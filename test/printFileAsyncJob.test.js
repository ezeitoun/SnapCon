// test/printFileAsyncJob.test.js — /api/printfile must hand back a job id and
// do the slow work detached (docs/TODO.md item 9a).
//
// The route awaited applyHeadMapping (G29 — bounded at TWELVE MINUTES on
// Creality) and then startPrintFile before responding, so the browser sat on
// "Starting print…" for the whole physical operation and a V3 Plus produced
// "did not respond within 60000ms" for a print that had actually started.
//
// /api/print already solved this: allocate a jobId, respond immediately, run
// upload/mapping/starting in a detached IIFE writing job.phase as it goes, and
// let the client poll /api/print-status. This converts /api/printfile onto that
// same machinery rather than inventing a second one.
//
// Why the detached work is a named function rather than an inline IIFE: it is
// the only way to test the phase progression and the success bookkeeping
// without an express harness, which this project does not have (the same
// constraint test/fleet-eject.test.js documents). It is extracted from
// server.js and run against stubbed collaborators.
//
// The bookkeeping assertions matter more than they look: clearing the "Loaded"
// badge, marking ROUTE_STARTED_PRINT (which suppresses notifyTick's duplicate
// print-started notification) and writing the audit row all used to happen on
// the request thread. Moved into the background path they must still fire
// exactly once, and a FAILED job must not leave an audit trail claiming a print
// started.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

function extractFn(name) {
  const start = serverSrc.indexOf("async function " + name + "(");
  assert.ok(start > 0, name + " must exist in server.js");
  return serverSrc.slice(start, serverSrc.indexOf("\n}", start) + 2);
}

const P = { id: "p20", name: "Creality SPARKX i7", url: "http://192.168.4.240:7125" };
const FILE = "Beardie (7h35m).gcode";

// A harness whose connector calls can be held open on demand, so a phase can be
// observed while the underlying operation is still pending.
function harness({ mapFails = false, startFails = false, hold = false } = {}) {
  // release() opens the gate PERMANENTLY: startPrintFile calls gate() again
  // after applyHeadMapping, and a one-shot deferred would leave that second
  // call pending forever.
  let open = !hold;
  const waiters = [];
  const deferred = { release: () => { open = true; waiters.splice(0).forEach(r => r()); } };
  const gate = () => open ? Promise.resolve() : new Promise(r => waiters.push(r));
  const calls = [];
  const env = {
    console: { log() {} },
    queuedFile: new Map([["20", { name: FILE, status: "ready", ts: 1 }]]),
    saveQueuedFiles: () => calls.push("saveQueuedFiles"),
    ROUTE_STARTED_PRINT: new Set(),
    auditLog: { log: e => calls.push("audit:" + e.event) }
  };
  vm.createContext(env);
  vm.runInContext(extractFn("runPrintFileJob"), env);

  const c = {
    applyHeadMapping: async () => { calls.push("applyHeadMapping"); await gate(); if (mapFails) throw new Error("G29 failed"); },
    startPrintFile: async () => { calls.push("startPrintFile"); await gate(); if (startFails) throw new Error("printer refused"); }
  };
  const job = { phase: "mapping", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now() };
  return { env, c, job, calls, deferred };
}

const run = (h, opts = {}) => h.env.runPrintFileJob({
  p: P, c: h.c, filename: FILE, tools: opts.tools || [], map: opts.map || {}, prefs: {},
  actor: { userId: "u1", userLabel: "alice" }, needsMapping: opts.needsMapping !== false,
  job: h.job, printerKey: "20"
});

test("the slow work runs detached — the job is still pending while mapping is in flight", async () => {
  const h = harness({ hold: true });
  const promise = run(h);
  await new Promise(r => setImmediate(r));
  assert.equal(h.job.done, false, "the caller must be able to respond before this finishes");
  assert.equal(h.job.phase, "mapping", "the in-flight phase must be observable via /api/print-status");
  h.deferred.release();
  await promise;
});

test("mapping then starting are both observable as phases", async () => {
  const h = harness();
  await run(h);
  assert.deepEqual(h.calls.filter(c => c === "applyHeadMapping" || c === "startPrintFile"),
    ["applyHeadMapping", "startPrintFile"], "mapping must still precede the start");
  assert.equal(h.job.phase, "done");
});

test("a successful job reaches done with a result", async () => {
  const h = harness();
  await run(h, { tools: [0, 1] });
  assert.equal(h.job.done, true);
  assert.equal(h.job.error, null);
  assert.equal(h.job.phase, "done");
  // Field-by-field rather than deepEqual: the result object is created inside
  // the vm sandbox, so it has that realm's Object prototype and is never
  // reference-equal to one built here.
  assert.equal(h.job.result.printer, P.name);
  assert.equal(h.job.result.filename, FILE);
  assert.equal(h.job.result.mapped, 2);
});

test("success bookkeeping happens exactly once", async () => {
  const h = harness();
  await run(h);
  assert.equal(h.calls.filter(c => c === "audit:print-started").length, 1);
  assert.equal(h.calls.filter(c => c === "saveQueuedFiles").length, 1);
  assert.equal(h.env.queuedFile.has("20"), false, "printing the staged file clears the Loaded badge");
  assert.ok(h.env.ROUTE_STARTED_PRINT.has(P.url), "suppresses notifyTick's duplicate print-started");
});

test("a mapping failure becomes job.error and never reports a start", async () => {
  const h = harness({ mapFails: true });
  await run(h);
  assert.equal(h.job.done, true);
  assert.equal(h.job.phase, "error");
  assert.match(h.job.error, /G29 failed/);
  assert.equal(h.calls.includes("startPrintFile"), false, "the print must not be started after mapping failed");
});

test("a start failure becomes job.error", async () => {
  const h = harness({ startFails: true });
  await run(h);
  assert.equal(h.job.phase, "error");
  assert.match(h.job.error, /printer refused/);
});

test("a failed job leaves no bookkeeping — no audit row, no badge clear", async () => {
  const h = harness({ startFails: true });
  await run(h);
  assert.equal(h.calls.some(c => c.startsWith("audit:")), false,
    "an audit trail claiming a print started would be a lie");
  assert.equal(h.env.ROUTE_STARTED_PRINT.size, 0);
  assert.equal(h.env.queuedFile.has("20"), true, "the staged file is still staged — nothing printed it");
});

test("no mapping requested skips straight to starting", async () => {
  const h = harness();
  await run(h, { needsMapping: false });
  assert.equal(h.calls.includes("applyHeadMapping"), false);
  assert.equal(h.job.phase, "done");
});

// The specific reason 9a exists: a connector call can stay pending far longer
// than any client-side HTTP timeout without the route itself timing out,
// because the route already returned.
test("a connector call outliving a client HTTP timeout does not fail the job", async () => {
  const h = harness({ hold: true });
  const promise = run(h);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(h.job.done, false, "still working long after a client would have given up");
  assert.equal(h.job.error, null, "and it must not have been failed on the client's behalf");
  h.deferred.release();
  await promise;
  assert.equal(h.job.phase, "done", "the print still completes normally afterwards");
});

// ---- the route itself ----
test("the route responds with a jobId BEFORE the detached work is awaited", () => {
  const i = serverSrc.indexOf('app.post("/api/printfile"');
  assert.ok(i > 0, "route must exist");
  const route = serverSrc.slice(i, serverSrc.indexOf("\n});", i));
  assert.match(route, /res\.json\(\{[^}]*jobId/, "the response must carry a jobId");
  const resAt = route.indexOf("jobId");
  const runAt = route.indexOf("runPrintFileJob(");
  assert.ok(resAt > 0 && runAt > 0, "route must respond and then kick off the job");
  assert.ok(route.indexOf("res.json") < runAt, "responding must come BEFORE starting the slow work");
  assert.doesNotMatch(route, /await\s+runPrintFileJob/, "awaiting it would reintroduce the block");
  assert.doesNotMatch(route, /await\s+c\.applyHeadMapping|await\s+c\.startPrintFile/,
    "the connector calls must no longer run on the request thread");
});

test("the route keeps its cheap synchronous guards before accepting a job", () => {
  const i = serverSrc.indexOf('app.post("/api/printfile"');
  const route = serverSrc.slice(i, serverSrc.indexOf("\n});", i));
  for (const guard of ["printerVisibleTo", "maintenanceMode", "Bad filename", "Unknown printer"]) {
    assert.ok(route.includes(guard), guard + " must still be checked before a job is accepted");
  }
  const jobAt = route.indexOf("newJobId()");
  assert.ok(jobAt > 0, "the route must allocate a job id");
  for (const guard of ["printerVisibleTo", "maintenanceMode"]) {
    assert.ok(route.indexOf(guard) < jobAt, guard + " must be rejected outright, not via a job");
  }
});

// ---- frontend: neither caller may treat HTTP 200 as "printing" ----
test("the card Print button polls the job instead of trusting the response", () => {
  const i = appSrc.indexOf('postJSON("/api/printfile"');
  assert.ok(i > 0, "card print path must exist");
  const block = appSrc.slice(i - 400, i + 1200);
  assert.match(block, /pollJob\(/, "must hand off to the shared job poller");
  assert.match(block, /fleet\.queued\.printing_status/,
    "9a converts sync->async only; this path's original success wording must survive");
});

test("the Printer Files modal polls the job too", () => {
  const first = appSrc.indexOf('postJSON("/api/printfile"');
  const i = appSrc.indexOf('postJSON("/api/printfile"', first + 1);
  assert.ok(i > 0, "printer-files modal print path must exist");
  const block = appSrc.slice(i - 400, i + 1200);
  assert.match(block, /pollJob\(/, "must hand off to the shared job poller");
});

test("pollJob understands the phases this route emits, including a future preparing phase", () => {
  const i = appSrc.indexOf("async function pollJob(");
  const fn = appSrc.slice(i, appSrc.indexOf("\n}", i));
  for (const phase of ["mapping", "starting", "preparing"]) {
    assert.ok(fn.includes('"' + phase + '"'), "pollJob must handle the " + phase + " phase");
  }
});

// ---- guard rails: the paths 9a must NOT touch ----
test("/api/print keeps its own existing async shape", () => {
  const i = serverSrc.indexOf('app.post("/api/print"');
  const route = serverSrc.slice(i, serverSrc.indexOf("\n});", i));
  assert.match(route, /res\.json\(\{ jobId \}\)/, "/api/print must be left exactly as it was");
});

test("queue dispatch still awaits its connector calls directly", () => {
  const i = serverSrc.indexOf("async function attemptQueueDispatch(");
  const fn = serverSrc.slice(i, serverSrc.indexOf("\n}\n", i));
  assert.match(fn, /await c\.startPrintFile/,
    "the queue is already detached at its own call sites and owns its lifecycle — untouched by 9a");
});
