// test/uiRefreshLanes.test.js — Part 5 of the design refresh: the spool lanes
// (Full view) and tiles (Compact) in a 2-column grid, column-first for a
// Snapmaker U1 with up to 4 lanes (T1/T2 left, T3/T4 right; owner,
// 2026-11-06), row-first otherwise; headLabel() labels; materials that wrap,
// never an ellipsis; horizontal Full-view lanes that keep click-to-unload, the
// active border and glow, and the dashed empty lane; the action bar pinned to
// the bottom of every card; and which views show the lanes at all (Full and
// Compact do, Camera view does not, in either design).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "public", "refresh.css"), "utf8");
const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
const es = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "es.json"), "utf8"));

function load({ tNotation = false } = {}) {
  const words = { ...Object.fromEntries(Object.entries(en.fleet.card).map(([k, v]) => ["fleet.card." + k, v])), ...Object.fromEntries(Object.entries(en.fleet.compact).map(([k, v]) => ["fleet.compact." + k, v])) };
  const sandbox = {
    t: (k, p = {}) => String(words[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => p[x]),
    esc: s => String(s).replace(/[&<>"']/g, c => "&#" + c.charCodeAt(0) + ";"),
    headLabel: i => (tNotation ? "T" + i : String(i + 1)), canAct: () => true,
    spoolSvg: (c, a) => `<svg data-spool="${c}"${a ? " data-active" : ""}></svg>`, emptySpoolSvg: () => '<svg data-empty></svg>',
  };
  vm.createContext(sandbox);
  const a = appSrc.indexOf("function laneGridAttrs(");
  const b = appSrc.indexOf("function buildCompactCardHtml(");
  vm.runInContext(appSrc.slice(a, b) + "\nthis.api={ laneGridAttrs, afcLanesHtmlRefresh, compactSpoolTilesHtmlRefresh };", sandbox);
  return sandbox.api;
}
const heads = n => Array.from({ length: n }, (_, i) => ({ loaded: i !== 2, hex: "#c0392b", material: i === 1 ? "PETG Translucent Extra Long Name" : "PLA" }));

test("U1 with up to 4 lanes: 2 columns, column-first; everything else row-first; one lane full width", () => {
  const api = load();
  // The fleet row's printerFamily (a U1 reports "snapmaker-u1"; Creality and AD5X printers also have 4 lanes).
  assert.equal(api.laneGridAttrs(4, "snapmaker-u1"), 'class="rf-lanes col-first" style="--rf-rows:2"');
  assert.equal(api.laneGridAttrs(3, "snapmaker-u1"), 'class="rf-lanes col-first" style="--rf-rows:2"', "odd count");
  assert.equal(api.laneGridAttrs(5, "snapmaker-u1"), 'class="rf-lanes" style="--rf-rows:3"', "over 4 lanes");
  for (const f of ["creality-sparkx-i7", "flashforge-ad5x", "creality-ender3-v3-plus", null, undefined, ""]) assert.equal(api.laneGridAttrs(4, f), 'class="rf-lanes" style="--rf-rows:2"', String(f));
  assert.equal(api.laneGridAttrs(16, null), 'class="rf-lanes" style="--rf-rows:8"', "Bambu AMS: no family, many lanes");
  assert.equal(api.laneGridAttrs(1, "snapmaker-u1"), 'class="rf-lanes single"');
  // The CSS that turns those classes into the grid.
  assert.match(css, /html\.ui-refresh \.rf-lanes\{display:grid; grid-template-columns:repeat\(2,minmax\(0,1fr\)\); grid-auto-flow:row;/);
  assert.match(css, /html\.ui-refresh \.rf-lanes\.col-first\{grid-auto-flow:column; grid-template-rows:repeat\(var\(--rf-rows\),auto\);\}/);
  assert.match(css, /html\.ui-refresh \.rf-lanes\.single\{grid-template-columns:minmax\(0,1fr\);\}/);
});

test("Full-view lanes: headLabel() labels, the whole material, state in sentence case, the classic behaviours kept", () => {
  const html = load({ tNotation: true }).afcLanesHtmlRefresh(heads(4), 0, 7, true, false, "snapmaker-u1");
  assert.match(html, /<b>T0<\/b> PLA/);
  assert.match(html, /<b>T1<\/b> PETG Translucent Extra Long Name/, "never shortened");
  assert.match(html, /<b>T3<\/b>/);
  assert.match(html, />Active</); assert.match(html, />Loaded</); assert.match(html, />Empty</);
  assert.doesNotMatch(html, />ACTIVE<|>LOADED<|>EMPTY</, "no all-caps labels (CLAUDE.md)");
  // The active lane's coloured border and inner glow, as classic.
  assert.match(html, /class="afc-lane-card rf-lane active" style="border:2px solid #c0392bbb;box-shadow:inset 0 0 20px #c0392b28,inset 0 0 6px #c0392b18;background:#c0392b14"/);
  // The dashed empty lane (classic .afc-lane-card.empty), without an unload click.
  assert.match(html, /class="afc-lane-card rf-lane empty"/);
  assert.equal((html.match(/data-unload-ext="2"/g) || []).length, 0);
  // Click-to-unload on each loaded lane.
  for (const i of [0, 1, 3]) assert.match(html, new RegExp(`data-unload-printer="7" data-unload-ext="${i}"`));
  assert.match(html, /class="rf-lanes col-first" style="--rf-rows:2"/);
  assert.match(load().afcLanesHtmlRefresh(heads(4), 0, 7, true, true, "x"), />Last used</, "a finished print's lane");
  // Status-only lanes (no unload support): no click.
  assert.doesNotMatch(load().afcLanesHtmlRefresh(heads(4), 0, 7, false, false, "x"), /data-unload/);
});

test("Compact chips: a swatch, the label and the whole material; empty slots dashed; click to unload", () => {
  const html = load().compactSpoolTilesHtmlRefresh(heads(4), 3, 9, true, "snapmaker-u1");
  assert.match(html, /^<div class="cc-tiles rf-lanes col-first" style="--rf-rows:2">/);
  assert.match(html, /<span class="rf-swatch" style="background:#c0392b"><\/span><span class="rf-chip-text"><b>2<\/b> PETG Translucent Extra Long Name<\/span>/);
  assert.match(html, /class="cc-tile rf-chip empty"[^>]*><span class="rf-swatch empty"><\/span><span class="rf-chip-text"><b>3<\/b> Empty<\/span>/);
  assert.match(html, /class="cc-tile rf-chip active spool-click" data-unload-printer="9" data-unload-ext="3"/);
  assert.match(html, /title="Slot 2, PETG Translucent Extra Long Name"/, "the full detail stays in the title");
  assert.equal(load().compactSpoolTilesHtmlRefresh([], 0, 9, true, "x"), "");
});

test("the CSS: the action bar at the bottom, materials that wrap, no ellipsis anywhere in Part 5", () => {
  const part5 = css.slice(css.indexOf("/* ---- UI-REFRESH Part 5"));
  assert.match(part5, /html\.ui-refresh \.pcard \.foot\{margin-top:auto;\}/);
  assert.doesNotMatch(part5.replace(/\/\*[\s\S]*?\*\//g, "").replace(/text-overflow:clip/g, ""), /text-overflow|ellipsis/);
  assert.match(part5, /\.cc-tile\.rf-chip\{[^}]*white-space:normal; overflow:visible; text-overflow:clip;/);
  assert.match(part5, /\.rf-chip-text\{min-width:0; overflow-wrap:anywhere;\}/);
  assert.match(part5, /\.rf-lane-name\{[^}]*overflow-wrap:anywhere;/);
  assert.match(part5, /\.rf-lane-spool svg\{width:40px; height:40px;/);
  assert.match(part5, /\.cc-tile\.rf-chip\{[^}]*border-radius:10px/, "a rounded rectangle, not a pill");
});

test("one place chooses each design; the new strings exist in both languages", () => {
  // One helper per card kind (cardLanesHtml, compactLanesHtml): the card
  // builders and the tool-change redraw both go through it.
  assert.match(appSrc, /function cardLanesHtml\(p, heads\)\{\n  return \(\/\* UI-REFRESH Part 5 \*\/uiRefresh\(\)\?afcLanesHtmlRefresh\(heads,p\.activeExt,p\.id,!!p\.capabilities\?\.unloadFilament,p\.state==='complete',p\.printerFamily\):afcLanesHtml\(/);
  assert.match(appSrc, /function compactLanesHtml\(p\)\{\n  return \(uiRefresh\(\) \? compactSpoolTilesHtmlRefresh\(p\.heads,p\.activeExt,p\.id,!!p\.capabilities\?\.unloadFilament,p\.printerFamily\) : compactSpoolTilesHtml\(/);
  assert.equal((appSrc.match(/afcLanesHtmlRefresh\(/g) || []).length, 2, "defined once, called once");
  assert.equal((appSrc.match(/compactSpoolTilesHtmlRefresh\(/g) || []).length, 2, "defined once, called once");
  for (const k of ["lane_active", "lane_loaded", "lane_last_used", "lane_empty"]) assert.ok(en.fleet.card[k] && es.fleet.card[k], k);
});

// ---- Which views show the lanes --------------------------------------------
// Camera view hides the spool lanes (the camera is that view's point); Full and
// Compact show them. Checked on the card each view really builds, against both
// stylesheets in the order the page loads them: the `display` that wins for
// the lanes container, by specificity, then by order. Also measured in a
// browser (Day and Night).
const { makeHarness } = require("./helpers/cardHarness");
const goldenPrinters = require("./fixtures/card-golden/printers");
const SHEETS = ["style.css", "refresh.css"].map(f => fs.readFileSync(path.join(ROOT, "public", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""));
// The class each view puts on <body> (the view switch in app.js).
const BODY_CLASS = { regular: [], camera: ["camview"], compact: ["compact"] };
const LANE_CONTAINERS = ["rf-lanes", "afc-lanes", "cc-tiles"];

// The class list of the element that wraps the lanes in the card a view builds.
function lanesContainer(view, refresh) {
  const h = makeHarness({ view });
  h.ctx.document.documentElement.classList.contains = c => refresh && c === "ui-refresh";
  const card = h.card({ ...goldenPrinters.printing, printerFamily: "snapmaker-u1" });
  const found = [...card.matchAll(/<div class="([^"]*)"/g)].map(m => m[1].split(" ")).filter(c => c.some(x => LANE_CONTAINERS.includes(x)));
  assert.equal(found.length, 1, `${view}: one lanes container in the card`);
  return found[0];
}
// Every style rule of a stylesheet: [selector list, declarations, enclosing at-rules].
function styleRules(sheet) {
  const out = [], open = [];
  for (const m of sheet.matchAll(/([^{}]*)([{}])/g)) {
    if (m[2] === "{") { open.push(m[1].trim()); continue; }
    const prelude = open.pop();
    if (prelude && !prelude.startsWith("@")) out.push([prelude, m[1], open.filter(p => p.startsWith("@"))]);
  }
  return out;
}
// A selector part made of a tag and classes ("body.camview", ".rf-lanes.single"); null for anything else.
const compound = s => { const m = /^([a-z]*)((?:\.[\w-]+)*)$/.exec(s); return m && { tag: m[1], classes: m[2].split(".").filter(Boolean) }; };
const fits = (c, el) => (!c.tag || c.tag === el.tag) && c.classes.every(x => el.classes.includes(x));
// The `display` the stylesheets give an element with these classes, in this
// view and design. A rule for the element that this cannot judge (an at-rule,
// a combinator, a pseudo-class, an ancestor other than html or body) fails the
// test instead of being skipped.
function displayOf(classes, view, refresh) {
  const el = { tag: "div", classes };
  const page = [{ tag: "html", classes: refresh ? ["ui-refresh"] : [] }, { tag: "body", classes: BODY_CLASS[view] }];
  let won = null;
  for (const sheet of SHEETS) for (const [selectors, decls, atRules] of styleRules(sheet)) {
    const d = [...decls.matchAll(/(?:^|;)\s*display\s*:\s*([^;]+)/g)].pop();
    if (!d) continue;
    for (const sel of selectors.split(",").map(x => x.trim())) {
      const raw = sel.split(/\s+/), last = raw[raw.length - 1];
      const subject = compound(last);
      if (!subject) { assert.ok(!classes.some(c => new RegExp("\\." + c + "(?![\\w-])").test(last)), `cannot judge "${sel}"`); continue; }
      if (!subject.classes.length || !fits(subject, el)) continue;
      const ancestors = raw.slice(0, -1).map(compound);
      assert.ok(!atRules.length && !/!important/.test(d[1]) && ancestors.every(a => a && (a.tag === "html" || a.tag === "body")), `cannot judge "${sel}"`);
      let i = 0;
      if (!ancestors.every(a => { while (i < page.length && !fits(a, page[i])) i++; return i++ < page.length; })) continue;
      const spec = [...ancestors, subject].reduce((n, c) => [n[0] + c.classes.length, n[1] + (c.tag ? 1 : 0)], [0, 0]);
      if (!won || spec[0] > won.spec[0] || (spec[0] === won.spec[0] && spec[1] >= won.spec[1])) won = { spec, value: d[1].trim() };
    }
  }
  return won && won.value;
}

test("with the refresh on, Camera view hides the lanes; Full and Compact show them", () => {
  for (const [view, container, want] of [
    ["camera", "rf-lanes col-first", "none"],
    ["regular", "rf-lanes col-first", "grid"],
    ["compact", "cc-tiles rf-lanes col-first", "grid"],
  ]) {
    const classes = lanesContainer(view, true);
    assert.equal(classes.join(" "), container, `${view}: the container the card builds`);
    assert.equal(displayOf(classes, view, true), want, view);
  }
});

test("classic is as it was: Camera view hides the lanes; Full and Compact show them", () => {
  for (const [view, container, want] of [
    ["camera", "afc-lanes", "none"],
    ["regular", "afc-lanes", "grid"],
    ["compact", "cc-tiles", "grid"],
  ]) {
    const classes = lanesContainer(view, false);
    assert.equal(classes.join(" "), container, `${view}: the container the card builds`);
    assert.equal(displayOf(classes, view, false), want, view);
  }
});
