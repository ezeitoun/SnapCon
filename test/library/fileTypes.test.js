// test/library/fileTypes.test.js — the Library's file types, as the card
// tags and the Type filter show them (libraryView.fileTypeOf, the cards'
// `types`, TYPES): G-code; a 3MF with sliced plates (role "sliced", set from
// its content by the scan); a 3MF that needs slicing; a source model, shown
// by its own extension. Archives are never part of a Model (TODO §26).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLibraryStore } = require("../../library/LibraryStore");
const grouping = require("../../library/grouping");
const V = require("../../library/libraryView");

const quiet = { log() {}, warn() {}, error() {} };
function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-ftype-"));
  const store = createLibraryStore({ baseDir: base, log: quiet }).open();
  t.after(() => store.close());
  store.roots.insert({ id: "nas", name: "U1 Files", path: base, grouping: "files", enabled: true, scan_every_min: 30, created_at: 1 });
  store.db.prepare("INSERT INTO scan_runs (root_id, started_at, finished_at, outcome) VALUES ('nas', 1, 2, 'ok')").run();
  let n = 0;
  return { db: store.db, group: () => grouping.run(store.db, { now: 1000, uuid: () => "00000000-0000-0000-0000-" + String(++n).padStart(12, "0") }) };
}
// `key` shared by two files makes them one Model.
function file(db, { rel, role, size = 100, key }) {
  const name = rel.split("/").pop(), ext = name.split(".").pop();
  key = key || "q:" + rel;
  const id = Number(db.prepare(`INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, content_key, state, hidden, first_seen, last_seen)
    VALUES ('nas', ?, ?, ?, ?, ?, 1, ?, ?, 'present', 0, 1, 1)`).run(rel, name, ext, role, size, key + rel, key).lastInsertRowid);
  db.prepare("INSERT INTO file_objects (file_id, name_norm, raw_name, origin) VALUES (?, ?, ?, 'exclude_object')").run(id, "obj" + id, "obj" + id);
  return id;
}
const byName = (db, opts) => Object.fromEntries(V.listModels(db, { limit: 120, ...opts }).models.map(m => [m.name, m]));

test("fileTypeOf: gcode, sliced 3MF, 3MF needing slicing, source; zip and anything else have none", () => {
  assert.equal(V.fileTypeOf("gcode", "sliced"), "gcode");
  for (const e of ["gco", "g", "gx", "bgcode", "GCODE"]) assert.equal(V.fileTypeOf(e, "sliced"), "gcode", e);
  assert.equal(V.fileTypeOf("3mf", "sliced"), "3mf_sliced", "a 3MF with a plate's G-code inside (also a .gcode.3mf)");
  assert.equal(V.fileTypeOf("3mf", "project"), "3mf");
  assert.equal(V.fileTypeOf("stl", "source"), "source");
  assert.equal(V.fileTypeOf("step", "source"), "source");
  assert.equal(V.fileTypeOf("zip", "archive"), null);
  assert.equal(V.fileTypeOf("png", "image"), null);
  assert.equal(V.fileTypeOf("xyz", "other"), null);
  assert.equal(V.fileTypeOf("", null), null);
});

test("card tags: one per type, in the order gcode, 3mf · sliced, 3mf, source; the source tag is its file's extension", t => {
  const { db, group } = setup(t);
  file(db, { rel: "Owl.gcode", role: "sliced" });
  file(db, { rel: "Crab/Crab.gcode", role: "sliced", key: "k:crab" });
  file(db, { rel: "Crab/Crab.3mf", role: "sliced", key: "k:crab" });
  file(db, { rel: "Crab/Crab plate.3mf", role: "project", key: "k:crab" });
  file(db, { rel: "Crab/Crab.stl", role: "source", key: "k:crab", size: 900 });
  file(db, { rel: "Crab/Crab small.step", role: "source", key: "k:crab", size: 50 });
  file(db, { rel: "Crab/Crab.zip", role: "archive", key: "k:crab" });
  file(db, { rel: "Rex.step", role: "source" });
  file(db, { rel: "Hidden.gcode", role: "sliced", key: "k:hid" });
  const hid = file(db, { rel: "Hidden.3mf", role: "project", key: "k:hid" });
  group();
  // Hidden is a cache of the person's Decisions, rebuilt by grouping: set after it.
  db.prepare("UPDATE files SET hidden = 1 WHERE id = ?").run(hid);
  const m = byName(db, {});
  assert.deepEqual(m["Owl"].types, [{ type: "gcode", ext: "gcode" }]);
  assert.deepEqual(m["Crab"].types.map(x => x.type), ["gcode", "3mf_sliced", "3mf", "source"]);
  assert.equal(m["Crab"].types[3].ext, "stl", "the largest source file's extension");
  assert.deepEqual(m["Rex"].types, [{ type: "source", ext: "step" }]);
  assert.deepEqual(m["Hidden"].types.map(x => x.type), ["gcode"], "a hidden file has no tag");
});

test("Type filter: G-code, 3MF sliced, 3MF and Source model, with facet counts only for types that exist", t => {
  const { db, group } = setup(t);
  file(db, { rel: "Owl.gcode", role: "sliced" });
  file(db, { rel: "Crab.3mf", role: "sliced" });
  file(db, { rel: "Santa.3mf", role: "project" });
  file(db, { rel: "Rex.stl", role: "source" });
  file(db, { rel: "Pack.zip", role: "archive" });
  group();
  const names = type => V.listModels(db, { type }).models.map(m => m.name);
  assert.deepEqual(names("gcode"), ["Owl"]);
  assert.deepEqual(names("3mf_sliced"), ["Crab"]);
  assert.deepEqual(names("3mf"), ["Santa"]);
  assert.deepEqual(names("source"), ["Rex"]);
  assert.equal(V.listModels(db, { type: "printable" }).total, 4, "an old option is ignored, not an error");
  assert.deepEqual(V.facets(db).types.map(x => [x.key, x.count]), [["gcode", 1], ["3mf_sliced", 1], ["3mf", 1], ["source", 1]]);
});
