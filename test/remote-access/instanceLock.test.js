const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const InstanceLock = require("../../remote-access/InstanceLock");

function tempBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-ra-lock-"));
}

test("resolveBeforeStart with no lock file is a no-op (spawn-fresh)", async () => {
  const dir = tempBaseDir();
  const result = await InstanceLock.resolveBeforeStart(dir);
  assert.equal(result.action, "spawn-fresh");
});

test("resolveBeforeStart clears a lock recording a dead PID", async () => {
  const dir = tempBaseDir();
  // A PID essentially guaranteed not to be alive on any real machine.
  InstanceLock.record(dir, 999999);
  const result = await InstanceLock.resolveBeforeStart(dir);
  assert.equal(result.action, "spawn-fresh");
  assert.equal(InstanceLock.readLock(dir), null, "stale lock must be cleared");
});

test("resolveBeforeStart clears the lock (without killing anything) when the live PID no longer looks like cloudflared", async () => {
  const dir = tempBaseDir();
  // Our own test process is alive but is obviously not cloudflared.
  InstanceLock.record(dir, process.pid);
  const result = await InstanceLock.resolveBeforeStart(dir);
  assert.equal(result.action, "spawn-fresh");
  assert.equal(InstanceLock.readLock(dir), null);
  // and, critically, our own test process must still be alive
  assert.equal(InstanceLock.isPidAlive(process.pid), true);
});

test("record()/readLock()/clear() round-trip", () => {
  const dir = tempBaseDir();
  assert.equal(InstanceLock.readLock(dir), null);
  InstanceLock.record(dir, 12345);
  assert.equal(InstanceLock.readLock(dir).pid, 12345);
  InstanceLock.clear(dir);
  assert.equal(InstanceLock.readLock(dir), null);
});

test("isPidAlive reflects reality for a real vs. a very unlikely PID", () => {
  assert.equal(InstanceLock.isPidAlive(process.pid), true);
  assert.equal(InstanceLock.isPidAlive(999999), false);
});

test("looksLikeCloudflared is false for an unrelated process (this test's own runtime)", async () => {
  const isCloudflared = await InstanceLock.looksLikeCloudflared(process.pid);
  assert.equal(isCloudflared, false);
});
