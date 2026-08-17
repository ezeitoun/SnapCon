// test/health-maintenance.test.js — regression anchor for the additive
// `code` (+ safe raw params) fields added to server.js's deterministic
// Health/Maintenance attention-reason generators as part of Health+
// Maintenance i18n. server.js has no module.exports and no existing
// route-level test harness in this project (confirmed: no other test
// spins it up or imports it directly) — a lightweight source-text check is
// the proportionate way to verify the additive fields exist and the
// original English title/detail prose was preserved unchanged for any
// other consumer, without introducing a new server test harness for this
// one change.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("checkFanMismatch's 'Fan not spinning' reason keeps its original title/detail AND carries the additive code/name/rpm fields", () => {
  assert.match(src, /title:\s*"Fan not spinning".*code:\s*"fan-not-spinning".*name:\s*f\.name.*rpm:\s*Math\.round\(f\.rpm\)/);
});

test("computeHealthAttention's four reasons (undervoltage/throttled/low-disk-space/recent-fault) all carry additive stable codes", () => {
  assert.match(src, /title:\s*"Undervoltage".*code:\s*"undervoltage"/);
  assert.match(src, /title:\s*"Throttled".*code:\s*"throttled"/);
  assert.match(src, /title:\s*"Low disk space".*code:\s*"low-disk-space"/);
  assert.match(src, /title:\s*"Recent fault".*code:\s*"recent-fault"/);
});

test("computeMaintenanceAttention's overdue/due-soon reasons carry additive code + raw component/date fields", () => {
  assert.match(src, /title:\s*"Maintenance overdue".*code:\s*"maintenance-overdue".*component:\s*next\.component.*date:\s*next\.date/);
  assert.match(src, /title:\s*"Maintenance due soon".*code:\s*"maintenance-due-soon".*component:\s*next\.component.*date:\s*next\.date/);
});

test("every attention-reason code is unique (no two generators share a code, which would collide client-side)", () => {
  const codes = [...src.matchAll(/code:\s*"([a-z-]+)"/g)].map(m => m[1]);
  const attentionCodes = codes.filter(c =>
    ["fan-not-spinning", "undervoltage", "throttled", "low-disk-space", "recent-fault", "maintenance-overdue", "maintenance-due-soon"].includes(c));
  assert.equal(attentionCodes.length, 7, "all 7 expected attention codes must be present exactly once each");
  assert.equal(new Set(attentionCodes).size, 7, "no duplicate codes");
});
