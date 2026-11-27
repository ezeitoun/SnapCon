// fileTrash.js — deleting files from the G-code folder, recoverably.
//
// A deleted file is never removed: it is moved (one rename, on the same share)
// into <G-code folder>/.snapcon-trash/<batch>/files/<its own path>, so its
// original place is in its trash path even if nothing else survives. Each
// delete request is one batch; a manifest.json written after the moves records
// who deleted what, when, and when its 30 days run out. A manifest that could
// not be written loses only that detail, never the files.
//
// Nothing here purges the trash. `expired` is reported so a later clean-up can
// act on it once restore and retention have been proven (owner, 2026-11-05).
//
// `io` is the file access to use: in server.js netfs (the G-code folder may be
// a NAS share), in tests the local disk. Every call is async and may throw
// NAS_UNREACHABLE.
const path = require("path");
const crypto = require("crypto");
const { isPathWithinFolder, resolveWithinFolder } = require("./pathSafety");

const TRASH_DIR = ".snapcon-trash";
const RETENTION_DAYS = 30;
const MAX_FILES = 500;
const MANIFEST = "manifest.json";
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const BATCH_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
// netfs's answers for "the folder stopped answering": offline, an operation
// that timed out (it may still complete), a worker that died mid-operation.
const STOPPED = new Set(["NAS_UNREACHABLE", "ETIMEDOUT", "WORKER_EXITED"]);
// A full disk (or quota): said plainly, since "ENOSPC" tells a person nothing.
const NO_SPACE = new Set(["ENOSPC", "EDQUOT"]);

// Is this the trash, or inside it? By the first segment of its path in the
// G-code folder, ignoring case (an SMB share is case-insensitive) and the
// trailing dots and spaces Windows drops from a name (".snapcon-trash." opens
// the trash there).
function isTrashRel(rel) {
  const first = String(rel || "").split(/[\\/]+/).filter(s => s && s !== ".")[0] || "";
  return first.replace(/[. ]+$/, "").toLowerCase() === TRASH_DIR;
}
function isInTrash(fp, folder) {
  if (!isPathWithinFolder(fp, folder)) return false;
  return isTrashRel(path.relative(folder, fp));
}

const pad = n => String(n).padStart(2, "0");
function batchName(now, rand) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z-${rand}`;
}
const randHex = () => crypto.randomBytes(3).toString("hex");

// One requested file: its {sub, name} checked the way /api/files/move checks
// it, plus the rules a delete adds. Answers { rel, fp } or { error, code }.
function checkEntry(f, folder, allowed) {
  const name = typeof (f || {}).name === "string" ? f.name : "";
  const sub = typeof (f || {}).sub === "string" ? f.sub : "";
  if (!name || name.length > 255 || /[\\/\0]/.test(name) || name === "." || name === ".." || sub.length > 1024 || /\0/.test(sub)) {
    return { error: "Not a file name", code: "invalid" };
  }
  const rel = (sub ? sub.replace(/[\\/]+$/, "") + "/" : "") + name;
  const fp = resolveWithinFolder(rel, folder);
  if (!fp || fp === path.resolve(folder)) return { error: "Not in the G-code folder", code: "invalid" };
  if (isInTrash(fp, folder)) return { error: "Already in the trash", code: "in_trash" };
  if (allowed && !allowed.test(name)) return { error: "Not a print file", code: "not_print_file" };
  return { rel: path.relative(folder, fp).split(path.sep).join("/"), fp };
}

// Moves each file to the trash, one at a time. inUse(fp) answers why a file
// must stay (a string) or null; it is asked before a file is touched and again
// with nothing awaited between that answer and the rename. In the same step,
// reserve(fp) marks the file as being deleted, so anything about to start
// using it can refuse while the rename runs; release(fp, outcome) ends that
// ("moved", "failed" or "unknown" when the folder stopped answering and the
// rename may still happen). Never throws for one file: every requested file
// gets a result, in order, and a file is only ever reported deleted once its
// rename succeeded.
//
// mode "permanent" (Admin only, decided by the caller) goes through exactly the
// same checks, reservation and per-file results, but removes the file instead
// of moving it (netfs unlinkFile: only if it is still the file that was
// checked — same inode, device, size and ns times). No trash folder or
// manifest.
const MODES = new Set(["trash", "permanent"]);
async function deleteFiles({ io, folder, files, mode = "trash", inUse = () => null, reserve = () => {}, release = () => {}, allowed = null, actor = null, now = Date.now(), rand = randHex }) {
  if (!MODES.has(mode)) throw new Error("unknown delete mode " + mode);
  const permanent = mode === "permanent";
  folder = path.resolve(folder);
  const results = [], moved = [], seen = new Set();
  let batch = null, batchDir = null, unreachable = false;

  for (const f of files) {
    const base = { sub: typeof (f || {}).sub === "string" ? f.sub : "", name: typeof (f || {}).name === "string" ? f.name : "" };
    if (unreachable) { results.push({ ...base, ok: false, code: "not_attempted", error: "Not deleted: the G-code folder stopped answering" }); continue; }
    const e = checkEntry(f, folder, allowed);
    if (e.error) { results.push({ ...base, ok: false, code: e.code, error: e.error }); continue; }
    if (seen.has(e.fp)) { results.push({ ...base, ok: false, code: "duplicate", error: "Listed twice" }); continue; }
    seen.add(e.fp);
    const why = inUse(e.fp);
    if (why) { results.push({ ...base, ok: false, code: "in_use", error: why }); continue; }
    let renaming = false;
    try {
      let st;
      try { st = await io.stat(e.fp); }
      catch (err) { if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) { results.push({ ...base, ok: false, code: "not_found", error: "Not found" }); continue; } throw err; }
      if (!st.isFile) { results.push({ ...base, ok: false, code: "not_a_file", error: "Not a file" }); continue; }

      if (permanent) {
        // The file's identity now (BigInt-exact inode, device, size, ns times):
        // the worker removes it only if it is still this file.
        let ident;
        try { ident = await io.identity(e.fp); }
        catch (err) { if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) { results.push({ ...base, ok: false, code: "not_found", error: "Not found" }); continue; } throw err; }
        const whyNow = inUse(e.fp);
        if (whyNow) { results.push({ ...base, ok: false, code: "in_use", error: whyNow }); continue; }
        reserve(e.fp);
        renaming = true;
        let outcome = "failed";
        try { await io.unlinkFile(e.fp, ident); outcome = "moved"; }
        catch (err) {
          if (err && STOPPED.has(err.code)) outcome = "unknown";
          if (err && err.code === "ECHANGED") { results.push({ ...base, ok: false, code: "changed", error: "Not deleted: the file changed while it was being deleted" }); continue; }
          if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) { results.push({ ...base, ok: false, code: "not_found", error: "Not found" }); continue; }
          throw err;
        }
        finally { release(e.fp, outcome); }
        results.push({ ...base, ok: true, path: e.rel, mode });
        continue;
      }

      if (!batchDir) {
        await io.mkdir(path.join(folder, TRASH_DIR), { recursive: true });
        // Never two requests in one batch folder: created without recursive,
        // so a name already taken fails and another is picked.
        for (let attempt = 0; ; attempt++) {
          const name = batchName(now, rand());
          try { await io.mkdir(path.join(folder, TRASH_DIR, name)); batch = name; break; }
          catch (err) { if (!(err && err.code === "EEXIST") || attempt >= 4) throw err; }
        }
        batchDir = path.join(folder, TRASH_DIR, batch);
      }
      const dest = path.join(batchDir, "files", ...e.rel.split("/"));
      await io.mkdir(path.dirname(dest), { recursive: true });

      // Asked again here, synchronously before the rename: an upload, a
      // waiting send or a queue item that took the file while the steps
      // above waited keeps it.
      const whyNow = inUse(e.fp);
      if (whyNow) { results.push({ ...base, ok: false, code: "in_use", error: whyNow }); continue; }
      reserve(e.fp);
      renaming = true;
      let outcome = "failed";
      try { await io.rename(e.fp, dest); outcome = "moved"; }
      catch (err) { if (err && STOPPED.has(err.code)) outcome = "unknown"; throw err; }
      finally { release(e.fp, outcome); }
      moved.push({ path: e.rel, size: st.size, mtimeMs: st.mtimeMs, deletedAt: now });
      results.push({ ...base, ok: true, path: e.rel, batch, mode });
    } catch (err) {
      if (err && STOPPED.has(err.code)) {
        unreachable = true;
        // A rename sent to a share that stopped answering (or did not answer
        // in time) may still have happened: say so, rather than "not deleted".
        results.push(renaming
          ? { ...base, ok: false, code: "unknown", error: permanent
            ? "The G-code folder stopped answering during the delete: this file may be deleted or still in place"
            : "The G-code folder stopped answering during the delete: this file may be in the trash or still in place" }
          : { ...base, ok: false, code: "not_attempted", error: "Not deleted: the G-code folder stopped answering" });
        continue;
      }
      if (err && NO_SPACE.has(err.code)) { results.push({ ...base, ok: false, code: "no_space", error: "Not deleted: the G-code folder's disk is full" }); continue; }
      results.push({ ...base, ok: false, code: "error", error: (err && err.message) || String(err) });
    }
  }

  let manifestError = null;
  if (moved.length && !unreachable) {
    const manifest = {
      version: 1, batch, deletedAt: now, expiresAt: now + RETENTION_DAYS * 86400000,
      by: actor ? { userId: actor.userId || null, userLabel: actor.userLabel || null } : null,
      files: moved,
    };
    try { await io.writeFileExclusive(path.join(batchDir, MANIFEST), Buffer.from(JSON.stringify(manifest, null, 2))); }
    catch (err) { manifestError = (err && err.message) || String(err); }
  } else if (moved.length) manifestError = "The G-code folder stopped answering";
  return { results, batch, unreachable, manifestError };
}

// Every file in the trash, by batch, newest first. What is actually in each
// batch's files/ folder is the truth (a restored file is gone from it, a
// batch whose manifest was lost is still listed); the manifest adds who and
// when.
async function listTrash({ io, folder, now = Date.now() }) {
  folder = path.resolve(folder);
  const root = path.join(folder, TRASH_DIR);
  let batches;
  try { batches = await io.readdir(root); }
  catch (err) { if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return []; throw err; }
  const out = [];
  for (const b of batches.filter(e => e.isDirectory && BATCH_RE.test(e.name)).map(e => e.name).sort().reverse()) {
    const dir = path.join(root, b);
    let manifest = null;
    try { manifest = JSON.parse(Buffer.from(await io.readFile(path.join(dir, MANIFEST), MANIFEST_MAX_BYTES)).toString("utf8")); }
    catch (err) { if (err && err.code === "NAS_UNREACHABLE") throw err; manifest = null; }
    const known = new Map(((manifest && Array.isArray(manifest.files)) ? manifest.files : []).map(f => [String(f.path), f]));
    const present = [];
    const walk = async rel => {
      let entries;
      try { entries = await io.readdir(path.join(dir, "files", ...rel.split("/").filter(Boolean))); }
      catch (err) { if (err && err.code === "NAS_UNREACHABLE") throw err; return; }
      for (const e of entries) {
        const r = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory) await walk(r);
        else if (e.isFile) present.push(r);
      }
    };
    await walk("");
    if (!present.length) continue;
    const deletedAt = manifest && Number.isFinite(manifest.deletedAt) ? manifest.deletedAt : batchTime(b);
    const expiresAt = manifest && Number.isFinite(manifest.expiresAt) ? manifest.expiresAt : deletedAt + RETENTION_DAYS * 86400000;
    out.push({
      batch: b, deletedAt, expiresAt, expired: now >= expiresAt,
      by: manifest && manifest.by ? manifest.by : null, manifest: !!manifest,
      files: present.sort().map(p => { const k = known.get(p); return { path: p, size: k && Number.isFinite(k.size) ? k.size : null }; }),
    });
  }
  return out;
}
function batchTime(b) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(b);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

// Puts one file back where it was deleted from. Never over another file, even
// one created at that place a moment before: refused (409). Its folder is
// created if it is gone. A restore that cannot finish leaves the file in the
// trash.
// Answers { ok: true, path } or { ok: false, status, code, error }.
async function restoreFile({ io, folder, batch, file, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  folder = path.resolve(folder);
  if (typeof batch !== "string" || !BATCH_RE.test(batch)) return { ok: false, status: 400, code: "invalid", error: "No such deletion" };
  const rel = typeof file === "string" ? file.replace(/\\/g, "/") : "";
  const filesDir = path.join(folder, TRASH_DIR, batch, "files");
  const src = resolveWithinFolder(rel, filesDir);
  const dest = resolveWithinFolder(rel, folder);
  if (!rel || /\0/.test(rel) || !src || !dest || src === filesDir || isInTrash(dest, folder)) return { ok: false, status: 400, code: "invalid", error: "Not a file in the trash" };
  let st;
  try { st = await io.stat(src); }
  catch (err) { if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return { ok: false, status: 404, code: "not_found", error: "Not in the trash" }; throw err; }
  if (!st.isFile) return { ok: false, status: 400, code: "not_a_file", error: "Not a file" };
  const taken = { ok: false, status: 409, code: "exists", error: "A file with this name is already there" };
  if (await io.exists(dest)) return taken;
  // The check above only saves a pointless copy: the move itself refuses a
  // file created there since (netfs/moveNoReplace.js), atomically.
  let moved;
  try { await io.mkdir(path.dirname(dest), { recursive: true }); moved = await io.moveNoReplace(src, dest); }
  catch (err) {
    if (err && err.code === "EEXIST") return taken;
    if (err && err.code === "NO_SAFE_MOVE") return { ok: false, status: 501, code: "restore_unsupported", error: "This storage can't restore a file without risking another file at that place, so it was not restored. It is still in the trash." };
    if (err && STOPPED.has(err.code)) return { ok: false, status: 503, code: "unknown", error: "The G-code folder stopped answering during the restore: the file may be back or still in the trash" };
    if (err && NO_SPACE.has(err.code)) return { ok: false, status: 507, code: "no_space", error: "Not restored: the G-code folder's disk is full. The file is still in the trash." };
    throw err;
  }
  // Restored: the link succeeded, and that is the answer. Whether the file can
  // be seen yet is reported separately: right after a link that raced another
  // for the same name, an SMB mount answered EINVAL for ~1.5 s (measured on
  // a NAS share, 2026-11-05; ordinary restores never did). Up to three looks,
  // 250 ms apart, EINVAL only; never a reason to call the restore failed.
  let visible = false;
  for (let i = 0; i < 3 && !visible; i++) {
    if (i) await sleep(250);
    try { await io.stat(dest); visible = true; }
    catch (err) { if (!(err && err.code === "EINVAL")) break; }
  }
  return { ok: true, path: path.relative(folder, dest).split(path.sep).join("/"), sourceKept: !!(moved && moved.sourceKept), visible };
}

module.exports = { MODES, TRASH_DIR, RETENTION_DAYS, MAX_FILES, BATCH_RE, isTrashRel, isInTrash, batchName, checkEntry, deleteFiles, listTrash, restoreFile };
