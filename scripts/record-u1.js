#!/usr/bin/env node
// scripts/record-u1.js — record what a real Snapmaker U1 does over time, to
// check the virtual U1's transitions (fixtures/virtual-u1/model.js) against it.
//
//   node scripts/record-u1.js <printer-ip> <out.jsonl> [--minutes N] [--stop-after-finish M]
//
// READ-ONLY: it opens one Moonraker WebSocket, subscribes to status, and
// writes down everything the printer pushes. It never sends G-code or any
// command — the same subscription SnapCon itself holds on every U1.
//
// Output is JSON Lines, one record per line:
//   {"t": <ms since start>, "at": <ISO time>, "kind": "baseline"|"delta"|"gcode"|"klippy"|"connection", ...}
// "delta" records are exactly Moonraker's notify_status_update payloads.
// The file holds the job's real file and object names: keep it local, or
// clean it before it goes anywhere public.
const fs = require("fs");

// The objects whose changes are transitions. Temperature-only objects are
// included because head handover (standby, preheat, pause at 40°C) is part of
// what is being checked.
const OBJECTS = {
  webhooks: null, print_stats: null, virtual_sdcard: null, display_status: null,
  pause_resume: null, idle_timeout: ["state"], machine_state_manager: null,
  toolhead: ["extruder", "homed_axes"], gcode_move: ["homing_origin", "speed_factor"],
  heater_bed: ["temperature", "target"],
  extruder: null, extruder1: null, extruder2: null, extruder3: null,
  fan: ["speed"], "fan_generic e1_fan": ["speed"], "fan_generic e2_fan": ["speed"], "fan_generic e3_fan": ["speed"],
  print_task_config: null,
  "filament_feed left": null, "filament_feed right": null,
  "filament_motion_sensor e0_filament": null, "filament_motion_sensor e1_filament": null,
  "filament_motion_sensor e2_filament": null, "filament_motion_sensor e3_filament": null,
  exclude_object: ["current_object", "excluded_objects"], exception_manager: null
};
// Fields that change several times a second and carry nothing about a
// transition; dropped so a multi-hour recording stays small.
const NOISE = new Set(["power", "printing_e_pos", "motion_queue", "file_position", "estimated_print_time", "print_time"]);

function args() {
  const a = process.argv.slice(2);
  const opt = (name, def) => { const i = a.indexOf(name); return i >= 0 ? Number(a[i + 1]) : def; };
  const pos = a.filter((x, i) => !x.startsWith("--") && !(i > 0 && a[i - 1].startsWith("--")));
  return { host: pos[0], out: pos[1], minutes: opt("--minutes", 240), stopAfterFinish: opt("--stop-after-finish", 10) };
}

function main() {
  const { host, out, minutes, stopAfterFinish } = args();
  if (!host || !out) {
    console.error("Usage: node scripts/record-u1.js <printer-ip> <out.jsonl> [--minutes N] [--stop-after-finish M]");
    process.exit(2);
  }
  if (typeof WebSocket === "undefined") { console.error("Needs Node 22+ (global WebSocket)."); process.exit(2); }

  const file = fs.createWriteStream(out, { flags: "a" });
  const t0 = Date.now();
  const write = rec => file.write(JSON.stringify({ t: Date.now() - t0, at: new Date().toISOString(), ...rec }) + "\n");
  const counts = { delta: 0, gcode: 0, klippy: 0, reconnects: 0 };
  let ws = null, stopping = false, lastState = null, finishTimer = null, rpcId = 1;

  const stop = reason => {
    if (stopping) return;
    stopping = true;
    write({ kind: "connection", event: "stop", reason });
    console.log(`Stopped (${reason}): ${counts.delta} status updates, ${counts.gcode} console lines, ${counts.reconnects} reconnects → ${out}`);
    try { ws && ws.close(); } catch {}
    file.end(() => process.exit(0));
  };
  setTimeout(() => stop(`${minutes} minutes elapsed`), minutes * 60 * 1000);
  process.on("SIGINT", () => stop("interrupted"));
  process.on("SIGTERM", () => stop("terminated"));

  const strip = delta => {
    for (const obj of Object.values(delta)) if (obj && typeof obj === "object") for (const k of Object.keys(obj)) if (NOISE.has(k)) delete obj[k];
    for (const k of Object.keys(delta)) if (delta[k] && typeof delta[k] === "object" && !Object.keys(delta[k]).length) delete delta[k];
    return delta;
  };

  const noteState = state => {
    if (!state || state === lastState) return;
    console.log(`${new Date().toISOString()}  print_stats.state: ${lastState || "?"} → ${state}`);
    const wasRunning = ["printing", "paused"].includes(lastState);
    lastState = state;
    // A job that finished while recording (not one already finished when the
    // recording began): keep recording a little longer for the end sequence.
    if (wasRunning && ["complete", "cancelled", "error"].includes(state) && !finishTimer && stopAfterFinish >= 0) {
      finishTimer = setTimeout(() => stop(`job ${state}, recorded ${stopAfterFinish} more minutes`), stopAfterFinish * 60 * 1000);
    }
  };

  const connect = () => {
    if (stopping) return;
    ws = new WebSocket(`ws://${host}/websocket`);
    ws.onopen = () => {
      write({ kind: "connection", event: "open" });
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "printer.objects.subscribe", params: { objects: OBJECTS }, id: rpcId++ }));
    };
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.result && msg.result.status) {
        write({ kind: "baseline", status: msg.result.status });
        noteState((msg.result.status.print_stats || {}).state);
        console.log(`Subscribed to ${host}: ${Object.keys(msg.result.status).length} objects`);
        return;
      }
      if (msg.error) { write({ kind: "connection", event: "rpc-error", error: msg.error }); return; }
      if (msg.method === "notify_status_update") {
        const delta = strip(msg.params[0] || {});
        if (!Object.keys(delta).length) return;
        counts.delta++;
        write({ kind: "delta", eventtime: msg.params[1], delta });
        noteState((delta.print_stats || {}).state);
      } else if (msg.method === "notify_gcode_response") {
        counts.gcode++;
        write({ kind: "gcode", line: msg.params[0] });
      } else if (/^notify_klippy_/.test(msg.method)) {
        counts.klippy++;
        write({ kind: "klippy", event: msg.method });
        console.log(`${new Date().toISOString()}  ${msg.method}`);
        if (msg.method === "notify_klippy_ready") ws.send(JSON.stringify({ jsonrpc: "2.0", method: "printer.objects.subscribe", params: { objects: OBJECTS }, id: rpcId++ }));
      }
    };
    ws.onclose = () => {
      if (stopping) return;
      write({ kind: "connection", event: "closed" });
      counts.reconnects++;
      setTimeout(connect, 5000);
    };
    ws.onerror = () => {};
  };
  connect();
}

main();
