// test/connectors/bambu-camera.test.js — the Bambu Lab camera relay: RTP
// depacketizing, SPS parsing, fragmented-MP4 muxing, the RTSP client, and
// the connector's relay end to end against a fake RTSPS camera
// (test/helpers/fakeRtspCamera.js) streaming a real x264 elementary stream.
//
// When an ffmpeg binary is on PATH, the muxer's output is additionally
// decoded by ffmpeg — the independent proof that what goes to the browser is
// a valid MP4. Those tests skip themselves on a machine without ffmpeg.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const h = require("../../connectors/h264-fmp4");
const { RtspClient, _internal: rtsp } = require("../../connectors/rtsp-client");
const camera = require("../../connectors/bambu-camera");
const bambu = require("../../connectors/bambulab-h2");
const { createFakeRtspCamera, packetize, accessUnits } = require("../helpers/fakeRtspCamera");
const { createFakeBambuBroker } = require("../helpers/fakeBambuBroker");
const { h2dPrinting } = require("../fixtures/bambu-reports");

const FIX = path.join(__dirname, "..", "fixtures", "h264");
const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const I = bambu._internal;

function probeMp4(buf) {
  const f = path.join(os.tmpdir(), "snapcon-test-" + process.pid + "-" + Math.random().toString(16).slice(2) + ".mp4");
  fs.writeFileSync(f, buf);
  try {
    const r = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "json", f], { encoding: "utf8" });
    const dec = spawnSync("ffmpeg", ["-v", "error", "-i", f, "-f", "null", "-"], { encoding: "utf8" });
    return { stream: JSON.parse(r.stdout).streams[0], decodeErrors: dec.stderr.trim() };
  } finally { fs.unlinkSync(f); }
}

// ---- SPS ----

test("SPS: baseline 160x120 and cropped high-profile 1920x1080", () => {
  const small = accessUnits(path.join(FIX, "small-baseline.h264")).flat().find(n => h.nalType(n) === 7);
  assert.deepEqual((({ width, height, profile, codec }) => ({ width, height, profile, codec }))(h.parseSps(small)), { width: 160, height: 120, profile: 66, codec: "avc1.42c00a" });
  const hd = h.splitAnnexB(fs.readFileSync(path.join(FIX, "hd-high.h264"))).find(n => h.nalType(n) === 7);
  const info = h.parseSps(hd);
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080, "1088 coded rows, cropped to 1080");
  assert.equal(info.codec, "avc1.640028");
});

test("emulation-prevention bytes are removed before parsing", () => {
  assert.deepEqual([...h.unescapeRbsp(Buffer.from([0x67, 0, 0, 3, 1, 0, 0, 3, 0]))], [0x67, 0, 0, 1, 0, 0, 0]);
});

// ---- RTP depacketizer ----

test("depacketizer: STAP-A + FU-A + single NAL round-trip byte for byte, frame by frame", () => {
  const aus = accessUnits(path.join(FIX, "small-baseline.h264"));
  const got = [];
  const d = new h.H264Depacketizer(au => got.push(au));
  let seq = 65530, ts = 0;
  for (const au of aus) {
    const out = packetize(au, { seqStart: seq, timestamp: ts, mtu: 300 });
    seq = out.seq; ts += 6000;
    for (const p of out.packets) d.push(h.parseRtp(p));
  }
  assert.equal(got.length, aus.length);
  got.forEach((au, i) => {
    assert.equal(au.nals.length, aus[i].length, "frame " + i);
    au.nals.forEach((n, j) => assert.ok(n.equals(aus[i][j]), `frame ${i} nal ${j}`));
    assert.equal(au.key, aus[i].some(n => h.nalType(n) === 5));
  });
});

test("depacketizer: a lost FU-A fragment drops that NAL instead of emitting it corrupt", () => {
  const big = accessUnits(path.join(FIX, "small-baseline.h264"))[0]; // SPS, PPS, SEI, IDR (large)
  const { packets } = packetize(big, { seqStart: 1, timestamp: 0, mtu: 200 });
  const got = [];
  const d = new h.H264Depacketizer(au => got.push(au));
  packets.forEach((p, i) => { if (i !== 3) d.push(h.parseRtp(p)); }); // lose one fragment
  assert.equal(got.length, 1);
  assert.equal(got[0].nals.some(n => h.nalType(n) === 5), false, "the damaged IDR is gone");
  assert.deepEqual(got[0].nals.map(h.nalType), [7, 8, 6]);
});

test("parseRtp rejects non-RTP data and honours padding and extensions", () => {
  assert.equal(h.parseRtp(Buffer.from([0, 1, 2])), null);
  const pkt = Buffer.from([0xb0, 0x60, 0, 1, 0, 0, 0, 9, 0, 0, 0, 1, 0xbe, 0xde, 0, 1, 1, 2, 3, 4, 0x65, 0xaa, 0, 0, 3]);
  const r = h.parseRtp(pkt);
  assert.deepEqual([...r.payload], [0x65, 0xaa], "4-byte extension skipped, 3 bytes of padding dropped");
  assert.equal(r.timestamp, 9);
});

// ---- fMP4 ----

function muxFixture(file, startTs) {
  const aus = accessUnits(path.join(FIX, file));
  const out = { init: null, frags: [] };
  const m = new h.Fmp4Muxer({ onInit: i => { out.init = i; }, onFragment: f => out.frags.push(f) });
  aus.forEach((au, i) => m.push({ nals: au, timestamp: (startTs + i * 6000) >>> 0, key: au.some(n => h.nalType(n) === 5) }));
  return out;
}

test("fMP4: init segment and one moof+mdat per frame, first fragment a sync sample", () => {
  const { init, frags } = muxFixture("small-baseline.h264", 0);
  assert.equal(init.buffer.subarray(4, 8).toString(), "ftyp");
  assert.ok(init.buffer.includes(Buffer.from("avcC")));
  assert.equal(init.info.codec, "avc1.42c00a");
  assert.equal(frags.length, 29, "the last frame waits for its successor's timestamp");
  assert.equal(frags[0].key, true);
  for (const f of frags) {
    assert.equal(f.buffer.subarray(4, 8).toString(), "moof");
    const moofLen = f.buffer.readUInt32BE(0);
    assert.equal(f.buffer.subarray(moofLen + 4, moofLen + 8).toString(), "mdat");
  }
});

test("fMP4: frames before the first keyframe are not emitted", () => {
  const aus = accessUnits(path.join(FIX, "small-baseline.h264"));
  const frags = [];
  const m = new h.Fmp4Muxer({ onInit: () => {}, onFragment: f => frags.push(f) });
  aus.slice(1, 5).forEach((au, i) => m.push({ nals: au, timestamp: i * 6000, key: false }));
  assert.equal(frags.length, 0);
});

test("fMP4 output decodes cleanly in ffmpeg, across a 32-bit RTP timestamp wrap", { skip: !HAS_FFMPEG && "ffmpeg not installed" }, () => {
  const { init, frags } = muxFixture("small-baseline.h264", 0xffffa000);
  const r = probeMp4(Buffer.concat([init.buffer, ...frags.map(f => f.buffer)]));
  assert.equal(r.stream.codec_name, "h264");
  assert.equal(r.stream.width, 160);
  assert.equal(Number(r.stream.nb_read_frames), 29);
  assert.equal(r.decodeErrors, "");
});

// ---- RTSP client ----

test("SDP: control URLs, sprop parameter sets, and a non-H.264 track refused", () => {
  const sdp = "v=0\r\na=control:*\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;sprop-parameter-sets=Z0IACpZUBQHogA==,aM48gA==\r\na=control:trackID=1\r\n";
  const t = rtsp.parseSdp(sdp, "rtsps://10.0.0.5:322/streaming/live/1/");
  assert.equal(t.url, "rtsps://10.0.0.5:322/streaming/live/1/trackID=1");
  assert.equal(t.payloadType, 96);
  assert.deepEqual(t.sprop.map(h.nalType), [7, 8]);
  assert.equal(rtsp.resolveControl("rtsp://x/abs", "rtsp://y/"), "rtsp://x/abs");
  assert.equal(rtsp.resolveControl("*", "rtsp://y/z"), "rtsp://y/z");
  assert.throws(() => rtsp.parseSdp("m=video 0 RTP/AVP 97\r\na=rtpmap:97 H265/90000\r\n", "rtsp://x"), /H265/);
});

async function withCamera(opts, fn) {
  const cam = createFakeRtspCamera({ password: "a1b2c3d4", ...opts });
  const port = await cam.listen();
  try { await fn(cam, port); } finally { await cam.close(); }
}

for (const auth of ["digest", "basic"]) {
  test(`RTSP: ${auth} auth, SETUP interleaved, PLAY, then RTP flows`, async () => {
    await withCamera({ auth }, async (cam, port) => {
      const c = new RtspClient({ createStream: () => net.connect(port, "127.0.0.1"), url: `rtsp://127.0.0.1:${port}/streaming/live/1`, username: "bblp", password: "a1b2c3d4" });
      const got = [];
      c.on("rtp", (ch, p) => got.push(ch));
      const track = await c.start();
      assert.equal(track.payloadType, 96);
      await new Promise(r => setTimeout(r, 200));
      c.close();
      assert.ok(got.length > 5, "packets arrived: " + got.length);
      assert.deepEqual(cam.state.requests.map(r => r.method).slice(0, 5), ["OPTIONS", "DESCRIBE", "DESCRIBE", "SETUP", "PLAY"], "DESCRIBE is repeated once, with credentials, after the 401");
      assert.match(cam.state.requests.find(r => r.method === "SETUP").headers.transport, /interleaved=0-1/);
    });
  });
}

test("RTSP: a wrong access code is reported as such", async () => {
  await withCamera({}, async (_cam, port) => {
    const c = new RtspClient({ createStream: () => net.connect(port, "127.0.0.1"), url: `rtsp://127.0.0.1:${port}/streaming/live/1`, username: "bblp", password: "nope" });
    await assert.rejects(c.start(), e => e.code === "EAUTH" && /access code/.test(e.message));
    c.close();
  });
});

// ---- the connector's relay, end to end ----

const SERIAL = "0940TESTH2D0001", CODE = "a1b2c3d4";

async function withPrinter({ liveview = true, camOpts = {} } = {}, fn) {
  const rep = h2dPrinting();
  rep.ipcam = { rtsp_url: liveview ? "rtsps://192.0.2.1:322/streaming/live/1" : "disable", resolution: "1080p" };
  const broker = createFakeBambuBroker({ serial: SERIAL, accessCode: CODE, report: rep });
  const cam = createFakeRtspCamera({ password: CODE, ...camOpts });
  const [mqttPort, camPort] = [await broker.listen(), await cam.listen()];
  I.setTransportFactory(cfg => net.connect(cfg.port, cfg.host));
  I.setCameraTransportFactory(() => net.connect(camPort, "127.0.0.1"));
  camera._internal.setIdleCloseMs(150);
  const p = { id: "p_cam", name: "H2D-Cam", url: `mqtts://127.0.0.1:${mqttPort}`, serial: SERIAL, verificationCode: CODE };
  try {
    const st = await bambu.probe(p);
    assert.equal(st.online, true, st.error);
    await fn(p, cam, broker);
  } finally {
    for (const [key, c] of I.connections) { I.teardown(c); I.connections.delete(key); }
    for (const r of I.relays.values()) r.stop();
    I.relays.clear();
    I.setTransportFactory(null); I.setCameraTransportFactory(null);
    camera._internal.setIdleCloseMs(15000);
    await broker.close(); await cam.close();
  }
}

function collector() {
  const chunks = [];
  let ended = null;
  return { chunks, get ended() { return ended; }, viewer: { write: b => chunks.push(b), end: e => { ended = e || true; }, backlog: () => 0 } };
}

test("capabilities follow the printer: camera only once LAN Only Liveview is on", async () => {
  await withPrinter({ liveview: false }, async (p) => {
    assert.equal(bambu.getCapabilities(p).camera, false);
    await assert.rejects(bambu.openCameraStream(p, collector().viewer), e => e.status === 404 && /LAN Only Liveview/.test(e.message));
  });
  await withPrinter({}, async (p) => {
    const caps = bambu.getCapabilities(p);
    assert.equal(caps.camera, true);
    assert.equal(caps.cameraStream, true);
    assert.equal(caps.control, false, "still monitor-only");
  });
});

test("relay: a viewer gets the init segment, then live fragments starting at a keyframe", async () => {
  await withPrinter({}, async (p) => {
    const v = collector();
    const sub = await bambu.openCameraStream(p, v.viewer);
    assert.equal(sub.codec, "avc1.42c00a");
    assert.deepEqual([sub.width, sub.height], [160, 120]);
    await new Promise(r => setTimeout(r, 400));
    sub.unsubscribe();
    assert.equal(v.chunks[0].subarray(4, 8).toString(), "ftyp");
    assert.equal(v.chunks[1].subarray(4, 8).toString(), "moof");
    assert.ok(v.chunks.length > 8, "fragments kept coming: " + v.chunks.length);
    if (HAS_FFMPEG) {
      const r = probeMp4(Buffer.concat(v.chunks));
      assert.equal(r.stream.width, 160);
      assert.equal(r.decodeErrors, "", "what the browser receives is a valid MP4");
    }
  });
});

test("relay: two viewers share ONE camera session, which closes after the last leaves", async () => {
  await withPrinter({}, async (p, cam) => {
    const a = collector(), b = collector();
    const sa = await bambu.openCameraStream(p, a.viewer);
    const sb = await bambu.openCameraStream(p, b.viewer);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(cam.state.sessions, 1, "one upstream RTSP session");
    assert.equal(b.chunks[0].subarray(4, 8).toString(), "ftyp", "the late joiner still starts with an init segment");
    assert.equal(b.chunks[1].subarray(4, 8).toString(), "moof");
    sa.unsubscribe(); sb.unsubscribe();
    await new Promise(r => setTimeout(r, 400));
    assert.equal(cam.state.sockets.size, 0, "camera session closed once nobody watches");
    assert.ok(cam.state.requests.some(r => r.method === "TEARDOWN"));
  });
});

test("relay: works when the camera only sends parameter sets in-band (no sprop in SDP)", async () => {
  await withPrinter({ camOpts: { spropInSdp: false } }, async (p) => {
    const v = collector();
    const sub = await bambu.openCameraStream(p, v.viewer);
    assert.equal(sub.codec, "avc1.42c00a");
    sub.unsubscribe();
  });
});

test("relay: a wrong access code fails the viewer with the reason", async () => {
  await withPrinter({ camOpts: { password: "different" } }, async (p) => {
    await assert.rejects(bambu.openCameraStream(p, collector().viewer), /access code/);
  });
});

test("relay: the camera dropping ends every viewer", async () => {
  await withPrinter({}, async (p, cam) => {
    const v = collector();
    await bambu.openCameraStream(p, v.viewer);
    for (const s of cam.state.sockets) s.destroy();
    await new Promise(r => setTimeout(r, 100));
    assert.ok(v.ended, "viewer was ended");
  });
});

test("snapshot: the latest keyframe decoded to a JPEG by ffmpeg", { skip: !HAS_FFMPEG && "ffmpeg not installed" }, async () => {
  camera._internal.resetFfmpegCheck();
  await withPrinter({}, async (p) => {
    assert.equal(bambu.getCapabilities(p).cameraSnapshot, true);
    const { contentType, buffer } = await bambu.getCameraSnapshot(p);
    assert.equal(contentType, "image/jpeg");
    assert.deepEqual([...buffer.subarray(0, 2)], [0xff, 0xd8]);
  });
});

test("snapshot: without ffmpeg the connector says so instead of hanging", async () => {
  const saved = process.env.SNAPCON_FFMPEG;
  process.env.SNAPCON_FFMPEG = "/nonexistent/ffmpeg";
  camera._internal.resetFfmpegCheck();
  try {
    await withPrinter({}, async (p) => {
      assert.equal(bambu.getCapabilities(p).cameraSnapshot, false);
      await assert.rejects(bambu.getCameraSnapshot(p), e => e.status === 501 && /ffmpeg/.test(e.message));
    });
  } finally {
    if (saved === undefined) delete process.env.SNAPCON_FFMPEG; else process.env.SNAPCON_FFMPEG = saved;
    camera._internal.resetFfmpegCheck();
  }
});

// ---- robustness (a camera that misbehaves must not hang viewers or crash SnapCon) ----

test("relay: a camera that stops sending but keeps the connection open is detected", async () => {
  camera._internal.setStallMs(600);
  try {
    await withPrinter({ camOpts: { stallAfter: 12 } }, async (p) => {
      const v = collector();
      await bambu.openCameraStream(p, v.viewer);
      const t0 = Date.now();
      while (!v.ended && Date.now() - t0 < 4000) await new Promise(r => setTimeout(r, 50));
      assert.ok(v.ended, "the viewer was ended instead of hanging on a frozen picture");
      assert.match(String(v.ended.message || ""), /stopped sending video/);
    });
  } finally { camera._internal.setStallMs(10000); }
});

test("relay: a malformed SPS ends that camera session — the process keeps running", async () => {
  await withPrinter({ camOpts: { corruptSps: true, spropInSdp: false } }, async (p) => {
    await assert.rejects(bambu.openCameraStream(p, collector().viewer), /SPS|picture/i);
  });
  // Reaching this line at all is the assertion: a throw inside the socket's
  // data handler would have taken the test process down.
});

test("relay: a stream with B-frames is refused with a clear reason", async () => {
  await withPrinter({ camOpts: { swapTimestamps: true } }, async (p) => {
    const v = collector();
    try { await bambu.openCameraStream(p, v.viewer); } catch (e) { assert.match(e.message, /B-frames/); return; }
    const t0 = Date.now();
    while (!v.ended && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 50));
    assert.match(String(v.ended && v.ended.message), /B-frames/);
  });
});

test("relay: stopping frees the cached GOP and keyframe", async () => {
  await withPrinter({}, async (p) => {
    const sub = await bambu.openCameraStream(p, collector().viewer);
    const relay = I.relays.get("p_cam");
    assert.ok(relay.gop.length && relay.lastKey);
    sub.unsubscribe();
    relay.stop();
    assert.deepEqual([relay.gop.length, relay.lastKey, relay.init], [0, null, null]);
  });
});
