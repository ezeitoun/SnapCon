// tools/refactor/lib/appPaths.js — the app's own source paths (never tools/,
// test/, scripts/, spike/, fixtures/ or data folders). Shared by the
// dependency-cruiser and ast-grep runners so both look at the same code.
"use strict";
const fs = require("fs");
const path = require("path");
const APP_DIRS = ["connectors", "remote-access", "sync", "queue", "transfers", "audit", "utilization", "library", "netfs", "routes"];
function appPaths(root, { browserShared = true } = {}) {
  const top = fs.readdirSync(root).filter(f => f.endsWith(".js") && fs.statSync(path.join(root, f)).isFile()).sort();
  const dirs = APP_DIRS.filter(d => fs.existsSync(path.join(root, d)));
  return [...top, ...dirs, ...(browserShared ? ["public/printer-identity.js", "public/rediscover.js"] : [])];
}
module.exports = { appPaths, APP_DIRS };
