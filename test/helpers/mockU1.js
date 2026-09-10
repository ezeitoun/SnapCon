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

const zlib = require("node:zlib");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// A real store-only zip. verifyFirmware's default ("crc") asks the printer to
// archive the uploaded file and then reads the CRC-32 straight out of the
// archive's central directory, so a mock that faked the endpoint would prove
// nothing — the bytes have to actually parse.
function storeOnlyZip(name, data) {
  const nameBuf = Buffer.from(name, "latin1");
  const crc = zlib.crc32(data) >>> 0;

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);          // version needed
  local.writeUInt16LE(0, 6);           // flags
  local.writeUInt16LE(0, 8);           // method 0 = stored
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);  // compressed == uncompressed
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);

  const cd = Buffer.alloc(46 + nameBuf.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);             // version made by
  cd.writeUInt16LE(20, 6);             // version needed
  cd.writeUInt16LE(0, 8);              // flags
  cd.writeUInt16LE(0, 10);             // method 0 = stored
  cd.writeUInt32LE(crc, 16);           // <- what parseZipCentralDirectory reads
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);   // <- and the size it reads
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42);             // local header offset
  nameBuf.copy(cd, 46);

  const cdOffset = local.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);            // entries on this disk
  eocd.writeUInt16LE(1, 10);           // entries total
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([local, data, cd, eocd]);
}

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
//   version string  the printer's BUILD, exactly as a real U1 reports it in
//                   fullversion: "<version>.<build>_<stamp>". The truncated
//                   three-part string the device reports in its `version`
//                   field is derived from it — see the reply below.
//   onUpgrade fn    called when system.upgrade is published (the flash!)
//   noZip   bool    refuse /server/files/zip, so verifyFirmware falls back to
//                   windowed sampling the way older printer firmware would
async function startMockU1({ file, name = "fw.bin", version = "1.5.2.13_20260722102206", onUpgrade = () => {}, noZip = false } = {}) {
  // uploadBody/uploadBytes/uploadPath record what the upload REQUEST actually
  // carried. The connector switched from fetch+Blob to a streaming uploader;
  // the only way to show the image still lands in the same place with the same
  // bytes is to look at what arrived, not at what the caller intended.
  const calls = { upgrade: [], uploads: 0, reads: 0, deviceInfo: 0, ranges: 0, zips: 0, deletes: [],
                  uploadBytes: 0, uploadHeader: "", uploadPath: null, uploadContentLength: null };
  // Scratch archives the printer was asked to build, by name.
  const archives = new Map();
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
      // Count every byte and keep the multipart preamble (the part headers,
      // which is where the field names and the filename live). The payload
      // itself is discarded — the read-back below is what verifyFirmware
      // actually compares.
      let seen = 0;
      const head = [];
      for await (const chunk of req) {
        if (seen < 1024) head.push(chunk.subarray(0, 1024 - seen));
        seen += chunk.length;
      }
      calls.uploadBytes = seen;
      calls.uploadHeader = Buffer.concat(head).toString("latin1");
      calls.uploadPath = url.pathname;
      calls.uploadContentLength = req.headers["content-length"] ? Number(req.headers["content-length"]) : null;
      calls.uploads++;
      return json({ result: { item: { path: name, size: file.length } } });
    }
    // Ask the printer to archive a file — what the CRC check is built on.
    if (url.pathname === "/server/files/zip" && req.method === "POST") {
      for await (const _ of req) { /* body is JSON we do not need to parse */ }
      if (noZip) { res.writeHead(404).end("not found"); return; }
      calls.zips++;
      // The archive is of whatever the printer actually holds, which is the
      // point: an upload that arrived corrupt produces a different CRC.
      const zipName = "verify.zip";
      archives.set(zipName, storeOnlyZip(name, file));
      return json({ result: {} });
    }
    if (url.pathname.startsWith("/server/files/gcodes/") && req.method === "DELETE") {
      const target = decodeURIComponent(url.pathname.slice("/server/files/gcodes/".length));
      calls.deletes.push(target);
      archives.delete(target);
      return json({ result: target });
    }

    // Any file the printer holds: the uploaded image, or a scratch archive.
    // Both must honour Range, since that is how the CRC and sampling checks
    // read them without pulling a quarter-gigabyte back over the network.
    const served = (() => {
      if (url.pathname === "/server/files/gcodes/" + encodeURIComponent(name) ||
          url.pathname === "/server/files/gcodes/" + name) return { body: file, isImage: true };
      for (const [zn, buf] of archives) {
        if (url.pathname === "/server/files/gcodes/" + encodeURIComponent(zn) ||
            url.pathname === "/server/files/gcodes/" + zn) return { body: buf, isImage: false };
      }
      // A zip the connector named itself (verify-<timestamp>.zip): the mock
      // stores one archive at a time, so serve it for any .zip request.
      if (/\.zip$/.test(url.pathname) && archives.size) {
        return { body: [...archives.values()][0], isImage: false };
      }
      return null;
    })();
    if (served) {
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
      if (range) {
        calls.ranges++;
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), served.body.length - 1);
        const slice = served.body.subarray(start, end + 1);
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Length": slice.length,
          "Content-Range": `bytes ${start}-${end}/${served.body.length}`,
        });
        return res.end(slice);
      }
      // A whole-file GET of the image is the md5 read-back, and only that.
      if (served.isImage) calls.reads++;
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": served.body.length });
      return res.end(served.body);
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

        // A REAL U1 reports these two at different granularities, and conflating
        // them is exactly the bug this mock used to hide: it returned the full
        // build in BOTH fields, so code comparing the short one against an image
        // version passed here and never matched on hardware. Observed live on a
        // U1 running 1.6.0.267:
        //
        //   version     "1.6.0"
        //   fullversion "1.6.0.267_20260815150420"
        const shortVersion = String(version).split("_")[0].split(".").slice(0, 3).join(".");
        const result = method === "system.get_device_info"
          ? { fullversion: version, version: shortVersion, product_code: "U1", hwver: "V1" }
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
