// test/notifyCli.test.js — the command-line hook (notifyCli.js; docs/TODO.md
// §37 P4) against a real local HTTP server standing in for SnapCon, with a
// virtual clock so --wait's minutes take none.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { runNotifyCli, parseWait, EXIT } = require("../notifyCli");
const { EventEmitter } = require("events");

// A fake SnapCon: POST /api/notify-load answers `accept`; GET
// /api/transfers/:id answers from `statuses` in turn (the last repeats). A
// status may be "drop" (the connection is cut) or { status, body }.
async function fakeSnapCon(t, { accept = { status: 200, body: { ok: true, mode: "pending", printer: "U1 A", transferId: "dsend_1" } }, statuses = [] } = {}) {
  const seen = { posts: [], gets: [] };
  let i = 0;
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", d => body += d);
    req.on("end", () => {
      if (req.method === "POST") { seen.posts.push({ url: req.url, headers: req.headers, body }); res.writeHead(accept.status, { "Content-Type": "application/json" }); return res.end(typeof accept.body === "string" ? accept.body : JSON.stringify(accept.body)); }
      seen.gets.push({ url: req.url, headers: req.headers });
      const s = statuses[Math.min(i++, statuses.length - 1)];
      if (s === "drop") return req.socket.destroy();
      res.writeHead(s.status || 200, { "Content-Type": "application/json" }); res.end(JSON.stringify(s.body || s));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => server.close(r)));
  return { port: server.address().port, seen, server };
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "Part.gcode"); fs.writeFileSync(file, "G1 X1\n");
  const tokenPath = path.join(dir, "notify-token.json"); fs.writeFileSync(tokenPath, JSON.stringify({ token: "a".repeat(64) }));
  return { dir, file, tokenPath };
}
// Runs the CLI with a virtual clock; returns { code, out, err }.
async function run(argv, { port, tokenPath }) {
  const out = [], err = [];
  let clock = 1e6;
  const code = await runNotifyCli({ argv: ["node", "SnapCon", ...argv], port, tokenPath, out: s => out.push(s), err: s => err.push(s),
    now: () => clock, sleep: async ms => { clock += ms; await new Promise(r => setImmediate(r)); } });
  return { code, out, err, elapsed: clock - 1e6 };
}
const final = (state, extra = {}) => ({ transferId: "dsend_1", printer: "U1 A", state, final: true, ...extra });
const going = (state, extra = {}) => ({ transferId: "dsend_1", printer: "U1 A", state, final: false, ...extra });

// ---- without --wait: exactly as before ----

test("without --wait: the reply on stdout and exit 0 — nothing followed, local and remote alike", async t => {
  const f = setup(t);
  const s = await fakeSnapCon(t);
  const local = await run(["--load", f.file, "--printer", "U1 A"], { port: s.port, tokenPath: f.tokenPath });
  assert.deepEqual([local.code, local.out, local.err], [0, ['SnapCon: {"ok":true,"mode":"pending","printer":"U1 A","transferId":"dsend_1"}'], []]);
  assert.equal(s.seen.posts[0].headers["x-snapcon-local-token"], "a".repeat(64));
  assert.deepEqual(JSON.parse(s.seen.posts[0].body), { file: f.file, printer: "U1 A", outputname: "" });
  const remote = await run(["--load", f.file, "--printer", "U1 A", "--snapcon", "127.0.0.1:" + s.port], { port: 1, tokenPath: f.tokenPath });
  assert.deepEqual([remote.code, remote.out], [0, local.out]);
  assert.equal(s.seen.posts[1].body, "G1 X1\n", "the bytes, streamed");
  assert.match(s.seen.posts[1].url, /^\/api\/notify-load\?printer=U1%20A&outputname=&filename=Part\.gcode$/);
  assert.equal(s.seen.gets.length, 0, "accepted is where it stops");
});

test("without --wait: refusals and errors read and exit exactly as before", async t => {
  const f = setup(t);
  const s = await fakeSnapCon(t, { accept: { status: 409, body: '{"error":"busy"}' } });
  assert.deepEqual(Object.values(await run(["--load", f.file, "--printer", "X"], { port: s.port, tokenPath: f.tokenPath })).slice(0, 3), [1, [], ['SnapCon: {"error":"busy"}']]);
  assert.deepEqual((await run(["--load"], { port: s.port, tokenPath: f.tokenPath })).err, ["--load requires a file path"]);
  assert.deepEqual((await run(["--load", "/no/such.gcode"], { port: s.port, tokenPath: f.tokenPath })).err, ["File not found: /no/such.gcode"]);
  const noTok = await run(["--load", f.file], { port: s.port, tokenPath: path.join(f.dir, "none.json") });
  assert.equal(noTok.code, 1);
  assert.match(noTok.err[0], /^SnapCon: no local notify token found at /);
  const closed = await fakeSnapCon(t); await new Promise(r => closed.server.close(r));
  const down = await run(["--load", f.file], { port: closed.port, tokenPath: f.tokenPath });
  assert.equal(down.code, 1);
  assert.match(down.err[0], new RegExp(`^Could not reach SnapCon on port ${closed.port} — is it running\\? \\(`));
  const rdown = await run(["--load", f.file, "--snapcon", "127.0.0.1:" + closed.port], { port: 1, tokenPath: f.tokenPath });
  assert.match(rdown.err[0], new RegExp(`^Could not reach SnapCon at 127\\.0\\.0\\.1:${closed.port} \\(`));
  assert.equal(rdown.code, 1);
});

// ---- with --wait: every exit code ----

test("--wait: verified exits 0, the acceptance and the result printed separately", async t => {
  const f = setup(t);
  const s = await fakeSnapCon(t, { statuses: [going("queued"), going("uploading", { phase: "sending", sent: 5, total: 10 }), final("verified", { basis: "content" })] });
  const r = await run(["--load", f.file, "--printer", "U1 A", "--wait"], { port: s.port, tokenPath: f.tokenPath });
  assert.equal(r.code, EXIT.delivered);
  assert.equal(r.out.length, 2);
  assert.match(r.out[0], /^SnapCon: \{"ok":true/);
  assert.equal(JSON.parse(r.out[1].replace(/^SnapCon result: /, "")).state, "verified");
  assert.match(r.err[r.err.length - 1], /start, middle and end match the file \(sampled, not compared byte for byte\)/);
  assert.equal(s.seen.gets[0].url, "/api/transfers/dsend_1");
  assert.equal(s.seen.gets[0].headers["x-snapcon-local-token"], "a".repeat(64));
});

test("--wait: acknowledged also exits 0, and says it was checked by size only", async t => {
  const f = setup(t);
  const s = await fakeSnapCon(t, { statuses: [final("acknowledged", { basis: "size" })] });
  const r = await run(["--load", f.file, "--wait"], { port: s.port, tokenPath: f.tokenPath });
  assert.equal(r.code, 0);
  assert.match(r.err.pop(), /checked by size only/);
  assert.match(r.out[1], /"state":"acknowledged"/);
});

test("--wait: failed and cancelled exit 1; refused when sent exits 1 without following", async t => {
  const f = setup(t);
  for (const st of [final("failed", { code: "ECONNRESET", message: "reset" }), final("cancelled", { outcome: "not-sent" })]) {
    const s = await fakeSnapCon(t, { statuses: [going("queued"), st] });
    const r = await run(["--load", f.file, "--wait", "60"], { port: s.port, tokenPath: f.tokenPath });
    assert.equal(r.code, EXIT.failed, st.state);
  }
  const s = await fakeSnapCon(t, { accept: { status: 409, body: { error: "duplicate" } } });
  const r = await run(["--load", f.file, "--wait"], { port: s.port, tokenPath: f.tokenPath });
  assert.equal(r.code, 1);
  assert.equal(s.seen.gets.length, 0);
});

test("--wait: still under way at the deadline exits 3, and says it continues", async t => {
  const f = setup(t);
  const s = await fakeSnapCon(t, { statuses: [going("queued")] });
  const r = await run(["--load", f.file, "--wait", "60"], { port: s.port, tokenPath: f.tokenPath });
  assert.equal(r.code, EXIT.timeout);
  assert.equal(r.elapsed, 60000, "waited exactly its time");
  assert.match(r.out[1], /"state":"queued","final":false/);
  assert.match(r.err.pop(), /Still not finished after 60 s.*continues in SnapCon/);
});

test("--wait: unknown, an id SnapCon no longer knows, and a refusal to say all exit 4", async t => {
  const f = setup(t);
  const cases = [[final("unknown", { reason: "unknown-after-upload" }), /isn't known whether/], [{ status: 404, body: { code: "transfer_unknown" } }, /no longer knows this transfer/], [{ status: 403, body: {} }, /refused to report/]];
  for (const [st, said] of cases) {
    const s = await fakeSnapCon(t, { statuses: [st] });
    const r = await run(["--load", f.file, "--wait"], { port: s.port, tokenPath: f.tokenPath });
    assert.equal(r.code, EXIT.unknown);
    assert.match(r.err.pop(), said);
  }
  const old = await fakeSnapCon(t, { accept: { status: 200, body: { ok: true, mode: "pending", printer: "U1 A" } } });
  const r = await run(["--load", f.file, "--wait"], { port: old.port, tokenPath: f.tokenPath });
  assert.equal(r.code, EXIT.unknown, "an older SnapCon without a transfer id");
  assert.equal(old.seen.gets.length, 0);
});

test("--wait: a moment without an answer is waited out, never taken as a failed upload", async t => {
  const f = setup(t);
  const s = await fakeSnapCon(t, { statuses: [going("uploading", { phase: "sending", sent: 1, total: 10 }), "drop", "drop", "drop", "drop", "drop", { status: 503, body: {} }, final("verified", { basis: "content" })] });
  const r = await run(["--load", f.file, "--wait"], { port: s.port, tokenPath: f.tokenPath });
  assert.equal(r.code, 0);
  assert.ok(r.err.some(l => /doesn't answer right now; still trying/.test(l)));
});

test("--wait: SnapCon restarting mid-wait — it is followed again once back, to its saved result", async t => {
  const f = setup(t);
  const s = await fakeSnapCon(t, { statuses: [going("uploading", { phase: "sending", sent: 1, total: 10 })] });
  const port = s.port;
  const out = [], err = [];
  let clock = 0, polls = 0, restarted = null;
  const code = await runNotifyCli({ argv: ["n", "S", "--load", f.file, "--wait"], port, tokenPath: f.tokenPath, out: x => out.push(x), err: x => err.push(x), now: () => clock,
    sleep: async ms => {
      clock += ms; polls++;
      if (polls === 2) { s.server.closeAllConnections(); await new Promise(r => s.server.close(r)); }        // SnapCon stops
      if (polls === 8) {                                                                                     // and comes back (14 s later) with the result saved
        restarted = http.createServer((q, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(final("verified", { basis: "content" }))); });
        await new Promise(r => restarted.listen(port, "127.0.0.1", r));
      }
    } });
  t.after(() => restarted && new Promise(r => restarted.close(r)));
  assert.equal(code, 0);
  assert.ok(err.some(l => /still trying/.test(l)));
});

test("--wait: SnapCon still not answering at the deadline exits 4, not 1", async t => {
  const f = setup(t);
  const s = await fakeSnapCon(t, { statuses: [going("queued"), "drop"] });
  const r = await run(["--load", f.file, "--wait", "30"], { port: s.port, tokenPath: f.tokenPath });
  assert.equal(r.code, EXIT.unknown);
  assert.match(r.out[1], /"state":"unreachable"/);
  assert.match(r.err.pop(), /Couldn't reach SnapCon/);
});

test("--wait: no tight loop — every 2 s for the first 30 s, then every 5 s; progress at most every 10 s, only when it changes", async t => {
  const f = setup(t);
  const statuses = [];
  for (let i = 0; i < 100; i++) statuses.push(going("uploading", { phase: "sending", sent: i, total: 100 }));
  const s = await fakeSnapCon(t, { statuses });
  const r = await run(["--load", f.file, "--wait", "120"], { port: s.port, tokenPath: f.tokenPath });
  assert.equal(r.code, 3);
  // 0,2,…,30 s (16), then every 5 s to 120 s (18): 34 or so.
  assert.ok(s.seen.gets.length >= 30 && s.seen.gets.length <= 36, String(s.seen.gets.length));
  const progress = r.err.slice(0, -1);
  assert.ok(progress.length <= 13, "at most one line every 10 s: " + progress.length);
  const q = await fakeSnapCon(t, { statuses: [going("queued")] });
  const quiet = await run(["--load", f.file, "--wait", "300"], { port: q.port, tokenPath: f.tokenPath });
  assert.equal(quiet.err.length, 2, "a state that does not change is said once (and the end)");
});

test("--wait takes 1–1800 seconds; anything else is refused before anything is sent", async t => {
  const f = setup(t);
  assert.equal(parseWait(["--load", "x"]), null);
  assert.equal(parseWait(["--wait"]), 300);
  assert.equal(parseWait(["--wait", "--printer", "U1"]), 300);
  assert.equal(parseWait(["--wait", "1800"]), 1800);
  for (const bad of ["0", "1801", "5m", "-3"]) assert.ok(parseWait(["--wait", bad]).error, bad);
  const s = await fakeSnapCon(t);
  const r = await run(["--load", f.file, "--wait", "9999"], { port: s.port, tokenPath: f.tokenPath });
  assert.equal(r.code, 1);
  assert.equal(s.seen.posts.length, 0);
});

test("--wait over --snapcon follows the same way, without a token", async t => {
  const f = setup(t);
  const s = await fakeSnapCon(t, { statuses: [final("verified", { basis: "content" })] });
  const r = await run(["--load", f.file, "--snapcon", "127.0.0.1:" + s.port, "--wait"], { port: 1, tokenPath: f.tokenPath });
  assert.equal(r.code, 0);
  assert.equal(s.seen.gets[0].headers["x-snapcon-local-token"], undefined);
});

// From the P4 test review.
test("a SnapCon that accepts but never answers a status read: each read has a time limit", { timeout: 5000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-p6-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "P.gcode"); fs.writeFileSync(file, "x");
  const tokenPath = path.join(dir, "t.json"); fs.writeFileSync(tokenPath, JSON.stringify({ token: "a".repeat(64) }));
  const timeouts = [];
  const httpImpl = { request(opts, onRes) {
    const req = new EventEmitter();
    req.write = () => {}; req.setTimeout = (ms, cb) => { timeouts.push(ms); setImmediate(cb); };
    req.destroy = e => setImmediate(() => req.emit("error", e));
    req.end = () => { if (opts.method === "POST") setImmediate(() => { const res = new EventEmitter(); res.statusCode = 200; res.setEncoding = () => {}; onRes(res); res.emit("data", JSON.stringify({ ok: true, transferId: "dsend_1" })); res.emit("end"); }); };
    return req;
  } };
  let clock = 0;
  const code = await runNotifyCli({ argv: ["n", "S", "--load", file, "--wait", "10"], port: 1, tokenPath, httpImpl, out() {}, err() {}, now: () => clock, sleep: async ms => { clock += ms; } });
  assert.equal(code, 4);
  assert.ok(timeouts.length > 0 && timeouts.every(ms => ms > 0 && ms <= 10000), String(timeouts));
});
