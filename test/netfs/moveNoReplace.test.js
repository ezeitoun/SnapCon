// test/netfs/moveNoReplace.test.js — a move that never replaces an existing
// target (restoring a file from the trash). fs.rename would silently replace
// a file created at the target a moment before; this must refuse instead, and
// where the storage has no safe way (no hard links) it must refuse the whole
// move, leaving the source where it was.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { moveNoReplace } = require("../../netfs/moveNoReplace");
const { createNetFs } = require("../../netfs/NetFs");

function dir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-mnr-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const fsWith = over => new Proxy(fs, { get: (o, k) => (k in over ? over[k] : o[k]) });
const body = Buffer.alloc(3 * 1024 * 1024 + 17, 7);

test("rename replaces a file created at the target: the bug this exists for", t => {
  const d = dir(t);
  fs.writeFileSync(path.join(d, "trash.gcode"), "restored");
  fs.writeFileSync(path.join(d, "a.gcode"), "someone else's new file");
  fs.renameSync(path.join(d, "trash.gcode"), path.join(d, "a.gcode"));
  assert.equal(fs.readFileSync(path.join(d, "a.gcode"), "utf8"), "restored", "POSIX rename overwrites");
});

test("the file moves whole, and a file already at the target is refused untouched", t => {
  const d = dir(t), src = path.join(d, "src.gcode"), dest = path.join(d, "a.gcode");
  fs.writeFileSync(src, body);
  assert.deepEqual(moveNoReplace(fs, src, dest), { sourceKept: false });
  assert.equal(fs.existsSync(src), false);
  assert.ok(fs.readFileSync(dest).equals(body));

  fs.writeFileSync(src, "restored");
  assert.throws(() => moveNoReplace(fs, src, dest), { code: "EEXIST" });
  assert.equal(fs.readFileSync(src, "utf8"), "restored");
  assert.ok(fs.readFileSync(dest).equals(body));
});

test("storage without hard links: the move is refused, nothing is copied, the source stays", t => {
  for (const code of ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EINVAL"]) {
    const d = dir(t), src = path.join(d, "src.gcode"), dest = path.join(d, "a.gcode");
    fs.writeFileSync(src, body);
    const calls = [];
    const noLinks = fsWith({
      linkSync: () => { throw Object.assign(new Error(code), { code }); },
      openSync: (...a) => { calls.push("open"); return fs.openSync(...a); },
      renameSync: (...a) => { calls.push("rename"); return fs.renameSync(...a); },
      copyFileSync: (...a) => { calls.push("copy"); return fs.copyFileSync(...a); },
      unlinkSync: (...a) => { calls.push("unlink"); return fs.unlinkSync(...a); },
    });
    assert.throws(() => moveNoReplace(noLinks, src, dest), e => e.code === "NO_SAFE_MOVE" && e.cause.code === code, code);
    assert.deepEqual(calls, [], "no fallback of any kind: " + code);
    assert.ok(fs.readFileSync(src).equals(body));
    assert.equal(fs.existsSync(dest), false);
  }
});

test("any other link failure (a full disk, a lost share) is passed on, the source untouched", t => {
  const d = dir(t), src = path.join(d, "src.gcode"), dest = path.join(d, "a.gcode");
  fs.writeFileSync(src, "x");
  const full = fsWith({ linkSync: () => { throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); } });
  assert.throws(() => moveNoReplace(full, src, dest), { code: "ENOSPC" });
  assert.equal(fs.readFileSync(src, "utf8"), "x");
  assert.equal(fs.existsSync(dest), false);
});

test("an old name that cannot be dropped leaves the file in both places, never in neither", t => {
  const d = dir(t), src = path.join(d, "src.gcode"), dest = path.join(d, "a.gcode");
  fs.writeFileSync(src, "x");
  const stuck = fsWith({ unlinkSync: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); } });
  assert.deepEqual(moveNoReplace(stuck, src, dest), { sourceKept: true });
  assert.ok(fs.existsSync(src) && fs.existsSync(dest));
});

test("netfs runs it in its worker, with the same refusal", async t => {
  const nf = createNetFs({ log: { log() {}, warn() {}, error() {} }, opTimeoutMs: 5000 });
  t.after(() => nf.stop());
  const d = dir(t), src = path.join(d, "src.gcode"), dest = path.join(d, "a.gcode");
  fs.writeFileSync(src, "x");
  assert.deepEqual(await nf.moveNoReplace(src, dest), { sourceKept: false });
  fs.writeFileSync(src, "y");
  await assert.rejects(nf.moveNoReplace(src, dest), { code: "EEXIST" });
  assert.equal(fs.readFileSync(dest, "utf8"), "x");
});
