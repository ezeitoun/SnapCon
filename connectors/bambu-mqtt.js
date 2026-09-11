// connectors/bambu-mqtt.js — the smallest MQTT 3.1.1 client the Bambu Lab
// connector needs, and nothing more: CONNECT with username/password, one
// SUBSCRIBE, QoS 0 PUBLISH in both directions, PINGREQ keepalive, DISCONNECT.
//
// Why not the `mqtt` npm package: SnapCon ships with exactly one runtime
// dependency (express) and is packaged into single-file desktop binaries with
// pkg. A full MQTT stack (plus its transitive dependencies) for what is, on
// this path, a read-only status subscription to one broker per printer would
// be most of the dependency tree. The protocol subset used here is small,
// fixed, and covered by test/connectors/bambu-mqtt.test.js against a real
// socket.
//
// Transport-agnostic on purpose: the caller hands in a function that returns
// an already-connecting Duplex stream (a TLS socket to the printer in
// production, a plain TCP socket to a fake broker in tests), so none of the
// certificate handling below this layer leaks into the protocol code.
const { EventEmitter } = require("events");

const TYPE = {
  CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, SUBSCRIBE: 8, SUBACK: 9,
  PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14
};

// A Bambu status push is tens of KB. Anything in the megabytes is not a
// status report — it is a desynchronised stream or something that is not an
// MQTT broker at all — and buffering it would only grow memory.
const MAX_PACKET_BYTES = 4 * 1024 * 1024;

// CONNACK return codes (MQTT 3.1.1 §3.2.2.3). 4 and 5 are the ones a printer
// actually sends for a wrong LAN access code.
const CONNACK_REASONS = {
  1: "unacceptable protocol version",
  2: "client identifier rejected",
  3: "server unavailable",
  4: "bad user name or password",
  5: "not authorized"
};

function encodeRemainingLength(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

// Returns { value, bytes } or null when the buffer does not yet hold the whole
// length field. Throws on a malformed (more than four byte) field.
function decodeRemainingLength(buf, offset) {
  let value = 0, multiplier = 1;
  for (let i = 0; i < 4; i++) {
    if (offset + i >= buf.length) return null;
    const byte = buf[offset + i];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, bytes: i + 1 };
    multiplier *= 128;
  }
  throw new Error("malformed MQTT remaining length");
}

function mqttString(s) {
  const b = Buffer.from(String(s), "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length, 0);
  return Buffer.concat([len, b]);
}

function packet(firstByte, body) {
  return Buffer.concat([Buffer.from([firstByte]), encodeRemainingLength(body.length), body]);
}

function encodeConnect({ clientId, username, password, keepaliveSec }) {
  let flags = 0x02; // clean session
  if (username != null) flags |= 0x80;
  if (password != null) flags |= 0x40;
  const ka = Buffer.alloc(2);
  ka.writeUInt16BE(keepaliveSec, 0);
  const parts = [mqttString("MQTT"), Buffer.from([4, flags]), ka, mqttString(clientId)];
  if (username != null) parts.push(mqttString(username));
  if (password != null) parts.push(mqttString(password));
  return packet(TYPE.CONNECT << 4, Buffer.concat(parts));
}

function encodeSubscribe(packetId, topic) {
  const id = Buffer.alloc(2);
  id.writeUInt16BE(packetId, 0);
  // Fixed-header flags for SUBSCRIBE are mandated as 0b0010.
  return packet((TYPE.SUBSCRIBE << 4) | 0x02, Buffer.concat([id, mqttString(topic), Buffer.from([0])]));
}

function encodePublish(topic, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return packet(TYPE.PUBLISH << 4, Buffer.concat([mqttString(topic), body]));
}

function encodePuback(packetId) {
  const id = Buffer.alloc(2);
  id.writeUInt16BE(packetId, 0);
  return packet(TYPE.PUBACK << 4, id);
}

const PINGREQ = Buffer.from([TYPE.PINGREQ << 4, 0]);
const DISCONNECT = Buffer.from([TYPE.DISCONNECT << 4, 0]);

// Pulls every complete packet off the front of `buf`. Returns the packets and
// whatever partial tail is left over for the next chunk.
function splitPackets(buf) {
  const packets = [];
  let offset = 0;
  while (buf.length - offset >= 2) {
    const len = decodeRemainingLength(buf, offset + 1);
    if (!len) break;
    if (len.value > MAX_PACKET_BYTES) throw new Error("MQTT packet too large (" + len.value + " bytes)");
    const start = offset + 1 + len.bytes;
    if (buf.length < start + len.value) break;
    packets.push({ type: buf[offset] >> 4, flags: buf[offset] & 0x0f, body: buf.subarray(start, start + len.value) });
    offset = start + len.value;
  }
  return { packets, rest: buf.subarray(offset) };
}

function decodePublish(flags, body) {
  const qos = (flags >> 1) & 0x03;
  const topicLen = body.readUInt16BE(0);
  const topic = body.subarray(2, 2 + topicLen).toString("utf8");
  let offset = 2 + topicLen, packetId = null;
  if (qos > 0) { packetId = body.readUInt16BE(offset); offset += 2; }
  return { topic, qos, packetId, payload: body.subarray(offset) };
}

// Events: "message" (topic, payloadBuffer), "close" (Error|null). "close" is
// emitted exactly once, whatever ended the session.
class MqttClient extends EventEmitter {
  constructor({ createStream, clientId, username, password, keepaliveSec = 30, connectTimeoutMs = 10000 }) {
    super();
    this._createStream = createStream;
    this._opts = { clientId, username, password, keepaliveSec };
    this._connectTimeoutMs = connectTimeoutMs;
    this._sock = null;
    this._buf = Buffer.alloc(0);
    this._nextPacketId = 1;
    this._pendingSub = new Map();
    this._connected = false;
    this._closed = false;
    this._lastRx = 0;
    this._pingTimer = null;
  }

  get connected() { return this._connected && !this._closed; }

  // Resolves once the broker has accepted the session (CONNACK rc 0). Rejects
  // with an Error carrying `.code` = "ECONNACK" and `.returnCode` when the
  // broker refuses, so a wrong access code is distinguishable from a network
  // failure without string matching.
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { reject(err); this._destroy(err); } else resolve();
      };
      const timer = setTimeout(() => done(Object.assign(new Error("MQTT connect timed out"), { code: "ETIMEDOUT" })), this._connectTimeoutMs);
      if (timer.unref) timer.unref();
      let sock;
      try { sock = this._createStream(); }
      catch (e) { done(e); return; }
      this._sock = sock;
      this._onConnack = (rc) => {
        if (rc === 0) { this._connected = true; this._startKeepalive(); done(null); }
        else done(Object.assign(new Error("MQTT connection refused: " + (CONNACK_REASONS[rc] || "code " + rc)), { code: "ECONNACK", returnCode: rc }));
      };
      // A socket that dies before CONNACK must reject connect(); one that dies
      // afterwards is a normal "close".
      this._onEarlyClose = (err) => done(err || new Error("connection closed before MQTT handshake completed"));
      sock.on("data", (chunk) => this._onData(chunk));
      sock.on("error", (err) => { if (!this._connected) this._onEarlyClose(err); this._destroy(err); });
      sock.on("close", () => { if (!this._connected) this._onEarlyClose(null); this._destroy(null); });
      // CONNECT carries the password (a Bambu printer's LAN access code), so
      // it is written only once the stream is really ready: for TLS that is
      // "secureConnect", which Node emits only AFTER the server certificate
      // passed verification (rejectUnauthorized + checkServerIdentity). A
      // write queued before the handshake could otherwise be flushed by the
      // TLS layer the moment the handshake completes — before the JS-side
      // identity check has had its say. Plain sockets wait for "connect".
      const sendConnect = () => { try { sock.write(encodeConnect(this._opts)); } catch (e) { done(e); } };
      if (sock.encrypted) sock.once("secureConnect", sendConnect);
      else if (sock.connecting) sock.once("connect", sendConnect);
      else sendConnect();
    });
  }

  subscribe(topic, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.connected) { reject(new Error("MQTT not connected")); return; }
      const id = this._takePacketId();
      const timer = setTimeout(() => { this._pendingSub.delete(id); reject(new Error("MQTT subscribe timed out")); }, timeoutMs);
      if (timer.unref) timer.unref();
      this._pendingSub.set(id, (codes) => {
        clearTimeout(timer);
        if (codes.some(c => c === 0x80)) reject(new Error("MQTT subscription to " + topic + " was refused"));
        else resolve(codes);
      });
      this._write(encodeSubscribe(id, topic));
    });
  }

  publish(topic, payload) {
    if (!this.connected) return false;
    return this._write(encodePublish(topic, payload));
  }

  end() {
    if (this._closed) return;
    if (this._connected) this._write(DISCONNECT);
    try { this._sock && this._sock.end(); } catch {}
    this._destroy(null);
  }

  // Packet identifiers are 1..65535; 0 is not a valid id.
  _takePacketId() {
    const id = this._nextPacketId;
    this._nextPacketId = id >= 0xffff ? 1 : id + 1;
    return id;
  }

  _write(buf) {
    try { this._sock.write(buf); return true; }
    catch (e) { this._destroy(e); return false; }
  }

  _startKeepalive() {
    const ka = this._opts.keepaliveSec;
    if (!ka) return;
    this._lastRx = Date.now();
    // Ping at half the keepalive interval; give up once nothing at all has
    // arrived for 1.5x the interval (the spec's own broker-side rule, applied
    // from our end so a silently dead TCP session is noticed).
    this._pingTimer = setInterval(() => {
      if (Date.now() - this._lastRx > ka * 1500) {
        this._destroy(Object.assign(new Error("MQTT keepalive timed out"), { code: "ETIMEDOUT" }));
        return;
      }
      this._write(PINGREQ);
    }, Math.max(1000, ka * 500));
    if (this._pingTimer.unref) this._pingTimer.unref();
  }

  _onData(chunk) {
    this._lastRx = Date.now();
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    let split;
    try { split = splitPackets(this._buf); }
    catch (e) { this._destroy(e); return; }
    this._buf = Buffer.from(split.rest);
    for (const pk of split.packets) {
      try { this._handle(pk); }
      catch (e) { this._destroy(e); return; }
    }
  }

  _handle(pk) {
    switch (pk.type) {
      case TYPE.CONNACK:
        if (this._onConnack) { const cb = this._onConnack; this._onConnack = null; cb(pk.body[1]); }
        break;
      case TYPE.SUBACK: {
        const id = pk.body.readUInt16BE(0);
        const cb = this._pendingSub.get(id);
        if (cb) { this._pendingSub.delete(id); cb([...pk.body.subarray(2)]); }
        break;
      }
      case TYPE.PUBLISH: {
        const msg = decodePublish(pk.flags, pk.body);
        // We only ever subscribe at QoS 0, but a broker may still deliver at
        // QoS 1; acknowledging keeps it from redelivering forever.
        if (msg.qos === 1 && msg.packetId != null) this._write(encodePuback(msg.packetId));
        this.emit("message", msg.topic, msg.payload);
        break;
      }
      default:
        // PINGRESP and anything else: receiving it already refreshed _lastRx.
        break;
    }
  }

  _destroy(err) {
    if (this._closed) return;
    this._closed = true;
    this._connected = false;
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    for (const cb of this._pendingSub.values()) { try { cb([0x80]); } catch {} }
    this._pendingSub.clear();
    try { this._sock && this._sock.destroy(); } catch {}
    this.emit("close", err || null);
  }
}

module.exports = {
  MqttClient,
  _internal: { encodeRemainingLength, decodeRemainingLength, encodeConnect, encodeSubscribe, encodePublish, splitPackets, decodePublish, TYPE, MAX_PACKET_BYTES }
};
