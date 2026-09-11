// test/helpers/fakeRtspCamera.js — a stand-in for a Bambu Lab printer's RTSPS
// camera (port 322): Digest (or Basic) auth, DESCRIBE with an H.264 SDP,
// SETUP for interleaved TCP, PLAY, then RTP packets framed on the same
// connection, looping over a real x264 elementary stream from
// test/fixtures/h264/. The packetizer here is written independently of the
// connector's depacketizer, so a round trip through both is a real check.
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { splitAnnexB, nalType } = require("../../connectors/h264-fmp4");

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

// Access units from an Annex B stream: everything up to and including a
// slice (type 1) or IDR (type 5) NAL is one frame.
function accessUnits(file) {
  const nals = splitAnnexB(fs.readFileSync(file));
  const aus = [];
  let cur = [];
  for (const n of nals) { cur.push(n); const t = nalType(n); if (t === 1 || t === 5) { aus.push(cur); cur = []; } }
  return aus;
}

// RFC 6184 packetization: SPS/PPS/SEI aggregated into one STAP-A, NALs above
// `mtu` split into FU-A fragments, the marker bit on a frame's last packet.
function packetize(nals, { seqStart, timestamp, pt = 96, mtu = 1200 }) {
  const packets = [];
  let seq = seqStart;
  const rtp = (payload, marker) => {
    const h = Buffer.alloc(12);
    h[0] = 0x80; h[1] = (marker ? 0x80 : 0) | pt;
    h.writeUInt16BE(seq & 0xffff, 2); seq++;
    h.writeUInt32BE(timestamp >>> 0, 4);
    h.writeUInt32BE(0x5eed, 8);
    return Buffer.concat([h, payload]);
  };
  const units = [];
  const small = nals.filter(n => [6, 7, 8].includes(nalType(n)));
  const rest = nals.filter(n => ![6, 7, 8].includes(nalType(n)));
  if (small.length) {
    const parts = [Buffer.from([(small[0][0] & 0x60) | 24])];
    for (const n of small) { const l = Buffer.alloc(2); l.writeUInt16BE(n.length, 0); parts.push(l, n); }
    units.push(Buffer.concat(parts));
  }
  for (const n of rest) {
    if (n.length <= mtu) { units.push(n); continue; }
    const ind = (n[0] & 0xe0) | 28, type = n[0] & 0x1f;
    for (let o = 1; o < n.length; o += mtu) {
      const s = o === 1 ? 0x80 : 0, e = o + mtu >= n.length ? 0x40 : 0;
      units.push(Buffer.concat([Buffer.from([ind, s | e | type]), n.subarray(o, Math.min(n.length, o + mtu))]));
    }
  }
  units.forEach((u, i) => packets.push(rtp(u, i === units.length - 1)));
  return { packets, seq };
}

// Fault injection for the robustness tests:
//   stallAfter      stop sending video after N frames but keep the connection open
//   corruptSps      replace every in-band SPS with a truncated one
//   swapTimestamps  send frames with presentation timestamps out of order (B-frames)
function createFakeRtspCamera({ username = "bblp", password, fixture = "small-baseline.h264", auth = "digest", spropInSdp = true, fps = 30, stallAfter = Infinity, corruptSps = false, swapTimestamps = false, createServer = (h) => net.createServer(h) } = {}) {
  let aus = accessUnits(path.join(__dirname, "..", "fixtures", "h264", fixture));
  if (corruptSps) aus = aus.map(au => au.map(n => nalType(n) === 7 ? n.subarray(0, 4) : n));
  const sps = aus.flat().find(n => nalType(n) === 7), pps = aus.flat().find(n => nalType(n) === 8);
  const state = { requests: [], sessions: 0, playing: 0, sockets: new Set(), authFailures: 0 };
  const realm = "BambuLab", nonce = crypto.randomBytes(8).toString("hex");

  function authorized(method, header) {
    if (!header) return false;
    if (auth === "basic") return header === "Basic " + Buffer.from(username + ":" + password).toString("base64");
    const p = {};
    header.replace(/(\w+)="?([^",]*)"?/g, (_, k, v) => { p[k] = v; });
    const ha1 = md5(`${username}:${realm}:${password}`), ha2 = md5(`${method}:${p.uri}`);
    const expected = p.qop ? md5(`${ha1}:${nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
    return p.username === username && p.response === expected;
  }

  const server = createServer((sock) => {
    state.sockets.add(sock);
    let buf = "", timer = null, seq = 1000, ts = 0xfffff000, frame = 0;
    const stop = () => { clearInterval(timer); timer = null; };
    sock.on("close", () => { stop(); state.sockets.delete(sock); });
    sock.on("error", () => {});
    sock.setEncoding("latin1");
    sock.on("data", (d) => {
      buf += d;
      let end;
      while ((end = buf.indexOf("\r\n\r\n")) !== -1) {
        const head = buf.slice(0, end); buf = buf.slice(end + 4);
        const [reqLine, ...lines] = head.split("\r\n");
        const [method, url] = reqLine.split(" ");
        const h = {};
        for (const l of lines) { const i = l.indexOf(":"); if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
        state.requests.push({ method, url, headers: h });
        const reply = (code, reason, extra = {}, body = "") => {
          const hs = { CSeq: h.cseq, ...extra };
          if (body) hs["Content-Length"] = Buffer.byteLength(body);
          sock.write(`RTSP/1.0 ${code} ${reason}\r\n` + Object.entries(hs).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n" + body);
        };
        if (method === "OPTIONS") { reply(200, "OK", { Public: "OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN" }); continue; }
        if (method === "TEARDOWN") { reply(200, "OK"); stop(); sock.end(); continue; }
        if (!authorized(method, h.authorization)) {
          if (h.authorization) state.authFailures++;
          reply(401, "Unauthorized", { "WWW-Authenticate": auth === "basic" ? `Basic realm="${realm}"` : `Digest realm="${realm}", nonce="${nonce}"` });
          continue;
        }
        if (method === "DESCRIBE") {
          const sprop = spropInSdp ? `;sprop-parameter-sets=${sps.toString("base64")},${pps.toString("base64")}` : "";
          const sdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Bambu\r\nt=0 0\r\na=control:*\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n" +
            `a=fmtp:96 packetization-mode=1${sprop}\r\na=control:trackID=1\r\n`;
          reply(200, "OK", { "Content-Type": "application/sdp", "Content-Base": url.replace(/\/?$/, "/") }, sdp);
        } else if (method === "SETUP") {
          state.sessions++;
          reply(200, "OK", { Transport: "RTP/AVP/TCP;unicast;interleaved=0-1", Session: "66334873;timeout=60" });
        } else if (method === "PLAY") {
          state.playing++;
          reply(200, "OK", { Session: "66334873" });
          timer = setInterval(() => {
            if (frame >= stallAfter) return;
            const au = aus[frame % aus.length];
            const step = 90000 / fps;
            const stamp = swapTimestamps && frame > 0 ? (frame % 2 ? ts + step : ts - step) >>> 0 : ts;
            frame++;
            const out = packetize(au, { seqStart: seq, timestamp: stamp });
            seq = out.seq; ts = (ts + step) >>> 0;
            for (const pkt of out.packets) {
              const hdr = Buffer.from([0x24, 0, 0, 0]); hdr.writeUInt16BE(pkt.length, 2);
              sock.write(Buffer.concat([hdr, pkt]));
            }
          }, 1000 / fps);
        } else reply(405, "Method Not Allowed");
      }
    });
  });
  return {
    state, server, aus, sps, pps,
    listen: () => new Promise(r => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () => new Promise(r => { for (const s of state.sockets) s.destroy(); server.close(() => r()); })
  };
}

module.exports = { createFakeRtspCamera, packetize, accessUnits };
