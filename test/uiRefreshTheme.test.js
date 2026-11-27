// test/uiRefreshTheme.test.js — Part 2 of the design refresh: the theme
// button. The refresh has two themes, Day and Night, the same two the classic
// design toggles between; its button names the current and the next theme and
// shows a sun or a moon. A third theme, Awareness, was removed on 2026-11-27
// (owner): a browser or an account that still has it saved is treated like
// any other unknown value, as it always was for one (the OS choice on first
// paint, ignored for an account).
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

test("first paint: Day or Night, nothing else; a saved name that no longer exists counts as nothing saved", () => {
  for (const stored of [{ "snapcon-theme": "awareness", "snapcon-ui": "refresh" }, { "snapcon-theme": "awareness", "snapcon-ui": "classic" }, { "snapcon-theme": "awareness" }, { "snapcon-theme": "sepia", "snapcon-ui": "refresh" }]) {
    assert.equal(firstPaint({ stored, prefersLight: true }).theme, "light", "the OS choice: " + JSON.stringify(stored));
    assert.equal(firstPaint({ stored, prefersLight: false }).theme, "dark", "the OS choice: " + JSON.stringify(stored));
  }
  // Light and dark, and the OS choice when nothing is saved, as before.
  assert.equal(firstPaint({ stored: { "snapcon-theme": "light", "snapcon-ui": "refresh" } }).theme, "light");
  assert.equal(firstPaint({ stored: { "snapcon-theme": "dark", "snapcon-ui": "refresh" }, prefersLight: true }).theme, "dark");
  assert.equal(firstPaint({ stored: { "snapcon-ui": "refresh" }, prefersLight: true }).theme, "light");
  assert.doesNotMatch(headSrc, /awareness/i, "the first-paint script knows two themes");
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
    grab("function syncThemeButton(){", "// UI-REFRESH: two themes"),
    grab("const THEME_CYCLE=", "// A signed-in user's saved theme"),
    grab("function applyAccountTheme(user){", "\n}\n") + "\n}",
  ].join("\n"), sandbox);
  return { els, htmlAttrs, store, classes, run: s => vm.runInContext(s, sandbox) };
}

test("the refresh's theme button goes Day -> Night -> Day", () => {
  const p = page({ refresh: true, theme: "light" });
  assert.equal(p.run("THEME_CYCLE.join()"), "light,dark");
  assert.deepEqual(["light", "dark", "awareness", "bogus"].map(x => p.run(`nextThemeRefresh(${JSON.stringify(x)})`)), ["dark", "light", "light", "light"]);
  // The click: one branch per design.
  assert.match(appSrc, /const next=uiRefresh\(\) \? nextThemeRefresh\(cur\) : \(cur==="light"\?"dark":"light"\);/);
});

test("refresh button: names the current and next theme, no aria-pressed, a sun or a moon", () => {
  for (const [theme, label, title, glyph] of [
    ["light", "Theme: Day. Switch to Night", "Switch to Night", "#tb-sun"],
    ["dark", "Theme: Night. Switch to Day", "Switch to Day", "#tb-moon"],
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

test("classic button: exactly today's toggle, and the usual glyph after the refresh's was shown", () => {
  const p = page({ refresh: true, theme: "dark" });
  p.run("syncThemeButton()");
  assert.equal(p.els.themeBtn.use.a.href, "#tb-moon");
  // Switch the refresh off: the theme stays, the classic button returns.
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

test("switching the design on or off never changes the theme, or what is saved", () => {
  for (const theme of ["light", "dark"]) {
    const p = page({ refresh: false, theme, stored: { "snapcon-theme": theme, "snapcon-ui": "classic" } });
    p.run("applyUiRefresh(true)"); assert.equal(p.htmlAttrs["data-theme"], theme);
    p.run("applyUiRefresh(false)"); assert.equal(p.htmlAttrs["data-theme"], theme);
    assert.equal(p.store["snapcon-theme"], theme);
  }
});

test("an account's theme is Day or Night; any other saved value is ignored, as an unknown one always was", () => {
  const p = page({ refresh: true, theme: "light" });
  p.run('applyAccountTheme({ theme: "dark" })');
  assert.deepEqual([p.htmlAttrs["data-theme"], p.store["snapcon-theme"]], ["dark", "dark"]);
  for (const old of ["awareness", "sepia"]) {
    const q = page({ refresh: true, theme: "light", stored: { "snapcon-theme": "light" } });
    q.run(`applyAccountTheme({ theme: ${JSON.stringify(old)} })`);
    assert.deepEqual([q.htmlAttrs["data-theme"], q.store["snapcon-theme"]], ["light", "light"], old);
  }
});

test("the server saves Day or Night only; the OS listener still only picks light or dark", () => {
  assert.match(serverSrc, /if \(theme !== "light" && theme !== "dark"\) return res\.status\(400\)\.json\(\{ error: "theme must be \\"light\\" or \\"dark\\"" \}\);/);
  assert.match(appSrc, /document\.documentElement\.setAttribute\("data-theme",e\.matches\?"light":"dark"\);/);
});

test("the two glyphs, their credit, and the theme names in both languages", () => {
  for (const id of ["tb-sun", "tb-moon"]) assert.match(html, new RegExp(`<symbol id="${id}" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1\\.75"`), id);
  const notices = fs.readFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(notices, /## Lucide/); assert.match(notices, /ISC License/); assert.match(notices, /Copyright \(c\) 2026 Lucide Icons and Contributors/);
  assert.match(notices, /the "sun" and "moon" icons/);
  for (const k of ["theme_name_light", "theme_name_dark", "theme_switch_to", "theme_current_next"]) {
    assert.ok(en.global.topbar[k] && es.global.topbar[k], k);
  }
  assert.deepEqual([en.global.topbar.theme_name_light, en.global.topbar.theme_name_dark], ["Day", "Night"]);
});

test("nothing of the removed third theme is left: no rule, glyph, name, credit or accepted value", () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
  assert.doesNotMatch(read("public/refresh.css"), /awareness/i, "refresh.css");
  assert.doesNotMatch(html, /awareness|tb-ribbon/i, "index.html");
  assert.doesNotMatch(appSrc, /"awareness"|tb-ribbon|Awareness/, "app.js");
  assert.doesNotMatch(serverSrc, /"awareness"|\\"awareness\\"/, "server.js");
  assert.doesNotMatch(read("THIRD_PARTY_NOTICES.md"), /ribbon|Awareness/, "the notices credit only what is shipped");
  assert.equal("theme_name_awareness" in en.global.topbar, false);
  assert.equal("theme_name_awareness" in es.global.topbar, false);
});
