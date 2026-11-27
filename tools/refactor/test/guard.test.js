// tools/refactor/test/guard.test.js — the guard refuses everything except an
// approved, isolated refactor worktree. Builds throwaway repositories in the
// system temp folder; never touches a real checkout.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const guard = require("../lib/guard");

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" });

function setup(t, { branch = "refactor/x" } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-test-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const main = path.join(base, "main"); fs.mkdirSync(main);
  git(main, "init", "-q", "-b", "main"); git(main, "config", "user.email", "t@t"); git(main, "config", "user.name", "t");
  fs.writeFileSync(path.join(main, "server.js"), "// app\n"); git(main, "add", "."); git(main, "commit", "-qm", "init");
  const wt = path.join(base, "wt");
  git(main, "worktree", "add", "-q", "-b", branch, wt);
  const approved = { production: main, worktrees: [wt] };
  return { base, main, wt, approved, opts: { cwd: wt, approved, serverDirs: [] } };
}
const refuses = (fn, re) => assert.throws(fn, e => e.code === "REFACTOR_GUARD" && re.test(e.message), String(re));

test("an approved linked worktree on refactor/<name> passes", t => {
  const s = setup(t);
  const c = guard.check(s.opts);
  assert.equal(c.worktree, s.wt); assert.equal(c.branch, "refactor/x");
});

test("the main checkout is refused", t => {
  const s = setup(t);
  refuses(() => guard.check({ ...s.opts, cwd: s.main }), /main checkout/);
});

test("an unapproved worktree, or one overlapping production, is refused", t => {
  const s = setup(t);
  refuses(() => guard.check({ ...s.opts, approved: { production: s.main, worktrees: [s.base] } }), /not an approved worktree/);
  refuses(() => guard.check({ ...s.opts, approved: { production: s.base, worktrees: [s.wt] } }), /overlaps the production checkout/);
});

test("a missing or malformed approved-paths file is refused", t => {
  const s = setup(t);
  refuses(() => guard.check({ cwd: s.wt, serverDirs: [] }), /approved-paths/);
  fs.mkdirSync(path.join(s.wt, "tools", "refactor", "local"), { recursive: true });
  fs.writeFileSync(path.join(s.wt, "tools", "refactor", "local", "approved-paths.json"), '{"worktrees":[]}');
  refuses(() => guard.check({ cwd: s.wt, serverDirs: [] }), /must hold/);
});

test("a branch not named refactor/<name> is refused", t => {
  const s = setup(t, { branch: "feature/x" });
  refuses(() => guard.check(s.opts), /is not refactor\/<name>/);
});

test("SnapCon runtime state inside the worktree is refused", t => {
  for (const name of ["config.json", "users.json", "data", "locales", "audit-data"]) {
    const s = setup(t);
    const p = path.join(s.wt, name);
    if (name.endsWith(".json")) fs.writeFileSync(p, "{}"); else fs.mkdirSync(p);
    refuses(() => guard.check(s.opts), /runtime state/);
  }
});

test("a symlink leading outside the worktree is refused; one inside is fine", t => {
  const s = setup(t);
  fs.mkdirSync(path.join(s.wt, "a")); fs.symlinkSync(path.join(s.wt, "a"), path.join(s.wt, "inside"));
  guard.check(s.opts);
  fs.symlinkSync(s.main, path.join(s.wt, "a", "escape"));
  refuses(() => guard.check(s.opts), /leads outside the worktree/);
});

test("a dangling symlink is refused", t => {
  const s = setup(t);
  fs.symlinkSync(path.join(s.base, "nowhere"), path.join(s.wt, "dangling"));
  refuses(() => guard.check(s.opts), /dangling symlink/);
});

test("a directory on another filesystem (a mount) is refused", t => {
  const s = setup(t);
  const m = path.join(s.wt, "mnt"); fs.mkdirSync(m);
  const statFn = p => ({ dev: path.resolve(p) === m ? 999999 : fs.statSync(p).dev });
  refuses(() => guard.check({ ...s.opts, statFn }), /another filesystem/);
});

test("a worktree overlapping a running server.js's directory is refused", t => {
  const s = setup(t);
  refuses(() => guard.check({ ...s.opts, serverDirs: [s.wt] }), /running server\.js/);
});

test("writes: only tools/refactor/out and guard temp folders; never production or elsewhere", t => {
  const s = setup(t);
  const c = guard.check(s.opts);
  fs.mkdirSync(c.outDir, { recursive: true });
  assert.ok(guard.assertWritable(c, path.join(c.outDir, "report.json")));
  const tmp = guard.makeTempDir("guard-test-tmp-"); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  assert.ok(guard.assertWritable(c, path.join(tmp, "x")));
  refuses(() => guard.assertWritable(c, path.join(s.wt, "server.js")), /outside tools\/refactor\/out/);
  refuses(() => guard.assertWritable(c, path.join(s.main, "x")), /outside|production/);
  refuses(() => guard.assertWritable(c, path.join(os.tmpdir(), "not-ours", "x")), /outside/);
});

test("an out folder that is a symlink to elsewhere is refused", t => {
  const s = setup(t);
  const elsewhere = path.join(s.base, "elsewhere"); fs.mkdirSync(elsewhere);
  fs.mkdirSync(path.join(s.wt, "tools", "refactor"), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(s.wt, "tools", "refactor", "out"));
  refuses(() => guard.check(s.opts), /leads outside the worktree/);
  const c = { worktree: s.wt, outDir: path.join(s.wt, "tools", "refactor", "out"), production: s.main };
  refuses(() => guard.assertWritable(c, path.join(c.outDir, "r.json")), /resolves outside the worktree/);
});

test("ensureOutDir creates only tools/refactor/out, inside the worktree", t => {
  const s = setup(t);
  fs.mkdirSync(path.join(s.wt, "tools", "refactor"), { recursive: true });
  const c = guard.check(s.opts);
  assert.equal(guard.ensureOutDir(c), c.outDir);
  assert.ok(fs.statSync(c.outDir).isDirectory());
  assert.ok(guard.assertWritable(c, path.join(c.outDir, "sub", "r.json")));
});
