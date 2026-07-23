// remote-access/RemoteAccessStore.js — persisted, non-secret Remote Access
// config. Same sync readFileSync/writeFileSync convention as server.js's
// loadConfig()/loadUsers() — no DB, no async fs, just a small JSON file.
//
// NEVER put the tunnel token in this file. It lives only in
// SecureCredentialStore. This file only ever holds identity/status metadata
// that's safe to read in plain text (hubId/hostname/publicUrl are not
// secrets — they're what the backend already handed back and what the UI
// displays openly).
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  enabled: false,
  autoStart: false,
  hubId: null,
  hostname: null,
  publicUrl: null,
  tunnelId: null,
  cloudflaredVersion: null,
  createdAt: null,
  lastConnectedAt: null,
  installationId: null,
  allowInsecureFallback: false,
  registrationSessionId: null,
  registerUrl: null,
  registrationExpiresAt: null
};

function dataDir(baseDir) {
  return path.join(baseDir, "remote-access-data");
}
function filePath(baseDir) {
  return path.join(dataDir(baseDir), "remote-access.json");
}

function load(baseDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(baseDir), "utf8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

// Defense in depth, not just convention: strip any secret-shaped field a
// caller might accidentally include, so a coding mistake elsewhere can never
// make the token land in this plain-JSON file. The real secrets only ever
// live in SecureCredentialStore.
const FORBIDDEN_KEYS = ["tunnelToken", "token", "apiKey", "password", "privateKey", "ed25519PrivateKeyJwk"];
function save(baseDir, patch) {
  const current = load(baseDir);
  const cleanPatch = { ...patch };
  for (const k of FORBIDDEN_KEYS) delete cleanPatch[k];
  const next = { ...current, ...cleanPatch };
  fs.mkdirSync(dataDir(baseDir), { recursive: true });
  fs.writeFileSync(filePath(baseDir), JSON.stringify(next, null, 2));
  return next;
}

module.exports = { DEFAULTS, dataDir, filePath, load, save };
