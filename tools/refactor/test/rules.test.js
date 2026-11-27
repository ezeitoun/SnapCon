// tools/refactor/test/rules.test.js — the enforcement rules are validated
// before they gate anything (docs/refactoring-policy.md): every
// dependency-cruiser rule fires on its "fail" fixture and stays quiet on its
// "pass" fixture; every ast-grep rule passes its valid/invalid examples; the
// ast-grep folder scoping really limits each rule.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { astGrepBin } = require("../lib/tools");

const ROOT = path.join(__dirname, "..");
const FIX = path.join(ROOT, "depcruise-fixtures");
const DEPCRUISE = path.join(ROOT, "node_modules", "dependency-cruiser", "bin", "dependency-cruiser.mjs");
const CONFIG = path.join(ROOT, ".dependency-cruiser.cjs");

function cruise(dir) {
  const r = spawnSync(process.execPath, [DEPCRUISE, "--config", CONFIG, "--output-type", "json", "."], { cwd: dir, encoding: "utf8" });
  return new Set(JSON.parse(r.stdout).summary.violations.map(v => v.rule.name));
}

const RULES = require(CONFIG).forbidden.map(r => r.name);
test("every dependency-cruiser rule has a pass and a fail fixture", () => {
  for (const rule of RULES) {
    assert.ok(fs.existsSync(path.join(FIX, rule, "fail")), rule + " fail fixture");
    assert.ok(fs.existsSync(path.join(FIX, rule, "pass")), rule + " pass fixture");
  }
});
for (const rule of RULES) {
  test(`dependency-cruiser ${rule}: fires on fail, quiet on pass`, () => {
    assert.ok(cruise(path.join(FIX, rule, "fail")).has(rule), "fires on its fail fixture");
    assert.deepEqual([...cruise(path.join(FIX, rule, "pass"))], [], "no violation at all on its pass fixture");
  });
}

test("ast-grep rules pass their valid/invalid examples (sg test)", () => {
  const r = spawnSync(astGrepBin(), ["test", "-c", "sgconfig.yml", "--skip-snapshot-tests"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const enforce = fs.readdirSync(path.join(ROOT, "ast-grep-rules", "enforce")).length;
  assert.match(r.stdout, new RegExp(`${enforce} passed; 0 failed`), "every enforcement rule has tests");
});

test("ast-grep folder scoping: routes/ gets all route rules, library/ only its own, test/ none", () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "sgscope-"));
  try {
    const body = 'setInterval(f, 1);\nrequire("../server");\nCFG = 1;\napp.listen(1);\nfunction registerXRoutes(a){ const m = new Map(); }\n';
    for (const d of ["routes", "library", "test/library"]) { fs.mkdirSync(path.join(T, d), { recursive: true }); fs.writeFileSync(path.join(T, d, "x.js"), body); }
    const r = spawnSync(astGrepBin(), ["scan", "-c", path.join(ROOT, "sgconfig.yml"), "--json=compact", T], { encoding: "utf8" });
    const hits = JSON.parse(r.stdout).map(h => path.relative(T, h.file).split(path.sep)[0] + ":" + h.ruleId).sort();
    assert.deepEqual(hits, ["library:no-listen-outside-server", "library:no-shared-state-reassignment",
      "routes:no-listen-outside-server", "routes:no-load-time-timers", "routes:no-shared-state-reassignment",
      "routes:route-module-no-server-require", "routes:state-not-in-register"]);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});
