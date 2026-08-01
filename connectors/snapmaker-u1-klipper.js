// connectors/snapmaker-u1-klipper.js — Snapmaker U1 running its stock
// ("vanilla") firmware, a Moonraker fork with U1-specific extras layered on
// top of stock Klipper: 4-toolhead print_task_config (filament/color state),
// structured error codes, print-preference/head-mapping macros, a camera
// plugin RPC, and product_info/serial fields not present on vanilla Moonraker.
const http = require("./http-utils");

exports.label = "SnapMaker (U1-Klipper)";
exports.brand = "SnapMaker";
exports.capabilities = {
  camera: true, filamentHeads: true, excludeObject: true, autoLevel: true,
  unloadFilament: true, firmwareInfo: true, inventory: true, discovery: true,
  // SET_PRINT_FILAMENT_CONFIG (see setFilamentColor below) really does write
  // filament_color_rgba back to the printer — the same command the
  // touchscreen itself issues. Verified against dlgambill/u1hub (the
  // project this codebase forked from), whose implementation was checked
  // against real U1 hardware.
  webUi: true, setColor: true, singleToolhead: false,
  // filamentHeads means "show per-slot status" (colors/materials/active
  // lane); headMapping means "assigning a model color to a slot in the
  // print/send UI actually does something" — only true here because
  // applyHeadMapping below really sends that assignment to the printer.
  // Kept as a separate flag since a connector can have the former without
  // the latter (Creality's CFS: real status, no confirmed print-start
  // slot-selection mechanism to apply a mapping through).
  headMapping: true,
  // Per-print options sent via SET_PRINT_PREFERENCES (see applyHeadMapping) —
  // real, registered U1 firmware parameters (print_task_config.py), not a
  // guess: BED_LEVEL/FLOW_CALIBRATE/TIME_LAPSE_CAMERA are each an optional
  // 0/1 int stored into that print's task config and acted on at print start.
  flowCalibration: true, timelapse: true,
  // print_task_config.py's SET_PRINT_PREFERENCES also takes a real
  // FLOW_CALIBRATE_EXTRUDERS='0,2' parameter (confirmed against the actual
  // Snapmaker/u1-klipper source) restricting which of the 4 physical
  // extruders get calibrated — the firmware's own flow_calib_extruders
  // config field defaults to all four, this just lets a job narrow it down
  // (e.g. only the one toolhead whose filament was just swapped). Not
  // confirmed for any other connector, so this is its own flag rather than
  // implied by flowCalibration.
  flowCalibrationPerExtruder: true,
  // Stock U1 firmware rejects a bed target above 100°C.
  maxBedTemp: 100
};

// ---- Fleet status ----
// Colors come from print_task_config (the touchscreen-assigned filament, which
// persists with the physical spools until unloaded). filament_detect was wrong:
// it only reports RFID-tagged official spools, so third-party heads read blank.
function decodeHeads(ptc) {
  const ex   = ptc.filament_exist || [];
  const rgba = ptc.filament_color_rgba || [];
  const typ  = ptc.filament_type || [];
  const sub  = ptc.filament_sub_type || [];
  const off  = ptc.filament_official || [];
  return [0, 1, 2, 3].map(i => {
    const loaded = !!ex[i];
    let hex = null;
    if (loaded && rgba[i]) {
      const m = /^#?([0-9a-fA-F]{6})/.exec(rgba[i]);
      if (m) hex = "#" + m[1].toUpperCase();
    }
    return {
      loaded,
      hex,
      material: loaded ? (typ[i] || null) : null,
      sub: (loaded && sub[i] && sub[i] !== "NONE") ? sub[i] : null,
      official: !!off[i]
    };
  });
}

async function probe(p) {
  const url = http.baseUrl(p) + "/printer/objects/query?print_task_config&print_stats&display_status&virtual_sdcard&heater_bed&extruder&extruder1&extruder2&extruder3&fan&gcode_move&toolhead&exclude_object";
  try {
    const { ok, status, json: j } = await http.fetchJSONTimeout(url, 3500);
    if (!ok) return { name: p.name, online: false, error: "HTTP " + status };
    const st = (j.result && j.result.status) || {};
    const ptc = st.print_task_config || {};
    const heads = decodeHeads(ptc);
    const ps = st.print_stats || {};
    const ds = st.display_status || {};
    const hb = st.heater_bed || {};
    const extKeys = ["extruder", "extruder1", "extruder2", "extruder3"];
    let hotend = null;
    for (const k of extKeys) {
      const e = st[k];
      if (e && typeof e.temperature === "number" && e.target > 80 && (e.temperature - e.target) <= 5) {
        // Whole degrees only (the UI never shows finer) — sensor jitter would
        // otherwise make every fleet payload unique and defeat the client's
        // skip-render-when-unchanged check.
        hotend = { temp: Math.round(e.temperature), target: Math.round(e.target) };
        break;
      }
    }
    const th = st.toolhead || {};
    const activeExt = typeof th.extruder === "string" ? parseInt(th.extruder.replace("extruder", "") || "0", 10) : null;
    const fan = st.fan || {};
    const gm = st.gcode_move || {};
    const psi = ps.info || {};
    const eo = st.exclude_object || {};
    const plate = (eo.objects && eo.objects.length)
      ? { total: eo.objects.length, excluded: (eo.excluded_objects || []).length, current: eo.current_object || null }
      : null;
    // Decode Snapmaker structured error from print_stats.exception / print_stats.message (JSON)
    let errorCode = "", errorMsg = "";
    if (ps.exception && typeof ps.exception === "object") {
      const { level = 0, id = 0, index = 0, code = 0, message: exMsg = "" } = ps.exception;
      const candidate = [level, id, index, code].map(n => String(n).padStart(4, "0")).join("-");
      if (candidate !== "0000-0000-0000-0000") { errorCode = candidate; errorMsg = exMsg; }
    } else if (ps.message) {
      try {
        const parsed = JSON.parse(ps.message);
        if (parsed.coded) errorCode = parsed.coded.split("-").map(g => g.trim().padStart(4, "0")).join("-");
        if (parsed.msg) errorMsg = parsed.msg;
      } catch { errorMsg = ps.message; }
    }
    return {
      name: p.name, online: true,
      state: ps.state || "unknown",
      message: errorMsg,
      errorCode,
      filename: ps.filename || "",
      progress: typeof (st.virtual_sdcard || {}).progress === "number" ? st.virtual_sdcard.progress : (typeof ds.progress === "number" ? ds.progress : 0),
      elapsed: typeof ps.print_duration === "number" ? ps.print_duration : null,
      filamentUsed: typeof ps.filament_used === "number" ? ps.filament_used : null,
      bed: (typeof hb.temperature === "number") ? { temp: Math.round(hb.temperature), target: Math.round(hb.target || 0) } : null,
      hotend,
      layer: (psi.current_layer != null) ? { current: psi.current_layer, total: psi.total_layer || 0 } : null,
      speed: (typeof gm.speed_factor === "number") ? Math.round(gm.speed_factor * 100) : null,
      fanPct: (typeof fan.speed === "number") ? Math.round(fan.speed * 100) : null,
      activeExt,
      plate,
      heads
    };
  } catch (e) {
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}
exports.probe = probe;

// ---- Print control ----
exports.uploadFile = http.uploadFile;
exports.startPrintFile = http.startPrintFile;
exports.pause = http.pause;
exports.resume = http.resume;
exports.cancel = http.cancel;
exports.eject = http.eject;
exports.estop = http.estop;
exports.bedTemp = http.bedTemp;

// Toolhead/color mapping + print preferences (auto-level, flow-calibrate,
// timelapse) — U1-only macros, sent once before a print starts. Called even
// when `tools` is empty (no color mapping to apply) so the preferences line
// still goes out; only the extruder-map macros are conditional on there
// actually being a mapping (SET_PRINT_USED_EXTRUDERS with an empty EXTRUDERS=
// list isn't a meaningful thing to send).
//
// `prefs` (optional): { autoLevel, flowCalibrate, timelapse } booleans from
// the per-job checkboxes (pfilemodal in app.js — an explicit choice for one
// print) or a bulk send (sendmodal — always sends explicit values, since
// there's no single target printer's default to fall back to). Any field
// left undefined here falls back to that printer's own configured default
// (Settings > printer > Behavior: Auto-level / Flow calibration / Time-lapse).
function withPrefFallback(prefValue, printerDefault) {
  return prefValue !== undefined ? !!prefValue : !!printerDefault;
}
async function applyHeadMapping(p, tools, map, prefs = {}) {
  const lines = tools.map(t => `SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=${t} MAP_EXTRUDER=${map[t]}`);
  if (tools.length) {
    const usedHeads = [...new Set(tools.map(t => map[t]))];
    lines.push("SET_PRINT_USED_EXTRUDERS EXTRUDERS=" + usedHeads.join(","));
  }
  const bedLevel = withPrefFallback(prefs.autoLevel, p.autoLevel);
  const flowCalibrate = withPrefFallback(prefs.flowCalibrate, p.flowCalibrate);
  const timelapse = withPrefFallback(prefs.timelapse, p.timelapse);
  let prefsLine = "SET_PRINT_PREFERENCES BED_LEVEL=" + (bedLevel ? "1" : "0") +
    " FLOW_CALIBRATE=" + (flowCalibrate ? "1" : "0") +
    " TIME_LAPSE_CAMERA=" + (timelapse ? "1" : "0");
  // FLOW_CALIBRATE_EXTRUDERS restricts calibration to specific physical
  // extruders (0-3) — irrelevant, and omitted, unless flow calibration is
  // actually on for this print. No entry (or an empty list) means "leave the
  // firmware's own flow_calib_extruders as-is" (defaults to all four), same
  // as never having sent the parameter at all.
  if (flowCalibrate && Array.isArray(prefs.flowCalibrateExtruders)) {
    const idxs = [...new Set(prefs.flowCalibrateExtruders.map(n => parseInt(n, 10)).filter(n => n >= 0 && n <= 3))];
    if (idxs.length) prefsLine += " FLOW_CALIBRATE_EXTRUDERS='" + idxs.join(",") + "'";
  }
  lines.push(prefsLine);
  await http.sendGcode(p, lines.join("\n"));
}
exports.applyHeadMapping = applyHeadMapping;

async function unloadFilament(p, extruders) {
  for (const e of extruders) {
    await http.sendGcode(p, "AUTO_FEEDING EXTRUDER=" + parseInt(e, 10) + " UNLOAD=1");
  }
}
exports.unloadFilament = unloadFilament;

// ---- Set a slot's stored color on the printer itself ----
// SET_PRINT_FILAMENT_CONFIG is a real, registered print_task_config.py
// gcode command — the exact one the touchscreen itself issues — confirmed
// against dlgambill/u1hub's implementation (this codebase's origin), which
// was checked against real hardware. Deliberately mirrors that
// implementation closely rather than reinventing it:
//  - idle-only: the firmware has no documented "change color mid-print"
//    story, and there's no reason to risk finding out live.
//  - a slot with nothing loaded has no color to correct.
//  - an official Snapmaker RFID spool's color comes from the tag itself —
//    firmware refuses this write outright unless FORCE=1 is also passed,
//    which u1hub deliberately never does (forcing it also flips that slot's
//    filament_official to false). This does the same: block, don't bypass.
//  - after sending, re-query and confirm the printer actually reports back
//    the value just sent — SAVE='1' on the gcode line is what u1hub's own
//    real-hardware testing settled on for this to stick.
async function setFilamentColor(p, ext, hex) {
  const slot = parseInt(ext, 10);
  if (!(slot >= 0 && slot <= 3)) throw new Error("Slot must be 0–3");
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ""));
  if (!m) throw new Error("Color must be RRGGBB hex");
  const rgba = m[1].toUpperCase() + "FF";

  const { ok, status, json } = await http.fetchJSONTimeout(http.baseUrl(p) + "/printer/objects/query?print_stats&print_task_config", 3500);
  if (!ok) throw new Error("Moonraker " + status);
  const st = (json.result || {}).status || {};
  const state = (st.print_stats || {}).state || "unknown";
  if (state === "printing" || state === "paused") throw new Error("Printer is " + state + " — colors can only be changed while idle");
  const ptc = st.print_task_config || {};
  if (!(ptc.filament_exist || [])[slot]) throw new Error("No filament loaded in slot T" + (slot + 1));
  if ((ptc.filament_edit || [])[slot] === false) throw new Error("T" + (slot + 1) + " is an official Snapmaker RFID spool — its color comes from the tag and can't be changed");

  await http.sendGcode(p, `SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER='${slot}' FILAMENT_COLOR_RGBA='${rgba}' SAVE='1'`);

  const confirm = await http.fetchJSONTimeout(http.baseUrl(p) + "/printer/objects/query?print_task_config", 3500);
  if (!confirm.ok) throw new Error("Write sent but read-back failed: Moonraker " + confirm.status);
  const gotPtc = ((confirm.json.result || {}).status || {}).print_task_config || {};
  const got = (gotPtc.filament_color_rgba || [])[slot];
  if (String(got || "").toUpperCase() !== rgba) throw new Error("Write not confirmed — printer reports " + (got || "nothing"));
  return "#" + m[1].toUpperCase();
}
exports.setFilamentColor = setFilamentColor;

// ---- Exclude-object (stock Klipper module — identical to generic Klipper) ----
exports.getPlate = http.getPlate;
exports.excludeObject = http.excludeObject;

// ---- File management (stock Moonraker — identical to generic Klipper) ----
exports.listFiles = http.listFiles;
exports.getThumbnail = http.getThumbnail;
exports.getFileMetadata = http.getFileMetadata;

// ---- Firmware (generic Moonraker query, reused as-is) ----
exports.getFirmwareInfo = http.queryFirmwareInfo;

// ---- Camera: Snapmaker U1 monitor.jpg via Moonraker WebSocket RPC ----
// Mirrors the Python camera-proxy logic: start_monitor → fetch JPEG → idle
// stop_monitor. This start/stop-cooldown state machine is a quirk of
// Snapmaker's own camera plugin (it misbehaves if start_monitor is hammered),
// not a generic "camera" concept, so it lives entirely inside this connector —
// a future brand with a persistent RTSP/MJPEG stream wouldn't need anything
// like it. Keyed by p.url (not fleet array index, which server.js no longer
// threads through to connector calls).
const CAM_START_COOLDOWN = 5;   // seconds between repeated start_monitor calls
const CAM_IDLE_STOP      = 60;  // seconds of inactivity before stop_monitor
const camState = new Map();     // printer url -> { lastStart, lastRequest, stopTimer }

function getCamState(url) {
  if (!camState.has(url)) camState.set(url, { lastStart: 0, lastRequest: 0, stopTimer: null });
  return camState.get(url);
}

// Send a single JSON-RPC call over Moonraker's WebSocket then close immediately.
function cameraRpc(p, method, params = {}) {
  return new Promise(resolve => {
    if (typeof WebSocket === "undefined") return resolve(); // Node <21: skip silently
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const ip   = new URL(http.baseUrl(p)).hostname;
      const token = p.token || "";
      const wsUrl = `ws://${ip}/websocket${token ? "?token=" + encodeURIComponent(token) : ""}`;
      const ws   = new WebSocket(wsUrl);
      const payload = JSON.stringify({ id: Date.now(), jsonrpc: "2.0", method, params });
      const timer = setTimeout(() => { try { ws.close(); } catch {} finish(); }, 3000);
      ws.onopen    = () => ws.send(payload);
      ws.onmessage = () => { clearTimeout(timer); try { ws.close(); } catch {} finish(); };
      ws.onerror   = () => { clearTimeout(timer); finish(); };
      ws.onclose   = () => { clearTimeout(timer); finish(); };
    } catch { finish(); }
  });
}

async function ensureCameraRunning(printer) {
  const st     = getCamState(printer.url);
  const domain = printer.cameraDomain || "lan";
  const now    = Date.now() / 1000;

  if (now - st.lastStart >= CAM_START_COOLDOWN) {
    st.lastStart = now;
    await cameraRpc(printer, "camera.start_monitor", { domain, interval: 0 });
    // Give the camera a moment to capture and write the first frame
    await new Promise(r => setTimeout(r, 1200));
  }

  st.lastRequest = now;
  if (st.stopTimer) clearTimeout(st.stopTimer);
  st.stopTimer = setTimeout(async () => {
    st.stopTimer = null;
    await cameraRpc(printer, "camera.stop_monitor", { domain });
  }, CAM_IDLE_STOP * 1000);
}

// Grab one camera frame as a JPEG buffer. Throws with a user-showable message.
async function getCameraSnapshot(p) {
  await ensureCameraRunning(p);
  const snapUrl = http.baseUrl(p) + "/server/files/camera/monitor.jpg";
  let r = await http.fetchTimeout(snapUrl, 6000);
  // If still 404 after the initial wait, retry once after another second
  if (r.status === 404) {
    await new Promise(ok => setTimeout(ok, 1000));
    r = await http.fetchTimeout(snapUrl, 6000);
  }
  if (!r.ok) throw new Error("Camera HTTP " + r.status + " — is the camera connected?");
  return { contentType: "image/jpeg", buffer: Buffer.from(await r.arrayBuffer()) };
}
exports.getCameraSnapshot = getCameraSnapshot;

// ---- Network inventory: device name / IP / MAC / serial (Snapmaker/
// Moonraker-fork-specific product_info block, not vanilla Moonraker) ----
async function getInventory(p) {
  try {
    const { ok, status, json } = await http.fetchJSONTimeout(http.baseUrl(p) + "/machine/system_info", 3500);
    if (!ok) return { name: p.name, online: false, error: "HTTP " + status };
    const si = json.result.system_info || {};
    const pi = si.product_info || {};
    const { iface, mac, ip } = http.pickIface(si.network || {});
    return {
      name: p.name, online: true,
      device_name: pi.device_name || null,
      machine_type: pi.machine_type || null,
      serial: pi.serial_number || null,
      iface, mac, ip
    };
  } catch (e) {
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}
exports.getInventory = getInventory;

// ---- Discovery: subnet scan fingerprinting this connector's product_info
// shape. Module-level (no configured printer yet), used by /api/discover. ----
async function discoverAt(base) {
  const { ok, json } = await http.fetchJSONTimeout(`${base}/machine/system_info`, 900);
  if (!ok) return null;
  const si = (json.result || {}).system_info;
  if (!si) return null;
  const pi = si.product_info || {};
  const { mac } = http.pickIface(si.network || {});
  return { url: base, device_name: pi.device_name || null, machine_type: pi.machine_type || null, serial: pi.serial_number || null, mac };
}
exports.discoverAt = discoverAt;
