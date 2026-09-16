// test/connectors/bambu-lab-live.test.js — the Bambu connector against a fake
// broker: what it says to the printer, what it does when the printer says no,
// and how one connection per printer is kept, reused and dropped.
//
// The transport is swapped for a plain socket (_internal.setTransportFactory),
// so this exercises the real MQTT client and the real connection machinery
// without certificates. TLS itself is a separate concern and is not retested
// here.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const bambu = require("../../connectors/bambu-lab");
const { createFakeBambuBroker } = require("../helpers/fakeBambuBroker");
const { IDLE_REPORT } = require("../fixtures/bambu-p2s-report");

const SERIAL = "22E8AJ5C2001188";
const CODE = "603db0db";
const VERSION = [{ name: "ota", product_name: "Bambu Lab P2S", sw_ver: "01.02.00.00" }];

// Each test gets its own broker, its own printer id (so connections never
// collide) and a guaranteed teardown.
let nextId = 0;
async function withPrinter(t, { code = CODE, report = IDLE_REPORT, version = VERSION } = {}) {
  const broker = createFakeBambuBroker({ serial: SERIAL, accessCode: code, report, version });
  const port = await broker.listen();
  bambu._internal.setTransportFactory(() => net.connect({ host: "127.0.0.1", port }));
  const p = { name: "P2S", id: "live-" + (++nextId), url: "http://127.0.0.1", serial: SERIAL, verificationCode: CODE };
  t.after(async () => {
    bambu._internal.closeAll();
    bambu._internal.setTransportFactory(null);
    await broker.close();
  });
  return { broker, p };
}

test("probe returns the printer's real status once it has connected", async (t) => {
  const { p } = await withPrinter(t);
  const st = await bambu.probe(p);
  assert.equal(st.online, true);
  assert.equal(st.state, "complete");
  assert.equal(st.heads.length, 5, "A1-A4 plus the external spool");
});

test("it subscribes and asks for a full status using the printer's own serial", async (t) => {
  const { broker, p } = await withPrinter(t);
  await bambu.probe(p);
  assert.deepEqual(broker.state.subscriptions, [`device/${SERIAL}/report`]);
  const pushall = broker.state.requests.find(r => r.json && r.json.pushing);
  assert.ok(pushall, "without asking, a Bambu printer only sends changes");
  assert.equal(pushall.topic, `device/${SERIAL}/request`);
  assert.equal(pushall.json.pushing.command, "pushall");
});

test("monitoring a printer never sends it anything that moves it", async (t) => {
  // The whole fleet is probed every couple of seconds. Anything but a status
  // request here would be sent to every Bambu printer, forever.
  const { broker, p } = await withPrinter(t);
  await bambu.probe(p);
  await bambu.probe(p);
  const commands = broker.state.requests.map(r => {
    const j = r.json || {};
    return (j.pushing && j.pushing.command) || (j.info && j.info.command) || (j.print && j.print.command) || (j.system && j.system.command);
  });
  assert.deepEqual([...new Set(commands)].sort(), ["get_version", "pushall"]);
});

test("a wrong access code is reported as a wrong access code", async (t) => {
  // The printer refuses the MQTT login outright, which is a different problem
  // from being unreachable and has a different fix.
  const { p } = await withPrinter(t, { code: "different" });
  const st = await bambu.probe(p);
  assert.equal(st.online, false);
  assert.match(st.error, /access code/i);
  assert.match(st.error, /Settings → Network/, "say where to find the right one");
});

test("a printer that is not there is reported as unreachable, not as a wrong code", async (t) => {
  const { p } = await withPrinter(t);
  bambu._internal.setTransportFactory(() => net.connect({ host: "127.0.0.1", port: 1 }));
  const st = await bambu.probe({ ...p, id: "unreachable-1" });
  assert.equal(st.online, false);
  assert.match(st.error, /refused|reach|timeout/i);
  assert.doesNotMatch(st.error, /access code/i);
});

test("the model and firmware are read from the printer, not guessed from its serial", async (t) => {
  const { p } = await withPrinter(t);
  await bambu.probe(p);
  const fw = await bambu.getFirmwareInfo(p);
  assert.equal(fw.model, "Bambu Lab P2S");
  assert.equal(fw.firmware, "01.02.00.00");
});

test("a model nobody has verified is flagged as untested rather than refused", async (t) => {
  const { p } = await withPrinter(t, { version: [{ name: "ota", product_name: "Bambu Lab X9Z", sw_ver: "02.00.00.00" }] });
  await bambu.probe(p);
  const caps = bambu.getCapabilities(p);
  assert.equal(caps.verifiedModel, false, "the card shows an 'untested model' badge from this");
  assert.equal(caps.fileTypes[0], "3mf", "it is still usable — detect and explain, never refuse");
});

test("the P2S is the model this beta was verified against", async (t) => {
  const { p } = await withPrinter(t);
  await bambu.probe(p);
  assert.equal(bambu.getCapabilities(p).verifiedModel, true);
});

// ---- Developer Mode -----------------------------------------------------------
// Control commands are refused unless Developer Mode is on. Until SnapCon has
// actually had a command refused it does not claim to know, but the printer's
// `fun` field carries a hint: bit 0x20000000 was set on the P2S while control
// was refused and cleared the moment Developer Mode was switched on.

test("controls stay available while nothing says otherwise", async (t) => {
  const { p } = await withPrinter(t, { report: { ...IDLE_REPORT, fun: "64039FD193FF9CB3" } });
  await bambu.probe(p);
  const caps = bambu.getCapabilities(p);
  assert.equal(caps.control, true);
  assert.equal(caps.developerMode, "on");
});

test("a printer whose hint says Developer Mode is off says so before a command is tried", async (t) => {
  const { p } = await withPrinter(t, { report: { ...IDLE_REPORT, fun: "64039FD1B3FF9CB3" } });
  await bambu.probe(p);
  const caps = bambu.getCapabilities(p);
  assert.equal(caps.developerMode, "off");
  assert.equal(caps.control, false, "the card disables the print controls and explains why");
});

test("SnapCon never sends a command just to find out whether Developer Mode is on", async (t) => {
  const { broker, p } = await withPrinter(t, { report: { ...IDLE_REPORT, fun: "64039FD1B3FF9CB3" } });
  await bambu.probe(p);
  assert.equal(broker.state.requests.filter(r => r.json && r.json.print).length, 0);
});

// ---- camera --------------------------------------------------------------------
// The printer advertises its own stream in ipcam.rtsp_url once LAN Only
// Liveview is on, and reports "disable" when it is off — so the camera button
// follows what the printer says, not a guess from the model.

test("a printer with its liveview on offers a camera", async (t) => {
  const { p } = await withPrinter(t);   // the captured report carries an rtsps:// url
  await bambu.probe(p);
  const caps = bambu.getCapabilities(p);
  assert.equal(caps.camera, true);
  assert.equal(caps.cameraStream, true);
});

test("a printer with its liveview off offers no camera button", async (t) => {
  const { p } = await withPrinter(t, {
    report: { ...IDLE_REPORT, ipcam: { ...IDLE_REPORT.ipcam, rtsp_url: "disable" } }
  });
  await bambu.probe(p);
  assert.equal(bambu.getCapabilities(p).camera, false, "a button that cannot work must not be offered");
});

test("the stream address keeps the host SnapCon verified, taking only port and path from the printer", async (t) => {
  // ipcam.rtsp_url arrives inside a status message. Following its host would
  // let a report redirect the camera connection somewhere else entirely.
  const { p } = await withPrinter(t, {
    report: { ...IDLE_REPORT, ipcam: { ...IDLE_REPORT.ipcam, rtsp_url: "rtsps://10.9.9.9:322/streaming/live/1" } }
  });
  await bambu.probe(p);
  const target = bambu._internal.liveviewTarget(p);
  assert.equal(target.port, 322);
  assert.equal(target.path, "/streaming/live/1");
  assert.ok(!("host" in target), "the host is never taken from a status message");
});

test("asking for a stream from a printer whose camera is off explains how to switch it on", async (t) => {
  const { p } = await withPrinter(t, {
    report: { ...IDLE_REPORT, ipcam: { ...IDLE_REPORT.ipcam, rtsp_url: "disable" } }
  });
  await bambu.probe(p);
  await assert.rejects(() => bambu.openCameraStream(p, { write() {}, end() {}, backlog: () => 0 }),
    e => { assert.match(e.message, /Liveview/i); assert.equal(e.status, 404); return true; });
});

// ---- the remaining-time unit check ---------------------------------------------

test("a printer whose countdown failed the unit check shows no remaining time", async (t) => {
  const { broker, p } = await withPrinter(t);
  await bambu.probe(p);                       // the connection the pushes ride on
  broker.push({ gcode_state: "RUNNING", mc_percent: 10, mc_remaining_time: 120 }, { full: false });
  await new Promise(r => setTimeout(r, 80));
  assert.equal((await bambu.probe(p)).remaining, 120 * 60, "trusted until something says otherwise");
  // What the check does when the file's own estimate disagrees by 60x.
  bambu._internal.connFor(p).remainingUnit = "suspect";
  assert.equal((await bambu.probe(p)).remaining, null, "better nothing than a countdown 60x out");
});

test("the check runs once per job, not once per status message", async (t) => {
  const { broker, p } = await withPrinter(t);
  await bambu.probe(p);
  const c = bambu._internal.connFor(p);
  for (let i = 0; i < 4; i++) {
    broker.push({ gcode_state: "RUNNING", subtask_name: "ams", mc_percent: 10 + i, mc_remaining_time: 120 }, { full: false });
    await new Promise(r => setTimeout(r, 30));
  }
  assert.equal(c.remainingUnitJob, ["ams", c.status.gcode_file, c.status.task_id].join("|"),
    "one check, pinned to the job it was made for");
});

// ---- one connection per printer ----------------------------------------------

test("repeated probes reuse the one connection", async (t) => {
  const { broker, p } = await withPrinter(t);
  await bambu.probe(p);
  await bambu.probe(p);
  await bambu.probe(p);
  assert.equal(broker.state.logins.length, 1, "a fleet poll must not redial every few seconds");
});

test("changing the access code reconnects instead of using the old session", async (t) => {
  const { broker, p } = await withPrinter(t);
  await bambu.probe(p);
  await bambu.probe({ ...p, verificationCode: "newcode1" });
  assert.equal(broker.state.logins.length, 2);
  assert.equal(broker.state.logins[1].password, "newcode1");
});

test("Test connection uses a throwaway session and leaves nothing behind", async (t) => {
  // Settings tests a row that may not be saved yet, so it has no printer id.
  // A lingering session would sit next to the saved printer's own.
  const { broker, p } = await withPrinter(t);
  const st = await bambu.probe({ ...p, id: undefined });
  assert.equal(st.online, true);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(broker.state.sockets.size, 0, "the test connection must close itself");
  assert.equal(bambu._internal.connectionCount(), 0);
});

test("a status delta updates the card without a full report", async (t) => {
  const { broker, p } = await withPrinter(t);
  await bambu.probe(p);
  broker.push({ gcode_state: "RUNNING", mc_percent: 42, layer_num: 10, total_layer_num: 94 }, { full: false });
  await new Promise(r => setTimeout(r, 60));
  const st = await bambu.probe(p);
  assert.equal(st.state, "printing");
  assert.equal(st.progress, 0.42);
  assert.equal(st.heads.length, 5, "a delta must not wipe the AMS the full report established");
});
