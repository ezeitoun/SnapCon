// test/libraryFolders.test.js — the Library page's folder state (public/
// library.js): the folder in the URL (valid, missing, stale), the fallback
// to the nearest folder that still exists after a rescan, the Location
// dropdown and the tree as one choice, the filter parameters with Include
// subfolders on and off, the card's folder line (and no empty chip row
// above it), "Scanned … ago", and a failed scan keeping the last list.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "library.js"), "utf8");
function extractFn(name) {
  const at = src.indexOf("function " + name + "(");
  assert.ok(at > 0, name + " must exist in public/library.js");
  return src.slice(at, src.indexOf("\n  }\n", at) + 4);
}
const ctx = vm.createContext({
  URLSearchParams,
  t: (k, p) => k + (p ? "(" + Object.entries(p).map(([a, b]) => a + "=" + b).join(",") + ")" : ""),
  tn: (k, n) => k + "#" + n,
  esc: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
  ICON_FOLDER: "<svg/>",
});
vm.runInContext(["parseGridUrl", "gridUrlFor", "folderParams", "nearestFolder", "scannedText", "scanErrorText", "folderLineHtml"].map(extractFn).join("\n"), ctx);
const call = (n, ...a) => vm.runInContext(n, ctx)(...a);
const plain = v => JSON.parse(JSON.stringify(v));

const TREE = { count: 9, roots: [{ id: "nas", name: "U1 Files", count: 8, children: [
  { name: "Cinderwin 3D", path: "Cinderwin 3D", children: [] },
  { name: "STLFlix", path: "STLFlix", children: [{ name: "Dragons", path: "STLFlix/Dragons", children: [] }] },
], loose: { count: 1, total: 1 } }] };

test("URL: a folder link opens that folder; no folder parameters keeps the page's own state", () => {
  assert.deepEqual(plain(call("parseGridUrl", "?location=nas&folder=STLFlix/Dragons")), { root: "nas", folder: "STLFlix/Dragons", loose: false });
  assert.deepEqual(plain(call("parseGridUrl", "?location=nas&loose=1")), { root: "nas", folder: "", loose: true }, "a location's loose files");
  assert.deepEqual(plain(call("parseGridUrl", "?folder=//a//b/")), { root: "", folder: "", loose: false }, "a folder means nothing without its location");
  assert.equal(call("parseGridUrl", ""), null);
  assert.equal(call("parseGridUrl", "?q=x"), null);
});

test("URL: written back readably, and read back to the same state", () => {
  const u = call("gridUrlFor", { root: "nas", folder: "STLFlix/Dragons", loose: false });
  assert.equal(u, "/library?location=nas&folder=STLFlix/Dragons");
  assert.equal(call("gridUrlFor", { root: "", folder: "", loose: false }), "/library");
  assert.equal(call("gridUrlFor", { root: "nas", folder: "", loose: true }), "/library?location=nas&loose=1");
  assert.deepEqual(plain(call("parseGridUrl", u.slice(u.indexOf("?")))), { root: "nas", folder: "STLFlix/Dragons", loose: false });
  assert.equal(call("gridUrlFor", { root: "nas", folder: "Fun & 50%/x", loose: false }), "/library?location=nas&folder=Fun+%26+50%25/x", "special characters stay encoded");
});

test("a stale folder (deleted, renamed, an old link) falls back to its nearest parent; a gone location to the top", () => {
  const n = sel => plain(call("nearestFolder", TREE, sel));
  assert.deepEqual(n({ root: "nas", folder: "STLFlix/Dragons", loose: false }), { root: "nas", folder: "STLFlix/Dragons", loose: false }, "still there: kept");
  assert.deepEqual(n({ root: "nas", folder: "STLFlix/Gone/Deeper", loose: false }), { root: "nas", folder: "STLFlix", loose: false });
  assert.deepEqual(n({ root: "nas", folder: "Nope", loose: false }), { root: "nas", folder: "", loose: false });
  assert.deepEqual(n({ root: "old", folder: "x", loose: false }), { root: "", folder: "", loose: false });
  assert.deepEqual(n({ root: "nas", folder: "", loose: true }), { root: "nas", folder: "", loose: true });
  assert.deepEqual(plain(call("nearestFolder", { roots: [{ ...TREE.roots[0], loose: null }] }, { root: "nas", folder: "", loose: true })), { root: "nas", folder: "", loose: false }, "no loose files any more");
  assert.deepEqual(plain(call("nearestFolder", null, { root: "nas", folder: "X", loose: false })), { root: "nas", folder: "X", loose: false }, "no tree yet: nothing to check against");
});

test("filter parameters: Include subfolders on and off, Loose files, and nothing for All locations", () => {
  assert.deepEqual(plain(call("folderParams", { root: "nas", folder: "STLFlix", loose: false }, true)), { folder: "STLFlix", subfolders: null });
  assert.deepEqual(plain(call("folderParams", { root: "nas", folder: "STLFlix", loose: false }, false)), { folder: "STLFlix", subfolders: "0" });
  assert.deepEqual(plain(call("folderParams", { root: "nas", folder: "", loose: true }, true)), { loose: "1" });
  assert.deepEqual(plain(call("folderParams", { root: "", folder: "", loose: false }, false)), {});
});

test("the Location dropdown and the tree are one choice", () => {
  // Choosing in the tree (or a folder fallback) sets the dropdown to the selection's location ...
  const sel = extractFn("selectFolder");
  assert.match(sel, /L\.sel=sel; L\.filters\.location=sel\.root;/);
  assert.match(sel, /syncLocationSelect\(\);/);
  assert.match(extractFn("loadTree"), /L\.sel=next; L\.filters\.location=next\.root; syncLocationSelect\(\);/);
  // ... "Any location" ("") is "All locations" (root ""), and the models ask for exactly the selection's location.
  const sync = extractFn("syncLocationSelect");
  const opts = [{ value: "" }, { value: "nas" }, { value: "gcode" }];
  const el = { value: "", options: opts };
  vm.runInContext(sync, Object.assign(ctx, { $: () => el, L: { sel: { root: "nas" } } }));
  call("syncLocationSelect"); assert.equal(el.value, "nas");
  ctx.L.sel.root = ""; call("syncLocationSelect"); assert.equal(el.value, "", "All locations in the tree is Any location");
  assert.match(src, /const gridQS=extra=>filterQS\(\{ \.\.\.L\.filters, location:L\.sel\.root \}/);
  // ... choosing in the dropdown selects that location's top in the tree.
  assert.match(src, /\$\("libLocation"\)\.addEventListener\("change",\(\)=>\{ selectFolder\(\{ root:\$\("libLocation"\)\.value, folder:"", loose:false \}\); \}\);/);
  // The tree always lists every location, whatever is selected.
  assert.match(extractFn("loadTree"), /filterQS\(\{ \.\.\.L\.filters, location:"" \}\)/);
});

test("the card's folder line: one path, or '2 folders' with every path in the title; none without a folder", () => {
  assert.match(call("folderLineHtml", { path: "STLFlix/Dragons" }), /class="lib-card-folder" title="STLFlix\/Dragons">.*>STLFlix\/Dragons<\/span>/);
  assert.match(call("folderLineHtml", { paths: ["KKReation", "STLFlix/Animals"] }), /title="KKReation\nSTLFlix\/Animals">.*>library\.n_folders#2</s);
  assert.equal(call("folderLineHtml", null), "");
});

test("a card without printer chips has no empty chip row: the folder line follows the detail line", () => {
  assert.match(src, /\$\{m\.families\.length\?`<span class="lib-fams">\$\{familyChips\(m\.families,2\)\}<\/span>`:""\}\$\{folderLineHtml\(m\.folder\)\}/);
});

test("'Scanned … ago', and a failed scan's reason in plain words", () => {
  const now = 10_000_000;
  assert.equal(call("scannedText", null, now), "library.scanned_never");
  assert.equal(call("scannedText", now - 20_000, now), "library.scanned_just_now");
  assert.equal(call("scannedText", now - 12 * 60_000, now), "library.scanned_min(n=12)");
  assert.equal(call("scannedText", now - 3 * 3600_000, now), "library.scanned_hours(n=3)");
  assert.equal(call("scanErrorText", "U1 Files", "folder not found"), "library.scan_failed(name=U1 Files,reason=library.scan_err_not_found)");
  assert.equal(call("scanErrorText", "U1 Files", "not readable (EACCES)"), "library.scan_failed(name=U1 Files,reason=library.scan_err_not_readable)");
  assert.equal(call("scanErrorText", "U1 Files", "not reachable"), "library.scan_failed(name=U1 Files,reason=library.scan_err_unreachable)");
});

test("a failed folder load keeps the last good tree; only this page's rescan polls, and it keeps folder, filters and scroll", () => {
  const load = extractFn("loadTree");
  assert.match(load, /catch\{ return; \}   \/\/ the last good tree stays/);
  assert.match(load, /const next=nearestFolder\(tree, L\.sel\);/);
  const fin = extractFn("finishRescan");
  assert.match(fin, /const pageEl=\$\("libraryPage"\), top=pageEl\?pageEl\.scrollTop:0;/);
  assert.match(fin, /await Promise\.all\(\[loadTree\(\), loadModels\(true,\{ tree:false \}\)\]\);/);
  assert.match(extractFn("pollRescan"), /if\(roots\.some\(busy\)\) return pollRescan\(failed\);/);
});
