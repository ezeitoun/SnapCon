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
  return serverSrc.slice(i, serverSrc.indexOf('\napp.get("/api/firmware-status"', i));
})();
// The route only VALIDATES and QUEUES. The work — and every check that has to
// be re-asked against state that may have moved since — lives in the job.
const jobSrc = (() => {
  const i = serverSrc.indexOf("async function runFirmwareDeploy(");
  assert.ok(i > 0, "the per-printer job must exist");
  return serverSrc.slice(i, serverSrc.indexOf("let fwDraining = false;", i));
})();
const drainSrc = (() => {
  const i = serverSrc.indexOf("async function drainFirmwareQueue()");
  assert.ok(i > 0, "the queue drain must exist");
  return serverSrc.slice(i, serverSrc.indexOf('app.get("/api/firmware-inspect"', i));
})();
// The Firmware tab, from its section marker to the first function that is not
// part of the deploy flow.
const uiSrc = (() => {
  const i = appSrc.indexOf("// ---- Deploy firmware ----");
  assert.ok(i > 0, "the deploy UI must exist");
  return appSrc.slice(i, appSrc.indexOf("// ---- Generic per-tab dirty tracking", i));
})();
const uiSlice = (from, to) => {
  const i = uiSrc.indexOf(from);
  assert.ok(i >= 0, "missing UI function: " + from);
  const j = to ? uiSrc.indexOf(to, i) : -1;
  return j > i ? uiSrc.slice(i, j) : uiSrc.slice(i);
};

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
  // ...and refusing ONE printer is a per-printer rejection, not a failure of
  // the whole request: the other selected printers still go ahead.
  assert.match(routeSrc, /if \(blocked\) \{ reject\(p, idx, blocked\); continue; \}/);
  // ...and it leaves a VISIBLE record. A rejection that only lands in the
  // response array is one the operator never sees: that was the bug.
  assert.match(routeSrc, /phase: "rejected"/);
  assert.match(routeSrc, /res\.json\(\{ ok: true, accepted, rejected, skipped,/);
});

test("a printer in maintenance mode is eligible — being out of production is a reason TO update", () => {
  // Only printing/paused/offline block. A deliberate maintenance state is the
  // sensible moment to flash, so it must not be treated as busy.
  assert.equal(/maintenance/.test(blockedSrc), false, "maintenance must not appear as a blocker");
  assert.match(serverSrc, /Maintenance mode is deliberately NOT a blocker/);
  // ...and the frontend must not invent a rule the server does not have.
  const fn = uiSlice("function firmwareIneligibleCode(", "function refreshFirmwareRowEligibility(");
  assert.equal(/maintenance/.test(fn), false);
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
  assert.match(jobSrc, /category: "admin", event: "firmware-deploy", \.\.\.actor,/);
  assert.match(jobSrc, /printerId: p\.id, printerName: p\.name,/);
  assert.match(jobSrc, /detail: \{ file: st\.file, result, watch: r\.outcome,/);
  assert.match(jobSrc, /event: "firmware-deploy-failed"/);
  // The actor travels WITH the queued job, not with whichever request
  // happened to start the drain — otherwise a second admin's deploy would be
  // logged against the first admin.
  assert.match(routeSrc, /FW_QUEUE\.push\(\{ id: p\.id, rel: relRaw, actor, verifyMode \}\);/);
  assert.match(drainSrc, /await runFirmwareDeploy\(job\.id, job\.rel, job\.actor, job\.verifyMode\);/);
});

test("a mid-flash disconnect is reported as progress, never as an error", () => {
  // The printer dropping off the network to write the image is the EXPECTED
  // ending. The server names it "rebooting"...
  assert.match(jobSrc, /phase: r\.after \? "updated" : "rebooting",/);
  // ...and the status slot renders it as a wait, never as a failure. This is
  // the case that used to surface as "Offline — HTTP 502", which is a raw
  // connection error from a completely different question (the version read)
  // and reads as something to intervene in.
  const slot = uiSlice("function firmwareStatusHtml(", "function renderFirmwareRowStatus(");
  assert.match(slot, /case "rebooting":/);
  assert.match(slot, /return label\("warn"\)\+bar\(true\);/);
  assert.match(uiSrc, /st_rebooting_eta/);
  // A printer being deployed to is shown by its DEPLOY state, never by the
  // version read — during a reboot that read legitimately fails.
  assert.match(uiSrc, /function firmwareDeployActive\(idx\)\{/);
  assert.match(uiSrc, /if\(firmwareDeployActive\(r\.id\)\) return "needs";/);
  assert.match(uiSrc, /if\(r\.skipped&&!firmwareDeployActive\(r\.id\)\)\{/);
  // Only a printer that never came back is called a failure.
  assert.match(uiSrc, /const FW_REBOOT_ERROR_MS = 5 \* 60 \* 1000;/);
  assert.match(slot, /if\(firmwareStatusShape\(x\)==="rebooting-lost"\)\{/);
  const shapeFn = uiSlice("function firmwareStatusShape(", "// A chip for a state");
  assert.match(shapeFn, /elapsed>FW_REBOOT_ERROR_MS \? "rebooting-lost" : "rebooting"/);
});

test("the user is told which phase is running, not just that something is happening", () => {
  // Every phase the SERVER can put a printer in must have a rendering, and
  // nothing else may appear — a phase with no case renders as an empty cell.
  const SERVER_PHASES = ["queued", "preparing", "upload", "verify", "flash",
                         "rebooting", "updated", "skipped", "cancelled", "failed",
                         // The server refused to start this one. Distinct from
                         // "skipped" (nothing needed doing) and "failed" (tried
                         // and went wrong) — and it must render, or a rejected
                         // printer shows an empty cell, which is the bug that
                         // made rejections invisible in the first place.
                         "rejected"];
  for (const phase of SERVER_PHASES) {
    assert.ok(new RegExp('phase: (?:"' + phase + '"|r\\.after \\? "updated" : "rebooting")').test(serverSrc),
              "the server never sets phase " + phase);
  }
  const slot = uiSlice("function firmwareStatusHtml(", "function renderFirmwareRowStatus(");
  const rendered = [...slot.matchAll(/case "([a-z-]+)":/g)].map(m => m[1]);
  assert.deepEqual(rendered.sort(), [...SERVER_PHASES].sort(),
    "every server phase is rendered, and nothing else is");
  // Two shapes, consistently: a CHIP for a state that simply is, a LABEL plus
  // a bar for one that is moving — so which kind of state a card is in is
  // legible before any of the words are.
  assert.match(slot, /case "upload":\s*return label\(""\)\+bar\(false\);/);
  assert.match(slot, /case "verify":\s*return label\(""\)\+bar\(true\);/);
  assert.match(slot, /case "flash":\s*return label\(""\)\+bar\(true\);/);
  // Only the upload knows a real fraction; everything else with a bar is
  // indeterminate and must not claim a percentage nothing reports.
  const pctFn = uiSlice("function firmwareStatusPct(", "// Which MARKUP a status needs");
  assert.match(pctFn, /return x\.phase==="upload" \? \(x\.total>0\?\(x\.sent\/x\.total\)\*100:0\) : 100;/);
  // A queued printer says where it is in the queue, which is what replaces
  // needing a separate order list.
  const words2 = uiSlice("function firmwareStatusText(", "function firmwareStatusPct(");
  assert.match(words2, /st_queued_nth",\{n:queuePos\}/);
  const status = uiSlice("function renderFirmwareStatus(", "// A live language switch");
  assert.match(status, /queue\.indexOf\(idx\)\+1/);
  // The card border carries the state, so the grid is scannable unread.
  assert.match(uiSrc, /const FW_CARD_STATE=\{ upload:"busy", verify:"busy", flash:"busy", preparing:"busy",/);
  assert.match(uiSrc, /\["busy","rebooting","done","failed"\]\.forEach\(c=>el\.classList\.toggle\(c,state===c\)\);/);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  assert.match(css, /\.fwgrid\{display:grid; grid-template-columns:repeat\(auto-fill,minmax\(196px,1fr\)\); gap:9px;\}/);
  ["sel", "busy", "rebooting", "done", "failed", "dim"].forEach(c =>
    assert.match(css, new RegExp("\\.fwcard\\." + c + "\\{"), "no border state for ." + c));
  // Everything under the header lines up with the printer NAME, not with the
  // card edge — the checkbox column indents the name, so without this the
  // version and the progress bar start 24px to its left, which is exactly the
  // misalignment the card layout was meant to remove. One definition feeds
  // both the header grid and the indent so they cannot drift apart.
  assert.match(css, /\.fwcard\{--fw-check:16px; --fw-gutter:8px;/);
  assert.match(css, /\.fwcard-head\{display:grid; grid-template-columns:var\(--fw-check\) 1fr; gap:var\(--fw-gutter\);/);
  assert.match(css, /\.fwcard > \.fwver, \.fwcard > \.fwstat\{padding-left:calc\(var\(--fw-check\) \+ var\(--fw-gutter\)\);\}/);
});

test("deploy is gated behind hold-to-confirm that names every printer and the file", () => {
  const fn = uiSlice("async function confirmFirmwareDeploy(", "async function startFirmwareDeploy(");
  assert.match(fn, /openHoldConfirmDialog\(\{/);
  assert.match(fn, /mode:"hold"/);
  // The dialog names the scope of the action and lists the printers, rather
  // than asking "are you sure".
  assert.match(fn, /tn\("settings\.firmware\.confirm_title",picked\.length,\{n:picked\.length\}\)/);
  assert.match(fn, /tn\("settings\.firmware\.confirm_hold_n",picked\.length,\{n:picked\.length\}\)/);
  assert.match(fn, /names\.join\(", "\)/, "the dialog names the printers it will change");
  assert.match(fn, /subtitle:SELECTED_FIRMWARE\.path/);
  // The consequences must state the two things that get printers bricked.
  assert.match(fn, /confirm_consequence_offline/);
  assert.match(fn, /confirm_consequence_power/);
});

test("the dialog shows what the image says about itself, and never claims proven compatibility", () => {
  const fn = uiSlice("async function confirmFirmwareDeploy(", "async function startFirmwareDeploy(");
  // A file whose own bytes disqualify it never reaches the dialog.
  assert.match(fn, /const ins=await inspectSelectedFirmware\(\);/);
  assert.match(fn, /if\(ins&&ins\.hardFail&&ins\.hardFail\.length\)\{/);
  const gateIdx = fn.indexOf("ins.hardFail.length");
  const dialogIdx = fn.indexOf("openHoldConfirmDialog(");
  assert.ok(gateIdx > 0 && gateIdx < dialogIdx, "the hard-fail check precedes the dialog");
  // Warnings are shown as things to CHECK, alongside the consequences.
  assert.match(fn, /inspect_warning/);
  // An unreadable version is stated as unknown, never guessed from the name.
  assert.match(fn, /confirm_version_unknown/);
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales-default", "en.json"), "utf8"));
  assert.equal(/compatible|verified for this printer/i.test(en.settings.firmware.confirm_version), false,
    "the version line must not imply the image was proven to fit this model");
});

test("the Deploy button carries the danger role, unlike the safe controls beside it", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /<button class="btn danger" id="fwDeploy"/);
  assert.match(html, /<button class="btn ghost" id="fwGet"/);
  assert.match(html, /<button class="btn ghost" id="fwSelect"/);
});

test("an ineligible printer is disabled with a stated reason, never silently unclickable", () => {
  const fn = uiSlice("function firmwareIneligibleCode(", "function firmwareIneligibleReason(");
  assert.match(fn, /p\.capabilities&&p\.capabilities\.firmwareDeploy/);
  const keys = uiSlice("const FW_INELIGIBLE_KEYS", "function firmwareIneligibleReason(");
  ["ineligible_unsupported", "ineligible_offline", "ineligible_printing", "ineligible_in_progress"]
    .forEach(k => assert.match(keys, new RegExp(k), "no reason for " + k));
  const cells = uiSlice("function updateFirmwareRowCells(", "// The one status slot per row");
  assert.match(cells, /chk\.disabled=!!why;/);
  assert.match(cells, /chk\.title=why;/, "a disabled control says why");
  assert.match(cells, /chk\.checked=FW_SEL\.has\(r\.id\);/);
  // Selection lives in a Set, not in the checkboxes: rows move between groups
  // as versions change, and a re-rendered checkbox would lose its state.
  assert.match(uiSrc, /const FW_SEL = new Set\(\);/);
  assert.match(uiSrc, /return \[\.\.\.FW_SEL\]\.filter\(idx=>!firmwareIneligibleReason\(firmwareFleetOf\(idx\)\)\);/,
    "an ineligible printer can never be deployed to, however it got selected");
  // Re-evaluated live off the fleet poll, not off a manual re-read.
  assert.match(appSrc, /updateAllPrinterRowStatuses\(\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*refreshFirmwareRowEligibility\(\);/);
});

test("the frontend gate is advisory — the server re-asks and its answer decides", () => {
  // Selection is sent as printer indexes; the server looks each one up again
  // and applies the same rules against fresh state.
  const start = uiSlice("async function startFirmwareDeploy(", "// The progress row is created lazily");
  // Sent as stable ids rather than row indexes — a Settings save can reorder
  // the fleet between the list being drawn and Deploy being pressed.
  assert.match(start, /postJSON\("\/api\/firmware-deploy",\{\s*\n?\s*printers:refs, path:SELECTED_FIRMWARE\.path/);
  assert.match(routeSrc, /const wanted = Array\.isArray\(b\.printers\)/);
  assert.match(routeSrc, /const blocked = await firmwareDeployBlockedBy\(p\);/);
  assert.match(jobSrc, /const stillBlocked = await firmwareDeployBlockedBy\(p\);/);
});

test("the Deploy button names the scope of the action and says why it is disabled", () => {
  const fn = uiSlice("function syncFirmwareDeployButton(", "// Batch progress, and an estimate");
  assert.match(fn, /tn\("settings\.firmware\.deploy_n",n,\{n\}\)/);
  assert.match(fn, /btn\.disabled=!n\|\|!SELECTED_FIRMWARE;/);
  assert.match(fn, /deploy_no_file/);
  assert.match(fn, /deploy_no_selection/);
  assert.match(fn, /if\(why\) btn\.title=why; else btn\.removeAttribute\("title"\);/);
  // A selection survives filtering AND collapsing, so the count can exceed
  // what is on screen — say so rather than letting it look like a miscount.
  assert.match(fn, /selection_hidden/);
  assert.match(fn, /FW_COLLAPSED\[g\]/, "a collapsed group counts as hidden");
});

test("no user-visible string is hardcoded in the deploy flow", () => {
  const flow = appSrc.slice(appSrc.indexOf("// ---- Deploy firmware ----"), appSrc.indexOf("function firmwareSkipReasonText"));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales-default", "en.json"), "utf8"));
  const es = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales-default", "es.json"), "utf8"));
  const get = (o, k) => k.split(".").reduce((a, b) => a && a[b], o);
  const keys = [...new Set([...flow.matchAll(/[^a-zA-Z]t\("([a-z0-9_.]+)"/g)].map(m => m[1]))];
  assert.ok(keys.length >= 15, "expected the flow to be fully translated");
  for (const k of keys) {
    assert.ok(get(en, k), "missing en key: " + k);
    assert.ok(get(es, k), "missing es key: " + k);
  }
  // tn() keys resolve to a _one/_other pair, never to the base key.
  const plural = [...new Set([...flow.matchAll(/tn\("([a-z0-9_.]+)"/g)].map(m => m[1]))];
  assert.ok(plural.length >= 3, "the count-bearing labels must be plural-aware");
  for (const k of plural) {
    assert.equal(get(en, k), undefined, "the base plural key must not exist: " + k);
    for (const suffix of ["_one", "_other"]) {
      assert.ok(get(en, k + suffix), "missing en key: " + k + suffix);
      assert.ok(get(es, k + suffix), "missing es key: " + k + suffix);
    }
  }
  // The stub it replaced must not linger as an orphan.
  assert.equal(get(en, "settings.firmware.deploy_not_implemented"), undefined);
  assert.equal(get(es, "settings.firmware.deploy_not_implemented"), undefined);
});

// ---------------------------------------------------------------------------
// Races: the request-time answers are stale by the time the job runs
// ---------------------------------------------------------------------------


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
  // Queued or running, both count — a printer waiting its turn must not be
  // enqueued twice.
  assert.match(serverSrc, /const fwBusyWith = id => \(FW_RUNNING === id \|\| FW_QUEUE\.some\(e => e\.id === id\)\);/);
  assert.match(routeSrc, /if \(fwBusyWith\(p\.id\)\)/);
  assert.match(routeSrc, /reject\(p, idx, p\.name \+ " already has a firmware update running", 409\)/);
  // A printer already mid-deploy must NOT have its live progress record
  // overwritten by the rejection of a second request naming it.
  assert.match(routeSrc, /if \(p && !fwBusyWith\(p\.id\)\) \{/);
  // keyed by the printer's stable id, not its index in the array — a Settings
  // reorder must not move one printer's claim onto another
  assert.match(routeSrc, /FW_QUEUE\.push\(\{ id: p\.id,/);
});

test("the queue claim is taken with no await between the check and the push", () => {
  // Otherwise two requests that were both parked on the state probe could
  // both pass the check. Node will not interleave a synchronous run of
  // check-then-claim, so the window has to contain no await at all.
  const window = routeSrc.slice(routeSrc.indexOf("---- NO await from here to the claim"));
  assert.ok(window.length > 0, "the claim window must be marked");
  const checkIdx = window.indexOf("fwBusyWith(p.id)");
  const pushIdx = window.indexOf("FW_QUEUE.push(");
  assert.ok(checkIdx > 0 && pushIdx > checkIdx);
  assert.equal(/await/.test(window.slice(checkIdx, pushIdx)), false,
    "an await between the check and the claim would reopen the race");
});

test("the running slot is released however a job ends, and one failure does not cancel the queue", () => {
  // runFirmwareDeploy never throws: every ending is recorded on the printer's
  // own record, so the drain loop always reaches the next printer.
  assert.match(jobSrc, /\} catch \(e\) \{/);
  assert.match(jobSrc, /fwSet\(id, \{ phase: "failed", error: e\.message/);
  assert.match(drainSrc, /while \(FW_QUEUE\.length\) \{/);
  assert.match(drainSrc, /\} finally \{ FW_RUNNING = null; fwDraining = false; FW_STOP_REQUESTED = false; \}/);
  assert.match(drainSrc, /if \(fwDraining\) return;/, "re-entrant-safe");
});

test("Stop after current never interrupts a flash", () => {
  // The half-written image is what leaves a printer unbootable, so the only
  // safe place to stop is between printers.
  assert.match(drainSrc, /if \(FW_STOP_REQUESTED\) \{/);
  const stopIdx = drainSrc.indexOf("FW_STOP_REQUESTED");
  const runIdx = drainSrc.indexOf("await runFirmwareDeploy(");
  assert.ok(stopIdx > 0 && stopIdx < runIdx, "the check is at the top of the loop, before a printer starts");
  // Queued printers say what happened rather than vanishing.
  assert.match(drainSrc, /fwSet\(job\.id, \{ phase: "cancelled", result: "cancelled"/);
  assert.match(serverSrc, /app\.post\("\/api\/firmware-stop", requireAdmin,/);
  // A new request clears a stop from a previous batch, or it would silently
  // cancel work the user just asked for.
  assert.match(routeSrc, /if \(accepted\.length\) \{ FW_STOP_REQUESTED = false; drainFirmwareQueue\(\); \}/);
});

test("the two toggles are saved settings, and the tab has no Save button", () => {
  // Nothing else on this tab is a stored value, so a Save button there is
  // just a control that does nothing for the thing in front of you.
  assert.match(appSrc, /name==="queue"\|\|name==="firmware"\)\?"none":""/);
  assert.match(appSrc, /\["fwSkipCurrent","fwVerify"\]\.forEach\(id=>\{/);
  assert.match(appSrc, /postJSON\("\/api\/firmware-options"/);
  // Its own route: a partial /api/config post falls back to the current value
  // for every field it omits, which is far too much to risk for two booleans.
  assert.match(serverSrc, /app\.post\("\/api\/firmware-options", requireAdmin,/);
  assert.match(serverSrc, /if \(CONFIG_LOAD_FAILED\) return res\.status\(409\)/,
    "a config that failed to read must never be overwritten from memory");
  assert.match(serverSrc, /event: "firmware-verify-disabled"/,
    "turning verification off is worth an audit line of its own");
  // Both default ON when absent, on both sides.
  assert.match(serverSrc, /firmwareSkipCurrent: CFG\.firmwareSkipCurrent !== false,/);
  assert.match(serverSrc, /firmwareVerify: CFG\.firmwareVerify !== false,/);
  assert.match(appSrc, /\$\("fwVerify"\)\.checked=c\.firmwareVerify!==false;/);
});

test("printers are deployed one at a time, not in parallel", () => {
  // The whole reason the queue exists: ~250 MB up and ~250 MB back per
  // printer, on the LAN the printers themselves depend on.
  assert.match(drainSrc, /await runFirmwareDeploy\(job\.id, job\.rel, job\.actor, job\.verifyMode\);/);
  assert.equal(/Promise\.all|Promise\.allSettled/.test(drainSrc), false,
    "the drain must not fan out");
  assert.match(serverSrc, /SEQUENTIAL BY DESIGN/);
});

test("each queued printer carries its own file, not the one that started the drain", () => {
  // A second request naming a DIFFERENT image can arrive while the queue is
  // still draining. Flashing it with the first request's file would put
  // firmware nobody asked for onto a printer.
  assert.match(routeSrc, /FW_QUEUE\.push\(\{ id: p\.id, rel: relRaw, actor, verifyMode \}\);/);
  assert.match(drainSrc, /const job = FW_QUEUE\.shift\(\);/);
  assert.match(drainSrc, /runFirmwareDeploy\(job\.id, job\.rel, job\.actor, job\.verifyMode\)/);
  assert.match(serverSrc, /async function drainFirmwareQueue\(\) \{/,
    "the drain must not take a single file for the whole queue");
});

// ---------------------------------------------------------------------------
// Three endings, kept distinct
// ---------------------------------------------------------------------------

test("a confirmed update and an unconfirmed reboot are recorded as different outcomes", () => {
  assert.match(jobSrc, /const result = r\.after \? "updated" : "version-unconfirmed";/);
  assert.match(jobSrc, /phase: r\.after \? "updated" : "rebooting",/);
  // never invents a version it has not observed
  assert.match(jobSrc, /to: \(r\.after && r\.after\.fullversion\) \|\| null/);
  assert.equal(/to:\s*(st\.file|"|\x27)/.test(jobSrc), false, "no fabricated version string");
});

test("the audit records the named result and the raw watch outcome", () => {
  assert.match(jobSrc, /detail: \{ file: st\.file, result, watch: r\.outcome,/);
  // a genuine failure is still its own event
  assert.match(jobSrc, /event: "firmware-deploy-failed"/);
});

test("both status endpoints expose the named result", () => {
  // The aggregate the Firmware tab reads...
  const agg = serverSrc.slice(serverSrc.indexOf('app.get("/api/firmware-status"'),
                              serverSrc.indexOf('app.get("/api/firmware-deploy-status"'));
  assert.match(agg, /result: st\.result \|\| null,/);
  // ...and the per-job shape this route has always had, kept for compatibility.
  const status = serverSrc.slice(serverSrc.indexOf('app.get("/api/firmware-deploy-status"'));
  assert.match(status, /result: st\.result \|\| null,/);
  assert.match(status, /app\.get\("\/api\/firmware-deploy-status", requireAdmin,/);
});

test("the UI treats version-unconfirmed as success, and only a real error as an error", () => {
  const slot = uiSlice("function firmwareStatusHtml(", "function renderFirmwareRowStatus(");
  // A finished update is a success chip whether or not a version was observed,
  // and it says how long ago so a day-old card does not read as fresh.
  assert.match(slot, /case "updated":/);
  const words = uiSlice("function firmwareStatusText(", "function firmwareStatusPct(");
  assert.match(words, /st_updated_ago",\{ago:fmtTime\(x\.ts\)\}/);
  // An unverified flash is stated on the row, not only in the audit.
  assert.match(slot, /x\.verify==="none"\?.*st_unverified/);
  // Only a real failure is an error, and it carries the reason plus a retry
  // rather than a bare HTTP code.
  assert.match(slot, /case "failed":/);
  assert.match(slot, /return chip\("err"\)\+/);
  const words3 = uiSlice("function firmwareStatusText(", "function firmwareStatusPct(");
  assert.match(words3, /case "failed":\s*return t\("settings\.firmware\.st_failed"\);/);
  assert.match(slot, /class="fwstat-reason"/);
  assert.match(slot, /data-fwretry="1"/);
  assert.match(uiSrc, /async function retryFirmwarePrinter\(idx\)\{/);
});

test("the fleet card says Updating while a deploy is in flight, and stops saying it", () => {
  // Checked BEFORE offline: a printer writing an image is legitimately
  // unreachable, and calling that "Offline" is what gets one power-cycled
  // mid-write.
  const fn = appSrc.slice(appSrc.indexOf("function statusColorText(p){"),
                          appSrc.indexOf("// ---- Camera view: live snapshot"));
  const updIdx = fn.indexOf('p.state==="updating"');
  const rebIdx = fn.indexOf('p.state==="rebooting"');
  const offIdx = fn.indexOf("if(!p.online)");
  assert.ok(updIdx > 0 && updIdx < offIdx, "updating is decided before offline");
  assert.ok(rebIdx > 0 && rebIdx < offIdx, "and so is rebooting — the printer is",
    "legitimately unreachable then");
  assert.match(fn, /statusTxt:t\("printer_status\.updating"\)/);
  assert.match(fn, /statusTxt:t\("printer_status\.rebooting"\)/);
  // Two states, not one: work in progress versus a wait for the machine to
  // come back. They mean different things to whoever is stood in front of it.
  assert.match(serverSrc, /function firmwareCardState\(p\) \{/);
  assert.match(serverSrc, /\? "rebooting" : null;/);
  assert.match(serverSrc, /return fwBusyWith\(p\.id\) \? "updating" : null;/);
  // The server owns the claim, and it is bounded — never open-ended.
  assert.match(serverSrc, /const FW_REBOOT_GRACE_MS = 15 \* 60 \* 1000;/);
  assert.match(serverSrc, /Date\.now\(\) - st\.flashStartedAt < FW_REBOOT_GRACE_MS/);
  // ...and it is dropped the moment the printer answers again.
  assert.match(serverSrc, /function firmwareNoteObserved\(p, online\) \{/);
  assert.match(serverSrc, /if \(st\.phase === "rebooting"\) \{ st\.phase = "updated"/);
  assert.match(serverSrc, /if \(fwState\) return \{ \.\.\.result, state: fwState \};/);
  // Neither state may be ticked: the server refuses it with 409 anyway.
  const elig = uiSlice("function firmwareIneligibleCode(", "function refreshFirmwareRowEligibility(");
  assert.match(elig, /p\.state==="updating"\|\|p\.state==="rebooting"/);
});


// ---------------------------------------------------------------------------
// "Skip printers already on this version"
// ---------------------------------------------------------------------------

test("skipping is on by default, and only a body that says otherwise turns it off", () => {
  // Re-sending a quarter-gigabyte image to a printer that already runs it is
  // the wasteful default, so the switch defaults ON — and a missing field must
  // mean ON, not OFF.
  assert.match(routeSrc, /const skipCurrent = b\.skipCurrent !== false;/);
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  // A setting that is on or off and takes effect by itself is a Switch, and a
  // real one: a checkbox input with role="switch", not a div with a handler.
  assert.match(html, /<input type="checkbox" role="switch" id="fwSkipCurrent" class="switch-input" checked>/);
  assert.match(html, /<label class="switch-row" for="fwSkipCurrent"/, "the label is associated with the control");
  assert.match(html, /data-i18n="settings\.firmware\.skip_current_label"/);
  assert.match(html, /data-i18n="settings\.firmware\.skip_current_desc"/);
});

test("a printer already on the version is SKIPPED, not failed and not refused", () => {
  // Nothing needed doing. Reporting that as an error would train people to
  // ignore firmware errors.
  assert.match(routeSrc, /skipped\.push\(\{ printer: idx, id: p\.id, name: p\.name, version: current \}\);/);
  assert.match(routeSrc, /phase: "skipped", file: path\.basename\(resolved\.file\), error: null,/);
  assert.match(routeSrc, /result: "already-current"/);
  // Decided on the build id, not the truncated version field — see
  // test/firmwareVersionMatch.test.js for why that distinction is the whole
  // difference between this skip working and never firing at all.
  assert.match(routeSrc, /String\(current\) === targetBuild/);
  assert.match(routeSrc, /res\.json\(\{ ok: true, accepted, rejected, skipped, warnings: image\.warnings, version: image\.version, buildId: targetBuild \}\);/);
  const slot = uiSlice("function firmwareStatusHtml(", "function renderFirmwareRowStatus(");
  assert.match(slot, /case "skipped":\s*return chip\("ok"\);/);
  const words = uiSlice("function firmwareStatusText(", "function firmwareStatusPct(");
  assert.match(words, /case "skipped":\s*return t\("settings\.firmware\.st_skipped"\);/);
});

test("skipping needs a version from BOTH sides — it never guesses", () => {
  // The image's version has to have been read out of its bytes, and the
  // printer has to have answered. Either one unknown means deploy, because
  // silently skipping a printer that might be out of date is the worse error.
  // Device info is now read UNCONDITIONALLY, because the compatibility check
  // needs the product code. That made "did we read a version" useless as the
  // skip gate — with it, an operator who deliberately turned skipping OFF would
  // silently have printers skipped anyway. This nearly shipped; the switch has
  // to be re-asserted at the decision itself.
  assert.match(routeSrc, /if \(skipCurrent && \(targetBuild \|\| image\.version\) && current && same\) \{/);
  assert.doesNotMatch(routeSrc, /\n\s*if \(current && same\) \{/,
    "the ungated form must not come back");
  assert.match(routeSrc, /catch \{ \/\* unknown: neither question can be answered, so neither blocks \*\/ \}/);
  // Both halves have to be known: the printer has to have answered, and the
  // IMAGE has to have stated a build. Neither is ever guessed.
  assert.match(routeSrc, /const same = targetBuild/);
});

test("both switches are sent with the request, and both default ON when absent", () => {
  const start = uiSlice("// Both default ON when the control", "// The progress row is created lazily");
  assert.match(start, /skipCurrent: firmwareSkipCurrentEnabled\(\)/);
  assert.match(start, /verify: firmwareVerifyEnabled\(\)/);
  assert.match(start, /const firmwareVerifyEnabled\s*=\s*\(\) => \{ const el=\$\("fwVerify"\);\s*return el \? !!el\.checked : true; \};/,
    "a missing control must read as ON — for verification that is the",
    "difference between a check and no check");
  // A missing control must read as ON, matching the server's own default for
  // an absent field — the safe reading, not the fast one.
  assert.match(start, /const firmwareSkipCurrentEnabled\s*=\s*\(\) => \{ const el=\$\("fwSkipCurrent"\);\s*return el \? !!el\.checked : true; \};/);
  // Skipping a printer is about VERSIONS, and must not read as anything to
  // do with verifying the upload — which is not a setting at all.
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales-default", "en.json"), "utf8"));
  assert.equal(/verif/i.test(en.settings.firmware.skip_current_label + en.settings.firmware.skip_current_desc), false,
    "the skip switch must not read as anything to do with verification");
});

test("the row re-reads its version once the deploy lands", () => {
  // Until it does, the row reads "Updated" while the version beside it is
  // still the one the printer reported BEFORE it was flashed — the one number
  // someone looks at to confirm the update took.
  const fn = uiSlice("async function refreshFirmwareRow(", "async function loadFirmware(");
  assert.match(fn, /getJSON\("\/api\/firmware\?printer="/, "one printer, not the fleet");
  assert.equal(/loadFirmware\(\)/.test(fn), false, "must not re-probe every printer");
  // Its version changed, so it may belong in a different group now.
  assert.match(fn, /renderFirmwareList\(\);/);
  // A printer still rebooting cannot answer; keep what is on screen.
  assert.match(fn, /if\(!fresh\|\|fresh\.error\|\|fresh\.skipped\)\{/);
  // Server side: one printer, same shape /api/fleet?printer=i already uses.
  const route = serverSrc.slice(serverSrc.indexOf('app.get("/api/firmware", requireAuth'),
                                serverSrc.indexOf("// ---- Health diagnostics"));
  assert.match(route, /if \(req\.query\.printer !== undefined\) \{/);
  assert.match(route, /if \(!p \|\| !printerVisibleTo\(req\.user, p\)\) return res\.status\(404\)/,
    "a single-printer read is still subject to group visibility");
});

test("the version re-read retries, because the first attempt normally fails", () => {
  // A printer answers its first probe well before Moonraker can serve
  // /printer/info, and "updated" is a settled phase — so a single attempt
  // fired the moment the printer reappears loses the race, the poll stops, and
  // the row keeps its pre-update version forever.
  const fn = uiSlice("async function refreshFirmwareRow(", "async function loadFirmware(");
  assert.match(fn, /if\(tries>=FW_REFRESH_MAX_TRIES\) FW_REFRESHED\.add\(idx\);/,
    "and it gives up eventually rather than polling forever");
  assert.match(uiSrc, /const FW_REFRESH_MAX_TRIES=\d+;/);
  const poll = uiSlice("async function pollFirmwareStatus(", "function renderFirmwareStatus(");
  assert.match(poll, /d\.printers\[k\]\.phase==="updated"&&!FW_REFRESHED\.has\(parseInt\(k,10\)\)/);
  assert.match(poll, /\(phases\.includes\("rebooting"\)\|\|owed\)\?4000:0/);
  assert.match(fn, /FW_REFRESH_INFLIGHT\.has\(idx\)/, "overlapping attempts would double-fetch");
});

test("a skip that cannot happen is stated, not silently ignored", () => {
  // Pre-1.6.0 U1 images carry no BUILD_NUMBER marker, so their version is
  // genuinely unreadable and "skip printers already on this version" has
  // nothing to compare. Saying so beats letting the user believe printers
  // were skipped when every one of them is about to be flashed.
  const fn = uiSlice("async function confirmFirmwareDeploy(", "async function startFirmwareDeploy(");
  assert.match(fn, /const skipDead=firmwareSkipCurrentEnabled\(\)&&!\(ins&&ins\.version\);/);
  assert.match(fn, /skipDead\?`<li>\$\{esc\(t\("settings\.firmware\.confirm_skip_no_version"\)\)\}<\/li>`:""/);
});

test("a server that cannot answer the inspect call is not reported as a corrupt file", () => {
  // A missing route and a missing FILE are both 404: an older SnapCon still
  // running answers /api/firmware-inspect with an HTML error page, while the
  // real route answers {error:"Firmware file not found"}. Branching on the
  // status cannot tell those apart, and getting it wrong reports a server
  // problem as a corrupt firmware file — which sends the user to look at
  // their file instead of at their server. So the branch is on content type.
  const fn = appSrc.slice(appSrc.indexOf("async function inspectSelectedFirmware("),
                          appSrc.indexOf("// ---- Deploy firmware ----"));
  assert.ok(fn.length > 0, "the inspect helper must exist");
  assert.match(fn, /await fetch\("\/api\/firmware-inspect\?path="/);
  assert.match(fn, /if\(!\(r\.headers\.get\("content-type"\)\|\|""\)\.includes\("application\/json"\)\)\{/);
  assert.equal(/r\.status!==404/.test(fn), false,
    "a status-based branch cannot distinguish a missing route from a missing file");
  assert.match(fn, /inspect_http_error/);
  // A JSON answer always falls through to the body, which carries the real
  // per-file reason ("Firmware file not found", "Invalid path").
  assert.match(fn, /d=await r\.json\(\);/);
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales-default", "en.json"), "utf8"));
  assert.match(en.settings.firmware.inspect_http_error, /\{status\}/);
  // ...and the message has to name the likely cause, because "HTTP 404" on
  // its own tells an operator nothing actionable.
  assert.match(en.settings.firmware.inspect_http_error, /restart the server/i);
});

test("the inspect route answers JSON on every path, including a failure", () => {
  // The counterpart of the rule above: if this route can ever answer with an
  // HTML error page, the client cannot tell that apart from an old server.
  const route = serverSrc.slice(serverSrc.indexOf('app.get("/api/firmware-inspect"'),
                                serverSrc.indexOf('app.post("/api/firmware-deploy"'));
  assert.match(route, /try \{ info = firmwareImage\.inspectFirmwareImage\(resolved\.file\); \}/);
  assert.match(route, /catch \(e\) \{ return res\.status\(500\)\.json\(\{ error:/);
  assert.match(route, /if \(resolved\.error\) return res\.status\(resolved\.status\)\.json\(/);
});

test("a deploy in flight is not restarted by the page — the server owns it", () => {
  // Progress is server state polled by the page, not page state pushed to the
  // server: closing the tab mid-deploy must not stop or restart anything.
  const poll = uiSlice("async function pollFirmwareStatus(", "function renderFirmwareStatus(");
  assert.match(poll, /getJSON\("\/api\/firmware-status"\)/);
  assert.equal(/postJSON|firmware-deploy"/.test(poll), false, "polling must not be able to start work");
  assert.match(poll, /catch\{ return; \}/, "a transient poll failure is not a deploy failure");
  // Entering the tab re-attaches to whatever the server is doing, and also
  // reads the fleet once — an empty list read as a broken tab.
  assert.match(appSrc, /if\(!FW_LOADED\) loadFirmware\(\); else renderFirmwareList\(\);/);
  assert.match(appSrc, /else scheduleFirmwareStatusPoll\(0\);/);
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
