// connectors/bambu-lab.js — Bambu Lab printers over their LAN protocol:
// status and control on MQTT over TLS (8883), files over implicit FTPS (990).
//
// BETA. Everything here was written against a real Bambu Lab P2S (firmware
// 01.02.00.00, AMS 2 Pro) surveyed with bambu-probe.js on 2026-09-15; the
// capture it produced is test/fixtures/bambu-p2s-report.js and drives this
// connector's tests. Other Bambu models speak the same protocol but differ in
// which fields they populate, so anything not seen on that printer is reported
// as unavailable rather than guessed (CLAUDE.md section 2), and a printer whose
// model we have not verified is labelled as untested rather than refused.
//
// Two facts decide most of the design:
//
//   1. CONTROL NEEDS DEVELOPER MODE. Without it the printer answers every
//      print command with {"result":"failed","reason":"mqtt message verify
//      failed"} and does nothing — while still serving status, file listings
//      and uploads perfectly. So a Bambu printer degrades to monitoring, with
//      an explanation, instead of looking broken. Verified both ways on the
//      P2S: refused with Developer Mode off, SUCCESS with it on.
//
//   2. THE REPORT TOPIC IS SHARED. Every client's command replies land on
//      device/<serial>/report — during the verified print test the printer's
//      own gcode_line and ledctrl replies arrived there too. Only push_status
//      messages are state, and a reply is ours only if its sequence_id matches
//      one we sent.
const tls = require("tls");
const crypto = require("crypto");
const { MqttClient } = require("./bambu-mqtt");
const { BAMBU_CA_PEMS } = require("./bambu-ca");
const { isValidHost, parseAddressUrl } = require("./address");
const camera = require("./bambu-camera");
const { FtpsClient } = require("./ftps-client");
const preview = require("./bambu-preview");
const zip = require("./zip-reader");
const threemf = require("../threemf");

const FTP_PORT = 990;

exports.label = "Bambu Lab (beta)";
exports.brand = "Bambu Lab";

const MQTT_PORT = 8883;
const MQTT_USER = "bblp";

// The port is fixed by the firmware, so Settings shows no Port field to get
// wrong; the scheme is only used to compose the stored canonical URL.
exports.address = { scheme: "http", defaultPort: MQTT_PORT, portEditable: false, required: true };

exports.capabilities = {
  camera: false, cameraSnapshot: false, cameraStream: false,
  filamentHeads: true, headMapping: true,
  // Two shapes, two start commands (see startPrintFile): a sliced .3mf project
  // goes through `project_file` and carries an AMS mapping; a plain .gcode goes
  // through `gcode_file`, which takes the file name alone.
  //
  // Only the .3mf path has been watched working on hardware here. The gcode one
  // is the documented command and the printer's owner reports it prints gcode;
  // it is offered rather than withheld, and the first real print will settle it.
  fileTypes: ["3mf", "gcode"],
  excludeObject: false,
  // Off until each flag's effect is verified on hardware — the verified start
  // payload is sent as captured instead of exposing switches that may do
  // nothing.
  autoLevel: false, flowCalibration: false, timelapse: false,
  unloadFilament: false, setColor: false,
  firmwareInfo: true, firmwareDeploy: false, health: false, fileSync: false, inventory: false,
  discovery: false, webUi: false,
  singleToolhead: true,
  // A Bambu printer authenticates with its serial plus the access code from its
  // own screen; there is no Moonraker API token to give it, so Settings hides
  // that field rather than offering one that does nothing.
  apiToken: false,
  // Bambu has no network emergency stop — `stop` is an ordinary cancel, and
  // M112 over the gcode channel is untested here. Both buttons stay visible
  // but disabled with a reason rather than quietly vanishing (the FlashForge
  // precedent, CLAUDE.md section 5).
  estop: false,
  eject: false,
  // Settings offers a per-printer switch for the external spool lane: a farm
  // that never loads that holder would otherwise carry a permanently empty
  // lane on every card. Not inferred from the report — an unused holder looks
  // exactly like one that is not there.
  externalSpoolOption: true,
  maxBedTemp: 120
};

// ---- pure decoding ----------------------------------------------------------
// Bambu sends many numbers as strings ("humidity":"5", "tray_now":"255"), and
// some as either.
function toNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// H2-series temperatures are packed: low 16 bits current, high 16 bits target.
// Used only as a fallback — see activeHotend().
function unpackTemp(v) {
  const n = toNum(v);
  if (n == null || n < 0) return null;
  return { temp: n & 0xffff, target: Math.floor(n / 65536) & 0xffff };
}

// Hex bitfields (ams_exist_bits, tray_exist_bits) as a BigInt: tray bits for
// four AMS units run past bit 31.
function parseHexBits(v) {
  if (typeof v !== "string" || !/^[0-9a-f]+$/i.test(v.trim())) return null;
  try { return BigInt("0x" + v.trim()); } catch { return null; }
}
function bitSet(bits, n) { return ((bits >> BigInt(n)) & 1n) === 1n; }

// "RRGGBBAA" -> "#RRGGBB". Alpha is dropped: SnapCon's swatches are opaque and
// a natural/transparent spool reports alpha 00 with a real RGB.
function trayHex(tray) {
  const raw = (tray && (tray.tray_color || (Array.isArray(tray.cols) && tray.cols[0]))) || "";
  const m = /^([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(raw).trim());
  return m ? "#" + m[1].toUpperCase() : null;
}

// print_error as the printer's own screen and Bambu Studio show it:
// 83918908 -> "0500-803C". Padded, so a code starting with 0 keeps it.
function formatPrintError(n) {
  const v = toNum(n);
  if (!v) return "";
  const s = (v >>> 0).toString(16).toUpperCase().padStart(8, "0");
  return s.slice(0, 4) + "-" + s.slice(4);
}

// Codes this connector actually acts on, in SnapCon's own words. Bambu Studio
// ships a full per-model table but it is AGPL-3.0 and SnapCon is MIT, so
// nothing is copied from it: every other code is shown as its number with a
// link for the operator to look up.
const USER_CANCEL = 0x0300400C;
const ERROR_TEXT = {
  0x0500803C: "The nozzle fitted doesn't match the one this file was sliced for. Confirm on the printer to continue, or re-slice for this nozzle.",
  [USER_CANCEL]: "The print was cancelled."
};
const ERROR_LOOKUP = "https://wiki.bambulab.com/en/hms/error-code";
function describePrintError(code) {
  const formatted = formatPrintError(code);
  if (!formatted) return { errorCode: "", message: "" };
  const known = ERROR_TEXT[code];
  return {
    errorCode: formatted,
    message: known || `Bambu Lab reported error ${formatted}. Look it up at ${ERROR_LOOKUP} or check the printer's screen.`
  };
}

// gcode_state -> SnapCon's shared state vocabulary. FAILED is ambiguous on
// Bambu: a user cancel and a real failure both end there, and the error code is
// what tells them apart (verified: a cancel leaves 0x0300400C).
function mapState(gcodeState, printError) {
  switch (String(gcodeState || "").toUpperCase()) {
    case "IDLE": return "standby";
    case "PREPARE": case "SLICING": case "RUNNING": return "printing";
    case "PAUSE": return "paused";
    case "FINISH": return "complete";
    case "FAILED": {
      const code = toNum(printError) || 0;
      return (code === 0 || code === USER_CANCEL) ? "cancelled" : "error";
    }
    default: return "unknown";
  }
}

// AMS unit 0's slots are A1-A4 on the printer's own screen, so they are A1-A4
// here. The external spool holder is "Ext".
function unitLabel(id) {
  if (id >= 128) return "HT" + (id - 127);
  return id < 26 ? String.fromCharCode(65 + id) : "AMS" + (id + 1);
}

// Every AMS slot, then the external holder, flattened into the `heads` array
// the fleet card renders, plus `activeExt` — the index of the slot feeding the
// nozzle.
//
// Whether a slot holds filament comes from the printer's own bitfields, not
// from whether a tray still carries a material: an emptied slot can keep
// reporting its last one. Captured P2S: tray_exist_bits "d" = A1, A3, A4
// occupied, A2 empty, and A2's object is {id, state} alone.
function decodeHeads(print, { externalSpool = true } = {}) {
  const heads = [];
  const index = new Map();
  const ams = (print && print.ams) || {};
  const amsExist = parseHexBits(ams.ams_exist_bits);
  const trayExist = parseHexBits(ams.tray_exist_bits);
  const units = (Array.isArray(ams.ams) ? ams.ams : [])
    .map(u => ({ u, id: toNum(u && u.id) }))
    .filter(x => x.id != null && x.id >= 0)
    .filter(x => amsExist == null || bitSet(amsExist, x.id >= 128 ? 4 + (x.id - 128) : x.id))
    .sort((a, b) => a.id - b.id);
  for (const { u, id } of units) {
    for (const tray of (Array.isArray(u.tray) ? u.tray : [])) {
      const slot = toNum(tray && tray.id);
      if (slot == null || slot < 0) continue;
      const present = trayExist != null
        ? bitSet(trayExist, id >= 128 ? 16 + (id - 128) : id * 4 + slot)
        : !!(tray && tray.tray_type);
      index.set(id + ":" + slot, heads.length);
      heads.push(trayToHead(tray, present, id >= 128 ? unitLabel(id) : unitLabel(id) + (slot + 1), {
        // What a print can be mapped onto: an AMS tray id, as ams_mapping
        // expects it. The external holder is display-only in this beta.
        mappable: true, tray: id * 4 + slot
      }));
    }
  }

  // Hidden lanes are still indexed below, so activeExt keeps pointing at the
  // right slot; they are simply not rendered.
  const ext = !externalSpool ? [] : (Array.isArray(print && print.vir_slot) && print.vir_slot.length
    ? print.vir_slot
    : (print && print.vt_tray && typeof print.vt_tray === "object" ? [print.vt_tray] : []));
  const dual = ext.length > 1;
  for (const tray of ext.slice().sort((a, b) => (toNum(a && a.id) || 0) - (toNum(b && b.id) || 0))) {
    const id = toNum(tray && tray.id);
    if (id == null) continue;
    index.set("ext:" + id, heads.length);
    heads.push(trayToHead(tray, !!(tray && tray.tray_type), dual ? (id === 254 ? "Ext-L" : "Ext-R") : "Ext",
      // Selecting the external spool needs a use_ams/ams_mapping encoding this
      // connector has never seen accepted by a printer. Shown, not offered.
      { mappable: false, tray: null }));
  }

  return { heads, activeExt: activeSlotIndex(print, index) };
}

function trayToHead(tray, present, label, extra) {
  return {
    loaded: !!present,
    hex: present ? trayHex(tray) : null,
    material: present && tray && tray.tray_type ? String(tray.tray_type) : null,
    sub: present && tray && tray.tray_sub_brands ? String(tray.tray_sub_brands) : null,
    // Bambu's own RFID spools carry a non-zero tray_uuid.
    official: !!(present && tray && /[1-9A-F]/i.test(String(tray.tray_uuid || ""))),
    label,
    ...extra
  };
}

// Which slot is feeding the nozzle. Newer firmware packs it into the active
// extruder's `snow` as (ams_id << 8) | slot, with slot 0xFF meaning nothing is
// loaded (the captured P2S reports 65535 there, i.e. nothing); older firmware
// only has ams.tray_now, where 255 is none and 254 the external holder.
function activeSlotIndex(print, index) {
  const ext = print && print.device && print.device.extruder;
  if (ext && Array.isArray(ext.info) && ext.info.length) {
    const active = ((toNum(ext.state) || 0) >> 4) & 0xf;
    const info = ext.info.find(e => toNum(e && e.id) === active) || ext.info[0];
    const snow = toNum(info && info.snow);
    if (snow == null) return null;
    const amsId = (snow >> 8) & 0xff, slot = snow & 0xff;
    if (slot === 0xff) return null;
    if (amsId === 254 || amsId === 255) {
      const hit = index.get("ext:" + amsId);
      return hit != null ? hit : (index.has("ext:255") ? index.get("ext:255") : (index.has("ext:254") ? index.get("ext:254") : null));
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

// Flat nozzle_temper/bed_temper first: those are the fields the P2S was
// verified to populate. The packed device.* values are a fallback for the H2
// series, which reports temperatures only there.
function activeHotend(print) {
  const temp = toNum(print && print.nozzle_temper);
  if (temp != null) return { temp: Math.round(temp), target: Math.round(toNum(print.nozzle_target_temper) || 0) };
  const ext = print && print.device && print.device.extruder;
  if (ext && Array.isArray(ext.info) && ext.info.length) {
    const active = ((toNum(ext.state) || 0) >> 4) & 0xf;
    const info = ext.info.find(e => toNum(e && e.id) === active) || ext.info[0];
    return unpackTemp(info && info.temp);
  }
  return null;
}

function bedTemps(print) {
  const temp = toNum(print && print.bed_temper);
  if (temp != null) return { temp: Math.round(temp), target: Math.round(toNum(print.bed_target_temper) || 0) };
  const dev = (print && print.device) || {};
  return unpackTemp(dev.bed && dev.bed.info ? dev.bed.info.temp : dev.bed_temp);
}

function basename(p) {
  const s = String(p || "");
  return s.slice(s.lastIndexOf("/") + 1);
}

// The merged report -> SnapCon's normalized status. Pure.
// `mc_remaining_time` is MINUTES. That is not our finding — the value read 0
// for the whole print we watched, because it paused seconds in — but Joel's
// driver, SnapCon PR #9 and ha-bambulab all read it the same way, three
// implementations arrived at independently.
//
// Three agreeing sources is better evidence than the one that told us Bambu
// could not print gcode (a single source, scoped to a different model family,
// which this plan over-generalised). It is still not OUR evidence, so the first
// reading of every print is checked against the slicer's own estimate, which
// travels inside the file. Minutes and seconds are a factor of 60 apart; no
// estimate is ever that wrong. A reading that fails the check is dropped rather
// than shown, because the fleet card, the notifications and the queue all read
// this number.
const REMAINING_UNIT_TOLERANCE = 8;   // an estimate may be badly out; 8x is not a bad estimate
function sanityCheckRemaining(reportedMinutes, fileSeconds) {
  const mins = toNum(reportedMinutes), secs = toNum(fileSeconds);
  if (!mins || !secs || mins <= 0 || secs <= 0) return "unknown";
  const ratio = (mins * 60) / secs;
  return (ratio > REMAINING_UNIT_TOLERANCE || ratio < 1 / REMAINING_UNIT_TOLERANCE) ? "suspect" : "ok";
}

function normalizeBambuState(p, print, { printer = p, remainingUnitSuspect = false } = {}) {
  print = print || {};
  const gs = String(print.gcode_state || "").toUpperCase();
  const printError = toNum(print.print_error) || 0;
  const state = mapState(gs, printError);
  const { heads, activeExt } = decodeHeads(print, { externalSpool: !(printer && printer.externalSpool === false) });

  // An error panel replaces the card's temperatures and progress, so it is
  // raised only when the print actually stopped on one: a failed print, or a
  // pause the printer took itself (the captured 0x0500803C nozzle question). A
  // code left over on an idle printer is stale.
  const stoppedOnError = state === "error" || (state === "paused" && printError && printError !== USER_CANCEL);
  const { errorCode, message } = stoppedOnError ? describePrintError(printError) : { errorCode: "", message: "" };

  // Progress, layer and remaining belong to a job that is actually running.
  // The captured idle report still says mc_percent 100 and layer_num 750 from
  // a job that ended: shown as live values they would re-fire every completion
  // notification and claim a print at 750/750.
  const busy = state === "printing" || state === "paused";
  const pct = toNum(print.mc_percent);
  const measuring = gs === "RUNNING" || gs === "PAUSE" || gs === "FAILED";
  const progress = state === "complete" ? 1 : (measuring && pct != null ? Math.max(0, Math.min(1, pct / 100)) : 0);
  const total = toNum(print.total_layer_num);
  const layerNum = toNum(print.layer_num);

  // Minutes from the printer, seconds for SnapCon. Only while a job is running
  // or paused: an idle printer keeps the last job's value, like its progress.
  function remaining() {
    if (!busy || remainingUnitSuspect) return null;
    const mins = toNum(print.mc_remaining_time);
    if (mins == null || mins < 0) return null;
    return Math.round(mins * 60);
  }

  // The printer reports its fans on a 0-15 scale — established here by watching
  // one wind down 15, 14, 13, 11, 0.
  const fanRaw = toNum(print.cooling_fan_speed);

  return {
    name: p.name, online: true,
    state,
    message,
    errorCode,
    filename: String(print.subtask_name || basename(print.gcode_file) || ""),
    progress,
    elapsed: null,
    remaining: remaining(),
    filamentUsed: null,
    bed: bedTemps(print),
    hotend: activeHotend(print),
    layer: busy && total && total > 0 ? { current: Math.max(0, layerNum || 0), total } : null,
    speed: toNum(print.spd_mag),
    // Still no chamber temperature: the P2S reports device.ctc.info.temp and
    // info.temp, neither confirmed to be the chamber.
    fanPct: fanRaw != null ? Math.round(Math.max(0, Math.min(15, fanRaw)) / 15 * 100) : null,
    activeExt,
    plate: null,
    heads
  };
}

// ---- report merging ---------------------------------------------------------
// Reports can be deltas. Objects merge recursively; arrays whose elements all
// carry an `id` (ams.ams[], tray[], vir_slot[], device.extruder.info[]) merge
// per element, so a delta naming one tray cannot erase the other three. Any
// other array (hms[]) is a current list and is replaced whole.
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
        // slot was emptied; merging it would keep the removed spool's material.
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

// ---- printer config -> connection parameters --------------------------------
function printerConfig(p) {
  // Upper-cased and trimmed: the printer publishes under its serial exactly as
  // printed on it, and the MQTT topic match is case-sensitive — a lower-case
  // serial connects, subscribes successfully, and then receives nothing at all.
  // (Cost a whole probe run against the real printer to discover.)
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
  if (!serial) return { error: "Enter the printer's serial number in Settings → Printers → Hardware. Bambu Lab printers are addressed by it, and it must match exactly." };
  if (!code) return { error: "Enter the printer's access code in Settings → Printers → Hardware. It is on the printer under Settings → Network." };
  return { host: host.replace(/^\[|\]$/g, ""), port, serial, code, sig: [host, port, serial, code].join("|") };
}

// ---- transport --------------------------------------------------------------
// The printer's certificate is issued by Bambu's own CA and names the printer's
// SERIAL, never its IP, so the identity check compares the serial and SNI
// carries it. Verified on the P2S: issuer "BBL Device CA N7-V2", no SAN.
function tlsOptions(cfg, { ca = BAMBU_CA_PEMS } = {}) {
  return {
    host: cfg.host,
    port: cfg.port,
    servername: cfg.serial,
    ca,
    // NOT pinned to TLS 1.2. The P2S on firmware 01.02.00.00 negotiated TLS
    // 1.3 in every captured run, so the pin other projects apply would only
    // cap it.
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
    checkServerIdentity: (_host, cert) => {
      const cn = cert && cert.subject && cert.subject.CN;
      if (String(cn || "").trim().toUpperCase() === cfg.serial.toUpperCase()) return undefined;
      return Object.assign(new Error(`the printer's certificate belongs to serial "${cn || "?"}", not ${cfg.serial}`), { code: "ERR_BAMBU_CERT_SERIAL" });
    }
  };
}
function defaultTransport(cfg) { return tls.connect(tlsOptions(cfg)); }
let transportFactory = defaultTransport;

const TLS_TRUST_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_SIGNATURE_FAILURE", "CERT_UNTRUSTED",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"
]);

// Turns a connection failure into something an operator can act on.
function describeError(e, name, port = MQTT_PORT) {
  if (!e) return "Could not reach " + name;
  if (e.code === "ECONNACK" && (e.returnCode === 4 || e.returnCode === 5)) {
    return "The printer rejected the access code. Check it on the printer under Settings → Network — it changes after a factory reset.";
  }
  if (e.code === "ERR_BAMBU_CERT_SERIAL") return "Serial number mismatch: " + e.message + ". Check the serial in Settings.";
  if (TLS_TRUST_CODES.has(e.code)) {
    return "The printer's certificate could not be verified against Bambu Lab's own authority (" + e.code + ").";
  }
  if (e.code === "ECONNREFUSED") return "Connection refused on port " + port + ". Is this a Bambu Lab printer, is it switched on, and is LAN Only Mode enabled?";
  if (e.code === "ETIMEDOUT" || e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH") return "Could not reach " + name + " (timeout)";
  return e.message || String(e);
}

// ---- Developer Mode ---------------------------------------------------------
// Three states, held in memory only, per printer: "unknown" (nothing has told
// us yet — the state after every restart and reconnect), "on", "off".
//
// The only authority is the printer's own answer to one of OUR print commands:
// "mqtt message verify failed" means off, a SUCCESS means on. SnapCon never
// sends a command merely to find out — the operator's next real command is the
// test, and a refused one changes nothing on the machine (verified).
//
// `fun` is a hint, and only ever a hint. On the P2S bit 0x20000000 was set
// while control was refused and cleared the moment Developer Mode was switched
// on. One printer, one toggle: enough to warn ahead of time and to clear a
// stale "off" so the operator is not locked out after fixing it, never enough
// to disable a control on its own.
const DEV_MODE_HINT_BIT = 0x20000000n;
function devModeHint(print) {
  const fun = print && print.fun;
  if (typeof fun !== "string" || !/^[0-9a-f]+$/i.test(fun.trim())) return null;
  let bits;
  try { bits = BigInt("0x" + fun.trim()); } catch { return null; }
  return (bits & DEV_MODE_HINT_BIT) === DEV_MODE_HINT_BIT ? "off" : "on";
}

// ---- per-printer connection --------------------------------------------------
const FIRST_REPORT_WAIT_MS = 5000;     // how long a first probe waits for real state
const PUSHALL_MIN_GAP_MS = 10 * 1000;
const SILENCE_PUSHALL_MS = 60 * 1000;
const RESYNC_MS = 5 * 60 * 1000;
const STALE_MS = 150 * 1000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60 * 1000;
// A rejected access code will not start working by being retried every second,
// and hammering a broker with bad credentials is how a client gets ignored. A
// corrected code changes the connection signature and reconnects at once.
const AUTH_RETRY_MS = 5 * 60 * 1000;
const EVICT_AFTER_MS = 5 * 60 * 1000;
const SWEEP_MS = 10 * 1000;

const connections = new Map();   // printer id (or a one-off key) -> conn

function newConn(name, cfg) {
  return {
    name, cfg, key: null,
    state: "idle",              // idle | connecting | ready | backoff | closed
    client: null,
    status: {},
    haveBaseline: false,
    version: null,
    devMode: "unknown",
    hint: null,
    // "unknown" until a job's countdown has been checked against the file's own
    // estimate; "suspect" hides the reading (see maybeCheckRemainingUnit).
    remainingUnit: "unknown",
    remainingUnitJob: null,
    lastError: null,
    authFailed: false,
    connectedAt: 0, lastReportAt: 0, lastPushallAt: 0, lastProbedAt: Date.now(),
    reconnectAttempts: 0, reconnectTimer: null,
    seq: 1000,
    pending: new Map(),        // sequence_id -> settle(reply), for commands in flight
    waiters: new Set(),
    loggedError: null, announced: false
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

  // Only push_status is state. The same topic also carries replies to commands
  // — ours and other clients' (during the verified print test the printer's own
  // gcode_line and ledctrl replies appeared here) — and folding those into the
  // merged report would corrupt it.
  if (msg.print && typeof msg.print === "object" && msg.print.command === "push_status") {
    const full = msg.print.msg === 0 || msg.print.msg === "0";
    c.status = full ? structuredClone(msg.print) : mergeReport(c.status, msg.print);
    c.lastReportAt = now;
    const hint = devModeHint(c.status);
    if (hint) {
      // A cached "off" clears the moment the hint says the switch was flipped,
      // so enabling Developer Mode on the printer gives the controls back
      // without restarting SnapCon or editing anything.
      if (c.devMode === "off" && c.hint === "off" && hint === "on") c.devMode = "unknown";
      c.hint = hint;
    }
    // First real countdown of a new job: check the unit against the slicer's
    // own estimate inside the file. Once per job, best effort, and never in the
    // way of the status it rode in on.
    maybeCheckRemainingUnit(c);
    if (!c.haveBaseline && c.status.gcode_state != null) {
      c.haveBaseline = true;
      // Only a session that actually delivered status counts as a success:
      // resetting the backoff on the handshake alone lets a printer that
      // accepts and immediately drops be redialled forever.
      c.reconnectAttempts = 0;
      c.lastError = null;
      c.loggedError = null;
      wake(c);
    }
    return;
  }

  // A reply to one of OUR commands, recognised only by the sequence_id we sent.
  // Everything else on this topic — the printer's own gcode_line and ledctrl
  // replies, and other clients' commands — is left alone.
  if (msg.print && typeof msg.print === "object" && msg.print.sequence_id != null) {
    const settle = c.pending.get(String(msg.print.sequence_id));
    if (settle) { settle(msg.print); return; }
  }

  if (msg.info && msg.info.command === "get_version" && Array.isArray(msg.info.module)) {
    const ota = msg.info.module.find(m => m && m.name === "ota");
    c.version = {
      model: ota && ota.product_name ? String(ota.product_name) : null,
      firmware: ota && ota.sw_ver ? String(ota.sw_ver) : null
    };
    wake(c);
  }
}

// Is this printer's countdown believable? Asked once per job, the first time it
// reports a non-zero remaining time while actually printing.
//
// The comparison is against the estimate the slicer wrote into the file, read
// from the printer over FTPS — one short session per job, the same cost the job
// preview already pays. If the two disagree by an order of magnitude the unit
// assumption is wrong on this model, the reading is dropped fleet-wide for this
// printer, and it says so in the log rather than counting down nonsense.
function maybeCheckRemainingUnit(c) {
  if (c.remainingUnit === "checking" || c.remainingUnitJob === jobKeyOf(c.status)) return;
  const mins = toNum(c.status.mc_remaining_time);
  const printing = ["RUNNING", "PAUSE"].includes(String(c.status.gcode_state || "").toUpperCase());
  if (!printing || !mins || mins <= 0) return;
  const file = String(c.status.subtask_name || "");
  if (!file) return;
  c.remainingUnitJob = jobKeyOf(c.status);
  c.remainingUnit = "checking";
  const cfg = c.cfg;
  (async () => {
    const ftp = ftpsFor(cfg);
    try {
      await ftp.connect(MQTT_USER, cfg.code);
      // The printer reports the job by name; the file it came from keeps its
      // extension on the printer's storage.
      const names = [file, file + ".3mf", file + ".gcode.3mf"];
      for (const name of names) {
        const size = await ftp.size(name).catch(() => null);
        if (size == null) continue;
        const info = await readSliceInfo(ftp, name, size).catch(() => null);
        const verdict = sanityCheckRemaining(mins, info && info.prediction);
        c.remainingUnit = verdict;
        if (verdict === "suspect") {
          console.log(`[Bambu] ${c.name} reported ${mins} as its remaining time while the file estimates ${info.prediction}s — the unit is not what SnapCon expects, so no remaining time is shown for this printer.`);
        }
        return;
      }
      c.remainingUnit = "unknown";
    } catch {
      c.remainingUnit = "unknown";   // could not read the file; assume nothing
    } finally {
      ftp.close();
    }
  })();
}
function jobKeyOf(print) {
  return [print && print.subtask_name, print && print.gcode_file, print && print.task_id].join("|");
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
  if (c.loggedError !== text) { console.log(`[Bambu] ${c.name} ${text}`); c.loggedError = text; }
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
  // Every way a session ends arrives here exactly once (MqttClient's contract),
  // so this is the single place that records why and schedules the retry.
  client.on("close", (err) => {
    if (c.client !== client) return;
    c.client = null;
    c.haveBaseline = false;
    // A reconnect proves nothing about Developer Mode either way.
    if (c.devMode === "off") c.devMode = "unknown";
    if (err) {
      c.authFailed = err.code === "ECONNACK" && (err.returnCode === 4 || err.returnCode === 5);
      noteError(c, describeError(err, c.name, c.cfg.port));
    }
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
    if (c.client !== client) return;
    noteError(c, describeError(e, c.name, c.cfg.port));
    client.end();
  }
}

function teardown(c) {
  c.state = "closed";
  // The camera session belongs to this printer's connection: a printer that is
  // evicted or reconfigured must not leave a relay holding a socket open.
  if (c.key != null) {
    const r = relays.get(c.key);
    if (r) { try { r.stop(); } catch {} relays.delete(c.key); }
  }
  if (c.reconnectTimer) { clearTimeout(c.reconnectTimer); c.reconnectTimer = null; }
  const client = c.client;
  c.client = null;
  if (client) { try { client.end(); } catch {} }
  c.haveBaseline = false;
  // A command still waiting for a reply will never get one now.
  for (const settle of c.pending.values()) {
    try { settle({ result: "failed", reason: "the connection to the printer closed" }); } catch {}
  }
  c.pending.clear();
  wake(c);
}

// One sweep for every connection rather than a timer per printer: evicts
// printers nobody is looking at, notices a session that went quiet, and keeps
// the merged state honest with a periodic full report.
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
      teardown(c);
      connections.delete(key);
      continue;
    }
    if (c.state !== "ready") continue;
    const since = now - (c.lastReportAt || c.connectedAt);
    if (since > STALE_MS) {
      noteError(c, "No status from the printer for " + Math.round(since / 1000) + "s — reconnecting");
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
    // session belongs to the old settings.
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

// The connection a saved printer uses, or null when it has none yet. Used by
// the synchronous getCapabilities(), which cannot wait for anything.
function connFor(p) {
  return (p && p.id != null) ? connections.get(String(p.id)) || null : null;
}

// A brand-new connection is given a bounded wait for its first real report
// rather than being reported offline straight away: server.js caches an offline
// result for 10s, which would hide a printer that was merely still connecting.
// There is no "connecting" state to report instead — the fleet card renders any
// state it does not recognise as "Idle", which would be a lie.
async function probe(p) {
  const name = (p && p.name) || "printer";
  const cfg = printerConfig(p);
  if (cfg.error) return { name, online: false, error: cfg.error };
  // Settings' Test connection probes a row that may not be saved yet. It gets a
  // throwaway session, closed immediately, so it never sits next to — or
  // replaces — the saved printer's own.
  const transient = !(p && p.id != null);
  const key = transient ? "test:" + crypto.randomBytes(6).toString("hex") : String(p.id);
  const c = ensureConn(key, name, cfg);
  try {
    if (!c.haveBaseline && (c.state === "connecting" || (c.state === "ready" && Date.now() - c.connectedAt < FIRST_REPORT_WAIT_MS))) {
      await waitForBaseline(c, FIRST_REPORT_WAIT_MS);
    }
    if (c.state === "ready" && c.haveBaseline) {
      return normalizeBambuState(p, c.status, { remainingUnitSuspect: c.remainingUnit === "suspect" });
    }
    return {
      name, online: false,
      error: c.lastError || (c.state === "ready"
        ? "Connected, but " + name + " has not sent a status report yet"
        : "Could not reach " + name)
    };
  } finally {
    if (transient) { teardown(c); connections.delete(key); }
  }
}
module.exports.probe = probe;

// Models this beta has actually been verified against, by the product_name the
// printer reports. Anything else works the same way but is labelled untested:
// the protocol is shared, the fields populated are not (CLAUDE.md section 2).
const VERIFIED_MODELS = new Set(["Bambu Lab P2S"]);

// ---- camera -------------------------------------------------------------------
// The printer advertises its own stream as ipcam.rtsp_url once LAN Only
// Liveview is switched on, and reports "disable" when it is off — so the camera
// button follows what this printer says rather than what its model usually has.
//
// Only the PORT and PATH are taken from that url. The host is always the one
// configured here, whose certificate was verified against the serial: a status
// message is printer-supplied data, and following its host would let a report
// point the camera connection at another machine entirely.
function liveviewTarget(p) {
  const c = connFor(p);
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

function defaultCameraTransport(cfg, port) { return tls.connect({ ...tlsOptions(cfg), port }); }
let cameraTransportFactory = defaultCameraTransport;

// File transfer runs over the same verified TLS as everything else. The data
// connection resumes the control connection's TLS session, which Bambu's FTP
// server requires.
function defaultFtpControl(cfg) { return tls.connect({ ...tlsOptions(cfg), port: FTP_PORT }); }
function defaultFtpData(cfg, port, session) { return tls.connect({ ...tlsOptions(cfg), port, session }); }
let ftpTransportFactory = { control: defaultFtpControl, data: defaultFtpData };

// One upstream session per printer, shared by every viewer: the camera serves
// a single H.264 track and opening it once per browser tab would be several
// connections to the same machine.
const relays = new Map();
function relayFor(p) {
  const cfg = printerConfig(p);
  if (cfg.error) throw Object.assign(new Error(cfg.error), { status: 400 });
  const target = liveviewTarget(p);
  if (!target) {
    throw Object.assign(new Error('The camera is off. Switch on "LAN Only Liveview" on the printer, under Settings → Network.'), { status: 404 });
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
      // The camera authenticates with the same credentials as everything else
      // (verified: Digest auth, user bblp plus the access code).
      username: MQTT_USER, password: cfg.code,
      log: (name, msg) => console.log(`[Bambu] ${name} ${msg}`)
    });
    r.sig = sig;
    relays.set(key, r);
  }
  return r;
}

// Live video for /api/camera-stream. `viewer` is { write, end, backlog };
// resolves once the first keyframe is on its way.
module.exports.openCameraStream = async (p, viewer) => relayFor(p).subscribe(viewer);

// A still frame, for the snapshot modal and notification images — only where
// ffmpeg is on the host. Without it the camera is live-view only, the same
// shape as SnapCon's existing WebRTC cameras.
module.exports.getCameraSnapshot = async (p) => {
  if (!camera.ffmpegPath()) {
    throw Object.assign(new Error("Still images from a Bambu Lab camera need ffmpeg on the SnapCon host. Live view works without it."), { status: 501 });
  }
  const key = await relayFor(p).keyframe();
  return { contentType: "image/jpeg", buffer: await camera.jpegFromKeyframe(key) };
};

// Synchronous by contract — server.js builds every fleet row with it and cannot
// await — so it reads whatever the live connection has already learned.
function getCapabilities(p) {
  const base = module.exports.capabilities;
  const c = connFor(p);
  const cam = liveviewTarget(p)
    ? { camera: true, cameraStream: true, cameraSnapshot: !!camera.ffmpegPath() }
    : null;
  if (!c) return { ...base, control: true, developerMode: "unknown", verifiedModel: true, ...cam };
  const developerMode = c.devMode !== "unknown" ? c.devMode : (c.hint || "unknown");
  return {
    ...base,
    ...cam,
    // Only a printer KNOWN to have control switched off loses its controls.
    // "unknown" keeps them: the operator's next command is what settles it.
    control: developerMode !== "off",
    developerMode,
    verifiedModel: !(c.version && c.version.model) || VERIFIED_MODELS.has(c.version.model),
    model: (c.version && c.version.model) || null
  };
}
module.exports.getCapabilities = getCapabilities;

// ---- control ----------------------------------------------------------------
// Every command carries its own sequence_id and waits for the reply that quotes
// it back. The report topic is shared — the printer's own gcode_line and
// ledctrl replies land there, and so do other clients' — so "any reply that
// looks like a success" would have us celebrating someone else's command.
const COMMAND_TIMEOUT_MS = 12000;
const VERIFY_FAILED = /mqtt message verify failed/i;
const DEV_MODE_HELP = "Printing from SnapCon needs Developer Mode on the printer: Settings → Network → LAN Only Mode, then Developer Mode.";

function connOrThrow(p) {
  const cfg = printerConfig(p);
  if (cfg.error) throw new Error(cfg.error);
  const c = connFor(p);
  if (!c || c.state !== "ready" || !c.client || !c.client.connected) {
    throw new Error(`${(p && p.name) || "The printer"} is not connected${c && c.lastError ? ": " + c.lastError : ""}`);
  }
  return c;
}

// Sends one print.* command and settles on ITS reply.
function sendCommand(c, body, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const seq = String(c.seq++);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.pending.delete(seq);
      reject(new Error(`${c.name} did not answer the ${body.command} command within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    c.pending.set(seq, (reply) => {
      clearTimeout(timer);
      c.pending.delete(seq);
      const result = String(reply.result || "").toLowerCase();   // SUCCESS for print.*, success for system.*
      const reason = String(reply.reason || "");
      if (result === "success") { c.devMode = "on"; resolve(reply); return; }
      if (VERIFY_FAILED.test(reason)) {
        // The one authoritative signal that control is switched off. Verified
        // on a P2S: the printer answers this in about half a second and does
        // not move.
        c.devMode = "off";
        reject(Object.assign(new Error(`${c.name} refused the command. ${DEV_MODE_HELP}`), { code: "EDEVMODE" }));
        return;
      }
      reject(new Error(`${c.name} refused the ${body.command} command${reason ? ": " + reason : ""}`));
    });
    if (!publishRequest(c, { print: { ...body, sequence_id: seq } })) {
      clearTimeout(timer);
      c.pending.delete(seq);
      reject(new Error(`${c.name} is not connected`));
    }
  });
}

const simpleCommand = (command) => async (p) => { await sendCommand(connOrThrow(p), { command, param: "" }); };
module.exports.pause = simpleCommand("pause");
module.exports.resume = simpleCommand("resume");
module.exports.cancel = simpleCommand("stop");

// There is no dedicated bed command: the bed is set with a gcode line, the same
// M140 every other connector sends.
module.exports.bedTemp = async (p, t) => {
  const temp = Math.round(Number(t));
  const max = module.exports.capabilities.maxBedTemp;
  if (!Number.isFinite(temp) || temp < 0 || temp > max) {
    throw new Error(`Bed temperature must be between 0 and ${max} °C`);
  }
  await sendCommand(connOrThrow(p), { command: "gcode_line", param: `M140 S${temp}\n` });
};

// ---- filament mapping ---------------------------------------------------------
// The Send dialog picks which AMS tray feeds each filament in the file; the
// server hands that here before starting the print, exactly as it does for the
// AD5X. Stashed rather than sent: a Bambu print is started by ONE command that
// carries the mapping with it.
const MAPPING_TTL_MS = 5 * 60 * 1000;
const mappings = new Map();   // printer id -> { file, ams_mapping, at }

module.exports.applyHeadMapping = async (p, tools, map, prefs, opts = {}) => {
  const c = connFor(p);
  const heads = c && c.haveBaseline ? decodeHeads(c.status).heads : [];
  const order = (Array.isArray(tools) && tools.length ? tools : Object.keys(map || {})).map(Number).sort((a, b) => a - b);
  const ams_mapping = [];
  for (const filament of order) {
    const head = Number((map || {})[filament]);
    const slot = heads[head];
    if (!Number.isInteger(head) || head < 0 || (heads.length && !slot)) {
      throw new Error(`There is no tray ${head + 1} on ${p.name}. Choose one of its AMS trays.`);
    }
    if (slot && slot.mappable === false) {
      throw new Error(`Printing from the external spool is not supported for Bambu Lab printers in this beta yet. Choose an AMS tray.`);
    }
    const tray = slot ? slot.tray : head;
    if (!Number.isInteger(tray) || tray < 0 || tray > 15) {
      throw new Error(`That tray cannot be used for printing on ${p.name}.`);
    }
    ams_mapping.push(tray);
  }
  mappings.set(String(p.id), { file: opts.file || null, ams_mapping, at: Date.now() });
};

function takeMapping(p, file) {
  const key = String(p.id);
  const m = mappings.get(key);
  if (!m || Date.now() - m.at > MAPPING_TTL_MS) return null;
  if (m.file && m.file !== file) return null;
  return m;
}

// ---- sending and starting a print ---------------------------------------------
function ftpsFor(cfg) {
  return new FtpsClient({
    connectControl: () => ftpTransportFactory.control(cfg),
    connectData: (port, session) => ftpTransportFactory.data(cfg, port, session)
  });
}

// Sends the file and confirms the printer holds all of it. Cleanup is
// deliberate, not reflexive:
//   - refused before any data moved -> delete NOTHING. A file of that name
//     already on the printer was never touched, and removing it would destroy
//     something the operator may be about to print from the screen.
//   - the transfer began and then failed -> one best-effort delete, because
//     what is on the printer now is a truncated .3mf that looks startable.
// Either way the error the operator sees is the original one: a failed cleanup
// must never replace the reason the upload failed.
module.exports.uploadFile = async (p, localPath, name, job = {}) => {
  const cfg = printerConfig(p);
  if (cfg.error) throw new Error(cfg.error);
  if (!/\.(3mf|gcode)$/i.test(String(name))) {
    throw new Error(`${p.name} prints a sliced .3mf project or a .gcode file. Export one from Bambu Studio or Orca Slicer.`);
  }
  const ftp = ftpsFor(cfg);
  try {
    await ftp.connect(MQTT_USER, cfg.code);
    try {
      await ftp.store(localPath, name, job);
    } catch (e) {
      if (e && e.started) {
        try { await ftp.remove(name); }
        catch (cleanupError) { console.log(`[Bambu] ${p.name} could not remove the incomplete ${name}: ${cleanupError.message}`); }
      }
      throw e;
    }
    // The printer's own view of the file, not ours: a transfer can report every
    // byte sent and still land short.
    const onPrinter = await ftp.size(name).catch(() => null);
    if (onPrinter != null && onPrinter !== job.total) {
      try { await ftp.remove(name); } catch { /* best effort */ }
      throw new Error(`${name} arrived incomplete on ${p.name} (${onPrinter} of ${job.total} bytes)`);
    }
  } finally {
    ftp.close();
  }
};

// Two ways to start a print, decided by what the file IS.
//
// A plain .gcode goes through `gcode_file`, which takes the file name and
// nothing else: the slicer already fixed which tool prints what, so there is no
// AMS mapping to add and none to demand. (Documented in the community protocol
// and reported working by this printer's owner; the .3mf path below is the one
// watched working here.)
//
// A sliced .3mf goes through `project_file`, which carries everything at once:
// the plate, the file, and which tray feeds each filament. Those flags are
// exactly the payload verified on a P2S — SnapCon's own print-option switches
// stay hidden for Bambu until each one's effect has been watched on hardware.
module.exports.startPrintFile = async (p, name) => {
  const c = connOrThrow(p);
  if (/\.gcode$/i.test(String(name))) {
    await sendCommand(c, { command: "gcode_file", param: String(name) }, { timeoutMs: 20000 });
    return;
  }
  const mapping = takeMapping(p, name);
  if (!mapping) {
    throw new Error(`Choose which AMS tray feeds each filament before printing ${name} on ${p.name}.`);
  }
  await sendCommand(c, {
    command: "project_file",
    param: "Metadata/plate_1.gcode",
    subtask_name: String(name).replace(/\.gcode\.3mf$|\.3mf$/i, ""),
    url: `ftp:///${name}`,
    bed_type: "auto",
    bed_leveling: true,
    flow_cali: false,
    vibration_cali: true,
    layer_inspect: false,
    timelapse: false,
    use_ams: true,
    ams_mapping: mapping.ams_mapping,
    profile_id: "0", project_id: "0", subtask_id: "0", task_id: "0"
  }, { timeoutMs: 20000 });
  mappings.delete(String(p.id));
};
// Declared unsupported outright (capabilities.estop / .eject), so the UI
// disables both. These exist so any path that still reaches them fails with
// the reason rather than a TypeError.
module.exports.estop = async () => {
  throw new Error("Bambu Lab printers have no network emergency stop. Cancel the print, or cut power at the machine.");
};
// There is no printer-side "forget the loaded file" on a Bambu: the machine
// shows its last job until the next print starts, and nothing SnapCon can send
// changes that. Verified live on a P2S sitting at FAILED after a cancel:
// `clean_print_error` was answered SUCCESS and left the state exactly as it
// was, `print_clean` was refused ("ERROR STATE"), and an M1003 gcode line was
// accepted with no effect.
//
// What Eject still means here is SnapCon's own staged file, which
// /api/printctl clears right after this call — so this is a deliberate no-op
// rather than an error, and the button is only offered when there IS one
// staged (see canEject in public/app.js).
module.exports.eject = async () => {};

// ---- the printer's own files ---------------------------------------------------
// Pressing Print with nothing selected opens a picker of what is already on the
// printer. A Bambu keeps its projects in the root (and a /cache copy of the
// last cloud job), alongside timelapse videos it cannot print.
const PRINTABLE_RE = /\.3mf$/i;
function filterPrintable(files) {
  return files.filter(f => !f.dir && PRINTABLE_RE.test(f.path || f.name || ""));
}

module.exports.listFiles = async (p) => {
  const cfg = printerConfig(p);
  if (cfg.error) throw new Error(cfg.error);
  const ftp = ftpsFor(cfg);
  try {
    await ftp.connect(MQTT_USER, cfg.code);
    const entries = await ftp.listDetailed("/");
    return filterPrintable(entries.map(e => ({ path: e.name, size: e.size, dir: e.dir })))
      .map(({ path, size }) => ({ path, size, modified: null }));
  } finally {
    ftp.close();
  }
};

// The palette of a file sitting on the printer, so its colours can be mapped to
// AMS trays before it is started. Read out of the .3mf itself with the same
// ranged reads the preview uses — a few KB, not the whole project.
function metadataFromSliceInfo(info) {
  const palette = (info.filaments || []).map((f, i) => ({
    i,
    hex: f.color || null,
    type: (f.type || "").trim(),
    wt: f.usedG != null ? String(f.usedG) : "",
    // A filament listed but never extruded must not ask for a tray.
    used: f.usedG != null ? f.usedG > 0 : !!(f.color || f.type)
  }));
  return {
    palette,
    estimatedTime: info.prediction != null ? info.prediction : null,
    // Full Spectrum is a Snapmaker feature; a Bambu file is never one.
    isFS: false, fsFork: null
  };
}

module.exports.getFileMetadata = async (p, file) => {
  const cfg = printerConfig(p);
  if (cfg.error) throw new Error(cfg.error);
  const ftp = ftpsFor(cfg);
  try {
    await ftp.connect(MQTT_USER, cfg.code);
    const size = await ftp.size(file).catch(() => null);
    const info = await readSliceInfo(ftp, file, size);
    if (!info) return { palette: [], estimatedTime: null, isFS: false, fsFork: null };
    return metadataFromSliceInfo(info);
  } finally {
    ftp.close();
  }
};

// Pulls Metadata/slice_info.config out of the archive on the printer. Falls
// back to reading the whole file when the server will not serve a range.
async function readSliceInfo(ftp, file, size) {
  let whole = null;
  const readWhole = async () => {
    if (!whole) whole = await ftp.read(file, 0, Infinity, 64 * 1024 * 1024);
    return whole;
  };
  let ranged = size != null;
  const read = async (offset, length) => {
    if (ranged) {
      try { return await ftp.read(file, offset, length); }
      catch (e) { if (e.code !== "ENOREST") throw e; ranged = false; }
    }
    const all = await readWhole();
    return all.subarray(offset, offset + length);
  };
  const total = size != null ? size : (await readWhole()).length;
  const entries = await zip.readCentralDirectory(read, total);
  const entry = entries.find(e => /^Metadata\/slice_info\.config$/i.test(e.name));
  if (!entry) return null;
  const xml = (await zip.readEntry(read, entry)).toString("utf8");
  return threemf._internal.parseSliceInfo(xml);
}

// ---- job preview --------------------------------------------------------------
// The fleet card asks for a picture of what this printer is printing. On a
// Bambu that picture is an entry inside the .3mf sitting on the printer, so it
// is read back from the machine rather than from SnapCon's library: the printer
// may be running a file that was sent from Bambu Studio and was never here.
//
// Only a few ranged reads, not the whole project: the archive's directory, then
// the one PNG. A 40 MB file over FTPS for a card thumbnail would be absurd.
module.exports.getThumbnail = async (p, file) => {
  const cfg = printerConfig(p);
  if (cfg.error) throw Object.assign(new Error(cfg.error), { status: 404 });
  const c = connFor(p);
  const st = (c && c.status) || {};
  // Which plate is printing is only known for the job the printer is actually
  // running; for any other file, plate 1.
  const current = String(st.subtask_name || "") === String(file || "") || basename(st.gcode_file) === String(file || "");
  const png = await preview.getPreview({
    printerKey: String(p.id != null ? p.id : cfg.sig),
    jobName: file,
    gcodeFile: current ? st.gcode_file : "",
    connect: async () => {
      const ftp = ftpsFor(cfg);
      try { await ftp.connect(MQTT_USER, cfg.code); }
      catch (e) { ftp.close(); throw e; }
      return ftp;
    }
  }).catch(() => null);
  if (!png) throw Object.assign(new Error("No preview for " + file), { status: 404 });
  return { contentType: "image/png", buffer: png };
};

// "Check again" on the card's monitoring-only note. The operator has just
// switched Developer Mode on at the printer, so the cached "off" — which was
// true when it was recorded — is dropped and the controls come back. Nothing is
// sent to the printer to test with: their next real command settles it, and a
// refused one changes nothing on the machine (verified).
module.exports.recheckControl = async (p) => {
  const c = connFor(p);
  if (c && c.devMode === "off") c.devMode = "unknown";
  return { developerMode: c ? (c.devMode !== "unknown" ? c.devMode : (c.hint || "unknown")) : "unknown" };
};

module.exports.getFirmwareInfo = async function getFirmwareInfo(p) {
  const c = connFor(p);
  if (!c || !c.version) return { skipped: true, reason: "The printer has not reported its version yet", reasonCode: "no-version" };
  return { model: c.version.model, firmware: c.version.firmware };
};

module.exports._internal = {
  toNum, unpackTemp, trayHex, formatPrintError, describePrintError, mapState, sanityCheckRemaining,
  decodeHeads, activeSlotIndex, activeHotend, bedTemps, normalizeBambuState,
  mergeReport, printerConfig, tlsOptions, describeError,
  setTransportFactory(fn) { transportFactory = fn || defaultTransport; },
  getTransportFactory() { return transportFactory; },
  devModeHint, connFor, liveviewTarget, relays, connections, teardown, newConn, ensureConn,
  filterPrintable, metadataFromSliceInfo, readSliceInfo,
  setCameraTransportFactory(fn) { cameraTransportFactory = fn || defaultCameraTransport; },
  setFtpTransportFactory(f) { ftpTransportFactory = f || { control: defaultFtpControl, data: defaultFtpData }; },
  connectionCount() { return connections.size; },
  // Tests only: drop every session so a test process exits cleanly.
  closeAll() {
    for (const [k, r] of relays) { try { r.stop(); } catch {} relays.delete(k); }
    for (const [k, c] of connections) { teardown(c); connections.delete(k); }
  },
  MqttClient, MQTT_USER, MQTT_PORT
};
