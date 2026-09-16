// test/printerAccessCodeSecret.test.js — a printer's access code is a secret and
// must get the same treatment as the Moonraker API token.
//
// The bug: publicCfg() stripped `token` but sent `verificationCode` verbatim to
// every Admin, and addPrinterRow() wrote it straight back into a plain <input>'s
// value. So a saved access code round-tripped to the browser and sat in the DOM
// in clear text — exactly what CLAUDE.md section 5 forbids ("Never place an
// existing secret back into the DOM merely to display it") and what the token
// already avoids. It matters more for Bambu Lab than for FlashForge: with
// Developer Mode on, that code is full control of the printer.
//
// Two halves, the same split (and for the same reason) as
// test-connection-credentials.test.js: server.js has no module.exports and
// starts a listener on require, so the two functions under test are extracted
// from source and run in a vm with stubbed globals — real behaviour, no
// listener — while the client contract is asserted against public/app.js source.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

const SECRET = "603db0db";   // shape of a real Bambu access code

// A function's source ends at the first "}" in column 0 — every nested block in
// these two is indented.
function extractFn(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start > 0, signature + " must exist in server.js");
  const end = src.indexOf("\n}", start);
  assert.ok(end > start, signature + " must be a top-level function");
  return src.slice(start, end + 2);
}

// ---- publicCfg: what /api/config hands the browser ----

function runPublicCfg(printers, role = "admin") {
  const ctx = vm.createContext({
    CFG: { notifications: null, resend: null, otp: null, groups: [] },
    FOLDER: "/gcode",
    PRINTERS: printers,
    IS_DOCKER: false,
    CONFIG_LOAD_FAILED: false,
    CONFIG_LOAD_QUARANTINE_PATH: null,
    auditLog: { isAvailable: () => true },
  });
  vm.runInContext(extractFn(serverSrc, "function publicCfg(role)"), ctx);
  return vm.runInContext("publicCfg", ctx)(role);
}

const SAVED_PRINTER = {
  name: "P2S", url: "http://192.168.16.223", connector: "bambu-lab",
  serial: "22E8AJ5C2001188", verificationCode: SECRET, token: "moonraker-token",
};

test("/api/config never carries a printer's access code", () => {
  const cfg = runPublicCfg([{ ...SAVED_PRINTER }]);
  assert.equal(cfg.printers[0].verificationCode, undefined);
  assert.ok(!JSON.stringify(cfg).includes(SECRET),
    "the access code must not appear anywhere in the admin config payload");
});

test("/api/config reports that an access code is configured, without its value", () => {
  const cfg = runPublicCfg([{ ...SAVED_PRINTER }]);
  assert.equal(cfg.printers[0].hasVerificationCode, true,
    "the UI needs this to show the Configured badge");
});

test("/api/config reports hasVerificationCode false for a printer that has none", () => {
  const cfg = runPublicCfg([{ ...SAVED_PRINTER, verificationCode: undefined }]);
  assert.equal(cfg.printers[0].hasVerificationCode, false);
  assert.equal(cfg.printers[0].verificationCode, undefined);
});

test("the API token keeps its existing masking (unchanged by this fix)", () => {
  const cfg = runPublicCfg([{ ...SAVED_PRINTER }]);
  assert.equal(cfg.printers[0].token, undefined);
  assert.equal(cfg.printers[0].hasToken, true);
});

test("a non-admin still gets no printers at all", () => {
  const cfg = runPublicCfg([{ ...SAVED_PRINTER }], "regular");
  assert.equal(cfg.printers, undefined);
});

// ---- buildPrinterRecord: what a save does to a stored access code ----
//
// The access code now behaves exactly like `token`: a value replaces, an
// explicit "" clears, and absent keeps what is on file. Absent is the NORMAL
// case once the field is masked — the browser no longer has the value to send
// back — so the old `if (p.verificationCode)` would silently wipe the stored
// code on every unrelated settings save.

async function buildRecord(submitted, existing) {
  const ctx = vm.createContext({
    CONNECTOR_TYPES: ["bambu-lab", "creality-klipper"],
    DEFAULT_CONNECTOR_TYPE: "bambu-lab",
    BRAND_EDITABLE_CONNECTOR: "klipper-moonraker",
    CFG: { groups: [] },
    resolvePrinterAddress: p => ({ url: String(p.url || "") }),
    getConnector: () => ({ brand: "Bambu Lab", label: "Bambu Lab" }),
    sanitizeBrand: b => String(b || ""),
    newPrinterId: () => "generated-id",
    detectCrealityWebrtcCamera: async () => {},
  });
  vm.runInContext(extractFn(serverSrc, "async function buildPrinterRecord(p, existing)"), ctx);
  return vm.runInContext("buildPrinterRecord", ctx)(submitted, existing);
}

const STORED = { id: "p1", url: "http://192.168.16.223", connector: "bambu-lab", verificationCode: SECRET };
const SUBMITTED = { name: "P2S", url: "http://192.168.16.223", connector: "bambu-lab" };

test("saving a row whose access code was never touched keeps the stored code", async () => {
  // The masked control sends nothing unless the user actually replaces or
  // clears it. Dropping the field here would log every Bambu printer out of
  // SnapCon the first time anyone renamed it.
  const o = await buildRecord({ ...SUBMITTED }, STORED);
  assert.equal(o.verificationCode, SECRET);
});

test("an all-whitespace access code counts as untouched, not as a new code", async () => {
  const o = await buildRecord({ ...SUBMITTED, verificationCode: "   " }, STORED);
  assert.equal(o.verificationCode, SECRET, "whitespace must never overwrite a real code");
});

test("an explicit empty string clears the stored access code", async () => {
  // This is the masked control's Clear action, and the only way to remove one.
  const o = await buildRecord({ ...SUBMITTED, verificationCode: "" }, STORED);
  assert.equal(o.verificationCode, undefined);
});

test("a submitted access code replaces the stored one", async () => {
  const o = await buildRecord({ ...SUBMITTED, verificationCode: "newcode1" }, STORED);
  assert.equal(o.verificationCode, "newcode1");
});

test("a submitted access code is still capped at 8 characters", async () => {
  const o = await buildRecord({ ...SUBMITTED, verificationCode: "0123456789" }, STORED);
  assert.equal(o.verificationCode, "01234567");
});

test("a brand-new printer with no access code stores none", async () => {
  const o = await buildRecord({ ...SUBMITTED }, undefined);
  assert.equal(o.verificationCode, undefined);
});

// ---- the client must not put the code back in the DOM ----

test("the access-code field is the shared masked-secret control", () => {
  const at = appSrc.indexOf("field_access_code");
  assert.ok(at !== -1, "the access-code field must exist in the printer row");
  const field = appSrc.slice(at, at + 400);
  assert.match(field, /secretFieldHtml\("pvcode"/,
    "CLAUDE.md section 5: a stored secret uses the Configured/Replace/Clear control");
  assert.doesNotMatch(field, /value="\$\{esc\(opts\.verificationCode/,
    "the saved code must never be written back into an input's value");
});

test("the masked control is told only whether a code is configured", () => {
  const at = appSrc.indexOf('secretFieldHtml("pvcode"');
  assert.ok(at !== -1);
  assert.match(appSrc.slice(at, at + 160), /opts\.hasVerificationCode/);
});

test("the access-code input still stops at 8 characters, as the plain input did", () => {
  // The server truncates at 8 either way. Without the cap in the markup a
  // 10-character paste looks accepted and then authenticates as its first 8 —
  // the printer answers "wrong code" and nothing on screen says why.
  const at = appSrc.indexOf('secretFieldHtml("pvcode"');
  assert.match(appSrc.slice(at, at + 160), /maxlength=\\?"8\\?"/);
});

test("secretFieldHtml puts caller-supplied attributes on the input, not the wrapper", () => {
  const fn = appSrc.slice(appSrc.indexOf("function secretFieldHtml("),
                          appSrc.indexOf("\n}", appSrc.indexOf("function secretFieldHtml(")));
  const inputLine = fn.split("\n").find(l => l.includes('type="password"'));
  assert.ok(inputLine, "the masked control must still render a real password input");
  assert.match(inputLine, /\$\{attrs/, "attributes belong on the input the user types into");
});

test("printer rows are rebuilt from hasVerificationCode, never from the value", () => {
  const at = appSrc.indexOf("function renderPrinterRowsFromConfig()");
  const fn = appSrc.slice(at, appSrc.indexOf("\n}", at));
  assert.match(fn, /hasVerificationCode:p\.hasVerificationCode/);
  assert.doesNotMatch(fn, /verificationCode:p\.verificationCode/,
    "the server no longer sends it, and passing it through would re-expose it");
});

test("every secret field in a printer row is wired, not just the first", () => {
  // The row now holds TWO (API token, access code). wireSecretField on a single
  // querySelector(".secret-field") would leave the access code's Replace and
  // Clear buttons dead.
  const at = appSrc.indexOf("wireSecretField(row.querySelector");
  assert.equal(at, -1,
    "a single-field wiring call would leave the second secret field inert");
  assert.match(appSrc, /row\.querySelectorAll\("\.secret-field"\)\.forEach\(wireSecretField\)/);
});

// Both reads below used `querySelector(".secret-field")`, which now finds
// whichever secret field appears first in the row — the token's. Left alone,
// the access code would be read as the token and vice versa.
for (const [what, marker] of [["the dirty-state snapshot", "function serializeRowForDiff(row)"],
                              ["the save payload", "function gatherPrinters()"]]) {
  test(`${what} reads each secret from its own field`, () => {
    const at = appSrc.indexOf(marker);
    assert.ok(at > 0, marker + " must exist");
    const fn = appSrc.slice(at, appSrc.indexOf("\n}", at));
    // .closest() rather than a :has() selector: plain DOM, no CSS-level
    // support question, and it reads as "the field this input belongs to".
    assert.match(fn, /token:secretFieldValue\([a-z]+\.querySelector\("\.ptoken"\)\.closest\("\.secret-field"\)\)/,
      "the token must be read from the field that holds .ptoken");
    assert.match(fn, /verificationCode:secretFieldValue\([a-z]+\.querySelector\("\.pvcode"\)\.closest\("\.secret-field"\)\)/,
      "the access code must be read from the field that holds .pvcode");
    assert.doesNotMatch(fn, /\.pvcode"\)\.value/,
      "reading .value directly would send the placeholder, not the secret");
  });
}

// ---- Test connection still works without re-typing the code ----

test("Test connection sends the saved printer's id so the server can use the stored code", () => {
  const at = appSrc.indexOf('postJSON("/api/test-connection"');
  assert.ok(at !== -1);
  const call = appSrc.slice(at, at + 500);
  assert.match(call, /id:/, "without the id the server cannot find the stored code");
  assert.match(call, /verificationCode:secretFieldValue\(/,
    "an untouched masked field sends undefined, which is what triggers the fallback");
});

test("/api/test-connection falls back to the stored access code for a saved printer", () => {
  const route = serverSrc.slice(serverSrc.indexOf('app.post("/api/test-connection"'));
  const body = route.slice(0, route.indexOf("\n});"));
  assert.match(body, /PRINTERS\.find\(/,
    "it must look the saved printer up by id to reuse its stored code");
  assert.match(body, /b\.verificationCode/,
    "a code typed into the row must still win over the stored one");
});
