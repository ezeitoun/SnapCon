// test/helpers/cardHarness.js — runs the fleet card builders from
// public/app.js (buildCardHtml, renderFleetListRows) outside a browser, so a
// test can compare the HTML they produce.
//
// Functions are lifted out of app.js by name, as they are first called: a
// ReferenceError for a top-level function of app.js loads that function and
// runs the build again. Everything else (globals, t(), the clock) is fixed
// here, so the output only depends on the printer passed in.
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "..", "public", "app.js"), "utf8");
const FUNCS = new Set([...appSrc.matchAll(/^(?:async )?function ([A-Za-z0-9_$]+)\(/gm)].map(m => m[1]));
function extractFn(name) {
  const at = appSrc.search(new RegExp("^(?:async )?function " + name.replace(/\$/g, "\\$") + "\\(", "m"));
  // A one-line function ends on its own line; others at the next "\n}".
  const line = appSrc.slice(at, appSrc.indexOf("\n", at));
  const opens = (line.match(/\{/g) || []).length, closes = (line.match(/\}/g) || []).length;
  if (opens > 0 && opens === closes && line.trimEnd().endsWith("}")) return line;
  return appSrc.slice(at, appSrc.indexOf("\n}", at) + 2);
}
// One top-level `const NAME=` / `let NAME=` statement, to its end.
function extractConst(name) {
  const m = new RegExp("^(?:const|let) " + name + "\\s*=", "m").exec(appSrc);
  if (!m) return null;
  let depth = 0, i = m.index + m[0].length, quote = null;
  for (; i < appSrc.length; i++) {
    const c = appSrc[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) break;
  }
  return appSrc.slice(m.index, i + 1).replace(/^(const|let) /, "var ");
}

// A fixed clock: 2026-10-15 12:00 UTC. Times print as en-GB in UTC, so the
// output is the same on any machine.
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
class FixedDate extends Date {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
  toLocaleTimeString(_l, o) { return super.toLocaleTimeString("en-GB", { timeZone: "UTC", ...o }); }
  toLocaleDateString(_l, o) { return super.toLocaleDateString("en-GB", { timeZone: "UTC", ...o }); }
}

// Just enough of an element for the builders: class, data-*, style
// properties, innerHTML, children, and querySelector for the list's <tbody>.
function fakeEl(tag) {
  const el = {
    tagName: tag, className: "", innerHTML: "", dataset: {}, children: [], props: {},
    classList: {
      add: (...c) => { el.className = [el.className, ...c].filter(Boolean).join(" "); },
      contains: c => el.className.split(" ").includes(c),
    },
    style: { setProperty: (k, v) => { el.props[k] = v; } },
    appendChild: c => { el.children.push(c); return c; },
    querySelector: sel => {
      if (sel === "tbody") { if (!el.tbody) el.tbody = fakeEl("tbody"); return el.tbody; }
      return { addEventListener() {} };
    },
    addEventListener() {},
  };
  return el;
}
function serialize(el) {
  const data = Object.entries(el.dataset).map(([k, v]) => ` data-${k}="${v}"`).join("");
  const style = Object.entries(el.props).map(([k, v]) => `${k}:${v}`).join(";");
  const kids = (el.tbody ? [el.tbody] : []).concat(el.children).map(serialize).join("");
  return `<${el.tagName} class="${el.className}"${data}${style ? ` style="${style}"` : ""}>${el.innerHTML}${kids}</${el.tagName}>`;
}

// view, layout: VIEW_MODE and CARD_LAYOUT; canAct false = a view-only user.
// strings: { key: "English text" } for keys whose real text a test needs
// (placeholders filled in); any other key renders as itself.
function makeHarness({ view = "regular", layout = "classic", canAct = true, strings = {} } = {}) {
  const ctx = vm.createContext({
    Date: FixedDate, Math, Number, String, JSON, Object, Array, Map, Set, URL, URLSearchParams, parseInt, parseFloat, isFinite, Number, RegExp, Error,
    encodeURIComponent, console,
    // documentElement: the design refresh preview is off (no html.ui-refresh), so
    // the classic card markup is what these reference tests see.
    document: { createElement: fakeEl, querySelector: () => null, querySelectorAll: () => [], documentElement: { classList: { contains: () => false } } },
    // t(): the key and its parameters, so the output shows what was chosen.
    t: (k, params) => k in strings
      ? strings[k].replace(/\{(\w+)\}/g, (m, n) => (params && n in params ? String(params[n]) : m))
      : k + (params ? " " + JSON.stringify(params) : ""),
    tn: (k, n, params) => k + " " + n + (params ? " " + JSON.stringify(params) : ""),
    renderFleet() {},
  });
  vm.runInContext([
    `var VIEW_MODE=${JSON.stringify(view)}, CARD_LAYOUT=${JSON.stringify(layout)}, CARD_LAYOUT_URL=null;`,
    `var SELECTED=null, ALLOW_MAPPING=false, USE_T_NOTATION=false, USERS_ENABLED=${canAct ? "false" : "true"}, CURRENT_USER=${canAct ? "null" : "{role:'viewer'}"};`,
    `var LIST_SORT_NAME_DIR=null, MATCH_THRESHOLD=60, MAPSEL={}, ERROR_CODES={};`,
    `var STATUS_OVERRIDE=new Map(), CARD_STATUS=new Map(), UPLOADS=new Map(), UPLOAD_CANCEL=new Map(), SEND_FILL=new Map(), CAM_SELECTED=new Set(), THUMB_TOKENS={}, THUMB_MISSING=new Set();`,
  ].join("\n"), ctx);
  const loaded = new Set();
  // Constants app.js defines at top level that a builder reads.
  for (const c of ["WIFI_OFF_ICON", "uploadStripKey", "HEAT_BAR_AMBIENT_C", "COLOR_FAMILIES"]) {
    const s = extractConst(c); if (s) vm.runInContext(s, ctx);
  }
  function run(code) {
    for (let tries = 0; tries < 200; tries++) {
      try { return vm.runInContext(code, ctx); }
      catch (e) {
        const m = /^([A-Za-z0-9_$]+) is not defined$/.exec(e && e.message);
        if (!m || loaded.has(m[1])) throw e;
        loaded.add(m[1]);
        if (FUNCS.has(m[1])) vm.runInContext(extractFn(m[1]), ctx);
        else { const s = extractConst(m[1]); if (!s) throw e; vm.runInContext(s, ctx); }
      }
    }
    throw new Error("too many lookups");
  }
  ctx.__p = null;
  return {
    ctx, run,
    card(p) { ctx.__p = p; return serialize(run("buildCardHtml(__p, [], false)")); },
    listRow(p) { ctx.__p = p; const wrap = fakeEl("div"); ctx.__wrap = wrap; run("renderFleetListRows([__p], __wrap, 6000)"); return serialize(wrap); },
  };
}

module.exports = { makeHarness, appSrc, extractFn, NOW };
