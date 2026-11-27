// notifyCli.js — the command-line hook (`SnapCon --load <file> --printer
// <name>`), moved out of server.js so it can be tested (docs/TODO.md §37 P4).
//
// It pings an ALREADY-RUNNING instance's HTTP API and exits — it never starts
// the web server, and never loads the server's stores (server.js calls this
// before it loads anything a running server may be writing).
// --outputname is cosmetic + the upload filename only; the file read from
// disk is always the --load path.
// `--snapcon <host[:port]>` targets a SnapCon instance on a DIFFERENT machine:
// it can't read a path off this machine's disk, so this reads the file and
// streams its bytes instead of sending a path reference. Without --snapcon,
// the same-machine path-reference flow with the local notify token.
//
// Without --wait: output and exit codes exactly as before P4 — the reply on
// stdout ("SnapCon: {json}") and exit 0 once SnapCon accepted the file, or
// the error on stderr and exit 1. Being accepted is not being delivered.
//
// With --wait [seconds] (default 300, at most 1800): the same first line,
// then it follows the transfer (GET /api/transfers/:id) and prints its final
// result on stdout ("SnapCon result: {json}") plus one plain sentence on
// stderr, with progress on stderr at most every 10 s. Exit codes:
//   0  delivered: verified (exact size, and start, middle and end sampled —
//      not every byte) or acknowledged (size or name only)
//   1  failed, cancelled, or refused when sent
//   3  still under way when the time ran out
//   4  unknown, or no longer followable (SnapCon no longer knows the id, it
//      refused to say, or did not answer by the deadline)
// A moment without an answer (SnapCon restarting) is waited out, never taken
// as a failed upload.
const fs = require("fs");
const path = require("path");
const http = require("http");
const { readNotifyToken } = require("./notifyToken");

const WAIT_DEFAULT_S = 300, WAIT_MAX_S = 1800;
const EXIT = Object.freeze({ delivered: 0, failed: 1, timeout: 3, unknown: 4 });
const POLL_FAST_MS = 2000, POLL_SLOW_MS = 5000, POLL_FAST_FOR_MS = 30000, SAY_EVERY_MS = 10000, REQUEST_TIMEOUT_MS = 10000;
// --snapcon upload: give up when nothing moves either way for this long (§51).
const UPLOAD_IDLE_MS = 120000;

// "host", "host:port", "[ipv6]", or "[ipv6]:port" — bracket form first so a
// bare colon inside an IPv6 address is never mistaken for a port split.
function parseTarget(target) {
  const s = String(target);
  const bracketed = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) return { hostname: bracketed[1], port: bracketed[2] ? parseInt(bracketed[2], 10) : 4545 };
  const i = s.lastIndexOf(":");
  const tail = i !== -1 ? s.slice(i + 1) : "";
  if (i !== -1 && /^\d+$/.test(tail)) return { hostname: s.slice(0, i), port: parseInt(tail, 10) };
  return { hostname: s, port: 4545 };
}
// null (not asked), a number of seconds, or { error }.
function parseWait(argv) {
  const i = argv.indexOf("--wait");
  if (i === -1) return null;
  const next = argv[i + 1];
  if (next == null || next.startsWith("--")) return WAIT_DEFAULT_S;
  if (!/^\d+$/.test(next) || +next < 1 || +next > WAIT_MAX_S) return { error: `--wait takes a number of seconds from 1 to ${WAIT_MAX_S}` };
  return +next;
}
// As before P4, exactly: a flag given last yields undefined, absent yields "".
const arg = (argv, name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : ""; };

// One request: { status, text } or a rejection (no answer at all).
function request(httpImpl, opts, send, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = httpImpl.request(opts, res => {
      let b = ""; res.setEncoding("utf8"); res.on("data", d => b += d);
      res.on("end", () => resolve({ status: res.statusCode, text: b }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("no answer within " + Math.round(timeoutMs / 1000) + " s"), { code: "ETIMEDOUT" })));
    send(req);
  });
}
// Streams a file as one POST body (--snapcon) and settles exactly once
// (docs/TODO.md §51). A file that can't be opened or read, or that ends with
// fewer bytes than announced (it shrank or was replaced); a connection that
// fails, closes before SnapCon answers, or makes no progress for idleMs — each
// rejects once, with both the file stream and the request destroyed, so no
// stream error is ever left unhandled and no promise is left pending. idleMs
// is an inactivity limit (no bytes either way), not a limit on the whole
// upload: a large file that keeps moving is never cut off. Source problems
// carry .source = true so the caller can say "could not read the file".
function sendFile(httpImpl, fsImpl, opts, file, size, idleMs) {
  return new Promise((resolve, reject) => {
    let settled = false, src = null, req = null, res = null, sentBytes = 0;
    const finish = (e, value) => {
      if (settled) return;                  // a second error close behind the first changes nothing
      settled = true;
      if (e) {
        try { if (src) src.destroy(); } catch { /* already gone */ }
        try { if (req) req.destroy(); } catch { /* already gone */ }
        reject(e);
      } else resolve(value);
    };
    const sourceError = (msg, code) => Object.assign(new Error(msg), { code, source: true });
    try {
      req = httpImpl.request(opts, r => {
        res = r;
        let b = ""; r.setEncoding("utf8"); r.on("data", d => { b += d; });
        r.on("end", () => finish(null, { status: r.statusCode, text: b }));
        r.on("error", e => finish(e));
        r.on("close", () => { if (!r.complete) finish(Object.assign(new Error("the connection closed before SnapCon finished answering"), { code: "ECONNRESET" })); });
      });
    } catch (e) { finish(e); return; }
    req.on("error", e => finish(e));
    req.on("close", () => { if (!res) finish(Object.assign(new Error("the connection closed before SnapCon answered"), { code: "ECONNRESET" })); });
    if (idleMs) req.setTimeout(idleMs, () => finish(Object.assign(new Error("no progress for " + Math.round(idleMs / 1000) + " s"), { code: "ETIMEDOUT" })));
    try { src = fsImpl.createReadStream(file); }
    catch (e) { finish(sourceError(e.message, e.code)); return; }
    src.on("error", e => finish(sourceError(e.message, e.code)));
    src.on("data", d => { sentBytes += d.length; });
    src.on("end", () => { if (sentBytes !== size) finish(sourceError(`the file changed while it was being sent (${sentBytes} of ${size} bytes)`, "ESIZE")); });
    src.pipe(req);
  });
}
const parseJson = text => { try { const j = JSON.parse(text); return j && typeof j === "object" ? j : null; } catch { return null; } };

// What a status says while it is under way, for stderr (and the key that
// decides whether it changed).
function progressLine(s, printer) {
  if (s.state === "queued") return s.waitingFor === "source" ? ["queued-source", "Waiting: the file's folder doesn't answer; SnapCon checks again shortly."]
    : s.waitingFor === "printer" ? ["queued-printer", `Waiting: ${printer} couldn't say whether it already has a file of this name (replacing is off); SnapCon asks again shortly.`]
    : ["queued", `Waiting: ${printer} is busy; the file is queued.`];
  if (s.state === "interrupted") return ["interrupted", "SnapCon restarted during the transfer; it is checking the printer."];
  if (s.state === "uploading") {
    if (s.phase === "sending" && s.total > 0) { const pct = Math.floor((100 * (s.sent || 0)) / s.total); return ["sending-" + Math.floor(pct / 10), `Sending to ${printer}: ${pct}%`]; }
    if (s.phase === "confirming") return ["confirming", `Sent; waiting for ${printer} to confirm.`];
    if (s.phase === "verifying") return ["verifying", "Checking the printer's copy."];
    if (s.phase === "finishing") return ["finishing", `Setting up ${printer}.`];
    return ["preparing", "Preparing to send."];
  }
  return [s.state || "?", `Waiting (${s.state}).`];
}
function finalSentence(s, printer) {
  const how = s.basis === "size" ? "size" : "name";
  if (s.state === "verified") return [EXIT.delivered, `Delivered to ${printer}: the printer's copy has the same size, and its start, middle and end match the file (sampled, not compared byte for byte).`];
  if (s.state === "acknowledged") return [EXIT.delivered, `Delivered to ${printer}, checked by ${how} only: the printer lists a file of that ${how} under this name, but its content wasn't compared.`];
  if (s.state === "failed") return [EXIT.failed, `Not delivered to ${printer}: ${s.message || s.code || "the transfer failed"}`];
  if (s.state === "cancelled") return [EXIT.failed, s.outcome === "sent" ? `Cancelled after the file reached ${printer}.` : s.outcome === "unknown" ? `Cancelled; it isn't known whether ${printer} has the file.` : "Cancelled before anything was sent."];
  return [EXIT.unknown, `It isn't known whether ${printer} has the complete file${s.message ? ` (${s.message})` : ""}. Check the printer's card in SnapCon.`];
}

// Follows a transfer to its end or the deadline; returns the exit code.
async function follow({ get, transferId, waitS, printer, out, err, now, sleep }) {
  const deadline = now() + waitS * 1000, started = now();
  let last = null, lastErr = null, saidKey = "", saidAt = -Infinity;
  const say = (key, line) => { if (key !== saidKey && now() - saidAt >= SAY_EVERY_MS) { err(line); saidKey = key; saidAt = now(); } };
  const result = (body, sentence, code) => { out("SnapCon result: " + JSON.stringify(body)); err(sentence); return code; };
  for (;;) {
    let r = null;
    try { r = await get(transferId); } catch (e) { lastErr = e; }
    if (r) {
      const body = parseJson(r.text);
      if (r.status === 200 && body && body.state) {
        lastErr = null; last = body;
        if (body.final) { const [code, sentence] = finalSentence(body, printer); return result(body, sentence, code); }
        say(...progressLine(body, printer));
      } else if (r.status === 404) {
        return result({ transferId, state: "lost", final: false }, "SnapCon no longer knows this transfer: it may have restarted without it, or its result expired. Check the printer's card in SnapCon.", EXIT.unknown);
      } else if (r.status === 401 || r.status === 403) {
        return result({ transferId, state: "lost", final: false }, `SnapCon refused to report this transfer (HTTP ${r.status}). Check the printer's card in SnapCon.`, EXIT.unknown);
      } else lastErr = new Error("HTTP " + r.status);
    }
    if (lastErr) say("unreachable", "SnapCon doesn't answer right now; still trying.");
    const left = deadline - now();
    if (left <= 0) {
      if (lastErr) return result({ transferId, state: "unreachable", final: false, ...(last ? { lastState: last.state } : {}) }, `Couldn't reach SnapCon to follow the transfer (${lastErr.message}). It may still finish; check SnapCon.`, EXIT.unknown);
      return result({ ...last, final: false }, `Still not finished after ${waitS} s (${progressLine(last, printer)[1]}). It continues in SnapCon.`, EXIT.timeout);
    }
    await sleep(Math.min(now() - started < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS, left));
  }
}

// Returns the exit code. The caller exits with it.
async function runNotifyCli({ argv, port, tokenPath, fsImpl = fs, httpImpl = http, out = console.log, err = console.error, uploadIdleMs = UPLOAD_IDLE_MS,
  now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const file = arg(argv, "--load");
  const printer = arg(argv, "--printer");
  const outputname = arg(argv, "--outputname");
  const snapconTarget = arg(argv, "--snapcon");
  if (!file) { err("--load requires a file path"); return 1; }
  if (!fsImpl.existsSync(file) || !fsImpl.statSync(file).isFile()) { err("File not found: " + file); return 1; }
  const wait = parseWait(argv);
  if (wait && wait.error) { err(wait.error); return 1; }

  let sent, get;
  if (snapconTarget) {
    const { hostname, port: tport } = parseTarget(snapconTarget);
    const stat = fsImpl.statSync(file);
    const qs = "printer=" + encodeURIComponent(printer) + "&outputname=" + encodeURIComponent(outputname) + "&filename=" + encodeURIComponent(path.basename(file));
    try {
      sent = await sendFile(httpImpl, fsImpl, { hostname, port: tport, path: "/api/notify-load?" + qs, method: "POST", headers: { "Content-Type": "application/octet-stream", "Content-Length": stat.size } },
        file, stat.size, uploadIdleMs);
    } catch (e) {
      if (e.source) { err("Could not read " + file + " while sending it (" + e.message + ")"); return 1; }
      err("Could not reach SnapCon at " + hostname + ":" + tport + " (" + e.message + ")"); return 1;
    }
    get = id => request(httpImpl, { hostname, port: tport, path: "/api/transfers/" + encodeURIComponent(id), method: "GET" }, req => req.end(), REQUEST_TIMEOUT_MS);
  } else {
    // Reads (never generates) the local notify token the running server
    // already established at its own startup — see notifyToken.js's header
    // comment for why the CLI must never be the one to create this value.
    const notifyToken = readNotifyToken(tokenPath);
    if (!notifyToken) {
      err("SnapCon: no local notify token found at " + tokenPath + " — is SnapCon running (has it started at least once)? If it logged a token-persistence failure, this feature is unavailable until that's fixed.");
      return 1;
    }
    const body = JSON.stringify({ file: path.resolve(file), printer, outputname });
    try {
      sent = await request(httpImpl, { hostname: "127.0.0.1", port, path: "/api/notify-load", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-SnapCon-Local-Token": notifyToken } }, req => { req.write(body); req.end(); });
    } catch (e) { err("Could not reach SnapCon on port " + port + " — is it running? (" + e.message + ")"); return 1; }
    get = id => request(httpImpl, { hostname: "127.0.0.1", port, path: "/api/transfers/" + encodeURIComponent(id), method: "GET", headers: { "X-SnapCon-Local-Token": notifyToken } }, req => req.end(), REQUEST_TIMEOUT_MS);
  }
  if (sent.status >= 300) { err("SnapCon: " + sent.text); return 1; }
  out("SnapCon: " + sent.text);
  if (!wait) return 0;

  const reply = parseJson(sent.text);
  const transferId = reply && typeof reply.transferId === "string" ? reply.transferId : null;
  if (!transferId) { err("SnapCon accepted the file but returned no transfer id to follow (an older SnapCon?), so its delivery can't be followed."); return EXIT.unknown; }
  return follow({ get, transferId, waitS: wait, printer: (reply && reply.printer) || printer || "the printer", out, err, now, sleep });
}

module.exports = { runNotifyCli, parseTarget, parseWait, EXIT, WAIT_DEFAULT_S, WAIT_MAX_S };
