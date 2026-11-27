// routes/discover.js — GET /api/discover and its helpers, moved from server.js
// (docs/refactoring-policy.md; tools/refactor/manifests/discover.json).
// No "use strict": server.js runs in sloppy mode and the moved code keeps it.
// server.js requires this module and calls registerDiscoverRoutes() at the
// route's original position, so the order of the routes is unchanged. The
// constants and the functions that need nothing from server.js stay at module
// scope, text unchanged; discoverAt, discoverIp and the route live inside
// registerDiscoverRoutes, where requireAdmin and the connector registry are
// parameters. The module owns no mutable state.
const os = require("os");
// Used only to ask the OS which adapter carries the default route (see
// defaultRouteAddress) — no packets are ever sent.
const dgram = require("dgram");

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
// Interfaces that are not a LAN a printer could be sitting on: VPN tunnels and
// the virtual switches Docker, WSL, Hyper-V, VirtualBox and VMware create. Each
// one costs a full 254-address sweep and finds nothing, and every one of them
// ends up named in the "no printers found on …" message, which is how this was
// noticed: a machine reported scanning a VPN range (100.64.0.0/24 here) and a
// virtual switch (172.17.64.0/24) alongside its real LAN (192.168.20.0/24).
//
// Matching on the interface NAME rather than the address, because the address
// ranges these use (172.16.0.0/12 especially) are legitimate private networks
// somebody's real printers live on.
const SKIP_INTERFACE_RE = /^(vEthernet|vmnet|vboxnet|VirtualBox|VMware|Hyper-?V|docker|br-|veth|virbr|tailscale|ts\d|zt[a-z0-9]|ZeroTier|utun|tun\d|tap\d|wg\d|Bluetooth|Loopback|isatap|Teredo)/i;
// …and addresses that cannot be a LAN whatever the interface is called:
// carrier-grade NAT (100.64.0.0/10, which Tailscale hands out) and the
// link-local block a machine gives itself when DHCP fails.
const SKIP_ADDRESS_RE = /^(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/;

// The address this machine would use to reach the wider network — its own
// answer to "which adapter is my default route".
//
// A UDP socket is `connect`ed, which sends NOTHING on the wire: it only makes
// the OS consult its routing table and bind a local address, which is then read
// back. Cheap, needs no privileges, and works the same on every platform, where
// parsing `route print` / `ip route` output would not.
function defaultRouteAddress({ timeoutMs = 300 } = {}) {
  return new Promise(resolve => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.close(); } catch {} resolve(v); } };
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (timer.unref) timer.unref();
    let sock;
    try { sock = dgram.createSocket("udp4"); } catch { clearTimeout(timer); resolve(null); return; }
    sock.on("error", () => { clearTimeout(timer); finish(null); });
    try {
      // A public address that is never actually contacted; only the route to it
      // matters.
      sock.connect(53, "8.8.8.8", () => {
        clearTimeout(timer);
        let addr = null;
        try { addr = sock.address().address; } catch {}
        finish(addr && addr !== "0.0.0.0" ? addr : null);
      });
    } catch { clearTimeout(timer); finish(null); }
  });
}

// Which /24 to sweep, given the address the machine actually routes through.
//
// A hub can sit on two real networks at once — a second NIC, a lab VLAN, wifi
// still connected alongside ethernet — and sweeping both is slow and turns up
// printers on a network nobody asked about. The default route is the machine's
// own answer to "which of these is my network", so the scan follows it.
//
// Falls back to every real network when the routing answer is missing or points
// at something that is not a LAN (a full-tunnel VPN, an exit node): scanning
// them all is worse than scanning one, and much better than scanning nothing.
function scanSubnets(ifs = os.networkInterfaces(), sourceIp = null) {
  const all = localSubnets(ifs);
  if (!sourceIp) return all;
  const base = String(sourceIp).split(".").slice(0, 3).join(".");
  return all.includes(base) ? [base] : all;
}

// The /24s worth sweeping for printers. `ifs` is injectable so the choice can
// be tested against a real machine's interface list rather than this one's.
function localSubnets(ifs = os.networkInterfaces()) {
  const out = new Set();
  for (const name in ifs) for (const a of ifs[name] || []) {
    if (a.family !== "IPv4" || a.internal) continue;
    if (SKIP_INTERFACE_RE.test(name) || SKIP_ADDRESS_RE.test(a.address)) continue;
    // A /32 is a single host, not a network — scanning the 254 addresses around
    // it is a guess about somebody else's routing.
    if (a.netmask === "255.255.255.255") continue;
    out.add(a.address.split(".").slice(0, 3).join("."));
  }
  return [...out];
}
// Port 80 catches the common case (Fluidd/Mainsail/KIAUH nginx proxying
// straight to Moonraker) — but plenty of stock images (e.g. Creality's K1
// series) run Moonraker directly on its own default port 7125 with nothing
// on 80 at all. Try both so those aren't invisible to the scan.
const DISCOVER_PORTS = [80, 7125];

function registerDiscoverRoutes(app, { requireAdmin, getConnector, listConnectorTypes }) {
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

  // A sweep of 254 addresses takes long enough that a motionless "Scanning…" box
  // reads as a hang, so this streams: one JSON object per line (NDJSON), a
  // progress line after every batch and a final line carrying the result. The
  // client shows a real bar and can say what it has found before the sweep ends.
  //
  // Streaming rather than a job id and polling: a scan is worthless once the page
  // that asked for it has gone, so tying it to the request is exactly right — and
  // it needs no server-side registry to leak.
  app.get("/api/discover", requireAdmin, async (req, res) => {
    const found = [];
    let ips, labels;
    if (req.query.subnet) {
      const spec = parseSubnetSpec(req.query.subnet);
      if (spec.error) return res.status(400).json({ error: spec.error });
      ips = spec.ips;
      labels = [spec.label];
    } else {
      // The adapter this machine actually routes through, falling back to every
      // real network when that cannot be determined.
      const bases = scanSubnets(os.networkInterfaces(), await defaultRouteAddress());
      // Every interface was virtual or a VPN: there is no local network to sweep,
      // which is a different answer from "swept it and found nothing".
      if (!bases.length) {
        return res.status(400).json({
          error: "SnapCon could not find a local network to scan — every network adapter on this machine is a VPN or a virtual switch. Enter a subnet to scan, or add the printer by its address.",
          code: "no_local_network"
        });
      }
      ips = bases.flatMap(base => Array.from({ length: 254 }, (_, i) => base + "." + (i + 1)));
      labels = bases.map(b => b + ".0/24");
    }
    res.set("Content-Type", "application/x-ndjson");
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    const line = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };
    line({ subnets: labels, total: ips.length, scanned: 0 });
    // A browser that navigated away should not leave the scan running.
    let aborted = false;
    req.on("close", () => { aborted = true; });
    const B = 40;
    for (let i = 0; i < ips.length && !aborted; i += B) {
      const results = await Promise.all(ips.slice(i, i + B).map(discoverIp));
      results.forEach(r => { if (r) found.push(r); });
      line({ scanned: Math.min(i + B, ips.length), total: ips.length, found: found.length });
    }
    if (!aborted) line({ done: true, subnets: labels, found });
    res.end();
  });
}

// _internal: the test seam (the connectors' convention), used by
// test/helpers/discoverCode.js. server.js uses registerDiscoverRoutes only.
module.exports = { registerDiscoverRoutes,
  _internal: { ipToInt, intToIp, maskToPrefixLen, parseSubnetSpec, defaultRouteAddress, scanSubnets, localSubnets,
    MIN_SCAN_PREFIX, SKIP_INTERFACE_RE, SKIP_ADDRESS_RE, DISCOVER_PORTS } };
