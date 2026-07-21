const test = require("node:test");
const assert = require("node:assert/strict");
const { redact } = require("../../remote-access/redact");

test("redact() replaces an exact secret match in a log line", () => {
  const out = redact("connecting with token abcdef123456 now", ["abcdef123456"]);
  assert.ok(!out.includes("abcdef123456"));
  assert.match(out, /\[redacted\]/);
});

test("redact() handles multiple secrets and multiple occurrences", () => {
  const out = redact("key1=SECRETONE key2=SECRETTWO again=SECRETONE", ["SECRETONE", "SECRETTWO"]);
  assert.ok(!out.includes("SECRETONE"));
  assert.ok(!out.includes("SECRETTWO"));
});

test("redact() is a no-op when the secret does not appear", () => {
  const out = redact("nothing sensitive here", ["some-token-value"]);
  assert.equal(out, "nothing sensitive here");
});

test("redact() ignores empty/short/undefined secrets rather than over-redacting trivial substrings", () => {
  const out = redact("a e i o u", ["", undefined, "a"]);
  assert.equal(out, "a e i o u");
});

test("redact() passes through non-string input unchanged", () => {
  assert.equal(redact(null, ["x"]), null);
  assert.equal(redact(undefined, ["x"]), undefined);
});

test("redact() applied to a constructed error message never leaks a token embedded in it", () => {
  const token = "tok_live_abcdef0123456789";
  const message = "Backend rejected tunnel token " + token + " with 401";
  const safe = redact(message, [token]);
  assert.ok(!safe.includes(token));
});
