// test/library/store.test.js — the Library database: first run, rebuild,
// corruption, versioning, migration and backups (docs/library-design.md §4.6,
// §14, and CLAUDE.md §7: never silently destroy recoverable data).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createLibraryStore, runBackup, listBackups, backupDue } = require("../../library/LibraryStore");
const schema = require("../../library/schema");

const quiet = { log() {}, warn() {}, error() {} };
const tmpBase = () => fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-lib-"));
const open = (baseDir, extra = {}) => createLibraryStore({ baseDir, log: quiet, ...extra }).open();
// The schema as it was at version 1 (before the identity cache), for upgrade tests.
const V1 = { ...schema, SCHEMA_VERSION: 1, IDENTITY_SQL: "" };
let clock = Date.parse("2026-10-01T03:00:00Z");
const tick = () => (clock += 1000);

// One row in every authored table, and derived rows that point at them.
function seed(db) {
  const now = Date.now();
  db.exec(`
    INSERT INTO roots (id, name, path, created_at, status) VALUES ('nas', 'NAS', '/models', ${now}, 'ok');
    INSERT INTO models (uuid, origin, name, created_at, updated_at) VALUES ('m-1', 'auto', 'Beardie', ${now}, ${now});
    INSERT INTO model_anchors (model_id, content_key, last_seen) VALUES (1, 'q:abc', ${now});
    INSERT INTO decisions (subject_type, subject_key, relation, object_type, object_key, created_at) VALUES ('file', 'q:abc', 'member_of', 'model', 'm-1', ${now});
    INSERT INTO prints (content_key, printer_id, remote_name, source, link_method, link_confidence) VALUES ('q:abc', 'p1', 'b.gcode', 'library', 'snapcon_variant', 'exact');
    INSERT INTO review_items (kind, subject_key, created_at, updated_at, print_id) VALUES ('suggested_match', 'rk', ${now}, ${now}, 1);
    INSERT INTO tags (name) VALUES ('lizard');
    INSERT INTO model_tags (model_id, tag_id) VALUES (1, 1);
    INSERT INTO collections (uuid, name) VALUES ('c-1', 'Best sellers');
    INSERT INTO collection_models (collection_id, model_id) VALUES (1, 1);
    INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, content_key, first_seen, last_seen, model_id, model_decision_id)
      VALUES ('nas', 'a.gcode', 'a.gcode', 'gcode', 'sliced', 1, 1, 'abc', 'q:abc', 1, 1, 1, 1);
    INSERT INTO files (root_id, rel_path, entry_path, container_id, name, ext, role, size, mtime_ms, quick_fp, content_key, first_seen, last_seen)
      VALUES ('nas', 'p.3mf', 'Auxiliaries/1.webp', 1, '1.webp', 'webp', 'image', 1, 1, 'def', 'q:def', 1, 1);
    INSERT INTO variants (file_id, printer_family) VALUES (1, 'snapmaker-u1');
    INSERT INTO claims (claim_key, subject_type, subject_key, relation, object_type, object_key, method, confidence, state, groups, evidence_json, rule_version, created_at, updated_at)
      VALUES ('ck', 'file', 'q:abc', 'member_of', 'model', 'm-1', 'x', 'high', 'applied', 'filename', '[]', 1, 1, 1);
    INSERT INTO model_stats (model_id, print_count) VALUES (1, 1);
    INSERT INTO model_families (model_id, printer_family, variant_count) VALUES (1, 'snapmaker-u1', 1);
    INSERT INTO model_fts (rowid, name) VALUES (1, 'Beardie');
  `);
}
const counts = (db, tables) => Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));

test("a first run creates the schema at the current version, with role grants seeded", () => {
  const s = open(tmpBase());
  assert.equal(s.available, true);
  assert.equal(s.schemaVersion(), schema.SCHEMA_VERSION);
  assert.ok(s.db.prepare("SELECT count(*) AS n FROM permission_grants WHERE subject_type='role'").get().n > 0);
  assert.equal(s.recovery, null);
  s.close();
});

test("reopening an existing database changes nothing", () => {
  const base = tmpBase();
  const a = open(base); seed(a.db); const before = counts(a.db, schema.AUTHORED_TABLES); a.close();
  const b = open(base);
  assert.deepEqual(counts(b.db, schema.AUTHORED_TABLES), before);
  b.close();
});

test("rebuildDerived empties every derived table and leaves every authored row exactly as it was (P4)", () => {
  const s = open(tmpBase());
  seed(s.db);
  const authoredBefore = schema.AUTHORED_TABLES.map(t => [t, s.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]);
  const res = s.rebuildDerived();
  assert.ok(res.ms >= 0);
  for (const [t, rows] of authoredBefore) assert.deepEqual(s.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(), rows, `${t} changed`);
  for (const t of schema.DERIVED_TABLES) assert.equal(s.db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, `${t} not emptied`);
  // The rebuilt tables are the real ones: indexes back, foreign keys on.
  assert.ok(s.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='files_container'").get());
  assert.equal(s.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.throws(() => s.db.prepare("INSERT INTO variants (file_id) VALUES (999)").run(), /FOREIGN KEY/);
  s.close();
});

test("a corrupt database is quarantined and the newest good backup restored", () => {
  const base = tmpBase();
  const a = open(base, { now: tick }); seed(a.db); a.close();
  runBackup({ DatabaseSync, dbPath: path.join(base, "library-data", "library.db"), backupsDir: path.join(base, "library-data", "backups"), reason: "nightly", now: tick });
  fs.writeFileSync(path.join(base, "library-data", "library.db"), "this is not a sqlite database, it is garbage ".repeat(200));
  const b = open(base, { now: tick });
  assert.equal(b.available, true);
  assert.ok(b.recovery && b.recovery.restoredFrom, "it must say it restored");
  assert.equal(b.db.prepare("SELECT name FROM models").get().name, "Beardie", "the backup's data is back");
  const kept = fs.readdirSync(path.join(base, "library-data")).filter(f => f.startsWith("library.db.corrupt-"));
  assert.ok(kept.length >= 1, "the corrupt file is kept, never deleted");
  b.close();
});

test("damage the open probe does not reach, found while preparing, is recovered the same way (M8)", () => {
  // Measured on a copy of a real backup: one damaged page inside a database
  // whose header and schema read fine — opening succeeded, preparing failed
  // with "malformed", and the Library stayed unavailable beside a good backup.
  const base = tmpBase();
  const dbPath = path.join(base, "library-data", "library.db");
  const a = open(base, { now: tick }); seed(a.db); a.close();
  runBackup({ DatabaseSync, dbPath, backupsDir: path.join(base, "library-data", "backups"), reason: "nightly", now: tick });
  // Damage the root page of the table preparing reads first (role defaults).
  const d = new DatabaseSync(dbPath);
  const page = d.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'permission_grants'").get().rootpage;
  const size = d.prepare("PRAGMA page_size").get().page_size;
  d.exec("PRAGMA journal_mode = DELETE"); d.close();
  const fd = fs.openSync(dbPath, "r+"); fs.writeSync(fd, Buffer.alloc(size, 0x5a), 0, size, (page - 1) * size); fs.closeSync(fd);
  const b = open(base, { now: tick });
  assert.equal(b.available, true, b.reason);
  assert.ok(b.recovery && b.recovery.restoredFrom, "restored from the good backup");
  assert.match(b.recovery.error, /malformed|corrupt/i);
  assert.equal(b.db.prepare("SELECT name FROM models").get().name, "Beardie");
  assert.ok(fs.readdirSync(path.join(base, "library-data")).some(f => f.startsWith("library.db.corrupt-")), "the damaged file is kept");
  b.close();
});

test("a corrupt database with no backup starts empty, says so, and keeps the corrupt file", () => {
  const base = tmpBase();
  fs.mkdirSync(path.join(base, "library-data"), { recursive: true });
  fs.writeFileSync(path.join(base, "library-data", "library.db"), "garbage ".repeat(500));
  const s = open(base);
  assert.equal(s.available, true);
  assert.equal(s.recovery.fresh, true, "never recreated silently");
  assert.ok(fs.readdirSync(path.join(base, "library-data")).some(f => f.startsWith("library.db.corrupt-")));
  s.close();
});

test("a database that cannot be opened for another reason is left untouched", () => {
  const base = tmpBase();
  fs.mkdirSync(path.join(base, "library-data", "library.db"), { recursive: true });   // a directory where the file should be
  const s = open(base);
  assert.equal(s.available, false);
  assert.ok(fs.statSync(path.join(base, "library-data", "library.db")).isDirectory(), "nothing was moved or replaced");
  assert.equal(fs.readdirSync(path.join(base, "library-data")).filter(f => f.includes("corrupt")).length, 0);
});

test("a database from a newer SnapCon is refused and left byte-for-byte untouched", () => {
  const base = tmpBase();
  const a = open(base); a.db.exec(`PRAGMA user_version = ${schema.SCHEMA_VERSION + 5}`); a.close();
  const file = path.join(base, "library-data", "library.db");
  const before = fs.readFileSync(file);
  const s = open(base);
  assert.equal(s.available, false);
  assert.match(s.reason, /newer/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test("an unversioned database that already has tables is not adopted", () => {
  const base = tmpBase();
  fs.mkdirSync(path.join(base, "library-data"));
  const d = new DatabaseSync(path.join(base, "library-data", "library.db")); d.exec("CREATE TABLE something_else (x)"); d.close();
  const s = open(base);
  assert.equal(s.available, false);
});

test("without node:sqlite the Library is unavailable, not a crash", () => {
  const s = open(tmpBase(), { sqlite: null });
  assert.equal(s.available, false);
  assert.match(s.reason, /node:sqlite/);
});

test("an upgrade takes a pre-migration snapshot, then migrates inside a transaction", () => {
  const base = tmpBase();
  const v1 = open(base, { now: tick, schema: V1, migrations: {} }); seed(v1.db); v1.close();
  const v2schema = { ...V1, SCHEMA_VERSION: 2 };
  const migrations = { 2: db => db.exec("ALTER TABLE models ADD COLUMN nickname TEXT") };
  const s = open(base, { now: tick, schema: v2schema, migrations });
  assert.equal(s.available, true);
  assert.equal(s.schemaVersion(), 2);
  assert.ok(s.db.prepare("SELECT nickname FROM models").get() !== undefined);
  assert.equal(s.db.prepare("SELECT name FROM models").get().name, "Beardie");
  const snap = listBackups(path.join(base, "library-data", "backups")).filter(b => b.reason === "pre-migration");
  assert.equal(snap.length, 1, "one snapshot before the upgrade");
  const old = new DatabaseSync(path.join(base, "library-data", "backups", snap[0].file));
  assert.equal(old.prepare("PRAGMA user_version").get().user_version, 1, "the snapshot is the pre-upgrade database");
  old.close(); s.close();
});

test("a failed migration rolls back and leaves the Library unavailable at the old version", () => {
  const base = tmpBase();
  const v1 = open(base, { now: tick, schema: V1, migrations: {} }); seed(v1.db); v1.close();
  const s = open(base, { now: tick, schema: { ...V1, SCHEMA_VERSION: 2 }, migrations: { 2: db => { db.exec("ALTER TABLE models ADD COLUMN x TEXT"); throw new Error("boom"); } } });
  assert.equal(s.available, false);
  const again = open(base, { schema: V1, migrations: {} });
  assert.equal(again.schemaVersion(), 1);
  assert.throws(() => again.db.prepare("SELECT x FROM models").get(), /no such column/);
  again.close();
});

test("backups: VACUUM INTO copies, seven routine ones kept, pre-migration snapshots never rotated", () => {
  const base = tmpBase();
  const s = open(base); seed(s.db); s.close();
  const dbPath = path.join(base, "library-data", "library.db"), backupsDir = path.join(base, "library-data", "backups");
  runBackup({ DatabaseSync, dbPath, backupsDir, reason: "pre-migration", now: tick });
  for (let i = 0; i < 10; i++) runBackup({ DatabaseSync, dbPath, backupsDir, reason: "nightly", now: tick });
  const all = listBackups(backupsDir);
  assert.equal(all.filter(b => b.reason === "nightly").length, 7);
  assert.equal(all.filter(b => b.reason === "pre-migration").length, 1);
  assert.equal(fs.readdirSync(backupsDir).filter(f => f.endsWith(".partial")).length, 0);
  const copy = new DatabaseSync(path.join(backupsDir, all[0].file));
  assert.equal(copy.prepare("SELECT name FROM models").get().name, "Beardie", "a backup is a complete, openable database");
  copy.close();
});

test("backups with another prefix (the audit and sync stores) never list or rotate the Library's", () => {
  const base = tmpBase();
  const s = open(base); seed(s.db); s.close();
  const dbPath = path.join(base, "library-data", "library.db"), backupsDir = path.join(base, "library-data", "backups");
  runBackup({ DatabaseSync, dbPath, backupsDir, reason: "nightly", now: tick });
  for (let i = 0; i < 9; i++) runBackup({ DatabaseSync, dbPath, backupsDir, reason: "nightly", now: tick, prefix: "audit" });
  assert.equal(listBackups(backupsDir).length, 1, "the Library's one backup, unchanged by the other prefix's rotation");
  assert.equal(listBackups(backupsDir, "audit").length, 7);
  assert.ok(listBackups(backupsDir, "audit").every(b => b.file.startsWith("audit-")));
  assert.throws(() => listBackups(backupsDir, "a.*"), /invalid backup prefix/);
});

test("backupDue: none yet, or the newest routine backup 24 h old; pre-migration snapshots don't count", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const at = new Date(2026, 9, 5, 2, 30, 0).getTime();   // stamps are local time
  const b = (stamp, reason = "nightly") => ({ stamp, reason });
  assert.equal(backupDue([], at, DAY), true);
  assert.equal(backupDue([b("20261005-023000", "pre-migration")], at, DAY), true);
  assert.equal(backupDue([b("20261004-023001")], at, DAY), false, "a second short of a day");
  assert.equal(backupDue([b("20261004-023000")], at, DAY), true);
  assert.equal(backupDue([b("20261005-020000", "pre-migration"), b("20261003-010000")], at, DAY), true);
});

test("a damaged database is never backed up over the good copies", () => {
  const base = tmpBase();
  const s = open(base); seed(s.db);
  for (let i = 0; i < 200; i++) s.db.prepare("INSERT INTO tags (name) VALUES (?)").run("tag-" + i + "-".repeat(200));
  s.close();
  const dbPath = path.join(base, "library-data", "library.db"), backupsDir = path.join(base, "library-data", "backups");
  runBackup({ DatabaseSync, dbPath, backupsDir, reason: "nightly", now: tick });
  // Overwrite a page in the middle of the file.
  const buf = fs.readFileSync(dbPath);
  buf.fill(0xa5, Math.floor(buf.length / 2), Math.floor(buf.length / 2) + 4096);
  fs.writeFileSync(dbPath, buf);
  assert.throws(() => runBackup({ DatabaseSync, dbPath, backupsDir, reason: "nightly", now: tick }), e => /integrity|malformed|corrupt/i.test(e.message));
  assert.equal(listBackups(backupsDir).length, 1, "the one good backup is still the only one");
});

test("after a backup is refused for failing its integrity check, the next start checks fully and restores", () => {
  const base = tmpBase();
  const s = open(base, { now: tick }); seed(s.db);
  for (let i = 0; i < 200; i++) s.db.prepare("INSERT INTO tags (name) VALUES (?)").run("tag-" + i + "-".repeat(200));
  // A leaf page of the tags table: data that startup never reads.
  const pageSize = s.db.prepare("PRAGMA page_size").get().page_size;
  const page = s.db.prepare("SELECT pageno FROM dbstat WHERE name = 'tags' AND pagetype = 'leaf' ORDER BY pageno LIMIT 1 OFFSET 1").get().pageno;
  s.close();
  const dbPath = path.join(base, "library-data", "library.db"), backupsDir = path.join(base, "library-data", "backups");
  runBackup({ DatabaseSync, dbPath, backupsDir, reason: "nightly", now: tick });
  const buf = fs.readFileSync(dbPath);
  buf.fill(0xa5, (page - 1) * pageSize + 8, page * pageSize);   // keep the page header's first bytes, garble its cells
  fs.writeFileSync(dbPath, buf);
  // A plain start does not notice: only the header and schema are read.
  const quiet1 = open(base, { now: tick });
  assert.equal(quiet1.available, true);
  assert.equal(quiet1.recovery, null);
  quiet1.requestIntegrityCheck("integrity check failed");   // what a refused backup does
  quiet1.close();
  // The next start runs the full check, finds the damage, and restores.
  const s2 = open(base, { now: tick });
  assert.equal(s2.available, true);
  assert.ok(s2.recovery && s2.recovery.restoredFrom, "restored from the good backup");
  assert.equal(s2.db.prepare("SELECT name FROM models").get().name, "Beardie");
  assert.equal(fs.existsSync(path.join(base, "library-data", "integrity-check-requested")), false, "the request is used once");
  s2.close();
});

test("migration 2 adds the identity cache, seeded from the full hashes the index already has", () => {
  const base = tmpBase();
  const v1 = open(base, { now: tick, schema: V1, migrations: {} });
  seed(v1.db);
  v1.db.prepare("INSERT INTO roots (id, name, path, created_at) VALUES ('r', 'r', 'x', 1)").run();
  const ins = v1.db.prepare(`INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, sha256, md5, content_key, first_seen, last_seen)
    VALUES ('r', ?, ?, 'gcode', 'sliced', 10, 1, ?, ?, ?, ?, 1, 1)`);
  ins.run("a.gcode", "a.gcode", "fpA", "A".repeat(64), "mA", "A".repeat(64));
  ins.run("b.gcode", "b.gcode", "fpB", null, null, "q:fpB");
  v1.close();
  const s = open(base, { now: tick });
  assert.equal(s.available, true);
  assert.equal(s.schemaVersion(), schema.SCHEMA_VERSION);
  assert.deepEqual(s.db.prepare("SELECT quick_fp, size, sha256, md5 FROM identity_cache").all().map(r => ({ ...r })),
    [{ quick_fp: "fpA", size: 10, sha256: "A".repeat(64), md5: "mA" }], "only verified hashes");
  assert.equal(s.db.prepare("SELECT name FROM models").get().name, "Beardie", "authored data untouched");
  s.close();
});

test("a derived rebuild keeps the identity cache; the explicit reset empties only the cache", () => {
  const base = tmpBase();
  const s = open(base);
  seed(s.db);
  s.db.prepare("INSERT INTO identity_cache (quick_fp, size, sha256, md5, verified_at) VALUES ('fp', 1, 'S', 'M', 1)").run();
  const decisions = s.db.prepare("SELECT count(*) AS n FROM decisions").get().n;
  s.rebuildDerived();
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM identity_cache").get().n, 1, "a normal rebuild keeps it");
  assert.deepEqual(s.resetIdentityCache(), { removed: 1 });
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM identity_cache").get().n, 0);
  assert.equal(s.db.prepare("SELECT name FROM models").get().name, "Beardie", "Models stay");
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM decisions").get().n, decisions, "Decisions stay");
  s.close();
});

test("migration 3 (M6): actions, withdrawn Decisions and merged Models arrive on a v2 database, and nothing authored is lost", () => {
  const base = tmpBase();
  // The v2 shape: today's schema without what migration 3 adds.
  const v2Authored = schema.AUTHORED_SQL
    .replace(/CREATE TABLE actions \([\s\S]*?\);/, "").replace(/CREATE INDEX actions_model [^;]*;/, "")
    .replace(/,\s*merged_into TEXT\);[^\n]*/, ");")
    .replace(/,\s*-- replaced by a later Decision; history kept\s*action_id INTEGER REFERENCES actions\(id\),\s*-- the M6 action that wrote it\s*withdrawn_at INTEGER\);[^\n]*/, ");");
  const v2Derived = schema.DERIVED_SQL.replace(", search_terms,", ",");
  assert.ok(!/merged_into|withdrawn_at|CREATE TABLE actions|search_terms/.test(v2Authored + v2Derived), "the v2 shape really lacks them");
  const v2 = open(base, { now: tick, schema: { ...schema, SCHEMA_VERSION: 2, AUTHORED_SQL: v2Authored, DERIVED_SQL: v2Derived }, migrations: {} });
  seed(v2.db);
  v2.close();
  const s = open(base, { now: tick });
  assert.equal(s.available, true);
  assert.equal(s.schemaVersion(), schema.SCHEMA_VERSION);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM decisions WHERE withdrawn_at IS NULL AND action_id IS NULL").get().n, 1, "the existing Decision is kept, active");
  assert.equal(s.db.prepare("SELECT merged_into FROM models").get().merged_into, null);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM actions").get().n, 0);
  assert.ok(s.db.prepare("PRAGMA table_info(model_fts)").all().some(c => c.name === "search_terms"));
  s.close();
});

test("migration 4 (M7): how each Print was started, one row per job, the imports and print links arrive on a v3 database, and every Print is kept", () => {
  const base = tmpBase();
  // The v3 shape: today's schema without what migration 4 adds — with its
  // comments, which is where a statement extractor tripped on "(#plate);".
  const v3Authored = schema.AUTHORED_SQL
    .replace(/audit_ref INTEGER,[^\n]*\n[\s\S]*?job_key TEXT\);[^\n]*/, "audit_ref INTEGER);")
    .replace(/CREATE UNIQUE INDEX prints_job [^;]*;/, "").replace(/CREATE INDEX prints_audit [^;]*;/, "")
    .replace(/CREATE TABLE print_imports \([\s\S]*?report_json TEXT NOT NULL\);/, "");
  const v3Derived = schema.DERIVED_SQL.replace(/CREATE TABLE print_links \([\s\S]*?by_decision INTEGER NOT NULL DEFAULT 0\);/, "").replace(/CREATE INDEX print_links_model [^;]*;/, "");
  assert.ok(!/job_key|print_imports|print_links|prints_job/.test(v3Authored + v3Derived), "the v3 shape really lacks them");
  const v3 = open(base, { now: tick, schema: { ...schema, SCHEMA_VERSION: 3, AUTHORED_SQL: v3Authored, DERIVED_SQL: v3Derived }, migrations: {} });
  seed(v3.db);
  v3.close();
  const s = open(base, { now: tick });
  assert.equal(s.available, true, s.reason);
  assert.equal(s.schemaVersion(), 4);
  const p = s.db.prepare("SELECT * FROM prints").get();
  assert.deepEqual([p.content_key, p.remote_name, p.via, p.job_key], ["q:abc", "b.gcode", null, null], "the existing Print is kept as it was");
  for (const c of ["via", "location", "queue_item_id", "job_key"]) assert.ok(s.db.prepare("PRAGMA table_info(prints)").all().some(x => x.name === c), c);
  s.db.prepare("INSERT INTO prints (printer_id, remote_name, source, link_method, link_confidence, job_key) VALUES ('p', 'x', 'send', 'none', 'none', 'k')").run();
  assert.throws(() => s.db.prepare("INSERT INTO prints (printer_id, remote_name, source, link_method, link_confidence, job_key) VALUES ('p', 'x', 'send', 'none', 'none', 'k')").run(), /UNIQUE/, "one row per job");
  assert.throws(() => s.db.prepare("INSERT INTO prints (printer_id, remote_name, source, link_method, link_confidence, via) VALUES ('p', 'x', 'send', 'none', 'none', 'fax')").run(), /CHECK/);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM print_imports").get().n, 0);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM print_links").get().n, 0, "derived: the next grouping fills it");
  s.close();
});
