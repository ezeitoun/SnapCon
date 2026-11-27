// fixtures/virtual-u1 — a virtual Snapmaker U1 for tests: a fake Moonraker
// (HTTP + WebSocket) in front of a four-head printer model built from real
// captures.
//
//   model.js     the printer: heads, head mapping, print states, faults; no I/O
//   server.js    Moonraker's HTTP API and WebSocket JSON-RPC in front of it
//   slicedFile.js  what a sent file says about itself (temperatures, tools,
//                layers, time, objects), from its start and end only
//   shape.js     field/type comparison between captures and the simulator
//   captures/    cleaned recordings of real U1s, one folder per firmware
//                version, made by scripts/capture-u1.js
//
// Tests: test/connectors/virtual-u1*.test.js. After a firmware update, capture
// an idle and a printing U1 with the script, then run the drift test.
// scripts/record-u1.js records a real U1's transitions over time (read-only),
// which is where model.js's timings come from.
const { startVirtualU1, Server } = require("./server");
const { VirtualU1, GcodeError, availableFirmware } = require("./model");

module.exports = { startVirtualU1, Server, VirtualU1, GcodeError, availableFirmware };
