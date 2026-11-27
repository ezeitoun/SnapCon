// test/thirdPartyNotices.test.js — THIRD_PARTY_NOTICES.md reaches whoever
// receives SnapCon, in each form it ships in:
//   - the Docker image copies the file;
//   - the packaged binaries embed it (package.json pkg.assets);
//   - a running SnapCon serves it at /THIRD_PARTY_NOTICES.md, which is the only
//     way to read a file embedded in a binary.
// The licences it carries (the theme icons, the bundled font) ask for their
// notice to go with every copy, so a distribution without it is the failure
// these tests are for.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const NAME = "THIRD_PARTY_NOTICES.md";
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");

test("the Docker image copies the notices, and .dockerignore does not leave them out", () => {
  const copied = new Set();
  for (const line of read("Dockerfile").split("\n")) {
    const m = /^COPY\s+(.+)$/.exec(line.trim());
    if (m) for (const src of m[1].split(/\s+/).slice(0, -1)) copied.add(src);
  }
  assert.ok(copied.has(NAME), "the Dockerfile must COPY " + NAME);
  const ignored = read(".dockerignore").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  assert.ok(!ignored.some(p => p === NAME || p === "*.md" || p === "**/*.md"), ".dockerignore must not exclude it");
});

test("the packaged binaries embed the notices", () => {
  const assets = JSON.parse(read("package.json")).pkg.assets;
  assert.ok(assets.includes(NAME), "package.json pkg.assets must list " + NAME);
});

// The route as server.js registers it, run against a folder standing in for
// ASSET_DIR (where the image and the binary keep the file).
function serve(assetDir) {
  const src = read("server.js");
  const at = src.indexOf(`app.get("/${NAME}"`);
  assert.ok(at > 0, "server.js must serve /" + NAME);
  const routeSrc = src.slice(at, src.indexOf("\n});", at) + 4);
  let handlers = null;
  vm.runInNewContext(routeSrc, { app: { get: (p, ...h) => { handlers = h; } }, fs, path, ASSET_DIR: assetDir });
  assert.equal(handlers.length, 1, "served like the page itself: no sign-in in front of it");
  const out = { status: 200, type: null, body: null };
  const res = {
    status(c) { out.status = c; return res; },
    type(t) { out.type = t; return res; },
    send(b) { out.body = b; return res; },
  };
  handlers[0]({}, res);
  return out;
}

test("a running SnapCon serves the notices it was shipped with, as readable text", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notices-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shipped = read(NAME);
  fs.writeFileSync(path.join(dir, NAME), shipped);
  const out = serve(dir);
  assert.equal(out.status, 200);
  assert.equal(out.body, shipped, "the whole file, unchanged");
  assert.match(String(out.type), /^text\/plain/, "shown in the browser, not offered as a download");
});

test("a copy that lost the file answers 404 instead of failing", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notices-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = serve(dir);
  assert.equal(out.status, 404);
  assert.match(String(out.body), /THIRD_PARTY_NOTICES\.md/);
});
