// test/uploadErrorCode.test.js — an upload failure reaches the browser with a
// code and the phase it failed in, so the card can say what went wrong in
// plain words ("The printer refused the file", "Lost connection to the
// printer") and tell an upload failure from a failure to start the print.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("node:http");
const os = require("os");
const path = require("path");

test("/api/print keeps the error's code and the phase it failed in, and /api/print-status reports both", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /job\.errorCode = \(e && e\.code\) \|\| null; job\.failedPhase = job\.phase;\n      job\.error = e\.message; job\.done = true; job\.phase = "error";/,
    "recorded before the phase becomes \"error\"");
  assert.match(src, /errorCode: job\.errorCode \|\| null, failedPhase: job\.failedPhase \|\| null \};/);
});

function refusingPrinter(t, body) {
  const srv = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.statusCode = body ? 200 : 413; res.end(body || "too large"); }); });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => { t.after(() => srv.close()); r(`http://127.0.0.1:${srv.address().port}`); }));
}
const tmpFile = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-rej-")); const f = path.join(d, "a.gcode"); fs.writeFileSync(f, "G28\n"); return f; };

test("a printer that answers and refuses the upload: UPLOAD_REJECTED (Moonraker)", async t => {
  const url = await refusingPrinter(t);
  await assert.rejects(require("../connectors/http-utils").uploadFile({ url }, tmpFile(), "a.gcode", { sent: 0, total: 0 }),
    e => e.code === "UPLOAD_REJECTED" && /Upload 413/.test(e.message));
});

test("a printer that answers and refuses the upload: UPLOAD_REJECTED (FlashForge native, HTTP error and error code)", async t => {
  const ff = require("../connectors/flashforge-utils");
  await assert.rejects(ff.uploadFile({ url: await refusingPrinter(t), serial: "SN", verificationCode: "x" }, tmpFile(), "a.gcode", { sent: 0, total: 0 }),
    e => e.code === "UPLOAD_REJECTED");
  await assert.rejects(ff.uploadFile({ url: await refusingPrinter(t, '{"code":1,"message":"Storage full"}'), serial: "SN", verificationCode: "x" }, tmpFile(), "a.gcode", { sent: 0, total: 0 }),
    e => e.code === "UPLOAD_REJECTED" && e.message === "Storage full");
});
