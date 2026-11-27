// test/utilization/writer.test.js — saving the tracker's steps: bounded turns,
// transient failures retried, uncertain commits not duplicated, permanent ones
// stopped, overflow and refused steps resynchronised without making anything up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { classify } = require("../../utilization/Writer");
const { rig, ledgerOf, sqliteError, T0, S, MIN, H, on, OFF } = require("./helpers");

const BUSY = 5, LOCKED = 6, IOERR = 10, FULL = 13, CORRUPT = 11, NOTADB = 26, CONSTRAINT_UNIQUE = 2067, IOERR_WRITE = 778;
const segs = (s, id = "u") => s.segments(id).map(x => [x.kind, x.start, x.end]);
function going(r) { const p = r.P("u"); r.tracker.beginTick([p], [p], r.clock.t); return p; }
// Make the store's next n applyBatch calls fail with `err` (before anything is written).
function failNext(r, n, err) { const was = r.store.applyBatch; let left = n; r.store.applyBatch = (...a) => { if (left-- > 0) throw err; return was(...a); }; return () => { r.store.applyBatch = was; }; }

test("errors are classified: busy, locked, I/O and full are transient; corruption is permanent; our own refusals are never retried", () => {
  for (const c of [BUSY, LOCKED, IOERR, FULL, IOERR_WRITE, 517 /* BUSY_SNAPSHOT */]) assert.equal(classify(sqliteError(c, "x")), "transient", String(c));
  for (const c of [CORRUPT, NOTADB, 14 /* CANTOPEN */, 8 /* READONLY */]) assert.equal(classify(sqliteError(c, "x")), "permanent", String(c));
  assert.equal(classify(sqliteError(CONSTRAINT_UNIQUE, "UNIQUE constraint failed")), "rule");
  assert.equal(classify(Object.assign(new Error("step before"), { rule: true })), "rule");
  assert.equal(classify(new TypeError("x is not a function")), "rule");
  assert.equal(classify(new Error("utilization store unavailable: x")), "permanent");
});

for (const [name, code] of [["busy", BUSY], ["locked", LOCKED], ["I/O error", IOERR], ["disk full", FULL]]) {
  test(`${name}: kept, retried after a delay, saved once; nothing lost or doubled`, t => {
    const r = rig(t);
    const p = going(r);
    r.tracker.observe(p, on("standby"), r.clock.t);
    r.clock.t += MIN; r.tracker.observe(p, on("printing", "a"), r.clock.t);
    const restore = failNext(r, 2, sqliteError(code, name));
    r.flush();
    assert.equal(r.writer.status().mode, "retrying");
    assert.deepEqual(r.fireTimers(), [30e3]);
    r.flush();                                                       // the second failure
    assert.deepEqual(r.fireTimers(), [60e3], "backoff grows");
    r.clock.t += MIN; r.tracker.observe(p, on("complete", "a"), r.clock.t);  // still recording into the queue
    r.flush();
    restore();
    assert.equal(r.writer.status().mode, "ok");
    assert.equal(r.writer.pending(), 0);
    assert.deepEqual(r.store.segments("u").map(x => x.kind), ["idle", "job", "idle"]);
    assert.deepEqual(r.store.jobs("u").map(j => j.outcome), ["completed"]);
  });
}

test("a retry is not started in the middle of a poll: only the next poll's end picks it up", t => {
  const r = rig(t);
  const p = going(r);
  r.tracker.observe(p, on("standby"), r.clock.t);
  const restore = failNext(r, 1, sqliteError(BUSY, "busy"));
  r.flush(); restore();
  r.fireTimers();
  assert.equal(r.turns.length, 0, "the timer only marks it due");
  r.flush();
  assert.equal(r.writer.pending(), 0);
});

test("an uncertain commit (reported failed, but it happened) is not applied twice", t => {
  let once = true;
  const r = rig(t, { storeOpts: { hooks: { afterCommit: (id, ops) => { if (once && ops.some(o => o.type === "step")) { once = false; throw sqliteError(IOERR, "disk I/O error"); } } } } });
  const p = going(r);
  r.tracker.observe(p, on("printing", "a"), r.clock.t);
  r.clock.t += MIN; r.tracker.observe(p, on("paused", "a"), r.clock.t);
  r.flush();
  assert.equal(r.writer.status().mode, "retrying");
  r.fireTimers(); r.flush();
  assert.equal(r.writer.status().replays, 1);
  assert.deepEqual(segs(r.store), [["job", T0, T0 + MIN], ["paused", T0 + MIN, null]]);
  assert.equal(r.store.jobs("u").length, 1);
});

test("a commit that failed and did not happen is rolled back and applied on retry", t => {
  let once = true;
  const r = rig(t, { storeOpts: { hooks: { beforeCommit: (id, ops) => { if (once && ops.some(o => o.type === "step")) { once = false; throw sqliteError(IOERR, "disk I/O error"); } } } } });
  const p = going(r);
  r.tracker.observe(p, on("printing", "a"), r.clock.t);
  r.flush();
  assert.equal(r.store.segments("u").length, 0);
  r.fireTimers(); r.flush();
  assert.equal(r.writer.status().replays, 0);
  assert.equal(r.store.segments("u").length, 1);
});

test("permanent: corruption stops the recording at once, no retries, logged once; the poll is untouched", t => {
  const errors = [];
  const r = rig(t, { log: { log() {}, warn() {}, error: m => errors.push(m) } });
  const p = going(r);
  r.tracker.observe(p, on("standby"), r.clock.t);
  failNext(r, 1e9, sqliteError(CORRUPT, "database disk image is malformed"));
  r.flush();
  assert.equal(r.writer.status().mode, "stopped");
  assert.equal(r.timers.length, 0, "no retry");
  for (let i = 0; i < 20; i++) { r.clock.t += MIN; assert.doesNotThrow(() => { r.tracker.beginTick([p], [p], r.clock.t); r.tracker.observe(p, on(i % 2 ? "printing" : "standby", "a"), r.clock.t); }); r.flush(); }
  assert.equal(r.writer.pending(), 0, "nothing piles up once stopped");
  assert.equal(errors.filter(m => /stopped recording/.test(m)).length, 1);
});

test("retries are bounded: still failing after 24 hours, recording stops", t => {
  const r = rig(t);
  const p = going(r);
  r.tracker.observe(p, on("standby"), r.clock.t);
  failNext(r, 1e9, sqliteError(IOERR, "disk I/O error"));
  const delays = [];
  for (let i = 0; i < 200 && r.writer.status().mode !== "stopped"; i++) {
    r.flush();
    const d = r.fireTimers();
    delays.push(...d);
    r.clock.t += d[0] || 0;
  }
  assert.equal(r.writer.status().mode, "stopped");
  assert.match(r.writer.status().stoppedBecause, /24 h/);
  assert.deepEqual(delays.slice(0, 6), [30e3, 60e3, 120e3, 300e3, 900e3, 900e3]);
  assert.ok(delays.length < 110, `${delays.length} attempts`);
});

test("a refused step drops what was waiting, closes at the committed checkpoint, reloads, and records on", t => {
  const r = rig(t);
  const p = going(r);
  r.tracker.observe(p, on("printing", "a"), r.clock.t); r.flush();
  r.clock.t += 30 * S; r.tracker.beginTick([p], [p], r.clock.t); r.flush();
  const cp = r.clock.t;
  r.clock.t += 10 * S; r.tracker.observe(p, on("paused", "a"), r.clock.t);
  failNext(r, 1, Object.assign(new Error("a programming error"), {}));
  r.flush();
  assert.equal(r.writer.status().resyncs, 1);
  assert.equal(r.writer.status().mode, "ok", "a refused step is not a reason to stop");
  r.clock.t += MIN; r.tracker.beginTick([p], [p], r.clock.t);
  r.tracker.observe(p, on("printing", "a"), r.clock.t);
  r.clock.t += MIN; r.tracker.observe(p, on("complete", "a"), r.clock.t);
  r.flush();
  const s = r.store.segments("u");
  assert.deepEqual(s.map(x => [x.kind, x.start, x.end]), [["job", T0, cp], ["job", cp + 70 * S, cp + 130 * S], ["idle", cp + 130 * S, null]]);
  assert.equal(s[0].jobId, s[1].jobId, "the same job, reloaded from the database");
  assert.deepEqual(r.store.jobs("u").map(j => j.outcome), ["completed"]);
  assert.equal(ledgerOf(r.store, "u", T0, r.clock.t).buckets.notRecorded, 70 * S);
});

test("a step the database refuses (a constraint) is never retried", t => {
  const r = rig(t);
  const p = going(r);
  r.tracker.observe(p, on("standby"), r.clock.t);
  failNext(r, 1, sqliteError(CONSTRAINT_UNIQUE, "UNIQUE constraint failed: segments.printer_id, segments.start_at"));
  r.flush();
  assert.equal(r.timers.length, 0);
  assert.equal(r.writer.status().droppedRule > 0, true);
});

test("overflow: the queue stays bounded, the committed checkpoint is kept, the missing time is Not recorded, and recording resumes", t => {
  const r = rig(t, { writerOpts: { maxQueue: 50 } });
  const p = going(r);
  r.tracker.observe(p, on("printing", "a"), r.clock.t);
  r.clock.t += 30 * S; r.tracker.beginTick([p], [p], r.clock.t); r.flush();
  const cp = r.clock.t;
  const restore = failNext(r, 1e9, sqliteError(BUSY, "database is locked"));
  let maxPending = 0, lastResyncAt = null, resyncs = 0;
  for (let i = 0; i < 300; i++) {
    r.clock.t += 10 * S;
    if (i % 3 === 0) r.tracker.beginTick([p], [p], r.clock.t);
    r.tracker.observe(p, on(i % 2 ? "printing" : "paused", "a"), r.clock.t);
    maxPending = Math.max(maxPending, r.writer.pending());
    if (r.writer.status().resyncs !== resyncs) { resyncs = r.writer.status().resyncs; lastResyncAt = r.clock.t; }
    r.flush(); r.fireTimers();
  }
  assert.ok(maxPending <= 50, `pending reached ${maxPending}`);
  assert.ok(r.writer.status().droppedOverflow > 0);
  assert.equal(Number(r.store.getMeta("heartbeat")), cp, "only committed checkpoints count");
  restore();
  r.clock.t += 10 * S; r.tracker.beginTick([p], [p], r.clock.t);
  const back = r.clock.t;
  r.tracker.observe(p, on("printing", "a"), r.clock.t);
  r.flush(); r.fireTimers(); r.flush();
  const s = r.store.segments("u");
  for (let i = 1; i < s.length; i++) assert.ok(s[i].start >= s[i - 1].end, "no overlap");
  assert.deepEqual(s[0].end, cp, "the open interval ends at the last committed checkpoint");
  // After cp, only readings taken after the last overflow (they were queued, then saved).
  assert.ok(s.every(x => x.start <= cp || x.start > lastResyncAt), "nothing from before the overflow is kept or made up");
  assert.ok(back > lastResyncAt);
  assert.ok(ledgerOf(r.store, "u", T0, r.clock.t + 1).buckets.notRecorded > 0);
});

test("each turn stops at its time budget and yields; the rest continues on later turns", t => {
  const r = rig(t, { writerOpts: { turnBudgetMs: 2, batchOps: 1 } });
  const ids = Array.from({ length: 30 }, (_, i) => "p" + i);
  const ps = ids.map(id => r.P(id));
  r.tracker.beginTick(ps, ps, r.clock.t);
  for (let k = 0; k < 20; k++) { r.clock.t += S; for (const p of ps) r.tracker.observe(p, on(k % 2 ? "printing" : "standby", "f" + k), r.clock.t); }
  const was = r.store.applyBatch;
  let calls = 0;
  r.store.applyBatch = (...a) => { calls++; const end = performance.now() + 0.5; while (performance.now() < end); return was(...a); };
  r.writer.kick();
  let turns = 0;
  while (r.turns.length) {
    calls = 0; r.turns.shift()(); turns++;
    // 0.5 ms a batch, 2 ms budget: the budget is checked before each batch, so at
    // most ceil(2 / 0.5) + 1. Counted, not timed, so a slow machine cannot flake it.
    assert.ok(calls <= 5, `a turn committed ${calls} batches`);
  }
  assert.ok(turns > 10, `${turns} turns`);
  assert.equal(r.writer.pending(), 0);
});

test("prune runs in budgeted turns after the poll, and never removes what is open or running", t => {
  const r = rig(t);
  const p = going(r);
  for (let i = 0; i < 400; i++) { r.clock.t += MIN; r.tracker.observe(p, on(i % 2 ? "printing" : "standby", "a"), r.clock.t); }
  r.flush();
  r.writer.schedulePrune(r.clock.t - 10 * MIN);
  assert.equal(r.turns.length, 0, "scheduling does not run it");
  // One turn per poll: each endTick (kick) runs one.
  let turns = 0; while (r.writer.status().pruning) { r.writer.pollTick(); let n = 0; while (r.turns.length) { r.turns.shift()(); n++; } assert.ok(n <= 4, `${n} prune turns in one poll`); if (++turns > 1000) break; }
  const s = r.store.segments("u");
  assert.equal(s.length, 12, "the 11 ending at or after the cutoff, and the open one");
  assert.ok(s.some(x => x.end == null));
  assert.ok(r.store.jobs("u").some(j => j.outcome === "running"));
  assert.equal(r.writer.status().prunedSegments, 388);
});

test("a transient failure while pruning ends today's prune instead of looping", t => {
  const r = rig(t);
  going(r);
  r.store.prunePass = () => { throw sqliteError(BUSY, "busy"); };
  r.writer.schedulePrune(r.clock.t);
  r.writer.pollTick();
  while (r.turns.length) r.turns.shift()();
  assert.equal(r.writer.status().mode, "ok");
  assert.equal(r.writer.status().pruning, false, "today's prune ended, not retried");
});

test("a reload that finds the database busy waits for the next poll; readings are ignored until then, and nothing stops", t => {
  const r = rig(t);
  const p = going(r);
  r.tracker.observe(p, on("printing", "a"), r.clock.t); r.flush();
  r.tracker.resync();
  const was = r.store.loadState; let fails = 1;
  r.store.loadState = (...a) => { if (fails-- > 0) throw sqliteError(BUSY, "database is locked"); return was(...a); };
  r.clock.t += 30 * S;
  assert.doesNotThrow(() => r.tracker.beginTick([p], [p], r.clock.t));
  r.tracker.observe(p, on("paused", "a"), r.clock.t);
  assert.equal(r.writer.pending(), 0, "nothing queued on memory that may be wrong");
  r.clock.t += 30 * S;
  r.tracker.beginTick([p], [p], r.clock.t);
  r.tracker.observe(p, on("paused", "a"), r.clock.t);
  r.flush();
  const s = r.store.segments("u");
  assert.equal(s[s.length - 1].kind, "paused");
  assert.equal(s[s.length - 1].jobId, s[0].jobId, "the running job, reloaded");
});

test("prune turns stop at their time budget too", t => {
  const r = rig(t, { writerOpts: { turnBudgetMs: 2 } });
  going(r);
  const was = r.store.prunePass; let calls = 0, left = 60;
  r.store.prunePass = (...a) => { calls++; const end = performance.now() + 0.5; while (performance.now() < end); return left-- > 0 ? { segments: 1, jobs: 0, batches: 0 } : was(...a); };
  r.writer.schedulePrune(r.clock.t);
  let turns = 0;
  while (r.writer.status().pruning && turns < 1000) { r.writer.pollTick(); while (r.turns.length) { calls = 0; r.turns.shift()(); turns++; assert.ok(calls <= 5, `a turn ran ${calls} passes`); } }
  assert.ok(turns > 10, `${turns} turns`);
  assert.equal(r.writer.status().pruning, false);
});

test("the writer says when it has gone idle (when checkpoints may run), and after each commit", t => {
  let idle = 0, commits = 0;
  const r = rig(t, { writerOpts: { onIdle: () => idle++, onCommit: () => commits++, batchOps: 1, turnBudgetMs: 0 } });
  const p = going(r);
  for (let i = 0; i < 5; i++) { r.clock.t += MIN; r.tracker.observe(p, on(i % 2 ? "printing" : "standby", "a"), r.clock.t); }
  r.writer.kick();
  let turns = 0;
  while (r.turns.length) { assert.equal(idle, 0, "not idle while steps wait"); r.turns.shift()(); turns++; }
  assert.ok(turns > 1);
  assert.equal(idle, 1);
  assert.ok(commits >= 5);
});

test("pruning never runs turn after turn: a bounded number per poll, idle in between, and each pass counts toward the WAL", t => {
  let idle = 0, commits = 0;
  const r = rig(t, { writerOpts: { onIdle: () => idle++, onCommit: () => commits++, pruneTurnsPerPoll: 1 } });
  const p = going(r);
  for (let i = 0; i < 300; i++) { r.clock.t += MIN; r.tracker.observe(p, on(i % 2 ? "printing" : "standby", "a"), r.clock.t); }
  r.flush();
  const c0 = commits, i0 = idle;
  r.writer.schedulePrune(r.clock.t);
  r.writer.kick();
  assert.equal(r.turns.length, 0, "a kick that is not a poll does not prune");
  r.writer.pollTick();
  r.turns.shift()();
  assert.equal(r.turns.length, 0, "no second turn scheduled by pruning alone");
  assert.equal(idle, i0 + 1, "idle after the prune turn, so a checkpoint can run");
  assert.ok(commits > c0, "prune passes count as commits");
});

test("a slow disk does not starve pruning: each poll still gets one prune turn after its saves", t => {
  const r = rig(t, { writerOpts: { turnBudgetMs: 1, batchOps: 1 } });
  const ps = Array.from({ length: 10 }, (_, i) => r.P("p" + i));
  r.tracker.beginTick(ps, ps, r.clock.t);
  for (let k = 0; k < 30; k++) { r.clock.t += MIN; for (const p of ps) r.tracker.observe(p, on(k % 2 ? "printing" : "standby", "a"), r.clock.t); }
  r.flush();
  const was = r.store.applyBatch;
  r.store.applyBatch = (...a) => { const end = performance.now() + 2; while (performance.now() < end); return was(...a); };   // every batch over budget
  r.writer.schedulePrune(r.clock.t - 5 * MIN);
  for (let poll = 0; poll < 40 && r.writer.status().pruning; poll++) {
    r.clock.t += 30e3;
    r.tracker.beginTick(ps, ps, r.clock.t);
    for (const p of ps) r.tracker.observe(p, on(poll % 2 ? "printing" : "standby", "b"), r.clock.t);
    r.writer.pollTick();
    while (r.turns.length) r.turns.shift()();
  }
  assert.equal(r.writer.status().pruning, false, "pruning finished");
  assert.ok(r.writer.status().prunedSegments > 0);
});

test("at most four prune turns per poll, however much is left", t => {
  const r = rig(t);
  going(r);
  let passes = 0;
  r.store.prunePass = () => { passes++; const end = performance.now() + 1; while (performance.now() < end); return { segments: 1, jobs: 0, batches: 0 }; };   // never done
  r.writer.schedulePrune(r.clock.t);
  r.writer.pollTick();
  let turns = 0;
  while (r.turns.length) { r.turns.shift()(); turns++; }
  assert.equal(turns, 4);
  assert.equal(r.writer.status().pruning, true, "the rest waits for the next poll");
  r.writer.pollTick();
  while (r.turns.length) { r.turns.shift()(); turns++; }
  assert.equal(turns, 8);
});
