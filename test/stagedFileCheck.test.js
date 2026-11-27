// test/stagedFileCheck.test.js — is a Loaded file still on the printer, the one
// SnapCon put there? (docs/TODO.md §37 P5)
//
// Before: a Loaded file was trusted until printed or ejected. Its Print was
// accepted first and checked after, by a name match anywhere on the printer;
// a file gone or changed meanwhile was started anyway (or failed on the
// printer), and a printer that could not be asked started it unchecked. The
// Loaded files were kept by the printer's place in the list, so a Settings
// reorder moved them to another printer.
//
// Now: one read at the exact name and recorded size — present, missing,
// changed or unable to verify — at startup, every 15 minutes and before a
// Print is accepted; only present is printed; nothing is deleted or re-sent;
// and the entries follow the printer's id.
//
// The code is server.js's own, run in a vm with a scripted connector.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const { loadUploadOutcomeHelpers } = require("./helpers/uploadOutcomeHelpers");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const fnSrc = marker => { const at = serverSrc.indexOf(marker); assert.ok(at >= 0, marker); return serverSrc.slice(at, at + serverSrc.slice(at).search(/\r?\n\}\r?\n/) + 3); };
const lineSrc = marker => { const at = serverSrc.indexOf(marker); assert.ok(at >= 0, marker); return serverSrc.slice(at, serverSrc.indexOf("\n", at)); };
const blockSrc = (marker, end) => { const at = serverSrc.indexOf(marker); assert.ok(at >= 0, marker); return serverSrc.slice(at, serverSrc.indexOf(end, at) + end.length); };
const routeSrc = marker => blockSrc(marker, "\n});\n");

function harness(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-staged-check-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const h = { verifyCalls: [], answer: { result: "acknowledged", basis: "size", evidence: "x" }, online: true, audits: [], started: [], probes: 0 };
  const connector = {
    verifyUpload: async (p, name, localPath, opts) => {
      h.verifyCalls.push({ printer: p.id, name, localPath, opts });
      if (h.gate) await h.gate;
      const a = typeof h.answer === "function" ? h.answer(p, name) : h.answer;
      if (a instanceof Error) throw a;
      return a;
    },
  };
  const printers = [{ id: "pA", name: "U1 A", url: "http://a", connector: "x" }, { id: "pB", name: "U1 B", url: "http://b", connector: "x" }];
  const routes = {};
  const env = {
    console: { log() {}, error() {}, warn() {} }, fs, path, JSON, Date, Math, String, Object, Number, Error, Map, Set, Promise, Array, setTimeout,
    PRINTERS: printers, JOBS: new Map(), STARTING: new Map(), queuedFile: new Map(), pendingLoad: new Map(),
    QUEUED_FILE_PATH: path.join(base, "queued-files.json"), CFG: {},
    getConnector: () => connector,
    probeCached: async () => { h.probes++; return { online: h.online, state: "standby" }; },
    printerVisibleTo: (u, p) => !(u && u.hidden && u.hidden.includes(p.id)),
    actorFromReq: () => ({ userId: "u1", userLabel: "Eran" }),
    auditLog: { log: e => { h.audits.push(e); return 1; } },
    fileTypeRefusal: () => null, getCapabilities: () => ({}), assertNotActiveJobFile: async () => {},
    printerHasAnyDefaultPref: () => false, wantsAnyPref: () => false, queueSendingRefusal: () => "queue",
    runPrintFileJob: o => { h.started.push({ file: o.filename, send: o.send }); },
    requireRegular: (req, res, next) => next(),
    app: { post: (r, ...fns) => { routes[r] = fns[fns.length - 1]; } },
  };
  vm.createContext(env);
  loadUploadOutcomeHelpers(env, serverSrc);
  vm.runInContext("let jobN = 0; const newJobId = () => 'j' + (++jobN);", env);
  for (const m of ["const STAGED_CHECK_STATES", "const STAGED_CHECK_BASES", "const STAGED_CHECK_MAP", "const stagedRowStatus", "const stagedSend",
    "const STAGED_CHECK_INTERVAL_MS", "const STAGED_CHECK_STARTUP_MS", "const STAGED_CHECK_FRESH_MS", "let stagedSweepRunning", "const STAGED_MANUAL_MIN_MS", "const stagedManualAt"]) vm.runInContext(lineSrc(m), env);
  vm.runInContext(blockSrc("const STAGED_REFUSAL = {", "\n};\n"), env);
  for (const m of ["function checkToolMap(", "function stagedChoices(", "async function checkStagedCopy(", "function noteStagedCheck(", "async function sweepStagedFiles(", "function saveQueuedFiles(", "function loadQueuedFiles(",
    "function otherSendInFlight(", "function queueDispatchJob("]) vm.runInContext(fnSrc(m), env);
  for (const r of ['app.post("/api/printctl"', 'app.post("/api/printfile"', 'app.post("/api/staged-file/dismiss"', 'app.post("/api/staged-file/check"']) vm.runInContext(routeSrc(r), env);
  vm.runInContext("this.stagedRowStatus = stagedRowStatus; this.stagedSend = stagedSend; this.STAGED_CHECK_INTERVAL_MS = STAGED_CHECK_INTERVAL_MS; this.STAGED_CHECK_STARTUP_MS = STAGED_CHECK_STARTUP_MS; this.stagedManualAt = stagedManualAt;", env);
  h.env = env; h.printers = printers; h.connector = connector;
  h.call = async (r, body, user = { id: "u1", role: "regular" }) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[r]({ user, body }, res);
    return res;
  };
  h.stage = (id, extra = {}) => env.queuedFile.set(id, { name: "Part.gcode", status: "ready", ts: 1, plate: null, send: { plate: null, location: "gcode:Part.gcode", library: { variantKey: "v1" } }, size: 1234, sizeOf: "file", verification: "verified", verifiedAt: 1, ...extra });
  // The card's Print of its Loaded file says so (loaded), as printQueuedFile does.
  h.print = (printer = 0, filename = "Part.gcode", extra = { loaded: true }) => h.call("/api/printfile", { printer, filename, map: {}, prefs: {}, ...extra });
  return h;
}

// ---- what one check says ----

test("the check reads the exact name, held to the recorded size, without the local file, once", async t => {
  const h = harness(t);
  h.stage("pA");
  const c = await h.env.checkStagedCopy(h.printers[0], h.connector, h.env.queuedFile.get("pA"));
  assert.equal(c.state, "present");
  assert.equal(c.basis, "size");
  assert.deepEqual({ ...h.verifyCalls[0], opts: { ...h.verifyCalls[0].opts } }, { printer: "pA", name: "Part.gcode", localPath: null, opts: { attempts: 1, localSize: 1234 } });
});

test("present by name only is never described as a size or content check; missing, changed and unable to verify are kept apart", async t => {
  const h = harness(t);
  h.stage("pA");
  const staged = h.env.queuedFile.get("pA");
  const cases = [
    [{ result: "acknowledged", basis: "name", evidence: "x" }, "present", "name"],
    [{ result: "verified", basis: "content", evidence: "x" }, "present", "name"],   // a later check never claims content
    [{ result: "absent", evidence: "x" }, "missing", null],
    [{ result: "mismatch", basis: "size", evidence: "x" }, "changed", null],
    [{ result: "unverifiable", evidence: "x" }, "unverifiable", null],
    [new Error("socket hang up"), "unverifiable", null],
  ];
  for (const [answer, state, basis] of cases) {
    h.answer = answer;
    const c = await h.env.checkStagedCopy(h.printers[0], h.connector, staged);
    assert.deepEqual([c.state, c.basis], [state, basis], JSON.stringify(answer.result || answer.message));
  }
  delete h.connector.verifyUpload;
  assert.equal((await h.env.checkStagedCopy(h.printers[0], h.connector, staged)).state, "unverifiable");
});

// ---- Print of the Loaded file: checked before it is accepted ----

test("Print: present is accepted and started, with the send recorded as checked by size", async t => {
  const h = harness(t);
  h.stage("pA");
  const r = await h.print();
  assert.equal(r.code, 200);
  assert.ok(r.body.jobId);
  assert.equal(h.started.length, 1);
  assert.equal(h.started[0].send.copyChecked, true);
  assert.equal(h.env.queuedFile.get("pA").check.state, "present");
});

// §38: the upload sent nothing, so the Print sends what was chosen with it.
function printWithChoices(t) {
  const h = harness(t);
  h.connector.applyHeadMapping = async () => {};
  h.jobs = [];
  h.env.runPrintFileJob = o => { h.jobs.push(o); };
  return h;
}
test("Print of the Loaded file: the map and options chosen with its upload are the ones sent", async t => {
  const h = printWithChoices(t);
  h.stage("pA", { map: { 0: 2, 1: 0 }, prefs: { autoLevel: true } });
  // As printQueuedFile: an empty map, and no options unless the dialog gave some.
  await h.call("/api/printfile", { printer: 0, filename: "Part.gcode", map: {}, loaded: true });
  const j = h.jobs[0];
  assert.equal(j.needsMapping, true);
  assert.deepEqual([...j.tools], [0, 1]);
  assert.deepEqual({ ...j.map }, { 0: 2, 1: 0 });
  assert.deepEqual({ ...j.prefs }, { autoLevel: true });
});
test("Print of the Loaded file: a map or options given with the Print win over what was kept", async t => {
  const h = printWithChoices(t);
  h.stage("pA", { map: { 0: 2 }, prefs: { autoLevel: true } });
  await h.call("/api/printfile", { printer: 0, filename: "Part.gcode", map: { 0: 1 }, prefs: { autoLevel: false }, loaded: true });
  assert.deepEqual({ ...h.jobs[0].map }, { 0: 1 });
  assert.deepEqual({ ...h.jobs[0].prefs }, { autoLevel: false });
});
test("Print of the Loaded file: option by option, the request, then what was kept; anything else is left to the printer's default", async t => {
  const h = printWithChoices(t);
  h.stage("pA", { prefs: { autoLevel: true } });
  await h.call("/api/printfile", { printer: 0, filename: "Part.gcode", map: {}, prefs: { timelapse: false }, loaded: true });
  assert.deepEqual({ ...h.jobs[0].prefs }, { autoLevel: true, timelapse: false });
  assert.equal(h.jobs[0].prefs.flowCalibrate, undefined, "the connector falls back to the printer's default");
});
test("what was kept survives a restart and is used by the Print", async t => {
  const h = printWithChoices(t);
  h.stage("pA", { map: { 0: 2 }, prefs: { timelapse: true } });
  h.env.saveQueuedFiles();
  h.env.queuedFile.clear();
  h.env.loadQueuedFiles();
  await h.call("/api/printfile", { printer: 0, filename: "Part.gcode", map: {}, loaded: true });
  assert.deepEqual({ ...h.jobs[0].map }, { 0: 2 });
  assert.deepEqual({ ...h.jobs[0].prefs }, { timelapse: true });
});
test("a Loaded file's map is never applied to another file", async t => {
  const h = printWithChoices(t);
  h.stage("pA", { map: { 0: 2 }, prefs: { autoLevel: true } });
  await h.call("/api/printfile", { printer: 0, filename: "Other.gcode", map: {}, loaded: true });
  assert.deepEqual([...h.jobs[0].tools], []);
  assert.equal(h.jobs[0].prefs, undefined);
  assert.equal(h.env.queuedFile.get("pA").name, "Part.gcode", "and the Loaded file keeps its own");
});
test("dismissed, nothing is left: a later Print of that name uses nothing that was kept", async t => {
  const h = printWithChoices(t);
  h.stage("pA", { map: { 0: 2 }, check: { state: "missing", at: 1 } });
  assert.equal((await h.call("/api/staged-file/dismiss", { printer: 0 })).code, 200);
  await h.call("/api/printfile", { printer: 0, filename: "Part.gcode", map: {}, loaded: true });
  assert.deepEqual([...h.jobs[0].tools], []);
});
test("ejected, nothing is left: a later Print of that name uses nothing that was kept", async t => {
  const h = printWithChoices(t);
  h.connector.eject = async () => {};
  h.stage("pA", { map: { 0: 2 }, prefs: { autoLevel: true } });
  assert.equal((await h.call("/api/printctl", { printer: 0, action: "eject" })).code, 200);
  await h.call("/api/printfile", { printer: 0, filename: "Part.gcode", map: {}, loaded: true });
  assert.deepEqual([...h.jobs[0].tools], []);
  assert.equal(h.jobs[0].prefs, undefined);
});
// A map someone chose that cannot be read stops the Print: it must not go ahead
// on the printer's own mapping. A record that never had one prints as ever.
const saved = (h, entry) => {
  fs.writeFileSync(h.env.QUEUED_FILE_PATH, JSON.stringify({ pA: { name: "Part.gcode", ts: 1, size: 1234, sizeOf: "file", ...entry } }));
  h.env.queuedFile.clear();
  h.env.loadQueuedFiles();
};
test("a saved map that cannot be read: the card's Print is refused, saying why, and nothing starts", async t => {
  const h = printWithChoices(t);
  for (const map of [{ 0: "1\nM112" }, { 0: 99 }, "123", [1], null]) {
    saved(h, { map });
    const r = await h.call("/api/printfile", { printer: 0, filename: "Part.gcode", map: {}, loaded: true });
    assert.equal(r.code, 409, JSON.stringify(map));
    assert.equal(r.body.code, "staged_bad_map");
    assert.match(r.body.error, /could not be read, so it was not printed/);
    assert.equal(h.jobs.length, 0);
    assert.equal(h.verifyCalls.length, 0, "the printer was not even asked");
    assert.equal(h.env.queuedFile.get("pA").name, "Part.gcode", "the Loaded file stays, for a person to deal with");
  }
});
test("still refused after another restart: the mark is saved", async t => {
  const h = printWithChoices(t);
  saved(h, { map: { 0: 99 } });
  h.env.saveQueuedFiles();
  h.env.queuedFile.clear();
  h.env.loadQueuedFiles();
  assert.equal((await h.call("/api/printfile", { printer: 0, filename: "Part.gcode", map: {}, loaded: true })).body.code, "staged_bad_map");
});
test("a record that never had a map, or had an empty one, prints as before", async t => {
  for (const entry of [{}, { map: {} }]) {
    const h = printWithChoices(t);
    saved(h, entry);
    assert.equal((await h.call("/api/printfile", { printer: 0, filename: "Part.gcode", map: {}, loaded: true })).code, 200);
    assert.equal(h.jobs.length, 1);
  }
});
test("a good map given with the Print replaces the unreadable one; a Print from the file list never looks at it", async t => {
  const h = printWithChoices(t);
  saved(h, { map: { 0: 99 } });
  assert.equal((await h.call("/api/printfile", { printer: 0, filename: "Part.gcode", map: { 0: 1 }, loaded: true })).code, 200);
  assert.deepEqual({ ...h.jobs[0].map }, { 0: 1 });
  const fromList = printWithChoices(t);
  saved(fromList, { map: { 0: 99 } });
  assert.equal((await fromList.call("/api/printfile", { printer: 0, filename: "Part.gcode", map: {} })).code, 200);
  assert.deepEqual([...fromList.jobs[0].tools], []);
});
test("ejecting clears the unreadable map", async t => {
  const h = printWithChoices(t);
  h.connector.eject = async () => {};
  saved(h, { map: { 0: 99 } });
  await h.call("/api/printctl", { printer: 0, action: "eject" });
  assert.equal((await h.call("/api/printfile", { printer: 0, filename: "Part.gcode", map: {}, loaded: true })).code, 200);
});
test("the fleet row and the Print dialog show the options kept, for that Loaded file only", () => {
  assert.match(serverSrc, /row\.queuedFile = \{[^}]*\.\.\.\(qf\.prefs \? \{ prefs: qf\.prefs \} : \{\}\)/);
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(app, /mode==="queued"&&loaded&&qf&&qf\.name===queuedName&&qf\.prefs/);
});
test("Print of the Loaded file with nothing kept: the printer's defaults still decide, as before", async t => {
  const h = printWithChoices(t);
  h.env.printerHasAnyDefaultPref = () => true;
  h.stage("pA");
  await h.call("/api/printfile", { printer: 0, filename: "Part.gcode", map: {}, loaded: true });
  assert.equal(h.jobs[0].needsMapping, true, "the start still sends the printer's options");
  assert.deepEqual([...h.jobs[0].tools], []);
  assert.equal(h.jobs[0].prefs, undefined);
});
test("a Print from the printer's file list does not use what the Loaded file of that name keeps", async t => {
  const h = printWithChoices(t);
  h.stage("pA", { map: { 0: 2 }, prefs: { autoLevel: true } });
  await h.call("/api/printfile", { printer: 0, filename: "Part.gcode", map: {} });
  assert.deepEqual([...h.jobs[0].tools], []);
  assert.equal(h.jobs[0].prefs, undefined);
  assert.equal(h.jobs[0].needsMapping, false);
});

test("Print: missing, changed and unable to verify are refused before anything is accepted, saying why; nothing starts", async t => {
  for (const [answer, code, re] of [
    [{ result: "absent", evidence: "x" }, "staged_missing", /no longer on U1 A/],
    [{ result: "mismatch", basis: "size", evidence: "x" }, "staged_changed", /has changed since SnapCon sent it/],
    [{ result: "unverifiable", evidence: "x" }, "staged_unverifiable", /could not check Part\.gcode on U1 A/],
    [new Error("ETIMEDOUT"), "staged_unverifiable", /could not check/],
  ]) {
    const h = harness(t);
    h.stage("pA");
    h.answer = answer;
    const r = await h.print();
    assert.equal(r.code, 409, code);
    assert.equal(r.body.code, code);
    assert.match(r.body.error, re);
    assert.equal(r.body.jobId, undefined, "no job was accepted");
    assert.equal(h.started.length, 0);
    assert.equal(h.env.JOBS.size, 0);
    assert.equal(h.env.queuedFile.get("pA").check.state, code.replace("staged_", ""), "the card shows it too");
    assert.ok(h.env.queuedFile.has("pA"), "never deleted by the check");
  }
});

test("Print of a printer file SnapCon did not stage is not checked (nothing to hold it to)", async t => {
  const h = harness(t);
  h.stage("pA");
  const r = await h.print(0, "Other.gcode");
  assert.equal(r.code, 200);
  assert.equal(h.verifyCalls.length, 0);
});

test("Print: a missing file found again (put back on the printer) prints again", async t => {
  const h = harness(t);
  h.stage("pA", { check: { state: "missing", at: 1, basis: null } });
  assert.equal((await h.print()).code, 200);
  assert.equal(h.env.queuedFile.get("pA").check.state, "present");
});

// ---- the scheduled check ----

test("the sweep checks every online Loaded printer once, one at a time, and records what it found", async t => {
  const h = harness(t);
  h.stage("pA"); h.stage("pB");
  let inFlight = 0, most = 0;
  h.connector.verifyUpload = async (p) => { inFlight++; most = Math.max(most, inFlight); await new Promise(r => setTimeout(r, 5)); inFlight--; return p.id === "pB" ? { result: "absent", evidence: "x" } : { result: "acknowledged", basis: "size", evidence: "x" }; };
  const out = await h.env.sweepStagedFiles();
  assert.deepEqual([...out.checked], ["pA", "pB"]);
  assert.equal(most, 1, "never two printers at once");
  assert.equal(h.env.queuedFile.get("pA").check.state, "present");
  assert.equal(h.env.queuedFile.get("pB").check.state, "missing");
  assert.equal(h.env.stagedRowStatus(h.env.queuedFile.get("pB")), "missing", "no longer Loaded to the page");
  assert.equal(h.env.stagedRowStatus(h.env.queuedFile.get("pA")), "ready");
});

test("the sweep never overlaps itself", { timeout: 5000 }, async t => {
  const h = harness(t);
  h.stage("pA");
  let open; h.gate = new Promise(r => { open = r; });
  const first = h.env.sweepStagedFiles();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual({ ...(await h.env.sweepStagedFiles()) }, { skipped: "running" });
  open(); await first;
  assert.equal(h.verifyCalls.length, 1);
});

test("an offline printer is not asked and its file is not declared missing; a failed read is 'unable to verify', not missing", async t => {
  const h = harness(t);
  h.stage("pA");
  h.online = false;
  await h.env.sweepStagedFiles();
  assert.equal(h.verifyCalls.length, 0);
  assert.equal(h.env.queuedFile.get("pA").check, undefined, "left as it was");
  h.online = true;
  h.answer = new Error("ECONNRESET");
  await h.env.sweepStagedFiles();
  assert.equal(h.env.queuedFile.get("pA").check.state, "unverifiable");
  assert.equal(h.env.stagedRowStatus(h.env.queuedFile.get("pA")), "ready", "still shown as Loaded, with its warning");
});

test("the sweep leaves a printer alone while a send or start runs on it, while it was checked a moment ago, and once a file is found gone or changed", async t => {
  const h = harness(t);
  h.stage("pA");
  h.env.JOBS.set("j", { printerId: "pA", done: false });            // an upload or start on this printer
  await h.env.sweepStagedFiles();
  h.env.JOBS.clear();
  h.env.STARTING.set("pA", true);
  await h.env.sweepStagedFiles();
  h.env.STARTING.clear();
  assert.equal(h.verifyCalls.length, 0, "busy: not asked");
  h.env.queuedFile.get("pA").check = { state: "present", at: Date.now(), basis: "size" };
  await h.env.sweepStagedFiles();
  assert.equal(h.verifyCalls.length, 0, "fresh: not asked again");
  for (const state of ["missing", "changed"]) {
    h.env.queuedFile.get("pA").check = { state, at: 1, basis: null };
    await h.env.sweepStagedFiles();
  }
  assert.equal(h.verifyCalls.length, 0, "found gone or changed: not asked again");
  h.env.queuedFile.get("pA").check = { state: "present", at: 1, basis: "size" };
  await h.env.sweepStagedFiles();
  assert.equal(h.verifyCalls.length, 1, "an old check is renewed");
});

test("the sweep runs a minute after startup and then every 15 minutes, and never stops the process exiting", () => {
  assert.equal(serverSrc.match(/const STAGED_CHECK_INTERVAL_MS = (.+);/)[1], "15 * 60 * 1000");
  assert.equal(serverSrc.match(/const STAGED_CHECK_STARTUP_MS = (.+);/)[1], "60 * 1000");
  assert.match(serverSrc, /setTimeout\(\(\) => \{ sweepStagedFiles\(\)\.catch\([^)]*\)[^;]*; \}, STAGED_CHECK_STARTUP_MS\)\.unref\(\);/);
  assert.match(serverSrc, /setInterval\(\(\) => \{ sweepStagedFiles\(\)\.catch\([^)]*\)[^;]*; \}, STAGED_CHECK_INTERVAL_MS\)\.unref\(\);/);
});

// ---- Dismiss and Check again ----

test("Dismiss forgets a missing, changed or unverifiable file (never the printer's copy), and refuses a file still ready", async t => {
  for (const state of ["missing", "changed", "unverifiable"]) {
    const h = harness(t);
    h.stage("pA", { check: { state, at: 1, basis: null } });
    h.env.saveQueuedFiles();
    assert.ok(JSON.parse(fs.readFileSync(h.env.QUEUED_FILE_PATH, "utf8")).pA, "saved before");
    const r = await h.call("/api/staged-file/dismiss", { printer: 0, name: "Part.gcode" });
    assert.equal(r.code, 200, state);
    assert.equal(h.env.queuedFile.has("pA"), false);
    assert.equal(JSON.parse(fs.readFileSync(h.env.QUEUED_FILE_PATH, "utf8")).pA, undefined, "and gone after a restart");
    assert.equal(h.verifyCalls.length, 0, "the printer is not asked, let alone told to delete");
    assert.equal(h.audits[0].event, "staged-file-dismissed");
  }
  const h = harness(t);
  h.stage("pA", { check: { state: "present", at: 1, basis: "size" } });
  assert.equal((await h.call("/api/staged-file/dismiss", { printer: 0 })).code, 409);
  h.stage("pA");
  assert.equal((await h.call("/api/staged-file/dismiss", { printer: 0 })).code, 409, "an unchecked Loaded file is ejected, not dismissed");
  h.env.queuedFile.set("pA", { name: "Part.gcode", status: "error", error: "x", ts: 1 });
  assert.equal((await h.call("/api/staged-file/dismiss", { printer: 0, name: "Other.gcode" })).code, 404, "only the file the page showed");
  assert.equal((await h.call("/api/staged-file/dismiss", { printer: 0, name: "Part.gcode" })).code, 200, "a deferred send's error too");
});

test("Dismiss and Check again keep to the printer's visibility", async t => {
  const h = harness(t);
  h.stage("pA", { check: { state: "missing", at: 1, basis: null } });
  const hidden = { id: "u2", role: "regular", hidden: ["pA"] };
  assert.equal((await h.call("/api/staged-file/dismiss", { printer: 0 }, hidden)).code, 403);
  assert.equal((await h.call("/api/staged-file/check", { printer: 0 }, hidden)).code, 403);
  assert.ok(h.env.queuedFile.has("pA"));
});

test("Check again asks once, records the answer, and not more than once a minute per printer", async t => {
  const h = harness(t);
  h.stage("pA", { check: { state: "unverifiable", at: 1, basis: null } });
  const r = await h.call("/api/staged-file/check", { printer: 0 });
  assert.equal(r.code, 200);
  assert.equal(r.body.check.state, "present");
  assert.equal(h.env.queuedFile.get("pA").check.state, "present");
  assert.equal((await h.call("/api/staged-file/check", { printer: 0 })).code, 429);
  assert.equal(h.verifyCalls.length, 1);
  h.stage("pB");
  assert.equal((await h.call("/api/staged-file/check", { printer: 1 })).code, 200, "another printer has its own minute");
});

// ---- printer ids, not places in the list ----

test("a Loaded file stays with its printer when the printers are reordered", async t => {
  const h = harness(t);
  h.stage("pA");
  h.printers.reverse();                                            // a Settings save reordered them
  assert.equal(h.printers[1].id, "pA");
  assert.equal(h.env.queuedFile.get("pB"), undefined, "the other printer did not inherit it");
  assert.equal((await h.print(1)).code, 200, "Print from its own card, now second in the list");
  assert.equal(h.verifyCalls[0].printer, "pA");
  h.stage("pA");
  assert.equal((await h.print(0)).code, 200);
  assert.equal(h.verifyCalls.length, 1, "printer pB's card has no Loaded file, so nothing was checked for it");
});

test("restored at startup by printer id, check included; a printer removed is not written; re-added it is checked again before any Print", async t => {
  const h = harness(t);
  h.stage("pB", { check: { state: "present", at: 5, basis: "size", evidence: "x" } });
  h.env.saveQueuedFiles();
  h.env.queuedFile.clear();
  h.printers.reverse();                                            // order differs at startup
  h.env.loadQueuedFiles();
  const back = h.env.queuedFile.get("pB");
  assert.equal(back.name, "Part.gcode");
  assert.deepEqual({ ...back.check }, { state: "present", at: 5, basis: "size", evidence: "x" });
  assert.equal(h.env.queuedFile.get("pA"), undefined);
  // Removed in Settings, then saved: not written, so gone after a restart.
  const removed = h.printers.splice(h.printers.findIndex(p => p.id === "pB"), 1)[0];
  h.env.saveQueuedFiles();
  assert.equal(JSON.parse(fs.readFileSync(h.env.QUEUED_FILE_PATH, "utf8")).pB, undefined);
  // Re-added in the same run: its entry is still known, and a Print checks it first.
  h.printers.push(removed);
  h.answer = { result: "absent", evidence: "x" };
  assert.equal((await h.print(h.printers.indexOf(removed))).code, 409);
});

test("a stored check that is malformed or unknown is not trusted", async t => {
  const h = harness(t);
  fs.writeFileSync(h.env.QUEUED_FILE_PATH, JSON.stringify({ pA: { name: "Part.gcode", ts: 1, check: { state: "present", at: 1, basis: "content" } } }));
  h.env.loadQueuedFiles();
  assert.equal(h.env.queuedFile.get("pA").check.basis, null, "a later check never claims content");
  for (const check of [{ state: "fine", at: 1 }, { state: "present" }, { state: "present", at: "soon" }, "present"]) {
    fs.writeFileSync(h.env.QUEUED_FILE_PATH, JSON.stringify({ pA: { name: "Part.gcode", ts: 1, check } }));
    h.env.queuedFile.clear();
    h.env.loadQueuedFiles();
    assert.equal(h.env.queuedFile.get("pA").check, undefined, JSON.stringify(check));
  }
});

test("the queue's other-send guard and every route find the Loaded file by printer id", () => {
  assert.match(fnSrc("function otherSendInFlight("), /queuedFile\.get\(p\.id\)/);
  assert.doesNotMatch(serverSrc, /queuedFile\.(get|set|has|delete)\((printer|idx|i|printerKey|PRINTERS\.indexOf)/);
});

test("an unverifiable Print says why, from what the check found", async t => {
  const h = harness(t);
  h.stage("pA");
  h.answer = { result: "unverifiable", evidence: "the printer lists only its 10 newest files, and Part.gcode is not among them" };
  const r = await h.print();
  assert.equal(r.code, 409);
  assert.match(r.body.error, /\(the printer lists only its 10 newest files, and Part\.gcode is not among them\)/);
  assert.doesNotMatch(r.body.error, /online/, "not blamed on the printer being offline");
});

// The owner's reading of the review (2026-10-28): only the card's Print of its
// Loaded file is checked and refused; a Print from the printer's file list is
// a separate operation that does not inherit the Loaded record at all.
test("same name, different content on the printer: the Loaded card's Print is refused; a file-list Print of it starts, without the Loaded record", async t => {
  const card = harness(t);
  card.stage("pA");
  card.answer = { result: "mismatch", basis: "size", evidence: "the printer's Part.gcode is 999 bytes, 1234 were sent" };
  const refused = await card.print(0, "Part.gcode");
  assert.equal(refused.code, 409);
  assert.equal(refused.body.code, "staged_changed");
  assert.equal(card.started.length, 0);

  const browser = harness(t);
  browser.stage("pA", { plate: 3, check: { state: "present", at: 7, basis: "size" } });
  browser.answer = { result: "mismatch", basis: "size", evidence: "x" };
  const r = await browser.print(0, "Part.gcode", {});
  assert.equal(r.code, 200);
  assert.equal(browser.verifyCalls.length, 0, "the Loaded record is not consulted, so nothing is checked for it");
  assert.equal(browser.started.length, 1);
  assert.equal(browser.started[0].send, null, "no Library send inherited");
  assert.deepEqual({ ...browser.env.queuedFile.get("pA").check }, { state: "present", at: 7, basis: "size" }, "nor is its freshness changed");
});

test("a file-list Print never inherits the Loaded record's plate or Library link, even when it is SnapCon's copy", async t => {
  const h = harness(t);
  h.stage("pA", { plate: 3 });
  h.env.runPrintFileJob = o => { h.started.push({ file: o.filename, send: o.send, plate: o.plate }); };
  assert.equal((await h.print(0, "Part.gcode", {})).code, 200);
  assert.deepEqual({ ...h.started[0] }, { file: "Part.gcode", send: null, plate: null });
  assert.equal(h.verifyCalls.length, 0);
  // That start has finished (the stand-in does not end its job; since §37 P3
  // a start still running holds the printer).
  for (const j of h.env.JOBS.values()) j.done = true;
  // The card's Print of the same file: checked, and it carries both.
  assert.equal((await h.print(0, "Part.gcode")).code, 200);
  assert.equal(h.started[1].plate, 3);
  assert.equal(h.started[1].send.library.variantKey, "v1");
  assert.equal(h.verifyCalls.length, 1);
});

test("only an explicit loaded:true is the Loaded file's Print", async t => {
  for (const loaded of [undefined, false, "true", 1]) {
    const h = harness(t);
    h.stage("pA");
    h.answer = { result: "absent", evidence: "x" };
    assert.equal((await h.print(0, "Part.gcode", loaded === undefined ? {} : { loaded })).code, 200, String(loaded));
    assert.equal(h.verifyCalls.length, 0);
  }
});

test("the page marks only the card's Loaded-file Print as loaded; Reprint and the file list do not", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(app, /async function printQueuedFile\(printerId, filename, prefs, \{loaded=true\}=\{\}\)/);
  assert.match(app, /postJSON\("\/api\/printfile",\{printer:printerId,filename,map:\{\},prefs,loaded\}\)/);
  assert.match(app, /openQuickPrintModal\(printerId,'queued',p\.filename,\{loaded:false\}\);\s+else printQueuedFile\(printerId,p\.filename,undefined,\{loaded:false\}\);/, "Reprint");
  assert.match(app, /postJSON\("\/api\/printfile",\{printer:PFILE_PRINTER,filename:PFILE_SELECTED,map:[^}]*\},prefs:PFILE_PREFS\}\)/, "the file list sends no loaded flag");
});

test("an older check that finishes after a newer one does not replace it; a check only rewrites the file when what it found changes", async t => {
  const h = harness(t);
  h.stage("pA");
  const staged = h.env.queuedFile.get("pA");
  h.env.noteStagedCheck(h.printers[0], staged, { state: "present", at: 200, basis: "size", evidence: null });
  h.env.noteStagedCheck(h.printers[0], staged, { state: "unverifiable", at: 100, basis: null, evidence: "slow, started earlier" });
  assert.equal(staged.check.state, "present");
  const writes = () => fs.statSync(h.env.QUEUED_FILE_PATH).mtimeMs;
  const first = writes();
  fs.utimesSync(h.env.QUEUED_FILE_PATH, new Date(1000), new Date(1000));
  h.env.noteStagedCheck(h.printers[0], staged, { state: "present", at: 300, basis: "size", evidence: null });
  assert.equal(writes(), 1000, "a renewed present is not written");
  assert.equal(staged.check.at, 300, "but kept in memory");
  h.env.noteStagedCheck(h.printers[0], staged, { state: "missing", at: 400, basis: null, evidence: null });
  assert.notEqual(writes(), 1000, "a change is written");
  assert.ok(first > 0);
});

// ---- from the P5 test review ----
test("a check still in flight when the Loaded file is replaced, or turns to an error, is not recorded on it", { timeout: 5000 }, async t => {
  for (const replace of [h => h.stage("pA", { ts: 2 }), h => h.env.queuedFile.set("pA", { name: "Part.gcode", status: "error", error: "x", ts: 2 })]) {
    const h = harness(t);
    h.stage("pA");
    h.answer = { result: "mismatch", basis: "size", evidence: "x" };
    let open; h.gate = new Promise(r => { open = r; });
    const sweep = h.env.sweepStagedFiles();
    await new Promise(r => setTimeout(r, 5));
    replace(h);
    open(); await sweep;
    assert.equal(h.env.queuedFile.get("pA").check, undefined, "the new file does not get the old answer");
  }
});

test("the sweep leaves a printer alone while the queue is sending to it", async t => {
  const h = harness(t);
  h.stage("pA");
  h.env.JOBS.set("q", { queueItemId: "qi", printerId: "pA", done: false });
  await h.env.sweepStagedFiles();
  assert.equal(h.verifyCalls.length, 0);
});

test("Check again has nothing to check when no file is Loaded, or it is still going out or failed", async t => {
  const h = harness(t);
  assert.equal((await h.call("/api/staged-file/check", { printer: 0 })).code, 404);
  for (const status of ["uploading", "error"]) {
    h.env.queuedFile.set("pA", { name: "Part.gcode", status, ts: 1 });
    h.env.stagedManualAt.clear();
    assert.equal((await h.call("/api/staged-file/check", { printer: 0 })).code, 404, status);
  }
  assert.equal(h.verifyCalls.length, 0);
});

test("a Print whose check overlaps the queue claiming the printer is refused, nothing started", { timeout: 5000 }, async t => {
  const h = harness(t);
  h.stage("pA");
  let open; h.gate = new Promise(r => { open = r; });
  const printing = h.print();
  await new Promise(r => setTimeout(r, 5));
  h.env.JOBS.set("q", { queueItemId: "qi", printerId: "pA", done: false });
  open();
  const r = await printing;
  assert.equal(r.code, 409);
  assert.equal(h.started.length, 0);
});

test("a check is written when its basis changes, not only its state", async t => {
  const h = harness(t);
  h.stage("pA");
  const staged = h.env.queuedFile.get("pA");
  h.env.noteStagedCheck(h.printers[0], staged, { state: "present", at: 1, basis: "name", evidence: null });
  fs.utimesSync(h.env.QUEUED_FILE_PATH, new Date(1000), new Date(1000));
  h.env.noteStagedCheck(h.printers[0], staged, { state: "present", at: 2, basis: "size", evidence: null });
  assert.notEqual(fs.statSync(h.env.QUEUED_FILE_PATH).mtimeMs, 1000);
});

test("two real checks that overlap: the one that started later wins, whichever finishes first", { timeout: 5000 }, async t => {
  const h = harness(t);
  h.stage("pA");
  const staged = h.env.queuedFile.get("pA");
  let openOld; const oldGate = new Promise(r => { openOld = r; });
  let n = 0;
  h.connector.verifyUpload = async () => (++n === 1 ? (await oldGate, { result: "unverifiable", evidence: "slow" }) : { result: "acknowledged", basis: "size", evidence: "x" });
  const older = h.env.checkStagedCopy(h.printers[0], h.connector, staged);
  await new Promise(r => setTimeout(r, 5));
  h.env.noteStagedCheck(h.printers[0], staged, await h.env.checkStagedCopy(h.printers[0], h.connector, staged));
  openOld();
  h.env.noteStagedCheck(h.printers[0], staged, await older);
  assert.equal(staged.check.state, "present");
});

test("the Dismiss and Check again routes need a Regular user, like every other printer action", () => {
  assert.match(serverSrc, /app\.post\("\/api\/staged-file\/dismiss", requireRegular,/);
  assert.match(serverSrc, /app\.post\("\/api\/staged-file\/check", requireRegular,/);
});

// §37 P3: the card's Print respects the one per-printer lock.
test("P3: the card's Print is refused while another file is going to that printer", async t => {
  const h = harness(t);
  h.stage("pA");
  h.env.JOBS.set("d", { printerId: "pA", done: false, file: "Waiting.gcode", deferredId: "dsend_x" });
  const r = await h.print();
  assert.equal(r.code, 409);
  assert.equal(r.body.code, "printer_receiving");
  assert.equal(h.started.length, 0);
});
