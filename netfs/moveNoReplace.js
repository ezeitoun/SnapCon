// netfs/moveNoReplace.js — move a file to a name that must not exist yet,
// refusing (EEXIST) rather than overwrite, even if another program creates
// that name at the last moment. fs.rename cannot do this: on POSIX, and on
// an SMB mount (measured on a NAS share, 2026-11-05), it silently replaces the
// target, and Node offers no renameat2(RENAME_NOREPLACE).
//
// The only mechanism used is a hard link: link() refuses an existing name
// atomically, and once both names refer to the file, dropping the old name
// completes the move with no data copied — so no crash can leave a partial
// file at the target. The probe showed link onto an existing name refused
// with EEXIST and that file untouched, and two processes racing for one name
// always produced exactly one winner. Where links are not supported the move
// is refused (NO_SAFE_MOVE): there is deliberately no copy or check-then-
// rename fallback, which could overwrite or leave a partial file (owner,
// 2026-11-05). The source is never touched before the link exists.
//
// Synchronous and given its fs, so it runs inside a netfs worker and is tested
// with failures injected. Answers { sourceKept }.
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK", "EINVAL"]);

function moveNoReplace(fsx, src, dest) {
  try { fsx.linkSync(src, dest); }
  catch (e) {
    if (e && LINK_UNSUPPORTED.has(e.code)) {
      throw Object.assign(new Error(`this storage cannot move a file without risking another one (link: ${e.code})`), { code: "NO_SAFE_MOVE", cause: e });
    }
    throw e;
  }
  // Both names are the file now. If the old one cannot be dropped the file
  // is at the new place anyway (and still at the old): not an error.
  try { fsx.unlinkSync(src); return { sourceKept: false }; }
  catch { return { sourceKept: true }; }
}

module.exports = { moveNoReplace, LINK_UNSUPPORTED };
