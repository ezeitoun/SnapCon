// connectors/klipper-moonraker.js — generic, stock Klipper via vanilla
// Moonraker. No brand-specific macros, no multi-toolhead filament tracking,
// no camera plugin — just what any Klipper/Moonraker box supports out of the
// box. Printers are added manually by IP (no discovery signature to key off).
const http = require("./http-utils");

exports.label = "Klipper (Moonraker)";
exports.capabilities = {
  camera: false, filamentHeads: false, excludeObject: true, autoLevel: false,
  unloadFilament: false, firmwareInfo: true, inventory: false, discovery: false,
  // Generic Klipper/Moonraker installs commonly proxy Fluidd or Mainsail on
  // the same host — a reasonable default, though a bare Moonraker-only setup
  // with no frontend installed would have nothing to actually show here.
  webUi: true, setColor: false, singleToolhead: false
};

// ---- Fleet status ----
// Same shape as every connector's probe(), but no print_task_config query
// (no filament-head tracking on stock Klipper) and no structured error
// decoding (that's a Snapmaker-only print_stats.message convention) — just
// the plain text Klipper already puts in print_stats.message.
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

// ---- Print control (stock Klipper — identical text to snapmaker-u1-klipper) ----
exports.uploadFile = http.uploadFile;
exports.startPrintFile = http.startPrintFile;
exports.pause = http.pause;
exports.resume = http.resume;
exports.cancel = http.cancel;
exports.eject = http.eject;
exports.estop = http.estop;
exports.bedTemp = http.bedTemp;
// No applyHeadMapping, no unloadFilament — no head-mapping macros or AUTO_FEEDING
// exist on stock Klipper.

// ---- Exclude-object (stock Klipper module) ----
exports.getPlate = http.getPlate;
exports.excludeObject = http.excludeObject;

// ---- File management (stock Moonraker) ----
exports.listFiles = http.listFiles;
exports.getThumbnail = http.getThumbnail;
exports.getFileMetadata = http.getFileMetadata;

// ---- Firmware (generic Moonraker query) ----
exports.getFirmwareInfo = http.queryFirmwareInfo;

// No getCameraSnapshot, no getInventory, no discoverAt — none of these exist
// on vanilla Moonraker without a brand-specific plugin/product_info block.
