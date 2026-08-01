// test/connectors/snapmaker-u1-klipper.test.js — regression coverage for
// applyHeadMapping's prefs-fallback behavior: "when sending to print, always
// use the printer's own Auto-Level/Flow Calibration/Time-Lapse defaults
// unless the job explicitly overrides them" (server.js's /api/print,
// /api/printfile, and uploadNotifiedFile all call applyHeadMapping with
// `prefs` possibly fully omitted — e.g. the plain fleet-card Upload/Print
// buttons and printQueuedFile send no prefs at all — relying entirely on
// this fallback to still apply the printer's configured defaults).
const test = require("node:test");
const assert = require("node:assert/strict");
const conn = require("../../connectors/snapmaker-u1-klipper");

function withMockFetch(handler, fn) {
  const realFetch = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = realFetch; });
}

function scriptOf(url) {
  return decodeURIComponent(new URL(url).searchParams.get("script"));
}

test("applyHeadMapping: no prefs sent at all — falls back entirely to the printer's own configured defaults", async () => {
  const calls = [];
  await withMockFetch(
    async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "" }; },
    () => conn.applyHeadMapping({ url: "http://127.0.0.1:1", autoLevel: true, flowCalibrate: true, timelapse: false }, [], {})
  );
  assert.equal(calls.length, 1);
  assert.equal(scriptOf(calls[0]), "SET_PRINT_PREFERENCES BED_LEVEL=1 FLOW_CALIBRATE=1 TIME_LAPSE_CAMERA=0");
});

test("applyHeadMapping: printer defaults all off, no prefs sent — sends all-off, never fabricates an 'on'", async () => {
  const calls = [];
  await withMockFetch(
    async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "" }; },
    () => conn.applyHeadMapping({ url: "http://127.0.0.1:1" }, [], {})
  );
  assert.equal(scriptOf(calls[0]), "SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=0 TIME_LAPSE_CAMERA=0");
});

test("applyHeadMapping: an explicit per-job pref overrides the printer's default in both directions", async () => {
  const calls = [];
  await withMockFetch(
    async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "" }; },
    () => conn.applyHeadMapping(
      { url: "http://127.0.0.1:1", autoLevel: true, flowCalibrate: false },
      [], {},
      { autoLevel: false, flowCalibrate: true }
    )
  );
  assert.equal(scriptOf(calls[0]), "SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=1 TIME_LAPSE_CAMERA=0");
});

test("applyHeadMapping: mixed — some fields explicit, others fall back to the printer default independently", async () => {
  const calls = [];
  await withMockFetch(
    async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "" }; },
    () => conn.applyHeadMapping(
      { url: "http://127.0.0.1:1", autoLevel: true, flowCalibrate: true, timelapse: true },
      [], {},
      { timelapse: false } // only timelapse is overridden; autoLevel/flowCalibrate must fall back
    )
  );
  assert.equal(scriptOf(calls[0]), "SET_PRINT_PREFERENCES BED_LEVEL=1 FLOW_CALIBRATE=1 TIME_LAPSE_CAMERA=0");
});

// ---- FLOW_CALIBRATE_EXTRUDERS (confirmed against the real Snapmaker/
// u1-klipper source, klippy/extras/print_task_config.py's cmd_SET_PRINT_
// PREFERENCES: FLOW_CALIBRATE_EXTRUDERS is a comma-separated list of the
// physical extruder indices (0-3) to restrict flow_calib_extruders to) ----
test("applyHeadMapping: flowCalibrateExtruders appends FLOW_CALIBRATE_EXTRUDERS when flow calibration is on", async () => {
  const calls = [];
  await withMockFetch(
    async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "" }; },
    () => conn.applyHeadMapping(
      { url: "http://127.0.0.1:1" }, [], {},
      { flowCalibrate: true, flowCalibrateExtruders: [0, 2] }
    )
  );
  assert.equal(scriptOf(calls[0]), "SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=1 TIME_LAPSE_CAMERA=0 FLOW_CALIBRATE_EXTRUDERS='0,2'");
});

test("applyHeadMapping: flowCalibrateExtruders is omitted when flow calibration is off, even if a list was sent", async () => {
  const calls = [];
  await withMockFetch(
    async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "" }; },
    () => conn.applyHeadMapping(
      { url: "http://127.0.0.1:1" }, [], {},
      { flowCalibrate: false, flowCalibrateExtruders: [0, 2] }
    )
  );
  assert.equal(scriptOf(calls[0]), "SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=0 TIME_LAPSE_CAMERA=0");
});

test("applyHeadMapping: an empty flowCalibrateExtruders list is omitted (leaves the firmware's own all-extruders default alone)", async () => {
  const calls = [];
  await withMockFetch(
    async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "" }; },
    () => conn.applyHeadMapping(
      { url: "http://127.0.0.1:1" }, [], {},
      { flowCalibrate: true, flowCalibrateExtruders: [] }
    )
  );
  assert.equal(scriptOf(calls[0]), "SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=1 TIME_LAPSE_CAMERA=0");
});

test("applyHeadMapping: flowCalibrateExtruders sanitizes out-of-range/duplicate/non-numeric values", async () => {
  const calls = [];
  await withMockFetch(
    async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "" }; },
    () => conn.applyHeadMapping(
      { url: "http://127.0.0.1:1" }, [], {},
      { flowCalibrate: true, flowCalibrateExtruders: [1, 1, 99, -1, "3", "bogus"] }
    )
  );
  assert.equal(scriptOf(calls[0]), "SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=1 TIME_LAPSE_CAMERA=0 FLOW_CALIBRATE_EXTRUDERS='1,3'");
});
