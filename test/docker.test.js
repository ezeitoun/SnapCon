// test/docker.test.js — static regression tests for C-1 (Dockerfile missing
// COPY lines for modules server.js actually requires — the container crashed
// on startup with "Cannot find module './auth'") and H-3 (docker-compose.yml
// only mounted config.json/gcode, so recreating the container silently wiped
// users.json and Remote Access's identity/token).
//
// These are static/textual checks, not a real `docker build`/`docker compose
// up` — Docker isn't assumed to be installed wherever this suite runs. The
// C-1 test derives its expectation from server.js's own require() graph
// (rather than hardcoding today's fix), so it keeps catching this class of
// regression if a future top-level module is added and the Dockerfile isn't
// updated to match.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function resolveLocalRequire(fromFile, spec) {
  const p = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  if (fs.existsSync(p + ".js")) return p + ".js";
  if (fs.existsSync(path.join(p, "index.js"))) return path.join(p, "index.js");
  return null;
}

function findLocalRequireSpecs(file) {
  const text = fs.readFileSync(file, "utf8");
  const specs = [];
  const re = /require\(\s*["'](\.[^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(text))) specs.push(m[1]);
  return specs;
}

// Only follows relative (".", "..") require()s — express/fs/path/os/crypto/
// etc. are node_modules/builtins and irrelevant to "which local source files
// does the image need."
function transitiveLocalDeps(entryFile) {
  const seen = new Set();
  const queue = [entryFile];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of findLocalRequireSpecs(file)) {
      const resolved = resolveLocalRequire(file, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

// The path component a Dockerfile COPY needs to cover for `absFile` to end
// up in the image — e.g. ".../connectors/http-utils.js" -> "connectors",
// ".../auth.js" -> "auth.js".
function topLevelComponent(absFile) {
  return path.relative(ROOT, absFile).split(path.sep)[0];
}

function dockerfileCopySources() {
  const text = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const sources = new Set();
  for (const line of text.split(/\r?\n/)) {
    // "COPY <src...> <dest>" — dest is always the last whitespace-separated
    // token; everything before it is one or more source paths.
    const m = line.match(/^\s*COPY\s+(.+?)\s+\S+\s*$/);
    if (!m) continue;
    for (const src of m[1].trim().split(/\s+/)) sources.add(src.replace(/\/$/, ""));
  }
  return sources;
}

test("C-1: Dockerfile COPYs every local module server.js transitively requires", () => {
  const deps = transitiveLocalDeps(path.join(ROOT, "server.js"));
  const copied = dockerfileCopySources();

  const missing = [];
  for (const dep of deps) {
    const top = topLevelComponent(dep);
    if (!copied.has(top)) missing.push(path.relative(ROOT, dep) + " (needs a COPY covering '" + top + "')");
  }
  assert.deepEqual(missing, [], "Dockerfile is missing a COPY for: " + missing.join(", "));
});

test("C-1: Dockerfile still copies server.js, parser.js, and public/ (sanity — didn't just delete the old COPY line)", () => {
  const copied = dockerfileCopySources();
  assert.ok(copied.has("server.js"));
  assert.ok(copied.has("parser.js"));
  assert.ok(copied.has("public"));
});

function composeHostVolumePaths() {
  const text = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  const hosts = [];
  const re = /^\s*-\s*(\.\/[^\s:]+):/gm;
  let m;
  while ((m = re.exec(text))) hosts.push(m[1]);
  return hosts;
}

test("H-3: docker-compose.yml persists users.json and remote-access-data, not just config.json/gcode", () => {
  const hosts = composeHostVolumePaths();
  assert.ok(hosts.includes("./config.json"), "sanity: the pre-existing config.json mount must still be there");
  assert.ok(hosts.includes("./gcode"), "sanity: the pre-existing gcode mount must still be there");
  assert.ok(hosts.includes("./users.json"), "users.json must be mounted or User Access Management accounts are wiped by recreating the container");
  assert.ok(hosts.includes("./remote-access-data"), "remote-access-data must be mounted or Remote Access's identity/token is orphaned by recreating the container");
});
