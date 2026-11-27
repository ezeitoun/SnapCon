// test/connectors/virtual-u1-connector.test.js — the Virtual U1 printer type
// (connectors/virtual-u1.js): one simulator per port, started on the first
// call, reached through the real U1 connector over the network, closed when
// no call has reached it for a while.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const vu1 = require("../../connectors/virtual-u1");
const connectors = require("../../connectors");

// A port nothing listens on right now.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
let nextId = 0;
async function printer(t, extra = {}) {
  const port = extra.port || await freePort();
  t.after(() => vu1._closeAll());
  return { id: "vu1-test-" + (++nextId), name: "VU1 #" + nextId, connector: "virtual-u1", ip: "127.0.0.1", port, url: "http://127.0.0.1:" + port, ...extra };
}
const simOn = port => vu1._sims.get(port);
async function waitClosed(port, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    const ok = await new Promise(r => { const c = net.connect(port, "127.0.0.1"); c.once("connect", () => { c.destroy(); r(false); }); c.once("error", () => r(true)); });
    if (ok) return;
    if (Date.now() > end) throw new Error("port " + port + " still open");
    await new Promise(r => setTimeout(r, 20));
  }
}

test("registered, virtual, Port-only on this machine, without discovery or firmware deploy", () => {
  assert.ok(connectors.CONNECTOR_TYPES.includes("virtual-u1"));
  assert.equal(connectors.isVirtualType("virtual-u1"), true);
  const t = connectors.listConnectorTypes().find(c => c.type === "virtual-u1");
  assert.equal(t.label, "Virtual U1");
  assert.equal(t.brand, "SnapMaker", "a U1 file matches it as it matches a real U1");
  assert.deepEqual(t.address, { scheme: "http", defaultPort: 7125, portEditable: true, required: true, fixedHost: "127.0.0.1" });
  assert.deepEqual(t.virtualOptions.timing, ["fast", "real"]);
  assert.ok(t.virtualOptions.firmware.includes("2.0.0") && t.virtualOptions.firmware.includes("1.6.0"));
  assert.equal(t.capabilities.discovery, false);
  assert.equal(t.capabilities.firmwareDeploy, false);
  assert.equal(t.capabilities.filamentHeads, true, "otherwise a U1's");
});

test("the first call starts the printer's simulator on its port, and it answers as a U1", async t => {
  const p = await printer(t);
  const st = await vu1.probe(p);
  assert.equal(st.online, true);
  assert.equal(st.state, "standby");
  assert.ok(simOn(p.port).sim, "running on the printer's port");
  assert.equal(simOn(p.port).sim.model.firmware, "2.0.0", "the newest firmware by default");
  assert.equal(simOn(p.port).sim.model.timing, "fast");
  const files = await vu1.listFiles(p);
  assert.ok(files.some(f => /Virtual cube/.test(f.name || f.path || JSON.stringify(f))), "its sample files");
});

test("two Virtual U1s on two ports are two printers", async t => {
  const a = await printer(t), b = await printer(t);
  await vu1.probe(a); await vu1.probe(b);
  await vu1.startPrintFile(a, "Virtual cube (single colour).gcode");
  // Fast prints 10x: 3s is 30s into the 200s cube.
  simOn(a.port).sim.model.advance(3);
  assert.equal((await vu1.probe(a)).state, "printing");
  assert.equal((await vu1.probe(b)).state, "standby");
  assert.notEqual(simOn(a.port).sim, simOn(b.port).sim);
});

test("firmware and timing come from the printer, and a change restarts its simulator", async t => {
  const p = await printer(t, { virtualFirmware: "1.6.0", virtualTiming: "real" });
  await vu1.probe(p);
  const first = simOn(p.port).sim;
  assert.equal(first.model.firmware, "1.6.0");
  assert.equal(first.model.timing, "real");
  await vu1.probe({ ...p, virtualTiming: "fast" });
  assert.notEqual(simOn(p.port).sim, first);
  assert.equal(simOn(p.port).sim.model.timing, "fast");
  // An unknown value falls back to the default, never to whatever was typed.
  await vu1.probe({ ...p, virtualFirmware: "9.9.9", virtualTiming: "fast" });
  assert.equal(simOn(p.port).sim.model.firmware, "2.0.0");
});

test("a port held by something else: offline with the reason, nothing is sent to it", async t => {
  const port = await freePort();
  const seen = [];
  const other = net.createServer(sock => { seen.push(1); sock.destroy(); });
  await new Promise(r => other.listen(port, "127.0.0.1", r));
  t.after(() => new Promise(r => other.close(r)));
  const p = await printer(t, { port });
  const st = await vu1.probe(p);
  assert.equal(st.online, false);
  assert.match(st.error, new RegExp(`Port ${port} is already in use on this machine`));
  await assert.rejects(vu1.pause(p), /already in use/, "a command fails with the reason, not a crash");
  assert.equal(seen.length, 0, "the U1 connector never talked to the other program");
});

test("two Virtual U1s on one port: the second is told, the first keeps running", async t => {
  const a = await printer(t);
  const b = await printer(t, { port: a.port });
  assert.equal((await vu1.probe(a)).online, true);
  const st = await vu1.probe(b);
  assert.equal(st.online, false);
  assert.match(st.error, new RegExp(`Port ${a.port} is used by another Virtual U1 \\(${a.name}\\)`));
  assert.equal((await vu1.probe(a)).online, true);
});

test("Test connection (a row with no saved id) reaches the simulator the printer runs", async t => {
  const p = await printer(t);
  await vu1.probe(p);
  const sim = simOn(p.port).sim;
  const st = await vu1.probe({ url: p.url, name: p.name });
  assert.equal(st.online, true);
  assert.equal(simOn(p.port).sim, sim, "not a second simulator, not a restart");
});

test("a simulator no call reaches for a while is closed and its port freed", async t => {
  const p = await printer(t);
  await vu1.probe(p);
  vu1._closeIdle(Date.now() + 1000);
  assert.ok(simOn(p.port), "still in use");
  vu1._closeIdle(Date.now() + vu1._IDLE_CLOSE_MS + 1000);
  assert.equal(simOn(p.port), undefined);
  await waitClosed(p.port);
  // Back on the next call, from scratch.
  assert.equal((await vu1.probe(p)).online, true);
});
