// test/connectors/bambulab-h2.test.js — the Bambu Lab H2 connector: decoding
// a printer's push_status report into SnapCon's normalized status, merging
// delta reports, and the persistent-connection probe() against a fake broker.
//
// The report bodies (test/fixtures/bambu-reports.js) follow real H2D / H2S
// captures field for field; see that file's header.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const bambu = require("../../connectors/bambulab-h2");
const { getConnector, getCapabilities, CONNECTOR_TYPES, getAddress } = require("../../connectors");
const { h2dPrinting, h2sPrinting, legacySingleNozzle } = require("../fixtures/bambu-reports");
const { createFakeBambuBroker } = require("../helpers/fakeBambuBroker");

const I = bambu._internal;
const P = { name: "H2D-1" };
const norm = (print, meta) => I.normalizeBambuState(P, print, meta);

// ---- registration ----

test("registered as bambulab-h2, addressed over mqtts on the fixed broker port", () => {
  assert.ok(CONNECTOR_TYPES.includes("bambulab-h2"));
  assert.equal(getConnector("bambulab-h2"), bambu);
  assert.deepEqual(getAddress("bambulab-h2"), { scheme: "mqtts", defaultPort: 8883, portEditable: false, required: true });
  assert.equal(bambu.brand, "Bambu Lab");
});

test("declares itself monitor-only and offers no control surface", () => {
  const caps = getCapabilities("bambulab-h2", {});
  assert.equal(caps.control, false);
  for (const k of ["camera", "headMapping", "excludeObject", "unloadFilament", "setColor", "firmwareDeploy", "fileSync", "webUi"]) {
    assert.equal(caps[k], false, k);
  }
  assert.equal(caps.filamentHeads, true, "AMS slots are status, and are shown");
  assert.notEqual(caps.thumbnails, false, "job previews are served (read over FTPS)");
  assert.equal(caps.cameraStream, false, "no camera until the printer reports LAN Only Liveview");
});

test("every control export refuses with the monitor-only error instead of acting", async () => {
  for (const fn of ["uploadFile", "startPrintFile", "pause", "resume", "cancel", "eject", "estop", "bedTemp"]) {
    await assert.rejects(bambu[fn]({ name: "H2D-1" }), e => e.code === "monitor_only" && e.status === 409 && /H2D-1/.test(e.message), fn);
  }
  assert.deepEqual(await bambu.listFiles({}), []);
  await assert.rejects(bambu.getThumbnail({}, "x"), e => e.status === 404);
});

// ---- state mapping ----

test("gcode_state maps onto SnapCon's state vocabulary", () => {
  assert.equal(I.mapState("IDLE", 0), "standby");
  assert.equal(I.mapState("PREPARE", 0), "printing", "heating/levelling before layer 1 is busy");
  assert.equal(I.mapState("SLICING", 0), "printing");
  assert.equal(I.mapState("RUNNING", 0), "printing");
  assert.equal(I.mapState("PAUSE", 0), "paused");
  assert.equal(I.mapState("FINISH", 0), "complete");
  assert.equal(I.mapState("INIT", 0), "unknown", "unverified meaning is not guessed");
  assert.equal(I.mapState(undefined, 0), "unknown");
});

test("FAILED is a cancel when the code says so (or there is none), an error otherwise", () => {
  assert.equal(I.mapState("FAILED", 0x0300400C), "cancelled");
  assert.equal(I.mapState("FAILED", 0), "cancelled");
  assert.equal(I.mapState("FAILED", 0x0300_8003), "error");
});

test("print_error is formatted the way Bambu prints it, zero-padded", () => {
  assert.equal(I.formatPrintError(50348044), "0300_400C");
  assert.equal(I.formatPrintError(0x07008011), "0700_8011");
  assert.equal(I.formatPrintError(0x0000_0001), "0000_0001");
  assert.equal(I.formatPrintError(0xC0010002), "C001_0002", "top bit set must not go negative");
  assert.equal(I.formatPrintError(0), "");
});

// ---- H2D (dual nozzle) ----

test("H2D: job fields, packed temperatures and remaining time", () => {
  const r = norm(h2dPrinting());
  assert.equal(r.online, true);
  assert.equal(r.state, "printing");
  assert.equal(r.filename, "Bracket v4");
  assert.equal(r.progress, 0.37);
  assert.equal(r.remaining, 95 * 60, "minutes from the printer -> seconds");
  assert.deepEqual(r.layer, { current: 41, total: 180 });
  assert.deepEqual(r.bed, { temp: 65, target: 65 }, "device.bed.info.temp, unpacked");
  assert.deepEqual(r.hotend, { temp: 220, target: 220 }, "the ACTIVE (right) nozzle");
  assert.equal(r.speed, 100);
  assert.equal(r.fanPct, 80, "gear 12 of 15");
  assert.equal(r.errorCode, "");
  assert.equal(r.message, "");
});

test("H2D: the hotend follows the active extruder bits, not extruder 0", () => {
  const rep = h2dPrinting();
  rep.device.extruder.state = 0x12; // two extruders, active = 1 (left)
  assert.deepEqual(norm(rep).hotend, { temp: 48, target: 0 });
});

test("H2D: every AMS slot and both external holders become lanes, named like the printer names them", () => {
  const { heads } = norm(h2dPrinting());
  assert.deepEqual(heads.map(h => h.label), ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4", "Ext-L", "Ext-R"]);
  assert.deepEqual(heads.map(h => h.loaded), [true, true, false, true, true, true, true, true, false, false]);
  assert.equal(heads[0].hex, "#FFFFFF");
  assert.equal(heads[3].material, "PETG");
  assert.equal(heads[3].hex, "#2850E0", "RRGGBBAA -> #RRGGBB");
  assert.equal(heads[0].official, true, "Bambu RFID spool (non-zero tray_uuid)");
  assert.equal(heads[2].hex, null, "an empty slot has no colour");
});

test("H2D: the active lane is the slot the active nozzle's `snow` names", () => {
  const r = norm(h2dPrinting());
  assert.equal(r.heads[r.activeExt].label, "B4", "snow 0x0103 = AMS 1, slot 3");
});

test("H2D: an external spool feeding the right nozzle is the active lane", () => {
  const rep = h2dPrinting();
  rep.vir_slot[1] = { id: "255", tray_type: "TPU", tray_color: "9B9EA0FF" };
  rep.device.extruder.info[0].snow = 0xff00; // ams 255, slot 0
  const r = norm(rep);
  assert.equal(r.heads[r.activeExt].label, "Ext-R");
  assert.equal(r.heads[r.activeExt].material, "TPU");
});

test("H2D: slot byte 0xFF means nothing is loaded — no lane is marked active", () => {
  const rep = h2dPrinting();
  rep.device.extruder.info[0].snow = 0xffff;
  assert.equal(norm(rep).activeExt, null);
});

test("slot presence comes from tray_exist_bits, not from a leftover filament type", () => {
  const rep = h2dPrinting();
  // Slot A1 still carries its last material, but the printer says it is empty.
  rep.ams.tray_exist_bits = "fa";
  assert.equal(norm(rep).heads[0].loaded, false);
  assert.equal(norm(rep).heads[0].material, null);
});

test("an AMS unit the printer no longer reports as present is dropped", () => {
  const rep = h2dPrinting();
  rep.ams.ams_exist_bits = "2"; // only unit 1
  assert.deepEqual(norm(rep).heads.map(h => h.label).slice(0, 4), ["B1", "B2", "B3", "B4"]);
});

test("AMS HT units get their own lane after the AMS units", () => {
  const rep = h2dPrinting();
  rep.ams.ams.push({ id: "128", info: "2004", tray: [tray0("PLA", "C12E1FFF")] });
  rep.ams.ams_exist_bits = "13";      // units 0, 1 and HT 128 (bit 4)
  rep.ams.tray_exist_bits = "100fb";  // ... and the HT's slot (bit 16)
  const labels = norm(rep).heads.map(h => h.label);
  assert.deepEqual(labels.slice(8), ["HT1", "Ext-L", "Ext-R"]);
  assert.equal(norm(rep).heads[8].loaded, true);
});
function tray0(type, color) { return { id: "0", tray_type: type, tray_color: color }; }

// ---- H2S (single nozzle) ----

test("H2S: single nozzle, one external holder labelled plainly", () => {
  const r = norm(h2sPrinting());
  assert.deepEqual(r.hotend, { temp: 275, target: 275 });
  assert.deepEqual(r.bed, { temp: 105, target: 105 });
  assert.deepEqual(r.heads.map(h => h.label), ["A1", "A2", "A3", "A4", "Ext"]);
  assert.equal(r.heads[r.activeExt].label, "A1");
  assert.equal(r.fanPct, 13);
});

// ---- older single-nozzle firmware ----

test("without a device object the legacy fields are used", () => {
  const r = norm(legacySingleNozzle());
  assert.deepEqual(r.hotend, { temp: 219, target: 220 });
  assert.deepEqual(r.bed, { temp: 60, target: 60 });
  assert.equal(r.filename, "widget.gcode.3mf", "no subtask_name -> the file's own name");
  assert.equal(r.heads[r.activeExt].label, "A3", "tray_now 2 = AMS 0, slot 2");
  assert.equal(r.heads.at(-1).label, "Ext");
  assert.equal(r.heads.at(-1).material, "TPU");
});

test("a pause the printer took on an error shows the code; a plain pause does not", () => {
  const r = norm(legacySingleNozzle());
  assert.equal(r.state, "paused");
  assert.equal(r.errorCode, "0700_8011");
  assert.match(r.message, /0700_8011/);
  const plain = legacySingleNozzle();
  plain.print_error = 0;
  assert.equal(norm(plain).errorCode, "");
  assert.equal(norm(plain).message, "");
});

test("an error code left over on an idle or running printer is not raised", () => {
  for (const gs of ["IDLE", "RUNNING", "FINISH"]) {
    const rep = h2dPrinting();
    rep.gcode_state = gs;
    rep.print_error = 0x03008003;
    assert.equal(norm(rep).errorCode, "", gs);
  }
});

test("a failed print raises an error panel; a cancelled one does not", () => {
  const failed = h2dPrinting();
  failed.gcode_state = "FAILED"; failed.print_error = 0x03008003;
  assert.equal(norm(failed).state, "error");
  assert.equal(norm(failed).errorCode, "0300_8003");
  const cancelled = h2dPrinting();
  cancelled.gcode_state = "FAILED"; cancelled.print_error = 0x0300400C;
  assert.equal(norm(cancelled).state, "cancelled");
  assert.equal(norm(cancelled).errorCode, "");
});

test("remaining time is only reported while a print is running or paused", () => {
  const idle = h2dPrinting();
  idle.gcode_state = "IDLE";
  assert.equal(norm(idle).remaining, null);
  const done = h2dPrinting();
  done.gcode_state = "FINISH";
  assert.equal(norm(done).remaining, null);
  assert.equal(norm(done).progress, 1);
});

test("numbers the printer sends as strings are read as numbers", () => {
  const rep = h2dPrinting();
  rep.mc_percent = "50"; rep.layer_num = "7"; rep.total_layer_num = "9"; rep.spd_mag = "124";
  const r = norm(rep);
  assert.equal(r.progress, 0.5);
  assert.deepEqual(r.layer, { current: 7, total: 9 });
  assert.equal(r.speed, 124);
});

test("an empty report normalizes without throwing", () => {
  const r = norm({});
  assert.equal(r.state, "unknown");
  assert.deepEqual(r.heads, []);
  assert.equal(r.hotend, null);
  assert.equal(r.bed, null);
});

// ---- elapsed time ----

test("elapsed time runs from when SnapCon saw the job start, and freezes when it ends", () => {
  const rep = h2dPrinting();
  rep.gcode_state = "PREPARE"; rep.mc_percent = 0;
  let job = I.trackJob(null, rep, 1000000);
  rep.gcode_state = "RUNNING"; rep.mc_percent = 10;
  job = I.trackJob(job, rep, 1060000);
  assert.equal(norm(rep, { job, now: 1090000 }).elapsed, 90);
  rep.gcode_state = "FINISH";
  job = I.trackJob(job, rep, 1200000);
  assert.equal(norm(rep, { job, now: 9999999 }).elapsed, 200, "frozen at the finish");
});

test("a job first met mid-print reports no elapsed time rather than a wrong one", () => {
  const rep = h2dPrinting(); // RUNNING at 37%
  const job = I.trackJob(null, rep, 5000);
  assert.equal(norm(rep, { job, now: 65000 }).elapsed, null);
});

test("the same file printed again is a new job", () => {
  const rep = h2dPrinting();
  rep.gcode_state = "PREPARE"; rep.mc_percent = 0;
  let job = I.trackJob(null, rep, 0);
  rep.gcode_state = "FINISH";
  job = I.trackJob(job, rep, 100000);
  rep.gcode_state = "PREPARE";
  job = I.trackJob(job, rep, 500000);
  assert.equal(job.startedAt, 500000);
  assert.equal(job.finishedAt, null);
});

// ---- delta merging ----

test("a delta updates one tray without erasing the others", () => {
  const base = h2dPrinting();
  const merged = I.mergeReport(structuredClone(base), { ams: { ams: [{ id: "1", tray: [{ id: "2", remain: 5 }] }] } });
  const unitB = merged.ams.ams.find(u => u.id === "1");
  assert.equal(unitB.tray.length, 4);
  assert.equal(unitB.tray.find(t => t.id === "2").remain, 5);
  assert.equal(unitB.tray.find(t => t.id === "2").tray_type, "ABS", "untouched fields survive");
  assert.equal(merged.ams.ams.length, 2, "the other unit survives");
});

test("a delta updates scalars and nested device fields in place", () => {
  const merged = I.mergeReport(h2dPrinting(), { mc_percent: 38, device: { extruder: { info: [{ id: 0, temp: 14418141 }] } } });
  assert.equal(merged.mc_percent, 38);
  assert.equal(merged.device.extruder.info.length, 2);
  assert.equal(merged.device.extruder.info[0].snow, 259);
  assert.equal(merged.subtask_name, "Bracket v4");
});

test("lists without ids (hms) are replaced, not accumulated", () => {
  const merged = I.mergeReport({ hms: [{ attr: 1, code: 2 }, { attr: 3, code: 4 }] }, { hms: [] });
  assert.deepEqual(merged.hms, []);
});

// ---- config / errors ----

test("serial and access code are required, and say where to find them", () => {
  assert.match(I.printerConfig({ url: "mqtts://10.0.0.5", verificationCode: "12345678" }).error, /serial/i);
  assert.match(I.printerConfig({ url: "mqtts://10.0.0.5", serial: "0940XXXX" }).error, /access code/i);
  assert.match(I.printerConfig({ serial: "x", verificationCode: "y" }).error, /address/i);
  const ok = I.printerConfig({ url: "mqtts://10.0.0.5", serial: " 0940AB ", verificationCode: "12345678" });
  assert.deepEqual([ok.host, ok.port, ok.serial, ok.code], ["10.0.0.5", 8883, "0940AB", "12345678"]);
});

test("connection failures are explained in terms an operator can act on", () => {
  assert.match(I.describeError({ code: "ECONNACK", returnCode: 5 }, "X"), /access code/);
  assert.match(I.describeError({ code: "ECONNACK", returnCode: 4 }, "X"), /access code/);
  assert.match(I.describeError({ code: "ERR_BAMBU_CERT_SERIAL", message: "cert is for Y" }, "X"), /Serial number mismatch/);
  assert.match(I.describeError({ code: "SELF_SIGNED_CERT_IN_CHAIN" }, "X"), /SNAPCON_BAMBU_INSECURE_TLS/);
  assert.match(I.describeError({ code: "ECONNREFUSED" }, "X"), /8883/);
  assert.match(I.describeError({ code: "ETIMEDOUT" }, "X"), /Could not reach X/);
});

test("model is read off the serial prefix", () => {
  assert.equal(bambu.modelFromSerial("0940A1B2C3D4E5F"), "H2D");
  assert.equal(bambu.modelFromSerial("239xxxxx"), "H2D Pro");
  assert.equal(bambu.modelFromSerial("093xxxxx"), "H2S");
  assert.equal(bambu.modelFromSerial("31bxxxxx"), "H2C", "case-insensitive");
  assert.equal(bambu.modelFromSerial("01P00A000000000"), null, "not an H2");
  assert.equal(bambu.modelFromSerial(""), null);
});

// ---- probe() over a live (fake) broker ----

const SERIAL = "0940TESTH2D0001";
const CODE = "a1b2c3d4";

async function withBroker(fn, opts = {}) {
  const broker = createFakeBambuBroker({
    serial: SERIAL, accessCode: CODE, report: h2dPrinting(),
    version: [{ name: "ota", product_name: "Bambu Lab H2D", sw_ver: "01.01.01.00" }],
    ...opts
  });
  const port = await broker.listen();
  I.setTransportFactory(cfg => net.connect(cfg.port, cfg.host));
  try { await fn(broker, port); }
  finally {
    for (const [key, c] of I.connections) { I.teardown(c); I.connections.delete(key); }
    I.setTransportFactory(null);
    await broker.close();
  }
}
const printerAt = (port, over = {}) => ({ id: "p_bambu_1", name: "H2D-1", url: `mqtts://127.0.0.1:${port}`, serial: SERIAL, verificationCode: CODE, ...over });

test("probe: first call waits for the first report and returns live status", async () => {
  await withBroker(async (broker, port) => {
    const r = await bambu.probe(printerAt(port));
    assert.equal(r.online, true, r.error);
    assert.equal(r.state, "printing");
    assert.equal(r.filename, "Bracket v4");
    assert.deepEqual(broker.state.subscriptions, [`device/${SERIAL}/report`]);
    assert.equal(broker.state.logins[0].username, "bblp");
  });
});

test("probe: the connector only ever asks the printer to REPORT — it never commands it", async () => {
  await withBroker(async (broker, port) => {
    await bambu.probe(printerAt(port));
    await new Promise(r => setTimeout(r, 50));
    assert.ok(broker.state.requests.length >= 1);
    for (const { topic, json } of broker.state.requests) {
      assert.equal(topic, `device/${SERIAL}/request`);
      const kind = json.pushing ? "pushing." + json.pushing.command : json.info ? "info." + json.info.command : Object.keys(json).join(",");
      assert.ok(["pushing.pushall", "info.get_version"].includes(kind), "unexpected request to the printer: " + kind);
    }
  });
});

test("probe: later calls read the persistent session, and pushed deltas show up", async () => {
  await withBroker(async (broker, port) => {
    const p = printerAt(port);
    await bambu.probe(p);
    broker.push({ mc_percent: 55, layer_num: 90 });
    await new Promise(r => setTimeout(r, 50));
    const r = await bambu.probe(p);
    assert.equal(r.progress, 0.55);
    assert.deepEqual(r.layer, { current: 90, total: 180 });
    assert.equal(broker.state.logins.length, 1, "one session per printer, reused");
  });
});

test("probe: a wrong access code comes back offline with the reason, not a hang", async () => {
  await withBroker(async (_broker, port) => {
    const t0 = Date.now();
    const r = await bambu.probe(printerAt(port, { verificationCode: "wrong123" }));
    assert.equal(r.online, false);
    assert.match(r.error, /access code/);
    assert.ok(Date.now() - t0 < 3000, "answered as soon as the broker refused");
  });
});

test("probe: a printer that is not there comes back offline", async () => {
  const srv = net.createServer();
  const port = await new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  await new Promise(r => srv.close(r));
  I.setTransportFactory(cfg => net.connect(cfg.port, cfg.host));
  try {
    const r = await bambu.probe(printerAt(port, { id: "p_gone" }));
    assert.equal(r.online, false);
    assert.match(r.error, /refused/i);
  } finally {
    for (const [key, c] of I.connections) { I.teardown(c); I.connections.delete(key); }
    I.setTransportFactory(null);
  }
});

test("probe: a dropped session reports offline, then reconnects on its own", async () => {
  await withBroker(async (broker, port) => {
    const p = printerAt(port);
    assert.equal((await bambu.probe(p)).online, true);
    broker.dropAll();
    await new Promise(r => setTimeout(r, 50));
    assert.equal((await bambu.probe(p)).online, false);
    // Backoff starts at ~1 s.
    await new Promise(r => setTimeout(r, 1800));
    const again = await bambu.probe(p);
    assert.equal(again.online, true, again.error);
    assert.equal(broker.state.logins.length, 2);
  });
});

test("probe: Test connection (an unsaved row, no id) uses a one-off session that is closed afterwards", async () => {
  await withBroker(async (broker, port) => {
    const r = await bambu.probe(printerAt(port, { id: undefined }));
    assert.equal(r.online, true, r.error);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(I.connections.size, 0, "no lingering connection");
    assert.equal(broker.state.sockets.size, 0, "socket closed at the broker too");
  });
});

test("probe: changing the access code in Settings reconnects with the new one", async () => {
  await withBroker(async (broker, port) => {
    const bad = await bambu.probe(printerAt(port, { verificationCode: "wrong123" }));
    assert.equal(bad.online, false);
    const good = await bambu.probe(printerAt(port));
    assert.equal(good.online, true, good.error);
    assert.deepEqual(broker.state.logins.map(l => l.accepted), [false, true]);
  });
});

test("probe: missing credentials are reported without opening a connection", async () => {
  const r = await bambu.probe({ id: "p_x", name: "H2D-2", url: "mqtts://10.1.1.1" });
  assert.equal(r.online, false);
  assert.match(r.error, /serial/i);
  assert.equal(I.connections.size, 0);
});

// ---- review follow-ups ----

test("the serial is upper-cased, so a lower-case entry still subscribes to the printer's real topic", async () => {
  assert.equal(I.printerConfig({ url: "mqtts://10.0.0.5", serial: "0940abc", verificationCode: "x" }).serial, "0940ABC");
  await withBroker(async (broker, port) => {
    const r = await bambu.probe(printerAt(port, { serial: SERIAL.toLowerCase() }));
    assert.equal(r.online, true, r.error);
    assert.deepEqual(broker.state.subscriptions, [`device/${SERIAL}/report`]);
  });
});

test("a printer that accepts and immediately drops the session is NOT redialled every second", async () => {
  await withBroker(async (broker, port) => {
    broker.state.dropAfterSubscribe = true;
    broker.state.answerPushall = false;
    const p = printerAt(port, { id: "p_flap" });
    await bambu.probe(p);
    await new Promise(r => setTimeout(r, 3500));
    const c = I.connections.get("p_flap");
    assert.ok(c.reconnectAttempts >= 2, "backoff keeps growing: " + c.reconnectAttempts);
    assert.ok(broker.state.logins.length <= 3, "logins in 3.5 s: " + broker.state.logins.length);
  });
});

test("an idle printer, or one still preparing, reports no progress from a stale mc_percent", () => {
  const idle = h2dPrinting();
  idle.gcode_state = "IDLE"; idle.mc_percent = 100;
  assert.equal(norm(idle).progress, 0);
  const preparing = h2dPrinting();
  preparing.gcode_state = "PREPARE"; preparing.mc_percent = 100;
  assert.equal(norm(preparing).state, "printing");
  assert.equal(norm(preparing).progress, 0, "a new job must not start at 100%");
  const paused = h2dPrinting();
  paused.gcode_state = "PAUSE";
  assert.equal(norm(paused).progress, 0.37);
});

test("a tray reported as just its id is an emptied slot, not a no-op", () => {
  const base = h2dPrinting();
  delete base.ams.tray_exist_bits; // make presence depend on the tray itself
  const merged = I.mergeReport(structuredClone(base), { ams: { ams: [{ id: "0", tray: [{ id: "1" }] }] } });
  const slot = merged.ams.ams.find(u => u.id === "0").tray.find(t => t.id === "1");
  assert.deepEqual(slot, { id: "1" });
  assert.equal(norm(merged).heads[1].loaded, false);
  assert.equal(norm(merged).heads[0].loaded, true, "the neighbours are untouched");
});
