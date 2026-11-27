// test/netfs/netfs.test.js — network-safe file access: lanes, timeouts, the
// availability breaker, recovery, and that a hung operation never freezes the
// server or starves other file work.
//
// A hung SMB call is simulated by the worker's __sleep op, which blocks its
// thread exactly as a 21 s Windows SMB timeout does (Atomics.wait).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createNetFs } = require("../../netfs/NetFs");

const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-netfs-"));
function make(t, o = {}) {
  const nf = createNetFs({ log: quiet, opTimeoutMs: 400, probeEveryMs: 100, ...o });
  t.after(() => nf.stop());
  return nf;
}
const elapsed = async fn => { const t = Date.now(); try { await fn(); } catch (e) { return { ms: Date.now() - t, error: e }; } return { ms: Date.now() - t }; };

test("the operations work on a real folder", async t => {
  const nf = make(t, { opTimeoutMs: 5000 });
  const d = tmp();
  fs.writeFileSync(path.join(d, "a.gcode"), "G1 X1\n".repeat(50000));
  fs.mkdirSync(path.join(d, "sub")); fs.writeFileSync(path.join(d, "sub", "dragon.gcode"), "x");
  assert.equal((await nf.stat(path.join(d, "a.gcode"))).isFile, true);
  assert.equal(await nf.exists(path.join(d, "nope")), false);
  const list = await nf.listDir(d, /\.gcode$/i);
  assert.deepEqual(list.map(e => e.name).sort(), ["a.gcode", "sub"]);
  assert.equal((await nf.read(path.join(d, "a.gcode"), 0, 5)).toString(), "G1 X1");
  await nf.writeFileExclusive(path.join(d, "new.gcode"), Buffer.from("hello"));
  await assert.rejects(nf.writeFileExclusive(path.join(d, "new.gcode"), Buffer.from("again")), { code: "EEXIST" }, "never overwrites");
  await nf.mkdir(path.join(d, "made"));
  await nf.rename(path.join(d, "new.gcode"), path.join(d, "made", "new.gcode"));
  assert.ok(fs.existsSync(path.join(d, "made", "new.gcode")));
  assert.deepEqual((await nf.walk(d, { query: "drag", filter: /\.gcode$/i })).map(r => r.sub + "/" + r.name), ["sub/dragon.gcode"]);
  const h = await nf.hashFile(path.join(d, "a.gcode"));
  assert.equal(h.sha256, crypto.createHash("sha256").update(fs.readFileSync(path.join(d, "a.gcode"))).digest("hex"));
  let streamed = 0;
  for await (const c of nf.createReadStream(path.join(d, "a.gcode"), { chunkSize: 4096 })) streamed += c.length;
  assert.equal(streamed, fs.statSync(path.join(d, "a.gcode")).size);
});

test("a hung operation blocks neither the event loop nor other file work", async t => {
  const nf = make(t, { opTimeoutMs: 5000 });
  const d = tmp(); nf.registerRoot("gcode", d);
  // Five hung calls at once: more than libuv's four threads, more than the lane.
  const hung = [0, 1, 2, 3, 4].map(() => nf._submit("__sleep", [1500], { path: d, timeoutMs: 5000 }).catch(() => {}));
  let maxGap = 0, last = Date.now();
  const iv = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 20);
  const local = await elapsed(() => fs.promises.readFile(__filename));
  await new Promise(r => setTimeout(r, 300));
  clearInterval(iv);
  assert.ok(local.ms < 200, `local fs.promises read took ${local.ms} ms`);
  assert.ok(maxGap < 200, `event loop stalled ${maxGap} ms`);
  await Promise.all(hung);
});

test("a timeout marks the root offline; later operations fail at once, other roots unaffected", async t => {
  const nf = make(t, { opTimeoutMs: 300, probeEveryMs: 60000 });
  const nas = tmp(), other = tmp();
  nf.registerRoot("gcode", nas);
  const first = await elapsed(() => nf._submit("__sleep", [2000], { path: nas }));
  assert.equal(first.error.code, "NAS_UNREACHABLE");
  assert.ok(first.ms < 1000, "the caller is freed at the timeout, not when Windows gives up");
  assert.equal(nf.availability(nas).status, "offline");
  const fast = await elapsed(() => nf.stat(path.join(nas, "x.gcode")));
  assert.equal(fast.error.code, "NAS_UNREACHABLE");
  assert.ok(fast.ms < 50, `fail-fast took ${fast.ms} ms`);
  assert.throws(() => nf.assertAvailable(path.join(nas, "a", "b.gcode")), { code: "NAS_UNREACHABLE" });
  assert.equal((await nf.stat(other)).isDirectory, true, "an unrelated path still works");
});

test("a network error code marks the root offline; a missing file does not", async t => {
  const nf = make(t, { probeEveryMs: 60000 });
  const nas = tmp(); nf.registerRoot("gcode", nas);
  await assert.rejects(nf.stat(path.join(nas, "missing.gcode")), { code: "ENOENT" });
  assert.equal(nf.availability(nas).status, "online", "a missing file is the file's problem, not the share's");
  await assert.rejects(nf._submit("__fail", ["UNKNOWN"], { path: nas }), { code: "NAS_UNREACHABLE" });
  assert.equal(nf.availability(nas).status, "offline");
});

test("recovery: the probe notices the root is back and marks it online", async t => {
  const nf = make(t, { probeEveryMs: 80 });
  const nas = tmp(); nf.registerRoot("gcode", nas);
  const changes = [];
  nf.onChange(s => changes.push(s.status));
  await assert.rejects(nf._submit("__fail", ["UNKNOWN"], { path: nas }));
  assert.equal(nf.availability(nas).status, "offline");
  await new Promise(r => setTimeout(r, 400));
  assert.equal(nf.availability(nas).status, "online", "no permanent stale offline state");
  assert.deepEqual(changes.slice(0, 3), ["offline", "checking", "online"]);
});

test("two requests that discover the outage together both fail cleanly, and it is reported once", async t => {
  const nf = make(t, { opTimeoutMs: 300, probeEveryMs: 60000 });
  const nas = tmp(); nf.registerRoot("gcode", nas);
  let offlineEvents = 0;
  nf.onChange(s => { if (s.status === "offline") offlineEvents++; });
  const [a, b] = await Promise.allSettled([nf._submit("__sleep", [1500], { path: nas }), nf._submit("__sleep", [1500], { path: nas })]);
  assert.equal(a.reason.code, "NAS_UNREACHABLE");
  assert.equal(b.reason.code, "NAS_UNREACHABLE");
  assert.equal(offlineEvents, 1);
});

test("a background scan cannot take interactive capacity", async t => {
  const nf = make(t, { opTimeoutMs: 5000 });
  const d = tmp();
  const bg = [0, 1, 2].map(() => nf._submit("__sleep", [800], { lane: "background", timeoutMs: 5000 }));
  const fg = await elapsed(() => nf.stat(d));   // interactive
  assert.ok(fg.ms < 300, `an interactive stat waited ${fg.ms} ms behind background work`);
  await Promise.all(bg);
});

test("a stream fails, instead of hanging, when its storage stops answering mid-read", async t => {
  const nf = make(t, { opTimeoutMs: 300, probeEveryMs: 60000 });
  const nas = tmp(); nf.registerRoot("gcode", nas);
  // Far larger than a Readable's read-ahead (64 KiB by default since Node 22),
  // so the stream cannot have buffered the whole file before the share dies.
  const size = 1024 * 1024;
  const f = path.join(nas, "big.gcode"); fs.writeFileSync(f, Buffer.alloc(size, 1));
  const stream = nf.createReadStream(f, { chunkSize: 16 * 1024 });
  let got = 0, err = null;
  try {
    for await (const c of stream) {
      got += c.length;
      // After the first chunk the share "dies": every later op times out.
      if (got === 16 * 1024) await assert.rejects(nf._submit("__sleep", [1500], { path: nas }));
    }
  } catch (e) { err = e; }
  assert.equal(err && err.code, "NAS_UNREACHABLE");
  assert.ok(got < size, "the upload reading it sees a failure, never a truncated success");
});

test("an operation queued before the outage is known fails as soon as it is, without waiting its turn", async t => {
  const nf = make(t, { lanes: { interactive: 1, background: 1, probe: 1 }, opTimeoutMs: 300, probeEveryMs: 60000 });
  const nas = tmp(); nf.registerRoot("gcode", nas);
  const blocker = nf._submit("__sleep", [1500], { path: nas }).catch(e => e);
  const queued = elapsed(() => nf.stat(path.join(nas, "x")));
  const b = await blocker, q = await queued;
  assert.equal(b.code, "NAS_UNREACHABLE");
  assert.equal(q.error.code, "NAS_UNREACHABLE");
  assert.ok(q.ms < 800, `queued op failed after ${q.ms} ms`);
});

test("identity (§37 A4): size, nanosecond times, inode and device — and an in-place edit of the same size changes it", async t => {
  const nf = make(t, { opTimeoutMs: 5000 });
  const d = tmp(); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, "a.gcode");
  fs.writeFileSync(f, "A".repeat(3000));
  const before = await nf.identity(f);
  assert.equal(before.size, 3000);
  const real = fs.statSync(f, { bigint: true });
  for (const k of ["mtimeNs", "ctimeNs", "ino", "dev"]) assert.equal(before[k], String(real[k]), k + " is the file's own, at full precision");
  assert.deepEqual(await nf.identity(f), before, "unchanged: the same identity");
  await new Promise(r => setTimeout(r, 20));
  const fd = fs.openSync(f, "r+"); fs.writeSync(fd, Buffer.from("B"), 0, 1, 1000); fs.closeSync(fd);
  const after = await nf.identity(f);
  assert.equal(after.size, 3000);
  assert.notEqual(after.mtimeNs + after.ctimeNs, before.mtimeNs + before.ctimeNs, "the edit shows");
  await assert.rejects(nf.identity(path.join(d, "gone.gcode")));
});
