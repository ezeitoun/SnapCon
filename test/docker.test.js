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

test("Audit: docker-compose.yml mounts the whole audit-data directory, not just the .db file", () => {
  const hosts = composeHostVolumePaths();
  assert.ok(hosts.includes("./audit-data"), "audit-data must be mounted as a directory (its WAL -wal/-shm sidecar files would be lost on container recreate if only audit.db itself were mounted) or the audit trail is wiped by recreating the container");
});

test("Queue: docker-compose.yml mounts the whole data directory, not a single queue-data.json file", () => {
  const hosts = composeHostVolumePaths();
  assert.ok(hosts.includes("./data"), "data must be mounted as a directory — queue-data.json's atomic temp-file-then-rename-with-backup sequence needs the temp file and the real file on the same underlying mount, or Queue Management state is wiped by recreating the container");
});

test("i18n: docker-compose.yml mounts the locales directory, or admin-added/edited languages are wiped by recreating the container", () => {
  const hosts = composeHostVolumePaths();
  assert.ok(hosts.includes("./locales"), "locales must be mounted as a directory — it's seeded once on first run and then holds every admin-added or admin-edited language; without this mount a container recreate reverts it to just the two bundled defaults");
});

test("i18n: Dockerfile COPYs locales-default (bundled originals, read via fs not require() so the C-1 require-graph check above can't catch a missing COPY here)", () => {
  const copied = dockerfileCopySources();
  assert.ok(copied.has("locales-default"), "locales-default must be COPYd or the container has nothing to seed BASE_DIR/locales/ from on first run");
});

// ---- Docker quality-of-life: ffmpeg, healthcheck, Docker Desktop, single data dir ----

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("Dockerfile: ffmpeg is a build option that defaults to on, tzdata always installed", () => {
  const df = read("Dockerfile");
  assert.match(df, /^ARG WITH_FFMPEG=true$/m);
  assert.match(df, /apk add --no-cache tzdata/);
  assert.match(df, /if \[ "\$WITH_FFMPEG" = "true" \]; then apk add --no-cache ffmpeg; fi/);
});

test("Dockerfile: the HEALTHCHECK script is copied into the image and used", () => {
  assert.ok(dockerfileCopySources().has("docker/healthcheck.js"));
  assert.match(read("Dockerfile"), /HEALTHCHECK [^\n]*\\\n\s*CMD \["node", "docker\/healthcheck\.js"\]/);
});

function runHealthcheck(env) {
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "docker", "healthcheck.js")], { env: { ...process.env, ...env } });
    child.on("exit", (code) => resolve(code));
  });
}

test("healthcheck: healthy only when /api/version answers 200 on config.json's port", async () => {
  const http = require("http");
  const os = require("os");
  let status = 200;
  const srv = http.createServer((req, res) => { res.statusCode = req.url === "/api/version" ? status : 404; res.end("{}"); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-hc-"));
  try {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: srv.address().port }));
    assert.equal(await runHealthcheck({ SNAPCON_DATA_DIR: dir }), 0, "answers → healthy");
    status = 503;
    assert.equal(await runHealthcheck({ SNAPCON_DATA_DIR: dir }), 1, "error status → unhealthy");
    const port = srv.address().port;
    await new Promise(r => srv.close(r));
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port }));
    assert.equal(await runHealthcheck({ SNAPCON_DATA_DIR: dir }), 1, "nothing listening → unhealthy");
  } finally {
    if (srv.listening) srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("docker-compose.yml: TZ, init and the ffmpeg build arg are wired; host networking stays the Linux default", () => {
  const c = read("docker-compose.yml");
  assert.match(c, /WITH_FFMPEG: \$\{SNAPCON_WITH_FFMPEG:-true\}/);
  assert.match(c, /TZ: \$\{TZ:-UTC\}/);
  assert.match(c, /^\s*init: true$/m);
  assert.match(c, /^\s*network_mode: host$/m);
});

test("docker-compose.desktop.yml: Docker Desktop switches to a bridge network and publishes the dashboard port", () => {
  const c = read("docker-compose.desktop.yml");
  assert.match(c, /^\s*network_mode: bridge$/m);
  assert.match(c, /-\s*"\$\{SNAPCON_PORT:-4545\}:4545"/);
});

test("docker-setup.sh creates every single-FILE bind-mount source as a file (not left for Docker to make a directory)", () => {
  const sh = read("docker-setup.sh");
  const hosts = composeHostVolumePaths().map(h => h.slice(2));
  for (const f of ["config.json", "users.json"]) {
    assert.ok(hosts.includes(f), "sanity: " + f + " is mounted");
    assert.match(sh, new RegExp("\\[ ! -e " + f.replace(".", "\\.") + " \\]"), f + " is created when missing");
  }
  for (const d of hosts.filter(h => !h.endsWith(".json"))) assert.match(sh, new RegExp("mkdir -p [^\\n]*\\b" + d + "\\b"), d + "/ is created");
  assert.match(sh, /"printers": \[\]/, "a fresh config has no placeholder printers");
});

test("server.js: SNAPCON_DATA_DIR moves the whole writable tree, and nothing changes when it is unset", () => {
  const src = read("server.js");
  assert.match(src, /const BASE_DIR = process\.env\.SNAPCON_DATA_DIR\s*\n\s*\? path\.resolve\(process\.env\.SNAPCON_DATA_DIR\)\s*\n\s*: \(IS_PKG \? path\.dirname\(process\.execPath\) : __dirname\);/);
  for (const c of ["CONFIG_PATH", "USERS_PATH", "QUEUED_FILE_PATH", "NOTIFY_TOKEN_PATH", "LOCALES_DIR"]) {
    assert.match(src, new RegExp("const " + c + " = path\\.join\\(BASE_DIR, "), c + " derives from BASE_DIR");
  }
});

// ---- Home Assistant add-on ----

test("HA add-on: a valid repository layout with the add-on in ha-addon/snapcon", () => {
  assert.match(read("repository.yaml"), /^name: .+$/m);
  const cfg = read("ha-addon/snapcon/config.yaml");
  for (const k of ["name", "version", "slug", "description", "arch"]) assert.match(cfg, new RegExp("^" + k + ":", "m"), k);
  assert.match(cfg, /^slug: snapcon$/m);
  assert.match(cfg, /^version: "([^"]+)"$/m);
  assert.equal(/^version: "([^"]+)"$/m.exec(cfg)[1], require(path.join(ROOT, "package.json")).version, "add-on version follows package.json");
  assert.match(cfg, /^host_network: true$/m, "LAN discovery and direct printer access");
  assert.match(cfg, /^webui: http:\/\/\[HOST\]:\[PORT:4545\]$/m);
  assert.doesNotMatch(cfg, /^ingress:/m, "the dashboard uses absolute /api paths, which ingress would break");
  assert.match(cfg, /- type: share\s*\n\s*read_only: false/);
});

test("HA add-on: all state in /data, G-code on /share, ffmpeg built in", () => {
  const run = read("ha-addon/snapcon/run.sh");
  assert.match(run, /export SNAPCON_DATA_DIR=\/data/);
  assert.match(run, /GCODE=\/share\/snapcon\/gcode/);
  assert.match(run, /exec node server\.js/);
  const df = read("ha-addon/snapcon/Dockerfile");
  // Not BUILD_FROM: Supervisor 2026.04+ ignores build.yaml and older ones
  // pass their Node-less Alpine base as BUILD_FROM ("npm: not found").
  assert.match(df, /^FROM node:22-alpine$/m);
  assert.doesNotMatch(df, /^(ARG BUILD_FROM|FROM \$)/m);
  assert.ok(!fs.existsSync(path.join(ROOT, "ha-addon", "snapcon", "build.yaml")), "build.yaml is no longer read — settings live in the Dockerfile");
  assert.match(df, /io\.hass\.version="\$\{BUILD_VERSION\}"/);
  assert.match(df, /io\.hass\.arch="\$\{BUILD_ARCH\}"/);
  assert.match(df, /apk add --no-cache tzdata ffmpeg/);
  assert.match(df, /if \[ -f \/addon\/app\/server\.js \]; then/, "a prepared local add-on uses its bundled app/");
  assert.match(df, /git clone --depth 1 --branch "\$SNAPCON_REF" "\$SNAPCON_REPO" \/app/);
  assert.match(df, /^ARG SNAPCON_REF=\S+$/m);
  assert.match(df, /^ARG SNAPCON_REPO=https:\/\/github\.com\/\S+\.git$/m);
  assert.ok(fs.statSync(path.join(ROOT, "ha-addon", "snapcon", "run.sh")).mode & 0o111, "run.sh is executable");
});

test("HA add-on: the local-add-on copy never includes personal files", () => {
  const sh = read("ha-addon/prepare-local-addon.sh");
  assert.match(sh, /git -C "\$ROOT" ls-files -z --cached --others --exclude-standard/, "only tracked or not-ignored files");
  const ignore = read(".gitignore");
  for (const f of ["config.json", "users.json", "notify-token.json", "remote-access-data/", "ha-addon/snapcon/app/", ".env"]) {
    assert.match(ignore, new RegExp("^" + f.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "$", "m"), f + " is git-ignored");
  }
});
