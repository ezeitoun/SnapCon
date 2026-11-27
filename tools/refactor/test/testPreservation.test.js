// tools/refactor/test/testPreservation.test.js — the test-preservation check
// on synthetic test files: a declared loader change passes; a removed,
// weakened or moved assertion, a removed or renamed test, and any
// undeclared line change fail; added assertions need review.
const test = require("node:test");
const assert = require("node:assert/strict");
const { compareTestFile } = require("../lib/testPreservation");

const BASE = `const { load } = require("./helpers/fromSource");
const T = (name, fn) => test(name, fn);
T("one", () => {
  const h = load();
  assert.equal(h.a, 1);
  assert.deepEqual(h.list, [1, 2]);
});
for (const k of ["x", "y"]) T(\`loop \${k}\`, () => { assert.ok(load()[k]); });
`;
const HARNESS = [{ base: "require\\(\"\\./helpers/fromSource\"\\)", head: "require\\(\"\\./helpers/fromModule\"\\)" }];

test("only the declared loader line changed (old and new forms declared): PASS", () => {
  const r = compareTestFile(BASE, BASE.replace('require("./helpers/fromSource")', 'require("./helpers/fromModule")'), HARNESS);
  assert.equal(r.status, "PASS", JSON.stringify(r));
  assert.deepEqual(r.lines.map(l => l.side + ":" + l.kind).sort(), ["base:declared-harness", "head:declared-harness"]);
  assert.equal(compareTestFile(BASE, BASE.replace('require("./helpers/fromSource")', 'require("./helpers/other")'), HARNESS).status, "FAIL", "an undeclared new form fails");
});

test("a removed or weakened assertion fails", () => {
  assert.equal(compareTestFile(BASE, BASE.replace("  assert.equal(h.a, 1);\n", ""), HARNESS).status, "FAIL");
  const w = compareTestFile(BASE, BASE.replace("assert.deepEqual(h.list, [1, 2]);", "assert.ok(h.list);"), HARNESS);
  assert.equal(w.status, "FAIL");
  assert.equal(w.missingAssertions[0].assertion, "assert.deepEqual(h.list, [1, 2])");
});

test("an assertion moved to another test, or a test renamed/removed, fails", () => {
  const moved = BASE.replace("  assert.equal(h.a, 1);\n", "").replace("assert.ok(load()[k]);", "assert.ok(load()[k]); assert.equal(h.a, 1);");
  assert.equal(compareTestFile(BASE, moved, HARNESS).status, "FAIL");
  assert.deepEqual(compareTestFile(BASE, BASE.replace('T("one"', 'T("uno"'), HARNESS).missingTests, ["one"]);
});

test("an undeclared non-assertion change fails; an added assertion is REVIEW", () => {
  assert.equal(compareTestFile(BASE, BASE.replace("const h = load();", "const h = load({ fake: true });"), HARNESS).status, "FAIL");
  const r = compareTestFile(BASE, BASE.replace("  assert.equal(h.a, 1);\n", "  assert.equal(h.a, 1);\n  assert.equal(h.b, 2);\n"), HARNESS);
  assert.equal(r.status, "REVIEW");
  assert.deepEqual(r.addedAssertions, [{ test: "one", assertion: "assert.equal(h.b, 2)" }]);
});

test("template-named tests are tracked by their template text", () => {
  const r = compareTestFile(BASE, BASE.replace("assert.ok(load()[k]);", "load()[k];"), HARNESS);
  assert.equal(r.status, "FAIL");
  assert.equal(r.missingAssertions[0].test, "`loop ${k}`");
});
