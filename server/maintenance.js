import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readJson, HttpError, VERSION } from "./util.js";
import { reauthenticate } from "./admin-disguise.js";
const REPO = "elysianki4225-png/nui";
async function github(url) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    headers: {
      "User-Agent": "nui-maintenance",
      Accept: "application/vnd.github+json",
    },
  });
  if (!r.ok)
    throw new HttpError(
      503,
      "无法检查 GitHub 更新，请稍后重试",
      "UPDATE_CHECK_FAILED",
    );
  let bytes = 0;
  const chunks = [];
  for await (const b of r.body) {
    bytes += b.length;
    if (bytes > 128 * 1024) throw new HttpError(503, "更新元数据过大");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks));
}
export class Maintenance {
  constructor(ctx) {
    this.ctx = ctx;
    this.request = path.join(ctx.cfg.dataDir, "maintenance-request.json");
    this.result = path.join(ctx.cfg.dataDir, "maintenance-result.json");
    this.latest = null;
  }
  available() {
    try {
      return [
        "/etc/nui-memo/maintenance-enabled",
        "/usr/local/libexec/nui-maintenance.mjs",
        "/etc/systemd/system/nui-memo-maintenance.path",
      ].every((p) => {
        const s = fs.lstatSync(p);
        return s.isFile() && s.uid === 0 && (s.mode & 0o022) === 0;
      });
    } catch {
      return false;
    }
  }
  status() {
    const job = this.ctx.store.state.settings.maintenanceJob;
    if (!job) return null;
    let result = null;
    try {
      const fd = fs.openSync(
        this.result,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
      try {
        const st = fs.fstatSync(fd);
        if (st.isFile() && st.size <= 8192) {
          const b = Buffer.alloc(8193),
            n = fs.readSync(fd, b, 0, b.length, 0);
          if (n <= 8192) result = JSON.parse(b.subarray(0, n));
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {}
    if (
      result?.id === job.id &&
      !(result.status === "running" && Date.now() - job.createdAt > 1800000)
    )
      return { ...job, ...result };
    if (["completed", "failed", "issued"].includes(job.status)) return job;
    if (Date.now() - job.createdAt > 300000)
      return {
        ...job,
        status: "failed",
        message: "维护任务未启动或已超时，请通过 SSH 检查维护服务",
      };
    return job;
  }
  busy() {
    const j = this.status();
    return (
      !!j &&
      ["queued", "running"].includes(j.status) &&
      Date.now() - j.createdAt < 1800000
    );
  }
  async check() {
    const commit = await github(
      `https://api.github.com/repos/${REPO}/git/ref/heads/main`,
    );
    commit.sha = commit.object?.sha;
    if (!/^[a-f0-9]{40}$/.test(commit.sha))
      throw new HttpError(503, "更新提交无效");
    const file = await github(
      `https://api.github.com/repos/${REPO}/contents/package.json?ref=${commit.sha}`,
    );
    const pkg = JSON.parse(
      Buffer.from(file.content || "", "base64").toString(),
    );
    if (
      typeof pkg.version !== "string" ||
      pkg.version.length > 64 ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.test(
        pkg.version,
      )
    )
      throw new HttpError(503, "远端版本号无效");
    this.latest = {
      sha: commit.sha,
      version: pkg.version,
      checkedAt: Date.now(),
    };
    return this.latest;
  }
  async queue(action, sha) {
    if (!this.available())
      throw new HttpError(
        503,
        "维护服务未安装，请先通过 SSH 的 n-ui 更新一次",
        "MAINTENANCE_UNAVAILABLE",
      );
    if (
      this.busy() ||
      this.ctx.pool.activeWrites > 1 ||
      this.ctx.pool.migrationBusy ||
      this.ctx.store.state.settings.storageMigration
    )
      throw new HttpError(
        409,
        "有写入、迁移或维护任务正在进行，请稍后重试",
        "BUSY",
      );
    const id = crypto.randomUUID(),
      job = {
        id,
        action,
        status: "queued",
        createdAt: Date.now(),
        message: "等待维护服务处理",
        sha,
      };
    this.ctx.store.log({
      t: "settings.set",
      settings: { maintenanceJob: job },
    });
    this.ctx.store.audit(
      this.ctx.store.state.admin.username,
      "maintenance.request",
      action + " " + id,
    );
    await this.ctx.store.flushDurable();
    const tmp = this.request + "." + id;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(job), {
        mode: 0o600,
        flag: "wx",
      });
      await fs.promises.rename(tmp, this.request);
    } catch (e) {
      await fs.promises.unlink(tmp).catch(() => {});
      this.ctx.store.log({
        t: "settings.set",
        settings: {
          maintenanceJob: {
            ...job,
            status: "failed",
            message: "无法提交维护请求",
          },
        },
      });
      throw new HttpError(500, "无法提交维护请求");
    }
    return job;
  }
}
export function registerMaintenanceRoutes({ route, requireAdmin }, ctx, m) {
  route("GET", "/api/admin/maintenance", async (req) => {
    requireAdmin(req);
    const job = m.status();
    if (
      job &&
      ["completed", "failed", "issued"].includes(job.status) &&
      job.status !== ctx.store.state.settings.maintenanceJob?.status
    ) {
      ctx.store.log({ t: "settings.set", settings: { maintenanceJob: job } });
      ctx.store.audit(
        ctx.store.state.admin.username,
        "maintenance.result",
        job.action + " " + job.status + " " + job.id,
      );
    }
    return {
      ok: true,
      available: m.available(),
      version: VERSION,
      job,
      latest: m.latest,
    };
  });
  route("POST", "/api/admin/maintenance/check", async (req, res, p, ip) => {
    requireAdmin(req);
    if (!ctx.limiter.allow("update-check:" + ip, 6, 60))
      throw new HttpError(429, "检查过于频繁");
    return { ok: true, latest: await m.check() };
  });
  route("POST", "/api/admin/maintenance/run", async (req, res, p, ip) => {
    requireAdmin(req);
    const b = await readJson(req, 4096);
    reauthenticate(req, b, { ...ctx, requireAdmin }, ip);
    if (!["update", "restart-service", "reboot-server"].includes(b.action))
      throw new HttpError(400, "不支持的维护操作");
    if (b.action === "reboot-server" && b.confirmation !== "重启服务器")
      throw new HttpError(400, "请输入“重启服务器”确认整机重启");
    if (
      b.action === "update" &&
      (!m.latest ||
        m.latest.sha !== b.sha ||
        Date.now() - m.latest.checkedAt > 300000)
    )
      throw new HttpError(409, "请先重新检查更新并确认目标版本");
    return {
      ok: true,
      job: await m.queue(b.action, b.action === "update" ? b.sha : undefined),
    };
  });
}
