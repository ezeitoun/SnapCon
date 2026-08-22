// connectors/migrateU1Connector.js — pure, no I/O. One-time schema migration
// retiring the original Snapmaker U1 connector ("snapmaker-u1-klipper") in
// favor of the WebSocket one ("snapmaker-u1-klipper-ws"), which became the
// only selectable U1 connector (see connectors/index.js's REGISTRY comment).
//
// Only the `connector` string moves. Ids, names, URLs, tokens, serials, pool
// assignments and every other field are preserved verbatim — an upgrade must
// never detach a printer from its history, its group access, or its queue.
//
// Safe on an already-migrated or brand-new config: with no printer naming the
// old connector this is a no-op (changed stays false), which is what lets
// server.js run it unconditionally at every startup like the other
// migrations rather than tracking a "have I run yet" flag.
//
// Why this is safe to apply silently: snapmaker-u1-klipper-ws.js re-exports
// the original's `capabilities` object itself and passes every control
// function (upload, print start, pause, e-stop, head mapping, camera, file
// sync) straight through to it. The only behavioral difference is where
// status comes from, and when its WebSocket isn't healthy it calls the
// original's own probe() as-is. The worst case for a migrated printer is
// therefore exactly the behavior it had before.
const OLD_TYPE = "snapmaker-u1-klipper";
const NEW_TYPE = "snapmaker-u1-klipper-ws";

function migrateU1ConnectorConfig(rawCfg) {
  const cfg = { ...rawCfg };
  let changed = false;

  // Rebuild the array only when something actually moves — an untouched
  // config must come back out with the very same objects it went in with,
  // not equal-looking copies, since server.js re-points its module-level
  // PRINTERS at whatever this returns.
  if (Array.isArray(cfg.printers) && cfg.printers.some(p => p && p.connector === OLD_TYPE)) {
    changed = true;
    cfg.printers = cfg.printers.map(p => (p && p.connector === OLD_TYPE ? { ...p, connector: NEW_TYPE } : p));
  }

  return { cfg, changed };
}

module.exports = { migrateU1ConnectorConfig, OLD_TYPE, NEW_TYPE };
