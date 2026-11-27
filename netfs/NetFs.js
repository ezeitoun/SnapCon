// netfs/NetFs.js — filesystem access to storage that may be on the network
// (the G-code folder, Library locations), built so that a dead or slow NAS
// can make NAS features unavailable but can never freeze SnapCon.
//
// Measured on Windows (docs/library-design.md §22, docs/TODO.md):
//   - a call to an unreachable SMB host blocks ~21 s and cannot be cancelled;
//   - synchronously on the main thread that freezes every request;
//   - through fs.promises it holds one of libuv's four process-wide threads,
//     and four such calls starve every file operation in the process; a
//     bigger pool only moves that cliff.
//
// So every operation here runs synchronously inside a small, fixed set of
// worker threads (netfs-worker.js), in LANES:
//   interactive  file browser, map, thumbnails, upload, print, queue
//   background   the Library indexer and other background work
//   probe        recovery checks of an offline root
// A hung call blocks one worker of one lane, never the main thread and never
// libuv's pool. A background scan cannot take interactive capacity.
//
// The AVAILABILITY BREAKER, per network root (a registered root, or a UNC
// share): a network error or a timeout marks the root offline; while offline,
// operations on it fail at once with NAS_UNREACHABLE instead of each hanging;
// a probe on the probe lane re-checks it, and any successful operation marks
// it online again. The breaker is a resilience mechanism, never proof that a
// file exists: callers still check every file they use, every time.
"use strict";
const path = require("path");
const { Readable } = require("stream");
const crypto = require("crypto");
const { Worker } = require("node:worker_threads");

const WORKER_FILE = path.join(__dirname, "netfs-worker.js");
const { NETWORK_CODES } = require("./codes");

class NasUnreachableError extends Error {
  constructor(root, reason) {
    super(`The storage at ${root} is unreachable${reason ? " (" + reason + ")" : ""}. SnapCon keeps checking and will use it again as soon as it answers.`);
    this.code = "NAS_UNREACHABLE"; this.root = root; this.reason = reason || null;
  }
}

const isUnc = p => /^(\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(p);
function uncShare(p) {
  const m = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)/.exec(p);
  return m ? `\\\\${m[1]}\\${m[2]}`.toLowerCase() : null;
}
const norm = p => path.resolve(String(p)).replace(/[\\/]+$/, "").toLowerCase();

function createNetFs({
  lanes = { interactive: 2, background: 1, probe: 1 },
  opTimeoutMs = 10000, probeEveryMs = 10000, queueWaitMs = 30000,
  log = console, now = Date.now, forceInline = false,
} = {}) {
  const roots = new Map();     // name -> absolute path (registered roots)
  const avail = new Map();     // key -> { key, probePath, status, since, lastOkAt, lastFailAt, lastError, probing }
  const listeners = new Set();
  let inline = forceInline, nextId = 1, stopped = false;
  let fault = null;            // tests only: (op, path) => error code to answer with, or null
  const laneState = {};

  // ---- workers and lanes ----
  function spawn(laneName) {
    const w = { busy: null, worker: null, lane: laneName };
    try { w.worker = new Worker(WORKER_FILE); }
    catch (e) {
      if (!inline) log.warn("[netfs] worker threads unavailable, running file operations in-process: " + e.message);
      inline = true; return null;
    }
    w.worker.on("message", msg => {
      const job = w.busy;
      if (!job || job.id !== msg.id) return;
      w.busy = null;
      w.worker.unref();
      finish(job, msg);
      pump(laneName);
    });
    w.worker.on("error", e => log.error("[netfs] worker error: " + e.message));
    w.worker.on("exit", () => {
      const lst = laneState[laneName];
      if (!lst) return;
      lst.workers = lst.workers.filter(x => x !== w);
      if (w.busy) finish(w.busy, { ok: false, error: { code: "WORKER_EXITED", message: "file worker exited" } });
      if (!stopped) { const n = spawn(laneName); if (n) lst.workers.push(n); pump(laneName); }
    });
    w.worker.unref();
    return w;
  }
  for (const [name, size] of Object.entries(lanes)) {
    laneState[name] = { queue: [], workers: [] };
    if (!forceInline) for (let i = 0; i < size; i++) { const w = spawn(name); if (w) laneState[name].workers.push(w); }
  }

  function pump(laneName) {
    const lst = laneState[laneName];
    while (lst.queue.length) {
      const w = lst.workers.find(x => !x.busy);
      if (!w) return;
      const job = lst.queue.shift();
      // The root went offline while this job waited: fail it at once.
      if (job.key && isOffline(job.key) && !job.isProbe) { reject(job, new NasUnreachableError(job.key, stateOf(job.key).lastError)); continue; }
      w.busy = job;
      job.worker = w;
      clearTimeout(job.queueTimer);
      armTimeout(job);
      w.worker.ref();   // a worker holding a job keeps the process alive; an idle one never does
      w.worker.postMessage({ id: job.id, op: job.op, args: job.args });
    }
  }

  function finish(job, msg) {
    if (job.done) {
      // Answered after its timeout: the storage did answer, so it counts for
      // the breaker, but nobody is waiting for the value any more.
      if (job.key) { if (msg.ok || !isNetworkError(msg.error)) markOnline(job.key); }
      return;
    }
    if (msg.ok) {
      if (job.key) markOnline(job.key);
      resolve(job, msg.buffer ? Buffer.from(msg.buffer) : msg.result);
    } else {
      const err = Object.assign(new Error(msg.error.message), { code: msg.error.code });
      if (job.key && isNetworkError(msg.error)) { markOffline(job.key, msg.error.message); reject(job, new NasUnreachableError(job.key, msg.error.message)); }
      else { if (job.key && err.code !== "WORKER_EXITED") markOnline(job.key); reject(job, err); }
    }
  }
  const resolve = (job, v) => { if (job.done) return; job.done = true; clearTimeout(job.timer); clearTimeout(job.queueTimer); job.resolve(v); };
  const reject = (job, e) => { if (job.done) return; job.done = true; clearTimeout(job.timer); clearTimeout(job.queueTimer); job.reject(e); };
  // The operation timeout runs from the moment a worker takes the job, not
  // from submit: time spent waiting behind other work on a healthy but busy
  // lane says nothing about the storage and must never mark it offline.
  function armTimeout(job) {
    const { key, timeoutMs } = job;
    job.timer = setTimeout(() => {
      // The worker stays busy until Windows gives up; the caller is freed
      // now, and the root is marked offline so nothing else queues on it.
      if (key) markOffline(key, `did not answer within ${timeoutMs / 1000} s`);
      reject(job, key ? new NasUnreachableError(key, `did not answer within ${timeoutMs / 1000} s`)
        : Object.assign(new Error(`file operation did not answer within ${timeoutMs / 1000} s`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    job.timer.unref && job.timer.unref();
  }
  // A root just went offline: everything queued for it fails now rather than
  // waiting for a worker only to be refused.
  function failQueuedFor(key) {
    for (const lst of Object.values(laneState)) {
      lst.queue = lst.queue.filter(job => {
        if (job.key !== key || job.isProbe) return true;
        reject(job, new NasUnreachableError(key, stateOf(key).lastError));
        return false;
      });
    }
  }
  const isNetworkError = e => !!e && NETWORK_CODES.has(e.code);

  function submit(op, args, { lane = "interactive", path: forPath, timeoutMs = opTimeoutMs, isProbe = false } = {}) {
    if (stopped) return Promise.reject(Object.assign(new Error("netfs stopped"), { code: "NETFS_STOPPED" }));
    const key = forPath != null ? keyFor(forPath) : null;
    if (key && isOffline(key) && !isProbe) return Promise.reject(new NasUnreachableError(key, stateOf(key).lastError));
    if (inline) {
      // Degraded mode, only if worker threads cannot start: the old
      // synchronous behaviour, no worse than before netfs existed.
      try {
        const v = require("./netfs-worker").run(op, args);
        if (key) markOnline(key);
        return Promise.resolve(v);
      } catch (e) {
        if (key && isNetworkError(e)) { markOffline(key, e.message); return Promise.reject(new NasUnreachableError(key, e.message)); }
        return Promise.reject(e);
      }
    }
    const lst = laneState[lane];
    if (!lst) return Promise.reject(new Error("unknown netfs lane: " + lane));
    const injected = fault && forPath != null ? fault(op, String(forPath)) : null;
    if (injected) {
      // Exactly what the worker reports for a failed call, through the same path.
      return new Promise((res, rej) => finish({ op, key, resolve: res, reject: rej, done: false }, { ok: false, error: { code: injected, message: injected + ": simulated, " + op } }));
    }
    return new Promise((res, rej) => {
      const job = { id: nextId++, op, args, key, isProbe, timeoutMs, resolve: res, reject: rej, done: false };
      // Waiting for a worker is bounded separately: every worker of the lane
      // can be stuck in calls Windows takes ~21 s to abandon. That is lane
      // congestion, not this root's failure, so it does not touch the breaker.
      job.queueTimer = setTimeout(() => {
        lst.queue = lst.queue.filter(j => j !== job);
        reject(job, Object.assign(new Error("file access is busy — every worker is waiting on storage that has not answered"), { code: "NETFS_BUSY" }));
      }, queueWaitMs);
      job.queueTimer.unref && job.queueTimer.unref();
      lst.queue.push(job);
      pump(lane);
    });
  }

  // ---- availability breaker ----
  function keyFor(p) {
    const n = norm(p);
    let best = null;
    for (const [, r] of roots) { const rn = norm(r); if ((n === rn || n.startsWith(rn + path.sep)) && (!best || rn.length > best.length)) best = rn; }
    return best || uncShare(String(p));   // an unregistered local path has no breaker
  }
  function stateOf(key) {
    if (!avail.has(key)) avail.set(key, { key, probePath: probePathFor(key), status: "online", since: now(), lastOkAt: null, lastFailAt: null, lastError: null, probing: false });
    return avail.get(key);
  }
  function probePathFor(key) {
    for (const [, r] of roots) if (norm(r) === key) return r;
    return key;
  }
  const isOffline = key => avail.has(key) && avail.get(key).status !== "online";
  function emit(s) { for (const fn of listeners) { try { fn({ ...s }); } catch {} } }
  function markOnline(key) {
    const s = stateOf(key);
    s.lastOkAt = now();
    if (s.status !== "online") { s.status = "online"; s.since = now(); s.lastError = null; log.log(`[netfs] ${key} is reachable again`); emit(s); }
  }
  function markOffline(key, reason) {
    const s = stateOf(key);
    s.lastFailAt = now(); s.lastError = reason || null;
    if (s.status === "online") { s.status = "offline"; s.since = now(); log.warn(`[netfs] ${key} is unreachable: ${reason}`); emit(s); }
    failQueuedFor(key);
    scheduleProbe(key);
  }
  // One probe at a time per root, on the probe lane, every probeEveryMs while
  // it is offline. Windows answers a known-dead host in milliseconds for ~40 s
  // after a failure, so most probes are cheap; the occasional 21 s one blocks
  // only the probe worker.
  function scheduleProbe(key) {
    const s = stateOf(key);
    if (s.probeTimer || stopped) return;
    s.probeTimer = setTimeout(async () => {
      s.probeTimer = null;
      if (s.status === "online" || stopped) return;
      s.status = "checking"; emit(s);
      try { await submit("stat", [s.probePath], { lane: "probe", path: s.probePath, isProbe: true, timeoutMs: 30000 }); markOnline(key); }
      catch { if (s.status !== "online") { s.status = "offline"; emit(s); scheduleProbe(key); } }
    }, probeEveryMs);
    s.probeTimer.unref && s.probeTimer.unref();
  }

  // ---- public API ----
  const opts = (p, o = {}) => ({ ...o, path: p });
  const api = {
    NasUnreachableError,
    // Registered roots get their own breaker key and are probed by their own
    // path; any other UNC path is keyed by its share.
    registerRoot(name, absPath) {
      const old = roots.get(name);
      if (absPath) roots.set(name, absPath); else roots.delete(name);
      if (old && (!absPath || norm(old) !== norm(absPath))) avail.delete(norm(old));
    },
    isNetworkPath: p => isUnc(String(p)),
    availability(p) { const key = keyFor(p); return key ? { ...stateOf(key), probeTimer: undefined } : { key: null, status: "online" }; },
    // Cheap gate for a request handler: throws NAS_UNREACHABLE when the root
    // is known offline, without touching the filesystem.
    assertAvailable(p) { const key = keyFor(p); if (key && isOffline(key)) throw new NasUnreachableError(key, stateOf(key).lastError); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // An error from file access that did not go through netfs (a download
    // writing with fs.promises): a network error still marks the root offline.
    noteError(p, e) { const key = keyFor(p); if (key && isNetworkError(e)) markOffline(key, e.message); },

    stat: (p, o) => submit("stat", [p], opts(p, o)),
    lstat: (p, o) => submit("lstat", [p], opts(p, o)),
    identity: (p, o) => submit("identity", [p], opts(p, o)),
    exists: (p, o) => submit("exists", [p], opts(p, o)),
    readdir: (p, o) => submit("readdir", [p], opts(p, o)),
    realpath: (p, o) => submit("realpath", [p], opts(p, o)),
    quickFp: (p, o) => submit("quickFp", [p], opts(p, o)),
    openable: (p, o) => submit("openable", [p], opts(p, o)),
    listDir: (p, filter, o = {}) => { const { keepErrors, ...rest } = o; return submit("listDir", [p, { filter: filter ? filter.source : null, keepErrors: !!keepErrors }], opts(p, rest)); },
    read: (p, pos, len, o) => submit("read", [p, pos, len], opts(p, o)),
    readFile: (p, maxBytes, o) => submit("readFile", [p, maxBytes], opts(p, o)),
    writeFileExclusive: (p, data, o) => submit("writeFileExclusive", [p, data], opts(p, { timeoutMs: 120000, ...o })),
    mkdir: (p, mo, o) => submit("mkdir", [p, mo || {}], opts(p, o)),
    rename: (a, b, o) => submit("rename", [a, b], opts(a, o)),
    moveNoReplace: (a, b, o) => submit("moveNoReplace", [a, b], opts(a, o)),
    unlinkFile: (p, expect, o) => submit("unlinkFile", [p, expect], opts(p, o)),
    walk: (dir, wo, o) => submit("walk", [dir, { ...wo, filter: wo.filter ? wo.filter.source : null }], opts(dir, { timeoutMs: 60000, ...o })),
    firmwareInspect: (p, io, o) => submit("firmwareInspect", [p, io || {}], opts(p, { timeoutMs: 60000, ...o })),
    threemfRead: (p, ro, o) => submit("threemfRead", [p, ro], opts(p, o)),
    threemfPlateThumbnail: (p, plate, o) => submit("threemfPlateThumbnail", [p, plate], opts(p, o)),
    threemfPlateGcode: (p, plate, o) => submit("threemfPlateGcode", [p, plate], opts(p, { timeoutMs: 60000, ...o })),

    // A Readable over the file, one chunk per worker round trip, each with its
    // own timeout: a NAS that dies mid-read fails the stream (and the upload
    // reading it) instead of hanging it.
    createReadStream(p, { lane = "interactive", chunkSize = 1024 * 1024, start = 0, end = Infinity } = {}) {
      let pos = start;
      return new Readable({
        read() {
          const len = Math.min(chunkSize, end - pos + 1);
          if (len <= 0) return this.push(null);
          submit("read", [p, pos, len], { lane, path: p }).then(buf => {
            if (!buf.length) return this.push(null);
            pos += buf.length;
            this.push(buf);
          }, e => this.destroy(e));
        },
      });
    },
    // Full-file SHA-256 from chunked reads: each chunk is bounded by the
    // operation timeout, so a NAS that dies mid-hash fails it.
    async hashFile(p, o = {}) {
      const st = await api.stat(p, o);
      const h = crypto.createHash("sha256");
      for await (const chunk of api.createReadStream(p, { lane: o.lane })) h.update(chunk);
      return { sizeBytes: st.size, mtimeMs: st.mtimeMs, sha256: h.digest("hex") };
    },

    async stop() {
      stopped = true;
      for (const s of avail.values()) clearTimeout(s.probeTimer);
      for (const lst of Object.values(laneState)) {
        for (const job of lst.queue) reject(job, Object.assign(new Error("netfs stopped"), { code: "NETFS_STOPPED" }));
        lst.queue = [];
        await Promise.all(lst.workers.map(w => w.worker.terminate().catch(() => {})));
        lst.workers = [];
      }
    },
    get inline() { return inline; },
    _lanes: laneState,
    _submit: submit,   // tests: runs the worker's __sleep/__fail ops
    _setFault(fn) { fault = fn || null; },   // tests: make operations on a path fail as an unreachable share does
  };
  return api;
}

module.exports = { createNetFs, NasUnreachableError, NETWORK_CODES, WORKER_FILE };
