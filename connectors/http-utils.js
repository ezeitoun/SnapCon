// connectors/http-utils.js — shared primitives for Moonraker-based connectors.
// Anything here is genuinely protocol-generic: plain Moonraker REST calls that
// never branch on a specific printer brand. A non-Moonraker connector (Bambu,
// etc.) simply won't require this file.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { Transform, Readable } = require("stream");
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

// Klipper machine health, normalized once for every Klipper-family connector.
//
// Klippy's `webhooks` object says whether the MACHINE is alive; print_stats
// says what the JOB was doing. Those are independent, and when Klipper shuts
// down mid-print the job fields simply freeze at plausible-looking values --
// confirmed live on a SPARKX i7 sitting in webhooks.state "shutdown" with a
// real state_message while SnapCon showed it idle. Health therefore wins
// absolutely: a fault here overrides state, however convincing print_stats,
// virtual_sdcard, filename or progress still look.
//
// Returns null when there is no fault, so a caller can simply skip the
// override. 'ready' MUST return null even though state_message is populated
// ("Printer is ready" on all 18 machines here) -- p.message is the flag the
// fleet card uses to suppress its progress/thumbnail/lanes block, so leaking
// it on a healthy printer would blank the whole fleet.
//
// 'startup' is deliberately not a fault: Moonraker refuses object queries
// while Klippy is not ready, so that case already resolves through the
// caller's own !ok -> online:false path. An unrecognised future value is left
// alone rather than guessed at.
//
// Distinct from Klippy being DISCONNECTED (process gone): that fails the query
// outright and is correctly reported as offline. Do not merge the two.
function klipperFault(st) {
  const w = st && st.webhooks;
  if (!w || typeof w !== "object") return null;
  if (w.state !== "shutdown" && w.state !== "error") return null;
  return {
    state: "error",
    errorCode: w.state === "shutdown" ? "KLIPPER_SHUTDOWN" : "KLIPPER_ERROR",
    message: String(w.state_message || "").trim()
  };
}

// POST to a printer's Moonraker endpoint. Throws a user-showable error on
// network failure, timeout, or a non-2xx response.
// `ms` defaults to a short bound suitable for a POST-and-forget gcode
// command (pause/resume/cancel/estop/bed-temp/start-print/exclude-object/
// filament-color) — see CODE_AUDIT.md P1-2: this used to be a bare fetch()
// with no timeout at all, able to hang the single most safety-critical
// action (E-Stop) indefinitely against a wedged printer. Some Moonraker
// macros are NOT fire-and-forget, though — `/printer/gcode/script` blocks
// until the macro fully finishes (confirmed live for G29, see
// creality-klipper.js), so a genuinely long-running physical macro must
// pass an explicit, generous `ms` rather than inherit this default.
async function moonrakerPost(p, apiPath, ms = 8000) {
  let r;
  try { r = await fetchTimeout(baseUrl(p) + apiPath, ms, { method: "POST" }); }
  catch (e) {
    if (e.name === "AbortError") throw new Error(p.name + " did not respond within " + ms + "ms");
    throw new Error("Could not reach " + p.name + ": " + e.message);
  }
  if (!r.ok) throw new Error("Moonraker " + r.status + ": " + (await r.text()).slice(0, 160));
}
const sendGcode = (p, script, ms) => moonrakerPost(p, "/printer/gcode/script?script=" + encodeURIComponent(script), ms);

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

// ---- File sync (Logs/Camera Folder → SnapCon host) ----
// Plain, unmodified Moonraker file-management endpoints (confirmed against
// Moonraker's own web_api.md, not U1-specific) — generic across every
// Klipper-family connector, so these live here rather than per-connector.
// `list` recurses (unlike the Storage card's own top-level-only
// /server/files/directory calls) — a relative path can include subdirs.
async function queryRemoteFileList(base, root) {
  const { ok, status, json } = await fetchJSONTimeout(base + "/server/files/list?root=" + encodeURIComponent(root), 8000);
  if (!ok) throw new Error("Moonraker " + status);
  return json.result || [];
}
function encodeRemotePath(relPath) {
  return String(relPath).split("/").map(encodeURIComponent).join("/");
}
// Streams to a `.part` file, tracks bytes received, validates against both
// the HTTP Content-Length and the size the file-listing reported (when
// known) before the atomic rename — a partial/corrupt transfer never
// replaces a good file, and never gets left behind under the final name.
// The timeout is an IDLE timeout (reset on every chunk), not a total-time
// cap — a large-but-healthy transfer over a slow LAN link shouldn't be
// killed just for taking a while.
async function downloadRemoteFile(base, root, relPath, destPath, expectedSize, idleTimeoutMs = 30000) {
  const url = base + "/server/files/" + encodeURIComponent(root) + "/" + encodeRemotePath(relPath);
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), idleTimeoutMs);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), idleTimeoutMs); };
  const tmp = destPath + ".part";
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    bump();
    if (!res.ok) throw new Error("HTTP " + res.status);
    const contentLength = Number(res.headers.get("content-length")) || 0;
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.rm(tmp, { force: true });
    const out = fs.createWriteStream(tmp);
    let received = 0;
    await new Promise((resolve, reject) => {
      const nodeStream = Readable.fromWeb(res.body);
      nodeStream.on("data", chunk => { received += chunk.length; bump(); });
      nodeStream.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      nodeStream.pipe(out);
    });
    if (expectedSize && received !== expectedSize) throw new Error(`Incomplete download: expected ${expectedSize} bytes, received ${received}`);
    if (contentLength && received !== contentLength) throw new Error(`Incomplete download: expected ${contentLength} bytes, received ${received}`);
    await fs.promises.rename(tmp, destPath);
    return { size: received };
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
// The set of gcode filenames that appear in at least one print job since
// `sinceSec` (a UNIX timestamp) — confirmed live that Moonraker's history
// `filename` field is the exact same string as the file listing's `path`
// (both plain root-relative paths), so this set can be checked directly
// against fetchStorageSection's gcodes.fileNames with no translation.
// Moonraker filters server-side via `since=`, so this stays cheap regardless
// of how far back the printer's full history goes — confirmed live against
// a printer with 233 total historical jobs, a 7-day window only returned 5.
async function queryRecentlyPrintedFiles(base, sinceSec) {
  const { ok, status, json } = await fetchJSONTimeout(base + "/server/history/list?since=" + sinceSec + "&limit=500&order=desc", 8000);
  if (!ok) throw new Error("Moonraker " + status);
  const jobs = (json.result || {}).jobs || [];
  return new Set(jobs.map(j => j.filename));
}
async function deleteRemoteFile(base, root, relPath) {
  const res = await fetchTimeout(base + "/server/files/" + encodeURIComponent(root) + "/" + encodeRemotePath(relPath), 8000, { method: "DELETE" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return true;
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
  let isFS = false, fsFork = null, tailText = "", tailPalette = null;
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
        tailPalette = fsResult.palette;
      }
    } finally { clearTimeout(tid); }
  } catch {}

  let estimatedTime = m.estimated_time || null;
  // Some Moonraker builds return a metadata record with no filament data at
  // all -- confirmed live on a Creality SPARKX i7, whose entire record was
  // {filename, first_layer_height, gcode_*_byte, job_id, modified,
  // object_height, print_start_time, size, slicer, uuid} for a genuinely
  // 4-colour file. That left the palette empty and the colour picker showed a
  // single unnamed slot, so the file's colours could not be assigned to lanes.
  //
  // The tail fetched just above already contains the slicer config block, and
  // parseGcodeMap already builds a full palette from it -- previously only
  // isFS/fsFork were taken and that palette was discarded. Reusing it costs no
  // extra request. Only ever a fallback: a printer that reports its own
  // palette keeps it, since the printer is authoritative about its own file.
  if (!palette.some(s => s.used) && tailPalette && tailPalette.some(s => s.used)) {
    palette.splice(0, palette.length, ...tailPalette);
  }
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
  if (!st.online) return { name: p.name, online: false, skipped: true, reason: st.error || "offline", reasonCode: "offline", detail: st.error || "" };
  // "maintenance" is a SnapCon-side flag, not a printer state: the machine is
  // reachable and idle, deliberately taken out of production. That makes it a
  // sensible printer to read firmware from and — see the deploy route — to
  // update. The states that genuinely block are the ones where it is moving.
  if (!["standby", "complete", "cancelled", "maintenance"].includes(st.state)) {
    return { name: p.name, online: true, skipped: true, reason: "busy (" + st.state + ")", reasonCode: "busy", state: st.state };
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

// ---- Health diagnostics: raw Moonraker/Klipper values only — no derived
// scores, no synthetic "health %"/"load %"/"drift %". Six independent
// sections, each wrapped so one section's failure/timeout never takes the
// others down with it (a slow /server/files/directory must not blank out
// MCU stats). `st` is an already-resolved probe() result, same convention
// as queryFirmwareInfo above — no reason to probe twice. Unlike
// queryFirmwareInfo (which only runs when the printer is idle), this only
// requires `st.online`: MCU retransmits/throttle state matter most while a
// print is actually running. ----
async function healthSection(promise) {
  try { return { available: true, ...(await promise) }; }
  catch (e) { return { available: false, reason: e.message }; }
}
async function fetchSystemSection(base) {
  const { ok, status, json } = await fetchJSONTimeout(base + "/machine/proc_stats", 5000);
  if (!ok) throw new Error("Moonraker " + status);
  const r = json.result || {};
  return {
    throttledState: r.throttled_state ?? null,
    cpuTemp: typeof r.cpu_temp === "number" ? r.cpu_temp : null,
    cpuUsage: (r.system_cpu_usage && typeof r.system_cpu_usage.cpu === "number") ? r.system_cpu_usage.cpu : null,
    uptimeSec: typeof r.system_uptime === "number" ? r.system_uptime : null,
    memory: r.system_memory || null
  };
}
// Discovers whichever "mcu"/"mcu e0".."e3" objects this printer actually
// reports (same list-then-query approach queryFirmwareInfo already uses)
// and queries only those — a 2-toolhead unit simply returns 3 entries, not
// a fixed 4-entry shape with holes. `available:false` is reserved for the
// query itself failing, never for a printer having fewer MCUs than another.
async function fetchMcuSection(base, mcuNames) {
  if (!mcuNames.length) return { list: [] };
  const { ok, status, json } = await fetchJSONTimeout(base + "/printer/objects/query?" + mcuNames.map(encodeURIComponent).join("&"), 5000);
  if (!ok) throw new Error("Moonraker " + status);
  const stq = (json.result || {}).status || {};
  return {
    list: mcuNames.map(n => {
      const s = stq[n] || {};
      const ls = s.last_stats || {};
      return {
        name: n === "mcu" ? "mainboard" : "toolhead " + n.replace(/^mcu\s*/, ""),
        bytesRetransmit: ls.bytes_retransmit ?? null,
        bytesInvalid: ls.bytes_invalid ?? null,
        // bytesWrite is the denominator for a retransmit RATE (retransmits
        // per bytes actually sent) rather than a bare cumulative total —
        // the total alone means nothing without knowing how much traffic
        // it happened against.
        bytesWrite: ls.bytes_write ?? null,
        srtt: ls.srtt ?? null,
        rttvar: ls.rttvar ?? null,
        freq: ls.freq ?? null,
        mcuTaskAvg: ls.mcu_task_avg ?? null,
        mcuTaskStddev: ls.mcu_task_stddev ?? null
      };
    })
  };
}
async function fetchHeatersSection(base, heaterNames) {
  if (!heaterNames.length) return { list: [] };
  const { ok, status, json } = await fetchJSONTimeout(base + "/printer/objects/query?" + heaterNames.map(encodeURIComponent).join("&"), 5000);
  if (!ok) throw new Error("Moonraker " + status);
  const stq = (json.result || {}).status || {};
  return {
    list: heaterNames.map(n => ({
      name: n,
      temperature: (stq[n] || {}).temperature ?? null,
      target: (stq[n] || {}).target ?? null,
      power: (stq[n] || {}).power ?? null
    }))
  };
}
// Standard `fan`/`heater_fan <name>`/`fan_generic <name>` objects report
// {speed, rpm} — speed is the commanded 0-1 duty, rpm is measured (or
// missing/null on fans with no tachometer wired — confirmed real on a live
// U1: heater_fan power_fan reports rpm:null). `rpm` absent from the
// response entirely is treated the same as an explicit null — both mean
// "not measurable," never "stopped". The U1's `purifier` object is a
// different shape (inner_fan_rpm / exhaust_fan.speed / inner_fan.speed);
// its inner fan is folded into the same list under its own name so callers
// don't need to special-case it.
async function fetchFansSection(base, fanNames, hasPurifier) {
  const queryNames = hasPurifier ? [...fanNames, "purifier"] : fanNames;
  if (!queryNames.length) return { list: [] };
  const { ok, status, json } = await fetchJSONTimeout(base + "/printer/objects/query?" + queryNames.map(encodeURIComponent).join("&"), 5000);
  if (!ok) throw new Error("Moonraker " + status);
  const stq = (json.result || {}).status || {};
  const list = fanNames.map(n => {
    const s = stq[n] || {};
    return { name: n, speed: typeof s.speed === "number" ? s.speed : null, rpm: typeof s.rpm === "number" ? s.rpm : null };
  });
  if (hasPurifier) {
    const s = stq.purifier || {};
    list.push({ name: "purifier inner fan", speed: (s.inner_fan && typeof s.inner_fan.speed === "number") ? s.inner_fan.speed : null, rpm: typeof s.inner_fan_rpm === "number" ? s.inner_fan_rpm : null });
    // Confirmed live (U1 Purple): exhaust_fan.speed can be 1 (fully
    // commanded on) while inner_fan is completely off — these are two
    // independent fans, not one. No rpm field exists for it anywhere in the
    // purifier object (unlike inner_fan_rpm), so it's never measurable.
    list.push({ name: "purifier exhaust fan", speed: (s.exhaust_fan && typeof s.exhaust_fan.speed === "number") ? s.exhaust_fan.speed : null, rpm: null });
  }
  return { list };
}
// disk_usage is filesystem-level and read from ONE root (gcodes, always
// present) — never summed across roots, since gcodes/logs/camera commonly
// share one underlying filesystem and summing their individually-reported
// disk_usage would double/triple-count the same disk. Per-category sizes
// are a separate, shallow (top-level files only, not recursed into
// subdirectories) sum of each root's own listing — a directory's own
// reported `size` is its inode/entry-table size, not a recursive content
// total, so recursing would be needed for a fully accurate category figure;
// out of scope here. "Other" folds in both that gap and any genuinely
// shared-filesystem overlap — the caller renders one tooltip explaining both.
async function fetchStorageSection(base, roots) {
  const catNames = roots.filter(r => ["gcodes", "logs", "camera"].includes(r));
  const dirs = await Promise.all(catNames.map(root =>
    fetchJSONTimeout(base + "/server/files/directory?path=" + encodeURIComponent(root), 8000)
      .then(r => ({ root, ...r }))
  ));
  const gcodesDir = dirs.find(d => d.root === "gcodes");
  if (!gcodesDir || !gcodesDir.ok) throw new Error("Moonraker " + (gcodesDir ? gcodesDir.status : "no gcodes root"));
  const diskUsage = (gcodesDir.json.result || {}).disk_usage || null;
  if (!diskUsage) throw new Error("no disk_usage reported");
  const categories = {};
  for (const d of dirs) {
    if (!d.ok) { categories[d.root] = { bytes: 0, fileCount: 0, available: false }; continue; }
    const files = (d.json.result || {}).files || [];
    categories[d.root] = {
      bytes: files.reduce((sum, f) => sum + (f.size || 0), 0),
      fileCount: files.length,
      available: true,
      // Only gcodes needs individual names — server.js cross-references
      // these against print history to compute an "unused" count, then
      // strips this field before the response reaches the browser (the
      // client only ever needs the final count, not the raw file list).
      // /server/files/directory's file objects use `filename`, NOT `path`
      // (confirmed live — `path` is undefined here; `path` is only what
      // /server/files/list and history's `filename` field use instead).
      ...(d.root === "gcodes" ? { fileNames: files.map(f => f.filename) } : {})
    };
  }
  const knownBytes = Object.values(categories).reduce((sum, c) => sum + (c.bytes || 0), 0);
  const otherBytes = Math.max(0, diskUsage.used - knownBytes);
  return { diskUsage, categories, otherBytes };
}
async function fetchHistorySection(base) {
  const [totalsR, listR] = await Promise.all([
    fetchJSONTimeout(base + "/server/history/totals", 5000),
    fetchJSONTimeout(base + "/server/history/list?limit=20&order=desc", 5000)
  ]);
  if (!totalsR.ok) throw new Error("Moonraker " + totalsR.status);
  const totals = (totalsR.json.result || {}).job_totals || {};
  const jobs = listR.ok ? ((listR.json.result || {}).jobs || []) : [];
  const completed = jobs.filter(j => j.status === "completed").length;
  return {
    totalJobs: totals.total_jobs ?? null,
    totalPrintTime: totals.total_print_time ?? null,
    totalFilamentUsed: totals.total_filament_used ?? null,
    // "Recent" on purpose — a window over the last `sampleSize` jobs, never
    // implied to be a lifetime figure. Caller labels this "Recent Success".
    recent: { completed, sampleSize: jobs.length }
  };
}
async function fetchFaultsSection(base, st) {
  const { ok, status, json } = await fetchJSONTimeout(base + "/printer/objects/query?exception_manager", 5000);
  if (!ok) throw new Error("Moonraker " + status);
  const list = (((json.result || {}).status || {}).exception_manager || {}).exceptions || [];
  // The printer's OWN current error (already decoded onto the probe result
  // by the caller's normal probe() path) is folded in as the most recent
  // entry when present, so an active fault shows up here even if
  // exception_manager's own history hasn't recorded it yet.
  const current = st.errorCode || st.message ? [{ current: true, errorCode: st.errorCode || null, message: st.message || null }] : [];
  return { list: [...current, ...list] };
}
async function queryHealth(p, st) {
  if (!st.online) return { online: false, skipped: true, reason: st.error || "offline" };
  const base = baseUrl(p);
  let objectNames = [];
  try {
    const ol = await fetchJSONTimeout(base + "/printer/objects/list", 5000);
    if (ol.ok) objectNames = (ol.json.result || {}).objects || [];
  } catch { /* MCU/heater sections below degrade to their own unavailable state */ }
  const mcuNames = objectNames.filter(o => /^mcu(\s|$)/.test(o));
  const heaterNames = objectNames.filter(o => /^(extruder\d*|heater_bed)$/.test(o));
  const fanNames = objectNames.filter(o => o === "fan" || /^heater_fan\s/.test(o) || /^fan_generic\s/.test(o));
  const hasPurifier = objectNames.includes("purifier");
  let roots = ["gcodes", "logs", "camera"];
  try {
    const rr = await fetchJSONTimeout(base + "/server/files/roots", 5000);
    if (rr.ok) roots = (rr.json.result || []).map(r => r.name);
  } catch { /* storage section below degrades to its own unavailable state */ }

  const [system, mcus, heaters, fans, storage, history, faults] = await Promise.all([
    healthSection(fetchSystemSection(base)),
    healthSection(fetchMcuSection(base, mcuNames)),
    healthSection(fetchHeatersSection(base, heaterNames)),
    healthSection(fetchFansSection(base, fanNames, hasPurifier)),
    healthSection(fetchStorageSection(base, roots)),
    healthSection(fetchHistorySection(base)),
    healthSection(fetchFaultsSection(base, st))
  ]);
  return { online: true, skipped: false, system, mcus, heaters, fans, storage, history, faults };
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
  baseUrl, fetchTimeout, fetchJSONTimeout, klipperFault, moonrakerPost, sendGcode,
  uploadWithProgress, uploadFile,
  pause, resume, cancel, eject, estop, bedTemp, startPrintFile,
  getPlate, excludeObject,
  listFiles, getThumbnail, getFileMetadata,
  queryFirmwareInfo, queryHealth, pickIface,
  queryRemoteFileList, downloadRemoteFile, deleteRemoteFile, queryRecentlyPrintedFiles,
  // exported for tests only
  _internal: { assertSafeGcodeArg, parseFallbackStats }
};
