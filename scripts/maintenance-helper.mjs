// Root-only systemd helper. The web process can request only these three operations.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const APP = "/opt/nui-memo",
  CONF = "/etc/nui-memo/config.json",
  REPO = "elysianki4225-png/nui";
// Only stable releases and numbered beta builds are supported by this release channel.
export function compareVersions(a, b) {
  const parse = (v) => {
    if (
      typeof v !== "string" ||
      v.length > 64 ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.test(
        v,
      )
    )
      throw Error("BAD_VERSION");
    const [core, pre] = v.split("-");
    return [...core.split(".").map(BigInt), pre ? BigInt(pre.slice(5)) : null];
  };
  const x = parse(a),
    y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  if (x[3] === y[3]) return 0;
  if (x[3] === null) return 1;
  if (y[3] === null) return -1;
  return x[3] > y[3] ? 1 : -1;
}
// Never follow app-controlled metadata symlinks, especially on rollback destinations.
export function copyRegularAtomic(source, destination, owner) {
  let input, output, tmp;
  try {
    try {
      input = fs.openSync(
        source,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
    const stat = fs.fstatSync(input);
    if (!stat.isFile() || stat.size > 512 * 1024 * 1024)
      throw Error("UNSAFE_METADATA");
    tmp = destination + "." + crypto.randomUUID();
    output = fs.openSync(
      tmp,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    const buffer = Buffer.alloc(65536);
    let at = 0;
    while (at < stat.size) {
      const n = fs.readSync(
        input,
        buffer,
        0,
        Math.min(buffer.length, stat.size - at),
        at,
      );
      if (!n) throw Error("METADATA_CHANGED");
      let written = 0;
      while (written < n)
        written += fs.writeSync(output, buffer, written, n - written);
      at += n;
    }
    if (owner) fs.fchownSync(output, owner.uid, owner.gid);
    fs.fsyncSync(output);
    fs.closeSync(output);
    output = undefined;
    fs.renameSync(tmp, destination);
    tmp = undefined;
    return true;
  } finally {
    if (input !== undefined) fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}
export function validateJob(j, now = Date.now()) {
  if (
    !j ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      j.id,
    ) ||
    !["update", "restart-service", "reboot-server"].includes(j.action) ||
    !Number.isSafeInteger(j.createdAt) ||
    now - j.createdAt > 300000 ||
    j.createdAt > now + 10000
  )
    throw Error("INVALID_JOB");
  if (j.action === "update" && !/^[a-f0-9]{40}$/.test(j.sha))
    throw Error("INVALID_COMMIT");
  return { id: j.id, action: j.action, createdAt: j.createdAt, sha: j.sha };
}
export function commandFor(action) {
  if (action === "restart-service")
    return ["/usr/bin/systemctl", ["restart", "nui-memo"]];
  if (action === "reboot-server") return ["/usr/bin/systemctl", ["reboot"]];
  throw Error("INVALID_ACTION");
}
async function download(url, max) {
  const r = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60000),
    headers: { "User-Agent": "nui-maintenance" },
  });
  if (!r.ok) throw Error("DOWNLOAD_FAILED");
  let size = 0;
  const chunks = [];
  for await (const b of r.body) {
    size += b.length;
    if (size > max) throw Error("DOWNLOAD_TOO_LARGE");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
export async function runMaintenance({
  app = APP,
  confPath = CONF,
  backupRoot = "/var/backups/nui-memo",
  exec = execFileSync,
  fetchBytes = download,
  healthCheck,
  uid = () => process.getuid?.(),
  chown = fs.chownSync,
  tmpRoot = "/var/tmp",
  stateDir = "/var/lib/nui-maintenance",
} = {}) {
  if (uid() !== 0) throw Error("ROOT_REQUIRED");
  const conf = JSON.parse(fs.readFileSync(confPath)),
    dir = path.resolve(conf.dataDir || "/var/lib/nui-memo");
  if (
    ["/", "/etc", "/var", "/var/lib", "/opt", "/home"].includes(dir) ||
    fs.realpathSync(dir) !== dir
  )
    throw Error("UNSAFE_DATA_DIR");
  const request = path.join(dir, "maintenance-request.json"),
    result = path.join(dir, "maintenance-result.json");
  let job;
  const fd = fs.openSync(
    request,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 4096)
      throw Error("INVALID_REQUEST");
    const b = Buffer.alloc(4097),
      n = fs.readSync(fd, b, 0, b.length, 0);
    if (n > 4096) throw Error("INVALID_REQUEST");
    job = validateJob(JSON.parse(b.subarray(0, n)));
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(request);
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, job.id), String(Date.now()), {
    flag: "wx",
    mode: 0o600,
  });
  for (const name of fs.readdirSync(stateDir))
    if (
      /^[a-f0-9-]{36}$/.test(name) &&
      Date.now() - fs.statSync(path.join(stateDir, name)).mtimeMs > 86400000
    )
      fs.unlinkSync(path.join(stateDir, name));
  const group = fs.statSync(confPath).gid;
  const report = (status, message) => {
    const tmp = result + "." + crypto.randomUUID();
    fs.writeFileSync(
      tmp,
      JSON.stringify({ ...job, status, message, updatedAt: Date.now() }),
      { flag: "wx", mode: 0o640 },
    );
    chown(tmp, 0, group);
    fs.renameSync(tmp, result);
  };
  const run = (bin, args, options = {}) =>
    exec(bin, args, {
      stdio: "inherit",
      timeout: 600000,
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/root",
        LANG: "C.UTF-8",
      },
      ...options,
    });
  let temp,
    backup,
    stopped = false,
    metadataComplete = false;
  try {
    report("running", "维护任务正在执行");
    if (job.action === "update") {
      const remote = JSON.parse(
        await fetchBytes(
          `https://api.github.com/repos/${REPO}/git/ref/heads/main`,
          128 * 1024,
        ),
      );
      if (remote.object?.sha !== job.sha) throw Error("MAIN_CHANGED");
      temp = fs.mkdtempSync(path.join(tmpRoot, "nui-update-"));
      fs.chmodSync(temp, 0o700);
      const archive = path.join(temp, "app.tar.gz");
      report("running", "下载已确认的 main 提交");
      fs.writeFileSync(
        archive,
        await fetchBytes(
          `https://codeload.github.com/${REPO}/tar.gz/${job.sha}`,
          32 * 1024 * 1024,
        ),
      );
      const list = exec("/usr/bin/tar", ["-tzf", archive], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      })
        .trim()
        .split("\n");
      if (
        list.length > 10000 ||
        list.some(
          (x) =>
            !x.startsWith("nui-" + job.sha + "/") ||
            x.split("/").includes("..") ||
            x.includes("\\"),
        )
      )
        throw Error("UNSAFE_ARCHIVE");
      const verbose = exec("/usr/bin/tar", ["-tvzf", archive], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      })
        .trim()
        .split("\n");
      if (
        verbose.some((x) => !["-", "d"].includes(x[0])) ||
        verbose.reduce((n, x) => n + Number(x.trim().split(/\s+/)[2]), 0) >
          256 * 1024 * 1024
      )
        throw Error("UNSAFE_ARCHIVE");
      run("/usr/bin/tar", [
        "--no-same-owner",
        "--no-same-permissions",
        "-xzf",
        archive,
        "-C",
        temp,
      ]);
      const src = path.join(temp, "nui-" + job.sha);
      report("running", "检查程序结构和语法");
      const version = JSON.parse(
        fs.readFileSync(path.join(src, "package.json")),
      ).version;
      const current = JSON.parse(
        fs.readFileSync(path.join(app, "server/package.json")),
      ).version;
      if (compareVersions(version, current) < 0) throw Error("OLDER_VERSION");
      for (const file of fs
        .readdirSync(path.join(src, "server"))
        .filter((x) => x.endsWith(".js")))
        run(app + "/node/bin/node", [
          "--check",
          path.join(src, "server", file),
        ]);
      run("/usr/bin/bash", ["-n", path.join(src, "install.sh")]);
      if (!fs.existsSync(path.join(src, "web/user/index.html")))
        throw Error("BAD_LAYOUT");
      backup = path.join(backupRoot, job.id);
      fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
      for (const name of ["server", "web", "scripts", "install.sh"])
        if (fs.existsSync(path.join(app, name)))
          fs.cpSync(path.join(app, name), path.join(backup, name), {
            recursive: true,
          });
      fs.copyFileSync(confPath, path.join(backup, "config.json"));
      report("running", "停止备忘录服务并备份元数据");
      stopped = true;
      run("/usr/bin/systemctl", ["stop", "nui-memo"]);
      for (const name of ["snapshot.json", "events.jsonl"])
        copyRegularAtomic(path.join(dir, name), path.join(backup, name));
      metadataComplete = true;
      report("running", "安装已确认提交，保留现有数据与域名配置");
      run("/usr/bin/bash", [path.join(src, "install.sh"), "--update", "-y"], {
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          HOME: "/root",
          LANG: "C.UTF-8",
          NUI_REF: job.sha,
        },
      });
    } else {
      if (job.action === "reboot-server") {
        report("issued", "已向系统提交整机重启请求；所有服务将暂时中断");
        const [bin, args] = commandFor(job.action);
        run(bin, args);
        return;
      }
      const [bin, args] = commandFor(job.action);
      run(bin, args);
    }
    const port = Number(conf.port || 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw Error("BAD_PORT");
    let healthy = healthCheck ? await healthCheck(port) : false;
    for (let i = 0; !healthCheck && i < 30; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(1000),
        });
        const j = await r.json();
        if (r.ok && j.ok) {
          healthy = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!healthy) throw Error("HEALTH_FAILED");
    stopped = false;
    report("completed", "操作完成，后端健康检查通过");
    try {
      if (backup) {
        const dirs = fs
          .readdirSync(backupRoot)
          .filter((n) => /^[a-f0-9-]{36}$/.test(n))
          .sort(
            (a, b) =>
              fs.statSync(path.join(backupRoot, b)).mtimeMs -
              fs.statSync(path.join(backupRoot, a)).mtimeMs,
          );
        for (const name of dirs.slice(3))
          fs.rmSync(path.join(backupRoot, name), {
            recursive: true,
            force: true,
          });
      }
    } catch (e) {
      console.error("[maintenance] backup cleanup:", e.message);
    }
  } catch (e) {
    if (stopped && backup) {
      try {
        run("/usr/bin/systemctl", ["stop", "nui-memo"]);
        for (const name of ["server", "web", "scripts", "install.sh"])
          if (fs.existsSync(path.join(backup, name))) {
            fs.rmSync(path.join(app, name), { recursive: true, force: true });
            fs.cpSync(path.join(backup, name), path.join(app, name), {
              recursive: true,
            });
          }
        fs.copyFileSync(path.join(backup, "config.json"), confPath);
        if (metadataComplete)
          for (const name of ["snapshot.json", "events.jsonl"]) {
            if (
              !copyRegularAtomic(
                path.join(backup, name),
                path.join(dir, name),
                fs.statSync(dir),
              )
            )
              fs.rmSync(path.join(dir, name), { force: true });
          }
        run("/usr/bin/systemctl", ["start", "nui-memo"]);
      } catch {
        report(
          "failed",
          "更新失败，自动恢复未完成，请通过 SSH 检查维护日志和 /var/backups/nui-memo",
        );
        return;
      }
    }
    console.error("[maintenance]", e.message);
    report(
      "failed",
      stopped
        ? "更新失败，已尝试恢复旧程序与元数据，请通过 SSH 检查"
        : "操作失败，请通过 SSH 检查 nui-memo-maintenance 日志",
    );
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  runMaintenance().catch((e) => {
    console.error("[maintenance]", e.message);
    process.exitCode = 1;
  });
