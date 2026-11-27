#!/usr/bin/env node
// tools/refactor/bin/sg-scan.js — the ast-grep enforcement rules over the
// app's own paths, from an approved refactor worktree only. Exit 1 on any
// error-level hit. Report: tools/refactor/out/ast-grep/scan.json.
"use strict";
const path = require("path");
const guard = require("../lib/guard");
const tools = require("../lib/tools");
const { appPaths } = require("../lib/appPaths");

const ctx = guard.check();
const cfg = path.join(ctx.toolsDir, "sgconfig.yml");
const r = tools.astGrep(ctx, ["scan", "-c", cfg, "--json=compact", ...appPaths(ctx.worktree)]);
let hits;
try { hits = JSON.parse(r.stdout || "[]"); } catch { console.error(r.stderr || r.stdout); process.exit(2); }
tools.writeOut(ctx, "ast-grep/scan.json", hits);
console.log(`${hits.length} hit(s)`);
for (const h of hits) console.log(`  ${h.severity || "error"} ${h.ruleId}: ${h.file}:${h.range.start.line + 1} ${h.text.split("\n")[0].slice(0, 90)}`);
process.exit(hits.length ? 1 : 0);
