// connectors/ftps-client.js — an FTP client over implicit TLS, the file access
// every Bambu Lab printer offers on port 990 (user bblp, password = the LAN
// access code).
//
// Reads: SIZE, NLST, and RETR — optionally from an offset (REST), which lets
// the preview reader pull one entry out of a multi-megabyte .3mf instead of the
// whole file. Writes: STOR (sending a sliced project to print) and DELE
// (cleaning up a transfer that failed part-way). No MKD/RMD/RNFR: SnapCon
// writes files into the printer's root and nothing else.
//
// Both halves of the conversation are TLS: the control connection from the
// first byte (implicit FTPS), and every passive data connection, which reuses
// the control connection's TLS session as Bambu's server (like vsftpd with
// require_ssl_reuse) insists. The caller supplies the socket factories, so the
// certificate policy (Bambu CA + serial as CN) lives in the connector.
const { EventEmitter } = require("events");
const fsStatSize = (p) => require("fs").statSync(p).size;

class FtpsClient extends EventEmitter {
  constructor({ connectControl, connectData, timeoutMs = 15000 }) {
    super();
    this.connectControl = connectControl; // () => TLS socket
    this.connectData = connectData;       // (port, session) => TLS socket
    this.timeoutMs = timeoutMs;
    this.sock = null;
    this.buf = "";
    this.queue = [];   // pending reply waiters, in order
    this.replies = []; // replies that arrived with nobody waiting
    this.closed = false;
  }

  async connect(user, pass) {
    this.sock = this.connectControl();
    this.sock.setEncoding("latin1");
    this.sock.on("data", (d) => this._onData(d));
    this.sock.on("error", (e) => this._fail(e));
    this.sock.on("close", () => this._fail(new Error("FTP connection closed")));
    const hello = await this._reply();
    if (hello.code !== 220) throw new Error("FTP server greeting: " + hello.text);
    const u = await this.cmd("USER " + user);
    if (u.code === 331) {
      const p = await this.cmd("PASS " + pass);
      if (p.code !== 230) throw Object.assign(new Error("FTP login rejected (" + p.code + ")"), { code: "EAUTH" });
    } else if (u.code !== 230) throw Object.assign(new Error("FTP login rejected (" + u.code + ")"), { code: "EAUTH" });
    await this.cmd("PBSZ 0");
    const prot = await this.cmd("PROT P");
    if (prot.code !== 200) throw new Error("FTP server refused an encrypted data channel");
    await this.cmd("TYPE I");
  }

  // Commands never carry CR/LF from a caller: a file name from the printer's
  // own report is the only variable part, and a newline there would inject
  // a second FTP command.
  async cmd(line) {
    if (/[\r\n]/.test(line)) throw new Error("refusing an FTP command containing a line break");
    this.sock.write(line + "\r\n");
    return this._reply();
  }

  async size(path) {
    const r = await this.cmd("SIZE " + path);
    if (r.code === 213) { const n = Number(r.text.trim().split(/\s+/).pop()); return Number.isFinite(n) ? n : null; }
    if (r.code === 550) return null;
    throw Object.assign(new Error("SIZE not supported (" + r.code + ")"), { code: "ENOSIZE" });
  }

  async list(dir) {
    const data = await this._transfer("NLST " + dir, 0, Infinity);
    return data.toString("utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.slice(s.lastIndexOf("/") + 1));
  }

  // Names WITH sizes and dates, in one transfer. NLST would need a SIZE call
  // per file — 137 round trips on a printer with a full library.
  //
  // Unix-style listing: "perms links owner group size Mon DD hh:mm name". The
  // date is three whitespace-separated fields, so a lazy match swallows part of
  // it into the file name (a real bug found against a printer, where names came
  // back as "20:02 video_...").
  async listDetailed(dir) {
    const data = await this._transfer("LIST " + dir, 0, Infinity);
    const out = [];
    for (const line of data.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = /^([-dl])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/.exec(line);
      if (!m) continue;
      out.push({ name: m[4], size: Number(m[2]), dir: m[1] === "d", raw: m[3] });
    }
    return out;
  }

  // Reads `length` bytes from `offset`. Stops the transfer as soon as enough
  // has arrived (the server then reports the aborted transfer, which is
  // expected and swallowed). Rejects with code ENOREST if the server does not
  // accept an offset, so the caller can fall back to one whole-file read.
  async read(path, offset = 0, length = Infinity, maxBytes = Infinity) {
    return this._transfer("RETR " + path, offset, length, maxBytes);
  }

  // Sends a local file as `name` in the printer's root, reporting progress
  // through `job` ({ total, sent }) so the upload bar is real rather than a
  // spinner. Rejects unless the printer confirms the whole transfer: a .3mf
  // that arrived truncated is a file an operator could start by hand from the
  // printer's screen.
  async store(localPath, name, job = {}) {
    if (/[\r\n]/.test(name)) throw new Error("refusing a file name containing a line break");
    const total = fsStatSize(localPath);
    job.total = total;
    job.sent = 0;
    const port = await this._pasv();
    const data = this.connectData(port, this.sock.getSession());
    const sent = new Promise((resolve, reject) => {
      let timer;
      // An idle timeout re-armed on every chunk: a 40 MB project on a busy
      // printer takes a while in total but must never stall for long.
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { data.destroy(); reject(Object.assign(new Error("FTP upload timed out"), { code: "ETIMEDOUT" })); }, this.timeoutMs);
        if (timer.unref) timer.unref();
      };
      arm();
      const file = require("fs").createReadStream(localPath);
      let finished = false;
      file.on("data", (chunk) => { job.sent += chunk.length; arm(); });
      file.on("error", (e) => { clearTimeout(timer); data.destroy(); reject(e); });
      data.on("error", (e) => { clearTimeout(timer); if (!finished) reject(e); });
      // The printer closing the data connection early is a failed transfer, not
      // a finished one — the 226/426 below is what actually decides.
      data.on("close", () => { clearTimeout(timer); finished = true; resolve(); });
      file.pipe(data);
    });
    sent.catch(() => {});   // awaited below
    const start = await this.cmd("STOR " + name);
    if (start.code !== 150 && start.code !== 125) {
      data.destroy();
      throw Object.assign(new Error("The printer refused the upload (" + start.code + " " + start.text.trim() + ")"), { code: "ESTOR", reply: start.code, started: false });
    }
    await sent;
    const end = await this._reply();
    if (end.code !== 226 && end.code !== 250) {
      throw Object.assign(new Error("The upload did not complete (" + end.code + " " + end.text.trim() + ")"), { code: "ESTOR", reply: end.code, started: true });
    }
    if (job.sent !== total) {
      throw Object.assign(new Error(`Only ${job.sent} of ${total} bytes reached the printer`), { code: "ESHORT", started: true });
    }
    return total;
  }

  // Best-effort during cleanup: true when the file is gone, false when it was
  // not there to begin with. Anything else (a printer that refuses deletes)
  // throws, so a caller deleting on purpose still hears about it.
  async remove(name) {
    if (/[\r\n]/.test(name)) throw new Error("refusing a file name containing a line break");
    const r = await this.cmd("DELE " + name);
    if (r.code === 250 || r.code === 200) return true;
    if (r.code === 550) return false;
    throw Object.assign(new Error("Could not delete " + name + " (" + r.code + ")"), { code: "EDELE" });
  }

  async _pasv() {
    const pasv = await this.cmd("PASV");
    if (pasv.code !== 227) throw new Error("FTP passive mode refused (" + pasv.code + ")");
    const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(pasv.text);
    if (!m) throw new Error("unreadable PASV reply");
    // The advertised host is ignored — the data connection always goes to the
    // host the control connection verified, never to an address in a reply.
    return Number(m[5]) * 256 + Number(m[6]);
  }

  async _transfer(command, offset, length, maxBytes = Infinity) {
    const port = await this._pasv();
    if (offset > 0) {
      const rest = await this.cmd("REST " + offset);
      if (rest.code !== 350) throw Object.assign(new Error("FTP server does not support REST"), { code: "ENOREST" });
    }
    // The data socket is opened BEFORE the command is sent and its TLS
    // handshake is not awaited: the server only runs that handshake once the
    // transfer command has arrived.
    const data = this.connectData(port, this.sock.getSession());
    const chunks = [];
    let got = 0, cut = false;
    const done = new Promise((resolve, reject) => {
      // An IDLE timeout, re-armed on every chunk: a large file on a slow
      // printer may take minutes in total, but must never stall for long.
      let timer;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { data.destroy(); reject(Object.assign(new Error("FTP transfer timed out"), { code: "ETIMEDOUT" })); }, this.timeoutMs);
        if (timer.unref) timer.unref();
      };
      arm();
      data.on("data", (d) => {
        if (cut) return;
        arm();
        chunks.push(d); got += d.length;
        if (got > maxBytes) { cut = true; data.destroy(); clearTimeout(timer); reject(Object.assign(new Error("file too large to read"), { code: "ETOOBIG" })); return; }
        if (got >= length) { cut = true; data.destroy(); clearTimeout(timer); resolve(); }
      });
      data.on("error", (e) => { clearTimeout(timer); if (!cut) reject(e); });
      data.on("close", () => { clearTimeout(timer); resolve(); });
    });
    done.catch(() => {}); // awaited below; this only keeps an early throw from leaving it unhandled
    const start = await this.cmd(command);
    if (start.code !== 150 && start.code !== 125) { data.destroy(); throw Object.assign(new Error("FTP " + command.split(" ")[0] + " refused (" + start.code + ")"), { code: start.code === 550 ? "ENOENT" : "EFTP" }); }
    await done;
    // Completion (226) or, after we cut the transfer short, 426/451 — either
    // way one final reply belongs to this transfer.
    const end = await this._reply().catch(() => null);
    if (!cut && end && end.code >= 400) throw new Error("FTP transfer failed (" + end.code + ")");
    if (cut) {
      // Some servers answer an aborted transfer twice (426, then 226). Let a
      // late second reply land and drop it, so the next command never reads
      // this transfer's reply as its own.
      await new Promise(r => setTimeout(r, 150));
      this.replies = [];
    }
    const all = Buffer.concat(chunks);
    return Number.isFinite(length) ? all.subarray(0, length) : all;
  }

  close() {
    if (this.closed) return;
    try { this.sock && this.sock.write("QUIT\r\n"); } catch {}
    try { this.sock && this.sock.end(); } catch {}
    this.closed = true;
    setTimeout(() => { try { this.sock && this.sock.destroy(); } catch {} }, 1000).unref?.();
  }

  _reply() {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    if (this.closed) return Promise.reject(new Error("FTP connection closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.queue = this.queue.filter(w => w !== waiter); reject(Object.assign(new Error("FTP server did not answer"), { code: "ETIMEDOUT" })); }, this.timeoutMs);
      if (timer.unref) timer.unref();
      const waiter = { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      this.queue.push(waiter);
    });
  }

  _onData(text) {
    this.buf += text;
    // Multi-line replies: "123-first line" ... "123 last line".
    for (;;) {
      const lines = this.buf.split("\r\n");
      if (lines.length < 2) return;
      const first = /^(\d{3})([ -])/.exec(lines[0]);
      if (!first) { this.buf = lines.slice(1).join("\r\n"); continue; }
      let endIdx = 0;
      if (first[2] === "-") {
        endIdx = lines.findIndex((l, i) => i > 0 && l.startsWith(first[1] + " "));
        if (endIdx === -1) return;
      }
      const text2 = lines.slice(0, endIdx + 1).join("\n");
      this.buf = lines.slice(endIdx + 1).join("\r\n");
      const reply = { code: Number(first[1]), text: text2.slice(4) };
      const w = this.queue.shift();
      if (w) w.resolve(reply); else this.replies.push(reply);
    }
  }

  _fail(err) {
    if (this.closed && !this.queue.length) return;
    this.closed = true;
    const q = this.queue; this.queue = [];
    for (const w of q) w.reject(err);
  }
}

module.exports = { FtpsClient };