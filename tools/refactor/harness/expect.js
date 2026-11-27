// tools/refactor/harness/expect.js — the checks a contract run makes on its
// OWN fixture, beyond comparing runs with each other: a control step sent to
// a fake printer must be acknowledged, and a request step may declare the
// outcome the fixture was built to produce ("expect"). Every problem is an
// error of the run, and a run with errors fails verification.
// Runs inside the harness container (run-in-container.js) and in the tools'
// own tests.
"use strict";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The fake printer acknowledges a control request with 200 {"ok":true}.
function checkControl(step, status, json) {
  if (status === 200 && json && json.ok === true) return [];
  return [`control step for printer "${step.printer}" (${step.path || "/__control/set"}) was not acknowledged: HTTP ${status} ${JSON.stringify(json)}`];
}

// step.expect: { status?, ndjsonRecords?, found? }
//   status         the HTTP status;
//   ndjsonRecords  the number of NDJSON records, none malformed, newline-terminated;
//   found          the `found` list of the final ("done") NDJSON record, exactly.
function checkExpect(step, result) {
  const e = step.expect;
  if (!e) return [];
  const out = [], known = new Set(["status", "ndjsonRecords", "found"]);
  for (const k of Object.keys(e)) if (!known.has(k)) out.push(`unknown expectation "${k}"`);
  if (e.status !== undefined && result.status !== e.status) out.push(`expected HTTP ${e.status}, got ${result.status}`);
  if (e.ndjsonRecords !== undefined || e.found !== undefined) {
    const nd = result.ndjson;
    if (!nd) out.push("expected an NDJSON answer, got " + (result.contentType || "no content type"));
    else {
      if (nd.records.some(r => !r.ok) || (nd.count && !nd.endsWithNewline)) out.push("the NDJSON answer has a malformed or unterminated record");
      if (e.ndjsonRecords !== undefined && nd.count !== e.ndjsonRecords) out.push(`expected ${e.ndjsonRecords} NDJSON records, got ${nd.count}`);
      if (e.found !== undefined) {
        const last = nd.records[nd.records.length - 1];
        const done = last && last.ok && last.value && last.value.done === true ? last.value : null;
        if (!done) out.push("expected a final done record, got " + JSON.stringify(last));
        else if (!same(done.found, e.found)) out.push(`expected found ${JSON.stringify(e.found)}, got ${JSON.stringify(done.found)}`);
      }
    }
  }
  return out;
}
module.exports = { checkControl, checkExpect };
