// tools/refactor/test/mutations.test.js — V7: a mutation is detected only by a
// pinning test that passed before and now fails genuinely; known failures and
// todo outcomes never make a mutation look detected.
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateMutation } = require("../lib/mutations");

// The unmutated pinning run: two ordinary tests, one known failure (it fails
// before any mutation), one failing todo, one passing todo, one skip.
const BEFORE = [
  { key: "pin :: guards visibility", status: "pass" },
  { key: "pin :: dwell is 30 s", status: "pass" },
  { key: "pin :: known failure", status: "fail" },
  { key: "pin :: known bug (todo)", status: "todo-fail" },
  { key: "pin :: fixed bug (todo)", status: "todo-pass" },
  { key: "pin :: windows only", status: "skip" },
];
const after = changes => BEFORE.map(t => (t.key in changes ? { ...t, status: changes[t.key] } : t));
const side = (changes, unmutated = [BEFORE]) => ({ unmutated, mutated: after(changes) });
const both = (changes, headChanges = changes) => evaluateMutation({ base: side(changes), head: side(headChanges, [BEFORE, BEFORE, BEFORE]) });

test("detected when an intended, previously passing non-todo test fails, by the same tests on base and head", () => {
  const r = both({ "pin :: dwell is 30 s": "fail" });
  assert.equal(r.status, "PASS");
  assert.deepEqual(r.base.detectedBy, ["pin :: dwell is 30 s"]);
  assert.deepEqual(r.head.detectedBy, ["pin :: dwell is 30 s"]);
});
test("nothing changed: undetected, FAIL", () => {
  const r = both({});
  assert.equal(r.status, "FAIL");
  assert.equal(r.why, "undetected (base and head)");
});
test("a known failure that keeps failing never counts as detection", () => {
  const r = both({});                                   // "known failure" is "fail" in the mutated run too
  assert.equal(r.status, "FAIL");
  assert.deepEqual(r.base.detectedBy, []);
  assert.ok(r.base.ignored.some(i => i.test === "pin :: known failure" && i.status === "fail" && i.before[0] === "fail"));
});
test("a test that was not passing in every unmutated run never counts (failed in one head run before)", () => {
  const flakyBefore = BEFORE.map(t => (t.key === "pin :: dwell is 30 s" ? { ...t, status: "fail" } : t));
  const r = evaluateMutation({ base: side({ "pin :: dwell is 30 s": "fail" }), head: side({ "pin :: dwell is 30 s": "fail" }, [BEFORE, flakyBefore]) });
  assert.equal(r.status, "FAIL");
  assert.deepEqual(r.head.detectedBy, []);
});
test("a mutation producing only todo outcomes is undetected (FAIL), never PASS", () => {
  for (const changes of [{ "pin :: fixed bug (todo)": "todo-fail" }, { "pin :: known bug (todo)": "todo-pass" }]) {
    const r = both(changes);
    assert.equal(r.status, "FAIL");
    assert.match(r.why, /^undetected: only todo outcomes changed/);
  }
});
test("a previously passing test that turns into a todo outcome is not a genuine failure", () => {
  const r = both({ "pin :: guards visibility": "todo-fail" });
  assert.equal(r.status, "FAIL");
  assert.deepEqual(r.base.detectedBy, []);
});
test("known failures and todo outcomes beside a real detection are reported but not counted", () => {
  const r = both({ "pin :: guards visibility": "fail", "pin :: fixed bug (todo)": "todo-fail" });
  assert.equal(r.status, "PASS");
  assert.deepEqual(r.base.detectedBy, ["pin :: guards visibility"]);
  assert.deepEqual(r.base.ignored.map(i => i.test).sort(), ["pin :: fixed bug (todo)", "pin :: known bug (todo)", "pin :: known failure"]);
});
test("a failure of a test that did not exist before (e.g. a file that no longer loads) is not detection; vanished tests are listed", () => {
  const mutated = [{ key: "test/x.test.js :: test/x.test.js", status: "fail" }];
  const r = evaluateMutation({ base: { unmutated: [BEFORE], mutated }, head: { unmutated: [BEFORE], mutated } });
  assert.equal(r.status, "FAIL");
  assert.deepEqual(r.base.vanished, ["pin :: dwell is 30 s", "pin :: guards visibility"]);
});
test("base and head detected by different tests: FAIL; detected on one side only: FAIL", () => {
  assert.equal(both({ "pin :: dwell is 30 s": "fail" }, { "pin :: guards visibility": "fail" }).status, "FAIL");
  const r = both({ "pin :: dwell is 30 s": "fail" }, {});
  assert.equal(r.status, "FAIL");
  assert.match(r.why, /undetected \(head\)/);
});
test("a mutation that could not be applied: FAIL", () => {
  assert.equal(evaluateMutation({ base: { error: "anchor not found" }, head: side({}) }).status, "FAIL");
});
