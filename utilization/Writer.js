// utilization/Writer.js — saves the tracker's steps (Fleet utilization, Phase
// 1.1). The tracker decides in memory and queues; this commits, off the poll.
//
// SQLite is synchronous: deferring it does not make it non-blocking. So the work
// itself is bounded: each turn commits small batches until a time budget is
// spent, then yields and continues on the next turn. The same goes for pruning.
//
// Failures (owner-approved design):
//   transient  BUSY, LOCKED, IOERR, FULL: the batch stays at the head of the
//              queue, under the same id, and is retried after 30 s, 1, 2, 5, 15
//              min, then every 15 min, for at most 24 hours, then recording stops
//              until restart. A commit reported failed may have happened: the
//              batch id makes the retry a no-op then (applied_batches).
//   permanent  CORRUPT, NOTADB, store unavailable, anything SQLite not listed:
//              recording stops, no retries.
//   rule       our own rules refused it (an overlap, a constraint, a programming
//              error): never retried. Everything waiting is dropped, because later
//              steps may build on the refused one; the open intervals are closed at
//              the committed checkpoint and the tracker reloads what the database
//              holds, so the time between is Not recorded.
// Overflow: more than `maxQueue` steps waiting drops them all; the committed
// checkpoint is kept, open intervals are closed there, and the time since reads
// as Not recorded until the next readings. Nothing is guessed.
//
// Gate (Phase 1.2): before each commit or prune pass the writer asks `gate()`
// how long to hold (0 = go). The Checkpointer holds it while a checkpoint
// runs (at most 250 ms, so the WAL can reset) and while recording is paused on
// WAL size. Holding never waits: the turn ends and a timer brings it back.
"use strict";
const { performance } = require("perf_hooks");

const PRUNE_ORDER = ["segments", "jobs", "batches"];
const TRANSIENT = new Set([5, 6, 10, 13]);     // SQLITE_BUSY, LOCKED, IOERR, FULL
function classify(e) {
  if (e && e.rule) return "rule";
  const code = e && Number.isInteger(e.errcode) ? e.errcode & 0xff : null;
  if (code != null) {
    if (TRANSIENT.has(code)) return "transient";
    if (code === 19) return "rule";              // SQLITE_CONSTRAINT: our rules, not the disk
    return "permanent";                          // CORRUPT 11, NOTADB 26, and anything unknown
  }
  if (e && /store unavailable/.test(e.message || "")) return "permanent";
  return "rule";                                 // a programming error: never retried, the queue is dropped
}

function createWriter({ store, log = console, maxQueue = 2000, batchOps = 4, turnBudgetMs = 1.5, retryDelaysMs = [30e3, 60e3, 120e3, 300e3, 900e3], retryForMs = 24 * 3600e3,
  onCommit = () => {}, onIdle = () => {}, gate = () => 0, pruneTurnsPerPoll = 4, schedule = fn => setImmediate(fn), timer = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; }, clock = Date.now, onResync = () => {} }) {
  let queue = [], head = null, scheduled = false, mode = "ok", failingSince = null, attempt = 0, seq = 0;
  const epoch = clock().toString(36);
  let committed = null;                          // the checkpoint known committed
  let prune = null;                              // { cutoff, limit, stage }
  let holdTimer = null;                          // a held turn comes back on this
  let pruneDue = 0;                              // prune turns this poll may still have
  const stats = { batches: 0, replays: 0, droppedOverflow: 0, droppedRule: 0, droppedStopped: 0, resyncs: 0, retries: 0, lastError: null, stoppedBecause: null, prunedSegments: 0, prunedJobs: 0 };

  const say = (level, m) => { try { log[level]("[utilization] " + m); } catch {} };
  function stop(why) { if (mode === "stopped") return; mode = "stopped"; stats.droppedStopped += queue.length + (head ? head.ops.length : 0); queue = []; head = null; prune = null; stats.stoppedBecause = why; say("error", `stopped recording (${why}); printing is not affected. It starts again when SnapCon restarts.`); }

  function resync(why) {
    stats.resyncs++;
    queue = [];
    head = null;
    if (committed != null) queue.push({ type: "closeAll", at: committed });
    say("warn", `resynchronising (${why}); from ${committed == null ? "the start" : new Date(committed).toISOString()} until the next readings is not recorded`);
    onResync();
  }
  function enqueue(op) {
    if (mode === "stopped") { stats.droppedStopped++; return; }
    if (queue.length + (head ? head.ops.length : 0) >= maxQueue) {
      stats.droppedOverflow += queue.length + (head ? head.ops.length : 0);
      resync(`more than ${maxQueue} steps waiting`);
      return;
    }
    queue.push(op);
  }
  function takeBatch() {
    if (!head) {
      if (!queue.length) return null;
      // A history op (up to a few records to reconcile) is a batch of its own,
      // so a batch stays one bounded unit of work.
      let n = 0;
      if (queue[0].type === "history") n = 1;
      else while (n < queue.length && n < batchOps && queue[n].type !== "history") n++;
      head = { id: `${epoch}-${++seq}`, ops: queue.splice(0, n) };
    }
    return head;
  }
  // One batch. true: committed (or already). false: stop this turn.
  function commitOne() {
    const b = takeBatch();
    if (!b) return false;
    try {
      const r = store.applyBatch(b.id, b.ops);
      if (r === "already") stats.replays++;
      for (const op of b.ops) if (op.type === "checkpoint") committed = Math.max(committed ?? op.at, op.at);
      stats.batches++; head = null; attempt = 0; failingSince = null;
      if (r === "applied") { try { onCommit(); } catch {} }
      return true;
    } catch (e) {
      stats.lastError = e.message;
      const kind = classify(e);
      if (kind === "rule") { stats.droppedRule += b.ops.length; head = null; say("error", `a batch was refused and dropped (${e.message})`); resync("a step was refused"); return false; }
      if (kind === "permanent") { stop(e.message); return false; }
      if (failingSince == null) failingSince = clock();
      if (clock() - failingSince >= retryForMs) { stop(`still failing after ${Math.round(retryForMs / 3600e3)} h: ${e.message}`); return false; }
      mode = "retrying"; stats.retries++;
      const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)];
      attempt++;
      say("warn", `could not save (${e.message}); trying again in ${Math.round(delay / 1000)} s`);
      // Due again: the next poll's endTick picks it up, never in the middle of a poll.
      timer(() => { if (mode === "retrying") mode = "ok"; }, delay);
      return false;
    }
  }
  function prunePassBounded() {
    const t0 = performance.now();
    // One table per pass, oldest intervals first: their removal is what frees jobs.
    const r = store.prunePass(prune.cutoff, prune.limit, PRUNE_ORDER[prune.stage]);
    const ms = performance.now() - t0;
    stats.prunedSegments += r.segments; stats.prunedJobs += r.jobs;
    if (!r.segments && !r.jobs && !r.batches) prune.stage++;
    else { try { onCommit(); } catch {} }         // a prune pass grows the WAL like any commit
    // Keep each pass inside the budget with as many rows as fit. A pass's cost
    // grows much slower than its rows (measured: 10 rows 0.26 ms, 100 rows
    // 0.94 ms, 200 rows 1.26 ms), so grow while under 45% of the budget and
    // shrink above 70%: the margin absorbs a pass that meets a WAL reset or
    // pages not in cache.
    if (ms > turnBudgetMs * 0.7) prune.limit = Math.max(10, Math.floor(prune.limit * 0.6));
    else if (ms < turnBudgetMs * 0.45) prune.limit = Math.min(500, Math.ceil(prune.limit * 1.5));
    if (prune.stage >= PRUNE_ORDER.length) prune = null;
  }
  // What a batch and a prune pass have been costing (moving averages): a turn
  // starts another only if it is expected to end within the budget. Each turn
  // does at least one, so the work always moves.
  let batchCost = 0.5, passCost = 1;
  const avg = (old, ms) => old * 0.8 + ms * 0.2;
  // Asks the gate; held: arrange to come back, and say so.
  function held() {
    let ms = 0;
    try { ms = gate() || 0; } catch {}
    if (ms <= 0) return false;
    if (!holdTimer) holdTimer = timer(() => { holdTimer = null; kick(); }, ms);
    return true;
  }
  function turn() {
    scheduled = false;
    if (mode !== "ok") return;
    const t0 = performance.now();
    let did = 0, wasHeld = false, prunedThisTurn = false;
    try {
      for (;;) {
        const spent = performance.now() - t0;
        if ((queue.length || head || prune) && held()) { wasHeld = true; break; }
        if (queue.length || head) {
          if (did && spent + batchCost > turnBudgetMs) break;
          const a = performance.now(); const ok = commitOne(); batchCost = avg(batchCost, performance.now() - a);
          did++; if (!ok) break; continue;
        }
        if (prune && pruneDue > 0) {
          if (did && spent + passCost > turnBudgetMs) break;
          const a = performance.now(); prunePassBounded(); passCost = avg(passCost, performance.now() - a);
          did++; prunedThisTurn = true; continue;
        }
        break;
      }
    } catch (e) {
      // Only pruning gets here. Transient: tried again with tomorrow's prune, so a
      // busy disk never turns into a loop. Anything else: stop.
      stats.lastError = e.message; prune = null;
      if (classify(e) !== "transient") stop(e.message);
    }
    // Steps waiting: another turn now. Pruning only: it goes on at the next
    // poll's endTick, one turn per poll, so the writer is idle between polls
    // and the WAL can be checkpointed (and reset) in that quiet time.
    if (prunedThisTurn) pruneDue--;
    if (wasHeld) return;
    if (mode === "ok" && (queue.length || head)) kick();
    // The poll's steps are saved: pruning gets its own turns now (at most
    // `pruneTurnsPerPoll`, each within the budget, the event loop free between
    // them), even if the budget went on the steps (slow disk), so retention
    // never starves.
    else if (mode === "ok" && prune && pruneDue > 0) kick();
    else if (!queue.length && !head) { try { onIdle(); } catch {} }
  }
  function kick() { if (!scheduled && mode === "ok" && (queue.length || head || (prune && pruneDue > 0))) { scheduled = true; schedule(turn); } }
  // Once per poll (endTick): this poll's saves, then its prune turns.
  function pollTick() { pruneDue = pruneTurnsPerPoll; kick(); }

  // Shutdown: commit what can be committed within the deadline, no waiting,
  // no retries. Whatever is left is not recorded; the checkpoint says up to when.
  function drainSync(deadlineMs = 1500) {
    const t0 = performance.now();
    if (mode === "retrying") mode = "ok";
    while (mode === "ok" && (queue.length || head) && performance.now() - t0 < deadlineMs) if (!commitOne()) break;
    const left = queue.length + (head ? head.ops.length : 0);
    return { left, committedCheckpoint: committed };
  }

  // Shutdown, asynchronous (Phase 1.2): turns as usual (each bounded, the event
  // loop free between them), the gate respected, until nothing is left or
  // `deadline` (a performance.now() time) passes. Resolves with what is left,
  // which is not recorded.
  function drain(deadline) {
    prune = null;
    if (mode === "retrying") mode = "ok";
    return new Promise(resolve => {
      const done = () => resolve({ left: queue.length + (head ? head.ops.length : 0), committedCheckpoint: committed });
      const step = () => {
        if (mode !== "ok" || !(queue.length || head)) return done();
        const remain = deadline - performance.now();
        if (remain <= 0) return done();
        let ms = 0;
        try { ms = gate() || 0; } catch {}
        if (ms > 0) { const t = setTimeout(step, Math.min(ms, remain)); if (t.unref) t.unref(); return; }
        scheduled = true; turn();
        setImmediate(step);
      };
      step();
    });
  }

  return {
    enqueue, kick, pollTick, drainSync, drain,
    halt: why => stop(why),
    schedulePrune: (cutoff, limit = 100) => { if (mode !== "stopped") prune = { cutoff, limit, stage: 0 }; },
    setCommitted: at => { committed = at; },
    pending: () => queue.length + (head ? head.ops.length : 0),
    status: () => ({ mode, pending: queue.length + (head ? head.ops.length : 0), pruning: !!prune, committedCheckpoint: committed, failingSince, ...stats }),
  };
}

module.exports = { createWriter, classify };
