// tools/refactor/harness/ndjson.js — parses an NDJSON response body into its
// records, in order, for the contract harness. Nothing is skipped or
// repaired: a line that is not JSON (an empty line included) is kept as a
// malformed record, and a body that does not end with a newline is reported.
// Runs inside the harness container (run-in-container.js) and in the tools'
// own tests.
"use strict";
function parseNdjson(body) {
  const text = String(body == null ? "" : body);
  const endsWithNewline = text.endsWith("\n");
  const parts = text.split("\n");
  if (endsWithNewline) parts.pop();
  const records = text === "" ? [] : parts.map(line => {
    try { return { ok: true, value: JSON.parse(line) }; }
    catch { return { ok: false, raw: line.slice(0, 500) }; }
  });
  return { count: records.length, endsWithNewline, records };
}
module.exports = { parseNdjson };
