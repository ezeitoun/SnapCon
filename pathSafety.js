// pathSafety.js — the shared directory-jail containment check reused by
// safePath() and the two file-mutation routes (mkdir, upload) that used to
// each carry their own copy of the same broken check. Extracted from
// server.js specifically so this is unit-testable without requiring
// server.js itself (see configLoader.js/notifyToken.js for the same
// rationale applied elsewhere in this codebase).
//
// See CODE_AUDIT.md P1-1: a bare `candidatePath.startsWith(folder)` string
// check has no notion of a path-segment boundary — a sibling directory
// whose name happens to extend folder's own string (folder ".../gcode",
// sibling ".../gcode-backup") passes it incorrectly. path.relative() gives
// a segment-aware answer instead: compute the relative path FROM folder TO
// the candidate, then check whether that relative path ever needs to climb
// upward (exactly ".." or a ".." + separator prefix) or lands on a
// different root entirely (an absolute result — e.g. a different Windows
// drive, which has no common ancestor to express a relative path from) —
// either means the candidate is outside folder, regardless of what its raw
// string happens to look like. This also handles folder being the
// filesystem root correctly, with no double-separator artifact the naive
// `candidatePath.startsWith(folder + path.sep)` form would have there.
//
// Deliberately checks the FIRST SEGMENT of the relative path, not just any
// ".." substring — a real (if oddly named) descendant like folder/"..hidden"
// produces the relative path "..hidden", which starts with ".." as raw
// characters but is not an upward-traversal token; only an exact ".." or a
// ".." immediately followed by a separator means "go up a level."
//
// Lexical only — does not resolve symlinks. A symlink planted inside folder
// pointing outside it is a different question, with different semantics
// particularly for mkdir/upload targets that may not exist yet on disk;
// deliberately not handled here.
const path = require("path");

function isPathWithinFolder(candidatePath, folder) {
  const rel = path.relative(folder, candidatePath);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  if (rel === ".." || rel.startsWith(".." + path.sep)) return false;
  return true;
}

function resolveWithinFolder(sub, folder) {
  if (!sub) return null;
  const resolved = path.resolve(folder, sub);
  return isPathWithinFolder(resolved, folder) ? resolved : null;
}

module.exports = { isPathWithinFolder, resolveWithinFolder };
