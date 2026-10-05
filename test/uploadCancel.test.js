// test/uploadCancel.test.js — cancelling an upload while it is sending
// (POST /api/print-cancel calls job.cancelUpload()).
//
// Both upload implementations (Moonraker's in http-utils, FlashForge's native
// one) stream the file through a raw request with a fixed Content-Length.
// Cancel destroys that request mid-body, so the printer sees a broken upload,
// never a complete-looking file. Cancel exists only while bytes are still
// going out: once the last one is written it is cleared, so a cancel cannot
// land between the upload finishing and the print starting.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("node:http");
const os = require("os");
const path = require("path");

const tmpFile = (bytes) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-cancel-"));
  const file = path.join(dir, "big.gcode");
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x47));
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

// A printer that reads slowly (so an upload backs up behind it) and records
// whether it ever received a whole body.
function slowPrinter(t, { replyJson = "{}" } = {}) {
  const seen = { received: 0, declared: 0, completed: false, aborted: false };
  const srv = http.createServer((req, res) => {
    seen.declared = Number(req.headers["content-length"]);
    req.pause(); setTimeout(() => req.resume(), 200);
    req.on("data", c => { seen.received += c.length; });
    req.on("end", () => { seen.completed = true; res.setHeader("content-type", "application/json"); res.end(replyJson); });
    req.on("close", () => { if (!seen.completed) seen.aborted = true; });
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => {
    t.after(() => srv.close());
    r({ url: `http://127.0.0.1:${srv.address().port}`, seen });
  }));
}

const uploaders = [
  ["Moonraker (http-utils)", () => require("../connectors/http-utils").uploadFile],
  ["FlashForge native", () => require("../connectors/flashforge-utils").uploadFile],
];

for (const [label, get] of uploaders) {
  test(`${label}: cancelling mid-upload rejects with UPLOAD_CANCELLED and the printer never gets a whole file`, async t => {
    const { file, cleanup } = tmpFile(48 * 1024 * 1024);
    t.after(cleanup);
    const printer = await slowPrinter(t);
    const job = { sent: 0, total: 0 };
    const upload = get()({ url: printer.url, serial: "SN", verificationCode: "x" }, file, "big.gcode", job);
    // Cancel once the first megabyte has left.
    await new Promise(r => { const w = setInterval(() => { if (job.sent > 1024 * 1024) { clearInterval(w); r(); } }, 5); });
    assert.equal(typeof job.cancelUpload, "function", "cancellable while sending");
    job.cancelUpload();
    await assert.rejects(upload, { code: "UPLOAD_CANCELLED" });
    assert.equal(job.cancelUpload, null, "cancel is single-use");
    await new Promise(r => setTimeout(r, 400));   // past the printer's stall
    assert.equal(printer.seen.completed, false, "the printer must not see a completed upload");
    assert.ok(printer.seen.aborted, "the request was torn down");
    assert.ok(printer.seen.received < printer.seen.declared, `received ${printer.seen.received} of ${printer.seen.declared} bytes`);
  });

  test(`${label}: once the whole file is sent, there is nothing left to cancel`, async t => {
    const { file, cleanup } = tmpFile(64 * 1024);
    t.after(cleanup);
    const printer = await slowPrinter(t, { replyJson: '{"code":0}' });
    const job = { sent: 0, total: 0 };
    await get()({ url: printer.url, serial: "SN", verificationCode: "x" }, file, "small.gcode", job);
    assert.equal(job.cancelUpload, null);
    assert.equal(printer.seen.completed, true);
  });
}

// ---- the route: /api/print-cancel ----
// The route is thin; what matters is that it is wired to the job the upload
// arms, guards access by the job's printer, and refuses once cancel is gone.
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const routeAt = serverSrc.indexOf('app.post("/api/print-cancel"');
const route = serverSrc.slice(routeAt, serverSrc.indexOf("\n});", routeAt));

test("/api/print-cancel: regular users only, the job's printer must be visible, and only while cancellable", () => {
  assert.ok(routeAt > 0, "the route exists");
  assert.match(route, /requireRegular/);
  assert.match(route, /printerVisibleTo\(req\.user, p\)/);
  assert.match(route, /if \(!job\.cancelUpload\)[\s\S]*status\(409\)/);
  assert.match(route, /event: "upload-cancelled"/);
  // The upload job records its printer, which is what the access check uses.
  assert.match(serverSrc, /phase: "upload", sent: 0, total: 0, done: false, error: null, result: null, ts: Date\.now\(\), printerId: p\.id, file: name/);
});
