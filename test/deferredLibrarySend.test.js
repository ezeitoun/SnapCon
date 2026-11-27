// test/deferredLibrarySend.test.js — a Library send that is finished later
// keeps what was sent (M7.1).
//
// Before: a Library Variant sent to a busy printer (deferred until it was
// free), or uploaded now and started later from the printer, lost its
// identity on the way: the eventual Print was linked by file name, or not at
// all. Now the send's Library Variant, verified hash, location and plate ride
// along — the deferred send (§37 P3) → upload → the printer's "ready" file (persisted) →
// started from the printer — and the Print is recorded as exactly that,
// unless the printer's copy is no longer the one SnapCon put there.
//
// The server functions are taken from server.js; the Print is recorded in a
// real Library database through library/prints.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const { deferredHarness } = require("./helpers/deferredHarness");
const { createLibraryStore } = require("../library/LibraryStore");
const grouping = require("../library/grouping");
const actions = require("../library/actions");
const prints = require("../library/prints");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const SHA = "a".repeat(64);
const quiet = { log() {}, warn() {}, error() {} };

// A Library with the Variant that was sent.
function library(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-defer-"));
  const store = createLibraryStore({ baseDir: base, log: quiet }).open();
  t.after(() => store.close());
  store.roots.insert({ id: "gcode", name: "G-code folder", path: base, grouping: "files", enabled: true, scan_every_min: 30, created_at: 1 });
  const db = store.db;
  db.prepare("INSERT INTO scan_runs (root_id, started_at, finished_at, outcome) VALUES ('gcode', 1, 2, 'ok')").run();
  const id = Number(db.prepare(`INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, sha256, content_key, first_seen, last_seen)
    VALUES ('gcode', 'AD5X/Beardie (5h41m).gcode', 'Beardie (5h41m).gcode', 'gcode', 'sliced', 10, 1, 'fp', ?, ?, 1, 1)`).run(SHA, SHA).lastInsertRowid);
  db.prepare("INSERT INTO file_objects (file_id, name_norm, raw_name, origin) VALUES (?, 'beardie.stl', 'Beardie.stl', 'exclude_object')").run(id);
  db.prepare("INSERT INTO variants (file_id, plate_no, printer_family) VALUES (?, NULL, 'flashforge-ad5x')").run(id);
  let n = 0;
  const group = () => grouping.run(db, { now: 1000, uuid: () => "00000000-0000-0000-0000-" + String(++n).padStart(12, "0") });
  group();
  const model = () => db.prepare("SELECT m.uuid, m.name, m.id FROM files f JOIN models m ON m.id = f.model_id").get();
  return { db, group, model };
}

// The server side of the send: server.js's own deferred-send code (§37 P3)
// and /api/printfile's pieces, with a printer whose storage is a Map
// (test/helpers/deferredHarness.js).
function server(t, opts = {}) {
  const h = deferredHarness(t, { printers: [{ id: "ad5x", name: "AD5X White", connector: "flashforge-ad5x" }], ...opts });
  const src = h.file("Beardie (5h41m).gcode", "0123456789");
  const recorded = [];
  const hashes = { [src]: SHA };
  // The Library's Variant hash stands for this file's content, as before.
  h.env.queueStore = { computeFileHash: async p => ({ sizeBytes: fs.statSync(p).size, sha256: hashes[p] || "other" }) };
  h.env.library = { recordPrintStart: e => { recorded.push(e); return Promise.resolve(null); } };
  for (const m of ["const STAGED_CHECK_MAP", "const stagedSend"]) vm.runInContext(serverSrc.slice(serverSrc.indexOf(m), serverSrc.indexOf("\n", serverSrc.indexOf(m))), h.env);
  vm.runInContext("this.stagedSend = stagedSend;", h.env);
  vm.runInContext("const libraryAudit = " + serverSrc.slice(serverSrc.indexOf("const libraryAudit = ") + 21, serverSrc.indexOf("\n", serverSrc.indexOf("const libraryAudit = "))), h.env);
  for (const name of ["async function checkStagedCopy(", "async function runPrintFileJob("]) {
    const at = serverSrc.indexOf(name);
    assert.ok(at > 0, name);
    vm.runInContext(serverSrc.slice(at, at + serverSrc.slice(at).search(/\r?\n\}\r?\n/) + 3), h.env);
  }
  const printer = h.p("ad5x");
  // The printer's copy, set by hand: another file of that name.
  const replaceOnPrinter = buf => h.storage.set("ad5x/Beardie (5h41m).gcode", buf);
  return { h, env: h.env, src, recorded, audits: h.audits, printer, connector: h.connector, hashes, replaceOnPrinter };
}
// What /api/print accepts for a deferred Library send (sendRef), sent once the
// printer is free.
const deferred = (src, model, { plate = null } = {}) => ({ name: path.basename(src), kind: "library", file: src, tools: [], map: {}, prefs: {}, actor: { userId: "u", userLabel: "owner" }, plate,
  send: { plate, location: "gcode:AD5X/Beardie (5h41m).gcode", library: { contentKey: SHA, plate: null, model: model.uuid, modelName: model.name, variantKey: SHA, sha256: SHA } } });
async function sendLater(s, d) {
  const rec = await s.env.acceptDeferredSend(s.printer, d);
  await s.h.pump();
  return rec;
}

// /api/printfile: the staged file's plate and send, after the copy check.
async function startFromPrinter(s, name) {
  const staged = s.env.queuedFile.get("ad5x");
  const isIt = staged && staged.status === "ready" && staged.name === name ? staged : null;
  // As /api/printfile does since §37 P5: the check first, refused unless present.
  const check = isIt ? await s.env.checkStagedCopy(s.printer, s.connector, isIt) : null;
  if (check && check.state !== "present") return { refused: check.state };
  const send = isIt ? s.env.stagedSend(isIt, check) : null;
  const job = { phase: "starting", done: false };
  await s.env.runPrintFileJob({ p: s.printer, c: s.connector, filename: name, tools: [], map: {}, prefs: {}, actor: { userId: "u", userLabel: "owner" },
    needsMapping: false, job, plate: isIt ? isIt.plate : null, send });
  return s.recorded[s.recorded.length - 1];
}
const chain = (L, e) => { prints.recordStart(L.db, e, { now: 5000 }); const p = L.db.prepare("SELECT p.*, pl.model_id, pl.confidence AS eff FROM prints p JOIN print_links pl ON pl.print_id = p.id ORDER BY p.id DESC LIMIT 1").get();
  return { method: p.link_method, confidence: p.link_confidence, model: L.db.prepare("SELECT uuid FROM models WHERE id = ?").get(p.model_id).uuid, location: p.location, evidence: JSON.parse(p.link_evidence_json) }; };

test("deferred Library send → upload when the printer is free → started from the printer: the Print is exact, not by name", async t => {
  const L = library(t), s = server(t), m = L.model();
  await sendLater(s, deferred(s.src, m));
  const ready = s.env.queuedFile.get("ad5x");
  assert.equal(ready.status, "ready");
  assert.equal(ready.send.library.model, m.uuid);
  const e = await startFromPrinter(s, "Beardie (5h41m).gcode");
  assert.equal(e.source, "library");
  assert.equal(e.library.staged, true);
  assert.equal(e.library.copyChecked, true, "the printer still holds the copy SnapCon sent");
  const c = chain(L, { ...e, jobKey: "printfile:1" });
  assert.deepEqual([c.method, c.confidence, c.model, c.location], ["snapcon_variant", "exact", m.uuid, "gcode:AD5X/Beardie (5h41m).gcode"]);
  assert.equal(c.evidence.basis, "sent from the Library, started later from the printer");
  assert.equal(s.audits.find(a => a.event === "print-started").detail.library.model, m.uuid);
});

test("a restart while the file waits on the printer: what was sent is persisted and comes back", async t => {
  const L = library(t), s = server(t), m = L.model();
  await sendLater(s, deferred(s.src, m, { plate: 2 }));
  s.env.saveQueuedFiles();
  s.env.queuedFile.clear();
  s.env.loadQueuedFiles();   // the restart
  const back = s.env.queuedFile.get("ad5x");
  assert.equal(back.plate, 2);
  assert.equal(back.send.library.variantKey, SHA);
  assert.equal(back.size, 10);
  const e = await startFromPrinter(s, "Beardie (5h41m).gcode");
  assert.equal(e.library.plate, 2, "the plate that was sent is the plate started");
});

// A restart while the send is still WAITING for the printer: nothing uploaded
// yet, so all it has is its saved record. `tamper` edits that record on disk
// before the restart.
async function restartWhileWaiting(t, { tamper } = {}) {
  const L = library(t), s = server(t), m = L.model();
  s.h.idle = false;
  const rec = await sendLater(s, deferred(s.src, m, { plate: 2 }));
  assert.equal(s.h.uploads.length, 0, "busy: nothing uploaded");
  assert.equal(s.h.state(rec.id), "queued");
  const st = fs.statSync(s.src);
  if (tamper) tamper(path.join(s.h.base, "data", "deferred-sends.json"));
  const after = server(t, { baseDir: s.h.base, storage: s.h.storage });
  fs.utimesSync(after.src, st.atime, st.mtime);   // server() wrote the same file again: as it was
  after.env.deferredStartup();
  return { L, s: after, m, rec };
}

test("a restart while the send waits for the printer: it stays waiting, then the Print is exact, on the right Model and plate", async t => {
  const { L, s, m, rec } = await restartWhileWaiting(t);
  assert.equal(s.h.state(rec.id), "queued");
  assert.equal(s.h.store.get(rec.id).send.library.model, m.uuid);
  s.h.idle = false;
  await s.h.pump();
  assert.equal(s.h.uploads.length, 0, "still busy: still nothing sent");
  s.h.idle = true;
  await s.h.pump();
  assert.equal(s.h.uploads.length, 1);
  const ready = s.env.queuedFile.get("ad5x");
  assert.equal(ready.status, "ready");
  assert.equal(ready.plate, 2);
  assert.equal(ready.send.library.model, m.uuid);
  const e = await startFromPrinter(s, "Beardie (5h41m).gcode");
  assert.equal(e.source, "library");
  assert.equal(e.library.plate, 2);
  const c = chain(L, { ...e, jobKey: "printfile:1" });
  assert.deepEqual([c.method, c.confidence, c.model, c.location], ["snapcon_variant", "exact", m.uuid, "gcode:AD5X/Beardie (5h41m).gcode"]);
});

test("a restart while the send waits, and the file changes before the printer is free: it is not sent", async t => {
  const { s, rec } = await restartWhileWaiting(t);
  s.hashes[s.src] = "other";
  fs.utimesSync(s.src, new Date(), new Date(Date.now() + 5000));
  await s.h.pump();
  assert.equal(s.h.uploads.length, 0);
  assert.equal(s.h.storage.size, 0, "nothing on the printer");
  assert.equal(s.env.queuedFile.get("ad5x"), undefined, "not Loaded");
  assert.equal(s.h.state(rec.id), "failed");
});

// Without this, the first test could pass on something other than the saved
// record: take the link out of the record and the same flow is no Library print.
test("a restart while the send waits, with its Library link gone from the saved record: the Print is not a Library print", async t => {
  const { s } = await restartWhileWaiting(t, { tamper: file => {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const records = Object.values(j).find(Array.isArray);
    assert.equal(records.length, 1);
    delete records[0].send;
    fs.writeFileSync(file, JSON.stringify(j));
  } });
  await s.h.pump();
  assert.equal(s.env.queuedFile.get("ad5x").send, null);
  const e = await startFromPrinter(s, "Beardie (5h41m).gcode");
  assert.notEqual(e.source, "library");
  assert.equal(e.library, null);
});

test("the source file gone after it reached the printer: the Print is still exact", async t => {
  const L = library(t), s = server(t), m = L.model();
  await sendLater(s, deferred(s.src, m));
  fs.rmSync(s.src);
  const c = chain(L, { ...(await startFromPrinter(s, "Beardie (5h41m).gcode")), jobKey: "printfile:2" });
  assert.equal(c.confidence, "exact");
});

// Before §37 P5 a changed copy was started and linked by name; the owner's
// decision (2026-10-28) is to refuse it.
test("a file of the same name that is not SnapCon's copy is not started from the Loaded file: changed", async t => {
  const L = library(t), s = server(t), m = L.model();
  await sendLater(s, deferred(s.src, m));
  s.replaceOnPrinter(Buffer.alloc(999));   // replaced on the printer by someone else
  // What the route acts on (it refuses anything but present: test/stagedFileCheck.test.js).
  const check = await s.env.checkStagedCopy(s.printer, s.connector, s.env.queuedFile.get("ad5x"));
  assert.equal(check.state, "changed");
  // and another printer file of a different name never borrows the identity
  const L2 = library(t), s2 = server(t);
  await sendLater(s2, deferred(s2.src, L2.model()));
  assert.equal((await startFromPrinter(s2, "Other.gcode")).library, null);
});

// Before §37 P5 a printer that could not be asked kept SnapCon's record and
// started; the owner's decision (2026-10-28) is to refuse until it is checked.
test("a printer whose files cannot be read does not start the Loaded file: unable to verify", async t => {
  const L = library(t), s = server(t), m = L.model();
  await sendLater(s, deferred(s.src, m));
  s.h.verify = { result: "unverifiable", evidence: "the printer's file list could not be read" };
  assert.equal((await s.env.checkStagedCopy(s.printer, s.connector, s.env.queuedFile.get("ad5x"))).state, "unverifiable");
});

test("a Loaded file found by name only (no size recorded) keeps its Library link and says its copy was not checked", async t => {
  const L = library(t), s = server(t), m = L.model();
  await sendLater(s, deferred(s.src, m));
  s.env.queuedFile.get("ad5x").size = null;   // as an entry from before sizes were recorded
  const e = await startFromPrinter(s, "Beardie (5h41m).gcode");
  assert.equal(e.library.copyChecked, false);
  assert.equal(chain(L, { ...e, jobKey: "printfile:3" }).evidence.printerCopyChecked, false);
});

// Since §37 P3 the content is fixed when the send is accepted (its sha256):
// already changed, it is refused then; changed while it waits, it fails then.
test("the Variant changed before the deferred upload: it is not sent as that Variant", async t => {
  const L = library(t), m = L.model();
  const s = server(t);
  s.hashes[s.src] = "b".repeat(64);
  await assert.rejects(s.env.acceptDeferredSend(s.printer, deferred(s.src, m)), e => e.status === 409 && /changed since it was chosen in the Library/.test(e.message));
  assert.equal(s.h.store.list().length, 0, "nothing queued");
  const s2 = server(t);
  const rec = await s2.env.acceptDeferredSend(s2.printer, deferred(s2.src, m));
  s2.hashes[s2.src] = "c".repeat(64);
  await s2.h.pump();
  assert.equal(s2.h.state(rec.id), "failed");
  assert.equal(s2.h.store.get(rec.id).code, "DEFERRED_SOURCE_CHANGED");
  assert.equal(s2.h.uploads.length, 0, "nothing reached the printer");
});

test("a Model renamed or merged while the send waits: the Print still lands on the Model that holds the Variant", async t => {
  const L = library(t), s = server(t), m = L.model();
  await sendLater(s, deferred(s.src, m));
  actions.apply(L.db, { kind: "rename", model: m.uuid, name: "Bearded Dragon" }, { actor: {}, now: 2000 }); L.group();
  const c = chain(L, { ...(await startFromPrinter(s, "Beardie (5h41m).gcode")), jobKey: "printfile:4" });
  assert.equal(c.model, m.uuid);
  assert.equal(L.db.prepare("SELECT name FROM models WHERE uuid = ?").get(m.uuid).name, "Bearded Dragon");
});

test("a Model merged while the send waits: the Print lands on the survivor, and says which Model it was sent as", async t => {
  const L = library(t), s = server(t), m = L.model();
  const id = Number(L.db.prepare(`INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, sha256, content_key, first_seen, last_seen)
    VALUES ('gcode', 'Lizards/Bearded Dragon.gcode', 'Bearded Dragon.gcode', 'gcode', 'sliced', 20, 1, 'fp2', ?, ?, 1, 1)`).run("c".repeat(64), "c".repeat(64)).lastInsertRowid);
  L.db.prepare("INSERT INTO file_objects (file_id, name_norm, raw_name, origin) VALUES (?, 'lizard.stl', 'Lizard.stl', 'exclude_object')").run(id);
  L.db.prepare("INSERT INTO variants (file_id, plate_no, printer_family) VALUES (?, NULL, 'flashforge-ad5x')").run(id);
  L.group();
  const other = L.db.prepare("SELECT m.uuid FROM files f JOIN models m ON m.id = f.model_id WHERE f.rel_path = 'Lizards/Bearded Dragon.gcode'").get().uuid;
  assert.notEqual(other, m.uuid);
  await sendLater(s, deferred(s.src, m));
  actions.apply(L.db, { kind: "merge", from: m.uuid, into: other }, { actor: {}, now: 2000 }); L.group();
  const c = chain(L, { ...(await startFromPrinter(s, "Beardie (5h41m).gcode")), jobKey: "printfile:5" });
  assert.equal(c.model, other, "shown under the survivor");
  assert.equal(c.confidence, "exact");
  assert.equal(L.db.prepare("SELECT model_uuid_at_link FROM prints WHERE job_key = 'printfile:5'").get().model_uuid_at_link, m.uuid, "sent as the Model since merged");
});

test("the fleet row shows the staged file, never what was sent", () => {
  assert.match(serverSrc, /if \(qf\) row\.queuedFile = \{ name: qf\.name, status: stagedRowStatus\(qf\), ts: qf\.ts,/);
  // and a waiting send never shows its source path or bytes
  assert.doesNotMatch(serverSrc.slice(serverSrc.indexOf("const deferredRow = "), serverSrc.indexOf("\n", serverSrc.indexOf("const deferredRow = "))), /source|bytes|path/);
});

// §37 P2: a deferred file is read back before it is shown as ready to print.
test("P2: a deferred upload the printer does not then list is not confirmed (needs attention), not ready; other content failed; both audited", async t => {
  const L = library(t), m = L.model();
  for (const [verify, unknown] of [[{ result: "absent", evidence: "x" }, true], [{ result: "unverifiable", evidence: "x" }, true], [{ result: "mismatch", evidence: "x" }, false]]) {
    const s = server(t);
    s.h.verify = verify;
    const rec = await sendLater(s, deferred(s.src, m));
    assert.equal(s.env.queuedFile.get("ad5x"), undefined, verify.result + ": not Loaded");
    assert.equal(s.h.state(rec.id), unknown ? "attention" : "failed", verify.result);
    if (unknown) assert.equal(s.h.store.get(rec.id).reason, "unknown-after-upload");
    assert.equal(s.audits[s.audits.length - 1].event, unknown ? "upload-unconfirmed" : "upload-failed", verify.result);
  }
});

test("P2: a deferred upload that checks out is ready, with what the check found", async t => {
  const L = library(t), s = server(t), m = L.model();
  s.h.verify = { result: "acknowledged", evidence: "x" };
  await sendLater(s, deferred(s.src, m));
  const ready = s.env.queuedFile.get("ad5x");
  assert.equal(ready.status, "ready");
  assert.equal(ready.verification, "acknowledged");
  assert.equal(s.audits.find(a => a.event === "file-uploaded").detail.verification, "acknowledged");
});

test("P5: a deferred send is staged with the size it was sent at, not the local file's size afterwards", async t => {
  const L = library(t), s = server(t), m = L.model();
  s.h.verify = { result: "verified", basis: "content", evidence: "x" };
  await sendLater(s, deferred(s.src, m));
  fs.appendFileSync(s.src, "changed after the send\n");
  assert.equal(s.env.queuedFile.get("ad5x").size, 10, "the 10 bytes that went out");
});

test("A4: a deferred send whose file changes before its read-back ends is never Loaded", async t => {
  const L = library(t), s = server(t), m = L.model();
  s.h.verify = () => { fs.appendFileSync(s.src, "changed during the read-back\n"); return { result: "verified", basis: "content", evidence: "x" }; };
  await sendLater(s, deferred(s.src, m));
  assert.equal(s.env.queuedFile.get("ad5x"), undefined, "not Loaded");
});
