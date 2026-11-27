// test/uiRefreshTokens.test.js — the design refresh's colour tokens
// (Part 1, docs/ui-refresh-changes.md): the owner's values are the ones in
// refresh.css, text stays at 4.5:1 or better, and Awareness keeps an exact
// copy of every light-surface rule of style.css, which itself is not edited.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const style = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
const refresh = fs.readFileSync(path.join(ROOT, "public", "refresh.css"), "utf8");
const AW = 'html.ui-refresh[data-theme="awareness"]';

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

test("Awareness has an exact copy of every light rule in style.css", () => {
  const light = rules(style).filter(([sel]) => sel.includes('[data-theme="light"]'));
  assert.ok(light.length >= 45, "light rules found: " + light.length);
  const mine = rules(refresh);
  for (const [sel, body, media] of light) {
    assert.deepEqual(media, [], "a light rule inside @media needs its copy inside the same @media: " + sel);
    const want = sel.split(",").map(s => s.trim().replace(/\[data-theme="light"\]/g, AW)).join(", ");
    // Two light rules can share a selector (the token block and the chart colours): match both.
    const same = mine.filter(([s]) => s.split(",").map(x => x.trim()).join(", ") === want);
    assert.ok(same.length, "missing Awareness copy of: " + sel);
    assert.ok(same.some(([, b]) => b === body), "the Awareness copy differs from style.css for: " + sel + " — " + body.slice(0, 80));
  }
});

// The token blocks of refresh.css, per theme, with var() resolved inside the theme.
function themeTokens(theme) {
  const all = rules(refresh);
  const pick = sels => Object.assign({}, ...all.filter(([s]) => sels.includes(s)).map(([, b]) => decls(b)));
  const t = theme === "dark" ? pick(['html.ui-refresh, html.ui-refresh[data-theme="dark"]'])
    : theme === "light" ? pick(['html.ui-refresh[data-theme="light"]'])
    : pick([AW]);   // the copied light token blocks, then Awareness's own (later wins)
  const resolve = v => { let x = v; for (let i = 0; i < 5; i++) x = x.replace(/var\((--[\w-]+)\)/g, (_, k) => t[k] || "var(" + k + ")"); return x; };
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, resolve(v)]));
}
const OWNER = {
  dark: { "--chassis": "#0D0D0D", "--panel": "#18161C", "--panel-2": "#221F27", "--line": "#2D2933", "--line-soft": "#26222B", "--line-2": "#26222B",
    "--ink": "#EDE9F3", "--ink-dim": "#A49DB0", "--ink-faint": "#8C859A", "--busy": "#D9B8FF", "--ok": "#7FD9A8", "--complete": "#7FD9A8",
    "--paused": "#F2C66D", "--bad": "#FF8A8A", "--idle": "#8E879A", "--signal": "#F2C66D", "--tb-bg": "#18161C", "--tb-accent": "#D9B8FF",
    "--tb-active-bg": "rgba(217,184,255,0.16)", "--tb-active-text": "#EBD9FF", "--tb-badge-text": "#1B1325", "--brand": "#D9B8FF", "--brand-ink": "#1B1325", "color-scheme": "dark" },
  light: { "--chassis": "#FFF4D6", "--panel": "#FFFBEF", "--panel-2": "#FFFFFF", "--line": "#EFE2BC", "--line-soft": "#F3E8C8", "--line-2": "#F3E8C8",
    "--ink": "#1D1B2C", "--ink-dim": "#6A6248", "--ink-faint": "#766E52", "--busy": "#263BAA", "--ok": "#1B6E46", "--complete": "#1B6E46",
    "--paused": "#8A5300", "--bad": "#B42318", "--idle": "#6A6248", "--signal": "#8A5300", "--tb-bg": "#FFFBEF", "--tb-accent": "#263BAA",
    "--tb-active-bg": "rgba(38,59,170,0.10)", "--tb-active-text": "#263BAA", "--tb-badge-text": "#FFFFFF", "--brand": "#263BAA", "--brand-ink": "#FFFFFF", "color-scheme": "light" },
  awareness: { "--chassis": "#F9DEDF", "--panel": "#FFF6F6", "--panel-2": "#FFFFFF", "--line": "#F0C9CB", "--line-soft": "#F5D7D9", "--line-2": "#F5D7D9",
    "--ink": "#2A1A1F", "--ink-dim": "#7A5560", "--ink-faint": "#7F5C66", "--busy": "#6B2FA0", "--ok": "#1B6E46", "--complete": "#1B6E46",
    "--paused": "#8A5300", "--bad": "#9E0F24", "--idle": "#7A5560", "--signal": "#8A5300", "--tb-bg": "#FFF6F6", "--tb-accent": "#FF173D",
    "--tb-active-bg": "rgba(255,23,61,0.12)", "--tb-active-text": "#B80D2C", "--tb-badge-text": "#FFFFFF", "--brand": "#E3123A", "--brand-ink": "#FFFFFF", "color-scheme": "light" },
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
  // Light and Awareness share Light's menu shadow and scrim; Dark keeps its own.
  assert.equal(themeTokens("awareness")["--tb-scrim"], themeTokens("light")["--tb-scrim"]);
  assert.equal(themeTokens("awareness")["--tb-menu-shadow"], themeTokens("light")["--tb-menu-shadow"]);
  assert.notEqual(themeTokens("dark")["--tb-scrim"], themeTokens("light")["--tb-scrim"]);
});

test("Awareness has a value for every token Light has, so nothing falls back to a dark value", () => {
  const lightTokens = rules(style).filter(([s]) => s === '[data-theme="light"]').flatMap(([, b]) => Object.keys(decls(b)));
  const t = themeTokens("awareness");
  for (const k of lightTokens) assert.ok(k in t, "Awareness has no " + k);
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

test("owner decisions after the contrast review: violet text, the G-code tag's tint, semibold fitting chips", () => {
  const aw = themeTokens("awareness");
  assert.equal(aw["--violet-soft"], "#5B3FC4", "Awareness --violet-soft is its --violet");
  assert.equal(aw["--violet-soft"], aw["--violet"]);
  // The Maintenance status badge: violet text on the badge's 14% tint over the card.
  const badgeRule = rules(refresh).find(([s]) => s === AW + " .status-badge");
  assert.match(badgeRule[1], /color-mix\(in srgb,var\(--status-color\) 14%,var\(--panel\)\)/);
  assert.ok(ratio(aw["--violet-soft"], mixHex(aw["--violet-soft"], aw["--panel"], 0.14)) >= 4.5, "Maintenance badge in Awareness");
  // G-code tags only (3MF and source keep their own tint): tinted from their own text colour.
  const tag = rules(refresh).find(([s]) => s === AW + " .lib-type:not(.is-3mf):not(.is-source)");
  assert.ok(tag, "the G-code tag rule");
  assert.equal(decls(tag[1])["--c"], "var(--type-gcode-ink)");
  const tint = Number(aw["--type-tint"].replace("%", "")) / 100;
  assert.ok(ratio(aw["--type-gcode-ink"], mixHex(aw["--type-gcode-ink"], aw["--panel"], tint)) >= 4.5, "G-code tag text on its tint");
  // Semibold in every theme: scoped to the refresh only.
  const fit = rules(refresh).find(([s]) => s === "html.ui-refresh .lib-fam.is-fit");
  assert.equal(decls(fit[1])["font-weight"], "600");
});
