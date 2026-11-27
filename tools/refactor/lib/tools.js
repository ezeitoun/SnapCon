// tools/refactor/lib/tools.js — runs the pinned tools after the guard has
// passed. ast-grep is installed with --ignore-scripts, so its npm launcher is
// a placeholder: the platform binary is called directly.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const guard = require("./guard");

const NM = path.join(__dirname, "..", "node_modules");
const PLATFORM_PKG = {
  "linux-x64": "@ast-grep/cli-linux-x64-gnu", "linux-arm64": "@ast-grep/cli-linux-arm64-gnu",
  "darwin-x64": "@ast-grep/cli-darwin-x64", "darwin-arm64": "@ast-grep/cli-darwin-arm64",
  "win32-x64": "@ast-grep/cli-win32-x64-msvc", "win32-arm64": "@ast-grep/cli-win32-arm64-msvc",
};
function astGrepBin() {
  const pkg = PLATFORM_PKG[process.platform + "-" + process.arch];
  if (!pkg) throw new Error("no ast-grep binary for " + process.platform + "-" + process.arch);
  const bin = path.join(NM, pkg, process.platform === "win32" ? "ast-grep.exe" : "ast-grep");
  if (!fs.existsSync(bin)) throw new Error("ast-grep binary missing: " + bin + " (run npm ci --ignore-scripts in tools/refactor)");
  return bin;
}
const depcruiseBin = () => path.join(NM, "dependency-cruiser", "bin", "dependency-cruiser.mjs");

// Run a tool from the worktree root; returns { status, stdout, stderr }.
function run(ctx, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd || ctx.worktree, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const astGrep = (ctx, args, opts) => run(ctx, astGrepBin(), args, opts);
const depcruise = (ctx, args, opts) => run(ctx, process.execPath, [depcruiseBin(), ...args], opts);

// Write a report file only where the guard allows.
function writeOut(ctx, rel, data) {
  guard.ensureOutDir(ctx);
  const p = path.join(ctx.outDir, rel);
  guard.assertWritable(ctx, p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  guard.assertWritable(ctx, p);
  fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
  return p;
}

const versions = () => ({
  node: process.version,
  "dependency-cruiser": require(path.join(NM, "dependency-cruiser", "package.json")).version,
  "@ast-grep/cli": execFileSync(astGrepBin(), ["--version"], { encoding: "utf8" }).trim(),
  jscodeshift: require(path.join(NM, "jscodeshift", "package.json")).version,
});

module.exports = { astGrep, depcruise, astGrepBin, writeOut, versions, NM };
