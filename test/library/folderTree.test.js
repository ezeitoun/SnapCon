// test/library/folderTree.test.js — the Library page's Folders panel and the
// folder filter (libraryView.folderTree / listModels with a folder): the tree
// from the flat list of file paths, its counts under the active filters, the
// "Loose files" row, the folder line on cards, and that folders come from
// present files only. On an index written directly, grouped by the real
// grouping (as libraryView.test.js does).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLibraryStore } = require("../../library/LibraryStore");
const grouping = require("../../library/grouping");
const V = require("../../library/libraryView");

const quiet = { log() {}, warn() {}, error() {} };
function setup(t, roots = [["nas", "U1 Files"]]) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-ftree-"));
  const store = createLibraryStore({ baseDir: base, log: quiet }).open();
  t.after(() => store.close());
  for (const [id, name] of roots) {
    store.roots.insert({ id, name, path: path.join(base, id), grouping: "files", enabled: true, scan_every_min: 30, created_at: 1 });
    store.db.prepare("INSERT INTO scan_runs (root_id, started_at, finished_at, outcome) VALUES (?, 1, 2, 'ok')").run(id);
  }
  let n = 0;
  return { db: store.db, group: () => grouping.run(store.db, { now: 1000, uuid: () => "00000000-0000-0000-0000-" + String(++n).padStart(12, "0") }) };
}
// One file; `key` shared by two files makes them one Model (same content).
function file(db, { root = "nas", rel, key, state = "present", objects }) {
  const name = rel.split("/").pop();
  key = key || "q:" + root + rel;
  const id = Number(db.prepare(`INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, content_key, state, first_seen, last_seen)
    VALUES (?, ?, ?, 'gcode', 'sliced', 100, 1, ?, ?, ?, 1, 1)`).run(root, rel, name, key, key, state).lastInsertRowid);
  for (const o of objects || [name.replace(/\.gcode$/, "")]) db.prepare("INSERT INTO file_objects (file_id, name_norm, raw_name, origin) VALUES (?, ?, ?, 'exclude_object')").run(id, o.toLowerCase() + id, o + id);
  return id;
}
// The designer layout of the brief.
function designer(db) {
  file(db, { rel: "Cinderwin 3D/Bat.gcode" });
  file(db, { rel: "Cinderwin 3D/Owl.gcode" });
  file(db, { rel: "KKReation/Fox.gcode" });
  file(db, { rel: "stlflix/Dragons/Wyvern.gcode" });
  file(db, { rel: "stlflix/Dragons/Drake.gcode" });
  file(db, { rel: "stlflix/Animals/Cat.gcode" });
  file(db, { rel: "Benchy.gcode" });
  // One Model whose files sit in two folders (the same content twice).
  file(db, { rel: "KKReation/Split part.gcode", key: "q:split" });
  file(db, { rel: "stlflix/Animals/Split part.gcode", key: "q:split" });
}
const names = nodes => nodes.map(n => n.name);
const find = (nodes, p) => { let level = nodes, n; for (const part of p.split("/")) { n = level.find(c => c.name === part); level = n.children; } return n; };
const gridNames = (db, opts) => V.listModels(db, { root: "nas", limit: 120, ...opts }).models.map(m => m.name).sort();

test("tree: nesting, counts of everything below, case-insensitive name order, and the Loose files row", t => {
  const { db, group } = setup(t);
  designer(db); group();
  const r = V.folderTree(db, { root: "nas" }).roots[0];
  assert.equal(r.name, "U1 Files");
  assert.equal(r.count, 8, "the location's row counts what its grid shows");
  assert.deepEqual(names(r.children), ["Cinderwin 3D", "KKReation", "stlflix"], "sorted ignoring case");
  assert.deepEqual(names(find(r.children, "stlflix").children), ["Animals", "Dragons"]);
  assert.equal(find(r.children, "Cinderwin 3D").count, 2);
  assert.equal(find(r.children, "KKReation").count, 2, "Fox and the split Model");
  assert.equal(find(r.children, "stlflix").count, 4, "Wyvern, Drake, Cat and the split Model: everything below, each Model once");
  assert.equal(find(r.children, "stlflix/Animals").count, 2);
  assert.deepEqual(r.loose, { count: 1, total: 1 }, "Benchy sits directly in the location");
});

test("tree: an empty location, and one with no subfolders (no Loose files row: there is nothing to tell apart)", t => {
  const { db, group } = setup(t, [["nas", "U1 Files"], ["flat", "Flat"]]);
  file(db, { root: "flat", rel: "A.gcode" }); file(db, { root: "flat", rel: "B.gcode" });
  group();
  const tree = V.folderTree(db, {});
  const nas = tree.roots.find(r => r.id === "nas"), flat = tree.roots.find(r => r.id === "flat");
  assert.deepEqual({ ...nas, children: nas.children.length }, { id: "nas", name: "U1 Files", count: 0, total: 0, children: 0, loose: null });
  assert.equal(flat.children.length, 0);
  assert.equal(flat.loose, null);
  assert.equal(flat.count, 2);
  assert.equal(tree.count, 2, "All locations counts every Model once");
});

test("folder filter: with subfolders everything below, without only the folder's own files; Loose files is the top's own", t => {
  const { db, group } = setup(t);
  designer(db); group();
  assert.equal(V.listModels(db, { root: "nas", folder: "stlflix" }).total, 4);
  assert.equal(V.listModels(db, { root: "nas", folder: "stlflix", subfolders: false }).total, 0, "stlflix itself holds no file");
  assert.equal(V.listModels(db, { root: "nas", folder: "stlflix/Dragons", subfolders: false }).total, 2);
  assert.equal(V.listModels(db, { root: "nas", folder: "", subfolders: false }).total, 1, "the top folder without subfolders: Benchy");
  assert.equal(V.listModels(db, { root: "nas", loose: true }).total, 1);
  assert.equal(V.listModels(db, { root: "nas", folder: "" }).total, 8, "the top with subfolders: today's flat view");
  assert.equal(V.listModels(db, { root: "nas", folder: "/stlflix//Dragons/" }).total, 2, "slashes are tidied");
  assert.equal(V.listModels(db, { root: "nas", folder: "stl" }).total, 0, "a prefix of a name is not its folder");
});

test("folder names that differ only in case, or hold % and _, are matched exactly", t => {
  const { db, group } = setup(t);
  file(db, { rel: "STL/A.gcode" }); file(db, { rel: "stl/B.gcode" });
  file(db, { rel: "100%_done/C.gcode" }); file(db, { rel: "100X_done/D.gcode" });
  group();
  assert.equal(V.listModels(db, { root: "nas", folder: "STL" }).total, 1);
  assert.equal(V.listModels(db, { root: "nas", folder: "stl" }).total, 1);
  assert.equal(V.listModels(db, { root: "nas", folder: "100%_done" }).total, 1);
});

test("counts follow the active filters; a folder they empty stays listed with count 0", t => {
  const { db, group } = setup(t);
  designer(db); group();
  const r = V.folderTree(db, { root: "nas", q: "wyvern" }).roots[0];
  assert.equal(r.count, 1);
  assert.equal(find(r.children, "stlflix").count, 1);
  assert.equal(find(r.children, "stlflix/Dragons").count, 1);
  const cin = find(r.children, "Cinderwin 3D");
  assert.equal(cin.count, 0);
  assert.equal(cin.total, 2, "still listed, with what it holds unfiltered (dimmed on the page)");
  assert.equal(r.loose.count, 0);
});

test("the card's folder line: the subfolder below the selected folder; '2 folders' when split; none when a file is directly in it", t => {
  const { db, group } = setup(t);
  designer(db); group();
  const at = (folder, opts = {}) => Object.fromEntries(V.listModels(db, { root: "nas", folder, limit: 120, ...opts }).models.map(m => [m.name, m.folder]));
  const top = at("");
  assert.deepEqual(top["Wyvern"], { path: "stlflix/Dragons" });
  assert.deepEqual(top["Benchy"], null, "directly in the selected folder");
  assert.deepEqual(top["Split part"], { paths: ["KKReation", "stlflix/Animals"] });
  const s = at("stlflix");
  assert.deepEqual(s["Cat"], { path: "Animals" });
  assert.deepEqual(s["Split part"], { path: "Animals" }, "only its files below the selected folder count");
  assert.equal(at("stlflix/Dragons", { subfolders: false })["Wyvern"], undefined, "no line without subfolders");
  assert.equal(V.listModels(db, { root: "nas" }).models[0].folder, undefined, "no folder selected, no line");
});

test("folders come from present files: a deleted folder leaves the tree and the filter, while its Models stay in the location's grid", t => {
  const { db, group } = setup(t);
  designer(db);
  file(db, { rel: "Gone/Old.gcode", state: "missing" });
  group();
  const r = V.folderTree(db, { root: "nas" }).roots[0];
  assert.ok(!names(r.children).includes("Gone"));
  assert.equal(V.listModels(db, { root: "nas", folder: "Gone" }).total, 0);
  assert.ok(gridNames(db, {}).includes("Old"), "the whole location still lists it (missing), as before folders");
});

// ---- "Needs attention first" (the Sort option that replaced the checkbox) ----

test("sort 'Needs attention first': Models that need attention by name, then the rest by name; paging keeps that order", t => {
  const { db, group } = setup(t);
  for (const n of ["Alpha", "bravo", "Charlie", "delta", "Echo", "foxtrot", "Golf"]) file(db, { rel: n + ".gcode" });
  group();
  const uuid = name => db.prepare("SELECT uuid FROM models WHERE name = ?").get(name).uuid;
  const raise = (name, kind) => db.prepare("INSERT INTO review_items (kind, subject_key, model_uuid, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").run(kind, kind + ":" + name, uuid(name));
  raise("Golf", "missing_file");          // action
  raise("Charlie", "unknown_printer");    // review
  raise("bravo", "folder_disagrees");     // information only: not "needs attention"
  const all = [];
  let cursor = null;
  do { const r = V.listModels(db, { root: "nas", sort: "attention", limit: 2, cursor }); all.push(...r.models.map(m => m.name)); cursor = r.next; } while (cursor);
  assert.deepEqual(all, ["Charlie", "Golf", "Alpha", "bravo", "delta", "Echo", "foxtrot"]);
  assert.deepEqual(V.listModels(db, { root: "nas", sort: "attention", q: "golf" }).models.map(m => m.name), ["Golf"], "with other filters too");
  assert.deepEqual(V.listModels(db, { root: "nas", attention: true }).models.map(m => m.name).sort(), ["Charlie", "Golf"], "the server's attention filter is unchanged");
});
