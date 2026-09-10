// test/webhookNotify.test.js — outbound webhook notifications (Discord + generic JSON).
//
// Extracted into its own module rather than living in server.js so the security
// rules below are unit-testable: server.js has no express/test harness in this
// project, and "the URL never reaches a log" is not something a source-text
// assertion can actually prove.
//
// The webhook URL is a CREDENTIAL — a Discord webhook URL embeds a token that
// grants posting rights to that channel. It gets the same treatment as
// telegramBotToken (never round-trips to the browser) and, additionally, must
// never appear in an error message or a log line, since unlike ntfy/Telegram
// the URL itself is the secret.
const test = require("node:test");
const assert = require("node:assert/strict");
const wh = require("../webhookNotify");

const DISCORD = "https://discord.com/api/webhooks/123456789/aVeryS3cretT0kenValue";

function withMockFetch(handler, fn) {
  const real = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = real; });
}
const okResponse = (status = 204, body = "") => ({
  ok: status >= 200 && status < 300, status, text: async () => body
});

// ---- URL validation ----

test("parseWebhookUrl accepts http and https, including private/LAN targets", () => {
  // A local n8n or Home Assistant endpoint is a legitimate target for a
  // local-first app — private ranges are deliberately NOT blocked.
  assert.equal(wh.parseWebhookUrl("http://192.168.1.50:5678/webhook/x").hostname, "192.168.1.50");
  assert.equal(wh.parseWebhookUrl("http://homeassistant.local:8123/api/webhook/y").protocol, "http:");
  assert.equal(wh.parseWebhookUrl(DISCORD).protocol, "https:");
});

test("parseWebhookUrl rejects any scheme that is not http or https", () => {
  for (const bad of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com",
                     "javascript:alert(1)", "data:text/plain,hi"]) {
    assert.throws(() => wh.parseWebhookUrl(bad), /http or https/i, bad + " must be rejected");
  }
});

test("parseWebhookUrl rejects URLs carrying embedded credentials", () => {
  assert.throws(() => wh.parseWebhookUrl("https://user:pass@example.com/hook"), /credential/i);
  assert.throws(() => wh.parseWebhookUrl("https://user@example.com/hook"), /credential/i);
});

test("parseWebhookUrl rejects junk, distinguishing 'nothing set' from 'not a URL'", () => {
  // An operator who left the field blank and one who typed something wrong need
  // different messages, so these are deliberately not the same error.
  for (const empty of ["", "   ", null, undefined]) {
    assert.throws(() => wh.parseWebhookUrl(empty), /not configured/i, JSON.stringify(empty));
  }
  for (const junk of ["not a url", "://missing-scheme", "http//no-colon"]) {
    assert.throws(() => wh.parseWebhookUrl(junk), /not a valid URL|http or https/i, junk);
  }
});

test("parseWebhookUrl error messages never echo the input back", () => {
  // These messages are shown to the user AND logged; echoing the input would
  // put a mistyped-but-still-secret URL straight into a log line.
  for (const bad of ["https://user:pass@example.com/hook", "file:///etc/passwd", "not a url"]) {
    try { wh.parseWebhookUrl(bad); assert.fail("should have thrown for " + bad); }
    catch (e) { assert.ok(!e.message.includes(bad), "input echoed back: " + e.message); }
  }
});

// ---- redaction ----

test("redactUrls strips anything URL-shaped, so a token cannot reach a log", () => {
  const msg = "connect ECONNREFUSED for " + DISCORD + " after 2 tries";
  const out = wh.redactUrls(msg);
  assert.ok(!out.includes("aVeryS3cretT0kenValue"), "token must not survive: " + out);
  assert.ok(!out.includes("discord.com"), "host must not survive either: " + out);
  assert.match(out, /\[redacted-url\]/);
  assert.ok(out.includes("ECONNREFUSED"), "the useful part of the message is kept");
});

test("redactUrls handles non-string and empty input without throwing", () => {
  assert.equal(wh.redactUrls(null), "");
  assert.equal(wh.redactUrls(undefined), "");
  assert.equal(wh.redactUrls(42), "42");
});

// ---- snapshot filename / content-type ----

test("snapshotFilename preserves the real image type, including FlashForge BMP", () => {
  assert.equal(wh.snapshotFilename({ contentType: "image/bmp" }), "snapshot.bmp");
  assert.equal(wh.snapshotFilename({ contentType: "image/png" }), "snapshot.png");
  assert.equal(wh.snapshotFilename({ contentType: "image/jpeg" }), "snapshot.jpg");
  assert.equal(wh.snapshotFilename({}), "snapshot.jpg", "unknown type falls back to jpg");
  assert.equal(wh.snapshotFilename(null), "snapshot.jpg");
});

// ---- payload shape ----

test("Discord payload is an embed carrying the printer name and message", () => {
  const p = wh.buildDiscordPayload({ printerName: "U1 Blue", message: "Print finished", event: "complete" });
  assert.equal(p.embeds.length, 1);
  assert.equal(p.embeds[0].title, "U1 Blue");
  assert.equal(p.embeds[0].description, "Print finished");
  assert.ok(typeof p.embeds[0].color === "number", "a colour makes the event scannable at a glance");
  assert.equal(p.embeds[0].image, undefined, "no attachment reference when there is no image");
});

test("Discord embed's attachment:// reference matches the multipart filename exactly", async () => {
  // A mismatch here renders as a broken image in Discord — the reference and the
  // uploaded part name have to agree, including for BMP.
  const image = { contentType: "image/bmp", buffer: Buffer.from([1, 2, 3]) };
  const p = wh.buildDiscordPayload({ printerName: "X", message: "m", event: "complete", image });
  assert.equal(p.embeds[0].image.url, "attachment://snapshot.bmp");

  let sent = null;
  await withMockFetch(async (url, opts) => { sent = opts; return okResponse(); },
    () => wh.sendWebhook({ url: DISCORD, format: "discord", printerName: "X", message: "m", event: "complete", image }));
  assert.ok(sent.body instanceof FormData, "an image makes it a multipart upload");
  const file = sent.body.get("files[0]");
  assert.equal(file.name, "snapshot.bmp", "the uploaded part name must match attachment://");
  assert.equal(file.type, "image/bmp", "and keep the real content type");
  const payload = JSON.parse(sent.body.get("payload_json"));
  assert.equal(payload.embeds[0].image.url, "attachment://" + file.name);
});

test("generic JSON payload carries SnapCon's own fields, not Discord's", () => {
  const p = wh.buildJsonPayload({
    printerName: "U1 Blue", message: "Print finished", event: "complete",
    st: { progress: 0.42, filename: "thing.gcode" }
  });
  assert.equal(p.printer, "U1 Blue");
  assert.equal(p.event, "complete");
  assert.equal(p.message, "Print finished");
  assert.equal(p.progress, 0.42);
  assert.equal(p.filename, "thing.gcode");
  assert.ok(p.ts, "a timestamp so a receiver can order events");
  assert.equal(p.embeds, undefined, "not Discord-shaped");
});

test("generic JSON payload tolerates a printer with no live stats", () => {
  const p = wh.buildJsonPayload({ printerName: "X", message: "m", event: "error" });
  assert.equal(p.progress, null);
  assert.equal(p.filename, null);
});

// ---- request behaviour ----

test("sendWebhook does not follow redirects", async () => {
  let opts = null;
  await assert.rejects(
    () => withMockFetch(async (u, o) => { opts = o; return okResponse(302); },
      () => wh.sendWebhook({ url: DISCORD, format: "discord", printerName: "X", message: "m", event: "complete" })),
    /redirect/i,
    "a 3xx must surface as an error rather than being chased to another host");
  assert.equal(opts.redirect, "manual", "redirect:manual is what stops fetch following it");
});

test("sendWebhook posts JSON with the right content type when there is no image", async () => {
  let opts = null;
  await withMockFetch(async (u, o) => { opts = o; return okResponse(); },
    () => wh.sendWebhook({ url: DISCORD, format: "discord", printerName: "X", message: "m", event: "complete" }));
  assert.equal(opts.method, "POST");
  assert.match(opts.headers["Content-Type"], /application\/json/);
  assert.equal(JSON.parse(opts.body).embeds[0].title, "X");
});

test("sendWebhook rejects a bad URL before making any request at all", async () => {
  let called = false;
  await assert.rejects(
    () => withMockFetch(async () => { called = true; return okResponse(); },
      () => wh.sendWebhook({ url: "file:///etc/passwd", format: "discord", printerName: "X", message: "m", event: "complete" })),
    /http or https/i);
  assert.equal(called, false, "validation must happen before the network call");
});

// ---- the security property that matters most ----

test("a transport failure never leaks the webhook URL or its token", async () => {
  await assert.rejects(
    () => withMockFetch(async () => { throw new Error("connect ECONNREFUSED " + DISCORD); },
      () => wh.sendWebhook({ url: DISCORD, format: "discord", printerName: "X", message: "m", event: "complete" })),
    (e) => {
      assert.ok(!e.message.includes("aVeryS3cretT0kenValue"), "token leaked: " + e.message);
      assert.ok(!e.message.includes("discord.com"), "host leaked: " + e.message);
      return true;
    });
});

test("an HTTP error response never leaks the URL either, even if the body echoes it", async () => {
  await assert.rejects(
    () => withMockFetch(async () => okResponse(401, "unauthorized for " + DISCORD),
      () => wh.sendWebhook({ url: DISCORD, format: "discord", printerName: "X", message: "m", event: "complete" })),
    (e) => {
      assert.ok(!e.message.includes("aVeryS3cretT0kenValue"), "token leaked from response body: " + e.message);
      assert.match(e.message, /401/, "but the status is still reported");
      return true;
    });
});

test("sendWebhook refuses when no URL is configured", async () => {
  await assert.rejects(() => wh.sendWebhook({ url: "", format: "discord", printerName: "X", message: "m", event: "complete" }),
    /not configured|valid URL|http or https/i);
});
