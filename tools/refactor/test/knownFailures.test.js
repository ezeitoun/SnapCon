// tools/refactor/test/knownFailures.test.js — known failures are reported,
// never silently passed; anything new or changed blocks.
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateKnownFailures } = require("../lib/knownFailures");

const REG = { failures: [
  { file: "test/a.test.js", name: "exact one", exact: "Expected 30 !== 215" },
  { file: "test/b.test.js", name: "random size", regex: "^sizes \\d+ !== \\d+$" },
] };
const run = over => ({ tests: [
  { file: "/tmp/app/test/a.test.js", name: "exact one", status: "fail", error: "Expected 30 !== 215" },
  { file: "/tmp/app/test/b.test.js", name: "random size", status: "fail", error: "sizes 2097354 !== 2097322" },
  { file: "/tmp/app/test/c.test.js", name: "fine", status: "pass" }, ...(over || []) ] });
const with_ = (name, patch) => ({ tests: run().tests.map(t => (t.name === name ? { ...t, ...patch } : t)) });

test("exactly the known failures, signatures matching: PASS_WITH_KNOWN_FAILURES (never plain PASS), each listed", () => {
  const r = evaluateKnownFailures(REG, run(), [run(), with_("random size", { error: "sizes 2097351 !== 2097320" })]);
  assert.equal(r.status, "PASS_WITH_KNOWN_FAILURES");
  assert.equal(r.known.length, 2);
  assert.ok(r.known.every(k => k.ok && k.runs.length === 3));
});
test("a new failure on head or on base blocks", () => {
  assert.equal(evaluateKnownFailures(REG, run(), [with_("fine", { status: "fail", error: "x" })]).status, "FAIL");
  assert.equal(evaluateKnownFailures(REG, with_("fine", { status: "fail", error: "x" }), [run()]).status, "FAIL");
});
test("a changed signature blocks (exact text, or outside the declared regex)", () => {
  assert.equal(evaluateKnownFailures(REG, run(), [with_("exact one", { error: "Expected 31 !== 215" })]).status, "FAIL");
  assert.equal(evaluateKnownFailures(REG, run(), [with_("random size", { error: "sizes 1 !== x" })]).status, "FAIL");
});
test("a known failure that passes, or is missing, blocks", () => {
  assert.equal(evaluateKnownFailures(REG, run(), [with_("exact one", { status: "pass", error: undefined })]).status, "FAIL");
  assert.equal(evaluateKnownFailures(REG, run(), [{ tests: run().tests.filter(t => t.name !== "exact one") }]).status, "FAIL");
});
test("no registry entries and no failures: PASS", () => {
  assert.equal(evaluateKnownFailures({ failures: [] }, { tests: [{ file: "a", name: "x", status: "pass" }] }, [{ tests: [{ file: "a", name: "x", status: "pass" }] }]).status, "PASS");
});

// A registry entry with "kind": "todo" is a test declared { todo }: it must be
// a failing todo ("todo-fail"); the other entries must be genuine failures.
const REG_TODO = { failures: [
  { file: "test/a.test.js", name: "exact one", exact: "Expected 30 !== 215" },
  { file: "test/t.test.js", name: "known bug", kind: "todo", exact: "Expected 30 !== 215" },
] };
const runT = over => ({ tests: [
  { file: "/tmp/app/test/a.test.js", name: "exact one", status: "fail", error: "Expected 30 !== 215" },
  { file: "/tmp/app/test/t.test.js", name: "known bug", status: "todo-fail", error: "Expected 30 !== 215" },
  { file: "/tmp/app/test/c.test.js", name: "fine", status: "pass" }, ...(over || []) ] });
const withT = (name, patch) => ({ tests: runT().tests.map(t => (t.name === name ? { ...t, ...patch } : t)) });

test("a registered failing todo with its signature: PASS_WITH_KNOWN_FAILURES, counted and labelled as a todo", () => {
  const r = evaluateKnownFailures(REG_TODO, runT(), [runT(), runT()]);
  assert.equal(r.status, "PASS_WITH_KNOWN_FAILURES");
  assert.deepEqual(r.counts, { failures: 1, todos: 1 });
  assert.deepEqual(r.known.map(k => [k.test, k.kind, k.ok]), [["test/a.test.js :: exact one", "failure", true], ["test/t.test.js :: known bug", "todo", true]]);
});
test("a registered todo that passes, or whose signature changes, blocks", () => {
  assert.equal(evaluateKnownFailures(REG_TODO, runT(), [withT("known bug", { status: "todo-pass", error: undefined })]).status, "FAIL");
  assert.equal(evaluateKnownFailures(REG_TODO, runT(), [withT("known bug", { error: "Expected 31 !== 215" })]).status, "FAIL");
  assert.equal(evaluateKnownFailures(REG_TODO, withT("known bug", { status: "todo-pass", error: undefined }), [runT()]).status, "FAIL");
});
test("the kinds never stand in for each other: a todo entry seen as a genuine failure, or a failure entry seen as a todo, blocks", () => {
  const r1 = evaluateKnownFailures(REG_TODO, runT(), [withT("known bug", { status: "fail" })]);
  assert.equal(r1.status, "FAIL");
  assert.deepEqual(r1.changed[0].runs.map(p => [p.status, p.expected]), [["fail", "todo-fail"]]);
  assert.equal(evaluateKnownFailures(REG_TODO, runT(), [withT("exact one", { status: "todo-fail" })]).status, "FAIL");
});
test("an unregistered failing todo blocks like an unregistered failure; an ordinary failure still blocks", () => {
  const r = evaluateKnownFailures(REG_TODO, runT(), [withT("fine", { status: "todo-fail", error: "x" })]);
  assert.equal(r.status, "FAIL");
  assert.deepEqual(r.newFailures.map(f => [f.test, f.status]), [["test/c.test.js :: fine", "todo-fail"]]);
  assert.equal(evaluateKnownFailures(REG_TODO, runT(), [withT("fine", { status: "fail", error: "x" })]).status, "FAIL");
});
test("an unregistered passing todo is not a failure", () => {
  assert.equal(evaluateKnownFailures(REG_TODO, runT(), [runT([{ file: "/tmp/app/test/d.test.js", name: "fixed bug", status: "todo-pass" }])]).status, "PASS_WITH_KNOWN_FAILURES");
});
