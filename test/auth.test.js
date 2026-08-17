// test/auth.test.js — unit tests for auth.js's OTP verification outcomes,
// specifically the additive `code` field added for Phase 11 (Login/Auth
// i18n). auth.js has no BASE_DIR/Express dependency, so this is directly
// requireable and testable without spinning up server.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const auth = require("../auth");

test("verifyOtpCode: no pending code for this login returns code=otp_verify_request_new, error text unchanged", () => {
  const result = auth.verifyOtpCode("nobody-has-ever-requested-this@test", "ABCD1234");
  assert.equal(result.ok, false);
  assert.equal(result.code, "otp_verify_request_new");
  assert.equal(result.error, "Request a new code");
});

test("verifyOtpCode: expired code returns code=otp_verify_expired, error text unchanged", () => {
  const loginNameLower = "expired-test-user";
  auth.setOtpCode(loginNameLower);
  // Force expiry by rewriting the entry directly — OTP_TTL_MS is 10 minutes,
  // too long to wait for in a test.
  auth.OTP_CODES.set(loginNameLower, { code: "AAAAAAAA", expiresAt: Date.now() - 1, attempts: 0 });
  const result = auth.verifyOtpCode(loginNameLower, "AAAAAAAA");
  assert.equal(result.ok, false);
  assert.equal(result.code, "otp_verify_expired");
  assert.equal(result.error, "Code expired — request a new one");
});

test("verifyOtpCode: exceeding the attempt cap returns code=otp_verify_too_many_attempts, error text unchanged", () => {
  const loginNameLower = "too-many-attempts-test-user";
  const code = auth.setOtpCode(loginNameLower);
  auth.OTP_CODES.set(loginNameLower, { code, expiresAt: Date.now() + 60000, attempts: 5 });
  const result = auth.verifyOtpCode(loginNameLower, code);
  assert.equal(result.ok, false);
  assert.equal(result.code, "otp_verify_too_many_attempts");
  assert.equal(result.error, "Too many attempts — request a new code");
});

test("verifyOtpCode: wrong code returns code=otp_verify_incorrect, error text unchanged — same code/string the unknown-login-name branch in server.js uses directly, preserving today's anti-enumeration equivalence", () => {
  const loginNameLower = "wrong-code-test-user";
  auth.setOtpCode(loginNameLower);
  const result = auth.verifyOtpCode(loginNameLower, "THEWRONGCODE");
  assert.equal(result.ok, false);
  assert.equal(result.code, "otp_verify_incorrect");
  assert.equal(result.error, "Incorrect code");
});

test("verifyOtpCode: correct code succeeds and carries no error/code fields", () => {
  const loginNameLower = "correct-code-test-user";
  const code = auth.setOtpCode(loginNameLower);
  const result = auth.verifyOtpCode(loginNameLower, code.toLowerCase()); // case-insensitive, matches existing .toUpperCase() behavior
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.equal(result.code, undefined);
});

test("verifyOtpCode: the four failure codes are pairwise distinct — a translation keyed on `code` can never conflate two different outcomes", () => {
  const codes = new Set(["otp_verify_request_new", "otp_verify_expired", "otp_verify_too_many_attempts", "otp_verify_incorrect"]);
  assert.equal(codes.size, 4);
});
