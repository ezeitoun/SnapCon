#!/usr/bin/env node
// scripts/verify-refactor.js — deterministic verification of one refactor
// boundary (docs/refactoring-policy.md), separate from any agent's judgment.
// Runs only from an approved refactor worktree (tools/refactor/lib/guard.js).
//
//   node scripts/verify-refactor.js --base <sha> --head <sha> --manifest <file>
//        [--repo <worktree | guard temp repo>] [--run-id <name>] [--suite-runs 3]
//        [--only V1,V2,…]   (development only: every check not run is UNVERIFIED)
//
// Checks: V1 git scope · V2 forbidden changes · V3 moved-code identity ·
// V4 dependency rules · V5 ast-grep rules · V6 full suite ×N (per test) and
// test preservation · V7 pinning tests + mutation check · V8 HTTP contracts ·
// V9 side effects · V10 golden cards · V11 packaging (static) · V12 real
// Docker/pkg builds (MANUAL, owner approval) · V13 Guardian review (AGENT).
// Writes tools/refactor/out/verify/<run-id>/report.json and report.md.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const T = path.join(__dirname, "..", "tools", "refactor");
const guard = require(path.join(T, "lib", "guard"));
const tools = require(path.join(T, "lib", "tools"));
const { appPaths } = require(path.join(T, "lib", "appPaths"));
const { compareMoved } = require(path.join(T, "lib", "identity"));
const { compareTestFile } = require(path.join(T, "lib", "testPreservation"));
const { compareRuns } = require(path.join(T, "lib", "contracts"));
const { evaluateKnownFailures } = require(path.join(T, "lib", "knownFailures"));
const { evaluateMutation } = require(path.join(T, "lib", "mutations"));
const harness = require(path.join(T, "harness", "run.js"));

const FORBIDDEN = [
  [/^library\/schema\.js$/, "database schema"],
  [/^(audit|sync|queue|transfers|utilization)\//, "persistence subsystem"],
  [/^locales-default\//, "shipped strings"],
  [/^test\/fixtures\/card-golden\//, "golden card files (never regenerated in a refactor)"],
  [/^package(-lock)?\.json$/, "app dependencies / packaging"],
  [/(^|\/)config[^/]*\.json$/, "configuration"],
  [/^connectors\//, "printer connectors"],
  [/^public\//, "frontend"],
  [/^tools\/refactor\/(\.dependency-cruiser|sgconfig\.yml|ast-grep-rules\/)/, "verification rules and baseline"],
  [/^scripts\/verify-refactor\.js$/, "the verifier itself"],
];
const DISCLAIMER = "Static analysis and passing tests show no detected difference. They do not prove behavioral equivalence.";

function main() {
  const ctx = guard.check();
  const a = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const repo = harness.checkRepo(ctx, a("--repo") || ctx.worktree);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const base = git("rev-parse", a("--base")).trim(), head = git("rev-parse", a("--head")).trim();
  const manifest = JSON.parse(fs.readFileSync(a("--manifest"), "utf8"));
  const runs = Number(a("--suite-runs") || 3);
  const only = a("--only") ? new Set(a("--only").split(",")) : null;
  const runId = a("--run-id") || new Date().toISOString().replace(/[:.]/g, "-");
  guard.ensureOutDir(ctx);
  const outDir = path.join(ctx.outDir, "verify", runId);
  guard.assertWritable(ctx, outDir); fs.mkdirSync(outDir, { recursive: true });

  const report = { boundary: manifest.boundary, base, head, repo: repo === ctx.worktree ? "worktree" : "scratch", startedAt: new Date().toISOString(), tools: tools.versions(), checks: [], disclaimer: DISCLAIMER };
  const add = (id, title, kind, status, evidence) => { report.checks.push({ id, title, kind, status, evidence }); console.log(`${id} ${status.padEnd(10)} ${title}`); };
  const want = id => !only || only.has(id);
  const skip = (id, title, kind) => add(id, title, kind, "UNVERIFIED", { reason: "not run (--only)" });

  const changed = git("diff", "--name-status", "--no-renames", base, head).split("\n").filter(Boolean).map(l => { const [st, f] = l.split("\t"); return { status: st, file: f }; });

  // ---- V1 git scope ----
  if (want("V1")) {
    const anc = spawnSync("git", ["merge-base", "--is-ancestor", base, head], { cwd: repo }).status === 0;
    const allowed = new Set([...(manifest.allowedFiles || []), ...(manifest.newFiles || [])]);
    const unexpected = changed.filter(c => !allowed.has(c.file));
    add("V1", "git: head descends from base; every changed file is declared", "automated", anc && !unexpected.length ? "PASS" : "FAIL", { headDescendsFromBase: anc, changed, unexpected });
  } else skip("V1", "git scope", "automated");

  // ---- V2 forbidden changes ----
  if (want("V2")) {
    const hits = [];
    for (const c of changed) for (const [re, what] of FORBIDDEN) if (re.test(c.file)) hits.push({ file: c.file, what });
    const docker = changed.find(c => c.file === "Dockerfile");
    if (docker) {
      const lines = git("diff", "-U0", base, head, "--", "Dockerfile").split("\n").filter(l => /^[+-][^+-]/.test(l));
      const bad = lines.filter(l => !/^\+COPY [a-z][a-z0-9-]* \.\/[a-z][a-z0-9-]*$/.test(l));
      if (bad.length) hits.push({ file: "Dockerfile", what: "only added `COPY <dir> ./<dir>` lines are allowed", lines: bad });
    }
    add("V2", "forbidden changes: schema, persistence, strings, golden files, dependencies, config, connectors, frontend, rules", "automated", hits.length ? "FAIL" : "PASS", { hits });
  } else skip("V2", "forbidden changes", "automated");

  // Trees for the remaining checks.
  const needTrees = ["V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10", "V11"].some(want);
  const baseTree = needTrees ? harness.exportCommit(repo, base) : null;
  const headTree = needTrees ? harness.exportCommit(repo, head) : null;
  const jsUnder = (root, rel) => { const p = path.join(root, rel); if (!fs.existsSync(p)) return []; if (fs.statSync(p).isFile()) return rel.endsWith(".js") ? [rel] : []; return fs.readdirSync(p).flatMap(e => jsUnder(root, path.join(rel, e))); };
  try {
    // ---- V3 moved-code identity ----
    if (want("V3")) {
      const baseSrc = fs.readFileSync(path.join(baseTree, manifest.movedFrom || "server.js"), "utf8");
      const headSources = Object.fromEntries(appPaths(headTree, { browserShared: false }).flatMap(p => jsUnder(headTree, p)).map(f => [f, fs.readFileSync(path.join(headTree, f), "utf8")]));
      // A moved declaration is looked for in every file this refactor may change (its new files, its
      // allowed files, the file it left). A same-named declaration in any other file is in a file V1
      // refuses to see changed, so it cannot be where the code went.
      const destinations = [...new Set([...(manifest.newFiles || []), ...(manifest.allowedFiles || []), manifest.movedFrom || "server.js"])];
      const res = (manifest.moved || []).map(symbol => compareMoved({ baseSrc, headSources, symbol, rewrites: manifest.rewrites || [], destinations }));
      add("V3", "moved code identical except declared rewrites", "automated", !res.length ? "UNVERIFIED" : res.every(r => r.status === "PASS") ? "PASS" : "FAIL", { symbols: res, note: res.length ? undefined : "manifest declares no moved symbols" });
    } else skip("V3", "moved-code identity", "automated");

    // ---- V4 dependency rules (head) ----
    if (want("V4")) {
      const cfg = path.join(ctx.toolsDir, ".dependency-cruiser.cjs"), known = path.join(ctx.toolsDir, ".dependency-cruiser-known-violations.json");
      const r = tools.depcruise(ctx, ["--config", cfg, "--output-type", "json", "--ignore-known", known, ...appPaths(headTree)], { cwd: headTree });
      let v = null; try { v = JSON.parse(r.stdout).summary; } catch { /* below */ }
      add("V4", "dependency rules: no violation beyond the reviewed baseline", "automated", v && v.violations.length === 0 ? "PASS" : "FAIL", v ? { modules: v.totalCruised, dependencies: v.totalDependenciesCruised, violations: v.violations } : { error: r.stderr.slice(-2000) });
    } else skip("V4", "dependency rules", "automated");

    // ---- V5 ast-grep rules (head) ----
    if (want("V5")) {
      const r = tools.astGrep(ctx, ["scan", "-c", path.join(ctx.toolsDir, "sgconfig.yml"), "--json=compact", ...appPaths(headTree)], { cwd: headTree });
      let hits = null; try { hits = JSON.parse(r.stdout || "[]"); } catch { /* below */ }
      add("V5", "ast-grep enforcement rules", "automated", hits && !hits.length ? "PASS" : "FAIL", hits ? { hits: hits.map(h => ({ rule: h.ruleId, file: h.file, line: h.range.start.line + 1 })) } : { error: r.stderr.slice(-2000) });
    } else skip("V5", "ast-grep rules", "automated");

    let image = null;
    const suiteRoot = path.join(outDir, "suite");
    const ensureImage = () => (image = image || harness.buildImage(ctx, repo, base));
    // ---- V6 full suite ×N + test preservation ----
    let headSuites = [], baseSuite = null;
    if (want("V6") || want("V7") || want("V10") || want("V11")) {
      ensureImage();
      baseSuite = harness.runTests(ctx, { image, src: baseTree, label: "base", outRoot: suiteRoot });
      for (let i = 1; i <= runs; i++) headSuites.push(harness.runTests(ctx, { image, src: headTree, label: "head-" + i, outRoot: suiteRoot }));
    }
    const key = t => (t.file || "").replace(/^\/tmp\/app\//, "") + " :: " + "  ".repeat(t.nesting || 0) + t.name;
    const statusMap = s => new Map(s.tests.map(t => [key(t), t.status]));
    if (want("V6")) {
      const b = statusMap(baseSuite), hs = headSuites.map(statusMap);
      const missing = [...b.keys()].filter(k => !hs.every(h => h.has(k)));
      const regressed = [...b].filter(([k, s]) => s === "pass" && hs.some(h => h.get(k) !== "pass")).map(([k]) => k);
      // Known failures of this environment: reported explicitly, never a plain PASS;
      // anything new, a changed signature, or a known failure that passes blocks.
      const registry = JSON.parse(fs.readFileSync(path.join(ctx.toolsDir, "harness", "known-failures.json"), "utf8"));
      const knownEval = evaluateKnownFailures(registry, baseSuite, headSuites);
      const flaky = [...new Set(hs.flatMap(h => [...h].filter(([k, s]) => s === "fail" && hs.some(o => o.get(k) === "pass")).map(([k]) => k)))];
      const added = [...hs[0].keys()].filter(k => !b.has(k));
      const changedTests = changed.filter(c => /^test\/.*\.js$/.test(c.file));
      const preservation = changedTests.map(c => {
        if (c.status === "D") return { file: c.file, status: "FAIL", why: "test file deleted" };
        if (c.status === "A") return { file: c.file, status: /^test\/(fixtures|helpers)\//.test(c.file) && !(manifest.declaredTestFiles || []).includes(c.file) ? "FAIL" : "REVIEW", why: "new file" };
        if (/^test\/(fixtures|helpers)\//.test(c.file)) {
          if (!(manifest.declaredTestFiles || []).includes(c.file)) return { file: c.file, status: "FAIL", why: "fixture/helper changed without declaration" };
          // A declared helper has no assertions to compare: never a silent pass —
          // every changed line goes to the Guardian (REVIEW).
          const lines = git("diff", "-U0", base, head, "--", c.file).split("\n").filter(l => /^[+-][^+-]/.test(l));
          return { file: c.file, status: "REVIEW", why: "declared helper changed: the Guardian reviews every line", changedLines: lines };
        }
        const r = compareTestFile(git("show", `${base}:${c.file}`), git("show", `${head}:${c.file}`), (manifest.declaredHarness || {})[c.file] || []);
        return { file: c.file, ...r };
      });
      const preserveFail = preservation.some(p => p.status === "FAIL");
      const st = missing.length || regressed.length || preserveFail || knownEval.status === "FAIL" ? "FAIL"
        : (preservation.some(p => p.status === "REVIEW") || flaky.length ? "REVIEW" : knownEval.status);
      add("V6", `full suite ×${runs} compared test by test with base; test preservation`, "automated", st,
        { base: summary(baseSuite), head: headSuites.map(summary), missingInHead: missing, regressed, flakyInHead: flaky, addedInHead: added, knownFailures: knownEval, testPreservation: preservation });
    } else skip("V6", "full suite + test preservation", "automated");

    // ---- V7 pinning tests + mutation check ----
    if (want("V7")) {
      const pins = manifest.pinningTests || [];
      const isPin = t => pins.some(p => (t.file || "").endsWith("/" + p) || (t.file || "") === p);
      const pinRes = headSuites.map(h => h.tests.filter(isPin));
      const pinsOk = pins.length && pinRes.every(r => r.length && r.every(t => t.status === "pass")) && baseSuite.tests.filter(isPin).every(t => t.status === "pass");
      const mutations = [];
      // Detection counts only pinning tests that passed in every unmutated run
      // and fail genuinely ("fail") under the mutation (tools/refactor/lib/mutations.js).
      const pinRun = r => r.tests.filter(isPin).map(t => ({ key: key(t), status: t.status }));
      const unmutatedBase = [pinRun(baseSuite)], unmutatedHead = headSuites.map(pinRun);
      for (const m of manifest.mutations || []) {
        const runMut = (tree, spec, label) => {
          const dir = guard.makeTempDir("snapcon-mut-");
          fs.cpSync(tree, dir, { recursive: true });
          const f = path.join(dir, spec.file), s = fs.readFileSync(f, "utf8");
          if (s.split(spec.find).length !== 2) { fs.rmSync(dir, { recursive: true, force: true }); return { error: `anchor not found exactly once in ${spec.file}` }; }
          fs.writeFileSync(f, s.replace(spec.find, spec.replace));
          const r = harness.runTests(ctx, { image: ensureImage(), src: dir, label, files: pins.join(","), outRoot: path.join(outDir, "mutations") });
          fs.rmSync(dir, { recursive: true, force: true });
          return { mutated: r.tests.map(t => ({ key: key(t), status: t.status })) };
        };
        const b = runMut(baseTree, m.base, "mut-" + m.name + "-base"), h = runMut(headTree, m.head || m.base, "mut-" + m.name + "-head");
        const ev = evaluateMutation({ base: { ...b, unmutated: unmutatedBase }, head: { ...h, unmutated: unmutatedHead } });
        mutations.push({ name: m.name, ...ev });
      }
      const st = !pinsOk ? "FAIL" : !mutations.length ? "UNVERIFIED" : mutations.every(x => x.status === "PASS") ? "PASS" : "FAIL";
      add("V7", "pinning tests pass on base and head; every declared mutation fails the same tests on both", "automated", st,
        { pinningTests: pins, headRuns: pinRes.map(r => ({ tests: r.length, failing: r.filter(t => t.status !== "pass").map(key) })), mutations });
    } else skip("V7", "pinning tests + mutations", "automated");

    // ---- V8 / V9 HTTP contracts and side effects ----
    if (want("V8") || want("V9")) {
      ensureImage();
      const sets = manifest.contractSets || ["health", "smoke"];
      const croot = path.join(outDir, "contracts");
      const b1 = harness.runOnce(ctx, { image, src: baseTree, label: "base1", sets, outRoot: croot });
      const b2 = harness.runOnce(ctx, { image, src: baseTree, label: "base2", sets, outRoot: croot });
      const h1 = harness.runOnce(ctx, { image, src: headTree, label: "head", sets, outRoot: croot });
      const load = r => (r.file ? JSON.parse(fs.readFileSync(r.file, "utf8")) : null);
      const B1 = load(b1), B2 = load(b2), H1 = load(h1);
      if (!B1 || !B2 || !H1) {
        add("V8", "HTTP contracts", "automated", "FAIL", { error: "a harness run produced no result", runs: [b1, b2, h1].map(r => ({ label: r.label, exit: r.exit, stderr: r.stderr })) });
        add("V9", "side effects", "automated", "FAIL", { error: "no harness result" });
      } else {
        const volatile = JSON.parse(fs.readFileSync(path.join(ctx.toolsDir, "harness", "requests", "volatile.json"), "utf8"));
        const c = compareRuns(B1, B2, H1, volatile);
        fs.writeFileSync(path.join(outDir, "contracts.json"), JSON.stringify(c, null, 2));
        const isoOk = Object.values(c.isolation).every(Boolean);
        const resOk = c.results.every(r => r.status === "PASS");
        add("V8", "HTTP contracts (targeted + smoke), base ×2 vs head, declared volatile fields only", "automated", isoOk && resOk && !B1.errors.length && !H1.errors.length ? "PASS" : "FAIL",
          { isolation: c.isolation, errors: c.errors, failing: c.results.filter(r => r.status !== "PASS"), passing: c.results.filter(r => r.status === "PASS").length, masked: c.masked, declaredButStable: c.declaredButStable });
        const se = [c.logs.status, c.printerRequests.status, c.files.status, c.audit.status, c.lifecycle.status];
        add("V9", "side effects and lifecycle: log lines, printer requests, files written, audit rows, timers and listeners per start", "automated", se.includes("FAIL") ? "FAIL" : se.includes("UNVERIFIED") ? "UNVERIFIED" : "PASS",
          { logs: { status: c.logs.status, missingInHead: c.logs.missingInHead, extraInHead: c.logs.extraInHead, maskedLines: c.maskedLogLines }, printerRequests: { status: c.printerRequests.status, baseRunsAgree: c.printerRequests.baseRunsAgree }, files: c.files.status, audit: c.audit.status,
            lifecycle: c.lifecycle,
            notCovered: "per-request setTimeout calls other than the tracked delays (25000) and listeners on objects other than process are not recorded (Guardian review, V13)" });
      }
    } else { skip("V8", "HTTP contracts", "automated"); skip("V9", "side effects", "automated"); }

    // ---- V10 golden cards ----
    if (want("V10")) {
      const goldenChanged = changed.filter(c => /^test\/fixtures\/card-golden\//.test(c.file));
      const cardTests = headSuites.flatMap(h => h.tests.filter(t => /compactCard\.test\.js$/.test(t.file || "")));
      const ok = !goldenChanged.length && cardTests.length && cardTests.every(t => t.status === "pass");
      add("V10", "golden card files unchanged and the card tests pass", "automated", ok ? "PASS" : "FAIL", { goldenChanged, cardTests: cardTests.length, failing: cardTests.filter(t => t.status !== "pass").map(key) });
    } else skip("V10", "golden cards", "automated");

    // ---- V11 packaging (static) ----
    if (want("V11")) {
      const dockerTests = headSuites.flatMap(h => h.tests.filter(t => /docker\.test\.js$/.test(t.file || "")));
      const allSrc = appPaths(headTree, { browserShared: false }).flatMap(p => jsUnder(headTree, p)).map(f => fs.readFileSync(path.join(headTree, f), "utf8")).join("\n");
      const reach = (manifest.newFiles || []).filter(f => f.endsWith(".js")).map(f => ({ file: f, required: new RegExp(`require\\(["']\\.\\.?/(?:\\.\\./)*${f.replace(/\.js$/, "").replace(/[.]/g, "\\.")}(\\.js)?["']\\)`).test(allSrc) }));
      const pkgB = JSON.parse(git("show", `${base}:package.json`)).pkg, pkgH = JSON.parse(git("show", `${head}:package.json`)).pkg;
      const ok = dockerTests.length && dockerTests.every(t => t.status === "pass") && reach.every(r => r.required) && JSON.stringify(pkgB) === JSON.stringify(pkgH);
      add("V11", "packaging (static): Dockerfile covers the require graph, new files are plainly required, pkg config unchanged", "automated", ok ? "PASS" : "FAIL",
        { dockerTests: dockerTests.length, dockerFailing: dockerTests.filter(t => t.status !== "pass").map(key), newFilesRequired: reach, pkgUnchanged: JSON.stringify(pkgB) === JSON.stringify(pkgH) });
    } else skip("V11", "packaging (static)", "automated");
  } finally {
    for (const d of [baseTree, headTree]) if (d) fs.rmSync(d, { recursive: true, force: true });
  }
  add("V12", "real Docker build + smoke run and pkg builds", "manual", "MANUAL-REQUIRED", { reason: "downloads images and Node binaries; mandatory before deployment, run only with the owner's explicit approval" });
  add("V13", "load order, shared-state ownership, untested error paths, timing, each changed test file", "agent", "UNVERIFIED", { reason: "pending the Refactor Guardian's review of this report and the diff" });

  const auto = report.checks.filter(c => c.kind === "automated");
  report.automated = auto.some(c => c.status === "FAIL") ? "FAIL" : auto.some(c => c.status === "UNVERIFIED") ? "UNVERIFIED" : auto.some(c => c.status === "REVIEW") ? "REVIEW"
    : auto.some(c => c.status === "PASS_WITH_KNOWN_FAILURES") ? "PASS_WITH_KNOWN_FAILURES" : "PASS";
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "report.md"), [`# Verification: ${report.boundary}`, "", `base \`${base}\` → head \`${head}\` (${report.repo})`, "",
    "| Check | Kind | Status | What |", "|---|---|---|---|", ...report.checks.map(c => `| ${c.id} | ${c.kind} | ${c.status} | ${c.title} |`), "",
    `Automated checks: **${report.automated}**. V12 (manual) and V13 (Guardian) are required before deployment.`, "", DISCLAIMER, ""].join("\n"));
  console.log(`\nautomated: ${report.automated} — ${path.join(outDir, "report.json")}\n${DISCLAIMER}`);
  process.exit(report.automated === "FAIL" ? 1 : 0);
}

function summary(s) {
  const c = {}; for (const t of s.tests) c[t.status] = (c[t.status] || 0) + 1;
  return { label: s.label, tests: s.tests.length, ...c, dockerExit: s.dockerExit, nodeTestExit: s.meta && s.meta.exit, seconds: s.meta && s.meta.seconds };
}

main();
