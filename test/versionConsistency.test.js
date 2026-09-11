// test/versionConsistency.test.js — every place SnapCon states its own version
// must agree.
//
// This exists because they did not. 0.7.0 was released with package.json,
// RELEASE_NOTES.md and the bundled locales' snapconVersion all moved to 0.7.0
// while THREE hardcoded strings stayed on 0.6.0: server.js's VERSION, its
// header comment, and public/app.js's VERSION. The shipped binaries reported
// 0.6.0 in the UI and at startup, and nothing failed - the version is a literal
// in each file rather than being read from package.json, so nothing could.
//
// It is not merely cosmetic. app.js compares its own VERSION against the
// server's /api/version to decide whether the page is stale and tell the user to
// restart, and against the locale's snapconVersion to decide whether a
// translation is out of date. A mismatch there is a false alarm; agreement on
// the WRONG number is a silent one.
//
// The fix is deliberately a test rather than deriving VERSION from package.json
// at runtime: public/app.js is served to a browser and cannot require() it, and
// server.js reads package.json from a pkg snapshot path that differs between a
// source run and a packaged binary. Keeping the literals and pinning them is
// simpler than making both read a file correctly in both modes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");

const pkgVersion = JSON.parse(read("package.json")).version;

function literal(file, name) {
  const m = new RegExp("const " + name + ' = "([^"]+)"').exec(read(file));
  assert.ok(m, name + " literal not found in " + file);
  return m[1];
}

test("package.json is the version everything else is checked against", () => {
  assert.match(pkgVersion, /^\d+\.\d+\.\d+$/, "got " + pkgVersion);
});

test("server.js VERSION matches package.json", () => {
  assert.equal(literal("server.js", "VERSION"), pkgVersion);
});

test("public/app.js VERSION matches package.json", () => {
  // The page compares this against /api/version and warns the user to restart
  // when they differ, so a stale literal here produces a permanent false alarm.
  assert.equal(literal("public/app.js", "VERSION"), pkgVersion);
});

test("server.js's header comment states the same version", () => {
  const first = read("server.js").split(/\r?\n/)[0];
  assert.ok(first.includes("v" + pkgVersion),
    "first line of server.js should say v" + pkgVersion + ", got: " + first);
});

test("the bundled locales' snapconVersion matches package.json", () => {
  // app.js marks a locale stale when meta.snapconVersion !== VERSION, so this
  // drifting flags both shipped translations as out of date on first launch.
  for (const loc of ["en", "es"]) {
    const meta = JSON.parse(read(`locales-default/${loc}.json`))._meta;
    assert.equal(meta.snapconVersion, pkgVersion, loc + ".json snapconVersion");
  }
});

test("RELEASE_NOTES.md has a section for this version", () => {
  const lines = read("RELEASE_NOTES.md").split(/\r?\n/).map(l => l.trim());
  assert.ok(lines.includes(pkgVersion),
    "no '" + pkgVersion + "' heading in RELEASE_NOTES.md — a release with no notes");
});

test("no stray older version literal is left behind in the shipped source", () => {
  // Catches the specific shape of the miss: one file bumped, another not.
  for (const f of ["server.js", "public/app.js"]) {
    const hits = [...read(f).matchAll(/const VERSION = "([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual([...new Set(hits)], [pkgVersion],
      f + " declares a VERSION that is not " + pkgVersion);
  }
});
