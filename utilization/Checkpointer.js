// utilization/Checkpointer.js — supervises checkpoint-worker.js: when the WAL
// is checkpointed, what happens when that cannot be done, the nightly backup,
// and the worker's share of shutdown. (Fleet utilization, Phase 1.2.)
//
// The main connection never checkpoints (UtilizationStore turns SQLite's
// automatic checkpoint off at open, for good). There is no fallback to a
// checkpoint on the main thread, ever: when the worker cannot keep the WAL
// under control, analytics stops saving, not SnapCon.
//
// States:
//   ok          the worker runs; commits go ahead.
//   worker-down the worker is starting, exited, failed to start or got stuck.
//               Commits go ahead (the WAL grows, up to the pause threshold). It
//               is replaced after 1 s, 5 s, 30 s, 5 min; `maxRestarts` in a row
//               without a complete checkpoint -> stopped.
//   paused-wal  the WAL file reached `pauseBytes`: the writer holds every commit
//               (steps wait in memory, bounded by the writer's queue; on
//               overflow that time is Not recorded, never made up). The worker
//               checkpoints with nothing writing; then one commit is let through
//               so SQLite can reset the WAL, and the next checkpoint's frame count
//               shows whether it did. Logical WAL under `resumeBytes` -> ok.
//               Still paused after `maxPausedMs` -> stopped.
//   stopped     recording stops until SnapCon restarts (the writer drops what is
//               waiting; the next start closes open intervals at the last
//               committed checkpoint). Also on corruption reported by the worker.
//
// Checkpoints are PASSIVE (checkpoint-worker.js): they never wait for a lock
// and never block the main connection. A complete one (busy 0, checkpointed ==
// log) copies back the frames that existed when it began; SQLite restarts the
// WAL from its beginning only at the next commit, and only if no commit landed
// while it ran. Hence:
//   - checkpoints are asked for when the writer goes idle (the end of a poll's
//     saves), or when the WAL file passes `triggerBytes`;
//   - while one runs the writer holds its commits (the barrier), for at most
//     `barrierMs`; past that it goes on and the next checkpoint does the reset.
// Progress is judged by SQLite's frame counts (`log`, `checkpointed`), the
// logical WAL; the file's size (physical) only grows until a reset truncates it
// to journal_size_limit. The thresholds are limits this code acts on, not a
// guarantee that SQLite can reset the WAL.
//
// Nothing here is awaited by the poll, the queue or a printer command, and no
// call blocks the event loop: stop() is asynchronous and bounded.
"use strict";
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { Worker } = require("node:worker_threads");
const { classify } = require("./Writer");

const WORKER_FILE = path.join(__dirname, "checkpoint-worker.js");

function createCheckpointer({ store, log = console, workerFile = WORKER_FILE, faults = false, now = Date.now,
  everyCommits = 200, triggerBytes = 8 << 20, pauseBytes = 32 << 20, resumeBytes = 8 << 20, barrierMs = 250,
  periodMs = 60e3, checkpointTimeoutMs = 30e3, backupTimeoutMs = 10 * 60e3, retryDelaysMs = [1e3, 5e3, 30e3, 60e3],
  restartDelaysMs = [1e3, 5e3, 30e3, 300e3], maxRestarts = 5, maxPausedMs = 30 * 60e3,
  timer = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
  onBackupFailed = () => {}, onRelease = () => {}, onStop = () => {} } = {}) {
  let worker = null, ready = false, state = "off", reason = null, stopping = false;
  let nextId = 1, commitsSince = 0, inflight = false, inflightAt = 0, backingUp = false;
  let failures = 0, restartsInRow = 0, pausedAt = null, probe = 0, pageSize = 4096;
  let periodic = null, retryTimer = null, restartTimer = null, pauseTimer = null;
  const pending = new Map();
  const stats = { checkpoints: 0, incomplete: 0, errors: 0, restarts: 0, resets: 0, pauses: 0, physicalMax: 0, lastCheckpoint: null, lastBackup: null, lastLogFrames: null };
  const say = (lvl, m) => { try { log[lvl]("[utilization] " + m); } catch {} };
  const paths = () => store.paths();
  function physical() { try { const n = fs.statSync(paths().walPath).size; if (n > stats.physicalMax) stats.physicalMax = n; return n; } catch { return 0; } }
  const logicalBytes = () => (stats.lastLogFrames == null ? null : stats.lastLogFrames * pageSize);

  function setState(s, why) {
    if (state === "stopped") return;
    if (state !== s) {
      const level = s === "ok" ? "log" : s === "stopped" ? "error" : "warn";
      say(level, `analytics checkpoints: ${s}${why ? " (" + why + ")" : ""}${s === "stopped" ? "; recording stopped until SnapCon restarts, printing is not affected" : ""}`);
    }
    state = s; reason = why || null;
  }
  // The state when nothing is wrong right now: paused wins over a down worker.
  function settle() {
    if (state === "stopped" || state === "off") return;
    if (pausedAt != null) setState("paused-wal", reason);
    else if (!worker || !ready) setState("worker-down", reason || "starting");
    else setState("ok");
  }
  function stopRecording(why) {
    if (state === "stopped") return;
    setState("stopped", why);
    clearInterval(periodic); clearTimeout(retryTimer); clearTimeout(restartTimer); clearTimeout(pauseTimer);
    try { onStop(why); } catch {}
    if (worker) { const w = worker; worker = null; ready = false; w.terminate().catch(() => {}); }
    failAll("recording stopped");
  }

  function failAll(message) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(message), { code: "WORKER_EXITED" })); }
    pending.clear();
  }
  function request(cmd, payload, timeoutMs) {
    if (!worker || !ready) return Promise.reject(Object.assign(new Error("checkpoint worker is not running"), { code: "WORKER_DOWN" }));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`checkpoint worker did not answer "${cmd}" within ${timeoutMs / 1000} s`), { code: "WORKER_TIMEOUT" }));
        if (worker) { reason = `worker stuck on ${cmd}`; worker.terminate().catch(() => {}); }   // replaced, not waited for
      }, timeoutMs);
      if (t.unref) t.unref();
      pending.set(id, { resolve, reject, timer: t });
      worker.postMessage({ id, cmd, payload });
    });
  }

  function spawn() {
    if (stopping || state === "stopped") return;
    ready = false;
    let w;
    try { w = new Worker(workerFile, { workerData: { dbPath: paths().dbPath, backupsDir: paths().backupsDir, faults } }); }
    catch (e) { reason = "worker thread unavailable: " + e.message; settle(); scheduleRestart(); return; }
    worker = w;
    w.unref();
    w.on("message", msg => {
      if (msg && "ready" in msg) {
        if (!msg.ready) {
          if (classify(msg.error) === "permanent") stopRecording("worker could not open the database: " + (msg.error && msg.error.message));
          else { reason = "worker could not open the database"; w.terminate().catch(() => {}); }
          return;
        }
        ready = true; reason = null; settle();
        if (commitsSince || pausedAt != null) checkpoint();
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error && msg.error.message), { errcode: msg.error && msg.error.errcode, code: msg.error && msg.error.code }));
    });
    w.on("error", e => say("warn", "checkpoint worker error: " + e.message));
    w.on("exit", code => {
      if (worker === w) { worker = null; ready = false; }
      failAll(`checkpoint worker exited (code ${code})`);
      inflight = false; backingUp = false;
      release();
      if (stopping || state === "stopped") return;
      stats.restarts++;
      reason = reason || `worker exited (code ${code})`;
      settle();
      scheduleRestart();
    });
  }
  function scheduleRestart() {
    if (stopping || state === "stopped") return;
    if (restartsInRow >= maxRestarts) { stopRecording(`the checkpoint worker failed ${restartsInRow} times in a row`); return; }
    const delay = restartDelaysMs[Math.min(restartsInRow, restartDelaysMs.length - 1)];
    restartsInRow++;
    clearTimeout(restartTimer);
    restartTimer = timer(() => { reason = null; spawn(); }, delay);
  }

  // The writer may go again (a checkpoint ended, a probe commit is allowed).
  function release() { try { onRelease(); } catch {} }

  function checkpoint() {
    if (inflight || !worker || !ready || stopping || state === "stopped") return;
    inflight = true; inflightAt = performance.now();
    const before = physical(), commits = commitsSince;
    commitsSince = 0;
    request("checkpoint", {}, checkpointTimeoutMs).then(r => {
      inflight = false;
      const complete = r.busy === 0 && r.log >= 0 && r.checkpointed === r.log;
      // A smaller log than the last one seen: SQLite restarted the WAL in between.
      if (stats.lastLogFrames != null && r.log < stats.lastLogFrames) stats.resets++;
      stats.lastLogFrames = r.log;
      stats.lastCheckpoint = { at: now(), ms: r.ms, complete, log: r.log, checkpointed: r.checkpointed, physicalBefore: before, commits };
      if (complete) { stats.checkpoints++; failures = 0; restartsInRow = 0; }
      else { stats.incomplete++; commitsSince += commits; retryLater(); }
      if (pausedAt != null) afterPausedCheckpoint(complete);
      release();
    }, e => {
      inflight = false;
      release();
      if (e.code === "WORKER_EXITED" || e.code === "WORKER_TIMEOUT" || e.code === "WORKER_DOWN") { commitsSince += commits; return; }
      stats.errors++;
      if (classify(e) === "transient") { commitsSince += commits; retryLater(); return; }
      stopRecording("checkpoint failed: " + e.message);
    });
  }
  function retryLater() {
    failures++;
    const delay = retryDelaysMs[Math.min(failures - 1, retryDelaysMs.length - 1)];
    clearTimeout(retryTimer);
    retryTimer = timer(checkpoint, delay);
  }

  // Paused: a complete checkpoint lets one commit through (the reset needs a
  // writer); the checkpoint after that commit reports the logical WAL.
  function enterPause(n) {
    if (pausedAt != null || state === "stopped") return;
    pausedAt = now(); stats.pauses++; probe = 0;
    reason = `WAL file reached ${(n / 1048576).toFixed(1)} MB; analytics saving paused`;
    settle();
    clearTimeout(pauseTimer);
    pauseTimer = timer(() => { if (pausedAt != null) stopRecording(`WAL still over the limit after ${Math.round(maxPausedMs / 60e3)} min`); }, maxPausedMs);
    checkpoint();
  }
  function afterPausedCheckpoint(complete) {
    const lb = logicalBytes();
    if (complete && lb != null && lb < resumeBytes) {
      pausedAt = null; probe = 0; reason = null; clearTimeout(pauseTimer); settle();
      say("log", `analytics saving resumed (WAL ${(lb / 1048576).toFixed(1)} MB in use, file ${(physical() / 1048576).toFixed(1)} MB)`);
      return;
    }
    if (complete) probe = 1;                    // one commit, then look again
  }
  // The writer asks before each commit or prune pass: how long to hold (ms).
  function gate() {
    if (state === "stopped" || state === "off") return 0;
    if (pausedAt != null) {
      if (probe > 0 && !inflight) { probe = 0; return 0; }   // the one commit that may reset the WAL
      return 1000;
    }
    if (inflight) { const left = barrierMs - (performance.now() - inflightAt); if (left > 0) return Math.ceil(left); }
    return 0;
  }

  // After each commit: a counter and one stat of the WAL file (microseconds).
  function noteCommit() {
    if (state === "off" || state === "stopped" || stopping) return;
    commitsSince++;
    if (pausedAt != null) { checkpoint(); return; }        // the probe commit: look again
    const n = physical();
    if (n >= pauseBytes) { enterPause(n); return; }
    if (n >= triggerBytes) checkpoint();
  }
  // The writer has nothing left to save.
  function noteIdle() {
    if (state === "off" || state === "stopped" || stopping || !commitsSince) return;
    if (commitsSince >= everyCommits || physical() >= triggerBytes) checkpoint();
  }

  function start() {
    if (!store.isAvailable()) { state = "off"; return; }
    stopping = false;
    try { pageSize = store.pragma("page_size") || 4096; } catch {}
    // After a reset SQLite truncates the WAL file to journal_size_limit, not to
    // zero: the file size can only signal growth above that.
    try { const lim = store.pragma("journal_size_limit"); if (lim >= pauseBytes || lim >= triggerBytes) say("warn", `WAL thresholds (${triggerBytes} / ${pauseBytes} bytes) are not above journal_size_limit (${lim}); the file size cannot show a reset`); } catch {}
    // A backup cut off by a forced stop leaves a .partial file: never a backup.
    try { for (const f of fs.readdirSync(paths().backupsDir)) if (/^utilization-.*\.partial$/.test(f)) fs.rmSync(path.join(paths().backupsDir, f), { force: true }); } catch {}
    state = "worker-down"; reason = "starting";
    spawn();
    periodic = setInterval(() => { if (commitsSince > 0) checkpoint(); }, periodMs);
    if (periodic.unref) periodic.unref();
  }

  // Nightly backup, on the worker; skipped (tried at the next due check) when
  // the worker is not running or saving is paused. Never on the main thread.
  function backup({ reason: why = "nightly" } = {}) {
    if (backingUp) return false;
    if (state !== "ok") { say("warn", `backup skipped: analytics checkpoints are ${state}; it is tried again later`); return false; }
    backingUp = true;
    const t0 = now();
    request("backup", { reason: why, now: now() }, backupTimeoutMs).then(r => {
      backingUp = false; stats.lastBackup = { at: now(), ok: true, ...r };
      say("log", `backup ${r.file}: ${r.bytes} bytes in ${r.ms} ms (worker)`);
    }, e => {
      backingUp = false; stats.lastBackup = { at: now(), ok: false, error: e.message, ms: now() - t0 };
      say("warn", "backup failed: " + e.message);
      try { onBackupFailed(e); } catch {}
    });
    return true;
  }

  // Shutdown, asynchronous and bounded: asks the worker to close its connection
  // (the main one has closed first, so the worker's is the last, and SQLite
  // folds the WAL back there, on the worker's thread), waits at most
  // `deadlineMs`, then terminates it either way. A worker still folding when the
  // process exits leaves the WAL on disk; SQLite recovers it at the next start.
  function stop(deadlineMs = 500) {
    stopping = true;
    clearInterval(periodic); clearTimeout(retryTimer); clearTimeout(restartTimer); clearTimeout(pauseTimer);
    const w = worker, wasReady = ready;
    worker = null; ready = false;
    if (state !== "stopped") state = "off";
    if (!w) { failAll("stopping"); return Promise.resolve({ workerClosed: false, ms: 0 }); }
    const t0 = performance.now();
    return new Promise(resolve => {
      let done = false, t = null;
      const finish = closed => { if (done) return; done = true; clearTimeout(t); w.terminate().catch(() => {}); failAll("stopping"); resolve({ workerClosed: closed, ms: performance.now() - t0 }); };
      if (!wasReady) return finish(false);
      t = setTimeout(() => finish(false), deadlineMs);
      if (t.unref) t.unref();
      w.on("message", msg => { if (msg && msg.id === 0) finish(true); });
      w.on("exit", () => finish(false));
      try { w.postMessage({ id: 0, cmd: "close" }); } catch { finish(false); }
    });
  }

  return {
    start, stop, noteCommit, noteIdle, gate, backup, checkpointNow: checkpoint,
    workerRunning: () => !!worker && ready,
    status: () => ({ state, reason, walPhysicalBytes: physical(), walLogicalBytes: logicalBytes(), paused: pausedAt != null, pending: pending.size, inflight, restartsInRow, failures, ...stats }),
    _fault: payload => request("fault", payload, 5000),
  };
}

module.exports = { createCheckpointer, WORKER_FILE };
