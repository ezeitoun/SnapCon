// test/threemf.test.js — reading a .3mf, which is a zip with a slicer's
// project inside it.
//
// The whole point is that the extension tells you nothing: two files the user
// exported from Bambu Studio on the same day, both named .3mf, were a sliced
// plate (printable) and an unsliced project (not). Whether a file can be
// printed is decided by what is inside it — Metadata/plate_N.gcode — and which
// printer it is for comes from project_settings.config, which every vendor's
// .3mf carries (checked against real files from Bambu Lab, Creality, Snapmaker,
// Anycubic and FlashForge).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const threemf = require("../threemf");
const { buildZip } = require("./helpers/fakeFtpsServer");

const PLATE_GCODE = [
  "; HEADER_BLOCK_START",
  "; total layer number: 94",
  "; filament_type = PETG;PETG",
  "; filament_colour = #000000;#FFFFFF",
  "; filament used [g] = 23.77,24.59",
  "; printer_model = Bambu Lab P2S",
  "; HEADER_BLOCK_END",
  "G1 X0 Y0"
].join("\n");

const SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value="N7"/>
    <metadata key="nozzle_diameters" value="0.4"/>
    <metadata key="prediction" value="9778"/>
    <metadata key="weight" value="48.36"/>
    <filament id="1" tray_info_idx="GFG00" type="PETG" color="#000000" used_g="23.77"/>
    <filament id="2" tray_info_idx="GFG00" type="PETG" color="#FFFFFF" used_g="24.59"/>
  </plate>
</config>`;

const settings = (model, id) => Buffer.from(JSON.stringify({ printer_model: model, printer_settings_id: id }));

function write(entries) {
  const f = path.join(os.tmpdir(), "snapcon-3mf-" + process.pid + "-" + Math.random().toString(16).slice(2) + ".3mf");
  fs.writeFileSync(f, buildZip(entries));
  return f;
}
const slicedBambu = (extra = []) => write([
  { name: "Metadata/project_settings.config", data: settings("Bambu Lab P2S", "Bambu Lab P2S 0.4 nozzle"), deflate: true },
  { name: "Metadata/slice_info.config", data: Buffer.from(SLICE_INFO), deflate: true },
  { name: "Metadata/plate_1.gcode", data: Buffer.from(PLATE_GCODE), deflate: true },
  { name: "Metadata/plate_1.png", data: Buffer.from("PNG-BYTES-PLATE-1"), deflate: false },
  ...extra
]);

test("a sliced Bambu project is recognised as printable", () => {
  const info = threemf.read(slicedBambu());
  assert.equal(info.isBambu, true);
  assert.equal(info.sliced, true);
  assert.deepEqual(info.plates, [1]);
});

test("an unsliced project is a Bambu file but not a printable one", () => {
  // Exactly the first test.3mf the user exported: the model and settings are
  // there, the sliced gcode is not. Offering it to a printer would fail at the
  // machine with nothing explaining why.
  const f = write([
    { name: "Metadata/project_settings.config", data: settings("Bambu Lab P2S", "Bambu Lab P2S 0.4 nozzle"), deflate: true },
    { name: "3D/3dmodel.model", data: Buffer.from("<model/>"), deflate: true }
  ]);
  const info = threemf.read(f);
  assert.equal(info.isBambu, true);
  assert.equal(info.sliced, false);
  assert.deepEqual(info.plates, []);
});

test("another vendor's .3mf is left alone", () => {
  // The library already accepts .3mf for FlashForge's AD5X. Bambu handling must
  // not change what those files do.
  for (const [model, id] of [["Flashforge AD5X", "Flashforge AD5X 0.4 nozzle"],
                             ["Creality Ender-3 V3 KE", "Creality Ender-3 V3 KE 0.4 nozzle"],
                             ["Snapmaker U1", "Snapmaker U1 (0.4 nozzle)"]]) {
    const f = write([{ name: "Metadata/project_settings.config", data: settings(model, id), deflate: true }]);
    assert.equal(threemf.read(f).isBambu, false, model + " must not be treated as a Bambu file");
  }
});

test("a file with no project settings at all is not claimed as Bambu", () => {
  const f = write([{ name: "3D/3dmodel.model", data: Buffer.from("<model/>"), deflate: true }]);
  assert.equal(threemf.read(f).isBambu, false);
});

test("the sliced gcode can be read back out for the existing parser", () => {
  // The colours SnapCon shows come from the same gcode header every other
  // printer's file has — it is simply inside the zip here, so nothing about
  // colour parsing needs a Bambu-specific path.
  const text = threemf.plateGcode(slicedBambu(), 1);
  assert.match(text, /filament_colour = #000000;#FFFFFF/);
  assert.match(text, /total layer number: 94/);
});

test("the plate's picture is the thumbnail", () => {
  const png = threemf.plateThumbnail(slicedBambu(), 1);
  assert.equal(png.toString(), "PNG-BYTES-PLATE-1");
});

test("a file with several plates lists them all", () => {
  const f = slicedBambu([
    { name: "Metadata/plate_2.gcode", data: Buffer.from(PLATE_GCODE), deflate: true },
    { name: "Metadata/plate_3.gcode", data: Buffer.from(PLATE_GCODE), deflate: true }
  ]);
  assert.deepEqual(threemf.read(f).plates, [1, 2, 3], "the Send dialog asks which one to print");
});

test("what the file was sliced for is reported for the pre-send checks", () => {
  const info = threemf.read(slicedBambu());
  assert.equal(info.printerModelId, "N7");
  assert.equal(info.nozzle, 0.4);
  assert.deepEqual(info.filaments.map(f => [f.type, f.color]), [["PETG", "#000000"], ["PETG", "#FFFFFF"]]);
});

test("a file that is not a zip is reported, not thrown at the caller", () => {
  const f = path.join(os.tmpdir(), "snapcon-not-a-zip-" + process.pid + ".3mf");
  fs.writeFileSync(f, Buffer.from("this is not a zip at all"));
  const info = threemf.read(f);
  assert.equal(info.isBambu, false);
  assert.equal(info.sliced, false);
  assert.ok(info.error, "the library still has to render a row for it");
  fs.unlinkSync(f);
});

test("a stored (uncompressed) entry reads back too", () => {
  // Slicers write both; a reader that only handled deflate would work until
  // someone's file did not.
  const f = write([
    { name: "Metadata/project_settings.config", data: settings("Bambu Lab P2S", "x"), deflate: false },
    { name: "Metadata/plate_1.gcode", data: Buffer.from(PLATE_GCODE), deflate: false }
  ]);
  assert.equal(threemf.read(f).sliced, true);
  assert.match(threemf.plateGcode(f, 1), /total layer number: 94/);
});

test("reading is capped so a huge entry cannot be inflated into memory", () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 65);
  const f = write([
    { name: "Metadata/project_settings.config", data: settings("Bambu Lab P2S", "x"), deflate: true },
    { name: "Metadata/plate_1.gcode", data: big, deflate: true }
  ]);
  assert.throws(() => threemf.plateGcode(f, 1, { maxBytes: 1024 * 1024 }), /too large/i);
});
