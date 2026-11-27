// test/connectors/websocket-url.test.js — the Moonraker WebSocket address the
// U1 connectors open (http.websocketUrl): same host and port as the printer's
// HTTP address. A real U1 stores no port and must keep its exact address; a
// printer on another port (the Virtual U1) must keep that port, which the
// address used to drop.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("../../connectors/http-utils");

test("a real U1's address is unchanged: no port, port 80 left out", () => {
  assert.equal(http.websocketUrl({ url: "http://192.168.40.203" }), "ws://192.168.40.203/websocket");
  assert.equal(http.websocketUrl({ url: "http://192.168.40.203/" }), "ws://192.168.40.203/websocket");
  assert.equal(http.websocketUrl({ url: "http://192.168.40.203:80" }), "ws://192.168.40.203/websocket");
  assert.equal(http.websocketUrl({ url: "http://u1-yellow.local" }), "ws://u1-yellow.local/websocket");
});

test("a printer on another port keeps that port", () => {
  assert.equal(http.websocketUrl({ url: "http://127.0.0.1:7125" }), "ws://127.0.0.1:7125/websocket");
});

test("the token goes in the query, encoded", () => {
  assert.equal(http.websocketUrl({ url: "http://192.168.40.203", token: "a b&c" }), "ws://192.168.40.203/websocket?token=a%20b%26c");
  assert.equal(http.websocketUrl({ url: "http://192.168.40.203", token: "" }), "ws://192.168.40.203/websocket");
});

test("an unparseable url throws, so the caller's catch still runs", () => {
  assert.throws(() => http.websocketUrl({ url: "not a url" }));
});

test("every U1 WebSocket is opened through websocketUrl, none builds its own", () => {
  for (const f of ["snapmaker-u1-klipper.js", "snapmaker-u1-klipper-ws.js", "snapmaker-u1-firmware.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "../../connectors", f), "utf8");
    assert.doesNotMatch(src, /`ws:\/\//, `${f} builds a ws:// address itself`);
    assert.match(src, /websocketUrl\(/, f);
  }
});
