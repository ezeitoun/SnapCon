// test/costCurrency.test.js — an estimated cost is written with the currency
// set in Settings > General, wherever it is shown.
//
// Reported 2026-11-27: the selected file's line in the file browser and the
// "Print a file on the printer" dialog wrote "$" whatever currency was set,
// while the Library, Health and the print log used the setting.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
function extractFn(name) {
  const at = src.indexOf("\nfunction " + name + "(");
  assert.ok(at > 0, "public/app.js has " + name + "()");
  return src.slice(at, src.indexOf("\n}\n", at) + 3);
}
// Any element the page asks for: remembers what is written to it.
function page(globals) {
  const els = {};
  const el = id => els[id] || (els[id] = new Proxy({ id, style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {} },
    { get: (o, k) => k in o ? o[k] : (typeof k === "string" && /^(querySelector|closest)$/.test(k) ? () => null : typeof k === "string" && /^(querySelectorAll)$/.test(k) ? () => [] : undefined) }));
  const ctx = vm.createContext({
    $: el, t: k => k, esc: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    fmtDuration: s => s + "s", parseTimeToHours: () => 1, canAct: () => true, energyCostEstimate: () => 0,
    FILE_TRASH_DAYS: 7, SEND_SOURCE: null, FLEET: [], ...globals,
  });
  return { ctx, els, el };
}
const palette = [{ wt: "100" }, { wt: "150.5" }];   // 250.5 g

test("the file browser's selected file: the cost carries the set currency", () => {
  for (const [currency, want] of [["€", "€5.01"], ["₪", "₪5.01"], ["$", "$5.01"]]) {
    const p = page({ FILAMENT_COST: 20, CURRENCY: currency, SELECTED: "a.gcode", MAP: { palette, meta: ["1h 2m", "250.5 g"] } });
    // Only the title and the meta line are looked at; what the function draws
    // after them needs the rest of the page.
    try { vm.runInContext(extractFn("renderJob") + "\nrenderJob();", p.ctx); } catch {}
    assert.equal(p.el("jmeta").textContent, "1h 2m  ·  250.5 g  ·  " + want);
  }
});

test("the file browser's selected file: no cost when no filament price is set", () => {
  const p = page({ FILAMENT_COST: 0, CURRENCY: "€", SELECTED: "a.gcode", MAP: { palette, meta: ["1h 2m", "250.5 g"] } });
  try { vm.runInContext(extractFn("renderJob") + "\nrenderJob();", p.ctx); } catch {}
  assert.equal(p.el("jmeta").textContent, "1h 2m  ·  250.5 g");
});

test("a file on the printer: the cost carries the set currency, written safely", () => {
  for (const [currency, want] of [["€", "€5.01"], ["$", "$5.01"], ["<b>", "&lt;b>5.01"]]) {
    const p = page({ FILAMENT_COST: 20, CURRENCY: currency, PFILE_PRINTER: "p1", PFILE_SELECTED: "a.gcode", PFILE_META: { palette, estimatedTime: 3600 } });
    vm.runInContext(extractFn("renderPfileInfo") + "\nrenderPfileInfo();", p.ctx);
    const m = /fleet\.modal\.pfile\.est_cost_label<\/span><span class="pfi-val">([^<]*)<\/span>/.exec(p.el("pfileinfo").innerHTML);
    assert.ok(m, "the cost row is there");
    assert.equal(m[1], want);
  }
});
