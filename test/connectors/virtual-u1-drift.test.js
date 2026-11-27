// test/connectors/virtual-u1-drift.test.js — keeps the virtual U1 honest.
//
// 1. Drift: for every firmware version captured, the simulator must report
//    the same objects and fields, with compatible types, as the real printer
//    did — idle and mid-print. A new capture after a firmware update
//    (scripts/capture-u1.js) makes this fail where the simulator fell behind.
// 2. Coverage: every object SnapCon's U1 probe asks for exists on the real
//    printer, in every captured version.
// 3. Cleanliness: the captures are committed to a public repository, so none
//    may carry a real serial, MAC, IP, device name or job name.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { VirtualU1, availableFirmware } = require("../../fixtures/virtual-u1");
const { loadCapture } = require("../../fixtures/virtual-u1/model");
const { shapeOf, diffShapes, formatDiff } = require("../../fixtures/virtual-u1/shape");
const { OBJECTS } = require("../../connectors/snapmaker-u1-klipper-ws")._internal;

const CAPTURES = path.join(__dirname, "..", "..", "fixtures", "virtual-u1", "captures");

// A simulated printer in the state the capture shows.
function simulatedLike(firmware, label) {
  const u = new VirtualU1({ firmware });
  if (label === "printing") {
    u.addFile("Drift.gcode", { tools: [0, 1], layers: 5, secondsPerLayer: 60 });
    u.runScript('SDCARD_PRINT_FILE FILENAME="Drift.gcode"');
    u.advance(120);
  }
  return u.status();
}

for (const fw of availableFirmware()) {
  for (const label of ["idle", "printing"]) {
    const file = path.join(CAPTURES, fw, label + ".json");
    if (!fs.existsSync(file)) continue;
    test(`firmware ${fw}, ${label}: the simulator reports what the real U1 reported`, () => {
      const real = shapeOf(loadCapture(fw, label).status);
      const sim = shapeOf(simulatedLike(fw, label));
      const d = diffShapes(real, sim);
      // Objects and fields the simulator adds would be invented data; ones it
      // drops are data SnapCon could read on a real printer but not here.
      assert.deepEqual(d, { addedObjects: [], removedObjects: [], addedFields: [], removedFields: [], changedTypes: [] }, "\n" + formatDiff(d));
    });
  }

  test(`firmware ${fw}: every object the U1 probe asks for exists on the real printer`, () => {
    const objects = new Set(loadCapture(fw, "idle").objectsList);
    for (const name of Object.keys(OBJECTS)) assert.ok(objects.has(name), name);
  });
}

test("the committed captures carry nothing that identifies a real printer, owner or job", () => {
  for (const fw of availableFirmware()) {
    for (const f of fs.readdirSync(path.join(CAPTURES, fw))) {
      const text = fs.readFileSync(path.join(CAPTURES, fw, f), "utf8");
      const where = `${fw}/${f}`;
      assert.doesNotMatch(text, /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/, where + ": a private IP address");
      const macs = text.match(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi) || [];
      for (const mac of macs) assert.match(mac, /^02:00:00:00:00:0\d$/, where + ": a real MAC address");
      const c = JSON.parse(text);
      const pi = c.systemInfo.system_info.product_info;
      assert.equal(pi.serial_number, "VIRTUALU1000000000000", where);
      assert.equal(pi.device_name, "Virtual U1", where);
      assert.ok(["", "Virtual print.gcode"].includes(c.status.print_stats.filename), where + ": a real job name");
      for (const o of (c.status.exclude_object || {}).objects || []) assert.match(o.name, /^OBJECT_\d+_ID_\d+_COPY_0$/, where);
      for (const info of (c.status.filament_detect || {}).info || []) {
        if (Array.isArray(info.CARD_UID)) assert.ok(info.CARD_UID.every(n => n === 0), where + ": an RFID card UID");
      }
    }
  }
});
