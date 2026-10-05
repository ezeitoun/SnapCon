// library/LibraryService.js — the only module server.js talks to for the
// Model Library (docs/library-design.md). M1: the database, its backups,
// Library permissions, and Library locations with their live status. M2: the
// indexer — one location at a time, scheduled by each location's interval,
// paused while SnapCon uploads to a printer — and, when nothing else is
// waiting, the full hash of every file.
"use strict";
const path = require("path");
const crypto = require("crypto");
const { createLibraryStore, backupDue: isBackupDue } = require("./LibraryStore");
const { createAuthorizer } = require("./permissions");
const { createWorkerHost } = require("./WorkerHost");
const { normalizeLocation, comparisonKey, overlaps, checkReachable } = require("./locations");
const { createScanner, summarise } = require("./Scanner");
const { GCODE_META_VERSION, THREEMF_META_VERSION, thumbExt } = require("./indexStore");
const { diagnosticsRaw } = require("./diagnosticsRaw");
const { diagnosticsGrouping, stableExport } = require("./diagnosticsGrouping");
const libraryView = require("./libraryView");
const libraryActions = require("./actions");
const libraryPrints = require("./prints");

const GCODE_ROOT = "gcode";
const NAME_MAX = 60;
const SCAN_MIN = 5, SCAN_MAX = 1440, SCAN_DEFAULT = 30;
const OFFLINE_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000];   // then the location's own interval (§10)
const TICK_MS = 15 * 1000;
const BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
const BACKUP_CHECK_MS = 60 * 60 * 1000;

class LibraryError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function createLibraryService({
  baseDir, getGcodeFolder, audit = () => {}, log = console, now = Date.now,
  platform = process.platform, checkTimeoutMs = 10000, workerOptions = {},
  checkFn = checkReachable,   // injectable for tests
  // M2 indexing. netfs: the shared network-safe file access (netfs/); when
  // absent the process-wide instance is used. uploadsActive(): true while
  // SnapCon is sending a file to a printer, which pauses all Library reads.
  indexing = true, netfs = null, uploadsActive = () => false, scanBudget,
  // M7: may this user see this printer (groupAccess.printerVisibleTo)? Print
  // history rows on other printers are not shown to them (§9 D6).
  printerVisible = () => true,
}) {
  const store = createLibraryStore({ baseDir, now, log }).open();
  const authz = store.available ? createAuthorizer(store.db) : null;
  const thumbsDir = path.join(baseDir, "library-data", "thumbs");
  let worker = null, scanner = null;
  let tickTimer = null, backupTimer = null;
  // The indexer: one location at a time (§6.1). scanQueue holds location ids;
  // `scanning` is the running scan's live stats, `hashing` the idle hash's.
  const scanQueue = [];
  let scanning = null, hashing = null, runLoop = null, stopping = false;
  let stopReason = null;           // why the running scan/hash should stop (cleared per step)
  // A halt (Rebuild, Remove location, server stop) outlasts the step it
  // interrupts: nothing in the loop clears it, so the loop winds down instead
  // of moving on to the next scan or to the idle hash. Only its owner clears it.
  let halt = null;
  const lastRuns = new Map();      // location id -> the last finished scan's stats
  let lastHash = null;
  const fs_ = () => netfs || require("../netfs").getNetFs();
  const probe = new Map();   // rootId -> { failures, nextAt, inFlight, realPath }
  let probeChain = Promise.resolve();
  // The last backup failure, until a backup succeeds. A nightly backup that
  // refuses because the database fails its integrity check must not be a
  // log line nobody reads: it shows in Settings > Library.
  let lastBackupError = null;

  const requireAvailable = () => {
    if (!store.available) throw new LibraryError(503, "library_unavailable", "The Library is unavailable: " + store.reason);
  };
  const stateOf = id => { if (!probe.has(id)) probe.set(id, { failures: 0, nextAt: 0, inFlight: false, realPath: null }); return probe.get(id); };

  function view(r) {
    const s = probe.get(r.id);
    const live = scanning && scanning.rootId === r.id ? scanning : null;
    const last = lastRuns.get(r.id);
    return {
      id: r.id, name: r.name, path: r.path, grouping: r.grouping, enabled: !!r.enabled,
      scanEveryMin: r.scan_every_min, status: r.status, lastOkAt: r.last_ok_at, lastScanAt: r.last_scan_at,
      lastError: r.last_error, isGcodeFolder: r.id === GCODE_ROOT, checking: !!(s && s.inFlight),
      queued: scanQueue.includes(r.id),
      scan: live ? { phase: live.phase, seen: live.seen, total: live.total, done: live.done, extracted: live.extracted, bytesRead: live.bytesRead, paused: live.paused, current: live.current } : null,
      lastScan: last ? { outcome: last.outcome, finishedAt: last.finishedAt, seen: last.seen, added: last.added, changed: last.changed, moved: last.moved, missing: last.missing, errors: last.errors } : null,
    };
  }

  // ---- the indexer ----

  // Queue a scan of a location. A scan already queued or running is not
  // queued twice; `front` puts an explicit Rescan ahead of scheduled ones.
  function requestScan(id, { front = false } = {}) {
    if (!indexing || !store.available || stopping) return false;
    if ((scanning && scanning.rootId === id) || scanQueue.includes(id)) return false;
    if (front) scanQueue.unshift(id); else scanQueue.push(id);
    if (hashing) stopReason = "a scan is waiting";   // scans come before idle hashing
    pump();
    return true;
  }

  function pump() {
    if (runLoop || stopping || !scanner) return;
    runLoop = (async () => {
      // Yield first: with nothing to do the body would otherwise run to its
      // `finally` (which clears runLoop) before runLoop is even assigned,
      // leaving a settled promise there that blocks every later pump().
      await null;
      try {
        while (!stopping && !halt && scanQueue.length) {
          const id = scanQueue.shift();
          const r = store.available && store.roots.get(id);
          if (!r || !r.enabled) continue;
          // Pipeline step 1: the location must answer before it is walked.
          // Marked as in progress first, so the check's own success cannot
          // queue it a second time.
          scanning = { rootId: id, phase: "checking" };
          const checked = await checkRoot(id);
          const root = store.roots.get(id);
          if (!checked || checked.status !== "ok" || stopping || halt || !root) { scanning = null; continue; }
          stopReason = null;
          const pathAtStart = root.path;
          const res = await scanner.scanRoot(root, {
            stats: scanning,
            shouldStop: () => halt || stopReason || (stopping && "server stopping")
              || (!store.roots.get(id) && "location removed")
              || (store.roots.get(id).path !== pathAtStart && "location moved")
              || (!store.roots.get(id).enabled && "location disabled"),
          });
          lastRuns.set(id, res);
          scanning = null;
          // The worker records the outcome; if it could not (it crashed), the
          // location must not be left showing "scanning".
          const after = store.roots.get(id);
          if (after && after.status === "scanning") store.roots.setStatus(id, { status: res.outcome === "offline" ? "offline" : "error", error: res.error || "the scan did not finish" });
          logScan(root, res);
          if (res.outcome === "ok") await runLineage();
          if (res.outcome === "offline") { const st = stateOf(id); st.failures = 0; st.nextAt = 0; }
        }
        // Nothing waiting: hash at idle (§6.1 step 3, full hash later).
        if (!stopping && !halt && !scanQueue.length) {
          const roots = store.roots.list().filter(r => r.enabled && r.full_hash === "idle" && r.status === "ok");
          if (roots.length) {
            stopReason = null;
            hashing = {};
            lastHash = await scanner.hashIdle({ roots, stats: hashing, shouldStop: () => halt || stopReason || (stopping && "server stopping") || (scanQueue.length && "a scan is waiting") });
            hashing = null;
            if (lastHash.hashed) log.log(`[library] full hash: ${lastHash.hashed} file(s), ${Math.round(lastHash.bytesRead / 1048576)} MB, ${lastHash.outcome}`);
            if (lastHash.hashed) await runLineage();   // new MD5s can prove a G-code came from a project plate
          }
        }
      } catch (e) {
        log.error("[library] indexer: " + e.message);
      } finally {
        scanning = null; hashing = null; runLoop = null;
        if (!stopping && !halt && scanQueue.length) pump();
      }
    })();
  }

  // Lineage Claims between files, recomputed from the whole index (worker).
  let lastLineage = null;
  async function runLineage() {
    try { const t0 = now(); lastLineage = { ...(await worker.request("index.lineage", { dbPath: store.dbPath, now: now() })), ms: now() - t0, at: now() }; }
    catch (e) { log.error("[library] lineage: " + e.message); }
    await runGrouping();
  }

  // Models (M4): regrouped from the whole index after lineage. The report is
  // what Diagnostics shows.
  const groupingReport = path.join(baseDir, "library-data", "grouping-report.json");
  let lastGrouping = null;
  async function runGrouping() {
    try { lastGrouping = { ...(await worker.request("index.group", { dbPath: store.dbPath, now: now(), reportPath: groupingReport })), at: now() }; }
    catch (e) { log.error("[library] grouping: " + e.message); lastGrouping = { error: e.message, at: now() }; }
  }

  // ---- M6 actions ----
  const asLibraryError = e => {
    if (!e || !e.status) return e;
    const le = new LibraryError(e.status, e.code, e.message);
    if (e.extra) le.extra = e.extra;
    return le;
  };
  async function runAction(user, actor, action) {
    requireAvailable();
    const cap = libraryActions.CAPABILITY[action && action.kind];
    if (!cap) throw new LibraryError(400, "unknown_action", "Unknown action.");
    if (!authz || !authz.can(user, cap)) throw new LibraryError(403, "forbidden", "You don't have permission to do this.");
    // An item about a Print on a printer this person may not see is not
    // theirs to see or act on (§9 D6): as if it did not exist.
    if (action.review != null && !reviewVisible(user, action.review)) throw new LibraryError(404, "review_not_found", "That item no longer exists.");
    let res;
    try { res = await worker.request("library.act", { dbPath: store.dbPath, action, actor, now: now(), reportPath: groupingReport }); }
    catch (e) { throw asLibraryError(e); }
    // Names, never folder paths, in the audit trail.
    audit("model-" + res.kind.replace(/_/g, "-"), actor, { action: res.actionId, ...auditSummary(res) });
    return res;
  }
  async function runUndo(user, actor, actionId) {
    requireAvailable();
    const a = store.db.prepare("SELECT id, kind FROM actions WHERE id = ?").get(Number(actionId));
    if (!a) throw new LibraryError(404, "action_not_found", "That change no longer exists.");
    if (!authz || !authz.can(user, libraryActions.CAPABILITY[a.kind])) throw new LibraryError(403, "forbidden", "You don't have permission to do this.");
    if (!changeVisible(user, a.id)) throw new LibraryError(404, "action_not_found", "That change no longer exists.");
    let res;
    try { res = await worker.request("library.undo", { dbPath: store.dbPath, actionId: a.id, actor, now: now(), reportPath: groupingReport }); }
    catch (e) { throw asLibraryError(e); }
    audit("model-change-undone", actor, { action: a.id, kind: a.kind, ...auditSummary(res.summary || {}) });
    return res;
  }
  // Print visibility for Library items and changes (§9 D6): an unlinked_print
  // Review Item, and a change that linked a Print, belong to that Print's
  // printer.
  function printVisible(user, printId) {
    const p = printId == null ? null : store.db.prepare("SELECT printer_id FROM prints WHERE id = ?").get(Number(printId));
    return !p || printerVisible(user, p.printer_id);
  }
  function reviewVisible(user, reviewId) {
    const r = store.db.prepare("SELECT kind, print_id FROM review_items WHERE id = ?").get(Number(reviewId));
    return !r || r.kind !== "unlinked_print" || (r.print_id != null && printVisible(user, r.print_id));
  }
  function changeVisible(user, actionId) {
    const a = store.db.prepare("SELECT detail_json FROM actions WHERE id = ?").get(Number(actionId));
    let s = {};
    try { s = (JSON.parse((a && a.detail_json) || "{}").summary) || {}; } catch {}
    return !s.print || printVisible(user, s.print.id);
  }

  function auditSummary(r) {
    const out = {};
    for (const k of ["model", "name", "before", "after", "family", "fileSays", "plate", "reviewKind"]) if (r[k] != null) out[k] = r[k];
    if (r.print) out.print = { id: r.print.id, file: r.print.file };
    for (const k of ["from", "into", "to", "a", "b"]) if (r[k]) out[k] = { uuid: r[k].uuid, name: r[k].name };
    if (r.files != null) out.files = r.files;
    if (r.file != null) out.file = r.file;
    return out;
  }

  // ---- M7: printing from the Library, and print history ----

  // A location a file is printed or queued from. The G-code folder is open to
  // whoever may print; any other location needs library.view. Answers its
  // folder for the route to resolve the file inside (lexically there, then by
  // realpath through netfs).
  // system: queue dispatch, for an item whose permission was checked when it
  // was queued.
  function printLocation(user, rootId, { system = false } = {}) {
    requireAvailable();
    const r = store.roots.get(String(rootId || ""));
    if (!r) throw new LibraryError(404, "location_not_found", "That Library location no longer exists.");
    if (!system && r.id !== GCODE_ROOT && !(authz && authz.can(user, "library.view"))) throw new LibraryError(403, "forbidden", "You don't have permission to use the Library.");
    if (!r.enabled) throw new LibraryError(409, "location_disabled", `The location "${r.name}" is switched off.`);
    if (r.status === "offline") throw new LibraryError(503, "location_offline", `The location "${r.name}" is unreachable. SnapCon keeps checking and will use it again as soon as it answers.`);
    // Answers, but can't be used (its folder is gone, or overlaps another).
    // Its own error text is not repeated: it can name the share's path, which
    // only those who manage locations see (Settings → Library).
    if (r.status === "error") throw new LibraryError(409, "location_error", `The location "${r.name}" can't be used right now. An admin can see why in Settings → Library.`);
    return { id: r.id, name: r.name, path: r.path, realPath: stateOf(r.id).realPath || null };
  }

  // What the Library knows about the file a person chose to print: the
  // Variant they saw (key) must still be the file's. Answers the identity the
  // print is recorded with; the route still checks the file on disk.
  function printIdentity({ rootId, rel, key, plate }) {
    requireAvailable();
    const db = store.db;
    const f = db.prepare("SELECT * FROM files WHERE root_id = ? AND rel_path = ? AND entry_path = ''").get(String(rootId), String(rel || ""));
    if (!f || f.state !== "present") throw new LibraryError(409, "library_file_missing", "The Library no longer has this file there. Reload the model.");
    // Which plates a printer can start is the print route's to check (M7.1):
    // a Bambu printer starts the plate it is told; others plate 1.
    const p = plate == null || plate === "" ? null : Number(plate);
    const v = db.prepare(`SELECT plate_no FROM variants WHERE file_id = ? AND ${p == null ? "plate_no IS NULL" : "plate_no = ?"}`).get(...(p == null ? [f.id] : [f.id, p]));
    if (!v) throw new LibraryError(409, "library_variant_missing", "That printable file or plate is no longer there. Reload the model.");
    const canon = k => { const ck = String(k || "").split("#")[0]; return (db.prepare("SELECT content_key FROM content_aliases WHERE alias = ?").get(ck) || {}).content_key || ck; };
    if (key && canon(key) !== canon(f.content_key)) throw new LibraryError(409, "library_file_changed", "This file changed since the model page was opened. Reload it before printing.");
    const m = f.model_id ? db.prepare("SELECT uuid, name FROM models WHERE id = ?").get(f.model_id) : null;
    return { contentKey: f.content_key, sha256: f.sha256 || null, size: f.size, mtimeMs: f.mtime_ms, plate: p, variantKey: p == null ? f.content_key : f.content_key + "#" + p,
      model: m ? m.uuid : null, modelName: m ? m.name : null, location: f.root_id + ":" + f.rel_path, fileName: f.name };
  }

  // Present files with this verified content, in locations that answer: where
  // a queued job's file may have moved to (§12). The caller hashes the
  // candidate before using it.
  function locateContent(sha256) {
    if (!store.available || !sha256) return [];
    return store.db.prepare(`SELECT f.root_id, f.rel_path, r.path AS root_path FROM files f JOIN roots r ON r.id = f.root_id
      WHERE f.entry_path = '' AND f.state = 'present' AND f.sha256 = ? AND r.enabled = 1 AND r.status != 'offline' ORDER BY f.root_id != 'gcode', f.root_id, f.rel_path`).all(String(sha256))
      .map(r => ({ rootId: r.root_id, rel: r.rel_path, rootPath: r.root_path }));
  }

  // Recording never holds up printing: a failure is logged, and the import
  // from the audit log fills the gap later from the same events.
  function recordPrintStart(event) {
    if (!store.available || !worker) return Promise.resolve(null);
    return worker.request("prints.start", { dbPath: store.dbPath, event, now: now() }).catch(e => { log.error("[library] print not recorded: " + e.message); return null; });
  }
  function recordPrintOutcome(event) {
    if (!store.available || !worker) return Promise.resolve(null);
    return worker.request("prints.outcome", { dbPath: store.dbPath, event, now: now() }).catch(e => { log.error("[library] print outcome not recorded: " + e.message); return null; });
  }
  async function importPrintHistory({ events, queueHistory, from, to }) {
    requireAvailable();
    if (!worker) throw new LibraryError(503, "worker_down", "The Library worker is not running.");
    const rep = await worker.request("prints.import", { dbPath: store.dbPath, events, queueHistory, from, to, now: now() });
    log.log(`[library] print history: ${rep.events} audit events, ${rep.created} prints added, ${rep.closed} closed, ${rep.alreadyRecorded} already recorded`);
    return rep;
  }
  function lastPrintImport() {
    if (!store.available) return null;
    const r = store.db.prepare("SELECT * FROM print_imports ORDER BY id DESC LIMIT 1").get();
    return r ? { id: r.id, ranAt: r.ran_at, from: r.from_ts, to: r.to_ts, created: r.created, updated: r.updated, report: JSON.parse(r.report_json) } : null;
  }

  function logScan(root, s) {
    const secs = ((s.finishedAt - s.startedAt) / 1000).toFixed(1);
    log.log(`[library] scanned ${root.name}: ${s.outcome} in ${secs} s — ${s.seen} files (${s.unchanged} unchanged, ${s.added} new, ${s.changed} changed, ` +
      `${s.moved} moved, ${s.missing} newly missing, ${s.errors} errors), ${Math.round(s.bytesRead / 1024)} KB read` + (s.error ? ` — ${s.error}` : ""));
  }

  // Stop whatever the indexer is doing and wait for it to wind down.
  // keepQueue: Remove location stops the running work but leaves the other
  // locations' scans queued; Rebuild and server stop drop the queue.
  async function haltIndexer(why, { keepQueue = false } = {}) {
    if (!keepQueue) scanQueue.length = 0;
    halt = why;
    try { while (runLoop) await runLoop.catch(() => {}); }
    finally { halt = null; }
    if (keepQueue && !stopping) pump();
  }

  function dueForScan(r) {
    if (!r.enabled || r.status !== "ok") return false;
    if (r.last_scan_at == null) return true;
    return now() - r.last_scan_at >= r.scan_every_min * 60 * 1000;
  }

  // One reachability check at a time, across all locations. On Windows a
  // first contact with an unreachable host holds one of libuv's four shared
  // filesystem threads for ~21 s whatever timeout we set (measured in M1).
  // Serialising means the Library can tie up at most one of them.
  function checkRoot(id) {
    const st = stateOf(id);
    const current = store.available && store.roots.get(id);
    if (st.inFlight) {
      // A check of the same folder is already coming; a check of a folder the
      // location no longer points at is not good enough — queue a fresh one.
      if (!current || st.checkingPath === current.path) return st.inFlight;
      return st.inFlight.then(() => checkRoot(id));
    }
    if (current) st.checkingPath = current.path;
    const run = probeChain.then(async () => {
      const r = store.available && store.roots.get(id);
      if (!r) return null;
      const res = await checkFn(r.path, { timeoutMs: checkTimeoutMs });
      const now_ = store.roots.get(id);
      if (!now_) return null;   // removed meanwhile
      // The G-code folder can move while a check of its old path is running;
      // that answer is about somewhere else and must not be recorded.
      if (now_.path !== r.path) { st.nextAt = 0; return view(now_); }
      if (res.status === "ok") {
        st.failures = 0; st.realPath = res.realPath || r.path;
        st.nextAt = now() + r.scan_every_min * 60 * 1000;
        // A G-code folder that overlaps another location stays in error.
        const clash = overlapping(r.path, st.realPath, id);
        if (clash) store.roots.setStatus(id, { status: "error", error: `overlaps the location "${clash.name}"` });
        else {
          store.roots.setStatus(id, { status: "ok", lastOkAt: now() });
          // Reachable and due: index it now rather than at the next tick.
          if (dueForScan(store.roots.get(id))) requestScan(id);
        }
      } else {
        st.failures = res.status === "offline" ? st.failures + 1 : 0;
        const backoff = res.status === "offline" ? OFFLINE_BACKOFF_MS[st.failures - 1] : undefined;
        st.nextAt = now() + (backoff || r.scan_every_min * 60 * 1000);
        store.roots.setStatus(id, { status: res.status, error: res.error || null });
      }
      return view(store.roots.get(id));
    });
    st.inFlight = run.finally(() => { st.inFlight = false; });
    probeChain = run.catch(e => log.error("[library] location check failed: " + e.message));
    return st.inFlight;
  }

  // Another location this path would overlap, compared by the path as given
  // and by where it really points (symlinks, junctions). null if none.
  function overlapping(p, real, exceptId) {
    for (const r of store.roots.list()) {
      if (r.id === exceptId) continue;
      const other = [r.path, stateOf(r.id).realPath].filter(Boolean);
      for (const a of [p, real].filter(Boolean)) for (const b of other) if (overlaps(a, b, platform)) return r;
    }
    return null;
  }

  function validName(name, fallback) {
    const n = String(name == null ? "" : name).trim() || fallback;
    if (!n) throw new LibraryError(400, "name_required", "Give the location a name.");
    if (n.length > NAME_MAX) throw new LibraryError(400, "name_too_long", `A location name can be at most ${NAME_MAX} characters.`);
    return n;
  }
  function validInterval(v) {
    if (v === undefined || v === null || v === "") return SCAN_DEFAULT;
    const n = Number(v);
    if (!Number.isInteger(n) || n < SCAN_MIN || n > SCAN_MAX) throw new LibraryError(400, "bad_interval", `The check interval must be ${SCAN_MIN}–${SCAN_MAX} minutes.`);
    return n;
  }

  // ---- public API ----

  async function addRoot(input, actor = {}) {
    requireAvailable();
    const abs = normalizeLocation(input && input.path, { baseDir, platform });
    if (!abs) throw new LibraryError(400, "path_required", "Enter the folder's path.");
    const grouping = (input && input.grouping) || "folders";
    if (!["folders", "files"].includes(grouping)) throw new LibraryError(400, "bad_grouping", "Unknown grouping mode.");
    const name = validName(input && input.name, path.basename(abs) || abs);
    const scanEveryMin = validInterval(input && input.scanEveryMin);
    const lexical = overlapping(abs, null, null);
    if (lexical) throw new LibraryError(409, "overlap", `This folder overlaps the location "${lexical.name}". A folder can belong to only one location.`);
    const res = await checkFn(abs, { timeoutMs: checkTimeoutMs });
    if (res.status !== "ok") {
      throw new LibraryError(400, res.status === "offline" ? "unreachable" : "not_a_folder",
        res.status === "offline" ? `SnapCon can't reach this folder right now (${res.error}).` : `This path can't be used: ${res.error}.`);
    }
    const real = overlapping(abs, res.realPath, null);
    if (real) throw new LibraryError(409, "overlap", `This folder is the same place as, or overlaps, the location "${real.name}". A folder can belong to only one location.`);
    const id = "loc_" + crypto.randomBytes(6).toString("hex");
    store.roots.insert({ id, name, path: abs, grouping, enabled: true, scan_every_min: scanEveryMin, created_at: now(), created_by: actor.userId || null });
    store.roots.setStatus(id, { status: "ok", lastOkAt: now() });
    Object.assign(stateOf(id), { realPath: res.realPath || abs, failures: 0, nextAt: now() + scanEveryMin * 60 * 1000 });
    if (scanner) { fs_().registerRoot("library:" + id, abs); requestScan(id); }
    audit("location-added", actor, { id, name, path: abs, grouping });
    return view(store.roots.get(id));
  }

  function updateRoot(id, patch, actor = {}) {
    requireAvailable();
    const r = store.roots.get(id);
    if (!r) throw new LibraryError(404, "not_found", "No such location.");
    const f = {};
    if (patch.name !== undefined) f.name = validName(patch.name, null);
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") throw new LibraryError(400, "bad_enabled", "enabled must be true or false.");
      f.enabled = patch.enabled;
    }
    if (patch.scanEveryMin !== undefined) f.scan_every_min = validInterval(patch.scanEveryMin);
    if (patch.grouping !== undefined) {
      // D8: the G-code folder groups individual files; its folders are organisational.
      if (id === GCODE_ROOT) throw new LibraryError(400, "gcode_grouping_fixed", "The G-code folder always groups individual files.");
      if (!["folders", "files"].includes(patch.grouping)) throw new LibraryError(400, "bad_grouping", "Unknown grouping mode.");
      f.grouping = patch.grouping;
    }
    if (patch.path !== undefined) throw new LibraryError(400, "path_fixed", "A location's folder can't be changed. Remove it and add the new folder instead.");
    store.roots.update(id, f);
    if (f.enabled === true) stateOf(id).nextAt = 0;
    audit("location-updated", actor, { id, name: r.name, changes: Object.keys(f) });
    return view(store.roots.get(id));
  }

  async function removeRoot(id, actor = {}) {
    requireAvailable();
    if (id === GCODE_ROOT) throw new LibraryError(400, "gcode_fixed", "The G-code folder is set in General settings and can't be removed here.");
    const r = store.roots.get(id);
    if (!r) throw new LibraryError(404, "not_found", "No such location.");
    // A scan of it stops first, so the worker is not writing rows for a
    // location that is being removed.
    const qi = scanQueue.indexOf(id);
    if (qi >= 0) scanQueue.splice(qi, 1);
    if ((scanning && scanning.rootId === id) || hashing) await haltIndexer("location removed", { keepQueue: true });
    if (!store.roots.get(id)) return { ok: true };
    // Its index rows go first, in the worker, in batches; then the location row.
    if (worker && worker.running) await worker.request("index.removeRoot", { dbPath: store.dbPath, rootId: id });
    if (!store.roots.get(id)) return { ok: true };
    store.roots.remove(id);
    if (scanner) fs_().registerRoot("library:" + id, null);
    probe.delete(id);
    audit("location-removed", actor, { id, name: r.name, path: r.path });
    return { ok: true };
  }

  // Rescan: re-check reachability now and, if the location answers, index it
  // next (ahead of scheduled scans). Answers with the check's result; the
  // scan itself runs in the background and shows in the location's view.
  async function rescan(id) {
    requireAvailable();
    if (!store.roots.get(id)) throw new LibraryError(404, "not_found", "No such location.");
    const v = await checkRoot(id);
    if (v && v.status === "ok" && requestScan(id, { front: true })) return view(store.roots.get(id));
    return v;
  }

  // The G-code folder is always a location, mirroring Settings → General.
  function syncGcodeRoot() {
    if (!store.available) return;
    const abs = normalizeLocation(getGcodeFolder(), { baseDir, platform });
    const r = store.roots.get(GCODE_ROOT);
    if (!r) {
      store.roots.insert({ id: GCODE_ROOT, name: "G-code folder", path: abs, grouping: "files", enabled: true, scan_every_min: SCAN_DEFAULT, created_at: now() });
    } else if (comparisonKey(r.path, platform) !== comparisonKey(abs, platform)) {
      store.roots.update(GCODE_ROOT, { path: abs });
      store.roots.setStatus(GCODE_ROOT, { status: "pending" });
      Object.assign(stateOf(GCODE_ROOT), { realPath: null, failures: 0 });
    } else return;
    stateOf(GCODE_ROOT).nextAt = 0;
    if (scanner) fs_().registerRoot("library:" + GCODE_ROOT, abs);
    if (tickTimer) checkRoot(GCODE_ROOT);
  }

  // A stored thumbnail by its key (content-addressed: "e" + 31 hex).
  function thumbFile(key) {
    if (!store.available || !/^e[0-9a-f]{31}$/.test(String(key))) return null;
    const t = store.db.prepare("SELECT key, mime FROM thumbs WHERE key = ?").get(key);
    return t ? { file: path.join(thumbsDir, t.key + "." + thumbExt(t.mime)), mime: t.mime } : null;
  }

  async function backupNow(reason = "manual") {
    requireAvailable();
    if (!worker) throw new LibraryError(503, "worker_down", "The Library worker is not running.");
    try {
      const res = await worker.request("backup", { dbPath: store.dbPath, backupsDir: store.backupsDir, reason });
      log.log(`[library] backup ${res.file} (${Math.round(res.bytes / 1024)} KB, ${res.ms} ms)`);
      lastBackupError = null;
      return res;
    } catch (e) {
      log.error("[library] backup failed: " + e.message);
      const code = e.code === "LIBRARY_DB_CORRUPT" ? "db_corrupt" : "backup_failed";
      lastBackupError = { at: now(), code, reason, message: e.message };
      // The live database failed its integrity check: have the next start
      // check it fully and, if it is damaged, restore the newest good backup.
      if (code === "db_corrupt") store.requestIntegrityCheck(e.message);
      audit("backup-failed", {}, { code, reason, message: e.message });
      throw new LibraryError(500, code, "Backup failed: " + e.message);
    }
  }

  function backupDue() {
    return isBackupDue(store.listBackups(), now(), BACKUP_EVERY_MS);
  }

  function tick() {
    if (!store.available) return;
    for (const r of store.roots.list()) {
      if (!r.enabled) continue;
      if (scanning && scanning.rootId === r.id) continue;   // the scan is its check
      const st = stateOf(r.id);
      if (!st.inFlight && now() >= st.nextAt) checkRoot(r.id).catch(() => {});
      if (dueForScan(r)) requestScan(r.id);
    }
    // Nothing queued or running: resume the idle full hash (it also resumes
    // here after a restart, where it was cut off).
    if (indexing && scanner && !runLoop && !stopping) pump();
  }

  function start() {
    if (!store.available) return;
    worker = createWorkerHost({ log, ...workerOptions });
    if (indexing) {
      scanner = createScanner({ netfs: fs_(), worker, readDb: () => store.db, dbPath: store.dbPath, thumbsDir, log, now, uploadsActive, ...(scanBudget ? { budgetBytesPerSec: scanBudget } : {}) });
    }
    syncGcodeRoot();
    // Each location is its own root in netfs's availability breaker, so a
    // mapped drive letter is protected like a UNC share. After syncGcodeRoot,
    // which creates the G-code folder's row on a first run.
    if (scanner) {
      for (const r of store.roots.list()) fs_().registerRoot("library:" + r.id, r.path);
      // Files indexed under an older extraction rule are read again now, not
      // at the location's next scheduled scan.
      const stale = store.db.prepare(`SELECT DISTINCT root_id FROM files WHERE entry_path = '' AND (
          (ext IN ('gcode', 'gco', 'g', 'gx') AND meta_version > 0 AND meta_version < ?) OR (ext = '3mf' AND meta_version < ?))`).all(GCODE_META_VERSION, THREEMF_META_VERSION);
      for (const { root_id } of stale) requestScan(root_id);
    }
    tick();
    tickTimer = setInterval(tick, TICK_MS); tickTimer.unref();
    const maybeBackup = () => { if (store.available && backupDue()) backupNow("nightly").catch(() => {}); };
    const first = setTimeout(maybeBackup, 60 * 1000); first.unref();
    backupTimer = setInterval(maybeBackup, BACKUP_CHECK_MS); backupTimer.unref();
  }

  async function stop() {
    clearInterval(tickTimer); clearInterval(backupTimer); tickTimer = backupTimer = null;
    stopping = true;
    await haltIndexer("server stopping");
    if (worker) await worker.stop().catch(() => {});
    store.close();
  }

  function status() {
    const backups = store.available ? store.listBackups() : [];
    return {
      available: store.available, reason: store.reason, schemaVersion: store.schemaVersion(),
      recovery: store.recovery,
      worker: worker ? worker.mode : null,
      backups: { count: backups.filter(b => b.reason !== "pre-migration").length, newest: backups.find(b => b.reason !== "pre-migration") || null, lastError: lastBackupError },
      indexer: indexing ? {
        scanning: scanning ? { rootId: scanning.rootId, phase: scanning.phase, done: scanning.done, total: scanning.total, paused: scanning.paused } : null,
        queue: [...scanQueue],
        hashing: hashing ? { current: hashing.current, hashed: hashing.hashed, remaining: hashing.remaining, bytesRead: hashing.bytesRead, paused: hashing.paused } : null,
        lastHash: lastHash ? { outcome: lastHash.outcome, hashed: lastHash.hashed, skipped: lastHash.skipped, remaining: lastHash.remaining, bytesRead: lastHash.bytesRead, finishedAt: lastHash.finishedAt } : null,
      } : null,
    };
  }

  // The full statistics of the last scan of each location (the M2 checkpoint
  // report reads these): counts, bytes, and read/parse/write timings.
  function scanReport() {
    const out = {};
    for (const [id, s] of lastRuns) {
      out[id] = {
        outcome: s.outcome, error: s.error, startedAt: s.startedAt, finishedAt: s.finishedAt, ms: s.finishedAt - s.startedAt,
        dirs: s.dirs, seen: s.seen, unchanged: s.unchanged, restat: s.restat, added: s.added, changed: s.changed, reread: s.reread,
        moved: s.moved, missing: s.missing, purged: s.purged, vanished: s.vanished, thumbsRemoved: s.thumbsRemoved, threemf: s.threemf, threemfReads: s.threemfBytes, extracted: s.extracted, streamed: s.streamed,
        thumbs: s.thumbs, errors: s.errors, errorList: s.errorList.slice(0, 50), expansions: s.expansions,
        bytesRead: s.bytesRead, readOps: s.readOps, listOps: s.listOps, fpOps: s.fpOps, pauses: s.pauses, pausedMs: s.pausedMs,
        interruptedBefore: s.interruptedBefore,
        timings: { windowReadMs: summarise(s.readMs), parseMs: summarise(s.parseMs), writeMs: summarise(s.writeMs), perFileMs: summarise(s.fileMs), quickFpMs: summarise(s.fpMs) },
      };
    }
    return { scans: out, hash: lastHash, hashing, lineage: lastLineage };
  }

  // Rebuild (§14): stop the indexer, drop and recreate the derived tables,
  // then rescan every location.
  async function rebuildDerived() {
    requireAvailable();
    await haltIndexer("rebuilding the index");
    const r = store.rebuildDerived();
    lastRuns.clear();
    for (const root of store.roots.list()) if (root.enabled) requestScan(root.id);
    return r;
  }

  return {
    get available() { return store.available; },
    status, start, stop,
    can: (user, cap) => !!authz && authz.can(user, cap),
    listRoots: () => (store.available ? store.roots.list().map(view) : []),
    addRoot, updateRoot, removeRoot, rescan, syncGcodeRoot, backupNow, rebuildDerived, scanReport,
    diagnosticsRaw: opts => { requireAvailable(); return diagnosticsRaw(store.db, opts || {}); },
    diagnosticsGrouping: ({ exportView = false } = {}) => {
      requireAvailable();
      const d = diagnosticsGrouping(store.db, { reportPath: groupingReport });
      return exportView ? stableExport(d) : { ...d, lastRun: lastGrouping };
    },
    // M5: the Library itself, from the index alone (never a file read).
    browse: (opts, user) => { requireAvailable(); return libraryView.listModels(store.db, { ...(opts || {}), printerVisible: pid => printerVisible(user, pid) }); },
    facets: () => { requireAvailable(); return libraryView.facets(store.db); },
    model: (uuid, user) => {
      requireAvailable();
      const m = libraryView.modelDetail(store.db, String(uuid || ""), { printerVisible: pid => printerVisible(user, pid) });
      if (!m) throw new LibraryError(404, "model_not_found", "No such model.");
      if (!m.mergedInto) {
        m.history = libraryActions.history(store.db, m.uuid).filter(h => !(h.summary && h.summary.print) || printVisible(user, h.summary.print.id));
        // Counts are everyone's (§9 D6); the rows only for printers this
        // user may see, and nothing about how many others there are.
        const id = store.db.prepare("SELECT id FROM models WHERE uuid = ?").get(m.uuid).id;
        const h = libraryPrints.historyFor(store.db, id, { visible: pid => printerVisible(user, pid) });
        m.printHistory = { rows: h.rows, someNotShown: h.hiddenCount > 0 };
      }
      return m;
    },
    // M6: a person's change to the Library. The capability is checked here,
    // per action, whatever the UI showed; the worker validates the request
    // against the current state and answers 409 when it no longer applies.
    act: (user, actor, action) => runAction(user, actor, action),
    undo: (user, actor, actionId) => runUndo(user, actor, actionId),
    attention: user => { requireAvailable(); return libraryView.attentionList(store.db, { printerVisible: pid => printerVisible(user, pid) }); },
    // What every Library page shows at the top: each location's state (never
    // its folder), whether indexing is running, and the attention counts.
    overview: user => {
      requireAvailable();
      const can = {};
      for (const [k, cap] of Object.entries({ grouping: "library.edit.grouping", metadata: "library.edit.metadata", cover: "library.edit.cover", hide: "library.hide", review: "library.review", diagnostics: "library.diagnostics" })) {
        can[k] = !!authz && authz.can(user, cap);
      }
      const s = status();
      const roots = store.roots.list().filter(r => r.enabled).map(r => ({ id: r.id, name: r.name, status: r.status, offline: r.status === "offline", lastOkAt: r.last_ok_at || null }));
      const ix = s.indexer;
      return {
        roots,
        indexing: ix ? { scanning: ix.scanning ? { rootId: ix.scanning.rootId, phase: ix.scanning.phase, done: ix.scanning.done, total: ix.scanning.total } : null,
          queued: ix.queue.length, hashing: ix.hashing ? { hashed: ix.hashing.hashed, remaining: ix.hashing.remaining } : null } : null,
        attention: libraryView.attentionCounts(store.db, { printerVisible: pid => printerVisible(user, pid) }),
        can,
      };
    },
    thumbFile,
    printLocation, printIdentity, locateContent, recordPrintStart, recordPrintOutcome, importPrintHistory, lastPrintImport,
    _store: store, _checkRoot: checkRoot, _tick: tick, _requestScan: requestScan, _group: runGrouping,
    // Tests: resolves once the indexer has nothing running.
    _idle: async () => { while (runLoop) await runLoop.catch(() => {}); },
  };
}

module.exports = { createLibraryService, LibraryError, GCODE_ROOT };
