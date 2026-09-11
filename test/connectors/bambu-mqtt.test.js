// test/connectors/bambu-mqtt.test.js — the minimal MQTT 3.1.1 client the Bambu
// Lab connector is built on. Pure codec checks first, then the client against
// a real socket (test/helpers/fakeBambuBroker.js) — framing bugs only show up
// when a large report arrives split across TCP chunks, so that is exercised
// explicitly rather than trusted.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { MqttClient, _internal: mq } = require("../../connectors/bambu-mqtt");
const { createFakeBambuBroker } = require("../helpers/fakeBambuBroker");

// ---- codec ----

test("remaining length round-trips across every encoding width", () => {
  for (const n of [0, 1, 127, 128, 16383, 16384, 2097151, 2097152, 268435455]) {
    const enc = mq.encodeRemainingLength(n);
    const dec = mq.decodeRemainingLength(Buffer.concat([enc, Buffer.from([0xff])]), 0);
    assert.deepEqual(dec, { value: n, bytes: enc.length }, "n=" + n);
  }
});

test("a truncated length field asks for more bytes instead of guessing", () => {
  assert.equal(mq.decodeRemainingLength(Buffer.from([0x80]), 0), null);
});

test("a five-byte length field is rejected as malformed", () => {
  assert.throws(() => mq.decodeRemainingLength(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x01]), 0), /malformed/);
});

test("splitPackets returns whole packets and keeps a partial tail for the next chunk", () => {
  const a = mq.encodePublish("t/a", "hello");
  const b = mq.encodePublish("t/b", "x".repeat(300));
  const joined = Buffer.concat([a, b]);
  const cut = a.length + 5;
  const first = mq.splitPackets(joined.subarray(0, cut));
  assert.equal(first.packets.length, 1);
  assert.equal(first.rest.length, 5);
  const second = mq.splitPackets(Buffer.concat([first.rest, joined.subarray(cut)]));
  assert.equal(second.packets.length, 1);
  assert.equal(second.rest.length, 0);
  const pub = mq.decodePublish(second.packets[0].flags, second.packets[0].body);
  assert.equal(pub.topic, "t/b");
  assert.equal(pub.payload.toString(), "x".repeat(300));
});

test("an absurdly large packet is refused instead of buffered", () => {
  const huge = Buffer.concat([Buffer.from([0x30]), mq.encodeRemainingLength(mq.MAX_PACKET_BYTES + 1)]);
  assert.throws(() => mq.splitPackets(huge), /too large/);
});

test("CONNECT carries clean-session, username and password flags", () => {
  const pk = mq.encodeConnect({ clientId: "c1", username: "bblp", password: "12345678", keepaliveSec: 30 });
  const { packets } = mq.splitPackets(pk);
  assert.equal(packets[0].type, mq.TYPE.CONNECT);
  const body = packets[0].body;
  assert.equal(body.subarray(2, 6).toString(), "MQTT");
  assert.equal(body[6], 4, "protocol level 4 = MQTT 3.1.1");
  assert.equal(body[7], 0x80 | 0x40 | 0x02);
  assert.equal(body.readUInt16BE(8), 30);
});

// ---- client against a real socket ----

const SERIAL = "TESTSERIAL0001";
const CODE = "a1b2c3d4";

async function withBroker(opts, fn) {
  const broker = createFakeBambuBroker({ serial: SERIAL, accessCode: CODE, ...opts });
  const port = await broker.listen();
  try { await fn(broker, port); } finally { await broker.close(); }
}

function client(port, over = {}) {
  return new MqttClient({
    createStream: () => net.connect(port, "127.0.0.1"),
    clientId: "snapcon-test", username: "bblp", password: CODE, keepaliveSec: 30, connectTimeoutMs: 3000, ...over
  });
}

test("connects, subscribes and receives a report split across many TCP chunks", async () => {
  await withBroker({}, async (broker, port) => {
    const c = client(port);
    await c.connect();
    assert.equal(c.connected, true);
    await c.subscribe(`device/${SERIAL}/report`);
    assert.deepEqual(broker.state.subscriptions, [`device/${SERIAL}/report`]);

    // ~60 KB, the size class of a real H2D pushall, written a few bytes at a
    // time so the client's reassembly is what gets tested.
    const big = { print: { command: "push_status", filler: "y".repeat(60000) } };
    const pkt = mq.encodePublish(`device/${SERIAL}/report`, JSON.stringify(big));
    const got = new Promise(resolve => c.once("message", (topic, payload) => resolve({ topic, payload })));
    const [sock] = broker.state.sockets;
    for (let i = 0; i < pkt.length; i += 997) sock.write(pkt.subarray(i, i + 997));
    const { topic, payload } = await got;
    assert.equal(topic, `device/${SERIAL}/report`);
    assert.equal(JSON.parse(payload.toString()).print.filler.length, 60000);
    c.end();
  });
});

test("publishes reach the broker as QoS 0 JSON", async () => {
  await withBroker({}, async (broker, port) => {
    const c = client(port);
    await c.connect();
    c.publish(`device/${SERIAL}/request`, { pushing: { command: "pushall" } });
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(broker.state.requests.map(r => r.json), [{ pushing: { command: "pushall" } }]);
    c.end();
  });
});

test("a wrong access code rejects connect() with the broker's return code", async () => {
  await withBroker({}, async (_broker, port) => {
    const c = client(port, { password: "wrong" });
    await assert.rejects(c.connect(), e => e.code === "ECONNACK" && e.returnCode === 5);
    assert.equal(c.connected, false);
  });
});

test("\"close\" fires exactly once whatever ends the session", async () => {
  await withBroker({}, async (broker, port) => {
    const c = client(port);
    let closes = 0;
    c.on("close", () => closes++);
    await c.connect();
    broker.dropAll();
    await new Promise(r => setTimeout(r, 80));
    c.end();
    assert.equal(closes, 1);
  });
});

test("a connection refused before any handshake rejects connect()", async () => {
  const srv = net.createServer();
  const port = await new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  await new Promise(r => srv.close(r));
  const c = client(port);
  await assert.rejects(c.connect(), e => e.code === "ECONNREFUSED");
});

test("a broker that stops answering pings is dropped by the keepalive", async () => {
  await withBroker({}, async (broker, port) => {
    const c = client(port, { keepaliveSec: 1 });
    await c.connect();
    broker.state.answerPings = false;
    const err = await new Promise(resolve => c.once("close", resolve));
    assert.equal(err && err.code, "ETIMEDOUT");
  });
});
