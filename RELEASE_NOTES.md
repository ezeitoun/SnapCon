0.1.0
### User Management
A new option under General Settings lets you enable "Enable User Access Management."   
Once turned on, logging in becomes required to use SnapCon.

### Improved Printer Maintenance
Printer Maintenance has been improved.

### Experimental Orca "Plugin"
For those who prefer working with Orca Slicer instead of Snapmaker Orca (Snorca), an option was added to "connect" Orca to SnapCon.

0.2.0
### Telegram Notifications Support
### Improved Subnets Support
- The old bare x.x.x.0 format, unchanged.
- CIDR notation: 192.168.22.0/25 (hosts .0–.127),    192.168.22.128/25 (hosts .128–.255) — exactly your examples.
- A dotted subnet mask instead of a prefix length: 192.168.22.128/255.255.255.128.
- An unaligned IP anywhere in the block (e.g. 192.168.22.5/25) — normalizes to the containing block automatically rather than requiring you to type the exact boundary address.
- Also added a floor at /20 (max 4096 addresses) — a typo'd /8 or /16 would otherwise kick off a scan that takes forever; it returns a clear error instead.
### Improved File Manager
- **New Folder**, a "+ Folder" button opens a styled modal   
- **Search**, not just filter — the search box now does a recursive search from the gcode root down through every subfolder
- **Upload from your PC**, an "Upload" button opens a native file picker (multi-file)
- **Multi-select → drag-to-move**, select files Explorer/Finder-style (Shift+click (range-select from the last-clicked anchor) and Ctrl+click (toggle individual files))

### Connectors Architecture Introduced
Although SnapCon was developed primarly for SnapMaker (and will be kept like that), I have added connectors architecture to support other printers.
- First fully developed/connectors is for AD5X (Native, No need for any special firmware deployment)
- - Scanning a subnet will find the AD5X, But you wont be able to use the printer until the Serial Number (SNXXXX) will be configured alone with the Printer ID
- - you can switch filemanets colors on the interface, due to a limitation on the AD5X GUI, It will always be displayed as black in the GUI (but the configured colors will be used for the poop calculations)
- - If a print was canceled, you will need to "Eject" the file via the printer card (otherwise it will stay busy due to the GUI popup window)

### Camera View & List View
Two new fleet layouts alongside the original card grid, cycled from the same view-switch button in the
header:
- **Camera View** — a grid focused on every printer's live camera feed, with a configurable refresh
  interval and optional staggered refresh so a large fleet's cameras don't all fire at once
- **List View** — the whole fleet as a dense, sortable table: thumbnail, progress, remaining time, layer
  count, and a filament chip per loaded toolhead
- Both share one toolbar: status tabs, a tag filter, multi-select with bulk Pause/Resume/Cancel, and a
  tag editor

### Printer Tags
Tag your printers (e.g. "garage", "farm-2") and filter Camera/List View down to just that group.

### Heat Multiple Printers
A bulk bed-temp control: pick any number of online printers, set a target, and optionally stagger the
start of each one a few seconds apart so heating a whole farm's beds doesn't trip a shared circuit.

### Remote Access
Check on your prints from anywhere — no port forwarding, no VPN, no messing with your router.
One click in Settings, a quick one-time verification in your browser, and SnapCon gives your
print farm its own secure private link you can open from your phone, at work, wherever.
Fully opt-in, and reversible any time you want to turn it off.

### Fixes
- Compact-mode bug: the folder icon didn't open the file list at all while in compact view
- "Folder button appears out of the blue" in Settings 
Visual polish

Bug Fixes:
- When printer cards are reduced in size, file manager does not open. Only opens if cards are full size.
- 

0.4.1
### Remote Access & Settings Rework
Remote Access and the Settings screens got a UX pass — clearer status, fewer confusing states.

### Telegram OTP Login
Telegram is now a third one-time-password delivery option alongside email (Resend) and ntfy.sh, using
the same bot you already configured under Notifications.

0.4.6
### Creality Support Grew Up
What started as a thin connector is now a real integration for K1 / K1C / K1 Max / K1 SE / Hi, K2, and
the Ender-3 V3 series:
- **Camera auto-detection** — SnapCon asks the printer itself whether it has a camera and wires it up
  automatically, no manual URL entry
- **Real auto-leveling** — the Auto-Level option now actually runs the printer's own leveling routine
  before a print, the same as it does on U1
- **Thumbnails that actually show up** — Creality Print embeds its preview image differently than most
  slicers; SnapCon now finds and decodes it instead of showing a blank card
- **Layer progress** — estimated from the file's own layer count when the printer doesn't report it
  directly
- **Read-only Creality Filament System (CFS) status** — see which slot's loaded and what color/material
  it is, for printers with a CFS box attached

### Per-Print Options, Properly
Auto-Level, Flow Calibration, and Time-Lapse now have real per-printer defaults (Settings → Printers →
Behavior), and a new **Force default behavior** switch: leave it on for the one-click Print experience,
or turn it off to get a quick confirmation popup before every print where you can override any of the
three for just that job. On U1, turning on Flow Calibration in that popup also lets you pick which
toolhead(s) to calibrate — handy when only one filament was just swapped and the rest are already
dialed in.

### Printer Tags, Everywhere
Tags are now editable directly on each printer in Settings, not just from Camera/List View's bulk
editor. A tag shaped like `/red/`, `/255,80,80/`, or `/#ff5050/` also tints that printer's card
background with the color inside — a quick visual grouping on the fleet grid itself.

### Smarter About What's Ready to Print
Upload a file to an idle printer with nothing else queued, and SnapCon now marks it "Loaded" right on
the status badge and remembers it — even across a SnapCon restart — instead of just silently storing it.
Hitting Print then prints that file directly rather than re-uploading whatever's selected in the file
manager.

### Under the Hood
A security and reliability pass (upload/path validation, crash-safety fixes in Remote Access, safer
Docker packaging), plus build-process fixes so macOS binaries built on Windows actually launch.

0.5.0
### Queue Management
Printers can now be grouped into **Printer Pools** and given an ordered queue instead of printing one
file at a time by hand. Add files to a pool's queue, and SnapCon dispatches them one after another —
pausing for a manual bed-clear confirmation between prints where that's how the pool is set up, or
picking straight up with the next job otherwise. A new full-page **Print Farm** view (its own entry in
the header's view cycle) shows queue status per pool, a Fleet Status strip with color-coded, clickable
printer chips (release a stopped/paused queue or a hardware error straight from the chip), and every
printer's own queue with pause/resume/stop and a real **Clear Queue** abort action. An **Auto-balance**
toggle per pool spreads queued jobs onto whichever sibling printer goes idle first. A new **Simulator**
connector type ("Dummy" printers) lets you build and test queue behavior without risking a real print.

### Audit Trail
Settings → Logs now keeps a real, persistent audit log of who did what — logins, print actions, queue
events, config changes — independent of whatever printers currently exist in config, so removing a
printer doesn't erase its history. Filterable by date, category, and free-text search.

### Printer Groups & Access Control
Users can be scoped to specific printer groups instead of seeing the whole fleet, managed from
Settings → Users.


