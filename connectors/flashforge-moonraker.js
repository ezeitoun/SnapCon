// connectors/flashforge-moonraker.js — Moonraker transport for FlashForge
// printers running a firmware mod (ZMOD ghzserg/zmod, Forge-X DrA1ex/ff5m).
// Both mods take the stock 8898 API down and serve Moonraker on 7125 instead.
//
// This is the transport half only — the same role flashforge-utils.js plays for
// the native :8898 API. It owns base URL, liveness, the common status query,
// config-file reads, macro dispatch, and camera URL resolution. It must NOT
// own mode detection (that's flashforge-mode.js) or FlashForge model semantics
// like the AD5X's IFS slots (that's flashforge-ad5x.js).
const http = require("./http-utils");

// Moonraker's default port. Stored FlashForge URLs are host-only — the native
// connector applies 8898 itself (flashforge-utils.js baseUrl), which is what
// keeps existing configs byte-identical — so this has to apply 7125 the same
// way. http.baseUrl() returns p.url verbatim and appends nothing, so a modded
// printer stored as "http://192.0.2.10" would otherwise hit :80 and get
// Fluidd's HTML instead of Moonraker's JSON.
const MOONRAKER_PORT = "7125";
const baseUrl = p => {
  let u = String(p.url).replace(/\/+$/, "");
  try {
    const parsed = new URL(u);
    if (!parsed.port) { parsed.port = MOONRAKER_PORT; u = parsed.toString().replace(/\/+$/, ""); }
  } catch { /* not a fully-qualified URL — leave it as typed */ }
  return u;
};

// Which host:port a given transport should talk to, for one printer.
//
// AUTO   — a stored port equal to a CONVENTIONAL transport default tells Auto
//          nothing it does not already know, so it is not authoritative and
//          each transport uses its own default. Any other port is information
//          Auto lacks, and IS authoritative for both transports.
// PINNED — the stored port is ALWAYS authoritative, including unusual pairings
//          such as Moonraker on 8898 or native on 7125. That is the escape
//          hatch for a genuinely remapped service.
//
// The two conventional ports are supplied by the CALLER, so this module encodes
// no belief about which protocol may live on which port. Nothing here says
// "8898 can only be native"; the pinned rows exist to prove it.
//
// Why the auto exception exists at all: SnapCon's own Settings row used to
// pre-fill 8898 into every FlashForge printer (address.defaultPort), so stored
// 8898s are indistinguishable from deliberate ones and cannot be migrated. See
// docs/superpowers/specs/flashforge-dual-transport-design.md.
function resolveEndpoint(p, { want, nativePort, moonrakerPort }) {
  const def = String(want === "native" ? nativePort : moonrakerPort);
  let u;
  try { u = new URL(String(p.url).replace(/\/+$/, "")); } catch { return String(p.url); }
  const stored = u.port;
  const pinned = p.transport === "native" || p.transport === "moonraker";
  const conventional = stored === String(nativePort) || stored === String(moonrakerPort);
  u.port = pinned ? (stored || def) : ((!stored || conventional) ? def : stored);
  return u.toString().replace(/\/+$/, "");
}

// Liveness only. Used as the moonraker thunk handed to flashforge-mode.resolve()
// — it answers "is there a Moonraker here", nothing more.
async function ping(p, ms = 3500) {
  const { ok, status, json } = await http.fetchJSONTimeout(baseUrl(p) + "/printer/info", ms);
  if (!ok) throw new Error("Moonraker " + status);
  // A 200 is not enough. A FlashForge box with wrong credentials answers 200
  // with {code, message} on every path it knows, so accepting any 200 here
  // would detect Moonraker on a stock printer and bury its real auth error.
  // Every genuine Moonraker reply carries a `result` object.
  if (!json || typeof json.result !== "object" || json.result === null) {
    throw new Error("Not a Moonraker endpoint");
  }
  return true;
}

// The status fields every Moonraker printer reports, normalized into the same
// shape every SnapCon connector's probe() returns. Deliberately contains no
// `heads`, no IFS, and no FlashForge model specifics — a caller that needs
// those adds them itself (see flashforge-ad5x.js). `extra` lets a caller append
// objects to the same single query rather than paying for a second round trip.
const BASE_OBJECTS = ["print_stats", "display_status", "virtual_sdcard", "heater_bed",
  "extruder", "fan", "gcode_move", "toolhead", "exclude_object"];

async function probeCommon(p, extra = [], ms = 3500) {
  const q = BASE_OBJECTS.concat(extra).map(encodeURIComponent).join("&");
  const { ok, status, json: j } = await http.fetchJSONTimeout(baseUrl(p) + "/printer/objects/query?" + q, ms);
  if (!ok) throw new Error("Moonraker " + status);
  const st = (j.result && j.result.status) || {};
  const ps = st.print_stats || {};
  const ds = st.display_status || {};
  const hb = st.heater_bed || {};
  const ext = st.extruder || {};
  const th = st.toolhead || {};
  const fan = st.fan || {};
  const gm = st.gcode_move || {};
  const psi = ps.info || {};
  const eo = st.exclude_object || {};
  return {
    status: st,
    state: {
      name: p.name, online: true,
      state: ps.state || "unknown",
      message: ps.message || "",
      errorCode: "",
      filename: ps.filename || "",
      progress: typeof (st.virtual_sdcard || {}).progress === "number" ? st.virtual_sdcard.progress
        : (typeof ds.progress === "number" ? ds.progress : 0),
      elapsed: typeof ps.print_duration === "number" ? ps.print_duration : null,
      filamentUsed: typeof ps.filament_used === "number" ? ps.filament_used : null,
      bed: (typeof hb.temperature === "number") ? { temp: Math.round(hb.temperature), target: Math.round(hb.target || 0) } : null,
      hotend: (typeof ext.temperature === "number") ? { temp: Math.round(ext.temperature), target: Math.round(ext.target || 0) } : null,
      layer: (psi.current_layer != null) ? { current: psi.current_layer, total: psi.total_layer || 0 } : null,
      speed: (typeof gm.speed_factor === "number") ? Math.round(gm.speed_factor * 100) : null,
      fanPct: (typeof fan.speed === "number") ? Math.round(fan.speed * 100) : null,
      activeExt: typeof th.extruder === "string" ? parseInt(th.extruder.replace("extruder", "") || "0", 10) : null,
      plate: (eo.objects && eo.objects.length)
        ? { total: eo.objects.length, excluded: (eo.excluded_objects || []).length, current: eo.current_object || null }
        : null,
      heads: []
    }
  };
}

// Which objects this printer actually has. Read once at detection, not per
// poll — capability decisions are the caller's, this only reports what exists.
async function listObjects(p, ms = 5000) {
  const { ok, json } = await http.fetchJSONTimeout(baseUrl(p) + "/printer/objects/list", ms);
  if (!ok) return [];
  return ((json || {}).result || {}).objects || [];
}

// ---- camera ----
//
// snapshot_url / stream_url are printer-returned strings crossing a trust
// boundary, so they are untrusted input (CLAUDE.md §8). A real Forge-X printer
// on this fleet advertises enabled:true with
// "http://198.51.100.23/webcam/?action=snapshot" — a different host, on a
// different subnet, which does not resolve. Honouring that would (a) make
// SnapCon issue GETs to arbitrary internal addresses on behalf of whatever can
// write the printer's webcam database, and (b) add a dead-host timeout to every
// camera poll across the fleet.
//
// The host is therefore never taken from the printer. Only the path and query
// are kept and rebuilt against the printer's own configured host — the same
// approach creality-klipper.js's detectCamera() already uses. What's added here
// is dropping disabled entries, and the redirect handling below.
const MAX_REDIRECTS = 3;

function sameHost(a, b) {
  try { return new URL(a).hostname === new URL(b).hostname; } catch { return false; }
}

// Rebuilds any webcam URL onto the printer's own origin, keeping ONLY the path
// and query. The supplied host, scheme, credentials and port are all discarded
// — the printer describes WHERE ON ITSELF its camera lives, and nothing more.
//
// This is deliberately not a rejection: a real Forge-X printer on this fleet
// advertises http://198.51.100.23/webcam/?action=snapshot — a host that does not
// resolve — while serving a genuine 76KB JPEG at that same path on ITSELF.
// Refusing the entry for its host would disable a camera that demonstrably
// works; rebuilding recovers it, and the foreign host is still never contacted.
// Which ports on the printer to try, in order. Same shape as
// creality-klipper.js's detectCamera(): a camera proxy usually sits on the
// standard web port, but it can be on whatever port the printer is configured
// on (a reverse proxy fronting everything) or on MJPG-Streamer's own 8080.
// Verification decides between them — this only proposes.
function candidatePorts(p) {
  let configured = "";
  try { configured = new URL(baseUrl(p)).port || ""; } catch { configured = ""; }
  return [...new Set(["", configured, "8080"])];
}

function onPrinterHost(p, raw, port = "") {
  let origin;
  try {
    const b = new URL(baseUrl(p));
    // The printer's own scheme and host. Any supplied host, scheme,
    // credentials or port is discarded here — this is the single point where
    // the destination is decided, and the printer has no say in it.
    origin = `${b.protocol}//${b.hostname}${port ? ":" + port : ""}`;
  } catch { return null; }
  let path, query;
  try {
    // The base is a throwaway: only pathname/search are read out of it, so a
    // supplied absolute URL contributes nothing but its path.
    const u = new URL(raw, "http://placeholder");
    path = u.pathname; query = u.search;
  } catch { return null; }
  return origin + path + query;
}

// The first ENABLED webcam whose rebuilt candidate actually serves an image —
// or null. Mechanics only: it makes no capability decision, which is the model
// connector's job.
//
// Verification is required rather than optional. A rebuilt candidate is a
// hypothesis ("the camera is probably at this path on the printer"), and
// advertising camera:true on an unverified hypothesis is what produces a
// permanently broken tile and a dead-host timeout on every poll.
async function resolveWebcam(p, ms = 3000) {
  const { ok, json } = await http.fetchJSONTimeout(baseUrl(p) + "/server/webcams/list", ms);
  if (!ok) return null;
  const cams = ((json || {}).result || {}).webcams || [];
  for (const cam of cams) {
    // Both Forge-X boxes ship a disabled "Example" placeholder at index 0, so
    // taking webcams[0] blindly would pick a stub over a real camera.
    if (!cam || !cam.enabled) continue;
    // snapshot_url first: stream_url is an endless MJPEG stream, which is not
    // something to verify by reading.
    const raw = cam.snapshot_url || cam.stream_url;
    if (!raw) continue;
    for (const port of candidatePorts(p)) {
      const candidate = onPrinterHost(p, raw, port);
      if (!candidate) continue;
      try {
        await fetchSnapshot(p, candidate, 4000);
        return candidate;
      } catch { /* not this port — try the next, then the next entry */ }
    }
  }
  return null;
}

// Fetch a camera frame with redirects handled manually. Node's fetch defaults
// to redirect:"follow", which would silently chase a 302 off the printer's
// host — validating only the initial URL is not enough. Every hop is checked
// before it is followed, and the hop count is bounded independently of the host
// check so a printer redirecting to ITSELF forever still terminates.
async function fetchSnapshot(p, url, ms = 5000) {
  // The timeout must span the BODY read, not just the headers. http-utils'
  // fetchTimeout clears its timer as soon as the response resolves (see its own
  // note), which is fine for JSON but not here: an MJPEG stream_url answers
  // headers immediately and then never ends, so arrayBuffer() would hang
  // forever on a poll thread.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Checked before EVERY request, initial and each redirect alike — the
      // printer never gets to choose the host we contact.
      if (!sameHost(target, baseUrl(p))) {
        throw new Error("Camera URL is not on the printer's host: " + target);
      }
      const r = await fetch(target, { redirect: "manual", signal: ctrl.signal });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) throw new Error("Camera redirect with no location");
        // Resolve a relative Location against the current target, then let the
        // top of the loop re-apply the host rule to it before it is followed.
        target = new URL(loc, target).toString();
        continue;
      }
      if (!r.ok) throw new Error("Camera HTTP " + r.status);
      // A 200 is not proof of a camera: Fluidd's SPA answers 200 text/html for
      // unknown paths, which would otherwise verify as a working snapshot.
      const ct = r.headers.get("content-type") || "";
      if (!/^image\//i.test(ct.trim())) throw new Error("Camera returned " + (ct || "no content-type") + ", not an image");
      return Buffer.from(await r.arrayBuffer());
    }
    // Every hop passed the host check, so only this counter can stop a printer
    // redirecting to itself indefinitely.
    throw new Error("Camera redirected more than " + MAX_REDIRECTS + " times");
  } finally { clearTimeout(timer); }
}

// ---- config files ----
// Moonraker exposes the printer's config directory. ZMOD and Forge-X both keep
// the stock firmware's own settings file there, which is where the AD5X's
// per-slot colours live. TTL-cached because it changes on the order of days and
// an untimed read would double Moonraker load on every poll (CLAUDE.md §9).
const configCache = new Map(); // url|name -> { ts, value }

async function readConfigJson(p, name, ttlMs = 30000) {
  const key = baseUrl(p) + "|" + name;
  const hit = configCache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.value;
  let value = null;
  try {
    const { ok, json } = await http.fetchJSONTimeout(baseUrl(p) + "/server/files/config/" + name, 5000);
    value = ok ? json : null;
  } catch { value = null; }
  configCache.set(key, { ts: Date.now(), value });
  return value;
}

// ---- macros ----
// Thin wrapper over the shared gcode sink so every FlashForge macro call goes
// through the same validation every other Klipper-family connector uses.
const sendMacro = (p, script, ms) => http.sendGcode(p, script, ms);

// exported for tests only
function _resetCaches() { configCache.clear(); }

module.exports = {
  baseUrl, resolveEndpoint, ping, probeCommon, listObjects,
  resolveWebcam, fetchSnapshot, onPrinterHost, sameHost, MAX_REDIRECTS,
  readConfigJson, sendMacro,
  _resetCaches
};
