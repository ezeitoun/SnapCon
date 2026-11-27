// test/netfs/unlinkFile.test.js — netfs's only removal (the File Browser's
// permanent delete), through the real worker: it removes a file only if it is
// still the one identity() described. A measurement on a NAS share (2026-11-05)
// showed why the inode matters: a file replaced by another of the same size and
// the same modified time looks unchanged by those two alone.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createNetFs } = require("../../netfs/NetFs");

function setup(t) {
  const nf = createNetFs({ log: { log() {}, warn() {}, error() {} }, opTimeoutMs: 5000 });
  t.after(() => nf.stop());
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-unlink-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return { nf, d };
}

test("the file that was checked is removed", async t => {
  const { nf, d } = setup(t);
  const a = path.join(d, "a.gcode"); fs.writeFileSync(a, "AAAA");
  const id = await nf.identity(a);
  assert.equal(await nf.unlinkFile(a, id), true);
  assert.equal(fs.existsSync(a), false);
});

test("a replacement with the same size and modified time is refused: only the inode tells them apart", async t => {
  const { nf, d } = setup(t);
  const a = path.join(d, "a.gcode"), b = path.join(d, "b.gcode");
  fs.writeFileSync(a, "AAAA"); fs.writeFileSync(b, "BBBB");
  const t0 = new Date(Date.UTC(2026, 0, 1)); fs.utimesSync(a, t0, t0); fs.utimesSync(b, t0, t0);
  const id = await nf.identity(a);
  fs.renameSync(b, a);                                      // another client replaces it
  const now = await nf.identity(a);
  assert.deepEqual([now.size, now.mtimeNs], [id.size, id.mtimeNs], "size and modified time alone see no change");
  assert.notEqual(now.ino, id.ino);
  await assert.rejects(nf.unlinkFile(a, id), { code: "ECHANGED" });
  assert.equal(fs.readFileSync(a, "utf8"), "BBBB", "the other client's file is kept");
});

test("a file rewritten in place, a folder, a link, or no identity at all: nothing is removed", async t => {
  const { nf, d } = setup(t);
  const a = path.join(d, "a.gcode"); fs.writeFileSync(a, "AAAA");
  const id = await nf.identity(a);
  fs.writeFileSync(a, "AAAA, longer now");
  await assert.rejects(nf.unlinkFile(a, id), { code: "ECHANGED" });
  assert.ok(fs.existsSync(a));

  const dir = path.join(d, "dir.gcode"); fs.mkdirSync(dir);
  await assert.rejects(nf.unlinkFile(dir, await nf.identity(dir)), { code: "ECHANGED" });
  assert.ok(fs.existsSync(dir));

  const target = path.join(d, "t.gcode"), link = path.join(d, "l.gcode");
  fs.writeFileSync(target, "T"); fs.symlinkSync(target, link);
  await assert.rejects(nf.unlinkFile(link, await nf.identity(link)), { code: "ECHANGED" });
  assert.ok(fs.existsSync(target) && fs.lstatSync(link).isSymbolicLink());

  await assert.rejects(nf.unlinkFile(a, null), { code: "ECHANGED" });
  await assert.rejects(nf.unlinkFile(a, { size: 16 }), { code: "ECHANGED" }, "an incomplete identity is never enough");
  assert.ok(fs.existsSync(a));
});

test("identity keeps a 64-bit server inode exact", async t => {
  // The NAS's inodes are beyond 2^53 (probe 3): compared as strings, never as Numbers.
  const { nf, d } = setup(t);
  const a = path.join(d, "a.gcode"); fs.writeFileSync(a, "A");
  const id = await nf.identity(a);
  assert.equal(typeof id.ino, "string");
  assert.equal(id.ino, String(fs.statSync(a, { bigint: true }).ino));
});
