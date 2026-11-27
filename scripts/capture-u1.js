#!/usr/bin/env node
// scripts/capture-u1.js — record what a real Snapmaker U1 reports, for the
// virtual U1 in fixtures/virtual-u1/.
//
//   node scripts/capture-u1.js <printer-ip> <label>
//   e.g. node scripts/capture-u1.js 192.0.2.10 idle
//        node scripts/capture-u1.js 192.0.2.11 printing
//
// READ-ONLY: every request is a GET. It never sends G-code, never subscribes,
// never uploads or deletes — safe against a printer in the middle of a job.
//
// Writes fixtures/virtual-u1/captures/<firmware>/<label>.json, cleaned for a
// public repository (see clean() below), then prints what changed against the
// previous capture of the same label from the newest other firmware version,
// so a firmware update shows at once whether anything SnapCon reads moved.
const fs = require("fs");
const path = require("path");
const { shapeOf, diffShapes, formatDiff } = require("../fixtures/virtual-u1/shape");

const CAPTURES = path.join(__dirname, "..", "fixtures", "virtual-u1", "captures");

// Large and never read by SnapCon: the whole parsed printer.cfg and the G-code
// command help list. Leaving them out keeps each capture ~50KB instead of ~250KB.
const SKIP_OBJECTS = new Set(["configfile", "gcode"]);

async function get(base, apiPath) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(base + apiPath, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`GET ${apiPath}: HTTP ${r.status}`);
    return (await r.json()).result;
  } finally { clearTimeout(t); }
}

// Everything that identifies a real machine, owner or job is replaced. Field
// names and types are kept exactly — they are the point of the capture.
function clean(capture) {
  const c = JSON.parse(JSON.stringify(capture));
  const si = c.systemInfo && c.systemInfo.system_info;
  if (si) {
    const pi = si.product_info || {};
    if (pi.serial_number) pi.serial_number = "VIRTUALU1000000000000";
    if (pi.device_name) pi.device_name = "Virtual U1";
    if (si.cpu_info && si.cpu_info.serial_number) si.cpu_info.serial_number = "0000000000000000";
    if (si.sd_info && si.sd_info.serial_number) si.sd_info.serial_number = "VIRTUALU1000000000000";
    let n = 0;
    for (const ifc of Object.values(si.network || {})) {
      n++;
      if (ifc.mac_address) ifc.mac_address = "02:00:00:00:00:0" + n;
      for (const a of ifc.ip_addresses || []) a.address = a.family === "ipv6" ? "::1" : "127.0.0.1";
    }
  }
  const st = c.status || {};
  // RFID tag UID of a Snapmaker spool.
  for (const info of ((st.filament_detect || {}).info) || []) {
    if (Array.isArray(info.CARD_UID)) info.CARD_UID = info.CARD_UID.map(() => 0);
  }
  // The owner's job: file and object names become neutral ones, consistently.
  const ps = st.print_stats || {};
  if (ps.filename) ps.filename = "Virtual print.gcode";
  const vsd = st.virtual_sdcard || {};
  if (vsd.file_path) vsd.file_path = vsd.file_path.replace(/[^/]+$/, "Virtual print.gcode");
  const eo = st.exclude_object;
  if (eo && Array.isArray(eo.objects)) {
    const names = new Map();
    eo.objects.forEach((o, i) => { names.set(o.name, `OBJECT_${i + 1}_ID_${i + 1}_COPY_0`); o.name = names.get(o.name); });
    eo.excluded_objects = (eo.excluded_objects || []).map(n => names.get(n) || "OBJECT_EXCLUDED");
    if (eo.current_object) eo.current_object = names.get(eo.current_object) || null;
  }
  return c;
}

// Newest firmware folder other than `fw` that has a capture with this label.
function previousCapture(fw, label) {
  if (!fs.existsSync(CAPTURES)) return null;
  const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const versions = fs.readdirSync(CAPTURES).filter(v => v !== fw).sort(byVersion).reverse();
  for (const v of versions) {
    const f = path.join(CAPTURES, v, label + ".json");
    if (fs.existsSync(f)) return { version: v, file: f };
  }
  return null;
}

async function main() {
  const [host, label] = process.argv.slice(2);
  if (!host || !/^[a-z0-9_-]+$/i.test(label || "")) {
    console.error("Usage: node scripts/capture-u1.js <printer-ip> <label>   (label: idle, printing, paused, …)");
    process.exit(2);
  }
  const base = /^https?:\/\//.test(host) ? host.replace(/\/+$/, "") : "http://" + host;

  const [printerInfo, serverInfo, systemInfo, roots, webcams, list] = await Promise.all([
    get(base, "/printer/info"), get(base, "/server/info"), get(base, "/machine/system_info"),
    get(base, "/server/files/roots"), get(base, "/server/webcams/list"), get(base, "/printer/objects/list")
  ]);
  const objects = list.objects.filter(o => !SKIP_OBJECTS.has(o));
  const query = await get(base, "/printer/objects/query?" + objects.map(encodeURIComponent).join("&"));

  const fw = ((systemInfo.system_info || {}).product_info || {}).firmware_version;
  if (!fw || !/^[0-9][0-9.]*$/.test(fw)) throw new Error("No usable firmware_version in /machine/system_info: " + fw);

  const capture = clean({
    capturedAt: new Date().toISOString().slice(0, 10),
    label,
    firmware: fw,
    klipperVersion: printerInfo.software_version,
    moonrakerVersion: serverInfo.moonraker_version,
    printerInfo, serverInfo, systemInfo,
    filesRoots: roots,
    webcams,
    objectsList: list.objects,
    status: query.status
  });

  const dir = path.join(CAPTURES, fw);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, label + ".json");
  const existed = fs.existsSync(out);
  const before = existed ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
  fs.writeFileSync(out, JSON.stringify(capture, null, 1) + "\n");

  const state = (capture.status.print_stats || {}).state;
  console.log(`${existed ? "Replaced" : "Wrote"} ${path.relative(process.cwd(), out)}`);
  console.log(`  firmware ${fw} (klipper ${capture.klipperVersion}, moonraker ${capture.moonrakerVersion}), print state "${state}", ${objects.length} objects`);

  if (before) {
    console.log(`\nAgainst the previous ${fw}/${label}.json:`);
    console.log(formatDiff(diffShapes(shapeOf(before.status), shapeOf(capture.status))));
  }
  const prev = previousCapture(fw, label);
  if (prev) {
    const old = JSON.parse(fs.readFileSync(prev.file, "utf8"));
    console.log(`\nAgainst firmware ${prev.version}/${label}.json:`);
    console.log(formatDiff(diffShapes(shapeOf(old.status), shapeOf(capture.status))));
  }
  console.log("\nReview the file before committing: the repository is public.");
}

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { clean };
