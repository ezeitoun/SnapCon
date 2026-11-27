// fixtures/virtual-u1/server.js — Moonraker's HTTP and WebSocket API in front
// of a VirtualU1 model, on 127.0.0.1 only. Tests point a real SnapCon
// connector at it.
//
//   const { startVirtualU1 } = require("../../fixtures/virtual-u1");
//   const u1 = await startVirtualU1({ firmware: "1.6.0" });
//   const p = { id: "v1", name: "Virtual U1", url: u1.url };
//   …connector calls…
//   await u1.close();
//
// Options: firmware, heads (see model.js), files: false (no default files),
// port, and timing: "fast" (default — waits skipped, time moves only when
// model.advance() is called) or "real" (steps take Yellow's real time, a
// G-code reply waits until its step is done, and a wall clock moves time;
// pass clock: false to keep "real" waits but step time by hand in a test;
// clock: true runs the wall clock with "fast" too, as the Virtual U1 printer
// in the app does), and printSpeed / instantHeat (model.js).
//
// Shapes of replies SnapCon reads come from the captures [live]; the rest are
// stock Moonraker shapes [guess: not read off a U1] and say so.
const http = require("http");
const crypto = require("crypto");
const { VirtualU1, GcodeError } = require("./model");

// Smallest valid images: a 1×1 PNG and a JPEG (SOI/APP0/EOI).
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
  "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function send(res, status, body, type = "application/json") {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(type === "application/json" ? JSON.stringify(body) : String(body));
  res.writeHead(status, { "content-type": type, "content-length": buf.length });
  res.end(buf);
}
const ok = (res, result) => send(res, 200, { result });
// [guess] Moonraker's error envelope.
const fail = (res, status, message) => send(res, status, { error: { code: status, message } });

// ---- WebSocket framing (RFC 6455), server side: just enough for JSON-RPC ----
function wsFrame(text, opcode = 1) {
  const payload = Buffer.from(text);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([head, payload]);
}

// Pulls complete frames off `buf`; returns { frames, rest }.
function wsParse(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    let len = b1 & 127, p = off + 2;
    if (len === 126) { if (buf.length < p + 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length < p + 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const masked = b1 & 128;
    const mask = masked ? buf.slice(p, p + 4) : null;
    if (masked) p += 4;
    if (buf.length < p + len) break;
    const data = Buffer.from(buf.slice(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    frames.push({ fin: !!(b0 & 128), opcode: b0 & 15, data });
    off = p + len;
  }
  return { frames, rest: buf.slice(off) };
}

class Server {
  constructor(model) {
    this.model = model;
    this.requests = [];           // "METHOD /path?query" of every HTTP request
    this.rpcLog = [];             // every JSON-RPC method received over the WebSocket
    this.sockets = new Set();
    this.clients = new Set();     // open WebSocket connections
    // Faults a test can switch on: each is a predicate on the request path.
    this.faults = { delayMs: 0, delayPath: null, hangPath: null, statusPath: null, status: 500, malformedPath: null, rpcSilent: false };
    this.klippyGone = false;      // Klippy disconnected: Moonraker up, Klipper not
    this.http = http.createServer((req, res) => this.handle(req, res).catch(e => fail(res, 500, e.message)));
    this.http.on("connection", s => { this.sockets.add(s); s.on("close", () => this.sockets.delete(s)); });
    this.http.on("upgrade", (req, socket) => this.upgrade(req, socket));
    model.onChange(() => this.broadcast());
    this.clock = null;
  }

  // Moves model time with the wall clock, as a running printer would.
  startClock(stepMs = 250) {
    if (this.clock) return;
    this.clock = setInterval(() => this.model.advance(stepMs / 1000), stepMs);
    this.clock.unref();
  }
  stopClock() { clearInterval(this.clock); this.clock = null; }

  listen(port = 0) {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, "127.0.0.1", () => { this.port = this.http.address().port; resolve(this.port); });
    });
  }

  // ---- HTTP ----
  async handle(req, res) {
    const u = new URL(req.url, "http://virtual-u1");
    const p = u.pathname;
    this.requests.push(req.method + " " + p + u.search);
    const f = this.faults;
    const hit = re => re && re.test(p);
    if (hit(f.hangPath)) return; // accepts the connection, never answers
    if (f.delayMs && (!f.delayPath || hit(f.delayPath))) await new Promise(r => setTimeout(r, f.delayMs));
    if (hit(f.statusPath)) return fail(res, f.status, "Simulated failure");
    if (hit(f.malformedPath)) return send(res, 200, Buffer.from('{"result": {"status": '), "application/json");

    const m = this.model;
    const klippyRoute = /^\/printer\//.test(p);
    // [source moonraker] with Klippy gone, printer/* routes answer 503.
    if (klippyRoute && this.klippyGone) return fail(res, 503, "Klippy Disconnected");

    if (req.method === "GET" && p === "/printer/objects/query") {
      const request = {};
      for (const [k, v] of u.searchParams) request[k] = v ? v.split(",") : null;
      return ok(res, { eventtime: m.time, status: m.query(request) });
    }
    if (req.method === "GET" && p === "/printer/objects/list") return ok(res, { objects: m.idleCapture.objectsList });
    if (req.method === "GET" && p === "/printer/info") {
      return ok(res, { ...m.idleCapture.printerInfo, state: m.klippy.state, state_message: m.klippy.message });
    }
    if (req.method === "POST" && p === "/printer/gcode/script") {
      try { m.runScript(u.searchParams.get("script") || ""); }
      catch (e) { if (e instanceof GcodeError) return fail(res, 400, e.message); throw e; }
      // [live] the request returns when the script has finished — a resume
      // only once the head is reheated. Immediate with timing "fast".
      await m.settled();
      return ok(res, "ok");
    }
    if (req.method === "POST" && p === "/printer/emergency_stop") { m.emergencyStop(); return ok(res, "ok"); }

    if (req.method === "GET" && p === "/server/info") return ok(res, this.serverInfo());
    if (req.method === "GET" && p === "/machine/system_info") return ok(res, m.idleCapture.systemInfo);
    // [guess] stock Moonraker shape; not read off a U1.
    if (req.method === "GET" && p === "/machine/proc_stats") {
      return ok(res, { moonraker_stats: [], throttled_state: { bits: 0, flags: [] }, cpu_temp: 48.5,
        network: {}, system_cpu_usage: { cpu: 12.5 }, system_memory: { total: 1000000, available: 600000, used: 400000 },
        system_uptime: 86400, websocket_connections: this.clients.size });
    }
    if (req.method === "GET" && p === "/server/webcams/list") return ok(res, m.idleCapture.webcams);
    if (req.method === "GET" && p === "/server/files/roots") return ok(res, m.idleCapture.filesRoots);
    if (req.method === "GET" && p === "/server/files/list") {
      const root = u.searchParams.get("root") || "gcodes";
      const files = m.files[root];
      if (!files) return fail(res, 400, `Invalid root request: ${root}`);
      return ok(res, [...files].map(([path, f]) => ({ path, modified: f.modified, size: f.content.length, permissions: "rw" })));
    }
    // [guess] stock Moonraker shape; not read off a U1.
    if (req.method === "GET" && p === "/server/files/directory") {
      const root = (u.searchParams.get("path") || "gcodes").split("/")[0];
      const files = m.files[root];
      if (!files) return fail(res, 404, "Directory does not exist");
      const used = [...files.values()].reduce((a, f) => a + f.content.length, 0);
      return ok(res, { dirs: [], files: [...files].map(([filename, f]) => ({ filename, modified: f.modified, size: f.content.length, permissions: "rw" })),
        disk_usage: { total: 30e9, used: 5e9 + used, free: 25e9 - used }, root_info: { name: root, permissions: "rw" } });
    }
    if (req.method === "GET" && p === "/server/files/metadata") {
      const f = m.files.gcodes.get(u.searchParams.get("filename") || "");
      if (!f) return fail(res, 404, "Metadata not available for " + u.searchParams.get("filename"));
      return ok(res, f.metadata);
    }
    if (req.method === "POST" && p === "/server/files/upload") return this.upload(req, res);
    if (p === "/server/files/camera/monitor.jpg") {
      // [snapcon] 404 until camera.start_monitor has run; then a frame.
      return m.cameraStarted ? send(res, 200, JPEG, "image/jpeg") : fail(res, 404, "File does not exist");
    }
    const file = /^\/server\/files\/([^/]+)\/(.+)$/.exec(p);
    if (file) return this.fileRoute(req, res, file[1], file[2].split("/").map(decodeURIComponent).join("/"));
    if (req.method === "GET" && p === "/server/history/list") {
      const limit = +(u.searchParams.get("limit") || 50);
      const jobs = [...m.history].reverse().slice(0, limit);
      return ok(res, { count: m.history.length, jobs });
    }
    // [guess] stock Moonraker shape; not read off a U1.
    if (req.method === "GET" && p === "/server/history/totals") {
      const sum = k => m.history.reduce((a, j) => a + (j[k] || 0), 0);
      return ok(res, { job_totals: { total_jobs: m.history.length, total_time: sum("total_duration"),
        total_print_time: sum("print_duration"), total_filament_used: sum("filament_used"), longest_job: 0, longest_print: 0 } });
    }
    return fail(res, 404, "Not Found");
  }

  serverInfo() {
    const si = this.model.idleCapture.serverInfo;
    const klippy = this.klippyGone ? "disconnected" : this.model.klippy.state;
    return { ...si, klippy_connected: !this.klippyGone, klippy_state: klippy, websocket_count: this.clients.size };
  }

  fileRoute(req, res, root, rel) {
    const files = this.model.files[root];
    if (!files) return fail(res, 400, "Invalid root");
    if (req.method === "DELETE") {
      if (!files.has(rel)) return fail(res, 404, "File does not exist");
      files.delete(rel);
      return ok(res, { item: { path: rel, root }, action: "delete_file" });
    }
    // Thumbnails live in .thumbs/ beside the file [live paths].
    if (/(^|\/)\.thumbs\/.+\.png$/.test(rel)) {
      const stem = rel.replace(/^.*\.thumbs\//, "").replace(/-\d+x\d+\.png$/, "");
      const owner = [...files.keys()].some(k => k.replace(/\.[^.]+$/, "") === stem);
      return owner ? send(res, 200, PNG, "image/png") : fail(res, 404, "File does not exist");
    }
    const f = files.get(rel);
    if (!f) return fail(res, 404, "File does not exist");
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (!range) return send(res, 200, f.content, "application/octet-stream");
    const size = f.content.length;
    let start, end;
    if (range[1] === "") { start = Math.max(0, size - +range[2]); end = size - 1; }
    else { start = +range[1]; end = range[2] === "" ? size - 1 : Math.min(+range[2], size - 1); }
    const body = f.content.slice(start, end + 1);
    res.writeHead(206, { "content-type": "application/octet-stream", "content-length": body.length, "content-range": `bytes ${start}-${end}/${size}` });
    res.end(body);
  }

  // Multipart upload, field "file" [snapcon uploadWithProgress]. A body that
  // ends short of its Content-Length (a cancelled upload) stores nothing.
  upload(req, res) {
    const expected = +req.headers["content-length"];
    const chunks = [];
    let got = 0;
    req.on("data", c => { chunks.push(c); got += c.length; });
    req.on("aborted", () => {});
    req.on("end", () => {
      if (expected && got !== expected) return;
      const body = Buffer.concat(chunks);
      const boundary = /boundary=(.+)$/.exec(req.headers["content-type"] || "");
      if (!boundary) return fail(res, 400, "No boundary");
      const sep = Buffer.from("--" + boundary[1]);
      const start = body.indexOf(sep);
      const headEnd = body.indexOf("\r\n\r\n", start);
      const head = body.slice(start, headEnd).toString();
      const name = (/filename="([^"]*)"/.exec(head) || [])[1];
      const dataEnd = body.indexOf(Buffer.from("\r\n--" + boundary[1]), headEnd);
      if (!name || dataEnd < 0) return fail(res, 400, "Malformed upload");
      const content = body.slice(headEnd + 4, dataEnd);
      // Prints as the file says (model.addUploadedFile).
      const file = this.model.addUploadedFile(name, content, { modified: Math.floor(Date.now() / 1000) });
      this.model.changed();
      // [guess] stock Moonraker upload reply.
      send(res, 201, { result: { item: { path: name, root: "gcodes", modified: file.modified, size: content.length, permissions: "rw" },
        print_started: false, print_queued: false, action: "create_file" } });
    });
  }

  // ---- WebSocket JSON-RPC ----
  upgrade(req, socket) {
    const key = req.headers["sec-websocket-key"];
    if (new URL(req.url, "http://x").pathname !== "/websocket" || !key) { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client = { socket, subscription: null, sent: {}, buf: Buffer.alloc(0) };
    this.clients.add(client);
    this.sockets.add(socket);
    const drop = () => { this.clients.delete(client); this.sockets.delete(socket); };
    socket.on("close", drop);
    socket.on("error", drop);
    socket.on("data", chunk => {
      const { frames, rest } = wsParse(Buffer.concat([client.buf, chunk]));
      client.buf = rest;
      for (const fr of frames) {
        if (fr.opcode === 8) { try { socket.write(wsFrame("", 8)); } catch {} socket.end(); return; }
        if (fr.opcode === 9) { socket.write(wsFrame(fr.data.toString(), 10)); continue; }
        if (fr.opcode === 1) this.rpc(client, fr.data.toString());
      }
    });
  }

  wsSend(client, msg) {
    try { client.socket.write(wsFrame(JSON.stringify(msg))); } catch {}
  }

  rpc(client, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    this.rpcLog.push(msg.method);
    if (this.faults.rpcSilent) return;
    const reply = result => this.wsSend(client, { jsonrpc: "2.0", result, id: msg.id });
    const error = (code, message) => this.wsSend(client, { jsonrpc: "2.0", error: { code, message }, id: msg.id });
    const m = this.model;
    switch (msg.method) {
      case "server.info": return reply(this.serverInfo());
      case "server.connection.identify": return reply({ connection_id: 1 });
      case "printer.objects.subscribe": {
        if (this.klippyGone) return error(503, "Klippy Disconnected");
        const objects = (msg.params || {}).objects || {};
        client.subscription = objects;
        const status = m.query(objects);
        client.sent = JSON.parse(JSON.stringify(status));
        return reply({ eventtime: m.time, status });
      }
      case "printer.objects.query": {
        if (this.klippyGone) return error(503, "Klippy Disconnected");
        return reply({ eventtime: m.time, status: m.query((msg.params || {}).objects || {}) });
      }
      // [snapcon] the U1 camera: start/stop_monitor over the WebSocket.
      case "camera.start_monitor": m.cameraStarted = true; return reply("ok");
      case "camera.stop_monitor": m.cameraStarted = false; return reply("ok");
      default: return error(-32601, "Method not found");
    }
  }

  // notify_status_update with only the fields that changed since the last
  // message to this client, one level deep [source moonraker].
  broadcast() {
    if (this.klippyGone) return;
    for (const c of this.clients) {
      if (!c.subscription) continue;
      const now = this.model.query(c.subscription);
      const delta = {};
      for (const [obj, fields] of Object.entries(now)) {
        const before = c.sent[obj] || {};
        for (const [k, v] of Object.entries(fields)) {
          if (JSON.stringify(before[k]) !== JSON.stringify(v)) (delta[obj] = delta[obj] || {})[k] = v;
        }
      }
      if (!Object.keys(delta).length) continue;
      c.sent = JSON.parse(JSON.stringify(now));
      this.wsSend(c, { jsonrpc: "2.0", method: "notify_status_update", params: [delta, this.model.time] });
    }
  }

  notifyAll(method) {
    for (const c of this.clients) this.wsSend(c, { jsonrpc: "2.0", method, params: [] });
  }

  // ---- fault controls ----
  // Klipper shuts down (E-stop, MCU fault): Moonraker keeps answering.
  klippyShutdown(message = "Lost communication with MCU 'mcu'") {
    this.model.shutdown(message);
    this.notifyAll("notify_klippy_shutdown");
  }
  // Klipper process gone: printer/* routes 503, subscriptions dropped.
  klippyDisconnect() {
    this.klippyGone = true;
    for (const c of this.clients) c.subscription = null;
    this.notifyAll("notify_klippy_disconnected");
  }
  // Klipper back (after a shutdown or a disconnect): a fresh start.
  klippyReady() {
    this.klippyGone = false;
    this.model.restart();
    this.notifyAll("notify_klippy_ready");
  }
  // The whole printer drops off the network: every socket closes, new
  // connections are refused until online().
  async offline() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.clients.clear();
    await new Promise(r => this.http.close(() => r()));
  }
  async online() {
    await this.listen(this.port);
  }

  async close() {
    this.stopClock();
    this.model.dropPending();
    for (const s of this.sockets) s.destroy();
    await new Promise(r => (this.http.listening ? this.http.close(() => r()) : r()));
  }
}

async function startVirtualU1(opts = {}) {
  const model = new VirtualU1(opts);
  if (opts.files !== false) {
    model.addFile("Virtual cube (single colour).gcode", { tools: [0], layers: 10, secondsPerLayer: 20 });
    model.addFile("Virtual dragon (4 colours).gcode", { tools: [0, 1, 2, 3], layers: 12, secondsPerLayer: 60 });
  }
  const server = new Server(model);
  await server.listen(opts.port || 0);
  if (opts.clock === true || (model.timing === "real" && opts.clock !== false)) server.startClock();
  return {
    model, server,
    get url() { return "http://127.0.0.1:" + server.port; },
    get port() { return server.port; },
    close: () => server.close()
  };
}

module.exports = { startVirtualU1, Server, wsFrame, wsParse };
