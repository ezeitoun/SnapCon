// test/connectors/crealityAutoLevel.test.js — SnapCon must not run G29 ahead of
// a Creality print (docs/TODO.md item 9d).
//
// G29 itself is fine, and is verified working on K1/K1 Max/KE/V3 Plus. What is
// not fine is running it as a PRE-PRINT step, because the printer's own
// print-start flow re-homes Z afterwards and invalidates the mesh and Z
// reference G29 just established:
//
//   non-CFS: START_PRINT's `prepare == 0` branch runs CANCEL_HOMEZ_NACCU, G28,
//            the material load, NOZ_CLEAR, NEXT_HOMEZ_NACCU and G28 Z -- two Z
//            re-homes after G29.
//   CFS:     SnapCon's own 9e preparation runs G28 and later G28 Z, also after
//            applyHeadMapping has already run G29.
//
// Confirmed live: a SnapCon-started print with auto-level ON gave bad Z, and
// with auto-level OFF gave a good first layer, with START_PRINT establishing a
// tight reference of its own (bst_z=0.017, spread ~0.015mm).
//
// So ownership sits with the printer: the file's own START_PRINT flow owns the
// Z reference for the print, and SnapCon must not inject G29 ahead of it. The
// U1 is deliberately NOT affected -- its autoLevel sends
// SET_PRINT_PREFERENCES BED_LEVEL=1, a firmware PREFERENCE the printer acts on
// at the right moment, which is a different mechanism entirely.
//
// Reordering G29 to after the preparation was considered and rejected: it would
// only help CFS machines, would leave every non-CFS Creality still re-homed by
// START_PRINT, and would mean probing with a hot freshly-loaded nozzle plus a
// heater cool/reheat cycle that has never been tested.
const test = require("node:test");
const assert = require("node:assert/strict");

const creality = require("../../connectors/creality-klipper");
const u1 = require("../../connectors/snapmaker-u1-klipper");
const idx = require("../../connectors/index.js");

const P = { id: "i7", name: "SPARKX i7", url: "http://127.0.0.1:1" };

// Records every gcode script sent, and answers objects/query well enough for
// the CFS preparation path to run.
function recorder({ box = {} } = {}) {
  const scripts = [];
  const state = {
    box: { ...box },
    prepare: 0,
    print_stats: { state: "standby", filename: "" },
    virtual_sdcard: { is_active: false, file_position: 0, file_path: "" },
    toolhead: { homed_axes: "" }
  };
  const impl = async (url) => {
    const u = String(url);
    if (u.includes("/printer/gcode/script")) {
      const s = decodeURIComponent(u.split("script=")[1] || "");
      scripts.push(s);
      if (s.startsWith("PRINT_PREPARING")) state.prepare = 2;
      if (s.startsWith("PRINT_PREPARED")) state.prepare = 1;
      if (/^(G28|CANCEL_HOMEZ_NACCU)\b/.test(s)) state.toolhead.homed_axes = "xyz";
      if (s.startsWith("PRINT_PREPARE_LOAD_MATERIAL")) state.virtual_sdcard.file_path = "f.gcode";
      if (s.startsWith("SDCARD_PRINT_FILE")) {
        state.virtual_sdcard.is_active = true;
        state.print_stats = { state: "printing", filename: "f.gcode" };
      }
      return { ok: true, status: 200, text: async () => "" };
    }
    if (u.includes("/printer/objects/query")) {
      return { ok: true, status: 200, json: async () => ({ result: { status: {
        box: { ...state.box },
        "gcode_macro START_PRINT": { prepare: state.prepare },
        print_stats: { ...state.print_stats },
        virtual_sdcard: { ...state.virtual_sdcard },
        toolhead: { ...state.toolhead }
      } } }) };
    }
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  };
  return { scripts, impl };
}

async function withRec(r, fn) {
  const real = global.fetch;
  global.fetch = r.impl;
  const timing = creality._internal && creality._internal.PREP_TIMING;
  const saved = timing && { ...timing };
  if (timing) Object.assign(timing, { pollMs: 1, stateMs: 60, homeMs: 60, loadMs: 60, confirmMs: 60 });
  try { return await fn(); }
  finally { global.fetch = real; if (timing && saved) Object.assign(timing, saved); }
}
const names = r => r.scripts.map(s => s.split(" ")[0]);

// ---- the capability ----

test("creality-klipper no longer advertises auto-level", () => {
  assert.equal(creality.capabilities.autoLevel, false,
    "the UI must not offer a setting SnapCon deliberately does not execute");
  assert.equal(idx.getCapabilities("creality-klipper", {}).autoLevel, false,
    "and the per-printer view must agree");
  assert.equal(idx.getCapabilities("creality-klipper", { filamentMode: "cfs" }).autoLevel, false,
    "including on a CFS printer");
});

test("no other connector loses auto-level", () => {
  assert.equal(u1.capabilities.autoLevel, true, "the U1 keeps its own, different mechanism");
  assert.equal(idx.getCapabilities("snapmaker-u1-klipper-ws", {}).autoLevel, true);
});

// ---- the behaviour ----

test("a stale saved autoLevel:true on the printer no longer triggers G29", async () => {
  // Hiding the control is not enough: config.json entries written before this
  // change still carry autoLevel:true, and applyHeadMapping reads p.autoLevel.
  const r = recorder();
  await withRec(r, () => creality.applyHeadMapping({ ...P, autoLevel: true }, [], {}, {}));
  assert.equal(r.scripts.some(s => s.startsWith("G29")), false,
    "a pre-print G29 is invalidated by the re-home that follows it");
});

test("an explicit autoLevel pref no longer triggers G29 either", async () => {
  const r = recorder();
  await withRec(r, () => creality.applyHeadMapping(P, [], {}, { autoLevel: true }));
  assert.equal(r.scripts.some(s => s.startsWith("G29")), false);
});

test("flow-calibrate and timelapse prefs are unchanged — Creality never used them here", async () => {
  const r = recorder();
  await withRec(r, () => creality.applyHeadMapping(P, [], {}, { flowCalibrate: true, timelapse: true }));
  assert.deepEqual(r.scripts, [], "this connector has never sent anything for those two");
});

test("CFS lane mapping is untouched", async () => {
  const r = recorder();
  await withRec(r, () => creality.applyHeadMapping({ ...P, autoLevel: true }, [0], { 0: 3 }, {}));
  assert.deepEqual(names(r), ["BOX_ENABLE_CFS_PRINT", "BOX_MODIFY_TN"],
    "mapping still goes out, and still without a G29 after it");
  assert.match(r.scripts[1], /T1A=T1D/);
});

// ---- 9e must be byte-identical ----

test("the CFS preparation sequence is unchanged", async () => {
  const r = recorder({ box: { enable: 1, state: "connect", cut_state: 0 } });
  await withRec(r, () => creality.startPrintFile({ ...P, autoLevel: true }, "f.gcode"));
  assert.deepEqual(names(r), [
    "PRINT_PREPARING", "CANCEL_HOMEZ_NACCU", "G28", "PRINT_PREPARE_LOAD_MATERIAL",
    "NOZ_CLEAR", "NEXT_HOMEZ_NACCU", "G28", "PRINT_PREPARED", "SDCARD_PRINT_FILE"
  ], "9d must not disturb 9e");
  assert.equal(r.scripts.some(s => s.startsWith("G29")), false,
    "and preparation must not acquire a G29 of its own");
});

test("non-CFS print start is unchanged", async () => {
  const r = recorder({ box: {} });
  await withRec(r, () => creality.startPrintFile({ ...P, autoLevel: true }, "f.gcode"));
  assert.deepEqual(names(r), ["SDCARD_PRINT_FILE"],
    "a V3 Plus still gets exactly one command");
});

// ---- the U1 must not be dragged into this ----

test("the U1 still sends its bed-level preference and never a G29", async () => {
  const sent = [];
  const real = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("script=")) sent.push(decodeURIComponent(u.split("script=")[1] || ""));
    return { ok: true, status: 200, text: async () => "", json: async () => ({ result: { status: {} } }) };
  };
  try {
    await u1.applyHeadMapping({ id: "u1", name: "U1 Gold", url: "http://127.0.0.1:1", autoLevel: true }, [], {}, {});
  } finally { global.fetch = real; }
  const joined = sent.join("\n");
  assert.match(joined, /SET_PRINT_PREFERENCES[^\n]*BED_LEVEL=1/,
    "the U1 tells the firmware to level at the right moment — a different mechanism");
  assert.doesNotMatch(joined, /\bG29\b/, "and must never acquire Creality's pre-print G29");
});

// ---- the helper is retained, not deleted ----

test("the G29 helper is kept for standalone use, not ripped out", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "..", "connectors", "creality-klipper.js"), "utf8");
  assert.match(src, /async function sendG29WithRecovery/,
    "G29 works; only its use as a pre-print step was wrong. The recovery logic "
    + "(a real K1C drops its Moonraker connection mid-G29) is hard-won and stays.");
});
