// test/connectors/crealityCfsPrepare.test.js — CFS material preparation must
// happen BEFORE the print job is started (docs/TODO.md item 9e).
//
// Traced from the printer's own macro source and confirmed live on a SPARKX i7.
// START_PRINT branches on a one-shot `prepare` flag:
//
//   {% if printer['gcode_macro START_PRINT'].prepare|int == 0 %}
//     ... PRINT_PREPARE_LOAD_MATERIAL FILENAME='{file_name}' ...
//   {% else %}
//     PRINT_PREPARE_CLEAR
//   {% endif %}
//
// and PRINT_PREPARE_LOAD_MATERIAL, when the CFS is enabled AND connected, calls
// the closed-source BOX_START_PRINT_EXTRUDE_MATERIAL FILENAME='...', which
// RE-SELECTS the file. SnapCon started with prepare == 0, so that re-selection
// landed on a job that had already started and reset it: print_stats.state fell
// back to standby, virtual_sdcard.file_position reset to 0, print_duration
// stopped at 0, and Moonraker closed the history row as `cancelled | 0s`.
//
// The macro is NOT the bug — the panel calls it too. The bug is ORDERING. The
// panel loads first (the selection lands while no job exists, harmlessly), sets
// prepare, and only then starts the file, so START_PRINT takes the else-branch.
// Captured live: exactly TWO selections, the second being the actual start, and
// print_duration advancing to 977s with the history row closing `completed`.
//
// So this is the panel's own contract, not a workaround: PRINT_PREPARING and
// PRINT_PREPARED are called by NO macro anywhere in the printer's 169 config
// sections — they exist purely for an external client to drive.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const conn = require("../../connectors/creality-klipper");
const moonraker = require("../../connectors/klipper-moonraker");
const u1 = require("../../connectors/snapmaker-u1-klipper");

const P = { name: "SPARKX i7", url: "http://192.168.4.240:7125" };
const FILE = "Benchy.gcode";

// A scripted printer: answers objects/query from its own state and mutates that
// state as gcode arrives, the way the real firmware does.
function mockPrinter(opts = {}) {
  const {
    box = { enable: 1, state: "connect", cut_state: 0 },
    applyPreparing = true,     // does PRINT_PREPARING actually set prepare=2
    applyHoming = true,        // does G28 actually home the machine
    applyPrepared = true,      // does PRINT_PREPARED actually set prepare=1
    selectOnLoad = true,       // does the load actually select the file
    startActivates = true,     // does SDCARD_PRINT_FILE make the job active
    failOn = null,             // script substring whose POST rejects
    queryFailsAfter = null,    // stop answering queries once this script was sent
    afterFailedStart = null    // state to report once SDCARD_PRINT_FILE failed
  } = opts;

  const scripts = [];
  const events = [];          // ordered log of selections and job starts
  const state = {
    box: { ...box },
    prepare: 0,
    print_stats: { state: "standby", filename: "" },
    virtual_sdcard: { is_active: false, file_position: 0, file_path: "" },
    // Empty exactly as a real i7 reports after END_PRINT releases homing —
    // the state my first implementation started a print on.
    toolhead: { homed_axes: "" }
  };
  let queriesDead = false;

  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/printer/gcode/script")) {
      const script = decodeURIComponent(u.split("script=")[1] || "");
      scripts.push(script);
      if (queryFailsAfter && script.includes(queryFailsAfter)) queriesDead = true;
      if (failOn && script.includes(failOn)) {
        if (script.includes("SDCARD_PRINT_FILE") && afterFailedStart) Object.assign(state, afterFailedStart);
        return { ok: false, status: 500, text: async () => "boom" };
      }
      if (script.startsWith("PRINT_PREPARING") && applyPreparing) state.prepare = 2;
      if (/^(G28|CANCEL_HOMEZ_NACCU)\b/.test(script) && applyHoming) state.toolhead.homed_axes = "xyz";
      if (script.startsWith("PRINT_PREPARED") && applyPrepared) state.prepare = 1;
      if (script.startsWith("PRINT_PREPARE_CLEAR")) state.prepare = 0;
      if (script.startsWith("PRINT_PREPARE_LOAD_MATERIAL") && selectOnLoad) {
        state.virtual_sdcard.file_path = FILE;
        events.push({ kind: "selection", jobActive: state.virtual_sdcard.is_active });
      }
      if (script.startsWith("SDCARD_PRINT_FILE")) {
        events.push({ kind: "startIssued", homed: state.toolhead.homed_axes });
      }
      if (script.startsWith("SDCARD_PRINT_FILE") && startActivates) {
        state.virtual_sdcard.file_path = FILE;
        state.virtual_sdcard.is_active = true;
        state.print_stats = { state: "printing", filename: FILE };
        state.prepare = 0;             // START_PRINT consumes it via PRINT_PREPARE_CLEAR
        events.push({ kind: "selection", jobActive: false });
        events.push({ kind: "jobStart" });
      }
      return { ok: true, status: 200, text: async () => "ok" };
    }
    if (u.includes("/printer/objects/query")) {
      if (queriesDead) throw new Error("network down");
      return {
        ok: true, status: 200,
        json: async () => ({ result: { status: {
          box: { ...state.box },
          "gcode_macro START_PRINT": { prepare: state.prepare },
          print_stats: { ...state.print_stats },
          virtual_sdcard: { ...state.virtual_sdcard },
          toolhead: { ...state.toolhead }
        } } })
      };
    }
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  };
  return { scripts, events, state, fetchImpl };
}

async function withMock(m, fn) {
  const real = global.fetch;
  global.fetch = m.fetchImpl;
  // Shrink the poll/timeout budget so a test never waits on real firmware
  // timings; the production values are minutes for the material load.
  const timing = conn._internal && conn._internal.PREP_TIMING;
  const saved = timing && { ...timing };
  if (timing) Object.assign(timing, { pollMs: 1, stateMs: 60, loadMs: 60, confirmMs: 60 });
  try { return await fn(); }
  finally { global.fetch = real; if (timing && saved) Object.assign(timing, saved); }
}
const names = m => m.scripts.map(s => s.split(" ")[0]);

// ---- the affected path ----

// The FULL ordered sequence, not a subset. An earlier implementation asserted
// only the four CFS commands, passed every test, and then started a print on an
// unhomed machine -- `!! key95 Must home axis first` 90 seconds in. Homing is
// part of preparation on this firmware: START_PRINT's prepare==0 branch runs
// CANCEL_HOMEZ_NACCU + G28 as well as the load, and its else-branch runs
// neither, so setting prepare disables the homing too. Observed on a real
// panel-started print with calibration OFF:
//   02:55:21 print preparing -> 02:55:23-29 homing (homed "" -> "xyz")
//   -> 02:55:57 load/selection -> 02:59:37 print prepared -> 02:59:41 start
test("a CFS printer homes and loads material before starting the job", async () => {
  const m = mockPrinter();
  await withMock(m, () => conn.startPrintFile(P, FILE));
  // CANCEL_HOMEZ_NACCU precedes G28 in the firmware's own branch, and it earns
  // its place here: it disarms accuracy-mode Z homing, so G28 is plain
  // positional homing. That is what keeps this clear of 9d, where Z work ahead
  // of a print that re-homes itself wrecked the first layer.
  assert.deepEqual(names(m), [
    "PRINT_PREPARING", "CANCEL_HOMEZ_NACCU", "G28", "PRINT_PREPARE_LOAD_MATERIAL",
    "NOZ_CLEAR", "NEXT_HOMEZ_NACCU", "G28", "PRINT_PREPARED", "SDCARD_PRINT_FILE"
  ], "the firmware's own prepare==0 branch, in its own order");
});

// The second thing a trimmed branch cost: a print that ran 190 seconds with
// state=printing, homed_axes="xyz", file_position climbing past 140k and no
// fault of any kind -- while the nozzle was in the air the whole time.
//
// homed_axes means the axes are REFERENCED, not that Z is at the right zero.
// Coarse G28 is not the machine's Z reference; NEXT_HOMEZ_NACCU + G28 Z is,
// and it is what the panel was seen probing (bst_z=0.017) before its own start.
// Direct proof it matters: the 9d run that produced a good first layer took
// START_PRINT's prepare==0 branch, which ENDS with exactly these two commands.
// Setting prepare bypasses them, so preparation has to supply them.
//
// This is deliberately NOT the same thing as 9d's G29: that is bed-mesh
// calibration laid down before a print that re-homes Z underneath it. Setting
// Z zero and calibrating a mesh are different operations, and conflating them
// is what removed this step in the first place.
test("the accuracy Z reference is established after the load, before the start", async () => {
  const m = mockPrinter();
  await withMock(m, () => conn.startPrintFile(P, FILE));
  const load = m.scripts.indexOf("PRINT_PREPARE_LOAD_MATERIAL FILENAME='" + FILE + "'");
  const naccu = m.scripts.indexOf("NEXT_HOMEZ_NACCU");
  const zHome = m.scripts.lastIndexOf("G28 Z");
  const prepared = m.scripts.indexOf("PRINT_PREPARED");
  const start = m.scripts.findIndex(s => s.startsWith("SDCARD_PRINT_FILE"));
  assert.ok(load >= 0 && naccu >= 0 && zHome >= 0, "all three stages must be present");
  assert.ok(load < naccu, "the branch cleans and re-homes Z after loading, not before");
  assert.ok(naccu < zHome, "accuracy mode must be armed before the Z home it applies to");
  assert.ok(zHome < prepared && prepared < start, "Z must be set before the flag and the start");
});

// The assertion that would have caught the failure. "did we send G28" is what a
// mock happily satisfies; "was the machine actually homed when we committed to
// the print" is the property that matters.
test("the machine is verifiably homed at the moment the print is started", async () => {
  const m = mockPrinter();
  await withMock(m, () => conn.startPrintFile(P, FILE));
  const issued = m.events.find(e => e.kind === "startIssued");
  assert.ok(issued, "the start must have been issued");
  assert.ok(issued.homed && issued.homed.length > 0,
    "starting a print on an unhomed machine faults on the first move (key95)");
});

test("homing that does not take is caught instead of being assumed", async () => {
  const m = mockPrinter({ applyHoming: false });
  await assert.rejects(() => withMock(m, () => conn.startPrintFile(P, FILE)));
  assert.equal(m.scripts.some(s => s.startsWith("SDCARD_PRINT_FILE")), false,
    "the command being accepted is not evidence the axes homed");
  assert.ok(m.scripts.some(s => s.startsWith("PRINT_PREPARE_CLEAR")));
});

test("a homing failure never starts the print and clears the flag", async () => {
  const m = mockPrinter({ failOn: "G28" });
  await assert.rejects(() => withMock(m, () => conn.startPrintFile(P, FILE)));
  assert.equal(m.scripts.some(s => s.startsWith("SDCARD_PRINT_FILE")), false);
  assert.ok(m.scripts.some(s => s.startsWith("PRINT_PREPARE_CLEAR")));
});

test("no bed-mesh calibration is added to preparation", async () => {
  // 9d: a pre-print G29 wrecked the first layer because the file re-homes Z
  // underneath the mesh. That is bed-mesh CALIBRATION, and preparation must
  // never grow one. Z homing is a different operation and is required -- see
  // the accuracy-Z test above. Conflating the two is what caused the air print.
  const m = mockPrinter();
  await withMock(m, () => conn.startPrintFile(P, FILE));
  for (const forbidden of ["G29", "BED_MESH_CALIBRATE", "BED_MESH_PROFILE"]) {
    assert.equal(m.scripts.some(s => s.includes(forbidden)), false, forbidden + " must not be sent");
  }
});

test("preparation does not invent a bed temperature", async () => {
  // The branch's M104/M140 take BED_TEMP from the sliced file via START_PRINT's
  // params, which we do not have. The load has been observed twice to work
  // without them, so they are the one part of the branch left out -- guessing a
  // temperature would be fabricating a value the printer never gave us.
  const m = mockPrinter();
  await withMock(m, () => conn.startPrintFile(P, FILE));
  for (const forbidden of ["M140", "M104", "M190", "M109"]) {
    assert.equal(m.scripts.some(s => s.startsWith(forbidden)), false, forbidden + " must not be sent");
  }
});

test("the load's file selection lands BEFORE any job exists", async () => {
  const m = mockPrinter();
  await withMock(m, () => conn.startPrintFile(P, FILE));
  const selections = m.events.filter(e => e.kind === "selection");
  assert.equal(selections.length, 2, "two selections total, as the panel produces");
  assert.equal(selections[0].jobActive, false,
    "the whole bug: the load's selection must not land on a live job");
  assert.equal(m.events[m.events.length - 1].kind, "jobStart",
    "the job start must be the LAST lifecycle event — nothing re-selects after it");
});

test("the filename is passed to the load so the right file's material is prepared", async () => {
  const m = mockPrinter();
  await withMock(m, () => conn.startPrintFile(P, FILE));
  const load = m.scripts.find(s => s.startsWith("PRINT_PREPARE_LOAD_MATERIAL"));
  assert.ok(load.includes(FILE), "PRINT_PREPARE_LOAD_MATERIAL takes FILENAME");
});

test("prepare must actually reach 2 before the load is sent", async () => {
  const m = mockPrinter({ applyPreparing: false });
  await assert.rejects(() => withMock(m, () => conn.startPrintFile(P, FILE)));
  assert.equal(m.scripts.some(s => s.startsWith("SDCARD_PRINT_FILE")), false,
    "an unverified prepare flag must never reach a print start");
});

test("prepare must actually reach 1 before the print is started", async () => {
  const m = mockPrinter({ applyPrepared: false });
  await assert.rejects(() => withMock(m, () => conn.startPrintFile(P, FILE)));
  assert.equal(m.scripts.some(s => s.startsWith("SDCARD_PRINT_FILE")), false,
    "prepare==0 at START_PRINT is exactly the broken branch this fix exists to avoid");
});

test("the print is confirmed active after the start", async () => {
  const m = mockPrinter();
  await withMock(m, () => conn.startPrintFile(P, FILE));
  assert.equal(m.state.print_stats.state, "printing");
  assert.equal(m.state.virtual_sdcard.is_active, true);
});

// ---- machines that must keep today's behaviour exactly ----

for (const [label, box] of [
  ["box.enable = 0", { enable: 0, state: "connect" }],
  ["box disconnected", { enable: 1, state: "disconnect" }],
  ["no box object at all", undefined]
]) {
  test(`${label}: single SDCARD_PRINT_FILE, unchanged`, async () => {
    const m = mockPrinter({ box: box || {} });
    if (!box) delete m.state.box;
    await withMock(m, () => conn.startPrintFile(P, FILE));
    assert.deepEqual(names(m), ["SDCARD_PRINT_FILE"],
      "non-CFS Creality, including both V3 Plus units here, must not gain a preparation sequence");
  });
}

test("an unreadable printer falls back to the plain start rather than refusing", async () => {
  const m = mockPrinter();
  const real = m.fetchImpl;
  m.fetchImpl = async (url) => {
    if (String(url).includes("/printer/objects/query")) throw new Error("network down");
    return real(url);
  };
  await withMock(m, () => conn.startPrintFile(P, FILE));
  assert.deepEqual(names(m), ["SDCARD_PRINT_FILE"],
    "a failed capability probe must not block a print that works today");
});

// ---- failure semantics: logical flag vs physical material ----

test("a preparation failure never starts the print and clears the flag", async () => {
  const m = mockPrinter({ failOn: "PRINT_PREPARING" });
  await assert.rejects(() => withMock(m, () => conn.startPrintFile(P, FILE)));
  assert.equal(m.scripts.some(s => s.startsWith("SDCARD_PRINT_FILE")), false);
  assert.ok(m.scripts.some(s => s.startsWith("PRINT_PREPARE_CLEAR")),
    "an armed prepare flag would make the NEXT print skip material loading entirely");
});

test("a load failure never starts the print and clears the flag", async () => {
  const m = mockPrinter({ failOn: "PRINT_PREPARE_LOAD_MATERIAL" });
  await assert.rejects(() => withMock(m, () => conn.startPrintFile(P, FILE)));
  assert.equal(m.scripts.some(s => s.startsWith("SDCARD_PRINT_FILE")), false);
  assert.ok(m.scripts.some(s => s.startsWith("PRINT_PREPARE_CLEAR")));
});

test("a load failure is NOT reported as safely retriable", async () => {
  const m = mockPrinter({ failOn: "PRINT_PREPARE_LOAD_MATERIAL" });
  await assert.rejects(() => withMock(m, () => conn.startPrintFile(P, FILE)), err => {
    // PRINT_PREPARE_CLEAR resets a variable; it proves nothing about filament
    // that BOX_START_PRINT_EXTRUDE_MATERIAL may already have cut or fed.
    assert.match(err.message, /check|material|CFS|lane/i,
      "the operator must be told to check the physical state before retrying");
    return true;
  });
});

// ---- the ambiguous zone around SDCARD_PRINT_FILE ----
// Measured live: Moonraker accepted a CANCEL_PRINT at 00:57:05 and Klipper ran
// it at 00:57:51, while the caller had already timed out at 20s. A failed POST
// is not evidence the command did not execute.

test("an ambiguous start that DID take effect is treated as started", async () => {
  const m = mockPrinter({
    failOn: "SDCARD_PRINT_FILE",
    afterFailedStart: {
      print_stats: { state: "printing", filename: FILE },
      virtual_sdcard: { is_active: true, file_position: 42, file_path: FILE }
    }
  });
  await withMock(m, () => conn.startPrintFile(P, FILE));
  assert.equal(m.scripts.some(s => s.startsWith("PRINT_PREPARE_CLEAR")), false,
    "clearing prepare under a running job would corrupt state START_PRINT owns");
});

test("an ambiguous start that did NOT take effect cleans up and fails", async () => {
  const m = mockPrinter({
    failOn: "SDCARD_PRINT_FILE",
    afterFailedStart: {
      print_stats: { state: "standby", filename: "" },
      virtual_sdcard: { is_active: false, file_position: 0, file_path: FILE }
    }
  });
  await assert.rejects(() => withMock(m, () => conn.startPrintFile(P, FILE)));
  assert.ok(m.scripts.some(s => s.startsWith("PRINT_PREPARE_CLEAR")),
    "definitely-inactive means the flag must not be left armed");
});

test("an ambiguous start whose outcome cannot be read fails conservatively", async () => {
  const m = mockPrinter({ failOn: "SDCARD_PRINT_FILE", queryFailsAfter: "SDCARD_PRINT_FILE" });
  await assert.rejects(() => withMock(m, () => conn.startPrintFile(P, FILE)), err => {
    assert.match(err.message, /unknown|could not|unable|check/i);
    return true;
  });
  assert.equal(m.scripts.some(s => s.startsWith("PRINT_PREPARE_CLEAR")), false,
    "cleaning up blind could tear down a print that actually started");
});

test("the standby + is_active normalization counts as evidence the job is live", async () => {
  // The i7 genuinely reports standby with is_active true during START_PRINT.
  const m = mockPrinter({
    failOn: "SDCARD_PRINT_FILE",
    afterFailedStart: {
      print_stats: { state: "standby", filename: FILE },
      virtual_sdcard: { is_active: true, file_position: 99, file_path: FILE }
    }
  });
  await withMock(m, () => conn.startPrintFile(P, FILE));
  assert.equal(m.scripts.some(s => s.startsWith("PRINT_PREPARE_CLEAR")), false,
    "standby+is_active is a live job on this firmware, not an idle printer");
});

// ---- ordering with head mapping, across the whole call path ----

// Lane mapping must reach the printer before material is loaded, or the load
// pulls from the wrong lane. That ordering is enforced by WHERE the two live:
// mapping is applyHeadMapping's job, startPrintFile never does it itself, and
// every start path calls the former before the latter. Asserted structurally
// rather than by driving both, so this does not depend on which lane-mapping
// commands the connector happens to emit.
test("startPrintFile never sends lane mapping itself", async () => {
  const m = mockPrinter();
  await withMock(m, () => conn.startPrintFile(P, FILE));
  for (const forbidden of ["BOX_MODIFY_TN", "BOX_ENABLE_CFS_PRINT"]) {
    assert.equal(m.scripts.some(s => s.startsWith(forbidden)), false,
      forbidden + " belongs to applyHeadMapping, which runs first");
  }
});

test("every start path applies head mapping before starting the print", () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
  let from = 0, checked = 0;
  for (;;) {
    const start = serverSrc.indexOf("c.startPrintFile(", from);
    if (start < 0) break;
    // The nearest applyHeadMapping call before this start must belong to the
    // same block -- i.e. there is one, and nothing resets between them.
    const mapAt = serverSrc.lastIndexOf("c.applyHeadMapping(", start);
    assert.ok(mapAt > 0 && start - mapAt < 1200,
      "a start at offset " + start + " has no head mapping immediately before it");
    checked++;
    from = start + 1;
  }
  assert.equal(checked, 3, "/api/print, /api/printfile and queue dispatch");
});

// ---- everything else must be untouched ----

test("generic Klipper and U1 keep the plain single-command start", async () => {
  const m = mockPrinter();
  await withMock(m, () => moonraker.startPrintFile(P, FILE));
  assert.deepEqual(names(m), ["SDCARD_PRINT_FILE"]);
  const m2 = mockPrinter();
  await withMock(m2, () => u1.startPrintFile(P, FILE));
  assert.deepEqual(names(m2), ["SDCARD_PRINT_FILE"]);
});

test("a filename that cannot be safely quoted falls back rather than breaking a working print", async () => {
  // PRINT_PREPARE_LOAD_MATERIAL takes FILENAME='...' (single-quoted, the
  // firmware's own form). An apostrophe would terminate that argument early.
  // Such files print fine today via the double-quoted SDCARD_PRINT_FILE, so the
  // CFS path steps aside instead of making a working case worse.
  const m = mockPrinter();
  await withMock(m, () => conn.startPrintFile(P, "Dad's Bracket.gcode"));
  assert.deepEqual(names(m), ["SDCARD_PRINT_FILE"]);
});

test("gcode-injection guards still apply on the CFS path", async () => {
  const m = mockPrinter();
  await withMock(m, async () => {
    await assert.rejects(() => conn.startPrintFile(P, 'x.gcode"\nM112'), /Invalid characters/);
  });
  assert.equal(m.scripts.length, 0, "nothing may be sent for a rejected filename");
});

test("all three server start paths still converge on the connector", () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
  const calls = serverSrc.split("c.startPrintFile(").length - 1;
  assert.equal(calls, 3, "/api/print, /api/printfile and queue dispatch — no CFS logic outside the connector");
  for (const forbidden of ["PRINT_PREPARING", "PRINT_PREPARE_LOAD_MATERIAL", "BOX_START_PRINT"]) {
    assert.equal(serverSrc.includes(forbidden), false, forbidden + " must not leak into server.js");
  }
});
