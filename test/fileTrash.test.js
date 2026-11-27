// test/fileTrash.test.js — deleting files from the G-code folder (fileTrash.js).
//
// A delete moves the file into .snapcon-trash/<batch>/files/<its own path>
// and never removes it; restore puts it back. Run against a real temporary
// folder through an async io that behaves like netfs, with failures injected
// where a NAS would fail.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fileTrash = require("../fileTrash");
const { moveNoReplace } = require("../netfs/moveNoReplace");

const SLICED = /\.(gcode|gco|g|gx|3mf)$/i;
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

function diskIo(overrides = {}) {
  const statOf = st => ({ size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile(), isDirectory: st.isDirectory() });
  const io = {
    stat: async p => statOf(fs.statSync(p)),
    exists: async p => fs.existsSync(p),
    readdir: async p => fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() })),
    mkdir: async (p, o = {}) => { fs.mkdirSync(p, { recursive: !!o.recursive }); return true; },
    rename: async (a, b) => { fs.renameSync(a, b); return true; },
    readFile: async p => new Uint8Array(fs.readFileSync(p)),   // netfs answers a Uint8Array
    writeFileExclusive: async (p, d) => { fs.writeFileSync(p, d, { flag: "wx" }); return true; },
    moveNoReplace: async (a, b) => moveNoReplace(fs, a, b),
    // As netfs's identity and unlinkFile (BigInt-exact; the real worker op is
    // tested in test/netfs/unlinkFile.test.js).
    identity: async p => { const s = fs.statSync(p, { bigint: true }); return { size: Number(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs), ino: String(s.ino), dev: String(s.dev) }; },
    unlinkFile: async (p, expect) => {
      const s = fs.lstatSync(p, { bigint: true });
      const now = { size: Number(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs), ino: String(s.ino), dev: String(s.dev) };
      if (!s.isFile() || ["size", "mtimeNs", "ctimeNs", "ino", "dev"].some(k => String(expect[k]) !== String(now[k]))) throw Object.assign(new Error("changed"), { code: "ECHANGED" });
      fs.unlinkSync(p); return true;
    },
  };
  return { ...io, ...overrides, _disk: io };
}
function folderWith(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-trash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const run = (folder, files, opts = {}) => fileTrash.deleteFiles({ io: opts.io || diskIo(), folder, files, allowed: SLICED, now: NOW, rand: () => "a1b2c3", ...opts });
const batchDir = folder => path.join(folder, ".snapcon-trash", "20261105T120000Z-a1b2c3");

test("a deleted file is moved into the trash under its own path, with a manifest", async t => {
  const folder = folderWith(t, { "U1/Parts/bracket.gcode": "G1 X1\n" });
  const out = await run(folder, [{ sub: "U1/Parts", name: "bracket.gcode" }], { actor: { userId: "u1", userLabel: "Eran" } });
  assert.deepEqual(out.results, [{ sub: "U1/Parts", name: "bracket.gcode", ok: true, path: "U1/Parts/bracket.gcode", batch: "20261105T120000Z-a1b2c3", mode: "trash" }]);
  assert.equal(fs.existsSync(path.join(folder, "U1/Parts/bracket.gcode")), false);
  assert.equal(fs.readFileSync(path.join(batchDir(folder), "files/U1/Parts/bracket.gcode"), "utf8"), "G1 X1\n");
  const m = JSON.parse(fs.readFileSync(path.join(batchDir(folder), "manifest.json"), "utf8"));
  assert.equal(m.expiresAt - m.deletedAt, 30 * DAY);
  assert.deepEqual(m.by, { userId: "u1", userLabel: "Eran" });
  assert.deepEqual(m.files.map(f => [f.path, f.size]), [["U1/Parts/bracket.gcode", 6]]);
  assert.equal(out.manifestError, null);
});

test("several files from different folders go into one deletion, and come back one by one", async t => {
  const folder = folderWith(t, { "a.gcode": "a", "U1/b.3mf": "bb", "U1/x/c.gx": "ccc" });
  const out = await run(folder, [{ sub: "", name: "a.gcode" }, { sub: "U1", name: "b.3mf" }, { sub: "U1/x", name: "c.gx" }]);
  assert.equal(out.results.filter(r => r.ok).length, 3);
  const listed = await fileTrash.listTrash({ io: diskIo(), folder, now: NOW });
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].files, [{ path: "U1/b.3mf", size: 2 }, { path: "U1/x/c.gx", size: 3 }, { path: "a.gcode", size: 1 }]);
  assert.equal(listed[0].expired, false);

  // The folder it came from was removed meanwhile: restore makes it again.
  fs.rmSync(path.join(folder, "U1"), { recursive: true });
  const r = await fileTrash.restoreFile({ io: diskIo(), folder, batch: listed[0].batch, file: "U1/x/c.gx" });
  assert.deepEqual(r, { ok: true, path: "U1/x/c.gx", sourceKept: false, visible: true });
  assert.equal(fs.readFileSync(path.join(folder, "U1/x/c.gx"), "utf8"), "ccc");
  // A restored file is no longer listed; the others still are.
  assert.deepEqual((await fileTrash.listTrash({ io: diskIo(), folder, now: NOW }))[0].files.map(f => f.path), ["U1/b.3mf", "a.gcode"]);
});

test("restore never writes over a file now at the original place", async t => {
  const folder = folderWith(t, { "a.gcode": "old" });
  await run(folder, [{ sub: "", name: "a.gcode" }]);
  fs.writeFileSync(path.join(folder, "a.gcode"), "new");
  const r = await fileTrash.restoreFile({ io: diskIo(), folder, batch: "20261105T120000Z-a1b2c3", file: "a.gcode" });
  assert.equal(r.ok, false); assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(path.join(folder, "a.gcode"), "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(batchDir(folder), "files/a.gcode"), "utf8"), "old");
});

test("restore refuses names that are not a file in that deletion", async t => {
  const folder = folderWith(t, { "a.gcode": "a" });
  await run(folder, [{ sub: "", name: "a.gcode" }]);
  for (const [batch, file] of [["../x", "a.gcode"], ["20261105T120000Z-a1b2c3", "../manifest.json"], ["20261105T120000Z-a1b2c3", "../../../a.gcode"],
                               ["20261105T120000Z-a1b2c3", ""], ["20261105T120000Z-a1b2c3", ".snapcon-trash/a.gcode"], ["20261105T120000Z-a1b2c3", "nope.gcode"]]) {
    const r = await fileTrash.restoreFile({ io: diskIo(), folder, batch, file });
    assert.equal(r.ok, false, batch + " " + file);
  }
  assert.ok(fs.existsSync(path.join(batchDir(folder), "manifest.json")));
});

test("nothing outside the G-code folder, in the trash, or not a print file is touched", async t => {
  const folder = folderWith(t, { "a.gcode": "a", "config.json": "{}", "dir.gcode/x.gcode": "x" });
  const outside = path.join(path.dirname(folder), path.basename(folder) + "-outside.gcode");
  fs.writeFileSync(outside, "o"); t.after(() => fs.rmSync(outside, { force: true }));
  await run(folder, [{ sub: "", name: "a.gcode" }]);
  const out = await run(folder, [
    { sub: "..", name: path.basename(outside) },
    { sub: "", name: "../" + path.basename(outside) },
    { sub: "", name: ".." },
    { sub: ".snapcon-trash/20261105T120000Z-a1b2c3/files", name: "a.gcode" },
    { sub: ".SNAPCON-TRASH", name: "manifest.gcode" },
    { sub: "", name: "config.json" },
    { sub: "", name: "dir.gcode" },
    { sub: "", name: "missing.gcode" },
    { name: 42 },
  ], { rand: () => "ffffff" });
  assert.deepEqual(out.results.map(r => r.code), ["invalid", "invalid", "invalid", "in_trash", "in_trash", "not_print_file", "not_a_file", "not_found", "invalid"]);
  assert.ok(out.results.every(r => !r.ok));
  assert.ok(fs.existsSync(outside) && fs.existsSync(path.join(folder, "config.json")) && fs.existsSync(path.join(folder, "dir.gcode/x.gcode")));
  assert.ok(fs.existsSync(path.join(batchDir(folder), "files/a.gcode")));
  assert.equal(out.batch, null, "no deletion folder is made when nothing is deleted");
});

test("a file in use is refused, and so is one that became in use while the delete waited", async t => {
  const folder = folderWith(t, { "a.gcode": "a", "b.gcode": "b", "c.gcode": "c" });
  const busy = new Set([path.join(folder, "a.gcode")]);
  // b becomes in use while its trash folder is being made: after the first
  // answer, before the rename.
  const io = diskIo();
  const mkdir = io.mkdir;
  io.mkdir = async (p, o) => { const r = await mkdir(p, o); if (p.endsWith(path.join("files"))) busy.add(path.join(folder, "b.gcode")); return r; };
  const asked = [];
  const out = await run(folder, [{ sub: "", name: "a.gcode" }, { sub: "", name: "b.gcode" }, { sub: "", name: "c.gcode" }], {
    io, inUse: fp => { asked.push(path.basename(fp)); return busy.has(fp) ? "It is in U1 Navy's queue." : null; },
  });
  assert.deepEqual(out.results.map(r => [r.name, r.ok, r.code || null]), [["a.gcode", false, "in_use"], ["b.gcode", false, "in_use"], ["c.gcode", true, null]]);
  assert.equal(out.results[0].error, "It is in U1 Navy's queue.");
  assert.ok(fs.existsSync(path.join(folder, "a.gcode")) && fs.existsSync(path.join(folder, "b.gcode")));
  assert.equal(fs.existsSync(path.join(folder, "c.gcode")), false);
  assert.deepEqual(asked, ["a.gcode", "b.gcode", "b.gcode", "c.gcode", "c.gcode"], "asked before, and again right before the rename");
});

test("one file failing never stops or changes the others", async t => {
  const folder = folderWith(t, { "a.gcode": "a", "b.gcode": "b", "c.gcode": "c" });
  const io = diskIo();
  io.rename = async (a, b) => { if (a.endsWith("b.gcode")) throw Object.assign(new Error("permission denied"), { code: "EACCES" }); return io._disk.rename(a, b); };
  const out = await run(folder, [{ sub: "", name: "a.gcode" }, { sub: "", name: "b.gcode" }, { sub: "", name: "c.gcode" }], { io });
  assert.deepEqual(out.results.map(r => r.ok), [true, false, true]);
  assert.equal(out.results[1].error, "permission denied");
  assert.ok(fs.existsSync(path.join(folder, "b.gcode")));
  const m = JSON.parse(fs.readFileSync(path.join(batchDir(folder), "manifest.json"), "utf8"));
  assert.deepEqual(m.files.map(f => f.path), ["a.gcode", "c.gcode"]);
});

test("a folder that stops answering leaves every later file untouched, and says which one is uncertain", async t => {
  const folder = folderWith(t, { "a.gcode": "a", "b.gcode": "b", "c.gcode": "c" });
  const io = diskIo();
  const renamed = [];
  io.rename = async (a, b) => {
    if (a.endsWith("b.gcode")) throw Object.assign(new Error("file operation did not answer within 15 s"), { code: "ETIMEDOUT" });
    renamed.push(path.basename(a)); return io._disk.rename(a, b);
  };
  const out = await run(folder, [{ sub: "", name: "a.gcode" }, { sub: "", name: "b.gcode" }, { sub: "", name: "c.gcode" }], { io });
  assert.deepEqual(out.results.map(r => r.code || "ok"), ["ok", "unknown", "not_attempted"]);
  assert.equal(out.unreachable, true);
  assert.deepEqual(renamed, ["a.gcode"]);
  assert.ok(fs.existsSync(path.join(folder, "c.gcode")));

  // Offline before anything was moved: nothing is attempted at all.
  const folder2 = folderWith(t, { "a.gcode": "a", "b.gcode": "b" });
  const off = diskIo({ stat: async () => { throw Object.assign(new Error("offline"), { code: "NAS_UNREACHABLE" }); } });
  const out2 = await run(folder2, [{ sub: "", name: "a.gcode" }, { sub: "", name: "b.gcode" }], { io: off });
  assert.deepEqual(out2.results.map(r => r.code), ["not_attempted", "not_attempted"]);
  assert.ok(fs.existsSync(path.join(folder2, "a.gcode")) && fs.existsSync(path.join(folder2, "b.gcode")));
});

test("a manifest that cannot be written loses no file: the trash still lists it by its path", async t => {
  const folder = folderWith(t, { "U1/a.gcode": "a" });
  const io = diskIo({ writeFileExclusive: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } });
  const out = await run(folder, [{ sub: "U1", name: "a.gcode" }], { io });
  assert.equal(out.results[0].ok, true);
  assert.equal(out.manifestError, "disk full");
  const listed = await fileTrash.listTrash({ io: diskIo(), folder, now: NOW });
  assert.equal(listed[0].manifest, false);
  assert.equal(listed[0].deletedAt, NOW);
  assert.equal(listed[0].expiresAt, NOW + 30 * DAY);
  assert.deepEqual(listed[0].files, [{ path: "U1/a.gcode", size: null }]);
});

test("two deletions never share a folder", async t => {
  const folder = folderWith(t, { "a.gcode": "a", "b.gcode": "b" });
  const rands = ["a1b2c3", "a1b2c3", "d4e5f6"];
  await run(folder, [{ sub: "", name: "a.gcode" }], { rand: () => rands.shift() });
  const out = await run(folder, [{ sub: "", name: "b.gcode" }], { rand: () => rands.shift() });
  assert.equal(out.batch, "20261105T120000Z-d4e5f6");
  const listed = await fileTrash.listTrash({ io: diskIo(), folder, now: NOW });
  assert.deepEqual(listed.map(b => b.files.map(f => f.path)), [["b.gcode"], ["a.gcode"]]);
});

test("after 30 days a deletion is reported expired, and nothing is purged", async t => {
  const folder = folderWith(t, { "a.gcode": "a" });
  await run(folder, [{ sub: "", name: "a.gcode" }]);
  const listed = await fileTrash.listTrash({ io: diskIo(), folder, now: NOW + 31 * DAY });
  assert.equal(listed[0].expired, true);
  assert.ok(fs.existsSync(path.join(batchDir(folder), "files/a.gcode")));
  assert.deepEqual(await fileTrash.listTrash({ io: diskIo(), folder: folderWith(t, {}), now: NOW }), [], "no trash yet: an empty list");
});

test("the same file listed twice is deleted once", async t => {
  const folder = folderWith(t, { "a.gcode": "a" });
  const out = await run(folder, [{ sub: "", name: "a.gcode" }, { sub: "", name: "a.gcode" }]);
  assert.deepEqual(out.results.map(r => r.code || "ok"), ["ok", "duplicate"]);
});

test("isInTrash and isTrashRel recognise the trash by its first segment only", () => {
  const f = path.resolve("/srv/gcode");
  assert.equal(fileTrash.isInTrash(path.join(f, ".snapcon-trash"), f), true);
  assert.equal(fileTrash.isInTrash(path.join(f, ".Snapcon-Trash", "x"), f), true);
  assert.equal(fileTrash.isInTrash(path.join(f, "U1", ".snapcon-trash"), f), false);
  assert.equal(fileTrash.isInTrash(path.join(f, ".snapcon-trash-old"), f), false);
  assert.equal(fileTrash.isInTrash(path.resolve("/elsewhere/.snapcon-trash"), f), false);
  assert.equal(fileTrash.isTrashRel(".snapcon-trash/a"), true);
  assert.equal(fileTrash.isTrashRel("a/.snapcon-trash"), false);
});

// ---- Races (owner review, 2026-11-05) ----

test("restore never overwrites a file created at the original place after its check", async t => {
  // The check said the place was free; another process wrote a file there
  // before the move. The restore is refused, both files intact.
  const folder = folderWith(t, { "a.gcode": "old" });
  await run(folder, [{ sub: "", name: "a.gcode" }]);
  const io = diskIo({ exists: async p => { const there = fs.existsSync(p); fs.writeFileSync(path.join(folder, "a.gcode"), "new, written meanwhile"); return there; } });
  const r = await fileTrash.restoreFile({ io, folder, batch: "20261105T120000Z-a1b2c3", file: "a.gcode" });
  assert.deepEqual([r.ok, r.status, r.code], [false, 409, "exists"]);
  assert.equal(fs.readFileSync(path.join(folder, "a.gcode"), "utf8"), "new, written meanwhile");
  assert.equal(fs.readFileSync(path.join(batchDir(folder), "files/a.gcode"), "utf8"), "old");
});

test("a file is reserved from its last in-use check until its rename has settled", async t => {
  const folder = folderWith(t, { "a.gcode": "a", "b.gcode": "b" });
  const log = [];
  const io = diskIo();
  io.rename = async (a, b) => { log.push("rename " + path.basename(a)); if (a.endsWith("b.gcode")) throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); return io._disk.rename(a, b); };
  await run(folder, [{ sub: "", name: "a.gcode" }, { sub: "", name: "b.gcode" }], {
    io,
    inUse: fp => { log.push("check " + path.basename(fp)); return null; },
    reserve: fp => log.push("reserve " + path.basename(fp)),
    release: (fp, outcome) => log.push("release " + path.basename(fp) + " " + outcome),
  });
  assert.deepEqual(log, [
    "check a.gcode", "check a.gcode", "reserve a.gcode", "rename a.gcode", "release a.gcode moved",
    "check b.gcode", "check b.gcode", "reserve b.gcode", "rename b.gcode", "release b.gcode unknown",
  ]);
});

// ---- Crash recovery: what is on disk is always enough ----

test("interrupted after the move, before the manifest: the file is listed and restorable", async t => {
  const folder = folderWith(t, { "U1/a.gcode": "a" });
  const crash = diskIo({ writeFileExclusive: () => new Promise(() => {}) });   // the process never gets past it
  run(folder, [{ sub: "U1", name: "a.gcode" }], { io: crash });
  for (let i = 0; i < 50 && fs.existsSync(path.join(folder, "U1/a.gcode")); i++) await new Promise(r => setTimeout(r, 5));
  // "After the restart": only the disk is left.
  const listed = await fileTrash.listTrash({ io: diskIo(), folder, now: NOW });
  assert.deepEqual(listed.map(b => [b.manifest, b.files.map(f => f.path)]), [[false, ["U1/a.gcode"]]]);
  const r = await fileTrash.restoreFile({ io: diskIo(), folder, batch: listed[0].batch, file: "U1/a.gcode" });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(folder, "U1/a.gcode"), "utf8"), "a");
});

test("interrupted before the move: the original is in place and the empty deletion is not listed", async t => {
  const folder = folderWith(t, { "a.gcode": "a" });
  fs.mkdirSync(path.join(folder, ".snapcon-trash", "20261105T115900Z-000000", "files"), { recursive: true });
  assert.deepEqual(await fileTrash.listTrash({ io: diskIo(), folder, now: NOW }), []);
  assert.ok(fs.existsSync(path.join(folder, "a.gcode")));
});

test("a manifest cut short is ignored: its files are still listed and restorable", async t => {
  const folder = folderWith(t, { "a.gcode": "a" });
  await run(folder, [{ sub: "", name: "a.gcode" }]);
  const m = path.join(batchDir(folder), "manifest.json");
  fs.writeFileSync(m, fs.readFileSync(m, "utf8").slice(0, 40));
  const listed = await fileTrash.listTrash({ io: diskIo(), folder, now: NOW });
  assert.deepEqual(listed.map(b => [b.manifest, b.files.map(f => f.path)]), [[false, ["a.gcode"]]]);
  assert.equal((await fileTrash.restoreFile({ io: diskIo(), folder, batch: listed[0].batch, file: "a.gcode" })).ok, true);
});

test("a restore cut short after the link leaves the file in both places; a second restore is refused", async t => {
  const folder = folderWith(t, { "a.gcode": "a" });
  await run(folder, [{ sub: "", name: "a.gcode" }]);
  // The hard link is made, the old name is never dropped (a crash between).
  const half = diskIo({ moveNoReplace: async (a, b) => { fs.linkSync(a, b); return { method: "link", sourceKept: true }; } });
  assert.equal((await fileTrash.restoreFile({ io: half, folder, batch: "20261105T120000Z-a1b2c3", file: "a.gcode" })).ok, true);
  assert.equal(fs.readFileSync(path.join(folder, "a.gcode"), "utf8"), "a");
  assert.deepEqual((await fileTrash.listTrash({ io: diskIo(), folder, now: NOW }))[0].files.map(f => f.path), ["a.gcode"]);
  assert.equal((await fileTrash.restoreFile({ io: diskIo(), folder, batch: "20261105T120000Z-a1b2c3", file: "a.gcode" })).code, "exists");
});

test("a restore the folder stopped answering during says so, and the file is still recoverable", async t => {
  const folder = folderWith(t, { "a.gcode": "a" });
  await run(folder, [{ sub: "", name: "a.gcode" }]);
  const down = diskIo({ moveNoReplace: async () => { throw Object.assign(new Error("offline"), { code: "NAS_UNREACHABLE" }); } });
  const r = await fileTrash.restoreFile({ io: down, folder, batch: "20261105T120000Z-a1b2c3", file: "a.gcode" });
  assert.deepEqual([r.ok, r.status, r.code], [false, 503, "unknown"]);
  assert.equal((await fileTrash.restoreFile({ io: diskIo(), folder, batch: "20261105T120000Z-a1b2c3", file: "a.gcode" })).ok, true);
});

// ---- A full disk ----

test("a full disk: the delete fails plainly, the original stays, nothing is reported deleted", async t => {
  const folder = folderWith(t, { "a.gcode": "a", "b.gcode": "b" });
  const full = diskIo({ mkdir: async () => { throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); } });
  const out = await run(folder, [{ sub: "", name: "a.gcode" }, { sub: "", name: "b.gcode" }], { io: full });
  assert.deepEqual(out.results.map(r => [r.ok, r.code, r.error]), [
    [false, "no_space", "Not deleted: the G-code folder's disk is full"],
    [false, "no_space", "Not deleted: the G-code folder's disk is full"],
  ]);
  assert.ok(fs.existsSync(path.join(folder, "a.gcode")) && fs.existsSync(path.join(folder, "b.gcode")));
  assert.equal(out.batch, null);
});

test("a full disk during a restore: refused plainly, the file stays in the trash", async t => {
  const folder = folderWith(t, { "a.gcode": "a" });
  await run(folder, [{ sub: "", name: "a.gcode" }]);
  const full = diskIo({ moveNoReplace: async () => { throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); } });
  const r = await fileTrash.restoreFile({ io: full, folder, batch: "20261105T120000Z-a1b2c3", file: "a.gcode" });
  assert.deepEqual([r.ok, r.status, r.code], [false, 507, "no_space"]);
  assert.equal(fs.existsSync(path.join(folder, "a.gcode")), false);
  assert.equal(fs.readFileSync(path.join(batchDir(folder), "files/a.gcode"), "utf8"), "a");
});

test("storage with no safe no-overwrite move: the restore is refused and nothing is written anywhere", async t => {
  const folder = folderWith(t, { "a.gcode": "a" });
  await run(folder, [{ sub: "", name: "a.gcode" }]);
  const noLinks = new Proxy(fs, { get: (o, k) => (k === "linkSync" ? () => { throw Object.assign(new Error("not supported"), { code: "EOPNOTSUPP" }); } : o[k]) });
  const io = diskIo({ moveNoReplace: async (a, b) => moveNoReplace(noLinks, a, b) });
  const r = await fileTrash.restoreFile({ io, folder, batch: "20261105T120000Z-a1b2c3", file: "a.gcode" });
  assert.deepEqual([r.ok, r.status, r.code], [false, 501, "restore_unsupported"]);
  assert.match(r.error, /still in the trash/);
  assert.equal(fs.existsSync(path.join(folder, "a.gcode")), false, "no placeholder, no partial file");
  assert.equal(fs.readFileSync(path.join(batchDir(folder), "files/a.gcode"), "utf8"), "a");
});

// ---- Delete permanently (owner, 2026-11-05) ----

test("permanent delete removes the files, makes no trash and no manifest, and says so per file", async t => {
  const folder = folderWith(t, { "a.gcode": "a", "U1/b.3mf": "b" });
  const out = await run(folder, [{ sub: "", name: "a.gcode" }, { sub: "U1", name: "b.3mf" }], { mode: "permanent" });
  assert.deepEqual(out.results.map(r => [r.path, r.ok, r.mode]), [["a.gcode", true, "permanent"], ["U1/b.3mf", true, "permanent"]]);
  assert.equal(fs.existsSync(path.join(folder, "a.gcode")) || fs.existsSync(path.join(folder, "U1/b.3mf")), false);
  assert.equal(fs.existsSync(path.join(folder, ".snapcon-trash")), false);
  assert.equal(out.batch, null);
});

test("permanent delete has the same refusals: outside, in the trash, not a print file, a folder, in use", async t => {
  const folder = folderWith(t, { "a.gcode": "a", "busy.gcode": "b", "notes.json": "{}", "dir.gcode/x.gcode": "x" });
  await run(folder, [{ sub: "", name: "a.gcode" }]);   // a.gcode is now in the trash
  const out = await run(folder, [
    { sub: "..", name: "x.gcode" },
    { sub: ".snapcon-trash/20261105T120000Z-a1b2c3/files", name: "a.gcode" },
    { sub: "", name: "notes.json" },
    { sub: "", name: "dir.gcode" },
    { sub: "", name: "busy.gcode" },
    { sub: "", name: "gone.gcode" },
  ], { mode: "permanent", inUse: fp => (fp.endsWith("busy.gcode") ? "It is in U1 Navy's queue." : null) });
  assert.deepEqual(out.results.map(r => r.code), ["invalid", "in_trash", "not_print_file", "not_a_file", "in_use", "not_found"]);
  assert.ok(fs.existsSync(path.join(batchDir(folder), "files/a.gcode")), "the trash is never touched");
  assert.ok(fs.existsSync(path.join(folder, "busy.gcode")) && fs.existsSync(path.join(folder, "notes.json")) && fs.existsSync(path.join(folder, "dir.gcode/x.gcode")));
});

test("permanent delete of a file replaced since it was checked removes nothing", async t => {
  const folder = folderWith(t, { "a.gcode": "a" });
  const io = diskIo();
  const unlink = io.unlinkFile;
  io.unlinkFile = async (p, expect) => { fs.writeFileSync(p, "someone else's new, longer file"); return unlink(p, expect); };
  const out = await run(folder, [{ sub: "", name: "a.gcode" }], { mode: "permanent", io });
  assert.deepEqual([out.results[0].ok, out.results[0].code], [false, "changed"]);
  assert.equal(fs.readFileSync(path.join(folder, "a.gcode"), "utf8"), "someone else's new, longer file");
});

test("permanent delete: a timeout is uncertain, never reported deleted, and later files are untouched", async t => {
  const folder = folderWith(t, { "a.gcode": "a", "b.gcode": "b", "c.gcode": "c" });
  const io = diskIo();
  const unlink = io.unlinkFile;
  io.unlinkFile = async (p, e) => { if (p.endsWith("b.gcode")) throw Object.assign(new Error("did not answer"), { code: "ETIMEDOUT" }); return unlink(p, e); };
  const released = [];
  const out = await run(folder, [{ sub: "", name: "a.gcode" }, { sub: "", name: "b.gcode" }, { sub: "", name: "c.gcode" }],
    { mode: "permanent", io, release: (fp, outcome) => released.push(path.basename(fp) + " " + outcome) });
  assert.deepEqual(out.results.map(r => [r.ok, r.code || "ok"]), [[true, "ok"], [false, "unknown"], [false, "not_attempted"]]);
  assert.match(out.results[1].error, /may be deleted or still in place/);
  assert.deepEqual(released, ["a.gcode moved", "b.gcode unknown"]);
  assert.ok(fs.existsSync(path.join(folder, "c.gcode")));
});

test("permanent delete: one failure never stops the others; a full disk or a lost share is said plainly", async t => {
  const folder = folderWith(t, { "a.gcode": "a", "b.gcode": "b", "c.gcode": "c" });
  const io = diskIo();
  const unlink = io.unlinkFile;
  io.unlinkFile = async (p, e) => { if (p.endsWith("b.gcode")) throw Object.assign(new Error("permission denied"), { code: "EACCES" }); return unlink(p, e); };
  const out = await run(folder, [{ sub: "", name: "a.gcode" }, { sub: "", name: "b.gcode" }, { sub: "", name: "c.gcode" }], { mode: "permanent", io });
  assert.deepEqual(out.results.map(r => r.ok), [true, false, true]);
  assert.ok(fs.existsSync(path.join(folder, "b.gcode")));
});

test("an unknown delete mode is refused before anything is touched", async t => {
  const folder = folderWith(t, { "a.gcode": "a" });
  await assert.rejects(run(folder, [{ sub: "", name: "a.gcode" }], { mode: "shred" }), /unknown delete mode/);
  assert.ok(fs.existsSync(path.join(folder, "a.gcode")));
});

// ---- Restore visibility (measured on a NAS share, 2026-11-05) ----

test("a restore is a restore even while the share does not show it yet; visibility is reported apart", async t => {
  const folder = folderWith(t, { "a.gcode": "a", "b.gcode": "b", "c.gcode": "c" });
  await run(folder, [{ sub: "", name: "a.gcode" }, { sub: "", name: "b.gcode" }, { sub: "", name: "c.gcode" }]);
  const B = "20261105T120000Z-a1b2c3";
  const flaky = (failures, code = "EINVAL") => {
    let n = 0; const slept = [];
    const io = diskIo({ stat: async p => { if (p.startsWith(path.join(folder, ".snapcon-trash"))) return diskIo().stat(p);
      if (n++ < failures) throw Object.assign(new Error(code), { code }); return diskIo().stat(p); } });
    return { io, slept, sleep: async ms => { slept.push(ms); } };
  };
  // EINVAL twice, then seen: visible, after two 250 ms waits.
  const f1 = flaky(2);
  const r1 = await fileTrash.restoreFile({ io: f1.io, folder, batch: B, file: "a.gcode", sleep: f1.sleep });
  assert.deepEqual([r1.ok, r1.visible], [true, true]);
  assert.deepEqual(f1.slept, [250, 250]);
  // EINVAL every time: still restored, reported not yet visible, after at most three looks.
  const f2 = flaky(99);
  const r2 = await fileTrash.restoreFile({ io: f2.io, folder, batch: B, file: "b.gcode", sleep: f2.sleep });
  assert.deepEqual([r2.ok, r2.visible], [true, false]);
  assert.deepEqual(f2.slept, [250, 250]);
  assert.equal(fs.readFileSync(path.join(folder, "b.gcode"), "utf8"), "b", "the file is really back");
  // Any other answer is not waited on.
  const f3 = flaky(99, "EACCES");
  const r3 = await fileTrash.restoreFile({ io: f3.io, folder, batch: B, file: "c.gcode", sleep: f3.sleep });
  assert.deepEqual([r3.ok, r3.visible], [true, false]);
  assert.deepEqual(f3.slept, []);
});

test("permanent delete hands the worker the file's identity, taken after it was found to be a file", async t => {
  const folder = folderWith(t, { "a.gcode": "a" });
  const seen = [];
  const io = diskIo();
  const unlink = io.unlinkFile;
  io.unlinkFile = async (p, expect) => { seen.push(Object.keys(expect).sort().join(",")); return unlink(p, expect); };
  const out = await run(folder, [{ sub: "", name: "a.gcode" }], { mode: "permanent", io });
  assert.equal(out.results[0].ok, true);
  assert.deepEqual(seen, ["ctimeNs,dev,ino,mtimeNs,size"]);
});
