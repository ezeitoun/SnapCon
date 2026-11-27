// test/sessionThemeRoute.test.js — POST /api/session/theme on the real
// `node server.js` process: a signed-in user of any role saves "light" or
// "dark" for their own account; every other value is refused with 400 and
// nothing is written. "awareness" (a third theme, removed 2026-11-27) is one
// of those other values now.
// Runs from a temporary directory of symlinks with one simulator printer (no
// network I/O), like queuePoolRoutes.test.js; the repository is never written.
// The two accounts and their passwords are made up for this test.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const { spawn } = require("child_process");
const auth = require("../auth");

const ROOT = path.join(__dirname, "..");
const NOT_LINKED = /^(config\.json.*|users\.json|data|gcode|notify-token\.json|.*-data|locales|\.git|dist|queued-files\.json)$/;
const skip = process.platform === "win32" ? "symlinks need privileges on Windows" : false;
const REFUSED = "theme must be \"light\" or \"dark\"";
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const call = (port, method, url, { body, cookie } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const headers = {};
  if (data) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(data); }
  if (cookie) headers.cookie = cookie;
  const req = http.request({ host: "127.0.0.1", port, path: url, method, timeout: 5000, headers },
    res => { let b = ""; res.on("data", d => b += d); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(b), setCookie: res.headers["set-cookie"] || [] }); } catch (e) { reject(e); } }); });
  req.on("error", reject).on("timeout", () => req.destroy(new Error("timeout")));
  req.end(data || undefined);
});

async function boot(t, { users } = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-theme-"));
  for (const e of fs.readdirSync(ROOT)) if (!NOT_LINKED.test(e)) fs.symlinkSync(path.join(ROOT, e), path.join(dir, e));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port, usersEnabled: !!users, printers: [{ id: "p_sample0001", name: "Sim A", connector: "dummy-simulator" }] }));
  const usersPath = path.join(dir, "users.json");
  if (users) fs.writeFileSync(usersPath, JSON.stringify({ users }, null, 2));
  const child = spawn(process.execPath, ["--preserve-symlinks", "--preserve-symlinks-main", path.join(dir, "server.js")], { cwd: os.tmpdir(), stdio: "ignore" });
  t.after(async () => { child.kill("SIGKILL"); await new Promise(r => child.once("exit", r)); fs.rmSync(dir, { recursive: true, force: true }); });
  let up = null;
  for (let i = 0; i < 100 && !up; i++) { try { up = await call(port, "GET", "/api/session"); } catch { await new Promise(r => setTimeout(r, 200)); } }
  assert.ok(up, "the server answered within 20 s");
  const stored = () => JSON.parse(fs.readFileSync(usersPath, "utf8")).users;
  const raw = () => fs.existsSync(usersPath) ? fs.readFileSync(usersPath, "utf8") : null;
  return { port, up: up.body, stored, raw };
}

async function account(loginName, role, password) {
  const now = "2026-01-01T00:00:00.000Z";
  return { id: "u_" + loginName, firstName: "", lastName: "", loginName, loginNameLower: loginName.toLowerCase(), email: "", phone: "",
    role, otpEnabled: false, passwordHash: await auth.hashPassword(password), groupIds: [], createdAt: now, updatedAt: now };
}

test("a signed-in user saves light or dark for their own account; any other value, the removed awareness included, is refused and nothing is written", { skip }, async t => {
  const s = await boot(t, { users: [await account("viewer", "view", "synthetic-viewer-pass"), await account("boss", "admin", "synthetic-admin-pass")] });
  assert.equal(s.up.usersEnabled, true);
  const save = (theme, cookie) => call(s.port, "POST", "/api/session/theme", { body: theme === undefined ? {} : { theme }, cookie });
  const mine = () => s.stored().find(u => u.loginName === "viewer");

  // Not signed in: nothing is saved for anyone.
  const before = s.raw();
  const anon = await save("dark");
  assert.equal(anon.status, 401);
  assert.equal(s.raw(), before);

  // The lowest role is enough: the choice is the user's own.
  const login = await call(s.port, "POST", "/api/login", { body: { loginName: "viewer", password: "synthetic-viewer-pass" } });
  assert.equal(login.status, 200);
  const cookie = login.setCookie.map(c => c.split(";")[0]).join("; ");
  assert.match(cookie, new RegExp("^" + auth.SESSION_COOKIE + "="));

  for (const bad of ["awareness", "Dark", "", "auto", undefined, 1, null, ["dark"]]) {
    const r = await save(bad, cookie);
    assert.deepEqual([r.status, r.body.error], [400, REFUSED], "refused: " + JSON.stringify(bad));
    assert.equal(s.raw(), before, "nothing written for " + JSON.stringify(bad));
  }

  for (const good of ["dark", "light"]) {
    const r = await save(good, cookie);
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    assert.equal(mine().theme, good, "stored for the user");
    assert.equal((await call(s.port, "GET", "/api/session", { cookie })).body.user.theme, good, "and given back with the session");
  }
  assert.equal("theme" in s.stored().find(u => u.loginName === "boss"), false, "no other account is touched");

  // A refused value leaves the saved one as it is.
  const afterLight = s.raw();
  assert.equal((await save("awareness", cookie)).status, 400);
  assert.equal(s.raw(), afterLight);
  assert.equal(mine().theme, "light");
});

test("with User Access Management off there is no account to save a theme for: 400, whatever the value, and no users file appears", { skip }, async t => {
  const s = await boot(t);
  assert.equal(s.up.usersEnabled, false);
  for (const theme of ["dark", "light", "awareness"]) {
    const r = await call(s.port, "POST", "/api/session/theme", { body: { theme } });
    assert.deepEqual([r.status, r.body.error], [400, "Per-user theme requires User Access Management"]);
  }
  assert.equal(s.raw(), null);
});
