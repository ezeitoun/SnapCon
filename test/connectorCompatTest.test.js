// test/connectorCompatTest.test.js — unit tests for connector-compat-test.js's
// pure logic (parsing, redaction, validation, contract sanity-check, report
// building). No hardware, no real connector network calls, no readline —
// the interactive flow only runs under `require.main === module`, so
// requiring the file here just exposes the exported pure functions.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  formatBytes, redactObject, parseExtraFields, validateGcodeFile,
  checkCoreMethods, sanityCheckCapabilities, validateBedTemp, isIdleState,
  makeStep, timeCall, overallResult, buildReportText, sanitizeReport, resultFileName,
  CORE_METHODS, BED_TEMP_MIN, BED_TEMP_MAX
} = require("../connector-compat-test");

// ---- formatBytes ----
test("formatBytes: bytes, KB, MB thresholds", () => {
  assert.equal(formatBytes(500), "500 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});

// ---- redactObject ----
test("redactObject: masks keys matching pass/token/secret/key, case-insensitive", () => {
  const out = redactObject({ name: "Shop K1C", url: "http://x", apiToken: "abc123", ApiKey: "def", password: "hunter2", note: "fine" });
  assert.equal(out.name, "Shop K1C");
  assert.equal(out.url, "http://x");
  assert.equal(out.apiToken, "[redacted]");
  assert.equal(out.ApiKey, "[redacted]");
  assert.equal(out.password, "[redacted]");
  assert.equal(out.note, "fine");
});

test("redactObject: non-object input passes through unchanged", () => {
  assert.equal(redactObject(null), null);
  assert.equal(redactObject("x"), "x");
});

// ---- parseExtraFields ----
test("parseExtraFields: parses comma-separated key=value with bool/number coercion", () => {
  const out = parseExtraFields("filamentMode=cfs, cameraUrl=http://1.2.3.4, verbose=true, retries=3");
  assert.deepEqual(out, { filamentMode: "cfs", cameraUrl: "http://1.2.3.4", verbose: true, retries: 3 });
});

test("parseExtraFields: parses newline-separated pairs", () => {
  const out = parseExtraFields("a=1\nb=false");
  assert.deepEqual(out, { a: 1, b: false });
});

test("parseExtraFields: blank input yields empty object", () => {
  assert.deepEqual(parseExtraFields(""), {});
  assert.deepEqual(parseExtraFields("   "), {});
  assert.deepEqual(parseExtraFields(undefined), {});
});

test("parseExtraFields: entries without '=' are ignored", () => {
  assert.deepEqual(parseExtraFields("justakey, real=1"), { real: 1 });
});

test("parseExtraFields: does not coerce an empty value to 0", () => {
  const out = parseExtraFields("note=");
  assert.equal(out.note, "");
});

// ---- validateGcodeFile ----
test("validateGcodeFile: accepts a real, non-empty .gcode file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-compat-test-"));
  const file = path.join(dir, "benchy.gcode");
  fs.writeFileSync(file, "; fake gcode\nG28\n");
  const r = validateGcodeFile(file);
  assert.equal(r.ok, true);
  assert.equal(r.name, "benchy.gcode");
  assert.equal(r.size, fs.statSync(file).size);
});

test("validateGcodeFile: rejects a missing file", () => {
  const r = validateGcodeFile(path.join(os.tmpdir(), "does-not-exist-" + Date.now() + ".gcode"));
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/i);
});

test("validateGcodeFile: rejects a directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-compat-test-"));
  const r = validateGcodeFile(dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /regular file/i);
});

test("validateGcodeFile: rejects a zero-byte file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-compat-test-"));
  const file = path.join(dir, "empty.gcode");
  fs.writeFileSync(file, "");
  const r = validateGcodeFile(file);
  assert.equal(r.ok, false);
  assert.match(r.error, /empty/i);
});

test("validateGcodeFile: rejects a non-.gcode extension", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-compat-test-"));
  const file = path.join(dir, "model.stl");
  fs.writeFileSync(file, "not actually gcode");
  const r = validateGcodeFile(file);
  assert.equal(r.ok, false);
  assert.match(r.error, /\.gcode/);
});

test("validateGcodeFile: never reads file content — a huge file validates without hanging", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-compat-test-"));
  const file = path.join(dir, "big.gcode");
  const fd = fs.openSync(file, "w");
  fs.writeSync(fd, Buffer.from("X"), 0, 1, 5 * 1024 * 1024); // sparse 5MB+1byte file
  fs.closeSync(fd);
  const r = validateGcodeFile(file);
  assert.equal(r.ok, true);
});

// ---- checkCoreMethods ----
test("checkCoreMethods: flags a connector missing a required core method", () => {
  const fakeConnector = {};
  for (const m of CORE_METHODS) fakeConnector[m] = () => {};
  delete fakeConnector.estop;
  const results = checkCoreMethods(fakeConnector);
  const estopEntry = results.find(r => r.method === "estop");
  assert.equal(estopEntry.ok, false);
  assert.ok(results.filter(r => r.method !== "estop").every(r => r.ok));
});

test("checkCoreMethods: a fully-compliant connector reports all ok", () => {
  const fakeConnector = {};
  for (const m of CORE_METHODS) fakeConnector[m] = () => {};
  const results = checkCoreMethods(fakeConnector);
  assert.ok(results.every(r => r.ok));
});

// ---- sanityCheckCapabilities ----
test("sanityCheckCapabilities: capability advertised + method exists -> OK", () => {
  const connector = { getFirmwareInfo: () => {} };
  const out = sanityCheckCapabilities(connector, { firmwareInfo: true });
  const entry = out.find(o => o.capability === "firmwareInfo");
  assert.equal(entry.status, "OK");
});

test("sanityCheckCapabilities: capability advertised + method missing -> CONTRACT-FAILURE", () => {
  const connector = {};
  const out = sanityCheckCapabilities(connector, { firmwareInfo: true });
  const entry = out.find(o => o.capability === "firmwareInfo");
  assert.equal(entry.status, "CONTRACT-FAILURE");
  assert.match(entry.note, /missing/);
});

test("sanityCheckCapabilities: capability not advertised + method missing -> UNSUPPORTED", () => {
  const connector = {};
  const out = sanityCheckCapabilities(connector, {});
  const entry = out.find(o => o.capability === "headMapping");
  assert.equal(entry.status, "UNSUPPORTED");
});

test("sanityCheckCapabilities: method exists but capability not advertised -> INFO, not OK (the creality-klipper applyHeadMapping case)", () => {
  // Mirrors the real creality-klipper.js shape: applyHeadMapping is exported
  // but headMapping:true is deliberately not declared.
  const connector = { applyHeadMapping: () => {} };
  const out = sanityCheckCapabilities(connector, { headMapping: false });
  const entry = out.find(o => o.capability === "headMapping");
  assert.equal(entry.status, "INFO");
  assert.match(entry.note, /not auto-tested/);
});

test("sanityCheckCapabilities: multi-method capability requires ALL methods present for OK", () => {
  const connector = { getPlate: () => {} }; // excludeObject() itself missing
  const out = sanityCheckCapabilities(connector, { excludeObject: true });
  const entry = out.find(o => o.capability === "excludeObject");
  assert.equal(entry.status, "CONTRACT-FAILURE");
  assert.match(entry.note, /excludeObject/);
});

// ---- validateBedTemp ----
test("validateBedTemp: accepts an in-range value with no maxBedTemp set", () => {
  const r = validateBedTemp("60", undefined);
  assert.equal(r.ok, true);
  assert.equal(r.value, 60);
  assert.equal(r.warn, null);
});

test("validateBedTemp: rejects non-numeric input", () => {
  const r = validateBedTemp("abc", 100);
  assert.equal(r.ok, false);
});

test(`validateBedTemp: rejects values outside the ${BED_TEMP_MIN}-${BED_TEMP_MAX} hard bound`, () => {
  assert.equal(validateBedTemp("-1", 120).ok, false);
  assert.equal(validateBedTemp("121", 120).ok, false);
  assert.equal(validateBedTemp("120", 120).ok, true);
  assert.equal(validateBedTemp("0", 120).ok, true);
});

test("validateBedTemp: warns (but still allows) exceeding the connector's own maxBedTemp", () => {
  const r = validateBedTemp("110", 100); // e.g. creality-klipper's maxBedTemp:100
  assert.equal(r.ok, true);
  assert.match(r.warn, /maxBedTemp/);
});

// ---- isIdleState ----
test("isIdleState: standby/complete/cancelled are idle, printing/paused are not", () => {
  assert.equal(isIdleState("standby"), true);
  assert.equal(isIdleState("complete"), true);
  assert.equal(isIdleState("cancelled"), true);
  assert.equal(isIdleState("printing"), false);
  assert.equal(isIdleState("paused"), false);
});

// ---- timeCall ----
test("timeCall: preserves a resolved value and measures elapsed time", async () => {
  const r = await timeCall(async () => 42);
  assert.equal(r.ok, true);
  assert.equal(r.result, 42);
  assert.equal(r.error, null);
  assert.ok(r.ms >= 0);
});

test("timeCall: preserves the real thrown error message rather than a generic one", async () => {
  const r = await timeCall(async () => { throw new Error("connect ETIMEDOUT 192.168.1.50:7125"); });
  assert.equal(r.ok, false);
  assert.match(r.error, /ETIMEDOUT/);
});

// ---- overallResult ----
test("overallResult: all PASS -> PASS", () => {
  const steps = [makeStep("probe", "PASS", 10), makeStep("upload", "PASS", 20)];
  assert.equal(overallResult(steps), "PASS");
});

test("overallResult: a SKIPPED step with no failures -> PASS WITH N SKIPPED", () => {
  const steps = [makeStep("probe", "PASS", 10), makeStep("bedTemp", "SKIPPED", null, "declined by user")];
  assert.equal(overallResult(steps), "PASS WITH 1 SKIPPED STEP");
});

test("overallResult: any FAIL -> FAILED, even alongside skips", () => {
  const steps = [makeStep("probe", "PASS", 10), makeStep("upload", "FAIL", 20, "boom"), makeStep("cancel", "SKIPPED")];
  assert.match(overallResult(steps), /^FAILED/);
});

test("overallResult: a CONTRACT-FAILURE counts as a failure", () => {
  const steps = [makeStep("core:estop", "CONTRACT-FAILURE", null, "missing")];
  assert.match(overallResult(steps), /^FAILED/);
});

test("overallResult: a declined physical confirmation (API PASS, physical FAIL) counts as a failure", () => {
  const step = makeStep("pause", "PASS", 15);
  step.physicalResult = "FAIL";
  assert.match(overallResult([step]), /^FAILED/);
});

// ---- buildReportText / sanitizeReport ----
test("buildReportText: includes connector/printer header and every step", () => {
  const meta = { connectorType: "creality-klipper", printerName: "Shop K1C", url: "http://192.168.1.50", firmware: "1.2.3" };
  const contractChecks = sanityCheckCapabilities({ getFirmwareInfo: () => {} }, { firmwareInfo: true });
  const steps = [makeStep("probe", "PASS", 126), makeStep("upload", "FAIL", 812, "connect ETIMEDOUT")];
  const text = buildReportText(meta, contractChecks, steps);
  assert.match(text, /creality-klipper/);
  assert.match(text, /Shop K1C/);
  assert.match(text, /probe/);
  assert.match(text, /upload/);
  assert.match(text, /connect ETIMEDOUT/);
  assert.match(text, /Overall: FAILED/);
});

test("sanitizeReport: redacts sensitive printer fields and never leaks them into the saved JSON", () => {
  const meta = {
    connectorType: "creality-klipper", printerName: "Shop K1C", url: "http://192.168.1.50",
    printerConfig: { name: "Shop K1C", url: "http://192.168.1.50", apiToken: "supersecret123" },
    capabilities: { firmwareInfo: true }, firmware: "1.2.3"
  };
  const report = sanitizeReport(meta, [], [makeStep("probe", "PASS", 100)]);
  assert.equal(report.printer.apiToken, "[redacted]");
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("supersecret123"));
  assert.equal(report.connectorType, "creality-klipper");
  assert.equal(report.overall, "PASS");
});

// ---- resultFileName ----
test("resultFileName: sanitizes the printer name and produces a colon-free filename", () => {
  const name = resultFileName("creality-klipper", "Shop / K1C");
  assert.match(name, /^creality-klipper-Shop_K1C-/);
  assert.ok(!name.includes(":"));
  assert.match(name, /\.json$/);
});
