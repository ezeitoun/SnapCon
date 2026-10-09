// test/library/libraryView.test.js — what the Library UI reads (M5, §13.2):
// keyset paging, search, filters and facets, offline versus missing,
// the cover order (§10), and how strongly each Review Item asks for
// attention. On an index written directly, grouped by the real grouping.
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-view-"));
  const store = createLibraryStore({ baseDir: base, log: quiet }).open();
  t.after(() => store.close());
  for (const id of ["gcode", "nas"]) store.roots.insert({ id, name: id === "gcode" ? "G-code folder" : "NAS models", path: base, grouping: "files", enabled: true, scan_every_min: 30, created_at: 1 });
  const db = store.db;
  for (const id of ["gcode", "nas"]) db.prepare("INSERT INTO scan_runs (root_id, started_at, finished_at, outcome) VALUES (?, 1, 2, 'ok')").run(id);
  let n = 0;
  return { db, group: () => grouping.run(db, { now: 1000, uuid: () => "00000000-0000-0000-0000-" + String(++n).padStart(12, "0") }) };
}
let fid = 0;
function file(db, { root = "gcode", rel, role = "sliced", objects = [], family, filaments, thumb, thumbW = 300, state = "present", project }) {
  const name = rel.split("/").pop();
  const key = "q:" + root + rel;
  const id = Number(db.prepare(`INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, content_key, state, thumb_key, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, 100, 1, ?, ?, ?, ?, 1, 1)`).run(root, rel, name, name.split(".").pop(), role, key, key, state, thumb || null).lastInsertRowid);
  if (thumb) db.prepare("INSERT OR IGNORE INTO thumbs (key, source, mime, bytes, w, h, created_at, last_used_at) VALUES (?, 'embedded', 'image/png', 1000, ?, ?, 1, 1)").run(thumb, thumbW, thumbW);
  for (const o of objects) db.prepare("INSERT INTO file_objects (file_id, name_norm, raw_name, origin) VALUES (?, ?, ?, 'exclude_object')").run(id, o.toLowerCase(), o);
  if (family !== undefined) db.prepare("INSERT INTO variants (file_id, plate_no, printer_family, filaments_json, est_seconds) VALUES (?, NULL, ?, ?, 3600)").run(id, family, JSON.stringify(filaments || [{ type: "PLA", hex: "#ff0000", g: 10 }]));
  if (project) {
    const pid = Number(db.prepare("INSERT INTO projects (file_id, flavour, title, printer_model) VALUES (?, 'snapmaker_orca', ?, ?)").run(id, project.title || null, project.printerModel || null).lastInsertRowid);
    for (const pl of project.plates || []) db.prepare("INSERT INTO plates (project_id, plate_no, name, sliced, thumb_key) VALUES (?, ?, ?, 0, ?)").run(pid, pl.no, pl.name || null, pl.thumb || null);
    for (const pl of project.plates || []) if (pl.thumb) db.prepare("INSERT OR IGNORE INTO thumbs (key, source, mime, bytes, w, h, created_at, last_used_at) VALUES (?, 'embedded', 'image/png', 1000, 200, 200, 1, 1)").run(pl.thumb);
  }
  return { id, key, rel };
}
const modelUuid = (db, rel) => db.prepare("SELECT m.uuid FROM files f JOIN models m ON m.id = f.model_id WHERE f.rel_path = ?").get(rel).uuid;

test("the grid pages by keyset over every visible Model exactly once, in name order, and counts them", t => {
  const { db, group } = setup(t);
  for (let i = 0; i < 25; i++) file(db, { rel: `Model ${String(i).padStart(2, "0")} x.gcode`, family: "snapmaker-u1", objects: ["obj" + i] });
  group();
  const seen = [];
  let cursor = null, pages = 0;
  do {
    const r = V.listModels(db, { limit: 7, cursor });
    assert.equal(r.total, 25);
    seen.push(...r.models.map(m => m.name));
    cursor = r.next; pages++;
  } while (cursor && pages < 10);
  assert.equal(pages, 4);
  assert.equal(new Set(seen).size, 25, "no Model twice, none skipped");
  assert.deepEqual(seen, [...seen].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  assert.equal(V.listModels(db, { cursor: "not-a-cursor" }).models.length, 25, "a bad cursor starts from the top");
});

test("search finds Models by prefix across names, file names and object names, and never passes FTS syntax through", t => {
  const { db, group } = setup(t);
  file(db, { rel: "Flexi Factory Skeleton T-Rex.gcode", family: "snapmaker-u1", objects: ["T-Rex Body_Curved.stl"] });
  file(db, { rel: "Crystal Dragon.gcode", family: "snapmaker-u1", objects: ["Wing Left.stl"] });
  group();
  assert.deepEqual(V.listModels(db, { q: "skel rex" }).models.map(m => m.name), ["Flexi Factory Skeleton T-Rex"]);
  assert.deepEqual(V.listModels(db, { q: "wing" }).models.map(m => m.name), ["Crystal Dragon"], "an object name inside the file");
  for (const q of ['"', "NEAR(a b)", "a OR", "*", "-x", "col:val", "((("]) assert.doesNotThrow(() => V.listModels(db, { q }), q);
  assert.equal(V.listModels(db, { q: "zzz" }).total, 0);
});

test("filters: printer family, location, type and material, with facet counts", t => {
  const { db, group } = setup(t);
  file(db, { rel: "Beardie.gcode", family: "flashforge-ad5x", objects: ["Beardie.stl"], filaments: [{ type: "PETG", hex: "#00ff00" }] });
  file(db, { root: "nas", rel: "Gecko.gcode", family: "snapmaker-u1", objects: ["Gecko.stl"] });
  file(db, { root: "nas", rel: "Santa.3mf", role: "project", project: { title: "Santa", printerModel: "Snapmaker U1", plates: [{ no: 1 }, { no: 2 }] } });
  group();
  const names = r => r.models.map(m => m.name).sort();
  assert.deepEqual(names(V.listModels(db, { family: "flashforge-ad5x" })), ["Beardie"]);
  assert.deepEqual(names(V.listModels(db, { root: "nas" })), ["Gecko", "Santa"]);
  assert.deepEqual(names(V.listModels(db, { type: "3mf" })), ["Santa"]);
  assert.deepEqual(names(V.listModels(db, { material: "petg" })), ["Beardie"]);
  const f = V.facets(db);
  assert.equal(f.total, 3);
  assert.deepEqual(f.families.map(x => [x.key, x.count]).sort(), [["flashforge-ad5x", 1], ["snapmaker-u1", 1]]);
  assert.deepEqual(f.materials.map(x => [x.key, x.count]), [["PETG", 1], ["PLA", 1]]);
  assert.deepEqual(f.types.map(x => [x.key, x.count]), [["gcode", 2], ["3mf", 1]]);
  const santa = V.modelDetail(db, modelUuid(db, "Santa.3mf"));
  assert.equal(santa.projects[0].plates.length, 2);
  assert.equal(santa.projects[0].setUpFor.family, "snapmaker-u1", "an unsliced project says what it is set up for");
  assert.equal(santa.printables.length, 0);
});

test("a file in an offline location is offline — never missing — and cannot be sent; a missing one says so", t => {
  const { db, group } = setup(t);
  file(db, { root: "nas", rel: "Gecko.gcode", family: "snapmaker-u1", objects: ["Gecko.stl"] });
  file(db, { rel: "Owl.gcode", family: "snapmaker-u1", objects: ["Owl.stl"], state: "missing" });
  file(db, { rel: "Frog.gcode", family: "snapmaker-u1", objects: ["Frog.stl"] });
  group();
  db.prepare("UPDATE roots SET status = 'offline' WHERE id = 'nas'").run();
  const card = name => V.listModels(db, { q: name }).models[0];
  assert.equal(card("gecko").offline, "all", "the Model stays in the Library");
  assert.equal(card("gecko").missing, 0);
  const g = V.modelDetail(db, modelUuid(db, "Gecko.gcode")).printables[0];
  assert.equal(g.file.availability, "offline");
  assert.deepEqual(g.send, { ok: false, reason: "offline" }, "M7: an unreachable location can't print, and says why");
  const o = V.modelDetail(db, modelUuid(db, "Owl.gcode")).printables[0];
  assert.equal(o.file.availability, "missing");
  assert.deepEqual(o.send, { ok: false, reason: "missing" });
  assert.deepEqual(V.modelDetail(db, modelUuid(db, "Frog.gcode")).printables[0].send, { ok: true, root: "gcode", path: "Frog.gcode", queue: true });
  // M7 (§12): any location that answers can print, through the same dialogs.
  db.prepare("UPDATE roots SET status = 'ok' WHERE id = 'nas'").run();
  assert.deepEqual(V.modelDetail(db, modelUuid(db, "Gecko.gcode")).printables[0].send, { ok: true, root: "nas", path: "Gecko.gcode", queue: true });
});

test("cover order: the owner's choice, then a Model image, then a plate picture, then the largest G-code thumbnail", t => {
  const { db, group } = setup(t);
  const a = file(db, { rel: "Dragon.gcode", family: "snapmaker-u1", objects: ["Dragon.stl"], thumb: "small", thumbW: 48 });
  file(db, { rel: "2x Dragon.gcode", family: "snapmaker-u1", objects: ["Dragon.stl"], thumb: "big", thumbW: 300 });
  group();
  const cover = () => V.listModels(db, { q: "dragon" }).models[0].cover;
  assert.deepEqual(cover(), { thumb: "big", source: "gcode" }, "the largest G-code thumbnail");
  const proj = file(db, { rel: "Dragon.3mf", role: "project", project: { title: "Dragon", plates: [{ no: 1, thumb: "plate1" }] } });
  const m = db.prepare("SELECT model_id FROM files WHERE id = ?").get(a.id).model_id;
  db.prepare("UPDATE files SET model_id = ? WHERE id = ?").run(m, proj.id);
  assert.deepEqual(cover(), { thumb: "plate1", source: "plate" });
  db.prepare("INSERT INTO files (root_id, rel_path, entry_path, container_id, name, ext, role, size, mtime_ms, quick_fp, content_key, thumb_key, model_id, first_seen, last_seen) VALUES ('gcode', 'Dragon.3mf', 'Auxiliaries/Model Pictures/1.png', ?, '1.png', 'png', 'image', 5, 1, 'e', 'q:e', 'pic', ?, 1, 1)").run(proj.id, m);
  db.prepare("INSERT INTO thumbs (key, source, mime, bytes, w, h, created_at, last_used_at) VALUES ('pic', 'embedded', 'image/png', 5000, 640, 480, 1, 1)").run();
  assert.deepEqual(cover(), { thumb: "pic", source: "image" });
  db.prepare("UPDATE models SET cover_source = 'user', cover_content_key = ? WHERE id = ?").run(a.key, m);
  assert.deepEqual(cover(), { thumb: "small", source: "chosen" });
});

test("attention levels: a broken Decision needs you, an uncertainty is worth a look, a folder disagreement or a generic name is information", () => {
  assert.equal(V.levelOf({ kind: "decision_unmatched", subject_key: "decision:1" }), "action");
  assert.equal(V.levelOf({ kind: "file_changed", subject_key: "changed:1" }), "action");
  assert.equal(V.levelOf({ kind: "suggested_match", subject_key: "x" }), "review");
  assert.equal(V.levelOf({ kind: "ambiguous_grouping", subject_key: "ambiguous:file:q:1" }), "review");
  assert.equal(V.levelOf({ kind: "ambiguous_grouping", subject_key: "ambiguous:generic:assembly" }), "info");
  assert.equal(V.levelOf({ kind: "folder_disagrees", subject_key: "folder:x" }), "info");
  assert.equal(V.levelOf({ kind: "possible_duplicate", subject_key: "duplicate:x" }), "info");
  assert.equal(V.levelOf({ kind: "empty_model", subject_key: "empty:x" }), "info");
});

test("Needs attention links each item to the Models it is about; the grid's filter counts only what asks for a look", t => {
  const { db, group } = setup(t);
  file(db, { rel: "Kraken.gcode", family: "snapmaker-u1", objects: ["Kraken.stl"] });
  file(db, { rel: "Kraken.3mf", role: "project", project: { title: null } });
  file(db, { rel: "Owl.3mf", role: "project", objects: ["Assembly"] });
  file(db, { rel: "Rocket.3mf", role: "project", objects: ["Assembly"] });
  group();
  const a = V.attentionList(db);
  const sugg = a.items.find(i => i.kind === "suggested_match");
  assert.equal(sugg.level, "review");
  assert.deepEqual(sugg.models.map(m => m.name).sort(), ["Kraken", "Kraken"]);
  assert.deepEqual(V.listModels(db, { attention: true }).models.map(m => m.name).sort(), ["Kraken", "Kraken"], "information alone does not flag a Model");
});

test("search finds camel-case and punctuated names however they are typed (search forms; names unchanged)", t => {
  const { db, group } = setup(t);
  file(db, { rel: "TinyTREX.gcode", family: "snapmaker-u1", objects: ["a.stl"] });
  file(db, { rel: "Skeleton T-Rex.gcode", family: "snapmaker-u1", objects: ["b.stl"] });
  file(db, { rel: "Big T Rex.gcode", family: "snapmaker-u1", objects: ["c.stl"] });
  file(db, { rel: "Rex the dog.gcode", family: "snapmaker-u1", objects: ["d.stl"] });
  group();
  const names = q => V.listModels(db, { q }).models.map(c => c.name).sort();
  for (const q of ["trex", "t rex", "t-rex", "T-REX"]) assert.deepEqual(names(q), ["Big T Rex", "Skeleton T-Rex", "TinyTREX"], q);
  assert.deepEqual(names("rex"), ["Big T Rex", "Rex the dog", "Skeleton T-Rex"]);
});
