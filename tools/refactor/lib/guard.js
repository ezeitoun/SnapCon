// tools/refactor/lib/guard.js — fail-closed safety check run first by every
// refactoring tool and script (docs/refactoring-policy.md). It refuses unless
// the working directory is an approved, isolated refactor worktree:
//   1. a linked git worktree (never a main checkout);
//   2. its real path matches an approved path from the gitignored
//      tools/refactor/local/approved-paths.json, and is not the production
//      checkout (by real path, and by the cwd of any running `server.js`);
//   3. on a `refactor/<name>` branch;
//   4. holding none of SnapCon's runtime state (config.json, users.json,
//      data/, *-data/, locales/);
//   5. with no symlink or mount inside it that leads outside it.
// assertWritable() then allows writes only under <worktree>/tools/refactor/out
// or a temporary folder this guard created. Node built-ins only.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

class GuardError extends Error { constructor(msg) { super("refactor guard: " + msg); this.code = "REFACTOR_GUARD"; } }

const RUNTIME_STATE = ["config.json", "users.json", "data", "locales", "queued-files.json", "notify-token.json"];
const FORBIDDEN_ROOTS = ["/mnt", "/media", "/srv"];

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const real = p => fs.realpathSync.native(p);
const within = (child, parent) => { const r = path.relative(parent, child); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };

function readApproved(toolsDir, opts) {
  if (opts.approved) return opts.approved;
  const f = path.join(toolsDir, "local", "approved-paths.json");
  let j;
  try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { throw new GuardError(`no readable approved-paths file (${f}): ${e.code || e.message}`); }
  if (!j || !Array.isArray(j.worktrees) || !j.worktrees.length || typeof j.production !== "string") throw new GuardError(`${f} must hold {"production": "<path>", "worktrees": ["<path>", …]}`);
  return j;
}

// The cwd of every running process whose command line runs server.js.
function serverProcessDirs() {
  const out = [];
  let pids = [];
  try { pids = fs.readdirSync("/proc").filter(d => /^\d+$/.test(d)); } catch { return out; }
  for (const pid of pids) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (!cmd.some(a => /(^|\/)server\.js$/.test(a))) continue;
      out.push(real(`/proc/${pid}/cwd`));
    } catch { /* gone, or not ours */ }
  }
  return out;
}

// Every symlink inside root must resolve inside root, and nothing inside root
// may sit on another filesystem (a mount). node_modules is walked too: its
// .bin links are part of what the tools execute.
function checkContainment(root, opts = {}) {
  const rootDev = (opts.statFn || fs.statSync)(root).dev;
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { throw new GuardError(`cannot read ${dir}: ${e.code}`); }
    for (const e of entries) {
      if (e.name === ".git" && dir === root) continue;          // the worktree's .git is a file pointing at the repository
      const p = path.join(dir, e.name);
      if (++seen > 500000) throw new GuardError("too many entries to check");
      if (e.isSymbolicLink()) {
        let target;
        try { target = real(p); } catch { throw new GuardError(`dangling symlink ${p}`); }
        if (!within(target, root)) throw new GuardError(`symlink ${p} leads outside the worktree (${target})`);
        continue;
      }
      if (e.isDirectory()) {
        if ((opts.statFn || fs.statSync)(p).dev !== rootDev) throw new GuardError(`${p} is on another filesystem (a mount)`);
        stack.push(p);
      }
    }
  }
}

function check(opts = {}) {
  const cwd = real(opts.cwd || process.cwd());
  let top, gitDir, common, branch;
  try {
    top = real(git(cwd, ["rev-parse", "--show-toplevel"]));
    gitDir = real(path.resolve(cwd, git(cwd, ["rev-parse", "--git-dir"])));
    common = real(path.resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"])));
    branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch (e) { throw new GuardError(`not inside a git checkout (${cwd})`); }
  if (gitDir === common) throw new GuardError(`${top} is a main checkout, not a linked refactor worktree`);
  const toolsDir = path.join(top, "tools", "refactor");
  const approved = readApproved(toolsDir, opts);
  let production;
  try { production = real(approved.production); } catch { throw new GuardError(`production path ${approved.production} cannot be resolved`); }
  if (top === production || within(top, production) || within(production, top)) throw new GuardError(`${top} is or overlaps the production checkout`);
  const ok = approved.worktrees.map(w => { try { return real(w); } catch { return null; } }).filter(Boolean);
  if (!ok.includes(top)) throw new GuardError(`${top} is not an approved worktree`);
  for (const d of (opts.serverDirs || serverProcessDirs())) {
    if (within(top, d) || within(d, top)) throw new GuardError(`${top} overlaps the working directory of a running server.js (${d})`);
  }
  if (!/^refactor\/[a-z0-9][a-z0-9._-]*$/.test(branch)) throw new GuardError(`branch "${branch}" is not refactor/<name>`);
  for (const name of RUNTIME_STATE) if (fs.existsSync(path.join(top, name))) throw new GuardError(`runtime state present in the worktree: ${name}`);
  for (const e of fs.readdirSync(top)) if (/-data$/.test(e)) throw new GuardError(`runtime state present in the worktree: ${e}`);
  for (const r of FORBIDDEN_ROOTS) if (within(top, r)) throw new GuardError(`${top} is under ${r}`);
  checkContainment(top, opts);
  return { worktree: top, branch, toolsDir, outDir: path.join(toolsDir, "out"), production };
}

// Writes are allowed only under <worktree>/tools/refactor/out or a temporary
// folder created by makeTempDir(). Resolves the nearest existing ancestor.
const TEMP_DIRS = new Set();
function makeTempDir(prefix = "snapcon-refactor-") {
  const d = real(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  TEMP_DIRS.add(d);
  return d;
}
function assertWritable(ctx, target) {
  let p = path.resolve(target);
  while (!fs.existsSync(p)) p = path.dirname(p);
  const r = real(p);
  const out = path.resolve(ctx.outDir);
  const outReal = fs.existsSync(out) ? real(out) : out;
  if (!within(outReal, ctx.worktree)) throw new GuardError(`tools/refactor/out resolves outside the worktree (${outReal})`);
  const allowed = within(r, outReal) || [...TEMP_DIRS].some(t => within(r, t));
  if (!allowed) throw new GuardError(`refusing to write ${target}: outside tools/refactor/out and the guard's temporary folders`);
  if (within(r, ctx.production)) throw new GuardError(`refusing to write into the production checkout: ${target}`);
  for (const f of FORBIDDEN_ROOTS) if (within(r, f)) throw new GuardError(`refusing to write under ${f}: ${target}`);
  return r;
}

// Create tools/refactor/out (only that folder) and confirm it resolves inside the worktree.
function ensureOutDir(ctx) {
  const parent = real(path.dirname(ctx.outDir));
  if (!within(parent, ctx.worktree)) throw new GuardError(`tools/refactor resolves outside the worktree (${parent})`);
  if (!fs.existsSync(ctx.outDir)) fs.mkdirSync(ctx.outDir);
  const r = real(ctx.outDir);
  if (!within(r, ctx.worktree)) throw new GuardError(`tools/refactor/out resolves outside the worktree (${r})`);
  return r;
}

module.exports = { check, assertWritable, ensureOutDir, makeTempDir, GuardError, _internal: { checkContainment, serverProcessDirs, within } };

if (require.main === module) {
  try { const c = check(); console.log(JSON.stringify({ ok: true, worktree: c.worktree, branch: c.branch })); }
  catch (e) { console.error(e.message); process.exit(2); }
}
