// test/cardActionRowRefresh.test.js — the printer's action buttons in the
// design refresh (public/refresh.css), after the owner's mockup of
// 2026-11-27, the same in every view: the row at the foot of a card (Full and
// Camera), the Compact card's two buttons and the List row's icon buttons.
//
// Flat, 8px corners; Print and Resume in the theme's brand fill; Pause
// neutral and as wide as Resume; Cancel in the danger colour with a soft
// border; E-Stop dark red behind a short divider; everything else without a
// fill. On a card's row: 36px high, an 18px icon 6px from its label, 8px
// between buttons, one shared width for Print, Resume and Pause, E-Stop at
// the far right, and one set of sizes for every row whatever actions it has,
// so Print, Upload and Preheat measure the same on a card with Reprint and on
// one without.
//
// The order of the actions, their handlers, titles and disabled states are
// the views' own and are covered by test/cardActionRow.test.js; the one-row
// behaviour of a card's row is style.css's and is covered there too. Here:
// the rules of the refresh's look, and that a row too narrow for it tightens
// in steps without ever leaving out an icon. Measured in a browser at card
// widths from 300 to 400 px in two fonts (Night theme).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const refresh = fs.readFileSync(path.join(ROOT, "public", "refresh.css"), "utf8");
const classic = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const at = refresh.indexOf("The printer's action buttons in the design refresh");
assert.ok(at > 0, "refresh.css has the action buttons' section");
// The section runs to the next one (Night's palette), or to the end of the file.
const next = refresh.indexOf("Night palette (owner", at);
const section = refresh.slice(refresh.indexOf("*/", at) + 2, next > 0 ? refresh.lastIndexOf("/*", next) : undefined).replace(/\/\*[\s\S]*?\*\//g, "");

// Where the buttons are, per view.
const VIEWS = ":is(.pcard .foot, .cc-actions, .list-actions-cell)";
const ANY = "html.ui-refresh " + VIEWS + " > .btn-chip";          // every view's buttons
const ROW = "html.ui-refresh .pcard .foot";                        // Full and Camera
const FOUR = ROW + ":has(> .btn-chip:nth-child(4))";
const PILL = "html.ui-refresh body.compact .cc-actions > .btn-chip.cc-pill";   // Compact
const MORE = "html.ui-refresh body.compact .cc-more";
const LIST = "html.ui-refresh .list-actions-cell";                 // List

// A selector list split at its top-level commas (not those inside :is()).
function splitTop(sel) {
  const out = []; let depth = 0, cur = "";
  for (const ch of sel) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && !depth) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
// Every rule of the section: { sel, sels, body, below } (below = its container step, if any).
function rules() {
  const out = [];
  const add = (sel, body, below) => out.push({ sel: sel.replace(/\s+/g, " ").trim(), sels: splitTop(sel.replace(/\s+/g, " ").trim()), body: body.replace(/\s+/g, " ").trim(), below });
  const flat = section.replace(/@container cardfoot \(max-width:\s*([^{]+?)\)\s*\{((?:[^{}]*\{[^{}]*\})+)\s*\}/g, (m, below, inner) => {
    for (const r of inner.matchAll(/([^{}]+)\{([^{}]*)\}/g)) add(r[1], r[2], below.trim());
    return "";
  });
  for (const r of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) add(r[1], r[2], null);
  return out;
}
const ALL = rules();
const find = (sel, has) => ALL.find(x => !x.below && x.sels.includes(sel) && (!has || has.test(x.body)));
const body = (sel, has) => { const r = find(sel, has); assert.ok(r, "a rule for " + sel); return r.body; };
const night = /html\.ui-refresh\[data-theme="dark"\]\{([^}]*)\}/.exec(refresh)[1];
const classicRule = sel => { const i = classic.indexOf(sel + "{"); assert.ok(i >= 0, "style.css has " + sel); return classic.slice(i + sel.length + 1, classic.indexOf("}", i)); };

// ---- one look, every view ----

test("the look is the refresh's only, and only the printers' action buttons'", () => {
  assert.ok(ALL.length >= 35, "the section's rules were found: " + ALL.length);
  const themed = 'html.ui-refresh[data-theme="dark"] ';
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const allowed = new RegExp("^(" + [esc(ANY), esc(themed + VIEWS + " > .btn-chip"), esc(ROW), esc(PILL), esc(MORE), esc(LIST)].join("|") + ")");
  for (const r of ALL) for (const s of r.sels) assert.match(s, allowed, "scoped to the refresh and to the action buttons: " + s);
  assert.doesNotMatch(classic, /--ar-(primary|pad|icon|gap|font|divider)/, "classic keeps its own buttons");
});

test("one look in every view: every colour, border and state is written once, for the row, the Compact buttons and the List buttons together", () => {
  const LOOK = /(^|;\s*)(background|color|border|border-color|border-radius|box-shadow|filter|opacity)\s*:/;
  const looks = ALL.filter(r => LOOK.test(r.body) && !r.sels[0].startsWith(MORE));
  assert.ok(looks.length >= 15, "the look's rules were found: " + looks.length);
  for (const r of looks) for (const s of r.sels) assert.ok(s.includes(" " + VIEWS + " > .btn-chip"), "for all three: " + s);
  // And a button's size is never set there: the sizes are each view's own.
  // (The divider before E-Stop is drawn there, with its own 1px width.)
  for (const r of looks) if (!/::before$/.test(r.sels[0])) assert.doesNotMatch(r.body, /(^|;\s*)(height|min-height|width|min-width|padding|gap|font-size|margin[a-z-]*)\s*:/, r.sel);
});

test("flat, with 8px corners: no gradient, bevel or glow on any action button", () => {
  assert.match(body(ANY), /border-radius:8px/);
  assert.doesNotMatch(section, /gradient\(/);
  for (const m of section.matchAll(/box-shadow:\s*([^;]+);/g)) assert.equal(m[1].trim(), "none");
  // A press moves the button 1px, as everywhere in the refresh, and brings no bevel back.
  for (const r of ALL.filter(x => /:active/.test(x.sel))) assert.match(r.body, /box-shadow:none; translate:0 1px/, r.sel);
});

test("Print and Resume: the theme's brand fill and its ink", () => {
  const b = body(ANY + '[data-start="1"]');
  assert.equal(b, body(ANY + '[data-act="resume"]'), "one rule for both");
  assert.match(b, /^background:var\(--brand\); color:var\(--brand-ink\)/);
  // Night's brand: the palette's steel blue with dark text (it was the mockup's lavender).
  assert.match(night, /--brand:#9AB9D4;/);
  assert.match(night, /--brand-ink:#111214;/);
});

test("the icons are the views' own; one is re-coloured only where its button's fill hides it", () => {
  const filtered = ALL.filter(r => /\bfilter:/.test(r.body) && / img$/.test(r.sels[0]) && !/:disabled/.test(r.sel));
  assert.deepEqual(filtered.map(r => r.sels.length), [2], "Print and Resume, in Night");
  for (const r of filtered) for (const s of r.sels) assert.match(s, /^html\.ui-refresh\[data-theme="dark"\] :is\(.+\) > \.btn-chip\[data-(start="1"|act="resume")\] img$/, s);
  for (const r of ALL) if (/ img$/.test(r.sels[0])) assert.doesNotMatch(r.body, /display:\s*none|visibility:\s*hidden|opacity:\s*0(?![.\d])|content:/, "never hidden or replaced: " + r.sel);
});

test("Plate, Reprint, Upload, Preheat and Pause: no fill, a quiet border", () => {
  assert.match(body(ANY), /^background:transparent; color:var\(--ink\); border:1px solid color-mix\(in srgb,var\(--ink\) \d+%,transparent\)/);
  // Pause is the neutral one of the three that share a width: nothing gives it a colour.
  for (const r of ALL) if (r.sels.some(s => s.includes('[data-act="pause"]'))) assert.doesNotMatch(r.body, /background|color|border/, r.sel);
});

test("Cancel: the danger colour for its label, no fill, a soft border; E-Stop is the only strong red", () => {
  const b = body(ANY + ".danger:not([data-estop])");
  const m = /^background:transparent; color:var\(--bad\); border-color:color-mix\(in srgb,var\(--bad\) (\d+)%,transparent\);$/.exec(b);
  assert.ok(m, b);
  assert.ok(+m[1] <= 25, "soft: " + m[1] + "%");
  // It still does not look like the safe actions beside it: their label is the theme's ink.
  assert.match(body(ANY), /color:var\(--ink\)/);
  for (const r of ALL) if (!/\[data-estop\]/.test(r.sel)) assert.doesNotMatch(r.body, /--btn-ds-/, "the dark red fill is E-Stop's alone: " + r.sel);
});

test("E-Stop: the dark danger fill and its border, a short divider before it", () => {
  const b = body(ANY + "[data-estop]");
  assert.match(b, /background:var\(--btn-ds-top\); color:var\(--btn-ds-ink\); border-color:var\(--btn-ds-border\)/);
  assert.match(b, /position:relative/);
  assert.ok(/html\.ui-refresh\[data-theme="dark"\]\{[^}]*--btn-ds-top:(#[0-9A-F]{6});[^}]*--btn-ds-border:(#[0-9A-F]{6});/i.test(refresh), "Night has a dark red fill and a red border for it");
  const divider = body(ANY + "[data-estop]::before");
  assert.match(divider, /content:""; position:absolute;/);
  assert.match(divider, /width:1px; height:var\(--ar-divider\);/, "short, by the view's own measure");
  assert.match(divider, /inset-inline-start:calc\(-1 \* var\(--ar-gap\) - 1px\)/, "one gap before the button");
  assert.match(divider, /pointer-events:none/, "it is not part of the button's target");
});

test("a button that cannot be used keeps a readable, muted label and icon", () => {
  const b = body(ANY + ":disabled");
  assert.match(b, /opacity:1/, "not faded as a whole, as other refresh buttons are");
  assert.match(b, /color:var\(--ink-faint\)/, "a muted label");
  assert.match(body(ANY + ":disabled img"), /^filter:grayscale\(1\); opacity:\.\d+;$/, "a muted icon, still shown");
  // Night's faint ink on Night's panel: the pair a disabled Upload is drawn in.
  const hex = k => new RegExp(k + ":(#[0-9A-Fa-f]{6});").exec(night)[1];
  const lum = h => { const c = [0, 2, 4].map(i => parseInt(h.slice(1 + i, 3 + i), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, c) => { const [x, y] = [lum(a), lum(c)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const r = ratio(hex("--ink-faint"), hex("--panel"));
  assert.ok(r >= 4.5, "readable: " + r.toFixed(2) + ":1");
});

// ---- Full and Camera: the row at the foot of a card ----

test("a card's row, the sizes of the mockup: 36px high, an 18px icon 6px from the label, 8px between buttons", () => {
  assert.match(body(ROW, /--ar-primary/), /^--ar-primary:96px; --ar-pad:10px; --ar-icon:18px; --ar-icon-gap:6px; --ar-gap:8px; --ar-font:12px; --ar-divider:18px;/, "the sizes are the row's, for every button in it");
  const b = body(ROW + " > .btn-chip", /min-height/);
  assert.match(b, /min-height:36px/);
  assert.match(b, /padding:0 var\(--ar-pad\)/, "the same sides on every button that is as wide as its content");
  assert.match(b, /(^|;\s*)gap:var\(--ar-icon-gap\)/);
  assert.match(b, /font-size:var\(--ar-font\)/);
  assert.match(body(ROW + " > .btn-chip img"), /^width:var\(--ar-icon\); height:var\(--ar-icon\);$/, "one icon box for every action");
  assert.match(body(ROW + " > .btn-chip:not(:last-child)"), /^margin-inline-end:var\(--ar-gap\);$/);
});

test("a card's row: no button grows, so a row without Reprint keeps every other button's size", () => {
  assert.match(body(ROW + " > .btn-chip", /min-height/), /flex:0 0 auto/);
  for (const r of ALL) assert.doesNotMatch(r.body, /flex:\s*1\b|flex-grow:\s*[1-9]/, r.sel);
});

test("a card's row: Print, Resume and Pause share one width, with the icon and label centred in it", () => {
  const r = ALL.find(x => !x.below && /min-width:var\(--ar-primary\)/.test(x.body));
  assert.ok(r, "a width for the main action");
  // 1px sides: at the narrowest steps "Resume" with its icon is within a pixel
  // or two of the shared width, and must stay inside it for the three to match.
  assert.equal(r.body, "min-width:var(--ar-primary); padding:0 1px;");
  for (const role of ['[data-start="1"]', '[data-act="resume"]', '[data-act="pause"]']) for (const row of [ROW, FOUR]) assert.ok(r.sels.includes(row + " > .btn-chip" + role), row + role);
  assert.equal(r.sels.length, 6, "those three and nothing else");
  // Centred: the chip's own rule (style.css) centres its icon and label.
  assert.match(/\n\s*\.btn-chip\{([^}]*)\}/.exec(classic)[1], /justify-content:center/);
});

test("a card's row: Pause is as wide as Resume, so Plate and Cancel stay where they are when a print is paused or resumed", () => {
  // Owner, 2026-11-27. The first button of a printer with a job is Pause or
  // Resume; with one width for both, everything after it keeps its place.
  const pause = ALL.filter(r => r.sels.some(s => s.includes('[data-act="pause"]')));
  assert.equal(pause.length, 2, "its width on a card's row and on a Compact card, and nothing else");
  for (const r of pause) assert.ok(r.sels.some(s => s.includes('[data-act="resume"]')), "in the rule that sizes Resume: " + r.sel);
});

test("a card's row: the rules that apply the sizes outrank the classic pills' own steps", () => {
  // style.css tightens a four-action row with the :has() selector; a refresh
  // rule without it would lose to those steps on the narrow cards.
  for (const tail of [" > .btn-chip", " > .btn-chip:not(:last-child)", " > .btn-chip img"]) {
    const r = find(ROW + tail, tail === " > .btn-chip" ? /min-height/ : null);
    assert.ok(r.sels.includes(FOUR + tail), "also written for a four-action row: " + tail);
  }
});

test("a card's row: one set of sizes for every row, by its width, never by how many actions it has", () => {
  const steps = ALL.filter(r => r.below);
  assert.equal(steps.length, 6);
  for (const s of steps) {
    assert.equal(s.sel, ROW + " > .btn-chip", "every button of every row");
    assert.match(s.below, /^calc\([\d.]+ch \+ \d+px\)$/, "in ch, so it follows the font: " + s.below);
    assert.match(s.body, /^(--ar-(primary|pad|icon|icon-gap|gap|font):[\d.]+px;\s*)+$/, "a step only sets the row's sizes: " + s.body);
  }
  // No size depends on the number of buttons: the four-action selector only
  // ever repeats a rule that is also written for any row, and sets no size.
  for (const r of ALL) for (const sel of r.sels) if (sel.includes(":nth-child(4)")) {
    assert.ok(r.sels.includes(sel.replace(FOUR, ROW)), "the same rule for any row: " + sel);
    assert.doesNotMatch(r.body, /--ar-[a-z-]+:/, "and it sets no size of its own: " + sel);
  }
});

test("a card's row too narrow for the mockup's sizes tightens in steps, and never below a readable floor", () => {
  const steps = ALL.filter(r => r.below);
  const need = s => { const m = /calc\(([\d.]+)ch \+ (\d+)px\)/.exec(s.below); return +m[1] * 7 + +m[2]; };
  const BASE = { primary: 96, pad: 10, icon: 18, "icon-gap": 6, gap: 8, font: 12 };
  const KEYS = Object.keys(BASE);
  // A step sets on the button every size that differs from the row's, so what
  // it does not name is the mockup's value, not the step before's.
  const val = (s, k) => { const m = new RegExp("--ar-" + k + ":([\\d.]+)px").exec(s.body); return m ? +m[1] : BASE[k]; };
  let last = { need: Infinity, ...BASE };
  for (const s of steps) {
    const now = { need: need(s) };
    for (const k of KEYS) now[k] = val(s, k);
    assert.ok(now.need < last.need, "starts below the step before: " + s.below);
    for (const k of KEYS) assert.ok(now[k] <= last[k], "never looser (" + k + "): " + s.below);
    assert.ok(KEYS.some(k => now[k] < last[k]), "tighter than the step before: " + s.below);
    last = now;
  }
  assert.ok(last.font >= 11, "the label is never smaller than 11px");
  assert.ok(last.icon >= 13, "the icon is never smaller than 13px");
  assert.ok(last.pad >= 2 && last.gap >= 3 && last["icon-gap"] >= 3, "nothing touches");
  assert.ok(last.primary >= 64, "Print and Resume keep a width of their own");
});

test("a card's row: E-Stop at the far right, and room for its divider", () => {
  assert.equal(body(ROW + " > .btn-chip[data-estop]"), "margin-inline-start:auto;");
  // The button before E-Stop leaves room for the divider and a gap on each side of it.
  assert.equal(body(ROW + " > .btn-chip:has(+ .btn-chip[data-estop])"), "margin-inline-end:calc(var(--ar-gap) * 2 + 1px);");
  assert.ok(find(FOUR + " > .btn-chip:has(+ .btn-chip[data-estop])"), "also for a four-action row");
});

test("a card's row keeps its place at the foot of the card, whatever is above it", () => {
  // A printer name that wraps makes its card's head taller; the row is pinned
  // to the bottom, so the rows of a line of cards share one inset.
  assert.match(refresh, /html\.ui-refresh \.pcard \.foot\{margin-top:auto;\}/);
});

// ---- Compact ----

test("Compact: the row's sizes at the Compact card's own scale, and one width for Print, Resume and Pause", () => {
  // The Compact card's buttons are 28px high with an 11.5px label (style.css),
  // against the row's 36px and 12px; the refresh scales the rest to match.
  const own = classicRule("body.compact .btn-chip.cc-pill");
  assert.match(own, /height:28px/);
  assert.match(own, /font-size:11\.5px/);
  assert.match(classicRule("body.compact .cc-actions"), /gap:6px/);
  assert.equal(body(PILL), "padding:0 8px; gap:5px;");
  assert.equal(body(PILL + " img"), "width:14px; height:14px;");
  const shared = find(PILL + '[data-start="1"]');
  assert.ok(shared, "a width for the main action");
  assert.equal(shared.body, "flex:0 0 auto; min-width:76px; padding:0 1px;");
  assert.deepEqual(shared.sels, ['[data-start="1"]', '[data-act="resume"]', '[data-act="pause"]'].map(r => PILL + r));
  // Its buttons are in the list every look is written for.
  assert.ok(VIEWS.includes(".cc-actions"));
});

test("Compact: the card's \"more\" button takes the same corners and quiet border", () => {
  assert.match(body(MORE), /^border-radius:8px; background:transparent; border-color:color-mix\(in srgb,var\(--ink\) 18%,transparent\);$/);
  assert.match(body(ANY), /border:1px solid color-mix\(in srgb,var\(--ink\) 18%,transparent\); border-radius:8px/, "as the buttons beside it");
});

// ---- List ----

test("List: the row's icon buttons keep their size, and E-Stop has its divider", () => {
  const own = classicRule(".btn-chip.icon-only");
  assert.match(own, /width:30px; height:30px/);
  assert.match(own, /border-radius:8px/);
  assert.match(classicRule(".list-actions-cell"), /gap:6px/);
  assert.equal(body(LIST), "--ar-gap:6px; --ar-divider:14px;");
  assert.equal(body(LIST + " > .btn-chip.icon-only img"), "width:16px; height:16px;");
  // One gap, the 1px divider, one gap: the row's own 6px plus this.
  assert.equal(body(LIST + " > .btn-chip[data-estop]"), "margin-inline-start:calc(var(--ar-gap) + 1px);");
  assert.ok(VIEWS.includes(".list-actions-cell"));
});
