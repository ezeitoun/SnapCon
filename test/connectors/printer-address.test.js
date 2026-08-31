// test/connectors/printer-address.test.js — the split of a printer's single
// stored `url` into the IP/hostname and port the user actually configures.
//
// `url` stays canonical (every connector's baseUrl() reads it); ip/port are
// the inputs it is derived from. The property that matters most here, and
// that most of these tests exist to pin down, is that the split is
// URL-PRESERVING for every address shape a real config holds — an upgrade
// must not move a printer's identity, since the offline cache, the save-time
// match for an id-less row and the fleet lookup all key on that string.
//
// The pure pieces (connectors/address.js, connectors/migratePrinterAddress.js,
// each connector's address contract) run for real. server.js can't be
// required without starting a listener and the frontend is browser-global
// code with no Node harness, so their wiring is asserted against source text —
// the established pattern in this suite (see creality-webrtc-camera.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { isValidHost, isValidPort, normalizePort, parseAddressUrl, composeAddressUrl } = require("../../connectors/address");
const { migratePrinterAddressConfig } = require("../../connectors/migratePrinterAddress");
const { getAddress, listConnectorTypes, CONNECTOR_TYPES } = require("../../connectors");

const ROOT = path.join(__dirname, "..", "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// ---------------------------------------------------------------------------
// The connector-declared address contract
// ---------------------------------------------------------------------------

test("every registered connector declares a complete address contract", () => {
  for (const type of CONNECTOR_TYPES) {
    const a = getAddress(type);
    assert.equal(typeof a.scheme, "string", type + " scheme");
    assert.equal(typeof a.portEditable, "boolean", type + " portEditable");
    assert.equal(typeof a.required, "boolean", type + " required");
    assert.ok(a.defaultPort === null || Number.isInteger(a.defaultPort), type + " defaultPort");
  }
});

test("the address contract matches each connector's real protocol", () => {
  // The U1 serves Moonraker on the plain HTTP port, so it has no port for the
  // user to set. Moonraker-family boxes can sit behind a reverse proxy, so
  // theirs is editable. The simulator has no hardware.
  //
  // FlashForge declares NO default port. Each transport resolves its own (see
  // flashforge-moonraker resolveEndpoint), and a default here would be
  // pre-filled into a new printer's port by the Settings row — which persisted
  // ":8898" into the stored URL and made auto-detection probe 8898 for both
  // transports, reporting a healthy modded printer as offline. The port stays
  // editable as the advanced override, and is authoritative under a pin.
  assert.deepEqual(getAddress("snapmaker-u1-klipper-ws"), { scheme: "http", defaultPort: 80, portEditable: false, required: true });
  assert.deepEqual(getAddress("klipper-moonraker"), { scheme: "http", defaultPort: 7125, portEditable: true, required: true });
  assert.deepEqual(getAddress("creality-klipper"), { scheme: "http", defaultPort: 7125, portEditable: true, required: true });
  assert.deepEqual(getAddress("flashforge-adventurer"), { scheme: "http", defaultPort: null, portEditable: true, required: true });
  assert.deepEqual(getAddress("flashforge-ad5x"), { scheme: "http", defaultPort: null, portEditable: true, required: true });
  assert.equal(getAddress("simulator").required, false);
});

test("an unknown connector type falls back to a usable contract instead of throwing", () => {
  const a = getAddress("does-not-exist");
  assert.equal(a.required, true);
  assert.equal(a.scheme, "http");
});

test("/api/connectors carries the address contract to the browser", () => {
  const creality = listConnectorTypes().find(c => c.type === "creality-klipper");
  assert.deepEqual(creality.address, { scheme: "http", defaultPort: 7125, portEditable: true, required: true });
  assert.ok(listConnectorTypes().every(c => c.address));
});

// ---------------------------------------------------------------------------
// connectors/address.js
// ---------------------------------------------------------------------------

test("isValidHost accepts IPs and hostnames and rejects anything carrying URL syntax", () => {
  for (const ok of ["192.0.2.10", "printer.local", "my-printer", "a", "[::1]"]) {
    assert.equal(isValidHost(ok), true, ok);
  }
  for (const bad of ["", "   ", "http://192.0.2.40", "192.0.2.40:7125", "host/path", "a b", "-lead", "trail-", null, undefined]) {
    assert.equal(isValidHost(bad), false, String(bad));
  }
});

test("port validation accepts 1-65535 and nothing else", () => {
  assert.equal(isValidPort(7125), true);
  assert.equal(isValidPort("7125"), true);
  assert.equal(isValidPort(1), true);
  assert.equal(isValidPort(65535), true);
  for (const bad of [0, -1, 65536, 1.5, "", null, undefined, "abc"]) assert.equal(isValidPort(bad), false, String(bad));
  assert.equal(normalizePort("7125"), 7125);
  assert.equal(normalizePort("nope"), null);
});

test("parseAddressUrl splits every URL shape a config actually holds", () => {
  assert.deepEqual(parseAddressUrl("http://192.0.2.10"), { scheme: "http", host: "192.0.2.10", port: null });
  assert.deepEqual(parseAddressUrl("http://192.0.2.20:7125"), { scheme: "http", host: "192.0.2.20", port: 7125 });
  assert.deepEqual(parseAddressUrl("http://printer.local:7125"), { scheme: "http", host: "printer.local", port: 7125 });
  assert.deepEqual(parseAddressUrl("https://p.example.com"), { scheme: "https", host: "p.example.com", port: null });
  assert.deepEqual(parseAddressUrl("http://192.0.2.30/"), { scheme: "http", host: "192.0.2.30", port: null });
  // No scheme at all: `new URL` either throws or reads the hostname as one.
  assert.deepEqual(parseAddressUrl("192.0.2.40"), { scheme: null, host: "192.0.2.40", port: null });
  assert.deepEqual(parseAddressUrl("printer.local:7125"), { scheme: null, host: "printer.local", port: 7125 });
});

test("parseAddressUrl returns null for anything that would be lost on recompose", () => {
  for (const bad of ["", "   ", "http://host/octoprint", "http://host/?x=1", "http://user:pw@host", "not a url"]) {
    assert.equal(parseAddressUrl(bad), null, String(bad));
  }
});

test("composeAddressUrl writes the port only when one is actually set", () => {
  const spec = { scheme: "http" };
  assert.equal(composeAddressUrl({ host: "192.0.2.10" }, spec), "http://192.0.2.10");
  assert.equal(composeAddressUrl({ host: "192.0.2.20", port: 7125 }, spec), "http://192.0.2.20:7125");
  assert.equal(composeAddressUrl({ host: "p.example.com", scheme: "https" }, spec), "https://p.example.com");
  assert.equal(composeAddressUrl({ host: "" }, spec), "");
});

test("parse then compose is lossless for every stored URL shape", () => {
  for (const url of ["http://192.0.2.10", "http://192.0.2.20:7125", "https://p.example.com", "http://printer.local:7125"]) {
    const parsed = parseAddressUrl(url);
    assert.equal(composeAddressUrl({ scheme: parsed.scheme, host: parsed.host, port: parsed.port }, { scheme: "http" }), url);
  }
});

// ---------------------------------------------------------------------------
// The startup migration
// ---------------------------------------------------------------------------

const FLEET = () => ({
  printers: [
    { id: "p1", name: "U1 Pink", url: "http://192.0.2.10", connector: "snapmaker-u1-klipper-ws", token: "secret" },
    { id: "p2", name: "SPARKX i7", url: "http://192.0.2.20:7125", connector: "creality-klipper" },
    { id: "p3", name: "Voron", url: "http://printer.local:7125", connector: "klipper-moonraker" },
    { id: "p4", name: "Remote", url: "https://p.example.com", connector: "klipper-moonraker" },
    { id: "p5", name: "5M PRO", url: "http://192.0.2.30/", connector: "flashforge-adventurer" },
    { id: "p6", name: "Dummy#1", url: "sim://o029orr1", connector: "simulator" },
    { id: "p7", name: "Odd", url: "http://host/octoprint", connector: "klipper-moonraker" }
  ]
});

test("migration splits each address into ip and port", () => {
  const { cfg } = migratePrinterAddressConfig(FLEET());
  const by = Object.fromEntries(cfg.printers.map(p => [p.id, p]));
  assert.deepEqual([by.p1.ip, by.p1.port], ["192.0.2.10", undefined]);
  assert.deepEqual([by.p2.ip, by.p2.port], ["192.0.2.20", 7125]);
  assert.deepEqual([by.p3.ip, by.p3.port], ["printer.local", 7125]);
  assert.deepEqual([by.p4.ip, by.p4.scheme], ["p.example.com", "https"]);
  assert.deepEqual([by.p5.ip, by.p5.port], ["192.0.2.30", undefined]);
});

test("migration preserves each printer's URL string, so nothing keyed on it moves", () => {
  const before = FLEET();
  const { cfg } = migratePrinterAddressConfig(before);
  for (const p of cfg.printers) {
    const was = before.printers.find(b => b.id === p.id);
    // The one intentional rewrite: a trailing slash, which every connector's
    // own baseUrl() already stripped before making a request.
    const expected = was.url === "http://192.0.2.30/" ? "http://192.0.2.30" : was.url;
    assert.equal(p.url, expected, was.name);
  }
});

test("migration preserves ids, names, tokens and every other field verbatim", () => {
  const before = FLEET();
  const { cfg } = migratePrinterAddressConfig(before);
  for (const p of cfg.printers) {
    const was = before.printers.find(b => b.id === p.id);
    for (const k of Object.keys(was)) {
      if (k === "url") continue;
      assert.deepEqual(p[k], was[k], was.name + "." + k);
    }
  }
  assert.deepEqual(cfg.printers.map(p => p.id), before.printers.map(p => p.id));
});

test("migration leaves a connector with no hardware address (Simulator) completely alone", () => {
  const { cfg } = migratePrinterAddressConfig(FLEET());
  const sim = cfg.printers.find(p => p.id === "p6");
  assert.equal(sim.url, "sim://o029orr1");
  assert.equal("ip" in sim, false);
  assert.equal("port" in sim, false);
});

test("a URL that can't be split is reported and left untouched, never destroyed", () => {
  const { cfg, issues } = migratePrinterAddressConfig(FLEET());
  const odd = cfg.printers.find(p => p.id === "p7");
  assert.equal(odd.url, "http://host/octoprint");
  assert.equal("ip" in odd, false);
  assert.deepEqual(issues, [{ name: "Odd", url: "http://host/octoprint" }]);
});

test("migration is idempotent — a second run changes nothing at all", () => {
  const first = migratePrinterAddressConfig(FLEET());
  assert.equal(first.changed, true);
  const second = migratePrinterAddressConfig(first.cfg);
  assert.equal(second.changed, false);
  assert.deepEqual(second.cfg, first.cfg);
});

test("an already-migrated printer is not re-derived from its url", () => {
  // Hand-edited or freshly saved: ip is authoritative, and a url that
  // disagrees is not used to overwrite it.
  const cfg = { printers: [{ id: "p1", url: "http://192.0.2.10", ip: "192.0.2.50", connector: "klipper-moonraker" }] };
  const { cfg: out, changed } = migratePrinterAddressConfig(cfg);
  assert.equal(changed, false);
  assert.equal(out.printers[0].ip, "192.0.2.50");
});

test("a config with no printers, or a brand-new one, is a no-op", () => {
  assert.equal(migratePrinterAddressConfig({}).changed, false);
  assert.equal(migratePrinterAddressConfig({ printers: [] }).changed, false);
  assert.equal(migratePrinterAddressConfig({ printers: [null] }).changed, false);
});

test("an explicit port is kept even on a connector that hides the port field", () => {
  // A hand-edited config pointing a U1 somewhere non-standard must keep
  // working — the field being hidden is a UI decision, not an address one.
  const { cfg } = migratePrinterAddressConfig({ printers: [{ id: "p1", url: "http://192.0.2.10:8080", connector: "snapmaker-u1-klipper-ws" }] });
  assert.equal(cfg.printers[0].port, 8080);
  assert.equal(cfg.printers[0].url, "http://192.0.2.10:8080");
});

test("the migrated printer keeps its key order, with ip/port next to url", () => {
  const { cfg } = migratePrinterAddressConfig({ printers: [{ name: "A", url: "http://h:7125", connector: "klipper-moonraker", token: "t" }] });
  assert.deepEqual(Object.keys(cfg.printers[0]), ["name", "url", "ip", "port", "connector", "token"]);
});

// ---------------------------------------------------------------------------
// server.js wiring
// ---------------------------------------------------------------------------

test("the migration runs at startup, persists only when something changed, and reports what it couldn't split", () => {
  const i = serverSrc.indexOf("function migratePrinterAddressOnStartup()");
  assert.ok(i > 0, "startup migration is wired in");
  const block = serverSrc.slice(i, i + 1200);
  assert.ok(block.includes("PRINTERS = Array.isArray(CFG.printers)"), "PRINTERS is re-pointed at the migrated array");
  assert.ok(block.includes("if (changed && !CONFIG_LOAD_FAILED)"), "never writes over a config that failed to load");
  assert.ok(block.includes("for (const i of issues)"), "unsplittable addresses are reported");
  // Ordering matters: the address contract comes from the connector a
  // printer ends up on, so the connector migration has to have run first.
  assert.ok(serverSrc.indexOf("migrateU1ConnectorOnStartup") < i);
});

test("buildPrinterRecord derives the canonical url from the address fields and stores both", () => {
  const i = serverSrc.indexOf("async function buildPrinterRecord(p, existing)");
  const head = serverSrc.slice(i, i + 500);
  assert.ok(head.includes("const addr = resolvePrinterAddress(p);"));
  assert.ok(head.includes("url: addr.url"));
  assert.ok(head.includes("if (addr.ip) o.ip = addr.ip;"));
  assert.ok(head.includes("if (addr.port) o.port = addr.port;"));
  assert.ok(head.includes("if (addr.scheme) o.scheme = addr.scheme;"));
});

test("resolvePrinterAddress accepts both submission shapes and never blanks an address it can't parse", () => {
  const i = serverSrc.indexOf("function resolvePrinterAddress(p) {");
  assert.ok(i > 0);
  const fn = serverSrc.slice(i, serverSrc.indexOf("async function buildPrinterRecord", i));
  assert.ok(fn.includes("if (!spec.required) return { url };"), "no-address connectors keep their url");
  assert.ok(fn.includes("isValidHost(ip)") && fn.includes("parseAddressUrl(url)"), "ip field first, url as the fallback");
  assert.ok(fn.includes('if (!addr || !isValidHost(addr.host)) return { url };'), "an unparseable url is passed through, not cleared");
  assert.ok(fn.includes('["http", "https"].includes(addr.scheme)'), "only schemes SnapCon speaks are taken from client input");
});

test("the save path composes the url before the blank-url filter and the identity match", () => {
  const save = serverSrc.slice(serverSrc.indexOf('app.post("/api/config"'), serverSrc.indexOf('app.post("/api/config"') + 3000);
  const compose = save.indexOf("...resolvePrinterAddress(p)");
  const filter = save.indexOf(".filter(p => p && p.url)");
  const match = save.indexOf("PRINTERS.find(ep => ep.url === String(p.url))");
  assert.ok(compose > 0 && filter > compose, "compose happens before the filter that would drop the row");
  assert.ok(match > filter, "the id/url identity match still runs on the canonical url");
  assert.ok(save.includes("(p.id && PRINTERS.find(ep => ep.id === p.id))"), "id is still matched first, so ids stay stable");
});

test("publicCfg still sends the whole printer record, so ip/port reach the Settings rows", () => {
  assert.ok(serverSrc.includes("printers: PRINTERS.map(p => ({ ...p, token: undefined, hasToken: !!p.token }))"));
});

// ---------------------------------------------------------------------------
// public/app.js wiring
// ---------------------------------------------------------------------------

test("the old single URL field is gone from the printer row", () => {
  assert.equal(appSrc.includes("purl"), false, "no .purl field or reader is left");
  assert.ok(appSrc.includes('class="field pip"') && appSrc.includes('class="field pport"'));
});

test("both address fields are real labelled inputs", () => {
  assert.ok(appSrc.includes('<label class="fl" for="pip-${uid}" data-i18n="settings.printers.field_ip">'));
  assert.ok(appSrc.includes('<label class="fl" for="pport-${uid}" data-i18n="settings.printers.field_port">'));
  assert.ok(appSrc.includes('id="pip-${uid}"') && appSrc.includes('id="pport-${uid}"'));
});

test("the row composes its URL the same way the server does", () => {
  const i = appSrc.indexOf("function rowAddressUrl(row){");
  const fn = appSrc.slice(i, i + 500);
  assert.ok(fn.includes('if(!spec.required) return row.dataset.url||"";'), "a Simulator row keeps its synthetic url");
  assert.ok(fn.includes("isValidHostValue(ip)"));
  assert.ok(fn.includes('(port?":"+port:"")'), "the port is only written when set");
});

test("which address fields show is the connector's call, not a hardcoded brand check", () => {
  const i = appSrc.indexOf("const syncAddressFields=(connectorChanged)=>{");
  const fn = appSrc.slice(i, i + 1200);
  assert.ok(fn.includes("connectorAddress(connectorEl.value)"));
  assert.ok(fn.includes('addrRow.style.display=spec.required?"":"none";'));
  assert.ok(fn.includes('portField.style.display=spec.portEditable?"":"none";'));
  // A stale port from the previous connector must not keep composing into
  // the URL from a field nobody can see.
  assert.ok(fn.includes('if(!spec.portEditable) portEl.value="";'));
  assert.ok(fn.includes("else if(!portEl.value.trim()&&spec.defaultPort) portEl.value=String(spec.defaultPort);"));
  assert.ok(fn.includes("if(connectorChanged){"), "both only happen on a deliberate connector change");
});

test("gatherPrinters sends the address fields plus the canonical url", () => {
  const i = appSrc.indexOf("function gatherPrinters(){");
  const fn = appSrc.slice(i, i + 1200);
  assert.ok(fn.includes('ip:r.querySelector(".pip").value.trim()||undefined,'));
  assert.ok(fn.includes('port:r.querySelector(".pport").value.trim()||undefined,'));
  assert.ok(fn.includes('url:rowAddressUrl(r)||r.dataset.url||undefined,'));
});

test("the dirty-state diff tracks the address fields", () => {
  const i = appSrc.indexOf("function serializeRowForDiff(row){");
  const fn = appSrc.slice(i, i + 1200);
  assert.ok(fn.includes('ip:row.querySelector(".pip").value.trim(),'));
  assert.ok(fn.includes('port:row.querySelector(".pport").value.trim(),'));
});

test("a named row with no usable address stops the save instead of being dropped silently", () => {
  const i = appSrc.indexOf("const badAddr=prows.find(r=>{");
  assert.ok(i > 0);
  const block = appSrc.slice(i, i + 900);
  assert.ok(block.includes('if(!ip) return !!r.querySelector(".pname").value.trim();'), "an untouched empty row is still dropped quietly");
  assert.ok(block.includes("return !isValidHostValue(ip);"));
  assert.ok(block.includes('t("settings.printers.save_error_missing_ip"'));
  assert.ok(block.includes('badAddr.querySelector(".pip").focus();'));
  assert.ok(appSrc.indexOf("const needProbe=prows.filter(r=>{") > i, "the check runs before the save does any work");
});

test("a pasted full URL is split into the right fields rather than rejected", () => {
  const i = appSrc.indexOf('ipEl.addEventListener("change",()=>{');
  const fn = appSrc.slice(i, i + 800);
  assert.ok(fn.includes("const parsed=parseAddress(raw);"));
  assert.ok(fn.includes("if(parsed.port&&spec.portEditable) portEl.value=parsed.port;"));
  assert.ok(fn.includes('addrErr.style.display="";'), "only a value that isn't an address at all gets the error");
});

test("the saved address round-trips into the row", () => {
  assert.ok(appSrc.includes("addPrinterRow(p.name,p.url,{id:p.id,ip:p.ip,port:p.port,scheme:p.scheme,"));
  assert.ok(appSrc.includes('row.dataset.scheme=(opts.scheme||'), "a non-default scheme survives a save");
});

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

test("the address strings exist in both bundled locales and the retired URL keys are gone", () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
  const es = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "es.json"), "utf8"));
  for (const loc of [en, es]) {
    const p = loc.settings.printers;
    for (const k of ["field_ip", "field_port", "ip_placeholder", "ip_invalid", "test_connection_no_ip", "save_error_missing_ip"]) {
      assert.ok(p[k] && p[k].trim(), k);
    }
    for (const gone of ["field_url", "url_placeholder", "simulator_url_placeholder", "test_connection_no_url"]) {
      assert.equal(gone in p, false, gone + " should have been removed with the field");
    }
  }
  assert.ok(en.settings.printers.save_error_missing_ip.includes("{name}"));
  assert.ok(es.settings.printers.save_error_missing_ip.includes("{name}"));
});
