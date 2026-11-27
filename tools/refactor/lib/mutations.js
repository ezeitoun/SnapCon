// tools/refactor/lib/mutations.js — V7's decision for one declared mutation.
// A mutation is DETECTED on a tree only by pinning tests that passed
// ("pass") in every unmutated run of that tree and fail as genuine failures
// ("fail") once the mutation is applied. Nothing else counts: a known
// failure, a todo ("todo-fail"/"todo-pass"), a skip, or a test that was not
// passing before can never make a mutation look detected; they are listed
// under "ignored" so the report still shows them. PASS needs the same
// non-empty set of detecting tests on base and on head.
"use strict";

// unmutated: array of runs (each an array of { key, status }); mutated: one run.
function detecting(unmutated, mutated) {
  const before = unmutated.map(r => new Map(r.map(t => [t.key, t.status])));
  const passedBefore = k => before.length > 0 && before.every(m => m.get(k) === "pass");
  const detectedBy = [], ignored = [];
  for (const t of mutated) {
    if (t.status === "pass" || t.status === "skip") continue;
    if (t.status === "fail" && passedBefore(t.key)) detectedBy.push(t.key);
    else ignored.push({ test: t.key, status: t.status, before: before.map(m => m.get(t.key) || "missing") });
  }
  // Previously passing tests that did not report at all (e.g. the file failed
  // to load): shown, never counted as detection.
  const seen = new Set(mutated.map(t => t.key));
  const vanished = before.length ? [...before[0].keys()].filter(k => passedBefore(k) && !seen.has(k)).sort() : [];
  return { detectedBy: detectedBy.sort(), ignored, vanished };
}

// { base: { unmutated, mutated, error? }, head: { unmutated, mutated, error? } }
function evaluateMutation({ base, head }) {
  if (base.error || head.error) return { status: "FAIL", why: "mutation could not be applied", base: { error: base.error }, head: { error: head.error } };
  const b = detecting(base.unmutated, base.mutated), h = detecting(head.unmutated, head.mutated);
  const onlyTodo = side => side.detectedBy.length === 0 && side.ignored.some(i => /^todo-/.test(i.status) && i.before.some(x => x !== i.status));
  let status = "PASS", why;
  if (!b.detectedBy.length || !h.detectedBy.length) {
    status = "FAIL";
    why = "undetected" + (onlyTodo(b) || onlyTodo(h) ? ": only todo outcomes changed" : "") + " (" + (!b.detectedBy.length ? "base" : "") + (!b.detectedBy.length && !h.detectedBy.length ? " and " : "") + (!h.detectedBy.length ? "head" : "") + ")";
  } else if (JSON.stringify(b.detectedBy) !== JSON.stringify(h.detectedBy)) {
    status = "FAIL"; why = "base and head are detected by different tests";
  }
  return { status, why, base: b, head: h };
}

module.exports = { evaluateMutation, detecting };
