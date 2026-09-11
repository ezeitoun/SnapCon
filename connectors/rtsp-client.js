// connectors/rtsp-client.js — a small RTSP 1.0 client for ONE H.264 video
// track, RTP interleaved over the RTSP connection itself (TCP), which is how
// a Bambu Lab printer's camera is read over RTSPS (TLS) on port 322.
//
// OPTIONS -> DESCRIBE (Basic or Digest auth) -> SETUP (interleaved=0-1) ->
// PLAY, then RTP packets arrive framed as "$", channel, 16-bit length. RTSP
// replies can still arrive in between (the keepalive's), so the parser tells
// the two apart by the leading "$". Nothing is decoded here — RTP payloads go
// to connectors/h264-fmp4.js.
//
// Transport-agnostic like connectors/bambu-mqtt.js: the caller passes a
// function returning a connecting Duplex (a verified TLS socket in
// production, a plain socket in tests). The first request — which may carry
// credentials — is written only after a TLS socket's "secureConnect", i.e.
// after the certificate was verified.
const { EventEmitter } = require("events");
const crypto = require("crypto");

const MAX_RTSP_HEADER = 64 * 1024;

function md5(s) { return crypto.createHash("md5").update(s).digest("hex"); }

// WWW-Authenticate: Digest realm="x", nonce="y", qop="auth" | Basic realm="x"
function parseAuthenticate(header) {
  const h = String(header || "").trim();
  const scheme = h.split(/\s+/, 1)[0].toLowerCase();
  const params = {};
  const re = /(\w+)=("([^"]*)"|[^,\s]*)/g;
  let m;
  while ((m = re.exec(h.slice(scheme.length)))) params[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[2];
  return { scheme, params };
}

function authorization(challenge, { username, password }, method, uri, nc) {
  if (!challenge) return null;
  if (challenge.scheme === "basic") return "Basic " + Buffer.from(username + ":" + password).toString("base64");
  if (challenge.scheme !== "digest") return null;
  const { realm = "", nonce = "", qop, opaque, algorithm } = challenge.params;
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}"`;
  if (qop && /(^|,)\s*auth\s*(,|$)/.test(qop)) {
    const ncHex = nc.toString(16).padStart(8, "0");
    const cnonce = crypto.randomBytes(8).toString("hex");
    header += `, response="${md5(`${ha1}:${nonce}:${ncHex}:${cnonce}:auth:${ha2}`)}", qop=auth, nc=${ncHex}, cnonce="${cnonce}"`;
  } else {
    header += `, response="${md5(`${ha1}:${nonce}:${ha2}`)}"`;
  }
  if (opaque) header += `, opaque="${opaque}"`;
  if (algorithm) header += `, algorithm=${algorithm}`;
  return header;
}

// The H.264 track of an SDP body: payload type, control URL, and the
// parameter sets when the server advertises them (sprop-parameter-sets).
function parseSdp(sdp, baseUrl) {
  const lines = String(sdp).split(/\r?\n/);
  let inVideo = false, track = null, sessionControl = null;
  for (const line of lines) {
    if (line.startsWith("m=")) {
      inVideo = line.startsWith("m=video");
      if (inVideo && !track) track = { payloadType: Number(line.split(/\s+/)[3]), control: null, codec: null, sprop: [] };
      else if (!inVideo && track && track.codec) break;
      continue;
    }
    const m = /^a=([\w-]+):?(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (!track || !inVideo) { if (key === "control") sessionControl = value.trim(); continue; }
    if (key === "control") track.control = value.trim();
    if (key === "rtpmap") {
      const [pt, enc] = value.trim().split(/\s+/);
      if (Number(pt) === track.payloadType) track.codec = String(enc || "").split("/")[0].toUpperCase();
    }
    if (key === "fmtp") {
      const sp = /sprop-parameter-sets=([^;\s]+)/i.exec(value);
      if (sp) track.sprop = sp[1].split(",").filter(Boolean).map(b => Buffer.from(b, "base64"));
    }
  }
  if (!track) throw new Error("the camera's SDP has no video track");
  if (track.codec && track.codec !== "H264") throw new Error("the camera streams " + track.codec + ", not H.264");
  track.url = resolveControl(track.control, baseUrl, sessionControl);
  return track;
}

function resolveControl(control, base, sessionControl) {
  if (!control || control === "*") return base;
  if (/^rtsps?:\/\//i.test(control)) return control;
  const root = sessionControl && /^rtsps?:\/\//i.test(sessionControl) ? sessionControl : base;
  return root.replace(/\/?$/, "/") + control.replace(/^\//, "");
}

// Events: "rtp" (channel, payloadBuffer), "close" (Error|null) — exactly once.
class RtspClient extends EventEmitter {
  constructor({ createStream, url, username, password, timeoutMs = 10000 }) {
    super();
    this._createStream = createStream;
    this.url = url;
    this.creds = { username, password };
    this.timeoutMs = timeoutMs;
    this.cseq = 1;
    this.nc = 1;
    this.challenge = null;
    this.session = null;
    this.buf = Buffer.alloc(0);
    this.pending = null;   // { resolve, reject, timer }
    this.closed = false;
    this.keepalive = null;
    this.track = null;
  }

  // Resolves once PLAY succeeded; RTP then flows as "rtp" events.
  async start() {
    const sock = this._createStream();
    this.sock = sock;
    await new Promise((resolve, reject) => {
      const onErr = (e) => { cleanup(); reject(e); };
      const onClose = () => { cleanup(); reject(new Error("camera connection closed before it was ready")); };
      const ready = () => { cleanup(); resolve(); };
      const cleanup = () => { sock.off("error", onErr); sock.off("close", onClose); sock.off("secureConnect", ready); sock.off("connect", ready); };
      sock.once("error", onErr);
      sock.once("close", onClose);
      if (sock.encrypted) sock.once("secureConnect", ready);
      else if (sock.connecting) sock.once("connect", ready);
      else ready();
    });
    sock.on("data", (d) => this._onData(d));
    sock.on("error", (e) => this._close(e));
    sock.on("close", () => this._close(null));
    // A printer that loses power mid-stream never closes the connection; TCP
    // keepalive plus the RTSP keepalive below are what notice.
    if (typeof sock.setKeepAlive === "function") sock.setKeepAlive(true, 10000);

    await this._request("OPTIONS", this.url);
    const desc = await this._request("DESCRIBE", this.url, { Accept: "application/sdp" });
    const base = desc.headers["content-base"] || desc.headers["content-location"] || this.url;
    this.track = parseSdp(desc.body.toString("utf8"), base);
    // Before PLAY on purpose: RTP can arrive in the very same read as the
    // PLAY reply, and whoever decodes it needs the SDP's parameter sets first.
    this.emit("track", this.track);
    const setup = await this._request("SETUP", this.track.url, { Transport: "RTP/AVP/TCP;unicast;interleaved=0-1" });
    const sess = String(setup.headers.session || "");
    this.session = sess.split(";")[0].trim();
    const timeout = Number((/timeout=(\d+)/i.exec(sess) || [])[1]) || 60;
    const playUrl = /^rtsps?:\/\//i.test(base) ? base : this.url;
    await this._request("PLAY", playUrl, { Range: "npt=0.000-" });
    // Keep the session alive at half its advertised timeout. OPTIONS is the
    // one method every RTSP server has to support.
    // A keepalive that is not answered means the session is gone — close it
    // rather than keep reporting a live camera that stopped sending.
    this.keepalive = setInterval(() => {
      if (this.pending) return; // a request is already outstanding; its own timeout covers it
      this._request("OPTIONS", this.url).catch((e) => this._close(e));
    }, Math.max(5, timeout / 2) * 1000);
    if (this.keepalive.unref) this.keepalive.unref();
    return this.track;
  }

  close() {
    if (this.closed) return;
    if (this.session && this.sock && !this.sock.destroyed) {
      try { this.sock.write(this._format("TEARDOWN", this.url, {})); } catch {}
    }
    this._close(null);
  }

  _format(method, url, headers) {
    const h = { CSeq: String(this.cseq++), "User-Agent": "SnapCon", ...headers };
    if (this.session) h.Session = this.session;
    const auth = authorization(this.challenge, this.creds, method, url, this.nc);
    if (auth) { h.Authorization = auth; this.nc++; }
    return `${method} ${url} RTSP/1.0\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n";
  }

  // One request at a time; a 401 is answered once with credentials.
  async _request(method, url, headers = {}, retried = false) {
    if (this.closed) throw new Error("camera connection closed");
    const res = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = null; reject(Object.assign(new Error("camera did not answer " + method), { code: "ETIMEDOUT" })); }, this.timeoutMs);
      if (timer.unref) timer.unref();
      this.pending = { resolve, reject, timer };
      try { this.sock.write(this._format(method, url, headers)); }
      catch (e) { clearTimeout(timer); this.pending = null; reject(e); }
    });
    if (res.status === 401 && !retried && res.headers["www-authenticate"]) {
      this.challenge = parseAuthenticate(res.headers["www-authenticate"]);
      return this._request(method, url, headers, true);
    }
    if (res.status === 401) throw Object.assign(new Error("the camera rejected the LAN access code"), { code: "EAUTH" });
    if (res.status === 404 || res.status === 454) throw Object.assign(new Error("the camera stream was not found (" + res.status + ")"), { code: "ENOSTREAM" });
    if (res.status < 200 || res.status >= 300) throw new Error("camera answered " + method + " with " + res.status + " " + res.reason);
    return res;
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (!this.buf.length) return;
      if (this.buf[0] === 0x24) { // "$" interleaved binary frame
        if (this.buf.length < 4) return;
        const len = this.buf.readUInt16BE(2);
        if (this.buf.length < 4 + len) return;
        const channel = this.buf[1];
        const payload = this.buf.subarray(4, 4 + len);
        this.buf = this.buf.subarray(4 + len);
        this.emit("rtp", channel, payload);
        continue;
      }
      const headEnd = this.buf.indexOf("\r\n\r\n");
      if (headEnd === -1) {
        if (this.buf.length > MAX_RTSP_HEADER) { this._close(new Error("malformed RTSP response")); }
        return;
      }
      const head = this.buf.subarray(0, headEnd).toString("latin1");
      const lines = head.split("\r\n");
      const status = /^RTSP\/1\.0\s+(\d{3})\s*(.*)$/.exec(lines[0]);
      if (!status) { this._close(new Error("malformed RTSP response")); return; }
      const headers = {};
      for (const l of lines.slice(1)) {
        const i = l.indexOf(":");
        if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      const bodyLen = Number(headers["content-length"] || 0);
      if (this.buf.length < headEnd + 4 + bodyLen) return;
      const body = this.buf.subarray(headEnd + 4, headEnd + 4 + bodyLen);
      this.buf = this.buf.subarray(headEnd + 4 + bodyLen);
      const p = this.pending;
      if (p) { this.pending = null; clearTimeout(p.timer); p.resolve({ status: Number(status[1]), reason: status[2], headers, body: Buffer.from(body) }); }
    }
  }

  _close(err) {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(err || new Error("camera connection closed")); this.pending = null; }
    try { this.sock && this.sock.destroy(); } catch {}
    this.emit("close", err || null);
  }
}

module.exports = { RtspClient, _internal: { parseAuthenticate, authorization, parseSdp, resolveControl } };
