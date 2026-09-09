// connectors/klipper-moonraker.js — generic, stock Klipper via vanilla
// Moonraker. No brand-specific macros, no multi-toolhead filament tracking,
// no camera plugin — just what any Klipper/Moonraker box supports out of the
// box. Printers are added manually by IP (no discovery signature to key off).
const http = require("./http-utils");

exports.label = "Klipper (Moonraker)";
exports.brand = "Klipper";
// Address contract: vanilla Moonraker listens on 7125, but a box behind a
// reverse proxy can be anywhere, so the port is the user's to set.
exports.address = { scheme: "http", defaultPort: 7125, portEditable: true, required: true };
exports.capabilities = {
  camera: false, filamentHeads: false, excludeObject: true, autoLevel: false,
  unloadFilament: false, firmwareInfo: true, inventory: false, discovery: false, health: true, fileSync: true,
  // Generic Klipper/Moonraker installs commonly proxy Fluidd or Mainsail on
  // the same host — a reasonable default, though a bare Moonraker-only setup
  // with no frontend installed would have nothing to actually show here.
  webUi: true, setColor: false, singleToolhead: false,
  // Real hardware is unknown for a generic Klipper box — matches the
  // server's own hard ceiling on POST /api/bedtemp rather than guessing low.
  maxBedTemp: 120
};

// ---- Fleet status ----
// Same shape as every connector's probe(), but no print_task_config query
// (no filament-head tracking on stock Klipper) and no structured error
// decoding (that's a Snapmaker-only print_stats.message convention) — just
// the plain text Klipper already puts in print_stats.message.
async function probe(p) {
  const url = http.baseUrl(p) + "/printer/objects/query?print_stats&display_status&virtual_sdcard&heater_bed&extruder&fan&gcode_move&toolhead&exclude_object&webhooks";
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
    // Klippy machine health outranks everything below. webhooks rides the
    // same query (no extra request); http.klipperFault() is the one shared
    // rule -- see its comment for why a shutdown must beat a frozen
    // print_stats. Stale filename/progress are deliberately left on the
    // payload as diagnostics; suppressing the active-print UI is the
    // frontend's job, driven by message/errorCode.
    const fault = http.klipperFault(st);
    return {
      name: p.name, online: true,
      state: fault ? fault.state : (ps.state || "unknown"),
      message: fault ? fault.message : (ps.message || ""),
      errorCode: fault ? fault.errorCode : "",
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
// Ordinary print-control commands get an explicit bound, not moonrakerPost's
// 8s fast-command default. /printer/gcode/script BLOCKS until the script
// finishes, and CANCEL_PRINT runs the printer's whole end-of-print routine --
// park the toolhead, cut heaters, retract -- which routinely runs past 8s. The
// command lands and completes; SnapCon just gave up waiting and reported
// "did not respond within 8000ms" for a cancel that had actually worked.
// Reported live on a U1; measured on a SPARKX i7 where Moonraker accepted
// CANCEL_PRINT at 00:57:05 and Klipper executed it at 00:57:51.
//
// estop is the deliberate exception and stays on the short default: in a real
// emergency the operator needs to know FAST that the command is not landing,
// so they can pull power, rather than have SnapCon wait a minute hoping.
// Same value and same reasoning as creality-klipper.js, kept local to each
// connector rather than hoisted into http-utils -- a shared-utility refactor
// is not something to bundle into a bug fix.
const CONTROL_TIMEOUT_MS = 60 * 1000;
exports.pause = p => http.sendGcode(p, "PAUSE", CONTROL_TIMEOUT_MS);
exports.resume = p => http.sendGcode(p, "RESUME", CONTROL_TIMEOUT_MS);
exports.cancel = p => http.sendGcode(p, "CANCEL_PRINT", CONTROL_TIMEOUT_MS);
exports.eject = p => http.sendGcode(p, "SDCARD_RESET_FILE", CONTROL_TIMEOUT_MS);
exports.estop = http.estop; // deliberately unchanged — see above
exports.bedTemp = (p, t) => http.sendGcode(p, "M140 S" + Math.round(t), CONTROL_TIMEOUT_MS);
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
exports.getHealth = http.queryHealth;
exports.querySyncFiles = http.queryRemoteFileList;
exports.downloadSyncFile = http.downloadRemoteFile;
exports.deleteSyncFile = http.deleteRemoteFile;

// No getCameraSnapshot, no getInventory, no discoverAt — none of these exist
// on vanilla Moonraker without a brand-specific plugin/product_info block.
