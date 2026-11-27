// tools/refactor/harness/fake-moonraker.js — a minimal Moonraker stand-in
// for the contract harness. Runs INSIDE the isolated container only, on a
// loopback address (127.0.0.x). Answers exactly the endpoints SnapCon's
// klipper-moonraker probe and Health read; state is set by the harness
// through /__control/*, and every request is logged for side-effect checks.
// Node built-ins only.
"use strict";
const http = require("http");

function createFakePrinter(initial = {}) {
  const state = {
    objects: {
      webhooks: { state: "ready", state_message: "Printer is ready" },
      print_stats: { state: "standby", filename: "", message: "", print_duration: 0, filament_used: 0, info: {} },
      display_status: { progress: 0 }, virtual_sdcard: { progress: 0 },
      toolhead: { extruder: "extruder" }, gcode_move: { speed_factor: 1 },
      exclude_object: { objects: [], excluded_objects: [], current_object: null },
      extruder: { temperature: 25, target: 0, power: 0 },
      heater_bed: { temperature: 25, target: 0, power: 0 },
      fan: { speed: 0, rpm: null },
      mcu: { last_stats: { bytes_retransmit: 0, bytes_invalid: 0, bytes_write: 1000, srtt: 0.001, rttvar: 0.0005, freq: 72000000, mcu_task_avg: 0.00001, mcu_task_stddev: 0.000005 } },
      exception_manager: { exceptions: [] },
    },
    roots: ["gcodes", "logs"],
    files: { gcodes: [{ filename: "a.gcode", size: 1000 }, { filename: "b.gcode", size: 2000 }, { filename: "c.gcode", size: 3000 }], logs: [{ filename: "klippy.log", size: 500 }] },
    diskUsage: { total: 32e9, used: 4e9, free: 28e9 },
    procStats: { throttled_state: null, cpu_temp: 45.5, system_cpu_usage: { cpu: 12.5 }, system_uptime: 86400, system_memory: { total: 1000000, available: 600000, used: 400000 } },
    historyTotals: { total_jobs: 10, total_print_time: 36000, total_filament_used: 12345 },
    jobs: [{ filename: "a.gcode", status: "completed", end_time: 0, start_time: 0 }],
    ...initial,
  };
  const log = [];
  const send = (res, code, body) => { const b = JSON.stringify(body); res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) }); res.end(b); };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/__control/")) {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        const j = body ? JSON.parse(body) : {};
        if (u.pathname === "/__control/set") {
          for (const [k, v] of Object.entries(j.objects || {})) state.objects[k] = { ...(state.objects[k] || {}), ...v };
          for (const k of ["roots", "files", "diskUsage", "procStats", "historyTotals", "jobs", "systemInfo"]) if (j[k] !== undefined) state[k] = j[k];
          return send(res, 200, { ok: true });
        }
        if (u.pathname === "/__control/remove-object") { delete state.objects[j.name]; return send(res, 200, { ok: true }); }
        if (u.pathname === "/__control/log") return send(res, 200, log);
        return send(res, 404, { error: "no such control" });
      });
      return;
    }
    log.push(req.method + " " + u.pathname + (u.search ? "?" + [...u.searchParams.keys()].sort().join("&") : ""));
    const p = u.pathname;
    if (p === "/printer/objects/list") return send(res, 200, { result: { objects: Object.keys(state.objects) } });
    if (p === "/printer/objects/query") {
      const status = {};
      for (const name of u.searchParams.keys()) if (state.objects[name]) status[name] = state.objects[name];
      return send(res, 200, { result: { eventtime: 1000.5, status } });
    }
    if (p === "/server/files/roots") return send(res, 200, { result: state.roots.map(name => ({ name, path: "/home/pi/" + name, permissions: "rw" })) });
    if (p === "/server/files/directory") {
      const root = (u.searchParams.get("path") || "").split("/")[0];
      if (!state.roots.includes(root)) return send(res, 404, { error: { code: 404, message: "no such root" } });
      return send(res, 200, { result: { dirs: [], files: (state.files[root] || []).map(f => ({ ...f, modified: 1700000000, permissions: "rw" })), disk_usage: state.diskUsage, root_info: { name: root, permissions: "rw" } } });
    }
    if (p === "/machine/proc_stats") return send(res, 200, { result: state.procStats });
    // Off by default (404, as before): answered only after a step sets
    // `systemInfo` through /__control/set; setting it to null turns it off again.
    if (p === "/machine/system_info" && state.systemInfo) return send(res, 200, { result: { system_info: state.systemInfo } });
    if (p === "/server/history/totals") return send(res, 200, { result: { job_totals: state.historyTotals } });
    if (p === "/server/history/list") return send(res, 200, { result: { count: state.jobs.length, jobs: state.jobs } });
    return send(res, 404, { error: { code: 404, message: "Not Found" } });
  });
  return { server, state, log };
}

module.exports = { createFakePrinter };
