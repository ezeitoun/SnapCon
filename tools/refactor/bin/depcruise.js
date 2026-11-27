#!/usr/bin/env node
// tools/refactor/bin/depcruise.js — dependency-cruiser over SnapCon's app
// code, from an approved refactor worktree only. Starts from the app's own
// files (never tools/, test/ or scripts/, which stay visible as targets).
//   node tools/refactor/bin/depcruise.js [--baseline-check | --write-baseline-proposal] [--json]
"use strict";
const fs = require("fs");
const path = require("path");
const guard = require("../lib/guard");
const tools = require("../lib/tools");

const ctx = guard.check();
const CONFIG = path.join(ctx.toolsDir, ".dependency-cruiser.cjs");
const KNOWN = path.join(ctx.toolsDir, ".dependency-cruiser-known-violations.json");
const { appPaths } = require("../lib/appPaths");
const startPoints = () => appPaths(ctx.worktree);

// The reviewed baseline must match its metadata and belong to this history.
const META = path.join(ctx.toolsDir, ".dependency-cruiser-known-violations.meta.json");
if (fs.existsSync(KNOWN)) {
  const known = JSON.parse(fs.readFileSync(KNOWN, "utf8"));
  const meta = fs.existsSync(META) ? JSON.parse(fs.readFileSync(META, "utf8")) : null;
  if (!meta) { console.error("baseline without its reviewed metadata: refusing"); process.exit(2); }
  if (!Array.isArray(known) || known.length !== meta.knownViolations) { console.error(`baseline holds ${Array.isArray(known) ? known.length : "?"} violations, metadata says ${meta.knownViolations}: refusing`); process.exit(2); }
  const { spawnSync } = require("child_process");
  const anc = spawnSync("git", ["merge-base", "--is-ancestor", meta.base, "HEAD"], { cwd: ctx.worktree });
  if (anc.status !== 0) { console.error(`baseline base ${meta.base} is not an ancestor of HEAD: refusing`); process.exit(2); }
}
const args = process.argv.slice(2);
const common = ["--config", CONFIG, "--output-type", "json"];
if (fs.existsSync(KNOWN) && !args.includes("--write-baseline-proposal")) common.push("--ignore-known", KNOWN);
const r = tools.depcruise(ctx, [...common, ...startPoints()]);
if (r.status !== 0 && !r.stdout) { console.error(r.stderr); process.exit(2); }
const result = JSON.parse(r.stdout);
const v = result.summary.violations;
if (args.includes("--write-baseline-proposal")) {
  // A proposal only: the tracked baseline changes through a reviewed commit.
  const p = tools.writeOut(ctx, "depcruise/known-violations.proposed.json", v.map(x => ({ type: x.type, from: x.from, to: x.to, rule: x.rule, ...(x.cycle ? { cycle: x.cycle } : {}) })));
  console.log("proposal written: " + p + " (" + v.length + " violations)");
}
tools.writeOut(ctx, "depcruise/result.json", result);
const s = result.summary;
console.log(`${s.totalCruised} modules, ${s.totalDependenciesCruised} dependencies; ${v.length} violation(s) not in the known baseline; ${s.ignore || 0} known (ignored)`);
for (const x of v) console.log(`  ${x.rule.severity} ${x.rule.name}: ${x.from} → ${x.to}${x.cycle ? " (cycle: " + x.cycle.map(c => c.name || c).join(" → ") + ")" : ""}`);
process.exit(v.some(x => x.rule.severity === "error") ? 1 : 0);
