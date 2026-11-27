// test/utilization/store.test.js — the utilization database: creation, schema,
// what it refuses, recovery, migration, backups.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createUtilizationStore, SCHEMA_SQL, V2_SQL, V3_SQL, SCHEMA_VERSION } = require("../../utilization/UtilizationStore");
const { DatabaseSync } = require("node:sqlite");
const { quiet, tmpBase } = require("./helpers");

const open = (base, opts = {}) => createUtilizationStore({ baseDir: base, log: quiet, now: () => 1_800_000_000_000, ...opts }).open();
const P = { id: "p1", name: "U1 Red", connector: "snapmaker-u1-klipper-ws", isVirtual: false, at: 1 };

test("created on first start, versioned, in WAL mode, with its own folder", t => {
  const base = tmpBase(t), s = open(base);
  t.after(() => s.close());
  assert.equal(s.isAvailable(), true);
  const db = new DatabaseSync(path.join(base, "utilization-data", "utilization.db"));
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  db.close();
  const raw = new DatabaseSync(path.join(base, "utilization-data", "utilization.db"));
  // synchronous is per connection: read it through the store's own.
  raw.close();
  assert.equal(s.pragma("synchronous"), 1, "NORMAL");
});

test("the database refuses two open intervals for one printer, and an interval that ends before it starts", t => {
  const base = tmpBase(t), s = open(base);
  t.after(() => s.close());
  s.upsertPrinter(P);
  s.apply("p1", 100, { next: { kind: "idle" } });
  const db = new DatabaseSync(path.join(base, "utilization-data", "utilization.db"));
  t.after(() => db.close());
  assert.throws(() => db.prepare("INSERT INTO segments (printer_id, kind, provenance, start_at) VALUES ('p1','idle','observed',200)").run(), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO segments (printer_id, kind, provenance, start_at, end_at) VALUES ('p1','idle','observed',300,300)").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO segments (printer_id, kind, provenance, start_at) VALUES ('p1','sleeping','observed',400)").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO segments (printer_id, kind, provenance, start_at, end_at) VALUES ('p1','idle','observed',100,150)").run(), /UNIQUE/, "one interval per printer per start time");
});

test("a step back in time is refused, and refused whole: nothing half-written", t => {
  const s = open(tmpBase(t));
  t.after(() => s.close());
  s.upsertPrinter(P);
  s.apply("p1", 100, { next: { kind: "idle" } });
  s.apply("p1", 200, { next: { kind: "offline", reason: "unreachable" } });
  assert.throws(() => s.apply("p1", 150, { next: { kind: "idle" } }), /before the open interval/);
  s.apply("p1", 300, {});
  assert.throws(() => s.apply("p1", 250, { next: { kind: "idle" } }), /before the last interval ended/);
  assert.throws(() => s.apply("p1", 400, { startJob: { filename: "a", key: "k" }, next: { kind: "bogus" } }), /invalid kind/);
  assert.equal(s.jobs("p1").length, 0, "the job of the refused step was rolled back");
  assert.deepEqual(s.segments("p1").map(x => [x.kind, x.start, x.end]), [["idle", 100, 200], ["offline", 200, 300]]);
});

test("an interval that would close where it opened is dropped, not stored with no length", t => {
  const s = open(tmpBase(t));
  t.after(() => s.close());
  s.upsertPrinter(P);
  s.apply("p1", 100, { next: { kind: "idle" } });
  s.apply("p1", 100, { next: { kind: "job", jobKey: "k" }, startJob: { filename: "a", key: "k" } });
  assert.deepEqual(s.segments("p1").map(x => [x.kind, x.start, x.end]), [["job", 100, null]]);
});

test("node:sqlite unavailable: nothing recorded, nothing thrown", t => {
  const s = createUtilizationStore({ baseDir: tmpBase(t), log: quiet, sqlite: null }).open();
  assert.equal(s.isAvailable(), false);
  assert.match(s.status().reason, /node:sqlite/);
  assert.throws(() => s.apply("p1", 1, {}), /unavailable/);
  assert.equal(s.backup(), null);
});

test("an unwritable folder: unavailable, not a crash", t => {
  const base = tmpBase(t);
  fs.writeFileSync(path.join(base, "utilization-data"), "a file where the folder should be");
  const s = open(base);
  assert.equal(s.isAvailable(), false);
  assert.match(s.status().reason, /cannot create/);
});

test("a damaged database is moved aside, kept, and a new one started", t => {
  const base = tmpBase(t), dir = path.join(base, "utilization-data");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "utilization.db"), "this is not a database, it is history someone may still want");
  const s = open(base);
  t.after(() => s.close());
  assert.equal(s.isAvailable(), true);
  const kept = fs.readdirSync(dir).filter(f => f.includes(".corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), "this is not a database, it is history someone may still want");
  assert.equal(s.status().recovery.moved[0], kept[0]);
});

// Deployment review: before, ANY open failure moved a healthy file aside and
// started empty in its place. Only damage may: a lock or a permission problem
// leaves the database exactly where it is.
for (const [name, hold] of [
  ["a lock held by another process", async file => {
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, ["-e", `const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(${JSON.stringify(file)});
      d.exec("PRAGMA locking_mode = EXCLUSIVE"); d.exec("BEGIN EXCLUSIVE"); d.exec("INSERT INTO meta (key, value) VALUES ('held', '1')"); console.log("held"); setTimeout(() => {}, 30000);`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("exit", reject); });
    return async () => { child.kill(); await new Promise(r => child.once("exit", r)); };
  }],
  ["a file this process may not read", async file => { fs.chmodSync(file, 0o000); return async () => fs.chmodSync(file, 0o600); }],
]) {
  test(`${name}: the database is left where it is, untouched, and nothing is recorded (never moved aside, never replaced)`, { skip: name.includes("may not read") && process.getuid && process.getuid() === 0 ? "root reads any file" : false }, async t => {
    const base = tmpBase(t), dir = path.join(base, "utilization-data"), file = path.join(dir, "utilization.db");
    open(base).close();
    const db = new DatabaseSync(file); db.prepare("INSERT INTO printers (id, name, connector, is_virtual, first_seen) VALUES ('keep', 'Keep', 'x', 0, 1)").run(); db.close();
    const release = await hold(file);
    let s;
    try { s = open(base); } finally { await release(); }
    t.after(() => s.close());
    assert.equal(s.isAvailable(), false, "recording is off");
    assert.match(s.status().reason, /left as it is/);
    assert.equal(s.status().recovery, null, "no recovery: nothing was moved");
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes(".corrupt-")), [], "nothing moved aside");
    const after = new DatabaseSync(file);
    assert.equal(after.prepare("SELECT count(*) AS n FROM printers WHERE id = 'keep'").get().n, 1, "the history is still in utilization.db");
    after.close();
    // The next start (the lock or permission gone) opens it as usual.
    const again = open(base);
    t.after(() => again.close());
    assert.equal(again.isAvailable(), true);
    assert.deepEqual(again.printers().map(p => p.id), ["keep"]);
  });
}

test("a database from a newer SnapCon is left alone: nothing recorded into it", t => {
  const base = tmpBase(t);
  open(base).close();
  const file = path.join(base, "utilization-data", "utilization.db");
  const db = new DatabaseSync(file); db.exec("PRAGMA user_version = 9"); db.close();
  const before = fs.statSync(file).mtimeMs;
  const s = open(base);
  assert.equal(s.isAvailable(), false);
  assert.match(s.status().reason, /newer SnapCon/);
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test("a version 1 database is upgraded to the current version after a pre-migration backup, data and job keys kept", t => {
  const base = tmpBase(t);
  const v1 = open(base, { schemaVersion: 1 });
  v1.upsertPrinter(P);
  const db1 = new DatabaseSync(path.join(base, "utilization-data", "utilization.db"));
  db1.exec("INSERT INTO jobs (printer_id, source, filename, started_at) VALUES ('p1','observed','a.gcode',100)");
  db1.exec("INSERT INTO segments (printer_id, kind, job_id, provenance, start_at, end_at) VALUES ('p1','job',1,'observed',100,200)");
  db1.close(); v1.close();
  const v2 = open(base);
  t.after(() => v2.close());
  assert.equal(v2.isAvailable(), true);
  assert.ok(v2.listBackups().some(b => b.reason === "pre-migration"));
  assert.deepEqual(v2.jobs("p1").map(j => [j.filename, j.key]), [["a.gcode", "p1:100:1"]]);
  assert.equal(v2.segments("p1").length, 1);
  const db = new DatabaseSync(path.join(base, "utilization-data", "utilization.db"));
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  const idx = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all().map(x => x.name);
  for (const n of ["jobs_key", "jobs_closed", "jobs_running", "segments_printer_end", "segments_job", "segments_closed", "segments_printer_start", "applied_batches_at", "jobs_history"]) assert.ok(idx.includes(n), n);
  assert.ok(db.prepare("PRAGMA table_info(segments)").all().some(c => c.name === "known_fraction"));
  assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'history_sync'").get());
});

test("a later upgrade runs its migration after a backup, and keeps the data", t => {
  const base = tmpBase(t);
  const v2 = open(base);
  v2.upsertPrinter(P); v2.apply("p1", 100, { next: { kind: "idle" } }); v2.close();
  const migrations = { 2: db => db.exec(V2_SQL), 3: db => db.exec(V3_SQL), 4: db => db.exec("ALTER TABLE printers ADD COLUMN note TEXT") };
  const v3 = open(base, { schemaVersion: 4, migrations });
  t.after(() => v3.close());
  assert.equal(v3.isAvailable(), true);
  assert.equal(v3.segments("p1").length, 1);
  assert.ok(v3.listBackups().some(b => b.reason === "pre-migration"));
  const db = new DatabaseSync(path.join(base, "utilization-data", "utilization.db"));
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
  assert.ok(db.prepare("PRAGMA table_info(printers)").all().some(c => c.name === "note"));
  db.close();
});

test("a failing migration leaves the old version and the data, and records nothing", t => {
  const base = tmpBase(t);
  const v2 = open(base); v2.upsertPrinter(P); v2.close();
  const bad = open(base, { schemaVersion: 4, migrations: { 2: db => db.exec(V2_SQL), 3: db => db.exec(V3_SQL), 4: db => { db.exec("ALTER TABLE printers ADD COLUMN x TEXT"); throw new Error("boom"); } } });
  assert.equal(bad.isAvailable(), false);
  const again = open(base);
  t.after(() => again.close());
  assert.equal(again.isAvailable(), true);
  assert.equal(again.printers().length, 1);
  const db = new DatabaseSync(path.join(base, "utilization-data", "utilization.db"));
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
  assert.ok(!db.prepare("PRAGMA table_info(printers)").all().some(c => c.name === "x"), "rolled back");
  db.close();
});

test("tables but no version: refused, not overwritten", t => {
  const base = tmpBase(t), dir = path.join(base, "utilization-data");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "utilization.db")); db.exec("CREATE TABLE x (a)"); db.close();
  const s = open(base);
  assert.equal(s.isAvailable(), false);
  assert.match(s.status().reason, /no schema version/);
});

test("prune keeps open intervals, running jobs and jobs still referenced", t => {
  const s = open(tmpBase(t));
  t.after(() => s.close());
  s.upsertPrinter(P);
  s.apply("p1", 100, { startJob: { filename: "old", key: "k1" }, next: { kind: "job", jobKey: "k1" } });
  s.apply("p1", 200, { endJob: { key: "k1", outcome: "completed" }, next: { kind: "idle" } });
  s.apply("p1", 300, { startJob: { filename: "new", key: "k2" }, next: { kind: "job", jobKey: "k2" } });
  assert.deepEqual(s.prune(250), { segments: 1, jobs: 1 });
  assert.deepEqual(s.segments("p1").map(x => x.kind), ["idle", "job"]);
  assert.deepEqual(s.jobs("p1").map(j => j.filename), ["new"]);
});

test("prune never removes a running job, even one with no open interval left after a clean stop", t => {
  const s = open(tmpBase(t));
  t.after(() => s.close());
  s.upsertPrinter(P);
  s.apply("p1", 100, { startJob: { filename: "long", key: "k1" }, next: { kind: "job", jobKey: "k1" } });
  s.apply("p1", 200, {});
  assert.deepEqual(s.prune(10_000), { segments: 1, jobs: 0 });
  assert.deepEqual(s.jobs("p1").map(j => [j.filename, j.outcome]), [["long", "running"]]);
});

test("backups are SQLite-consistent copies with the utilization prefix", t => {
  const s = open(tmpBase(t));
  t.after(() => s.close());
  s.upsertPrinter(P);
  const r = s.backup();
  assert.match(r.file, /^utilization-.*-nightly\.db$/);
  assert.equal(s.listBackups().length, 1);
});

test("the schema keeps provenance and outcome to their allowed values", () => {
  for (const v of ["'observed','inferred','backfilled'", "'running','completed','failed','cancelled','unknown'", "'job','paused','error','idle','offline','unobserved'"]) assert.ok(SCHEMA_SQL.includes(v), v);
});

test("a batch is applied once: the same id again changes nothing", t => {
  const s = open(tmpBase(t));
  t.after(() => s.close());
  s.upsertPrinter(P);
  const ops = [{ type: "step", printerId: "p1", at: 100, startJob: { key: "k", filename: "a" }, next: { kind: "job", jobKey: "k" } }, { type: "checkpoint", at: 100 }];
  assert.equal(s.applyBatch("b1", ops), "applied");
  assert.equal(s.applyBatch("b1", ops), "already");
  assert.equal(s.segments("p1").length, 1);
  assert.equal(s.jobs("p1").length, 1);
});

test("a commit that fails is rolled back whole, and the same batch can be applied after", t => {
  let fail = true;
  const s = open(tmpBase(t), { hooks: { beforeCommit: () => { if (fail) { fail = false; throw Object.assign(new Error("disk I/O error"), { errcode: 10 }); } } } });
  t.after(() => s.close());
  s.upsertPrinter(P);
  const ops = [{ type: "step", printerId: "p1", at: 100, startJob: { key: "k", filename: "a" }, next: { kind: "job", jobKey: "k" } }];
  assert.throws(() => s.applyBatch("b1", ops), /disk I\/O/);
  assert.equal(s.segments("p1").length + s.jobs("p1").length, 0);
  assert.equal(s.applyBatch("b1", ops), "applied");
  assert.equal(s.segments("p1").length, 1);
});

test("uniqueness keeps every legitimate event: back-to-back steps, two printers at one instant, the same file twice", t => {
  const s = open(tmpBase(t));
  t.after(() => s.close());
  s.upsertPrinter(P); s.upsertPrinter({ ...P, id: "p2" });
  const step = (id, at, o) => s.applyBatch(`${id}-${at}`, [{ type: "step", printerId: id, at, ...o }]);
  step("p1", 100, { startJob: { key: "p1:100", filename: "a" }, next: { kind: "job", jobKey: "p1:100" } });
  step("p2", 100, { startJob: { key: "p2:100", filename: "a" }, next: { kind: "job", jobKey: "p2:100" } });
  step("p1", 101, { next: { kind: "paused", jobKey: "p1:100" } });
  step("p1", 102, { next: { kind: "job", jobKey: "p1:100" } });
  step("p1", 103, { endJob: { key: "p1:100", outcome: "completed" }, next: { kind: "idle" } });
  step("p1", 104, { startJob: { key: "p1:104", filename: "a" }, next: { kind: "job", jobKey: "p1:104" } });
  assert.deepEqual(s.segments("p1").map(x => [x.kind, x.start]), [["job", 100], ["paused", 101], ["job", 102], ["idle", 103], ["job", 104]]);
  assert.equal(s.segments("p2").length, 1);
  assert.deepEqual(s.jobs("p1").map(j => [j.filename, j.outcome]), [["a", "completed"], ["a", "running"]]);
});

test("the queries on the hot path and in prune use their indexes, never a whole-table scan", t => {
  const s = open(tmpBase(t));
  t.after(() => s.close());
  const scan = plan => plan.filter(d => /^SCAN (segments|jobs|applied_batches)\b/.test(d) && !/USING (COVERING )?INDEX/.test(d));
  const plans = {
    open: s.explain("SELECT * FROM segments WHERE printer_id = ? AND end_at IS NULL", "p"),
    lastEnd: s.explain("SELECT max(end_at) AS e FROM segments WHERE printer_id = ?", "p"),
    jobByKey: s.explain("SELECT id FROM jobs WHERE job_key = ?", "k"),
    running: s.explain("SELECT printer_id, job_key FROM jobs WHERE outcome = 'running'"),
    pruneSegments: s.explain("SELECT id FROM segments WHERE end_at IS NOT NULL AND end_at < ? ORDER BY end_at LIMIT ?", 1, 1),
    pruneJobs: s.explain("SELECT j.id FROM jobs j WHERE j.outcome <> 'running' AND coalesce(j.ended_at, j.started_at) < ? AND NOT EXISTS (SELECT 1 FROM segments s WHERE s.job_id = j.id) ORDER BY coalesce(j.ended_at, j.started_at) LIMIT ?", 1, 1),
    pruneBatches: s.explain("SELECT id FROM applied_batches WHERE at < ? ORDER BY at LIMIT ?", 1, 1),
    // History reconciliation (reconcile.js)
    already: s.explain("SELECT 1 FROM jobs WHERE printer_id = ? AND history_id = ?", "p", "h"),
    match: s.explain("SELECT * FROM jobs WHERE printer_id = ? AND history_id IS NULL AND source = 'observed' AND started_at BETWEEN ? AND ? AND (filename IS NULL OR ? IS NULL OR filename = ?) ORDER BY abs(started_at - ?) LIMIT 1", "p", 1, 2, "f", "f", 1),
    later: s.explain("SELECT 1 FROM segments WHERE job_id = ? AND start_at > ? LIMIT 1", 1, 1),
    segBefore: s.explain("SELECT * FROM segments WHERE printer_id = ? AND start_at <= ? ORDER BY start_at DESC LIMIT 1", "p", 1),
    segInside: s.explain("SELECT * FROM segments WHERE printer_id = ? AND start_at > ? AND start_at < ? ORDER BY start_at", "p", 1, 2),
  };
  for (const [k, p] of Object.entries(plans)) assert.deepEqual(scan(p), [], `${k}: ${p.join(" | ")}`);
  assert.ok(plans.pruneJobs.some(d => /segments_job/.test(d)), plans.pruneJobs.join(" | "));
  assert.ok(plans.later.some(d => /segments_job/.test(d)), "only the job's own intervals: " + plans.later.join(" | "));
  assert.ok(plans.match.some(d => /jobs_printer/.test(d) && /started_at>\? AND started_at<\?/.test(d)), plans.match.join(" | "));
});

test("prune in passes: each pass removes at most its limit", t => {
  const s = open(tmpBase(t));
  t.after(() => s.close());
  s.upsertPrinter(P);
  for (let i = 0; i < 50; i++) s.apply("p1", 100 + i * 10, { next: { kind: i % 2 ? "idle" : "offline" } });
  s.apply("p1", 1000, {});
  const passes = [];
  for (;;) { const r = s.prunePass(900, 7); passes.push(r.segments); if (!r.segments && !r.jobs && !r.batches) break; }
  assert.ok(passes.every(n => n <= 7));
  assert.ok(passes.length >= 8, "49 intervals in passes of 7");
  assert.deepEqual(s.segments("p1").map(x => [x.start, x.end]), [[590, 1000]]);
});
