// test/discoverBehaviour.test.js — behavior pins for GET /api/discover and its
// helpers, written BEFORE any refactoring (docs/refactoring-policy.md §3.1)
// for the behaviors no test covered (2026-11-16):
//   1. authentication: the route sits behind requireAdmin, which runs first;
//   2. the subnet argument (parseSubnetSpec) and its address arithmetic;
//   3. which local networks are swept (the /32 rule on its own; the route's
//      "no local network" answer);
//   4. probing: every connector that can fingerprint, ports 80 then 7125,
//      first hit wins, a failing connector does not stop the next;
//   5. the streamed answer: headers, the initial / progress / done records;
//   6. a browser that goes away stops the sweep;
//   7. the route lookup (defaultRouteAddress): its deadline and its socket.
// test/discoverySubnets.test.js keeps the interface-selection cases. Real
// HTTP, authentication and the stream on the wire are pinned by the contract
// harness (tools/refactor/harness). Loads the code through
// test/helpers/discoverCode.js — only that loader may change when the code moves.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadDiscoverCode, fakeDgram } = require("./helpers/discoverCode");

const plain = o => JSON.parse(JSON.stringify(o));
const LAN = { "Ethernet 3": [{ family: "IPv4", internal: false, address: "192.168.20.151", netmask: "255.255.255.0" }] };
const VIRTUAL_ONLY = {
  "Tailscale": [{ family: "IPv4", internal: false, address: "100.64.0.80", netmask: "255.255.255.255" }],
  "vEthernet (Default Switch)": [{ family: "IPv4", internal: false, address: "172.17.64.1", netmask: "255.255.240.0" }],
  "Loopback Pseudo-Interface 1": [{ family: "IPv4", internal: true, address: "127.0.0.1", netmask: "255.0.0.0" }],
};
// A connector that records every base URL it is asked about and "finds" a
// printer at the ones listed in `hits` ({ base: hit }).
// `onFirst` runs once, inside the first probe (used to close the request
// while the first batch is in flight).
function connector(hits = {}, { throws = false, onFirst = null } = {}) {
  const asked = [];
  return { asked, discoverAt: async base => { asked.push(base); if (onFirst && asked.length === 1) onFirst(); if (throws) throw new Error("boom"); return hits[base] || null; } };
}

// ---------- 1. authentication ----------
test("1. GET /api/discover is registered with requireAdmin as its only middleware, before the handler", () => {
  const requireAdmin = (req, res, next) => next();
  const d = loadDiscoverCode({ requireAdmin });
  assert.equal(d.route.method, "GET");
  assert.equal(d.route.handlers.length, 2);
  assert.equal(d.route.handlers[0], requireAdmin);
});
test("1. when requireAdmin refuses, the handler never runs (nothing is probed, no route lookup)", async () => {
  const c = connector();
  const d = loadDiscoverCode({ connectors: { a: c }, interfaces: LAN, requireAdmin: (req, res) => res.status(403).json({ error: "Admin only" }) });
  const r = await d.call({ subnet: "10.0.0.0/30" }, { user: { role: "view" } });
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: "Admin only" });
  assert.deepEqual(c.asked, []);
  assert.equal(d.dgram.sockets.length, 0);
  assert.deepEqual(r.lines, []);
});

// ---------- 2. the subnet argument ----------
test("2. a bare x.x.x.0 is the whole /24: .1 to .254", () => {
  const { parseSubnetSpec } = loadDiscoverCode().internal;
  const s = plain(parseSubnetSpec(" 192.168.1.0 "));
  assert.equal(s.label, "192.168.1.0/24");
  assert.equal(s.ips.length, 254);
  assert.equal(s.ips[0], "192.168.1.1");
  assert.equal(s.ips[253], "192.168.1.254");
});
test("2. CIDR: the network is derived from an unaligned address, and the block includes both boundary addresses", () => {
  const { parseSubnetSpec } = loadDiscoverCode().internal;
  const s = plain(parseSubnetSpec("192.168.22.130/25"));
  assert.equal(s.label, "192.168.22.128/25");
  assert.equal(s.ips.length, 128);
  assert.equal(s.ips[0], "192.168.22.128");
  assert.equal(s.ips[127], "192.168.22.255");
  assert.deepEqual(plain(parseSubnetSpec("10.0.0.0/30")), { ips: ["10.0.0.0", "10.0.0.1", "10.0.0.2", "10.0.0.3"], label: "10.0.0.0/30" });
  assert.deepEqual(plain(parseSubnetSpec("200.100.50.77/32")), { ips: ["200.100.50.77"], label: "200.100.50.77/32" });
});
test("2. a dotted mask is accepted when contiguous and refused when not", () => {
  const { parseSubnetSpec, maskToPrefixLen } = loadDiscoverCode().internal;
  assert.equal(plain(parseSubnetSpec("192.168.22.128/255.255.255.128")).label, "192.168.22.128/25");
  assert.equal(maskToPrefixLen("255.255.240.0"), 20);
  assert.equal(maskToPrefixLen("255.0.255.0"), null);
  assert.deepEqual(plain(parseSubnetSpec("192.168.22.128/255.0.255.0")), { error: "Invalid prefix length or subnet mask after the /" });
});
test("2. the largest block that may be swept is a /20 (4096 addresses); anything larger is refused by name", () => {
  const { parseSubnetSpec, MIN_SCAN_PREFIX } = loadDiscoverCode().internal;
  assert.equal(MIN_SCAN_PREFIX, 20);
  const ok = plain(parseSubnetSpec("10.1.16.0/20"));
  assert.equal(ok.ips.length, 4096);
  assert.equal(ok.label, "10.1.16.0/20");
  assert.deepEqual(plain(parseSubnetSpec("10.1.0.0/19")), { error: "Subnet too large to scan — use /20 or smaller (max 4096 addresses)" });
  assert.deepEqual(plain(parseSubnetSpec("10.0.0.0/8")), { error: "Subnet too large to scan — use /20 or smaller (max 4096 addresses)" });
});
test("2. nonsense is refused with the message for its kind", () => {
  const { parseSubnetSpec } = loadDiscoverCode().internal;
  assert.deepEqual(plain(parseSubnetSpec("nonsense")), { error: "Invalid subnet. Expected x.x.x.0, or CIDR like 192.168.1.0/24" });
  assert.deepEqual(plain(parseSubnetSpec("192.168.1.300")), { error: "Invalid subnet. Expected x.x.x.0, or CIDR like 192.168.1.0/24" });
  assert.deepEqual(plain(parseSubnetSpec("192.168.1/24")), { error: "Invalid IP address before the /" });
  assert.deepEqual(plain(parseSubnetSpec("192.168.1.0/33")), { error: "Invalid prefix length or subnet mask after the /" });
});
test("2. address arithmetic holds above 128.0.0.0 (no signed 32-bit overflow)", () => {
  const { ipToInt, intToIp } = loadDiscoverCode().internal;
  assert.equal(ipToInt("192.168.20.151"), 3232240791);
  assert.equal(intToIp(3232240791), "192.168.20.151");
  assert.equal(intToIp(ipToInt("255.255.255.255")), "255.255.255.255");
  assert.equal(ipToInt("256.1.1.1"), null);
  assert.equal(ipToInt("1.2.3"), null);
});

// ---------- 3. which networks ----------
test("3. a /32 address is one host, not a network — whatever the adapter is called", () => {
  const { localSubnets } = loadDiscoverCode().internal;
  const ifs = { "eth1": [{ family: "IPv4", internal: false, address: "203.0.113.5", netmask: "255.255.255.255" }] };
  assert.deepEqual(plain(localSubnets(ifs)), []);
  assert.deepEqual(plain(localSubnets({ "eth1": [{ ...ifs.eth1[0], netmask: "255.255.255.0" }] })), ["203.0.113"], "the same adapter with a real mask is swept");
});
test("3. carrier-grade NAT (100.64.0.0/10) and link-local (169.254.0.0/16) addresses are never a LAN — whatever the adapter is called and whatever its mask", () => {
  const { localSubnets } = loadDiscoverCode().internal;
  const one = address => ({ "Ethernet 9": [{ family: "IPv4", internal: false, address, netmask: "255.255.255.0" }] });
  for (const a of ["100.64.0.1", "100.100.5.2", "100.127.255.254", "169.254.10.20"]) assert.deepEqual(plain(localSubnets(one(a))), [], a);
  assert.deepEqual(plain(localSubnets(one("100.63.255.1"))), ["100.63.255"], "just below the CGNAT block is an ordinary network");
  assert.deepEqual(plain(localSubnets(one("100.128.0.1"))), ["100.128.0"], "just above it too");
  assert.deepEqual(plain(localSubnets(one("172.17.64.1"))), ["172.17.64"], "a private range is skipped by adapter name only, never by address");
});
test("3. no local network to sweep: 400 with code no_local_network, and nothing is probed", async () => {
  const c = connector();
  const d = loadDiscoverCode({ connectors: { a: c }, interfaces: VIRTUAL_ONLY });
  const r = await d.call({});
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, {
    error: "SnapCon could not find a local network to scan — every network adapter on this machine is a VPN or a virtual switch. Enter a subnet to scan, or add the printer by its address.",
    code: "no_local_network" });
  assert.deepEqual(c.asked, []);
  assert.deepEqual(r.lines, []);
});
test("3. an invalid subnet argument is a 400 with the parser's message, before any stream starts", async () => {
  const d = loadDiscoverCode({ interfaces: LAN });
  const r = await d.call({ subnet: "10.0.0.0/8" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "Subnet too large to scan — use /20 or smaller (max 4096 addresses)" });
  assert.equal(r.headers["Content-Type"], undefined);
  assert.equal(d.dgram.sockets.length, 0, "an explicit subnet never asks for the default route");
});

// ---------- 4. probing ----------
test("4. every address is tried on port 80 (bare URL) and then 7125; a printer answering only on 7125 is found", async () => {
  const c = connector({ "http://10.0.0.2:7125": { url: "http://10.0.0.2:7125", device_name: "K1", machine_type: "K1", serial: null, mac: null } });
  const d = loadDiscoverCode({ connectors: { creality: c } });
  const r = await d.call({ subnet: "10.0.0.0/30" });
  assert.deepEqual([...c.asked].sort(), ["http://10.0.0.0", "http://10.0.0.0:7125", "http://10.0.0.1", "http://10.0.0.1:7125",
    "http://10.0.0.2", "http://10.0.0.2:7125", "http://10.0.0.3", "http://10.0.0.3:7125"]);
  assert.ok(c.asked.indexOf("http://10.0.0.2") < c.asked.indexOf("http://10.0.0.2:7125"), "port 80 first");
  assert.deepEqual(r.lines[r.lines.length - 1].found,
    [{ ip: "10.0.0.2", url: "http://10.0.0.2:7125", device_name: "K1", machine_type: "K1", serial: null, mac: null, connector: "creality" }]);
});
test("4. connectors are asked in registry order; one without discoverAt is skipped; the first hit wins and ends the search for that address", async () => {
  const first = connector({ "http://10.0.0.1": { url: "http://10.0.0.1", device_name: "U1", machine_type: "U1", serial: "S1", mac: "aa" } });
  const second = connector({ "http://10.0.0.1": { url: "http://10.0.0.1", device_name: "other" } });
  const d = loadDiscoverCode({ connectors: { "no-discovery": { probe: async () => ({}) }, first, second } });
  const r = await d.call({ subnet: "10.0.0.1/32" });
  assert.deepEqual(first.asked, ["http://10.0.0.1"], "a hit on port 80 means 7125 is not tried");
  assert.deepEqual(second.asked, [], "a later connector is not asked once one has answered");
  assert.deepEqual(r.lines[r.lines.length - 1].found, [{ ip: "10.0.0.1", url: "http://10.0.0.1", device_name: "U1", machine_type: "U1", serial: "S1", mac: "aa", connector: "first" }]);
});
test("4. a connector that throws does not stop the next one", async () => {
  const broken = connector({}, { throws: true });
  const good = connector({ "http://10.0.0.1": { url: "http://10.0.0.1", device_name: "U1" } });
  const d = loadDiscoverCode({ connectors: { broken, good } });
  const r = await d.call({ subnet: "10.0.0.1/32" });
  assert.deepEqual(broken.asked, ["http://10.0.0.1"]);
  assert.deepEqual(r.lines[r.lines.length - 1].found, [{ ip: "10.0.0.1", url: "http://10.0.0.1", device_name: "U1", connector: "good" }]);
});

// ---------- 5. the streamed answer ----------
test("5. headers: NDJSON, never cached, never sniffed", async () => {
  const d = loadDiscoverCode({ connectors: { a: connector() } });
  const r = await d.call({ subnet: "10.0.0.0/30" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.headers, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  assert.ok(r.raw.endsWith("\n"), "every record ends with a newline");
  assert.equal(r.raw.split("\n").length - 1, r.lines.length, "one record per line");
});
test("5. a small sweep is exactly three records: initial, one progress, done", async () => {
  const d = loadDiscoverCode({ connectors: { a: connector() } });
  const r = await d.call({ subnet: "10.0.0.0/30" });
  assert.deepEqual(r.lines, [
    { subnets: ["10.0.0.0/30"], total: 4, scanned: 0 },
    { scanned: 4, total: 4, found: 0 },
    { done: true, subnets: ["10.0.0.0/30"], found: [] },
  ]);
});
test("5. without a subnet the routed LAN's /24 is swept in batches of 40: 1 initial + 7 progress + 1 done, found counted as it goes", async () => {
  const c = connector({ "http://192.168.20.5": { url: "http://192.168.20.5", device_name: "A" }, "http://192.168.20.200:7125": { url: "http://192.168.20.200:7125", device_name: "B" } });
  const d = loadDiscoverCode({ connectors: { a: c }, interfaces: LAN, dgram: fakeDgram({ address: "192.168.20.151" }) });
  const r = await d.call({});
  assert.equal(r.lines.length, 9);
  assert.deepEqual(r.lines[0], { subnets: ["192.168.20.0/24"], total: 254, scanned: 0 });
  assert.deepEqual(r.lines.slice(1, 8), [
    { scanned: 40, total: 254, found: 1 }, { scanned: 80, total: 254, found: 1 }, { scanned: 120, total: 254, found: 1 }, { scanned: 160, total: 254, found: 1 },
    { scanned: 200, total: 254, found: 2 }, { scanned: 240, total: 254, found: 2 }, { scanned: 254, total: 254, found: 2 },
  ]);
  assert.deepEqual(r.lines[8], { done: true, subnets: ["192.168.20.0/24"],
    found: [{ ip: "192.168.20.5", url: "http://192.168.20.5", device_name: "A", connector: "a" }, { ip: "192.168.20.200", url: "http://192.168.20.200:7125", device_name: "B", connector: "a" }] });
  assert.equal(c.asked.filter(b => !b.endsWith(":7125")).length, 254, "addresses .1 to .254, each once on port 80");
  assert.ok(!c.asked.includes("http://192.168.20.0") && !c.asked.includes("http://192.168.20.255"));
});

// ---------- 6. a browser that goes away ----------
test("6. a request closed during the first batch stops the sweep: no further batch is probed and no done record is written", async () => {
  let ctl = null;
  const c = connector({}, { onFirst: () => ctl.close() });
  const d = loadDiscoverCode({ connectors: { a: c } });
  const r = await d.call({ subnet: "10.0.0.0/25" }, { onLine: (o, x) => { ctl = x; } });
  assert.deepEqual(r.lines, [{ subnets: ["10.0.0.0/25"], total: 128, scanned: 0 }, { scanned: 40, total: 128, found: 0 }],
    "the batch already running reports; nothing after it");
  assert.equal(r.ended, true, "the response is still ended");
  assert.equal(c.asked.length, 80, "40 addresses x 2 ports, not 128 x 2");
});
test("6. a request that stays open runs every batch and ends with the done record", async () => {
  const c = connector();
  const d = loadDiscoverCode({ connectors: { a: c } });
  const r = await d.call({ subnet: "10.0.0.0/25" });
  assert.deepEqual(r.lines.map(l => l.scanned), [0, 40, 80, 120, 128, undefined]);
  assert.equal(r.lines[5].done, true);
  assert.equal(c.asked.length, 256);
});

// ---------- 7. the route lookup ----------
const within = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r("STILL PENDING"), ms))]);
test("7. the default route is read from a UDP socket connected to 8.8.8.8:53; the socket is closed once and the deadline timer cleared", async () => {
  const dgram = fakeDgram({ address: "192.168.20.151" });
  const d = loadDiscoverCode({ dgram });
  assert.equal(await within(d.internal.defaultRouteAddress(), 2000), "192.168.20.151");
  assert.equal(dgram.sockets.length, 1);
  assert.equal(dgram.sockets[0].type, "udp4");
  assert.deepEqual(dgram.sockets[0].connects, [[53, "8.8.8.8"]]);
  assert.equal(dgram.sockets[0].closed, 1);
  assert.deepEqual(d.timers.created.map(x => x.ms), [300], "one deadline timer, 300 ms by default");
  assert.deepEqual(d.timers.cleared, d.timers.created.map(x => x.t), "and it is cleared when the answer arrives");
});
test("7. a socket that never answers gives null at the deadline, and is closed", async () => {
  const dgram = fakeDgram({ behaviour: "silent" });
  const d = loadDiscoverCode({ dgram });
  const t0 = Date.now();
  assert.equal(await within(d.internal.defaultRouteAddress({ timeoutMs: 40 }), 2000), null);
  assert.ok(Date.now() - t0 >= 30, "not before the deadline");
  assert.equal(dgram.sockets[0].closed, 1);
  assert.deepEqual(d.timers.created.map(x => x.ms), [40]);
});
test("7. a socket error, a refused connect, no sockets at all, and an unbound 0.0.0.0 are all 'unknown' (null), with the socket closed and the timer cleared", async () => {
  for (const [opts, sockets] of [[{ behaviour: "error" }, 1], [{ behaviour: "throw-connect" }, 1], [{ behaviour: "throw-create" }, 0], [{ address: "0.0.0.0" }, 1]]) {
    const dgram = fakeDgram(opts);
    const d = loadDiscoverCode({ dgram });
    assert.equal(await within(d.internal.defaultRouteAddress(), 2000), null, JSON.stringify(opts));
    assert.equal(dgram.sockets.length, sockets);
    if (sockets) assert.equal(dgram.sockets[0].closed, 1, JSON.stringify(opts) + ": closed once");
    assert.deepEqual(d.timers.cleared, d.timers.created.map(x => x.t), JSON.stringify(opts) + ": timer cleared");
  }
});
test("7. the route uses the lookup: with two LANs only the routed one is swept; when the lookup fails, both are", async () => {
  const TWO = { ...LAN, "Wi-Fi": [{ family: "IPv4", internal: false, address: "10.20.30.40", netmask: "255.255.255.0" }] };
  const routed = await loadDiscoverCode({ connectors: { a: connector() }, interfaces: TWO, dgram: fakeDgram({ address: "10.20.30.40" }) }).call({});
  assert.deepEqual(routed.lines[0], { subnets: ["10.20.30.0/24"], total: 254, scanned: 0 });
  const unknown = await loadDiscoverCode({ connectors: { a: connector() }, interfaces: TWO, dgram: fakeDgram({ behaviour: "error" }) }).call({});
  assert.deepEqual(unknown.lines[0], { subnets: ["192.168.20.0/24", "10.20.30.0/24"], total: 508, scanned: 0 });
});
