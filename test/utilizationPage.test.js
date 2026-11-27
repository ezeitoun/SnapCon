// test/utilizationPage.test.js — the Fleet utilization page (public/
// utilization.js, Phase 4).
//
//   1. Its pure helpers: the address and the API/CSV query, what an error
//      means, a chart column's segments (shares of eligible time, never
//      stretched to 100% recorded), sorting, deltas in words, schedules.
//   2. The whole page, run in a sandbox against the REAL reporting API (a
//      real store, the real routes, the real permission check): loading,
//      the chart's totals against the API's, hidden and virtual printers
//      never shown or linked, estimates kept apart, the farm-hours, network
//      and unavailable errors, the empty state, a late answer after closing.
//   3. Translations (every key it uses, in English and Spanish, with the same
//      placeholders) and the accessible, responsive structure it is built on.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const vm = require("node:vm");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const { createUtilizationStore } = require("../utilization/UtilizationStore");
const { createReporting, LIMITATIONS } = require("../utilization/Reporting");
const { registerUtilizationRoutes } = require("../utilization/routes");
const { dayRange, rangeDays } = require("../utilization/timeBuckets");
const { BUCKETS } = require("../utilization/classify");
const { emptyJobs } = require("../utilization/rollup");
const { printerVisibleTo } = require("../groupAccess");
const { quiet, tmpBase } = require("./utilization/helpers");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "public", "utilization.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
const indexHtml = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
const ES = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "es.json"), "utf8"));
const H = 3600e3, DAY = 86400e3;

// A function's whole source, braces matched (the page's helpers are one-liners
// and blocks alike).
function fnSource(text, name) {
  const at = text.indexOf("function " + name + "(");
  assert.ok(at >= 0, "missing function " + name);
  let i = text.indexOf("{", text.indexOf(")", at)), depth = 0;
  for (; i < text.length; i++) { if (text[i] === "{") depth++; else if (text[i] === "}" && --depth === 0) break; }
  return text.slice(at, i + 1);
}
const constLine = name => { const m = src.match(new RegExp("  const " + name + "=[^\\n]*\\n")); assert.ok(m, "missing const " + name); return m[0]; };

// English, as i18n.js does it; an unknown key comes back marked so a raw key
// in the page fails the tests.
function lookup(data, key) { return key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), data); }
function makeT(data) {
  const t = (key, params) => {
    const v = lookup(data, key);
    if (typeof v !== "string") return "⟦" + key + "⟧";
    return v.replace(/\{(\w+)\}/g, (m, k) => (params && params[k] != null ? String(params[k]) : m));
  };
  const tn = (key, count, params) => t(key + (count === 1 ? "_one" : "_other"), Object.assign({ count }, params || {}));
  return { t, tn };
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- 1. pure helpers ----
const PURE = ["labelEvery", "parseUrl", "urlFor", "queryFor", "csvHref", "errorInfo", "segmentsFor", "provenanceTotals", "conflictTotal", "sortValue", "sortRows",
  "dayDate", "fmtDay", "fmtRange", "fmtNum", "fmtPct", "fmtHours", "fmtPerDay", "deltaText", "scheduleText", "pointLabel", "pointSummary"];
const { t: enT, tn: enTn } = makeT(EN);
const pure = vm.createContext({ URLSearchParams, Intl, t: enT, tn: enTn, uiDateLocale: () => "en-US" });
vm.runInContext([constLine("STACK"), constLine("GAPS"), constLine("PROV"), constLine("KPIS"), fnSource(appSrc, "fmtDuration"), ...PURE.map(n => fnSource(src, n))].join("\n"), pure);
const call = (n, ...a) => vm.runInContext(n, pure)(...a);
const plain = v => JSON.parse(JSON.stringify(v));

const hoursOf = o => Object.fromEntries(BUCKETS.map(b => [b, { total: 0, observed: 0, inferred: 0, backfilled: 0, estimated: 0, ...(o[b] || {}) }]));

test("the address: defaults left out, every filter read back, anything unknown is the default", () => {
  assert.equal(call("urlFor", { range: 7, basis: "24h", end: "", virtual: false }), "/utilization");
  const s = { range: 90, basis: "farm", end: "2026-10-01", virtual: true };
  assert.equal(call("urlFor", s), "/utilization?range=90&basis=farm&end=2026-10-01&virtual=1");
  assert.deepEqual(plain(call("parseUrl", "?range=90&basis=farm&end=2026-10-01&virtual=1")), s);
  assert.deepEqual(plain(call("parseUrl", "?range=8&basis=hours&end=tomorrow&virtual=yes")), { range: 7, basis: "24h", end: "", virtual: false });
  assert.deepEqual(plain(call("parseUrl", "")), { range: 7, basis: "24h", end: "", virtual: false });
});

test("the reports and the CSV get the same filters, and nothing else (no printer list the page made up)", () => {
  const s = { range: 30, basis: "farm", end: "2026-10-01", virtual: true };
  assert.equal(call("queryFor", s), "range=30&basis=farm&end=2026-10-01&includeVirtual=1");
  assert.equal(call("csvHref", s, "printers"), "/api/utilization/export.csv?view=printers&range=30&basis=farm&end=2026-10-01&includeVirtual=1");
  assert.equal(call("csvHref", { range: 7, basis: "24h", end: "", virtual: false }, "fleet"), "/api/utilization/export.csv?view=fleet&range=7&basis=24h");
  assert.doesNotMatch(call("csvHref", s, "printers"), /printers=/, "never a printer list of its own");
});

test("what an error means: farm hours offer the 24-hour figures, the time zone does not; network and unavailable are their own", () => {
  assert.deepEqual(plain(call("errorInfo", 409, "farm_hours_not_configured", "x")), { kind: "farm_missing", fallback24h: true, detail: "" });
  assert.deepEqual(plain(call("errorInfo", 409, "farm_hours_invalid", "Farm hours in config.json are not usable: the start and the end must differ")),
    { kind: "farm_invalid", fallback24h: true, detail: "the start and the end must differ" });
  assert.equal(call("errorInfo", 409, "time_zone_invalid").fallback24h, false);
  assert.equal(call("errorInfo", 503, "utilization_unavailable").kind, "unavailable");
  assert.equal(call("errorInfo", 503, undefined).kind, "unavailable");
  assert.equal(call("errorInfo", 400, "bad_end").kind, "bad_end");
  assert.equal(call("errorInfo", 0).kind, "network");
  assert.equal(call("errorInfo", 500, "utilization_report_failed", "boom").kind, "generic");
});

test("a column is shares of eligible time: Not recorded keeps its height, nothing is stretched to 100% recorded", () => {
  const agg = { eligibleHours: 24, hours: hoursOf({ printing: { total: 6, estimated: 2 }, idle: { total: 6 }, notRecorded: { total: 12 } }) };
  const segs = plain(call("segmentsFor", agg));
  assert.deepEqual(segs.map(s => s.bucket), ["printing", "idle", "notRecorded"], "stack order");
  assert.equal(segs.find(s => s.bucket === "notRecorded").share, 0.5, "half the day not recorded is half the column");
  const p = segs[0];
  assert.equal(p.confirmed, 4 / 24); assert.equal(p.estimated, 2 / 24, "the estimated part is its own (hatched) part");
  const recordedOnly = segs.filter(s => s.bucket !== "notRecorded").reduce((a, s) => a + s.share, 0);
  assert.equal(recordedOnly, 0.5, "recorded activity is not normalized to the full column");
  // Shares that do not reach the eligible time are left short, not scaled up.
  const short = plain(call("segmentsFor", { eligibleHours: 10, hours: hoursOf({ idle: { total: 4 } }) }));
  assert.equal(short.reduce((a, s) => a + s.share, 0), 0.4);
  assert.deepEqual(plain(call("segmentsFor", { eligibleHours: 0, hours: hoursOf({}) })), [], "no eligible time: an empty column");
  assert.match(call("pointSummary", { from: "2026-11-02", to: "2026-11-02", eligibleHours: 24, hours: agg.hours }, "day"), /Not recorded 50%/);
  assert.match(call("pointSummary", { from: "2026-11-02", to: "2026-11-02", eligibleHours: 0, hours: hoursOf({}) }, "day"), /no eligible time/);
});

test("per-printer sorting: by value both ways, an unknown value last either way, ties in API order", () => {
  const row = (id, u, extra = {}) => ({ id, name: id, kpis: { utilization: { value: u, withEstimates: u }, failureLoss: { value: null } }, coverage: { telemetry: 1 },
    jobs: { completed: 1, failed: 0, cancelled: 0, unknown: { total: 0 } }, hours: hoursOf({}), reconciliation: { conflicts: {} }, ...extra });
  const rows = [row("b", 0.5), row("a", null), row("c", 0.9), row("d", 0.5)];
  assert.deepEqual(call("sortRows", rows, "utilization", "desc").map(r => r.id), ["c", "b", "d", "a"]);
  assert.deepEqual(call("sortRows", rows, "utilization", "asc").map(r => r.id), ["b", "d", "c", "a"]);
  assert.deepEqual(call("sortRows", rows, "name", "asc").map(r => r.id), ["a", "b", "c", "d"]);
  const conf = [row("x", 0, { reconciliation: { conflicts: { "outcome-disagrees": 2, "ends-after-now": 1 } } }), row("y", 0)];
  assert.deepEqual(call("sortRows", conf, "conflicts", "desc").map(r => r.id), ["x", "y"]);
  assert.equal(call("conflictTotal", conf[0].reconciliation), 3);
});

test("provenance: observed, inferred and backfilled hours, and the estimated part of them", () => {
  const p = { hours: hoursOf({ printing: { total: 10, observed: 6, inferred: 2, backfilled: 2, estimated: 2 }, historicalUncertain: { total: 1, backfilled: 1, estimated: 1 } }) };
  assert.deepEqual(plain(call("provenanceTotals", p)), { observed: 6, inferred: 2, backfilled: 3, estimated: 3 });
});

test("axis labels: as many as fit the plot, never more than 10, so they never overlap on a phone", () => {
  assert.equal(call("labelEvery", 7, 1400), 1, "a week: every day labelled");
  assert.equal(call("labelEvery", 30, 1400), 3, "30 days on a desktop: 10 labels");
  assert.equal(call("labelEvery", 30, 390), 5, "30 days on a phone: 6 labels");
  assert.equal(call("labelEvery", 13, 390), 3, "13 weeks on a phone");
  assert.equal(call("labelEvery", 30, 100), 15, "never fewer than 2 labels");
});

test("a change is said in words, never colour alone; a change too small to show is not '0 better'", () => {
  assert.deepEqual(plain(call("deltaText", { change: 0.032, verdict: "better", partialCoverage: false }, true)), { text: "+3.2 pts", verdict: "better", partial: false });
  assert.deepEqual(plain(call("deltaText", { change: -0.5, verdict: "worse", partialCoverage: true }, false)), { text: "−30m 00s", verdict: "worse", partial: true });
  assert.equal(call("deltaText", { change: -0.0001, verdict: "better", partialCoverage: false }, true).text, "−under 0.1 pts");
  assert.equal(call("deltaText", { change: 0, verdict: "same", partialCoverage: false }, true).text, "±under 0.1 pts");
  assert.equal(call("deltaText", null, true), null, "no comparison is said as such, not as 0");
});

test("unknown figures are a dash, never 0; durations go through fmtDuration; schedules in words, overnight said", () => {
  assert.equal(call("fmtPct", null), "—");
  assert.equal(call("fmtPct", 0), "0%");
  assert.equal(call("fmtHours", 0), "0 h");
  assert.equal(call("fmtHours", 0.03), "under 0.1 h", "some time is never shown as none");
  assert.equal(call("fmtHours", 412.4), "412 h");
  assert.equal(call("fmtPerDay", null), "—");
  assert.equal(call("fmtPerDay", 14 + 19 / 60), "14h 19m");
  assert.equal(call("scheduleText", { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" }), "Farm hours Mon–Fri 08:00–18:00");
  assert.equal(call("scheduleText", { days: [0, 6], start: "22:00", end: "06:00" }), "Farm hours Sun, Sat 22:00–06:00 (overnight)");
  assert.equal(call("fmtRange", "2026-10-05", "2026-11-03"), "Oct 5 – Nov 3, 2026");
});

// ---- 2. the whole page against the real API ----
function world(t, { nowDay = "2027-01-15", historyReading } = {}) {
  const base = tmpBase(t);
  const clock = { t: dayRange(nowDay, "UTC").start + 12 * H };
  let reporting = null;
  const store = createUtilizationStore({ baseDir: base, log: quiet, now: () => clock.t, onTouched: ch => reporting && reporting.invalidate(ch) }).open();
  t.after(() => store.close());
  reporting = createReporting({ store, now: () => clock.t, ...(historyReading ? { historyReading } : {}) });
  const db = new DatabaseSync(path.join(base, "utilization-data", "utilization.db"));
  t.after(() => db.close());
  let n = 0;
  const w = {
    clock, store, reporting, nowDay,
    printer: (id, name, { virtual = false, firstSeen = clock.t - 60 * DAY } = {}) =>
      db.prepare("INSERT INTO printers (id, name, connector, is_virtual, first_seen) VALUES (?,?,?,?,?)").run(id, name, "x", virtual ? 1 : 0, firstSeen),
    seg: (pid, kind, start, end, o = {}) => db.prepare("INSERT INTO segments (printer_id, kind, job_id, provenance, start_at, end_at, estimated, known_fraction) VALUES (?,?,?,?,?,?,?,?)")
      .run(pid, kind, o.jobId ?? null, o.provenance || "observed", start, end, o.estimated ? 1 : 0, o.estimated ? 0.5 : null),
    job: (pid, start, end, outcome, o = {}) => {
      const id = Number(db.prepare("INSERT INTO jobs (printer_id, source, filename, started_at, ended_at, outcome, job_key, outcome_source) VALUES (?,?,?,?,?,?,?,?)")
        .run(pid, o.source || "observed", "a.gcode", start, end, outcome, pid + ":" + (++n), o.source === "backfilled" ? "history" : null).lastInsertRowid);
      w.seg(pid, "job", start, end, { jobId: id, provenance: o.source || "observed", estimated: o.estimated });
      return id;
    },
    day: d => dayRange(d, "UTC"),
  };
  return w;
}
async function serve(t, w, { users, config = {}, configured, available = () => true }) {
  const app = express();
  let current = null;
  const requireAuth = (req, res, next) => { req.user = current ? users[current] : null; next(); };
  registerUtilizationRoutes(app, { reporting: w.reporting, store: w.store, requireAuth, getConfig: () => ({ timeZone: "UTC", ...config }), getPrinters: () => configured,
    printerVisibleTo, isAvailable: available, now: () => w.clock.t });
  const srv = http.createServer(app);
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  return { base: `http://127.0.0.1:${srv.address().port}`, as: u => { current = u; } };
}

// The page in a sandbox: the real public/utilization.js, the real switchHtml
// and fmtDuration from app.js, English from the locale file, and a DOM just
// big enough for it (the page renders by innerHTML).
function page({ base, fetchImpl, search = "", lang = EN }) {
  const handlers = {};
  const el = id => ({ id, title: "", textContent: "", innerHTML: "", scrollTop: 0, attrs: {},
    classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(type, fn) { handlers[id + ":" + type] = fn; }, querySelectorAll: () => [], contains: () => false, focus() {} });
  const els = { utilizationBtn: el("utilizationBtn"), utilizationPage: el("utilizationPage"), uzLive: el("uzLive"), setup: el("setup") };
  const location = { pathname: "/utilization", search };
  const history = { pushState(_, __, u) { const [p, q = ""] = u.split("?"); location.pathname = p; location.search = q ? "?" + q : ""; }, replaceState(...a) { this.pushState(...a); } };
  const { t, tn } = makeT(lang);
  const ctx = vm.createContext({
    window: { addEventListener() {} }, document: { querySelectorAll: () => [], activeElement: null }, location, history, URLSearchParams, Intl, Promise, setTimeout,
    fetch: fetchImpl || (url => fetch(base + url)), $: id => els[id] || null, esc, t, tn, uiDateLocale: () => "en-US", checkAuthFailure() {},
  });
  vm.runInContext([fnSource(appSrc, "fmtDuration"), fnSource(appSrc, "switchHtml")].join("\n"), ctx);
  vm.runInContext(src, ctx);
  const api = vm.runInContext("window.UtilizationPage", ctx);
  const root = els.utilizationPage;
  const settled = async () => { for (let i = 0; i < 400 && /aria-busy="true"/.test(root.innerHTML); i++) await new Promise(r => setTimeout(r, 10)); assert.doesNotMatch(root.innerHTML, /aria-busy="true"/, "the page finished loading"); return root.innerHTML; };
  return { api, root, els, location, handlers, settled };
}
const bars = html => [...html.matchAll(/<div class="uz-bar[^"]*" id="uzBar-(\d+)"[^>]*>([\s\S]*?)<\/div>/g)].map(m => ({
  i: +m[1], parts: [...m[2].matchAll(/uz-b-(\w+)( is-est)?" style="height:([\d.]+)%"/g)].map(p => ({ bucket: p[1], est: !!p[2], pct: +p[3] })) }));

// Two printers anyone can see, one a group may not, and a virtual one.
function fleet(t, opts) {
  const w = world(t, opts);
  w.printer("a", "Alpha"); w.printer("b", "Bravo"); w.printer("secret", "Secret Printer"); w.printer("v", "Virtual One", { virtual: true });
  const days = rangeDays(w.nowDay, 7);
  for (const day of days) {
    const d = w.day(day);
    // Alpha: printing 8 h, idle the rest. Bravo: 12 h not recorded, then 6 h estimated (backfilled) printing, 6 h idle.
    w.job("a", d.start, d.start + 8 * H, "completed"); w.seg("a", "idle", d.start + 8 * H, Math.min(d.end, w.clock.t));
    if (d.start + 18 * H <= w.clock.t) { w.job("b", d.start + 12 * H, d.start + 18 * H, "completed", { source: "backfilled", estimated: true }); w.seg("b", "idle", d.start + 18 * H, Math.min(d.end, w.clock.t)); }
    w.job("secret", d.start, Math.min(d.end, w.clock.t), "completed");
    w.seg("v", "idle", d.start, Math.min(d.end, w.clock.t));
  }
  // The week before: Alpha printed 4 h a day, so this week's figures have a change to show.
  for (const day of rangeDays(rangeDays(w.nowDay, 7)[0], 8).slice(0, 7)) {
    const d = w.day(day);
    w.job("a", d.start, d.start + 4 * H, "completed"); w.seg("a", "idle", d.start + 4 * H, d.end);
  }
  const configured = [{ id: "a", name: "Alpha" }, { id: "b", name: "Bravo" }, { id: "secret", name: "Secret Printer", allowedGroups: ["g2"] }, { id: "v", name: "Virtual One" }];
  const users = { viewer: { username: "viewer", role: "viewer", groupIds: ["grp_everyone"] }, admin: { username: "admin", role: "admin" } };
  return { w, configured, users };
}

test("the page against the real API: loading first, then the KPIs, the chart and the table, exactly as the API reports them", async t => {
  const { w, configured, users } = fleet(t);
  const srv = await serve(t, w, { users, configured });
  srv.as("viewer");
  const p = page({ base: srv.base });
  p.api.openFromLocation();
  assert.match(p.root.innerHTML, /aria-busy="true"/, "loading is shown at once");
  assert.match(p.root.innerHTML, /Loading utilization…/);
  assert.equal(p.els.uzLive.textContent, "Loading utilization…", "and announced");
  assert.equal(p.els.utilizationBtn.attrs["aria-pressed"], "true");
  const html = await p.settled();
  assert.match(p.els.uzLive.textContent, /^Showing /, "the loaded report is announced once");
  assert.doesNotMatch(html, /⟦/, "no raw translation key anywhere");

  const sum = await (await fetch(srv.base + "/api/utilization/summary?range=7&basis=24h")).json();
  const series = await (await fetch(srv.base + "/api/utilization/series?range=7&basis=24h")).json();
  assert.ok(html.includes(">" + call("fmtPct", sum.current.kpis.utilization.value) + "<"), "the confirmed utilization tile is the API's figure");
  assert.ok(html.includes("With estimates: ≈" + call("fmtPct", sum.current.kpis.utilization.withEstimates)), "the figure with estimates is shown apart, marked ≈");
  assert.ok(sum.current.kpis.utilization.withEstimates > sum.current.kpis.utilization.value, "(the fixture has estimated printing)");

  // Chart totals: one column per day; each column's parts are the API's
  // bucket hours over eligible hours, Not recorded included, never rescaled.
  const cols = bars(html);
  assert.equal(cols.length, series.points.length);
  assert.equal(cols.length, 7);
  for (const c of cols) {
    const pt = series.points[c.i];
    const total = c.parts.reduce((a, x) => a + x.pct, 0);
    const want = BUCKETS.reduce((a, b) => a + pt.hours[b].total, 0) / pt.eligibleHours * 100;
    assert.ok(Math.abs(total - want) < 0.01, `column ${c.i}: ${total} vs ${want}`);
    for (const b of BUCKETS) {
      const got = c.parts.filter(x => x.bucket === b).reduce((a, x) => a + x.pct, 0);
      assert.ok(Math.abs(got - pt.hours[b].total / pt.eligibleHours * 100) < 0.01, `column ${c.i} ${b}`);
    }
    const nr = c.parts.find(x => x.bucket === "notRecorded");
    assert.ok(nr && nr.pct > 0, `column ${c.i}: Bravo's unrecorded hours are drawn, not dropped`);
    const est = c.parts.filter(x => x.est).reduce((a, x) => a + x.pct, 0);
    assert.ok(Math.abs(est - BUCKETS.reduce((a, b) => a + pt.hours[b].estimated, 0) / pt.eligibleHours * 100) < 0.01, `column ${c.i}: estimates hatched`);
  }
  // Offline is named as unreachable from SnapCon wherever it is named.
  assert.match(html, /Offline \(unreachable from SnapCon\)/);
  assert.match(html, /Unreachable from SnapCon \(two polls without an answer\)\. Not proof the printer was inactive\./);
  // History reading is off unless configured, and the page says so.
  assert.deepEqual(sum.printerHistory, { reading: "off", printersRead: 0 });
  assert.match(html, /Printer job history is not read \(off in config\.json: utilization\.readPrinterHistory\)/);
  // The conservative note and every limitation the API lists.
  assert.match(html, /These figures are conservative/);
  for (const k of sum.limitations) assert.ok(html.includes(esc(lookup(EN, "utilization.limit." + k))), k);
});

test("a history pilot is said with its count of the printers shown, never a hidden one", async t => {
  const { w, configured, users } = fleet(t, { historyReading: () => ({ mode: "pilot", ids: new Set(["a", "secret"]) }) });
  const srv = await serve(t, w, { users, configured });
  srv.as("viewer");
  const p = page({ base: srv.base });
  p.api.openFromLocation();
  const html = await p.settled();
  assert.match(html, /Printer job history is read for 1 of these 2 printers only \(a pilot/, "the viewer's two printers, one of them read; the hidden one not counted");
  assert.doesNotMatch(html, /secret/i);
});

test("hidden printers never appear: not in the table, the totals, the chart text or the CSV it links; virtual ones only when asked", async t => {
  const { w, configured, users } = fleet(t);
  const srv = await serve(t, w, { users, configured });
  srv.as("viewer");
  const p = page({ base: srv.base });
  p.api.openFromLocation();
  const html = await p.settled();
  assert.doesNotMatch(html, /Secret Printer|secret/i, "a printer of another group");
  assert.doesNotMatch(html, /Virtual One/, "virtual printers are left out by default");
  assert.match(html, /Alpha/); assert.match(html, /Bravo/);
  assert.match(html, /2 printers/, "the count is of visible printers");
  for (const view of ["printers", "fleet"]) {
    const href = call("csvHref", { range: 7, basis: "24h", end: "", virtual: false }, view);
    assert.ok(html.includes(esc(href)), "the page links the CSV with its own filters");
    const csv = await (await fetch(srv.base + href)).text();
    assert.doesNotMatch(csv, /secret|Secret Printer|Virtual One/i, view + " CSV");
  }
  // The secret printer's 24 h a day of printing is in no total the viewer sees.
  const sum = await (await fetch(srv.base + "/api/utilization/summary")).json();
  assert.equal(sum.printers, 2);

  const pv = page({ base: srv.base, search: "?virtual=1" });
  pv.api.openFromLocation();
  const vhtml = await pv.settled();
  assert.match(vhtml, /Virtual One/);
  assert.match(vhtml, /class="uz-tag">virtual</, "labelled as virtual");
  assert.ok(vhtml.includes(esc("view=printers&range=7&basis=24h&includeVirtual=1")), "the CSV link keeps the choice");
  assert.doesNotMatch(vhtml, /Secret Printer/);
});

test("farm hours: missing or unusable is said plainly with where it lives, no schedule invented, no CSV offered, 24 hours one click away", async t => {
  const { w, configured, users } = fleet(t);
  for (const [config, title, body] of [
    [{}, "Farm hours are not set up", /Add utilization\.farmHours to config\.json/],
    [{ farmHours: { days: [1], start: "08:00", end: "08:00" } }, "Farm hours can't be used", /config\.json \(utilization\.farmHours\) are not usable/],
  ]) {
    const srv = await serve(t, w, { users, configured, config });
    srv.as("viewer");
    const p = page({ base: srv.base, search: "?basis=farm" });
    p.api.openFromLocation();
    const html = await p.settled();
    assert.match(html, /role="alert"/);
    assert.ok(html.includes(esc(title)), title);
    assert.match(html, body);
    assert.match(html, /Settings does not have this option yet/);
    assert.match(html, /id="uzUse24h"/, "the 24-hour figures are offered");
    assert.doesNotMatch(html, /uz-csv/, "no CSV link to a report that fails");
    assert.doesNotMatch(html, /uz-kpi"/, "no figures from a schedule that does not exist");
  }
  const srv = await serve(t, w, { users, configured, config: { farmHours: { days: [1], start: "08:00", end: "08:00" } } });
  srv.as("viewer");
  const p = page({ base: srv.base, search: "?basis=farm" });
  p.api.openFromLocation();
  await p.settled();
  assert.match(p.root.innerHTML, /the start and the end must differ/, "the server's reason is shown");
});

test("API errors: unavailable, a network failure and a server error each say what happened and offer Try again", async t => {
  const { w, configured, users } = fleet(t);
  const srv = await serve(t, w, { users, configured, available: () => false });
  srv.as("viewer");
  const p = page({ base: srv.base });
  p.api.openFromLocation();
  let html = await p.settled();
  assert.match(html, /Utilization data is not available/);
  assert.match(html, /The fleet and printing are not affected/);
  assert.match(html, /id="uzRetry"/);
  const net = page({ fetchImpl: () => Promise.reject(new TypeError("fetch failed")) });
  net.api.openFromLocation();
  html = await net.settled();
  assert.match(html, /Couldn&#39;t reach SnapCon/);
  const boom = page({ fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ error: "The report could not be made: x", code: "utilization_report_failed" }), { status: 500 })) });
  boom.api.openFromLocation();
  html = await boom.settled();
  assert.match(html, /Couldn&#39;t load utilization/);
});

test("empty: no printer to report says why (and that virtual printers are left out); nothing recorded keeps the chart, all Not recorded", async t => {
  const w = world(t);
  const srv = await serve(t, w, { users: {}, configured: [] });
  const p = page({ base: srv.base });
  p.api.openFromLocation();
  const html = await p.settled();
  assert.match(html, /No printers to report/);
  assert.match(html, /Virtual printers are left out unless you include them/);

  const w2 = world(t);
  w2.printer("idle", "Quiet", { firstSeen: w2.clock.t - 3 * DAY });
  const srv2 = await serve(t, w2, { users: {}, configured: [{ id: "idle", name: "Quiet" }] });
  const p2 = page({ base: srv2.base });
  p2.api.openFromLocation();
  const html2 = await p2.settled();
  assert.match(html2, /Nothing was recorded in this period/);
  const cols = bars(html2).filter(c => c.parts.length);
  assert.ok(cols.length > 0);
  for (const c of cols) assert.deepEqual(c.parts.map(x => x.bucket), ["notRecorded"], "all of it shown as Not recorded, not hidden");
  assert.match(html2, /—/, "unknown KPIs are a dash, not 0");
});

test("a report that answers after the page closed is dropped (no render over the fleet)", async t => {
  const { w, configured, users } = fleet(t);
  const srv = await serve(t, w, { users, configured });
  let release; const gate = new Promise(r => { release = r; });
  const p = page({ fetchImpl: async url => { await gate; return fetch(srv.base + url); } });
  p.api.openFromLocation();
  const before = p.root.innerHTML;
  p.api.close();
  assert.equal(p.api.isOpen(), false);
  assert.equal(p.els.utilizationBtn.attrs["aria-pressed"], "false");
  assert.equal(p.location.pathname, "/", "closing leaves /utilization");
  release();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(p.root.innerHTML, before, "nothing rendered after close");
});

test("read only: the page only ever GETs /api/utilization/*", async t => {
  const { w, configured, users } = fleet(t);
  const srv = await serve(t, w, { users, configured });
  const seen = [];
  const p = page({ fetchImpl: (url, opts) => { seen.push([url, (opts && opts.method) || "GET"]); return fetch(srv.base + url); } });
  p.api.openFromLocation();
  await p.settled();
  assert.equal(seen.length, 3);
  for (const [url, method] of seen) { assert.equal(method, "GET"); assert.match(url, /^\/api\/utilization\/(summary|series|printers)\?/); }
  assert.doesNotMatch(src, /method\s*:\s*["'](POST|PUT|DELETE|PATCH)/i, "no write request anywhere in the page");
});

// ---- 3. translations, accessibility, responsive structure ----
test("translations: every key the page uses exists in English and Spanish, with the same placeholders", () => {
  const keys = new Set();
  // Literal keys; a literal ending in "_" or "." is a prefix completed at run time.
  for (const m of src.matchAll(/"(utilization\.[A-Za-z0-9_.-]+)"/g)) if (!/[_.]$/.test(m[1])) keys.add(m[1]);
  keys.add("utilization.csv_printers"); keys.add("utilization.csv_fleet");
  // Keys built at run time, from the API's own vocabulary.
  for (const b of BUCKETS) { keys.add("utilization.bucket." + b); keys.add("utilization.bucket_desc." + b); }
  for (const k of LIMITATIONS) keys.add("utilization.limit." + k);
  const rec = fs.readFileSync(path.join(ROOT, "utilization", "reconcile.js"), "utf8");
  for (const m of rec.matchAll(/conflict\("([a-z-]+)"\)/g)) keys.add("utilization.conflict." + m[1]);
  const jobs = emptyJobs();
  for (const k of Object.keys(jobs.unknown).filter(k => k !== "total")) keys.add("utilization.unknown." + k);
  for (const k of Object.keys(jobs.evidence)) keys.add("utilization.evidence." + k);
  for (const k of ["utilization", "avgPrintHoursPerPrinterDay", "failureLoss", "pausedErrorHoursPerPrinterDay"]) { keys.add("utilization.kpi." + k); keys.add("utilization.kpi." + k + "_how"); }
  for (const k of ["farm_missing", "farm_invalid", "time_zone", "unavailable", "bad_end", "network", "generic"]) { keys.add(`utilization.error.${k}_title`); keys.add(`utilization.error.${k}_body`); }
  for (const k of ["better", "worse", "same"]) keys.add("utilization.delta." + k);
  for (const k of ["observed", "inferred", "backfilled"]) keys.add("utilization.col." + k);
  const plural = new Set(["utilization.days", "utilization.printer_count", "utilization.kpi.printer_days"]);
  const ph = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(",");
  let checked = 0;
  for (const k of keys) {
    // A key that is a prefix (built further at run time) is checked above.
    if (/\.$/.test(k) || /\.(bucket|bucket_desc|limit|conflict|unknown|evidence|error|delta|col|kpi)$/.test(k)) continue;
    const forms = plural.has(k) ? [k + "_one", k + "_other"] : [k];
    for (const f of forms) {
      const en = lookup(EN, f), es = lookup(ES, f);
      assert.equal(typeof en, "string", "English: " + f);
      assert.equal(typeof es, "string", "Spanish: " + f);
      assert.ok(es.trim(), "Spanish is translated: " + f);
      assert.equal(ph(es), ph(en), "placeholders: " + f);
      checked++;
    }
  }
  assert.ok(checked > 150, "checked " + checked + " keys");
  // Nothing in the Spanish section that English does not have.
  const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, p + k + ".") : [p + k]));
  assert.deepEqual(flat(ES.utilization).sort(), flat(EN.utilization).sort());
  assert.equal(EN._meta.version, ES._meta.version, "both bundled files carry the bumped version");
  assert.ok(lookup(EN, "utilization.bucket.offline").includes("unreachable from SnapCon"));
  assert.ok(lookup(ES, "utilization.bucket.offline").includes("inalcanzable desde SnapCon"));
});

test("a language switch re-renders the open page from the loaded reports (no reload, no new request)", async t => {
  const { w, configured, users } = fleet(t);
  const srv = await serve(t, w, { users, configured });
  let calls = 0;
  const p = page({ fetchImpl: url => { calls++; return fetch(srv.base + url); }, lang: ES });
  p.api.openFromLocation();
  const html = await p.settled();
  assert.match(html, /Utilización confirmada/);
  assert.match(html, /Sin conexión \(inalcanzable desde SnapCon\)/);
  assert.doesNotMatch(html, /⟦/, "no raw key in Spanish either");
  p.api.rerender();
  assert.equal(calls, 3, "re-rendered from what was loaded");
  assert.match(appSrc, /function refreshDynamicI18nText\(\)\{\n  if\(window\.UtilizationPage\) UtilizationPage\.rerender\(\);/, "app.js re-renders it on a language change");
});

test("accessible structure: real radios in labelled groups, a switch, sortable headers as buttons with aria-sort, a chart with one tab stop, a text alternative and a table", async t => {
  const { w, configured, users } = fleet(t);
  const srv = await serve(t, w, { users, configured });
  const p = page({ base: srv.base });
  p.api.openFromLocation();
  const html = await p.settled();
  assert.equal((html.match(/<fieldset class="uz-seg"><legend/g) || []).length, 2, "Period and Hours counted are labelled groups");
  assert.equal((html.match(/type="radio" name="uzRange"/g) || []).length, 3);
  assert.match(html, /<input type="checkbox" role="switch" id="uzVirtual"/, "Include virtual printers is a real switch");
  assert.match(html, /<label class="uz-field-label" for="uzEnd">/, "the date has its label");
  const tabStops = bars(html).length && (html.match(/class="uz-bar[^"]*" id="uzBar-\d+" data-i="\d+" role="img" tabindex="0"/g) || []).length;
  assert.equal(tabStops, 1, "the chart is one tab stop; arrows move inside it");
  assert.equal((html.match(/role="img" tabindex="-1" aria-label="[^"]+"/g) || []).length, 6, "every other column is described in words");
  assert.match(html, /aria-controls="uzChartTable"/, "the chart's table is one button away");
  assert.match(html, /<caption class="uz-sr">Share of eligible time in each state, per period<\/caption>/);
  assert.match(html, /<th scope="col" aria-sort="ascending"><button type="button" class="uz-sort" data-sort="name"/);
  assert.equal((html.match(/<th scope="col" aria-sort="none"><button type="button" class="uz-sort"/g) || []).length, 12);
  assert.doesNotMatch(html.replace(/<th scope="(col|row)"/g, ""), /<th[ >]/, "every header cell has its scope");
  assert.match(html, /<details class="uz-help"><summary>How this is calculated<\/summary>/, "help is a native disclosure");
  assert.match(html, /<span class="uz-delta is-(better|worse)"><span class="uz-delta-mark" aria-hidden="true">[▲▼]<\/span><span class="uz-delta-num">[^<]+<\/span> <span class="uz-delta-verdict">(better|worse)<\/span>/, "a change: an arrow (hidden from screen readers) and the verdict in words");
  assert.doesNotMatch(html, /<div[^>]*onclick/i);
  assert.match(indexHtml, /<div class="uz-sr" id="uzLive" role="status" aria-live="polite"><\/div>/, "the live region survives re-renders");
});

test("navigation and layout: the bar cell and its menu-sheet row, the tiers that shrink and move it, the route, both themes' chart colours, phone widths", () => {
  assert.match(indexHtml, /<button class="tb-cell" id="utilizationBtn"[^>]*aria-pressed="false"/);
  assert.match(indexHtml, /<button class="tb-sheet-row" id="tbSheetUtilization" data-for="utilizationBtn">/);
  assert.match(indexHtml, /<symbol id="tb-utilization"/);
  assert.ok(indexHtml.indexOf('src="/utilization.js"') > indexHtml.indexOf('src="/app.js"'), "loaded after app.js, whose globals it uses");
  assert.match(css, /#libraryBtn, #utilizationBtn\{width:46px; padding:0; justify-content:center;\}/, "icon-only in the tablet tier");
  assert.match(css, /#libraryBtn, #utilizationBtn, #themeBtn, #gear, \.tb-user, #topbarClock\{display:none;\}/, "into the menu sheet in the narrow tier");
  assert.match(fs.readFileSync(path.join(ROOT, "server.js"), "utf8"), /app\.get\(\/\^\\\/utilization\\\/\?\$\/i,/, "/utilization serves the app");
  const hues = block => ["printing", "running", "failed", "unknown", "paused", "offline", "idle", "error"].map(k => (block.match(new RegExp("--uz-" + k + ":(#[0-9a-f]{6})")) || [])[1]);
  const dark = css.slice(css.indexOf(':root, [data-theme="dark"]{\n    --uz-printing'));
  const light = css.slice(css.indexOf('[data-theme="light"]{\n    --uz-printing'));
  // The validated palettes (dataviz validate_palette.js, adjacent pairs in this stack order).
  assert.deepEqual(hues(dark), ["#3987e5", "#199e70", "#d95926", "#9085e9", "#c98500", "#6b7280", "#008300", "#e66767"]);
  assert.deepEqual(hues(light), ["#2a78d6", "#1baf7a", "#eb6834", "#6250d6", "#eda100", "#8a8f98", "#008300", "#e34948"]);
  assert.match(src, /const STACK=\["printing","provisionalRunning","failed","provisionalUnknown","paused","offline","idle","error","unobserved","historicalUncertain","notRecorded"\]/);
  assert.match(css, /@media \(max-width:720px\)\{\n    \.uz-head\{align-items:stretch;\}/);
  assert.match(css, /\.uz-kpis\{grid-template-columns:1fr 1fr; gap:8px;\}/, "two tiles a row on a phone");
  assert.match(css, /@media \(max-width:420px\)\{\n    \.uz-kpis\{grid-template-columns:1fr;\}/, "one on a narrow phone");
  assert.match(css, /\.uz-table-wrap\{overflow-x:auto; max-width:100%;\}/, "wide tables scroll inside their frame, not the page");
  assert.match(css, /\.utilization-page\.show\{display:block; max-height:calc\(100vh - 120px\); overflow-y:auto; overflow-x:hidden;\}/);
  // Deployment review (contrast and targets): the page's own text never uses --ink-faint (3.1:1 on the
  // dark panel); help toggles and sort buttons are at least 24 px tall; a summary keeps its marker.
  const uzRules = css.slice(css.indexOf("/* ---- Fleet utilization"));
  for (const sel of [".uz-kpi-prev", ".uz-yaxis", ".uz-x"]) assert.doesNotMatch(uzRules.match(new RegExp("\\" + sel + "\\{[^}]*\\}"))[0], /ink-faint/, sel);
  assert.match(uzRules, /\.uz-help summary\{[^}]*line-height:24px;/);
  assert.doesNotMatch(uzRules.match(/\.uz-help summary\{[^}]*\}/)[0], /display:/, "a summary keeps its disclosure marker");
  assert.match(uzRules, /\.uz-sort\{[^}]*min-height:24px;/);
  assert.match(uzRules, /\.uz-delta\{font-weight:600; color:var\(--ink\);\}/, "the change is text in ink; the colour is only on the arrow");
  assert.match(css, /@media \(forced-colors:active\)\{\n    \.uz-seg-part, \.uz-hseg, \.uz-sw\{forced-color-adjust:none;\}/);
});
