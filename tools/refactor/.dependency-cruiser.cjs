/** SnapCon module boundaries (docs/refactoring-policy.md). Run from the
 *  repository root through tools/refactor/bin/depcruise.js. Existing
 *  violations are recorded in .dependency-cruiser-known-violations.json and
 *  changed only through a reviewed commit. The browser scripts (public/*.js,
 *  plain <script> files sharing globals) are invisible to this tool, apart
 *  from the two that server.js requires. */
// The app's declared npm dependencies are not installed in refactor
// worktrees (only tools/refactor is), so they cannot resolve there; exempt
// exactly those names from no-unresolvable, nothing else.
const appDeps = Object.keys(require("../../package.json").dependencies || {});
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const declaredDeps = appDeps.length ? "^(" + appDeps.map(escapeRe).join("|") + ")(/|$)" : "^$";

module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", comment: "A module must not depend on itself through others.",
      from: {}, to: { circular: true } },
    { name: "modules-not-to-server", severity: "error", comment: "Only server.js wires the app; nothing requires it back.",
      from: { pathNot: "^server\\.js$" }, to: { path: "^server\\.js$" } },
    { name: "connectors-stay-leaf", severity: "error",
      comment: "Printer connectors must not depend on SnapCon subsystems. netfs/ is allowed: CLAUDE.md requires every file access that can touch the G-code folder to go through it.",
      from: { path: "^connectors/" },
      to: { path: "^(queue|transfers|library|sync|audit|utilization|remote-access|routes)/" } },
    { name: "subsystems-not-to-routes", severity: "error", comment: "Subsystems are used by routes, not the other way round.",
      from: { path: "^(queue|transfers|library|sync|audit|utilization|remote-access|netfs|connectors)/" },
      to: { path: "^routes/" } },
    { name: "app-not-to-tools", severity: "error", comment: "The app never requires refactoring tools, tests or scripts.",
      from: { pathNot: "^(tools|test|scripts|spike)/" },
      to: { path: "^(tools|test|scripts|spike)/|node_modules/(dependency-cruiser|jscodeshift|@ast-grep)" } },
    { name: "no-unresolvable", severity: "error", comment: "Every require resolves.",
      from: {}, to: { couldNotResolve: true, pathNot: declaredDeps } },
  ],
  options: {
    moduleSystems: ["cjs"],
    // Tests, scripts and tools stay visible as dependency targets (so
    // app-not-to-tools can fire) but are not cruised themselves.
    doNotFollow: { path: "node_modules|^(tools|test|scripts|spike)/" },
    // No includeOnly: it would also drop unresolvable requires, which
    // no-unresolvable must see. Browser scripts are excluded except the two
    // shared files server.js requires.
    // tools/, test/, scripts/ are not excluded: they must stay visible as
    // targets. bin/depcruise.js starts from the app's own files only.
    exclude: { path: "node_modules|^(dist|gcode|docs|fixtures)/|-data/|^public/(?!printer-identity\\.js$|rediscover\\.js$)" },
    skipAnalysisNotInRules: false,
  },
};
