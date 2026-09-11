// test/connectors/bambu-preview.test.js — the job preview for Bambu Lab
// printers: the plate image inside the job's .3mf, read over implicit FTPS
// from a fake printer (test/helpers/fakeFtpsServer.js) with real TLS, trusted
// through the same Bambu-CA + serial-as-CN policy as the MQTT connection.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const tls = require("tls");
const path = require("path");
const crypto = require("crypto");
const bambu = require("../../connectors/bambulab-h2");
const preview = require("../../connectors/bambu-preview");
const { readCentralDirectory, readEntry } = require("../../connectors/zip-reader");
const { BAMBU_CA_PEMS } = require("../../connectors/bambu-ca");
const { createFakeFtpsServer, buildZip } = require("../helpers/fakeFtpsServer");
const { createFakeBambuBroker } = require("../helpers/fakeBambuBroker");
const { h2dPrinting } = require("../fixtures/bambu-reports");

const I = bambu._internal;
const TLSFIX = path.join(__dirname, "..", "fixtures", "bambu-tls");
const read = f => fs.readFileSync(path.join(TLSFIX, f), "utf8");
const SERIAL = "TESTSERIAL0001", CODE = "a1b2c3d4";

const PNG1 = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("plate one")]);
const PNG2 = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), crypto.randomBytes(3000)]);
// A realistically heavy .3mf: ~3 MB of model data ahead of the metadata.
const MODEL = crypto.randomBytes(3 * 1024 * 1024);
const ARCHIVE = buildZip([
  { name: "3D/3dmodel.model", data: MODEL },
  { name: "Metadata/plate_1.png", data: PNG1, deflate: true },
  { name: "Metadata/plate_2.png", data: PNG2 },
  { name: "Metadata/plate_2_small.png", data: Buffer.from("small") },
  { name: "Metadata/plate_2.gcode", data: Buffer.from("G28\n".repeat(1000)), deflate: true }
]);

// ---- pure pieces ----

test("zip reader: stored and deflated entries, reading only what it needs", async () => {
  let bytes = 0;
  const readRange = async (o, l) => { bytes += l; return ARCHIVE.subarray(o, o + l); };
  const entries = await readCentralDirectory(readRange, ARCHIVE.length);
  assert.deepEqual(entries.map(e => e.name), ["3D/3dmodel.model", "Metadata/plate_1.png", "Metadata/plate_2.png", "Metadata/plate_2_small.png", "Metadata/plate_2.gcode"]);
  assert.ok((await readEntry(readRange, entries[1])).equals(PNG1), "deflated");
  assert.ok((await readEntry(readRange, entries[2])).equals(PNG2), "stored");
  assert.ok(bytes < ARCHIVE.length / 20, "read " + bytes + " of " + ARCHIVE.length + " bytes");
});

test("zip reader: a file that is not a ZIP is refused clearly", async () => {
  const junk = crypto.randomBytes(5000);
  await assert.rejects(readCentralDirectory(async (o, l) => junk.subarray(o, o + l), junk.length), /not a ZIP/);
});

test("candidate file names follow how Bambu stores sent jobs", () => {
  const { candidateNames, plateIndex } = preview._internal;
  assert.deepEqual(candidateNames("Bracket v4", "/data/Metadata/plate_2.gcode"), ["Bracket v4.gcode.3mf", "Bracket v4.3mf"], "the RAM-disk gcode path is not a file name");
  assert.deepEqual(candidateNames("", "36mm.gcode.3mf"), ["36mm.gcode.3mf"]);
  assert.deepEqual(candidateNames("evil\r\nDELE x", ""), [], "a line break can never reach an FTP command");
  assert.equal(plateIndex("/data/Metadata/plate_3.gcode"), 3);
  assert.equal(plateIndex(""), 1);
});

// ---- through the connector, over real TLS ----

async function withPrinter(opts, fn) {
  preview._internal.clear();
  BAMBU_CA_PEMS.push(read("ca.pem"));
  const ftp = createFakeFtpsServer({ key: read("TESTSERIAL0001-key.pem"), cert: read("TESTSERIAL0001.pem"), accessCode: CODE, ...opts });
  const ftpPort = await ftp.listen();
  const rep = h2dPrinting();
  rep.gcode_file = "/data/Metadata/plate_2.gcode";
  const broker = createFakeBambuBroker({ serial: SERIAL, accessCode: CODE, report: rep });
  const mqttPort = await broker.listen();
  I.setTransportFactory(cfg => net.connect(cfg.port, cfg.host));
  I.setFtpTransportFactory({
    control: (cfg) => tls.connect({ ...I.tlsOptions(cfg), port: ftpPort }),
    data: (cfg, port, session) => tls.connect({ ...I.tlsOptions(cfg), port, session })
  });
  const p = { id: "p_prev", name: "H2D-Prev", url: `mqtts://127.0.0.1:${mqttPort}`, serial: SERIAL, verificationCode: CODE };
  try {
    const st = await bambu.probe(p);
    assert.equal(st.online, true, st.error);
    await fn(p, ftp);
  } finally {
    for (const [key, c] of I.connections) { I.teardown(c); I.connections.delete(key); }
    I.setTransportFactory(null); I.setFtpTransportFactory(null);
    BAMBU_CA_PEMS.splice(BAMBU_CA_PEMS.indexOf(read("ca.pem")), 1);
    preview._internal.clear();
    await broker.close(); await ftp.close();
  }
}

test("preview: the printing plate's image, from /cache, via ranged reads", async () => {
  await withPrinter({ files: { "/cache/Bracket v4.gcode.3mf": ARCHIVE } }, async (p, ftp) => {
    const { contentType, buffer } = await bambu.getThumbnail(p, "Bracket v4");
    assert.equal(contentType, "image/png");
    assert.ok(buffer.equals(PNG2), "plate_2.png, because the printer reports plate_2.gcode");
    assert.ok(ftp.state.bytesSent < ARCHIVE.length / 4, `sent ${ftp.state.bytesSent} of ${ARCHIVE.length} bytes`);
    assert.ok(ftp.state.commands.some(c => c.startsWith("REST ")));
    assert.ok(!ftp.state.commands.some(c => /^(STOR|DELE|RMD|MKD|RNFR|RNTO|APPE)\b/.test(c)), "read-only");
  });
});

test("preview: cached per job — asking again only checks the file's size, it does not read it again", async () => {
  await withPrinter({ files: { "/Bracket v4.3mf": ARCHIVE } }, async (p, ftp) => {
    await bambu.getThumbnail(p, "Bracket v4");
    const [retrs, bytes] = [ftp.state.retrs, ftp.state.bytesSent];
    const again = await bambu.getThumbnail(p, "Bracket v4");
    assert.ok(again.buffer.equals(PNG2));
    assert.equal(ftp.state.retrs, retrs, "no transfer");
    assert.equal(ftp.state.bytesSent, bytes);
  });
});

test("preview: a job re-sliced under the same name gets its new image, not the cached one", async () => {
  const files = { "/cache/Bracket v4.gcode.3mf": ARCHIVE };
  await withPrinter({ files }, async (p) => {
    assert.ok((await bambu.getThumbnail(p, "Bracket v4")).buffer.equals(PNG2));
    const NEW = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("re-sliced")]);
    files["/cache/Bracket v4.gcode.3mf"] = buildZip([{ name: "3D/3dmodel.model", data: MODEL.subarray(0, 1000) }, { name: "Metadata/plate_2.png", data: NEW }]);
    assert.ok((await bambu.getThumbnail(p, "Bracket v4")).buffer.equals(NEW));
  });
});

test("preview: a server without REST falls back to one whole-file read", async () => {
  await withPrinter({ noRest: true, files: { "/cache/Bracket v4.gcode.3mf": ARCHIVE } }, async (p, ftp) => {
    const { buffer } = await bambu.getThumbnail(p, "Bracket v4");
    assert.ok(buffer.equals(PNG2));
    assert.equal(ftp.state.retrs, 1 + 0, "whole file fetched exactly once");
  });
});

test("preview: a server without SIZE is searched by listing", async () => {
  await withPrinter({ noSize: true, files: { "/cache/Bracket v4.3mf": ARCHIVE } }, async (p) => {
    const { buffer } = await bambu.getThumbnail(p, "Bracket v4");
    assert.ok(buffer.equals(PNG2));
  });
});

test("preview: a job whose file is not on the printer is a 404, remembered for a while", async () => {
  await withPrinter({ files: {} }, async (p, ftp) => {
    await assert.rejects(bambu.getThumbnail(p, "Bracket v4"), e => e.status === 404);
    const logins = ftp.state.logins;
    await assert.rejects(bambu.getThumbnail(p, "Bracket v4"), e => e.status === 404);
    assert.equal(ftp.state.logins, logins, "the miss is cached — the card's retries cost nothing");
  });
});

test("preview: another job's file uses plate 1 (only the printing job's plate is known)", async () => {
  await withPrinter({ files: { "/cache/Older job.gcode.3mf": ARCHIVE } }, async (p) => {
    const { buffer } = await bambu.getThumbnail(p, "Older job");
    assert.ok(buffer.equals(PNG1));
  });
});

test("preview: a wrong access code is a 404, not a hang or a crash", async () => {
  await withPrinter({ accessCode: "different", files: { "/cache/Bracket v4.gcode.3mf": ARCHIVE } }, async (p) => {
    await assert.rejects(bambu.getThumbnail(p, "Bracket v4"), e => e.status === 404);
  });
});

test("preview: the data connection goes to the verified host, never to the address in the PASV reply", async () => {
  // The fake server advertises 10.99.99.99; the test transport would fail to
  // reach it — success proves the advertised host was ignored.
  await withPrinter({ files: { "/cache/Bracket v4.gcode.3mf": ARCHIVE } }, async (p) => {
    assert.ok((await bambu.getThumbnail(p, "Bracket v4")).buffer.equals(PNG2));
  });
});
