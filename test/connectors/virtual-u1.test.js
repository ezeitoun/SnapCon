// test/connectors/virtual-u1.test.js — the real U1 connector
// (connectors/snapmaker-u1-klipper.js) against the virtual U1
// (fixtures/virtual-u1/): a Moonraker server on 127.0.0.1 in front of a
// four-head printer model built from captures of real U1s.
//
// What these tests can and cannot prove: they check SnapCon against the U1
// as the captures and Snapmaker's source describe it. Anything the model
// marks [guess] (durations, some reply shapes) is not evidence about a real
// printer, and passing here never counts as hardware validation.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const u1c = require("../../connectors/snapmaker-u1-klipper");
const { startVirtualU1, availableFirmware } = require("../../fixtures/virtual-u1");

const DRAGON = "Virtual dragon (4 colours).gcode";
const CUBE = "Virtual cube (single colour).gcode";
const EXT = ["extruder", "extruder1", "extruder2", "extruder3"];

async function virtualU1(t, opts) {
  const u1 = await startVirtualU1(opts);
  t.after(() => u1.close());
  return { u1, p: { id: "virtual-" + u1.port, name: "Virtual U1", url: u1.url } };
}
const head = (u1, i) => u1.model.status()[EXT[i]];
const mapTable = u1 => u1.model.status().print_task_config.extruder_map_table.slice(0, 4);

// Map file colours 0,1 onto physical heads 2,3 and start the four-colour file
// printing only with those two — a two-head job on the "wrong" heads, so a
// connector that ignored the map would show up.
async function startMappedPrint(u1, p, { tools = [0, 1], map = { 0: 2, 1: 3 }, file } = {}) {
  const name = file || "Two colour mapped.gcode";
  if (!file) u1.model.addFile(name, { tools, layers: 6, secondsPerLayer: 40 });
  await u1c.applyHeadMapping(p, tools, map, { autoLevel: false, flowCalibrate: false, timelapse: false });
  await u1c.startPrintFile(p, name);
  return name;
}

// ---- status, per firmware version ----

for (const fw of availableFirmware()) {
  test(`firmware ${fw}: an idle U1 reads as standby with four loaded heads`, async t => {
    const { p } = await virtualU1(t, { firmware: fw });
    const st = await u1c.probe(p);
    assert.equal(st.online, true);
    assert.equal(st.state, "standby");
    assert.equal(st.errorCode, "");
    assert.equal(st.heads.length, 4);
    assert.deepEqual(st.heads.map(h => h.loaded), [true, true, true, true]);
    assert.deepEqual(st.heads.map(h => h.hex), ["#F5D629", "#000000", "#E53935", "#1E88E5"]);
    assert.equal(st.hotend, null, "no head is heating");
  });
}

test("an empty head reads as empty — no colour, no vendor, no material", async t => {
  const { p } = await virtualU1(t, { heads: [{ color: "#FF0000" }, { color: "#00FF00" }, null, { color: "#0000FF", official: true, vendor: "Snapmaker" }] });
  const st = await u1c.probe(p);
  assert.deepEqual(st.heads[2], { loaded: false, hex: null, vendor: null, material: null, sub: null, official: false });
  assert.equal(st.heads[3].official, true);
  assert.equal(st.heads[3].vendor, "Snapmaker");
});

// ---- head mapping and print start ----

test("head mapping lands in print_task_config: the map, the used heads, the preferences", async t => {
  const { u1, p } = await virtualU1(t);
  await u1c.applyHeadMapping(p, [0, 1], { 0: 2, 1: 3 }, { autoLevel: true, flowCalibrate: true, timelapse: false, flowCalibrateExtruders: [2] });
  const ptc = u1.model.status().print_task_config;
  assert.deepEqual(ptc.extruder_map_table.slice(0, 4), [2, 3, 2, 3], "only the listed tools change; the rest keep their value");
  assert.deepEqual(ptc.extruders_used, [false, false, true, true]);
  assert.equal(ptc.auto_bed_leveling, true);
  assert.equal(ptc.flow_calibrate, true);
  assert.equal(ptc.time_lapse_camera, false);
  assert.deepEqual(ptc.flow_calib_extruders, [false, false, true, false]);
  assert.deepEqual(u1.server.requests.filter(r => r.startsWith("POST")).length, 1, "one request for the whole mapping");
});

test("a print is 'printing' as soon as it starts, before any heating", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p);
  const st = await u1c.probe(p);
  assert.equal(st.state, "printing");
  assert.equal(st.progress, 0);
  assert.equal(st.layer, null, "no layer until the file reports one");
  assert.equal(st.activeExt, 2, "file colour 0 runs on physical head 2");
  assert.equal(head(u1, 2).target, 215);
});

test("the firmware refuses a new head mapping while printing, and SnapCon surfaces its code", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p);
  await assert.rejects(u1c.applyHeadMapping(p, [0], { 0: 1 }, {}), /Moonraker 400: .*0001-0531-0000-0015/);
  assert.deepEqual(mapTable(u1), [2, 3, 2, 3], "the running job's map is untouched");
});

test("starting a second print while one runs is refused with 'SD busy'", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p);
  await assert.rejects(u1c.startPrintFile(p, CUBE), /0001-0531-0000-0001.*SD busy/);
});

test("a file name with a quote or line break never reaches the printer", async t => {
  const { u1, p } = await virtualU1(t);
  // startPrintFile throws before it builds a request, not as a rejection.
  assert.throws(() => u1c.startPrintFile(p, 'evil".gcode'), /Invalid characters/);
  assert.throws(() => u1c.startPrintFile(p, "a.gcode\nM112"), /Invalid characters/);
  assert.equal(u1.model.gcodeLog.length, 0);
});

// ---- four heads during a print ----

test("tool changes: the active head follows the map, and the fleet card follows the active head", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p);
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    u1.model.advance(20);
    const st = await u1c.probe(p);
    seen.add(st.activeExt);
    const active = EXT.findIndex((_, h) => head(u1, h).state === "ACTIVATE");
    assert.equal(st.activeExt, active, "activeExt is the head that is actually picked");
  }
  assert.deepEqual([...seen].sort(), [2, 3], "only the two mapped heads ever print");
  assert.equal(head(u1, 0).target, 0);
  assert.equal(head(u1, 1).target, 0);
});

test("a parked head waits at standby temperature, then heats before its turn (as seen on Gold and Yellow)", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p);
  let sawStandby = false, sawPreheat = false;
  for (let i = 0; i < 60; i++) {
    u1.model.advance(5);
    for (let h = 0; h < 4; h++) {
      const e = head(u1, h);
      if (e.state !== "PARKED") continue;
      if (e.target === 65) sawStandby = true;
      if (e.target === 215) sawPreheat = true;
    }
  }
  assert.ok(sawStandby, "a used head parked at 65°C");
  assert.ok(sawPreheat, "the next head heated to print temperature while parked");
});

test("hotend shows the active head when it is the only hot one", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p, { tools: [0], map: { 0: 1 } });
  u1.model.advance(60);
  const st = await u1c.probe(p);
  assert.equal(st.activeExt, 1);
  assert.deepEqual(st.hotend, { temp: 215, target: 215 });
});

// Finding, not fixed here: probe() takes the FIRST head (0→3) whose target is
// above 80 and whose temperature is not more than 5° ABOVE it — so a parked
// head that is still heating (temperature far below target) qualifies, and a
// lower-numbered one wins over the head that is printing. Live evidence:
// fixtures/virtual-u1/captures/2.0.0/printing.json has a parked head at a
// 215 target while another prints.
test("hotend shows the active head, not a parked head that is preheating", { todo: "probe() picks the first heating head, not the active one — see docs/TODO.md" }, async t => {
  const { u1, p } = await virtualU1(t);
  u1.model.addFile("Preheat.gcode", { tools: [0, 1], layers: 4, secondsPerLayer: 60 });
  await u1c.applyHeadMapping(p, [0, 1], { 0: 3, 1: 1 }, {});
  await u1c.startPrintFile(p, "Preheat.gcode");
  // Into head 3's first segment, while head 1 preheats for the next one.
  let st;
  for (let i = 0; i < 40; i++) {
    u1.model.advance(2);
    if (head(u1, 1).target === 215 && head(u1, 1).temperature < 200 && head(u1, 3).state === "ACTIVATE") { st = await u1c.probe(p); break; }
  }
  assert.ok(st, "reached the preheat window");
  assert.equal(st.activeExt, 3);
  assert.equal(st.hotend.temp, Math.round(head(u1, 3).temperature));
});

// ---- pause, resume, cancel, complete, eject ----

test("pause drops every hot head to 40°C; resume puts the targets back", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p);
  u1.model.advance(120);
  const before = [0, 1, 2, 3].map(h => head(u1, h).target);
  await u1c.pause(p);
  assert.equal((await u1c.probe(p)).state, "paused");
  for (let h = 0; h < 4; h++) assert.equal(head(u1, h).target, before[h] > 0 ? 40 : 0);
  await u1c.resume(p);
  assert.equal((await u1c.probe(p)).state, "printing");
  assert.deepEqual([0, 1, 2, 3].map(h => head(u1, h).target), before);
});

test("PAUSE on an idle printer is not an error; RESUME on one is", async t => {
  const { p } = await virtualU1(t);
  await u1c.pause(p); // the firmware only prints "!! Cannot pause while not printing"
  await assert.rejects(u1c.resume(p), /Cannot resume while not paused: standby/); // [live] Yellow's wording
});

test("cancel ends 'cancelled', leaves the head picked, and resets the map", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p);
  u1.model.advance(100);
  const active = (await u1c.probe(p)).activeExt;
  await u1c.cancel(p);
  const st = await u1c.probe(p);
  assert.equal(st.state, "cancelled");
  assert.equal(head(u1, active).state, "ACTIVATE", "CANCEL_PRINT does not park (PRINT_END does)");
  assert.deepEqual(mapTable(u1), [0, 1, 2, 3]);
  assert.deepEqual(u1.model.status().print_task_config.reprint_info.extruder_map_table.slice(0, 4), [2, 3, 2, 3], "reprint_info keeps the last job's map");
  assert.ok([0, 1, 2, 3].every(h => head(u1, h).target === 0));
});

test("a job that runs to the end is 'complete', every head parked, the last one still named active", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p);
  u1.model.advance(600);
  const st = await u1c.probe(p);
  assert.equal(st.state, "complete");
  assert.equal(st.progress, 1);
  assert.deepEqual(st.layer, { current: 6, total: 6 }, "layers stay on the finished job");
  assert.ok([0, 1, 2, 3].every(h => head(u1, h).state === "PARKED"));
  assert.ok([2, 3].includes(st.activeExt), "toolhead.extruder keeps the last head, as Navy showed live");
  assert.deepEqual(mapTable(u1), [0, 1, 2, 3]);
  assert.equal(u1.model.history.at(-1).status, "completed");
});

test("eject returns to standby with no file", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p);
  u1.model.advance(600);
  await u1c.eject(p);
  const st = await u1c.probe(p);
  assert.equal(st.state, "standby");
  assert.equal(st.filename, "");
});

// ---- heads, filament, bed ----

test("unloading two heads empties exactly those two", async t => {
  const { u1, p } = await virtualU1(t);
  await u1c.unloadFilament(p, [1, 3]);
  const st = await u1c.probe(p);
  assert.deepEqual(st.heads.map(h => h.loaded), [true, false, true, false]);
  assert.deepEqual(u1.model.gcodeLog.filter(l => l.startsWith("AUTO_FEEDING")), ["AUTO_FEEDING EXTRUDER=1 UNLOAD=1", "AUTO_FEEDING EXTRUDER=3 UNLOAD=1"]);
  assert.equal(st.activeExt, 3, "unload picks the head it unloads (T<i> A0)");
});

test("setting a head's colour and material is written and read back", async t => {
  const { u1, p } = await virtualU1(t);
  const material = u1c.filamentMaterials.find(m => m.type === "PETG") || u1c.filamentMaterials[0];
  assert.equal(await u1c.setFilamentColor(p, 2, "#12AB34", { material }), "#12AB34");
  const st = await u1c.probe(p);
  assert.equal(st.heads[2].hex, "#12AB34");
  assert.equal(st.heads[2].material, material.type);
});

test("colour changes are refused while printing, and on an official RFID spool", async t => {
  const { u1, p } = await virtualU1(t, { heads: [{ color: "#111111", official: true, vendor: "Snapmaker" }, {}, {}, {}] });
  await assert.rejects(u1c.setFilamentColor(p, 0, "#222222"), /official Snapmaker RFID spool/);
  await startMappedPrint(u1, p);
  await assert.rejects(u1c.setFilamentColor(p, 1, "#222222"), /Printer is printing/);
});

test("a bed target above the U1's 100°C is refused by the printer", async t => {
  const { u1, p } = await virtualU1(t);
  await u1c.bedTemp(p, 60);
  assert.equal(u1.model.status().heater_bed.target, 60);
  await assert.rejects(u1c.bedTemp(p, 110), /Moonraker 400: .*out of range/);
});

test("exclude object: the plate lists the file's objects, and an excluded one is counted", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p);
  u1.model.advance(80);
  const plate = await u1c.getPlate(p);
  assert.equal(plate.objects.length, 3);
  await u1c.excludeObject(p, plate.objects[1].name);
  const st = await u1c.probe(p);
  assert.equal(st.plate.total, 3);
  assert.equal(st.plate.excluded, 1);
});

// ---- files ----

test("files: list, metadata palette, thumbnail, upload, identity check, delete", async t => {
  const { u1, p } = await virtualU1(t);
  assert.deepEqual((await u1c.listFiles(p)).map(f => f.path), [DRAGON, CUBE], "newest first");

  const meta = await u1c.getFileMetadata(p, DRAGON);
  assert.deepEqual(meta.palette.map(s => s.hex), ["#F5D629", "#000000", "#E53935", "#1E88E5"]);
  assert.equal(meta.estimatedTime, 12 * 60);

  const thumb = await u1c.getThumbnail(p, DRAGON);
  assert.equal(thumb.contentType, "image/png");
  assert.ok(u1.server.requests.some(r => r.includes("-300x300.png")), "the largest thumbnail is fetched");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "virtual-u1-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const local = path.join(dir, "Uploaded.gcode");
  fs.writeFileSync(local, Buffer.alloc(300 * 1024, 0x47));
  const job = { sent: 0, total: 0 };
  await u1c.uploadFile(p, local, "Uploaded.gcode", job);
  assert.equal(job.sent, job.total);
  const same = await u1c.compareRemoteFile(p, "Uploaded.gcode", local);
  assert.equal(same.identical, true, "head, middle and tail windows all matched over Range");

  await u1c.deleteFile(p, "Uploaded.gcode");
  assert.ok(!(await u1c.listFiles(p)).some(f => f.path === "Uploaded.gcode"));
});

// ---- firmware, health, inventory ----

test("firmware info: Klipper version and the five MCUs, all on one version", async t => {
  const { u1, p } = await virtualU1(t, { firmware: "1.6.0" });
  const info = await u1c.getFirmwareInfo(p, await u1c.probe(p));
  assert.equal(info.skipped, false);
  assert.match(info.klipper, /^1\.6\.0\./);
  assert.equal(info.firmware, "1.6.0");
  assert.deepEqual(info.mcus.map(m => m.name), ["mainboard", "toolhead e0", "toolhead e1", "toolhead e2", "toolhead e3"]);
  assert.equal(new Set(info.mcus.map(m => m.version)).size, 1);
  assert.equal(u1.model.status().mcu.mcu_version, info.mcus[0].version);
});

test("firmware info is skipped while printing", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p);
  const info = await u1c.getFirmwareInfo(p, await u1c.probe(p));
  assert.equal(info.skipped, true);
  assert.equal(info.reasonCode, "busy");
});

test("health: every section answers, with the U1's four heaters, fans and purifier", async t => {
  const { p } = await virtualU1(t);
  const h = await u1c.getHealth(p, await u1c.probe(p));
  for (const s of ["system", "mcus", "heaters", "fans", "storage", "history", "faults"]) assert.equal(h[s].available, true, s);
  assert.deepEqual(h.heaters.list.map(x => x.name).sort(), ["extruder", "extruder1", "extruder2", "extruder3", "heater_bed"]);
  assert.ok(h.fans.list.some(f => f.name === "purifier exhaust fan"));
  assert.equal(h.storage.categories.gcodes.fileCount, 2);
});

test("inventory reads the cleaned capture: no real serial or MAC", async t => {
  const { p } = await virtualU1(t);
  const inv = await u1c.getInventory(p);
  assert.equal(inv.machine_type, "Snapmaker U1");
  assert.equal(inv.serial, "VIRTUALU1000000000000");
  assert.match(inv.mac, /^02:00:00:00:00:0\d$/);
});

test("camera: start_monitor over the WebSocket, then a JPEG", async t => {
  const { u1, p } = await virtualU1(t);
  // The connector waits 1.2s after start_monitor and then arms a 60s
  // stop_monitor timer that would hold the test process open for a minute.
  // Mocked timers: the wait is ticked past, the 60s timer never runs.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = u1c.getCameraSnapshot(p);
  while (!u1.server.rpcLog.includes("camera.start_monitor")) await new Promise(r => setImmediate(r));
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); // let the RPC reply land
  t.mock.timers.tick(1200);
  const snap = await pending;
  assert.equal(snap.contentType, "image/jpeg");
  assert.equal(snap.buffer[0], 0xff);
  assert.ok(u1.server.rpcLog.includes("camera.start_monitor"));
});

// ---- faults ----

test("E-stop: Klipper shuts down and the card shows it, over the frozen job", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p);
  u1.model.advance(100);
  await u1c.estop(p);
  const st = await u1c.probe(p);
  assert.equal(st.online, true);
  assert.equal(st.state, "error");
  assert.equal(st.errorCode, "KLIPPER_SHUTDOWN");
  assert.match(st.message, /M112/);
  assert.ok(st.filename, "the job's fields stay as diagnostics");
});

test("a coded print error pauses the job and SnapCon decodes the code", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p);
  u1.model.advance(100);
  u1.model.runout(3);
  const st = await u1c.probe(p);
  assert.equal(st.state, "paused");
  assert.equal(st.errorCode, "0002-0523-0003-0000");
  assert.equal(st.message, "e3_filament runout");
  assert.equal(st.heads[3].loaded, false);
});

test("a coded error that is not a pause ends the job in 'error'", async t => {
  const { u1, p } = await virtualU1(t);
  await startMappedPrint(u1, p);
  u1.model.advance(100);
  u1.model.printError({ level: 3, id: 522, index: 0, code: 4, message: "motion fault", action: "cancel" });
  const st = await u1c.probe(p);
  assert.equal(st.state, "error");
  assert.equal(st.errorCode, "0003-0522-0000-0004");
});

test("Klippy disconnected: Moonraker answers 503, the printer reads offline", async t => {
  const { u1, p } = await virtualU1(t);
  u1.server.klippyDisconnect();
  const st = await u1c.probe(p);
  assert.equal(st.online, false);
  assert.equal(st.error, "HTTP 503");
  u1.server.klippyReady();
  assert.equal((await u1c.probe(p)).online, true);
});

test("an HTTP 500 and a malformed reply both read as offline, not as a state", async t => {
  const { u1, p } = await virtualU1(t);
  u1.server.faults.statusPath = /^\/printer\/objects\/query$/;
  assert.deepEqual(await u1c.probe(p), { name: "Virtual U1", online: false, error: "HTTP 500" });
  u1.server.faults.statusPath = null;
  u1.server.faults.malformedPath = /^\/printer\/objects\/query$/;
  const st = await u1c.probe(p);
  assert.equal(st.online, false);
  assert.ok(st.error);
});

test("a printer that accepts the connection and never answers times out in 3.5s", async t => {
  const { u1, p } = await virtualU1(t);
  u1.server.faults.hangPath = /^\/printer\/objects\/query$/;
  const t0 = Date.now();
  const st = await u1c.probe(p);
  assert.deepEqual(st, { name: "Virtual U1", online: false, error: "timeout" });
  assert.ok(Date.now() - t0 < 5000);
});

test("a printer that drops off the network reads offline, and back online when it returns", async t => {
  const { u1, p } = await virtualU1(t);
  await u1.server.offline();
  const st = await u1c.probe(p);
  assert.equal(st.online, false);
  await u1.server.online();
  assert.equal((await u1c.probe(p)).online, true);
});

test("a command to an unreachable printer fails with a message naming it", async t => {
  const { u1, p } = await virtualU1(t);
  await u1.server.offline();
  await assert.rejects(u1c.pause(p), /Could not reach Virtual U1/);
});
