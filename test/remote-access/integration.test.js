// test/remote-access/integration.test.js — drives CloudflaredManager against
// a REAL child process (test/fixtures/fake-cloudflared.js run via Node
// itself), not a mocked EventEmitter — this is what proves redaction and
// lifecycle behavior hold against actual OS process behavior, matching the
// plan's "fake cloudflared executable" integration-test requirement.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const CFM = require("../../remote-access/CloudflaredManager");

// Lives at repo-root fixtures/, NOT under test/ — node --test's default
// discovery treats any file inside a directory literally named "test" as a
// candidate test file, and this fixture (an intentionally long-running,
// argv-mode-driven script) previously got discovered and "run" as if it
// were a test, hanging until timeout. Living outside test/ avoids that
// regardless of how `node --test` is invoked.
const FIXTURE = path.join(__dirname, "..", "..", "fixtures", "fake-cloudflared.js");

function tempBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-ra-int-"));
}
function fakeInstalledBinary(dir) {
  const key = CFM.platformKey();
  const entry = CFM.RELEASES[key] || { localBin: "cloudflared" };
  const binPath = path.join(CFM.binDir(dir), entry.localBin);
  fs.mkdirSync(CFM.binDir(dir), { recursive: true });
  fs.writeFileSync(binPath, "placeholder — never actually executed directly, see spawnFn override below");
}
function fixtureSpawnFn(mode) {
  return (binPath, args, opts) => spawn(process.execPath, [FIXTURE, mode], { env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
}

test("integration: connected fixture reaches sawConnectionEvidence and stop() cleanly terminates it; token never leaks into a captured log line", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  const logs = [];
  const mgr = CFM.createProcessManager(dir, { spawnFn: fixtureSpawnFn("connected") });
  mgr.onStatusChange(s => { if (s.line) logs.push(s.line); });
  const token = "integration-secret-token-value";

  await mgr.start(token);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(mgr.getStatus().sawConnectionEvidence, true);

  await mgr.stop();
  assert.equal(mgr.getStatus().processRunning, false);
  assert.ok(!logs.some(l => l.includes(token)), "the real token must never appear in a captured log line");
  assert.ok(logs.some(l => l.includes("[redacted]")), "the fixture's deliberate token echo must have been redacted, not silently dropped");
});

test("integration: crash fixture triggers a real scheduled restart via backoff", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  let spawns = 0;
  const spawnFn = (binPath, args, opts) => { spawns++; return spawn(process.execPath, [FIXTURE, "crash"], { env: opts.env, stdio: ["ignore", "pipe", "pipe"] }); };
  const mgr = CFM.createProcessManager(dir, { spawnFn });

  await mgr.start("tok");
  assert.equal(spawns, 1);
  await new Promise(r => setTimeout(r, 2700)); // fixture crashes at ~200ms, first backoff delay is 2000ms
  assert.equal(spawns, 2, "an unexpected crash must result in a real scheduled respawn");
  assert.equal(mgr.getStatus().restartCount, 1);
  // Without this, the second crashed child triggers yet another scheduled
  // restart (and so on, forever) — a real leaked child process + timer that
  // outlives this test and keeps node --test's own process from exiting.
  await mgr.stop();
}, { timeout: 10000 });

// Node's child_process .kill("SIGTERM") has no ignorable-signal semantics on
// Windows — per Node's own documented behavior, POSIX signals don't exist
// there, so ANY signal argument (SIGTERM included) forcibly terminates the
// process, similarly to SIGKILL. That means a fixture "ignoring SIGTERM" is
// not a distinguishable scenario on win32 — the process dies immediately
// regardless, so this specific escalation path can't be exercised on this
// platform. The manager's own SIGTERM-then-SIGKILL logic is still correct
// and necessary for Linux/macOS (both real Milestone A targets), where a
// child genuinely can ignore SIGTERM — only THIS test is Windows-inapplicable.
test("integration: hang fixture ignores SIGTERM and is force-killed via the SIGKILL escalation", { skip: process.platform === "win32" ? "Windows has no ignorable SIGTERM — see comment above" : false }, async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  const spawnFn = (binPath, args, opts) => spawn(process.execPath, [FIXTURE, "hang"], { env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
  const mgr = CFM.createProcessManager(dir, { spawnFn });

  await mgr.start("tok");
  await new Promise(r => setTimeout(r, 300));
  const stopStart = Date.now();
  await mgr.stop();
  const elapsed = Date.now() - stopStart;
  assert.equal(mgr.getStatus().processRunning, false);
  assert.ok(elapsed >= 4900, "stop() must wait out the graceful SIGTERM window before escalating to SIGKILL (took " + elapsed + "ms)");
}, { timeout: 15000 });

test("integration: error fixture's stderr line is captured as a redacted lastError", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  const spawnFn = (binPath, args, opts) => spawn(process.execPath, [FIXTURE, "error"], { env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
  const mgr = CFM.createProcessManager(dir, { spawnFn });
  const token = "another-secret-value";

  await mgr.start(token);
  await new Promise(r => setTimeout(r, 400));
  assert.match(mgr.getStatus().lastError, /could not connect/);
  assert.ok(!mgr.getStatus().lastError.includes(token));
  // The error fixture also exits unexpectedly (code 1) — same leaked
  // restart-loop risk as the crash test above if this isn't stopped.
  await mgr.stop();
});
