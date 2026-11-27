// tools/refactor/test/jsonReporter.test.js — the harness reporter keeps a
// test declared { todo } apart from a genuine failure, through real node:test.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");

const REPORTER = path.join(__dirname, "..", "harness", "json-reporter.mjs");
const SAMPLE = path.join(__dirname, "fixtures", "reporter-sample.js");

function report() {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=" + REPORTER, "--test-reporter-destination=stdout", SAMPLE],
    { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const lines = r.stdout.split("\n").filter(Boolean).map(l => JSON.parse(l));
  return { exit: r.status, byName: new Map(lines.map(l => [l.name, l])), lines };
}
const R = report();

test("one line per test, nothing dropped or doubled", () => {
  assert.deepEqual(R.lines.map(l => l.name).sort(), ["failing todo", "ordinary failure", "ordinary pass", "passing todo", "skipped"]);
});
test("an ordinary failure is a genuine failure, with its message", () => {
  const t = R.byName.get("ordinary failure");
  assert.equal(t.status, "fail");
  assert.equal(t.error, "Expected values to be strictly equal:\n\n30 !== 215\n");
});
test("a failing todo is todo-fail, not fail, and keeps its message for the signature check", () => {
  const t = R.byName.get("failing todo");
  assert.equal(t.status, "todo-fail");
  assert.equal(t.error, "Expected values to be strictly equal:\n\n30 !== 215\n");
});
test("a passing todo is todo-pass, neither pass nor fail, with no error", () => {
  const t = R.byName.get("passing todo");
  assert.equal(t.status, "todo-pass");
  assert.equal(t.error, undefined);
});
test("an ordinary pass and a skip keep their statuses", () => {
  assert.equal(R.byName.get("ordinary pass").status, "pass");
  assert.equal(R.byName.get("skipped").status, "skip");
});
test("the run still exits 1, because of the genuine failure", () => {
  assert.equal(R.exit, 1);
});
