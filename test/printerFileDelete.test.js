// test/printerFileDelete.test.js — deleting a G-code file from a printer's own
// storage (the printer-files dialog, POST /api/printer-file-delete).
//
// A delete is permanent, so the rule is about what SnapCon itself still needs
// the file for: the job printing it, a start in progress, an upload still
// writing it, or a queue item that will start it without sending it again.
// printerFileDeleteRefusal() is the whole decision, tested here as a table;
// the connector half is tested against a fake Moonraker.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("node:http");
const path = require("path");
const vm = require("node:vm");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
function extractFn(name) {
  const at = serverSrc.indexOf("function " + name + "(");
  assert.ok(at > 0, name + " must exist in server.js");
  return serverSrc.slice(at, serverSrc.indexOf("\n}", at) + 2);
}
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(extractFn("activeJobConflict") + "\n" + extractFn("printerFileDeleteRefusal"), sandbox);
const refusal = s => vm.runInContext("printerFileDeleteRefusal", sandbox)({
  printerName: "U1 Navy", file: "Benchy.gcode", state: "standby", activeFilename: null,
  starting: false, staged: null, queue: [], uploading: [], ...s,
});

test("an idle printer's file can be deleted", () => {
  assert.equal(refusal({}), null);
  assert.equal(refusal({ state: "complete", activeFilename: "Benchy.gcode" }), null, "a finished job's stale filename is not a conflict");
});

test("the file being printed or paused is refused; another file on the same printer is not", () => {
  assert.match(refusal({ state: "printing", activeFilename: "Benchy.gcode" }), /printing right now/);
  assert.match(refusal({ state: "paused", activeFilename: "sub/Benchy.gcode", file: "Benchy.gcode" }), /printing right now/);
  assert.equal(refusal({ state: "printing", activeFilename: "Other.gcode" }), null);
});

test("nothing is deleted while a start sequence runs (the printer still looks idle then)", () => {
  assert.match(refusal({ starting: true, file: "Anything.gcode" }), /starting a print/);
});

test("a file still being sent is refused: staged upload or an /api/print upload in flight", () => {
  assert.match(refusal({ staged: { name: "Benchy.gcode", status: "uploading" } }), /still being sent/);
  assert.match(refusal({ staged: { name: "Benchy.gcode", status: "queued" } }), /still being sent/);
  assert.match(refusal({ uploading: ["Benchy.gcode"] }), /still being sent/);
  assert.equal(refusal({ uploading: ["Other.gcode"] }), null);
});

test("a staged file that is ready (or failed) may be deleted; the route then clears it", () => {
  assert.equal(refusal({ staged: { name: "Benchy.gcode", status: "ready" } }), null);
  assert.equal(refusal({ staged: { name: "Benchy.gcode", status: "error" } }), null);
});

test("a queue item that will start this file without sending it again is refused", () => {
  const item = (status, alreadyUploaded, name = "Benchy.gcode") => ({ status, alreadyUploaded, file: { name } });
  assert.match(refusal({ queue: [item("queued", true)] }), /waiting in U1 Navy's queue/);
  assert.match(refusal({ queue: [item("dispatching", false)] }), /waiting in U1 Navy's queue/);
  assert.equal(refusal({ queue: [item("queued", false)] }), null, "it will be uploaded again when its turn comes");
  assert.equal(refusal({ queue: [item("queued", true, "Other.gcode")] }), null);
  assert.equal(refusal({ queue: [item("completed", true)] }), null);
});

// ---- connectors: DELETE /server/files/gcodes/<path> ----

function fakeMoonraker({ native = false } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push(req.method + " " + u.pathname);
    res.setHeader("content-type", "application/json");
    if (u.pathname === "/detail") {
      if (!native) { res.statusCode = 404; return res.end(); }
      return res.end(JSON.stringify({ code: 0, detail: { status: "ready" } }));
    }
    if (native) { res.statusCode = 404; return res.end(); }
    if (u.pathname === "/printer/info") return res.end(JSON.stringify({ result: { state: "ready" } }));
    if (req.method === "DELETE" && u.pathname.startsWith("/server/files/gcodes/")) return res.end(JSON.stringify({ result: {} }));
    res.statusCode = 404; res.end("{}");
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () =>
    r({ url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() })));
}

for (const mod of ["snapmaker-u1-klipper", "snapmaker-u1-klipper-ws", "klipper-moonraker", "creality-klipper"]) {
  test(`${mod}: deleteFile deletes the file, subfolder and all, from the gcodes root`, async t => {
    const c = require("../connectors/" + mod);
    assert.equal(c.capabilities.deleteFile, true);
    const s = await fakeMoonraker();
    t.after(() => s.close());
    await c.deleteFile({ id: "p", name: "P", url: s.url }, "parts/Benchy v2.gcode");
    assert.deepEqual(s.seen, ["DELETE /server/files/gcodes/parts/Benchy%20v2.gcode"]);
  });
}

test("FlashForge: deleteFile goes through Moonraker on a modded printer, and is refused on stock firmware", async t => {
  const mode = require("../connectors/flashforge-mode");
  const fm = require("../connectors/flashforge-moonraker");
  const ad5x = require("../connectors/flashforge-ad5x");
  mode._resetAll(); fm._resetCaches();
  const modded = await fakeMoonraker();
  t.after(() => modded.close());
  await ad5x.deleteFile({ id: "ff1", name: "AD5X White", url: modded.url }, "Benchy.gcode");
  assert.ok(modded.seen.includes("DELETE /server/files/gcodes/Benchy.gcode"), modded.seen.join(" | "));

  mode._resetAll(); fm._resetCaches();
  const stock = await fakeMoonraker({ native: true });
  t.after(() => stock.close());
  await assert.rejects(ad5x.deleteFile({ id: "ff2", name: "AD5X", url: stock.url }, "Benchy.gcode"), /not available on this printer's stock firmware/);
  assert.ok(!stock.seen.some(x => x.startsWith("DELETE")));
});
