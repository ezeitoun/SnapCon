// test/jobRetention.test.js — a finished upload/print job is kept for ten
// minutes after it finished, not after it was created (docs/TODO.md §37 P0-3).
//
// Before: the sweep deleted `job.done && job.ts < now - 10 min`, and job.ts is
// the creation time. A job that ran longer than ten minutes (a slow upload,
// Creality leveling, mapping) was deleted within a minute of finishing, so a
// tab polling it late (timers slowed in a background tab) got 404 and showed
// "No such job" for a job that had succeeded.
//
// The sweep is taken from server.js and run with a fake clock.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const MIN = 60 * 1000;

function harness() {
  const env = { Map, JOBS: new Map() };
  vm.createContext(env);
  const at = serverSrc.indexOf("const JOB_MAX_AGE");
  assert.ok(at > 0);
  const fnAt = serverSrc.indexOf("function sweepFinishedJobs(", at);
  assert.ok(fnAt > 0, "the sweep is a function the interval calls");
  vm.runInContext(serverSrc.slice(at, serverSrc.indexOf("\n", at)), env);
  vm.runInContext(serverSrc.slice(fnAt, serverSrc.indexOf("\n}\n", fnAt) + 3), env);
  // The interval, every minute, as server.js runs it.
  const sweepsUntil = (from, to) => { for (let now = from; now <= to; now += MIN) env.sweepFinishedJobs(now); };
  return { jobs: env.JOBS, sweepsUntil };
}

test("a job that ran longer than ten minutes is kept for ten minutes after it finished", () => {
  const h = harness();
  const created = 0;
  const job = { done: false, ts: created };
  h.jobs.set("j1", job);
  h.sweepsUntil(created, 30 * MIN);           // a 30-minute job, still running
  assert.ok(h.jobs.has("j1"), "never removed while running");
  job.done = true;                            // finishes at minute 30
  h.sweepsUntil(31 * MIN, 39 * MIN);
  assert.ok(h.jobs.has("j1"), "still there 9 minutes after it finished (deleted at 31 before the fix)");
  h.sweepsUntil(40 * MIN, 42 * MIN);
  assert.ok(!h.jobs.has("j1"), "gone a little over ten minutes after it finished");
});

test("a short job is kept for ten minutes after it finished too", () => {
  const h = harness();
  h.jobs.set("j1", { done: true, ts: 0 });
  h.sweepsUntil(1 * MIN, 10 * MIN);
  assert.ok(h.jobs.has("j1"));
  h.sweepsUntil(11 * MIN, 12 * MIN);
  assert.ok(!h.jobs.has("j1"));
});

test("an unfinished job is never removed, however old", () => {
  const h = harness();
  h.jobs.set("j1", { done: false, ts: 0 });
  h.sweepsUntil(0, 600 * MIN);
  assert.ok(h.jobs.has("j1"));
});

test("a running upload keeps its job, its progress and its Cancel through any number of sweeps", () => {
  const h = harness();
  let cancelled = 0;
  const job = { done: false, ts: 0, phase: "upload", sent: 10, total: 100, cancelUpload: () => { cancelled++; } };
  h.jobs.set("j1", job);
  h.sweepsUntil(0, 120 * MIN);
  assert.equal(h.jobs.get("j1"), job, "the same object, still there");
  assert.equal(job.doneSeenAt, undefined, "a running job is not marked");
  assert.equal(typeof job.cancelUpload, "function", "Cancel is still armed");
  h.jobs.get("j1").cancelUpload();
  assert.equal(cancelled, 1);
  // Cancelled and finished: kept for ten minutes like any other finished job.
  job.done = true; job.phase = "error"; job.cancelled = true;
  h.sweepsUntil(121 * MIN, 130 * MIN);
  assert.ok(h.jobs.has("j1"));
  h.sweepsUntil(131 * MIN, 132 * MIN);
  assert.ok(!h.jobs.has("j1"));
});

// §37 P1: reading a finished job no longer removes it 5 s later, so its
// result is there for a second tab, or a tab that lost its connection, for the
// whole retention period (test/printUploadOutcome.test.js).
test("the sweep runs every minute, and is the only thing that removes a finished job", () => {
  assert.match(serverSrc, /setInterval\(\(\) => sweepFinishedJobs\(Date\.now\(\)\), 60 \* 1000\)\.unref\(\);/);
  assert.doesNotMatch(serverSrc, /if \(job\.done\) setTimeout\(\(\) => JOBS\.delete\(req\.query\.job\), 5000\);/);
});
