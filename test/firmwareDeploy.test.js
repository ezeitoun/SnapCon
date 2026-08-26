// test/firmwareDeploy.test.js — the guard rails around POST /api/firmware-deploy.
//
// Flashing is the most consequential thing SnapCon can do to a printer, and a
// U1 trusts anything on its LAN: /access/info returns trusted:true with no key,
// no token and no pairing (see connectors/snapmaker-u1-firmware.js's SECURITY
// note). Nothing about that is SnapCon's to fix — what IS SnapCon's job is not
// being the thing that makes it easy to trigger by accident. These tests pin
// the three properties that provide that: admin only, the file must come from
// the configured firmware folder, and a printer mid-print is refused.
//
// server.js cannot be required (it starts a listener — the constraint
// test/pathSafety.test.js and test/firmwareFiles.test.js both document), so the
// containment rule is exercised directly against the shared jail the route
// uses, and the route's wiring is asserted against its source text. The
// connector module CAN be required and its own precondition is tested for real.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveWithinFolder, isPathWithinFolder } = require("../pathSafety");
const u1fw = require("../connectors/snapmaker-u1-firmware");

const ROOT = path.join(os.tmpdir(), "snapcon-fwdeploy-test", "firmware");
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const resolverSrc = (() => {
  const i = serverSrc.indexOf("function resolveFirmwareFile(relRaw) {");
  assert.ok(i > 0, "the shared resolver must exist");
  return serverSrc.slice(i, serverSrc.indexOf("async function firmwareDeployBlockedBy", i));
})();
const blockedSrc = (() => {
  const i = serverSrc.indexOf("async function firmwareDeployBlockedBy(p) {");
  assert.ok(i > 0, "the shared state check must exist");
  return serverSrc.slice(i, serverSrc.indexOf("\n}", i));
})();
const routeSrc = (() => {
  const i = serverSrc.indexOf('app.post("/api/firmware-deploy"');
  assert.ok(i > 0, "the deploy route must exist");
  return serverSrc.slice(i, serverSrc.indexOf('\napp.get("/api/firmware-deploy-status"', i));
})();

// ---------------------------------------------------------------------------
// Containment — the same jail, for the same reason, as the listing route
// ---------------------------------------------------------------------------

test("a relative path escaping the firmware folder is rejected", () => {
  assert.equal(resolveWithinFolder("../evil.bin", ROOT), null);
  assert.equal(resolveWithinFolder("K1C/../../evil.bin", ROOT), null);
  assert.equal(resolveWithinFolder("..", ROOT), null);
  // and the sibling-prefix escape CODE_AUDIT.md P1-1 reported
  assert.equal(isPathWithinFolder(ROOT + "-backup/evil.bin", ROOT), false);
});

test("a legitimate nested path is accepted", () => {
  assert.equal(resolveWithinFolder("U1/1.6.0.267.bin", ROOT), path.join(ROOT, "U1", "1.6.0.267.bin"));
});

test("an absolute path from the browser is rejected outright, before the jail", () => {
  // Belt and braces: path.isAbsolute() refuses it as a contract violation, and
  // resolveWithinFolder would refuse it again. The explicit check is what makes
  // the contract ("relative to the firmware folder") enforced rather than
  // merely implied.
  assert.match(resolverSrc, /if \(!relRaw \|\| path\.isAbsolute\(relRaw\)\) return \{ status: 400, error: "Invalid path" \};/);
  const absIdx = resolverSrc.indexOf("path.isAbsolute(relRaw)");
  const jailIdx = resolverSrc.indexOf("resolveWithinFolder(relRaw, root)");
  assert.ok(absIdx > 0 && jailIdx > absIdx, "the absolute-path refusal comes first");
  assert.equal(resolveWithinFolder(path.join(os.tmpdir(), "elsewhere", "evil.bin"), ROOT), null);
});

test("the jail is anchored on the configured folder resolved against BASE_DIR", () => {
  assert.match(resolverSrc, /const root = path\.resolve\(BASE_DIR, configured\);/);
  assert.match(resolverSrc, /const file = resolveWithinFolder\(relRaw, root\);/);
  assert.match(resolverSrc, /if \(!configured\) return \{ status: 400, error: "No firmware folder is configured" \};/);
  // and the route surfaces whatever status the resolver decided
  assert.match(routeSrc, /if \(resolved\.error\) return res\.status\(resolved\.status\)\.json\(\{ error: resolved\.error \}\);/);
});

test("symlinks are not followed out of the jail, matching the listing route", () => {
  // pathSafety.js is lexical by its own documentation and does not resolve
  // symlinks, so the route uses lstat rather than pretending otherwise.
  assert.match(resolverSrc, /fs\.lstatSync\(file\)\.isFile\(\)/);
  const jail = fs.readFileSync(path.join(__dirname, "..", "pathSafety.js"), "utf8");
  assert.match(jail, /does not resolve symlinks/);
});

test("a missing file is a 404, not a flash attempt", () => {
  assert.match(resolverSrc, /catch \{ return \{ status: 404, error: "Firmware file not found" \}; \}/);
  assert.match(routeSrc, /res\.status\(resolved\.status\)/);
});

// ---------------------------------------------------------------------------
// Who and when
// ---------------------------------------------------------------------------

test("the route is admin-only", () => {
  assert.match(serverSrc, /app\.post\("\/api\/firmware-deploy", requireAdmin,/);
  assert.match(serverSrc, /app\.get\("\/api\/firmware-deploy-status", requireAdmin,/);
  // requireRegular is enough to e-stop a printer; it is not enough to reflash one.
  assert.equal(/app\.post\("\/api\/firmware-deploy", requireRegular/.test(serverSrc), false);
});

test("a connector that does not advertise firmwareDeploy is refused", () => {
  assert.match(routeSrc, /if \(!getCapabilities\(p\.connector, p\)\.firmwareDeploy\) \{/);
});

test("only the U1 advertises firmwareDeploy — the protocol is verified nowhere else", () => {
  const { getCapabilities, CONNECTOR_TYPES } = require("../connectors");
  const advertising = CONNECTOR_TYPES.filter(t => getCapabilities(t, {}).firmwareDeploy);
  assert.deepEqual(advertising, ["snapmaker-u1-klipper-ws"],
    "a brand without a verified network flashing protocol must not claim this");
  // The -ws connector inherits it by re-exporting the base capabilities object.
  assert.equal(require("../connectors/snapmaker-u1-klipper").capabilities.firmwareDeploy, true);
});

test("firmwareDeploy is deliberately absent from connector-compat-test's capability map", () => {
  // That map pairs a capability with methods the CONNECTOR must export, and
  // this capability is served by a separate module by design (see that module's
  // header: "No connector exports change"). Registering it there would report a
  // false CONTRACT-FAILURE.
  const compat = path.join(__dirname, "..", "connector-compat-test.js");
  if (!fs.existsSync(compat)) return;   // optional dev tool, not always present
  const src = fs.readFileSync(compat, "utf8");
  const map = src.slice(src.indexOf("const CAPABILITY_METHOD_MAP"), src.indexOf("};", src.indexOf("const CAPABILITY_METHOD_MAP")));
  assert.equal(/firmwareDeploy/.test(map), false);
});

test("a printer that is printing or paused is refused", () => {
  assert.match(blockedSrc, /st\.state === "printing" \|\| st\.state === "paused"/);
  assert.match(blockedSrc, /is printing — stop the print before updating firmware/);
  // asked by the route before it accepts the request...
  assert.match(routeSrc, /const blocked = await firmwareDeployBlockedBy\(p\);/);
  assert.match(routeSrc, /if \(blocked\) return res\.status\(400\)\.json\(\{ error: blocked \}\);/);
});

// ---------------------------------------------------------------------------
// The connector module's own preconditions
// ---------------------------------------------------------------------------

test("startLocalUpgrade rejects a non-absolute printer path", async () => {
  // systemUpgrade.sh is handed this verbatim; a relative path would be resolved
  // against whatever cwd unisrv happens to have.
  await assert.rejects(() => u1fw.startLocalUpgrade({ url: "http://127.0.0.1" }, "firmware.bin"),
    /absolute path/);
  await assert.rejects(() => u1fw.startLocalUpgrade({ url: "http://127.0.0.1" }, ""),
    /absolute path/);
  await assert.rejects(() => u1fw.startLocalUpgrade({ url: "http://127.0.0.1" }, "userdata/gcodes/fw.bin"),
    /absolute path/);
});

test("the module still refuses to report success from an RPC acknowledgement alone", () => {
  // unisrv answers {"state":"success"} to system.upgrade even for a file that
  // does not exist; the real outcome arrives later on system/notification.
  const modSrc = fs.readFileSync(path.join(__dirname, "..", "connectors", "snapmaker-u1-firmware.js"), "utf8");
  const update = modSrc.slice(modSrc.indexOf("async function updateFromFile"));
  assert.match(update, /await startLocalUpgrade\(/);
  assert.match(update, /await watchUpgrade\(/, "the flash outcome must come from the notification watch");
  const startIdx = update.indexOf("await startLocalUpgrade(");
  const watchIdx = update.indexOf("await watchUpgrade(");
  assert.ok(watchIdx > startIdx, "watch after start");
});

test("the MD5 verify still gates the flash", () => {
  const modSrc = fs.readFileSync(path.join(__dirname, "..", "connectors", "snapmaker-u1-firmware.js"), "utf8");
  const update = modSrc.slice(modSrc.indexOf("async function updateFromFile"));
  const verifyIdx = update.indexOf("await verifyFirmware(");
  const flashIdx = update.indexOf("await startLocalUpgrade(");
  assert.ok(verifyIdx > 0 && verifyIdx < flashIdx, "verify precedes the flash");
  assert.match(update, /if \(!v\.ok\) \{[\s\S]*?throw new Error\(/, "a mismatch aborts before flashing");
});

// ---------------------------------------------------------------------------
// Reporting: a dropped connection at the flash stage is progress, not failure
// ---------------------------------------------------------------------------

test("the audit entry records who flashed what onto which printer", () => {
  assert.match(routeSrc, /category: "admin", event: "firmware-deploy", \.\.\.actor,/);
  assert.match(routeSrc, /printerId: p\.id, printerName: p\.name,/);
  assert.match(routeSrc, /detail: \{ file: job\.file, result: job\.result,/);
  assert.match(routeSrc, /event: "firmware-deploy-failed"/);
});

test("a mid-flash disconnect is reported as progress, never as an error", () => {
  const poll = appSrc.slice(appSrc.indexOf("function pollFirmwareDeploy("), appSrc.indexOf("function firmwareSkipReasonText"));
  // No version came back => the printer is still writing the image. That branch
  // must be an "ok" status, not an error one.
  // The no-version-came-back branch must set an "ok" status, immediately —
  // asserted on the branch itself, since the legitimate error branch sits
  // above it and a loose match would span both.
  assert.match(poll, /\} else \{\s*\n\s*st\.className="pstatus ok";\s*\n\s*st\.textContent=t\("settings\.firmware\.done_flashing"/);
  assert.equal(/done_flashing[\s\S]{0,120}pstatus err/.test(poll), false, "nothing turns the expected disconnect into an error");
  // A real error is still reported as one.
  assert.match(poll, /if\(d\.error\)\{ st\.className="pstatus err"; st\.textContent=d\.error; return; \}/);
});

test("the user is told which phase is running, not just that something is happening", () => {
  assert.match(appSrc, /const FW_DEPLOY_PHASE_KEYS=\{/);
  for (const phase of ["starting", "device", "upload", "uploaded", "verify", "verified", "flash", "progress"]) {
    assert.match(appSrc, new RegExp(phase + ':"settings\\.firmware\\.phase_'), "no message for phase " + phase);
  }
});

test("deploy is gated behind hold-to-confirm that names the printer and the file", () => {
  const fn = appSrc.slice(appSrc.indexOf("function confirmFirmwareDeploy("), appSrc.indexOf("let FW_DEPLOY_POLL"));
  assert.match(fn, /openHoldConfirmDialog\(\{/);
  assert.match(fn, /mode:"hold"/);
  assert.match(fn, /t\("settings\.firmware\.confirm_title",\{printer:target\.name\}\)/);
  assert.match(fn, /subtitle:SELECTED_FIRMWARE\.path/);
  // The consequences must state the two things that get printers bricked.
  assert.match(fn, /confirm_consequence_offline/);
  assert.match(fn, /confirm_consequence_power/);
});

test("the Deploy button carries the danger role, unlike the safe controls beside it", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /<button class="btn danger" id="fwDeploy"/);
  assert.match(html, /<button class="btn ghost" id="fwGet"/);
  assert.match(html, /<button class="btn ghost" id="fwSelect"/);
});

test("one printer at a time: the target list only offers capable printers", () => {
  const fn = appSrc.slice(appSrc.indexOf("function syncFirmwareDeployTargets("), appSrc.indexOf("const FW_DEPLOY_PHASE_KEYS"));
  assert.match(fn, /FLEET\.filter\(p=>p\.capabilities&&p\.capabilities\.firmwareDeploy\)/);
  assert.match(fn, /settings\.firmware\.no_targets/);
});

test("no user-visible string is hardcoded in the deploy flow", () => {
  const flow = appSrc.slice(appSrc.indexOf("// ---- Deploy firmware ----"), appSrc.indexOf("function firmwareSkipReasonText"));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales-default", "en.json"), "utf8"));
  const es = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales-default", "es.json"), "utf8"));
  const get = (o, k) => k.split(".").reduce((a, b) => a && a[b], o);
  const keys = [...new Set([...flow.matchAll(/t\("([a-z0-9_.]+)"/g)].map(m => m[1]))];
  assert.ok(keys.length >= 15, "expected the flow to be fully translated");
  for (const k of keys) {
    assert.ok(get(en, k), "missing en key: " + k);
    assert.ok(get(es, k), "missing es key: " + k);
  }
  // The stub it replaced must not linger as an orphan.
  assert.equal(get(en, "settings.firmware.deploy_not_implemented"), undefined);
  assert.equal(get(es, "settings.firmware.deploy_not_implemented"), undefined);
});

// ---------------------------------------------------------------------------
// Races: the request-time answers are stale by the time the job runs
// ---------------------------------------------------------------------------

const jobSrc = (() => {
  const i = serverSrc.indexOf("app.post(\"/api/firmware-deploy\"");
  const j = serverSrc.indexOf("\napp.get(\"/api/firmware-deploy-status\"", i);
  const body = serverSrc.slice(i, j);
  return body.slice(body.indexOf("(async () => {"));
})();

test("the printer state is re-checked inside the job, not only when the request arrived", () => {
  // One helper, asked twice: once to answer the request, once immediately
  // before the deploy starts.
  assert.match(serverSrc, /async function firmwareDeployBlockedBy\(p\) \{/);
  // Declared once, and asked at every point where the answer could have
  // changed: when the request arrives, when the job starts, and — the one
  // that matters most — immediately before the irreversible write.
  // test/firmwarePreFlashGate.test.js proves that last one behaviourally.
  assert.equal((serverSrc.match(/async function firmwareDeployBlockedBy/g) || []).length, 1);
  assert.match(routeSrc, /const blocked = await firmwareDeployBlockedBy\(p\);/);
  assert.match(jobSrc, /const stillBlocked = await firmwareDeployBlockedBy\(p\);/);
  assert.match(jobSrc, /const busy = await firmwareDeployBlockedBy\(p\);/);
  assert.match(jobSrc, /const stillBlocked = await firmwareDeployBlockedBy\(p\);/);
  assert.match(jobSrc, /if \(stillBlocked\) throw new Error\(stillBlocked\);/);
  // and it must happen BEFORE the module is handed the printer
  const checkIdx = jobSrc.indexOf("await firmwareDeployBlockedBy(p)");
  const runIdx = jobSrc.indexOf("u1Firmware.updateFromFile(");
  assert.ok(checkIdx > 0 && checkIdx < runIdx, "re-check precedes updateFromFile");
});

test("the firmware file is re-resolved inside the job, against the CURRENT config", () => {
  // Between the request and the job the admin can change the firmware folder,
  // and the file can be deleted, moved, or swapped for a symlink. The check
  // that counts is the one taken against what will actually be read.
  assert.match(serverSrc, /function resolveFirmwareFile\(relRaw\) \{/);
  assert.match(jobSrc, /const now = resolveFirmwareFile\(relRaw\);/);
  assert.match(jobSrc, /if \(now\.error\) throw new Error\(now\.error\);/);
  // the module is handed the RE-resolved path, never the request-time one
  assert.match(jobSrc, /u1Firmware\.updateFromFile\(p, now\.file,/);
  const reIdx = jobSrc.indexOf("resolveFirmwareFile(relRaw)");
  const runIdx = jobSrc.indexOf("u1Firmware.updateFromFile(");
  assert.ok(reIdx > 0 && reIdx < runIdx, "re-resolution precedes updateFromFile");
});

test("the re-resolver repeats the jail, lstat and absolute-path checks", () => {
  const fn = serverSrc.slice(serverSrc.indexOf("function resolveFirmwareFile(relRaw) {"),
                             serverSrc.indexOf("async function firmwareDeployBlockedBy"));
  assert.match(fn, /path\.isAbsolute\(relRaw\)/);
  assert.match(fn, /resolveWithinFolder\(relRaw, root\)/);
  assert.match(fn, /fs\.lstatSync\(file\)\.isFile\(\)/);
  assert.match(fn, /path\.resolve\(BASE_DIR, configured\)/);
  // reads CFG at call time rather than closing over a resolved value
  assert.match(fn, /String\(CFG\.firmwareFolder \|\| ""\)\.trim\(\)/);
});

test("a second deploy to the same printer is refused with 409", () => {
  assert.match(serverSrc, /const FW_ACTIVE = new Map\(\);/);
  assert.match(serverSrc, /if \(FW_ACTIVE\.has\(p\.id\)\) \{\s*\n\s*return res\.status\(409\)/);
  assert.match(serverSrc, /already has a firmware update running/);
  // keyed by the printer's stable id, not its index in the array
  assert.match(serverSrc, /FW_ACTIVE\.set\(p\.id, jobId\);/);
});

test("the concurrency claim is taken with no await between the check and the set", () => {
  // Otherwise two requests that were both parked on the state probe could
  // both pass the check. Node will not interleave a synchronous run of
  // check-then-set, so the window has to contain no await at all.
  const route = serverSrc.slice(serverSrc.indexOf("app.post(\"/api/firmware-deploy\""));
  const checkIdx = route.indexOf("FW_ACTIVE.has(p.id)");
  const setIdx = route.indexOf("FW_ACTIVE.set(p.id, jobId)");
  assert.ok(checkIdx > 0 && setIdx > checkIdx);
  assert.equal(/await/.test(route.slice(checkIdx, setIdx)), false,
    "an await between the check and the claim would reopen the race");
});

test("the claim is released however the job ends", () => {
  assert.match(jobSrc, /\} finally \{[\s\S]*?if \(FW_ACTIVE\.get\(p\.id\) === jobId\) FW_ACTIVE\.delete\(p\.id\);/);
  // guarded by jobId so a finished job cannot release a newer one's claim
  assert.match(jobSrc, /FW_ACTIVE\.get\(p\.id\) === jobId/);
});

// ---------------------------------------------------------------------------
// Three endings, kept distinct
// ---------------------------------------------------------------------------

test("a confirmed update and an unconfirmed reboot are recorded as different outcomes", () => {
  assert.match(jobSrc, /job\.result = r\.after \? "updated" : "version-unconfirmed";/);
  // never invents a version it has not observed
  assert.match(jobSrc, /to: \(r\.after && r\.after\.fullversion\) \|\| null/);
  assert.equal(/to:\s*(job\.file|"|\x27)/.test(jobSrc), false, "no fabricated version string");
});

test("the audit records the named result and the raw watch outcome", () => {
  assert.match(jobSrc, /detail: \{ file: job\.file, result: job\.result,/);
  assert.match(jobSrc, /watch: r\.outcome,/);
  // a genuine failure is still its own event
  assert.match(jobSrc, /event: "firmware-deploy-failed"/);
});

test("the status endpoint exposes the named result", () => {
  const status = serverSrc.slice(serverSrc.indexOf("app.get(\"/api/firmware-deploy-status\""));
  assert.match(status, /result: job\.result,/);
});

test("the UI treats version-unconfirmed as success, and only a real error as an error", () => {
  const poll = appSrc.slice(appSrc.indexOf("function pollFirmwareDeploy("), appSrc.indexOf("function firmwareSkipReasonText"));
  // the confirmed branch requires BOTH the named result and an actual version
  assert.match(poll, /if\(d\.result==="updated"&&d\.to\)\{/);
  // everything else that finished without an error is still "ok"
  assert.match(poll, /\} else \{\s*\n\s*st\.className="pstatus ok";\s*\n\s*st\.textContent=t\("settings\.firmware\.done_flashing"/);
  assert.match(poll, /if\(d\.error\)\{ st\.className="pstatus err"/);
});


test("no new runtime dependency was added", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies || {}).sort(), ["express"]);
  const modSrc = fs.readFileSync(path.join(__dirname, "..", "connectors", "snapmaker-u1-firmware.js"), "utf8");
  const requires = [...modSrc.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]);
  for (const r of requires) {
    assert.ok(r.startsWith("node:") || r.startsWith("./"), "unexpected dependency: " + r);
  }
});
