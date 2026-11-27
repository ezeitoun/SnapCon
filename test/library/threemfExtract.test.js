// test/library/threemfExtract.test.js — the M3 zip reader and 3MF extraction
// on fixtures: normal zip, zip64, unicode names, data descriptors, malformed
// archives, missing metadata, a very large model entry, multi-plate, sliced
// .gcode.3mf and an unsliced project. "What the file says" only: nothing here
// infers a relationship.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { openZipAsync } = require("../../library/zipReader");
const { extract3mf, wantedEntries, detectFlavour } = require("../../library/threemfExtract");
const { buildZip, build3mf, PNG } = require("./helpers/zip");

// Reads a zip held in memory the way the scanner does: directory, then only
// the wanted entries; counts the bytes.
async function extractBuffer(buf) {
  let bytes = 0;
  const readAt = async (pos, len) => { bytes += len; return buf.subarray(pos, pos + len); };
  const zip = await openZipAsync(readAt, buf.length);
  const directory = [...zip.entries.values()].filter(e => !e.dir).map(e => ({ name: e.name, rawSize: e.rawSize, compSize: e.compSize, method: e.method, crc: e.crc }));
  const raw = {};
  for (const w of wantedEntries(directory)) raw[w.name] = await zip.readRaw(w.name, w);
  return { x: extract3mf({ directory, raw, zip64: zip.zip64 }), bytes, size: buf.length };
}

const MAKERWORLD = {
  Title: "Keyrambit - roblox rivals (karambit model)", Designer: "TR10_", License: "BY-NC-SA", Origin: "original",
  DesignModelId: "USec11953facc500", DesignProfileId: "808246553", DesignRegion: "US", DesignerUserId: "1827583527",
  ProfileTitle: "With PLA supports and PETG model sharper", ProfileUserName: "TR10_", ProfileUserId: "1827583527",
};

test("a sliced Bambu .gcode.3mf: MakerWorld metadata, profile, a printable plate with its printer id, MD5 and filaments", async () => {
  const buf = build3mf({ metadata: MAKERWORLD, objects: [], plates: [{ no: 1, sliced: true, printerModelId: "N7", sliceObjects: ["Keyrambit rivals main.stl"],
    filaments: [{ type: "PETG", color: "#000000", usedG: 23.77 }, { type: "PETG", color: "#FFFFFF", usedG: 24.59 }], prediction: 9778, weight: 48.36 }] });
  const { x } = await extractBuffer(buf);
  assert.equal(x.flavour.flavour, "bambu");
  assert.equal(x.flavour.method, "application_version_form");
  assert.equal(x.producer, "BambuStudio"); assert.equal(x.producerVersion, "02.06.00.51");
  for (const [k, v] of Object.entries({ title: MAKERWORLD.Title, designer: "TR10_", license: "BY-NC-SA", designModelId: "USec11953facc500",
    designProfileId: "808246553", profileTitle: MAKERWORLD.ProfileTitle, profileUserName: "TR10_" })) assert.equal(x.project[k], v, k);
  assert.equal(x.profile.printer_model, "Bambu Lab P2S");
  assert.equal(x.slicedCount, 1);
  const p = x.plates[0];
  assert.equal(p.sliced, true);
  assert.match(p.gcodeMd5, /^[0-9a-f]{32}$/);
  assert.equal(p.slice.printerModelId, "N7");
  assert.equal(p.slice.prediction, 9778);
  assert.deepEqual(p.slice.filaments.map(f => [f.type, f.color, f.usedG]), [["PETG", "#000000", 23.77], ["PETG", "#FFFFFF", 24.59]]);
  assert.deepEqual(p.slicedObjects, ["Keyrambit rivals main.stl"]);
  assert.equal(p.thumbnail.entry, "Metadata/plate_1.png", "the full plate picture first");
});

test("a plate's picture is the largest the file holds: the full plate picture, else the small one", async () => {
  // Owner, 2026-11-27: the Library kept the small plate picture (128 px in
  // Bambu-family slicers) although the file also holds the full one (512 px),
  // so larger pictures on a Model's page looked soft.
  const plates = [{ no: 1, sliced: true, printerModelId: "N7" }];
  const entriesOf = buf => extractBuffer(buf).then(r => r.x.plates[0].thumbnail);
  const dirOf = names => names.map(name => ({ name, rawSize: 1000, compSize: 1000, method: 0, crc: 0 }));
  const wanted = dir => wantedEntries(dir).map(w => w.name).filter(n => /plate_1.*\.png$/.test(n));

  assert.equal((await entriesOf(build3mf({ plates }))).entry, "Metadata/plate_1.png");
  // Only one of the two is read from the file, never both.
  assert.deepEqual(wanted(dirOf(["Metadata/plate_1.png", "Metadata/plate_1_small.png", "Metadata/plate_1.gcode"])), ["Metadata/plate_1.png"]);
  // Only the small one is there.
  assert.deepEqual(wanted(dirOf(["Metadata/plate_1_small.png", "Metadata/plate_1.gcode"])), ["Metadata/plate_1_small.png"]);
  // The full one is over the size limit for a picture: the small one is taken.
  const big = dirOf(["Metadata/plate_1.png", "Metadata/plate_1_small.png", "Metadata/plate_1.gcode"]);
  big[0].rawSize = 3 * 1024 * 1024;
  assert.deepEqual(wanted(big), ["Metadata/plate_1_small.png"]);
});

test("an unsliced project: plates, objects and source references, and nothing printable", async () => {
  const { x } = await extractBuffer(build3mf({ application: "BambuStudio-2.3.5",
    settings: { printer_model: "Snapmaker U1", printer_settings_id: "PixelPrints U1 (0.4mm)", version: "2.3.5" },
    objects: [{ id: "9", name: "Assembly", parts: [{ name: "Full Beard Version Standard.OBJ", sourceFile: "C:\\Temp\\santa-painted.3mf" }] }],
    plates: [{ no: 1, objects: ["9"] }, { no: 2, objects: ["9"] }] }));
  assert.equal(x.flavour.flavour, "snapmaker_orca");
  assert.equal(x.flavour.method, "bambu_name_three_part_version+snapmaker_printer");
  assert.equal(x.slicedCount, 0);
  assert.deepEqual(x.plates.map(p => [p.plate_no, p.sliced, p.objects]), [[1, false, ["Assembly"]], [2, false, ["Assembly"]]]);
  assert.deepEqual(x.sourceFiles, ["C:\\Temp\\santa-painted.3mf"], "recorded as written, path and all");
  assert.deepEqual(x.meshNames, ["Full Beard Version Standard.OBJ"]);
  assert.equal(x.project.title, null, "empty metadata stays null");
});

test("multi-plate: each plate by itself, only the sliced ones printable", async () => {
  const { x } = await extractBuffer(build3mf({ objects: [{ id: "1", name: "A.stl", parts: [] }, { id: "2", name: "B.stl", parts: [] }],
    plates: [{ no: 1, objects: ["1"] }, { no: 2, objects: ["2"], sliced: true, printerModelId: "N7" }, { no: 3, name: "Spares", objects: ["1", "2"] }] }));
  assert.deepEqual(x.plates.map(p => [p.plate_no, p.name, p.sliced, p.objects]), [[1, null, false, ["A.stl"]], [2, null, true, ["B.stl"]], [3, "Spares", false, ["A.stl", "B.stl"]]]);
  assert.equal(x.slicedCount, 1);
});

test("missing metadata: no settings, no model settings, no slice info — the file says little, so little is recorded", async () => {
  const buf = buildZip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "3D/3dmodel.model", data: "<model><resources/></model>" }]);
  const { x } = await extractBuffer(buf);
  assert.equal(x.flavour.flavour, "other");
  assert.equal(x.flavour.method, "no_application");
  assert.equal(x.profile, null);
  assert.equal(x.identity, null, "no printer identity at all, rather than a guess");
  assert.deepEqual(x.plates, []);
  assert.equal(x.thumbnail, null);
});

test("a very large model entry: only its head is read, the metadata still found, the mesh never", async () => {
  const buf = build3mf({ metadata: { Title: "Big One" }, modelExtraBytes: 6 * 1024 * 1024 });
  const { x, bytes, size } = await extractBuffer(buf);
  assert.equal(x.project.title, "Big One");
  assert.ok(x.problems.some(p => /only its head/.test(p.note || "")));
  assert.ok(bytes < size / 4, `read ${bytes} of ${size}`);
});

test("zip64 with every 32-bit field saturated, unicode-path names and UTF-8 names", async () => {
  const buf = build3mf({ zip64: true, metadata: { Title: "Zip64 Dragon" },
    aux: [{ name: "Auxiliaries/Model Pictures/Bild-U.png", data: PNG, unicodeName: "Auxiliaries/Model Pictures/Bild-Ü.png" },
      { name: "Auxiliaries/Model Pictures/写真.png", data: PNG, utf8: true }] });
  const { x } = await extractBuffer(buf);
  assert.equal(x.zip64, true);
  assert.equal(x.project.title, "Zip64 Dragon");
  assert.deepEqual(x.auxiliaries.map(a => a.name).sort(), ["Bild-Ü.png", "写真.png"]);
  assert.ok(x.auxiliaries.every(a => a.picture && a.picture.mime === "image/png"));
  // and the M0 fixture written to independently-verified layout
  const m0 = path.join(__dirname, "..", "library-spike", "fixtures", "fixture-zip64-extras.3mf");
  const fx = await extractBuffer(fs.readFileSync(m0));
  assert.equal(fx.x.project.title, "Zip64 Dragon");
  assert.deepEqual(fx.x.sourceFiles, ["Dragon_Body.stl"]);
  assert.deepEqual(fx.x.auxiliaries.map(a => a.name), ["Bild-Ü.webp"]);
});

test("entries written with data descriptors (local sizes zero) read correctly", async () => {
  const buf = buildZip([{ name: "3D/3dmodel.model", data: '<model><metadata name="Application">OrcaSlicer-2.2.0</metadata></model>', dataDescriptor: true },
    { name: "Metadata/project_settings.config", data: JSON.stringify({ printer_model: "Snapmaker U1" }), dataDescriptor: true }]);
  const { x } = await extractBuffer(buf);
  assert.equal(x.flavour.flavour, "orca");
  assert.equal(x.profile.printer_model, "Snapmaker U1");
});

test("flavours from the producer the file names, with the method kept", () => {
  const f = (app, pm) => detectFlavour({ application: app, settings: pm ? { printer_model: pm } : null, names: new Set() });
  assert.equal(f("CrealityPrint-6.0.1").flavour, "creality");
  assert.equal(f("PrusaSlicer-2.8.0").flavour, "prusa");
  assert.equal(f("BambuStudio-2.3.1", "Bambu Lab X1").flavour, "other", "a three-part Bambu name without a Snapmaker printer is not guessed");
  assert.equal(f("BambuStudio-2.3.1", "Bambu Lab X1").method, "bambu_name_unknown_fork");
});

test("a damaged metadata entry is a problem recorded, not a failed file", async () => {
  const buf = build3mf({ extra: [], omit: ["Metadata/project_settings.config"] });
  const withBad = buildZip([{ name: "3D/3dmodel.model", data: '<model><metadata name="Application">BambuStudio-02.06.00.51</metadata></model>' },
    { name: "Metadata/project_settings.config", data: "{ not json" }]);
  const { x } = await extractBuffer(withBad);
  assert.equal(x.profile, null);
  assert.ok(x.problems.some(p => p.entry === "Metadata/project_settings.config" && /not JSON/.test(p.error)));
  assert.ok((await extractBuffer(buf)).x.profile === null);
});

