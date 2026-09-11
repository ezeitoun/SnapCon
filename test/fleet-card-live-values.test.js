// test/fleet-card-live-values.test.js — the split between the STRUCTURAL card
// signature and the four live values patched into a surviving card.
//
// Why this split exists: while progress/elapsed/bed/hotend were part of
// cardSignature(), every actively printing card was destroyed and rebuilt on
// every poll, which tore down its WebRTC camera session, wiped the .pstatus
// line an in-flight action was still writing to, dropped keyboard focus, and
// restarted the progress shimmer. The rule this file guards is narrow and
// easy to break by accident: exactly those four fields may be missing from
// the signature, and each one must have a data-live hook that
// updateFleetCardLiveValues() writes.
//
// cardSignature() is browser-global code with no module system (the same
// constraint test/i18n-closure.test.js and test/health-maintenance.test.js
// document). It is also a pure function of its argument plus one Map, so
// rather than assert on its source text — which would pass while the
// behavior regressed — it is extracted and executed in a node:vm sandbox.
// The DOM half (updateFleetCardLiveValues) needs a real document; this
// project has no jsdom dependency and adding one for a ~30-line function
// would be disproportionate, so the DOM behavior is covered by browser
// verification and only its wiring is asserted here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

// Slice one top-level function out of app.js. Every function in that file is
// declared at column 0, so its closing brace is the first line that is
// exactly "}".
function extractFn(name) {
  const start = appSrc.indexOf("function " + name + "(");
  assert.ok(start > 0, name + " must exist in public/app.js");
  const end = appSrc.indexOf("\n}", start);
  assert.ok(end > start, name + " must have a top-level closing brace");
  return appSrc.slice(start, end + 2);
}

const sandbox = { STATUS_OVERRIDE: new Map(), JSON };
vm.createContext(sandbox);
vm.runInContext(extractFn("cardSignature"), sandbox);
const cardSignature = sandbox.cardSignature;

// A printer mid-print: every field the signature reads is populated, so a
// test that changes one field changes only that field.
const BASE = () => ({
  id: 3, online: true, state: "printing", name: "U1 Pink", brand: "SnapMaker",
  url: "http://192.168.4.193", filename: "bracket.gcode",
  progress: 0.4213, elapsed: 1234.56, filamentUsed: 8123, completedAt: null,
  errorCode: null, message: null, plate: { total: 4, excluded: 1 },
  activeExt: 0, forceDefaults: true,
  heads: [{ loaded: true, hex: "#ff0000", material: "PLA" }],
  capabilities: { camera: true, headMapping: true },
  tags: ["garage"], queuedFile: null, layer: { current: 12, total: 300 },
  bed: { temp: 60, target: 60 }, hotend: { temp: 215, target: 220 }
});

const sigOf = p => cardSignature(p);
const withField = (field, value) => { const p = BASE(); p[field] = value; return p; };

// ---------------------------------------------------------------------------
// 1-4. The four live fields must NOT invalidate the signature
// ---------------------------------------------------------------------------

test("changing progress does not change the structural signature", () => {
  assert.equal(sigOf(withField("progress", 0.9987)), sigOf(BASE()));
});

test("changing elapsed does not change the structural signature", () => {
  assert.equal(sigOf(withField("elapsed", 9999.9)), sigOf(BASE()));
});

test("changing bed temperature does not change the structural signature", () => {
  assert.equal(sigOf(withField("bed", { temp: 61, target: 60 })), sigOf(BASE()));
  // Target too — a new bed target is patched live, not rebuilt.
  assert.equal(sigOf(withField("bed", { temp: 60, target: 80 })), sigOf(BASE()));
});

test("changing hotend temperature does not change the structural signature", () => {
  assert.equal(sigOf(withField("hotend", { temp: 219, target: 220 })), sigOf(BASE()));
  assert.equal(sigOf(withField("hotend", { temp: 215, target: 250 })), sigOf(BASE()));
});

test("all four together still produce an unchanged signature — the printing-card case", () => {
  const p = BASE();
  p.progress = 0.77; p.elapsed = 4321; p.bed = { temp: 58, target: 60 }; p.hotend = { temp: 221, target: 220 };
  assert.equal(sigOf(p), sigOf(BASE()));
});

// ---------------------------------------------------------------------------
// 5. Structural fields must still invalidate it
// ---------------------------------------------------------------------------

test("state still invalidates the signature", () => {
  assert.notEqual(sigOf(withField("state", "paused")), sigOf(BASE()));
  assert.notEqual(sigOf(withField("state", "complete")), sigOf(BASE()));
});

test("online still invalidates the signature", () => {
  assert.notEqual(sigOf(withField("online", false)), sigOf(BASE()));
});

test("error state still invalidates the signature", () => {
  assert.notEqual(sigOf(withField("errorCode", "E1001")), sigOf(BASE()));
  assert.notEqual(sigOf(withField("message", "Heater fault")), sigOf(BASE()));
});

test("queuedFile still invalidates the signature (badge precedence, banner, thumbnail stem)", () => {
  assert.notEqual(sigOf(withField("queuedFile", { name: "next.gcode", status: "ready" })), sigOf(BASE()));
});

test("capabilities still invalidate the signature (which controls exist at all)", () => {
  assert.notEqual(sigOf(withField("capabilities", { camera: false })), sigOf(BASE()));
});

test("heads still invalidate the signature (swatches, AFC lanes, mapping grid)", () => {
  assert.notEqual(sigOf(withField("heads", [{ loaded: true, hex: "#00ff00", material: "PETG" }])), sigOf(BASE()));
});

test("plate still invalidates the signature (the plate button's presence and its title)", () => {
  assert.notEqual(sigOf(withField("plate", { total: 4, excluded: 2 })), sigOf(BASE()));
});

test("statusOverride still invalidates the signature", () => {
  const before = sigOf(BASE());
  sandbox.STATUS_OVERRIDE.set("3", { statusColor: "var(--busy)", statusTxt: "Pausing" });
  try { assert.notEqual(sigOf(BASE()), before); }
  finally { sandbox.STATUS_OVERRIDE.clear(); }
});

test("the remaining structural fields all still invalidate the signature", () => {
  const base = sigOf(BASE());
  for (const [field, value] of [
    ["name", "U1 Blue"], ["brand", "Creality"], ["url", "http://192.168.4.9"],
    ["filename", "other.gcode"], ["filamentUsed", 9999], ["completedAt", 1700000000000],
    ["activeExt", 2], ["forceDefaults", false], ["tags", ["office"]],
    ["layer", { current: 13, total: 300 }]
  ]) {
    assert.notEqual(sigOf(withField(field, value)), base, field + " must still force a rebuild");
  }
});

test("exactly four fields are absent from the signature — nothing else silently joined them", () => {
  // Guards the real hazard: someone removing one more field "because it was
  // easy" without giving it a data-live hook.
  const sig = JSON.parse(cardSignature(BASE()));
  const keys = Object.keys(sig).sort();
  assert.deepEqual(keys, [
    "activeExt", "brand", "capabilities", "completedAt", "errorCode", "filamentUsed",
    "filename", "forceDefaults", "heads", "layer", "message", "name", "online",
    "plate", "queuedFile", "state", "statusOverride", "stem", "tags", "url"
  ]);
  // `remaining` joined the live values with the Bambu Lab connector, which
  // reports the printer's own countdown instead of leaving it to be derived
  // from elapsed/progress. Like those two it only ever feeds the
  // data-live="remaining" cell, so it is patched, never structural.
  for (const gone of ["progress", "elapsed", "bed", "hotend", "remaining"]) {
    assert.equal(gone in sig, false, gone + " must stay out of the signature");
  }
});

// ---------------------------------------------------------------------------
// Wiring: every omitted field has a hook, and the reuse path patches it
// ---------------------------------------------------------------------------

test("updateFleetCardLiveValues is called exactly where a card is REUSED, never on rebuild", () => {
  const i = appSrc.indexOf("function reconcileFleetCards(");
  const fn = appSrc.slice(i, appSrc.indexOf("\n}", i));
  assert.match(fn, /cached\.sig===sig\)\{ el=cached\.el; rebuilt=false; updateFleetCardLiveValues\(el, p\);/);
  // The rebuild branch is what tears the camera session down; the reuse
  // branch must not reach it.
  const reuseIdx = fn.indexOf("updateFleetCardLiveValues");
  const closeIdx = fn.indexOf("closeCamRtc(p.id)");
  assert.ok(closeIdx > reuseIdx, "closeCamRtc must remain in the rebuild branch below the reuse branch");
  assert.equal((fn.match(/closeCamRtc\(p\.id\)/g) || []).length, 1, "exactly one teardown site, in the rebuild branch");
});

test("every field removed from the signature has a data-live hook in buildCardHtml", () => {
  const i = appSrc.indexOf("function buildCardHtml(");
  const build = appSrc.slice(i, appSrc.indexOf("\n}", i));
  for (const hook of ["pct", "bar", "elapsed", "remaining", "hotend-val", "hotend-target", "hotend-bar", "bed-val", "bed-target", "bed-bar"]) {
    assert.ok(build.includes('data-live="' + hook + '"'), "missing hook: " + hook);
  }
});

test("the live updater writes individual style properties, never the whole style attribute", () => {
  const i = appSrc.indexOf("function updateFleetCardLiveValues(");
  const fn = appSrc.slice(i, appSrc.indexOf("\n}", i));
  assert.ok(fn.includes("el.style.width=") && fn.includes("fill.style.width="));
  assert.ok(fn.includes("el.style.background=") && fn.includes("el.style.boxShadow="));
  // Either of these would wipe .prog-fill's animation-delay seed and restart
  // the shimmer on every poll — the exact artifact this change removes.
  assert.equal(/style\.cssText/.test(fn), false, "must not assign style.cssText");
  assert.equal(/setAttribute\(\s*["']style["']/.test(fn), false, "must not assign the style attribute");
  assert.equal(/animation-?[Dd]elay/.test(fn), false, "must not touch animation-delay");
});

test("the live updater null-guards every lookup (offline and error cards have no stats bar)", () => {
  const i = appSrc.indexOf("function updateFleetCardLiveValues(");
  const fn = appSrc.slice(i, appSrc.indexOf("\n}", i));
  assert.match(fn, /const el=card\.querySelector\(sel\); if\(!el\) return;/);
  assert.match(fn, /if\(el&&el\.textContent!==txt\)/);
  assert.match(fn, /if\(fill\) fill\.style\.width=/);
});

test("the build path and the live path share one heat-bar shadow spec", () => {
  // Two hand-written "0 0 6px" strings would drift apart silently.
  assert.match(appSrc, /function heatBarShadow\(bg\)\{ return bg\?`0 0 6px \$\{bg\}`:""; \}/);
  assert.match(appSrc, /box-shadow:\$\{heatBarShadow\(bar\.bg\)\}/);
  assert.equal((appSrc.match(/0 0 6px \$\{bg\}/g) || []).length, 1, "exactly one shadow spec");
});

test("the live updater reads only the live fields off the printer", () => {
  const i = appSrc.indexOf("function updateFleetCardLiveValues(");
  const fn = appSrc.slice(i, appSrc.indexOf("\n}", i));
  const fields = [...new Set([...fn.matchAll(/\bp\.([a-zA-Z]+)/g)].map(m => m[1]))].sort();
  // "remaining": a printer-reported countdown (Bambu Lab) — see the signature
  // test above for why it is live rather than structural.
  assert.deepEqual(fields, ["bed", "elapsed", "hotend", "progress", "remaining"],
    "patching anything else means that field no longer needs to be structural — decide deliberately, not by accident");
});
