// test/fileSearchScope.test.js — the file browser's search looks in the folder
// being shown and below it, not in the whole G-code folder.
//
// Reported: searching while inside the U1 folder also listed files from the I7
// and 5M Pro folders. The route always walked the G-code folder's top and the
// browser never said which folder it was showing.
//
// The route is run from server.js's own source (server.js has no exports and
// starts a listener; see fileDeleteRoute.test.js) against a real folder and
// the real netfs walk.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const { routeEnd } = require("./helpers/routeEnd");
const { resolveWithinFolder, isPathWithinFolder } = require("../pathSafety");
const fileTrash = require("../fileTrash");
const { getNetFs } = require("../netfs");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

function makeFolder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-search-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const rel of [
    "benchy.gcode", "U1/benchy-u1.gcode", "U1/Deep/benchy-deep.3mf", "U1/other.gcode",
    "I7/benchy-i7.gcode", "5MPro/benchy-5m.gx", "U1-old/benchy-old.gcode",
    fileTrash.TRASH_DIR + "/files/benchy-trashed.gcode",
  ]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), "x");
  }
  return dir;
}

function searchRoute(FOLDER, netfs = getNetFs()) {
  let handler = null;
  const at = serverSrc.indexOf('app.get("/api/files/search"');
  assert.ok(at > 0, "the search route must exist");
  const sandbox = {
    path, FOLDER, netfs, requireAuth: () => {}, isPathWithinFolder, fileTrash,
    SLICED_FILE_RE: /\.(gcode|gco|g|gx|3mf)$/i,
    safePath: sub => { const fp = resolveWithinFolder(sub, FOLDER); return fp && !fileTrash.isInTrash(fp, FOLDER) ? fp : null; },
    replyIfNasDown: () => false,
    app: { get: (p, mw, h) => { handler = h; } },
  };
  vm.createContext(sandbox);
  vm.runInContext(serverSrc.slice(at, routeEnd(serverSrc, at) + 4), sandbox);
  return async query => {
    const out = { status: 200, body: null };
    const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
    await handler({ query }, res);
    return out;
  };
}
const paths = out => out.body.files.map(f => (f.sub ? f.sub + "/" : "") + f.name).sort();

test("a search inside a folder returns only files in it and below it", async t => {
  const search = searchRoute(makeFolder(t));
  const out = await search({ q: "benchy", sub: "U1" });
  assert.equal(out.status, 200);
  assert.deepEqual(paths(out), ["U1/Deep/benchy-deep.3mf", "U1/benchy-u1.gcode"],
    "nothing from I7, 5MPro, the top, or a folder whose name merely starts with U1");
});

test("results keep their path from the G-code folder, so they can be selected", async t => {
  const search = searchRoute(makeFolder(t));
  const out = await search({ q: "deep", sub: "U1" });
  assert.deepEqual(out.body.files.map(f => [f.sub, f.name]), [["U1/Deep", "benchy-deep.3mf"]]);
  const nested = await search({ q: "benchy", sub: "U1/Deep" });
  assert.deepEqual(nested.body.files.map(f => [f.sub, f.name]), [["U1/Deep", "benchy-deep.3mf"]]);
});

test("at the top of the G-code folder the search still covers every folder", async t => {
  const search = searchRoute(makeFolder(t));
  const all = ["5MPro/benchy-5m.gx", "I7/benchy-i7.gcode", "U1-old/benchy-old.gcode", "U1/Deep/benchy-deep.3mf", "U1/benchy-u1.gcode", "benchy.gcode"];
  assert.deepEqual(paths(await search({ q: "benchy" })), all);
  assert.deepEqual(paths(await search({ q: "benchy", sub: "" })), all);
});

test("a folder outside the G-code folder, or the trash, is refused", async t => {
  const search = searchRoute(makeFolder(t));
  for (const sub of ["..", "../..", "U1/../..", fileTrash.TRASH_DIR, fileTrash.TRASH_DIR + "/files"]) {
    const out = await search({ q: "benchy", sub });
    assert.equal(out.status, 400, sub);
    assert.equal(out.body.files, undefined, sub);
  }
});

test("a folder that does not exist gives no results rather than an error", async t => {
  const search = searchRoute(makeFolder(t));
  const out = await search({ q: "benchy", sub: "Gone" });
  assert.equal(out.status, 200);
  assert.equal(out.body.files.length, 0);
});

// ---- links: the starting folder is checked by where it really is ----
// The path check before this compares text only, and the walk reads the folder
// it is given. Searching the whole G-code folder never followed a link.
function withLinks(t) {
  const dir = makeFolder(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-search-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outside, "Inner"));
  fs.writeFileSync(path.join(outside, "benchy-outside.gcode"), "x");
  fs.writeFileSync(path.join(outside, "Inner", "benchy-outside-inner.gcode"), "x");
  const link = (target, at) => fs.symlinkSync(target, path.join(dir, at), "dir");
  try {
    link(outside, "alias");                                            // the folder itself is a link out
    link(outside, "U1/way-out");                                       // a link on the way: U1/way-out/Inner
    link(path.join(dir, fileTrash.TRASH_DIR), "bin");                  // a link into the trash
    link(path.join(dir, fileTrash.TRASH_DIR, "files"), "U1/bin-files");
    link(path.join(dir, "I7"), "U1/to-i7");                            // a link to a folder inside
  } catch (e) { if (e.code === "EPERM") { t.skip("cannot create links here"); return null; } throw e; }
  return dir;
}

test("a folder that is a link to somewhere outside the G-code folder is refused", async t => {
  const dir = withLinks(t); if (!dir) return;
  const out = await searchRoute(dir)({ q: "benchy", sub: "alias" });
  assert.equal(out.status, 400);
  assert.equal(out.body.files, undefined, "nothing outside the G-code folder is listed");
});

test("a folder reached through a link out of the G-code folder is refused", async t => {
  const dir = withLinks(t); if (!dir) return;
  const search = searchRoute(dir);
  for (const sub of ["alias/Inner", "U1/way-out", "U1/way-out/Inner"]) {
    const out = await search({ q: "benchy", sub });
    assert.equal(out.status, 400, sub);
    assert.equal(out.body.files, undefined, sub);
  }
});

test("a link into the trash is refused", async t => {
  const dir = withLinks(t); if (!dir) return;
  const search = searchRoute(dir);
  for (const sub of ["bin", "bin/files", "U1/bin-files"]) {
    const out = await search({ q: "benchy", sub });
    assert.equal(out.status, 400, sub);
    assert.equal(out.body.files, undefined, sub);
  }
});

test("links below the searched folder are still not followed", async t => {
  const dir = withLinks(t); if (!dir) return;
  const search = searchRoute(dir);
  assert.deepEqual(paths(await search({ q: "benchy", sub: "U1" })), ["U1/Deep/benchy-deep.3mf", "U1/benchy-u1.gcode"]);
  assert.ok(!paths(await search({ q: "benchy" })).some(p => /outside|trashed|to-i7|alias|bin/.test(p)));
});

test("a link to another folder inside the G-code folder can be searched, under the path it was opened by", async t => {
  const dir = withLinks(t); if (!dir) return;
  const out = await searchRoute(dir)({ q: "benchy", sub: "U1/to-i7" });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.files.map(f => [f.sub, f.name]), [["U1/to-i7", "benchy-i7.gcode"]]);
});

test("the G-code folder itself may be reached through a link", async t => {
  const dir = makeFolder(t);
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-search-holder-"));
  t.after(() => fs.rmSync(holder, { recursive: true, force: true }));
  try { fs.symlinkSync(dir, path.join(holder, "gcode"), "dir"); } catch (e) { if (e.code === "EPERM") return t.skip("cannot create links here"); throw e; }
  const search = searchRoute(path.join(holder, "gcode"));
  assert.deepEqual(paths(await search({ q: "benchy", sub: "U1" })), ["U1/Deep/benchy-deep.3mf", "U1/benchy-u1.gcode"]);
  // ...and the trash is still found by where it really is.
  fs.symlinkSync(path.join(dir, fileTrash.TRASH_DIR, "files"), path.join(dir, "U1", "bin-files"), "dir");
  const out = await search({ q: "benchy", sub: "U1/bin-files" });
  assert.equal(out.status, 400);
  assert.equal(out.body.files, undefined);
});

test("an unreachable G-code folder is reported as such, not as an invalid or empty folder", async t => {
  const dir = makeFolder(t);
  const down = Object.assign(new Error("down"), { code: "NAS_UNREACHABLE" });
  let handler = null;
  const at = serverSrc.indexOf('app.get("/api/files/search"');
  const sandbox = {
    path, FOLDER: dir, requireAuth: () => {}, isPathWithinFolder, fileTrash, SLICED_FILE_RE: /\.gcode$/i,
    netfs: { realpath: async () => { throw down; }, walk: async () => { throw down; } },
    safePath: sub => resolveWithinFolder(sub, dir),
    replyIfNasDown: (res, e) => { if (!e || e.code !== "NAS_UNREACHABLE") return false; res.status(503).json({ code: "gcode_folder_unreachable" }); return true; },
    app: { get: (p, mw, h) => { handler = h; } },
  };
  vm.createContext(sandbox);
  vm.runInContext(serverSrc.slice(at, routeEnd(serverSrc, at) + 4), sandbox);
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
  await handler({ query: { q: "benchy", sub: "U1" } }, res);
  assert.equal(out.status, 503);
  assert.equal(out.body.code, "gcode_folder_unreachable");
});

// ---- the browser: runSearch(), run from app.js's own source ----
function runSearchHarness() {
  const at = appSrc.indexOf("async function runSearch(");
  assert.ok(at > 0, "runSearch must exist in public/app.js");
  const src = appSrc.slice(at, appSrc.indexOf("\n}", at) + 2);
  const sandbox = {
    CURRENT_SUB: "", SEARCH_RESULTS: null, renders: 0, urls: [], pending: [], box: { value: "" },
    encodeURIComponent,
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    var $ = id => { if (id !== "filter") throw new Error("unexpected element " + id); return box; };
    var getJSON = url => { urls.push(url); return new Promise((resolve, reject) => pending.push({ resolve, reject })); };
    var renderList = () => { renders++; };
  ` + src, sandbox);
  return sandbox;
}

test("the browser asks for the folder it is showing", async () => {
  const s = runSearchHarness();
  s.CURRENT_SUB = "U1/Deep & more"; s.box.value = "benchy";
  const done = vm.runInContext('runSearch("benchy")', s);
  assert.deepEqual([...s.urls], ["/api/files/search?q=benchy&sub=" + encodeURIComponent("U1/Deep & more")]);
  s.pending[0].resolve({ files: [{ name: "a.gcode", sub: "U1/Deep & more" }] });
  await done;
  assert.equal(s.SEARCH_RESULTS.length, 1);
  assert.equal(s.renders, 1);
});

test("an answer that arrives after another folder was opened is dropped", async () => {
  const s = runSearchHarness();
  s.CURRENT_SUB = "U1"; s.box.value = "benchy";
  const done = vm.runInContext('runSearch("benchy")', s);
  s.CURRENT_SUB = "I7";                       // the user opened another folder meanwhile
  s.pending[0].resolve({ files: [{ name: "benchy-u1.gcode", sub: "U1" }] });
  await done;
  assert.equal(s.SEARCH_RESULTS, null, "results for U1 must not be shown as I7's");
  assert.equal(s.renders, 0);
});

test("an answer for a search text that has since changed is still dropped", async () => {
  const s = runSearchHarness();
  s.CURRENT_SUB = "U1"; s.box.value = "benchy";
  const done = vm.runInContext('runSearch("benchy")', s);
  s.box.value = "bracket";
  s.pending[0].resolve({ files: [{ name: "benchy-u1.gcode", sub: "U1" }] });
  await done;
  assert.equal(s.SEARCH_RESULTS, null);
  assert.equal(s.renders, 0);
});

test.after(async () => { try { await getNetFs().stop(); } catch {} });
