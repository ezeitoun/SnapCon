// test/printUploadOutcome.test.js — what /api/print does with a transfer that
// ends without a plain yes, and how a cancel meets the print start
// (docs/TODO.md §37 P1).
//
// Before: a cancel was possible only while bytes went out; an upload whose
// printer never answered never ended; nothing told "failed" from "unknown";
// a finished job was dropped 5 s after it was first read, so a second tab or a
// tab that lost its connection read "No such job".
//
// The routes run from server.js's own source in a vm, with a connector whose
// upload the test settles by hand, in the same states the real transport
// (connectors/http-utils.js sendMultipartUpload) goes through.
const test = require("node:test");
const { routeEnd } = require("./helpers/routeEnd");
const assert = require("node:assert/strict");
const { fileIdentity } = require("./helpers/fileIdentity");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const { loadUploadOutcomeHelpers } = require("./helpers/uploadOutcomeHelpers");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const route = marker => {
  const at = serverSrc.indexOf(marker);
  assert.ok(at > 0, marker);
  return serverSrc.slice(at, routeEnd(serverSrc, at, true) + 5);
};
const fn = marker => {
  const at = serverSrc.indexOf(marker);
  assert.ok(at >= 0, marker);
  return serverSrc.slice(at, at + serverSrc.slice(at).search(/\r?\n\}\r?\n/) + 3);
};
const until = async (cond, what) => { for (let i = 0; i < 400; i++) { if (cond()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error("timed out waiting for " + what); };

function harness(t, { cfg = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-outcome-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const fp = path.join(base, "Part.gcode");
  fs.writeFileSync(fp, "G1 X1\n");
  const h = { uploads: [], started: [], mapped: 0, audits: [], staged: () => env.queuedFile.get("pr1") };
  const connector = {
    uploadFile: (p, file, name, job) => new Promise((resolve, reject) => {
      job.total = 100; job.sent = 40;
      h.job = job;
      job.cancelUpload = () => { job.cancelRequested = true; job.cancelUpload = null; reject(Object.assign(new Error("Upload cancelled"), { code: "UPLOAD_CANCELLED", outcome: "failed", abortedMidBody: true })); };
      h.uploads.push({
        lastByte: () => { job.sent = 100; job.confirmingSince = Date.now(); job.cancelUpload = () => { job.cancelRequested = true; job.cancelUpload = null; }; },
        answer: () => { job.cancelUpload = null; resolve("{}"); },
        unknown: () => { job.cancelUpload = null; reject(Object.assign(new Error("All 100 bytes were sent, but the printer did not confirm the upload within 120 s"), { code: "UPLOAD_UNCONFIRMED", outcome: "unknown", reason: "timeout", seconds: 120 })); },
        stall: () => { job.cancelUpload = null; reject(Object.assign(new Error("The printer stopped accepting data for 60 s"), { code: "UPLOAD_STALLED", outcome: "failed", seconds: 60, printerPrompt: true })); },
      });
    }),
    applyHeadMapping: async () => { h.mapped++; },
    // The read-back (§37 P2): verified unless a test sets h.verify.
    verifyUpload: async () => { h.verifyCalls = (h.verifyCalls || 0) + 1; return typeof h.verify === "function" ? h.verify() : h.verify || { result: "verified", evidence: "the test printer has it" }; },
    startPrintFile: async (p, name) => { h.started.push(name); },
  };
  const printer = { id: "pr1", name: "U1 Navy", url: "http://u1", connector: "snapmaker-u1-klipper" };
  const routes = {};
  const env = {
    console: { log() {}, error() {}, warn() {} }, path, fs, JSON, Date, Math, String, Object, Number, Error, Map, Set, Promise, Array, setTimeout,
    PRINTERS: [printer], JOBS: new Map(), queuedFile: new Map(), pendingLoad: new Map(), ROUTE_STARTED_PRINT: new Set(),
    QUEUED_FILE_PATH: path.join(base, "queued-files.json"),
    CFG: { allowUploadWhilePrinting: true, skipIdenticalUploads: false, ...cfg },
    netfs: { stat: async f => { const s = fs.statSync(f); return { size: s.size, mtimeMs: s.mtimeMs }; }, identity: fileIdentity },
    printerVisibleTo: () => true,
    resolveFileRef: async () => ({ fp, dir: base, root: "gcode" }),
    relOf: ref => path.relative(ref.dir, ref.fp),
    fileExists: async f => fs.existsSync(f),
    resolvePrintPlate: async () => ({ plate: null }),
    libraryPrintIdentity: async () => null,
    replyFileRefError: () => false,
    fileTypeRefusal: () => null, getCapabilities: () => ({}),
    assertNotActiveJobFile: async () => {}, withGcodeHolds: h => h, holdGcodeFile: () => true, gcodeFileBeingDeleted: () => false, BEING_DELETED: n => n + " is being deleted.",
    queueDispatchJob: () => null, queueSendingRefusal: () => "",
    isPrinterIdle: async () => true,
    decideUpload: async () => ({ action: "upload" }),
    getConnector: () => connector,
    queueStore: {},
    actorFromReq: () => ({ userId: "u1", userLabel: "Eran" }),
    whileUploading: fn => fn(), withStartSequence: async (p, fn) => fn(),
    printerHasAnyDefaultPref: () => true, wantsAnyPref: () => false,
    auditLog: { log: e => { h.audits.push(e); return 1; } }, library: { recordPrintStart: () => {} },
    requireRegular: (req, res, next) => next(), requireAuth: (req, res, next) => next(),
    app: { post: (r, ...fns) => { routes[r] = fns[fns.length - 1]; }, get: (r, ...fns) => { routes[r] = fns[fns.length - 1]; } },
  };
  vm.createContext(env);
  loadUploadOutcomeHelpers(env, serverSrc);
  vm.runInContext("let jobN = 0; const newJobId = () => 'j' + (++jobN);", env);
  vm.runInContext(serverSrc.slice(serverSrc.indexOf("const sendRef = (ref, ident, plate) =>"), routeEnd(serverSrc, serverSrc.indexOf("const sendRef = (ref, ident, plate) =>"), true) + 5), env);
  vm.runInContext(serverSrc.slice(serverSrc.indexOf("const libraryAudit = id =>"), serverSrc.indexOf("\n", serverSrc.indexOf("const libraryAudit = id =>"))), env);
  for (const m of ["function checkToolMap(", "function stagedChoices(", "function uploadDisposition(", "function saveQueuedFiles(", "function activeUploadFor("]) vm.runInContext(fn(m), env);
  for (const r of ['app.post("/api/print", requireRegular', 'app.post("/api/print-cancel"', 'app.get("/api/print-status"']) vm.runInContext(route(r), env);
  const call = async (r, req) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[r]({ user: { id: "u1", role: "regular" }, ...req }, res);
    return res;
  };
  h.env = env;
  h.send = async ({ start }) => { const r = await call("/api/print", { body: { file: "Part.gcode", printer: 0, start } }); assert.ok(r.body.jobId, JSON.stringify(r.body)); h.jobId = r.body.jobId; await until(() => h.uploads.length, "the upload"); return r.body.jobId; };
  h.call = call;
  h.cancel = (jobId = h.jobId) => call("/api/print-cancel", { body: { job: jobId } });
  h.status = (jobId = h.jobId) => call("/api/print-status", { query: { job: jobId } });
  h.done = () => until(() => env.JOBS.get(h.jobId).done, "the job to end");
  return h;
}

test("Unknown: Upload & Print never starts, nothing is staged, the job says unknown, and it is audited", async t => {
  const h = harness(t);
  await h.send({ start: true });
  h.uploads[0].lastByte();
  assert.equal((await h.status()).body.phase, "confirming");
  h.uploads[0].unknown();
  await h.done();
  const s = (await h.status()).body;
  assert.equal(s.outcome, "unknown");
  assert.equal(s.errorCode, "UPLOAD_UNCONFIRMED");
  assert.equal(s.errorReason, "timeout");
  assert.equal(s.errorSeconds, 120);
  assert.equal(s.failedPhase, "upload");
  assert.deepEqual(h.started, [], "no start");
  assert.equal(h.mapped, 0, "and nothing before it");
  assert.equal(h.staged(), undefined, "not shown as Loaded");
  assert.ok(h.audits.some(a => a.event === "upload-unconfirmed"));
  assert.equal(h.env.activeUploadFor("pr1"), null, "the printer is free");
});

test("a failed transfer is failed, not unknown, and its screen-message hint travels", async t => {
  const h = harness(t);
  await h.send({ start: true });
  h.uploads[0].stall();
  await h.done();
  const s = (await h.status()).body;
  assert.equal(s.outcome, "failed");
  assert.equal(s.errorCode, "UPLOAD_STALLED");
  assert.equal(s.printerPrompt, true);
  assert.deepEqual(h.started, []);
  assert.ok(h.audits.some(a => a.event === "upload-failed"));
});

test("Cancel while the printer confirms: the start is called off at once and shown, and the printer's yes is the outcome", async t => {
  const h = harness(t);
  await h.send({ start: true });
  h.uploads[0].lastByte();
  const c = await h.cancel();
  assert.equal(c.code, 200);
  assert.equal(c.body.whileConfirming, true);
  const during = (await h.status()).body;
  assert.equal(during.phase, "confirming", "still waiting for the printer's answer");
  assert.equal(during.startCancelled, true, "and the page can say the start was cancelled");
  assert.equal(during.cancellable, false);
  assert.match((await h.cancel()).body.error, /Already cancelled; waiting for the printer/);
  assert.ok(h.env.activeUploadFor("pr1").startCancelled);
  h.uploads[0].answer();
  await h.done();
  const s = (await h.status()).body;
  assert.equal(s.outcome, "sent", "the printer has the file");
  assert.equal(s.cancelled, true);
  assert.equal(s.errorCode, "UPLOAD_CANCELLED");
  assert.deepEqual(h.started, [], "never started");
  assert.equal(h.mapped, 0, "no mapping either");
  assert.equal(h.staged(), undefined);
  assert.ok(h.audits.some(a => a.event === "upload-cancelled" && a.detail.whileConfirming));
});

test("Cancel while the printer confirms, then no answer: unknown, never started", async t => {
  const h = harness(t);
  await h.send({ start: true });
  h.uploads[0].lastByte();
  await h.cancel();
  h.uploads[0].unknown();
  await h.done();
  const s = (await h.status()).body;
  assert.equal(s.outcome, "unknown");
  assert.equal(s.cancelled, true);
  assert.equal(s.startCancelled, true);
  assert.deepEqual(h.started, []);
});

test("the answer and a cancel at the same moment: answer first starts the print and refuses the cancel; cancel first starts nothing", async t => {
  {
    const h = harness(t);
    await h.send({ start: true });
    h.uploads[0].lastByte();
    h.uploads[0].answer();
    const c = await h.cancel();
    await h.done();
    assert.equal(c.code, 409);
    assert.match(c.body.error, /already has the file|already finished/);
    assert.deepEqual(h.started, ["Part.gcode"]);
  }
  {
    const h = harness(t);
    await h.send({ start: true });
    h.uploads[0].lastByte();
    const pending = h.cancel();     // its handler runs before the answer below settles
    h.uploads[0].answer();
    assert.equal((await pending).code, 200);
    await h.done();
    assert.deepEqual(h.started, []);
  }
});

test("upload only, cancelled while confirming: not staged as Loaded although the printer confirmed it", async t => {
  const h = harness(t);
  await h.send({ start: false });
  h.uploads[0].lastByte();
  await h.cancel();
  h.uploads[0].answer();
  await h.done();
  assert.equal(h.staged(), undefined);
  assert.equal((await h.status()).body.outcome, "sent");
});

// §38: only a print that starts sends mapping and preferences. This harness's
// printer has default options on (printerHasAnyDefaultPref).
test("an upload to a printer with default options sends no mapping or preferences, and keeps the map for its Print", async t => {
  const h = harness(t);
  const r = await h.call("/api/print", { body: { file: "Part.gcode", printer: 0, start: false, map: { 0: 2 } } });
  h.jobId = r.body.jobId;
  await until(() => h.uploads.length, "the upload");
  h.uploads[0].answer();
  await h.done();
  assert.equal(h.mapped, 0);
  assert.deepEqual(h.started, []);
  assert.deepEqual({ ...h.staged().map }, { 0: 2 });
  assert.equal(h.env.JOBS.get(h.jobId).result.mapped, 0, "the page is not told heads were mapped");
});

test("uploading again replaces what was kept: the old map never reaches the new file, even of the same name", async t => {
  const h = harness(t);
  const upload = async map => {
    const n = h.uploads.length;
    const r = await h.call("/api/print", { body: { file: "Part.gcode", printer: 0, start: false, map } });
    h.jobId = r.body.jobId;
    await until(() => h.uploads.length > n, "the upload");
    h.uploads[n].answer();
    await h.done();
  };
  await upload({ 0: 2 });
  assert.deepEqual({ ...h.staged().map }, { 0: 2 });
  await upload({});
  assert.equal(h.staged().map, undefined);
});

test("an upload while the printer is printing sends no mapping or preferences into the running print", async t => {
  const h = harness(t);
  h.env.isPrinterIdle = async () => false;
  await h.send({ start: false });
  await until(() => h.uploads.length, "the upload");
  h.uploads[0].answer();
  await h.done();
  assert.equal(h.uploads.length, 1, "it went straight through: uploads while printing are on");
  assert.equal(h.mapped, 0);
  assert.deepEqual(h.started, []);
});

test("Upload & Print still sends mapping and preferences, before the start", async t => {
  const h = harness(t);
  const order = [];
  const c = h.env.getConnector();
  const start = c.startPrintFile;
  c.applyHeadMapping = async () => { order.push("mapping"); };
  c.startPrintFile = async (...a) => { order.push("start"); return start(...a); };
  const r = await h.call("/api/print", { body: { file: "Part.gcode", printer: 0, start: true, map: { 0: 2 } } });
  h.jobId = r.body.jobId;
  await until(() => h.uploads.length, "the upload");
  h.uploads[0].answer();
  await h.done();
  assert.deepEqual(order, ["mapping", "start"]);
  assert.equal(h.env.JOBS.get(h.jobId).result.mapped, 1);
});

test("a plain success still stages, starts and reports sent", async t => {
  const h = harness(t);
  await h.send({ start: false });
  h.uploads[0].lastByte();
  h.uploads[0].answer();
  await h.done();
  assert.equal(h.staged().status, "ready");
  const s = (await h.status()).body;
  assert.equal(s.outcome, "sent");
  assert.equal(s.error, null);
});

test("an audit write failing after a successful start does not turn it into a failure, and the printer is free", async t => {
  const h = harness(t);
  h.env.auditLog.log = () => { throw new Error("audit database locked"); };
  await h.send({ start: true });
  h.uploads[0].lastByte();
  h.uploads[0].answer();
  await h.done();
  await new Promise(r => setTimeout(r, 20));
  const s = (await h.status()).body;
  assert.equal(s.error, null);
  assert.equal(s.phase, "done");
  assert.deepEqual(h.started, ["Part.gcode"]);
  assert.equal(h.env.activeUploadFor("pr1"), null);
});

test("an audit write failing while recording an unknown upload still ends the job", async t => {
  const h = harness(t);
  h.env.auditLog.log = () => { throw new Error("audit database locked"); };
  await h.send({ start: true });
  h.uploads[0].lastByte();
  h.uploads[0].unknown();
  await h.done();
  assert.equal((await h.status()).body.outcome, "unknown");
  assert.equal(h.env.activeUploadFor("pr1"), null);
});

test("a finished job's result is kept however often it is read; a job SnapCon does not know says so, with when the server started", async t => {
  const h = harness(t);
  await h.send({ start: false });
  h.uploads[0].lastByte();
  h.uploads[0].unknown();
  await h.done();
  await h.status();
  await new Promise(r => setTimeout(r, 50));
  assert.ok(h.env.JOBS.has(h.jobId), "not dropped on read");
  assert.equal((await h.status()).body.outcome, "unknown", "a second reader gets the same result");
  const gone = await h.status("j-not-here");
  assert.equal(gone.code, 404);
  assert.equal(gone.body.code, "job_unknown");
  assert.equal(typeof gone.body.serverStartedAt, "number");
  assert.doesNotMatch(serverSrc, /if \(job\.done\) setTimeout\(\(\) => JOBS\.delete/, "no delete-after-read");
});

test("the job carries the deadlines from config.json's uploadTimeouts, in seconds, held to their limits", async t => {
  const h = harness(t, { cfg: { uploadTimeouts: { connect: 15, inactivity: 5, confirm: 300 } } });
  await h.send({ start: false });
  assert.deepEqual({ ...h.job.timeouts }, { connectMs: 15000, inactivityMs: 10000, confirmMs: 300000 });
  const u = h.env.uploadTimeoutsFromConfig;
  assert.deepEqual({ ...u({}) }, {}, "nothing set: the connector defaults");
  assert.deepEqual({ ...u({ uploadTimeouts: { confirm: "x", connect: true, inactivity: 9999 } }) }, { inactivityMs: 600000 }, "not a number is ignored");
  assert.deepEqual({ ...u({ uploadTimeouts: [1, 2] }) }, {});
  assert.deepEqual({ ...u({ uploadTimeouts: { connect: 1 } }) }, { connectMs: 2000 });
});

test("a Settings save keeps uploadTimeouts (the config is rebuilt there, not merged)", () => {
  const at = serverSrc.indexOf('app.post("/api/config"');
  const body = serverSrc.slice(at, routeEnd(serverSrc, at, true));
  assert.match(body, /uploadTimeouts: CFG\.uploadTimeouts \|\| undefined/);
});

// ---- §37 P2: the printer's copy is read back before anything may start it ----
// Before: the printer's yes to the upload was the last word. A printer that
// accepted a file it then did not hold (or held other content under that
// name) was sent a start, and the file was shown as Loaded.

const gateP = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
const finish = h => { h.uploads[0].lastByte(); h.uploads[0].answer(); return h.done(); };

test("P2: not in the printer's file list after its yes is Unknown: never started, not staged, audited as unconfirmed", async t => {
  const h = harness(t);
  h.verify = { result: "absent", evidence: "Part.gcode is not in the printer's file list" };
  await h.send({ start: true });
  await finish(h);
  const s = (await h.status()).body;
  assert.equal(s.outcome, "unknown");
  assert.equal(s.errorCode, "UPLOAD_UNCONFIRMED");
  assert.equal(s.errorReason, "not-on-printer");
  assert.equal(s.failedPhase, "verifying");
  assert.deepEqual(h.started, [], "Unknown never starts a print");
  assert.equal(h.mapped, 0, "nothing sent to the printer before a start either");
  assert.equal(h.staged(), undefined, "not shown as Loaded");
  assert.ok(h.audits.some(a => a.event === "upload-unconfirmed"));
});

test("P2: a file list that cannot be read is Unknown too, for the same reason", async t => {
  for (const verify of [{ result: "unverifiable", evidence: "the printer's file list could not be read" }, () => { throw new Error("socket hang up"); }]) {
    const h = harness(t);
    h.verify = verify;
    await h.send({ start: true });
    await finish(h);
    const s = (await h.status()).body;
    assert.equal(s.outcome, "unknown");
    assert.equal(s.errorReason, "verify-unreadable");
    assert.deepEqual(h.started, []);
  }
});

test("P2: other content under that name is Failed: never started, never staged, and nothing deleted", async t => {
  const h = harness(t);
  h.verify = { result: "mismatch", evidence: "the printer's Part.gcode is 90 bytes, the file sent is 6" };
  h.deletes = 0;
  h.env.getConnector().deleteFile = async () => { h.deletes++; };
  await h.send({ start: true });
  await finish(h);
  const s = (await h.status()).body;
  assert.equal(s.outcome, "failed");
  assert.equal(s.errorCode, "UPLOAD_MISMATCH");
  assert.equal(s.failedPhase, "verifying");
  assert.deepEqual(h.started, []);
  assert.equal(h.staged(), undefined);
  assert.equal(h.deletes, 0, "the printer's copy is left as it is (D6)");
  assert.ok(h.audits.some(a => a.event === "upload-failed" && a.detail.code === "UPLOAD_MISMATCH"));
});

test("P2: verified and acknowledged both start; the result and the audit say which", async t => {
  for (const result of ["verified", "acknowledged"]) {
    const h = harness(t);
    h.verify = { result, evidence: "x" };
    await h.send({ start: true });
    await finish(h);
    const s = (await h.status()).body;
    assert.equal(s.outcome, "sent");
    assert.equal(s.result.verification, result);
    assert.deepEqual(h.started, ["Part.gcode"]);
    assert.equal(h.audits.find(a => a.event === "print-started").detail.verification, result);
  }
});

test("P2: an upload-only file is staged with what the check found, and only after it", async t => {
  const h = harness(t);
  let staged;
  h.verify = () => { staged = h.staged(); return { result: "verified", evidence: "x" }; };
  await h.send({ start: false });
  await finish(h);
  assert.equal(staged, undefined, "not Loaded while its copy is being checked");
  assert.equal(h.staged().status, "ready");
  assert.equal(h.staged().verification, "verified");
  assert.ok(Number.isFinite(h.staged().verifiedAt));
  assert.equal(h.verifyCalls, 1);
});

test("P2: the phase reads 'verifying' while the printer's copy is checked, and Cancel is refused then, as once the printer has answered", async t => {
  const h = harness(t);
  const g = gateP();
  h.verify = async () => { await g.p; return { result: "verified", evidence: "x" }; };
  await h.send({ start: true });
  h.uploads[0].lastByte(); h.uploads[0].answer();
  await until(() => h.env.JOBS.get(h.jobId).phase === "verifying", "the check");
  assert.equal((await h.status()).body.phase, "verifying");
  assert.equal((await h.status()).body.cancellable, false);
  assert.equal((await h.cancel()).code, 409);
  g.open();
  await h.done();
  assert.deepEqual(h.started, ["Part.gcode"], "the start follows the check");
});

test("P2: what was staged keeps its check across a restart; an entry from before the check stays unchecked", async t => {
  const h = harness(t);
  for (const name of ["function loadQueuedFiles("]) vm.runInContext(fn(name), h.env);
  h.verify = { result: "acknowledged", evidence: "x" };
  await h.send({ start: false });
  await finish(h);
  const at = h.staged().verifiedAt;
  h.env.queuedFile.clear();
  h.env.loadQueuedFiles();
  assert.equal(h.staged().verification, "acknowledged");
  assert.equal(h.staged().verifiedAt, at);
  // Written before the read-back existed, or edited by hand: not trusted.
  for (const bad of [{}, { verification: "trust-me", verifiedAt: 1 }, { verification: "verified" }]) {
    fs.writeFileSync(h.env.QUEUED_FILE_PATH, JSON.stringify({ pr1: { name: "Part.gcode", ts: 1, ...bad } }));
    h.env.queuedFile.clear();
    h.env.loadQueuedFiles();
    assert.equal(h.staged().verification, undefined, JSON.stringify(bad));
  }
});

test("P2: a local file that changed while it was sent cannot be compared: Unknown (local-changed), not Failed; unchanged it stays Failed", async t => {
  const changed = harness(t);
  changed.verify = () => { const f = changed.env.JOBS.get(changed.jobId) && path.join(path.dirname(changed.env.QUEUED_FILE_PATH), "Part.gcode"); fs.writeFileSync(f, "G1 X2 Y2\n"); return { result: "mismatch", evidence: "x" }; };
  await changed.send({ start: true });
  await finish(changed);
  const c = (await changed.status()).body;
  assert.equal(c.outcome, "unknown");
  assert.equal(c.errorReason, "local-changed");
  assert.deepEqual(changed.started, []);

  const same = harness(t);
  same.verify = { result: "mismatch", evidence: "x" };
  await same.send({ start: true });
  await finish(same);
  assert.equal((await same.status()).body.outcome, "failed");
});

test("P2: a connector that cannot read files back leaves the upload Unknown, never started", async t => {
  const h = harness(t);
  delete h.env.getConnector().verifyUpload;
  await h.send({ start: true });
  await finish(h);
  const s = (await h.status()).body;
  assert.equal(s.outcome, "unknown");
  assert.equal(s.errorReason, "verify-unreadable");
  assert.deepEqual(h.started, []);
});

test("P2: a cancel while the printer confirms is checked before the read-back, which then does not run", async t => {
  const h = harness(t);
  await h.send({ start: true });
  h.uploads[0].lastByte();
  assert.equal((await h.cancel()).code, 200);
  h.uploads[0].answer();
  await h.done();
  assert.equal(h.verifyCalls || 0, 0);
  assert.equal((await h.status()).body.cancelled, true);
});

test("P2: a file whose copy is being checked cannot be deleted from the printer", () => {
  const at = serverSrc.indexOf("const refusal = printerFileDeleteRefusal({");
  assert.ok(at > 0);
  const route = serverSrc.slice(at, at + 600);
  assert.match(route, /uploading: \[\.\.\.JOBS\.values\(\)\]\.filter\(j => !j\.done && \(j\.phase === "upload" \|\| j\.phase === "verifying"\)/);
});

// §37 P3: one transfer at a time per printer.
test("P3: a manual Upload while another send to that printer is running is refused, saying the printer is receiving another file", async t => {
  const h = harness(t);
  h.env.JOBS.set("other", { printerId: "pr1", done: false, file: "Waiting.gcode", deferredId: "dsend_x" });
  const r = await h.call("/api/print", { body: { file: "Part.gcode", printer: 0, start: false } });
  assert.equal(r.code, 409);
  assert.equal(r.body.code, "printer_receiving");
  assert.match(r.body.error, /U1 Navy is receiving another file \(Waiting\.gcode\)/);
  assert.equal(h.uploads.length, 0);
});

// ---- §37 A4 (owner, 2026-10-29): the source is checked again after the read-back ----
// The read-back samples the file: exact size, and its start, middle and end
// (connectors/http-utils.js). sampledReadBack compares those windows of what
// was sent with the local file now, as that connector does.
function sampledReadBack(sent, fp) {
  return () => {
    const now = fs.readFileSync(fp);
    if (now.length !== sent.length) return { result: "mismatch", basis: "size", evidence: "size" };
    const w = 100, mid = Math.floor(sent.length / 2) - w / 2;
    for (const at of [0, mid, sent.length - w]) if (!now.subarray(at, at + w).equals(sent.subarray(at, at + w))) return { result: "mismatch", basis: "content", evidence: "window" };
    return { result: "verified", basis: "content", evidence: "head, middle and end match" };
  };
}
const sourceOf = h => path.join(path.dirname(h.env.QUEUED_FILE_PATH), "Part.gcode");
const gcode3k = () => Buffer.from(Array.from({ length: 300 }, (_, i) => `G1 X${String(i).padStart(4, "0")}\n`).join("")).subarray(0, 3000);

test("A4: an in-place edit of the same size outside the sampled windows, during the send, is Unknown (changed on this computer): never Verified, started or Loaded", async t => {
  const h = harness(t);
  const sent = gcode3k();
  fs.writeFileSync(sourceOf(h), sent);
  h.verify = sampledReadBack(sent, sourceOf(h));
  await h.send({ start: true });
  // Mid-send: 4 bytes at offset 1000 rewritten in place — same size, outside every window.
  await new Promise(r => setTimeout(r, 5));
  const fd = fs.openSync(sourceOf(h), "r+"); fs.writeSync(fd, Buffer.from("X999"), 0, 4, 1000); fs.closeSync(fd);
  assert.equal(h.verify().result, "verified", "the sampled read-back alone would pass it");
  await finish(h);
  const s = (await h.status()).body;
  assert.equal(s.outcome, "unknown");
  assert.equal(s.errorReason, "local-changed");
  assert.match(s.error, /changed on this computer/);
  assert.deepEqual(h.started, []);
  assert.equal(h.mapped, 0);
  assert.equal(h.staged(), undefined, "not Loaded");
});

test("A4: the same file, untouched, still goes through: Verified, started", async t => {
  const h = harness(t);
  const sent = gcode3k();
  fs.writeFileSync(sourceOf(h), sent);
  h.verify = sampledReadBack(sent, sourceOf(h));
  await h.send({ start: true });
  await finish(h);
  const s = (await h.status()).body;
  assert.equal(s.error, null);
  assert.deepEqual(h.started, ["Part.gcode"]);
});

test("A4: a source that cannot be checked again after the send fails closed: Unknown, never started", async t => {
  const h = harness(t);
  await h.send({ start: true });
  fs.rmSync(sourceOf(h));
  await finish(h);
  const s = (await h.status()).body;
  assert.equal(s.outcome, "unknown");
  assert.equal(s.errorReason, "local-unreadable");
  assert.match(s.error, /could not be checked again on this computer/);
  assert.deepEqual(h.started, []);
  assert.equal(h.staged(), undefined);
});

