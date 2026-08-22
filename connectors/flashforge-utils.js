// connectors/flashforge-utils.js — shared primitives for FlashForge's HTTP
// API (port 8898, JSON, serialNumber+checkCode auth) — NOT Moonraker/Klipper
// at all, a completely different protocol family. Shared by
// flashforge-adventurer.js (5M/5M Pro) and flashforge-ad5x.js (adds the IFS
// multi-material station).
//
// Built from the community-documented API (github.com/Parallel-7/
// flashforge-api-docs) and confirmed working against a real Adventurer 5M
// Pro. Fields marked "assumed" below are still just documented, not yet
// exercised on real hardware — worth double-checking if something looks off.
const fs = require("fs");
const http = require("http");
const net = require("net");
const { Transform } = require("stream");
const { normHex } = require("../parser");

// Port 8898 is FlashForge's HTTP API port — not the obvious default the way
// Moonraker's port-80-via-proxy convention is, so it's easy to type just the
// bare IP and get nothing but silent offline. Default it in whenever the
// entered URL has no explicit port, rather than requiring every user to know
// to add :8898 themselves.
const baseUrl = p => {
  let u = String(p.url).replace(/\/+$/, "");
  try {
    const parsed = new URL(u);
    if (!parsed.port) { parsed.port = "8898"; u = parsed.toString().replace(/\/+$/, ""); }
  } catch { /* not a fully-qualified URL — leave it as typed */ }
  return u;
};

async function fetchTimeout(url, ms, opts) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

// Every FlashForge HTTP endpoint returns {code, message, ...data} —
// code:0 = success (confirmed against the reference emulator's
// create_success_response/create_error_response), anything else is a
// user-showable error via `message`.
async function ffPost(p, path, extraBody, ms = 5000) {
  const body = JSON.stringify({ serialNumber: p.serial || "", checkCode: p.verificationCode || "", ...extraBody });
  let r;
  try {
    r = await fetchTimeout(baseUrl(p) + path, ms, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  } catch (e) {
    throw new Error("Could not reach " + p.name + ": " + e.message);
  }
  if (!r.ok) throw new Error("FlashForge HTTP " + r.status);
  const j = await r.json();
  if (j.code !== 0) throw new Error(j.message || "FlashForge error " + j.code);
  return j;
}

const ffDetail = p => ffPost(p, "/detail", {}, 3500).then(j => j.detail || {});
// Every /control command in the actual primary source (github.com/
// Parallel-7/flashforge-api-docs wiki, cloned locally and read directly —
// not just the wiki's rendered prose) is documented with cmd/args nested
// under "payload": jobCtl_cmd, temperatureCtl_cmd, streamCtrl_cmd, ms_cmd,
// msConfig_cmd, stateCtrl_cmd, printerCtl_cmd — no exceptions shown anywhere.
// This used to send cmd/args flat instead (no "payload"), which a real AD5X
// silently accepts (code:0) while doing the WRONG thing rather than
// erroring — confirmed live: flat jobCtl_cmd "cancel" just paused the print
// instead of cancelling it, and flat ms_cmd "unload" did nothing at all.
// Wrapped is the correct, canonical shape.
const ffControl = (p, cmd, args) => ffPost(p, "/control", { payload: { cmd, args } });

// ---- Status: modern-firmware status strings -> SnapCon's internal state
// vocabulary (idle/printing/paused/complete/cancelled/error/standby, matching
// what the Klipper connectors already emit) ----
const STATE_MAP = {
  ready: "standby", completed: "complete",
  building: "printing", working: "printing", printing: "printing", heating: "printing",
  busy: "busy", canceling: "cancelled", cancel: "cancelled",
  pause: "paused", paused: "paused", pausing: "paused",
  error: "error", calibrate_doing: "busy"
};

// /detail really does carry an `errorCode` — confirmed live on a 5M Pro
// (firmware 3.1.5), where it reads "" on a healthy machine. It used to be
// hardcoded to "" here and discarded, even though the rest of SnapCon already
// consumes this field: http-utils.js's fault history reads st.errorCode, and
// the fleet card's error panel (public/app.js's lookupKlipperError) renders
// it — both escaped, so a printer-controlled string is safe to pass through.
//
// Only a genuinely non-empty, non-zero code is reported. public/app.js:330
// treats ANY truthy errorCode as 'attention', so a firmware that reports a
// benign "0"/"0000" sentinel would otherwise pin every FlashForge printer to
// a permanent attention badge — snapmaker-u1-klipper.js filters exactly such
// a sentinel ("0000-0000-0000-0000") for the same reason. Only string/number
// are accepted so an unexpected object can't stringify to "[object Object]".
function faultCode(d) {
  const raw = d.errorCode;
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  const code = String(raw).trim();
  return (!code || /^0+$/.test(code)) ? "" : code;
}

// A real 5M Pro reports `coolingFanSpeed`; `coolingFanLeftSpeed` — the name
// taken from the documented example payload — does not appear anywhere in its
// /detail (confirmed by dumping all 52 fields off firmware 3.1.5), which is
// why fanPct was always null on real hardware. Both names are tried,
// preferring the confirmed one, because this function is shared with
// flashforge-ad5x.js and no AD5X was available to check which name that model
// uses — so this can only add a reading, never take one away.
//
// STILL UNVERIFIED: the 0-255 PWM scale. The documented example value (128)
// implies PWM, but a live idle printer reads 0, so this can only be settled
// while a print is actually running. If the field turns out to be a 0-100
// percentage instead, this under-reports by 2.55x.
function fanPercent(d) {
  const raw = (typeof d.coolingFanSpeed === "number") ? d.coolingFanSpeed
    : (typeof d.coolingFanLeftSpeed === "number") ? d.coolingFanLeftSpeed
      : null;
  if (raw === null) return null;
  return Math.max(0, Math.min(100, Math.round(raw / 255 * 100)));
}

// d = the raw /detail object. Shared by both connectors — AD5X's probe()
// calls this then layers matlStationInfo-derived heads[] on top.
function decodeCommonStatus(p, d) {
  // printProgress is documented as a 0.0-1.0 ratio already, matching our
  // internal `progress` convention directly (no *100 needed).
  const progress = typeof d.printProgress === "number" ? d.printProgress : 0;
  // rightTemp is the documented single-nozzle field in the API's own
  // example payload; leftTemp exists for dual-nozzle FlashForge models this
  // API family also serves, so fall back to it if right reads nothing.
  const hotendSrc = (typeof d.rightTemp === "number" && d.rightTemp > 0) ? { t: d.rightTemp, tt: d.rightTargetTemp }
    : (typeof d.leftTemp === "number" && d.leftTemp > 0) ? { t: d.leftTemp, tt: d.leftTargetTemp } : null;
  return {
    name: p.name, online: true,
    state: STATE_MAP[d.status] || d.status || "unknown",
    message: d.status === "error" ? String(d.errorMessage || d.status || "") : "",
    errorCode: faultCode(d),
    filename: d.printFileName || "",
    progress,
    elapsed: typeof d.printDuration === "number" ? d.printDuration : null,
    filamentUsed: null, // not present in the documented /detail schema
    bed: (typeof d.platTemp === "number") ? { temp: Math.round(d.platTemp), target: Math.round(d.platTargetTemp || 0) } : null,
    hotend: hotendSrc ? { temp: Math.round(hotendSrc.t), target: Math.round(hotendSrc.tt || 0) } : null,
    layer: (typeof d.printLayer === "number") ? { current: d.printLayer, total: d.targetPrintLayer || 0 } : null,
    speed: null, // not present in the documented /detail schema
    fanPct: fanPercent(d),
    activeExt: null,
    plate: null // FlashForge's API has no documented exclude_object equivalent
  };
}

// ---- Job control ----
// jobID is documented as an empty string in the reference spec's own
// example payload — not something read back from /detail first.
const pause = p => ffControl(p, "jobCtl_cmd", { jobID: "", action: "pause" });
const resume = p => ffControl(p, "jobCtl_cmd", { jobID: "", action: "continue" });
const cancel = p => ffControl(p, "jobCtl_cmd", { jobID: "", action: "cancel" });
// A cancelled or completed job leaves an on-screen "clear the plate" dialog
// that blocks new jobs until dismissed — confirmed live: after cancelling,
// the printer stayed on printFileName/status "cancel" indefinitely (not the
// quick auto-transition to "ready" the docs describe) and refused a new
// print. stateCtrl_cmd/setClearPlatform is the documented dismiss-and-reset
// command (github.com/Parallel-7/flashforge-api-docs wiki, "HTTP REST API" —
// "Availability: 5M Series, AD5X"), so this is what eject() actually is here.
const eject = p => ffControl(p, "stateCtrl_cmd", { action: "setClearPlatform" });
// The HTTP API (port 8898) has no real emergency-stop endpoint — jobCtl_cmd
// "cancel" is a graceful cancel (finishes/retracts like a normal cancel),
// not an immediate halt, which is exactly why an AD5X e-stop wasn't
// stopping right away. A genuine immediate/irrecoverable stop only exists
// on the legacy raw G-code TCP control port (8899): per community docs
// (github.com/Parallel-7/flashforge-api-docs wiki "TCP Protocol"), ~M601 S1
// acquires the control session (printer replies "...Control Success...ok"),
// then ~M112 halts everything immediately. NOT yet verified against real
// hardware — M112 is destructive and irreversible, so this needs a
// deliberate real test with nothing valuable printing, not an incidental one.
function tcpHost(p) {
  try { return new URL(baseUrl(p)).hostname; }
  catch { return String(p.url).replace(/^https?:\/\//, "").split(":")[0].split("/")[0]; }
}
// Runs `commands` in order over ONE socket (the control session M601 grants
// is tied to that connection, not just a token) — waits for "ok" between
// each. The last command (M112) may never send a clean reply once the halt
// begins, so reaching it (idx > 0, meaning M601 itself was acknowledged) is
// treated as success even if the socket then times out or drops.
function sendTcpSequence(p, commands, ms = 4000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: tcpHost(p), port: 8899 });
    let buf = "", idx = 0;
    const timer = setTimeout(() => { sock.destroy(); resolve({ ok: idx > 0 }); }, ms);
    const sendNext = () => sock.write("~" + commands[idx] + "\r\n");
    sock.on("connect", sendNext);
    sock.on("data", d => {
      buf += d.toString();
      if (/\bok\b/i.test(buf)) {
        idx++; buf = "";
        if (idx < commands.length) sendNext();
        else { clearTimeout(timer); sock.end(); resolve({ ok: true }); }
      }
    });
    sock.on("error", e => { clearTimeout(timer); if (idx === 0) reject(new Error("TCP control: " + e.message)); else resolve({ ok: true }); });
    sock.on("close", () => { clearTimeout(timer); resolve({ ok: idx > 0 }); });
  });
}
async function estop(p) {
  const r = await sendTcpSequence(p, ["M601 S1", "M112"]);
  if (!r.ok) throw new Error("Could not confirm the printer received the stop — check it directly");
}

// -100 = off, -200 = "no change" (per temperatureCtl_cmd's documented args)
const NO_CHANGE = -200;
const bedTemp = (p, t) => ffControl(p, "temperatureCtl_cmd", { platform: Math.round(t), rightNozzle: NO_CHANGE, leftNozzle: NO_CHANGE, chamber: NO_CHANGE });

// /printGcode answers {"code":0,"message":"Success"} even when it silently
// discards the command. Confirmed live on a 5M Pro (firmware 3.1.5): a start
// issued 1ms after uploadFile() resolved was acknowledged and then ignored
// (the printer sat at "ready", never heated), while a byte-identical call
// 1857ms later actually printed. server.js's /api/print fires the start the
// instant the upload resolves, so Send to Printers landed inside that window
// every time — and because the response says Success, SnapCon reported the
// job done and wrote a "print-started" audit entry for a print that never
// happened. The silent false success was the more dangerous half of the bug.
//
// A fixed sleep would only ever be a guess: that measurement used a 1MB file,
// and the window plausibly scales with upload size. So the command is
// confirmed against the printer's OWN state instead and re-issued if it
// didn't take — self-calibrating, and free when the first attempt works
// (the common case, since /api/printfile starts prints with no upload
// before them and has never had this problem).
//
// Deliberately NOT retried when the printer is ALREADY behind an on-screen
// dialog before the start is issued: the "clear the plate" prompt after a
// finished/cancelled job (see eject()) leaves it busy/cancel and legitimately
// refusing new jobs until an operator presses OK — confirmed live. That is a
// human-blocked printer, not a dropped command, so it fails immediately with
// something actionable rather than firing print commands at a machine that is
// waiting on a person.
//
// That check is a PRE-FLIGHT ONLY and is deliberately never applied during
// the confirmation window. Confirmed live on a 5M Pro: the printer passes
// through a blocked-looking state on its way INTO a print — the window caught
// it there while it was in fact heating the bed toward 50C, and it went on to
// print the job normally. Failing on that transient reported a false failure
// for a print that was genuinely running, which is a worse bug than the one
// this function exists to fix. Inside the window, only reaching "printing"
// counts; every other state simply keeps polling.
// DEFAULT IS 1 — the start is verified but deliberately NOT re-issued.
//
// Re-issuing looked right on paper (the first /printGcode after an upload is
// provably inert: measured "ready" 1800ms after it) and the second command
// did make the printer report "printing". But confirmed live on a 5M Pro, it
// never actually printed: heaters reached 220C/50C, printDuration ticked up,
// and printProgress/currentPrintSpeed/coolingFanSpeed stayed at 0 with
// printLayer pinned at the layer TOTAL — a phantom job that sat at full
// temperature until cancelled. Reporting "printing" for that is worse than
// the silent no-op this function was written to fix, and re-sending a
// physical state-changing command to a machine whose API acknowledges
// commands it discards is not a safe thing to do blind.
//
// So: keep the verification (which is what stops SnapCon lying about a print
// that never began) and drop the automatic retry until the underlying
// sequencing is actually understood. The loop still honours a higher
// attempts override so the behaviour remains testable/measurable, but no
// production path re-issues a start today.
const PRINT_CONFIRM_ATTEMPTS = 1;
const PRINT_CONFIRM_WINDOW_MS = 2500;
const PRINT_CONFIRM_POLL_MS = 500;
// Mapped states (STATE_MAP output) that mean "a person has to act", not
// "the command was dropped".
const PRINT_BLOCKED_STATES = new Set(["busy", "paused", "cancelled"]);

// opts is a named-option override for the three timings above; production
// callers pass nothing and get the measured defaults. It exists so the
// confirmation logic can be tested without spending its real wall-clock
// budget — the defaults are the contract, not the parameters.
async function issuePrintAndConfirm(p, body, opts = {}) {
  const attempts = opts.attempts || PRINT_CONFIRM_ATTEMPTS;
  const windowMs = opts.windowMs || PRINT_CONFIRM_WINDOW_MS;
  const pollMs = opts.pollMs || PRINT_CONFIRM_POLL_MS;
  // Pre-flight (see above): only a printer that is blocked BEFORE anything is
  // sent counts as human-blocked. A failed read here is not evidence of
  // anything, so it falls through and the start is attempted normally.
  let pre = "";
  try { pre = STATE_MAP[(await ffDetail(p)).status] || ""; } catch { /* not evidence */ }
  if (PRINT_BLOCKED_STATES.has(pre)) {
    throw new Error("The printer isn't ready for a new job — its screen is showing a dialog. Clear it on the printer, then try again.");
  }

  let seen = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await ffPost(p, "/printGcode", body, 8000);
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollMs));
      let state;
      // A transient read failure is not evidence either way — keep polling
      // rather than treating it as a dropped command and re-issuing a start.
      try { state = STATE_MAP[(await ffDetail(p)).status] || ""; } catch { continue; }
      if (state === "printing") return res;
      seen = state;
    }
  }
  throw new Error("The printer acknowledged the print but never started it (still "
    + (seen === "standby" || !seen ? "idle" : seen) + " after " + attempts
    + " attempts) — this can happen right after a large upload. Try again.");
}

const startPrintFile = (p, filename) => issuePrintAndConfirm(p, { fileName: filename, levelingBeforePrint: false });

// ---- File management ----
async function listFiles(p) {
  const j = await ffPost(p, "/gcodeList", {}, 8000);
  return (j.gcodeList || []).map(name => ({ path: name, size: null, modified: null }));
}
async function getThumbnail(p, file) {
  const j = await ffPost(p, "/gcodeThumb", { fileName: file }, 8000);
  if (!j.imageData) { const e = new Error("No thumbnail"); e.status = 404; throw e; }
  const buffer = Buffer.from(j.imageData, "base64");
  // Confirmed live: this is actually BMP ("BM" magic bytes), not PNG despite
  // the field name — mislabeling it caused no visible failure (browsers
  // sniff content), but was still wrong.
  const contentType = buffer[0] === 0x42 && buffer[1] === 0x4D ? "image/bmp" : "image/png";
  return { contentType, buffer };
}
// There's no dedicated per-file metadata endpoint — /gcodeList's optional
// gcodeListDetail array is the only source, and it's only ever populated for
// AD5X multi-material (useMatlStation) jobs; confirmed live against a real
// 5M Pro that plain single-material files get no gcodeListDetail at all, so
// this degrades to an empty palette there rather than erroring.
async function getFileMetadata(p, file) {
  const j = await ffPost(p, "/gcodeList", {}, 8000);
  const detail = (j.gcodeListDetail || []).find(f => f.gcodeFileName === file);
  if (!detail) return { palette: [], estimatedTime: null, isFS: false, fsFork: null };
  // materialColor comes straight from the printer's own JSON with no format
  // guarantee — every other hex color in the codebase (parsed gcode files,
  // live head status, flashforge-ad5x.js's own materialColor uses) goes
  // through normHex(), which enforces a strict #RRGGBB/#RGB shape and
  // returns null on anything else. Skipping that here let an unvalidated
  // device-controlled string reach an unescaped `style="background:${...}"`
  // template in public/app.js.
  const palette = (detail.gcodeToolDatas || []).map((t, i) => ({
    i, hex: normHex(t.materialColor), type: t.materialName || "",
    wt: t.filamentWeight != null ? String(t.filamentWeight) : "",
    used: true
  }));
  return { palette, estimatedTime: detail.printingTime || null, isFS: false, fsFork: null };
}

// Upload: unlike Moonraker's plain multipart POST, FlashForge's /uploadGcode
// puts auth + print options in HEADERS (not form fields) alongside a
// multipart body carrying just the file bytes.
function uploadFile(p, fp, name, job) {
  return new Promise((resolve, reject) => {
    const boundary = "----snapcon" + Math.random().toString(16).slice(2);
    const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="gcodeFile"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    const fileSize = fs.statSync(fp).size;
    job.total = pre.length + fileSize + post.length;
    job.sent = 0;
    const u = new URL(baseUrl(p) + "/uploadGcode");
    const req = http.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": job.total,
        serialNumber: p.serial || "", checkCode: p.verificationCode || "",
        fileSize: String(fileSize), printNow: "false", levelingBeforePrint: "false"
      }
    }, res => {
      let b = ""; res.setEncoding("utf8"); res.on("data", d => b += d);
      res.on("end", () => {
        if (res.statusCode >= 300) return reject(new Error("Upload " + res.statusCode + ": " + b.slice(0, 160)));
        try { if (JSON.parse(b).code !== 0) return reject(new Error(JSON.parse(b).message || "Upload failed")); }
        catch { /* non-JSON 2xx body — treat as success */ }
        resolve(b);
      });
    });
    req.on("error", reject);
    req.write(pre); job.sent += pre.length;
    const fileStream = fs.createReadStream(fp);
    const counter = new Transform({ transform(chunk, _e, cb) { job.sent += chunk.length; cb(null, chunk); } });
    fileStream.on("error", reject);
    counter.on("error", reject);
    counter.on("data", chunk => { if (!req.write(chunk)) { counter.pause(); req.once("drain", () => counter.resume()); } });
    counter.on("end", () => { req.write(post); job.sent += post.length; req.end(); });
    fileStream.pipe(counter);
  });
}

// ---- Camera: a SEPARATE MJPEG-Streamer instance (V4L2/FFmpeg on the
// printer) on port 8080, not reachable through the main JSON API port at
// all. /getThum looks like the obvious candidate (name matches, and it does
// return an image) but it's actually the CURRENT PRINT's thumbnail, not a
// camera frame — confirmed live: it errors whenever nothing is printing,
// camera or not.
//
// Confirmed live against a real 5M Pro: this build of MJPG-Streamer only
// implements the `?action=stream` plugin (continuous multipart
// `multipart/x-mixed-replace`), NOT `?action=snapshot` — so a single frame
// has to be pulled out of the live stream and the connection dropped
// immediately, rather than requesting one image directly. It also only
// accepts ONE viewer at a time (confirmed: a second connection attempt gets
// silently hung up while a browser tab is still open on the stream) — all
// the more reason to grab one frame and disconnect right away rather than
// leaving a connection open.
async function getCameraSnapshot(p) {
  const host = new URL(baseUrl(p)).hostname;
  const streamUrl = `http://${host}:8080/?action=stream`;
  await ffControl(p, "streamCtrl_cmd", { action: "open" }).catch(() => {});
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      const req = http.get(streamUrl, { timeout: 8000 }, res => {
        if (res.statusCode !== 200) { req.destroy(); return done(reject, new Error("FlashForge camera HTTP " + res.statusCode)); }
        let buf = Buffer.alloc(0), dataStart = -1, contentLength = -1;
        res.on("data", chunk => {
          buf = Buffer.concat([buf, chunk]);
          if (dataStart === -1) {
            const headerEnd = buf.indexOf("\r\n\r\n");
            if (headerEnd === -1) return; // still waiting for the multipart part's headers
            const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, headerEnd).toString("latin1"));
            if (!m) { req.destroy(); return done(reject, new Error("Malformed camera stream (no frame length)")); }
            contentLength = parseInt(m[1], 10);
            dataStart = headerEnd + 4;
          }
          if (contentLength !== -1 && buf.length >= dataStart + contentLength) {
            const frame = buf.slice(dataStart, dataStart + contentLength);
            req.destroy();
            done(resolve, { contentType: "image/jpeg", buffer: frame });
          }
        });
        res.on("end", () => done(reject, new Error("Camera stream ended with no frame — is another viewer already connected?")));
        res.on("error", e => done(reject, e));
      });
      req.on("timeout", () => { req.destroy(); done(reject, new Error("Camera stream timed out — is another viewer already connected?")); });
      req.on("error", e => done(reject, e));
    });
  } finally {
    ffControl(p, "streamCtrl_cmd", { action: "close" }).catch(() => {});
  }
}

module.exports = {
  baseUrl, fetchTimeout, ffPost, ffDetail, ffControl, STATE_MAP, decodeCommonStatus,
  pause, resume, cancel, eject, estop, bedTemp, startPrintFile, issuePrintAndConfirm,
  listFiles, getThumbnail, getFileMetadata, uploadFile, getCameraSnapshot
};
