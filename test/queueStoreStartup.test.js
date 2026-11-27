// test/queueStoreStartup.test.js — the real `node server.js` process, started
// normally (no --load), still loads the queue store before it serves: the
// load was moved below the command-line block so that a --load call cannot
// touch queue files (that half is pinned in test/notifyCliProcess.test.js and
// test/transferStatus.test.js). Runs from a temporary directory of symlinks,
// like notifyCliProcess.test.js, with one simulator printer (no network I/O),
// so the repository and its data are never written.
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
const getJson = (port, url) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: url, timeout: 2000 }, res => { let b = ""; res.on("data", d => b += d); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); })
    .on("error", reject).on("timeout", function () { this.destroy(new Error("timeout")); });
});
const BACKUP = { p_sample0001: { queueState: "idle", queuePaused: true, queueStopped: false, reconciliationPending: false, attentionReason: null, attentionDetail: null, queue: [], currentItem: null, recentHistory: [], updatedAt: 1 } };

async function boot(t, dataFiles) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-qstart-"));
  for (const e of fs.readdirSync(ROOT)) if (!NOT_LINKED.test(e)) fs.symlinkSync(path.join(ROOT, e), path.join(dir, e));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port, printers: [{ id: "p_sample0001", name: "Sim A", connector: "dummy-simulator" }] }));
  fs.mkdirSync(path.join(dir, "data"));
  for (const [n, c] of Object.entries(dataFiles)) fs.writeFileSync(path.join(dir, "data", n), c);
  const child = spawn(process.execPath, ["--preserve-symlinks", "--preserve-symlinks-main", path.join(dir, "server.js")], { cwd: os.tmpdir(), stdio: "ignore" });
  t.after(async () => { child.kill("SIGKILL"); await new Promise(r => child.once("exit", r)); fs.rmSync(dir, { recursive: true, force: true }); });
  let status = null;
  for (let i = 0; i < 100 && !status; i++) { try { status = await getJson(port, "/api/queue-store/status"); } catch { await new Promise(r => setTimeout(r, 200)); } }
  assert.ok(status, "the server answered within 20 s");
  return { port, dir, status, data: n => fs.readFileSync(path.join(dir, "data", n), "utf8"), names: () => fs.readdirSync(path.join(dir, "data")).filter(n => n.startsWith("queue-data")).sort() };
}

test("normal start-up loads the queue store: a valid queue file is served as it is and left untouched", { skip }, async t => {
  const text = JSON.stringify(BACKUP, null, 2);
  const s = await boot(t, { "queue-data.json": text });
  assert.equal(s.status.queueStoreRecoveryRequired, false);
  assert.equal(s.status.storeDegraded, false);
  const q = await getJson(s.port, "/api/queue/p_sample0001");
  assert.equal(q.queueState, "idle");
  assert.equal(q.queuePaused, true, "the state came from the file, not from a default");
  assert.equal(s.data("queue-data.json"), text);
  assert.deepEqual(s.names(), ["queue-data.json"]);
});

test("normal start-up still performs the queue store's recovery: corrupt primary, good backup, unfinished save", { skip }, async t => {
  const s = await boot(t, { "queue-data.json": "{ corrupt", "queue-data.json.bak": JSON.stringify(BACKUP), "queue-data.json.tmp": "{half" });
  assert.equal(s.status.queueStoreRecoveryRequired, false);
  assert.equal(s.status.storeDegraded, false);
  assert.equal(s.status.saveBlocked, null);
  assert.equal((await getJson(s.port, "/api/queue/p_sample0001")).queuePaused, true, "the backup's state is what the server holds");
  assert.deepEqual(JSON.parse(s.data("queue-data.json")), BACKUP, "the primary was replaced from the backup");
  assert.equal(s.data("queue-data.json.bak"), JSON.stringify(BACKUP), "the backup itself was not rewritten");
  const names = s.names();
  assert.equal(names.filter(n => n.startsWith("queue-data.json.corrupt-")).length, 1, "the corrupt file was kept");
  assert.equal(names.filter(n => n.startsWith("queue-data.json.tmp.leftover-")).length, 1, "the unfinished save was kept");
  assert.equal(s.data(names.find(n => n.startsWith("queue-data.json.tmp.leftover-"))), "{half");
});
