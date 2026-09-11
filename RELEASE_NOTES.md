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

0.7.0

### Printer Health
A new Health page gives one printer a full check-up: toolheads, the link to the controller board,
heaters, fans, storage, system load, service history and recent faults, all on one screen. The
fleet is scanned for printers that need attention, so a problem surfaces without opening each
machine in turn.

Reading a printer's health is deliberately on demand rather than polled - it asks the printer real
questions and there is no reason to do that every few seconds - with an auto-refresh you can turn
on while you are watching a particular machine.

### Logs, Camera and G-code Sync
SnapCon can copy files off your printers into a folder you choose: Klipper logs, camera captures
and the G-code files stored on the machine. Each root is configured separately with its own
retention, and old files are cleaned up on a schedule.

It keeps a record of what it has already fetched, so re-running a sync transfers only what is new
rather than everything again. Progress appears inline on the Storage card, and two syncs of the
same printer and folder cannot overlap.

### Light and Dark Themes
SnapCon now has a light theme alongside the original dark one, with a sun/moon button in the top
bar. Every status colour was re-derived for the light palette and contrast-checked rather than
simply inverted.

On first run it follows your operating system's setting and keeps following it until you make an
explicit choice. The chosen theme is applied before the stylesheet loads, so there is no flash of
the wrong colours on a refresh, and it is stored against your user account so it travels between
browsers.

### FlashForge Printers Running ZMOD or Forge-X
A FlashForge printer runs either its stock firmware, which serves FlashForge's own API, or a
community modification such as ZMOD or Forge-X, which replaces it with Moonraker. SnapCon now
detects which one a printer is actually speaking and routes every operation accordingly.

This is detected rather than configured, and re-checked - the same printer was observed serving
one transport and then the other within a single session, so a mode that has gone stale is noticed
instead of being trusted forever. Capabilities follow the transport too: a modded printer offers
what Moonraker genuinely supports, and a stock one offers what the native API supports, rather
than either being assumed from the model name.

### The Snapmaker U1 Connector
U1 printers now use the WebSocket connector by default. It follows the printer's status over a
live connection instead of polling, notices when that connection has gone stale, and falls back to
the original HTTP behaviour whenever the WebSocket is unhealthy.

Existing printers are switched over automatically at startup. Only the connector changes - ids,
addresses, tokens, serial numbers, queue pool assignments and group access are all preserved, and
the new connector passes every control action straight through to the original, so the worst case
for a migrated printer is exactly the behaviour it had before. The old connector remains available
in the picker as "SnapMaker U1 (Old)".
### Creality Printers Are Now Properly Supported
Creality's newer machines run Klipper, so SnapCon could always *connect* to one — but Creality layer
their own print-start macros, filament system and camera on top, and until those are handled a
Creality looks connected while quietly getting things wrong. That work is done.

**What you get:** correct status, progress and temperatures — including during the start macros,
where cards used to read "Idle" mid-job — plus full print control, cancelling individual objects
mid-print, the Health page, log/camera/G-code sync, network discovery, firmware versions, and a link
to the printer's own web interface.

**With a CFS fitted**, prints now track from start to finish. They used to lose track of themselves
moments after starting: elapsed and remaining stuck at zero, the card falling back to idle while the
machine was clearly running, and the printer's own history recording every SnapCon-started job as
cancelled after zero seconds — which also meant Queue Management could not follow these printers at
all. The cause was ordering: the printer reloads material as part of starting, and doing that after
the job had begun reset it. SnapCon now prepares the machine first — homing, loading the chosen lane,
setting the Z reference — exactly as the printer's own touchscreen does. You can map which lane feeds
which colour from SnapCon, and starting with an empty extruder works instead of failing seconds in
with a runout error.

**Bed levelling is left to the printer, deliberately.** SnapCon no longer runs a levelling pass before
a Creality print and no longer offers the option. Levelling was never broken — the problem was when
SnapCon ran it. These machines re-home the Z axis during their own start routine, discarding the
measurement just taken, so turning auto-level on made first layers worse rather than better. Left
alone the printer sets its own reference, measured at 0.017mm on a test machine. An older saved
configuration with auto-level switched on is ignored rather than quietly acted on. Snapmaker U1
printers are unaffected and keep their own auto-level, which works differently.

**Camera:** machines whose camera is reachable only over WebRTC, such as the SPARKX i7, now show a
live feed and can take snapshots. Local network only, and those printers cannot attach a camera image
to notifications.

**Tested on** a SPARKX i7 with a CFS Nano and two Ender-3 V3 Plus units, including real prints —
several were deliberately sacrificed to get the CFS start sequence right. The rest of the Klipper
range (K1, K1C, K1 SE, K1 Max, K2, Hi, Ender-3 V3 KE) speaks the same protocol and should work; we
would like to hear from you if you run one. Older Creality machines that do not run Klipper are not
supported — there is no API to talk to.

Two known limits: the printer's touchscreen still does not show a SnapCon-started print while it is
running, though it does show when one finishes; and Creality does not report loaded filament
per-toolhead, so spool colours are not shown on the card the way they are for a Snapmaker U1.

### Multi-Language Support (English + Spanish)
SnapCon's interface can now be used in English or Spanish, with the whole app — Fleet, Health,
Maintenance, Settings, Queue Management, and the login screen itself — fully translated.
- **Pick your language before you even log in.** The login screen has its own language selector, so
  you don't need an account to read it in your language.
- **Each user can set their own language**, independent of what everyone else on the account sees —
  from the topbar's language picker or Settings → View. Admins can also set the site-wide default for
  anyone who hasn't chosen one yet.
- **Bundled languages are plain JSON files** (`locales-default/en.json`, `locales-default/es.json`),
  with English always the authoritative source. A live copy is kept in a `locales/` folder next to
  wherever SnapCon is running (alongside `config.json`), so an update to SnapCon never silently
  overwrites a language file you've customized.
- **Falls back to English automatically** wherever a translation is missing, blank, or doesn't match —
  you'll never see a broken or half-translated screen.
- **A built-in Language Editor** (Settings → View → Edit languages, admin-only) lets you add a new
  language, edit any existing translation key-by-key, see translation completeness at a glance, and
  import or export a language as a JSON file — so a translation can be prepared externally and dropped
  in without editing anything by hand.
- Snapmaker's own printer error-code catalog (titles, descriptions, help links) is deliberately left
  exactly as Snapmaker wrote it — those are reference material, not SnapCon's own UI text.

### Live Camera for WebRTC-Only Printers
Some printers — confirmed on a Creality SPARKX i7 — only offer their camera as a live WebRTC stream,
with no still-image URL for SnapCon to fetch. Those cameras now work in Camera View: the picture is
streamed straight from the printer to your browser, and the Snapshot button grabs the current frame.
- **Detected automatically** when you save the printer, and only when no ordinary snapshot camera is
  found — printers with a normal camera keep working exactly as before, unchanged.
- **Local network only in this version.** A WebRTC camera can't be reached when SnapCon is opened
  remotely over Remote Access, so the tile says "Camera available on local network only" rather than
  retrying in the background.
- **Not included in notification images.** A snapshot for ntfy/Telegram is taken by the server, and
  a WebRTC camera can only be read by a browser, so notifications for those printers still arrive —
  just without a picture attached. Every other camera is unaffected.
- **Snapshots work from List View too.** Taking a snapshot of a WebRTC camera from the fleet list
  is no longer interrupted by the regular fleet refresh, so the picture comes through instead of
  timing out on "Live view is still connecting".
- Streams are only opened for camera tiles you can actually see, and are closed as soon as they
  scroll away, you leave Camera View, or the tab goes into the background — so a large farm doesn't
  hold dozens of video connections open.
### Printers Are Now Set Up by IP and Port
A printer's address used to be one URL field you had to type in full. It is now the two things you
actually know about the machine: its **IP / Hostname**, and — only where it matters — its **Port**.
- **Each printer type asks for what it needs.** Snapmaker U1 and FlashForge use a fixed port, so
  there is no port box to fill in. Klipper/Moonraker printers (including Creality) show a Port box
  that starts at 7125, which you can change for a printer behind a proxy or on a custom setup. The
  Simulator asks for no address at all.
- **Your existing printers move over by themselves.** SnapCon splits every saved address the first
  time it starts after the update. Nothing about how a printer is reached changes, and every
  printer keeps its identity — its maintenance history, group access, queue and pool assignment all
  stay attached.
- **Paste a full URL if that's what you have.** Type or paste `http://192.168.1.50:7125` into the
  IP / Hostname box and SnapCon splits it into the right boxes for you.
- **Saving tells you when an address is missing** instead of quietly dropping the printer from the
  list, which is what used to happen with an empty address field.

### A More Responsive Interface
SnapCon's interface gives clearer, more immediate feedback during everyday use.
- **Buttons respond the moment you press them.** Printer controls that wait on the machine to
  answer — Pause, Cancel, E-Stop — previously gave no sign your click had landed until the printer
  replied.
- **Better on touchscreens.** Tapping a control on a tablet no longer leaves it stuck looking
  "hovered" until you tap somewhere else.
- **Menus and dialogs open with a small amount of motion** that shows where they came from. Closing
  is still immediate — nothing was slowed down to make room for it.
- **Settings labels are easier to read**, in ordinary sentence case rather than all capitals.
- **Reduce Motion is respected.** If your system asks for less motion, the movement is dropped and
  the feedback you actually need is kept.

### Faster, Steadier Fleet Updates
Printer cards now update their live readings in place, instead of being rebuilt from scratch every
time progress, elapsed time or a temperature changes. That makes the fleet steadier to watch and
considerably lighter on a large farm.
- **Camera feeds stay connected while a printer prints.** A live WebRTC video session (confirmed on
  the Creality SPARKX i7) was being dropped and reconnected on every routine fleet refresh.
- **Status messages stay on screen.** A message like "Pausing…" is no longer wiped away by the next
  refresh.
- **Keyboard focus stays where you put it** during routine refreshes, instead of being lost every
  few seconds.
- **Progress, elapsed time, remaining time and temperatures update in place**, and the progress
  bar's shimmer now runs continuously instead of restarting on every refresh.
- **Temperature bars ease between readings** as the values change.
- **Large fleets ask far less of the browser.** With 100 actively printing test printers, the work
  each refresh costs dropped by roughly 8x.
### Update Snapmaker U1 Firmware Over the Network
Settings → Firmware can flash Snapmaker U1 printers from a firmware file on your own machine — no
USB stick, no Snapmaker cloud account. Point SnapCon at a **Firmware folder** in Settings →
General, pick a file, select the printers, and hold the button to confirm.

- **Several printers, one at a time.** Selected printers queue and run in sequence. Each update
  moves around a quarter of a gigabyte to the printer and reads it back to check it arrived, and
  doing that to several machines at once would saturate the same network the printers rely on.
- **The confirmation names what will happen** — every printer, the file and the version — rather
  than asking whether you are sure, and says up front that each machine goes offline for several
  minutes and must not lose power.
- **You can see which stage each printer is in** — waiting, transferring with a byte count,
  checking, writing, or restarting — because those stages take very different amounts of time and
  only one of them is safe to walk away from.
- **The file is checked before anything is written.** SnapCon reads the uploaded copy back off the
  printer and compares it against the original; if they differ, nothing is flashed.
- **The printer going quiet at the end is normal.** It drops offline to write the image and returns
  a few minutes later on the new version — SnapCon says so rather than reporting an error.
- **Stop applies between printers.** A machine already writing its image is never interrupted,
  because a half-written image is what leaves a printer unbootable.
- **Printers already on the chosen build are skipped** rather than re-flashed, and printers that
  cannot be updated right now — printing, faulted, offline — are listed with the reason and a Retry
  instead of quietly dropping out of the batch.
- **A print will not be started on a printer being updated**, and an update will not begin on a
  printer that is printing.
- **Admin only**, and the file must come from your configured firmware folder. A U1 accepts firmware
  from anything on the same network with no password at all, so SnapCon deliberately does not offer
  a way to point this at an arbitrary file or a web address.
- Snapmaker U1 only. Other printers do not expose a comparable network update interface, so they are
  not offered as targets.
- Downloading firmware from Snapmaker still needs their cloud, so SnapCon does not do it — you
  supply the file.

About the file-name check: if the file is named for a different product than the printer reports
itself to be, SnapCon stops before uploading. This is a check on the NAME, and it is not proof of
compatibility — a firmware image does not state which model it belongs to, so an image that is named
correctly but is not the right firmware will pass unnoticed. It catches a naming mistake. Confirm
you have the right file for your printer.

### A Crashed Printer No Longer Looks Idle
Klipper can shut itself down - a failed command, a lost connection to a control board, a
thermal fault - and when it does it stops printing but keeps reporting whatever the job was
last doing. SnapCon read that at face value, so a machine that had crashed mid-print showed as
**Idle**, or carried on showing a progress bar for a print that had already stopped.
- **The fleet now shows Error, with the printer's own explanation.** Klipper says what actually
  failed and how to recover it, and that text is shown on the card instead of a generic message.
  The progress bar, thumbnail and filament lanes are hidden, because none of them are true any
  more. The file name is kept - it is useful for working out what was lost.
- **The print queue will not send work to a faulted printer.** Previously a queued job could be
  dispatched to a machine that was never going to print it, and the queue would then wait
  indefinitely for a print that had already died. It now flags the job for your attention
  instead. As part of this, printers in a state SnapCon cannot positively identify as free are
  no longer treated as available - if in doubt, it waits rather than starting a job.
- **Firmware updates are blocked while a printer reports an error**, with a message that points
  at clearing the fault rather than at stopping a print.
- **Snapmaker U1 status stays honest if its live connection goes stale.** U1s receive status
  over a persistent connection; if Klipper shuts down or disconnects underneath it, SnapCon now
  stops trusting the cached values and re-checks the printer directly rather than continuing to
  display the last thing it heard.

This covers Snapmaker U1, Creality and generic Klipper/Moonraker printers.

### Printing a File Already on the Printer No Longer Freezes the Button
Starting a file that is already stored on a printer used to hold the browser until the printer had
finished everything it does before a print - on a Creality machine that includes a full bed-levelling
pass, which can run for several minutes. The button sat on "Starting print..." throughout, and on
slower machines it could give up with a timeout for a print that had in fact started perfectly well.
- **The button now reports what the printer is actually doing** - mapping filament, then starting -
  instead of freezing on one message.
- **A failure that happens after the print was requested is now shown to you.** Previously, once the
  request timed out, whatever happened next was invisible.
- **Success is only reported when the print has really started**, not when the request was accepted.
- Behaviour that has not changed: the print itself, what gets sent to the printer, the queue, and
  uploading a new file (which already worked this way).

*For anyone automating SnapCon:* `POST /api/printfile` now returns immediately with a `jobId` and
the meaning of the response has changed from "the print started" to "the request was accepted".
Poll `GET /api/print-status?job=<jobId>` for the outcome. Scripts that relied on the old
synchronous success or error response need updating.

### Discord Notifications, and Webhooks for Everything Else
SnapCon can now post to Discord. Print started, paused, failed, finished, or hit a progress
milestone — it arrives in your channel as a tidy embed, colour-coded by event, with the camera
snapshot attached. Paste a webhook URL from your Discord channel settings and that is it.

There is also a generic JSON mode for anything that is not Discord — n8n, Home Assistant, Node-RED,
or a script of your own — posting the printer, event, message, progress and filename.

It sits alongside the existing ntfy and Telegram options and fires on the same events, so nothing
needs configuring twice.

A Discord webhook URL is effectively a password for that channel, so SnapCon stores it the way it
stores your Telegram bot token — it never comes back to the browser — and strips it out of error
messages and logs so it cannot leak into a log file if your endpoint returns something unexpected.
Requests do not follow redirects, for the same reason. Local addresses are allowed on purpose, so
pointing this at a Home Assistant box on your own network works.

### E-Stop No Longer Claims Success on FlashForge
On FlashForge printers running stock firmware, E-Stop reported that it had worked while the printer
carried on printing. The firmware accepts the stop command, answers "ok", and does nothing — so
SnapCon believed it. Confirmed three separate ways on a real 5M Pro.

The button is now shown disabled on those printers, with an explanation, rather than offering an
emergency stop that does not stop anything. **Cancel still works normally** and remains the way to
stop a print. Printers running ZMOD or Forge-X keep a real emergency stop, because Klipper provides
one.

This also fixed something less visible: SnapCon tries the other connection type if the first fails,
and a false success meant that fallback was never reached — so a modded printer that had been
misidentified had its emergency stop silently swallowed.

### Smaller Fixes
- **A FlashForge camera that is switched off now says so**, instead of reporting a connection error
  that reads like the printer has fallen off the network.
- **FlashForge fan speed was under-reported by 2.55x** — a fan running at 100% displayed as 39%.
- **Creality printers with a CFS can have filament lanes mapped** from SnapCon, and a multi-colour
  file whose metadata carries no palette no longer leaves the colour picker empty.
- **Eject is offered whenever a printer is holding a job**, including a file SnapCon staged but has
  not printed yet — previously that could not be cleared at all.
- **Searching the fleet for a colour no longer hides the printer named after it.** Searching "blue"
  returned every printer with blue filament except the one called U1 Blue.
- **Cards show what SnapCon is doing** while it uploads a file and runs pre-print macros, instead of
  reading Idle for what can be minutes on a Creality.
- **Print starts are logged phase by phase**, so a print that stalls can be told apart after the
  fact — was it the upload, the head mapping, or the start itself.

### Security Fixes
Five issues found during a review of SnapCon's own code. All are fixed in this release, and
upgrading is recommended for anyone running SnapCon where more than one person can reach it.

- **Printer group access was not enforced everywhere.** Group restrictions were applied across most
  of the app but missing on thirteen routes, so a user limited to certain printers could still see
  or act on printers outside their groups - including switching maintenance mode fleet-wide. Every
  route now applies the same check.
- **A damaged config file could be overwritten instead of preserved.** If `config.json` could not be
  read or parsed, SnapCon fell back to empty defaults and then saved those defaults back over the
  original within the first moments of startup, destroying every printer, user and credential with
  no message. A genuine first run is now told apart from a failure; a failure is reported loudly and
  the original file is set aside untouched rather than replaced.
- **The gcode folder boundary could be sidestepped.** The check that keeps file operations inside
  your gcode folder compared text rather than path segments, so a neighbouring folder whose name
  merely started with the same characters was treated as inside it. Containment is now checked
  properly.
- **The slicer-integration endpoint now requires a credential.** The local file-path branch of the
  print-trigger endpoint identified callers only by them appearing to be local. That stopped being a
  meaningful distinction once Remote Access was available, because tunnelled traffic arrives looking
  local. It now requires a credential the server generates once and the command-line tool reads.
- **Printer commands can no longer hang forever.** The shared path behind E-Stop, pause, resume,
  cancel, eject and bed temperature had no timeout, so a printer that accepted a connection and then
  stopped responding could leave the most safety-critical action waiting indefinitely. Commands now
  fail in reasonable time, with deliberately longer allowances for the few operations that really do
  take minutes.

Unreleased

### Bambu Lab H2 series, monitoring only
Bambu Lab H2D, H2D Pro, H2S and H2C printers can now be added alongside the rest of the farm with
the new **Bambu Lab H2D / H2S / H2C (monitoring only)** connector - IP address, serial number and
the printer's 8-character LAN access code are all it needs. Status, progress, the printer's own
remaining-time estimate, layers, bed and active-nozzle temperatures and every AMS, AMS HT and
external-spool slot appear on the card and in the list view, and notifications work as for any
other printer. LAN Only Mode and Developer Mode do not need to be enabled.

SnapCon never commands these printers. The card and list view show a *Monitoring only* note where
the controls would be, and the server refuses print, pause/resume/cancel, E-Stop, bed-temperature,
Printer Pool and queue requests for them. The connection is verified against Bambu Lab's own
certificate authority and the printer's serial number before the access code is sent.

- **Live camera.** With *LAN Only Liveview* switched on at the printer, the card gets a camera
  button, Camera View shows the printer live and the camera window plays it live. SnapCon relays the
  printer's RTSPS stream as fragmented MP4 that the browser decodes itself - no plugin, and it works
  on a plain http:// LAN address. One camera session per printer, only while someone watches.
  Notification pictures additionally need ffmpeg on the SnapCon host.
- **Job preview.** The plate image is read from the job's .3mf on the printer (FTPS, ranged reads of
  just the image). On H2 firmware this needs *Store sent files on external storage* with a USB drive
  or SD card in the printer.
- **Printer-reported remaining time.** A connector can now report the printer's own countdown,
  which the card, list view and queue view prefer over estimating it from elapsed time and progress.
- **Named filament lanes.** A connector can label its slots the way the printer does (A1, HT1,
  Ext-L) instead of T1..Tn.

