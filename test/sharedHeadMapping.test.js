// test/sharedHeadMapping.test.js — several colors of a file may print from the
// same toolhead.
//
// Sending a print with, say, filament 1 → head 1, 2 → 3, 3 → 2 and 4 → head 1
// again was refused: "Two colors are mapped to the same head". Sharing a head
// is a normal choice (two of the file's colors printed with the same
// filament), and every connector sends one assignment per color, so the
// refusal is gone. /api/printfile never had it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("node:http");
const path = require("path");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("/api/print no longer refuses colors that share a head", () => {
  assert.doesNotMatch(serverSrc, /mapped to the same/);
  const route = serverSrc.slice(serverSrc.indexOf('app.post("/api/print"'), serverSrc.indexOf("\n});", serverSrc.indexOf('app.post("/api/print"')));
  assert.doesNotMatch(route, /new Set\(heads\)\.size/);
  assert.match(route, /tools = Object\.keys\(map\)\.map\(Number\)\.sort\(\(a, b\) => a - b\);/, "the mapping still reaches the connector");
});

test("the U1 sends one assignment per color, two of them to the same head, and lists that head once", async t => {
  const scripts = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      if (u.pathname === "/printer/gcode/script") {
        scripts.push(u.searchParams.get("script") || (body && JSON.parse(body).script) || "");
      }
      res.setHeader("content-type", "application/json"); res.end('{"result":"ok"}');
    });
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const u1 = require("../connectors/snapmaker-u1-klipper");
  // Filament 1 → head 1, 2 → head 3, 3 → head 2, 4 → head 1 again (0-based below).
  await u1.applyHeadMapping({ url: `http://127.0.0.1:${srv.address().port}`, name: "U1" }, [0, 1, 2, 3], { 0: 0, 1: 2, 2: 1, 3: 0 }, {});
  const lines = scripts.join("\n").split("\n");
  assert.deepEqual(lines.filter(l => l.startsWith("SET_PRINT_EXTRUDER_MAP")), [
    "SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=0 MAP_EXTRUDER=0",
    "SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=1 MAP_EXTRUDER=2",
    "SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=2 MAP_EXTRUDER=1",
    "SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=3 MAP_EXTRUDER=0",
  ]);
  assert.ok(lines.includes("SET_PRINT_USED_EXTRUDERS EXTRUDERS=0,2,1"), lines.join(" | "));
});
