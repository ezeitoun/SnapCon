// test/utilization/reporting.test.js — Phase 3: rollups, KPIs, series,
// per-printer, CSV, and the API around them (validation, visibility, limits).
// Data is written straight into a real store, so every figure below is
// computed by hand from intervals placed exactly.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const http = require("http");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const { createUtilizationStore } = require("../../utilization/UtilizationStore");
const { createReporting, csvCell } = require("../../utilization/Reporting");
const { registerUtilizationRoutes } = require("../../utilization/routes");
const { dayRange, rangeDays, addDays } = require("../../utilization/timeBuckets");
const { BUCKETS } = require("../../utilization/classify");
const { quiet, tmpBase } = require("./helpers");

const H = 3600e3, MIN = 60e3, DAY = 86400e3;
const near = (a, b, eps = 1e-3, msg) => assert.ok(a != null && Math.abs(a - b) <= eps, `${msg || ""} ${a} vs ${b}`);

// A store with printers and intervals written directly (exact), and a clock.
function world(t, { tz = "UTC", nowDay = "2027-01-15", nowHour = 12 } = {}) {
  const base = tmpBase(t);
  const clock = { t: dayRange(nowDay, tz).start + nowHour * H };
  // Wired as index.js wires it: the store's change notices drop cached days.
  let reporting = null;
  const store = createUtilizationStore({ baseDir: base, log: quiet, now: () => clock.t, onTouched: ch => reporting && reporting.invalidate(ch) }).open();
  t.after(() => store.close());
  reporting = createReporting({ store, now: () => clock.t });
  const db = new DatabaseSync(path.join(base, "utilization-data", "utilization.db"));
  t.after(() => db.close());
  let jobN = 0;
  const w = {
    base, clock, store, reporting, db, tz,
    printer: (id, { name = id, firstSeen = clock.t - 400 * DAY, removedAt = null, virtual = false } = {}) =>
      db.prepare("INSERT INTO printers (id, name, connector, is_virtual, first_seen, removed_at) VALUES (?,?,?,?,?,?)").run(id, name, "x", virtual ? 1 : 0, firstSeen, removedAt),
    job: (pid, start, end, outcome, o = {}) => Number(db.prepare(`INSERT INTO jobs (printer_id, source, filename, started_at, ended_at, outcome, end_reason, job_key, outcome_source, history_mode)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(pid, o.source || "observed", "a.gcode", start, end, outcome, o.reason || null, `${pid}:k${++jobN}`, o.outcomeSource || null, o.mode || null).lastInsertRowid),
    seg: (pid, kind, start, end, o = {}) => db.prepare("INSERT INTO segments (printer_id, kind, job_id, provenance, start_at, end_at, estimated, known_fraction) VALUES (?,?,?,?,?,?,?,?)")
      .run(pid, kind, o.jobId ?? null, o.provenance || "observed", start, end, o.estimated ? 1 : 0, o.knownFraction ?? null),
    day: d => dayRange(d, tz),
    q: (o = {}) => ({ printers: store.printers().filter(p => o.includeVirtual || !p.isVirtual).map(p => ({ ...p, firstJobAt: store.firstJobAt(p.id) })), range: 7, endDay: nowDay, tz, basis: { kind: "24h" }, basisKey: "24h", ...o }),
  };
  // A job interval with its job.
  w.printJob = (pid, start, end, outcome, o = {}) => { const id = w.job(pid, start, end, outcome, o); w.seg(pid, "job", start, end, { jobId: id, ...o }); return id; };
  return w;
}
const totalHours = a => BUCKETS.reduce((n, b) => n + a.hours[b].total, 0);

test("one printer, one day, placed by hand: every KPI by its formula, and the buckets add up to eligible time", async t => {
  const w = world(t);
  w.printer("p");
  const d = w.day("2027-01-14");
  w.printJob("p", d.start, d.start + 6 * H, "completed");                   // 6 h printing, confirmed
  w.printJob("p", d.start + 6 * H, d.start + 8 * H, "failed");               // 2 h failed
  const jp = w.job("p", d.start + 8 * H, d.start + 11 * H, "completed");
  w.seg("p", "paused", d.start + 8 * H, d.start + 9 * H, { jobId: jp });     // 1 h paused inside a completed job
  w.seg("p", "job", d.start + 9 * H, d.start + 11 * H, { jobId: jp });       // 2 h more printing
  w.seg("p", "error", d.start + 11 * H, d.start + 12 * H);                   // 1 h error
  w.seg("p", "idle", d.start + 12 * H, d.start + 20 * H);                    // 8 h idle
  w.seg("p", "offline", d.start + 20 * H, d.start + 22 * H);                 // 2 h offline; last 2 h not recorded
  const s = await w.reporting.series(w.q({ range: 7, endDay: "2027-01-14" }));
  const a = s.points.at(-1);
  assert.equal(a.from, "2027-01-14");
  near(a.hours.printing.total, 8); near(a.hours.failed.total, 2); near(a.hours.paused.total, 1); near(a.hours.error.total, 1);
  near(a.hours.idle.total, 8); near(a.hours.offline.total, 2); near(a.hours.notRecorded.total, 2);
  near(totalHours(a), a.eligibleHours, 1e-6, "all buckets, Not recorded included, add up to eligible");
  near(a.eligibleHours, 24); near(a.recordedHours, 22);
  near(a.kpis.utilization.value, 8 / 24, 1e-4, "utilization: confirmed Printing / eligible");
  near(a.kpis.avgPrintHoursPerPrinterDay.value, 8, 1e-4, "8 h on one printer-day");
  near(a.kpis.failureLoss.value, 2 / 10, 1e-4, "failed / (printing + failed)");
  near(a.kpis.pausedErrorHoursPerPrinterDay.value, 2 / (22 / 24), 1e-3, "(paused + error) per recorded printer-day");
  near(a.secondary.successRate.value, 2 / 3, 1e-4, "completed / (completed + failed + cancelled)");
  assert.deepEqual(Object.keys(a.kpis), ["utilization", "avgPrintHoursPerPrinterDay", "failureLoss", "pausedErrorHoursPerPrinterDay"], "the four tiles (owner, closeout)");
  near(a.coverage.telemetry, 22 / 24, 1e-4);
});

test("estimates are never confirmed productive time: headline excludes them, 'withEstimates' shows them, labelled", async t => {
  const w = world(t);
  w.printer("p");
  const d = w.day("2027-01-14");
  w.seg("p", "idle", d.start, d.start + 12 * H);
  w.printJob("p", d.start + 12 * H, d.start + 16 * H, "completed", { source: "backfilled", provenance: "backfilled", estimated: true, knownFraction: 0.5 });
  w.seg("p", "idle", d.start + 16 * H, d.end);
  const a = (await w.reporting.series(w.q({ endDay: "2027-01-14" }))).points.at(-1);
  near(a.hours.printing.total, 2); near(a.hours.printing.estimated, 2); near(a.hours.printing.backfilled, 2);
  near(a.hours.historicalUncertain.total, 2);
  assert.equal(a.kpis.utilization.value, 0, "nothing confirmed");
  near(a.kpis.utilization.withEstimates, 2 / 24, 1e-4);
  near(a.kpis.utilization.estimatedHoursExcluded, 2);
  assert.equal(a.kpis.avgPrintHoursPerPrinterDay.value, 0);
  near(a.kpis.avgPrintHoursPerPrinterDay.withEstimates, 2, 1e-4);
  near(totalHours(a), 24, 1e-6);
  // Historically uncertain time is not recorded time.
  near(a.recordedHours, 22); near(a.coverage.telemetry, 22 / 24, 1e-4);
});

test("estimated failed time is not confirmed failure loss; unobserved time is not recorded time", async t => {
  const w = world(t);
  w.printer("p");
  const d = w.day("2027-01-14");
  w.printJob("p", d.start, d.start + 4 * H, "completed");                                                                     // 4 h confirmed printing
  w.printJob("p", d.start + 4 * H, d.start + 6 * H, "failed", { source: "backfilled", provenance: "backfilled", estimated: true, knownFraction: 1 });   // 2 h estimated failed
  w.seg("p", "unobserved", d.start + 6 * H, d.start + 9 * H);
  w.seg("p", "idle", d.start + 9 * H, d.end);
  const a = (await w.reporting.series(w.q({ endDay: "2027-01-14" }))).points.at(-1);
  assert.equal(a.kpis.failureLoss.value, 0, "no confirmed failure");
  near(a.kpis.failureLoss.withEstimates, 2 / 6, 1e-4);
  near(a.recordedHours, 21, 1e-6, "24 less 3 unobserved");
});

test("the current day grows while its interval is open: never served stale from the cache", async t => {
  const w = world(t, { nowHour: 6 });
  w.printer("p");
  const today = w.day("2027-01-15");
  w.seg("p", "idle", today.start, null);
  const first = (await w.reporting.series(w.q({ endDay: "2027-01-15" }))).points.at(-1);
  near(first.hours.idle.total, 6);
  w.clock.t += 2 * H;                                                       // no write, just time
  const later = (await w.reporting.series(w.q({ endDay: "2027-01-15" }))).points.at(-1);
  near(later.hours.idle.total, 8);
});

test("missing coverage stays visible: shares include Not recorded, and nothing recorded is no figure (null), not 0%", async t => {
  const w = world(t);
  w.printer("p"); w.printer("q");
  const d = w.day("2027-01-14");
  w.seg("p", "idle", d.start, d.start + 12 * H);                             // p: half recorded; q: nothing
  const s = await w.reporting.perPrinter(w.q({ endDay: "2027-01-14", range: 7 }));
  const p = s.printers.find(x => x.id === "p"), q = s.printers.find(x => x.id === "q");
  near(p.shares.notRecorded, (7 * 24 - 12) / (7 * 24), 1e-4);
  near(Object.values(p.shares).reduce((n, v) => n + v, 0), 1, 1e-3);
  assert.equal(q.kpis.utilization.value, null);
  assert.equal(q.coverage.telemetry, 0);
  assert.equal(q.kpis.avgPrintHoursPerPrinterDay.value, null);
});

test("partial history: a printer counts only from when it existed, or from its first job the printer's history shows", async t => {
  const w = world(t);
  const d = w.day("2027-01-14");
  w.printer("p", { firstSeen: d.start + 12 * H });
  w.seg("p", "idle", d.start + 12 * H, d.end);
  w.printer("b", { firstSeen: d.start + 12 * H });
  w.printJob("b", d.start + 6 * H, d.start + 8 * H, "completed", { source: "backfilled", provenance: "backfilled", estimated: true, knownFraction: 1 });
  w.seg("b", "idle", d.start + 12 * H, d.end);
  const s = await w.reporting.perPrinter(w.q({ endDay: "2027-01-14" }));
  near(s.printers.find(x => x.id === "p").eligibleHours, 12);
  near(s.printers.find(x => x.id === "b").eligibleHours, 18, 1e-6, "from its 06:00 history job");
});

test("DST: a 23-hour local day is 23 eligible hours, and farm hours across it hold their real length", async t => {
  const w = world(t, { tz: "America/New_York", nowDay: "2026-03-10" });
  w.printer("p", { firstSeen: dayRange("2026-03-01", "America/New_York").start });
  const d = w.day("2026-03-08");
  w.seg("p", "idle", d.start, d.end);
  const day = (await w.reporting.series(w.q({ endDay: "2026-03-09" }))).points.find(x => x.from === "2026-03-08");
  near(day.eligibleHours, 23); near(day.basisHours, 23); near(day.hours.idle.total, 23);
  const farm = { kind: "farm", schedule: { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "06:00" } };
  const f = (await w.reporting.series(w.q({ endDay: "2026-03-09", basis: farm, basisKey: "farm-test" }))).points.find(x => x.from === "2026-03-08");
  near(f.basisHours, 5, 1e-6, "00:00-06:00 on the day 02:00 is skipped is 5 hours");
});

test("farm hours: only scheduled time counts on both sides; unscheduled days are no printer-days", async t => {
  const w = world(t);
  w.printer("p");
  const d = w.day("2027-01-14");                                              // a Thursday
  w.printJob("p", d.start, d.start + 12 * H, "completed");                   // 00:00-12:00: 4 h inside 08:00-18:00
  w.seg("p", "idle", d.start + 12 * H, d.end);
  const farm = { kind: "farm", schedule: { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" } };
  const s = await w.reporting.series(w.q({ endDay: "2027-01-14", basis: farm, basisKey: "farm-t" }));
  const a = s.points.at(-1);
  near(a.basisHours, 10); near(a.eligibleHours, 10); near(a.hours.printing.total, 4);
  near(a.kpis.utilization.value, 0.4, 1e-4);
  const sat = s.points.find(x => x.from === "2027-01-09");                    // a Saturday: no farm hours
  assert.equal(sat.basisHours, 0);
  assert.equal(sat.kpis.utilization.value, null);
});

test("job outcomes: counted on the day they ended; unknown never in the success rate; why unknown is kept; how each is known", async t => {
  const w = world(t);
  w.printer("p");
  const d = w.day("2027-01-14"), d0 = w.day("2027-01-13");
  w.job("p", d0.start + 23 * H, d.start + H, "completed");                    // ends on the 14th
  w.job("p", d.start + 2 * H, d.start + 3 * H, "cancelled");
  w.job("p", d.start + 4 * H, d.start + 5 * H, "unknown", { outcomeSource: "unresolved", reason: "unresolved: ..." });
  w.job("p", d.start + 5 * H, null, "unknown", { outcomeSource: "ambiguous", reason: "ambiguous: ..." });
  w.job("p", d.start + 6 * H, d.start + 7 * H, "unknown", { outcomeSource: "history", reason: "history:interrupted" });
  w.job("p", d.start + 8 * H, d.start + 8 * H + 20e3, "completed", { source: "backfilled", outcomeSource: "history", mode: "short" });
  w.job("p", d.start + 9 * H, d.start + 10 * H, "completed", { source: "backfilled", outcomeSource: "history", mode: "offline" });
  w.job("p", d.start + 11 * H, null, "running");
  const a = (await w.reporting.series(w.q({ endDay: "2027-01-14" }))).points.at(-1);
  assert.deepEqual([a.jobs.completed, a.jobs.cancelled, a.jobs.running], [3, 1, 1]);
  assert.deepEqual(a.jobs.unknown, { total: 3, unresolved: 1, ambiguous: 1, interrupted: 1, endedWithoutOutcome: 0, other: 0 });
  assert.equal(a.jobs.evidence.recoveredShort, 1);
  assert.equal(a.jobs.evidence.recoveredDuringOffline, 1);
  near(a.secondary.successRate.value, 3 / 4, 1e-4);
  near(a.secondary.successRate.outcomeCoverage, 4 / 7, 1e-4, "secondary, with its outcome coverage");
  near(a.coverage.jobsWithOutcome, 4 / 7, 1e-4);
});

test("previous period and deltas; the 90-day view in weeks, the oldest block short and labelled with its real dates", async t => {
  const w = world(t);
  w.printer("p");
  const days = rangeDays("2027-01-14", 14);
  for (const [i, day] of days.entries()) { const d = w.day(day); w.printJob("p", d.start, d.start + (i < 7 ? 6 : 12) * H, "completed"); w.seg("p", "idle", d.start + (i < 7 ? 6 : 12) * H, d.end); }
  const s = await w.reporting.summary(w.q({ endDay: "2027-01-14", range: 7 }));
  near(s.current.kpis.utilization.value, 0.5); near(s.previousPeriod.kpis.utilization.value, 0.25);
  assert.equal(s.deltas.utilization.verdict, "better");
  assert.deepEqual([s.previous.from, s.previous.to], ["2027-01-01", "2027-01-07"]);
  const n = await w.reporting.series(w.q({ endDay: "2027-01-14", range: 90 }));
  assert.equal(n.granularity, "week");
  assert.equal(n.points.length, 13);
  assert.deepEqual([n.points[0].days, n.points[0].from, n.points.at(-1).to], [6, "2026-10-17", "2027-01-14"]);
});

test("removed printers keep their history for when they existed", async t => {
  const w = world(t);
  const d = w.day("2027-01-14");
  w.printer("gone", { removedAt: d.start + 6 * H });
  w.seg("gone", "idle", d.start - DAY, d.start + 6 * H);
  const p = (await w.reporting.perPrinter(w.q({ endDay: "2027-01-14" }))).printers[0];
  assert.equal(p.removedAt, d.start + 6 * H);
  near(p.eligibleHours, 6 * 24 + 6, 1e-6, "eligible until removed, not after");
});

test("the cache: a later change to an old, cached day is seen (only the days after the change are dropped)", async t => {
  const w = world(t);
  w.printer("p");
  const d = w.day("2027-01-10");
  w.seg("p", "idle", d.start - 10 * DAY, d.start);
  const q = w.q({ endDay: "2027-01-14", range: 7 });
  const before = await w.reporting.summary(q);
  const st = w.reporting.status();
  assert.ok(st.cacheEntries >= 7);
  await w.reporting.summary(q);
  assert.ok(w.reporting.status().cachedDays > st.cachedDays, "served from the cache");
  // A history backfill into the 10th, through the store's own batch (it reports what it touched).
  w.store.applyBatch("b1", [{ type: "history", printerId: "p", at: w.clock.t, cursorTo: null,
    records: [{ historyId: "x@1", filename: "a.gcode", status: "completed", outcome: "completed", start: d.start + H, end: d.start + 3 * H, startS: 1, knownFraction: 1, printMs: 2 * H, next: null }] }]);
  const after = await w.reporting.summary(q);
  near(after.current.hours.printing.total - before.current.hours.printing.total, 2);
  assert.ok(w.reporting.status().invalidated >= 5, "the 10th and after dropped");
});

// ---- the API ----
async function api(t, w, { users = {}, config = {}, printers = null } = {}) {
  const app = express();
  const requireAuth = (req, res, next) => { const u = req.headers["x-user"]; req.user = u ? users[u] : null; if (u && !req.user) return res.status(401).end(); next(); };
  const configured = printers || w.store.printers().filter(p => !p.removedAt).map(p => ({ id: p.id, name: p.name }));
  registerUtilizationRoutes(app, { reporting: w.reporting, store: w.store, requireAuth, getConfig: () => ({ timeZone: "UTC", ...config }), getPrinters: () => configured,
    printerVisibleTo: require("../../groupAccess").printerVisibleTo, isAvailable: () => w.store.isAvailable(), now: () => w.clock.t });
  const srv = http.createServer(app);
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  return async (p, user) => { const r = await fetch(base + p, { headers: user ? { "x-user": user } : {} }); const text = await r.text(); let body = text; try { body = JSON.parse(text); } catch {} return { status: r.status, body, headers: r.headers }; };
}

test("the API: validation of every parameter, with a reason", async t => {
  const w = world(t);
  w.printer("p");
  const get = await api(t, w);
  for (const [qs, code] of [["range=8", "bad_range"], ["range=x", "bad_range"], ["basis=hours", "bad_basis"], ["includeVirtual=2", "bad_include_virtual"],
    ["end=2027-01-16", "bad_end"], ["end=2027-02-30", "bad_end"], ["end=yesterday", "bad_end"], ["end=2025-01-01", "bad_end"], ["range=90&end=2026-02-01", "bad_end"],
    ["printers=", "bad_printers"], ["printers=a%20b", "bad_printers"], ["printers=" + Array.from({ length: 201 }, (_, i) => "p" + i).join(","), "bad_printers"], ["printers=nope", "unknown_printer"]]) {
    const r = await get("/api/utilization/summary?" + qs);
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.code, code, qs);
  }
  assert.equal((await get("/api/utilization/export.csv?view=excel")).body.code, "bad_view");
  assert.equal((await get("/api/utilization/summary")).status, 200);
});

test("the API: farm hours and the time zone are never invented", async t => {
  const w = world(t);
  w.printer("p");
  assert.equal((await (await api(t, w))("/api/utilization/summary?basis=farm")).body.code, "farm_hours_not_configured");
  const r = await (await api(t, w, { config: { farmHours: { days: [1, 2, 3, 4, 5], start: "08:00", end: "08:00" } } }))("/api/utilization/summary?basis=farm");
  assert.equal(r.status, 409); assert.equal(r.body.code, "farm_hours_invalid"); assert.match(r.body.error, /must differ/);
  for (const bad of [{ days: [], start: "08:00", end: "18:00" }, { days: [1], start: "8:00", end: "18:00" }, "08:00-18:00"]) {
    const x = await (await api(t, w, { config: { farmHours: bad } }))("/api/utilization/summary?basis=farm");
    assert.deepEqual([x.status, x.body.code], [409, "farm_hours_invalid"], JSON.stringify(bad));
  }
  const night = await (await api(t, w, { config: { farmHours: { days: [1, 2, 3, 4, 5], start: "22:00", end: "06:00" } } }))("/api/utilization/summary?basis=farm");
  assert.equal(night.status, 200, "overnight is a valid schedule");
  assert.equal((await (await api(t, w, { config: { timeZone: "Mars/Olympus" } }))("/api/utilization/summary")).body.code, "time_zone_invalid");
  const ok = await (await api(t, w, { config: { farmHours: { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" } } }))("/api/utilization/summary?basis=farm");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.basis, { kind: "farm", schedule: { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" } });
});

test("the API: each user sees only their printers; one they may not see is answered as unknown; removed printers for admins only; virtual on request", async t => {
  const w = world(t);
  const d = w.day("2027-01-14");
  for (const id of ["red", "blue", "gone", "vu1"]) w.printer(id, { removedAt: id === "gone" ? d.start : null, virtual: id === "vu1" });
  for (const id of ["red", "blue", "gone", "vu1"]) w.seg(id, "idle", d.start - DAY, d.start);
  const users = { admin: { role: "admin" }, alice: { role: "user", groupIds: ["g-red"] } };
  const get = await api(t, w, { users, printers: [{ id: "red", allowedGroups: ["g-red"] }, { id: "blue", allowedGroups: ["g-blue"] }, { id: "vu1", allowedGroups: ["g-red"] }] });
  const ids = r => r.body.printers.map(p => p.id).sort();
  assert.deepEqual(ids(await get("/api/utilization/printers", "admin")), ["blue", "gone", "red"]);
  assert.deepEqual(ids(await get("/api/utilization/printers", "alice")), ["red"]);
  assert.deepEqual(ids(await get("/api/utilization/printers?includeVirtual=1", "alice")), ["red", "vu1"]);
  for (const id of ["blue", "gone", "nonexistent"]) {
    const r = await get("/api/utilization/summary?printers=" + id, "alice");
    assert.deepEqual([r.status, r.body.code, r.body.error], [400, "unknown_printer", "Unknown printer"], id);
  }
  const fleet = await get("/api/utilization/summary", "alice");
  assert.equal(fleet.body.printers, 1, "fleet totals over her printers only");
  const csv = await get("/api/utilization/export.csv", "alice");
  assert.ok(!/blue|gone/.test(csv.body), "the CSV follows the same visibility");
});

test("CSV: column names with units, numbers as numbers, and formula injection neutralised", async t => {
  assert.equal(csvCell("=HYPERLINK(\"http://x\",\"y\")"), `"'=HYPERLINK(""http://x"",""y"")"`);
  for (const s of ["+1", "-1", "@SUM(A1)", "\tx", "\rx"]) assert.ok(csvCell(s).replace(/^"/, "").startsWith("'"), JSON.stringify(s));
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell(12.5), "12.5"); assert.equal(csvCell(null), ""); assert.equal(csvCell(NaN), "");
  const w = world(t);
  w.printer("p", { name: "=cmd|' /C calc'!A0" });
  const d = w.day("2027-01-14");
  w.printJob("p", d.start, d.start + 6 * H, "completed");
  const r = await (await api(t, w, { printers: [{ id: "p", name: "x" }] }))("/api/utilization/export.csv?range=7&end=2027-01-14");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.match(r.headers.get("content-disposition"), /attachment; filename="snapcon-utilization-printers-7d-2027-01-14\.csv"/);
  const lines = r.body.trim().split("\r\n");
  const head = lines[0].split(",");
  for (const c of ["date", "printer_name", "printing_hours", "printing_estimated_hours", "not_recorded_hours", "utilization_confirmed_pct", "telemetry_coverage_pct", "jobs_outcome_unknown"]) assert.ok(head.includes(c), c);
  assert.equal(lines.length, 8, "a header and 7 days");
  assert.ok(lines.slice(1).every(l => l.includes(`'=cmd|' /C calc'!A0`)), "the name can no longer run as a formula");
});

test("API and CSV agree: the same calculations, filters and days", async t => {
  const w = world(t);
  for (const id of ["a", "b"]) w.printer(id);
  for (const day of rangeDays("2027-01-14", 30)) {
    const d = w.day(day);
    w.printJob("a", d.start + H, d.start + 4 * H, "completed");
    w.printJob("b", d.start + 2 * H, d.start + 3 * H, day.endsWith("5") ? "failed" : "completed", { source: "backfilled", provenance: "backfilled", estimated: true, knownFraction: 0.5 });
    w.seg("a", "idle", d.start + 4 * H, d.end); w.seg("b", "idle", d.start + 3 * H, d.end);
  }
  const get = await api(t, w);
  const series = (await get("/api/utilization/series?range=30&end=2027-01-14")).body;
  const fleet = (await get("/api/utilization/export.csv?view=fleet&range=30&end=2027-01-14")).body.trim().split("\r\n");
  const head = fleet[0].split(",");
  const col = (line, name) => { const v = line.split(",")[head.indexOf(name)]; return v === "" ? null : Number(v); };
  assert.equal(fleet.length - 1, series.points.length);
  series.points.forEach((p, i) => {
    const line = fleet[i + 1];
    assert.equal(line.split(",")[0], p.from);
    for (const b of ["printing", "failed", "idle", "not_recorded", "historical_uncertain"]) {
      const key = b.replace(/_(\w)/g, (_, c) => c.toUpperCase());
      near(col(line, `${b}_hours`), p.hours[key].total, 1e-4, `${p.from} ${b}`);
    }
    assert.equal(col(line, "utilization_confirmed_pct"), p.kpis.utilization.value == null ? null : Math.round(p.kpis.utilization.value * 1e4) / 100);
  });
  const per = (await get("/api/utilization/printers?range=30&end=2027-01-14")).body.printers;
  const rows = (await get("/api/utilization/export.csv?view=printers&range=30&end=2027-01-14")).body.trim().split("\r\n").slice(1);
  for (const p of per) {
    const mine = rows.filter(l => l.split(",")[1] === p.id);
    near(mine.reduce((n, l) => n + col(l, "printing_hours"), 0), p.hours.printing.total, 1e-3, p.id);
    near(mine.reduce((n, l) => n + col(l, "jobs_completed"), 0), p.jobs.completed, 0, p.id);
  }
});

test("the API: reconciliation conflicts and outcome-unknown jobs stay visible, with the accounting limitations", async t => {
  const w = world(t);
  w.printer("p");
  const d = w.day("2027-01-14");
  w.job("p", d.start, d.start + H, "unknown", { outcomeSource: "ambiguous", reason: "ambiguous: x" });
  w.db.prepare("INSERT INTO history_sync (printer_id, counters) VALUES ('p', ?)").run(JSON.stringify({ matched: 4, unresolved: 1, ambiguous: 1, conflicts: { "ambiguous-reprint": 1, "contradicts-observed": 2 } }));
  const s = (await (await api(t, w))("/api/utilization/summary?end=2027-01-14")).body;
  assert.equal(s.current.jobs.unknown.ambiguous, 1);
  assert.equal(s.flags.unresolvedOrAmbiguous, true);
  assert.deepEqual(s.reconciliation.conflicts, { "ambiguous-reprint": 1, "contradicts-observed": 2 });
  assert.ok(s.limitations.includes("offline-jobs-not-timed") && s.limitations.includes("unknown-outcomes-never-success"));
});

test("the API: unavailable data is said (503), not shown as zero", async t => {
  const w = world(t);
  const app = express();
  registerUtilizationRoutes(app, { reporting: w.reporting, store: w.store, requireAuth: (q, r, n) => n(), getConfig: () => ({}), getPrinters: () => [], printerVisibleTo: () => true, isAvailable: () => false });
  const srv = http.createServer(app); await new Promise(r => srv.listen(0, "127.0.0.1", r)); t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/utilization/summary`);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, "utilization_unavailable");
  void addDays;
});

test("wired through createUtilization: what a poll records, saved by the writer, reaches the report through the cache's change notices", async t => {
  const { createUtilization } = require("../../utilization");
  let clock = dayRange("2027-01-14", "UTC").start;
  const u = createUtilization({ baseDir: tmpBase(t), log: quiet, now: () => clock, checkpointerOptions: { periodMs: 1e9 } });
  t.after(() => u.stop());
  u.start();
  const app = express();
  u.registerRoutes(app, { requireAuth: (q, r, n) => n(), getConfig: () => ({ timeZone: "UTC" }), getPrinters: () => [{ id: "p" }], printerVisibleTo: () => true });
  const srv = http.createServer(app); await new Promise(r => srv.listen(0, "127.0.0.1", r)); t.after(() => srv.close());
  const get = async q => (await fetch(`http://127.0.0.1:${srv.address().port}${q}`)).json();
  const p = { id: "p", name: "P", connector: "x" };
  const poll = async st => { clock += 30e3; u.beginTick([p], [p]); u.observe(p, { online: true, state: st, filename: "a.gcode" }); u.endTick(); await new Promise(r => setTimeout(r, 20)); };
  for (let i = 0; i < 4; i++) await poll("printing");
  clock += 2 * H; await poll("complete");
  clock = dayRange("2027-01-15", "UTC").start + H; await poll("standby");
  const s1 = await get("/api/utilization/series?range=7&end=2027-01-15");
  const day14 = s1.points.find(x => x.from === "2027-01-14");
  near(day14.hours.printing.total, 2 + 4 * 30 / 3600 - 30 / 3600, 0.02, "the printing seen");
  assert.equal(day14.jobs.completed, 1);
  // A day already reported changes later (the printer's history fills it): the report follows.
  await poll("standby");
  assert.equal((await get("/api/utilization/summary?range=7&end=2027-01-15")).current.jobs.completed, 1);
});
