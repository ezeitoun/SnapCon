// fixtures/virtual-u1/model.js — the state of one virtual Snapmaker U1, with
// no I/O. server.js puts Moonraker's HTTP and WebSocket API in front of it.
//
// Where each behaviour comes from is marked, the same way docs/TODO.md does:
//   [live]    seen on a real U1 (fixtures/virtual-u1/captures/)
//   [source]  Snapmaker/u1-klipper 1.6.0 (firmware 2.0's Klipper source is not
//             published; its captures show the same shapes)
//   [guess]   neither — a stand-in so the simulation can run. Never treat a
//             [guess] as evidence of how a real U1 behaves.
//
// Time is virtual: nothing moves until advance(seconds) is called (server.js
// calls it from a wall clock when asked to). How long the printer's own steps
// take is the `timing` option:
//   "fast" (default)  every wait is skipped: a resume is reheated at once, a
//                     tool change is instant, a command's reply never waits.
//   "real"            each step takes the time Yellow took [live recording,
//                     2026-10-11]: pause, resume's reheat, cancel's clean-up
//                     and tool changes run over time, and settled() — what
//                     the server waits on before replying — resolves only
//                     when they are done.
// Two more options shorten a print further, as the Virtual U1 printer type's
// Fast timing does (connectors/virtual-u1.js):
//   printSpeed: n     the print itself (start sequence, layers) runs n times
//                     faster than its time; print_stats reports that time,
//                     so a file's own durations still add up. Default 1.
//   instantHeat       heaters reach their target at once.
const fs = require("fs");
const path = require("path");
const { readSlicedFile } = require("./slicedFile");

const CAPTURES = path.join(__dirname, "captures");
const HEADS = 4;              // [source] PHYSICAL_EXTRUDER_NUM
const LOGICAL_TOOLS = 32;     // [source] LOGICAL_EXTRUDER_NUM
const EXT = ["extruder", "extruder1", "extruder2", "extruder3"];
const AMBIENT = 25;           // [live] idle heads read 25.0
const PAUSE_TEMP = 40;        // [source][live] pause_resume.py: hot heads drop to 40
const MAX_BED = 100;          // [live] printer.cfg heater_bed max_temp
const MAX_NOZZLE = 300;       // [guess] only used to reject absurd targets
// Standby and preheat are the slicer's, not the printer's: with Orca's ooze
// prevention on, the file itself sets a parked head to print temperature plus
// standby_temperature_delta, and heats the next head preheat_time seconds
// before its change (M104 S65 Tn / M104 S215 Tn in SnapmakerOrca files). The
// defaults are SnapmakerOrca's: -150 and 30s, so a 215°C head waits at 65.
// [live] Yellow's recording, 33 changes, matched them: heads waited at 65,
// the next head was heated 28–37s ahead, and a used head stayed at standby
// after its last use, until the job ended (no M104 S0 Tn in the file). A head
// the job never uses stays at 0.
const STANDBY_DELTA = -150;
const PREHEAT_SECONDS = 30;
// [live] The head being left dropped to standby about 4s before it parked.
const STANDBY_LEAD_SECONDS = 4;
// [live] How long Yellow's steps took, for timing "real". A tool change (park,
// pick, offsets) took ~4s; pause dropped the heads to 40 ~3s after "paused";
// cancel turned heaters off and cleared homing ~9s after "cancelled"; resume
// reheated the head (101 → 230 in ~22s after a 2-minute pause), then took
// ~13s more before printing (what it does in that time is not traced).
const TOOL_CHANGE_SECONDS = 4;
const PAUSE_COOL_DELAY = 3;
const CANCEL_CLEANUP_DELAY = 9;
const RESUME_AFTER_HEAT = 13;
const HEAT_RATE = 5, COOL_RATE = 2, BED_RATE = 1;     // °C/s [guess]
const FILAMENT_MM_PER_S = 2;                            // [guess]
// [source] channel_sequence/module_sequence in printer.cfg: head 0 = left ch1,
// head 1 = left ch0, head 2 = right ch0, head 3 = right ch1.
const FEEDER = [["left", "extruder0"], ["left", "extruder1"], ["right", "extruder2"], ["right", "extruder3"]];

const clone = v => JSON.parse(JSON.stringify(v));
const identityMap = () => Array.from({ length: LOGICAL_TOOLS }, (_, i) => (i < HEADS ? i : 0));

// A G-code error, as Moonraker reports it: HTTP 400 with this message.
class GcodeError extends Error {}
// The U1's structured errors carry a "coded" JSON string as their message
// [source virtual_sdcard.py] — the same form SnapCon decodes from
// print_stats.message.
const coded = (level, id, index, code, msg, action = "none") =>
  new GcodeError(JSON.stringify({ coded: [level, id, index, code].map(n => String(n).padStart(4, "0")).join("-"), msg, action }));

function loadCapture(firmware, label) {
  const f = path.join(CAPTURES, firmware, label + ".json");
  if (!fs.existsSync(f)) throw new Error(`No capture ${firmware}/${label}.json — see scripts/capture-u1.js`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

function availableFirmware() {
  return fs.readdirSync(CAPTURES).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// Filament in a head, as print_task_config stores it [live].
const EMPTY_SLOT = { present: false, vendor: "NONE", type: "NONE", sub: "NONE", rgba: "FFFFFFFF", official: false, sku: 0 };
function filament(spec) {
  if (!spec) return { ...EMPTY_SLOT };
  const hex = String(spec.color || "#FFFFFF").replace("#", "").toUpperCase().slice(0, 6);
  return {
    present: spec.present !== false,
    vendor: spec.vendor || "Generic", type: spec.type || "PLA", sub: spec.sub != null ? spec.sub : "",
    rgba: hex + "FF", official: !!spec.official, sku: spec.official ? (spec.sku || 1) : 0
  };
}
const argb = rgba => (parseInt(rgba.slice(6, 8) || "FF", 16) * 0x1000000) + parseInt(rgba.slice(0, 6), 16);

// One G-code line → { cmd, params }. Klipper's extended syntax (KEY=value,
// optionally quoted) and classic syntax (S220 T1) are both handled.
function parseLine(line) {
  const text = line.replace(/;.*$/, "").trim();
  if (!text) return null;
  const m = /^(\S+)\s*(.*)$/.exec(text);
  const cmd = m[1].toUpperCase();
  const params = {};
  const rest = m[2];
  if (/=/.test(rest)) {
    const re = /([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g;
    let p;
    while ((p = re.exec(rest))) params[p[1].toUpperCase()] = p[2].replace(/^(["'])(.*)\1$/, "$2");
  } else {
    for (const tok of rest.split(/\s+/).filter(Boolean)) params[tok[0].toUpperCase()] = tok.slice(1);
  }
  return { cmd, params, raw: text };
}

class VirtualU1 {
  // firmware: a folder under captures/ ("1.6.0", "2.0.0"); defaults to the newest.
  // heads: up to four filament specs { color, type, vendor, sub, official } or
  // null for an empty head. Defaults to four loaded PLA spools.
  // timing: "fast" or "real" (see the top of this file).
  constructor({ firmware, heads, timing = "fast", printSpeed = 1, instantHeat = false } = {}) {
    if (!["fast", "real"].includes(timing)) throw new Error(`timing must be "fast" or "real", not ${JSON.stringify(timing)}`);
    if (!(printSpeed > 0)) throw new Error(`printSpeed must be above 0, not ${JSON.stringify(printSpeed)}`);
    this.timing = timing;
    this.printSpeed = printSpeed;
    this.instantHeat = !!instantHeat;
    this.firmware = firmware || availableFirmware().pop();
    this.idleCapture = loadCapture(this.firmware, "idle");
    // Objects the model does not drive keep the idle capture's real values.
    this.baseStatus = clone(this.idleCapture.status);
    this.time = 0;
    this.listeners = new Set();
    this.pending = [];         // steps still running ("real" timing only)
    this.settleWaiters = [];
    this.gcodeLog = [];        // every command the simulator received, in order
    this.history = [];         // finished jobs, newest last

    const specs = heads || [
      { color: "#F5D629" }, { color: "#000000" }, { color: "#E53935" }, { color: "#1E88E5" }
    ];
    this.heads = Array.from({ length: HEADS }, (_, i) => {
      const live = this.baseStatus[EXT[i]] || {};
      return {
        temp: AMBIENT, target: 0, power: 0,
        state: "PARKED",
        offset: live.extruder_offset || [0, 0, 0],
        switchCount: live.switch_count || 0,
        filament: filament(specs[i] === undefined ? null : specs[i])
      };
    });
    this.activeHead = 0;        // toolhead.extruder: the last head picked [live]
    this.bed = { temp: AMBIENT, target: 0 };
    this.homed = "";
    this.fanSpeed = 0;
    this.klippy = { state: "ready", message: "Printer is ready" };
    this.machine = { main: 0, action: 0 };   // [source] machine_state_manager IDLE
    this.taskConfig = {
      map: identityMap(), used: [false, false, false, false],
      bedLevel: false, flowCalibrate: false, timelapse: false, flowCalibExtruders: [true, true, true, true]
    };
    this.reprint = clone(this.taskConfig);
    this.job = null;
    this.stats = this.freshStats();
    this.files = { gcodes: new Map(), logs: new Map(), camera: new Map(), config: new Map() };
    this.excludeObject = { objects: [], excluded: [], current: null };
    this.cameraStarted = false;
  }

  // ---- change notification (server.js turns these into WebSocket deltas) ----
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) fn(); }

  // ---- steps that take time ----
  // later({ after, until, skip }, run): run() once `after` seconds of model
  // time have passed or until() is true. With timing "fast" there is no wait:
  // skip() (if given) puts the printer where the wait would have left it,
  // and run() happens now.
  later({ after, until, skip }, run) {
    if (this.timing === "fast") { if (skip) skip(); run(); return; }
    this.pending.push({ at: after != null ? this.time + after : null, until, run });
  }
  runPending() {
    for (const op of this.pending.slice()) {
      if ((op.at != null && this.time >= op.at - 1e-9) || (op.until && op.until())) {
        this.pending.splice(this.pending.indexOf(op), 1);
        op.run();
      }
    }
    if (!this.pending.length) this.releaseSettled();
  }
  releaseSettled() { const w = this.settleWaiters; this.settleWaiters = []; for (const r of w) r(); }
  // Resolves when no step is still running: when a real U1 answers the
  // /printer/gcode/script request that started one. Like Klipper's G-code
  // queue, a command sent during a tool change waits for it too.
  settled() { return this.pending.length ? new Promise(r => this.settleWaiters.push(r)) : Promise.resolve(); }
  dropPending() { this.pending = []; this.releaseSettled(); }

  freshStats() {
    return {
      state: "standby", filename: "", printDuration: 0, totalDuration: 0, filamentUsed: 0,
      layer: null, totalLayers: null, exception: null, message: "", progress: 0,
      filePosition: 0, fileSize: 0, filePath: null, isActive: false, paused: false
    };
  }

  // ---- G-code ----
  // Runs a /printer/gcode/script payload: one command per line, stopping at
  // the first error, which is thrown as a GcodeError (HTTP 400). Long-running
  // macros (unload, cancel) complete at once here — the request does not wait
  // on virtual time [guess for durations].
  runScript(script) {
    if (this.klippy.state !== "ready") throw new GcodeError("Klippy not ready: " + this.klippy.state); // [guess] exact text
    try {
      for (const line of String(script).split(/\r?\n/)) {
        const g = parseLine(line);
        if (!g) continue;
        this.gcodeLog.push(g.raw);
        this.runCommand(g);
      }
    } finally {
      this.changed();
    }
  }

  runCommand({ cmd, params }) {
    const tool = /^T(\d+)$/.exec(cmd);
    if (tool) return this.selectTool(+tool[1], params.A !== undefined ? +params.A : 1);
    switch (cmd) {
      case "SDCARD_PRINT_FILE": return this.startPrint(params.FILENAME);
      case "PAUSE": return this.pause();
      case "RESUME": return this.resume();
      case "CANCEL_PRINT": return this.cancel();
      case "SDCARD_RESET_FILE": return this.resetFile();
      case "M140": return this.setBed(+params.S);
      case "M104": case "M109": return this.setNozzle(+params.S, params.T, params.A);
      case "SET_HEATER_TEMPERATURE": return this.setHeater(params.HEATER, +params.TARGET);
      case "TURN_OFF_HEATERS": return this.heatersOff();
      case "SET_PRINT_EXTRUDER_MAP": return this.setExtruderMap(params);
      case "SET_PRINT_USED_EXTRUDERS": return this.setUsedExtruders(params);
      case "SET_PRINT_PREFERENCES": return this.setPreferences(params);
      case "SET_PRINT_FILAMENT_CONFIG": return this.setFilamentConfig(params);
      case "AUTO_FEEDING": return this.autoFeeding(params);
      case "EXCLUDE_OBJECT": return this.excludeObjectCmd(params);
      case "G28": this.homed = "xyz"; return;
      case "M106": this.fanSpeed = Math.min(1, (+params.S || 0) / 255); return;
      case "M107": this.fanSpeed = 0; return;
      default:
        // [source] gcode.py: Unknown command:"FOO"
        throw new GcodeError(`Unknown command:"${cmd}"`);
    }
  }

  printing() { return this.stats.state === "printing" || this.stats.state === "paused"; }

  // ---- heads ----
  // [source] Tn maps through extruder_map_table unless A0 is given.
  selectTool(n, apply = 1) {
    if (n >= LOGICAL_TOOLS) throw new GcodeError(`Unknown command:"T${n}"`);
    const head = apply ? this.taskConfig.map[n] : n;
    if (!(head >= 0 && head < HEADS)) throw new GcodeError("[guess] invalid extruder " + head);
    this.pickHead(head);
  }

  // [source] _cmd_SWITCH_EXTRUDER: park whichever head is active, pick the
  // target, toolhead.extruder follows it, the part fan follows it, offsets
  // follow it.
  pickHead(head) {
    if (this.heads[head].state === "ACTIVATE") return;
    if (!this.homed.includes("x")) this.homed = "xyz";
    for (const h of this.heads) if (h.state === "ACTIVATE") h.state = "PARKED";
    this.heads[head].state = "ACTIVATE";
    this.heads[head].switchCount++;
    this.activeHead = head;
  }

  parkAll() { for (const h of this.heads) h.state = "PARKED"; }

  setNozzle(t, T, A) {
    if (!(t >= 0 && t <= MAX_NOZZLE)) throw new GcodeError(`Requested temperature (${t}) out of range (0.0:${MAX_NOZZLE}.0)`);
    let head = this.activeHead;
    if (T !== undefined) head = (A !== undefined && +A === 0) ? +T : this.taskConfig.map[+T];
    if (!this.heads[head]) throw new GcodeError("[guess] invalid extruder " + head);
    this.heads[head].target = t;
  }

  setHeater(name, t) {
    if (name === "heater_bed") return this.setBed(t);
    const i = EXT.indexOf(name);
    if (i < 0) throw new GcodeError(`Unknown heater "${name}"`);
    this.heads[i].target = t;
  }

  // [source] Klipper's verify of max_temp; text format of heaters.py.
  setBed(t) {
    if (!(t >= 0 && t <= MAX_BED)) throw new GcodeError(`Requested temperature (${t.toFixed(1)}) out of range (0.0:${MAX_BED.toFixed(1)})`);
    this.bed.target = t;
  }

  heatersOff() {
    for (const h of this.heads) h.target = 0;
    this.bed.target = 0;
  }

  // ---- print_task_config [source print_task_config.py] ----
  setExtruderMap(p) {
    if (this.printing()) throw coded(1, 531, 0, 15, "[print_task_config] not allowed to set extruder map during printing!");
    if (p.CONFIG_EXTRUDER === undefined || p.MAP_EXTRUDER === undefined) throw new GcodeError("[print_task_config] extruder map, incomplete parameters");
    const c = +p.CONFIG_EXTRUDER, m = +p.MAP_EXTRUDER;
    if (!(c >= 0 && c < LOGICAL_TOOLS && m >= 0 && m < HEADS)) throw new GcodeError("[print_task_config] extruder map, invalid extruder index!!!");
    this.taskConfig.map[c] = m;
    this.reprint.map[c] = m;
  }

  setUsedExtruders(p) {
    if (this.printing()) throw coded(1, 531, 0, 16, "[print_task_config] not allow to set used extruders during printing!");
    const list = String(p.EXTRUDERS || "").split(",").filter(s => s !== "").map(Number);
    this.taskConfig.used = [0, 1, 2, 3].map(i => list.includes(i));
    this.reprint.used = this.taskConfig.used.slice();
  }

  setPreferences(p) {
    const touchesJob = ["BED_LEVEL", "FLOW_CALIBRATE", "SHAPER_CALIBRATE", "TIME_LAPSE_CAMERA", "END_UNLOAD_FILAMENT"].some(k => p[k] !== undefined);
    if (this.printing() && touchesJob) throw coded(1, 531, 0, 16, "[print_task_config] not allow to set preferences during printing!");
    if (p.BED_LEVEL !== undefined) this.taskConfig.bedLevel = this.reprint.bedLevel = !!+p.BED_LEVEL;
    if (p.FLOW_CALIBRATE !== undefined) this.taskConfig.flowCalibrate = this.reprint.flowCalibrate = !!+p.FLOW_CALIBRATE;
    if (p.TIME_LAPSE_CAMERA !== undefined) this.taskConfig.timelapse = this.reprint.timelapse = !!+p.TIME_LAPSE_CAMERA;
    if (p.FLOW_CALIBRATE_EXTRUDERS !== undefined) {
      const list = String(p.FLOW_CALIBRATE_EXTRUDERS).split(",").filter(s => s !== "").map(Number);
      this.taskConfig.flowCalibExtruders = [0, 1, 2, 3].map(i => list.includes(i));
      this.reprint.flowCalibExtruders = this.taskConfig.flowCalibExtruders.slice();
    }
  }

  // [source] reset_print_info, run at the end of every job.
  resetPrintInfo() {
    this.taskConfig.map = identityMap();
    this.taskConfig.used = [false, false, false, false];
    this.taskConfig.bedLevel = this.taskConfig.flowCalibrate = this.taskConfig.timelapse = false;
    this.taskConfig.flowCalibExtruders = [true, true, true, true];
  }

  // [source] cmd_SET_PRINT_FILAMENT_CONFIG. No printing guard in firmware.
  setFilamentConfig(p) {
    const i = +p.CONFIG_EXTRUDER;
    if (!(i >= 0 && i < HEADS)) throw new GcodeError(`[print_task_config] extruder${p.CONFIG_EXTRUDER} is out of range[0, ${HEADS - 1}]`);
    const f = this.heads[i].filament;
    if (f.official && !+p.FORCE) throw new GcodeError("[print_task_config] filament_config, official filament, not configurable!");
    const material = [p.VENDOR, p.FILAMENT_TYPE, p.FILAMENT_SUBTYPE];
    if (material.some(v => v !== undefined) && material.some(v => v === undefined)) throw new GcodeError("[print_task_config] filament_config, incomplete parameters");
    if (p.FILAMENT_COLOR_RGBA !== undefined && !/^([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(p.FILAMENT_COLOR_RGBA)) throw new GcodeError("[print_task_config] filament_config, rgba error");
    if (p.VENDOR !== undefined) { f.vendor = p.VENDOR; f.type = p.FILAMENT_TYPE; f.sub = p.FILAMENT_SUBTYPE; }
    if (p.FILAMENT_COLOR_RGBA !== undefined) f.rgba = (p.FILAMENT_COLOR_RGBA.toUpperCase() + "FF").slice(0, 8);
    f.official = false; f.sku = 0;
  }

  // [source] AUTO_FEEDING → FEED_AUTO: picks the head with T<i> A0, heats,
  // unloads, then turns that heater off. The intermediate channel states are
  // not simulated; the request completes with the end state.
  autoFeeding(p) {
    const i = +p.EXTRUDER;
    if (!(i >= 0 && i < HEADS)) throw new GcodeError("[guess] AUTO_FEEDING invalid extruder " + p.EXTRUDER);
    if (!+p.UNLOAD) throw new GcodeError("[guess] only UNLOAD=1 is simulated");
    if (![0, 1, 9, 10].includes(this.machine.main)) throw new GcodeError("[guess] AUTO_FEEDING not allowed in machine state " + this.machine.main);
    this.selectTool(i, 0);
    this.heads[i].target = 0;
    this.heads[i].filament = { ...EMPTY_SLOT };
  }

  excludeObjectCmd(p) {
    if (p.NAME === undefined) return; // EXCLUDE_OBJECT with no args lists them [source]
    const name = String(p.NAME).toUpperCase(); // [source] no check the object exists
    if (!this.excludeObject.excluded.includes(name)) this.excludeObject.excluded.push(name);
  }

  // ---- files ----
  // A virtual G-code file. opts.tools are the slicer's logical tools (T0…)
  // the file prints with; the rest shape its metadata and how it runs.
  // opts.standbyDelta and opts.preheatTime are the slicer's ooze prevention
  // settings the file was sliced with (see STANDBY_DELTA). opts.content is
  // the file's bytes when it is a real one (addUploadedFile); otherwise a
  // small file saying the same is made up.
  //
  // Per logical tool: opts.nozzleTemps (else opts.nozzleTemp, 215), colours,
  // types, filamentNames, weights. opts.layers with opts.estimatedSeconds or
  // opts.secondsPerLayer sets how long it prints. opts.objectList names its
  // objects ({ name, center, polygon }); else opts.objects made-up ones.
  addFile(name, opts = {}) {
    const tools = opts.tools || [0];
    const nozzleTemp = opts.nozzleTemp || 215;
    const slots = Math.max(Math.max(...tools) + 1, (opts.nozzleTemps || []).length, (opts.colours || []).length, (opts.weights || []).length);
    const nozzleTemps = Array.from({ length: slots }, (_, t) => (opts.nozzleTemps && opts.nozzleTemps[t] > 0 ? opts.nozzleTemps[t] : nozzleTemp));
    const oozePrevention = opts.oozePrevention !== false;
    const standbyDelta = opts.standbyDelta ?? STANDBY_DELTA;
    const preheatTime = opts.preheatTime ?? PREHEAT_SECONDS;
    const layers = opts.layers || 20;
    const secondsPerLayer = opts.estimatedSeconds ? opts.estimatedSeconds / layers : (opts.secondsPerLayer || 30);
    const colourDefaults = ["#F5D629", "#000000", "#E53935", "#1E88E5"];
    const colours = Array.from({ length: slots }, (_, t) => (opts.colours && opts.colours[t]) || colourDefaults[t % 4]);
    const types = Array.from({ length: slots }, (_, t) => (opts.types && opts.types[t]) || "PLA");
    const names = Array.from({ length: slots }, (_, t) => (opts.filamentNames && opts.filamentNames[t]) || "Generic " + types[t]);
    const weights = opts.weights ? Array.from({ length: slots }, (_, t) => opts.weights[t] || 0)
      : Array.from({ length: slots }, (_, t) => (tools.includes(t) ? 12.5 : 0));
    const bedTemp = opts.bedTemp ?? 65;
    const layerHeight = opts.layerHeight || 0.2;
    const firstLayerHeight = opts.firstLayerHeight || layerHeight;
    const estimated = Math.round(layers * secondsPerLayer);
    let content = opts.content, gcodeStart = opts.gcodeStart, gcodeEnd = opts.gcodeEnd;
    if (!content) {
      // Head and tail like an Orca/SnapmakerOrca file: SnapCon reads the last
      // 50KB for the slicer's config block, so the tail carries the palette.
      const header = `; generated by SnapmakerOrca 2.4.0\n; total layer number: ${layers}\n`;
      const body = "G1 X10 Y10 E0.5\n".repeat(opts.bodyLines || 200);
      const tail = [
        "; filament used [g] = " + weights.join(", "),
        `; estimated printing time (normal mode) = ${Math.floor(estimated / 60)}m ${estimated % 60}s`,
        "; CONFIG_BLOCK_START",
        "; filament_colour = " + colours.join(";"),
        "; filament_type = " + types.join(";"),
        "; first_layer_bed_temperature = " + bedTemp,
        "; nozzle_temperature = " + nozzleTemps.join(","),
        "; ooze_prevention = " + (oozePrevention ? 1 : 0),
        "; preheat_time = " + preheatTime,
        "; standby_temperature_delta = " + standbyDelta,
        "; CONFIG_BLOCK_END", ""
      ].join("\n");
      content = Buffer.from(header + body + tail);
      gcodeStart = header.length;
      gcodeEnd = header.length + body.length;
    }
    const objectList = opts.objectList || Array.from({ length: opts.objects || 3 }, (_, i) => {
      const x = 60 + i * 50, y = 120;
      return { name: `OBJECT_${i + 1}_ID_${i + 1}_COPY_0`, center: [x, y], polygon: [[x - 10, y - 10], [x + 10, y - 10], [x + 10, y + 10], [x - 10, y + 10]] };
    });
    const modified = opts.modified || 1760000000 + this.files.gcodes.size;
    const stem = name.replace(/\.[^.]+$/, "");
    const used = tools.filter(t => t < slots);
    this.files.gcodes.set(name, {
      content, modified,
      plan: { tools, layers, secondsPerLayer, objectList, bedTemp, nozzleTemps, oozePrevention, standbyDelta, preheatTime },
      // [live] field set of a SnapmakerOrca file's metadata, from history entries.
      metadata: {
        size: content.length, modified, uuid: "00000000-0000-0000-0000-" + String(this.files.gcodes.size).padStart(12, "0"),
        slicer: opts.slicer || "SnapmakerOrca", slicer_version: opts.slicerVersion || "2.4.0",
        gcode_start_byte: gcodeStart ?? 0, gcode_end_byte: gcodeEnd ?? content.length,
        layer_count: layers, object_height: firstLayerHeight + (layers - 1) * layerHeight, estimated_time: estimated,
        nozzle_diameter: opts.nozzleDiameter || 0.4, layer_height: layerHeight, first_layer_height: firstLayerHeight,
        first_layer_extr_temp: nozzleTemps[used[0] ?? 0], first_layer_bed_temp: bedTemp, chamber_temp: 0,
        filament_name: names.join(";"),
        filament_type: types.join(";"),
        filament_colour: colours.join(";"),
        filament_weight: weights, filament_total: weights.reduce((a, b) => a + b, 0) * 330,
        filament_weight_total: weights.reduce((a, b) => a + b, 0),
        thumbnails: opts.thumbnail === false ? [] : [
          { width: 96, height: 96, size: 100, relative_path: `.thumbs/${stem}-96x96.png` },
          { width: 48, height: 48, size: 80, relative_path: `.thumbs/${stem}-48x48.png` },
          { width: 300, height: 300, size: 200, relative_path: `.thumbs/${stem}-300x300.png` }
        ],
        print_start_time: null, job_id: null, filename: name
      }
    });
    return this.files.gcodes.get(name);
  }

  // A file sent to the printer: it prints as the file itself says
  // (slicedFile.js), and what the file does not say keeps addFile's defaults.
  addUploadedFile(name, content, { modified } = {}) {
    return this.addFile(name, { ...readSlicedFile(content), content, modified });
  }

  // A tool's print and standby temperatures. With ooze prevention off the
  // slicer writes no standby: [guess, no U1 file of ours has it off] the
  // parked head stays at its print temperature, and the next head heats only
  // at its change.
  nozzleOf(plan, tool) { return plan.nozzleTemps[tool] || plan.nozzleTemps[0] || 215; }
  standbyOf(plan, tool) { return plan.oozePrevention ? Math.max(0, this.nozzleOf(plan, tool) + plan.standbyDelta) : this.nozzleOf(plan, tool); }

  // ---- print control ----
  // [source] cmd_SDCARD_PRINT_FILE then work_handler: refused while a job runs,
  // resets print_stats, turns every heater off, and is "printing" within one
  // reactor tick — before any heating or homing.
  startPrint(filename) {
    if (this.stats.isActive || this.stats.state === "paused") throw coded(1, 531, 0, 1, "SD busy");
    const name = String(filename || "").replace(/^\//, "");
    const file = this.files.gcodes.get(name);
    if (!file) throw new GcodeError(`[guess] Unable to open file "${name}"`);
    this.dropPending(); // e.g. an earlier cancel's clean-up must not hit this job
    this.stats = this.freshStats();
    // Wall-clock start, for the history record: Moonraker stamps jobs with real
    // UNIX time (fleet utilization reads them against SnapCon's own clock).
    this.jobStartedAt = Date.now() / 1000;
    this.heatersOff();
    // set_new_print_info: when no used heads were set, they come from the
    // file's tools through the map [source].
    if (!this.taskConfig.used.some(Boolean)) this.taskConfig.used = [0, 1, 2, 3].map(h => file.plan.tools.some(t => this.taskConfig.map[t] === h));
    this.reprint = clone(this.taskConfig);
    this.machine = { main: 1, action: 0 };
    this.excludeObject = { objects: clone(file.plan.objectList), excluded: [], current: null };
    Object.assign(this.stats, {
      state: "printing", filename: name, fileSize: file.content.length, isActive: true,
      filePath: "/home/lava/printer_data/gcodes/" + name, exception: null, message: ""
    });
    // The job: a list of segments, one per (layer, tool), printed in order.
    // [guess] every tool the file uses prints on every layer, in tool order:
    // only the start and end of a file are read, not its tool changes.
    const segments = [];
    for (let l = 1; l <= file.plan.layers; l++) {
      for (const t of file.plan.tools) segments.push({ layer: l, tool: t, seconds: file.plan.secondsPerLayer / file.plan.tools.length });
    }
    this.job = {
      plan: file.plan, segments, seg: 0, segElapsed: 0, elapsed: 0,
      total: file.plan.layers * file.plan.secondsPerLayer,
      // Start G-code [guess for every duration]: home, heat, then optional
      // bed levelling and flow calibration, while already "printing".
      prepare: 15 + (this.taskConfig.bedLevel ? 60 : 0) + (this.taskConfig.flowCalibrate ? 30 * this.taskConfig.flowCalibExtruders.filter(Boolean).length : 0),
      prepared: 0
    };
    this.homed = "xyz";
    this.bed.target = file.plan.bedTemp;
    const firstHead = this.taskConfig.map[segments[0].tool];
    this.pickHead(firstHead);
    this.heads[firstHead].target = this.nozzleOf(file.plan, segments[0].tool);
  }

  // [source][live] pause_resume.py: refused only by a message, not an error
  // (HTTP 200) — "!! Cannot pause while not printing", or "!! Print already
  // paused" when paused. "paused" at once; ~3s later hot heads go to 40°C and
  // the part fan stops. The head stays picked. Targets are kept for RESUME.
  pause() {
    if (this.stats.state !== "printing") return;
    this.stats.state = "paused";
    this.stats.isActive = false;
    this.stats.paused = true;
    this.job.savedTargets = this.heads.map(h => h.target);
    this.later({ after: PAUSE_COOL_DELAY }, () => {
      if (this.stats.state !== "paused") return;
      for (const h of this.heads) if (h.target > 0) h.target = PAUSE_TEMP;
      this.fanSpeed = 0;
    });
  }

  // [live] Yellow: targets go back, machine_state_manager.action_code is 130
  // (PRINT_RESUMING) and print_stats stays "paused" while the head reheats and
  // ~13s after; then "printing", and only then does the request return.
  resume() {
    if (this.stats.state !== "paused") throw new GcodeError(`!! Cannot resume while not paused: ${this.stats.state}`);
    if (this.machine.main !== 1 || this.machine.action !== 0) throw new GcodeError("[guess] resume refused: machine state");
    this.job.savedTargets.forEach((t, i) => { this.heads[i].target = t; });
    this.machine.action = 130;
    const head = this.heads[this.activeHead];
    this.later({
      until: () => head.temp >= head.target - 5,
      skip: () => { for (const h of this.heads) if (h.target > 0 && h.temp < h.target) h.temp = h.target; }
    }, () => this.later({ after: RESUME_AFTER_HEAT }, () => {
      this.machine.action = 0;
      this.stats.state = "printing";
      this.stats.isActive = true;
      this.stats.paused = false;
    }));
  }

  // [source][live] CANCEL_PRINT: "cancelled" at once, machine state idle, the
  // file cleared; ~9s later heaters and part fan off and homing cleared. The
  // head is NOT parked (PRINT_END parks, cancel does not).
  cancel() {
    if (!this.printing()) return; // [guess] CANCEL_PRINT when idle just runs the macro harmlessly
    this.pending = []; // a resume or tool change still running never finishes
    this.finishJob("cancelled", { cleanUp: false });
    this.stats.filePosition = 0;
    this.stats.fileSize = 0;
    this.stats.filePath = null;
    this.later({ after: CANCEL_CLEANUP_DELAY }, () => {
      this.heatersOff();
      this.fanSpeed = 0;
      this.homed = "";
    });
  }

  // [source] SDCARD_RESET_FILE: back to standby, no cancel bookkeeping.
  resetFile() {
    this.job = null;
    this.stats = this.freshStats();
  }

  // cleanUp: turn the heaters and part fan off now (cancel does it later).
  finishJob(status, { cleanUp = true } = {}) {
    const s = this.stats;
    s.state = status;
    s.isActive = false;
    s.paused = false;
    if (cleanUp) {
      this.heatersOff();
      this.fanSpeed = 0;
    }
    this.machine = { main: 0, action: 0 };
    this.excludeObject.current = null;
    this.history.push({
      job_id: String(this.history.length + 1).padStart(6, "0"), user: "No User", filename: s.filename,
      // Real UNIX times, as Moonraker records them. In "fast" timing the
      // durations are simulated time and can exceed this wall-clock span.
      status: status === "complete" ? "completed" : status, start_time: this.jobStartedAt || Date.now() / 1000, end_time: Date.now() / 1000,
      print_duration: s.printDuration, total_duration: s.totalDuration, filament_used: s.filamentUsed,
      auxiliary_data: [], exists: true, metadata: (this.files.gcodes.get(s.filename) || {}).metadata || {}
    });
    this.resetPrintInfo();
    this.job = null;
  }

  // [source][live] PRINT_END: the last head parks; ~4s later the bed and every
  // head are set to 0 and homing is cleared, and in the same moment the job is
  // "complete" with no file, the machine idle and the map reset.
  complete() {
    this.parkAll();
    this.job.ending = true;
    this.later({ after: TOOL_CHANGE_SECONDS }, () => {
      this.homed = "";
      this.stats.progress = 1;
      this.stats.filePosition = this.stats.fileSize;
      this.stats.filePath = null;
      this.finishJob("complete");
    });
  }

  // ---- faults ----
  // [source] M112 → Klippy shutdown. print_stats is not reset: the job fields
  // freeze [live on a Creality, not observed on a U1].
  emergencyStop() {
    this.gcodeLog.push("M112");
    this.shutdown("Shutdown due to M112 command");
  }
  shutdown(message) {
    this.klippy = { state: "shutdown", message };
    this.machine = { main: 7, action: 0 }; // [source] ABNORMAL
    this.dropPending();
    for (const h of this.heads) h.target = 0;
    this.bed.target = 0;
    if (this.stats.isActive) this.stats.isActive = false;
    this.changed();
  }
  // FIRMWARE_RESTART / Klippy coming back: a fresh Klipper, job state reset.
  restart() {
    this.klippy = { state: "ready", message: "Printer is ready" };
    this.machine = { main: 0, action: 0 };
    this.dropPending();
    this.job = null;
    this.stats = this.freshStats();
    this.parkAll();
    this.homed = "";
    this.changed();
  }
  // A coded print error raised by the file [source]: "pause" actions pause
  // the job with the error in print_stats; anything else ends it in "error".
  printError({ level = 2, id = 523, index = 0, code = 0, message = "simulated fault", action = "pause" } = {}) {
    this.stats.exception = { id, index, code, message, level };
    this.stats.message = JSON.stringify({ coded: [level, id, index, code].map(n => String(n).padStart(4, "0")).join("-"), msg: message, action });
    if (action === "pause") this.pause();
    else this.finishJob("error");
    this.changed();
  }
  // [source] filament runout on head i: sensor false, exception 523/i/0, pause.
  runout(head) {
    this.heads[head].filament.present = false;
    this.printError({ level: 2, id: 523, index: head, code: 0, message: `e${head}_filament runout`, action: "pause" });
  }

  // ---- time ----
  advance(seconds, step = 1) {
    for (let t = 0; t < seconds; t += step) this.tick(Math.min(step, seconds - t));
    this.changed();
  }

  tick(dt) {
    this.time += dt;
    const approach = (cur, target, up, down) => (this.instantHeat ? (target > 0 ? target : AMBIENT)
      : target > cur ? Math.min(target, cur + up * dt) : Math.max(target > 0 ? target : AMBIENT, cur - down * dt));
    for (const h of this.heads) {
      h.temp = approach(h.temp, h.target, HEAT_RATE, COOL_RATE);
      h.power = h.target > 0 ? (h.temp < h.target ? 1 : 0.35) : 0;
    }
    this.bed.temp = approach(this.bed.temp, this.bed.target, BED_RATE, BED_RATE);
    if (this.klippy.state !== "ready") return;
    this.runPending();
    if (this.stats.state !== "printing" || !this.job || this.job.ending) return;

    // The print's own time: dt, or more with printSpeed (see the top).
    dt *= this.printSpeed;
    this.stats.totalDuration += dt;
    // A tick can run through several short segments: the time left over
    // after one goes to the next.
    let left = dt;
    while (left > 1e-9 && this.job && !this.job.ending) left = this.printFor(left);
  }

  // Prints for up to dt seconds of print time; returns the time not used
  // (0 while waiting: heating, the start sequence, a tool change).
  printFor(dt) {
    const s = this.stats, job = this.job;
    // Nothing prints until the active head and the bed are at temperature.
    const head = this.heads[this.activeHead];
    const hot = head.target > 0 && (this.instantHeat || (head.temp >= head.target - 5 && this.bed.temp >= this.bed.target - 2));
    if (job.prepared < job.prepare) { if (hot) job.prepared += dt; return 0; }
    if (!hot || job.changing) return 0;

    if (s.totalLayers == null) s.totalLayers = job.plan.layers;
    const seg = job.segments[job.seg];
    const step = Math.min(dt, seg.seconds - job.segElapsed);
    s.layer = seg.layer;
    this.excludeObject.current = this.excludeObject.objects.length
      ? this.excludeObject.objects[(seg.layer - 1) % this.excludeObject.objects.length].name : null;
    s.printDuration += step;
    s.filamentUsed += FILAMENT_MM_PER_S * step;
    this.fanSpeed = seg.layer > 1 ? 1 : 0;
    job.segElapsed += step;
    job.elapsed += step;
    s.progress = Math.min(0.999, job.elapsed / job.total);
    s.filePosition = Math.floor(s.progress * s.fileSize);

    // Before a tool change the next head heats (the file's preheat_time), and
    // the head being left drops to standby shortly before it parks.
    const next = job.segments[job.seg + 1];
    if (next) {
      const nextHead = this.taskConfig.map[next.tool];
      const remaining = seg.seconds - job.segElapsed;
      if (nextHead !== this.activeHead) {
        if (job.plan.oozePrevention && remaining <= job.plan.preheatTime) this.heads[nextHead].target = this.nozzleOf(job.plan, next.tool);
        if (remaining <= STANDBY_LEAD_SECONDS) this.heads[this.activeHead].target = this.standbyOf(job.plan, seg.tool);
      }
    }
    if (job.segElapsed < seg.seconds - 1e-9) return 0;

    job.seg++;
    job.segElapsed = 0;
    if (job.seg >= job.segments.length) { this.complete(); return 0; }
    const nextHead = this.taskConfig.map[job.segments[job.seg].tool];
    if (nextHead !== this.activeHead) {
      // [live: Yellow] The head left waits at standby until the job ends.
      // The change takes ~4s: the old head parks and the part fan stops; no
      // head is picked until the new one is, and toolhead.extruder keeps
      // naming the old head until then.
      this.heads[this.activeHead].target = this.standbyOf(job.plan, seg.tool);
      this.heads[nextHead].target = this.nozzleOf(job.plan, job.segments[job.seg].tool);
      this.heads[this.activeHead].state = "PARKED";
      this.fanSpeed = 0;
      job.changing = true;
      this.later({ after: TOOL_CHANGE_SECONDS }, () => {
        job.changing = false;
        this.pickHead(nextHead);
      });
    }
    return dt - step;
  }

  // ---- status: the Klipper objects, as printer.objects.query returns them ----
  // Builds every object from the idle capture, then overlays what the model
  // drives. Field names and types are the capture's; the drift test checks it.
  status() {
    const st = clone(this.baseStatus);
    const s = this.stats;
    const r1 = v => Math.round(v * 10) / 10;

    st.webhooks = { state: this.klippy.state, state_message: this.klippy.message };
    st.print_stats = {
      ...st.print_stats,
      filename: s.filename, total_duration: s.totalDuration, print_duration: s.printDuration,
      filament_used: s.filamentUsed, state: s.state, exception: s.exception || {}, message: s.message,
      info: { total_layer: s.totalLayers, current_layer: s.layer }
    };
    st.virtual_sdcard = { ...st.virtual_sdcard, file_path: s.filePath, progress: s.progress, is_active: s.isActive, file_position: s.filePosition, file_size: s.fileSize };
    st.display_status = { ...st.display_status, progress: Math.floor(s.progress * 100) / 100, message: null };
    st.pause_resume = { ...st.pause_resume, is_paused: s.paused };
    st.idle_timeout = { ...st.idle_timeout, state: s.state === "printing" ? "Printing" : "Ready" };
    st.machine_state_manager = { ...st.machine_state_manager, main_state: this.machine.main, action_code: this.machine.action };
    st.heater_bed = { ...st.heater_bed, temperature: r1(this.bed.temp), target: this.bed.target, power: this.bed.target > 0 ? 0.5 : 0 };

    const active = this.heads.filter(h => h.state === "ACTIVATE");
    const stats = active.length === 1 ? [EXT[this.heads.indexOf(active[0])], 0] : active.length === 0 ? [EXT[this.activeHead], 1] : ["unknown extruder", 2];
    this.heads.forEach((h, i) => {
      const on = h.state === "ACTIVATE";
      st[EXT[i]] = {
        ...st[EXT[i]],
        temperature: r1(h.temp), target: h.target, power: h.power,
        state: h.state, park_pin: !on, active_pin: on, grab_valid_pin: on, can_extrude: on && h.temp >= 170,
        real_extruder_stats: stats, switch_count: h.switchCount, extruder_offset: h.offset
      };
      const sensor = `filament_motion_sensor e${i}_filament`;
      if (st[sensor]) st[sensor] = { ...st[sensor], filament_detected: h.filament.present };
      const [module, key] = FEEDER[i];
      const feed = st["filament_feed " + module];
      if (feed && feed[key]) {
        feed[key] = { ...feed[key], filament_detected: h.filament.present,
          channel_state: h.filament.present ? "load_finish" : "wait_insert",
          channel_action_state: h.filament.present ? "load_finish" : "unload_finish" };
      }
      const fanName = i === 0 ? "fan" : `fan_generic e${i}_fan`;
      if (st[fanName] && i !== this.activeHead) st[fanName] = { ...st[fanName], speed: 0 };
    });
    // [live] `fan` follows the active head's own part fan.
    const activeFan = this.activeHead === 0 ? "fan" : `fan_generic e${this.activeHead}_fan`;
    if (st[activeFan]) st[activeFan] = { ...st[activeFan], speed: this.fanSpeed };
    st.fan = { ...st.fan, speed: this.fanSpeed, rpm: this.fanSpeed ? 8600 : 0 };
    st.toolhead = { ...st.toolhead, extruder: EXT[this.activeHead], homed_axes: this.homed };
    st.gcode_move = { ...st.gcode_move, homing_origin: [...this.heads[this.activeHead].offset, 0] };

    const tc = this.taskConfig, f = this.heads.map(h => h.filament);
    st.print_task_config = {
      ...st.print_task_config,
      filament_vendor: f.map(x => x.vendor), filament_type: f.map(x => x.type), filament_sub_type: f.map(x => x.sub),
      filament_color: f.map(x => argb(x.rgba)), filament_color_rgba: f.map(x => x.rgba),
      filament_official: f.map(x => x.official), filament_sku: f.map(x => x.sku),
      // [source] recomputed on every read: exist from the sensors, edit = exist && !official.
      filament_exist: f.map(x => x.present), filament_edit: f.map(x => x.present && !x.official),
      extruder_map_table: tc.map.slice(), extruders_used: tc.used.slice(),
      auto_bed_leveling: tc.bedLevel, flow_calibrate: tc.flowCalibrate, time_lapse_camera: tc.timelapse,
      flow_calib_extruders: tc.flowCalibExtruders.slice(),
      reprint_info: {
        ...(st.print_task_config || {}).reprint_info,
        auto_bed_leveling: this.reprint.bedLevel, flow_calibrate: this.reprint.flowCalibrate,
        time_lapse_camera: this.reprint.timelapse, flow_calib_extruders: this.reprint.flowCalibExtruders.slice(),
        extruder_map_table: this.reprint.map.slice(), extruders_used: this.reprint.used.slice()
      }
    };
    st.exclude_object = { ...st.exclude_object, objects: clone(this.excludeObject.objects), excluded_objects: this.excludeObject.excluded.slice(), current_object: this.excludeObject.current };
    return st;
  }

  // printer.objects.query semantics: each requested object, all fields or the
  // listed ones; objects the printer doesn't have are left out [source moonraker].
  query(request) {
    const all = this.status();
    const out = {};
    for (const [name, fields] of Object.entries(request)) {
      if (!(name in all)) continue;
      if (!Array.isArray(fields) || !fields.length) { out[name] = all[name]; continue; }
      out[name] = {};
      for (const f of fields) if (f in all[name]) out[name][f] = all[name][f];
    }
    return out;
  }
}

module.exports = { VirtualU1, GcodeError, availableFirmware, loadCapture, parseLine, EXT };
