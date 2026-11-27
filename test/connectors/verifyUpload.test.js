// test/connectors/verifyUpload.test.js — each connector's read-back after an
// upload (docs/TODO.md §37 P2): what the printer holds under the name a start
// would use, as verified / acknowledged / mismatch / absent / unverifiable.
//
// Before: no connector could answer this; the printer's yes to the upload was
// taken as the file being there, and a start followed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("node:http");
const tls = require("tls");
const httpUtils = require("../../connectors/http-utils");
const ff = require("../../connectors/flashforge-utils");
const { getConnector, listConnectorTypes } = require("../../connectors");

const SIZE = 300000;
function localFile(t, name = "Part.gcode") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-verify-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, name);
  const b = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) b[i] = (i * 7) % 251;
  fs.writeFileSync(f, b);
  return { f, b };
}
const FAST = { attempts: 3, retryMs: 20, listTimeoutMs: 1000, rangeTimeoutMs: 1000 };

// ---- Moonraker ----
// files: path (relative to gcodes) -> Buffer. listings: how many directory
// reads answer before the file shows (listing lag). ranges: "206" | "200".
function fakeMoonraker(t, { files, hideFor = 0, listStatus = 200, ranges = "206" }) {
  const m = { listReads: 0, rangeReads: 0 };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/server/files/directory") {
      m.listReads++;
      assert.equal(u.searchParams.get("path"), "gcodes", "the gcodes root, where uploads land");
      if (listStatus !== 200) { res.statusCode = listStatus; return res.end("{}"); }
      const root = [...files].filter(([p]) => !p.includes("/") && m.listReads > hideFor);
      const dirs = [...new Set([...files.keys()].filter(p => p.includes("/")).map(p => p.split("/")[0]))];
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ result: { dirs: dirs.map(d => ({ dirname: d })), files: root.map(([p, b]) => ({ filename: p, size: b.length, modified: 1 })) } }));
    }
    const fm = /^\/server\/files\/gcodes\/(.+)$/.exec(u.pathname);
    if (fm) {
      m.rangeReads++;
      const b = files.get(decodeURIComponent(fm[1]));
      if (!b) { res.statusCode = 404; return res.end(); }
      if (ranges === "200") { res.statusCode = 200; return res.end(b); }
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
      res.writeHead(206, { "content-range": `bytes ${r[1]}-${r[2]}/${b.length}` });
      return res.end(b.subarray(+r[1], +r[2] + 1));
    }
    res.statusCode = 404; res.end("{}");
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => { t.after(() => srv.close()); m.p = { name: "U1", url: "http://127.0.0.1:" + srv.address().port }; r(m); }));
}

test("Moonraker: the file at the root with the same size and head, middle and end is verified", async t => {
  const { f, b } = localFile(t);
  const m = await fakeMoonraker(t, { files: new Map([["Part.gcode", b]]) });
  const v = await httpUtils.verifyUpload(m.p, "Part.gcode", f, FAST);
  assert.equal(v.result, "verified", v.evidence);
  assert.equal(m.rangeReads, 3);
});

test("Moonraker: a listing that lags the upload is asked again, then verified", async t => {
  const { f, b } = localFile(t);
  const m = await fakeMoonraker(t, { files: new Map([["Part.gcode", b]]), hideFor: 2 });
  const v = await httpUtils.verifyUpload(m.p, "Part.gcode", f, FAST);
  assert.equal(v.result, "verified");
  assert.equal(m.listReads, 3);
});

test("Moonraker: not listed after every try is absent; a same-named file in a subfolder does not answer for it", async t => {
  const { f, b } = localFile(t);
  const m = await fakeMoonraker(t, { files: new Map([["Old/Part.gcode", b]]) });
  const v = await httpUtils.verifyUpload(m.p, "Part.gcode", f, FAST);
  assert.equal(v.result, "absent");
  assert.equal(m.listReads, 3);
  assert.equal(m.rangeReads, 0);
});

test("Moonraker: another size, or other content at the same size, is a mismatch", async t => {
  const { f, b } = localFile(t);
  const shorter = await fakeMoonraker(t, { files: new Map([["Part.gcode", b.subarray(0, SIZE - 1)]]) });
  assert.equal((await httpUtils.verifyUpload(shorter.p, "Part.gcode", f, FAST)).result, "mismatch");
  const other = Buffer.from(b); other[SIZE - 10] ^= 0xff;   // only the end differs
  const changed = await fakeMoonraker(t, { files: new Map([["Part.gcode", other]]) });
  assert.equal((await httpUtils.verifyUpload(changed.p, "Part.gcode", f, FAST)).result, "mismatch");
});

test("Moonraker: listed at the right size but the content cannot be read back (no range support) is acknowledged", async t => {
  const { f, b } = localFile(t);
  const m = await fakeMoonraker(t, { files: new Map([["Part.gcode", b]]), ranges: "200" });
  assert.equal((await httpUtils.verifyUpload(m.p, "Part.gcode", f, FAST)).result, "acknowledged");
});

test("Moonraker: a listing that cannot be read is unverifiable, never absent", async t => {
  const { f, b } = localFile(t);
  const m = await fakeMoonraker(t, { files: new Map([["Part.gcode", b]]), listStatus: 500 });
  const v = await httpUtils.verifyUpload(m.p, "Part.gcode", f, FAST);
  assert.equal(v.result, "unverifiable");
  assert.match(v.evidence, /Moonraker 500/);
  const down = await httpUtils.verifyUpload({ name: "U1", url: "http://127.0.0.1:1" }, "Part.gcode", f, FAST);
  assert.equal(down.result, "unverifiable");
});

test("Moonraker: the local file gone is unverifiable, not a match", async t => {
  const { b } = localFile(t);
  const m = await fakeMoonraker(t, { files: new Map([["Part.gcode", b]]) });
  assert.equal((await httpUtils.verifyUpload(m.p, "Part.gcode", path.join(os.tmpdir(), "no-such-snapcon-file.gcode"), FAST)).result, "unverifiable");
});

test("Moonraker: other file types (.gx, .3mf) are found by the same listing", async t => {
  for (const name of ["Part.gx", "Part.3mf"]) {
    const { f, b } = localFile(t, name);
    const m = await fakeMoonraker(t, { files: new Map([[name, b]]) });
    assert.equal((await httpUtils.verifyUpload(m.p, name, f, FAST)).result, "verified", name);
  }
});

test("the identity comparison used to skip an upload is unchanged: it still finds a copy in a subfolder", async t => {
  const { f, b } = localFile(t);
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/server/files/list") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ result: [{ path: "Old/Part.gcode", size: SIZE, modified: 1 }] })); }
    const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
    res.writeHead(206); res.end(b.subarray(+r[1], +r[2] + 1));
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const cmp = await httpUtils.compareRemoteFile({ url: "http://127.0.0.1:" + srv.address().port }, "Part.gcode", f, { rangeTimeoutMs: 1000 });
  assert.equal(cmp.identical, true);
});

// ---- FlashForge stock API: names only ----
function withFetch(handler, fn) {
  const real = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = real; });
}
const ffList = (names, { fail = 0 } = {}) => {
  let reads = 0;
  const handler = async (url) => {
    assert.match(String(url), /\/gcodeList$/);
    if (++reads <= fail) throw new Error("socket hang up");
    return { ok: true, status: 200, json: async () => ({ code: 0, gcodeList: names }) };
  };
  return { handler, reads: () => reads };
};
const FFP = { name: "5M PRO", url: "http://127.0.0.1:1", serial: "SN", verificationCode: "c" };

test("FlashForge native: listed by name is acknowledged, never verified (D1)", async () => {
  const l = ffList(["Other.gcode", "Part.gcode"]);
  const v = await withFetch(l.handler, () => ff.verifyUpload(FFP, "Part.gcode", null, { retryMs: 1 }));
  assert.equal(v.result, "acknowledged");
});

test("FlashForge native: not listed after every try is absent; a list that cannot be read is unverifiable; a read that fails once is asked again", async () => {
  const absent = ffList(["Other.gcode"]);
  assert.equal((await withFetch(absent.handler, () => ff.verifyUpload(FFP, "Part.gcode", null, { retryMs: 1 }))).result, "absent");
  assert.equal(absent.reads(), 3);
  const down = ffList([], { fail: 99 });
  assert.equal((await withFetch(down.handler, () => ff.verifyUpload(FFP, "Part.gcode", null, { retryMs: 1 }))).result, "unverifiable");
  const flaky = ffList(["Part.gcode"], { fail: 1 });
  assert.equal((await withFetch(flaky.handler, () => ff.verifyUpload(FFP, "Part.gcode", null, { retryMs: 1 }))).result, "acknowledged");
});

test("FlashForge connectors read back by name on the stock API and by content over Moonraker", async t => {
  for (const type of ["flashforge-adventurer", "flashforge-ad5x"]) {
    const c = getConnector(type);
    const l = ffList(["Part.gcode"]);
    const v = await withFetch(l.handler, () => c.verifyUpload({ ...FFP, id: type + "-n", transport: "native" }, "Part.gcode", null));
    assert.equal(v.result, "acknowledged", type);
  }
  const { f, b } = localFile(t);
  const m = await fakeMoonraker(t, { files: new Map([["Part.gcode", b]]) });
  const port = new URL(m.p.url).port;
  const v = await getConnector("flashforge-ad5x").verifyUpload({ id: "ad5x-m", name: "AD5X", url: "http://127.0.0.1:" + port, transport: "moonraker" }, "Part.gcode", f);
  assert.equal(v.result, "verified");
});

// ---- Bambu Lab: the printer's SIZE (tested against the fake FTPS server only;
// physical validation is outstanding) ----
const bambu = require("../../connectors/bambu-lab");
const { createFakeFtpsServer } = require("../helpers/fakeFtpsServer");
const FIX = path.join(__dirname, "..", "fixtures", "bambu-tls");
const KEY = fs.readFileSync(path.join(FIX, "TESTSERIAL0001-key.pem"));
const CERT = fs.readFileSync(path.join(FIX, "TESTSERIAL0001.pem"));
const CODE = "123ab4cd";
async function withFtp(opts, fn) {
  const srv = createFakeFtpsServer({ key: KEY, cert: CERT, accessCode: CODE, ...opts });
  const port = await new Promise(r => srv.server.listen(0, "127.0.0.1", () => r(srv.server.address().port)));
  bambu._internal.setFtpTransportFactory({ control: () => tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }) });
  try { await fn(srv); }
  finally {
    bambu._internal.setFtpTransportFactory(null);
    for (const s of srv.state.sockets) s.destroy();
    await new Promise(r => srv.server.close(r));
  }
}
const BP = { id: "b1", name: "P2S", ip: "127.0.0.1", serial: "TESTSERIAL0001", verificationCode: CODE };

test("Bambu: the same SIZE is acknowledged, another is a mismatch, none is absent, an unanswered SIZE is unverifiable (D2)", async t => {
  const { f, b } = localFile(t, "plate.3mf");
  await withFtp({ files: { "plate.3mf": b } }, async () => assert.equal((await bambu.verifyUpload(BP, "plate.3mf", f)).result, "acknowledged"));
  await withFtp({ files: { "plate.3mf": b.subarray(0, 10) } }, async () => assert.equal((await bambu.verifyUpload(BP, "plate.3mf", f)).result, "mismatch"));
  await withFtp({ files: {} }, async () => assert.equal((await bambu.verifyUpload(BP, "plate.3mf", f)).result, "absent"));
  await withFtp({ files: { "plate.3mf": b }, noSize: true }, async () => assert.equal((await bambu.verifyUpload(BP, "plate.3mf", f)).result, "unverifiable"));
});

// ---- the simulator, and every connector ----
test("the simulator acknowledges the one file it holds", async () => {
  const sim = getConnector("simulator");
  const p = { id: "sim-verify", name: "Dummy" };
  await sim.uploadFile(p, __filename, "Part.gcode", {});
  assert.equal((await sim.verifyUpload(p, "Part.gcode")).result, "acknowledged");
  assert.equal((await sim.verifyUpload(p, "Other.gcode")).result, "absent");
});

test("every registered connector can read a file back, so none is Unknown by default", () => {
  for (const { type } of listConnectorTypes()) {
    assert.equal(typeof getConnector(type).verifyUpload, "function", type);
  }
});

// ---- review fixes ----
// A Moonraker with a small raw route table, for the shapes the main fake does not make.
function rawMoonraker(t, routes) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const fn = routes[u.pathname] || (u.pathname.startsWith("/server/files/gcodes/") && routes.file);
    if (!fn) { res.statusCode = 404; return res.end("{}"); }
    fn(req, res, u);
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => { t.after(() => srv.close()); r({ name: "K", url: "http://127.0.0.1:" + srv.address().port }); }));
}
const json = (res, body) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };

test("Moonraker: a printer that rewrites uploads (object processing) holds a changed copy by design: acknowledged, not a mismatch", async t => {
  const { f } = localFile(t);
  for (const [processing, want] of [[true, "acknowledged"], [false, "mismatch"]]) {
    const p = await rawMoonraker(t, {
      "/server/files/directory": (req, res) => json(res, { result: { dirs: [], files: [{ filename: "Part.gcode", size: SIZE + 900, modified: 1 }] } }),
      "/server/config": (req, res) => json(res, { result: { config: { file_manager: { enable_object_processing: processing } } } }),
    });
    assert.equal((await httpUtils.verifyUpload(p, "Part.gcode", f, FAST)).result, want, "processing " + processing);
  }
});

test("Moonraker: an answer that is not a file listing, or an entry with no size, proves nothing: unverifiable", async t => {
  const { f } = localFile(t);
  const notListing = await rawMoonraker(t, { "/server/files/directory": (req, res) => json(res, { result: { hello: 1 } }) });
  assert.equal((await httpUtils.verifyUpload(notListing, "Part.gcode", f, FAST)).result, "unverifiable");
  const noSize = await rawMoonraker(t, { "/server/files/directory": (req, res) => json(res, { result: { dirs: [], files: [{ filename: "Part.gcode", modified: 1 }] } }) });
  assert.equal((await httpUtils.verifyUpload(noSize, "Part.gcode", f, FAST)).result, "unverifiable");
});

test("a ranged read the printer does not honour is not downloaded to its end", async t => {
  const { f, b } = localFile(t);
  const big = Buffer.concat([b, Buffer.alloc(20 * 1024 * 1024)]);
  let sentBytes = 0, ended = false;
  const p = await rawMoonraker(t, {
    "/server/files/directory": (req, res) => json(res, { result: { dirs: [], files: [{ filename: "Part.gcode", size: SIZE, modified: 1 }] } }),
    file: (req, res) => {
      res.writeHead(200, { "content-length": big.length });
      let off = 0;
      const pump = () => { while (off < big.length) { const chunk = big.subarray(off, off + 65536); off += chunk.length; sentBytes += chunk.length; if (!res.write(chunk)) return res.once("drain", pump); } res.end(); ended = true; };
      res.on("close", () => {});
      pump();
    },
  });
  const v = await httpUtils.verifyUpload(p, "Part.gcode", f, FAST);
  assert.equal(v.result, "acknowledged");
  assert.ok(!ended || sentBytes < big.length, "the whole file was not read");
});

test("FlashForge native: an AD5X-style list (gcodeListDetail) is read too; an answer with neither list is unverifiable", async () => {
  const detail = async () => ({ ok: true, status: 200, json: async () => ({ code: 0, gcodeListDetail: [{ gcodeFileName: "Part.gcode" }] }) });
  assert.equal((await withFetch(detail, () => ff.verifyUpload(FFP, "Part.gcode", null, { retryMs: 1 }))).result, "acknowledged");
  const neither = async () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) });
  assert.equal((await withFetch(neither, () => ff.verifyUpload(FFP, "Part.gcode", null, { retryMs: 1 }))).result, "unverifiable");
});

test("FlashForge native: a list whose body never arrives ends at the deadline as unverifiable", async () => {
  const stalled = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
  const started = Date.now();
  const v = await withFetch(stalled, () => ff.verifyUpload(FFP, "Part.gcode", null, { attempts: 2, retryMs: 1, readTimeoutMs: 50 }));
  assert.equal(v.result, "unverifiable");
  assert.ok(Date.now() - started < 2000);
});

test("Bambu: right after an upload the read-back uses the SIZE the upload read, without a second login", async t => {
  const { f } = localFile(t, "plate.3mf");
  await withFtp({ files: {} }, async srv => {
    bambu._internal.setFtpTransportFactory({
      control: () => tls.connect({ host: "127.0.0.1", port: srv.server.address().port, rejectUnauthorized: false }),
      data: (cfg, port, session) => tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, session }),
    });
    await bambu.uploadFile(BP, f, "plate.3mf", { timeouts: { confirmMs: 5000 } });
    const logins = srv.state.logins;
    assert.equal((await bambu.verifyUpload(BP, "plate.3mf", f)).result, "acknowledged");
    assert.equal(srv.state.logins, logins, "no second session");
    // Used once: a later check asks the printer again.
    assert.equal((await bambu.verifyUpload(BP, "plate.3mf", f)).result, "acknowledged");
    assert.equal(srv.state.logins, logins + 1);
  });
});

test("Moonraker: another size is a mismatch on its own, even when the printer cannot serve ranges", async t => {
  const { f, b } = localFile(t);
  const m = await fakeMoonraker(t, { files: new Map([["Part.gcode", b.subarray(0, SIZE - 1)]]), ranges: "200" });
  assert.equal((await httpUtils.verifyUpload(m.p, "Part.gcode", f, FAST)).result, "mismatch");
});

test("Moonraker: a settings read that fails leaves a mismatch a mismatch", async t => {
  const { f } = localFile(t);
  const p = await rawMoonraker(t, {
    "/server/files/directory": (req, res) => json(res, { result: { dirs: [], files: [{ filename: "Part.gcode", size: 1, modified: 1 }] } }),
    "/server/config": (req, res) => { res.statusCode = 500; res.end("{}"); },
  });
  assert.equal((await httpUtils.verifyUpload(p, "Part.gcode", f, FAST)).result, "mismatch");
});

test("Bambu: a login the printer refuses is unverifiable, never absent", async t => {
  const { f, b } = localFile(t, "plate.3mf");
  await withFtp({ files: { "plate.3mf": b } }, async () => {
    const v = await bambu.verifyUpload({ ...BP, id: "b-wrong", verificationCode: "deadbeef" }, "plate.3mf", f);
    assert.equal(v.result, "unverifiable", v.evidence);
  });
});

test("the Adventurer 5M over Moonraker reads back by content, and the U1 connector uses the shared read-back", async t => {
  const { f, b } = localFile(t);
  const m = await fakeMoonraker(t, { files: new Map([["Part.gcode", b]]) });
  const v = await getConnector("flashforge-adventurer").verifyUpload({ id: "adv-m", name: "5M", url: m.p.url, transport: "moonraker" }, "Part.gcode", f);
  assert.equal(v.result, "verified");
  assert.equal(require("../../connectors/snapmaker-u1-klipper-ws").verifyUpload, httpUtils.verifyUpload);
  assert.equal(require("../../connectors/creality-klipper").verifyUpload, httpUtils.verifyUpload);
  assert.equal(require("../../connectors/klipper-moonraker").verifyUpload, httpUtils.verifyUpload);
});

// ---- §37 P5: a Loaded file checked later, without the local file ----
test("P5: with no local file, Moonraker holds the printer's copy to a known size and never reads its content", async t => {
  const { b } = localFile(t);
  const m = await fakeMoonraker(t, { files: new Map([["Part.gcode", b]]) });
  const same = await httpUtils.verifyUpload(m.p, "Part.gcode", null, { ...FAST, attempts: 1, localSize: SIZE });
  assert.deepEqual([same.result, same.basis], ["acknowledged", "size"]);
  assert.equal(m.rangeReads, 0, "no content read");
  const other = await httpUtils.verifyUpload(m.p, "Part.gcode", null, { ...FAST, attempts: 1, localSize: SIZE + 1 });
  assert.deepEqual([other.result, other.basis], ["mismatch", "size"]);
  const byName = await httpUtils.verifyUpload(m.p, "Part.gcode", null, { ...FAST, attempts: 1 });
  assert.deepEqual([byName.result, byName.basis], ["acknowledged", "name"]);
  const gone = await httpUtils.verifyUpload(m.p, "Gone.gcode", null, { ...FAST, attempts: 1, localSize: SIZE });
  assert.equal(gone.result, "absent");
  assert.equal(m.listReads, 4, "one listing each");
});

test("P5: every answer says what it rests on — content, size or name", async t => {
  const { f, b } = localFile(t);
  const m = await fakeMoonraker(t, { files: new Map([["Part.gcode", b]]) });
  assert.equal((await httpUtils.verifyUpload(m.p, "Part.gcode", f, FAST)).basis, "content");
  const noRange = await fakeMoonraker(t, { files: new Map([["Part.gcode", b]]), ranges: "200" });
  assert.equal((await httpUtils.verifyUpload(noRange.p, "Part.gcode", f, FAST)).basis, "size");
  const l = ffList(["Part.gcode"]);
  assert.equal((await withFetch(l.handler, () => ff.verifyUpload(FFP, "Part.gcode", null, { retryMs: 1 }))).basis, "name");
});

test("P5: Bambu holds a Loaded file to its recorded size without the local file; with none, its name", async t => {
  const { b } = localFile(t, "plate.3mf");
  await withFtp({ files: { "plate.3mf": b } }, async () => {
    const v = await bambu.verifyUpload({ ...BP, id: "b-p5" }, "plate.3mf", null, { localSize: SIZE });
    assert.deepEqual([v.result, v.basis], ["acknowledged", "size"]);
    assert.equal((await bambu.verifyUpload({ ...BP, id: "b-p5" }, "plate.3mf", null, { localSize: 7 })).result, "mismatch");
    assert.equal((await bambu.verifyUpload({ ...BP, id: "b-p5" }, "plate.3mf", null)).basis, "name");
  });
});

test("FlashForge native: a name missing from a full list (the 5M PRO shows its ten newest) is unverifiable, not absent; from a shorter list, absent", async () => {
  const full = ffList(Array.from({ length: 10 }, (_, i) => `Newer${i}.gcode`));
  const v = await withFetch(full.handler, () => ff.verifyUpload(FFP, "Old.gcode", null, { attempts: 1 }));
  assert.equal(v.result, "unverifiable");
  assert.match(v.evidence, /lists only its 10 newest files/);
  const short = ffList(["A.gcode", "B.gcode", "C.gcode"]);
  assert.equal((await withFetch(short.handler, () => ff.verifyUpload(FFP, "Old.gcode", null, { attempts: 1 }))).result, "absent");
  const there = ffList(Array.from({ length: 10 }, (_, i) => i === 9 ? "Old.gcode" : `Newer${i}.gcode`));
  assert.equal((await withFetch(there.handler, () => ff.verifyUpload(FFP, "Old.gcode", null, { attempts: 1 }))).result, "acknowledged");
});

test("P5: with no local file, a printer that rewrites uploads is acknowledged by name, and an entry with no size is unverifiable", async t => {
  const rewrites = await rawMoonraker(t, {
    "/server/files/directory": (req, res) => json(res, { result: { dirs: [], files: [{ filename: "Part.gcode", size: 999, modified: 1 }] } }),
    "/server/config": (req, res) => json(res, { result: { config: { file_manager: { enable_object_processing: true } } } }),
  });
  const v = await httpUtils.verifyUpload(rewrites, "Part.gcode", null, { ...FAST, attempts: 1, localSize: 1234 });
  assert.deepEqual([v.result, v.basis], ["acknowledged", "name"]);
  const noSize = await rawMoonraker(t, { "/server/files/directory": (req, res) => json(res, { result: { dirs: [], files: [{ filename: "Part.gcode", modified: 1 }] } }) });
  assert.equal((await httpUtils.verifyUpload(noSize, "Part.gcode", null, { ...FAST, attempts: 1, localSize: 1234 })).result, "unverifiable");
});

// ---- Bambu: only a clear "no such file" means absent (owner, 2026-10-29) ----
// The replace guard sends a file only when the printer's answer is "absent";
// an answer that says neither "here, N bytes" nor "not here" must read as
// "can't tell".
test("Bambu SIZE: a clear size is present, a clear 550 is absent, anything else is unverifiable — never absent", async t => {
  const { f, b } = localFile(t);
  const cases = [
    ["213 " + b.length, "acknowledged"],
    ["550 No such file", "absent"],
    ["550 Could not get file size.", "absent"],
    ["213 abc", "unverifiable"],
    ["213 ", "unverifiable"],
    ["213 1e3", "unverifiable"],
    ["213 -5", "unverifiable"],
    ["213 12.5", "unverifiable"],
    ["550 Permission denied", "unverifiable"],
    ["250 OK", "unverifiable"],
    ["450 Requested file action not taken", "unverifiable"],
  ];
  for (const [answer, want] of cases) {
    await withFtp({ files: {}, sizeReply: () => answer }, async () => {
      const v = await bambu.verifyUpload(BP, "plate.3mf", f);
      assert.equal(v.result, want, JSON.stringify(answer));
      if (want === "unverifiable") assert.notEqual(v.result, "absent");
    });
  }
});

test("Bambu with replacing off: an unclear SIZE answer refuses the send; replacing on, nothing is asked and it uploads", async t => {
  const vm = require("node:vm");
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
  const at = src.indexOf("async function decideUpload(");
  const decide = cfg => { const box = { CFG: cfg, getConnector: () => bambu }; vm.createContext(box); vm.runInContext(src.slice(at, src.indexOf("\n}\n", at) + 2), box); return vm.runInContext("decideUpload", box); };
  for (const [answer, want] of [["213 abc", "refuse"], ["550 Permission denied", "refuse"], ["550 No such file", "upload"], ["213 12", "refuse"]]) {
    await withFtp({ files: {}, sizeReply: () => answer }, async () => {
      assert.equal((await decide({ overwriteDifferentFiles: false })(BP, "plate.3mf")).action, want, answer);
    });
  }
  let asked = 0;
  await withFtp({ files: {}, sizeReply: () => { asked++; return "213 abc"; } }, async () => {
    assert.equal((await decide({})(BP, "plate.3mf")).action, "upload");
  });
  assert.equal(asked, 0, "replacing on (the default): the printer is not asked, Bambu uploads as before");
});
