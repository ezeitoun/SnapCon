// test/discoverySubnets.test.js — "Discover on my local network" must scan the
// networks a printer could actually be on, and nothing else.
//
// The bug, from a real machine: Discover reported "No printers found on
// 100.64.0.0/24, 192.168.20.0/24, 172.17.64.0/24". Only the middle one is a
// LAN. The other two are a Tailscale interface (a single /32 address on a VPN)
// and a Hyper-V virtual switch — 508 addresses probed for nothing, three times
// the wait, and an error naming networks the operator has never heard of.
//
// Every non-internal IPv4 interface was treated as a /24 taken from its first
// three octets, which is where both mistakes came from.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "routes", "discover.js"), "utf8");

function extract(name) {
  const start = serverSrc.indexOf("function " + name + "(");
  assert.ok(start > 0, name + " must exist in server.js");
  return serverSrc.slice(start, serverSrc.indexOf("\n}", start) + 2);
}
const sandbox = { Set, Array, String, Number };
vm.createContext(sandbox);
for (const c of ["const SKIP_INTERFACE_RE", "const SKIP_ADDRESS_RE"]) {
  const at = serverSrc.indexOf(c);
  assert.ok(at > 0, c + " must exist");
  vm.runInContext(serverSrc.slice(at, serverSrc.indexOf("\n", at) + 1), sandbox);
}
vm.runInContext(extract("localSubnets"), sandbox);
const subnets = (ifs) => Array.from(vm.runInContext("localSubnets", sandbox)(ifs));

// What the machine that hit this reported; the addresses are examples.
const REAL_MACHINE = {
  "Ethernet 3": [{ family: "IPv4", internal: false, address: "192.168.20.151", netmask: "255.255.255.0" }],
  "vEthernet (Default Switch)": [{ family: "IPv4", internal: false, address: "172.17.64.1", netmask: "255.255.240.0" }],
  "Tailscale": [{ family: "IPv4", internal: false, address: "100.64.0.80", netmask: "255.255.255.255" }],
  "Loopback Pseudo-Interface 1": [{ family: "IPv4", internal: true, address: "127.0.0.1", netmask: "255.0.0.0" }]
};

test("only the real LAN is scanned on the machine that reported this", () => {
  assert.deepEqual(subnets(REAL_MACHINE), ["192.168.20"]);
});

test("a Tailscale address is not a network to scan", () => {
  // /32 is one host, not a subnet, and 100.64.0.0/10 is carrier-grade NAT —
  // a VPN peer range where probing 254 addresses finds nothing slowly.
  const only = { "Tailscale": REAL_MACHINE["Tailscale"] };
  assert.deepEqual(subnets(only), []);
});

test("a VPN that reports a /24 is still skipped by its address range", () => {
  // Belt and braces: the name check and the CGNAT range check are independent,
  // because interface names differ across platforms.
  const odd = { "utun3": [{ family: "IPv4", internal: false, address: "100.100.5.2", netmask: "255.255.255.0" }] };
  assert.deepEqual(subnets(odd), []);
});

test("a virtual switch is skipped even though its address looks private", () => {
  // 172.16.0.0/12 is a legitimate private range, so this is decided by the
  // interface being virtual, not by the address.
  const hv = { "vEthernet (Default Switch)": REAL_MACHINE["vEthernet (Default Switch)"] };
  assert.deepEqual(subnets(hv), []);
});

test("a real LAN in the 172.16 range is still scanned", () => {
  // The flip side of the test above: somebody's actual office network.
  const office = { "eth0": [{ family: "IPv4", internal: false, address: "172.20.4.11", netmask: "255.255.255.0" }] };
  assert.deepEqual(subnets(office), ["172.20.4"]);
});

test("Docker and WSL bridges are skipped", () => {
  const linux = {
    "eth0": [{ family: "IPv4", internal: false, address: "10.0.0.5", netmask: "255.255.255.0" }],
    "docker0": [{ family: "IPv4", internal: false, address: "172.17.0.1", netmask: "255.255.0.0" }],
    "br-2f1a": [{ family: "IPv4", internal: false, address: "172.18.0.1", netmask: "255.255.0.0" }],
    "veth9a1": [{ family: "IPv4", internal: false, address: "172.19.0.1", netmask: "255.255.0.0" }]
  };
  assert.deepEqual(subnets(linux), ["10.0.0"]);
});

test("an address the machine gave itself is not a network", () => {
  const apipa = { "Ethernet": [{ family: "IPv4", internal: false, address: "169.254.11.9", netmask: "255.255.0.0" }] };
  assert.deepEqual(subnets(apipa), []);
});

test("two real networks are both scanned", () => {
  // A hub with a second NIC on the printer VLAN is the case this must not break.
  const dual = {
    "eth0": [{ family: "IPv4", internal: false, address: "192.168.1.10", netmask: "255.255.255.0" }],
    "eth1": [{ family: "IPv4", internal: false, address: "10.20.30.40", netmask: "255.255.255.0" }]
  };
  assert.deepEqual(subnets(dual).sort(), ["10.20.30", "192.168.1"]);
});

// ---- only the adapter that carries the default route ----
// A machine can have two real LANs (a second NIC, a lab network, a
// still-connected wifi). Sweeping both is slow and finds printers on networks
// the operator was not asking about, so the scan follows the route the machine
// itself uses to reach anything else.

vm.runInContext(extract("scanSubnets"), sandbox);
const scanFor = (ifs, sourceIp) => Array.from(vm.runInContext("scanSubnets", sandbox)(ifs, sourceIp));

const TWO_LANS = {
  "Ethernet 3": [{ family: "IPv4", internal: false, address: "192.168.20.151", netmask: "255.255.255.0" }],
  "Wi-Fi": [{ family: "IPv4", internal: false, address: "10.20.30.40", netmask: "255.255.255.0" }],
  "Tailscale": [{ family: "IPv4", internal: false, address: "100.64.0.80", netmask: "255.255.255.255" }]
};

test("only the network the machine routes through is scanned", () => {
  assert.deepEqual(scanFor(TWO_LANS, "192.168.20.151"), ["192.168.20"]);
  assert.deepEqual(scanFor(TWO_LANS, "10.20.30.40"), ["10.20.30"]);
});

test("a machine whose default route is a VPN falls back to its real networks", () => {
  // An exit node, or a full-tunnel VPN. Scanning the VPN would find nothing, so
  // this is the one case where scanning every real LAN is better than nothing.
  assert.deepEqual(scanFor(TWO_LANS, "100.64.0.80").sort(), ["10.20.30", "192.168.20"]);
});

test("not knowing the route is not a failure", () => {
  // The routing lookup is best effort; without an answer the scan behaves as
  // it did before, minus the virtual adapters.
  assert.deepEqual(scanFor(TWO_LANS, null).sort(), ["10.20.30", "192.168.20"]);
  assert.deepEqual(scanFor(TWO_LANS, "203.0.113.7").sort(), ["10.20.30", "192.168.20"],
    "an address belonging to no adapter tells us nothing");
});

test("one LAN behaves the same either way", () => {
  assert.deepEqual(scanFor(REAL_MACHINE, "192.168.20.151"), ["192.168.20"]);
  assert.deepEqual(scanFor(REAL_MACHINE, null), ["192.168.20"]);
});

test("a machine with nothing scannable says so instead of scanning nonsense", () => {
  assert.deepEqual(subnets({ "Tailscale": REAL_MACHINE["Tailscale"] }), []);
  const at = serverSrc.indexOf('app.get("/api/discover"');
  const route = serverSrc.slice(at, serverSrc.indexOf("\n  });", at));
  assert.match(route, /no_local_network|No network/i,
    "a scan with no networks to scan must explain itself, not report 'no printers found'");
});
