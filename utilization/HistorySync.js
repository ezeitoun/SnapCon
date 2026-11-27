// utilization/HistorySync.js — when and how a printer's job history is read
// for reconciliation (fleet utilization, Phase 2). Network only, read only:
// it calls the connector's fetchJobHistory (a GET of Moonraker's history) and
// hands the cleaned records to the Writer, which applies them in its bounded,
// idempotent batches (reconcile.js). Nothing here touches the database except
// one indexed read of the printer's reconciliation state per pass.
//
// Bounds, so it cannot get in the way of monitoring, the queue or a print:
//   - one request at a time across the whole fleet, at least `minGapMs` apart;
//   - a printer is read only when it is online and not printing or paused
//     (its history then has nothing new to say; the printer is left alone);
//   - at most `maxPages` pages of `pageSize` per pass; more is read on a later
//     pass, never in a burst;
//   - a printer is read every `intervalMs`, sooner (`soonMs`) after a job of
//     its ends; failures back off (1 min, 5 min, 30 min, 2 h); a printer
//     without history (404) is left for `unavailableMs`;
//   - the first pass looks back `initialWindowMs` (90 days); later passes from
//     the newest start already applied, less `overlapS` for late or skewed
//     records (re-reading them is a no-op).
//
// Off unless configured (owner, pre-deployment safeguards): `setting()` is
// config.json utilization.readPrinterHistory: true reads every printer that has
// a history, a list of printer ids reads only those (a pilot), anything else,
// the key absent included, reads none. Off means no request at all, scheduled
// or after a job ends; it is checked on every tick and before every page, so
// turning it off stops a pass in progress. Recording is not affected.
"use strict";
const { normalizeRecord, collect, estimateSkew, recordKey, linkNext } = require("./history");

// What config.json utilization.readPrinterHistory means. Never throws.
function historyMode(value) {
  if (value === true) return { mode: "on", ids: null };
  if (Array.isArray(value)) {
    const ids = value.filter(v => typeof v === "string" && v.trim()).map(v => v.trim());
    if (ids.length) return { mode: "pilot", ids: new Set(ids) };
  }
  return { mode: "off", ids: null, invalid: value !== undefined && value !== null && value !== false };
}

function createHistorySync({ store, writer, historyFor, kindOf = () => null, now = Date.now, log = console, setting = () => undefined,
  intervalMs = 10 * 60e3, soonMs = 60e3, startDelayMs = 2 * 60e3, retryDelaysMs = [60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3],
  unavailableMs = 6 * 3600e3, pageSize = 50, maxPages = 4, initialWindowMs = 90 * 86400e3, overlapS = 3600,
  minGapMs = 2000, recordsPerOp = 5, pollMs = 30e3, pageGapMs = 200 } = {}) {
  const per = new Map();          // printer id -> { nextAt, failures, unavailableUntil, lastError }
  let inflight = false, stopped = false, lastRequestAt = -Infinity, order = 0;
  const stats = { passes: 0, requests: 0, records: 0, duplicates: 0, skipped: {}, errors: 0, unavailable: 0 };
  const say = (lvl, m) => { try { log[lvl]("[utilization] " + m); } catch {} };
  const stateOf = (id, at) => { let s = per.get(id); if (!s) { s = { nextAt: at + startDelayMs + 5e3 * (order++ % 12), failures: 0, unavailableUntil: 0, lastError: null }; per.set(id, s); } return s; };
  const wait = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
  let modeSaid = null;
  const mode = () => { try { return historyMode(setting()); } catch { return historyMode(undefined); } };
  const allowed = (m, id) => m.mode === "on" || (m.mode === "pilot" && m.ids.has(id));
  // Said once at the start and again whenever the setting changes.
  function sayMode(m) {
    const key = m.mode + (m.ids ? ":" + [...m.ids].sort().join(",") : "") + (m.invalid ? ":invalid" : "");
    if (key === modeSaid) return;
    modeSaid = key;
    say("log", m.mode === "off" ? `printer job history is not read${m.invalid ? " (utilization.readPrinterHistory in config.json is not true or a list of printer ids)" : ""}: off unless config.json utilization.readPrinterHistory turns it on`
      : m.mode === "on" ? "printer job history is read (config.json utilization.readPrinterHistory: true)"
      : `printer job history is read for ${m.ids.size} printer(s) only (config.json utilization.readPrinterHistory: ${[...m.ids].join(", ")})`);
  }

  // Once per poll, from beginTick: starts at most one pass, never waits for it.
  function tick(active, at = now()) {
    const m = mode();
    sayMode(m);
    if (m.mode === "off") return;
    if (stopped || inflight || at - lastRequestAt < minGapMs) return;
    let pick = null;
    for (const p of active || []) {
      if (!p || !p.id || !allowed(m, p.id)) continue;
      const s = stateOf(p.id, at);
      if (s.nextAt > at || s.unavailableUntil > at) continue;
      const kind = kindOf(p.id);
      if (kind == null || kind === "job" || kind === "paused" || kind === "offline") continue;
      const readHistory = historyFor(p);
      if (!readHistory) continue;
      if (!pick || s.nextAt < pick.s.nextAt) pick = { p, s, readHistory };
    }
    if (!pick) return;
    inflight = true;
    pass(pick.p, pick.s, pick.readHistory).catch(e => fail(pick.p, pick.s, e)).finally(() => { inflight = false; });
  }

  async function pass(p, s, readHistory) {
    stats.passes++;
    const startedAt = now();
    const st = store.historyState(p.id);
    const skewMs = estimateSkew(st && st.skewSamples, { pollMs });
    const sinceS = st && Number.isFinite(st.cursor) ? st.cursor - overlapS : (startedAt - skewMs - initialWindowMs) / 1000;
    const pages = [], ids = new Set();
    let more = false;
    for (let i = 0; i < maxPages; i++) {
      if (stopped) return;
      if (i) await wait(pageGapMs);
      // Turned off (or this printer taken out of a pilot) while a pass runs:
      // no further page; what was read is dropped and read again if it returns.
      if (stopped || !allowed(mode(), p.id)) return;
      lastRequestAt = now(); stats.requests++;
      const res = await readHistory({ since: sinceS, start: i * pageSize, limit: pageSize, order: "asc" });
      if (res && res.unavailable) {
        stats.unavailable++;
        s.unavailableUntil = now() + unavailableMs; s.nextAt = s.unavailableUntil;
        say("log", `${p.name || p.id}: no job history on this printer; checking again in ${Math.round(unavailableMs / 3600e3)} h`);
        return;
      }
      const jobs = (res && Array.isArray(res.jobs)) ? res.jobs : [];
      pages.push(jobs);
      const fresh = jobs.filter(j => recordKey(j) && !ids.has(recordKey(j)));
      for (const j of fresh) ids.add(recordKey(j));
      if (jobs.length < pageSize || !fresh.length) break;   // the last page, or a printer that ignores paging
      if (i === maxPages - 1) more = true;
    }
    const { jobs, duplicates } = collect(pages, { sinceS });
    stats.duplicates += duplicates;
    const records = [];
    let minInProgress = Infinity;
    const nowMs = now();
    for (const raw of jobs) {
      const r = normalizeRecord(raw, { nowMs, skewMs });
      if (r.record) records.push(r.record);
      else {
        stats.skipped[r.skip] = (stats.skipped[r.skip] || 0) + 1;
        if (r.skip === "in-progress" && Number.isFinite(r.startS)) minInProgress = Math.min(minInProgress, r.startS);
      }
    }
    linkNext(records);
    records.sort((a, b) => a.start - b.start);
    stats.records += records.length;
    // The cursor never passes a job still running: it is read again until done.
    let cursorTo = records.length ? Math.max(...records.map(r => r.startS)) : null;
    if (cursorTo != null && Number.isFinite(minInProgress)) cursorTo = Math.min(cursorTo, minInProgress - 1);
    for (let i = 0; i < records.length; i += recordsPerOp) {
      const last = i + recordsPerOp >= records.length;
      writer.enqueue({ type: "history", printerId: p.id, at: now(), records: records.slice(i, i + recordsPerOp), cursorTo: last ? cursorTo : null });
    }
    s.failures = 0; s.lastError = null;
    s.nextAt = startedAt + (more ? soonMs : intervalMs);
  }

  function fail(p, s, e) {
    stats.errors++;
    const delay = retryDelaysMs[Math.min(s.failures, retryDelaysMs.length - 1)];
    if (!s.failures) say("warn", `${p.name || p.id}: job history not read (${e && e.message}); trying again in ${Math.round(delay / 60e3)} min`);
    s.failures++; s.lastError = e && e.message;
    s.nextAt = now() + delay;
  }

  return {
    tick,
    // A job of this printer ended: read its history soon, for the outcome.
    markDue: (id, inMs = soonMs) => { const s = per.get(id); if (s) s.nextAt = Math.min(s.nextAt, now() + inMs); },
    stop: () => { stopped = true; },
    status: () => { const m = mode(); return { reading: m.mode, pilot: m.ids ? [...m.ids] : [], inflight, ...stats, printers: Object.fromEntries([...per].map(([id, s]) => [id, { ...s }])) }; },
  };
}

module.exports = { createHistorySync, historyMode };
