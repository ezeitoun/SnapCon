// test/helpers/fileIdentity.js — netfs.identity as netfs/netfs-worker.js
// computes it (§37 A4), for harnesses that run on real files.
const fs = require("fs");
const fileIdentity = async p => { const s = fs.statSync(p, { bigint: true }); return { size: Number(s.size), mtimeMs: Number(s.mtimeMs), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs), ino: String(s.ino), dev: String(s.dev) }; };
module.exports = { fileIdentity };
