// connector-compat-test.js — SnapCon connector hardware-compatibility wizard
//
// Interactively drives a connector's real functions (the same functions
// server.js's route handlers call) against one real, already-known printer,
// so you can validate a connector against unknown/new hardware before it
// ships. Every state-changing step is gated behind its own [y/N] confirm,
// and every gated step asks for physical/visual confirmation SEPARATELY
// from whatever the connector call itself reported — a successful API call
// is not proof the printer physically did the thing.
//
// This exercises the same connector methods server.js's routes call, against
// real hardware — it does NOT test server.js itself: no auth, no
// audit logging, no maintenanceMode gate, no busy-printer queueing, no
// Express routing. See "server.js orchestration NOT replicated here" below.
//
// Usage:   node connector-compat-test.js
//
// Standalone by design: requires ./connectors directly, never requires
// server.js, starts no Express listener, touches no config.json, adds no
// npm dependency (Node core `readline` only). Same spirit as
// capture-proxy.js — a diagnostic tool, not part of the running app.
//
// ---- server.js orchestration this wizard deliberately does NOT replicate
// (so a PASS here means "the connector talked to the printer correctly,"
// not "SnapCon's full request pipeline behaves identically") ----
//   - requireRegular/printerVisibleTo auth + printer-visibility checks
//   - auditLog.log(...) after every action
//   - p.maintenanceMode gate on /api/print and /api/printfile (note:
//     /api/printctl — pause/resume/cancel/eject/estop — has NO maintenance
//     gate today either, so that asymmetry isn't wizard-specific)
//   - busy-printer queueing (isPrinterIdle / pendingLoad / QueueStore) —
//     the wizard always calls the connector directly, gated by its own
//     pre-flight state check below, never SnapCon's queue
//   - the background JOBS-map / /api/print-status polling abstraction —
//     the wizard awaits each call directly and polls job.sent/job.total
//     itself for upload progress
//   - applyHeadMapping's auto-trigger on default per-printer prefs
//     (printerHasAnyDefaultPref) — only fires here if you add those same
//     fields yourself via the extra-fields prompt
//
// The 0-120°C bed-temp hard clamp IS replicated below (a real safety bound
// from /api/bedtemp, not incidental request-handling).

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { getConnector, listConnectorTypes, getCapabilities } = require("./connectors");

// ---------------------------------------------------------------------
// Pure logic (exported for tests — no hardware, no I/O beyond fs.stat)
// ---------------------------------------------------------------------

// Every connector exports these unconditionally (verified against all 7
// registered connector modules, including dummy-simulator.js) — none are
// gated by a capability flag. A connector missing one is a contract bug,
// not a normal "unsupported" skip.
const CORE_METHODS = [
  "probe", "uploadFile", "startPrintFile", "pause", "resume",
  "cancel", "eject", "estop", "bedTemp"
];

// Verified capability-flag -> method-name pairing, read directly from each
// connectors/*.js module's own capabilities object + exports list.
const CAPABILITY_METHOD_MAP = {
  firmwareInfo: ["getFirmwareInfo"],
  health: ["getHealth"],
  fileSync: ["querySyncFiles"],
  excludeObject: ["getPlate", "excludeObject"],
  headMapping: ["applyHeadMapping"],
  unloadFilament: ["unloadFilament"],
  camera: ["getCameraSnapshot"],
  setColor: ["setFilamentColor"],
  inventory: ["getInventory"]
};

// Same idle-state list connectors/http-utils.js's queryFirmwareInfo already
// uses to decide whether a printer is safe to interrogate further — reused
// here rather than inventing a second definition of "idle."
const IDLE_STATES = ["standby", "complete", "cancelled"];

const SENSITIVE_KEY_RE = /pass|token|secret|key/i;
const RESULTS_DIR = "connector-test-results";
const BED_TEMP_MIN = 0;
const BED_TEMP_MAX = 120; // same hard bound as POST /api/bedtemp in server.js

function formatBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

// Shallow-redacts any key whose NAME looks sensitive. Deliberately a
// different mechanism from remote-access/redact.js (which scrubs known
// secret VALUES out of free text) — here the input is an object with
// caller-supplied field names we've never seen before, so name-matching is
// the only thing that can work.
function redactObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : v;
  }
  return out;
}

function coerceValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

// Parses simple `key=value` pairs, comma- or newline-separated. Reasonable
// bool/number coercion only — no implicit JSON parsing, no nested values.
function parseExtraFields(input) {
  const out = {};
  if (!input || !input.trim()) return out;
  const parts = input.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (!key) continue;
    out[key] = coerceValue(raw);
  }
  return out;
}

// Validates without reading the file's contents — only uploadFile() itself
// streams it.
function validateGcodeFile(filePath) {
  if (!filePath) return { ok: false, error: "No file path given" };
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, error: "File not found: " + filePath };
  }
  if (!stat.isFile()) return { ok: false, error: "Not a regular file: " + filePath };
  if (stat.size <= 0) return { ok: false, error: "File is empty: " + filePath };
  if (!/\.gcode$/i.test(filePath)) return { ok: false, error: "Not a .gcode file: " + filePath };
  return { ok: true, name: path.basename(filePath), size: stat.size };
}

// Missing a core method is a CONTRACT-FAILURE, not a normal skip — every
// connector, even dummy-simulator.js, exports all of these.
function checkCoreMethods(connector) {
  return CORE_METHODS.map(method => ({ method, ok: typeof connector[method] === "function" }));
}

// 4-way contract sanity check per optional capability:
//   advertised + method(s) exist          -> OK (offer it later)
//   advertised + method(s) missing        -> CONTRACT-FAILURE (a real bug)
//   not advertised + method(s) missing    -> UNSUPPORTED (don't offer)
//   not advertised + method(s) exist      -> INFO (never auto-offered —
//     e.g. creality-klipper exports applyHeadMapping without headMapping:
//     true, since its own comment explains real per-slot mapping isn't
//     actually supported there)
function sanityCheckCapabilities(connector, capabilities) {
  const caps = capabilities || {};
  const out = [];
  for (const [cap, methods] of Object.entries(CAPABILITY_METHOD_MAP)) {
    const advertised = !!caps[cap];
    const present = methods.map(m => typeof connector[m] === "function");
    const allPresent = present.every(Boolean);
    const anyPresent = present.some(Boolean);
    let status, note = null;
    if (advertised && allPresent) {
      status = "OK";
    } else if (advertised && !allPresent) {
      status = "CONTRACT-FAILURE";
      const missing = methods.filter((m, i) => !present[i]);
      note = "capability advertised but missing: " + missing.join(", ");
    } else if (!advertised && !anyPresent) {
      status = "UNSUPPORTED";
    } else {
      status = "INFO";
      note = "method exists but capability not advertised — informational only, not auto-tested";
    }
    out.push({ capability: cap, methods, status, note });
  }
  return out;
}

// Same 0-120°C hard bound as POST /api/bedtemp; a value above the
// connector's own advertised maxBedTemp is allowed but flagged, since
// that's advisory (per-model) rather than the app-wide safety clamp.
function validateBedTemp(input, maxBedTemp) {
  const n = Number(input);
  if (!Number.isFinite(n)) return { ok: false, error: "Not a number" };
  if (n < BED_TEMP_MIN || n > BED_TEMP_MAX) {
    return { ok: false, error: `Temp must be ${BED_TEMP_MIN}-${BED_TEMP_MAX}°C` };
  }
  const warn = (typeof maxBedTemp === "number" && n > maxBedTemp)
    ? `Exceeds this connector's advertised maxBedTemp (${maxBedTemp}°C).`
    : null;
  return { ok: true, value: n, warn };
}

function isIdleState(state) {
  return IDLE_STATES.includes(state);
}

// One record per operation. apiMs/physicalResult stay null for checks with
// no physical component (e.g. a read-only firmware/health query).
function makeStep(step, apiResult, apiMs, apiDetail) {
  return { step, apiResult, apiMs: apiMs ?? null, apiDetail: apiDetail ?? null, physicalResult: null, physicalDetail: null };
}

// Times an async call, preserving the real thrown error verbatim (message +
// stack) rather than collapsing it into a generic failure — this is exactly
// what's needed to diagnose e.g. Moonraker timeout behavior.
async function timeCall(fn) {
  const start = Date.now();
  try {
    const result = await fn();
    return { ok: true, ms: Date.now() - start, result, error: null };
  } catch (e) {
    return { ok: false, ms: Date.now() - start, result: null, error: e && (e.stack || e.message) || String(e) };
  }
}

function overallResult(steps) {
  const failed = steps.filter(s => s.apiResult === "FAIL" || s.apiResult === "CONTRACT-FAILURE" || s.physicalResult === "FAIL");
  const skipped = steps.filter(s => s.apiResult === "SKIPPED" || s.apiResult === "UNSUPPORTED");
  if (failed.length) return `FAILED (${failed.length} failing step${failed.length === 1 ? "" : "s"})`;
  if (skipped.length) return `PASS WITH ${skipped.length} SKIPPED STEP${skipped.length === 1 ? "" : "S"}`;
  return "PASS";
}

function padCol(s, width) {
  s = String(s);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function buildReportText(meta, contractChecks, steps) {
  const lines = [];
  lines.push("Connector Compatibility Report");
  lines.push("-".repeat(31));
  lines.push("Connector: " + meta.connectorType);
  lines.push("Printer:   " + meta.printerName);
  lines.push("URL:       " + meta.url);
  if (meta.firmware) lines.push("Firmware:  " + meta.firmware);
  lines.push("");
  lines.push("Contract check:");
  for (const c of contractChecks) {
    lines.push("  " + padCol(c.capability, 16) + padCol(c.status, 18) + (c.note || ""));
  }
  lines.push("");
  lines.push("Operations:");
  for (const s of steps) {
    const apiCol = padCol(s.apiResult, 11) + padCol(s.apiMs != null ? s.apiMs + " ms" : "", 10);
    lines.push("  " + padCol(s.step, 24) + apiCol + (s.apiDetail && s.apiResult !== "PASS" ? s.apiDetail : ""));
    if (s.physicalResult) {
      lines.push("  " + padCol("  physical", 24) + padCol(s.physicalResult, 21) + (s.physicalDetail || ""));
    }
  }
  lines.push("");
  lines.push("Overall: " + overallResult(steps));
  return lines.join("\n");
}

function sanitizeReport(meta, contractChecks, steps) {
  return {
    timestamp: new Date().toISOString(),
    connectorType: meta.connectorType,
    printerName: meta.printerName,
    printer: redactObject(meta.printerConfig),
    capabilities: meta.capabilities,
    firmware: meta.firmware || null,
    contractChecks,
    steps,
    overall: overallResult(steps)
  };
}

function resultFileName(connectorType, printerName) {
  const safeName = String(printerName || "printer").replace(/[^a-z0-9_-]+/gi, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${connectorType}-${safeName}-${stamp}.json`;
}

module.exports = {
  CORE_METHODS, CAPABILITY_METHOD_MAP, IDLE_STATES,
  formatBytes, redactObject, parseExtraFields, validateGcodeFile,
  checkCoreMethods, sanityCheckCapabilities, validateBedTemp, isIdleState,
  makeStep, timeCall, overallResult, buildReportText, sanitizeReport, resultFileName,
  BED_TEMP_MIN, BED_TEMP_MAX, RESULTS_DIR
};

// ---------------------------------------------------------------------
// Interactive flow — only runs when this file is executed directly.
// ---------------------------------------------------------------------

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(resolve => rl.question(q, resolve));
  async function confirm(q) {
    const a = (await ask(q + " [y/N] ")).trim().toLowerCase();
    return a === "y" || a === "yes";
  }
  async function askPhysical(q) {
    const a = (await ask(q + " [y/n, blank = not sure] ")).trim().toLowerCase();
    if (a === "y" || a === "yes") return "PASS";
    if (a === "n" || a === "no") return "FAIL";
    return "USER-UNCONFIRMED";
  }

  const steps = [];
  function record(entry) { steps.push(entry); return entry; }

  async function main() {
    console.log("SnapCon Connector Hardware-Compatibility Wizard");
    console.log("This performs REAL print-control actions against real hardware.\n");

    // ---- Setup ----
    const types = listConnectorTypes();
    types.forEach((t, i) => console.log(`  ${i + 1}) ${t.type} — ${t.label}`));
    let typeIdx = -1;
    while (!(typeIdx >= 0 && typeIdx < types.length)) {
      typeIdx = parseInt(await ask("Connector # : "), 10) - 1;
    }
    const connectorType = types[typeIdx].type;
    const connector = getConnector(connectorType);

    const name = (await ask("Printer name: ")).trim() || "Test printer";
    let url = (await ask("Printer URL (e.g. http://192.168.1.50): ")).trim().replace(/\/+$/, "");
    const extraRaw = await ask("Extra fields? key=value, comma-separated (e.g. filamentMode=cfs). Blank to skip: ");
    const extra = parseExtraFields(extraRaw);

    let printer = { name, url, connector: connectorType, ...extra };
    console.log("\nPrinter object:", JSON.stringify(redactObject(printer), null, 2));
    if (printer.maintenanceMode) {
      console.log("Note: maintenanceMode is set on this object — server.js's /api/print and /api/printfile would refuse to upload/start; /api/printctl (pause/resume/cancel/eject/estop) does not check it. This wizard does not check it either way.");
    }

    // ---- Read-only diagnostics ----
    console.log("\n--- Read-only diagnostics ---");
    const coreCheck = checkCoreMethods(connector);
    for (const c of coreCheck) {
      if (!c.ok) {
        record(makeStep(`core:${c.method}`, "CONTRACT-FAILURE", null, "connector does not export this required method"));
        console.log(`  CONTRACT-FAILURE: connector is missing required core method '${c.method}'`);
      }
    }

    // Declared here (not where first computed) so an early Quit from the
    // probe-retry loop below can still call finish() safely — `let`/`const`
    // declared later in this scope would still be in their temporal dead
    // zone at that point.
    let capabilities = null, contractChecks = [], firmwareLabel = null;

    let st = null;
    while (!st) {
      const probeRun = await timeCall(() => connector.probe(printer));
      if (probeRun.ok && probeRun.result && probeRun.result.online) {
        st = probeRun.result;
        record(makeStep("probe", "PASS", probeRun.ms, null));
        console.log(`  probe PASS (${probeRun.ms} ms) — state=${st.state}`);
      } else {
        const detail = probeRun.error || (probeRun.result && probeRun.result.error) || "not online";
        console.log(`  probe FAILED (${probeRun.ms} ms): ${detail}`);
        const choice = (await ask("  [R]etry/change URL  [C]ontinue anyway  [Q]uit: ")).trim().toLowerCase();
        if (choice === "r") {
          url = (await ask("  New URL: ")).trim().replace(/\/+$/, "") || url;
          printer = { ...printer, url };
        } else if (choice === "c") {
          record(makeStep("probe", "FAIL", probeRun.ms, detail));
          st = { online: false, state: "unknown" };
        } else {
          record(makeStep("probe", "FAIL", probeRun.ms, detail));
          finish();
          return;
        }
      }
    }

    capabilities = getCapabilities(connectorType, printer);
    console.log("\nResolved capabilities:", JSON.stringify(capabilities));
    contractChecks = sanityCheckCapabilities(connector, capabilities);
    console.log("\nContract check:");
    for (const c of contractChecks) {
      console.log(`  ${c.capability.padEnd(16)} ${c.status}${c.note ? " — " + c.note : ""}`);
      if (c.status === "CONTRACT-FAILURE") record(makeStep(`contract:${c.capability}`, "CONTRACT-FAILURE", null, c.note));
    }

    if (contractChecks.find(c => c.capability === "firmwareInfo" && c.status === "OK")) {
      const fwRun = await timeCall(() => connector.getFirmwareInfo(printer, st));
      if (fwRun.ok && fwRun.result && !fwRun.result.skipped) {
        record(makeStep("firmwareInfo", "PASS", fwRun.ms, null));
        firmwareLabel = fwRun.result.version || fwRun.result.name || null;
        console.log(`  firmwareInfo PASS (${fwRun.ms} ms)`);
      } else {
        record(makeStep("firmwareInfo", fwRun.ok ? "SKIPPED" : "FAIL", fwRun.ms, fwRun.error || (fwRun.result && fwRun.result.reason)));
        console.log(`  firmwareInfo ${fwRun.ok ? "SKIPPED" : "FAIL"} (${fwRun.ms} ms)`);
      }
    }
    if (contractChecks.find(c => c.capability === "health" && c.status === "OK")) {
      const hRun = await timeCall(() => connector.getHealth(printer, st));
      record(makeStep("health", hRun.ok ? "PASS" : "FAIL", hRun.ms, hRun.error));
      console.log(`  health ${hRun.ok ? "PASS" : "FAIL"} (${hRun.ms} ms)`);
    }

    // ---- Top-level menu ----
    let done = false;
    while (!done) {
      console.log("\n1) Temperature test\n2) Print-cycle test\n" +
        (typeof connector.estop === "function" ? "3) EMERGENCY STOP TEST\n" : "") +
        "0) Done — show report\n");
      const choice = (await ask("Choice: ")).trim();
      if (choice === "1") await temperatureTest();
      else if (choice === "2") await printCycleTest();
      else if (choice === "3" && typeof connector.estop === "function") await estopTest();
      else if (choice === "0") done = true;
    }
    const { meta } = finish();

    function finish() {
      const meta = {
        connectorType, printerName: printer.name, url: printer.url,
        printerConfig: printer, capabilities, firmware: firmwareLabel
      };
      const text = buildReportText(meta, contractChecks, steps);
      console.log("\n" + text);
      return { meta, text };
    }

    async function temperatureTest() {
      st = (await timeCall(() => connector.probe(printer))).result || st;
      const original = st && st.bed ? st.bed.target : null;
      console.log(`Current bed: ${st && st.bed ? `${st.bed.temp}°C (target ${st.bed.target}°C)` : "unknown"}`);
      const targetRaw = await ask("Target bed temperature (°C): ");
      const v = validateBedTemp(targetRaw, capabilities.maxBedTemp);
      if (!v.ok) { console.log("  " + v.error); record(makeStep("bedTemp", "SKIPPED", null, v.error)); return; }
      if (v.warn && !(await confirm("  " + v.warn + " Continue?"))) { record(makeStep("bedTemp", "SKIPPED", null, "declined after maxBedTemp warning")); return; }
      if (!(await confirm(`Set bed target to ${v.value}°C?`))) { record(makeStep("bedTemp", "SKIPPED", null, "declined by user")); return; }
      const run = await timeCall(() => connector.bedTemp(printer, v.value));
      const entry = record(makeStep("bedTemp", run.ok ? "PASS" : "FAIL", run.ms, run.error));
      console.log(`  bedTemp ${entry.apiResult} (${run.ms} ms)`);
      if (run.ok) {
        const after = (await timeCall(() => connector.probe(printer))).result;
        console.log(`  New target reported: ${after && after.bed ? after.bed.target : "unknown"}°C`);
        entry.physicalResult = await askPhysical("  Did the bed's target actually update on the printer?");
      }
      if (original != null && (await confirm(`Restore original target (${original}°C)?`))) {
        const restore = await timeCall(() => connector.bedTemp(printer, original));
        record(makeStep("bedTemp:restore", restore.ok ? "PASS" : "FAIL", restore.ms, restore.error));
      }
    }

    async function printCycleTest() {
      const filePath = (await ask("Path to .gcode file: ")).trim();
      const v = validateGcodeFile(filePath);
      if (!v.ok) { console.log("  " + v.error); record(makeStep("gcodeValidation", "FAIL", null, v.error)); return; }
      console.log(`  ${v.name} (${formatBytes(v.size)})`);

      st = (await timeCall(() => connector.probe(printer))).result || st;
      if (st && st.online && !isIdleState(st.state)) {
        console.log(`  WARNING: printer currently reports state "${st.state}" — it may not be idle.`);
      }
      let started = false;

      if (await confirm(`Upload ${v.name}?`)) {
        const job = {};
        const progressTimer = setInterval(() => {
          if (job.total) process.stdout.write(`\r  uploading ${job.sent}/${job.total} bytes`);
        }, 300);
        const run = await timeCall(() => connector.uploadFile(printer, filePath, v.name, job));
        clearInterval(progressTimer);
        process.stdout.write("\n");
        record(makeStep("upload", run.ok ? "PASS" : "FAIL", run.ms, run.error));
        console.log(`  upload ${run.ok ? "PASS" : "FAIL"} (${run.ms} ms)`);
      } else {
        record(makeStep("upload", "SKIPPED", null, "declined by user"));
      }

      const headMappingCheck = contractChecks.find(c => c.capability === "headMapping" && c.status === "OK");
      if (headMappingCheck && (await confirm("Test applyHeadMapping (empty mapping)?"))) {
        const run = await timeCall(() => connector.applyHeadMapping(printer, [], {}, {}));
        record(makeStep("applyHeadMapping", run.ok ? "PASS" : "FAIL", run.ms, run.error));
        console.log(`  applyHeadMapping ${run.ok ? "PASS" : "FAIL"} (${run.ms} ms)`);
      }

      if (await confirm(`Start print of ${v.name}?`)) {
        const run = await timeCall(() => connector.startPrintFile(printer, v.name));
        const entry = record(makeStep("start", run.ok ? "PASS" : "FAIL", run.ms, run.error));
        console.log(`  start ${entry.apiResult} (${run.ms} ms)`);
        if (run.ok) { started = true; entry.physicalResult = await askPhysical("  Did the printer actually start printing?"); }
      } else {
        record(makeStep("start", "SKIPPED", null, "declined by user — no test print running this session"));
      }

      if (await confirm(started ? "Pause?" : "Pause? (no print was started this session — likely to fail)")) {
        const run = await timeCall(() => connector.pause(printer));
        const entry = record(makeStep("pause", run.ok ? "PASS" : "FAIL", run.ms, run.error));
        console.log(`  pause ${entry.apiResult} (${run.ms} ms)`);
        if (run.ok) entry.physicalResult = await askPhysical("  Did the printer visibly pause?");
      } else {
        record(makeStep("pause", "SKIPPED", null, "declined by user"));
      }

      if (await confirm("Resume?")) {
        const run = await timeCall(() => connector.resume(printer));
        const entry = record(makeStep("resume", run.ok ? "PASS" : "FAIL", run.ms, run.error));
        console.log(`  resume ${entry.apiResult} (${run.ms} ms)`);
        if (run.ok) entry.physicalResult = await askPhysical("  Did the printer visibly resume?");
      } else {
        record(makeStep("resume", "SKIPPED", null, "declined by user"));
      }

      const beforeCancel = (await timeCall(() => connector.probe(printer))).result;
      console.log(`  Printer currently reports: state=${beforeCancel ? beforeCancel.state : "unknown"}`);
      if (await confirm("Cancel?")) {
        const run = await timeCall(() => connector.cancel(printer));
        const entry = record(makeStep("cancel", run.ok ? "PASS" : "FAIL", run.ms, run.error));
        console.log(`  cancel ${entry.apiResult} (${run.ms} ms)`);
        if (run.ok) entry.physicalResult = await askPhysical("  Did the printer visibly cancel?");
      } else {
        record(makeStep("cancel", "SKIPPED", null, "declined by user"));
      }

      if (await confirm("Eject?")) {
        const run = await timeCall(() => connector.eject(printer));
        record(makeStep("eject", run.ok ? "PASS" : "FAIL", run.ms, run.error));
        console.log(`  eject ${run.ok ? "PASS" : "FAIL"} (${run.ms} ms)`);
      } else {
        record(makeStep("eject", "SKIPPED", null, "declined by user"));
      }
    }

    async function estopTest() {
      console.log("\n  This sends the REAL emergency-stop command to the printer.");
      console.log("  The printer may enter firmware shutdown.");
      console.log("  Manual firmware/printer restart may be required.");
      console.log("  This cannot be undone through this wizard.\n");
      const typed = await ask("  Type ESTOP exactly to continue, anything else cancels: ");
      if (typed !== "ESTOP") { console.log("  Cancelled."); record(makeStep("estop", "SKIPPED", null, "not confirmed")); return; }
      const run = await timeCall(() => connector.estop(printer));
      record(makeStep("estop", run.ok ? "PASS" : "FAIL", run.ms, run.error));
      console.log(`  estop ${run.ok ? "PASS" : "FAIL"} (${run.ms} ms)`);
      const after = await timeCall(() => connector.probe(printer));
      console.log(`  post-estop probe: ${after.ok ? "online, state=" + after.result.state : "offline/unreachable — expected after a firmware shutdown"}`);
    }

    if (await confirm("\nSave this run as JSON?")) {
      if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR);
      const file = path.join(RESULTS_DIR, resultFileName(connectorType, printer.name));
      fs.writeFileSync(file, JSON.stringify(sanitizeReport(meta, contractChecks, steps), null, 2));
      console.log("Saved to " + file);
    }
    rl.close();
  }

  main().catch(e => { console.error(e); rl.close(); process.exit(1); });
}
