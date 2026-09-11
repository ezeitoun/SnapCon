// connectors/bambulab-h2.js — Bambu Lab H2 series (H2D, H2D Pro, H2S, H2C),
// MONITORING ONLY.
//
// What it does: keeps one persistent MQTT-over-TLS session per printer to the
// broker every Bambu printer runs on its own LAN port 8883, subscribes to
// `device/<serial>/report`, and turns the printer's `push_status` reports into
// the same normalized status every other connector returns from probe(). The
// fleet card, list view, notifications and audit trail then work unchanged:
// state, progress, remaining time, layers, bed/nozzle temperatures, fan,
// speed, and every AMS / AMS HT / external-spool slot with its colour and
// material. Two more read-only feeds sit on top:
//   - the camera, relayed live from the printer's RTSPS stream (port 322) as
//     fragmented MP4 (connectors/bambu-camera.js), once "LAN Only Liveview"
//     is switched on at the printer;
//   - the job preview image, read out of the job's .3mf over FTPS (port 990,
//     connectors/bambu-preview.js).
//
// What it deliberately does NOT do: send the printer anything that changes
// what it does. The only messages ever published are `get_version` and
// `pushall` — both requests for the printer to REPORT its state, the same two
// Bambu Studio and ha-bambulab send on connect. Every control export below is
// a stub that throws, and `capabilities.control === false` is what makes the
// UI hide the controls and server.js refuse the routes (connectors/
// monitorOnly.js is the one shared rule). Reasons it ships read-only:
//   - Since Bambu's 2025 "Authorization Control" firmware, commands from
//     third-party software are only accepted in LAN-only mode with Developer
//     Mode on, which also cuts the printer off Bambu's cloud and Handy app.
//     Reading status is explicitly NOT gated — it works in cloud mode too
//     (Bambu's own announcement lists "MQTT status push for tools like
//     HomeAssistant" as unaffected).
//   - Sending prints needs FTPS plus a different file format (.3mf with
//     embedded plate gcode) from everything else SnapCon handles.
//
// Printer config this connector reads (the same Settings fields FlashForge
// uses, holding Bambu's credentials here):
//   - `url` / `ip`         the printer's address (port 8883 is applied here)
//   - `serial`             the printer's serial number — it is both the MQTT
//                          topic and the common name on the printer's TLS
//                          certificate
//   - `verificationCode`   the 8-character LAN access code shown on the
//                          printer's screen (Settings -> Network / LAN Only)
//
// TLS: the printer's certificate is issued by Bambu's private CA with the
// serial as its common name. It is verified against that CA
// (connectors/bambu-ca.js) and the CN is checked against the configured
// serial, so the access code is never handed to a look-alike on the LAN.
// SNAPCON_BAMBU_INSECURE_TLS=1 skips verification — an escape hatch for a
// future printer whose CA is not in the bundle yet, not a default.
//
// Protocol facts below were taken from Bambu Studio's own device parsing
// (bambulab/BambuStudio, src/slic3r/GUI/DeviceCore) and ha-bambulab's
// pybambu, and checked against real H2D / H2D Pro / H2S / H2C report captures
// (see test/connectors/bambulab-h2.test.js for the shapes relied on).
const tls = require("tls");
const crypto = require("crypto");
const { MqttClient } = require("./bambu-mqtt");
const { BAMBU_CA_PEMS } = require("./bambu-ca");
const { parseAddressUrl, isValidHost } = require("./address");
const { monitorOnlyError } = require("./monitorOnly");
const camera = require("./bambu-camera");
const preview = require("./bambu-preview");
const { FtpsClient } = require("./ftps-client");

exports.label = "Bambu Lab H2D / H2S / H2C (monitoring only)";
exports.brand = "Bambu Lab";
// The broker port is fixed by the firmware; the connector applies it itself,
// so the stored URL stays host-only (mqtts://<ip>).
exports.address = { scheme: "mqtts", defaultPort: 8883, portEditable: false, required: true };
exports.capabilities = {
  // THE flag: see file header and connectors/monitorOnly.js.
  control: false,
  // The camera is decided per printer by getCapabilities() below: it exists
  // only once the printer reports LAN Only Liveview as switched on. This
  // static set is what a printer SnapCon has not heard from yet gets.
  camera: false, cameraSnapshot: false, cameraStream: false,
  filamentHeads: true, headMapping: false,
  excludeObject: false, autoLevel: false, flowCalibration: false, timelapse: false,
  unloadFilament: false, setColor: false,
  firmwareInfo: false, firmwareDeploy: false, health: false, fileSync: false, inventory: false,
  // Bambu announces itself over SSDP on UDP, which does not fit the HTTP
  // fingerprint discoverAt(baseUrl) shape — printers are added by IP.
  discovery: false,
  webUi: false,
  // H2D / H2D Pro / H2C carry two nozzles. Only ever used for wording.
  singleToolhead: false,
  estop: false,
  // H2D/H2S heated bed is specified to 120 °C.
  maxBedTemp: 120
};

const MQTT_PORT = 8883;
const FTP_PORT = 990;
const MQTT_USER = "bblp";

// ---- logging ----
const DEBUG = /^(1|true)$/i.test(process.env.SNAPCON_BAMBU_DEBUG || "");
const INSECURE_TLS = () => /^(1|true)$/i.test(process.env.SNAPCON_BAMBU_INSECURE_TLS || "");
function log(name, msg) { console.log(`[Bambu] ${name} ${msg}`); }
function debugLog(name, msg) { if (DEBUG) console.log(`[Bambu:debug] ${name} ${msg}`); }

// ---- model identification ----
// Serial-number prefixes, from `sn_prefix` in Bambu Studio's
// resources/printers/*.json. Only used to label a printer (a tag on first
// save); nothing about decoding depends on it — decoding follows the shape of
// the report itself, which is what actually differs between models.
const SERIAL_PREFIX_MODELS = [
  ["239", "H2D Pro"],
  ["094", "H2D"],
  ["093", "H2S"],
  ["31B", "H2C"]
];
function modelFromSerial(serial) {
  const s = String(serial || "").trim().toUpperCase();
  for (const [prefix, model] of SERIAL_PREFIX_MODELS) if (s.startsWith(prefix)) return model;
  return null;
}
exports.modelFromSerial = modelFromSerial;

// ---- pure decoding helpers ----
// Bambu sends many numbers as strings ("humidity":"5", "cooling_fan_speed":"2",
// "tray_now":"255"), and a few as either. Everything numeric goes through here.
function toNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// H2-series temperatures are packed: low 16 bits current, high 16 bits target
// (device.extruder.info[].temp, device.bed.info.temp, device.ctc.info.temp).
// 16056565 = 0x00F500F5 = 245 °C heading to 245 °C.
function unpackTemp(v) {
  const n = toNum(v);
  if (n == null || n < 0) return null;
  return { temp: n & 0xffff, target: Math.floor(n / 65536) & 0xffff };
}

// Hex bitfields (ams_exist_bits, tray_exist_bits) as a BigInt — tray bits for
// four AMS units plus AMS HT run past bit 31.
function parseHexBits(v) {
  if (typeof v !== "string" || !/^[0-9a-f]+$/i.test(v.trim())) return null;
  try { return BigInt("0x" + v.trim()); } catch { return null; }
}
function bitSet(bits, n) { return ((bits >> BigInt(n)) & 1n) === 1n; }

// "RRGGBBAA" -> "#RRGGBB". Alpha is dropped: SnapCon's swatches are opaque, and
// a transparent/natural spool reports alpha 00 with a real RGB.
function trayHex(tray) {
  const raw = (tray && (tray.tray_color || (Array.isArray(tray.cols) && tray.cols[0]))) || "";
  const m = /^([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(raw).trim());
  return m ? "#" + m[1].toUpperCase() : null;
}

// print_error as Bambu prints it: eight hex digits split in two,
// 50348044 -> "0300_400C". Padded, so codes whose first digit is 0 keep it.
function formatPrintError(n) {
  const v = toNum(n);
  if (!v) return "";
  const s = (v >>> 0).toString(16).toUpperCase().padStart(8, "0");
  return s.slice(0, 4) + "_" + s.slice(4);
}

// "Cancelled by user". Bambu ends a cancelled print in FAILED with this code.
const PRINT_ERROR_USER_CANCEL = 0x0300400C;

// gcode_state -> SnapCon's normalized state vocabulary (the Klipper one every
// other connector emits: standby / printing / paused / complete / cancelled /
// error).
//
// FAILED is ambiguous on Bambu: a user cancel and a real failure both end
// there. The error code decides — the cancel code, or no code at all, is a
// cancel; anything else is an error the operator needs to look at.
//
// PREPARE / SLICING are the minutes of heating, levelling and AMS loading
// before the first layer — the machine is busy, so they read as printing.
// INIT is accepted by ha-bambulab but its meaning is unverified, so it is
// passed through as "unknown" rather than guessed at.
function mapState(gcodeState, printError) {
  switch (String(gcodeState || "").toUpperCase()) {
    case "IDLE": return "standby";
    case "PREPARE": case "SLICING": case "RUNNING": return "printing";
    case "PAUSE": return "paused";
    case "FINISH": return "complete";
    case "FAILED": {
      const code = toNum(printError) || 0;
      return (code === 0 || code === PRINT_ERROR_USER_CANCEL) ? "cancelled" : "error";
    }
    default: return "unknown";
  }
}

function unitLabel(id) {
  if (id >= 128) return "HT" + (id - 127);
  return id < 26 ? String.fromCharCode(65 + id) : "AMS" + (id + 1);
}

// Every AMS / AMS HT slot, then the external spool holder(s), flattened into
// the `heads` array afcLanesHtml() renders — plus `activeExt`, the index of
// the slot currently feeding the active nozzle.
//
// Which slots exist comes from the printer's own bitfields when present
// (ams_exist_bits / tray_exist_bits), not from whether a tray object carries
// a filament type: an emptied slot can keep reporting its last material, and
// a spool without RFID can be physically present with no type set yet.
//   ams_exist_bits:  bit <id> for AMS 0-3, bit 4+(id-128) for AMS HT
//   tray_exist_bits: bit <ams*4+slot> for AMS 0-3, bit 16+(id-128) for AMS HT
function decodeHeads(print) {
  const heads = [];
  const index = new Map(); // "unit:slot" | "ext:<id>" -> heads index
  const ams = (print && print.ams) || {};
  const amsExist = parseHexBits(ams.ams_exist_bits);
  const trayExist = parseHexBits(ams.tray_exist_bits);
  const units = (Array.isArray(ams.ams) ? ams.ams : [])
    .map(u => ({ u, id: toNum(u && u.id) }))
    .filter(x => x.id != null && x.id >= 0)
    .filter(x => amsExist == null || bitSet(amsExist, x.id >= 128 ? 4 + (x.id - 128) : x.id))
    .sort((a, b) => a.id - b.id);
  for (const { u, id } of units) {
    const trays = Array.isArray(u.tray) ? u.tray : [];
    for (const tray of trays) {
      const slot = toNum(tray && tray.id);
      if (slot == null || slot < 0) continue;
      const present = trayExist != null
        ? bitSet(trayExist, id >= 128 ? 16 + (id - 128) : id * 4 + slot)
        : !!(tray && tray.tray_type);
      index.set(id + ":" + slot, heads.length);
      heads.push(trayToHead(tray, present, id >= 128 ? unitLabel(id) : unitLabel(id) + (slot + 1)));
    }
  }

  // External spool holders. Dual-nozzle models report both in vir_slot[]:
  // id "254" feeds the left (deputy) nozzle, "255" the right (main) one —
  // Bambu Studio's DeviceManager is the reference for that mapping.
  // Single-nozzle models report one, as vt_tray or a one-entry vir_slot.
  const ext = Array.isArray(print && print.vir_slot) && print.vir_slot.length
    ? print.vir_slot
    : (print && print.vt_tray && typeof print.vt_tray === "object" ? [print.vt_tray] : []);
  const dual = ext.length > 1;
  for (const tray of ext.slice().sort((a, b) => (toNum(a && a.id) || 0) - (toNum(b && b.id) || 0))) {
    const id = toNum(tray && tray.id);
    if (id == null) continue;
    index.set("ext:" + id, heads.length);
    heads.push(trayToHead(tray, !!(tray && tray.tray_type), dual ? (id === 254 ? "Ext-L" : "Ext-R") : "Ext"));
  }

  return { heads, activeExt: activeSlotIndex(print, index) };
}

function trayToHead(tray, present, label) {
  const material = present && tray && tray.tray_type ? String(tray.tray_type) : null;
  return {
    loaded: !!present,
    hex: present ? trayHex(tray) : null,
    material,
    sub: present && tray && tray.tray_sub_brands ? String(tray.tray_sub_brands) : null,
    // Bambu's own RFID spools carry a non-zero tray_uuid.
    official: !!(present && tray && /[1-9A-F]/i.test(String(tray.tray_uuid || ""))),
    label
  };
}

// The active nozzle and which slot feeds it.
//
// H2 series: device.extruder.state bits 4-7 are the active extruder; that
// extruder's `snow` is the slot now loaded into it, packed (ams_id << 8) | slot.
// ams_id 254/255 is an external holder; slot 0xFF means nothing is loaded.
// The legacy ams.tray_now is NOT used there — on a dual-nozzle printer it does
// not say which nozzle, and Bambu Studio ignores it too.
//
// Older single-nozzle firmware (no device.extruder) only has tray_now:
// 255 none, 254 external, 128-135 AMS HT, otherwise ams*4 + slot.
function activeSlotIndex(print, index) {
  const ext = print && print.device && print.device.extruder;
  if (ext && Array.isArray(ext.info) && ext.info.length) {
    const state = toNum(ext.state) || 0;
    const active = (state >> 4) & 0xf;
    const info = ext.info.find(e => toNum(e && e.id) === active) || ext.info[0];
    const snow = toNum(info && info.snow);
    if (snow == null) return null;
    const amsId = (snow >> 8) & 0xff, slot = snow & 0xff;
    if (slot === 0xff) return null;
    if (amsId === 254 || amsId === 255) {
      if (index.has("ext:" + amsId)) return index.get("ext:" + amsId);
      // A single-holder printer reports its one spool as id 255 whichever way
      // round the packed value names it.
      return index.has("ext:255") ? index.get("ext:255") : (index.has("ext:254") ? index.get("ext:254") : null);
    }
    const hit = index.get(amsId + ":" + slot);
    return hit == null ? null : hit;
  }
  const now = toNum(print && print.ams && print.ams.tray_now);
  if (now == null || now === 255) return null;
  if (now === 254) return index.has("ext:255") ? index.get("ext:255") : (index.has("ext:254") ? index.get("ext:254") : null);
  const hit = now >= 128 ? index.get(now + ":0") : index.get(Math.floor(now / 4) + ":" + (now % 4));
  return hit == null ? null : hit;
}

// Current/target of the nozzle doing the work. On H2 that is the active
// extruder's packed value; on anything without device.extruder, the legacy
// single-nozzle fields.
function activeHotend(print) {
  const ext = print && print.device && print.device.extruder;
  if (ext && Array.isArray(ext.info) && ext.info.length) {
    const active = ((toNum(ext.state) || 0) >> 4) & 0xf;
    const info = ext.info.find(e => toNum(e && e.id) === active) || ext.info[0];
    const t = unpackTemp(info && info.temp);
    if (t) return t;
  }
  const temp = toNum(print && print.nozzle_temper);
  if (temp == null) return null;
  return { temp: Math.round(temp), target: Math.round(toNum(print.nozzle_target_temper) || 0) };
}

function bedTemps(print) {
  const dev = (print && print.device) || {};
  const packed = unpackTemp(dev.bed && dev.bed.info ? dev.bed.info.temp : dev.bed_temp);
  if (packed) return packed;
  const temp = toNum(print && print.bed_temper);
  if (temp == null) return null;
  return { temp: Math.round(temp), target: Math.round(toNum(print.bed_target_temper) || 0) };
}

function basename(p) {
  const s = String(p || "");
  return s.slice(s.lastIndexOf("/") + 1);
}

// Identifies one print job across reports, so elapsed time can be measured
// from when SnapCon first saw it start.
function jobKey(print) {
  return [print.subtask_name || "", print.gcode_file || "", print.task_id || print.subtask_id || ""].join("|");
}

const ACTIVE_STATES = new Set(["PREPARE", "SLICING", "RUNNING", "PAUSE"]);

// Bambu reports no elapsed time on H2 (gcode_start_time is absent in every H2
// capture), so it is measured: a job first seen while preparing, or at 0%, is
// timed from that moment; one SnapCon only meets mid-print (a restart, a new
// connection) has an unknown start and reports no elapsed time rather than a
// wrong one. Remaining time comes from the printer itself and is unaffected.
function trackJob(job, print, now) {
  const gs = String(print.gcode_state || "").toUpperCase();
  const key = jobKey(print);
  if (ACTIVE_STATES.has(gs)) {
    if (!job || job.key !== key || job.finishedAt) {
      const startSec = toNum(print.gcode_start_time);
      const fresh = gs === "PREPARE" || gs === "SLICING" || (toNum(print.mc_percent) || 0) === 0;
      return { key, startedAt: startSec && startSec > 1e9 ? startSec * 1000 : (fresh ? now : null), finishedAt: null };
    }
    return job;
  }
  if ((gs === "FINISH" || gs === "FAILED") && job && job.key === key && !job.finishedAt) {
    return { ...job, finishedAt: now };
  }
  return job;
}

// The printer's report (already merged from deltas) -> SnapCon's normalized
// status. Pure: `now` and the tracked job come in as arguments.
function normalizeBambuState(p, print, { job = null, now = Date.now() } = {}) {
  print = print || {};
  const gs = String(print.gcode_state || "").toUpperCase();
  const printError = toNum(print.print_error) || 0;
  const state = mapState(gs, printError);
  const { heads, activeExt } = decodeHeads(print);

  // An error panel replaces the card's temperatures and progress, so it is
  // only raised when the print has actually stopped on one: a failed print,
  // or a pause the printer took because of an error (runout, clog, ...).
  // A code left over on an idle or running printer is stale and not shown.
  let errorCode = "", message = "";
  const stoppedOnError = state === "error" || (state === "paused" && printError && printError !== PRINT_ERROR_USER_CANCEL);
  if (stoppedOnError) {
    errorCode = formatPrintError(printError);
    message = "Bambu Lab error " + errorCode + " — see the printer's screen or Bambu Handy for details.";
  }

  // Progress only means something for a job that has started printing:
  // mc_percent keeps the LAST job's value on an idle printer (an H2 sitting at
  // IDLE after a finished print reports 100), and during PREPARE of a new job
  // it can still hold that stale value for a report or two — which would read
  // as a print starting at 100% and fire every progress notification at once.
  const pct = toNum(print.mc_percent);
  const measuring = gs === "RUNNING" || gs === "PAUSE" || gs === "FAILED";
  const progress = state === "complete" ? 1 : (measuring && pct != null ? Math.max(0, Math.min(1, pct / 100)) : 0);
  const busy = state === "printing" || state === "paused";
  const remainingMin = toNum(print.mc_remaining_time);
  const total = toNum(print.total_layer_num);
  const layerNum = toNum(print.layer_num);

  let elapsed = null;
  if (job && job.key === jobKey(print) && job.startedAt) {
    elapsed = Math.max(0, Math.round(((job.finishedAt || now) - job.startedAt) / 1000));
  }

  const fanRaw = toNum(print.cooling_fan_speed);
  return {
    name: p.name, online: true,
    state,
    message,
    errorCode,
    filename: String(print.subtask_name || basename(print.gcode_file) || ""),
    progress,
    elapsed,
    // Seconds, straight from the printer's own estimate. The card prefers this
    // over deriving remaining time from elapsed/progress, which on Bambu would
    // rest on a whole-percent progress value and a measured start time.
    remaining: busy && remainingMin != null ? Math.max(0, Math.round(remainingMin * 60)) : null,
    filamentUsed: null,
    bed: bedTemps(print),
    hotend: activeHotend(print),
    layer: total && total > 0 ? { current: Math.max(0, layerNum || 0), total } : null,
    speed: toNum(print.spd_mag),
    // 0-15 fan gear -> percent.
    fanPct: fanRaw != null ? Math.round(Math.max(0, Math.min(15, fanRaw)) / 15 * 100) : null,
    activeExt,
    plate: null,
    heads
  };
}

// ---- report merging ----
// Reports can be deltas (only what changed). Objects merge recursively. Arrays
// whose elements all carry an `id` (ams.ams[], tray[], vir_slot[],
// device.extruder.info[]) merge element-by-element on that id, so a delta
// naming one tray cannot erase the other fifteen; any other array (hms[]) is
// replaced whole — it is a current list, not a set of records. A report
// marked full (msg: 0) replaces everything instead, which is what clears
// units that were unplugged since the last full report.
function isIdArray(a) {
  return Array.isArray(a) && a.length > 0 && a.every(x => x && typeof x === "object" && !Array.isArray(x) && x.id !== undefined);
}
function mergeReport(target, delta) {
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) return target;
  const out = (target && typeof target === "object" && !Array.isArray(target)) ? target : {};
  for (const key of Object.keys(delta)) {
    const d = delta[key], t = out[key];
    if (isIdArray(d) && isIdArray(t)) {
      const merged = t.map(x => ({ ...x }));
      for (const el of d) {
        const i = merged.findIndex(x => String(x.id) === String(el.id));
        // A tray reported as nothing but its id is how the printer says the
        // slot was emptied (ha-bambulab clears the slot on it too) — merging
        // it would keep the removed spool's material, colour and RFID fields.
        const reset = key === "tray" && Object.keys(el).length === 1;
        if (i === -1 || reset) { if (i === -1) merged.push(structuredClone(el)); else merged[i] = structuredClone(el); }
        else merged[i] = mergeReport(merged[i], el);
      }
      out[key] = merged;
    } else if (d && typeof d === "object" && !Array.isArray(d)) {
      out[key] = mergeReport(t && typeof t === "object" && !Array.isArray(t) ? t : {}, d);
    } else {
      out[key] = Array.isArray(d) ? structuredClone(d) : d;
    }
  }
  return out;
}

// ---- printer config -> connection parameters ----
function printerConfig(p) {
  // Upper-cased: the printer publishes under its serial exactly as printed
  // (upper case), and the MQTT topic match is case-sensitive — a serial typed
  // in lower case would pass the (case-insensitive) certificate check and then
  // subscribe to a topic nothing is ever published on.
  const serial = String((p && p.serial) || "").trim().toUpperCase();
  const code = String((p && p.verificationCode) || "").trim();
  let host = String((p && p.ip) || "").trim();
  let port = MQTT_PORT;
  const parsed = parseAddressUrl(p && p.url);
  if (parsed) {
    if (!isValidHost(host)) host = parsed.host;
    if (parsed.port) port = parsed.port;
  }
  if (!isValidHost(host)) return { error: "No address configured for " + ((p && p.name) || "this printer") };
  if (!serial) return { error: "Enter the printer's serial number (Settings → Printers → Hardware) — Bambu Lab printers are addressed by it." };
  if (!code) return { error: "Enter the printer's 8-character LAN access code (Settings → Printers → Hardware) — it is shown on the printer under Settings → Network / LAN Only Mode." };
  return { host: host.replace(/^\[|\]$/g, ""), port, serial, code, sig: [host, port, serial, code].join("|") };
}

// ---- transport ----
// Production transport: TLS to the printer, verified against Bambu's CA with
// the certificate's CN checked against the configured serial. Tests swap this
// out (see _internal.setTransportFactory) for a plain socket to a fake broker,
// and exercise tlsOptions() itself against a real TLS server.
function tlsOptions(cfg, { insecure = INSECURE_TLS(), ca = BAMBU_CA_PEMS } = {}) {
  return {
    host: cfg.host,
    port: cfg.port,
    // The printer's certificate names its serial, never its IP — so SNI and the
    // identity check both use the serial.
    servername: cfg.serial,
    ca,
    // Pinned to 1.2 as ha-bambulab does: newer Bambu firmware (P2S 01.02) never
    // answers a TLS 1.3 ClientHello, and nothing is gained by offering it.
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
    rejectUnauthorized: !insecure,
    checkServerIdentity: (_host, cert) => {
      const cn = cert && cert.subject && cert.subject.CN;
      if (String(cn || "").trim().toUpperCase() === cfg.serial.toUpperCase()) return undefined;
      return Object.assign(new Error(`the printer's certificate belongs to serial "${cn || "?"}", not ${cfg.serial}`), { code: "ERR_BAMBU_CERT_SERIAL" });
    }
  };
}
function defaultTransport(cfg) {
  return tls.connect(tlsOptions(cfg));
}
let transportFactory = defaultTransport;

const TLS_TRUST_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_SIGNATURE_FAILURE", "CERT_UNTRUSTED",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"
]);

// Turns a connection failure into something an operator can act on — the
// same idea as FlashForge preferring the printer's own "check code error".
function describeError(e, name, port = MQTT_PORT) {
  if (!e) return "Could not reach " + name;
  if (e.code === "ECONNACK" && (e.returnCode === 4 || e.returnCode === 5)) {
    return "The printer rejected the LAN access code. Check the 8-character code on the printer (Settings → Network / LAN Only Mode) — it changes after a factory reset.";
  }
  if (e.code === "ERR_BAMBU_CERT_SERIAL") return "Serial number mismatch: " + e.message + ". Check the serial number in Settings.";
  if (TLS_TRUST_CODES.has(e.code)) {
    return "The printer's TLS certificate could not be verified against Bambu Lab's CA (" + e.code + "). " +
      "If this is a model newer than the H2 series, SNAPCON_BAMBU_INSECURE_TLS=1 skips the check.";
  }
  if (e.code === "ECONNREFUSED") return "Connection refused on port " + port + " — is this a Bambu Lab printer, and is it switched on?";
  if (e.code === "ETIMEDOUT" || e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH") return "Could not reach " + name + " (timeout)";
  return e.message || String(e);
}

// ---- per-printer connection ----
const FIRST_REPORT_WAIT_MS = 6000;     // how long a probe waits on a brand-new connection
const PUSHALL_MIN_GAP_MS = 10 * 1000;  // never ask for a full report more often than this
const SILENCE_PUSHALL_MS = 60 * 1000;  // no report this long -> ask for one
const RESYNC_MS = 5 * 60 * 1000;       // periodic full report, as Bambu Studio does
const STALE_MS = 150 * 1000;           // no report this long -> drop and reconnect
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60 * 1000;
// A rejected access code will not start working by retrying every few seconds,
// and hammering the broker with bad credentials is exactly what gets a client
// ignored. A corrected code in Settings changes the connection signature and
// reconnects immediately (see ensureConn), so this only paces the unchanged
// wrong code.
const AUTH_RETRY_MS = 5 * 60 * 1000;
const EVICT_AFTER_MS = 5 * 60 * 1000;
const SWEEP_MS = 10 * 1000;

const connections = new Map(); // printer id (or a one-off test key) -> Conn

function newConn(name, cfg) {
  return {
    name, cfg,
    state: "idle",          // idle | connecting | ready | backoff | closed
    client: null,
    status: {},
    haveBaseline: false,
    version: null,
    job: null,
    lastError: null,
    authFailed: false,
    connectedAt: 0,
    lastReportAt: 0,
    lastPushallAt: 0,
    lastProbedAt: Date.now(),
    reconnectAttempts: 0,
    reconnectTimer: null,
    seq: 0,
    waiters: new Set(),
    loggedError: null,
    announced: false
  };
}

function wake(c) {
  for (const w of c.waiters) { try { w(); } catch {} }
  c.waiters.clear();
}

function publishRequest(c, body) {
  if (!c.client || !c.client.connected) return false;
  return c.client.publish(`device/${c.cfg.serial}/request`, JSON.stringify(body));
}

function requestFullStatus(c, withVersion) {
  const now = Date.now();
  if (now - c.lastPushallAt < PUSHALL_MIN_GAP_MS) return;
  c.lastPushallAt = now;
  if (withVersion) publishRequest(c, { info: { sequence_id: String(c.seq++), command: "get_version" } });
  publishRequest(c, { pushing: { sequence_id: String(c.seq++), command: "pushall", version: 1, push_target: 1 } });
}

function handleMessage(c, topic, payload) {
  let msg;
  try { msg = JSON.parse(Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload)); }
  catch { return; }
  if (!msg || typeof msg !== "object") return;
  const now = Date.now();
  // Only push_status is printer state. Other `print` messages are echoes and
  // replies to commands (someone else's Bambu Studio session, for instance)
  // and would corrupt the merged state if folded in.
  if (msg.print && typeof msg.print === "object" && msg.print.command === "push_status") {
    const full = msg.print.msg === 0 || msg.print.msg === "0";
    c.status = full ? structuredClone(msg.print) : mergeReport(c.status, msg.print);
    c.lastReportAt = now;
    c.job = trackJob(c.job, c.status, now);
    // A report without gcode_state is a delta on top of a state we have not
    // seen yet (possible right after a reconnect) — not enough to show.
    if (!c.haveBaseline && c.status.gcode_state != null) {
      c.haveBaseline = true;
      // Only a session that actually delivered status counts as a successful
      // connection. Resetting the backoff on the handshake alone let a printer
      // that accepts and then immediately drops the session (connection
      // limit, a competing client) be redialled every second forever.
      c.reconnectAttempts = 0;
      c.lastError = null;
      c.loggedError = null;
      if (!c.announced) { log(c.name, "connected (monitoring only)"); c.announced = true; }
      wake(c);
    }
    return;
  }
  if (msg.info && msg.info.command === "get_version" && Array.isArray(msg.info.module)) {
    const ota = msg.info.module.find(m => m && m.name === "ota");
    c.version = {
      product: ota && ota.product_name ? String(ota.product_name) : null,
      firmware: ota && ota.sw_ver ? String(ota.sw_ver) : null
    };
    debugLog(c.name, "version " + JSON.stringify(c.version));
  }
}

function scheduleReconnect(c) {
  if (c.state === "closed" || c.reconnectTimer) return;
  const attempt = c.reconnectAttempts++;
  const delay = c.authFailed
    ? AUTH_RETRY_MS
    : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, attempt)) + Math.floor(Math.random() * 500);
  c.state = "backoff";
  c.reconnectTimer = setTimeout(() => { c.reconnectTimer = null; connect(c); }, delay);
  if (c.reconnectTimer.unref) c.reconnectTimer.unref();
}

function noteError(c, text) {
  c.lastError = text;
  // One log line per distinct problem, not one per retry.
  if (c.loggedError !== text) { log(c.name, text); c.loggedError = text; }
}

async function connect(c) {
  if (c.state === "closed" || c.state === "connecting" || c.state === "ready") return;
  c.state = "connecting";
  c.haveBaseline = false;
  c.status = {};
  const client = new MqttClient({
    createStream: () => transportFactory(c.cfg),
    clientId: "snapcon-" + crypto.randomBytes(6).toString("hex"),
    username: MQTT_USER,
    password: c.cfg.code,
    keepaliveSec: 30,
    connectTimeoutMs: 8000
  });
  c.client = client;
  client.on("message", (topic, payload) => { if (c.client === client) handleMessage(c, topic, payload); });
  // Every way a session ends — refused handshake, TLS failure, dropped
  // socket, keepalive timeout — arrives here exactly once (MqttClient's
  // contract), so this is the single place that records why and schedules the
  // retry. connect()'s own catch below only sees failures that happen while
  // the socket is still up (a refused subscription).
  client.on("close", (err) => {
    if (c.client !== client) return;
    c.client = null;
    const wasReady = c.state === "ready";
    c.haveBaseline = false;
    if (err) {
      c.authFailed = err.code === "ECONNACK" && (err.returnCode === 4 || err.returnCode === 5);
      noteError(c, describeError(err, c.name, c.cfg.port));
    }
    if (wasReady && c.announced) { log(c.name, "disconnected"); c.announced = false; }
    if (c.state !== "closed") scheduleReconnect(c);
    wake(c);
  });
  try {
    await client.connect();
    if (c.client !== client) return;
    await client.subscribe(`device/${c.cfg.serial}/report`);
    if (c.client !== client) return;
    c.state = "ready";
    c.authFailed = false;
    c.connectedAt = Date.now();
    c.lastReportAt = 0;
    c.lastPushallAt = 0;
    requestFullStatus(c, true);
  } catch (e) {
    // A failed handshake already went through the "close" handler above,
    // which cleared c.client — only a failure on a still-open session (a
    // refused subscription) is left to handle here.
    if (c.client !== client) return;
    noteError(c, describeError(e, c.name, c.cfg.port));
    client.end(); // -> "close" above schedules the retry and wakes waiters
  }
}

function teardown(c) {
  c.state = "closed";
  const relay = c.key != null ? relays.get(c.key) : null;
  if (relay) { relay.stop(); relays.delete(c.key); }
  if (c.reconnectTimer) { clearTimeout(c.reconnectTimer); c.reconnectTimer = null; }
  const client = c.client;
  c.client = null;
  if (client) { try { client.end(); } catch {} }
  c.haveBaseline = false;
  wake(c);
}

// Watchdog + eviction in one sweep for every connection, rather than a timer
// per printer.
let sweepTimer = null;
function ensureSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, SWEEP_MS);
  if (sweepTimer.unref) sweepTimer.unref();
}
function sweep() {
  const now = Date.now();
  for (const [key, c] of connections) {
    if (now - c.lastProbedAt > EVICT_AFTER_MS) {
      debugLog(c.name, "evicting — not probed in over " + Math.round(EVICT_AFTER_MS / 60000) + "m");
      teardown(c);
      connections.delete(key);
      continue;
    }
    if (c.state !== "ready") continue;
    const since = now - (c.lastReportAt || c.connectedAt);
    if (since > STALE_MS) {
      noteError(c, "No status report from the printer for " + Math.round(since / 1000) + "s — reconnecting");
      if (c.client) c.client.end();
      continue;
    }
    if (since > SILENCE_PUSHALL_MS || now - c.lastPushallAt > RESYNC_MS) requestFullStatus(c, !c.version);
  }
}

function ensureConn(key, name, cfg) {
  let c = connections.get(key);
  if (c && c.cfg.sig !== cfg.sig) {
    // Address, serial or access code changed under the same printer: the open
    // session (if any) belongs to the old settings.
    debugLog(name, "connection settings changed, reconnecting");
    teardown(c);
    connections.delete(key);
    c = null;
  }
  if (!c) {
    c = newConn(name, cfg);
    c.key = key;
    connections.set(key, c);
    ensureSweep();
    connect(c);
  }
  c.name = name;
  c.lastProbedAt = Date.now();
  return c;
}

function waitForBaseline(c, ms) {
  if (c.haveBaseline || (c.state !== "connecting" && c.state !== "ready")) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { c.waiters.delete(done); resolve(); }, ms);
    if (timer.unref) timer.unref();
    function done() { clearTimeout(timer); resolve(); }
    c.waiters.add(done);
  });
}

async function probe(p) {
  const name = (p && p.name) || "printer";
  const cfg = printerConfig(p);
  if (cfg.error) return { name, online: false, error: cfg.error };
  // Settings' "Test connection" probes a row that may not be saved yet (no
  // id). It gets a one-off connection that is closed again right after, so it
  // never lingers next to — or replaces — the saved printer's own session.
  const transient = !(p && p.id);
  const key = transient ? "test:" + crypto.randomBytes(6).toString("hex") : String(p.id);
  const c = ensureConn(key, name, cfg);
  try {
    // Only a connection still coming up is worth waiting for; one sitting in
    // backoff answers immediately (server.js's offline cache paces retries).
    if (!c.haveBaseline && (c.state === "connecting" || (c.state === "ready" && Date.now() - c.connectedAt < FIRST_REPORT_WAIT_MS))) {
      await waitForBaseline(c, FIRST_REPORT_WAIT_MS);
    }
    if (c.state === "ready" && c.haveBaseline) return normalizeBambuState(p, c.status, { job: c.job, now: Date.now() });
    const error = c.lastError || (c.state === "ready"
      ? "Connected, but " + name + " has not sent a status report yet"
      : "Could not reach " + name);
    return { name, online: false, error };
  } finally {
    if (transient) { teardown(c); connections.delete(key); }
  }
}
exports.probe = probe;

// ---- everything that would change the printer: refused, by design ----
// server.js and the UI never get here for a control:false connector; these
// exist so any path that does (a future route, the compat wizard) fails with
// the reason instead of "c.pause is not a function".
for (const fn of ["uploadFile", "startPrintFile", "pause", "resume", "cancel", "eject", "estop", "bedTemp"]) {
  exports[fn] = async (p) => { throw monitorOnlyError(p && p.name); };
}
// Read-only and harmless: nothing on the printer is listed for printing from
// SnapCon, since SnapCon cannot start one here.
exports.listFiles = async () => [];

// ---- camera ----
// The printer advertises its own stream as ipcam.rtsp_url once LAN Only
// Liveview is on ("disable" otherwise). Only its port and path are taken from
// it — the host is always the one configured (and TLS-verified) here, never an
// address out of a status message.
function liveviewTarget(p) {
  const c = p && p.id != null ? connections.get(String(p.id)) : null;
  const url = c && c.haveBaseline && c.status && c.status.ipcam && c.status.ipcam.rtsp_url;
  if (typeof url !== "string" || !/^rtsps:\/\//i.test(url)) return null;
  let port = camera.CAMERA_PORT, path = camera.CAMERA_PATH;
  try {
    const u = new URL(url);
    if (u.port) port = Number(u.port);
    if (u.pathname && u.pathname !== "/") path = u.pathname;
  } catch { /* keep the documented defaults */ }
  return { port, path };
}

// Synchronous by contract (server.js builds fleet rows with it). Reads what
// the printer's last report said about its camera.
function getCapabilities(p) {
  if (!liveviewTarget(p)) return exports.capabilities;
  return { ...exports.capabilities, camera: true, cameraStream: true, cameraSnapshot: !!camera.ffmpegPath() };
}
exports.getCapabilities = getCapabilities;

function defaultCameraTransport(cfg, port) {
  return tls.connect({ ...tlsOptions(cfg), port });
}
let cameraTransportFactory = defaultCameraTransport;

const relays = new Map(); // printer id -> CameraRelay
function relayFor(p) {
  const cfg = printerConfig(p);
  if (cfg.error) throw Object.assign(new Error(cfg.error), { status: 400 });
  const target = liveviewTarget(p);
  if (!target) {
    throw Object.assign(new Error("The camera is off — switch on \"LAN Only Liveview\" on the printer (Settings → Network / LAN Mode)."), { status: 404 });
  }
  const key = String(p.id);
  const sig = cfg.sig + "|" + target.port + target.path;
  let r = relays.get(key);
  if (r && r.sig !== sig) { r.stop(); relays.delete(key); r = null; }
  if (!r) {
    const host = cfg.host.includes(":") ? "[" + cfg.host + "]" : cfg.host;
    r = new camera.CameraRelay({
      key, name: p.name,
      createStream: () => cameraTransportFactory(cfg, target.port),
      url: `rtsps://${host}:${target.port}${target.path}`,
      username: MQTT_USER, password: cfg.code,
      log
    });
    r.sig = sig;
    relays.set(key, r);
  }
  return r;
}

// Live video for /api/camera-stream. `viewer` = { write(buf), end(err),
// backlog() }; resolves once the first keyframe is on its way, with the codec
// string the browser needs for its SourceBuffer.
exports.openCameraStream = async (p, viewer) => relayFor(p).subscribe(viewer);

// A still frame, for the snapshot modal and notification images. Only with
// ffmpeg on the host (see connectors/bambu-camera.js).
exports.getCameraSnapshot = async (p) => {
  if (!camera.ffmpegPath()) throw Object.assign(new Error("Still frames from Bambu Lab cameras need ffmpeg on the SnapCon host"), { status: 501 });
  const key = await relayFor(p).keyframe();
  return { contentType: "image/jpeg", buffer: await camera.jpegFromKeyframe(key) };
};

// ---- job preview ----
function defaultFtpControl(cfg) {
  return tls.connect({ ...tlsOptions(cfg), port: FTP_PORT });
}
function defaultFtpData(cfg, port, session) {
  return tls.connect({ ...tlsOptions(cfg), port, session });
}
let ftpTransportFactory = { control: defaultFtpControl, data: defaultFtpData };

// `file` is the job name the card shows. The printer's own report adds which
// plate is printing; for any other file, plate 1.
exports.getThumbnail = async (p, file) => {
  const cfg = printerConfig(p);
  if (cfg.error) throw Object.assign(new Error(cfg.error), { status: 404 });
  const c = p && p.id != null ? connections.get(String(p.id)) : null;
  const st = (c && c.status) || {};
  const current = String(st.subtask_name || "") === String(file || "") || basename(st.gcode_file) === String(file || "");
  const png = await preview.getPreview({
    printerKey: String(p.id != null ? p.id : cfg.sig),
    jobName: file,
    gcodeFile: current ? st.gcode_file : "",
    connect: async () => {
      const ftp = new FtpsClient({
        connectControl: () => ftpTransportFactory.control(cfg),
        connectData: (port, session) => ftpTransportFactory.data(cfg, port, session)
      });
      try { await ftp.connect(MQTT_USER, cfg.code); }
      catch (e) { ftp.close(); throw e; }
      return ftp;
    }
  }).catch((e) => { debugLog(p.name, "preview: " + e.message); return null; });
  if (!png) throw Object.assign(new Error("No preview for " + file), { status: 404 });
  return { contentType: "image/png", buffer: png };
};

// exported for tests only
exports._internal = {
  normalizeBambuState, decodeHeads, mergeReport, mapState, unpackTemp, formatPrintError, trackJob,
  printerConfig, describeError, handleMessage, newConn, connections, teardown, sweep,
  setTransportFactory(fn) { transportFactory = fn || defaultTransport; },
  setCameraTransportFactory(fn) { cameraTransportFactory = fn || defaultCameraTransport; },
  setFtpTransportFactory(f) { ftpTransportFactory = f || { control: defaultFtpControl, data: defaultFtpData }; },
  relays, liveviewTarget,
  defaultTransport, tlsOptions,
  timings: { FIRST_REPORT_WAIT_MS, PUSHALL_MIN_GAP_MS, SILENCE_PUSHALL_MS, RESYNC_MS, STALE_MS, AUTH_RETRY_MS }
};
