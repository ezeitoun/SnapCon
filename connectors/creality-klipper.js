// connectors/creality-klipper.js — Creality K1 / K1C / K1 Max / K1 SE / Hi /
// K2 series, all genuine forks of stock Klipper3d/klipper (confirmed from
// source: klippy/ core is unmodified). K1/K1C/K1 Max/K1 SE/Hi have no
// multi-color hardware at all — plain single-extruder Klipper. K2 adds a
// [box] module (their CFS multi-color system, gcode macros
// BOX_LOAD_MATERIAL_WITH_MATERIAL / BOX_CHECK_MATERIAL / BOX_QUIT_MATERIAL /
// BOX_INFO_REFRESH) but its logic is compiled into a closed-source
// box_wrapper.cpython-39.so, so the exact printer/objects/query?box JSON
// shape isn't known yet — filamentHeads/unloadFilament stay unimplemented
// here until that's captured from a real K2 (or documented) and probe()/
// applyHeadMapping/unloadFilament get K2-specific bodies added.
//
// PAUSE/RESUME/CANCEL_PRINT are wrapped on-printer via Klipper's
// `rename_existing: *_BASE` pattern (adds parking/fan/temp-recovery
// behavior) but keep their stock macro names, and SDCARD_PRINT_FILE is
// untouched — confirmed from K2's gcode_macro.cfg — so every function below
// (identical to klipper-moonraker.js) works correctly across the whole line
// with zero Creality-specific gcode needed.
const http = require("./http-utils");

exports.label = "Creality (K1 / K2 / Hi)";
exports.capabilities = {
  camera: false, filamentHeads: false, excludeObject: true, autoLevel: false,
  unloadFilament: false, firmwareInfo: true, inventory: false, discovery: true,
  // Confirmed live against a real Ender-3 V3 Plus: it serves its own
  // proprietary web UI (title "Creality", not actually Fluidd/Mainsail) on
  // the same host/port as Moonraker — a real dashboard either way.
  webUi: true, setColor: false, singleToolhead: false
};

// ---- Fleet status ----
// Same stock-Klipper query as klipper-moonraker.js — no [box] fields read
// yet (see file header). Kept as its own copy (not a re-export from
// klipper-moonraker.js) so this connector stays independently editable when
// K2 CFS support lands, without touching another brand's file.
async function probe(p) {
  const url = http.baseUrl(p) + "/printer/objects/query?print_stats&display_status&virtual_sdcard&heater_bed&extruder&fan&gcode_move&toolhead&exclude_object";
  try {
    const { ok, status, json: j } = await http.fetchJSONTimeout(url, 3500);
    if (!ok) return { name: p.name, online: false, error: "HTTP " + status };
    const st = (j.result && j.result.status) || {};
    const ps = st.print_stats || {};
    const ds = st.display_status || {};
    const hb = st.heater_bed || {};
    const ext = st.extruder || {};
    const hotend = (typeof ext.temperature === "number")
      ? { temp: Math.round(ext.temperature), target: Math.round(ext.target || 0) }
      : null;
    const th = st.toolhead || {};
    const activeExt = typeof th.extruder === "string" ? parseInt(th.extruder.replace("extruder", "") || "0", 10) : null;
    const fan = st.fan || {};
    const gm = st.gcode_move || {};
    const psi = ps.info || {};
    const eo = st.exclude_object || {};
    const plate = (eo.objects && eo.objects.length)
      ? { total: eo.objects.length, excluded: (eo.excluded_objects || []).length, current: eo.current_object || null }
      : null;
    return {
      name: p.name, online: true,
      state: ps.state || "unknown",
      message: ps.message || "",
      errorCode: "",
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
      heads: []
    };
  } catch (e) {
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}
exports.probe = probe;

// ---- Print control (stock Klipper macro names — Creality's on-printer
// PAUSE/RESUME/CANCEL_PRINT wrapping is transparent to Moonraker callers) ----
exports.uploadFile = http.uploadFile;
exports.startPrintFile = http.startPrintFile;
exports.pause = http.pause;
exports.resume = http.resume;
exports.cancel = http.cancel;
exports.eject = http.eject;
exports.estop = http.estop;
exports.bedTemp = http.bedTemp;
// No applyHeadMapping, no unloadFilament — that's the K2 CFS gap noted above.

// ---- Exclude-object (stock Klipper module) ----
exports.getPlate = http.getPlate;
exports.excludeObject = http.excludeObject;

// ---- File management (stock Moonraker) ----
exports.listFiles = http.listFiles;
exports.getThumbnail = http.getThumbnail;
exports.getFileMetadata = http.getFileMetadata;

// ---- Firmware (generic Moonraker query) ----
exports.getFirmwareInfo = http.queryFirmwareInfo;

// No getCameraSnapshot, no getInventory — camera is a closed-source shell
// capture utility (not Moonraker's webcam component, see photograph.py), and
// there's no genuine per-unit serial number exposed anywhere: confirmed live
// against a real printer that `machine/system_info`'s cpu_info.serial_number
// is blank, and sd_info.serial_number is the SD CARD's serial (changes if
// the card is swapped, not a printer identity). A factory EEPROM ([bl24c16f]
// in factory_printer.cfg) may hold one, but there's no documented Moonraker
// endpoint/macro that reads it back out.
//
// Discovery: single cheap call, matching snapmaker's discoverAt's cost
// profile (one HTTP request per candidate IP during a subnet scan). Creality
// bakes the product line into the embedded Linux hostname — confirmed live
// against a real "Ender-3 V3 Plus" reporting hostname "Ender-3". This is a
// best-effort heuristic, not a hard fingerprint: a user-renamed hostname
// defeats it, and it can't distinguish sub-variants (e.g. "V3 Plus" vs
// "SE"/"KE" — those only showed up in that same printer's build-volume
// macro variables and factory_printer.cfg's header comment, both far more
// expensive to fetch for every candidate IP in a subnet scan, so they're
// left as a manual follow-up rather than baked into discovery).
async function discoverAt(base) {
  const { ok, json } = await http.fetchJSONTimeout(`${base}/printer/info`, 900);
  if (!ok) return null;
  const hostname = (json.result || {}).hostname || "";
  if (!/^(ender|cr-?\d|k1|k2|creality)/i.test(hostname)) return null;
  return { url: base, device_name: hostname, machine_type: hostname, serial: null, mac: null };
}
exports.discoverAt = discoverAt;
