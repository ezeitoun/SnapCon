// test/uiRefreshButtons.test.js — Part 3 of the design refresh: the four
// button roles (docs/ui-refresh-changes.md), as the owner set them on
// 2026-11-05. The filled red is E-Stop's alone, Stop is outlined, card chips
// and compact pills keep their size, the glow is only on a dialog's main
// action, presses never animate box-shadow, and progress fills use the
// status tokens.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(ROOT, "public", "refresh.css"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const part3 = css.slice(css.indexOf("UI-REFRESH Part 3: buttons"));

function rules(src) {
  const out = []; const body = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^}]*)\}/g; let m;
  while ((m = re.exec(body))) out.push({ sel: m[1].replace(/\s+/g, " ").trim(), body: m[2] });
  return out;
}
const splitTop = sel => { const out = []; let d = 0, cur = ""; for (const ch of sel) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && !d) { out.push(cur.trim()); cur = ""; } else cur += ch; } out.push(cur.trim()); return out; };
const R = rules(part3);
const withProp = (prop, valueRe) => R.filter(r => new RegExp("(^|;)\\s*" + prop + "\\s*:" + (valueRe || "")).test(r.body));

test("the filled red gradient is E-Stop's and its hold button's, nothing else", () => {
  const strong = withProp("background", "\\s*linear-gradient\\(var\\(--btn-ds-top\\)");
  const sels = strong.flatMap(r => splitTop(r.sel)).map(s => s.replace(/:hover:not\(:disabled\)$/, ""));
  assert.deepEqual([...new Set(sels)].sort(), ["html.ui-refresh .btn-chip[data-estop]", "html.ui-refresh .hc-hold-btn"]);
});

test("Stop and the other destructive actions are outlined: transparent, red text and border", () => {
  const outlined = R.find(r => r.sel.startsWith("html.ui-refresh .btn-chip.danger:not([data-estop])") && /background:transparent/.test(r.body));
  assert.ok(outlined, "the outlined danger rule");
  for (const s of [".btn-chip.danger:not([data-estop])", ".btn.danger", ".btn.ghost.danger", ".btn.danger-filled:not(.hc-hold-btn)"]) {
    assert.ok(splitTop(outlined.sel).includes("html.ui-refresh " + s), s);
  }
  assert.match(outlined.body, /color:var\(--bad\)/);
  assert.match(outlined.body, /border:1px solid var\(--bad\)/);
});

test("no minimum height on card chips or compact pills; 44px only on dialog, settings and page buttons", () => {
  for (const r of withProp("min-height", "\\s*44px")) for (const s of splitTop(r.sel)) assert.doesNotMatch(s, /btn-chip|cc-pill/, s);
  assert.ok(R.some(r => /min-height:\s*0/.test(r.body) && splitTop(r.sel).some(s => s.includes(".pcard") && s.includes(".btn"))), "buttons inside a printer card are exempt");
  assert.equal(withProp("min-height").filter(r => splitTop(r.sel).some(s => /btn-chip/.test(s))).length, 0);
});

test("the hero glow: dialog main actions only, each one real and inside a dialog", () => {
  const glow = R.filter(r => /--btn-p-glow\)/.test(r.body) && !/--btn-p-glow:/.test(r.body));
  assert.equal(glow.length, 1, "one hero rule");
  const ids = [...glow[0].sel.matchAll(/#([\w-]+)/g)].map(m => m[1]);
  assert.ok(ids.length >= 10);
  const modals = [...html.matchAll(/<div class="modal(?: [^"]*)?" id="([^"]+)"/g)].map(m => ({ id: m[1], at: m.index }));
  for (const id of ids) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > 0, id + " exists in index.html");
    const owner = modals.filter(m => m.at < at).pop();
    assert.ok(owner, id + " is inside a dialog");
    const next = modals.find(m => m.at > owner.at);
    assert.ok(!next || at < next.at, id + " belongs to " + owner.id);
  }
  // Never on a card chip.
  assert.doesNotMatch(glow[0].sel, /btn-chip|pcard/);
  // One per dialog.
  const per = {};
  for (const id of ids) { const at = html.indexOf(`id="${id}"`); const m = modals.filter(x => x.at < at).pop().id; per[m] = (per[m] || 0) + 1; }
  for (const [m, n] of Object.entries(per)) assert.equal(n, 1, m + " has one hero");
});

test("presses move by translate only: box-shadow is never transitioned", () => {
  for (const r of withProp("transition")) assert.doesNotMatch(r.body, /transition:[^;]*box-shadow/, r.sel);
  for (const r of R.filter(r => /:active/.test(r.sel))) assert.match(r.body, /translate:0 1px/, r.sel);
});

test("every role has the brand focus ring, and one disabled look", () => {
  const focus = R.find(r => /:focus-visible/.test(r.sel));
  assert.match(focus.body, /outline:2px solid var\(--brand\)/);
  assert.match(focus.body, /outline-offset:2px/);
  const disabled = R.find(r => /:disabled\s*$/.test(splitTop(r.sel)[0]) && /opacity:\s*\.45/.test(r.body));
  assert.ok(disabled);
  assert.match(disabled.body, /box-shadow:none/);
  assert.match(disabled.body, /cursor:not-allowed/);
});

test("the primary gradients keep white text off #FF173D, and button text passes 4.5:1", () => {
  assert.doesNotMatch(part3, /--btn-p-top:#FF173D|--btn-p-bottom:#FF173D/i);
  const lum = h => { const c = [0, 2, 4].map(i => parseInt(h.slice(1 + i, 3 + i), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const block of R.filter(r => /--btn-p-top:/.test(r.body))) {
    const v = k => (new RegExp(k + ":(#[0-9A-Fa-f]{6})").exec(block.body) || [])[1];
    for (const [ink, top, bottom] of [["--btn-p-ink", "--btn-p-top", "--btn-p-bottom"], ["--btn-ds-ink", "--btn-ds-top", "--btn-ds-bottom"]]) {
      assert.ok(ratio(v(ink), v(top)) >= 4.5 && ratio(v(ink), v(bottom)) >= 4.5, `${block.sel}: ${ink}`);
    }
  }
});

test("progress fills use the status tokens, not fixed colours", () => {
  const fills = R.filter(r => /\.prog-fill/.test(r.sel));
  assert.ok(fills.length >= 4);
  for (const r of fills) assert.doesNotMatch(r.body, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, r.sel);
  assert.ok(fills.some(r => /\.prog-fill\.amber/.test(r.sel) && /var\(--paused\)/.test(r.body)));
  assert.ok(fills.some(r => /\.prog-fill\.red/.test(r.sel) && /var\(--bad\)/.test(r.body)));
  assert.ok(fills.some(r => /\.prog-fill\.cyan::after/.test(r.sel) && /var\(--busy\)/.test(r.body)));
});
