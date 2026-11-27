// test/uploadTransfer.test.js — every upload ends, as sent, failed or unknown
// (docs/TODO.md §37 P1).
//
// Before: the Moonraker and FlashForge native uploads had no deadline at all.
// A printer that stopped reading left the upload "running" forever, and one
// that took every byte and never answered left it at 100% forever, with Cancel
// gone. A FlashForge answer that was not JSON counted as success.
//
// Both uploads run here against fake printers on 127.0.0.1, with short
// deadlines. Each test has its own timeout: against the old code the stalled
// cases never settle, so they fail by timing out instead of hanging the suite.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("node:http");
const dns = require("node:dns");

const T = { connectMs: 300, inactivityMs: 400, confirmMs: 600 };
const LIMIT = { timeout: 8000 };

function tmpFile(t, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-xfer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "part.gcode");
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x47));
  return file;
}

// A fake printer. `handler(req, res, seen)` decides how it behaves; `seen`
// records what it received.
function fakePrinter(t, handler) {
  const seen = { received: 0, declared: 0, completed: false };
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    seen.declared = Number(req.headers["content-length"]);
    seen.headers = req.headers;
    req.on("data", c => { seen.received += c.length; });
    req.on("end", () => { seen.completed = true; });
    handler(req, res, seen);
  });
  srv.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => {
    t.after(() => { for (const s of sockets) s.destroy(); srv.close(); });
    r({ url: `http://127.0.0.1:${srv.address().port}`, seen });
  }));
}
const json = (res, body) => { res.setHeader("content-type", "application/json"); res.end(body); };
const afterBody = fn => (req, res, seen) => req.on("end", () => fn(req, res, seen));

const MOONRAKER_OK = '{"result":{"item":{"path":"part.gcode","root":"gcodes"},"action":"create_file"}}';
const FF_OK = '{"code":0,"message":"Success"}';
const uploaders = [
  { label: "Moonraker", get: () => require("../connectors/http-utils").uploadFile, ok: MOONRAKER_OK },
  { label: "FlashForge native", get: () => require("../connectors/flashforge-utils").uploadFile, ok: FF_OK },
];
const printerAt = url => ({ url, name: "Fake", serial: "SN1", verificationCode: "code" });

async function run(get, url, file, job) {
  try { return { value: await get()(printerAt(url), file, "part.gcode", job) }; }
  catch (error) { return { error }; }
}

for (const { label, get, ok } of uploaders) {
  test(`${label}: an answer accepting the file resolves; the bytes went out on a connection of its own`, LIMIT, async t => {
    const file = tmpFile(t, 2 * 1024 * 1024);
    const printer = await fakePrinter(t, afterBody((req, res) => json(res, ok)));
    const job = { timeouts: T };
    const r = await run(get, printer.url, file, job);
    assert.equal(r.error, undefined, r.error && r.error.message);
    assert.equal(printer.seen.received, printer.seen.declared);
    assert.equal(job.sent, job.total);
    assert.equal(printer.seen.headers.connection, "close", "not a reused keep-alive socket");
    assert.equal(job.cancelUpload, null, "nothing left to cancel");
  });

  test(`${label}: a slow answer inside the confirmation deadline is still accepted`, LIMIT, async t => {
    const file = tmpFile(t, 64 * 1024);
    const printer = await fakePrinter(t, afterBody((req, res) => setTimeout(() => json(res, ok), 350)));
    const r = await run(get, printer.url, file, { timeouts: T });
    assert.equal(r.error, undefined);
  });

  test(`${label}: a slow but steady printer is never taken for a stalled one`, LIMIT, async t => {
    // Bigger than the socket buffers, so most of it goes out while the
    // printer is reading. What is still buffered when the last byte is handed
    // over drains inside the confirmation window, as it does on a slow link.
    const file = tmpFile(t, 24 * 1024 * 1024);
    // Reads in bursts with pauses shorter than the inactivity deadline, for
    // much longer than that deadline in total.
    const printer = await fakePrinter(t, (req, res) => {
      req.on("data", () => { req.pause(); setTimeout(() => req.resume(), 5); });
      req.on("end", () => json(res, ok));
    });
    const started = Date.now();
    const r = await run(get, printer.url, file, { timeouts: { ...T, confirmMs: 5000 } });
    assert.equal(r.error, undefined, r.error && r.error.message);
    assert.ok(Date.now() - started > T.inactivityMs, "the whole transfer took longer than the inactivity deadline");
  });

  test(`${label}: a printer that stops taking data fails as stalled, before the last byte`, LIMIT, async t => {
    const file = tmpFile(t, 48 * 1024 * 1024);
    const printer = await fakePrinter(t, (req) => {
      let got = 0;
      req.on("data", c => { got += c.length; if (got > 1024 * 1024) req.pause(); });
    });
    const job = { timeouts: T };
    const r = await run(get, printer.url, file, job);
    assert.equal(r.error.code, "UPLOAD_STALLED");
    assert.equal(r.error.outcome, "failed");
    assert.equal(r.error.abortedMidBody, true);
    assert.ok(printer.seen.received < printer.seen.declared);
    assert.equal(job.confirmingSince, undefined, "never reached the last byte");
    assert.equal(job.cancelUpload, null);
  });

  test(`${label}: every byte taken and no answer is unknown, after the confirmation deadline`, LIMIT, async t => {
    const file = tmpFile(t, 256 * 1024);
    const printer = await fakePrinter(t, () => {});
    const job = { timeouts: T };
    const r = await run(get, printer.url, file, job);
    assert.equal(r.error.code, "UPLOAD_UNCONFIRMED");
    assert.equal(r.error.outcome, "unknown");
    assert.equal(r.error.reason, "timeout");
    assert.equal(printer.seen.completed, true, "the printer did get the whole body");
    assert.ok(job.confirmingSince > 0);
    assert.equal(job.cancelUpload, null);
  });

  test(`${label}: the connection dropped after the last byte is unknown`, LIMIT, async t => {
    const file = tmpFile(t, 256 * 1024);
    const printer = await fakePrinter(t, afterBody(req => req.socket.destroy()));
    const r = await run(get, printer.url, file, { timeouts: T });
    assert.equal(r.error.outcome, "unknown");
    assert.equal(r.error.code, "UPLOAD_UNCONFIRMED");
    assert.equal(r.error.reason, "connection-lost");
  });

  test(`${label}: an answer cut off after its headers is unknown`, LIMIT, async t => {
    const file = tmpFile(t, 256 * 1024);
    const printer = await fakePrinter(t, afterBody((req, res) => {
      res.writeHead(200, { "content-length": 200 }); res.write('{"co');
      setTimeout(() => req.socket.destroy(), 50);
    }));
    const r = await run(get, printer.url, file, { timeouts: T });
    assert.equal(r.error.outcome, "unknown");
    assert.equal(r.error.reason, "connection-lost");
  });

  test(`${label}: the connection dropped mid-file is a failed transfer`, LIMIT, async t => {
    const file = tmpFile(t, 48 * 1024 * 1024);
    const printer = await fakePrinter(t, (req) => {
      let got = 0;
      req.on("data", c => { got += c.length; if (got > 2 * 1024 * 1024) req.socket.destroy(); });
    });
    const r = await run(get, printer.url, file, { timeouts: T });
    assert.equal(r.error.outcome, "failed");
    assert.notEqual(r.error.code, "UPLOAD_UNCONFIRMED");
  });

  test(`${label}: a printer that refuses the file fails as rejected, before or after the body`, LIMIT, async t => {
    const file = tmpFile(t, 256 * 1024);
    const late = await fakePrinter(t, afterBody((req, res) => { res.statusCode = 400; res.end("bad"); }));
    const r1 = await run(get, late.url, file, { timeouts: T });
    assert.equal(r1.error.code, "UPLOAD_REJECTED");
    assert.equal(r1.error.outcome, "failed");
    const early = await fakePrinter(t, (req, res) => { res.statusCode = 507; res.end("full"); });
    const r2 = await run(get, early.url, tmpFile(t, 8 * 1024 * 1024), { timeouts: T });
    assert.equal(r2.error.code, "UPLOAD_REJECTED");
    assert.equal(r2.error.outcome, "failed");
  });

  test(`${label}: a connection that never opens fails within the connect deadline, nothing sent`, LIMIT, async t => {
    const file = tmpFile(t, 64 * 1024);
    // A name lookup that never answers stands in for a printer that never
    // completes the handshake.
    const real = dns.lookup;
    dns.lookup = (host, ...rest) => (host === "never.snapcon.test" ? undefined : real(host, ...rest));
    t.after(() => { dns.lookup = real; });
    const job = { timeouts: T };
    const started = Date.now();
    const r = await run(get, "http://never.snapcon.test:7125", file, job);
    assert.equal(r.error.code, "UPLOAD_CONNECT_TIMEOUT");
    assert.equal(r.error.outcome, "failed");
    assert.ok(Date.now() - started < T.connectMs + 1000);
    assert.equal(job.sent, 0);
  });

  test(`${label}: cancel while bytes go out fails as cancelled; the printer gets a short body`, LIMIT, async t => {
    const file = tmpFile(t, 48 * 1024 * 1024);
    const printer = await fakePrinter(t, (req) => { req.on("data", () => { req.pause(); setTimeout(() => req.resume(), 20); }); });
    const job = { timeouts: { ...T, inactivityMs: 5000 } };
    const p = run(get, printer.url, file, job);
    await new Promise(r => { const w = setInterval(() => { if (job.sent > 1024 * 1024) { clearInterval(w); r(); } }, 5); });
    job.cancelUpload();
    const r = await p;
    assert.equal(r.error.code, "UPLOAD_CANCELLED");
    assert.equal(r.error.outcome, "failed");
    assert.equal(job.cancelRequested, true);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(printer.seen.completed, false);
  });

  test(`${label}: cancel after the last byte cuts nothing; the printer's answer is the outcome`, LIMIT, async t => {
    const file = tmpFile(t, 128 * 1024);
    const printer = await fakePrinter(t, afterBody((req, res) => setTimeout(() => json(res, ok), 250)));
    const job = { timeouts: T };
    const p = run(get, printer.url, file, job);
    await new Promise(r => { const w = setInterval(() => { if (job.confirmingSince) { clearInterval(w); r(); } }, 2); });
    assert.equal(typeof job.cancelUpload, "function", "Cancel is still available while confirming");
    job.cancelUpload();
    assert.equal(job.cancelRequested, true, "the caller is told at once");
    assert.equal(job.cancelUpload, null, "single use");
    const r = await p;
    assert.equal(r.error, undefined, "the printer accepted it, and that is reported");
    assert.equal(printer.seen.completed, true);
  });

  test(`${label}: cancel after the last byte with no answer ends unknown at the deadline`, LIMIT, async t => {
    const file = tmpFile(t, 128 * 1024);
    const printer = await fakePrinter(t, () => {});
    const job = { timeouts: T };
    const p = run(get, printer.url, file, job);
    await new Promise(r => { const w = setInterval(() => { if (job.confirmingSince) { clearInterval(w); r(); } }, 2); });
    job.cancelUpload();
    const r = await p;
    assert.equal(r.error.outcome, "unknown");
    assert.equal(job.cancelRequested, true);
  });

  test(`${label}: the answer and a cancel at the same moment settle once`, LIMIT, async t => {
    const file = tmpFile(t, 64 * 1024);
    let release;
    const printer = await fakePrinter(t, afterBody((req, res) => { release = () => json(res, ok); }));
    const job = { timeouts: T };
    const p = run(get, printer.url, file, job);
    await new Promise(r => { const w = setInterval(() => { if (release && job.confirmingSince) { clearInterval(w); r(); } }, 2); });
    release();
    job.cancelUpload();      // in the same tick as the answer being written
    const r = await p;
    assert.equal(r.error, undefined);
    assert.equal(job.cancelRequested, true, "the caller still sees the cancel and starts nothing");
  });

  test(`${label}: a local read error mid-file fails the transfer`, LIMIT, async t => {
    const file = tmpFile(t, 64 * 1024);
    const printer = await fakePrinter(t, afterBody((req, res) => json(res, ok)));
    fs.rmSync(file);
    const r = await run(get, printer.url, file, { timeouts: T });
    assert.ok(r.error);
    assert.notEqual(r.error.outcome, "unknown");
  });
}

test("FlashForge native: code 0 accepts, another code refuses, a reply that is not JSON is unknown (D1)", LIMIT, async t => {
  const get = () => require("../connectors/flashforge-utils").uploadFile;
  const cases = [
    [FF_OK, null, null],
    ['{"code":1,"message":"Send file error"}', "UPLOAD_REJECTED", "failed"],
    ["{}", "UPLOAD_REJECTED", "failed"],
    ["<html>ok</html>", "UPLOAD_UNCONFIRMED", "unknown"],
    ["", "UPLOAD_UNCONFIRMED", "unknown"],
    ["null", "UPLOAD_UNCONFIRMED", "unknown"],
  ];
  for (const [body, code, outcome] of cases) {
    const printer = await fakePrinter(t, afterBody((req, res) => res.end(body)));
    const r = await run(get, printer.url, tmpFile(t, 16 * 1024), { timeouts: T });
    if (!code) { assert.equal(r.error, undefined, body); continue; }
    assert.equal(r.error.code, code, body);
    assert.equal(r.error.outcome, outcome, body);
    if (outcome === "unknown") assert.equal(r.error.reason, "unreadable-reply");
  }
});

test("FlashForge native: auth and print options still travel as headers", LIMIT, async t => {
  const printer = await fakePrinter(t, afterBody((req, res) => json(res, FF_OK)));
  const file = tmpFile(t, 4096);
  await require("../connectors/flashforge-utils").uploadFile(printerAt(printer.url), file, "part.gcode", { timeouts: T });
  assert.equal(printer.seen.headers.serialnumber, "SN1");
  assert.equal(printer.seen.headers.checkcode, "code");
  assert.equal(printer.seen.headers.filesize, "4096");
  assert.equal(printer.seen.headers.printnow, "false");
});

test("5M / 5M Pro native: an upload SnapCon cut off says the printer may show a message; a refused one does not", LIMIT, async t => {
  const adv = require("../connectors/flashforge-adventurer");
  const ad5x = require("../connectors/flashforge-ad5x");
  const stall = await fakePrinter(t, (req) => { let g = 0; req.on("data", c => { g += c.length; if (g > 1024 * 1024) req.pause(); }); });
  const p = { ...printerAt(stall.url), id: "ff1", connector: "flashforge-adventurer", transport: "native" };
  const job = { timeouts: T };
  const e1 = await adv.uploadFile(p, tmpFile(t, 48 * 1024 * 1024), "part.gcode", job).catch(e => e);
  assert.equal(e1.code, "UPLOAD_STALLED");
  assert.equal(e1.printerPrompt, true);
  const refuse = await fakePrinter(t, afterBody((req, res) => json(res, '{"code":1,"message":"no"}')));
  const e2 = await adv.uploadFile({ ...p, url: refuse.url }, tmpFile(t, 4096), "part.gcode", { timeouts: T }).catch(e => e);
  assert.equal(e2.code, "UPLOAD_REJECTED");
  assert.equal(e2.printerPrompt, undefined, "the printer answered: nothing was cut off");
  // The AD5X has not been checked (§33): no such claim there.
  const stall2 = await fakePrinter(t, (req) => { let g = 0; req.on("data", c => { g += c.length; if (g > 1024 * 1024) req.pause(); }); });
  const e3 = await ad5x.uploadFile({ ...printerAt(stall2.url), id: "ad1", connector: "flashforge-ad5x", transport: "native" }, tmpFile(t, 48 * 1024 * 1024), "part.gcode", { timeouts: T }).catch(e => e);
  assert.equal(e3.code, "UPLOAD_STALLED");
  assert.equal(e3.printerPrompt, undefined);
});

test("deadlines default to 10 s / 60 s / 120 s and a job may override them", () => {
  const h = require("../connectors/http-utils");
  assert.deepEqual({ ...h.UPLOAD_TIMEOUTS }, { connectMs: 10000, inactivityMs: 60000, confirmMs: 120000 });
  assert.deepEqual(h.uploadTimeoutsFor({}), { connectMs: 10000, inactivityMs: 60000, confirmMs: 120000 });
  assert.deepEqual(h.uploadTimeoutsFor({ timeouts: { confirmMs: 300000 } }), { connectMs: 10000, inactivityMs: 60000, confirmMs: 300000 });
});
