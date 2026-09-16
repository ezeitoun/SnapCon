// test/connectors/ftps-upload.test.js — sending a file to a printer over
// implicit FTPS, and what happens when that goes wrong.
//
// Verified against a real Bambu Lab P2S on 2026-09-15: STOR answers 150 then
// 226, SIZE reports the stored length, DELE removes a file, and storing over an
// existing name replaces it. Those are the behaviours asserted here against the
// fake server.
//
// The cleanup rules matter more than the happy path. A half-written .3mf left
// on the printer is a file an operator can start by hand from its screen, and
// deleting the wrong thing is worse: a refused STOR means the existing file of
// that name was never touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const tls = require("tls");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FtpsClient } = require("../../connectors/ftps-client");
const { createFakeFtpsServer } = require("../helpers/fakeFtpsServer");

const FIX = path.join(__dirname, "..", "fixtures", "bambu-tls");
const KEY = fs.readFileSync(path.join(FIX, "TESTSERIAL0001-key.pem"));
const CERT = fs.readFileSync(path.join(FIX, "TESTSERIAL0001.pem"));
const CODE = "603db0db";

async function withServer(opts, fn) {
  const srv = createFakeFtpsServer({ key: KEY, cert: CERT, accessCode: CODE, ...opts });
  const port = await new Promise(r => srv.server.listen(0, "127.0.0.1", () => r(srv.server.address().port)));
  const client = new FtpsClient({
    connectControl: () => tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }),
    connectData: (p, session) => tls.connect({ host: "127.0.0.1", port: p, rejectUnauthorized: false, session })
  });
  try {
    await client.connect("bblp", CODE);
    await fn(client, srv);
  } finally {
    client.close();
    await new Promise(r => srv.server.close(r));
  }
}

function tmpFile(bytes) {
  const f = path.join(os.tmpdir(), "snapcon-ftps-" + process.pid + "-" + Math.random().toString(16).slice(2) + ".3mf");
  fs.writeFileSync(f, bytes);
  return f;
}

test("a file is stored under its own name and reports the size it was sent", async () => {
  await withServer({}, async (client, srv) => {
    const body = Buffer.alloc(40000, 7);
    const local = tmpFile(body);
    const job = {};
    await client.store(local, "plate.3mf", job);
    assert.equal(srv.state.stored["plate.3mf"].length, body.length);
    assert.equal(await client.size("plate.3mf"), body.length);
    fs.unlinkSync(local);
  });
});

test("upload progress is reported so the UI can show a bar", async () => {
  await withServer({}, async (client) => {
    const local = tmpFile(Buffer.alloc(120000, 3));
    const job = {};
    const seen = [];
    const timer = setInterval(() => seen.push(job.sent), 5);
    await client.store(local, "big.3mf", job);
    clearInterval(timer);
    assert.equal(job.total, 120000, "the bar needs the total up front");
    assert.equal(job.sent, 120000, "and must end at 100%");
    assert.ok(seen.every(v => v === undefined || v <= 120000), "progress must never exceed the total");
    fs.unlinkSync(local);
  });
});

test("storing over an existing name replaces it", async () => {
  // Verified on the printer: the same .3mf uploaded three times answered 226
  // with a matching SIZE each time. Re-sending a file must not need a delete
  // first, and must not append.
  await withServer({ files: { "plate.3mf": Buffer.alloc(999, 1) } }, async (client, srv) => {
    const local = tmpFile(Buffer.alloc(200, 9));
    await client.store(local, "plate.3mf", {});
    assert.equal(srv.state.stored["plate.3mf"].length, 200);
    fs.unlinkSync(local);
  });
});

test("a refused upload fails with the printer's own reply and stores nothing", async () => {
  await withServer({ refuseStor: true }, async (client, srv) => {
    const local = tmpFile(Buffer.alloc(100, 1));
    await assert.rejects(() => client.store(local, "plate.3mf", {}), /55[02]|refused/i);
    assert.equal(Object.keys(srv.state.stored).length, 0);
    fs.unlinkSync(local);
  });
});

test("a transfer cut short rejects rather than reporting success", async () => {
  // The printer accepted the data connection and then dropped it: the file on
  // the printer is a truncated .3mf, which must never be started.
  await withServer({ cutUploadAfter: 8192 }, async (client) => {
    const local = tmpFile(Buffer.alloc(200000, 5));
    await assert.rejects(() => client.store(local, "plate.3mf", {}));
    fs.unlinkSync(local);
  });
});

test("a file can be deleted, and deleting one that is not there says so", async () => {
  await withServer({ files: { "old.3mf": Buffer.alloc(10) } }, async (client) => {
    assert.equal(await client.remove("old.3mf"), true);
    assert.equal(await client.remove("never-existed.3mf"), false,
      "a missing file is not an error worth surfacing during cleanup");
  });
});

test("a file name containing a line break is refused before it reaches the printer", async () => {
  await withServer({}, async (client) => {
    const local = tmpFile(Buffer.alloc(10));
    await assert.rejects(() => client.store(local, "evil.3mf\r\nDELE important.3mf", {}), /line break/i);
    fs.unlinkSync(local);
  });
});
