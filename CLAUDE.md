# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This file is tracked in the repository. Private and machine-specific instructions — the Remote Access provisioning backend's repository and internals, the verified cross-repository contract, request-signing details, and this machine's paths — live in `CLAUDE.local.md` at the repository root, which is gitignored and loaded alongside this file. Where this file refers to it, read it there. On a clone without `CLAUDE.local.md`, everything here still applies: treat the provisioning backend's source and contract as unavailable, and say so before any change that would cross into it (Section 8) rather than assuming how it behaves.

## What this is

SnapCon is a local-first fleet management platform for 3D printer farms (Klipper/Moonraker-based printers — Snapmaker U1, generic Klipper — plus FlashForge and Creality via their native APIs). It's a single Node/Express server plus a hand-written, framework-free HTML/CSS/JS frontend — no bundler, no build step for the UI. It began as a fork of Danny Gimbell's U1Hub and has since diverged significantly.

---

# 0. Project layout

This section is filled from the actual current repositories. If it looks stale, re-verify against source before trusting it — see Section 1, "Existing behavior is evidence."

## Repositories

- This repository — the main SnapCon application (see "What this is" above for the stack). `server.js` is the backend entry point, `public/` is the frontend.
- A separate, private repository holds the Remote Access provisioning backend that SnapCon's `remote-access/` subsystem talks to. Its location, stack, commands, directory map and the verified client/server contract are in `CLAUDE.local.md`.

**Changes to Remote Access frequently touch both repositories.** Before changing authentication, authorization, tunnel behavior, provisioning behavior, request signing, trust boundaries, or related Remote Access behavior in either repository, check whether the other repository depends on the current behavior and report that dependency before implementing. A change in one repository is not complete until the relevant behavior in the other repository has been checked.

## Commands

**SnapCon** (repository root):

```bash
npm install                    # install
npm start                      # node server.js — serves http://localhost:4545
npm test                       # node --test "test/**/*.test.js" — full suite (connectors, queue, audit, library, groupAccess, parser, docker, remote-access)
node --test test/remote-access/apiClient.test.js   # run a single test file (pattern works for any path)
npm run build                  # pkg: builds standalone win/mac/linux binaries into dist/
```

No lint/format command is defined — no script, no `.eslintrc`/`.prettierrc`, no eslint/prettier dependency.

The provisioning backend's commands are in `CLAUDE.local.md`.

## Directory map

**Repository root** (2 levels; `node_modules`/`.git`/`dist`/`gcode` contents omitted):

```
server.js                 — Express hub, ~3600 lines
auth.js, groupAccess.js   — authentication and printer-group access control
parser.js                 — gcode metadata extraction
connectors/                — creality-klipper.js, dummy-simulator.js, flashforge-ad5x.js,
                             flashforge-adventurer.js, flashforge-utils.js, http-utils.js,
                             index.js, klipper-moonraker.js, snapmaker-u1-klipper.js,
                             snapmaker-u1-klipper-ws.js
remote-access/              — RemoteAccessService.js + Store/SecureCredentialStore/
                             CloudflaredManager/RemoteAccessApiClient/Ed25519Identity/redact/serialize
sync/                       — SyncEngine.js, SyncStore.js (Logs/Camera/G-code Sync)
queue/                      — QueueEngine.js, QueueStore.js, migratePrinterPool.js (Queue Management)
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

## Named shared things

Verified against source. Where something is marked NOT CURRENTLY SHARED, that means the *behavior* is a required convention but no shared helper/component implements it — don't invent one; apply the convention directly at the call site the way existing code already does.

| Item | Status | Exact reference | Use when |
|---|---|---|---|
| Helper text | EXISTS | `.settings-help` — `public/style.css:841-844`. 12px, `var(--ink-faint)`, with `.warn`/`.ok`/`.err` color-state variants. Used 24× across `public/app.js`. | Any helper text below a field or control. |
| Switch | EXISTS | `switchHtml(id, checked, label, description, disabled)` — `public/app.js:6420-6427`. Real `<input type="checkbox" role="switch" class="switch-input">`. CSS: `.switch-row`/`.switch-input`/`.switch-label`/`.switch-desc` (`public/style.css:921-932`). | A setting that is on or off and takes effect by itself. |
| Checkbox | EXISTS | `checkboxHtml(id, checked, label, description, disabled, attrs)` — `public/app.js:6437-6444`. CSS: `.checkbox-row`/`.checkbox-input`/`.checkbox-label`/`.checkbox-desc`. Several call sites (list-view row-select, bulk-heat, camera multi-select, groups picker) apply `.checkbox-input` to a raw `<input>` directly without calling `checkboxHtml()` — the CSS class is the consistently-shared part even where the generator function isn't always used. | One of several items being selected for an action. |
| Masked-secret control | EXISTS | `secretFieldHtml(cls, hasValue, placeholder)` (`public/app.js:6382-6388`) + `wireSecretField()` + `setSecretFieldState(field, hasValue)` (`public/app.js:6491-6497`) + `secretFieldValue()`. CSS: `.secret-field`/`.secret-chip` (`public/style.css:962-964`). | Any stored secret (tokens, API keys, bot tokens). |
| Toolhead mapping | EXISTS — **two, deliberately different, see Section 5** | `toolheadNumber(i)` (`public/app.js:1849`) and `headLabel(i)` (`public/app.js:594`). | See Section 5, "Toolhead naming," before using either. |
| Duration formatter | EXISTS | `fmtDuration(s)` — `public/app.js:3031-3037`. | Any elapsed/remaining/job-duration display. |
| Filename display | NOT CURRENTLY SHARED | No helper ties extension-stripping + truncation + `title` attribute together; each is done ad hoc per call site today. See Section 5, "Filenames," for the required convention. `stripExt()` (`public/app.js`) is the one extension-stripping function. | — |
| Settings dirty-state footer | NOT CURRENTLY SHARED — **two real implementations** | The generic per-tab system: `registerSettingsTab(name, getValues, setValues)` (`public/app.js`), `.settings-dirty-bar` (`public/style.css`); registered tabs are **General** and **Notifications**. Printers tab: its own `baselinePrintersDirty()`, `.printers-dirty-bar`. Other tabs (View among them) still save through the shared `#globalSaveRow` with no dirty footer. See Section 5. | — |

## Architecture notes

Preserved and re-verified from the previous version of this file, refreshed against current source.

### Backend: one process, `server.js` is the hub

Everything server-side is orchestrated from `server.js` (~3600 lines). Key things to know before touching it:

- **BASE_DIR vs ASSET_DIR**: when running as a `pkg`-packaged executable, `__dirname` points into the read-only bundle snapshot. User-editable state (`config.json`, `users.json`, `gcode/`, and the `audit-data/`, `sync-data/`, `remote-access-data/`, `data/` directories) must live next to the actual executable (`BASE_DIR`), while bundled assets (`public/`, `parser.js`) stay on `__dirname` (`ASSET_DIR`). Don't conflate the two when adding anything that reads/writes files.
- **Config is live-reloaded, not restart-required**: `CFG`/`FOLDER`/`PRINTERS` are module-level globals populated by `loadConfig()` and mutated in place by the Settings API routes (`POST /api/config`).
- **CLI notify mode**: if the process is invoked with `--load <file> --printer <name>`, the top of `server.js` handles that as a one-shot CLI call to an *already-running* instance's `/api/notify-load` and exits — it never starts Express. This is what the packaged `snapcon-win-x64.exe --load ... --printer ...` hook and the Orca "plugin" integration both use. `--snapcon <host[:port]>` targets a SnapCon instance on a different machine and streams the file's bytes rather than a path reference (the target machine can't read a path off the caller's disk).
- Every `/api/*` route goes through `auth.makeAuthMiddleware()` first (`auth.js`, ~164 lines), which is a no-op (implicit admin) unless `CFG.usersEnabled` is true. Routes then layer `requireAuth` / `requireRegular` / `requireAdmin` on top for actual enforcement — see Section 8 for the authorization rules.

### Printer connectors: the plugin boundary

`connectors/index.js` is a registry mapping a printer's `connector` config string to an implementation module. **Adding a new printer brand means adding one file to `connectors/` and one line to the `REGISTRY` map — nothing else in the app should need to change.** Each connector module exports:

- `label`, `capabilities` (a fixed set of booleans — `camera`, `filamentHeads`, `excludeObject`, `unloadFilament`, `firmwareInfo`, `inventory`, `discovery`, `webUi`, `setColor`, `singleToolhead`, `health`, `fileSync`, `headMapping`, and others — the UI reads `capabilities` to decide what controls to render per printer, so a connector that doesn't support something simply doesn't declare it rather than the frontend special-casing brands).
  - **Cameras have two transports, reported additively.** `camera` means "there is a camera to show"; `cameraSnapshot` means the server can fetch frames (`getCameraSnapshot()` → `/api/snapshot`, the camera-grid JPEG polling, and notification images); `cameraWebrtc` means a browser-only live stream, with its signaling URL passed on the fleet row as `cameraWebrtcUrl` (derived from the printer's host, never stored in config.json). Keep these flat booleans — four places gate on `capabilities?.camera`, and nesting them into an object would read as truthy for every printer. A WebRTC-only camera supports live viewing and a canvas-captured manual snapshot, but **no notification image**, and is **LAN-only**: over HTTPS the signaling POST is mixed content and Private Network Access blocks it, so the tile says so once and never retries. Sessions live in `CAM_RTC`, are opened only for visible Camera View tiles, and are closed on viewport exit, view change, card rebuild/removal, offline, and hidden tab — see `docs/TODO.md` item 0 for what remains unverified.
- `probe(printer)` — polls the printer and returns a normalized fleet-status shape (state, progress, temps, layer, plate/exclude-object info, etc.) regardless of brand.
- `address` — how a printer on this connector is addressed: `{ scheme, defaultPort, portEditable, required }`, read through `getAddress(type)` and shipped to the browser with `listConnectorTypes()`. A printer stores the user-facing `ip`/`port` (plus `scheme` when it isn't the connector's own) and the canonical `url` derived from them; `connectors/address.js` owns the parse/compose, `connectors/migratePrinterAddress.js` splits pre-existing configs at startup, and `resolvePrinterAddress()` in `server.js` composes on save. The Settings row shows a Port field only when `portEditable`, and no address fields at all when `required` is false (the simulator). A connector with a fixed port (U1 80, FlashForge 8898) leaves the port out of the stored URL and applies it in its own `baseUrl()` — which is what keeps existing configs byte-identical through the migration.
- Print-control functions: `uploadFile`, `startPrintFile`, `pause`, `resume`, `cancel`, `eject`, `estop`, `bedTemp`, and brand-specific extras like `applyHeadMapping`/`unloadFilament` where the machine supports multi-toolhead filament.

Current connectors: `snapmaker-u1-klipper.js` and its WebSocket variant `snapmaker-u1-klipper-ws.js` (subscribes to live status over WS with delta-merge and staleness detection, falling back to the base HTTP connector when unhealthy), `klipper-moonraker.js` (generic Klipper/Moonraker), `creality-klipper.js` — these four share `connectors/http-utils.js`. `flashforge-adventurer.js` and `flashforge-ad5x.js` share `flashforge-utils.js` instead, since FlashForge speaks a different native protocol, not Moonraker. `dummy-simulator.js` is a no-network-I/O connector used by Queue Management testing/demo flows.

See Section 3 for U1-primacy rules.

### `remote-access/`: isolated subsystem, one entry point

`RemoteAccessService.js` is the *only* module `server.js` talks to for Remote Access (the managed Cloudflare Tunnel feature). It owns `RemoteAccessStore` (persistence), `SecureCredentialStore` (secrets), `CloudflaredManager` (child-process supervision of the `cloudflared` binary), `RemoteAccessApiClient` (talks to the provisioning backend — see the cross-repo contract in `CLAUDE.local.md`), and `Ed25519Identity` (per-installation signed identity). Nothing outside this module ever touches a `child_process`, a secret, or the provisioning backend directly — the `requireAdmin` routes `server.js` registers for `/api/remote-access/*` are the entire surface the browser can reach. Requires `usersEnabled` to be on first (SnapCon refuses to expose a login-less instance to the internet). `test/remote-access/` covers this subsystem in real depth; `fixtures/fake-cloudflared.js` stands in for the real binary in those tests.

### `sync/`, `queue/`, `audit/`: the other isolated subsystems

- **`sync/`** (`SyncEngine.js`, `SyncStore.js`) — the Logs/Camera/G-code Sync feature: downloads files from a printer's Moonraker file storage to a configured local folder, with SQLite-backed (`node:sqlite`) dedup/history tracking and age-based retention cleanup. Per-printer-per-root locking prevents overlapping sync runs.
- **`queue/`** (`QueueEngine.js`, `QueueStore.js`) — the Queue Management ("Command Center") print-job queue: atomic, synchronous JSON persistence with a `.bak` fallback and a corrupt-file quarantine/recovery flow requiring explicit admin acknowledgment before further writes resume.
- **`audit/`** (`AuditLog.js`) — the Settings > Logs audit trail, backed by `node:sqlite` with fully parameterized queries.

All three deliberately use Node's built-in `node:sqlite` rather than a native-addon SQLite package, specifically to avoid reintroducing native-addon packaging risk into the `pkg` cross-build (documented directly in `audit/AuditLog.js`'s and `sync/SyncStore.js`'s own header comments). Each wraps `require("node:sqlite")` in try/catch and degrades to safe no-ops if unavailable (e.g. on a pre-22.5 Node runtime) rather than crashing.

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

Three ways SnapCon ships: `npm start` from source, a `pkg`-built standalone executable per OS (see `package.json`'s `pkg` config and the BASE_DIR/ASSET_DIR split above), or Docker (`Dockerfile` + `docker-compose.yml`, config/gcode/users/audit-data/sync-data/remote-access-data/data mounted as volumes). `IS_DOCKER` (checked via `/.dockerenv`) gates whether the Settings "Restart App" button is safe to expose — it only actually recovers the app when something supervises the process (Docker's `restart: unless-stopped`), not under a bare `node server.js` or the packaged binary. `test/docker.test.js` walks `server.js`'s actual `require()` graph and asserts every top-level local module it needs is covered by a `Dockerfile` `COPY` line — keep this passing rather than hand-verifying the Dockerfile when adding a new top-level module.

### Misc

- `capture-proxy.js` is a standalone diagnostic tool (not wired into `server.js`) for capturing the raw HTTP traffic between Snapmaker Orca and a real U1 printer — run directly with `node capture-proxy.js http://<printer-ip> [port]`.

---

# SnapCon — Claude Development Guide

This file defines the engineering principles, architectural constraints, review expectations, and UI conventions Claude must follow when working on SnapCon.

These are project rules, not suggestions.

SnapCon is a production printer fleet-management application developed primarily for the Snapmaker U1 ecosystem.

Reliability, predictable behavior, recoverability, and maintainability are more important than architectural novelty.

The project intentionally uses a relatively lightweight architecture.

Do not introduce frameworks, abstractions, dependencies, or infrastructure merely because they would make the code look more conventional or "modern."

---

# 1. Development philosophy

## Understand before changing

Before changing code:

1. Understand the complete execution path involved.
2. Search for all callers and consumers of the code being changed.
3. Check whether another subsystem already compensates for the apparent behavior.
4. Look for an existing SnapCon pattern before designing a new one.
5. Identify side effects, shared state, timers, polling, asynchronous work, network operations, and DOM references affected by the change.
6. Consider connector differences rather than assuming all printers behave like the Snapmaker U1.
7. Determine whether the issue is a current bug, realistic risk, scaling concern, maintenance concern, or merely theoretical/style concern.
8. Read existing tests covering the affected area before designing the change.

Do not modify code when I explicitly request planning or review first.

## Existing behavior is evidence

Before describing something as a bug:

- trace the complete path;
- search for guards or compensating behavior elsewhere;
- inspect the current source;
- inspect relevant tests;
- check whether the behavior is intentional.

Previous audits, review documents, TODOs, comments, issues, and earlier Claude conclusions may be used as leads, but they are not current-state evidence.

Every finding must be re-verified against the current source.

If a reported issue has already been fixed, say so rather than designing another fix for it.

## Scope discipline

Solve the requested problem.

Do not expand the scope merely because adjacent code could also be improved.

If investigation exposes another issue:

- mention it;
- explain whether it affects the current task;
- recommend a separate task when appropriate.

Do not opportunistically refactor unrelated code.

Do not create generic frameworks for behavior required in only one place.

Do not replace working architecture merely because another architecture is more fashionable.

Prefer one understandable local mechanism over an abstraction whose future reuse is hypothetical.

## Prefer existing patterns

Before inventing a new mechanism, search SnapCon for an existing implementation of the same problem.

Reuse established patterns where they are correct.

Particularly strong existing implementations should be treated as examples rather than rewritten simply for consistency with weaker areas of the codebase.

Consistency is valuable, but correctness is more important than making everything look identical.

---

For code review, audit, or planning-only tasks, read `docs/review-and-planning.md` before starting.

---

# 2. Printer data is evidence

Treat live printer data as authoritative evidence.

A module, object, field, or capability existing in Klipper, Moonraker, firmware source, or manufacturer documentation does not mean it is loaded, enabled, or available on a particular printer.

Before building a feature or metric from printer data:

1. Confirm the object or field exists on the live printer.
2. Confirm what the value actually represents.
3. Confirm its units and semantics.
4. Confirm whether it is instantaneous, cumulative, resettable, or persistent.
5. Confirm connector behavior before exposing it through shared SnapCon code.

A module existing in the Klipper or Moonraker source tree does not mean the object is loaded on the machine.

Query the live printer's object list before building anything on a metric.

Do not infer availability from upstream source code alone.

If a value has no confirmed source, drop it rather than substituting the closest available field.

Say that the source does not exist or is not currently available.

Do not derive a metric the printer doesn't report — such as drift over time, historical utilization, or per-toolhead operating hours — unless SnapCon explicitly stores the history required to calculate it correctly.

Do not present an estimate or derived value as printer-reported data.

If a useful metric can only be estimated, identify:

- source values;
- calculation;
- assumptions;
- limitations;

and obtain approval before implementing it.

Absence of data is valid state.

Prefer `null`, unavailable, unsupported, or an appropriate empty state over fabricated/default data that could be mistaken for a real printer reading.

---

# 3. Printer connector architecture

The connector abstraction is an important SnapCon boundary.

Shared code should use connector capabilities and connector functions rather than manufacturer-specific assumptions whenever practical.

Keep manufacturer-specific interpretation inside the connector when practical rather than teaching shared frontend/backend code manufacturer-specific semantics.

When reviewing printer behavior, trace the complete path:

printer response
→ connector normalization
→ server state/API
→ frontend interpretation

Look specifically for:

- incorrect capability assumptions;
- manufacturer-specific behavior leaking into shared code;
- inconsistent state vocabulary;
- missing capability checks;
- reconnect/state problems;
- timeout behavior;
- error normalization;
- fallback behavior.

The Snapmaker U1 is SnapCon's primary ecosystem.

Experimental connectors are not required to have identical maturity or feature coverage.

Do not weaken the U1 implementation merely to achieve artificial connector symmetry.

Do not require feature parity where the underlying printer does not provide the necessary capability or data.

---

# 4. Frontend architecture

SnapCon intentionally uses a framework-free frontend.

Do not trim or soften this rule into wording such as "prefer minimal dependencies."

Do not recommend React, Vue, Angular, Svelte, a virtual-DOM framework, a component library, or a frontend rewrite unless there is an extraordinary, demonstrated requirement that cannot reasonably be solved within the current architecture.

Do not quietly introduce a frontend framework or component library as part of an unrelated feature, cleanup, optimization, or refactor.

"Modernizing the frontend," reducing boilerplate, improving maintainability, or making component reuse easier are not sufficient reasons by themselves to introduce a framework.

Prefer localized improvements using SnapCon's existing JavaScript, DOM, CSS, and shared UI patterns.

If you believe a framework is genuinely required, stop at the planning stage and explain:

- the concrete problem the current architecture cannot reasonably solve;
- why a framework is necessary rather than merely convenient;
- migration scope;
- operational and packaging impact;
- regression risk;
- why the benefit justifies changing a core architectural decision.

Do not implement such a migration without explicit approval.

## Frontend lifecycle

High-frequency frontend paths require particular care around:

- DOM identity;
- event listeners;
- stale DOM references;
- polling;
- asynchronous updates;
- camera refresh;
- job progress;
- manual refresh;
- visibility changes;
- module/global state;
- UI state persistence.

Do not assume a DOM element captured before an asynchronous operation remains mounted afterward.

When optimizing rendering, prefer the smallest mechanism that solves the demonstrated problem.

Do not gradually invent a generic virtual DOM or reconciliation framework inside the existing frontend.

---

# 5. UI conventions

Use established SnapCon UI conventions consistently rather than inventing new interaction patterns for individual features.

Before implementing a new UI control or interaction, search the existing SnapCon UI for the same type of interaction.

Reuse the established component, CSS class, layout, wording pattern, and behavior where appropriate.

If an implementation intentionally deviates from an established convention, call out the deviation during planning and explain why.

Do not create a second UI pattern for a problem SnapCon already solves.

## Controls

Switch = a setting that is on or off and takes effect by itself.

Checkbox = one of several items being selected for an action.

Both are real semantic inputs:

- `input type="checkbox"` for checkboxes;
- `input type="checkbox" role="switch"` for switches.

Never implement switches or checkboxes as `div` elements with click handlers.

Every visible label must be correctly associated with its control using `htmlFor`/`for`.

Preserve native keyboard interaction and focus behavior whenever possible.

See Section 0's Named shared things table for the exact Switch and Checkbox implementations (function signatures, file paths, CSS classes, and current usage-consistency notes).

## Labels and helper text

Labels use sentence case.

No ALL CAPS labels anywhere.

Labels appear above the field.

Helper text appears below it.

Helper text uses SnapCon's established helper-text style — see Section 0's Named shared things table for the exact class.

Do not introduce a new typography treatment when it already serves the purpose.

## Destructive actions

Destructive actions use the danger role.

They must never visually resemble the safe adjacent action.

Irreversible actions require confirmation.

The confirmation must name what will be affected rather than using a generic "Are you sure?"

Prefer:

`Remove 3 printers?`

over:

`Are you sure?`

## Action scope

Buttons name the scope of an action whenever multiple items are affected.

Examples:

- `Heat 3 printers`
- `Exclude 2 objects`
- `Unload all 4 heads`

Do not use ambiguous labels such as `Heat`, `Exclude`, or `Unload` when the action applies to multiple targets.

## Disabled controls

Disabled controls carry a `title` attribute explaining why the action is unavailable.

Do not require the user to infer why a control is disabled.

## Settings

Settings tabs use the shared dirty-state behavior described below. **Two separate, real implementations currently exist — not one shared component** (see Section 0's Named shared things table for the exact references); do not consolidate them as a side effect of an unrelated task, and do not pretend a single shared helper spans both. The General and Notifications tabs are registered onto the generic per-tab system (`registerSettingsTab()`); the Printers tab has its own separate implementation; the remaining tabs (View among them) still use the shared Save row and have no dirty footer yet.

Whichever implementation applies to the tab you're working on, the required behavior is the same:

- When settings differ from their last successfully saved values, show the sticky settings footer containing: change count; Discard; Save.
- The footer appears only while dirty.
- Dirty state is a diff against the last successfully saved values, not merely evidence that an input event occurred.
- After successful save, update the saved baseline.
- Discard restores the last successfully saved values.

## Filenames

**No shared helper currently implements this** — extension-stripping, truncation, and the `title` attribute are done ad hoc per call site today. The required convention, regardless:

- strip the extension;
- retain the complete original filename in a `title` attribute;
- truncate the visible filename when necessary;
- place filenames in flexible columns so they do not force layouts wider.

Never modify the actual filename merely for display purposes.

Do not invent a shared filename-display helper/component name that doesn't exist — apply the convention above directly at the call site, the way existing code already does.

For extension-stripping, use `stripExt()` in `public/app.js` (strips any extension). It used to be defined twice; commit `0686754` removed the duplicate, so there is now exactly one.

## Toolhead naming

SnapCon has **two real, deliberately different** toolhead-numbering conventions. Do not collapse them into a single "always T1–T4" rule, and do not substitute one for the other without first verifying which convention the feature you're touching is supposed to use — they produce different labels for the same index once T-notation is on, and swapping them silently mislabels a toolhead.

- **`toolheadNumber(i)`** — `public/app.js:1849` — `"T"+(i+1)`. Maps Klipper's 0-based extruder/eN indexing to 1-based T1–T4 (`extruder`/index 0 → T1, `extruder1`/index 1 → T2, `extruder2` → T3, `extruder3` → T4). Documented in-code as the single source of truth for "which physical toolhead does this Klipper object refer to," shared by every Health-page card that references a toolhead: heaters via `heaterLabel()`, fans via `fanLabel()` (example: `e0_nozzle_fan` → T1's cooling fan), and MCUs.
- **`headLabel(i)`** — `public/app.js:594` — `USE_T_NOTATION ? 'T'+i : String(i+1)`. A separate numbering (0-based when T-notation is on — G-code `Tn`-command style) used by the fleet-card Toolheads/spool-lane UI and the Quick Print extruder picker. Explicitly documented in-code as not interchangeable with `toolheadNumber()`.
- MCU names are relabeled server-side, through neither function: `connectors/http-utils.js` maps `mcu` → `"mainboard"` and `mcu e0`.."mcu e3"` → `"toolhead e0"`.."toolhead e3"` (0-based, no T-notation).

Rules:

- Use the mapping appropriate to the UI context you're working in. Check which one the surrounding code already uses before adding new output.
- Never independently derive a user-facing toolhead number from a Klipper object name (`extruder2`, `e1_fan`, etc.) in UI or feature-specific code — always go through one of the two existing functions.
- If a newly encountered object name doesn't fit either existing mapping, investigate and extend the appropriate one rather than inventing a third.

## Empty toolheads

An empty toolhead renders as an empty slot.

Never render a spool graphic merely because the toolhead exists.

A spool graphic implies filament is actually present and must only be shown when printer state supports that conclusion.

## Secrets

Secrets use the shared masked-secret control — see Section 0's Named shared things table for the exact implementation.

Configured secrets display:

- Configured badge;
- Replace;
- Clear.

Never place an existing secret back into the DOM merely to display it.

Never use a placeholder that resembles an actual secret value.

A placeholder must not imply a secret was retrieved when only configured/not-configured state is known.

## Durations

Use `fmtDuration(s)` (`public/app.js:3031-3037`) whenever displaying durations — elapsed/remaining/job-duration displays all route through it (seconds are dropped once the total reaches an hour, kept below that).

Do not create locally different duration formatting for a new feature when this shared implementation already exists.

---

# 6. Backend principles

SnapCon uses a shared Node process to manage the fleet.

Blocking the Node event loop can therefore affect every printer and every connected user.

Treat the following carefully:

- synchronous operations on large files;
- expensive loops;
- whole-file hashing;
- large JSON serialization/parsing;
- blocking filesystem operations;
- unbounded network operations;
- unbounded response bodies.

Do not optimize harmless synchronous operations merely because they are synchronous.

Evaluate realistic input sizes and frequency.

## Printer network operations

Printer network operations must fail predictably.

Timeouts matter.

A printer that accepts a connection but stops responding must not be able to leave important SnapCon operations hanging indefinitely.

Failure isolation is generally more important than aggressive retry behavior.

Especially scrutinize operations involving:

- E-Stop;
- pause/resume;
- cancel;
- print start;
- uploads;
- camera/snapshot requests;
- reconnects;
- queue execution.

---

# 7. Configuration and persistent state

Persistent state is operationally important.

Never silently destroy potentially recoverable user data.

Distinguish:

- missing file / legitimate first run;
- valid file;
- corrupt file;
- failed write;
- interrupted write.

Do not treat "missing" and "corrupt" as equivalent states.

Prefer recovery patterns already proven elsewhere in SnapCon.

When changing persistence behavior, consider:

- atomic writes;
- backups;
- quarantine/recovery;
- schema migrations;
- interrupted writes;
- startup behavior;
- operator feedback;
- rollback/backward compatibility.

A migration must not turn a recoverable read failure into permanent data loss.

---

# 8. Authentication, authorization, and security

Authentication and authorization are separate concerns.

A route being authenticated does not prove the authenticated user is authorized to operate on the requested printer.

When reviewing printer-specific routes, verify both:

1. role permission;
2. printer/group visibility.

Do not assume one implies the other.

## Remote Access

Remote Access changes SnapCon's trust model substantially compared with LAN-only operation.

Remember that the Remote Access system crosses BOTH repositories documented in Section 0 (the provisioning backend's details are in `CLAUDE.local.md`).

When reviewing Remote Access:

- verify authentication boundaries;
- verify authorization;
- inspect client-IP assumptions;
- inspect proxy/tunnel behavior;
- inspect filesystem access;
- inspect secrets and tokens;
- inspect request signing;
- inspect replay protection;
- inspect rate limiting where exposure materially changes risk;
- inspect both repositories when behavior crosses the boundary.

Do not assume Cloudflare/proxy behavior that is not visible in source.

If security depends on how traffic appears at runtime, require live verification before describing the vulnerability as confirmed.

## Input boundaries

Treat data crossing trust boundaries as untrusted until validated.

This includes:

- HTTP request data;
- filenames;
- paths;
- uploaded files;
- printer-returned strings;
- external-service responses;
- values interpolated into G-code;
- values inserted into HTML;
- persisted configuration loaded from disk.

Prefer validation at the boundary plus defense-in-depth at dangerous shared sinks.

---

# 9. Performance and scaling

Optimize for realistic SnapCon deployments.

Use these approximate review points:

- ~20 printers — normal current deployment;
- ~50 printers — plausible larger farm;
- ~100 printers — scaling target worth evaluating.

Do not optimize solely for hypothetical deployments involving thousands of printers.

Before recommending significant complexity for performance:

1. identify the expensive operation;
2. explain how often it occurs;
3. explain how cost grows with fleet size;
4. determine whether the problem is observable today;
5. prefer measurement when practical.

A design may be implementation-ready while still correctly remaining in the backlog until a real trigger exists.

Do not equate theoretical efficiency with user-visible improvement.

---

# 10. Testing philosophy

Tests protect behavior, not coverage percentages.

Prioritize tests around:

- security boundaries;
- authentication;
- authorization;
- group access;
- path validation;
- queue state transitions;
- connector state normalization;
- parser behavior;
- configuration recovery;
- persistence;
- critical pure functions;
- bugs that have already occurred.

Every bug fix should receive a regression test when the behavior can reasonably be tested without major restructuring.

Before accepting a new regression test, ask:

- Would this test have failed before the fix?
- Does it exercise the real bug?
- Does it test behavior rather than implementation detail?
- Could the test pass while the bug still exists?
- Are mocks bypassing the actual failure path?

Do not restructure large portions of production code solely to increase coverage.

---

# 11. Implementation standard

When implementing an approved change:

1. Re-read current code immediately before editing.
2. Reconfirm the approved plan still matches current source.
3. Keep the patch focused.
4. Follow existing patterns where appropriate.
5. Add/update appropriate tests.
6. Run targeted tests.
7. Run the full test suite when practical.
8. Review the resulting Git diff as if another developer wrote it.
9. Trace changed values into callers and consumers.
10. Look specifically for unintended behavior changes.
11. Report exactly what changed and what was tested.

Do not hide failing tests.

Do not dismiss a failing test as unrelated without investigating why it failed.

If implementation reveals that an approved design was based on an incorrect assumption, stop and explain rather than forcing the planned implementation onto the code.

---

# 12. Git discipline

Prefer small, coherent commits.

Do not mix unrelated cleanup with functional fixes.

For significant changes, separate independently useful structural changes when that improves review or rollback safety.

Do not commit generated audits, review reports, temporary diagnostics, screenshots, or investigation artifacts unless explicitly requested.

Do not commit until explicitly requested.

---

# 13. Final self-review

Before declaring a task complete, ask:

- Did I solve the requested problem rather than a broader one?
- Did I accidentally change unrelated behavior?
- Did I verify all important callers and consumers?
- Did I introduce a new implicit contract?
- Did I preserve connector behavior?
- Did I correctly distinguish missing printer data from real values?
- Did I handle failure paths?
- Did I preserve authorization boundaries?
- Did I check the other Remote Access repository where relevant?
- Did I add the right regression test?
- Did I introduce unnecessary abstraction or dependency?
- Is there a simpler implementation?
- Does the UI follow existing SnapCon conventions?
- Would I approve this diff if somebody else submitted it?

If the answer to any of these raises a meaningful concern, investigate before declaring the task complete.
