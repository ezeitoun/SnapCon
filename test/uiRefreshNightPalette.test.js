// test/uiRefreshNightPalette.test.js — the design refresh's Night theme after
// the owner's palette of 2026-11-27 (public/refresh.css, public/app.js).
//
// A palette update, not a redesign: the layouts, sizes, order and icons are
// what they were. The lavender is gone; each role has one colour, defined in
// the theme's tokens, so every view and page shows the same colour for the
// same thing:
//   page #111214 · cards, top bar, panels #191B1E · raised surfaces and
//   filament tiles #222428 · borders and dividers #303338 · text #F1F3F5 and
//   #AEB5BE · primary actions #9AB9D4 with dark text · Printing #4FB8B0 ·
//   Complete #78C79A · Paused and attention #E0B563 · Idle and Offline
//   #9BA3AE · errors and E-Stop as they were.
// A thin neutral divider under the printer's name, no coloured glows, a
// neutral outline for the active filament slot, neutral inactive navigation
// icons, a slate fill for what is selected. Day and the classic
// design are not touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const refresh = fs.readFileSync(path.join(ROOT, "public", "refresh.css"), "utf8");
const css = refresh.replace(/\/\*[\s\S]*?\*\//g, "");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

const NIGHT = 'html.ui-refresh[data-theme="dark"]';
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].replace(/\s+/g, " ").trim(), body: m[2].replace(/\s+/g, " ").trim() }));
const sels = r => r.sel.split(/,\s*(?![^()]*\))/).map(s => s.trim());
const bodyOf = sel => { const r = rules.filter(x => sels(x).includes(sel)); assert.ok(r.length, "a rule for " + sel); return r.map(x => x.body).join(" "); };
const decls = b => Object.fromEntries(b.split(";").map(d => d.trim()).filter(Boolean).map(d => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]));
// Night's tokens: the shared block (also the fallback) and the Night-only one.
const shared = decls(rules.find(r => r.sel === "html.ui-refresh, " + NIGHT).body);
const own = decls(rules.filter(r => r.sel === NIGHT).map(r => r.body).join(" "));
const night = { ...shared, ...own };
const val = k => { let v = night[k]; for (let i = 0; i < 5 && /var\(/.test(v || ""); i++) v = v.replace(/var\((--[\w-]+)\)/g, (m, n) => night[n] || m); return v; };

test("each role has the owner's colour, in the theme's tokens", () => {
  const WANT = {
    "--chassis": "#111214",                                   // page background
    "--panel": "#191B1E", "--tb-bg": "#191B1E",              // cards, top bar, panels
    "--panel-2": "#222428",                                   // raised surfaces, filament tiles
    "--line": "#303338", "--line-soft": "#303338", "--line-2": "#303338", "--tb-divider": "#303338",   // borders and dividers
    "--ink": "#F1F3F5", "--ink-dim": "#AEB5BE",              // text
    "--brand": "#9AB9D4", "--accent": "#9AB9D4", "--tb-accent": "#9AB9D4",   // primary actions and what follows them
    "--busy": "#4FB8B0",                                      // Printing
    "--ok": "#78C79A", "--complete": "#78C79A",              // Complete
    "--paused": "#E0B563", "--signal": "#E0B563",            // Paused and attention
    "--idle": "#9BA3AE", "--offline": "#9BA3AE", "--st-idle": "#9BA3AE", "--st-offline": "#9BA3AE",   // Idle and Offline
    "--bad": "#FF8A8A",                                       // errors: as it was
  };
  for (const [k, v] of Object.entries(WANT)) assert.equal(val(k), v, k);
  // Dark text on the primary colour.
  assert.equal(val("--brand-ink"), "#111214");
  assert.equal(val("--tb-badge-text"), "#111214");
});

test("no lavender is left in the refresh", () => {
  assert.doesNotMatch(refresh, /#D9B8FF|#E6CFFF|#C9A0FF|#EBD9FF|#1B1325|217,\s*184,\s*255|201,\s*160,\s*255/i);
  // The gradient buttons outside the cards (dialogs, settings) take the primary colour too.
  const p = decls(rules.find(r => r.sel === "html.ui-refresh, " + NIGHT && /--btn-p-top/.test(r.body) || r.sel === NIGHT && /--btn-p-top/.test(r.body) || /--btn-p-top:#[0-9A-F]{6}/i.test(r.body) && r.sel.includes('[data-theme="dark"]')).body);
  const hue = h => { const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); return { blueOverRed: b - r, greenOverRed: g - r }; };
  for (const k of ["--btn-p-top", "--btn-p-bottom"]) { const h = hue(p[k]); assert.ok(h.blueOverRed > 30 && h.greenOverRed > 10, k + " " + p[k] + " is a steel blue, not a purple"); }
  assert.equal(p["--btn-p-glow"], "transparent", "and no coloured glow around a dialog's main action");
});

test("Night's new tokens are Night's alone: Day keeps its own idle and accent", () => {
  for (const k of ["--accent", "--st-idle", "--st-offline", "--lane-active"]) {
    assert.ok(k in own, k + " is set for Night");
    assert.ok(!(k in shared), k + " is not in the block every refresh theme falls back to");
  }
  for (const r of rules) if (/data-theme="light"/.test(r.sel)) assert.doesNotMatch(r.body, /--st-(idle|offline)|--lane-active/, r.sel.slice(0, 60));
});

test("a printer's state has one colour wherever it is shown: cards in every view, list rows, the top bar's counts", () => {
  // statusColorText() is the one place a card or a row gets its colour from
  // (Full, Compact, Camera and List alike); the top bar's counts name theirs.
  const fn = appSrc.slice(appSrc.indexOf("function statusColorText("), appSrc.indexOf("\n}", appSrc.indexOf("function statusColorText(")));
  const colour = state => new RegExp('statusColor:"([^"]+)", statusTxt:t\\("printer_status\\.' + state + '"\\)').exec(fn)[1];
  assert.equal(colour("printing"), "var(--busy)");
  assert.equal(colour("complete"), "var(--complete)");
  assert.equal(colour("paused"), "var(--paused)");
  assert.equal(colour("error"), "var(--bad)");
  // Idle and Offline: Night's slate; every other theme and design keeps what it had.
  assert.equal(colour("idle"), "var(--st-idle, var(--ok))");
  assert.equal(colour("offline"), "var(--st-offline, var(--ink-faint))");
  const tb = appSrc.slice(appSrc.indexOf("const TB_STATUS = ["), appSrc.indexOf("];", appSrc.indexOf("const TB_STATUS = [")));
  const pill = key => new RegExp("key:'" + key + "'[^}]*color:'([^']+)'").exec(tb)[1];
  assert.equal(pill("printing"), colour("printing"));
  assert.equal(pill("idle"), colour("idle"));
  assert.equal(pill("offline"), colour("offline"));
  assert.equal(pill("attention"), colour("error"));
  // The Compact card draws its dot and its figures from the same --status-color.
  assert.match(fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8"), /body\.compact \.cc-dot\{[^}]*background:var\(--status-color\)/);
});

test("a thin neutral divider under the printer's name in every card view, whatever the state", () => {
  for (const v of ["", ".err-line", ".pause-line", ".complete-line", ".cancelled-line"]) {
    assert.match(bodyOf(NIGHT + " .prism-line" + v), /height:1px; margin-top:-1px; background:var\(--line\); box-shadow:none;/, "Full and Camera" + v);
  }
  assert.match(bodyOf(NIGHT + " body.compact .cc-line"), /height:1px; margin-top:-1px; background:var\(--line\);/, "Compact");
});

test("no coloured glows: the progress fill is flat, the status badge has no halo", () => {
  assert.match(bodyOf(NIGHT + " .prog-fill.cyan"), /background:var\(--busy\); box-shadow:none;/, "Printing: flat teal");
  assert.match(bodyOf(NIGHT + " .prog-fill.cyan::after"), /display:none;/, "no moving sheen over it");
  assert.match(bodyOf(NIGHT + " .prog-fill.green"), /background:var\(--complete\); box-shadow:none;/);
  assert.match(bodyOf(NIGHT + " .prog-fill.amber"), /box-shadow:none;/);
  assert.match(bodyOf(NIGHT + " .status-badge"), /box-shadow:none;/);
  // Errors keep their red treatment, glow included.
  assert.match(bodyOf(NIGHT + " .prog-fill.red"), /box-shadow:0 0 10px color-mix\(in srgb,var\(--bad\) 40%,transparent\)/);
});

test("the active filament slot has a neutral outline in every printer view; the filament's own colour stays on its swatch", () => {
  assert.equal(val("--lane-active"), "#9BA3AE");
  assert.match(bodyOf(NIGHT + " .afc-lane-card.rf-lane.active"), /border-color:var\(--lane-active\) !important; box-shadow:none !important; background:color-mix\(in srgb,var\(--lane-active\) \d+%,var\(--panel-2\)\) !important;/, "Full and Camera: over the lane's inline colour, tint included");
  assert.match(bodyOf(NIGHT + " body.compact .cc-tile.rf-chip.active"), /outline-color:var\(--lane-active\);/, "Compact");
});

test("navigation: neutral icons, a slate fill for what is selected", () => {
  assert.equal(val("--tb-active-bg"), "rgba(155,163,174,0.16)");
  assert.equal(val("--tb-hover"), "rgba(155,163,174,0.08)");
  assert.equal(val("--tb-active-text"), "#F1F3F5");
  assert.match(bodyOf(NIGHT + " .tb-icon"), /color:var\(--tb-text-2\);/, "inactive: the secondary text colour");
  assert.match(bodyOf(NIGHT + " .tb-cell.is-active .tb-icon"), /color:var\(--tb-active-text\);/);
  // The fleet's filters (All, Printing, Idle...): the selected one has the same slate fill.
  assert.match(bodyOf(NIGHT + " .camtabs button.active"), /background:var\(--tb-active-bg\);/);
});

test("charts and tags follow the palette: a printing bar is the Printing colour on the Utilization page too, and nothing is purple", () => {
  assert.equal(val("--uz-printing"), "#4FB8B0", "Utilization: Printing");
  assert.equal(val("--uz-paused"), "#E0B563", "Utilization: Paused");
  assert.equal(val("--uz-idle"), "#9BA3AE", "Utilization: Idle");
  assert.equal(val("--uz-error"), "#FF8A8A", "Utilization: Error");
  // Idle and Offline are both slate; on a chart, where no label sits on each bar, Offline is the darker one.
  assert.notEqual(val("--uz-offline"), val("--uz-idle"));
  const purple = h => { const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); return b > g + 25 && r > g + 5; };
  for (const k of ["--uz-unknown", "--uz-offline", "--storage-gcode", "--storage-camera", "--storage-logs", "--type-3mf", "--type-3mf-ink", "--type-gcode-ink"]) {
    assert.match(val(k), /^#[0-9A-F]{6}$/i, k + " is set for Night");
    assert.ok(!purple(val(k)), k + " " + val(k) + " is not a purple");
  }
});

test("the last hard-coded dark-theme colours and glows give way to the tokens", () => {
  assert.match(bodyOf(NIGHT + " .hdr-name"), /color:var\(--ink\);/, "the printer's name");
  assert.match(bodyOf(NIGHT + " .prog-time-val"), /color:var\(--ink\);/, "the times under the progress bar");
  assert.match(bodyOf(NIGHT + " .pill-btn"), /color:var\(--ink-dim\);/, "the small links in a card's head");
  assert.match(bodyOf(NIGHT + " .prog-pct.cyan"), /color:var\(--ink\); filter:none;/, "the percentage: no halo");
  assert.match(bodyOf(NIGHT + " .prog-pct.amber"), /color:var\(--ink\); filter:none;/);
  // The temperature bars keep their heat colour (it is data) and lose the glow, which is written inline.
  assert.match(bodyOf(NIGHT + " .stats-mini-fill"), /box-shadow:none !important;/);
});
