// tools/refactor/selftest/variants.js — deliberately broken heads for
// validating scripts/verify-refactor.js. Each must be caught by the checks
// named in `expect`; "same" must pass everything.
module.exports = [
  { branch: "same", what: "no change at all (harness self-test)", expect: "all automated checks PASS", edits: [] },
  { branch: "fan-threshold", what: "behavior: fan counted as spinning at any rpm", expect: ["V6", "V7", "V8"],
    edits: [{ file: "server.js", find: "const FAN_STOPPED_RPM_THRESHOLD = 50;", replace: "const FAN_STOPPED_RPM_THRESHOLD = 0;" }] },
  { branch: "visibility", what: "behavior: Health ignores group visibility", expect: ["V6", "V8"],
    edits: [{ file: "server.js", find: 'if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });\n  const c = getConnector(p.connector);\n  if (!c.getHealth)', replace: 'if (!p) return res.status(400).json({ error: "Unknown printer" });\n  const c = getConnector(p.connector);\n  if (!c.getHealth)' }] },
  { branch: "reload-resets-state", what: "lifetime: a Settings save clears the Health maps", expect: ["V8"],
    edits: [{ file: "server.js", find: "    loadConfig();\n", replace: "    loadConfig();\n    heaterStableSince.clear(); fanMismatchSeen.clear();\n" }] },
  { branch: "weakened-test", what: "test: an assertion removed from the Health pins", expect: ["V6"],
    edits: [{ file: "test/healthBehaviour.test.js", find: '  assert.equal(r2.body.heaters.list[0].state, "stable", "dwell kept across the reload");\n', replace: "" }] },
  { branch: "forbidden-schema", what: "forbidden: database schema touched", expect: ["V1", "V2"],
    edits: [{ file: "library/schema.js", find: '"use strict";', replace: '"use strict"; // touched' }] },
  { branch: "golden", what: "forbidden: a golden card file changed", expect: ["V1", "V2", "V10"],
    edits: [{ file: "test/fixtures/card-golden/full-classic.printing.html", append: "<!-- changed -->\n" }] },
  { branch: "bad-module", what: "boundary: a route module requires server.js and makes state per registration", expect: ["V1", "V4", "V5"],
    edits: [{ file: "routes/bad.js", create: '"use strict";\nconst s = require("../server");\nfunction registerBadRoutes(app) { const seen = new Map(); app.get("/api/bad", (q, r) => r.json([...seen])); }\nmodule.exports = { registerBadRoutes };\n' }] },
  { branch: "side-effect", what: "side effect: an extra file written at start-up", expect: ["V9"],
    edits: [{ file: "server.js", find: "loadUsers();\n", replace: "loadUsers();\ntry { fs.writeFileSync(path.join(BASE_DIR, \"selftest-extra.txt\"), \"x\"); } catch {}\n" }] },
  { branch: "extra-interval", what: "lifecycle: an extra interval started at start-up", expect: ["V9"],
    edits: [{ file: "server.js", find: "loadUsers();\n", replace: "loadUsers();\nsetInterval(() => {}, 123456).unref();\n" }] },
  { branch: "health-timer-leak", what: "lifecycle: the Health deadline timer is never cleared", expect: ["V6", "V9"],
    edits: [{ file: "server.js", find: 'reasonCode: "connector_error" });\n  } finally {\n    clearTimeout(timer);\n  }', replace: 'reasonCode: "connector_error" });\n  } finally {\n  }' }] },
];
