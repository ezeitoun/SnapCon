// test/queueDispatchUpload.test.js — a queue dispatch's upload is seen and can
// be cancelled like any other, and the queue and manual sends never overlap
// on one printer (TODO §28).
//
// Before: attemptQueueDispatch uploaded through a throwaway progress object
// that was not in JOBS, so no tab saw the upload and nobody could cancel it;
// "Is this printer idle?" did not know the queue was sending to it, so a
// manual Print could go to the same printer; the queue claimed a printer a
// manual send was still uploading to; and Clear during the upload sent a
// print cancel to an idle printer while the upload went on and the print
// started anyway.
//
// attemptQueueDispatch, isPrinterIdle, activeUploadFor and the
// /api/print-cancel and Clear routes are taken from server.js and run against
// the real QueueStore/QueueEngine. The connector is a stand-in whose upload
// arms and clears job.cancelUpload the way connectors/http-utils.js does.
const test = require("node:test");
const { routeEnd } = require("./helpers/routeEnd");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const { loadUploadOutcomeHelpers } = require("./helpers/uploadOutcomeHelpers");
const { createQueueStore } = require("../queue/QueueStore");
const QueueEngine = require("../queue/QueueEngine");
const { isPathWithinFolder, resolveWithinFolder } = require("../pathSafety");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const strip = s => s.replace(/\/\/[^\n]*/g, "");

class LibraryError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const FOLDER = path.resolve(os.tmpdir(), "snapcon-dispatch-upload-gcode");
const FILE = path.join(FOLDER, "Beardie.gcode");

const tick = () => new Promise(r => setImmediate(r));
async function until(fn, what) {
  for (let i = 0; i < 500; i++) { if (fn()) return; await tick(); }
  assert.fail("timed out waiting for " + what);
}
// A dispatch that should not claim returns; one that wrongly claims would
// wait forever on the stand-in upload, so stop at whichever comes first.
const settled = (h, run = h.dispatch()) => Promise.race([run, until(() => h.uploads.length, "").catch(() => {})]);
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };

function loadFn(env, marker) {
  const at = serverSrc.indexOf(marker);
  if (at < 0) return false;
  const end = serverSrc.slice(at).search(/\r?\n\}\r?\n/);
  vm.runInContext(serverSrc.slice(at, at + end + 3), env);
  return true;
}
function loadRoute(env, marker) {
  const at = serverSrc.indexOf(marker);
  assert.ok(at > 0, marker);
  vm.runInContext(serverSrc.slice(at, routeEnd(serverSrc, at) + 4), env);
}

function harness(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-dispatch-upload-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const netfs = {
    availability: () => ({ status: "online" }),
    exists: async p => p === FOLDER || p === FILE,
    realpath: async p => p,
    stat: async () => ({ size: 100, mtimeMs: 1 }),
    // The source's identity (§37 A4): unchanged unless a test moves it.
    identity: async p => { if (p !== FILE) throw Object.assign(new Error("ENOENT: " + p), { code: "ENOENT" }); return { ...h.sourceId }; },
  };
  const queueStore = createQueueStore({ baseDir: base, fileIO: {
    stat: async () => ({ size: 100, mtimeMs: 1 }),
    hashFile: async () => { if (h.hashGate) await h.hashGate.p; return { sizeBytes: 100, sha256: "h" }; },
  } });
  const printer = { id: "pr1", name: "U1", url: "http://u1", printerPoolId: "pool", connector: "x" };
  const h = { sourceId: { size: 100, mtimeMs: 1, mtimeNs: "1000000", ctimeNs: "1000000", ino: "7", dev: "1" }, hashGate: null, started: [], cancels: 0, uploads: [], audits: [], plan: "upload", mapping: false, mappingGate: null, startGate: null, probeGate: null };
  // Mirrors connectors/http-utils.js sendMultipartUpload: cancelling while
  // bytes go out cuts the transfer; after the last byte (lastByte) a cancel
  // only sets job.cancelRequested and the printer's answer still settles it;
  // once it has answered (finish) there is nothing to cancel.
  const conn = {
    uploadFile: (p, fp, name, job) => new Promise((resolve, reject) => {
      job.total = 100; job.sent = 40;
      h.lastJob = job;
      job.cancelUpload = () => { job.cancelRequested = true; job.cancelUpload = null; const e = new Error("Upload cancelled"); e.code = "UPLOAD_CANCELLED"; e.outcome = "failed"; reject(e); };
      h.uploads.push({
        lastByte: () => { job.sent = 100; job.confirmingSince = Date.now(); job.cancelUpload = () => { job.cancelRequested = true; job.cancelUpload = null; }; },
        finish: () => { job.cancelUpload = null; job.sent = 100; resolve(); },
        fail: code => { job.cancelUpload = null; const e = new Error("socket hang up"); e.code = code; e.outcome = "failed"; reject(e); },
        failWith: e => { job.cancelUpload = null; reject(e); },
      });
    }),
    applyHeadMapping: async () => { if (h.mappingGate) await h.mappingGate.p; },
    // The read-back (§37 P2): verified unless a test sets h.verify.
    verifyUpload: async () => { h.verifyCalls = (h.verifyCalls || 0) + 1; return typeof h.verify === "function" ? h.verify() : h.verify || { result: "verified", evidence: "the test printer has it" }; },
    startPrintFile: async (p, name) => { if (h.startGate) await h.startGate.p; h.started.push(name); },
    cancel: async () => { h.cancels++; },
  };
  const routes = {};
  const env = {
    console: { log() {}, error() {} }, path, Date, Error, Math, String, Object, Number, Array, LibraryError, QueueEngine, isPathWithinFolder, resolveWithinFolder, CFG: {},
    PRINTERS: [printer], pendingLoad: new Map(), queuedFile: new Map(), JOBS: new Map(), STARTING: new Map(), FOLDER, GCODE_ROOT: "gcode",
    DISPATCH_IDLE_STATES: new Set(["standby", "idle", "complete", "cancelled"]),
    probeCached: async () => { const g = h.probeGate; if (g) await g.p; return { online: true, state: "standby" }; },
    firmwareUpdating: () => false,
    safePath: sub => resolveWithinFolder(sub, FOLDER), fileExists: p => netfs.exists(p), netfs, queueStore,
    library: { available: true, rescan: async () => {}, locateContent: () => [], printLocation: () => { throw new Error("no Library roots here"); }, recordPrintStart: () => {} },
    getConnector: () => conn,
    assertNotActiveJobFile: async () => {}, decideUpload: async () => ({ action: h.plan }), whileUploading: fn => fn(),
    printerHasAnyDefaultPref: () => h.mapping, wantsAnyPref: () => false, ROUTE_STARTED_PRINT: new Set(),
    auditLog: { log: e => { h.audits.push(e.event); return 1; } }, libraryAudit: x => x,
    printerVisibleTo: () => true, printerById: id => [printer].find(p => p.id === id), redactQueueStateForResponse: s => s,
    requireRegular: () => {}, app: { post: (route, ...handlers) => { routes[route] = handlers[handlers.length - 1]; } },
  };
  vm.createContext(env);
  vm.runInContext("const relOf = ref => path.relative(ref.dir, ref.fp).split(path.sep).join('/');", env);
  vm.runInContext("const ROOT_DOWN = new Map(); let jobN = 0; const newJobId = () => 'j' + (++jobN);", env);
  // §37 P1: the upload-outcome helpers (absent before it).
  try { loadUploadOutcomeHelpers(env, serverSrc); } catch {}
  for (const name of ["async function resolveFileRef(", "async function locationAnswers(", "function noteRootDown(", "async function relocateQueuedFile(",
    "async function attemptQueueDispatch(", "async function withStartSequence(", "async function isPrinterIdle(", "function activeUploadFor(", "function actorFromReq("]) {
    assert.ok(loadFn(env, name), name);
  }
  // The §28 helpers: absent before the change, which is part of what fails.
  for (const name of ["function queueDispatchJob(", "function otherSendInFlight(", "function queueStillDispatching("]) loadFn(env, name);
  loadRoute(env, 'app.post("/api/print-cancel"');
  // Clear takes its turn in the per-printer decision chain (§36).
  vm.runInContext("const QUEUE_DECISIONS = new Map();", env);
  for (const name of ["function serializeQueueDecision(", "function sameQueueDecisionItem("]) assert.ok(loadFn(env, name), name);
  loadRoute(env, 'app.post("/api/queue/:printerId/clear"');
  queueStore.assignPool("pr1");
  queueStore.applyIntent("pr1", s => ({ ...s, queue: [{ id: "qi_1", status: "queued", alreadyUploaded: false, file: { name: "Beardie.gcode", sub: "", sizeBytes: 100, sha256: "h" },
    map: {}, prefs: {}, createdAt: 1, dispatchedAt: null, finishedAt: null, queuedBy: null, retryOfItemId: null, dispatchSnapshot: null }] }));
  const call = async (route, req) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[route](req, res);
    return res;
  };
  const user = { id: "u1", firstName: "Eran", lastName: "Z", role: "regular" };
  return Object.assign(h, {
    env, printer,
    state: () => queueStore.getPrinterState("pr1"),
    dispatch: () => env.attemptQueueDispatch("pr1"),
    upload: () => env.activeUploadFor("pr1"),
    cancelUpload: (job, u = user) => call("/api/print-cancel", { body: { job }, user: u }),
    // Naming the job shown, as the page does.
    clear: () => { const cur = queueStore.getPrinterState("pr1").currentItem; return call("/api/queue/:printerId/clear", { params: { printerId: "pr1" }, body: { itemId: cur ? cur.id : null }, user }); },
  });
}

// ---- seen like any other upload ----

test("a queue upload is on the printer's fleet row while its bytes go out, and gone after", async t => {
  const h = harness(t);
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload to start");
  const up = h.upload();
  assert.ok(up, "every tab's card gets the strip from the row");
  assert.equal(up.file, "Beardie.gcode");
  assert.equal(up.sent, 40);
  assert.equal(up.total, 100);
  assert.equal(up.cancellable, true);
  h.uploads[0].finish();
  await run;
  assert.equal(h.upload(), null);
  assert.deepEqual(h.started, ["Beardie.gcode"]);
  assert.equal(h.state().queueState, "printing");
});

test("cancelling mid-upload: the item waits for a person (dispatch-failed, upload-cancelled, by whom), nothing starts, nothing retries", async t => {
  const h = harness(t);
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload to start");
  const res = await h.cancelUpload(h.upload().jobId);
  assert.equal(res.code, 200);
  await run;
  const s = h.state();
  assert.equal(s.queueState, "queue_attention_required");
  assert.equal(s.attentionReason, "dispatch-failed", "Retry, Skip and Stop, as for any dispatch failure");
  assert.equal(s.attentionDetail.code, "upload-cancelled");
  assert.match(s.attentionDetail.message, /Eran Z/);
  assert.match(s.attentionDetail.message, /Beardie\.gcode/);
  assert.equal(s.currentItem.id, "qi_1", "the item is kept");
  assert.deepEqual(h.started, []);
  assert.equal(h.cancels, 0, "no print cancel is sent to the printer");
  assert.equal(h.upload(), null);
  await h.dispatch();
  assert.equal(h.uploads.length, 1, "not dispatched again by itself");
  assert.deepEqual(h.started, []);
});

test("cancelled with sign-in off: the message just says it was cancelled", async t => {
  const h = harness(t);
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload to start");
  await h.cancelUpload(h.upload().jobId, { implicit: true, role: "admin" });
  await run;
  assert.equal(h.state().attentionDetail.code, "upload-cancelled");
  assert.doesNotMatch(h.state().attentionDetail.message, / by /);
  assert.match(h.state().attentionDetail.message, /Beardie\.gcode/);
});

test("Cancel once the printer has answered is refused, and the print starts", async t => {
  const h = harness(t);
  h.mapping = true;
  h.mappingGate = gate();
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload to start");
  const jobId = h.upload().jobId;
  h.uploads[0].finish();
  await until(() => h.env.STARTING.has("pr1"), "the start sequence");
  const res = await h.cancelUpload(jobId);
  assert.equal(res.code, 409);
  h.mappingGate.open();
  await run;
  assert.deepEqual(h.started, ["Beardie.gcode"]);
  assert.equal(h.state().queueState, "printing");
});

test("an upload that fails on the network is a dispatch failure, as before, and the strip goes", async t => {
  const h = harness(t);
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload to start");
  h.uploads[0].fail("ECONNRESET");
  await run;
  assert.equal(h.state().attentionReason, "dispatch-failed");
  assert.equal(h.state().attentionDetail.code, "dispatch-error");
  assert.equal(h.upload(), null);
  assert.ok([...h.env.JOBS.values()].every(j => j.done), "no record left running");
});

// ---- Clear ----

test("Clear during the upload stops it; the print is not started and no print cancel is sent", async t => {
  const h = harness(t);
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload to start");
  const res = await h.clear();
  assert.equal(res.code, 200);
  h.uploads[0].finish();   // what an upload Clear did not stop would do next
  await run;
  assert.deepEqual(h.started, []);
  assert.equal(h.cancels, 0);
  const s = h.state();
  assert.equal(s.queueState, "idle");
  assert.equal(s.currentItem, null);
  assert.equal(s.recentHistory.at(-1).status, "cancelled");
  assert.equal(h.upload(), null);
});

test("Clear while the file is still being checked: nothing is sent", async t => {
  const h = harness(t);
  h.hashGate = gate();
  const run = h.dispatch();
  await until(() => h.state().queueState === "dispatching", "the claim");
  assert.equal((await h.clear()).code, 200);
  assert.equal(h.cancels, 0);
  h.hashGate.open();
  await settled(h, run);
  assert.equal(h.uploads.length, 0);
  assert.deepEqual(h.started, []);
  assert.equal(h.state().queueState, "idle");
});

test("Clear after the last byte, before the start: the print is not started", async t => {
  const h = harness(t);
  h.mapping = true;
  h.mappingGate = gate();
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload to start");
  h.uploads[0].finish();
  await until(() => h.env.STARTING.has("pr1"), "the start sequence");
  assert.equal((await h.clear()).code, 200);
  h.mappingGate.open();
  await run;
  assert.deepEqual(h.started, []);
  assert.equal(h.cancels, 0, "nothing was printing, so nothing to cancel");
  assert.equal(h.state().queueState, "idle");
});

test("Clear once the start has been sent cancels the print as before, and the dispatch then records nothing", async t => {
  const h = harness(t);
  h.startGate = gate();
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload to start");
  h.uploads[0].finish();
  await until(() => h.env.STARTING.has("pr1"), "the start sequence");
  await tick();
  assert.equal((await h.clear()).code, 200);
  assert.equal(h.cancels, 1);
  h.startGate.open();
  await run;   // must not throw
  assert.equal(h.state().queueState, "idle", "Clear's result stands");
  assert.ok(!h.audits.includes("queue-print-started"));
});

// ---- one sender at a time ----

test("the queue does not claim a printer a manual send is still uploading to", async t => {
  const h = harness(t);
  h.env.JOBS.set("jm", { phase: "upload", sent: 0, total: 0, done: false, ts: 1, printerId: "pr1", file: "Other.gcode" });
  await settled(h);
  assert.equal(h.state().queueState, "idle");
  assert.deepEqual(h.state().queue.map(i => i.id), ["qi_1"]);
  assert.equal(h.uploads.length, 0);
  h.env.JOBS.get("jm").done = true;
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload once the manual send is done");
  h.uploads[0].finish();
  await run;
});

test("the queue does not claim a printer a deferred file is going out to", async t => {
  const h = harness(t);
  h.env.queuedFile.set("pr1", { name: "Other.gcode", status: "uploading", ts: 1 });
  await settled(h);
  assert.equal(h.state().queueState, "idle");
  assert.equal(h.uploads.length, 0);
});

test("a manual send that begins while the queue is checking the printer wins; the queue does not claim", async t => {
  const h = harness(t);
  h.probeGate = gate();
  const run = h.dispatch();
  await tick();
  // The queue is waiting for its probe; a manual Print registers its job.
  h.env.JOBS.set("jm", { phase: "upload", sent: 0, total: 0, done: false, ts: 1, printerId: "pr1", file: "Other.gcode" });
  h.probeGate.open(); h.probeGate = null;
  await settled(h, run);
  assert.equal(h.state().queueState, "idle");
  assert.equal(h.uploads.length, 0);
});

test("while the queue sends to a printer it is not idle, for every manual path that asks", async t => {
  const h = harness(t);
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload to start");
  assert.equal(await h.env.isPrinterIdle(h.printer), false);
  h.uploads[0].finish();
  await run;
});

test("a manual idle check already waiting on its probe when the queue claims answers not idle", async t => {
  const h = harness(t);
  h.probeGate = gate();
  const manual = h.env.isPrinterIdle(h.printer);
  await tick();
  const g = h.probeGate; h.probeGate = null;
  const run = h.dispatch();
  await until(() => h.uploads.length, "the queue's upload");
  g.open();
  assert.equal(await manual, false);
  h.uploads[0].finish();
  await run;
});

// ---- the manual routes (too many dependencies to run here: checked in source) ----

function routeSrc(marker) {
  const at = serverSrc.indexOf(marker);
  return strip(serverSrc.slice(at, routeEnd(serverSrc, at)));
}

const fnSrcQ = marker => { const at = serverSrc.indexOf(marker); assert.ok(at >= 0, marker); return serverSrc.slice(at, serverSrc.indexOf("\n}\n", at) + 2); };
// Since §37 P3 the check is the one per-printer transfer lock (transferBusy:
// a queue dispatch, or any other send or start), whose refusal names the queue
// when it is the queue (transferBusyRefusal → queueSendingRefusal).
test("/api/print refuses Upload and Print while the queue sends, before anything else and again where its job is registered", () => {
  const r = routeSrc('app.post("/api/print"');
  const early = r.indexOf("transferBusy(p)");
  assert.ok(early > 0 && early < r.indexOf("uploadDisposition("), "refused before the busy/defer decision, so the reason is the queue");
  assert.match(fnSrcQ("function transferBusyRefusal("), /if \(qj\) return queueSendingRefusal\(p, qj\);/);
  const set = r.indexOf("JOBS.set(jobId, job)");
  const late = r.lastIndexOf("transferBusy(p)", set);
  assert.ok(late > early, "checked again where the job is registered");
  assert.doesNotMatch(r.slice(late, set), /await/, "with nothing awaited between the check and the registration");
});

// Since §37 P3 through the one per-printer lock, which includes the queue.
test("/api/printfile refuses a staged-file Print while the queue sends, and registers its start against the printer", () => {
  const r = routeSrc('app.post("/api/printfile"');
  const set = r.indexOf("JOBS.set(jobId, job)");
  const check = r.lastIndexOf("transferBusy(p)", set);
  assert.ok(check > 0);
  assert.doesNotMatch(r.slice(check, set), /await/);
  assert.match(r.slice(r.indexOf("const job = {"), set), /printerId: p\.id/, "so the queue sees the start in JOBS");
});

// ---- §37 P1: a transfer that ends without a plain yes ----

const unconfirmed = (reason = "timeout") => Object.assign(new Error("All 100 bytes were sent, but the printer did not confirm the upload within 120 s"),
  { code: "UPLOAD_UNCONFIRMED", outcome: "unknown", reason, seconds: 120 });
const addSecondItem = h => h.env.queueStore.applyIntent("pr1", st => ({ ...st, queue: [...st.queue, { id: "qi_2", status: "queued", alreadyUploaded: false, file: { name: "Next.gcode", sub: "", sizeBytes: 100, sha256: "h" },
  map: {}, prefs: {}, createdAt: 2, dispatchedAt: null, finishedAt: null, queuedBy: null, retryOfItemId: null, dispatchSnapshot: null }] }));
const dispatchJobs = h => [...h.env.JOBS.values()].filter(j => j.queueItemId);

test("Unknown: the item waits for a person as not confirmed, nothing starts, the queue does not move on, the printer is free again", async t => {
  const h = harness(t);
  addSecondItem(h);
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload to start");
  h.uploads[0].lastByte();
  h.uploads[0].failWith(unconfirmed());
  await run;
  const st = h.state();
  assert.equal(st.queueState, "queue_attention_required");
  assert.equal(st.attentionReason, "dispatch-failed");
  assert.equal(st.attentionDetail.code, "upload-unconfirmed");
  assert.equal(st.attentionDetail.uploadOutcome, "unknown");
  assert.equal(st.attentionDetail.file, "Beardie.gcode");
  assert.equal(st.attentionDetail.reason, "timeout");
  assert.equal(st.attentionDetail.seconds, 120);
  assert.match(st.attentionDetail.message, /cannot tell whether the printer has the file; it was not started/);
  assert.equal(st.recentHistory[0].uploadOutcome, "unknown", "the history says so too, not just 'failed'");
  assert.deepEqual(h.started, [], "Unknown never starts a print");
  assert.equal(st.queue[0].id, "qi_2", "the next item is still waiting");
  // No retry and no advance by itself: another sweep claims nothing.
  await h.dispatch();
  assert.equal(h.uploads.length, 1, "nothing sent again");
  assert.equal(h.state().currentItem.id, "qi_1");
  assert.ok(dispatchJobs(h).every(j => j.done), "the dispatch job is settled");
  assert.equal(h.env.queueDispatchJob("pr1"), null, "manual sends are accepted again");
  assert.ok(h.audits.includes("queue-dispatch-failed"));
});

test("a stalled upload and a connection that never opened are failed transfers, with their own codes", async t => {
  for (const [code, want] of [["UPLOAD_STALLED", "upload-stalled"], ["UPLOAD_CONNECT_TIMEOUT", "upload-connect-timeout"]]) {
    const h = harness(t);
    const run = h.dispatch();
    await until(() => h.uploads.length, "the upload to start");
    h.uploads[0].failWith(Object.assign(new Error("The printer stopped accepting data for 60 s"), { code, outcome: "failed", seconds: 60 }));
    await run;
    const st = h.state();
    assert.equal(st.attentionDetail.code, want);
    assert.equal(st.attentionDetail.uploadOutcome, undefined, "a plain failure");
    assert.deepEqual(h.started, []);
    assert.equal(h.env.queueDispatchJob("pr1"), null);
  }
});

test("Cancel while the printer confirms: shown at once, the start is never sent, and the printer's yes is what is recorded", async t => {
  const h = harness(t);
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload to start");
  const jobId = h.upload().jobId;
  h.uploads[0].lastByte();
  assert.equal(h.upload().confirming, true);
  const res = await h.cancelUpload(jobId);
  assert.equal(res.code, 200);
  assert.equal(res.body.whileConfirming, true);
  const up = h.upload();
  assert.equal(up.startCancelled, true, "every tab sees the start was cancelled while the answer is awaited");
  assert.equal(up.cancellable, false, "single use");
  assert.equal((await h.cancelUpload(jobId)).code, 409);
  assert.ok(h.env.queueDispatchJob("pr1"), "the printer stays taken until it answers");
  h.uploads[0].finish();
  await run;
  const st = h.state();
  assert.deepEqual(h.started, [], "no start after a cancel");
  assert.equal(st.attentionDetail.code, "upload-cancelled");
  assert.equal(st.attentionDetail.uploadOutcome, "sent");
  assert.match(st.attentionDetail.message, /by Eran Z after Beardie\.gcode reached the printer, which confirmed it; it was not started/);
  assert.equal(h.env.queueDispatchJob("pr1"), null);
});

test("Cancel while the printer confirms and no answer comes: recorded as unknown, never started", async t => {
  const h = harness(t);
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload to start");
  const jobId = h.upload().jobId;
  h.uploads[0].lastByte();
  await h.cancelUpload(jobId);
  h.uploads[0].failWith(unconfirmed());
  await run;
  const st = h.state();
  assert.equal(st.attentionDetail.code, "upload-cancelled");
  assert.equal(st.attentionDetail.uploadOutcome, "unknown");
  assert.match(st.attentionDetail.message, /could not tell whether the printer received it; it was not started/);
  assert.deepEqual(h.started, []);
});

test("the printer's answer and a cancel in the same moment: whichever lands first decides, and nothing starts after a cancel", async t => {
  // Answer first: the cancel finds nothing to cancel and the print starts.
  {
    const h = harness(t);
    const run = h.dispatch();
    await until(() => h.uploads.length, "the upload to start");
    const jobId = h.upload().jobId;
    h.uploads[0].lastByte();
    h.uploads[0].finish();
    const res = await h.cancelUpload(jobId);
    await run;
    assert.equal(res.code, 409);
    assert.deepEqual(h.started, ["Beardie.gcode"]);
  }
  // Cancel first, the answer in the same tick: nothing starts.
  {
    const h = harness(t);
    const run = h.dispatch();
    await until(() => h.uploads.length, "the upload to start");
    h.uploads[0].lastByte();
    h.lastJob.cancelUpload();
    h.uploads[0].finish();
    await run;
    assert.deepEqual(h.started, []);
    assert.equal(h.state().attentionDetail.uploadOutcome, "sent");
  }
});

test("Clear while the printer confirms: no print cancel is sent, nothing starts, the printer is freed once it answers", async t => {
  const h = harness(t);
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload to start");
  h.uploads[0].lastByte();
  const res = await h.clear();
  assert.equal(res.code, 200);
  assert.equal(h.cancels, 0, "nothing is printing, so no print cancel");
  assert.equal(h.lastJob.cancelRequested, true, "the start is called off at once");
  h.uploads[0].failWith(unconfirmed());
  await run;
  assert.deepEqual(h.started, []);
  assert.equal(h.state().queueState, "idle");
  assert.equal(h.env.queueDispatchJob("pr1"), null);
});

test("a failing audit write while recording the failure still frees the printer", async t => {
  const h = harness(t);
  h.env.auditLog.log = () => { throw new Error("audit database locked"); };
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload to start");
  h.uploads[0].lastByte();
  h.uploads[0].failWith(unconfirmed());
  await run.catch(() => {});
  assert.equal(h.state().attentionDetail.code, "upload-unconfirmed", "the queue recorded it before the audit failed");
  assert.ok(dispatchJobs(h).every(j => j.done));
  assert.equal(h.env.queueDispatchJob("pr1"), null);
  assert.equal(h.upload(), null);
});

// ---- §37 P2: the copy a queued start would use is read back first ----
const setAlreadyUploaded = h => h.env.queueStore.applyIntent("pr1", st => ({ ...st, queue: st.queue.map(i => i.id === "qi_1" ? { ...i, alreadyUploaded: true } : i) }));

test("P2: a queued file the printer accepted but does not list waits for a person as not confirmed; nothing starts", async t => {
  const h = harness(t);
  h.verify = { result: "absent", evidence: "Beardie.gcode is not in the printer's file list" };
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload");
  h.uploads[0].finish();
  await run;
  const st = h.state();
  assert.equal(st.attentionReason, "dispatch-failed");
  assert.equal(st.attentionDetail.code, "upload-unconfirmed");
  assert.equal(st.attentionDetail.reason, "not-on-printer");
  assert.equal(st.attentionDetail.uploadOutcome, "unknown");
  assert.match(st.attentionDetail.message, /it is not in the printer's file list/);
  assert.deepEqual(h.started, []);
  await h.dispatch();
  assert.equal(h.uploads.length, 1, "never sent again by itself");
});

test("P2: other content under that name: the item waits for a person (upload-mismatch), nothing starts, nothing deleted", async t => {
  const h = harness(t);
  h.verify = { result: "mismatch", evidence: "other content" };
  h.deletes = 0;
  h.env.getConnector().deleteFile = async () => { h.deletes++; };
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload");
  h.uploads[0].finish();
  await run;
  const st = h.state();
  assert.equal(st.attentionDetail.code, "upload-mismatch");
  assert.equal(st.attentionDetail.uploadOutcome, undefined, "a failed transfer, not an unknown one");
  assert.deepEqual(h.started, []);
  assert.equal(h.deletes, 0);
});

test("P2: an item uploaded earlier (alreadyUploaded) is read back before it starts; gone since, it is not started", async t => {
  const ok = harness(t);
  setAlreadyUploaded(ok);
  await ok.dispatch();
  assert.equal(ok.uploads.length, 0, "not sent again");
  assert.equal(ok.verifyCalls, 1, "but checked");
  assert.deepEqual(ok.started, ["Beardie.gcode"]);

  const gone = harness(t);
  setAlreadyUploaded(gone);
  gone.verify = { result: "absent", evidence: "x" };
  await gone.dispatch();
  assert.deepEqual(gone.started, []);
  assert.equal(gone.state().attentionDetail.code, "upload-unconfirmed");
  assert.equal(gone.state().attentionDetail.reason, "gone-from-printer", "uploaded earlier, not just now");
  assert.match(gone.state().attentionDetail.message, /it was uploaded earlier and is no longer in the printer's file list/);
});

test("P2: while the printer's copy is read back, the fleet row still shows the upload, as checking, with nothing to cancel", async t => {
  const h = harness(t);
  const g = gate();
  h.verify = async () => { await g.p; return { result: "verified", evidence: "x" }; };
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload");
  h.uploads[0].finish();
  await until(() => h.upload() && h.upload().verifying, "the check");
  assert.deepEqual({ verifying: h.upload().verifying, cancellable: h.upload().cancellable, file: h.upload().file }, { verifying: true, cancellable: false, file: "Beardie.gcode" });
  g.open();
  await run;
  assert.equal(h.upload(), null);
  assert.deepEqual(h.started, ["Beardie.gcode"]);
});

test("P3: the queue does not claim a printer with a deferred send queued for it; one needing attention does not hold it", async t => {
  for (const [state, claims] of [["queued", false], ["attention", true]]) {
    const h = harness(t);
    h.env.deferredStore = { list: ({ printerId, states } = {}) => [{ id: "dsend_1", printerId: "pr1", state, source: { path: FILE } }].filter(r => (!printerId || r.printerId === printerId) && (!states || states.includes(r.state))), status: () => ({}) };
    await settled(h);
    assert.equal(h.state().queueState === "dispatching" || h.uploads.length > 0, claims, state);
  }
});

test("A4: a queued file that changed on this computer while it was sent waits for a person; nothing starts", async t => {
  const h = harness(t);
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload");
  h.sourceId = { ...h.sourceId, mtimeNs: "2000000", ctimeNs: "2000000" };   // edited in place, same size
  h.uploads[0].finish();
  await run;
  const st = h.state();
  assert.equal(st.attentionDetail.reason, "local-changed");
  assert.equal(st.attentionDetail.uploadOutcome, "unknown");
  assert.deepEqual(h.started, []);
});

test("A4: a queued file whose identity cannot be taken before it is sent is never started (fail closed)", async t => {
  const h = harness(t);
  h.env.netfs.identity = async () => { throw Object.assign(new Error("share gone"), { code: "NAS_UNREACHABLE" }); };
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload");
  h.uploads[0].finish();
  await run;
  assert.equal(h.state().attentionDetail.reason, "local-unreadable");
  assert.deepEqual(h.started, []);
});

test("A4 review R1: a queued file edited after its content hash, before it is sent, is caught by the read-back's re-check", async t => {
  const h = harness(t);
  const realHash = h.env.queueStore.computeFileHash;
  let hashed = false;
  h.env.queueStore.computeFileHash = async (...a) => { const out = await realHash(...a); hashed = true; return out; };
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload");
  assert.ok(hashed);
  h.uploads[0].finish();
  // The identity the hash was taken with is the reference: an edit before the
  // upload (here, any time after the hash) shows at the re-check.
  await run;
  assert.deepEqual(h.started, ["Beardie.gcode"], "unchanged: it starts");
  const h2 = harness(t);
  // Edited while SnapCon decides how to send it — after the hash, before any byte.
  const stubDecide = h2.env.decideUpload;
  h2.env.decideUpload = async (...a) => { h2.sourceId = { ...h2.sourceId, mtimeNs: "9", ctimeNs: "9" }; return stubDecide(...a); };
  const run2 = h2.dispatch();
  await until(() => h2.uploads.length, "the upload");
  h2.uploads[0].finish();
  await run2;
  assert.equal(h2.state().attentionDetail.reason, "local-changed");
  assert.deepEqual(h2.started, []);
});

// From the A4 test review.
test("A4: acknowledged + changed source -> local-changed, nothing starts", async t => {
  const h = harness(t);
  h.verify = { result: "acknowledged", basis: "size", evidence: "x" };
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload");
  h.sourceId = { ...h.sourceId, mtimeNs: "2000000", ctimeNs: "2000000" };
  h.uploads[0].finish();
  await run;
  assert.equal(h.state().attentionDetail.reason, "local-changed");
  assert.deepEqual(h.started, []);
});

test("A4: any one identity field changing is a changed source", async t => {
  for (const k of ["size", "mtimeNs", "ctimeNs", "ino", "dev"]) {
    const h = harness(t);
    const run = h.dispatch();
    await until(() => h.uploads.length, "the upload");
    h.sourceId = { ...h.sourceId, [k]: k === "size" ? 101 : "999" };
    h.uploads[0].finish();
    await run;
    assert.equal(h.state().attentionDetail && h.state().attentionDetail.reason, "local-changed", k);
    assert.deepEqual(h.started, [], k);
  }
});

test("A4 review R1: identity moving during the hash (content hash still equal) -> file-changed, nothing sent", async t => {
  const h = harness(t);
  h.hashGate = gate();
  const run = h.dispatch();
  await tick(); await tick();
  h.sourceId = { ...h.sourceId, mtimeNs: "5000000", ctimeNs: "5000000" };
  h.hashGate.open();
  await settled(h, run);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.state().attentionReason, "file-changed");
  assert.deepEqual(h.started, []);
});

// ---- every send uploads; replacing off fails closed (owner, 2026-10-29) ----
function realDecide(h, cfg) {
  h.env.CFG = { ...(h.env.CFG || {}), ...cfg };
  delete h.env.decideUpload;
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const at = src.indexOf("async function decideUpload(");
  require("node:vm").runInContext(src.slice(at, src.indexOf("\n}\n", at) + 2), h.env);
}

test("a queued file is uploaded even when the printer's copy matches it by sample, or entirely", async t => {
  const h = harness(t);
  realDecide(h, { skipIdenticalUploads: true });
  h.verify = { result: "verified", basis: "content", evidence: "head, middle and end match" };
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload");
  h.uploads[0].finish();
  await run;
  assert.equal(h.uploads.length, 1, "uploaded");
  assert.deepEqual(h.started, ["Beardie.gcode"]);
  assert.equal(h.cancels, 0, "nothing cancelled");
});

test("replacing off: a queued file whose name the printer has, or may have, waits for a person; nothing is sent or started", async t => {
  for (const verify of [{ result: "acknowledged", basis: "name", evidence: "listed" }, { result: "unverifiable", evidence: "list unreadable" }]) {
    const h = harness(t);
    realDecide(h, { overwriteDifferentFiles: false });
    h.verify = verify;
    await settled(h);
    assert.equal(h.uploads.length, 0, verify.result);
    assert.deepEqual(h.started, [], verify.result);
    assert.match(h.state().attentionDetail.message, /Replacing files on the printer is switched off/, verify.result);
  }
});

test("the file being printed is never sent over by the queue", async t => {
  const h = harness(t);
  realDecide(h, {});
  h.env.assertNotActiveJobFile = async () => { throw Object.assign(new Error("Beardie.gcode is printing on U1 right now"), { status: 409 }); };
  await settled(h);
  assert.equal(h.uploads.length, 0);
  assert.deepEqual(h.started, []);
});

// From the skip-removal test review.
test("replacing off, Clear while the printer is asked whether it has the name: nothing is sent or started", async t => {
  const h = harness(t);
  realDecide(h, { overwriteDifferentFiles: false });
  const g = gate();
  h.verify = async () => { await g.p; return { result: "absent", evidence: "x" }; };
  const run = h.dispatch();
  await until(() => h.verifyCalls === 1, "the guard's question");
  assert.equal((await h.clear()).code, 200);
  g.open();
  await settled(h, run);
  assert.equal(h.uploads.length, 0);
  assert.deepEqual(h.started, []);
});

test("a sampled-identical copy (compareRemoteFile) does not stop a queued upload", async t => {
  const h = harness(t);
  realDecide(h, {});
  h.env.getConnector().compareRemoteFile = async () => ({ present: true, sameSize: true, identical: true });
  const run = h.dispatch();
  await until(() => h.uploads.length, "the upload");
  h.uploads[0].finish();
  await run;
  assert.equal(h.uploads.length, 1);
});

test("replacing off, an item SnapCon already uploaded (alreadyUploaded) is not refused: read back and started", async t => {
  const h = harness(t);
  realDecide(h, { overwriteDifferentFiles: false });
  h.env.queueStore.applyIntent("pr1", s => ({ ...s, queue: s.queue.map(i => ({ ...i, alreadyUploaded: true })) }));
  await settled(h);
  assert.equal(h.uploads.length, 0);
  assert.deepEqual(h.started, ["Beardie.gcode"]);
});

test("A4 review R2: a queued file found moved is checked against the identity its hash was taken with, so an edit before its upload is caught", async t => {
  const MOVED = path.join(FOLDER, "moved", "Beardie.gcode");
  for (const edit of [false, true]) {
    const h = harness(t);
    h.env.library.locateContent = () => [{ rootId: "gcode", rel: "moved/Beardie.gcode" }];
    h.env.netfs.exists = async p => p === FOLDER || p === MOVED || p === path.dirname(MOVED);
    h.env.netfs.identity = async p => { if (p !== MOVED) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return { ...h.sourceId }; };
    if (edit) { const d = h.env.decideUpload; h.env.decideUpload = async (...a) => { h.sourceId = { ...h.sourceId, mtimeNs: "8", ctimeNs: "8" }; return d(...a); }; }
    const run = h.dispatch();
    await until(() => h.uploads.length, "the upload of the moved file");
    h.uploads[0].finish();
    await run;
    if (edit) { assert.equal(h.state().attentionDetail.reason, "local-changed"); assert.deepEqual(h.started, []); }
    else assert.deepEqual(h.started, ["Beardie.gcode"], "unedited: it prints from where it moved to");
  }
});
