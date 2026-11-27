// utilization/history.js — a printer's job-history records made safe to use
// (fleet utilization, Phase 2). Pure: no I/O, no clock of its own.
//
// What is refused, with the reason counted (never guessed around):
//   no-id             no job id: it could not be applied once and only once;
//   in-progress       not finished: read again at a later pass;
//   bad-start/bad-end a time that is not a number, zero or negative;
//   empty             ends where it starts (or before);
//   implausible-span  longer than `maxSpanMs` (a corrupt or reset clock);
//   future            ends after now (with the skew applied), beyond `futureToleranceMs`.
// Times are the printer's (UNIX seconds); `skewMs` (SnapCon minus printer, as
// estimated from jobs both saw) moves them onto SnapCon's clock.
"use strict";
const { moonrakerOutcome, backfilledJob } = require("./classify");

const DAY = 86400e3;

// A record's identity: the printer's job id with its start time. Unique even
// where the printer's history was reset and ids start again from 000001; the
// same record read twice (paging, a later pass) has the same identity.
const recordKey = j => (j && j.job_id != null && String(j.job_id).trim() ? `${String(j.job_id).trim()}@${Number(j.start_time)}` : null);

function normalizeRecord(raw, { nowMs, skewMs = 0, maxSpanMs = 7 * DAY, futureToleranceMs = 120e3 } = {}) {
  if (!raw || typeof raw !== "object") return { skip: "no-id" };
  const jid = raw.job_id == null ? "" : String(raw.job_id).trim();
  if (!jid) return { skip: "no-id" };
  const status = typeof raw.status === "string" ? raw.status : "";
  const outcome = moonrakerOutcome(status);
  if (outcome === "running") return { skip: "in-progress", startS: Number(raw.start_time) };
  const s = Number(raw.start_time), e = Number(raw.end_time);
  if (!Number.isFinite(s) || s <= 0) return { skip: "bad-start" };
  if (!Number.isFinite(e) || e <= 0) return { skip: "bad-end" };
  if (e <= s) return { skip: "empty" };
  if ((e - s) * 1000 > maxSpanMs) return { skip: "implausible-span" };
  const start = Math.round(s * 1000 + skewMs), end = Math.round(e * 1000 + skewMs);
  if (end > nowMs + futureToleranceMs) return { skip: "future" };
  const id = recordKey(raw);
  const b = backfilledJob(raw);                      // Phase 0: the estimate's known share
  return {
    record: {
      historyId: id, filename: typeof raw.filename === "string" && raw.filename ? raw.filename : null,
      status, outcome, start, end, startS: s,
      knownFraction: b ? b.knownFraction : 0,
      printMs: Number.isFinite(raw.print_duration) && raw.print_duration >= 0 ? raw.print_duration * 1000 : null,
    },
  };
}

// Many pages into one list: each job (id and start) once, the first seen; only those
// starting at or after `sinceS` (printer clock), whatever the printer filtered.
function collect(pages, { sinceS = -Infinity } = {}) {
  const seen = new Set(), out = [];
  let duplicates = 0;
  for (const page of pages) for (const j of page) {
    const id = recordKey(j);
    if (id && seen.has(id)) { duplicates++; continue; }
    if (id) seen.add(id);
    const st = Number(j && j.start_time);
    if (Number.isFinite(st) && st < sinceS) continue;
    out.push(j);
  }
  return { jobs: out, duplicates };
}

// SnapCon-minus-printer clock difference, from jobs both saw. SnapCon sees a
// job start up to one poll late, so each sample is skew plus a lag in
// [0, poll); the smallest of several is the best estimate of the skew itself.
// Fewer than three samples, or a spread wider than plausible: no estimate (0).
function estimateSkew(samples, { pollMs = 30e3, maxSkewMs = 120e3 } = {}) {
  const v = (samples || []).filter(Number.isFinite);
  if (v.length < 3) return 0;
  const lo = Math.min(...v), hi = Math.max(...v);
  if (hi - lo > pollMs * 2) return 0;
  return Math.max(-maxSkewMs, Math.min(maxSkewMs, lo));
}

// Records of one printer, in start order, each told which record came next:
// the evidence that an ending SnapCon saw belonged to a later job (reconcile.js).
function linkNext(records) {
  const sorted = [...records].sort((a, b) => a.start - b.start);
  sorted.forEach((r, i) => { const n = sorted[i + 1]; r.next = n ? { start: n.start, end: n.end, historyId: n.historyId } : null; });
  return sorted;
}

module.exports = { normalizeRecord, collect, estimateSkew, recordKey, linkNext };
