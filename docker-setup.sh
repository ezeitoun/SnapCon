#!/bin/sh
# docker-setup.sh — prepares this folder for `docker compose up` (run once;
# safe to run again, it never overwrites anything).
#
# Creates what docker-compose.yml bind-mounts, so Docker does not invent it:
# a missing FILE source (config.json, users.json) would otherwise be created
# by Docker as an empty DIRECTORY, and SnapCon could not save its settings.
set -e
cd "$(dirname "$0")"

for f in config.json users.json; do
  if [ -d "$f" ]; then
    if rmdir "$f" 2>/dev/null; then
      echo "removed the empty directory $f/ that an earlier 'docker compose up' created"
    else
      echo "error: $f is a directory with content — move it away and run this again" >&2
      exit 1
    fi
  fi
done

if [ ! -e config.json ]; then
  printf '{\n  "port": 4545,\n  "gcodeFolder": "./gcode",\n  "printers": []\n}\n' > config.json
  echo "created config.json (no printers yet — add them in the dashboard's Settings)"
fi
if [ ! -e users.json ]; then
  printf '{ "users": [] }\n' > users.json
  echo "created users.json"
fi
if [ ! -e .env ] && [ -e .env.example ]; then
  cp .env.example .env
  echo "created .env from .env.example (time zone, ffmpeg, port)"
fi
mkdir -p gcode remote-access-data audit-data sync-data data locales

echo
if [ "$(uname -s)" = "Linux" ]; then
  echo "Ready. Start SnapCon with:"
  echo "  docker compose up -d --build"
  echo "then open http://<this-computer's-IP>:4545"
else
  echo "Ready. On Docker Desktop start SnapCon with:"
  echo "  docker compose -f docker-compose.yml -f docker-compose.desktop.yml up -d --build"
  echo "then open http://localhost:4545"
fi
