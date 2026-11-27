// test/library/locations.test.js — Library location paths: normalising,
// overlap refusal, and the reachability check (§4, §10).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeLocation, overlaps, checkReachable } = require("../../library/locations");

const B = "\\";
const win = p => normalizeLocation(p, { baseDir: "C:\\SnapCon", platform: "win32" });

test("Windows paths: either slash, UNC shares kept, trailing separators dropped, relative resolved", () => {
  assert.equal(win("//nas/Models/"), B + B + "nas" + B + "Models");
  assert.equal(win(B + B + "nas" + B + "Models" + B), B + B + "nas" + B + "Models");
  assert.equal(win(B + B + "198.51.100.7" + B + "Storage" + B + "Files" + B + B), B + B + "198.51.100.7" + B + "Storage" + B + "Files");
  assert.equal(win("D:/Models/"), "D:\\Models");
  assert.equal(win("D:\\"), "D:\\", "a drive root keeps its separator");
  assert.equal(win("models"), "C:\\SnapCon\\models");
  assert.equal(win('"D:\\My Models"'), "D:\\My Models", "pasted quotes are removed");
  assert.equal(win("   "), "");
});

test("POSIX paths", () => {
  const nx = p => normalizeLocation(p, { baseDir: "/app", platform: "linux" });
  assert.equal(nx("/mnt/models/"), "/mnt/models");
  assert.equal(nx("models"), "/app/models");
  assert.equal(nx("/"), "/");
});

test("overlap: the same folder, a parent or a child — but not a sibling that shares a prefix", () => {
  const W = "win32";
  assert.equal(overlaps("\\\\nas\\Models", "\\\\nas\\Models", W), true);
  assert.equal(overlaps("\\\\nas\\Models\\Dragons", "\\\\nas\\Models", W), true, "child");
  assert.equal(overlaps("\\\\nas\\Models", "\\\\nas\\Models\\Dragons", W), true, "parent");
  assert.equal(overlaps("\\\\NAS\\models", "\\\\nas\\Models", W), true, "Windows names are case-insensitive");
  assert.equal(overlaps("\\\\nas\\Models2", "\\\\nas\\Models", W), false, "a sibling with a common prefix is not inside it");
  assert.equal(overlaps("D:\\", "D:\\Models", W), true, "a drive root contains everything on it");
  assert.equal(overlaps("/mnt/Models", "/mnt/models", "linux"), false, "Linux names are case-sensitive");
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-loc-"));

test("reachable: a readable folder is ok", async () => {
  const d = tmp();
  const r = await checkReachable(d);
  assert.equal(r.status, "ok");
  assert.ok(r.realPath);
});

test("error, not offline: a missing folder whose parent answers, or a file", async () => {
  const d = tmp();
  assert.equal((await checkReachable(path.join(d, "gone"))).status, "error");
  fs.writeFileSync(path.join(d, "f.txt"), "x");
  const r = await checkReachable(path.join(d, "f.txt"));
  assert.equal(r.status, "error");
  assert.equal(r.code, "ENOTDIR");
});

test("offline: neither the folder nor its parent answers", async () => {
  const d = tmp();
  const r = await checkReachable(path.join(d, "no-share", "models"));
  assert.equal(r.status, "offline");
});

test("offline: a share that hangs is cut off at the timeout", async () => {
  const never = new Promise(() => {});
  const fsp = { stat: () => never, opendir: () => never, realpath: () => never };
  const t0 = Date.now();
  const r = await checkReachable("\\\\dead\\share", { timeoutMs: 150, fsp });
  assert.equal(r.status, "offline");
  assert.equal(r.code, "ETIMEDOUT");
  assert.ok(Date.now() - t0 < 1000);
});

test("a symlink or junction resolves to where it really points", async () => {
  const d = tmp();
  const target = path.join(d, "real"); fs.mkdirSync(target);
  const link = path.join(d, "link");
  try { fs.symlinkSync(target, link, "junction"); } catch (e) { return; }   // no symlink rights: skip
  const r = await checkReachable(link);
  assert.equal(r.status, "ok");
  assert.equal(path.resolve(r.realPath).toLowerCase(), path.resolve(fs.realpathSync(target)).toLowerCase());
});
