// test/queueRootOutage.test.js — a queued job whose folder is unavailable
// waits; a file that is really gone from a folder that answers is "missing"
// (M7.1).
//
// Before: the G-code folder vanishing at once (a drive or share that answers
// "not found" instead of timing out) made dispatch read every queued file as
// deleted and fail it as file-missing. A root-level outage is not proof that
// one file was deleted.
//
// attemptQueueDispatch and its helpers are taken from server.js and run
// against the real QueueStore/QueueEngine and the real path checks; the
// filesystem is a stand-in that can make the root vanish at once, time out,
// or come back.
const test = require("node:test");
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

class LibraryError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const FOLDER = path.resolve(os.tmpdir(), "snapcon-outage-gcode");
const FILE = path.join(FOLDER, "Beardie.gcode");

function harness(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-outage-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // The filesystem: "up" (both there), "fileGone" (folder answers, file
  // deleted), "vanished" (the folder itself not found, at once), "timeout"
  // (the share does not answer).
  const disk = { mode: "up" };
  const down = () => { const e = new Error("share not answering"); e.code = "NAS_UNREACHABLE"; return e; };
  const netfs = {
    availability: () => ({ status: disk.mode === "timeout" && disk.breakerKnows ? "offline" : "online" }),
    exists: async p => { if (disk.mode === "timeout") throw down(); if (disk.mode === "vanished") return false; return p === FOLDER || (p === FILE && disk.mode === "up"); },
    realpath: async p => p,
    stat: async () => ({ size: 10, mtimeMs: 1 }),
    identity: async () => ({ size: 10, mtimeMs: 1, mtimeNs: "1000000", ctimeNs: "1000000", ino: "3", dev: "1" }),
  };
  const queueStore = createQueueStore({ baseDir: base, fileIO: {
    stat: async () => ({ size: 10, mtimeMs: 1 }),
    hashFile: async () => { if (disk.mode === "timeout") throw down(); return { sizeBytes: 10, sha256: "h" }; },
  } });
  const printer = { id: "pr1", name: "U1", url: "http://u1", printerPoolId: "pool", connector: "x" };
  const started = [], rescans = [], audits = [];
  const env = {
    console: { log() {}, error() {} }, path, Date, Error, Math, Number, Object, Array, LibraryError, QueueEngine, isPathWithinFolder, resolveWithinFolder, CFG: {},
    PRINTERS: [printer], pendingLoad: new Map(), queuedFile: new Map(), JOBS: new Map(), STARTING: new Map(), isPrinterIdle: async () => true, FOLDER, GCODE_ROOT: "gcode",
    safePath: sub => resolveWithinFolder(sub, FOLDER), fileExists: p => netfs.exists(p), netfs, queueStore,
    library: { available: true, rescan: async id => { rescans.push(id); }, locateContent: () => [], printLocation: () => { throw new Error("no Library roots here"); }, recordPrintStart: () => {} },
    getConnector: () => ({ uploadFile: async () => {}, verifyUpload: async () => ({ result: "verified", evidence: "the test printer has it" }), startPrintFile: async (p, name) => { started.push(name); } }),
    assertNotActiveJobFile: async () => {}, decideUpload: async () => ({ action: "upload" }), whileUploading: fn => fn(), withStartSequence: (p, fn) => fn(),
    printerHasAnyDefaultPref: () => false, wantsAnyPref: () => false, ROUTE_STARTED_PRINT: new Set(),
    auditLog: { log: e => { audits.push(e.event); return 1; } }, libraryAudit: x => x,
  };
  vm.createContext(env);
  try { loadUploadOutcomeHelpers(env, serverSrc); } catch {}
  vm.runInContext("const relOf = ref => path.relative(ref.dir, ref.fp).split(path.sep).join('/');", env);
  vm.runInContext("const ROOT_DOWN = new Map(); let jobN = 0; const newJobId = () => 'j' + (++jobN);", env);
  for (const name of ["async function resolveFileRef(", "async function locationAnswers(", "function noteRootDown(", "async function relocateQueuedFile(", "async function attemptQueueDispatch(",
    "function queueDispatchJob(", "function otherSendInFlight(", "function queueStillDispatching("]) {
    const at = serverSrc.indexOf(name);
    assert.ok(at > 0, name);
    const end = serverSrc.slice(at).search(/\r?\n\}\r?\n/);
    vm.runInContext(serverSrc.slice(at, at + end + 3), env);
  }
  queueStore.assignPool("pr1");
  queueStore.applyIntent("pr1", s => ({ ...s, queue: [{ id: "qi_1", status: "queued", alreadyUploaded: false, file: { name: "Beardie.gcode", sub: "", sizeBytes: 10, sha256: "h" },
    map: {}, prefs: {}, createdAt: 1, dispatchedAt: null, finishedAt: null, queuedBy: null, retryOfItemId: null, dispatchSnapshot: null }] }));
  const state = () => queueStore.getPrinterState("pr1");
  return { disk, dispatch: () => env.attemptQueueDispatch("pr1"), state, started, rescans, audits };
}

test("the G-code folder vanishing at once: the job waits in place, is never 'missing', and the folder is checked", async t => {
  const h = harness(t);
  h.disk.mode = "vanished";
  for (let i = 0; i < 3; i++) await h.dispatch();
  assert.equal(h.state().queueState, "idle", "no attention state");
  assert.deepEqual(h.state().queue.map(i => i.id), ["qi_1"], "still first, same item");
  assert.equal(h.state().queue[0].status, "queued");
  assert.equal(h.started.length, 0);
  assert.deepEqual(h.rescans, ["gcode"], "checked once, not on every sweep");
});

test("a share that times out: the job waits in place, never 'missing'", async t => {
  const h = harness(t);
  h.disk.mode = "timeout";
  await h.dispatch();
  assert.equal(h.state().queueState, "idle");
  assert.deepEqual(h.state().queue.map(i => i.id), ["qi_1"]);
  h.disk.breakerKnows = true;   // once netfs knows, nothing is even attempted
  await h.dispatch();
  assert.deepEqual(h.state().queue.map(i => i.id), ["qi_1"]);
  assert.equal(h.started.length, 0);
});

test("the folder answers but the file is gone: that is 'missing', as before", async t => {
  const h = harness(t);
  h.disk.mode = "fileGone";
  await h.dispatch();
  assert.equal(h.state().queueState, "queue_attention_required");
  assert.equal(h.state().attentionReason, "file-missing");
  assert.equal(h.started.length, 0);
});

test("the folder comes back: the waiting job is validated as usual and printed", async t => {
  const h = harness(t);
  h.disk.mode = "vanished";
  await h.dispatch();
  h.disk.mode = "up";
  await h.dispatch();
  assert.deepEqual(h.started, ["Beardie.gcode"]);
  assert.equal(h.state().queue.length, 0);
  assert.ok(h.audits.includes("queue-print-started"));
});
