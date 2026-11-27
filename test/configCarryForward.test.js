// test/configCarryForward.test.js — a Settings save must not drop config
// (docs/TODO.md §49). POST /api/config writes a full rebuild of config.json
// (`const next = { … }` in server.js), not a merge, so a top-level key the
// server reads but the rebuild does not list is silently lost on every
// ordinary save — as happened to `utilization` (readPrinterHistory) and
// `openeiKey`. Every key read as CFG.<key> must be in the rebuild, or be
// listed below with the reason it may go.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// Keys a Settings save may drop, and why. Add one only with a reviewed reason.
const MAY_BE_DROPPED = {
  openCompact: "legacy: migrated into defaultView at startup (ensureDefaultViewSchema), unused afterwards",
};

function rebuildKeys() {
  const a = src.indexOf("  const next = {");
  assert.ok(a > 0, "the Settings-save rebuild exists");
  const body = src.slice(a, src.indexOf("\n  };", a));
  return new Set([...body.matchAll(/^\s{4}([A-Za-z_]\w*)\s*:/gm), ...body.matchAll(/^\s{4}([A-Za-z_]\w*),/gm)].map(m => m[1]));
}

test("every config key the server reads survives a Settings save (or is a reviewed exception)", () => {
  const reads = new Set([...src.matchAll(/\bCFG\.([A-Za-z_]\w*)/g)].map(m => m[1]));
  const kept = rebuildKeys();
  const dropped = [...reads].filter(k => !kept.has(k)).sort();
  assert.deepEqual(dropped, Object.keys(MAY_BE_DROPPED).sort(),
    "a key the server reads is lost on every Settings save — carry it forward in POST /api/config's rebuild, or add it to MAY_BE_DROPPED with a reason");
});

test("the two keys from §49 are carried forward exactly as found", () => {
  assert.match(src, /^    utilization: CFG\.utilization \|\| undefined,$/m);
  assert.match(src, /^    openeiKey: CFG\.openeiKey \|\| undefined,$/m);
});

test("the exceptions are still real (a stale entry is removed, not kept forever)", () => {
  for (const k of Object.keys(MAY_BE_DROPPED)) assert.match(src, new RegExp("\\bCFG\\." + k + "\\b"), k + " is still read somewhere");
});
