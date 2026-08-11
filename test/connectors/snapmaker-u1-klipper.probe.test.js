// test/connectors/snapmaker-u1-klipper.probe.test.js — characterizes the
// EXISTING (HTTP-polling) U1 connector's probe() normalization exactly as it
// behaves today, before connectors/snapmaker-u1-klipper-ws.js's own
// normalizeU1State() is written. Its output must match this file's
// expectations byte-for-byte given the same raw Moonraker `status` shape —
// that's what proves the two connectors agree.
const test = require("node:test");
const assert = require("node:assert/strict");
const conn = require("../../connectors/snapmaker-u1-klipper");

function withMockFetch(handler, fn) {
  const realFetch = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = realFetch; });
}

// Wraps a raw Moonraker `status` dict exactly as printer.objects.query
// returns it: { result: { status: {...} } }.
function mockQueryResponse(status) {
  return async () => ({ ok: true, status: 200, json: async () => ({ result: { status } }) });
}

const PRINTER = { name: "Test U1", url: "http://127.0.0.1:1" };

test("probe(): full printing state — heads, hotend selection, plate, layer, speed, fan all map correctly", async () => {
  const status = {
    print_task_config: {
      filament_exist: [true, false, true, true],
      filament_color_rgba: ["FF0000FF", null, "00FF00FF", "0000FFFF"],
      filament_type: ["PLA", null, "PETG", "ABS"],
      filament_sub_type: ["NONE", null, "SILK", "NONE"],
      filament_official: [true, false, false, true]
    },
    print_stats: { state: "printing", filename: "test_print.gcode", print_duration: 3661.5, filament_used: 1234.56, info: { current_layer: 42, total_layer: 100 } },
    display_status: { progress: 0.1 },
    virtual_sdcard: { progress: 0.4235 },
    heater_bed: { temperature: 59.8, target: 60 },
    extruder: { temperature: 25.1, target: 0 },
    extruder1: { temperature: 24.9, target: 0 },
    extruder2: { temperature: 219.7, target: 220 },
    extruder3: { temperature: 23.0, target: 0 },
    toolhead: { extruder: "extruder2" },
    fan: { speed: 0.75 },
    gcode_move: { speed_factor: 1.1 },
    exclude_object: { objects: [{ name: "obj1" }, { name: "obj2" }], excluded_objects: ["obj1"], current_object: "obj2" }
  };
  const result = await withMockFetch(mockQueryResponse(status), () => conn.probe(PRINTER));
  assert.deepEqual(result, {
    name: "Test U1", online: true,
    state: "printing", message: "", errorCode: "",
    filename: "test_print.gcode",
    progress: 0.4235, // virtual_sdcard wins over display_status
    elapsed: 3661.5,
    filamentUsed: 1234.56,
    bed: { temp: 60, target: 60 },
    hotend: { temp: 220, target: 220 }, // extruder2 is the one within 5deg of a >80 target
    layer: { current: 42, total: 100 },
    speed: 110,
    fanPct: 75,
    activeExt: 2,
    plate: { total: 2, excluded: 1, current: "obj2" },
    heads: [
      { loaded: true, hex: "#FF0000", material: "PLA", sub: null, official: true },
      { loaded: false, hex: null, material: null, sub: null, official: false },
      { loaded: true, hex: "#00FF00", material: "PETG", sub: "SILK", official: false },
      { loaded: true, hex: "#0000FF", material: "ABS", sub: null, official: true }
    ]
  });
});

test("probe(): idle/minimal state — every optional field absent falls back to null/0/empty consistently", async () => {
  const status = { print_stats: { state: "standby" } };
  const result = await withMockFetch(mockQueryResponse(status), () => conn.probe(PRINTER));
  assert.deepEqual(result, {
    name: "Test U1", online: true,
    state: "standby", message: "", errorCode: "",
    filename: "",
    progress: 0,
    elapsed: null,
    filamentUsed: null,
    bed: null,
    hotend: null,
    layer: null,
    speed: null,
    fanPct: null,
    activeExt: null,
    plate: null,
    heads: [
      { loaded: false, hex: null, material: null, sub: null, official: false },
      { loaded: false, hex: null, material: null, sub: null, official: false },
      { loaded: false, hex: null, material: null, sub: null, official: false },
      { loaded: false, hex: null, material: null, sub: null, official: false }
    ]
  });
});

// hotend selection is `target > 80 && (temperature - target) <= 5`: an
// extruder well below its target still qualifies (still heating up counts as
// "this print's toolhead"), but one *overshooting* its target by more than
// 5deg is excluded (sensor glitch / not this print's toolhead) — asymmetric
// on purpose, not a +/-5deg window.
test("probe(): hotend excludes an extruder overshooting its target by more than 5deg", async () => {
  const status = {
    print_stats: { state: "printing" },
    extruder: { temperature: 226, target: 220 }, // overshoot by 6 — excluded
    extruder1: { temperature: 25, target: 0 } // target not >80 at all — never a candidate
  };
  const result = await withMockFetch(mockQueryResponse(status), () => conn.probe(PRINTER));
  assert.equal(result.hotend, null);
});

test("probe(): hotend still reports an extruder well below its target (mid heat-up)", async () => {
  const status = {
    print_stats: { state: "printing" },
    extruder: { temperature: 100, target: 220 } // 120deg below target — still qualifies
  };
  const result = await withMockFetch(mockQueryResponse(status), () => conn.probe(PRINTER));
  assert.deepEqual(result.hotend, { temp: 100, target: 220 });
});

test("probe(): structured print_stats.exception decodes to a padded errorCode + message", async () => {
  const status = {
    print_stats: { state: "error", exception: { level: 2, id: 5, index: 0, code: 17, message: "Extruder overheat" } }
  };
  const result = await withMockFetch(mockQueryResponse(status), () => conn.probe(PRINTER));
  assert.equal(result.errorCode, "0002-0005-0000-0017");
  assert.equal(result.message, "Extruder overheat");
});

test("probe(): print_stats.message as JSON {coded,msg} decodes to errorCode + message", async () => {
  const status = {
    print_stats: { state: "error", message: JSON.stringify({ coded: "1 - 2 - 3", msg: "Something broke" }) }
  };
  const result = await withMockFetch(mockQueryResponse(status), () => conn.probe(PRINTER));
  assert.equal(result.errorCode, "0001-0002-0003");
  assert.equal(result.message, "Something broke");
});

test("probe(): print_stats.message that isn't JSON is used as the raw error message, no errorCode", async () => {
  const status = { print_stats: { state: "error", message: "Plain text error, not JSON" } };
  const result = await withMockFetch(mockQueryResponse(status), () => conn.probe(PRINTER));
  assert.equal(result.errorCode, "");
  assert.equal(result.message, "Plain text error, not JSON");
});

test("probe(): non-OK HTTP response reports offline with the status code, no throw", async () => {
  const result = await withMockFetch(
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    () => conn.probe(PRINTER)
  );
  assert.deepEqual(result, { name: "Test U1", online: false, error: "HTTP 500" });
});

test("probe(): a fetch abort/timeout reports online:false with error 'timeout'", async () => {
  const result = await withMockFetch(
    async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; },
    () => conn.probe(PRINTER)
  );
  assert.deepEqual(result, { name: "Test U1", online: false, error: "timeout" });
});

test("probe(): a generic network failure reports online:false with the raw error message", async () => {
  const result = await withMockFetch(
    async () => { throw new Error("ECONNREFUSED"); },
    () => conn.probe(PRINTER)
  );
  assert.deepEqual(result, { name: "Test U1", online: false, error: "ECONNREFUSED" });
});
