// transfers/TransferResults.js — the final outcome of each transfer, kept for
// a while after it ends (docs/TODO.md §37 P4), so the command line's --wait
// and GET /api/transfers/:id can answer across a restart.
//
// One entry per transfer id. A transfer id names ONE attempt: Send again makes
// a new id (linked by parentId), so an earlier attempt's result never changes
// to a later one's. Rules (owner, 2026-10-28):
//   - an entry is written only from an outcome that really happened (the
//     deferred send's saved state), never guessed from a file name;
//   - a final entry is never overwritten — not by a late or repeated update,
//     an older backup, or a later attempt. The one exception: "unknown" may
//     become verified/acknowledged for the same attempt when a new read-back
//     proves it (reconcile), and the entry keeps what it was before;
//   - bounded: entries older than retentionHours (default 24) go, then the
//     oldest beyond maxCount (default 1000, at most 10000: each save rewrites the file) — but never one isProtected(id)
//     still needs (an unresolved send's only status);
//   - saved the DeferredStore way (temporary file, flushed .bak, rename);
//     missing, corrupt (→ backup), unreadable-for-now (read-only until
//     restart) and newer-format (read-only) are kept apart. A backup can only
//     be older: it may lack the newest results (asked for, they are "not
//     known" — never a success), and nothing in it is final that was not.
const fs = require("fs");
const path = require("path");
const { _internal: { withTransientRetry } } = require("../queue/QueueStore");
const { ID_SHAPE } = require("./DeferredStore");

const FORMAT = 1;
const FINAL_STATES = new Set(["verified", "acknowledged", "failed", "cancelled", "unknown"]);
const DELIVERED = new Set(["verified", "acknowledged"]);
const BASES = new Set(["content", "size", "name"]);
const RESULT_LIMITS = Object.freeze({ retentionHours: 24, retentionHoursMin: 1, retentionHoursMax: 720, maxCount: 1000, maxCountMin: 100, maxCountMax: 10000 });

function writeAll(fsImpl, fd, data) {
  const buf = Buffer.from(data);
  let off = 0;
  while (off < buf.length) {
    const n = fsImpl.writeSync(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw Object.assign(new Error("No space left to write the file"), { code: "ENOSPC" });
    off += n;
  }
}
function flush(fsImpl, p, flags) {
  try { const fd = fsImpl.openSync(p, flags); try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); } } catch { /* best effort */ }
}
const str = (v, n) => (v == null ? null : String(v).slice(0, n));
// A message is kept for the retention period and shown to anyone who can see
// the printer: absolute paths in it (an fs or printer error) are left out.
const noPaths = v => v == null ? null : String(v)
  .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s'"`)]*/g, "<path>")
  .replace(/(^|[\s'"`(=])\/(?:[^\s'"`)/]+\/)+[^\s'"`)]*/g, "$1<path>");

function createTransferResults({ baseDir, fsImpl = fs, now = () => Date.now(), retry = {}, isProtected = () => false }) {
  const dataDir = path.join(baseDir, "data");
  const PRIMARY = path.join(dataDir, "transfer-results.json");
  const BAK = PRIMARY + ".bak";
  const TMP = PRIMARY + ".tmp";
  const R = (op, label) => withTransientRetry(op, label, retry);

  let entries = new Map();   // id → entry, in insertion (time) order
  let loadStatus = "missing";
  let noWrite = false;
  let degraded = false;
  let quarantined = [];
  let limits = { retentionHours: RESULT_LIMITS.retentionHours, maxCount: RESULT_LIMITS.maxCount };

  function persist(map) {
    if (noWrite) return { ok: false, error: new Error("The transfer results file could not be read; nothing is saved until SnapCon restarts and can read it.") };
    try {
      const json = JSON.stringify({ format: FORMAT, savedAt: now(), results: [...map.values()] });
      fsImpl.mkdirSync(dataDir, { recursive: true });
      R(() => { const fd = fsImpl.openSync(TMP, "w"); try { writeAll(fsImpl, fd, json); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); } }, "transfer results save (temporary file)");
      try { R(() => fsImpl.copyFileSync(PRIMARY, BAK), "transfer results save (backup)"); flush(fsImpl, BAK, "r+"); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
      R(() => fsImpl.renameSync(TMP, PRIMARY), "transfer results save");
      flush(fsImpl, dataDir, "r");
      degraded = false;
      return { ok: true };
    } catch (e) {
      degraded = true;
      console.error("[transfers] results save failed:", e.message);
      return { ok: false, error: e };
    }
  }
  function read(file) {
    let text;
    try { text = R(() => fsImpl.readFileSync(file, "utf8"), "transfer results load"); }
    catch (e) { return e && e.code === "ENOENT" ? { missing: true } : { readError: e }; }
    let j;
    try { j = JSON.parse(text); } catch { return { corrupt: true }; }
    if (!j || typeof j !== "object" || !Array.isArray(j.results)) return { corrupt: true };
    return { json: j };
  }
  function quarantine(file, ts) {
    if (!fsImpl.existsSync(file)) return true;
    try { const dest = file + ".corrupt-" + ts; R(() => fsImpl.renameSync(file, dest), "transfer results quarantine"); quarantined.push(dest); return true; }
    catch (e) { console.error(`[transfers] could not move ${path.basename(file)} aside: ${e.message}`); return false; }
  }
  const valid = e => e && typeof e === "object" && typeof e.id === "string" && ID_SHAPE.test(e.id) && FINAL_STATES.has(e.state) && Number.isFinite(e.at)
    && (e.basis == null || BASES.has(e.basis)) && (e.parentId == null || (typeof e.parentId === "string" && ID_SHAPE.test(e.parentId)));
  function readOnly(status, why) {
    loadStatus = status; noWrite = true; entries = new Map();
    console.error("[transfers] " + why + " — transfer results are not saved until SnapCon restarts and can read it");
  }

  function load() {
    quarantined = []; noWrite = false; degraded = false;
    try { if (fsImpl.existsSync(TMP)) fsImpl.unlinkSync(TMP); } catch {}
    const ts = now();
    const primary = read(PRIMARY);
    if (primary.readError) { readOnly("read-error", "transfer-results.json exists but could not be read (" + primary.readError.message + ")"); return status(); }
    let j = primary.json;
    if (j) loadStatus = "ok";
    else if (primary.missing && !fsImpl.existsSync(BAK)) { entries = new Map(); loadStatus = "missing"; return status(); }
    else {
      const bak = read(BAK);
      if (bak.readError) { readOnly("read-error", "transfer-results.json is unreadable and its backup could not be read (" + bak.readError.message + ")"); return status(); }
      const moved = quarantine(PRIMARY, ts);
      if (!moved) { readOnly("unreadable", "transfer-results.json is unreadable and could not be moved aside"); return status(); }
      if (bak.json) { j = bak.json; loadStatus = "restored-from-backup"; console.warn("[transfers] transfer-results.json was unreadable; restored from its backup (the newest results may be missing)"); }
      else { if (!quarantine(BAK, ts)) { readOnly("unreadable", "transfer-results.json and its backup are unreadable and could not be moved aside"); return status(); } j = { results: [] }; loadStatus = "unreadable"; console.error("[transfers] transfer-results.json and its backup are both unreadable; earlier results are not known"); }
    }
    if (Number.isFinite(j.format) && j.format > FORMAT) { readOnly("newer-format", `transfer-results.json was written by a newer SnapCon (format ${j.format})`); return status(); }
    entries = new Map();
    for (const e of j.results.filter(valid).sort((a, b) => a.at - b.at)) entries.set(e.id, e);
    const pruned = pruneIn(entries);
    entries = pruned.map;
    // What was loaded becomes the saved state, so a second restart sees the same.
    if (pruned.changed || loadStatus !== "ok") persist(entries);
    return status();
  }

  function expired(e, t = now()) { return t - e.at > limits.retentionHours * 3600 * 1000; }
  // Expired first, then the oldest beyond the count; a protected entry stays.
  function pruneIn(map) {
    const t = now();
    const out = new Map();
    let changed = false;
    for (const [id, e] of map) { if (expired(e, t) && !isProtected(id)) changed = true; else out.set(id, e); }
    let over = out.size - limits.maxCount;
    if (over > 0) for (const id of [...out.keys()]) { if (over <= 0) break; if (isProtected(id)) continue; out.delete(id); over--; changed = true; }
    return { map: out, changed };
  }
  function prune() {
    const p = pruneIn(entries);
    if (!p.changed) return { ok: true, removed: 0 };
    const r = persist(p.map);
    if (!r.ok) return r;
    const removed = entries.size - p.map.size;
    entries = p.map;
    return { ok: true, removed };
  }

  // Persist first: memory changes only once the entry is on disk.
  //   { ok:true, written }            — saved
  //   { ok:true, kept: existing }     — an entry already stands and this does
  //                                     not change it (repeat, stale, or not
  //                                     a proven reconcile)
  //   { ok:true, reconciled, from }   — unknown → delivered, proven
  //   { ok:false, reason:"persist" }  — not saved; the caller keeps its record
  // opts.reconcile: the caller holds new read-back evidence for this attempt.
  function record(entry, { reconcile = false } = {}) {
    const e = {
      id: entry.id, parentId: entry.parentId || null, printerId: str(entry.printerId, 200), state: entry.state, at: Number.isFinite(entry.at) ? entry.at : now(),
      basis: entry.basis || null, code: str(entry.code, 80), reason: str(entry.reason, 80), outcome: str(entry.outcome, 20), message: str(noPaths(entry.message), 300),
    };
    if (!valid(e)) throw new Error("not a valid transfer result");
    const cur = entries.get(e.id);
    let next = e, reconciled = false;
    if (cur) {
      if (cur.state === e.state) return { ok: true, kept: { ...cur } };
      if (!(cur.state === "unknown" && DELIVERED.has(e.state) && reconcile)) return { ok: true, kept: { ...cur } };
      next = { ...e, parentId: cur.parentId, reconciledFrom: { state: cur.state, at: cur.at, reason: cur.reason } };
      reconciled = true;
    }
    const map = new Map(entries);
    map.delete(next.id);
    map.set(next.id, next);
    const pruned = pruneIn(map);
    if (!pruned.map.has(next.id)) pruned.map.set(next.id, next);   // the newest is never pruned by its own write
    const r = persist(pruned.map);
    if (!r.ok) return { ok: false, reason: "persist", error: r.error };
    entries = pruned.map;
    return reconciled ? { ok: true, written: { ...next }, reconciled: true, from: cur.state } : { ok: true, written: { ...next } };
  }

  function get(id) {
    const e = entries.get(id);
    if (!e || (expired(e) && !isProtected(id))) return null;
    return { ...e, ...(e.reconciledFrom ? { reconciledFrom: { ...e.reconciledFrom } } : {}) };
  }
  // Later attempts of a transfer (Send again links each to the one before),
  // nearest first — so a send brought back from a backup can be told that a
  // newer attempt already delivered it.
  function laterAttempts(id) {
    const out = [], seen = new Set([id]);
    let frontier = new Set([id]);
    while (frontier.size) {
      const next = new Set();
      for (const e of entries.values()) if (e.parentId && frontier.has(e.parentId) && !seen.has(e.id) && !(expired(e) && !isProtected(e.id))) { seen.add(e.id); next.add(e.id); out.push({ ...e }); }
      frontier = next;
    }
    return out;
  }
  function setLimits(l = {}) { limits = { retentionHours: l.retentionHours || RESULT_LIMITS.retentionHours, maxCount: l.maxCount || RESULT_LIMITS.maxCount }; }
  function status() { return { loadStatus, readOnly: noWrite, degraded, count: entries.size, quarantined: quarantined.slice(), limits: { ...limits } }; }

  return { load, record, get, laterAttempts, prune, setLimits, status, paths: { PRIMARY, BAK, TMP } };
}

module.exports = { createTransferResults, RESULT_LIMITS, FINAL_STATES, DELIVERED };
