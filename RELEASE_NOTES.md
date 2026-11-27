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

0.7.1

### Bambu Lab Support (Beta)
SnapCon now speaks to Bambu Lab printers directly over your network â€” no cloud account, no Bambu
Studio running in the background. Add one under Settings > Printers with its IP address, serial
number and access code, all three of which are on the printer's own screen under Settings > Network.

This is a **beta**. It was built and checked against one real printer, a P2S, and printing has not
yet been run end to end by anyone but us. Treat the first few prints as a test, and keep an eye on
the machine.

**What you get**

- **Live status** â€” state, progress, layer, nozzle and bed temperatures, and the printer's own error
  codes with an explanation for the ones SnapCon recognises.
- **The AMS on the card**, named the way the printer names it: A1 to A4, plus the external spool
  holder as Ext. An empty tray shows as an empty slot rather than a spool that isn't there. The
  external spool can be switched off per printer if you never load it.
- **Live camera**, in Camera View and from the card's camera button. SnapCon connects to the
  printer's camera itself and relays the picture to your browser, so it works without anything
  installed on your machine. Still images for notifications need ffmpeg on the SnapCon host; live
  video does not.
- **Printing** â€” send a sliced `.3mf` or a `.gcode` from your library, choose which AMS tray feeds
  each filament, and pause, resume or cancel. A multi-plate project asks which plate to print.
- **The printer's own files** â€” press Print with nothing selected to browse what is already on the
  machine and start it, with its colours read out of the file.
- **Job thumbnails**, read from the file the printer is actually running.

**Before it will print**

Bambu printers only accept commands from third-party software when **Developer Mode** is on
(Settings > Network on the printer, after LAN Only Mode). Without it SnapCon still shows everything
â€” status, AMS, camera â€” and says so on the card instead of failing on every button. Turn it on and
press **Check again**, and the controls come back.

**Checks before a print goes out**

SnapCon looks at the file and at what the printer has loaded, and says something before the machine
heats up:

- a `.3mf` that was never sliced cannot print, and Send is blocked
- a file sliced for a different Bambu model, or for a different nozzle, is flagged
- a filament with no tray of that material blocks the send, rather than starting a print that fails
  a few layers in
- trays are suggested by material first and colour second

**Not in this beta**

Queue Management and printer pools (a Bambu printer cannot be added to a pool yet), printing from
the external spool, more than one AMS unit, and printer discovery by scan. Time remaining and fan
speed are deliberately not shown: the printer reports values we have not been able to confirm the
meaning of, and a wrong number is worse than none.

### Also in this release

- **Printer access codes are now treated as secrets.** The access code used by FlashForge and Bambu
  Lab printers was sent to the browser and written back into the Settings field in clear text. It
  now behaves like the API token: SnapCon says only whether one is configured, and offers Replace
  and Clear. Existing codes keep working, and Test connection no longer needs you to retype one.
- **The Send dialog's Upload button fills as the transfer runs**, as the card's own Upload button
  always has. With several printers selected it shows the average across them.
- **Controls a printer cannot perform now say so.** A disabled E-Stop or Eject explains itself
  rather than failing when pressed, and a printer with no eject command of its own only offers the
  button when SnapCon is actually holding a file for it.
- **The file browser marks 3MF files**, and says when one has no sliced plate â€” the same extension
  covers a printable plate and a project that was never sliced.
- **A file cannot be sent to a printer that cannot print it.** SnapCon refuses before the upload
  rather than after it.


0.7.2

### Bambu Lab: time remaining and fan speed
Both were deliberately blank in 0.7.1 — the printer reports them, but SnapCon had no way to confirm
what the numbers meant, and a wrong countdown is worse than none.

- **Time remaining** now shows. The printer reports it in minutes, which is how Joel's
  print-farm-manager, the Bambu connector proposed in SnapCon PR #9 and the Home Assistant
  integration all read it — three implementations that arrived at it separately.
- **It checks itself on the first print.** Every sliced file carries the slicer's own estimate, so
  the first countdown of each job is compared against it. Minutes and seconds are a factor of sixty
  apart, and no estimate is ever that wrong: if they disagree by that much, SnapCon hides the
  remaining time for that printer and says so in the log rather than counting down a wrong number.
- **Fan speed** now shows as a percentage. Bambu reports fans on a 0-15 scale, which was established
  by watching one wind down step by step on a real printer.

Chamber temperature is still not shown. The printer reports two readings that might be it, and
neither has been confirmed.


2026.11.0

### New version numbers
SnapCon now numbers its releases by date (calendar versioning) instead of 0.x. This release was
going to be 0.8.0; it is **2026.11.0**, with everything that was planned for 0.8.0.

The three numbers are **year . month . fix**, with no leading zeros:
- **2026.11.0** — the release for November 2026.
- **2026.11.1**, **2026.11.2** — fixes to that release, nothing new.
- **2026.12.0** — the next monthly release; the last number starts again at 0.

The number tells you how recent your SnapCon is at a glance. It says nothing about how big a release
is. The update check added in this release (see "Update check" below) counts 2026.11.0 as newer than
any 0.x number. SnapCon 0.7.2 and earlier have no update check, so they do not announce this release.

### Remote Access: cloudflared updated to 2026.10.5 (security)
Remote Access now runs cloudflared **2026.10.5** instead of 2026.7.2. Versions before 2026.10.2
trust eight certificates that Cloudflare announced in October 2026 as compromised, which could let
someone impersonate a service the tunnel connects to.

There is nothing to do beyond updating SnapCon. The next time Remote Access starts, SnapCon
downloads the new cloudflared once and checks it against the checksums Cloudflare published before
running it. The remote link drops for a moment while the tunnel reconnects.

### Web-server libraries updated (security)
The downloads and installs from source now use Express 4.22.3 with current versions of the libraries it
builds on (`body-parser`, `proxy-addr`, `qs`). The versions used before had published security
advisories; these have none. A Docker image gets the current versions each time it is built, so
rebuild yours to pick them up.

### Every upload is checked on the printer before it prints
After a printer accepts a file, SnapCon now reads it back before starting it or showing it as Loaded:
- On Snapmaker U1, Creality, Klipper and FlashForge printers running Moonraker, it checks that the file
  is there under its exact name, with the same size, and that its beginning, middle and end match what
  was sent — a sample of the file, not every byte. The upload then reads **Verified on {printer} (size and
  sampled content)**. SnapCon also checks that the file on your computer did not change while it was being
  sent: if it did, the upload is **not confirmed** — "the file changed on this computer while it was being
  sent" — and if it cannot be checked again, it is not confirmed either; nothing is started or Loaded.
- On FlashForge's own firmware, which lists names only, and on Bambu Lab printers, which report a size,
  the upload reads **Sent — {printer} lists it**: the printer has it, but its content could not be compared.
- If the file is not on the printer, or its copy cannot be checked, the upload shows **Not confirmed**, in
  amber, and nothing is started. If the printer holds a different file under that name, the upload has
  **failed**, nothing is started, and the printer's file is left as it is.
- **Every file you send is uploaded.** "Skip uploading a file the printer already has" is gone: a
  printer's copy can only be sampled — Moonraker offers no checksum — so a matching sample could hide an
  edit elsewhere in the file and print the old one. Sending a file the printer already has now takes as
  long as any upload (about 2 MB/s on a Snapmaker U1; a 25 MB file, about 13 s). A
  `"skipIdenticalUploads"` left in `config.json` is ignored.
- **"Replace a file on the printer that has the same name"** (formerly "Overwrite a file on the printer
  when the content differs") is still on by default. Turned off, SnapCon now sends a file only when the
  printer is known *not* to have that name: if it has one — even an identical one, which SnapCon cannot
  prove — or SnapCon cannot tell (its file list cannot be read; a FlashForge on its own firmware lists only
  its ten newest files), the send is refused and nothing is sent. Before, a copy SnapCon could not
  compare was overwritten. With it off:
  - re-printing a file sent before is refused (printers keep what they printed) — delete the printer's
    copy, rename, or turn replacing on;
  - a queue holding several copies of one file prints the first, and the rest wait for you;
  - a FlashForge on its own firmware holding ten or more files refuses every send;
  - files from your slicer and files waiting for a busy printer follow the same rule: one whose name
    the printer has fails (nothing is sent); if the printer cannot say, it waits and SnapCon asks again
    a minute later.
  A same-named file in a printer subfolder no longer counts — uploads land in the top folder. On Bambu Lab
  printers, only a clear "no such file" answer counts as the file not being there; an answer SnapCon
  cannot read is treated as "can't tell".

The check takes a moment after the upload; the card says "Checking the printer's copy" meanwhile.
Bambu Lab: the check has been tested in software only; it has not yet been tried on a real printer.

### A Loaded file is checked on the printer before it prints
A file waiting on a printer ("Loaded") is now checked on that printer — at its exact name and the size
SnapCon sent — a minute after SnapCon starts, every 15 minutes after that, and when you press Print on
its card. The check reads the printer's file list; it does not read the file's content again.
- **No longer on the printer:** the Loaded badge goes, the card says so, and **Dismiss** clears it.
  Nothing is sent again by itself.
- **Changed:** a different file now has that name on the printer (another size). Print is refused, and
  the card says why.
- **Unable to verify:** the printer could not be asked (offline, or it did not answer). Print is refused
  until a check succeeds — **Check again** on the card asks once more. An offline printer is never
  reported as missing its file.
- Printing a file you pick from the printer's own file list is unaffected: it does not depend on the
  Loaded file of the same name.
- A Loaded file now stays with its printer when printers are reordered in Settings.

What the check can and cannot see:
- **It protects the card's Print of its Loaded file**, and nothing else. A file you print from the
  printer's own file list, or a print started on the printer or from another program, is not checked.
- **It compares the name and the size SnapCon sent**, not the content. A file replaced on the printer by
  one of exactly the same size is not noticed.
- **A printer that rewrites every upload** (Moonraker's "object processing", `enable_object_processing`,
  turned on) changes its copy by design, so SnapCon cannot use the size to tell whether the file was
  replaced. On such a printer the check confirms only that *a* file of that name exists there — not that
  it is the file SnapCon sent, and not that it is intact. It is off on the printers SnapCon has been
  tested on.

FlashForge printers on their own firmware list only their ten newest files; a Loaded file older than
those shows "Unable to verify" and can still be printed from the printer's file list. This check has been
tested in software, on a virtual printer, and on a Snapmaker U1: a Loaded file found present; one found
changed, and its Print refused; and one found missing, and its Print refused.

### Files waiting for a busy printer are kept, in order, and survive a restart
A file sent to a printer that is busy — Upload with "upload while printing" off, or a file pushed from
your slicer with SnapCon's command-line hook — now waits on disk until the printer is free:
- **Nothing is lost on a restart.** Each waiting file is saved before SnapCon answers that it is queued.
  Files pushed from a slicer are kept in SnapCon's `data/deferred-files` folder until they are sent.
- **First in, first out, per printer**, several at a time — each with its own **Cancel** and the time it
  started waiting. A second file of the same name for the same printer is refused instead of replacing the
  first.
- **One transfer per printer at a time.** While a printer is receiving a file, another upload to it says
  it is receiving another file and is refused; queued files and the print queue wait their turn.
- **The file sent is the file you chose.** If it changes or disappears while it waits, it is not sent. A
  file sent from the Library keeps its link to its Model while it waits, across a restart too.
  If its folder (a network share) does not answer for a while, the file keeps waiting — SnapCon asks
  again a minute later — and other files for that printer, and its print queue, go ahead meanwhile.
- **If SnapCon stops in the middle of sending,** it checks the printer afterwards. A file that arrived
  whole becomes Loaded; anything else waits for you — **Send again**, **Check again** or **Cancel**.
  SnapCon never resends, overwrites, deletes or prints anything by itself.
- A printer removed from Settings keeps its waiting files (admins see them above the fleet); they are
  sent only if a printer with the same ID comes back.
- **If SnapCon's list of waiting files is damaged,** it is restored from its backup, every file in it waits
  for you, and none of the kept files is deleted until an admin has looked and acknowledged. Files that no
  waiting send needs any more are moved aside, never deleted on their own; admins see how many there are
  above the fleet and can delete them there.

Limits for files pushed from a slicer: 512 MB each and 4 GB in total by default, and SnapCon keeps
256 MB of disk free. They can be changed in `config.json` under `"deferredSends"`
(`"maxFileMB"`, at most 2048; `"maxTotalMB"`; `"freeMarginMB"`). Downgrading to an earlier version
drops files still waiting. Tested in software, on a virtual printer, and on one Snapmaker U1: a file sent
during a short print waited, was delivered when the print ended, and checked out. Not yet on other printers,
or through a restart on a physical printer.

### The command-line hook can wait for the printer's answer
Until now the command-line hook (and the Orca integration built on it) exited as soon as SnapCon
**accepted** a file — which is not the same as the printer having it. Add `--wait` to have it follow the
transfer to its end:

    SnapCon --load "Part.gcode" --printer "U1 White" --wait [seconds]

- It prints SnapCon's first answer as before, then the final result on its own line (`SnapCon result:
  {…}`), with progress and one plain sentence on the error output — at most a line every 10 seconds.
- **Exit codes:** `0` delivered — *verified* (the printer's copy has the same size, and its start,
  middle and end match the file: a sampled check, not every byte) or *acknowledged* (checked by size or
  name only; the result says which); `1` failed, cancelled, or refused
  when sent; `3` still waiting or sending when the time ran out (default 300 s, at most 1800); `4` not
  known — the printer's copy could not be confirmed, or SnapCon no longer knows the transfer or did not
  answer by the end.
- If SnapCon restarts while it waits, it keeps asking and picks the transfer up again when SnapCon is back.
- **Without `--wait`, nothing changes**: same output, same exit codes.

Known limits of the hook in this release:
- **Sending to SnapCon on another computer (`--snapcon`)**, as the Orca integration does when Orca runs on
  a different machine: the hook reads the file and sends its bytes as they are on disk at that moment. The
  check that the file did not change while it was sent (see above) covers files SnapCon reads itself, not
  the copy on the slicer's computer. If another program changes the file while it is being sent, SnapCon
  does not notice; if it is shortened, the hook can wait without end. Orca finishes writing the file before
  it runs the hook and waits for it, so Orca itself does not do this.
- **SnapCon's first answer has no time limit.** If SnapCon takes the file and then stops answering, the
  hook waits — with or without `--wait` — until it is stopped. Stop it, then check the printer's card in
  SnapCon before sending again.
- **Orca and `--wait`:** leave `--wait` out of Orca's post-processing script by default. Without it, exit code
  `0` means SnapCon accepted the file, not that it was delivered. With it, Orca waits until the transfer ends or
  the time runs out, and exit code `3` means the transfer is still waiting or sending, not necessarily that it
  failed: Orca may report the export as failed while SnapCon keeps the transfer and delivers it later. Exit code
  `1` is different, and doesn't always mean the same thing. If SnapCon refused the send or couldn't be reached,
  such as with an unknown printer name, no transfer was created and nothing appears on a card. With `--wait`, it
  can also mean a transfer SnapCon had accepted then failed or was cancelled: the card says what happened, and a
  transfer cancelled late may already have reached the printer. In neither case does SnapCon send the file again
  by itself. Orca may report only that the script failed and its error code, not SnapCon's reason; to see the
  reason, run the command in a terminal. Before retrying, look at the printer's card in SnapCon, especially when
  sending the same file name; a second send of a name that is already waiting is refused.
- **Orca's Export G-code gives its output name as a full path** (`SLIC3R_PP_OUTPUT_NAME`). SnapCon refuses
  an `--outputname` containing a path (`Bad output name`), so a script passing that value straight through
  fails on Export. Pass only the file name: the README's Orca example now shows how.

Each transfer's outcome is kept for 24 hours (at most 1,000), across restarts, in `data/transfer-results.json`;
both can be changed in `config.json` under `"transferResults"` (`"retentionHours"`, 1–720; `"maxCount"`,
100–10,000). **Send again** on a card is a new transfer with its own ID, so a command waiting on the first
attempt gets that attempt's outcome, never a later one's. A file pushed with `--snapcon` to SnapCon on
another machine can be followed the same way only while logins are off there, as pushing itself. Tested in
software, against a virtual printer, and with Orca on Windows sending to a virtual printer (accepted, delivered,
timed out while busy, and refused); not yet with physical printers.

### "Upload" now always means upload
The Upload button used to do two different things depending on the printer, with nothing on screen
saying which. On an ordinary printer it staged a file. On a printer belonging to a **queue pool** the
same click created a **queue item**, which the queue engine would later upload *and start printing*.

Upload now always means upload. Scheduling a print is a separate, explicit choice.

- **Upload into queue** (Settings → Sending prints) — **off by default**. When off, uploading to a
  queue-managed printer simply puts the file there and leaves the queue alone. When on, the file is
  uploaded *and* added to that printer's queue so it prints in turn.
- **If you use Queue Management, read this one.** With the setting off — the default — an Upload
  click on a pooled printer no longer schedules a print. The file lands on the printer and nothing
  else happens. Turn **Upload into queue** on to get the old behaviour back.
- It applies **always**, not only when the printer happens to be mid-print. A setting that only
  sometimes does what its label says is the thing this replaces.
- **An upload changes nothing on the printer but its files.** Uploading, and a file delivered when a busy
  printer frees up, used to also send the printer's toolhead map and print options (auto-level, flow
  calibration, timelapse) if it had any, including during a print. These are now sent only when a print starts.
  A map you chose, and options you ticked, with the upload stay with the Loaded file and are used by its
  **Print** on the card; an option you left unticked follows the printer's default. They are not sent if you
  start the file from the printer's own screen or file list. If a saved map cannot be read, **Print** is refused
  and says so; upload the file again or eject it.

### Uploading to a printer that is already printing
- **Allow uploading while a printer is printing** (Settings → Sending prints) — **on by default**.
  Uploads used to be deferred until the printer was free; now they go straight through.
- **Starting a second print on a busy printer is refused**, whatever that setting says. That had no
  server-side guard at all before — only a disabled button.
- **A file can never be sent over the one being printed.** Moonraker replaces a same-named file in
  place while Klipper is streaming the running job out of it, so SnapCon refuses that outright on
  every path: the card, the printer-files dialog and the queue.

### Send to printers: only compatible printers are pre-ticked
Opening Send with a file sliced for one printer family used to tick every idle printer, other brands
included. Now a printer SnapCon knows is a mismatch is left unticked (and still marked, as before).
When the file's brand cannot be determined, every idle printer is pre-ticked exactly as before.

### Fixed: a queued upload from a subfolder failed as "file missing"
Uploading to a queue-managed printer added a queue item that remembered only the file's name, not
the folder it was in. When the queue came to print it, SnapCon looked for the file at the top of the
G-code folder, didn't find it, and failed the item as missing — for any file kept in a subfolder.
Queue items now keep the full location. Items added before this fix still carry only the name; if
one fails as missing, remove it and queue the file again.

### Send checks the printer model, not only the brand
Send used to compare brands only, so a file sliced for one Creality machine was offered to every
Creality printer. A file in a real library, kept under a `K1C` folder, turned out to be sliced for an
Ender-3 V3 Plus. SnapCon now reads which machine a file was sliced for and compares it with each
printer's own model.
- **Another model of the same brand** gets a warning on that printer's row ("Sliced for a Creality
  Ender-3 V3 Plus. This printer is a Creality SPARKX i7.") and is left unticked. Sending anyway still
  works after one confirmation. Nothing is refused.
- When a file only *probably* names its printer (its printer model is a generic "Generic Klipper
  Printer" and the machine comes from its profile name), the warning says "Probably", and the
  printer stays ticked.
- The job card names the model when it is known: "Sliced for Snapmaker U1".
- A printer whose exact model SnapCon cannot tell (an Adventurer 5M vs 5M Pro) is compared by
  brand only, as before.

### Model Library (new)
A Library of your model files across the G-code folder and any other folders you add as
**locations** (Settings → Library) — local disks or network shares. Open it with the Library button
in the header.
- **Models, not folders of files.** Files are grouped into Models from what the files themselves say
  (object names, project titles, slicer metadata, identical content), never from folder names alone.
  Each Model shows its covers, the printable files and plates, projects, and which of your printers
  each file was sliced for — with how sure SnapCon is and why.
- **Search and filters** by name, printer, location, type and material. "trex", "t rex" and "t-rex"
  all find TinyTREX and Skeleton T-Rex.
- **Needs attention** lists what SnapCon is unsure about: two Models that may be the same, a file
  that fits several Models, a file whose printer is unknown, a missing or unreadable file.
- **You stay in charge.** Merge, separate, move a file, rename, choose the cover, set the printer, hide
  — and undo any of it from the Model's Changes list, even after a restart. Your choices survive
  rescans and index rebuilds; the files themselves are never moved, renamed or changed.
- **Network shares that go offline** keep their Models in the Library, shown as offline; nothing in
  SnapCon waits on them.
- Library Diagnostics (admins) explains every grouping decision.

### Print and queue from the Library
- **Print and Queue on a Model** use the same Send and Queue dialogs and the same safety checks as the
  file browser, from any Library location. The dialog says which Model and location it is sending.
- Before anything is sent, SnapCon checks that the file is still exactly the one shown on the Model
  page. A changed file is refused rather than printed.
- A queued Library file is checked again, in full, when its turn comes. If it was moved, an identical
  copy elsewhere in the Library is used only after its content is verified; if its location is
  offline, it waits in place.

### Print history
- Every print is recorded with what was printed, where, when, how it was started, and how it ended
  when the printer reported it. A Model page shows its history and a count: "17 prints · 13 confirmed
  · 4 matched by filename". Prints sent from the Library are confirmed; older prints matched only by
  file name are marked as such and never counted as confirmed. Generic names ("Assembly", "Benchy")
  are never matched by name; a print whose name fits several Models asks you which one.
- **The last 90 days** of prints are filled in from the existing log on first start.
- Counts include every printer; the list only shows prints on printers you can see.

### Fixed: Bambu Lab projects with several plates printed plate 1
Choosing plate 3 in Send mapped plate 3's filaments but started plate 1. Now:
- the plate you choose drives both the tray mapping and the actual start command sent to the printer;
- a plate the file does not have is refused before anything is sent;
- a printer that cannot choose a plate is never sent one other than plate 1.

Plate 1 was validated. Starting a plate other than 1 on a physical Bambu printer has **not** been
tested yet; until it has, treat it as untested. It fails safely: SnapCon names the plate it starts
and never silently prints a different one.

### Queue reliability
- **A G-code folder that disappears** (a drive or share that is suddenly not there) no longer marks
  every queued job "file missing". Jobs wait in place until the folder answers again; a file that is
  really gone is still reported.
- **On Windows, another program holding the queue file open for a moment** (a backup tool, a viewer)
  no longer makes a queue action fail. If it holds it longer, the action is refused and nothing is
  lost.
- **A file sent now and started later** — uploaded to a busy printer and started from it afterwards —
  is recorded in the print history as exactly what was sent.

### Uploads
- **Every upload ends.** A printer that stops reading, or takes the whole file and never answers, no longer
  leaves an upload running for ever. It ends as sent, failed or **unknown**, and an unknown upload never
  starts a print. The time limits can be changed in `config.json` under `"uploadTimeouts"`.
- **Cancel upload** stops a file while it is still sending, from the card or a Send row. Every tab and device
  shows the upload strip and can cancel it, and it survives a page reload.
- **The Send dialog says "waiting to be sent"** for a file accepted but not yet sent. It says "Done" only when
  every file was sent.

### Printers
- **Delete a file from a printer** in the printer-files dialog, on printers that support it. It asks first,
  naming the file.
- **Filament material on a U1 slot** can now be set, not just its colour. A slot with no material set starts on
  Generic PLA.
- **Several colors can share one toolhead** when sending a print. This used to be refused.
- **Auto-level on FlashForge 5M printers** on their own firmware: before a print, from the job's choice or the
  printer's default. Tested on a 5M PRO.
- **FlashForge print starts** get 15 seconds to show, not 2.5, so a healthy start is no longer reported as failed.
- **Rediscover** (Settings → Printers) checks saved U1 printers for a changed address, serial or name, and offers
  to update them.
- **Discover** scans only the default network adapter's subnet, not VPN and virtual adapters.
- **FlashForge printers on ZMOD or Forge-X:** file sync now works. Camera snapshots from ZMOD printers now work.
  An AD5X on ZMOD can be allowed to start prints over Moonraker, per printer; this is unverified, so it stays off
  by default.
- **Fixed:** one unreachable printer no longer hangs the whole Firmware tab.

### Fleet and interface
- **A new top bar**, and status pills that filter the fleet.
- **A new printing card** in Full view, now the default. **Classic** is still in Settings → View → Printer card
  layout.
- **Compact view** has its own card.
- **Offline cards** are clear about it and say when the printer was last reached. Preheat is disabled, with the
  reason, on a printer that is offline, updating or rebooting.
- **File names keep their extension** wherever they are shown.
- **Keyboard focus** survives a card update, and List view rows show feedback from an action.
- **The Library** has a folder tree beside the grid with Rescan, and file type tags on model cards.
- The light theme's remaining gaps are closed, danger buttons have a real outline, and scrollbars match the theme.

### Queue
- **A printer that goes idle without reporting how its print ended** no longer leaves the item "printing" for
  ever: the queue asks a person. **Mark as completed** records a print you saw finish, and Resume is no longer
  offered where it could only fail.
- **A queue dispatch's upload** shows on the card and can be cancelled.
- **Clear** stops a dispatch that has not started its print, instead of letting it start anyway.

### Virtual printers
- **Enable virtual printers** (Settings → General) is off by default. While it is off, virtual printers are left
  out of the fleet and stay saved in `config.json`.
- **Virtual U1** is a new printer type that runs a simulated U1 on this machine, for trying SnapCon without a
  real printer. The Simulator is now shown as "Test printer".

### Reliability and upgrades
- **An unreachable network share no longer freezes SnapCon.** File access that may touch a share now runs apart
  from the server, so printers and pages keep working while it is down.
- **The audit and sync databases are backed up nightly**, the way the Library is.
- **Installed translations now receive new strings** at startup, and their existing values are never changed.

### Update check
- SnapCon now checks GitHub once a day for a newer release and tells admins in the top bar and in
  Settings → General → Updates. It is on by default; the request carries only SnapCon's version
  (nothing about your printers or files), and the "Check for updates" switch turns it off.

### Docker: settings now live in a mounted folder (action needed to use Queue Management)
If you run SnapCon with Docker, `config.json` is now kept in a mounted folder (`./config`) instead of
being mounted as a single file.

- **Why:** switching Queue Management on or off, and changing a printer's pool, now save the settings by
  writing a complete new file and swapping it in, so a crash or power cut cannot leave half a settings
  file. A file mounted on its own cannot be swapped, so on the old layout those three actions fail (the
  settings are left untouched, and the message says why).
- **Existing installations keep running** on their current compose file after an image update. Everything
  else still saves. To use those three actions, move to the new layout: stop SnapCon, copy `config.json`
  into a new `config` folder, switch to the new compose file, start again. The steps are in
  `docs/docker-config-migration.md`.
- **SnapCon refuses to start rather than run on default settings** if the new layout is used but an
  existing installation's `config.json` was not copied into the folder, or the copy there cannot be used
  (damaged, empty, or not a file). The file is left exactly as it is. Default settings have user
  accounts switched off, so starting anyway could have opened an installation that required sign-in. The
  log says what to do.
- **New installations** follow the quick start in `docker-compose.yml`; nothing extra is needed.

Tested on Docker Engine on Linux. Not tested on Docker Desktop (macOS, Windows), rootless Docker, or
settings folders on network storage.

### Fleet utilization (new)
- **A Utilization page**, opened from the top bar, shows how the fleet's time was spent over 7, 30 or 90
  days: printing, idle, paused, in error, and unreachable from SnapCon, per day and per printer, with CSV
  export.
- **Four headline figures:** utilization, average print time per printer per day, time lost to failed
  prints, and paused and error time. Job success rate is shown with how many outcomes are actually known.
- **Only what SnapCon saw counts as confirmed.** Estimated time is marked as an estimate, and time
  SnapCon was not running is shown as not recorded, never filled in.
- **Farm hours** (count only your working hours) are set in `config.json` under `utilization.farmHours`;
  there is no Settings option yet.
- **Reading each printer's own job history** to fill in outcomes is off by default
  (`utilization.readPrinterHistory` in `config.json`).
- Recording starts when you install this release.

### Delete files from the File Browser
- **Delete** one file or a selection. **Move to Trash** is the default: the file is kept for 30 days in a
  trash folder inside the G-code folder and can be restored. Nothing empties the trash automatically yet.
- **Delete permanently** is offered only to a signed-in Admin, and only while user accounts are switched
  on. It asks twice.
- **A file SnapCon still needs is not deleted:** one being uploaded, waiting to be sent, or named by a
  queue item.
- **Nothing is overwritten:** a restore never replaces a file that has since taken the same name. On
  storage that cannot guarantee this, restore is refused and the file stays in the trash.
- If the storage stops answering part-way, the result is reported as unknown, not as done.

### Queue: saving and recovery
- **Queue saves are flushed to disk**, and so is the folder they are in where the system allows it, so a
  finished save is far less likely to be lost in a crash. This has not been tested against a real power
  loss, and Windows cannot flush a folder.
- **A queue file that cannot be read is never guessed at or replaced.** SnapCon keeps it, stops queue
  changes, and asks an Admin to decide; that state now survives a restart. Starting the queue empty is an
  explicit Admin action, and the files that were in place are kept under new names.
- **Switching Queue Management on or off, and changing a printer's pool, now either happen completely or
  not at all.** If the settings cannot be saved, the queue is put back and the message says what is on
  disk.
- **The command-line mode** (`--load`) no longer touches the queue files of a running SnapCon.
- How recovery, reset and rollback work: `docs/queue-recovery.md`.

### Design refresh (preview)
A new look you can try without giving up the current one. Switch it on in **Settings → View → Design
refresh (preview)**. It applies at once, in this browser only, and you can switch back to the current
design at any time.
- **Three themes** from the theme button: Day, Night and Awareness.
- **Clearer buttons:** the main action stands out. E-Stop has its own danger style: it is filled, where
  Cancel and the other destructive actions are outlined.
- **Errors you cannot miss:** a printer in Error gets a red outline and a moving light until someone
  clicks its card or opens its Health page.
- **Printer cards:** the action buttons line up along the bottom of every card. In Full and Compact,
  spools are laid out two by two (1 and 2 on the left, 3 and 4 on the right on a Snapmaker U1). Camera
  view shows no spools, as today.

This is a preview: some screens are only recoloured, and details may change.

Also fixed, in both designs: a card's fourth action no longer runs off the card, and number steppers keep
their value visible.

The theme icons are from Lucide. Third-party notices are in `THIRD_PARTY_NOTICES.md`, which is in the
Docker image and the downloads; every installation also shows it at `/THIRD_PARTY_NOTICES.md`.

### Fleet, Health and files
- **One unreachable printer no longer slows the whole Fleet page.** A printer last seen offline is shown
  from that result at once and re-checked in the background. It can be switched off with
  `"fleetFastOffline": false` in `config.json`.
- **The Health page always gets an answer.** It used to wait forever for an offline FlashForge printer,
  or one on stock firmware. It now says the printer is offline, or that its firmware has no health data.
- **File search stays in the folder you are in.** Searching inside a folder used to list matches from
  every folder. It now covers that folder and the ones below it; from the top it still covers everything.
- **Energy cost uses each printer's power draw** (Settings → Printers → Power draw). It used to assume
  1,000 W per printer, several times too high for most printers. No energy cost is shown when the power
  draw, the rate or the print time is unknown.
- **Fixed:** saving Settings no longer drops the `utilization` and `openeiKey` entries set by hand in
  `config.json`.
- **Fixed:** the command-line upload to a remote SnapCon no longer crashes or hangs when the file
  disappears or the connection drops while sending.

### Known limitations
- Docker: the three Queue Management actions above need the new settings folder layout; see
  `docs/docker-config-migration.md`.
- Starting a Bambu plate other than plate 1 has not yet been tested on physical hardware (see above).


2026.11.1

Fixes and new additions to 2026.11.0. Nothing changes in how printers are driven or in the queue, and
your settings and data are kept.

### New additions
- **Model Library: select several models to hide or delete them.** Each model card has a checkbox at
  its bottom right. With at least one ticked, a bar under the grid offers Hide and Delete; a right-click
  on a card offers the same. Both ask first, naming the model or saying how many.
  - **Hide** takes the models out of the Library; "Show hidden models" lists them and offers Unhide.
    Nothing is deleted.
  - **Delete** uses the file browser's delete for the models' print files in the G-code folder: Move to
    Trash by default, and Delete permanently only for a signed-in Admin. The models are then hidden.
    Pictures, documents and files in other locations are left where they are, and the dialog says how
    many.
- **Model Library: sharper pictures for 3MF files.** The Library now keeps a plate's full picture
  (512 px in Bambu-family slicers) instead of the small one (128 px). 3MF files are read again once
  after the update.
- **Model Library: a Model's page** shows larger pictures, and writes out each filament a file needs:
  its colour, its type and its grams, then the total and the estimated filament cost (when a filament
  price is set in Settings → General).
- **Model Library: opening it closes the file manager.**
- **File browser: leave a search with ✕ or Esc.** The search box has a ✕ while it holds text, and Esc
  clears it too. Before, the only way back to the folder was to delete the text.
- **File browser: the selected file's details show in every view.** The filaments it needs, the
  printer it was sliced for and the estimated cost were hidden in Compact and Camera view. Its picture
  is larger.
- **Printer cards: the actions stay on one row, the main action first.** An idle printer shows Print,
  Reprint, Upload, Preheat; a printing one shows Pause or Resume, Plate, Cancel, E-Stop. On a narrow
  card the buttons tighten in steps and keep their icons. List view uses the same order.

### Fixes
- The estimated cost is written with the currency set in Settings → General. In the file browser and
  in the dialog for printing a file that is already on the printer it always showed "$".
- Settings → General: an empty "Filament, per spool" or electricity rate box showed an example number
  that read as a saved value. The examples now say "e.g.".
- A card's print picture no longer jumps for a moment when the card is redrawn.
- A card is no longer redrawn at every tool change of a multi-colour print. Only its filament lanes
  are updated, so whatever you were pointing at or had selected on the card stays.

### Design refresh preview
These apply only when the preview is on (Settings → View).
- **New: flat action buttons** in every view. Print and Resume are the filled ones, E-Stop sits apart
  at the right, and a button that cannot be used now stays readable.
- **New: a Night palette** with neutral dark surfaces, steel blue for the main actions, teal for
  printing, green for complete, amber for paused, and one grey for idle and offline.
- **Removed: the Awareness theme.** The preview now has Day and Night, like the classic design. A
  browser or account that had Awareness chosen follows the computer's light or dark setting until a
  theme is picked again.
