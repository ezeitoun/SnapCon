// test/utilization/classify.test.js — what a printer's time counts as.
const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../../utilization/classify");

test("the six operational states are exactly the defined ones", () => {
  assert.deepEqual([...c.OPERATIONAL], ["printing", "failed", "paused", "error", "idle", "offline"]);
  for (const b of [...c.PROVISIONAL, ...c.GAPS]) assert.ok(!c.OPERATIONAL.includes(b), b);
});

test("every connector state maps to its kind", () => {
  const want = { printing: "job", paused: "paused", error: "error", shutdown: "error", standby: "idle", idle: "idle", complete: "idle", cancelled: "idle", busy: "idle", updating: "offline", rebooting: "offline" };
  for (const [state, kind] of Object.entries(want)) assert.equal(c.classifyReading({ online: true, state }).kind, kind, state);
});

test("not reachable is Offline; online but unknown is NOT Offline, nor Idle", () => {
  assert.equal(c.classifyReading({ online: false, state: "printing" }).kind, "offline");
  assert.equal(c.classifyReading(null).kind, "offline");
  for (const state of ["unknown", "maintenance", undefined, null, "", "constructor", "toString"]) {
    const r = c.classifyReading({ online: true, state });
    assert.equal(r.kind, "unobserved", String(state));
    assert.match(r.reason, /^state-/);
  }
});

test("job time is Printing only when the job completed", () => {
  const job = outcome => c.bucketFor({ kind: "job", outcome });
  assert.equal(job("completed"), "printing");
  assert.equal(job("failed"), "failed");
  assert.equal(job("cancelled"), "failed");
  assert.equal(job("running"), "provisionalRunning");
  assert.equal(job("unknown"), "provisionalUnknown");
  assert.throws(() => job(undefined), /invalid outcome/);
  assert.throws(() => c.bucketFor({ kind: "nonsense" }), /invalid interval kind/);
});

test("a pause or error inside a job stays what it is, whatever the job's outcome", () => {
  for (const outcome of ["completed", "failed", "unknown"]) {
    assert.equal(c.bucketFor({ kind: "paused", outcome }), "paused");
    assert.equal(c.bucketFor({ kind: "error", outcome }), "error");
  }
});

test("Moonraker statuses: an ending that says nothing about the job is unknown, not success or failure", () => {
  const want = { completed: "completed", cancelled: "cancelled", error: "failed", klippy_shutdown: "failed", in_progress: "running", interrupted: "unknown", klippy_disconnect: "unknown", server_exit: "unknown", brand_new: "unknown", constructor: "unknown" };
  for (const [s, o] of Object.entries(want)) assert.equal(c.moonrakerOutcome(s), o, s);
});

const J = (o = {}) => ({ job_id: "0001", status: "completed", start_time: 1000, end_time: 1960, total_duration: 960, print_duration: 360, ...o });

test("backfill: one policy for every job; the printer's print time is known, the rest is uncertain; raw figures kept", () => {
  const s = c.backfilledJob(J());   // the real cube's shape: 16 minutes on the clock, 6 printing
  assert.equal(s.knownFraction, 0.375);
  assert.equal(s.provenance, "backfilled");
  assert.equal(s.outcome, "completed");
  assert.deepEqual(s.raw, { status: "completed", jobId: "0001", totalDuration: 960, printDuration: 360 });
});

test("backfill: a long gap between clock and print time gets no different rule", () => {
  const short = c.backfilledJob(J({ end_time: 1000 + 3600, print_duration: 3000 }));
  const long = c.backfilledJob(J({ end_time: 1000 + 36000, print_duration: 3000 }));
  assert.equal(short.knownFraction, 3000 / 3600);
  assert.equal(long.knownFraction, 3000 / 36000);
});

test("backfill: a missing or impossible figure claims nothing and overstates nothing", () => {
  assert.equal(c.backfilledJob(J({ print_duration: null })).knownFraction, 0);
  assert.equal(c.backfilledJob(J({ print_duration: -5 })).knownFraction, 0);
  assert.equal(c.backfilledJob(J({ print_duration: 99999 })).knownFraction, 1);
  assert.equal(c.backfilledJob(J({ end_time: null })), null);
  assert.equal(c.backfilledJob(J({ end_time: 1000 })), null);
  assert.equal(c.backfilledJob(J({ status: "in_progress" })), null);
});

test("an outage stays Offline without the printer's own timestamps", () => {
  assert.deepEqual(c.splitOutage({ start: 100, end: 200, cause: "unreachable" }, null), [{ start: 100, end: 200, kind: "offline", provenance: "observed", reason: "unreachable" }]);
  assert.equal(c.splitOutage({ start: 100, end: 200, cause: "unreachable" }, { start: 300, end: 400, outcome: "completed" })[0].kind, "offline");
  assert.throws(() => c.splitOutage({ start: 100, end: 200 }, null), /known cause/);
  assert.throws(() => c.splitOutage({ start: 100, end: 200, cause: "maybe" }, null), /known cause/);
});

test("progress having advanced changes nothing about an outage", () => {
  const out = c.splitOutage({ start: 100, end: 200, cause: "unreachable", progressBefore: 0.2, progressAfter: 0.9 }, { progressAdvanced: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "offline");
});

test("an unreachable outage stays Offline whatever the history says; SnapCon's own downtime gets only the confirmed part, inferred and estimated", () => {
  const off = c.splitOutage({ start: 100, end: 400, cause: "unreachable" }, { start: 200, end: 300, outcome: "completed", jobId: "7", knownFraction: 1 });
  assert.deepEqual(off.map(s => [s.start, s.end, s.kind, s.provenance]), [[100, 400, "offline", "observed"]]);
  const down = c.splitOutage({ start: 100, end: 400, cause: "service-down" }, { start: 200, end: 300, outcome: "completed", jobId: "7", knownFraction: 0.5 });
  assert.deepEqual(down.map(s => [s.start, s.end, s.kind, s.provenance, s.estimated, s.knownFraction]), [[200, 300, "job", "inferred", true, 0.5]]);
  assert.equal(down[0].jobId, "7");
});

test("the chart stacks every bucket once, a running job directly on Printing", () => {
  assert.deepEqual([...c.CHART_ORDER].sort(), [...c.BUCKETS].sort());
  assert.deepEqual(c.CHART_ORDER.slice(0, 2), ["printing", "provisionalRunning"]);
});
