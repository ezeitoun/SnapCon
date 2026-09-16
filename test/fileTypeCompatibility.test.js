// test/fileTypeCompatibility.test.js — a file must not be sent to a printer
// that cannot print it.
//
// SnapCon's library holds gcode and .3mf side by side. A Bambu Lab printer
// starts a sliced .3mf and nothing else: plain gcode is non-functional on it.
// Every other printer here is the reverse. Nothing stopped either mistake —
// the file was uploaded, the print was started, and the failure surfaced at the
// machine (or, worse, as a print that never began with no clear reason).
//
// A connector says what it accepts with capabilities.fileTypes. ABSENT means
// today's whole set, so no existing connector changes behaviour.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function extract(name) {
  const start = serverSrc.indexOf("function " + name + "(");
  assert.ok(start > 0, name + " must exist in server.js");
  return serverSrc.slice(start, serverSrc.indexOf("\n}", start) + 2);
}
const sandbox = {};
vm.createContext(sandbox);
// The function reads the legacy extension list from a module-level constant,
// so that comes into the sandbox with it.
const defaults = serverSrc.slice(serverSrc.indexOf("const DEFAULT_FILE_TYPES ="));
vm.runInContext(defaults.slice(0, defaults.indexOf("\n") + 1), sandbox);
vm.runInContext(extract("fileTypeRefusal"), sandbox);
const refusal = (caps, name, printerName) => vm.runInContext("fileTypeRefusal", sandbox)(caps, name, printerName);

test("a Bambu printer refuses plain gcode, and says what it needs instead", () => {
  const why = refusal({ fileTypes: ["3mf"] }, "benchy.gcode", "Macky's P2S");
  assert.ok(why, "this must not reach the printer");
  assert.match(why, /Macky's P2S/);
  assert.match(why, /\.3mf/, "say what it does take");
});

test("a Bambu printer accepts a .3mf", () => {
  assert.equal(refusal({ fileTypes: ["3mf"] }, "ams.gcode.3mf", "P2S"), null);
  assert.equal(refusal({ fileTypes: ["3mf"] }, "plate.3MF", "P2S"), null, "case does not matter");
});

test("a connector that declares nothing keeps accepting everything it used to", () => {
  // Every existing connector: gcode, gco, g, gx and .3mf (FlashForge's AD5X
  // format). This is the check that this guard changes nothing for them.
  for (const f of ["a.gcode", "a.gco", "a.g", "a.gx", "a.3mf"]) {
    assert.equal(refusal({}, f, "U1"), null, f + " must still be accepted");
    assert.equal(refusal(undefined, f, "U1"), null);
  }
});

test("a file with no extension at all is refused rather than guessed at", () => {
  assert.ok(refusal({ fileTypes: ["3mf"] }, "somefile", "P2S"));
});

for (const [route, marker] of [
  ["/api/print", 'app.post("/api/print"'],
  ["/api/printfile", 'app.post("/api/printfile"'],
  ["/api/notify-load", 'app.post("/api/notify-load"']
]) {
  test(`${route} refuses a file the printer cannot print`, () => {
    const at = serverSrc.indexOf(marker);
    assert.ok(at > 0, route + " must exist");
    const body = serverSrc.slice(at, serverSrc.indexOf("\n});", at));
    assert.match(body, /fileTypeRefusal/, "every route that puts a file on a printer checks first");
  });
}

test("the refusal names the printer, so a bulk send says which one failed", () => {
  const why = refusal({ fileTypes: ["3mf"] }, "x.gcode", "Shelf B");
  assert.match(why, /Shelf B/);
});
