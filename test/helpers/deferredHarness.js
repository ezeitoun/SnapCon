// test/helpers/deferredHarness.js — runs server.js's own deferred-send code
// (docs/TODO.md §37 P3: the section "Sends waiting for a busy printer", the
// person's actions on a send, the transfer lock) in a vm, against a real
// DeferredStore in a temporary directory and a printer whose storage is a Map.
//
// The connector is scripted: uploadFile stores the bytes it read (or is held
// open with a gate, or fails as told), verifyUpload answers from that storage.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const vm = require("node:vm");
const { loadUploadOutcomeHelpers } = require("./uploadOutcomeHelpers");
const { fileIdentity } = require("./fileIdentity");
const { createDeferredStore, LIMITS, ID_SHAPE } = require("../../transfers/DeferredStore");
const { createTransferResults, RESULT_LIMITS } = require("../../transfers/TransferResults");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
const between = (start, end) => {
  const a = serverSrc.indexOf(start); const b = serverSrc.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error("server.js has no " + start);
  return serverSrc.slice(a, b);
};
const fnSrc = marker => { const at = serverSrc.indexOf(marker); if (at < 0) throw new Error(marker); return serverSrc.slice(at, at + serverSrc.slice(at).search(/\r?\n\}\r?\n/) + 3); };
const lineSrc = marker => { const at = serverSrc.indexOf(marker); if (at < 0) throw new Error(marker); return serverSrc.slice(at, serverSrc.indexOf("\n", at)); };
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const until = async (cond, what, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out waiting for " + what); await new Promise(r => setTimeout(r, 2)); } };

// opts.baseDir: reuse a directory (a "restart"); opts.printers: [{id,name}].
function deferredHarness(t, opts = {}) {
  const base = opts.baseDir || fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-deferred-srv-"));
  if (!opts.baseDir) t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const srcDir = path.join(base, "gcode");
  fs.mkdirSync(srcDir, { recursive: true });
  const h = {
    base, srcDir, storage: opts.storage || new Map(), audits: [], idle: true, online: true, uploads: [], verifyCalls: 0,
    uploadGate: null, uploadFail: null, verify: null, free: 1e12, logs: [], hashCache: new Map(),
  };
  const printers = (opts.printers || [{ id: "pA", name: "U1 A" }, { id: "pB", name: "U1 B" }]).map(p => ({ url: "http://" + p.id, connector: "x", ...p }));
  const connector = {
    uploadFile: async (p, fp, name, job) => {
      const bytes = fs.readFileSync(fp);
      job.total = bytes.length; job.sent = 0;
      const u = { printer: p.id, name, bytes };
      h.uploads.push(u);
      job.cancelUpload = () => { job.cancelRequested = true; job.cancelUpload = null; u.cancelled = true; };
      if (h.uploadGate) await h.uploadGate;
      if (u.cancelled) throw Object.assign(new Error("Upload cancelled"), { code: "UPLOAD_CANCELLED", outcome: "failed" });
      job.cancelUpload = null;
      if (h.uploadFail) { const e = h.uploadFail; h.uploadFail = null; throw e; }
      h.storage.set(p.id + "/" + name, bytes);
      job.sent = bytes.length;
    },
    verifyUpload: async (p, name, localPath, o = {}) => {
      h.verifyCalls++;
      if (h.verify) return typeof h.verify === "function" ? h.verify(p, name, localPath, o) : h.verify;
      const held = h.storage.get(p.id + "/" + name);
      if (!held) return { result: "absent", evidence: "not listed" };
      if (localPath) return held.equals(fs.readFileSync(localPath)) ? { result: "verified", basis: "content", evidence: "x" } : { result: "mismatch", basis: "content", evidence: "x" };
      if (o.localSize == null) return { result: "acknowledged", basis: "name", evidence: "x" };
      return held.length === o.localSize ? { result: "acknowledged", basis: "size", evidence: "x" } : { result: "mismatch", basis: "size", evidence: "x" };
    },
    startPrintFile: async () => { h.started = (h.started || 0) + 1; },
    listFiles: async p => [...h.storage].filter(([k]) => k.startsWith(p.id + "/")).map(([k, b]) => ({ path: k.slice(p.id.length + 1), size: b.length })),
  };
  const store = createDeferredStore({ baseDir: base, freeBytes: () => h.free });
  h.loadStatus = store.load();
  // server.js's own isProtected rule (read from its source below).
  let isProtected = () => false;
  const results = createTransferResults({ baseDir: base, isProtected: tid => isProtected(tid), ...(opts.resultsOpts || {}) });
  const routes = {};
  const env = {
    console: { log: (...a) => h.logs.push(a.join(" ")), error() {}, warn() {} },
    path, fs, Date, JSON, Promise, Error, Math, Number, Object, Array, Map, Set, String, Buffer, setTimeout, setImmediate,
    CFG: opts.cfg || {}, PRINTERS: printers, JOBS: new Map(), STARTING: new Map(), queuedFile: new Map(),
    QUEUED_FILE_PATH: path.join(base, "queued-files.json"),
    deferredStore: store, DEFERRED_LIMITS: LIMITS, transferResults: results, RESULT_LIMITS, ID_SHAPE, SERVER_STARTED_AT: 1,
    NOTIFY_TOKEN: "tok", isLoopback: req => ["127.0.0.1", "::1"].includes(req.socket.remoteAddress), timingSafeTokenEqual: (a, b) => a === b,
    getConnector: () => connector, getCapabilities: () => ({ maxMapTools: 32, maxMapHeads: 4 }), assertNotActiveJobFile: async () => {}, withGcodeHolds: h => h, holdGcodeFile: () => true, gcodeFileBeingDeleted: () => false, BEING_DELETED: n => n + " is being deleted.", whileUploading: fn => fn(), withStartSequence: (p, fn) => fn(),
    printerHasAnyDefaultPref: () => false, wantsAnyPref: () => false, ROUTE_STARTED_PRINT: new Set(),
    netfs: { stat: async p => fs.statSync(p), identity: fileIdentity, availability: () => ({ status: "online" }) },
    // As QueueStore.computeFileHash: cached by size and mtime unless forced —
    // so a caller that forgets { force: true } is caught (P3 test review F2).
    queueStore: { computeFileHash: async (p, { force = false } = {}) => {
      const st = fs.statSync(p), c = h.hashCache.get(p);
      if (!force && c && c.size === st.size && c.mtimeMs === st.mtimeMs) return { sizeBytes: c.size, sha256: c.sha256 };
      const b = fs.readFileSync(p); const v = { size: b.length, mtimeMs: st.mtimeMs, sha256: sha(b) };
      h.hashCache.set(p, v); return { sizeBytes: v.size, sha256: v.sha256 };
    } },
    isPrinterIdle: async () => h.idle,
    probeCached: async () => ({ online: h.online, state: "standby" }),
    printerVisibleTo: (u, p) => !(u && u.hidden && u.hidden.includes(p.id)),
    actorFromReq: req => ({ userId: (req && req.user && req.user.id) || "u1", userLabel: "Eran" }),
    auditLog: { log: e => { h.audits.push(e); return 1; } },
    library: { recordPrintStart: () => Promise.resolve(null) },
    requireRegular: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
    app: { post: (r, ...fns) => { routes["POST " + r] = fns[fns.length - 1]; }, get: (r, ...fns) => { routes["GET " + r] = fns[fns.length - 1]; } },
  };
  env.__deferredSection = true;
  vm.createContext(env);
  vm.runInContext("let jobN = 0; const newJobId = () => 'j' + (++jobN);", env);
  vm.runInContext("function printerById(id) { return PRINTERS.find(p => p.id === id); }", env);
  vm.runInContext("const queueSendingRefusal = (p, job) => `${p.name} is receiving its next queued job (\"${job.file}\"). Try again once it has started.`;", env);
  loadUploadOutcomeHelpers(env, serverSrc);
  vm.runInContext(lineSrc("const DEFERRED_LIMIT_KEYS"), env);
  for (const m of ["function checkToolMap(", "function stagedChoices(", "function transferResultLimitsFromConfig(", "function deferredLimitsFromConfig(", "function warnOnce(", "function saveQueuedFiles(", "function loadQueuedFiles("]) vm.runInContext(fnSrc(m), env);
  vm.runInContext(lineSrc("const STAGED_CHECK_STATES"), env);
  vm.runInContext(lineSrc("const STAGED_CHECK_BASES"), env);
  // The deferred-send section itself, up to (not including) its timer.
  vm.runInContext(between("// ---- Sends waiting for a busy printer (§37 P3) ----", "setInterval(() => {\n  pumpDeferred()"), env);
  vm.runInContext(lineSrc("const deferredRow = "), env);
  vm.runInContext(between("// ---- A person's actions on a deferred send (§37 P3) ----", "const normPrinterName"), env);
  vm.runInContext("this.pumpDeferred = pumpDeferred; this.reconcileDeferred = reconcileDeferred; this.deferredStartup = deferredStartup; this.acceptDeferredSend = acceptDeferredSend; this.deferredWaiting = deferredWaiting; this.transferBusy = transferBusy; this.deferredCheckedAt = deferredCheckedAt; this.syncDeferredResults = syncDeferredResults; this.applyDeferredCompleted = applyDeferredCompleted; this.completeDeferred = completeDeferred; this.deferredRow = deferredRow; this.transferResultLimitsFromConfig = transferResultLimitsFromConfig;", env);

  const prot = lineSrc("const transferResults = createTransferResults(").match(/isProtected: (tid => \{.*\}) \}\);$/);
  if (!prot) throw new Error("server.js's isProtected rule not found");
  isProtected = vm.runInContext("(" + prot[1] + ")", env);
  results.load();
  h.env = env; h.store = store; h.results = results; h.printers = printers; h.connector = connector;
  h.file = (name, content) => { const f = path.join(srcDir, name); fs.writeFileSync(f, content); return f; };
  h.p = id => printers.find(p => p.id === id);
  // Accepts a send as /api/print's defer path does.
  h.sendLater = (printerId, name, content, extra = {}) => {
    const file = extra.buffer ? null : h.file(name, content);
    return env.acceptDeferredSend(h.p(printerId), { name, kind: extra.buffer ? "push" : "folder", file, buffer: extra.buffer || null, actor: { userId: "u1", userLabel: "Eran" }, ...extra });
  };
  h.jobs = () => [...env.JOBS.values()];
  // One pass of the sender, and every send it started run to its end.
  h.pump = async () => { await env.pumpDeferred(); await until(() => h.jobs().every(j => j.done), "the sends to finish"); };
  h.call = async (method, route, params = {}, body = {}, user = { id: "u1", role: "regular" }, extra = {}) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[method + " " + route]({ params, body, user, query: {}, headers: {}, socket: { remoteAddress: "127.0.0.1" }, ...extra }, res);
    return res;
  };
  h.state = id => (store.get(id) || {}).state;
  return h;
}

module.exports = { deferredHarness, until, sha };
