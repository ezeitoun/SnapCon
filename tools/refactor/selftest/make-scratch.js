// tools/refactor/selftest/make-scratch.js — builds a validation scratch
// repository in the system temp folder: commit "base" = this worktree's app
// files as they stand (tracked + new, minus tools/ and gitignored files),
// then one branch per deliberately broken variant from selftest/variants.js.
// Never touches the real repository. Prints the scratch path.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const guard = require("../lib/guard");
const { SCRATCH_PREFIX } = require("../harness/run");
const variants = require("./variants");

const ctx = guard.check();
const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), SCRATCH_PREFIX));
const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ctx.worktree, encoding: "utf8" }).split("\n").filter(f => f && !f.startsWith("tools/"));
for (const f of files) { const s = path.join(ctx.worktree, f); if (!fs.existsSync(s)) continue; fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.copyFileSync(s, path.join(dir, f)); }
git("init", "-q", "-b", "base"); git("config", "user.email", "selftest@localhost"); git("config", "user.name", "selftest");
git("add", "-A"); git("commit", "-qm", "base: the worktree's app files");
for (const v of variants) {
  git("checkout", "-q", "-b", v.branch, "base");
  for (const e of v.edits) {
    const f = path.join(dir, e.file);
    if (e.create !== undefined) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, e.create); continue; }
    if (e.append !== undefined) { fs.appendFileSync(f, e.append); continue; }
    const s = fs.readFileSync(f, "utf8");
    if (s.split(e.find).length !== 2) throw new Error(`${v.branch}: anchor not found exactly once in ${e.file}: ${e.find.slice(0, 60)}`);
    fs.writeFileSync(f, s.replace(e.find, e.replace));
  }
  git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", v.branch + ": " + v.what);
}
git("checkout", "-q", "base");
console.log(dir);
