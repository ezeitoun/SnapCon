// test/printStagedSize.test.js — an uploaded file is staged with its own size
// (docs/TODO.md §37 P0-2).
//
// Before: /api/print's Upload staged the "ready to print" file with
// `size: job.total`. On Moonraker (and FlashForge) that is the whole upload
// body, multipart framing included, so it never equalled the size the printer
// lists, and the staged-copy check decided the printer's copy "is not the copy
// SnapCon staged": a Library send started later from the printer lost its
// Library Variant. An identical copy that was not uploaded again was staged
// with no size at all. Entries saved that way (sizes ~180-200 bytes too big
// on every live Moonraker printer, 2026-10-23) keep their Library link, with
// the copy unchecked rather than confirmed.
//
// /api/print runs here from server.js with the real Moonraker connector code
// (connectors/http-utils.js: multipart upload, file list, range reads)
// against a fake Moonraker on 127.0.0.1, and the real decideUpload,
// uploadDisposition, saveQueuedFiles/loadQueuedFiles and checkStagedCopy (§37 P5).
const test = require("node:test");
const { routeEnd } = require("./helpers/routeEnd");
const assert = require("node:assert/strict");
const { fileIdentity } = require("./helpers/fileIdentity");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("node:vm");
const httpUtils = require("../connectors/http-utils");
const { loadUploadOutcomeHelpers } = require("./helpers/uploadOutcomeHelpers");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
function fnSrc(marker) {
  const at = serverSrc.indexOf(marker);
  assert.ok(at >= 0, marker);
  const end = serverSrc.slice(at).search(/\r?\n\}\r?\n/);
  return serverSrc.slice(at, at + end + 3);
}
function lineSrc(marker) {
  const at = serverSrc.indexOf(marker);
  assert.ok(at >= 0, marker);
  return serverSrc.slice(at, routeEnd(serverSrc, at, true) + 5);
}
const routeSrc = (() => {
  const at = serverSrc.indexOf('app.post("/api/print", requireRegular');
  assert.ok(at > 0);
  return serverSrc.slice(at, routeEnd(serverSrc, at, true) + 5);
})();

// A Moonraker that keeps uploaded files in memory and answers the three calls
// the connector makes: upload, list, ranged read.
function fakeMoonraker(t) {
  const files = new Map();   // name -> Buffer
  const m = { files, uploads: 0, requests: [], failList: false };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    m.requests.push(req.method + " " + u.pathname);
    if (m.failList && (u.pathname === "/server/files/list" || u.pathname === "/server/files/directory")) { res.statusCode = 500; return res.end("{}"); }
    if (req.method === "POST" && u.pathname === "/server/files/upload") {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const boundary = "--" + /boundary=(.+)$/.exec(req.headers["content-type"])[1];
        const headEnd = body.indexOf("\r\n\r\n") + 4;
        const name = /filename="([^"]+)"/.exec(body.slice(0, headEnd).toString())[1];
        const tail = body.lastIndexOf(Buffer.from("\r\n" + boundary + "--"));
        files.set(name, body.slice(headEnd, tail));
        m.uploads++;
        m.lastBodySize = body.length;
        res.statusCode = 201; res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ result: { item: { path: name, root: "gcodes" }, action: "create_file" } }));
      });
      return;
    }
    if (u.pathname === "/server/files/list") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ result: [...files].map(([p, b]) => ({ path: p, size: b.length, modified: 1 })) }));
    }
    // The gcodes root, as Moonraker lists one directory (§37 P2 read-back).
    if (u.pathname === "/server/files/directory") {
      res.setHeader("content-type", "application/json");
      const root = [...files].filter(([p]) => !p.includes("/"));
      return res.end(JSON.stringify({ result: { dirs: [], files: root.map(([p, b]) => ({ filename: p, size: b.length, modified: 1 })) } }));
    }
    if (u.pathname.startsWith("/server/files/gcodes/")) {
      const b = files.get(decodeURIComponent(u.pathname.slice("/server/files/gcodes/".length)));
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
      if (!b || !r) { res.statusCode = 404; return res.end(); }
      res.statusCode = 206; return res.end(b.slice(+r[1], +r[2] + 1));
    }
    res.statusCode = 404; res.end("{}");
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(() => server.close());
    m.url = "http://127.0.0.1:" + server.address().port;
    resolve(m);
  }));
}

const IDENT = { contentKey: "c".repeat(64), plate: 1, model: 7, modelName: "Beardie", variantKey: "v1", sha256: "c".repeat(64), location: "gcode:Beardie.gcode" };

async function harness(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-staged-size-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const moon = await fakeMoonraker(t);
  const fp = path.join(base, "Beardie.gcode");
  // Big enough that the identity check reads three distinct windows.
  const content = Buffer.alloc(300000, 0);
  for (let i = 0; i < content.length; i++) content[i] = (i * 31) % 251;
  fs.writeFileSync(fp, content);
  const printer = { id: "pr1", name: "U1 Navy", url: moon.url, connector: "snapmaker-u1-klipper" };
  const connector = { uploadFile: httpUtils.uploadFile, listFiles: httpUtils.listFiles, compareRemoteFile: httpUtils.compareRemoteFile, verifyUpload: httpUtils.verifyUpload, startPrintFile: httpUtils.startPrintFile, cancel: httpUtils.cancel, deleteFile: httpUtils.deleteFile, estop: httpUtils.estop };
  const routes = {};
  const env = {
    console: { log() {}, error() {}, warn() {} }, path, fs, JSON, Date, Math, String, Object, Number, Error, Map, Set, Promise, setTimeout,
    PRINTERS: [printer], JOBS: new Map(), queuedFile: new Map(), pendingLoad: new Map(), ROUTE_STARTED_PRINT: new Set(),
    QUEUED_FILE_PATH: path.join(base, "queued-files.json"),
    CFG: { allowUploadWhilePrinting: true, skipIdenticalUploads: true },
    netfs: { stat: async f => { const s = fs.statSync(f); return { size: s.size, mtimeMs: s.mtimeMs }; }, identity: fileIdentity },
    printerVisibleTo: () => true,
    resolveFileRef: async (user, root, file) => ({ fp, dir: base, root: "gcode" }),
    relOf: ref => path.relative(ref.dir, ref.fp).split(path.sep).join("/"),
    fileExists: async f => fs.existsSync(f),
    resolvePrintPlate: async () => ({ plate: null }),
    libraryPrintIdentity: async () => IDENT,
    replyFileRefError: () => false,
    fileTypeRefusal: () => null, getCapabilities: () => ({}),
    assertNotActiveJobFile: async () => {}, withGcodeHolds: h => h, holdGcodeFile: () => true, gcodeFileBeingDeleted: () => false, BEING_DELETED: n => n + " is being deleted.",
    queueDispatchJob: () => null, queueSendingRefusal: () => "",
    isPrinterIdle: async () => true,
    getConnector: () => connector,
    queueStore: {},
    actorFromReq: () => ({ userId: "u1", userLabel: "Eran" }),
    whileUploading: fn => fn(), withStartSequence: async (p, fn) => fn(),
    printerHasAnyDefaultPref: () => false, wantsAnyPref: () => false,
    auditLog: { log: () => 1 }, library: { recordPrintStart: () => {} },
    requireRegular: (req, res, next) => next(),
    app: { post: (route, ...fns) => { routes[route] = fns[fns.length - 1]; } },
  };
  vm.createContext(env);
  loadUploadOutcomeHelpers(env, serverSrc);
  vm.runInContext("let jobN = 0; const newJobId = () => 'j' + (++jobN);", env);
  vm.runInContext(lineSrc("const sendRef = (ref, ident, plate) =>"), env);
  vm.runInContext(serverSrc.slice(serverSrc.indexOf("const libraryAudit = id =>"), serverSrc.indexOf("\n", serverSrc.indexOf("const libraryAudit = id =>"))), env);
  for (const m of ["function checkToolMap(", "function stagedChoices(", "function uploadDisposition(", "async function decideUpload(", "function saveQueuedFiles(", "function loadQueuedFiles(", "async function checkStagedCopy("]) vm.runInContext(fnSrc(m), env);
  // The Loaded-file check (§37 P5).
  for (const m of ["const STAGED_CHECK_STATES", "const STAGED_CHECK_BASES", "const STAGED_CHECK_MAP", "const stagedSend"]) vm.runInContext(serverSrc.slice(serverSrc.indexOf(m), serverSrc.indexOf("\n", serverSrc.indexOf(m))), env);
  vm.runInContext("this.stagedSend = stagedSend;", env);
  vm.runInContext(routeSrc, env);
  const h = { env, moon, fp, content, printer, connector, routes };
  // Upload only (start false), as a Library send, and wait for the job.
  h.upload = async () => {
    let body;
    const res = { status(c) { this.code = c; return this; }, json(b) { body = b; return this; } };
    await routes["/api/print"]({ body: { file: "Beardie.gcode", printer: 0, start: false, library: { key: "v1", plate: 1 } }, user: { id: "u1", role: "regular" } }, res);
    assert.ok(body && body.jobId, JSON.stringify(body));
    const job = env.JOBS.get(body.jobId);
    for (let i = 0; i < 500 && !job.done; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(job.done && !job.error, job.error || "job did not finish");
    return job;
  };
  h.staged = () => env.queuedFile.get("pr1");
  // What a Print of the Loaded file records as sent: the check, then the send
  // when it found the file present; null otherwise (§37 P5 refuses that Print).
  h.printer = printer; h.connector = connector;
  h.check = async () => { const c = await env.checkStagedCopy(printer, connector, h.staged()); return c.state === "present" ? env.stagedSend(h.staged(), c) : null; };
  return h;
}

test("a Moonraker upload is staged with the file's own size, not the upload body's", async t => {
  const h = await harness(t);
  const job = await h.upload();
  assert.equal(h.moon.uploads, 1);
  assert.ok(job.total > h.content.length, "the upload body carries multipart framing");
  assert.equal(h.moon.files.get("Beardie.gcode").length, h.content.length, "the printer has the file itself");
  assert.equal(h.staged().size, h.content.length, "staged with the file's size");
  assert.equal(h.staged().sizeOf, "file");
  // Started later from the printer: still the copy SnapCon staged, so the
  // Print keeps the Library Variant it was sent as.
  const send = await h.check();
  assert.ok(send, "the printer's copy is recognised as SnapCon's");
  assert.equal(send.copyChecked, true);
  assert.equal(send.library.variantKey, "v1");
});

test("a copy on the printer that really differs in size is still caught", async t => {
  const h = await harness(t);
  await h.upload();
  // Replaced on the printer by a different file under the same name.
  h.moon.files.set("Beardie.gcode", Buffer.alloc(h.content.length - 5000, 1));
  assert.equal(await h.check(), null, "not the copy SnapCon sent: no Print of it is recorded as the Variant (and P5 refuses it)");
  assert.equal((await h.env.checkStagedCopy(h.printer, h.connector, h.staged())).state, "changed", "read off a real Moonraker listing");
});

test("the size survives a restart, still marked as the file's own", async t => {
  const h = await harness(t);
  await h.upload();
  h.env.saveQueuedFiles();
  h.env.queuedFile.clear();
  h.env.loadQueuedFiles();
  assert.equal(h.staged().size, h.content.length);
  assert.equal(h.staged().sizeOf, "file");
  assert.equal((await h.check()).copyChecked, true);
});

test("an entry saved before the fix keeps its Library link, its copy unchecked rather than confirmed", async t => {
  const h = await harness(t);
  h.moon.files.set("Beardie.gcode", Buffer.from(h.content));
  // As written by the old code: the upload body's size (framing included), no sizeOf.
  const legacy = { pr1: { name: "Beardie.gcode", ts: 1, plate: null, send: { plate: null, location: "gcode:Beardie.gcode", library: { variantKey: "v1", contentKey: IDENT.contentKey } }, size: h.content.length + 196 } };
  fs.writeFileSync(h.env.QUEUED_FILE_PATH, JSON.stringify(legacy));
  h.env.loadQueuedFiles();
  assert.equal(h.staged().size, null, "an unreliable size is not kept as evidence");
  const send = await h.check();
  assert.ok(send, "the Library link is not dropped because of the old size");
  assert.equal(send.copyChecked, false, "and the copy is not claimed as checked");
  assert.equal(send.library.variantKey, "v1");
  // Saved again, it stays unknown rather than regaining the old size.
  h.env.saveQueuedFiles();
  assert.equal(JSON.parse(fs.readFileSync(h.env.QUEUED_FILE_PATH, "utf8")).pr1.size, null);
});

test("A4 review R3: a Library file that changes after the Library's check, before it is sent, is not sent", async t => {
  const h = await harness(t);
  h.env.libraryPrintIdentity = async () => {
    const st = fs.statSync(h.fp);
    const id = { ...IDENT, size: st.size, mtimeMs: st.mtimeMs };
    fs.appendFileSync(h.fp, "; re-exported\n");                 // after the check, before the send
    return id;
  };
  h.env.library.rescan = async () => {};
  let body;
  const res = { status(c) { this.code = c; return this; }, json(b) { body = b; return this; } };
  await h.routes["/api/print"]({ body: { file: "Beardie.gcode", printer: 0, start: false, library: { key: "v1", plate: 1 } }, user: { id: "u1", role: "regular" } }, res);
  const job = h.env.JOBS.get(body.jobId);
  for (let i = 0; i < 500 && !job.done; i++) await new Promise(r => setTimeout(r, 10));
  assert.match(job.error || "", /changed since the Library last read it/);
  assert.equal(h.moon.uploads, 0, "nothing sent");
  assert.equal(h.staged(), undefined);
});

test("A4 review R3: the same, with an edit that keeps the size (only the modified time shows it)", async t => {
  const h = await harness(t);
  h.env.libraryPrintIdentity = async () => {
    const st = fs.statSync(h.fp);
    const id = { ...IDENT, size: st.size, mtimeMs: st.mtimeMs };
    const fd = fs.openSync(h.fp, "r+"); fs.writeSync(fd, Buffer.from(";"), 0, 1, 0); fs.closeSync(fd);
    fs.utimesSync(h.fp, st.atime, new Date(st.mtimeMs + 5000));
    return id;
  };
  h.env.library.rescan = async () => {};
  let body;
  const res = { status(c) { this.code = c; return this; }, json(b) { body = b; return this; } };
  await h.routes["/api/print"]({ body: { file: "Beardie.gcode", printer: 0, start: false, library: { key: "v1", plate: 1 } }, user: { id: "u1", role: "regular" } }, res);
  const job = h.env.JOBS.get(body.jobId);
  for (let i = 0; i < 500 && !job.done; i++) await new Promise(r => setTimeout(r, 10));
  assert.match(job.error || "", /changed since the Library last read it/);
  assert.equal(h.moon.uploads, 0);
});

// ---- Every send uploads (owner, 2026-10-29): a sampled match is not proof ----
// What the printer was asked: anything but listing, reading and uploading
// files would be an operation nobody asked for.
const OTHER_OPS = r => !/^(GET \/server\/files\/(list|directory|gcodes\/.*)|POST \/server\/files\/upload)$/.test(r);
// The printer's copy: same name and size, identical start, middle and end
// (the sampled 64 KB windows), different bytes at 100000 — outside all three.
const differentOutsideWindows = content => { const b = Buffer.from(content); b.write("DIFFERENT", 100000); return b; };
const send = async (h, body = {}) => {
  let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  await h.routes["/api/print"]({ body: { file: "Beardie.gcode", printer: 0, start: false, ...body }, user: { id: "u1", role: "regular" } }, res);
  if (out.body.jobId) { const job = h.env.JOBS.get(out.body.jobId); for (let i = 0; i < 500 && !job.done; i++) await new Promise(r => setTimeout(r, 10)); out.job = job; }
  return out;
};

test("a printer copy with the same name, size and sampled windows but different content elsewhere is replaced by a full upload", async t => {
  const h = await harness(t);
  const theirs = differentOutsideWindows(h.content);
  h.moon.files.set("Beardie.gcode", theirs);
  assert.ok(await httpUtils.compareRemoteFile(h.printer, "Beardie.gcode", h.fp).then(c => c.identical), "the sampled comparison alone calls them identical");
  assert.equal(h.env.CFG.skipIdenticalUploads, true, "with the old skip setting still in config.json");
  const r = await send(h);
  assert.equal(r.job.error, null);
  assert.equal(h.moon.uploads, 1, "uploaded, not skipped");
  assert.ok(h.moon.files.get("Beardie.gcode").equals(h.content), "the printer now has this file, byte for byte");
  assert.equal(h.staged().name, "Beardie.gcode");
  assert.deepEqual(h.moon.requests.filter(OTHER_OPS), [], "no start, cancel, delete or restart");
});

test("an identical file the printer already has is uploaded again, and nothing else happens", async t => {
  const h = await harness(t);
  h.moon.files.set("Beardie.gcode", Buffer.from(h.content));
  const r = await send(h);
  assert.equal(r.job.error, null);
  assert.equal(h.moon.uploads, 1);
  assert.equal(r.job.skippedUpload, undefined);
  assert.deepEqual(h.moon.requests.filter(OTHER_OPS), []);
});

test("replacing switched off: a printer that has the name, or cannot say, refuses the send; one known not to have it gets it", async t => {
  const h = await harness(t);
  h.env.CFG.overwriteDifferentFiles = false;
  h.moon.files.set("Beardie.gcode", Buffer.from(h.content));          // even byte-identical: not provable
  let r = await send(h);
  assert.equal(r.code, 409);
  assert.equal(r.body.code, "printer_has_file");
  assert.match(r.body.error, /already has a file called "Beardie\.gcode".*can't prove the two are the same/);
  assert.equal(h.moon.uploads, 0);
  assert.deepEqual(h.moon.requests.filter(q => q.startsWith("GET /server/files/gcodes/")), [], "asked by name only: the printer's content is not read");
  h.moon.files.clear(); h.moon.failList = true;                       // cannot say
  r = await send(h);
  assert.equal(r.code, 409);
  assert.match(r.body.error, /couldn't check whether U1 Navy already has a file called/);
  assert.equal(h.moon.uploads, 0, "fails closed: nothing sent on incomplete evidence");
  h.moon.failList = false;                                            // known not to have it
  r = await send(h);
  assert.equal(r.job.error, null);
  assert.equal(h.moon.uploads, 1);
  assert.deepEqual(h.moon.requests.filter(OTHER_OPS), []);
});

test("the file being printed is never sent over, whatever the replace setting", async t => {
  for (const overwrite of [true, false]) {
    const h = await harness(t);
    h.env.CFG.overwriteDifferentFiles = overwrite;
    h.env.assertNotActiveJobFile = async () => { throw Object.assign(new Error("Beardie.gcode is printing on U1 Navy right now"), { status: 409 }); };
    const r = await send(h);
    assert.ok(r.code === 409 || (r.job && r.job.error), String(overwrite));
    assert.equal(h.moon.uploads, 0, String(overwrite));
  }
});
