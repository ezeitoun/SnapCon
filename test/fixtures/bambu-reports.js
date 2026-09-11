// test/fixtures/bambu-reports.js — Bambu Lab `push_status` report bodies for
// the connector tests. Hand-written, but every field and its encoding follows
// real H2D / H2S captures (the ones published with ha-bambulab's pybambu mock
// data): packed temperatures, hex bitfields, string-typed numbers, extruder
// `snow` slot references and the vir_slot external holders are all exactly as
// the printer sends them. Values are invented; shapes are not.
//
// Each builder returns a fresh object so a test can mutate it freely.

const tray = (id, type, color, extra = {}) => ({
  id: String(id), tray_type: type, tray_color: color, tray_sub_brands: type ? type + " Basic" : "",
  tray_uuid: type ? "5998E373899342BE9FC6BFA51103AB78" : "00000000000000000000000000000000",
  remain: 80, state: type ? 11 : 0, cols: [color || "00000000"], ...extra
});
const emptyTray = (id) => ({ id: String(id), state: 0 });

// H2D, dual nozzle, printing from the RIGHT nozzle out of AMS B slot 4, two
// AMS 2 Pro units (A bound to the left nozzle, B to the right), both external
// holders empty.
function h2dPrinting() {
  return {
    gcode_state: "RUNNING", mc_percent: 37, mc_remaining_time: 95, layer_num: 41, total_layer_num: 180,
    gcode_file: "/data/Metadata/plate_1.gcode", subtask_name: "Bracket v4", task_id: "815",
    print_error: 0, hms: [], stg_cur: 0, print_type: "local",
    bed_temper: 65.0, bed_target_temper: 65.0, nozzle_temper: 220.0, nozzle_target_temper: 220.0,
    spd_lvl: 2, spd_mag: 100, cooling_fan_speed: "12",
    stat: "16382181F0", fun: "1AFFF9CFF", cfg: "3C5FDAD9",
    device: {
      // state 0x02: two extruders, active extruder (bits 4-7) = 0 = right/main
      extruder: {
        state: 2,
        info: [
          // right: 0x00DC00DC = 220 -> 220; snow 0x0103 = AMS 1 (B), slot 3
          { id: 0, temp: 14418140, snow: 259, spre: 259, star: 259, info: 79, hnow: 0 },
          // left: 0x00000030 = 48 °C, no target; snow 0xFEFF = nothing loaded
          { id: 1, temp: 48, snow: 65279, spre: 65279, star: 65279, info: 8, hnow: 1 }
        ]
      },
      // 0x00410041 = 65 -> 65
      bed: { info: { temp: 4259905 }, state: 2 },
      ctc: { info: { temp: 34 }, state: 0 },
      nozzle: { exist: 3, info: [{ id: 0, diameter: 0.4, type: "HS01" }, { id: 1, diameter: 0.4, type: "HS01" }] }
    },
    ams: {
      ams_exist_bits: "3", tray_exist_bits: "fb", tray_now: "7",
      ams: [
        { id: "0", info: "2103", humidity: "4", temp: "26.1", tray: [tray(0, "PLA", "FFFFFFFF"), tray(1, "PLA", "000000FF"), emptyTray(2), tray(3, "PETG", "2850E0FF")] },
        { id: "1", info: "2003", humidity: "5", temp: "27.4", tray: [tray(0, "PLA", "FF6A13FF"), tray(1, "PLA", "7C4B00FF"), tray(2, "ABS", "D3B7A7FF"), tray(3, "PETG", "ADB1B2FF")] }
      ]
    },
    vir_slot: [
      { id: "254", tray_type: "", tray_color: "00000000", cols: ["00000000"] },
      { id: "255", tray_type: "", tray_color: "00000000", cols: ["00000000"] }
    ]
  };
}

// H2S, single nozzle, one AMS with one spool, printing from it.
function h2sPrinting() {
  return {
    gcode_state: "RUNNING", mc_percent: 42, mc_remaining_time: 78, layer_num: 24, total_layer_num: 75,
    gcode_file: "/data/Metadata/plate_1.gcode", subtask_name: "Cable guide", print_error: 0, hms: [],
    bed_temper: 105.0, bed_target_temper: 105.0, nozzle_temper: 275.0, nozzle_target_temper: 275.0,
    spd_mag: 100, cooling_fan_speed: "2",
    device: {
      extruder: { state: 1, info: [{ id: 0, temp: 18022675, snow: 0, spre: 0, star: 0, info: 78 }] },
      bed: { info: { temp: 6881385 }, state: 2 },
      ctc: { info: { temp: 3932220 }, state: 2 }
    },
    ams: {
      ams_exist_bits: "1", tray_exist_bits: "1", tray_now: "0",
      ams: [{ id: "0", info: "1003", humidity: "5", temp: "30.2", tray: [tray(0, "ABS", "FFFFFFFF"), emptyTray(1), emptyTray(2), emptyTray(3)] }]
    },
    vir_slot: [{ id: "255", tray_type: "", tray_color: "00000000" }]
  };
}

// A single-nozzle printer on older firmware: no `device` object at all, the
// legacy temperature fields, tray_now for the active slot, vt_tray as the
// external holder — what an X1/P1 sends. The connector should degrade to it.
function legacySingleNozzle() {
  return {
    gcode_state: "PAUSE", mc_percent: 63, mc_remaining_time: 12, layer_num: 90, total_layer_num: 140,
    gcode_file: "/sdcard/widget.gcode.3mf", subtask_name: "", print_error: 0x07008011, hms: [],
    bed_temper: 59.6, bed_target_temper: 60, nozzle_temper: 219.4, nozzle_target_temper: 220,
    spd_mag: 124, cooling_fan_speed: "15",
    ams: {
      ams_exist_bits: "1", tray_exist_bits: "5", tray_now: "2",
      ams: [{ id: "0", tray: [tray(0, "PLA", "C12E1FFF"), emptyTray(1), tray(2, "PLA-CF", "161616FF"), emptyTray(3)] }]
    },
    vt_tray: { id: "255", tray_type: "TPU", tray_color: "9B9EA0FF" }
  };
}

module.exports = { h2dPrinting, h2sPrinting, legacySingleNozzle };
