// connectors/http-utils.js — shared primitives for Moonraker-based connectors.
// Anything here is genuinely protocol-generic: plain Moonraker REST calls that
// never branch on a specific printer brand. A non-Moonraker connector (Bambu,
// etc.) simply won't require this file.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { Readable } = require("stream");
const { parseGcodeMap, normHex } = require("../parser");
// Local job files are read through netfs: the G-code folder is often a NAS,
// and a synchronous read of an unreachable share froze the whole server for
// ~21 s on Windows. netfs reads in worker threads with per-chunk timeouts.
const netfs = require("../netfs").getNetFs();

const baseUrl = p => String(p.url).replace(/\/+$/, "");

// Moonraker's WebSocket address for a printer, on the same host AND port as
// its HTTP address. A real U1 stores no port (always 80), so its address is
// the bare ws://<ip>/websocket; a printer on another port keeps that port.
// Throws on an unparseable url, like new URL().
function websocketUrl(p) {
  const token = p.token || "";
  return `ws://${new URL(baseUrl(p)).host}/websocket${token ? "?token=" + encodeURIComponent(token) : ""}`;
}

// fetch with a built-in timeout via AbortController.
// NOTE: the timer only covers the response HEADERS — reading the body after
// this resolves is unbounded. Use fetchJSONTimeout when you consume the body.
async function fetchTimeout(url, ms = 3500, opts = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

// Fetch + read the body under ONE timeout (docs/TODO.md §37 P1): the body of a
// ranged read is what the identity check compares, and a printer that sends
// the headers and then stalls would otherwise hold it — and the upload or the
// queue dispatch waiting on it — forever.
// A Range request answered with anything but 206 is not read further: the
// caller cannot compare it, and a 200 would be the whole file (§37 P2 reads
// back after every upload, so a printer that ignores ranges must not cost a
// whole download each time).
async function fetchBufferTimeout(url, ms, opts = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (opts.headers && opts.headers.Range && r.status !== 206) {
      ctrl.abort();
      return { ok: r.ok, status: r.status, buffer: Buffer.alloc(0) };
    }
    return { ok: r.ok, status: r.status, buffer: Buffer.from(await r.arrayBuffer()) };
  } finally { clearTimeout(id); }
}

// Fetch + parse JSON under ONE timeout. A printer that accepts the connection
// but stalls mid-body would otherwise hang the caller forever.
async function fetchJSONTimeout(url, ms = 3500) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return { ok: r.ok, status: r.status, json: r.ok ? await r.json() : null };
  } finally { clearTimeout(id); }
}

// Klipper machine health, normalized once for every Klipper-family connector.
//
// Klippy's `webhooks` object says whether the MACHINE is alive; print_stats
// says what the JOB was doing. Those are independent, and when Klipper shuts
// down mid-print the job fields simply freeze at plausible-looking values --
// confirmed live on a SPARKX i7 sitting in webhooks.state "shutdown" with a
// real state_message while SnapCon showed it idle. Health therefore wins
// absolutely: a fault here overrides state, however convincing print_stats,
// virtual_sdcard, filename or progress still look.
//
// Returns null when there is no fault, so a caller can simply skip the
// override. 'ready' MUST return null even though state_message is populated
// ("Printer is ready" on all 18 machines here) -- p.message is the flag the
// fleet card uses to suppress its progress/thumbnail/lanes block, so leaking
// it on a healthy printer would blank the whole fleet.
//
// 'startup' is deliberately not a fault: Moonraker refuses object queries
// while Klippy is not ready, so that case already resolves through the
// caller's own !ok -> online:false path. An unrecognised future value is left
// alone rather than guessed at.
//
// Distinct from Klippy being DISCONNECTED (process gone): that fails the query
// outright and is correctly reported as offline. Do not merge the two.
function klipperFault(st) {
  const w = st && st.webhooks;
  if (!w || typeof w !== "object") return null;
  if (w.state !== "shutdown" && w.state !== "error") return null;
  return {
    state: "error",
    errorCode: w.state === "shutdown" ? "KLIPPER_SHUTDOWN" : "KLIPPER_ERROR",
    message: String(w.state_message || "").trim()
  };
}

// POST to a printer's Moonraker endpoint. Throws a user-showable error on
// network failure, timeout, or a non-2xx response.
// `ms` defaults to a short bound suitable for a POST-and-forget gcode
// command (pause/resume/cancel/estop/bed-temp/start-print/exclude-object/
// filament-color) — see CODE_AUDIT.md P1-2: this used to be a bare fetch()
// with no timeout at all, able to hang the single most safety-critical
// action (E-Stop) indefinitely against a wedged printer. Some Moonraker
// macros are NOT fire-and-forget, though — `/printer/gcode/script` blocks
// until the macro fully finishes (confirmed live for G29, see
// creality-klipper.js), so a genuinely long-running physical macro must
// pass an explicit, generous `ms` rather than inherit this default.
async function moonrakerPost(p, apiPath, ms = 8000) {
  let r;
  try { r = await fetchTimeout(baseUrl(p) + apiPath, ms, { method: "POST" }); }
  catch (e) {
    if (e.name === "AbortError") throw new Error(p.name + " did not respond within " + ms + "ms");
    throw new Error("Could not reach " + p.name + ": " + e.message);
  }
  if (!r.ok) throw new Error("Moonraker " + r.status + ": " + (await r.text()).slice(0, 160));
}
const sendGcode = (p, script, ms) => moonrakerPost(p, "/printer/gcode/script?script=" + encodeURIComponent(script), ms);

// ---- Sending a file (docs/TODO.md §37 P1) ----
// Every upload ends, with one of three outcomes the caller can act on:
//   resolved             the printer answered and accepted the file;
//   e.outcome "failed"   the transfer did not complete: nothing connected, it
//                        was cut before the last byte (a body shorter than its
//                        Content-Length, which the printer discards), the
//                        printer refused it, or the local file could not be
//                        read. That is all it says: it is not evidence about
//                        what the printer holds;
//   e.outcome "unknown"  every byte was handed over and no definite answer came
//                        back (no reply in time, the connection dropped after
//                        the last byte, a reply that could not be read). The
//                        file may or may not be on the printer.
// Three deadlines, each over one stretch of the transfer, overridable per
// upload through job.timeouts (the server fills it from config.json's
// uploadTimeouts):
//   connectMs     request created → connection open (name lookup included);
//   inactivityMs  restarted each time a chunk is handed to the OS: a printer
//                 that stops taking data. Not a limit on the whole transfer,
//                 so a slow but steady one never trips it;
//   confirmMs     last byte handed to the OS → the printer's complete reply.
//                 It also covers the bytes still in the OS buffers on their
//                 way to the printer, which on a slow link is a good share.
const UPLOAD_TIMEOUTS = Object.freeze({ connectMs: 10000, inactivityMs: 60000, confirmMs: 120000 });
const uploadTimeoutsFor = job => ({ ...UPLOAD_TIMEOUTS, ...((job && job.timeouts) || {}) });
const secs = ms => Math.round(ms / 1000);
function uploadError(message, code, outcome, extra) {
  return Object.assign(new Error(message), { code, outcome, ...(extra || {}) });
}

// Streams a file as multipart/form-data, reporting the bytes handed to the OS
// so the UI can show real progress. `judge(statusCode, body)` reads the
// printer's answer: it returns for an accepted file and throws (an error with
// its own code and outcome) otherwise. Shared by the Moonraker upload below and
// FlashForge's native one, which differ only in the address, headers, field
// name and how the answer reads.
//
// Cancel (POST /api/print-cancel calls job.cancelUpload) while bytes are going
// out cuts the body short: a broken upload, never a complete-looking file.
// After the last byte nothing is cut: the file may already be complete on the
// printer. Cancel then only sets job.cancelRequested, so the caller starts
// nothing, and this keeps waiting for the printer's answer until the
// confirmation deadline, which is the real outcome reported.
//
// Each upload has its own connection (agent: false): no idle keep-alive socket
// the printer may already have closed, and the connect deadline means one thing.
async function sendMultipartUpload({ url, headers, field, name, fp, job, judge }) {
  const fileSize = (await netfs.stat(fp)).size;
  const T = uploadTimeoutsFor(job);
  return new Promise((resolve, reject) => {
    const boundary = "----snapcon" + Math.random().toString(16).slice(2);
    const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    job.total = pre.length + fileSize + post.length;
    job.sent = 0;
    let settled = false, lastByte = false, timer = null;
    const u = new URL(url);
    const req = http.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST", agent: false,
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": job.total, ...headers }
    });
    const fileStream = netfs.createReadStream(fp);
    // Settles once, whichever comes first: the answer, a deadline, a cancel, an
    // error. Everything that could still fire afterwards is a no-op.
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      job.cancelUpload = null;
      if (err) { fileStream.destroy(); req.destroy(); reject(err); }
      else resolve(value);
    };
    const arm = (ms, makeError) => { clearTimeout(timer); timer = setTimeout(() => finish(makeError()), ms); };
    // A connection lost before the last byte is a failed transfer; after it,
    // the printer may have the whole file.
    const lost = e => lastByte
      ? uploadError(`All ${job.total} bytes were sent, but the connection to the printer was lost before it confirmed the upload${e && e.message ? " (" + e.message + ")" : ""}`, "UPLOAD_UNCONFIRMED", "unknown", { reason: "connection-lost" })
      : Object.assign(e || new Error("Connection to the printer lost"), { outcome: "failed" });
    const stalled = () => uploadError(`The printer stopped accepting data for ${secs(T.inactivityMs)} s`, "UPLOAD_STALLED", "failed", { abortedMidBody: true, seconds: secs(T.inactivityMs) });

    arm(T.connectMs, () => uploadError(`Could not connect to the printer within ${secs(T.connectMs)} s`, "UPLOAD_CONNECT_TIMEOUT", "failed", { seconds: secs(T.connectMs) }));
    req.on("error", e => finish(lost(e)));
    req.on("response", res => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", d => { if (b.length < 65536) b += d; });
      res.on("end", () => {
        try { judge(res.statusCode, b); }
        catch (e) { return finish(e); }
        // Accepted before the whole body had gone: not an answer about this file.
        if (!lastByte) return finish(uploadError("The printer answered before it had received the whole file", "UPLOAD_UNCONFIRMED", "unknown", { reason: "unreadable-reply" }));
        finish(null, b);
      });
      res.on("error", e => finish(lost(e)));
      res.on("close", () => { if (!res.complete) finish(lost(new Error("the printer's answer was cut off"))); });
    });
    // A local read that fails mid-upload (the NAS went away) aborts the
    // request: the printer must see a broken upload, never a complete one with
    // the tail missing.
    fileStream.on("error", e => finish(Object.assign(e, { outcome: "failed" })));
    job.cancelUpload = () => {
      job.cancelRequested = true;
      finish(uploadError("Upload cancelled", "UPLOAD_CANCELLED", "failed", { abortedMidBody: true }));
    };
    const send = () => {
      if (settled) return;
      const sent = n => err => {
        if (err || settled) return;
        job.sent += n;
        if (!lastByte) arm(T.inactivityMs, stalled);
      };
      arm(T.inactivityMs, stalled);
      req.write(pre, sent(pre.length));
      fileStream.on("data", chunk => {
        if (!req.write(chunk, sent(chunk.length))) { fileStream.pause(); req.once("drain", () => fileStream.resume()); }
      });
      fileStream.on("end", () => { if (!settled) req.end(post, sent(post.length)); });
    };
    req.on("socket", s => { if (s.connecting) s.once("connect", send); else send(); });
    // The last byte is with the OS: from here the printer may hold the file.
    req.on("finish", () => {
      if (settled) return;
      lastByte = true;
      job.sent = job.total;
      job.confirmingSince = Date.now();
      job.cancelUpload = () => { job.cancelRequested = true; job.cancelUpload = null; };
      arm(T.confirmMs, () => uploadError(`All ${job.total} bytes were sent, but the printer did not confirm the upload within ${secs(T.confirmMs)} s`, "UPLOAD_UNCONFIRMED", "unknown", { reason: "timeout", seconds: secs(T.confirmMs) }));
    });
  });
}

// Moonraker: any 2xx accepts the file.
async function uploadWithProgress(base, fp, name, job) {
  return sendMultipartUpload({
    url: base + "/server/files/upload", headers: {}, field: "file", name, fp, job,
    // UPLOAD_REJECTED: the printer answered and refused the file (as opposed
    // to a connection that failed), so the browser can say so.
    judge: (status, body) => {
      if (status >= 300) throw uploadError("Upload " + status + ": " + body.slice(0, 160), "UPLOAD_REJECTED", "failed");
    },
  });
}
const uploadFile = (p, fp, name, job) => uploadWithProgress(baseUrl(p), fp, name, job);

// ---- Print control: standard Klipper macros, identical across every
// Moonraker-based connector ----
const pause = p => sendGcode(p, "PAUSE");
const resume = p => sendGcode(p, "RESUME");
const cancel = p => sendGcode(p, "CANCEL_PRINT");
const eject = p => sendGcode(p, "SDCARD_RESET_FILE");
const estop = p => moonrakerPost(p, "/printer/emergency_stop");
const bedTemp = (p, t) => sendGcode(p, "M140 S" + Math.round(t));

// A value interpolated into a literal `script` line must never contain a
// quote or a line break: Moonraker executes a multi-line `script` value one
// gcode/macro command per line, so an embedded CR/LF turns one intended
// command into two attacker-chosen ones. This is the shared sink for every
// Klipper-family connector (klipper-moonraker, creality-klipper,
// snapmaker-u1-klipper all re-export startPrintFile/excludeObject
// unchanged), so it enforces this itself rather than trusting every caller
// upstream (server.js's /api/print, /api/printfile, /api/exclude, and the
// --load/--snapcon CLI/notify-load path) to have validated first.
function assertSafeGcodeArg(value) {
  if (/["\r\n]/.test(String(value))) throw new Error("Invalid characters in gcode argument");
  return value;
}
const startPrintFile = (p, filename) => sendGcode(p, `SDCARD_PRINT_FILE FILENAME="${assertSafeGcodeArg(filename)}"`);

// ---- Exclude-object: live plate map + skip a single object mid-print
// (stock Klipper's exclude_object module) ----
async function getPlate(p) {
  const { ok, status, json } = await fetchJSONTimeout(baseUrl(p) + "/printer/objects/query?exclude_object", 3500);
  if (!ok) throw new Error("Moonraker " + status);
  const eo = ((json.result || {}).status || {}).exclude_object || {};
  return {
    objects: (eo.objects || []).map(o => ({ name: o.name, center: o.center, polygon: o.polygon })),
    current: eo.current_object || null,
    excluded: eo.excluded_objects || []
  };
}
async function excludeObject(p, name) {
  await sendGcode(p, `EXCLUDE_OBJECT NAME=${assertSafeGcodeArg(name)}`);
}

// ---- File management on the printer (stock Moonraker) ----
async function listFiles(p) {
  const { ok, status, json } = await fetchJSONTimeout(baseUrl(p) + "/server/files/list?root=gcodes", 8000);
  if (!ok) throw new Error("Moonraker " + status);
  return (json.result || [])
    .map(f => ({ path: f.path, size: f.size, modified: f.modified }))
    .sort((a, b) => b.modified - a.modified);
}
// ---- "Does the printer already have this exact file?" ----
// Moonraker publishes no checksum for gcode files (verified against a live U1:
// its metadata carries size/modified/uuid/job_id and slicer fields, nothing
// hash-like), and downloading a copy to hash would cost more than the upload
// it is meant to save — the largest job in the reference fleet is 182MB.
//
// So identity is established from exact byte size plus three 64KB windows read
// over HTTP Range and compared against the local file. Verified end to end on
// real hardware against a genuine duplicate: all three windows matched and
// 196608 bytes moved, 3% of that file.
//
// This is a strong indicator, NOT proof: a false positive would need two
// different sliced files of identical length that also agree at head, middle
// and tail. Every uncertain answer therefore fails CLOSED — `identical` is
// only ever true when all of it was actually checked, so anything unverifiable
// simply gets uploaded as before.
const IDENTITY_WINDOW = 64 * 1024;
const baseNameOf = s => String(s).replace(/\\/g, "/").split("/").pop();

// opts.rangeTimeoutMs: the deadline for each ranged read, headers and body
// together (10 s; tests shorten it).
async function compareRemoteFile(p, name, localPath, { rangeTimeoutMs = 10000 } = {}) {
  // Throws if the local file is gone — a caller must not read that as a match.
  const localSize = (await netfs.stat(localPath)).size;

  const wanted = baseNameOf(name);
  // The printer's copy may sit in a subfolder while uploads land at the root,
  // so the listing is matched on basename.
  const remote = (await listFiles(p)).find(f => baseNameOf(f.path) === wanted);
  if (!remote) return { present: false, sameSize: false, identical: false, localSize, remoteSize: null };
  if (remote.size !== localSize) {
    // Disproof is free: differing lengths settle it with no content read.
    return { present: true, sameSize: false, identical: false, localSize, remoteSize: remote.size };
  }

  const same = await compareWindows(p, remote.path, localPath, localSize, rangeTimeoutMs);
  if (same === "unverifiable") return { present: true, sameSize: true, identical: false, localSize, remoteSize: remote.size, unverified: true };
  if (same === "different") return { present: true, sameSize: true, identical: false, localSize, remoteSize: remote.size };
  return { present: true, sameSize: true, identical: true, localSize, remoteSize: remote.size };
}

// Head, middle and tail of the printer's copy at `remotePath` (relative to the
// gcodes root) against the local file of the same length: "same" when every
// window matched, "different" when one did not, "unverifiable" when one could
// not be read in time or the printer did not honour the range.
async function compareWindows(p, remotePath, localPath, localSize, rangeTimeoutMs) {
  const url = baseUrl(p) + "/server/files/gcodes/" + String(remotePath).split("/").map(encodeURIComponent).join("/");
  // Head, middle and tail: a re-slice that changed only infill differs in the
  // middle, and one that changed only end-gcode differs at the tail.
  const win = Math.min(IDENTITY_WINDOW, localSize);
  const starts = [...new Set([0, Math.max(0, Math.floor(localSize / 2) - Math.floor(win / 2)), Math.max(0, localSize - win)])];

  for (const start of starts) {
    const len = Math.min(win, localSize - start);
    if (len <= 0) continue;
    // One deadline over the whole read: a window that does not arrive in time
    // leaves the copy unverified.
    let res;
    try { res = await fetchBufferTimeout(url, rangeTimeoutMs, { headers: { Range: `bytes=${start}-${start + len - 1}` } }); }
    catch { return "unverifiable"; }
    // 206 is the only answer that proves the range was honoured; a 200 would
    // be the whole file and must not be compared against one window.
    if (!res.ok || res.status !== 206) return "unverifiable";
    const remoteChunk = res.buffer;
    const localChunk = await netfs.read(localPath, start, len);
    if (remoteChunk.length !== len || !remoteChunk.equals(localChunk)) return "different";
  }
  return "same";
}

// Whether this Moonraker rewrites uploaded files (object processing). Anything
// that cannot be read says no: a mismatch then stays a mismatch.
async function rewritesUploads(p, ms) {
  try {
    const { ok, json } = await fetchJSONTimeout(baseUrl(p) + "/server/config", ms);
    const fm = ok && json && json.result && json.result.config && json.result.config.file_manager;
    return !!(fm && fm.enable_object_processing === true);
  } catch { return false; }
}

// ---- "Is the file we just sent on the printer?" (docs/TODO.md §37 P2) ----
// Read back after an upload, before anything may start it. Unlike
// compareRemoteFile, which looks anywhere for a copy worth not sending again,
// this asks about the one file a print start will use: `name` at the gcodes
// root, where every upload lands. The root's directory listing, not
// /server/files/list, so a same-named file in a subfolder cannot answer for it.
//   verified      at that path, the local size, and head, middle and tail match;
//   acknowledged  at that path and the local size; the content could not be
//                 read back (no range support, a read that ran out of time);
//   mismatch      at that path with another size or other content: proof the
//                 printer holds something else under that name;
//   absent        the listing answered and the file is not in it, after a few
//                 tries (a listing can lag an upload by a moment);
//   unverifiable  the listing could not be read.
// Every answer says what it rests on (basis): "content" (the windows were
// compared), "size" (listed at the expected size) or "name" (listed only).
// With no localPath (a Loaded file checked later, §37 P5: the local copy may
// have moved or changed since) opts.localSize is what the printer's copy is
// held to, and the content is not read; with neither, only the name.
// opts (tests shorten them): attempts, retryMs, listTimeoutMs, rangeTimeoutMs, localSize.
async function verifyUpload(p, name, localPath, { attempts = 3, retryMs = 1500, listTimeoutMs = 8000, rangeTimeoutMs = 10000, localSize: knownSize = null } = {}) {
  let localSize = Number.isFinite(knownSize) ? knownSize : null;
  if (localPath) {
    try { localSize = (await netfs.stat(localPath)).size; }
    catch (e) { return { result: "unverifiable", evidence: "the local file could not be read: " + e.message }; }
  }
  let listed = false, remote = null, lastError = null;
  for (let i = 0; i < attempts && !remote; i++) {
    if (i) await new Promise(r => setTimeout(r, retryMs));
    try {
      const { ok, status, json } = await fetchJSONTimeout(baseUrl(p) + "/server/files/directory?path=gcodes&extended=false", listTimeoutMs);
      if (!ok) { lastError = "Moonraker " + status; continue; }
      const files = json && json.result && json.result.files;
      if (!Array.isArray(files)) { lastError = "the printer's answer is not a file listing"; continue; }
      listed = true;
      remote = files.find(f => f && f.filename === name) || null;
    } catch (e) { lastError = e.message; }
  }
  if (!remote) {
    return listed
      ? { result: "absent", evidence: `${name} is not in the printer's file list` }
      : { result: "unverifiable", evidence: "the printer's file list could not be read" + (lastError ? ": " + lastError : "") };
  }
  if (localSize == null) return { result: "acknowledged", basis: "name", evidence: `${name} is in the printer's file list` };
  if (!Number.isFinite(remote.size)) return { result: "unverifiable", evidence: `the printer lists ${name} without a size` };
  if (!localPath) {
    if (remote.size === localSize) return { result: "acknowledged", basis: "size", evidence: `${name} is on the printer at ${localSize} bytes` };
    if (await rewritesUploads(p, listTimeoutMs)) return { result: "acknowledged", basis: "name", evidence: `${name} is on the printer; it rewrites uploads (object processing), so its size cannot be compared` };
    return { result: "mismatch", basis: "size", evidence: `the printer's ${name} is ${remote.size} bytes, ${localSize} were sent` };
  }
  const same = remote.size === localSize ? await compareWindows(p, name, localPath, localSize, rangeTimeoutMs) : "different";
  const differs = remote.size !== localSize ? `the printer's ${name} is ${remote.size} bytes, the file sent is ${localSize}`
    : same === "different" ? `the printer's ${name} has other content than the file sent` : null;
  if (differs) {
    // A printer whose Moonraker rewrites every upload ([file_manager]
    // enable_object_processing) holds a changed copy by design. Not seen on
    // the reference fleet (all off, 2026-10-27), but a setting a user can turn on.
    if (await rewritesUploads(p, listTimeoutMs)) return { result: "acknowledged", basis: "name", evidence: `${name} is on the printer; it rewrites uploads (object processing), so its copy cannot be compared` };
    return { result: "mismatch", basis: remote.size !== localSize ? "size" : "content", evidence: differs };
  }
  if (same === "unverifiable") return { result: "acknowledged", basis: "size", evidence: `${name} is on the printer at ${localSize} bytes; its content could not be read back` };
  return { result: "verified", basis: "content", evidence: `${name} is on the printer at ${localSize} bytes, and its head, middle and end match` };
}

// `file` is the real filename as reported by the printer (with its actual
// extension) — Moonraker's thumbnail cache is keyed by the extension-less
// stem instead ("<stem>-300x300.png"), so that stripping happens here,
// internally, rather than the caller pre-computing a Moonraker-specific stem
// that a different connector (e.g. FlashForge, which wants the exact
// filename) would misinterpret.
// Moonraker's own metadata is the only reliable way to locate a preview. This
// used to guess "gcodes/.thumbs/<stem>-300x300.png", which is a slicer
// convention rather than an API — and one that only some slicers follow. Read
// live off two printers holding thumbnails in the same .thumbs/ directory:
//
//   U1 Navy    96x96, 48x48, 300x300     -> the guess happened to hit
//   AD5X Blue  32x32, 64x64, 140x110     -> no 300x300 at all, so it 404'd
//
// The U1 worked by coincidence of what its slicer emits, and every printer
// configured for other sizes silently lost its previews. /server/files/metadata
// reports what is actually there, and is documented rather than inferred.
async function getThumbnail(p, file) {
  const base = baseUrl(p);
  const meta = await fetchJSONTimeout(base + "/server/files/metadata?filename=" + encodeURIComponent(file), 5000);
  if (!meta.ok) { const e = new Error("Moonraker " + meta.status); e.status = meta.status; throw e; }
  const thumbs = (((meta.json || {}).result || {}).thumbnails) || [];
  // No preview is a legitimate answer for a plain gcode file, not a fault —
  // the route turns this into a 404 and the card simply shows nothing.
  if (!thumbs.length) { const e = new Error("No preview stored for " + file); e.status = 404; throw e; }

  // Largest available: the array's order carries no meaning (300x300 is last
  // on the U1, 140x110 is second on the AD5X), and the card scales down.
  const area = t => (Number(t.width) || 0) * (Number(t.height) || 0);
  const best = thumbs.reduce((a, b) => (area(b) > area(a) ? b : a));

  // relative_path is relative to the GCODE FILE's own directory, so a file in
  // a subfolder has its .thumbs/ beside it, not at the gcodes root.
  const name = String(file);
  const dir = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "";
  const rel = dir + String(best.relative_path || "");
  // Encode per segment: these names routinely contain spaces and brackets,
  // and the separators have to survive.
  const url = base + "/server/files/gcodes/" + rel.split("/").map(encodeURIComponent).join("/");

  const r = await fetchTimeout(url, 5000);
  if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  return { contentType: r.headers.get("content-type") || "image/png", buffer: Buffer.from(await r.arrayBuffer()) };
}

// ---- File sync (Logs/Camera Folder → SnapCon host) ----
// Plain, unmodified Moonraker file-management endpoints (confirmed against
// Moonraker's own web_api.md, not U1-specific) — generic across every
// Klipper-family connector, so these live here rather than per-connector.
// `list` recurses (unlike the Storage card's own top-level-only
// /server/files/directory calls) — a relative path can include subdirs.
// What connectors export as querySyncFiles / downloadSyncFile /
// deleteSyncFile. Like every other connector call they take the PRINTER, not a
// URL: a connector may first re-point it (the FlashForge connectors aim it at
// Moonraker's port), which a URL string handed in from outside would bypass.
const querySyncFiles = (p, root) => queryRemoteFileList(baseUrl(p), root);
const downloadSyncFile = (p, root, relPath, destPath, expectedSize) => downloadRemoteFile(baseUrl(p), root, relPath, destPath, expectedSize);
const deleteSyncFile = (p, root, relPath) => deleteRemoteFile(baseUrl(p), root, relPath);
// Deleting a G-code file from the printer's own storage (the printer-files
// dialog). `relPath` is the path as listFiles() reports it.
const deleteFile = (p, relPath) => deleteRemoteFile(baseUrl(p), "gcodes", relPath);

async function queryRemoteFileList(base, root) {
  const { ok, status, json } = await fetchJSONTimeout(base + "/server/files/list?root=" + encodeURIComponent(root), 8000);
  if (!ok) throw new Error("Moonraker " + status);
  return json.result || [];
}
function encodeRemotePath(relPath) {
  return String(relPath).split("/").map(encodeURIComponent).join("/");
}
// Streams to a `.part` file, tracks bytes received, validates against both
// the HTTP Content-Length and the size the file-listing reported (when
// known) before the atomic rename — a partial/corrupt transfer never
// replaces a good file, and never gets left behind under the final name.
// The timeout is an IDLE timeout (reset on every chunk), not a total-time
// cap — a large-but-healthy transfer over a slow LAN link shouldn't be
// killed just for taking a while.
async function downloadRemoteFile(base, root, relPath, destPath, expectedSize, idleTimeoutMs = 30000) {
  const url = base + "/server/files/" + encodeURIComponent(root) + "/" + encodeRemotePath(relPath);
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), idleTimeoutMs);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), idleTimeoutMs); };
  const tmp = destPath + ".part";
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    bump();
    if (!res.ok) throw new Error("HTTP " + res.status);
    const contentLength = Number(res.headers.get("content-length")) || 0;
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.rm(tmp, { force: true });
    const out = fs.createWriteStream(tmp);
    let received = 0;
    await new Promise((resolve, reject) => {
      const nodeStream = Readable.fromWeb(res.body);
      nodeStream.on("data", chunk => { received += chunk.length; bump(); });
      nodeStream.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      nodeStream.pipe(out);
    });
    if (expectedSize && received !== expectedSize) throw new Error(`Incomplete download: expected ${expectedSize} bytes, received ${received}`);
    if (contentLength && received !== contentLength) throw new Error(`Incomplete download: expected ${contentLength} bytes, received ${received}`);
    await fs.promises.rename(tmp, destPath);
    return { size: received };
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
// The set of gcode filenames that appear in at least one print job since
// `sinceSec` (a UNIX timestamp) — confirmed live that Moonraker's history
// `filename` field is the exact same string as the file listing's `path`
// (both plain root-relative paths), so this set can be checked directly
// against fetchStorageSection's gcodes.fileNames with no translation.
// Moonraker filters server-side via `since=`, so this stays cheap regardless
// of how far back the printer's full history goes — confirmed live against
// a printer with 233 total historical jobs, a 7-day window only returned 5.
async function queryRecentlyPrintedFiles(base, sinceSec) {
  const { ok, status, json } = await fetchJSONTimeout(base + "/server/history/list?since=" + sinceSec + "&limit=500&order=desc", 8000);
  if (!ok) throw new Error("Moonraker " + status);
  const jobs = (json.result || {}).jobs || [];
  return new Set(jobs.map(j => j.filename));
}
// One page of the printer's job history (fleet utilization, Phase 2). Read
// only: a single GET, bounded by a timeout. `since`/`before` are UNIX seconds
// on the PRINTER's clock; `start` is Moonraker's offset for paging. Not every
// Moonraker build honours every parameter (the Virtual U1 answers with the
// newest `limit` jobs whatever was asked), so callers filter and de-duplicate
// themselves. Returns { count, jobs } exactly as the printer sent them; a
// printer without the history component answers 404, reported as
// { unavailable: true }.
async function fetchJobHistory(p, { since = null, before = null, start = 0, limit = 50, order = "asc", timeoutMs = 8000 } = {}) {
  const q = new URLSearchParams({ limit: String(Math.max(1, Math.min(100, limit | 0))), start: String(Math.max(0, start | 0)), order: order === "desc" ? "desc" : "asc" });
  if (Number.isFinite(since)) q.set("since", String(since));
  if (Number.isFinite(before)) q.set("before", String(before));
  const { ok, status, json } = await fetchJSONTimeout(baseUrl(p) + "/server/history/list?" + q, timeoutMs);
  if (status === 404) return { unavailable: true, count: 0, jobs: [] };
  if (!ok) throw new Error("Moonraker " + status);
  const result = (json && json.result) || {};
  return { count: Number.isFinite(result.count) ? result.count : null, jobs: Array.isArray(result.jobs) ? result.jobs : [] };
}
async function deleteRemoteFile(base, root, relPath) {
  const res = await fetchTimeout(base + "/server/files/" + encodeURIComponent(root) + "/" + encodeRemotePath(relPath), 8000, { method: "DELETE" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return true;
}

// Fallback slicer-comment parsing for gcode Moonraker's own scanner didn't
// recognize at all (slicer:"Unknown", no estimated_time/filament_colour) —
// confirmed live against real Creality-Print-sliced files, which come in (at
// least) two comment dialects depending on slicer version, neither of which
// Moonraker's built-in scanner picked up on these real files:
//  - Cura-derived (older Creality Print, "FLAVOR:Creality OS"): plain header
//    tags positioned right before the actual gcode starts —
//    `;TIME:<seconds>`, `;Filament Weight:<grams>`.
//  - OrcaSlicer/BambuStudio-derived (newer Creality Print): a stats block at
//    the very end of the file, just before the alphabetical CONFIG_BLOCK
//    settings dump — `; estimated printing time (normal mode) = 9h 42m 19s`,
//    `; total filament used [g] = 236.85`.
function parseFallbackStats(text) {
  let estimatedTime = null, filamentG = null;
  const curaTime = /^;TIME:([\d.]+)/m.exec(text);
  if (curaTime) estimatedTime = parseFloat(curaTime[1]);
  if (estimatedTime == null) {
    const orcaTime = /estimated printing time(?:\s*\([^)]*\))?\s*=\s*((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s)?)/i.exec(text);
    if (orcaTime && orcaTime[1].trim()) {
      const hh = /(\d+)h/.exec(orcaTime[1]), mm = /(\d+)m/.exec(orcaTime[1]), ss = /(\d+)s/.exec(orcaTime[1]);
      estimatedTime = (hh ? +hh[1] * 3600 : 0) + (mm ? +mm[1] * 60 : 0) + (ss ? +ss[1] : 0);
    }
  }
  const curaWeight = /^;Filament Weight:([\d.]+)/m.exec(text);
  if (curaWeight) filamentG = parseFloat(curaWeight[1]);
  if (filamentG == null) {
    const orcaWeight = /total filament used \[g\]\s*=\s*([\d.]+)/i.exec(text) || /filament used \[g\]\s*=\s*([\d.]+)/i.exec(text);
    if (orcaWeight) filamentG = parseFloat(orcaWeight[1]);
  }
  return { estimatedTime, filamentG };
}

// Palette of a file stored on the printer, from Moonraker's slicer metadata,
// plus Full-Spectrum detection off the last 50KB of the gcode (config block
// is at EOF) via the shared gcode-content parser (parser.js — not a connector
// concern, it parses slicer OUTPUT format, not a printer protocol).
async function getFileMetadata(p, file) {
  const { ok, status, json } = await fetchJSONTimeout(baseUrl(p) + "/server/files/metadata?filename=" + encodeURIComponent(file), 8000);
  if (!ok) throw new Error("Moonraker " + status);
  const m = json.result || {};
  const colours = String(m.filament_colour || "").split(";");
  const types = String(m.filament_type || "").split(";");
  const weights = Array.isArray(m.filament_weight) ? m.filament_weight : [];
  const n = Math.max(colours.length, types.length, weights.length);
  const palette = [];
  for (let i = 0; i < n; i++) {
    const hex = normHex(colours[i]);
    const type = (types[i] || "").trim();
    const wt = weights[i];
    palette.push({
      i, hex, type,
      wt: wt != null ? String(wt) : "",
      used: (typeof wt === "number") ? wt > 0 : !!(hex || type)
    });
  }
  let isFS = false, fsFork = null, tailText = "", tailPalette = null;
  const encodedPath = file.split("/").map(encodeURIComponent).join("/");
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await fetch(baseUrl(p) + "/server/files/gcodes/" + encodedPath,
        { signal: ctrl.signal, headers: { Range: "bytes=-51200" } });
      if (r.ok || r.status === 206) {
        tailText = await r.text();
        const fsResult = parseGcodeMap(tailText, { scanBody: false });
        isFS = fsResult.isFS; fsFork = fsResult.fsFork;
        tailPalette = fsResult.palette;
      }
    } finally { clearTimeout(tid); }
  } catch {}

  let estimatedTime = m.estimated_time || null;
  // Some Moonraker builds return a metadata record with no filament data at
  // all -- confirmed live on a Creality SPARKX i7, whose entire record was
  // {filename, first_layer_height, gcode_*_byte, job_id, modified,
  // object_height, print_start_time, size, slicer, uuid} for a genuinely
  // 4-colour file. That left the palette empty and the colour picker showed a
  // single unnamed slot, so the file's colours could not be assigned to lanes.
  //
  // The tail fetched just above already contains the slicer config block, and
  // parseGcodeMap already builds a full palette from it -- previously only
  // isFS/fsFork were taken and that palette was discarded. Reusing it costs no
  // extra request. Only ever a fallback: a printer that reports its own
  // palette keeps it, since the printer is authoritative about its own file.
  if (!palette.some(s => s.used) && tailPalette && tailPalette.some(s => s.used)) {
    palette.splice(0, palette.length, ...tailPalette);
  }
  const havePalette = palette.some(s => s.used);
  if (!estimatedTime || !havePalette) {
    let fb = parseFallbackStats(tailText); // OrcaSlicer/BambuStudio dialect — already have the bytes, no extra request
    if (fb.estimatedTime == null && fb.filamentG == null && typeof m.gcode_start_byte === "number" && m.gcode_start_byte > 0) {
      // Tail dialect found nothing — try the Cura dialect's header window instead,
      // a small Range request just before where the real gcode begins.
      try {
        const start = Math.max(0, m.gcode_start_byte - 16384);
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 8000);
        try {
          const r = await fetch(baseUrl(p) + "/server/files/gcodes/" + encodedPath,
            { signal: ctrl.signal, headers: { Range: `bytes=${start}-${m.gcode_start_byte}` } });
          if (r.ok || r.status === 206) fb = parseFallbackStats(await r.text());
        } finally { clearTimeout(tid); }
      } catch {}
    }
    if (!estimatedTime && fb.estimatedTime != null) estimatedTime = fb.estimatedTime;
    // Replaces (never appends to) an all-unused palette — that placeholder
    // entry exists only so an empty file still has a "which slot feeds this
    // print" row elsewhere in the UI; leaving it in place alongside a real
    // fallback entry would just be a second, redundant blank row.
    if (!havePalette && fb.filamentG != null) palette.splice(0, palette.length, { i: 0, hex: null, type: "", wt: String(fb.filamentG), used: true });
  }
  return { palette, estimatedTime, isFS, fsFork };
}

// ---- Firmware inventory (same Moonraker APIs fluidd reads — no brand-
// specific assumptions: every field is optional-chained/defaulted) ----
// `st` is an already-resolved probe() result (the caller already has one from
// probeCached — no reason to probe twice).
async function queryFirmwareInfo(p, st) {
  if (!st.online) return { name: p.name, online: false, skipped: true, reason: st.error || "offline", reasonCode: "offline", detail: st.error || "" };
  // "maintenance" is a SnapCon-side flag, not a printer state: the machine is
  // reachable and idle, deliberately taken out of production. That makes it a
  // sensible printer to read firmware from and — see the deploy route — to
  // update. The states that genuinely block are the ones where it is moving.
  if (!["standby", "complete", "cancelled", "maintenance"].includes(st.state)) {
    return { name: p.name, online: true, skipped: true, reason: "busy (" + st.state + ")", reasonCode: "busy", state: st.state };
  }
  const base = baseUrl(p);
  try {
    const [pi, si, ol] = await Promise.all([
      fetchJSONTimeout(base + "/printer/info", 5000),
      fetchJSONTimeout(base + "/machine/system_info", 5000),
      fetchJSONTimeout(base + "/printer/objects/list", 5000)
    ]);
    const info = pi.ok ? (pi.json.result || {}) : {};
    const sys  = si.ok ? ((si.json.result || {}).system_info || {}) : {};
    const prod = sys.product_info || {};
    const dist = sys.distribution || {};

    // Every MCU the printer exposes: "mcu" is the mainboard, "mcu e0".."e3"
    // are per-toolhead MCUs on boards that have them (e.g. Snapmaker U1) —
    // this stays generic since it only reacts to whatever MCU names are
    // actually present, never assumes a fixed count.
    let mcus = [];
    const mcuNames = ol.ok ? ((ol.json.result || {}).objects || []).filter(o => /^mcu(\s|$)/.test(o)) : [];
    if (mcuNames.length) {
      const q = await fetchJSONTimeout(base + "/printer/objects/query?" + mcuNames.map(encodeURIComponent).join("&"), 5000);
      const stq = q.ok ? (((q.json.result || {}).status) || {}) : {};
      mcus = mcuNames.map(n => ({
        name: n === "mcu" ? "mainboard" : "toolhead " + n.replace(/^mcu\s*/, ""),
        version: (stq[n] || {}).mcu_version || null
      }));
    }

    return {
      name: p.name, online: true, skipped: false,
      machine: prod.machine_type || null,
      firmware: prod.firmware_version || null,
      software: prod.software_version || null,
      klipper: info.software_version || null,
      os: [dist.name, dist.kernel_version ? "kernel " + dist.kernel_version : ""].filter(Boolean).join(" · ") || null,
      mcus
    };
  } catch (e) {
    return { name: p.name, online: true, skipped: true, reason: e.message };
  }
}

// ---- Health diagnostics: raw Moonraker/Klipper values only — no derived
// scores, no synthetic "health %"/"load %"/"drift %". Six independent
// sections, each wrapped so one section's failure/timeout never takes the
// others down with it (a slow /server/files/directory must not blank out
// MCU stats). `st` is an already-resolved probe() result, same convention
// as queryFirmwareInfo above — no reason to probe twice. Unlike
// queryFirmwareInfo (which only runs when the printer is idle), this only
// requires `st.online`: MCU retransmits/throttle state matter most while a
// print is actually running. ----
async function healthSection(promise) {
  try { return { available: true, ...(await promise) }; }
  catch (e) { return { available: false, reason: e.message }; }
}
async function fetchSystemSection(base) {
  const { ok, status, json } = await fetchJSONTimeout(base + "/machine/proc_stats", 5000);
  if (!ok) throw new Error("Moonraker " + status);
  const r = json.result || {};
  return {
    throttledState: r.throttled_state ?? null,
    cpuTemp: typeof r.cpu_temp === "number" ? r.cpu_temp : null,
    cpuUsage: (r.system_cpu_usage && typeof r.system_cpu_usage.cpu === "number") ? r.system_cpu_usage.cpu : null,
    uptimeSec: typeof r.system_uptime === "number" ? r.system_uptime : null,
    memory: r.system_memory || null
  };
}
// Discovers whichever "mcu"/"mcu e0".."e3" objects this printer actually
// reports (same list-then-query approach queryFirmwareInfo already uses)
// and queries only those — a 2-toolhead unit simply returns 3 entries, not
// a fixed 4-entry shape with holes. `available:false` is reserved for the
// query itself failing, never for a printer having fewer MCUs than another.
async function fetchMcuSection(base, mcuNames) {
  if (!mcuNames.length) return { list: [] };
  const { ok, status, json } = await fetchJSONTimeout(base + "/printer/objects/query?" + mcuNames.map(encodeURIComponent).join("&"), 5000);
  if (!ok) throw new Error("Moonraker " + status);
  const stq = (json.result || {}).status || {};
  return {
    list: mcuNames.map(n => {
      const s = stq[n] || {};
      const ls = s.last_stats || {};
      return {
        name: n === "mcu" ? "mainboard" : "toolhead " + n.replace(/^mcu\s*/, ""),
        bytesRetransmit: ls.bytes_retransmit ?? null,
        bytesInvalid: ls.bytes_invalid ?? null,
        // bytesWrite is the denominator for a retransmit RATE (retransmits
        // per bytes actually sent) rather than a bare cumulative total —
        // the total alone means nothing without knowing how much traffic
        // it happened against.
        bytesWrite: ls.bytes_write ?? null,
        srtt: ls.srtt ?? null,
        rttvar: ls.rttvar ?? null,
        freq: ls.freq ?? null,
        mcuTaskAvg: ls.mcu_task_avg ?? null,
        mcuTaskStddev: ls.mcu_task_stddev ?? null
      };
    })
  };
}
async function fetchHeatersSection(base, heaterNames) {
  if (!heaterNames.length) return { list: [] };
  const { ok, status, json } = await fetchJSONTimeout(base + "/printer/objects/query?" + heaterNames.map(encodeURIComponent).join("&"), 5000);
  if (!ok) throw new Error("Moonraker " + status);
  const stq = (json.result || {}).status || {};
  return {
    list: heaterNames.map(n => ({
      name: n,
      temperature: (stq[n] || {}).temperature ?? null,
      target: (stq[n] || {}).target ?? null,
      power: (stq[n] || {}).power ?? null
    }))
  };
}
// Standard `fan`/`heater_fan <name>`/`fan_generic <name>` objects report
// {speed, rpm} — speed is the commanded 0-1 duty, rpm is measured (or
// missing/null on fans with no tachometer wired — confirmed real on a live
// U1: heater_fan power_fan reports rpm:null). `rpm` absent from the
// response entirely is treated the same as an explicit null — both mean
// "not measurable," never "stopped". The U1's `purifier` object is a
// different shape (inner_fan_rpm / exhaust_fan.speed / inner_fan.speed);
// its inner fan is folded into the same list under its own name so callers
// don't need to special-case it.
async function fetchFansSection(base, fanNames, hasPurifier) {
  const queryNames = hasPurifier ? [...fanNames, "purifier"] : fanNames;
  if (!queryNames.length) return { list: [] };
  const { ok, status, json } = await fetchJSONTimeout(base + "/printer/objects/query?" + queryNames.map(encodeURIComponent).join("&"), 5000);
  if (!ok) throw new Error("Moonraker " + status);
  const stq = (json.result || {}).status || {};
  const list = fanNames.map(n => {
    const s = stq[n] || {};
    return { name: n, speed: typeof s.speed === "number" ? s.speed : null, rpm: typeof s.rpm === "number" ? s.rpm : null };
  });
  if (hasPurifier) {
    const s = stq.purifier || {};
    list.push({ name: "purifier inner fan", speed: (s.inner_fan && typeof s.inner_fan.speed === "number") ? s.inner_fan.speed : null, rpm: typeof s.inner_fan_rpm === "number" ? s.inner_fan_rpm : null });
    // Confirmed live (U1 Purple): exhaust_fan.speed can be 1 (fully
    // commanded on) while inner_fan is completely off — these are two
    // independent fans, not one. No rpm field exists for it anywhere in the
    // purifier object (unlike inner_fan_rpm), so it's never measurable.
    list.push({ name: "purifier exhaust fan", speed: (s.exhaust_fan && typeof s.exhaust_fan.speed === "number") ? s.exhaust_fan.speed : null, rpm: null });
  }
  return { list };
}
// disk_usage is filesystem-level and read from ONE root (gcodes, always
// present) — never summed across roots, since gcodes/logs/camera commonly
// share one underlying filesystem and summing their individually-reported
// disk_usage would double/triple-count the same disk. Per-category sizes
// are a separate, shallow (top-level files only, not recursed into
// subdirectories) sum of each root's own listing — a directory's own
// reported `size` is its inode/entry-table size, not a recursive content
// total, so recursing would be needed for a fully accurate category figure;
// out of scope here. "Other" folds in both that gap and any genuinely
// shared-filesystem overlap — the caller renders one tooltip explaining both.
async function fetchStorageSection(base, roots) {
  const catNames = roots.filter(r => ["gcodes", "logs", "camera"].includes(r));
  const dirs = await Promise.all(catNames.map(root =>
    fetchJSONTimeout(base + "/server/files/directory?path=" + encodeURIComponent(root), 8000)
      .then(r => ({ root, ...r }))
  ));
  const gcodesDir = dirs.find(d => d.root === "gcodes");
  if (!gcodesDir || !gcodesDir.ok) throw new Error("Moonraker " + (gcodesDir ? gcodesDir.status : "no gcodes root"));
  const diskUsage = (gcodesDir.json.result || {}).disk_usage || null;
  if (!diskUsage) throw new Error("no disk_usage reported");
  const categories = {};
  for (const d of dirs) {
    if (!d.ok) { categories[d.root] = { bytes: 0, fileCount: 0, available: false }; continue; }
    const files = (d.json.result || {}).files || [];
    categories[d.root] = {
      bytes: files.reduce((sum, f) => sum + (f.size || 0), 0),
      fileCount: files.length,
      available: true,
      // Only gcodes needs individual names — server.js cross-references
      // these against print history to compute an "unused" count, then
      // strips this field before the response reaches the browser (the
      // client only ever needs the final count, not the raw file list).
      // /server/files/directory's file objects use `filename`, NOT `path`
      // (confirmed live — `path` is undefined here; `path` is only what
      // /server/files/list and history's `filename` field use instead).
      ...(d.root === "gcodes" ? { fileNames: files.map(f => f.filename) } : {})
    };
  }
  const knownBytes = Object.values(categories).reduce((sum, c) => sum + (c.bytes || 0), 0);
  const otherBytes = Math.max(0, diskUsage.used - knownBytes);
  return { diskUsage, categories, otherBytes };
}
async function fetchHistorySection(base) {
  const [totalsR, listR] = await Promise.all([
    fetchJSONTimeout(base + "/server/history/totals", 5000),
    fetchJSONTimeout(base + "/server/history/list?limit=20&order=desc", 5000)
  ]);
  if (!totalsR.ok) throw new Error("Moonraker " + totalsR.status);
  const totals = (totalsR.json.result || {}).job_totals || {};
  const jobs = listR.ok ? ((listR.json.result || {}).jobs || []) : [];
  const completed = jobs.filter(j => j.status === "completed").length;
  return {
    totalJobs: totals.total_jobs ?? null,
    totalPrintTime: totals.total_print_time ?? null,
    totalFilamentUsed: totals.total_filament_used ?? null,
    // "Recent" on purpose — a window over the last `sampleSize` jobs, never
    // implied to be a lifetime figure. Caller labels this "Recent Success".
    recent: { completed, sampleSize: jobs.length }
  };
}
async function fetchFaultsSection(base, st) {
  const { ok, status, json } = await fetchJSONTimeout(base + "/printer/objects/query?exception_manager", 5000);
  if (!ok) throw new Error("Moonraker " + status);
  const list = (((json.result || {}).status || {}).exception_manager || {}).exceptions || [];
  // The printer's OWN current error (already decoded onto the probe result
  // by the caller's normal probe() path) is folded in as the most recent
  // entry when present, so an active fault shows up here even if
  // exception_manager's own history hasn't recorded it yet.
  const current = st.errorCode || st.message ? [{ current: true, errorCode: st.errorCode || null, message: st.message || null }] : [];
  return { list: [...current, ...list] };
}
async function queryHealth(p, st) {
  if (!st.online) return { online: false, skipped: true, reason: st.error || "offline" };
  const base = baseUrl(p);
  let objectNames = [];
  try {
    const ol = await fetchJSONTimeout(base + "/printer/objects/list", 5000);
    if (ol.ok) objectNames = (ol.json.result || {}).objects || [];
  } catch { /* MCU/heater sections below degrade to their own unavailable state */ }
  const mcuNames = objectNames.filter(o => /^mcu(\s|$)/.test(o));
  const heaterNames = objectNames.filter(o => /^(extruder\d*|heater_bed)$/.test(o));
  const fanNames = objectNames.filter(o => o === "fan" || /^heater_fan\s/.test(o) || /^fan_generic\s/.test(o));
  const hasPurifier = objectNames.includes("purifier");
  let roots = ["gcodes", "logs", "camera"];
  try {
    const rr = await fetchJSONTimeout(base + "/server/files/roots", 5000);
    if (rr.ok) roots = (rr.json.result || []).map(r => r.name);
  } catch { /* storage section below degrades to its own unavailable state */ }

  const [system, mcus, heaters, fans, storage, history, faults] = await Promise.all([
    healthSection(fetchSystemSection(base)),
    healthSection(fetchMcuSection(base, mcuNames)),
    healthSection(fetchHeatersSection(base, heaterNames)),
    healthSection(fetchFansSection(base, fanNames, hasPurifier)),
    healthSection(fetchStorageSection(base, roots)),
    healthSection(fetchHistorySection(base)),
    healthSection(fetchFaultsSection(base, st))
  ]);
  return { online: true, skipped: false, system, mcus, heaters, fans, storage, history, faults };
}

// ---- Network inventory: name / IP / MAC, for DHCP reservations ----
function pickIface(net) {
  let fallback = null;
  for (const name in net) {
    const ifc = net[name] || {};
    const v4 = (ifc.ip_addresses || []).find(a => a.family === "ipv4" && !a.is_link_local);
    if (v4) return { iface: name, mac: ifc.mac_address || null, ip: v4.address };
    if (!fallback && ifc.mac_address) fallback = { iface: name, mac: ifc.mac_address, ip: null };
  }
  return fallback || { iface: null, mac: null, ip: null };
}

module.exports = {
  baseUrl, websocketUrl, fetchTimeout, fetchJSONTimeout, fetchBufferTimeout, klipperFault, moonrakerPost, sendGcode,
  uploadWithProgress, uploadFile, sendMultipartUpload, uploadError, UPLOAD_TIMEOUTS, uploadTimeoutsFor,
  pause, resume, cancel, eject, estop, bedTemp, startPrintFile,
  getPlate, excludeObject,
  listFiles, getThumbnail, getFileMetadata, compareRemoteFile, verifyUpload, fetchJobHistory,
  queryFirmwareInfo, queryHealth, pickIface,
  queryRemoteFileList, downloadRemoteFile, deleteRemoteFile, queryRecentlyPrintedFiles,
  querySyncFiles, downloadSyncFile, deleteSyncFile, deleteFile,
  // exported for tests only
  _internal: { assertSafeGcodeArg, parseFallbackStats }
};
