// test/replaceFileGuard.test.js — every send uploads; replacing a file the
// printer already has, when switched off, is refused unless the printer is
// known not to hold that name (owner, 2026-10-29; docs/TODO.md §37).
//
// Before: a file whose size and three sampled 64 KB windows matched the
// printer's copy was not sent ("skip identical uploads", on by default), and
// with replacing off only a difference actually found was refused — a copy
// that could not be compared was overwritten.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const fnSrc = name => { const at = serverSrc.indexOf("async function " + name + "("); assert.ok(at > 0, name); return serverSrc.slice(at, serverSrc.indexOf("\n}\n", at) + 2); };

function decider({ cfg = {}, verify, noVerify = false, compare } = {}) {
  const asked = [];
  const sandbox = {
    CFG: cfg,
    getConnector: () => ({
      ...(noVerify ? {} : { verifyUpload: async (...a) => { asked.push(a); if (verify instanceof Error) throw verify; return verify; } }),
      compareRemoteFile: async () => { asked.push("compare"); return compare || { present: true, identical: true }; },
    }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc("decideUpload"), sandbox);
  return { asked, decide: async (...a) => JSON.parse(JSON.stringify(await vm.runInContext("decideUpload", sandbox)(...a))) };
}
const P = { name: "U1 Navy", connector: "snapmaker-u1-klipper-ws" };

test("replacing on (the default): always upload, and the printer is not even asked — a sampled match never skips", async () => {
  for (const cfg of [{}, { overwriteDifferentFiles: true }, { skipIdenticalUploads: true }, { skipIdenticalUploads: true, overwriteDifferentFiles: true }]) {
    const d = decider({ cfg, compare: { present: true, sameSize: true, identical: true } });
    assert.deepEqual(await d.decide(P, "job.gcode"), { action: "upload" }, JSON.stringify(cfg));
    assert.deepEqual(d.asked, [], JSON.stringify(cfg));
  }
});

test("replacing off: the printer is asked about the exact upload name only, without comparing content", async () => {
  const d = decider({ cfg: { overwriteDifferentFiles: false }, verify: { result: "absent", evidence: "x" } });
  assert.deepEqual(await d.decide(P, "job.gcode"), { action: "upload" });
  assert.equal(d.asked.length, 1);
  assert.deepEqual([d.asked[0][1], d.asked[0][2]], ["job.gcode", null], "by name, no local file to sample");
});

test("replacing off: present, or anything SnapCon cannot be sure of, is refused — never overwritten on incomplete evidence", async () => {
  const cases = [
    [{ result: "acknowledged", basis: "name", evidence: "listed" }, /already has a file called "job\.gcode".*can't prove the two are the same/],
    [{ result: "verified", basis: "content", evidence: "sampled" }, /already has a file called/],
    [{ result: "mismatch", basis: "size", evidence: "x" }, /already has a file called/],
    [{ result: "unverifiable", evidence: "the printer lists only its 10 newest files" }, /couldn't check whether U1 Navy already has a file called "job\.gcode" \(the printer lists only its 10 newest files\)/],
    [new Error("socket hang up"), /couldn't check whether .*\(socket hang up\)/],
    [undefined, /couldn't check whether/],
  ];
  for (const [verify, said] of cases) {
    const d = decider({ cfg: { overwriteDifferentFiles: false }, verify });
    const r = await d.decide(P, "job.gcode");
    assert.equal(r.action, "refuse", String(verify && (verify.result || verify.message)));
    assert.match(r.reason, said);
    assert.match(r.reason, /Replacing files on the printer is switched off in Settings/);
  }
  const none = decider({ cfg: { overwriteDifferentFiles: false }, noVerify: true });
  assert.equal((await none.decide(P, "job.gcode")).action, "refuse", "a printer type that cannot list its files: refused");
});

test("nothing is skipped anywhere: no skip branch, no identical-copy reuse, no setting", () => {
  assert.doesNotMatch(serverSrc, /identicalAtUploadPath|skippedUpload|action: "skip"|skipIdenticalUploads|compareRemoteFile/);
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.doesNotMatch(app + html, /SkipIdenticalUploads|skipIdenticalUploads|skippedUpload|already_on_printer|printing_on_existing/);
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
  for (const l of ["en", "es"]) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "locales-default", l + ".json"), "utf8"), /skip_identical|already_on_printer|printing_on_existing|overwrite_different_/, l);
  assert.match(en.settings.general.replace_same_name_desc, /if it has one, or SnapCon can’t tell, the send is refused/);
  // A reworded string gets a new key: an installed translation keeps its old
  // value for a key it already has (locales.js addMissingBundledKeys).
  assert.equal(en.settings.general.overwrite_different_desc, undefined);
  assert.match(html, /data-i18n="settings\.general\.replace_same_name_label"/);
});
