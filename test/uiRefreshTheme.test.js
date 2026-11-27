// test/uiRefreshTheme.test.js — Part 2 of the design refresh: the theme
// button cycles Day -> Night -> Awareness while the refresh is on, and stays
// exactly today's light/dark toggle while it is off. A saved "awareness"
// shows as dark with the refresh off and is never overwritten by that, so
// turning the refresh back on restores it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
const es = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "es.json"), "utf8"));

const headSrc = /<script>([\s\S]*?)<\/script>/.exec(html.slice(0, html.indexOf("</head>")))[1];
function firstPaint({ stored = {}, search = "", prefersLight = false } = {}) {
  const classes = new Set(), attrs = {};
  vm.runInNewContext(headSrc, {
    URLSearchParams, location: { search },
    localStorage: { getItem: k => (k in stored ? stored[k] : null) },
    window: { matchMedia: () => ({ matches: prefersLight }) },
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, classList: { add: c => classes.add(c) } } },
  });
  return { refresh: classes.has("ui-refresh"), theme: attrs["data-theme"] };
}

test("first paint: Awareness only with the refresh on; otherwise dark, whatever the OS says", () => {
  const aw = { "snapcon-theme": "awareness" };
  assert.deepEqual(firstPaint({ stored: { ...aw, "snapcon-ui": "refresh" } }), { refresh: true, theme: "awareness" });
  assert.deepEqual(firstPaint({ stored: { ...aw, "snapcon-ui": "classic" }, prefersLight: true }), { refresh: false, theme: "dark" });
  assert.deepEqual(firstPaint({ stored: aw, prefersLight: true }), { refresh: false, theme: "dark" });
  assert.deepEqual(firstPaint({ stored: { ...aw, "snapcon-ui": "classic" }, search: "?ui=refresh" }), { refresh: true, theme: "awareness" });
  assert.deepEqual(firstPaint({ stored: { ...aw, "snapcon-ui": "refresh" }, search: "?ui=classic" }), { refresh: false, theme: "dark" });
  // Light and dark, and the OS choice when nothing is saved, as before.
  assert.equal(firstPaint({ stored: { "snapcon-theme": "light", "snapcon-ui": "refresh" } }).theme, "light");
  assert.equal(firstPaint({ stored: { "snapcon-ui": "refresh" }, prefersLight: true }).theme, "light");
  assert.equal(firstPaint({ stored: { "snapcon-theme": "sepia", "snapcon-ui": "refresh" } }).theme, "dark", "anything unknown: dark");
});

// The theme functions of app.js, run against a minimal page.
function el(attrs = {}) {
  const a = { ...attrs }; const use = { a: { href: "#tb-theme" }, getAttribute(k) { return this.a[k]; }, setAttribute(k, v) { this.a[k] = v; } };
  return { a, title: "", textContent: "", use, getAttribute: k => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v); }, removeAttribute: k => { delete a[k]; }, querySelector: () => use };
}
function page({ refresh, theme, stored = {} }) {
  const classes = new Set(refresh ? ["ui-refresh"] : []);
  const htmlAttrs = { "data-theme": theme };
  const store = { ...stored };
  const els = { themeBtn: el({ "aria-pressed": "false" }), tbSheetTheme: el({ "aria-pressed": "false" }), tbSheetThemeLabel: el() };
  const words = { ...en.global.topbar };
  const sandbox = {
    $: id => els[id] || null,
    t: (k, p = {}) => String(words[k.replace("global.topbar.", "")] ?? k).replace(/\{(\w+)\}/g, (_, x) => p[x]),
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { documentElement: { classList: { contains: c => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
      getAttribute: k => htmlAttrs[k], setAttribute: (k, v) => { htmlAttrs[k] = v; } } },
    FLEET: [], renderFleet() {},
  };
  vm.createContext(sandbox);
  const grab = (from, to) => { const a = appSrc.indexOf(from); const b = appSrc.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return appSrc.slice(a, b); };
  vm.runInContext([
    grab("function uiRefresh(){", "\n", 0).split("\n")[0],
    grab("function applyUiRefresh(on){", "\nfunction syncUiRefreshSwitch"),
    grab("function syncThemeButton(){", "// UI-REFRESH: three themes, cycled"),
    grab("const THEME_CYCLE=", "// A signed-in user's saved theme"),
    grab("function applyAccountTheme(user){", "\n}\n") + "\n}",
  ].join("\n"), sandbox);
  return { els, htmlAttrs, store, classes, run: s => vm.runInContext(s, sandbox) };
}

test("the refresh cycles Day -> Night -> Awareness -> Day", () => {
  const p = page({ refresh: true, theme: "light" });
  assert.deepEqual(["light", "dark", "awareness", "bogus"].map(x => p.run(`nextThemeRefresh(${JSON.stringify(x)})`)), ["dark", "awareness", "light", "light"]);
  // The click: one branch per design.
  assert.match(appSrc, /const next=uiRefresh\(\) \? nextThemeRefresh\(cur\) : \(cur==="light"\?"dark":"light"\);/);
});

test("refresh button: names the current and next theme, no aria-pressed, a sun, a moon and a ribbon", () => {
  for (const [theme, label, title, glyph] of [
    ["light", "Theme: Day. Switch to Night", "Switch to Night", "#tb-sun"],
    ["dark", "Theme: Night. Switch to Awareness", "Switch to Awareness", "#tb-moon"],
    ["awareness", "Theme: Awareness. Switch to Day", "Switch to Day", "#tb-ribbon"],
  ]) {
    const p = page({ refresh: true, theme });
    p.run("syncThemeButton()");
    assert.equal(p.els.themeBtn.a["aria-label"], label);
    assert.equal(p.els.themeBtn.title, title);
    assert.equal("aria-pressed" in p.els.themeBtn.a, false);
    assert.equal("aria-pressed" in p.els.tbSheetTheme.a, false);
    assert.equal(p.els.tbSheetThemeLabel.textContent, en.global.topbar["theme_name_" + theme]);
    assert.equal(p.els.themeBtn.use.a.href, glyph);
    assert.equal(p.els.tbSheetTheme.use.a.href, glyph);
  }
});

test("classic button: exactly today's toggle, and the usual glyph even after the ribbon was shown", () => {
  const p = page({ refresh: true, theme: "awareness" });
  p.run("syncThemeButton()");
  assert.equal(p.els.themeBtn.use.a.href, "#tb-ribbon");
  // Switch the refresh off: Awareness falls back to dark, the classic button returns.
  p.run("applyUiRefresh(false)");
  assert.equal(p.htmlAttrs["data-theme"], "dark");
  assert.equal(p.els.themeBtn.use.a.href, "#tb-theme");
  assert.equal(p.els.themeBtn.a["aria-pressed"], "false");
  assert.equal(p.els.themeBtn.a["aria-label"], en.global.topbar.theme_alt_light);
  assert.equal(p.els.themeBtn.title, en.global.topbar.theme_title_to_light);
  const light = page({ refresh: false, theme: "light" });
  light.run("syncThemeButton()");
  assert.equal(light.els.themeBtn.a["aria-pressed"], "true");
  assert.equal(light.els.themeBtn.title, en.global.topbar.theme_title_to_dark);
});

test("a saved Awareness is kept while the refresh is off, and comes back when it is on", () => {
  const p = page({ refresh: false, theme: "dark", stored: { "snapcon-theme": "awareness", "snapcon-ui": "classic" } });
  p.run("applyUiRefresh(true)");
  assert.equal(p.htmlAttrs["data-theme"], "awareness");
  p.run("applyUiRefresh(false)");
  assert.equal(p.htmlAttrs["data-theme"], "dark");
  assert.equal(p.store["snapcon-theme"], "awareness", "never overwritten by switching");
  // Light and dark are not touched by the switch.
  const l = page({ refresh: true, theme: "light", stored: { "snapcon-theme": "light" } });
  l.run("applyUiRefresh(false)"); assert.equal(l.htmlAttrs["data-theme"], "light");
});

test("an account's Awareness is accepted; shown as dark while the refresh is off", () => {
  const off = page({ refresh: false, theme: "light" });
  off.run('applyAccountTheme({ theme: "awareness" })');
  assert.deepEqual([off.htmlAttrs["data-theme"], off.store["snapcon-theme"]], ["dark", "awareness"]);
  const on = page({ refresh: true, theme: "light" });
  on.run('applyAccountTheme({ theme: "awareness" })');
  assert.equal(on.htmlAttrs["data-theme"], "awareness");
  const bad = page({ refresh: true, theme: "light" });
  bad.run('applyAccountTheme({ theme: "sepia" })');
  assert.equal(bad.htmlAttrs["data-theme"], "light", "an unknown account theme is ignored, as before");
});

test("the server accepts awareness; the OS listener still only picks light or dark", () => {
  assert.match(serverSrc, /if \(theme !== "light" && theme !== "dark" && theme !== "awareness"\) return res\.status\(400\)/);
  assert.match(appSrc, /document\.documentElement\.setAttribute\("data-theme",e\.matches\?"light":"dark"\);/);
});

test("the ribbon glyph, its credit, and the theme names in both languages", () => {
  for (const id of ["tb-sun", "tb-moon", "tb-ribbon"]) assert.match(html, new RegExp(`<symbol id="${id}" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1\\.75"`), id);
  const notices = fs.readFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(notices, /## Lucide/); assert.match(notices, /ISC License/); assert.match(notices, /Copyright \(c\) 2026 Lucide Icons and Contributors/);
  for (const k of ["theme_name_light", "theme_name_dark", "theme_name_awareness", "theme_switch_to", "theme_current_next"]) {
    assert.ok(en.global.topbar[k] && es.global.topbar[k], k);
  }
  assert.deepEqual([en.global.topbar.theme_name_light, en.global.topbar.theme_name_dark, en.global.topbar.theme_name_awareness], ["Day", "Night", "Awareness"]);
});
