// test/fixtures/bambu-p2s-report.js — CAPTURED from a real Bambu Lab P2S
// (firmware 01.02.00.00, AMS 2 Pro), 2026-09-15, by bambu-probe.js. Not
// hand-written: this is what the printer actually publishes, which is the whole
// point of having probed one before writing the connector (CLAUDE.md section 2).
//
// The probe redacts credential-shaped values at capture time; those markers
// have been replaced here with deterministic stand-ins of the same TYPE and
// LENGTH (tray_uuid, tag_uid, ip, wifi_signal, the *_id job fields). Every
// other value is verbatim from the printer.
//
// IDLE_REPORT is a full pushall answer from an idle printer that had finished a
// cloud job: note gcode_state FINISH with mc_percent still 100 and layer_num
// still 750 from that previous job — the stale values the connector must not
// show — and AMS tray 1 present-but-empty ({id, state} only).
//
// PRINT_EVENTS is the real command/state sequence from the verified print test:
// pushall baseline, project_file SUCCESS, RUNNING, a self-PAUSE on
// 0x0500803C (nozzle does not match the sliced file), then stop -> FAILED with
// 0x0300400C (task cancelled).
"use strict";

const IDLE_REPORT = {
  "3D": {
    "layer_num": 750,
    "print_cali_option": 78,
    "total_layer_num": 750,
    "ventobox": {
      "enable": false,
      "speed": 50,
      "visable": true
    }
  },
  "ams": {
    "ams": [
      {
        "dry_setting": {
          "dry_duration": -1,
          "dry_filament": "",
          "dry_temperature": -1
        },
        "dry_sf_reason": [],
        "dry_time": 0,
        "humidity": "2",
        "humidity_raw": "36",
        "id": "0",
        "info": "10002003",
        "temp": "24.2",
        "tray": [
          {
            "bed_temp": "0",
            "bed_temp_type": "0",
            "cali_idx": -1,
            "cols": [
              "545454FF"
            ],
            "ctype": 2,
            "drying_temp": "55",
            "drying_time": "8",
            "id": "0",
            "nozzle_temp_max": "230",
            "nozzle_temp_min": "190",
            "remain": 62,
            "state": 11,
            "tag_uid": "3A18F6D4B2907E5C",
            "total_len": 330000,
            "tray_color": "545454FF",
            "tray_diameter": "1.75",
            "tray_id_name": "A00-D03",
            "tray_info_idx": "GFA00",
            "tray_sub_brands": "PLA Basic",
            "tray_type": "PLA",
            "tray_uuid": "6D4B2907E5C3A18F6D4B2907E5C3A18F",
            "tray_weight": "1000",
            "xcam_info": "102710278403E8030000803F"
          },
          {
            "id": "1",
            "state": 26
          },
          {
            "bed_temp": "0",
            "bed_temp_type": "0",
            "cali_idx": -1,
            "cols": [
              "FFFFFFFF"
            ],
            "ctype": 2,
            "drying_temp": "65",
            "drying_time": "8",
            "id": "2",
            "nozzle_temp_max": "260",
            "nozzle_temp_min": "230",
            "remain": 15,
            "state": 11,
            "tag_uid": "907E5C3A18F6D4B2",
            "total_len": 330000,
            "tray_color": "FFFFFFFF",
            "tray_diameter": "1.75",
            "tray_id_name": "G00-W00",
            "tray_info_idx": "GFG00",
            "tray_sub_brands": "PETG Basic",
            "tray_type": "PETG",
            "tray_uuid": "C3A18F6D4B2907E5C3A18F6D4B2907E5",
            "tray_weight": "1000",
            "xcam_info": "000000000000000000000000"
          },
          {
            "bed_temp": "0",
            "bed_temp_type": "0",
            "cali_idx": -1,
            "cols": [
              "000000FF"
            ],
            "ctype": 2,
            "drying_temp": "65",
            "drying_time": "8",
            "id": "3",
            "nozzle_temp_max": "260",
            "nozzle_temp_min": "230",
            "remain": 84,
            "state": 11,
            "tag_uid": "F6D4B2907E5C3A18",
            "total_len": 330000,
            "tray_color": "000000FF",
            "tray_diameter": "1.75",
            "tray_id_name": "G00-K00",
            "tray_info_idx": "GFG00",
            "tray_sub_brands": "PETG Basic",
            "tray_type": "PETG",
            "tray_uuid": "2907E5C3A18F6D4B2907E5C3A18F6D4B",
            "tray_weight": "1000",
            "xcam_info": "000000000000000000000000"
          }
        ]
      }
    ],
    "ams_exist_bits": "1",
    "ams_exist_bits_raw": "1",
    "cali_id": 255,
    "cali_stat": 0,
    "cfs": [
      2,
      5,
      7
    ],
    "insert_flag": true,
    "power_on_flag": true,
    "tray_exist_bits": "d",
    "tray_hall_out_bits": "0",
    "tray_is_bbl_bits": "d",
    "tray_now": "255",
    "tray_pre": "255",
    "tray_read_done_bits": "d",
    "tray_reading_bits": "0",
    "tray_tar": "255",
    "unbind_ams_stat": 0,
    "version": 82159
  },
  "ams_rfid_status": 0,
  "ams_status": 0,
  "ap_err": 0,
  "aux": "A801004",
  "aux_part_fan": false,
  "batch_id": 0,
  "bed_target_temper": 0,
  "bed_temper": 16,
  "big_fan1_speed": "0",
  "big_fan2_speed": "0",
  "cali_version": 0,
  "canvas_id": 0,
  "care": [
    {
      "id": "ss",
      "info": "581858"
    },
    {
      "id": "ls",
      "info": "1A00"
    }
  ],
  "cfg": "4E1205FDA9B",
  "command": "push_status",
  "cooling_fan_speed": "0",
  "design_id": "0",
  "device": {
    "airduct": {
      "modeCur": 0,
      "modeFunc": 0,
      "modeList": [
        {
          "ctrl": [
            16,
            32,
            160,
            48
          ],
          "modeId": 0,
          "off": []
        },
        {
          "ctrl": [
            16,
            32,
            48
          ],
          "modeId": 1,
          "off": [
            160
          ]
        }
      ],
      "modeVisable": 7,
      "parts": [
        {
          "func": 0,
          "id": 16,
          "range": 6553600,
          "state": 0,
          "tar_state": 0
        },
        {
          "func": 6,
          "id": 32,
          "range": 6553600,
          "state": 0,
          "tar_state": 0
        },
        {
          "func": 5,
          "id": 160,
          "range": 6553600,
          "state": 0,
          "tar_state": 0
        },
        {
          "func": 2,
          "id": 48,
          "range": 6553600,
          "state": 0,
          "tar_state": 0
        }
      ],
      "subFunc": 0,
      "subMode": 0,
      "subVisable": 7,
      "version": 1
    },
    "bed": {
      "info": {
        "temp": 16
      },
      "state": 0
    },
    "bed_temp": 16,
    "cam": {
      "laser": {
        "cond": 253,
        "state": 0
      },
      "timelapse_path": "",
      "tl_external_free_kb": 2162176,
      "tl_external_total_kb": 15272064,
      "tl_internal_free_kb": 359277,
      "tl_internal_total_kb": 962560
    },
    "ctc": {
      "info": {
        "temp": 24
      },
      "state": 0
    },
    "ext_tool": {
      "calib": 2,
      "low_prec": true,
      "mount": 0,
      "mount_3d": 0,
      "th_temp": 0,
      "type": ""
    },
    "extruder": {
      "info": [
        {
          "filam_bak": [],
          "hnow": 0,
          "hpre": 0,
          "htar": 0,
          "id": 0,
          "info": 1032,
          "snow": 65535,
          "spre": 65535,
          "star": 65535,
          "stat": 0,
          "temp": 21,
          "z_bias": 0
        }
      ],
      "state": 1
    },
    "fan": 0,
    "fourth_axis": {
      "connect_flag": 0,
      "theta_pitch": -1
    },
    "holder": null,
    "laser": {
      "power": 0
    },
    "nozzle": {
      "exist": 1,
      "info": [
        {
          "color_m": "00000000",
          "diameter": 0.4,
          "fila_id": "",
          "id": 0,
          "p_t": 0,
          "sn": "SN0",
          "stat": 0,
          "tm": 0,
          "type": "HH01",
          "wear": 0
        }
      ],
      "src_id": 0,
      "state": 0,
      "tar_id": 0
    },
    "plate": {
      "base": 4,
      "cali2d_id": "",
      "cur_id": "P0101",
      "mat": 1,
      "tar_id": ""
    },
    "toolhead": {
      "pos_reference": 0,
      "pos_x": 0.05394997075200081,
      "pos_y": 0.2707500159740448,
      "pos_z": 0.13801999390125275
    },
    "type": 1
  },
  "err": "0",
  "err2": {
    "err_code": "0",
    "img_id": ""
  },
  "fail_reason": "0",
  "fan_gear": 0,
  "file": "/data/Metadata/plate_1.gcode",
  "force_upgrade": false,
  "fun": "64039FD1B3FF9CB3",
  "fun2": "3973",
  "gcode_file": "/data/Metadata/plate_1.gcode",
  "gcode_file_prepare_percent": "100",
  "gcode_state": "FINISH",
  "heatbreak_fan_speed": "0",
  "hms": [
    {
      "attr": 83887616,
      "code": 131184,
      "ts_boot": 33429,
      "ts_unix": "20260708111841"
    },
    {
      "attr": 83952640,
      "code": 196610,
      "ts_boot": 5631336395,
      "ts_unix": "20260911171702"
    }
  ],
  "home_flag": -1066967664,
  "hw_switch_state": 2,
  "info": {
    "temp": 24
  },
  "ipcam": {
    "agora_service": "disable",
    "brtc_service": "enable",
    "bs_state": 0,
    "cap_pic_enable": "invalid",
    "ipcam_dev": "1",
    "ipcam_record": "enable",
    "laser_preview_res": 7,
    "liveview_preview": true,
    "mode_bits": 2,
    "resolution": "1080p",
    "rtsp_url": "rtsps://203.0.113.9:322/streaming/live/1",
    "timelapse": "disable",
    "tl_external_free_kb": 2162176,
    "tl_external_total_kb": 15272064,
    "tl_internal_free_kb": 359277,
    "tl_internal_total_kb": 962560,
    "tl_store_hpd_type": 2,
    "tl_store_path_type": 2,
    "tutk_server": "disable"
  },
  "job": {
    "cur_stage": {
      "idx": 0,
      "state": 0
    },
    "job_state": 8,
    "stage": [
      {
        "clock_in": false,
        "color": [
          ""
        ],
        "diameter": [
          0.4000000059604645
        ],
        "est_time": 0,
        "heigh": 0,
        "idx": 0,
        "platform": "",
        "print_then": false,
        "proc_list": [],
        "tool": [
          "HH01"
        ],
        "type": 2
      }
    ]
  },
  "job_attr": 1,
  "job_id": "JOBID00000",
  "lan_task_id": "L",
  "layer_num": 750,
  "lights_report": [
    {
      "mode": "on",
      "node": "chamber_light"
    },
    {
      "mode": "flashing",
      "node": "work_light"
    }
  ],
  "mapping": [
    65535,
    3
  ],
  "mc_action": 255,
  "mc_err": 0,
  "mc_percent": 100,
  "mc_print_error_code": "0",
  "mc_print_stage": "1",
  "mc_print_sub_stage": 0,
  "mc_remaining_time": 0,
  "mc_stage": 1,
  "model_id": "USd8b0ea0c847351",
  "msg": 0,
  "net": {
    "conf": 16,
    "info": [
      {
        "ip": 1111111111,
        "mask": 16711679
      },
      {
        "ip": 1,
        "mask": 0
      }
    ]
  },
  "nozzle_diameter": "0.4",
  "nozzle_target_temper": 0,
  "nozzle_temper": 21,
  "nozzle_type": "HH01",
  "online": {
    "ahb": true,
    "version": 25
  },
  "percent": 100,
  "plate_cnt": 1,
  "plate_id": 1,
  "plate_idx": 1,
  "prepare_per": 100,
  "print_error": 0,
  "print_gcode_action": 255,
  "print_real_action": 0,
  "print_type": "cloud",
  "profile_id": "PROFILEID",
  "project_id": "PROJECTID0",
  "queue": 0,
  "queue_est": 0,
  "queue_number": 0,
  "queue_sts": 0,
  "queue_total": 0,
  "remain_time": 0,
  "s_obj": [],
  "sdcard": true,
  "sequence_id": "2021",
  "spd_lvl": 2,
  "spd_mag": 100,
  "stat": "40258000",
  "state": 6,
  "stg": [
    2,
    13,
    11,
    4,
    8,
    14,
    3,
    54,
    1,
    51
  ],
  "stg_cd": 0,
  "stg_cur": -1,
  "subtask_id": "SUBTASKID0",
  "subtask_name": "Tremendous Snaget-Gaaris",
  "task_id": "TASKID0000",
  "total_layer_num": 750,
  "upgrade_state": {
    "ahb_new_version_number": "",
    "ams_new_version_number": "",
    "consistency_request": false,
    "dis_state": 0,
    "err_code": 0,
    "ext_new_version_number": "",
    "force_upgrade": false,
    "idx": 25,
    "idx2": 245611864,
    "lower_limit": "00.00.00.00",
    "message": "",
    "module": "",
    "new_version_state": 2,
    "ota_new_version_number": "",
    "progress": "0",
    "sequence_id": 0,
    "sn": "SN0000000000000",
    "status": "IDLE"
  },
  "upload": {
    "file_size": 0,
    "finish_size": 0,
    "message": "Good",
    "oss_url": "O",
    "progress": 0,
    "sequence_id": "0903",
    "speed": 0,
    "status": "idle",
    "task_id": "T",
    "time_remaining": 0,
    "trouble_id": ""
  },
  "ver": "20008",
  "vir_slot": [
    {
      "bed_temp": "0",
      "bed_temp_type": "0",
      "cali_idx": -1,
      "cols": [
        "00000000"
      ],
      "ctype": 2,
      "drying_temp": "0",
      "drying_time": "0",
      "id": "255",
      "nozzle_temp_max": "0",
      "nozzle_temp_min": "0",
      "remain": 0,
      "tag_uid": "5C3A18F6D4B2907E",
      "total_len": 330000,
      "tray_color": "00000000",
      "tray_diameter": "1.75",
      "tray_id_name": "",
      "tray_info_idx": "",
      "tray_sub_brands": "",
      "tray_type": "",
      "tray_uuid": "8F6D4B2907E5C3A18F6D4B2907E5C3A1",
      "tray_weight": "0",
      "xcam_info": "000000000000000000000000"
    }
  ],
  "wifi_signal": "WIFISI",
  "xcam": {
    "allow_skip_parts": false,
    "buildplate_marker_detector": true,
    "cfg": 8089015,
    "first_layer_inspector": true,
    "halt_print_sensitivity": "medium",
    "print_halt": true,
    "printing_monitor": true,
    "spaghetti_detector": true
  },
  "xcam_status": "0"
};

const PRINT_EVENTS = [
  {
    "ms": 1325,
    "phase": "before start",
    "section": "print",
    "command": "push_status",
    "sequence_id": "2021",
    "gcode_state": "FINISH",
    "mc_percent": 100,
    "mc_remaining_time": 0,
    "mc_print_stage": "1",
    "mc_print_sub_stage": 0,
    "stg_cur": -1,
    "print_error": 0,
    "mc_print_error_code": "0",
    "layer_num": 750,
    "total_layer_num": 750,
    "print_type": "cloud",
    "subtask_name": "Tremendous Snaget-Gaaris",
    "gcode_file": "/data/Metadata/plate_1.gcode",
    "hms": [
      {
        "attr": 83887616,
        "code": 131184,
        "ts_boot": 33429,
        "ts_unix": "20260708111841"
      },
      {
        "attr": 83952640,
        "code": 196610,
        "ts_boot": 5631336395,
        "ts_unix": "20260911171702"
      },
      {
        "attr": 83887360,
        "code": 65543,
        "ts_boot": 6009584926,
        "ts_unix": "20260916022110"
      }
    ]
  },
  {
    "ms": 4646,
    "phase": "after start",
    "section": "print",
    "command": "gcode_line",
    "result": "SUCCESS",
    "reason": "SUCCESS",
    "sequence_id": "3313"
  },
  {
    "ms": 4699,
    "phase": "after start",
    "section": "print",
    "command": "project_file",
    "result": "SUCCESS",
    "reason": "SUCCESS",
    "sequence_id": "20001",
    "subtask_name": "ams"
  },
  {
    "ms": 4699,
    "phase": "after start",
    "section": "print",
    "command": "gcode_line",
    "result": "SUCCESS",
    "reason": "SUCCESS",
    "sequence_id": "3314"
  },
  {
    "ms": 4746,
    "phase": "after start",
    "section": "system",
    "command": "ledctrl",
    "result": "success",
    "reason": "",
    "sequence_id": "2301"
  },
  {
    "ms": 4746,
    "phase": "after start",
    "section": "print",
    "command": "gcode_line",
    "result": "SUCCESS",
    "reason": "SUCCESS",
    "sequence_id": "3315"
  },
  {
    "ms": 4747,
    "phase": "after start",
    "section": "system",
    "command": "ledctrl",
    "result": "fail",
    "reason": "did not find the valid led: chamber_light2",
    "sequence_id": "2301"
  },
  {
    "ms": 4770,
    "phase": "after start",
    "section": "print",
    "command": "gcode_line",
    "result": "SUCCESS",
    "reason": "SUCCESS",
    "sequence_id": "3318"
  },
  {
    "ms": 4992,
    "phase": "after start",
    "section": "print",
    "command": "push_status",
    "sequence_id": "2021",
    "gcode_state": "FINISH",
    "mc_percent": 100,
    "mc_remaining_time": 0,
    "mc_print_stage": "1",
    "mc_print_sub_stage": 0,
    "stg_cur": -1,
    "print_error": 0,
    "mc_print_error_code": "0",
    "layer_num": 750,
    "total_layer_num": 750,
    "print_type": "cloud",
    "subtask_name": "ams",
    "gcode_file": "/data/Metadata/plate_1.gcode",
    "hms": [
      {
        "attr": 83887616,
        "code": 131184,
        "ts_boot": 33429,
        "ts_unix": "20260708111841"
      },
      {
        "attr": 83952640,
        "code": 196610,
        "ts_boot": 5631336395,
        "ts_unix": "20260911171702"
      }
    ]
  },
  {
    "ms": 4992,
    "phase": "after start",
    "section": "print",
    "command": "gcode_line",
    "result": "SUCCESS",
    "reason": "SUCCESS",
    "sequence_id": "3324"
  },
  {
    "ms": 7577,
    "phase": "after start",
    "section": "print",
    "command": "push_status",
    "sequence_id": "2021",
    "gcode_state": "RUNNING",
    "mc_percent": 0,
    "mc_remaining_time": 0,
    "mc_print_stage": "1",
    "mc_print_sub_stage": 0,
    "stg_cur": -1,
    "print_error": 0,
    "mc_print_error_code": "0",
    "layer_num": 750,
    "total_layer_num": 94,
    "print_type": "local",
    "subtask_name": "ams",
    "gcode_file": "/data/Metadata/plate_1.gcode",
    "hms": [
      {
        "attr": 83887616,
        "code": 131184,
        "ts_boot": 33429,
        "ts_unix": "20260708111841"
      },
      {
        "attr": 83952640,
        "code": 196610,
        "ts_boot": 5631336395,
        "ts_unix": "20260911171702"
      }
    ]
  },
  {
    "ms": 8759,
    "phase": "after start",
    "section": "print",
    "command": "push_status",
    "sequence_id": "2021",
    "gcode_state": "PAUSE",
    "mc_percent": 0,
    "mc_remaining_time": 0,
    "mc_print_stage": "3",
    "mc_print_sub_stage": 0,
    "stg_cur": -1,
    "print_error": 83918908,
    "mc_print_error_code": "0",
    "layer_num": 0,
    "total_layer_num": 94,
    "print_type": "local",
    "subtask_name": "ams",
    "gcode_file": "/data/Metadata/plate_1.gcode",
    "hms": [
      {
        "attr": 83887616,
        "code": 131184,
        "ts_boot": 33429,
        "ts_unix": "20260708111841"
      },
      {
        "attr": 83952640,
        "code": 196610,
        "ts_boot": 5631336395,
        "ts_unix": "20260911171702"
      }
    ]
  },
  {
    "ms": 24313,
    "phase": "after stop",
    "section": "print",
    "command": "stop",
    "result": "SUCCESS",
    "reason": "SUCCESS",
    "sequence_id": "20002"
  },
  {
    "ms": 24400,
    "phase": "after stop",
    "section": "print",
    "command": "gcode_line",
    "result": "SUCCESS",
    "reason": "SUCCESS",
    "sequence_id": "2023"
  },
  {
    "ms": 24887,
    "phase": "after stop",
    "section": "print",
    "command": "push_status",
    "sequence_id": "2021",
    "gcode_state": "FAILED",
    "mc_percent": 0,
    "mc_remaining_time": 0,
    "mc_print_stage": "3",
    "mc_print_sub_stage": 0,
    "stg_cur": -1,
    "print_error": 0,
    "mc_print_error_code": "0",
    "layer_num": 0,
    "total_layer_num": 94,
    "print_type": "local",
    "subtask_name": "ams",
    "gcode_file": "/data/Metadata/plate_1.gcode",
    "hms": [
      {
        "attr": 83887616,
        "code": 131184,
        "ts_boot": 33429,
        "ts_unix": "20260708111841"
      },
      {
        "attr": 83952640,
        "code": 196610,
        "ts_boot": 5631336395,
        "ts_unix": "20260911171702"
      }
    ]
  },
  {
    "ms": 25026,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "success",
    "reason": "",
    "sequence_id": "2301"
  },
  {
    "ms": 25026,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "fail",
    "reason": "did not find the valid led: chamber_light2",
    "sequence_id": "2301"
  },
  {
    "ms": 25150,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "success",
    "reason": "",
    "sequence_id": "2301"
  },
  {
    "ms": 25274,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "fail",
    "reason": "did not find the valid led: chamber_light2",
    "sequence_id": "2301"
  },
  {
    "ms": 25384,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "success",
    "reason": "",
    "sequence_id": "2301"
  },
  {
    "ms": 25384,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "fail",
    "reason": "did not find the valid led: chamber_light2",
    "sequence_id": "2301"
  },
  {
    "ms": 25551,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "success",
    "reason": "",
    "sequence_id": "2301"
  },
  {
    "ms": 25676,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "fail",
    "reason": "did not find the valid led: chamber_light2",
    "sequence_id": "2301"
  },
  {
    "ms": 25790,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "success",
    "reason": "",
    "sequence_id": "2301"
  },
  {
    "ms": 25790,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "fail",
    "reason": "did not find the valid led: chamber_light2",
    "sequence_id": "2301"
  },
  {
    "ms": 26000,
    "phase": "after stop",
    "section": "print",
    "command": "push_status",
    "sequence_id": "2021",
    "gcode_state": "FAILED",
    "mc_percent": 0,
    "mc_remaining_time": 0,
    "mc_print_stage": "1",
    "mc_print_sub_stage": 5,
    "stg_cur": -1,
    "print_error": 0,
    "mc_print_error_code": "0",
    "layer_num": 0,
    "total_layer_num": 94,
    "print_type": "local",
    "subtask_name": "ams",
    "gcode_file": "/data/Metadata/plate_1.gcode",
    "hms": [
      {
        "attr": 83887616,
        "code": 131184,
        "ts_boot": 33429,
        "ts_unix": "20260708111841"
      },
      {
        "attr": 83952640,
        "code": 196610,
        "ts_boot": 5631336395,
        "ts_unix": "20260911171702"
      }
    ]
  },
  {
    "ms": 26000,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "success",
    "reason": "",
    "sequence_id": "2301"
  },
  {
    "ms": 26000,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "fail",
    "reason": "did not find the valid led: chamber_light2",
    "sequence_id": "2301"
  },
  {
    "ms": 26153,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "success",
    "reason": "",
    "sequence_id": "2301"
  },
  {
    "ms": 26273,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "fail",
    "reason": "did not find the valid led: chamber_light2",
    "sequence_id": "2301"
  },
  {
    "ms": 26397,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "success",
    "reason": "",
    "sequence_id": "2301"
  },
  {
    "ms": 26397,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "fail",
    "reason": "did not find the valid led: chamber_light2",
    "sequence_id": "2301"
  },
  {
    "ms": 26560,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "success",
    "reason": "",
    "sequence_id": "2301"
  },
  {
    "ms": 26682,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "fail",
    "reason": "did not find the valid led: chamber_light2",
    "sequence_id": "2301"
  },
  {
    "ms": 26805,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "success",
    "reason": "",
    "sequence_id": "2301"
  },
  {
    "ms": 26805,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "fail",
    "reason": "did not find the valid led: chamber_light2",
    "sequence_id": "2301"
  },
  {
    "ms": 26965,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "success",
    "reason": "",
    "sequence_id": "2301"
  },
  {
    "ms": 27080,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "fail",
    "reason": "did not find the valid led: chamber_light2",
    "sequence_id": "2301"
  },
  {
    "ms": 27165,
    "phase": "after stop",
    "section": "print",
    "command": "push_status",
    "sequence_id": "2021",
    "gcode_state": "FAILED",
    "mc_percent": 0,
    "mc_remaining_time": 0,
    "mc_print_stage": "1",
    "mc_print_sub_stage": 5,
    "stg_cur": -1,
    "print_error": 0,
    "mc_print_error_code": "0",
    "layer_num": 0,
    "total_layer_num": 94,
    "print_type": "local",
    "subtask_name": "ams",
    "gcode_file": "/data/Metadata/plate_1.gcode",
    "hms": [
      {
        "attr": 83887616,
        "code": 131184,
        "ts_boot": 33429,
        "ts_unix": "20260708111841"
      },
      {
        "attr": 83952640,
        "code": 196610,
        "ts_boot": 5631336395,
        "ts_unix": "20260911171702"
      }
    ]
  },
  {
    "ms": 27165,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "success",
    "reason": "",
    "sequence_id": "2301"
  },
  {
    "ms": 27216,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "fail",
    "reason": "did not find the valid led: chamber_light2",
    "sequence_id": "2301"
  },
  {
    "ms": 27363,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "success",
    "reason": "",
    "sequence_id": "2301"
  },
  {
    "ms": 27486,
    "phase": "after stop",
    "section": "system",
    "command": "ledctrl",
    "result": "fail",
    "reason": "did not find the valid led: chamber_light2",
    "sequence_id": "2301"
  },
  {
    "ms": 28265,
    "phase": "after stop",
    "section": "print",
    "command": "gcode_line",
    "result": "SUCCESS",
    "reason": "SUCCESS",
    "sequence_id": "3482"
  },
  {
    "ms": 28371,
    "phase": "after stop",
    "section": "print",
    "command": "push_status",
    "sequence_id": "2021",
    "gcode_state": "FAILED",
    "mc_percent": 0,
    "mc_remaining_time": 0,
    "mc_print_stage": "1",
    "mc_print_sub_stage": 5,
    "stg_cur": -1,
    "print_error": 0,
    "mc_print_error_code": "0",
    "layer_num": 0,
    "total_layer_num": 94,
    "print_type": "local",
    "subtask_name": "ams",
    "gcode_file": "/data/Metadata/plate_1.gcode",
    "hms": [
      {
        "attr": 83887616,
        "code": 131184,
        "ts_boot": 33429,
        "ts_unix": "20260708111841"
      },
      {
        "attr": 83952640,
        "code": 196610,
        "ts_boot": 5631336395,
        "ts_unix": "20260911171702"
      }
    ]
  },
  {
    "ms": 29537,
    "phase": "after stop",
    "section": "print",
    "command": "push_status",
    "sequence_id": "2021",
    "gcode_state": "FAILED",
    "mc_percent": 0,
    "mc_remaining_time": 0,
    "mc_print_stage": "1",
    "mc_print_sub_stage": 0,
    "stg_cur": -1,
    "print_error": 50348044,
    "mc_print_error_code": "16396",
    "layer_num": 0,
    "total_layer_num": 94,
    "print_type": "local",
    "subtask_name": "ams",
    "gcode_file": "/data/Metadata/plate_1.gcode",
    "hms": [
      {
        "attr": 83887616,
        "code": 131184,
        "ts_boot": 33429,
        "ts_unix": "20260708111841"
      },
      {
        "attr": 83952640,
        "code": 196610,
        "ts_boot": 5631336395,
        "ts_unix": "20260911171702"
      },
      {
        "attr": 83887104,
        "code": 196695,
        "ts_boot": 6011612759,
        "ts_unix": "20260916025458"
      }
    ]
  }
];

module.exports = { IDLE_REPORT, PRINT_EVENTS };
