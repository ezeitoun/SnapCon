// tools/refactor/lib/knownFailures.js — V6's treatment of known failures.
// The reviewed registry (harness/known-failures.json) must match EXACTLY:
// every entry fails on base and on every head run with a matching signature
// (exact message, or a declared regex where the source shows the numbers are
// random). An entry with "kind": "todo" is a test declared { todo } (a
// documented known bug) and must be reported as a failing todo ("todo-fail");
// every other entry must be a genuine failure ("fail"). The two kinds never
// stand in for each other. Blocks on: a new failure or new failing todo (base
// or head), a changed signature or kind, a known entry that passes or is
// missing. Never a plain PASS.
"use strict";
const keyOf = t => (t.file || "").replace(/^\/tmp\/app\//, "") + " :: " + t.name;
const FAILING = new Set(["fail", "todo-fail"]);
const expectedStatus = e => (e.kind === "todo" ? "todo-fail" : "fail");

function signatureOk(entry, message) {
  if (message == null) return false;
  return entry.exact !== undefined ? message === entry.exact : new RegExp(entry.regex).test(message);
}

function evaluateKnownFailures(registry, baseRun, headRuns) {
  const known = new Map(registry.failures.map(e => [e.file + " :: " + e.name, e]));
  const out = { status: "PASS", known: [], newFailures: [], changed: [],
    counts: { failures: registry.failures.filter(e => e.kind !== "todo").length, todos: registry.failures.filter(e => e.kind === "todo").length } };
  const runs = [["base", baseRun], ...headRuns.map((h, i) => ["head-" + (i + 1), h])];
  for (const [label, run] of runs) {
    for (const t of run.tests) if (FAILING.has(t.status) && !known.has(keyOf(t))) out.newFailures.push({ run: label, test: keyOf(t), status: t.status, error: t.error });
  }
  for (const [k, e] of known) {
    const want = expectedStatus(e);
    const per = runs.map(([label, run]) => {
      const t = run.tests.find(x => keyOf(x) === k);
      return { run: label, status: t ? t.status : "missing", expected: want, error: t && t.error, signatureMatches: !!t && t.status === want && signatureOk(e, t.error) };
    });
    const ok = per.every(p => p.signatureMatches);
    out.known.push({ test: k, kind: e.kind === "todo" ? "todo" : "failure", ok, signature: e.exact !== undefined ? "exact" : "regex", reason: e.reason, runs: per });
    if (!ok) out.changed.push({ test: k, runs: per.filter(p => !p.signatureMatches) });
  }
  out.status = out.newFailures.length || out.changed.length ? "FAIL" : known.size ? "PASS_WITH_KNOWN_FAILURES" : "PASS";
  return out;
}

module.exports = { evaluateKnownFailures, signatureOk, keyOf };
