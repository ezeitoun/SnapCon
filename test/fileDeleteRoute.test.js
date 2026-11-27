// test/fileDeleteRoute.test.js — the server side of deleting G-code folder
// files (POST /api/files/delete, fileTrash.js does the moving).
//
// gcodeFileInUse() decides which files must stay: run here from server.js's
// own source against the stores it reads. The routes are checked by their
// source (server.js has no exports and starts a listener; see
// threemfRoutes.test.js), and the trash's exclusion from the File Browser and
// the Library by the rules that keep it out.
const test = require("node:test");
const { routeEnd } = require("./helpers/routeEnd");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const { resolveWithinFolder } = require("../pathSafety");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
function extractFn(name) {
  const at = serverSrc.indexOf("function " + name + "(");
  assert.ok(at > 0, name + " must exist in server.js");
  return serverSrc.slice(at, serverSrc.indexOf("\n}", at) + 2);
}
function routeSrc(start) {
  const at = serverSrc.indexOf(start);
  assert.ok(at > 0, start);
  return serverSrc.slice(at, routeEnd(serverSrc, at) + 4);
}

const FOLDER = path.resolve("/srv/gcode");
const fp = rel => path.join(FOLDER, rel);
function inUse(fileRel, state = {}) {
  const sandbox = {
    path, resolveWithinFolder, FOLDER, GCODE_ROOT: "gcode", process,
    printerVisibleTo: (user, p) => !user || !user.hidden || !user.hidden.includes(p.id),
    PRINTERS: [{ id: "p_1", name: "U1 Navy" }, { id: "p_2", name: "U1 Red" }],
    JOBS: new Map(Object.entries(state.jobs || {})),
    deferredStore: {
      status: () => ({ recoveryRequired: false, dropped: 0, ...(state.deferredStatus || {}) }),
      list: ({ states }) => (state.deferred || []).filter(r => states.includes(r.state)),
    },
    queueStore: {
      getGlobalStatus: () => ({ queueStoreRecoveryRequired: !!state.queueBroken }),
      getPrinterState: id => (state.queues || {})[id] || { queue: [], currentItem: null },
    },
  };
  vm.createContext(sandbox);
  const at = serverSrc.indexOf("const DELETING = new Map();");
  vm.runInContext(serverSrc.slice(at, serverSrc.indexOf("// Why the G-code folder file at fp", at)) + "\n" + extractFn("gcodeFileInUse"), sandbox);
  return vm.runInContext("gcodeFileInUse", sandbox)(fp(fileRel), state.user || null);
}

test("a file nothing refers to can be deleted", () => {
  assert.equal(inUse("U1/a.gcode", {
    jobs: { j1: { done: false, printerId: "p_1", sourcePath: fp("U1/other.gcode") } },
    deferred: [{ state: "queued", printerName: "U1 Navy", source: { path: fp("U1/other.gcode") } }],
    queues: { p_1: { queue: [{ file: { sub: "U1", name: "other.gcode" } }], currentItem: null } },
  }), null);
});

test("an upload reading the file keeps it; a finished one does not", () => {
  assert.equal(inUse("U1/a.gcode", { jobs: { j1: { done: false, printerId: "p_2", sourcePath: fp("U1/a.gcode") } } }), "It is being sent to U1 Red.");
  assert.equal(inUse("U1/a.gcode", { jobs: { j1: { done: true, printerId: "p_2", sourcePath: fp("U1/a.gcode") } } }), null);
});

test("a waiting send that will read the file keeps it, in every state that can still send", () => {
  for (const s of ["queued", "uploading", "interrupted", "attention"]) {
    assert.match(inUse("a.gcode", { deferred: [{ state: s, printerId: "p_1", printerName: "U1 Navy", source: { path: fp("a.gcode") } }] }) || "", /A send to U1 Navy is waiting for it/, s);
  }
  // A completed send no longer reads it; a slicer push sends its own copy.
  assert.equal(inUse("a.gcode", { deferred: [{ state: "completed", printerName: "U1 Navy", source: { path: fp("a.gcode") } }] }), null);
  assert.equal(inUse("a.gcode", { deferred: [{ state: "queued", printerName: "U1 Navy", bytes: { size: 1 }, source: { kind: "push" } }] }), null);
});

test("a queue item naming the file keeps it, pending or current; a Library location's item does not", () => {
  assert.equal(inUse("U1/a.gcode", { queues: { p_2: { queue: [{ file: { sub: "U1", name: "a.gcode" } }], currentItem: null } } }), "It is in U1 Red's queue. Remove it from the queue first.");
  assert.match(inUse("a.gcode", { queues: { p_1: { queue: [], currentItem: { file: { sub: "", name: "a.gcode" } } } } }) || "", /U1 Navy's queue/);
  assert.equal(inUse("a.gcode", { queues: { p_1: { queue: [{ file: { sub: "", name: "a.gcode", root: "loc_nas2" } }], currentItem: null } } }), null);
  assert.match(inUse("a.gcode", { queues: { p_1: { queue: [{ file: { sub: "", name: "a.gcode", root: "gcode" } }], currentItem: null } } }) || "", /queue/);
});

test("a printer the user may not see is not named in the reason", () => {
  const user = { hidden: ["p_2"] };
  assert.equal(inUse("a.gcode", { user, jobs: { j1: { done: false, printerId: "p_2", sourcePath: fp("a.gcode") } } }), "It is being sent to a printer.");
  assert.equal(inUse("a.gcode", { user, deferred: [{ state: "queued", printerId: "p_2", printerName: "U1 Red", source: { path: fp("a.gcode") } }] }), "A send to a printer is waiting for it. Cancel that send first.");
  assert.equal(inUse("a.gcode", { user, queues: { p_2: { queue: [{ file: { sub: "", name: "a.gcode" } }], currentItem: null } } }), "It is in a printer's queue.");
  // Still refused: hiding the name never lets the delete through.
  assert.match(inUse("a.gcode", { user: { hidden: [] }, queues: { p_2: { queue: [{ file: { sub: "", name: "a.gcode" } }], currentItem: null } } }) || "", /U1 Red's queue/);
});

test("when waiting sends or the queue cannot be read, every delete is refused", () => {
  assert.match(inUse("a.gcode", { deferredStatus: { recoveryRequired: true } }) || "", /waiting sends can't be fully read/);
  assert.match(inUse("a.gcode", { deferredStatus: { dropped: 2 } }) || "", /waiting sends can't be fully read/);
  assert.match(inUse("a.gcode", { queueBroken: true }) || "", /print queue can't be read/);
});

test("an upload's job records the file it reads", () => {
  // Without sourcePath on /api/print's job, an Upload in progress could not
  // keep its file.
  assert.match(serverSrc, /const job = \{ phase: "upload",[^\n]*printerId: p\.id, file: name, sourcePath: fp,/);
});

test("the delete route: Regular and Admin only, print files only, in-use checked, audited per file", () => {
  const src = routeSrc('app.post("/api/files/delete", requireRegular,');
  assert.match(src, /fileTrash\.deleteFiles\(\{ io: TRASH_IO, folder: FOLDER, files, mode, inUse: fp => gcodeFileInUse\(fp, req\.user\), reserve: reserveGcodeDelete, release: releaseGcodeDelete, allowed: SLICED_FILE_RE, actor \}\)/);
  assert.match(src, /files\.length > fileTrash\.MAX_FILES/);
  assert.match(src, /event: r\.ok \? "file-deleted" : "file-delete-unconfirmed", \.\.\.actor, detail: \{ file: rel, method: mode, \.\.\.\(mode === "trash" \? \{ trash: out\.batch \} : \{\}\) \}/);
  assert.match(routeSrc('app.get("/api/files/trash", requireRegular,'), /fileTrash\.listTrash/);
  const restore = routeSrc('app.post("/api/files/trash/restore", requireRegular,');
  assert.match(restore, /fileTrash\.restoreFile/);
  assert.match(restore, /event: "file-restored"/);
  // Every trash call goes through netfs: the G-code folder may be a NAS.
  const io = serverSrc.slice(serverSrc.indexOf("const TRASH_IO = {"), serverSrc.indexOf("};", serverSrc.indexOf("const TRASH_IO = {")));
  assert.doesNotMatch(io, /\bfs\./);
  for (const op of ["stat", "exists", "readdir", "mkdir", "rename", "readFile", "writeFileExclusive"]) assert.match(io, new RegExp("netfs\\." + op + "\\("), op);
});

test("the trash is not shown, browsed, written into or moved to by the File Browser", () => {
  const list = routeSrc('app.get("/api/files", requireAuth,');
  assert.match(list, /if \(!dir \|\| fileTrash\.isInTrash\(dir, FOLDER\)\) return res\.status\(400\)/);
  assert.match(list, /e\.isDirectory && !\(dir === FOLDER && fileTrash\.isTrashRel\(e\.name\)\)/);
  assert.match(routeSrc('app.post("/api/files/mkdir",'), /fileTrash\.isInTrash\(target, FOLDER\)/);
  const move = routeSrc('app.post("/api/files/move",');
  assert.match(move, /fileTrash\.isInTrash\(targetDir, FOLDER\)/);
  assert.match(move, /fileTrash\.isInTrash\(srcPath, FOLDER\)/);
  assert.match(routeSrc('app.post("/api/files/upload",'), /if \(!dir \|\| fileTrash\.isInTrash\(dir, FOLDER\)\)/);
  // The search walk skips every dot-folder, the trash among them.
  assert.match(fs.readFileSync(path.join(ROOT, "netfs", "netfs-worker.js"), "utf8"), /if \(e\.name\.startsWith\("\."\)\) continue;/);
});

test("the Library never scans the trash", () => {
  const scanner = fs.readFileSync(path.join(ROOT, "library", "Scanner.js"), "utf8");
  const m = /const SKIP_DIR = (\/.*\/i);/.exec(scanner);
  assert.ok(m, "Scanner.js SKIP_DIR");
  const SKIP_DIR = vm.runInNewContext(m[1]);
  assert.equal(SKIP_DIR.test(".snapcon-trash"), true);
  assert.equal(SKIP_DIR.test("U1"), false);
});

test("the Dockerfile ships fileTrash.js", () => {
  assert.match(fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8"), /^COPY [^\n]*\bfileTrash\.js\b/m);
});

// ---- Owner review, 2026-11-05 ----

test("no G-code folder route can name a file in the trash: safePath refuses every spelling of it", () => {
  const sandbox = { resolveWithinFolder, FOLDER, fileTrash: require("../fileTrash") };
  vm.createContext(sandbox);
  vm.runInContext(extractFn("safePath"), sandbox);
  const safePath = vm.runInContext("safePath", sandbox);
  for (const p of [".snapcon-trash", ".snapcon-trash/20261105T120000Z-a1b2c3/files/a.gcode", "./.snapcon-trash/x.gcode",
                   "U1/../.snapcon-trash/x.gcode", ".SNAPCON-TRASH/x.gcode", ".snapcon-trash./x.gcode", ".snapcon-trash /x.gcode",
                   "../gcode/.snapcon-trash/x.gcode", "../../etc/passwd"]) {
    assert.equal(safePath(p), null, p);
  }
  assert.equal(safePath("U1/a.gcode"), path.join(FOLDER, "U1/a.gcode"));
  assert.equal(safePath("U1/.snapcon-trash/a.gcode"), path.join(FOLDER, "U1/.snapcon-trash/a.gcode"), "only the folder's own trash is special");
  // resolveFileRef's G-code branch goes through safePath: /api/map, the send
  // dialog's file reads, /api/print, the queue and Library sends of a "gcode" root.
  assert.match(extractFn("resolveFileRef"), /if \(root == null \|\| root === "" \|\| root === GCODE_ROOT\) \{\n\s+const fp = safePath\(file\);/);
});

function reservations() {
  const sandbox = { path, process, resolveWithinFolder, FOLDER, GCODE_ROOT: "gcode", setTimeout: (fn, ms) => { sandbox.held.push({ fn, ms }); return { unref() {} }; }, held: [] };
  vm.createContext(sandbox);
  const at = serverSrc.indexOf("const DELETING = new Map();");
  vm.runInContext(serverSrc.slice(at, serverSrc.indexOf("// Why the G-code folder file at fp", at)), sandbox);
  return sandbox;
}

test("a file being moved to the trash is seen as such until its rename settles; an unknown one is held 10 minutes", () => {
  const s = reservations();
  const r = src => vm.runInContext(src, s);
  const a = fp("U1/a.gcode");
  s.a = a;
  assert.equal(r("gcodeFileBeingDeleted(a)"), false);
  r("reserveGcodeDelete(a)");
  assert.equal(r("gcodeFileBeingDeleted(a)"), true);
  assert.equal(r("queueFileBeingDeleted({ sub: 'U1', name: 'a.gcode' })"), true);
  assert.equal(r("queueFileBeingDeleted({ sub: 'U1', name: 'a.gcode', root: 'loc_2' })"), false, "a Library location is another folder");
  r("releaseGcodeDelete(a, 'moved')");
  assert.equal(r("gcodeFileBeingDeleted(a)"), false);
  r("reserveGcodeDelete(a)"); r("releaseGcodeDelete(a, 'unknown')");
  assert.equal(r("gcodeFileBeingDeleted(a)"), true, "the rename may still happen");
  assert.equal(s.held[0].ms, 10 * 60 * 1000);
  s.held[0].fn();
  assert.equal(r("gcodeFileBeingDeleted(a)"), false);
});

test("a second delete of a file being deleted is refused", () => {
  assert.match(extractFn("gcodeFileInUse"), /if \(DELETING\.has\(k\)\) return "Another delete of this file is in progress\.";/);
  assert.match(routeSrc('app.post("/api/files/delete", requireRegular,'), /reserve: reserveGcodeDelete, release: releaseGcodeDelete/);
});

// Each place that starts using a G-code folder file refuses one being deleted,
// with nothing awaited between that check and the point it is recorded — so
// the delete's own last check (synchronous, then the reservation) and this one
// can never both pass.
function noAwaitBetween(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, from + " … " + to);
  assert.doesNotMatch(src.slice(a, b), /\bawait\b/, "nothing awaited between " + from + " and " + to);
}
test("an Upload, a waiting send and every queue add refuse a file being deleted, right where they register", () => {
  noAwaitBetween(serverSrc, 'if (gcodeFileBeingDeleted(fp)) return res.status(409).json({ error: BEING_DELETED(name), code: "file_being_deleted" });', "JOBS.set(jobId, job);");
  noAwaitBetween(serverSrc, 'if (file && gcodeFileBeingDeleted(file)) throw httpError(409, BEING_DELETED(name), "file_being_deleted");', "rec = deferredStore.add(");
  noAwaitBetween(serverSrc, "if (gcodeFileBeingDeleted(fp)) return false;", "const result = queueStore.applyIntent(p.id, (state) => ({");
  noAwaitBetween(serverSrc, "const deleting = items.find(i => queueFileBeingDeleted(i.file));", "queue: [...state.queue, ...items]");
  noAwaitBetween(serverSrc, "const deleting = resolved.find(f => queueFileBeingDeleted(f));", "const result = queueStore.applyBulkIntent((current) => {");
});

test("restore goes through the no-overwrite move, never rename", () => {
  const src = fs.readFileSync(path.join(ROOT, "fileTrash.js"), "utf8");
  const restore = src.slice(src.indexOf("async function restoreFile("));
  assert.match(restore, /io\.moveNoReplace\(src, dest\)/);
  assert.doesNotMatch(restore, /io\.rename\(/);
  assert.match(serverSrc, /moveNoReplace: \(a, b\) => netfs\.moveNoReplace\(a, b\)/);
});

// ---- Two methods, holds (owner review 2, 2026-11-05) ----

test("permanent delete: only a signed-in Admin with accounts on — never while accounts are off", () => {
  const sandbox = { CFG: {} };
  vm.createContext(sandbox);
  const line = serverSrc.slice(serverSrc.indexOf("const permanentDeleteAllowed = "), serverSrc.indexOf("\n", serverSrc.indexOf("const permanentDeleteAllowed = ")));
  vm.runInContext(line.replace("const permanentDeleteAllowed", "this.allowed"), sandbox);
  const allowed = (usersEnabled, user) => { sandbox.CFG.usersEnabled = usersEnabled; return sandbox.allowed(user); };
  assert.equal(allowed(false, { role: "admin", implicit: true }), false, "accounts off: everyone is an implicit admin");
  assert.equal(allowed(true, { role: "admin", implicit: true }), false);
  assert.equal(allowed(true, { role: "regular" }), false);
  assert.equal(allowed(true, { role: "viewer" }), false);
  assert.equal(allowed(true, null), false);
  assert.equal(allowed(true, { role: "admin" }), true);
  // Checked before anything is read, and the mode defaults to the trash.
  const route = routeSrc('app.post("/api/files/delete", requireRegular,');
  assert.ok(route.indexOf("permanentDeleteAllowed(req.user)") < route.indexOf("fileTrash.deleteFiles("));
  assert.match(route, /const mode = \(req\.body \|\| \{\}\)\.mode == null \? "trash" : \(req\.body \|\| \{\}\)\.mode;/);
  assert.match(route, /if \(!fileTrash\.MODES\.has\(mode\)\) return res\.status\(400\)/);
  assert.match(route, /return res\.status\(403\)\.json\(\{ error: CFG\.usersEnabled \? "Only an Admin can delete files permanently\." : "Deleting permanently needs user accounts to be switched on\."/);
});

// The reservation and hold block, plus gcodeFileInUse, run for real.
function holds(state = {}) {
  const sandbox = {
    path, process, resolveWithinFolder, FOLDER, GCODE_ROOT: "gcode",
    setTimeout: (fn, ms) => ({ unref() {} }),
    printerVisibleTo: () => true,
    PRINTERS: [{ id: "p_1", name: "U1 Navy" }],
    JOBS: new Map(),
    deferredStore: { status: () => ({ recoveryRequired: false, dropped: 0 }), list: () => state.deferred || [] },
    queueStore: { getGlobalStatus: () => ({}), getPrinterState: () => ({ queue: state.queue || [], currentItem: null }) },
  };
  vm.createContext(sandbox);
  const at = serverSrc.indexOf("const DELETING = new Map();");
  vm.runInContext(serverSrc.slice(at, serverSrc.indexOf("// Why the G-code folder file at fp", at)) + "\n" + extractFn("gcodeFileInUse")
    + "\nthis.api = { holdGcodeFile, releaseGcodeHolds, withGcodeHolds, gcodeFileInUse, reserveGcodeDelete, releaseGcodeDelete, gcodeFileBeingDeleted, PREPARING };", sandbox);
  return sandbox;
}
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };

test("a file being prepared for a send cannot be deleted, by either method, until the send has recorded itself", async t => {
  const fileTrash = require("../fileTrash");
  const { api, JOBS } = holds();
  const os = require("os");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-hold-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, "a.gcode"), "a");
  const fpA = path.join(folder, "a.gcode");
  const io = {
    stat: async p => { const st = fs.statSync(p); return { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() }; },
    mkdir: async (p, o = {}) => { fs.mkdirSync(p, { recursive: !!o.recursive }); }, rename: async (a, b) => fs.renameSync(a, b),
    writeFileExclusive: async (p, d) => fs.writeFileSync(p, d, { flag: "wx" }), unlinkFile: async p => fs.unlinkSync(p),
  };
  const del = mode => fileTrash.deleteFiles({ io, folder, files: [{ sub: "", name: "a.gcode" }], mode, inUse: fp => api.gcodeFileInUse(fp, null), reserve: api.reserveGcodeDelete, release: api.releaseGcodeDelete });

  // A send: holds first, then hashes (held open here), then records its job.
  const hashing = gate();
  const req = {};
  const send = api.withGcodeHolds(async () => {
    assert.equal(api.holdGcodeFile(req, fpA), true);
    await hashing.p;                                    // the hash, the printer's answer…
    JOBS.set("j1", { done: false, printerId: "p_1", sourcePath: fpA });
  })(req, {});
  for (const mode of ["trash", "permanent"]) {
    const out = await del(mode);
    assert.deepEqual([out.results[0].ok, out.results[0].code], [false, "in_use"], mode);
    assert.match(out.results[0].error, /being prepared for a send/);
  }
  hashing.open(); await send;
  assert.equal(api.PREPARING.size, 0, "released once the handler finished");
  // Now recorded: still refused, by the job.
  assert.match((await del("trash")).results[0].error, /being sent to U1 Navy/);
  JOBS.get("j1").done = true;
  assert.equal((await del("trash")).results[0].ok, true, "free once the send is done");
});

test("a send that starts while a delete is moving the file is refused before it reads anything", async t => {
  const fileTrash = require("../fileTrash");
  const { api } = holds();
  const os = require("os");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-hold-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, "a.gcode"), "a");
  const fpA = path.join(folder, "a.gcode");
  const renaming = gate();
  const io = {
    stat: async p => { const st = fs.statSync(p); return { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() }; },
    mkdir: async (p, o = {}) => { fs.mkdirSync(p, { recursive: !!o.recursive }); },
    rename: async (a, b) => { await renaming.p; fs.renameSync(a, b); },
    writeFileExclusive: async (p, d) => fs.writeFileSync(p, d, { flag: "wx" }),
  };
  const deleting = fileTrash.deleteFiles({ io, folder, files: [{ sub: "", name: "a.gcode" }], inUse: fp => api.gcodeFileInUse(fp, null), reserve: api.reserveGcodeDelete, release: api.releaseGcodeDelete });
  for (let i = 0; i < 20 && !api.gcodeFileBeingDeleted(fpA); i++) await new Promise(r => setImmediate(r));
  assert.equal(api.holdGcodeFile({}, fpA), false, "the send is refused while the rename runs");
  renaming.open();
  assert.equal((await deleting).results[0].ok, true);
  assert.equal(api.gcodeFileBeingDeleted(fpA), false);
});

test("holds are released however the handler ends — returned, thrown, or the client hung up mid-way", async () => {
  const { api } = holds();
  const fp1 = fp("a.gcode");
  // Returned early (an error answer)
  const r1 = {}; await api.withGcodeHolds(async req => { api.holdGcodeFile(req, fp1); return "409"; })(r1, {});
  assert.equal(api.PREPARING.size, 0);
  // Threw (a NAS timeout the handler did not catch)
  const r2 = {};
  await assert.rejects(api.withGcodeHolds(async req => { api.holdGcodeFile(req, fp1); throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); })(r2, {}), /timed out/);
  assert.equal(api.PREPARING.size, 0);
  // The client hung up while the handler still hashes: the response closing
  // must not release it — only the handler finishing does.
  const hashing = gate();
  const r3 = {}, res = new (require("events").EventEmitter)();
  const running = api.withGcodeHolds(async req => { api.holdGcodeFile(req, fp1); await hashing.p; })(r3, res);
  res.emit("close");
  await new Promise(r => setImmediate(r));
  assert.equal(api.PREPARING.size, 1, "still held after the response closed");
  assert.match(api.gcodeFileInUse(fp1, null), /being prepared for a send/);
  hashing.open(); await running;
  assert.equal(api.PREPARING.size, 0);
  // Two sends of one file: both must finish before it is free.
  const a = gate(), b = gate();
  const s1 = api.withGcodeHolds(async req => { api.holdGcodeFile(req, fp1); await a.p; })({}, {});
  const s2 = api.withGcodeHolds(async req => { api.holdGcodeFile(req, fp1); await b.p; })({}, {});
  a.open(); await s1;
  assert.match(api.gcodeFileInUse(fp1, null) || "", /being prepared/);
  b.open(); await s2;
  assert.equal(api.gcodeFileInUse(fp1, null), null);
});

test("background work already recorded keeps its file: a waiting send, a queue item, a running upload", () => {
  const fpA = fp("a.gcode");
  assert.match(holds({ deferred: [{ state: "uploading", printerId: "p_1", source: { path: fpA } }] }).api.gcodeFileInUse(fpA, null), /waiting for it/);
  assert.match(holds({ queue: [{ status: "dispatching", file: { sub: "", name: "a.gcode" } }] }).api.gcodeFileInUse(fpA, null), /queue/);
  const s = holds(); s.JOBS.set("j", { done: false, printerId: "p_1", sourcePath: fpA });
  assert.match(s.api.gcodeFileInUse(fpA, null), /being sent/);
});

test("every send path holds its file before its first file-dependent await, inside withGcodeHolds", () => {
  for (const r of ['app.post("/api/print", requireRegular, withGcodeHolds(async (req, res) => {',
                   'app.post("/api/queue/:printerId/items", requireRegular, withGcodeHolds(async (req, res) => {',
                   'app.post("/api/queue/send", requireRegular, withGcodeHolds(async (req, res) => {',
                   'app.post("/api/notify-load", refuseOversizePush, rawGcodeBody, withGcodeHolds(async (req, res) => {']) {
    assert.ok(serverSrc.includes(r), r);
  }
  // /api/print: resolve → hold → exists.
  assert.ok(serverSrc.includes("    ref = await resolveFileRef(req.user, root, file);\n    // Held before anything reads it (holdGcodeFile).\n    if (ref && !holdGcodeFile(req, ref.fp)) return res.status(409)"), "the hold comes straight after the file is resolved");
  const print = serverSrc.slice(serverSrc.indexOf('app.post("/api/print", requireRegular, withGcodeHolds('));
  assert.ok(print.indexOf("holdGcodeFile(req, ref.fp)") < print.indexOf("await fileExists(ref.fp)"));
  // The queue's file resolution (both queue routes use it).
  const rq = extractFn("resolveQueuedFile");
  assert.ok(rq.indexOf("holdGcodeFile(req, ref.fp)") > 0 && rq.indexOf("holdGcodeFile(req, ref.fp)") < rq.indexOf("await fileExists(ref.fp)"));
  assert.ok(rq.indexOf("holdGcodeFile(req, ref.fp)") < rq.indexOf("computeFileHash"));
  // The slicer's file-path send.
  const nl = serverSrc.slice(serverSrc.indexOf('app.post("/api/notify-load",'));
  assert.ok(nl.indexOf("holdGcodeFile(req, absFile)") > 0 && nl.indexOf("holdGcodeFile(req, absFile)") < nl.indexOf("await netfs.stat(absFile)"));
  // The release is the handler's end, never the response's "close".
  const w = serverSrc.slice(serverSrc.indexOf("const withGcodeHolds = "), serverSrc.indexOf("};", serverSrc.indexOf("const withGcodeHolds = ")));
  assert.match(w, /try \{ return await handler\(req, res, next\); \} finally \{ releaseGcodeHolds\(req\); \}/);
  assert.doesNotMatch(w, /on\("close"/);
});

test("an Upload that also queues adds its queue item before its job is marked done", () => {
  // So the file is covered by the job (sourcePath) until the item exists.
  const at = serverSrc.indexOf("if (disposition.queue) await addQueueItem(true);");
  const done = serverSrc.indexOf('job.phase = "done"; job.done = true;', at);
  assert.ok(at > 0 && done > at && done - at < 600);
});

test("every send hold is taken inside a route wrapped in withGcodeHolds, directly or through a helper", () => {
  // A hold taken anywhere else would never be released. For each call, find
  // the top-level construct it is in (a route, or a function); a function's
  // callers are followed the same way, until each path ends at a route.
  const lines = serverSrc.split("\n");
  const topAt = idx => {          // the column-0 route or function containing idx
    const before = serverSrc.slice(0, idx).split("\n");
    for (let i = before.length - 1; i >= 0; i--) {
      const l = before[i];
      let m;
      if ((m = /^app\.(get|post|put|delete|patch)\("([^"]+)"/.exec(l))) return { kind: "route", line: l, name: m[2] };
      if ((m = /^(?:async )?function (\w+)\(/.exec(l))) return { kind: "function", line: l, name: m[1] };
    }
    return { kind: "top" };
  };
  const callsOf = name => { const out = []; const re = new RegExp("\\b" + name + "\\(", "g"); let m;
    while ((m = re.exec(serverSrc))) { const line = serverSrc.slice(serverSrc.lastIndexOf("\n", m.index) + 1, serverSrc.indexOf("\n", m.index));
      if (!/^(?:async )?function /.test(line)) out.push(m.index); } return out; };
  const routes = new Set(), seenFns = new Set();
  const follow = (idx, trail) => {
    const top = topAt(idx);
    assert.notEqual(top.kind, "top", "a hold outside any route or function: " + trail);
    if (top.kind === "route") {
      assert.match(top.line, /withGcodeHolds\(async \(req, res\) => \{$/, `${top.name} takes a hold (${trail}) but is not wrapped in withGcodeHolds`);
      routes.add(top.name); return;
    }
    if (seenFns.has(top.name)) return;
    seenFns.add(top.name);
    const callers = callsOf(top.name);
    assert.ok(callers.length, top.name + " takes a hold and is never called");
    for (const c of callers) follow(c, trail + " ← " + top.name);
  };
  const holds = callsOf("holdGcodeFile");
  assert.ok(holds.length >= 3);
  for (const h of holds) follow(h, "holdGcodeFile");
  assert.deepEqual([...routes].sort(), ["/api/notify-load", "/api/print", "/api/queue/:printerId/items", "/api/queue/send"]);
  assert.deepEqual([...seenFns], ["resolveQueuedFile"]);
  void lines;
});
