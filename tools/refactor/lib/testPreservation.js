// tools/refactor/lib/testPreservation.js — compares a test file base vs head,
// assertion by assertion and test by test (never by counts alone):
//   - every base test name still exists;
//   - every base assertion still exists, verbatim (whitespace-normalised), in
//     the same test; added assertions are reported (strengthening, reviewed);
//   - every changed line is classified: a declared harness line (how the code
//     under test is loaded — the only kind a refactor may change), an
//     assertion change, or undeclared. Anything but declared/added fails.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const j = require("jscodeshift").withParser("babel");
const { parse } = require("../mapper/map-server");

const norm = s => s.replace(/\s+/g, " ").trim();
const isStr = n => n && (n.type === "Literal" || n.type === "StringLiteral") && typeof n.value === "string";

// { testName: [assertion texts] } — a "test" is any call whose first argument
// is a string/template and whose last argument is a function (test, T, testT,
// it, describe and local wrappers alike).
function testsOf(src) {
  const root = parse(src);
  const tests = new Map();
  const owner = p => {
    for (let q = p.parent; q; q = q.parent) {
      const n = q.node;
      if (n.type === "CallExpression" && n.arguments.length >= 2 && (isStr(n.arguments[0]) || n.arguments[0].type === "TemplateLiteral") && /Function/.test(n.arguments[n.arguments.length - 1].type)) {
        return isStr(n.arguments[0]) ? n.arguments[0].value : "`" + src.slice(n.arguments[0].start + 1, n.arguments[0].end - 1) + "`";
      }
    }
    return "(file level)";
  };
  root.find(j.CallExpression).forEach(p => {
    const n = p.node, c = n.callee;
    if (n.arguments.length >= 2 && (isStr(n.arguments[0]) || n.arguments[0].type === "TemplateLiteral") && /Function/.test(n.arguments[n.arguments.length - 1].type)) {
      const name = isStr(n.arguments[0]) ? n.arguments[0].value : "`" + src.slice(n.arguments[0].start + 1, n.arguments[0].end - 1) + "`";
      if (!tests.has(name)) tests.set(name, []);
    }
    const isAssert = (c.type === "MemberExpression" && c.object.type === "Identifier" && c.object.name === "assert") || (c.type === "Identifier" && c.name === "assert");
    if (isAssert) { const o = owner(p); if (!tests.has(o)) tests.set(o, []); tests.get(o).push(norm(src.slice(n.start, n.end))); }
  });
  return tests;
}

function changedLines(baseSrc, headSrc) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tp-"));
  try {
    fs.writeFileSync(path.join(d, "a"), baseSrc); fs.writeFileSync(path.join(d, "b"), headSrc);
    const r = spawnSync("git", ["diff", "--no-index", "-U0", "--no-color", path.join(d, "a"), path.join(d, "b")], { encoding: "utf8" });
    return r.stdout.split("\n").filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).map(l => ({ side: l[0] === "+" ? "head" : "base", text: l.slice(1) }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

function compareTestFile(baseSrc, headSrc, harnessPatterns = []) {
  const bt = testsOf(baseSrc), ht = testsOf(headSrc);
  const out = { status: "PASS", missingTests: [], addedTests: [], missingAssertions: [], addedAssertions: [], lines: [] };
  for (const [name, asserts] of bt) {
    if (!ht.has(name)) { out.missingTests.push(name); continue; }
    const pool = [...ht.get(name)];
    for (const a of asserts) { const i = pool.indexOf(a); if (i < 0) out.missingAssertions.push({ test: name, assertion: a }); else pool.splice(i, 1); }
    for (const a of pool) out.addedAssertions.push({ test: name, assertion: a });
  }
  for (const name of ht.keys()) if (!bt.has(name)) out.addedTests.push(name);
  // Declarations: { base: regex for the removed line, head: regex for the added line }.
  const decl = harnessPatterns.map(p => (typeof p === "string" ? { base: new RegExp(p), head: new RegExp(p) } : { base: new RegExp(p.base), head: new RegExp(p.head) }));
  for (const l of changedLines(baseSrc, headSrc)) {
    const kind = !l.text.trim() ? "blank" : decl.some(d => d[l.side].test(l.text)) ? "declared-harness" : /\bassert\b/.test(l.text) ? "assertion" : "undeclared";
    out.lines.push({ ...l, kind });
  }
  const undeclared = out.lines.filter(l => l.kind === "undeclared" || (l.kind === "assertion" && l.side === "base"));
  // An assertion line removed from the base is only acceptable if the same
  // assertion still exists in the same test (verbatim) — checked above.
  if (out.missingTests.length || out.missingAssertions.length) out.status = "FAIL";
  else if (out.lines.some(l => l.kind === "undeclared")) out.status = "FAIL";
  else if (out.addedAssertions.length || out.addedTests.length) out.status = "REVIEW";
  out.undeclaredLines = undeclared.filter(l => l.kind === "undeclared");
  return out;
}

module.exports = { compareTestFile, testsOf, changedLines };
