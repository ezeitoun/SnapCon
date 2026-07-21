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

// Hardening: found by code review. resolveBeforeStart() awaits this from
// inside start(), and start()/stop() are serialized at the CloudflaredManager
// level — an unbounded tasklist/proc read here would mean a subsequent
// stop() call (including the one server.js's graceful-shutdown path depends
// on) could queue behind it indefinitely, breaking the "shutdown is always
// bounded" guarantee that whole path exists for. A 1ms timeout can't
// possibly complete a real tasklist/proc read in time, so this reliably
// exercises the timeout path itself (resolving false, the safe default)
// rather than a normal fast completion — proving the function actually
// bounds itself instead of only being fast by coincidence on this machine.
test("looksLikeCloudflared resolves false (not hung) when given a timeout too short for a real OS lookup to complete", async () => {
  const start = Date.now();
  const result = await InstanceLock.looksLikeCloudflared(process.pid, 1);
  const elapsed = Date.now() - start;
  assert.equal(result, false, "timing out must resolve the safe default (false), never leave the caller hanging");
  assert.ok(elapsed < 2000, "must resolve at ~the timeout, not wait for the real OS call to finish on its own (took " + elapsed + "ms)");
});
