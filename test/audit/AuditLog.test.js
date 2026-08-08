// test/audit/AuditLog.test.js — unit tests for audit/AuditLog.js: the
// node:sqlite-backed log()/query()/prune() round-trip. Each test opens a
// fresh AuditLog against a throwaway temp directory (mkdtempSync), so tests
// never share database state and never touch this repo's real audit-data/.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAuditLog } = require("../../audit/AuditLog");

function freshAuditLog() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-audit-test-"));
  return createAuditLog({ baseDir });
}

test("AuditLog: is available on this runtime (Node 22.5+ ships node:sqlite)", () => {
  const audit = freshAuditLog();
  assert.equal(audit.isAvailable(), true);
});

test("AuditLog: log() then query() round-trips every field, including a JSON detail blob", () => {
  const audit = freshAuditLog();
  audit.log({ category: "job", event: "print-started", userId: "u1", userLabel: "alice", printerId: "p1", printerName: "U1", detail: { file: "test.gcode" } });
  const { rows, total } = audit.query({});
  assert.equal(total, 1);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.category, "job");
  assert.equal(row.event, "print-started");
  assert.equal(row.userId, "u1");
  assert.equal(row.userLabel, "alice");
  assert.equal(row.printerId, "p1");
  assert.equal(row.printerName, "U1");
  assert.deepEqual(JSON.parse(row.detail), { file: "test.gcode" });
  assert.equal(typeof row.ts, "number");
});

test("AuditLog: log() accepts null userId/printerId (printer-observed events, no SnapCon user attributable)", () => {
  const audit = freshAuditLog();
  audit.log({ category: "job", event: "print-completed", printerId: "p1", printerName: "U1" });
  const { rows } = audit.query({});
  assert.equal(rows[0].userId, null);
  assert.equal(rows[0].userLabel, null);
  assert.equal(rows[0].detail, null);
});

test("AuditLog: query() rows come back newest-first", () => {
  const audit = freshAuditLog();
  audit.log({ category: "auth", event: "login", userId: "u1", userLabel: "first" });
  audit.log({ category: "auth", event: "login", userId: "u1", userLabel: "second" });
  const { rows } = audit.query({});
  assert.equal(rows[0].userLabel, "second");
  assert.equal(rows[1].userLabel, "first");
});

test("AuditLog: query() filters by category", () => {
  const audit = freshAuditLog();
  audit.log({ category: "auth", event: "login", userId: "u1", userLabel: "alice" });
  audit.log({ category: "job", event: "print-started", userId: "u1", userLabel: "alice", printerId: "p1" });
  const authOnly = audit.query({ category: "auth" });
  assert.equal(authOnly.total, 1);
  assert.equal(authOnly.rows[0].category, "auth");
});

test("AuditLog: query() free-text search (q) matches across user/printer/detail", () => {
  const audit = freshAuditLog();
  audit.log({ category: "job", event: "print-started", userId: "u1", userLabel: "alice", printerId: "p1", printerName: "Garage U1", detail: { file: "vase.gcode" } });
  audit.log({ category: "job", event: "print-started", userId: "u2", userLabel: "bob", printerId: "p2", printerName: "Office AD5X", detail: { file: "bracket.gcode" } });
  assert.equal(audit.query({ q: "Garage" }).total, 1);
  assert.equal(audit.query({ q: "bracket" }).total, 1);
  assert.equal(audit.query({ q: "nonexistent-thing" }).total, 0);
});

test("AuditLog: query() respects limit/offset for paging", () => {
  const audit = freshAuditLog();
  for (let i = 0; i < 5; i++) audit.log({ category: "auth", event: "login", userId: "u" + i, userLabel: "user" + i });
  const page1 = audit.query({ limit: 2, offset: 0 });
  const page2 = audit.query({ limit: 2, offset: 2 });
  assert.equal(page1.total, 5); // total reflects the whole filtered set, not just this page
  assert.equal(page1.rows.length, 2);
  assert.equal(page2.rows.length, 2);
  assert.notEqual(page1.rows[0].userLabel, page2.rows[0].userLabel);
});

test("AuditLog: prune() with a generous retention window keeps everything", () => {
  const audit = freshAuditLog();
  audit.log({ category: "auth", event: "login", userId: "u1", userLabel: "alice" });
  audit.prune(9999);
  assert.equal(audit.query({}).total, 1);
});

test("AuditLog: prune(0) removes every existing row (each one is already older than a 0-day window by the time prune runs)", () => {
  const audit = freshAuditLog();
  audit.log({ category: "auth", event: "login", userId: "u1", userLabel: "alice" });
  audit.log({ category: "job", event: "print-started", userId: "u1", userLabel: "alice", printerId: "p1" });
  audit.prune(0);
  assert.equal(audit.query({}).total, 0);
});

test("AuditLog: prune() falls back to retentionDaysFn() when called with no argument", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-audit-test-"));
  const audit = createAuditLog({ baseDir, retentionDaysFn: () => 0 });
  audit.log({ category: "auth", event: "login", userId: "u1", userLabel: "alice" });
  audit.prune();
  assert.equal(audit.query({}).total, 0);
});

test("AuditLog: degrades to a safe no-op (never throws) when the base directory can't be created", () => {
  // A file (not a directory) at the path AuditLog wants to mkdir into forces
  // the constructor's fs.mkdirSync to fail, exercising the unavailable path.
  const blockerParent = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-audit-test-"));
  const blockerFile = path.join(blockerParent, "audit-data");
  fs.writeFileSync(blockerFile, "not a directory");
  const audit = createAuditLog({ baseDir: blockerParent });
  assert.equal(audit.isAvailable(), false);
  assert.doesNotThrow(() => audit.log({ category: "auth", event: "login" }));
  const result = audit.query({});
  assert.equal(result.unavailable, true);
  assert.deepEqual(result.rows, []);
  assert.doesNotThrow(() => audit.prune(90));
});
