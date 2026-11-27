// test/rediscover.test.js — Settings > Printers "Rediscover" matching
// (public/rediscover.js, docs/TODO.md §35).
//
// From a small U1 farm's report: "some machines appear with the same serial
// number". Rediscover reads each saved printer's address and scans the
// network, then says what changed. The serial is the identity, the address is
// what a router changes: a saved serial found elsewhere is an address
// correction, and only a serial found nowhere is a serial correction.
// Nothing the evidence leaves open goes into Update all.
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../public/rediscover.js");

// A saved U1. ip "192.168.40.N", serial "SN-<n>".
const u1 = (id, n, serial = "SN-" + id, extra = {}) => ({
  id, name: "U1 " + id, url: "http://192.168.40." + n, ip: "192.168.40." + n, serial, connector: "snapmaker-u1-klipper-ws", checkable: true, fixedHost: false, ...extra,
});
const scan = (found, extra = {}) => ({ subnet: "192.168.40", label: "192.168.40.0/24", complete: true, error: null, found, ...extra });
const at = (n, serial, name) => ({ ip: "192.168.40." + n, url: "http://192.168.40." + n, serial, device_name: name || null });
// Each printer answering at its own saved address, unless overridden.
const liveAll = (printers, over = {}) => Object.fromEntries(printers.map(p => [p.id, over[p.id] || { online: true, serial: p.serial, name: p.name }]));

test("everything as saved: all unchanged, nothing offered", () => {
  const printers = [u1("A", 10), u1("B", 11)];
  const r = R.plan({ printers, live: liveAll(printers), scans: [scan([at(10, "SN-A"), at(11, "SN-B")])] });
  assert.deepEqual(r.unchanged, ["A", "B"]);
  assert.deepEqual(r.fixes, []);
  assert.deepEqual(r.updateAll, []);
  assert.equal(r.checked, 2);
});

test("a saved serial found at a new, free address: an address correction, in Update all", () => {
  const printers = [u1("A", 10), u1("B", 11)];
  const r = R.plan({ printers, live: liveAll(printers, { A: { online: false } }), scans: [scan([at(57, "SN-A"), at(11, "SN-B")])] });
  assert.equal(r.fixes.length, 1);
  assert.deepEqual(r.fixes[0].moves.map(m => [m.id, m.field, m.from, m.to]), [["A", "address", "192.168.40.10", "192.168.40.57"]]);
  assert.equal(r.fixes[0].ambiguous, false);
  assert.deepEqual(r.updateAll, [r.fixes[0].key]);
  assert.deepEqual(R.fixChanges(r.fixes[0]), [{ id: "A", ip: "192.168.40.57" }]);
});

test("two printers swapped addresses: one correction for both, never two that would each duplicate an address", () => {
  const printers = [u1("A", 10), u1("B", 11)];
  // A's address answers with B's serial and the other way round.
  const live = { A: { online: true, serial: "SN-B" }, B: { online: true, serial: "SN-A" } };
  const r = R.plan({ printers, live, scans: [scan([at(10, "SN-B"), at(11, "SN-A")])] });
  assert.equal(r.fixes.length, 1, "one group");
  const f = r.fixes[0];
  assert.deepEqual(f.moves.map(m => [m.id, m.to]).sort(), [["A", "192.168.40.11"], ["B", "192.168.40.10"]]);
  assert.equal(f.ambiguous, false);
  assert.deepEqual(r.updateAll, [f.key]);
  assert.deepEqual(r.blocked, []);
  // No serial was touched: copying the swapped serials in would have tied each
  // row's history to the other machine.
  assert.ok(f.moves.every(m => m.field === "address"));
  // Applied together they leave no duplicate; either half alone would.
  const both = R.fixChanges(f);
  assert.deepEqual(R.conflicts(R.applyChanges(printers, both), both), []);
  const half = [both[0]];
  assert.equal(R.conflicts(R.applyChanges(printers, half), half)[0].field, "address");
});

test("a chain (A to B's address, B to a free one) is one group too", () => {
  const printers = [u1("A", 10), u1("B", 11)];
  const r = R.plan({ printers, live: { A: { online: false }, B: { online: true, serial: "SN-A" } }, scans: [scan([at(11, "SN-A"), at(12, "SN-B")])] });
  assert.equal(r.fixes.length, 1);
  assert.deepEqual(r.fixes[0].moves.map(m => [m.id, m.to]).sort(), [["A", "192.168.40.11"], ["B", "192.168.40.12"]]);
});

test("a move onto an address another printer keeps: blocked, not offered, not in Update all", () => {
  // B is still saved at .11 but its own serial wasn't seen anywhere.
  const printers = [u1("A", 10), u1("B", 11)];
  const r = R.plan({ printers, live: { A: { online: false }, B: { online: true, serial: "SN-A" } }, scans: [scan([at(11, "SN-A")])] });
  assert.deepEqual(r.fixes, []);
  assert.deepEqual(r.updateAll, []);
  assert.equal(r.blocked.length, 1);
  assert.deepEqual([r.blocked[0].id, r.blocked[0].reason, r.blocked[0].other], ["A", "address-taken", "B"]);
  assert.deepEqual(r.notFound, ["B"], "B's own serial is nowhere; its address answers as A");
});

test("an address held by a printer that can't be checked (FlashForge) blocks the move as well", () => {
  const ff = { id: "F", name: "5M PRO", url: "http://192.168.40.57", ip: "192.168.40.57", serial: "SNMOMX", connector: "flashforge-adventurer", checkable: false };
  const printers = [u1("A", 10), ff];
  const r = R.plan({ printers, live: { A: { online: false } }, scans: [scan([at(57, "SN-A")])] });
  assert.deepEqual(r.fixes, []);
  assert.equal(r.blocked[0].other, "F");
});

test("serial found nowhere, a different free serial at the saved address, every scan complete: a serial correction", () => {
  const printers = [u1("A", 10)];
  const r = R.plan({ printers, live: { A: { online: true, serial: "SN-NEW" } }, scans: [scan([at(10, "SN-NEW")])] });
  assert.equal(r.fixes.length, 1);
  assert.deepEqual(r.fixes[0].moves, [{ id: "A", field: "serial", from: "SN-A", to: "SN-NEW" }]);
  assert.equal(r.fixes[0].ambiguous, false);
  assert.deepEqual(r.updateAll, [r.fixes[0].key]);
});

// Item 4 of the 2026-10-23 review: a scan that failed somewhere else must not
// hold back a correction the evidence settles; one that failed where the
// correction depends on must.
const failed = (subnet) => ({ subnet, label: subnet + ".0/24", complete: false, error: "connection reset", found: [] });

test("a serial correction is automatic when only an unrelated network's scan failed", () => {
  const printers = [u1("A", 10)];
  const r = R.plan({ printers, live: { A: { online: true, serial: "SN-NEW" } }, scans: [scan([at(10, "SN-NEW")]), failed("192.168.20")] });
  assert.equal(r.fixes[0].ambiguous, false);
  assert.deepEqual(r.updateAll, [r.fixes[0].key]);
  assert.deepEqual(r.scanIssues, [{ label: "192.168.20.0/24", error: "connection reset" }], "the failure is still reported");
});

test("a serial correction needs a person when the printer's own network wasn't scanned to the end (the old serial may be there)", () => {
  const printers = [u1("A", 10)];
  const r = R.plan({ printers, live: { A: { online: true, serial: "SN-NEW" } }, scans: [failed("192.168.40"), scan([], { subnet: "192.168.20", label: "192.168.20.0/24" })] });
  assert.equal(r.fixes[0].ambiguous, true);
  assert.equal(r.fixes[0].reason, "scan-incomplete");
  assert.deepEqual(r.fixes[0].unverified, ["192.168.40.0/24"]);
  assert.deepEqual(r.updateAll, []);
});

test("a move seen in a complete scan stays automatic when an unrelated network's scan failed", () => {
  const printers = [u1("A", 10)];
  const r = R.plan({ printers, live: { A: { online: false } }, scans: [scan([at(57, "SN-A")]), failed("192.168.20")] });
  assert.equal(r.fixes[0].ambiguous, false);
  assert.deepEqual(r.updateAll, [r.fixes[0].key]);
});

test("a swap read directly, with its own network's scan unfinished, needs a person: another device there could report the same serial", () => {
  const printers = [u1("A", 10), u1("B", 11)];
  const live = { A: { online: true, serial: "SN-B" }, B: { online: true, serial: "SN-A" } };
  const r = R.plan({ printers, live, scans: [failed("192.168.40")] });
  assert.equal(r.fixes.length, 1, "still one group");
  assert.equal(r.fixes[0].ambiguous, true);
  assert.equal(r.fixes[0].reason, "move-unverified");
  assert.deepEqual(r.fixes[0].unverified, ["192.168.40.0/24"]);
  assert.deepEqual(r.updateAll, []);
});

test("a move to another network needs both networks scanned to the end", () => {
  const printers = [u1("A", 10)];
  const moved = { subnet: "192.168.5", label: "192.168.5.0/24", complete: true, error: null, found: [{ ip: "192.168.5.7", url: "http://192.168.5.7", serial: "SN-A" }] };
  let r = R.plan({ printers, live: { A: { online: false } }, scans: [moved, failed("192.168.40")] });
  assert.equal(r.fixes[0].ambiguous, true, "the network it left wasn't fully scanned");
  assert.deepEqual(r.fixes[0].unverified, ["192.168.40.0/24"]);
  r = R.plan({ printers, live: { A: { online: false } }, scans: [moved, scan([])] });
  assert.equal(r.fixes[0].ambiguous, false);
});

test("a printer saved by host name: its serial correction waits on every scan, having no network of its own", () => {
  const printers = [{ ...u1("A", 10), ip: "u1-a.local", url: "http://u1-a.local" }];
  const live = { A: { online: true, serial: "SN-NEW" } };
  assert.equal(R.plan({ printers, live, scans: [scan([])] }).fixes[0].ambiguous, false);
  assert.equal(R.plan({ printers, live, scans: [scan([]), failed("192.168.20")] }).fixes[0].ambiguous, true);
  assert.equal(R.plan({ printers, live, scans: [] }).fixes[0].ambiguous, true, "no scan at all");
});

test("no serial saved: the one its address reports is filled in, as Save's auto-fill does", () => {
  const printers = [u1("A", 10, "")];
  const r = R.plan({ printers, live: { A: { online: true, serial: "SN-A" } }, scans: [scan([at(10, "SN-A")])] });
  assert.deepEqual(r.fixes[0].moves, [{ id: "A", field: "serial", from: "", to: "SN-A" }]);
  assert.equal(r.fixes[0].ambiguous, false);
});

test("a serial saved on two printers (the report): listed, and the one whose address says otherwise must be confirmed", () => {
  const printers = [u1("Gold", 10, "SN-X"), u1("Silver", 11, "SN-X")];
  const live = { Gold: { online: true, serial: "SN-X" }, Silver: { online: true, serial: "SN-Y" } };
  const r = R.plan({ printers, live, scans: [scan([at(10, "SN-X"), at(11, "SN-Y")])] });
  assert.deepEqual(r.duplicates, [{ field: "serial", value: "SN-X", ids: ["Gold", "Silver"] }]);
  assert.deepEqual(r.unchanged, ["Gold"]);
  assert.equal(r.fixes.length, 1);
  assert.deepEqual(r.fixes[0].moves, [{ id: "Silver", field: "serial", from: "SN-X", to: "SN-Y" }]);
  assert.equal(r.fixes[0].ambiguous, true);
  assert.equal(r.fixes[0].reason, "shared-serial");
  assert.deepEqual(r.updateAll, [], "never applied without a person");
});

test("a serial saved on two printers, neither address answering with it: no move is guessed", () => {
  const printers = [u1("Gold", 10, "SN-X"), u1("Silver", 11, "SN-X")];
  const r = R.plan({ printers, live: { Gold: { online: false }, Silver: { online: false } }, scans: [scan([at(30, "SN-X")])] });
  assert.deepEqual(r.fixes, []);
  assert.deepEqual(r.notFound.sort(), ["Gold", "Silver"]);
});

test("an address saved on two printers: listed, and a serial read there must be confirmed", () => {
  const printers = [u1("A", 10, ""), u1("B", 10, "")];
  const r = R.plan({ printers, live: { A: { online: true, serial: "SN-Q" }, B: { online: true, serial: "SN-Q" } }, scans: [scan([at(10, "SN-Q")])] });
  assert.deepEqual(r.duplicates.map(d => d.field), ["address"]);
  assert.ok(r.fixes.every(f => f.ambiguous && f.reason === "shared-address"));
  assert.deepEqual(r.updateAll, []);
});

test("one serial answering at two addresses (the printers themselves): reported, nothing offered", () => {
  const printers = [u1("A", 10)];
  const r = R.plan({ printers, live: { A: { online: false } }, scans: [scan([at(20, "SN-A"), at(21, "SN-A")])] });
  assert.deepEqual(r.fixes, []);
  assert.deepEqual(r.conflicts, [{ id: "A", reason: "serial-at-several", ips: ["192.168.40.20", "192.168.40.21"] }]);
});

test("not found only when its network was fully scanned; an unfinished or unscanned network is 'not checked'", () => {
  const printers = [u1("A", 10), { ...u1("B", 5), ip: "192.168.9.5", url: "http://192.168.9.5" }, { ...u1("C", 6), ip: null, url: "" }];
  const live = { A: { online: false }, B: { online: false }, C: { online: false } };
  let r = R.plan({ printers, live, scans: [scan([])] });
  assert.deepEqual(r.notFound, ["A"]);
  assert.deepEqual(r.notChecked, [{ id: "B", reason: "not-scanned" }, { id: "C", reason: "no-address" }]);
  r = R.plan({ printers, live, scans: [scan([], { complete: false, error: "aborted" })] });
  assert.deepEqual(r.notFound, [], "a scan that didn't finish proves nothing is missing");
  assert.deepEqual(r.notChecked[0], { id: "A", reason: "scan-incomplete" });
  r = R.plan({ printers, live, scans: [] });
  assert.deepEqual(r.notFound, [], "no scan at all");
});

test("not found is never turned into a change", () => {
  const printers = [u1("A", 10)];
  const r = R.plan({ printers, live: { A: { online: false } }, scans: [scan([])] });
  assert.deepEqual(r.notFound, ["A"]);
  assert.deepEqual(r.fixes, []);
  assert.deepEqual(r.updateAll, []);
});

test("an address that answers with another printer's serial is that printer's move, never this one's serial", () => {
  const printers = [u1("A", 10), u1("B", 11)];
  // B moved onto A's address; A is off.
  const r = R.plan({ printers, live: { A: { online: true, serial: "SN-B" }, B: { online: false } }, scans: [scan([at(10, "SN-B")])] });
  assert.ok(!r.fixes.some(f => f.moves.some(m => m.field === "serial")), "A is not given B's serial");
  assert.deepEqual(r.blocked.map(b => [b.id, b.other]), [["B", "A"]], "B can't take an address A still has");
  assert.deepEqual(r.notFound, ["A"]);
});

test("names: only a real difference is listed (the slicer hook ignores case and underscores), never in Update all", () => {
  const printers = [u1("A", 10, "SN-A", { name: "U1 OLIVE" }), u1("B", 11, "SN-B", { name: "U1 Navy" }), u1("C", 12, "SN-C", { name: "Shelf 2" })];
  const live = { A: { online: true, serial: "SN-A", name: "U1 Olive" }, B: { online: true, serial: "SN-B", name: "Navy_Left" }, C: { online: true, serial: "SN-C", name: "U1 Navy" } };
  const r = R.plan({ printers, live, scans: [scan([])] });
  assert.deepEqual(r.renames.map(x => [x.id, x.to, x.clash]), [["B", "Navy_Left", null], ["C", "U1 Navy", "B"]]);
  assert.deepEqual(r.updateAll, []);
  assert.deepEqual(r.unchanged, ["A", "B", "C"], "a name difference alone is not a correction");
});

test("a moved printer's name is read where it was found", () => {
  const printers = [u1("A", 10)];
  const r = R.plan({ printers, live: { A: { online: false } }, scans: [scan([at(57, "SN-A", "Shelf A")])] });
  assert.deepEqual(r.renames.map(x => x.to), ["Shelf A"]);
});

test("new U1s on the network are listed for adding, and are never part of Update all", () => {
  const printers = [u1("A", 10)];
  const r = R.plan({ printers, live: liveAll(printers), scans: [scan([at(10, "SN-A"), at(40, "SN-NEW", "U1 New"), at(41, null, "Generic Klipper")])] });
  assert.deepEqual(r.newPrinters.map(f => f.ip), ["192.168.40.40"], "one that reports no serial isn't a U1");
  assert.deepEqual(r.updateAll, []);
});

test("a printer saved by host name is moved to an IP only after a person confirms", () => {
  const printers = [{ ...u1("A", 10), ip: "u1-a.local", url: "http://u1-a.local" }];
  const r = R.plan({ printers, live: { A: { online: false } }, scans: [scan([at(30, "SN-A")])] });
  assert.equal(r.fixes[0].ambiguous, true);
  assert.equal(r.fixes[0].reason, "host-name");
  assert.deepEqual(r.updateAll, []);
});

test("a printer that always runs on this machine (the Virtual U1) is never moved", () => {
  const printers = [{ ...u1("V", 10), ip: "127.0.0.1", url: "http://127.0.0.1:7126", fixedHost: true }];
  const r = R.plan({ printers, live: { V: { online: false } }, scans: [scan([at(30, "SN-V")])] });
  assert.deepEqual(r.fixes, []);
  assert.equal(r.conflicts[0].reason, "fixed-host");
});

test("conflicts: a duplicate that was already there doesn't block an unrelated fix; a new one does", () => {
  const printers = [u1("A", 10, "SN-DUP"), u1("B", 11, "SN-DUP")];
  assert.deepEqual(R.conflicts(R.applyChanges(printers, [{ id: "A", ip: "192.168.40.12" }]), [{ id: "A", ip: "192.168.40.12" }]), [],
    "an address fix is not blocked by a serial duplicate that was already there");
  const ch = [{ id: "A", serial: "SN-B2" }, { id: "B", serial: "SN-B2" }];
  assert.ok(R.conflicts(R.applyChanges(printers, ch), ch).some(c => c.field === "serial"));
});

test("conflicts: names compared the way the slicer hook finds them", () => {
  const printers = [u1("A", 10), u1("B", 11, "SN-B", { name: "U1 Navy" })];
  const ch = [{ id: "A", name: "u1_navy " }];
  assert.deepEqual(R.conflicts(R.applyChanges(printers, ch), ch), [{ id: "A", field: "name", other: "B" }]);
});

test("withHost keeps the scheme and port, changes only the host", () => {
  assert.equal(R.withHost("http://192.168.40.10", "192.168.40.57"), "http://192.168.40.57");
  assert.equal(R.withHost("https://10.0.0.5:7125", "10.0.0.6"), "https://10.0.0.6:7125");
  assert.equal(R.withHost("not a url", "10.0.0.6"), null);
});
