// test/queueRetrySaveRoute.test.js — POST /api/queue-store/retry-save on the
// real `node server.js` process when the data folder cannot be written: a
// failed retry answers with a short text and the error code only — never the
// raw error object, never a path on the server.
// Runs from a temporary directory of symlinks with one simulator printer (no
// network I/O), like queuePoolRoutes.test.js; the repository is never written.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const NOT_LINKED = /^(config\.json.*|users\.json|data|gcode|notify-token\.json|.*-data|locales|\.git|dist|queued-files\.json)$/;
const skip = process.platform === "win32" ? "symlinks need privileges on Windows" : (process.getuid && process.getuid() === 0 ? "root ignores folder permissions" : false);
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const call = (port, method, url, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: "127.0.0.1", port, path: url, method, timeout: 5000, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
    res => { let b = ""; res.on("data", d => b += d); res.on("end", () => { try { resolve({ status: res.statusCode, text: b, body: JSON.parse(b) }); } catch (e) { reject(e); } }); });
  req.on("error", reject).on("timeout", () => req.destroy(new Error("timeout")));
  req.end(data || undefined);
});
async function boot(t, dataFiles) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-qfail-"));
  for (const e of fs.readdirSync(ROOT)) if (!NOT_LINKED.test(e)) fs.symlinkSync(path.join(ROOT, e), path.join(dir, e));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port, printers: [{ id: "p_sample0001", name: "Sim A", connector: "dummy-simulator" }] }));
  const data = path.join(dir, "data");
  fs.mkdirSync(data);
  for (const [n, c] of Object.entries(dataFiles)) fs.writeFileSync(path.join(data, n), c);
  const child = spawn(process.execPath, ["--preserve-symlinks", "--preserve-symlinks-main", path.join(dir, "server.js")], { cwd: os.tmpdir(), stdio: "ignore" });
  t.after(async () => { child.kill("SIGKILL"); await new Promise(r => child.once("exit", r)); try { fs.chmodSync(data, 0o755); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  let up = null;
  for (let i = 0; i < 100 && !up; i++) { try { up = await call(port, "GET", "/api/queue-store/status"); } catch { await new Promise(r => setTimeout(r, 200)); } }
  assert.ok(up, "the server answered within 20 s");
  const files = () => Object.fromEntries(fs.readdirSync(data).filter(n => n.startsWith("queue-data")).sort().map(n => [n, fs.readFileSync(path.join(data, n)).toString("hex")]));
  return { port, dir, data, files };
}

test("a retry that fails answers with a short text and the error code — not the error object, and no path on the server", { skip }, async t => {
  const s = await boot(t, {});
  fs.chmodSync(s.data, 0o555);
  const r = await call(s.port, "POST", "/api/queue-store/retry-save", {});
  assert.equal(r.body.ok, false);
  assert.equal(typeof r.body.error, "string");
  assert.deepEqual([r.body.code, r.body.reason], ["queue_save_retry_failed", "EACCES"]);
  assert.equal(r.text.includes(s.dir) || /errno|syscall|[\\/]/.test(r.text), false, r.text);
  fs.chmodSync(s.data, 0o755);
  assert.deepEqual((await call(s.port, "POST", "/api/queue-store/retry-save", {})).body, { ok: true });
});
