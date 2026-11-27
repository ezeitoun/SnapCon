// test/uiRefreshTokens.test.js — the design refresh's colour tokens
// (Part 1, docs/ui-refresh-changes.md): the owner's values are the ones in
// refresh.css and text stays at 4.5:1 or better. (Awareness, a third theme
// with a copy of every light-surface rule, was removed on 2026-11-27.)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const style = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
const refresh = fs.readFileSync(path.join(ROOT, "public", "refresh.css"), "utf8");

// Top-level rules as [selector, declarations], comments removed, whitespace normalised.
function rules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = []; let at = 0, pre = 0; const stack = [];
  while (at < src.length) {
    const c = src[at];
    if (c === "{") {
      const p = src.slice(pre, at).trim();
      if (p.startsWith("@")) { stack.push(p); pre = at + 1; }
      else { const end = src.indexOf("}", at); out.push([p.replace(/\s+/g, " "), src.slice(at + 1, end).replace(/\s+/g, " ").trim(), stack.slice()]); at = end; pre = end + 1; }
    } else if (c === "}") { stack.pop(); pre = at + 1; }
    at++;
  }
  return out;
}
const decls = body => Object.fromEntries(body.split(";").map(d => d.trim()).filter(Boolean).map(d => { const i = d.indexOf(":"); return [d.slice(0, i).trim(), d.slice(i + 1).trim()]; }));

// The token blocks of refresh.css, per theme, with var() resolved inside the theme.
function themeTokens(theme) {
  const all = rules(refresh);
  const pick = sels => Object.assign({}, ...all.filter(([s]) => sels.includes(s)).map(([, b]) => decls(b)));
  const t = theme === "dark" ? pick(['html.ui-refresh, html.ui-refresh[data-theme="dark"]'])
    : pick(['html.ui-refresh[data-theme="light"]']);
  const resolve = v => { let x = v; for (let i = 0; i < 5; i++) x = x.replace(/var\((--[\w-]+)\)/g, (_, k) => t[k] || "var(" + k + ")"); return x; };
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, resolve(v)]));
}
const OWNER = {
  // Night: the owner's palette of 2026-11-27 (test/uiRefreshNightPalette.test.js).
  dark: { "--chassis": "#111214", "--panel": "#191B1E", "--panel-2": "#222428", "--line": "#303338", "--line-soft": "#303338", "--line-2": "#303338",
    "--ink": "#F1F3F5", "--ink-dim": "#AEB5BE", "--ink-faint": "#8B929C", "--busy": "#4FB8B0", "--ok": "#78C79A", "--complete": "#78C79A",
    "--paused": "#E0B563", "--bad": "#FF8A8A", "--idle": "#9BA3AE", "--signal": "#E0B563", "--tb-bg": "#191B1E", "--tb-accent": "#9AB9D4",
    "--tb-active-bg": "rgba(155,163,174,0.16)", "--tb-active-text": "#F1F3F5", "--tb-badge-text": "#111214", "--brand": "#9AB9D4", "--brand-ink": "#111214", "color-scheme": "dark" },
  light: { "--chassis": "#FFF4D6", "--panel": "#FFFBEF", "--panel-2": "#FFFFFF", "--line": "#EFE2BC", "--line-soft": "#F3E8C8", "--line-2": "#F3E8C8",
    "--ink": "#1D1B2C", "--ink-dim": "#6A6248", "--ink-faint": "#766E52", "--busy": "#263BAA", "--ok": "#1B6E46", "--complete": "#1B6E46",
    "--paused": "#8A5300", "--bad": "#B42318", "--idle": "#6A6248", "--signal": "#8A5300", "--tb-bg": "#FFFBEF", "--tb-accent": "#263BAA",
    "--tb-active-bg": "rgba(38,59,170,0.10)", "--tb-active-text": "#263BAA", "--tb-badge-text": "#FFFFFF", "--brand": "#263BAA", "--brand-ink": "#FFFFFF", "color-scheme": "light" },
};

test("the owner's values, and the derived top-bar tokens, are what refresh.css sets", () => {
  for (const [theme, want] of Object.entries(OWNER)) {
    const t = themeTokens(theme);
    for (const [k, v] of Object.entries(want)) assert.equal(t[k], v, `${theme} ${k}`);
    assert.equal(t["--tb-text"], want["--ink"], theme);
    assert.equal(t["--tb-text-2"], want["--ink-dim"], theme);
    assert.equal(t["--tb-muted"], want["--ink-dim"], theme);
    assert.equal(t["--tb-divider"], want["--line"], theme);
    assert.equal(t["--tb-menu"], want["--panel"], theme);
    assert.equal(t["--tb-menu-border"], want["--line"], theme);
    assert.equal(t["--offline"], want["--idle"], theme);
    const half = want["--tb-active-bg"].replace(/,([\d.]+)\)$/, (_, a) => "," + (Number(a) / 2) + ")");
    assert.equal(t["--tb-hover"], half, theme + " --tb-hover is the active tint at half strength");
  }
  // Dark keeps its own menu scrim.
  assert.notEqual(themeTokens("dark")["--tb-scrim"], themeTokens("light")["--tb-scrim"]);
});

function lum(hex) {
  const n = hex.replace("#", ""); const c = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255);
  const f = v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("text stays at 4.5:1 or better on chassis, panel and panel-2, --ink-faint included", () => {
  for (const theme of Object.keys(OWNER)) {
    const t = themeTokens(theme);
    for (const fg of ["--ink", "--ink-dim", "--ink-faint", "--busy", "--ok", "--paused", "--bad", "--idle", "--signal", "--tb-text", "--tb-text-2"]) {
      for (const bg of ["--chassis", "--panel", "--panel-2"]) {
        const r = ratio(t[fg], t[bg]);
        assert.ok(r >= 4.5, `${theme}: ${fg} ${t[fg]} on ${bg} ${t[bg]} is ${r.toFixed(2)}:1`);
      }
    }
    assert.ok(ratio(t["--brand-ink"], t["--brand"]) >= 4.5, theme + " --brand-ink on --brand");
    assert.ok(ratio(t["--tb-active-text"], t["--tb-bg"]) >= 4.5, theme + " active top-bar text");
  }
});

const mixHex = (fg, bg, t) => { const p = h => [0, 2, 4].map(i => parseInt(h.replace("#", "").slice(i, i + 2), 16)); const a = p(fg), b = p(bg);
  return "#" + a.map((v, i) => Math.round(v * t + b[i] * (1 - t)).toString(16).padStart(2, "0")).join(""); };

test("owner decision after the contrast review: a family chip that fits a fleet printer is semibold", () => {
  // In every theme, scoped to the refresh only.
  const fit = rules(refresh).find(([s]) => s === "html.ui-refresh .lib-fam.is-fit");
  assert.equal(decls(fit[1])["font-weight"], "600");
  assert.equal(rules(refresh).filter(([s]) => /awareness/.test(s)).length, 0, "no rule is left for the removed third theme");
});
