// test/cardActiveLane.test.js — a tool change no longer rebuilds a printer's
// card.
//
// Reported 2026-11-27: on a multi-colour print the whole card was built again
// at every tool change, because the toolhead in use (activeExt) was part of
// cardSignature(). Hover and keyboard focus were lost each time and the
// thumbnail was drawn again. The toolhead in use is now out of the signature,
// and syncCardActiveLane() draws only the card's filament lanes again, with
// the same function that built them.
//
// The cards are built by the real builders (test/helpers/cardHarness.js).
// There is no browser here, so the card handed to syncCardActiveLane() is a
// stand-in that knows which lane is shown as active and records what its
// lanes block is replaced with.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeHarness, appSrc } = require("./helpers/cardHarness");

const heads = [
  { loaded: true, hex: "#F2C200", material: "PLA" },
  { loaded: true, hex: "#1E5BD8", material: "PETG" },
  { loaded: false },
  { loaded: true, hex: "#FFFFFF", material: "PLA" },
];
const printer = o => ({
  id: 7, name: "U1 Left", brand: "SnapMaker", url: "http://192.168.1.40", online: true, state: "printing",
  filename: "Gear box v3.gcode", progress: 0.4, elapsed: 600, heads,
  capabilities: { filamentHeads: true, unloadFilament: true }, activeExt: 0, ...o,
});

// A card as the page holds it: `shown` is the lane drawn as active (-1: none).
function cardOnPage({ compact, lanes, shown, focusedExt }) {
  const root = {
    outerHTML: "(as built)",
    querySelectorAll: () => Array.from({ length: lanes }, (_, i) => ({ classList: { contains: c => c === "active" && i === shown } })),
    contains: el => !!el && el.inLanes === true,
  };
  const refocused = [];
  const card = {
    classList: { contains: c => c === "cc-card" && !!compact },
    querySelector: sel => sel.startsWith("[data-unload-ext=") ? { focus: () => refocused.push(sel) } : root,
  };
  const activeElement = focusedExt === undefined ? null : { inLanes: true, dataset: { unloadExt: String(focusedExt) } };
  return { card, root, refocused, activeElement };
}
function sync(h, page, p) {
  h.ctx.document.activeElement = page.activeElement;
  h.ctx.__card = page.card; h.ctx.__p = p;
  h.run("syncCardActiveLane(__card, __p)");
  return page.root.outerHTML;
}

const VIEWS = [
  ["Full, classic layout", { view: "regular", layout: "classic" }, false],
  ["Full, new layout", { view: "regular", layout: "v2" }, false],
  ["Camera", { view: "camera", layout: "classic" }, false],
  ["Compact", { view: "compact", layout: "classic" }, true],
];

for (const [name, opts, compact] of VIEWS) {
  for (const refresh of [false, true]) {
    const design = refresh ? "design refresh" : "classic design";
    test(`${name}, ${design}: a tool change redraws the lanes exactly as a newly built card has them`, () => {
      const h = makeHarness(opts);
      if (refresh) h.ctx.document.documentElement.classList.contains = c => c === "ui-refresh";
      const before = h.card(printer({ activeExt: 0 })), after = h.card(printer({ activeExt: 1 }));
      assert.notEqual(before, after, "the two cards differ, in their lanes");
      const page = cardOnPage({ compact, lanes: heads.length, shown: 0 });
      const drawn = sync(h, page, printer({ activeExt: 1 }));
      assert.notEqual(drawn, "(as built)", "the lanes were drawn again");
      assert.ok(after.includes(drawn), "what was drawn is the lanes block of a card built for the new toolhead");
      assert.equal(before.includes(drawn), false, "and not the old one");
      assert.match(drawn, /^<div /);
    });
  }
}

test("nothing is drawn again while the toolhead in use is the one shown", () => {
  for (const [, opts, compact] of VIEWS) {
    const h = makeHarness(opts);
    const page = cardOnPage({ compact, lanes: heads.length, shown: 1 });
    assert.equal(sync(h, page, printer({ activeExt: 1 })), "(as built)");
  }
});

test("a toolhead that is empty, or none at all, is shown as no active lane", () => {
  const h = makeHarness({ view: "regular" });
  for (const activeExt of [2, null, undefined, 9]) {
    // Nothing shown as active and nothing to show: left alone.
    assert.equal(sync(h, cardOnPage({ lanes: heads.length, shown: -1 }), printer({ activeExt })), "(as built)", String(activeExt));
    // A lane was shown as active: drawn again without one.
    const drawn = sync(h, cardOnPage({ lanes: heads.length, shown: 0 }), printer({ activeExt }));
    assert.equal(/afc-lane-card active/.test(drawn), false, String(activeExt));
    assert.match(drawn, /afc-lane-card idle/);
  }
});

test("a card without lanes is left alone", () => {
  const h = makeHarness({ view: "regular" });
  h.ctx.document.activeElement = null;
  h.ctx.__card = { classList: { contains: () => false }, querySelector: () => null }; h.ctx.__p = printer({ activeExt: 1 });
  assert.doesNotThrow(() => h.run("syncCardActiveLane(__card, __p)"));
});

test("a lane that had keyboard focus gets it back; focus elsewhere is not moved", () => {
  const h = makeHarness({ view: "compact" });
  const focused = cardOnPage({ compact: true, lanes: heads.length, shown: 0, focusedExt: 3 });
  sync(h, focused, printer({ activeExt: 1 }));
  assert.deepEqual(focused.refocused, ['[data-unload-ext="3"]']);
  const elsewhere = cardOnPage({ compact: true, lanes: heads.length, shown: 0 });
  elsewhere.activeElement = { inLanes: false, dataset: {} };
  sync(h, elsewhere, printer({ activeExt: 1 }));
  assert.deepEqual(elsewhere.refocused, []);
});

test("the card is patched, not rebuilt: the toolhead in use is out of the signature and its hook runs on every kept card", () => {
  const h = makeHarness({ view: "regular" });
  const sig = p => { h.ctx.__p = p; return h.run("cardSignature(__p)"); };
  assert.equal(sig(printer({ activeExt: 0 })), sig(printer({ activeExt: 1 })));
  // Which lanes there are still rebuilds the card.
  assert.notEqual(sig(printer({})), sig(printer({ heads: heads.slice(0, 2) })));
  const at = appSrc.indexOf("function updateFleetCardLiveValues(");
  assert.match(appSrc.slice(at, appSrc.indexOf("\n}", at)), /syncCardActiveLane\(card, p\);/);
});
