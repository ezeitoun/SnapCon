// server.js — SnapCon  ·  v0.0.7
// Watches a folder of sliced gcode, shows the toolhead/color map per file,
// and pushes the chosen file to the chosen printer via Moonraker (server-side,
// so no browser CORS headaches).

const VERSION = "0.0.7";

const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { Transform } = require("stream");
const { parseGcodeMap, parseGcodeMapLines, normHex } = require("./parser");
const auth = require("./auth");

// When packaged as a single executable (pkg), __dirname points inside the
// read-only bundle. User-editable files (config.json, the gcode folder) must
// live NEXT TO THE EXE instead. Bundled assets (public/, parser.js) stay on
// __dirname, which pkg maps into the snapshot.
const IS_PKG = typeof process.pkg !== "undefined";
const BASE_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
const ASSET_DIR = __dirname;

const CONFIG_PATH = path.join(BASE_DIR, "config.json");
const USERS_PATH = path.join(BASE_DIR, "users.json");
const DEFAULT_CFG = { gcodeFolder: "./gcode", port: 4545, printers: [] };

// Live config — editable from the Settings page, no restart needed.
let CFG, FOLDER, PRINTERS;
function loadConfig() {
  try { CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { CFG = { ...DEFAULT_CFG }; }
  FOLDER = path.resolve(BASE_DIR, CFG.gcodeFolder || "./gcode");
  PRINTERS = Array.isArray(CFG.printers) ? CFG.printers : [];
  try { fs.mkdirSync(FOLDER, { recursive: true }); } catch {}
}
loadConfig();
const PORT = CFG.port || 4545;

// Users for the optional User Access Management feature. No file exists until
// the first user is actually created — CFG.usersEnabled being true with zero
// users is refused server-side (see POST /api/config).
let USERS = [];
function loadUsers() {
  try { USERS = JSON.parse(fs.readFileSync(USERS_PATH, "utf8")).users || []; }
  catch { USERS = []; }
}
function saveUsers() {
  fs.writeFileSync(USERS_PATH, JSON.stringify({ users: USERS }, null, 2));
}
loadUsers();

// ---- CLI notify mode ----
// `SnapCon --load "C:\file.gcode" --printer "U1 White" --outputname "Nicer Name"`
// pings an ALREADY-RUNNING instance's HTTP API and exits — it never starts the
// web server itself. A plain top-level `return` (valid — CommonJS wraps each
// file in a function) stops the rest of this file, Express setup included,
// from ever running. --outputname is cosmetic + the upload filename only —
// the file read from disk is always the --load path.
const CLI_LOAD_ARG = process.argv.indexOf("--load");
if (CLI_LOAD_ARG !== -1) {
  const file = process.argv[CLI_LOAD_ARG + 1];
  const printerArgI = process.argv.indexOf("--printer");
  const printer = printerArgI !== -1 ? process.argv[printerArgI + 1] : "";
  const outputArgI = process.argv.indexOf("--outputname");
  const outputname = outputArgI !== -1 ? process.argv[outputArgI + 1] : "";
  if (!file) { console.error("--load requires a file path"); process.exit(1); }
  const body = JSON.stringify({ file: path.resolve(file), printer, outputname });
  const req = http.request({
    hostname: "127.0.0.1", port: PORT, path: "/api/notify-load", method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
  }, res => {
    let b = ""; res.setEncoding("utf8"); res.on("data", d => b += d);
    res.on("end", () => {
      if (res.statusCode >= 300) { console.error("SnapCon: " + b); process.exit(1); }
      console.log("SnapCon: " + b); process.exit(0);
    });
  });
  req.on("error", e => { console.error("Could not reach SnapCon on port " + PORT + " — is it running? (" + e.message + ")"); process.exit(1); });
  req.write(body); req.end();
  return;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ASSET_DIR, "public")));
// Annotates req.user on every /api request; when usersEnabled is false this
// always resolves to an implicit admin, so every route below behaves exactly
// as it does today. Individual routes layer requireAuth/requireRegular/
// requireAdmin on top where they need to actually enforce something.
app.use("/api", auth.makeAuthMiddleware(() => CFG, () => USERS));
const { requireAuth, requireRegular, requireAdmin } = auth;
// Explicit index route so the UI is served even when running from a packaged
// binary (where express.static from the snapshot can be unreliable).
app.get("/", (req, res) => {
  try { res.type("html").send(fs.readFileSync(path.join(ASSET_DIR, "public", "index.html"), "utf8")); }
  catch (e) { res.status(500).send("index.html not found"); }
});
// /orca/<printer name> (case-insensitive, "_" = space) — same page; the client
// reads the path and filters the fleet down to just that one printer's card.
app.get(/^\/orca\/.+$/i, (req, res) => {
  try { res.type("html").send(fs.readFileSync(path.join(ASSET_DIR, "public", "index.html"), "utf8")); }
  catch (e) { res.status(500).send("index.html not found"); }
});

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

// Resolve a requested path safely INSIDE the watched folder (no traversal).
function safePath(sub) {
  if (!sub) return null;
  const p = path.resolve(FOLDER, sub);
  return p.startsWith(FOLDER) ? p : null;
}

// Printer URLs from config may carry a trailing slash — strip it once here.
const baseUrl = p => String(p.url).replace(/\/+$/, "");

// POST to a printer's Moonraker endpoint. Throws a user-showable error on
// network failure or a non-2xx response.
async function moonrakerPost(p, apiPath) {
  let r;
  try { r = await fetch(baseUrl(p) + apiPath, { method: "POST" }); }
  catch (e) { throw new Error("Could not reach " + p.name + ": " + e.message); }
  if (!r.ok) throw new Error("Moonraker " + r.status + ": " + (await r.text()).slice(0, 160));
}
const sendGcode = (p, script) => moonrakerPost(p, "/printer/gcode/script?script=" + encodeURIComponent(script));


app.get("/api/printers", requireAuth, (req, res) => {
  res.json(PRINTERS.map((p, i) => ({ id: i, name: p.name })));
});

app.get("/api/files", requireAuth, (req, res) => {
  const sub = req.query.sub || "";
  const dir = sub ? safePath(sub) : FOLDER;
  if (!dir) return res.status(400).json({ error: "Invalid path" });
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const folders = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    const files = entries
      .filter(e => e.isFile() && /\.(gcode|gco|g)$/i.test(e.name))
      .map(e => {
        const fp = path.join(dir, e.name);
        const st = fs.statSync(fp);
        return { name: e.name, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ folder: dir, sub, folders, files });
  } catch (e) {
    res.status(500).json({ error: "Cannot read folder — " + e.message });
  }
});

app.get("/api/map", requireAuth, async (req, res) => {
  const fp = safePath(req.query.file);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });
  try {
    // The Orca config block (colours + "filament used [g]") lives at the END of
    // the file, so read just the tail — turns a 200MB read into ~2MB and skips
    // the body scan entirely. Fall back to the whole file only if the colour
    // config isn't found in the tail.
    const TAIL = 3 * 1024 * 1024;
    const size = fs.statSync(fp).size;
    let text;
    if (size > TAIL) {
      const fd = fs.openSync(fp, "r");
      try {
        const buf = Buffer.alloc(TAIL);
        fs.readSync(fd, buf, 0, TAIL, size - TAIL);
        text = buf.toString("utf8");
      } finally { fs.closeSync(fd); }
    } else {
      text = fs.readFileSync(fp, "utf8");
    }
    let result = parseGcodeMap(text, { scanBody: false });
    if (result.noColors && size > TAIL) {
      // Colours weren't in the tail — fall back to a full parse (rare). Stream
      // it line-by-line: these files can be 200MB+, never hold one in memory.
      const rl = readline.createInterface({ input: fs.createReadStream(fp, { encoding: "utf8" }), crlfDelay: Infinity });
      result = await parseGcodeMapLines(rl, { scanBody: true });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Local gcode thumbnail (base64 PNG/JPG embedded by Orca in the header) ----
app.get("/api/local-thumbnail", requireAuth, (req, res) => {
  const fp = safePath(req.query.file);
  if (!fp || !fs.existsSync(fp)) return res.status(404).send("Not found");
  try {
    const HEAD = 2 * 1024 * 1024;
    const size = fs.statSync(fp).size;
    let text;
    if (size > HEAD) {
      const fd = fs.openSync(fp, "r");
      try { const buf = Buffer.alloc(HEAD); fs.readSync(fd, buf, 0, HEAD, 0); text = buf.toString("latin1"); }
      finally { fs.closeSync(fd); }
    } else {
      text = fs.readFileSync(fp, "latin1");
    }
    // Collect every "thumbnail begin WxH" position — pick the largest, then extract data up to its end marker
    const beginRe = /; thumbnail(?:_(\w+))? begin (\d+)x(\d+)/gi;
    const candidates = [];
    let m;
    while ((m = beginRe.exec(text)) !== null) {
      candidates.push({ lineEnd: m.index + m[0].length, area: parseInt(m[2]) * parseInt(m[3]), type: (m[1] || "png").toLowerCase() });
    }
    if (!candidates.length) return res.status(404).send("No thumbnail");
    candidates.sort((a, b) => b.area - a.area);
    const { lineEnd, type } = candidates[0];

    const dataStart = text.indexOf("\n", lineEnd) + 1;
    const endIdx = text.indexOf("; thumbnail", dataStart); // finds "; thumbnail end"
    if (endIdx === -1) return res.status(404).send("Thumbnail end not found");

    const b64 = text.slice(dataStart, endIdx)
      .split(/\r?\n/)
      .map(l => l.replace(/^;\s?/, ""))
      .join("");

    const buf = Buffer.from(b64, "base64");
    const ct = type === "jpg" || type === "jpeg" ? "image/jpeg" : "image/png";
    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=3600");
    res.send(buf);
  } catch (e) { res.status(500).send(e.message); }
});

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

const JOBS = new Map();   // jobId -> { phase, sent, total, done, error, result, ts }
const newJobId = () => "j" + Date.now() + Math.random().toString(16).slice(2, 6);

// Normal cleanup happens when /api/print-status reads a finished job — but if
// the tab closed mid-upload nobody ever polls, so sweep abandoned finished
// jobs too. Every completion path (success or error) sets done.
const JOB_MAX_AGE = 10 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - JOB_MAX_AGE;
  for (const [id, job] of JOBS) if (job.done && job.ts < cutoff) JOBS.delete(id);
}, 60 * 1000).unref();

app.post("/api/print", requireRegular, (req, res) => {
  const { file, printer, start, map } = req.body || {};
  const fp = safePath(file);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });

  // map is { logicalToolIndex: physicalHeadIndex }. Reject two tools → same head —
  // but only when actually starting a print. A plain upload just stages the file
  // on the printer; the mapping isn't acted on until print start, so a conflicting
  // (or mismatched-material) mapping shouldn't block getting the file there.
  let tools = [];
  if (map && Object.keys(map).length) {
    tools = Object.keys(map).map(Number).sort((a, b) => a - b);
    const heads = tools.map(t => map[t]);
    if (start && new Set(heads).size !== heads.length) {
      return res.status(400).json({ error: "Two colors are mapped to the same head — give each its own head." });
    }
  }

  const base = baseUrl(p);
  const name = path.basename(fp);

  // Kick the work off in the background and hand the client a job id to poll.
  const jobId = newJobId();
  const job = { phase: "upload", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now() };
  JOBS.set(jobId, job);
  res.json({ jobId });

  (async () => {
    try {
      await uploadWithProgress(base, fp, name, job);     // 1) upload (with progress)
      if (tools.length) {                                 // 2) toolhead mapping macros
        job.phase = "mapping";
        const lines = tools.map(t => `SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=${t} MAP_EXTRUDER=${map[t]}`);
        lines.push("SET_PRINT_USED_EXTRUDERS EXTRUDERS=" + tools.map(t => map[t]).join(","));
        lines.push("SET_PRINT_PREFERENCES BED_LEVEL=" + (p.autoLevel ? "1" : "0") + " FLOW_CALIBRATE=0 TIME_LAPSE_CAMERA=0");
        await sendGcode(p, lines.join("\n"));
      }
      if (start) { job.phase = "starting"; await sendGcode(p, `SDCARD_PRINT_FILE FILENAME="${name}"`); }
      job.result = { printer: p.name, started: !!start, mapped: tools.length };
      job.phase = "done"; job.done = true;
    } catch (e) {
      job.error = e.message; job.done = true; job.phase = "error";
    }
  })();
});

// Poll a print job's progress. Cleans the record up once a finished job is read.
app.get("/api/print-status", requireAuth, (req, res) => {
  const job = JOBS.get(req.query.job);
  if (!job) return res.status(404).json({ error: "No such job" });
  const out = { phase: job.phase, sent: job.sent, total: job.total, done: job.done, error: job.error, result: job.result };
  if (job.done) setTimeout(() => JOBS.delete(req.query.job), 5000);
  res.json(out);
});

// ---- Files stored on a printer + start one directly ----
app.get("/api/printer-files", requireAuth, async (req, res) => {
  const p = PRINTERS[req.query.printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  try {
    const { ok, status, json } = await fetchJSONTimeout(baseUrl(p) + "/server/files/list?root=gcodes", 8000);
    if (!ok) return res.status(502).json({ error: "Moonraker " + status });
    const files = (json.result || [])
      .map(f => ({ path: f.path, size: f.size, modified: f.modified }))
      .sort((a, b) => b.modified - a.modified);
    res.json({ files });
  } catch (e) {
    res.status(502).json({ error: "Could not reach " + p.name + ": " + e.message });
  }
});

// Palette of a file stored on the printer, from Moonraker's slicer metadata.
// Per-color weights decide which palette slots the print actually uses — the
// same rule parser.js applies to local files.
app.get("/api/printer-file-meta", requireAuth, async (req, res) => {
  const p = PRINTERS[req.query.printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: "Missing file" });
  try {
    const { ok, status, json } = await fetchJSONTimeout(baseUrl(p) + "/server/files/metadata?filename=" + encodeURIComponent(file), 8000);
    if (!ok) return res.status(502).json({ error: "Moonraker " + status });
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
    // Fetch the last 50 KB of the gcode to run FS detection (config block is at EOF).
    let isFS = false, fsFork = null;
    try {
      const encodedPath = file.split("/").map(encodeURIComponent).join("/");
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 10000);
      try {
        const r = await fetch(baseUrl(p) + "/server/files/gcodes/" + encodedPath,
          { signal: ctrl.signal, headers: { Range: "bytes=-51200" } });
        if (r.ok || r.status === 206) {
          const fsResult = parseGcodeMap(await r.text(), { scanBody: false });
          isFS = fsResult.isFS; fsFork = fsResult.fsFork;
        }
      } finally { clearTimeout(tid); }
    } catch {}
    res.json({ palette, estimatedTime: m.estimated_time || null, isFS, fsFork });
  } catch (e) {
    res.status(502).json({ error: "Could not reach " + p.name + ": " + e.message });
  }
});

app.post("/api/printfile", requireRegular, async (req, res) => {
  const { printer, filename, map } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!filename || /["\r\n]/.test(filename)) return res.status(400).json({ error: "Bad filename" });

  // Same head-mapping macros as the upload flow (map = { paletteIdx: headIdx }).
  let tools = [];
  if (map && Object.keys(map).length) {
    tools = Object.keys(map).map(Number).sort((a, b) => a - b);
  }
  try {
    if (tools.length) {
      const lines = tools.map(t => `SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=${t} MAP_EXTRUDER=${map[t]}`);
      const usedHeads = [...new Set(tools.map(t => map[t]))];
      lines.push("SET_PRINT_USED_EXTRUDERS EXTRUDERS=" + usedHeads.join(","));
      lines.push("SET_PRINT_PREFERENCES BED_LEVEL=" + (p.autoLevel ? "1" : "0") + " FLOW_CALIBRATE=0 TIME_LAPSE_CAMERA=0");
      await sendGcode(p, lines.join("\n"));
    }
    await sendGcode(p, `SDCARD_PRINT_FILE FILENAME="${filename}"`);
    // Printing it is what "ready to print" was waiting for — clear the badge.
    if (queuedFile.get(printer)?.name === filename) queuedFile.delete(printer);
    res.json({ ok: true, printer: p.name, filename, mapped: tools.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Print control: pause / resume / cancel (standard Klipper macros) ----
app.post("/api/printctl", requireRegular, async (req, res) => {
  const { printer, action } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  try {
    if (action === "estop") {
      await moonrakerPost(p, "/printer/emergency_stop");
      return res.json({ ok: true, action });
    }
    const cmd = { pause: "PAUSE", resume: "RESUME", cancel: "CANCEL_PRINT", eject: "SDCARD_RESET_FILE" }[action];
    if (!cmd) return res.status(400).json({ error: "Bad action" });
    await sendGcode(p, cmd);
    res.json({ ok: true, action });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Exclude-object: live plate map + skip a single object mid-print ----
app.get("/api/plate", requireAuth, async (req, res) => {
  const p = PRINTERS[req.query.printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  try {
    const { ok, status, json } = await fetchJSONTimeout(baseUrl(p) + "/printer/objects/query?exclude_object", 3500);
    if (!ok) return res.status(502).json({ error: "Moonraker " + status });
    const eo = ((json.result || {}).status || {}).exclude_object || {};
    res.json({
      objects: (eo.objects || []).map(o => ({ name: o.name, center: o.center, polygon: o.polygon })),
      current: eo.current_object || null,
      excluded: eo.excluded_objects || []
    });
  } catch (e) {
    res.status(502).json({ error: "Could not reach " + p.name + ": " + e.message });
  }
});

app.post("/api/exclude", requireRegular, async (req, res) => {
  const { printer, name } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!name || /["\r\n]/.test(name)) return res.status(400).json({ error: "Bad object name" });
  try {
    await sendGcode(p, `EXCLUDE_OBJECT NAME=${name}`);
    res.json({ ok: true, excluded: name });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Fleet: live per-head filament + status across all printers ----
// Colors come from print_task_config (the touchscreen-assigned filament, which
// persists with the physical spools until unloaded). filament_detect was wrong:
// it only reports RFID-tagged official spools, so third-party heads read blank.
function decodeHeads(ptc) {
  const ex   = ptc.filament_exist || [];
  const rgba = ptc.filament_color_rgba || [];
  const typ  = ptc.filament_type || [];
  const sub  = ptc.filament_sub_type || [];
  const off  = ptc.filament_official || [];
  return [0, 1, 2, 3].map(i => {
    const loaded = !!ex[i];
    let hex = null;
    if (loaded && rgba[i]) {
      const m = /^#?([0-9a-fA-F]{6})/.exec(rgba[i]);
      if (m) hex = "#" + m[1].toUpperCase();
    }
    return {
      loaded,
      hex,
      material: loaded ? (typ[i] || null) : null,
      sub: (loaded && sub[i] && sub[i] !== "NONE") ? sub[i] : null,
      official: !!off[i]
    };
  });
}

async function probe(p) {
  const url = baseUrl(p) + "/printer/objects/query?print_task_config&print_stats&display_status&virtual_sdcard&heater_bed&extruder&extruder1&extruder2&extruder3&fan&gcode_move&toolhead&exclude_object";
  try {
    const { ok, status, json: j } = await fetchJSONTimeout(url, 3500);
    if (!ok) return { name: p.name, online: false, error: "HTTP " + status };
    const st = (j.result && j.result.status) || {};
    const ptc = st.print_task_config || {};
    const heads = decodeHeads(ptc);
    const ps = st.print_stats || {};
    const ds = st.display_status || {};
    const hb = st.heater_bed || {};
    const extKeys = ["extruder", "extruder1", "extruder2", "extruder3"];
    let hotend = null;
    for (const k of extKeys) {
      const e = st[k];
      if (e && typeof e.temperature === "number" && e.target > 80 && (e.temperature - e.target) <= 5) {
        // Whole degrees only (the UI never shows finer) — sensor jitter would
        // otherwise make every fleet payload unique and defeat the client's
        // skip-render-when-unchanged check.
        hotend = { temp: Math.round(e.temperature), target: Math.round(e.target) };
        break;
      }
    }
    const th = st.toolhead || {};
    const activeExt = typeof th.extruder === "string" ? parseInt(th.extruder.replace("extruder", "") || "0", 10) : null;
    const fan = st.fan || {};
    const gm = st.gcode_move || {};
    const psi = ps.info || {};
    const eo = st.exclude_object || {};
    const plate = (eo.objects && eo.objects.length)
      ? { total: eo.objects.length, excluded: (eo.excluded_objects || []).length, current: eo.current_object || null }
      : null;
    // Decode Snapmaker structured error from print_stats.exception / print_stats.message (JSON)
    let errorCode = "", errorMsg = "";
    if (ps.exception && typeof ps.exception === "object") {
      const { level = 0, id = 0, index = 0, code = 0, message: exMsg = "" } = ps.exception;
      const candidate = [level, id, index, code].map(n => String(n).padStart(4, "0")).join("-");
      if (candidate !== "0000-0000-0000-0000") { errorCode = candidate; errorMsg = exMsg; }
    } else if (ps.message) {
      try {
        const parsed = JSON.parse(ps.message);
        if (parsed.coded) errorCode = parsed.coded.split("-").map(g => g.trim().padStart(4, "0")).join("-");
        if (parsed.msg) errorMsg = parsed.msg;
      } catch { errorMsg = ps.message; }
    }
    return {
      name: p.name, online: true,
      state: ps.state || "unknown",
      message: errorMsg,
      errorCode,
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
      heads
    };
  } catch (e) {
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

// A printer that failed its last probe is served from this cache and only
// re-probed every OFFLINE_RETRY_MS — otherwise every unreachable printer costs
// a full fetch timeout on every fleet poll.
const OFFLINE_RETRY_MS = 10 * 1000;
const offlineCache = new Map();   // printer url -> { result, until }

async function probeCached(p) {
  const hit = offlineCache.get(p.url);
  if (hit && Date.now() < hit.until) return hit.result;
  const result = await probe(p);
  if (result.online) offlineCache.delete(p.url);
  else offlineCache.set(p.url, { result, until: Date.now() + OFFLINE_RETRY_MS });
  return result;
}

// ---- Notify: external CLI hook (--load/--printer) stages a file for a printer ----
// No interactive hand-off, ever — a notify always just uploads. If the printer
// is busy right now, it's held in pendingLoad and a background sweep retries
// it once the printer goes idle, with no browser tab needed for that to happen.
// queuedFile: printer index -> { name, status, ts, error? } — reflects the
// upload's progress; visible to ANY tab as a "ready to print" card banner.
const pendingLoad = new Map();
const queuedFile = new Map();

const normPrinterName = s => String(s || "").replace(/_/g, " ").trim().toLowerCase();
function findPrinterIndex(name) {
  const norm = normPrinterName(name);
  if (!norm) return -1;
  return PRINTERS.findIndex(p => normPrinterName(p.name) === norm);
}

async function isPrinterIdle(p) {
  try { const st = await probeCached(p); return st.online && st.state !== "printing" && st.state !== "paused"; }
  catch { return false; }
}
async function uploadNotifiedFile(idx, pl) {
  const p = PRINTERS[idx];
  queuedFile.set(idx, { name: pl.name, status: "uploading", ts: Date.now() });
  try {
    await uploadWithProgress(baseUrl(p), pl.file, pl.name, { sent: 0, total: 0 });
    queuedFile.set(idx, { name: pl.name, status: "ready", ts: Date.now() });
  } catch (e) {
    queuedFile.set(idx, { name: pl.name, status: "error", error: e.message, ts: Date.now() });
  }
}
// Runs independent of any open browser tab — this is what lets a queued file
// eventually upload even if nobody ever loads the page.
const PENDING_RETRY_MS = 5000;
setInterval(async () => {
  for (const [idx, pl] of [...pendingLoad]) {
    const p = PRINTERS[idx];
    if (!p) { pendingLoad.delete(idx); continue; }
    if (await isPrinterIdle(p)) {
      pendingLoad.delete(idx);
      uploadNotifiedFile(idx, pl);
    }
  }
}, PENDING_RETRY_MS).unref();

app.get("/api/fleet", requireAuth, async (req, res) => {
  // ?printer=N probes just that printer — the splash screen uses this to show
  // per-printer connect progress. No param = the whole fleet (normal polling).
  if (req.query.printer !== undefined) {
    const i = parseInt(req.query.printer, 10);
    const p = PRINTERS[i];
    if (!p) return res.status(400).json({ error: "Unknown printer" });
    return res.json({ id: i, url: p.url, brand: p.brand || "SnapMaker", ...(await probeCached(p)) });
  }
  const out = await Promise.all(PRINTERS.map(async (p, i) => {
    const row = { id: i, url: p.url, brand: p.brand || "SnapMaker", ...(await probeCached(p)) };
    const qf = queuedFile.get(i);
    if (qf) row.queuedFile = qf;
    return row;
  }));
  res.json(out);
});

// Only the local machine may stage arbitrary filesystem paths onto a printer —
// this bypasses the gcodeFolder jail that keeps the normal web UI sandboxed.
function isLoopback(req) {
  const ip = req.socket.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

app.post("/api/notify-load", async (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ error: "localhost only" });
  const { file, printer, outputname } = req.body || {};
  if (!file || typeof file !== "string") return res.status(400).json({ error: "file required" });
  if (!printer) return res.status(400).json({ error: "printer required" });
  if (outputname && /["\r\n/\\]/.test(outputname)) return res.status(400).json({ error: "Bad output name" });
  const absFile = path.resolve(file);
  if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) return res.status(404).json({ error: "File not found: " + absFile });
  const idx = findPrinterIndex(printer);
  if (idx === -1) return res.status(400).json({ error: "Unknown printer: " + printer });
  const p = PRINTERS[idx];
  // outputname is used exactly as given — it's what the file is uploaded and
  // displayed as. The file actually read off disk is always absFile.
  const name = outputname ? outputname.trim() : path.basename(absFile);

  if (!(await isPrinterIdle(p))) {
    pendingLoad.set(idx, { file: absFile, name, ts: Date.now() });
    return res.json({ ok: true, mode: "pending", printer: p.name });
  }

  uploadNotifiedFile(idx, { file: absFile, name });
  res.json({ ok: true, mode: "queued", printer: p.name });
});

// ---- Camera snapshot: Snapmaker U1 monitor.jpg via Moonraker WebSocket RPC ----
// Mirrors the Python camera-proxy logic: start_monitor → fetch JPEG → idle stop_monitor.
const CAM_START_COOLDOWN = 5;   // seconds between repeated start_monitor calls
const CAM_IDLE_STOP      = 60;  // seconds of inactivity before stop_monitor
const camState = new Map();     // per printer-index: { lastStart, lastRequest, stopTimer }

function getCamState(idx) {
  if (!camState.has(idx)) camState.set(idx, { lastStart: 0, lastRequest: 0, stopTimer: null });
  return camState.get(idx);
}

// Send a single JSON-RPC call over Moonraker's WebSocket then close immediately.
function cameraRpc(p, method, params = {}) {
  return new Promise(resolve => {
    if (typeof WebSocket === "undefined") return resolve(); // Node <21: skip silently
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const ip   = new URL(baseUrl(p)).hostname;
      const token = p.token || "";
      const wsUrl = `ws://${ip}/websocket${token ? "?token=" + encodeURIComponent(token) : ""}`;
      const ws   = new WebSocket(wsUrl);
      const payload = JSON.stringify({ id: Date.now(), jsonrpc: "2.0", method, params });
      const timer = setTimeout(() => { try { ws.close(); } catch {} finish(); }, 3000);
      ws.onopen    = () => ws.send(payload);
      ws.onmessage = () => { clearTimeout(timer); try { ws.close(); } catch {} finish(); };
      ws.onerror   = () => { clearTimeout(timer); finish(); };
      ws.onclose   = () => { clearTimeout(timer); finish(); };
    } catch { finish(); }
  });
}

async function ensureCameraRunning(idx, printer) {
  const st     = getCamState(idx);
  const domain = printer.cameraDomain || "lan";
  const now    = Date.now() / 1000;

  if (now - st.lastStart >= CAM_START_COOLDOWN) {
    st.lastStart = now;
    await cameraRpc(printer, "camera.start_monitor", { domain, interval: 0 });
    // Give the camera a moment to capture and write the first frame
    await new Promise(r => setTimeout(r, 1200));
  }

  st.lastRequest = now;
  if (st.stopTimer) clearTimeout(st.stopTimer);
  st.stopTimer = setTimeout(async () => {
    st.stopTimer = null;
    await cameraRpc(printer, "camera.stop_monitor", { domain });
  }, CAM_IDLE_STOP * 1000);
}

// Grab one camera frame as a JPEG buffer. Throws with a user-showable message.
async function getSnapshot(idx, p) {
  await ensureCameraRunning(idx, p);
  const snapUrl = baseUrl(p) + "/server/files/camera/monitor.jpg";
  let r = await fetchTimeout(snapUrl, 6000);
  // If still 404 after the initial wait, retry once after another second
  if (r.status === 404) {
    await new Promise(ok => setTimeout(ok, 1000));
    r = await fetchTimeout(snapUrl, 6000);
  }
  if (!r.ok) throw new Error("Camera HTTP " + r.status + " — is the camera connected?");
  return Buffer.from(await r.arrayBuffer());
}

app.get("/api/snapshot", requireAuth, async (req, res) => {
  const idx = parseInt(req.query.printer, 10);
  const p   = PRINTERS[idx];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  try {
    const buf = await getSnapshot(idx, p);
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "no-store");
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: "No camera frame: " + e.message });
  }
});

// ---- Thumbnail proxy: fetch gcode thumbnail from Moonraker ----
app.get("/api/thumbnail", requireAuth, async (req, res) => {
  const p = PRINTERS[req.query.printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: "Missing file" });
  const thumbUrl = baseUrl(p) + "/server/files/gcodes/.thumbs/" + encodeURIComponent(file) + "-300x300.png";
  try {
    const r = await fetchTimeout(thumbUrl, 5000);
    if (!r.ok) return res.status(r.status).end();
    res.set("Content-Type", r.headers.get("content-type") || "image/png");
    // Effectively permanent: the client puts a per-job token in the URL, so a
    // new print job (even of a re-sliced same-name file) is a new cache entry —
    // one printer read per job, zero re-reads mid-print.
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).end();
  }
});

// ---- Unload filament from extruder(s) ----
app.post("/api/unload", requireRegular, async (req, res) => {
  const { printer, extruders } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!Array.isArray(extruders) || !extruders.length) return res.status(400).json({ error: "No extruders specified" });
  try {
    for (const e of extruders) {
      await sendGcode(p, "AUTO_FEEDING EXTRUDER=" + parseInt(e, 10) + " UNLOAD=1");
    }
    res.json({ ok: true, printer: p.name, extruders });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Set bed temperature on a printer (M140 — standard, no wait) ----
app.post("/api/bedtemp", requireRegular, async (req, res) => {
  const { printer, temp } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  const t = Number(temp);
  if (!Number.isFinite(t) || t < 0 || t > 120) return res.status(400).json({ error: "Temp must be 0–120 °C" });
  try {
    await sendGcode(p, "M140 S" + Math.round(t));
    res.json({ ok: true, printer: p.name, target: Math.round(t) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Network inventory: name / IP / MAC / serial, for DHCP reservations ----
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

async function probeInfo(p) {
  try {
    const { ok, status, json } = await fetchJSONTimeout(baseUrl(p) + "/machine/system_info", 3500);
    if (!ok) return { name: p.name, online: false, error: "HTTP " + status };
    const si = json.result.system_info || {};
    const pi = si.product_info || {};
    const { iface, mac, ip } = pickIface(si.network || {});
    return {
      name: p.name, online: true,
      device_name: pi.device_name || null,
      machine_type: pi.machine_type || null,
      serial: pi.serial_number || null,
      iface, mac, ip
    };
  } catch (e) {
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

// ---- Firmware inventory (same Moonraker APIs fluidd reads) ----
// Full firmware detail is only pulled from printers that aren't moving:
// standby / complete / cancelled. Busy or offline machines are listed as
// skipped with the reason.
async function probeFirmware(p) {
  const st = await probeCached(p);
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
    // are the U1 toolheads.
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

app.get("/api/firmware", requireAuth, async (req, res) => {
  const out = await Promise.all(PRINTERS.map((p, i) => probeFirmware(p).then(r => ({ id: i, ...r }))));
  res.json(out);
});

// ---- Filesystem browser (for folder picker) ----
app.get("/api/browse", requireAdmin, (req, res) => {
  const isWin = process.platform === "win32";

  // Windows-only: list available drives
  if (req.query.drives === "1") {
    const drives = [];
    for (let c = 65; c <= 90; c++) {
      const d = String.fromCharCode(c) + ":\\";
      try { fs.accessSync(d); drives.push(d); } catch {}
    }
    return res.json({ drives });
  }

  let p = req.query.path ? path.resolve(req.query.path) : os.homedir();
  try { if (!fs.statSync(p).isDirectory()) p = path.dirname(p); }
  catch { p = os.homedir(); }

  const up = path.dirname(p);
  const atRoot = up === p;

  let entries = [];
  try {
    entries = fs.readdirSync(p, { withFileTypes: true })
      .filter(e => { try { return e.isDirectory(); } catch { return false; } })
      .map(e => ({ name: e.name, path: path.join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  } catch {}

  res.json({ path: p, parent: atRoot ? null : up, entries, isWin, atRoot });
});

app.get("/api/inventory", requireAuth, async (req, res) => {
  const out = await Promise.all(PRINTERS.map((p, i) => probeInfo(p).then(r => ({ id: i, ...r }))));
  res.json(out);
});

// ---- Printer hours: proxy Moonraker history/totals ----
app.get("/api/printer-hours", requireAuth, async (req, res) => {
  const p = PRINTERS[req.query.printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  try {
    const { ok, status, json: j } = await fetchJSONTimeout(baseUrl(p) + "/server/history/totals", 5000);
    if (!ok) return res.status(502).json({ error: "Moonraker " + status });
    const tt = (j.result && j.result.job_totals && typeof j.result.job_totals.total_time === "number") ? j.result.job_totals.total_time : null;
    res.json({ totalSeconds: tt });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Maintenance log per printer ----
app.get("/api/maintenance", requireAuth, (req, res) => {
  const idx = parseInt(req.query.printer, 10);
  const p = PRINTERS[idx];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  res.json(p.maintenance || []);
});

app.post("/api/maintenance", requireRegular, (req, res) => {
  const { printer, entry } = req.body || {};
  const idx = parseInt(printer, 10);
  const p = PRINTERS[idx];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!entry || !entry.date) return res.status(400).json({ error: "Missing date" });
  if (!p.maintenance) p.maintenance = [];
  p.maintenance.push({ date: String(entry.date), comment: String(entry.comment || ""), hours: String(entry.hours || "—"), totalSeconds: entry.totalSeconds != null ? Number(entry.totalSeconds) : null });
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2));
    res.json({ ok: true, maintenance: p.maintenance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Settings: read/write config from the UI (no file editing) ----
// Role-aware: non-Admin roles never see printers[] (and therefore never see
// Moonraker tokens), notifications, or the Resend API key. This is the actual
// fix for the plaintext-token leak that motivated keeping users.json separate
// from config.json in the first place.
function publicCfg(role) {
  const base = {
    gcodeFolder: CFG.gcodeFolder || "./gcode",
    folderResolved: FOLDER,
    refreshInterval: CFG.refreshInterval || 2,
    filamentCost: CFG.filamentCost || null,
    electricityRate: CFG.electricityRate || null,
    tNotation: CFG.tNotation || false,
    openCompact: CFG.openCompact || false,
    allowMapping: CFG.allowMapping !== false,
    suggestMatching: CFG.suggestMatching !== false,
    usersEnabled: !!CFG.usersEnabled,
    configured: PRINTERS.length > 0
  };
  if (role !== "admin") return base;
  return {
    ...base,
    notifications: CFG.notifications || null,
    printers: PRINTERS,
    // The Resend API key never round-trips to the browser, even for Admin —
    // unlike printer tokens (which do, into a masked <input>), this secret
    // gets the stricter treatment since leaking it is exactly what this
    // feature is partly meant to close off.
    resend: { fromAddress: (CFG.resend && CFG.resend.fromAddress) || "", hasApiKey: !!(CFG.resend && CFG.resend.apiKey) }
  };
}
app.get("/api/config", requireAuth, (req, res) => res.json(publicCfg(req.user.role)));
app.get("/api/version", (req, res) => res.json({ version: VERSION }));

app.post("/api/config", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (b.usersEnabled && !USERS.some(u => u.role === "admin")) {
    return res.status(400).json({ error: "Create an Admin user before enabling User Access Management" });
  }
  const next = {
    gcodeFolder: (typeof b.gcodeFolder === "string" && b.gcodeFolder.trim()) ? b.gcodeFolder.trim() : (CFG.gcodeFolder || "./gcode"),
    refreshInterval: (typeof b.refreshInterval === "number" && b.refreshInterval >= 1 && b.refreshInterval <= 60) ? b.refreshInterval : (CFG.refreshInterval || 2),
    filamentCost: (typeof b.filamentCost === "number" && b.filamentCost > 0) ? b.filamentCost : undefined,
    electricityRate: (typeof b.electricityRate === "number" && b.electricityRate > 0) ? b.electricityRate : undefined,
    tNotation: b.tNotation ? true : undefined,
    openCompact: b.openCompact ? true : undefined,
    // Unlike tNotation/openCompact (default off, "omit means false" is safe),
    // these default ON — so absence must fall back to the previous stored
    // value, not to false, or unchecking them would never persist.
    allowMapping: (typeof b.allowMapping === "boolean") ? b.allowMapping : (CFG.allowMapping !== false),
    suggestMatching: (typeof b.suggestMatching === "boolean") ? b.suggestMatching : (CFG.suggestMatching !== false),
    usersEnabled: b.usersEnabled ? true : undefined,
    resend: (b.resend && typeof b.resend === "object") ? {
      apiKey: (typeof b.resend.apiKey === "string" && b.resend.apiKey.trim()) ? b.resend.apiKey.trim() : ((CFG.resend && CFG.resend.apiKey) || undefined),
      fromAddress: String(b.resend.fromAddress || "").trim()
    } : (CFG.resend || undefined),
    notifications: (b.notifications && typeof b.notifications === "object") ? {
      enabled: !!b.notifications.enabled,
      onEvents: !!b.notifications.onEvents,
      onIntervals: !!b.notifications.onIntervals,
      includeImage: !!b.notifications.includeImage,
      service: b.notifications.service === "telegram" ? "telegram" : "ntfy",
      ntfyTopic: String(b.notifications.ntfyTopic || "").trim(),
      telegramChatId: String(b.notifications.telegramChatId || "").trim()
    } : (CFG.notifications || undefined),
    port: PORT,
    printers: Array.isArray(b.printers)
      ? b.printers.filter(p => p && p.url).map(p => {
          const o = { name: String(p.name || p.url), url: String(p.url) };
          if (p.brand) o.brand = String(p.brand);
          if (p.location) o.location = String(p.location);
          if (p.costKwh) o.costKwh = String(p.costKwh);
          if (p.purchaseDate) o.purchaseDate = String(p.purchaseDate);
          if (p.autoLevel) o.autoLevel = true;
          if (p.pushNotify) o.pushNotify = true;
          if (p.serial) o.serial = String(p.serial);
          if (p.verificationCode) o.verificationCode = String(p.verificationCode).slice(0, 4);
          if (p.token) o.token = String(p.token);
          const existing = PRINTERS.find(ep => ep.url === o.url);
          if (existing && existing.maintenance) o.maintenance = existing.maintenance;
          return o;
        })
      : (CFG.printers || [])
  };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
    loadConfig();
    res.json({ ok: true, ...publicCfg(req.user.role) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- User Access Management: session, login, OTP, user CRUD ----
// Every route below is reachable even when usersEnabled is false (the client
// never calls most of them in that case), but each checks CFG.usersEnabled
// itself where it matters so a stray call can't do anything surprising.
const LOGIN_NAME_RE = /^[a-zA-Z0-9_.-]{2,32}$/;
const ROLES = ["view", "regular", "admin"];

function publicUser(u) {
  return { id: u.id, firstName: u.firstName || "", lastName: u.lastName || "", loginName: u.loginName, email: u.email || "", phone: u.phone || "", role: u.role, otpEnabled: !!u.otpEnabled, createdAt: u.createdAt, updatedAt: u.updatedAt };
}
function findUserByLoginName(loginName) {
  const norm = String(loginName || "").trim().toLowerCase();
  return norm ? USERS.find(u => u.loginNameLower === norm) : undefined;
}
// Admins remaining if `excludeId` were removed/demoted — used by the
// last-admin guardrail on both PUT (demote) and DELETE.
function adminCountExcluding(excludeId) {
  return USERS.filter(u => u.role === "admin" && u.id !== excludeId).length;
}

app.get("/api/session", (req, res) => {
  if (!CFG.usersEnabled) return res.json({ usersEnabled: false });
  if (!req.user) return res.json({ usersEnabled: true, authenticated: false });
  res.json({ usersEnabled: true, authenticated: true, user: { id: req.user.id, loginName: req.user.loginName, firstName: req.user.firstName, lastName: req.user.lastName, role: req.user.role } });
});

app.post("/api/login", async (req, res) => {
  if (!CFG.usersEnabled) return res.status(400).json({ error: "User Access Management is not enabled" });
  const { loginName, password } = req.body || {};
  const u = findUserByLoginName(loginName);
  if (!u) return res.status(401).json({ error: "Invalid login name or password" });
  if (u.otpEnabled) return res.status(400).json({ error: 'This account signs in with an emailed code — use "Email me a code instead"' });
  if (!(await auth.verifyPassword(String(password || ""), u.passwordHash))) return res.status(401).json({ error: "Invalid login name or password" });
  const token = auth.createSession(u.id);
  res.cookie(auth.SESSION_COOKIE, token, auth.sessionCookieOptions());
  res.json({ ok: true, user: { id: u.id, loginName: u.loginName, firstName: u.firstName, lastName: u.lastName, role: u.role } });
});

// Deliberately generic: whether the login name doesn't exist, isn't an OTP
// account, or has no email on file all produce the same message, so this
// can't be used to enumerate accounts.
app.post("/api/login/otp/request", async (req, res) => {
  if (!CFG.usersEnabled) return res.status(400).json({ error: "User Access Management is not enabled" });
  if (!CFG.resend || !CFG.resend.apiKey || !CFG.resend.fromAddress) return res.status(500).json({ error: "Email login is not configured" });
  const u = findUserByLoginName((req.body || {}).loginName);
  if (!u || !u.otpEnabled || !u.email) return res.status(400).json({ error: "Could not send a code for that login name" });
  const code = auth.setOtpCode(u.loginNameLower);
  try {
    await sendResendEmail({
      apiKey: CFG.resend.apiKey, fromAddress: CFG.resend.fromAddress, to: u.email,
      subject: "Your SnapCon login code",
      text: "Your SnapCon login code is: " + code + "\n\nThis code expires in 10 minutes."
    });
  } catch (e) {
    return res.status(502).json({ error: "Could not send the code: " + e.message });
  }
  res.json({ ok: true });
});

app.post("/api/login/otp/verify", (req, res) => {
  if (!CFG.usersEnabled) return res.status(400).json({ error: "User Access Management is not enabled" });
  const { loginName, code } = req.body || {};
  const u = findUserByLoginName(loginName);
  if (!u || !u.otpEnabled) return res.status(401).json({ error: "Incorrect code" });
  const result = auth.verifyOtpCode(u.loginNameLower, code);
  if (!result.ok) return res.status(401).json({ error: result.error });
  const token = auth.createSession(u.id);
  res.cookie(auth.SESSION_COOKIE, token, auth.sessionCookieOptions());
  res.json({ ok: true, user: { id: u.id, loginName: u.loginName, firstName: u.firstName, lastName: u.lastName, role: u.role } });
});

app.post("/api/logout", (req, res) => {
  if (req.sessionToken) auth.destroySession(req.sessionToken);
  res.clearCookie(auth.SESSION_COOKIE);
  res.json({ ok: true });
});

app.get("/api/users", requireAdmin, (req, res) => {
  res.json(USERS.map(publicUser));
});

app.post("/api/users", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const loginName = String(b.loginName || "").trim();
  if (!LOGIN_NAME_RE.test(loginName)) return res.status(400).json({ error: "Login name must be 2-32 characters (letters, numbers, _ . -)" });
  const loginNameLower = loginName.toLowerCase();
  if (USERS.some(u => u.loginNameLower === loginNameLower)) return res.status(400).json({ error: "That login name is already in use" });
  if (!ROLES.includes(b.role)) return res.status(400).json({ error: "Invalid role" });
  const otpEnabled = !!b.otpEnabled;
  let passwordHash = null;
  if (!otpEnabled) {
    const password = String(b.password || "");
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    passwordHash = await auth.hashPassword(password);
  }
  const now = new Date().toISOString();
  const u = {
    id: auth.newUserId(),
    firstName: String(b.firstName || "").trim(), lastName: String(b.lastName || "").trim(),
    loginName, loginNameLower,
    email: String(b.email || "").trim(), phone: String(b.phone || "").trim(),
    role: b.role, otpEnabled, passwordHash,
    createdAt: now, updatedAt: now
  };
  USERS.push(u);
  try { saveUsers(); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, user: publicUser(u) });
});

app.put("/api/users/:id", requireAdmin, async (req, res) => {
  const u = USERS.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: "User not found" });
  const b = req.body || {};

  // Validate everything into locals first — nothing on the live `u` object
  // (still referenced by any active session via authMiddleware) is mutated
  // until every check below has passed, so a request that fails partway
  // through can't leave in-memory state ahead of what's on disk.
  let loginName, loginNameLower;
  if (b.loginName !== undefined) {
    loginName = String(b.loginName || "").trim();
    if (!LOGIN_NAME_RE.test(loginName)) return res.status(400).json({ error: "Login name must be 2-32 characters (letters, numbers, _ . -)" });
    loginNameLower = loginName.toLowerCase();
    if (USERS.some(x => x.id !== u.id && x.loginNameLower === loginNameLower)) return res.status(400).json({ error: "That login name is already in use" });
  }
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) return res.status(400).json({ error: "Invalid role" });
    if (u.role === "admin" && b.role !== "admin" && adminCountExcluding(u.id) === 0) return res.status(400).json({ error: "Cannot demote the last Admin" });
  }
  const nextOtpEnabled = b.otpEnabled !== undefined ? !!b.otpEnabled : u.otpEnabled;
  if (b.password) {
    if (nextOtpEnabled) return res.status(400).json({ error: "OTP-enabled accounts cannot have a password" });
    if (String(b.password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  const willHavePassword = nextOtpEnabled ? false : (b.password ? true : !!u.passwordHash);
  if (!nextOtpEnabled && !willHavePassword) return res.status(400).json({ error: "Set a password, or enable OTP login" });
  const newPasswordHash = b.password ? await auth.hashPassword(String(b.password)) : undefined;

  // Every check passed — apply.
  if (loginName !== undefined) { u.loginName = loginName; u.loginNameLower = loginNameLower; }
  if (b.role !== undefined) u.role = b.role;
  if (b.firstName !== undefined) u.firstName = String(b.firstName || "").trim();
  if (b.lastName !== undefined) u.lastName = String(b.lastName || "").trim();
  if (b.email !== undefined) u.email = String(b.email || "").trim();
  if (b.phone !== undefined) u.phone = String(b.phone || "").trim();
  u.otpEnabled = nextOtpEnabled;
  if (nextOtpEnabled) u.passwordHash = null; // forced regardless of what the request body contains
  else if (newPasswordHash) u.passwordHash = newPasswordHash;
  u.updatedAt = new Date().toISOString();
  try { saveUsers(); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, user: publicUser(u) });
});

app.delete("/api/users/:id", requireAdmin, (req, res) => {
  const idx = USERS.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "User not found" });
  if (USERS[idx].role === "admin" && adminCountExcluding(USERS[idx].id) === 0) return res.status(400).json({ error: "Cannot delete the last Admin" });
  const [removed] = USERS.splice(idx, 1);
  try { saveUsers(); } catch (e) { USERS.splice(idx, 0, removed); return res.status(500).json({ error: e.message }); }
  if (removed.id === (req.user && req.user.id)) { auth.destroySession(req.sessionToken); res.clearCookie(auth.SESSION_COOKIE); }
  res.json({ ok: true });
});

// Mirrors /api/notify-test's "test the live form values, not necessarily
// saved ones" UX — works before the Resend settings have been saved.
app.post("/api/email-test", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const apiKey = (typeof b.apiKey === "string" && b.apiKey.trim()) ? b.apiKey.trim() : ((CFG.resend && CFG.resend.apiKey) || "");
  const fromAddress = String(b.fromAddress || (CFG.resend && CFG.resend.fromAddress) || "").trim();
  const to = String(b.to || "").trim();
  if (!apiKey) return res.status(400).json({ error: "Enter a Resend API key first" });
  if (!fromAddress) return res.status(400).json({ error: "Enter a from-address first" });
  if (!to) return res.status(400).json({ error: "Enter a test recipient address" });
  try {
    await sendResendEmail({ apiKey, fromAddress, to, subject: "SnapCon test email", text: "This is a test email from SnapCon." });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Notifications ----
// The notification icon is fetched by the ntfy CLIENT (the phone), so it needs
// a URL the phone can reach — the LAN address of this hub, not localhost.
function lanAddr() {
  const ifs = os.networkInterfaces();
  for (const name in ifs) for (const a of ifs[name] || [])
    if (a.family === "IPv4" && !a.internal) return a.address + ":" + PORT;
  return "localhost:" + PORT;
}
function lanHost(req) {
  const host = (req && req.headers.host) || "";
  if (host && !/^(localhost|127\.)/i.test(host)) return host;
  return lanAddr();
}

function fmtDur(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return "—";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? h + "h " + String(m).padStart(2, "0") + "m" : m + "m";
}

// Event notification body. Start is a one-liner; everything else carries the
// live stats (the picture, when included, follows as the ntfy attachment).
function eventMessage(ev, st) {
  const job = st.filename || "job";
  const lines = [];
  if (ev === "start") lines.push("Started " + job);
  else if (ev === "complete") lines.push(job + " Completed");
  else if (/^\d+%$/.test(ev)) lines.push(job + " " + ev);
  else lines.push(ev.charAt(0).toUpperCase() + ev.slice(1));
  if (ev !== "start") {
    if (st.bed) lines.push(`Bed: ${st.bed.temp}/${st.bed.target}°C`);
    if (st.hotend) lines.push(`Hotend: ${st.hotend.temp}/${st.hotend.target}°C`);
    if (st.layer) lines.push(`Layer: ${st.layer.current}/${st.layer.total}`);
    const rem = (st.progress > 0 && st.elapsed > 0) ? st.elapsed * (1 / st.progress - 1) : null;
    lines.push("Elapsed: " + fmtDur(st.elapsed) + (rem != null ? "  ·  Remaining: " + fmtDur(rem) : ""));
  }
  return lines.join("\n");
}

// Publish to ntfy.sh. Title/message/icon travel as query params (headers can't
// hold multi-line text); an image goes as the PUT body so ntfy hosts it.
async function sendNtfy({ topic, title, message, iconUrl, image }) {
  const qs = new URLSearchParams({ title, message });
  if (iconUrl) qs.set("icon", iconUrl);
  const url = "https://ntfy.sh/" + encodeURIComponent(topic) + "?" + qs;
  const opts = image
    ? { method: "PUT", headers: { "Filename": "snapshot.jpg", "Content-Type": "image/jpeg" }, body: image }
    : { method: "POST" };
  const r = await fetchTimeout(url, 15000, opts);
  if (!r.ok) throw new Error("ntfy.sh " + r.status + ": " + (await r.text()).slice(0, 160));
}

// Send an OTP login code (or a test message) via Resend's HTTP API — a plain
// fetchTimeout() POST, same shape as sendNtfy() above, so this needs no
// nodemailer/SMTP dependency.
async function sendResendEmail({ apiKey, fromAddress, to, subject, text }) {
  const r = await fetchTimeout("https://api.resend.com/emails", 15000, {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromAddress, to, subject, text })
  });
  if (!r.ok) throw new Error("Resend " + r.status + ": " + (await r.text()).slice(0, 160));
}

async function sendEventNotification(idx, p, ev, st) {
  const nf = CFG.notifications || {};
  let message = eventMessage(ev, st);
  let image = null;
  if (nf.includeImage) {
    try { image = await getSnapshot(idx, p); }
    catch { /* no camera — send the text anyway */ }
  }
  await sendNtfy({
    topic: nf.ntfyTopic, title: p.name, message, image,
    iconUrl: "http://" + lanAddr() + "/snapcon-icon-512.png"
  });
}

// ---- Notification watcher ----
// Polls printer state on its own schedule (independent of any open browser),
// fires event notifications on state transitions and interval notifications
// when a print crosses 25/50/75%. Reads CFG live, so settings changes apply
// without a restart.
const NOTIFY_POLL_MS = 30 * 1000;
const NOTIFY_STATE = new Map();   // printer url -> { state, filename, progress, milestones:Set }

async function notifyTick() {
  const nf = CFG.notifications || {};
  if (!nf.enabled || nf.service !== "ntfy" || !nf.ntfyTopic) return;
  if (!nf.onEvents && !nf.onIntervals) return;

  await Promise.all(PRINTERS.map(async (p, i) => {
    const st = await probeCached(p);
    if (!st.online) return;
    const prev = NOTIFY_STATE.get(p.url);
    const cur = {
      state: st.state, filename: st.filename, progress: st.progress || 0,
      milestones: prev ? prev.milestones : new Set()
    };

    // A new job = entered "printing" from anything but a pause (resume is not
    // a start), or the filename changed under a running printer.
    const newJob = prev && st.state === "printing" &&
      ((prev.state !== "printing" && prev.state !== "paused") ||
       (st.filename && prev.filename !== st.filename));
    if (newJob) cur.milestones = new Set();

    if (!prev) {
      // First sight of this printer (server just started): record where it is
      // and seed already-passed milestones so we don't fire a burst of stale
      // notifications for a print that's been running for hours.
      [25, 50, 75].forEach(m => { if (cur.progress * 100 >= m) cur.milestones.add(m); });
      NOTIFY_STATE.set(p.url, cur);
      return;
    }
    NOTIFY_STATE.set(p.url, cur);

    try {
      if (nf.onEvents) {
        if (newJob) await sendEventNotification(i, p, "start", st);
        else if (st.state !== prev.state && ["complete", "paused", "error", "cancelled"].includes(st.state)) {
          await sendEventNotification(i, p, st.state === "paused" ? "paused" : st.state, st);
        }
      }
      if (nf.onIntervals && st.state === "printing") {
        for (const m of [25, 50, 75]) {
          if (cur.progress * 100 >= m && !cur.milestones.has(m)) {
            cur.milestones.add(m);
            await sendEventNotification(i, p, m + "%", st);
          }
        }
      }
    } catch (e) {
      console.log("notify: " + p.name + ": " + e.message);
    }
  }));
}
setInterval(notifyTick, NOTIFY_POLL_MS).unref();
notifyTick();   // prime NOTIFY_STATE at startup (first sight never notifies)

app.post("/api/notify-test", requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (b.service === "telegram") return res.status(400).json({ error: "Telegram is not implemented yet — select ntfy.sh" });
  const topic = String(b.topic || (CFG.notifications || {}).ntfyTopic || "").trim();
  if (!/^[-_A-Za-z0-9]{1,64}$/.test(topic)) return res.status(400).json({ error: "Enter a valid ntfy topic first" });

  // TEMPORARY: the test targets U1 Gold until the real event wiring lands.
  const idx = PRINTERS.findIndex(p => p.name === "U1 Gold" || String(p.url).includes("192.168.4.194"));
  if (idx < 0) return res.status(400).json({ error: 'Test printer "U1 Gold" not found in config' });
  const p = PRINTERS[idx];

  try {
    const st = await probe(p);
    if (!st.online) return res.status(502).json({ error: p.name + " is offline: " + (st.error || "") });
    const ev = st.state || "idle"; // test uses the live state as the event
    let message = eventMessage(ev, st);
    let image = null;
    if (b.includeImage !== false) {
      try { image = await getSnapshot(idx, p); }
      catch (e) { message += "\n(camera unavailable: " + e.message + ")"; }
    }
    await sendNtfy({
      topic, title: p.name, message, image,
      iconUrl: "http://" + lanHost(req) + "/snapcon-icon-512.png"
    });
    res.json({ ok: true, topic, printer: p.name });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Electricity rate lookup by US ZIP code (OpenEI Utility Rate Database) ----
app.get("/api/electricity-rate", requireAuth, async (req, res) => {
  const zip = (req.query.zip || "").trim().replace(/\D/g, "");
  if (!/^\d{5}$/.test(zip)) return res.status(400).json({ error: "Please enter a valid 5-digit US ZIP code" });
  try {
    const apiKey = CFG.openeiKey || "DEMO_KEY";
    const oeUrl = `https://api.openei.org/utility_rates?version=7&format=json&api_key=${encodeURIComponent(apiKey)}&address=${zip}&sector=Residential&limit=5&detail=full`;
    const [oeR, zippR] = await Promise.all([
      fetch(oeUrl),
      fetch(`https://api.zippopotam.us/us/${zip}`)
    ]);

    let location = zip;
    if (zippR.ok) {
      const zd = await zippR.json();
      const place = (zd.places || [])[0];
      if (place) location = `${place["place name"]}, ${place["state abbreviation"]}`;
    }

    if (!oeR.ok) return res.status(502).json({ error: "Could not reach OpenEI rate database", location });
    const data = await oeR.json();
    if (data.error) return res.status(400).json({ error: String(data.error), location });
    const items = data.items || [];
    if (!items.length) return res.status(404).json({ error: "No residential rates found for this ZIP code", location });

    // Pull base energy rate from energyratestructure[period=0][tier=0].rate ($/kWh)
    let rate = null, utilityName = "";
    for (const item of items) {
      const ers = item.energyratestructure;
      if (Array.isArray(ers) && Array.isArray(ers[0]) && ers[0][0] != null && ers[0][0].rate != null) {
        rate = parseFloat(ers[0][0].rate);
        utilityName = item.utility || "";
        break;
      }
    }
    if (rate == null) return res.status(502).json({ error: "Rate data found but $/kWh could not be extracted — enter manually", location });

    const cents = parseFloat((rate * 100).toFixed(2));
    rate = parseFloat(rate.toFixed(4));
    return res.json({ rate, cents, location, utility: utilityName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Auto-discovery: scan the local subnet(s) for Moonraker printers ----
function localSubnets() {
  const out = new Set();
  const ifs = os.networkInterfaces();
  for (const name in ifs) for (const a of ifs[name] || []) {
    if (a.family === "IPv4" && !a.internal) out.add(a.address.split(".").slice(0, 3).join("."));
  }
  return [...out];
}
// Port 80 catches the common case (Fluidd/Mainsail/KIAUH nginx proxying
// straight to Moonraker) — but plenty of stock images (e.g. Creality's K1
// series) run Moonraker directly on its own default port 7125 with nothing
// on 80 at all. Try both so those aren't invisible to the scan.
const DISCOVER_PORTS = [80, 7125];
async function probeMoonrakerAt(base) {
  const { ok, json } = await fetchJSONTimeout(`${base}/machine/system_info`, 900);
  if (!ok) return null;
  const si = (json.result || {}).system_info;
  if (!si) return null;
  const pi = si.product_info || {};
  const { mac } = pickIface(si.network || {});
  return { url: base, device_name: pi.device_name || null, machine_type: pi.machine_type || null, serial: pi.serial_number || null, mac };
}
async function probeMoonraker(ip) {
  for (const port of DISCOVER_PORTS) {
    const base = port === 80 ? `http://${ip}` : `http://${ip}:${port}`;
    try {
      const hit = await probeMoonrakerAt(base);
      if (hit) return { ip, ...hit };
    } catch { /* try the next port */ }
  }
  return null;
}
app.get("/api/probe-printer", requireAdmin, async (req, res) => {
  const url = (req.query.url || "").trim().replace(/\/+$/, "");
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const r = await fetchJSONTimeout(url + "/machine/system_info", 5000);
    if (!r.ok) return res.status(502).json({ error: "Could not reach printer" });
    const si = ((r.json.result || {}).system_info) || {};
    const pi = si.product_info || {};
    res.json({ name: pi.device_name || null, serial: pi.serial_number || null, brand: pi.machine_type || null });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/discover", requireAdmin, async (req, res) => {
  const found = [];
  let bases;
  if (req.query.subnet) {
    const parts = req.query.subnet.split(".");
    if (parts.length !== 4 || parts.some(p => isNaN(p) || +p < 0 || +p > 255)) {
      return res.status(400).json({ error: "Invalid subnet. Expected format: x.x.x.0" });
    }
    bases = [parts.slice(0, 3).join(".")];
  } else {
    bases = localSubnets();
  }
  for (const base of bases) {
    const ips = [];
    for (let i = 1; i <= 254; i++) ips.push(base + "." + i);
    const B = 40;
    for (let i = 0; i < ips.length; i += B) {
      const results = await Promise.all(ips.slice(i, i + B).map(probeMoonraker));
      results.forEach(r => { if (r) found.push(r); });
    }
  }
  res.json({ subnets: bases, found });
});

app.listen(PORT, () => {
  const url = "http://localhost:" + PORT;
  console.log("\n  SnapCon  v" + VERSION + "  →  " + url);
  console.log("  Folder:   " + FOLDER);
  console.log("  Config:   " + CONFIG_PATH);
  console.log("  Printers: " + (PRINTERS.map(p => p.name).join(", ") || "(none configured — open the page and use Settings)") + "\n");
  if (IS_PKG) {
    // Double-click launch: open the browser for the user.
    const cmd = process.platform === "win32" ? `start "" "${url}"`
      : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    try { require("child_process").exec(cmd); } catch {}
  }
});
