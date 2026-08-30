// test/connectors/flashforge-ad5x-moonraker.test.js — the AD5X's 4-slot IFS
// (material station) as read over Moonraker on ZMOD firmware.
//
// Fixtures mirror what a real ZMOD AD5X returned: slots 1 and 2 physically
// loaded, 3 and 4 empty, but ALL FOUR carrying a stored colour. That asymmetry
// is the point — ffmColorN persists after a spool is pulled, so presence must
// gate colour and not the reverse. Rendering a spool for a slot that has none
// is exactly what SnapCon's empty-toolhead rule forbids.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const mode = require("../../connectors/flashforge-mode");
const fm = require("../../connectors/flashforge-moonraker");
const ad5x = require("../../connectors/flashforge-ad5x");

// Observed on the real printer.
const FFM_INFO = {
  ffmEnable: true, channel: 2,
  ffmColor0: "", ffmColor1: "#8000FF", ffmColor2: "#FFEB3B", ffmColor3: "#FFFFFF", ffmColor4: "#FFFF00",
  ffmType0: "?", ffmType1: "PLA", ffmType2: "PLA", ffmType3: "PLA", ffmType4: "PLA"
};

function zmodPrinter(opts = {}) {
  // `native` is off by default: a printer running ZMOD has :8898 CLOSED. It is
  // switched on only to prove the native-pinned path still reaches it.
  const { portSensors = [true, true, false, false], ifsVars = { tools: [2, 1, 3, 4], current_tool: -1 }, ffmInfo = FFM_INFO, native = false } = opts;
  const seen = { queries: [], gcode: [], all: [] };
  const json = (res, b) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.all.push(req.method + " " + u.pathname);
    if (req.method === "POST" && (u.pathname === "/detail" || u.pathname === "/printGcode")) {
      if (!native) { res.statusCode = 404; return res.end(); }
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ code: 0, detail: { status: "ready" } }));
    }
    if (u.pathname === "/printer/info") return json(res, { result: { state: "ready" } });
    if (u.pathname === "/server/webcams/list") return json(res, { result: { webcams: [] } });
    if (u.pathname === "/server/files/config/Adventurer5M.json") return json(res, { FFMInfo: ffmInfo });
    if (u.pathname === "/printer/gcode/script") { seen.gcode.push(u.searchParams.get("script")); return json(res, { result: "ok" }); }
    if (u.pathname === "/printer/objects/list") {
      return json(res, { result: { objects: [
        "print_stats", "virtual_sdcard", "heater_bed", "extruder", "toolhead", "exclude_object",
        "gcode_macro _IFS_VARS",
        "zmod_ifs_switch_sensor _ifs_port_sensor_1", "zmod_ifs_switch_sensor _ifs_port_sensor_2",
        "zmod_ifs_switch_sensor _ifs_port_sensor_3", "zmod_ifs_switch_sensor _ifs_port_sensor_4"
      ] } });
    }
    if (u.pathname === "/printer/objects/query") {
      seen.queries.push(u.search);
      const status = {
        print_stats: { state: "standby", filename: "", info: {} }, display_status: { progress: 0 },
        virtual_sdcard: { progress: 0 }, heater_bed: { temperature: 20, target: 0 },
        extruder: { temperature: 21, target: 0 }, fan: {}, gcode_move: { speed_factor: 1 },
        toolhead: { extruder: "extruder" }, exclude_object: { objects: [] }
      };
      portSensors.forEach((v, i) => { status[`zmod_ifs_switch_sensor _ifs_port_sensor_${i + 1}`] = { filament_detected: v, enabled: true }; });
      status["gcode_macro _IFS_VARS"] = ifsVars;
      return json(res, { result: { eventtime: 1, status } });
    }
    res.statusCode = 404; res.end();
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () =>
    r({ url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() })));
}

const P = s => ({ id: "prt_ad5x", name: "AD5X", url: s.url });

test.beforeEach(() => { mode._resetAll(); fm._resetCaches(); });

test("loaded slots carry their stored colour and material", async () => {
  const s = await zmodPrinter();
  try {
    const r = await ad5x.probe(P(s));
    assert.equal(r.heads.length, 4);
    assert.deepEqual(r.heads[0], { loaded: true, hex: "#8000FF", material: "PLA", sub: null, official: false });
    assert.deepEqual(r.heads[1], { loaded: true, hex: "#FFEB3B", material: "PLA", sub: null, official: false });
  } finally { s.close(); }
});

test("an empty slot never carries a colour, even though one is stored for it", async () => {
  // ffmColor3/ffmColor4 are set on the real printer while those ports read
  // filament_detected:false. A spool graphic there would be a lie.
  const s = await zmodPrinter();
  try {
    const r = await ad5x.probe(P(s));
    assert.deepEqual(r.heads[2], { loaded: false, hex: null, material: null, sub: null, official: false });
    assert.deepEqual(r.heads[3], { loaded: false, hex: null, material: null, sub: null, official: false });
  } finally { s.close(); }
});

test("slot sensors are queried under the zmod_ifs_switch_sensor prefix", async () => {
  // The same objects appear in objects/list under filament_switch_sensor too,
  // but only this prefix returns data — the intuitive name yields zero slots.
  const s = await zmodPrinter();
  try {
    await ad5x.probe(P(s));
    const q = decodeURIComponent(s.seen.queries.join("&"));
    assert.ok(q.includes("zmod_ifs_switch_sensor _ifs_port_sensor_1"), "must use the zmod_ prefix");
    assert.ok(!/[?&]filament_switch_sensor _ifs_port_sensor/.test(q), "the bare prefix returns nothing");
  } finally { s.close(); }
});

test("the IFS query rides along on the status query rather than costing a second round trip", async () => {
  const s = await zmodPrinter();
  try {
    await ad5x.probe(P(s));
    assert.equal(s.seen.queries.length, 1, "one objects/query per poll");
  } finally { s.close(); }
});

test("activeExt stays null until the tool→slot mapping is verified on hardware", async () => {
  // _IFS_VARS.current_tool is a TOOL index and tools[] maps tool->slot, so the
  // active slot is tools[current_tool]-1, not current_tool. Unverified against
  // a real multi-colour print, so it ships as null rather than as a guess.
  const s = await zmodPrinter({ ifsVars: { tools: [2, 1, 3, 4], current_tool: 0 } });
  try {
    assert.equal((await ad5x.probe(P(s))).activeExt, null);
  } finally { s.close(); }
});

test("a printer reporting no stored colours still reports slot presence", async () => {
  const s = await zmodPrinter({ ffmInfo: null });
  try {
    const r = await ad5x.probe(P(s));
    assert.equal(r.heads[0].loaded, true);
    assert.equal(r.heads[0].hex, null, "absent colour is null, never a substituted default");
  } finally { s.close(); }
});

// ---- multi-colour start: implemented but inert ----

test("applyHeadMapping assigns each tool to its slot and stores no pending mapping", async () => {
  const s = await zmodPrinter();
  try {
    const p = P(s);
    await ad5x.probe(p);
    await ad5x.applyHeadMapping(p, [0, 1], { 0: 1, 1: 0 });
    const sent = s.seen.gcode.join("\n");
    assert.match(sent, /_IFS_COLORS_ASSIGN TOOL=0 PORT=2/);
    assert.match(sent, /_IFS_COLORS_ASSIGN TOOL=1 PORT=1/);
  } finally { s.close(); }
});

test("applyHeadMapping rejects a non-integer or out-of-range tool or slot", async () => {
  const s = await zmodPrinter();
  try {
    const p = P(s);
    await ad5x.probe(p);
    await assert.rejects(() => ad5x.applyHeadMapping(p, ["x"], { x: 0 }));
    await assert.rejects(() => ad5x.applyHeadMapping(p, [0], { 0: 99 }));
    await assert.rejects(() => ad5x.applyHeadMapping(p, [99], { 99: 0 }));
  } finally { s.close(); }
});

test("start-print refuses rather than guessing which macro is safe unattended", async () => {
  // ZMOD overrides SDCARD_PRINT_FILE and _IFS_COLORS_PRINT calls
  // BASE_SDCARD_PRINT_FILE, implying the override opens a touchscreen dialog.
  // Discovering that at runtime would mean a hung overnight queue job.
  const s = await zmodPrinter();
  try {
    const p = P(s);
    await ad5x.probe(p);
    const before = s.seen.gcode.length;
    await assert.rejects(() => ad5x.startPrintFile(p, "cube.gcode"), /not (yet )?(verified|supported)/i);
    assert.equal(s.seen.gcode.length, before, "must not send a speculative macro");
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// Transport routing must come from the normal mode-resolution path, not from
// "is a profile cached". A profile only exists after a successful probe, so
// keying on it meant an explicitly pinned printer took the WRONG branch until
// its first poll landed.
// ---------------------------------------------------------------------------

test("a printer pinned to moonraker hits the hardware gate even before its first probe", async () => {
  const s = await zmodPrinter();
  try {
    // No probe() first, so nothing is cached — only the explicit pin.
    const p = { ...P(s), transport: "moonraker" };
    await assert.rejects(() => ad5x.startPrintFile(p, "cube.gcode"), /not yet verified/i);
    assert.ok(!s.seen.all.some(x => x.includes("/printGcode")), "must not fall through to the native API");
    assert.equal(s.seen.gcode.length, 0, "must emit no print-start macro");
  } finally { s.close(); }
});

test("applyHeadMapping on a pinned, unprobed printer takes the Moonraker path", async () => {
  const s = await zmodPrinter();
  try {
    const p = { ...P(s), transport: "moonraker" };
    await ad5x.applyHeadMapping(p, [0], { 0: 1 });
    assert.match(s.seen.gcode.join("\n"), /_IFS_COLORS_ASSIGN TOOL=0 PORT=2/);
    assert.ok(!s.seen.all.some(x => x.includes("/printGcode")), "must not touch the native API");
  } finally { s.close(); }
});

test("a printer pinned to native still uses the native print path", async () => {
  const s = await zmodPrinter({ native: true });
  try {
    const p = { ...P(s), transport: "native" };
    await ad5x.startPrintFile(p, "cube.gcode").catch(() => {});
    assert.ok(s.seen.all.some(x => x.includes("/printGcode")), "native pin must reach the native API");
    assert.equal(s.seen.gcode.length, 0, "and must emit no Moonraker macro");
  } finally { s.close(); }
});

test("auto-detected Moonraker still hits the gate, unchanged", async () => {
  const s = await zmodPrinter();
  try {
    const p = P(s);
    await ad5x.probe(p);                       // auto-detects moonraker
    await assert.rejects(() => ad5x.startPrintFile(p, "cube.gcode"), /not yet verified/i);
    assert.equal(s.seen.gcode.length, 0);
  } finally { s.close(); }
});

test("no Moonraker print-start macro is emitted on any routing path", async () => {
  const s = await zmodPrinter();
  try {
    for (const t of [undefined, "moonraker", "native"]) {
      const p = { ...P(s), ...(t ? { transport: t } : {}) };
      await ad5x.startPrintFile(p, "cube.gcode").catch(() => {});
    }
    const g = s.seen.gcode.join("\n");
    assert.ok(!/SDCARD_PRINT_FILE|BASE_SDCARD_PRINT_FILE|_IFS_COLORS_PRINT/.test(g), "emitted: " + g);
  } finally { s.close(); }
});
