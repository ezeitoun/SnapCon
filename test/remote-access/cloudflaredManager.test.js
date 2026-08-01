const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const CFM = require("../../remote-access/CloudflaredManager");

function tempBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-ra-pm-"));
}

// Fakes the presence of an already-verified, installed binary so
// createProcessManager's spawnChild() doesn't bail out on a missing file —
// this stage tests the process lifecycle, not installation (covered by
// checksumVerification.test.js).
function fakeInstalledBinary(dir) {
  const key = CFM.platformKey();
  const entry = CFM.RELEASES[key] || { localBin: "cloudflared" };
  const binPath = path.join(CFM.binDir(dir), entry.localBin);
  fs.mkdirSync(CFM.binDir(dir), { recursive: true });
  fs.writeFileSync(binPath, "not a real binary, just needs to exist on disk for this test");
}

function makeFakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  // Simulate a real process actually dying shortly after SIGTERM, so tests
  // exercising the normal stop() path don't need the 5s SIGKILL escalation.
  child.kill = signal => {
    child.killSignals.push(signal);
    if (signal === "SIGTERM") setImmediate(() => child.emit("exit", 0, null));
  };
  return child;
}

// Models a genuine OS-level spawn failure (binary deleted between
// verification and exec, permission denied, a noexec mount): Node never
// assigns a real pid, and per Node's own documented spawn semantics, 'exit'
// is NOT guaranteed to follow 'error' in this case — kill() on such a child
// is a no-op (neither throws nor causes 'exit').
function makeFakeChildThatFailsToSpawn() {
  const child = new EventEmitter();
  child.pid = undefined;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = signal => { child.killSignals.push(signal); };
  return child;
}

// A rarer but real variant: the child DID obtain a real pid (looks fully
// spawned from Node's perspective) but then hits an 'error' (e.g. an EPIPE
// on a stdio stream) and never emits 'exit' at all.
function makeFakeChildThatErrorsWithoutExiting(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = signal => { child.killSignals.push(signal); };
  return child;
}

function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeoutFn: (fn, delay) => { scheduled.push(delay); fn(); return { fired: true }; }, // fires immediately, records the delay it *would* have waited
    clearTimeoutFn: () => {}
  };
}

test("backoffDelay() returns the documented table and caps at the last entry", () => {
  assert.equal(CFM.backoffDelay(0), 2000);
  assert.equal(CFM.backoffDelay(1), 5000);
  assert.equal(CFM.backoffDelay(2), 10000);
  assert.equal(CFM.backoffDelay(3), 30000);
  assert.equal(CFM.backoffDelay(4), 60000);
  assert.equal(CFM.backoffDelay(5), 60000);
  assert.equal(CFM.backoffDelay(100), 60000);
});

test("start() spawns with argv ['tunnel','--no-autoupdate','run'] and the token only in the spawn-scoped env, never argv", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  let seenArgs, seenEnv;
  const spawnFn = (bin, args, opts) => { seenArgs = args; seenEnv = opts.env; return makeFakeChild(); };
  const mgr = CFM.createProcessManager(dir, { spawnFn, ...fakeTimers() });

  const token = "super-secret-tunnel-token-value";
  await mgr.start(token);

  // --no-autoupdate is a TUNNEL COMMAND OPTION, not a `run` subcommand
  // option (confirmed against the real binary's own usage/error output) —
  // it must precede "run", not follow it.
  assert.deepEqual(seenArgs, ["tunnel", "--no-autoupdate", "run"]);
  assert.equal(seenEnv.TUNNEL_TOKEN, token);
  assert.ok(!seenArgs.some(a => a.includes(token)), "token must never appear in argv");
});

test("start() never mutates the parent process's real process.env", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  const spawnFn = () => makeFakeChild();
  const mgr = CFM.createProcessManager(dir, { spawnFn, ...fakeTimers() });
  assert.equal(process.env.TUNNEL_TOKEN, undefined);
  await mgr.start("some-token");
  assert.equal(process.env.TUNNEL_TOKEN, undefined, "process.env itself must never be mutated by start()");
});

test("duplicate start() calls without an intervening stop() spawn only one child", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  let spawnCount = 0;
  const spawnFn = () => { spawnCount++; return makeFakeChild(); };
  const mgr = CFM.createProcessManager(dir, { spawnFn, ...fakeTimers() });
  await mgr.start("tok");
  await mgr.start("tok");
  assert.equal(spawnCount, 1);
  assert.equal(mgr.getStatus().processRunning, true);
});

test("an unexpected exit (no prior stop()) schedules a restart via backoffDelay(), and restartCount increments", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  let spawnCount = 0;
  const children = [];
  const spawnFn = () => { spawnCount++; const c = makeFakeChild(); children.push(c); return c; };
  const timers = fakeTimers();
  const mgr = CFM.createProcessManager(dir, { spawnFn, ...timers });

  await mgr.start("tok");
  assert.equal(spawnCount, 1);
  children[0].emit("exit", 1, null); // unexpected crash, not stop()
  assert.equal(spawnCount, 2, "an unexpected exit must trigger a scheduled restart");
  assert.equal(timers.scheduled[0], 2000, "first restart must use the first backoff delay");
  assert.equal(mgr.getStatus().restartCount, 1);
});

test("stop() is intentional and must NOT schedule a restart", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  let spawnCount = 0;
  const spawnFn = () => { spawnCount++; return makeFakeChild(); };
  const timers = fakeTimers();
  const mgr = CFM.createProcessManager(dir, { spawnFn, ...timers });

  await mgr.start("tok");
  assert.equal(spawnCount, 1);
  await mgr.stop();
  // Note: timers.scheduled will contain stop()'s own SIGKILL-escalation
  // delay (5000ms) — that's expected and unrelated to restart scheduling.
  // What must NOT happen is a second spawn / a nonzero restartCount.
  assert.equal(spawnCount, 1, "stop() must never cause a second spawn");
  assert.equal(mgr.getStatus().processRunning, false);
  assert.equal(mgr.getStatus().restartCount, 0, "an intentional stop schedules no restart");
});

test("restart() stops the current child and starts a fresh one with the same token", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  const seenEnvs = [];
  const spawnFn = (bin, args, opts) => { seenEnvs.push(opts.env.TUNNEL_TOKEN); return makeFakeChild(); };
  const mgr = CFM.createProcessManager(dir, { spawnFn, ...fakeTimers() });

  await mgr.start("consistent-token");
  await mgr.restart();
  assert.deepEqual(seenEnvs, ["consistent-token", "consistent-token"]);
});

test("getStatus() reports processRunning:false and a clear lastError when the binary isn't installed yet", async () => {
  const dir = tempBaseDir(); // fakeInstalledBinary() NOT called — binary absent
  const spawnFn = () => makeFakeChild();
  const mgr = CFM.createProcessManager(dir, { spawnFn, ...fakeTimers() });
  await mgr.start("tok");
  assert.equal(mgr.getStatus().processRunning, false);
  assert.match(mgr.getStatus().lastError, /not installed/);
});

test("sawConnectionEvidence flips true only after a matching stdout line", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  let child;
  const spawnFn = () => { child = makeFakeChild(); return child; };
  const mgr = CFM.createProcessManager(dir, { spawnFn, ...fakeTimers() });
  await mgr.start("tok");
  assert.equal(mgr.getStatus().sawConnectionEvidence, false);
  child.stdout.emit("data", Buffer.from("Registered tunnel connection\n"));
  assert.equal(mgr.getStatus().sawConnectionEvidence, true);
});

test("independent createProcessManager() instances do not share state", async () => {
  const dirA = tempBaseDir(), dirB = tempBaseDir();
  fakeInstalledBinary(dirA); fakeInstalledBinary(dirB);
  const mgrA = CFM.createProcessManager(dirA, { spawnFn: () => makeFakeChild(), ...fakeTimers() });
  const mgrB = CFM.createProcessManager(dirB, { spawnFn: () => makeFakeChild(), ...fakeTimers() });
  await mgrA.start("tokA");
  assert.equal(mgrA.getStatus().processRunning, true);
  assert.equal(mgrB.getStatus().processRunning, false);
});

// Hardening: found by code review, not live testing. start() awaits
// InstanceLock.resolveBeforeStart() before `running` ever becomes true —
// calling stop() in that window (without serialization) sees "nothing
// running," resolves immediately, and then the in-flight start() spawns a
// child anyway, undoing the stop it just reported as complete.
test("stop() called immediately after start() (without awaiting either first) is serialized — the process ends up actually stopped", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  const spawnFn = () => makeFakeChild();
  const mgr = CFM.createProcessManager(dir, { spawnFn, ...fakeTimers() });

  const startPromise = mgr.start("tok"); // deliberately not awaited yet
  const stopPromise = mgr.stop();        // called immediately after, also not awaited

  await startPromise;
  await stopPromise;

  assert.equal(mgr.getStatus().processRunning, false, "stop() must take effect even when it lands while start() is still mid-flight");
});

// C-5 regression: a spawn failure emits 'error' but Node does NOT guarantee
// a following 'exit' — before the fix, the 'error' handler only recorded
// lastError, leaving `running`/`child` stuck as if a real process were still
// alive. The next stop() call would then wait forever for an 'exit' that
// could never fire, and its kill() would be a no-op against a ChildProcess
// with no real pid — deadlocking every subsequent enable/disable/restart
// until the whole SnapCon process was killed and restarted.

test("C-5: the 'error' handler resets running/child and records lastError, mirroring 'exit'", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  const fakeChild = makeFakeChildThatFailsToSpawn();
  // Deliberately REAL timers here, not fakeTimers(): fakeTimers() fires
  // scheduleRestart()'s backoff callback synchronously, which would
  // immediately re-spawn (via the same spawnFn) and flip running back to
  // true again within this same emit() call, masking the exact regression
  // this test exists to catch. With real timers, the ~2s backoff hasn't
  // fired by the time we assert below, so the post-'error', pre-restart
  // state is actually observable.
  const mgr = CFM.createProcessManager(dir, { spawnFn: () => fakeChild });

  await mgr.start("tok");
  assert.equal(mgr.getStatus().processRunning, true, "sanity: spawnChild() optimistically sets running=true before the OS confirms anything");

  fakeChild.emit("error", new Error("spawn ENOENT"));

  assert.equal(mgr.getStatus().processRunning, false, "the 'error' handler must reset running, just like 'exit' does");
  assert.match(mgr.getStatus().lastError, /ENOENT/);
  await mgr.stop(); // cleanup: cancel the real backoff-restart timer scheduleRestart() just armed
});

test("C-5: stop() after a spawn failure resolves promptly instead of deadlocking (the reported bug: Enable fails, later Disable hangs forever)", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  const fakeChild = makeFakeChildThatFailsToSpawn();
  const mgr = CFM.createProcessManager(dir, { spawnFn: () => fakeChild }); // real timers — see note above

  await mgr.start("tok");
  fakeChild.emit("error", new Error("spawn EACCES"));

  const outcome = await Promise.race([
    mgr.stop().then(() => "resolved"),
    new Promise(r => setTimeout(() => r("timed-out"), 1000))
  ]);
  assert.equal(outcome, "resolved", "stop() must not hang forever after a spawn failure");
  assert.equal(mgr.getStatus().processRunning, false);
});

test("C-5: stop() resolves immediately (no signal attempted) when the child never obtained a real pid, independent of whether 'error' has fired yet", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  const fakeChild = makeFakeChildThatFailsToSpawn(); // pid stays undefined; deliberately never emits anything in this test
  const mgr = CFM.createProcessManager(dir, { spawnFn: () => fakeChild, ...fakeTimers() });

  await mgr.start("tok");
  const outcome = await Promise.race([
    mgr.stop().then(() => "resolved"),
    new Promise(r => setTimeout(() => r("timed-out"), 1000))
  ]);
  assert.equal(outcome, "resolved");
  assert.equal(fakeChild.killSignals.length, 0, "a child with no real pid must never be sent a signal");
});

test("C-5: stop() resolves via the 'error' event (not just 'exit') when a child with a real pid errors without ever exiting", async () => {
  const dir = tempBaseDir();
  fakeInstalledBinary(dir);
  const fakeChild = makeFakeChildThatErrorsWithoutExiting();
  const mgr = CFM.createProcessManager(dir, { spawnFn: () => fakeChild, ...fakeTimers() });

  await mgr.start("tok");
  const stopPromise = mgr.stop();
  // stop() is itself serialized (see remote-access/serialize.js) — its real
  // body, which registers the 'exit'/'error' listeners, runs on a microtask
  // queued by that wrapper rather than synchronously inside this call. Flush
  // pending microtasks before emitting, so the emit lands after those
  // listeners actually exist.
  await new Promise(r => setImmediate(r));
  fakeChild.emit("error", new Error("EPIPE"));

  const outcome = await Promise.race([
    stopPromise.then(() => "resolved"),
    new Promise(r => setTimeout(() => r("timed-out"), 1000))
  ]);
  assert.equal(outcome, "resolved", "stop() must not hang forever waiting only for 'exit' when 'error' fires instead");
});
