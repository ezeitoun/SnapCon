// test/helpers/fakeBambuBroker.js — a stand-in for the MQTT broker a Bambu Lab
// printer runs on port 8883, just faithful enough for the connector's tests:
// checks the bblp/<access code> login, acknowledges the subscription, answers
// a `pushall` request with a full push_status report and `get_version` with a
// module list, and records every request the client publishes so a test can
// assert the connector never sends the printer anything else.
//
// Works over a plain net.Server (most tests, via the connector's
// setTransportFactory hook) or a tls.Server (the TLS verification test) —
// pass `createServer` to choose.
const net = require("net");
const { _internal: mq } = require("../../connectors/bambu-mqtt");

function readString(buf, offset) {
  const len = buf.readUInt16BE(offset);
  return { value: buf.subarray(offset + 2, offset + 2 + len).toString("utf8"), next: offset + 2 + len };
}

function decodeConnect(body) {
  let o = readString(body, 0).next;       // protocol name
  const flags = body[o + 1];
  o += 4;                                  // level, flags, keepalive(2)
  const clientId = readString(body, o); o = clientId.next;
  let username = null, password = null;
  if (flags & 0x80) { const u = readString(body, o); username = u.value; o = u.next; }
  if (flags & 0x40) { const p = readString(body, o); password = p.value; o = p.next; }
  return { clientId: clientId.value, username, password };
}

function frame(firstByte, body) {
  return Buffer.concat([Buffer.from([firstByte]), mq.encodeRemainingLength(body.length), body]);
}

function createFakeBambuBroker({ serial, accessCode, report, version, createServer = (h) => net.createServer(h) } = {}) {
  const state = {
    logins: [],          // { clientId, username, password, accepted }
    subscriptions: [],   // topic strings
    requests: [],        // parsed JSON of every client PUBLISH
    sockets: new Set(),
    answerPushall: true,
    answerPings: true,
    dropAfterSubscribe: false
  };
  let currentReport = report;

  function sendReport(sock, printObj, full = true) {
    const payload = JSON.stringify({ print: { ...printObj, command: "push_status", ...(full ? { msg: 0 } : { msg: 1 }) } });
    sock.write(mq.encodePublish(`device/${serial}/report`, payload));
  }

  const server = createServer((sock) => {
    state.sockets.add(sock);
    let buf = Buffer.alloc(0);
    let authed = false;
    sock.on("error", () => {});
    sock.on("close", () => state.sockets.delete(sock));
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { packets, rest } = mq.splitPackets(buf);
      buf = Buffer.from(rest);
      for (const pk of packets) {
        if (pk.type === mq.TYPE.CONNECT) {
          const c = decodeConnect(pk.body);
          const accepted = c.username === "bblp" && c.password === accessCode;
          state.logins.push({ ...c, accepted });
          sock.write(frame(mq.TYPE.CONNACK << 4, Buffer.from([0, accepted ? 0 : 5])));
          if (!accepted) sock.end(); else authed = true;
        } else if (!authed) {
          sock.destroy();
        } else if (pk.type === mq.TYPE.SUBSCRIBE) {
          const id = pk.body.readUInt16BE(0);
          const topic = readString(pk.body, 2).value;
          state.subscriptions.push(topic);
          const ack = Buffer.alloc(3); ack.writeUInt16BE(id, 0); ack[2] = topic === `device/${serial}/report` ? 0 : 0x80;
          sock.write(frame(mq.TYPE.SUBACK << 4, ack));
          // Accept-then-drop: what a printer at its connection limit, or one
          // kicking a duplicate session, looks like from the client side.
          if (state.dropAfterSubscribe) setTimeout(() => sock.destroy(), 20);
        } else if (pk.type === mq.TYPE.PUBLISH) {
          const msg = mq.decodePublish(pk.flags, pk.body);
          let json = null;
          try { json = JSON.parse(msg.payload.toString("utf8")); } catch {}
          state.requests.push({ topic: msg.topic, json });
          if (json && json.pushing && json.pushing.command === "pushall" && state.answerPushall && currentReport) sendReport(sock, currentReport, true);
          if (json && json.info && json.info.command === "get_version" && version) {
            sock.write(mq.encodePublish(`device/${serial}/report`, JSON.stringify({ info: { command: "get_version", module: version } })));
          }
        } else if (pk.type === mq.TYPE.PINGREQ) {
          if (state.answerPings) sock.write(Buffer.from([mq.TYPE.PINGRESP << 4, 0]));
        } else if (pk.type === 14) {
          sock.end();
        }
      }
    });
  });

  return {
    state,
    server,
    listen: () => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    // Push a report to every connected client, as the printer does on its own.
    push(printObj, { full = false } = {}) { for (const s of state.sockets) sendReport(s, printObj, full); },
    setReport(r) { currentReport = r; },
    dropAll() { for (const s of state.sockets) s.destroy(); },
    close: () => new Promise(resolve => { for (const s of state.sockets) s.destroy(); server.close(() => resolve()); })
  };
}

module.exports = { createFakeBambuBroker };
