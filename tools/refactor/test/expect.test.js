// tools/refactor/test/expect.test.js — a contract run checks its own fixture:
// an unacknowledged control step, or a request that does not produce what its
// step declares, is an error of the run — and a run with errors can never
// pass verification, however well it matches the other runs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkControl, checkExpect } = require("../harness/expect");
const { parseNdjson } = require("../harness/ndjson");
const { compareRuns } = require("../lib/contracts");

const BRAVO = { ip: "127.0.0.3", url: "http://127.0.0.3:7125", device_name: "Bravo U1", connector: "snapmaker-u1-klipper-ws" };
const sweep = found => ({ status: 200, contentType: "application/x-ndjson",
  ndjson: parseNdjson([{ subnets: ["127.0.0.0/30"], total: 4, scanned: 0 }, { scanned: 4, total: 4, found: found.length }, { done: true, subnets: ["127.0.0.0/30"], found }].map(o => JSON.stringify(o) + "\n").join("")) });
const ENABLED = { id: "finds-bravo", expect: { status: 200, ndjsonRecords: 3, found: [BRAVO] } };
const DISABLED = { id: "after-switch-off", expect: { status: 200, ndjsonRecords: 3, found: [] } };

test("a control step counts only when the fake printer acknowledges it with 200 {ok:true}", () => {
  const step = { do: "printer", printer: "bravo" };
  assert.deepEqual(checkControl(step, 200, { ok: true }), []);
  assert.match(checkControl(step, 404, { error: "no such control" })[0], /printer "bravo" \(\/__control\/set\) was not acknowledged: HTTP 404/);
  assert.equal(checkControl(step, 200, { ok: false }).length, 1);
  assert.equal(checkControl(step, 200, null).length, 1, "an answer that is not JSON");
  assert.equal(checkControl(step, 500, { ok: true }).length, 1);
});
test("the enabled sweep must actually find Bravo; the sweep after the switch-off must find nothing", () => {
  assert.deepEqual(checkExpect(ENABLED, sweep([BRAVO])), []);
  assert.deepEqual(checkExpect(DISABLED, sweep([])), []);
  assert.match(checkExpect(ENABLED, sweep([]))[0], /^expected found \[\{"ip":"127\.0\.0\.3".*\], got \[\]$/, "the enable step did nothing");
  assert.match(checkExpect(DISABLED, sweep([BRAVO]))[0], /^expected found \[\], got \[\{"ip":"127\.0\.0\.3"/, "the switch-off did nothing");
  assert.equal(checkExpect(ENABLED, sweep([{ ...BRAVO, connector: "creality-klipper" }])).length, 1, "found by the wrong connector");
});
test("status, record count, a missing done record, a malformed record and a non-NDJSON answer are each reported; an unknown expectation is refused", () => {
  assert.deepEqual(checkExpect({ id: "x", expect: { status: 401 } }, { status: 200 }), ["expected HTTP 401, got 200"]);
  assert.deepEqual(checkExpect({ id: "x", expect: { ndjsonRecords: 9 } }, sweep([])), ["expected 9 NDJSON records, got 3"]);
  const noDone = { status: 200, ndjson: parseNdjson('{"scanned":0}\n{"scanned":4}\n') };
  assert.match(checkExpect(DISABLED, noDone).join("|"), /expected 3 NDJSON records, got 2\|expected a final done record/);
  assert.match(checkExpect(DISABLED, { status: 200, ndjson: parseNdjson('{"scanned":0}\n{oops\n{"done":true,"found":[]}\n') })[0], /malformed or unterminated/);
  assert.match(checkExpect(DISABLED, { status: 400, contentType: "application/json" }).join("|"), /expected HTTP 200, got 400\|expected an NDJSON answer, got application\/json/);
  assert.deepEqual(checkExpect({ id: "x", expect: { satus: 200 } }, { status: 200 }), ['unknown expectation "satus"']);
  assert.deepEqual(checkExpect({ id: "x" }, { status: 500 }), [], "no expectation declared: nothing checked here");
});
test("a run that recorded such an error fails verification even when all three runs are identical", () => {
  const run = (label, errors) => ({ label, isolation: { ok: true }, errors, printerRequests: {}, files: [], audit: [], logs: [], lifecycle: [],
    results: [{ id: "finds-bravo", method: "GET", path: "/api/discover", ...sweep([]) }] });
  const vol = { results: {}, logs: { exactStepPrefixes: [], linePatterns: [] } };
  const err = ["finds-bravo: " + checkExpect(ENABLED, sweep([]))[0]];
  const identical = compareRuns(run("base1", err), run("base2", err), run("head", err), vol);
  assert.equal(identical.results[0].status, "PASS", "the three runs do agree with each other…");
  assert.equal(identical.status, "FAIL", "…and the verification still fails");
  assert.deepEqual(identical.errors.head, err);
  assert.equal(compareRuns(run("base1", []), run("base2", []), run("head", err), vol).status, "FAIL", "an error in one run is enough");
  const ctl = ['control step for printer "bravo" (/__control/set) was not acknowledged: HTTP 404 {"error":"no such control"}'];
  assert.equal(compareRuns(run("base1", ctl), run("base2", ctl), run("head", ctl), vol).status, "FAIL", "a failed control step blocks too");
});
