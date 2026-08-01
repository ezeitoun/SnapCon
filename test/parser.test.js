// test/parser.test.js — regression tests for:
//  - C-2: catastrophic backtracking in the old CFG_RE regex (a comment line
//    with a long run of spaces and no "=" used to take seconds-to-minutes;
//    matchCfgLine() replaces it with a linear-time hand-parse).
//  - H-1: an unrealistic T<n> body token (e.g. "T99999999999999999999")
//    used to inflate paletteCount into an effectively-infinite build loop,
//    and Math.max(...used) used to throw RangeError once a file had ~65,536+
//    distinct T<n> values (V8's apply-argument-count ceiling).
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseGcodeMap, normHex, _internal } = require("../parser");
const { matchCfgLine, MAX_REALISTIC_HEAD_INDEX } = _internal;

test("matchCfgLine still parses an ordinary '; key = value' comment", () => {
  const m = matchCfgLine("; filament_colour = #FF0000;#00FF00");
  assert.deepEqual(m, { key: "filament_colour", value: "#FF0000;#00FF00" });
});

test("matchCfgLine rejects a line with no '='", () => {
  assert.equal(matchCfgLine("; just a comment"), null);
});

test("matchCfgLine rejects a key containing a disallowed character", () => {
  assert.equal(matchCfgLine("; weird#key = value"), null);
});

test("a long run of spaces with no '=' parses in well under a second (was a multi-second-plus ReDoS)", () => {
  const line = ";" + " ".repeat(50000);
  const start = Date.now();
  const result = matchCfgLine(line);
  const elapsed = Date.now() - start;
  assert.equal(result, null);
  assert.ok(elapsed < 200, "expected linear-time parsing, took " + elapsed + "ms");
});

test("parseGcodeMap on a file whose config block is one giant space-only comment line stays fast", () => {
  const text = "G28\n;" + " ".repeat(50000) + "\nG1 X10\n";
  const start = Date.now();
  parseGcodeMap(text, { scanBody: false });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, "expected the whole parse to stay fast, took " + elapsed + "ms");
});

test("an unrealistically large T<n> body token is clamped, not used to inflate paletteCount", () => {
  const text = ["G28", "T99999999999999999999", "G1 X10"].join("\n");
  const start = Date.now();
  const result = parseGcodeMap(text, { scanBody: true });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, "must not attempt a huge allocation/loop, took " + elapsed + "ms");
  assert.ok(result.paletteCount <= MAX_REALISTIC_HEAD_INDEX + 2, "paletteCount must stay bounded: " + result.paletteCount);
});

test("a weight list with 70,000 entries no longer throws (Math.max(...used) RangeError)", () => {
  // The T<n> clamp above caps bodyUsed at MAX_REALISTIC_HEAD_INDEX+1
  // elements, so it can no longer reach V8's ~65,536 apply-argument-count
  // ceiling on its own — but the per-colour-weight path builds `used` from
  // the length of a semicolon-separated "filament used [g]" config value,
  // which isn't clamped at all. A config line with tens of thousands of
  // positive weight entries is what used to make Math.max(...used) throw.
  const weights = new Array(70000).fill("1").join(";");
  const text = "; filament used [g] = " + weights + "\nG28\n";
  const result = parseGcodeMap(text, { scanBody: false });
  assert.equal(result.paletteCount, 70000);
});

test("normHex is unaffected by the parser changes", () => {
  assert.equal(normHex("ff0000"), "#FF0000");
  assert.equal(normHex("not-a-color"), null);
});
