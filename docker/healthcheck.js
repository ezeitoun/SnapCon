// docker/healthcheck.js — the image's HEALTHCHECK. Asks the running server
// for /api/version (unauthenticated, cheap) on the port config.json sets, so
// `docker ps` / Portainer / Home Assistant show "healthy" only once the
// dashboard actually answers. Exit 0 = healthy, 1 = not.
const fs = require("fs");
const path = require("path");
const http = require("http");

const dataDir = process.env.SNAPCON_DATA_DIR || path.join(__dirname, "..");
let port = 4545;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  if (Number(cfg.port) > 0) port = Number(cfg.port);
} catch {} // no/unreadable config.json: the server falls back to 4545 too

const req = http.get({ host: "127.0.0.1", port, path: "/api/version", timeout: 4000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on("timeout", () => req.destroy(new Error("timeout")));
req.on("error", () => process.exit(1));
