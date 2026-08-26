// connectors/migratePrinterAddress.js — pure, no I/O. Splits a printer's
// single stored `url` into the two fields the user actually configures:
// `ip` (IP address or hostname) and, where the connector offers it, `port`.
//
// `url` stays and stays canonical — every connector's baseUrl() still reads
// it, and nothing else in the app had to learn about the split. This
// migration only fills in the inputs that url is now derived from.
//
// It is deliberately URL-preserving: for every address shape found in a real
// config (host-only, host:port, https, trailing slash) recomposing from the
// parts produces the identical string, so no printer's identity, offline
// cache key or save-time match moves underneath it. An explicit port is kept
// even on connectors that hide the port field, since a hand-edited config
// pointing at a non-standard port must keep working.
//
// Safe to run at every startup like the other migrations: a printer that
// already has `ip` is left alone, and so is one this module can't take apart
// confidently — those are reported through `issues` for the caller to log,
// never rewritten and never dropped.
const { getAddress } = require("./index");
const { parseAddressUrl, composeAddressUrl, isValidHost, normalizePort } = require("./address");

function migratePrinterAddressConfig(rawCfg) {
  const cfg = { ...rawCfg };
  const issues = [];
  if (!Array.isArray(cfg.printers)) return { cfg, changed: false, issues };

  let changed = false;
  const printers = cfg.printers.map(p => {
    if (!p || typeof p !== "object") return p;
    const spec = getAddress(p.connector);
    // Connectors with no hardware address (the simulator's synthetic
    // sim:// url) have nothing to split.
    if (!spec.required) return p;
    // Already migrated.
    if (isValidHost(p.ip)) return p;
    if (!String(p.url || "").trim()) return p;

    const parsed = parseAddressUrl(p.url);
    if (!parsed || !isValidHost(parsed.host)) {
      issues.push({ name: p.name || p.id || "", url: String(p.url) });
      return p;
    }

    const next = { ip: parsed.host };
    const port = normalizePort(parsed.port);
    if (port) next.port = port;
    // Only a scheme that differs from the connector's own is worth storing —
    // an https printer must stay https after this.
    if (parsed.scheme && parsed.scheme !== spec.scheme) next.scheme = parsed.scheme;
    const url = composeAddressUrl({ scheme: next.scheme || spec.scheme, host: next.host || parsed.host, port }, spec);

    changed = true;
    return withAddress(p, { ...next, url });
  });

  if (changed) cfg.printers = printers;
  return { cfg, changed, issues };
}

// Writes url/ip/port/scheme while keeping the printer's existing key order,
// with the new fields sitting next to `url` rather than tacked onto the end —
// config.json is a file people read and hand-edit.
function withAddress(p, fields) {
  const out = {};
  for (const k of Object.keys(p)) {
    if (k === "ip" || k === "port" || k === "scheme") continue;
    out[k] = k === "url" ? fields.url : p[k];
    if (k === "url") {
      out.ip = fields.ip;
      if (fields.port) out.port = fields.port;
      if (fields.scheme) out.scheme = fields.scheme;
    }
  }
  if (!("url" in p)) {
    out.url = fields.url;
    out.ip = fields.ip;
    if (fields.port) out.port = fields.port;
    if (fields.scheme) out.scheme = fields.scheme;
  }
  return out;
}

module.exports = { migratePrinterAddressConfig };
