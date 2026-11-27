// test/libraryFilamentLine.test.js — what a printable file in the Library says
// about its filament (public/library.js).
//
// Reported: a Model's page showed each file's colours only as small dots, with
// the filament type once and the grams per colour in a hover text, and no
// cost. Each filament is now written out (colour, type, grams), with the
// file's total and what that filament costs at the price set in Settings —
// the same rule as the file browser, and nothing when no price is set.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "library.js"), "utf8");
function extractFn(name) {
  const at = src.indexOf("function " + name + "(");
  assert.ok(at > 0, "public/library.js has " + name + "()");
  return src.slice(at, src.indexOf("\n  }\n", at) + 4);
}
const fmtG = /^\s*const fmtG=.*$/m.exec(src);
assert.ok(fmtG, "the grams formatter");

// The page a file row is drawn in. `settings` is what app.js holds from
// Settings > General: the filament price per kilogram and the currency symbol.
function library(settings = {}) {
  const ctx = vm.createContext({
    t: k => k,
    tn: (k, n) => k + "#" + n,
    esc: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    fmtDuration: s => s + "s",
    thumbUrl: k => "/thumb/" + k,
    canAct: () => true,
    printerHtml: () => "", availHtml: () => "", whyHereHtml: () => "", whyPrinterHtml: () => "", fileMenuHtml: () => "",
    QUEUE_MANAGEMENT_ENABLED: false,
    FILAMENT_COST: 0, CURRENCY: "$",
    ...settings,
  });
  vm.runInContext(fmtG[0] + "\n" + ["filamentCostText", "filamentLineHtml", "variantHtml"].map(extractFn).join("\n"), ctx);
  return (n, ...a) => vm.runInContext(n, ctx)(...a);
}
const variant = o => ({
  key: "k1", plate: null, plateName: null, thumb: null, estSeconds: 3107, weightG: 16.23, copies: 1, layerHeight: 0.2, nozzle: 0.4, slicer: "Orca",
  printer: {}, profile: {}, send: { ok: true, root: "r", path: "a.gcode" },
  file: { name: "a.gcode", rootName: "G-code folder", path: "a.gcode", availability: "ok", duplicates: [], why: null },
  filaments: [
    { type: "PLA", color: "#B08D6E", grams: 6.21, vendor: "Generic" },
    { type: "PLA", color: "#FFFFFF", grams: 4.1, vendor: null },
    { type: "PETG", color: "#7A3E00", grams: 3.4, vendor: null },
    { type: "PLA", color: "#000000", grams: 2.52, vendor: null },
  ],
  ...o,
});
// The filaments written on the line: [colour, the words beside it].
const chips = html => [...html.matchAll(/<span class="lib-fil-chip"[^>]*><span class="lib-sw" style="--sw:([^"]*)"><\/span>(.*?)<\/span>(?=<span class="lib-(?:fil-chip|dim|fil-cost)|<\/div>)/g)]
  .map(m => [m[1], m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()]);

test("each filament is written out: its colour, its type and its grams", () => {
  const html = library()("filamentLineHtml", variant());
  assert.deepEqual(chips(html), [
    ["#B08D6E", "PLA 6.2 g"],
    ["#FFFFFF", "PLA 4.1 g"],
    ["#7A3E00", "PETG 3.4 g"],
    ["#000000", "PLA 2.5 g"],
  ]);
  assert.match(html, /title="PLA · Generic · #B08D6E · 6\.2 g"/, "the hover text still has the vendor and the colour code");
});

test("the file's total filament leads the line, under its label", () => {
  const html = library()("filamentLineHtml", variant());
  assert.match(html, /^<div class="lib-fil"><span class="lib-fil-lbl">library\.weight<\/span><span class="lib-fil-total">16 g<\/span>/);
});

test("the total is said once in the row, not again among the print facts", () => {
  const row = library()("variantHtml", variant());
  assert.equal(row.split(">16 g<").length - 1, 1);
  assert.match(row, /<div class="lib-var-facts">[^]*?3107s[^]*?0\.2 mm/, "time, layer height and nozzle stay where they were");
});

test("one filament: the total already says its grams, so the filament names only colour and type", () => {
  const html = library()("filamentLineHtml", variant({ weightG: 16.23, filaments: [{ type: "PLA", color: "#112233", grams: 16.23, vendor: null }] }));
  assert.deepEqual(chips(html), [["#112233", "PLA"]]);
  assert.equal(html.split("16 g").length - 1, 2, "once on the line, once in the filament's hover text");
});

test("the cost is the file's filament at the price in Settings, in the currency set there", () => {
  const lib = library({ FILAMENT_COST: 25, CURRENCY: "€" });
  assert.equal(lib("filamentCostText", 16.23), "€0.41");
  assert.match(lib("filamentLineHtml", variant()), /<span class="lib-fil-cost">fleet\.modal\.pfile\.est_cost_label <b>€0\.41<\/b><\/span><\/div>$/, "labelled as an estimate, last on the line");
});

test("no price in Settings: no cost is shown, rather than a zero", () => {
  for (const price of [0, null, undefined, "", -5, NaN]) {
    const lib = library({ FILAMENT_COST: price });
    assert.equal(lib("filamentCostText", 16.23), null, "price " + String(price));
    assert.doesNotMatch(lib("filamentLineHtml", variant()), /lib-fil-cost/);
  }
});

test("no weight known: no cost is made up", () => {
  const lib = library({ FILAMENT_COST: 25 });
  assert.equal(lib("filamentCostText", null), null);
  assert.equal(lib("filamentCostText", 0), null);
  const html = lib("filamentLineHtml", variant({ weightG: null, filaments: [{ type: "PLA", color: "#112233", grams: null, vendor: null }] }));
  assert.deepEqual(chips(html), [["#112233", "PLA"]]);
  assert.doesNotMatch(html, /lib-fil-total|lib-fil-cost/);
});

test("a file with no total of its own uses the sum of its filaments", () => {
  const html = library({ FILAMENT_COST: 20 })("filamentLineHtml", variant({ weightG: null }));
  assert.match(html, /<span class="lib-fil-total">16 g<\/span>/);
  assert.match(html, /<b>\$0\.32<\/b>/, "6.21 + 4.1 + 3.4 + 2.52 g at 20 per kg");
});

test("a file that names no filament and no weight has no filament line", () => {
  assert.equal(library()("filamentLineHtml", variant({ weightG: null, filaments: [] })), "");
  assert.doesNotMatch(library()("variantHtml", variant({ weightG: null, filaments: [] })), /lib-fil/);
});

test("more filaments than fit: the first eight, then how many more", () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ type: "PLA", color: "#00000" + (i % 10), grams: 1, vendor: null }));
  const html = library()("filamentLineHtml", variant({ weightG: 11, filaments: many }));
  assert.equal(chips(html).length, 8);
  assert.match(html, /<span class="lib-dim">library\.and_more#3<\/span>/);
});

test("a colour that is not a colour code never reaches the page's styles", () => {
  const html = library()("filamentLineHtml", variant({ filaments: [{ type: "PLA", color: 'red;background:url(//x)"><b>', grams: 2, vendor: null }, { type: "<i>TPU</i>", color: null, grams: 1, vendor: null }] }));
  assert.deepEqual([...html.matchAll(/ style="([^"]*)"/g)].map(m => m[1]), ["--sw:transparent", "--sw:transparent"], "both swatches are empty");
  assert.doesNotMatch(html, /"><b>|<i>TPU/, "nothing typed into a file becomes markup");
  assert.match(html, /&lt;i>TPU&lt;\/i>/, "a type is shown as text");
});
