// test/utilization/serverHook.test.js — how server.js uses fleet utilization:
// from the existing poll, guarded, and nowhere near a printer command.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createUtilization } = require("../../utilization");
const { quiet, tmpBase } = require("./helpers");

const server = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
const fnSrc = name => { const at = server.indexOf(name); return server.slice(at, at + server.slice(at).search(/\r?\n\}\r?\n/) + 3); };

test("the reading is taken in notifyTick, before the offline early return, and only there", () => {
  const tick = fnSrc("async function notifyTick(");
  const probe = tick.indexOf("const st = await probeCached(p);");
  const observe = tick.indexOf("utilization.observe(p, st);");
  const early = tick.indexOf("if (!st.online)");
  assert.ok(probe > 0 && observe > probe && observe < early, "observed right after the probe, offline included");
  assert.ok(tick.indexOf("utilization.beginTick(CFG.printers, PRINTERS);") < probe);
  assert.equal(server.split("utilization.observe(").length, 2, "one place feeds it");
  const end = tick.lastIndexOf("utilization.endTick();");
  assert.ok(end > tick.lastIndexOf("}));"), "saving starts after every printer of the poll is done");
});

test("nothing in utilization/ can send anything to a printer", () => {
  for (const f of fs.readdirSync(path.join(__dirname, "..", "..", "utilization"))) {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "utilization", f), "utf8");
    assert.doesNotMatch(src, /require\(["'][^"']*connectors|fetch\(|http\.request|getConnector/, f);
  }
});

test("every entry point swallows its own failures", async t => {
  const u = createUtilization({ baseDir: tmpBase(t), log: quiet, sqlite: null });
  assert.doesNotThrow(() => { u.start(); u.beginTick(null, undefined); u.observe(null, null); u.observe({ id: "x" }, { online: true, state: "printing" }); });
  await u.stop();
  const v = createUtilization({ baseDir: tmpBase(t), log: quiet });
  v.start();
  assert.doesNotThrow(() => v.observe(undefined, undefined));
  assert.doesNotThrow(() => v.endTick());
  assert.doesNotThrow(() => v.beginTick([{ id: "a", name: "A" }, null, {}], [{ id: "a" }]));
  await v.stop();
  assert.equal(v.isAvailable(), false, "closed");
});

test("after recording stopped on an error, shutdown still closes the database", async t => {
  const u = createUtilization({ baseDir: tmpBase(t), log: quiet });
  u.start();
  u.observe({ id: "x", name: "X" }, { online: true, state: "standby" });
  const r = u.beginTick({ [Symbol.iterator]() { throw new Error("boom"); } }, []);
  assert.equal(r, undefined);
  assert.equal(u.status().recording, false);
  const res = await u.stop();
  assert.equal(u.isAvailable(), false, "closed");
  assert.ok(res);
});

test("stopped on shutdown, backed up nightly, kept out of Git and in the Docker volume", () => {
  // The exit deadline is armed before any cleanup; utilization stops (async)
  // before Remote Access and the Library, as it always has.
  const sd = fnSrc("function shutdown(");
  const timerAt = sd.indexOf("setTimeout(() => process.exit(0), 8000)"), httpAt = sd.indexOf("httpServer.close()");
  const utilAt = sd.indexOf("utilization.stop()"), raAt = sd.indexOf("remoteAccess.disableForShutdown()"), libAt = sd.indexOf("library.stop()");
  assert.ok(timerAt > 0 && timerAt < httpAt && httpAt < utilAt && utilAt < raAt && utilAt < libAt, "order");
  assert.match(sd, /Promise\.resolve\(\)\.then\(\(\) => utilization\.stop\(\)\)[\s\S]*\.then\(\(\) => Promise\.all\(\[/, "Remote Access and the Library after utilization");
  assert.match(fnSrc("function backupDatabasesIfDue("), /backupStoreIfDue\("utilization", utilization, "admin"\)/);
  const root = path.join(__dirname, "..", "..");
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^utilization-data\/$/m);
  assert.match(fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8"), /\.\/utilization-data:\/app\/utilization-data/);
  assert.match(fs.readFileSync(path.join(root, "Dockerfile"), "utf8"), /^COPY utilization \.\/utilization$/m);
  // The checkpoint worker is loaded by path: the packaged build must carry it.
  assert.ok(require(path.join(root, "package.json")).pkg.scripts.includes("utilization/checkpoint-worker.js"));
  assert.match(fs.readFileSync(path.join(root, "utilization", "Checkpointer.js"), "utf8"), /path\.join\(__dirname, "checkpoint-worker\.js"\)/);
  // The reporting API: behind sign-in, each printer through printerVisibleTo.
  assert.match(server, /utilization\.registerRoutes\(app, \{ requireAuth, getConfig: \(\) => CFG\.utilization, getPrinters: \(\) => PRINTERS, printerVisibleTo \}\)/);
});
