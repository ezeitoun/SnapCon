#!/bin/sh
# prepare-local-addon.sh — turns ha-addon/snapcon into a self-contained LOCAL
# Home Assistant add-on with this checkout's code (e.g. a branch that is not
# on GitHub's main yet), instead of the image cloning it from GitHub.
#
#   ./ha-addon/prepare-local-addon.sh
#   then copy the folder ha-addon/snapcon to Home Assistant's /addons/snapcon
#   (Samba share "addons", or scp to the SSH add-on) and install "SnapCon"
#   from Add-on Store → Local add-ons.
#
# Only files git tracks (or new, not-ignored ones) are copied — never your
# config.json, users.json, data folders or node_modules (all in .gitignore).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
APP="$HERE/snapcon/app"

command -v git >/dev/null || { echo "error: git is needed to know which files belong to SnapCon" >&2; exit 1; }
git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "error: $ROOT is not a git checkout" >&2; exit 1; }

rm -rf "$APP"
mkdir -p "$APP"
git -C "$ROOT" ls-files -z --cached --others --exclude-standard \
  | grep -zEv '^(test|docs|fixtures|ha-addon|\.github)/' \
  | (cd "$ROOT" && tar --null -T - -cf -) \
  | tar -C "$APP" -xf -

[ -f "$APP/server.js" ] || { echo "error: copying the app failed" >&2; exit 1; }
echo "prepared $APP ($(git -C "$ROOT" rev-parse --abbrev-ref HEAD) @ $(git -C "$ROOT" rev-parse --short HEAD))"
echo "next: copy $HERE/snapcon to /addons/snapcon on Home Assistant"
