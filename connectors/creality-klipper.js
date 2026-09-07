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

exports.label = "Creality (Klipper)";
exports.brand = "Creality";
// Address contract: same Moonraker default as generic Klipper, and
// editable for the same reason.
exports.address = { scheme: "http", defaultPort: 7125, portEditable: true, required: true };
exports.capabilities = {
  camera: false, filamentHeads: false, excludeObject: true,
  // G29 (see applyHeadMapping below) is real, registered, and confirmed
  // live on K1, K1 Max, Ender-3 V3 KE, and a real Ender-3 V3 Plus — a full
  // leveling routine (home, clear old mesh, nozzle-clear, re-home, probe,
  // save), not a bare BED_MESH_CALIBRATE composed here by guesswork.
  autoLevel: true,
  unloadFilament: false, firmwareInfo: true, inventory: false, discovery: true, health: true, fileSync: true,
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
// Two independent camera transports, reported as additive flags rather than
// a nested object: `camera` keeps its existing meaning ("there is a camera to
// show") for the four places the frontend already gates on it, and the two
// new flags say HOW it can be reached. A connector that declares neither
// reads as false on both, so nothing else changes.
//   cameraSnapshot — server-side getCameraSnapshot(): /api/snapshot, the
//                    camera-view grid's JPEG polling, notification images.
//   cameraWebrtc   — browser-side only (see detectCameraWebrtc): live view
//                    and a canvas-captured manual snapshot, no server path.
function getCapabilities(p) {
  if (!p) return exports.capabilities;
  const extra = {};
  if (p.filamentMode === "cfs") extra.filamentHeads = true;
  if (p.cameraUrl) { extra.camera = true; extra.cameraSnapshot = true; }
  else if (p.cameraWebrtc) { extra.camera = true; extra.cameraWebrtc = true; }
  return Object.keys(extra).length ? { ...exports.capabilities, ...extra } : exports.capabilities;
}
exports.getCapabilities = getCapabilities;

// ---- Fleet status ----
// Same stock-Klipper query as klipper-moonraker.js — no [box] fields read
// yet (see file header). Kept as its own copy (not a re-export from
// klipper-moonraker.js) so this connector stays independently editable when
// K2 CFS support lands, without touching another brand's file.
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
    const result = {
      name: p.name, online: true,
      state: fault ? fault.state : (ps.state || "unknown"),
      message: fault ? fault.message : (ps.message || ""),
      errorCode: fault ? fault.errorCode : "",
      filename: ps.filename || "",
      // display_status.progress tracks real gcode EXECUTION; virtual_sdcard.
      // progress tracks how far Klipper's SD-card reader has read AHEAD into
      // its own buffer, which can run well past a long blocking macro (e.g.
      // this printer's own START_PRINT, confirmed live to run several
      // minutes of leveling before the first real extrusion command) even
      // though nothing has actually printed yet — confirmed live: SnapCon
      // showed 3.6%/"layer 7" from virtual_sdcard while Fluidd (reading
      // display_status) correctly showed 0%, mid-leveling, nothing executed.
      // display_status is preferred first now; virtual_sdcard is still the
      // fallback for a printer.cfg with no [display_status] section at all
      // (a real gap on some headless/Moonraker-only setups), where
      // ds.progress would never be a number to begin with.
      progress: typeof ds.progress === "number" ? ds.progress : (typeof (st.virtual_sdcard || {}).progress === "number" ? st.virtual_sdcard.progress : 0),
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
    // plain text near the top or tail of the file across the confirmed
    // dialects (Cura: ";LAYER_COUNT:<n>"; OrcaSlicer: "total layer number:
    // <n>"; Creality Print: "total layers count = <n>") — see
    // getTotalLayers below. For the CURRENT layer, this printer's
    // virtual_sdcard also exposes a real, smoothly-incrementing `layer`
    // field — a Creality-specific extension, not stock Klipper — confirmed
    // live to advance by exactly 1 per layer while display_status.progress
    // (the source for result.progress above) only updates in coarse
    // whole-percent steps, which made a progress×total estimate jump by 2+
    // layers at a time. Prefer the real counter; fall back to the
    // progress×total estimate only when virtual_sdcard.layer isn't a valid
    // positive number (e.g. a printer.cfg build that doesn't expose it).
    if (!result.layer && result.progress > 0 && (ps.state === "printing" || ps.state === "paused") && ps.filename) {
      try {
        const total = await getTotalLayers(p, ps.filename);
        if (total) {
          const vsLayer = (st.virtual_sdcard || {}).layer;
          result.layer = (typeof vsLayer === "number" && vsLayer > 0)
            ? { current: Math.min(total, vsLayer), total }
            : { current: Math.min(total, Math.max(1, Math.round(result.progress * total))), total };
        }
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

// Cura (;LAYER_COUNT:<n>, conventionally near the top) and OrcaSlicer
// ("total layer number: <n>") were the two known dialects here. Confirmed
// live on a real Creality-Print-sliced file (the same slicer this
// printer's own config identifies itself with — see printer_settings_id in
// parser.js) that it uses a THIRD, different phrasing: "; total layers
// count = <n>" — and confirmed that line lives in the slicer's config-
// summary block near the END of the file, not the start.
function findLayerCount(text) {
  const cura = /;LAYER_COUNT:(\d+)/.exec(text);
  if (cura) return parseInt(cura[1], 10);
  const orca = /total layer number:\s*(\d+)/i.exec(text);
  if (orca) return parseInt(orca[1], 10);
  const creality = /total layers count\s*=\s*(\d+)/i.exec(text);
  if (creality) return parseInt(creality[1], 10);
  return null;
}

// Total layer count for the currently-printing file, read once per job and
// cached (two small bounded reads — head and tail — not a full-file scan,
// and never re-fetched for the same printer+filename since it can't change
// mid-print). Both ends are checked since different slicer dialects place
// their layer-count comment in different places (Cura conventionally near
// the top; OrcaSlicer/Creality Print's own config-summary block confirmed
// live at the bottom of a 3MB+ file, well past a head-only read). Keyed by
// printer URL, not id, so it's naturally invalidated if the printer's own
// address changes.
const LAYER_COUNT_CACHE = new Map(); // "url|filename" -> total layers, or null if confirmed absent
async function getTotalLayers(p, filename) {
  const key = http.baseUrl(p) + "|" + filename;
  if (LAYER_COUNT_CACHE.has(key)) return LAYER_COUNT_CACHE.get(key);
  let total = null;
  try {
    const encodedPath = filename.split("/").map(encodeURIComponent).join("/");
    const url = http.baseUrl(p) + "/server/files/gcodes/" + encodedPath;
    const [head, tail] = await Promise.all([
      http.fetchTimeout(url, 8000, { headers: { Range: "bytes=0-65536" } }),
      // A suffix range ("last N bytes") — confirmed live to work against
      // Moonraker's own file server (returns 206 Partial Content, correctly
      // clamped when the whole file is smaller than the requested range).
      http.fetchTimeout(url, 8000, { headers: { Range: "bytes=-65536" } })
    ]);
    let n = null;
    if (head.ok || head.status === 206) n = findLayerCount(await head.text());
    if (n === null && (tail.ok || tail.status === 206)) n = findLayerCount(await tail.text());
    if (n > 0) total = n;
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
      // The printer streams status asynchronously and answers this query a few
      // frames later — captured live on a SPARKX i7 with a CFS attached: 33
      // messages over 20s, boxsInfo in exactly one of them (index 2, ~50ms in).
      // Resolving on the FIRST message therefore read a status frame, found no
      // boxsInfo and reported a working CFS as absent. Keep listening until the
      // answer arrives or the existing timeout fires.
      //
      // Note the status frame also carries cfsConnect: 0 on a printer whose CFS
      // is plainly attached and enumerating slots, so that field is deliberately
      // not used as a presence check — the boxsInfo payload itself is.
      ws.onmessage = ev => {
        if (done) return;                   // already answered — cleanup is once-only
        let boxsInfo = null;
        try { boxsInfo = JSON.parse(ev.data).boxsInfo || null; } catch { boxsInfo = null; }
        if (!boxsInfo) return;              // status noise — keep waiting
        clearTimeout(timer);
        try { ws.close(); } catch {}
        finish(boxsInfo);
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
// Local overrides below, not http-utils.js's shared 8s "fast command"
// default: confirmed live, repeatedly, that this printer's own Moonraker/
// SBC can genuinely take longer than 8s to respond to a basic print-control
// command while otherwise working correctly — first found with
// SDCARD_PRINT_FILE right after a G29 leveling pass (confirmed via a live
// probe immediately after: state:"printing", virtual_sdcard.is_active:true
// — the print was genuinely running, SnapCon had just given up waiting and
// reported a false failure), then again with a plain CANCEL_PRINT (printer
// cancelled immediately for real; SnapCon still reported "did not respond
// within 8000ms"). A longer, explicit bound avoids reporting a false
// failure for a command that's actually working, for every ordinary
// print-control action.
//
// estop is the deliberate exception — NOT given a longer timeout, still
// exports.estop = http.estop unchanged below. E-Stop is the one action
// where a longer wait is the wrong tradeoff: in a real emergency the
// operator needs to know FAST if the command isn't landing, not have
// SnapCon quietly wait longer hoping it eventually works — an unresponsive
// printer during an E-Stop may need the operator to act physically (pull
// power) instead of waiting on it.
const CONTROL_TIMEOUT_MS = 60 * 1000;

// assertSafeGcodeArg's check is duplicated here rather than reaching into
// http-utils.js for it (it's exported test-only there) — the same trivial,
// well-understood guard http-utils.js's own startPrintFile already applies
// before interpolating a filename into a literal gcode script line.
function assertSafeGcodeArg(value) {
  if (/["\r\n]/.test(String(value))) throw new Error("Invalid characters in gcode argument");
  return value;
}
async function startPrintFile(p, filename) {
  await http.sendGcode(p, `SDCARD_PRINT_FILE FILENAME="${assertSafeGcodeArg(filename)}"`, CONTROL_TIMEOUT_MS);
}
exports.startPrintFile = startPrintFile;
exports.pause = p => http.sendGcode(p, "PAUSE", CONTROL_TIMEOUT_MS);
exports.resume = p => http.sendGcode(p, "RESUME", CONTROL_TIMEOUT_MS);
exports.cancel = p => http.sendGcode(p, "CANCEL_PRINT", CONTROL_TIMEOUT_MS);
exports.eject = p => http.sendGcode(p, "SDCARD_RESET_FILE", CONTROL_TIMEOUT_MS);
exports.estop = http.estop; // deliberately unchanged — see comment above
exports.bedTemp = (p, t) => http.sendGcode(p, "M140 S" + Math.round(t), CONTROL_TIMEOUT_MS);

// Named "applyHeadMapping" only because that's the pre-print-preferences
// hook server.js calls for every connector before starting a print (see its
// `if (c.applyHeadMapping && ...)` gating) — tools/map are always empty here
// since this connector has no confirmed way to apply a head/slot assignment
// (the K2 CFS gap noted above); the only real preference is auto-level.
// `/printer/gcode/script` blocks until the macro fully finishes (standard
// Moonraker behavior, not a fire-and-forget queue), so this genuinely waits
// out the full leveling pass before the caller proceeds to upload/start the
// print — matching the intent of the checkbox: a leveled bed BEFORE this
// print, not a leveling pass racing it.
async function applyHeadMapping(p, tools, map, prefs = {}) {
  const autoLevel = prefs.autoLevel !== undefined ? !!prefs.autoLevel : !!p.autoLevel;
  // Generous explicit bound (not the default 8s fast-command timeout). A
  // real K1C's own klippy.log showed a live PRTOUCH full-bed G29 pass still
  // probing past the originally-documented "~1-3 minutes" — an abort here
  // does NOT stop the physical macro (Klipper has no idea the HTTP client
  // gave up), so a too-short bound doesn't just show a slow-but-harmless
  // error: it silently orphans the print, since the caller (server.js)
  // never reaches startPrintFile once this rejects, even though the printer
  // goes on to finish leveling successfully a few minutes later on its own.
  // 12 minutes gives real headroom above what's been observed live.
  if (autoLevel) await sendG29WithRecovery(p);
}

// A real K1C's own connection to Moonraker has been observed, live and
// repeatedly (including 2-3 times on the SAME print, back to back), to drop
// mid-G29 with a bare connection-level failure ("Could not reach <name>:
// fetch failed" — http-utils.js's moonrakerPost, NOT a timeout and NOT a
// real HTTP error response from Moonraker) — plausibly the printer's own
// SBC struggling to keep servicing Moonraker's HTTP port while it's busy
// with unusually heavy retransmit traffic to the leveling MCU sub-board
// during active probing (confirmed via klippy.log — a hardware/firmware
// reliability characteristic of the printer, not something this connector
// can fix outright).
//
// The mesh itself keeps probing and saves successfully on the printer
// regardless of whether SnapCon's HTTP connection survived to see it —
// confirmed live: "Mesh Bed Leveling Complete" still appears in klippy.log
// even on a run where the HTTP call to send G29 had already failed client-
// side. So blindly RESENDING G29 after a drop is actively counterproductive
// when drops recur during the same pass, as observed: each resend restarts
// the whole multi-minute probe from zero, and if the connection is flaky
// for the pass's whole duration, every resend can hit the same drop again,
// burning many multiples of the real leveling time for nothing (confirmed:
// 3 resends, 3 drops, print failed after ~15 minutes of no forward
// progress).
//
// Instead: snapshot the currently-saved mesh before sending G29. If the
// send drops with this specific connection-level error, don't resend it —
// poll the printer with cheap reachability checks until it responds again,
// then confirm the saved mesh actually changed (real evidence a fresh pass
// completed, not just a guess based on elapsed time) before proceeding.
// Never applies to a real rejection from Moonraker/Klipper (a non-2xx
// response) or a timeout (the 12-minute bound is already generous) —
// those indicate a genuine problem retrying/waiting wouldn't fix.
const MESH_RECOVERY_POLL_INTERVAL_MS = 10 * 1000;
const MESH_RECOVERY_TIMEOUT_MS = 12 * 60 * 1000;

// null means "no usable fingerprint right now" — either unreachable, or a
// pass is actively in progress. Confirmed live, mid-G29 on a real K1C:
// bed_mesh.probed_matrix is cleared to an empty shape ([[]]) the INSTANT a
// new pass starts, and only repopulated once the whole pass finishes —
// profile_name is blanked the same way, while profiles.default.points (the
// last-SAVED config, untouched until save_config at the very end) keeps
// showing the previous pass's data throughout. An earlier version of this
// compared raw probed_matrix values directly, which meant "the old mesh
// just got cleared to start a new pass" (probed_matrix: [[]], genuinely
// different from the populated "before" snapshot) was wrongly read as
// "leveling already finished" — treating an empty/unpopulated matrix as "no
// fingerprint" (same as unreachable) instead of a real value fixes that: it
// can never be mistaken for a legitimately different, freshly-completed
// mesh, so the caller keeps waiting until a real one appears.
async function readMeshFingerprint(p) {
  try {
    const { ok, json } = await http.fetchJSONTimeout(http.baseUrl(p) + "/printer/objects/query?bed_mesh", 5000);
    if (!ok) return null;
    const mesh = json.result && json.result.status && json.result.status.bed_mesh;
    const matrix = mesh && mesh.probed_matrix;
    if (!matrix || !matrix.length || !matrix.some(row => row && row.length)) return null;
    return JSON.stringify(matrix);
  } catch {
    return null;
  }
}

async function waitForFreshMesh(p, before) {
  const deadline = Date.now() + MESH_RECOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, MESH_RECOVERY_POLL_INTERVAL_MS));
    const now = await readMeshFingerprint(p);
    if (now !== null && now !== before) {
      console.log(`[creality] ${p.name}: reconnected — a new bed mesh was saved, treating G29 as complete`);
      return;
    }
  }
  throw new Error(`${p.name}: lost connection during G29 and never confirmed the leveling pass finished (bed mesh unchanged after ${Math.round(MESH_RECOVERY_TIMEOUT_MS / 60000)} minutes)`);
}

async function sendG29WithRecovery(p) {
  const before = await readMeshFingerprint(p);
  try {
    await http.sendGcode(p, "G29", 12 * 60 * 1000);
  } catch (e) {
    if (!/^Could not reach /.test(e.message)) throw e;
    console.log(`[creality] ${p.name}: lost connection during G29 (${e.message}) — the physical pass keeps running on the printer independent of this HTTP connection, so waiting for it to reconnect and confirm a new mesh was saved instead of resending G29`);
    await waitForFreshMesh(p, before);
  }
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
exports.getHealth = http.queryHealth;
exports.querySyncFiles = http.queryRemoteFileList;
exports.downloadSyncFile = http.downloadRemoteFile;
exports.deleteSyncFile = http.deleteRemoteFile;

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

// Some Creality machines (confirmed on an F022 / SPARKX i7) ship a camera
// that is reachable ONLY over WebRTC: Moonraker's own webcam component is
// stripped (/server/webcams/list is empty, the webcams DB namespace does not
// exist), and a separate service on port 8000 answers a WebRTC offer. There
// is no still-image endpoint at any path on it, so this can never feed
// getCameraSnapshot() — it is a browser-side transport only.
//
// Probed exactly like detectCamera above: a reachable service that answers
// is a confirmed yes, an unreachable one throws so the caller retries on a
// later save instead of caching a false negative. The device answers HTTP
// 200 with a literal "{}" for anything it doesn't understand, so a status
// code alone proves nothing — the decoded payload has to be a real answer.
const WEBRTC_PORT = 8000;
const WEBRTC_SIGNAL_PATH = "/call/webrtc_local";
function webrtcSignalUrl(p) {
  try { return `http://${new URL(http.baseUrl(p)).hostname}:${WEBRTC_PORT}${WEBRTC_SIGNAL_PATH}`; }
  catch { return null; }
}
// A minimal, syntactically valid recv-side offer: enough for the device to
// produce an answer, without pulling in a media stack server-side.
const WEBRTC_PROBE_SDP = [
  "v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0",
  "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:snapcon", "a=ice-pwd:snapconsnapconsnapcon",
  "a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF",
  "a=setup:actpass", "a=mid:0", "a=recvonly", "a=rtcp-mux", "a=rtpmap:96 H264/90000", ""
].join("\r\n");
async function detectCameraWebrtc(p) {
  const url = webrtcSignalUrl(p);
  if (!url) return null;
  const body = Buffer.from(JSON.stringify({ type: "offer", sdp: WEBRTC_PROBE_SDP })).toString("base64");
  const r = await http.fetchTimeout(url, 3000, { method: "POST", headers: { "Content-Type": "plain/text" }, body });
  if (!r.ok) throw new Error("WebRTC signaling unreachable"); // retried on a later save
  const text = (await r.text()).trim();
  let answer;
  try { answer = JSON.parse(Buffer.from(text, "base64").toString("utf8")); }
  catch { return null; } // "{}" or anything undecodable: confirmed not a WebRTC camera
  return (answer && answer.type === "answer" && typeof answer.sdp === "string") ? url : null;
}
exports.detectCameraWebrtc = detectCameraWebrtc;
exports.webrtcSignalUrl = webrtcSignalUrl;

// ---- Model detection ----
// This connector covers several physically different machines, and they do
// not behave identically (the i7 alone has the WebRTC camera; it also has no
// part-cooling `fan` object at all). Creality stamps an internal model code
// into the first line of printer.cfg — confirmed across three live units:
//
//   # F002   Ender-3 V3 Plus   (300x300x330)   both units report F002
//   # F022   SPARKX i7         (260x260x300)
//
// printer.cfg is the source, NOT the hostname: one V3 Plus reported
// "v3-brown" (renamed by its owner) and the other still the factory
// "Ender-3", while both agreed on F002. The i7's hostname happens to start
// with its code, which is exactly the coincidence that would have made
// hostname parsing look correct.
//
// An unrecognised code returns its raw value rather than null, so a model
// this table has never seen still identifies itself instead of vanishing.
const MODEL_CODES = { F002: "Ender-3 V3 Plus", F022: "SPARKX i7" };
// The one model confirmed to serve a WebRTC camera. Kept as a list so the
// gate reads as a fact about specific machines rather than a magic string.
const WEBRTC_CAMERA_MODELS = ["F022"];
async function detectModel(p) {
  const r = await http.fetchTimeout(http.baseUrl(p) + "/server/files/config/printer.cfg", 3000);
  if (!r.ok) throw new Error("Moonraker unreachable"); // retried on a later save
  // Only the header matters; printer.cfg can be hundreds of lines.
  const head = (await r.text()).slice(0, 400);
  const m = /^\s*#\s*(F\d{3})\b/m.exec(head);
  if (!m) return null; // confirmed readable, but no model stamp in this firmware
  const code = m[1].toUpperCase();
  return { code, label: MODEL_CODES[code] || code };
}
exports.detectModel = detectModel;
exports.modelHasWebrtcCamera = code => WEBRTC_CAMERA_MODELS.includes(String(code || "").toUpperCase());

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
exports._internal = { decodeCfsHeads, fetchCfsStatus, decodeEmbeddedThumbnail, getTotalLayers, LAYER_COUNT_CACHE, MESH_RECOVERY_POLL_INTERVAL_MS, MESH_RECOVERY_TIMEOUT_MS };

async function discoverAt(base) {
  const { ok, json } = await http.fetchJSONTimeout(`${base}/printer/info`, 900);
  if (!ok) return null;
  const hostname = (json.result || {}).hostname || "";
  if (!/^(ender|cr-?\d|k1|k2|creality)/i.test(hostname)) return null;
  return { url: base, device_name: hostname, machine_type: hostname, serial: null, mac: null };
}
exports.discoverAt = discoverAt;
