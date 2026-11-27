// tools/refactor/harness/run-in-container.js — runs ONE SnapCon copy against
// fake printers and replays a request set. Runs only INSIDE the isolated
// harness container (--network none): SnapCon, the fake printers and this
// replayer share the container's loopback-only network namespace.
//   node /harness/run-in-container.js --label <name> --requests <file> [--requests <file> …]
// Reads the app source from /src (read-only), works in /tmp, writes
// /out/<label>.json. Aborts before starting anything if the isolation
// self-check fails. Node built-ins only.
"use strict";
const fs = require("fs");
const os = require("os");
const net = require("net");
const dns = require("dns");
const path = require("path");
const { spawn } = require("child_process");
const { createFakePrinter } = require("./fake-moonraker");
const { parseNdjson } = require("./ndjson");
const { checkControl, checkExpect } = require("./expect");

const arg = (n, all = false) => { const v = []; process.argv.forEach((a, i) => { if (a === n) v.push(process.argv[i + 1]); }); return all ? v : v[0]; };
const LABEL = arg("--label"), REQUESTS = arg("--requests", true);
const SRC = "/src", APP = "/tmp/app", OUT = "/out", PORT = 4545;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- isolation self-check: must fail closed ----------
async function isolationCheck() {
  const ifaces = os.networkInterfaces();
  const nonLoop = Object.entries(ifaces).filter(([, a]) => a.some(x => !x.internal)).map(([n]) => n);
  const tryConnect = (host, port) => new Promise(resolve => {
    const s = net.connect({ host, port, timeout: 2000 });
    s.on("connect", () => { s.destroy(); resolve("CONNECTED"); });
    s.on("timeout", () => { s.destroy(); resolve("timeout"); });
    s.on("error", e => resolve(e.code || e.message));
  });
  // Generic private-network, internet and metadata targets, plus this
  // machine's own LAN targets (NAS, printers) passed in from the gitignored
  // tools/refactor/local/approved-paths.json — never written in tracked files.
  const extra = String(process.env.ISOLATION_EXTRA_TARGETS || "").split(",").filter(Boolean).map(t => { const i = t.lastIndexOf(":"); return [t.slice(0, i), Number(t.slice(i + 1))]; });
  const targets = [["192.168.0.1", 80], ["192.168.1.1", 80], ["10.0.0.1", 80], ["172.16.0.1", 80], ["1.1.1.1", 443], ["8.8.8.8", 53], ["169.254.169.254", 80], ...extra];
  const connects = {};
  for (const [h, p] of targets) connects[h + ":" + p] = await tryConnect(h, p);
  const lookup = await new Promise(r => dns.lookup("github.com", e => r(e ? e.code : "RESOLVED")));
  const ok = nonLoop.length === 0 && Object.values(connects).every(v => v !== "CONNECTED") && lookup !== "RESOLVED";
  return { ok, nonLoopbackInterfaces: nonLoop, interfaces: Object.keys(ifaces), connects, dnsGithub: lookup };
}

// ---------- the app copy and fixtures ----------
function copyDir(a, b) { fs.cpSync(a, b, { recursive: true }); }
async function prepareApp() {
  fs.rmSync(APP, { recursive: true, force: true });
  copyDir(SRC, APP);
  fs.symlinkSync("/deps/node_modules", path.join(APP, "node_modules"));
  fs.mkdirSync(path.join(APP, "gcode"), { recursive: true });
  const auth = require(path.join(APP, "auth.js"));
  const users = [
    { id: "u_admin", loginName: "admin", loginNameLower: "admin", firstName: "Ada", lastName: "Admin", role: "admin", groupIds: [], passwordHash: await auth.hashPassword("admin-pass-1") },
    { id: "u_view", loginName: "viewer", loginNameLower: "viewer", firstName: "Vic", lastName: "Viewer", role: "view", groupIds: [], passwordHash: await auth.hashPassword("viewer-pass-1") },
  ];
  fs.writeFileSync(path.join(APP, "users.json"), JSON.stringify({ users }, null, 2));
  const printers = [
    { id: "p_alpha", name: "Alpha", connector: "klipper-moonraker", url: "http://127.0.0.2:7125" },
    { id: "p_bravo", name: "Bravo", connector: "klipper-moonraker", url: "http://127.0.0.3:7125", allowedGroups: ["grp_staff"] },
    { id: "p_charlie", name: "Charlie", connector: "klipper-moonraker", url: "http://127.0.0.4:7125" },
  ];
  const cfg = { port: PORT, gcodeFolder: "./gcode", usersEnabled: true, checkForUpdates: false, gcodeSyncRetentionDays: 7,
    groups: [{ id: "grp_everyone", name: "Everyone", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "grp_staff", name: "Staff", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    printers };
  // Fail closed: every printer must be a loopback fake; no outbound feature on.
  for (const p of cfg.printers) if (!/^http:\/\/127\.0\.0\.\d+:\d+$/.test(p.url)) throw new Error("fixture printer not on loopback: " + p.url);
  if (cfg.checkForUpdates !== false || cfg.notifications || cfg.remoteAccess) throw new Error("fixture enables an outbound feature");
  fs.writeFileSync(path.join(APP, "config.json"), JSON.stringify(cfg, null, 2));
  return cfg;
}

// ---------- SnapCon process ----------
let server = null;
const logLines = [];
let currentStep = "start";
let starts = 0;
// Health's deadline (25 s) is tracked as a lifecycle contract. A request set
// may declare more ("trackDelays": [ms, …]) for the timers its own routes
// create; with no declaration the list is exactly "25000", as before.
const TRACK_DELAYS = [...new Set(["25000", ...REQUESTS.flatMap(f => (JSON.parse(fs.readFileSync(f, "utf8")).trackDelays || []).map(String))])].join(",");
function startServer() {
  const lifecycleOut = path.join("/tmp", `lifecycle.${starts++}.json`);
  server = spawn(process.execPath, ["--require", "/harness/lifecycle-probe.js", "server.js"], { cwd: APP,
    env: { PATH: process.env.PATH, HOME: "/tmp", NODE_ENV: "production", TZ: "UTC", LIFECYCLE_OUT: lifecycleOut, LIFECYCLE_TRACK_DELAYS: TRACK_DELAYS }, stdio: ["ignore", "pipe", "pipe"] });
  const take = stream => {
    let buf = "";
    stream.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { logLines.push({ step: currentStep, line: buf.slice(0, i) }); buf = buf.slice(i + 1); } });
  };
  take(server.stdout); take(server.stderr);
  return server;
}
async function waitReady() {
  for (let i = 0; i < 200; i++) {
    try { const r = await request({ method: "GET", path: "/api/version" }); if (r.status === 200) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error("SnapCon did not start");
}
async function stopServer() {
  if (!server) return;
  const s = server; server = null;
  const exited = new Promise(r => s.on("exit", (code, sig) => r({ code, sig })));
  s.kill("SIGTERM");
  const res = await Promise.race([exited, sleep(15000).then(() => { s.kill("SIGKILL"); return { killed: true }; })]);
  return res;
}

// ---------- HTTP replay ----------
const cookies = {};
function request({ method = "GET", path: p, as = null, body }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { accept: "application/json" };
    if (data) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(data); }
    if (as && cookies[as]) headers.cookie = cookies[as];
    const t0 = Date.now();
    const req = require("http").request({ host: "127.0.0.1", port: PORT, method, path: p, headers, timeout: 60000 }, res => {
      let b = "";
      res.on("data", d => { b += d; });
      res.on("end", () => {
        let json = null; try { json = JSON.parse(b); } catch { /* not json */ }
        const contentType = (res.headers["content-type"] || "").split(";")[0];
        // An NDJSON stream is recorded whole, record by record and in order
        // (the 2000-character text below would cut a long one short).
        const ndjson = contentType === "application/x-ndjson" ? parseNdjson(b) : undefined;
        resolve({ status: res.statusCode, contentType, json, text: json === null ? b.slice(0, 2000) : undefined, ndjson, setCookie: res.headers["set-cookie"] || null, ms: Date.now() - t0 });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("client timeout")); });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
function control(printers, name, pathName, body) {
  const fp = printers[name];
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = require("http").request({ host: fp.host, port: 7125, method: "POST", path: pathName, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, res => {
      let b = ""; res.on("data", d => { b += d; });
      res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject); req.write(data); req.end();
  });
}

async function main() {
  const out = { label: LABEL, startedAt: new Date().toISOString(), node: process.version, isolation: null, results: [], logs: logLines, printerRequests: {}, files: null, audit: null, errors: [] };
  out.isolation = await isolationCheck();
  if (!out.isolation.ok) { out.errors.push("isolation self-check failed: refusing to run"); fs.writeFileSync(path.join(OUT, LABEL + ".json"), JSON.stringify(out, null, 2)); process.exit(3); }

  // Fake printers: Alpha and Bravo answer; Charlie (127.0.0.4) has nothing listening (offline).
  const printers = {};
  for (const [name, host] of [["alpha", "127.0.0.2"], ["bravo", "127.0.0.3"]]) {
    const fp = createFakePrinter();
    await new Promise(r => fp.server.listen(7125, host, r));
    printers[name] = { ...fp, host };
  }
  await prepareApp();
  const before = new Set(listFiles(APP));
  startServer(); await waitReady();

  const steps = REQUESTS.flatMap(f => JSON.parse(fs.readFileSync(f, "utf8")).steps.map(s => ({ ...s, set: path.basename(f) })));
  for (const s of steps) {
    currentStep = s.id || s.do;
    try {
      if (s.do === "login") {
        const r = await request({ method: "POST", path: "/api/login", body: { loginName: s.user, password: s.password } });
        if (r.status !== 200 || !r.setCookie) throw new Error("login failed for " + s.user + ": " + r.status);
        cookies[s.as || s.user] = r.setCookie.map(c => c.split(";")[0]).join("; ");
      } else if (s.do === "request") {
        const r = await request({ method: s.method || "GET", path: s.path, as: s.as || null, body: s.body });
        out.results.push({ id: s.id, set: s.set, method: s.method || "GET", path: s.path, as: s.as || null, status: r.status, contentType: r.contentType, json: r.json, text: r.text, ...(r.ndjson ? { ndjson: r.ndjson } : {}), ms: r.ms });
        // What the fixture was built to produce (step.expect): a miss is an
        // error of this run, so it can never pass by merely matching other runs.
        for (const problem of checkExpect(s, r)) out.errors.push(s.id + ": " + problem);
      } else if (s.do === "printer") {
        // A control step the fake printer did not acknowledge is an error of this run.
        const c = await control(printers, s.printer, s.path || "/__control/set", s.body);
        for (const problem of checkControl(s, c.status, c.json)) out.errors.push(problem);
      } else if (s.do === "wait") {
        await sleep(s.ms);
      } else if (s.do === "reload") {
        // A real configuration reload: the Settings save path (POST /api/config)
        // with the configuration it just read, which ends in loadConfig().
        const g = await request({ method: "GET", path: "/api/config", as: s.as });
        const r = await request({ method: "POST", path: "/api/config", as: s.as, body: g.json });
        out.results.push({ id: s.id, set: s.set, method: "POST", path: "/api/config (reload)", as: s.as, status: r.status, contentType: r.contentType, json: r.json, ms: r.ms });
      } else if (s.do === "restart") {
        const ex = await stopServer();
        out.results.push({ id: s.id, set: s.set, method: "RESTART", path: "-", status: ex && ex.killed ? "killed" : "exited", json: ex });
        for (const k of Object.keys(cookies)) delete cookies[k];
        startServer(); await waitReady();
      } else throw new Error("unknown step " + JSON.stringify(s));
    } catch (e) { out.errors.push((s.id || s.do) + ": " + e.message); }
  }
  currentStep = "stop";
  out.shutdown = await stopServer();
  for (const [name, fp] of Object.entries(printers)) { out.printerRequests[name] = countLog(fp.log); fp.server.close(); }
  out.lifecycle = [];
  for (let i = 0; i < starts; i++) {
    const f = path.join("/tmp", `lifecycle.${i}.json`);
    out.lifecycle.push(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { missing: true });
  }
  out.files = listFiles(APP).filter(f => !before.has(f)).sort();
  out.audit = readAudit();
  fs.writeFileSync(path.join(OUT, LABEL + ".json"), JSON.stringify(out, null, 2));
  process.exit(0);
}
const countLog = log => log.reduce((m, l) => { m[l] = (m[l] || 0) + 1; return m; }, {});
function listFiles(dir, rel = "") {
  const outList = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.name === "node_modules" && !rel) continue;
    if (e.isDirectory()) outList.push(...listFiles(dir, r)); else outList.push(r);
  }
  return outList;
}
function readAudit() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(APP, "audit-data", "audit.db"), { readOnly: true });
    return db.prepare("SELECT category, event, userLabel, printerName, detail FROM audit_log ORDER BY id").all();
  } catch (e) { return { error: e.message }; }
}
main().catch(e => { console.error(e); process.exit(1); });
