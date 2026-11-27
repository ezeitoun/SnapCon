// transfers/DeferredStore.js — the sends waiting for a printer (docs/TODO.md
// §37 P3): files SnapCon was asked to upload to a printer that was busy, kept
// on disk so a restart does not lose them, in order, per printer id.
//
// It owns two things and nothing else: data/deferred-sends.json (the records)
// and data/deferred-files/ (the bytes of files pushed from a slicer, which
// exist nowhere else). server.js decides what to do with a record; this
// module makes each change durable before it counts.
//
// Persistence follows queue/QueueStore.js: a temporary file, a .bak copy of
// the current one, an atomic rename, a directory flush. Two additions: the
// temporary file is flushed before the rename, and a corrupt primary loaded
// from its .bak does not bring anything back to life by itself — every record
// that was not finished comes back as "needs attention", because a backup
// cannot say what happened after it was written (owner, 2026-10-28).
//
// States (owner-approved, 2026-10-28):
//   queued       persisted and waiting its turn (first in, first out per printer)
//   uploading    persisted BEFORE the first byte goes; still this at startup
//                means the attempt was interrupted
//   interrupted  a restart found it uploading; its outcome is being reconciled
//                (read back), never resent by itself
//   attention    needs a person: Send again, Check again or Cancel
//   completed    reached the printer and checked; the Loaded entry follows,
//                then the record is removed (startup finishes that if needed)
//   failed       did not reach the printer as asked (or its source changed)
//   cancelled    a person cancelled it
// Nothing here ever starts a print.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// QueueStore's bounded retry for a file another program holds open for a
// moment (Windows: EPERM/EBUSY/EACCES), with the same limits.
const { _internal: { withTransientRetry } } = require("../queue/QueueStore");

const STATES = new Set(["queued", "uploading", "interrupted", "attention", "completed", "failed", "cancelled"]);
// Not finished: they hold the destination (the duplicate rule) and their bytes.
const OPEN_STATES = new Set(["queued", "uploading", "interrupted", "attention", "completed"]);
const FORMAT = 1;
// A record id is also a file name under deferred-files/: never a path.
const ID_SHAPE = /^dsend_[A-Za-z0-9_-]{1,64}$/;

// Defaults for the bytes pushed from a slicer (owner-approved 2026-10-28).
const LIMITS = Object.freeze({ maxFileBytes: 512 * 1024 * 1024, maxFileBytesCeiling: 2 * 1024 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 * 1024, freeMarginBytes: 256 * 1024 * 1024 });

// Every byte, or an error: writeSync may write fewer than asked (a disk that
// fills, Linux's 2 GiB-per-call limit) without throwing.
function writeAll(fsImpl, fd, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let off = 0;
  while (off < buf.length) {
    const n = fsImpl.writeSync(fd, buf, off, Math.min(buf.length - off, 64 * 1024 * 1024));
    if (!(n > 0)) throw Object.assign(new Error("No space left to write the file"), { code: "ENOSPC" });
    off += n;
  }
}
function writeFileDurably(fsImpl, file, data) {
  const fd = fsImpl.openSync(file, "w");
  try { writeAll(fsImpl, fd, data); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
}
function flushFile(fsImpl, file) {
  try { const fd = fsImpl.openSync(file, "r+"); try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); } } catch { /* best effort */ }
}
function flushDir(fsImpl, dir) {
  try { const fd = fsImpl.openSync(dir, "r"); try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); } }
  catch { /* no directory flush on this platform — not fatal */ }
}
const limitError = (message, code) => Object.assign(new Error(message), { code, status: code === "DEFERRED_DISK_FULL" ? 507 : 413 });

// freeBytes(dir): injectable for tests; the default asks the filesystem.
// retry: QueueStore's retry options (tests shorten them).
function createDeferredStore({ baseDir, fsImpl = fs, now = () => Date.now(), freeBytes = null, retry = {}, newId = () => "dsend_" + crypto.randomBytes(8).toString("hex") }) {
  const dataDir = path.join(baseDir, "data");
  const PRIMARY = path.join(dataDir, "deferred-sends.json");
  const BAK = PRIMARY + ".bak";
  const TMP = PRIMARY + ".tmp";
  const FILES = path.join(dataDir, "deferred-files");
  const INCOMING = path.join(FILES, ".incoming");
  // Complete files no send refers to: moved here, never deleted by SnapCon on
  // its own — only by an admin's explicit, audited action (owner, 2026-10-28).
  const ORPHANED = path.join(FILES, ".orphaned");
  const R = (op, label) => withTransientRetry(op, label, retry);

  let records = [];          // in seq order
  let nextSeq = 1;
  // missing | ok | restored-from-backup | unreadable | read-error | newer-format
  let loadStatus = "missing";
  let degraded = false;
  let quarantined = [];
  let dropped = 0;
  // Saved with the list, so it outlives a restart (P3 persistence review):
  //   { reason, since, blockAdds } — orphan bytes are never removed while it
  //   stands, and new sends are refused while blockAdds; an admin clears it.
  let hold = null;
  // The file on disk could not be read safely (or is from a newer SnapCon):
  // nothing is written over it until SnapCon restarts and can read it.
  let noWrite = false;

  const snapshot = recs => ({ format: FORMAT, savedAt: now(), nextSeq, hold, records: recs });
  function persist(recs) {
    if (noWrite) return { ok: false, error: new Error("The list of sends waiting for busy printers could not be read; nothing is saved until SnapCon restarts and can read it.") };
    try {
      const json = JSON.stringify(snapshot(recs), null, 2);
      JSON.parse(json);
      fsImpl.mkdirSync(dataDir, { recursive: true });
      R(() => writeFileDurably(fsImpl, TMP, json), "deferred save (temporary file)");
      try { R(() => fsImpl.copyFileSync(PRIMARY, BAK), "deferred save (backup)"); flushFile(fsImpl, BAK); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
      R(() => fsImpl.renameSync(TMP, PRIMARY), "deferred save");
      flushDir(fsImpl, dataDir);
      degraded = false;
      return { ok: true };
    } catch (e) {
      degraded = true;
      console.error("[deferred] save failed:", e.message);
      return { ok: false, error: e };
    }
  }

  // { json } | { corrupt } | { readError }: a file that cannot be read now is
  // not the same as one that reads as garbage (P3 persistence review).
  function read(file) {
    let text;
    try { text = R(() => fsImpl.readFileSync(file, "utf8"), "deferred load"); }
    catch (e) { return e && e.code === "ENOENT" ? { missing: true } : { readError: e }; }
    let j;
    try { j = JSON.parse(text); } catch { return { corrupt: true }; }
    if (!j || typeof j !== "object" || !Array.isArray(j.records)) return { corrupt: true };
    return { json: j };
  }
  // true when the file is out of the way (moved, or was never there).
  function quarantine(file, ts) {
    if (!fsImpl.existsSync(file)) return true;
    try { const dest = file + ".corrupt-" + ts; R(() => fsImpl.renameSync(file, dest), "deferred quarantine"); quarantined.push(dest); return true; }
    catch (e) { console.error(`[deferred] could not move ${path.basename(file)} aside: ${e.message}`); return false; }
  }
  function clean(r) {
    return r && typeof r === "object" && typeof r.id === "string" && ID_SHAPE.test(r.id) && typeof r.printerId === "string" && typeof r.name === "string"
      && STATES.has(r.state) && Number.isFinite(r.seq) && r.source && typeof r.source === "object" && Number.isFinite(r.source.size) && typeof r.source.sha256 === "string"
      && (r.transferId == null || (typeof r.transferId === "string" && ID_SHAPE.test(r.transferId)))
      && (r.parentTransferId == null || (typeof r.parentTransferId === "string" && ID_SHAPE.test(r.parentTransferId)));
  }
  // Read-only until restart: a file that may hold sends is never written over.
  function blockReadOnly(status, why) {
    loadStatus = status; noWrite = true; records = []; nextSeq = 1;
    console.error("[deferred] " + why + " — sends to busy printers are refused, and nothing is written over it, until SnapCon restarts and can read it");
  }

  function load() {
    try { if (fsImpl.existsSync(TMP)) fsImpl.unlinkSync(TMP); } catch {}
    quarantined = []; degraded = false; noWrite = false; hold = null; dropped = 0;
    const ts = now();
    const primary = read(PRIMARY);
    if (primary.readError) { blockReadOnly("read-error", "deferred-sends.json exists but could not be read (" + primary.readError.message + ")"); return status(); }
    let j = primary.json;
    let restored = false, writeRestored = true;
    if (j) {
      loadStatus = "ok";
    } else if (primary.missing && !fsImpl.existsSync(BAK)) {
      records = []; nextSeq = 1; loadStatus = "missing"; return status();
    } else {
      // The primary is corrupt (or gone with a backup left): fall back.
      const bak = read(BAK);
      if (bak.readError) { blockReadOnly("read-error", "deferred-sends.json is unreadable and its backup could not be read (" + bak.readError.message + ")"); return status(); }
      const movedPrimary = quarantine(PRIMARY, ts);
      if (bak.json) {
        j = bak.json;
        restored = true;
        loadStatus = "restored-from-backup";
        // Older than what was lost: nothing in it is acted on by itself — not
        // a send, and not a completion that may already have been applied.
        for (const r of j.records) {
          if (clean(r) && r.state !== "failed" && r.state !== "cancelled") { r.state = "attention"; r.reason = "restored-from-backup"; r.updatedAt = ts; }
          // Kept as they were, but marked: what they say may be out of date (§37 P4).
          else if (clean(r)) r.restoredFromBackup = ts;
        }
        hold = { reason: "restored-from-backup", since: ts, blockAdds: false };
        // A corrupt primary still in place would be copied over the good
        // backup by the next save: stay unsaved (and degraded) instead.
        if (!movedPrimary) { writeRestored = false; degraded = true; }
        console.warn("[deferred] deferred-sends.json was unreadable; restored from its backup — every unfinished send needs a person's attention");
      } else {
        const movedBak = quarantine(BAK, ts);
        j = { nextSeq: 1, records: [] };
        if (!movedPrimary || !movedBak) { blockReadOnly("unreadable", "deferred-sends.json and its backup are unreadable and could not be moved aside"); return status(); }
        loadStatus = "unreadable";
        hold = { reason: "unreadable", since: ts, blockAdds: true };
        console.error("[deferred] deferred-sends.json and its backup are both unreadable — new sends to busy printers are refused until an admin acknowledges");
      }
    }
    if (Number.isFinite(j.format) && j.format > FORMAT) { blockReadOnly("newer-format", `deferred-sends.json was written by a newer SnapCon (format ${j.format})`); return status(); }
    if (!restored && j.hold && typeof j.hold === "object") hold = { reason: String(j.hold.reason || "unknown"), since: Number(j.hold.since) || ts, blockAdds: !!j.hold.blockAdds };
    const all = j.records;
    records = all.filter(clean).sort((a, b) => a.seq - b.seq);
    dropped = all.length - records.length;
    if (dropped) {
      // Kept on disk in the quarantine, and their bytes kept: a hold until an
      // admin has looked (e.g. after a downgrade).
      console.error(`[deferred] ${dropped} send(s) in deferred-sends.json could not be understood and were set aside`);
      if (!hold) hold = { reason: "records-set-aside", since: ts, blockAdds: false };
      try { fsImpl.mkdirSync(dataDir, { recursive: true }); const dest = PRIMARY + ".set-aside-" + ts; fsImpl.writeFileSync(dest, JSON.stringify(all.filter(r => !clean(r)), null, 2)); quarantined.push(dest); } catch {}
    }
    nextSeq = Math.max(Number.isFinite(j.nextSeq) ? j.nextSeq : 1, ...records.map(r => r.seq + 1), 1);
    // Make what was loaded, and any hold, the saved state, so a second restart
    // sees the same (an unreadable store stays held, not "missing").
    if ((restored && writeRestored) || loadStatus === "unreadable" || dropped) persist(records);
    return status();
  }

  function status() {
    return { loadStatus, degraded, recoveryRequired: noWrite || !!(hold && hold.blockAdds), hold: hold ? { ...hold } : null, readOnly: noWrite, dropped, quarantined: quarantined.slice() };
  }
  const copy = r => r && JSON.parse(JSON.stringify(r));
  function list({ printerId = null, states = null } = {}) {
    return records.filter(r => (!printerId || r.printerId === printerId) && (!states || states.includes(r.state))).map(copy);
  }
  function get(id) { return copy(records.find(r => r.id === id) || null); }
  // The send whose current attempt is this transfer id (P4), if any.
  function byTransfer(tid) { return copy(records.find(r => (r.transferId || r.id) === tid) || null); }
  const holdsTransfer = tid => records.some(r => (r.transferId || r.id) === tid);
  // An open send to the same printer under the same destination name.
  function openDuplicate(printerId, name) {
    // A completed send whose Loaded entry is written and only waits for its
    // result to be saved (§37 P4) no longer holds the name.
    return copy(records.find(r => r.printerId === printerId && r.name === name && OPEN_STATES.has(r.state) && !(r.state === "completed" && r.loadedApplied)) || null);
  }

  // Persist first: memory changes only once the new state is on disk, so an
  // action never runs on a state a crash would forget.
  function add(fields) {
    if (noWrite || (hold && hold.blockAdds)) throw Object.assign(new Error(noWrite ? "The list of sends waiting for busy printers could not be read; restart SnapCon once it can be." : "Pending sends could not be restored after a restart; an admin has to acknowledge that first."), { code: "DEFERRED_RECOVERY_REQUIRED", status: 503 });
    const rec = { ...fields, id: fields.id || newId(), seq: nextSeq, state: "queued", createdAt: now(), updatedAt: now() };
    const r = persist([...records, rec]);
    if (!r.ok) throw Object.assign(new Error("The send could not be saved: " + r.error.message), { code: "DEFERRED_SAVE_FAILED", status: 503 });
    records.push(rec); nextSeq++;
    return copy(rec);
  }
  // Changes a record only from one of `from`; anything else (already moved on,
  // gone) answers { ok:false } and changes nothing — repeated or racing
  // actions are no-ops.
  function transition(id, from, patch) {
    const i = records.findIndex(r => r.id === id);
    if (i < 0) return { ok: false, reason: "missing" };
    if (!from.includes(records[i].state)) return { ok: false, reason: "state", state: records[i].state };
    const next = { ...records[i], ...(typeof patch === "function" ? patch(copy(records[i])) : patch), updatedAt: now() };
    if (!STATES.has(next.state)) throw new Error("bad state " + next.state);
    const candidate = records.slice(); candidate[i] = next;
    const r = persist(candidate);
    if (!r.ok) return { ok: false, reason: "persist", error: r.error };
    records = candidate;
    return { ok: true, record: copy(next) };
  }
  function remove(id, from) {
    const i = records.findIndex(r => r.id === id);
    if (i < 0) return { ok: false, reason: "missing" };
    if (!from.includes(records[i].state)) return { ok: false, reason: "state", state: records[i].state };
    const candidate = records.filter(r => r.id !== id);
    const r = persist(candidate);
    if (!r.ok) return { ok: false, reason: "persist", error: r.error };
    records = candidate;
    return { ok: true };
  }
  function retrySave() { return persist(records); }
  // An admin has looked: the hold goes. Not while the file could not be read
  // at all — there is nothing safe to write over it.
  function acknowledgeRecovery() {
    if (noWrite) return { ok: false, error: new Error("The list could not be read; restart SnapCon once it can be.") };
    const was = hold; hold = null;
    const r = persist(records);
    if (!r.ok) hold = was;
    return r;
  }

  // ---- bytes pushed from a slicer ----
  const bytesPath = id => { if (!ID_SHAPE.test(String(id))) throw new Error("bad send id"); return path.join(FILES, id); };
  function storedBytesTotal() {
    let total = 0;
    for (const dir of [FILES, INCOMING, ORPHANED]) {
      let names = [];
      try { names = fsImpl.readdirSync(dir); } catch { continue; }
      for (const n of names) { try { const st = fsImpl.statSync(path.join(dir, n)); if (st.isFile()) total += st.size; } catch {} }
    }
    return total;
  }
  function free(dir) {
    if (freeBytes) return freeBytes(dir);
    try { const s = fsImpl.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
  }
  // Writes the bytes durably under the send's id BEFORE its record exists:
  // .part, flushed, renamed. Refuses before writing anything when a limit
  // would be passed (the space is reserved at once, so two pushes cannot both
  // pass the total), and removes the partial file on any failure.
  // Asynchronous, in chunks, hashing as it writes: a large push must not hold
  // the event loop — measured synchronously, 512 MB held it for 2.2 s (P3
  // review). Every byte is written or it fails (writeSync/write may write
  // fewer than asked without an error).
  let reserved = 0;
  const call = (fn, ...a) => new Promise((res, rej) => fsImpl[fn](...a, (e, v) => e ? rej(e) : res(v)));
  async function storeBytes(id, buffer, limits = {}) {
    const L = { ...LIMITS, ...limits };
    const maxFile = Math.min(L.maxFileBytes, L.maxFileBytesCeiling);
    const size = buffer.length;
    if (!ID_SHAPE.test(String(id))) throw new Error("bad send id");
    if (size > maxFile) throw limitError(`The file is ${Math.ceil(size / 1048576)} MB; files sent to a printer through SnapCon's command-line hook can be at most ${Math.floor(maxFile / 1048576)} MB.`, "DEFERRED_FILE_TOO_LARGE");
    fsImpl.mkdirSync(INCOMING, { recursive: true });
    const used = storedBytesTotal() + reserved;
    if (used + size > L.maxTotalBytes) throw limitError(`Files kept for printers already use ${Math.ceil(used / 1048576)} MB of the ${Math.floor(L.maxTotalBytes / 1048576)} MB allowed. Cancel some, or wait for them to be sent.`, "DEFERRED_STORE_FULL");
    if (free(INCOMING) < size + L.freeMarginBytes) throw limitError("Not enough disk space to keep this file until the printer is free.", "DEFERRED_DISK_FULL");
    reserved += size;
    const part = path.join(INCOMING, id + ".part");
    const hash = crypto.createHash("sha256");
    let fd = null;
    try {
      fd = await call("open", part, "w");
      const CHUNK = 8 * 1024 * 1024;
      for (let off = 0; off < size; ) {
        const len = Math.min(CHUNK, size - off);
        let done = 0;
        while (done < len) {
          const n = await call("write", fd, buffer, off + done, len - done, null);
          if (!(n > 0)) throw Object.assign(new Error("No space left to write the file"), { code: "ENOSPC" });
          done += n;
        }
        hash.update(buffer.subarray(off, off + len));
        off += len;
        await new Promise(r => setImmediate(r));
      }
      await call("fsync", fd);
      await call("close", fd); fd = null;
      await call("rename", part, bytesPath(id));
      flushDir(fsImpl, FILES);
    } catch (e) {
      if (fd != null) { try { await call("close", fd); } catch {} }
      try { fsImpl.unlinkSync(part); } catch {}
      if (e && e.code === "ENOSPC") throw limitError("Not enough disk space to keep this file until the printer is free.", "DEFERRED_DISK_FULL");
      throw e;
    } finally { reserved -= size; }
    return { file: bytesPath(id), size, sha256: hash.digest("hex") };
  }
  function deleteBytes(id) { try { fsImpl.unlinkSync(bytesPath(id)); } catch {} }
  // At startup, on a clean store with no hold standing: removes partial
  // files (never acknowledged: a send exists only once its bytes were renamed
  // into place and its record saved), and MOVES complete files no record
  // refers to into .orphaned — never deletes them. They are counted, listed
  // and kept until an admin deletes them (deleteOrphaned). From a backup,
  // after an unreadable list, with records set aside or a file not readable,
  // nothing is touched at all.
  function cleanupOrphans() {
    if ((loadStatus !== "ok" && loadStatus !== "missing") || hold || noWrite) return { skipped: hold ? hold.reason : loadStatus, removed: [], setAside: [] };
    const keep = new Set(records.filter(r => r.bytes).map(r => r.id));
    const removed = [], setAside = [];
    try { for (const n of fsImpl.readdirSync(INCOMING)) { try { fsImpl.unlinkSync(path.join(INCOMING, n)); removed.push(".incoming/" + n); } catch {} } } catch {}
    let names = [];
    try { names = fsImpl.readdirSync(FILES); } catch {}
    for (const n of names) {
      if (n.startsWith(".") || keep.has(n)) continue;
      try {
        if (!fsImpl.statSync(path.join(FILES, n)).isFile()) continue;
        fsImpl.mkdirSync(ORPHANED, { recursive: true });
        R(() => fsImpl.renameSync(path.join(FILES, n), path.join(ORPHANED, n)), "deferred set aside");
        setAside.push(n);
      } catch {}
    }
    if (setAside.length) flushDir(fsImpl, FILES);
    return { removed, setAside };
  }
  function listOrphaned() {
    let names = [];
    try { names = fsImpl.readdirSync(ORPHANED); } catch { return []; }
    return names.map(n => { try { const st = fsImpl.statSync(path.join(ORPHANED, n)); return st.isFile() ? { name: n, size: st.size } : null; } catch { return null; } }).filter(Boolean);
  }
  // The admin's explicit action: deletes the files set aside, and says which.
  function deleteOrphaned() {
    const gone = [];
    for (const f of listOrphaned()) { try { fsImpl.unlinkSync(path.join(ORPHANED, f.name)); gone.push(f); } catch {} }
    return gone;
  }

  return { newId, load, status, list, get, byTransfer, holdsTransfer, openDuplicate, add, transition, remove, retrySave, acknowledgeRecovery, listOrphaned, deleteOrphaned,
    storeBytes, deleteBytes, bytesPath, storedBytesTotal, cleanupOrphans, paths: { PRIMARY, BAK, FILES, INCOMING, ORPHANED } };
}

module.exports = { createDeferredStore, LIMITS, STATES, OPEN_STATES, ID_SHAPE };
