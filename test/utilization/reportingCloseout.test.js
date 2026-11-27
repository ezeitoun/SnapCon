// test/utilization/reportingCloseout.test.js — Phase 3 closeout (owner,
// 2026-11-03): confirmed time kept apart from everything provisional, unknown,
// uncertain or not recorded; overnight farm hours; the cache after late
// changes; reports read only; one set of definitions everywhere.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const http = require("http");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const { createUtilizationStore } = require("../../utilization/UtilizationStore");
const { createReporting } = require("../../utilization/Reporting");
const { registerUtilizationRoutes } = require("../../utilization/routes");
const { dayRange, farmWindows, shiftOf, rangeDays } = require("../../utilization/timeBuckets");
const { BUCKETS } = require("../../utilization/classify");
const { quiet, tmpBase } = require("./helpers");

const H = 3600e3, MIN = 60e3, DAY = 86400e3;
const near = (a, b, eps = 1e-3, msg) => assert.ok(a != null && Math.abs(a - b) <= eps, `${msg || ""} ${a} vs ${b}`);

function world(t, { tz = "UTC", nowDay = "2027-01-15", nowHour = 12, statements = null } = {}) {
  const base = tmpBase(t);
  const clock = { t: dayRange(nowDay, tz).start + nowHour * H };
  let reporting = null;
  const store = createUtilizationStore({ baseDir: base, log: quiet, now: () => clock.t, onTouched: ch => reporting && reporting.invalidate(ch),
    hooks: statements ? { onStatement: sql => statements.push(sql) } : {} }).open();
  t.after(() => store.close());
  reporting = createReporting({ store, now: () => clock.t });
  const db = new DatabaseSync(path.join(base, "utilization-data", "utilization.db"));
  t.after(() => db.close());
  let jobN = 0;
  const w = {
    clock, store, reporting, db, tz,
    printer: (id, { firstSeen = clock.t - 300 * DAY, removedAt = null } = {}) => db.prepare("INSERT INTO printers (id, name, connector, is_virtual, first_seen, removed_at) VALUES (?,?,?,0,?,?)").run(id, id, "x", firstSeen, removedAt),
    job: (pid, start, end, outcome, o = {}) => Number(db.prepare(`INSERT INTO jobs (printer_id, source, filename, started_at, ended_at, outcome, end_reason, job_key, outcome_source, history_mode)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(pid, o.source || "observed", "a.gcode", start, end, outcome, o.reason || null, `${pid}:k${++jobN}`, o.outcomeSource || null, o.mode || null).lastInsertRowid),
    seg: (pid, kind, start, end, o = {}) => db.prepare("INSERT INTO segments (printer_id, kind, job_id, provenance, start_at, end_at, estimated, known_fraction) VALUES (?,?,?,?,?,?,?,?)")
      .run(pid, kind, o.jobId ?? null, o.provenance || "observed", start, end, o.estimated ? 1 : 0, o.knownFraction ?? null),
    day: d => dayRange(d, tz),
    q: (o = {}) => ({ printers: store.printers().map(p => ({ ...p, firstJobAt: store.firstJobAt(p.id) })), range: 7, endDay: nowDay, tz, basis: { kind: "24h" }, basisKey: "24h", ...o }),
  };
  w.printJob = (pid, start, end, outcome, o = {}) => { const id = w.job(pid, start, end, outcome, o); w.seg(pid, "job", start, end, { jobId: id, ...o }); return id; };
  return w;
}
const hoursOf = w => (w.end - w.start) / H;
const farm = schedule => ({ basis: { kind: "farm", schedule }, basisKey: "farm:" + JSON.stringify(schedule) });

// ---- A. confirmed time ----
test("A: provisional, outcome-unknown, uncertain and Not recorded time never enter confirmed Printing or Failed", async t => {
  const w = world(t);
  w.printer("p");
  const d = w.day("2027-01-14"), at = h => d.start + h * H;
  w.printJob("p", at(0), at(2), "completed");                                                                       // 2 h confirmed printing
  w.printJob("p", at(2), at(3), "cancelled");                                                                       // 1 h confirmed failed
  w.printJob("p", at(3), at(4), "running");                                                                         // provisional running
  w.printJob("p", at(4), at(5), "unknown", { reason: "ended-without-outcome" });                                   // outcome unknown
  w.printJob("p", at(5), at(6), "unknown", { outcomeSource: "ambiguous", reason: "ambiguous: x" });
  w.printJob("p", at(6), at(7), "unknown", { outcomeSource: "unresolved", reason: "unresolved: x" });
  w.printJob("p", at(7), at(9), "completed", { source: "backfilled", provenance: "backfilled", estimated: true, knownFraction: 0.5 });   // 1 h estimated, 1 h uncertain
  w.printJob("p", at(9), at(10), "failed", { provenance: "inferred", estimated: true, knownFraction: 0 });          // 1 h uncertain
  w.seg("p", "unobserved", at(10), at(11));                                                                         // the rest: Not recorded
  const a = (await w.reporting.series(w.q({ endDay: "2027-01-14" }))).points.at(-1);
  near(a.kpis.utilization.numeratorHours, 2, 1e-9, "confirmed printing: the observed completed job only");
  near(a.kpis.failureLoss.failedHours, 1, 1e-9, "confirmed failed: the observed cancelled job only");
  near(a.kpis.failureLoss.printingHours, 2, 1e-9);
  near(a.kpis.utilization.value, 2 / 24, 1e-4);
  near(a.kpis.utilization.withEstimates, 3 / 24, 1e-4, "with the 1 h estimate, labelled");
  near(a.kpis.avgPrintHoursPerPrinterDay.value, 2, 1e-4);
  near(a.kpis.failureLoss.value, 1 / 3, 1e-4);
  near(a.hours.provisionalRunning.total, 1); near(a.hours.provisionalUnknown.total, 3);
  near(a.hours.historicalUncertain.total, 2); near(a.hours.unobserved.total, 1); near(a.hours.notRecorded.total, 13);
  near(BUCKETS.reduce((n, b) => n + a.hours[b].total, 0), 24, 1e-6);
});

test("A, property: on any mix of intervals, confirmed time is exactly the observed or inferred, not estimated, completed or failed job time", async t => {
  let x = 11;
  const rnd = n => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % n; };
  const outcomes = ["completed", "failed", "cancelled", "running", "unknown"];
  for (let trial = 0; trial < 8; trial++) {
    const w = world(t);
    w.printer("p");
    const d = w.day("2027-01-14");
    let at = d.start, wantPrint = 0, wantFail = 0;
    while (at < d.end - 30 * MIN) {
      const len = (5 + rnd(55)) * MIN, end = Math.min(at + len, d.end);
      const kind = ["job", "job", "job", "paused", "error", "idle", "offline", "unobserved"][rnd(8)];
      const prov = ["observed", "observed", "inferred", "backfilled"][rnd(4)];
      const estimated = prov !== "observed" && rnd(2) === 0, kf = estimated ? rnd(11) / 10 : null;
      if (rnd(5) === 0) { at = end; continue; }                                        // a gap: Not recorded
      if (kind === "job") {
        const outcome = outcomes[rnd(outcomes.length)];
        w.printJob("p", at, end, outcome, { provenance: prov, estimated, knownFraction: kf, source: prov === "backfilled" ? "backfilled" : "observed" });
        if (!estimated) { if (outcome === "completed") wantPrint += end - at; if (outcome === "failed" || outcome === "cancelled") wantFail += end - at; }
      } else w.seg("p", kind, at, end, { provenance: prov === "backfilled" ? "observed" : prov });
      at = end;
    }
    const a = (await w.reporting.series(w.q({ endDay: "2027-01-14" }))).points.at(-1);
    near(a.kpis.utilization.numeratorHours, wantPrint / H, 1e-3, `trial ${trial} printing`);
    near(a.kpis.failureLoss.failedHours, wantFail / H, 1e-3, `trial ${trial} failed`);
  }
});

// ---- B. overnight farm hours ----
const NIGHTS = { days: [1, 2, 3, 4, 5], start: "22:00", end: "06:00" };      // Monday to Friday nights

test("B: an overnight shift is split at midnight; each day gets its parts; an unscheduled morning gets the tail of the night before", () => {
  // 2027-01-11 is a Monday.
  const parts = day => farmWindows(day, NIGHTS, "UTC").map(hoursOf);
  assert.deepEqual(parts("2027-01-10"), [], "Sunday: no shift, and Saturday was not scheduled");
  assert.deepEqual(parts("2027-01-11"), [2], "Monday: 22:00-24:00 of Monday's shift");
  assert.deepEqual(parts("2027-01-12"), [6, 2], "Tuesday: Monday's tail, then Tuesday's start");
  assert.deepEqual(parts("2027-01-16"), [6], "Saturday: Friday night's tail only");
  const [tail, start] = farmWindows("2027-01-12", NIGHTS, "UTC");
  assert.equal(tail.shiftEnd - tail.shiftStart, 8 * H, "each part knows its whole shift");
  assert.equal(start.shiftStart, dayRange("2027-01-12", "UTC").start + 22 * H);
  // An end of 00:00 is the next midnight; so is 24:00 (not overnight).
  assert.deepEqual(farmWindows("2027-01-11", { days: [1], start: "20:00", end: "00:00" }, "UTC").map(hoursOf), [4]);
  assert.deepEqual(farmWindows("2027-01-12", { days: [1], start: "20:00", end: "00:00" }, "UTC").map(hoursOf), []);
  assert.deepEqual(farmWindows("2027-01-11", { days: [1], start: "20:00", end: "24:00" }, "UTC").map(hoursOf), [4]);
});

test("B: DST: a night across spring-forward is 7 hours, across fall-back 9; nonexistent starts move to where the clock resumes, repeated ones take the first", () => {
  const NY = "America/New_York";
  const satNight = { days: [6], start: "22:00", end: "06:00" };
  const spring = shiftOf("2026-03-07", satNight, NY), fall = shiftOf("2026-10-31", satNight, NY);
  assert.equal(hoursOf(spring), 7, "02:00-03:00 does not exist on 2026-03-08");
  assert.equal(hoursOf(fall), 9, "01:00-02:00 happens twice on 2026-11-01");
  assert.deepEqual(farmWindows("2026-03-08", satNight, NY).map(hoursOf), [5], "Sunday gets 00:00-06:00 of it: 5 real hours");
  assert.deepEqual(farmWindows("2026-11-01", satNight, NY).map(hoursOf), [7]);
  const skipped = shiftOf("2026-03-08", { days: [0], start: "02:30", end: "08:00" }, NY);
  assert.equal(new Date(skipped.start).toISOString(), "2026-03-08T07:00:00.000Z", "02:30 does not exist: from 03:00 EDT");
  const repeated = shiftOf("2026-11-01", { days: [0], start: "01:30", end: "03:00" }, NY);
  assert.equal(new Date(repeated.start).toISOString(), "2026-11-01T05:30:00.000Z", "01:30 EDT, the first of the two");
  assert.equal(hoursOf(repeated), 2.5, "and the repeated hour is worked");
});

test("B: one shift is one scheduled day, however midnight or a period edge cuts it", async t => {
  const w = world(t, { nowDay: "2027-01-25" });
  w.printer("p");
  for (const day of rangeDays("2027-01-24", 21)) { const d = w.day(day); w.seg("p", "idle", d.start, d.end); }
  // A Monday-to-Monday week: five night shifts start in it.
  const week = await w.reporting.summary(w.q({ endDay: "2027-01-17", range: 7, ...farm(NIGHTS) }));     // 2027-01-11 Mon .. 01-17 Sun
  near(week.current.basisHours, 40, 1e-6, "five 8-hour nights");
  near(week.current.printerDays, 5, 1e-6, "one printer-day per shift, not per calendar day touched");
  // A week from Tuesday to Monday: Monday night's start is in the previous period, its tail in this one.
  const tue = await w.reporting.summary(w.q({ endDay: "2027-01-18", range: 7, ...farm(NIGHTS) }));      // 01-12 Tue .. 01-18 Mon
  near(tue.current.printerDays + tue.previousPeriod.printerDays, 5 + 5, 1e-6, "shifts split by the period edge add up across the two periods");
  near(tue.current.printerDays, 6 / 8 + 4 + 2 / 8, 1e-6, "Monday night's tail (6/8), four whole nights, the next Monday's start (2/8)");
  // Utilization over farm hours: printing inside the night counts; outside it does not.
  const d = w.day("2027-01-19");                                                                       // a Tuesday
  w.db.prepare("DELETE FROM segments WHERE start_at >= ? AND start_at < ?").run(d.start, d.end);
  w.printJob("p", d.start + 20 * H, d.start + 24 * H, "completed");                                     // 20:00-24:00: 2 h inside 22:00-
  w.seg("p", "idle", d.start, d.start + 20 * H);
  w.reporting.invalidate(new Map([["p", d.start]]));
  const one = (await w.reporting.series(w.q({ endDay: "2027-01-19", range: 7, ...farm(NIGHTS) }))).points.at(-1);
  near(one.basisHours, 8, 1e-6, "Monday's tail 6 h + Tuesday's start 2 h");
  near(one.hours.printing.total, 2, 1e-6);
  near(one.kpis.utilization.value, 2 / 8, 1e-4);
});

test("B: the API takes an overnight schedule; missing and invalid schedules keep their explicit errors", async t => {
  const w = world(t);
  w.printer("p");
  const get = await api(t, w, { config: { farmHours: NIGHTS } });
  const r = await get("/api/utilization/summary?basis=farm&range=30");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.basis, { kind: "farm", schedule: NIGHTS });
  assert.ok(r.body.previous.from < r.body.from);
  for (const [cfg, code] of [[{}, "farm_hours_not_configured"], [{ farmHours: { days: [1], start: "06:00", end: "06:00" } }, "farm_hours_invalid"], [{ farmHours: { days: [8], start: "22:00", end: "06:00" } }, "farm_hours_invalid"]]) {
    const x = await (await api(t, w, { config: cfg }))("/api/utilization/summary?basis=farm");
    assert.deepEqual([x.status, x.body.code], [409, code], JSON.stringify(cfg));
  }
});

// ---- C. the cache after late changes ----
async function parity(get, range, end) {
  const fleet = (await get(`/api/utilization/export.csv?view=fleet&range=${range}&end=${end}`)).body.trim().split("\r\n");
  const head = fleet[0].split(",");
  const series = (await get(`/api/utilization/series?range=${range}&end=${end}`)).body;
  const col = (line, name) => { const v = line.split(",")[head.indexOf(name)]; return v === "" ? null : Number(v); };
  series.points.forEach((p, i) => {
    const line = fleet[i + 1];
    near(col(line, "printing_hours"), p.hours.printing.total, 1e-4, p.from);
    near(col(line, "eligible_hours"), p.eligibleHours, 1e-4, p.from);
    assert.equal(col(line, "utilization_confirmed_pct"), p.kpis.utilization.value == null ? null : Math.round(p.kpis.utilization.value * 1e4) / 100, p.from);
  });
  return series;
}
const dayOf = (s, d) => s.points.find(p => p.from === d);

test("C: late history fills a cached day; an unresolved outcome resolved later; both seen by the API and CSV alike", async t => {
  const w = world(t);
  w.printer("p");
  const d10 = w.day("2027-01-10");
  w.seg("p", "idle", d10.start - 5 * DAY, d10.start);
  const get = await api(t, w);
  const before = await parity(get, 7, "2027-01-14");
  assert.equal(dayOf(before, "2027-01-10").hours.printing.total, 0);
  w.store.applyBatch("h1", [{ type: "history", printerId: "p", at: w.clock.t, cursorTo: null, records: [{ historyId: "A@1", filename: "a.gcode", status: "completed", outcome: "completed", start: d10.start + H, end: d10.start + 3 * H, startS: 1, knownFraction: 1, printMs: 2 * H, next: null }] }]);
  const after = await parity(get, 7, "2027-01-14");
  near(dayOf(after, "2027-01-10").hours.printing.total, 2, 1e-6, "the late history is there");
  near(dayOf(after, "2027-01-10").kpis.utilization.value, 0, 1e-9, "estimated, not confirmed");
  // An observed job left unresolved (seen ending at 01:33, its record says it
  // ended at 01:30 completed), then resolved by a delayed page: a 50 s job
  // between 01:31 and the poll that saw the ending.
  const d12 = w.day("2027-01-12");
  const seenEnd = d12.start + H + 33 * MIN;
  w.seg("p", "idle", d12.start, d12.start + H);
  const jid = w.printJob("p", d12.start + H, seenEnd, "unknown", { outcomeSource: "unresolved", reason: "unresolved: x" });
  w.db.prepare("UPDATE jobs SET ended_at = ?, history_outcome = 'completed', history_end = ?, history_status = 'completed', history_id = 'U@1' WHERE id = ?").run(seenEnd, d12.start + 1.5 * H, jid);
  w.seg("p", "idle", seenEnd, d12.end);
  w.reporting.invalidate(new Map([["p", d12.start]]));
  const pre = await parity(get, 7, "2027-01-14");
  near(dayOf(pre, "2027-01-12").hours.provisionalUnknown.total, 33 / 60, 1e-6);
  w.store.applyBatch("h2", [{ type: "history", printerId: "p", at: w.clock.t, cursorTo: null, records: [{ historyId: "N@2", filename: "a.gcode", status: "cancelled", outcome: "cancelled", start: d12.start + H + 31 * MIN, end: d12.start + H + 31 * MIN + 50e3, startS: 2, knownFraction: 1, printMs: 50, next: null }] }]);
  const post = await parity(get, 7, "2027-01-14");
  near(dayOf(post, "2027-01-12").hours.printing.total, 33 / 60, 1e-6, "resolved to completed: its time is now Printing");
  near(dayOf(post, "2027-01-12").hours.provisionalUnknown.total, 0, 1e-6);
  assert.equal(dayOf(post, "2027-01-12").secondary.successRate.cancelled, 1, "and the later job is counted as its own");
});

test("C: a later record well inside an unresolved job's observed time means two prints under it: ambiguous, never completed", async t => {
  const w = world(t);
  w.printer("p");
  const d = w.day("2027-01-12");
  w.seg("p", "idle", d.start, d.start + H);
  const jid = w.printJob("p", d.start + H, d.start + 2 * H, "unknown", { outcomeSource: "unresolved", reason: "unresolved: x" });
  w.db.prepare("UPDATE jobs SET ended_at = ?, history_outcome = 'completed', history_end = ?, history_status = 'completed', history_id = 'U@1' WHERE id = ?").run(d.start + 2 * H, d.start + 1.5 * H, jid);
  w.seg("p", "idle", d.start + 2 * H, d.end);
  w.store.applyBatch("h", [{ type: "history", printerId: "p", at: w.clock.t, cursorTo: null, records: [{ historyId: "N@2", filename: "a.gcode", status: "cancelled", outcome: "cancelled", start: d.start + 1.6 * H, end: d.start + 1.8 * H, startS: 2, knownFraction: 1, printMs: 0.2 * H, next: null }] }]);
  const j = w.store.jobs("p").find(x => x.id === jid);
  assert.deepEqual([j.outcome, j.outcomeSource], ["unknown", "ambiguous"]);
  const a = (await w.reporting.series(w.q({ endDay: "2027-01-14" }))).points.find(p => p.from === "2027-01-12");
  near(a.hours.printing.total, 0, 1e-9); near(a.hours.provisionalUnknown.total, 1, 1e-6);
});

test("C: removal, return after removal, and an earlier first job change eligibility, and the cached days follow", async t => {
  const w = world(t);
  w.printer("p", { firstSeen: w.day("2027-01-09").start });
  const get = await api(t, w, { printers: [{ id: "p" }] });
  for (const day of rangeDays("2027-01-14", 6)) { const d = w.day(day); w.seg("p", "idle", d.start, d.end); }
  const s0 = await parity(get, 7, "2027-01-14");
  near(s0.points.reduce((n, p) => n + p.eligibleHours, 0), 6 * 24, 1e-6);
  const d12 = w.day("2027-01-12");
  w.store.applyBatch("r1", [{ type: "removed", id: "p", at: d12.start }]);
  const s1 = await parity(get, 7, "2027-01-14");
  near(s1.points.reduce((n, p) => n + p.eligibleHours, 0), 3 * 24, 1e-6, "eligible only until removed");
  w.store.applyBatch("r2", [{ type: "printer", id: "p", name: "p", connector: "x", isVirtual: false, at: w.clock.t }]);
  const s2 = await parity(get, 7, "2027-01-14");
  near(s2.points.reduce((n, p) => n + p.eligibleHours, 0), 6 * 24, 1e-6, "back: eligible again, including the days it was away");
  const d08 = w.day("2027-01-08");
  w.store.applyBatch("h3", [{ type: "history", printerId: "p", at: w.clock.t, cursorTo: null, records: [{ historyId: "E@3", filename: "a.gcode", status: "completed", outcome: "completed", start: d08.start + 12 * H, end: d08.start + 13 * H, startS: 3, knownFraction: 1, printMs: H, next: null }] }]);
  const s3 = await parity(get, 7, "2027-01-14");
  near(dayOf(s3, "2027-01-08").eligibleHours, 12, 1e-6, "eligible from its first job in the printer's history");
});

test("C: a schedule or time-zone change gives new figures at once, never cached ones from before", async t => {
  const w = world(t);
  w.printer("p");
  for (const day of rangeDays("2027-01-14", 7)) { const d = w.day(day); w.printJob("p", d.start + 9 * H, d.start + 13 * H, "completed"); }
  const a = await w.reporting.summary(w.q({ endDay: "2027-01-14", ...farm({ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "18:00" }) }));
  const b = await w.reporting.summary(w.q({ endDay: "2027-01-14", ...farm({ days: [0, 1, 2, 3, 4, 5, 6], start: "12:00", end: "14:00" }) }));
  near(a.current.hours.printing.total, 28); near(b.current.hours.printing.total, 7 * 1, 1e-6, "12:00-13:00 of each job");
  const c = await w.reporting.summary({ ...w.q({ endDay: "2027-01-14" }), tz: "America/New_York" });
  assert.notEqual(c.current.eligibleHours, a.current.eligibleHours);
  assert.equal(c.timeZone, "America/New_York");
});

test("C: the oldest day a report may ask for is complete within the retention (pruning cuts at the time of day)", async t => {
  const w = world(t);
  w.printer("p");
  const get = await api(t, w);
  const day = d => { const x = new Date(Date.UTC(2027, 0, 15) - d * DAY); return x.toISOString().slice(0, 10); };
  assert.equal((await get(`/api/utilization/summary?range=7&end=${day(399 - 13)}`)).status, 200, "the period before ends 399 days back");
  assert.equal((await get(`/api/utilization/summary?range=7&end=${day(400 - 13)}`)).body.code, "bad_end");
});

// ---- E. read only ----
test("E: reports only read: every statement a report runs is a SELECT, and nothing is written", async t => {
  const statements = [];
  const w = world(t, { statements });
  w.printer("p");
  for (const day of rangeDays("2027-01-14", 30)) { const d = w.day(day); w.printJob("p", d.start, d.start + 4 * H, "completed"); }
  const get = await api(t, w);
  statements.length = 0;
  for (const p of ["/api/utilization/summary?range=90", "/api/utilization/series?range=30", "/api/utilization/printers?range=7", "/api/utilization/export.csv?range=30", "/api/utilization/export.csv?view=fleet&range=90"]) assert.equal((await get(p)).status, 200, p);
  assert.ok(statements.length > 0);
  const writes = statements.filter(s => !/^\s*SELECT/i.test(s));
  assert.deepEqual(writes, []);
});

// ---- F. one set of definitions ----
test("F: the four tiles, the success rate, buckets, printer rows and CSV agree with each other and with their own components", async t => {
  const w = world(t);
  for (const id of ["a", "b", "c"]) w.printer(id);
  for (const [i, day] of rangeDays("2027-01-14", 30).entries()) {
    const d = w.day(day);
    w.printJob("a", d.start, d.start + 5 * H, i % 4 ? "completed" : "failed");
    w.seg("a", "paused", d.start + 5 * H, d.start + 6 * H);
    w.printJob("b", d.start + H, d.start + 2 * H, "cancelled");
    w.printJob("b", d.start + 2 * H, d.start + 4 * H, "completed", { source: "backfilled", provenance: "backfilled", estimated: true, knownFraction: 0.5 });
    w.seg("c", "error", d.start, d.start + 2 * H);
    if (i % 3) w.seg("c", "idle", d.start + 2 * H, d.end);
  }
  const get = await api(t, w);
  const sum = (await get("/api/utilization/summary?range=30&end=2027-01-14")).body.current;
  const series = (await get("/api/utilization/series?range=30&end=2027-01-14")).body.points;
  const per = (await get("/api/utilization/printers?range=30&end=2027-01-14")).body.printers;
  const rows = (await get("/api/utilization/export.csv?view=printers&range=30&end=2027-01-14")).body.trim().split("\r\n");
  const head = rows[0].split(","), col = (l, n) => { const v = l.split(",")[head.indexOf(n)]; return v === "" ? null : Number(v); };
  const total = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
  for (const b of BUCKETS) {
    near(total(series, p => p.hours[b].total), sum.hours[b].total, 1e-3, `series ${b}`);
    near(total(per, p => p.hours[b].total), sum.hours[b].total, 1e-3, `printers ${b}`);
  }
  near(total(rows.slice(1), l => col(l, "printing_hours")), sum.hours.printing.total, 1e-2, "CSV printing");
  // Each tile from its own components, the same in every view.
  const tile = a => ({
    u: a.kpis.utilization.numeratorHours / a.kpis.utilization.denominatorHours,
    avg: a.kpis.utilization.numeratorHours / a.kpis.avgPrintHoursPerPrinterDay.printerDays,
    loss: a.kpis.failureLoss.failedHours / (a.kpis.failureLoss.failedHours + a.kpis.failureLoss.printingHours),
    pe: (a.kpis.pausedErrorHoursPerPrinterDay.pausedHours + a.kpis.pausedErrorHoursPerPrinterDay.errorHours) / a.kpis.pausedErrorHoursPerPrinterDay.recordedPrinterDays,
    sr: a.secondary.successRate.completed / (a.secondary.successRate.completed + a.secondary.successRate.failed + a.secondary.successRate.cancelled),
  });
  for (const a of [sum, ...per, ...series]) {
    const x = tile(a);
    if (a.kpis.utilization.value != null) near(a.kpis.utilization.value, x.u, 1e-3);
    if (a.kpis.avgPrintHoursPerPrinterDay.value != null) near(a.kpis.avgPrintHoursPerPrinterDay.value, x.avg, 1e-2);
    if (a.kpis.failureLoss.value != null) near(a.kpis.failureLoss.value, x.loss, 1e-3);
    if (a.kpis.pausedErrorHoursPerPrinterDay.value != null) near(a.kpis.pausedErrorHoursPerPrinterDay.value, x.pe, 1e-2);
    if (a.secondary.successRate.value != null) near(a.secondary.successRate.value, x.sr, 1e-3);
  }
  for (const p of per) {
    const mine = rows.slice(1).filter(l => l.split(",")[1] === p.id);
    near(total(mine, l => col(l, "printer_days")), p.printerDays, 1e-2, p.id);
    near(total(mine, l => col(l, "recorded_printer_days")), p.recordedPrinterDays, 1e-2, p.id);
    assert.equal(total(mine, l => col(l, "jobs_cancelled")), p.secondary.successRate.cancelled);
  }
});

async function api(t, w, { config = {}, printers = null } = {}) {
  const app = express();
  const configured = printers || w.store.printers().map(p => ({ id: p.id }));
  registerUtilizationRoutes(app, { reporting: w.reporting, store: w.store, requireAuth: (q, r, n) => n(), getConfig: () => ({ timeZone: w.tz, ...config }), getPrinters: () => configured,
    printerVisibleTo: () => true, isAvailable: () => w.store.isAvailable(), now: () => w.clock.t });
  const srv = http.createServer(app);
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  return async p => { const r = await fetch(base + p); const text = await r.text(); let body = text; try { body = JSON.parse(text); } catch {} return { status: r.status, body }; };
}
