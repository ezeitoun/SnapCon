// test/connectors/remote-file-identity.test.js — deciding whether the copy
// already on a printer is the same file we were about to upload.
//
// Moonraker exposes NO checksum for gcode files (confirmed against a live U1:
// its metadata has size/modified/uuid/job_id and slicer fields, nothing
// hash-like). Downloading the file to hash it would cost more than the upload
// it saves — 182MB for the largest job in this fleet.
//
// So identity is established by: exact byte size, then three 64KB windows
// (head / middle / tail) read over HTTP Range and compared to the local file.
// Verified end to end against a real duplicate — 3DBenchy, present both in the
// library and on U1 Pink at 6379028 bytes — where all three windows matched
// and 196608 bytes moved, 3% of the file.
//
// This is deliberately NOT called proof. A false positive needs two different
// sliced files of identical length that also agree at all three windows; the
// UI wording says "looks identical" and the setting that acts on it is the
// user's to turn off.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("../../connectors/http-utils");

// A local file of known content, so the windows are real reads.
function tmpFile(bytes) {
  const f = path.join(os.tmpdir(), "snapcon-identity-" + Math.random().toString(36).slice(2) + ".gcode");
  fs.writeFileSync(f, bytes);
  return f;
}
const filled = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff));

// Serves listFiles plus Range reads out of `remoteBuf`.
function printer({ remoteName, remoteBuf, listOverride }) {
  const calls = [];
  const handler = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/server/files/list")) {
      const body = { result: listOverride || (remoteBuf ? [{ path: remoteName, size: remoteBuf.length, modified: 1 }] : []) };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    }
    // Range read of the stored file.
    const range = (init && init.headers && (init.headers.Range || init.headers.range)) || "";
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    if (!m || !remoteBuf) return { ok: false, status: 416, arrayBuffer: async () => new ArrayBuffer(0) };
    const slice = remoteBuf.subarray(Number(m[1]), Number(m[2]) + 1);
    return { ok: true, status: 206, headers: { get: () => null }, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
  };
  return { calls, handler };
}
function withMockFetch(handler, fn) {
  const real = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = real; });
}
const P = { url: "http://192.168.40.193" };

test("a file the printer does not have is reported absent, and nothing is read", async () => {
  const local = tmpFile(filled(5000, 1));
  const s = printer({ remoteName: "other.gcode", remoteBuf: filled(5000, 1) });
  const out = await withMockFetch(s.handler, () => http.compareRemoteFile(P, "mine.gcode", local));
  assert.equal(out.present, false);
  assert.equal(out.identical, false);
  assert.equal(s.calls.filter(c => !c.includes("/list")).length, 0, "no content reads for an absent file");
  fs.unlinkSync(local);
});

test("same name but a different size is settled without reading any content", async () => {
  // Size alone disproves identity, and disproof is free.
  const local = tmpFile(filled(5000, 1));
  const s = printer({ remoteName: "mine.gcode", remoteBuf: filled(6000, 1) });
  const out = await withMockFetch(s.handler, () => http.compareRemoteFile(P, "mine.gcode", local));
  assert.equal(out.present, true);
  assert.equal(out.sameSize, false);
  assert.equal(out.identical, false);
  assert.equal(s.calls.filter(c => !c.includes("/list")).length, 0, "a size mismatch needs no Range read");
  fs.unlinkSync(local);
});

test("identical content is confirmed", async () => {
  const bytes = filled(500000, 3);
  const local = tmpFile(bytes);
  const s = printer({ remoteName: "mine.gcode", remoteBuf: Buffer.from(bytes) });
  const out = await withMockFetch(s.handler, () => http.compareRemoteFile(P, "mine.gcode", local));
  assert.equal(out.present, true);
  assert.equal(out.sameSize, true);
  assert.equal(out.identical, true);
  fs.unlinkSync(local);
});

test("same size but different content is caught", async () => {
  // The case size alone cannot see — two files of equal length.
  const local = tmpFile(filled(500000, 3));
  const other = filled(500000, 4);
  const s = printer({ remoteName: "mine.gcode", remoteBuf: Buffer.from(other) });
  const out = await withMockFetch(s.handler, () => http.compareRemoteFile(P, "mine.gcode", local));
  assert.equal(out.sameSize, true);
  assert.equal(out.identical, false, "differing bytes at equal length must not read as identical");
  fs.unlinkSync(local);
});

test("a difference only in the MIDDLE is caught", async () => {
  // Head and tail alone would miss a re-slice that changed only infill.
  const bytes = filled(600000, 5);
  const local = tmpFile(bytes);
  const remote = Buffer.from(bytes);
  remote[Math.floor(remote.length / 2) + 100] ^= 0xff;
  const s = printer({ remoteName: "mine.gcode", remoteBuf: remote });
  const out = await withMockFetch(s.handler, () => http.compareRemoteFile(P, "mine.gcode", local));
  assert.equal(out.identical, false);
  fs.unlinkSync(local);
});

test("a difference only in the TAIL is caught", async () => {
  const bytes = filled(600000, 6);
  const local = tmpFile(bytes);
  const remote = Buffer.from(bytes);
  remote[remote.length - 5] ^= 0xff;
  const s = printer({ remoteName: "mine.gcode", remoteBuf: remote });
  const out = await withMockFetch(s.handler, () => http.compareRemoteFile(P, "mine.gcode", local));
  assert.equal(out.identical, false);
  fs.unlinkSync(local);
});

test("a file smaller than one window is compared whole", async () => {
  const bytes = filled(900, 7);
  const local = tmpFile(bytes);
  const s = printer({ remoteName: "small.gcode", remoteBuf: Buffer.from(bytes) });
  const out = await withMockFetch(s.handler, () => http.compareRemoteFile(P, "small.gcode", local));
  assert.equal(out.identical, true);
  fs.unlinkSync(local);
});

test("only a fraction of a large file is transferred", async () => {
  // The entire point: verifying must cost far less than uploading.
  const bytes = filled(4 * 1024 * 1024, 9);
  const local = tmpFile(bytes);
  let pulled = 0;
  const s = printer({ remoteName: "big.gcode", remoteBuf: Buffer.from(bytes) });
  const counting = async (url, init) => {
    const r = await s.handler(url, init);
    if (r.status === 206) { const b = await r.arrayBuffer(); pulled += b.byteLength; return { ...r, arrayBuffer: async () => b }; }
    return r;
  };
  const out = await withMockFetch(counting, () => http.compareRemoteFile(P, "big.gcode", local));
  assert.equal(out.identical, true);
  assert.ok(pulled < bytes.length / 4, `expected a small sample, pulled ${pulled} of ${bytes.length}`);
  fs.unlinkSync(local);
});

test("a printer that refuses Range reads is never called identical", async () => {
  // Failing closed: an unverified file gets uploaded, exactly as today.
  const bytes = filled(500000, 11);
  const local = tmpFile(bytes);
  const s = printer({ remoteName: "mine.gcode", remoteBuf: Buffer.from(bytes) });
  const noRange = async (url, init) => {
    const r = await s.handler(url, init);
    return r.status === 206 ? { ok: false, status: 501, arrayBuffer: async () => new ArrayBuffer(0) } : r;
  };
  const out = await withMockFetch(noRange, () => http.compareRemoteFile(P, "mine.gcode", local));
  assert.equal(out.sameSize, true);
  assert.equal(out.identical, false, "unverifiable must never mean identical");
  fs.unlinkSync(local);
});

test("a subfolder copy is matched by basename", async () => {
  const bytes = filled(300000, 13);
  const local = tmpFile(bytes);
  const s = printer({
    remoteName: "jobs/mine.gcode", remoteBuf: Buffer.from(bytes),
    listOverride: [{ path: "jobs/mine.gcode", size: 300000, modified: 1 }],
  });
  const out = await withMockFetch(s.handler, () => http.compareRemoteFile(P, "mine.gcode", local));
  assert.equal(out.present, true, "the printer's copy may live in a subfolder");
  assert.equal(out.identical, true);
  fs.unlinkSync(local);
});

test("a missing local file is an error, not a false match", async () => {
  const s = printer({ remoteName: "mine.gcode", remoteBuf: filled(1000, 1) });
  await withMockFetch(s.handler, async () => {
    await assert.rejects(() => http.compareRemoteFile(P, "mine.gcode", path.join(os.tmpdir(), "definitely-not-here.gcode")));
  });
});
