// tools/refactor/test/contracts.test.js — the contract comparison masks only
// declared fields that vary between base runs, reports every masked value,
// and accepts the measured-duration log exception only in its narrow form.
const test = require("node:test");
const assert = require("node:assert/strict");
const { compareRuns, validateLinePattern } = require("../lib/contracts");

const LC = (over = {}) => [{ intervals: [{ creator: "notifyTick", delay: 30000, unref: true, cleared: false, phase: "startup" }], startupTimeouts: [],
  listeners: [{ event: "SIGTERM", method: "on", creator: "<anonymous>" }], tracked: { 25000: { created: 2, cleared: 2, fired: 0 } }, activeIntervalsAtExit: ["notifyTick|30000|unref=true"], ...over }];
const run = (label, at, logs, extra = {}, lifecycle = LC()) => ({ label, lifecycle, isolation: { ok: true }, errors: [], printerRequests: { a: { "GET /x": 1 } }, files: ["f"], audit: [],
  results: [{ id: "r1", method: "GET", path: "/api/x", status: 200, contentType: "application/json", json: { at, value: 1, ...extra } }], logs: logs.map(line => ({ step: "s", line })) });
const VOL = { results: { r1: [{ pointer: "/at", kind: "timestamp", reason: "t" }, { pointer: "/value", kind: "timestamp", reason: "declared but stable" }] },
  logs: { exactStepPrefixes: [], linePatterns: [{ regex: "^\\[library\\] scanned G-code folder: ok in (\\d+\\.\\d) s — ", kind: "duration", reason: "measured" }] } };
const L = n => `[library] scanned G-code folder: ok in ${n} s — 1 files`;

test("declared + varying field masked and reported; declared but stable is not masked; any other change fails", () => {
  const r = compareRuns(run("base1", "t1", [L("0.1")]), run("base2", "t2", [L("0.1")]), run("head", "t3", [L("0.0")]), VOL);
  assert.equal(r.status, "PASS");
  assert.deepEqual(r.masked.map(m => [m.field, m.base1, m.base2, m.head]), [["/json/at", '"t1"', '"t2"', '"t3"']]);
  assert.deepEqual(r.declaredButStable, [{ id: "r1", pointer: "/value" }]);
  assert.equal(r.maskedLogLines.length, 2, "both masked log lines reported");
  assert.equal(compareRuns(run("base1", "t1", [L("0.1")]), run("base2", "t2", [L("0.1")]), run("head", "t3", [L("0.1")], { value: 2 }), VOL).status, "FAIL");
  assert.equal(compareRuns(run("base1", "t1", [L("0.1")]), run("base2", "t2", [L("0.1")]), run("head", "t3", [L("0.1") + " extra"]), VOL).status, "FAIL", "text outside the number still compared");
  assert.equal(compareRuns(run("base1", "t1", [L("0.1")]), run("base2", "t2", [L("0.1")]), run("head", "t3", [L("0.1"), "[health] new line"]), VOL).status, "FAIL");
});

test("the duration exception is refused in any broader form", () => {
  assert.ok(validateLinePattern({ regex: "^\\[library\\] scanned G-code folder: ok in (\\d+\\.\\d) s — ", kind: "duration" }));
  for (const [p, why] of [
    [{ regex: "^\\[library\\] scanned G-code folder: ok in (.*)", kind: "duration" }, /plain number/],
    [{ regex: "(\\d+) s", kind: "duration" }, /anchored/],
    [{ regex: "^.*(\\d+) s", kind: "duration" }, /literal text/],
    [{ regex: "^ok in (\\d+) s", kind: "duration" }, /literal text/],
    [{ regex: "^\\[library\\] scanned G-code folder: ok in (\\d+\\.\\d) s", kind: "timestamp" }, /only kind "duration"/],
    [{ regex: "^\\[library\\] scanned G-code folder: ok in (\\w+) s", kind: "duration" }, /plain number/],
  ]) assert.throws(() => validateLinePattern(p), why, p.regex);
});

test("lifecycle: identical per start passes; an extra interval, a listener or an uncleared tracked timer fails; base disagreement is UNVERIFIED; missing is UNVERIFIED", () => {
  const go = (h, b2 = LC()) => compareRuns(run("base1", "t1", []), run("base2", "t2", [], {}, b2), run("head", "t3", [], {}, h), VOL).lifecycle.status;
  assert.equal(go(LC()), "PASS");
  assert.equal(go(LC({ intervals: [...LC()[0].intervals, { creator: "<anonymous>", delay: 123456, unref: true, cleared: false, phase: "startup" }] })), "FAIL");
  assert.equal(go(LC({ listeners: [...LC()[0].listeners, { event: "exit", method: "on", creator: "x" }] })), "FAIL");
  assert.equal(go(LC({ tracked: { 25000: { created: 2, cleared: 1, fired: 1 } } })), "FAIL");
  assert.equal(go(LC(), LC({ startupTimeouts: [{ creator: "a", delay: 1, unref: false, cleared: false }] })), "UNVERIFIED");
  assert.equal(go([{ missing: true }]), "UNVERIFIED");
  assert.equal(compareRuns(run("base1", "t1", []), run("base2", "t2", []), run("head", "t3", [], {}, null), VOL).lifecycle.status, "UNVERIFIED", "no lifecycle record at all");
});

test("pid exception: only the number in Node's own '(node:N) ' prefix is masked, and reported; everything else is still compared", () => {
  const W = n => `(node:${n}) ExperimentalWarning: SQLite is an experimental feature and might change at any time`;
  const V = { ...VOL, logs: { ...VOL.logs, linePatterns: [...VOL.logs.linePatterns, { regex: "^\\(node:(\\d+)\\) ", kind: "pid", reason: "pid" }] } };
  const ok = compareRuns(run("base1", "t1", [W(18)]), run("base2", "t2", [W(18)]), run("head", "t3", [W(19)]), V);
  assert.equal(ok.logs.status, "PASS");
  assert.deepEqual(ok.maskedLogLines.filter(m => m.kind === "pid").map(m => m.original), [W(18), W(19)], "each masked value reported");
  const other = (h, why) => assert.equal(compareRuns(run("base1", "t1", [W(18)]), run("base2", "t2", [W(18)]), run("head", "t3", [h]), V).logs.status, "FAIL", why);
  other("(node:19) DeprecationWarning: something else", "a different warning text after the prefix");
  other("(node:19) ExperimentalWarning: SQLite is an experimental feature and might change", "truncated warning text");
  other("[health] (node:19) ExperimentalWarning: SQLite is an experimental feature and might change at any time", "the prefix not at the start of the line");
  other("(node:x19) ExperimentalWarning: SQLite is an experimental feature and might change at any time", "not a plain number");
  other("(nodejs:19) ExperimentalWarning: SQLite is an experimental feature and might change at any time", "another prefix");
  assert.equal(compareRuns(run("base1", "t1", [W(18)]), run("base2", "t2", [W(18)]), run("head", "t3", [W(19), W(20)]), V).logs.status, "FAIL", "an extra warning line");
});

test("pid exception is refused for any other pattern", () => {
  assert.ok(validateLinePattern({ regex: "^\\(node:(\\d+)\\) ", kind: "pid" }));
  for (const regex of ["^\\((\\w+):(\\d+)\\) ", "\\(node:(\\d+)\\) ", "^\\(node:(.*)\\) ", "^\\(node:(\\d+)\\) ExperimentalWarning: (.*)", "^\\[health\\] (\\d+)"])
    assert.throws(() => validateLinePattern({ regex, kind: "pid" }), /accepted only for Node's runtime-warning prefix/, regex);
});

// ---------- NDJSON answers: every record, in order ----------
const { parseNdjson } = require("../harness/ndjson");
const ND = lines => parseNdjson(lines.map(l => (typeof l === "string" ? l : JSON.stringify(l)) + "\n").join(""));
const SWEEP = [{ subnets: ["127.0.0.0/30"], total: 4, scanned: 0 }, { scanned: 4, total: 4, found: 0 }, { done: true, subnets: ["127.0.0.0/30"], found: [] }];
const ndRun = (label, ndjson) => ({ ...run(label, "t", []), results: [{ id: "nd", method: "GET", path: "/api/discover", status: 200, contentType: "application/x-ndjson", json: null, text: "…", ndjson }] });
const ndStatus = (head, base = ND(SWEEP)) => { const r = compareRuns(ndRun("base1", base), ndRun("base2", base), ndRun("head", head), { results: {}, logs: { exactStepPrefixes: [], linePatterns: [] } }); return [r.status, r.results[0].diffs]; };

test("parseNdjson keeps every record in order; a non-JSON or empty line is malformed, never skipped; the final newline is reported", () => {
  assert.deepEqual(ND(SWEEP), { count: 3, endsWithNewline: true, records: SWEEP.map(value => ({ ok: true, value })) });
  assert.deepEqual(parseNdjson('{"a":1}\n\nnot json\n{"b":2}'), { count: 4, endsWithNewline: false,
    records: [{ ok: true, value: { a: 1 } }, { ok: false, raw: "" }, { ok: false, raw: "not json" }, { ok: true, value: { b: 2 } }] });
  assert.deepEqual(parseNdjson(""), { count: 0, endsWithNewline: false, records: [] });
});
test("NDJSON: identical records in the same order pass", () => {
  assert.deepEqual(ndStatus(ND(SWEEP)), ["PASS", []]);
});
test("NDJSON: a missing, an extra, a reordered or a changed record fails, at its position", () => {
  const [s1, d1] = ndStatus(ND([SWEEP[0], SWEEP[2]]));
  assert.equal(s1, "FAIL"); assert.ok(d1.some(d => d.field === "/ndjson/count" && d.base === "3" && d.head === "2"));
  const [s2, d2] = ndStatus(ND([...SWEEP, { scanned: 4, total: 4, found: 0 }]));
  assert.equal(s2, "FAIL"); assert.ok(d2.some(d => d.field === "/ndjson/count" && d.head === "4"));
  const [s3, d3] = ndStatus(ND([SWEEP[1], SWEEP[0], SWEEP[2]]));
  assert.equal(s3, "FAIL"); assert.ok(d3.some(d => d.field.startsWith("/ndjson/records/0/")) && d3.some(d => d.field.startsWith("/ndjson/records/1/")));
  const [s4, d4] = ndStatus(ND([SWEEP[0], { scanned: 4, total: 4, found: 1 }, SWEEP[2]]));
  assert.equal(s4, "FAIL"); assert.deepEqual(d4.map(d => [d.field, d.base, d.head]), [["/ndjson/records/1/value/found", "0", "1"]]);
});
test("NDJSON: a malformed record or an unterminated last record fails — in head, and even when base and head agree on it", () => {
  const bad = ND([SWEEP[0], "{oops", SWEEP[2]]);
  const [s1, d1] = ndStatus(bad);
  assert.equal(s1, "FAIL"); assert.ok(d1.some(d => d.run === "head" && d.malformed === "{oops"));
  const [s2, d2] = ndStatus(bad, bad);
  assert.equal(s2, "FAIL", "identical on both sides is still a failure");
  assert.deepEqual([...new Set(d2.map(d => d.run))].sort(), ["base1", "base2", "head"]);
  const cut = parseNdjson(SWEEP.map(l => JSON.stringify(l)).join("\n"));
  assert.equal(ndStatus(cut, cut)[0], "FAIL", "no final newline");
});
test("NDJSON: an answer that stops being NDJSON (or starts being) fails; non-NDJSON results are compared exactly as before", () => {
  const plainHead = { ...ndRun("head", undefined) }; delete plainHead.results[0].ndjson;
  const r = compareRuns(ndRun("base1", ND(SWEEP)), ndRun("base2", ND(SWEEP)), plainHead, { results: {}, logs: { exactStepPrefixes: [], linePatterns: [] } });
  assert.equal(r.status, "FAIL");
  const plainRun = l => run(l, "t1", []);
  assert.equal(compareRuns(plainRun("base1"), plainRun("base2"), plainRun("head"), VOL).status, "PASS");
});
test("NDJSON: a record that changes only beyond character 2,000 of the body fails (the text field alone, cut at 2,000, would have passed)", () => {
  const records = n => [{ subnets: ["10.0.0.0/20"], total: 4096, scanned: 0 }, ...Array.from({ length: 102 }, (_, i) => ({ scanned: Math.min((i + 1) * 40, 4096), total: 4096, found: i >= 80 ? n : 0 }))];
  const body = n => records(n).map(r => JSON.stringify(r) + "\n").join("");
  const A = body(0), B = body(1);
  const firstDiff = [...A].findIndex((c, i) => c !== B[i]);
  assert.ok(firstDiff > 2000, "the two bodies first differ at character " + firstDiff);
  assert.equal(A.slice(0, 2000), B.slice(0, 2000), "what the harness keeps as text is identical");
  const res = (label, b, withRecords) => ({ ...run(label, "t", []), results: [{ id: "nd", method: "GET", path: "/api/discover", status: 200, contentType: "application/x-ndjson", json: null, text: b.slice(0, 2000), ...(withRecords ? { ndjson: parseNdjson(b) } : {}) }] });
  const vol = { results: {}, logs: { exactStepPrefixes: [], linePatterns: [] } };
  assert.equal(compareRuns(res("base1", A, false), res("base2", A, false), res("head", B, false), vol).status, "PASS", "the gap: text only, the change is invisible");
  const r = compareRuns(res("base1", A, true), res("base2", A, true), res("head", B, true), vol);
  assert.equal(r.status, "FAIL");
  assert.equal(r.results[0].diffs.length, 22, "every changed record is reported (records 81 to 102)");
  assert.deepEqual(r.results[0].diffs[0], { field: "/ndjson/records/81/value/found", base: "0", head: "1" });
});

// ---------- the baseline itself must be stable: all three runs are covered ----------
const NOVOL = { results: {}, logs: { exactStepPrefixes: [], linePatterns: [] } };
const nd3 = (b1, b2, h) => compareRuns(ndRun("base1", b1), ndRun("base2", b2), ndRun("head", h), NOVOL);
test("baseline: head equal to base1 does not pass when base2 has a different NDJSON value", () => {
  const other = ND([SWEEP[0], { scanned: 4, total: 4, found: 1 }, SWEEP[2]]);
  const r = nd3(ND(SWEEP), other, ND(SWEEP));
  assert.equal(r.status, "FAIL");
  assert.deepEqual(r.results[0].diffs, [{ field: "/ndjson/records/1/value/found", base: "0", base2: "1", head: "0", note: "varies between base runs but is not declared volatile" }]);
  assert.deepEqual(r.masked, [], "NDJSON is never masked");
  const declared = compareRuns(ndRun("base1", ND(SWEEP)), ndRun("base2", other), ndRun("head", ND(SWEEP)),
    { ...NOVOL, results: { nd: [{ pointer: "/records/1/value/found", kind: "timestamp", reason: "an attempt to declare it" }, { pointer: "/ndjson/records/1/value/found", kind: "timestamp", reason: "another" }] } });
  assert.equal(declared.status, "FAIL", "and declaring it volatile does not help: only /json fields can be declared");
});
test("baseline: an extra or a missing NDJSON record in base2 fails, even though head equals base1", () => {
  const extra = nd3(ND(SWEEP), ND([...SWEEP, { scanned: 4, total: 4, found: 0 }]), ND(SWEEP));
  assert.equal(extra.status, "FAIL");
  assert.ok(extra.results[0].diffs.some(d => d.field === "/ndjson/count" && d.base === "3" && d.base2 === "4" && d.head === "3"));
  assert.ok(extra.results[0].diffs.some(d => d.field === "/ndjson/records/3/value/scanned" && d.base === "<missing>" && d.base2 === "4" && d.head === "<missing>"),
    "a field that exists only in base2 is covered");
  const missing = nd3(ND(SWEEP), ND([SWEEP[0], SWEEP[2]]), ND(SWEEP));
  assert.equal(missing.status, "FAIL");
  assert.ok(missing.results[0].diffs.some(d => d.field === "/ndjson/count" && d.base2 === "2"));
  assert.ok(missing.results[0].diffs.some(d => d.field === "/ndjson/records/2/value/done" && d.base === "true" && d.base2 === "<missing>" && d.head === "true"));
});
test("baseline: a result present only in base2, or missing from base2 (or from any run), is reported by name and fails — nothing throws", () => {
  const withExtra = (label, id) => { const r = run(label, "t1", []); r.results.push({ id, method: "GET", path: "/api/y", status: 200, contentType: "application/json", json: { a: 1 } }); return r; };
  const onlyB2 = compareRuns(run("base1", "t1", []), withExtra("base2", "only-b2"), run("head", "t1", []), NOVOL);
  assert.equal(onlyB2.status, "FAIL");
  assert.deepEqual(onlyB2.results.find(x => x.id === "only-b2"), { id: "only-b2", status: "FAIL", why: "missing in base1 and head", missingIn: ["base1", "head"] });
  const notB2 = compareRuns(withExtra("base1", "x"), run("base2", "t1", []), withExtra("head", "x"), NOVOL);
  assert.equal(notB2.status, "FAIL");
  assert.deepEqual(notB2.results.find(x => x.id === "x"), { id: "x", status: "FAIL", why: "missing in base2", missingIn: ["base2"] });
  assert.equal(compareRuns(withExtra("base1", "x"), withExtra("base2", "x"), run("head", "t1", []), NOVOL).results.find(x => x.id === "x").why, "missing in head");
  assert.equal(compareRuns(run("base1", "t1", []), withExtra("base2", "x"), withExtra("head", "x"), NOVOL).results.find(x => x.id === "x").why, "missing in base1");
  assert.equal(compareRuns(withExtra("base1", "x"), withExtra("base2", "x"), withExtra("head", "x"), NOVOL).status, "PASS", "present in all three and equal: passes");
});
test("baseline: an undeclared JSON difference between the base runs fails even when head equals base1; a field only in base2 too", () => {
  const r = compareRuns(run("base1", "t1", [], { n: 1 }), run("base2", "t1", [], { n: 2 }), run("head", "t1", [], { n: 1 }), NOVOL);
  assert.equal(r.status, "FAIL");
  assert.deepEqual(r.results[0].diffs, [{ field: "/json/n", base: "1", base2: "2", head: "1", note: "varies between base runs but is not declared volatile" }]);
  const only = compareRuns(run("base1", "t1", []), run("base2", "t1", [], { extra: true }), run("head", "t1", []), NOVOL);
  assert.equal(only.status, "FAIL");
  assert.deepEqual(only.results[0].diffs, [{ field: "/json/extra", base: "<missing>", base2: "true", head: "<missing>", note: "varies between base runs but is not declared volatile" }]);
});
test("declared JSON volatility works as before: a declared field that varies between the base runs is masked and reported, whatever head holds; declared but stable is compared exactly", () => {
  const r = compareRuns(run("base1", "t1", []), run("base2", "t2", []), run("head", "t1", []), VOL);
  assert.equal(r.status, "PASS", "head equal to base1");
  assert.deepEqual(r.masked.map(m => [m.field, m.base1, m.base2, m.head]), [["/json/at", '"t1"', '"t2"', '"t1"']]);
  assert.equal(compareRuns(run("base1", "t1", []), run("base2", "t2", []), run("head", "t9", []), VOL).status, "PASS", "head with a third value");
  assert.deepEqual(r.declaredButStable, [{ id: "r1", pointer: "/value" }]);
  assert.equal(compareRuns(run("base1", "t1", []), run("base2", "t2", []), run("head", "t3", [], { value: 2 }), VOL).status, "FAIL", "a declared field that did not vary is still compared");
  assert.equal(compareRuns(run("base1", "t1", []), run("base2", "t1", []), run("head", "t3", []), VOL).status, "FAIL", "declared, but the base runs agree: not masked");
  const gone = run("head", "t3", []); delete gone.results[0].json.at;
  assert.equal(compareRuns(run("base1", "t1", []), run("base2", "t2", []), gone, VOL).status, "FAIL", "a masked field must still exist in head");
});
