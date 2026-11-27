// test/cardActionRow.test.js — the row of actions at the foot of a printer
// card (Full view in both layouts, and Camera view; buildCardHtml in
// public/app.js and `.pcard .foot` in public/style.css).
//
// Owner, 2026-11-27: one compact row per card, the main action on the left,
// the pills at their natural width with 8px between them.
//   a printer that can take a job:  Print · Reprint · Upload · Preheat
//   a printer with a job:           Pause or Resume · Plate · Cancel · E-Stop
// Reported the same day: with four actions the fourth sat alone on a second
// row, because each pill was held to a quarter of the row with wide gaps.
//
// The order is checked on the cards the builder really makes; the fit is
// checked by the rules here and was measured in a browser at card widths from
// 300 to 451 px, in two fonts, with the design refresh on and off.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeHarness } = require("./helpers/cardHarness");

const ROOT = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// ---- the order ----

const caps = { camera: true, filamentHeads: true, unloadFilament: true, excludeObject: true, webUi: true };
const base = { id: 7, name: "U1 Left", brand: "SnapMaker", url: "http://192.168.1.40", online: true, heads: [{ loaded: true, hex: "#F2C200", material: "PLA" }], capabilities: caps, activeExt: 0 };
const PRINTERS = {
  idle: { ...base, state: "standby", filename: "", progress: 0, elapsed: 0 },
  finished: { ...base, state: "complete", filename: "Bracket.gcode", progress: 1, elapsed: 62820, filamentUsed: 138600, completedAt: Date.UTC(2026, 9, 15, 9, 12) },
  printing: { ...base, state: "printing", filename: "Gear box v3.gcode", progress: 0.457, elapsed: 52920, filamentUsed: 77040, plate: { total: 4, excluded: 1 } },
  paused: { ...base, state: "paused", filename: "Gear box v3.gcode", progress: 0.457, elapsed: 52920, filamentUsed: 77040, plate: { total: 4, excluded: 1 } },
  printingOneObject: { ...base, state: "printing", filename: "Vase.gcode", progress: 0.2, elapsed: 600, filamentUsed: 900, plate: { total: 1, excluded: 0 } },
  otherBrand: { ...base, id: 9, name: "K1C", brand: "Creality", state: "paused", filename: "Gear box v3.gcode", progress: 0.457, elapsed: 52920, filamentUsed: 77040, plate: { total: 4, excluded: 1 } },
};
const VIEWS = { "Full, classic layout": { view: "regular", layout: "classic" }, "Full, new layout": { view: "regular", layout: "v2" }, "Camera": { view: "camera", layout: "classic" } };

// The actions of a card's foot, in the order they are in the page, each named
// by what it does (the attribute the click handler acts on).
function actions(view, printer) {
  const html = makeHarness(VIEWS[view]).card(printer);
  const foot = /<div class="foot[^"]*">([^]*?)<\/div>/.exec(html);
  assert.ok(foot, "the card has a row of actions");
  return [...foot[1].matchAll(/<button class="btn-chip[^"]*"([^>]*)>/g)].map(m => {
    const a = m[1];
    if (/data-start="1"/.test(a)) return "Print";
    if (/data-start="0"/.test(a)) return "Upload";
    if (/data-reprint=/.test(a)) return "Reprint";
    if (/data-preheat=/.test(a)) return "Preheat";
    if (/data-act="pause"/.test(a)) return "Pause";
    if (/data-act="resume"/.test(a)) return "Resume";
    if (/data-act="cancel"/.test(a)) return "Cancel";
    if (/data-plate=/.test(a)) return "Plate";
    if (/data-estop=/.test(a)) return "E-Stop";
    return "unknown: " + a.trim();
  });
}

for (const view of Object.keys(VIEWS)) {
  test(`${view}: a printer that can take a job starts with Print; Reprint follows it after a finished print`, () => {
    assert.deepEqual(actions(view, PRINTERS.idle), ["Print", "Upload", "Preheat"]);
    assert.deepEqual(actions(view, PRINTERS.finished), ["Print", "Reprint", "Upload", "Preheat"]);
  });

  test(`${view}: a printer with a job starts with Pause or Resume and ends with the two that stop it`, () => {
    assert.deepEqual(actions(view, PRINTERS.printing), ["Pause", "Plate", "Cancel", "E-Stop"]);
    assert.deepEqual(actions(view, PRINTERS.paused), ["Resume", "Plate", "Cancel", "E-Stop"]);
    assert.deepEqual(actions(view, PRINTERS.printingOneObject), ["Pause", "Cancel", "E-Stop"], "no Plate with nothing to exclude");
  });
}

// List view: one row per printer, the actions as icon buttons. It has no
// Reprint and no Plate; what it has is in the cards' order.
function listActions(printer) {
  const html = makeHarness({ view: "list", layout: "classic" }).listRow(printer);
  const cell = /<td class="list-actions-cell"[^>]*>([^]*?)<\/td>|<div class="list-actions-cell"[^>]*>([^]*?)<\/div>/.exec(html);
  assert.ok(cell, "the row has its actions");
  return [...(cell[1] || cell[2]).matchAll(/<button class="btn-chip icon-only[^"]*"([^>]*)>/g)].map(m => {
    const a = m[1];
    if (/data-start="1"/.test(a)) return "Print";
    if (/data-start="0"/.test(a)) return "Upload";
    if (/data-preheat=/.test(a)) return "Preheat";
    if (/data-act="pause"/.test(a)) return "Pause";
    if (/data-act="resume"/.test(a)) return "Resume";
    if (/data-act="cancel"/.test(a)) return "Cancel";
    if (/data-estop=/.test(a)) return "E-Stop";
    return "unknown: " + a.trim();
  });
}

test("List: the same order as the cards, for the actions a row has", () => {
  assert.deepEqual(listActions(PRINTERS.idle), ["Print", "Upload", "Preheat"]);
  assert.deepEqual(listActions(PRINTERS.finished), ["Print", "Upload", "Preheat"]);
  assert.deepEqual(listActions(PRINTERS.printing), ["Pause", "Cancel", "E-Stop"]);
  assert.deepEqual(listActions(PRINTERS.paused), ["Resume", "Cancel", "E-Stop"]);
});

test("Compact: the card's two buttons are the first two of that order", () => {
  const main = p => { const h = makeHarness({ view: "compact", layout: "classic" }); h.ctx.__p = p; return h.run("compactCardActions(__p).main.map(a => a.label)"); };
  assert.deepEqual([...main(PRINTERS.idle)], ["printer.action_print", "printer.action_preheat"], "no Reprint, and Upload was never on this card");
  assert.deepEqual([...main(PRINTERS.finished)], ["printer.action_print", "printer.action_reprint"]);
  assert.deepEqual([...main(PRINTERS.printing)], ["printer.action_pause", "printer.action_plate"]);
  assert.deepEqual([...main(PRINTERS.paused)], ["printer.action_resume", "printer.action_plate"]);
});

test("the order follows the printer's state, not its brand", () => {
  assert.deepEqual(actions("Full, classic layout", PRINTERS.otherBrand), actions("Full, classic layout", PRINTERS.paused));
});

// ---- the row ----

const rule = sel => { const at = css.indexOf(sel + "{"); assert.ok(at >= 0, "style.css has " + sel); return css.slice(at + sel.length + 1, css.indexOf("}", at)); };
// The rules inside one `@container cardfoot (...)` block, by its condition.
function containerRules() {
  const out = [];
  for (const m of css.matchAll(/@container cardfoot \(max-width:\s*([^{]+?)\)\s*\{((?:[^{}]*\{[^{}]*\})+)\s*\}/g)) out.push({ below: m[1].trim(), rules: m[2].trim() });
  return out;
}

test("where there is room: packed from the left, 8px between the pills, each pill as wide as its own content", () => {
  const row = rule(".pcard .foot");
  assert.match(row, /justify-content:\s*flex-start/);
  const pill = rule(".pcard .foot > .btn-chip");
  assert.match(pill, /flex:\s*0 0 auto/, "its natural width: not a share of the row, not stretched");
  assert.match(pill, /padding:\s*8px 10px/, "8px above and below as before, 10px at the sides");
  // 33px is the height the icon gives a pill (15 + 16 + 2), kept when a step
  // below makes the icon smaller.
  assert.match(pill, /min-height:\s*33px/, "the same height at every step");
  // The space between pills is on the pills, so a step can narrow it (a row
  // cannot restyle itself from its own width).
  assert.match(rule(".pcard .foot > .btn-chip:not(:last-child)"), /margin-inline-end:\s*8px/);
  assert.match(row, /(^|;)\s*gap:\s*8px 0/, "8px between rows if it ever wraps; none of its own between pills");
});

test("the icons are never left out (owner, 2026-11-27: a row without them looked wrong)", () => {
  for (const m of css.matchAll(/([^{}]*\.foot[^{}]*)\{([^{}]*)\}/g)) {
    if (/\bimg\b/.test(m[1])) assert.doesNotMatch(m[2], /display:\s*none|visibility:\s*hidden|opacity:\s*0(?![.\d])/, m[1].trim());
  }
});

test("a row too narrow for that gives way in steps, before anything moves to a second row", () => {
  const row = rule(".pcard .foot");
  assert.match(row, /container-type:\s*inline-size/);
  assert.match(row, /container-name:\s*cardfoot/);
  // The steps' widths are in ch, so they follow the width of the font in use;
  // that is the pill's own font, which the row therefore has to carry.
  assert.match(row, /font-size:\s*12px/);
  assert.match(row, /font-weight:\s*600/);
  const pillBase = /\n\s*\.btn-chip\{([^}]*)\}/.exec(css);
  assert.ok(pillBase, "the pill's own rule");
  assert.match(pillBase[1], /font-size:12px; font-weight:600/, "the pill's font, which the row repeats");
  const steps = containerRules();
  const FOUR = ".pcard .foot:has(> .btn-chip:nth-child(4)) > .btn-chip";
  const three = steps.filter(s => !s.rules.includes(":nth-child(4)"));
  const four = steps.filter(s => s.rules.includes(":nth-child(4)"));
  assert.equal(three.length, 1, "any row: one step");
  assert.match(three[0].rules, /^\.pcard \.foot > \.btn-chip\{padding:8px 6px; gap:4px;\}$/);
  assert.equal(four.length, 4, "four actions: four steps");
  for (const s of steps) assert.match(s.below, /^calc\([\d.]+ch \+ \d+px\)$/, s.below);
  // Each step starts below the one before it, and only ever tightens.
  const need = s => { const m = /calc\(([\d.]+)ch \+ (\d+)px\)/.exec(s.below); return +m[1] * 7 + +m[2]; };
  const num = (s, re) => { const m = re.exec(s.rules); return m ? +m[1] : null; };
  let last = { need: Infinity, pad: 10, between: 8, font: 12, icon: 15 };
  for (const s of four) {
    assert.ok(need(s) < last.need, "starts below the step before: " + s.below);
    const now = {
      need: need(s),
      pad: num(s, new RegExp(FOUR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{[^}]*padding:8px (\\d+)px")),
      between: num(s, /margin-inline-end:(\d+)px/) ?? last.between,
      font: num(s, /font-size:([\d.]+)px/) ?? last.font,
      icon: num(s, /img\{width:(\d+)px/) ?? last.icon,
    };
    assert.ok(now.pad !== null && now.pad < last.pad, "tighter sides: " + s.below);
    assert.ok(now.between <= last.between && now.font <= last.font && now.icon <= last.icon, "never looser: " + s.below);
    last = now;
  }
  assert.ok(last.font >= 11, "the label is never smaller than 11px");
  assert.ok(last.icon >= 13, "the icon is never smaller than 13px");
  assert.ok(last.pad >= 2 && last.between >= 3, "the pills never touch");
  // While tightened, four pills share what is left of the row, so it ends at
  // the card's edge; at the last step they are their own width again, so that
  // a row which still wraps does not stretch one pill across the card.
  assert.match(four[0].rules, /flex:1 0 auto/);
  assert.match(four[3].rules, /flex:0 0 auto/);
});

test("the labels are never cut, and a row that still does not fit wraps instead of leaving the card", () => {
  assert.match(rule(".pcard .foot"), /flex-wrap:\s*wrap/);
  assert.match(rule(".btn-chip span"), /white-space:nowrap/);
  assert.doesNotMatch(rule(".pcard .foot > .btn-chip"), /min-width:\s*0|overflow:\s*hidden/);
});
