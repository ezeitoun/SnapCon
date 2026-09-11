// server.js — SnapCon  ·  v0.7.0
// Watches a folder of sliced gcode, shows the toolhead/color map per file,
// and pushes the chosen file to the chosen printer via Moonraker (server-side,
// so no browser CORS headaches).

const VERSION = "0.7.0";

const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const readline = require("readline");
const { parseGcodeMap, parseGcodeMapLines } = require("./parser");
const auth = require("./auth");
const { getConnector, listConnectorTypes, getCapabilities, getAddress, CONNECTOR_TYPES, DEFAULT_TYPE: DEFAULT_CONNECTOR_TYPE } = require("./connectors");
const { isValidHost, normalizePort, parseAddressUrl, composeAddressUrl } = require("./connectors/address");
const connHttp = require("./connectors/http-utils");
// Firmware flashing lives outside the connector interface on purpose (see
// that module's header) — it is required directly, by the one route that
// drives it, and only ever for printers whose connector advertises
// firmwareDeploy.
const u1Firmware = require("./connectors/snapmaker-u1-firmware");
const firmwareImage = require("./connectors/firmwareImage");
// Connectors that only watch their printers (capabilities.control === false,
// Bambu Lab today) — see refuseMonitorOnly() below for where it is enforced.
const { isMonitorOnly, monitorOnlyMessage, MONITOR_ONLY_CODE } = require("./connectors/monitorOnly");
const { createRemoteAccessService } = require("./remote-access/RemoteAccessService");
const { createAuditLog } = require("./audit/AuditLog");
const { createSyncEngine } = require("./sync/SyncEngine");
const { loadConfigFile } = require("./configLoader");
const locales = require("./locales");
const { readNotifyToken, ensureNotifyToken, timingSafeTokenEqual } = require("./notifyToken");
const { isPathWithinFolder, resolveWithinFolder } = require("./pathSafety");
const { sendWebhook, redactUrls } = require("./webhookNotify");

// Defense in depth, not a substitute for fixing the actual bug: an unhandled
// promise rejection anywhere (a bare setTimeout callback with no .catch(), a
// fire-and-forget async call) crashes the entire process by Node's default
// behavior — every printer, every connected user — over what might be a
// single isolated feature's failure. Log it instead of letting the process
// die silently-to-the-user; this is what actually caught H-2 (a corrupted
// Remote Access identity key crashing the whole server) having no visible
// trace anywhere before it was fixed at the source in RemoteAccessService.js.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && reason.stack || reason);
});

// When packaged as a single executable (pkg), __dirname points inside the
// read-only bundle. User-editable files (config.json, the gcode folder) must
// live NEXT TO THE EXE instead. Bundled assets (public/, parser.js) stay on
// __dirname, which pkg maps into the snapshot.
const IS_PKG = typeof process.pkg !== "undefined";
// SNAPCON_DATA_DIR (optional) moves every writable file — config.json,
// users.json, locales/, the *-data folders and, by default, gcode/ — into one
// directory. The Home Assistant add-on points it at its persistent /data, and
// a Docker setup can use it to keep all state in a single volume. Unset, the
// layout is exactly as before (next to server.js / the executable).
const BASE_DIR = process.env.SNAPCON_DATA_DIR
  ? path.resolve(process.env.SNAPCON_DATA_DIR)
  : (IS_PKG ? path.dirname(process.execPath) : __dirname);
if (process.env.SNAPCON_DATA_DIR) { try { fs.mkdirSync(BASE_DIR, { recursive: true }); } catch {} }
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
const QUEUED_FILE_PATH = path.join(BASE_DIR, "queued-files.json");
const NOTIFY_TOKEN_PATH = path.join(BASE_DIR, "notify-token.json");
const DEFAULT_CFG = { gcodeFolder: "./gcode", port: 4545, printers: [] };
// Runtime, writable, per-install (BASE_DIR) — never the bundled read-only
// tree. LOCALES_DEFAULT_DIR ships the canonical originals and is only ever
// read from, to seed LOCALES_DIR on first run (see locales.seedDefaultLocales).
const LOCALES_DIR = path.join(BASE_DIR, "locales");
const LOCALES_DEFAULT_DIR = path.join(ASSET_DIR, "locales-default");
let LOCALE_REGISTRY = { locales: {}, errors: [] };
function refreshLocaleRegistry() { LOCALE_REGISTRY = locales.scanLocales(LOCALES_DIR); }

// Live config — editable from the Settings page, no restart needed.
let CFG, FOLDER, PRINTERS;
// Set fresh on every loadConfig() call (including the reload after a
// successful POST /api/config save, which naturally clears these again by
// loading the just-written, definitely-valid file) — see P0-1 in
// CODE_AUDIT.md: a corrupt config.json used to be silently discarded and
// then permanently overwritten with near-empty defaults by the ensure*Schema
// migrations just below. These gate that overwrite and surface the failure
// to an admin via publicCfg() (Settings > General shows a warning banner).
let CONFIG_LOAD_FAILED = false;
let CONFIG_LOAD_QUARANTINE_PATH = null;
function loadConfig() {
  const result = loadConfigFile(CONFIG_PATH, DEFAULT_CFG);
  CFG = result.cfg;
  CONFIG_LOAD_FAILED = result.loadFailed;
  CONFIG_LOAD_QUARANTINE_PATH = result.quarantinePath;
  FOLDER = path.resolve(BASE_DIR, CFG.gcodeFolder || "./gcode");
  PRINTERS = Array.isArray(CFG.printers) ? CFG.printers : [];
  try { fs.mkdirSync(FOLDER, { recursive: true }); } catch {}
  // Logs/Camera Folder are opt-in (no default, unlike gcodeFolder) — only
  // create them once the user has actually pointed at a path. Best-effort:
  // a bad path here shouldn't block the rest of config from loading, same
  // as the gcodeFolder mkdir above.
  if (CFG.logsFolder) { try { fs.mkdirSync(path.resolve(BASE_DIR, CFG.logsFolder), { recursive: true }); } catch {} }
  if (CFG.cameraFolder) { try { fs.mkdirSync(path.resolve(BASE_DIR, CFG.cameraFolder), { recursive: true }); } catch {} }
  if (CFG.gcodeSyncFolder) { try { fs.mkdirSync(path.resolve(BASE_DIR, CFG.gcodeSyncFolder), { recursive: true }); } catch {} }
}
loadConfig();
const PORT = CFG.port || 4545;
// Seed-once, never-overwrite for every locale except English (see
// locales.seedDefaultLocales), then English's own version-gated sync (see
// locales.syncCanonicalEnglish — safe specifically because the Language
// Editor never lets anyone write en.json), then an initial scan — same
// "load at startup, Refresh re-scans" lifecycle as every other cached
// registry in this file.
try { locales.seedDefaultLocales(LOCALES_DIR, LOCALES_DEFAULT_DIR); } catch (e) { console.error("[locales] seeding failed:", e.message); }
try { locales.syncCanonicalEnglish(LOCALES_DIR, LOCALES_DEFAULT_DIR); } catch (e) { console.error("[locales] English sync failed:", e.message); }
refreshLocaleRegistry();

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
  if (changed && !CONFIG_LOAD_FAILED) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch {} }
}
ensurePrinterIds();

// One-time migration for a config.json predating per-event, per-milestone,
// and per-provider notification settings: derives the new fields from the
// old bundled ones (onEvents → all four event flags, service → exactly one
// provider enabled) so an existing setup keeps behaving identically until
// the user actually opens Settings > Notifications and changes something.
function ensureNotificationSchema() {
  const nf = CFG.notifications;
  if (!nf || typeof nf !== "object") return;
  let changed = false;
  if (nf.onStart === undefined && nf.onPause === undefined && nf.onError === undefined && nf.onComplete === undefined) {
    const on = !!nf.onEvents;
    nf.onStart = on; nf.onPause = on; nf.onError = on; nf.onComplete = on;
    changed = true;
  }
  if (!Array.isArray(nf.milestonePercents)) { nf.milestonePercents = [25, 50, 75]; changed = true; }
  if (nf.ntfyEnabled === undefined && nf.telegramEnabled === undefined) {
    nf.ntfyEnabled = nf.service !== "telegram";
    nf.telegramEnabled = nf.service === "telegram";
    changed = true;
  }
  if (changed && !CONFIG_LOAD_FAILED) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch {} }
}
ensureNotificationSchema();

// One-time migration: the old openCompact boolean (just compact-or-not) is
// superseded by defaultView (a full view-mode choice, including Print Farm)
// — preserves whatever behavior an existing install already had, then the
// old field just goes unused (never deleted, harmless leftover, same "don't
// bother stripping it" posture as other superseded fields in this file).
function ensureDefaultViewSchema() {
  if (CFG.defaultView === undefined) {
    CFG.defaultView = CFG.openCompact ? "compact" : "regular";
    if (!CONFIG_LOAD_FAILED) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch {} }
  }
}
ensureDefaultViewSchema();

// One-time migration guaranteeing CFG.groups always exists and always
// contains the permanent, protected "Everyone" group. A user or printer with
// no explicit group assignment falls back to this id at READ time only (see
// printerVisibleTo() in groupAccess.js) — never force-written onto that
// user/printer — but the group itself must exist unconditionally from
// process start, the same guarantee ensurePrinterIds() gives every printer's
// own id.
const { GROUP_EVERYONE_ID, printerVisibleTo, removeGroupReferences } = require("./groupAccess");
const newGroupId = () => "grp_" + crypto.randomBytes(6).toString("hex");
// One-time migration from the pre-rename "Printer Profile" config schema to
// "Printer Pool" (see queue/migratePrinterPool.js for the pure logic) — runs
// unconditionally at every startup like the other ensure*Schema migrations
// above, and persists immediately if anything actually changed so an
// existing install only ever pays this cost once. Existing pool/printer ids
// are preserved verbatim by the migration — only field/key names move.
const { migratePrinterPoolConfig } = require("./queue/migratePrinterPool");
(function migratePrinterPoolOnStartup() {
  const { cfg, changed } = migratePrinterPoolConfig(CFG);
  CFG = cfg;
  PRINTERS = Array.isArray(CFG.printers) ? CFG.printers : [];
  if (changed && !CONFIG_LOAD_FAILED) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch {} }
})();
// Retires the original U1 connector in favor of the WebSocket one (see
// connectors/migrateU1Connector.js for the pure logic and why the swap is
// safe to apply without asking). Same unconditional-every-startup shape as
// the migration above: a no-op once no printer names the old connector.
// Deliberately runs before anything is served, so no route, no probe and no
// Settings row ever sees a printer on a connector that is no longer in the
// REGISTRY. Even if the write below fails, CFG in memory is already migrated.
const { migrateU1ConnectorConfig } = require("./connectors/migrateU1Connector");
(function migrateU1ConnectorOnStartup() {
  const { cfg, changed } = migrateU1ConnectorConfig(CFG);
  CFG = cfg;
  PRINTERS = Array.isArray(CFG.printers) ? CFG.printers : [];
  if (changed && !CONFIG_LOAD_FAILED) {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch {}
    console.log("[config] migrated printers from the retired snapmaker-u1-klipper connector to snapmaker-u1-klipper-ws");
  }
})();
// Splits each printer's stored `url` into the IP/hostname and port the
// user now configures directly (see connectors/migratePrinterAddress.js).
// `url` remains the canonical value every connector reads, so this changes
// nothing about how a printer is reached — recomposing from the parts
// yields the same string. Runs after the connector migration above
// because the address contract (default port, whether a port is even
// configurable) comes from the connector a printer ends up on.
const { migratePrinterAddressConfig } = require("./connectors/migratePrinterAddress");
(function migratePrinterAddressOnStartup() {
  const { cfg, changed, issues } = migratePrinterAddressConfig(CFG);
  CFG = cfg;
  PRINTERS = Array.isArray(CFG.printers) ? CFG.printers : [];
  // Reported, never rewritten: a URL this migration can't take apart
  // keeps working exactly as it did, and the admin can fix the address in
  // Settings when they choose to.
  for (const i of issues) console.warn("[config] printer " + JSON.stringify(i.name) + ": could not split " + JSON.stringify(i.url) + " into an address and port — left unchanged");
  if (changed && !CONFIG_LOAD_FAILED) {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch {}
    console.log("[config] migrated printer addresses to separate IP/hostname and port fields");
  }
})();
function ensureGroupsSchema() {
  if (!Array.isArray(CFG.groups)) CFG.groups = [];
  let changed = false;
  if (!CFG.groups.some(g => g.id === GROUP_EVERYONE_ID)) {
    const now = new Date().toISOString();
    CFG.groups.unshift({ id: GROUP_EVERYONE_ID, name: "Everyone", createdAt: now, updatedAt: now });
    changed = true;
  }
  if (changed && !CONFIG_LOAD_FAILED) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch {} }
}
ensureGroupsSchema();

// Queue Management (Phase 1: per-printer manual queues only — no automated
// G-code/API bed-clear yet). Re-runs unconditionally on every startup, not
// as a true one-shot migration, since it also has to cover a printer added
// later while the feature was already on, not just an old config.json
// predating the feature entirely.
const QueueEngine = require("./queue/QueueEngine");
const { createQueueStore, defaultPrinterState: defaultQueuePrinterState } = require("./queue/QueueStore");
const newPrinterPoolId = () => "pp_" + crypto.randomBytes(6).toString("hex");
// Id kept as its original literal value across the Printer Pool rename —
// see queue/migratePrinterPool.js: existing pool ids are preserved verbatim,
// only field/key names ("queueProfiles"/"printerPoolId") were renamed.
const PRINTER_POOL_DEFAULT_MANUAL_ID = "qp_default_manual";
function ensurePrinterPoolSchema() {
  if (!CFG.queueManagement || typeof CFG.queueManagement !== "object") CFG.queueManagement = { enabled: false, mode: "per-printer" };
  if (!Array.isArray(CFG.printerPools)) CFG.printerPools = [];
  let changed = false;
  if (CFG.queueManagement.enabled && !CFG.printerPools.some(p => p.id === PRINTER_POOL_DEFAULT_MANUAL_ID)) {
    const now = new Date().toISOString();
    CFG.printerPools.unshift({ id: PRINTER_POOL_DEFAULT_MANUAL_ID, name: "Unassigned", type: "manual", isDefault: true, bedClearOnDispatchFailure: false, createdAt: now, updatedAt: now });
    changed = true;
  }
  if (changed && !CONFIG_LOAD_FAILED) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch {} }
}
ensurePrinterPoolSchema();
const queueStore = createQueueStore({ baseDir: BASE_DIR });
queueStore.load();

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

  // Reads (never generates) the local notify token the running server
  // already established at its own startup — see notifyToken.js's header
  // comment for why the CLI must never be the one to create this value.
  const notifyToken = readNotifyToken(NOTIFY_TOKEN_PATH);
  if (!notifyToken) {
    console.error("SnapCon: no local notify token found at " + NOTIFY_TOKEN_PATH + " — is SnapCon running (has it started at least once)? If it logged a token-persistence failure, this feature is unavailable until that's fixed.");
    process.exit(1);
  }
  const body = JSON.stringify({ file: path.resolve(file), printer, outputname });
  const req = http.request({
    hostname: "127.0.0.1", port: PORT, path: "/api/notify-load", method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-SnapCon-Local-Token": notifyToken }
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

// Established once here, at genuine server startup (never in CLI mode,
// which returns above before reaching this line) — the ONE writer for this
// value; see notifyToken.js's header comment. null means persistence
// failed; /api/notify-load's file-path branch below must fail closed in
// that case rather than fall back to trusting isLoopback() alone.
const NOTIFY_TOKEN = ensureNotifyToken(NOTIFY_TOKEN_PATH);

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

// Audit log — the only module the routes below talk to for it. Degrades to a
// silent no-op on a Node runtime too old for node:sqlite (see AuditLog.js);
// never blocks or crashes any request either way.
const auditLog = createAuditLog({ baseDir: BASE_DIR, retentionDaysFn: () => CFG.auditRetentionDays });
setInterval(() => auditLog.prune(CFG.auditRetentionDays), 24 * 60 * 60 * 1000).unref();
auditLog.prune(CFG.auditRetentionDays);

// Logs/Camera sync — the only module the routes below talk to for it. Same
// "one entry point" shape as remoteAccess/auditLog above.
const syncEngine = createSyncEngine({ baseDir: BASE_DIR, getConnector });

// Never attributes an action to the implicit admin (usersEnabled:false) —
// there's no real account behind it, just the historical "everyone's an
// admin" back-compat behavior. A route firing while usersEnabled is off logs
// userId:null/userLabel:null, same shape as a print started from a printer's
// own screen.
function actorFromReq(req) {
  const u = req && req.user;
  if (!u || u.implicit) return { userId: null, userLabel: null };
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return { userId: u.id, userLabel: name || u.loginName };
}

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
// /health or /health/<printer id> — same page; the client reads the path on
// load and via pushState as the printer picker changes (the Health page's
// own router, not a general SPA catch-all — every other path still 404s).
app.get(/^\/health(\/.*)?$/i, (req, res) => {
  try { res.type("html").send(fs.readFileSync(path.join(ASSET_DIR, "public", "index.html"), "utf8")); }
  catch (e) { res.status(500).send("index.html not found"); }
});

// fetchTimeout/fetchJSONTimeout/baseUrl/pickIface are generic HTTP helpers
// (not printer-protocol-specific) shared with connectors/ — see
// connectors/http-utils.js. Everything printer-protocol-specific now lives
// behind getConnector(p.connector), never called directly from here.
const { fetchTimeout, fetchJSONTimeout, baseUrl } = connHttp;

// Resolve a requested path safely INSIDE the watched folder (no traversal).
// See pathSafety.js for the actual containment logic and why it's not a
// bare startsWith() check.
function safePath(sub) {
  return resolveWithinFolder(sub, FOLDER);
}


app.get("/api/printers", requireAuth, (req, res) => {
  const out = [];
  PRINTERS.forEach((p, i) => { if (printerVisibleTo(req.user, p)) out.push({ id: i, name: p.name }); });
  res.json(out);
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

// Settings > General's live "does this path resolve" check — for the folder
// currently TYPED in the field, which may not be saved (or valid) yet, so it
// can't reuse FOLDER/safePath (those are jailed to the already-saved
// gcodeFolder). Resolves the same way loadConfig() resolves gcodeFolder
// (relative to BASE_DIR, same as a relative "./gcode" in config.json would
// be) and counts the same sliced-file extensions /api/files does.
app.get("/api/check-folder", requireAdmin, (req, res) => {
  const raw = String(req.query.path || "").trim();
  if (!raw) return res.json({ ok: false, error: "Enter a path" });
  const resolved = path.resolve(BASE_DIR, raw);
  try {
    if (!fs.statSync(resolved).isDirectory()) return res.json({ ok: false, error: "Not a folder" });
    const count = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => e.isFile() && /\.(gcode|gco|g|gx|3mf)$/i.test(e.name)).length;
    res.json({ ok: true, resolved, count });
  } catch {
    res.json({ ok: false, error: "Path not found" });
  }
});

// ---- Firmware folder listing (Settings > Firmware's "Select Firmware") ----
// Deliberately NOT built on /api/browse: that one is a browse-anywhere
// DIRECTORY picker, and teaching it to list files would expose filenames
// across the whole disk for no benefit here. This route speaks only in paths
// RELATIVE to the configured firmware folder — the browser never sends an
// absolute path — so the contract is jailed by construction rather than by
// an after-the-fact check on something arbitrary.
//
// Containment is pathSafety.js's resolveWithinFolder(), the same lexical jail
// safePath() uses for the gcode folder. That jail is LEXICAL ONLY — by its own
// documentation it does not resolve symlinks — so symlinks are handled here
// instead of pretending it covers them: symlink entries are never listed, and
// the directory being opened is checked with lstat, so a hand-crafted ?path=
// naming a symlinked directory is rejected rather than followed out of the
// jail. No claim is made beyond that.
//
// No extension filter: which files a given connector accepts is a question for
// Deploy, which has the connector in hand and must revalidate whatever it is
// given anyway. Listing everything avoids inventing a firmware file format.
app.get("/api/firmware-files", requireAdmin, (req, res) => {
  const configured = String(CFG.firmwareFolder || "").trim();
  // A CODE, not prose, unlike every other error here: this is the one case
  // the picker explains rather than echoes ("set a firmware folder in Settings
  // → General"), and that sentence has to come from the locale files. The
  // deploy route answers the same condition in prose because nothing there is
  // reachable from the UI without a folder already configured.
  if (!configured) return res.status(400).json({ error: "no_folder" });
  const root = path.resolve(BASE_DIR, configured);
  const sub = String(req.query.path || "");
  const dir = sub ? resolveWithinFolder(sub, root) : root;
  if (!dir) return res.status(400).json({ error: "Invalid path" });
  // "/"-joined so the value round-trips back through this same route
  // unchanged regardless of the OS separator, exactly like CURRENT_SUB does
  // for the gcode file manager.
  const rel = p => path.relative(root, p).split(path.sep).join("/");
  let entries;
  try {
    if (!fs.lstatSync(dir).isDirectory()) return res.status(400).json({ error: "Not a folder" });
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return res.status(404).json({ error: "Path not found" }); }
  const dirs = [], files = [];
  for (const e of entries) {
    // isDirectory()/isFile() are both false for a symlink here, so symlinks
    // fall out of the listing entirely — see the jail note above.
    const full = path.join(dir, e.name);
    if (e.isDirectory()) dirs.push({ name: e.name, path: rel(full) });
    else if (e.isFile()) {
      try {
        const st = fs.statSync(full);
        files.push({ name: e.name, path: rel(full), size: st.size, mtime: st.mtimeMs });
      } catch { /* vanished between readdir and stat — just omit it */ }
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  dirs.sort(byName); files.sort(byName);
  // parent is null at the root and "" for a first-level subfolder (the root's
  // own relative path) — the client tests for null, not falsiness.
  res.json({ path: rel(dir), parent: dir === root ? null : rel(path.dirname(dir)), dirs, files });
});

// ---- Firmware deploy (Settings > Firmware) ----
//
// The single most consequential thing this product can do to a printer, so:
// requireAdmin (not requireRegular, which is enough for e-stop), the file must
// come from the configured firmware folder through the same jail the listing
// route uses, and the printer must not be mid-print. A U1 trusts anything on
// the LAN (see the firmware module's SECURITY note) — SnapCon deliberately
// does not make that easy to trigger by accident, which is why there is no
// option to point this at an arbitrary path or a remote URL.
//
// SEQUENTIAL BY DESIGN. Each printer costs ~250 MB up and ~250 MB back for the
// MD5 read-back; three at once is 1.5 GB of concurrent traffic on the same LAN
// the printers depend on. Selected printers queue and run one at a time, and a
// failure records that printer and moves to the next rather than cancelling
// the rest.
//
// Progress is a printer-keyed record polled by /api/firmware-status. A
// blocking request is not viable: upload, verify and the flash watch together
// run for minutes, and the caller needs to know WHICH of those it is in — a
// single spinner over the whole sequence is what makes people power-cycle a
// printer mid-write.
const FW_STATE = new Map();     // printer id -> { phase, sent, total, file, error, result, ... }
const FW_QUEUE = [];            // { id, rel, actor } — waiting their turn
let FW_RUNNING = null;          // the one printer deploying right now
const FW_JOBS = new Map();      // jobId -> printer id, for /api/firmware-deploy-status
const newFwJobId = () => "fw" + Date.now() + Math.random().toString(16).slice(2, 6);

// How long a printer may claim to be "updating" after the flash began without
// being seen again. Past this it falls back to whatever the probe actually
// says, rather than claiming indefinitely that it is coming back.
const FW_REBOOT_GRACE_MS = 15 * 60 * 1000;

// A printer is off-limits to a second deploy while queued or running.
const fwBusyWith = id => (FW_RUNNING === id || FW_QUEUE.some(e => e.id === id));

// What the fleet card should say instead of the probe's own answer, or null.
//
// Two states, not one: "updating" while SnapCon is still doing something to
// the printer (queued, transferring, verifying, writing), and "rebooting"
// once the flash has taken it off the network. They mean different things to
// whoever is stood in front of the machine — the first is interruptible work,
// the second is a wait — and one word for both left people unsure whether
// anything was happening at all.
//
// Deliberately NOT open-ended: see FW_REBOOT_GRACE_MS.
function firmwareCardState(p) {
  const st = FW_STATE.get(p.id);
  if (!st) return null;
  if (st.phase === "rebooting") {
    return (st.flashStartedAt && Date.now() - st.flashStartedAt < FW_REBOOT_GRACE_MS)
      ? "rebooting" : null;
  }
  return fwBusyWith(p.id) ? "updating" : null;
}
// Is SnapCon actively doing something to this printer's firmware? Covers the
// whole window: queued, transferring, verifying, writing, and the reboot
// afterwards. Used by isPrinterIdle so the print queue cannot dispatch a job
// into the middle of a deploy.
function firmwareUpdating(p) {
  return firmwareCardState(p) !== null;
}

// Resolve whatever the browser named into a printer.
//
// Prefers the STABLE id. server.js already knows PRINTERS[] can be reordered by
// a Settings save within one run — saveQueuedFiles() persists by p.id for
// exactly that reason — and firmware deploy is the most destructive thing here,
// so it must not resolve a target through an index that may since have moved.
// A numeric index is still accepted so an older client keeps working, but it is
// the weaker identifier and the browser no longer sends one.
function firmwareTargetFor(ref) {
  if (typeof ref === "string" && ref) return PRINTERS.find(x => x.id === ref) || null;
  if (typeof ref === "number" && Number.isInteger(ref) && ref >= 0) return PRINTERS[ref] || null;
  return null;
}

// Does the image positively CONTRADICT what this printer says it is?
//
// Deliberately narrow, and it does not second-guess connectors/firmwareImage.js:
// that module documents at length that the payload never states a model and the
// file name proves nothing, which is why compatibilityFor() returns a warning
// rather than a verdict. So absence of evidence stays a warning and only
// positive disagreement — the file says A400, the printer says U1 — stops the
// deploy, before a quarter-gigabyte is uploaded rather than after.
//
// The escape hatch is deliberate and obvious: name the file correctly.
function firmwareCompatReject(image, productCode) {
  const c = firmwareImage.compatibilityFor(image, productCode);
  if (c.hardFail && c.hardFail.length) return c.hardFail.join("; ");
  const named = image && image.filename && image.filename.product;
  if (!named || !productCode) return null;
  if (String(named).toLowerCase() === String(productCode).toLowerCase()) return null;
  return "The firmware file is named for " + named + " but this printer reports itself as "
    + productCode + " — nothing was uploaded. Check the file, or rename it if it really is correct.";
}

// Called from probeCached with a fresh observation: a printer that answers
// again after a flash has finished rebooting, so stop overriding its state.
// Phase-gated — during upload/verify the printer is legitimately online and
// must not clear itself early.
function firmwareNoteObserved(p, online) {
  const st = FW_STATE.get(p.id);
  if (!st || !online) return;
  if (st.phase === "rebooting") { st.phase = "updated"; st.backOnlineAt = Date.now(); st.ts = Date.now(); }
}

setInterval(() => {
  const cutoff = Date.now() - JOB_MAX_AGE;
  for (const [id, st] of FW_STATE) {
    const settled = ["updated", "failed", "skipped", "cancelled", "rejected"].includes(st.phase);
    if (settled && st.ts < cutoff && !fwBusyWith(id)) { FW_STATE.delete(id); }
  }
  for (const [jobId, id] of FW_JOBS) if (!FW_STATE.has(id)) FW_JOBS.delete(jobId);
}, 60 * 1000).unref();

// Resolve a browser-supplied RELATIVE path to a real file inside the
// configured firmware folder, or explain why not.
//
// Deliberately called twice: once to answer the request, and again inside the
// job immediately before the file is read. Between those two moments the
// admin can edit the firmware folder in Settings, and the file itself can be
// deleted, moved, or replaced with a symlink pointing somewhere else. The
// check that matters is the one taken against the state that will actually be
// used, so it is one function rather than a validated value carried forward.
function resolveFirmwareFile(relRaw) {
  const configured = String(CFG.firmwareFolder || "").trim();
  if (!configured) return { status: 400, error: "No firmware folder is configured" };
  // Absolute paths are refused outright rather than merely failing the jail
  // below — the contract with the browser is "relative to the firmware
  // folder", and anything else is a caller doing something it should not.
  if (!relRaw || path.isAbsolute(relRaw)) return { status: 400, error: "Invalid path" };
  const root = path.resolve(BASE_DIR, configured);
  const file = resolveWithinFolder(relRaw, root);
  if (!file) return { status: 400, error: "Invalid path" };
  // lstat, not stat: a symlink is not followed out of the jail here either.
  try { if (!fs.lstatSync(file).isFile()) return { status: 400, error: "Not a file" }; }
  catch { return { status: 404, error: "Firmware file not found" }; }
  return { file };
}

// Is this printer safe to flash right now? Re-asked immediately before the
// deploy starts and again immediately before the irreversible write, not only
// when the request arrived.
//
// Maintenance mode is deliberately NOT a blocker: a printer taken out of
// production on purpose is a sensible one to update. Printing and paused are.
async function firmwareDeployBlockedBy(p) {
  try {
    const st = await probeCached(p);
    if (st && st.online && (st.state === "printing" || st.state === "paused")) {
      return p.name + " is printing — stop the print before updating firmware";
    }
    // Checked here as well as in the connectors, not instead of them: this is
    // the last gate before an irreversible write, and its correctness should
    // not depend on a mapping that lives in another module. Stated separately
    // from the printing case because "is printing" would be a lie about a
    // crashed machine and points the operator at the wrong fix -- a Klipper
    // shutdown needs FIRMWARE_RESTART, not "stop the print".
    if (st && st.online && st.state === "error") {
      return p.name + " is reporting an error — clear the fault before updating firmware";
    }
    if (st && !st.online) return p.name + " is offline";
  } catch { /* unreachable printer: let the deploy itself report the failure */ }
  return null;
}

function fwSet(id, patch) {
  const cur = FW_STATE.get(id) || { sent: 0, total: 0 };
  FW_STATE.set(id, { ...cur, ...patch, ts: Date.now() });
}

// One printer, start to finish. Never throws: every ending is recorded on the
// printer's own record so the queue can carry on to the next one.
async function runFirmwareDeploy(id, relRaw, actor, verifyMode) {
  const p = PRINTERS.find(x => x.id === id);
  const st = FW_STATE.get(id) || {};
  if (!p) { fwSet(id, { phase: "failed", error: "Printer no longer exists" }); return; }
  try {
    fwSet(id, { phase: "preparing", sent: 0, total: 0, startedAt: Date.now() });
    // Re-ask both questions against the state that will actually be used. The
    // request-time answers are already stale by the time this runs, and "the
    // printer was idle a moment ago" is not what makes flashing safe.
    const stillBlocked = await firmwareDeployBlockedBy(p);
    if (stillBlocked) throw new Error(stillBlocked);
    const now = resolveFirmwareFile(relRaw);
    if (now.error) throw new Error(now.error);

    // With no mode the connector picks its own default: a CRC-32 taken from
    // the printer's own archive of the file, falling back to windowed
    // sampling on firmware without that endpoint. "none" is the one value a
    // request can set, and it means exactly what it says.
    const r = await u1Firmware.updateFromFile(p, now.file, {
      ...(verifyMode ? { verify: verifyMode } : {}),
      onStep: sInfo => {
        if (sInfo.step === "device" && sInfo.info) fwSet(id, { before: sInfo.info });
        if (sInfo.step === "upload") fwSet(id, { phase: "upload", sent: 0 });
        if (sInfo.step === "verify") fwSet(id, { phase: "verify", sent: 0 });
        if (sInfo.step === "verify-skipped") fwSet(id, { verify: "none" });
        if (sInfo.step === "flash") fwSet(id, { phase: "flash", flashStartedAt: Date.now() });
      },
      // Per-chunk, so this only touches an in-memory record — the poll reads it.
      onProgress: (phase, sent, total) => {
        const cur = FW_STATE.get(id);
        if (cur && cur.phase === phase) { cur.sent = sent; cur.total = total; cur.ts = Date.now(); }
      },
      // The last exit before anything irreversible. Upload and verify take
      // minutes, which is long enough for someone to have started a print
      // since this deploy began. Throwing here aborts with nothing written;
      // the uploaded image stays on the printer, which is inert.
      beforeFlash: async () => {
        const busy = await firmwareDeployBlockedBy(p);
        if (busy) throw new Error(p.name + " started printing during the upload — nothing was flashed");
      },
    });

    // Three distinct endings, kept distinct. A flash that started and took the
    // printer offline to write the image is a SUCCESS the user should see as
    // such — but the new version is genuinely not observable yet, so nothing
    // invents one: "after" stays null and the phase says why.
    const result = r.after ? "updated" : "version-unconfirmed";
    fwSet(id, {
      phase: r.after ? "updated" : "rebooting",
      result, before: r.before, after: r.after, sent: 0, total: 0,
      flashStartedAt: (FW_STATE.get(id) || {}).flashStartedAt || Date.now(),
    });
    auditLog.log({
      category: "admin", event: "firmware-deploy", ...actor,
      printerId: p.id, printerName: p.name,
      // The verification MODE is recorded, not just that it happened: if this
      // printer later turns out to have been flashed with a bad image, "which
      // check ran, and did it fall back to a weaker one" is the question.
      detail: { file: st.file, result, watch: r.outcome,
                verify: r.verify || null, verifyFellBackFrom: r.fellBackFrom || null,
                from: (r.before && r.before.fullversion) || null,
                to: (r.after && r.after.fullversion) || null },
    });
  } catch (e) {
    fwSet(id, { phase: "failed", error: e.message, result: null, sent: 0, total: 0 });
    auditLog.log({
      category: "admin", event: "firmware-deploy-failed", ...actor,
      printerId: p.id, printerName: p.name,
      detail: { file: st.file, error: e.message },
    });
  }
}

// Set by POST /api/firmware-stop. Honoured BETWEEN printers only: a flash
// that has started is never interrupted, because the half-written image is
// what leaves a printer unbootable. Everything still queued is dropped and
// recorded as cancelled, so the rows say what happened rather than silently
// disappearing.
let FW_STOP_REQUESTED = false;

// Drains the queue one printer at a time. Re-entrant-safe: only ever one
// runner, and it keeps going until the queue is empty.
let fwDraining = false;
async function drainFirmwareQueue() {
  if (fwDraining) return;
  fwDraining = true;
  try {
    while (FW_QUEUE.length) {
      if (FW_STOP_REQUESTED) {
        // Between printers is the only safe place to stop.
        for (const job of FW_QUEUE.splice(0)) {
          fwSet(job.id, { phase: "cancelled", result: "cancelled", sent: 0, total: 0 });
        }
        break;
      }
      const job = FW_QUEUE.shift();
      FW_RUNNING = job.id;
      // Never throws — see runFirmwareDeploy. One printer failing must not
      // cancel the printers queued behind it.
      await runFirmwareDeploy(job.id, job.rel, job.actor, job.verifyMode);
      FW_RUNNING = null;
    }
  } finally { FW_RUNNING = null; fwDraining = false; FW_STOP_REQUESTED = false; }
}

// Inspect a firmware file without deploying it — what the confirmation dialog
// shows before anything is committed.
app.get("/api/firmware-inspect", requireAdmin, (req, res) => {
  const resolved = resolveFirmwareFile(String(req.query.path || ""));
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  // Belt and braces with the module's own guarding: this route must always
  // answer JSON, because a caller that gets an HTML error page back cannot
  // tell "this file is unreadable" from "this SnapCon has no such route".
  let info;
  try { info = firmwareImage.inspectFirmwareImage(resolved.file); }
  catch (e) { return res.status(500).json({ error: "The firmware file could not be checked: " + e.message }); }
  res.json({
    file: info.file, size: info.size, container: info.container, chip: info.chip,
    chipOk: info.chipOk, headerConsistent: info.headerConsistent,
    version: info.version, buildTime: info.buildTime,
    // What a printer would report if it were running this image. The browser
    // compares on THIS, never on the version alone — see firmwareBuildId.
    buildId: firmwareImage.firmwareBuildId(info),
    filenameProduct: info.filename ? info.filename.product : null,
    hardFail: info.hardFail, warnings: info.warnings,
  });
});

app.post("/api/firmware-deploy", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const actor = actorFromReq(req);
  const relRaw = String(b.path || "");
  const skipCurrent = b.skipCurrent !== false;   // defaults ON
  // Verification is a MODE, and only an explicit false turns it off — an old
  // or hand-written client that omits the field still gets the check. null
  // means "let the connector choose", which is the CRC-32 check.
  const verifyMode = b.verify === false ? "none" : null;
  const wanted = Array.isArray(b.printers) ? b.printers : (b.printer !== undefined ? [b.printer] : []);
  if (!wanted.length) return res.status(400).json({ error: "No printers selected" });

  const resolved = resolveFirmwareFile(relRaw);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  // Pre-flight on the image itself. Only facts readable from the bytes are
  // fatal (container, chip, internally impossible offsets); a filename/model
  // mismatch is a warning carried to the caller, never a claim of proven
  // compatibility — see connectors/firmwareImage.js.
  const image = firmwareImage.inspectFirmwareImage(resolved.file);
  if (image.hardFail.length) return res.status(400).json({ error: image.hardFail.join("; ") });
  const targetBuild = firmwareImage.firmwareBuildId(image);

  const accepted = [], rejected = [], skipped = [];

  // A rejected printer used to be pushed to `rejected` and nothing else: it got
  // no FW_STATE, so it never appeared in the status table, and the browser read
  // the array only to clear a refresh flag. Selecting five printers with two
  // printing therefore reported "Firmware update started" and those two silently
  // vanished. Every rejection now leaves a visible record carrying its reason.
  //
  // The one exception is a printer already mid-deploy: writing here would
  // overwrite the live progress record of the deploy that is actually running.
  const reject = (p, idx, error, status) => {
    rejected.push({ printer: idx, id: p ? p.id : null, name: p ? p.name : undefined,
                    ...(status ? { status } : {}), error });
    if (p && !fwBusyWith(p.id)) {
      fwSet(p.id, { phase: "rejected", file: path.basename(resolved.file), error,
                    result: "rejected", sent: 0, total: 0 });
    }
  };

  for (const ref of wanted) {
    const p = firmwareTargetFor(ref);
    if (!p) {
      rejected.push({ printer: typeof ref === "number" ? ref : null, id: typeof ref === "string" ? ref : null,
                      error: "That printer no longer exists" });
      continue;
    }
    // The index is still reported back so the existing status table, which is
    // keyed by index, can find the row. Resolution happened by id.
    const idx = PRINTERS.indexOf(p);
    if (!getCapabilities(p.connector, p).firmwareDeploy) {
      reject(p, idx, p.name + " does not support firmware deployment");
      continue;
    }
    // Cheap early answer; the claim that actually decides is taken below,
    // after every await, so this one is an optimisation and not the guard.
    if (fwBusyWith(p.id)) {
      reject(p, idx, p.name + " already has a firmware update running", 409);
      continue;
    }
    const blocked = await firmwareDeployBlockedBy(p);
    if (blocked) { reject(p, idx, blocked); continue; }

    // Already on this build? Not a failure — nothing needed doing. Costs a
    // ~250 MB upload and an unnecessary flash to find out the hard way.
    // Asked here, with the rest of the awaits, so the claim below can be
    // taken synchronously.
    //
    // Compared on the BUILD ID, not the version. A U1 reports "1.6.0" in the
    // version field and "1.6.0.267_20260815150420" in fullversion; the image
    // states the latter. Comparing the short one against the image never
    // matched, so this skip silently never fired — every printer already
    // running the image was re-flashed anyway.
    // Read once and used for two questions: which build this printer is on,
    // and which product it says it is. Previously only fetched when skipCurrent
    // was on, which is why the compatibility check below could never run.
    let current = null, product = null;
    try {
      const info = await u1Firmware.getDeviceInfo(p);
      // product_code is the field name system.get_device_info actually uses
      // (confirmed in connectors/firmwareImage.js and the mock printer). Reading
      // `product` instead silently returns undefined, which makes the
      // compatibility check below inert rather than failing loudly.
      if (info) { current = info.fullversion || info.version; product = info.product_code || null; }
    } catch { /* unknown: neither question can be answered, so neither blocks */ }

    // Before the upload, not after: a contradiction found here costs nothing,
    // and found later costs a quarter-gigabyte and an operator's confidence.
    const incompatible = firmwareCompatReject(image, product);
    if (incompatible) { reject(p, idx, incompatible); continue; }

    // ---- NO await from here to the claim. ----
    // Two requests naming the same printer can both be parked on the probes
    // above; if the queue claim were taken after another await, both would
    // pass the check and the printer would be enqueued twice. Node will not
    // interleave a synchronous check-then-claim, so this window contains none.
    if (fwBusyWith(p.id)) {
      reject(p, idx, p.name + " already has a firmware update running", 409);
      continue;
    }
    // With a build stamp the whole identifier must match. Without one (a
    // pre-1.6.0 image states no BUILD_NUMBER) fall back to the version half,
    // which is weaker but still a real reading from the payload.
    const same = targetBuild
      ? String(current) === targetBuild
      : !!(image.version && firmwareImage.firmwareVersionPart(current) === image.version);
    // skipCurrent is re-asserted HERE, not in whether the version was read.
    // Device info is now fetched unconditionally (the compatibility check needs
    // the product code), so gating on `current` being populated would silently
    // start skipping printers for an operator who deliberately turned skipping
    // off. The switch decides, exactly as before.
    if (skipCurrent && (targetBuild || image.version) && current && same) {
      fwSet(p.id, { phase: "skipped", file: path.basename(resolved.file), error: null,
                    result: "already-current", sent: 0, total: 0, current });
      skipped.push({ printer: idx, id: p.id, name: p.name, version: current });
      continue;
    }
    fwSet(p.id, { phase: "queued", file: path.basename(resolved.file), error: null,
                  result: null, sent: 0, total: 0, queuedAt: Date.now(), flashStartedAt: null });
    // Each entry carries its OWN file, actor and verification choice. A second
    // request that arrives while the queue is still draining names a different
    // file, and deploying it with the first request's image would flash the
    // wrong firmware onto a printer nobody asked to change.
    FW_QUEUE.push({ id: p.id, rel: relRaw, actor, verifyMode });
    const jobId = newFwJobId();
    FW_JOBS.set(jobId, p.id);
    accepted.push({ printer: idx, id: p.id, name: p.name, job: jobId });
  }

  // A new request clears a stop from a previous batch — otherwise the stop
  // would silently cancel work the user just asked for.
  if (accepted.length) { FW_STOP_REQUESTED = false; drainFirmwareQueue(); }
  res.json({ ok: true, accepted, rejected, skipped, warnings: image.warnings, version: image.version, buildId: targetBuild });
});

// The Firmware tab's two switches. A dedicated route rather than the shared
// /api/config body, which falls back to the current value for every field it
// is not given — far too much to put at risk for two booleans saved on every
// toggle. Admin-only for the same reason the deploy is: turning verification
// off changes what a later flash checks.
app.post("/api/firmware-options", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (typeof b.skipCurrent === "boolean") CFG.firmwareSkipCurrent = b.skipCurrent;
  if (typeof b.verify === "boolean") CFG.firmwareVerify = b.verify;
  // Same guard every other write in this file uses: a config that failed to
  // load must never be overwritten from memory, or a recoverable read failure
  // becomes permanent data loss (CODE_AUDIT P0-1).
  if (CONFIG_LOAD_FAILED) return res.status(409).json({ error: "Config could not be read; not overwriting it" });
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); }
  catch (e) { return res.status(500).json({ error: "Could not save: " + e.message }); }
  if (b.verify === false) {
    // Worth a line in the audit on its own: it is the one setting that
    // decides whether anything checks an image before it is written.
    auditLog.log({ category: "admin", event: "firmware-verify-disabled", ...actorFromReq(req) });
  }
  res.json({ ok: true, skipCurrent: CFG.firmwareSkipCurrent !== false, verify: CFG.firmwareVerify !== false });
});

// Stop the queue after the printer currently being flashed finishes. Never
// interrupts a flash in progress — see FW_STOP_REQUESTED.
app.post("/api/firmware-stop", requireAdmin, (req, res) => {
  const pending = FW_QUEUE.length;
  FW_STOP_REQUESTED = true;
  auditLog.log({
    category: "admin", event: "firmware-deploy-stop", ...actorFromReq(req),
    detail: { running: FW_RUNNING !== null, pending },
  });
  res.json({ ok: true, running: FW_RUNNING !== null, pending });
});

// Aggregate status for the Firmware tab: every printer this server knows
// something about, plus the queue. Same lifetime rules as /api/print-status.
app.get("/api/firmware-status", requireAdmin, (req, res) => {
  // FW_STATE is keyed by the printer's STABLE id, so a Settings reorder cannot
  // slide one printer's progress onto another mid-deploy. The browser addresses
  // printers by array index, the same as every other route, so translate on the
  // way out rather than teaching the frontend a second identifier.
  const idxOf = new Map(PRINTERS.map((p, i) => [p.id, i]));
  const printers = {};
  for (const [id, st] of FW_STATE) {
    const idx = idxOf.get(id);
    if (idx === undefined) continue;   // printer deleted since the deploy
    printers[idx] = {
      phase: st.phase, sent: st.sent || 0, total: st.total || 0,
      file: st.file || null, error: st.error || null, result: st.result || null,
      current: st.current || null,
      // So the row can show a clock ticking through the reboot, which is the
      // one stretch where nothing else on screen changes.
      flashStartedAt: st.flashStartedAt || null,
      // The footer builds its estimate from bytes moved over seconds elapsed
      // on the transfer actually in flight, rather than from a constant.
      startedAt: st.startedAt || null,
      // When this record last changed — a settled card reports how long ago
      // it finished rather than just that it did.
      ts: st.ts || null,
      verify: st.verify || null,
      from: (st.before && st.before.fullversion) || null,
      to: (st.after && st.after.fullversion) || null,
    };
  }
  const toIdx = id => { const i = idxOf.get(id); return i === undefined ? null : i; };
  res.json({
    running: FW_RUNNING === null ? null : toIdx(FW_RUNNING),
    queue: FW_QUEUE.map(e => toIdx(e.id)).filter(i => i !== null),
    stopping: FW_STOP_REQUESTED,
    printers,
  });
});

// Retained for compatibility with the single-job shape this route has always
// had. Nothing in the tree consumes it any more (the Firmware tab reads the
// aggregate above), so it is a candidate for deliberate removal rather than
// something to keep growing.
app.get("/api/firmware-deploy-status", requireAdmin, (req, res) => {
  const id = FW_JOBS.get(req.query.job);
  const st = id !== undefined ? FW_STATE.get(id) : null;
  if (!st) return res.status(404).json({ error: "No such job" });
  const done = ["updated", "failed", "skipped", "rebooting"].includes(st.phase);
  res.json({
    phase: st.phase, done, error: st.error || null, outcome: st.result || null,
    result: st.result || null, file: st.file || null, detail: null,
    from: (st.before && st.before.fullversion) || null,
    to: (st.after && st.after.fullversion) || null,
  });
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
  if (!isPathWithinFolder(target, FOLDER)) return res.status(400).json({ error: "Invalid folder name" });
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
  // Same CRLF/quote check as /api/printfile and /api/exclude — this name is
  // later reused verbatim as the on-printer filename passed to
  // startPrintFile()/excludeObject(), which build a literal gcode script
  // line around it (see connectors/http-utils.js). An embedded quote or
  // newline there injects a second gcode/macro command into the printer.
  if (!name || /["\r\n]/.test(name) || !/\.(gcode|gco|g|gx|3mf)$/i.test(name)) {
    return res.status(400).json({ error: "Only sliced files (.gcode/.gco/.g/.gx/.3mf) can be uploaded here" });
  }
  const target = path.join(dir, name);
  if (!isPathWithinFolder(target, FOLDER)) return res.status(400).json({ error: "Invalid file name" });
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

// Per-print checkboxes (Flow Calibration / Time-Lapse / Auto-Leveling —
// currently only meaningful to snapmaker-u1-klipper's applyHeadMapping,
// which folds them into one SET_PRINT_PREFERENCES macro line). A connector
// that doesn't understand `prefs` simply never sees it reach anything, since
// only connectors that export applyHeadMapping get called at all.
const wantsAnyPref = prefs => !!(prefs && (prefs.autoLevel || prefs.flowCalibrate || prefs.timelapse));
// Same three fields, but read from the PRINTER's own configured defaults
// (Settings > printer > Behavior) rather than a request's per-job prefs —
// used so applyHeadMapping still fires when a printer has e.g.
// flowCalibrate:true by default and the caller sent no override for it.
const printerHasAnyDefaultPref = p => !!(p.autoLevel || p.flowCalibrate || p.timelapse);

// ---- Monitor-only printers ----
// A connector that declares capabilities.control === false (connectors/
// monitorOnly.js) is read-only BY DESIGN: SnapCon shows its status and never
// commands it. The UI hides every control for such a printer, and this is the
// server half of the same rule — every route that would change what a printer
// does calls refuseMonitorOnly() right after its visibility check, and queue
// dispatch/auto-balance skip these printers outright. One predicate, so a
// connector can never be half read-only. The connector's own control stubs
// throw too; this guard exists so a request gets a clear 409 before any of
// the route's side effects (staging a file, queueing, audit rows) happen.
function printerIsMonitorOnly(p) {
  return !!p && isMonitorOnly(getCapabilities(p.connector, p));
}
function refuseMonitorOnly(p, res) {
  if (!printerIsMonitorOnly(p)) return false;
  res.status(409).json({ error: monitorOnlyMessage(p.name), code: MONITOR_ONLY_CODE });
  return true;
}

app.post("/api/print", requireRegular, async (req, res) => {
  const { file, printer, start, map, prefs } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  if (refuseMonitorOnly(p, res)) return;
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
      const unit = (getCapabilities(p.connector, p) || {}).singleToolhead ? "slot" : "head";
      return res.status(400).json({ error: `Two colors are mapped to the same ${unit} — give each its own ${unit}.` });
    }
  }

  const c = getConnector(p.connector);
  const name = path.basename(fp);

  // Upload-only click (Upload button, not Print) while this printer is
  // actively busy: queue it instead of racing an upload against whatever's
  // already printing. When Queue Management is enabled and this printer has
  // a pool, the new per-printer queue subsumes the old single-slot
  // mechanism entirely (round-3 issue #7) — otherwise falls back to the
  // original pendingLoad/queuedFile mechanism, unchanged.
  if (!start && !(await isPrinterIdle(p))) {
    if (CFG.queueManagement && CFG.queueManagement.enabled && p.printerPoolId) {
      const actor = actorFromReq(req);
      let hash;
      try { hash = queueStore.computeFileHash(fp); } catch { hash = null; }
      if (hash) {
        const result = queueStore.applyIntent(p.id, (state) => ({
          ...state,
          queue: [...state.queue, {
            id: QueueEngine.newQueueItemId(), status: "queued", alreadyUploaded: false,
            file: { name, sub: "", sizeBytes: hash.sizeBytes, sha256: hash.sha256 },
            map, prefs, createdAt: Date.now(), dispatchedAt: null, finishedAt: null,
            queuedBy: actor, retryOfItemId: null, dispatchSnapshot: null
          }],
          updatedAt: Date.now()
        }));
        if (result.ok) {
          auditLog.log({ category: "job", event: "queue-item-added", ...actor, printerId: p.id, printerName: p.name, detail: { count: 1, viaLegacyUpload: true } });
          return res.json({ ok: true, mode: "queued", printer: p.name });
        }
      }
      // Persistence/hash unavailable — fall through to the legacy mechanism
      // rather than silently dropping the upload the user asked for.
    }
    pendingLoad.set(printer, { file: fp, name, ts: Date.now(), tools, map, prefs, actor: actorFromReq(req) });
    return res.json({ ok: true, mode: "pending", printer: p.name });
  }

  // Kick the work off in the background and hand the client a job id to poll.
  const jobId = newJobId();
  const job = { phase: "upload", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now() };
  JOBS.set(jobId, job);
  res.json({ jobId });
  const actor = actorFromReq(req);

  (async () => {
    try {
      await c.uploadFile(p, fp, name, job);               // 1) upload (with progress)
      console.log(`[print] ${p.name}: upload resolved for "${name}" (start=${start})`);
      // 2) toolhead mapping + print-preference macros (connector-optional) —
      // still needed with no mapping chosen (tools=[]) when the printer has
      // its own preferences (auto-level/flow-calibrate/timelapse) to send
      // before print start.
      // Guarded from here: applyHeadMapping is where the long waits live.
      await withStartSequence(p, async () => {
        if (c.applyHeadMapping && (tools.length || printerHasAnyDefaultPref(p) || wantsAnyPref(prefs))) {
          job.phase = "mapping";
          console.log(`[print] ${p.name}: applyHeadMapping starting (tools=${tools.length}, prefs=${JSON.stringify(prefs)}, printer defaults autoLevel=${!!p.autoLevel} flowCalibrate=${!!p.flowCalibrate} timelapse=${!!p.timelapse})`);
          await c.applyHeadMapping(p, tools, map, prefs);
          console.log(`[print] ${p.name}: applyHeadMapping resolved`);
        }
        if (start) {
          job.phase = "starting";
          console.log(`[print] ${p.name}: startPrintFile starting for "${name}"`);
          await c.startPrintFile(p, name);
          console.log(`[print] ${p.name}: startPrintFile resolved`);
        }
      });
      if (!start) {
        // Upload-only click, printer was idle (the busy case queued via
        // pendingLoad above, never reaches here) — the file is sitting on
        // the printer with nothing else loaded or printing, so surface it
        // the same "ready to print" way uploadNotifiedFile does once a
        // pending upload finally lands: one click away, not silently just
        // stored.
        queuedFile.set(printer, { name, status: "ready", ts: Date.now() });
        saveQueuedFiles();
      }
      job.result = { printer: p.name, started: !!start, mapped: tools.length };
      job.phase = "done"; job.done = true;
      if (start) ROUTE_STARTED_PRINT.add(p.url);
      auditLog.log({ category: "job", event: start ? "print-started" : "file-uploaded", ...actor, printerId: p.id, printerName: p.name, detail: { file: name } });
    } catch (e) {
      console.log(`[print] ${p.name}: FAILED at phase "${job.phase}" — ${e.message}`);
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
  if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
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
  if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
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

// The slow half of /api/printfile, run detached so the request can return a
// job id immediately (docs/TODO.md item 9a). applyHeadMapping can take up to
// twelve minutes on Creality (G29), and any gcode command can additionally sit
// queued behind a blocking macro -- measured at ~46s for a CANCEL_PRINT stuck
// behind START_PRINT -- so awaiting this on the request thread meant the
// browser timed out on prints that had actually started.
//
// Named rather than an inline IIFE (unlike /api/print's, which predates this)
// so the phase progression and the success bookkeeping are testable without an
// express harness, which this project does not have.
//
// The bookkeeping stays inside the success path on purpose: clearing the
// "Loaded" badge, ROUTE_STARTED_PRINT (which suppresses notifyTick's duplicate
// print-started notification) and the audit row must fire exactly once, and
// never for a job that failed -- an audit trail claiming a print started when
// it did not is worse than no trail at all.
async function runPrintFileJob({ p, c, filename, tools, map, prefs, actor, needsMapping, job, printerKey }) {
  try {
    await withStartSequence(p, async () => {
      if (needsMapping) {
        job.phase = "mapping";
        console.log(`[printfile] ${p.name}: applyHeadMapping starting (tools=${tools.length}, prefs=${JSON.stringify(prefs)}, printer defaults autoLevel=${!!p.autoLevel} flowCalibrate=${!!p.flowCalibrate} timelapse=${!!p.timelapse})`);
        await c.applyHeadMapping(p, tools, map, prefs);
        console.log(`[printfile] ${p.name}: applyHeadMapping resolved, calling startPrintFile`);
      }
      job.phase = "starting";
      await c.startPrintFile(p, filename);
    });
    console.log(`[printfile] ${p.name}: startPrintFile resolved for "${filename}"`);
    // Printing it is what "ready to print" was waiting for -- clear the badge.
    if (queuedFile.get(printerKey)?.name === filename) { queuedFile.delete(printerKey); saveQueuedFiles(); }
    ROUTE_STARTED_PRINT.add(p.url);
    auditLog.log({ category: "job", event: "print-started", ...actor, printerId: p.id, printerName: p.name, detail: { file: filename } });
    job.result = { printer: p.name, filename, mapped: tools.length };
    job.phase = "done"; job.done = true;
  } catch (e) {
    console.log(`[printfile] ${p.name}: FAILED at phase "${job.phase}" -- ${e.message}`);
    job.error = e.message; job.done = true; job.phase = "error";
  }
}

app.post("/api/printfile", requireRegular, (req, res) => {
  const { printer, filename, map, prefs } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  if (refuseMonitorOnly(p, res)) return;
  if (p.maintenanceMode) return res.status(409).json({ error: p.name + " is in maintenance mode — take it off maintenance before printing." });
  if (!filename || /["\r\n]/.test(filename)) return res.status(400).json({ error: "Bad filename" });

  // Same head-mapping macros as the upload flow (map = { paletteIdx: headIdx }).
  let tools = [];
  if (map && Object.keys(map).length) {
    tools = Object.keys(map).map(Number).sort((a, b) => a - b);
  }
  const c = getConnector(p.connector);
  // Still needed with no mapping chosen (tools=[]) when the printer has its
  // own preferences (auto-level/flow-calibrate/timelapse) to send before
  // print start.
  const needsMapping = !!c.applyHeadMapping && (tools.length > 0 || printerHasAnyDefaultPref(p) || wantsAnyPref(prefs));

  // Everything above is cheap and synchronous, so those rejections stay
  // outright HTTP errors. Everything below can block on physical printer work,
  // so it moves onto the same JOBS machinery /api/print already uses: this
  // response now means "start job accepted", NOT "printing" -- clients poll
  // /api/print-status for the outcome.
  const jobId = newJobId();
  const job = { phase: needsMapping ? "mapping" : "starting", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now() };
  JOBS.set(jobId, job);
  res.json({ ok: true, jobId, printer: p.name, filename, mapped: tools.length });
  runPrintFileJob({ p, c, filename, tools, map, prefs, actor: actorFromReq(req), needsMapping, job, printerKey: printer });
});

// ---- Print control: pause / resume / cancel (standard Klipper macros) ----
app.post("/api/printctl", requireRegular, async (req, res) => {
  const { printer, action } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  if (refuseMonitorOnly(p, res)) return;
  const c = getConnector(p.connector);
  const method = { pause: c.pause, resume: c.resume, cancel: c.cancel, eject: c.eject, estop: c.estop }[action];
  if (!method) return res.status(400).json({ error: "Bad action" });
  try {
    await method.call(c, p);
    // Eject means "this printer is no longer holding a job for me". The
    // connector call clears Klipper's loaded file; the staged entry behind the
    // "Loaded" badge is SnapCon's own and was previously cleared ONLY by
    // actually printing the file, so a staged job could not be dismissed at
    // all. Clearing it here is what makes the button mean what it says.
    if (action === "eject" && queuedFile.has(printer)) { queuedFile.delete(printer); saveQueuedFiles(); }
    auditLog.log({ category: "job", event: "printctl-" + action, ...actorFromReq(req), printerId: p.id, printerName: p.name });
    res.json({ ok: true, action });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Exclude-object: live plate map + skip a single object mid-print ----
app.get("/api/plate", requireAuth, async (req, res) => {
  const p = PRINTERS[req.query.printer];
  if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
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
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  if (refuseMonitorOnly(p, res)) return;
  if (!name || /["\r\n]/.test(name)) return res.status(400).json({ error: "Bad object name" });
  const c = getConnector(p.connector);
  if (!c.excludeObject) return res.status(400).json({ error: p.name + " does not support excluding objects" });
  try {
    await c.excludeObject(p, name);
    auditLog.log({ category: "job", event: "exclude-object", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { name } });
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
//
// That "requires a repeat" rule breaks down for a genuine, sustained ramp
// (heating/cooling toward a target): the reading is a different integer on
// almost every poll, so it never repeats twice in a row, and `shown` stays
// frozen at whatever it was before the ramp started — confirmed live on a
// real K1C (hotend actually at 128.5°C heading to 130, still showing 115°C).
// JITTER_BAND bounds what counts as "rounding noise" (the ±1° case this was
// built for) — anything bigger is a real change and shows immediately,
// without waiting for a repeat.
const JITTER_BAND = 1;
const tempStableCache = new Map(); // "printerUrl:bed"|"printerUrl:hotend" -> { shown, pendingVal, pendingCount }
function stabilizeTemp(key, incoming) {
  if (!incoming) return incoming;
  let st = tempStableCache.get(key);
  if (!st) { st = { shown: incoming.temp, pendingVal: incoming.temp, pendingCount: 0 }; tempStableCache.set(key, st); }
  else if (incoming.temp === st.shown) {
    st.pendingVal = incoming.temp; st.pendingCount = 0;
  } else if (Math.abs(incoming.temp - st.shown) > JITTER_BAND) {
    st.shown = incoming.temp; st.pendingVal = incoming.temp; st.pendingCount = 0;
  } else {
    if (incoming.temp === st.pendingVal) st.pendingCount++;
    else { st.pendingVal = incoming.temp; st.pendingCount = 1; }
    if (st.pendingCount >= 2) { st.shown = incoming.temp; st.pendingCount = 0; }
  }
  return { temp: st.shown, target: incoming.target };
}

// Connectors report progress/duration for a completed print but no wall-clock
// end time — Klipper's print_stats has nothing like it. Stamp one the first
// time a probe observes a printer land on "complete", so the fleet card can
// show "Finished <time>" instead of a stale "Remaining 00m 00s". Cleared the
// moment the printer leaves the complete state so the next print gets its
// own fresh stamp rather than showing a previous job's finish time.
const completedAtCache = new Map(); // printer url -> timestamp
function stampCompletedAt(p, result) {
  if (result.state === "complete") {
    if (!completedAtCache.has(p.url)) completedAtCache.set(p.url, Date.now());
    return { ...result, completedAt: completedAtCache.get(p.url) };
  }
  completedAtCache.delete(p.url);
  return result;
}

// The WebRTC signaling URL only reaches the client through the fleet row —
// it is derived from the printer's own host by the connector, never stored
// in config.json and never hardcoded. Absent for every printer that has no
// WebRTC camera, so the client's own capability check stays the gate.
function webrtcCameraFields(p, conn) {
  if (!p.cameraWebrtc || typeof conn.webrtcSignalUrl !== "function") return {};
  const url = conn.webrtcSignalUrl(p);
  return url ? { cameraWebrtcUrl: url } : {};
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
    result = stampCompletedAt(p, result);
  }
  // Checked fresh every call, independent of the reachability cache above —
  // maintenanceMode can flip without a new probe cycle needing to happen.
  // A printer being reflashed reports nothing useful about itself — and for
  // part of that window it is legitimately offline while it writes the image.
  // Showing "Offline" in red at exactly that moment is what makes people
  // power-cycle a printer mid-write, so the firmware state speaks instead.
  // Server-side, so it holds for every client whether or not the Firmware
  // tab is open. Cleared by observation or by the reboot grace window.
  firmwareNoteObserved(p, !!result.online);
  const fwState = firmwareCardState(p);
  if (fwState) return { ...result, state: fwState };
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

// Printer url -> true, set right after /api/print or /api/printfile actually
// starts a print. notifyTick()'s own job-start detection (its only way to
// notice a print started directly on a printer's own screen) checks and
// consumes this flag so a SnapCon-initiated start — already audit-logged by
// the route itself, with the real user attached — isn't logged a second
// time, anonymously, whenever the next poll notices the same transition.
const ROUTE_STARTED_PRINT = new Set();

// A file that's actually "ready" is a real, permanent fact — it's sitting on
// the printer's own storage until it's printed or ejected — but Klipper
// itself has no concept of "loaded but not started" separate from actually
// beginning the print, so this in-memory bookkeeping is the ONLY place that
// fact lives. Persisted (by printer id, not the runtime array index queuedFile
// itself uses, since a Settings save can reorder PRINTERS[] within the same
// run) so a SnapCon restart doesn't forget it and silently strand a file the
// user can no longer see is there. "queued"/"uploading"/"error" are
// mid-flight snapshots of an operation that's simply dead the moment the
// process restarts — nothing to resume, so only "ready" is written.
function saveQueuedFiles() {
  const out = {};
  for (const [idx, qf] of queuedFile) {
    if (qf.status !== "ready") continue;
    const p = PRINTERS[idx];
    if (p && p.id) out[p.id] = { name: qf.name, ts: qf.ts };
  }
  try { fs.writeFileSync(QUEUED_FILE_PATH, JSON.stringify(out, null, 2)); }
  catch (e) { console.error("[queued-files] save failed:", e.message); }
}
function loadQueuedFiles() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(QUEUED_FILE_PATH, "utf8")); } catch { return; }
  if (!saved || typeof saved !== "object") return;
  PRINTERS.forEach((p, idx) => {
    const entry = p.id && saved[p.id];
    if (entry && entry.name) queuedFile.set(idx, { name: entry.name, status: "ready", ts: entry.ts || Date.now() });
  });
}
loadQueuedFiles();

const normPrinterName = s => String(s || "").replace(/_/g, " ").trim().toLowerCase();
function findPrinterIndex(name) {
  const norm = normPrinterName(name);
  if (!norm) return -1;
  return PRINTERS.findIndex(p => normPrinterName(p.name) === norm);
}

// The states in which SnapCon may START work on a printer -- queue dispatch,
// the pendingLoad retry, and both /api/notify-load arms all gate on this.
//
// An ALLOWLIST on purpose. This used to exclude only "printing"/"paused",
// which meant every other state counted as idle -- including "error", so a
// printer whose Klipper had shut down was handed queued jobs (docs/TODO.md
// item 9b). Failing closed also means a state we have not thought about, or
// one a future connector introduces, cannot silently authorise starting a job.
//
// FlashForge's "busy" is deliberately absent even though it counted as idle
// before: a dispatch predicate should not call an ambiguous state idle merely
// to preserve previous behavior. Add it only on hardware evidence that it is
// safe to dispatch into.
const DISPATCH_IDLE_STATES = new Set(["standby", "idle", "complete", "cancelled"]);

// Printers with a start sequence in flight (docs/TODO.md item 9i).
//
// Between "SnapCon began starting a print" and "the printer reports a job"
// the machine is physically busy while print_stats still says standby with no
// filename -- so the allowlist above calls it idle and it looks dispatchable.
// Reachable consequences during that window: queue dispatch claiming a
// printer already mid-start from another path, /api/notify-load uploading
// immediately instead of staging, and the card reading Idle.
//
// Deliberately keyed on "a start is in progress", not on any brand: the same
// race exists wherever the start is slow. Creality auto-level runs G29 inside
// applyHeadMapping bounded at TWELVE minutes, CFS material preparation runs
// 4-5 minutes, U1 head-mapping macros take seconds. One guard, three
// durations. The CFS case is only the one that made it obvious.
//
// A LEAKED entry is worse than the bug -- the printer becomes permanently
// undispatchable -- so every path in and out goes through withStartSequence,
// which releases in a finally.
//
// REFERENCE COUNTED, not a plain Set, because nothing serialises two starts
// of the SAME printer. Traced: /api/print gates on isPrinterIdle only when
// NOT starting, so the starting case has no gate; /api/printfile has no idle
// gate at all; and queue dispatch's isPrinterIdle + atomic
// claimNextForDispatch serialise queue-against-queue and nothing else. Two
// rapid Print clicks, or a Print racing a queue dispatch, therefore both
// enter here -- and with a Set the first completion would delete the entry
// and un-guard a start still in progress, which is precisely the window this
// exists to close.
const STARTING = new Map();   // printer id -> starts currently in flight
async function withStartSequence(p, fn) {
  STARTING.set(p.id, (STARTING.get(p.id) || 0) + 1);
  try { return await fn(); }
  finally {
    const left = (STARTING.get(p.id) || 1) - 1;
    if (left > 0) STARTING.set(p.id, left); else STARTING.delete(p.id);
  }
}
async function isPrinterIdle(p) {
  // Checked before the probe on purpose: the printer genuinely reports an
  // idle-looking state during its own start sequence, so no probe result can
  // answer this question.
  if (STARTING.has(p.id)) return false;
  // Same reasoning, different operation: during a firmware upload or verify the
  // printer is genuinely online and reporting standby, so the probe cannot tell
  // that it is busy. Dispatching a print here does not endanger the machine —
  // updateFromFile's beforeFlash gate catches it and aborts with nothing
  // written — but it destroys the deploy and surfaces as a firmware failure the
  // operator did not cause. The pre-flash gate stays as the last safety net;
  // this stops the collision happening in the first place.
  if (firmwareUpdating(p)) return false;
  try { const st = await probeCached(p); return !!(st && st.online) && DISPATCH_IDLE_STATES.has(st.state); }
  catch { return false; }
}
async function uploadNotifiedFile(idx, pl) {
  const p = PRINTERS[idx];
  const c = getConnector(p.connector);
  queuedFile.set(idx, { name: pl.name, status: "uploading", ts: Date.now() });
  saveQueuedFiles();
  try {
    await c.uploadFile(p, pl.file, pl.name, { sent: 0, total: 0 });
    // Only ever set when this came from the Upload-button queue (not the
    // --load CLI hook, which has no color-mapping concept) — apply the same
    // head mapping an immediate upload would have gotten, now that the
    // printer that was busy is finally idle enough to receive it.
    if (c.applyHeadMapping && ((pl.tools && pl.tools.length) || printerHasAnyDefaultPref(p) || wantsAnyPref(pl.prefs))) await c.applyHeadMapping(p, pl.tools || [], pl.map, pl.prefs);
    queuedFile.set(idx, { name: pl.name, status: "ready", ts: Date.now() });
    saveQueuedFiles();
    // pl.actor is attached by whichever caller queued this (a web request's
    // actorFromReq(req), or userLabel:"CLI" for the --load/--snapcon hook) —
    // by the time a busy printer finally goes idle and this runs, the
    // original HTTP request is long gone, so the actor has to travel with
    // the payload rather than being read from req here.
    auditLog.log({ category: "job", event: "file-uploaded", ...(pl.actor || { userId: null, userLabel: null }), printerId: p.id, printerName: p.name, detail: { file: pl.name } });
  } catch (e) {
    queuedFile.set(idx, { name: pl.name, status: "error", error: e.message, ts: Date.now() });
    saveQueuedFiles();
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

function printerById(id) { return PRINTERS.find(p => p.id === id); }
// The executable bed-clear payload (real URL/headers/body/secrets — see
// QueueItem.dispatchSnapshot) must never reach a GET response or an audit
// entry, even defensively — Phase 1 never actually populates it (Manual
// pools have no payload at all), but every route response is still
// scrubbed through this so it stays true once G-code/API pools exist.
function redactQueueStateForResponse(state) {
  const stripItem = (item) => (item && item.dispatchSnapshot) ? { ...item, dispatchSnapshot: { ...item.dispatchSnapshot, bedClearExecutable: undefined } } : item;
  return { ...state, currentItem: stripItem(state.currentItem), queue: state.queue.map(stripItem), recentHistory: state.recentHistory.map(stripItem) };
}

// ---- Queue Management dispatch execution ----
// claimNextForDispatch() only ever decides WHO gets claimed and persists
// that decision — actually touching the connector (upload/mapping/start)
// happens here, exactly once per claim, and records the real-world outcome
// back through QueueEngine's Category-B functions (onDispatchSuccess/
// Failure) via queueStore.applyObserved.
async function attemptQueueDispatch(printerId) {
  const p = PRINTERS.find(pr => pr.id === printerId);
  if (!p || !p.printerPoolId) return;
  // Never dispatch to a monitor-only printer, even one left in a pool by a
  // hand-edited config or a connector change (see refuseMonitorOnly).
  if (printerIsMonitorOnly(p)) return;
  // Interlock with the OLD single-slot mechanism (round-3 issue #7): a
  // printer the legacy pendingLoad/queuedFile flow still owns must finish
  // resolving under that flow first — both mechanisms racing to claim the
  // same printer the instant it goes idle is exactly the overlap the
  // interlock exists to prevent.
  const idx = PRINTERS.indexOf(p);
  if (pendingLoad.has(idx)) return;
  if (!(await isPrinterIdle(p))) return;

  const claim = queueStore.claimNextForDispatch(printerId);
  if (!claim.claimed) return;
  const item = claim.item;
  const c = getConnector(p.connector);
  const fp = safePath((item.file.sub ? item.file.sub + "/" : "") + item.file.name);

  // Mandatory pre-dispatch file-identity check (design doc Part B/D6,
  // round-3 issue #4, round-4 issue #7) — forced, uncached hash, since this
  // IS the moment identity is being decided, not the routine case the cache
  // exists for.
  let verified = false;
  try {
    if (!fp || !fs.existsSync(fp)) {
      queueStore.applyObserved(printerId, QueueEngine.onFileVerificationFailed, item.id, "missing", { code: "file-missing", message: "File no longer exists: " + item.file.name });
    } else {
      const hash = queueStore.computeFileHash(fp, { force: true });
      if (hash.sha256 !== item.file.sha256) {
        queueStore.applyObserved(printerId, QueueEngine.onFileVerificationFailed, item.id, "changed", { code: "file-changed", message: "File content changed since it was queued: " + item.file.name });
      } else {
        verified = true;
      }
    }
  } catch (e) {
    queueStore.applyObserved(printerId, QueueEngine.onFileVerificationFailed, item.id, "missing", { code: "file-check-error", message: e.message });
  }
  if (!verified) return;

  const name = item.file.name;
  try {
    if (!item.alreadyUploaded) await c.uploadFile(p, fp, name, { sent: 0, total: 0 });
    const tools = Object.keys(item.map || {}).map(Number).sort((a, b) => a - b);
    await withStartSequence(p, async () => {
      if (c.applyHeadMapping && (tools.length || printerHasAnyDefaultPref(p) || wantsAnyPref(item.prefs))) {
        await c.applyHeadMapping(p, tools, item.map, item.prefs);
      }
      await c.startPrintFile(p, name);
    });
    queueStore.applyObserved(printerId, QueueEngine.onDispatchSuccess, item.id);
    // Same dedup convention /api/print already uses — notifyTick's own
    // newJob detection would otherwise double-log this print's start.
    ROUTE_STARTED_PRINT.add(p.url);
    auditLog.log({ category: "job", event: "queue-print-started", printerId: p.id, printerName: p.name, detail: { file: name, retryOf: item.retryOfItemId || undefined } });
  } catch (e) {
    queueStore.applyObserved(printerId, QueueEngine.onDispatchFailure, item.id, { code: "dispatch-error", message: e.message });
    auditLog.log({ category: "job", event: "queue-dispatch-failed", printerId: p.id, printerName: p.name, detail: { file: name, error: e.message } });
  }
}

// Idle-sweep: the only OTHER trigger for a claim besides an explicit
// immediate attempt right after an action that might have freed a printer up
// (enqueue-with-start-now, confirm-bed-clear, resolving an attention state).
// Both paths funnel through the same claimNextForDispatch/attemptQueueDispatch
// — there is no second decision-making code path.
const QUEUE_SWEEP_MS = 5000;
setInterval(() => {
  if (!CFG.queueManagement || !CFG.queueManagement.enabled) return;

  // Auto-balance (opt-in per Printer Pool, see Settings -> Queue Management):
  // before the normal claim sweep below, let a printer about to sit idle
  // with an empty queue borrow work from a same-connector sibling in the
  // same pool that still has a backlog, rather than sit idle while others
  // are stacked up. QueueEngine.computeAutoBalanceMoves is pure — it just
  // computes the moves against a snapshot; applyBulkIntent is what actually
  // persists them as ONE transaction, so two printers going idle in the same
  // tick can't race each other for the same donor (see that function's own
  // comment for why processing them together, not one claim call each,
  // matters here).
  const balancePools = (CFG.printerPools || []).filter(pool => pool.autoBalance);
  if (balancePools.length) {
    const groups = balancePools
      .map(pool => ({ printers: PRINTERS.filter(p => p.printerPoolId === pool.id && !printerIsMonitorOnly(p)).map(p => ({ id: p.id, connector: p.connector })) }))
      .filter(g => g.printers.length > 1);
    if (groups.length) {
      const result = queueStore.applyBulkIntent(current => QueueEngine.computeAutoBalanceMoves(current, groups));
      if (result.ok && result.updates) {
        for (const printerId of Object.keys(result.updates)) {
          const p = printerById(printerId);
          if (p) auditLog.log({ category: "job", event: "queue-auto-balance-move", printerId: p.id, printerName: p.name });
        }
      }
    }
  }

  for (const p of PRINTERS) {
    if (!p.printerPoolId) continue;
    const qs = queueStore.getPrinterState(p.id);
    if (qs.queueState === "idle" && !qs.queuePaused && !qs.queueStopped && qs.queue.length) {
      attemptQueueDispatch(p.id).catch(e => console.error("[queue] dispatch sweep error:", e.message));
    }
  }
}, QUEUE_SWEEP_MS).unref();

app.get("/api/fleet", requireAuth, async (req, res) => {
  // ?printer=N probes just that printer — the splash screen uses this to show
  // per-printer connect progress. No param = the whole fleet (normal polling).
  if (req.query.printer !== undefined) {
    const i = parseInt(req.query.printer, 10);
    const p = PRINTERS[i];
    // A printer outside the caller's groups reports the exact same "Unknown
    // printer" shape as a genuinely-missing index — its existence isn't
    // leaked to a user who can't see it.
    if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
    const conn = getConnector(p.connector);
    return res.json({ id: i, url: p.url, brand: p.brand || "SnapMaker", tags: p.tags || [], capabilities: getCapabilities(p.connector, p), ...webrtcCameraFields(p, conn), colorPalette: conn.colorPalette, autoLevel: !!p.autoLevel, flowCalibrate: !!p.flowCalibrate, timelapse: !!p.timelapse, forceDefaults: p.forceDefaults !== false, ...(await probeCached(p)) });
  }
  const out = await Promise.all(PRINTERS.map(async (p, i) => {
    if (!printerVisibleTo(req.user, p)) return null;
    const conn = getConnector(p.connector);
    // autoLevel/flowCalibrate/timelapse: not secrets (unlike token/
    // verificationCode) — exposed here so the per-print options checkboxes
    // (pfilemodal) can default to this printer's existing preferences for
    // every role, not just Admin (who already sees them via /api/config's
    // printers[]).
    const row = { id: i, url: p.url, brand: p.brand || "SnapMaker", tags: p.tags || [], capabilities: getCapabilities(p.connector, p), ...webrtcCameraFields(p, conn), colorPalette: conn.colorPalette, autoLevel: !!p.autoLevel, flowCalibrate: !!p.flowCalibrate, timelapse: !!p.timelapse, forceDefaults: p.forceDefaults !== false, ...(await probeCached(p)) };
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
    // Lightweight enough for every fleet-card poll — the full queue (files,
    // history, dispatch snapshots) is only ever fetched on demand via
    // GET /api/queue/:printerId, not repeated here on every 2s tick.
    let queueAttention = false;
    if (p.printerPoolId) {
      const qs = queueStore.getPrinterState(p.id);
      queueAttention = qs.queueState === "queue_attention_required";
      row.queueSummary = { queueState: qs.queueState, pendingCount: qs.queue.length, requiresAttention: queueAttention, paused: qs.queuePaused, stopped: qs.queueStopped };
    }
    // Cheap, fleet-wide attention flag for the Health topbar badge — only
    // ever data already in memory (maintenance schedule + queue state), no
    // new I/O. Deliberately does NOT reach into per-printer Health
    // diagnostics (throttling/disk/faults) — that richer picture only
    // exists once a printer's own Health page has actually been opened and
    // fetched; see /api/health.
    const attentionReasons = computeMaintenanceAttention(p);
    if (queueAttention) {
      // The queue store already knows WHY it stopped (file-missing,
      // file-changed, …) and often has the offending filename — passing the
      // generic "waiting on a human" line instead left the Health page
      // unable to say anything useful about a printer its own badge counted.
      const qs = queueStore.getPrinterState(p.id);
      const why = qs.attentionDetail && qs.attentionDetail.message;
      attentionReasons.push({
        severity: "critical", title: "Queue needs attention",
        detail: why || "Queue dispatch is waiting on a human (bed clear, resolve, etc.)",
        code: "queue-attention", reason: qs.attentionReason || null, message: why || null
      });
    }
    if (attentionReasons.length) { row.needsAttention = true; row.attentionReasons = attentionReasons; }
    return row;
  }));
  res.json(out.filter(Boolean));
});

// NOT a sufficient authentication boundary on its own (see CODE_AUDIT.md
// P0-3): once Remote Access is enabled, cloudflared runs as a local child
// process forwarding tunnel traffic to http://localhost:<port> (snapcon-api
// hardcodes this as every Hub's ingress target), so a request that arrived
// over the public tunnel is indistinguishable from a genuinely local one at
// this level — req.socket.remoteAddress reflects the immediate TCP peer,
// not the original public client. /api/notify-load's file-path branch below
// pairs this with a real local-possession credential (notifyToken.js) as
// the actual authentication boundary; this check is kept only as
// additional, cheap defense-in-depth (it still blocks an ordinary LAN
// caller who's obtained the token from using this over the network).
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
    if (idx === -1 || !printerVisibleTo(req.user, PRINTERS[idx])) return res.status(400).json({ error: "Unknown printer: " + printer });
    const p = PRINTERS[idx];
    if (refuseMonitorOnly(p, res)) return;
    const name = outputname || path.basename(filename || "upload.gcode");
    fs.mkdirSync(NOTIFY_TMP_DIR, { recursive: true });
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const tmpFile = path.join(NOTIFY_TMP_DIR, "push-" + Date.now() + "-" + Math.random().toString(16).slice(2) + "-" + safeName);
    fs.writeFileSync(tmpFile, req.body);

    const actor = actorFromReq(req);
    if (!(await isPrinterIdle(p))) {
      pendingLoad.set(idx, { file: tmpFile, name, ts: Date.now(), cleanup: true, actor });
      return res.json({ ok: true, mode: "pending", printer: p.name });
    }
    uploadNotifiedFile(idx, { file: tmpFile, name, cleanup: true, actor });
    return res.json({ ok: true, mode: "queued", printer: p.name });
  }

  // isLoopback() is defense-in-depth only, not the real boundary — see its
  // own comment and notifyToken.js. NOTIFY_TOKEN === null means the server
  // could never durably persist a token (logged loudly at startup); fail
  // closed rather than accept any header value or silently trust loopback
  // alone in that state.
  if (!isLoopback(req)) return res.status(403).json({ error: "localhost only" });
  if (!NOTIFY_TOKEN) return res.status(503).json({ error: "Local file-path notify is unavailable — SnapCon could not establish a local notify token. Check server logs." });
  if (!timingSafeTokenEqual(req.headers["x-snapcon-local-token"], NOTIFY_TOKEN)) return res.status(403).json({ error: "localhost only" });
  const { file, printer, outputname } = req.body || {};
  if (!file || typeof file !== "string") return res.status(400).json({ error: "file required" });
  if (!printer) return res.status(400).json({ error: "printer required" });
  if (outputname && /["\r\n/\\]/.test(outputname)) return res.status(400).json({ error: "Bad output name" });
  const absFile = path.resolve(file);
  if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) return res.status(404).json({ error: "File not found: " + absFile });
  const idx = findPrinterIndex(printer);
  if (idx === -1) return res.status(400).json({ error: "Unknown printer: " + printer });
  const p = PRINTERS[idx];
  if (refuseMonitorOnly(p, res)) return;
  // outputname is used exactly as given — it's what the file is uploaded and
  // displayed as. The file actually read off disk is always absFile.
  const name = outputname ? outputname.trim() : path.basename(absFile);

  // Same-machine CLI call (--load, no --snapcon) — no browser session exists
  // to attribute this to, so it's labeled as coming from the CLI itself.
  const actor = { userId: null, userLabel: "CLI" };
  if (!(await isPrinterIdle(p))) {
    pendingLoad.set(idx, { file: absFile, name, ts: Date.now(), actor });
    return res.json({ ok: true, mode: "pending", printer: p.name });
  }

  uploadNotifiedFile(idx, { file: absFile, name, actor });
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
  if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
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

// ---- Live camera as a fragmented-MP4 byte stream ----
// For connectors whose camera is a video stream the browser cannot open
// itself (Bambu Lab: RTSPS). The connector relays it (one upstream session per
// printer, shared by every viewer) and this route hands one viewer its copy.
// The page plays it through Media Source Extensions; X-SnapCon-Codec tells it
// which SourceBuffer to create before the first byte arrives. The response
// never ends on its own — it stops when the viewer goes away or the camera
// does. A viewer that falls far behind is dropped by the relay instead of
// buffering the printer's video in SnapCon's memory.
app.get("/api/camera-stream", requireAuth, async (req, res) => {
  const p = PRINTERS[parseInt(req.query.printer, 10)];
  if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
  const c = getConnector(p.connector);
  if (!c.openCameraStream || !getCapabilities(p.connector, p).cameraStream) return res.status(400).json({ error: p.name + " has no live camera stream" });
  let sub = null, ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    if (sub) sub.unsubscribe();
    if (!res.writableEnded) res.end();
  };
  const headersFor = (codec) => ({
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-SnapCon-Codec": codec || ""
  });
  let pendingWrites = [];
  const viewer = {
    // Bytes can arrive (init segment + buffered GOP) before openCameraStream
    // resolves with the codec for the headers — hold them until then.
    write: (buf) => { if (ended) return; if (pendingWrites) pendingWrites.push(buf); else res.write(buf); },
    end: () => finish(),
    backlog: () => res.writableLength || 0
  };
  req.on("close", finish);
  try {
    sub = await c.openCameraStream(p, viewer);
  } catch (e) {
    pendingWrites = null;
    if (!ended) res.status(e.status || 502).json({ error: e.message });
    ended = true;
    return;
  }
  if (ended) { sub.unsubscribe(); return; }
  res.writeHead(200, headersFor(sub.codec));
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const queued = pendingWrites; pendingWrites = null;
  for (const b of queued) res.write(b);
});

// ---- Thumbnail proxy: fetch gcode thumbnail from Moonraker ----
app.get("/api/thumbnail", requireAuth, async (req, res) => {
  const p = PRINTERS[req.query.printer];
  if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
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
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  if (refuseMonitorOnly(p, res)) return;
  if (!Array.isArray(extruders) || !extruders.length) return res.status(400).json({ error: "No extruders specified" });
  const c = getConnector(p.connector);
  if (!c.unloadFilament) return res.status(400).json({ error: p.name + " does not support filament unload" });
  try {
    await c.unloadFilament(p, extruders);
    auditLog.log({ category: "job", event: "unload-filament", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { extruders } });
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
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  if (refuseMonitorOnly(p, res)) return;
  if (typeof extruder !== "number" || extruder < 0) return res.status(400).json({ error: "Invalid extruder" });
  if (!/^#[0-9a-fA-F]{6}$/.test(String(hex || ""))) return res.status(400).json({ error: "Invalid color" });
  const c = getConnector(p.connector);
  if (!c.setFilamentColor) return res.status(400).json({ error: p.name + " does not support setting filament color" });
  try {
    // May differ from the requested hex (e.g. AD5X snaps to its touchscreen's
    // fixed color palette) — the client shows this back to the user rather
    // than assuming its own request was applied verbatim.
    const applied = await c.setFilamentColor(p, extruder, hex);
    auditLog.log({ category: "job", event: "filament-color-set", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { extruder, hex: applied || hex } });
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
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  if (refuseMonitorOnly(p, res)) return;
  const t = Number(temp);
  if (!Number.isFinite(t) || t < 0 || t > 120) return res.status(400).json({ error: "Temp must be 0–120 °C" });
  try {
    await getConnector(p.connector).bedTemp(p, t);
    auditLog.log({ category: "job", event: "bedtemp-set", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { target: Math.round(t) } });
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
  if (!c.getFirmwareInfo) return { name: p.name, online: true, skipped: true, reason: "not supported", reasonCode: "not_supported" };
  const st = await probeCached(p);
  return c.getFirmwareInfo(p, st);
}

app.get("/api/firmware", requireAuth, async (req, res) => {
  // ?printer=<index> reads ONE printer, the same shape /api/fleet?printer=i
  // uses. The Firmware tab calls it after a deploy finishes so a single row
  // can be refreshed in place — re-reading the whole fleet would rebuild every
  // row and throw away the selection and the progress bars on screen.
  if (req.query.printer !== undefined) {
    const idx = parseInt(req.query.printer, 10);
    const p = PRINTERS[idx];
    if (!p || !printerVisibleTo(req.user, p)) return res.status(404).json({ error: "Unknown printer" });
    const one = await probeFirmware(p);
    return res.json({
      id: idx,
      // The STABLE identity, additive to the index the rest of the tab is keyed
      // on. Deploy sends this back so a Settings reorder between rendering this
      // list and pressing Deploy cannot retarget the flash — see
      // firmwareTargetFor().
      pid: p.id,
      connector: p.connector,
      uniformMcuVersions: getCapabilities(p.connector, p).uniformMcuVersions === true,
      ...one,
    });
  }
  const visible = PRINTERS.map((p, i) => ({ p, i })).filter(({ p }) => printerVisibleTo(req.user, p));
  // `connector` is the printer's real connector id, not something inferred
  // from its brand or model text — the Firmware tab filters on it, and a
  // brand string is user-editable on generic Klipper.
  //
  // `uniformMcuVersions` travels per row because it decides whether a board
  // reporting a different version is a fault worth flagging or just a
  // separate component. Sent even on skipped rows so the filter still works
  // on a printer whose version could not be read.
  const out = await Promise.all(visible.map(({ p, i }) => probeFirmware(p).then(r => ({
    id: i,
    pid: p.id,
    connector: p.connector,
    uniformMcuVersions: getCapabilities(p.connector, p).uniformMcuVersions === true,
    ...r,
  }))));
  res.json(out);
});

// ---- Health diagnostics: single-printer, on-demand only (the Health page
// has no auto-polling — every request here is a real "give me fresh data
// right now", so this is deliberately uncached, same as /api/firmware
// above; no probeCached-style wrapper exists for anything but probe()
// itself). Sectioned response (system/mcus/heaters/storage/history/faults)
// — see connectors/http-utils.js's queryHealth for why each section is
// independently isolated against failure. ----
// Critical disk threshold: <5% free OR <2GB free, whichever triggers first
// — the only threshold defined for Phase 1 (a separate warning-level
// threshold is left for later rather than guessed now).
const DISK_CRITICAL_PCT = 0.05;
const DISK_CRITICAL_BYTES = 2 * 1024 * 1024 * 1024;
// The richer, per-printer half of the two-tier attention design (see
// computeMaintenanceAttention above for the cheap fleet-wide half this
// extends) — only ever computed against a health object that's already
// been fetched for this one printer, never triggered fleet-wide. MCU
// retransmit/invalid-byte counters are deliberately NOT a trigger here:
// they're cumulative-since-boot with no defensible threshold or "recent
// increase" detection built, so surfacing them as attention items would be
// exactly the false-confidence failure mode this design avoids — they stay
// diagnostics-only (still visible in health.mcus) until real trend-based
// alerting exists.
// "Commanded but not spinning" only becomes an attention signal once it's
// been observed on two checks in a row — Health has no continuous polling
// to time a startup-transient delay against, so persistence across separate
// manual checks is the only signal available. First observation just
// records itself and does not flag (covers a normal spin-up transient
// landing on the one check that happens to sample it); only a mismatch
// still present on a LATER check flags. A check that finds the fan fine
// clears the record immediately, so recovery resets the count right away.
const fanMismatchSeen = new Map(); // "printerId|fanName" -> true (mismatched last check)
const FAN_COMMANDED_THRESHOLD = 0.1; // speed above this = "meaningfully commanded on"
const FAN_STOPPED_RPM_THRESHOLD = 50; // rpm below this while commanded = "not spinning"
function checkFanMismatch(p, health) {
  const reasons = [];
  const fans = (health.fans && health.fans.available) ? health.fans.list : [];
  for (const f of fans) {
    const key = p.id + "|" + f.name;
    // rpm===null means no tachometer wired (confirmed real on this fleet) —
    // "not measurable", never treated as "stopped".
    const measurable = typeof f.rpm === "number";
    const commanded = typeof f.speed === "number" && f.speed > FAN_COMMANDED_THRESHOLD;
    const mismatched = measurable && commanded && f.rpm < FAN_STOPPED_RPM_THRESHOLD;
    if (mismatched) {
      if (fanMismatchSeen.get(key)) {
        // code/name/rpm are additive — title/detail stay as the existing
        // English prose for any consumer that isn't the (now code-aware)
        // client renderer; the client translates from code+params instead
        // of parsing this English sentence back apart.
        reasons.push({ severity: "warning", title: "Fan not spinning", detail: `${f.name} is commanded on but reporting ${Math.round(f.rpm)} RPM.`, suggestedComponent: "Fans", code: "fan-not-spinning", name: f.name, rpm: Math.round(f.rpm) });
      } else {
        fanMismatchSeen.set(key, true);
      }
    } else {
      fanMismatchSeen.delete(key);
    }
  }
  return reasons;
}
// Heater duty is only a trustworthy signal once a reading has held near
// target for a little while — a heater ramping up legitimately sits at
// ~100% duty, and a head cooling down from a previous job reports a real
// power number that has nothing to do with health (confirmed live:
// "extruder 118° / 65° target · power 0%" is just a cooling head, not a
// fault). Band and dwell below are starting points, same "unvalidated
// against real degraded hardware" caveat as every other threshold on this
// page: within 3°C of target counts as "at target," and it has to stay
// there for 30 real (wall-clock) seconds before duty is trusted enough to
// color-judge. A wall-clock dwell is the only way to time this at all given
// Health's manual-refresh-only cadence — tracked per printer+heater across
// refreshes in a session-lifetime Map (same pattern as fanMismatchSeen
// below). Any observation that drops back out of band clears the timer, so
// a heater has to re-earn the dwell after every overshoot/undershoot.
// Duty-threshold coloring itself (warn/crit %) stays client-side in app.js,
// matching how MCU/fan thresholds are applied — this function only decides
// which of idle/heating/cooling/settling/stable a reading is in, since only
// that classification needs cross-request memory.
const HEATER_TARGET_BAND_C = 3;
const HEATER_DWELL_MS = 30000;
const heaterStableSince = new Map(); // "printerId|heaterName" -> ms timestamp first seen in-band
function annotateHeaterStates(p, health) {
  if (!health.heaters || !health.heaters.available) return;
  const now = Date.now();
  for (const h of health.heaters.list) {
    const key = p.id + "|" + h.name;
    if (!h.target) { h.state = "idle"; heaterStableSince.delete(key); continue; }
    const inBand = h.temperature != null && Math.abs(h.temperature - h.target) <= HEATER_TARGET_BAND_C;
    if (!inBand) {
      h.state = (h.temperature != null && h.temperature < h.target) ? "heating" : "cooling";
      heaterStableSince.delete(key);
      continue;
    }
    let since = heaterStableSince.get(key);
    if (!since) { since = now; heaterStableSince.set(key, since); }
    h.state = (now - since >= HEATER_DWELL_MS) ? "stable" : "settling";
  }
}
// "Unused" is defined entirely by the G-code sync retention setting — if
// gcodeSyncRetentionDays isn't configured, there's no threshold to judge by,
// so this stays undefined and the client simply doesn't show a count rather
// than inventing a default window. Cross-references the gcodes file listing
// (already fetched by the storage section) against print history filtered
// to that same window — confirmed live that history's `filename` field is
// the exact same string as the file listing's `path`, and that Moonraker's
// own `since=` filtering keeps this cheap regardless of the printer's full
// history depth. `fileNames` is deleted from the response afterward — the
// client only ever needs the final count, not the raw list.
async function annotateGcodeUnusedCount(p, health) {
  const gcodes = health.storage && health.storage.available && health.storage.categories && health.storage.categories.gcodes;
  if (!gcodes || !CFG.gcodeSyncRetentionDays || !Array.isArray(gcodes.fileNames)) return;
  try {
    const base = connHttp.baseUrl(p);
    const sinceSec = Date.now() / 1000 - CFG.gcodeSyncRetentionDays * 86400;
    const recent = await connHttp.queryRecentlyPrintedFiles(base, sinceSec);
    gcodes.unusedCount = gcodes.fileNames.filter(name => !recent.has(name)).length;
    gcodes.unusedThresholdDays = CFG.gcodeSyncRetentionDays;
  } catch (e) {
    // Best-effort — leave unusedCount undefined, the client just won't show it.
  } finally {
    delete gcodes.fileNames;
  }
}
function computeHealthAttention(p, health) {
  const reasons = computeMaintenanceAttention(p);
  if (health.system && health.system.available && health.system.throttledState) {
    // {bits, flags:[...]} is the real Moonraker shape (confirmed via source/
    // docs research — it was never observed non-null live, since this
    // fleet's U1 hardware isn't the Raspberry Pi this check is built for).
    // A non-array flags falls through to the old generic behavior, so an
    // unexpected shape degrades safely rather than silently saying nothing.
    const flags = Array.isArray(health.system.throttledState.flags) ? health.system.throttledState.flags : [];
    if (flags.includes("Under-Voltage Detected")) {
      reasons.push({ severity: "critical", title: "Undervoltage", detail: "The printer's controller is reporting a power under-voltage condition right now.", suggestedComponent: "Power Supply", code: "undervoltage" });
    } else {
      reasons.push({ severity: "critical", title: "Throttled", detail: "The printer's controller is reporting a throttle condition (power or thermal) right now.", code: "throttled" });
    }
  }
  if (health.storage && health.storage.available) {
    const du = health.storage.diskUsage;
    if (du && (du.free < du.total * DISK_CRITICAL_PCT || du.free < DISK_CRITICAL_BYTES)) {
      reasons.push({ severity: "critical", title: "Low disk space", detail: "Uploads can fail confusingly once the disk fills — free up space soon.", code: "low-disk-space" });
    }
  }
  if (health.faults && health.faults.available && health.faults.list.length) {
    reasons.push({ severity: "warning", title: "Recent fault", detail: "The printer has reported at least one recent error — see the fault log.", code: "recent-fault" });
  }
  reasons.push(...checkFanMismatch(p, health));
  return reasons;
}
app.get("/api/health", requireAuth, async (req, res) => {
  const idx = parseInt(req.query.printer, 10);
  const p = PRINTERS[idx];
  if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
  const c = getConnector(p.connector);
  if (!c.getHealth) return res.json({ id: p.id, name: p.name, online: true, skipped: true, reason: "not supported" });
  const st = await probeCached(p);
  const health = await c.getHealth(p, st);
  if (!health.skipped) annotateHeaterStates(p, health);
  if (!health.skipped) await annotateGcodeUnusedCount(p, health);
  const attentionReasons = health.skipped ? [] : computeHealthAttention(p, health);
  res.json({
    id: p.id, name: p.name, ...health,
    ...(attentionReasons.length ? { needsAttention: true, attentionReasons } : {}),
    // Lets the Storage card decide whether Sync logs/Sync camera can be
    // enabled at all, without a separate /api/config round-trip.
    syncFolders: { logs: !!CFG.logsFolder, camera: !!CFG.cameraFolder, gcodes: !!CFG.gcodeSyncFolder },
    syncSupported: !!c.querySyncFiles
  });
});

// ---- Logs/Camera/G-code sync: fire-and-forget trigger + pollable status.
// The route returns as soon as the sync is STARTED, not when it finishes —
// the Health page polls GET /api/sync-status while phase isn't
// "idle"/"error", same reasoning as Health's own "no auto-polling except
// while something the user actually started is running" carve-out. ----
function syncRootConfig(root) {
  if (root === "logs") return { folder: CFG.logsFolder, retentionDays: CFG.logsRetentionDays, label: "Logs" };
  if (root === "camera") return { folder: CFG.cameraFolder, retentionDays: CFG.cameraRetentionDays, label: "Camera" };
  if (root === "gcodes") return { folder: CFG.gcodeSyncFolder, retentionDays: CFG.gcodeSyncRetentionDays, label: "Synced g-code" };
  return null;
}
app.post("/api/sync", requireAdmin, async (req, res) => {
  const idx = parseInt(req.query.printer, 10);
  const p = PRINTERS[idx];
  if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
  const root = String(req.query.root || "");
  const rootCfg = syncRootConfig(root);
  if (!rootCfg) return res.status(400).json({ error: "root must be 'logs', 'camera', or 'gcodes'" });
  const destFolder = rootCfg.folder;
  if (!destFolder) return res.status(400).json({ error: `Configure a ${rootCfg.label} folder in Settings first` });
  const c = getConnector(p.connector);
  if (!c.querySyncFiles) return res.status(400).json({ error: "This printer's connector doesn't support file sync" });
  if (syncEngine.isRunning(p.id, root)) return res.status(409).json({ error: "A sync is already running for this printer" });
  const retentionDays = rootCfg.retentionDays;
  const resolvedDest = path.resolve(BASE_DIR, destFolder);
  syncEngine.runSync(p, root, resolvedDest, retentionDays)
    .then(summary => {
      auditLog.log({
        category: "sync", event: "sync-completed", ...actorFromReq(req),
        printerId: p.id, printerName: p.name,
        detail: { root, ...summary }
      });
    })
    .catch(e => {
      auditLog.log({
        category: "sync", event: "sync-failed", ...actorFromReq(req),
        printerId: p.id, printerName: p.name,
        detail: { root, error: e.message }
      });
    });
  res.json({ ok: true, started: true });
});

app.get("/api/sync-status", requireAdmin, (req, res) => {
  const idx = parseInt(req.query.printer, 10);
  const p = PRINTERS[idx];
  if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
  const root = String(req.query.root || "");
  if (!syncRootConfig(root)) return res.status(400).json({ error: "root must be 'logs', 'camera', or 'gcodes'" });
  res.json(syncEngine.getStatus(p.id, root));
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
  const visible = PRINTERS.map((p, i) => ({ p, i })).filter(({ p }) => printerVisibleTo(req.user, p));
  const out = await Promise.all(visible.map(({ p, i }) => {
    const c = getConnector(p.connector);
    return c.getInventory ? c.getInventory(p).then(r => ({ id: i, ...r })) : Promise.resolve({ id: i, name: p.name, online: null, skipped: true, reason: "not supported" });
  }));
  res.json(out);
});

// ---- Printer hours: proxy Moonraker history/totals ----
app.get("/api/printer-hours", requireAuth, async (req, res) => {
  const p = PRINTERS[req.query.printer];
  if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
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
const DEFAULT_MAINT_COMPONENTS = ["Nozzle", "Timing Belt", "Bed Sheet", "Hotend", "PTFE Tube", "Extruder Gears", "Lead Screw", "Fans", "Lubrication", "Firmware", "Wiper", "Power Supply"];
// "date" entries compute nextScheduled the normal calendar way. hours250/500
// are intentionally NOT date-computable (computeNextScheduled returns null
// for them) — there's no stored per-printer hours history to compare a
// threshold against yet, and nothing background-watches maintenance due
// dates at all (unlike the print-event notifier). The client keeps these two
// disabled in the picker until that's built; this table just reserves their
// keys so a future implementation has one place to add the real logic.
const MAINT_FREQ_SPEC = {
  none: null,
  weekly: { unit: "days", amount: 7 },
  monthly: { unit: "months", amount: 1 },
  quarterly: { unit: "months", amount: 3 },
  hours250: { unit: "hours", amount: 250 },
  hours500: { unit: "hours", amount: 500 }
};
// CFG.maintenanceComponents starts out undefined on any pre-existing config —
// this is the same "compute the default at read time, only persist once
// something actually changes" convention used elsewhere (e.g. refreshInterval).
const maintComponents = () => Array.isArray(CFG.maintenanceComponents) ? CFG.maintenanceComponents : DEFAULT_MAINT_COMPONENTS.slice();
function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function addMonths(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00");
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}
// null for "none" (no reminder wanted) and for the not-yet-computable
// hours-based options — computeNextMaintenance already skips entries with no
// nextScheduled, so both cases simply don't produce a due date.
function computeNextScheduled(dateStr, freqKey) {
  const spec = MAINT_FREQ_SPEC[freqKey];
  if (!spec) return null;
  if (spec.unit === "days") return addDays(dateStr, spec.amount);
  if (spec.unit === "months") return addMonths(dateStr, spec.amount);
  return null;
}
// Returns a status ("unknown"/"active"/"expiring"/"expired") + the expiry
// date itself, rather than a bare boolean — the client needs both to decide
// which of "Unknown" / "Expires <date>" / "Expired" to show, and whether
// that deserves the warning color (expired, or expiring within 30 days).
function computeWarranty(purchaseDate) {
  if (!purchaseDate) return { status: "unknown", expiry: null };
  const expiry = new Date(purchaseDate + "T00:00:00");
  expiry.setMonth(expiry.getMonth() + 12);
  const expiryStr = expiry.toISOString().slice(0, 10);
  const daysLeft = Math.floor((expiry.getTime() - Date.now()) / 86400000);
  const status = daysLeft < 0 ? "expired" : daysLeft <= 30 ? "expiring" : "active";
  return { status, expiry: expiryStr };
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
// The cheap half of the two-tier attention design (see /api/fleet's use of
// this, and /api/health for the richer per-printer half) — maintenance data
// only, already in memory, safe to run on every fleet poll for every
// printer with no new I/O.
function computeMaintenanceAttention(p) {
  const entries = (CFG.maintenanceHistory && CFG.maintenanceHistory[p.id]) || [];
  const next = computeNextMaintenance(entries);
  if (!next) return [];
  const daysUntil = Math.floor((new Date(next.date + "T00:00:00").getTime() - Date.now()) / 86400000);
  if (daysUntil < 0) return [{ severity: "critical", title: "Maintenance overdue", detail: `${next.component} was due ${next.date}`, code: "maintenance-overdue", component: next.component, date: next.date }];
  if (daysUntil <= 14) return [{ severity: "warning", title: "Maintenance due soon", detail: `${next.component} due ${next.date}`, code: "maintenance-due-soon", component: next.component, date: next.date }];
  return [];
}

app.get("/api/maintenance", requireAuth, (req, res) => {
  const idx = parseInt(req.query.printer, 10);
  const p = PRINTERS[idx];
  if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
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
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  if (!entry || !entry.date) return res.status(400).json({ error: "Missing date" });
  if (!CFG.maintenanceHistory || typeof CFG.maintenanceHistory !== "object") CFG.maintenanceHistory = {};
  if (!Array.isArray(CFG.maintenanceHistory[p.id])) CFG.maintenanceHistory[p.id] = [];
  const entries = CFG.maintenanceHistory[p.id];
  const frequency = Object.prototype.hasOwnProperty.call(MAINT_FREQ_SPEC, entry.frequency) ? entry.frequency : "monthly";
  const component = String(entry.component || "").trim();
  entries.push({
    date: String(entry.date),
    comment: String(entry.comment || ""),
    part: String(entry.part || ""),
    hours: String(entry.hours || "—"),
    totalSeconds: entry.totalSeconds != null ? Number(entry.totalSeconds) : null,
    component,
    frequency,
    nextScheduled: computeNextScheduled(entry.date, frequency),
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
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
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
    logsFolder: CFG.logsFolder || "",
    cameraFolder: CFG.cameraFolder || "",
    firmwareFolder: CFG.firmwareFolder || "",
    // Both default ON when unset, so an install that predates them gets the
    // safe behaviour rather than the fast one.
    firmwareSkipCurrent: CFG.firmwareSkipCurrent !== false,
    firmwareVerify: CFG.firmwareVerify !== false,
    gcodeSyncFolder: CFG.gcodeSyncFolder || "",
    logsRetentionDays: CFG.logsRetentionDays || null,
    cameraRetentionDays: CFG.cameraRetentionDays || null,
    gcodeSyncRetentionDays: CFG.gcodeSyncRetentionDays || null,
    refreshInterval: CFG.refreshInterval || 2,
    cameraViewRefreshInterval: CFG.cameraViewRefreshInterval || 6,
    cameraViewStagger: CFG.cameraViewStagger !== false,
    alternateDisplay: CFG.alternateDisplay || "all",
    filamentCost: CFG.filamentCost || null,
    electricityRate: CFG.electricityRate || null,
    currency: CFG.currency || "$",
    tNotation: CFG.tNotation || false,
    defaultView: CFG.defaultView || "regular",
    siteName: CFG.siteName || "",
    allowMapping: CFG.allowMapping !== false,
    suggestMatching: CFG.suggestMatching !== false,
    usersEnabled: !!CFG.usersEnabled,
    configured: PRINTERS.length > 0,
    locale: CFG.locale || "en"
  };
  if (role !== "admin") return base;
  return {
    ...base,
    isDocker: IS_DOCKER,
    // telegramBotToken never round-trips to the browser, same treatment as
    // the Resend API key below — a bot token is a real secret (anyone who
    // has it can send messages as your bot).
    notifications: CFG.notifications
      ? { ...CFG.notifications, telegramBotToken: undefined, hasTelegramBotToken: !!CFG.notifications.telegramBotToken,
          // The webhook URL is itself the credential — a Discord webhook URL
          // embeds a token granting posting rights to that channel — so it gets
          // the same never-round-trip treatment as the bot token above.
          webhookUrl: undefined, hasWebhookUrl: !!CFG.notifications.webhookUrl }
      : null,
    // The Moonraker API token is a real secret too — same treatment as
    // telegramBotToken above, replacing the old "send it in plaintext, mask
    // it visually client-side" behavior. hasToken tells the UI whether to
    // show the "Configured" state; the value itself never leaves the server
    // unless it's actively being replaced (see POST /api/config below).
    printers: PRINTERS.map(p => ({ ...p, token: undefined, hasToken: !!p.token })),
    // The Resend API key never round-trips to the browser, even for Admin —
    // unlike printer tokens (which do, into a masked <input>), this secret
    // gets the stricter treatment since leaking it is exactly what this
    // feature is partly meant to close off.
    resend: { fromAddress: (CFG.resend && CFG.resend.fromAddress) || "", hasApiKey: !!(CFG.resend && CFG.resend.apiKey) },
    otp: {
      service: (CFG.otp && CFG.otp.service) || "resend",
      ntfyTopic: (CFG.otp && CFG.otp.ntfyTopic) || "",
      telegramChatId: (CFG.otp && CFG.otp.telegramChatId) || "",
      // OTP-via-Telegram reuses the bot configured under Notifications —
      // a bot token is a service credential (like the Resend API key),
      // not a per-purpose secret, so there's no reason to make an admin
      // stand up a second bot just for login codes.
      telegramBotConfigured: !!(CFG.notifications && CFG.notifications.telegramBotToken)
    },
    auditRetentionDays: CFG.auditRetentionDays || 90,
    auditAvailable: auditLog.isAvailable(),
    configLoadFailed: CONFIG_LOAD_FAILED,
    configLoadQuarantinePath: CONFIG_LOAD_QUARANTINE_PATH
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
  if (!security.allowed) return res.status(400).json({ ok: false, error: security.reason, code: security.code });
  // The rest (provisioning, download, process start) can take a while — the
  // client polls /api/remote-access/status rather than this request hanging.
  res.json({ ok: true, pending: true });
  const actor = actorFromReq(req);
  remoteAccess.enable()
    .then(() => auditLog.log({ category: "admin", event: "remote-access-enabled", ...actor }))
    .catch(e => console.error("[remote-access] enable failed:", e.message));
});
app.post("/api/remote-access/disable", requireAdmin, (req, res) => {
  res.json({ ok: true, pending: true });
  const actor = actorFromReq(req);
  remoteAccess.disable()
    .then(() => auditLog.log({ category: "admin", event: "remote-access-disabled", ...actor }))
    .catch(e => console.error("[remote-access] disable failed:", e.message));
});
app.post("/api/remote-access/remove", requireAdmin, (req, res) => {
  res.json({ ok: true, pending: true });
  const actor = actorFromReq(req);
  remoteAccess.removeRemoteAccess()
    .then(() => auditLog.log({ category: "admin", event: "remote-access-removed", ...actor }))
    .catch(e => console.error("[remote-access] remove failed:", e.message));
});
// Diagnostics: re-runs the connection chain from the top. requireAdmin, same
// as every other action on this feature — errors surface via the normal
// status poll, same "fire and let the client poll" shape as enable/disable.
app.post("/api/remote-access/restart", requireAdmin, async (req, res) => {
  const r = await remoteAccess.restart();
  if (!r.ok) return res.status(400).json(r);
  auditLog.log({ category: "admin", event: "remote-access-restarted", ...actorFromReq(req) });
  res.json(r);
});
app.get("/api/remote-access/log", requireAdmin, (req, res) => res.json({ lines: remoteAccess.getLog() }));
// No requireAuth: body/headers are fixed and carry zero identifying or
// operational information — see remote-access plan, "Public endpoint probe."
app.get("/api/remote-access/probe", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true });
});

// The one connector whose Brand a client may set (see buildPrinterRecord).
const BRAND_EDITABLE_CONNECTOR = "klipper-moonraker";
const BRAND_MAX_LENGTH = 30;
// Brand is printer-supplied text that ends up in fleet rows, the list view,
// and modal titles — the frontend escapes it at every sink, this trims it to
// a sane length and drops control characters at the boundary as well.
function sanitizeBrand(value) {
  if (typeof value !== "string") return "";
  const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
  return value.replace(CONTROL_CHARS, "").trim().slice(0, BRAND_MAX_LENGTH);
}

// Probes for a WebRTC camera, but only on a model confirmed to have one —
// the i7 today. Every other Creality would just spend the probe's timeout
// discovering that nothing is listening on its port 8000, on every save.
// A model that could not be identified is probed anyway: an unknown machine
// is more likely to be a model this table has not met than a known one.
// Its own try/catch, so an unreachable service can never throw past a
// snapshot URL that was just confirmed.
async function detectCrealityWebrtcCamera(conn, o) {
  if (typeof conn.detectCameraWebrtc !== "function") return;
  if (o.modelCode && !conn.modelHasWebrtcCamera(o.modelCode)) { o.cameraWebrtcChecked = true; return; }
  try {
    if (await conn.detectCameraWebrtc(o)) o.cameraWebrtc = true;
    o.cameraWebrtcChecked = true;
  } catch { /* unreachable right now — retried on a later save */ }
}

// Turns whatever a caller submitted into the one address shape SnapCon
// stores: the ip/port the user configures plus the canonical `url` every
// connector's baseUrl() reads. The connector owns the rules (scheme,
// default port, whether a port is configurable, whether an address is
// needed at all) — see connectors/index.js's getAddress().
//
// Both directions are accepted and converge on the same record: a browser
// row sends ip/port, while an older API client (or the discovery flow)
// sends a plain url and gets its parts derived from it. Idempotent, so
// running it again on an already-resolved printer changes nothing.
// A url it cannot take apart is passed through untouched rather than
// blanked — that value is the only address the printer has.
function resolvePrinterAddress(p) {
  const connector = CONNECTOR_TYPES.includes(p.connector) ? p.connector : DEFAULT_CONNECTOR_TYPE;
  const spec = getAddress(connector);
  const url = String(p.url == null ? "" : p.url).trim();
  // Connectors with no hardware to reach (the simulator) keep whatever
  // synthetic url they were given and get no address fields.
  if (!spec.required) return { url };
  const ip = String(p.ip == null ? "" : p.ip).trim();
  const addr = isValidHost(ip)
    ? { host: ip, port: p.port, scheme: p.scheme }
    : parseAddressUrl(url);
  if (!addr || !isValidHost(addr.host)) return { url };
  // Only the two schemes SnapCon actually speaks are honored from client
  // input; anything else falls back to the connector's own.
  const scheme = ["http", "https"].includes(addr.scheme) ? addr.scheme : spec.scheme;
  const port = normalizePort(addr.port);
  const out = { url: composeAddressUrl({ scheme, host: addr.host, port }, spec), ip: addr.host };
  if (port) out.port = port;
  if (scheme !== spec.scheme) out.scheme = scheme;
  return out;
}
// Creality-only camera auto-detect (see that connector's detectCamera):
// runs once per printer, at save time — either on a brand-new printer or
// whenever its URL changes (could be a different physical unit) — not on
// every single settings save, so editing an unrelated field doesn't re-probe
// every Creality printer's network over again. A detection call that
// couldn't even reach the printer leaves cameraChecked unset so it's retried
// on a later save instead of permanently caching a false negative.
async function buildPrinterRecord(p, existing) {
  const connector = CONNECTOR_TYPES.includes(p.connector) ? p.connector : DEFAULT_CONNECTOR_TYPE;
  const addr = resolvePrinterAddress(p);
  const o = { name: String(p.name || addr.url), url: addr.url };
  if (addr.ip) o.ip = addr.ip;
  if (addr.port) o.port = addr.port;
  if (addr.scheme) o.scheme = addr.scheme;
  if (p.location) o.location = String(p.location);
  if (p.costKwh) o.costKwh = String(p.costKwh);
  if (p.purchaseDate) o.purchaseDate = String(p.purchaseDate);
  if (p.autoLevel) o.autoLevel = true;
  if (p.flowCalibrate) o.flowCalibrate = true;
  if (p.timelapse) o.timelapse = true;
  if (p.pushNotify) o.pushNotify = true;
  // Default true (unset = today's one-click Print: apply this printer's own
  // configured defaults with no per-job popup) — only ever stored when
  // explicitly turned off, so an old config.json that never wrote this field
  // still behaves exactly like it always has.
  if (typeof p.forceDefaults === "boolean") {
    if (!p.forceDefaults) o.forceDefaults = false;
  } else if (existing && existing.forceDefaults === false) {
    o.forceDefaults = false;
  }
  o.connector = connector;
  // Brand is derived from the connector for every connector except generic
  // Klipper (Moonraker) — that one is a protocol many vendors speak, so
  // "Klipper" names the connector, not the machine's maker, and the user may
  // type the real one (Voron, Ratrig, a self-build). This stays the source
  // of truth either way: the derived value is never taken from the client,
  // and the typed one is only accepted for that single connector, sanitized.
  const derivedBrand = getConnector(o.connector).brand || getConnector(o.connector).label || o.connector;
  o.brand = (o.connector === BRAND_EDITABLE_CONNECTOR ? sanitizeBrand(p.brand) : "") || derivedBrand;
  // Only meaningful for creality-klipper (see that connector's
  // getCapabilities) — harmless if present on any other connector,
  // just never read.
  if (p.filamentMode === "cfs") o.filamentMode = "cfs";
  // Only meaningful for the FlashForge connectors (see connectors/
  // flashforge-mode.js): pins a printer to the stock :8898 API or to the
  // Moonraker a firmware mod exposes, instead of auto-detecting. An allowlist,
  // not a passthrough — anything else, absent included, means auto.
  if (p.transport === "native" || p.transport === "moonraker") o.transport = p.transport;
  if (p.serial) o.serial = String(p.serial);
  // Was capped at 4 chars (Snapmaker's pairing code length) — widened
  // for FlashForge's checkCode, documented as 4-5 digits.
  if (p.verificationCode) o.verificationCode = String(p.verificationCode).slice(0, 8);
  o.id = (existing && existing.id) || newPrinterId();
  // Printer Pool assignment is changed only via the dedicated
  // /api/printer-pool route (it also has to update QueueStore's
  // own state, not just this config field) — a general settings save just
  // carries it forward untouched, same convention as `id` on this same line.
  if (existing && existing.printerPoolId) o.printerPoolId = existing.printerPoolId;
  // Same "blank means keep the existing secret" convention as
  // notifications.telegramBotToken — except the token never round-
  // trips to the client at all now, so blank/omitted is the NORMAL
  // case on every save, not just when the user didn't touch it.
  // An explicit "" (the masked-secret control's Clear action) is
  // what actually wipes it; anything else falls back to whatever's
  // already on file.
  o.token = (typeof p.token === "string" && p.token.trim())
    ? p.token.trim()
    : (p.token === "" ? undefined : ((existing && existing.token) || undefined));
  // Tags can also be written via POST /api/printer-tags (the Camera View's
  // bulk "Edit Tags" modal) — an array here (even empty, meaning the user
  // cleared every tag in this row) is this save's authoritative value;
  // its absence (a caller that doesn't touch tags at all) carries the
  // matched existing printer's tags forward untouched, the same way o.id
  // is, so saving any general setting can't silently wipe them.
  if (Array.isArray(p.tags)) {
    const tags = p.tags.map(t => String(t).trim()).filter(Boolean);
    if (tags.length) o.tags = tags;
  } else if (existing && Array.isArray(existing.tags) && existing.tags.length) {
    o.tags = existing.tags;
  }
  // Same "array present (even empty) means authoritative, absent means carry
  // existing forward" convention as tags above — an empty array here is a
  // deliberate "no groups checked", which falls back to Everyone at read
  // time (see printerVisibleTo()), not stored as an empty array forever.
  if (Array.isArray(p.allowedGroups)) {
    const known = new Set((CFG.groups || []).map(g => g.id));
    const allowed = p.allowedGroups.filter(gId => known.has(gId));
    if (allowed.length) o.allowedGroups = allowed;
  } else if (existing && Array.isArray(existing.allowedGroups) && existing.allowedGroups.length) {
    o.allowedGroups = existing.allowedGroups;
  }

  if (o.connector === "creality-klipper") {
    const conn = getConnector(o.connector);
    const urlChanged = !existing || existing.url !== o.url;
    // This connector spans several machines that differ in real ways, so the
    // model is detected once and kept — it also decides whether the WebRTC
    // camera probe below is worth making at all.
    if (!urlChanged && existing && existing.modelChecked) {
      o.modelChecked = true;
      if (existing.model) o.model = existing.model;
      if (existing.modelCode) o.modelCode = existing.modelCode;
    } else {
      try {
        const model = await conn.detectModel(o);
        o.modelChecked = true;
        if (model) { o.model = model.label; o.modelCode = model.code; }
      } catch { /* unreachable right now — leave modelChecked unset, retried next save */ }
    }
    if (!urlChanged && existing.cameraChecked) {
      o.cameraChecked = true;
      if (existing.cameraUrl) o.cameraUrl = existing.cameraUrl;
      if (existing.cameraWebrtc) o.cameraWebrtc = true;
      // cameraChecked only ever meant "the SNAPSHOT probe ran". A printer
      // added before WebRTC support existed carries it with no cameraUrl and
      // no cameraWebrtc, and would otherwise sit in this branch forever —
      // never probing for a WebRTC camera no matter how many times it is
      // saved. cameraWebrtcChecked is absent on every such config, so each
      // one re-probes exactly once after upgrading and then caches normally.
      if (existing.cameraWebrtcChecked) o.cameraWebrtcChecked = true;
      else if (!o.cameraUrl) await detectCrealityWebrtcCamera(conn, o);
    } else {
      try {
        const camUrl = await conn.detectCamera(o);
        o.cameraChecked = true;
        if (camUrl) o.cameraUrl = camUrl;
        // Only when there's no snapshot camera: a printer that can serve
        // JPEGs keeps the server-side path, which also feeds notification
        // images. WebRTC is the fallback transport, never a replacement.
        if (!camUrl) await detectCrealityWebrtcCamera(conn, o);
      } catch { /* unreachable right now — leave cameraChecked unset, retried next save */ }
    }
  }
  // Bambu Lab: the model is read straight off the serial number's prefix
  // (connectors/bambulab-h2.js modelFromSerial) — no network call — and kept
  // until the serial changes, with the same first-identification tagging as
  // the Creality detection above.
  if (o.connector === "bambulab-h2") {
    // Reused only from a record that was ALREADY this connector with this
    // serial — a printer switched over from another connector must not carry
    // that connector's detected model across.
    const sameMachine = !!existing && existing.connector === o.connector && existing.serial === o.serial;
    if (sameMachine && existing.modelChecked) {
      o.modelChecked = true;
      if (existing.model) o.model = existing.model;
    } else {
      const model = getConnector(o.connector).modelFromSerial(o.serial);
      if (model) {
        o.model = model;
        o.modelChecked = true;
        // Tagged here, on this first identification for this connector and
        // serial — the generic rule below keys on existing.modelChecked, which
        // a printer switched over from Creality already carries.
        const tags = o.tags || [];
        if (!tags.some(t => t.toLowerCase() === model.toLowerCase())) o.tags = [...tags, model];
      }
    }
  }
  // A connector that covers several machines tags the printer with the model
  // it detected, so a mixed fleet can be filtered and told apart at a glance.
  // Added only on the save that FIRST identifies the model (o.modelChecked
  // set here, not carried forward), so removing the tag afterwards sticks —
  // an auto-tag that reappears on every save would be impossible to delete.
  if (o.model && !(existing && existing.modelChecked)) {
    const tags = o.tags || [];
    if (!tags.some(t => t.toLowerCase() === o.model.toLowerCase())) o.tags = [...tags, o.model];
  }
  return o;
}

// Fields whose value is (or embeds) a real secret — printers[] carries each
// printer's Moonraker token, notifications/otp carry bot tokens and API
// keys. Everything else is plain settings, safe to log verbatim so the audit
// entry is actually useful ("refreshInterval 2 -> 5") rather than opaque.
const CONFIG_SECRET_FIELDS = new Set(["resend", "otp", "notifications", "printers"]);
// Internal bookkeeping the client never edits directly — comparing these
// would just report noise (e.g. maintenanceHistory growing from an unrelated
// maintenance-log save) rather than an actual admin decision.
const CONFIG_IGNORED_FIELDS = new Set(["port", "maintenanceHistory", "maintenanceComponents", "groups"]);
function diffConfigForAudit(before, after) {
  const changed = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (CONFIG_IGNORED_FIELDS.has(k)) continue;
    const bv = before ? before[k] : undefined;
    const av = after ? after[k] : undefined;
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    changed.push(CONFIG_SECRET_FIELDS.has(k) ? { field: k } : { field: k, from: bv, to: av });
  }
  return changed;
}

app.post("/api/config", requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (b.usersEnabled && !USERS.some(u => u.role === "admin")) {
    return res.status(400).json({ error: "Create an Admin user before enabling User Access Management" });
  }
  // A live tunnel with no login requirement is a public address anyone can
  // send prints and heat beds through — block turning User Access Management
  // off from under it rather than silently stopping the tunnel as a side
  // effect of an edit made in a completely different tab (see Remote Access).
  if (!b.usersEnabled && CFG.usersEnabled && remoteAccess.getStatus().enabled) {
    return res.status(400).json({ error: "Remote Access is on and needs a login requirement. Turn off Remote Access first (Settings → Remote Access), then disable User Access Management." });
  }
  const printersOut = Array.isArray(b.printers)
    ? await Promise.all(
        b.printers
          // Simulator printers have no real hardware address — the client
          // auto-fills a synthetic one, but this is the actual boundary
          // where a blank url would otherwise silently drop the printer
          // from the saved list entirely (see the `.filter(p && p.url)`
          // below), so the same fallback is applied here too rather than
          // trusting the client.
          .map(p => {
            if (!p) return p;
            if (p.connector === "simulator") {
              return String(p.url || "").trim() ? p : { ...p, url: "sim://" + crypto.randomBytes(4).toString("hex") };
            }
            // Compose the canonical url here, before the filter and the
            // identity match below — both still key on `url`, and a row
            // from the browser now carries ip/port instead.
            return { ...p, ...resolvePrinterAddress(p) };
          })
          .filter(p => p && p.url)
          .map(p => {
            const existing = (p.id && PRINTERS.find(ep => ep.id === p.id)) || PRINTERS.find(ep => ep.url === String(p.url));
            return buildPrinterRecord(p, existing);
          })
      )
    : (CFG.printers || []);
  const next = {
    gcodeFolder: (typeof b.gcodeFolder === "string" && b.gcodeFolder.trim()) ? b.gcodeFolder.trim() : (CFG.gcodeFolder || "./gcode"),
    // Unlike gcodeFolder, an empty submission here is a valid, intentional
    // "not configured yet" state — it clears the field rather than falling
    // back to whatever was previously saved.
    logsFolder: (typeof b.logsFolder === "string") ? b.logsFolder.trim() : (CFG.logsFolder || ""),
    cameraFolder: (typeof b.cameraFolder === "string") ? b.cameraFolder.trim() : (CFG.cameraFolder || ""),
    firmwareFolder: (typeof b.firmwareFolder === "string") ? b.firmwareFolder.trim() : (CFG.firmwareFolder || ""),
    firmwareSkipCurrent: (typeof b.firmwareSkipCurrent === "boolean") ? b.firmwareSkipCurrent : (CFG.firmwareSkipCurrent !== false),
    firmwareVerify: (typeof b.firmwareVerify === "boolean") ? b.firmwareVerify : (CFG.firmwareVerify !== false),
    gcodeSyncFolder: (typeof b.gcodeSyncFolder === "string") ? b.gcodeSyncFolder.trim() : (CFG.gcodeSyncFolder || ""),
    logsRetentionDays: (typeof b.logsRetentionDays === "number" && b.logsRetentionDays > 0) ? b.logsRetentionDays : undefined,
    cameraRetentionDays: (typeof b.cameraRetentionDays === "number" && b.cameraRetentionDays > 0) ? b.cameraRetentionDays : undefined,
    gcodeSyncRetentionDays: (typeof b.gcodeSyncRetentionDays === "number" && b.gcodeSyncRetentionDays > 0) ? b.gcodeSyncRetentionDays : undefined,
    refreshInterval: (typeof b.refreshInterval === "number" && b.refreshInterval >= 1 && b.refreshInterval <= 60) ? b.refreshInterval : (CFG.refreshInterval || 2),
    cameraViewRefreshInterval: (typeof b.cameraViewRefreshInterval === "number" && b.cameraViewRefreshInterval >= 3 && b.cameraViewRefreshInterval <= 60) ? b.cameraViewRefreshInterval : (CFG.cameraViewRefreshInterval || 6),
    // Defaults ON like allowMapping/suggestMatching below — absence must
    // fall back to the previous stored value, not to false.
    cameraViewStagger: (typeof b.cameraViewStagger === "boolean") ? b.cameraViewStagger : (CFG.cameraViewStagger !== false),
    alternateDisplay: ["all","compact","camera","list","printfarm"].includes(b.alternateDisplay) ? b.alternateDisplay : (CFG.alternateDisplay || "all"),
    filamentCost: (typeof b.filamentCost === "number" && b.filamentCost > 0) ? b.filamentCost : undefined,
    electricityRate: (typeof b.electricityRate === "number" && b.electricityRate > 0) ? b.electricityRate : undefined,
    currency: (typeof b.currency === "string" && b.currency.trim()) ? b.currency.trim().slice(0, 6) : "$",
    // System default locale — not required to currently be an installed
    // locale (same loose-validation treatment as currency above, since
    // installed locales are a dynamic set, not a fixed allow-list like
    // alternateDisplay/defaultView).
    locale: (typeof b.locale === "string" && locales.LOCALE_RE.test(b.locale)) ? b.locale : (CFG.locale || "en"),
    tNotation: b.tNotation ? true : undefined,
    defaultView: ["regular","compact","camera","list","printfarm"].includes(b.defaultView) ? b.defaultView : (CFG.defaultView || "regular"),
    // Empty means "don't show it" (see the topbar) — never persisted as a
    // stray leftover string once cleared.
    siteName: (typeof b.siteName === "string" && b.siteName.trim()) ? b.siteName.trim().slice(0, 60) : undefined,
    // Unlike tNotation (default off, "omit means false" is safe), these
    // default ON — so absence must fall back to the previous stored
    // value, not to false, or unchecking them would never persist.
    allowMapping: (typeof b.allowMapping === "boolean") ? b.allowMapping : (CFG.allowMapping !== false),
    suggestMatching: (typeof b.suggestMatching === "boolean") ? b.suggestMatching : (CFG.suggestMatching !== false),
    usersEnabled: b.usersEnabled ? true : undefined,
    resend: (b.resend && typeof b.resend === "object") ? {
      apiKey: (typeof b.resend.apiKey === "string" && b.resend.apiKey.trim()) ? b.resend.apiKey.trim() : ((CFG.resend && CFG.resend.apiKey) || undefined),
      fromAddress: String(b.resend.fromAddress || "").trim()
    } : (CFG.resend || undefined),
    otp: (b.otp && typeof b.otp === "object") ? {
      service: ["ntfy", "telegram"].includes(b.otp.service) ? b.otp.service : "resend",
      ntfyTopic: String(b.otp.ntfyTopic || "").trim(),
      telegramChatId: String(b.otp.telegramChatId || "").trim()
    } : (CFG.otp || undefined),
    notifications: (b.notifications && typeof b.notifications === "object") ? {
      enabled: !!b.notifications.enabled,
      onStart: !!b.notifications.onStart,
      onPause: !!b.notifications.onPause,
      onError: !!b.notifications.onError,
      onComplete: !!b.notifications.onComplete,
      onIntervals: !!b.notifications.onIntervals,
      // Whatever percentages the client sent, deduped/sorted/clamped to a
      // sane 1-99 range — never trust it to already be clean.
      milestonePercents: Array.isArray(b.notifications.milestonePercents)
        ? [...new Set(b.notifications.milestonePercents.map(Number).filter(n => Number.isFinite(n) && n > 0 && n < 100))].sort((a, b2) => a - b2)
        : DEFAULT_MILESTONES,
      includeImage: !!b.notifications.includeImage,
      // Both providers are independent now — either, neither, or both can
      // be enabled at once (see sendEventNotification).
      ntfyEnabled: !!b.notifications.ntfyEnabled,
      telegramEnabled: !!b.notifications.telegramEnabled,
      ntfyTopic: String(b.notifications.ntfyTopic || "").trim(),
      telegramChatId: String(b.notifications.telegramChatId || "").trim(),
      // Same 3-state convention as the printer token above: a non-blank
      // string replaces it, an explicit "" (Clear) wipes it, anything else
      // (omitted/undefined — the normal "didn't touch it" case) keeps
      // whatever's already on file.
      telegramBotToken: (typeof b.notifications.telegramBotToken === "string" && b.notifications.telegramBotToken.trim())
        ? b.notifications.telegramBotToken.trim()
        : (b.notifications.telegramBotToken === "" ? undefined : ((CFG.notifications && CFG.notifications.telegramBotToken) || undefined)),
      webhookEnabled: !!b.notifications.webhookEnabled,
      // "discord" (an embed) or "json" (SnapCon's own fields, for n8n/Home
      // Assistant/anything custom). Explicit rather than sniffed from the URL:
      // guessing wrong on a value the UI masks would be baffling to debug.
      webhookFormat: b.notifications.webhookFormat === "json" ? "json" : "discord",
      // Same 3-state convention as telegramBotToken above.
      webhookUrl: (typeof b.notifications.webhookUrl === "string" && b.notifications.webhookUrl.trim())
        ? b.notifications.webhookUrl.trim()
        : (b.notifications.webhookUrl === "" ? undefined : ((CFG.notifications && CFG.notifications.webhookUrl) || undefined))
    } : (CFG.notifications || undefined),
    port: PORT,
    // Internal bookkeeping, not part of this endpoint's editable settings —
    // carried forward untouched so a general settings save can never wipe
    // maintenance history/component list the way it silently did before
    // (this `next` object is a full rebuild, not a merge, so anything not
    // explicitly copied here is lost the moment this file is rewritten).
    maintenanceHistory: CFG.maintenanceHistory || undefined,
    maintenanceComponents: CFG.maintenanceComponents || undefined,
    // Groups are managed entirely through their own /api/groups CRUD routes,
    // never through this endpoint — carried forward untouched for the same
    // "full rebuild, not a merge" reason as maintenanceHistory above.
    groups: CFG.groups || undefined,
    // Queue Management is managed entirely through its own
    // /api/queue-management/* and /api/printer-pools/* routes, never through
    // this endpoint — carried forward untouched for the same "full rebuild,
    // not a merge" reason as maintenanceHistory/groups above. Omitting this
    // was the root cause of a report where a newly-created Printer Pool
    // vanished after an unrelated Settings save: this `next` rebuild would
    // silently drop it, and the loadConfig() reload below never re-runs
    // ensurePrinterPoolSchema() to restore even the defaults.
    queueManagement: CFG.queueManagement || undefined,
    printerPools: (CFG.printerPools && CFG.printerPools.length) ? CFG.printerPools : undefined,
    // Editable from the Settings > Logs tab's "keep logs for ___ days" field.
    auditRetentionDays: (typeof b.auditRetentionDays === "number" && b.auditRetentionDays > 0) ? b.auditRetentionDays : (CFG.auditRetentionDays || undefined),
    // Persistent identity, independent of name/url — matched by id first
    // (round-tripped from the client) so renaming or re-IP'ing a printer
    // doesn't detach it from its own maintenance history (CFG.maintenanceHistory,
    // keyed by id, never nested in here). Falls back to a url match for
    // pre-upgrade clients that haven't got an id yet. Built above (async —
    // Creality printers may need a live camera-detection round-trip).
    printers: printersOut
  };
  // Computed right before the write, against the CFG that's still live at
  // this point — never against `next` after loadConfig() below has already
  // replaced it.
  const configDiff = diffConfigForAudit(CFG, next);
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
    loadConfig();
    if (configDiff.length) auditLog.log({ category: "admin", event: "settings-updated", ...actorFromReq(req), detail: { changed: configDiff } });
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
  return { id: u.id, firstName: u.firstName || "", lastName: u.lastName || "", loginName: u.loginName, email: u.email || "", phone: u.phone || "", role: u.role, otpEnabled: !!u.otpEnabled, groupIds: Array.isArray(u.groupIds) ? u.groupIds : [], createdAt: u.createdAt, updatedAt: u.updatedAt };
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
  // locale is included unauthenticated too — it's just the system-configured
  // default locale CODE (e.g. "en"/"es"), not sensitive — so the login
  // overlay's pre-auth i18n bootstrap can resolve a starting locale without
  // a separate round-trip or requiring a session first.
  if (!CFG.usersEnabled) return res.json({ usersEnabled: false, locale: CFG.locale || "en" });
  if (!req.user) return res.json({ usersEnabled: true, authenticated: false, locale: CFG.locale || "en" });
  res.json({ usersEnabled: true, authenticated: true, user: { id: req.user.id, loginName: req.user.loginName, firstName: req.user.firstName, lastName: req.user.lastName, role: req.user.role, theme: req.user.theme, locale: req.user.locale } });
});

// Self-service, deliberately narrow — not routed through PUT /api/users/:id
// (requireAdmin, full profile edit) since a "regular"/"view" user must be
// able to save their own theme choice without user-management permissions.
// Only ever touches the caller's own record (req.user.id from the session),
// never req.params — there is no other user's data reachable here.
app.post("/api/session/theme", requireAuth, (req, res) => {
  if (!req.user.id) return res.status(400).json({ error: "Per-user theme requires User Access Management" });
  const theme = req.body && req.body.theme;
  if (theme !== "light" && theme !== "dark") return res.status(400).json({ error: "theme must be \"light\" or \"dark\"" });
  const u = USERS.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: "User not found" });
  u.theme = theme;
  u.updatedAt = new Date().toISOString();
  try { saveUsers(); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true });
});

// Same shape as POST /api/session/theme above — self-service, any role, only
// ever touches the caller's own record. Resolution order (user -> CFG.locale
// -> "en") is applied client-side by the i18n runtime; this route only
// persists the override. Not gated on the locale actually existing in the
// registry — a locale later removed just falls back to "en" at read time
// (see applyAccountLocale-equivalent in app.js), same as a deleted theme
// choice never being a fatal state.
app.post("/api/session/locale", requireAuth, (req, res) => {
  if (!req.user.id) return res.status(400).json({ error: "Per-user language requires User Access Management" });
  const locale = req.body && req.body.locale;
  if (locale !== null && (typeof locale !== "string" || !locales.LOCALE_RE.test(locale))) {
    return res.status(400).json({ error: "locale must be a valid locale code, or null to follow the system default" });
  }
  const u = USERS.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: "User not found" });
  u.locale = locale;
  u.updatedAt = new Date().toISOString();
  try { saveUsers(); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true });
});

// ---- Public locale discovery (unauthenticated, read-only) ----
// Exists specifically for the login/OTP overlay's pre-auth i18n bootstrap —
// public/i18n.js's fetchLocale() calls the second route below for EVERY
// locale load, authenticated or not, so there is exactly one code path
// rather than branching i18n.js on auth state. Deliberately separate from
// the authenticated /api/locales* routes below (never modified by this
// pair): trimmed response shape only (no `errors`/`version`/`snapconVersion`
// /`updated` on the list; no `fingerprint` on the single-locale read — that
// one backs the Language Editor's optimistic-concurrency check and has no
// pre-auth use). Every mutation (save/create/import/refresh) stays
// requireAdmin on the routes further down — nothing here writes anything.
app.get("/api/public-locales", (req, res) => {
  res.json({
    locales: Object.entries(LOCALE_REGISTRY.locales).map(([locale, entry]) => ({
      locale, language: entry.meta.language, nativeName: entry.meta.nativeName,
      completionPercent: entry.completion.percent
    }))
  });
});
app.get("/api/public-locales/:locale", (req, res) => {
  const filePath = locales.safeLocalePath(LOCALES_DIR, req.params.locale);
  if (!filePath) return res.status(400).json({ error: "Invalid locale code" });
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch (e) { return res.status(404).json({ error: "Locale not found" }); }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { return res.status(500).json({ error: "This locale file is currently invalid JSON: " + e.message }); }
  res.json({ data });
});

// ---- Locale discovery + Language Editor (admin-only mutation) ----
// Reading the list is available to any authenticated user (populating their
// own language selector); every write (save/create/import/refresh) is
// requireAdmin, enforced server-side — never inferred from what the
// frontend chooses to show. English (en) is permanently read-only, even for
// Admin, at every mutating route below.
app.get("/api/locales", requireAuth, (req, res) => {
  res.json({
    locales: Object.entries(LOCALE_REGISTRY.locales).map(([locale, entry]) => ({
      locale, language: entry.meta.language, nativeName: entry.meta.nativeName,
      version: entry.meta.version || 0, snapconVersion: entry.meta.snapconVersion || null,
      updated: entry.meta.updated || null, completionPercent: entry.completion.percent
    })),
    errors: LOCALE_REGISTRY.errors
  });
});

app.post("/api/locales/refresh", requireAdmin, (req, res) => {
  refreshLocaleRegistry();
  res.json({ ok: true, errors: LOCALE_REGISTRY.errors });
});

// requireAuth, not requireAdmin — the i18n runtime needs this for ANY
// signed-in user to actually render translated text, not just the
// Language Editor (admin-only writes are the real gate, further down).
app.get("/api/locales/:locale", requireAuth, (req, res) => {
  const filePath = locales.safeLocalePath(LOCALES_DIR, req.params.locale);
  if (!filePath) return res.status(400).json({ error: "Invalid locale code" });
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch (e) { return res.status(404).json({ error: "Locale not found" }); }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { return res.status(500).json({ error: "This locale file is currently invalid JSON: " + e.message }); }
  res.json({ data, fingerprint: locales.computeFingerprint(LOCALES_DIR, req.params.locale + ".json") });
});

app.post("/api/locales", requireAdmin, (req, res) => {
  const b = req.body || {};
  const locale = String(b.locale || "");
  if (!locales.LOCALE_RE.test(locale)) return res.status(400).json({ error: "Locale code must look like \"es\", \"fr\", or \"pt-BR\"" });
  if (locale === "en") return res.status(400).json({ error: "English is the built-in source locale and can't be recreated" });
  if (LOCALE_REGISTRY.locales[locale]) return res.status(400).json({ error: `"${locale}" already exists` });
  const enPath = locales.safeLocalePath(LOCALES_DIR, "en");
  let enData;
  try { enData = JSON.parse(fs.readFileSync(enPath, "utf8")); }
  catch (e) { return res.status(500).json({ error: "Could not read the English source to seed the new language: " + e.message }); }
  // Untranslated per spec 3D/6E — null values, not copied English prose,
  // so a fresh language never claims false completion.
  function nullify(obj) {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
    const out = {};
    for (const k of Object.keys(obj)) out[k] = (k !== "_meta" && typeof obj[k] === "object" && obj[k] !== null) ? nullify(obj[k]) : (k === "_meta" ? obj[k] : null);
    return out;
  }
  const data = nullify(enData);
  data._meta = { locale, language: String(b.language || "").trim() || locale, nativeName: String(b.nativeName || "").trim() || locale, version: 1, snapconVersion: VERSION, updated: new Date().toISOString().slice(0, 10) };
  try { locales.writeLocaleFile(LOCALES_DIR, locale, data); } catch (e) { return res.status(500).json({ error: e.message }); }
  refreshLocaleRegistry();
  res.json({ ok: true });
});

app.post("/api/locales/:locale", requireAdmin, (req, res) => {
  const locale = req.params.locale;
  if (locale === "en") return res.status(400).json({ error: "English is the built-in source locale and is read-only" });
  if (!locales.LOCALE_RE.test(locale)) return res.status(400).json({ error: "Invalid locale code" });
  const b = req.body || {};
  if (!b.data || typeof b.data !== "object") return res.status(400).json({ error: "Missing locale data" });
  const shape = locales.validateLocaleShape(locale + ".json", b.data);
  if (!shape.ok) return res.status(400).json({ error: shape.error });
  const currentFingerprint = locales.computeFingerprint(LOCALES_DIR, locale + ".json");
  if (currentFingerprint && b.expectedFingerprint && currentFingerprint !== b.expectedFingerprint) {
    return res.status(409).json({ error: "This translation changed elsewhere since it was opened — refresh to see the latest version before saving." });
  }
  const nextData = { ...b.data, _meta: { ...b.data._meta, version: (parseInt(b.data._meta.version, 10) || 0) + 1, snapconVersion: VERSION, updated: new Date().toISOString().slice(0, 10) } };
  try { locales.writeLocaleFile(LOCALES_DIR, locale, nextData); } catch (e) { return res.status(500).json({ error: e.message }); }
  refreshLocaleRegistry();
  res.json({ ok: true, meta: nextData._meta });
});

// Preview-only — validates and reports stats without writing anything, so
// the editor can show "N recognized / N missing / N orphaned / N placeholder
// errors" before the admin commits (spec 6G).
app.post("/api/locales/:locale/import-preview", requireAdmin, (req, res) => {
  const locale = req.params.locale;
  if (locale === "en") return res.status(400).json({ error: "English is the built-in source locale and is read-only" });
  const b = req.body || {};
  if (!b.data || typeof b.data !== "object") return res.status(400).json({ error: "Missing locale data" });
  const shape = locales.validateLocaleShape(locale + ".json", b.data);
  if (!shape.ok) return res.status(400).json({ error: shape.error });
  const enEntry = LOCALE_REGISTRY.locales.en;
  let enFlat = {};
  try { enFlat = locales.flattenKeys(JSON.parse(fs.readFileSync(locales.safeLocalePath(LOCALES_DIR, "en"), "utf8"))); } catch {}
  const importedFlat = locales.flattenKeys(b.data);
  const completion = locales.computeCompletion(enFlat, importedFlat);
  res.json({
    recognizedKeys: completion.translated,
    missingKeys: completion.total - completion.translated,
    orphanedKeys: locales.findOrphanedKeys(enFlat, importedFlat).length,
    placeholderErrors: locales.findPlaceholderMismatches(enFlat, importedFlat).length
  });
});

app.post("/api/locales/:locale/import", requireAdmin, (req, res) => {
  const locale = req.params.locale;
  if (locale === "en") return res.status(400).json({ error: "English is the built-in source locale and is read-only" });
  if (!locales.LOCALE_RE.test(locale)) return res.status(400).json({ error: "Invalid locale code" });
  const b = req.body || {};
  if (!b.data || typeof b.data !== "object") return res.status(400).json({ error: "Missing locale data" });
  const shape = locales.validateLocaleShape(locale + ".json", b.data);
  if (!shape.ok) return res.status(400).json({ error: shape.error });
  // Import REPLACES the target file — the imported JSON is the whole
  // translation, not a patch merged over whatever was there before (spec
  // 6G: "the imported locale represents the target translation file rather
  // than silently merging hidden values from the previous version").
  const nextData = { ...b.data, _meta: { ...b.data._meta, locale, version: (parseInt(b.data._meta.version, 10) || 0) + 1, updated: new Date().toISOString().slice(0, 10) } };
  try { locales.writeLocaleFile(LOCALES_DIR, locale, nextData); } catch (e) { return res.status(500).json({ error: e.message }); }
  refreshLocaleRegistry();
  res.json({ ok: true });
});

app.post("/api/login", async (req, res) => {
  if (!CFG.usersEnabled) return res.status(400).json({ error: "User Access Management is not enabled", code: "users_disabled" });
  const { loginName, password } = req.body || {};
  const u = findUserByLoginName(loginName);
  if (!u) {
    auditLog.log({ category: "auth", event: "login-failed", userLabel: String(loginName || ""), detail: { reason: "unknown login name" } });
    // Deliberately the SAME code (and English string) as the bad-password
    // branch below — anti-enumeration, see the class comment above
    // /api/login/otp/request. A translation must never split these into
    // two distinguishable codes.
    return res.status(401).json({ error: "Invalid login name or password", code: "invalid_credentials" });
  }
  if (u.otpEnabled) return res.status(400).json({ error: 'This account signs in with a one-time code — use "Send me a code instead"', code: "otp_required" });
  if (!(await auth.verifyPassword(String(password || ""), u.passwordHash))) {
    auditLog.log({ category: "auth", event: "login-failed", userId: u.id, userLabel: u.loginName, detail: { reason: "bad password" } });
    return res.status(401).json({ error: "Invalid login name or password", code: "invalid_credentials" });
  }
  const token = auth.createSession(u.id);
  res.cookie(auth.SESSION_COOKIE, token, auth.sessionCookieOptions());
  auditLog.log({ category: "auth", event: "login", userId: u.id, userLabel: u.loginName });
  res.json({ ok: true, user: { id: u.id, loginName: u.loginName, firstName: u.firstName, lastName: u.lastName, role: u.role, theme: u.theme || null, locale: u.locale || null } });
});

// Deliberately generic: whether the login name doesn't exist, isn't an OTP
// account, or has no email on file all produce the same message, so this
// can't be used to enumerate accounts.
app.post("/api/login/otp/request", async (req, res) => {
  if (!CFG.usersEnabled) return res.status(400).json({ error: "User Access Management is not enabled", code: "users_disabled" });
  const otpService = (CFG.otp && CFG.otp.service) || "resend";
  if (otpService === "ntfy") {
    if (!CFG.otp || !CFG.otp.ntfyTopic) return res.status(500).json({ error: "OTP is not configured", code: "otp_not_configured" });
  } else if (otpService === "telegram") {
    if (!CFG.otp || !CFG.otp.telegramChatId || !CFG.notifications || !CFG.notifications.telegramBotToken) return res.status(500).json({ error: "OTP is not configured", code: "otp_not_configured" });
  } else if (!CFG.resend || !CFG.resend.apiKey || !CFG.resend.fromAddress) {
    return res.status(500).json({ error: "OTP is not configured", code: "otp_not_configured" });
  }
  const u = findUserByLoginName((req.body || {}).loginName);
  // ntfy/Telegram both deliver to a shared recipient, not a per-user
  // address, so email isn't required for those paths — it still is for
  // Resend, which needs somewhere to send the message.
  if (!u || !u.otpEnabled || (otpService === "resend" && !u.email)) return res.status(400).json({ error: "Could not send a code for that login name", code: "otp_request_generic_fail" });
  const code = auth.setOtpCode(u.loginNameLower);
  try {
    if (otpService === "ntfy") {
      await sendNtfy({ topic: CFG.otp.ntfyTopic, title: "SnapCon login code", message: "Code for " + u.loginName + ": " + code + " (expires in 10 min)" });
    } else if (otpService === "telegram") {
      await sendTelegram({ botToken: CFG.notifications.telegramBotToken, chatId: CFG.otp.telegramChatId, message: "SnapCon login code for " + u.loginName + ": " + code + " (expires in 10 min)" });
    } else {
      await sendResendEmail({
        apiKey: CFG.resend.apiKey, fromAddress: CFG.resend.fromAddress, to: u.email,
        subject: "Your SnapCon login code",
        text: "Your SnapCon login code is: " + code + "\n\nThis code expires in 10 minutes."
      });
    }
  } catch (e) {
    // Raw delivery diagnostic (Resend/ntfy/Telegram HTTP error) — left as
    // free text in `detail`, never given its own translated code; only
    // reachable for an already-valid, already-configured OTP account, so
    // (unlike otp_request_generic_fail above) this path is not itself an
    // anti-enumeration concern — that property is pre-existing, not
    // something this phase changes.
    return res.status(502).json({ error: "Could not send the code: " + e.message, code: "otp_delivery_failed", detail: e.message });
  }
  res.json({ ok: true });
});

app.post("/api/login/otp/verify", (req, res) => {
  if (!CFG.usersEnabled) return res.status(400).json({ error: "User Access Management is not enabled", code: "users_disabled" });
  const { loginName, code } = req.body || {};
  const u = findUserByLoginName(loginName);
  if (!u || !u.otpEnabled) {
    auditLog.log({ category: "auth", event: "login-failed", userLabel: String(loginName || ""), detail: { reason: "unknown/non-OTP login name" } });
    // Same code+string as auth.verifyOtpCode()'s own "wrong code" outcome
    // below — preserves today's exact distinguishability from its OTHER
    // three outcomes (request_new/expired/too_many_attempts), which this
    // phase does not change.
    return res.status(401).json({ error: "Incorrect code", code: "otp_verify_incorrect" });
  }
  const result = auth.verifyOtpCode(u.loginNameLower, code);
  if (!result.ok) {
    auditLog.log({ category: "auth", event: "login-failed", userId: u.id, userLabel: u.loginName, detail: { reason: result.error } });
    return res.status(401).json({ error: result.error, code: result.code });
  }
  const token = auth.createSession(u.id);
  res.cookie(auth.SESSION_COOKIE, token, auth.sessionCookieOptions());
  auditLog.log({ category: "auth", event: "login", userId: u.id, userLabel: u.loginName, detail: { via: "otp" } });
  res.json({ ok: true, user: { id: u.id, loginName: u.loginName, firstName: u.firstName, lastName: u.lastName, role: u.role, theme: u.theme || null, locale: u.locale || null } });
});

app.post("/api/logout", (req, res) => {
  if (req.user) auditLog.log({ category: "auth", event: "logout", ...actorFromReq(req) });
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
  if (!LOGIN_NAME_RE.test(loginName)) return res.status(400).json({ error: "Login name must be 2-32 characters (letters, numbers, _ . -)", code: "invalid_login_name" });
  const loginNameLower = loginName.toLowerCase();
  if (USERS.some(u => u.loginNameLower === loginNameLower)) return res.status(400).json({ error: "That login name is already in use", code: "login_name_taken" });
  if (!ROLES.includes(b.role)) return res.status(400).json({ error: "Invalid role", code: "invalid_role" });
  const otpEnabled = !!b.otpEnabled;
  let passwordHash = null;
  if (!otpEnabled) {
    const password = String(b.password || "");
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters", code: "password_too_short" });
    passwordHash = await auth.hashPassword(password);
  }
  const now = new Date().toISOString();
  const knownGroups = new Set((CFG.groups || []).map(g => g.id));
  const u = {
    id: auth.newUserId(),
    firstName: String(b.firstName || "").trim(), lastName: String(b.lastName || "").trim(),
    loginName, loginNameLower,
    email: String(b.email || "").trim(), phone: String(b.phone || "").trim(),
    role: b.role, otpEnabled, passwordHash,
    groupIds: Array.isArray(b.groupIds) ? b.groupIds.filter(gId => knownGroups.has(gId)) : [],
    createdAt: now, updatedAt: now
  };
  USERS.push(u);
  try { saveUsers(); } catch (e) { return res.status(500).json({ error: e.message }); }
  auditLog.log({ category: "admin", event: "user-created", ...actorFromReq(req), detail: { targetUserId: u.id, loginName: u.loginName, role: u.role } });
  res.json({ ok: true, user: publicUser(u) });
});

app.put("/api/users/:id", requireAdmin, async (req, res) => {
  const u = USERS.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: "User not found", code: "user_not_found" });
  const b = req.body || {};

  // Validate everything into locals first — nothing on the live `u` object
  // (still referenced by any active session via authMiddleware) is mutated
  // until every check below has passed, so a request that fails partway
  // through can't leave in-memory state ahead of what's on disk.
  let loginName, loginNameLower;
  if (b.loginName !== undefined) {
    loginName = String(b.loginName || "").trim();
    if (!LOGIN_NAME_RE.test(loginName)) return res.status(400).json({ error: "Login name must be 2-32 characters (letters, numbers, _ . -)", code: "invalid_login_name" });
    loginNameLower = loginName.toLowerCase();
    if (USERS.some(x => x.id !== u.id && x.loginNameLower === loginNameLower)) return res.status(400).json({ error: "That login name is already in use", code: "login_name_taken" });
  }
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) return res.status(400).json({ error: "Invalid role", code: "invalid_role" });
    if (u.role === "admin" && b.role !== "admin" && adminCountExcluding(u.id) === 0) return res.status(400).json({ error: "Cannot demote the last Admin", code: "last_admin_demote" });
  }
  const nextOtpEnabled = b.otpEnabled !== undefined ? !!b.otpEnabled : u.otpEnabled;
  if (b.password) {
    if (nextOtpEnabled) return res.status(400).json({ error: "OTP-enabled accounts cannot have a password", code: "otp_no_password" });
    if (String(b.password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters", code: "password_too_short" });
  }
  const willHavePassword = nextOtpEnabled ? false : (b.password ? true : !!u.passwordHash);
  if (!nextOtpEnabled && !willHavePassword) return res.status(400).json({ error: "Set a password, or enable OTP login", code: "password_or_otp_required" });
  const newPasswordHash = b.password ? await auth.hashPassword(String(b.password)) : undefined;

  // Every check passed — apply.
  if (loginName !== undefined) { u.loginName = loginName; u.loginNameLower = loginNameLower; }
  if (b.role !== undefined) u.role = b.role;
  if (b.firstName !== undefined) u.firstName = String(b.firstName || "").trim();
  if (b.lastName !== undefined) u.lastName = String(b.lastName || "").trim();
  if (b.email !== undefined) u.email = String(b.email || "").trim();
  if (b.phone !== undefined) u.phone = String(b.phone || "").trim();
  if (Array.isArray(b.groupIds)) {
    const known = new Set((CFG.groups || []).map(g => g.id));
    u.groupIds = b.groupIds.filter(gId => known.has(gId));
  }
  u.otpEnabled = nextOtpEnabled;
  // A password already on file stays on file when OTP is turned on — it's just
  // unusable while otpEnabled blocks password login (see /api/login above) —
  // so switching OTP back off later doesn't force re-entering a password.
  if (!nextOtpEnabled && newPasswordHash) u.passwordHash = newPasswordHash;
  u.updatedAt = new Date().toISOString();
  try { saveUsers(); } catch (e) { return res.status(500).json({ error: e.message }); }
  auditLog.log({ category: "admin", event: "user-updated", ...actorFromReq(req), detail: { targetUserId: u.id, loginName: u.loginName } });
  res.json({ ok: true, user: publicUser(u) });
});

app.delete("/api/users/:id", requireAdmin, (req, res) => {
  const idx = USERS.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "User not found", code: "user_not_found" });
  if (USERS[idx].role === "admin" && adminCountExcluding(USERS[idx].id) === 0) return res.status(400).json({ error: "Cannot delete the last Admin", code: "last_admin_delete" });
  // Same reasoning as the usersEnabled guard above: deleting the only
  // account left would leave a live public tunnel with no one who can log
  // in — block it here rather than silently stopping the tunnel.
  if (USERS.length === 1 && remoteAccess.getStatus().enabled) {
    return res.status(400).json({ error: "Remote Access is on and needs at least one account. Turn off Remote Access first (Settings → Remote Access), then delete this account.", code: "remote_access_needs_account" });
  }
  const [removed] = USERS.splice(idx, 1);
  try { saveUsers(); } catch (e) { USERS.splice(idx, 0, removed); return res.status(500).json({ error: e.message }); }
  if (removed.id === (req.user && req.user.id)) { auth.destroySession(req.sessionToken); res.clearCookie(auth.SESSION_COOKIE); }
  auditLog.log({ category: "admin", event: "user-deleted", ...actorFromReq(req), detail: { targetUserId: removed.id, loginName: removed.loginName } });
  res.json({ ok: true });
});

// ---- Groups: scope which users can see/act on which printers ----
// CFG.groups lives in config.json (not users.json) since it must exist
// unconditionally at startup, same as CFG.printers (see ensureGroupsSchema).
// USERS[].groupIds and PRINTERS[].allowedGroups are the two membership
// edges; printerVisibleTo() is the one place their "missing means Everyone"
// fallback is applied.
app.get("/api/groups", requireAdmin, (req, res) => {
  res.json(CFG.groups || []);
});

app.post("/api/groups", requireAdmin, (req, res) => {
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "Group name required", code: "group_name_required" });
  if (!Array.isArray(CFG.groups)) CFG.groups = [];
  const now = new Date().toISOString();
  const g = { id: newGroupId(), name, createdAt: now, updatedAt: now };
  CFG.groups.push(g);
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); }
  catch (e) { CFG.groups.pop(); return res.status(500).json({ error: e.message }); }
  auditLog.log({ category: "admin", event: "group-created", ...actorFromReq(req), detail: { groupId: g.id, name } });
  res.json({ ok: true, group: g });
});

app.put("/api/groups/:id", requireAdmin, (req, res) => {
  const g = (CFG.groups || []).find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: "Group not found", code: "group_not_found" });
  if (g.id === GROUP_EVERYONE_ID) return res.status(400).json({ error: "The Everyone group can't be renamed", code: "group_everyone_immutable_rename" });
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "Group name required", code: "group_name_required" });
  const prevName = g.name;
  g.name = name;
  g.updatedAt = new Date().toISOString();
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); }
  catch (e) { g.name = prevName; return res.status(500).json({ error: e.message }); }
  auditLog.log({ category: "admin", event: "group-renamed", ...actorFromReq(req), detail: { groupId: g.id, from: prevName, to: name } });
  res.json({ ok: true, group: g });
});

app.delete("/api/groups/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  if (id === GROUP_EVERYONE_ID) return res.status(400).json({ error: "The Everyone group can't be deleted", code: "group_everyone_immutable_delete" });
  const idx = (CFG.groups || []).findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ error: "Group not found", code: "group_not_found" });

  // Nothing is written to either file until both are known-good — restores
  // all three in-memory structures if either save fails, matching the
  // validate-then-mutate pattern the user CRUD routes above already use.
  const removedGroup = CFG.groups[idx];
  const groupsBackup = CFG.groups.slice();
  const printerBackups = PRINTERS.map(p => p.allowedGroups);
  const userBackups = USERS.map(u => u.groupIds);

  CFG.groups.splice(idx, 1);
  removeGroupReferences(id, PRINTERS, USERS);

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2));
    saveUsers();
  } catch (e) {
    CFG.groups = groupsBackup;
    PRINTERS.forEach((p, i) => { p.allowedGroups = printerBackups[i]; });
    USERS.forEach((u, i) => { u.groupIds = userBackups[i]; });
    return res.status(500).json({ error: e.message });
  }
  auditLog.log({ category: "admin", event: "group-deleted", ...actorFromReq(req), detail: { groupId: id, name: removedGroup.name } });
  res.json({ ok: true });
});

// ---- Audit log: read-only Settings > Logs tab ----
app.get("/api/audit-log", requireAdmin, (req, res) => {
  const { from, to, category, event, userId, printerId, q, limit, offset } = req.query;
  res.json(auditLog.query({
    from: from ? Number(from) : undefined,
    to: to ? Number(to) : undefined,
    category: category || undefined,
    event: event || undefined,
    userId: userId || undefined,
    printerId: printerId || undefined,
    q: q || undefined,
    limit: limit ? Number(limit) : 100,
    offset: offset ? Number(offset) : 0
  }));
});

// ==================================================================
// ---- Queue Management (Phase 1: per-printer manual queues) ----
// ==================================================================

app.get("/api/queue-management/status", requireAuth, (req, res) => {
  res.json({ enabled: !!(CFG.queueManagement && CFG.queueManagement.enabled), mode: (CFG.queueManagement && CFG.queueManagement.mode) || "per-printer", store: queueStore.getGlobalStatus() });
});

app.post("/api/queue-management/enable", requireAdmin, (req, res) => {
  if (!CFG.queueManagement || typeof CFG.queueManagement !== "object") CFG.queueManagement = { enabled: false, mode: "per-printer" };
  if (!CFG.queueManagement.enabled) {
    CFG.queueManagement.enabled = true;
    ensurePrinterPoolSchema(); // creates the protected Unassigned pool + persists
    // Auto-assign every currently-unmanaged printer — both systems of
    // record (config.json's printerPoolId, and QueueStore's own queueState)
    // need updating together (design doc A3).
    let changed = false;
    for (const p of PRINTERS) {
      // A monitor-only printer can never be dispatched to, so it is not
      // managed by the queue at all (see refuseMonitorOnly).
      if (printerIsMonitorOnly(p)) continue;
      if (!p.printerPoolId) { p.printerPoolId = PRINTER_POOL_DEFAULT_MANUAL_ID; changed = true; }
      if (queueStore.getPrinterState(p.id).queueState === "unmanaged") queueStore.assignPool(p.id);
    }
    if (changed) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch {} }
    auditLog.log({ category: "admin", event: "queue-management-enabled", ...actorFromReq(req) });
  }
  res.json({ ok: true });
});

app.post("/api/queue-management/disable", requireAdmin, (req, res) => {
  if (!CFG.queueManagement) CFG.queueManagement = {};
  CFG.queueManagement.enabled = false;
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch {}
  auditLog.log({ category: "admin", event: "queue-management-disabled", ...actorFromReq(req) });
  res.json({ ok: true });
});

// ---- Printer Pools (bed-clear policy) ----
function sanitizePrinterPool(p) { return { id: p.id, name: p.name, type: p.type, isDefault: !!p.isDefault, autoBalance: !!p.autoBalance }; }

app.get("/api/printer-pools", requireAuth, (req, res) => {
  const pools = CFG.printerPools || [];
  if (req.user.role !== "admin") return res.json(pools.map(sanitizePrinterPool));
  res.json(pools.map(p => ({ ...sanitizePrinterPool(p), bedClearOnDispatchFailure: !!p.bedClearOnDispatchFailure, createdAt: p.createdAt, updatedAt: p.updatedAt })));
});

app.post("/api/printer-pools", requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  if (!name) return res.status(400).json({ error: "Pool name required", code: "pool_name_required" });
  // Phase 1: only Manual pools exist — G-code/API land in Phase 2.
  if (b.type && b.type !== "manual") return res.status(400).json({ error: "Only Manual bed-clear pools are available right now" });
  if (!Array.isArray(CFG.printerPools)) CFG.printerPools = [];
  const now = new Date().toISOString();
  const pool = { id: newPrinterPoolId(), name, type: "manual", isDefault: false, bedClearOnDispatchFailure: false, autoBalance: false, createdAt: now, updatedAt: now };
  CFG.printerPools.push(pool);
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); }
  catch (e) { CFG.printerPools.pop(); return res.status(500).json({ error: e.message }); }
  auditLog.log({ category: "admin", event: "printer-pool-created", ...actorFromReq(req), detail: { poolId: pool.id, name } });
  res.json({ ok: true, pool });
});

app.put("/api/printer-pools/:id", requireAdmin, (req, res) => {
  const pool = (CFG.printerPools || []).find(p => p.id === req.params.id);
  if (!pool) return res.status(404).json({ error: "Pool not found", code: "pool_not_found" });
  const b = req.body || {};
  const prevName = pool.name, prevAutoBalance = !!pool.autoBalance;
  if (b.name !== undefined) {
    const name = String(b.name || "").trim();
    if (!name) return res.status(400).json({ error: "Pool name required", code: "pool_name_required" });
    pool.name = name;
  }
  if (b.bedClearOnDispatchFailure !== undefined) pool.bedClearOnDispatchFailure = !!b.bedClearOnDispatchFailure;
  if (b.autoBalance !== undefined) pool.autoBalance = !!b.autoBalance;
  pool.updatedAt = new Date().toISOString();
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); }
  catch (e) { pool.name = prevName; pool.autoBalance = prevAutoBalance; return res.status(500).json({ error: e.message }); }
  auditLog.log({ category: "admin", event: "printer-pool-updated", ...actorFromReq(req), detail: { poolId: pool.id, name: pool.name } });
  res.json({ ok: true, pool });
});

app.delete("/api/printer-pools/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  if (id === PRINTER_POOL_DEFAULT_MANUAL_ID) return res.status(400).json({ error: "The Unassigned pool can't be deleted" });
  const idx = (CFG.printerPools || []).findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: "Pool not found", code: "pool_not_found" });
  if (PRINTERS.some(p => p.printerPoolId === id)) return res.status(400).json({ error: "Printers are still assigned to this pool — reassign them first" });
  const removed = CFG.printerPools[idx];
  CFG.printerPools.splice(idx, 1);
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); }
  catch (e) { CFG.printerPools.splice(idx, 0, removed); return res.status(500).json({ error: e.message }); }
  auditLog.log({ category: "admin", event: "printer-pool-deleted", ...actorFromReq(req), detail: { poolId: id, name: removed.name } });
  res.json({ ok: true });
});

// Reassigning a printer's Printer Pool — separate from /api/config's
// general printer save, same reasoning as /api/printer-tags having its own
// dedicated endpoint: this touches QueueStore state, not just config.json.
app.post("/api/printer-pool", requireAdmin, (req, res) => {
  const { printer, printerId, printerPoolId } = req.body || {};
  // Prefers the persistent printer id when given — a Settings-tab row's DOM
  // position can briefly disagree with PRINTERS[]'s real order during an
  // unsaved drag-reorder, which a plain array index would silently trust.
  const p = printerId ? printerById(printerId) : PRINTERS[parseInt(printer, 10)];
  // code is additive alongside the existing error string — any other
  // consumer of this route that only ever read `error` keeps working
  // unchanged; the Settings > Printers tab's own frontend is the only
  // current caller that looks at `code`, to render a translated message
  // instead of this raw English fallback.
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  // Assigning a pool is what lets the queue dispatch prints to a printer, so a
  // monitor-only one is refused here; removing it from a pool stays allowed.
  if (printerPoolId && refuseMonitorOnly(p, res)) return;
  const qs = queueStore.getPrinterState(p.id);
  if (qs.queueState !== "idle" && qs.queueState !== "unmanaged") return res.status(409).json({ error: "This printer's queue must be idle before changing its pool", code: "queue_not_idle" });
  if (qs.queue.length) return res.status(409).json({ error: "Clear this printer's queue before changing its pool", code: "queue_not_empty" });

  if (!printerPoolId) {
    p.printerPoolId = undefined;
    queueStore.unassignPool(p.id);
  } else {
    const pool = (CFG.printerPools || []).find(x => x.id === printerPoolId);
    if (!pool) return res.status(400).json({ error: "Unknown printer pool", code: "unknown_pool" });
    p.printerPoolId = printerPoolId;
    queueStore.assignPool(p.id);
  }
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  auditLog.log({ category: "admin", event: "printer-pool-changed", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { printerPoolId: printerPoolId || null } });
  res.json({ ok: true, printerPoolId: p.printerPoolId || null });
});

// ---- Per-printer queue ----
app.get("/api/queue/:printerId", requireAuth, (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p || !printerVisibleTo(req.user, p)) return res.status(404).json({ error: "Unknown printer", code: "unknown_printer" });
  res.json({ printerId: p.id, printerPoolId: p.printerPoolId || null, ...redactQueueStateForResponse(queueStore.getPrinterState(p.id)) });
});

app.post("/api/queue/:printerId/items", requireRegular, (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer", code: "no_printer_access" });
  if (refuseMonitorOnly(p, res)) return;
  if (!p.printerPoolId) return res.status(400).json({ error: "This printer has no Printer Pool assigned" });
  const b = req.body || {};
  const files = Array.isArray(b.files) ? b.files : [];
  if (!files.length) return res.status(400).json({ error: "No files given" });

  const actor = actorFromReq(req);
  const items = [];
  for (const f of files) {
    const name = String((f || {}).name || "").trim();
    const sub = String((f || {}).sub || "");
    const qty = Math.max(1, Math.min(50, parseInt(f.quantity, 10) || 1));
    const fp = safePath(sub ? sub + "/" + name : name);
    if (!name || !fp || !fs.existsSync(fp)) return res.status(400).json({ error: "File not found: " + name });
    let hash;
    try { hash = queueStore.computeFileHash(fp); } catch { return res.status(400).json({ error: "Could not read file: " + name }); }
    for (let i = 0; i < qty; i++) {
      items.push({
        id: QueueEngine.newQueueItemId(), status: "queued", alreadyUploaded: false,
        file: { name, sub, sizeBytes: hash.sizeBytes, sha256: hash.sha256 },
        map: f.map || {}, prefs: f.prefs || {},
        createdAt: Date.now(), dispatchedAt: null, finishedAt: null,
        queuedBy: actor, retryOfItemId: null, dispatchSnapshot: null
      });
    }
  }

  const result = queueStore.applyIntent(p.id, (state) => ({ ...state, queue: [...state.queue, ...items], updatedAt: Date.now() }));
  if (!result.ok) return res.status(503).json({ error: "Could not save the queue right now — " + (result.reason || "unknown error"), code: "queue_save_failed", detail: result.reason || null });
  auditLog.log({ category: "job", event: "queue-item-added", ...actor, printerId: p.id, printerName: p.name, detail: { count: items.length } });
  if (b.startImmediately) attemptQueueDispatch(p.id).catch(e => console.error("[queue] immediate dispatch error:", e.message));
  res.json({ ok: true, added: items.length, state: redactQueueStateForResponse(result.nextState) });
});

app.delete("/api/queue/:printerId/items/:itemId", requireRegular, (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer", code: "no_printer_access" });
  const result = queueStore.applyIntent(p.id, (state) => {
    const idx = state.queue.findIndex(i => i.id === req.params.itemId);
    if (idx === -1) return state; // already gone — not an error
    const next = state.queue.slice();
    const [removed] = next.splice(idx, 1);
    return { ...state, queue: next, recentHistory: QueueEngine.pushHistory(state.recentHistory, { ...removed, status: "removed", finishedAt: Date.now() }), updatedAt: Date.now() };
  });
  if (!result.ok) return res.status(503).json({ error: "Could not save the queue right now", code: "queue_save_failed" });
  auditLog.log({ category: "job", event: "queue-item-removed", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { itemId: req.params.itemId } });
  res.json({ ok: true, state: redactQueueStateForResponse(result.nextState) });
});

// Reorder within one printer's queue, or move to a compatible printer in the
// same pool (design doc D8 — same-connector only in Phase 1, no
// dependency on the future Shared Queue matcher).
app.post("/api/queue/:printerId/items/:itemId/move", requireRegular, (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer", code: "no_printer_access" });
  const { toIndex, toPrinterId } = req.body || {};

  if (toPrinterId && toPrinterId !== p.id) {
    const target = printerById(toPrinterId);
    if (!target) return res.status(400).json({ error: "Unknown target printer" });
    if (!printerVisibleTo(req.user, target)) return res.status(403).json({ error: "You don't have access to the target printer" });
    if (target.printerPoolId !== p.printerPoolId) return res.status(400).json({ error: "Can only move between printers in the same Printer Pool" });
    if (!QueueEngine.printersCompatibleForMove(p, target)) return res.status(400).json({ error: "Target printer uses a different connector — the file's mapping wouldn't carry over" });

    const source = queueStore.getPrinterState(p.id);
    const item = source.queue.find(i => i.id === req.params.itemId);
    if (!item) return res.status(404).json({ error: "Item not found (already dispatched, or removed)" });

    const result = queueStore.applyBulkIntent((current) => {
      const src = current[p.id] || defaultQueuePrinterState();
      const dst = current[target.id] || defaultQueuePrinterState();
      return {
        [p.id]: { ...src, queue: src.queue.filter(i => i.id !== item.id), updatedAt: Date.now() },
        [target.id]: { ...dst, queue: [...dst.queue, item], updatedAt: Date.now() }
      };
    });
    if (!result.ok) return res.status(503).json({ error: "Could not save the queue right now", code: "queue_save_failed" });
    auditLog.log({ category: "job", event: "queue-item-moved", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { itemId: item.id, toPrinterId: target.id } });
    return res.json({ ok: true });
  }

  const result = queueStore.applyIntent(p.id, (state) => {
    const idx = state.queue.findIndex(i => i.id === req.params.itemId);
    if (idx === -1) return state;
    const next = state.queue.slice();
    const [item] = next.splice(idx, 1);
    const target = Math.max(0, Math.min(next.length, Number(toIndex) || 0));
    next.splice(target, 0, item);
    return { ...state, queue: next, updatedAt: Date.now() };
  });
  if (!result.ok) return res.status(503).json({ error: "Could not save the queue right now", code: "queue_save_failed" });
  res.json({ ok: true, state: redactQueueStateForResponse(result.nextState) });
});

app.post("/api/queue/:printerId/pause", requireRegular, (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer", code: "no_printer_access" });
  const result = queueStore.applyIntent(p.id, QueueEngine.pauseQueue);
  if (!result.ok) return res.status(503).json({ error: "Could not save the queue right now", code: "queue_save_failed" });
  auditLog.log({ category: "job", event: "queue-paused", ...actorFromReq(req), printerId: p.id, printerName: p.name });
  res.json({ ok: true, state: redactQueueStateForResponse(result.nextState) });
});

// A single "Resume Queue" action handles both cases — clearing a plain
// pause needs no reconciliation, but clearing a Stop always re-probes the
// printer live first (design doc D3): a printer that sat stopped for a
// while could have had something started on it manually in the meantime.
app.post("/api/queue/:printerId/resume", requireRegular, async (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer", code: "no_printer_access" });
  const qs = queueStore.getPrinterState(p.id);

  let result;
  if (qs.queueStopped) {
    let probe;
    try { probe = await getConnector(p.connector).probe(p); } catch { probe = { online: false }; }
    result = queueStore.applyIntent(p.id, QueueEngine.resumeFromStop, probe);
  } else {
    result = queueStore.applyIntent(p.id, QueueEngine.resumeQueue);
  }
  if (!result.ok) return res.status(503).json({ error: "Could not save the queue right now", code: "queue_save_failed" });
  auditLog.log({ category: "job", event: "queue-resumed", ...actorFromReq(req), printerId: p.id, printerName: p.name });
  attemptQueueDispatch(p.id).catch(e => console.error("[queue] post-resume dispatch error:", e.message));
  res.json({ ok: true, state: redactQueueStateForResponse(result.nextState) });
});

app.post("/api/queue/:printerId/stop", requireRegular, (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer", code: "no_printer_access" });
  const result = queueStore.applyIntent(p.id, QueueEngine.stopQueue);
  if (!result.ok) return res.status(503).json({ error: "Could not save the queue right now", code: "queue_save_failed" });
  auditLog.log({ category: "job", event: "queue-stopped", ...actorFromReq(req), printerId: p.id, printerName: p.name });
  res.json({ ok: true, state: redactQueueStateForResponse(result.nextState) });
});

// Clear — the actual "abort everything" action Stop deliberately isn't
// (Stop only blocks the next auto-dispatch; the current print, if any, keeps
// running and every queued item stays queued). This cancels whatever's
// physically printing right now, then wipes the rest of the queue.
app.post("/api/queue/:printerId/clear", requireRegular, async (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer", code: "no_printer_access" });
  const qs = queueStore.getPrinterState(p.id);
  // A monitor-only printer can only still hold queue state from before its
  // connector was switched; SnapCon cannot cancel on it, and refusing the
  // Clear would leave that queue stuck for good — so the queue is cleared and
  // the print, if any, left to the operator.
  const wasPrinting = (qs.queueState === "dispatching" || qs.queueState === "printing") && !printerIsMonitorOnly(p);
  if (wasPrinting) {
    try { await getConnector(p.connector).cancel(p); }
    catch (e) { return res.status(502).json({ error: "Could not cancel the current print: " + e.message }); }
  }
  const removedQueuedCount = qs.queue.length;
  const result = queueStore.applyIntent(p.id, QueueEngine.clearQueue);
  if (!result.ok) return res.status(503).json({ error: "Could not save the queue right now", code: "queue_save_failed" });
  auditLog.log({ category: "job", event: "queue-cleared", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { cancelledCurrent: wasPrinting, removedQueuedCount } });
  res.json({ ok: true, state: redactQueueStateForResponse(result.nextState) });
});

// Manual bed-clear confirmation — always a real, audited, server-side
// action (Correction 2), never a client-only state flip.
app.post("/api/queue/:printerId/confirm-bed-clear", requireRegular, (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer", code: "no_printer_access" });
  const actor = actorFromReq(req);
  const result = queueStore.confirmManualBedClear(p.id, actor);
  if (!result.ok) return res.status(409).json({ error: "Could not confirm right now — " + (result.reason || "invalid state") });
  const hadWork = result.nextState.queue.length > 0;
  result.auditEvent.detail.resultedInDispatch = hadWork;
  auditLog.log(result.auditEvent);
  if (hadWork) attemptQueueDispatch(p.id).catch(e => console.error("[queue] post-confirm dispatch error:", e.message));
  res.json({ ok: true, state: redactQueueStateForResponse(result.nextState) });
});

// Resolving queue_attention_required — Resume re-verifies the printer's
// LIVE state before allowing it (never trust what was recorded at the
// moment of failure) and, if legal, actually tells the printer to resume
// before the queue's own state catches up to match.
app.post("/api/queue/:printerId/resolve", requireRegular, async (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer", code: "no_printer_access" });
  const { action } = req.body || {};

  if (action === "resume") {
    let probe;
    try { probe = await getConnector(p.connector).probe(p); } catch { probe = { online: false }; }
    if (!probe.online || probe.state !== "paused") return res.status(409).json({ error: "This printer isn't in a resumable state right now" });
    try { await getConnector(p.connector).resume(p); }
    catch (e) { return res.status(502).json({ error: "Resume failed: " + e.message }); }
  }

  const result = queueStore.applyIntent(p.id, QueueEngine.resolveAttention, action);
  if (!result.ok) return res.status(400).json({ error: result.reason === "invalid-transition" ? (result.error && result.error.message) : "Could not resolve right now" });
  auditLog.log({ category: "job", event: "queue-attention-resolved", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { action } });
  if (result.nextState.queueState === "idle" || result.nextState.queueState === "dispatching") {
    attemptQueueDispatch(p.id).catch(e => console.error("[queue] post-resolve dispatch error:", e.message));
  }
  res.json({ ok: true, state: redactQueueStateForResponse(result.nextState) });
});

// file-changed's dedicated accept path — forces a fresh, uncached hash
// (round-4 issue #7) rather than trusting anything cached, since this IS
// the moment identity itself is being decided.
app.post("/api/queue/:printerId/accept-file-change", requireRegular, (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer", code: "no_printer_access" });
  const qs = queueStore.getPrinterState(p.id);
  if (qs.attentionReason !== "file-changed" || !qs.currentItem) return res.status(409).json({ error: "Nothing to accept right now" });
  const item = qs.currentItem;
  const fp = safePath((item.file.sub ? item.file.sub + "/" : "") + item.file.name);
  if (!fp || !fs.existsSync(fp)) return res.status(400).json({ error: "File no longer exists" });
  let hash;
  try { hash = queueStore.computeFileHash(fp, { force: true }); } catch (e) { return res.status(400).json({ error: e.message }); }
  const actor = actorFromReq(req);
  const result = queueStore.applyIntent(p.id, QueueEngine.acceptFileChange, { sizeBytes: hash.sizeBytes, sha256: hash.sha256, actor });
  if (!result.ok) return res.status(400).json({ error: "Could not accept the file change" });
  auditLog.log({ category: "job", event: "queue-file-change-accepted", ...actor, printerId: p.id, printerName: p.name, detail: { file: item.file.name } });
  attemptQueueDispatch(p.id).catch(e => console.error("[queue] post-accept dispatch error:", e.message));
  res.json({ ok: true, state: redactQueueStateForResponse(result.nextState) });
});

// ---- Bulk "Send to Queue" (file-manager multiselect → Printer Pool) ----
app.post("/api/queue/send", requireRegular, (req, res) => {
  const b = req.body || {};
  const files = Array.isArray(b.files) ? b.files : [];
  const poolId = b.poolId;
  const mode = b.mode === "distribute" ? "distribute" : "print-on-all";
  if (!files.length) return res.status(400).json({ error: "No files given" });
  const pool = (CFG.printerPools || []).find(x => x.id === poolId);
  if (!pool) return res.status(400).json({ error: "Unknown printer pool", code: "unknown_pool" });
  const targetPrinters = PRINTERS.filter(p => p.printerPoolId === poolId && printerVisibleTo(req.user, p) && !printerIsMonitorOnly(p));
  if (!targetPrinters.length) return res.status(400).json({ error: "No printers available in this pool" });

  // Validate + resolve every file BEFORE computing or writing anything —
  // one invalid file fails the whole request, never a partial distribution
  // (round-4 issue #2).
  const resolved = [];
  for (const f of files) {
    const name = String((f || {}).name || "").trim();
    const sub = String((f || {}).sub || "");
    const qty = Math.max(1, Math.min(50, parseInt(f.quantity, 10) || 1));
    const fp = safePath(sub ? sub + "/" + name : name);
    if (!name || !fp || !fs.existsSync(fp)) return res.status(400).json({ error: "File not found: " + name });
    let hash;
    try { hash = queueStore.computeFileHash(fp); } catch { return res.status(400).json({ error: "Could not read file: " + name }); }
    resolved.push({ name, sub, qty, sizeBytes: hash.sizeBytes, sha256: hash.sha256, map: f.map || {}, prefs: f.prefs || {} });
  }

  const actor = actorFromReq(req);
  const makeItem = (f) => ({
    id: QueueEngine.newQueueItemId(), status: "queued", alreadyUploaded: false,
    file: { name: f.name, sub: f.sub, sizeBytes: f.sizeBytes, sha256: f.sha256 },
    map: f.map, prefs: f.prefs, createdAt: Date.now(), dispatchedAt: null, finishedAt: null,
    queuedBy: actor, retryOfItemId: null, dispatchSnapshot: null
  });
  // Quantity is expanded into a flat list of individual entries before
  // distribution — Distribute's round-robin never has to know "quantity" is
  // a separate concept (design doc A5).
  const expanded = [];
  for (const f of resolved) for (let i = 0; i < f.qty; i++) expanded.push(f);

  const result = queueStore.applyBulkIntent((current) => {
    const updates = {};
    targetPrinters.forEach(p => { updates[p.id] = { ...(current[p.id] || defaultQueuePrinterState()), queue: [...((current[p.id] || defaultQueuePrinterState()).queue)], updatedAt: Date.now() }; });
    if (mode === "print-on-all") {
      targetPrinters.forEach(p => { updates[p.id].queue.push(...expanded.map(makeItem)); });
    } else {
      expanded.forEach((f, i) => { updates[targetPrinters[i % targetPrinters.length].id].queue.push(makeItem(f)); });
    }
    return updates;
  });
  if (!result.ok) return res.status(503).json({ error: "Could not save the queue right now", code: "queue_save_failed" });
  auditLog.log({ category: "job", event: "queue-bulk-send", ...actor, detail: { poolId, mode, fileCount: resolved.length, totalItems: expanded.length, printerCount: targetPrinters.length } });
  if (b.startImmediately) targetPrinters.forEach(p => attemptQueueDispatch(p.id).catch(e => console.error("[queue] bulk-send dispatch error:", e.message)));
  res.json({ ok: true, printers: targetPrinters.map(p => p.id), totalItems: expanded.length });
});

// ---- Global store status/controls (round-4 issue #1/#8) ----
app.get("/api/queue-store/status", requireAuth, (req, res) => res.json(queueStore.getGlobalStatus()));
app.post("/api/queue-store/retry-save", requireAdmin, (req, res) => {
  const r = queueStore.retrySave();
  auditLog.log({ category: "admin", event: r.ok ? "queue-store-recovered" : "queue-store-retry-failed", ...actorFromReq(req) });
  res.json(r);
});
app.post("/api/queue-store/stop-all", requireAdmin, (req, res) => {
  queueStore.stopAll();
  auditLog.log({ category: "admin", event: "queue-store-stopped-by-admin", ...actorFromReq(req) });
  res.json({ ok: true });
});
app.post("/api/queue-store/resume-all", requireAdmin, (req, res) => {
  queueStore.resumeAll();
  auditLog.log({ category: "admin", event: "queue-store-resumed-by-admin", ...actorFromReq(req) });
  res.json({ ok: true });
});
app.post("/api/queue-store/acknowledge-reset", requireAdmin, (req, res) => {
  const r = queueStore.acknowledgeReset((req.body || {}).confirm);
  if (!r.ok) return res.status(400).json(r);
  auditLog.log({ category: "admin", event: "queue-store-reset-acknowledged", ...actorFromReq(req) });
  res.json(r);
});
app.get("/api/queue-store/corrupt-files/:name", requireAdmin, (req, res) => {
  const p = queueStore.getCorruptFilePath(req.params.name);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: "Not found" });
  res.download(p);
});

// Mirrors /api/notify-test's "test the live form values, not necessarily
// saved ones" UX — works before the Resend settings have been saved.
// Tests whichever OTP provider is currently selected in the (possibly
// unsaved) form — same "test the live values" convention as /api/notify-test.
app.post("/api/otp-test", requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (b.service === "ntfy") {
    const topic = (typeof b.ntfyTopic === "string" && b.ntfyTopic.trim()) ? b.ntfyTopic.trim() : ((CFG.otp && CFG.otp.ntfyTopic) || "");
    if (!topic) return res.status(400).json({ error: "Enter a topic first", code: "missing_topic" });
    try {
      await sendNtfy({ topic, title: "SnapCon OTP test", message: "This is a test OTP notification from SnapCon." });
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
    return;
  }
  if (b.service === "telegram") {
    // Bot token always comes from Notifications — see the comment on
    // publicCfg()'s otp.telegramBotConfigured for why OTP doesn't have its
    // own.
    const botToken = (CFG.notifications && CFG.notifications.telegramBotToken) || "";
    const chatId = (typeof b.chatId === "string" && b.chatId.trim()) ? b.chatId.trim() : ((CFG.otp && CFG.otp.telegramChatId) || "");
    if (!botToken) return res.status(400).json({ error: "Configure a Telegram bot on the Notifications tab first", code: "missing_bot_config" });
    if (!chatId) return res.status(400).json({ error: "Enter a chat ID first", code: "missing_chat_id" });
    try {
      await sendTelegram({ botToken, chatId, message: "This is a test OTP message from SnapCon." });
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
    return;
  }
  const apiKey = (typeof b.apiKey === "string" && b.apiKey.trim()) ? b.apiKey.trim() : ((CFG.resend && CFG.resend.apiKey) || "");
  const fromAddress = String(b.fromAddress || (CFG.resend && CFG.resend.fromAddress) || "").trim();
  const to = String(b.to || "").trim();
  if (!apiKey) return res.status(400).json({ error: "Enter a Resend API key first", code: "missing_api_key" });
  if (!fromAddress) return res.status(400).json({ error: "Enter a from-address first", code: "missing_from_address" });
  if (!to) return res.status(400).json({ error: "Enter a test recipient address", code: "missing_recipient" });
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
    // A printer-reported countdown (Bambu Lab) wins over extrapolating from
    // elapsed/progress, same rule as the dashboard's fmtRemaining().
    const rem = (typeof st.remaining === "number" && Number.isFinite(st.remaining)) ? st.remaining
      : (st.progress > 0 && st.elapsed > 0) ? st.elapsed * (1 / st.progress - 1) : null;
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

// Fires the same event to every ENABLED provider independently — one
// provider being misconfigured (bad bot token, dead topic) must never
// silently block the other from delivering. Only surfaces an error up to
// the caller (notifyTick's catch, which just logs) if every attempted
// provider failed; a partial failure is logged per-provider here instead.
async function sendEventNotification(idx, p, ev, st) {
  const nf = CFG.notifications || {};
  const message = eventMessage(ev, st);
  let image = null;
  if (nf.includeImage) {
    try { image = await getSnapshot(p); }
    catch { /* no camera — send the text anyway */ }
  }
  const jobs = [];
  if (nf.ntfyEnabled) {
    jobs.push(sendNtfy({
      topic: nf.ntfyTopic, title: p.name, message, image,
      iconUrl: "http://" + lanAddr() + "/snapcon-icon-512.png"
    }).catch(e => { throw new Error("ntfy.sh: " + e.message); }));
  }
  if (nf.telegramEnabled) {
    // Telegram has no separate "title" field the way ntfy does — fold the
    // printer name into the message text instead.
    jobs.push(sendTelegram({ botToken: nf.telegramBotToken, chatId: nf.telegramChatId, message: p.name + ": " + message, image })
      .catch(e => { throw new Error("Telegram: " + e.message); }));
  }
  if (nf.webhookEnabled) {
    // sendWebhook already redacts its own errors; the prefix stays generic so
    // the destination is never named in a failure line either.
    jobs.push(sendWebhook({
      url: nf.webhookUrl, format: nf.webhookFormat, printerName: p.name,
      message, event: ev, st, image
    }).catch(e => { throw new Error("Webhook: " + e.message); }));
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.filter(r => r.status === "rejected");
  // redactUrls here as well as inside sendWebhook: this line concatenates
  // messages from every provider, and a future one could carry a URL too.
  if (failed.length) console.log("notify: " + p.name + ": " + redactUrls(failed.map(r => r.reason.message).join("; ")));
  if (failed.length && failed.length === results.length) throw new Error(failed[0].reason.message);
}

// ---- Notification watcher ----
// Polls printer state on its own schedule (independent of any open browser),
// fires event notifications on state transitions and milestone notifications
// when a print crosses one of the configured percentages. Reads CFG live, so
// settings changes apply without a restart.
const NOTIFY_POLL_MS = 30 * 1000;
const NOTIFY_STATE = new Map();   // printer url -> { state, filename, progress, milestones:Set }
const DEFAULT_MILESTONES = [25, 50, 75];

async function notifyTick() {
  const nf = CFG.notifications || {};
  const ntfyReady = !!nf.ntfyEnabled && !!nf.ntfyTopic;
  const telegramReady = !!nf.telegramEnabled && !!nf.telegramChatId && !!nf.telegramBotToken;
  const webhookReady = !!nf.webhookEnabled && !!nf.webhookUrl;
  // Whether the Notifications feature itself can fire anything right now —
  // gates ONLY the actual sendEventNotification calls below. State tracking
  // (prev/cur diffing, newJob detection) and the audit-log calls that ride on
  // it run unconditionally, regardless of this — see the notifyTick refactor
  // in the Audit plan: a job started/finished on a printer's own screen must
  // still be logged even with Notifications turned off entirely.
  const notifyReady = !!nf.enabled && (ntfyReady || telegramReady || webhookReady);
  const canNotifyEvent = notifyReady && (nf.onStart || nf.onPause || nf.onError || nf.onComplete);
  const canNotifyIntervals = notifyReady && nf.onIntervals;
  const milestones = (Array.isArray(nf.milestonePercents) && nf.milestonePercents.length) ? nf.milestonePercents : DEFAULT_MILESTONES;

  await Promise.all(PRINTERS.map(async (p, i) => {
    const st = await probeCached(p);
    if (!st.online) return;

    // A printer that was unreachable during startup reconciliation
    // (round-3 issue #11) gets a real reconciliation attempt the moment a
    // regular poll finally reaches it — no separate retry loop needed, this
    // rides on the fleet poll that already exists.
    if (p.printerPoolId && queueStore.getPrinterState(p.id).reconciliationPending) {
      queueStore.applyObserved(p.id, QueueEngine.reconcileOnStartup, { online: true, state: st.state, filename: st.filename });
      queueStore.setReconciliationPending(p.id, false);
    }

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
      milestones.forEach(m => { if (cur.progress * 100 >= m) cur.milestones.add(m); });
      NOTIFY_STATE.set(p.url, cur);
      return;
    }
    NOTIFY_STATE.set(p.url, cur);

    // Audit: printer-observed, not SnapCon-attributable — userId/userLabel
    // both null, same as any other action that happened directly on the
    // printer's own screen rather than through this app. Runs every tick,
    // independent of whether Notifications is even configured. Skips
    // logging a start already recorded (with the real user) by /api/print or
    // /api/printfile the moment they kicked it off — this is only reached
    // for a start ROUTE_STARTED_PRINT never saw at all, i.e. one that began
    // directly on the printer's own screen.
    if (newJob) {
      if (!ROUTE_STARTED_PRINT.delete(p.url)) {
        auditLog.log({ category: "job", event: "print-started", printerId: p.id, printerName: p.name, detail: { file: st.filename } });
      }
    } else if (st.state !== prev.state) {
      if (st.state === "complete") {
        // Klipper's filament_used is raw extruded length in mm — the printer
        // reports no diameter/density, so a gram figure is only ever an
        // estimate (standard 1.75mm filament at PLA-like density, ~1.24
        // g/cm³; genuinely off for TPU/ABS/other diameters). Cost is
        // estimated from the rates configured RIGHT NOW, at completion time
        // — a historical log entry should reflect what a print likely cost
        // when it ran, not get silently recomputed against whatever
        // Settings says the next time someone views the Logs tab.
        const filamentUsedMm = st.filamentUsed;
        const filamentGramsEst = (typeof filamentUsedMm === "number") ? filamentUsedMm * 0.002982 : null;
        const elapsedSec = st.elapsed;
        const hours = (typeof elapsedSec === "number") ? elapsedSec / 3600 : 0;
        const fCost = (CFG.filamentCost > 0 && filamentGramsEst) ? (CFG.filamentCost / 1000) * filamentGramsEst : 0;
        const eCost = (CFG.electricityRate > 0 && hours) ? CFG.electricityRate * hours : 0;
        const costEst = (fCost + eCost) > 0 ? Math.round((fCost + eCost) * 100) / 100 : null;
        auditLog.log({ category: "job", event: "print-completed", printerId: p.id, printerName: p.name, detail: { file: st.filename, elapsedSec, filamentUsedMm, filamentGramsEst, costEst } });
      } else if (st.state === "error" || st.state === "cancelled") {
        // A "cancelled" state can be the direct downstream result of a
        // printer error the 30s poll interval never caught as its own
        // separate "error" state (the printer auto-cancels, or something
        // cancels in response to the error, all inside one poll window) —
        // st.message/st.errorCode reflect the printer's own print_stats
        // regardless of which state it settled on by the time this polls,
        // so surfacing them here is the only way "cancelled" ever explains
        // itself as error-caused rather than a plain, deliberate cancel.
        // Not every connector exposes these (FlashForge only populates
        // message while status is literally "error"), so this degrades to
        // just the filename wherever they're not available.
        const detail = { file: st.filename };
        if (st.message) detail.reason = st.message;
        if (st.errorCode) detail.errorCode = st.errorCode;
        auditLog.log({ category: "job", event: "print-" + st.state, printerId: p.id, printerName: p.name, detail });
      }
    }

    // Queue Management: reuses this same state-diffing to drive
    // onProbeComplete/onProbeFailedOrCancelled — only for a printer whose
    // queue actually believes it's "printing" right now (a print started
    // outside the queue, e.g. directly on the printer's touchscreen, never
    // entered "printing" from the queue's perspective, so there's nothing
    // here for it to advance). "resumable" is deliberately recorded false at
    // detection time — resolveAttention's Resume action re-checks the LIVE
    // probe itself rather than trusting a snapshot that could be stale by
    // the time a human actually clicks it.
    if (!newJob && st.state !== prev.state) {
      const qState = queueStore.getPrinterState(p.id);
      if (qState.queueState === "printing") {
        if (st.state === "complete") {
          queueStore.applyObserved(p.id, QueueEngine.onProbeComplete);
        } else if (st.state === "error" || st.state === "cancelled") {
          queueStore.applyObserved(p.id, QueueEngine.onProbeFailedOrCancelled, false, { code: st.state, message: st.message || ("Print " + st.state) });
        }
      }
    }

    try {
      if (canNotifyEvent) {
        if (newJob) {
          if (nf.onStart) await sendEventNotification(i, p, "start", st);
        } else if (st.state !== prev.state) {
          if (st.state === "complete" && nf.onComplete) await sendEventNotification(i, p, "complete", st);
          else if (st.state === "paused" && nf.onPause) await sendEventNotification(i, p, "paused", st);
          // "cancelled" is folded into the same "error or failure" toggle as
          // "error" — from a notification's point of view both mean the same
          // thing: this print did not reach complete on its own.
          else if ((st.state === "error" || st.state === "cancelled") && nf.onError) await sendEventNotification(i, p, st.state, st);
        }
      }
      if (canNotifyIntervals && st.state === "printing") {
        for (const m of milestones) {
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
  const service = (b.service === "telegram" || b.service === "webhook") ? b.service : "ntfy";
  if (!PRINTERS.length) return res.status(400).json({ error: "Add a printer first", code: "no_printers" });
  const p = PRINTERS[0]; // any configured printer works for a connectivity test

  try {
    const st = await getConnector(p.connector).probe(p);
    if (!st.online) return res.status(502).json({ error: p.name + " is offline: " + (st.error || ""), code: "printer_offline", name: p.name, detail: st.error || "" });
    const ev = st.state || "idle"; // test uses the live state as the event
    let message = eventMessage(ev, st);
    let image = null;
    if (b.includeImage !== false) {
      try { image = await getSnapshot(p); }
      catch (e) { message += "\n(camera unavailable: " + e.message + ")"; }
    }
    if (service === "webhook") {
      // Same "test the form's current value, fall back to what's saved"
      // convention as the Telegram branch below — works before Save too.
      const url = (typeof b.webhookUrl === "string" && b.webhookUrl.trim()) ? b.webhookUrl.trim() : (nf.webhookUrl || "");
      const format = b.webhookFormat === "json" ? "json" : "discord";
      if (!url) return res.status(400).json({ error: "Enter a webhook URL first", code: "missing_webhook_url" });
      await sendWebhook({ url, format, printerName: p.name, message, event: ev, st, image });
      return res.json({ ok: true, service, printer: p.name });
    }
    if (service === "telegram") {
      const chatId = String(b.chatId || nf.telegramChatId || "").trim();
      // Same "test with the form's current value, fall back to what's saved"
      // convention as the OTP/Resend test buttons — works before Save too.
      const botToken = (typeof b.botToken === "string" && b.botToken.trim()) ? b.botToken.trim() : (nf.telegramBotToken || "");
      if (!chatId) return res.status(400).json({ error: "Enter a Telegram chat ID first", code: "missing_chat_id" });
      if (!botToken) return res.status(400).json({ error: "Enter a Telegram bot token first", code: "missing_bot_token" });
      await sendTelegram({ botToken, chatId, message: p.name + ": " + message, image });
      return res.json({ ok: true, service, printer: p.name });
    }
    const topic = String(b.topic || nf.ntfyTopic || "").trim();
    if (!/^[-_A-Za-z0-9]{1,64}$/.test(topic)) return res.status(400).json({ error: "Enter a valid ntfy topic first", code: "invalid_topic" });
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

// Settings > Printers "Test connection" — unlike /api/probe-printer above
// (which hits a Klipper-only endpoint directly), this goes through the
// connector abstraction so it works for every brand, and doesn't require
// the printer to already be saved in PRINTERS (url/connector come straight
// from the form, so this also works while adding a new printer).
// POST rather than GET: FlashForge authenticates every request with a
// checkCode, and a secret has no business in a query string (server logs,
// browser history, Referer). Credentials come from the submitted form rather
// than the saved config because Test has to work on a printer row that hasn't
// been saved yet — that's most of what the button is for.
app.post("/api/test-connection", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const url = String(b.url || "").trim().replace(/\/+$/, "");
  if (!url) return res.status(400).json({ error: "url required" });
  const conn = getConnector(b.connector);
  // Mirrors the subset of sanitizePrinter()'s shape that the probe path
  // actually reads, so a passing test means those same credentials will still
  // work once the row is saved. Without serial/verificationCode here, every
  // FlashForge test failed with the printer's own "SN is different" no matter
  // what the user had typed. `name` is included because ffPost interpolates it
  // into its unreachable-printer message.
  const p = { url, name: String(b.name || "").trim() || url };
  if (b.serial) p.serial = String(b.serial);
  // Same 8-char cap sanitizePrinter() applies, so a code that would be
  // truncated on save can't quietly pass the test at full length.
  if (b.verificationCode) p.verificationCode = String(b.verificationCode).slice(0, 8);
  try {
    const st = await conn.probe(p);
    if (!st.online) return res.status(502).json({ error: st.error || "Could not reach printer" });
    let firmware = null;
    if (conn.capabilities.firmwareInfo && conn.getFirmwareInfo) {
      try {
        const fw = await conn.getFirmwareInfo(p, st);
        if (!fw.skipped) firmware = fw;
      } catch { /* firmware is a bonus, not required for a successful test */ }
    }
    res.json({ ok: true, state: st.state, bed: st.bed, firmware });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
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

// ---- Queue Management: startup crash recovery (design doc Part E) ----
// Only states that could plausibly be "mid-something" at the moment of a
// crash need reconciling — idle/unmanaged/awaiting_bed_clear (Manual, just
// waiting on a human)/queue_attention_required/queue_stopped-flagged are all
// safe to simply resume exactly as persisted.
const QUEUE_RECONCILE_STATES = new Set(["dispatching", "printing", "bed_clear_running"]);
async function reconcileQueuesOnStartup() {
  if (!CFG.queueManagement || !CFG.queueManagement.enabled) return;
  for (const p of PRINTERS) {
    if (!p.printerPoolId) continue;
    const qs = queueStore.getPrinterState(p.id);
    if (!QUEUE_RECONCILE_STATES.has(qs.queueState)) continue;
    let probe;
    try { probe = await getConnector(p.connector).probe(p); }
    catch { probe = { online: false }; }
    if (!probe.online) {
      // Can't reach it right now — this is a SOFTER, "we don't know yet"
      // signal than a confirmed mismatch (round-3 issue #11), not treated
      // the same. The regular fleet poll picks this back up the moment it
      // actually reaches the printer (see notifyTick).
      queueStore.setReconciliationPending(p.id, true);
      continue;
    }
    const result = queueStore.applyObserved(p.id, QueueEngine.reconcileOnStartup, probe);
    if (result.nextState.attentionReason) {
      auditLog.log({ category: "job", event: "queue-recovery-review-needed", printerId: p.id, printerName: p.name, detail: { reason: result.nextState.attentionReason } });
    }
  }
}

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
  reconcileQueuesOnStartup().catch(e => console.error("[queue] startup reconciliation failed:", e.message));
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
