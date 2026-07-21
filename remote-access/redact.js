// remote-access/redact.js — scrubs secret values out of any string before
// it's ever logged or stored for display. Shared by CloudflaredManager
// (child-process stdout/stderr) and RemoteAccessApiClient (error messages
// that might otherwise echo request/response bodies containing a token or
// the provisioning key).
//
// Deliberately simple: exact-substring replacement for each known secret
// value, applied always, even in debug output. Not a general secret-
// detector — it only redacts values the caller explicitly hands it, which
// is the only thing that can be redacted reliably without false positives.
function redact(str, secrets) {
  if (typeof str !== "string" || !str) return str;
  let out = str;
  for (const secret of secrets || []) {
    if (!secret || typeof secret !== "string" || secret.length < 6) continue; // too short to bother matching, avoids over-eager redaction of trivial substrings
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

module.exports = { redact };
