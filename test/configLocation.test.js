// test/configLocation.test.js — where config.json lives (configLoader.js):
// SNAPCON_CONFIG_DIR, the start-up check that goes with it, keeping the
// owner when the file is replaced, and the single-file-mount warning's
// detection. Real files in temporary folders.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { resolveConfigLocation, checkConfigDir, readConfigStrict, existingInstallEvidence, isMountPoint, replaceConfigFile } = require("../configLoader");
const DEFAULTS = { gcodeFolder: "./gcode", port: 4545, printers: [] };

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-cfgloc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// An application folder with a settings folder inside it, as in the container.
function layout(t, { withDir = true } = {}) {
  const baseDir = tmp(t);
  const loc = resolveConfigLocation({ baseDir, env: { SNAPCON_CONFIG_DIR: path.join(baseDir, "config") } });
  if (withDir) fs.mkdirSync(loc.configDir);
  return { baseDir, ...loc, check: () => checkConfigDir({ ...loc, baseDir, defaultCfg: DEFAULTS }) };
}

test("without SNAPCON_CONFIG_DIR, config.json is beside the application, as before", () => {
  for (const env of [{}, { SNAPCON_CONFIG_DIR: "" }, { SNAPCON_CONFIG_DIR: "   " }]) {
    const loc = resolveConfigLocation({ baseDir: "/app", env });
    assert.deepEqual(loc, { configPath: path.join("/app", "config.json"), configDir: null, legacyPath: path.join("/app", "config.json") });
  }
});

test("SNAPCON_CONFIG_DIR moves config.json into that folder; a relative value is taken from the application folder", () => {
  const abs = resolveConfigLocation({ baseDir: "/app", env: { SNAPCON_CONFIG_DIR: "/srv/snapcon-settings" } });
  assert.equal(abs.configPath, path.join("/srv/snapcon-settings", "config.json"));
  assert.equal(abs.legacyPath, path.join("/app", "config.json"));
  const rel = resolveConfigLocation({ baseDir: "/app", env: { SNAPCON_CONFIG_DIR: "config" } });
  assert.equal(rel.configPath, path.join("/app", "config", "config.json"));
});

test("settings folder: a config.json in it starts normally, even with one left at the old place", t => {
  const l = layout(t);
  fs.writeFileSync(l.configPath, JSON.stringify({ usersEnabled: true, port: 4600 }));
  fs.writeFileSync(l.legacyPath, "{}");
  assert.deepEqual(l.check(), { ok: true, firstRun: false, load: { cfg: { usersEnabled: true, port: 4600 }, loadFailed: false, quarantinePath: null } },
    "the settings that were checked are the ones handed back to start with");
});

test("settings folder: empty folder and nothing else is a first run", t => {
  const l = layout(t);
  fs.writeFileSync(path.join(l.baseDir, "users.json"), "");          // the compose quick start's `touch users.json`
  fs.mkdirSync(path.join(l.baseDir, "data"));                        // mounted, empty
  fs.mkdirSync(path.join(l.baseDir, "remote-access-data"));
  assert.deepEqual(l.check(), { ok: true, firstRun: true, load: { cfg: DEFAULTS, loadFailed: false, quarantinePath: null } });
  assert.equal(fs.existsSync(l.configPath), false, "the check creates nothing");
});

test("settings folder: no config.json in it but one at the old place — refused, and nothing is touched", t => {
  const l = layout(t);
  fs.writeFileSync(l.legacyPath, JSON.stringify({ usersEnabled: true }));
  const r = l.check();
  assert.equal(r.ok, false);
  assert.equal(r.code, "config_not_migrated");
  assert.match(r.message, /docker-config-migration\.md/);
  assert.equal(fs.readFileSync(l.legacyPath, "utf8"), JSON.stringify({ usersEnabled: true }));
  assert.deepEqual(fs.readdirSync(l.configDir), []);
});

test("settings folder: no config.json anywhere, but user accounts exist — refused (defaults would switch sign-in off)", t => {
  const l = layout(t);
  fs.writeFileSync(path.join(l.baseDir, "users.json"), JSON.stringify({ users: [{ id: "u_sample", loginName: "sample", role: "admin" }] }));
  const r = l.check();
  assert.equal(r.ok, false);
  assert.equal(r.code, "config_missing_on_existing_install");
  assert.match(r.message, /users\.json/);
});

test("settings folder: a queue file or a Remote Access identity also marks a used installation; unreadable evidence counts as found", t => {
  const a = layout(t);
  fs.mkdirSync(path.join(a.baseDir, "data"));
  fs.writeFileSync(path.join(a.baseDir, "data", "queue-data.json"), "{}");
  assert.equal(a.check().code, "config_missing_on_existing_install");
  const b = layout(t);
  fs.mkdirSync(path.join(b.baseDir, "remote-access-data"));
  fs.writeFileSync(path.join(b.baseDir, "remote-access-data", "identity.json"), "{}");
  assert.equal(b.check().code, "config_missing_on_existing_install");
  const c = layout(t);
  fs.writeFileSync(path.join(c.baseDir, "users.json"), "{ not json");
  assert.match(existingInstallEvidence(c.baseDir), /users\.json/);
  assert.equal(existingInstallEvidence(tmp(t)), null);
});

test("settings folder: a config.json holding {} is the deliberate fresh start on a used installation", t => {
  const l = layout(t);
  fs.writeFileSync(path.join(l.baseDir, "users.json"), JSON.stringify({ users: [{ id: "u_sample" }] }));
  fs.writeFileSync(l.configPath, "{}");
  assert.deepEqual(l.check(), { ok: true, firstRun: false, load: { cfg: {}, loadFailed: false, quarantinePath: null } });
});

// A config.json that is THERE but cannot be used must never become "start
// with defaults": defaults have user accounts off. Each case is an
// installation with accounts whose settings move went wrong.
const USERS = JSON.stringify({ users: [{ id: "u_sample", loginName: "sample", role: "admin" }] });
const unusable = {
  "invalid JSON (cut short)": l => fs.writeFileSync(l.configPath, '{ "usersEnabled": true, "printers": ['),
  "an empty file": l => fs.writeFileSync(l.configPath, ""),
  "JSON that is not an object (array)": l => fs.writeFileSync(l.configPath, "[]"),
  "JSON that is not an object (null)": l => fs.writeFileSync(l.configPath, "null"),
  "a folder where the file should be": l => fs.mkdirSync(l.configPath),
  "a link to a file that does not exist": l => fs.symlinkSync(path.join(l.configDir, "gone.json"), l.configPath),
  "a link to a folder": l => { fs.mkdirSync(path.join(l.configDir, "d")); fs.symlinkSync(path.join(l.configDir, "d"), l.configPath); },
};
for (const [what, make] of Object.entries(unusable)) {
  test("settings folder: config.json present but unusable — " + what + " — refused, and left exactly as found", t => {
    const l = layout(t);
    fs.writeFileSync(path.join(l.baseDir, "users.json"), USERS);
    make(l);
    const before = fs.readdirSync(l.configDir).sort();
    const lst = fs.lstatSync(l.configPath);
    const bytes = lst.isFile() ? fs.readFileSync(l.configPath) : null;
    const r = l.check();
    assert.equal(r.ok, false);
    assert.equal(r.code, "config_unusable");
    assert.equal("load" in r, false, "no settings are handed back to start with");
    assert.match(r.message, /left exactly as it is/);
    assert.match(r.message, /docker-config-migration\.md/);
    assert.deepEqual(fs.readdirSync(l.configDir).sort(), before, "nothing set aside, nothing created");
    assert.equal(fs.lstatSync(l.configPath).ino, lst.ino, "not renamed or replaced");
    if (bytes) assert.deepEqual(fs.readFileSync(l.configPath), bytes);
  });
}

test("settings folder: an unusable config.json is refused even on an installation with no other trace of use", t => {
  const l = layout(t);
  fs.writeFileSync(l.configPath, "{ broken");
  assert.equal(l.check().code, "config_unusable");
});

test("settings folder: a config.json that cannot be read is refused (EACCES), and one that cannot be examined", t => {
  const l = layout(t);
  fs.writeFileSync(l.configPath, JSON.stringify({ usersEnabled: true }));
  const deny = code => Object.assign(new Error(code), { code });
  const real = fs.realpathSync(l.configPath);
  const noRead = { ...fs, readFileSync: (p, ...r) => { if (p === l.configPath || p === real) throw deny("EACCES"); return fs.readFileSync(p, ...r); } };
  const r = checkConfigDir({ ...l, defaultCfg: DEFAULTS, fsImpl: noRead });
  assert.equal(r.code, "config_unusable");
  assert.match(r.message, /EACCES/);
  const noStat = { ...fs, lstatSync: (p, ...r) => { if (p === l.configPath) throw deny("EIO"); return fs.lstatSync(p, ...r); } };
  assert.equal(checkConfigDir({ ...l, defaultCfg: DEFAULTS, fsImpl: noStat }).code, "config_unusable");
});

test("settings folder: config.json is read exactly once by the start-up check", t => {
  const l = layout(t);
  fs.writeFileSync(l.configPath, JSON.stringify({ usersEnabled: true }));
  let reads = 0;
  const counting = { ...fs, readFileSync: (p, ...r) => { if (p === l.configPath) reads++; return fs.readFileSync(p, ...r); } };
  const r = checkConfigDir({ ...l, defaultCfg: DEFAULTS, fsImpl: counting });
  assert.equal(r.load.cfg.usersEnabled, true);
  assert.equal(reads, 1);
});

test("readConfigStrict: a link to a good file is followed; missing means no entry at all", t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "real.json"), '{"a":1}');
  fs.symlinkSync(path.join(dir, "real.json"), path.join(dir, "config.json"));
  assert.deepEqual(readConfigStrict(path.join(dir, "config.json")), { state: "ok", cfg: { a: 1 } });
  assert.deepEqual(readConfigStrict(path.join(dir, "none.json")), { state: "missing" });
});

test("used-installation evidence is conservative: a users.json of another shape, or a non-empty folder in its place, counts; an empty folder or accounts list does not", t => {
  const mk = content => { const d = tmp(t); if (content !== undefined) fs.writeFileSync(path.join(d, "users.json"), content); return d; };
  assert.match(existingInstallEvidence(mk('{"users":"x"}')), /users\.json/);
  assert.match(existingInstallEvidence(mk("[]")), /users\.json/);
  assert.match(existingInstallEvidence(mk("null")), /users\.json/);
  assert.equal(existingInstallEvidence(mk('{"users":[]}')), null);
  assert.equal(existingInstallEvidence(mk("{}")), null);
  assert.equal(existingInstallEvidence(mk("  \n")), null);
  const emptyDir = tmp(t); fs.mkdirSync(path.join(emptyDir, "users.json"));
  assert.equal(existingInstallEvidence(emptyDir), null, "Docker's folder-for-a-missing-file, never used");
  const fullDir = tmp(t); fs.mkdirSync(path.join(fullDir, "users.json")); fs.writeFileSync(path.join(fullDir, "users.json", "x"), "1");
  assert.match(existingInstallEvidence(fullDir), /users\.json/);
});

test("settings folder: missing, or not a folder — refused and not created", t => {
  const l = layout(t, { withDir: false });
  assert.equal(l.check().code, "config_dir_missing");
  assert.equal(fs.existsSync(l.configDir), false);
  fs.writeFileSync(l.configDir, "a file");
  assert.equal(l.check().code, "config_dir_not_a_folder");
});

test("isMountPoint: reads the mount table; escaped spaces; null where there is no table", t => {
  const dir = tmp(t);
  const table = path.join(dir, "mountinfo");
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, "{}");
  const spaced = path.join(dir, "with space");
  fs.mkdirSync(spaced);
  fs.writeFileSync(table, [
    "36 35 98:0 / / rw - ext4 /dev/root rw",
    "40 36 8:2 /x/config.json " + fs.realpathSync(file) + " rw,relatime - ext4 /dev/sda2 rw",
    "41 36 8:2 /y " + fs.realpathSync(spaced).replace(/ /g, "\\040") + " rw - ext4 /dev/sda2 rw",
    "",
  ].join("\n"));
  assert.equal(isMountPoint(file, { mountinfoPath: table }), true);
  assert.equal(isMountPoint(spaced, { mountinfoPath: table }), true);
  assert.equal(isMountPoint(dir, { mountinfoPath: table }), false);
  assert.equal(isMountPoint(file, { mountinfoPath: path.join(dir, "none") }), null);
});

test("replaceConfigFile: the new file is given the old one's owner and group when they are not the process's own", t => {
  const dir = tmp(t);
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, "{}", { mode: 0o640 });
  const chowns = [];
  const fsImpl = { ...fs,
    statSync: (p, ...r) => { const st = fs.statSync(p, ...r); return p === fs.realpathSync(file) ? Object.assign(Object.create(st), { mode: st.mode, uid: st.uid + 1, gid: st.gid + 1, isDirectory: () => false }) : st; },
    chownSync: (p, uid, gid) => { chowns.push([path.basename(p), uid - process.getuid(), gid - process.getgid()]); const e = new Error("EPERM"); e.code = "EPERM"; throw e; },
  };
  replaceConfigFile(file, '{"a":1}', { fsImpl });
  assert.deepEqual(chowns, [["config.json.tmp", 1, 1]], "asked for on the temporary file, before the rename; a refusal does not fail the save");
  assert.equal(fs.readFileSync(file, "utf8"), '{"a":1}');
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});

test("replaceConfigFile: no ownership change is attempted when the file is already the process's own", t => {
  const dir = tmp(t);
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, "{}");
  let asked = 0;
  replaceConfigFile(file, '{"a":2}', { fsImpl: { ...fs, chownSync: () => { asked++; } } });
  assert.equal(asked, 0);
});

// The real process: server.js with a settings folder must stop before it
// loads or serves anything. Run from a copy-free scratch application folder
// is not possible (server.js takes its folder from where it is), so this
// uses SNAPCON_CONFIG_DIR pointing at a folder that does not exist — the one
// refusal that depends on nothing beside the application.
test("server.js exits with code 78 and an explanation when the settings folder is missing, in server and --load mode", async t => {
  const missing = path.join(tmp(t), "no-such-folder");
  const run = args => new Promise(resolve => execFile(process.execPath, [path.join(__dirname, "..", "server.js"), ...args],
    { env: { ...process.env, SNAPCON_CONFIG_DIR: missing }, cwd: os.tmpdir(), timeout: 60000 }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stdout, stderr })));
  for (const args of [[], ["--load", "x.gcode"]]) {
    const r = await run(args);
    assert.equal(r.code, 78, r.stderr);
    assert.match(r.stderr, /SNAPCON_CONFIG_DIR is set to/);
    assert.doesNotMatch(r.stdout, /SnapCon running|http:\/\//);
  }
  assert.equal(fs.existsSync(missing), false);
});

// The real process, with a settings folder whose config.json is there but
// broken. If it went on to start it would use defaults: accounts off, and a
// listener. It must stop first, and leave the folder exactly as it was.
test("server.js with an unusable config.json in the settings folder: exits 78 before listening, serving or writing, in server and --load mode", async t => {
  const dir = tmp(t);
  const file = path.join(dir, "config.json");
  const broken = '{ "usersEnabled": true, "port": 4545, "printers": [';
  fs.writeFileSync(file, broken);
  const ino = fs.statSync(file).ino;
  const run = args => new Promise(resolve => execFile(process.execPath, [path.join(__dirname, "..", "server.js"), ...args],
    { env: { ...process.env, SNAPCON_CONFIG_DIR: dir }, cwd: os.tmpdir(), timeout: 60000 }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stdout, stderr })));
  for (const args of [[], ["--load", "x.gcode"]]) {
    const r = await run(args);
    assert.equal(r.code, 78, r.stderr);
    assert.match(r.stderr, /cannot be used: it is not valid JSON/);
    assert.match(r.stderr, /left exactly as it is/);
    assert.doesNotMatch(r.stdout + r.stderr, /SnapCon running|http:\/\/|EADDRINUSE|starting with defaults/);
  }
  assert.deepEqual(fs.readdirSync(dir), ["config.json"], "nothing set aside, no temporary file");
  assert.equal(fs.readFileSync(file, "utf8"), broken);
  assert.equal(fs.statSync(file).ino, ino);
});

test("server.js: the first loadConfig() starts from the settings the start-up check read, and a settings-folder reload never takes defaults", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const fn = src.slice(src.indexOf("function loadConfig() {"), src.indexOf("// Best-effort create."));
  assert.match(fn, /let result = CONFIG_START_LOAD;\s*CONFIG_START_LOAD = null;/);
  const dirBranch = fn.slice(fn.indexOf("if (CONFIG_LOCATION.configDir) {"), fn.indexOf("} else result = loadConfigFile("));
  assert.match(dirBranch, /readConfigStrict\(CONFIG_PATH\)/);
  assert.match(dirBranch, /CONFIG_LOAD_FAILED = true;\s*return;/);
  assert.doesNotMatch(dirBranch, /loadConfigFile|DEFAULT_CFG/);
  assert.ok(src.indexOf("CONFIG_START_LOAD = check.load;") < src.indexOf("\nloadConfig();"), "checked before the first load");
  assert.ok(src.indexOf("process.exit(78)") < src.indexOf("\nloadConfig();"));
});
