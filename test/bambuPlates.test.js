// test/bambuPlates.test.js — a multi-plate Bambu project prints the plate that
// was chosen, fed by that plate's filaments (M7.1).
//
// Before: the Send dialog offered a plate picker and mapped the chosen plate's
// filaments, but the connector always sent Metadata/plate_1.gcode — plate 3
// chosen, plate 1 printed. The plate now travels from the request to
// project_file, a plate the file does not hold is refused before anything is
// sent, and a printer that cannot choose a plate is never sent one but 1.
//
// The project is built here: no multi-plate sliced Bambu file was at hand.
// Its plate G-code headers and slice_info are in the shape of a real P2S
// project (Bambu/ams.gcode.3mf). Server functions are taken
// from server.js and run against the real threemf reader and parser.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const threemf = require("../threemf");
const { parseGcodeMap } = require("../parser");
const { buildZip } = require("./helpers/fakeFtpsServer");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const fnSrc = (name, kind = "async function ") => { const at = serverSrc.indexOf(kind + name + "("); assert.ok(at > 0, name); return serverSrc.slice(at, serverSrc.indexOf("\n}", at) + 2); };

// Four project filaments. Plate 1 uses 1 and 2; plate 2 is not sliced; plate 3
// uses 2 and 4.
const gcode = used => ["; HEADER_BLOCK_START", "; filament_type = PLA;PETG;PLA;PETG", "; filament_colour = #FF0000;#00FF00;#0000FF;#FFFFFF",
  "; filament used [g] = " + used.join(","), "; printer_model = Bambu Lab P2S", "; HEADER_BLOCK_END", "G1 X0 Y0"].join("\n");
const plateXml = (i, fil) => `  <plate>\n    <metadata key="index" value="${i}"/>\n    <metadata key="printer_model_id" value="N7"/>\n` +
  fil.map(([id, tray, type]) => `    <filament id="${id}" tray_info_idx="${tray}" type="${type}" color="#000000" used_g="10"/>`).join("\n") + "\n  </plate>";
const SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${plateXml(1, [[1, "GFA00", "PLA"], [2, "GFG00", "PETG"]])}\n${plateXml(3, [[2, "GFG00", "PETG"], [4, "GFG01", "PETG"]])}\n</config>`;
function project({ bambu = true } = {}) {
  const f = path.join(os.tmpdir(), "snapcon-plates-" + process.pid + "-" + Math.random().toString(16).slice(2) + ".3mf");
  fs.writeFileSync(f, buildZip([
    { name: "Metadata/project_settings.config", data: Buffer.from(JSON.stringify({ printer_model: bambu ? "Bambu Lab P2S" : "Flashforge AD5X", printer_settings_id: "x" })), deflate: true },
    { name: "Metadata/slice_info.config", data: Buffer.from(SLICE_INFO), deflate: true },
    { name: "Metadata/plate_1.gcode", data: Buffer.from(gcode([5, 6, 0, 0])), deflate: true },
    { name: "Metadata/plate_3.gcode", data: Buffer.from(gcode([0, 7, 0, 8])), deflate: true },
  ]));
  return f;
}

function server(caps) {
  const env = { netfs: { threemfRead: async fp => threemf.read(fp) }, getCapabilities: c => caps[c] || {} };
  vm.createContext(env);
  vm.runInContext(fnSrc("resolvePrintPlate"), env);
  vm.runInContext(fnSrc("plateTrayInfo", "function "), env);
  vm.runInContext(fnSrc("platePalette", "function "), env);
  return env;
}
const BAMBU = { name: "P2S", connector: "bambu-lab" }, OTHER = { name: "AD5X", connector: "flashforge-ad5x" };
const CAPS = { "bambu-lab": { plateSelect: true } };

test("the file says which plates are sliced, and which filaments each plate uses", () => {
  const info = threemf.read(project());
  assert.deepEqual(info.plates, [1, 3]);
  assert.deepEqual(info.plateFilaments[1].map(f => f.id), [1, 2]);
  assert.deepEqual(info.plateFilaments[3].map(f => f.id), [2, 4]);
});

test("the plate's colours, by the project's filament number: what the Send dialog maps", () => {
  const f = project();
  const pal = parseGcodeMap(threemf.plateGcode(f, 3), { scanBody: false }).palette;
  assert.deepEqual(pal.filter(x => x.used).map(x => x.i), [1, 3], "plate 3 uses project filaments 2 and 4 (palette 1 and 3)");
  const env = server(CAPS);
  assert.deepEqual([...env.plateTrayInfo(threemf.read(f), 3)], [null, "GFG00", null, "GFG01"], "tray hints line up with the palette");
  assert.deepEqual([...env.plateTrayInfo(threemf.read(f), 1)], ["GFA00", "GFG00"]);
});

test("only the plate's own filaments need a tray: the plate block, not the header, says which", () => {
  // A real Bambu plate G-code names every project filament and no per-filament
  // use (the owner's ams.gcode.3mf: "total filament weight", no "filament used").
  const env = server(CAPS), f = project();
  const all = [0, 1, 2, 3].map(i => ({ i, used: true }));
  assert.deepEqual(env.platePalette(all, threemf.read(f), 3).filter(s => s.used).map(s => s.i), [1, 3]);
  assert.deepEqual(env.platePalette(all, threemf.read(f), 1).filter(s => s.used).map(s => s.i), [0, 1]);
  assert.deepEqual(env.platePalette(all, { plateFilaments: {} }, 1), all, "no plate block: as parsed");
});

test("the plate asked for is the plate started; absent, the first sliced one — what /api/map shows", async () => {
  const env = server(CAPS), f = project();
  assert.equal((await env.resolvePrintPlate(BAMBU, f, 3)).plate, 3);
  assert.equal((await env.resolvePrintPlate(BAMBU, f, "3")).plate, 3);
  assert.equal((await env.resolvePrintPlate(BAMBU, f, undefined)).plate, 1);
  assert.match(serverSrc, /const plate = Math\.max\(1, parseInt\(req\.query\.plate, 10\) \|\| info\.plates\[0\] \|\| 1\);/, "/api/map's own default is the first sliced plate");
});

test("a plate the file does not hold, or that is not sliced, is refused before anything is sent", async () => {
  const env = server(CAPS), f = project();
  for (const bad of [2, 9, 0, "abc", 1.5]) assert.equal((await env.resolvePrintPlate(BAMBU, f, bad)).code, "no_such_plate", String(bad));
});

test("a printer that cannot choose a plate is never sent another one", async () => {
  const env = server(CAPS), f = project();
  assert.equal((await env.resolvePrintPlate(OTHER, f, 3)).code, "plate_unsupported");
  assert.equal((await env.resolvePrintPlate(OTHER, f, 1)).plate, 1);
});

test("files without plates have none: plain G-code, a non-Bambu 3MF", async () => {
  const env = server(CAPS);
  assert.equal((await env.resolvePrintPlate(BAMBU, "x.gcode", 3)).plate, null);
  assert.equal((await env.resolvePrintPlate(OTHER, project({ bambu: false }), 3)).plate, null);
});

test("the plate travels from the request to the connector, on the direct, staged and deferred paths", () => {
  const route = serverSrc.slice(serverSrc.indexOf('app.post("/api/print"'));
  const body = route.slice(0, route.indexOf("\napp."));
  assert.ok(body.indexOf("resolvePrintPlate(p, ref.fp, plateAsked)") < body.indexOf("libraryPrintIdentity("), "the Variant is the plate that prints");
  assert.match(body, /c\.applyHeadMapping\(p, tools, map, prefs, \{ file: name, plate \}\)/);
  assert.match(body, /c\.startPrintFile\(p, name, \{ plate, prefs \}\)/);
  assert.match(body, /acceptDeferredSend\(p, \{[^}]*\bplate, actor: actorFromReq\(req\)/, "a deferred send keeps its plate");
  const job = fnSrc("runPrintFileJob");
  assert.match(job, /c\.applyHeadMapping\(p, tools, map, prefs, \{ file: filename, plate \}\)/);
  assert.match(job, /c\.startPrintFile\(p, filename, \{ plate, prefs \}\)/);
  // The deferred send (§37 P3) sends only the file; its plate waits for the Print (§38).
  assert.doesNotMatch(fnSrc("runDeferredSend"), /applyHeadMapping/);
  // The browser: a card's own Print passes the plate its colours were mapped for.
  assert.match(appSrc, /if\(plate==null&&MAP&&MAP\.plate\) plate=MAP\.plate;/);
});

// M8 security review: a filament id in slice_info indexed an array on the main
// thread — id="4294967295" made /api/map build a 4-billion-slot array (minutes
// of a frozen server, then out of memory). Ids are bounded where they are read
// and where they index.
test("a crafted filament id cannot make /api/map build a huge array", () => {
  const huge = SLICE_INFO.replace('<filament id="4" tray_info_idx="GFG01"', '<filament id="4294967295" tray_info_idx="GFG01"').replace('<filament id="2" tray_info_idx="GFG00" type="PETG"', '<filament id="20000000" tray_info_idx="GFG00" type="PETG"');
  const f = path.join(os.tmpdir(), "snapcon-plates-huge-" + process.pid + ".3mf");
  fs.writeFileSync(f, buildZip([
    { name: "Metadata/project_settings.config", data: Buffer.from(JSON.stringify({ printer_model: "Bambu Lab P2S" })), deflate: true },
    { name: "Metadata/slice_info.config", data: Buffer.from(huge), deflate: true },
    { name: "Metadata/plate_3.gcode", data: Buffer.from(gcode([0, 7, 0, 8])), deflate: true },
  ]));
  const info = threemf.read(f);
  assert.ok(info.plateFilaments[3].every(x => x.id >= 1 && x.id <= 64), "out-of-range ids are dropped where they are read");
  const env = server(CAPS);
  const t0 = Date.now();
  // Even handed ids that bypassed the reader, the route's array stays small.
  const out = env.plateTrayInfo({ filaments: [], plateFilaments: { 3: [{ id: 4294967295, trayInfoIdx: "x" }, { id: 2, trayInfoIdx: "GFG00" }] } }, 3);
  assert.ok(out.length <= 64 && Date.now() - t0 < 100);
  assert.deepEqual([...out], [null, "GFG00"]);
});
