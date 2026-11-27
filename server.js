// server.js — SnapCon  ·  v2026.11.1
// Watches a folder of sliced gcode, shows the toolhead/color map per file,
// and pushes the chosen file to the chosen printer via Moonraker (server-side,
// so no browser CORS headaches).

const VERSION = "2026.11.1";

const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const readline = require("readline");
const { parseGcodeMap, parseGcodeMapLines } = require("./parser");
const threemf = require("./threemf");
const auth = require("./auth");
const { getConnector, listConnectorTypes, isVirtualType, getCapabilities, getAddress, CONNECTOR_TYPES, DEFAULT_TYPE: DEFAULT_CONNECTOR_TYPE } = require("./connectors");
const { isValidHost, normalizePort, parseAddressUrl, composeAddressUrl } = require("./connectors/address");
const connHttp = require("./connectors/http-utils");
// Firmware flashing lives outside the connector interface on purpose (see
// that module's header) — it is required directly, by the one route that
// drives it, and only ever for printers whose connector advertises
// firmwareDeploy.
const u1Firmware = require("./connectors/snapmaker-u1-firmware");
const firmwareImage = require("./connectors/firmwareImage");
const { createRemoteAccessService } = require("./remote-access/RemoteAccessService");
const { createAuditLog } = require("./audit/AuditLog");
const { createUtilization } = require("./utilization");
const { createLibraryService, LibraryError, GCODE_ROOT } = require("./library/LibraryService");
const { checkReachable, netfsFsp } = require("./library/locations");
// Every filesystem call that can touch the G-code folder (often a NAS share)
// goes through netfs: it runs in dedicated worker threads, so a dead NAS can
// fail those calls but can never freeze the server or starve local file work.
const netfs = require("./netfs").getNetFs();
// Uploads in progress: to a printer, a firmware image, or into the G-code
// folder. The Library's indexer pauses its reads while any is running
// (docs/library-design.md §6.1), so a scan never competes with them.
let UPLOADS_ACTIVE = 0;
async function whileUploading(fn) { UPLOADS_ACTIVE++; try { return await fn(); } finally { UPLOADS_ACTIVE--; } }
const { registerLibraryRoutes } = require("./library/routes");
const { createSyncEngine } = require("./sync/SyncEngine");
const { loadConfigFile, replaceConfigFile, resolveConfigLocation, checkConfigDir, readConfigStrict, isMountPoint } = require("./configLoader");
const locales = require("./locales");
const { ensureNotifyToken, timingSafeTokenEqual } = require("./notifyToken");
const { isPathWithinFolder, resolveWithinFolder } = require("./pathSafety");
const fileTrash = require("./fileTrash");
const { createFleetProbe, keyOf: fleetProbeKeyOf } = require("./fleetProbe");
const { sendWebhook, redactUrls } = require("./webhookNotify");
// Shared with the browser (served from public/): the one place slicer metadata
// and connector knowledge become a printer identity.
const PrinterIdentity = require("./public/printer-identity.js");
const Rediscover = require("./public/rediscover.js");

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

// config.json sits beside the application unless SNAPCON_CONFIG_DIR names a
// folder for it (the Docker layout: a mounted folder, so config.json can be
// replaced as a whole — configLoader.js). With a settings folder, a
// config.json that cannot be used, or a missing one on an installation that
// has been used before, stops the start here, before anything is loaded,
// written or served: starting with defaults would switch user accounts off.
// The settings read by that check are the ones the first loadConfig() below
// starts with (CONFIG_START_LOAD) — the file is not read a second time.
// This applies to the --load process too.
const CONFIG_LOCATION = resolveConfigLocation({ baseDir: BASE_DIR });
const CONFIG_PATH = CONFIG_LOCATION.configPath;
const CONFIG_DEFAULTS = { gcodeFolder: "./gcode", port: 4545, printers: [] };
let CONFIG_START_LOAD = null;
if (CONFIG_LOCATION.configDir) {
  const check = checkConfigDir({ ...CONFIG_LOCATION, baseDir: BASE_DIR, defaultCfg: CONFIG_DEFAULTS });
  if (!check.ok) {
    console.error("[config] " + check.message.split("\n").join("\n[config] "));
    process.exit(78);   // EX_CONFIG
  }
  CONFIG_START_LOAD = check.load;
} else if (isMountPoint(CONFIG_PATH)) {
  console.warn("[config] " + CONFIG_PATH + " is mounted as a single file. SnapCon runs, but changing a printer's pool and switching Queue Management on or off cannot be saved in this layout. Mount a settings folder instead: see docs/docker-config-migration.md.");
}
const USERS_PATH = path.join(BASE_DIR, "users.json");
const QUEUED_FILE_PATH = path.join(BASE_DIR, "queued-files.json");
const NOTIFY_TOKEN_PATH = path.join(BASE_DIR, "notify-token.json");
const DEFAULT_CFG = CONFIG_DEFAULTS;
// Runtime, writable, per-install (BASE_DIR) — never the bundled read-only
// tree. LOCALES_DEFAULT_DIR ships the canonical originals and is only ever
// read from, to seed LOCALES_DIR on first run (see locales.seedDefaultLocales).
const LOCALES_DIR = path.join(BASE_DIR, "locales");
const LOCALES_DEFAULT_DIR = path.join(ASSET_DIR, "locales-default");
let LOCALE_REGISTRY = { locales: {}, errors: [] };
function refreshLocaleRegistry() { LOCALE_REGISTRY = locales.scanLocales(LOCALES_DIR); }

// Live config — editable from the Settings page, no restart needed.
let CFG, FOLDER, PRINTERS;
// PRINTERS is the printers SnapCon runs: every one in config.json, except
// virtual printers (the Simulator, the Virtual U1) while Settings › General ›
// Enable virtual printers is off. Those stay in CFG.printers untouched and
// come back unchanged when it is turned on; nothing else sees them — no
// fleet row, no probe, no route, no pool, no queue dispatch. A new array,
// the same printer objects: an edit to a printer reaches CFG.printers too,
// and a save keeps the hidden ones (POST /api/config).
function activePrinters(cfg) {
  const all = Array.isArray(cfg.printers) ? cfg.printers : [];
  return cfg.virtualPrintersEnabled === true ? all : all.filter(p => !isVirtualType(p.connector));
}
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
  let result = CONFIG_START_LOAD;
  CONFIG_START_LOAD = null;
  if (!result) {
    if (CONFIG_LOCATION.configDir) {
      // With a settings folder a reload never falls back to defaults and
      // never sets the file aside: if config.json is missing or unusable the
      // settings in memory stay and CONFIG_LOAD_FAILED is set. That flag is
      // not a write lock: only the paths that consult it (the ensure*Schema
      // migrations, the queue and pool saves, a few routes) refuse to write;
      // the other Settings write sites still write the file.
      const read = readConfigStrict(CONFIG_PATH);
      if (read.state !== "ok") {
        console.error("[config] " + CONFIG_PATH + " could not be reloaded (" + (read.why || "it is missing") + "); keeping the settings in memory and leaving the file as it is");
        CONFIG_LOAD_FAILED = true;
        return;
      }
      result = { cfg: read.cfg, loadFailed: false, quarantinePath: null };
    } else result = loadConfigFile(CONFIG_PATH, DEFAULT_CFG);
  }
  CFG = result.cfg;
  CONFIG_LOAD_FAILED = result.loadFailed;
  CONFIG_LOAD_QUARANTINE_PATH = result.quarantinePath;
  FOLDER = path.resolve(BASE_DIR, CFG.gcodeFolder || "./gcode");
  PRINTERS = activePrinters(CFG);
  // The G-code folder is its own availability root (netfs/NetFs.js): known
  // unreachable, its routes answer 503 at once instead of each hanging.
  netfs.registerRoot("gcode", FOLDER);
  ensureFolder(FOLDER);
  // Logs/Camera Folder are opt-in (no default, unlike gcodeFolder) — only
  // create them once the user has actually pointed at a path. Best-effort:
  // a bad path here shouldn't block the rest of config from loading, same
  // as the gcodeFolder mkdir above.
  if (CFG.logsFolder) ensureFolder(path.resolve(BASE_DIR, CFG.logsFolder));
  if (CFG.cameraFolder) ensureFolder(path.resolve(BASE_DIR, CFG.cameraFolder));
  if (CFG.gcodeSyncFolder) ensureFolder(path.resolve(BASE_DIR, CFG.gcodeSyncFolder));
}
// Best-effort create. A network folder is created asynchronously through
// netfs: startup must never wait on a NAS (an unreachable one used to delay
// it ~21 s). A local folder is created at once, as before.
function ensureFolder(p) {
  if (netfs.isNetworkPath(p)) { netfs.mkdir(p, { recursive: true }, { timeoutMs: 30000 }).catch(() => {}); return; }
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
loadConfig();
const PORT = CFG.port || 4545;
// Seed-once, never-overwrite for every locale except English (see
// locales.seedDefaultLocales), then English's own version-gated sync (see
// locales.syncCanonicalEnglish — safe specifically because the Language
// Editor never lets anyone write en.json), then the strings each installed
// translation is missing from its bundled copy (locales.addMissingBundledKeys
// — adds only, never changes a value), then an initial scan — same
// "load at startup, Refresh re-scans" lifecycle as every other cached
// registry in this file.
try { locales.seedDefaultLocales(LOCALES_DIR, LOCALES_DEFAULT_DIR); } catch (e) { console.error("[locales] seeding failed:", e.message); }
try { locales.syncCanonicalEnglish(LOCALES_DIR, LOCALES_DEFAULT_DIR); } catch (e) { console.error("[locales] English sync failed:", e.message); }
try { locales.addMissingBundledKeys(LOCALES_DIR, LOCALES_DEFAULT_DIR); } catch (e) { console.error("[locales] adding new strings failed:", e.message); }
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

// One-time rename: the Simulator printer type became "Test printer" on
// 2026-10-15. A printer's brand is stored when it is saved (buildPrinterRecord),
// so a Simulator saved before keeps showing the old name until it is renamed
// here. Every printer, hidden virtual ones included (CFG.printers).
function renameSimulatorBrand() {
  let changed = false;
  for (const p of CFG.printers || []) {
    if (p && p.connector === "simulator" && p.brand === "Simulator") { p.brand = getConnector("simulator").brand; changed = true; }
  }
  if (changed && !CONFIG_LOAD_FAILED) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch {} }
}
renameSimulatorBrand();

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
  PRINTERS = activePrinters(CFG);
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
  PRINTERS = activePrinters(CFG);
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
  PRINTERS = activePrinters(CFG);
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
const { changePrinterPool, enableQueueManagement, disableQueueManagement } = require("./queue/poolChange");
const { createTransferResults, RESULT_LIMITS } = require("./transfers/TransferResults");
const { createDeferredStore, LIMITS: DEFERRED_LIMITS, ID_SHAPE } = require("./transfers/DeferredStore");
const newPrinterPoolId = () => "pp_" + crypto.randomBytes(6).toString("hex");
// Id kept as its original literal value across the Printer Pool rename —
// see queue/migratePrinterPool.js: existing pool ids are preserved verbatim,
// only field/key names ("queueProfiles"/"printerPoolId") were renamed.
const PRINTER_POOL_DEFAULT_MANUAL_ID = "qp_default_manual";
// save: false — the caller saves config.json itself and checks the result.
function ensurePrinterPoolSchema({ save = true } = {}) {
  if (!CFG.queueManagement || typeof CFG.queueManagement !== "object") CFG.queueManagement = { enabled: false, mode: "per-printer" };
  if (!Array.isArray(CFG.printerPools)) CFG.printerPools = [];
  let changed = false;
  if (CFG.queueManagement.enabled && !CFG.printerPools.some(p => p.id === PRINTER_POOL_DEFAULT_MANUAL_ID)) {
    const now = new Date().toISOString();
    CFG.printerPools.unshift({ id: PRINTER_POOL_DEFAULT_MANUAL_ID, name: "Unassigned", type: "manual", isDefault: true, bedClearOnDispatchFailure: false, createdAt: now, updatedAt: now });
    changed = true;
  }
  if (save && changed && !CONFIG_LOAD_FAILED) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch {} }
}
ensurePrinterPoolSchema();
// Created here, LOADED only after the CLI block below returns — for the same
// reason as the two stores that follow: loading acts on the folder (a leftover
// temporary file, a corrupt primary beside a good backup), and a --load call
// is a second process next to the running server.
const queueStore = createQueueStore({ baseDir: BASE_DIR, fileIO: { stat: p => netfs.stat(p), hashFile: p => netfs.hashFile(p) } });
// Sends waiting for a busy printer (§37 P3), and the final outcome of each
// transfer (§37 P4). Created here, LOADED only at startup below (before
// deferredStartup), never in the CLI block: a --load call is a second
// process, and loading tidies files (a leftover temporary file, a corrupt
// list) the running server may be writing at that moment.
const deferredStore = createDeferredStore({ baseDir: BASE_DIR });
// A result an unresolved send still needs is never expired (owner, P4 item 6).
// While the send list cannot be read (or is held after a recovery), nothing
// is known to be resolved, so nothing expires (P4 backend review R3).
const transferResults = createTransferResults({ baseDir: BASE_DIR, isProtected: tid => { const st = deferredStore.status(); return st.readOnly || st.recoveryRequired || deferredStore.holdsTransfer(tid); } });

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
// `SnapCon --load "C:\file.gcode" --printer "U1 White" [--outputname "Nicer
// Name"] [--snapcon host[:port]] [--wait [seconds]]` pings an ALREADY-RUNNING
// instance and exits — see notifyCli.js. A plain top-level `return` (valid —
// CommonJS wraps each file in a function) stops the rest of this file,
// Express setup and every store load included, from ever running.
const CLI_LOAD_ARG = process.argv.indexOf("--load");
if (CLI_LOAD_ARG !== -1) {
  require("./notifyCli").runNotifyCli({ argv: process.argv, port: PORT, tokenPath: NOTIFY_TOKEN_PATH })
    .then(code => process.exit(code), e => { console.error("SnapCon: " + (e && e.message)); process.exit(1); });
  return;
}

// Genuine server startup from here on. The queue store is loaded first, before
// anything below can read or change queue state (it was loaded just above the
// CLI block until the queue durability fix; nothing in between used it).
queueStore.load();

// Established once here, at genuine server startup (never in CLI mode,
// which returns above before reaching this line) — the ONE writer for this
// value; see notifyToken.js's header comment. null means persistence
// failed; /api/notify-load's file-path branch below must fail closed in
// that case rather than fall back to trusting isLoopback() alone.
const NOTIFY_TOKEN = ensureNotifyToken(NOTIFY_TOKEN_PATH);

// Where files pushed from a remote --snapcon CLI call used to wait, deleted at
// every startup. They are kept in data/deferred-files/ now (§37 P3); an old
// leftover directory is still removed.
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
// "Update available": asks GitHub for the latest release at startup and
// daily while Settings > General > "Check for updates" is on (updateCheck.js).
const { createUpdateChecker } = require("./updateCheck");
const updateChecker = createUpdateChecker({ baseDir: BASE_DIR, version: VERSION, isEnabled: () => CFG.checkForUpdates !== false });

// Audit log — the only module the routes below talk to for it. Degrades to a
// silent no-op on a Node runtime too old for node:sqlite (see AuditLog.js);
// never blocks or crashes any request either way.
const auditLog = createAuditLog({ baseDir: BASE_DIR, retentionDaysFn: () => CFG.auditRetentionDays });
// Fleet utilization (Phase 1: recording only). Fed by notifyTick's readings;
// cannot throw, and a failure only stops the recording.
const utilization = createUtilization({
  baseDir: BASE_DIR, isVirtual: isVirtualType,
  // Phase 2: the printer's job history, read only, where its connector has one.
  // Read only when config.json utilization.readPrinterHistory says so (true, or
  // a list of printer ids for a pilot); off when absent. Live: a config change
  // applies at the next poll.
  historySetting: () => CFG.utilization ? CFG.utilization.readPrinterHistory : undefined,
  historyFor: p => {
    const c = getConnector(p.connector);
    return c && c.capabilities && c.capabilities.jobHistory && typeof c.fetchJobHistory === "function" ? opts => c.fetchJobHistory(p, opts) : null;
  },
  // The nightly backup runs on its worker: its failure is reported here.
  onBackupFailed: e => auditLog.log({ category: "admin", event: "backup-failed", detail: { database: "utilization.db", message: e.message } }),
});
utilization.start();
setInterval(() => auditLog.prune(CFG.auditRetentionDays), 24 * 60 * 60 * 1000).unref();
auditLog.prune(CFG.auditRetentionDays);

// Logs/Camera sync — the only module the routes below talk to for it. Same
// "one entry point" shape as remoteAccess/auditLog above.
const syncEngine = createSyncEngine({ baseDir: BASE_DIR, getConnector, fileIO: {
  stat: p => netfs.stat(p), mkdir: (p, o) => netfs.mkdir(p, o),
  isNetworkPath: p => netfs.isNetworkPath(p), availability: p => netfs.availability(p),
  noteError: (p, e) => netfs.noteError(p, e),
} });

// Nightly copies of audit.db and sync.db (AuditLog/SyncStore backup(): the
// Library's runBackup with their own prefix). Same rule as the Library's own
// backups: due once the newest copy is 24 h old, checked hourly and once a
// minute after start, so a restart neither skips a day nor doubles one up.
// Small databases, so this runs on the main thread, like the Library's
// pre-migration snapshot; the time each copy took is logged.
const { backupDue } = require("./library/LibraryStore");
const DB_BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
function backupStoreIfDue(name, store, category) {
  if (!store.isAvailable() || !backupDue(store.listBackups(), Date.now(), DB_BACKUP_EVERY_MS)) return;
  try {
    const r = store.backup({ reason: "nightly" });
    if (r) console.log(`[${name}] backup ${r.file}: ${r.bytes} bytes in ${r.ms} ms`);
  } catch (e) {
    console.warn(`[${name}] backup failed: ${e.message}`);
    auditLog.log({ category, event: "backup-failed", detail: { database: name + ".db", message: e.message } });
  }
}
function backupDatabasesIfDue() {
  backupStoreIfDue("audit", auditLog, "admin");
  backupStoreIfDue("sync", syncEngine.store, "sync");
  backupStoreIfDue("utilization", utilization, "admin");
}
setTimeout(backupDatabasesIfDue, 60 * 1000).unref();
setInterval(backupDatabasesIfDue, 60 * 60 * 1000).unref();

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

// Model Library (docs/library-design.md) — the only module the routes below
// talk to for it. Same shape as audit/sync/queue: its own library-data/
// directory, node:sqlite, and "unavailable" instead of a crash if anything
// about its database is wrong. Its worker thread and location checks start
// with the server (see app.listen below). The G-code folder is always one of
// its locations and follows Settings > General.
const library = createLibraryService({
  baseDir: BASE_DIR,
  getGcodeFolder: () => FOLDER,
  checkFn: (p, o) => checkReachable(p, { ...o, fsp: netfsFsp(netfs) }),
  netfs, uploadsActive: () => UPLOADS_ACTIVE > 0,
  audit: (event, actor, detail) => auditLog.log({ category: "library", event, ...actor, detail }),
  // Print history rows follow printer visibility (§9 D6). A printer since
  // removed from SnapCon is visible to admins only.
  printerVisible: (user, printerId) => {
    const p = PRINTERS.find(x => x.id === printerId);
    return p ? printerVisibleTo(user, p) : (!user || user.role === "admin" || !!user.implicit);
  },
});
registerLibraryRoutes(app, { library, requireAuth, actorFromReq });

// Print history from the audit log (M7, §9 D7): the last 90 days at most (the
// log keeps no more by default), with the queue's recent history, whose
// verified hashes link a queued job exactly. Safe to repeat: what a Print
// already records is not added again.
const PRINT_HISTORY_EVENTS = ["print-started", "queue-print-started", "print-completed", "print-cancelled", "print-error"];
async function importPrintHistory() {
  if (!library.available) return null;
  const to = Date.now();
  const from = to - Math.min(90, Number(CFG.auditRetentionDays) || 90) * 24 * 3600 * 1000;
  const events = auditLog.events({ from, to, names: PRINT_HISTORY_EVENTS });
  const queueHistory = {};
  for (const p of PRINTERS) {
    const st = queueStore.getPrinterState(p.id);
    queueHistory[p.id] = [...(st.recentHistory || []), ...(st.currentItem ? [st.currentItem] : [])].map(i => ({ id: i.id, file: { name: i.file && i.file.name, sha256: i.file && i.file.sha256 }, dispatchedAt: i.dispatchedAt || null }));
  }
  return library.importPrintHistory({ events, queueHistory, from, to });
}
// The import's report (and running it again): for those who may see Library
// Diagnostics. It names printers and file names, so it is not for everyone.
const needLibraryDiagnostics = (req, res, next) => (library.can(req.user, "library.diagnostics") ? next() : res.status(403).json({ error: "forbidden", code: "forbidden" }));
app.get("/api/library/print-history/import", requireAuth, needLibraryDiagnostics, (req, res) => res.json(library.lastPrintImport() || {}));
app.post("/api/library/print-history/import", requireAuth, needLibraryDiagnostics, async (req, res) => {
  try {
    const rep = await importPrintHistory();
    auditLog.log({ category: "library", event: "print-history-imported", ...actorFromReq(req), detail: rep ? { created: rep.created, closed: rep.closed, events: rep.events } : null });
    res.json(rep || {});
  } catch (e) { res.status(e.status || 500).json({ error: e.message, code: e.code || null }); }
});

// Explicit index route so the UI is served even when running from a packaged
// binary (where express.static from the snapshot can be unreliable).
app.get("/", (req, res) => {
  try { res.type("html").send(fs.readFileSync(path.join(ASSET_DIR, "public", "index.html"), "utf8")); }
  catch (e) { res.status(500).send("index.html not found"); }
});
// Third-party notices (THIRD_PARTY_NOTICES.md: the theme icons, the bundled
// font). The file goes with every copy of SnapCon — the Docker image copies it
// and the packaged binaries embed it (package.json pkg.assets) — and it is
// served here so that whoever has a copy can read it: a file inside a binary
// cannot be opened any other way. No sign-in, like the page and its assets.
app.get("/THIRD_PARTY_NOTICES.md", (req, res) => {
  try { res.type("text/plain").send(fs.readFileSync(path.join(ASSET_DIR, "THIRD_PARTY_NOTICES.md"), "utf8")); }
  catch (e) { res.status(404).type("text/plain").send("THIRD_PARTY_NOTICES.md not found"); }
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
// /library, /library/m/<uuid>, /library/attention — the Library (M5), same
// page and its own small router, like /health. /library/diagnostics is the
// admin Diagnostics page (its API is admin-only; the page itself is static).
app.get(/^\/library\/diagnostics\/?$/i, (req, res) => res.redirect("/library-diagnostics.html"));
app.get(/^\/library(\/(m\/[0-9a-f-]{36}|attention)?)?\/?$/i, (req, res) => {
  try { res.type("html").send(fs.readFileSync(path.join(ASSET_DIR, "public", "index.html"), "utf8")); }
  catch (e) { res.status(500).send("index.html not found"); }
});

// /utilization — Fleet utilization (read only), same page, like /library; its
// filters are in the query string, read by public/utilization.js.
app.get(/^\/utilization\/?$/i, (req, res) => {
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
// Never a path in the trash (fileTrash.js): every route that names a G-code
// folder file comes through here or resolveFileRef(), so none can read, send,
// queue or overwrite a deleted file. The trash's own routes use fileTrash.
function safePath(sub) {
  const fp = resolveWithinFolder(sub, FOLDER);
  return fp && !fileTrash.isInTrash(fp, FOLDER) ? fp : null;
}

// The extensions the file browser lists as printable files.
const SLICED_FILE_RE = /\.(gcode|gco|g|gx|3mf)$/i;

// A request that needed the G-code folder while it is unreachable gets a
// clear 503 instead of a hang or a misleading "not found". Returns true when
// it answered. Any other error is the caller's to report.
function replyIfNasDown(res, e) {
  if (!e || e.code !== "NAS_UNREACHABLE") return false;
  res.status(503).json({
    error: "The G-code folder is unreachable" + (e.reason ? " (" + e.reason + ")" : "") + ". SnapCon keeps checking and will use it again as soon as it answers.",
    code: "gcode_folder_unreachable",
  });
  return true;
}

// Does this file exist? Through netfs, so an unreachable share is an error
// (NAS_UNREACHABLE), never a quiet "no". Checked on every use: the breaker
// only short-circuits a known outage, it never stands in for this check.
const fileExists = fp => netfs.exists(fp);
// The G-code folder's trash (fileTrash.js) reaches the folder through netfs too.
const TRASH_IO = {
  stat: p => netfs.stat(p), exists: p => netfs.exists(p), readdir: p => netfs.readdir(p),
  mkdir: (p, o) => netfs.mkdir(p, o), rename: (a, b) => netfs.rename(a, b), moveNoReplace: (a, b) => netfs.moveNoReplace(a, b), unlinkFile: (p, expect) => netfs.unlinkFile(p, expect), identity: p => netfs.identity(p),
  readFile: (p, max) => netfs.readFile(p, max), writeFileExclusive: (p, data) => netfs.writeFileExclusive(p, data),
};

// M7 (docs/library-design.md §12): a file named by a Library location and its
// path inside it. No root, or "gcode", is the G-code folder exactly as before
// (safePath). Any other location resolves inside its own folder, then by real
// path: a location can be any folder on any share, and a link or junction in
// it must not lead out of it. Answers { fp, root, dir } or null (no such
// file); throws a LibraryError (no permission, switched off, unreachable) or
// NAS_UNREACHABLE. `system`: dispatch of an item already checked when queued.
async function resolveFileRef(user, root, file, { system = false } = {}) {
  if (root == null || root === "" || root === GCODE_ROOT) {
    const fp = safePath(file);
    return fp ? { fp, root: GCODE_ROOT, dir: FOLDER } : null;
  }
  const loc = library.printLocation(user, String(root), { system });
  const fp = resolveWithinFolder(file, loc.path);
  if (!fp) return null;
  let real, realRoot;
  try { [real, realRoot] = await Promise.all([netfs.realpath(fp), netfs.realpath(loc.path)]); }
  catch (e) { if (e && e.code === "NAS_UNREACHABLE") throw e; return null; }
  if (!isPathWithinFolder(real, realRoot)) return null;
  return { fp, root: loc.id, dir: loc.path };
}
const relOf = ref => path.relative(ref.dir, ref.fp).split(path.sep).join("/");
// The answer when a file reference can't be used. true when it answered.
function replyFileRefError(res, e, root) {
  if (e && e.code === "NAS_UNREACHABLE" && root && root !== GCODE_ROOT) {
    res.status(503).json({ error: "That Library location is unreachable. SnapCon keeps checking and will use it again as soon as it answers.", code: "location_unreachable" });
    return true;
  }
  if (replyIfNasDown(res, e)) return true;
  if (e instanceof LibraryError) { res.status(e.status).json({ error: e.message, code: e.code }); return true; }
  return false;
}
// M7: a print chosen in the Library is recorded as exactly that Variant, so the
// file must still be the one the Library indexed (same size and modified
// time; the Variant the person saw) and its content is known by hash — the
// Library's, or computed now when the Library has not hashed it yet.
async function libraryPrintIdentity(ref, lib) {
  const id = library.printIdentity({ rootId: ref.root, rel: relOf(ref), key: lib && lib.key, plate: lib && lib.plate });
  const st = await netfs.stat(ref.fp);
  if (st.size !== id.size || Math.abs(st.mtimeMs - id.mtimeMs) >= 1) {
    library.rescan(ref.root).catch(() => {});
    throw new LibraryError(409, "library_file_changed", "This file changed since the Library last read it. SnapCon is reading it again; try again in a moment.");
  }
  const sha256 = id.sha256 || (await queueStore.computeFileHash(ref.fp)).sha256;
  return { ...id, sha256 };
}
// M7.1: which plate of a project this print starts. A Bambu project holds one
// G-code per sliced plate; the plate asked for must be one of them (absent:
// the first, which is what /api/map shows), and a plate other than 1 only
// goes to a connector that can start the plate it is told
// (capabilities.plateSelect). Every other file: no plate. Never "plate N"
// shown while another one prints.
async function resolvePrintPlate(p, fp, requested) {
  if (!/\.3mf$/i.test(fp)) return { plate: null };
  const info = await netfs.threemfRead(fp);
  if (!info.isBambu || !info.sliced) return { plate: null };
  const asked = requested == null || requested === "" ? null : Number(requested);
  const plate = asked == null ? info.plates[0] : asked;
  if (!Number.isInteger(plate) || !info.plates.includes(plate)) {
    return { error: `This file has no sliced plate ${requested}.`, code: "no_such_plate", status: 400 };
  }
  if (plate !== 1 && !(getCapabilities(p.connector, p) || {}).plateSelect) {
    return { error: `${p.name} can only start plate 1 of a project, and this is plate ${plate}.`, code: "plate_unsupported", status: 400 };
  }
  return { plate };
}
// What a send that is finished later (deferred until the printer is free, or
// uploaded now and started later from the printer) keeps so its Print can be
// recorded as exactly what was sent (M7.1): the plate, the location, and the
// Library Variant with its verified hash.
const sendRef = (ref, ident, plate) => ({
  plate: plate == null ? null : plate, location: ref.root + ":" + relOf(ref),
  library: ident ? { contentKey: ident.contentKey, plate: ident.plate, model: ident.model, modelName: ident.modelName, variantKey: ident.variantKey, sha256: ident.sha256 } : null,
});

// What a queue item keeps of it: stable ids and names, never a folder path.
const libraryQueueRef = id => ({ model: id.model, modelName: id.modelName, contentKey: id.contentKey, variantKey: id.variantKey, plate: id.plate, location: id.location });
const libraryAudit = id => ({ model: id.model, modelName: id.modelName, location: String(id.location).split(":")[0], content: String(id.contentKey).slice(0, 16) });


app.get("/api/printers", requireAuth, (req, res) => {
  const out = [];
  PRINTERS.forEach((p, i) => { if (printerVisibleTo(req.user, p)) out.push({ id: i, name: p.name }); });
  res.json(out);
});

app.get("/api/files", requireAuth, async (req, res) => {
  const sub = req.query.sub || "";
  const dir = sub ? safePath(sub) : FOLDER;
  // The trash (fileTrash.js) is not a folder to browse.
  if (!dir || fileTrash.isInTrash(dir, FOLDER)) return res.status(400).json({ error: "Invalid path" });
  try {
    // One netfs round trip: the directory plus a stat of each listed file.
    // .gx/.3mf are FlashForge's slicer output (.3mf specifically for
    // multi-material/IFS jobs on the AD5X) — without these, a FlashForge
    // user's sliced files never show up here at all.
    const entries = await netfs.listDir(dir, SLICED_FILE_RE);
    const folders = entries.filter(e => e.isDirectory && !(dir === FOLDER && fileTrash.isTrashRel(e.name))).map(e => e.name).sort();
    const files = [];
    for (const e of entries.filter(x => x.isFile)) {
      const fp = path.join(dir, e.name);
      const row = { name: e.name, size: e.size, mtime: e.mtimeMs };
      // A .3mf tells the library nothing by its name: the same extension
      // covers a printable sliced plate and a project that was never sliced.
      // Read once per listing, cached on size+mtime, so the row can say which
      // it is instead of letting someone send a file no printer can start.
      if (/\.3mf$/i.test(e.name)) {
        const info = await threemfInfoCached(fp, e);
        if (info.isBambu) { row.kind = "bambu-3mf"; row.sliced = info.sliced; }
      }
      files.push(row);
    }
    files.sort((a, b) => b.mtime - a.mtime);
    res.json({ folder: dir, sub, folders, files });
  } catch (e) {
    if (replyIfNasDown(res, e)) return;
    res.status(500).json({ error: "Cannot read folder — " + e.message });
  }
});

// Settings > General's live "does this path resolve" check — for the folder
// currently TYPED in the field, which may not be saved (or valid) yet, so it
// can't reuse FOLDER/safePath (those are jailed to the already-saved
// gcodeFolder). Resolves the same way loadConfig() resolves gcodeFolder
// (relative to BASE_DIR, same as a relative "./gcode" in config.json would
// be) and counts the same sliced-file extensions /api/files does.
// Opening a zip for every row of a folder listing, on every poll, would be
// pointless work: a file that has not changed cannot have become sliced. Keyed
// on path + size + mtime, so replacing a file with a sliced version of itself
// is picked up immediately. Bounded, because a big library would otherwise keep
// an entry per file forever.
const THREEMF_CACHE = new Map();
const THREEMF_CACHE_MAX = 2000;
async function threemfInfoCached(fp, stat) {
  const key = fp + "|" + stat.size + "|" + stat.mtimeMs;
  const hit = THREEMF_CACHE.get(key);
  if (hit) return hit;
  const info = await netfs.threemfRead(fp);   // threemf.read, run in a netfs worker
  if (THREEMF_CACHE.size >= THREEMF_CACHE_MAX) THREEMF_CACHE.clear();
  THREEMF_CACHE.set(key, info);
  return info;
}

// The typed path may be a network share that is down: checked through netfs so
// that costs this request at most its timeout, never the server.
app.get("/api/check-folder", requireAdmin, async (req, res) => {
  const raw = String(req.query.path || "").trim();
  if (!raw) return res.json({ ok: false, error: "Enter a path" });
  const resolved = path.resolve(BASE_DIR, raw);
  try {
    if (!(await netfs.stat(resolved)).isDirectory) return res.json({ ok: false, error: "Not a folder" });
    const count = (await netfs.readdir(resolved)).filter(e => e.isFile && SLICED_FILE_RE.test(e.name)).length;
    res.json({ ok: true, resolved, count });
  } catch (e) {
    res.json({ ok: false, error: e.code === "NAS_UNREACHABLE" ? "Unreachable — the share did not answer" : "Path not found" });
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
app.get("/api/firmware-files", requireAdmin, async (req, res) => {
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
  // Through netfs: the firmware folder can be a share like the G-code folder.
  let entries;
  try {
    if (!(await netfs.lstat(dir)).isDirectory) return res.status(400).json({ error: "Not a folder" });
    entries = await netfs.listDir(dir);
  } catch (e) {
    if (e && e.code === "NAS_UNREACHABLE") return res.status(503).json({ error: e.message });
    return res.status(404).json({ error: "Path not found" });
  }
  const dirs = [], files = [];
  for (const e of entries) {
    // isDirectory/isFile are both false for a symlink here (the worker reads
    // dirents, never following them), so symlinks fall out of the listing
    // entirely — see the jail note above. A file that vanished between
    // readdir and stat is already omitted.
    const full = path.join(dir, e.name);
    if (e.isDirectory) dirs.push({ name: e.name, path: rel(full) });
    else if (e.isFile) files.push({ name: e.name, path: rel(full), size: e.size, mtime: e.mtimeMs });
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
async function resolveFirmwareFile(relRaw) {
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
  try { if (!(await netfs.lstat(file)).isFile) return { status: 400, error: "Not a file" }; }
  catch (e) {
    if (e && e.code === "NAS_UNREACHABLE") return { status: 503, error: e.message };
    return { status: 404, error: "Firmware file not found" };
  }
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
    const now = await resolveFirmwareFile(relRaw);
    if (now.error) throw new Error(now.error);

    // With no mode the connector picks its own default: a CRC-32 taken from
    // the printer's own archive of the file, falling back to windowed
    // sampling on firmware without that endpoint. "none" is the one value a
    // request can set, and it means exactly what it says.
    const r = await whileUploading(() => u1Firmware.updateFromFile(p, now.file, {
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
    }));

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
app.get("/api/firmware-inspect", requireAdmin, async (req, res) => {
  const resolved = await resolveFirmwareFile(String(req.query.path || ""));
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  // Belt and braces with the module's own guarding: this route must always
  // answer JSON, because a caller that gets an HTML error page back cannot
  // tell "this file is unreadable" from "this SnapCon has no such route".
  let info;
  try { info = await netfs.firmwareInspect(resolved.file); }
  catch (e) {
    if (e && e.code === "NAS_UNREACHABLE") return res.status(503).json({ error: e.message });
    return res.status(500).json({ error: "The firmware file could not be checked: " + e.message });
  }
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

  const resolved = await resolveFirmwareFile(relRaw);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  // Pre-flight on the image itself. Only facts readable from the bytes are
  // fatal (container, chip, internally impossible offsets); a filename/model
  // mismatch is a warning carried to the caller, never a claim of proven
  // compatibility — see connectors/firmwareImage.js.
  let image;
  try { image = await netfs.firmwareInspect(resolved.file); }
  catch (e) { return res.status(e && e.code === "NAS_UNREACHABLE" ? 503 : 500).json({ error: "The firmware file could not be checked: " + e.message }); }
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

// The fleet's non-blocking offline display path (docs/TODO.md §48). On unless
// config.json says "fleetFastOffline": false. Turning it off makes GET
// /api/fleet probe every printer the authoritative way again, at once, with
// no restart; probes already running finish and are recorded normally (they
// are real results about the printer as configured). Admin-only, saved, and
// audited, like the firmware options above.
app.get("/api/fleet-fast-offline", requireAdmin, (req, res) => {
  res.json({ enabled: CFG.fleetFastOffline !== false, stats: FLEET_PROBE.stats() });
});
app.post("/api/fleet-fast-offline", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (typeof b.enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
  if (CONFIG_LOAD_FAILED) return res.status(409).json({ error: "Config could not be read; not overwriting it" });
  const prev = CFG.fleetFastOffline, before = prev !== false;
  CFG.fleetFastOffline = b.enabled;
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); }
  catch (e) { CFG.fleetFastOffline = prev; return res.status(500).json({ error: "Could not save: " + e.message }); }
  if (before !== b.enabled) auditLog.log({ category: "admin", event: "fleet-fast-offline-changed", ...actorFromReq(req), detail: { enabled: b.enabled } });
  res.json({ ok: true, enabled: b.enabled });
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
// File search walks the folder the file browser is showing (`sub`) and
// everything below it — the whole G-code folder only when the browser is at
// its top. Done in a netfs worker so a large or slow share costs this request,
// not the server. Hidden folders (.thumbs) are skipped, as before. Each
// result's `sub` stays relative to the G-code folder, whatever was searched.
//
// safePath() only compares path text, and the walk reads the folder it is
// given, following a link. So the starting folder is also resolved here: where
// it really is must be inside the real G-code folder and outside its trash —
// whether the link is the folder itself or a folder on the way to it. A link
// to another folder inside the G-code folder is allowed (it reaches nothing
// the browser cannot). Links met below the starting folder are not followed by
// the walk, as before. This is a check at the time of the request, not a
// guarantee against a folder being swapped for a link while the walk runs.
app.get("/api/files/search", requireAuth, async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) return res.json({ files: [] });
  const sub = String(req.query.sub || "");
  const dir = sub ? safePath(sub) : FOLDER;
  if (!dir) return res.status(400).json({ error: "Invalid folder" });
  const base = path.relative(FOLDER, dir).split(path.sep).filter(Boolean).join("/");
  try {
    if (base) {
      // A folder that is not there throws here and gives no results below.
      const [real, realRoot] = await Promise.all([netfs.realpath(dir), netfs.realpath(FOLDER)]);
      if (!isPathWithinFolder(real, realRoot) || fileTrash.isInTrash(real, realRoot)) return res.status(400).json({ error: "Invalid folder" });
    }
    const results = await netfs.walk(dir, { query: q, filter: SLICED_FILE_RE, limit: 300 });
    if (base) for (const r of results) r.sub = r.sub ? base + "/" + r.sub : base;
    results.sort((a, b) => b.mtime - a.mtime);
    res.json({ files: results });
  } catch (e) {
    if (replyIfNasDown(res, e)) return;
    res.json({ files: [] });
  }
});

app.post("/api/files/mkdir", requireRegular, async (req, res) => {
  const { sub, name } = req.body || {};
  const dir = sub ? safePath(sub) : FOLDER;
  try {
    if (!dir || !(await fileExists(dir))) return res.status(400).json({ error: "Invalid folder" });
    const clean = String(name || "").trim();
    if (!clean || /[\\/]/.test(clean) || clean === "." || clean === "..") {
      return res.status(400).json({ error: "Invalid folder name" });
    }
    const target = path.join(dir, clean);
    if (!isPathWithinFolder(target, FOLDER) || fileTrash.isInTrash(target, FOLDER)) return res.status(400).json({ error: "Invalid folder name" });
    if (await fileExists(target)) return res.status(409).json({ error: "Already exists" });
    await netfs.mkdir(target);
    res.json({ ok: true });
  } catch (e) {
    if (replyIfNasDown(res, e)) return;
    res.status(500).json({ error: e.message });
  }
});

// Move one or more files (each identified by its own {sub, name}, since a
// multi-select drag can span several source folders at once) into targetSub.
app.post("/api/files/move", requireRegular, async (req, res) => {
  const { files, targetSub } = req.body || {};
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: "No files given" });
  const targetDir = targetSub ? safePath(targetSub) : FOLDER;
  try {
    if (!targetDir || fileTrash.isInTrash(targetDir, FOLDER) || !(await fileExists(targetDir)) || !(await netfs.stat(targetDir)).isDirectory) {
      return res.status(400).json({ error: "Invalid target folder" });
    }
    const results = [];
    for (const f of files) {
      const name = String((f || {}).name || "");
      const rel = ((f || {}).sub ? f.sub + "/" : "") + name;
      const srcPath = safePath(rel);
      if (!name || !srcPath || fileTrash.isInTrash(srcPath, FOLDER) || !(await fileExists(srcPath)) || !(await netfs.stat(srcPath)).isFile) {
        results.push({ name, ok: false, error: "Not found" }); continue;
      }
      const destPath = path.join(targetDir, name);
      if (path.dirname(srcPath) === targetDir) { results.push({ name, ok: false, error: "Already there" }); continue; }
      if (await fileExists(destPath)) { results.push({ name, ok: false, error: "Already exists in target" }); continue; }
      try { await netfs.rename(srcPath, destPath); results.push({ name, ok: true }); }
      catch (e) { if (e.code === "NAS_UNREACHABLE") throw e; results.push({ name, ok: false, error: e.message }); }
    }
    res.json({ results });
  } catch (e) {
    if (replyIfNasDown(res, e)) return;
    res.status(500).json({ error: e.message });
  }
});

// Signed in, accounts on, Admin: the only user who may delete permanently.
const permanentDeleteAllowed = user => !!(CFG.usersEnabled && user && !user.implicit && user.role === "admin");

// Delete one or more files ({sub, name} each, like move): each is moved into
// the G-code folder's .snapcon-trash and kept 30 days (fileTrash.js), never
// removed. A file an upload, a waiting send or a queue item still needs is
// refused (gcodeFileInUse, asked again right before its rename). Every file
// gets its own result; one that fails never stops the others, except when the
// folder stops answering, which leaves the rest untouched.
app.post("/api/files/delete", requireRegular, async (req, res) => {
  const { files } = req.body || {};
  const mode = (req.body || {}).mode == null ? "trash" : (req.body || {}).mode;
  if (!fileTrash.MODES.has(mode)) return res.status(400).json({ error: "Unknown delete mode" });
  // Permanent delete: only a signed-in Admin, and never while accounts are
  // off (then everyone is an implicit admin). Refused before anything is read.
  if (mode === "permanent" && !permanentDeleteAllowed(req.user)) {
    return res.status(403).json({ error: CFG.usersEnabled ? "Only an Admin can delete files permanently." : "Deleting permanently needs user accounts to be switched on.", code: "permanent_delete_not_allowed" });
  }
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: "No files given" });
  if (files.length > fileTrash.MAX_FILES) return res.status(400).json({ error: `At most ${fileTrash.MAX_FILES} files at once` });
  const actor = actorFromReq(req);
  let out;
  try {
    out = await fileTrash.deleteFiles({ io: TRASH_IO, folder: FOLDER, files, mode, inUse: fp => gcodeFileInUse(fp, req.user), reserve: reserveGcodeDelete, release: releaseGcodeDelete, allowed: SLICED_FILE_RE, actor });
  } catch (e) {
    if (replyIfNasDown(res, e)) return;
    return res.status(500).json({ error: e.message });
  }
  for (const r of out.results.filter(x => x.ok || x.code === "unknown")) {
    const rel = r.ok ? r.path : (r.sub ? r.sub + "/" : "") + r.name;
    try { auditLog.log({ category: "job", event: r.ok ? "file-deleted" : "file-delete-unconfirmed", ...actor, detail: { file: rel, method: mode, ...(mode === "trash" ? { trash: out.batch } : {}) } }); } catch {}
  }
  if (out.manifestError) console.warn(`[files] trash ${out.batch}: manifest not written (${out.manifestError}); the files are in it, by their own paths`);
  if (out.unreachable && !out.results.some(r => r.ok)) {
    const maybe = out.results.some(r => r.code === "unknown");
    return res.status(503).json({ error: maybe ? "The G-code folder stopped answering during the delete. One file may already be in the trash; refresh to check." : "The G-code folder is unreachable. Nothing was deleted.", code: "gcode_folder_unreachable", results: out.results });
  }
  res.json({ results: out.results, batch: out.batch, ...(out.unreachable ? { code: "gcode_folder_unreachable" } : {}) });
});

// What is in the trash, by deletion, newest first. Restore has no screen yet:
// this and /api/files/trash/restore are how a file is recovered.
app.get("/api/files/trash", requireRegular, async (req, res) => {
  try { res.json({ retentionDays: fileTrash.RETENTION_DAYS, deletions: await fileTrash.listTrash({ io: TRASH_IO, folder: FOLDER }) }); }
  catch (e) {
    if (replyIfNasDown(res, e)) return;
    res.status(500).json({ error: e.message });
  }
});

// Puts one file back where it was deleted from; never over a file now there.
app.post("/api/files/trash/restore", requireRegular, async (req, res) => {
  const { batch, file } = req.body || {};
  try {
    const r = await fileTrash.restoreFile({ io: TRASH_IO, folder: FOLDER, batch, file });
    if (!r.ok) return res.status(r.status).json({ error: r.error, code: r.code });
    try { auditLog.log({ category: "job", event: "file-restored", ...actorFromReq(req), detail: { file: r.path, trash: batch, ...(r.sourceKept ? { sourceKept: true } : {}) } }); } catch {}
    // visible: false only means the share has not shown it yet (see restoreFile).
    res.json({ ok: true, path: r.path, visible: r.visible });
  } catch (e) {
    if (replyIfNasDown(res, e)) return;
    res.status(500).json({ error: e.message });
  }
});

// Local-PC → gcode-folder upload (the reverse direction of /api/print's
// printer upload): one file per request, raw bytes, name/sub in the query
// string — mirrors /api/notify-load's existing raw-body convention instead
// of pulling in a multipart-parsing dependency for a single call site.
app.post("/api/files/upload", requireRegular, rawGcodeBody, async (req, res) => {
  const sub = String(req.query.sub || "");
  const dir = sub ? safePath(sub) : FOLDER;
  const name = path.basename(String(req.query.name || "").trim());
  // Same CRLF/quote check as /api/printfile and /api/exclude — this name is
  // later reused verbatim as the on-printer filename passed to
  // startPrintFile()/excludeObject(), which build a literal gcode script
  // line around it (see connectors/http-utils.js). An embedded quote or
  // newline there injects a second gcode/macro command into the printer.
  if (!name || /["\r\n]/.test(name) || !SLICED_FILE_RE.test(name)) {
    return res.status(400).json({ error: "Only sliced files (.gcode/.gco/.g/.gx/.3mf) can be uploaded here" });
  }
  if (!dir || fileTrash.isInTrash(dir, FOLDER)) return res.status(400).json({ error: "Invalid folder" });
  const target = path.join(dir, name);
  if (!isPathWithinFolder(target, FOLDER)) return res.status(400).json({ error: "Invalid file name" });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Empty upload" });
  try {
    if (!(await fileExists(dir))) return res.status(400).json({ error: "Invalid folder" });
    // Exclusive create in one step: it fails with EEXIST rather than
    // overwrite, even if the file appeared after a separate existence check.
    await whileUploading(() => netfs.writeFileExclusive(target, req.body));
    res.json({ ok: true, name });
  } catch (e) {
    if (replyIfNasDown(res, e)) return;
    if (e.code === "EEXIST") return res.status(409).json({ error: "Already exists" });
    res.status(500).json({ error: e.message });
  }
});

// A Bambu project's tray_info_idx per filament, indexed by the project's
// filament number for one plate (null where that plate does not use it).
function plateTrayInfo(info, plate) {
  const list = (info.plateFilaments && info.plateFilaments[plate]) || null;
  if (!list) return info.filaments.map(f => f.trayInfoIdx);   // no per-plate list: as the file gives it
  const out = [];
  // Ids come from the file: only plausible filament numbers index the array.
  for (const f of list) if (Number.isInteger(f.id) && f.id >= 1 && f.id <= 64) out[f.id - 1] = f.trayInfoIdx;
  return Array.from(out, v => (v === undefined ? null : v));
}

// A Bambu plate's G-code does not say which of the project's filaments it
// uses; its slice_info plate block does (M7.1). Only those are marked used —
// they are the ones that need a tray — so the colours mapped in the Send
// dialog are this plate's. Without a plate block, the palette as parsed.
function platePalette(palette, info, plate) {
  const list = info.plateFilaments && info.plateFilaments[plate];
  if (!list || !list.length) return palette;
  const ids = new Set(list.map(f => f.id));
  return palette.map(s => ({ ...s, used: ids.has(s.i + 1) }));
}

app.get("/api/map", requireAuth, async (req, res) => {
  try {
    const ref = await resolveFileRef(req.user, req.query.root, req.query.file);
    const fp = ref && ref.fp;
    if (!fp || !(await fileExists(fp))) return res.status(404).json({ error: "File not found" });
    // A Bambu .3mf is a zip: its sliced gcode — with the ordinary header
    // comments this parser already reads — is one entry inside it. Read as
    // text it produced "no colours" and nothing else, silently, which left the
    // Job card blank and the filament mapping impossible to choose.
    //
    // Only a Bambu .3mf takes this path: .3mf is also FlashForge's AD5X format
    // and those files keep the behaviour they have always had.
    const info = /\.3mf$/i.test(fp) ? await netfs.threemfRead(fp) : null;
    if (info && info.isBambu) {
      if (!info.sliced) {
        return res.json({ ...parseGcodeMap("", { scanBody: false }), notSliced: true, printerModel: info.printerModel });
      }
      const plate = Math.max(1, parseInt(req.query.plate, 10) || info.plates[0] || 1);
      const result = parseGcodeMap(await netfs.threemfPlateGcode(fp, plate), { scanBody: false });
      result.palette = platePalette(result.palette, info, plate);
      return res.json({
        ...result,
        printerModel: result.printerModel || info.printerModel,
        // What the Send dialog needs on top of the palette: which plates this
        // file holds, and what it was sliced for.
        plates: info.plates,
        plate,
        printerModelId: info.printerModelId,
        nozzle: info.nozzle,
        // By the project's filament number (the palette index), for the
        // plate shown: a multi-plate project's plates use different filaments.
        trayInfoIdx: plateTrayInfo(info, plate)
      });
    }
    // The Orca config block (colours + "filament used [g]") lives at the END of
    // the file, so read just the tail — turns a 200MB read into ~2MB and skips
    // the body scan entirely. Fall back to the whole file only if the colour
    // config isn't found in the tail.
    const TAIL = 3 * 1024 * 1024;
    const size = (await netfs.stat(fp)).size;
    const text = (size > TAIL ? await netfs.read(fp, size - TAIL, TAIL) : await netfs.readFile(fp)).toString("utf8");
    let result = parseGcodeMap(text, { scanBody: false });
    if (result.noColors && size > TAIL) {
      // Colours weren't in the tail — fall back to a full parse (rare). Stream
      // it line-by-line: these files can be 200MB+, never hold one in memory.
      const input = netfs.createReadStream(fp);
      input.setEncoding("utf8");   // a character split across two chunks is decoded whole
      const rl = readline.createInterface({ input, crlfDelay: Infinity });
      result = await parseGcodeMapLines(rl, { scanBody: true });
    }
    res.json(result);
  } catch (e) {
    if (replyFileRefError(res, e, req.query.root)) return;
    res.status(500).json({ error: e.message });
  }
});

// ---- Local gcode thumbnail (base64 PNG/JPG embedded by Orca in the header) ----
app.get("/api/local-thumbnail", requireAuth, async (req, res) => {
  try {
    const ref = await resolveFileRef(req.user, req.query.root, req.query.file);
    const fp = ref && ref.fp;
    if (!fp || !(await fileExists(fp))) return res.status(404).send("Not found");
    // A Bambu .3mf keeps its preview as a real PNG inside the archive rather
    // than base64 in a gcode comment.
    if (/\.3mf$/i.test(fp)) {
      const info = await netfs.threemfRead(fp);
      if (info.isBambu) {
        const plate = Math.max(1, parseInt(req.query.plate, 10) || info.plates[0] || 1);
        const png = await netfs.threemfPlateThumbnail(fp, plate);
        if (!png) return res.status(404).send("No thumbnail");
        res.set("Content-Type", "image/png");
        res.set("Cache-Control", "public, max-age=3600");
        return res.send(png);
      }
    }
    const HEAD = 2 * 1024 * 1024;
    const text = (await netfs.read(fp, 0, HEAD)).toString("latin1");   // the whole file when it is smaller
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
  } catch (e) {
    if (e && e.code === "NAS_UNREACHABLE") return res.status(503).send("G-code folder unreachable");
    res.status(500).send(e.message);
  }
});

const JOBS = new Map();   // jobId -> { phase, sent, total, done, error, result, ts }
const newJobId = () => "j" + Date.now() + Math.random().toString(16).slice(2, 6);
// When this process started: a page polling a job this server does not know
// can tell "SnapCon restarted since" from "no longer kept" (§37 P1).
const SERVER_STARTED_AT = Date.now();

// Upload deadlines (docs/TODO.md §37 P1). The connectors' defaults (10 s to
// connect, 60 s without the printer taking data, 120 s from the last byte to
// its answer) unless config.json's uploadTimeouts overrides one, in seconds:
//   "uploadTimeouts": { "connect": 10, "inactivity": 60, "confirm": 120 }
// No Settings UI. A value that is not a number is ignored; one outside its
// limits is held to the nearest limit. Each warning is logged once.
const UPLOAD_TIMEOUT_LIMITS = { connect: [2, 60], inactivity: [10, 600], confirm: [30, 1800] };
const UPLOAD_TIMEOUT_WARNED = new Set();
function uploadTimeoutsFromConfig(cfg) {
  const src = cfg && cfg.uploadTimeouts;
  const out = {};
  if (src == null) return out;
  const warn = msg => { if (!UPLOAD_TIMEOUT_WARNED.has(msg)) { UPLOAD_TIMEOUT_WARNED.add(msg); console.log("[config] uploadTimeouts: " + msg); } };
  if (typeof src !== "object" || Array.isArray(src)) { warn("not an object; the defaults apply"); return out; }
  for (const [key, [lo, hi]] of Object.entries(UPLOAD_TIMEOUT_LIMITS)) {
    if (src[key] == null) continue;
    const v = Number(src[key]);
    if (typeof src[key] === "boolean" || !Number.isFinite(v)) { warn(`${key} is not a number of seconds; its default applies`); continue; }
    const held = Math.min(hi, Math.max(lo, v));
    if (held !== v) warn(`${key} ${v} s is outside ${lo}–${hi} s; ${held} s is used`);
    out[key + "Ms"] = Math.round(held * 1000);
  }
  return out;
}

// Limits for the files kept for a busy printer (§37 P3), in MB, from
// config.json's deferredSends unless set there:
//   "deferredSends": { "maxFileMB": 512, "maxTotalMB": 4096, "freeMarginMB": 256 }
// maxFileMB cannot exceed 2048 (the push body limit). Held to the limits and
// warned once, as uploadTimeouts above.
const DEFERRED_LIMIT_KEYS = { maxFileMB: ["maxFileBytes", 1, 2048], maxTotalMB: ["maxTotalBytes", 64, 1048576], freeMarginMB: ["freeMarginBytes", 0, 1048576] };
function deferredLimitsFromConfig(cfg) {
  const src = cfg && cfg.deferredSends;
  const out = {};
  if (src == null || typeof src !== "object" || Array.isArray(src)) return out;
  for (const [key, [field, lo, hi]] of Object.entries(DEFERRED_LIMIT_KEYS)) {
    if (src[key] == null) continue;
    const v = Number(src[key]);
    if (typeof src[key] === "boolean" || !Number.isFinite(v)) { warnOnce(`[config] deferredSends: ${key} is not a number of MB; its default applies`); continue; }
    const held = Math.min(hi, Math.max(lo, v));
    if (held !== v) warnOnce(`[config] deferredSends: ${key} ${v} MB is outside ${lo}–${hi} MB; ${held} MB is used`);
    out[field] = Math.round(held * 1024 * 1024);
  }
  return out;
}
// How long finished transfers' results are kept (§37 P4), from config.json:
//   "transferResults": { "retentionHours": 24, "maxCount": 1000 }
// Held to 1–720 hours and 100–10000 results, warned once.
function transferResultLimitsFromConfig(cfg) {
  const src = cfg && cfg.transferResults;
  const out = { retentionHours: RESULT_LIMITS.retentionHours, maxCount: RESULT_LIMITS.maxCount };
  if (src == null || typeof src !== "object" || Array.isArray(src)) return out;
  for (const [key, lo, hi] of [["retentionHours", RESULT_LIMITS.retentionHoursMin, RESULT_LIMITS.retentionHoursMax], ["maxCount", RESULT_LIMITS.maxCountMin, RESULT_LIMITS.maxCountMax]]) {
    if (src[key] == null) continue;
    const v = Number(src[key]);
    if (typeof src[key] === "boolean" || !Number.isFinite(v)) { warnOnce(`[config] transferResults: ${key} is not a number; its default applies`); continue; }
    const held = Math.round(Math.min(hi, Math.max(lo, v)));
    if (held !== v) warnOnce(`[config] transferResults: ${key} ${v} is outside ${lo}–${hi}; ${held} is used`);
    out[key] = held;
  }
  return out;
}
function warnOnce(msg) { if (!UPLOAD_TIMEOUT_WARNED.has(msg)) { UPLOAD_TIMEOUT_WARNED.add(msg); console.log(msg); } }

// The upload a printer's fleet row reports while it is going out, so every
// tab — not only the one that started it — shows the card's upload strip
// (TODO §24). Jobs that carry printerId are /api/print's, /api/printfile's
// and the queue's dispatches (§28); only an upload phase counts (the others
// are not transfers; the read-back that follows one is), and the newest wins if two overlap. Who may see it is the row's own visibility;
// cancelling stays behind /api/print-cancel's role and printer checks.
//
// An upload stays in phase "upload" until the printer answers. Once its last
// byte is out it is confirming (job.confirmingSince): the printer may have the
// whole file, and a cancel then only stops what would follow (§37 P1).
function activeUploadFor(printerId) {
  let best = null, bestId = null;
  for (const [id, job] of JOBS) {
    if (job.printerId !== printerId || job.done || (job.phase !== "upload" && job.phase !== "verifying")) continue;
    if (!best || job.ts > best.ts) { best = job; bestId = id; }
  }
  // verifying (§37 P2): the printer has answered and its copy is read back;
  // still this upload's strip, nothing left to cancel.
  if (best && best.phase === "verifying") return { jobId: bestId, file: best.file || "", sent: best.total || 0, total: best.total || 0, cancellable: false, verifying: true, startsPrint: !!best.startsPrint };
  return best ? { jobId: bestId, file: best.file || "", sent: best.sent || 0, total: best.total || 0, cancellable: !!best.cancelUpload,
    ...(best.confirmingSince ? { confirming: true, startCancelled: !!best.cancelRequested, startsPrint: !!best.startsPrint } : {}) } : null;
}
// What became of the transfer itself, kept on the job apart from whatever
// followed it (mapping, the start): "sent" (the printer accepted it),
// "failed" (it did not complete — not evidence of what the printer holds),
// "unknown" (every byte sent, no definite answer). Reported by
// /api/print-status; Unknown never starts a print and is never retried.
function noteUploadFailure(job, e) {
  if (!job.outcome) job.outcome = (e && e.outcome) || "failed";
  if (e && e.reason) job.errorReason = e.reason;
  if (e && e.seconds) job.errorSeconds = e.seconds;
  if (e && e.printerPrompt) job.printerPrompt = true;
}
// The upload went through but a cancel came while the printer was confirming
// it: nothing that follows is done (§37 P1, decision Q1).
function cancelledAfterSending(job, p) {
  return Object.assign(new Error(`Cancelled. ${p.name} confirmed it received the file; nothing more was done with it.`), { code: "UPLOAD_CANCELLED", outcome: job.outcome || "sent" });
}

// After the printer accepted a file, what it actually holds under that name,
// read back before anything may start it (§37 P2). The connector's
// verifyUpload answers; only "verified" (content checked) and "acknowledged"
// (the printer lists it, at the right size where it reports one) let the
// caller go on. "mismatch" is proof of other content under that name: Failed.
// "absent" and "unverifiable" leave what the printer holds unknown: Unknown,
// which never starts a print. A connector with no verifyUpload is
// unverifiable. Nothing is deleted on any answer (D6).
//
// The printer has answered for the upload by now, so Cancel is already
// disarmed, as in P1: the check runs to its end. The answer stays on the job
// (job.verification) for /api/print-status and for what is staged.
const START_OK_VERIFICATIONS = new Set(["verified", "acknowledged"]);
// earlier: the file was uploaded before this run (a queue item staged with
// alreadyUploaded), not just now, which only changes what is said.
// job.localStat: the source's identity (netfs.identity) taken before its
// bytes were read for this upload. It is taken again after the read-back,
// whatever the printer said (§37 A4, owner 2026-10-29): the read-back samples
// the file (exact size plus its start, middle and end), so an edit of the
// same size elsewhere during the send would otherwise pass. A source that
// changed is Unknown, "changed on this computer" — never Verified, never
// Loaded; one whose identity was not taken, or cannot be taken again, is
// Unknown too (fail closed). earlier: nothing was sent in this run.
const SOURCE_IDENTITY_KEYS = ["size", "mtimeNs", "ctimeNs", "ino", "dev"];
const sameSource = (a, b) => !!a && !!b && SOURCE_IDENTITY_KEYS.every(k => a[k] != null && a[k] === b[k]);
const sourceIdentityNow = fp => netfs.identity(fp).catch(() => null);
async function verifyOnPrinter(p, c, name, fp, job, { earlier = false } = {}) {
  job.phase = "verifying";
  let v;
  try { v = c.verifyUpload ? await c.verifyUpload(p, name, fp) : { result: "unverifiable", evidence: "this printer type cannot read files back" }; }
  catch (e) { v = { result: "unverifiable", evidence: e.message }; }
  let result = (v && v.result) || "unverifiable";
  if (!earlier && (START_OK_VERIFICATIONS.has(result) || result === "mismatch")) {
    const now = job.localStat ? await sourceIdentityNow(fp) : null;
    if (!job.localStat || !now) {
      result = "local-unreadable";
      v = { result, evidence: `the file on this computer could not be checked again after it was sent` };
    } else if (!sameSource(job.localStat, now)) {
      result = "local-changed";
      v = { result, evidence: `the local ${name} changed while it was being sent, so the printer's copy cannot be compared` };
    }
  }
  job.verification = { result, ...(v && v.basis ? { basis: v.basis } : {}), evidence: (v && v.evidence) || null, at: Date.now() };
  console.log(`[verify] ${p.name}: "${name}" ${result}${job.verification.evidence ? " — " + job.verification.evidence : ""}`);
  if (START_OK_VERIFICATIONS.has(result)) return job.verification;
  if (result === "mismatch") {
    job.outcome = "failed";
    throw Object.assign(new Error(`${p.name} accepted ${name}, but the file it holds under that name is not the one sent (${job.verification.evidence}).`), { code: "UPLOAD_MISMATCH", outcome: "failed" });
  }
  job.outcome = "unknown";
  const reason = result === "absent" ? (earlier ? "gone-from-printer" : "not-on-printer") : result === "local-changed" || result === "local-unreadable" ? result : "verify-unreadable";
  const message = reason === "gone-from-printer" ? `${name} was uploaded to ${p.name} earlier, but it is no longer in the printer's file list.`
    : reason === "not-on-printer" ? `All of ${name} was sent and ${p.name} accepted it, but it is not in the printer's file list.`
    : reason === "local-changed" ? `${name} changed on this computer while it was being sent, so SnapCon cannot tell whether ${p.name} has the right copy.`
    : reason === "local-unreadable" ? `${name} could not be checked again on this computer after it was sent, so SnapCon cannot tell whether ${p.name} has the right copy.`
    : `All of ${name} was sent and ${p.name} accepted it, but SnapCon could not check the printer's copy (${job.verification.evidence}).`;
  throw Object.assign(new Error(message), { code: "UPLOAD_UNCONFIRMED", outcome: "unknown", reason });
}
// What a staged ("Loaded") entry keeps of the check, for P5 and the card.
const stagedVerification = v => v ? { verification: v.result, verifiedAt: v.at } : {};
// The queue's dispatch to this printer while one runs (TODO §28): it has a
// JOBS entry from its claim to its end, marked by queueItemId. While it runs
// the printer is taken: manual sends and starts are refused.
function queueDispatchJob(printerId) {
  for (const job of JOBS.values()) if (job.queueItemId && job.printerId === printerId && !job.done) return job;
  return null;
}
const queueSendingRefusal = (p, job) => `${p.name} is receiving its next queued job ("${job.file}"). Try again once it has started.`;
// Anything other than the queue sending to or starting on this printer: a
// send or start of its own in JOBS, a deferred file going out, or a start
// sequence. The queue does not claim the printer while one runs (§28).
function otherSendInFlight(p) {
  if (STARTING.has(p.id)) return true;
  for (const job of JOBS.values()) if (!job.queueItemId && job.printerId === p.id && !job.done) return true;
  const qf = queuedFile.get(p.id);
  return !!(qf && qf.status === "uploading");
}

// The one per-printer transfer lock (§37 P3): a start, any send (manual,
// deferred, CLI) or a queue dispatch in progress. Every path that sends a file
// checks it with nothing awaited before registering its job, so no two
// transfers to one printer overlap. Jobs stay registered through the P2
// read-back, so the lock is held until the check is done.
const transferBusy = p => otherSendInFlight(p) || !!queueDispatchJob(p.id);
function transferBusyRefusal(p) {
  const qj = queueDispatchJob(p.id);
  if (qj) return queueSendingRefusal(p, qj);
  if (STARTING.has(p.id)) return `${p.name} is starting a print. Try again once it has started.`;
  const j = [...JOBS.values()].find(x => !x.done && x.printerId === p.id);
  return `${p.name} is receiving another file${j && j.file ? " (" + j.file + ")" : ""}. Try again once it has finished.`;
}

// Normal cleanup happens when /api/print-status reads a finished job — but if
// the tab closed mid-upload nobody ever polls, so sweep abandoned finished
// jobs too. Every completion path (success or error) sets done.
//
// Kept for JOB_MAX_AGE after the job FINISHED, not after it was created: a job
// that ran longer than that (a slow upload, a long leveling) was otherwise
// deleted within a minute of finishing, and a tab whose timers the browser had
// slowed read "No such job" for a job that succeeded (docs/TODO.md §37 P0-3).
// The sweep notes when it first sees a job done, so this covers every
// completion path without each one keeping a time: a job is kept at least
// JOB_MAX_AGE after it finished, and at most one sweep longer.
const JOB_MAX_AGE = 10 * 60 * 1000;
function sweepFinishedJobs(now) {
  for (const [id, job] of JOBS) {
    if (!job.done) continue;
    if (job.doneSeenAt == null) { job.doneSeenAt = now; continue; }
    if (now - job.doneSeenAt >= JOB_MAX_AGE) JOBS.delete(id);
  }
}
setInterval(() => sweepFinishedJobs(Date.now()), 60 * 1000).unref();

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
// A toolhead map, { color: head }, from a request or from disk: its values reach
// G-code (the U1's MAP_EXTRUDER=), so it is whole numbers within what this printer
// addresses (capabilities.maxMapTools, maxMapHeads; 32 where a connector states no
// less), or it is refused whole: part of a map would print on the wrong heads.
function checkToolMap(map, p) {
  if (map == null) return { map: {} };
  const caps = getCapabilities(p.connector, p) || {};
  const tools = caps.maxMapTools || 32, heads = caps.maxMapHeads || 32;
  const error = `That toolhead mapping is not valid for ${p.name}: colors are 0-${tools - 1} and heads 0-${heads - 1}.`;
  if (typeof map !== "object" || Array.isArray(map)) return { error };
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!/^\d+$/.test(k) || Number(k) >= tools || !Number.isInteger(n) || n < 0 || n >= heads) return { error };
    out[k] = n;
  }
  return { map: out };
}
// What a person chose with a send that does not start (TODO §38): the toolhead
// map, and the print options they ticked. Nothing is sent to the printer until
// the print starts, so the Loaded file keeps them for its Print. An option left
// unticked is no choice: the Send dialog always sends all three, false unless
// ticked, and those falses are overrides only for a print starting now. Later,
// the printer's own default decides (withPrefFallback). Also reads
// queued-files.json: someone chose a map, so one that does not check out there
// stops the Print (mapInvalid) rather than print on the printer's own mapping. A
// record that never had a map has none to doubt.
function stagedChoices(map, prefs, p) {
  const out = {};
  const checked = map === null ? { error: true } : checkToolMap(map, p);
  if (checked.error) { out.mapInvalid = true; console.warn(`[queued-files] ${p.name}: a saved toolhead mapping is not valid; its Print is refused`); }
  else if (Object.keys(checked.map).length) out.map = checked.map;
  const ticked = {};
  for (const k of ["autoLevel", "flowCalibrate", "timelapse"]) if (prefs && prefs[k] === true) ticked[k] = true;
  if (Object.keys(ticked).length) out.prefs = ticked;
  return out;
}

// Which file types a connector accepts. Declared as capabilities.fileTypes;
// ABSENT means the whole set SnapCon's library has always offered, so no
// existing connector changes behaviour.
//
// This exists because the two mistakes are silent: plain gcode sent to a Bambu
// Lab printer is uploaded happily and then cannot be started (that firmware
// only runs a sliced .3mf project), and a .3mf sent to a Klipper printer is a
// zip it will never execute. Both surfaced at the machine, if at all.
//
// Returns a sentence to refuse with, or null when the file is fine.
const DEFAULT_FILE_TYPES = ["gcode", "gco", "g", "gx", "3mf"];
function fileTypeRefusal(capabilities, name, printerName) {
  const accepted = (capabilities && Array.isArray(capabilities.fileTypes) && capabilities.fileTypes.length)
    ? capabilities.fileTypes
    : DEFAULT_FILE_TYPES;
  const ext = String(name || "").toLowerCase().split(".").pop();
  if (ext && String(name).includes(".") && accepted.some(t => t.toLowerCase() === ext)) return null;
  const list = accepted.map(t => "." + t).join(", ");
  return `${printerName} cannot print "${name}". It accepts ${list}.`;
}

// ---- Never write over the job a printer is running ----
// Moonraker's upload endpoint takes no overwrite flag and replaces a
// same-named file in place, while Klipper's virtual_sdcard streams the RUNNING
// job out of that same file by byte offset. Sending a file whose name matches
// the active job can therefore corrupt a print that is hours in. Whether
// Moonraker truncates in place is deliberately not established experimentally
// — the whole point is to never find out on someone's 22-hour job.
//
// Pure, so the rule itself is testable without a printer. `activeFilename` is
// whatever the connector last reported as the running file; the STATE carries
// the decision, because connectors deliberately leave a stale filename on the
// payload after a job ends and on a Klippy fault, as a diagnostic.
function activeJobConflict(printerState, activeFilename, targetName) {
  if (printerState !== "printing" && printerState !== "paused") return false;
  if (!activeFilename || !targetName) return false;
  // Basename on both sides: a stored path can carry a subfolder while an
  // upload lands under a bare basename, so comparing raw strings would miss
  // exactly the collision this exists to catch. Case-sensitive — these are
  // Linux filesystems, where Job.gcode and job.gcode are two different files.
  const base = s => String(s).replace(/\\/g, "/").split("/").pop();
  return base(activeFilename) === base(targetName);
}

// Why a file on the printer must not be deleted right now, or null. Pure, so
// the whole table is testable without a printer. Names are compared by
// basename, like activeJobConflict(): a stored path may carry a subfolder the
// other side doesn't, and a false match only refuses, never deletes.
//   state/activeFilename  the printer's probe (printing or paused on this file)
//   starting              a start sequence is running (STARTING), during which
//                         the printer still reports an idle-looking state
//   staged                queuedFile's entry for the printer, if any
//   queue                 the printer's queue: pending items and the current one
//   uploading             names of /api/print uploads to this printer in flight
function printerFileDeleteRefusal({ printerName, file, state, activeFilename, starting, staged, queue, uploading }) {
  const base = s => String(s).replace(/\\/g, "/").split("/").pop();
  const name = base(file);
  if (starting) return `${printerName} is starting a print. Try again once it has started.`;
  if (activeJobConflict(state, activeFilename, file)) return `"${name}" is the file ${printerName} is printing right now.`;
  if (staged && base(staged.name) === name && staged.status !== "ready" && staged.status !== "error") {
    return `"${name}" is still being sent to ${printerName}.`;
  }
  if ((uploading || []).some(n => base(n) === name)) return `"${name}" is still being sent to ${printerName}.`;
  // A queued item that was already uploaded will start this file without
  // sending it again; the one being dispatched may be sending or starting it.
  const waiting = (queue || []).some(i => i && i.file && base(i.file.name) === name &&
    ((i.status === "queued" && i.alreadyUploaded) || i.status === "dispatching"));
  if (waiting) return `"${name}" is waiting in ${printerName}'s queue. Remove it from the queue first.`;
  return null;
}

// G-code folder files a delete is moving to the trash right now (reserved by
// fileTrash in the same step as its last gcodeFileInUse check). An upload,
// waiting send or queue item about to start using one refuses at the moment
// it registers, so neither side can pass its check while the other is past
// its own. Kept for a while after a rename whose result is unknown (the share
// stopped answering): it may still happen.
const DELETING = new Map();
const FILE_UNKNOWN_HOLD_MS = 10 * 60 * 1000;
const fileKey = s => { const r = path.resolve(String(s)); return process.platform === "win32" ? r.toLowerCase() : r; };
function reserveGcodeDelete(fp) { const k = fileKey(fp); DELETING.set(k, (DELETING.get(k) || 0) + 1); }
function releaseGcodeDelete(fp, outcome) {
  const done = () => { const k = fileKey(fp), n = (DELETING.get(k) || 0) - 1; if (n > 0) DELETING.set(k, n); else DELETING.delete(k); };
  if (outcome === "unknown") setTimeout(done, FILE_UNKNOWN_HOLD_MS).unref(); else done();
}
const gcodeFileBeingDeleted = fp => !!fp && DELETING.has(fileKey(fp));
// A queue item's file, if it is one of those (Library locations never are).
function queueFileBeingDeleted(file) {
  if (!file || (file.root && file.root !== GCODE_ROOT)) return false;
  return gcodeFileBeingDeleted(resolveWithinFolder((file.sub ? file.sub + "/" : "") + file.name, FOLDER));
}
const BEING_DELETED = name => `${name} is being deleted.`;

// Per-file "being prepared" holds (owner review, 2026-11-05): a send takes one
// on its file synchronously, before its first file-dependent await (the
// existence check, the hash), and keeps it until its request handler has
// finished — by then it is recorded (an upload job, a waiting send, a queue
// item), which gcodeFileInUse sees for as long as the file is needed. A file
// being deleted is refused here; a held file is refused by the delete. Each
// side marks and checks in one synchronous step, so both can never pass.
// Released when the handler's promise settles (withGcodeHolds), never on the
// HTTP response closing: a client that hangs up mid-hash leaves the handler
// running, and still needing the file.
const PREPARING = new Map();
function holdGcodeFile(req, fp) {
  if (!fp) return true;
  const k = fileKey(fp);
  if (DELETING.has(k)) return false;
  PREPARING.set(k, (PREPARING.get(k) || 0) + 1);
  (req.gcodeHolds || (req.gcodeHolds = [])).push(k);
  return true;
}
function releaseGcodeHolds(req) {
  for (const k of req.gcodeHolds || []) { const n = (PREPARING.get(k) || 0) - 1; if (n > 0) PREPARING.set(k, n); else PREPARING.delete(k); }
  req.gcodeHolds = [];
}
const withGcodeHolds = handler => async (req, res, next) => {
  try { return await handler(req, res, next); } finally { releaseGcodeHolds(req); }
};

// Why the G-code folder file at fp must not be deleted now, or null: an
// upload of it in progress, a waiting send that will read it, or a queue item
// that names it (pending or current). Synchronous, so fileTrash can ask it
// with nothing awaited before the rename. Fails closed when the waiting sends
// or the queue could not be read: a reference we cannot see may exist.
// A printer `user` may not see is named only as "a printer".
function gcodeFileInUse(fp, user) {
  const key = fileKey;
  const k = key(fp);
  if (DELETING.has(k)) return "Another delete of this file is in progress.";
  if (PREPARING.has(k)) return "It is being prepared for a send. Try again in a moment.";
  const nameOf = id => { const p = PRINTERS.find(x => x.id === id); return p && printerVisibleTo(user, p) ? p.name : "a printer"; };
  for (const job of JOBS.values()) {
    if (!job.done && job.sourcePath && key(job.sourcePath) === k) return `It is being sent to ${nameOf(job.printerId)}.`;
  }
  const ds = deferredStore.status();
  if (ds.recoveryRequired || ds.dropped) return "The list of waiting sends can't be fully read right now, so a send may still need this file.";
  for (const r of deferredStore.list({ states: ["queued", "uploading", "interrupted", "attention"] })) {
    if (!r.bytes && r.source && r.source.path && key(r.source.path) === k) return `A send to ${nameOf(r.printerId)} is waiting for it. Cancel that send first.`;
  }
  if (queueStore.getGlobalStatus().queueStoreRecoveryRequired) return "The print queue can't be read right now, so a queue item may still need this file.";
  for (const p of PRINTERS) {
    const qs = queueStore.getPrinterState(p.id) || {};
    for (const item of [...(qs.queue || []), ...(qs.currentItem ? [qs.currentItem] : [])]) {
      if (!item || !item.file || (item.file.root && item.file.root !== GCODE_ROOT)) continue;
      const ifp = resolveWithinFolder((item.file.sub ? item.file.sub + "/" : "") + item.file.name, FOLDER);
      if (ifp && key(ifp) === k) return printerVisibleTo(user, p) ? `It is in ${p.name}'s queue. Remove it from the queue first.` : "It is in a printer's queue.";
    }
  }
  return null;
}

// Throws a 409 when sending `name` to `p` would disturb its running job.
// probeCached() re-probes an online printer on every call (it caches only
// OFFLINE results), so this reads current state rather than a stale snapshot —
// which matters here more than anywhere else in the app.
// `action` only picks the wording: "send" is about to overwrite the file,
// "start" is about to re-start the one already running. Both are refused.
async function assertNotActiveJobFile(p, name, action = "send") {
  let st;
  try { st = await probeCached(p); } catch { return; } // unreachable: it cannot be printing at us
  if (!st || !st.online) return;
  if (!activeJobConflict(st.state, st.filename, name)) return;
  const e = new Error(action === "start"
    ? `${p.name} is already printing "${name}". Wait for it to finish before starting it again.`
    : `"${name}" is the file ${p.name} is printing right now. Sending it would overwrite the job in progress. ` +
      `Wait for it to finish, or send the file under a different name.`);
  e.status = 409;
  throw e;
}

// ---- What the Upload / Print buttons do to a busy printer ----
// Pure, so the whole decision table is testable without a printer.
//
// "Upload" used to mean two different things: on an ordinary printer it staged
// a file for later, while on one belonging to a queue pool the same click
// created a queue ITEM that would eventually upload AND start a print. Same
// button, two outcomes, nothing on screen saying which. Upload now always
// means upload, and scheduling is the separate `uploadIntoQueue` setting —
// which applies ALWAYS, not only when the printer happened to be mid-print,
// since a setting that only sometimes does what its label says is the hidden
// conditional this replaces.
//
// Deferring an upload existed to avoid racing a transfer against a running
// print. The dangerous half of that race — writing over the file being
// streamed — is refused outright by assertNotActiveJobFile, so what remains is
// a preference (`allowWhilePrinting`) rather than a rule. Upload-AND-print
// against a busy printer stays refused either way; that had no server-side
// guard at all, only a disabled button.
function uploadDisposition({ start, busy, allowWhilePrinting, uploadIntoQueue, pooled }) {
  // Printing needs the printer, not just its filesystem.
  if (start && busy) return { action: "refuse", queue: false, alreadyUploaded: false };
  // A queue item is only meaningful for an upload; a print starts now.
  const queue = !start && !!uploadIntoQueue && !!pooled;
  if (!start && busy && !allowWhilePrinting) {
    // Deferred: the bytes are not on the printer yet, so an item created here
    // must NOT claim they are or dispatch would skip the upload entirely.
    return { action: "defer", queue, alreadyUploaded: false };
  }
  return { action: "upload", queue, alreadyUploaded: queue };
}

// A queue item names its file as { name, sub } relative to the G-code folder,
// and dispatch rebuilds the path from exactly that pair. Derived from the
// resolved path so a file in a subfolder keeps its subfolder: a bare basename
// made dispatch look at the top of the folder and fail the item as missing.
function queueFileRef(fp, folder) {
  const parts = path.relative(folder, fp).split(path.sep);
  const name = parts.pop();
  return { name, sub: parts.join("/") };
}

// ---- Replacing a file the printer already has ----
// Every accepted send uploads the file (owner, 2026-10-29): no comparison
// SnapCon can make proves a printer's copy is identical — Moonraker publishes
// no checksum, and the read-back only samples the size, start, middle and
// end — so a matching sample is never taken as reason not to send.
//
// With "replace a file the printer already has" off (overwriteDifferentFiles
// false), a file is sent only when the printer is known NOT to hold one at
// that exact name. One holding it, or a printer that cannot say (an
// unreadable list, FlashForge's ten-newest list when full), is refused: the
// guard fails closed rather than overwriting on incomplete evidence.
async function decideUpload(p, name) {
  if (CFG.overwriteDifferentFiles !== false) return { action: "upload" };
  const c = getConnector(p.connector);
  let v = null;
  if (c.verifyUpload) {
    try { v = await c.verifyUpload(p, name, null, { attempts: 1 }); }
    catch (e) { v = { result: "unverifiable", evidence: e.message }; }
  }
  if (v && v.result === "absent") return { action: "upload" };
  const off = "Replacing files on the printer is switched off in Settings";
  if (v && v.result !== "unverifiable") return { action: "refuse", present: true, reason: `${p.name} already has a file called "${name}". ${off}, and SnapCon can't prove the two are the same, so it doesn't replace it. Turn replacing on, or send this one under a different name.` };
  return { action: "refuse", reason: `SnapCon couldn't check whether ${p.name} already has a file called "${name}"${v && v.evidence ? ` (${v.evidence})` : ""}. ${off}, so it isn't sent. Try again, turn replacing on, or send it under a different name.` };
}

app.post("/api/print", requireRegular, withGcodeHolds(async (req, res) => {
  // root (M7, §12): the Library location the file is in; absent = the G-code
  // folder. library: { key, plate } — the Variant chosen on a Model page.
  const { file, printer, start, map: mapAsked, prefs, root, library: lib, plate: plateAsked } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  if (p.maintenanceMode) return res.status(409).json({ error: p.name + " is in maintenance mode — take it off maintenance before printing." });
  const { map, error: mapError } = checkToolMap(mapAsked, p);
  if (mapError) return res.status(400).json({ error: mapError, code: "bad_tool_map" });
  let ref, ident = null, plate = null;
  try {
    ref = await resolveFileRef(req.user, root, file);
    // Held before anything reads it (holdGcodeFile).
    if (ref && !holdGcodeFile(req, ref.fp)) return res.status(409).json({ error: BEING_DELETED(path.basename(ref.fp)), code: "file_being_deleted" });
    if (!ref || !(await fileExists(ref.fp))) return res.status(404).json({ error: "File not found" });
    const pl = await resolvePrintPlate(p, ref.fp, plateAsked);
    if (pl.error) return res.status(pl.status).json({ error: pl.error, code: pl.code });
    plate = pl.plate;
    // The Variant printed is the plate that prints: a plate changed in the
    // Send dialog is that plate's Variant.
    if (lib) ident = await libraryPrintIdentity(ref, { ...lib, plate: plate != null ? plate : lib.plate });
  } catch (e) { if (replyFileRefError(res, e, root)) return; return res.status(500).json({ error: e.message }); }
  if (ident && ident.plate != null && ident.plate !== (plate != null ? plate : 1)) {
    return res.status(400).json({ error: `${p.name} can only start plate 1 of a project, and this is plate ${ident.plate}.`, code: "plate_unsupported" });
  }
  const fp = ref.fp;
  // Before anything is uploaded: a file this printer could never start is
  // refused here rather than after a multi-megabyte transfer.
  const typeRefusal = fileTypeRefusal(getCapabilities(p.connector, p), path.basename(fp), p.name);
  if (typeRefusal) return res.status(400).json({ error: typeRefusal });
  // Ahead of the upload-or-queue decision below: queuing a file that would
  // overwrite the running job only defers the damage.
  try { await assertNotActiveJobFile(p, path.basename(fp)); }
  catch (e) { return res.status(e.status || 409).json({ error: e.message }); }

  // map is { logicalToolIndex: physicalHeadIndex }. Several colors may share one
  // head (or slot): printing two of a file's colors with the same filament is a
  // normal choice, and every connector sends one assignment per color (the U1's
  // SET_PRINT_EXTRUDER_MAP, the IFS port, the AMS tray, the CFS table), so it is
  // expressible everywhere. This used to be refused when starting a print; the
  // /api/printfile path never refused it.
  let tools = [];
  if (map && Object.keys(map).length) {
    tools = Object.keys(map).map(Number).sort((a, b) => a - b);
  }

  const c = getConnector(p.connector);
  const name = path.basename(fp);
  // Another transfer to this printer (a queue dispatch, a deferred or CLI
  // send, another Upload): no connector is known to take two at once, so this
  // is refused, Upload as well as Print (TODO §28, §37 P3).
  if (transferBusy(p)) return res.status(409).json({ error: transferBusyRefusal(p), code: "printer_receiving" });

  // What this click actually does to a printer that is already busy, and
  // whether it also schedules a print — see uploadDisposition's own comment.
  const pooled = !!(CFG.queueManagement && CFG.queueManagement.enabled && p.printerPoolId);
  const disposition = uploadDisposition({
    start: !!start,
    busy: !(await isPrinterIdle(p)),
    allowWhilePrinting: CFG.allowUploadWhilePrinting !== false,
    uploadIntoQueue: CFG.uploadIntoQueue === true,
    pooled,
  });

  if (disposition.action === "refuse") {
    return res.status(409).json({ error: `${p.name} is printing — wait for it to finish before starting another job. You can still upload a file to it.` });
  }

  // Adds the queue item this click asked for. `uploaded` says whether the
  // bytes are already on the printer, which is what stops dispatch sending
  // them a second time.
  const addQueueItem = async (uploaded) => {
    const actor = actorFromReq(req);
    let hash;
    try { hash = await queueStore.computeFileHash(fp); } catch { return false; }
    if (!hash) return false;
    if (ident && hash.sha256 !== ident.sha256) return false;
    // A file being deleted is not queued (gcodeFileBeingDeleted); nothing is
    // awaited from here to the item being stored.
    if (gcodeFileBeingDeleted(fp)) return false;
    const result = queueStore.applyIntent(p.id, (state) => ({
      ...state,
      queue: [...state.queue, {
        id: QueueEngine.newQueueItemId(), status: "queued", alreadyUploaded: !!uploaded,
        file: { ...queueFileRef(fp, ref.dir), ...(ref.root !== GCODE_ROOT ? { root: ref.root } : {}), sizeBytes: hash.sizeBytes, sha256: hash.sha256 },
        ...(ident ? { library: libraryQueueRef(ident) } : {}),
        map, prefs, createdAt: Date.now(), dispatchedAt: null, finishedAt: null,
        queuedBy: actor, retryOfItemId: null, dispatchSnapshot: null
      }],
      updatedAt: Date.now()
    }));
    if (!result.ok) return false;
    auditLog.log({ category: "job", event: "queue-item-added", ...actor, printerId: p.id, printerName: p.name, detail: { count: 1, viaLegacyUpload: true, ...(ident ? { library: libraryAudit(ident) } : {}) } });
    return true;
  };

  // Deferred: hold the file and send it when the printer frees up. The queue
  // item, if one was asked for, uploads at dispatch because the bytes are not
  // there yet.
  if (disposition.action === "defer") {
    if (disposition.queue && await addQueueItem(false)) return res.json({ ok: true, mode: "queued", printer: p.name });
    // Kept on disk, in order, before the answer (§37 P3).
    let rec;
    try { rec = await acceptDeferredSend(p, { name, kind: ident ? "library" : "folder", file: fp, tools, map, prefs, plate, actor: actorFromReq(req), send: sendRef(ref, ident, plate) }); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}) }); }
    return res.json({ ok: true, mode: "pending", printer: p.name, transferId: tidOf(rec) });
  }

  // Decided BEFORE the job id is handed out, so a refusal is a plain HTTP
  // error the user sees immediately rather than a job that fails a moment
  // later. Costs one sub-second round trip, and only when a setting could act
  // on the answer.
  const plan = await decideUpload(p, name);
  if (plan.action === "refuse") return res.status(409).json({ error: plan.reason, code: "printer_has_file" });
  // Again where the job is registered, with nothing awaited in between: the
  // queue or another send may have taken the printer while decideUpload
  // asked it (§28, §37 P3).
  if (transferBusy(p)) return res.status(409).json({ error: transferBusyRefusal(p), code: "printer_receiving" });

  // Kick the work off in the background and hand the client a job id to poll.
  const jobId = newJobId();
  // printerId/file: which printer the upload is going to and under what name,
  // so deleting that file from the printer is refused while it is in flight.
  // sourcePath: the file it reads, so deleting that file here is refused too.
  // Not while that file is being deleted (gcodeFileBeingDeleted), checked with
  // nothing awaited before the job is registered.
  if (gcodeFileBeingDeleted(fp)) return res.status(409).json({ error: BEING_DELETED(name), code: "file_being_deleted" });
  const job = { phase: "upload", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now(), printerId: p.id, file: name, sourcePath: fp, timeouts: uploadTimeoutsFromConfig(CFG), startsPrint: !!start };
  JOBS.set(jobId, job);
  res.json({ jobId });
  const actor = actorFromReq(req);

  (async () => {
    try {
      // What the Library compares a plain send against (content_fp, §9): the
      // file's size and modified time as it went out.
      // The file's own size is also what a staged copy is checked against
      // later (checkStagedCopy): never job.total, which is the whole
      // upload body, multipart framing included, on Moonraker and FlashForge.
      let sentStat = null, fileSize = null;
      // The source's identity before its bytes are read (verifyOnPrinter).
      job.localStat = null;
      try {
        const s = await netfs.identity(fp);
        fileSize = s.size;
        job.localStat = s;
        if (start && !ident) sentStat = { size: s.size, mtimeMs: s.mtimeMs };
      } catch {}
      // A Library send: the file is still the one the Library read (A4 review R3).
      if (ident && job.localStat && Number.isFinite(ident.size) && (job.localStat.size !== ident.size || Math.abs(job.localStat.mtimeMs - ident.mtimeMs) >= 1)) {
        library.rescan(ref.root).catch(() => {});
        throw Object.assign(new Error(`${name} changed since the Library last read it; nothing was sent. Try again in a moment.`), { code: "LIBRARY_FILE_CHANGED", outcome: "failed" });
      }
      await whileUploading(() => c.uploadFile(p, fp, name, job));   // 1) upload (with progress)
      console.log(`[print] ${p.name}: upload resolved for "${name}" (start=${start})`);
      job.outcome = "sent";
      // Cancelled while the printer was confirming: it has the file, and
      // nothing more happens — no check, no mapping, no start, no staging.
      // Checked with nothing awaited since the upload settled, which disarmed
      // Cancel in the same step, so a cancel lands either before this (nothing
      // starts) or after it (refused: the file is on the printer).
      if (job.cancelRequested) throw cancelledAfterSending(job, p);
      // 2) what the printer holds under that name, read back (§37 P2). Throws
      // Unknown or Failed; only a verified or acknowledged copy goes on.
      await verifyOnPrinter(p, c, name, fp, job);
      // 2) toolhead mapping + print-preference macros (connector-optional),
      // only for a print that starts here: an upload changes nothing on the
      // printer but its files (TODO §38). Still needed with no mapping chosen
      // (tools=[]) when the printer has its own preferences
      // (auto-level/flow-calibrate/timelapse) to send before print start.
      // Guarded from here: applyHeadMapping is where the long waits live.
      await withStartSequence(p, async () => {
        if (start && c.applyHeadMapping && (tools.length || printerHasAnyDefaultPref(p) || wantsAnyPref(prefs))) {
          job.phase = "mapping";
          console.log(`[print] ${p.name}: applyHeadMapping starting (tools=${tools.length}, prefs=${JSON.stringify(prefs)}, printer defaults autoLevel=${!!p.autoLevel} flowCalibrate=${!!p.flowCalibrate} timelapse=${!!p.timelapse})`);
          await c.applyHeadMapping(p, tools, map, prefs, { file: name, plate });
          console.log(`[print] ${p.name}: applyHeadMapping resolved`);
        }
        if (start) {
          job.phase = "starting";
          console.log(`[print] ${p.name}: startPrintFile starting for "${name}"${plate != null ? " (plate " + plate + ")" : ""}`);
          await c.startPrintFile(p, name, { plate, prefs });
          console.log(`[print] ${p.name}: startPrintFile resolved`);
        }
      });
      if (!start) {
        // The file is on the printer now. Surface it the same "ready to
        // print" way a deferred send does once it lands (applyDeferredCompleted):
        // one click away, not silently just stored. It keeps what was sent
        // (plate, Library Variant) and what was chosen (map, ticked options)
        // for when it is started from there.
        queuedFile.set(p.id, { name, status: "ready", ts: Date.now(), plate, send: sendRef(ref, ident, plate), size: fileSize, sizeOf: "file", ...stagedVerification(job.verification), ...stagedChoices(map, prefs, p) });
        saveQueuedFiles();
      } else if (queuedFile.get(p.id) && queuedFile.get(p.id).name === name) {
        // This upload replaced the printer's copy of a file staged earlier.
        queuedFile.delete(p.id); saveQueuedFiles();
        // "Upload into queue": the item is added only after the bytes are
        // actually there, and carries alreadyUploaded so dispatch does not
        // send the same file a second time.
        if (disposition.queue) await addQueueItem(true);
      }
      job.result = { printer: p.name, started: !!start, mapped: start ? tools.length : 0, verification: job.verification ? job.verification.result : null };
      job.phase = "done"; job.done = true;
      if (start) ROUTE_STARTED_PRINT.add(p.url);
      const auditRef = auditLog.log({ category: "job", event: start ? "print-started" : "file-uploaded", ...actor, printerId: p.id, printerName: p.name,
        detail: { file: name, ...(job.verification ? { verification: job.verification.result } : {}), ...(ident ? { library: libraryAudit(ident) } : {}) } });
      // Print history (M7): this job, as the Variant chosen in the Library or
      // as the file sent from where it is.
      if (start) {
        library.recordPrintStart({
          jobKey: "print:" + jobId, printerId: p.id, printerName: p.name, remoteName: name, source: ident ? "library" : "send", via: "print",
          user: actor, startedAt: Date.now(), auditRef, location: ref.root + ":" + relOf(ref), stat: sentStat,
          library: ident ? { contentKey: ident.contentKey, plate: ident.plate, model: ident.model, variantKey: ident.variantKey, sha256: ident.sha256 } : null,
        });
      }
    } catch (e) {
      // Already recorded as done (an audit or history write failed after a
      // successful start): the result stands; this is only logged.
      if (job.done) { console.log(`[print] ${p.name}: after "${name}" ${job.result && job.result.started ? "started" : "uploaded"}: ${e.message}`); return; }
      console.log(`[print] ${p.name}: FAILED at phase "${job.phase}" — ${e.message}`);
      if ((e && e.code === "UPLOAD_CANCELLED") || job.cancelRequested) job.cancelled = true;
      if (job.phase === "upload" || job.phase === "verifying") noteUploadFailure(job, e);
      // The code (ECONNRESET, ETIMEDOUT, UPLOAD_REJECTED, NAS_UNREACHABLE…)
      // and the phase it failed in let the browser say what went wrong in
      // plain words, and tell an upload failure from a start failure.
      job.errorCode = (e && e.code) || null; job.failedPhase = job.phase;
      job.error = e.message; job.done = true; job.phase = "error";
      // After the job is settled, so a failing audit write cannot hold the
      // printer (§37 P1). A cancel was logged when it was asked for.
      if (job.failedPhase === "upload" || job.failedPhase === "verifying") {
        const event = job.outcome === "unknown" ? "upload-unconfirmed" : job.outcome === "sent" ? "file-uploaded" : job.cancelled ? null : "upload-failed";
        if (event) {
          try {
            auditLog.log({ category: "job", event, ...actor, printerId: p.id, printerName: p.name,
              detail: { file: name, ...(job.errorCode ? { code: job.errorCode } : {}), ...(job.errorReason ? { reason: job.errorReason } : {}), ...(job.cancelled ? { cancelled: true } : {}) } });
          } catch (auditError) { console.log(`[print] ${p.name}: could not record the upload's outcome: ${auditError.message}`); }
        }
      }
    }
  })();
}));

// Cancels an upload until the printer has answered for it (§37 P1).
// While bytes are going out the transfer is cut: the printer is left with a
// broken upload, not a complete-looking file. After the last byte nothing is
// cut (the printer may have the whole file): the cancel stops everything that
// would follow — mapping, the print start, a queue item's start — at once, and
// the upload still waits for the printer's answer, which is what is reported.
// Once the printer has answered, the connector has disarmed job.cancelUpload,
// so a cancel can never land between the answer and the print starting.
app.post("/api/print-cancel", requireRegular, (req, res) => {
  const job = JOBS.get(req.body && req.body.job);
  if (!job || !job.printerId) return res.status(404).json({ error: "No such upload" });
  const p = PRINTERS.find(x => x.id === job.printerId);
  if (!p || !printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  if (!job.cancelUpload) {
    return res.status(409).json({ error: job.done ? "This upload has already finished."
      : job.cancelRequested ? "Already cancelled; waiting for the printer to say whether it received the file."
      : "The printer already has the file; the upload can't be cancelled now." });
  }
  const whileConfirming = !!job.confirmingSince;
  // A queue dispatch names who cancelled in the item's attention message.
  job.cancelledBy = actorFromReq(req).userLabel;
  job.cancelUpload();
  try { auditLog.log({ category: "job", event: "upload-cancelled", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { file: job.file, ...(whileConfirming ? { whileConfirming: true } : {}) } }); }
  catch (e) { console.log(`[print] ${p.name}: could not record the cancel: ${e.message}`); }
  res.json({ ok: true, ...(whileConfirming ? { whileConfirming: true } : {}) });
});

// Poll a print job's progress. A finished job is kept, result and all, for
// JOB_MAX_AGE after it finished (sweepFinishedJobs), however often it is read:
// a tab that lost its connection, or a second tab, still gets the real result
// (§37 P1). A job this server does not know is not evidence of anything about
// the printer: the answer says so, and when this server started.
app.get("/api/print-status", requireAuth, (req, res) => {
  const job = JOBS.get(req.query.job);
  if (!job) return res.status(404).json({ error: "No such job", code: "job_unknown", serverStartedAt: SERVER_STARTED_AT });
  // "confirming": every byte is out and the printer has not answered yet.
  const confirming = !job.done && job.phase === "upload" && !!job.confirmingSince;
  const out = { phase: confirming ? "confirming" : job.phase, sent: job.sent, total: job.total, done: job.done, error: job.error, result: job.result, 
    cancellable: !!job.cancelUpload, cancelled: !!job.cancelled,
    errorCode: job.errorCode || null, failedPhase: job.failedPhase || null,
    outcome: job.outcome || null, startCancelled: !!job.cancelRequested && !!job.confirmingSince,
    confirmingMs: job.confirmingSince ? Date.now() - job.confirmingSince : null,
    errorReason: job.errorReason || null, errorSeconds: job.errorSeconds || null, printerPrompt: !!job.printerPrompt };
  res.json(out);
});

// A printer whose CONTROLS are switched off at the machine (a Bambu Lab
// printer without Developer Mode) reports that to SnapCon, and SnapCon
// remembers it so the buttons are disabled with a reason instead of failing on
// every press. That memory has to be droppable, or an operator who fixes it on
// the printer stays locked out until SnapCon restarts. This is the card's
// "Check again": it asks the connector to forget what it learned, nothing more.
app.post("/api/printer-control-recheck", requireRegular, async (req, res) => {
  const p = PRINTERS[req.body && req.body.printer];
  if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
  const c = getConnector(p.connector);
  if (!c.recheckControl) return res.json({ ok: true, unsupported: true });
  try {
    res.json({ ok: true, ...(await c.recheckControl(p)) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Files stored on a printer + start one directly ----
app.get("/api/printer-files", requireAuth, async (req, res) => {
  const p = PRINTERS[req.query.printer];
  if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
  // Optional, like every other connector extra: a connector that cannot browse
  // the printer's own storage says so, rather than the route calling a method
  // that isn't there and reporting a TypeError as if the printer were
  // unreachable.
  const c = getConnector(p.connector);
  if (!c.listFiles) return res.status(400).json({ error: p.name + " cannot list the files stored on it. Send a file from SnapCon's library instead." });
  try {
    res.json({ files: await c.listFiles(p) });
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
// What a Print of the Loaded file records as sent (M7.1), once the check
// found it present: copyChecked when that rested on the recorded size, not
// the name alone.
const stagedSend = (staged, check) => staged.send ? { ...staged.send, copyChecked: check.basis === "size" } : null;

// ---- Is the Loaded file still the one SnapCon put there? (§37 P5) ----
// One read of the printer, at the exact name every upload uses, held to the
// size recorded when it was staged. The local file is not compared: it may
// have moved or changed since. So the most this says is that the printer has
// a file of that name and size (basis "size"), or of that name (basis
// "name", when no size was recorded or the printer reports none) — never
// that its content was checked.
//   present       still there (at the recorded size, where there is one);
//   missing       the printer answered and it is not there;
//   changed       there under that name at another size;
//   unverifiable  the printer could not be asked (offline, a failed read).
// Nothing is deleted, sent or retried here; only the entry's check changes.
const STAGED_CHECK_STATES = new Set(["present", "missing", "changed", "unverifiable"]);
const STAGED_CHECK_BASES = new Set(["size", "name"]);
const STAGED_CHECK_MAP = { verified: "present", acknowledged: "present", absent: "missing", mismatch: "changed" };
async function checkStagedCopy(p, c, staged) {
  const at = Date.now();   // when it began: a slower, older check never replaces a newer one
  let v;
  if (!c.verifyUpload) v = { result: "unverifiable", evidence: "this printer type cannot list its files" };
  else {
    try { v = await c.verifyUpload(p, staged.name, null, { attempts: 1, localSize: staged.size == null ? null : staged.size }); }
    catch (e) { v = { result: "unverifiable", evidence: e.message }; }
  }
  const state = STAGED_CHECK_MAP[v && v.result] || "unverifiable";
  const basis = state === "present" ? (v.basis === "size" ? "size" : "name") : null;
  return { state, at, basis, evidence: (v && v.evidence) ? String(v.evidence).slice(0, 300) : null };
}
// Records a check on the entry, if it is still the same Loaded file.
function noteStagedCheck(p, staged, check) {
  const cur = queuedFile.get(p.id);
  if (cur !== staged || cur.status !== "ready") return;
  if (cur.check && cur.check.at > check.at) return;
  const changed = !cur.check || cur.check.state !== check.state || cur.check.basis !== check.basis;
  cur.check = check;
  // Written when what it found changes; a renewed "present" is kept in memory.
  if (changed) saveQueuedFiles();
  if (check.state !== "present") console.log(`[staged] ${p.name}: "${staged.name}" ${check.state}${check.evidence ? " — " + check.evidence : ""}`);
}
// What the page sees: gone or changed is not "ready" any more.
const stagedRowStatus = qf => qf.status === "ready" && qf.check && (qf.check.state === "missing" || qf.check.state === "changed") ? qf.check.state : qf.status;
// A Print of the Loaded file goes ahead only on "present" (owner decision,
// 2026-10-28): missing and changed are refused, and so is a printer that
// cannot be asked — the person sees why and can check again.
const STAGED_REFUSAL = {
  missing: (p, n) => `${n} is no longer on ${p.name}. Dismiss it, or send it again.`,
  changed: (p, n) => `The file called ${n} on ${p.name} has changed since SnapCon sent it, so it was not started. Send it again to print it.`,
  unverifiable: (p, n, why) => `SnapCon could not check ${n} on ${p.name}${why ? " (" + why + ")" : ""}, so it was not started. Check the printer, then try again.`,
};

// The scheduled check of every Loaded file: shortly after startup, then every
// 15 minutes. One printer at a time, one read each, and never two sweeps at
// once. A printer that is offline, busy with a send or a start, or checked in
// the last few minutes (a Print just did) is left as it is: offline says
// nothing about the file. A file found missing or changed stays so until
// dismissed or replaced; it is not asked about again.
const STAGED_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const STAGED_CHECK_STARTUP_MS = 60 * 1000;
const STAGED_CHECK_FRESH_MS = 5 * 60 * 1000;
let stagedSweepRunning = false;
async function sweepStagedFiles(now = Date.now()) {
  if (stagedSweepRunning) return { skipped: "running" };
  stagedSweepRunning = true;
  const done = [];
  try {
    for (const p of [...PRINTERS]) {
      const staged = queuedFile.get(p.id);
      if (!staged || staged.status !== "ready") continue;
      if (staged.check && (staged.check.state === "missing" || staged.check.state === "changed")) continue;
      if (staged.check && now - staged.check.at < STAGED_CHECK_FRESH_MS) continue;
      if (otherSendInFlight(p) || queueDispatchJob(p.id) || STARTING.has(p.id)) continue;
      let st;
      try { st = await probeCached(p); } catch { st = null; }
      if (!st || !st.online) continue;
      noteStagedCheck(p, staged, await checkStagedCopy(p, getConnector(p.connector), staged));
      done.push(p.id);
    }
  } finally { stagedSweepRunning = false; }
  return { checked: done };
}

// plate: the plate to start (a Bambu project). send: what SnapCon sent when
// this file is the one it staged on this printer (M7.1) — the Print is then
// recorded as that, not guessed from the file name.
async function runPrintFileJob({ p, c, filename, tools, map, prefs, actor, needsMapping, job, plate = null, send = null }) {
  try {
    await withStartSequence(p, async () => {
      if (needsMapping) {
        job.phase = "mapping";
        console.log(`[printfile] ${p.name}: applyHeadMapping starting (tools=${tools.length}, prefs=${JSON.stringify(prefs)}, printer defaults autoLevel=${!!p.autoLevel} flowCalibrate=${!!p.flowCalibrate} timelapse=${!!p.timelapse})`);
        await c.applyHeadMapping(p, tools, map, prefs, { file: filename, plate });
        console.log(`[printfile] ${p.name}: applyHeadMapping resolved, calling startPrintFile`);
      }
      job.phase = "starting";
      await c.startPrintFile(p, filename, { plate, prefs });
    });
    console.log(`[printfile] ${p.name}: startPrintFile resolved for "${filename}"`);
    // Printing it is what "ready to print" was waiting for -- clear the badge.
    if (queuedFile.get(p.id)?.name === filename) { queuedFile.delete(p.id); saveQueuedFiles(); }
    ROUTE_STARTED_PRINT.add(p.url);
    const lib = send && send.library;
    const auditRef = auditLog.log({ category: "job", event: "print-started", ...actor, printerId: p.id, printerName: p.name,
      detail: { file: filename, ...(lib ? { library: libraryAudit({ ...lib, location: send.location }), staged: true } : {}) } });
    const startedAt = Date.now();
    library.recordPrintStart({ jobKey: "printfile:" + p.id + ":" + startedAt, printerId: p.id, printerName: p.name, remoteName: filename,
      source: lib ? "library" : "printer_storage", via: "print", user: actor, startedAt, auditRef, location: send ? send.location : null,
      library: lib ? { ...lib, plate: plate != null ? plate : lib.plate, staged: true, copyChecked: !!send.copyChecked } : null });
    job.result = { printer: p.name, filename, mapped: tools.length };
    job.phase = "done"; job.done = true;
  } catch (e) {
    console.log(`[printfile] ${p.name}: FAILED at phase "${job.phase}" -- ${e.message}`);
    job.error = e.message; job.done = true; job.phase = "error";
  }
}

app.post("/api/printfile", requireRegular, async (req, res) => {
  // loaded: the card's Print of its Loaded file (§37 P5): checked on the
  // printer before it is accepted, and refused unless still there. A Print
  // picked from the printer's file list is a separate operation: it does not
  // consult the Loaded record at all (no check, no plate, no Library send),
  // even when a file of the same name is Loaded.
  const { printer, filename, map: mapAsked, prefs, loaded } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  // The file SnapCon staged on this printer, when the card is printing it: its
  // plate and what was sent are used, not reconstructed from the name (M7.1).
  const staged = (() => { const q = loaded === true && queuedFile.get(p.id); return q && q.status === "ready" && q.name === filename ? q : null; })();
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  if (p.maintenanceMode) return res.status(409).json({ error: p.name + " is in maintenance mode — take it off maintenance before printing." });
  if (!filename || /["\r\n]/.test(filename)) return res.status(400).json({ error: "Bad filename" });
  const { map, error: mapError } = checkToolMap(mapAsked, p);
  if (mapError) return res.status(400).json({ error: mapError, code: "bad_tool_map" });
  // The map chosen with this Loaded file cannot be read: nothing is started on
  // the printer's own mapping. A map given with this Print replaces it.
  if (staged && staged.mapInvalid && !Object.keys(map).length) {
    return res.status(409).json({ error: `The toolhead mapping saved with ${filename} on ${p.name} could not be read, so it was not printed. Upload the file again to choose its mapping, or eject it.`, code: "staged_bad_map" });
  }
  // The file is already on the printer, but it may still be one this printer
  // cannot start (its storage holds timelapse videos too).
  {
    const why = fileTypeRefusal(getCapabilities(p.connector, p), filename, p.name);
    if (why) return res.status(400).json({ error: why });
  }
  // Nothing is uploaded here, so there is no file to corrupt — but asking a
  // printer to start the job it is already running produces a confusing
  // failure from Klipper, and SnapCon can say what is actually wrong.
  try { await assertNotActiveJobFile(p, filename, "start"); }
  catch (e) { return res.status(e.status || 409).json({ error: e.message }); }

  // Same head-mapping macros as the upload flow (map = { paletteIdx: headIdx }).
  // The Loaded file's own choices (stagedChoices) apply unless this request
  // makes its own: the card's Print sends an empty map and, without the print
  // options dialog, no options. Option by option: this request, then what the
  // Loaded file kept, then the printer's default (in the connector).
  const startMap = Object.keys(map).length ? map : (staged && staged.map) || {};
  const startPrefs = staged && staged.prefs ? { ...staged.prefs, ...prefs } : prefs;
  const tools = Object.keys(startMap).map(Number).sort((a, b) => a - b);
  const c = getConnector(p.connector);
  // Still needed with no mapping chosen (tools=[]) when the printer has its
  // own preferences (auto-level/flow-calibrate/timelapse) to send before
  // print start.
  const needsMapping = !!c.applyHeadMapping && (tools.length > 0 || printerHasAnyDefaultPref(p) || wantsAnyPref(startPrefs));

  // Everything above is cheap and synchronous, so those rejections stay
  // outright HTTP errors. Everything below can block on physical printer work,
  // so it moves onto the same JOBS machinery /api/print already uses: this
  // response now means "start job accepted", NOT "printing" -- clients poll
  // /api/print-status for the outcome.
  // Not while another transfer to this printer runs (the queue, a deferred,
  // CLI or manual send: the one lock, §28, §37 P3); checked right before the
  // job is registered, and the job names the printer so the queue in turn
  // does not claim it while this start runs.
  if (transferBusy(p)) return res.status(409).json({ error: transferBusyRefusal(p), code: "printer_receiving" });
  // The Loaded file is checked on the printer before the start is accepted
  // (§37 P5): one read, at its exact name and recorded size. Anything but
  // present is refused here, with why, and nothing is started or sent.
  let send = null;
  if (staged) {
    const check = await checkStagedCopy(p, c, staged);
    noteStagedCheck(p, staged, check);
    if (check.state !== "present") return res.status(409).json({ error: STAGED_REFUSAL[check.state](p, filename, check.evidence), code: "staged_" + check.state });
    send = stagedSend(staged, check);
    // Checked with an await: another transfer may have taken the printer meanwhile.
    if (transferBusy(p)) return res.status(409).json({ error: transferBusyRefusal(p), code: "printer_receiving" });
  }
  const jobId = newJobId();
  const job = { phase: needsMapping ? "mapping" : "starting", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now(), printerId: p.id };
  JOBS.set(jobId, job);
  res.json({ ok: true, jobId, printer: p.name, filename, mapped: tools.length });
  runPrintFileJob({ p, c, filename, tools, map: startMap, prefs: startPrefs, actor: actorFromReq(req), needsMapping, job,
    plate: staged ? staged.plate : null, send });
});

// ---- Print control: pause / resume / cancel (standard Klipper macros) ----
app.post("/api/printctl", requireRegular, async (req, res) => {
  const { printer, action } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
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
    if (action === "eject" && queuedFile.has(p.id)) { queuedFile.delete(p.id); saveQueuedFiles(); }
    auditLog.log({ category: "job", event: "printctl-" + action, ...actorFromReq(req), printerId: p.id, printerName: p.name });
    res.json({ ok: true, action });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Deletes a G-code file from the printer's own storage (the printer-files
// dialog). Refused while anything in SnapCon still needs that file: see
// printerFileDeleteRefusal(). A staged file that is deleted stops being
// offered as "ready to print".
app.post("/api/printer-file-delete", requireRegular, async (req, res) => {
  const { printer, file } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  if (typeof file !== "string" || !file.trim() || file.length > 500 || /[\r\n\0]/.test(file) || file.startsWith("/") ||
      file.replace(/\\/g, "/").split("/").includes("..")) {
    return res.status(400).json({ error: "Bad file name" });
  }
  const c = getConnector(p.connector);
  if (!c.deleteFile || !(getCapabilities(p.connector, p) || {}).deleteFile) {
    return res.status(400).json({ error: p.name + " can't delete files from its storage through SnapCon." });
  }
  // Fail closed: a delete is permanent, so "couldn't tell what it's doing" refuses.
  let st;
  try { st = await probeCached(p); } catch { st = null; }
  if (!st || !st.online) return res.status(502).json({ error: "Could not reach " + p.name + "." });
  const qs = queueStore.getPrinterState(p.id) || {};
  const refusal = printerFileDeleteRefusal({
    printerName: p.name, file, state: st.state, activeFilename: st.filename,
    starting: STARTING.has(p.id),
    staged: queuedFile.get(p.id) || null,
    queue: [...(qs.queue || []), ...(qs.currentItem ? [qs.currentItem] : [])],
    uploading: [...JOBS.values()].filter(j => !j.done && (j.phase === "upload" || j.phase === "verifying") && j.printerId === p.id).map(j => j.file),
  });
  if (refusal) return res.status(409).json({ error: refusal });
  try {
    await c.deleteFile(p, file);
  } catch (e) {
    return res.status(502).json({ error: "Could not delete \"" + file + "\" from " + p.name + ": " + e.message });
  }
  const staged = queuedFile.get(p.id);
  if (staged && path.basename(String(staged.name)) === path.basename(file)) { queuedFile.delete(p.id); saveQueuedFiles(); }
  auditLog.log({ category: "job", event: "printer-file-deleted", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { file } });
  res.json({ ok: true });
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
// The offline cache, stable printer identity and the fleet's non-blocking
// display path live in fleetProbe.js (docs/TODO.md §43, §48): results are
// kept per printer id, never per URL, so printers without a URL no longer
// share one entry. FLEET_PROBE is created below, after LAST_SEEN.
// When each printer last answered a probe: printer id -> ms. Set by
// fleetProbe.js on every real, current, online result — probeCached() and the
// fleet's display path alike, so it advances with no browser open (notifyTick)
// — and never by a failed, served-from-memory, timed-out or obsolete one. In memory only: after a restart a printer has
// no time until it is reached once, and the card says so.
const LAST_SEEN = new Map();
const lastSeenIso = p => (LAST_SEEN.has(p.id) ? new Date(LAST_SEEN.get(p.id)).toISOString() : null);

// probeCached() (decisions and actions) uses FLEET_PROBE.fresh(); only the
// fleet route (what the cards show) uses FLEET_PROBE.display() through
// probeForDisplay(). Switch: config.json "fleetFastOffline" — absent or true
// = on (the default); false = the fleet route behaves exactly as fresh()
// (the pre-§48 behaviour). Changed live by POST /api/fleet-fast-offline.
const FLEET_PROBE = createFleetProbe({
  probe: p => getConnector(p.connector).probe(p),
  currentPrinter: key => PRINTERS.find(x => fleetProbeKeyOf(x) === key) || null,
  onOnline: (p, at) => LAST_SEEN.set(p.id, at),
  enabled: () => CFG.fleetFastOffline !== false,
  retryMs: OFFLINE_RETRY_MS,
});

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
const tempStableCache = new Map(); // "<printer key>:bed"|"<printer key>:hotend" -> { shown, pendingVal, pendingCount } (key: fleetProbeKeyOf, §43)
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
const completedAtCache = new Map(); // printer key (fleetProbeKeyOf, §43) -> timestamp
function stampCompletedAt(p, result) {
  const key = fleetProbeKeyOf(p);
  if (result.state === "complete") {
    if (!completedAtCache.has(key)) completedAtCache.set(key, Date.now());
    return { ...result, completedAt: completedAtCache.get(key) };
  }
  completedAtCache.delete(key);
  return result;
}

// Which machine a fleet row is: from the connector when it only drives one
// model, else a model the connector detected (Creality) or the printer reports
// (Bambu). null when none of those is known — the Send dialog then compares
// brands only, as it always did.
function printerFamilyFields(p, conn, caps) {
  const idn = PrinterIdentity.identifyPrinter({
    connectorFamily: conn.printerFamily, model: p.model,
    capabilitiesModel: caps && caps.model, brand: p.brand,
  });
  return { printerFamily: idn.key, printerFamilyLabel: idn.label };
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
// The authoritative status, for every decision and action: an offline result
// is reused for OFFLINE_RETRY_MS, anything else is a new probe of its own.
async function probeCached(p) {
  return finishProbe(p, await FLEET_PROBE.fresh(p));
}
// What the fleet cards show (GET /api/fleet only). A printer last seen offline
// is answered from that result at once and re-checked in the background; it
// then carries statusCheckedAt (when that offline result was observed). Online
// and printing states are always a live probe. Never use this for a decision.
async function probeForDisplay(p) {
  const d = await FLEET_PROBE.display(p);
  const r = finishProbe(p, d.result);
  return d.cached ? { ...r, statusCheckedAt: new Date(d.checkedAt).toISOString() } : r;
}
function finishProbe(p, result) {
  if (result.online) {
    const key = fleetProbeKeyOf(p);
    result = { ...result, bed: stabilizeTemp(key + ":bed", result.bed), hotend: stabilizeTemp(key + ":hotend", result.hotend) };
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
// No interactive hand-off, ever — a notify always just uploads. It is kept as
// a deferred send (deferredStore, §37 P3) and sent as soon as the printer is
// free, with no browser tab needed for that to happen.
// queuedFile: printer id -> { name, status, ts, error?, check? } — the file
// waiting on the printer ("Loaded"); visible to ANY tab. Keyed by the
// printer's stable id (§37 P5), like the deferred sends.
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
// fact lives. Persisted by printer id so a SnapCon restart doesn't forget it
// and silently strand a file the user can no longer see is there. "queued"/"uploading"/"error" are
// mid-flight snapshots of an operation that's simply dead the moment the
// process restarts — nothing to resume, so only "ready" is written.
function saveQueuedFiles() {
  const out = {};
  for (const [id, qf] of queuedFile) {
    if (qf.status !== "ready") continue;
    // A printer removed from Settings: not written, so its entry does not
    // outlive the next restart.
    if (!PRINTERS.some(p => p.id === id)) continue;
    out[id] = { name: qf.name, ts: qf.ts, plate: qf.plate == null ? null : qf.plate, send: qf.send || null, ...(qf.map ? { map: qf.map } : {}), ...(qf.mapInvalid ? { mapInvalid: true } : {}), ...(qf.prefs ? { prefs: qf.prefs } : {}), size: qf.size == null ? null : qf.size, ...(qf.sizeOf ? { sizeOf: qf.sizeOf } : {}), ...(qf.verification ? { verification: qf.verification, verifiedAt: qf.verifiedAt || null } : {}), ...(qf.check ? { check: qf.check } : {}) };
  }
  try { fs.writeFileSync(QUEUED_FILE_PATH, JSON.stringify(out, null, 2)); }
  catch (e) { console.error("[queued-files] save failed:", e.message); }
}
function loadQueuedFiles() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(QUEUED_FILE_PATH, "utf8")); } catch { return; }
  if (!saved || typeof saved !== "object") return;
  PRINTERS.forEach(p => {
    const entry = p.id && saved[p.id];
    // An entry written before sizes were recorded as the file's own (sizeOf
    // "file") may hold the whole upload body's size, framing included: its
    // size is unknown, so its copy on the printer is not checked against it
    // and its Library link stays (checkStagedCopy by name, copyChecked false).
    const fileSize = entry && entry.sizeOf === "file" && entry.size != null ? entry.size : null;
    // An entry written before the read-back (§37 P2) has no check recorded:
    // it stays unchecked, never assumed verified.
    const checked = entry && START_OK_VERIFICATIONS.has(entry.verification) && Number.isFinite(entry.verifiedAt)
      ? { verification: entry.verification, verifiedAt: entry.verifiedAt } : {};
    // What the last freshness check found (§37 P5); anything else is unchecked.
    const check = entry && entry.check && STAGED_CHECK_STATES.has(entry.check.state) && Number.isFinite(entry.check.at)
      ? { state: entry.check.state, at: entry.check.at, basis: STAGED_CHECK_BASES.has(entry.check.basis) ? entry.check.basis : null, evidence: typeof entry.check.evidence === "string" ? entry.check.evidence.slice(0, 300) : null } : null;
    if (entry && entry.name) queuedFile.set(p.id, { name: entry.name, status: "ready", ts: entry.ts || Date.now(), plate: entry.plate == null ? null : entry.plate, send: entry.send || null, ...stagedChoices(entry.map, entry.prefs, p), ...(entry.mapInvalid === true ? { mapInvalid: true } : {}), size: fileSize, ...(fileSize != null ? { sizeOf: "file" } : {}), ...checked, ...(check ? { check } : {}) });
  });
}
loadQueuedFiles();
deferredStore.load();
transferResults.setLimits(transferResultLimitsFromConfig(CFG));
transferResults.load();
deferredStartup();
// The scheduled freshness check of Loaded files (§37 P5; sweepStagedFiles).
setTimeout(() => { sweepStagedFiles().catch(e => console.log("[staged] check failed:", e.message)); }, STAGED_CHECK_STARTUP_MS).unref();
setInterval(() => { sweepStagedFiles().catch(e => console.log("[staged] check failed:", e.message)); }, STAGED_CHECK_INTERVAL_MS).unref();

// The card's Dismiss and Check again for a Loaded file found missing or
// changed, or that could not be checked, and Dismiss for a deferred send's
// error (§37 P5). Dismiss forgets SnapCon's record only: the printer's file is
// never touched. Check again is one read, at most once a minute per printer.
const STAGED_MANUAL_MIN_MS = 60 * 1000;
const stagedManualAt = new Map();
app.post("/api/staged-file/dismiss", requireRegular, (req, res) => {
  const p = PRINTERS[req.body && req.body.printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  const qf = queuedFile.get(p.id);
  if (!qf || (req.body.name && qf.name !== req.body.name)) return res.status(404).json({ error: "Nothing to dismiss" });
  const dismissable = qf.status === "error" || (qf.status === "ready" && qf.check && qf.check.state !== "present");
  if (!dismissable) return res.status(409).json({ error: `${qf.name} is ready to print on ${p.name}; eject it instead.` });
  queuedFile.delete(p.id);
  saveQueuedFiles();
  try { auditLog.log({ category: "job", event: "staged-file-dismissed", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { file: qf.name, ...(qf.check ? { check: qf.check.state } : {}) } }); }
  catch (e) { console.log(`[staged] ${p.name}: could not record the dismiss: ${e.message}`); }
  res.json({ ok: true });
});
app.post("/api/staged-file/check", requireRegular, async (req, res) => {
  const p = PRINTERS[req.body && req.body.printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  const staged = queuedFile.get(p.id);
  if (!staged || staged.status !== "ready") return res.status(404).json({ error: "No Loaded file to check" });
  const last = stagedManualAt.get(p.id) || 0;
  if (Date.now() - last < STAGED_MANUAL_MIN_MS) return res.status(429).json({ error: "Checked a moment ago. Try again in a minute." });
  stagedManualAt.set(p.id, Date.now());
  const check = await checkStagedCopy(p, getConnector(p.connector), staged);
  noteStagedCheck(p, staged, check);
  res.json({ ok: true, check: { state: check.state, at: check.at, basis: check.basis } });
});

// A deferred send as the page sees it: never its source path or bytes.
const deferredRow = r => ({ id: r.id, transferId: tidOf(r), name: r.name, state: r.state, ...((f => f ? { finished: f.state, ...(f.later ? { finishedLater: true } : {}) } : {})(deferredFinished(r))), createdAt: r.createdAt, seq: r.seq, ...(r.waitingFor ? { waitingFor: r.waitingFor } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.error ? { error: r.error } : {}), ...(r.code ? { code: r.code } : {}), ...(r.outcome ? { outcome: r.outcome } : {}), ...(r.errorReason ? { errorReason: r.errorReason } : {}), printerName: r.printerName || null });

// ---- A person's actions on a deferred send (§37 P3) ----
// Each acts only from the states it names, so a repeated click, a second tab
// or a restart in between changes nothing twice. A send whose printer was
// removed is an admin's to act on (there is no printer to check access to).
function deferredForRequest(req, res) {
  const rec = deferredStore.get(req.params.id);
  if (!rec) { res.status(404).json({ error: "No such send" }); return null; }
  const p = printerById(rec.printerId);
  if (p ? !printerVisibleTo(req.user, p) : !(req.user && req.user.role === "admin")) { res.status(403).json({ error: "You don't have access to this printer" }); return null; }
  return { rec, p };
}
function deferredAudit(req, event, rec, extra = {}) {
  try { auditLog.log({ category: "job", event, ...actorFromReq(req), printerId: rec.printerId, printerName: rec.printerName || null, detail: { file: rec.name, transferId: tidOf(rec), ...extra } }); } catch {}
}
// Cancel: a queued, interrupted or attention send is cancelled (its stored
// bytes go only once that is saved); one uploading is cut as any upload is
// (P1: after the last byte only what follows is called off).
app.post("/api/deferred/:id/cancel", requireRegular, (req, res) => {
  const it = deferredForRequest(req, res); if (!it) return;
  const { rec } = it;
  if (rec.state === "uploading") {
    const job = [...JOBS.values()].find(j => j.deferredId === rec.id && !j.done);
    if (!job || !job.cancelUpload) return res.status(409).json({ error: "The printer has already answered for this file; it can't be cancelled now." });
    job.cancelledBy = actorFromReq(req).userLabel;
    job.cancelUpload();
    deferredAudit(req, "deferred-send-cancel-requested", rec);
    return res.json({ ok: true, state: "uploading" });
  }
  const t = deferredStore.transition(rec.id, ["queued", "interrupted", "attention"], { state: "cancelled", outcome: rec.state === "queued" ? "not-sent" : "unknown" });
  if (!t.ok) return res.status(t.reason === "persist" ? 503 : 409).json({ error: t.reason === "persist" ? "The cancel could not be saved; nothing changed." : `This send is ${t.state || "gone"}; nothing to cancel.` });
  noteDeferredResult(t.record);
  if (rec.bytes) deferredStore.deleteBytes(rec.id);
  deferredAudit(req, "deferred-send-cancelled", rec, { from: rec.state });
  res.json({ ok: true, state: "cancelled" });
});
// Dismiss: forgets a failed or cancelled send (and any bytes kept for it), or
// one restored from a backup that had already finished. Its result is saved
// first (§37 P4): the record is never the last trace of an outcome to go.
app.post("/api/deferred/:id/dismiss", requireRegular, (req, res) => {
  const it = deferredForRequest(req, res); if (!it) return;
  const from = deferredFinished(it.rec) ? ["attention", "failed", "cancelled"] : ["failed", "cancelled"];
  if (!from.includes(it.rec.state)) return res.status(409).json({ error: "Only a failed or cancelled send can be dismissed." });
  if (!deferredResultSettled(it.rec) && !noteDeferredResult(it.rec).ok) return res.status(503).json({ error: "Its result could not be saved; nothing changed." });
  const r = deferredStore.remove(it.rec.id, from);
  if (!r.ok) return res.status(r.reason === "persist" ? 503 : 409).json({ error: r.reason === "persist" ? "Could not be saved; nothing changed." : "Only a failed or cancelled send can be dismissed." });
  if (it.rec.bytes) deferredStore.deleteBytes(it.rec.id);
  deferredAudit(req, "deferred-send-dismissed", it.rec, { from: it.rec.state });
  res.json({ ok: true });
});
// Send again: the person authorises another transfer of a send that needs
// attention or failed. Back in line where it was; it replaces the printer's
// file of that name when it goes (the page says so before asking).
app.post("/api/deferred/:id/send-again", requireRegular, (req, res) => {
  const it = deferredForRequest(req, res); if (!it) return;
  const { rec, p } = it;
  if (!p) return res.status(409).json({ error: "Its printer is not configured any more; it cannot be sent." });
  if (rec.bytes && !fs.existsSync(deferredStore.bytesPath(rec.id))) return res.status(409).json({ error: "The file kept for this send is gone; send it again from the slicer." });
  // Its content is fixed by hash: a changed source fails again every time.
  // A new version is a new send (P3 frontend review).
  const finished = deferredFinished(rec);
  if (finished) return res.status(409).json({ error: finished.later ? `A later attempt already delivered ${rec.name}; this send, restored from a backup, is out of date and is not sent again. Dismiss it.` : `${rec.name} already finished (${finished.state}) before SnapCon restored this send from its backup; it is not sent again. Dismiss it.` });
  if (rec.state === "failed" && rec.code === "DEFERRED_SOURCE_CHANGED") return res.status(409).json({ error: `${rec.name} changed since this send was asked for. Send the file again from SnapCon to send the new version.` });
  const other = deferredStore.list({ printerId: p.id }).find(r => r.id !== rec.id && r.name === rec.name && ["queued", "uploading", "interrupted", "attention", "completed"].includes(r.state) && !(r.state === "completed" && r.loadedApplied));
  if (other) return res.status(409).json({ error: `${rec.name} is already waiting to be sent to ${p.name} in another send.` });
  // Another attempt is another transfer (§37 P4): the attempt that ended
  // keeps its result under its own id, saved before the send moves on.
  if (!deferredResultSettled(rec) && !noteDeferredResult(rec).ok) return res.status(503).json({ error: "The result of the last attempt could not be saved; nothing changed." });
  const transferId = deferredStore.newId();
  const t = deferredStore.transition(rec.id, ["attention", "failed"], { state: "queued", transferId, parentTransferId: tidOf(rec), reason: null, error: null, code: null, errorReason: null, outcome: null, evidence: null, waitingFor: null, notBefore: null });
  if (!t.ok) return res.status(t.reason === "persist" ? 503 : 409).json({ error: t.reason === "persist" ? "Could not be saved; nothing changed." : `This send is ${t.state || "gone"}.` });
  deferredAudit(req, "deferred-send-again", t.record, { from: rec.state, parentTransferId: tidOf(rec) });
  setImmediate(() => { pumpDeferred().catch(() => {}); });
  res.json({ ok: true, state: "queued", transferId });
});
// Check again: reads the printer back once (at most once a minute per send).
app.post("/api/deferred/:id/check", requireRegular, async (req, res) => {
  const it = deferredForRequest(req, res); if (!it) return;
  const { rec, p } = it;
  if (!p) return res.status(409).json({ error: "Its printer is not configured any more." });
  if (!["interrupted", "attention"].includes(rec.state)) return res.status(409).json({ error: `This send is ${rec.state}; there is nothing to check.` });
  if (transferBusy(p)) return res.status(409).json({ error: transferBusyRefusal(p) });
  if (Date.now() - (deferredCheckedAt.get(rec.id) || 0) < 60 * 1000) return res.status(429).json({ error: "Checked a moment ago. Try again in a minute." });
  deferredCheckedAt.set(rec.id, Date.now());
  const out = await reconcileDeferredOne(p, rec, ["interrupted", "attention"]);
  deferredAudit(req, "deferred-send-checked", rec, { state: out.state });
  res.json({ ok: true, state: out.state, evidence: out.evidence });
});
// Sends whose printer was removed, for the fleet's attention list (admins).
app.get("/api/deferred/orphans", requireAdmin, (req, res) => {
  const st = deferredStore.status();
  const orphaned = deferredStore.listOrphaned();
  res.json({ status: { loadStatus: st.loadStatus, recoveryRequired: st.recoveryRequired, degraded: st.degraded, readOnly: st.readOnly, hold: st.hold ? { reason: st.hold.reason, since: st.hold.since } : null, dropped: st.dropped },
    orphanedFiles: { count: orphaned.length, bytes: orphaned.reduce((n, f) => n + f.size, 0) },
    results: (({ loadStatus, readOnly, degraded }) => ({ loadStatus, readOnly, degraded }))(transferResults.status()),
    sends: deferredStore.list().filter(r => !printerById(r.printerId)).map(r => ({ ...deferredRow(r), printerId: r.printerId })) });
});
// The only way set-aside files are deleted: an admin's explicit action, audited
// with each file.
app.post("/api/deferred/orphaned-files/delete", requireAdmin, (req, res) => {
  const gone = deferredStore.deleteOrphaned();
  try { auditLog.log({ category: "system", event: "deferred-files-deleted", ...actorFromReq(req), detail: { files: gone.map(f => f.name), bytes: gone.reduce((n, f) => n + f.size, 0) } }); } catch {}
  res.json({ ok: true, deleted: gone.length });
});
// Clears the hold only: no send changes state, and no file is deleted.
app.post("/api/deferred/acknowledge-recovery", requireAdmin, (req, res) => {
  const r = deferredStore.acknowledgeRecovery();
  if (!r.ok) return res.status(503).json({ error: r.error ? r.error.message : "Could not be saved." });
  try { auditLog.log({ category: "system", event: "deferred-sends-recovery-acknowledged", ...actorFromReq(req) }); } catch {}
  res.json({ ok: true });
});

// ---- A transfer's status (§37 P4) ----
// Read-only. What a transfer id's attempt is doing, or how it ended: a send
// still under way from deferredStore (with its job's progress), else its
// saved result, else (a result not yet saved) the outcome its send records.
// Asked by a signed-in user who can see its printer (a removed printer's:
// admins), or by the same-machine command line with its local token. Anyone
// else gets exactly the answer an unknown id gets, so an id reveals nothing.
const TRANSFER_UNDER_WAY = new Set(["queued", "uploading", "interrupted"]);
function transferReadAllowed(req, printerId) {
  if (NOTIFY_TOKEN && isLoopback(req) && req.headers["x-snapcon-local-token"] && timingSafeTokenEqual(req.headers["x-snapcon-local-token"], NOTIFY_TOKEN)) return true;
  if (!req.user) return false;
  const p = printerById(printerId);
  return p ? printerVisibleTo(req.user, p) : req.user.role === "admin";
}
function transferStatus(id, rec, result) {
  const p = printerById(rec ? rec.printerId : result.printerId);
  const out = { transferId: id, printer: p ? p.name : (rec && rec.printerName) || null };
  if (rec && TRANSFER_UNDER_WAY.has(rec.state)) {
    Object.assign(out, { state: rec.state, final: false }, rec.parentTransferId ? { parentTransferId: rec.parentTransferId } : {});
    if (rec.state === "queued" && rec.waitingFor) out.waitingFor = rec.waitingFor;
    if (rec.state === "uploading") {
      const job = [...JOBS.values()].find(j => j.deferredId === rec.id && !j.done);
      const ph = job && job.phase;
      out.phase = ph === "upload" ? (job.total > 0 && job.sent >= job.total ? "confirming" : "sending") : ph === "verifying" ? "verifying" : ph === "mapping" ? "finishing" : "preparing";
      if (job && job.total > 0) { out.sent = job.sent || 0; out.total = job.total; }
    }
    return out;
  }
  // An outcome its send records but the results do not hold yet (a save
  // that failed, or a completion settling an "unknown") is the newer one.
  const pending = rec && !deferredResultSettled(rec) ? resultEntryFor(rec) : null;
  const e = pending || result;
  if (!e) return Object.assign(out, { state: "unknown", final: true, reason: (rec && rec.reason) || "restored-from-backup" });
  Object.assign(out, { state: e.state, final: true, at: e.at });
  for (const k of ["basis", "code", "reason", "outcome", "message", "reconciledFrom"]) if (e[k] != null) out[k] = e[k];
  if (e.parentId) out.parentTransferId = e.parentId;
  if (pending) out.unsaved = true;
  return out;
}
app.get("/api/transfers/:id", (req, res) => {
  const id = String(req.params.id || "");
  const unknown = () => res.status(404).json({ error: "SnapCon does not know this transfer (it may have expired).", code: "transfer_unknown", serverStartedAt: SERVER_STARTED_AT });
  if (!ID_SHAPE.test(id)) return unknown();
  const rec = deferredStore.byTransfer(id);
  const result = transferResults.get(id);
  // Its current attempt's own record wins only while it is under way.
  const printerId = rec ? rec.printerId : result ? result.printerId : null;
  if (!printerId || !transferReadAllowed(req, printerId)) return unknown();
  res.json(transferStatus(id, rec, result));
});

const normPrinterName = s => String(s || "").replace(/_/g, " ").trim().toLowerCase();
function findPrinterIndex(name) {
  const norm = normPrinterName(name);
  if (!norm) return -1;
  return PRINTERS.findIndex(p => normPrinterName(p.name) === norm);
}

// The states in which SnapCon may START work on a printer -- queue dispatch,
// the deferred sends, and both /api/notify-load arms all gate on this.
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
  // A queue dispatch is decided after the probe, not before: callers act on
  // "idle" without waiting again, and the queue may claim the printer while
  // the probe is out (§28).
  let st;
  try { st = await probeCached(p); } catch { return false; }
  return !!(st && st.online) && DISPATCH_IDLE_STATES.has(st.state) && !queueDispatchJob(p.id);
}
// ---- Sends waiting for a busy printer (§37 P3) ----
// A file SnapCon was asked to upload while the printer was busy (the Upload
// button with uploads-while-printing off, the slicer/CLI hook) is kept in
// deferredStore — on disk, in order per printer id — and sent once the printer
// is free. Rules (owner, 2026-10-28):
//   - acknowledged only once its record (and any pushed bytes) is saved;
//   - first in, first out per printer; a second open send of the same name to
//     the same printer is refused, never replacing the first;
//   - the source must still be exactly what was asked for (sha256), or it fails;
//   - sent through the per-printer lock as a real job (progress, Cancel, the
//     strip), read back as every upload is (P2), and only ever uploaded: no
//     path here starts a print;
//   - an attempt interrupted by a restart is reconciled by reading the printer
//     back, never resent, overwritten, deleted or started by itself; anything
//     not proven complete waits for a person (Send again, Check again, Cancel);
//   - a removed printer's sends are kept, shown as needing attention, and go
//     on only if a printer with that id comes back.
const DEFERRED_PUMP_MS = 5000;
const DEFERRED_RECONCILE_MS = 60 * 1000;
// A source folder that did not answer: asked again after this, not every pass.
const DEFERRED_SOURCE_RETRY_MS = 60 * 1000;
// A queued send that can go now: not waiting out a source retry, and its file
// (unless pushed bytes, kept here) not on a share known to be down. One that
// cannot does not hold up the next send to that printer, nor its queue
// (owner, 2026-10-28) — it goes when it can, its content checked first.
const deferredEligible = (r, now = Date.now()) => r.state === "queued" && !(r.notBefore > now) && (!!r.bytes || netfs.availability(r.source.path).status === "online");
const sourcePathOf = rec => rec.bytes ? deferredStore.bytesPath(rec.id) : rec.source.path;
// The transfer id of a send's current attempt (§37 P4): the send's own id at
// first; Send again gives it a new one, linked by parentTransferId, so an
// earlier attempt's result never turns into a later one's. A restart's
// reconciliation keeps the attempt's id.
const tidOf = r => r.transferId || r.id;
// The file's hash, with its identity (netfs.identity) taken before and after
// hashing: if they differ the file was being written while it was read, and
// the hash describes no one version of it (§37 A4). `id` is the identity the
// upload's later re-check compares against.
async function sourceIdentity(file) {
  const before = await netfs.identity(file);
  const h = await queueStore.computeFileHash(file, { force: true });
  const after = await netfs.identity(file);
  if (!sameSource(before, after) || h.sizeBytes !== before.size) throw Object.assign(new Error("it changed while SnapCon was reading it"), { code: "SOURCE_CHANGED_WHILE_READ" });
  return { size: h.sizeBytes, sha256: h.sha256, mtimeMs: before.mtimeMs, id: before };
}
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });
const deferredDuplicate = (p, name) => httpError(409, `${name} is already waiting to be sent to ${p.name}. Cancel that send first to replace it.`, "deferred_duplicate");

// Accepts a send for later: duplicate check, the source's identity (or the
// pushed bytes, written durably first), then the record — persisted before
// this returns, which is when the caller may answer that it is queued.
async function acceptDeferredSend(p, { name, kind, file = null, buffer = null, tools = [], map = {}, prefs = {}, plate = null, actor, send = null }) {
  if (deferredStore.openDuplicate(p.id, name)) throw deferredDuplicate(p, name);
  const id = deferredStore.newId();
  let source, bytes = null;
  if (buffer) {
    const b = await deferredStore.storeBytes(id, buffer, deferredLimitsFromConfig(CFG));
    bytes = { size: b.size, sha256: b.sha256 };
    source = { kind, size: b.size, sha256: b.sha256 };
  } else {
    let ident;
    try { ident = await sourceIdentity(file); }
    catch (e) { throw httpError(e && e.code === "NAS_UNREACHABLE" ? 503 : 404, `${name} could not be read: ${e.message}`, "deferred_source_unreadable"); }
    if (send && send.library && send.library.sha256 && ident.sha256 !== send.library.sha256) throw httpError(409, `${name} changed since it was chosen in the Library; it was not queued. Send it again from the model page.`, "deferred_source_changed");
    source = { kind, path: file, size: ident.size, sha256: ident.sha256, mtimeMs: ident.mtimeMs };
  }
  // Checked again: the hash or the write took time.
  if (deferredStore.openDuplicate(p.id, name)) { if (bytes) deferredStore.deleteBytes(id); throw deferredDuplicate(p, name); }
  // Nothing is awaited from here to the add: a delete of the file that has
  // begun is seen here, and one that begins later sees this send.
  if (file && gcodeFileBeingDeleted(file)) throw httpError(409, BEING_DELETED(name), "file_being_deleted");
  let rec;
  try { rec = deferredStore.add({ id, transferId: id, printerId: p.id, printerName: p.name, name, source, ...(bytes ? { bytes } : {}), tools, map, prefs, plate, actor: actor || null, send }); }
  catch (e) { if (bytes) deferredStore.deleteBytes(id); throw e; }
  try { auditLog.log({ category: "job", event: "deferred-send-accepted", ...(actor || { userId: null, userLabel: null }), printerId: p.id, printerName: p.name, detail: { file: name, transferId: tidOf(rec), source: kind } }); } catch {}
  setImmediate(() => { pumpDeferred().catch(e => console.log("[deferred] send failed to start:", e.message)); });
  return rec;
}

// A send to a printer that has queued ones waiting goes after them: the queue
// does not claim it meanwhile (C4). Sends needing attention do not hold it up.
const deferredWaiting = printerId => deferredStore.list({ printerId, states: ["queued"] }).some(r => deferredEligible(r));

// Starts the first queued send of each free printer. One pass at a time; the
// claim (record → uploading, saved, and the job registered) happens with
// nothing awaited after the last check.
let deferredPumping = false;
async function pumpDeferred() {
  if (deferredPumping) return;
  deferredPumping = true;
  try {
    // A store that could not save stops new sends until it can again: a
    // restart must never find a state it does not know.
    if (deferredStore.status().degraded && !deferredStore.retrySave().ok) return;
    retryUnsavedDeferred();
    transferResults.setLimits(transferResultLimitsFromConfig(CFG));
    syncDeferredResults();
    // Per printer, the oldest send that can go now (deferredEligible).
    const first = new Map();
    for (const r of deferredStore.list({ states: ["queued"] })) if (!first.has(r.printerId) && deferredEligible(r)) first.set(r.printerId, r);
    for (const [printerId, rec] of first) {
      const p = printerById(printerId);
      if (!p) continue;                                   // removed: kept, needs attention
      if (transferBusy(p)) continue;
      if (!(await isPrinterIdle(p))) continue;
      const head = deferredStore.list({ printerId, states: ["queued"] }).find(r => deferredEligible(r));
      if (!head || head.id !== rec.id || transferBusy(p)) continue;
      const t = deferredStore.transition(rec.id, ["queued"], { state: "uploading", attempt: { id: "att_" + Date.now().toString(36), startedAt: Date.now() } });
      if (!t.ok) continue;
      const job = { phase: "verify", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now(), printerId: p.id, file: rec.name, deferredId: rec.id, timeouts: uploadTimeoutsFromConfig(CFG), startsPrint: false };
      JOBS.set(newJobId(), job);
      try { auditLog.log({ category: "job", event: "deferred-send-started", printerId: p.id, printerName: p.name, detail: { file: rec.name, transferId: tidOf(rec) } }); } catch {}
      runDeferredSend(p, t.record, job).catch(e => console.log(`[deferred] ${p.name}: ${e.message}`));
    }
  } finally { deferredPumping = false; }
}

// ---- Transfer results (§37 P4) ----
// A send's final state, once saved in deferredStore, is written to
// transferResults — the outcome --wait and GET /api/transfers/:id answer
// with, kept after the send itself is gone. Written only from that saved
// state, never from a file name. Order on completion (owner, P4 item 2):
// completed saved → result saved → Loaded entry → the record removed. The
// record is the only durable completion until its result is saved, so it is
// never removed before; a result that could not be saved is written again on
// the next pass (syncDeferredResults), and at startup — never another upload.
function resultEntryFor(r) {
  const base = { id: tidOf(r), parentId: r.parentTransferId || null, printerId: r.printerId, at: r.updatedAt || Date.now() };
  if (r.state === "completed") {
    const c = r.completion || {};
    // A basis a connector may report beyond these is left out, never fatal (R1).
    return START_OK_VERIFICATIONS.has(c.verification) ? { ...base, state: c.verification, basis: ["content", "size", "name"].includes(c.basis) ? c.basis : null, at: c.at || base.at } : null;
  }
  if (r.state === "failed") return { ...base, state: "failed", code: r.code || null, message: r.error || null };
  if (r.state === "cancelled") return { ...base, state: "cancelled", outcome: r.outcome || null, message: r.error || null };
  // A send brought back from a backup is not an outcome: nothing is written
  // for it (backup recovery never makes a result).
  if (r.state === "attention" && r.reason !== "restored-from-backup") return { ...base, state: "unknown", reason: r.reason || null, code: r.code || null, message: r.error || null };
  return null;
}
// Its result is saved (or it has none to save).
function deferredResultSettled(r) {
  const e = resultEntryFor(r);
  if (!e) return true;
  const cur = transferResults.get(e.id);
  return !!cur && !(r.state === "completed" && cur.state === "unknown");
}
const RESULT_SAVE_WARNED = new Set();
// After a result could not be saved, the pass waits this long before trying
// again: a disk refusing every write (EACCES retried synchronously) must not
// hold the event loop every 5 s (P4 backend review R2).
const RESULTS_RETRY_MS = 60 * 1000;
let RESULTS_RETRY_AT = 0;
// A completion is read-back evidence (P2), so it may settle an "unknown" of
// the same attempt — audited as such.
function noteDeferredResult(r) {
  const e = resultEntryFor(r);
  if (!e) return { ok: true };
  let out;
  try { out = transferResults.record(e, { reconcile: r.state === "completed" }); }
  catch (err) { out = { ok: false, reason: "invalid", error: err }; }
  if (!out.ok) RESULTS_RETRY_AT = Date.now() + RESULTS_RETRY_MS;
  if (!out.ok) {
    if (!RESULT_SAVE_WARNED.has(r.id)) { RESULT_SAVE_WARNED.add(r.id); console.log(`[transfers] the result of "${r.name}" could not be saved (${out.error ? out.error.message : "?"}); its send is kept and it is saved again on the next pass`); }
    return out;
  }
  RESULT_SAVE_WARNED.delete(r.id);
  if (out.reconciled) {
    try { auditLog.log({ category: "job", event: "transfer-result-reconciled", printerId: r.printerId, printerName: r.printerName || null, detail: { file: r.name, transferId: e.id, from: out.from, to: e.state, basis: e.basis } }); } catch {}
  }
  return out;
}
// Each pass and at startup: results not yet saved are saved, and completed
// sends finished (Loaded entry, then the record once its result is saved).
function syncDeferredResults({ force = false } = {}) {
  let writing = force || Date.now() >= RESULTS_RETRY_AT;
  for (const r of deferredStore.list({ states: ["completed", "failed", "cancelled", "attention"] })) {
    try {
      if (writing && !deferredResultSettled(r) && !noteDeferredResult(r).ok) writing = false;   // one failure ends this pass's writes
      if (r.state === "completed") applyDeferredCompleted(r);
    } catch (e) { console.log(`[transfers] "${r.name}": ${e.message}`); }
  }
}
// A send brought back by a backup restore may be out of date (owner, P4):
//   - its own attempt already has a final result (delivered, failed,
//     cancelled) → it is finished;
//   - a later attempt of it (Send again, linked by parentTransferId) was
//     delivered → it is finished, and must never go again.
// Either way it can only be dismissed. { state, later } or null. A send not
// restored has no later attempts (Send again moves its own transfer id on),
// so this changes nothing for it.
function deferredFinished(r) {
  if (!["attention", "failed", "cancelled"].includes(r.state)) return null;
  const restored = r.reason === "restored-from-backup" || !!r.restoredFromBackup;
  const delivered = transferResults.laterAttempts(tidOf(r)).find(e => e.state === "verified" || e.state === "acknowledged");
  if (delivered) return { state: delivered.state, later: true };
  const own = transferResults.get(tidOf(r));
  return own && own.state !== "unknown" && (restored || r.state === "attention") ? { state: own.state, later: false } : null;
}

// Ends an attempt: only from "uploading", so a restart's reconciliation or a
// person's action that moved it on is never overwritten. An ending that could
// not be saved (the disk refused) is kept and saved on the next pass, so it is
// neither lost for the rest of the run nor redone (P3 review); a restart
// before then reconciles the attempt as interrupted.
const DEFERRED_UNSAVED = new Map();   // id → { from, patch }
function endDeferred(rec, patch) {
  const t = deferredStore.transition(rec.id, ["uploading"], patch);
  if (!t.ok) {
    console.log(`[deferred] "${rec.name}": could not record ${patch.state} (${t.reason})`);
    if (t.reason === "persist") DEFERRED_UNSAVED.set(rec.id, { from: ["uploading"], patch });
  } else noteDeferredResult(t.record);
  return t;
}
function retryUnsavedDeferred() {
  for (const [id, u] of [...DEFERRED_UNSAVED]) {
    const t = deferredStore.transition(id, u.from, u.patch);
    if (t.ok) { DEFERRED_UNSAVED.delete(id); noteDeferredResult(t.record); if (t.record.state === "completed") applyDeferredCompleted(t.record); }
    else if (t.reason !== "persist") DEFERRED_UNSAVED.delete(id);   // moved on, or gone
  }
}
// Reached the printer and checked: saved as completed first, then its result,
// then the Loaded entry, then the record (and its bytes) go — the record only
// once the result is saved. A crash between any two steps is finished at
// startup (syncDeferredResults) — never another upload.
function completeDeferred(rec, from, { verification, size }) {
  const patch = { state: "completed", completion: { verification: verification.result, basis: verification.basis || null, verifiedAt: verification.at, size, at: Date.now() } };
  const t = deferredStore.transition(rec.id, from, patch);
  if (!t.ok) { if (t.reason === "persist") DEFERRED_UNSAVED.set(rec.id, { from, patch }); return t; }
  noteDeferredResult(t.record);
  applyDeferredCompleted(t.record);
  return t;
}
// Completions whose Loaded entry this run has written: written once, while
// the record waits for its result to be saved.
const DEFERRED_LOADED = new Set();
function applyDeferredCompleted(r) {
  const p = printerById(r.printerId);
  if (!p) return;                                         // kept until its printer is back
  if (!r.loadedApplied && !DEFERRED_LOADED.has(r.id)) {
    DEFERRED_LOADED.add(r.id);
    // Finished at startup after a crash: a Loaded file staged after this send
    // completed is the newer one and is left as it is (P3 review).
    const cur = queuedFile.get(p.id);
    const doneAt = (r.completion && r.completion.at) || r.updatedAt || 0;
    if (!(cur && cur.status === "ready" && cur.ts > doneAt && cur.name !== r.name)) {
      const size = r.completion && r.completion.size != null ? r.completion.size : r.source.size;
      queuedFile.set(p.id, { name: r.name, status: "ready", ts: Date.now(), plate: r.plate == null ? null : r.plate, send: r.send || null, size, sizeOf: "file", ...stagedChoices(r.map, r.prefs, p),
        ...(r.completion && START_OK_VERIFICATIONS.has(r.completion.verification) ? { verification: r.completion.verification, verifiedAt: r.completion.verifiedAt } : {}) });
      saveQueuedFiles();
    }
    // Waiting for its result: saved as Loaded already, so a restart does not
    // Load it again and a new send of the name is not refused (backend B1).
    if (!deferredResultSettled(r)) deferredStore.transition(r.id, ["completed"], { loadedApplied: true });
  }
  // The record is the only durable completion until its result is saved.
  if (!deferredResultSettled(r)) return;
  const rm = deferredStore.remove(r.id, ["completed"]);
  if (rm.ok) { DEFERRED_LOADED.delete(r.id); if (r.bytes) deferredStore.deleteBytes(r.id); }
}

async function runDeferredSend(p, rec, job) {
  const c = getConnector(p.connector);
  const actor = rec.actor || { userId: null, userLabel: null };
  const src = sourcePathOf(rec);
  // Nothing has been sent yet: a cancel now calls the whole send off.
  job.cancelUpload = () => { job.cancelRequested = true; job.cancelUpload = null; };
  try {
    // The source is still exactly what was asked for (owner safeguard 5).
    let ident;
    try { ident = await sourceIdentity(src); }
    catch (e) {
      // A share that is down says nothing about the file: the send goes back
      // in line, as an offline printer never drops one (P3 test review F4).
      // netfs's codes for "could not ask now" (netfs/NetFs.js), not "not there".
      if (e && ["NAS_UNREACHABLE", "ETIMEDOUT", "NETFS_BUSY", "NETFS_STOPPED", "WORKER_EXITED"].includes(e.code)) {
        throw Object.assign(new Error(`The folder ${rec.name} is in does not answer; it waits until it does.`), { code: "DEFERRED_SOURCE_UNREACHABLE", outcome: "failed", requeue: true });
      }
      // The code only: the fs message names the full path, and this text is kept
      // with the transfer's result (P4 security review).
      if (e && e.code === "SOURCE_CHANGED_WHILE_READ") throw Object.assign(new Error("It was changing while SnapCon checked it; nothing was sent. To send the new version, send the file again from SnapCon."), { code: "DEFERRED_SOURCE_CHANGED", outcome: "failed" });
      throw Object.assign(new Error(`It is no longer where it was when the send was asked for (${(e && e.code) || "unreadable"}); nothing was sent.`), { code: "DEFERRED_SOURCE_MISSING", outcome: "failed" });
    }
    if (ident.sha256 !== rec.source.sha256 || ident.size !== rec.source.size) {
      throw Object.assign(new Error("It changed after the send was asked for; nothing was sent. To send the new version, send the file again from SnapCon."), { code: "DEFERRED_SOURCE_CHANGED", outcome: "failed" });
    }
    // "Looks idle" was a sampled observation: re-check against the running job.
    await assertNotActiveJobFile(p, rec.name);
    // Replacing a file the printer already has, when that is switched off:
    // refused, as for any other send (owner, 2026-10-29).
    const plan = await decideUpload(p, rec.name);
    // It has the file: refused. It could not say (its list unreadable for
    // now): nothing sent, and the send waits and asks again later.
    if (plan.action === "refuse" && !plan.present) throw Object.assign(new Error(plan.reason), { code: "DEFERRED_PRINTER_UNCHECKED", outcome: "failed", requeue: true, waitingFor: "printer" });
    if (plan.action === "refuse") throw Object.assign(new Error(plan.reason + " Nothing was sent."), { code: "PRINTER_HAS_FILE", outcome: "failed" });
    // Still nothing sent: a cancel up to here calls the send off; from here
    // the connector's own Cancel takes over (P1).
    if (job.cancelRequested) throw Object.assign(new Error("Cancelled before anything was sent."), { code: "UPLOAD_CANCELLED", outcome: "failed" });
    job.cancelUpload = null;
    job.phase = "upload";
    job.localStat = ident.id;
    await whileUploading(() => c.uploadFile(p, src, rec.name, job));
    job.outcome = "sent";
    if (job.cancelRequested) throw cancelledAfterSending(job, p);
    await verifyOnPrinter(p, c, rec.name, src, job);
    // Nothing but the file goes to the printer (TODO §38): this runs unattended,
    // as soon as a print ends. The map and options wait for the Print.
    completeDeferred(rec, ["uploading"], { verification: job.verification, size: ident.size });
    job.result = { printer: p.name, started: false, verification: job.verification.result };
    job.phase = "done";
    try { auditLog.log({ category: "job", event: "file-uploaded", ...actor, printerId: p.id, printerName: p.name, detail: { file: rec.name, deferred: true, transferId: tidOf(rec), verification: job.verification.result } }); } catch {}
  } catch (e) {
    if (job.phase === "upload" || job.phase === "verifying") noteUploadFailure(job, e);
    job.errorCode = (e && e.code) || null; job.failedPhase = job.phase; job.error = e.message; job.phase = "error";
    const cancelled = (e && e.code === "UPLOAD_CANCELLED") || job.cancelRequested;
    if (cancelled) job.cancelled = true;
    // Nothing was sent and the source may come back: back in line, unchanged.
    if (!cancelled && e && e.requeue) {
      const patch = { state: "queued", attempt: null, waitingFor: e.waitingFor || "source", notBefore: Date.now() + DEFERRED_SOURCE_RETRY_MS };
      const t = deferredStore.transition(rec.id, ["uploading"], patch);
      if (!t.ok && t.reason === "persist") DEFERRED_UNSAVED.set(rec.id, { from: ["uploading"], patch });
      try { auditLog.log({ category: "job", event: e.waitingFor === "printer" ? "deferred-send-printer-unchecked" : "deferred-send-source-unreachable", printerId: p.id, printerName: p.name, detail: { file: rec.name, transferId: tidOf(rec) } }); } catch {}
      return;
    }
    const unknown = !cancelled && (job.outcome === "unknown" || (e && e.outcome === "unknown"));
    const state = cancelled ? "cancelled" : unknown ? "attention" : "failed";
    endDeferred(rec, { state, error: e.message, code: job.errorCode, ...(unknown ? { reason: "unknown-after-upload", errorReason: job.errorReason || null } : {}), ...(cancelled ? { outcome: job.outcome || "not-sent" } : {}) });
    try { auditLog.log({ category: "job", event: cancelled ? "deferred-send-cancelled" : unknown ? "upload-unconfirmed" : "upload-failed", ...actor, printerId: p.id, printerName: p.name, detail: { file: rec.name, deferred: true, transferId: tidOf(rec), ...(job.errorCode ? { code: job.errorCode } : {}) } }); } catch {}
  } finally {
    job.done = true; job.cancelUpload = null;
  }
}

// Reading the printer back for a send whose attempt was interrupted, or that
// needs attention (§37 P3, owner decisions 1 and D): only a copy proven
// complete — content verified, or the exact size listed — completes it.
// Anything else needs a person; a printer that cannot be asked leaves it as it
// was. Nothing is uploaded, overwritten, deleted or started.
const DEFERRED_ATTENTION_REASON = { absent: "interrupted-not-on-printer", mismatch: "interrupted-different-on-printer", acknowledged: "interrupted-listed-by-name" };
async function reconcileDeferredOne(p, rec, from) {
  const c = getConnector(p.connector);
  // What the file on this computer is now (A4 review B1): the very content
  // asked for (compared by content), gone (the printer's copy by size alone,
  // as P3 intends for a slicer's removed temporary file — but never for a
  // send whose own upload saw the file change), changed (proves nothing: it
  // needs a person), or not readable now (left as it was).
  let localPath = null, localId = null, source = "same";
  try {
    const ident = await sourceIdentity(sourcePathOf(rec));
    if (ident.sha256 === rec.source.sha256) { localPath = sourcePathOf(rec); localId = ident.id; } else source = "changed";
  } catch (e) {
    source = e && ["ENOENT", "ENOTDIR"].includes(e.code) ? "missing" : e && e.code === "SOURCE_CHANGED_WHILE_READ" ? "changed" : "unreadable";
  }
  if (source === "changed") {
    const t = deferredStore.transition(rec.id, from, { state: "attention", reason: "source-changed", evidence: `${rec.name} on this computer is not the version this send was asked for` });
    if (t.ok) noteDeferredResult(t.record);
    return { state: t.ok ? "attention" : (t.state || rec.state), evidence: "the file changed on this computer" };
  }
  if (source === "unreadable" || (source === "missing" && rec.errorReason === "local-changed")) return { state: rec.state, evidence: source === "unreadable" ? "the file on this computer could not be read" : "the file changed on this computer during its send and is gone; only its content could prove the copy" };
  let v;
  if (!c.verifyUpload) v = { result: "unverifiable", evidence: "this printer type cannot read files back" };
  else {
    try { v = await c.verifyUpload(p, rec.name, localPath, { attempts: 1, localSize: rec.source.size }); }
    catch (e) { v = { result: "unverifiable", evidence: e.message }; }
  }
  // Compared against a file that changed meanwhile: that comparison proves
  // nothing (§37 A4); the send is left as it was.
  if (localPath && !sameSource(localId, await sourceIdentityNow(localPath))) v = { result: "unverifiable", evidence: `${rec.name} changed on this computer while the printer's copy was compared` };
  const complete = v.result === "verified" || (v.result === "acknowledged" && v.basis === "size") || (v.result === "acknowledged" && v.basis === "content");
  if (complete) {
    const t = completeDeferred(rec, from, { verification: { result: v.result, basis: v.basis || null, at: Date.now() }, size: rec.source.size });
    return { state: t.ok ? "completed" : (t.state || rec.state), evidence: v.evidence || null };
  }
  if (v.result === "unverifiable") return { state: rec.state, evidence: v.evidence || null };
  const reason = DEFERRED_ATTENTION_REASON[v.result] || "interrupted-unknown";
  const t = deferredStore.transition(rec.id, from, { state: "attention", reason, evidence: v.evidence ? String(v.evidence).slice(0, 300) : null });
  if (t.ok) noteDeferredResult(t.record);
  return { state: t.ok ? "attention" : (t.state || rec.state), evidence: v.evidence || null };
}
const deferredCheckedAt = new Map();
let deferredReconciling = false;
async function reconcileDeferred(now = Date.now()) {
  if (deferredReconciling) return;
  deferredReconciling = true;
  try {
    for (const rec of deferredStore.list({ states: ["interrupted"] })) {
      const p = printerById(rec.printerId);
      if (!p || transferBusy(p)) continue;
      if (now - (deferredCheckedAt.get(rec.id) || 0) < DEFERRED_RECONCILE_MS) continue;
      let st; try { st = await probeCached(p); } catch { st = null; }
      if (!st || !st.online) continue;                    // offline: left as it was
      deferredCheckedAt.set(rec.id, Date.now());
      const out = await reconcileDeferredOne(p, rec, ["interrupted"]);
      try { auditLog.log({ category: "job", event: "deferred-send-reconciled", printerId: p.id, printerName: p.name, detail: { file: rec.name, transferId: tidOf(rec), state: out.state } }); } catch {}
    }
  } finally { deferredReconciling = false; }
}

// At startup: an attempt still "uploading" was interrupted (owner safeguard
// 1: an outcome to reconcile, not proof of a partial file); a completed one
// whose Loaded entry may not have been written is finished; leftover bytes
// are removed only after a clean load.
function deferredStartup() {
  for (const rec of deferredStore.list({ states: ["uploading"] })) {
    const t = deferredStore.transition(rec.id, ["uploading"], { state: "interrupted", interruptedAt: Date.now() });
    try { auditLog.log({ category: "job", event: "deferred-send-interrupted", printerId: rec.printerId, printerName: rec.printerName || null, detail: { file: rec.name, transferId: tidOf(rec), saved: t.ok } }); } catch {}
  }
  syncDeferredResults({ force: true });
  const c = deferredStore.cleanupOrphans();
  if (c.skipped) console.log(`[deferred] stored files kept: the send list was ${c.skipped}`);
  if (c.setAside && c.setAside.length) {
    console.log(`[deferred] ${c.setAside.length} stored file(s) no send refers to were set aside (kept until an admin deletes them)`);
    try { auditLog.log({ category: "system", event: "deferred-files-set-aside", detail: { files: c.setAside } }); } catch {}
  }
  const st = deferredStore.status();
  if (st.loadStatus !== "ok" && st.loadStatus !== "missing" || st.hold || st.dropped) {
    try { auditLog.log({ category: "system", event: "deferred-sends-restored", detail: { loadStatus: st.loadStatus, hold: st.hold ? st.hold.reason : null, readOnly: st.readOnly, dropped: st.dropped, quarantined: st.quarantined.map(f => path.basename(f)) } }); } catch {}
  }
}
setInterval(() => {
  pumpDeferred().catch(e => console.log("[deferred] send pass failed:", e.message));
  reconcileDeferred().catch(e => console.log("[deferred] reconcile pass failed:", e.message));
}, DEFERRED_PUMP_MS).unref();

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
// Does a Library location's folder answer at all? (A missing file inside one
// that answers is a missing file; a folder that is not there is a location
// that is offline or gone.)
async function locationAnswers(dir) {
  if (!dir) return false;
  try { return await netfs.exists(dir); } catch { return false; }
}
// A root found not answering: logged once per outage, and the Library checks
// it (at most every 30 s), which marks a Library location offline so dispatch
// stops even claiming for it.
const ROOT_DOWN = new Map();   // root id -> when it was last checked
function noteRootDown(rootId) {
  const last = ROOT_DOWN.get(rootId);
  if (last && Date.now() - last < 30000) return;
  if (!last) console.log(`[queue] ${rootId === GCODE_ROOT ? "the G-code folder" : "Library location " + rootId} does not answer; queued items from it wait`);
  ROOT_DOWN.set(rootId, Date.now());
  if (library.available) library.rescan(rootId).catch(() => {});
}

// A queued file no longer where it was: the Library's other present copies of
// the same content (by sha256), each hashed again now. The first identical one
// is used; nothing is guessed from a name. null when there is none.
async function relocateQueuedFile(item) {
  if (!item.file.sha256) return null;
  for (const c of library.locateContent(item.file.sha256)) {
    try {
      const ref = await resolveFileRef(null, c.rootId, c.rel, { system: true });
      if (!ref || !(await fileExists(ref.fp))) continue;
      const idBefore = await sourceIdentityNow(ref.fp);
      const h = await queueStore.computeFileHash(ref.fp, { force: true });
      const idAfter = await sourceIdentityNow(ref.fp);
      if (h.sha256 !== item.file.sha256 || !sameSource(idBefore, idAfter)) continue;
      console.log(`[queue] "${item.file.name}" moved: dispatching the identical file at ${c.rootId}:${c.rel}`);
      // id: what the upload's read-back compares against (§37 A4).
      return { fp: ref.fp, root: ref.root, rel: relOf(ref), id: idBefore };
    } catch { /* unreachable or unreadable: try the next copy */ }
  }
  return null;
}

// Whether the queue still owns this dispatch. Clear takes the item off, and
// then what the dispatch was about to do is not started or recorded (§28).
// A read, not a transition.
function queueStillDispatching(printerId, itemId) {
  const s = queueStore.getPrinterState(printerId);
  return s.queueState === "dispatching" && !!s.currentItem && s.currentItem.id === itemId;
}

async function attemptQueueDispatch(printerId) {
  const p = PRINTERS.find(pr => pr.id === printerId);
  if (!p || !p.printerPoolId) return;
  // Interlock with the sends waiting for this printer (round-3 issue #7, §37
  // P3 C4): they were asked for first and go first; the queue does not claim
  // the printer while any is queued. One needing attention does not hold it.
  if (deferredWaiting(p.id)) return;
  if (!(await isPrinterIdle(p))) return;
  // While the folder the next item is in is known to be unreachable nothing
  // is claimed: the items wait in order and dispatch resumes on the first
  // tick after it answers again. Only a shortcut — the forced check below
  // still decides, because "online" is not proof the file is there. The next
  // item's folder is the G-code folder, or the Library location it was
  // queued from (M7, §12).
  const next = queueStore.getPrinterState(printerId).queue[0];
  const nextRoot = (next && next.file && next.file.root) || GCODE_ROOT;
  let nextDir = FOLDER;
  if (nextRoot !== GCODE_ROOT) {
    try { nextDir = library.printLocation(null, nextRoot, { system: true }).path; }
    catch (e) { if (e instanceof LibraryError && e.status === 503) return; nextDir = null; }   // offline: wait; removed or off: fails below
  }
  if (nextDir && netfs.availability(nextDir).status !== "online") return;
  // A root that does not answer at all — a share or drive that is gone at
  // once (not found) rather than by timing out — is an outage, not proof
  // that the item's file was deleted: nothing is claimed, the item keeps its
  // place, and the root is checked again (M7.1; the G-code folder and Library
  // locations alike). Once the root answers, a file that is really gone is
  // "missing" as before.
  if (next && nextDir && !(await locationAnswers(nextDir))) { noteRootDown(nextRoot); return; }

  if (next) ROOT_DOWN.delete(nextRoot);
  // Checked again here, with nothing awaited before the claim: a manual send
  // or start registered while the checks above waited keeps the printer, and
  // a later sweep tries again (§28).
  if (deferredWaiting(p.id) || otherSendInFlight(p)) return;
  const claim = queueStore.claimNextForDispatch(printerId);
  if (!claim.claimed) return;
  const item = claim.item;
  // In JOBS from the claim to the end (§28): its upload is on the fleet row
  // like any other (activeUploadFor), /api/print-cancel can stop it, and
  // manual sends see the printer as taken (queueDispatchJob).
  const job = { phase: "verify", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now(), printerId: p.id, file: item.file.name, queueItemId: item.id, timeouts: uploadTimeoutsFromConfig(CFG), startsPrint: true };
  JOBS.set(newJobId(), job);
  try {
    const c = getConnector(p.connector);
    const rel = (item.file.sub ? item.file.sub + "/" : "") + item.file.name;
    let ref = null, fp = null, relocated = null;
    try { ref = await resolveFileRef(null, item.file.root, rel, { system: true }); fp = ref && ref.fp; }
    catch (e) {
      if (e && (e.code === "NAS_UNREACHABLE" || (e instanceof LibraryError && e.status === 503))) {
        queueStore.applyObserved(printerId, QueueEngine.onDispatchDeferred, item.id);
        return;
      }
      if (!(e instanceof LibraryError)) throw e;
      // The location was removed or switched off: like a missing file, the
      // item waits for a person (the same attention state, with the reason).
      queueStore.applyObserved(printerId, QueueEngine.onFileVerificationFailed, item.id, "missing", { code: "file-missing", message: e.message + " (" + item.file.name + ")" });
      return;
    }

    // Mandatory pre-dispatch file-identity check (design doc Part B/D6,
    // round-3 issue #4, round-4 issue #7) — forced, uncached hash, since this
    // IS the moment identity is being decided, not the routine case the cache
    // exists for.
    let verified = false;
    // The identity the content hash below was taken with (A4 review R1): the
    // read-back later compares against it, so an edit between the hash and the
    // upload is caught too.
    let hashedId = null;
    try {
      if (!fp || !(await fileExists(fp))) {
        // A Library location that does not answer at all is offline, not a
        // missing file (§12, M7): the item goes back to the front and waits,
        // and the Library checks the location now. Once it is known offline
        // nothing is claimed until it answers again.
        if (!(await locationAnswers(nextDir))) {
          console.log(`[queue] ${p.name}: "${item.file.name}" not dispatched — its folder does not answer; it stays first in the queue`);
          noteRootDown(nextRoot);
          queueStore.applyObserved(printerId, QueueEngine.onDispatchDeferred, item.id);
          return;
        }
        // Moved (§12, M7): the same content, verified now by its full hash, at
        // another place the Library knows. Dispatched from there and recorded
        // as such; anything else waits for a person.
        relocated = await relocateQueuedFile(item);
        if (relocated) { fp = relocated.fp; verified = true; hashedId = relocated.id; }
        else queueStore.applyObserved(printerId, QueueEngine.onFileVerificationFailed, item.id, "missing", { code: "file-missing", message: "File no longer exists: " + item.file.name });
      } else {
        const idBefore = await sourceIdentityNow(fp);
        const hash = await queueStore.computeFileHash(fp, { force: true });
        const idAfter = await sourceIdentityNow(fp);
        if (sameSource(idBefore, idAfter)) hashedId = idBefore;
        if (hash.sha256 !== item.file.sha256 || (idBefore && idAfter && !sameSource(idBefore, idAfter))) {
          queueStore.applyObserved(printerId, QueueEngine.onFileVerificationFailed, item.id, "changed", { code: "file-changed", message: "File content changed since it was queued: " + item.file.name });
        } else {
          verified = true;
        }
      }
    } catch (e) {
      // Unreachable storage says nothing about the file: nothing has been sent
      // yet, so the item goes back to the front of the queue unverified.
      if (e && e.code === "NAS_UNREACHABLE") {
        console.log(`[queue] ${p.name}: "${item.file.name}" not dispatched — the G-code folder is unreachable; it stays first in the queue`);
        queueStore.applyObserved(printerId, QueueEngine.onDispatchDeferred, item.id);
        return;
      }
      queueStore.applyObserved(printerId, QueueEngine.onFileVerificationFailed, item.id, "missing", { code: "file-check-error", message: e.message });
    }
    if (!verified) return;
    // Cleared while the file was being checked: nothing is sent (§28).
    if (!queueStillDispatching(printerId, item.id)) return;

    const name = item.file.name;
    try {
      // The queue reaches the same printers as the card and needs the same
      // protection: dispatch decides a printer is idle from a sampled probe, and
      // a job can start between that decision and this write.
      await assertNotActiveJobFile(p, name);
      // alreadyUploaded is the queue's own "this one is staged" flag; any
      // other item is always sent (no sampled comparison proves a copy is
      // the same).
      if (!item.alreadyUploaded) {
        const plan = await decideUpload(p, name);
        // A refusal is a real failure for a queued job — it cannot print what it
        // is not allowed to place — so it goes down the same path as any other
        // dispatch error rather than silently starting the wrong file.
        if (plan.action === "refuse") throw new Error(plan.reason);
        // Cleared while the printer was asked: nothing is sent (§28).
        if (!queueStillDispatching(printerId, item.id)) { console.log(`[queue] ${p.name}: "${name}" was taken off the queue before it was sent; not sending it`); return; }
        {   // the upload
          job.phase = "upload";
          job.localStat = hashedId || await sourceIdentityNow(fp);
          await whileUploading(() => c.uploadFile(p, fp, name, job));
          job.outcome = "sent";
          // Cancelled from the strip while the printer was confirming: it has
          // the file and confirmed it, and the item is not started (§37 P1).
          if (job.cancelRequested) throw cancelledAfterSending(job, p);
        }
      }
      // Whatever put the file there — this upload, or an earlier one
      // (alreadyUploaded) — the copy a start would use is read back first
      // (§37 P2). Unknown or Failed: the item waits for a person, never started.
      await verifyOnPrinter(p, c, name, fp, job, { earlier: !!item.alreadyUploaded });
      // Cleared while the file went out, or while the mapping below ran:
      // nothing is printing yet, so the start is not sent (§28).
      if (!queueStillDispatching(printerId, item.id)) { console.log(`[queue] ${p.name}: "${name}" was taken off the queue before it started; not starting it`); return; }
      const tools = Object.keys(item.map || {}).map(Number).sort((a, b) => a - b);
      let cleared = false;
      await withStartSequence(p, async () => {
        if (c.applyHeadMapping && (tools.length || printerHasAnyDefaultPref(p) || wantsAnyPref(item.prefs))) {
          job.phase = "mapping";
          await c.applyHeadMapping(p, tools, item.map, item.prefs);
        }
        if (!queueStillDispatching(printerId, item.id)) { cleared = true; return; }
        // From here Clear cancels the print, as it always did.
        job.phase = "starting";
        await c.startPrintFile(p, name, { prefs: item.prefs });
      });
      if (cleared) { console.log(`[queue] ${p.name}: "${name}" was taken off the queue before it started; not starting it`); return; }
      // Cleared once the start had been sent: Clear cancelled the print and
      // its result stands; nothing is recorded as started.
      if (!queueStillDispatching(printerId, item.id)) return;
      queueStore.applyObserved(printerId, QueueEngine.onDispatchSuccess, item.id);
      // Same dedup convention /api/print already uses — notifyTick's own
      // newJob detection would otherwise double-log this print's start.
      ROUTE_STARTED_PRINT.add(p.url);
      const auditRef = auditLog.log({ category: "job", event: "queue-print-started", printerId: p.id, printerName: p.name,
        detail: { file: name, retryOf: item.retryOfItemId || undefined, ...(item.library ? { library: libraryAudit(item.library) } : {}), ...(relocated ? { relocated: { from: item.file.root || GCODE_ROOT, to: relocated.root } } : {}) } });
      // Print history (M7): the queued Variant, or the queue's verified hash.
      library.recordPrintStart({
        jobKey: "queue:" + item.id, printerId: p.id, printerName: p.name, remoteName: name, source: item.library ? "library" : "queue", via: "queue",
        queueItemId: item.id, user: item.queuedBy || null, startedAt: Date.now(), auditRef, sha256: item.file.sha256,
        location: relocated ? relocated.root + ":" + relocated.rel : (item.file.root || GCODE_ROOT) + ":" + rel,
        library: item.library ? { contentKey: item.library.contentKey, plate: item.library.plate, model: item.library.model, variantKey: item.library.variantKey, sha256: item.file.sha256 } : null,
      });
    } catch (e) {
      if (job.phase === "upload" || job.phase === "verifying") noteUploadFailure(job, e);
      job.error = e.message; job.phase = "error";
      // Cleared meanwhile (Clear stops the upload itself): not the queue's to record.
      if (!queueStillDispatching(printerId, item.id)) return;
      // The item waits for a person, with Retry, Skip and Stop like any
      // dispatch failure — never started, never retried by itself, whatever
      // became of the transfer (§37 P1). Who cancelled is what
      // /api/print-cancel noted on the job.
      const error = queueDispatchError(e, job, name);
      queueStore.applyObserved(printerId, QueueEngine.onDispatchFailure, item.id, error);
      auditLog.log({ category: "job", event: "queue-dispatch-failed", printerId: p.id, printerName: p.name, detail: { file: name, error: error.message, ...(error.uploadOutcome ? { uploadOutcome: error.uploadOutcome } : {}) } });
    }
  } finally {
    job.done = true; job.cancelUpload = null;
    if (job.phase !== "error") job.phase = "done";
  }
}

// A failed dispatch as the queue records it (attentionDetail). The code and
// the extra fields let the page say it in the reader's language; the message
// is the English fallback. uploadOutcome is set when the transfer itself was
// not a plain failure: "sent" (the printer has the file and confirmed it) or
// "unknown" (it may have it). Either way nothing was started (§37 P1).
const UPLOAD_UNCONFIRMED_WHY = {
  timeout: s => `it did not answer within ${s} s`,
  "connection-lost": () => "the connection was lost before it answered",
  "unreadable-reply": () => "its answer could not be read",
  "not-on-printer": () => "it is not in the printer's file list",
  "verify-unreadable": () => "its copy on the printer could not be checked",
  "gone-from-printer": () => "it was uploaded earlier and is no longer in the printer's file list",
  "local-changed": () => "the file changed on this computer while it was being sent",
  "local-unreadable": () => "the file on this computer could not be checked again after it was sent",
};
function queueDispatchError(e, job, name) {
  const by = job.cancelledBy ? " by " + job.cancelledBy : "";
  const extra = { file: name, ...(job.cancelledBy ? { by: job.cancelledBy } : {}), ...(job.errorReason ? { reason: job.errorReason } : {}), ...(job.errorSeconds ? { seconds: job.errorSeconds } : {}), ...(job.printerPrompt ? { printerPrompt: true } : {}) };
  if (job.cancelRequested && job.outcome === "sent") {
    return { code: "upload-cancelled", message: `Cancelled${by} after ${name} reached the printer, which confirmed it; it was not started.`, uploadOutcome: "sent", ...extra };
  }
  if (job.cancelRequested && job.outcome === "unknown") {
    return { code: "upload-cancelled", message: `Cancelled${by} while the printer was confirming ${name}. SnapCon could not tell whether the printer received it; it was not started.`, uploadOutcome: "unknown", ...extra };
  }
  if (e && e.code === "UPLOAD_CANCELLED") return { code: "upload-cancelled", message: `Upload cancelled${by} before it finished: ${name}`, ...extra };
  if (e && e.code === "UPLOAD_UNCONFIRMED") {
    const why = (UPLOAD_UNCONFIRMED_WHY[job.errorReason] || UPLOAD_UNCONFIRMED_WHY["connection-lost"])(job.errorSeconds || "");
    return { code: "upload-unconfirmed", message: `${name} was sent, but the printer did not confirm it: ${why}. SnapCon cannot tell whether the printer has the file; it was not started.`, uploadOutcome: "unknown", ...extra };
  }
  if (e && e.code === "UPLOAD_MISMATCH") return { code: "upload-mismatch", message: `${name} was sent, but the file the printer holds under that name is not the one sent; it was not started.`, ...extra };
  if (e && e.code === "UPLOAD_STALLED") return { code: "upload-stalled", message: `${e.message}: ${name} was not sent completely.`, ...extra };
  if (e && e.code === "UPLOAD_CONNECT_TIMEOUT") return { code: "upload-connect-timeout", message: `${e.message}: ${name} was not sent.`, ...extra };
  return { code: "dispatch-error", message: e.message };
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
      .map(pool => ({ printers: PRINTERS.filter(p => p.printerPoolId === pool.id).map(p => ({ id: p.id, connector: p.connector })) }))
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
    return res.json({ id: i, url: p.url, brand: p.brand || "SnapMaker", virtual: isVirtualType(p.connector), tags: p.tags || [], capabilities: getCapabilities(p.connector, p), ...printerFamilyFields(p, conn, getCapabilities(p.connector, p)), transport: conn.getTransport ? conn.getTransport(p) : null, ...webrtcCameraFields(p, conn), colorPalette: conn.colorPalette, filamentMaterials: conn.filamentMaterials, autoLevel: !!p.autoLevel, flowCalibrate: !!p.flowCalibrate, timelapse: !!p.timelapse, forceDefaults: p.forceDefaults !== false, powerDrawW: Number(p.costKwh) > 0 ? Number(p.costKwh) : null, ...(await probeForDisplay(p)), lastSeenAt: lastSeenIso(p) });
  }
  FLEET_PROBE.prune(new Set(PRINTERS.map(fleetProbeKeyOf)));   // forget printers removed from config (§48)
  const out = await Promise.all(PRINTERS.map(async (p, i) => {
    if (!printerVisibleTo(req.user, p)) return null;
    const conn = getConnector(p.connector);
    // autoLevel/flowCalibrate/timelapse: not secrets (unlike token/
    // verificationCode) — exposed here so the per-print options checkboxes
    // (pfilemodal) can default to this printer's existing preferences for
    // every role, not just Admin (who already sees them via /api/config's
    // printers[]).
    // transport: which protocol this printer is actually driven over, where
    // the connector can say (FlashForge's stock API vs Moonraker after a
    // firmware mod). Synchronous and I/O-free by the same contract
    // getCapabilities has; null for every connector that speaks only one.
    const row = { id: i, url: p.url, brand: p.brand || "SnapMaker", virtual: isVirtualType(p.connector), tags: p.tags || [], capabilities: getCapabilities(p.connector, p), ...printerFamilyFields(p, conn, getCapabilities(p.connector, p)), transport: conn.getTransport ? conn.getTransport(p) : null, ...webrtcCameraFields(p, conn), colorPalette: conn.colorPalette, filamentMaterials: conn.filamentMaterials, autoLevel: !!p.autoLevel, flowCalibrate: !!p.flowCalibrate, timelapse: !!p.timelapse, forceDefaults: p.forceDefaults !== false, powerDrawW: Number(p.costKwh) > 0 ? Number(p.costKwh) : null, ...(await probeForDisplay(p)), lastSeenAt: lastSeenIso(p) };
    const up = activeUploadFor(p.id);
    if (up) row.upload = up;
    const qf = queuedFile.get(p.id);
    // Sends waiting for this printer (§37 P3), in order.
    const waiting = deferredStore.list({ printerId: p.id });
    const pl = waiting.find(r => r.state === "queued");
    // queuedFile (uploading/ready/error) reflects the retry sweep actually
    // acting on this printer; a queued deferred send is the earlier "still waiting for
    // it to go idle" state — surface that too, as the same field with its
    // own status, or the client has no way to tell "already queued" from
    // "hasn't been queued yet" while the printer stays busy, and would just
    // keep re-showing the queue prompt on every poll.
    // A Loaded file found gone or changed is no longer "ready" to the page:
    // no Loaded badge, no Print, its own banner (§37 P5).
    if (qf) row.queuedFile = { name: qf.name, status: stagedRowStatus(qf), ts: qf.ts, ...(qf.prefs ? { prefs: qf.prefs } : {}), ...(qf.error ? { error: qf.error } : {}), ...(qf.outcome ? { outcome: qf.outcome } : {}), ...(qf.reason ? { reason: qf.reason } : {}), ...(qf.plate != null ? { plate: qf.plate } : {}),
      ...(qf.check ? { check: { state: qf.check.state, at: qf.check.at, basis: qf.check.basis } } : {}), ...(qf.verification ? { verification: qf.verification, verifiedAt: qf.verifiedAt || null } : {}) };
    else if (pl) row.queuedFile = { name: pl.name, status: "queued", ts: pl.createdAt };
    if (waiting.length) row.pendingSends = waiting.map(deferredRow);
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

// A push larger than a kept file may be is refused from its declared size,
// before express.raw reads the whole body into memory (P3 review).
function refuseOversizePush(req, res, next) {
  const len = Number(req.headers["content-length"]);
  const max = deferredLimitsFromConfig(CFG).maxFileBytes || DEFERRED_LIMITS.maxFileBytes;
  if (req.is("application/octet-stream") && Number.isFinite(len) && len > max) {
    return res.status(413).json({ error: `The file is ${Math.ceil(len / 1048576)} MB; files sent through SnapCon's command-line hook can be at most ${Math.floor(max / 1048576)} MB.`, code: "DEFERRED_FILE_TOO_LARGE" });
  }
  next();
}
app.post("/api/notify-load", refuseOversizePush, rawGcodeBody, withGcodeHolds(async (req, res) => {
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
    const name = outputname || path.basename(filename || "upload.gcode");
    // The slicer hook can push any file at any printer. One this printer could
    // never start is refused before the bytes are written to disk.
    {
      const why = fileTypeRefusal(getCapabilities(p.connector, p), name, p.name);
      if (why) return res.status(400).json({ error: why });
    }
    // Kept durably (data/deferred-files/<id>, then its record) before the
    // answer, and sent as soon as the printer is free (§37 P3). "queued" still
    // means it goes now, "pending" that it waits for the printer.
    const idle = (await isPrinterIdle(p)) && !transferBusy(p);
    let rec;
    try { rec = await acceptDeferredSend(p, { name, kind: "push", buffer: req.body, actor: actorFromReq(req) }); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}) }); }
    return res.json({ ok: true, mode: idle ? "queued" : "pending", printer: p.name, transferId: tidOf(rec) });
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
  // Held before anything reads it (holdGcodeFile): the file may be in the G-code folder.
  if (!holdGcodeFile(req, absFile)) return res.status(409).json({ error: BEING_DELETED(path.basename(absFile)), code: "file_being_deleted" });
  // The slicer's output path can be a share too, so this goes through netfs.
  try { if (!(await netfs.stat(absFile)).isFile) return res.status(404).json({ error: "File not found: " + absFile }); }
  catch (e) {
    if (e && e.code === "NAS_UNREACHABLE") return res.status(503).json({ error: e.message, code: "gcode_folder_unreachable" });
    return res.status(404).json({ error: "File not found: " + absFile });
  }
  const idx = findPrinterIndex(printer);
  if (idx === -1) return res.status(400).json({ error: "Unknown printer: " + printer });
  const p = PRINTERS[idx];
  // outputname is used exactly as given — it's what the file is uploaded and
  // displayed as. The file actually read off disk is always absFile.
  const name = outputname ? outputname.trim() : path.basename(absFile);
  {
    const why = fileTypeRefusal(getCapabilities(p.connector, p), name, p.name);
    if (why) return res.status(400).json({ error: why });
  }

  // Same-machine CLI call (--load, no --snapcon) — no browser session exists
  // to attribute this to, so it's labeled as coming from the CLI itself.
  const actor = { userId: null, userLabel: "CLI" };
  const idle = (await isPrinterIdle(p)) && !transferBusy(p);
  let rec;
  try { rec = await acceptDeferredSend(p, { name, kind: "cli-path", file: absFile, actor }); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}) }); }
  res.json({ ok: true, mode: idle ? "queued" : "pending", printer: p.name, transferId: tidOf(rec) });
}));

// ---- Camera snapshot: delegated entirely to the connector — cooldown/idle-
// stop timer state (if any) lives inside it, not here. See
// connectors/snapmaker-u1-klipper.js's getCameraSnapshot for why: it's a
// quirk of Snapmaker's own camera plugin, not a generic "camera" concept.
// Every connector's getCameraSnapshot() returns { contentType, buffer }. This
// checks it before anything uses it: /api/snapshot copies contentType onto the
// response, where an invalid one ("undefined" from a connector returning a
// bare Buffer) made Express throw while sending — then again in the route's
// own 502 handler, so the browser got no answer at all and the log an
// unhandled rejection. A bad answer is now an ordinary "no camera frame".
async function getSnapshot(p) {
  const c = getConnector(p.connector);
  if (!c.getCameraSnapshot) throw new Error(p.name + " has no camera");
  return checkSnapshot(p, await c.getCameraSnapshot(p));
}
function checkSnapshot(p, shot) {
  const buffer = shot && shot.buffer;
  const type = String((shot && shot.contentType) || "").split(";")[0].trim().toLowerCase();
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error(p.name + "'s camera returned no image");
  if (!/^image\/[a-z0-9][a-z0-9.+-]*$/.test(type)) throw new Error(p.name + "'s camera returned " + (type || "no content type") + ", not an image");
  return { contentType: type, buffer };
}

// ---- Camera snapshot route: GET /api/snapshot, its throttle and its cache
// live in routes/snapshot.js. Required and registered here, at the route's
// original position, so start-up order is unchanged
// (docs/refactoring-policy.md). getSnapshot and checkSnapshot above stay
// here: notifications use them too. ----
const { registerSnapshotRoutes } = require("./routes/snapshot");
registerSnapshotRoutes(app, { requireAuth, getConfig: () => CFG, getPrinters: () => PRINTERS, printerVisibleTo, getSnapshot });

// ---- Live camera: relay one printer's video to a browser ----
// For cameras SnapCon has to connect to itself rather than let the browser do
// it: a Bambu Lab printer serves RTSP over TLS, with credentials, on a port no
// browser speaks. The connector holds ONE session per printer and fans it out
// to every viewer, so ten open tabs are still one connection to the machine.
//
// Same access rules as /api/snapshot above — video from a printer is exactly as
// sensitive as a still from it. A viewer that goes away unsubscribes, or the
// printer would keep streaming to nobody; one that stops reading is dropped by
// the relay (see `backlog`) rather than buffering video in SnapCon's memory.
app.get("/api/camera-stream", requireAuth, async (req, res) => {
  const p = PRINTERS[parseInt(req.query.printer, 10)];
  if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
  const c = getConnector(p.connector);
  if (!c.openCameraStream || !getCapabilities(p.connector, p).cameraStream) {
    return res.status(400).json({ error: p.name + " has no live camera stream" });
  }
  let sub = null, ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    if (sub) sub.unsubscribe();
    if (!res.writableEnded) res.end();
  };
  // Bytes can arrive (the init segment, then a buffered group of pictures)
  // before openCameraStream resolves with the codec the headers need — hold
  // them until the headers have gone out.
  let pendingWrites = [];
  const viewer = {
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
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-SnapCon-Codec": sub.codec || ""
  });
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
  // Optional: a connector with no way to fetch a preview answers 404 (the card
  // simply shows no thumbnail) rather than crashing the route.
  const conn = getConnector(p.connector);
  if (!conn.getThumbnail) return res.status(404).json({ error: p.name + " does not provide job previews" });
  try {
    const { contentType, buffer } = await conn.getThumbnail(p, file);
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
  const { printer, extruder, hex, material } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer" });
  if (typeof extruder !== "number" || extruder < 0) return res.status(400).json({ error: "Invalid extruder" });
  if (!/^#[0-9a-fA-F]{6}$/.test(String(hex || ""))) return res.status(400).json({ error: "Invalid color" });
  const c = getConnector(p.connector);
  if (!c.setFilamentColor) return res.status(400).json({ error: p.name + " does not support setting filament color" });

  // Material is optional; when present it is resolved to the connector's own
  // table entry HERE and that entry — never the request's strings — is what
  // gets forwarded. The connector interpolates these values into a G-code
  // line and the printer's firmware validates none of them, so this is a
  // trust boundary (section 8), and the connector re-checks at the sink.
  let resolvedMaterial;
  if (material !== undefined && material !== null) {
    if (!c.findFilamentMaterial) return res.status(400).json({ error: p.name + " does not support setting filament material" });
    resolvedMaterial = c.findFilamentMaterial(material);
    if (!resolvedMaterial) return res.status(400).json({ error: "Unknown filament material" });
  }

  try {
    // May differ from the requested hex (e.g. AD5X snaps to its touchscreen's
    // fixed color palette) — the client shows this back to the user rather
    // than assuming its own request was applied verbatim.
    const applied = await c.setFilamentColor(p, extruder, hex, { material: resolvedMaterial });
    const detail = { extruder, hex: applied || hex };
    if (resolvedMaterial) detail.material = resolvedMaterial;
    auditLog.log({ category: "job", event: "filament-color-set", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail });
    res.json({ ok: true, printer: p.name, extruder, hex: applied || hex, material: resolvedMaterial || null });
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

// ---- Firmware inventory: GET /api/firmware and its helpers live in
// routes/firmwareInventory.js. Required and registered here, at the route's
// original position, so start-up order is unchanged
// (docs/refactoring-policy.md). Firmware deployment stays in this file. ----
const { registerFirmwareInventoryRoutes } = require("./routes/firmwareInventory");
registerFirmwareInventoryRoutes(app, { requireAuth, getPrinters: () => PRINTERS, printerVisibleTo, getConnector, getCapabilities, probeCached });

// ---- Health diagnostics: GET /api/health and its helpers live in
// routes/health.js. Required and registered here, at the route's original
// position, so start-up order is unchanged (docs/refactoring-policy.md). ----
const { registerHealthRoutes } = require("./routes/health");
registerHealthRoutes(app, { requireAuth, getConfig: () => CFG, getPrinters: () => PRINTERS, getConnector, printerVisibleTo, probeCached, computeMaintenanceAttention, connHttp });

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
// Every call goes through netfs: the path is whatever the admin typed, often a
// share, and a disconnected mapped drive letter hangs exactly like one.
app.get("/api/browse", requireAdmin, async (req, res) => {
  const isWin = process.platform === "win32";

  // Windows-only: list available drives. On the background lane with a short
  // timeout, so a dead mapped drive costs this list one entry, not the file
  // browser its capacity.
  if (req.query.drives === "1") {
    const letters = [];
    for (let c = 65; c <= 90; c++) letters.push(String.fromCharCode(c) + ":\\");
    const found = await Promise.all(letters.map(d => netfs.exists(d, { lane: "background", timeoutMs: 3000 }).catch(() => false)));
    return res.json({ drives: letters.filter((d, i) => found[i]) });
  }

  let p = req.query.path ? path.resolve(req.query.path) : os.homedir();
  try { if (!(await netfs.stat(p)).isDirectory) p = path.dirname(p); }
  catch { p = os.homedir(); }

  const up = path.dirname(p);
  const atRoot = up === p;

  let entries = [];
  try {
    entries = (await netfs.readdir(p))
      .filter(e => e.isDirectory)
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
    // Settings > Printers shows its Rediscover button only when this is
    // present: a page newer than the running server (public/ is served from
    // disk, so it updates before a restart does) must not offer a button
    // whose routes are not there yet.
    rediscover: true,
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
    // The Full view's printing-card layout: "v2" (the new layout, default) or
    // "classic". Only an explicit Classic is stored, so a config that never
    // chose keeps following the default.
    cardLayout: CFG.cardLayout === "classic" ? "classic" : "v2",
    siteName: CFG.siteName || "",
    allowMapping: CFG.allowMapping !== false,
    suggestMatching: CFG.suggestMatching !== false,
    checkForUpdates: CFG.checkForUpdates !== false,
    allowUploadWhilePrinting: CFG.allowUploadWhilePrinting !== false,
    uploadIntoQueue: CFG.uploadIntoQueue === true,
    overwriteDifferentFiles: CFG.overwriteDifferentFiles !== false,
    usersEnabled: !!CFG.usersEnabled,
    virtualPrintersEnabled: CFG.virtualPrintersEnabled === true,
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
    // The printer's access code gets the same treatment for the same reason:
    // it is the credential a FlashForge authenticates every call with, and on a
    // Bambu Lab printer with Developer Mode on it is full control of the
    // machine. It used to round-trip in clear text and be written straight back
    // into the Settings input's value.
    printers: PRINTERS.map(p => ({
      ...p,
      token: undefined, hasToken: !!p.token,
      verificationCode: undefined, hasVerificationCode: !!p.verificationCode
    })),
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
// Update status is admin-only. Reading it never contacts GitHub; "Check now"
// does, at most once a minute and never against an active rate limit.
app.get("/api/update-status", requireAdmin, (req, res) => res.json(updateChecker.status()));
app.post("/api/update-check", requireAdmin, async (req, res) => {
  // checkNow() is written never to throw; if it somehow does, answer with a
  // controlled error instead of leaving the request hanging.
  try { res.json(await updateChecker.checkNow()); }
  catch (e) {
    console.error("[update-check] Check now failed:", e && e.message);
    res.status(500).json({ error: "update_check_failed" });
  }
});

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
// Virtual types (Simulator, Virtual U1) are offered only while Enable virtual
// printers is on, so they cannot be added while it is off.
app.get("/api/connectors", requireAuth, (req, res) => res.json(listConnectorTypes().filter(c => !c.virtual || CFG.virtualPrintersEnabled === true)));

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
  // A connector that always runs on one host (the Virtual U1, on this
  // machine) takes only a port from the client.
  const ip = spec.fixedHost || String(p.ip == null ? "" : p.ip).trim();
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
  // Same convention for the external spool lane (Bambu Lab, see that
  // connector's externalSpoolOption): default on, stored only when switched
  // off, and a save that doesn't mention it carries the existing choice
  // forward rather than turning the lane back on.
  if (typeof p.externalSpool === "boolean") {
    if (!p.externalSpool) o.externalSpool = false;
  } else if (existing && existing.externalSpool === false) {
    o.externalSpool = false;
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
  // The operator's explicit opt-in to SnapCon starting prints over Moonraker
  // on an AD5X running ZMOD, where the print-start macro may open a
  // touchscreen dialog (see connectors/flashforge-ad5x.js's hardware gate).
  // Stored only when EXACTLY true, so the connector's `!== true` check can
  // never be satisfied by a leftover or hand-edited truthy value.
  if (p.allowMoonrakerPrintStart === true) o.allowMoonrakerPrintStart = true;
  if (p.serial) o.serial = String(p.serial);
  // A virtual printer's simulator settings (the Virtual U1's Firmware and
  // Timing): only values the connector offers, only on that connector.
  const virtualOptions = getConnector(o.connector).virtualOptions;
  if (virtualOptions) {
    if (virtualOptions.firmware.includes(p.virtualFirmware)) o.virtualFirmware = p.virtualFirmware;
    if (virtualOptions.timing.includes(p.virtualTiming)) o.virtualTiming = p.virtualTiming;
  }
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
  // Identical convention for the access code, now that it is masked too: a
  // value replaces, "" (the control's Clear) removes, absent keeps what is on
  // file. Absent is the NORMAL case — the browser no longer has the value to
  // send back — so the old `if (p.verificationCode)` would have wiped the
  // stored code on every unrelated settings save. Still capped at 8 chars:
  // widened from Snapmaker's 4-char pairing code for FlashForge's checkCode.
  o.verificationCode = (typeof p.verificationCode === "string" && p.verificationCode.trim())
    ? p.verificationCode.trim().slice(0, 8)
    : (p.verificationCode === "" ? undefined : ((existing && existing.verificationCode) || undefined));
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

// The printers a save must keep although the browser never saw them: the
// virtual printers hidden while Enable virtual printers is off (see
// activePrinters). The browser posts its whole list, so without these a save
// would delete them. Kept as they are, after the saved ones, unless the save
// itself carries one (it cannot: no row shows it).
function hiddenPrinters(saved) {
  const ids = new Set(saved.map(p => p.id));
  return (CFG.printers || []).filter(p => !PRINTERS.includes(p) && !ids.has(p.id));
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
      ).then(saved => saved.concat(hiddenPrinters(saved)))
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
    // Only an explicit Classic is written; New (the default) is left out, so
    // "never chose" stays distinguishable from "chose Classic". Absent (an
    // older page) keeps the current choice rather than resetting it.
    cardLayout: b.cardLayout === undefined ? (CFG.cardLayout === "classic" ? "classic" : undefined) : (b.cardLayout === "classic" ? "classic" : undefined),
    // Empty means "don't show it" (see the topbar) — never persisted as a
    // stray leftover string once cleared.
    siteName: (typeof b.siteName === "string" && b.siteName.trim()) ? b.siteName.trim().slice(0, 60) : undefined,
    // Unlike tNotation (default off, "omit means false" is safe), these
    // default ON — so absence must fall back to the previous stored
    // value, not to false, or unchecking them would never persist.
    allowMapping: (typeof b.allowMapping === "boolean") ? b.allowMapping : (CFG.allowMapping !== false),
    suggestMatching: (typeof b.suggestMatching === "boolean") ? b.suggestMatching : (CFG.suggestMatching !== false),
    checkForUpdates: (typeof b.checkForUpdates === "boolean") ? b.checkForUpdates : (CFG.checkForUpdates !== false),
    allowUploadWhilePrinting: (typeof b.allowUploadWhilePrinting === "boolean") ? b.allowUploadWhilePrinting : (CFG.allowUploadWhilePrinting !== false),
    uploadIntoQueue: (typeof b.uploadIntoQueue === "boolean") ? b.uploadIntoQueue : (CFG.uploadIntoQueue === true),
    overwriteDifferentFiles: (typeof b.overwriteDifferentFiles === "boolean") ? b.overwriteDifferentFiles : (CFG.overwriteDifferentFiles !== false),
    usersEnabled: b.usersEnabled ? true : undefined,
    // Off by default; only an explicit true is stored. Absent (an older page)
    // keeps the current choice.
    virtualPrintersEnabled: (typeof b.virtualPrintersEnabled === "boolean" ? b.virtualPrintersEnabled : CFG.virtualPrintersEnabled === true) || undefined,
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
    // Set by hand in config.json only (no Settings UI, §37 P1): carried
    // forward for the same reason.
    uploadTimeouts: CFG.uploadTimeouts || undefined,
    // Also set by hand in config.json only, with no Settings field: carried
    // forward for the same reason (docs/TODO.md §49). Without this a Settings
    // save silently undid "utilization": { "readPrinterHistory": … } and
    // dropped the OpenEI key (the ZIP rate lookup fell back to DEMO_KEY).
    // test/configCarryForward.test.js fails if a key the server reads is
    // neither a Settings field nor carried forward.
    utilization: CFG.utilization || undefined,
    openeiKey: CFG.openeiKey || undefined,
    // Set only through POST /api/fleet-fast-offline (§48): carried forward,
    // or a Settings save would silently turn a rollback (false) back on.
    fleetFastOffline: typeof CFG.fleetFastOffline === "boolean" ? CFG.fleetFastOffline : undefined,
    // Same: the limits for files kept for busy printers (§37 P3).
    deferredSends: CFG.deferredSends || undefined,
    transferResults: CFG.transferResults || undefined,
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
    library.syncGcodeRoot();   // the G-code folder may have moved
    updateChecker.reschedule(); // "Check for updates" may have been switched on or off
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
  const printerBackups = (CFG.printers || []).map(p => p.allowedGroups);
  const userBackups = USERS.map(u => u.groupIds);

  CFG.groups.splice(idx, 1);
  // Every printer, the hidden virtual ones too: none may keep a deleted group.
  removeGroupReferences(id, CFG.printers || [], USERS);

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2));
    saveUsers();
  } catch (e) {
    CFG.groups = groupsBackup;
    (CFG.printers || []).forEach((p, i) => { p.allowedGroups = printerBackups[i]; });
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

// The three routes that change config.json together with the queue store
// save it as a whole (temporary file, flush, rename, folder flush — see
// configLoader.js replaceConfigFile) and are refused while config.json could
// not be read at start-up. queue/poolChange.js decides what each kind of
// failed save means; this only logs and audits it.
const saveConfigReplacing = () => replaceConfigFile(CONFIG_PATH, JSON.stringify(CFG, null, 2));
function reportConfigSaveProblem(req, r, what) {
  if (r.code !== "config_save_not_durable") return;
  console.error("[config] " + what + ": config.json was replaced but could not be confirmed as safely stored (" + ((r.cause && r.cause.code) || "error") + ")");
  auditLog.log({ category: "admin", event: "config-save-problem", ...actorFromReq(req), detail: { action: what, code: r.code, reason: (r.cause && r.cause.code) || null } });
}

app.post("/api/queue-management/enable", requireAdmin, (req, res) => {
  if (!CFG.queueManagement || typeof CFG.queueManagement !== "object") CFG.queueManagement = { enabled: false, mode: "per-printer" };
  if (!CFG.queueManagement.enabled) {
    // Auto-assign every currently-unmanaged printer — both systems of
    // record (config.json's printerPoolId, and QueueStore's own queueState)
    // need updating together (design doc A3). queue/poolChange.js does it in
    // that order, checks each step, and undoes a half-done change: nothing
    // is switched on while the queue store cannot save, and a failed
    // config.json save is an error here, no longer swallowed.
    const r = enableQueueManagement({
      queueStore, printers: PRINTERS, defaultPoolId: PRINTER_POOL_DEFAULT_MANUAL_ID, configLoadFailed: CONFIG_LOAD_FAILED,
      setEnabled: on => { CFG.queueManagement.enabled = on; if (on) ensurePrinterPoolSchema({ save: false }); },   // creates the protected Unassigned pool
      saveConfig: saveConfigReplacing,
    });
    if (!r.ok) {
      reportConfigSaveProblem(req, r, "enabling Queue Management");
      if (r.code === "queue_enable_incomplete") {
        console.error("[queue] enabling Queue Management was only partly undone (" + r.undoReason + "): the queue store has printers as managed that config.json does not");
        auditLog.log({ category: "admin", event: "queue-management-enable-incomplete", ...actorFromReq(req), detail: { reason: r.undoReason } });
      }
      if (r.applied) auditLog.log({ category: "admin", event: "queue-management-enabled", ...actorFromReq(req), detail: { saveConfirmed: false } });
      return res.status(r.status).json({ error: r.error, code: r.code });
    }
    auditLog.log({ category: "admin", event: "queue-management-enabled", ...actorFromReq(req) });
  }
  res.json({ ok: true });
});

app.post("/api/queue-management/disable", requireAdmin, (req, res) => {
  if (!CFG.queueManagement) CFG.queueManagement = {};
  const r = disableQueueManagement({
    isEnabled: () => CFG.queueManagement.enabled, setEnabled: on => { CFG.queueManagement.enabled = on; },
    configLoadFailed: CONFIG_LOAD_FAILED, saveConfig: saveConfigReplacing,
  });
  if (!r.ok) {
    reportConfigSaveProblem(req, r, "disabling Queue Management");
    if (r.applied) auditLog.log({ category: "admin", event: "queue-management-disabled", ...actorFromReq(req), detail: { saveConfirmed: false } });
    return res.status(r.status).json({ error: r.error, code: r.code });
  }
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
  const qs = queueStore.getPrinterState(p.id);
  if (qs.queueState !== "idle" && qs.queueState !== "unmanaged") return res.status(409).json({ error: "This printer's queue must be idle before changing its pool", code: "queue_not_idle" });
  if (qs.queue.length) return res.status(409).json({ error: "Clear this printer's queue before changing its pool", code: "queue_not_empty" });

  if (!printerPoolId) {
    // Leaving a pool: nothing to validate (the change itself is made below).
  } else {
    const pool = (CFG.printerPools || []).find(x => x.id === printerPoolId);
    if (!pool) return res.status(400).json({ error: "Unknown printer pool", code: "unknown_pool" });
    // A pool sends one file to every printer in it (print-on-all, distribute)
    // without asking what each can print. A printer with its own file types —
    // a Bambu Lab printer takes .3mf and .gcode, not the whole gcode family —
    // would be handed files it cannot start, at dispatch, unattended. Refused
    // until Queue Management understands per-printer file types (docs/TODO.md
    // section 13). Leaving a pool is always allowed: the branch above returns
    // before this.
    const caps = getCapabilities(p.connector, p);
    if (Array.isArray(caps.fileTypes) && caps.fileTypes.length) {
      return res.status(400).json({
        error: p.name + " cannot be added to a pool yet: it prints " + caps.fileTypes.map(t => "." + t).join(", ") + ", and pools send the same file to every printer in them.",
        code: "incompatible_file_types"
      });
    }
  }
  // Both records — the queue store, then config.json — with every answer
  // checked and a half-done change undone (queue/poolChange.js). Refused
  // with 503 before anything is touched while the queue store cannot save.
  const r = changePrinterPool({ queueStore, printer: p, printerPoolId: printerPoolId || null, configLoadFailed: CONFIG_LOAD_FAILED, saveConfig: saveConfigReplacing });
  if (!r.ok) {
    reportConfigSaveProblem(req, r, "changing a printer's pool");
    if (r.applied) auditLog.log({ category: "admin", event: "printer-pool-changed", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { printerPoolId: printerPoolId || null, saveConfirmed: false } });
    if (r.code === "pool_change_incomplete") {
      console.error("[queue] a pool change for " + p.name + " was only partly undone (" + r.undoReason + "): the queue store has it, config.json does not");
      auditLog.log({ category: "admin", event: "printer-pool-change-incomplete", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { printerPoolId: printerPoolId || null, reason: r.undoReason } });
    }
    return res.status(r.status).json({ error: r.error, code: r.code });
  }
  auditLog.log({ category: "admin", event: "printer-pool-changed", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { printerPoolId: printerPoolId || null } });
  res.json({ ok: true, printerPoolId: p.printerPoolId || null });
});

// ---- Per-printer queue ----
app.get("/api/queue/:printerId", requireAuth, (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p || !printerVisibleTo(req.user, p)) return res.status(404).json({ error: "Unknown printer", code: "unknown_printer" });
  res.json({ printerId: p.id, printerPoolId: p.printerPoolId || null, ...redactQueueStateForResponse(queueStore.getPrinterState(p.id)) });
});

// One file of a queue request (M7, §12): resolved in its location, hashed,
// and — when it was chosen on a Library Model page — checked to still be that
// Variant. null when it answered the request with the reason.
async function resolveQueuedFile(req, res, f, name, sub) {
  const root = (f || {}).root;
  // A file no printer can start is never queued (M8 review: with Library
  // locations any file in one — an STL, a PDF — could be). Pools only hold
  // printers that print the default types.
  const why = name && fileTypeRefusal(null, name, "The queue");
  if (why) { res.status(400).json({ error: why, code: "not_printable" }); return null; }
  let ref, hash, ident = null;
  try {
    ref = name ? await resolveFileRef(req.user, root, sub ? sub + "/" + name : name) : null;
    // Held before anything reads it; the route is wrapped in withGcodeHolds.
    if (ref && !holdGcodeFile(req, ref.fp)) { res.status(409).json({ error: BEING_DELETED(name), code: "file_being_deleted" }); return null; }
    if (!ref || !(await fileExists(ref.fp))) { res.status(400).json({ error: "File not found: " + name }); return null; }
    if (f.library) ident = await libraryPrintIdentity(ref, f.library);
    hash = await queueStore.computeFileHash(ref.fp);
  } catch (e) {
    if (replyFileRefError(res, e, root)) return null;
    res.status(400).json({ error: "Could not read file: " + name });
    return null;
  }
  if (ident && hash.sha256 !== ident.sha256) {
    res.status(409).json({ error: "This file changed since the Library last read it. Reload the model and try again.", code: "library_file_changed" });
    return null;
  }
  // Dispatch starts a project's plate 1 (M7.1): another plate is never queued.
  if (ident && ident.plate != null && ident.plate !== 1) {
    res.status(400).json({ error: `The queue can only start plate 1 of a project, and this is plate ${ident.plate}. Print it directly instead.`, code: "plate_unsupported" });
    return null;
  }
  return { root: ref.root, hash, ident };
}

app.post("/api/queue/:printerId/items", requireRegular, withGcodeHolds(async (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer", code: "no_printer_access" });
  if (!p.printerPoolId) return res.status(400).json({ error: "This printer has no Printer Pool assigned" });
  const b = req.body || {};
  const files = Array.isArray(b.files) ? b.files : [];
  if (!files.length) return res.status(400).json({ error: "No files given" });

  for (const f of files) {
    const { error } = checkToolMap((f || {}).map, p);
    if (error) return res.status(400).json({ error, code: "bad_tool_map" });
  }

  const actor = actorFromReq(req);
  const items = [];
  for (const f of files) {
    const name = String((f || {}).name || "").trim();
    const sub = String((f || {}).sub || "");
    const qty = Math.max(1, Math.min(50, parseInt(f.quantity, 10) || 1));
    const r = await resolveQueuedFile(req, res, f, name, sub);
    if (!r) return;
    for (let i = 0; i < qty; i++) {
      items.push({
        id: QueueEngine.newQueueItemId(), status: "queued", alreadyUploaded: false,
        file: { name, sub, ...(r.root !== GCODE_ROOT ? { root: r.root } : {}), sizeBytes: r.hash.sizeBytes, sha256: r.hash.sha256 },
        ...(r.ident ? { library: libraryQueueRef(r.ident) } : {}),
        map: f.map || {}, prefs: f.prefs || {},
        createdAt: Date.now(), dispatchedAt: null, finishedAt: null,
        queuedBy: actor, retryOfItemId: null, dispatchSnapshot: null
      });
    }
  }

  // Checked with nothing awaited before the items are stored.
  const deleting = items.find(i => queueFileBeingDeleted(i.file));
  if (deleting) return res.status(409).json({ error: BEING_DELETED(deleting.file.name), code: "file_being_deleted" });
  const result = queueStore.applyIntent(p.id, (state) => ({ ...state, queue: [...state.queue, ...items], updatedAt: Date.now() }));
  if (!result.ok) return res.status(503).json({ error: "Could not save the queue right now — " + (result.reason || "unknown error"), code: "queue_save_failed", detail: result.reason || null });
  const libs = items.filter(i => i.library).map(i => libraryAudit(i.library));
  auditLog.log({ category: "job", event: "queue-item-added", ...actor, printerId: p.id, printerName: p.name, detail: { count: items.length, ...(libs.length ? { library: libs[0] } : {}) } });
  if (b.startImmediately) attemptQueueDispatch(p.id).catch(e => console.error("[queue] immediate dispatch error:", e.message));
  res.json({ ok: true, added: items.length, state: redactQueueStateForResponse(result.nextState) });
}));

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

// Queue decisions for one printer (resolve, accept-file-change, Clear) run one
// at a time. A decision can wait on the printer (Resume probes and resumes it, the
// file check hashes a file), and two people deciding at once used to both pass
// their checks before either changed the queue: both could resume, or one
// could retry an item the other had just skipped. A second decision now waits
// its turn and is checked again against the queue as it is by then. Clear
// waits on the printer too (it cancels the print), so it takes its turn the
// same way (docs/TODO.md §36).
//
// The chain is released in a finally whatever the decision does, and a failed
// decision doesn't fail the next one. Different printers don't wait on each
// other. A printer that stops answering holds its own decisions only for as
// long as the connector's own timeouts allow.
const QUEUE_DECISIONS = new Map();   // printer id -> the decision chain's tail
function serializeQueueDecision(printerId, fn) {
  const prev = QUEUE_DECISIONS.get(printerId) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.catch(() => {});
  QUEUE_DECISIONS.set(printerId, tail);
  tail.then(() => { if (QUEUE_DECISIONS.get(printerId) === tail) QUEUE_DECISIONS.delete(printerId); });
  return run;
}
// The item a decision was made about. The page names it; a decision for an
// item the queue has since moved past (resolved, retried, replaced by the next
// one) is refused rather than applied to whatever is waiting now.
function sameQueueDecisionItem(state, itemId) {
  return (state.currentItem ? state.currentItem.id : null) === (itemId == null ? null : itemId);
}

// Clear — the actual "abort everything" action Stop deliberately isn't
// (Stop only blocks the next auto-dispatch; the current print, if any, keeps
// running and every queued item stays queued). This cancels whatever's
// physically printing right now, then wipes the rest of the queue.
app.post("/api/queue/:printerId/clear", requireRegular, async (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer", code: "no_printer_access" });
  // The job the page showed (none for a queue with nothing current). A Clear
  // sent while a Resume waits on the printer runs after it and sees the print
  // the Resume started, so it cancels it; a second Clear finds nothing left to
  // cancel. A Clear about a job the queue has moved past is refused before any
  // command: it never cancels a print the person didn't see.
  const { itemId } = req.body || {};
  try {
    await serializeQueueDecision(p.id, async () => {
      const store = queueStore.getGlobalStatus();
      if (store.queueStoreRecoveryRequired || store.storeDegraded || store.storeStoppedByAdmin) {
        return res.status(503).json({ error: "The queue can't save changes right now", code: "queue_store_unavailable" });
      }
      const qs = queueStore.getPrinterState(p.id);
      if (!sameQueueDecisionItem(qs, itemId)) {
        return res.status(409).json({ error: "The queue has moved on since this page showed it. Refresh to see what it's doing now.", code: "stale_decision" });
      }
      const wasPrinting = qs.queueState === "dispatching" || qs.queueState === "printing";
      // A dispatch that has not sent its start has nothing printing: clearing the
      // queue is enough, since the dispatch will not start an item that is no
      // longer the queue's, and an upload still going out is stopped below (§28).
      // No dispatch record (after a restart) or a start already sent: cancel the
      // print, as always.
      // Only a job the queue has current is ever cancelled: a page that showed
      // an idle queue names no job, and a print started since (by the queue,
      // which makes it current, or outside it) is never cancelled by its Clear.
      const dispatch = qs.queueState === "dispatching" ? queueDispatchJob(p.id) : null;
      let cancelledItemId = null;
      if (qs.currentItem && (qs.queueState === "printing" || (qs.queueState === "dispatching" && (!dispatch || dispatch.phase === "starting")))) {
        try { await getConnector(p.connector).cancel(p); }
        catch (e) { return res.status(502).json({ error: "Could not cancel the current print: " + e.message, code: "cancel_failed", detail: e.message }); }
        cancelledItemId = qs.currentItem.id;
      }
      const removedQueuedCount = qs.queue.length;
      // The printer's own updates keep arriving during the cancel (the print
      // can end, failed or complete, in the meantime): cleared only while the
      // same job is current, and its outcome is recorded once.
      const result = queueStore.applyIntent(p.id, state => {
        if (!sameQueueDecisionItem(state, qs.currentItem ? qs.currentItem.id : null)) throw new Error("The queue moved on while the print was being cancelled");
        return QueueEngine.clearQueue(state, { cancelledItemId });
      });
      if (!result.ok && result.reason === "invalid-transition") return res.status(409).json({ error: "The print was cancelled, but the queue moved on before it could be cleared, so nothing else was removed. Check what it shows now.", code: "queue_moved_during_clear" });
      if (!result.ok) return res.status(503).json({ error: "Could not save the queue right now", code: "queue_save_failed" });
      if (dispatch && dispatch.cancelUpload) dispatch.cancelUpload();
      auditLog.log({ category: "job", event: "queue-cleared", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail: { cancelledCurrent: wasPrinting, removedQueuedCount } });
      res.json({ ok: true, state: redactQueueStateForResponse(result.nextState) });
    });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: "Could not clear the queue right now", code: "clear_failed" });
  }
});

// Manual bed-clear confirmation — always a real, audited, server-side
// action (Correction 2), never a client-only state flip.
app.post("/api/queue/:printerId/confirm-bed-clear", requireRegular, (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer", code: "no_printer_access" });
  // The finished job the page showed. A confirmation from a page that is
  // behind (it showed an earlier print's bed) is refused before anything is
  // started. Checked and applied with nothing awaited between, so no other
  // request can change the queue in between; that is also why this needs no
  // place in the decision chain.
  const { itemId } = req.body || {};
  if (!sameQueueDecisionItem(queueStore.getPrinterState(p.id), itemId)) {
    return res.status(409).json({ error: "This is about a print the queue has moved past. Refresh to see what it's waiting on now.", code: "stale_decision" });
  }
  const actor = actorFromReq(req);
  const result = queueStore.confirmManualBedClear(p.id, actor);
  if (!result.ok && result.reason === "invalid-transition") return res.status(409).json({ error: "This printer isn't waiting for its bed to be cleared", code: "not_awaiting_bed_clear" });
  if (!result.ok) return res.status(503).json({ error: "Could not save the queue right now", code: "queue_save_failed" });
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
  const { action, itemId } = req.body || {};
  try {
    await serializeQueueDecision(p.id, async () => {
      // Everything that can refuse is checked BEFORE any command reaches the
      // printer, and inside the chain, so it is checked against the queue as
      // the previous decision left it. The dry run is the engine's own rule,
      // so the two can't disagree.
      const store = queueStore.getGlobalStatus();
      if (store.queueStoreRecoveryRequired || store.storeDegraded || store.storeStoppedByAdmin) {
        return res.status(503).json({ error: "The queue can't save changes right now", code: "queue_store_unavailable" });
      }
      const current = queueStore.getPrinterState(p.id);
      if (current.queueState !== "queue_attention_required") {
        return res.status(409).json({ error: "This printer's queue isn't waiting for a decision", code: "not_in_attention" });
      }
      if (!sameQueueDecisionItem(current, itemId)) {
        return res.status(409).json({ error: "This decision is about a job the queue has already moved past. Refresh to see what it's waiting on now.", code: "stale_decision" });
      }
      try { QueueEngine.resolveAttention(current, action); }
      catch { return res.status(400).json({ error: "That action isn't available for this queue right now", code: "invalid_action" }); }

      if (action === "resume") {
        let probe;
        try { probe = await getConnector(p.connector).probe(p); } catch { probe = { online: false }; }
        if (!probe.online || probe.state !== "paused") return res.status(409).json({ error: "This printer isn't in a resumable state right now" });
        try { await getConnector(p.connector).resume(p); }
        catch (e) { return res.status(502).json({ error: "Resume failed: " + e.message }); }
      }

      // Applied only to the item the checks above passed for. Nothing outside
      // this chain moves a queue out of attention, so this can't fail here
      // today; it is the last guard should that ever change.
      const result = queueStore.applyIntent(p.id, (state, a) => {
        if (!sameQueueDecisionItem(state, itemId)) throw new Error("The queue moved on while this decision was made");
        return QueueEngine.resolveAttention(state, a);
      }, action);
      if (!result.ok) return res.status(400).json({ error: result.reason === "invalid-transition" ? (result.error && result.error.message) : "Could not resolve right now" });
      // A completion a person confirmed names its file and who decided. Not a
      // print-completed event: the Library imports those as printer-reported.
      const detail = action === "mark-completed" && current.currentItem
        ? { action, file: current.currentItem.file && current.currentItem.file.name, completedBy: "user" }
        : { action };
      auditLog.log({ category: "job", event: "queue-attention-resolved", ...actorFromReq(req), printerId: p.id, printerName: p.name, detail });
      if (result.nextState.queueState === "idle" || result.nextState.queueState === "dispatching") {
        attemptQueueDispatch(p.id).catch(e => console.error("[queue] post-resolve dispatch error:", e.message));
      }
      res.json({ ok: true, state: redactQueueStateForResponse(result.nextState) });
    });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: "Could not resolve right now" });
  }
});

// file-changed's dedicated accept path — forces a fresh, uncached hash
// (round-4 issue #7) rather than trusting anything cached, since this IS
// the moment identity itself is being decided.
app.post("/api/queue/:printerId/accept-file-change", requireRegular, async (req, res) => {
  const p = printerById(req.params.printerId);
  if (!p) return res.status(400).json({ error: "Unknown printer", code: "unknown_printer" });
  if (!printerVisibleTo(req.user, p)) return res.status(403).json({ error: "You don't have access to this printer", code: "no_printer_access" });
  const { itemId } = req.body || {};
  // One decision at a time per printer, like /resolve: a Skip and an accept
  // sent together can't both act on the same item.
  try {
    await serializeQueueDecision(p.id, async () => {
      const qs = queueStore.getPrinterState(p.id);
      if (qs.attentionReason !== "file-changed" || !qs.currentItem) return res.status(409).json({ error: "Nothing to accept right now" });
      if (!sameQueueDecisionItem(qs, itemId)) {
        return res.status(409).json({ error: "This decision is about a job the queue has already moved past. Refresh to see what it's waiting on now.", code: "stale_decision" });
      }
      const item = qs.currentItem;
      let hash;
      try {
        // The file where the item lives: the G-code folder, or the Library
        // location it was queued from (M8 review: this hashed the G-code folder's
        // path for a Library item, so it could never be accepted).
        const ref = await resolveFileRef(req.user, item.file.root, (item.file.sub ? item.file.sub + "/" : "") + item.file.name);
        if (!ref || !(await fileExists(ref.fp))) return res.status(400).json({ error: "File no longer exists" });
        hash = await queueStore.computeFileHash(ref.fp, { force: true });
      } catch (e) {
        if (replyFileRefError(res, e, item.file.root)) return;
        return res.status(400).json({ error: e.message });
      }
      const actor = actorFromReq(req);
      // The hash took a while: accept only if the item it describes is still the
      // one waiting on this decision.
      const result = queueStore.applyIntent(p.id, (state, args) => {
        if (!state.currentItem || state.currentItem.id !== item.id) throw new Error("The queue changed while the file was being checked");
        return QueueEngine.acceptFileChange(state, args);
      }, { sizeBytes: hash.sizeBytes, sha256: hash.sha256, actor });
      if (!result.ok) return res.status(400).json({ error: "Could not accept the file change" });
      auditLog.log({ category: "job", event: "queue-file-change-accepted", ...actor, printerId: p.id, printerName: p.name, detail: { file: item.file.name } });
      attemptQueueDispatch(p.id).catch(e => console.error("[queue] post-accept dispatch error:", e.message));
      res.json({ ok: true, state: redactQueueStateForResponse(result.nextState) });
    });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: "Could not accept the file change" });
  }
});

// ---- Bulk "Send to Queue" (file-manager multiselect → Printer Pool) ----
app.post("/api/queue/send", requireRegular, withGcodeHolds(async (req, res) => {
  const b = req.body || {};
  const files = Array.isArray(b.files) ? b.files : [];
  const poolId = b.poolId;
  const mode = b.mode === "distribute" ? "distribute" : "print-on-all";
  if (!files.length) return res.status(400).json({ error: "No files given" });
  const pool = (CFG.printerPools || []).find(x => x.id === poolId);
  if (!pool) return res.status(400).json({ error: "Unknown printer pool", code: "unknown_pool" });
  const targetPrinters = PRINTERS.filter(p => p.printerPoolId === poolId && printerVisibleTo(req.user, p));
  if (!targetPrinters.length) return res.status(400).json({ error: "No printers available in this pool" });
  for (const f of files) for (const p of targetPrinters) {
    const { error } = checkToolMap((f || {}).map, p);
    if (error) return res.status(400).json({ error, code: "bad_tool_map" });
  }

  // Validate + resolve every file BEFORE computing or writing anything —
  // one invalid file fails the whole request, never a partial distribution
  // (round-4 issue #2).
  const resolved = [];
  for (const f of files) {
    const name = String((f || {}).name || "").trim();
    const sub = String((f || {}).sub || "");
    const qty = Math.max(1, Math.min(50, parseInt(f.quantity, 10) || 1));
    const r = await resolveQueuedFile(req, res, f, name, sub);
    if (!r) return;
    resolved.push({ name, sub, root: r.root, qty, sizeBytes: r.hash.sizeBytes, sha256: r.hash.sha256, ident: r.ident, map: f.map || {}, prefs: f.prefs || {} });
  }

  const actor = actorFromReq(req);
  const makeItem = (f) => ({
    id: QueueEngine.newQueueItemId(), status: "queued", alreadyUploaded: false,
    file: { name: f.name, sub: f.sub, ...(f.root !== GCODE_ROOT ? { root: f.root } : {}), sizeBytes: f.sizeBytes, sha256: f.sha256 },
    ...(f.ident ? { library: libraryQueueRef(f.ident) } : {}),
    map: f.map, prefs: f.prefs, createdAt: Date.now(), dispatchedAt: null, finishedAt: null,
    queuedBy: actor, retryOfItemId: null, dispatchSnapshot: null
  });
  // Quantity is expanded into a flat list of individual entries before
  // distribution — Distribute's round-robin never has to know "quantity" is
  // a separate concept (design doc A5).
  const expanded = [];
  for (const f of resolved) for (let i = 0; i < f.qty; i++) expanded.push(f);
  // Checked with nothing awaited before the items are stored.
  const deleting = resolved.find(f => queueFileBeingDeleted(f));
  if (deleting) return res.status(409).json({ error: BEING_DELETED(deleting.name), code: "file_being_deleted" });

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
  const libs = resolved.filter(f => f.ident).map(f => libraryAudit(f.ident));
  auditLog.log({ category: "job", event: "queue-bulk-send", ...actor, detail: { poolId, mode, fileCount: resolved.length, totalItems: expanded.length, printerCount: targetPrinters.length, ...(libs.length ? { library: libs } : {}) } });
  if (b.startImmediately) targetPrinters.forEach(p => attemptQueueDispatch(p.id).catch(e => console.error("[queue] bulk-send dispatch error:", e.message)));
  res.json({ ok: true, printers: targetPrinters.map(p => p.id), totalItems: expanded.length });
}));

// ---- Global store status/controls (round-4 issue #1/#8) ----
app.get("/api/queue-store/status", requireAuth, (req, res) => res.json(queueStore.getGlobalStatus()));
app.post("/api/queue-store/retry-save", requireAdmin, (req, res) => {
  const r = queueStore.retrySave();
  auditLog.log({ category: "admin", event: r.ok ? "queue-store-recovered" : "queue-store-retry-failed", ...actorFromReq(req) });
  if (r.ok) return res.json({ ok: true });
  // r.error is an Error: sent as it is, it reaches the browser as an object
  // (shown as "[object Object]") carrying the server's full path. Only its
  // code goes out, and only if it looks like one.
  const code = r.error && r.error.code;
  const reason = typeof code === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(code) ? code : "error";
  res.json({ ok: false, code: "queue_save_retry_failed", reason,
    error: reason === "QUEUE_RECOVERY_REQUIRED" ? "Nothing was saved: queue recovery is required first." : "The queue could not be saved (" + reason + ")." });
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
  // A reset that began and did not finish is a server-side failure, and is
  // audited: recovery stays required (see QueueStore.js acknowledgeReset).
  if (!r.ok && r.code === "queue_reset_incomplete") auditLog.log({ category: "admin", event: "queue-store-reset-failed", ...actorFromReq(req) });
  if (!r.ok) return res.status(r.code === "queue_reset_incomplete" ? 500 : 400).json(r);
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

// ---- A queue print the printer went idle on (docs/TODO.md §34) ----
// The queue leaves "printing" when the printer reports complete, error or
// cancelled (notifyTick, below). A printer that goes back to standby without
// one of those, or never starts the item, would leave it "printing" forever.
// Standby is not completion: after it is confirmed, the queue asks a person
// (recovery-unknown-outcome, the reason startup reconciliation gives the same
// case) and nothing advances, retries or resends on its own.
//
// Confirmed means QUEUE_IDLE_CHECKS idle readings in a row that also span
// QUEUE_IDLE_MIN_MS, so polls that come close together cannot confirm it
// early. A printer never seen printing since the dispatch may look idle during
// its own start, so that case also waits QUEUE_START_GRACE_MS from the
// dispatch. Printing, paused, busy or any other reading starts the count over,
// and so does the printer going offline (queueIdleWatchOffline).
const QUEUE_IDLE_CHECKS = 3;
const QUEUE_IDLE_MIN_MS = 60 * 1000;
const QUEUE_START_GRACE_MS = 10 * 60 * 1000;
const QUEUE_IDLE_LIKE = new Set(["standby", "idle", "complete", "cancelled", "error"]);
const QUEUE_IDLE_WATCH = new Map(); // printer id -> { itemId, seenPrinting, checks, firstIdleAt }

// One reading. Pure: returns the next watch and a verdict, null until confirmed.
function queueIdleWatchStep(watch, { itemId, dispatchedAt, state, now }) {
  const w = watch && watch.itemId === itemId ? { ...watch } : { itemId, seenPrinting: false, checks: 0, firstIdleAt: null };
  if (!QUEUE_IDLE_LIKE.has(state)) {
    if (state === "printing" || state === "paused") w.seenPrinting = true;
    w.checks = 0; w.firstIdleAt = null;
    return { watch: w, verdict: null };
  }
  w.checks += 1;
  if (w.firstIdleAt == null) w.firstIdleAt = now;
  if (w.checks < QUEUE_IDLE_CHECKS || now - w.firstIdleAt < QUEUE_IDLE_MIN_MS) return { watch: w, verdict: null };
  if (w.seenPrinting) return { watch: w, verdict: "printer-idle" };
  const since = dispatchedAt != null ? dispatchedAt : w.firstIdleAt;
  return { watch: w, verdict: now - since >= QUEUE_START_GRACE_MS ? "start-not-seen" : null };
}

// The printer did not answer: the idle count starts over; whether it was seen
// printing is kept.
function queueIdleWatchOffline(p) {
  const w = QUEUE_IDLE_WATCH.get(p.id);
  if (w) QUEUE_IDLE_WATCH.set(p.id, { ...w, checks: 0, firstIdleAt: null });
}

// Called by notifyTick with each online reading, after its complete/error/
// cancelled handling, so a queue that reading already moved on is left alone.
function watchQueuePrinting(p, st) {
  const qs = p.printerPoolId ? queueStore.getPrinterState(p.id) : null;
  if (!qs || qs.queueState !== "printing" || !qs.currentItem) { QUEUE_IDLE_WATCH.delete(p.id); return; }
  const item = qs.currentItem;
  const { watch, verdict } = queueIdleWatchStep(QUEUE_IDLE_WATCH.get(p.id), { itemId: item.id, dispatchedAt: item.dispatchedAt, state: st.state, now: Date.now() });
  QUEUE_IDLE_WATCH.set(p.id, watch);
  if (!verdict) return;
  QUEUE_IDLE_WATCH.delete(p.id);
  const name = item.file && item.file.name;
  const message = verdict === "printer-idle"
    ? `The printer went idle without reporting that "${name}" finished, failed or was cancelled. Check the printer before choosing what to do.`
    : `The printer has not been seen printing "${name}" in the ${Math.round(QUEUE_START_GRACE_MS / 60000)} minutes since it was sent. Check the printer before choosing what to do.`;
  queueStore.applyObserved(p.id, QueueEngine.onPrinterIdleWhilePrinting, item.id, { code: verdict, message });
  auditLog.log({ category: "job", event: "queue-outcome-unknown", printerId: p.id, printerName: p.name, detail: { file: name, reason: verdict, printerState: st.state } });
}

// Energy for one print (docs/TODO.md §45): the printer's own power draw
// (Settings > Printers "Power draw, watts" — stored as `costKwh` despite its
// name) × the print's hours × the electricity rate. An estimate — nothing
// measures the draw — and none at all when the watts, the rate or the time is
// unknown: never the old implied 1,000 W. Returned with its basis so a
// measured figure from a real meter can replace it later.
function printEnergyEstimate(p, hours) {
  const watts = Number(p && p.costKwh), rate = Number(CFG.electricityRate);
  if (!(watts > 0) || !(rate > 0) || !(hours > 0)) return null;
  const kwh = watts * hours / 1000;
  return { kwhEst: Math.round(kwh * 1000) / 1000, watts, ratePerKwh: rate, cost: kwh * rate, basis: "estimate" };
}

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

  utilization.beginTick(CFG.printers, PRINTERS);
  await Promise.all(PRINTERS.map(async (p, i) => {
    const st = await probeCached(p);
    // Fleet utilization: the reading as it is, offline included. Cannot throw.
    utilization.observe(p, st);
    // Unreachable: a queue print's idle count starts over (§34).
    if (!st.online) { queueIdleWatchOffline(p); return; }

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
        const auditRef = auditLog.log({ category: "job", event: "print-started", printerId: p.id, printerName: p.name, detail: { file: st.filename } });
        // Print history (M7): a job SnapCon did not start, linked by name.
        const startedAt = Date.now();
        library.recordPrintStart({ jobKey: "observed:" + p.id + ":" + startedAt, printerId: p.id, printerName: p.name, remoteName: st.filename || "",
          source: "external", via: null, startedAt, auditRef });
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
        const energy = printEnergyEstimate(p, hours);   // §45: this printer's watts, not 1 kW
        const eCost = energy ? energy.cost : 0;
        const costEst = (fCost + eCost) > 0 ? Math.round((fCost + eCost) * 100) / 100 : null;
        auditLog.log({ category: "job", event: "print-completed", printerId: p.id, printerName: p.name, detail: { file: st.filename, elapsedSec, filamentUsedMm, filamentGramsEst, costEst,
          ...(energy ? { energy: { kwhEst: energy.kwhEst, watts: energy.watts, ratePerKwh: energy.ratePerKwh, basis: energy.basis } } : {}) } });
        library.recordPrintOutcome({ printerId: p.id, remoteName: st.filename, outcome: "completed", at: Date.now(), elapsedSec, filamentG: filamentGramsEst, costEst });
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
        library.recordPrintOutcome({ printerId: p.id, remoteName: st.filename, outcome: st.state === "error" ? "failed" : "cancelled", at: Date.now() });
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
    watchQueuePrinting(p, st);

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
  // Fleet utilization: what this poll observed is saved now, after it, in
  // bounded turns.
  utilization.endTick();
}
setInterval(notifyTick, NOTIFY_POLL_MS).unref();

// Fleet utilization reports (Phase 3): read only, signed-in users, each
// printer as visible to them (utilization/routes.js).
utilization.registerRoutes(app, { requireAuth, getConfig: () => CFG.utilization, getPrinters: () => PRINTERS, printerVisibleTo });
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
  // The access code is masked in Settings, so an untouched field sends nothing
  // — without this, Test connection would fail on every saved printer whose
  // code the admin hadn't just retyped. Only ever the code already on file for
  // the printer this row IS (matched by its own id, never by a client-supplied
  // url), and only when the row didn't carry one.
  else if (b.id) {
    const saved = PRINTERS.find(x => x.id === b.id);
    if (saved && saved.verificationCode) p.verificationCode = saved.verificationCode;
  }
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

// ---- Auto-discovery: GET /api/discover and its helpers live in
// routes/discover.js. Required and registered here, at the route's original
// position, so the order of the routes is unchanged (docs/refactoring-policy.md). ----
const { registerDiscoverRoutes } = require("./routes/discover");
registerDiscoverRoutes(app, { requireAdmin, getConnector, listConnectorTypes });

// ---- Settings > Printers "Rediscover" (docs/TODO.md §35) ----
// Matching is public/rediscover.js, in the browser; these two routes are its
// evidence and its save. Only printers whose connector can be asked for a
// serial (the inventory capability, U1 today) are read or changed: on
// FlashForge and Bambu the serial is a credential the printer won't tell.
const rediscoverCheckable = p => !!(getConnector(p.connector).capabilities || {}).inventory && typeof getConnector(p.connector).getInventory === "function";

// Every saved printer, plus what each checkable one's saved address answers
// right now. Read-only: the same /machine/system_info the Inventory page asks.
app.get("/api/rediscover/printers", requireAdmin, async (req, res) => {
  const printers = PRINTERS.map(p => ({
    id: p.id, name: p.name, url: p.url, ip: p.ip || null, serial: p.serial || "", connector: p.connector,
    checkable: rediscoverCheckable(p), fixedHost: !!getAddress(p.connector).fixedHost,
  }));
  const live = {};
  await Promise.all(PRINTERS.filter(rediscoverCheckable).map(async p => {
    try {
      const r = await getConnector(p.connector).getInventory(p);
      live[p.id] = r && r.online ? { online: true, serial: r.serial || null, name: r.device_name || null } : { online: false };
    } catch { live[p.id] = { online: false }; }
  }));
  res.json({ printers, live });
});

// Applies a set of corrections at once, so a swap (two printers trading
// addresses) never passes through a state with one address on both. Each
// change names the values it was planned against (expect); a printer changed
// since the scan is refused rather than overwritten. The result may not give
// a changed field the same value as another printer's (Rediscover.conflicts),
// which is also what keeps a rename from breaking the slicer hook's lookup by
// name. Everything else on the record — id, history, maintenance, pool,
// tokens, settings — is the same object, untouched.
const REDISCOVER_SERIAL_RE = /^[A-Za-z0-9._-]{1,64}$/;
app.post("/api/rediscover/apply", requireAdmin, (req, res) => {
  const changes = Array.isArray(req.body && req.body.changes) ? req.body.changes : null;
  if (!changes || !changes.length || changes.length > 500) return res.status(400).json({ error: "No changes given" });
  if (CONFIG_LOAD_FAILED) return res.status(409).json({ error: "Config could not be read; not overwriting it" });
  const list = (CFG.printers || []).map(p => ({ ...p }));
  const clean = [];
  for (const c of changes) {
    const p = c && list.find(x => x.id === c.id);
    if (!p || !PRINTERS.some(x => x.id === p.id)) return res.status(400).json({ error: "Unknown printer" });
    if (clean.some(x => x.id === p.id)) return res.status(400).json({ error: "A printer is named twice" });
    if (!rediscoverCheckable(p)) return res.status(400).json({ error: p.name + " can't be checked this way" });
    const e = c.expect || {};
    if (e.url !== p.url || (e.serial || "") !== (p.serial || "") || e.name !== p.name) {
      return res.status(409).json({ error: p.name + " was changed after the scan. Run Rediscover again.", code: "stale" });
    }
    const one = { id: p.id };
    if (c.ip !== undefined) {
      const ip = String(c.ip || "").trim();
      if (!isValidHost(ip) || getAddress(p.connector).fixedHost) return res.status(400).json({ error: "Invalid address for " + p.name });
      one.ip = ip;
    }
    if (c.serial !== undefined) {
      const serial = String(c.serial || "").trim();
      if (!REDISCOVER_SERIAL_RE.test(serial)) return res.status(400).json({ error: "Invalid serial for " + p.name });
      one.serial = serial;
    }
    if (c.name !== undefined) {
      const name = String(c.name || "").trim();
      if (!name || name.length > 100 || /[\u0000-\u001f]/.test(name)) return res.status(400).json({ error: "Invalid name for " + p.name });
      one.name = name;
    }
    if (Object.keys(one).length === 1) return res.status(400).json({ error: "Nothing to change for " + p.name });
    clean.push(one);
  }
  // The address goes through the same composer a Settings save uses, so the
  // stored ip/port/scheme/url are exactly what saving the row would store.
  for (const c of clean) {
    const p = list.find(x => x.id === c.id);
    if (c.ip !== undefined) Object.assign(p, resolvePrinterAddress({ ...p, ip: c.ip }));
    if (c.serial !== undefined) p.serial = c.serial;
    if (c.name !== undefined) p.name = c.name;
  }
  const clash = Rediscover.conflicts(list, clean)[0];
  if (clash) {
    const me = list.find(x => x.id === clash.id), other = list.find(x => x.id === clash.other);
    const what = { address: "address", serial: "serial", name: "name" }[clash.field] || "identity";
    return res.status(409).json({ error: "That would give " + (me ? me.name : "a printer") + " the same " + what + " as " + (other ? other.name : "another printer") + ".", code: "duplicate" });
  }
  const before = new Map((CFG.printers || []).map(p => [p.id, p]));
  const prev = CFG.printers;
  CFG.printers = list;
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); }
  catch (e) { CFG.printers = prev; return res.status(500).json({ error: "Could not save: " + e.message }); }
  loadConfig();
  for (const c of clean) {
    const b = before.get(c.id), a = list.find(x => x.id === c.id);
    const detail = { source: "rediscover", changed: [] };
    if (c.ip !== undefined) { detail.changed.push("address"); detail.address = { from: b.url, to: a.url }; }
    if (c.serial !== undefined) detail.changed.push("serial");
    if (c.name !== undefined) { detail.changed.push("name"); detail.name = { from: b.name, to: a.name }; }
    auditLog.log({ category: "admin", event: "printer-identity-updated", ...actorFromReq(req), printerId: a.id, printerName: a.name, detail });
  }
  res.json({ ok: true, printers: publicCfg(req.user.role).printers });
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
  library.start();
  // Print history (M7, §9 D7): imported from the audit log a minute after
  // start, once the Library worker is up. Every run adds only what no Print
  // records yet, so this also fills in jobs from while the Library was down.
  setTimeout(() => importPrintHistory().catch(e => console.error("[library] print history import failed:", e.message)), 60 * 1000).unref();
  updateChecker.start();
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

  // Independent, unconditional deadline — scheduled up front, before any
  // cleanup, not nested inside the graceful path's .finally(). A .finally()
  // only ever runs once the promise it's attached to actually settles, so if
  // disableForShutdown() (or anything several layers beneath it — a subprocess
  // spawn with no timeout of its own, say) ever hung, the "bounded" exit would
  // silently stop being bounded at all. This timer fires no matter what.
  const forceExitTimer = setTimeout(() => process.exit(0), 8000);
  if (forceExitTimer.unref) forceExitTimer.unref();

  httpServer.close(); // stop accepting new connections; lets in-flight ones finish
  updateChecker.stop();

  // Fleet utilization stops first, as before, but asynchronously (at most 1 s,
  // the event loop free throughout); Remote Access and the Library then stop
  // as they always have.
  Promise.resolve().then(() => utilization.stop())
    .catch(e => console.error("[utilization] shutdown:", e.message))
    .then(() => Promise.all([
    Promise.resolve(remoteAccess.disableForShutdown()) // stop cloudflared only — token/config are retained so the next boot reconnects
      .catch(e => console.error("[remote-access] shutdown:", e.message)),
    library.stop().catch(e => console.error("[library] shutdown:", e.message)),
  ])).finally(() => { clearTimeout(forceExitTimer); process.exit(0); });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
