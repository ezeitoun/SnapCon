// test/firmwareInventoryBehaviour.test.js — behavior pins for GET
// /api/firmware (the read-only firmware inventory) and its helpers, written
// BEFORE any refactoring (docs/refactoring-policy.md §3.1) for the behaviors
// no test exercised (2026-11-19):
//   1. authentication: the route sits behind requireAuth, which runs first;
//   2. the single-printer read (?printer=i): who gets a 404, the answer's
//      shape, and that eligibility is not applied to it;
//   3. the list: visible AND flashable printers only, fleet order, the index
//      in the whole printer list as `id`, batches of 6;
//   4. the opt-in stream (?stream=…): headers and records;
//   5. a browser that goes away;
//   6. the rows probeFirmware answers with — not supported, offline, timeout,
//      error, success — and its 20 s timer;
//   7. a configuration reload: a REPLACED printer list is what the next
//      request reads.
// test/firmwareInventory.test.js keeps the original hang regression (real
// timers) and the source-text checks. Real HTTP, authentication and group
// visibility on the wire are pinned by the contract harness
// (tools/refactor/harness). Loads the code through
// test/helpers/firmwareInventoryCode.js — only that loader may change when the
// code moves. The deployment routes (/api/firmware-*) are not part of this.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFirmwareInventoryCode } = require("./helpers/firmwareInventoryCode");

const ON = { online: true, state: "standby" };
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r)); };
const within = (p, ms) => { let t; return Promise.race([p, new Promise(r => { t = setTimeout(() => r("STILL PENDING"), ms); })]).finally(() => clearTimeout(t)); };
const fleet = n => Array.from({ length: n }, (_, i) => ({ id: "p_" + i, name: "P" + i, connector: "u1" }));
const names = (from, to) => Array.from({ length: to - from }, (_, i) => "P" + (from + i));
const okRow = p => ({ name: p.name, online: true, skipped: false, firmware: "1.0.0" });
const decorated = (p, i) => ({ id: i, pid: p.id, connector: p.connector, uniformMcuVersions: false, ...okRow(p) });

// A world for the route: every dependency is a fake that records how it was
// used. `caps(p)` is what getCapabilities answers for a printer, `probe(p)`
// what probeCached resolves to, `info(p, st)` what the connector's
// getFirmwareInfo returns.
function mk({ printers = [], caps = () => ({ firmwareInfo: true, firmwareDeploy: true }), visible = () => true, probe = () => ON,
  info = p => okRow(p), connector = null, requireAuth } = {}) {
  const log = { probe: [], info: [], visible: [], caps: [], connector: [] };
  const conn = connector || { getFirmwareInfo: (p, st) => { log.info.push({ p, st }); return info(p, st); } };
  const d = loadFirmwareInventoryCode({ printers, requireAuth,
    printerVisibleTo: (user, p) => { log.visible.push({ user, name: p.name }); return visible(user, p); },
    getCapabilities: (type, p) => { log.caps.push({ type, name: p.name }); return caps(p); },
    getConnector: type => { log.connector.push(type); return conn; },
    probeCached: async p => { log.probe.push(p.name); return probe(p); } });
  return { d, log };
}

// ---------- 1. authentication ----------
test("1. GET /api/firmware is registered with requireAuth as its only middleware, before the handler", () => {
  const requireAuth = (req, res, next) => next();
  const { d } = mk({ requireAuth });
  assert.equal(d.route.method, "GET");
  assert.equal(d.route.path, "/api/firmware");
  assert.equal(d.route.handlers.length, 2);
  assert.equal(d.route.handlers[0], requireAuth);
  assert.equal(d.routes.length, 1, "the firmware inventory registers this one route and nothing else");
});
test("1. when requireAuth refuses, the handler never runs: nothing is probed, in any of the three modes", async () => {
  const { d, log } = mk({ printers: fleet(2), requireAuth: (req, res) => res.status(401).json({ error: "Not signed in" }) });
  for (const query of [{}, { printer: "0" }, { stream: "1" }]) {
    const r = await d.call(query, { user: null });
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: "Not signed in" });
    assert.deepEqual(r.lines, []);
    assert.deepEqual(r.headers, {});
  }
  assert.deepEqual(log, { probe: [], info: [], visible: [], caps: [], connector: [] });
  assert.deepEqual(d.timers.created, []);
});

// ---------- 2. the single-printer read ----------
test("2. ?printer=i answers { id, pid, connector, uniformMcuVersions, ...row } — in that order, the row's own fields last", async () => {
  const printers = [{ id: "p_a", name: "Alpha", connector: "klipper" }, { id: "p_b", name: "Bravo", connector: "u1" }];
  const { d, log } = mk({ printers, caps: p => ({ firmwareInfo: true, firmwareDeploy: true, uniformMcuVersions: p.name === "Bravo" }),
    info: p => ({ name: p.name, online: true, skipped: false, machine: "Snapmaker U1", firmware: "1.2.3", mcus: [{ name: "mainboard", version: "v1" }] }) });
  const r = await d.call({ printer: "1" });
  assert.equal(r.status, 200);
  assert.equal(r.text, '{"id":1,"pid":"p_b","connector":"u1","uniformMcuVersions":true,"name":"Bravo","online":true,"skipped":false,"machine":"Snapmaker U1","firmware":"1.2.3","mcus":[{"name":"mainboard","version":"v1"}]}');
  assert.deepEqual(log.probe, ["Bravo"], "only the printer asked for is probed");
  assert.deepEqual(r.headers, {}, "a single read is plain JSON: none of the stream's headers");
  const a = await d.call({ printer: "0" });
  assert.equal(a.json.id, 0);
  assert.equal(a.json.pid, "p_a");
  assert.equal(a.json.uniformMcuVersions, false);
});
test("2. uniformMcuVersions is true only for a capability that is exactly true; a row's own field of a decorating name wins", async () => {
  const printers = [{ id: "p_a", name: "Alpha", connector: "klipper" }];
  const truthy = await mk({ printers, caps: () => ({ firmwareInfo: true, uniformMcuVersions: 1 }) }).d.call({ printer: "0" });
  assert.equal(truthy.json.uniformMcuVersions, false);
  const own = await mk({ printers, info: p => ({ name: p.name, online: true, skipped: false, connector: "from-the-row", id: 99 }) }).d.call({ printer: "0" });
  assert.equal(own.text, '{"id":99,"pid":"p_a","connector":"from-the-row","uniformMcuVersions":false,"name":"Alpha","online":true,"skipped":false}');
});
test("2. an index that names no printer is 404 Unknown printer, and nothing is probed", async () => {
  const { d, log } = mk({ printers: fleet(2) });
  for (const printer of ["2", "9", "-1", "abc", "", "NaN", "1e3x"]) {
    const r = await d.call({ printer });
    if (printer === "1e3x") { assert.equal(r.status, 200, "parseInt reads the leading digits: 1e3x is printer 1"); assert.equal(r.json.id, 1); continue; }
    assert.equal(r.status, 404, JSON.stringify(printer));
    assert.deepEqual(r.json, { error: "Unknown printer" }, JSON.stringify(printer));
  }
  assert.deepEqual(log.probe, ["P1"], "only the one request that named a printer probed anything");
  assert.deepEqual(log.visible.map(v => v.name), ["P1"], "visibility is not even asked for an index that names no printer");
});
test("2. a printer the user may not see is the same 404, and nothing is probed", async () => {
  const user = { role: "view", groupIds: [] };
  const { d, log } = mk({ printers: fleet(2), visible: (u, p) => p.name !== "P1" });
  const hidden = await d.call({ printer: "1" }, { user });
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.json, { error: "Unknown printer" });
  assert.deepEqual(log.probe, []);
  assert.deepEqual(log.connector, []);
  assert.deepEqual(log.caps, []);
  assert.equal(log.visible.length, 1);
  assert.equal(log.visible[0].user, user, "visibility is asked for the request's user");
  assert.equal(log.visible[0].name, "P1");
  const seen = await d.call({ printer: "0" }, { user });
  assert.equal(seen.status, 200);
  assert.equal(seen.json.name, "P0");
});
test("2. eligibility is not applied to a single read: a printer SnapCon cannot flash is still read", async () => {
  const printers = [{ id: "p_k", name: "Klipper", connector: "klipper-moonraker" }];
  const { d, log } = mk({ printers, caps: () => ({ firmwareInfo: true, firmwareDeploy: false }) });
  const r = await d.call({ printer: "0" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { id: 0, pid: "p_k", connector: "klipper-moonraker", uniformMcuVersions: false, name: "Klipper", online: true, skipped: false, firmware: "1.0.0" });
  assert.deepEqual(log.probe, ["Klipper"]);
  assert.deepEqual((await d.call({})).json, [], "the same printer is not in the list");
});
test("2. ?printer wins over ?stream: a single read is never a stream", async () => {
  const { d } = mk({ printers: fleet(1) });
  const r = await d.call({ printer: "0", stream: "1" });
  assert.deepEqual(r.json, decorated(fleet(1)[0], 0));
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.headers, {});
});

// ---------- 3. the list ----------
test("3. the list holds only printers that are visible to the user AND flashable (firmwareDeploy exactly true), in fleet order; id is the index in the whole printer list", async () => {
  const printers = [
    { id: "p_0", name: "Generic", connector: "klipper" },       // not flashable
    { id: "p_1", name: "U1 a", connector: "u1" },
    { id: "p_2", name: "U1 hidden", connector: "u1" },          // not visible
    { id: "p_3", name: "Truthy", connector: "almost" },         // firmwareDeploy: 1, not true
    { id: "p_4", name: "U1 b", connector: "u1" },
  ];
  const user = { role: "view", groupIds: ["g1"] };
  const { d, log } = mk({ printers, visible: (u, p) => p.name !== "U1 hidden",
    caps: p => ({ firmwareInfo: true, firmwareDeploy: p.connector === "u1" ? true : p.connector === "almost" ? 1 : false }) });
  const r = await d.call({}, { user });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, [decorated(printers[1], 1), decorated(printers[4], 4)]);
  assert.equal(r.text.startsWith('[{"id":1,"pid":"p_1","connector":"u1","uniformMcuVersions":false,"name":"U1 a",'), true, "the same key order as a single read");
  assert.deepEqual(log.probe, ["U1 a", "U1 b"], "a printer that is not listed is not probed");
  assert.deepEqual(r.headers, {}, "the default answer is plain JSON");
  assert.deepEqual(r.lines, []);
  assert.deepEqual(log.visible.map(v => v.name), printers.map(p => p.name), "every printer is checked for visibility once");
  assert.ok(log.visible.every(v => v.user === user), "for the request's user");
  assert.ok(log.caps.every(c => c.type === printers.find(p => p.name === c.name).connector), "capabilities are asked with (connector, printer)");
});
test("3. no printer to list: an empty array, nothing probed", async () => {
  const none = mk({ printers: [] });
  assert.deepEqual((await none.d.call({})).json, []);
  const { d, log } = mk({ printers: fleet(3), caps: () => ({ firmwareInfo: true }) });
  const r = await d.call({});
  assert.equal(r.text, "[]");
  assert.deepEqual(log.probe, []);
});
test("3. rows that could not be read are still listed and decorated", async () => {
  const printers = fleet(3);
  const { d } = mk({ printers, probe: p => (p.name === "P1" ? { online: false, error: "connect ETIMEDOUT" } : ON),
    caps: p => ({ firmwareDeploy: true, firmwareInfo: p.name !== "P2", uniformMcuVersions: true }) });
  const r = await d.call({});
  assert.deepEqual(r.json, [
    { id: 0, pid: "p_0", connector: "u1", uniformMcuVersions: true, name: "P0", online: true, skipped: false, firmware: "1.0.0" },
    { id: 1, pid: "p_1", connector: "u1", uniformMcuVersions: true, name: "P1", online: false, skipped: true, reason: "connect ETIMEDOUT", reasonCode: "offline", detail: "connect ETIMEDOUT" },
    { id: 2, pid: "p_2", connector: "u1", uniformMcuVersions: true, name: "P2", online: true, skipped: true, reason: "not supported", reasonCode: "not_supported" },
  ]);
});
test("3. printers are read in batches of 6: a batch starts only when the whole previous batch has answered, and rows keep fleet order", async () => {
  const printers = fleet(14);
  const gates = [];
  const { d, log } = mk({ printers, probe: () => new Promise(r => gates.push(r)) });
  const pending = d.call({});
  await settle();
  assert.deepEqual(log.probe, names(0, 6), "the first six, all at once");
  for (const i of [5, 4, 3, 2, 1]) gates[i](ON);                    // answered in reverse, one still out
  await settle();
  assert.equal(log.probe.length, 6, "the seventh waits for the whole first batch");
  gates[0](ON); await settle();
  assert.deepEqual(log.probe, names(0, 12), "then the next six");
  for (const i of [11, 10, 9, 8, 7, 6]) gates[i](ON);
  await settle();
  assert.deepEqual(log.probe, names(0, 14), "then the last two");
  gates[13](ON); gates[12](ON);
  const r = await within(pending, 2000);
  assert.deepEqual(r.json, printers.map((p, i) => decorated(p, i)));
  assert.equal(r.jsonCalls, 1, "one answer, at the end");
});

// ---------- 4. the stream ----------
test("4. ?stream=1 headers: NDJSON, never cached, never sniffed", async () => {
  const { d } = mk({ printers: fleet(2) });
  const r = await d.call({ stream: "1" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.headers, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  assert.ok(r.raw.endsWith("\n"), "every record ends with a newline");
  assert.equal(r.raw.split("\n").length - 1, r.lines.length, "one record per line");
  assert.equal(r.json, undefined, "no JSON answer in stream mode");
  assert.equal(r.endCalls, 1);
});
test("4. records: initial { total, read: 0 }, one { total, read, rows } per batch of 6, final { done, total, rows } with every row", async () => {
  const printers = fleet(14);
  const { d } = mk({ printers });
  const r = await d.call({ stream: "1" });
  const rows = printers.map((p, i) => decorated(p, i));
  assert.deepEqual(r.lines, [
    { total: 14, read: 0 },
    { total: 14, read: 6, rows: rows.slice(0, 6) },
    { total: 14, read: 12, rows: rows.slice(6, 12) },
    { total: 14, read: 14, rows: rows.slice(12) },
    { done: true, total: 14, rows },
  ]);
  assert.equal(r.raw.split("\n")[1].startsWith('{"total":14,"read":6,"rows":[{"id":0,"pid":"p_0",'), true);
});
test("4. total counts the listed printers only; with none there are exactly the initial and the done record", async () => {
  const { d, log } = mk({ printers: fleet(3), visible: (u, p) => p.name === "P2" });
  const one = await d.call({ stream: "1" });
  assert.deepEqual(one.lines, [{ total: 1, read: 0 }, { total: 1, read: 1, rows: [decorated(fleet(3)[2], 2)] }, { done: true, total: 1, rows: [decorated(fleet(3)[2], 2)] }]);
  assert.deepEqual(log.probe, ["P2"]);
  const none = await mk({ printers: fleet(3), caps: () => ({ firmwareInfo: true }) }).d.call({ stream: "1" });
  assert.equal(none.raw, '{"total":0,"read":0}\n{"done":true,"total":0,"rows":[]}\n');
  assert.equal(none.endCalls, 1);
});
test("4. the stream is opt-in by any non-empty value — \"0\" and \"false\" included; an empty value or none is the JSON array", async () => {
  for (const stream of ["1", "true", "yes", "0", "false"]) {
    const r = await mk({ printers: fleet(1) }).d.call({ stream });
    assert.equal(r.headers["Content-Type"], "application/x-ndjson", JSON.stringify(stream));
    assert.equal(r.lines.length, 3, JSON.stringify(stream));
  }
  for (const query of [{}, { stream: "" }, { stream: undefined }]) {
    const r = await mk({ printers: fleet(1) }).d.call(query);
    assert.deepEqual(r.json, [decorated(fleet(1)[0], 0)], JSON.stringify(query));
    assert.deepEqual(r.headers, {});
    assert.equal(r.raw, "");
  }
});

// ---------- 5. a browser that goes away ----------
test("5. stream: a request closed during the first batch stops the read — that batch still reports, no further batch is probed, no done record, and the response is ended", async () => {
  let live = null;
  const { d, log } = mk({ printers: fleet(14), probe: p => { if (p.name === "P0") live.req.emit("close"); return ON; } });
  live = d.call({ stream: "1" });
  const r = await within(live, 2000);
  const rows = fleet(14).map((p, i) => decorated(p, i));
  assert.deepEqual(r.lines, [{ total: 14, read: 0 }, { total: 14, read: 6, rows: rows.slice(0, 6) }]);
  assert.deepEqual(log.probe, names(0, 6), "the batch already started runs to its end; nothing after it");
  assert.equal(r.ended, true);
  assert.equal(r.endCalls, 1);
});
test("5. stream: a request closed between batches stops before the next one", async () => {
  const { d, log } = mk({ printers: fleet(14) });
  const r = await d.call({ stream: "1" }, { onLine: (o, ctl) => { if (o.read === 6) ctl.close(); } });
  assert.deepEqual(r.lines.map(l => l.read), [0, 6]);
  assert.deepEqual(log.probe, names(0, 6));
  assert.equal(r.endCalls, 1);
});
test("5. stream: a request that stays open runs every batch and ends with the done record", async () => {
  const { d, log } = mk({ printers: fleet(14) });
  const r = await d.call({ stream: "1" });
  assert.deepEqual(r.lines.map(l => l.read), [0, 6, 12, 14, undefined]);
  assert.equal(r.lines[4].done, true);
  assert.equal(log.probe.length, 14);
});
test("5. JSON array (no stream): a request closed during the first batch stops the read too, and the answer is the rows read so far", async () => {
  let live = null;
  const { d, log } = mk({ printers: fleet(14), probe: p => { if (p.name === "P0") live.req.emit("close"); return ON; } });
  live = d.call({});
  const r = await within(live, 2000);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, fleet(14).slice(0, 6).map((p, i) => decorated(p, i)), "a partial array, sent to a client that is gone");
  assert.deepEqual(log.probe, names(0, 6));
  assert.equal(r.jsonCalls, 1);
});

// ---------- 6. the rows ----------
const P = { id: "p_x", name: "Xray", connector: "some-connector" };
const head = { id: 0, pid: "p_x", connector: "some-connector", uniformMcuVersions: false };
test("6. firmwareInfo not declared, or no getFirmwareInfo: a not-supported row — no probe, no connector call, no timer", async () => {
  const off = mk({ printers: [P], caps: () => ({ firmwareInfo: false, firmwareDeploy: true }) });
  const r = await off.d.call({ printer: "0" });
  assert.deepEqual(r.json, { ...head, name: "Xray", online: true, skipped: true, reason: "not supported", reasonCode: "not_supported" });
  assert.deepEqual(off.log.probe, []);
  assert.deepEqual(off.log.info, [], "the method exists and must not be called");
  assert.deepEqual(off.d.timers.created, []);
  assert.deepEqual(off.log.connector, ["some-connector"], "the connector is looked up by the printer's connector id");
  assert.deepEqual(off.log.caps[0], { type: "some-connector", name: "Xray" }, "capabilities are asked with (connector, printer)");
  const absent = mk({ printers: [P], caps: () => ({}) });
  assert.equal((await absent.d.call({ printer: "0" })).json.reasonCode, "not_supported", "a capability never declared counts as no");
  const noMethod = mk({ printers: [P], connector: {} });
  const n = await noMethod.d.call({ printer: "0" });
  assert.deepEqual(n.json, { ...head, name: "Xray", online: true, skipped: true, reason: "not supported", reasonCode: "not_supported" });
  assert.deepEqual(noMethod.log.probe, []);
});
test("6. probeCached throwing: an offline row with the message as reason and detail; the connector is not called", async () => {
  const { d, log } = mk({ printers: [P], probe: () => { throw new Error("probe exploded"); } });
  const r = await d.call({ printer: "0" });
  assert.deepEqual(r.json, { ...head, name: "Xray", online: false, skipped: true, reason: "probe exploded", reasonCode: "offline", detail: "probe exploded" });
  assert.deepEqual(log.info, []);
  assert.deepEqual(d.timers.created, []);
  const blank = await mk({ printers: [P], probe: () => { throw new Error(""); } }).d.call({ printer: "0" });
  assert.deepEqual(blank.json, { ...head, name: "Xray", online: false, skipped: true, reason: "offline", reasonCode: "offline", detail: "" });
});
test("6. a probe that says online:false: an offline row with the probe's error as reason and detail; the connector is not called, no timer", async () => {
  const { d, log } = mk({ printers: [P], probe: () => ({ online: false, error: "connect ETIMEDOUT 192.168.40.31:8898" }) });
  const r = await d.call({ printer: "0" });
  assert.deepEqual(r.json, { ...head, name: "Xray", online: false, skipped: true, reason: "connect ETIMEDOUT 192.168.40.31:8898", reasonCode: "offline", detail: "connect ETIMEDOUT 192.168.40.31:8898" });
  assert.deepEqual(log.probe, ["Xray"]);
  assert.deepEqual(log.info, []);
  assert.deepEqual(d.timers.created, []);
  const blank = await mk({ printers: [P], probe: () => ({ online: false }) }).d.call({ printer: "0" });
  assert.deepEqual(blank.json, { ...head, name: "Xray", online: false, skipped: true, reason: "offline", reasonCode: "offline", detail: "" });
});
test("6. only an explicit online:false is offline: any other probe result goes to the connector, unchanged", async () => {
  for (const st of [{ state: "printing" }, { online: true }, undefined, null]) {
    const { d, log } = mk({ printers: [P], probe: () => st });
    const r = await d.call({ printer: "0" });
    assert.equal(r.json.skipped, false, JSON.stringify(st));
    assert.equal(log.info.length, 1);
    assert.equal(log.info[0].st, st);
  }
});
test("6. success: the connector's object is the row, as it is; getFirmwareInfo(p, st) gets the printer and the probe result; the 20 s timer is created once and cleared, never fired", async () => {
  const st = { online: true, state: "complete", marker: 42 };
  const row = { name: "what the connector says", online: true, skipped: false, klipper: "v0.12", mcus: [], anything: { else: [1, 2] } };
  const { d, log } = mk({ printers: [P], probe: () => st, info: async () => row });
  const r = await d.call({ printer: "0" });
  assert.deepEqual(r.json, { ...head, ...row });
  assert.equal(log.info.length, 1, "called exactly once");
  assert.equal(log.info[0].p, P, "the printer object itself");
  assert.equal(log.info[0].st, st, "the probe result itself — the connector does not probe again");
  assert.deepEqual(log.probe, ["Xray"], "probed once");
  assert.deepEqual(d.timers.created.map(t => t.ms), [20000], "one timer, 20 s by default");
  assert.equal(d.timers.cleared.length, 1);
  assert.equal(d.timers.cleared[0], d.timers.created[0], "cleared once the connector has answered");
  const sync = await mk({ printers: [P], info: () => ({ name: "sync", online: true, skipped: false }) }).d.call({ printer: "0" });
  assert.equal(sync.json.name, "sync", "a connector answering without a promise is accepted");
});
test("6. a connector that never answers: when the 20 s timer fires the row is a timeout row with the exact reason, and the timer is cleared", async () => {
  const { d } = mk({ printers: [P], info: () => new Promise(() => {}) });
  const pending = d.call({ printer: "0" });
  await settle();
  assert.deepEqual(d.timers.created.map(t => t.ms), [20000]);
  assert.deepEqual(d.timers.cleared, [], "still waiting: nothing answered, nothing cleared");
  assert.equal(await within(pending, 30), "STILL PENDING", "no answer before the timer");
  d.timers.created[0].fn();
  const r = await within(pending, 2000);
  assert.notEqual(r, "STILL PENDING", "the timer firing must produce the answer");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ...head, name: "Xray", online: true, skipped: true, reason: "did not answer within 20s", reasonCode: "timeout" });
  assert.equal(d.timers.cleared.length, 1);
  assert.equal(d.timers.cleared[0], d.timers.created[0]);
});
test("6. in the list one printer that never answers costs one timeout row; the others in its batch are read", async () => {
  const printers = fleet(3);
  const { d } = mk({ printers, info: p => (p.name === "P1" ? new Promise(() => {}) : okRow(p)) });
  const pending = d.call({});
  await settle();
  assert.deepEqual(d.timers.created.map(t => t.ms), [20000, 20000, 20000], "one timer per printer read");
  assert.equal(d.timers.created.filter(t => t.cleared).length, 2, "the two that answered cleared theirs");
  d.timers.created.find(t => !t.cleared).fn();
  const r = await within(pending, 2000);
  assert.notEqual(r, "STILL PENDING");
  assert.deepEqual(r.json, [decorated(printers[0], 0),
    { id: 1, pid: "p_1", connector: "u1", uniformMcuVersions: false, name: "P1", online: true, skipped: true, reason: "did not answer within 20s", reasonCode: "timeout" },
    decorated(printers[2], 2)]);
  assert.equal(d.timers.created.filter(t => t.cleared).length, 3);
});
test("6. a connector that fails: an error row with the message as reason and detail, and the timer is cleared", async () => {
  const { d } = mk({ printers: [P], info: async () => { throw new Error("ECONNREFUSED 10.0.0.9"); } });
  const r = await d.call({ printer: "0" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ...head, name: "Xray", online: true, skipped: true, reason: "ECONNREFUSED 10.0.0.9", reasonCode: "error", detail: "ECONNREFUSED 10.0.0.9" });
  assert.deepEqual(d.timers.created.map(t => t.ms), [20000]);
  assert.equal(d.timers.cleared.length, 1);
  assert.equal(d.timers.cleared[0], d.timers.created[0], "cleared after the failure");
  const blank = await mk({ printers: [P], info: async () => { throw new Error(""); } }).d.call({ printer: "0" });
  assert.deepEqual(blank.json, { ...head, name: "Xray", online: true, skipped: true, reason: "read failed", reasonCode: "error", detail: "" });
});
test("6. a connector that throws before returning a promise: the same error row; no timer was created", async () => {
  const { d } = mk({ printers: [P], info: () => { throw new Error("not even async"); } });
  const r = await d.call({ printer: "0" });
  assert.deepEqual(r.json, { ...head, name: "Xray", online: true, skipped: true, reason: "not even async", reasonCode: "error", detail: "not even async" });
  assert.deepEqual(d.timers.created, []);
  assert.deepEqual(d.timers.cleared, [undefined], "clearTimeout still runs, with nothing to clear");
});

// ---------- 7. configuration reload ----------
test("7. a printer list REPLACED by a reload is what the next request reads — single read, list and stream", async () => {
  const before = [{ id: "p_old", name: "Old", connector: "u1" }];
  const after = [{ id: "p_new0", name: "New 0", connector: "u1" }, { id: "p_new1", name: "New 1", connector: "u1" }];
  const { d, log } = mk({ printers: before });
  assert.equal((await d.call({ printer: "0" })).json.pid, "p_old");
  assert.equal((await d.call({ printer: "1" })).status, 404);
  assert.deepEqual((await d.call({})).json.map(r => r.pid), ["p_old"]);
  assert.deepEqual((await d.call({ stream: "1" })).lines[0], { total: 1, read: 0 });
  d.setPrinters(after);                                              // a new array, as loadConfig() assigns one
  log.probe.length = 0;
  assert.equal((await d.call({ printer: "0" })).json.pid, "p_new0");
  const one = await d.call({ printer: "1" });
  assert.equal(one.status, 200);
  assert.equal(one.json.pid, "p_new1");
  assert.deepEqual((await d.call({})).json.map(r => r.pid), ["p_new0", "p_new1"]);
  const s = await d.call({ stream: "1" });
  assert.deepEqual(s.lines[0], { total: 2, read: 0 });
  assert.deepEqual(s.lines[2].rows.map(r => r.name), ["New 0", "New 1"]);
  assert.equal(log.probe.includes("Old"), false, "the replaced list is never read again");
  d.setPrinters([]);
  assert.equal((await d.call({ printer: "0" })).status, 404);
  assert.deepEqual((await d.call({})).json, []);
});
