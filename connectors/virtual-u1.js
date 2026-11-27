// connectors/virtual-u1.js — the Virtual U1: a simulated Snapmaker U1 for
// trying SnapCon without a real printer, one per printer configured with it.
//
// Each printer of this type gets its own simulator (fixtures/virtual-u1, the
// same one the U1 tests use) on 127.0.0.1 and the printer's port, started the
// first time SnapCon calls the printer. SnapCon then talks to it over HTTP and
// WebSocket through the real U1 connector (snapmaker-u1-klipper-ws.js),
// unchanged: every function here hands straight to it, so what runs against
// a Virtual U1 is exactly the code that runs against a real one.
//
// Per printer: port, firmware (a capture folder: "1.6.0", "2.0.0") and timing
// ("fast" skips every wait and prints 10x faster, "real" takes a real U1's
// time; see SPEED). A file sent to it prints as the file says: its
// temperatures, colours, layers, time and objects (fixtures/virtual-u1/
// slicedFile.js). A
// change to any of them restarts that printer's simulator. Its state lives in
// memory: restarting SnapCon resets it to idle with its sample files, as the
// Simulator does.
//
// A virtual printer: shown only while Settings › General › Enable virtual
// printers is on (connectors/index.js isVirtualType).
const u1 = require("./snapmaker-u1-klipper-ws");
const { startVirtualU1, availableFirmware } = require("../fixtures/virtual-u1");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 7125;
const TIMINGS = ["fast", "real"];
// Fast: every wait (heating, tool changes, pause, resume, cancel) is done at
// once, and the print itself runs 10 times faster than the file's time.
// Real: the file's time, and a real U1's waits.
const SPEED = { fast: { printSpeed: 10, instantHeat: true }, real: {} };
// A port that would not open is tried again after this, not on every poll.
const RETRY_MS = 10 * 1000;
// A simulator no call has reached for this long belongs to a printer that was
// removed, changed type or hidden: it is closed and its port freed. Calls
// arrive every few seconds while the printer is shown (the fleet poll).
const IDLE_CLOSE_MS = 2 * 60 * 1000;

exports.label = "Virtual U1";
// The machine it simulates: a U1 file matches it exactly as it matches a real
// U1 (the Send dialog compares brand, then family). The fleet card says it is
// virtual from the row's `virtual` flag instead.
exports.brand = u1.brand;
exports.virtual = true;
exports.printerFamily = u1.printerFamily;
// A U1's, less what has no meaning on a simulator: finding printers on the
// network, and deploying firmware to one.
exports.capabilities = { ...u1.capabilities, discovery: false, firmwareDeploy: false };
// Always on this machine, so only the port is the user's to set.
exports.address = { scheme: "http", defaultPort: DEFAULT_PORT, portEditable: true, required: true, fixedHost: HOST };

// The per-printer choices Settings offers (Firmware, Timing), and the only
// values buildPrinterRecord in server.js stores.
exports.virtualOptions = { firmware: availableFirmware(), timing: TIMINGS };

// The simulator settings a printer asks for, with defaults.
function settingsOf(p) {
  let port = parseInt(p.port, 10);
  if (!(port >= 1 && port <= 65535)) { try { port = parseInt(new URL(p.url).port, 10); } catch { port = NaN; } }
  if (!(port >= 1 && port <= 65535)) port = DEFAULT_PORT;
  const versions = exports.virtualOptions.firmware;
  const firmware = versions.includes(p.virtualFirmware) ? p.virtualFirmware : versions[versions.length - 1];
  const timing = TIMINGS.includes(p.virtualTiming) ? p.virtualTiming : "fast";
  return { port, firmware, timing };
}

// One simulator per port: port -> { key, owner, sim, starting, error,
// failedAt, lastUsed }. Keyed by port, not printer, so Settings' Test
// connection (a row with no saved id yet) reaches the same simulator the
// saved printer runs, instead of a second one failing on its port.
const sims = new Map();

function closeSim(port) {
  const s = sims.get(port);
  sims.delete(port);
  if (s && s.sim) s.sim.close().catch(() => {});
}

// Starts the simulator on this printer's port if none runs, or restarts it if
// the printer's firmware or timing changed. Resolves to null once it runs, or
// to the reason it does not — the port held by something else, or by another
// Virtual U1 — which callers report rather than talking to whatever answers
// on that port.
async function ensure(p) {
  const want = settingsOf(p);
  const key = `${want.firmware}|${want.timing}`;
  const now = Date.now();
  let s = sims.get(want.port);
  if (s && s.owner && p.id && s.owner.id !== p.id && now - s.lastUsed < IDLE_CLOSE_MS) {
    return `Port ${want.port} is used by another Virtual U1 (${s.owner.name}). Give each Virtual U1 its own port.`;
  }
  // The owner's settings changed, or the port passes to this printer: start
  // afresh. A call with no id (Test connection) uses whatever runs.
  if (s && !s.starting && p.id && (s.key !== key || (s.owner && s.owner.id !== p.id))) { closeSim(want.port); s = null; }
  if (!s) { s = { key }; sims.set(want.port, s); }
  if (p.id && !s.owner) s.owner = { id: p.id, name: p.name };
  if (p.id) s.lastUsed = now;
  else if (!s.lastUsed) s.lastUsed = now;
  if (s.starting) await s.starting;
  if (s.sim) return null;
  if (s.failedAt && now - s.failedAt < RETRY_MS) return s.error;
  s.starting = startVirtualU1({ port: want.port, firmware: want.firmware, timing: want.timing, clock: true, ...SPEED[want.timing] })
    .then(sim => { s.sim = sim; s.error = null; s.failedAt = 0; },
          e => {
            s.error = e && e.code === "EADDRINUSE"
              ? `Port ${want.port} is already in use on this machine. Choose another port for this Virtual U1.`
              : `The Virtual U1 could not start: ${e && e.message}`;
            s.failedAt = Date.now();
          })
    .finally(() => { s.starting = null; });
  await s.starting;
  // Replaced while it was starting (its settings changed meanwhile).
  if (sims.get(want.port) !== s) { if (s.sim) s.sim.close().catch(() => {}); return "The Virtual U1 is restarting."; }
  return s.sim ? null : s.error;
}

// The printer as the U1 connector sees it: always this machine, its port.
function target(p) {
  const { port } = settingsOf(p);
  return { ...p, ip: HOST, port, url: `http://${HOST}:${port}` };
}

exports.probe = async p => {
  const err = await ensure(p);
  if (err) return { name: p.name, online: false, error: err };
  return u1.probe(target(p));
};

// Not printer calls: passed through as they are.
const PASS_THROUGH = new Set(["probe", "findFilamentMaterial", "discoverAt"]);
for (const [name, value] of Object.entries(u1)) {
  if (name in exports || PASS_THROUGH.has(name)) continue;
  if (typeof value !== "function") { exports[name] = value; continue; }
  exports[name] = async (p, ...args) => {
    const err = await ensure(p);
    if (err) throw new Error(err);
    return value(target(p), ...args);
  };
}
exports.findFilamentMaterial = u1.findFilamentMaterial;

function closeIdle(now = Date.now()) {
  for (const [port, s] of sims) if (!s.starting && now - s.lastUsed > IDLE_CLOSE_MS) closeSim(port);
}
const sweep = setInterval(closeIdle, 30 * 1000);
// Never keeps the process alive by itself (tests, the --load CLI mode).
if (sweep.unref) sweep.unref();

// For tests: close every simulator now.
exports._closeAll = () => { for (const port of [...sims.keys()]) closeSim(port); };
exports._sims = sims;
exports._closeIdle = closeIdle;
exports._IDLE_CLOSE_MS = IDLE_CLOSE_MS;
