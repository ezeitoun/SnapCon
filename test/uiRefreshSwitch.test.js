// test/uiRefreshSwitch.test.js — the design refresh preview's switch
// (docs/ui-refresh-changes.md). With the preview off nothing may change, so
// the switch has to be right before anything is built on it: the first-paint
// script sets html.ui-refresh before any stylesheet loads (no flash), the
// Settings switch applies at once and is kept in this browser, ?ui= overrides
// one page load, and every rule in refresh.css is scoped to the class.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "public", "refresh.css"), "utf8");

const headScript = (() => {
  const head = html.slice(0, html.indexOf("</head>"));
  const m = /<script>([\s\S]*?)<\/script>/.exec(head);
  assert.ok(m, "first-paint script in <head>");
  return { src: m[1], at: m.index };
})();

function firstPaint({ stored = {}, search = "", storageThrows = false, prefersLight = false } = {}) {
  const classes = new Set(), attrs = {};
  const sandbox = {
    URLSearchParams,
    location: { search },
    localStorage: { getItem: k => { if (storageThrows) throw new Error("blocked"); return k in stored ? stored[k] : null; } },
    window: { matchMedia: () => ({ matches: prefersLight }) },
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, classList: { add: c => classes.add(c) } } },
  };
  vm.runInNewContext(headScript.src, sandbox);
  return { refresh: classes.has("ui-refresh"), theme: attrs["data-theme"] };
}

test("the class is set by the first-paint script, before any stylesheet loads", () => {
  const firstLink = html.indexOf('<link rel="stylesheet"');
  assert.ok(headScript.at < firstLink, "the script runs before style.css and refresh.css");
  assert.ok(html.indexOf('href="/style.css"') < html.indexOf('href="/refresh.css"'), "refresh.css loads after style.css");
});

test("off unless this browser chose it; ?ui= overrides one page load", () => {
  assert.equal(firstPaint().refresh, false, "nothing stored: classic");
  assert.equal(firstPaint({ stored: { "snapcon-ui": "classic" } }).refresh, false);
  assert.equal(firstPaint({ stored: { "snapcon-ui": "refresh" } }).refresh, true);
  assert.equal(firstPaint({ stored: { "snapcon-ui": "refresh" }, search: "?ui=classic" }).refresh, false);
  assert.equal(firstPaint({ stored: { "snapcon-ui": "classic" }, search: "?ui=refresh" }).refresh, true);
  assert.equal(firstPaint({ search: "?cards=v2&ui=refresh" }).refresh, true);
  assert.equal(firstPaint({ stored: { "snapcon-ui": "refresh" }, search: "?ui=shiny" }).refresh, true, "an unknown ?ui= is ignored");
  assert.equal(firstPaint({ stored: { "snapcon-ui": "yes" } }).refresh, false, "an unknown stored value is classic");
});

test("the theme is decided exactly as before, whatever the preview", () => {
  for (const ui of [undefined, "refresh", "classic"]) {
    const stored = ui ? { "snapcon-ui": ui } : {};
    assert.equal(firstPaint({ stored: { ...stored, "snapcon-theme": "light" } }).theme, "light");
    assert.equal(firstPaint({ stored: { ...stored, "snapcon-theme": "dark" } }).theme, "dark");
    assert.equal(firstPaint({ stored, prefersLight: true }).theme, "light");
    assert.equal(firstPaint({ stored }).theme, "dark");
  }
  // Blocked storage: classic, and the theme still follows the OS.
  assert.deepEqual(firstPaint({ storageThrows: true, prefersLight: true }), { refresh: false, theme: "light" });
  assert.deepEqual(firstPaint({ storageThrows: true, search: "?ui=refresh" }), { refresh: true, theme: "dark" });
});

function app({ initial = false, storageThrows = false } = {}) {
  const classes = new Set(initial ? ["ui-refresh"] : []);
  const store = {};
  const sandbox = {
    FLEET: [{ id: "p_1" }], renders: 0,
    document: { documentElement: { classList: { contains: c => classes.has(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } },
      getAttribute: () => "dark", setAttribute() {} } },
    localStorage: { setItem: (k, v) => { if (storageThrows) throw new Error("blocked"); store[k] = v; }, getItem: k => { if (storageThrows) throw new Error("blocked"); return k in store ? store[k] : null; } },
    shownTheme: v => v,
    $: () => null,
  };
  sandbox.renderFleet = () => { sandbox.renders++; };
  vm.createContext(sandbox);
  const at = appSrc.indexOf("function uiRefresh(){");
  const end = appSrc.indexOf("function syncUiRefreshSwitch(){", at);
  vm.runInContext(appSrc.slice(at, appSrc.indexOf("\n", end)), sandbox);
  return { sandbox, classes, store, run: src => vm.runInContext(src, sandbox) };
}

test("the switch applies at once, is kept in this browser, and rebuilds the cards only on a change", () => {
  const a = app();
  assert.equal(a.run("uiRefresh()"), false);
  a.run("applyUiRefresh(true)");
  assert.equal(a.classes.has("ui-refresh"), true);
  assert.equal(a.store["snapcon-ui"], "refresh");
  assert.equal(a.sandbox.renders, 1);
  a.run("applyUiRefresh(true)");
  assert.equal(a.sandbox.renders, 1, "no rebuild when nothing changed");
  a.run("applyUiRefresh(false)");
  assert.deepEqual([a.classes.has("ui-refresh"), a.store["snapcon-ui"], a.sandbox.renders], [false, "classic", 2]);
});

test("a page opened with ?ui= is not saved until the switch itself is flipped", () => {
  // The override set the class at first paint; nothing was written.
  const a = app({ initial: true });
  assert.equal(a.run("uiRefresh()"), true);
  assert.equal(a.store["snapcon-ui"], undefined);
  a.run("applyUiRefresh(false)");
  assert.equal(a.store["snapcon-ui"], "classic");
});

test("blocked storage still switches this page", () => {
  const a = app({ storageThrows: true });
  a.run("applyUiRefresh(true)");
  assert.equal(a.classes.has("ui-refresh"), true);
});

test("the switch is a real labelled switch, outside the View tab's Save row, in both languages", () => {
  assert.match(html, /<label class="switch-row" for="setUiRefresh"><input type="checkbox" role="switch" id="setUiRefresh" class="switch-input">/);
  // Its own card in the View tab, before the tab's other settings.
  const tab = html.indexOf('id="tab-prefs"');
  assert.ok(tab > 0 && html.indexOf('id="uiRefreshCard"', tab) > tab && html.indexOf('id="uiRefreshCard"', tab) < html.indexOf('id="setUserLocale"', tab));
  // Never read or written by the Save path.
  const save = appSrc.slice(appSrc.indexOf("async function saveConfig("), appSrc.indexOf("\n}\n", appSrc.indexOf("async function saveConfig(")));
  assert.doesNotMatch(save, /setUiRefresh|snapcon-ui/);
  for (const l of ["en", "es"]) {
    const v = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", l + ".json"), "utf8")).settings.view;
    assert.ok(v.ui_refresh_label && v.ui_refresh_desc, l);
  }
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8")).settings.view;
  assert.equal(en.ui_refresh_label, "Design refresh (preview)");
  assert.match(en.ui_refresh_desc, /This browser only\.$/);
});

test("every rule in refresh.css is scoped under html.ui-refresh", () => {
  // Comments out, then every selector list before a "{" (at-rules aside,
  // whose inner rules are checked the same way).
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [];
  const re = /([^{}]+)\{/g; let m;
  while ((m = re.exec(body))) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith("@") || /^(from|to|\d+%)(\s*,\s*(from|to|\d+%))*$/.test(sel)) continue;
    // Split on top-level commas only: :is(a, b) is one selector.
    let depth = 0, cur = "";
    for (const ch of sel) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { selectors.push(cur.trim()); cur = ""; } else cur += ch; }
    selectors.push(cur.trim());
  }
  for (const s of selectors) assert.match(s, /^html\.ui-refresh\b/, "unscoped selector: " + s);
});
