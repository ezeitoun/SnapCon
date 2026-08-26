// test/firmwareFiles.test.js — the containment rules behind
// GET /api/firmware-files (Settings > Firmware's "Select Firmware").
//
// The route lists the configured firmware folder so a firmware file can be
// picked. It is admin-only, but "admin" is not the boundary being tested here:
// the boundary is that the route speaks ONLY in paths relative to
// CFG.firmwareFolder, so no absolute path from the browser is ever honored and
// nothing above that root is reachable.
//
// server.js cannot be required (it starts a listening server as a side effect —
// the same constraint test/pathSafety.test.js documents), so the resolution
// rule itself is exercised directly against the shared jail the route uses,
// with the route's own wiring asserted against its source. That split is
// deliberate: the lexical rule is where the security actually lives, and it is
// testable for real.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveWithinFolder, isPathWithinFolder } = require("../pathSafety");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const routeSrc = (() => {
  const i = serverSrc.indexOf('app.get("/api/firmware-files"');
  assert.ok(i > 0, "the route must exist");
  return serverSrc.slice(i, serverSrc.indexOf("\n});", i));
})();

const ROOT = path.join(os.tmpdir(), "snapcon-fw-test", "firmware");
// The sibling-prefix escape from CODE_AUDIT.md P1-1: a bare startsWith()
// check would accept this.
const SIBLING = path.join(path.dirname(ROOT), path.basename(ROOT) + "-backup");

// ---------------------------------------------------------------------------
// What the route accepts as ?path=
// ---------------------------------------------------------------------------

test("no path lists the root itself", () => {
  // The route uses `sub ? resolveWithinFolder(sub, root) : root`, so an absent
  // path is the root without going through the jail at all.
  assert.match(routeSrc, /const dir = sub \? resolveWithinFolder\(sub, root\) : root;/);
  assert.equal(isPathWithinFolder(ROOT, ROOT), true);
});

test("a nested relative path resolves inside the root", () => {
  const target = resolveWithinFolder("K1C/v1.3", ROOT);
  assert.equal(target, path.join(ROOT, "K1C", "v1.3"));
  assert.equal(isPathWithinFolder(target, ROOT), true);
});

test("../ traversal is rejected", () => {
  assert.equal(resolveWithinFolder("..", ROOT), null);
  assert.equal(resolveWithinFolder("../..", ROOT), null);
  assert.equal(resolveWithinFolder("../secrets", ROOT), null);
  assert.equal(resolveWithinFolder("K1C/../../secrets", ROOT), null);
});

test("traversal that only LOOKS like it escapes is still allowed — no over-blocking", () => {
  // A real descendant whose name merely starts with ".." is not traversal.
  const target = resolveWithinFolder("..hidden/fw.bin", ROOT);
  assert.equal(target, path.join(ROOT, "..hidden", "fw.bin"));
});

test("percent-encoded traversal is a non-issue: Express decodes before we see it", () => {
  // req.query.path arrives already decoded, so "%2e%2e%2f" is the same "../"
  // the previous test rejects. Asserted explicitly so nobody "fixes" this by
  // adding a second, redundant decode.
  const decoded = decodeURIComponent("%2e%2e%2fsecrets");
  assert.equal(decoded, "../secrets");
  assert.equal(resolveWithinFolder(decoded, ROOT), null);
  // And a double-encoded value decodes to a literal name, not traversal — it
  // must not be decoded twice into an escape.
  assert.equal(decodeURIComponent("%252e%252e%252f"), "%2e%2e%2f");
  assert.notEqual(resolveWithinFolder("%2e%2e%2f", ROOT), null);
});

test("an absolute path from the browser cannot escape the root", () => {
  // path.resolve(root, "/etc/passwd") ignores root on POSIX and lands outside,
  // which the jail then rejects — the route never trusts an absolute path.
  assert.equal(resolveWithinFolder(path.join(os.tmpdir(), "elsewhere"), ROOT), null);
  assert.equal(resolveWithinFolder(path.parse(ROOT).root, ROOT), null);
});

test("a sibling folder sharing the root's string prefix is rejected", () => {
  assert.equal(isPathWithinFolder(SIBLING, ROOT), false);
  assert.equal(isPathWithinFolder(path.join(SIBLING, "fw.bin"), ROOT), false);
  assert.equal(resolveWithinFolder("../" + path.basename(SIBLING), ROOT), null);
});

test("an empty path is the root, not a jail bypass", () => {
  assert.equal(resolveWithinFolder("", ROOT), null, "falsy sub never reaches the jail");
  assert.match(routeSrc, /const sub = String\(req\.query\.path \|\| ""\);/);
});

// ---------------------------------------------------------------------------
// Route behavior that the jail alone does not cover
// ---------------------------------------------------------------------------

test("a nonexistent path is a 404, not a crash or a partial listing", () => {
  assert.match(routeSrc, /catch \{ return res\.status\(404\)\.json\(\{ error: "Path not found" \}\); \}/);
});

test("a file cannot be treated as a directory", () => {
  assert.match(routeSrc, /if \(!fs\.lstatSync\(dir\)\.isDirectory\(\)\) return res\.status\(400\)\.json\(\{ error: "Not a folder" \}\);/);
});

test("symlinks are neither listed nor navigable — and no claim is made beyond that", () => {
  // pathSafety.js is lexical by its own documentation and does NOT resolve
  // symlinks, so the route must not depend on it for this. Two mechanisms:
  // lstat on the directory being opened (a symlinked dir fails isDirectory),
  // and Dirent.isDirectory()/isFile() both being false for a symlink entry,
  // which drops it from the listing.
  assert.match(routeSrc, /fs\.lstatSync\(dir\)/, "lstat, not stat, on the directory being opened");
  assert.match(routeSrc, /if \(e\.isDirectory\(\)\)/);
  assert.match(routeSrc, /else if \(e\.isFile\(\)\)/);
  const jail = fs.readFileSync(path.join(__dirname, "..", "pathSafety.js"), "utf8");
  assert.match(jail, /does not resolve symlinks/, "the jail still documents its own limit");
});

test("no extension filter is applied — every regular file is listed", () => {
  // Deliberate: which files a connector accepts is Deploy's question, and it
  // has the connector in hand. Guards against someone quietly inventing a
  // firmware file format here.
  assert.equal(/\\\.(bin|img|zip)/.test(routeSrc), false);
  assert.match(routeSrc, /size: st\.size, mtime: st\.mtimeMs/);
});

test("responses carry relative, forward-slashed paths only", () => {
  // The client sends these straight back as ?path=, so they must round-trip
  // regardless of OS separator, and must never be absolute.
  assert.match(routeSrc, /const rel = p => path\.relative\(root, p\)\.split\(path\.sep\)\.join\("\/"\);/);
  assert.match(routeSrc, /res\.json\(\{ path: rel\(dir\), parent: dir === root \? null : rel\(path\.dirname\(dir\)\)/);
  assert.equal(/absolute/i.test(routeSrc.split("res.json")[1] || ""), false);
});

test("the route is admin-only and refuses to run with no folder configured", () => {
  assert.match(serverSrc, /app\.get\("\/api\/firmware-files", requireAdmin,/);
  assert.match(routeSrc, /if \(!configured\) return res\.status\(400\)\.json\(\{ error: "no_folder" \}\);/);
});

test("the root is resolved against BASE_DIR, like every other configured folder", () => {
  assert.match(routeSrc, /const root = path\.resolve\(BASE_DIR, configured\);/);
});

// ---------------------------------------------------------------------------
// Config plumbing
// ---------------------------------------------------------------------------

test("firmwareFolder is persisted and returned like the other folder settings", () => {
  assert.match(serverSrc, /firmwareFolder: \(typeof b\.firmwareFolder === "string"\) \? b\.firmwareFolder\.trim\(\) : \(CFG\.firmwareFolder \|\| ""\),/);
  assert.match(serverSrc, /firmwareFolder: CFG\.firmwareFolder \|\| "",/);
});

test("the picker never sends an absolute path, and the selection stays transient", () => {
  const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(appSrc, /getJSON\("\/api\/firmware-files"\+\(rel\?"\?path="\+encodeURIComponent\(rel\):""\)\)/);
  assert.match(appSrc, /let SELECTED_FIRMWARE=null;/);
  // Persisting the choice would mean adding it to the config save body.
  assert.equal(/SELECTED_FIRMWARE/.test(appSrc.slice(appSrc.indexOf("const body={ gcodeFolder"), appSrc.indexOf("const body={ gcodeFolder") + 2000)), false);
});

test("the General tab's dirty tracking includes the new field in BOTH halves", () => {
  // Only half of it and the sticky footer never notices the field changed, or
  // Discard silently fails to restore it.
  const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const get = appSrc.slice(appSrc.indexOf("function generalTabValues()"), appSrc.indexOf("function setGeneralTabValues"));
  const set = appSrc.slice(appSrc.indexOf("function setGeneralTabValues"), appSrc.indexOf("function setGeneralTabValues") + 1400);
  assert.match(get, /firmwareFolder:\$\("setFirmwareFolder"\)\.value\.trim\(\)/);
  assert.match(set, /\$\("setFirmwareFolder"\)\.value=v\.firmwareFolder\|\|""/);
});
