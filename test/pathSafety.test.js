// test/pathSafety.test.js — unit tests for the shared directory-jail
// containment check (pathSafety.js), extracted from server.js specifically
// so this is testable without requiring server.js itself (which starts a
// real listening server as a side effect of being required).
//
// Regression coverage for CODE_AUDIT.md P1-1: safePath() (and two other
// call sites, /api/files/mkdir and /api/files/upload) used to gate the
// gcode-folder jail with a bare `candidatePath.startsWith(folder)` check,
// which a sibling directory sharing the folder's own string prefix could
// pass. These tests are pure string/lexical logic — no filesystem I/O is
// needed at all, since path.resolve/path.relative never touch disk.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const { isPathWithinFolder, resolveWithinFolder } = require("../pathSafety");

const FOLDER = path.join(os.tmpdir(), "snapcon-pathsafety-test", "gcode");
const SIBLING = path.join(path.dirname(FOLDER), path.basename(FOLDER) + "-backup");

test("isPathWithinFolder: the folder itself is within itself", () => {
  assert.equal(isPathWithinFolder(FOLDER, FOLDER), true);
});

test("isPathWithinFolder: a genuine descendant is within the folder", () => {
  assert.equal(isPathWithinFolder(path.join(FOLDER, "sub", "file.gcode"), FOLDER), true);
});

test("isPathWithinFolder: the reported bypass — a sibling sharing the folder's string prefix is rejected", () => {
  // This is the actual P1-1 regression: a bare startsWith(FOLDER) check
  // would incorrectly accept this, since ".../gcode-backup" begins with
  // the literal characters ".../gcode".
  assert.equal(isPathWithinFolder(SIBLING, FOLDER), false);
});

test("isPathWithinFolder: an unrelated path is rejected", () => {
  assert.equal(isPathWithinFolder(path.join(os.tmpdir(), "totally-unrelated"), FOLDER), false);
});

test("isPathWithinFolder: the folder's own parent is rejected (an exact '..' escape)", () => {
  assert.equal(isPathWithinFolder(path.dirname(FOLDER), FOLDER), false);
});

test("isPathWithinFolder: a real descendant whose name merely starts with '..' as characters (e.g. '..hidden') is NOT mistaken for an upward escape", () => {
  // path.relative(FOLDER, .../gcode/..hidden) === "..hidden" — starts with
  // ".." as a raw string but is a single real segment, not a parent
  // reference (which would need ".." exactly, or ".." + a separator).
  assert.equal(isPathWithinFolder(path.join(FOLDER, "..hidden"), FOLDER), true);
});

test("isPathWithinFolder: the filesystem root as folder is handled correctly, with no double-separator artifact", () => {
  // The naive `candidatePath.startsWith(folder + path.sep)` form breaks
  // here: root + sep doubles the separator ("//" or "\\\\"), which no real
  // descendant path starts with, incorrectly rejecting everything. This is
  // the exact limitation this implementation was chosen to avoid.
  const root = path.parse(FOLDER).root;
  assert.equal(isPathWithinFolder(root, root), true);
  assert.equal(isPathWithinFolder(path.join(root, "etc", "passwd"), root), true);
});

test("resolveWithinFolder: empty/falsy sub returns null", () => {
  assert.equal(resolveWithinFolder("", FOLDER), null);
  assert.equal(resolveWithinFolder(undefined, FOLDER), null);
});

test("resolveWithinFolder: a normal relative subpath resolves correctly", () => {
  assert.equal(resolveWithinFolder(path.join("sub", "file.gcode"), FOLDER), path.join(FOLDER, "sub", "file.gcode"));
});

test("resolveWithinFolder: the audit's exact realistic scenario — '../<folder-name>-backup' — is rejected", () => {
  const sub = path.join("..", path.basename(FOLDER) + "-backup");
  assert.equal(resolveWithinFolder(sub, FOLDER), null);
});

test("resolveWithinFolder: an absolute path supplied as sub (bypassing folder entirely via path.resolve's own semantics) is rejected", () => {
  const outsideAbsolute = path.join(os.tmpdir(), "elsewhere", "file.gcode");
  assert.equal(resolveWithinFolder(outsideAbsolute, FOLDER), null);
});
