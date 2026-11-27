// test/printerIdentity.test.js — which printer a file was sliced for, and
// whether it suits the printer it is being sent to.
//
// Every file case below is copied from a real file in a real library
// (config-block values as the slicer wrote them), so the table in
// public/printer-identity.js is held to evidence, not to what a slicer
// "should" write.
const test = require("node:test");
const assert = require("node:assert/strict");
const PI = require("../public/printer-identity.js");

const BRANDS = ["SnapMaker", "FlashForge", "Creality", "Bambu Lab", "Klipper", "Simulator"];
const id = meta => PI.identifyFile(meta, BRANDS);

// ---- files ----

test("a U1 file is a Snapmaker U1, high confidence", () => {
  // U1/Hippocampus (9h48m).gcode — its settings id names only "U1", which is
  // not enough on its own; the compatible-printers list agrees with printer_model.
  const r = id({ printerModel: "Snapmaker U1", printerSettingsId: "PixelPrints U1 (0.4mm)",
    printCompatiblePrinters: '"Snapmaker U1 (0.4 nozzle)"',
    defaultPrintProfile: "0.20 Standard @Snapmaker U1 (0.4 nozzle)" });
  assert.equal(r.family, "snapmaker-u1");
  assert.equal(r.brand, "SnapMaker");
  assert.equal(r.confidence, "high");
});

test("default_print_profile never decides: an AD5X file inheriting an AD5M Pro preset is still an AD5X", () => {
  // AD5X/MatMireMakes/Beardie (5h41m).gcode, verbatim.
  const r = id({ printerModel: "Flashforge AD5X", printerSettingsId: "AD5X (PixelPrints, 0.4)",
    printCompatiblePrinters: '"Flashforge AD5X 0.4 nozzle"',
    defaultPrintProfile: "0.20mm Standard @Flashforge AD5M Pro 0.4 Nozzle" });
  assert.equal(r.family, "flashforge-ad5x");
  assert.equal(r.confidence, "high");
  assert.equal(r.conflict, false);
});

test("Creality Print files are identified by model, not only by brand", () => {
  const i7 = id({ printerModel: "SPARKX i7", printerSettingsId: "SPARKX i7 0.4 nozzle",
    printCompatiblePrinters: '"SPARKX i7 0.4 nozzle"' });
  assert.equal(i7.family, "creality-sparkx-i7");
  assert.equal(i7.confidence, "high");
  // K1C/HollowLog (5h42m).gcode — stored under K1C/, sliced for a V3 Plus.
  const log = id({ printerModel: "Creality Ender-3 V3 Plus", printerSettingsId: "Creality Ender-3 V3 Plus 0.4 nozzle",
    printCompatiblePrinters: '"Creality Ender-3 V3 Plus 0.4 nozzle"' });
  assert.equal(log.family, "creality-ender3-v3-plus");
  assert.equal(log.confidence, "high");
});

test("a generic printer_model falls back to the settings id, and is only 'likely'", () => {
  // 5M PRO/skelly.gcode
  const skelly = id({ printerModel: "Generic Klipper Printer",
    printerSettingsId: "Flashforge Adventurer 5M Pro 0.4 Nozzle benchy",
    printCompatiblePrinters: '"Flashforge Adventurer 5M Pro 0.4 Nozzle"' });
  assert.equal(skelly.family, "flashforge-5m-pro");
  assert.equal(skelly.confidence, "medium");
  assert.equal(skelly.method, "settings_id");
  // K1C/K1C.gcode — a vendor@model preset id, and a user's own "MyKlipper" profile.
  const k1 = id({ printerModel: "Generic Klipper Printer", printerSettingsId: "Creality@K1",
    printCompatiblePrinters: '"MyKlipper 0.4 nozzle"' });
  assert.equal(k1.family, "creality-k1");
  assert.equal(k1.brand, "Creality");
  assert.equal(k1.confidence, "medium");
});

test("a Bambu model code is an identity", () => {
  // Bambu/ams.gcode.3mf
  const r = id({ printerModel: "Bambu Lab P2S", printerModelId: "N7" });
  assert.equal(r.family, "bambu-p2s");
  assert.equal(r.confidence, "high");
  assert.equal(r.method, "bambu_model_id");
});

test("fields that contradict each other never produce a confident answer", () => {
  const r = id({ printerModel: "Snapmaker U1", printCompatiblePrinters: '"Flashforge AD5X 0.4 nozzle"' });
  assert.equal(r.family, "snapmaker-u1");
  assert.equal(r.confidence, "medium");
  assert.equal(r.conflict, true);
});

test("no fields means nothing to detect; unrecognised fields keep the brand-level answer", () => {
  assert.equal(id({}).hasData, false);
  assert.equal(id({}).brand, null);
  // A family SnapCon has no evidence for still gets its brand, as before.
  const r = id({ printerModel: "Creality K2 Plus" });
  assert.equal(r.family, null);
  assert.equal(r.brand, "Creality");
  assert.equal(r.confidence, "low");
  // And a file naming no known brand at all is `false`, not null.
  assert.equal(id({ printerModel: "Voron 2.4" }).brand, false);
});

test("the K1 pattern does not claim a K1C or K1 Max", () => {
  assert.equal(PI.familyOf("Creality K1C 0.4 nozzle"), "creality-k1c", "the K1C is its own family, never the K1");
  assert.equal(PI.familyOf("Creality K1 Max"), null);
  assert.equal(PI.familyOf("Creality@K1"), "creality-k1");
});

test("the Ender-3 V3 KE is its own family, and is not the V3 Plus", () => {
  // A real file ([CP] TinyTREX).
  const id = PI.identifyFile({ printerModel: "Creality Ender-3 V3 KE", printerSettingsId: "PixelPrints - V3 KE (0.4)",
    printCompatiblePrinters: '"Creality Ender-3 V3 KE 0.2 nozzle";"Creality Ender-3 V3 KE 0.4 nozzle"' });
  assert.equal(id.family, "creality-ender3-v3-ke");
  assert.equal(id.confidence, "high");
  assert.equal(PI.familyOf("Creality Ender-3 V3 Plus"), "creality-ender3-v3-plus");
  assert.equal(PI.compare(id, PI.identifyPrinter({ model: "Ender-3 V3 Plus", brand: "Creality" })).status, "model_mismatch");
});

test("folder labels resolve through the same families: K1C and V3 KE", () => {
  assert.deepEqual(PI.familiesLikeName("K1C"), ["creality-k1c"]);
  assert.deepEqual(PI.familiesLikeName("V3 KE"), ["creality-ender3-v3-ke"]);
  assert.deepEqual(PI.familiesLikeName("K1"), ["creality-k1"]);
});

test("the 5M and 5M Pro are told apart", () => {
  assert.equal(PI.familyOf("Flashforge Adventurer 5M Pro 0.4 Nozzle"), "flashforge-5m-pro");
  assert.equal(PI.familyOf("Flashforge Adventurer 5M 0.4 Nozzle"), "flashforge-5m");
});

// ---- printers ----

test("printers are identified from their connector, a detected model, or a reported model", () => {
  assert.equal(PI.identifyPrinter({ connectorFamily: "snapmaker-u1", brand: "SnapMaker" }).key, "snapmaker-u1");
  assert.equal(PI.identifyPrinter({ model: "Ender-3 V3 Plus", brand: "Creality" }).key, "creality-ender3-v3-plus");
  assert.equal(PI.identifyPrinter({ model: "SPARKX i7", brand: "Creality" }).key, "creality-sparkx-i7");
  assert.equal(PI.identifyPrinter({ capabilitiesModel: "Bambu Lab P2S", brand: "Bambu Lab" }).key, "bambu-p2s");
  // The Adventurer connector drives both a 5M and a 5M Pro and cannot tell
  // which: brand only, never a guess.
  const ff = PI.identifyPrinter({ brand: "FlashForge" });
  assert.equal(ff.key, null);
  assert.equal(ff.brand, "FlashForge");
});

// ---- comparison ----

const V3PLUS = PI.identifyPrinter({ model: "Ender-3 V3 Plus", brand: "Creality" });
const I7 = PI.identifyPrinter({ model: "SPARKX i7", brand: "Creality" });
const U1 = PI.identifyPrinter({ connectorFamily: "snapmaker-u1", brand: "SnapMaker" });
const FF5M = PI.identifyPrinter({ brand: "FlashForge" });
const HOLLOWLOG = id({ printerModel: "Creality Ender-3 V3 Plus", printerSettingsId: "Creality Ender-3 V3 Plus 0.4 nozzle" });

test("same brand, different model is a confident model mismatch", () => {
  // The case brand-level checks passed: a V3 Plus file offered to a SPARKX i7.
  assert.deepEqual({ ...PI.compare(HOLLOWLOG, I7) }, { status: "model_mismatch", confident: true });
  assert.equal(PI.compare(HOLLOWLOG, V3PLUS).status, "match");
});

test("a different brand is still a brand mismatch", () => {
  assert.equal(PI.compare(HOLLOWLOG, U1).status, "brand_mismatch");
});

test("a 'likely' identity is a mismatch, but not a confident one", () => {
  const k1 = id({ printerModel: "Generic Klipper Printer", printerSettingsId: "Creality@K1" });
  assert.deepEqual({ ...PI.compare(k1, V3PLUS) }, { status: "model_mismatch", confident: false });
});

test("a printer whose model is unknown is never called a mismatch on model", () => {
  const skelly = id({ printerModel: "Generic Klipper Printer", printerSettingsId: "Flashforge Adventurer 5M Pro 0.4 Nozzle benchy" });
  assert.equal(PI.compare(skelly, FF5M).status, "unknown");
});

test("a user-typed brand is never a mismatch", () => {
  const voron = { key: null, brand: "Voron" };
  const known = b => BRANDS.includes(b);
  assert.equal(PI.compare(HOLLOWLOG, voron, known).status, "unknown");
});
