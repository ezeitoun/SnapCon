// tools/refactor/harness/run.js — host side of the contract harness. From an
// approved refactor worktree only (guard), it:
//   1. builds the harness image (pinned base; the build's `npm ci` of the
//      app's lock file is the only network use),
//   2. exports a commit with `git archive` into a guard temp folder,
//   3. runs ONE container per run with --network none, read-only root, no
//      capabilities, resource limits, the source mounted read-only and only
//      the run's own out folder writable. No host network, no production
//      mounts, no Docker socket.
//   node tools/refactor/harness/run.js --commit <sha> --label <name> [--repo <guard-temp repo>] [--sets health,smoke]
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const guard = require("../lib/guard");

const IMAGE_REPO = "snapcon-refactor-harness";
const LIMITS = ["--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "256"];
// Test-suite runs get more CPU and memory (same isolation otherwise).
const TEST_LIMITS = ["--memory", "4g", "--memory-swap", "4g", "--cpus", "6", "--pids-limit", "512"];

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return r;
}

// A repository the harness may read: the worktree itself, or a scratch
// repository inside a guard-created temporary folder (validation runs).
// Read-only: the worktree itself, or a validation scratch repository made by
// tools/refactor/selftest/make-scratch.js (system temp folder, fixed prefix,
// no runtime state, not production).
const SCRATCH_PREFIX = "snapcon-refactor-scratch-";
function checkRepo(ctx, repo) {
  const r = fs.realpathSync(repo);
  if (r === ctx.worktree) return r;
  const tmp = fs.realpathSync(require("os").tmpdir());
  if (path.dirname(r) !== tmp || !path.basename(r).startsWith(SCRATCH_PREFIX)) throw new guard.GuardError(`repository ${repo} is neither the worktree nor a validation scratch repository`);
  if (r === ctx.production || r.startsWith(ctx.production + path.sep)) throw new guard.GuardError("refusing the production checkout");
  for (const f of ["config.json", "users.json", "data", "locales", "audit-data"]) if (fs.existsSync(path.join(r, f))) throw new guard.GuardError("scratch repository holds runtime state: " + f);
  return r;
}

function buildImage(ctx, repo, commit) {
  const dir = guard.makeTempDir("snapcon-harness-ctx-");
  fs.mkdirSync(path.join(dir, "app"));
  for (const f of ["package.json", "package-lock.json"]) fs.writeFileSync(path.join(dir, "app", f), execFileSync("git", ["show", `${commit}:${f}`], { cwd: repo }));
  fs.cpSync(path.join(ctx.toolsDir, "harness"), path.join(dir, "harness"), { recursive: true, filter: s => !/\/Dockerfile$/.test(s) });
  fs.copyFileSync(path.join(ctx.toolsDir, "harness", "Dockerfile"), path.join(dir, "Dockerfile"));
  const hash = crypto.createHash("sha256");
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach(e => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { hash.update(path.relative(dir, p)); hash.update(fs.readFileSync(p)); } });
  walk(dir);
  const tag = IMAGE_REPO + ":" + hash.digest("hex").slice(0, 16);
  const have = sh("docker", ["image", "inspect", tag]).status === 0;
  if (!have) {
    const b = sh("docker", ["build", "--pull=false", "-t", tag, "--label", "snapcon-refactor-harness=1", dir]);
    if (b.status !== 0) throw new Error("image build failed:\n" + b.stderr.slice(-3000));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return tag;
}

// This machine's own LAN targets for the isolation self-check (e.g. the NAS),
// from the gitignored local file: {"isolationTargets": ["host:port", …]}.
function localIsolationTargets(ctx) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ctx.toolsDir, "local", "approved-paths.json"), "utf8"));
    const t = Array.isArray(j.isolationTargets) ? j.isolationTargets.filter(x => /^[\w.-]+:\d+$/.test(x)) : [];
    return t.join(",");
  } catch { return ""; }
}

function exportCommit(repo, commit) {
  const dir = guard.makeTempDir("snapcon-harness-src-");
  const tar = execFileSync("git", ["archive", "--format=tar", commit], { cwd: repo, maxBuffer: 1024 * 1024 * 1024 });
  const x = sh("tar", ["-x", "-C", dir], { input: tar });
  if (x.status !== 0) throw new Error("git archive extract failed: " + x.stderr);
  for (const forbidden of ["config.json", "users.json", "data", "locales", "audit-data"]) if (fs.existsSync(path.join(dir, forbidden))) throw new guard.GuardError("exported tree holds runtime state: " + forbidden);
  return dir;
}

function runOnce(ctx, { image, src, label, sets, outRoot }) {
  const out = path.join(outRoot, label);
  guard.assertWritable(ctx, out);
  fs.mkdirSync(out, { recursive: true });
  const args = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    ...LIMITS, "--tmpfs", "/tmp:rw,size=768m,mode=1777", "--user", "node", "--name", "snapcon-harness-" + label + "-" + process.pid,
    "--label", "snapcon-refactor-harness=1",
    "-v", `${src}:/src:ro`, "-v", `${out}:/out:rw`, "-e", "ISOLATION_EXTRA_TARGETS=" + localIsolationTargets(ctx), image,
    "node", "/harness/run-in-container.js", "--label", label, ...sets.flatMap(s => ["--requests", `/harness/requests/${s}.json`])];
  const t0 = Date.now();
  const r = sh("docker", args, { timeout: 15 * 60 * 1000 });
  const file = path.join(out, label + ".json");
  return { label, exit: r.status, seconds: Math.round((Date.now() - t0) / 100) / 10, file: fs.existsSync(file) ? file : null, stderr: r.stderr.slice(-2000), dockerArgs: args };
}

function main() {
  const ctx = guard.check();
  const a = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const repo = checkRepo(ctx, a("--repo") || ctx.worktree);
  const commit = a("--commit") || "HEAD";
  const sets = (a("--sets") || "health,smoke").split(",");
  const label = a("--label") || "run";
  guard.ensureOutDir(ctx);
  const outRoot = path.join(ctx.outDir, "harness", a("--run-id") || new Date().toISOString().replace(/[:.]/g, "-"));
  const image = buildImage(ctx, repo, commit);
  const src = exportCommit(repo, commit);
  try { console.log(JSON.stringify(runOnce(ctx, { image, src, label, sets, outRoot }), null, 1)); }
  finally { fs.rmSync(src, { recursive: true, force: true }); }
}

// The app's own tests for a tree, inside the same isolated container shape.
function runTests(ctx, { image, src, label, files, outRoot }) {
  const out = path.join(outRoot, label);
  guard.assertWritable(ctx, out);
  fs.mkdirSync(out, { recursive: true });
  const args = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    ...TEST_LIMITS, "--tmpfs", "/tmp:rw,size=1536m,mode=1777", "--user", "node", "--label", "snapcon-refactor-harness=1",
    "-v", `${src}:/src:ro`, "-v", `${out}:/out:rw`, image, "node", "/harness/run-tests-in-container.js", "--label", label, ...(files ? ["--files", files] : [])];
  const r = sh("docker", args, { timeout: 25 * 60 * 1000 });
  const jl = path.join(out, label + ".tests.jsonl");
  const tests = fs.existsSync(jl) ? fs.readFileSync(jl, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  const meta = fs.existsSync(path.join(out, label + ".tests.meta.json")) ? JSON.parse(fs.readFileSync(path.join(out, label + ".tests.meta.json"), "utf8")) : null;
  return { label, dockerExit: r.status, tests, meta };
}

module.exports = { buildImage, exportCommit, runOnce, runTests, checkRepo, SCRATCH_PREFIX };
if (require.main === module) main();
