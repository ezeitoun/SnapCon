// test/utilization/history.test.js — a printer's history records made safe to
// use: what is refused and why, identity, paging, clock skew.
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRecord, collect, estimateSkew, recordKey } = require("../../utilization/history");

const NOW = 1_800_000_000_000;
const rec = (o = {}) => ({ job_id: "00000A", filename: "a.gcode", status: "completed", start_time: NOW / 1000 - 3600, end_time: NOW / 1000 - 600, print_duration: 2400, total_duration: 3000, ...o });

test("a finished record: times on SnapCon's clock, outcome from the printer, Phase 0's known share", () => {
  const { record } = normalizeRecord(rec(), { nowMs: NOW });
  assert.deepEqual([record.start, record.end, record.outcome, record.filename], [NOW - 3600e3, NOW - 600e3, "completed", "a.gcode"]);
  assert.equal(record.knownFraction, 2400 / 3000);
  assert.equal(record.historyId, "00000A@" + (NOW / 1000 - 3600));
});

test("outcomes: only what says how a job ended is final; interrupted and the unknown stay unknown, never completed", () => {
  const out = s => normalizeRecord(rec({ status: s }), { nowMs: NOW }).record.outcome;
  assert.deepEqual(["completed", "cancelled", "error", "klippy_shutdown", "interrupted", "klippy_disconnect", "server_exit", "something-new", ""].map(out),
    ["completed", "cancelled", "failed", "failed", "unknown", "unknown", "unknown", "unknown", "unknown"]);
});

test("refused, with the reason: no id, unfinished, broken or implausible times, the future", () => {
  const why = o => normalizeRecord(rec(o), { nowMs: NOW }).skip;
  assert.equal(why({ job_id: null }), "no-id");
  assert.equal(why({ job_id: "  " }), "no-id");
  assert.equal(why({ status: "in_progress", end_time: null }), "in-progress");
  assert.equal(why({ start_time: "yesterday" }), "bad-start");
  assert.equal(why({ start_time: 0 }), "bad-start");
  assert.equal(why({ end_time: null }), "bad-end");
  assert.equal(why({ end_time: NOW / 1000 - 3600 }), "empty");
  assert.equal(why({ end_time: NOW / 1000 - 4000 }), "empty");
  assert.equal(why({ start_time: NOW / 1000 - 10 * 86400 }), "implausible-span");
  assert.equal(why({ end_time: NOW / 1000 + 600 }), "future");
  assert.equal(normalizeRecord(null, { nowMs: NOW }).skip, "no-id");
  assert.ok(normalizeRecord(rec({ end_time: NOW / 1000 + 60 }), { nowMs: NOW }).record, "within the tolerance");
});

test("print_duration missing or larger than the span: known share 0, or capped at the whole span", () => {
  assert.equal(normalizeRecord(rec({ print_duration: undefined }), { nowMs: NOW }).record.knownFraction, 0);
  assert.equal(normalizeRecord(rec({ print_duration: 99999 }), { nowMs: NOW }).record.knownFraction, 1);
});

test("clock skew moves the printer's times onto SnapCon's clock, and can make a record 'future'", () => {
  const { record } = normalizeRecord(rec(), { nowMs: NOW, skewMs: 30e3 });
  assert.equal(record.start, NOW - 3600e3 + 30e3);
  assert.equal(normalizeRecord(rec({ end_time: NOW / 1000 + 100 }), { nowMs: NOW, skewMs: 60e3 }).skip, "future");
});

test("identity is the job id with its start: a reset printer reusing ids is not mistaken for the old jobs", () => {
  assert.notEqual(recordKey(rec()), recordKey(rec({ start_time: NOW / 1000 - 7200 })));
  assert.equal(recordKey(rec()), recordKey({ ...rec(), status: "cancelled" }));
  assert.equal(recordKey({ job_id: "" }), null);
});

test("pages into one list: each job once, and only from `since` on, whatever the printer filtered", () => {
  const a = rec({ job_id: "1", start_time: 1000 }), b = rec({ job_id: "2", start_time: 2000 }), c = rec({ job_id: "3", start_time: 3000 });
  const { jobs, duplicates } = collect([[a, b], [b, c], [c]], { sinceS: 1500 });
  assert.deepEqual(jobs.map(j => j.job_id), ["2", "3"]);
  assert.equal(duplicates, 2);
});

test("skew from jobs both saw: the smallest lag of three or more; too few or too scattered, none", () => {
  assert.equal(estimateSkew([5e3, 12e3, 20e3]), 5e3);
  assert.equal(estimateSkew([5e3, 12e3]), 0);
  assert.equal(estimateSkew([5e3, 12e3, 300e3]), 0, "scattered: not one offset");
  assert.equal(estimateSkew([500e3, 510e3, 520e3]), 120e3, "capped");
  assert.equal(estimateSkew([-40e3, -30e3, -20e3]), -40e3);
});
