// tools/refactor/harness/run-tests-in-container.js — runs node:test files of
// the app copy at /src INSIDE the isolated harness container (--network none)
// and writes one JSON line per test to /out/<label>.tests.jsonl.
//   node /harness/run-tests-in-container.js --label <name> [--files "test/**/*.test.js" | --files a.test.js,b.test.js]
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const LABEL = arg("--label"), FILES = arg("--files") || "test/**/*.test.js";
const APP = "/tmp/app";
fs.rmSync(APP, { recursive: true, force: true });
fs.cpSync("/src", APP, { recursive: true });
fs.symlinkSync("/deps/node_modules", path.join(APP, "node_modules"));
const files = FILES.includes("*") ? [FILES] : FILES.split(",");
const t0 = Date.now();
const r = spawnSync(process.execPath, ["--test", "--test-reporter=/harness/json-reporter.mjs", "--test-reporter-destination=stdout", ...files],
  { cwd: APP, encoding: "utf8", env: { PATH: process.env.PATH, HOME: "/tmp", TZ: "UTC" }, maxBuffer: 256 * 1024 * 1024, timeout: 20 * 60 * 1000 });
fs.writeFileSync(path.join("/out", LABEL + ".tests.jsonl"), r.stdout);
fs.writeFileSync(path.join("/out", LABEL + ".tests.meta.json"), JSON.stringify({ exit: r.status, seconds: (Date.now() - t0) / 1000, stderrTail: (r.stderr || "").slice(-4000), files }, null, 2));
process.exit(0);
