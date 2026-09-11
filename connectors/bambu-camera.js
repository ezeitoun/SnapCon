// connectors/bambu-camera.js — the Bambu Lab H2 camera, relayed.
//
// H2 printers stream H.264 over RTSPS on port 322 once "LAN Only Liveview" is
// switched on at the printer (it reports ipcam.rtsp_url; "disable" means off).
// A browser cannot open RTSP, so SnapCon holds ONE RTSP session per printer
// and fans it out to every viewer as a fragmented-MP4 byte stream the page
// plays through Media Source Extensions (see connectors/h264-fmp4.js for why
// not WebCodecs). The session opens on the first viewer and closes a short
// while after the last one leaves — nothing is streamed while nobody watches.
//
// A late joiner starts at the most recent keyframe: the relay keeps the
// fragments of the current group of pictures and replays them first, so a
// tile shows a picture at once instead of waiting for the next keyframe.
//
// Still frames (the snapshot modal's fallback, notification images) need a
// decoder, which SnapCon does not ship. When an `ffmpeg` binary is available
// (on PATH, or SNAPCON_FFMPEG=/path/to/ffmpeg) the latest keyframe — already
// received over the verified TLS session — is piped into it and one JPEG
// comes back. ffmpeg never touches the network or the access code.
const { spawn, spawnSync } = require("child_process");
const { RtspClient } = require("./rtsp-client");
const { parseRtp, H264Depacketizer, Fmp4Muxer, toAnnexB, NAL, nalType, parseSps } = require("./h264-fmp4");

const CAMERA_PORT = 322;
const CAMERA_PATH = "/streaming/live/1";
let IDLE_CLOSE_MS = 15 * 1000;        // keep the session briefly after the last viewer (tab switches, re-renders)
const READY_TIMEOUT_MS = 12 * 1000;   // first keyframe must arrive within this
// A late joiner is sent the cached GOP in one burst, so the cache must stay
// well under the point where a viewer counts as "too slow".
const GOP_MAX_BYTES = 6 * 1024 * 1024;
const VIEWER_MAX_BACKLOG = 12 * 1024 * 1024; // a viewer this far behind is dropped, not buffered forever
// No video for this long on a live session = the camera (or the link) is gone,
// even if the TCP connection has not noticed yet.
let STALL_MS = 10 * 1000;

// ---- optional ffmpeg (still frames only) ----
let ffmpegChecked = false, ffmpegBin = null;
function ffmpegPath() {
  if (ffmpegChecked) return ffmpegBin;
  ffmpegChecked = true;
  const candidate = process.env.SNAPCON_FFMPEG || "ffmpeg";
  try {
    const r = spawnSync(candidate, ["-hide_banner", "-version"], { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    if (r.status === 0) ffmpegBin = candidate;
  } catch { ffmpegBin = null; }
  return ffmpegBin;
}

function jpegFromKeyframe(annexB, timeoutMs = 10000) {
  const bin = ffmpegPath();
  if (!bin) return Promise.reject(new Error("still frames from this camera need ffmpeg installed on the SnapCon host"));
  return new Promise((resolve, reject) => {
    const ff = spawn(bin, ["-hide_banner", "-loglevel", "error", "-f", "h264", "-i", "pipe:0", "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "-q:v", "4", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
    const out = [], err = [];
    const timer = setTimeout(() => { ff.kill("SIGKILL"); reject(new Error("ffmpeg took too long to decode the frame")); }, timeoutMs);
    ff.stdout.on("data", d => out.push(d));
    ff.stderr.on("data", d => err.push(d));
    ff.on("error", e => { clearTimeout(timer); reject(e); });
    ff.on("close", code => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code === 0 && buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) resolve(buf);
      else reject(new Error("ffmpeg could not decode the frame" + (err.length ? ": " + Buffer.concat(err).toString().trim().slice(0, 200) : "")));
    });
    ff.stdin.on("error", () => {});
    ff.stdin.end(annexB);
  });
}

// ---- the relay ----
class CameraRelay {
  constructor({ key, name, createStream, url, username, password, log }) {
    Object.assign(this, { key, name, createStream, url, username, password, log });
    this.viewers = new Set();
    this.client = null;
    this.state = "idle";        // idle | starting | live | closed
    this.init = null;           // { buffer, info }
    this.gop = [];              // fragments since the last keyframe
    this.gopBytes = 0;
    this.lastKey = null;        // Annex B of the latest keyframe (SPS+PPS+IDR)
    this.waiters = [];
    this.idleTimer = null;
    this.lastError = null;
  }

  get codec() { return this.init ? this.init.info.codec : null; }

  _start() {
    if (this.state === "starting" || this.state === "live") return;
    this.state = "starting";
    this.init = null; this.gop = []; this.gopBytes = 0; this.lastKey = null;
    const muxer = new Fmp4Muxer({
      onInit: (init) => { this.init = init; },
      onFragment: (f) => this._onFragment(f)
    });
    const depack = new H264Depacketizer((au) => muxer.push(au));
    const client = new RtspClient({ createStream: this.createStream, url: this.url, username: this.username, password: this.password });
    this.client = client;
    client.on("track", (track) => {
      // Parameter sets from the SDP let the init segment be built even if the
      // camera only repeats them in-band at long intervals. Validated first:
      // a malformed one is ignored and the in-band copy used instead.
      const sps = track.sprop.find(n => nalType(n) === NAL.SPS), pps = track.sprop.find(n => nalType(n) === NAL.PPS);
      try { if (sps) parseSps(sps); muxer.setParameterSets(sps, pps); } catch { /* wait for in-band ones */ }
    });
    client.on("rtp", (channel, payload) => {
      if (channel !== 0) return; // RTCP on 1 is not needed
      const pkt = parseRtp(payload);
      if (!pkt || !client.track || pkt.payloadType !== client.track.payloadType) return;
      // This runs inside the socket's data handler: anything the camera sends
      // that the decoder side cannot handle (a truncated SPS, B-frames) must
      // end THIS session, never escape as an exception that takes the whole
      // server down.
      try { depack.push(pkt); }
      catch (e) { this.lastError = e; client._close(e); }
    });
    client.on("close", (err) => {
      if (this.client !== client) return;
      this.client = null;
      if (err) this.lastError = err;
      const was = this.state;
      this.state = "idle";
      clearInterval(this.watchdog); this.watchdog = null;
      if (was === "live") this.log(this.name, "camera stream ended" + (err ? ": " + err.message : ""));
      this._fail(err || this.lastError || new Error("the camera stream ended"));
    });
    client.start().catch((e) => {
      if (this.client !== client) return;
      this.lastError = e;
      client.close();
    });
  }

  _onFragment(f) {
    this.lastFragmentAt = Date.now();
    if (f.key) {
      this.gop = []; this.gopBytes = 0;
      this.lastKey = toAnnexB(f.nals);
      if (this.state !== "live") {
        this.state = "live"; this.lastError = null;
        this.log(this.name, "camera stream live (" + this.init.info.width + "x" + this.init.info.height + ")");
        this._startWatchdog();
      }
      const waiters = this.waiters; this.waiters = [];
      for (const w of waiters) w.resolve();
    }
    if (this.state !== "live") return;
    if (this.gopBytes + f.buffer.length <= GOP_MAX_BYTES) { this.gop.push(f.buffer); this.gopBytes += f.buffer.length; }
    for (const v of this.viewers) v.write(f.buffer);
  }

  _startWatchdog() {
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.state !== "live") { clearInterval(this.watchdog); this.watchdog = null; return; }
      if (Date.now() - this.lastFragmentAt > STALL_MS) {
        const err = new Error("the camera stopped sending video");
        this.lastError = err;
        if (this.client) this.client._close(err); else this.stop();
      }
    }, Math.min(2000, STALL_MS / 2));
    if (this.watchdog.unref) this.watchdog.unref();
  }

  _fail(err) {
    const waiters = this.waiters; this.waiters = [];
    for (const w of waiters) w.reject(err);
    for (const v of [...this.viewers]) v.end(err);
    this.viewers.clear();
  }

  _waitLive(timeoutMs) {
    if (this.state === "live") return Promise.resolve();
    this._start();
    return new Promise((resolve, reject) => {
      const w = { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(x => x !== w);
        reject(new Error(this.lastError ? this.lastError.message : "the camera sent no picture in time"));
        this._scheduleIdle();
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.waiters.push(w);
    });
  }

  // A viewer: { write(buf), end(err) }. Returns an unsubscribe function.
  async subscribe(viewer) {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    await this._waitLive(READY_TIMEOUT_MS);
    const v = {
      write: (buf) => { if (viewer.backlog && viewer.backlog() > VIEWER_MAX_BACKLOG) { unsubscribe(); viewer.end(new Error("viewer too slow")); return; } viewer.write(buf); },
      end: (err) => viewer.end(err)
    };
    viewer.write(this.init.buffer);
    for (const g of this.gop) viewer.write(g);
    this.viewers.add(v);
    const unsubscribe = () => { if (this.viewers.delete(v)) this._scheduleIdle(); };
    return { codec: this.codec, width: this.init.info.width, height: this.init.info.height, unsubscribe };
  }

  async keyframe() {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    try {
      await this._waitLive(READY_TIMEOUT_MS);
      return this.lastKey;
    } finally { this._scheduleIdle(); }
  }

  _scheduleIdle() {
    if (this.viewers.size || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.viewers.size) return;
      this.stop();
    }, IDLE_CLOSE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  stop() {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    clearInterval(this.watchdog); this.watchdog = null;
    const c = this.client;
    this.client = null;
    this.state = "idle";
    // Nothing of a stopped session is worth keeping in memory: the next viewer
    // starts a fresh one and waits for a fresh keyframe anyway.
    this.init = null; this.gop = []; this.gopBytes = 0; this.lastKey = null;
    if (c) c.close();
    this._fail(new Error("camera stream stopped"));
  }
}

module.exports = {
  CameraRelay, ffmpegPath, jpegFromKeyframe, CAMERA_PORT, CAMERA_PATH,
  _internal: {
    READY_TIMEOUT_MS,
    setIdleCloseMs(ms) { IDLE_CLOSE_MS = ms; },
    setStallMs(ms) { STALL_MS = ms; },
    resetFfmpegCheck() { ffmpegChecked = false; ffmpegBin = null; }
  }
};
