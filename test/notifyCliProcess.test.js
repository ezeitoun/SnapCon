// test/notifyCliProcess.test.js — the real `node server.js --load …` process
// (docs/TODO.md §37 P4): what it prints and how it exits, against a fake
// SnapCon in this process. It runs from a temporary directory of symlinks
// (--preserve-symlinks keeps __dirname there), so its own config.json, token
// and folders are the temporary ones and the repository is never written.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");

const ROOT = path.join(__dirname, "..");
// Left out: everything a running SnapCon keeps as its own state.
const NOT_LINKED = /^(config\.json.*|users\.json|data|gcode|notify-token\.json|.*-data|locales|\.git|dist|queued-files\.json)$/;
const skip = process.platform === "win32" ? "symlinks need privileges on Windows" : false;

async function instance(t, statuses, accept = { ok: true, mode: "pending", printer: "U1 A", transferId: "dsend_p1" }) {
  const seen = { gets: 0, posts: [] };
  let i = 0;
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", d => b += d);
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.method === "POST") { seen.posts.push({ url: req.url, token: req.headers["x-snapcon-local-token"], body: b }); return res.end(JSON.stringify(accept)); }
      seen.gets++;
      res.end(JSON.stringify(statuses[Math.min(i++, statuses.length - 1)]));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-cliproc-"));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const e of fs.readdirSync(ROOT)) if (!NOT_LINKED.test(e)) fs.symlinkSync(path.join(ROOT, e), path.join(dir, e));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port }));
  fs.writeFileSync(path.join(dir, "notify-token.json"), JSON.stringify({ token: "b".repeat(64) }));
  const file = path.join(dir, "Part.gcode"); fs.writeFileSync(file, "G1 X1\n");
  // A running server's state, mid-save and damaged: a --load run must leave it exactly as it is.
  fs.mkdirSync(path.join(dir, "data"));
  for (const [n, c] of [["deferred-sends.json", '{"format":1,"records":[]}'], ["deferred-sends.json.tmp", "{half"], ["transfer-results.json", "{ corrupt"], ["transfer-results.json.tmp", "{half"],
    // The queue store as well: a corrupt primary beside a good backup and an unfinished save is the state its
    // start-up would act on (keep a copy, replace the primary, move the temporary file) — the server's job, never this process's.
    ["queue-data.json", "{ corrupt"], ["queue-data.json.bak", '{"p_sample0001":{"queueState":"idle","queue":[]}}'], ["queue-data.json.tmp", "{half"]]) fs.writeFileSync(path.join(dir, "data", n), c);
  const run = (...args) => new Promise(resolve => {
    execFile(process.execPath, ["--preserve-symlinks", "--preserve-symlinks-main", path.join(dir, "server.js"), "--load", file, "--printer", "U1 A", ...args],
      { cwd: os.tmpdir(), timeout: 60000 }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stdout, stderr }));
  });
  const dataSnapshot = () => Object.fromEntries(fs.readdirSync(path.join(dir, "data")).map(n => [n, fs.readFileSync(path.join(dir, "data", n), "utf8")]));
  return { run, port, seen, file, dataSnapshot };
}
const final = (state, extra = {}) => ({ transferId: "dsend_p1", printer: "U1 A", state, final: true, ...extra });
// Lines the process wrote, without what server.js's start may log first.
const lines = s => s.split("\n").filter(l => /^SnapCon/.test(l));

test("the real process without --wait: one line on stdout, exit 0, nothing followed — same-machine and --snapcon", { skip }, async t => {
  const s = await instance(t, [final("verified")]);
  const before = s.dataSnapshot();
  const r = await s.run();
  assert.deepEqual(s.dataSnapshot(), before, "the server's send list and results untouched: nothing loaded, tidied or moved aside");
  assert.equal(r.code, 0);
  assert.deepEqual(lines(r.stdout), ['SnapCon: {"ok":true,"mode":"pending","printer":"U1 A","transferId":"dsend_p1"}']);
  assert.doesNotMatch(r.stderr, /SnapCon|Waiting|Delivered/);
  assert.equal(s.seen.posts[0].token, "b".repeat(64), "the temporary instance's own token");
  assert.equal(JSON.parse(s.seen.posts[0].body).file, s.file);
  const remote = await s.run("--snapcon", "127.0.0.1:" + s.port);
  assert.equal(remote.code, 0);
  assert.deepEqual(lines(remote.stdout), lines(r.stdout));
  assert.equal(s.seen.gets, 0);
});

test("the real process with --wait: exit 0 delivered, 1 failed, 4 unknown, 3 out of time", { skip }, async t => {
  for (const [statuses, code, args] of [
    [[final("verified", { basis: "content" })], 0, ["--wait"]],
    [[final("acknowledged", { basis: "size" })], 0, ["--wait"]],
    [[final("failed", { code: "ECONNRESET", message: "reset" })], 1, ["--wait"]],
    [[final("cancelled", { outcome: "not-sent" })], 1, ["--wait"]],
    [[final("unknown", { reason: "unknown-after-upload" })], 4, ["--wait"]],
    [[{ transferId: "dsend_p1", state: "queued", final: false }], 3, ["--wait", "1"]],
  ]) {
    const s = await instance(t, statuses);
    const r = await s.run(...args);
    assert.equal(r.code, code, statuses[0].state);
    const out = lines(r.stdout);
    assert.equal(out.length, 2, "the acceptance, then the result");
    assert.match(out[0], /^SnapCon: \{"ok":true/);
    assert.equal(JSON.parse(out[1].replace(/^SnapCon result: /, "")).state, statuses[0].state);
  }
});

test("the CLI module ships everywhere server.js does: Docker copies it and pkg can trace it", () => {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(src, /require\("\.\/notifyCli"\)/, "a literal require, which pkg bundles");
  assert.match(fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8"), /^COPY [^\n]*\bnotifyCli\.js\b/m);
  assert.match(src, /require\("\.\/transfers\/TransferResults"\)/);
  assert.match(fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8"), /^COPY transfers \.\/transfers$/m);
});
