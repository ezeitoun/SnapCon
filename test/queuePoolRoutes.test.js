// test/queuePoolRoutes.test.js — POST /api/printer-pool and
// POST /api/queue-management/enable on the real `node server.js` process:
// refused with 503 and nothing changed while the queue store cannot save,
// and config.json and the queue store agreeing when it can. The half-done
// cases (one save works, the other fails) are in test/queue/poolChange.test.js.
// Runs from a temporary directory of symlinks with simulator printers (no
// network I/O), like queueStoreStartup.test.js; the repository is never written.
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
const skip = process.platform === "win32" ? "symlinks need privileges on Windows" : false;
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const call = (port, method, url, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: "127.0.0.1", port, path: url, method, timeout: 5000, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
    res => { let b = ""; res.on("data", d => b += d); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { reject(e); } }); });
  req.on("error", reject).on("timeout", () => req.destroy(new Error("timeout")));
  req.end(data || undefined);
});

async function boot(t, dataFiles) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-qpool-"));
  for (const e of fs.readdirSync(ROOT)) if (!NOT_LINKED.test(e)) fs.symlinkSync(path.join(ROOT, e), path.join(dir, e));
  const cfgPath = path.join(dir, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ port, printers: [{ id: "p_sample0001", name: "Sim A", connector: "dummy-simulator" }, { id: "p_sample0002", name: "Sim B", connector: "dummy-simulator" }] }));
  fs.mkdirSync(path.join(dir, "data"));
  for (const [n, c] of Object.entries(dataFiles)) fs.writeFileSync(path.join(dir, "data", n), c);
  const child = spawn(process.execPath, ["--preserve-symlinks", "--preserve-symlinks-main", path.join(dir, "server.js")], { cwd: os.tmpdir(), stdio: "ignore" });
  t.after(async () => { child.kill("SIGKILL"); await new Promise(r => child.once("exit", r)); fs.rmSync(dir, { recursive: true, force: true }); });
  let up = null;
  for (let i = 0; i < 100 && !up; i++) { try { up = await call(port, "GET", "/api/queue-store/status"); } catch { await new Promise(r => setTimeout(r, 200)); } }
  assert.ok(up, "the server answered within 20 s");
  const queueFiles = () => Object.fromEntries(fs.readdirSync(path.join(dir, "data")).filter(n => n.startsWith("queue-data")).sort().map(n => [n, fs.readFileSync(path.join(dir, "data", n), "utf8")]));
  return { port, dir, cfg: () => JSON.parse(fs.readFileSync(cfgPath, "utf8")), cfgText: () => fs.readFileSync(cfgPath, "utf8"), queueFiles, status: up.body };
}

test("recovery required: enabling Queue Management and changing a pool are refused with 503, and neither config.json nor any queue file changes", { skip }, async t => {
  const s = await boot(t, { "queue-data.json": "{ corrupt", "queue-data.json.bak": "also { corrupt" });
  assert.equal(s.status.queueStoreRecoveryRequired, true);
  const cfg = s.cfgText(), files = s.queueFiles();
  for (const [url, body] of [["/api/queue-management/enable", {}], ["/api/printer-pool", { printerId: "p_sample0001", printerPoolId: null }]]) {
    const r = await call(s.port, "POST", url, body);
    assert.deepEqual([r.status, r.body.code], [503, "queue_store_unavailable"], url);
  }
  assert.equal(s.cfgText(), cfg);
  assert.deepEqual(s.queueFiles(), files);
  assert.equal((await call(s.port, "GET", "/api/queue-management/status")).body.enabled, false);
  assert.equal((await call(s.port, "GET", "/api/queue/p_sample0001")).body.queueState, "unmanaged");
});

test("healthy store: enabling manages every printer in the store and in config.json, and a pool change keeps the two in step", { skip }, async t => {
  const s = await boot(t, {});
  assert.equal((await call(s.port, "POST", "/api/queue-management/enable", {})).status, 200);
  let cfg = s.cfg(), q = JSON.parse(s.queueFiles()["queue-data.json"]);
  assert.equal(cfg.queueManagement.enabled, true);
  assert.deepEqual(cfg.printers.map(p => p.printerPoolId), ["qp_default_manual", "qp_default_manual"]);
  assert.ok(cfg.printerPools.some(p => p.id === "qp_default_manual"));
  assert.deepEqual([q.p_sample0001.queueState, q.p_sample0002.queueState], ["idle", "idle"]);

  const out = await call(s.port, "POST", "/api/printer-pool", { printerId: "p_sample0002", printerPoolId: null });
  assert.deepEqual([out.status, out.body.printerPoolId], [200, null]);
  cfg = s.cfg(); q = JSON.parse(s.queueFiles()["queue-data.json"]);
  assert.deepEqual(cfg.printers.map(p => p.printerPoolId), ["qp_default_manual", undefined]);
  assert.deepEqual([q.p_sample0001.queueState, q.p_sample0002.queueState], ["idle", "unmanaged"]);

  // Off and on again: nothing else differs, and "on" is still written to config.json.
  assert.equal((await call(s.port, "POST", "/api/queue-management/disable", {})).status, 200);
  assert.equal(s.cfg().queueManagement.enabled, false);
  assert.equal((await call(s.port, "POST", "/api/queue-management/enable", {})).status, 200);
  assert.equal(s.cfg().queueManagement.enabled, true);
});

test("switching Queue Management off or on when config.json cannot be saved is an error and is not applied (not answered as done)", { skip: skip || (process.getuid && process.getuid() === 0 ? "root ignores file permissions" : false) }, async t => {
  const s = await boot(t, {});
  assert.equal((await call(s.port, "POST", "/api/queue-management/enable", {})).status, 200);
  const cfgPath = path.join(s.dir, "config.json");
  fs.chmodSync(cfgPath, 0o444);
  t.after(() => { try { fs.chmodSync(cfgPath, 0o644); } catch {} });
  const off = await call(s.port, "POST", "/api/queue-management/disable", {});
  assert.deepEqual([off.status, off.body.code], [500, "config_save_failed"]);
  assert.equal((await call(s.port, "GET", "/api/queue-management/status")).body.enabled, true, "still on, as config.json says");

  // And the other way round: off on disk, the switch-on cannot be saved -> undone in the queue store too.
  fs.chmodSync(cfgPath, 0o644);
  assert.equal((await call(s.port, "POST", "/api/queue-management/disable", {})).status, 200);
  assert.equal((await call(s.port, "POST", "/api/printer-pool", { printerId: "p_sample0001", printerPoolId: null })).status, 200);
  fs.chmodSync(cfgPath, 0o444);
  const on = await call(s.port, "POST", "/api/queue-management/enable", {});
  assert.deepEqual([on.status, on.body.code], [500, "config_save_failed"]);
  assert.equal((await call(s.port, "GET", "/api/queue-management/status")).body.enabled, false);
  assert.equal(JSON.parse(s.queueFiles()["queue-data.json"]).p_sample0001.queueState, "unmanaged", "the printer this call managed is unmanaged again");
  const pool = await call(s.port, "POST", "/api/printer-pool", { printerId: "p_sample0002", printerPoolId: null });
  assert.deepEqual([pool.status, pool.body.code], [500, "config_save_failed"]);
  assert.equal(JSON.parse(s.queueFiles()["queue-data.json"]).p_sample0002.queueState, "idle", "the pool change was undone in the queue store");
});
