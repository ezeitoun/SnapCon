// webhookNotify.js — outbound notification webhooks (Discord, or generic JSON).
//
// The third notification provider alongside ntfy and Telegram (see
// sendNtfy/sendTelegram in server.js). It lives in its own module rather than
// beside them because it is the first place SnapCon fetches a URL the USER
// supplies, which brings security rules the other two do not have — and those
// rules need real unit tests, which server.js has no harness for.
//
// Two things make this provider different from the other two:
//
//  1. The URL *is* the secret. A Discord webhook URL embeds a token granting
//     posting rights to that channel. So it gets telegramBotToken's treatment
//     (never round-trips to the browser) AND must never appear in an error
//     message or log line — hence redactUrls(), which server.js also applies at
//     the shared notification failure logger as defence in depth.
//
//  2. The destination is arbitrary. Private/LAN targets are deliberately
//     ALLOWED: a local n8n or Home Assistant endpoint is exactly the kind of
//     thing a local-first app should be able to post to. The guards are instead
//     on the shape of the request: http/https only, no embedded credentials, no
//     redirect following (so a permissive endpoint cannot bounce the request —
//     and the token in its URL — somewhere else), and a bounded timeout.
const { fetchTimeout } = require("./connectors/http-utils");

// Long enough for a slow home server, short enough that the notification
// watcher's 30s tick is never blocked behind a hanging endpoint.
const WEBHOOK_TIMEOUT_MS = 10000;

// Discord renders the embed's left border in this colour. Mapped to the same
// events the other providers fire on, so a channel is scannable at a glance.
const EVENT_COLORS = {
  start: 0x3B82F6,     // blue
  pause: 0xF59E0B,     // amber
  error: 0xEF4444,     // red
  complete: 0x22C55E,  // green
  milestone: 0x8B5CF6  // violet
};
const DEFAULT_COLOR = 0x9CA3AF;

// Anything URL-shaped becomes a placeholder. Deliberately blunt: a webhook URL
// is a credential, and a transport error or an endpoint's own error body can
// echo it back verbatim. Losing the host from a log line is a fair price for
// guaranteeing the token never lands in one.
function redactUrls(text) {
  if (text == null) return "";
  return String(text).replace(/\bhttps?:\/\/\S+/gi, "[redacted-url]");
}

// Validate a user-supplied webhook URL. Throws with a message safe to show the
// user AND safe to log — it never echoes the input back.
function parseWebhookUrl(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) throw new Error("Webhook URL is not configured");
  let u;
  try { u = new URL(s); } catch { throw new Error("Webhook URL is not a valid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Webhook URL must be http or https");
  }
  // user:pass@host would hand credentials to whatever the URL points at, and is
  // never how a webhook endpoint is addressed.
  if (u.username || u.password) {
    throw new Error("Webhook URL must not contain embedded credentials");
  }
  return u;
}

// The uploaded part's filename must match the embed's attachment:// reference
// exactly or Discord renders a broken image — and not every connector's camera
// returns a JPEG (FlashForge's is BMP), so the real type is preserved rather
// than assumed. Same reasoning as sendNtfy's Filename header.
function snapshotFilename(image) {
  const ct = String((image && image.contentType) || "").toLowerCase();
  if (ct === "image/bmp") return "snapshot.bmp";
  if (ct === "image/png") return "snapshot.png";
  if (ct === "image/webp") return "snapshot.webp";
  return "snapshot.jpg";
}

function buildDiscordPayload({ printerName, message, event, image }) {
  const embed = {
    title: String(printerName || "SnapCon"),
    description: String(message || ""),
    color: EVENT_COLORS[event] != null ? EVENT_COLORS[event] : DEFAULT_COLOR,
    timestamp: new Date().toISOString()
  };
  if (image) embed.image = { url: "attachment://" + snapshotFilename(image) };
  return { username: "SnapCon", embeds: [embed] };
}

// For endpoints that are not Discord (n8n, Home Assistant, anything custom):
// SnapCon's own fields, so a receiver can act on the data rather than parse a
// sentence. No image — an arbitrary endpoint has no agreed way to take one, and
// base64-inlining a snapshot would bloat every request.
function buildJsonPayload({ printerName, message, event, st }) {
  return {
    printer: String(printerName || ""),
    event: String(event || ""),
    message: String(message || ""),
    progress: (st && typeof st.progress === "number") ? st.progress : null,
    filename: (st && st.filename) || null,
    ts: new Date().toISOString()
  };
}

async function sendWebhook({ url, format, printerName, message, event, st, image }) {
  const u = parseWebhookUrl(url);           // before any network call
  const opts = { method: "POST", redirect: "manual" };

  if (format === "json") {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(buildJsonPayload({ printerName, message, event, st }));
  } else {
    const payload = buildDiscordPayload({ printerName, message, event, image });
    if (image && image.buffer) {
      // Node's built-in FormData/Blob handle the multipart upload, same
      // no-SDK approach as sendTelegram's sendPhoto. Content-Type is left to
      // fetch so it can set the multipart boundary.
      const name = snapshotFilename(image);
      const fd = new FormData();
      fd.append("payload_json", JSON.stringify(payload));
      fd.append("files[0]", new Blob([image.buffer], { type: image.contentType || "image/jpeg" }), name);
      opts.body = fd;
    } else {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(payload);
    }
  }

  let r;
  try {
    r = await fetchTimeout(u.toString(), WEBHOOK_TIMEOUT_MS, opts);
  } catch (e) {
    // A transport error routinely embeds the URL it failed to reach.
    throw new Error("Webhook request failed: " + redactUrls(e && e.message));
  }
  // redirect:"manual" surfaces a 3xx as a response rather than following it, so
  // this is where a redirect becomes a visible failure instead of the token
  // being replayed to wherever Location points.
  if (r.status >= 300 && r.status < 400) {
    throw new Error("Webhook returned a redirect (HTTP " + r.status + ") — redirects are not followed");
  }
  if (!r.ok) {
    let body = "";
    try { body = redactUrls((await r.text()) || "").slice(0, 160); } catch { /* body is a bonus */ }
    throw new Error("Webhook HTTP " + r.status + (body ? ": " + body : ""));
  }
}

module.exports = {
  sendWebhook, parseWebhookUrl, redactUrls, snapshotFilename,
  buildDiscordPayload, buildJsonPayload,
  _internal: { WEBHOOK_TIMEOUT_MS, EVENT_COLORS }
};
