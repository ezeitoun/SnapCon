// connectors/creality-klipper.js — Creality K1 / K1C / K1 Max / K1 SE / Hi /
// K2 series, all genuine forks of stock Klipper3d/klipper (confirmed from
// source: klippy/ core is unmodified). K1/K1C/K1 Max/K1 SE/Hi have no
// multi-color hardware at all — plain single-extruder Klipper. K2 adds a
// [box] module (their CFS multi-color system, gcode macros
// BOX_LOAD_MATERIAL_WITH_MATERIAL / BOX_CHECK_MATERIAL / BOX_QUIT_MATERIAL /
// BOX_INFO_REFRESH) but its logic is compiled into a closed-source
// box_wrapper.cpython-39.so, so the exact printer/objects/query?box JSON
// shape isn't known yet — applyHeadMapping/unloadFilament stay unimplemented
// here until that's captured from a real K2 (or documented) and get
// K2-specific bodies added.
//
// PAUSE/RESUME/CANCEL_PRINT are wrapped on-printer via Klipper's
// `rename_existing: *_BASE` pattern (adds parking/fan/temp-recovery
// behavior) but keep their stock macro names, and SDCARD_PRINT_FILE is
// untouched — confirmed from K2's gcode_macro.cfg — so every function below
// (identical to klipper-moonraker.js) works correctly across the whole line
// with zero Creality-specific gcode needed.
//
// Same connector, more than one physical filament configuration: a plain K1/
// K1C/K1 Max/K1 SE/Hi/K2 hotend is single-color, but a K2 with a CFS box
// attached is multi-slot. Since that's a hardware fact about a specific
// printer, not something discovery can safely infer, it's a user-set field
// on the printer (`p.filamentMode`, "single" | "cfs" — see getCapabilities
// below and the "Filament system" selector in Settings), not a capability
// baked into the connector module.
const http = require("./http-utils");

exports.label = "Creality (K1 / K2 / Hi)";
exports.brand = "Creality";
exports.capabilities = {
  camera: false, filamentHeads: false, excludeObject: true,
  // G29 (see applyHeadMapping below) is real, registered, and confirmed
  // live on K1, K1 Max, Ender-3 V3 KE, and a real Ender-3 V3 Plus — a full
  // leveling routine (home, clear old mesh, nozzle-clear, re-home, probe,
  // save), not a bare BED_MESH_CALIBRATE composed here by guesswork.
  autoLevel: true,
  unloadFilament: false, firmwareInfo: true, inventory: false, discovery: true,
  // Confirmed live against a real Ender-3 V3 Plus: it serves its own
  // proprietary web UI (title "Creality", not actually Fluidd/Mainsail) on
  // the same host/port as Moonraker — a real dashboard either way.
  webUi: true, setColor: false, singleToolhead: false,
  // K1/K1C/K1 Max/K1 SE/Hi/K2 heated beds are all spec'd to 100°C.
  maxBedTemp: 100
};

// `p.filamentMode==="cfs"` reports filamentHeads:true so the fleet card
// renders the same per-slot lane UI (afcLanesHtml) other multi-head
// connectors use, fed by the real slot colors/materials probe() reads over
// CFS's own status socket (see fetchCfsStatus/decodeCfsHeads below).
// `p.cameraUrl` (set by detectCamera below, at printer save time — see
// server.js's POST /api/config) reports camera:true once a working snapshot
// URL has actually been confirmed for that specific unit, since not every
// Creality install has a webcam attached. Every printer this connector
// hasn't detected either of those for keeps the static capabilities above
// unchanged.
function getCapabilities(p) {
  if (!p) return exports.capabilities;
  const extra = {};
  if (p.filamentMode === "cfs") extra.filamentHeads = true;
  if (p.cameraUrl) extra.camera = true;
  return Object.keys(extra).length ? { ...exports.capabilities, ...extra } : exports.capabilities;
}
exports.getCapabilities = getCapabilities;

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
    const result = {
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
    // Klipper's own print_stats.info (current_layer/total_layer) stays null
    // on real Creality Print output — confirmed live: the sliced gcode never
    // calls SET_PRINT_STATS_INFO. The total layer count IS available as
    // plain text near the top of the file in both real dialects confirmed
    // live (Cura-derived: ";LAYER_COUNT:<n>"; OrcaSlicer-derived: "total
    // layer number: <n>"), so the current layer is estimated from
    // progress × total — approximate (per-layer print time varies), but far
    // better than showing nothing. See getTotalLayers below.
    if (!result.layer && result.progress > 0 && (ps.state === "printing" || ps.state === "paused") && ps.filename) {
      try {
        const total = await getTotalLayers(p, ps.filename);
        if (total) result.layer = { current: Math.min(total, Math.max(1, Math.round(result.progress * total))), total };
      } catch { /* layer estimate is a bonus, never fail the probe over it */ }
    }
    // CFS is a separate proprietary socket from everything queried above —
    // fetched only for printers configured as such, and failure here (no
    // box attached, socket closed, older firmware) just leaves heads:[]
    // rather than failing the whole probe.
    if (p.filamentMode === "cfs") {
      try {
        const boxsInfo = await fetchCfsStatus(p);
        if (boxsInfo) {
          const decoded = decodeCfsHeads(boxsInfo);
          result.heads = decoded.heads;
          if (decoded.activeExt != null) result.activeExt = decoded.activeExt;
        }
      } catch { /* status-only — never fail the probe over this */ }
    }
    return result;
  } catch (e) {
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}
exports.probe = probe;

// Total layer count for the currently-printing file, read once per job and
// cached (a small bounded header read, not a full-file scan, and never
// re-fetched for the same printer+filename since it can't change mid-print).
// Keyed by printer URL, not id, so it's naturally invalidated if the
// printer's own address changes.
const LAYER_COUNT_CACHE = new Map(); // "url|filename" -> total layers, or null if confirmed absent
async function getTotalLayers(p, filename) {
  const key = http.baseUrl(p) + "|" + filename;
  if (LAYER_COUNT_CACHE.has(key)) return LAYER_COUNT_CACHE.get(key);
  let total = null;
  try {
    const encodedPath = filename.split("/").map(encodeURIComponent).join("/");
    const r = await http.fetchTimeout(http.baseUrl(p) + "/server/files/gcodes/" + encodedPath, 8000,
      { headers: { Range: "bytes=0-65536" } });
    if (r.ok || r.status === 206) {
      const text = await r.text();
      const cura = /;LAYER_COUNT:(\d+)/.exec(text);
      const orca = /total layer number:\s*(\d+)/i.exec(text);
      const n = cura ? parseInt(cura[1], 10) : (orca ? parseInt(orca[1], 10) : null);
      if (n > 0) total = n;
    }
  } catch { /* leave uncached (null but not stored) so a transient failure is retried next probe, not stuck forever */ return null; }
  LAYER_COUNT_CACHE.set(key, total);
  return total;
}

// ---- Creality Filament System (CFS) status (read-only) ----
// Confirmed against 3dg1luk43/ha_creality_ws's real source (ws_client.py,
// const.py, sensor.py, tools/creality_printer_test_server.py) — Creality
// runs its own proprietary websocket for CFS, separate from Moonraker, on
// the printer's IP at port 9999, no authentication:
//   ->  {"method":"get","params":{"boxsInfo":1}}
//   <-  {"boxsInfo":{"materialBoxs":[{id,state,type,temp?,humidity?,
//        materials:[{id,vendor,type,name,color,percent,state,selected}]}],
//        same_material:[...]}}
// This is status/display only: which slot is loaded and its color/material,
// same shape probe() already returns for other multi-head connectors
// (afcLanesHtml/auto-match read `heads`/`activeExt`). The print-time
// mechanism that maps a sliced file's T<n> tool changes to a specific
// physical box+slot could NOT be confirmed from any public source — it's
// not in K2_Series_Klipper's gcode_macro.cfg, and box_wrapper's own logic is
// a closed-source .so — so nothing here selects a slot or writes to a box;
// that remains unimplemented pending a confirmed source for it.
function fetchCfsStatus(p) {
  return new Promise(resolve => {
    if (typeof WebSocket === "undefined") return resolve(null); // Node <21: skip silently
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    try {
      const ip = new URL(http.baseUrl(p)).hostname;
      const ws = new WebSocket(`ws://${ip}:9999`);
      const payload = JSON.stringify({ method: "get", params: { boxsInfo: 1 } });
      const timer = setTimeout(() => { try { ws.close(); } catch {} finish(null); }, 2500);
      ws.onopen = () => ws.send(payload);
      ws.onmessage = ev => {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        try { finish(JSON.parse(ev.data).boxsInfo || null); } catch { finish(null); }
      };
      ws.onerror = () => { clearTimeout(timer); finish(null); };
      ws.onclose = () => { clearTimeout(timer); finish(null); };
    } catch { finish(null); }
  });
}

// Flattens every box's slots into the same fixed-shape `heads` array other
// multi-head connectors use, and finds whichever slot is currently feeding
// the toolhead (materials[].selected===1) for `activeExt`.
function decodeCfsHeads(boxsInfo) {
  const heads = [];
  let activeExt = null;
  const boxes = (boxsInfo && boxsInfo.materialBoxs) || [];
  for (const box of boxes) {
    for (const m of (box.materials || [])) {
      const idx = heads.length;
      const loaded = !!(m && (m.vendor || m.name || m.color));
      let hex = null;
      if (loaded && m.color) {
        const c = /^#?([0-9a-fA-F]{6})/.exec(String(m.color));
        if (c) hex = "#" + c[1].toUpperCase();
      }
      if (loaded && m.selected === 1) activeExt = idx;
      heads.push({ loaded, hex, material: loaded ? (m.type || m.name || null) : null, sub: null, official: false });
    }
  }
  return { heads, activeExt };
}

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

// Named "applyHeadMapping" only because that's the pre-print-preferences
// hook server.js calls for every connector before starting a print (see its
// `if (c.applyHeadMapping && ...)` gating) — tools/map are always empty here
// since this connector has no confirmed way to apply a head/slot assignment
// (the K2 CFS gap noted above); the only real preference is auto-level.
// `/printer/gcode/script` blocks until the macro fully finishes (standard
// Moonraker behavior, not a fire-and-forget queue), so this genuinely waits
// out the full ~1-3 minute leveling pass before the caller proceeds to
// upload/start the print — matching the intent of the checkbox: a leveled
// bed BEFORE this print, not a leveling pass racing it.
async function applyHeadMapping(p, tools, map, prefs = {}) {
  const autoLevel = prefs.autoLevel !== undefined ? !!prefs.autoLevel : !!p.autoLevel;
  if (autoLevel) await http.sendGcode(p, "G29");
}
exports.applyHeadMapping = applyHeadMapping;
// No unloadFilament — that's the K2 CFS gap noted above.

// ---- Exclude-object (stock Klipper module) ----
exports.getPlate = http.getPlate;
exports.excludeObject = http.excludeObject;

// ---- File management ----
exports.listFiles = http.listFiles;
exports.getFileMetadata = http.getFileMetadata;

// Thumbnail: embedded base64 PNG in the gcode's own header comments, NOT a
// Moonraker .thumbs/*.png sidecar file — confirmed live: the shared
// http.getThumbnail's sidecar-path convention 404s on every real
// Creality-Print-sliced file, because Creality Print embeds the image
// directly rather than Moonraker generating a separate cached file for it.
// Comment formats confirmed live on real Creality Print output, varying by
// slicer version — three so far, all seen on the same printer:
//   ; thumbnail begin <w>x<h> <size>\n(base64, "; "-prefixed per line)\n; thumbnail end
//     — the real industry-standard marker (PrusaSlicer/OrcaSlicer/
//     SuperSlicer, confirmed live on an "generated by OrcaSlicer 2.3.0"
//     file) and what Moonraker's own thumbnail scanner looks for.
//   ; thumbnail begin <w> <h> <size> (space, not "x") — confirmed live on a
//     different real file from the same printer (older Creality Print/Cura
//     engine); same block shape, just a different separator character.
//   ; png begin <w>*<h> <size> ...\n(base64, "; "-prefixed per line)\n; png end
//     — the older Cura-derived Creality Print dialect.
// Only a bounded head window is ever fetched (never the whole file, which
// can be hundreds of MB) — sized from Moonraker's own gcode_start_byte when
// available (everything before it is header/thumbnails/settings, confirmed
// live), capped so a missing or unexpectedly huge gcode_start_byte still
// can't trigger an unbounded download.
const THUMBNAIL_HEAD_CAP = 400 * 1024;

function decodeEmbeddedThumbnail(text) {
  let best = null; // picks the largest embedded size when more than one is present
  const stdRe = /;\s*thumbnail begin (\d+)[x ](\d+) \d+\r?\n([\s\S]*?);\s*thumbnail end/gi;
  let m;
  while ((m = stdRe.exec(text))) {
    const w = parseInt(m[1], 10);
    if (!best || w > best.w) best = { w, b64: m[3] };
  }
  if (!best) {
    const curaRe = /;\s*png begin (\d+)\*\d+[^\n]*\r?\n([\s\S]*?);\s*png end/g;
    while ((m = curaRe.exec(text))) {
      const w = parseInt(m[1], 10);
      if (!best || w > best.w) best = { w, b64: m[2] };
    }
  }
  if (!best) return null;
  const b64 = best.b64.split("\n").map(l => l.replace(/^;\s?/, "").trim()).filter(Boolean).join("");
  if (!b64) return null;
  try { return Buffer.from(b64, "base64"); } catch { return null; }
}

async function getThumbnail(p, file) {
  let capBytes = THUMBNAIL_HEAD_CAP;
  try {
    const { ok, json } = await http.fetchJSONTimeout(http.baseUrl(p) + "/server/files/metadata?filename=" + encodeURIComponent(file), 5000);
    const startByte = ok && (json.result || {}).gcode_start_byte;
    if (typeof startByte === "number" && startByte > 0) capBytes = Math.min(THUMBNAIL_HEAD_CAP, startByte);
  } catch { /* fall back to the flat cap below */ }
  const encodedPath = file.split("/").map(encodeURIComponent).join("/");
  const r = await http.fetchTimeout(http.baseUrl(p) + "/server/files/gcodes/" + encodedPath, 8000,
    { headers: { Range: `bytes=0-${capBytes}` } });
  if (!r.ok && r.status !== 206) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  const buffer = decodeEmbeddedThumbnail(await r.text());
  if (!buffer) { const e = new Error("No embedded thumbnail found"); e.status = 404; throw e; }
  return { contentType: "image/png", buffer };
}
exports.getThumbnail = getThumbnail;

// ---- Firmware (generic Moonraker query) ----
exports.getFirmwareInfo = http.queryFirmwareInfo;

// ---- Camera detection + snapshot ----
// Earlier assumption here (K1/K2 firmware docs describing a closed-source
// shell capture utility) turned out not to hold across the whole line: a
// real Ender-3 V3 Plus confirmed live actually runs a standard
// crowsnest/MJPG-Streamer setup, discoverable through Moonraker's own
// GET /server/webcams/list (the same registry Fluidd/Mainsail read). Whether
// any given unit has a camera at all is genuinely per-printer (confirmed via
// two real units of the same model, one with a camera and one without) —
// not a fixed connector-level fact — so detection runs once per printer at
// save time (see server.js's POST /api/config) and the result is stored on
// the printer record (`cameraUrl`), not assumed here.
//
// The registry's stream_url/snapshot_url are relative paths meant to be
// resolved by whatever reverse-proxies the printer's main web port (nginx,
// on a standard Fluidd/crowsnest install) — but Creality's own port-80 httpd
// doesn't proxy that path (confirmed live: 404), while the underlying
// MJPG-Streamer process is reachable directly on its own default port 8080
// (confirmed live: real JPEG). Since which of those actually works isn't
// knowable without asking the printer, every candidate is tried and the
// first one that returns a real image wins.
async function detectCamera(p) {
  const { ok, json } = await http.fetchJSONTimeout(http.baseUrl(p) + "/server/webcams/list", 3000);
  if (!ok) throw new Error("Moonraker unreachable"); // caller retries on a later save, doesn't cache a false negative
  const webcams = (json.result || {}).webcams || [];
  if (!webcams.length) return null; // confirmed, not just unreachable: no camera configured
  const rel = webcams[0].snapshot_url || webcams[0].stream_url;
  if (!rel) return null;
  let hostname, path, query;
  try {
    hostname = new URL(http.baseUrl(p)).hostname;
    const u = new URL(rel, "http://placeholder");
    path = u.pathname; query = u.search;
  } catch { return null; }
  const candidates = [
    `http://${hostname}${path}${query}`,        // as-published, printer's own web port (works if it's a real proxy)
    `http://${hostname}:8080/${query}`,          // MJPG-Streamer's own default port, root-served
    `http://${hostname}:8080${path}${query}`     // same port, in case the published path is also kept there
  ];
  for (const url of candidates) {
    try {
      const r = await http.fetchTimeout(url, 2500);
      if (r.ok && (r.headers.get("content-type") || "").startsWith("image/")) return url;
    } catch { /* try the next candidate */ }
  }
  return null; // a webcam was registered but no candidate actually resolved to an image
}
exports.detectCamera = detectCamera;

async function getCameraSnapshot(p) {
  if (!p.cameraUrl) throw new Error("No camera detected for this printer");
  const r = await http.fetchTimeout(p.cameraUrl, 5000);
  if (!r.ok) throw new Error("Camera HTTP " + r.status);
  return { contentType: r.headers.get("content-type") || "image/jpeg", buffer: Buffer.from(await r.arrayBuffer()) };
}
exports.getCameraSnapshot = getCameraSnapshot;

// No getInventory — there's no genuine per-unit serial number exposed
// anywhere: confirmed live against a real printer that
// `machine/system_info`'s cpu_info.serial_number
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
exports._internal = { decodeCfsHeads, fetchCfsStatus, decodeEmbeddedThumbnail, getTotalLayers, LAYER_COUNT_CACHE };

async function discoverAt(base) {
  const { ok, json } = await http.fetchJSONTimeout(`${base}/printer/info`, 900);
  if (!ok) return null;
  const hostname = (json.result || {}).hostname || "";
  if (!/^(ender|cr-?\d|k1|k2|creality)/i.test(hostname)) return null;
  return { url: base, device_name: hostname, machine_type: hostname, serial: null, mac: null };
}
exports.discoverAt = discoverAt;
