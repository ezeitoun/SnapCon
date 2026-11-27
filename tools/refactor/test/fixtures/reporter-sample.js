// tools/refactor/test/fixtures/reporter-sample.js — one test of each kind, run
// by test/jsonReporter.test.js through harness/json-reporter.mjs. Not matched
// by the tooling's "test/*.test.js" glob, so it never runs on its own.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

test("ordinary pass", () => { assert.equal(1, 1); });
test("ordinary failure", () => { assert.equal(30, 215); });
test("failing todo", { todo: "documented known bug" }, () => { assert.equal(30, 215); });
test("passing todo", { todo: "documented known bug, fixed meanwhile" }, () => { assert.equal(1, 1); });
test("skipped", { skip: "not on this platform" }, () => { assert.fail("never runs"); });
