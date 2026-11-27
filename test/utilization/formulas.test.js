// test/utilization/formulas.test.js — the accounting and the KPIs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { BUCKETS, backfilledJob, splitOutage } = require("../../utilization/classify");
const { farmWindows, dayRange } = require("../../utilization/timeBuckets");
const { OverlapError, accountPrinter, eligibleSpan, metrics, delta, isLow } = require("../../utilization/formulas");

const H = 3600000, DAY = 24 * H;
const seg = (startH, endH, kind, extra = {}) => ({ start: startH * H, end: endH * H, kind, provenance: "observed", ...extra });
const job = (startH, endH, outcome, extra = {}) => seg(startH, endH, "job", { outcome, ...extra });
const day = (segments, extra = {}) => accountPrinter({ segments, start: 0, end: DAY, basisMs: DAY, ...extra });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ""} ${a} vs ${b}`);
const bucketsTotal = l => BUCKETS.reduce((n, b) => n + l.buckets[b], 0);

test("a full day splits into the six states, and nothing is counted twice", () => {
  const l = day([job(0, 8, "completed"), job(8, 10, "failed"), seg(10, 11, "paused"), seg(11, 12, "error"), seg(12, 20, "idle"), seg(20, 24, "offline")]);
  assert.deepEqual([l.buckets.printing, l.buckets.failed, l.buckets.paused, l.buckets.error, l.buckets.idle, l.buckets.offline].map(x => x / H), [8, 2, 1, 1, 8, 4]);
  assert.equal(bucketsTotal(l), DAY);
  const m = metrics([l]);
  near(m.utilization, 8 / 24);
  near(m.failureLoss, 2 / 10);
  near(m.avgPrintHoursPerPrinterDay, 8);
  near(m.pausedErrorHoursPerPrinterDay, 2);
  assert.equal(m.coverage.telemetry, 1);
  assert.equal(m.coverage.outcomes, 1);
});

test("overlapping intervals are refused, not added up", () => {
  assert.throws(() => day([seg(0, 5, "idle"), seg(4, 6, "offline")]), OverlapError);
  assert.throws(() => day([job(0, 5, "completed"), job(0, 5, "failed")]), OverlapError);
  // Touching is not overlapping.
  assert.equal(bucketsTotal(day([seg(0, 5, "idle"), seg(5, 6, "offline")])), DAY);
});

test("an interval with no provenance, or backwards, is refused", () => {
  assert.throws(() => day([{ start: 0, end: H, kind: "idle" }]), /provenance/);
  assert.throws(() => day([seg(0, 1, "idle", { provenance: "guessed" })]), /provenance/);
  assert.throws(() => day([seg(5, 4, "idle")]), /invalid interval/);
});

test("a running job is provisional, not Printing, and the figures say what it could become", () => {
  const m = metrics([day([job(0, 12, "running"), seg(12, 24, "idle")])]);
  assert.equal(m.utilization, 0);
  near(m.utilizationIfProvisionalSucceeds, 0.5);
  assert.equal(m.hours.printing, 0);
  assert.equal(m.hours.provisionalRunning, 12);
});

test("when a job fails, its time moves to Failed: same total, no Printing left behind", () => {
  const segs = outcome => [job(0, 10, outcome), seg(10, 11, "paused"), job(11, 12, outcome), seg(12, 24, "idle")];
  const before = day(segs("running")), after = day(segs("failed"));
  assert.equal(before.buckets.provisionalRunning, 11 * H);
  assert.equal(after.buckets.provisionalRunning, 0);
  assert.equal(after.buckets.printing, 0);
  assert.equal(after.buckets.failed, 11 * H);
  assert.equal(after.buckets.paused, H, "its pause stays Paused");
  assert.equal(bucketsTotal(before), bucketsTotal(after));
});

test("an unknown outcome is kept apart, is not success, and is left out of the success rate", () => {
  const l = day([job(0, 6, "unknown"), job(6, 12, "completed"), seg(12, 24, "idle")]);
  assert.equal(l.buckets.provisionalUnknown, 6 * H);
  assert.equal(l.buckets.printing, 6 * H);
  const m = metrics([l], [{ outcome: "unknown" }, { outcome: "completed" }, { outcome: "cancelled" }]);
  near(m.utilization, 0.25);
  near(m.successRate, 0.5);
  assert.deepEqual(m.jobs, { completed: 1, failed: 1, unknownOutcome: 1 });
  assert.equal(metrics([l], [{ outcome: "unknown" }]).successRate, null);
});

test("time with no reading is a coverage gap, visible, and not any operational state", () => {
  const l = day([seg(0, 6, "idle"), seg(6, 8, "unobserved"), seg(12, 18, "offline")]);
  assert.equal(l.buckets.unobserved, 2 * H);
  assert.equal(l.buckets.notRecorded, 10 * H);
  assert.equal(l.buckets.idle, 6 * H);
  assert.equal(l.buckets.offline, 6 * H);
  const m = metrics([l]);
  near(m.eligibleHours, 24);
  near(m.recordedHours, 12);
  near(m.coverage.telemetry, 0.5);
});

test("nothing recorded: no figures at all, never a zero that claims the printers sat idle", () => {
  const m = metrics([day([])]);
  assert.equal(m.coverage.telemetry, 0);
  assert.equal(m.coverage.outcomes, null);
  assert.equal(m.coverage.jobsWithOutcome, null);
  assert.equal(m.eligibleHours, 24, "the eligible time is still shown");
  assert.equal(m.utilization, null);
  assert.equal(m.utilizationIfProvisionalSucceeds, null);
  assert.equal(m.utilizationOfRecorded, null);
  assert.equal(m.avgPrintHoursPerPrinterDay, null);
  assert.equal(delta(m.utilization, 0.5, { higherIsBetter: true }), null);
  assert.equal(isLow(m.utilization, 40), false);
  assert.equal(m.failureLoss, null);
  assert.equal(m.pausedErrorHoursPerPrinterDay, null);
  assert.equal(m.successRate, null);
  assert.equal(metrics([]).utilization, null);
  assert.equal(metrics([]).avgPrintHoursPerPrinterDay, null);
});

test("backfilled: the known part counts, the rest is uncertain, provenance is kept, day totals hold", () => {
  // The real cube's shape, on a day otherwise unrecorded.
  const j = backfilledJob({ job_id: "1", status: "completed", start_time: 0, end_time: 960, print_duration: 360 });
  const l = day([j]);
  assert.equal(l.buckets.printing, 360000);
  assert.equal(l.buckets.historicalUncertain, 600000);
  assert.equal(l.buckets.notRecorded, DAY - 960000);
  assert.equal(l.provenance.backfilled.printing, 360000);
  assert.equal(l.provenance.observed.printing, 0);
  assert.equal(bucketsTotal(l), DAY);
  const m = metrics([l]);
  assert.equal(m.pausedErrorHoursPerPrinterDay, null, "history says nothing about pauses or errors");
  assert.ok(m.backfilledHours > 0);
});

test("a failed backfilled job: known time is Failed; a job with no print time claims nothing", () => {
  const f = day([backfilledJob({ status: "klippy_shutdown", start_time: 0, end_time: 3600, print_duration: 1800 })]);
  assert.equal(f.buckets.failed, 1800000);
  assert.equal(f.buckets.printing, 0);
  const n = day([backfilledJob({ status: "completed", start_time: 0, end_time: 3600, print_duration: null })]);
  assert.equal(n.buckets.printing, 0);
  assert.equal(n.buckets.historicalUncertain, 3600000);
});

test("a backfilled job across midnight: each day gets its share, and the shares make the whole", () => {
  const j = backfilledJob({ status: "completed", start_time: 22 * 3600, end_time: 26 * 3600, print_duration: 3 * 3600 });
  const a = accountPrinter({ segments: [j], start: 0, end: DAY, basisMs: DAY });
  const b = accountPrinter({ segments: [j], start: DAY, end: 2 * DAY, basisMs: DAY });
  assert.equal(a.buckets.printing + b.buckets.printing, 3 * H);
  assert.equal(a.buckets.historicalUncertain + b.buckets.historicalUncertain, H);
  assert.equal(a.buckets.printing, b.buckets.printing);
});

test("Offline is kept even when the printer's history confirms a job in it: no time moves to Printing (owner, Phase 2 closeout)", () => {
  const segs = splitOutage({ start: 0, end: 10 * H, cause: "unreachable" }, { start: 2 * H, end: 6 * H, outcome: "completed", knownFraction: 1 });
  assert.deepEqual(segs.map(s => [s.start / H, s.end / H, s.kind]), [[0, 10, "offline"]]);
  const l = day([...segs, seg(10, 24, "idle")]);
  assert.equal(l.buckets.printing, 0, "understated on purpose");
  assert.equal(l.buckets.offline, 10 * H);
});

test("an inferred interval counts only its confirmed share, estimated; the rest is historically uncertain", () => {
  const segs = splitOutage({ start: 0, end: 10 * H, cause: "service-down" }, { start: 2 * H, end: 6 * H, outcome: "completed", knownFraction: 0.75 });
  const l = day([...segs, seg(10, 24, "idle")]);
  assert.equal(l.buckets.printing, 3 * H);
  assert.equal(l.buckets.historicalUncertain, H);
  assert.equal(l.provenance.inferred.printing, 3 * H);
  assert.equal(l.estimated.printing, 3 * H);
  assert.equal(l.buckets.notRecorded, 6 * H);
  near(metrics([l]).inferredHours, 4);
});

test("farm hours: time outside the schedule leaves both sides of the division", () => {
  const NY = "America/New_York", schedule = { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" };
  const d = "2026-06-15", r = dayRange(d, NY), w = farmWindows(d, schedule, NY);
  const segments = [
    { start: r.start, end: w[0].start, kind: "job", outcome: "completed", provenance: "observed" },    // night print
    { start: w[0].start, end: w[0].start + 5 * H, kind: "job", outcome: "completed", provenance: "observed" },
    { start: w[0].start + 5 * H, end: r.end, kind: "idle", provenance: "observed" },
  ];
  const farm = accountPrinter({ segments, start: r.start, end: r.end, windows: w, basisMs: 10 * H });
  const all = accountPrinter({ segments, start: r.start, end: r.end, basisMs: 24 * H });
  assert.equal(farm.eligibleMs, 10 * H);
  assert.equal(farm.buckets.printing, 5 * H);
  assert.equal(farm.buckets.idle, 5 * H);
  near(metrics([farm]).utilization, 0.5);
  near(metrics([all]).utilization, 13 / 24);
  assert.equal(bucketsTotal(farm), farm.eligibleMs);
});

test("farm hours: a day with no schedule adds nothing, and does not count as a printer-day", () => {
  const off = accountPrinter({ segments: [job(0, 24, "completed")], start: 0, end: DAY, windows: [], basisMs: 0 });
  assert.equal(off.eligibleMs, 0);
  assert.equal(off.buckets.printing, 0);
  const on = accountPrinter({ segments: [job(0, 10, "completed")], start: 0, end: 10 * H, basisMs: 10 * H });
  const m = metrics([on, off]);
  assert.equal(m.printerDays, 1);
  near(m.avgPrintHoursPerPrinterDay, 10);
});

test("the 25-hour and 23-hour days are measured against their real length", () => {
  const NY = "America/New_York";
  for (const [d, len] of [["2026-11-01", 25], ["2026-03-08", 23]]) {
    const r = dayRange(d, NY);
    const l = accountPrinter({ segments: [{ start: r.start, end: r.end, kind: "job", outcome: "completed", provenance: "observed" }], start: r.start, end: r.end, basisMs: r.end - r.start });
    assert.equal(l.eligibleMs, len * H);
    near(metrics([l]).utilization, 1, d);
    near(metrics([l]).printerDays, 1, d);
  }
});

test("a printer counts only while it existed; virtual printers not at all by default", () => {
  assert.deepEqual(eligibleSpan({ firstSeen: 50 }, 0, 100), { start: 50, end: 100 });
  assert.deepEqual(eligibleSpan({ firstSeen: 50, firstJobAt: 20 }, 0, 100), { start: 20, end: 100 }, "known from its first job");
  assert.deepEqual(eligibleSpan({ firstSeen: 10, removedAt: 60 }, 0, 100), { start: 10, end: 60 });
  assert.equal(eligibleSpan({ firstSeen: 10, removedAt: 5 }, 8, 100), null);
  assert.equal(eligibleSpan({}, 0, 100), null);
  assert.equal(eligibleSpan({ firstSeen: 200 }, 0, 100), null);
  assert.equal(eligibleSpan({ firstSeen: 10, isVirtual: true }, 0, 100), null);
  assert.deepEqual(eligibleSpan({ firstSeen: 10, isVirtual: true }, 0, 100, { includeVirtual: true }), { start: 10, end: 100 });
});

test("a removed printer's time stays in the fleet for when it existed, and does not dilute after", () => {
  const whole = accountPrinter({ segments: [job(0, 24, "completed")], start: 0, end: DAY, basisMs: DAY });
  const half = accountPrinter({ segments: [job(0, 12, "completed")], start: 0, end: 12 * H, basisMs: DAY });
  const m = metrics([whole, half]);
  near(m.utilization, 1);
  near(m.printerDays, 1.5);
  near(m.avgPrintHoursPerPrinterDay, 24);
});

test("deltas: better depends on the KPI; no figure, no delta; partial coverage is said", () => {
  assert.equal(delta(0.6, 0.5, { higherIsBetter: true }).verdict, "better");
  assert.equal(delta(0.4, 0.5, { higherIsBetter: true }).verdict, "worse");
  assert.equal(delta(0.6, 0.5, { higherIsBetter: false }).verdict, "worse");
  assert.equal(delta(0.4, 0.5, { higherIsBetter: false }).verdict, "better");
  assert.equal(delta(0.5, 0.5, { higherIsBetter: true }).verdict, "same");
  assert.equal(delta(null, 0.5, { higherIsBetter: true }), null);
  assert.equal(delta(0.5, null, { higherIsBetter: true }), null);
  assert.equal(delta(0, 0, { higherIsBetter: true }).verdict, "same", "zero is a figure");
  assert.equal(delta(0.6, 0.5, { higherIsBetter: true, currentCoverage: 1, previousCoverage: 0.4 }).partialCoverage, true);
  assert.equal(delta(0.6, 0.5, { higherIsBetter: true, currentCoverage: 1, previousCoverage: 1 }).partialCoverage, false);
});

test("Low needs a figure", () => {
  assert.equal(isLow(0.39, 40), true);
  assert.equal(isLow(0.4, 40), false);
  assert.equal(isLow(null, 40), false);
});

test("any mix of intervals adds up to exactly the eligible time (seeded)", () => {
  let x = 12345;
  const r = n => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % n; };
  const kinds = ["paused", "error", "idle", "offline", "unobserved", "job"], outcomes = ["completed", "failed", "cancelled", "running", "unknown"], provs = ["observed", "inferred", "backfilled"];
  for (let run = 0; run < 400; run++) {
    const segments = [];
    let t = r(5000);
    while (t < DAY && segments.length < 40) {
      const end = t + 1 + r(7 * H);
      const kind = kinds[r(kinds.length)];
      const s = { start: t, end, kind, provenance: provs[r(3)] };
      if (kind === "job") { s.outcome = outcomes[r(5)]; if (r(2)) s.knownFraction = r(1001) / 1000; }
      segments.push(s);
      t = end + (r(3) ? 0 : r(H));
    }
    const start = r(DAY / 2), end = start + 1 + r(DAY / 2);
    const windows = r(2) ? [{ start: start + r(H), end: start + H + r(5 * H) }] : undefined;
    const l = accountPrinter({ segments, start, end, windows, basisMs: DAY });
    assert.equal(bucketsTotal(l), l.eligibleMs, `run ${run}`);
    assert.equal(l.buckets.notRecorded >= 0, true, `run ${run}`);
  }
});

test("telemetry coverage and outcome coverage are reported apart", () => {
  const l = day([job(0, 6, "completed"), job(6, 8, "failed"), job(8, 10, "running"), job(10, 12, "unknown"), seg(12, 18, "idle")]);
  const m = metrics([l], [{ outcome: "completed" }, { outcome: "failed" }, { outcome: "unknown" }]);
  near(m.coverage.telemetry, 18 / 24);
  near(m.coverage.outcomes, 8 / 12, "4 of 12 job hours have no known ending");
  near(m.coverage.jobsWithOutcome, 2 / 3);
});

test("unknown and running outcomes are never success: not in utilization, not in the success rate", () => {
  const l = day([job(0, 10, "unknown"), job(10, 20, "running"), seg(20, 24, "idle")]);
  const m = metrics([l], [{ outcome: "unknown" }, { outcome: "unknown" }]);
  assert.equal(m.utilization, 0, "there is time recorded, and none of it is confirmed Printing");
  near(m.utilizationIfProvisionalSucceeds, 20 / 24);
  assert.equal(m.hours.printing, 0);
  assert.equal(m.successRate, null);
  assert.equal(m.jobs.completed, 0);
  assert.equal(m.avgPrintHoursPerPrinterDay, 0);
  assert.equal(m.failureLoss, null);
});

test("spread history is marked estimated, across midnight, and inside farm hours", () => {
  const j = backfilledJob({ status: "completed", start_time: 22 * 3600, end_time: 26 * 3600, print_duration: 2 * 3600 });
  assert.equal(j.estimated, true);
  const a = accountPrinter({ segments: [j], start: 0, end: DAY, basisMs: DAY });
  const b = accountPrinter({ segments: [j], start: DAY, end: 2 * DAY, basisMs: DAY });
  assert.equal(a.estimated.printing, H);
  assert.equal(b.estimated.printing, H);
  assert.equal(a.estimated.historicalUncertain + b.estimated.historicalUncertain, 2 * H);
  // Farm hours: the window catches part of the spread, and that part is estimated too.
  const farm = accountPrinter({ segments: [j], start: 0, end: DAY, windows: [{ start: 23 * H, end: DAY }], basisMs: H });
  assert.equal(farm.buckets.printing, H / 2);
  assert.equal(farm.estimated.printing, H / 2);
  assert.equal(farm.estimated.historicalUncertain, H / 2);
  assert.equal(bucketsTotal(farm), farm.eligibleMs);
  near(metrics([a, b]).estimatedHours.printing, 2);
  // Observed time is never estimated.
  assert.equal(day([job(0, 5, "completed")]).estimated.printing, 0);
});

test("SnapCon being down is Not recorded, never observed Offline", () => {
  assert.deepEqual(splitOutage({ start: 0, end: 5 * H, cause: "service-down" }, null), []);
  const l = day(splitOutage({ start: 0, end: 5 * H, cause: "service-down" }, null));
  assert.equal(l.buckets.offline, 0);
  assert.equal(l.buckets.notRecorded, DAY);
  // Independent evidence, the printer's own job timestamps, is the only thing that fills it.
  const segs = splitOutage({ start: 0, end: 5 * H, cause: "service-down" }, { start: H, end: 3 * H, outcome: "completed", knownFraction: 1 });
  assert.deepEqual(segs.map(s => [s.start / H, s.end / H, s.kind, s.provenance, s.estimated]), [[1, 3, "job", "inferred", true]]);
  const m = day(segs);
  assert.equal(m.buckets.printing, 2 * H);
  assert.equal(m.buckets.offline, 0);
  assert.equal(m.buckets.notRecorded, 22 * H);
  // No known share: the confirmed span is historically uncertain, never Printing.
  const u = day(splitOutage({ start: 0, end: 5 * H, cause: "service-down" }, { start: H, end: 3 * H, outcome: "completed" }));
  assert.equal(u.buckets.printing, 0);
  assert.equal(u.buckets.historicalUncertain, 2 * H);
});
