// test/utilization/checkpointer.test.js — WAL checkpoints and nightly backups on
// the worker thread (Phase 1.2), against the real worker, the real writer and
// real SQLite files. Never a checkpoint on the main thread; when the WAL cannot
// be controlled, analytics stops saving, not SnapCon.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { DatabaseSync } = require("node:sqlite");
const { createUtilizationStore } = require("../../utilization/UtilizationStore");
const { createCheckpointer } = require("../../utilization/Checkpointer");
const { createWriter } = require("../../utilization/Writer");
const { createTracker } = require("../../utilization/Tracker");
const { createUtilization } = require("../../utilization");
const { quiet, tmpBase, ledgerOf } = require("./helpers");

const until = async (fn, ms = 5000, what = "condition") => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timed out waiting for " + what); await new Promise(r => setTimeout(r, 2)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Small limits so the tests run in seconds; production uses 8 MB / 32 MB / 8 MB.
// The store truncates the WAL file to journal_size_limit at a reset (4 MB in
// production, below the 8 / 32 MB thresholds); the tests keep that relation.
const SMALL = { triggerBytes: 128 << 10, pauseBytes: 1 << 20, resumeBytes: 256 << 10 };
const SMALL_JOURNAL = 64 << 10;
const FAST = { retryDelaysMs: [10], restartDelaysMs: [20], periodMs: 1e9, faults: true };

function setup(t, cpOpts = {}, wOpts = {}, base = tmpBase(t)) {
  const store = createUtilizationStore({ baseDir: base, log: quiet, journalSizeLimit: SMALL_JOURNAL }).open();
  let writer = null;
  const commitsAt = [];
  const cp = createCheckpointer({ store, log: quiet, ...FAST, ...SMALL, onRelease: () => writer.kick(), onStop: why => writer.halt(why), ...cpOpts });
  writer = createWriter({ store, log: quiet, batchOps: 1, onCommit: () => { commitsAt.push(performance.now()); cp.noteCommit(); }, onIdle: () => cp.noteIdle(), gate: () => cp.gate(), ...wOpts });
  t.after(async () => { await cp.stop(200); store.close(); });
  store.upsertPrinter({ id: "p", name: "P", connector: "x", isVirtual: false, at: 0 });
  let at = 1000, n = 0;
  const push = (k = 1) => { for (let i = 0; i < k; i++) { at += 1000; n++; writer.enqueue({ type: "step", printerId: "p", at, next: { kind: n % 2 ? "idle" : "offline" } }); } writer.kick(); };
  const drained = () => writer.pending() === 0 && !cp.status().inflight;
  return { base, store, cp, writer, push, drained, commitsAt, queued: () => n };
}
const auto = store => store.pragma("wal_autocheckpoint");
const walFile = store => { try { return fs.statSync(store.paths().walPath).size; } catch { return 0; } };
const quickCheck = file => { const db = new DatabaseSync(file); try { return db.prepare("PRAGMA quick_check").get().quick_check; } finally { db.close(); } };
// A reader holding a snapshot: the WAL cannot reset past it.
function holdReader(t, file) {
  const reader = new DatabaseSync(file);
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM segments").get();
  let open = true;
  const release = () => { if (open) { open = false; reader.exec("COMMIT"); reader.close(); } };
  t.after(release);
  return release;
}

test("automatic checkpoints are off on the main connection from the moment it opens", async t => {
  const { store, cp } = setup(t);
  assert.equal(auto(store), 0, "before the worker exists");
  cp.start();
  assert.equal(cp.status().state, "worker-down");
  await until(() => cp.status().state === "ok", 5000, "ok");
  assert.equal(auto(store), 0);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../../utilization/Checkpointer.js"), "utf8"), /wal_autocheckpoint|setAutoCheckpoint/, "nothing can turn it back on");
});

test("idle checkpoints let SQLite reset the WAL: shown by its frame counts, and the file stays small", async t => {
  const { store, cp, push, drained } = setup(t, { everyCommits: 20 });
  cp.start(); await until(() => cp.status().state === "ok");
  for (let i = 0; i < 40; i++) { push(25); await until(drained); await sleep(1); }
  const s = cp.status();
  assert.ok(s.checkpoints >= 20, `${s.checkpoints} checkpoints`);
  assert.ok(s.resets >= 10, `${s.resets} resets seen in the frame counts`);
  assert.ok(s.walLogicalBytes < SMALL.resumeBytes, `logical ${s.walLogicalBytes}`);
  assert.ok(s.physicalMax <= 4 << 20, `file at most ${s.physicalMax}`);
  assert.equal(store.segments("p").length, 1000);
});

test("sustained writes, never idle: the barrier holds commits while a checkpoint runs, so the WAL still resets", async t => {
  const { store, cp, writer, push, queued } = setup(t, { everyCommits: 1e9 });
  cp.start(); await until(() => cp.status().state === "ok");
  let lagMax = 0, last = performance.now();
  const iv = setInterval(() => { const n = performance.now(); lagMax = Math.max(lagMax, n - last - 1); last = n; }, 1);
  const end = Date.now() + 1500;
  let neverIdle = true;
  while (Date.now() < end) { if (writer.pending() < 200) push(50); if (writer.pending() === 0) neverIdle = false; await new Promise(r => setImmediate(r)); }
  clearInterval(iv);
  const s = cp.status();
  assert.ok(neverIdle, "the writer was never idle");
  // A reset is only seen when a checkpoint's frame count drops below the last
  // one's, which a busy machine can hide; the bound below is the guarantee.
  assert.ok(s.checkpoints >= 2 && s.resets >= 1, `${s.checkpoints} checkpoints, ${s.resets} resets`);
  assert.equal(s.state, "ok", "never needed to pause");
  assert.ok(s.physicalMax < SMALL.pauseBytes, `file reached ${s.physicalMax}`);
  // Gross blocking only: this process shares the machine, and the latency
  // bounds themselves are measured by the benchmark, not here.
  assert.ok(lagMax < 250, `event loop lagged ${lagMax.toFixed(1)} ms`);
  await until(() => writer.pending() === 0, 10000);
  assert.equal(store.segments("p").length, queued(), "every step saved");
});

test("the barrier holds commits at most 250 ms, then lets them go while a slow checkpoint still runs", async t => {
  const { cp, push, commitsAt, drained } = setup(t, { everyCommits: 1, checkpointTimeoutMs: 10e3 });
  cp.start(); await until(() => cp.status().state === "ok");
  push(1); await until(drained);
  await cp._fault({ hangMs: 800 });
  push(1); await until(() => cp.status().inflight);
  const t0 = performance.now();
  commitsAt.length = 0;
  push(20);
  await sleep(150);
  assert.equal(commitsAt.length, 0, "held during the barrier");
  await until(() => commitsAt.length > 0, 1000, "released");
  const firstAfter = commitsAt[0] - t0;
  assert.ok(firstAfter >= 200 && firstAfter < 450, `first commit after ${firstAfter.toFixed(0)} ms`);
  assert.equal(cp.status().inflight, true, "the checkpoint was still running");
});

test("one checkpoint at a time: asking again while one runs does not start another", async t => {
  const { cp, push, drained } = setup(t, { checkpointTimeoutMs: 10e3 });
  cp.start(); await until(() => cp.status().state === "ok");
  push(3); await until(drained);
  await cp._fault({ hangMs: 300 });
  push(1); await until(drained);
  const before = cp.status().checkpoints;
  cp.checkpointNow(); cp.checkpointNow(); cp.checkpointNow();
  assert.equal(cp.status().pending, 1, "one request to the worker");
  await until(() => !cp.status().inflight, 3000);
  assert.equal(cp.status().checkpoints, before + 1);
});

test("contention: a reader holding a snapshot keeps the WAL from resetting; saving pauses (no main-thread checkpoint) and resumes once it has gone", async t => {
  const { store, cp, push, writer } = setup(t, { everyCommits: 10 });
  cp.start(); await until(() => cp.status().state === "ok");
  const release = holdReader(t, store.paths().dbPath);
  for (let i = 0; i < 400 && cp.status().state !== "paused-wal"; i++) { push(10); await sleep(1); }
  assert.equal(cp.status().state, "paused-wal");
  assert.equal(auto(store), 0, "no fallback");
  await sleep(50);
  const at = store.segments("p").length;
  push(30); await sleep(100);
  assert.ok(store.segments("p").length <= at + 1, "held while paused (one probe commit at most)");
  assert.ok(writer.pending() >= 29, "kept in memory");
  release();
  await until(() => cp.status().state === "ok", 8000, "resumed");
  assert.ok(cp.status().walLogicalBytes < SMALL.resumeBytes);
  await until(() => writer.pending() === 0, 8000);
  assert.ok(store.segments("p").length > at);
  assert.equal(auto(store), 0);
});

test("paused too long: recording stops safely, the worker is gone, and nothing falls back to the main thread", async t => {
  const { store, cp, push, writer } = setup(t, { everyCommits: 10, maxPausedMs: 300 });
  cp.start(); await until(() => cp.status().state === "ok");
  holdReader(t, store.paths().dbPath);
  for (let i = 0; i < 400 && cp.status().state !== "paused-wal"; i++) { push(10); await sleep(1); }
  await until(() => cp.status().state === "stopped", 3000, "stopped");
  assert.equal(writer.status().mode, "stopped");
  assert.equal(cp.workerRunning(), false);
  assert.equal(auto(store), 0);
  assert.equal(cp.backup(), false);
});

test("while saving is paused, overflowed readings are Not recorded, never invented", async t => {
  const base = tmpBase(t);
  const store = createUtilizationStore({ baseDir: base, log: quiet, journalSizeLimit: SMALL_JOURNAL }).open();
  let writer = null, tracker = null;
  const cp = createCheckpointer({ store, log: quiet, ...FAST, ...SMALL, everyCommits: 10, onRelease: () => writer.kick(), onStop: w => writer.halt(w) });
  writer = createWriter({ store, log: quiet, batchOps: 1, maxQueue: 40, onCommit: () => cp.noteCommit(), onIdle: () => cp.noteIdle(), gate: () => cp.gate(), onResync: () => tracker.resync() });
  tracker = createTracker({ store, writer, log: quiet });
  t.after(async () => { await cp.stop(200); store.close(); });
  let clock = 1_800_000_000_000;
  const T0 = clock;
  tracker.start(clock); cp.start(); await until(() => cp.status().state === "ok");
  const ps = Array.from({ length: 10 }, (_, i) => ({ id: "p" + i, name: "P" + i, connector: "x" }));
  const poll = k => { clock += 30e3; tracker.beginTick(ps, ps, clock); ps.forEach((p, i) => tracker.observe(p, { online: true, state: (k + i) % 2 ? "standby" : "printing", filename: "f" }, clock)); writer.kick(); };
  const release = holdReader(t, store.paths().dbPath);
  let k = 0;
  for (; k < 600 && cp.status().state !== "paused-wal"; k++) { poll(k); await sleep(1); }
  assert.equal(cp.status().state, "paused-wal");
  const pausedFrom = clock;
  for (let j = 0; j < 30; j++) { poll(k++); await sleep(1); }
  assert.ok(writer.status().droppedOverflow > 0, "overflowed");
  const pausedTo = clock;
  release();
  await until(() => cp.status().state === "ok", 8000, "resumed");
  for (let j = 0; j < 3; j++) { poll(k++); await sleep(5); }
  await until(() => writer.pending() === 0, 8000);
  for (const p of ps) {
    const segs = store.segments(p.id);
    for (let i = 1; i < segs.length; i++) assert.ok(segs[i].start >= segs[i - 1].end, "no overlap");
    const inside = segs.filter(s => s.start > pausedFrom + 60e3 && s.start < pausedTo - 60e3);
    assert.equal(inside.length, 0, `${p.id}: ${inside.length} intervals invented in the overflowed time`);
    assert.ok(ledgerOf(store, p.id, T0, clock).buckets.notRecorded > 0, `${p.id}: that time is Not recorded`);
  }
});

test("worker crash: worker-down, saving goes on, a replacement takes over", async t => {
  const { store, cp, push, drained } = setup(t);
  cp.start(); await until(() => cp.status().state === "ok");
  cp._fault({ crash: true }).catch(() => {});
  await until(() => cp.status().state === "worker-down", 3000, "down");
  push(20); await until(() => store.segments("p").length === 20, 3000, "saved while down");
  await until(() => cp.status().state === "ok", 5000, "replaced");
  assert.equal(cp.status().restarts, 1);
  assert.equal(auto(store), 0);
  push(5); await until(drained);
});

test("worker down while the WAL reaches the limit: paused, then the replacement checkpoints and saving resumes", async t => {
  const { store, cp, push, writer } = setup(t, { restartDelaysMs: [400], everyCommits: 1e9 });
  cp.start(); await until(() => cp.status().state === "ok");
  cp._fault({ crash: true }).catch(() => {});
  await until(() => cp.status().state === "worker-down");
  for (let i = 0; i < 400 && cp.status().state !== "paused-wal"; i++) { push(10); await sleep(0); }
  assert.equal(cp.status().state, "paused-wal");
  await until(() => cp.status().state === "ok", 8000, "resumed");
  await until(() => writer.pending() === 0, 8000);
  assert.equal(auto(store), 0);
  assert.ok(cp.status().walLogicalBytes < SMALL.resumeBytes);
});

test("a worker that keeps failing: bounded replacements, then recording stops", async t => {
  const base = tmpBase(t);
  const broken = path.join(base, "broken-worker.js");
  fs.writeFileSync(broken, "process.exit(5);\n");
  const { store, cp, writer } = setup(t, { workerFile: broken, maxRestarts: 3 }, {}, base);
  cp.start();
  await until(() => cp.status().state === "stopped", 5000, "stopped");
  assert.equal(cp.status().restarts, 4, "the first start and three replacements");
  assert.equal(writer.status().mode, "stopped");
  assert.equal(auto(store), 0);
  assert.equal(cp.backup(), false, "no backup without the worker, and none on the main thread");
});

test("a stuck worker is not waited for: terminated after its timeout and replaced", async t => {
  const { cp, push } = setup(t, { checkpointTimeoutMs: 100, everyCommits: 1 });
  cp.start(); await until(() => cp.status().state === "ok");
  await cp._fault({ hangMs: 3000 });
  push(2);
  await until(() => cp.status().state === "worker-down", 2000, "down");
  await until(() => cp.status().state === "ok", 8000, "replaced");
});

test("a transient error (busy) is retried; corruption stops recording", async t => {
  const a = setup(t, { everyCommits: 1 });
  a.cp.start(); await until(() => a.cp.status().state === "ok");
  await a.cp._fault({ throwCode: 5 });
  a.push(2);
  await until(() => a.cp.status().checkpoints >= 1, 3000, "retried");
  assert.equal(a.cp.status().state, "ok");
  const b = setup(t, { everyCommits: 1 });
  b.cp.start(); await until(() => b.cp.status().state === "ok");
  await b.cp._fault({ throwCode: 11 });
  b.push(2);
  await until(() => b.cp.status().state === "stopped", 3000, "stopped");
  assert.equal(b.writer.status().mode, "stopped");
});

test("backup overlapping checkpoints and writes: a consistent copy, and saving keeps going", async t => {
  const { store, cp, push, writer, drained } = setup(t, { everyCommits: 5 });
  cp.start(); await until(() => cp.status().state === "ok");
  push(800); await until(drained, 10000);
  assert.equal(cp.backup(), true);
  assert.equal(cp.backup(), false, "one at a time");
  const before = store.segments("p").length;
  while (!cp.status().lastBackup) { push(5); await sleep(1); }
  await until(() => writer.pending() === 0, 8000);
  const b = cp.status().lastBackup;
  assert.equal(b.ok, true);
  const file = path.join(store.paths().backupsDir, b.file);
  assert.equal(quickCheck(file), "ok");
  const db = new DatabaseSync(file); const n = db.prepare("SELECT count(*) AS n FROM segments").get().n; db.close();
  assert.ok(n >= before && n <= store.segments("p").length);
  assert.ok(store.segments("p").length > before, "saved during the backup");
  assert.equal(cp.status().state, "ok");
});

test("a failed backup is reported and changes nothing else; backups are skipped unless ok", async t => {
  const failed = [];
  const { store, cp, push, drained } = setup(t, { onBackupFailed: e => failed.push(e.message) });
  assert.equal(cp.backup(), false, "not before the worker is ready");
  cp.start(); await until(() => cp.status().state === "ok");
  fs.rmSync(store.paths().backupsDir, { recursive: true, force: true });
  fs.writeFileSync(store.paths().backupsDir, "a file where the backups folder should be");
  cp.backup();
  await until(() => cp.status().lastBackup, 5000);
  assert.equal(cp.status().lastBackup.ok, false);
  assert.equal(failed.length, 1);
  push(5); await until(drained);
  assert.equal(store.segments("p").length, 5);
  assert.equal(cp.status().state, "ok");
});

test("forced stop in the middle of a backup: the database is intact; the partial copy is cleared at the next start", async t => {
  const { base, store, cp, push, drained } = setup(t);
  cp.start(); await until(() => cp.status().state === "ok");
  push(100); await until(drained);
  fs.mkdirSync(store.paths().backupsDir, { recursive: true });
  fs.writeFileSync(path.join(store.paths().backupsDir, "utilization-20261102-000000-nightly.db.partial"), "cut off");
  await cp._fault({ hangMs: 3000 });
  cp.backup();
  await sleep(20);
  await cp.stop(0);
  store.close();
  const again = createUtilizationStore({ baseDir: base, log: quiet }).open();
  const cp2 = createCheckpointer({ store: again, log: quiet, ...FAST });
  t.after(async () => { await cp2.stop(200); again.close(); });
  cp2.start();
  assert.equal(quickCheck(again.paths().dbPath), "ok");
  assert.equal(again.segments("p").length, 100);
  assert.deepEqual(fs.readdirSync(again.paths().backupsDir).filter(f => f.endsWith(".partial")), []);
  await until(() => cp2.status().state === "ok");
});

// ---- shutdown, through the module server.js uses ----
function wired(t, opts = {}, base = tmpBase(t)) {
  let clock = 1_800_000_000_000;
  const u = createUtilization({ baseDir: base, log: quiet, now: () => clock, journalSizeLimit: SMALL_JOURNAL, checkpointerOptions: { ...FAST, ...(opts.cp || {}) } });
  const ps = Array.from({ length: 30 }, (_, i) => ({ id: "p" + i, name: "P" + i, connector: "x" }));
  const poll = k => { clock += 30e3; u.beginTick(ps, ps); ps.forEach((p, i) => u.observe(p, { online: true, state: (k + i) % 3 ? "standby" : "printing", filename: "a" })); u.endTick(); };
  return { u, poll, base, dbFile: path.join(base, "utilization-data", "utilization.db") };
}
async function lagDuring(fn) {
  let lag = 0, last = performance.now();
  const iv = setInterval(() => { const n = performance.now(); lag = Math.max(lag, n - last - 1); last = n; }, 1);
  const r = await fn();
  clearInterval(iv);
  return { r, lag };
}

test("clean stop: asynchronous, bounded, queued steps saved; the main connection closes first and the worker folds the WAL", async t => {
  const { u, poll, dbFile } = wired(t);
  u.start(); await until(() => u.status().checkpoints.state === "ok");
  for (let k = 0; k < 20; k++) { poll(k); await sleep(2); }
  poll(20);                                                    // queued, not yet saved
  const t0 = performance.now();
  const { r, lag } = await lagDuring(() => u.stop(1000));
  const ms = performance.now() - t0;
  assert.equal(r.left, 0);
  assert.equal(r.mainClosed, true);
  assert.ok(r.closeMs < 10, `main close ${r.closeMs.toFixed(2)} ms`);
  assert.equal(r.worker.workerClosed, true);
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
  assert.ok(lag < 30, `event loop lagged ${lag.toFixed(1)} ms`);
  assert.equal(fs.existsSync(dbFile + "-wal") ? fs.statSync(dbFile + "-wal").size : 0, 0, "WAL folded back, by the worker");
  assert.equal(quickCheck(dbFile), "ok");
});

test("stop with a stuck worker: never past its budget; the WAL is left for the next start, which recovers it", async t => {
  const { u, poll, base, dbFile } = wired(t, { cp: { checkpointTimeoutMs: 60e3, everyCommits: 1 } });
  u.start(); await until(() => u.status().checkpoints.state === "ok");
  for (let k = 0; k < 10; k++) { poll(k); await sleep(2); }
  await until(() => u.status().writer.pending === 0 && !u.status().checkpoints.inflight);
  await u._checkpointerFault({ hangMs: 3000 });
  poll(10);
  await sleep(20);
  const t0 = performance.now();
  const r = await u.stop(300);
  assert.ok(performance.now() - t0 < 600, `stop took ${(performance.now() - t0).toFixed(0)} ms`);
  assert.equal(r.worker.workerClosed, false);
  const again = createUtilizationStore({ baseDir: base, log: quiet }).open();
  t.after(() => again.close());
  assert.equal(again.isAvailable(), true);
  assert.ok(again.segments("p0").length > 0);
  assert.equal(quickCheck(dbFile), "ok");
});

test("stop with the worker down: the main connection is not closed (no WAL fold on the main thread); the next start recovers", async t => {
  const base = tmpBase(t);
  const broken = path.join(base, "broken-worker.js");
  fs.writeFileSync(broken, "process.exit(5);\n");
  const { u, poll, dbFile } = wired(t, { cp: { workerFile: broken, restartDelaysMs: [60e3] } }, base);
  u.start();
  await until(() => u.status().checkpoints.restarts >= 1, 3000, "worker gone");
  for (let k = 0; k < 10; k++) { poll(k); await sleep(2); }
  await until(() => u.status().writer.pending === 0);
  const wal = fs.statSync(dbFile + "-wal").size;
  assert.ok(wal > 0);
  const r = await u.stop(500);
  assert.equal(r.mainClosed, false, "left open for the process exit");
  // The stop's own final steps were appended; a fold would have emptied or removed it.
  assert.ok(fs.statSync(dbFile + "-wal").size >= wal, "not folded here");
  const again = createUtilizationStore({ baseDir: base, log: quiet }).open();
  t.after(() => again.close());
  assert.ok(again.segments("p0").length > 0);
  assert.equal(quickCheck(dbFile), "ok");
});

test("stop while saving is paused: nothing more is saved, it does not wait past its budget, the rest stays Not recorded", async t => {
  const { u, poll, dbFile } = wired(t, { cp: { ...SMALL, everyCommits: 10 } });
  u.start(); await until(() => u.status().checkpoints.state === "ok");
  holdReader(t, dbFile);
  for (let k = 0; k < 600 && u.status().checkpoints.state !== "paused-wal"; k++) { poll(k); await sleep(1); }
  assert.equal(u.status().checkpoints.state, "paused-wal");
  poll(999);
  const t0 = performance.now(), cpu0 = process.cpuUsage();
  const r = await u.stop(1000, 300);
  const cpuMs = (process.cpuUsage(cpu0).user + process.cpuUsage(cpu0).system) / 1000;
  assert.ok(performance.now() - t0 < 1000);
  assert.ok(r.left > 0, "left unsaved, not forced through");
  assert.ok(cpuMs < 150, `waited on timers, not spinning: ${cpuMs.toFixed(0)} ms of CPU`);
});

test("recovery: a damaged database is moved aside before the worker starts, and the worker works on the new one", async t => {
  const base = tmpBase(t), dir = path.join(base, "utilization-data");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "utilization.db"), "not a database");
  const u = createUtilization({ baseDir: base, log: quiet, checkpointerOptions: FAST });
  t.after(() => u.stop());
  u.start();
  assert.equal(u.status().store.recovery.moved.length, 1);
  await until(() => u.status().checkpoints.state === "ok", 5000, "worker");
});

test("no database: no worker, nothing to stop", async t => {
  const store = createUtilizationStore({ baseDir: tmpBase(t), log: quiet, sqlite: null }).open();
  const cp = createCheckpointer({ store, log: quiet });
  cp.start();
  assert.equal(cp.status().state, "off");
  assert.equal(cp.backup(), false);
  assert.deepEqual(await cp.stop(10), { workerClosed: false, ms: 0 });
});
