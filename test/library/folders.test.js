// test/library/folders.test.js — folder classification (§6.4), on the shape
// of a real library, and the rule that a folder never decides a
// file's printer.
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyFolders } = require("../../library/folders");
const PrinterIdentity = require("../../public/printer-identity");

const REAL = [
  ["gcode", "5M PRO"], ["gcode", "AD5X"], ["gcode", "AD5X/Cinderwin3D"], ["gcode", "AD5X/MatMireMakes"], ["gcode", "I7"],
  ["gcode", "K1C"], ["gcode", "U1"], ["gcode", "U1/Cinderwin 3D"], ["gcode", "U1/Mat Mires Makes"], ["gcode", "V3 Plus"],
  ["u1", "MatMire Makes"], ["u1", "PrintVerse"], ["u1", "U1"], ["u1", "Upload"],
  ["v3", "PrintVerse"], ["v3", "Big Crystals"], ["v3", "Big Crystals/200"], ["v3", "STLs"], ["v3", "Others"],
].map(([root_id, rel_path]) => ({ root_id, rel_path }));

const byPath = rows => Object.fromEntries(rows.map(r => [r.root_id + ":" + r.rel_path, r]));

test("printer-like folders come from the resolver's own family names", () => {
  const c = byPath(classifyFolders(REAL));
  for (const p of ["gcode:5M PRO", "gcode:AD5X", "gcode:I7", "gcode:U1", "gcode:V3 Plus", "u1:U1"]) assert.equal(c[p].class, "printer_family_like", p);
  assert.deepEqual(c["gcode:5M PRO"].evidence[0].families, ["flashforge-5m-pro"]);
  assert.deepEqual(c["gcode:V3 Plus"].evidence[0].families, ["creality-ender3-v3-plus"]);
  assert.equal(c["gcode:K1C"].class, "printer_family_like", "through the resolver's K1C family, not a folder-only list");
  assert.deepEqual(c["gcode:K1C"].evidence[0].families, ["creality-k1c"]);
  assert.equal(c["gcode:AD5X"].evidence[0].strength, "none", "never Evidence for a file's printer");
});

test("a folder name that recurs under other parents is a designer; one-offs stay unknown", () => {
  const c = byPath(classifyFolders(REAL));
  assert.equal(c["gcode:AD5X/Cinderwin3D"].class, "designer", "same as U1/Cinderwin 3D, ignoring spaces");
  assert.equal(c["gcode:U1/Cinderwin 3D"].class, "designer");
  assert.equal(c["gcode:AD5X/MatMireMakes"].class, "designer", "same as u1:MatMire Makes");
  assert.equal(c["u1:PrintVerse"].class, "designer", "recurs in another location");
  assert.deepEqual(c["u1:PrintVerse"].evidence[0].also_at, ["v3:PrintVerse"]);
  assert.equal(c["gcode:U1/Mat Mires Makes"].class, "unknown", "a near-miss spelling is M4's candidate discovery, not a match here");
  assert.equal(c["v3:Big Crystals/200"].class, "unknown");
  assert.equal(c["v3:Others"].class, "unknown");
});

test("format folders", () => {
  const c = byPath(classifyFolders(REAL));
  assert.equal(c["v3:STLs"].class, "format");
  for (const n of ["Supported", "pre-supported", "Images", "3MF", "Print Files"]) {
    assert.equal(classifyFolders([{ root_id: "r", rel_path: n }])[0].class, "format", n);
  }
});

test("familiesLikeName: a run of a label's model words with a letter and a digit, nothing looser", () => {
  const f = PrinterIdentity.familiesLikeName;
  assert.deepEqual(f("U1"), ["snapmaker-u1"]);
  assert.deepEqual(f("V3Plus"), ["creality-ender3-v3-plus"]);
  assert.deepEqual(f("5M").sort(), ["flashforge-5m", "flashforge-5m-pro"]);
  for (const n of ["3", "200", "Plus", "Pro", "KE", "Cinderwin 3D", ""]) assert.deepEqual(f(n), [], n);
});
