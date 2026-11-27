// test/uploadOnlyNoPrinterCommands.test.js — a send that does not start changes
// nothing on the printer but its files (docs/TODO.md §38).
//
// Before: a file delivered to a printer with default print options also sent
// the printer its head mapping and SET_PRINT_PREFERENCES. A waiting send did it
// unattended, right after a print ended; the Virtual U1 never showed it, and a
// guarded run on a real U1 did (§37 C1). Now the map and the ticked options wait
// with the Loaded file, and its Print sends them.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const { deferredHarness } = require("./helpers/deferredHarness");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const lineSrc = m => { const at = serverSrc.indexOf(m); assert.ok(at >= 0, m); return serverSrc.slice(at, serverSrc.indexOf("\n", at)); };

// A printer with default options on, whose every connector call is recorded.
function printer(t, opts = {}) {
  const h = deferredHarness(t, opts);
  vm.runInContext(lineSrc("const wantsAnyPref = "), vm.createContext(h.env));
  h.env.printerHasAnyDefaultPref = () => true;
  h.calls = [];
  h.connector.applyHeadMapping = async () => { h.calls.push("applyHeadMapping"); };
  for (const k of Object.keys(h.connector)) {
    const fn = h.connector[k];
    h.connector[k] = (...a) => { h.calls.push(k); return fn(...a); };
  }
  return h;
}
const ONLY_FILE_CALLS = new Set(["uploadFile", "verifyUpload"]);

test("busy, then free: the waiting file is delivered, and the printer gets nothing else", async t => {
  const h = printer(t);
  h.idle = false;
  await h.sendLater("pA", "Part.gcode", "G1 X1\n", { tools: [0], map: { 0: 2 }, prefs: { autoLevel: true } });
  await h.pump();
  assert.deepEqual(h.calls, [], "nothing at all while the printer is busy");
  h.idle = true;
  await h.pump();
  assert.deepEqual(h.uploads.map(u => u.name), ["Part.gcode"]);
  assert.deepEqual(h.calls.filter(c => !ONLY_FILE_CALLS.has(c)), [], "no mapping, no preferences, no start");
  assert.equal(h.started, undefined, "not started");
  assert.equal(h.env.queuedFile.get("pA").status, "ready");
});

test("a pushed file from the hook, to a printer with default options, gets nothing but the file", async t => {
  const h = printer(t);
  await h.sendLater("pA", "Push.gcode", null, { buffer: Buffer.from("; a comment\n") });
  await h.pump();
  assert.deepEqual(h.calls.filter(c => !ONLY_FILE_CALLS.has(c)), []);
  assert.equal(h.env.queuedFile.get("pA").map, undefined, "nothing chosen, nothing kept");
  assert.equal(h.env.queuedFile.get("pA").prefs, undefined);
});

test("what was chosen with a waiting send stays with the Loaded file, across a restart", async t => {
  const h = printer(t);
  await h.sendLater("pA", "Part.gcode", "G1 X1\n", { tools: [0, 1], map: { 0: 2, 1: 0 }, prefs: { autoLevel: true, flowCalibrate: false, timelapse: false } });
  await h.pump();
  assert.deepEqual({ ...h.env.queuedFile.get("pA").map }, { 0: 2, 1: 0 });
  h.env.saveQueuedFiles();
  h.env.queuedFile.clear();
  h.env.loadQueuedFiles();
  const back = h.env.queuedFile.get("pA");
  assert.deepEqual({ ...back.map }, { 0: 2, 1: 0 });
  assert.deepEqual({ ...back.prefs }, { autoLevel: true }, "only what was ticked: flowCalibrate stays the printer's");
});

test("the Send dialog's options, none ticked, are no choice: the printer's defaults still apply at the Print", async t => {
  const h = printer(t);
  await h.sendLater("pA", "Part.gcode", "G1 X1\n", { prefs: { autoLevel: false, flowCalibrate: false, timelapse: false } });
  await h.pump();
  assert.equal(h.env.queuedFile.get("pA").prefs, undefined);
});

test("what queued-files.json says is checked before it can reach G-code", async t => {
  const h = printer(t);
  const load = entry => {
    fs.writeFileSync(h.env.QUEUED_FILE_PATH, JSON.stringify({ pA: { name: "Part.gcode", ts: 1, ...entry } }));
    h.env.queuedFile.clear();
    h.env.loadQueuedFiles();
    return h.env.queuedFile.get("pA");
  };
  // Not kept, part or whole, and marked: its Print is refused (stagedFileCheck.test.js).
  for (const map of [{ 0: "1\nM112" }, { 0: 1, 1: -1 }, { x: 2 }, { 0: null }, { 0: 1.5 }, { 0: true }, { 0: 4 }, { 32: 1 }, { 0: "1e1" }, { 0: [1] }, { 0: 1, 1: 9 }, "123", [1, 2], 7, true, null]) {
    const back = load({ map });
    assert.equal(back.map, undefined, JSON.stringify(map));
    assert.equal(back.mapInvalid, true, JSON.stringify(map));
  }
  assert.deepEqual({ ...load({ map: { 2: "3", 5: 0 } }).map }, { 2: 3, 5: 0 }, "a good one is kept");
  assert.deepEqual({ ...load({ prefs: { autoLevel: "yes\nM112", flowCalibrate: 1, timelapse: true, other: true } }).prefs }, { timelapse: true });
  for (const prefs of ["autoLevel", [true], 1, null]) assert.equal(load({ prefs }).prefs, undefined, JSON.stringify(prefs));
  const legacy = load({});
  assert.equal(legacy.name, "Part.gcode", "a record from before this keeps working");
  assert.equal(legacy.map, undefined);
  assert.equal(legacy.mapInvalid, undefined, "it never had a map to doubt");
  assert.equal(load({ map: {} }).mapInvalid, undefined, "nor did one saved empty");
  assert.equal(legacy.prefs, undefined);
});

// The real U1 connector: what a Print actually sends for each source of an
// option. Precedence: the request, then what the Loaded file kept, then the
// printer's default.
test("the U1's command at the Print: a kept tick adds to the printer's defaults, an explicit false overrides them", async t => {
  const http = require("http");
  const u1 = require("../connectors/snapmaker-u1-klipper");
  const scripts = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", d => { b += d; });
    req.on("end", () => { const u = new URL(req.url, "http://x"); scripts.push(u.searchParams.get("script") || (b ? JSON.parse(b).script : "")); res.setHeader("content-type", "application/json"); res.end('{"result":"ok"}'); });
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const p = { name: "U1", url: `http://127.0.0.1:${srv.address().port}`, autoLevel: false, flowCalibrate: true, timelapse: false };
  await u1.applyHeadMapping(p, [], {}, { timelapse: true });           // kept tick, nothing else
  assert.match(scripts.at(-1), /SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=1 TIME_LAPSE_CAMERA=1/);
  await u1.applyHeadMapping(p, [], {}, undefined);                     // nothing chosen: the printer's defaults
  assert.match(scripts.at(-1), /SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=1 TIME_LAPSE_CAMERA=0/);
  await u1.applyHeadMapping(p, [], {}, { flowCalibrate: false });      // the Print dialog's explicit false
  assert.match(scripts.at(-1), /SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=0 TIME_LAPSE_CAMERA=0/);
  await u1.applyHeadMapping(p, [0], { 0: 2 }, {});                     // the kept map
  assert.match(scripts.at(-1), /SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=0 MAP_EXTRUDER=2/);
});
