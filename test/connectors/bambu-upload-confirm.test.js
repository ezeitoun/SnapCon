// test/connectors/bambu-upload-confirm.test.js — a Bambu upload whose last
// byte went out but whose completion reply never came is Unknown, and nothing
// is deleted (docs/TODO.md §37 P1, D6).
//
// Before: the printer's 226 got the 15 s every FTP command gets, and a timeout
// there was a plain failure. Now it waits the upload confirmation deadline
// (120 s by default, job.timeouts.confirmMs here), and a missing answer is
// Unknown: the whole file may be on the printer.
const test = require("node:test");
const assert = require("node:assert/strict");
const tls = require("tls");
const fs = require("fs");
const os = require("os");
const path = require("path");
const bambu = require("../../connectors/bambu-lab");
const { createFakeFtpsServer } = require("../helpers/fakeFtpsServer");

const FIX = path.join(__dirname, "..", "fixtures", "bambu-tls");
const KEY = fs.readFileSync(path.join(FIX, "TESTSERIAL0001-key.pem"));
const CERT = fs.readFileSync(path.join(FIX, "TESTSERIAL0001.pem"));
const CODE = "123ab4cd";
const I = bambu._internal;

async function withFtp(opts, fn) {
  const srv = createFakeFtpsServer({ key: KEY, cert: CERT, accessCode: CODE, ...opts });
  const port = await new Promise(r => srv.server.listen(0, "127.0.0.1", () => r(srv.server.address().port)));
  I.setFtpTransportFactory({
    control: () => tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }),
    data: (cfg, p, session) => tls.connect({ host: "127.0.0.1", port: p, rejectUnauthorized: false, session }),
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-bambu-up-"));
  const local = path.join(dir, "plate.3mf");
  fs.writeFileSync(local, Buffer.alloc(300000, 3));
  try { await fn(srv, local); }
  finally {
    I.setFtpTransportFactory(null);
    for (const s of srv.state.sockets) s.destroy();
    await new Promise(r => srv.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const printer = { id: "b1", name: "P2S", ip: "127.0.0.1", serial: "TESTSERIAL0001", verificationCode: CODE };

test("Bambu: a whole file with no completion reply is unknown at the confirmation deadline, and is not deleted", { timeout: 20000 }, async () => {
  await withFtp({ afterStor: "silent" }, async (srv, local) => {
    const job = { timeouts: { confirmMs: 500 } };
    const started = Date.now();
    const e = await bambu.uploadFile(printer, local, "plate.3mf", job).catch(err => err);
    assert.equal(e.code, "UPLOAD_UNCONFIRMED", e.message);
    assert.equal(e.outcome, "unknown");
    assert.equal(e.reason, "timeout");
    assert.ok(Date.now() - started < 5000, "the deadline is the confirmation one, not a hang");
    assert.ok(srv.state.stored["plate.3mf"], "the printer has the file");
    assert.ok(!srv.state.commands.some(c => c.startsWith("DELE")), "and SnapCon did not delete it");
  });
});

test("Bambu: the control connection lost after the whole file is unknown, nothing deleted", { timeout: 20000 }, async () => {
  await withFtp({ afterStor: "drop" }, async (srv, local) => {
    const e = await bambu.uploadFile(printer, local, "plate.3mf", { timeouts: { confirmMs: 5000 } }).catch(err => err);
    assert.equal(e.code, "UPLOAD_UNCONFIRMED", e.message);
    assert.equal(e.outcome, "unknown");
    assert.equal(e.reason, "connection-lost");
    assert.ok(!srv.state.commands.some(c => c.startsWith("DELE")));
  });
});

test("Bambu: a normal upload still completes and is checked by SIZE", { timeout: 20000 }, async () => {
  await withFtp({}, async (srv, local) => {
    await bambu.uploadFile(printer, local, "plate.3mf", { timeouts: { confirmMs: 5000 } });
    assert.equal(srv.state.stored["plate.3mf"].length, 300000);
    assert.ok(srv.state.commands.includes("SIZE plate.3mf"));
  });
});

// Cut before the last byte: a failed transfer, never Unknown. (Whether the
// truncated file is then removed depends on how the data connection ended; a
// reset skips the cleanup, as it did before P1 — docs/TODO.md §37.)
test("Bambu: a transfer cut short is still a failure, not unknown", { timeout: 20000 }, async () => {
  await withFtp({ cutUploadAfter: 8192 }, async (srv, local) => {
    const e = await bambu.uploadFile(printer, local, "plate.3mf", {}).catch(err => err);
    assert.ok(e instanceof Error);
    assert.notEqual(e.outcome, "unknown");
    assert.notEqual(e.code, "UPLOAD_UNCONFIRMED");
  });
});

// The printer closes the data connection cleanly part-way, while the local
// read (slow here, as from a NAS) is between chunks, and then never answers.
// No write fails, so the close looks like the end of the transfer. Before the
// fix this became Unknown, "All N bytes were sent"; only 16 KB of 300 KB were.
test("Bambu: a clean early close of the data connection, then no reply, is a failure, not 'all bytes sent'", { timeout: 20000 }, async () => {
  const { Readable } = require("stream");
  const netfs = require("../../netfs").getNetFs();
  const realStream = netfs.createReadStream;
  let rest;
  netfs.createReadStream = (fp) => {
    const all = fs.readFileSync(fp);
    const s = new Readable({ read() {} });
    s.push(all.subarray(0, 16384));            // the first chunk, then the read stalls
    rest = setTimeout(() => { s.push(all.subarray(16384)); s.push(null); }, 3000);
    return s;
  };
  try {
    await withFtp({ endUploadAfter: 8192, afterStor: "silent" }, async (srv, local) => {
      const e = await bambu.uploadFile(printer, local, "plate.3mf", { timeouts: { confirmMs: 500 } }).catch(err => err);
      assert.ok(e instanceof Error);
      assert.notEqual(e.outcome, "unknown", e.message);
      assert.notEqual(e.code, "UPLOAD_UNCONFIRMED");
      assert.equal(e.outcome, "failed");
      assert.doesNotMatch(e.message, /All \d+ bytes were sent/);
      assert.match(e.message, /after 16384 of 300000 bytes/);
      // Cleanup is unchanged by this (a separate item, docs/TODO.md §37).
      assert.ok(!srv.state.commands.some(c => c.startsWith("DELE")));
    });
  } finally {
    clearTimeout(rest);
    netfs.createReadStream = realStream;
  }
});
