// connectors/snapmaker-u1-klipper-ws.js — THE Snapmaker U1 connector. Same
// normalized status as connectors/snapmaker-u1-klipper.js (the original,
// unmodified), but sourced from a persistent Moonraker
// `printer.objects.subscribe` WebSocket instead of a fresh HTTP
// `printer.objects.query` on every probe(). HTTP remains the fallback —
// literally the original connector's own probe(), called as-is — whenever
// the WebSocket isn't healthy.
//
// Deliberately NOT merged into the original: every export below other than
// probe()/label/capabilities is a direct passthrough to
// connectors/snapmaker-u1-klipper.js, so there is exactly one implementation
// of everything except status acquisition. The status normalization logic IS
// duplicated (see normalizeU1State below) rather than extracted/shared, on
// purpose — this file must never require touching the original, which stays
// intact as the delegate underneath it and as the reference implementation.
//
// This connector replaced the original as the only selectable U1 connector:
// the original is no longer in the REGISTRY and existing configs naming it
// are rewritten here at startup (connectors/migrateU1Connector.js). The
// automatic HTTP fallback below — not a connector switch in Settings — is
// what covers a printer whose firmware the WebSocket path doesn't suit.
//
// Camera is completely out of scope here — getCameraSnapshot is re-exported
// from the existing connector unchanged, and this file never touches its
// WebSocket or shares a socket with it. The status WebSocket below is a
// second, independent connection.
const http = require("./http-utils");
const base = require("./snapmaker-u1-klipper");

exports.label = "SnapMaker U1";
exports.brand = "SnapMaker";
exports.capabilities = base.capabilities;

// ---- debug logging (per-message detail, off by default) ----
const DEBUG = /^(1|true)$/i.test(process.env.SNAPCON_U1WS_DEBUG || "");
function log(p, msg) { console.log(`[U1-Enhanced] ${p.name} ${msg}`); }
function debugLog(p, msg) { if (DEBUG) console.log(`[U1-Enhanced:debug] ${p.name} ${msg}`); }

// ---- status normalization — intentional duplicate of
// snapmaker-u1-klipper.js's probe() mapping (see file header for why) ----
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

// st is a raw Moonraker `status` dict — the same shape whether it came from
// printer.objects.query's result.status (HTTP) or the accumulated
// printer.objects.subscribe baseline + notify_status_update deltas (WS).
function normalizeU1State(p, st) {
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
}
exports._internal = { normalizeU1State, decodeHeads };

// ---- per-printer WebSocket status connection ----
const OBJECTS = {
  print_task_config: null, print_stats: null, display_status: null, virtual_sdcard: null,
  heater_bed: null, extruder: null, extruder1: null, extruder2: null, extruder3: null,
  fan: null, gcode_move: null, toolhead: null, exclude_object: null
};

const CONNECT_TIMEOUT_MS = 5000;
const SUBSCRIBE_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_TIMEOUT_MS = 8000;
const HEARTBEAT_MAX_MISSES = 2;
// Staleness is a passive safety net (in case the heartbeat mechanism itself
// somehow stalls — GC pause, laptop sleep/resume, clock skew) — the
// heartbeat's own miss-counter above is the active path that actually
// detects and recovers from a dead connection. Deliberately NOT "time since
// last real status delta": an idle printer can go a long time with zero
// field changes and still be perfectly healthy.
const STALE_MS = HEARTBEAT_INTERVAL_MS * 3;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const STARTUP_JITTER_MS = 2000;
const EVICT_AFTER_MS = 5 * 60 * 1000;
const EVICT_SWEEP_MS = 60 * 1000;

const connections = new Map(); // printer.id -> Conn

function newConn(p) {
  return {
    url: p.url,
    ws: null,
    connectionState: "disconnected", // disconnected | connecting | subscribing | ready | backoff
    rawState: {},
    haveBaseline: false,
    lastMessageAt: 0,
    lastHeartbeatAt: 0,
    lastProbedAt: Date.now(),
    reconnectAttempts: 0,
    reconnectTimer: null,
    connectTimer: null,
    heartbeatTimer: null,
    heartbeatMisses: 0,
    nextRpcId: 1,
    pendingRpc: new Map()
  };
}

function rejectAllPending(c, err) {
  for (const pending of c.pendingRpc.values()) pending.reject(err);
  c.pendingRpc.clear();
}

function sendRpc(c, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!c.ws) { reject(new Error("not connected")); return; }
    const id = c.nextRpcId++;
    const timer = setTimeout(() => { c.pendingRpc.delete(id); reject(new Error("RPC timeout: " + method)); }, timeoutMs);
    if (timer.unref) timer.unref();
    c.pendingRpc.set(id, {
      resolve: r => { clearTimeout(timer); resolve(r); },
      reject: e => { clearTimeout(timer); reject(e); }
    });
    try { c.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id })); }
    catch (e) { clearTimeout(timer); c.pendingRpc.delete(id); reject(e); }
  });
}

// Moonraker sends only the fields that actually changed, per object — merge
// one level into the existing object rather than replacing it, so an
// {extruder:{temperature:220.1}} delta can't wipe out extruder.target. A
// field's own value (including array fields like filament_color_rgba) is
// always replaced wholesale when present, never merged further — Klipper
// reports at field granularity, not into individual array elements.
function mergeStatusDelta(target, delta) {
  for (const objName of Object.keys(delta)) {
    if (!target[objName] || typeof target[objName] !== "object") target[objName] = {};
    Object.assign(target[objName], delta[objName]);
  }
  return target;
}

function stopHeartbeat(c) {
  if (c.heartbeatTimer) { clearInterval(c.heartbeatTimer); c.heartbeatTimer = null; }
}

function startHeartbeat(p, c) {
  stopHeartbeat(c);
  c.heartbeatMisses = 0;
  c.heartbeatTimer = setInterval(() => {
    sendRpc(c, "server.info", {}, HEARTBEAT_TIMEOUT_MS)
      .then(() => { c.heartbeatMisses = 0; c.lastHeartbeatAt = Date.now(); })
      .catch(e => {
        c.heartbeatMisses++;
        debugLog(p, "heartbeat miss " + c.heartbeatMisses + " (" + e.message + ")");
        if (c.heartbeatMisses >= HEARTBEAT_MAX_MISSES) {
          log(p, "status WebSocket unresponsive, reconnecting");
          try { c.ws && c.ws.close(); } catch {}
        }
      });
  }, HEARTBEAT_INTERVAL_MS);
  if (c.heartbeatTimer.unref) c.heartbeatTimer.unref();
}

function handleMessage(p, c, ev) {
  c.lastMessageAt = Date.now();
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id != null && c.pendingRpc.has(msg.id)) {
    const pending = c.pendingRpc.get(msg.id);
    c.pendingRpc.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message || "RPC error"));
    else pending.resolve(msg.result);
    return;
  }
  if (msg.method === "notify_status_update" && Array.isArray(msg.params)) {
    debugLog(p, "status delta: " + JSON.stringify(msg.params[0]));
    mergeStatusDelta(c.rawState, msg.params[0] || {});
  }
  // Other notifications (notify_klippy_ready, notify_proc_stat_update, ...)
  // are received but ignored — this connection is status-only.
}

function scheduleReconnect(p, c) {
  if (c.reconnectTimer) return; // one attempt in flight at a time
  const attempt = c.reconnectAttempts++;
  const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * Math.max(1, backoff * 0.2));
  c.reconnectTimer = setTimeout(() => { c.reconnectTimer = null; connect(p, c); }, backoff + jitter);
  if (c.reconnectTimer.unref) c.reconnectTimer.unref();
}

function subscribe(p, c) {
  sendRpc(c, "printer.objects.subscribe", { objects: OBJECTS }, SUBSCRIBE_TIMEOUT_MS)
    .then(result => {
      // A fresh baseline, always — after a reconnect this replaces whatever
      // was accumulated before, rather than resuming deltas on top of
      // possibly-stale state from before the gap.
      c.rawState = (result && result.status) || {};
      c.haveBaseline = true;
      c.connectionState = "ready";
      c.reconnectAttempts = 0;
      c.lastMessageAt = Date.now();
      c.lastHeartbeatAt = Date.now();
      log(p, "status subscription ready");
      startHeartbeat(p, c);
    })
    .catch(e => {
      debugLog(p, "subscribe failed: " + e.message);
      try { c.ws && c.ws.close(); } catch {}
    });
}

function connect(p, c) {
  if (c.connectionState === "connecting" || c.connectionState === "subscribing") return; // already in flight
  if (typeof WebSocket === "undefined") { debugLog(p, "no global WebSocket available (Node <21) — staying on HTTP"); return; }
  c.connectionState = "connecting";
  c.haveBaseline = false;
  let ip;
  try { ip = new URL(http.baseUrl(p)).hostname; }
  catch { c.connectionState = "disconnected"; scheduleReconnect(p, c); return; }
  const token = p.token || "";
  const wsUrl = `ws://${ip}/websocket${token ? "?token=" + encodeURIComponent(token) : ""}`;
  let ws;
  try { ws = new WebSocket(wsUrl); }
  catch { c.connectionState = "disconnected"; scheduleReconnect(p, c); return; }
  c.ws = ws;
  const connectTimer = setTimeout(() => {
    if (c.connectionState !== "ready") { debugLog(p, "connect timeout"); try { ws.close(); } catch {} }
  }, CONNECT_TIMEOUT_MS);
  if (connectTimer.unref) connectTimer.unref();
  ws.onopen = () => {
    clearTimeout(connectTimer);
    log(p, "status WebSocket connected");
    c.connectionState = "subscribing";
    subscribe(p, c);
  };
  ws.onmessage = ev => handleMessage(p, c, ev);
  ws.onerror = () => debugLog(p, "status WebSocket error");
  ws.onclose = () => {
    clearTimeout(connectTimer);
    const wasReady = c.connectionState === "ready";
    c.ws = null;
    c.haveBaseline = false;
    stopHeartbeat(c);
    rejectAllPending(c, new Error("socket closed"));
    if (wasReady) log(p, "status WebSocket disconnected, falling back to HTTP");
    c.connectionState = "backoff";
    scheduleReconnect(p, c);
  };
}

function teardown(c) {
  if (c.connectTimer) { clearTimeout(c.connectTimer); c.connectTimer = null; }
  if (c.reconnectTimer) { clearTimeout(c.reconnectTimer); c.reconnectTimer = null; }
  stopHeartbeat(c);
  rejectAllPending(c, new Error("connection torn down"));
  if (c.ws) {
    try { c.ws.onopen = c.ws.onmessage = c.ws.onerror = c.ws.onclose = null; c.ws.close(); } catch {}
    c.ws = null;
  }
  c.connectionState = "disconnected";
  c.haveBaseline = false;
}

// A printer that stops being probed through THIS connector — removed from
// config entirely, or switched back to the plain HTTP connector for A/B
// testing — just stops showing up in ensureConn() calls. This sweep is what
// actually closes its socket; no explicit removal hook from server.js needed.
let evictionStarted = false;
function ensureEvictionSweep() {
  if (evictionStarted) return;
  evictionStarted = true;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, c] of connections) {
      if (now - c.lastProbedAt > EVICT_AFTER_MS) {
        debugLog({ name: id }, "evicting — not probed in over " + Math.round(EVICT_AFTER_MS / 60000) + "m");
        teardown(c);
        connections.delete(id);
      }
    }
  }, EVICT_SWEEP_MS);
  // Never keep the process alive just for this sweep — matters for tests,
  // `node --check`, and the --load/--snapcon one-shot CLI mode, none of
  // which should hang just because this module got required.
  if (timer.unref) timer.unref();
}
ensureEvictionSweep();

function ensureConn(p) {
  let c = connections.get(p.id);
  if (!c) {
    c = newConn(p);
    connections.set(p.id, c);
    // Small randomized startup delay — a farm of many U1s shouldn't all dial
    // their first status WebSocket in the same instant.
    c.connectTimer = setTimeout(() => connect(p, c), Math.floor(Math.random() * STARTUP_JITTER_MS));
    if (c.connectTimer.unref) c.connectTimer.unref();
  } else if (c.url !== p.url) {
    // Same printer id, address changed under it — the open socket (if any)
    // is talking to the wrong host now.
    debugLog(p, "printer URL changed, reconnecting");
    teardown(c);
    c.url = p.url;
    c.connectTimer = setTimeout(() => connect(p, c), 200);
    if (c.connectTimer.unref) c.connectTimer.unref();
  }
  c.lastProbedAt = Date.now();
  return c;
}

function isHealthy(c) {
  if (c.connectionState !== "ready" || !c.haveBaseline) return false;
  if (c.lastHeartbeatAt && (Date.now() - c.lastHeartbeatAt) > STALE_MS) return false;
  return true;
}

async function probe(p) {
  const c = ensureConn(p);
  if (isHealthy(c)) return normalizeU1State(p, c.rawState);
  return base.probe(p);
}
exports.probe = probe;

// ---- everything else: reuse the existing, known-good connector's
// implementation directly — this experiment is status-acquisition only ----
exports.uploadFile = base.uploadFile;
exports.startPrintFile = base.startPrintFile;
exports.pause = base.pause;
exports.resume = base.resume;
exports.cancel = base.cancel;
exports.eject = base.eject;
exports.estop = base.estop;
exports.bedTemp = base.bedTemp;
exports.applyHeadMapping = base.applyHeadMapping;
exports.unloadFilament = base.unloadFilament;
exports.setFilamentColor = base.setFilamentColor;
exports.getPlate = base.getPlate;
exports.excludeObject = base.excludeObject;
exports.listFiles = base.listFiles;
exports.getThumbnail = base.getThumbnail;
exports.getFileMetadata = base.getFileMetadata;
exports.getFirmwareInfo = base.getFirmwareInfo;
exports.getHealth = base.getHealth;
exports.querySyncFiles = base.querySyncFiles;
exports.downloadSyncFile = base.downloadSyncFile;
exports.deleteSyncFile = base.deleteSyncFile;
exports.getCameraSnapshot = base.getCameraSnapshot; // camera is explicitly out of scope — untouched
exports.getInventory = base.getInventory;
exports.discoverAt = base.discoverAt;
