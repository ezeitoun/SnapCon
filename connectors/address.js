// connectors/address.js — pure address helpers, no I/O. SnapCon stores a
// printer's canonical `url`, but the user configures an IP/hostname and (on
// connectors where it's meaningful) a port. These functions are the single
// place that converts between the two, shared by the startup migration
// (connectors/migratePrinterAddress.js), the config save path in server.js,
// and the Settings UI's validation rules.
//
// The one rule everything here exists to protect: a stored URL that works
// today must still be the exact same string after parsing and recomposing
// it. That is why an explicit port is preserved even on connectors that
// don't offer a port field, and why a URL this module can't confidently
// take apart is reported rather than rewritten.

// Hostname or IPv4 literal. Deliberately rejects anything carrying a scheme,
// a path, a port, credentials or whitespace — those belong to the URL, not
// to the address field the user types into.
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;
// Bracketed IPv6 literal, as it appears inside a URL's authority.
const IPV6_RE = /^\[[0-9A-Fa-f:.]{2,45}\]$/;

function isValidHost(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return false;
  return IPV6_RE.test(s) || HOST_RE.test(s);
}

function isValidPort(v) {
  if (v === null || v === undefined || v === "") return false;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

// Normalizes whatever the client or config.json holds into a port number, or
// null for "not set" — which is a real state, not an error: a printer whose
// URL never carried a port keeps working exactly as it did, on the scheme's
// implicit port or on whatever port the connector applies itself.
function normalizePort(v) {
  return isValidPort(v) ? Number(v) : null;
}

// Splits a stored/legacy URL into its parts, or returns null when the value
// isn't something we can put back together again losslessly (a path, a
// query, credentials, garbage). null means "leave this printer's url alone".
function parseAddressUrl(url) {
  const raw = String(url == null ? "" : url).trim().replace(/\/+$/, "");
  if (!raw) return null;
  let u = null;
  try { u = new URL(raw); } catch { u = null; }
  if (u && u.hostname) {
    // Anything beyond scheme://host[:port] would be dropped by
    // composeAddressUrl(), so it isn't ours to migrate.
    if ((u.pathname && u.pathname !== "/") || u.search || u.hash || u.username || u.password) return null;
    return { scheme: u.protocol.replace(/:$/, ""), host: u.hostname, port: u.port ? Number(u.port) : null };
  }
  // A bare "host" or "host:port" with no scheme at all. `new URL` either
  // throws on these or reads the hostname as a scheme, so they land here.
  const m = /^([A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(raw);
  if (m && (!m[3] || isValidPort(m[3]))) return { scheme: null, host: m[1], port: m[3] ? Number(m[3]) : null };
  return null;
}

// Builds the canonical URL SnapCon stores and every connector's baseUrl()
// reads. The port is written only when one is actually set: connectors with
// a fixed port (the U1's 80, FlashForge's 8898) leave it out and let the
// connector apply its own, which is what keeps existing configs byte-for-
// byte identical through this migration.
function composeAddressUrl(addr, spec) {
  const host = String((addr && addr.host) || "").trim();
  if (!host) return "";
  const scheme = (addr && addr.scheme) || (spec && spec.scheme) || "http";
  const port = normalizePort(addr && addr.port);
  return scheme + "://" + host + (port ? ":" + port : "");
}

module.exports = { isValidHost, isValidPort, normalizePort, parseAddressUrl, composeAddressUrl, HOST_RE, IPV6_RE };
