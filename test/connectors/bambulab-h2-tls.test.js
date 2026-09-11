// test/connectors/bambulab-h2-tls.test.js — the Bambu connector's real TLS
// path, against a real TLS server.
//
// A Bambu printer's broker certificate is issued by Bambu's private CA with
// the printer's SERIAL as its common name and no subjectAltName, so Node's
// default hostname check could never pass against the LAN IP. The connector
// replaces it with "chains to Bambu's CA AND the CN is the configured serial".
// Both halves matter: without the CA check any device on the LAN could
// collect the access code; without the CN check any Bambu printer could stand
// in for another. The fixtures (test/fixtures/bambu-tls/) are a throwaway CA
// and two leaf certificates with made-up serials; the CA is added to the trust
// list only for the tests that need it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const tls = require("tls");
const bambu = require("../../connectors/bambulab-h2");
const { BAMBU_CA_PEMS } = require("../../connectors/bambu-ca");
const { h2sPrinting } = require("../fixtures/bambu-reports");
const { createFakeBambuBroker } = require("../helpers/fakeBambuBroker");

const I = bambu._internal;
const FIX = path.join(__dirname, "..", "fixtures", "bambu-tls");
const read = f => fs.readFileSync(path.join(FIX, f), "utf8");
const TEST_CA = read("ca.pem");
const CODE = "a1b2c3d4";
const SERIAL = "TESTSERIAL0001";

async function tlsBroker(certCn, fn) {
  const sniSeen = [];
  const broker = createFakeBambuBroker({
    serial: SERIAL, accessCode: CODE, report: h2sPrinting(),
    createServer: handler => {
      const srv = tls.createServer({ key: read(certCn + "-key.pem"), cert: read(certCn + ".pem") }, handler);
      srv.on("secureConnection", s => sniSeen.push(s.servername));
      srv.on("tlsClientError", () => {});
      return srv;
    }
  });
  const port = await broker.listen();
  I.setTransportFactory(null); // the real TLS transport
  try { await fn(port, broker, sniSeen); }
  finally {
    for (const [key, c] of I.connections) { I.teardown(c); I.connections.delete(key); }
    await broker.close();
  }
}

function trustTestCa() {
  BAMBU_CA_PEMS.push(TEST_CA);
  return () => { const i = BAMBU_CA_PEMS.indexOf(TEST_CA); if (i !== -1) BAMBU_CA_PEMS.splice(i, 1); };
}

const printer = (port, over = {}) => ({ id: "p_tls_" + Math.random().toString(16).slice(2), name: "H2S-TLS", url: `mqtts://127.0.0.1:${port}`, serial: SERIAL, verificationCode: CODE, ...over });

test("the bundled Bambu CA certificates all parse, and none has expired", () => {
  const { X509Certificate } = require("crypto");
  assert.ok(BAMBU_CA_PEMS.length >= 6);
  for (const pem of BAMBU_CA_PEMS) {
    const c = new X509Certificate(pem);
    assert.match(c.subject, /BBL/);
    assert.ok(new Date(c.validTo) > new Date(), c.subject + " expired " + c.validTo);
  }
});

test("tlsOptions: verified by default, SNI is the serial, pinned to TLS 1.2", () => {
  const o = I.tlsOptions({ host: "10.0.0.9", port: 8883, serial: SERIAL }, { insecure: false });
  assert.equal(o.rejectUnauthorized, true);
  assert.equal(o.servername, SERIAL);
  assert.equal(o.minVersion, "TLSv1.2");
  assert.equal(o.maxVersion, "TLSv1.2");
  assert.equal(o.ca, BAMBU_CA_PEMS);
  assert.equal(o.checkServerIdentity("10.0.0.9", { subject: { CN: SERIAL } }), undefined);
  assert.equal(o.checkServerIdentity("10.0.0.9", { subject: { CN: SERIAL.toLowerCase() } }), undefined, "case-insensitive");
  assert.equal(o.checkServerIdentity("10.0.0.9", { subject: { CN: "SOMEONEELSE" } }).code, "ERR_BAMBU_CERT_SERIAL");
  assert.equal(I.tlsOptions({ host: "h", port: 1, serial: SERIAL }, { insecure: true }).rejectUnauthorized, false);
});

test("TLS: a printer whose certificate chains to the CA and names the serial is accepted", async () => {
  const untrust = trustTestCa();
  try {
    await tlsBroker("TESTSERIAL0001", async (port, _broker, sniSeen) => {
      const r = await bambu.probe(printer(port));
      assert.equal(r.online, true, r.error);
      assert.equal(r.state, "printing");
      assert.deepEqual(sniSeen, [SERIAL], "SNI carries the serial, not the IP");
    });
  } finally { untrust(); }
});

test("TLS: a genuine certificate for a DIFFERENT serial is refused before the access code is sent", async () => {
  const untrust = trustTestCa();
  try {
    await tlsBroker("SOMEOTHERSERIAL", async (port, broker) => {
      const r = await bambu.probe(printer(port));
      assert.equal(r.online, false);
      assert.match(r.error, /Serial number mismatch/);
      assert.equal(broker.state.logins.length, 0, "the access code never left SnapCon");
    });
  } finally { untrust(); }
});

test("TLS: a certificate that does not chain to Bambu's CA is refused before the access code is sent", async () => {
  await tlsBroker("TESTSERIAL0001", async (port, broker) => {
    const r = await bambu.probe(printer(port));
    assert.equal(r.online, false);
    assert.match(r.error, /could not be verified/);
    assert.equal(broker.state.logins.length, 0, "the access code never left SnapCon");
  });
});
