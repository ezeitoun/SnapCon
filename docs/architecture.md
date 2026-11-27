# SnapCon architecture reference

Moved out of `CLAUDE.md` (its "Section 0": Directory map and Architecture notes) so that it is read
when relevant instead of being loaded into every session. **Everything here is still a project rule
with the same force as `CLAUDE.md`**; `CLAUDE.md` says which section to read before working in each
area. The text below is unchanged, except where it was brought in line with the code: the sentence under "CLI notify mode" about which stores a `--load` process loads, and the `queue/` entries (directory map and subsystem description), both updated with the queue durability fix. "Section N" in it means that numbered section of `CLAUDE.md`
("Section 0" is `CLAUDE.md`'s project layout plus this file and `docs/ui-conventions.md`; "Section 5"
is continued in `docs/ui-conventions.md`).

If something here looks stale, re-verify against source before trusting it — see `CLAUDE.md` Section 1,
"Existing behavior is evidence."

## Directory map

**Repository root** (2 levels; `node_modules`/`.git`/`dist`/`gcode` contents omitted):

```
server.js                 — Express hub, ~3600 lines
auth.js, groupAccess.js   — authentication and printer-group access control
fleetProbe.js             — printer status probing: offline cache per printer id, the fleet's
                             non-blocking display path (docs/fleet-probe.md, TODO §48/§43)
parser.js                 — gcode metadata extraction
connectors/                — creality-klipper.js, dummy-simulator.js, flashforge-ad5x.js,
                             flashforge-adventurer.js, flashforge-utils.js, http-utils.js,
                             index.js, klipper-moonraker.js, snapmaker-u1-klipper.js,
                             snapmaker-u1-klipper-ws.js
remote-access/              — RemoteAccessService.js + Store/SecureCredentialStore/
                             CloudflaredManager/RemoteAccessApiClient/Ed25519Identity/redact/serialize
sync/                       — SyncEngine.js, SyncStore.js (Logs/Camera/G-code Sync)
queue/                      — QueueEngine.js, QueueStore.js, poolChange.js, migratePrinterPool.js (Queue Management)
transfers/                  — DeferredStore.js: sends waiting for a busy printer (docs/TODO.md §37 P3);
                             TransferResults.js: each transfer's final outcome, for --wait (§37 P4)
audit/                      — AuditLog.js (Settings > Logs audit trail)
library/                    — Model Library (docs/library-design.md): LibraryService.js (entry point),
                             LibraryStore.js, schema.js, permissions.js, locations.js, routes.js,
                             WorkerHost.js + indexer-worker.js (worker thread), Scanner.js (M2 file
                             access, main thread), indexStore.js (M2 DB writes, worker), gcodeExtract.js,
                             folders.js, diagnosticsRaw.js; public/library-raw.html is the raw view
                             M4: grouping.js, titles.js, genericNames.js, decisions.js, diagnosticsGrouping.js
                             (public/library-diagnostics.html). M5: libraryView.js (read-only Library API);
                             the UI is public/library.js, an in-app page (/library) like Health
netfs/                      — NetFs.js + netfs-worker.js + index.js (singleton): network-safe fs access
public/                     — app.js (~7300 lines), style.css, index.html, fonts/, *.svg icons, error-codes.js
test/                       — connectors/, queue/, audit/, remote-access/, library/, library-spike/,
                             docker.test.js, groupAccess.test.js, parser.test.js
docs/                       — README screenshots; library-design.md (Model Library specification,
                             the single implementation reference for that feature); TODO.md (gitignored)
spike/library-m0/           — M0 measurement code for the Library (not part of the app)
fixtures/                   — fake-cloudflared.js
Dockerfile, docker-compose.yml, package.json, package-lock.json
```

The provisioning backend's directory map is in `CLAUDE.local.md`.

## Architecture notes

Preserved and re-verified from the previous version of this file, refreshed against current source.

### Backend: one process, `server.js` is the hub

Everything server-side is orchestrated from `server.js` (~3600 lines). Key things to know before touching it:

- **BASE_DIR vs ASSET_DIR**: when running as a `pkg`-packaged executable, `__dirname` points into the read-only bundle snapshot. User-editable state (`config.json`, `users.json`, `gcode/`, and the `audit-data/`, `sync-data/`, `remote-access-data/`, `data/` directories) must live next to the actual executable (`BASE_DIR`), while bundled assets (`public/`, `parser.js`) stay on `__dirname` (`ASSET_DIR`). Don't conflate the two when adding anything that reads/writes files.
- **Config is live-reloaded, not restart-required**: `CFG`/`FOLDER`/`PRINTERS` are module-level globals populated by `loadConfig()` and mutated in place by the Settings API routes (`POST /api/config`).
- **CLI notify mode**: if the process is invoked with `--load <file> --printer <name>`, the top of `server.js` hands it to `notifyCli.js` as a one-shot CLI call to an *already-running* instance's `/api/notify-load` and exits — it never starts Express, and never loads a store: the queue store, the deferred-send store and the transfer-result store are created above the CLI block and loaded only below it, at real server start-up (`queueStore.load()` was moved below the block by the queue durability fix). `--wait [seconds]` follows the transfer through `GET /api/transfers/:id` (exit 0 verified/acknowledged, 1 failed/cancelled/refused, 3 out of time, 4 unknown/lost); without it, output and exit codes are exactly as before. This is what the packaged `snapcon-win-x64.exe --load ... --printer ...` hook and the Orca "plugin" integration both use. `--snapcon <host[:port]>` targets a SnapCon instance on a different machine and streams the file's bytes rather than a path reference (the target machine can't read a path off the caller's disk).
- **Printer status: two paths, never mixed.** `probeCached(p)` is the authoritative status for every decision and action (sends, uploads, deletes, firmware, queue, idle checks, notifyTick). `probeForDisplay(p)` is for `GET /api/fleet` only: a printer last seen offline is answered from memory and re-checked in the background, so one unreachable printer cannot slow the fleet; online/printing states are always probed live. Both live in `fleetProbe.js`, keyed by printer id. Switch: `config.json` `fleetFastOffline` (default on), changed live by `POST /api/fleet-fast-offline`. See `docs/fleet-probe.md`; a test pins the list of callers of each.
- Every `/api/*` route goes through `auth.makeAuthMiddleware()` first (`auth.js`, ~164 lines), which is a no-op (implicit admin) unless `CFG.usersEnabled` is true. Routes then layer `requireAuth` / `requireRegular` / `requireAdmin` on top for actual enforcement — see Section 8 for the authorization rules.

### Printer connectors: the plugin boundary

`connectors/index.js` is a registry mapping a printer's `connector` config string to an implementation module. **Adding a new printer brand means adding one file to `connectors/` and one line to the `REGISTRY` map — nothing else in the app should need to change.** Each connector module exports:

- `label`, `capabilities` (a fixed set of booleans — `camera`, `filamentHeads`, `excludeObject`, `unloadFilament`, `firmwareInfo`, `inventory`, `discovery`, `webUi`, `setColor`, `singleToolhead`, `health`, `fileSync`, `headMapping`, and others — the UI reads `capabilities` to decide what controls to render per printer, so a connector that doesn't support something simply doesn't declare it rather than the frontend special-casing brands).
  - **Cameras have two transports, reported additively.** `camera` means "there is a camera to show"; `cameraSnapshot` means the server can fetch frames (`getCameraSnapshot()` → `/api/snapshot`, the camera-grid JPEG polling, and notification images); `cameraWebrtc` means a browser-only live stream, with its signaling URL passed on the fleet row as `cameraWebrtcUrl` (derived from the printer's host, never stored in config.json). Keep these flat booleans — four places gate on `capabilities?.camera`, and nesting them into an object would read as truthy for every printer. A WebRTC-only camera supports live viewing and a canvas-captured manual snapshot, but **no notification image**, and is **LAN-only**: over HTTPS the signaling POST is mixed content and Private Network Access blocks it, so the tile says so once and never retries. Sessions live in `CAM_RTC`, are opened only for visible Camera View tiles, and are closed on viewport exit, view change, card rebuild/removal, offline, and hidden tab — see `docs/TODO.md` item 0 for what remains unverified.
- `probe(printer)` — polls the printer and returns a normalized fleet-status shape (state, progress, temps, layer, plate/exclude-object info, etc.) regardless of brand.
- `address` — how a printer on this connector is addressed: `{ scheme, defaultPort, portEditable, required }`, read through `getAddress(type)` and shipped to the browser with `listConnectorTypes()`. A printer stores the user-facing `ip`/`port` (plus `scheme` when it isn't the connector's own) and the canonical `url` derived from them; `connectors/address.js` owns the parse/compose, `connectors/migratePrinterAddress.js` splits pre-existing configs at startup, and `resolvePrinterAddress()` in `server.js` composes on save. The Settings row shows a Port field only when `portEditable`, and no address fields at all when `required` is false (the simulator). A connector with a fixed port (U1 80, FlashForge 8898) leaves the port out of the stored URL and applies it in its own `baseUrl()` — which is what keeps existing configs byte-identical through the migration.
- Print-control functions: `uploadFile`, `startPrintFile`, `pause`, `resume`, `cancel`, `eject`, `estop`, `bedTemp`, and brand-specific extras like `applyHeadMapping`/`unloadFilament` where the machine supports multi-toolhead filament.
- `verifyUpload(p, name, localPath, opts)` — reads back what the printer holds under `name` after an upload (`docs/TODO.md` §37 P2): `verified` (content checked), `acknowledged` (listed, at the right size where the printer reports one), `mismatch`, `absent` or `unverifiable`. The server (`verifyOnPrinter`) starts or stages a file only on `verified`/`acknowledged`; `absent`/`unverifiable` are Unknown and `mismatch` is Failed, and neither ever starts a print or deletes anything. Reusing a copy already on the printer instead of uploading requires `verified`. Every registered connector must export it — a test enforces this; one without it is treated as `unverifiable`. Each answer carries a `basis` — `content`, `size` or `name` — so a name-and-size check is never presented as a content check. With `localPath` null and `opts.localSize`, it checks a Loaded file later (§37 P5, `checkStagedCopy` in `server.js`): name and recorded size only, never content; the card's Print of a Loaded file starts only when that check finds it present.

Current connectors: `snapmaker-u1-klipper.js` and its WebSocket variant `snapmaker-u1-klipper-ws.js` (subscribes to live status over WS with delta-merge and staleness detection, falling back to the base HTTP connector when unhealthy), `klipper-moonraker.js` (generic Klipper/Moonraker), `creality-klipper.js` — these four share `connectors/http-utils.js`. `flashforge-adventurer.js` and `flashforge-ad5x.js` share `flashforge-utils.js` instead, since FlashForge speaks a different native protocol, not Moonraker. `dummy-simulator.js` is a no-network-I/O connector used by Queue Management testing/demo flows.

See Section 3 for U1-primacy rules.

### `remote-access/`: isolated subsystem, one entry point

`RemoteAccessService.js` is the *only* module `server.js` talks to for Remote Access (the managed Cloudflare Tunnel feature). It owns `RemoteAccessStore` (persistence), `SecureCredentialStore` (secrets), `CloudflaredManager` (child-process supervision of the `cloudflared` binary), `RemoteAccessApiClient` (talks to the provisioning backend — see the cross-repo contract in `CLAUDE.local.md`), and `Ed25519Identity` (per-installation signed identity). Nothing outside this module ever touches a `child_process`, a secret, or the provisioning backend directly — the `requireAdmin` routes `server.js` registers for `/api/remote-access/*` are the entire surface the browser can reach. Requires `usersEnabled` to be on first (SnapCon refuses to expose a login-less instance to the internet). `test/remote-access/` covers this subsystem in real depth; `fixtures/fake-cloudflared.js` stands in for the real binary in those tests.

### `sync/`, `queue/`, `audit/`: the other isolated subsystems

- **`sync/`** (`SyncEngine.js`, `SyncStore.js`) — the Logs/Camera/G-code Sync feature: downloads files from a printer's Moonraker file storage to a configured local folder, with SQLite-backed (`node:sqlite`) dedup/history tracking and age-based retention cleanup. Per-printer-per-root locking prevents overlapping sync runs.
- **`queue/`** (`QueueEngine.js`, `QueueStore.js`, `poolChange.js`) — the Queue Management ("Command Center") print-job queue: atomic, synchronous JSON persistence (temporary file written and flushed → `.bak` copy, flushed → rename → folder flush) with a `.bak` fallback and a corrupt-file quarantine/recovery flow requiring explicit admin acknowledgment before further writes resume. Recovery-required survives restarts through the marker file `data/queue-data.json.recovery-required`; an unreadable file is never moved, written over or reset. `poolChange.js` holds the changes that touch both `config.json` and the queue store (a printer's pool, Queue Management on/off); for those three routes only, `config.json` is replaced as a whole (`configLoader.js` `replaceConfigFile`) and never written in place, so they fail where it cannot be renamed over (a single-file Docker bind mount; the supported Docker layout mounts a settings folder instead, `SNAPCON_CONFIG_DIR`, `docs/docker-config-migration.md`). States, the reset's steps, rollback and the limits of what was verified: `docs/queue-recovery.md`.
- **`audit/`** (`AuditLog.js`) — the Settings > Logs audit trail, backed by `node:sqlite` with fully parameterized queries.

All three deliberately use Node's built-in `node:sqlite` rather than a native-addon SQLite package, specifically to avoid reintroducing native-addon packaging risk into the `pkg` cross-build (documented directly in `audit/AuditLog.js`'s and `sync/SyncStore.js`'s own header comments). Each wraps `require("node:sqlite")` in try/catch and degrades to safe no-ops if unavailable (e.g. on a pre-22.5 Node runtime) rather than crashing.

`transfers/` is the fourth such subsystem (plain JSON, no SQLite):

- **`transfers/`** (`DeferredStore.js`) — sends waiting for a busy printer (the Upload button with uploads-while-printing off, the slicer/CLI hook): `data/deferred-sends.json` written the QueueStore way (temporary file → `.bak` copy → rename, plus a flush), and slicer-pushed bytes durably in `data/deferred-files/<id>` before the record exists. First in, first out per printer **id**; never two open sends of one name to one printer. `server.js` sends them through the one per-printer transfer lock (`transferBusy`) as real jobs, read back like every upload, and **never starts a print** from any of it. An attempt still `uploading` at startup is reconciled by reading the printer back, never resent; a backup loaded after corruption brings every unfinished send back as "needs attention". Limits (MB) in `config.json` `deferredSends`: `maxFileMB` 512 (at most 2048), `maxTotalMB` 4096, `freeMarginMB` 256. Recovery is held, not guessed: a backup restore, an unreadable list or records it cannot understand put a **hold** on disk (no clean-up until an admin acknowledges; an unreadable list also refuses new sends), a list that cannot be read for now or is from a newer SnapCon is never written over, and complete files no record refers to are moved to `data/deferred-files/.orphaned/` — deleted only by an admin's explicit, audited `POST /api/deferred/orphaned-files/delete`. A source folder that does not answer leaves its send queued for 60 s (`notBefore`) without holding up other sends to that printer or its queue; among sends that can go, oldest first. **`TransferResults.js`** (§37 P4) keeps each transfer's final outcome (`data/transfer-results.json`, same save pattern; `config.json` `transferResults`: `retentionHours` 24, `maxCount` 1000, at most 10000), read by `GET /api/transfers/:id` (read-only; session + printer visibility, or the local notify token from loopback; anything else gets the unknown-id 404) and by the command line's `--wait` (`notifyCli.js`). A transfer id is one attempt: Send again makes a new one (`parentTransferId`). A final result is never overwritten — except `unknown` → verified/acknowledged for the same attempt on new read-back evidence, audited `transfer-result-reconciled` — and a completed send's record is removed only once its result is saved. A backup restore of either file never creates a result. Neither store is loaded before `server.js`'s CLI block returns: a `--load` call is a second process and must not tidy the running server's files. **Read-back semantics (§37 P2/A4):** `verified` with basis `content` means exact size plus the start, middle and end sampled (`connectors/http-utils.js`), never every byte — say "sampled" wherever it is described. After every read-back `verifyOnPrinter` re-takes the source's identity (`netfs.identity`: size, nanosecond mtime/ctime, inode, device) against the one taken before its bytes were read; changed → Unknown `local-changed`, not re-checkable → Unknown (fail closed), never Verified or Loaded. A waiting send's hash is bracketed by two identity reads. **No skip-identical (owner, 2026-10-29):** every accepted send uploads; nothing is reused on a sampled match (`compareRemoteFile` remains in the connectors but nothing in `server.js` uses it). `decideUpload` is only the replace guard: with `overwriteDifferentFiles` false a send goes only when `verifyUpload(p, name, null)` says `absent`; present or `unverifiable` is refused (fail closed) — at Upload, the queue and deferred sends. `skipIdenticalUploads` in `config.json` is ignored. A deferred send refused because the printer could not say re-queues (`waitingFor: "printer"`, 60 s `notBefore`); one whose name the printer has fails `PRINTER_HAS_FILE`. Queue items SnapCon itself staged (`alreadyUploaded`) are not asked. Reworded shipped strings get new keys (`replace_same_name_*`): installed translations keep values of keys they already have.

### `netfs/`: filesystem access that may be on a NAS

Any fs call that can touch the G-code folder, the sync/firmware folders, a Library location or another path a user typed goes through `require("./netfs").getNetFs()` — **never** `fs.*Sync` on the main thread and never `fs.promises` in a loop. Measured on Windows: a call to an unreachable SMB host blocks ~21 s and cannot be cancelled; synchronously that froze the whole server, and through `fs.promises` four such calls starve libuv's process-wide pool (the pool size cannot be raised from JS). netfs runs sync fs inside dedicated worker threads in lanes (interactive 2 / background 1 / probe 1) with per-op timeouts, and keeps an availability breaker per registered root or UNC share: while offline, calls fail at once with `NAS_UNREACHABLE` (routes answer 503 `gcode_folder_unreachable` via `replyIfNasDown`). **The breaker is never proof a file exists** — keep every existence/containment/identity check on every use. Specification: `docs/library-design.md` §23. Tests: `test/netfs/`. `netfs/netfs-worker.js` is listed in `pkg.scripts`; `netfs/` is copied by the Dockerfile.

### `library/`: the Model Library

`LibraryService.js` is the only module `server.js` talks to for the Model Library. **`docs/library-design.md` is its specification and wins over any other description, including this one.** It is built milestone by milestone (M0–M8), each approved by the owner before the next starts. Key rules a change must keep:

- **Storage:** `library-data/library.db` via `node:sqlite` (same degrade pattern as above), plus nightly `VACUUM INTO` backups in `library-data/backups/`. `library/schema.js` is the specification's §5 SQL, enforced statement for statement by `test/library/schema.test.js`.
- **Authored vs derived:** authored tables (models, decisions, prints, review items, grants, locations' configuration) are never dropped. Derived tables (the index) can be dropped and rebuilt at any time. No authored table may have a foreign key into a derived one.
- **Inferences and decisions:** every inferred relationship is a Claim with Evidence, confidence and provenance. A person's Decision always wins and survives rebuilds.
- **Permissions:** checked through Library capabilities (`library/permissions.js`), not roles.
- **Network locations:** reachability checks and network scanning go through `netfs/` (probe and background lanes), one filesystem operation at a time per location, and share netfs's availability breaker with the G-code folder.
- **Worker:** `library/indexer-worker.js` runs in a worker thread supervised by `WorkerHost.js`, and is listed in `package.json` → `pkg.scripts`.
- **Indexer split (M2):** `Scanner.js` does every file read on the main thread through netfs's background lane (throttled, paused while `UPLOADS_ACTIVE` > 0 in server.js — wrap any new upload path in `whileUploading()`); `indexStore.js` in the worker does all parsing and every database write on its own connection. Never parse a whole file or write the index from the main thread.
- **Printer identity in the index** comes only from the file's own fields through `public/printer-identity.js` (`targets_printer` Claims: high→applied, medium→suggested, low→recorded). Folder classification (`folders.js`, `familiesLikeName`) is for navigation and "folder disagrees" only, never Evidence for a file's printer.
- **3MF (M3):** `library/zipReader.js` is the hardened zip reader (also behind top-level `threemf.js`); `threemfExtract.js` turns the few small entries the scanner read into "what the file says". A printable Variant exists only for a plate whose G-code is inside; an unsliced project gets no printer Claim. Lineage (`lineage()` in `indexStore.js`) is recomputed from the whole index after scans and hashes. No Models or `member_of` before M4.
- **Extraction rule versions:** bump `RULE_VERSION` in `gcodeExtract.js` when extraction changes what it reads; files indexed under an older version are re-read automatically at the next start.
- **Printer identity:** comes only from the shared resolver `public/printer-identity.js` (also used by the Send dialog), never from folder names.

### `parser.js`: gcode metadata extraction

Reads a sliced gcode file's header comments to report which filament **colors** (not physical toolheads) a print needs — Snapmaker U1 gcode uses logical palette indices (`T<n>`) that the printer maps to physical heads at print start, so the parser's job is "which colors does this file need," not "which toolhead."

### Frontend: `public/`, no build step

`index.html` + `style.css` + `app.js` (~7300 lines) — hand-written, no framework, no bundler, served directly via `express.static`. Notable conventions:

- `style.css` uses a `:root` CSS custom-property token system (`--chassis`, `--panel`, `--ink*`, `--signal`, `--ok`, `--bad`, `--busy`, `--violet*`, etc. — a dark "control-room" theme with an amber accent). Prefer extending these tokens (or adding new ones + using `color-mix()` the way existing rules do) over hardcoding new hex values, since app.js also references some of them directly via inline `--status-color` custom properties.
- `statusColorText()` in `app.js` is the single source of truth for the status-badge color/label mapping, shared by both the card grid and the list-view table render paths — update it there, not per-view.
- Body classes (`body.compact`, `body.camview`, `body.listview`, `body.showfiles`) toggle the four fleet display modes and the file-browser sidebar via CSS, rather than swapping DOM structure — check existing `body.<mode>` selectors in `style.css` before adding new per-mode overrides.
- Fonts: `--mono` is self-hosted JetBrains Mono (`public/fonts/JetBrainsMono-Variable.woff2`, loaded via `@font-face`) to keep the app's local-first, no-external-request posture — don't switch this to a CDN-hosted font.

### Packaging & deployment

Three ways SnapCon ships: `npm start` from source, a `pkg`-built standalone executable per OS (see `package.json`'s `pkg` config and the BASE_DIR/ASSET_DIR split above), or Docker (`Dockerfile` + `docker-compose.yml`, config/gcode/users/audit-data/sync-data/remote-access-data/data mounted as volumes). In Docker `config.json` lives in a mounted settings folder named by `SNAPCON_CONFIG_DIR` (set in `docker-compose.yml`, never in the image; `configLoader.js` `resolveConfigLocation` / `checkConfigDir`): unset, `config.json` is in `BASE_DIR` as everywhere else; set, `checkConfigDir` both checks and loads: start-up stops (exit 78) rather than run on defaults when the folder is missing, when its `config.json` is present but unusable (left exactly as found, never set aside), or when it holds none on an installation that has been used; the settings it read are the ones the first `loadConfig()` starts with, and a later reload that fails keeps the settings in memory (`docs/docker-config-migration.md`). `IS_DOCKER` (checked via `/.dockerenv`) gates whether the Settings "Restart App" button is safe to expose — it only actually recovers the app when something supervises the process (Docker's `restart: unless-stopped`), not under a bare `node server.js` or the packaged binary. `test/docker.test.js` walks `server.js`'s actual `require()` graph and asserts every top-level local module it needs is covered by a `Dockerfile` `COPY` line — keep this passing rather than hand-verifying the Dockerfile when adding a new top-level module. `THIRD_PARTY_NOTICES.md` goes with every copy: a `COPY` in the `Dockerfile`, an entry in `pkg.assets`, and a route in `server.js` that serves it from `ASSET_DIR` at `/THIRD_PARTY_NOTICES.md` without sign-in (the only way to read a file embedded in a binary); `test/thirdPartyNotices.test.js` holds the three together.

### Misc

- `capture-proxy.js` is a standalone diagnostic tool (not wired into `server.js`) for capturing the raw HTTP traffic between Snapmaker Orca and a real U1 printer — run directly with `node capture-proxy.js http://<printer-ip> [port]`.
