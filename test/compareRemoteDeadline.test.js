// test/compareRemoteDeadline.test.js — the "is this file already on the
// printer?" check (http-utils compareRemoteFile) has one deadline per ranged
// read, its body included (docs/TODO.md §37 P1, decision Q8).
//
// Before: fetchTimeout covered only the response headers, and the body was
// read with no limit. A printer that answered a range request with its headers
// and then stalled held the check forever — and with it /api/print (which asks
// before it hands out a job) or the queue dispatch (stuck in "verify", the
// printer taken until a restart).
//
// The test has its own timeout, so against the old code it fails instead of
// hanging.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("node:http");
const { compareRemoteFile } = require("../connectors/http-utils");

const SIZE = 300000;
function localFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-cmp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, "Part.gcode");
  const b = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) b[i] = (i * 7) % 251;
  fs.writeFileSync(f, b);
  return { f, b };
}
// A Moonraker listing the file at the same size; `range(req, res, start, end)`
// answers each ranged read.
function fakeMoonraker(t, range) {
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/server/files/list") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ result: [{ path: "Part.gcode", size: SIZE, modified: 1 }] }));
    }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
    return range(req, res, +m[1], +m[2]);
  });
  srv.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => {
    t.after(() => { for (const s of sockets) s.destroy(); srv.close(); });
    r({ url: "http://127.0.0.1:" + srv.address().port });
  }));
}

test("a range read whose body stalls leaves the copy unverified within the deadline, so it is uploaded as before", { timeout: 8000 }, async t => {
  const { f } = localFile(t);
  const printer = await fakeMoonraker(t, (req, res, start, end) => {
    res.writeHead(206, { "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${SIZE}` });
    res.write(Buffer.alloc(100));       // the headers and a little, then nothing
  });
  const started = Date.now();
  const r = await compareRemoteFile({ url: printer.url }, "Part.gcode", f, { rangeTimeoutMs: 400 });
  assert.equal(r.identical, false);
  assert.equal(r.unverified, true);
  assert.ok(Date.now() - started < 3000, "settled by the deadline, not by the printer");
});

test("a range read that does answer in time is still compared: identical stays identical", { timeout: 8000 }, async t => {
  const { f, b } = localFile(t);
  const printer = await fakeMoonraker(t, (req, res, start, end) => {
    res.writeHead(206, { "content-range": `bytes ${start}-${end}/${SIZE}` });
    res.end(b.subarray(start, end + 1));
  });
  const r = await compareRemoteFile({ url: printer.url }, "Part.gcode", f, { rangeTimeoutMs: 2000 });
  assert.equal(r.identical, true);
});

test("the default deadline for a range read is 10 s, as before, now including its body", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "connectors", "http-utils.js"), "utf8");
  assert.match(src, /async function compareRemoteFile\(p, name, localPath, \{ rangeTimeoutMs = 10000 \} = \{\}\)/);
  assert.match(src, /fetchBufferTimeout\(url, rangeTimeoutMs, \{ headers: \{ Range:/);
});
