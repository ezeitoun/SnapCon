// test/threemfRoutes.test.js — the server's two file-reading routes must
// understand a Bambu .3mf, and must leave every other .3mf exactly as it was.
//
// Before this, /api/map read a .3mf as UTF-8 text: the zip bytes produced no
// colours, no weights and no printer, with no error anywhere — the Job card
// simply showed "no colours found". Since the filament mapping is built from
// that palette, and the Bambu connector refuses to start a print without a
// mapping, this was the thing standing between "the printer is connected" and
// "the printer can print".
//
// Source-text for the routes (server.js has no exports and starts a listener,
// the constraint test-connection-credentials.test.js documents) plus real
// behaviour for the parsing itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const threemf = require("../threemf");
const { parseGcodeMap } = require("../parser");
const { buildZip } = require("./helpers/fakeFtpsServer");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// A plate's gcode carries the ordinary Orca/Bambu header comments — the same
// ones parser.js already reads out of a plain .gcode file.
const PLATE = [
  "; total layer number: 94",
  "; filament_type = PETG;PETG",
  "; filament_colour = #000000;#FFFFFF",
  "; filament used [g] = 23.77,24.59",
  "; printer_model = Bambu Lab P2S",
  "; printer_settings_id = Bambu Lab P2S 0.4 nozzle",
  "M140 S70"
].join("\n");

function bambuFile() {
  const f = path.join(os.tmpdir(), "snapcon-route-3mf-" + process.pid + "-" + Math.random().toString(16).slice(2) + ".3mf");
  fs.writeFileSync(f, buildZip([
    { name: "Metadata/project_settings.config", data: Buffer.from(JSON.stringify({ printer_model: "Bambu Lab P2S" })), deflate: true },
    { name: "Metadata/plate_1.gcode", data: Buffer.from(PLATE), deflate: true },
    { name: "Metadata/plate_1.png", data: Buffer.from("\x89PNG-the-plate"), deflate: false }
  ]));
  return f;
}

test("the colours of a Bambu .3mf come from the same parser as every other file", () => {
  // Not a second, Bambu-shaped colour parser: the plate's gcode is lifted out
  // of the zip and handed to parseGcodeMap unchanged.
  const f = bambuFile();
  const result = parseGcodeMap(threemf.plateGcode(f, 1), { scanBody: false });
  assert.equal(result.noColors, false);
  assert.deepEqual(result.palette.filter(s => s.present).map(s => s.hex), ["#000000", "#FFFFFF"]);
  assert.equal(result.palette[0].type, "PETG");
  assert.equal(result.printerModel, "Bambu Lab P2S");
  fs.unlinkSync(f);
});

test("reading a .3mf as plain text — the old behaviour — finds nothing at all", () => {
  // Kept as the record of what the bug looked like: the zip's bytes parse
  // cleanly as "a file with no colours", which is why it failed silently.
  const f = bambuFile();
  const asText = parseGcodeMap(fs.readFileSync(f, "utf8"), { scanBody: false });
  assert.equal(asText.noColors, true, "this is what the Job card was showing");
  fs.unlinkSync(f);
});

test("/api/map reads a Bambu .3mf through threemf, not as text", () => {
  const route = serverSrc.slice(serverSrc.indexOf('app.get("/api/map"'), serverSrc.indexOf('app.get("/api/local-thumbnail"'));
  assert.match(route, /threemf/);
  assert.match(route, /isBambu/, "only a Bambu .3mf takes this path");
  assert.match(route, /plateGcode/);
  assert.match(route, /parseGcodeMap/, "the same parser still produces the result");
});

test("/api/local-thumbnail serves the plate picture out of a Bambu .3mf", () => {
  const route = serverSrc.slice(serverSrc.indexOf('app.get("/api/local-thumbnail"'), serverSrc.indexOf("const JOBS = new Map()"));
  assert.match(route, /plateThumbnail/);
  assert.match(route, /isBambu/);
});

test("another vendor's .3mf still takes the original path", () => {
  // FlashForge's AD5X uses .3mf too. Its files must behave exactly as before —
  // this beta is not the place to change what they do.
  const f = path.join(os.tmpdir(), "snapcon-ad5x-" + process.pid + ".3mf");
  fs.writeFileSync(f, buildZip([
    { name: "Metadata/project_settings.config", data: Buffer.from(JSON.stringify({ printer_model: "Flashforge AD5X" })), deflate: true }
  ]));
  assert.equal(threemf.read(f).isBambu, false);
  fs.unlinkSync(f);
});

test("the file list says which files are 3MF and whether they are printable", () => {
  // The library badge and the "Not sliced" warning are drawn from this.
  const route = serverSrc.slice(serverSrc.indexOf('app.get("/api/files"'), serverSrc.indexOf('app.get("/api/check-folder"'));
  assert.match(route, /threemf/);
  assert.match(route, /sliced/);
});

test("threemf.js is copied into the Docker image", () => {
  // test/docker.test.js walks server.js's requires; this is the explicit check
  // that the new top-level module was not forgotten.
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /COPY .*threemf\.js/);
});
