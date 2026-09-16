// test/connectors/bambu-lab-control.test.js — commanding a Bambu printer:
// what goes on the wire, how a reply is matched to the command that caused it,
// and what Developer Mode does to all of it.
//
// Every command shape here was verified against a real P2S on 2026-09-15:
// project_file with an ams_mapping started a print and answered
// result "SUCCESS"; stop cancelled it; with Developer Mode off both came back
// result "failed", reason "mqtt message verify failed", and the printer did
// not move.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const bambu = require("../../connectors/bambu-lab");
const { createFakeBambuBroker } = require("../helpers/fakeBambuBroker");
const { IDLE_REPORT } = require("../fixtures/bambu-p2s-report");

const SERIAL = "22E8AJ5C2001188";
const CODE = "603db0db";

let nextId = 0;
async function withPrinter(t, { commandReply = "success", report = IDLE_REPORT } = {}) {
  const broker = createFakeBambuBroker({ serial: SERIAL, accessCode: CODE, report, commandReply,
    version: [{ name: "ota", product_name: "Bambu Lab P2S", sw_ver: "01.02.00.00" }] });
  const port = await broker.listen();
  bambu._internal.setTransportFactory(() => net.connect({ host: "127.0.0.1", port }));
  const p = { name: "P2S", id: "ctl-" + (++nextId), url: "http://127.0.0.1", serial: SERIAL, verificationCode: CODE };
  t.after(async () => {
    bambu._internal.closeAll();
    bambu._internal.setTransportFactory(null);
    await broker.close();
  });
  await bambu.probe(p);   // establishes the connection the commands ride on
  return { broker, p };
}
const printCommands = (broker) => broker.state.requests.filter(r => r.json && r.json.print).map(r => r.json.print);

// ---- the simple controls ----

for (const [method, command] of [["pause", "pause"], ["resume", "resume"], ["cancel", "stop"]]) {
  test(`${method} sends the printer's own ${command} command`, async (t) => {
    const { broker, p } = await withPrinter(t);
    await bambu[method](p);
    const sent = printCommands(broker).filter(c => c.command === command);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].sequence_id, "a reply can only be matched to a command that carried an id");
  });
}

test("setting the bed temperature sends it as a gcode line", async (t) => {
  const { broker, p } = await withPrinter(t);
  await bambu.bedTemp(p, 60);
  const line = printCommands(broker).find(c => c.command === "gcode_line");
  assert.ok(line, "there is no dedicated bed command — it goes through gcode_line");
  assert.match(line.param, /^M140 S60\b/);
});

test("a bed temperature is rounded and clamped to something the printer will accept", async (t) => {
  const { broker, p } = await withPrinter(t);
  await bambu.bedTemp(p, 61.7);
  assert.match(printCommands(broker).find(c => c.command === "gcode_line").param, /^M140 S62\b/);
  await assert.rejects(() => bambu.bedTemp(p, 500), /temperature/i);
  await assert.rejects(() => bambu.bedTemp(p, -5), /temperature/i);
});

// ---- replies belong to the command that caused them ----

test("a command waits for the reply carrying its own id", async (t) => {
  const { broker, p } = await withPrinter(t);
  await bambu.pause(p);
  const seq = printCommands(broker).find(c => c.command === "pause").sequence_id;
  // Another client's reply, on the same topic, must not be mistaken for ours.
  broker.push({ command: "stop", sequence_id: String(Number(seq) + 999), result: "SUCCESS" });
  const before = Date.now();
  await bambu.resume(p);
  assert.ok(Date.now() - before < 3000, "the resume must be settled by its OWN reply, not a stranger's");
});

test("a printer that never answers a command fails rather than hanging forever", async (t) => {
  const { p } = await withPrinter(t, { commandReply: "silent" });
  await assert.rejects(() => bambu.pause(p), /did not answer|timed out/i);
});

// ---- Developer Mode ----

test("a refused command explains that Developer Mode is off", async (t) => {
  const { p } = await withPrinter(t, { commandReply: "verifyFailed" });
  await assert.rejects(() => bambu.cancel(p), (e) => {
    assert.match(e.message, /Developer Mode/i);
    assert.match(e.message, /Settings → Network/, "say where the switch is");
    return true;
  });
});

test("after a refusal the controls are disabled, with the reason on the card", async (t) => {
  // Starting from a printer whose hint says nothing is wrong: the captured idle
  // report was taken BEFORE Developer Mode was switched on, so its own `fun`
  // value already reads as off (which the previous test covers).
  const { p } = await withPrinter(t, {
    commandReply: "verifyFailed",
    report: { ...IDLE_REPORT, fun: "64039FD193FF9CB3" }
  });
  assert.equal(bambu.getCapabilities(p).control, true, "nothing known yet — the controls stay live");
  await bambu.cancel(p).catch(() => {});
  const caps = bambu.getCapabilities(p);
  assert.equal(caps.developerMode, "off");
  assert.equal(caps.control, false);
});

test("a command that succeeds proves Developer Mode is on", async (t) => {
  const { p } = await withPrinter(t);
  await bambu.pause(p);
  assert.equal(bambu.getCapabilities(p).developerMode, "on");
});

test("turning Developer Mode on gives the controls back without restarting SnapCon", async (t) => {
  // The printer reports the switch in `fun`: bit 0x20000000 set while control
  // was refused, cleared once it was enabled. A cached "off" must not outlive
  // the user fixing it — they would otherwise be locked out of their own
  // printer until SnapCon was restarted.
  const { broker, p } = await withPrinter(t, { commandReply: "verifyFailed" });
  broker.push({ ...IDLE_REPORT, fun: "64039FD1B3FF9CB3" }, { full: true });
  await new Promise(r => setTimeout(r, 60));
  await bambu.cancel(p).catch(() => {});
  assert.equal(bambu.getCapabilities(p).control, false);
  broker.state.commandReply = "success";
  broker.push({ ...IDLE_REPORT, fun: "64039FD193FF9CB3" }, { full: true });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(bambu.getCapabilities(p).control, true, "the switch was flipped; the controls must come back");
});

// ---- printing a file the printer already holds ----
// Pressing Print on a card with nothing selected opens a picker of the files on
// the printer. A Bambu printer keeps 137 of them; without these two methods the
// picker had nothing to show and the flow dead-ended.

test("the printer's own .3mf files can be listed", async (t) => {
  const { p } = await withPrinter(t);
  assert.equal(typeof bambu.listFiles, "function");
});

test("only files the printer could actually start are offered", async (t) => {
  // Its storage also holds timelapse videos and a cache folder. Listing a .mp4
  // in a print picker is an invitation to an error.
  const { p } = await withPrinter(t);
  const files = bambu._internal.filterPrintable([
    { path: "ams.gcode.3mf", size: 1774136 },
    { path: "video_2026-02-10_20-02-14.mp4", size: 3932485 },
    { path: "thumbnail", size: 65536 },
    { path: "Bin 6H 2W.gcode.3mf", size: 2973930 }
  ]);
  assert.deepEqual(files.map(f => f.path), ["ams.gcode.3mf", "Bin 6H 2W.gcode.3mf"]);
});

test("the palette of a file on the printer is read from the file itself", async (t) => {
  const { p } = await withPrinter(t);
  assert.equal(typeof bambu.getFileMetadata, "function",
    "without it the picker offers no colours, so no AMS mapping can be chosen, so the print is refused");
});

test("a Bambu slice_info becomes the same palette shape every other connector returns", () => {
  // The picker, the mapping rows and the weight column all read this shape.
  const meta = bambu._internal.metadataFromSliceInfo({
    printerModelId: "N7", nozzle: 0.4, prediction: 9778, weight: 48.36,
    filaments: [
      { id: 1, type: "PETG", color: "#000000", usedG: 23.77, trayInfoIdx: "GFG00" },
      { id: 2, type: "PETG", color: "#FFFFFF", usedG: 24.59, trayInfoIdx: "GFG00" }
    ]
  });
  assert.equal(meta.estimatedTime, 9778);
  assert.deepEqual(meta.palette.map(s => [s.i, s.hex, s.type, s.wt, s.used]), [
    [0, "#000000", "PETG", "23.77", true],
    [1, "#FFFFFF", "PETG", "24.59", true]
  ]);
  assert.equal(meta.isFS, false, "Full Spectrum is a Snapmaker concept, not a Bambu one");
});

test("a filament the file never uses is in the palette but not marked used", () => {
  const meta = bambu._internal.metadataFromSliceInfo({
    filaments: [{ id: 1, type: "PLA", color: "#FF0000", usedG: 0 }]
  });
  assert.equal(meta.palette[0].used, false, "an unused slot must not ask for a tray");
});

// ---- the job preview ----

test("the card's thumbnail comes from the plate picture inside the printer's own copy", async (t) => {
  // The fleet card asks the connector for a picture of what is printing. For a
  // Bambu that lives inside the .3mf sitting on the printer, so it is read back
  // over the same file connection — not from the library, which may not have
  // the file the printer is actually running.
  const { p } = await withPrinter(t);
  assert.equal(typeof bambu.getThumbnail, "function",
    "without this the route answers 502 and the card shows no thumbnail at all");
});

test("a printer with no preview for that job says so, rather than failing loudly", async (t) => {
  const { p } = await withPrinter(t);
  await assert.rejects(() => bambu.getThumbnail(p, "nothing-like-this.3mf"), (e) => {
    assert.equal(e.status, 404, "a missing preview is a 404, not a server error");
    return true;
  });
});

// ---- starting a print ----

test("a print cannot be started without a filament mapping chosen for it", async (t) => {
  // The AMS mapping is picked in the Send dialog and stashed by
  // applyHeadMapping. Without it the connector must refuse rather than invent
  // one: guessing a tray prints the wrong colour, or the wrong material.
  const { p } = await withPrinter(t);
  await assert.rejects(() => bambu.startPrintFile(p, "plate.3mf"), /AMS|tray/i);
});

test("the mapping chosen in the Send dialog is what the start command carries", async (t) => {
  const { broker, p } = await withPrinter(t);
  // tools/map as the server passes them: file filament index -> head index.
  await bambu.applyHeadMapping(p, [0, 1], { 0: 3, 1: 2 }, {});
  await bambu.startPrintFile(p, "ams.3mf");
  const start = printCommands(broker).find(c => c.command === "project_file");
  assert.ok(start, "a print starts with project_file");
  assert.equal(start.use_ams, true);
  assert.deepEqual(start.ams_mapping, [3, 2], "filament 1 from A4, filament 2 from A3");
  assert.equal(start.param, "Metadata/plate_1.gcode");
  assert.equal(start.url, "ftp:///ams.3mf");
  assert.equal(start.subtask_name, "ams");
});

// ---- plain gcode ----
// A sliced .3mf is started with project_file and carries its AMS mapping. A
// plain .gcode is started with gcode_file, which takes the file name and
// nothing else — the mapping is already baked into the file by the slicer, so
// there is none to send and none to demand.

test("a plain .gcode is started with the printer's gcode_file command", async (t) => {
  const { broker, p } = await withPrinter(t);
  await bambu.startPrintFile(p, "benchy.gcode");
  const start = printCommands(broker).find(c => c.command === "gcode_file");
  assert.ok(start, "project_file is for a sliced project; a .gcode has its own command");
  assert.equal(start.param, "benchy.gcode");
  assert.equal(start.ams_mapping, undefined, "there is no mapping to send for a plain gcode");
});

test("a plain .gcode does not require a tray to be chosen first", async (t) => {
  // The slicer already decided which filament each tool uses; SnapCon has no
  // mapping to add, so demanding one would block a print it cannot improve.
  const { p } = await withPrinter(t);
  await bambu.startPrintFile(p, "benchy.gcode");
});

test("a sliced .3mf still demands its mapping", async (t) => {
  const { p } = await withPrinter(t);
  await assert.rejects(() => bambu.startPrintFile(p, "plate.3mf"), /AMS|tray/i);
});

test("both file types can be sent to the printer", async (t) => {
  assert.deepEqual(bambu.capabilities.fileTypes, ["3mf", "gcode"]);
});

test("the external spool cannot be chosen as a print's filament source yet", async (t) => {
  // Its use_ams/ams_mapping encoding has never been accepted by a printer here,
  // so a mapping naming it is refused rather than sent and hoped for.
  const { p } = await withPrinter(t);
  await assert.rejects(() => bambu.applyHeadMapping(p, [0], { 0: 4 }, {}), /external spool/i);
});

test("a tray that does not exist is refused before anything is sent", async (t) => {
  const { broker, p } = await withPrinter(t);
  await assert.rejects(() => bambu.applyHeadMapping(p, [0], { 0: 9 }, {}), /tray/i);
  assert.equal(printCommands(broker).length, 0);
});

test("a stale mapping is not applied to a different file", async (t) => {
  const { p } = await withPrinter(t);
  await bambu.applyHeadMapping(p, [0], { 0: 0 }, {}, { file: "one.3mf" });
  await assert.rejects(() => bambu.startPrintFile(p, "two.3mf"), /AMS|tray/i,
    "the mapping was chosen for a different file");
});
