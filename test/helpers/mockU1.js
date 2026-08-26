// test/helpers/mockU1.js — the smallest printer that connectors/snapmaker-u1-firmware.js
// will talk to. NOT a printer simulator: it answers exactly the calls
// updateFromFile() makes, in the shapes that module already parses, and records
// what it was asked to do so a test can assert on it.
//
// It exists because the pre-flash safety gate cannot be proven by reading source
// order — the only convincing evidence is that startLocalUpgrade never reaches
// the wire when the printer turns busy mid-upload.
//
// Node 22 ships a WebSocket *client* (used by the module) but no server, so the
// upgrade handshake and a minimal frame codec are implemented here. Only what
// this flow needs: single-frame text messages, no fragmentation, no compression,
// no ping/pong.
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ---- minimal frame codec (text, single frame, no extensions) ----
function encodeText(str) {
  const payload = Buffer.from(str, "utf8");
  const head = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b; })()]);
  return Buffer.concat([head, payload]);
}
// Returns [message, rest] or null when a whole frame is not buffered yet.
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const len0 = buf[1] & 0x7f;
  const masked = (buf[1] & 0x80) !== 0;
  let offset = 2, len = len0;
  if (len0 === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len0 === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  let mask = null;
  if (masked) { if (buf.length < offset + 4) return null; mask = buf.subarray(offset, offset + 4); offset += 4; }
  if (buf.length < offset + len) return null;
  const data = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  return [data.toString("utf8"), buf.subarray(offset + len)];
}

// opts:
//   file    Buffer  the firmware bytes the printer will hand back on read-back
//   name    string  the stored file name
//   version string  fullversion reported by system.get_device_info
//   onUpgrade fn    called when system.upgrade is published (the flash!)
async function startMockU1({ file, name = "fw.bin", version = "1.5.2.13", onUpgrade = () => {} } = {}) {
  const calls = { upgrade: [], uploads: 0, reads: 0, deviceInfo: 0 };
  let flashing = false;   // set once system.upgrade is published
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };

    if (url.pathname === "/server/files/roots") {
      return json({ result: [{ name: "gcodes", path: "/userdata/gcodes" }] });
    }
    if (url.pathname === "/server/files/directory") {
      // free space: generous, so uploadFirmware's precheck passes
      return json({ result: { disk_usage: { free: 8e9 } } });
    }
    if (url.pathname === "/server/files/upload" && req.method === "POST") {
      // Drain the multipart body; the bytes themselves are irrelevant here —
      // the read-back below is what verifyFirmware actually compares.
      for await (const _ of req) { /* discard */ }
      calls.uploads++;
      return json({ result: { item: { path: name, size: file.length } } });
    }
    if (url.pathname === "/server/files/gcodes/" + encodeURIComponent(name) ||
        url.pathname === "/server/files/gcodes/" + name) {
      calls.reads++;
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": file.length });
      return res.end(file);
    }
    res.writeHead(404).end("not found");
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + crypto.createHash("sha1").update(key + WS_GUID).digest("base64") + "\r\n\r\n");
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));

    let buf = Buffer.alloc(0);
    // mqttRpc subscribes (id 1) then publishes (id 2); the answer it waits for
    // is the SUBSCRIBE reply carrying the response payload.
    let pendingSub = null;
    socket.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const got = decodeFrame(buf);
        if (!got) break;
        buf = got[1];
        let msg; try { msg = JSON.parse(got[0]); } catch { continue; }

        if (msg.method === "server.mqtt.subscribe") {
          // A real flash takes the services down to write the image, so the
          // watch socket dies rather than being answered. watchUpgrade treats
          // that as the expected outcome; reproducing it keeps the test honest
          // (and fast) instead of waiting out a timeout that never happens on
          // real hardware.
          if (flashing && msg.params && msg.params.topic === "system/notification") {
            setTimeout(() => { try { socket.destroy(); } catch {} }, 10);
            continue;
          }
          pendingSub = msg.id; continue;
        }
        if (msg.method !== "server.mqtt.publish") continue;

        const env = msg.params && msg.params.payload;
        const method = env && env.method;
        if (method === "system.get_device_info") calls.deviceInfo++;
        if (method === "system.upgrade") { calls.upgrade.push(env.params); flashing = true; onUpgrade(env.params); }

        const result = method === "system.get_device_info"
          ? { fullversion: version, version }
          : { state: "success" };   // unisrv acks even a bad path — the module knows this
        if (pendingSub !== null) {
          socket.write(encodeText(JSON.stringify({
            jsonrpc: "2.0", id: pendingSub,
            result: { payload: { jsonrpc: "2.0", id: env.id, result } },
          })));
          pendingSub = null;
        }
      }
    });
    socket.on("error", () => {});
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  return {
    calls,
    printer: { name: "MOCK U1", url: `http://127.0.0.1:${port}`, token: "" },
    async close() {
      for (const s of sockets) { try { s.destroy(); } catch {} }
      await new Promise(r => server.close(r));
    },
  };
}

module.exports = { startMockU1 };
