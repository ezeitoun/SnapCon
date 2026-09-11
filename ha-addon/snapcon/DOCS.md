# SnapCon — Home Assistant add-on

SnapCon is a fleet dashboard for Snapmaker U1 and Bambu Lab H2 (H2D, H2D Pro,
H2S, H2C) 3D printers: live status, temperatures, cameras, job previews,
queue, notifications. This add-on runs it on your Home Assistant host.

## Install

**From GitHub (recommended)**

1. Settings → Add-ons → Add-on Store → ⋮ (top right) → **Repositories**.
2. Add `https://github.com/jschallmayer78/SnapCon` and close the dialog.
3. Find **SnapCon** in the store → **Install** (the first build takes a few
   minutes: the image is built on your Home Assistant host).
4. **Start**, then **Open Web UI** — or open `http://<home-assistant-ip>:4545`.

**As a local add-on** (to try a branch that is not on `main` yet)

1. On a computer with the SnapCon checkout: `./ha-addon/prepare-local-addon.sh`
2. Copy the folder `ha-addon/snapcon` to `/addons/snapcon` on Home Assistant
   (Samba share **addons**, or `scp -r` via the SSH add-on).
3. Add-on Store → ⋮ → **Check for updates** → **Local add-ons** → SnapCon → Install.

## Using it

- Add printers in SnapCon's **Settings** (Discover on network works: the
  add-on uses the host network). Bambu Lab printers need IP, serial number
  and the LAN access code; the camera needs "LAN Only Liveview" on the
  printer, the job preview needs "Store sent files on external storage".
- **G-code folder**: `/share/snapcon/gcode`, reachable as
  `share/snapcon/gcode` over the Samba add-on — point your slicer's output
  there.
- **Port**: 4545. Because of host networking the port is not changed in the
  add-on's Network section but in SnapCon's Settings (then restart the add-on).
- **Time zone**: taken from Home Assistant automatically.
- **Camera snapshots** from Bambu Lab printers use ffmpeg, which is included.

## Data and backups

Everything SnapCon stores — printers, settings, users, languages, audit trail,
queue, Remote Access identity — lives in the add-on's private `/data`, which
survives updates and is part of Home Assistant backups. G-code files on
`/share` are backed up with the Share folder.

## Notes

- The dashboard opens in its own tab (no sidebar/ingress panel): SnapCon's
  pages use absolute paths that Home Assistant's ingress proxy would break.
- **Restart App** in SnapCon's Settings stops the process; turn on the
  add-on's **Watchdog** switch so the Supervisor starts it again.
- Updating: when installed from GitHub, the image contains SnapCon as it was
  on `main` when it was built — use **Rebuild** in the add-on to pick up newer
  commits.
