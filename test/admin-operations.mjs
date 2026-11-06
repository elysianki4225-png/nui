import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { AdminDisguise } from "../server/admin-disguise.js";
import { hashSecret } from "../server/security.js";
import { Maintenance } from "../server/maintenance.js";
import { Store } from "../server/store.js";
import {
  validateJob,
  commandFor,
  runMaintenance,
} from "../scripts/maintenance-helper.mjs";
const state = {
    admin: { disguise: { enabled: true, codeHash: hashSecret("87654321") } },
  },
  gate = new AdminDisguise({ state });
const token = gate.issue(),
  req = { headers: { cookie: "memo_disguise=" + token } };
assert(gate.unlocked(req));
assert(!gate.unlocked({ headers: { cookie: "memo_disguise=" + token + "x" } }));
assert(!new AdminDisguise({ state }).unlocked(req));
state.admin.disguise.codeHash = hashSecret("12345678");
assert(!gate.unlocked(req));
assert.throws(() =>
  validateJob({
    id: "../../escape",
    action: "reboot-server",
    createdAt: Date.now(),
  }),
);
assert.throws(() =>
  validateJob({
    id: crypto.randomUUID(),
    action: "shell",
    createdAt: Date.now(),
  }),
);
assert.throws(() =>
  validateJob({
    id: crypto.randomUUID(),
    action: "update",
    sha: ";touch /tmp/no",
    createdAt: Date.now(),
  }),
);
assert.throws(() =>
  validateJob({
    id: crypto.randomUUID(),
    action: "restart-service",
    createdAt: Date.now() - 301000,
  }),
);
assert.deepEqual(commandFor("restart-service"), [
  "/usr/bin/systemctl",
  ["restart", "nui-memo"],
]);
assert.throws(() => commandFor("stop-anything"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nui-maintenance-test-"));
try {
  const data = path.join(root, "queue");
  fs.mkdirSync(data);
  const store = new Store(data);
  await store.load();
  store.log({ t: "admin.set", admin: { username: "admin" } });
  const ctx = {
      store,
      cfg: { dataDir: data },
      pool: { activeWrites: 1, migrationBusy: false },
    },
    m = new Maintenance(ctx);
  m.available = () => false;
  await assert.rejects(
    m.queue("restart-service"),
    (e) => e.code === "MAINTENANCE_UNAVAILABLE",
  );
  m.available = () => true;
  ctx.pool.activeWrites = 2;
  await assert.rejects(m.queue("restart-service"), (e) => e.code === "BUSY");
  ctx.pool.activeWrites = 1;
  const job = await m.queue("restart-service");
  assert(m.busy());
  assert.equal(JSON.parse(fs.readFileSync(m.request)).id, job.id);
  assert(!fs.readFileSync(m.request, "utf8").includes("password"));
  await assert.rejects(m.queue("restart-service"), (e) => e.code === "BUSY");
  fs.writeFileSync(
    m.result,
    JSON.stringify({ id: job.id, status: "completed" }),
  );
  assert(!m.busy());
  await store.close();
  // Run the real file/backup/rollback workflow with ONLY process/network effects injected.
  const app = path.join(root, "app"),
    dir = path.join(root, "data"),
    conf = path.join(root, "config.json"),
    backups = path.join(root, "backups");
  fs.mkdirSync(dir);
  for (const d of ["server", "web", "scripts"])
    fs.mkdirSync(path.join(app, d), { recursive: true });
  fs.writeFileSync(
    path.join(app, "server/package.json"),
    '{"version":"3.2.0"}',
  );
  fs.writeFileSync(path.join(app, "server/index.js"), "old-code");
  fs.writeFileSync(path.join(app, "install.sh"), "old-installer");
  fs.writeFileSync(path.join(dir, "snapshot.json"), "old-metadata");
  fs.writeFileSync(conf, JSON.stringify({ dataDir: dir, port: 8787 }));
  const sha = "a".repeat(40),
    src = path.join(root, "source", "nui-" + sha);
  for (const d of ["server", "web/user", "scripts"])
    fs.mkdirSync(path.join(src, d), { recursive: true });
  fs.writeFileSync(path.join(src, "package.json"), '{"version":"3.2.1"}');
  fs.writeFileSync(path.join(src, "server/index.js"), "new-code");
  fs.writeFileSync(path.join(src, "web/user/index.html"), "new-page");
  fs.writeFileSync(path.join(src, "install.sh"), "new-installer");
  const archive = path.join(root, "source.tar.gz");
  execFileSync("tar", [
    "-czf",
    archive,
    "-C",
    path.join(root, "source"),
    "nui-" + sha,
  ]);
  let commands = [],
    failInstall = false,
    healthy = true;
  const execute = (bin, args, opts) => {
    if (bin === "/usr/bin/tar") return execFileSync(bin, args, opts);
    commands.push([bin, args]);
    if (bin === "/usr/bin/bash" && args.includes("--update")) {
      fs.writeFileSync(path.join(app, "server/index.js"), "new-code");
      fs.writeFileSync(path.join(dir, "snapshot.json"), "new-metadata");
      if (failInstall) throw Error("INJECTED_INSTALL_FAILURE");
    }
    return "";
  };
  const options = {
    app,
    confPath: conf,
    backupRoot: backups,
    exec: execute,
    fetchBytes: async (url) =>
      url.includes("api.github.com")
        ? Buffer.from(JSON.stringify({ object: { sha } }))
        : fs.readFileSync(archive),
    uid: () => 0,
    chown: () => {},
    tmpRoot: root,
    healthCheck: async () => healthy,
    stateDir: path.join(root, "receipts"),
  };
  const run = async (action) => {
    commands = [];
    const j = { id: crypto.randomUUID(), createdAt: Date.now(), action, sha };
    fs.writeFileSync(
      path.join(dir, "maintenance-request.json"),
      JSON.stringify(j),
    );
    await runMaintenance(options);
    return JSON.parse(
      fs.readFileSync(path.join(dir, "maintenance-result.json")),
    );
  };
  assert.equal((await run("restart-service")).status, "completed");
  assert.deepEqual(commands, [commandFor("restart-service")]);
  assert.equal((await run("reboot-server")).status, "issued");
  assert.deepEqual(commands, [commandFor("reboot-server")]);
  failInstall = true;
  assert.equal((await run("update")).status, "failed");
  assert.equal(
    fs.readFileSync(path.join(app, "server/index.js"), "utf8"),
    "old-code",
  );
  assert.equal(
    fs.readFileSync(path.join(dir, "snapshot.json"), "utf8"),
    "old-metadata",
  );
  failInstall = false;
  healthy = false;
  assert.equal((await run("update")).status, "failed");
  assert.equal(
    fs.readFileSync(path.join(app, "server/index.js"), "utf8"),
    "old-code",
  );
  healthy = true;
  assert.equal((await run("update")).status, "completed");
  assert.equal(
    fs.readFileSync(path.join(app, "server/index.js"), "utf8"),
    "new-code",
  );
  const completed = JSON.parse(
    fs.readFileSync(path.join(dir, "maintenance-result.json")),
  );
  fs.writeFileSync(
    path.join(dir, "maintenance-request.json"),
    JSON.stringify(completed),
  );
  await assert.rejects(runMaintenance(options), (e) => e.code === "EEXIST");
  fs.symlinkSync(conf, path.join(dir, "maintenance-request.json"));
  await assert.rejects(runMaintenance(options));
  assert(fs.existsSync(conf));
  fs.unlinkSync(path.join(dir, "maintenance-request.json"));
  console.log(
    "PASS maintenance allowlist, replays/stale input, job locking, fixed commands, real backups, install/health failure rollback and symlink rejection (no actual reboot)",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nui-admin-ops-")),
  base = "http://127.0.0.1:8986";
let child,
  logs = "";
const jar = new Map();
const password = "isolated-test-password";
const start = async () => {
  child = spawn(process.execPath, ["server/index.js"], {
    env: {
      ...process.env,
      MEMO_HOST: "127.0.0.1",
      MEMO_PORT: "8986",
      MEMO_DATA_DIR: dir,
      MEMO_DEV: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => (logs += b));
  child.stderr.on("data", (b) => (logs += b));
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(base + "/api/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error(logs);
};
const stop = () =>
  new Promise((r) => {
    child.once("exit", r);
    child.kill("SIGTERM");
  });
async function request(method, url, body, headers = {}) {
  const r = await fetch(base + url, {
    method,
    headers: {
      "X-Memo-Client": "test",
      "Content-Type": "application/json",
      Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of r.headers.getSetCookie()) {
    const [k, ...rest] = c.split(";")[0].split("=");
    jar.set(k, rest.join("="));
  }
  return {
    status: r.status,
    data: await r.json(),
    cookies: r.headers.getSetCookie(),
  };
}
try {
  await start();
  assert.equal(
    (await request("POST", "/api/admin/setup", { username: "admin", password }))
      .status,
    200,
  );
  assert.equal(
    (
      await request("PATCH", "/api/admin/disguise", {
        enabled: true,
        code: "87654321",
        password: "wrong",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("PATCH", "/api/admin/disguise", {
        enabled: true,
        code: "abc",
        password,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("PATCH", "/api/admin/disguise", {
        enabled: true,
        code: "87654321",
        password,
      })
    ).status,
    200,
  );
  assert.equal((await request("GET", "/api/admin/status")).data.loggedIn, true);
  assert(
    !JSON.stringify(
      (await request("GET", "/api/admin/disguise")).data,
    ).includes("codeHash"),
  );
  const adminCookie = jar.get("memo_admin");
  await request("POST", "/api/admin/logout");
  assert.deepEqual((await request("GET", "/api/admin/status")).data, {
    ok: true,
    disguised: true,
  });
  assert.equal(
    (await request("POST", "/api/admin/login", { username: "admin", password }))
      .status,
    404,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/api/admin/disguise/unlock",
        { code: "87654321" },
        { "X-Memo-Client": "" },
      )
    ).data.code,
    "CSRF",
  );
  assert.equal(
    (await request("POST", "/api/admin/disguise/unlock", { code: "11111111" }))
      .status,
    400,
  );
  const unlocked = await request("POST", "/api/admin/disguise/unlock", {
    code: "87654321",
  });
  assert.equal(unlocked.status, 200);
  assert(
    unlocked.cookies.some(
      (c) => c.includes("HttpOnly") && c.includes("SameSite=Strict"),
    ),
  );
  assert.equal(
    (await request("GET", "/api/admin/status")).data.loggedIn,
    false,
  );
  assert.equal((await request("GET", "/api/admin/settings")).status, 401);
  assert.equal(
    (await request("POST", "/api/admin/login", { username: "admin", password }))
      .status,
    200,
  );
  assert.equal(
    (
      await request("POST", "/api/admin/maintenance/run", {
        action: "reboot-server",
        password,
        confirmation: "wrong",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("POST", "/api/admin/maintenance/run", {
        action: "restart-service",
        password,
      })
    ).data.code,
    "MAINTENANCE_UNAVAILABLE",
  );
  await request("POST", "/api/admin/logout");
  assert.equal(jar.get("memo_disguise"), "");
  assert.equal(
    (await request("GET", "/api/admin/status")).data.disguised,
    true,
  );
  await stop();
  await start();
  assert.equal(
    (await request("GET", "/api/admin/status")).data.disguised,
    true,
  );
  for (let i = 0; i < 8; i++)
    assert.equal(
      (
        await request("POST", "/api/admin/disguise/unlock", {
          code: "11111111",
        })
      ).status,
      400,
    );
  assert.equal(
    (await request("POST", "/api/admin/disguise/unlock", { code: "87654321" }))
      .status,
    429,
  );
  await stop();
  const s = new Store(dir);
  await s.load();
  assert(!JSON.stringify(s.state.admin).includes("87654321"));
  assert(s.state.admin.disguise.enabled);
  await s.close();
  console.log(
    "PASS calculator real HTTP backend enforcement, independent hashed code, auth/CSRF/reauth, logout, rate limit, persisted setting and unavailable helper",
  );
} catch (e) {
  console.error(logs);
  throw e;
} finally {
  if (child?.exitCode === null) await stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
