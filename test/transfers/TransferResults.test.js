// test/transfers/TransferResults.test.js — the final outcome of each transfer,
// kept across restarts for the command line's --wait (docs/TODO.md §37 P4).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createTransferResults, RESULT_LIMITS } = require("../../transfers/TransferResults");

function tmp(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-results-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}
const quiet = t => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; t.after(() => { console.warn = w; console.error = e; }); };
const open = (base, o = {}) => { const s = createTransferResults({ baseDir: base, ...o }); s.load(); return s; };
const ok = (id, o = {}) => ({ id, printerId: "pA", state: "verified", basis: "content", at: Date.now(), ...o });
// An fs whose matching calls fail while armed.
function failingFs(match, code = "EIO") {
  let armed = false;
  return {
    fsImpl: new Proxy(fs, { get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      return (...a) => { if (armed && match(prop, a)) throw Object.assign(new Error("disk said no"), { code }); return v.apply(target, a); };
    } }),
    arm: () => { armed = true; }, disarm: () => { armed = false; },
  };
}

test("nothing saved yet is empty, not an error; a result survives a restart with its basis, code and reason", t => {
  const base = tmp(t);
  const s = open(base);
  assert.equal(s.status().loadStatus, "missing");
  assert.ok(s.record(ok("dsend_a")).written);
  assert.ok(s.record({ id: "dsend_b", printerId: "pA", state: "failed", code: "UPLOAD_FAILED", message: "reset", at: Date.now() }).written);
  assert.ok(s.record({ id: "dsend_c", printerId: "pA", state: "unknown", reason: "unknown-after-upload", at: Date.now() }).written);
  const again = open(base);
  assert.equal(again.status().loadStatus, "ok");
  assert.equal(again.get("dsend_a").state, "verified");
  assert.equal(again.get("dsend_a").basis, "content");
  assert.equal(again.get("dsend_b").code, "UPLOAD_FAILED");
  assert.equal(again.get("dsend_c").reason, "unknown-after-upload");
  assert.equal(again.get("dsend_none"), null);
});

test("a final result is never overwritten: not by a repeat, a stale update, or a different ending", t => {
  const s = open(tmp(t));
  s.record(ok("dsend_a"));
  for (const late of [{ state: "failed", code: "X" }, { state: "unknown" }, { state: "acknowledged", basis: "size" }, { state: "cancelled" }]) {
    const r = s.record(ok("dsend_a", late), { reconcile: true });
    assert.ok(r.ok && r.kept, late.state);
    assert.equal(s.get("dsend_a").state, "verified");
  }
  s.record({ id: "dsend_f", printerId: "pA", state: "failed", at: Date.now() });
  assert.ok(s.record(ok("dsend_f"), { reconcile: true }).kept, "failed stays failed even with evidence");
  assert.equal(s.get("dsend_f").state, "failed");
});

test("unknown becomes verified or acknowledged only with new read-back evidence, and keeps what it was", t => {
  const base = tmp(t);
  const s = open(base);
  s.record({ id: "dsend_u", printerId: "pA", state: "unknown", reason: "unknown-after-upload", at: 1000 + Date.now() - 5000 });
  assert.ok(s.record(ok("dsend_u")).kept, "without evidence: unchanged");
  assert.ok(s.record({ id: "dsend_u", printerId: "pA", state: "failed", at: Date.now() }, { reconcile: true }).kept, "unknown never becomes failed");
  assert.equal(s.get("dsend_u").state, "unknown");
  const r = s.record(ok("dsend_u", { basis: "size", state: "acknowledged" }), { reconcile: true });
  assert.equal(r.reconciled, true);
  assert.equal(r.from, "unknown");
  const again = open(base).get("dsend_u");
  assert.equal(again.state, "acknowledged");
  assert.equal(again.reconciledFrom.state, "unknown");
  assert.equal(again.reconciledFrom.reason, "unknown-after-upload");
});

test("each attempt keeps its own result: a retry is another id, linked to the one before", t => {
  const s = open(tmp(t));
  s.record({ id: "dsend_1", printerId: "pA", state: "failed", code: "UPLOAD_FAILED", at: Date.now() });
  s.record(ok("dsend_2", { parentId: "dsend_1" }));
  assert.equal(s.get("dsend_1").state, "failed");
  assert.equal(s.get("dsend_2").parentId, "dsend_1");
});

test("results expire after the retention time, but never one still protected", t => {
  const base = tmp(t);
  let clock = Date.now();
  const protectedIds = new Set(["dsend_keep"]);
  const s = open(base, { now: () => clock, isProtected: id => protectedIds.has(id) });
  s.record(ok("dsend_old", { at: clock }));
  s.record({ id: "dsend_keep", printerId: "pA", state: "unknown", at: clock });
  clock += 25 * 3600 * 1000;
  assert.equal(s.get("dsend_old"), null, "expired: not answered");
  assert.equal(s.get("dsend_keep").state, "unknown", "an unresolved send's only status is kept");
  assert.equal(s.prune().removed, 1);
  const again = open(base, { now: () => clock, isProtected: id => protectedIds.has(id) });
  assert.equal(again.get("dsend_old"), null);
  assert.ok(again.get("dsend_keep"));
  // Configurable.
  const short = open(tmp(t), { now: () => clock });
  short.setLimits({ retentionHours: 1, maxCount: 1000 });
  short.record(ok("dsend_x", { at: clock - 2 * 3600 * 1000 }));
  assert.equal(short.get("dsend_x"), null);
});

test("at most maxCount results, the oldest going first; never a protected one, never the one being written", t => {
  const s = open(tmp(t), { isProtected: id => id === "dsend_0" });
  s.setLimits({ retentionHours: 24, maxCount: 100 });
  const t0 = Date.now() - 1000;
  for (let i = 0; i < 105; i++) s.record(ok("dsend_" + i, { at: t0 + i }));
  assert.equal(s.status().count, 100);
  assert.ok(s.get("dsend_0"), "protected");
  for (let i = 1; i <= 5; i++) assert.equal(s.get("dsend_" + i), null, "oldest go first");
  assert.ok(s.get("dsend_104"));
  assert.deepEqual([RESULT_LIMITS.retentionHours, RESULT_LIMITS.maxCount], [24, 1000], "the approved defaults");
});

test("a save that fails changes nothing: not in memory, not on disk, and it is reported", t => {
  quiet(t);
  const base = tmp(t);
  const f = failingFs(prop => prop === "writeSync" || prop === "openSync", "ENOSPC");
  const s = open(base, { fsImpl: f.fsImpl, retry: { delays: [] } });
  s.record(ok("dsend_a"));
  f.arm();
  const r = s.record(ok("dsend_b"));
  assert.deepEqual([r.ok, r.reason], [false, "persist"]);
  assert.equal(s.get("dsend_b"), null);
  assert.equal(s.status().degraded, true);
  f.disarm();
  assert.ok(open(base).get("dsend_a"));
  assert.equal(open(base).get("dsend_b"), null);
  assert.ok(s.record(ok("dsend_b")).written, "saved once the disk takes it");
  assert.equal(s.status().degraded, false);
});

test("a disk that takes fewer bytes than asked is a failed save, not a short file", t => {
  quiet(t);
  const base = tmp(t);
  let short = false;
  const fsImpl = new Proxy(fs, { get(target, prop) {
    if (prop === "writeSync") return (fd, buf, off, len) => short ? 0 : target.writeSync(fd, buf, off, len);
    const v = target[prop]; return typeof v === "function" ? v.bind(target) : v;
  } });
  const s = open(base, { fsImpl, retry: { delays: [] } });
  s.record(ok("dsend_a"));
  short = true;
  assert.equal(s.record(ok("dsend_b")).ok, false);
  assert.ok(open(base).get("dsend_a"), "the saved file is whole");
});

test("an interrupted write (a temporary file left) does not change the saved results", t => {
  const base = tmp(t);
  const s = open(base);
  s.record(ok("dsend_a"));
  fs.writeFileSync(s.paths.TMP, '{"format":1,"results":[{"id":"dsend_ghost","state":"verified","at":1}]}');
  const again = open(base);
  assert.ok(again.get("dsend_a"));
  assert.equal(again.get("dsend_ghost"), null, "a temporary file is never taken as the results");
  assert.equal(fs.existsSync(again.paths.TMP), false);
});

test("a corrupt file falls back to its backup, which may only lack the newest — a missing result is not known, never a success", t => {
  quiet(t);
  const base = tmp(t);
  const s = open(base);
  s.record(ok("dsend_a"));
  s.record(ok("dsend_b"));                                   // the backup holds dsend_a only
  fs.writeFileSync(s.paths.PRIMARY, "{ corrupt");
  let again = open(base);
  assert.equal(again.status().loadStatus, "restored-from-backup");
  assert.ok(again.get("dsend_a"));
  assert.equal(again.get("dsend_b"), null, "not in the backup: not known");
  // A reconcile lost with the primary: the backup's older, more cautious answer.
  const b2 = tmp(t);
  const s2 = open(b2);
  s2.record({ id: "dsend_u", printerId: "pA", state: "unknown", at: Date.now() });
  s2.record(ok("dsend_u"), { reconcile: true });             // the backup holds it as unknown
  fs.writeFileSync(s2.paths.PRIMARY, "{ corrupt");
  again = open(b2);
  assert.equal(again.get("dsend_u").state, "unknown", "never a success the backup did not hold");
  assert.ok(again.status().quarantined.some(f => f.includes(".corrupt-")), "the corrupt file is kept aside");
  // A stale backup cannot undo a later reconcile once the primary is good again.
  again.record(ok("dsend_u"), { reconcile: true });
  assert.equal(open(b2).get("dsend_u").state, "verified");
});

test("both files corrupt: no results known, both kept aside; a file it cannot read now, or from a newer SnapCon, is never written over", t => {
  quiet(t);
  const base = tmp(t);
  const s = open(base);
  s.record(ok("dsend_a")); s.record(ok("dsend_b"));
  fs.writeFileSync(s.paths.PRIMARY, "{ x"); fs.writeFileSync(s.paths.BAK, "{ y");
  const again = open(base);
  assert.equal(again.status().loadStatus, "unreadable");
  assert.equal(again.get("dsend_a"), null);
  assert.equal(again.status().quarantined.length, 2);

  const b2 = tmp(t);
  const s2 = open(b2); s2.record(ok("dsend_a"));
  const before = fs.readFileSync(s2.paths.PRIMARY, "utf8");
  const f = failingFs((prop, a) => prop === "readFileSync" && String(a[0]).endsWith("transfer-results.json"), "EACCES");
  f.arm();
  const ro = open(b2, { fsImpl: f.fsImpl, retry: { delays: [] } });
  assert.deepEqual([ro.status().loadStatus, ro.status().readOnly], ["read-error", true]);
  assert.equal(ro.record(ok("dsend_z")).ok, false);
  f.disarm();
  assert.equal(fs.readFileSync(s2.paths.PRIMARY, "utf8"), before);

  fs.writeFileSync(s2.paths.PRIMARY, JSON.stringify({ format: 99, results: [] }));
  const newer = open(b2);
  assert.deepEqual([newer.status().loadStatus, newer.record(ok("dsend_q")).ok], ["newer-format", false]);
  assert.match(fs.readFileSync(s2.paths.PRIMARY, "utf8"), /"format":99/);
});

test("entries it cannot understand are dropped on load; it holds no file path or content, only the outcome", t => {
  const base = tmp(t);
  fs.mkdirSync(path.join(base, "data"), { recursive: true });
  fs.writeFileSync(path.join(base, "data", "transfer-results.json"), JSON.stringify({ format: 1, results: [
    ok("dsend_a"), { id: "../etc", state: "verified", at: Date.now() }, { id: "dsend_b", state: "delivered-maybe", at: Date.now() }, { id: "dsend_c", state: "verified", basis: "guess", at: Date.now() },
  ] }));
  const s = open(base);
  assert.equal(s.status().count, 1);
  s.record({ ...ok("dsend_p"), path: "/secret/file.gcode", sha256: "x", name: "file.gcode" });
  // Paths inside an error message are left out too (P4 security review).
  s.record({ id: "dsend_m", printerId: "pA", state: "failed", at: Date.now(), message: "ENOENT: no such file or directory, stat '/mnt/secret/Files/a.gcode' and C:\\Users\\eran\\AppData\\x.gcode and \\\\nas\\share\\y.gcode (HTTP 500)" });
  const raw = fs.readFileSync(s.paths.PRIMARY, "utf8");
  assert.doesNotMatch(raw, /secret|sha256|file\.gcode|Users|AppData|nas|share/);
  assert.match(s.get("dsend_m").message, /^ENOENT: no such file or directory, stat '<path>' and <path> and <path> \(HTTP 500\)$/);
  assert.throws(() => s.record({ id: "dsend_q", state: "probably-fine", at: Date.now() }));
});

test("later attempts are found through their links, nearest first; the count ceiling is 10000", t => {
  const s = open(tmp(t));
  s.record({ id: "dsend_a", printerId: "pA", state: "failed", at: Date.now() - 3 });
  s.record({ id: "dsend_b", parentId: "dsend_a", printerId: "pA", state: "unknown", at: Date.now() - 2 });
  s.record({ id: "dsend_c", parentId: "dsend_b", printerId: "pA", state: "verified", basis: "content", at: Date.now() - 1 });
  s.record({ id: "dsend_x", printerId: "pA", state: "verified", at: Date.now() });
  assert.deepEqual(s.laterAttempts("dsend_a").map(e => e.id), ["dsend_b", "dsend_c"]);
  assert.deepEqual(s.laterAttempts("dsend_c"), []);
  assert.equal(RESULT_LIMITS.maxCountMax, 10000);
  assert.equal(RESULT_LIMITS.maxCount, 1000);
});
