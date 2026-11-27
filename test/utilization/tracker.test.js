// test/utilization/tracker.test.js — readings in, intervals out: what the
// tracker records, and what it refuses to make up. Steps reach the database
// through the real writer; `flush` runs its turns as the event loop would.
const test = require("node:test");
const assert = require("node:assert/strict");
const { rig, build, ledgerOf, quiet, tmpBase, T0, S, MIN, H, on, OFF } = require("./helpers");
const { createUtilizationStore } = require("../../utilization/UtilizationStore");
const { createTracker } = require("../../utilization/Tracker");
const { createWriter } = require("../../utilization/Writer");

const segs = (s, id = "u") => s.segments(id).map(x => [x.kind, x.start, x.end, x.reason || undefined].filter(v => v !== undefined));
function feed(r, id, steps) {
  const p = r.P(id);
  r.tracker.beginTick([p], [p], r.clock.t);
  for (const [dt, reading] of steps) { r.clock.t += dt; r.tracker.observe(p, reading, r.clock.t); }
  r.flush();
  return p;
}

test("observing reads and writes nothing during the poll: steps wait for the writer", t => {
  const r = rig(t);
  const p = r.P("u");
  r.tracker.beginTick([p], [p], r.clock.t);
  const was = r.store.applyBatch;
  r.store.applyBatch = () => { throw new Error("written during the poll"); };
  r.store.loadState = () => { throw new Error("read during the poll"); };
  for (const st of ["standby", "printing", "paused", "printing", "complete"]) { r.clock.t += MIN; r.tracker.observe(p, on(st, "a"), r.clock.t); }
  assert.ok(r.writer.pending() > 0);
  r.store.applyBatch = was;
  r.flush();
  assert.equal(r.writer.pending(), 0);
  assert.deepEqual(r.store.segments("u").map(x => x.kind), ["idle", "job", "paused", "job", "idle"]);
});

test("the same reading again queues nothing", t => {
  const r = rig(t);
  const p = feed(r, "u", [[0, on("standby")]]);
  const before = r.writer.pending();
  for (let i = 0; i < 5; i++) { r.clock.t += 30 * S; r.tracker.observe(p, on("standby"), r.clock.t); }
  assert.equal(r.writer.pending(), before);
  r.flush();
  assert.deepEqual(segs(r.store), [["idle", T0, null]]);
});

test("a printed job: idle, job, idle; outcome from the printer", t => {
  const r = rig(t);
  feed(r, "u", [[0, on("standby")], [MIN, on("printing", "a.gcode")], [H, on("complete", "a.gcode")], [MIN, on("standby")]]);
  assert.deepEqual(segs(r.store).map(s => s[0]), ["idle", "job", "idle"]);
  const [j] = r.store.jobs("u");
  assert.deepEqual([j.filename, j.outcome, j.reason, j.start, j.end], ["a.gcode", "completed", "printer-reported", T0 + MIN, T0 + MIN + H]);
});

test("cancelled, error and shutdown end a job as such; standby with no ending is unknown, not success", t => {
  for (const [state, outcome] of [["cancelled", "cancelled"], ["error", "failed"], ["shutdown", "failed"], ["standby", "unknown"], ["idle", "unknown"], ["busy", "unknown"]]) {
    const r = rig(t);
    feed(r, "u", [[0, on("printing", "a")], [MIN, on(state, "a")]]);
    assert.equal(r.store.jobs("u")[0].outcome, outcome, state);
  }
});

test("a pause stays inside its job; the job's outcome does not swallow it", t => {
  const r = rig(t);
  feed(r, "u", [[0, on("printing", "a")], [10 * MIN, on("paused", "a")], [5 * MIN, on("printing", "a")], [10 * MIN, on("cancelled", "a")]]);
  const s = r.store.segments("u");
  assert.deepEqual(s.map(x => x.kind), ["job", "paused", "job", "idle"]);
  assert.equal(new Set(s.slice(0, 3).map(x => x.jobId)).size, 1, "one job");
  assert.equal(r.store.jobs("u").length, 1);
  const l = ledgerOf(r.store, "u", T0, r.clock.t);
  assert.equal(l.buckets.failed, 20 * MIN);
  assert.equal(l.buckets.paused, 5 * MIN);
});

test("a different file while printing is a new job; the old one ends unknown", t => {
  const r = rig(t);
  feed(r, "u", [[0, on("printing", "a")], [MIN, on("printing", "b")]]);
  const j = r.store.jobs("u");
  assert.deepEqual(j.map(x => [x.filename, x.outcome]), [["a", "unknown"], ["b", "running"]]);
  assert.equal(j[0].reason, "another-job");
});

test("printing again after idle is a new job, even with the same file", t => {
  const r = rig(t);
  feed(r, "u", [[0, on("printing", "a")], [MIN, on("complete", "a")], [MIN, on("printing", "a")]]);
  assert.deepEqual(r.store.jobs("u").map(x => x.outcome), ["completed", "running"]);
});

test("one lost reply is not an outage", t => {
  const r = rig(t);
  feed(r, "u", [[0, on("printing", "a")], [30 * S, OFF], [30 * S, on("printing", "a")]]);
  assert.deepEqual(segs(r.store).map(s => s[0]), ["job"]);
});

test("two unanswered readings are Offline, dated from the first", t => {
  const r = rig(t);
  feed(r, "u", [[0, on("standby")], [30 * S, OFF], [30 * S, OFF], [30 * S, OFF], [30 * S, on("standby")]]);
  assert.deepEqual(segs(r.store), [["idle", T0, T0 + 30 * S], ["offline", T0 + 30 * S, T0 + 120 * S, "unreachable"], ["idle", T0 + 120 * S, null]]);
});

test("a job through an outage: the outage is Offline, never printing; the same file after it is the same job", t => {
  const r = rig(t);
  feed(r, "u", [[0, on("printing", "a")], [30 * S, OFF], [30 * S, OFF], [10 * MIN, on("printing", "a")]]);
  const s = r.store.segments("u");
  assert.deepEqual(s.map(x => x.kind), ["job", "offline", "job"]);
  assert.equal(s[1].jobId, null, "the outage is not job time");
  assert.equal(s[0].jobId, s[2].jobId);
});

test("online but unreadable is unobserved, at once, never Offline or Idle", t => {
  const r = rig(t);
  feed(r, "u", [[0, on("standby")], [30 * S, on("unknown")], [30 * S, on("standby")]]);
  assert.deepEqual(segs(r.store).map(s => [s[0], s[3]]), [["idle", undefined], ["unobserved", "state-unrecognized"], ["idle", undefined]]);
});

test("readings older than the last one counted are ignored; two at the same instant write once", t => {
  const r = rig(t);
  const p = feed(r, "u", [[0, on("standby")], [MIN, on("printing", "a")]]);
  r.tracker.observe(p, on("standby"), r.clock.t - 30 * S);
  r.tracker.observe(p, on("printing", "a"), r.clock.t);
  r.tracker.observe(p, on("printing", "a"), r.clock.t);
  r.flush();
  assert.deepEqual(segs(r.store).map(s => s[0]), ["idle", "job"]);
  assert.equal(r.writer.status().mode, "ok", "an out-of-order reading must not stop the recording");
  r.clock.t += MIN;
  r.tracker.observe(p, on("complete", "a"), r.clock.t);
  r.flush();
  assert.deepEqual(segs(r.store).map(s => s[0]), ["idle", "job", "idle"], "and later readings still count");
});

test("printers observed in any order keep their own histories, saved in the order they happened", t => {
  const r = rig(t);
  const a = r.P("a"), b = r.P("b");
  r.tracker.beginTick([a, b], [a, b], r.clock.t);
  const plan = [[a, on("standby")], [b, on("printing", "x")], [b, on("printing", "x")], [a, on("printing", "y")], [b, on("complete", "x")], [a, on("paused", "y")]];
  for (const [p, rd] of plan) { r.clock.t += 7 * S; r.tracker.observe(p, rd, r.clock.t); }
  r.flush();
  assert.deepEqual(r.store.segments("a").map(x => x.kind), ["idle", "job", "paused"]);
  assert.deepEqual(r.store.segments("b").map(x => x.kind), ["job", "idle"]);
  assert.deepEqual(r.store.jobs("b").map(j => j.outcome), ["completed"]);
});

test("restart: open intervals end at the last committed checkpoint; the downtime has no interval and is Not recorded", t => {
  const r = rig(t);
  feed(r, "u", [[0, on("standby")], [MIN, on("printing", "a")]]);
  r.tracker.beginTick([r.P("u")], [r.P("u")], r.clock.t + 20 * S);   // checkpoint
  r.flush();
  const alive = r.clock.t + 20 * S;
  r.clock.t = alive + H;            // SnapCon was down for an hour, killed without a clean stop
  const n = r.restart();
  r.clock.t += 30 * S;
  n.tracker.beginTick([r.P("u")], [r.P("u")], r.clock.t);
  n.tracker.observe(r.P("u"), on("printing", "a"), r.clock.t);
  n.flush();
  const s = n.store.segments("u");
  assert.deepEqual(s.map(x => [x.kind, x.start, x.end]), [["idle", T0, T0 + MIN], ["job", T0 + MIN, alive], ["job", r.clock.t, null]]);
  assert.equal(s[1].jobId, s[2].jobId, "the same job continues");
  assert.ok(!s.some(x => x.kind === "offline"), "SnapCon being down is never Offline");
  const l = ledgerOf(n.store, "u", T0, r.clock.t + MIN);
  assert.equal(l.buckets.notRecorded, r.clock.t - alive);
  assert.equal(l.buckets.offline, 0);
});

test("forced stop: steps queued but not committed are not recorded, and nothing is made up for them", t => {
  const r = rig(t);
  const p = feed(r, "u", [[0, on("standby")]]);
  r.clock.t += 30 * S; r.tracker.beginTick([p], [p], r.clock.t); r.flush();   // checkpoint committed
  const cp = r.clock.t;
  r.clock.t += 10 * S; r.tracker.observe(p, on("printing", "a"), r.clock.t);   // queued, never committed
  assert.ok(r.writer.pending() > 0);
  r.clock.t += H;
  const n = r.restart();
  assert.deepEqual(segs(n.store), [["idle", T0, cp]]);
  assert.equal(n.store.jobs("u").length, 0);
});

test("restart: a job found already finished ends with its outcome and NO made-up end time", t => {
  const r = rig(t);
  feed(r, "u", [[0, on("printing", "a")]]);
  r.tracker.stop(r.clock.t + S);
  r.clock.t += H;
  const n = r.restart();
  n.tracker.observe(r.P("u"), on("complete", "a"), r.clock.t + S);
  n.flush();
  const [j] = n.store.jobs("u");
  assert.deepEqual([j.outcome, j.end], ["completed", null]);
});

test("restart: a different file after the downtime ends the old job unknown, with no end time", t => {
  const r = rig(t);
  feed(r, "u", [[0, on("printing", "a")]]);
  r.tracker.stop(r.clock.t + S);
  r.clock.t += H;
  const n = r.restart();
  n.tracker.observe(r.P("u"), on("printing", "b"), r.clock.t + S);
  n.flush();
  assert.deepEqual(n.store.jobs("u").map(j => [j.filename, j.outcome, j.end]), [["a", "unknown", null], ["b", "running", null]]);
});

test("a clean stop commits what is queued and closes every interval; the job stays running", t => {
  const r = rig(t);
  const p = r.P("u");
  r.tracker.beginTick([p], [p], r.clock.t);
  r.tracker.observe(p, on("printing", "a"), r.clock.t);    // not flushed: stop must save it
  const left = r.tracker.stop(r.clock.t + 5 * S);
  assert.equal(left.left, 0);
  assert.deepEqual(segs(r.store), [["job", T0, T0 + 5 * S]]);
  assert.equal(r.store.jobs("u")[0].outcome, "running");
  assert.equal(Number(r.store.getMeta("heartbeat")), T0 + 5 * S);
});

test("a clean stop never waits past its deadline; what is left is not recorded", t => {
  const r = rig(t);
  const p = r.P("u");
  r.tracker.beginTick([p], [p], r.clock.t);
  for (let i = 0; i < 200; i++) { r.clock.t += S; r.tracker.observe(p, on(i % 2 ? "printing" : "standby", "a"), r.clock.t); }
  const was = r.store.applyBatch;
  r.store.applyBatch = (...a) => { const end = Date.now() + 20; while (Date.now() < end); return was(...a); };
  const t0 = Date.now();
  const res = r.tracker.stop(r.clock.t, 50);
  assert.ok(Date.now() - t0 < 50 + 25 + 30, `took ${Date.now() - t0} ms`);
  assert.ok(res.left > 0);
  assert.equal(Number(r.store.getMeta("heartbeat")), res.committedCheckpoint, "the checkpoint stays where the committed data is");
});

test("renamed or moved to another address: the same printer, the same history", t => {
  const r = rig(t);
  const p = feed(r, "u", [[0, on("standby")]]);
  const moved = { ...p, name: "U1 Red (bench 4)", url: "http://192.0.2.250" };
  r.clock.t += MIN;
  r.tracker.beginTick([moved], [moved], r.clock.t);
  r.tracker.observe(moved, on("standby"), r.clock.t);
  r.flush();
  assert.deepEqual(r.store.printers().map(x => [x.id, x.name]), [["u", "U1 Red (bench 4)"]]);
  assert.equal(r.store.segments("u").length, 1);
});

test("removed: its interval ends, its job ends unknown, its history stays; back again, it is the same printer", t => {
  const r = rig(t);
  const p = feed(r, "u", [[0, on("printing", "a")]]);
  r.clock.t += MIN;
  r.tracker.beginTick([], [], r.clock.t);
  r.flush();
  const [row] = r.store.printers();
  assert.equal(row.removedAt, r.clock.t);
  assert.deepEqual(segs(r.store), [["job", T0, r.clock.t]]);
  assert.deepEqual(r.store.jobs("u").map(j => [j.outcome, j.reason]), [["unknown", "removed"]]);
  r.clock.t += H;
  r.tracker.beginTick([p], [p], r.clock.t);
  r.tracker.observe(p, on("standby"), r.clock.t);
  r.flush();
  assert.equal(r.store.printers()[0].removedAt, null);
  assert.deepEqual(r.store.segments("u").map(x => x.kind), ["job", "idle"], "the gap between has no interval");
});

test("a virtual printer is recorded as virtual; hidden, it stops being watched but is not removed", t => {
  const r = rig(t);
  const v = { id: "v", name: "VU1 #1", connector: "virtual-u1" };
  const isVirtual = c => c === "virtual-u1";
  r.tracker.beginTick([v], [v], r.clock.t, { isVirtual });
  r.tracker.observe(v, on("standby"), r.clock.t);
  r.clock.t += MIN;
  r.tracker.beginTick([v], [], r.clock.t, { isVirtual });
  r.flush();
  assert.equal(r.store.printers()[0].isVirtual, 1);
  assert.equal(r.store.printers()[0].removedAt, null);
  assert.deepEqual(segs(r.store, "v"), [["idle", T0, r.clock.t]]);
});

test("an unavailable store records nothing and throws nothing", t => {
  const store = createUtilizationStore({ baseDir: tmpBase(t), log: quiet, sqlite: null }).open();
  const writer = createWriter({ store, log: quiet, schedule: () => {}, timer: () => {} });
  const tracker = createTracker({ store, writer, log: quiet });
  assert.doesNotThrow(() => { tracker.start(1); tracker.beginTick([{ id: "u" }], [{ id: "u" }], 2); tracker.observe({ id: "u" }, on("printing", "a"), 3); tracker.stop(4); });
  assert.equal(writer.pending(), 0);
});

test("a long random run, with restarts, forced stops and partial flushes: never overlapping, never duplicated", t => {
  let r = rig(t);
  let x = 7;
  const rnd = n => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % n; };
  const readings = [on("standby"), on("printing", "a"), on("printing", "b"), on("paused", "a"), on("complete", "a"), on("cancelled", "b"), on("error"), on("unknown"), OFF, OFF, OFF];
  const p = r.P("u");
  for (let i = 0; i < 3000; i++) {
    if (rnd(4) === 0) r.tracker.beginTick([p], [p], r.clock.t);
    r.clock.t += rnd(3) === 0 ? 0 : 1 + rnd(60 * S);
    r.tracker.observe(p, readings[rnd(readings.length)], r.clock.t - (rnd(20) === 0 ? 5 * S : 0));
    if (rnd(5) === 0) r.flush();
    if (rnd(400) === 0) { if (rnd(2)) r.tracker.stop(r.clock.t); r.clock.t += rnd(H); r = r.restart(); }
  }
  r.flush();
  const s = r.store.segments("u");
  for (let i = 1; i < s.length; i++) assert.ok(s[i].start >= s[i - 1].end, `interval ${i} overlaps`);
  assert.equal(new Set(s.map(z => z.start)).size, s.length, "no duplicates");
  assert.ok(s.filter(z => z.kind === "job").every(z => z.jobId != null));
  const l = ledgerOf(r.store, "u", T0, r.clock.t + 1);
  assert.equal(Object.values(l.buckets).reduce((a, b) => a + b, 0), l.eligibleMs);
});
