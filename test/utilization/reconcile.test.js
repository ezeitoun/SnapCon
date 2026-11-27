// test/utilization/reconcile.test.js — history records against what SnapCon
// recorded: observed telemetry stays authoritative; history settles provisional
// outcomes, recovers short jobs and fills only Not recorded time, once.
const test = require("node:test");
const assert = require("node:assert/strict");
const { rig, ledgerOf, quiet, tmpBase, T0, S, MIN, H, on, OFF } = require("./helpers");
const { normalizeRecord, linkNext } = require("../../utilization/history");
const { createUtilizationStore } = require("../../utilization/UtilizationStore");
const { dayRange } = require("../../utilization/timeBuckets");
const { BUCKETS } = require("../../utilization/classify");

// A printer history record, times in SnapCon ms.
const raw = (id, startMs, endMs, status = "completed", { file = "a.gcode", printS } = {}) => ({
  job_id: id, filename: file, status, start_time: startMs / 1000, end_time: endMs / 1000,
  print_duration: printS == null ? (endMs - startMs) / 1000 : printS, total_duration: (endMs - startMs) / 1000,
});
function apply(r, raws, { id = "u", skewMs = 0 } = {}) {
  const records = linkNext(raws.map(x => normalizeRecord(x, { nowMs: r.clock.t, skewMs })).filter(x => x.record).map(x => x.record));
  r.writer.enqueue({ type: "history", printerId: id, at: r.clock.t, records, cursorTo: null });
  r.flush();
  return r.store.lastHistory();
}
function watch(r, id, steps) {
  const p = r.P(id);
  r.tracker.beginTick([p], [p], r.clock.t);
  for (const [dt, reading] of steps) { r.clock.t += dt; r.tracker.observe(p, reading, r.clock.t); }
  r.flush();
  return p;
}
const segs = (s, id = "u") => s.segments(id).map(x => [x.kind, x.start, x.end, x.provenance, x.estimated]);
const total = l => BUCKETS.reduce((a, b) => a + l.buckets[b], 0);
const noOverlap = s => { const v = s.segments("u"); for (let i = 1; i < v.length; i++) assert.ok(v[i].start >= v[i - 1].end, `overlap at ${i}`); };

test("a short job between two polls is recovered as a job, and the observed idle time is left alone", t => {
  const r = rig(t);
  watch(r, "u", [[0, on("standby")], [30 * S, on("standby")], [30 * S, on("complete", "cal.gcode")], [30 * S, on("standby")]]);
  const before = segs(r.store);
  const n = apply(r, [raw("A1", T0 + 35 * S, T0 + 52 * S, "completed", { file: "cal.gcode" })]);
  assert.equal(n.short, 1);
  assert.deepEqual(segs(r.store), before, "no interval changed or added");
  const [j] = r.store.jobs("u");
  assert.deepEqual([j.source, j.filename, j.outcome, j.start, j.end, j.outcomeSource], ["backfilled", "cal.gcode", "completed", T0 + 35 * S, T0 + 52 * S, "history"]);
  const l = ledgerOf(r.store, "u", T0, r.clock.t);
  assert.equal(l.buckets.idle, r.clock.t - T0, "its 17 s stay counted once, as observed");
});

for (const [status, outcome] of [["completed", "completed"], ["error", "failed"], ["cancelled", "cancelled"], ["klippy_shutdown", "failed"]]) {
  test(`a job running when SnapCon stopped: history settles it as ${outcome}, and fills only the downtime, marked inferred`, t => {
    let r = rig(t);
    watch(r, "u", [[0, on("standby")], [MIN, on("printing", "a.gcode")], [10 * MIN, on("printing", "a.gcode")]]);
    r.tracker.stop(r.clock.t + S);
    const down = r.clock.t + S;
    r.clock.t += H;
    r = r.restart();
    watch(r, "u", [[S, on("standby")]]);
    const n = apply(r, [raw("B1", T0 + MIN - 10 * S, down + 40 * MIN, status)]);
    assert.equal(n.matched, 1);
    const j = r.store.jobs("u")[0];
    assert.deepEqual([j.outcome, j.end, j.reason, j.outcomeSource], [outcome, down + 40 * MIN, "history:" + status, "history"]);
    const s = r.store.segments("u");
    assert.deepEqual(s.filter(x => x.provenance === "inferred").map(x => [x.kind, x.start, x.end, x.jobId]), [["job", down, down + 40 * MIN, j.id]]);
    noOverlap(r.store);
    const l = ledgerOf(r.store, "u", T0, r.clock.t);
    assert.equal(total(l), l.eligibleMs, "every millisecond once");
    assert.equal(l.buckets.notRecorded, r.clock.t - (down + 40 * MIN), "the rest of the downtime, to the first reading after the restart, stays Not recorded");
  });
}

test("never success from nothing: interrupted leaves a job unknown; an observed unknown becomes completed only on the printer's word", t => {
  let r = rig(t);
  watch(r, "u", [[0, on("printing", "a.gcode")]]);
  r.tracker.stop(r.clock.t + S); r.clock.t += H; r = r.restart();
  watch(r, "u", [[S, on("standby")]]);
  apply(r, [raw("C1", T0 - 5 * S, T0 + 30 * MIN, "interrupted")]);
  assert.equal(r.store.jobs("u")[0].outcome, "unknown");
  const r2 = rig(t);
  watch(r2, "u", [[0, on("printing", "b.gcode")], [MIN, on("standby")]]);      // ended without saying how
  assert.equal(r2.store.jobs("u")[0].outcome, "unknown");
  const r3 = rig(t);
  watch(r3, "u", [[0, on("printing", "b.gcode")], [MIN, on("standby")]]);
  apply(r3, [raw("C3", T0 - 5 * S, T0 + 50 * S, "interrupted", { file: "b.gcode" })]);
  const j3 = r3.store.jobs("u")[0];
  assert.deepEqual([j3.outcome, j3.reason, j3.outcomeSource], ["unknown", "ended-without-outcome", null], "an unknown from history settles nothing");
  apply(r2, [raw("C2", T0 - 5 * S, T0 + 50 * S, "completed", { file: "b.gcode" })]);
  assert.equal(r2.store.jobs("u")[0].outcome, "completed");
  assert.equal(r2.store.jobs("u")[0].end, T0 + MIN, "the observed end is kept");
});

test("observed and history disagree with nothing to say which job is which: UNRESOLVED, neither side preferred (owner, closeout)", t => {
  let r = rig(t);
  watch(r, "u", [[0, on("printing", "a.gcode")], [10 * MIN, on("cancelled", "a.gcode")]]);
  const n = apply(r, [raw("D1", T0 - 5 * S, T0 + 10 * MIN - 5 * S, "completed")]);
  const j = r.store.jobs("u")[0];
  assert.deepEqual([j.outcome, j.outcomeSource, j.historyOutcome], ["unknown", "unresolved", "completed"]);
  assert.match(j.reason, /SnapCon saw cancelled, the printer's history says completed/);
  assert.equal(n.conflicts["outcome-disagrees"], 1);
  assert.equal(r.store.historyState("u").counters.unresolved, 1);
  // Its time is outcome-unknown time: neither Printing nor Failed.
  const l = ledgerOf(r.store, "u", T0, r.clock.t);
  assert.deepEqual([l.buckets.printing, l.buckets.failed, l.buckets.provisionalUnknown], [0, 0, 10 * MIN]);
  // Read again, or after a restart: still unresolved, nothing applied twice.
  assert.equal(apply(r, [raw("D1", T0 - 5 * S, T0 + 10 * MIN - 5 * S, "completed")]).already, 1);
  r.clock.t += MIN; r = r.restart();
  assert.equal(r.store.jobs("u")[0].outcomeSource, "unresolved");
});

test("a delayed page brings the evidence: an unresolved job is resolved by the later record that explains the ending", t => {
  const r = rig(t);
  watch(r, "u", [[0, on("standby")], [30 * S, on("printing", "cube.gcode")], [30 * S, on("cancelled", "cube.gcode")], [30 * S, on("standby")]]);
  apply(r, [raw("000001", T0 + 8 * S, T0 + 31 * S, "completed", { file: "cube.gcode" })]);        // page 1: no next record yet
  assert.equal(r.store.jobs("u")[0].outcomeSource, "unresolved");
  const n = apply(r, [raw("000002", T0 + 55 * S, T0 + 59 * S, "cancelled", { file: "cube.gcode" })]);   // page 2, later
  assert.equal(n.resolvedLater, 1);
  const [a, b] = r.store.jobs("u");
  assert.deepEqual([a.outcome, a.outcomeSource, a.end], ["completed", "history", T0 + 31 * S]);
  assert.deepEqual([b.source, b.outcome], ["backfilled", "cancelled"]);
});

test("the ending SnapCon saw was a later job's (one that ran between two polls): the earlier job takes its own record's outcome", t => {
  // As seen live on a Virtual U1: a 22 s print seen printing once; a second
  // print started and was cancelled before the next poll, which saw "cancelled".
  const r = rig(t);
  watch(r, "u", [[0, on("standby")], [30 * S, on("printing", "cube.gcode")], [30 * S, on("cancelled", "cube.gcode")], [30 * S, on("standby")]]);
  const j0 = r.store.jobs("u")[0];
  assert.equal(j0.outcome, "cancelled", "what the tracker could tell");
  const n = apply(r, [raw("000001", T0 + 8 * S, T0 + 31 * S, "completed", { file: "cube.gcode" }), raw("000002", T0 + 55 * S, T0 + 59 * S, "cancelled", { file: "cube.gcode" })]);
  assert.equal(n.corrected, 1);
  assert.equal(n.short, 1);
  const [a, b] = r.store.jobs("u");
  assert.deepEqual([a.outcome, a.end, a.outcomeSource], ["completed", T0 + 31 * S, "history"]);
  assert.match(a.reason, /later job/);
  assert.deepEqual([b.source, b.outcome], ["backfilled", "cancelled"]);
});

test("three quick prints of one file around the polls (as seen live): each record goes to its own job", t => {
  // Print 1 seen printing once; print 2 started and was cancelled before the
  // next poll (which saw "cancelled"); print 3 seen printing, then complete.
  const r = rig(t);
  watch(r, "u", [[0, on("standby")], [30 * S, on("printing", "cube.gcode")], [30 * S, on("cancelled", "cube.gcode")], [30 * S, on("printing", "cube.gcode")], [30 * S, on("complete", "cube.gcode")], [30 * S, on("standby")]]);
  const n = apply(r, [
    raw("000001", T0 + 11 * S, T0 + 35 * S, "completed", { file: "cube.gcode" }),
    raw("000002", T0 + 56 * S, T0 + 60 * S, "cancelled", { file: "cube.gcode" }),
    raw("000003", T0 + 90 * S, T0 + 112 * S, "completed", { file: "cube.gcode" })]);
  assert.deepEqual([n.matched, n.corrected, n.short], [2, 1, 1]);
  const jobs = r.store.jobs("u");
  const byRecord = id => jobs.find(j => j.historyId && j.historyId.startsWith(id + "@"));
  assert.deepEqual([byRecord("000001").source, byRecord("000001").outcome], ["observed", "completed"]);
  assert.deepEqual([byRecord("000002").source, byRecord("000002").outcome], ["backfilled", "cancelled"]);
  assert.deepEqual([byRecord("000003").source, byRecord("000003").outcome], ["observed", "completed"]);
  assert.ok(jobs.every(j => j.end == null || j.end >= j.start), "no job ends before it starts");
});

test("without that evidence the job is left unresolved, and the disagreement counted", t => {
  const r = rig(t);
  watch(r, "u", [[0, on("standby")], [30 * S, on("printing", "cube.gcode")], [30 * S, on("cancelled", "cube.gcode")], [30 * S, on("standby")]]);
  // A next record that ran well after SnapCon's look is no evidence about that ending.
  watch(r, "u", [[10 * MIN, on("standby")]]);
  const n = apply(r, [raw("000001", T0 + 8 * S, T0 + 31 * S, "completed", { file: "cube.gcode" }), raw("000002", T0 + 5 * MIN, T0 + 6 * MIN, "completed", { file: "cube.gcode" })]);
  assert.equal(n.corrected, 0);
  assert.equal(n.conflicts["outcome-disagrees"], 1);
  assert.deepEqual([r.store.jobs("u")[0].outcome, r.store.jobs("u")[0].outcomeSource], ["unknown", "unresolved"]);
});

test("a job while SnapCon was not running: backfilled into the Not recorded time only, estimated, print_duration's share", t => {
  let r = rig(t);
  watch(r, "u", [[0, on("standby")]]);
  r.tracker.stop(r.clock.t + MIN); const down = r.clock.t + MIN;
  r.clock.t += 3 * H; r = r.restart();
  watch(r, "u", [[S, on("standby")]]);
  const js = down + 30 * MIN, je = js + H;
  const n = apply(r, [raw("E1", js, je, "completed", { printS: 45 * 60 })]);
  assert.equal(n.backfilled, 1);
  const b = r.store.segments("u").filter(x => x.provenance === "backfilled");
  assert.deepEqual(b.map(x => [x.kind, x.start, x.end, x.estimated, x.knownFraction]), [["job", js, je, true, 0.75]]);
  const l = ledgerOf(r.store, "u", T0, r.clock.t);
  assert.equal(l.buckets.printing, 45 * MIN);
  assert.equal(l.estimated.printing, 45 * MIN, "labelled estimated");
  assert.equal(l.buckets.historicalUncertain, 15 * MIN);
  assert.equal(total(l), l.eligibleMs);
  noOverlap(r.store);
});

test("before SnapCon was installed: backfilled, and the first observed interval is untouched", t => {
  const r = rig(t);
  watch(r, "u", [[0, on("standby")]]);
  apply(r, [raw("F1", T0 - 5 * H, T0 - 4 * H, "cancelled", { printS: 1800 })]);
  const s = r.store.segments("u");
  assert.deepEqual(s.map(x => [x.kind, x.provenance, x.start]), [["job", "backfilled", T0 - 5 * H], ["idle", "observed", T0]]);
  const l = ledgerOf(r.store, "u", T0 - 5 * H, r.clock.t + MIN);
  assert.equal(l.buckets.failed, 30 * MIN, "cancelled time is failed time");
});

test("a record that contradicts observed telemetry is skipped and counted: a long job over observed idle, or over another job", t => {
  const r = rig(t);
  watch(r, "u", [[0, on("standby")], [20 * MIN, on("printing", "x.gcode")], [20 * MIN, on("complete", "x.gcode")], [MIN, on("standby")]]);
  const before = segs(r.store);
  const n = apply(r, [raw("G1", T0 + MIN, T0 + 10 * MIN, "completed", { file: "other.gcode" }), raw("G2", T0 + 25 * MIN, T0 + 35 * MIN, "completed", { file: "other.gcode" })]);
  assert.equal(n.conflicts["contradicts-observed"], 1);
  assert.equal(n.conflicts["overlaps-another-job"], 1);
  assert.deepEqual(segs(r.store), before);
  assert.equal(r.store.jobs("u").length, 1, "nothing invented");
});

test("a job while the printer did not answer: recorded as a job; the Offline observation stays", t => {
  const r = rig(t);
  watch(r, "u", [[0, on("standby")], [30 * S, OFF], [30 * S, OFF], [30 * MIN, on("standby")]]);
  const before = segs(r.store);
  const n = apply(r, [raw("H1", T0 + 5 * MIN, T0 + 25 * MIN, "completed")]);
  assert.equal(n.duringOffline, 1);
  assert.deepEqual(segs(r.store), before);
  assert.equal(r.store.jobs("u")[0].outcome, "completed");
});

test("the same records again (another poll, a restart, a replay) change nothing", t => {
  let r = rig(t);
  watch(r, "u", [[0, on("standby")]]);
  r.tracker.stop(r.clock.t + MIN); const down = r.clock.t + MIN;
  r.clock.t += 3 * H; r = r.restart();
  watch(r, "u", [[S, on("standby")]]);
  const recs = [raw("I1", down + 10 * MIN, down + 40 * MIN), raw("I2", down + 50 * MIN, down + 70 * MIN, "error")];
  apply(r, recs);
  const fromHistory = s => segs(s).filter(x => x[3] !== "observed");
  const s1 = fromHistory(r.store), j1 = r.store.jobs("u").length;
  assert.equal(s1.length, 2);
  assert.equal(apply(r, recs).already, 2);
  r.clock.t += MIN;
  r = r.restart();
  assert.equal(apply(r, recs).already, 2);
  assert.deepEqual(fromHistory(r.store), s1);
  assert.equal(r.store.jobs("u").length, j1);
});

test("gaps: one record across two Not recorded stretches fills both, and not the observed time between", t => {
  let r = rig(t);
  watch(r, "u", [[0, on("standby")]]);
  r.tracker.stop(r.clock.t + MIN); const d1 = r.clock.t + MIN;
  r.clock.t += 20 * MIN; r = r.restart();
  watch(r, "u", [[0, on("standby")], [40 * S, on("standby")]]);
  const back = r.clock.t - 40 * S;
  r.tracker.stop(r.clock.t + S); const d2 = r.clock.t + S;
  r.clock.t += 20 * MIN; r = r.restart();
  watch(r, "u", [[0, on("standby")]]);
  const n = apply(r, [raw("J1", d1 + MIN, d2 + 10 * MIN, "completed")]);
  assert.equal(n.backfilled, 1);
  const b = r.store.segments("u").filter(x => x.provenance === "backfilled").map(x => [x.start, x.end]);
  assert.deepEqual(b, [[d1 + MIN, back], [d2, d2 + 10 * MIN]]);
  noOverlap(r.store);
});

test("two history records that overlap each other: the second fills only what is left; nothing counted twice", t => {
  let r = rig(t);
  watch(r, "u", [[0, on("standby")]]);
  r.tracker.stop(r.clock.t + MIN); const d = r.clock.t + MIN;
  r.clock.t += 3 * H; r = r.restart();
  watch(r, "u", [[S, on("standby")]]);
  // A printer cannot run two jobs at once: the second record contradicts the
  // first, so it is skipped and counted, not squeezed into what is left.
  const n = apply(r, [raw("K1", d + 10 * MIN, d + 60 * MIN), raw("K2", d + 50 * MIN, d + 90 * MIN)]);
  assert.equal(n.backfilled, 1);
  assert.equal(n.conflicts["overlaps-another-record"], 1);
  noOverlap(r.store);
  const l = ledgerOf(r.store, "u", T0, r.clock.t);
  assert.equal(total(l), l.eligibleMs);
  assert.equal(l.buckets.printing, 50 * MIN);
});

test("never past the moment the history was queued: the tracker's next step is not overlapped", t => {
  let r = rig(t);
  watch(r, "u", [[0, on("standby")]]);
  r.tracker.stop(r.clock.t + MIN); const d = r.clock.t + MIN;
  r.clock.t += H; r = r.restart();
  const recs = [normalizeRecord(raw("L1", d + 10 * MIN, r.clock.t + 60 * S), { nowMs: r.clock.t }).record];
  const queuedAt = r.clock.t;
  r.writer.enqueue({ type: "history", printerId: "u", at: queuedAt, records: recs, cursorTo: null });
  watch(r, "u", [[S, on("standby")]]);
  noOverlap(r.store);
  assert.ok(r.store.segments("u").filter(x => x.provenance !== "observed").every(x => x.end <= queuedAt), "clipped where it was queued");
  assert.equal(r.writer.status().resyncs, 0, "the tracker's next step was not refused");
  assert.equal(r.writer.status().mode, "ok");
});

test("a reprint of the same file after the downtime (as reproduced): the merged job is ambiguous, for good", t => {
  let r = rig(t);
  watch(r, "u", [[0, on("printing", "a.gcode")]]);
  r.tracker.stop(r.clock.t + S); r.clock.t += H; r = r.restart();
  watch(r, "u", [[S, on("printing", "a.gcode")], [10 * MIN, on("printing", "a.gcode")]]);   // the tracker continues the job by file name
  const n = apply(r, [raw("M1", T0 - 5 * S, T0 + 20 * MIN, "error")]);
  assert.equal(n.conflicts["ambiguous-reprint"], 1);
  let j = r.store.jobs("u")[0];
  assert.deepEqual([j.outcome, j.outcomeSource], ["unknown", "ambiguous"], "two prints under one job: not confirmed either way");
  // The reprint finishes: the tracker's ending cannot confirm the merged job.
  watch(r, "u", [[MIN, on("complete", "a.gcode")], [MIN, on("standby")]]);
  j = r.store.jobs("u")[0];
  assert.deepEqual([j.outcome, j.outcomeSource], ["unknown", "ambiguous"]);
  const l = ledgerOf(r.store, "u", T0, r.clock.t);
  assert.equal(l.buckets.printing, 0, "none of its time counted as success");
  assert.equal(l.buckets.failed, 0, "nor as failure");
});

test("a DST change inside a backfilled job: each local day gets its part, and the parts add up", t => {
  const tz = "America/New_York";
  const r = rig(t);
  // 2026-03-08: 02:00 local does not exist; the day has 23 hours.
  const d8 = dayRange("2026-03-08", tz), d9 = dayRange("2026-03-09", tz);
  assert.equal(d8.end - d8.start, 23 * H);
  r.clock.t = d9.end + H;
  watch(r, "u", [[0, on("standby")]]);
  // 22 elapsed hours into the 8th is 23:00 local (02:00 was skipped): a 3-hour job to 02:00 on the 9th.
  const js = d8.start + 22 * H, je = d9.start + 2 * H;
  assert.equal(je - js, 3 * H);
  apply(r, [raw("N1", js, je, "completed", { printS: 2 * 3600 })]);
  const a = ledgerOf(r.store, "u", d8.start, d8.end), b = ledgerOf(r.store, "u", d9.start, d9.end);
  assert.equal(a.buckets.printing + b.buckets.printing, 2 * H, "print_duration, spread over the span");
  assert.equal(a.buckets.historicalUncertain + b.buckets.historicalUncertain, 1 * H);
  assert.equal(a.estimated.printing + b.estimated.printing, 2 * H, "all of it estimated");
  assert.equal(a.buckets.printing + a.buckets.historicalUncertain, d8.end - js, "the 8th: its last hour");
  assert.equal(total(a) + total(b), (d8.end - d8.start) + (d9.end - d9.start));
});

test("clock skew: learnt from jobs both saw, applied to the rest; a printer far off is refused, not misplaced", t => {
  const { estimateSkew } = require("../../utilization/history");
  let r = rig(t);
  const files = ["p.gcode", "q.gcode", "r.gcode"];
  const lag = [8e3, 15e3, 22e3];
  let at = T0;
  for (let i = 0; i < 3; i++) {
    watch(r, "u", [[MIN, on("printing", files[i])], [5 * MIN, on("complete", files[i])], [MIN, on("standby")]]);
    const obs = r.store.jobs("u")[i].start;
    apply(r, [raw("S" + i, obs - lag[i] - 20e3, obs + 4 * MIN, "completed", { file: files[i] })]);   // printer clock 20 s behind
    at = r.clock.t;
  }
  const skew = estimateSkew(r.store.historyState("u").skewSamples);
  assert.equal(skew, 28e3, "lag plus 20 s");
  assert.equal(r.store.historyState("u").counters.matched, 3);
  // A printer far off: its record lands on time SnapCon watched as idle, and is refused.
  watch(r, "u", [[30 * MIN, on("standby")], [30 * S, on("standby")]]);
  const n = apply(r, [raw("Z1", at + 5 * MIN, at + 25 * MIN, "completed", { file: "z.gcode" })], { skewMs: 0 });
  assert.equal(n.conflicts["contradicts-observed"], 1);
});

test("database recovery: a fresh database after a quarantine is backfilled again from history, once", t => {
  const base = tmpBase(t);
  let r = rig(t, { base });
  watch(r, "u", [[0, on("standby")]]);
  r.store.close();
  require("fs").writeFileSync(require("path").join(base, "utilization-data", "utilization.db"), "damaged");
  r = r.restart();
  assert.ok(r.store.status().recovery);
  watch(r, "u", [[MIN, on("standby")]]);
  const recs = [raw("R1", T0 - 3 * H, T0 - 2 * H)];
  assert.equal(apply(r, recs).backfilled, 1);
  assert.equal(apply(r, recs).already, 1);
});

test("a record for a different file is not matched to the job SnapCon watched", t => {
  const r = rig(t);
  watch(r, "u", [[0, on("printing", "a.gcode")], [10 * MIN, on("complete", "a.gcode")]]);
  const n = apply(r, [raw("W1", T0 - 5 * S, T0 + 10 * MIN - 5 * S, "cancelled", { file: "b.gcode" })]);
  assert.equal(n.matched, 0);
  assert.equal(r.store.jobs("u")[0].historyId, null);
  assert.equal(r.store.jobs("u")[0].outcome, "completed");
});

test("printers never share jobs: the same record on two printers is two jobs, matched only on its own printer", t => {
  const r = rig(t);
  watch(r, "a", [[0, on("printing", "a.gcode")], [10 * MIN, on("complete", "a.gcode")]]);
  watch(r, "b", [[0, on("standby")]]);
  const rec = raw("SAME", T0 - 5 * S, T0 + 10 * MIN - 5 * S, "completed");
  assert.equal(apply(r, [rec], { id: "a" }).matched, 1);
  const nb = apply(r, [rec], { id: "b" });
  assert.equal(nb.matched, 0);
  assert.equal(nb.backfilled, 1, "on b it is b's own (b was not watched yet then)");
  assert.equal(r.store.jobs("a").length, 1);
  assert.equal(r.store.jobs("b").length, 1);
  assert.notEqual(r.store.jobs("a")[0].id, r.store.jobs("b")[0].id);
  assert.equal(r.store.jobs("a")[0].source, "observed");
});

test("repeated same-file prints: the reprint's own record is counted as its own job, and the merged job stays ambiguous", t => {
  let r = rig(t);
  watch(r, "u", [[0, on("printing", "a.gcode")], [MIN, on("printing", "a.gcode")]]);
  r.tracker.stop(r.clock.t + S); const down = r.clock.t + S;
  r.clock.t += H; r = r.restart();
  watch(r, "u", [[S, on("printing", "a.gcode")], [10 * MIN, on("printing", "a.gcode")], [10 * MIN, on("complete", "a.gcode")], [MIN, on("standby")]]);
  const back = down + H + S;
  const n = apply(r, [raw("P1", T0 - 5 * S, down + 10 * MIN, "error"), raw("P2", down + 30 * MIN, back + 20 * MIN, "completed")]);
  assert.equal(n.conflicts["ambiguous-reprint"], 1);
  assert.equal(n.conflicts["ambiguous-merged-job"], 1);
  const jobs = r.store.jobs("u");
  assert.equal(jobs.length, 2, "two prints, two jobs");
  assert.deepEqual([jobs[0].outcome, jobs[0].outcomeSource], ["unknown", "ambiguous"]);
  assert.deepEqual([jobs[1].source, jobs[1].outcome], ["backfilled", "completed"]);
  assert.ok(r.store.segments("u").every(x => x.provenance === "observed"), "nothing filled for the ambiguous job, nothing added for the reprint");
  r.clock.t += MIN; r = r.restart();
  assert.equal(r.store.jobs("u")[0].outcomeSource, "ambiguous", "a restart does not revive it");
});

test("the reprint's record alone (the first one already gone from the printer) still marks the merged job ambiguous", t => {
  let r = rig(t);
  watch(r, "u", [[0, on("printing", "a.gcode")], [MIN, on("printing", "a.gcode")]]);
  r.tracker.stop(r.clock.t + S); const down = r.clock.t + S;
  r.clock.t += H; r = r.restart();
  watch(r, "u", [[S, on("printing", "a.gcode")], [10 * MIN, on("complete", "a.gcode")]]);
  const n = apply(r, [raw("Q2", down + 30 * MIN, down + H + 5 * MIN, "completed")]);
  assert.equal(n.conflicts["ambiguous-merged-job"], 1);
  assert.deepEqual([r.store.jobs("u")[0].outcome, r.store.jobs("u")[0].outcomeSource], ["unknown", "ambiguous"]);
  assert.equal(r.store.jobs("u").length, 2);
});

test("a short job is recovered only between Idle readings; over observed Error it is a conflict; over unobserved, a job without time", t => {
  const r = rig(t);
  watch(r, "u", [[0, on("error")], [30 * S, on("error")], [30 * S, on("standby")]]);
  const before = segs(r.store);
  const n = apply(r, [raw("E1", T0 + 10 * S, T0 + 25 * S, "completed")]);
  assert.equal(n.conflicts["contradicts-observed-error"], 1);
  assert.equal(r.store.jobs("u").length, 0);
  const r2 = rig(t);
  watch(r2, "u", [[0, on("unknown")], [30 * S, on("unknown")], [30 * S, on("standby")]]);
  const n2 = apply(r2, [raw("U1", T0 + 10 * S, T0 + 25 * S, "completed")]);
  assert.equal(n2.duringOffline, 1);
  assert.equal(r2.store.jobs("u").length, 1);
  assert.deepEqual(segs(r.store), before);
});

test("partial coverage: Offline stays Offline, only the Not recorded part is filled, and the job is counted once", t => {
  let r = rig(t);
  watch(r, "u", [[0, on("standby")], [30 * S, OFF], [30 * S, OFF], [20 * MIN, OFF]]);
  r.tracker.stop(r.clock.t + S); const down = r.clock.t + S;
  r.clock.t += H; r = r.restart();
  watch(r, "u", [[S, on("standby")]]);
  const n = apply(r, [raw("O1", T0 + 5 * MIN, down + 30 * MIN, "completed", { printS: 40 * 60 })]);
  assert.equal(n.backfilled, 1);
  assert.equal(n.duringOffline, 1);
  const s = r.store.segments("u");
  assert.ok(s.some(x => x.kind === "offline" && x.start === T0 + 30 * S && x.end === down), "the Offline interval untouched");
  assert.deepEqual(s.filter(x => x.provenance === "backfilled").map(x => [x.start, x.end]), [[down, down + 30 * MIN]]);
  assert.equal(r.store.jobs("u").length, 1);
  const l = ledgerOf(r.store, "u", T0, r.clock.t);
  assert.equal(total(l), l.eligibleMs, "every millisecond once");
});

test("matched downtime: only print_duration less the printing SnapCon saw counts, estimated; never negative, never above the gap", t => {
  for (const [printS, expectKnown] of [[25 * 60, 15 / 30], [5 * 60, 0], [120 * 60, 1], [null, 0]]) {
    let r = rig(t);
    watch(r, "u", [[0, on("printing", "a.gcode")], [10 * MIN, on("printing", "a.gcode")]]);     // 10 min of printing seen
    r.tracker.stop(r.clock.t + S); const down = r.clock.t + S;
    r.clock.t += H; r = r.restart();
    watch(r, "u", [[S, on("standby")]]);
    const rec = raw("M" + printS, T0 - 5 * S, down + 30 * MIN, "completed", { printS: printS == null ? undefined : printS });
    if (printS == null) delete rec.print_duration;
    apply(r, [rec]);
    const filled = r.store.segments("u").filter(x => x.provenance === "inferred");
    assert.equal(filled.length, 1);
    assert.equal(filled[0].estimated, true);
    assert.ok(Math.abs(filled[0].knownFraction - expectKnown) < 0.01, `print ${printS}: share ${filled[0].knownFraction} expected ${expectKnown}`);
    const l = ledgerOf(r.store, "u", T0, r.clock.t);
    assert.ok(Math.abs(l.estimated.printing - expectKnown * 30 * MIN) < 2 * S);
    assert.ok(Math.abs(l.buckets.historicalUncertain - (1 - expectKnown) * 30 * MIN) < 2 * S);
    assert.equal(total(l), l.eligibleMs);
    assert.equal(apply(r, [rec]).already, 1, "not allocated twice");
  }
});

test("delayed page: the merged job's own record arriving after the reprint's does not settle it", t => {
  // SnapCon saw "printing a.gcode" at every poll; the printer ran two prints of
  // it back to back. The reprint's record comes first (a later page was read first).
  const r = rig(t);
  watch(r, "u", [[0, on("printing", "a.gcode")], [5 * MIN, on("printing", "a.gcode")], [5 * MIN, on("complete", "a.gcode")], [MIN, on("standby")]]);
  assert.equal(apply(r, [raw("R2", T0 + 5 * MIN + 10 * S, T0 + 10 * MIN - 5 * S, "completed")]).conflicts["ambiguous-merged-job"], 1);
  apply(r, [raw("R1", T0 - 5 * S, T0 + 5 * MIN, "error")]);
  const host = r.store.jobs("u").find(j => j.source === "observed");
  assert.deepEqual([host.outcome, host.outcomeSource], ["unknown", "ambiguous"]);
  assert.equal(r.store.jobs("u").length, 2);
});
