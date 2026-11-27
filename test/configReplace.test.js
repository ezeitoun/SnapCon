// test/configReplace.test.js — replaceConfigFile() (configLoader.js): the
// whole-file replacement used by the pool / Queue Management routes. Real
// files in a temporary folder, with single filesystem calls made to fail.
// What is checked each time is what is ON DISK afterwards, and that the error
// says which of two things happened to config.json: "unchanged" or
// "replaced-not-flushed". Nothing here ever writes config.json where it is.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { replaceConfigFile } = require("../configLoader");

const OLD = JSON.stringify({ port: 4545, printers: [{ id: "p_sample0001", name: "Sim A" }], note: "x".repeat(400) }, null, 2);
const NEW = JSON.stringify({ port: 4545, printers: [{ id: "p_sample0001", name: "Sim A", printerPoolId: "pp_a" }], note: "y".repeat(600) }, null, 2);
const err = code => Object.assign(new Error(code + ": simulated"), { code });
const notRoot = process.getuid && process.getuid() === 0 ? "root ignores file permissions" : false;

function setup(t, { content = OLD } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  if (content !== null) fs.writeFileSync(file, content);
  return { dir, file, read: () => fs.readFileSync(file, "utf8"), names: () => fs.readdirSync(dir).sort() };
}
// rule(op, basename) -> an Error to throw, { max } to write at most that many bytes per call, or nothing.
function faulty(rule) {
  const fdName = new Map(), calls = [];
  const hit = (op, name) => { calls.push(op + " " + name); const r = rule(op, name, calls); if (r instanceof Error) throw r; return r; };
  const wrap = { ...fs,
    openSync(p, ...r) { const name = path.basename(p); hit("open", name); const fd = fs.openSync(p, ...r); fdName.set(fd, name); return fd; },
    writeSync(fd, buf, off, len, ...r) { const res = hit("write", fdName.get(fd)); if (res && res.max) len = Math.min(len, res.max); return fs.writeSync(fd, buf, off, len, ...r); },
    fsyncSync(fd) { hit("fsync", fdName.get(fd)); return fs.fsyncSync(fd); },
    closeSync(fd) { fdName.delete(fd); return fs.closeSync(fd); },
    renameSync(a, b) { hit("rename", path.basename(a)); return fs.renameSync(a, b); },
    unlinkSync(p) { hit("unlink", path.basename(p)); return fs.unlinkSync(p); },
  };
  return { fs: wrap, calls };
}
const fails = (fn) => { try { fn(); } catch (e) { return e; } assert.fail("expected the save to fail"); };

test("the new settings are written and flushed beside config.json, renamed over it, and the folder is flushed — in that order, keeping the file's permissions", t => {
  const s = setup(t);
  fs.chmodSync(s.file, 0o600);
  const f = faulty(() => undefined);
  replaceConfigFile(s.file, NEW, { fsImpl: f.fs });
  assert.equal(s.read(), NEW);
  assert.deepEqual(s.names(), ["config.json"], "no temporary file is left");
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  const c = f.calls, at = x => c.indexOf(x), dir = path.basename(s.dir);
  assert.ok(at("write config.json.tmp") < at("fsync config.json.tmp") && at("fsync config.json.tmp") < at("rename config.json.tmp") && at("rename config.json.tmp") < at("fsync " + dir), c.join(", "));
  assert.equal(c.includes("open config.json"), false, "config.json itself is never opened for writing");
});

test("no config.json yet: the first save creates it", t => {
  const s = setup(t, { content: null });
  replaceConfigFile(s.file, NEW);
  assert.equal(s.read(), NEW);
});

for (const [what, rule] of [
  ["the disk fills part-way through the new file", (op, n, calls) => op === "write" && n === "config.json.tmp" ? (calls.filter(c => c === "write config.json.tmp").length > 1 ? err("ENOSPC") : { max: 100 }) : undefined],
  ["the new file cannot be created", (op, n) => op === "open" && n === "config.json.tmp" ? err("EROFS") : undefined],
  ["the new file cannot be flushed", (op, n) => op === "fsync" && n === "config.json.tmp" ? err("EIO") : undefined],
  ["the rename fails", (op, n) => op === "rename" && n === "config.json.tmp" ? err("EIO") : undefined],
]) {
  test(`${what}: config.json on disk is byte for byte what it was, and the error says "unchanged"`, t => {
    const s = setup(t);
    const e = fails(() => replaceConfigFile(s.file, NEW, { fsImpl: faulty(rule).fs }));
    assert.equal(e.configFile, "unchanged");
    assert.equal(s.read(), OLD);
    assert.deepEqual(s.names(), ["config.json"], "the partial temporary file was removed");
    assert.doesNotThrow(() => JSON.parse(s.read()));
  });
}

test("the folder cannot be flushed after the rename: config.json already holds the new settings, and the error says so (\"replaced-not-flushed\") instead of \"unchanged\"", t => {
  const s = setup(t), dir = path.basename(s.dir);
  const e = fails(() => replaceConfigFile(s.file, NEW, { fsImpl: faulty((op, n) => op === "fsync" && n === dir ? err("EIO") : undefined).fs }));
  assert.equal(e.configFile, "replaced-not-flushed");
  assert.equal(e.code, "EIO");
  assert.equal(s.read(), NEW);
});

test("a folder that cannot be flushed at all (the flush is not supported there) is not a failure", t => {
  const s = setup(t), dir = path.basename(s.dir);
  replaceConfigFile(s.file, NEW, { fsImpl: faulty((op, n) => op === "fsync" && n === dir ? err("EINVAL") : undefined).fs });
  assert.equal(s.read(), NEW);
  replaceConfigFile(s.file, OLD, { platform: "win32" });
  assert.equal(s.read(), OLD);
});

test("a config.json that is read-only stays as it is: a rename could replace it, and is not tried", { skip: notRoot }, t => {
  const s = setup(t);
  fs.chmodSync(s.file, 0o444);
  const f = faulty(() => undefined);
  const e = fails(() => replaceConfigFile(s.file, NEW, { fsImpl: f.fs }));
  assert.equal(e.configFile, "unchanged");
  assert.equal(s.read(), OLD);
  assert.deepEqual(f.calls, [], "nothing was written anywhere");
});

test("a config.json that is a symbolic link stays a link: the file it points to is replaced", { skip: process.platform === "win32" ? "symlinks need privileges on Windows" : false }, t => {
  const s = setup(t, { content: null });
  const real = path.join(s.dir, "real", "settings.json");
  fs.mkdirSync(path.dirname(real)); fs.writeFileSync(real, OLD);
  fs.symlinkSync(real, s.file);
  replaceConfigFile(s.file, NEW);
  assert.equal(fs.lstatSync(s.file).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(real, "utf8"), NEW);
});

// A config.json that is itself a mount point (Docker's single-file bind
// mount, as in docker-compose.yml) cannot be renamed over: EBUSY, or EXDEV.
// There the save FAILS and the file is left alone. It is never opened for
// writing: opening it would cut it short, and a process that stops before
// every byte is back cannot put anything right afterwards.
for (const code of ["EBUSY", "EXDEV"]) {
  test(`config.json cannot be renamed over (${code}, a mount point): the save fails, config.json is byte for byte what it was and is never opened for writing`, t => {
    const s = setup(t);
    const before = fs.readFileSync(s.file), ino = fs.statSync(s.file).ino;
    const f = faulty((op, n) => op === "rename" && n === "config.json.tmp" ? err(code) : undefined);
    const opened = [];
    const realOpen = f.fs.openSync;
    f.fs.openSync = (p, flags, ...r) => { opened.push(path.basename(p) + " " + flags); return realOpen(p, flags, ...r); };
    for (const k of ["writeFileSync", "appendFileSync", "truncateSync", "copyFileSync", "createWriteStream", "chmodSync", "chownSync", "utimesSync"]) f.fs[k] = (p, ...r) => { opened.push(k + " " + path.basename(String(p))); return fs[k](p, ...r); };
    const e = fails(() => replaceConfigFile(s.file, NEW, { fsImpl: f.fs }));
    assert.equal(e.configFile, "unchanged");
    assert.equal(e.code, code);
    assert.equal(/[\\/]/.test(e.message), false, "no server path in the message");
    assert.deepEqual(fs.readFileSync(s.file), before, "the same bytes");
    assert.equal(fs.statSync(s.file).ino, ino, "the same file");
    assert.deepEqual(s.names(), ["config.json"], "the temporary file was removed");
    assert.deepEqual(opened.filter(o => !/^config\.json\.tmp |^\w+Sync config\.json\.tmp$/.test(o)), [], "nothing but the temporary file was opened or written: " + opened.join(", "));
    assert.equal(f.calls.some(c => c === "open config.json" || c === "write config.json" || c === "fsync config.json"), false, f.calls.join(", "));
  });
}

test("configLoader.js has no way left to write config.json where it is", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "configLoader.js"), "utf8");
  const body = src.slice(src.indexOf("function replaceConfigFile("));
  assert.doesNotMatch(body, /replaceInPlace|inPlace|"damaged"/);
  assert.doesNotMatch(body, /openSync\(target|writeFileDurably\(fsImpl, target|writeFileSync\(/, "the only file written is the temporary one");
});

test("the temporary file never has wider permissions than config.json, even while it is being written", t => {
  const s = setup(t);
  fs.chmodSync(s.file, 0o600);
  let modeWhileWriting = null;
  const f = faulty((op, n) => { if (op === "write" && n === "config.json.tmp") modeWhileWriting = fs.statSync(s.file + ".tmp").mode & 0o777; });
  replaceConfigFile(s.file, NEW, { fsImpl: f.fs });
  assert.equal(modeWhileWriting, 0o600);
  // A stale temporary file from an earlier stop, with wider permissions, is not reused.
  fs.writeFileSync(s.file + ".tmp", "stale", { mode: 0o644 });
  replaceConfigFile(s.file, OLD, { fsImpl: f.fs });
  assert.equal(modeWhileWriting, 0o600);
  assert.equal(s.read(), OLD);
});
