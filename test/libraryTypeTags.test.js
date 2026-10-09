// test/libraryTypeTags.test.js — the Library card's file-type tags and its
// detail line (public/library.js): one tag per type with its title, the
// source tag showing the real extension, a click that sets the Type filter
// without opening the Model, and no "1 file" on a single-file Model.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "library.js"), "utf8");
function extractFn(name) {
  const at = src.indexOf("function " + name + "(");
  assert.ok(at > 0, name);
  return src.slice(at, src.indexOf("\n  }\n", at) + 4);
}
const iconsAt = src.indexOf("const TYPE_ICONS={");
const ctx = vm.createContext({
  t: k => k,
  tn: (k, n) => k + "#" + n,
  esc: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
  printsLine: () => "printed",
});
vm.runInContext(src.slice(iconsAt, src.indexOf("\n  };\n", iconsAt) + 5) + "\n" + ["typeTagsHtml", "cardMetaHtml"].map(extractFn).join("\n"), ctx);
const call = (n, ...a) => vm.runInContext(n, ctx)(...a);

test("one tag: the extension, its title in words, the type it filters on", () => {
  const html = call("typeTagsHtml", [{ type: "gcode", ext: "gcode" }]);
  assert.match(html, /^<span class="lib-types"><span class="lib-type" data-type="gcode" title="library\.tag_title_gcode"><svg[^]*?<\/svg><span>gcode<\/span><\/span><\/span>$/);
  assert.equal(call("typeTagsHtml", []), "");
  assert.equal(call("typeTagsHtml", undefined), "");
});

test("several tags in the order given, each styled and titled; the source tag shows its file's extension", () => {
  const html = call("typeTagsHtml", [{ type: "gcode", ext: "gcode" }, { type: "3mf_sliced", ext: "3mf" }, { type: "3mf", ext: "3mf" }, { type: "source", ext: "step" }]);
  const tags = [...html.matchAll(/<span class="lib-type([^"]*)" data-type="([^"]+)" title="([^"]+)">.*?<span>([^<]+)<\/span><\/span>/g)].map(m => [m[1], m[2], m[3], m[4]]);
  assert.deepEqual(tags, [
    ["", "gcode", "library.tag_title_gcode", "gcode"],
    [" is-3mf", "3mf_sliced", "library.tag_title_3mf_sliced", "3mf · library.tag_sliced"],
    [" is-3mf", "3mf", "library.tag_title_3mf", "3mf"],
    [" is-source", "source", "library.tag_title_source", "step"],
  ]);
});

test("detail line: a single file says nothing about itself; several still do", () => {
  const m = (o) => ({ variants: 0, projects: 0, files: 1, materials: [], prints: null, ...o });
  assert.equal(call("cardMetaHtml", m({ materials: ["PLA"], prints: { count: 1 } })), 'PLA · <span title="printed">library.n_prints#1</span>');
  assert.equal(call("cardMetaHtml", m({})), "", "nothing at all to say");
  assert.equal(call("cardMetaHtml", m({ files: 3, materials: ["PLA"] })), "library.n_files#3 · PLA");
  assert.equal(call("cardMetaHtml", m({ variants: 5, files: 5 })), "library.n_variants#5");
  assert.equal(call("cardMetaHtml", m({ projects: 2, files: 1 })), "library.n_projects#2");
});

test("clicking a tag sets the Type filter and never opens the Model", () => {
  assert.match(src, /const tag=e\.target\.closest\("\.lib-type"\);\n\s+if\(tag\)\{ e\.preventDefault\(\); e\.stopPropagation\(\); setTypeFilter\(tag\.dataset\.type\); return; \}\n\s+if\(e\.metaKey\|\|e\.ctrlKey\|\|e\.button===1\) return; e\.preventDefault\(\); go\("\/library\/m\/"\+c\.dataset\.uuid\);/);
  const set = extractFn("setTypeFilter");
  assert.match(set, /L\.filters\.type=type;/);
  assert.match(set, /loadModels\(true\);/);
  assert.match(src, /<span class="lib-well">\$\{coverHtml\(m\.cover,m\.name\)\}<span class="lib-badges">\$\{att\}\$\{off\}<\/span>\$\{typeTagsHtml\(m\.types\)\}<\/span>/, "in the picture, after the top-left badges");
});
