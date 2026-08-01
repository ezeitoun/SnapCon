// connectors/http-utils.js — shared primitives for Moonraker-based connectors.
// Anything here is genuinely protocol-generic: plain Moonraker REST calls that
// never branch on a specific printer brand. A non-Moonraker connector (Bambu,
// etc.) simply won't require this file.
const fs = require("fs");
const http = require("http");
const { Transform } = require("stream");
const { parseGcodeMap, normHex } = require("../parser");

const baseUrl = p => String(p.url).replace(/\/+$/, "");

// fetch with a built-in timeout via AbortController.
// NOTE: the timer only covers the response HEADERS — reading the body after
// this resolves is unbounded. Use fetchJSONTimeout when you consume the body.
async function fetchTimeout(url, ms = 3500, opts = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

// Fetch + parse JSON under ONE timeout. A printer that accepts the connection
// but stalls mid-body would otherwise hang the caller forever.
async function fetchJSONTimeout(url, ms = 3500) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return { ok: r.ok, status: r.status, json: r.ok ? await r.json() : null };
  } finally { clearTimeout(id); }
}

// POST to a printer's Moonraker endpoint. Throws a user-showable error on
// network failure or a non-2xx response.
async function moonrakerPost(p, apiPath) {
  let r;
  try { r = await fetch(baseUrl(p) + apiPath, { method: "POST" }); }
  catch (e) { throw new Error("Could not reach " + p.name + ": " + e.message); }
  if (!r.ok) throw new Error("Moonraker " + r.status + ": " + (await r.text()).slice(0, 160));
}
const sendGcode = (p, script) => moonrakerPost(p, "/printer/gcode/script?script=" + encodeURIComponent(script));

// Stream a file to the printer as multipart/form-data, reporting bytes sent so
// the UI can show a real upload progress bar. Resolves on the printer's 2xx.
function uploadWithProgress(base, fp, name, job) {
  return new Promise((resolve, reject) => {
    const boundary = "----snapcon" + Math.random().toString(16).slice(2);
    const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    const fileSize = fs.statSync(fp).size;
    job.total = pre.length + fileSize + post.length;
    job.sent = 0;
    const u = new URL(base + "/server/files/upload");
    const req = http.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": job.total }
    }, res => {
      let b = ""; res.setEncoding("utf8"); res.on("data", d => b += d);
      res.on("end", () => (res.statusCode < 300 ? resolve(b) : reject(new Error("Upload " + res.statusCode + ": " + b.slice(0, 160)))));
    });
    req.on("error", reject);
    req.write(pre); job.sent += pre.length;
    const fileStream = fs.createReadStream(fp);
    const counter = new Transform({ transform(chunk, _e, cb) { job.sent += chunk.length; cb(null, chunk); } });
    fileStream.on("error", reject);
    counter.on("error", reject);
    counter.on("data", chunk => { if (!req.write(chunk)) { counter.pause(); req.once("drain", () => counter.resume()); } });
    counter.on("end", () => { req.write(post); job.sent += post.length; req.end(); });
    fileStream.pipe(counter);
  });
}
const uploadFile = (p, fp, name, job) => uploadWithProgress(baseUrl(p), fp, name, job);

// ---- Print control: standard Klipper macros, identical across every
// Moonraker-based connector ----
const pause = p => sendGcode(p, "PAUSE");
const resume = p => sendGcode(p, "RESUME");
const cancel = p => sendGcode(p, "CANCEL_PRINT");
const eject = p => sendGcode(p, "SDCARD_RESET_FILE");
const estop = p => moonrakerPost(p, "/printer/emergency_stop");
const bedTemp = (p, t) => sendGcode(p, "M140 S" + Math.round(t));

// A value interpolated into a literal `script` line must never contain a
// quote or a line break: Moonraker executes a multi-line `script` value one
// gcode/macro command per line, so an embedded CR/LF turns one intended
// command into two attacker-chosen ones. This is the shared sink for every
// Klipper-family connector (klipper-moonraker, creality-klipper,
// snapmaker-u1-klipper all re-export startPrintFile/excludeObject
// unchanged), so it enforces this itself rather than trusting every caller
// upstream (server.js's /api/print, /api/printfile, /api/exclude, and the
// --load/--snapcon CLI/notify-load path) to have validated first.
function assertSafeGcodeArg(value) {
  if (/["\r\n]/.test(String(value))) throw new Error("Invalid characters in gcode argument");
  return value;
}
const startPrintFile = (p, filename) => sendGcode(p, `SDCARD_PRINT_FILE FILENAME="${assertSafeGcodeArg(filename)}"`);

// ---- Exclude-object: live plate map + skip a single object mid-print
// (stock Klipper's exclude_object module) ----
async function getPlate(p) {
  const { ok, status, json } = await fetchJSONTimeout(baseUrl(p) + "/printer/objects/query?exclude_object", 3500);
  if (!ok) throw new Error("Moonraker " + status);
  const eo = ((json.result || {}).status || {}).exclude_object || {};
  return {
    objects: (eo.objects || []).map(o => ({ name: o.name, center: o.center, polygon: o.polygon })),
    current: eo.current_object || null,
    excluded: eo.excluded_objects || []
  };
}
async function excludeObject(p, name) {
  await sendGcode(p, `EXCLUDE_OBJECT NAME=${assertSafeGcodeArg(name)}`);
}

// ---- File management on the printer (stock Moonraker) ----
async function listFiles(p) {
  const { ok, status, json } = await fetchJSONTimeout(baseUrl(p) + "/server/files/list?root=gcodes", 8000);
  if (!ok) throw new Error("Moonraker " + status);
  return (json.result || [])
    .map(f => ({ path: f.path, size: f.size, modified: f.modified }))
    .sort((a, b) => b.modified - a.modified);
}
// `file` is the real filename as reported by the printer (with its actual
// extension) — Moonraker's thumbnail cache is keyed by the extension-less
// stem instead ("<stem>-300x300.png"), so that stripping happens here,
// internally, rather than the caller pre-computing a Moonraker-specific stem
// that a different connector (e.g. FlashForge, which wants the exact
// filename) would misinterpret.
async function getThumbnail(p, file) {
  const stem = String(file).replace(/\.[^./\\]+$/, "");
  const url = baseUrl(p) + "/server/files/gcodes/.thumbs/" + encodeURIComponent(stem) + "-300x300.png";
  const r = await fetchTimeout(url, 5000);
  if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  return { contentType: r.headers.get("content-type") || "image/png", buffer: Buffer.from(await r.arrayBuffer()) };
}

// Fallback slicer-comment parsing for gcode Moonraker's own scanner didn't
// recognize at all (slicer:"Unknown", no estimated_time/filament_colour) —
// confirmed live against real Creality-Print-sliced files, which come in (at
// least) two comment dialects depending on slicer version, neither of which
// Moonraker's built-in scanner picked up on these real files:
//  - Cura-derived (older Creality Print, "FLAVOR:Creality OS"): plain header
//    tags positioned right before the actual gcode starts —
//    `;TIME:<seconds>`, `;Filament Weight:<grams>`.
//  - OrcaSlicer/BambuStudio-derived (newer Creality Print): a stats block at
//    the very end of the file, just before the alphabetical CONFIG_BLOCK
//    settings dump — `; estimated printing time (normal mode) = 9h 42m 19s`,
//    `; total filament used [g] = 236.85`.
function parseFallbackStats(text) {
  let estimatedTime = null, filamentG = null;
  const curaTime = /^;TIME:([\d.]+)/m.exec(text);
  if (curaTime) estimatedTime = parseFloat(curaTime[1]);
  if (estimatedTime == null) {
    const orcaTime = /estimated printing time(?:\s*\([^)]*\))?\s*=\s*((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s)?)/i.exec(text);
    if (orcaTime && orcaTime[1].trim()) {
      const hh = /(\d+)h/.exec(orcaTime[1]), mm = /(\d+)m/.exec(orcaTime[1]), ss = /(\d+)s/.exec(orcaTime[1]);
      estimatedTime = (hh ? +hh[1] * 3600 : 0) + (mm ? +mm[1] * 60 : 0) + (ss ? +ss[1] : 0);
    }
  }
  const curaWeight = /^;Filament Weight:([\d.]+)/m.exec(text);
  if (curaWeight) filamentG = parseFloat(curaWeight[1]);
  if (filamentG == null) {
    const orcaWeight = /total filament used \[g\]\s*=\s*([\d.]+)/i.exec(text) || /filament used \[g\]\s*=\s*([\d.]+)/i.exec(text);
    if (orcaWeight) filamentG = parseFloat(orcaWeight[1]);
  }
  return { estimatedTime, filamentG };
}

// Palette of a file stored on the printer, from Moonraker's slicer metadata,
// plus Full-Spectrum detection off the last 50KB of the gcode (config block
// is at EOF) via the shared gcode-content parser (parser.js — not a connector
// concern, it parses slicer OUTPUT format, not a printer protocol).
async function getFileMetadata(p, file) {
  const { ok, status, json } = await fetchJSONTimeout(baseUrl(p) + "/server/files/metadata?filename=" + encodeURIComponent(file), 8000);
  if (!ok) throw new Error("Moonraker " + status);
  const m = json.result || {};
  const colours = String(m.filament_colour || "").split(";");
  const types = String(m.filament_type || "").split(";");
  const weights = Array.isArray(m.filament_weight) ? m.filament_weight : [];
  const n = Math.max(colours.length, types.length, weights.length);
  const palette = [];
  for (let i = 0; i < n; i++) {
    const hex = normHex(colours[i]);
    const type = (types[i] || "").trim();
    const wt = weights[i];
    palette.push({
      i, hex, type,
      wt: wt != null ? String(wt) : "",
      used: (typeof wt === "number") ? wt > 0 : !!(hex || type)
    });
  }
  let isFS = false, fsFork = null, tailText = "";
  const encodedPath = file.split("/").map(encodeURIComponent).join("/");
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await fetch(baseUrl(p) + "/server/files/gcodes/" + encodedPath,
        { signal: ctrl.signal, headers: { Range: "bytes=-51200" } });
      if (r.ok || r.status === 206) {
        tailText = await r.text();
        const fsResult = parseGcodeMap(tailText, { scanBody: false });
        isFS = fsResult.isFS; fsFork = fsResult.fsFork;
      }
    } finally { clearTimeout(tid); }
  } catch {}

  let estimatedTime = m.estimated_time || null;
  const havePalette = palette.some(s => s.used);
  if (!estimatedTime || !havePalette) {
    let fb = parseFallbackStats(tailText); // OrcaSlicer/BambuStudio dialect — already have the bytes, no extra request
    if (fb.estimatedTime == null && fb.filamentG == null && typeof m.gcode_start_byte === "number" && m.gcode_start_byte > 0) {
      // Tail dialect found nothing — try the Cura dialect's header window instead,
      // a small Range request just before where the real gcode begins.
      try {
        const start = Math.max(0, m.gcode_start_byte - 16384);
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 8000);
        try {
          const r = await fetch(baseUrl(p) + "/server/files/gcodes/" + encodedPath,
            { signal: ctrl.signal, headers: { Range: `bytes=${start}-${m.gcode_start_byte}` } });
          if (r.ok || r.status === 206) fb = parseFallbackStats(await r.text());
        } finally { clearTimeout(tid); }
      } catch {}
    }
    if (!estimatedTime && fb.estimatedTime != null) estimatedTime = fb.estimatedTime;
    // Replaces (never appends to) an all-unused palette — that placeholder
    // entry exists only so an empty file still has a "which slot feeds this
    // print" row elsewhere in the UI; leaving it in place alongside a real
    // fallback entry would just be a second, redundant blank row.
    if (!havePalette && fb.filamentG != null) palette.splice(0, palette.length, { i: 0, hex: null, type: "", wt: String(fb.filamentG), used: true });
  }
  return { palette, estimatedTime, isFS, fsFork };
}

// ---- Firmware inventory (same Moonraker APIs fluidd reads — no brand-
// specific assumptions: every field is optional-chained/defaulted) ----
// `st` is an already-resolved probe() result (the caller already has one from
// probeCached — no reason to probe twice).
async function queryFirmwareInfo(p, st) {
  if (!st.online) return { name: p.name, online: false, skipped: true, reason: st.error || "offline" };
  if (!["standby", "complete", "cancelled"].includes(st.state)) {
    return { name: p.name, online: true, skipped: true, reason: "busy (" + st.state + ")" };
  }
  const base = baseUrl(p);
  try {
    const [pi, si, ol] = await Promise.all([
      fetchJSONTimeout(base + "/printer/info", 5000),
      fetchJSONTimeout(base + "/machine/system_info", 5000),
      fetchJSONTimeout(base + "/printer/objects/list", 5000)
    ]);
    const info = pi.ok ? (pi.json.result || {}) : {};
    const sys  = si.ok ? ((si.json.result || {}).system_info || {}) : {};
    const prod = sys.product_info || {};
    const dist = sys.distribution || {};

    // Every MCU the printer exposes: "mcu" is the mainboard, "mcu e0".."e3"
    // are per-toolhead MCUs on boards that have them (e.g. Snapmaker U1) —
    // this stays generic since it only reacts to whatever MCU names are
    // actually present, never assumes a fixed count.
    let mcus = [];
    const mcuNames = ol.ok ? ((ol.json.result || {}).objects || []).filter(o => /^mcu(\s|$)/.test(o)) : [];
    if (mcuNames.length) {
      const q = await fetchJSONTimeout(base + "/printer/objects/query?" + mcuNames.map(encodeURIComponent).join("&"), 5000);
      const stq = q.ok ? (((q.json.result || {}).status) || {}) : {};
      mcus = mcuNames.map(n => ({
        name: n === "mcu" ? "mainboard" : "toolhead " + n.replace(/^mcu\s*/, ""),
        version: (stq[n] || {}).mcu_version || null
      }));
    }

    return {
      name: p.name, online: true, skipped: false,
      machine: prod.machine_type || null,
      firmware: prod.firmware_version || null,
      software: prod.software_version || null,
      klipper: info.software_version || null,
      os: [dist.name, dist.kernel_version ? "kernel " + dist.kernel_version : ""].filter(Boolean).join(" · ") || null,
      mcus
    };
  } catch (e) {
    return { name: p.name, online: true, skipped: true, reason: e.message };
  }
}

// ---- Network inventory: name / IP / MAC, for DHCP reservations ----
function pickIface(net) {
  let fallback = null;
  for (const name in net) {
    const ifc = net[name] || {};
    const v4 = (ifc.ip_addresses || []).find(a => a.family === "ipv4" && !a.is_link_local);
    if (v4) return { iface: name, mac: ifc.mac_address || null, ip: v4.address };
    if (!fallback && ifc.mac_address) fallback = { iface: name, mac: ifc.mac_address, ip: null };
  }
  return fallback || { iface: null, mac: null, ip: null };
}

module.exports = {
  baseUrl, fetchTimeout, fetchJSONTimeout, moonrakerPost, sendGcode,
  uploadWithProgress, uploadFile,
  pause, resume, cancel, eject, estop, bedTemp, startPrintFile,
  getPlate, excludeObject,
  listFiles, getThumbnail, getFileMetadata,
  queryFirmwareInfo, pickIface,
  // exported for tests only
  _internal: { assertSafeGcodeArg, parseFallbackStats }
};
