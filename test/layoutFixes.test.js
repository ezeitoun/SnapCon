// test/layoutFixes.test.js — two layout bugs of the classic design, fixed for
// both designs (2026-11-05):
// 1. A printer card with four actions (a completed print: Upload, Print,
//    Preheat, Print again) overflowed a standard 300px card by about 53px:
//    the chips cannot shrink below their labels. The footer now wraps.
// 2. A number stepper squeezed by its row (the heat dialog's seconds) shrank
//    its input to its padding and clipped the value. The input keeps room
//    for three digits, and every width cap leaves room for the − and +
//    buttons plus that.
// Checked here by the rules; measured in a browser in every view and theme
// (Full, Compact, Camera; Night, Day, Awareness; refresh on and off).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = sel => { const at = css.indexOf(sel + "{"); assert.ok(at >= 0, sel); return css.slice(at + sel.length + 1, css.indexOf("}", at)); };

test("a card's action row wraps instead of overflowing the card", () => {
  assert.match(rule(".pcard .foot"), /flex-wrap:\s*wrap/);
  // The chips themselves are unchanged: they keep their labels at full width.
  assert.match(rule(".btn-chip span"), /white-space:nowrap/);
});

test("a stepper's input keeps room for three digits", () => {
  const r = rule(".number-field input.field");
  assert.match(r, /min-width:\s*calc\(3ch \+ 10px\)/);
  assert.doesNotMatch(r, /min-width:\s*0[;\s]/);
  assert.match(r, /padding-left:\s*4px/);
  assert.match(r, /padding-right:\s*4px/);
});

test("every number input's width cap fits the − and + buttons plus three digits", () => {
  // Two 30px buttons + 3ch (about 26px at 14px) + 10px padding and borders.
  const MIN = 96;
  const sources = ["index.html", "app.js", "library.js", "utilization.js"].map(f => fs.readFileSync(path.join(ROOT, "public", f), "utf8"));
  const caps = [];
  for (const src of sources) for (const m of src.matchAll(/<input[^>]*type="number"[^>]*>/g)) {
    const w = /max-width:\s*(\d+)px/.exec(m[0]) || /[^-]width:\s*(\d+)px/.exec(m[0]);
    if (w) caps.push([Number(w[1]), m[0].slice(0, 90)]);
  }
  assert.ok(caps.length >= 6, "number inputs with a width cap: " + caps.length);
  for (const [w, tag] of caps) assert.ok(w >= MIN, `${w}px is too narrow for a stepper: ${tag}`);
  assert.match(sources[0], /id="bulkheatStaggerSecs" type="number" min="5" max="600" step="5" value="60" style="max-width:120px"/);
});

test("the Delete dialog's method radios take the theme's accent, in both designs", () => {
  assert.match(rule(".delete-mode-row input[type=radio]"), /accent-color:\s*var\(--accent\)/);
  const refresh = fs.readFileSync(path.join(ROOT, "public", "refresh.css"), "utf8");
  assert.match(refresh, /html\.ui-refresh \.delete-mode-row input\[type=radio\]\{accent-color:var\(--brand\);\}/);
});
