import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  compareVersions,
  copyRegularAtomic,
} from "../scripts/maintenance-helper.mjs";
import { Maintenance } from "../server/maintenance.js";
for (const [a, b, expected] of [
  ["3.5.0-beta.1", "3.3.0", 1],
  ["3.5.0-beta.2", "3.5.0-beta.10", -1],
  ["3.5.0", "3.5.0-beta.10", 1],
  ["3.5.0-beta.1", "3.5.0", -1],
  ["3.5.0-beta.1", "3.5.0-beta.1", 0],
  ["3.6.0-beta.1", "3.5.99", 1],
])
  assert.equal(compareVersions(a, b), expected);
for (const bad of [
  "3.5.0-beta",
  "3.5.0-beta.-1",
  "3.5.0-beta.01",
  "03.5.0",
  "3.5.0;reboot",
  "3.5.0.1",
])
  assert.throws(() => compareVersions(bad, "3.5.0"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nui-beta-audit-"));
try {
  const source = path.join(dir, "source"),
    destination = path.join(dir, "snapshot.json"),
    outside = path.join(dir, "protected");
  fs.writeFileSync(source, "snapshot");
  fs.writeFileSync(outside, "must-not-change");
  fs.symlinkSync(outside, destination);
  assert(copyRegularAtomic(source, destination, fs.statSync(dir)));
  assert.equal(fs.readFileSync(outside, "utf8"), "must-not-change");
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(destination, "utf8"), "snapshot");
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  fs.unlinkSync(source);
  fs.symlinkSync(outside, source);
  assert.throws(() => copyRegularAtomic(source, destination));
  fs.unlinkSync(source);
  execFileSync("mkfifo", [source]);
  assert.throws(() => copyRegularAtomic(source, destination));
  fs.unlinkSync(source);
  assert.equal(copyRegularAtomic(source, destination), false);
  const m = new Maintenance({
    cfg: { dataDir: dir },
    store: {
      state: {
        settings: {
          maintenanceJob: {
            id: "job",
            createdAt: Date.now(),
            status: "queued",
          },
        },
      },
    },
  });
  fs.symlinkSync(outside, m.result);
  assert.equal(m.status().status, "queued");
  fs.unlinkSync(m.result);
  execFileSync("mkfifo", [m.result]);
  assert.equal(m.status().status, "queued");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url) =>
      new Response(
        JSON.stringify(
          url.includes("/git/ref/")
            ? { object: { sha: "a".repeat(40) } }
            : {
                content: Buffer.from(
                  JSON.stringify({ version: "3.5.0-beta.1" }),
                ).toString("base64"),
              },
        ),
      );
    assert.equal((await m.check()).version, "3.5.0-beta.1");
  } finally {
    globalThis.fetch = original;
  }
  console.log(
    "PASS beta audit: prerelease precedence, invalid versions, atomic metadata rollback, symlink/FIFO rejection and bounded status reads",
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
