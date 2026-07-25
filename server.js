// server.js — SnapCon  ·  v0.2.0
// Watches a folder of sliced gcode, shows the toolhead/color map per file,
// and pushes the chosen file to the chosen printer via Moonraker (server-side,
// so no browser CORS headaches).

const VERSION = "0.2.0";

const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const readline = require("readline");
const { parseGcodeMap, parseGcodeMapLines } = require("./parser");
const auth = require("./auth");
const { getConnector, listConnectorTypes, CONNECTOR_TYPES, DEFAULT_TYPE: DEFAULT_CONNECTOR_TYPE } = require("./connectors");
const connHttp = require("./connectors/http-utils");
const { createRemoteAccessService } = require("./remote-access/RemoteAccessService");

// When packaged as a single executable (pkg), __dirname points inside the
// read-only bundle. User-editable files (config.json, the gcode folder) must
// live NEXT TO THE EXE instead. Bundled assets (public/, parser.js) stay on
// __dirname, which pkg maps into the snapshot.
const IS_PKG = typeof process.pkg !== "undefined";
const BASE_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
const ASSET_DIR = __dirname;

// /.dockerenv is created by the Docker Engine in every Linux container —
// the standard, reliable way to tell "are we in a container" without any
// extra permissions. Gates the Settings "Restart App" button: exiting only
// actually recovers when something is set up to relaunch us (the shipped
// docker-compose.yml sets `restart: unless-stopped`); on a bare `node
// server.js` or the packaged .exe there's no supervisor, so that button
// would just kill the app for good.
const IS_DOCKER = (() => { try { return fs.existsSync("/.dockerenv"); } catch { return false; } })();

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

const newPrinterId = () => "p_" + crypto.randomBytes(6).toString("hex");
// One-time migration for a config.json predating persistent printer ids:
// assigns one to any printer missing it, and moves that printer's inline
// maintenance log into CFG.maintenanceHistory (keyed by id, not nested in
// the printer object) — the whole point being that history now survives a
// printer being deleted, renamed, or re-IP'd, since it's no longer stored
// inside the array entry that disappears when that happens.
function ensurePrinterIds() {
  if (!CFG.maintenanceHistory || typeof CFG.maintenanceHistory !== "object") CFG.maintenanceHistory = {};
  let changed = false;
  for (const p of PRINTERS) {
    if (!p.id) { p.id = newPrinterId(); changed = true; }
    if (Array.isArray(p.maintenance)) {
      CFG.maintenanceHistory[p.id] = p.maintenance;
      delete p.maintenance;
      changed = true;
    }
  }
  if (changed) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch {} }
}
ensurePrinterIds();

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
// `--snapcon <host[:port]>` targets a SnapCon instance on a DIFFERENT machine
// (e.g. the slicing PC isn't the one hosting SnapCon). Since that instance
// can't read a path off this machine's disk, this mode reads the file itself
// and streams its bytes over HTTP instead of sending a path reference — the
// server materializes them into a temp file on its own side (see
// /api/notify-load below). Omit --snapcon to keep the original same-machine,
// zero-copy path-reference flow.
const CLI_LOAD_ARG = process.argv.indexOf("--load");
if (CLI_LOAD_ARG !== -1) {
  const file = process.argv[CLI_LOAD_ARG + 1];
  const printerArgI = process.argv.indexOf("--printer");
  const printer = printerArgI !== -1 ? process.argv[printerArgI + 1] : "";
  const outputArgI = process.argv.indexOf("--outputname");
  const outputname = outputArgI !== -1 ? process.argv[outputArgI + 1] : "";
  const snapconArgI = process.argv.indexOf("--snapcon");
  const snapconTarget = snapconArgI !== -1 ? process.argv[snapconArgI + 1] : "";
  if (!file) { console.error("--load requires a file path"); process.exit(1); }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { console.error("File not found: " + file); process.exit(1); }

  if (snapconTarget) {
    // "host", "host:port", "[ipv6]", or "[ipv6]:port" — bracket form first so
    // a bare colon inside an IPv6 address is never mistaken for a port split.
    const s = String(snapconTarget);
    const bracketed = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
    let hostname, port;
    if (bracketed) {
      hostname = bracketed[1]; port = bracketed[2] ? parseInt(bracketed[2], 10) : 4545;
    } else {
      const i = s.lastIndexOf(":");
      const tail = i !== -1 ? s.slice(i + 1) : "";
      if (i !== -1 && /^\d+$/.test(tail)) { hostname = s.slice(0, i); port = parseInt(tail, 10); }
      else { hostname = s; port = 4545; }
    }
    const stat = fs.statSync(file);
    const qs = "printer=" + encodeURIComponent(printer) + "&outputname=" + encodeURIComponent(outputname) + "&filename=" + encodeURIComponent(path.basename(file));
    const req = http.request({
      hostname, port, path: "/api/notify-load?" + qs, method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": stat.size }
    }, res => {
      let b = ""; res.setEncoding("utf8"); res.on("data", d => b += d);
      res.on("end", () => {
        if (res.statusCode >= 300) { console.error("SnapCon: " + b); process.exit(1); }
        console.log("SnapCon: " + b); process.exit(0);
      });
    });
    req.on("error", e => { console.error("Could not reach SnapCon at " + hostname + ":" + port + " (" + e.message + ")"); process.exit(1); });
    fs.createReadStream(file).pipe(req);
    return;
  }

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

// Temp staging area for files pushed from a remote --snapcon CLI call (see
// /api/notify-load) — the server can't reference a path on the CLI's own
// machine, so it writes the pushed bytes here first. Wiped on every startup
// to drop anything orphaned by a crash mid-transfer.
const NOTIFY_TMP_DIR = path.join(BASE_DIR, ".notify-tmp");
try { fs.rmSync(NOTIFY_TMP_DIR, { recursive: true, force: true }); } catch {}

const app = express();
app.use(express.json({ limit: "1mb" }));
// Separate parser (different Content-Type) for the raw gcode bytes a remote
// --snapcon push sends to /api/notify-load — express.json() above ignores
// non-JSON bodies and leaves the stream untouched, so layering this is safe.
const rawGcodeBody = express.raw({ type: "application/octet-stream", limit: "2gb" });
app.use(express.static(path.join(ASSET_DIR, "public")));
// Annotates req.user on every /api request; when usersEnabled is false this
// always resolves to an implicit admin, so every route below behaves exactly
// as it does today. Individual routes layer requireAuth/requireRegular/
// requireAdmin on top where they need to actually enforce something.
app.use("/api", auth.makeAuthMiddleware(() => CFG, () => USERS));
const { requireAuth, requireRegular, requireAdmin } = auth;

// Remote Access (Cloudflare Tunnel, managed) — Development Preview. Cheap to
// construct (no I/O here); the actual startupInit() call — which may spawn
// a process — happens later, inside app.listen's callback, not here (see
// that callback for why: the server must be accepting requests first).
const remoteAccess = createRemoteAccessService({ baseDir: BASE_DIR, getConfig: () => CFG, getUsers: () => USERS, port: PORT });
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

// fetchTimeout/fetchJSONTimeout/baseUrl/pickIface are generic HTTP helpers
// (not printer-protocol-specific) shared with connectors/ — see
// connectors/http-utils.js. Everything printer-protocol-specific now lives
// behind getConnector(p.connector), never called directly from here.
const { fetchTimeout, fetchJSONTimeout, baseUrl } = connHttp;

// Resolve a requested path safely INSIDE the watched folder (no traversal).
function safePath(sub) {
  if (!sub) return null;
  const p = path.resolve(FOLDER, sub);
  return p.startsWith(FOLDER) ? p : null;
}


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
      // .gx/.3mf are FlashForge's slicer output (.3mf specifically for
      // multi-material/IFS jobs on the AD5X) — without these, a FlashForge
      // user's sliced files never show up here at all.
      .filter(e => e.isFile() && /\.(gcode|gco|g|gx|3mf)$/i.test(e.name))
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

// Recursive walk under `dir`, filtering to the same sliced-file extensions
// /api/files uses — `relSub` is the "/"-joined relative path the client
// already speaks (CURRENT_SUB), built independently of the OS path separator
// so it round-trips straight back into safePath()/loadFiles() unchanged.
function walkFilesRecursive(dir, relSub, q, results, limit) {
  if (results.length >= limit) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (results.length >= limit) return;
    if (e.name.startsWith(".")) continue; // skip .thumbs and other hidden dirs
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkFilesRecursive(fp, relSub ? relSub + "/" + e.name : e.name, q, results, limit);
    } else if (e.isFile() && /\.(gcode|gco|g|gx|3mf)$/i.test(e.name) && e.name.toLowerCase().includes(q)) {
      const st = fs.statSync(fp);
      results.push({ name: e.name, sub: relSub, size: st.size, mtime: st.mtimeMs });
    }
  }
}

app.get("/api/files/search", requireAuth, (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) return res.json({ files: [] });
  const results = [];
  walkFilesRecursive(FOLDER, "", q, results, 300);
  results.sort((a, b) => b.mtime - a.mtime);
  res.json({ files: results });
});

app.post("/api/files/mkdir", requireRegular, (req, res) => {
  const { sub, name } = req.body || {};
  const dir = sub ? safePath(sub) : FOLDER;
  if (!dir || !fs.existsSync(dir)) return res.status(400).json({ error: "Invalid folder" });
  const clean = String(name || "").trim();
  if (!clean || /[\\/]/.test(clean) || clean === "." || clean === "..") {
    return res.status(400).json({ error: "Invalid folder name" });
  }
  const target = path.join(dir, clean);
  if (!target.startsWith(FOLDER)) return res.status(400).json({ error: "Invalid folder name" });
  if (fs.existsSync(target)) return res.status(409).json({ error: "Already exists" });
  try { fs.mkdirSync(target); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Move one or more files (each identified by its own {sub, name}, since a
// multi-select drag can span several source folders at once) into targetSub.
app.post("/api/files/move", requireRegular, (req, res) => {
  const { files, targetSub } = req.body || {};
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: "No files given" });
  const targetDir = targetSub ? safePath(targetSub) : FOLDER;
  if (!targetDir || !fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return res.status(400).json({ error: "Invalid target folder" });
  }
  const results = files.map(f => {
    const name = String((f || {}).name || "");
    const rel = (f.sub ? f.sub + "/" : "") + name;
    const srcPath = safePath(rel);
    if (!name || !srcPath || !fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
      return { name, ok: false, error: "Not found" };
    }
    const destPath = path.join(targetDir, name);
    if (path.dirname(srcPath) === targetDir) return { name, ok: false, error: "Already there" };
    if (fs.existsSync(destPath)) return { name, ok: false, error: "Already exists in target" };
    try { fs.renameSync(srcPath, destPath); return { name, ok: true }; }
    catch (e) { return { name, ok: false, error: e.message }; }
  });
  res.json({ results });
});

// Local-PC → gcode-folder upload (the reverse direction of /api/print's
// printer upload): one file per request, raw bytes, name/sub in the query
// string — mirrors /api/notify-load's existing raw-body convention instead
// of pulling in a multipart-parsing dependency for a single call site.
app.post("/api/files/upload", requireRegular, rawGcodeBody, (req, res) => {
  const sub = String(req.query.sub || "");
  const dir = sub ? safePath(sub) : FOLDER;
  if (!dir || !fs.existsSync(dir)) return res.status(400).json({ error: "Invalid folder" });
  const name = path.basename(String(req.query.name || "").trim());
  if (!name || !/\.(gcode|gco|g|gx|3mf)$/i.test(name)) {
    return res.status(400).json({ error: "Only sliced files (.gcode/.gco/.g/.gx/.3mf) can be uploaded here" });
  }
  const target = path.join(dir, name);
  if (!target.startsWith(FOLDER)) return res.status(400).json({ error: "Invalid file name" });
  if (fs.existsSync(target)) return res.status(409).json({ error: "Already exists" });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Empty upload" });
  try { fs.writeFileSync(target, req.body); res.json({ ok: true, name }); }
  catch (e) { res.status(500).json({ error: e.message }); }
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

app.post("/api/print", requireRegular, async (req, res) => {
  const { file, printer, start, map } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (p.maintenanceMode) return res.status(409).json({ error: p.name + " is in maintenance mode — take it off maintenance before printing." });
  const fp = safePath(file);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });

  // map is { logicalToolIndex: physicalHeadIndex }. Reject two tools → same head —
  // but only when actually starting a print. A plain upload just stages the file
  // on the printer; the mapping isn't acted on until print start, so a conflicting
  // (or mismatched-material) mapping shouldn't block getting the file there.
  // The conflict itself is real on every multi-color connector — a single-
  // toolhead-with-material-changer printer (AD5X's IFS) still can't have two
  // colors sharing one physical filament slot in the same print, same as two
  // colors can't share one independent toolhead on the U1 — only the WORDING
  // needs to differ, since "head" reads as "not possible on this printer at
  // all" to someone whose printer only has one physical nozzle.
  let tools = [];
  if (map && Object.keys(map).length) {
    tools = Object.keys(map).map(Number).sort((a, b) => a - b);
    const heads = tools.map(t => map[t]);
    if (start && new Set(heads).size !== heads.length) {
      const unit = (getConnector(p.connector).capabilities || {}).singleToolhead ? "slot" : "head";
      return res.status(400).json({ error: `Two colors are mapped to the same ${unit} — give each its own ${unit}.` });
    }
  }

  const c = getConnector(p.connector);
  const name = path.basename(fp);

  // Upload-only click (Upload button, not Print) while this printer is
  // actively busy: queue it instead of racing an upload against whatever's
  // already printing — the same pendingLoad/queuedFile mechanism the --load
  // CLI hook already uses, so it uploads automatically the moment this
  // printer goes idle and shows the same "ready to print" banner either way.
  if (!start && !(await isPrinterIdle(p))) {
    pendingLoad.set(printer, { file: fp, name, ts: Date.now(), tools, map });
    return res.json({ ok: true, mode: "pending", printer: p.name });
  }

  // Kick the work off in the background and hand the client a job id to poll.
  const jobId = newJobId();
  const job = { phase: "upload", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now() };
  JOBS.set(jobId, job);
  res.json({ jobId });

  (async () => {
    try {
      await c.uploadFile(p, fp, name, job);               // 1) upload (with progress)
      // 2) toolhead mapping + print-preference macros (connector-optional) —
      // still needed with no mapping chosen (tools=[]) when the printer has
      // its own preferences (e.g. auto-level) to send before print start.
      if (c.applyHeadMapping && (tools.length || p.autoLevel)) {
        job.phase = "mapping";
        await c.applyHeadMapping(p, tools, map);
      }
      if (start) { job.phase = "starting"; await c.startPrintFile(p, name); }
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
    res.json({ files: await getConnector(p.connector).listFiles(p) });
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
  const c = getConnector(p.connector);
  if (!c.getFileMetadata) return res.json({ palette: [], estimatedTime: null, isFS: false, fsFork: null });
  try {
    res.json(await c.getFileMetadata(p, file));
  } catch (e) {
    res.status(502).json({ error: "Could not reach " + p.name + ": " + e.message });
  }
});

app.post("/api/printfile", requireRegular, async (req, res) => {
  const { printer, filename, map } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (p.maintenanceMode) return res.status(409).json({ error: p.name + " is in maintenance mode — take it off maintenance before printing." });
  if (!filename || /["\r\n]/.test(filename)) return res.status(400).json({ error: "Bad filename" });

  // Same head-mapping macros as the upload flow (map = { paletteIdx: headIdx }).
  let tools = [];
  if (map && Object.keys(map).length) {
    tools = Object.keys(map).map(Number).sort((a, b) => a - b);
  }
  const c = getConnector(p.connector);
  try {
    // Still needed with no mapping chosen (tools=[]) when the printer has its
    // own preferences (e.g. auto-level) to send before print start.
    if (c.applyHeadMapping && (tools.length || p.autoLevel)) await c.applyHeadMapping(p, tools, map);
    await c.startPrintFile(p, filename);
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
  const c = getConnector(p.connector);
  const method = { pause: c.pause, resume: c.resume, cancel: c.cancel, eject: c.eject, estop: c.estop }[action];
  if (!method) return res.status(400).json({ error: "Bad action" });
  try {
    await method.call(c, p);
    res.json({ ok: true, action });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Exclude-object: live plate map + skip a single object mid-print ----
app.get("/api/plate", requireAuth, async (req, res) => {
  const p = PRINTERS[req.query.printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  const c = getConnector(p.connector);
  if (!c.getPlate) return res.json({ objects: [], current: null, excluded: [] });
  try {
    res.json(await c.getPlate(p));
  } catch (e) {
    res.status(502).json({ error: "Could not reach " + p.name + ": " + e.message });
  }
});

app.post("/api/exclude", requireRegular, async (req, res) => {
  const { printer, name } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!name || /["\r\n]/.test(name)) return res.status(400).json({ error: "Bad object name" });
  const c = getConnector(p.connector);
  if (!c.excludeObject) return res.status(400).json({ error: p.name + " does not support excluding objects" });
  try {
    await c.excludeObject(p, name);
    res.json({ ok: true, excluded: name });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Fleet: live per-head filament + status across all printers ----
// The actual protocol call (probe()) is delegated to the printer's connector
// (connectors/<type>.js) — this layer only handles the parts that are the
// same no matter what's behind the URL: offline retry caching and the
// maintenanceMode override.

// A printer that failed its last probe is served from this cache and only
// re-probed every OFFLINE_RETRY_MS — otherwise every unreachable printer costs
// a full fetch timeout on every fleet poll.
const OFFLINE_RETRY_MS = 10 * 1000;
const offlineCache = new Map();   // printer url -> { result, until }

// /api/fleet's client only re-renders a card when the raw JSON body differs
// from the last poll (see app.js's FLEET_PREV_BODY check) — cheap, but it
// means any value that wobbles by ±1 on its own, with no real state change,
// forces a full card rebuild every single poll, which is what shows up as
// visible flicker/jitter. Bed/hotend temps are the common offender: a
// connector already rounds them to whole degrees, but real sensor noise
// straddling a .5° boundary (e.g. reading 21.49 then 21.52) still flips the
// rounded integer back and forth forever. Require a new value to repeat on
// two consecutive polls before it's accepted, so a single noisy reading
// can't reach the client — a genuine temperature change still shows up,
// just one poll interval (a couple seconds) later.
const tempStableCache = new Map(); // "printerUrl:bed"|"printerUrl:hotend" -> { shown, pendingVal, pendingCount }
function stabilizeTemp(key, incoming) {
  if (!incoming) return incoming;
  let st = tempStableCache.get(key);
  if (!st) { st = { shown: incoming.temp, pendingVal: incoming.temp, pendingCount: 0 }; tempStableCache.set(key, st); }
  else if (incoming.temp === st.shown) {
    st.pendingVal = incoming.temp; st.pendingCount = 0;
  } else {
    if (incoming.temp === st.pendingVal) st.pendingCount++;
    else { st.pendingVal = incoming.temp; st.pendingCount = 1; }
    if (st.pendingCount >= 2) { st.shown = incoming.temp; st.pendingCount = 0; }
  }
  return { temp: st.shown, target: incoming.target };
}

async function probeCached(p) {
  const hit = offlineCache.get(p.url);
  let result;
  if (hit && Date.now() < hit.until) result = hit.result;
  else {
    result = await getConnector(p.connector).probe(p);
    if (result.online) offlineCache.delete(p.url);
    else offlineCache.set(p.url, { result, until: Date.now() + OFFLINE_RETRY_MS });
  }
  if (result.online) {
    result = { ...result, bed: stabilizeTemp(p.url + ":bed", result.bed), hotend: stabilizeTemp(p.url + ":hotend", result.hotend) };
  }
  // Checked fresh every call, independent of the reachability cache above —
  // maintenanceMode can flip without a new probe cycle needing to happen.
  return p.maintenanceMode ? { ...result, state: "maintenance" } : result;
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
  const c = getConnector(p.connector);
  queuedFile.set(idx, { name: pl.name, status: "uploading", ts: Date.now() });
  try {
    await c.uploadFile(p, pl.file, pl.name, { sent: 0, total: 0 });
    // Only ever set when this came from the Upload-button queue (not the
    // --load CLI hook, which has no color-mapping concept) — apply the same
    // head mapping an immediate upload would have gotten, now that the
    // printer that was busy is finally idle enough to receive it.
    if (c.applyHeadMapping && ((pl.tools && pl.tools.length) || p.autoLevel)) await c.applyHeadMapping(p, pl.tools || [], pl.map);
    queuedFile.set(idx, { name: pl.name, status: "ready", ts: Date.now() });
  } catch (e) {
    queuedFile.set(idx, { name: pl.name, status: "error", error: e.message, ts: Date.now() });
  } finally {
    // Remote --snapcon pushes materialize into NOTIFY_TMP_DIR (see
    // /api/notify-load) — that copy is only ever needed for this one upload.
    if (pl.cleanup) { try { fs.unlinkSync(pl.file); } catch {} }
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
    const conn = getConnector(p.connector);
    return res.json({ id: i, url: p.url, brand: p.brand || "SnapMaker", tags: p.tags || [], capabilities: conn.capabilities, colorPalette: conn.colorPalette, ...(await probeCached(p)) });
  }
  const out = await Promise.all(PRINTERS.map(async (p, i) => {
    const conn = getConnector(p.connector);
    const row = { id: i, url: p.url, brand: p.brand || "SnapMaker", tags: p.tags || [], capabilities: conn.capabilities, colorPalette: conn.colorPalette, ...(await probeCached(p)) };
    const qf = queuedFile.get(i);
    const pl = pendingLoad.get(i);
    // queuedFile (uploading/ready/error) reflects the retry sweep actually
    // acting on this printer; pendingLoad is the earlier "still waiting for
    // it to go idle" state — surface that too, as the same field with its
    // own status, or the client has no way to tell "already queued" from
    // "hasn't been queued yet" while the printer stays busy, and would just
    // keep re-showing the queue prompt on every poll.
    if (qf) row.queuedFile = qf;
    else if (pl) row.queuedFile = { name: pl.name, status: "queued", ts: pl.ts };
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

app.post("/api/notify-load", rawGcodeBody, async (req, res) => {
  // A remote --snapcon CLI call arrives as raw gcode bytes (application/octet-
  // stream) instead of a JSON {file} path reference, since it can't assume
  // this server can read a path off the CLI's own machine. It's gated the
  // same as an actual print request (requireRegular) rather than the
  // loopback-trust check below, since it's reachable from anywhere on the LAN.
  if (Buffer.isBuffer(req.body)) {
    if (!req.user) return res.status(401).json({ error: "Login required" });
    if (req.user.role !== "regular" && req.user.role !== "admin") return res.status(403).json({ error: "Insufficient permissions" });
    const printer = String(req.query.printer || "");
    const outputname = String(req.query.outputname || "").trim();
    const filename = String(req.query.filename || "");
    if (!printer) return res.status(400).json({ error: "printer required" });
    if (outputname && /["\r\n/\\]/.test(outputname)) return res.status(400).json({ error: "Bad output name" });
    const idx = findPrinterIndex(printer);
    if (idx === -1) return res.status(400).json({ error: "Unknown printer: " + printer });
    const p = PRINTERS[idx];
    const name = outputname || path.basename(filename || "upload.gcode");
    fs.mkdirSync(NOTIFY_TMP_DIR, { recursive: true });
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const tmpFile = path.join(NOTIFY_TMP_DIR, "push-" + Date.now() + "-" + Math.random().toString(16).slice(2) + "-" + safeName);
    fs.writeFileSync(tmpFile, req.body);

    if (!(await isPrinterIdle(p))) {
      pendingLoad.set(idx, { file: tmpFile, name, ts: Date.now(), cleanup: true });
      return res.json({ ok: true, mode: "pending", printer: p.name });
    }
    uploadNotifiedFile(idx, { file: tmpFile, name, cleanup: true });
    return res.json({ ok: true, mode: "queued", printer: p.name });
  }

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

// ---- Camera snapshot: delegated entirely to the connector — cooldown/idle-
// stop timer state (if any) lives inside it, not here. See
// connectors/snapmaker-u1-klipper.js's getCameraSnapshot for why: it's a
// quirk of Snapmaker's own camera plugin, not a generic "camera" concept.
async function getSnapshot(p) {
  const c = getConnector(p.connector);
  if (!c.getCameraSnapshot) throw new Error(p.name + " has no camera");
  return c.getCameraSnapshot(p);
}

// Server-side throttle for the fleet Camera View's automatic polling: that
// grid re-requests every printer's snapshot on every metadata poll tick
// (the fast, user-configured fleet refresh interval — deliberately NOT
// slowed down for this, so temps/progress/status keep updating promptly),
// independent of how often the actual camera frame should change. Without
// this, that would hit real camera hardware (RPC + wait on Snapmaker, a
// fresh MJPEG connection on FlashForge) far more often than intended.
// Cache TTL follows CFG.cameraViewRefreshInterval (Settings tab) — the knob
// the user actually sees controls real request frequency, regardless of how
// often the client happens to ask. ?fresh=1 (the single-printer snapshot
// modal's open/Refresh — an explicit user action) always bypasses this and
// re-primes the cache with the new frame.
const snapshotCache = new Map(); // printer index -> { ts, contentType, buffer }
const snapshotInflight = new Map(); // printer index -> in-flight Promise, so concurrent requests within one TTL window share one real fetch
async function getSnapshotThrottled(p, idx) {
  const ttlMs = (CFG.cameraViewRefreshInterval || 6) * 1000;
  const cached = snapshotCache.get(idx);
  if (cached && Date.now() - cached.ts < ttlMs) return cached;
  if (snapshotInflight.has(idx)) return snapshotInflight.get(idx);
  const pending = (async () => {
    try {
      const { contentType, buffer } = await getSnapshot(p);
      const entry = { ts: Date.now(), contentType, buffer };
      snapshotCache.set(idx, entry);
      return entry;
    } finally {
      snapshotInflight.delete(idx);
    }
  })();
  snapshotInflight.set(idx, pending);
  return pending;
}

app.get("/api/snapshot", requireAuth, async (req, res) => {
  const idx = parseInt(req.query.printer, 10);
  const p   = PRINTERS[idx];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  try {
    let contentType, buffer;
    if (req.query.fresh) {
      ({ contentType, buffer } = await getSnapshot(p));
      snapshotCache.set(idx, { ts: Date.now(), contentType, buffer });
    } else {
      ({ contentType, buffer } = await getSnapshotThrottled(p, idx));
    }
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "no-store");
    res.send(buffer);
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
  try {
    const { contentType, buffer } = await getConnector(p.connector).getThumbnail(p, file);
    res.set("Content-Type", contentType);
    // Effectively permanent: the client puts a per-job token in the URL, so a
    // new print job (even of a re-sliced same-name file) is a new cache entry —
    // one printer read per job, zero re-reads mid-print.
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    res.send(buffer);
  } catch (e) {
    res.status(e.status || 502).end();
  }
});

// ---- Unload filament from extruder(s) ----
app.post("/api/unload", requireRegular, async (req, res) => {
  const { printer, extruders } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!Array.isArray(extruders) || !extruders.length) return res.status(400).json({ error: "No extruders specified" });
  const c = getConnector(p.connector);
  if (!c.unloadFilament) return res.status(400).json({ error: p.name + " does not support filament unload" });
  try {
    await c.unloadFilament(p, extruders);
    res.json({ ok: true, printer: p.name, extruders });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Relabel a slot's stored color/material on the printer itself ----
app.post("/api/filament-color", requireRegular, async (req, res) => {
  const { printer, extruder, hex } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (typeof extruder !== "number" || extruder < 0) return res.status(400).json({ error: "Invalid extruder" });
  if (!/^#[0-9a-fA-F]{6}$/.test(String(hex || ""))) return res.status(400).json({ error: "Invalid color" });
  const c = getConnector(p.connector);
  if (!c.setFilamentColor) return res.status(400).json({ error: p.name + " does not support setting filament color" });
  try {
    // May differ from the requested hex (e.g. AD5X snaps to its touchscreen's
    // fixed color palette) — the client shows this back to the user rather
    // than assuming its own request was applied verbatim.
    const applied = await c.setFilamentColor(p, extruder, hex);
    res.json({ ok: true, printer: p.name, extruder, hex: applied || hex });
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
    await getConnector(p.connector).bedTemp(p, t);
    res.json({ ok: true, printer: p.name, target: Math.round(t) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Firmware inventory (same Moonraker APIs fluidd reads) ----
// Full firmware detail is only pulled from printers that aren't moving:
// standby / complete / cancelled. Busy or offline machines are listed as
// skipped with the reason. probeCached already has an up-to-date probe();
// no reason for the connector to probe a second time.
async function probeFirmware(p) {
  const c = getConnector(p.connector);
  if (!c.getFirmwareInfo) return { name: p.name, online: true, skipped: true, reason: "not supported" };
  const st = await probeCached(p);
  return c.getFirmwareInfo(p, st);
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
  const out = await Promise.all(PRINTERS.map((p, i) => {
    const c = getConnector(p.connector);
    return c.getInventory ? c.getInventory(p).then(r => ({ id: i, ...r })) : Promise.resolve({ id: i, name: p.name, online: null, skipped: true, reason: "not supported" });
  }));
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
const DEFAULT_MAINT_COMPONENTS = ["Linear Shaft / Linear Bearing", "X Carbon Rod Assembly", "Lead Screw / Nut", "Steel Pin / Steel Ball", "Timing Belt", "Pogo pin"];
const MAINT_FREQ_MONTHS = { monthly: 1, quarterly: 3, "6months": 6 };
// CFG.maintenanceComponents starts out undefined on any pre-existing config —
// this is the same "compute the default at read time, only persist once
// something actually changes" convention used elsewhere (e.g. refreshInterval).
const maintComponents = () => Array.isArray(CFG.maintenanceComponents) ? CFG.maintenanceComponents : DEFAULT_MAINT_COMPONENTS.slice();
function addMonths(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00");
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}
function computeWarranty(purchaseDate) {
  if (!purchaseDate) return false;
  const expiry = new Date(purchaseDate + "T00:00:00");
  expiry.setMonth(expiry.getMonth() + 12);
  return Date.now() <= expiry.getTime();
}
// "Next" due = soonest nextScheduled among each component's MOST RECENT entry
// — an older service record for the same part shouldn't out-rank a newer one.
function computeNextMaintenance(entries) {
  // entries is always in save/push order, so the last one seen per component
  // IS the most recent — comparing e.date alone would tie (and pick wrong)
  // whenever two entries for the same component are logged on the same day.
  const latestByComponent = new Map();
  for (const e of entries) {
    if (!e.component || !e.nextScheduled) continue;
    latestByComponent.set(e.component, e);
  }
  let best = null;
  for (const e of latestByComponent.values()) {
    if (!best || e.nextScheduled < best.nextScheduled) best = e;
  }
  return best ? { date: best.nextScheduled, component: best.component } : null;
}

app.get("/api/maintenance", requireAuth, (req, res) => {
  const idx = parseInt(req.query.printer, 10);
  const p = PRINTERS[idx];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  // Keyed by the printer's persistent id (CFG.maintenanceHistory), never
  // nested inside the printer's own config entry — so this survives the
  // printer being renamed, re-IP'd, or deleted (see ensurePrinterIds()).
  const entries = (CFG.maintenanceHistory && CFG.maintenanceHistory[p.id]) || [];
  // warranty/next are computed server-side and returned as plain values (not
  // the raw purchaseDate) so Regular/View roles — who never receive printers[]
  // from publicCfg() — can still see them without gaining printer-config access.
  res.json({ entries, components: maintComponents(), warranty: computeWarranty(p.purchaseDate), next: computeNextMaintenance(entries) });
});

app.post("/api/maintenance", requireRegular, (req, res) => {
  const { printer, entry } = req.body || {};
  const idx = parseInt(printer, 10);
  const p = PRINTERS[idx];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!entry || !entry.date) return res.status(400).json({ error: "Missing date" });
  if (!CFG.maintenanceHistory || typeof CFG.maintenanceHistory !== "object") CFG.maintenanceHistory = {};
  if (!Array.isArray(CFG.maintenanceHistory[p.id])) CFG.maintenanceHistory[p.id] = [];
  const entries = CFG.maintenanceHistory[p.id];
  const frequency = MAINT_FREQ_MONTHS[entry.frequency] ? entry.frequency : "monthly";
  const component = String(entry.component || "").trim();
  entries.push({
    date: String(entry.date),
    comment: String(entry.comment || ""),
    hours: String(entry.hours || "—"),
    totalSeconds: entry.totalSeconds != null ? Number(entry.totalSeconds) : null,
    component,
    frequency,
    nextScheduled: addMonths(entry.date, MAINT_FREQ_MONTHS[frequency]),
    cost: Number(entry.cost) || 0
  });
  if (component && !maintComponents().includes(component)) CFG.maintenanceComponents = [...maintComponents(), component];
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2));
    res.json({ ok: true, entries, components: maintComponents(), warranty: computeWarranty(p.purchaseDate), next: computeNextMaintenance(entries) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Separate from the log-entry save above — the Offline/Online button is its
// own action, not tied to logging a maintenance record.
app.post("/api/maintenance-mode", requireRegular, (req, res) => {
  const { printer, offline } = req.body || {};
  const p = PRINTERS[parseInt(printer, 10)];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  p.maintenanceMode = !!offline;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2));
    res.json({ ok: true, maintenanceMode: p.maintenanceMode });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Separate, dedicated endpoint rather than routing through /api/config's
// full printer-list rebuild below — that endpoint's whitelist has no tags
// field, and this way editing tags never risks touching any other printer
// field the Settings form itself doesn't know about.
app.post("/api/printer-tags", requireAdmin, (req, res) => {
  const { printer, tags } = req.body || {};
  const p = PRINTERS[parseInt(printer, 10)];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  p.tags = Array.isArray(tags)
    ? [...new Set(tags.map(t => String(t).trim()).filter(Boolean))].slice(0, 20).map(t => t.slice(0, 24))
    : [];
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2));
    res.json({ ok: true, tags: p.tags });
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
    cameraViewRefreshInterval: CFG.cameraViewRefreshInterval || 6,
    cameraViewStagger: CFG.cameraViewStagger !== false,
    alternateDisplay: CFG.alternateDisplay || "all",
    filamentCost: CFG.filamentCost || null,
    electricityRate: CFG.electricityRate || null,
    currency: CFG.currency || "$",
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
    isDocker: IS_DOCKER,
    // telegramBotToken never round-trips to the browser, same treatment as
    // the Resend API key below — a bot token is a real secret (anyone who
    // has it can send messages as your bot).
    notifications: CFG.notifications
      ? { ...CFG.notifications, telegramBotToken: undefined, hasTelegramBotToken: !!CFG.notifications.telegramBotToken }
      : null,
    printers: PRINTERS,
    // The Resend API key never round-trips to the browser, even for Admin —
    // unlike printer tokens (which do, into a masked <input>), this secret
    // gets the stricter treatment since leaking it is exactly what this
    // feature is partly meant to close off.
    resend: { fromAddress: (CFG.resend && CFG.resend.fromAddress) || "", hasApiKey: !!(CFG.resend && CFG.resend.apiKey) },
    otp: { service: (CFG.otp && CFG.otp.service) || "resend", ntfyTopic: (CFG.otp && CFG.otp.ntfyTopic) || "" }
  };
}
app.get("/api/config", requireAuth, (req, res) => res.json(publicCfg(req.user.role)));
app.get("/api/version", (req, res) => res.json({ version: VERSION }));

// Exits the process so Docker's `restart: unless-stopped` policy relaunches
// it fresh — picks up an externally-edited config.json or a `docker compose
// pull`'d image. Gated to Docker only (see IS_DOCKER above): with no
// supervisor to catch the exit, this would just kill the app for good.
app.post("/api/restart", requireAdmin, (req, res) => {
  if (!IS_DOCKER) return res.status(400).json({ error: "Not running in Docker — nothing would bring it back up" });
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 200);
});

// Predefined printer "Connector" types — how SnapCon talks to that printer.
// Registered in connectors/index.js; this is the single source of truth the
// client reads (GET /api/connectors) instead of a hardcoded <option> list.
app.get("/api/connectors", requireAuth, (req, res) => res.json(listConnectorTypes()));

// ---- Remote Access (Cloudflare Tunnel, managed) — Development Preview ----
// Every route here is requireAdmin (matches /api/config, /api/restart, /api/
// users) except the probe, which is deliberately unauthenticated — its only
// job is proving a request reached this instance through the tunnel, not
// testing the login system, and its response carries no information at all.
app.get("/api/remote-access/status", requireAdmin, (req, res) => res.json(remoteAccess.getStatus()));
app.post("/api/remote-access/enable", requireAdmin, (req, res) => {
  // Fast-fail synchronously on the security precondition — never even
  // attempt the network/child-process work if login protection isn't on.
  const security = remoteAccess.validateRemoteAccessSecurity();
  if (!security.allowed) return res.status(400).json({ ok: false, error: security.reason });
  // The rest (provisioning, download, process start) can take a while — the
  // client polls /api/remote-access/status rather than this request hanging.
  res.json({ ok: true, pending: true });
  remoteAccess.enable().catch(e => console.error("[remote-access] enable failed:", e.message));
});
app.post("/api/remote-access/disable", requireAdmin, (req, res) => {
  res.json({ ok: true, pending: true });
  remoteAccess.disable().catch(e => console.error("[remote-access] disable failed:", e.message));
});
app.post("/api/remote-access/remove", requireAdmin, (req, res) => {
  res.json({ ok: true, pending: true });
  remoteAccess.removeRemoteAccess().catch(e => console.error("[remote-access] remove failed:", e.message));
});
// No requireAuth: body/headers are fixed and carry zero identifying or
// operational information — see remote-access plan, "Public endpoint probe."
app.get("/api/remote-access/probe", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true });
});

app.post("/api/config", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (b.usersEnabled && !USERS.some(u => u.role === "admin")) {
    return res.status(400).json({ error: "Create an Admin user before enabling User Access Management" });
  }
  const next = {
    gcodeFolder: (typeof b.gcodeFolder === "string" && b.gcodeFolder.trim()) ? b.gcodeFolder.trim() : (CFG.gcodeFolder || "./gcode"),
    refreshInterval: (typeof b.refreshInterval === "number" && b.refreshInterval >= 1 && b.refreshInterval <= 60) ? b.refreshInterval : (CFG.refreshInterval || 2),
    cameraViewRefreshInterval: (typeof b.cameraViewRefreshInterval === "number" && b.cameraViewRefreshInterval >= 3 && b.cameraViewRefreshInterval <= 60) ? b.cameraViewRefreshInterval : (CFG.cameraViewRefreshInterval || 6),
    // Defaults ON like allowMapping/suggestMatching below — absence must
    // fall back to the previous stored value, not to false.
    cameraViewStagger: (typeof b.cameraViewStagger === "boolean") ? b.cameraViewStagger : (CFG.cameraViewStagger !== false),
    alternateDisplay: ["all","compact","camera","list"].includes(b.alternateDisplay) ? b.alternateDisplay : (CFG.alternateDisplay || "all"),
    filamentCost: (typeof b.filamentCost === "number" && b.filamentCost > 0) ? b.filamentCost : undefined,
    electricityRate: (typeof b.electricityRate === "number" && b.electricityRate > 0) ? b.electricityRate : undefined,
    currency: (typeof b.currency === "string" && b.currency.trim()) ? b.currency.trim().slice(0, 6) : "$",
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
    otp: (b.otp && typeof b.otp === "object") ? {
      service: b.otp.service === "ntfy" ? "ntfy" : "resend",
      ntfyTopic: String(b.otp.ntfyTopic || "").trim()
    } : (CFG.otp || undefined),
    notifications: (b.notifications && typeof b.notifications === "object") ? {
      enabled: !!b.notifications.enabled,
      onEvents: !!b.notifications.onEvents,
      onIntervals: !!b.notifications.onIntervals,
      includeImage: !!b.notifications.includeImage,
      service: b.notifications.service === "telegram" ? "telegram" : "ntfy",
      ntfyTopic: String(b.notifications.ntfyTopic || "").trim(),
      telegramChatId: String(b.notifications.telegramChatId || "").trim(),
      // Same "blank means keep the existing secret" convention as resend.apiKey.
      telegramBotToken: (typeof b.notifications.telegramBotToken === "string" && b.notifications.telegramBotToken.trim())
        ? b.notifications.telegramBotToken.trim()
        : ((CFG.notifications && CFG.notifications.telegramBotToken) || undefined)
    } : (CFG.notifications || undefined),
    port: PORT,
    // Internal bookkeeping, not part of this endpoint's editable settings —
    // carried forward untouched so a general settings save can never wipe
    // maintenance history/component list the way it silently did before
    // (this `next` object is a full rebuild, not a merge, so anything not
    // explicitly copied here is lost the moment this file is rewritten).
    maintenanceHistory: CFG.maintenanceHistory || undefined,
    maintenanceComponents: CFG.maintenanceComponents || undefined,
    printers: Array.isArray(b.printers)
      ? b.printers.filter(p => p && p.url).map(p => {
          const o = { name: String(p.name || p.url), url: String(p.url) };
          if (p.brand) o.brand = String(p.brand);
          if (p.location) o.location = String(p.location);
          if (p.costKwh) o.costKwh = String(p.costKwh);
          if (p.purchaseDate) o.purchaseDate = String(p.purchaseDate);
          if (p.autoLevel) o.autoLevel = true;
          if (p.pushNotify) o.pushNotify = true;
          o.connector = CONNECTOR_TYPES.includes(p.connector) ? p.connector : DEFAULT_CONNECTOR_TYPE;
          if (p.serial) o.serial = String(p.serial);
          // Was capped at 4 chars (Snapmaker's pairing code length) — widened
          // for FlashForge's checkCode, documented as 4-5 digits.
          if (p.verificationCode) o.verificationCode = String(p.verificationCode).slice(0, 8);
          if (p.token) o.token = String(p.token);
          // Persistent identity, independent of name/url — matched by id
          // first (round-tripped from the client) so renaming or re-IP'ing a
          // printer doesn't detach it from its own maintenance history
          // (CFG.maintenanceHistory, keyed by id, never nested in here).
          // Falls back to a url match for pre-upgrade clients that haven't
          // got an id yet, then mints a fresh one for a genuinely new printer.
          const existing = (p.id && PRINTERS.find(ep => ep.id === p.id)) || PRINTERS.find(ep => ep.url === o.url);
          o.id = (existing && existing.id) || newPrinterId();
          // Tags are only ever written via POST /api/printer-tags, never
          // through this form-driven rebuild (the Settings printer-editing
          // table has no tags field at all) — carry them forward from the
          // matched existing printer the same way o.id is, or saving any
          // general setting would silently wipe every printer's tags.
          if (existing && Array.isArray(existing.tags) && existing.tags.length) o.tags = existing.tags;
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
  const otpService = (CFG.otp && CFG.otp.service) || "resend";
  if (otpService === "ntfy") {
    if (!CFG.otp || !CFG.otp.ntfyTopic) return res.status(500).json({ error: "OTP is not configured" });
  } else if (!CFG.resend || !CFG.resend.apiKey || !CFG.resend.fromAddress) {
    return res.status(500).json({ error: "OTP is not configured" });
  }
  const u = findUserByLoginName((req.body || {}).loginName);
  // ntfy delivers to a shared topic, not a per-user address, so email isn't
  // required for that path — it still is for Resend, which needs somewhere
  // to send the message.
  if (!u || !u.otpEnabled || (otpService !== "ntfy" && !u.email)) return res.status(400).json({ error: "Could not send a code for that login name" });
  const code = auth.setOtpCode(u.loginNameLower);
  try {
    if (otpService === "ntfy") {
      await sendNtfy({ topic: CFG.otp.ntfyTopic, title: "SnapCon login code", message: "Code for " + u.loginName + ": " + code + " (expires in 10 min)" });
    } else {
      await sendResendEmail({
        apiKey: CFG.resend.apiKey, fromAddress: CFG.resend.fromAddress, to: u.email,
        subject: "Your SnapCon login code",
        text: "Your SnapCon login code is: " + code + "\n\nThis code expires in 10 minutes."
      });
    }
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
  // A password already on file stays on file when OTP is turned on — it's just
  // unusable while otpEnabled blocks password login (see /api/login above) —
  // so switching OTP back off later doesn't force re-entering a password.
  if (!nextOtpEnabled && newPasswordHash) u.passwordHash = newPasswordHash;
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
// Tests whichever OTP provider is currently selected in the (possibly
// unsaved) form — same "test the live values" convention as /api/notify-test.
app.post("/api/otp-test", requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (b.service === "ntfy") {
    const topic = (typeof b.ntfyTopic === "string" && b.ntfyTopic.trim()) ? b.ntfyTopic.trim() : ((CFG.otp && CFG.otp.ntfyTopic) || "");
    if (!topic) return res.status(400).json({ error: "Enter a topic first" });
    try {
      await sendNtfy({ topic, title: "SnapCon OTP test", message: "This is a test OTP notification from SnapCon." });
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
    return;
  }
  const apiKey = (typeof b.apiKey === "string" && b.apiKey.trim()) ? b.apiKey.trim() : ((CFG.resend && CFG.resend.apiKey) || "");
  const fromAddress = String(b.fromAddress || (CFG.resend && CFG.resend.fromAddress) || "").trim();
  const to = String(b.to || "").trim();
  if (!apiKey) return res.status(400).json({ error: "Enter a Resend API key first" });
  if (!fromAddress) return res.status(400).json({ error: "Enter a from-address first" });
  if (!to) return res.status(400).json({ error: "Enter a test recipient address" });
  try {
    await sendResendEmail({ apiKey, fromAddress, to, subject: "SnapCon OTP test", text: "This is a test OTP email from SnapCon." });
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
  // image = { contentType, buffer } from a connector's getCameraSnapshot —
  // not every connector's camera returns a JPEG (FlashForge's is BMP), so
  // the filename/content-type ride along with the snapshot itself.
  const ext = image && image.contentType === "image/bmp" ? "snapshot.bmp" : "snapshot.jpg";
  const opts = image
    ? { method: "PUT", headers: { "Filename": ext, "Content-Type": image.contentType || "image/jpeg" }, body: image.buffer }
    : { method: "POST" };
  const r = await fetchTimeout(url, 15000, opts);
  if (!r.ok) throw new Error("ntfy.sh " + r.status + ": " + (await r.text()).slice(0, 160));
}

// Send via a Telegram bot (api.telegram.org) — sendPhoto (with the message as
// its caption) when a snapshot is available, sendMessage otherwise. Node's
// built-in fetch/FormData/Blob handle the multipart photo upload with no new
// dependency, same "no SDK needed" approach as sendNtfy/sendResendEmail.
async function sendTelegram({ botToken, chatId, message, image }) {
  if (!botToken) throw new Error("Telegram bot token is not configured");
  if (!chatId) throw new Error("Telegram chat ID is not configured");
  const base = "https://api.telegram.org/bot" + botToken;
  let r;
  if (image) {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", message);
    form.append("photo", new Blob([image.buffer], { type: image.contentType || "image/jpeg" }), "snapshot.jpg");
    r = await fetchTimeout(base + "/sendPhoto", 15000, { method: "POST", body: form });
  } else {
    r = await fetchTimeout(base + "/sendMessage", 15000, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
  }
  if (!r.ok) throw new Error("Telegram " + r.status + ": " + (await r.text()).slice(0, 160));
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
    try { image = await getSnapshot(p); }
    catch { /* no camera — send the text anyway */ }
  }
  if (nf.service === "telegram") {
    // Telegram has no separate "title" field the way ntfy does — fold the
    // printer name into the message text instead.
    await sendTelegram({ botToken: nf.telegramBotToken, chatId: nf.telegramChatId, message: p.name + ": " + message, image });
  } else {
    await sendNtfy({
      topic: nf.ntfyTopic, title: p.name, message, image,
      iconUrl: "http://" + lanAddr() + "/snapcon-icon-512.png"
    });
  }
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
  if (!nf.enabled) return;
  if (nf.service === "telegram" ? (!nf.telegramChatId || !nf.telegramBotToken) : !nf.ntfyTopic) return;
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
  const nf = CFG.notifications || {};
  const service = b.service === "telegram" ? "telegram" : "ntfy";
  if (!PRINTERS.length) return res.status(400).json({ error: "Add a printer first" });
  const p = PRINTERS[0]; // any configured printer works for a connectivity test

  try {
    const st = await getConnector(p.connector).probe(p);
    if (!st.online) return res.status(502).json({ error: p.name + " is offline: " + (st.error || "") });
    const ev = st.state || "idle"; // test uses the live state as the event
    let message = eventMessage(ev, st);
    let image = null;
    if (b.includeImage !== false) {
      try { image = await getSnapshot(p); }
      catch (e) { message += "\n(camera unavailable: " + e.message + ")"; }
    }
    if (service === "telegram") {
      const chatId = String(b.chatId || nf.telegramChatId || "").trim();
      // Same "test with the form's current value, fall back to what's saved"
      // convention as the OTP/Resend test buttons — works before Save too.
      const botToken = (typeof b.botToken === "string" && b.botToken.trim()) ? b.botToken.trim() : (nf.telegramBotToken || "");
      if (!chatId) return res.status(400).json({ error: "Enter a Telegram chat ID first" });
      if (!botToken) return res.status(400).json({ error: "Enter a Telegram bot token first" });
      await sendTelegram({ botToken, chatId, message: p.name + ": " + message, image });
      return res.json({ ok: true, service, printer: p.name });
    }
    const topic = String(b.topic || nf.ntfyTopic || "").trim();
    if (!/^[-_A-Za-z0-9]{1,64}$/.test(topic)) return res.status(400).json({ error: "Enter a valid ntfy topic first" });
    await sendNtfy({
      topic, title: p.name, message, image,
      iconUrl: "http://" + lanHost(req) + "/snapcon-icon-512.png"
    });
    res.json({ ok: true, service, topic, printer: p.name });
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
// IPv4 <-> integer, via multiplication rather than bit-shifts — shifting an
// octet into bit 24-31 overflows into JS's signed 32-bit bitwise range and
// flips negative for anything with a high first octet (>=128).
function ipToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || "").trim());
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some(o => o < 0 || o > 255)) return null;
  return parts[0] * 16777216 + parts[1] * 65536 + parts[2] * 256 + parts[3];
}
function intToIp(n) {
  return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join(".");
}
// A dotted mask (255.255.255.128) is only valid if it's a contiguous run of
// 1-bits followed by 0-bits — reject anything else (e.g. 255.0.255.0) rather
// than silently misinterpreting it.
function maskToPrefixLen(mask) {
  const n = ipToInt(mask);
  if (n === null) return null;
  let ones = 0, seenZero = false;
  for (let i = 31; i >= 0; i--) {
    if ((n >>> i) & 1) { if (seenZero) return null; ones++; }
    else seenZero = true;
  }
  return ones;
}
const MIN_SCAN_PREFIX = 20; // /20 = 4096 addresses — below this a typo could kick off a scan that takes forever
// Accepts either the legacy bare "x.x.x.0" (whole /24, unchanged behavior)
// or CIDR notation with a prefix length ("192.168.22.128/25") or a dotted
// mask ("192.168.22.128/255.255.255.128") — the IP need not be block-aligned,
// the network is derived by zeroing the host bits either way. Returns the
// FULL address block inclusive of what strict subnetting would call the
// network/broadcast addresses (e.g. .0/25 scans .0-.127, not .1-.126) —
// deliberate: this is a printer-discovery sweep, not a routing table, and a
// printer can legitimately sit at either boundary address.
function parseSubnetSpec(spec) {
  spec = String(spec || "").trim();
  const slash = spec.indexOf("/");
  if (slash === -1) {
    const parts = spec.split(".");
    if (parts.length !== 4 || parts.some(p => isNaN(p) || +p < 0 || +p > 255)) {
      return { error: "Invalid subnet. Expected x.x.x.0, or CIDR like 192.168.1.0/24" };
    }
    const base = parts.slice(0, 3).join(".");
    return { ips: Array.from({ length: 254 }, (_, i) => base + "." + (i + 1)), label: base + ".0/24" };
  }
  const ipInt = ipToInt(spec.slice(0, slash));
  if (ipInt === null) return { error: "Invalid IP address before the /" };
  const suffix = spec.slice(slash + 1).trim();
  const prefixLen = /^\d{1,2}$/.test(suffix) ? parseInt(suffix, 10) : maskToPrefixLen(suffix);
  if (prefixLen === null || prefixLen < 0 || prefixLen > 32) return { error: "Invalid prefix length or subnet mask after the /" };
  if (prefixLen < MIN_SCAN_PREFIX) return { error: "Subnet too large to scan — use /" + MIN_SCAN_PREFIX + " or smaller (max " + Math.pow(2, 32 - MIN_SCAN_PREFIX) + " addresses)" };
  const blockSize = Math.pow(2, 32 - prefixLen);
  const networkInt = Math.floor(ipInt / blockSize) * blockSize;
  const ips = [];
  for (let n = networkInt; n <= networkInt + blockSize - 1; n++) ips.push(intToIp(n));
  return { ips, label: intToIp(networkInt) + "/" + prefixLen };
}
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
// Tries every connector that supports discovery (discoverAt is optional —
// most future brands won't fingerprint this way at all) against one base
// URL, so adding a connector automatically joins the scan with no changes
// here.
async function discoverAt(base) {
  for (const { type } of listConnectorTypes()) {
    const c = getConnector(type);
    if (!c.discoverAt) continue;
    try {
      const hit = await c.discoverAt(base);
      if (hit) return { ...hit, connector: type };
    } catch { /* try the next connector */ }
  }
  return null;
}
async function discoverIp(ip) {
  for (const port of DISCOVER_PORTS) {
    const base = port === 80 ? `http://${ip}` : `http://${ip}:${port}`;
    try {
      const hit = await discoverAt(base);
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
  let ips, labels;
  if (req.query.subnet) {
    const spec = parseSubnetSpec(req.query.subnet);
    if (spec.error) return res.status(400).json({ error: spec.error });
    ips = spec.ips;
    labels = [spec.label];
  } else {
    const bases = localSubnets();
    ips = bases.flatMap(base => Array.from({ length: 254 }, (_, i) => base + "." + (i + 1)));
    labels = bases.map(b => b + ".0/24");
  }
  const B = 40;
  for (let i = 0; i < ips.length; i += B) {
    const results = await Promise.all(ips.slice(i, i + B).map(discoverIp));
    results.forEach(r => { if (r) found.push(r); });
  }
  res.json({ subnets: labels, found });
});

const httpServer = app.listen(PORT, () => {
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
  // Remote Access reconnects (if it was previously enabled) only AFTER the
  // server is actually accepting requests — startupInit() may spawn a
  // process and probe this server's own /api/remote-access/probe endpoint,
  // neither of which can happen correctly before app.listen's callback fires.
  remoteAccess.startupInit().catch(e => console.error("[remote-access] startupInit failed:", e.message));
});

// Graceful shutdown — new to this codebase (previously nothing here handled
// SIGINT/SIGTERM at all; Ctrl+C or a service manager's stop signal just hard-
// killed the process). Guarded against repeated signals so a second Ctrl+C
// during shutdown doesn't re-enter this and double-run the sequence.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n  Received " + signal + " — shutting down...");
  httpServer.close(); // stop accepting new connections; lets in-flight ones finish

  // Independent, unconditional deadline — scheduled up front, not nested
  // inside the graceful path's .finally(). A .finally() only ever runs once
  // the promise it's attached to actually settles, so if disableForShutdown()
  // (or anything several layers beneath it — a subprocess spawn with no
  // timeout of its own, say) ever hung, the "bounded" exit would silently
  // stop being bounded at all. This timer fires no matter what.
  const forceExitTimer = setTimeout(() => process.exit(0), 8000);
  if (forceExitTimer.unref) forceExitTimer.unref();

  Promise.resolve(remoteAccess.disableForShutdown()) // stop cloudflared only — token/config are retained so the next boot reconnects
    .catch(e => console.error("[remote-access] shutdown:", e.message))
    .finally(() => { clearTimeout(forceExitTimer); process.exit(0); });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
