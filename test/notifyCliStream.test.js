// test/notifyCliStream.test.js — the --snapcon upload's stream lifecycle
// (docs/TODO.md §51). Before: notifyCli piped createReadStream(file) into the
// request with no error handling either way, so a file that vanished while
// being sent ended the CLI with an uncaught exception (seen as an intermittent
// full-suite failure), a dead connection left the file stream running, and a
// file that shrank left the upload hanging. Now every failure settles the
// upload exactly once, destroys both sides, prints a clear message and exits 1.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { Readable } = require("stream");
const { runNotifyCli } = require("../notifyCli");

const T = (name, fn) => test(name, { timeout: 10000 }, fn);
let stray = [];
const onStray = e => stray.push(e);
process.on("uncaughtException", onStray);
process.on("unhandledRejection", onStray);
test.afterEach(async () => {
  await new Promise(r => setTimeout(r, 30));          // let any late stream error surface
  assert.deepEqual(stray.map(String), [], "no uncaught exception or unhandled rejection");
  stray = [];
});

// A SnapCon stand-in on loopback; `onPost(req, res, chunks)` decides what it does.
async function server(t, onPost) {
  const seen = { posts: [], aborted: 0 };
  const s = http.createServer((req, res) => {
    const chunks = [];
    const post = { url: req.url, bytes: 0, complete: false };
    seen.posts.push(post);
    req.on("data", c => { chunks.push(c); post.bytes += c.length; });
    req.on("aborted", () => { seen.aborted++; });
    req.on("error", () => {});
    req.on("end", () => { post.complete = true; post.body = Buffer.concat(chunks); });
    onPost(req, res, chunks, post);
  });
  await new Promise(r => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => { s.closeAllConnections && s.closeAllConnections(); s.close(r); }));
  return { port: s.address().port, seen, server: s };
}
const okWhenDone = (req, res) => req.on("end", () => { res.setHeader("content-type", "application/json"); res.end('{"ok":true,"mode":"pending","printer":"U1 A","transferId":"dsend_1"}'); });

function tmpFile(t, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-cli-stream-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "Part.gcode"); fs.writeFileSync(file, bytes);
  return file;
}
// A file system whose file looks fine to existsSync/statSync, with a read stream the test controls.
function fakeFs(size, makeStream) {
  const streams = [];
  return { streams, existsSync: () => true, statSync: () => ({ size, isFile: () => true }),
    createReadStream: () => { const s = makeStream(); streams.push(s); return s; } };
}
async function send(port, file, extra = {}) {
  const out = [], err = [];
  const code = await runNotifyCli({ argv: ["node", "SnapCon", "--load", file, "--printer", "U1 A", "--snapcon", "127.0.0.1:" + port], port: 1, tokenPath: "/nonexistent",
    out: s => out.push(s), err: s => err.push(s), ...extra });
  return { code, out, err };
}

T("a successful upload is unchanged: every byte arrives, the reply is printed, exit 0", async t => {
  const bytes = Buffer.alloc(3 * 1024 * 1024, 7); bytes.write("G1 X1\n");
  const file = tmpFile(t, bytes);
  const s = await server(t, okWhenDone);
  const r = await send(s.port, file);
  assert.deepEqual([r.code, r.err], [0, []]);
  assert.match(r.out[0], /^SnapCon: \{"ok":true/);
  assert.equal(s.seen.posts[0].bytes, bytes.length); assert.ok(s.seen.posts[0].body.equals(bytes), "exact bytes");
});

T("the file disappears between the size check and the read: a clear error, exit 1, nothing uncaught", async t => {
  const s = await server(t, okWhenDone);
  const ffs = fakeFs(100, () => fs.createReadStream(path.join(os.tmpdir(), "snapcon-no-such-" + process.pid + ".gcode")));
  const r = await send(s.port, "/x/Part.gcode", { fsImpl: ffs });
  assert.equal(r.code, 1);
  assert.match(r.err[0], /^Could not read \/x\/Part\.gcode while sending it \(ENOENT/);
  assert.equal(r.err.length, 1, "one message");
});

T("a read error mid-transfer: the upload is aborted (SnapCon sees it cut off), exit 1", async t => {
  const s = await server(t, okWhenDone);
  const ffs = fakeFs(64 * 1024, () => new Readable({ read() {
    if (!this.sent) { this.sent = true; this.push(Buffer.alloc(16 * 1024, 1)); }
    else setImmediate(() => this.destroy(Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" })));
  } }));
  const r = await send(s.port, "/x/Part.gcode", { fsImpl: ffs });
  assert.equal(r.code, 1); assert.match(r.err[0], /^Could not read .* \(EIO: i\/o error, read\)$/);
  await new Promise(r2 => setTimeout(r2, 50));
  assert.equal(s.seen.posts[0].complete, false, "SnapCon never received a complete (wrong) file");
});

T("the file shrinks while being sent: an error, not a hang", async t => {
  const s = await server(t, okWhenDone);
  const ffs = fakeFs(10000, () => Readable.from([Buffer.alloc(4000, 2)]));   // announced 10000, only 4000 come
  const r = await send(s.port, "/x/Part.gcode", { fsImpl: ffs, uploadIdleMs: 5000 });
  assert.equal(r.code, 1); assert.match(r.err[0], /the file changed while it was being sent \(4000 of 10000 bytes\)/);
});

T("SnapCon drops the connection mid-upload: the file stream is stopped, exit 1", async t => {
  const s = await server(t, (req, res, chunks, post) => { req.once("data", () => req.socket.destroy()); });
  const ffs = fakeFs(10 * 1024 * 1024, () => new Readable({ read() { setImmediate(() => this.push(Buffer.alloc(64 * 1024, 3))); } }));
  const r = await send(s.port, "/x/Part.gcode", { fsImpl: ffs });
  assert.equal(r.code, 1); assert.match(r.err[0], /^Could not reach SnapCon at 127\.0\.0\.1:\d+ \(/);
  assert.equal(ffs.streams[0].destroyed, true, "the local file stream was destroyed");
});

T("SnapCon takes the whole file and closes without answering: exit 1, says so", async t => {
  const s = await server(t, (req) => req.on("end", () => req.socket.destroy()));
  const file = tmpFile(t, "G1 X1\n");
  const r = await send(s.port, file);
  assert.equal(r.code, 1); assert.match(r.err[0], /^Could not reach SnapCon at .*\((socket hang up|the connection closed before SnapCon answered)/);
});

T("SnapCon stops reading (no progress): the idle limit ends it, both sides destroyed", async t => {
  const s = await server(t, (req) => { req.pause(); });             // accepts, never reads, never answers
  const ffs = fakeFs(50 * 1024 * 1024, () => new Readable({ read() { setImmediate(() => this.push(Buffer.alloc(256 * 1024, 4))); } }));
  const t0 = Date.now();
  const r = await send(s.port, "/x/Part.gcode", { fsImpl: ffs, uploadIdleMs: 300 });
  assert.equal(r.code, 1); assert.match(r.err[0], /\(no progress for 0 s\)|\(no progress for \d+ s\)/);
  assert.ok(Date.now() - t0 < 5000, "bounded by the idle limit");
  assert.equal(ffs.streams[0].destroyed, true);
});

T("SnapCon not running: the original race — deleting the file right after cannot raise anything", async t => {
  const closed = http.createServer(); await new Promise(r => closed.listen(0, "127.0.0.1", r)); const port = closed.address().port; await new Promise(r => closed.close(r));
  for (let i = 0; i < 25; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-cli-stream-"));
    const file = path.join(dir, "Part.gcode"); fs.writeFileSync(file, "G1 X1\n");
    const r = await send(port, file);
    fs.rmSync(dir, { recursive: true, force: true });                // what the old test's cleanup did
    assert.equal(r.code, 1); assert.match(r.err[0], /^Could not reach SnapCon at 127\.0\.0\.1:\d+ \(/);
  }
});

T("simultaneous failures (read error and dropped connection together): settled once, one message", async t => {
  const s = await server(t, (req) => { req.once("data", () => setImmediate(() => req.socket.destroy())); });
  const ffs = fakeFs(1024 * 1024, () => new Readable({ read() {
    if (!this.n) { this.n = 1; this.push(Buffer.alloc(32 * 1024, 5)); setImmediate(() => this.destroy(new Error("EIO: i/o error, read"))); }
  } }));
  const r = await send(s.port, "/x/Part.gcode", { fsImpl: ffs });
  assert.equal(r.code, 1);
  assert.equal(r.err.length, 1, "exactly one error line");
  assert.match(r.err[0], /^(Could not read|Could not reach SnapCon)/);
});

T("the status reads (request()) and the local, path-only mode are untouched", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "notifyCli.js"), "utf8");
  assert.match(src, /get = id => request\(httpImpl, \{ hostname, port: tport, path: "\/api\/transfers\/"/);
  assert.match(src, /sent = await sendFile\(httpImpl, fsImpl, \{ hostname, port: tport, path: "\/api\/notify-load\?" \+ qs/);
  assert.doesNotMatch(src, /createReadStream\(file\)\.pipe\(req\)/, "the unguarded pipe is gone");
});
