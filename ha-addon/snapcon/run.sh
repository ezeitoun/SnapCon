#!/bin/sh
# SnapCon add-on entrypoint. Every writable file (config.json, users.json,
# languages, audit trail, Remote Access identity) lives in /data, which the
# Supervisor keeps across updates and includes in Home Assistant backups.
set -e

export SNAPCON_DATA_DIR=/data
mkdir -p /data

# First start: a config whose G-code folder is on /share, so a slicer (or the
# Samba add-on) can drop files there. Afterwards SnapCon's Settings own it.
if [ ! -s /data/config.json ]; then
  GCODE=/share/snapcon/gcode
  if ! mkdir -p "$GCODE" 2>/dev/null; then GCODE=/data/gcode; fi
  printf '{\n  "port": 4545,\n  "gcodeFolder": "%s",\n  "printers": []\n}\n' "$GCODE" > /data/config.json
  echo "[snapcon] first start: created /data/config.json (G-code folder: $GCODE)"
fi

cd /app
exec node server.js
