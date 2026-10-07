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

// Both client-only stores cardSignature() consults: the phase badge and the
// result line a print/upload action last wrote (see setCardStatus).
const sandbox = { STATUS_OVERRIDE: new Map(), CARD_STATUS: new Map(), UPLOAD_CANCEL: new Map(), SEND_FILL: new Map(), JSON };
vm.createContext(sandbox);
// cardSignature resolves the displayed file through the same helper the card
// and list view use, so the real one comes along rather than a stand-in that
// could disagree with it.
vm.runInContext(extractFn("cardFileStem"), sandbox);
// The offline card's lastSeenAt is in the signature only while that card
// shows, which cardMode() decides — the real one, for the same reason.
vm.runInContext(extractFn("printerShowsOffline") + "\n" + extractFn("cardMode"), sandbox);
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

test("cardStatus still invalidates the signature", () => {
  // The result line lives in a store rather than the card's DOM precisely so
  // a rebuild can restore it — which only works if a new message forces that
  // rebuild in the first place.
  const before = sigOf(BASE());
  sandbox.CARD_STATUS.set("3", { cls: "pstatus err", txt: "Could not start the print" });
  try { assert.notEqual(sigOf(BASE()), before); }
  finally { sandbox.CARD_STATUS.clear(); }
});

test("a cancellable upload invalidates the signature, so its button appears and goes", () => {
  const before = sigOf(BASE());
  sandbox.UPLOAD_CANCEL.set("3", "j1");
  try { assert.notEqual(sigOf(BASE()), before); }
  finally { sandbox.UPLOAD_CANCEL.clear(); }
});

test("a send starting or ending rebuilds the card; its percentage does not", () => {
  const before = sigOf(BASE());
  sandbox.SEND_FILL.set("3", { start: false, pct: 10 });
  try {
    const during = sigOf(BASE());
    assert.notEqual(during, before);
    sandbox.SEND_FILL.set("3", { start: false, pct: 90 });
    assert.equal(sigOf(BASE()), during, "progress is patched in place, never a rebuild per tick");
  } finally { sandbox.SEND_FILL.clear(); }
});

test("an online printer's lastSeenAt, which moves on every probe, never rebuilds its card", () => {
  // Regression: lastSeenAt went into the signature unconditionally, so every
  // online card was rebuilt on every poll.
  assert.equal(sigOf({ ...BASE(), lastSeenAt: "2026-10-06T21:24:37.104Z" }),
               sigOf({ ...BASE(), lastSeenAt: "2026-10-06T21:24:41.117Z" }));
  // On the offline card it is displayed, so a different time does rebuild it.
  const off = t => sigOf({ ...BASE(), online: false, state: undefined, lastSeenAt: t });
  assert.notEqual(off("2026-10-06T21:24:37.104Z"), off("2026-10-06T21:30:00.000Z"));
});

test("the remaining structural fields all still invalidate the signature", () => {
  const base = sigOf(BASE());
  for (const [field, value] of [
    ["name", "U1 Blue"], ["brand", "Creality"], ["url", "http://192.168.4.9"],
    ["filename", "other.gcode"], ["completedAt", 1700000000000],
    ["activeExt", 2], ["forceDefaults", false], ["tags", ["office"]]
  ]) {
    assert.notEqual(sigOf(withField(field, value)), base, field + " must still force a rebuild");
  }
});

test("filament used and the layer, which move every few seconds while printing, don't rebuild the card", () => {
  // Measured 2026-10-06: filamentUsed changed 84 times in 12 polls across the
  // printing cards, so every printing card was rebuilt on every poll.
  const base = sigOf(BASE());
  assert.equal(sigOf(withField("filamentUsed", 9999)), base);
  assert.equal(sigOf(withField("layer", { current: 13, total: 300 })), base);
  assert.equal(sigOf(withField("layer", null)), base, "even appearing or going: the cell's text is patched");
});

test("the object being printed (plate.current) doesn't rebuild the card; excluding one does", () => {
  const plate = (current, excluded) => sigOf(withField("plate", { total: 4, excluded, current }));
  assert.equal(plate("BRACKET_ID_1", 0), plate("BRACKET_ID_2", 0), "the nozzle moving between objects");
  assert.notEqual(plate("BRACKET_ID_1", 0), plate("BRACKET_ID_1", 1), "an exclusion changes the Plate button's tooltip");
  assert.notEqual(sigOf(withField("plate", null)), sigOf(withField("plate", { total: 2, excluded: 0 })), "and the button's presence");
});

test("exactly six fields are absent from the signature — nothing else silently joined them", () => {
  // Guards the real hazard: someone removing one more field "because it was
  // easy" without giving it a data-live hook.
  const sig = JSON.parse(cardSignature(BASE()));
  const keys = Object.keys(sig).sort();
  assert.deepEqual(keys, [
    // cardStatus, statusOverride, uploadCancel and sendFill are the client-only stores:
    // all are rendered into the card, so all must force the rebuild that shows them.
    "activeExt", "brand", "capabilities", "cardStatus", "completedAt", "errorCode",
    "filename", "forceDefaults", "heads", "lastSeenAt", "message", "name",
    "online", "plate", "queuedFile", "sendFill", "state", "statusOverride", "stem", "tags",
    "transport", "uploadCancel", "url"
  ]);
  for (const gone of ["progress", "elapsed", "bed", "hotend", "filamentUsed", "layer"]) {
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
  for (const hook of ["pct", "bar", "elapsed", "remaining", "hotend-val", "hotend-target", "hotend-bar", "bed-val", "bed-target", "bed-bar",
    "layer-current", "layer-target", "center-val"]) {
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

test("the live updater reads only the four live fields off the printer, plus lastSeenAt for the offline card's \"ago\"", () => {
  const i = appSrc.indexOf("function updateFleetCardLiveValues(");
  const fn = appSrc.slice(i, appSrc.indexOf("\n}", i));
  const fields = [...new Set([...fn.matchAll(/\bp\.([a-zA-Z]+)/g)].map(m => m[1]))].sort();
  // lastSeenAt is the exception on purpose: it stays IN the signature (a new
  // time rebuilds the card); the updater reads it only to recompute the
  // "2h 03m ago" text, which moves with the clock, not with the data.
  assert.deepEqual(fields, ["bed", "elapsed", "hotend", "lastSeenAt", "progress"],
    "patching anything else means that field no longer needs to be structural — decide deliberately, not by accident");
  // filamentUsed and layer are read through the same helpers buildCardHtml()
  // renders them with, so the two paths can't format them differently.
  assert.match(fn, /layerDisplay\(p\)/);
  assert.match(fn, /VIEW_MODE==='camera' \? cardLayerText\(p\) : cardFilamentText\(p\)/);
  const build = appSrc.slice(appSrc.indexOf("function buildCardHtml("), appSrc.indexOf("\n}", appSrc.indexOf("function buildCardHtml(")));
  assert.match(build, /const filM=cardFilamentText\(p\);/);
  assert.match(build, /const layerTxt=cardLayerText\(p\);/);
});
