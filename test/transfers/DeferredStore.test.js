// test/transfers/DeferredStore.test.js — the store behind sends waiting for a
// busy printer (docs/TODO.md §37 P3).
//
// Before: they lived in memory only (pendingLoad), one per printer, replaced
// silently by the next, gone after a restart, keyed by the printer's place in
// the list; bytes pushed from a slicer were deleted at startup.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDeferredStore, LIMITS } = require("../../transfers/DeferredStore");

function tmp(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-deferred-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}
const quiet = t => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; t.after(() => { console.warn = w; console.error = e; }); };
const rec = (o = {}) => ({ printerId: "pA", printerName: "U1 A", name: "Part.gcode", source: { kind: "folder", path: "/g/Part.gcode", size: 10, sha256: "a".repeat(64) }, ...o });
// An fs whose next matching call fails, then behaves.
function failingFs(match) {
  let armed = false;
  return {
    fsImpl: new Proxy(fs, { get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      return (...a) => { if (armed && match(prop, a)) { armed = false; throw Object.assign(new Error("disk said no"), { code: "EIO" }); } return v.apply(target, a); };
    } }),
    arm: () => { armed = true; },
  };
}

// ---- records ----

test("nothing saved yet is an empty store, not an error; what is added survives a restart in order", t => {
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base });
  assert.equal(s.load().loadStatus, "missing");
  const a = s.add(rec({ name: "A.gcode" }));
  const b = s.add(rec({ name: "B.gcode" }));
  const c = s.add(rec({ name: "C.gcode", printerId: "pB" }));
  assert.ok(a.seq < b.seq && b.seq < c.seq);
  assert.equal(a.state, "queued");
  const again = createDeferredStore({ baseDir: base });
  assert.equal(again.load().loadStatus, "ok");
  assert.deepEqual(again.list({ printerId: "pA" }).map(r => r.name), ["A.gcode", "B.gcode"], "first in, first out, per printer id");
  const d = again.add(rec({ name: "D.gcode" }));
  assert.ok(d.seq > c.seq, "order continues after a restart");
});

test("a send that cannot be saved is not accepted: add throws and nothing changes", t => {
  const base = tmp(t);
  const f = failingFs((prop, a) => prop === "renameSync" && String(a[1]).endsWith("deferred-sends.json"));
  const s = createDeferredStore({ baseDir: base, fsImpl: f.fsImpl });
  s.load();
  s.add(rec({ name: "A.gcode" }));
  f.arm();
  quiet(t);
  assert.throws(() => s.add(rec({ name: "B.gcode" })), e => e.code === "DEFERRED_SAVE_FAILED" && e.status === 503);
  assert.deepEqual(s.list().map(r => r.name), ["A.gcode"]);
  assert.equal(s.status().degraded, true);
});

test("a change applies only from the states named; repeated or racing actions change nothing", t => {
  const s = createDeferredStore({ baseDir: tmp(t) }); s.load();
  const r = s.add(rec());
  assert.equal(s.transition(r.id, ["queued"], { state: "uploading", attempt: { id: "a1", startedAt: 1 } }).ok, true);
  const again = s.transition(r.id, ["queued"], { state: "uploading" });
  assert.deepEqual([again.ok, again.reason, again.state], [false, "state", "uploading"]);
  assert.equal(s.remove(r.id, ["queued"]).ok, false, "a cancel of a send already uploading does not remove it");
  assert.equal(s.transition("nope", ["queued"], { state: "failed" }).reason, "missing");
});

test("a final state that could not be written leaves the last saved one: after a restart it is still 'uploading' (reconciled, never resent)", t => {
  const base = tmp(t);
  const f = failingFs((prop, a) => prop === "renameSync" && String(a[1]).endsWith("deferred-sends.json"));
  const s = createDeferredStore({ baseDir: base, fsImpl: f.fsImpl }); s.load();
  const r = s.add(rec());
  s.transition(r.id, ["queued"], { state: "uploading", attempt: { id: "a1", startedAt: 1 } });
  f.arm();
  quiet(t);
  const done = s.transition(r.id, ["uploading"], { state: "completed" });
  assert.deepEqual([done.ok, done.reason], [false, "persist"]);
  assert.equal(s.get(r.id).state, "uploading", "memory follows the disk");
  const after = createDeferredStore({ baseDir: base }); after.load();
  assert.equal(after.get(r.id).state, "uploading");
  assert.equal(after.get(r.id).attempt.id, "a1", "with the attempt that was interrupted");
});

test("a leftover temporary file from a crash during a save is ignored and removed", t => {
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base }); s.load();
  s.add(rec({ name: "A.gcode" }));
  fs.writeFileSync(s.paths.PRIMARY + ".tmp", "{ half a fi");
  const again = createDeferredStore({ baseDir: base });
  assert.equal(again.load().loadStatus, "ok");
  assert.deepEqual(again.list().map(r => r.name), ["A.gcode"]);
  assert.equal(fs.existsSync(s.paths.PRIMARY + ".tmp"), false);
});

// ---- the backup, and stale backups (owner safeguard 3) ----

test("a corrupt file falls back to its backup, quarantined, and nothing in the backup is acted on by itself", t => {
  quiet(t);
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base }); s.load();
  const q = s.add(rec({ name: "Q.gcode" }));
  const u = s.add(rec({ name: "U.gcode" }));
  s.transition(u.id, ["queued"], { state: "uploading", attempt: { id: "a1", startedAt: 1 } });
  const f = s.add(rec({ name: "F.gcode" }));
  s.transition(f.id, ["queued"], { state: "failed", error: "x" });
  s.add(rec({ name: "Last.gcode" }));                               // the backup is the state before this
  fs.writeFileSync(s.paths.PRIMARY, "{ corrupt");
  const again = createDeferredStore({ baseDir: base });
  const st = again.load();
  assert.equal(st.loadStatus, "restored-from-backup");
  assert.equal(st.quarantined.length, 1);
  assert.ok(fs.existsSync(st.quarantined[0]), "the unreadable file is kept, renamed");
  assert.deepEqual(again.list().map(r => [r.name, r.state, r.reason || null]), [
    ["Q.gcode", "attention", "restored-from-backup"],
    ["U.gcode", "attention", "restored-from-backup"],
    ["F.gcode", "failed", null],
  ]);
  assert.deepEqual(again.list({ states: ["queued", "uploading"] }), [], "nothing queued to send by itself");
  // The restored state is the saved one: another restart sees the same.
  const third = createDeferredStore({ baseDir: base });
  assert.equal(third.load().loadStatus, "ok");
  assert.equal(third.get(q.id).state, "attention");
});

test("a stale backup does not bring back a send that was finished, as something to send", t => {
  quiet(t);
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base }); s.load();
  const r = s.add(rec());
  s.transition(r.id, ["queued"], { state: "uploading", attempt: { id: "a1", startedAt: 1 } });
  s.transition(r.id, ["uploading"], { state: "completed" });
  s.remove(r.id, ["completed"]);                                    // finished and removed; the backup still has it "completed"
  s.add(rec({ name: "Other.gcode" }));                              // the backup now holds the state where it was removed... one save later
  // Corrupt the primary and put an older backup back, as from before the finish.
  fs.writeFileSync(s.paths.PRIMARY, "{ corrupt");
  fs.writeFileSync(s.paths.BAK, JSON.stringify({ format: 1, nextSeq: 2, records: [{ ...r, state: "uploading", attempt: { id: "a1", startedAt: 1 } }] }));
  const again = createDeferredStore({ baseDir: base });
  again.load();
  assert.equal(again.get(r.id).state, "attention", "comes back for a person, not as an upload to resume");
  assert.equal(again.get(r.id).reason, "restored-from-backup");
});

test("both files unreadable: an empty store, both quarantined, new sends refused until an admin acknowledges", t => {
  quiet(t);
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base }); s.load();
  s.add(rec()); s.add(rec({ name: "B.gcode" }));
  fs.writeFileSync(s.paths.PRIMARY, "x"); fs.writeFileSync(s.paths.BAK, "y");
  const again = createDeferredStore({ baseDir: base });
  const st = again.load();
  assert.equal(st.loadStatus, "unreadable");
  assert.equal(st.recoveryRequired, true);
  assert.equal(st.quarantined.length, 2);
  assert.throws(() => again.add(rec({ name: "C.gcode" })), e => e.code === "DEFERRED_RECOVERY_REQUIRED");
  assert.equal(again.acknowledgeRecovery().ok, true);
  assert.equal(again.add(rec({ name: "C.gcode" })).state, "queued");
});

test("an open send holds its destination: the same name on the same printer is a duplicate until it is finished", t => {
  const s = createDeferredStore({ baseDir: tmp(t) }); s.load();
  const r = s.add(rec());
  for (const state of ["uploading", "interrupted", "attention", "completed"]) {
    s.transition(r.id, ["queued", "uploading", "interrupted", "attention", "completed"], { state });
    assert.ok(s.openDuplicate("pA", "Part.gcode"), state);
  }
  assert.equal(s.openDuplicate("pB", "Part.gcode"), null, "another printer");
  assert.equal(s.openDuplicate("pA", "Other.gcode"), null);
  s.transition(r.id, ["completed"], { state: "failed" });
  assert.equal(s.openDuplicate("pA", "Part.gcode"), null, "a failed send no longer holds it");
});

// ---- bytes pushed from a slicer ----

test("pushed bytes are written whole under the send's id, with their hash, before any record exists", async t => {
  const s = createDeferredStore({ baseDir: tmp(t), freeBytes: () => 1e12 }); s.load();
  const out = await s.storeBytes("dsend_x", Buffer.from("G1 X1\n"));
  assert.equal(fs.readFileSync(out.file, "utf8"), "G1 X1\n");
  assert.equal(out.size, 6);
  assert.equal(out.sha256, require("crypto").createHash("sha256").update("G1 X1\n").digest("hex"));
  assert.deepEqual(fs.readdirSync(s.paths.INCOMING), [], "no partial file left");
});

test("the limits refuse before anything is written: per file (512 MB by default, 2 GB at most), in total, and free disk space", async t => {
  assert.equal(LIMITS.maxFileBytes, 512 * 1024 * 1024);
  assert.equal(LIMITS.maxTotalBytes, 4 * 1024 * 1024 * 1024);
  assert.equal(LIMITS.freeMarginBytes, 256 * 1024 * 1024);
  let free = 1e12;
  const s = createDeferredStore({ baseDir: tmp(t), freeBytes: () => free }); s.load();
  await assert.rejects(s.storeBytes("dsend_a", Buffer.alloc(11), { maxFileBytes: 10 }), e => e.code === "DEFERRED_FILE_TOO_LARGE" && e.status === 413);
  await assert.rejects(s.storeBytes("dsend_a", Buffer.alloc(11), { maxFileBytes: 1e12, maxFileBytesCeiling: 10 }), e => e.code === "DEFERRED_FILE_TOO_LARGE", "the ceiling wins over a larger setting");
  await s.storeBytes("dsend_b", Buffer.alloc(8), { maxTotalBytes: 20 });
  await assert.rejects(s.storeBytes("dsend_c", Buffer.alloc(13), { maxTotalBytes: 20 }), e => e.code === "DEFERRED_STORE_FULL");
  free = 100;
  await assert.rejects(s.storeBytes("dsend_d", Buffer.alloc(10), { freeMarginBytes: 95 }), e => e.code === "DEFERRED_DISK_FULL" && e.status === 507);
  assert.deepEqual(fs.readdirSync(s.paths.FILES).filter(n => n !== ".incoming"), ["dsend_b"], "nothing written by a refusal");
});

test("a write that fails part-way (disk full) leaves no partial file and says so", async t => {
  const base = tmp(t);
  const f = failingFs((prop) => prop === "write");
  const s = createDeferredStore({ baseDir: base, fsImpl: f.fsImpl, freeBytes: () => 1e12 }); s.load();
  fs.mkdirSync(s.paths.INCOMING, { recursive: true });
  f.arm();
  const fsWrite = f.fsImpl; void fsWrite;
  await assert.rejects(s.storeBytes("dsend_x", Buffer.alloc(100)));
  assert.deepEqual(fs.readdirSync(s.paths.INCOMING), []);
  assert.equal(fs.existsSync(s.bytesPath("dsend_x")), false);
});

test("cleanup after a clean load removes partial files, sets complete files no record refers to aside (never deletes them), and keeps the rest", async t => {
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base, freeBytes: () => 1e12 }); s.load();
  const kept = await s.storeBytes("dsend_keep", Buffer.from("a"));
  s.add(rec({ id: "dsend_keep", bytes: { size: 1, sha256: kept.sha256 } }));
  await s.storeBytes("dsend_orphan", Buffer.from("b"));                    // a crash before its record was written
  fs.writeFileSync(path.join(s.paths.INCOMING, "dsend_half.part"), "c");
  const again = createDeferredStore({ baseDir: base }); again.load();
  const out = again.cleanupOrphans();
  assert.deepEqual(out.removed, [".incoming/dsend_half.part"], "only the partial write, which was never acknowledged");
  assert.deepEqual(out.setAside, ["dsend_orphan"]);
  assert.ok(fs.existsSync(require("path").join(again.paths.ORPHANED, "dsend_orphan")), "moved, not deleted");
  assert.deepEqual(again.listOrphaned(), [{ name: "dsend_orphan", size: 1 }]);
  assert.ok(fs.existsSync(again.bytesPath("dsend_keep")));
  assert.equal(again.storedBytesTotal(), 2, "set-aside files still count against the total");
  assert.deepEqual(again.deleteOrphaned().map(f => f.name), ["dsend_orphan"], "deleted only when asked");
  assert.deepEqual(again.listOrphaned(), []);
});

test("after a load from the backup, or with nothing readable, no stored bytes are removed", async t => {
  quiet(t);
  for (const corruptBak of [false, true]) {
    const base = tmp(t);
    const s = createDeferredStore({ baseDir: base, freeBytes: () => 1e12 }); s.load();
    s.add(rec({ name: "A.gcode" })); s.add(rec({ name: "B.gcode" }));
    await s.storeBytes("dsend_maybe", Buffer.from("z"));
    fs.writeFileSync(s.paths.PRIMARY, "{");
    if (corruptBak) fs.writeFileSync(s.paths.BAK, "{");
    const again = createDeferredStore({ baseDir: base }); again.load();
    assert.ok(again.cleanupOrphans().skipped);
    assert.ok(fs.existsSync(again.bytesPath("dsend_maybe")), "may be all that is left of an acknowledged send");
  }
});

// ---- from the persistence review (2026-10-28) ----
const shortWriteFs = (limit) => new Proxy(fs, { get(target, prop) {
  const v = target[prop];
  if (prop === "write") return (fd, buf, off, len, pos, cb) => limit === 0 ? cb(null, 0) : v.call(target, fd, buf, off, Math.min(len, limit), pos, cb);
  return typeof v === "function" ? v.bind(target) : v;
} });

test("both unreadable stays held across a restart: still refusing, and no stored bytes removed, until an admin acknowledges", async t => {
  quiet(t);
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base, freeBytes: () => 1e12 }); s.load();
  s.add(rec()); s.add(rec({ name: "B.gcode" }));
  await s.storeBytes("dsend_maybe", Buffer.from("z"));
  fs.writeFileSync(s.paths.PRIMARY, "x"); fs.writeFileSync(s.paths.BAK, "y");
  createDeferredStore({ baseDir: base }).load();
  const again = createDeferredStore({ baseDir: base });
  const st = again.load();
  assert.equal(st.recoveryRequired, true, "the second start is still held, not a first run");
  assert.equal(st.hold.reason, "unreadable");
  assert.throws(() => again.add(rec({ name: "C.gcode" })), e => e.code === "DEFERRED_RECOVERY_REQUIRED");
  assert.ok(again.cleanupOrphans().skipped);
  assert.ok(fs.existsSync(again.bytesPath("dsend_maybe")));
  assert.equal(again.acknowledgeRecovery().ok, true);
  const third = createDeferredStore({ baseDir: base });
  assert.equal(third.load().recoveryRequired, false, "acknowledged for good");
});

test("after a restore from backup, stored bytes are kept on every later start until an admin acknowledges", async t => {
  quiet(t);
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base, freeBytes: () => 1e12 }); s.load();
  s.add(rec({ name: "A.gcode" }));
  await s.storeBytes("dsend_late", Buffer.from("added after the backup"));
  s.add(rec({ id: "dsend_late", name: "Late.gcode", bytes: { size: 1, sha256: "x" } }));
  fs.writeFileSync(s.paths.PRIMARY, "{");
  createDeferredStore({ baseDir: base }).load();               // restores from the backup
  const second = createDeferredStore({ baseDir: base });
  assert.equal(second.load().hold.reason, "restored-from-backup");
  assert.ok(second.cleanupOrphans().skipped);
  assert.ok(fs.existsSync(second.bytesPath("dsend_late")), "the send added after the backup keeps its bytes");
  const attentionBefore = second.list().map(r => [r.id, r.state]);
  second.acknowledgeRecovery();
  assert.deepEqual(second.list().map(r => [r.id, r.state]), attentionBefore, "acknowledging reactivates nothing");
  const third = createDeferredStore({ baseDir: base }); third.load();
  const out = third.cleanupOrphans();
  assert.deepEqual([out.removed, out.setAside], [[], ["dsend_late"]], "after acknowledging: set aside, still not deleted");
  assert.ok(fs.existsSync(require("path").join(third.paths.ORPHANED, "dsend_late")));
});

test("a completed send in a backup is not applied again: it needs attention like the rest", t => {
  quiet(t);
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base }); s.load();
  const r = s.add(rec());
  s.transition(r.id, ["queued"], { state: "uploading", attempt: { id: "a", startedAt: 1 } });
  s.transition(r.id, ["uploading"], { state: "completed", completion: { verification: "verified", verifiedAt: 2, size: 10 } });
  s.add(rec({ name: "Next.gcode" }));                           // the backup now holds "completed"
  fs.writeFileSync(s.paths.PRIMARY, "{");
  const again = createDeferredStore({ baseDir: base }); again.load();
  assert.equal(again.get(r.id).state, "attention");
  assert.equal(again.get(r.id).reason, "restored-from-backup");
});

test("a write the disk cuts short is never taken for a whole one", async t => {
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base, freeBytes: () => 1e12, fsImpl: shortWriteFs(1000) }); s.load();
  const out = await s.storeBytes("dsend_long", Buffer.alloc(5000, 7));
  assert.equal(fs.statSync(out.file).size, 5000, "every byte written, across several short writes");
  const zero = createDeferredStore({ baseDir: base, freeBytes: () => 1e12, fsImpl: shortWriteFs(0) }); zero.load();
  await assert.rejects(zero.storeBytes("dsend_none", Buffer.alloc(10)), e => e.status === 507);
  assert.equal(fs.existsSync(zero.bytesPath("dsend_none")), false);
  assert.deepEqual(fs.readdirSync(zero.paths.INCOMING), []);
});

test("a corrupt list that cannot be moved aside is not copied over its good backup", t => {
  quiet(t);
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base }); s.load();
  s.add(rec({ name: "A.gcode" })); s.add(rec({ name: "B.gcode" }));
  const goodBak = fs.readFileSync(s.paths.BAK, "utf8");
  fs.writeFileSync(s.paths.PRIMARY, "{ corrupt");
  const locked = new Proxy(fs, { get(target, prop) {
    const v = target[prop];
    if (prop === "renameSync") return (a, b) => { if (String(a).endsWith("deferred-sends.json")) throw Object.assign(new Error("locked"), { code: "EPERM" }); return v.call(target, a, b); };
    return typeof v === "function" ? v.bind(target) : v;
  } });
  const again = createDeferredStore({ baseDir: base, fsImpl: locked, retry: { delays: [], sleep: () => {} } });
  const st = again.load();
  assert.equal(st.loadStatus, "restored-from-backup");
  assert.equal(st.degraded, true, "not saved");
  assert.equal(fs.readFileSync(s.paths.BAK, "utf8"), goodBak, "the good backup is untouched");
});

test("a list that cannot be read for now (locked, busy) is not treated as corrupt: nothing is moved, overwritten or accepted until a restart can read it", t => {
  quiet(t);
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base }); s.load();
  s.add(rec({ name: "A.gcode" }));
  const before = fs.readFileSync(s.paths.PRIMARY, "utf8");
  const busy = new Proxy(fs, { get(target, prop) {
    const v = target[prop];
    if (prop === "readFileSync") return (f, ...a) => { if (String(f).endsWith("deferred-sends.json")) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return v.call(target, f, ...a); };
    return typeof v === "function" ? v.bind(target) : v;
  } });
  const again = createDeferredStore({ baseDir: base, fsImpl: busy, retry: { delays: [1, 1], sleep: () => {} } });
  const st = again.load();
  assert.deepEqual([st.loadStatus, st.readOnly, st.recoveryRequired], ["read-error", true, true]);
  assert.throws(() => again.add(rec({ name: "B.gcode" })), e => e.code === "DEFERRED_RECOVERY_REQUIRED");
  assert.equal(again.acknowledgeRecovery().ok, false, "nothing safe to write over it");
  assert.ok(again.cleanupOrphans().skipped);
  assert.equal(fs.readFileSync(s.paths.PRIMARY, "utf8"), before);
  assert.deepEqual(fs.readdirSync(path.dirname(s.paths.PRIMARY)).filter(n => n.includes("corrupt")), []);
});

test("a held file open for a moment is retried, as QueueStore does, instead of failing the save", t => {
  const base = tmp(t);
  let fails = 2;
  const flaky = new Proxy(fs, { get(target, prop) {
    const v = target[prop];
    if (prop === "renameSync") return (a, b) => { if (fails > 0 && String(b).endsWith("deferred-sends.json")) { fails--; throw Object.assign(new Error("held"), { code: "EPERM" }); } return v.call(target, a, b); };
    return typeof v === "function" ? v.bind(target) : v;
  } });
  const s = createDeferredStore({ baseDir: base, fsImpl: flaky, retry: { delays: [1, 1, 1], sleep: () => {} } }); s.load();
  assert.equal(s.add(rec()).state, "queued");
  assert.equal(fails, 0);
});

test("records that cannot be understood (an unknown state, no source, a path-like id) are set aside and reported, their bytes kept", async t => {
  quiet(t);
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base, freeBytes: () => 1e12 }); s.load();
  const good = s.add(rec());
  await s.storeBytes("dsend_future", Buffer.from("z"));
  const j = JSON.parse(fs.readFileSync(s.paths.PRIMARY, "utf8"));
  j.records.push({ ...j.records[0], id: "dsend_future", state: "teleported", seq: 50 }, { ...j.records[0], id: "../../config.json", seq: 51 }, { ...j.records[0], id: "dsend_nosrc", source: undefined, seq: 52 });
  fs.writeFileSync(s.paths.PRIMARY, JSON.stringify(j));
  const again = createDeferredStore({ baseDir: base });
  const st = again.load();
  assert.equal(st.dropped, 3);
  assert.equal(st.hold.reason, "records-set-aside");
  assert.deepEqual(again.list().map(r => r.id), [good.id]);
  assert.ok(st.quarantined.some(f => f.includes("set-aside")));
  assert.ok(again.cleanupOrphans().skipped);
  assert.ok(fs.existsSync(again.bytesPath("dsend_future")));
  assert.throws(() => again.bytesPath("../../config.json"));
});

test("a list written by a newer SnapCon is not read as this one's: nothing written over it, nothing accepted", t => {
  quiet(t);
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base }); s.load();
  s.add(rec());
  const j = JSON.parse(fs.readFileSync(s.paths.PRIMARY, "utf8")); j.format = 2;
  fs.writeFileSync(s.paths.PRIMARY, JSON.stringify(j));
  const again = createDeferredStore({ baseDir: base });
  const st = again.load();
  assert.deepEqual([st.loadStatus, st.readOnly], ["newer-format", true]);
  assert.throws(() => again.add(rec({ name: "B.gcode" })));
  assert.equal(JSON.parse(fs.readFileSync(s.paths.PRIMARY, "utf8")).format, 2);
});

test("the primary gone with its backup still there is a restore, not a first run", t => {
  quiet(t);
  const base = tmp(t);
  const s = createDeferredStore({ baseDir: base }); s.load();
  s.add(rec({ name: "A.gcode" })); s.add(rec({ name: "B.gcode" }));
  fs.rmSync(s.paths.PRIMARY);
  const again = createDeferredStore({ baseDir: base });
  assert.equal(again.load().loadStatus, "restored-from-backup");
  assert.deepEqual(again.list().map(r => r.state), ["attention"]);
});

test("storing a large push does not hold the event loop: other work runs while it is written", async t => {
  const s = createDeferredStore({ baseDir: tmp(t), freeBytes: () => 1e12 }); s.load();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  await s.storeBytes("dsend_big", Buffer.alloc(64 * 1024 * 1024, 3));
  clearInterval(timer);
  assert.ok(ticks > 0, "timers ran during the write");
});

test("two pushes at once cannot both pass the total: the space is reserved when each is accepted", async t => {
  const s2 = createDeferredStore({ baseDir: tmp(t), freeBytes: () => 1e12 }); s2.load();
  const both = await Promise.allSettled([s2.storeBytes("dsend_one", Buffer.alloc(15), { maxTotalBytes: 20 }), s2.storeBytes("dsend_two", Buffer.alloc(15), { maxTotalBytes: 20 })]);
  assert.deepEqual(both.map(r => r.status).sort(), ["fulfilled", "rejected"]);
});
