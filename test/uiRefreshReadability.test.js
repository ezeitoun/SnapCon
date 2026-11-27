// test/uiRefreshReadability.test.js — the readability fixes after Part 6
// (owner, 2026-11-06): one focus-ring colour per theme; lane words in theme
// ink, the filament colour only in borders and accents; readable empty
// lanes; "(Virtual)" and the Awareness "Con" above 4.5:1.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const style = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8").replace(/^﻿/, "");
const css = fs.readFileSync(path.join(ROOT, "public", "refresh.css"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const block = css.slice(css.indexOf("UI-REFRESH remediation (owner, 2026-11-06): readability"));

test("every style.css focus rule that colours its ring is re-coloured to --brand under the switch", () => {
  const noComments = style.replace(/\/\*[\s\S]*?\*\//g, "");
  const want = [];
  for (const [, sel, body] of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!sel.includes("focus-visible")) continue;
    if (!/outline\s*:\s*[^;]*?var\(--[\w-]+\)/.test(body) && !body.includes("outline-color")) continue;
    for (const s of sel.split(/,(?![^()]*\))/)) if (s.includes("focus-visible")) want.push("html.ui-refresh " + s.trim());
  }
  assert.ok(want.length >= 18);
  const m = block.match(/\*\/\s*([\s\S]*?)\{ outline-color:var\(--brand\); \}/);
  assert.ok(m, "the generated ring rule");
  const have = m[1].split(/,\n/).map(s => s.trim());
  assert.deepEqual(have, want, "regenerate the list when a coloured focus rule is added to style.css");
  assert.doesNotMatch(m[0].split("*/").pop(), /outline-(offset|width|style)|outline\s*:/, "only the colour changes");
});

test("lane words are theme ink; the filament colour stays on the border, glow and tint", () => {
  const fn = appSrc.slice(appSrc.indexOf("function afcLanesHtmlRefresh("), appSrc.indexOf("function compactSpoolTilesHtmlRefresh("));
  assert.match(fn, /<div class="rf-lane-state">\$\{esc\(laneStateText\(loaded,active,finished\)\)\}<\/div>/);
  assert.doesNotMatch(fn, /rf-lane-state"[^>]*style=/, "no inline filament colour on the state text");
  assert.match(fn, /border:2px solid \$\{color\}bb;box-shadow:inset 0 0 20px \$\{color\}28/, "the active border and glow stay");
  assert.match(block, /html\.ui-refresh \.afc-lane-card\.rf-lane\.active \.rf-lane-state\{ color:var\(--ink\); font-weight:700; \}/);
});

test("empty lanes keep the dashed border without the classic opacity on their text", () => {
  assert.match(style, /\.afc-lane-card\.empty\{border-style:dashed; opacity:0\.55;\}/, "the classic rule this overrides");
  assert.match(block, /html\.ui-refresh \.afc-lane-card\.rf-lane\.empty\{ opacity:1; \}/);
  assert.match(block, /html\.ui-refresh \.afc-lane-card\.rf-lane\.empty \.rf-lane-spool\{ opacity:\.55; \}/, "only the empty spool graphic is faded");
  assert.match(block, /\.rf-lane\.empty \.rf-lane-name\{ color:var\(--ink-dim\); \}/);
});

test("(Virtual) and the Awareness brand", () => {
  assert.match(block, /html\.ui-refresh \.hdr-transport\{ opacity:1; color:var\(--ink-faint\); \}/);
  assert.match(block, /html\.ui-refresh\[data-theme="awareness"\] \.tb-name-con\{ color:color-mix\(in srgb, var\(--tb-accent\) 72%, var\(--ink\)\); \}/);
});

test("Camera view's missing-thumbnail placeholder: faint ink at full opacity under the switch only", () => {
  assert.match(style, /\.stats-thumb-empty\{[^}]*opacity:0\.3;\}/, "the classic rule stays as it is");
  assert.match(css, /html\.ui-refresh body\.camview \.stats-thumb-empty\{ opacity:1; color:var\(--ink-faint\); \}/);
  assert.equal((css.match(/stats-thumb-empty/g) || []).length, 2, "only this rule (and its comment) touches it");
});
