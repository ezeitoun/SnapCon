// auth.js — optional User Access Management: password/OTP sessions + role
// guards. Every piece here is inert unless CFG.usersEnabled is true — see
// makeAuthMiddleware's first branch, which is the entire back-compat story.
const crypto = require("crypto");

const SESSION_COOKIE = "sc_session";
const SESSION_IDLE_MS = 18 * 60 * 60 * 1000; // ~18h sliding idle timeout
const SWEEP_MS = 60 * 1000;

const SESSIONS = new Map(); // token -> { userId, lastSeenAt }

const newToken = () => crypto.randomBytes(24).toString("hex");
const newUserId = () => "u_" + crypto.randomBytes(6).toString("hex");

// ---- Passwords: scrypt, stored as "scrypt:N:r:p:saltHex:hashHex" ----
// Async (crypto.scrypt, not scryptSync): this is a real-time printer-control
// app polling /api/fleet on a 2s interval for every open tab — a sync scrypt
// call would stall that event loop for every other user on every login.
const { promisify } = require("util");
const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

// Returns false immediately (no scrypt call) when stored is null/blank — a
// fresh OTP-only account has no passwordHash yet. (An account that later
// switches to OTP keeps its old passwordHash on file, unused; server.js
// blocks password login for it directly by checking otpEnabled first.)
async function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = await scryptAsync(password, salt, expected.length, { N: +N, r: +r, p: +p });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

// ---- Cookies: hand-rolled parser, no dependency ----
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  });
  return out;
}

// ---- Sessions: in-memory only, same simplification as JOBS/offlineCache/camState ----
function createSession(userId) {
  const token = newToken();
  SESSIONS.set(token, { userId, lastSeenAt: Date.now() });
  return token;
}
function destroySession(token) { SESSIONS.delete(token); }
function touchSession(token) {
  const s = SESSIONS.get(token);
  if (s) s.lastSeenAt = Date.now();
  return s;
}
setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [token, s] of SESSIONS) if (s.lastSeenAt < cutoff) SESSIONS.delete(token);
}, SWEEP_MS).unref();

// ---- OTP codes: 8-char, excludes 0/O/1/I, 10-min TTL, 5-attempt cap ----
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const OTP_CODES = new Map(); // loginNameLower -> { code, expiresAt, attempts }

function generateOtpCode() {
  const buf = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < buf.length; i++) out += OTP_ALPHABET[buf[i] % OTP_ALPHABET.length];
  return out;
}
function setOtpCode(loginNameLower) {
  const code = generateOtpCode();
  OTP_CODES.set(loginNameLower, { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
  return code;
}
function verifyOtpCode(loginNameLower, code) {
  const entry = OTP_CODES.get(loginNameLower);
  if (!entry) return { ok: false, error: "Request a new code" };
  if (Date.now() > entry.expiresAt) { OTP_CODES.delete(loginNameLower); return { ok: false, error: "Code expired — request a new one" }; }
  if (entry.attempts >= OTP_MAX_ATTEMPTS) { OTP_CODES.delete(loginNameLower); return { ok: false, error: "Too many attempts — request a new code" }; }
  entry.attempts++;
  if (String(code || "").toUpperCase() !== entry.code) return { ok: false, error: "Incorrect code" };
  OTP_CODES.delete(loginNameLower);
  return { ok: true };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of OTP_CODES) if (now > v.expiresAt) OTP_CODES.delete(k);
}, SWEEP_MS).unref();

// ---- Middleware ----
// getCfg()/getUsers() are passed as closures (not imported) so this module
// never has to know about server.js's CFG/USERS globals or loadConfig/loadUsers
// timing — it just reads whatever the caller currently has live.
// Shared by both the login handlers (setting a new cookie) and the middleware
// below (sliding an existing one) so the browser-side expiry and the
// server-side idle sweep can never drift apart.
function sessionCookieOptions() {
  return { httpOnly: true, sameSite: "lax", maxAge: SESSION_IDLE_MS };
}

function makeAuthMiddleware(getCfg, getUsers) {
  return function authMiddleware(req, res, next) {
    const cfg = getCfg();
    if (!cfg.usersEnabled) { req.user = { role: "admin", implicit: true }; return next(); }
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    const session = token && touchSession(token);
    if (!session) { req.user = null; return next(); }
    const users = getUsers();
    const u = users.find(u => u.id === session.userId);
    if (!u) { req.user = null; return next(); }
    req.user = { id: u.id, loginName: u.loginName, firstName: u.firstName, lastName: u.lastName, role: u.role };
    req.sessionToken = token;
    // Refresh the cookie's expiry on every authenticated request — without
    // this, the browser drops the cookie 18h after LOGIN even for a
    // continuously-active user, even though the server-side session (via
    // touchSession above) genuinely slides and would have kept it alive.
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Login required" });
  next();
}
function requireRegular(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Login required" });
  if (req.user.role !== "regular" && req.user.role !== "admin") return res.status(403).json({ error: "Insufficient permissions" });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Login required" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

module.exports = {
  SESSION_COOKIE, SESSION_IDLE_MS, SESSIONS, OTP_CODES,
  newUserId,
  hashPassword, verifyPassword, parseCookies,
  createSession, destroySession, touchSession, sessionCookieOptions,
  setOtpCode, verifyOtpCode,
  makeAuthMiddleware, requireAuth, requireRegular, requireAdmin
};
