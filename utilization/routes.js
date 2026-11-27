// utilization/routes.js — the fleet utilization reporting API (Phase 3).
// Read only, behind sign-in (requireAuth), every printer filtered by what the
// signed-in user may see (owner decision D12): a configured printer through
// printerVisibleTo; a printer since removed from SnapCon, admins only (as for
// the Library's print history). Virtual printers only when asked for.
//
//   GET /api/utilization/summary   fleet KPIs, the previous period, deltas, coverage
//   GET /api/utilization/series    per day (7, 30 days) or per week (90 days)
//   GET /api/utilization/printers  per printer
//   GET /api/utilization/export.csv?view=printers|fleet
// Query: range=7|30|90 (default 7), basis=24h|farm (default 24h),
//   end=YYYY-MM-DD (default today, in the report's time zone; not in the
//   future, not before the 400-day retention), includeVirtual=0|1,
//   printers=id,id (at most 200, each one the user may see).
// Time zone: config.json utilization.timeZone, else the host's (D8). Farm
// hours: config.json utilization.farmHours { days: [0-6], start, end }, a shift
// starting on each day named; an end not after the start is overnight (ends the
// next day). Never invented: without a valid schedule, basis=farm is refused (409).
"use strict";
const { isValidTimeZone, scheduleError, localDay, addDays } = require("./timeBuckets");

const RANGES = new Set([7, 30, 90]);
const MAX_PRINTERS = 200;
// Data older than 400 days is pruned at the moment's time of day, so the oldest
// full day still complete is 399 days back.
const RETENTION_DAYS = 399;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function hostTimeZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } }

function registerUtilizationRoutes(app, { reporting, store, requireAuth, getConfig, getPrinters, printerVisibleTo, isAvailable, now = Date.now }) {
  const bad = (res, status, code, message) => res.status(status).json({ error: message, code });

  // The query, checked; or the reply that says what is wrong.
  function parse(req, res) {
    if (!isAvailable()) { bad(res, 503, "utilization_unavailable", "Fleet utilization data is not available."); return null; }
    const qs = req.query || {};
    const range = qs.range == null ? 7 : Number(qs.range);
    if (!RANGES.has(range)) { bad(res, 400, "bad_range", "range must be 7, 30 or 90"); return null; }
    const basisKind = qs.basis == null ? "24h" : String(qs.basis);
    if (basisKind !== "24h" && basisKind !== "farm") { bad(res, 400, "bad_basis", "basis must be 24h or farm"); return null; }
    const includeVirtual = qs.includeVirtual == null ? false : qs.includeVirtual === "1" ? true : qs.includeVirtual === "0" ? false : null;
    if (includeVirtual == null) { bad(res, 400, "bad_include_virtual", "includeVirtual must be 0 or 1"); return null; }

    const cfg = getConfig() || {};
    const tz = cfg.timeZone == null ? hostTimeZone() : String(cfg.timeZone);
    if (!isValidTimeZone(tz)) { bad(res, 409, "time_zone_invalid", `utilization.timeZone in config.json is not a time zone: ${tz}`); return null; }
    let basis = { kind: "24h" }, basisKey = "24h";
    if (basisKind === "farm") {
      const s = cfg.farmHours;
      if (s == null) { bad(res, 409, "farm_hours_not_configured", "Farm hours are not configured (config.json utilization.farmHours)."); return null; }
      const err = scheduleError(s);
      if (err) { bad(res, 409, "farm_hours_invalid", `Farm hours in config.json are not usable: ${err}`); return null; }
      basis = { kind: "farm", schedule: { days: [...s.days].sort(), start: s.start, end: s.end } };
      basisKey = "farm:" + JSON.stringify(basis.schedule);
    }

    const today = localDay(now(), tz);
    const endDay = qs.end == null ? today : String(qs.end);
    let realDay = false;
    try { realDay = /^\d{4}-\d{2}-\d{2}$/.test(endDay) && addDays(endDay, 0) === endDay; } catch { realDay = false; }
    if (!realDay) { bad(res, 400, "bad_end", "end must be a date, YYYY-MM-DD"); return null; }
    if (endDay > today) { bad(res, 400, "bad_end", "end cannot be in the future"); return null; }
    if (addDays(endDay, -(range * 2 - 1)) < addDays(today, -RETENTION_DAYS)) { bad(res, 400, "bad_end", `the range and the period before it must be within the last ${RETENTION_DAYS} days`); return null; }

    // The printers this user may see, in SnapCon's utilization records.
    const configured = new Map((getPrinters() || []).map(p => [p.id, p]));
    const user = req.user || null;
    const admin = !user || user.role === "admin" || !!user.implicit;
    const visible = store.printers().filter(r => {
      if (r.isVirtual && !includeVirtual) return false;
      const p = configured.get(r.id);
      return p ? printerVisibleTo(user, p) : admin;
    });
    let printers = visible;
    if (qs.printers != null) {
      const ids = String(qs.printers).split(",").filter(Boolean);
      if (!ids.length || ids.length > MAX_PRINTERS || ids.some(id => !ID.test(id))) { bad(res, 400, "bad_printers", `printers must be 1 to ${MAX_PRINTERS} printer ids`); return null; }
      const byId = new Map(visible.map(p => [p.id, p]));
      // A printer the user may not see is answered exactly like one that does not exist.
      if (ids.some(id => !byId.has(id))) { bad(res, 400, "unknown_printer", "Unknown printer"); return null; }
      printers = [...new Set(ids)].map(id => byId.get(id));
    }
    if (printers.length > MAX_PRINTERS) printers = printers.slice(0, MAX_PRINTERS);
    printers = printers.map(p => ({ ...p, firstJobAt: store.firstJobAt(p.id) }));
    return { printers, range, endDay, tz, basis, basisKey };
  }
  const handle = fn => async (req, res) => {
    const q = parse(req, res);
    if (!q) return;
    try { await fn(q, req, res); }
    catch (e) { if (!res.headersSent) bad(res, 500, "utilization_report_failed", "The report could not be made: " + e.message); }
  };

  app.get("/api/utilization/summary", requireAuth, handle(async (q, req, res) => res.json(await reporting.summary(q))));
  app.get("/api/utilization/series", requireAuth, handle(async (q, req, res) => res.json(await reporting.series(q))));
  app.get("/api/utilization/printers", requireAuth, handle(async (q, req, res) => res.json(await reporting.perPrinter(q))));
  app.get("/api/utilization/export.csv", requireAuth, (req, res, next) => {
    const view = req.query.view == null ? "printers" : String(req.query.view);
    if (view !== "printers" && view !== "fleet") return bad(res, 400, "bad_view", "view must be printers or fleet");
    return handle(async (q) => {
      const body = await reporting.csv(q, view);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="snapcon-utilization-${view}-${q.range}d-${q.endDay}.csv"`);
      res.setHeader("Cache-Control", "no-store");
      res.send(body);
    })(req, res, next);
  });
}

module.exports = { registerUtilizationRoutes, MAX_PRINTERS, RANGES };
