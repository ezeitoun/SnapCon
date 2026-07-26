# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SnapCon is a local-first fleet management platform for 3D printer farms (Klipper/Moonraker-based printers — Snapmaker U1, generic Klipper — plus FlashForge and Creality via their native APIs). It's a single Node/Express server plus a hand-written, framework-free HTML/CSS/JS frontend — no bundler, no build step for the UI. It began as a fork of Danny Gimbell's U1Hub and has since diverged significantly.

## Commands

```bash
npm start                      # run the server (node server.js), serves http://localhost:4545
npm test                       # runs node --test "test/remote-access/**/*.test.js"
node --test test/remote-access/apiClient.test.js   # run a single test file
npm run build                  # pkg: builds standalone win/mac/linux binaries into dist/
```

- Tests use Node's built-in `node:test` + `node:assert/strict` — no Jest/Mocha. Only `test/remote-access/` is currently covered.
- There is no lint/format tooling configured.
- `docker compose up -d` builds and runs the container (see `docker-compose.yml`); `network_mode: host` is required for LAN auto-discovery on Linux hosts.

## Architecture

### Backend: one process, `server.js` is the hub

Everything server-side is orchestrated from `server.js` (~1900 lines). Key things to know before touching it:

- **BASE_DIR vs ASSET_DIR**: when running as a `pkg`-packaged executable, `__dirname` points into the read-only bundle snapshot. User-editable state (`config.json`, `users.json`, `gcode/`) must live next to the actual executable (`BASE_DIR`), while bundled assets (`public/`, `parser.js`) stay on `__dirname` (`ASSET_DIR`). Don't conflate the two when adding anything that reads/writes files.
- **Config is live-reloaded, not restart-required**: `CFG`/`FOLDER`/`PRINTERS` are module-level globals populated by `loadConfig()` and mutated in place by the Settings API routes (`POST /api/config`).
- **CLI notify mode**: if the process is invoked with `--load <file> --printer <name>`, the top of `server.js` handles that as a one-shot CLI call to an *already-running* instance's `/api/notify-load` and exits — it never starts Express. This is what the packaged `snapcon-win-x64.exe --load ... --printer ...` hook and the Orca "plugin" integration both use. `--snapcon <host[:port]>` targets a SnapCon instance on a different machine and streams the file's bytes rather than a path reference (the target machine can't read a path off the caller's disk).
- Every `/api/*` route goes through `auth.makeAuthMiddleware()` first, which is a no-op (implicit admin) unless `CFG.usersEnabled` is true. Routes then layer `requireAuth` / `requireRegular` / `requireAdmin` on top for actual enforcement.

### Printer connectors: the plugin boundary

`connectors/index.js` is a registry mapping a printer's `connector` config string to an implementation module. **Adding a new printer brand means adding one file to `connectors/` and one line to the `REGISTRY` map — nothing else in the app should need to change.** Each connector module exports:

- `label`, `capabilities` (a fixed set of booleans: `camera`, `filamentHeads`, `excludeObject`, `unloadFilament`, `firmwareInfo`, `inventory`, `discovery`, `webUi`, `setColor`, `singleToolhead`, …) — the UI reads `capabilities` to decide what controls to render per printer, so a connector that doesn't support something simply doesn't declare it rather than the frontend special-casing brands.
- `probe(printer)` — polls the printer and returns a normalized fleet-status shape (state, progress, temps, layer, plate/exclude-object info, etc.) regardless of brand.
- Print-control functions: `uploadFile`, `startPrintFile`, `pause`, `resume`, `cancel`, `eject`, `estop`, `bedTemp`, and brand-specific extras like `applyHeadMapping`/`unloadFilament` where the machine supports multi-toolhead filament.

`connectors/http-utils.js` holds logic shared across the several connectors that are actually Klipper/Moonraker under the hood (`snapmaker-u1-klipper`, `klipper-moonraker`, `creality-klipper` all reuse it); FlashForge's two connectors (`flashforge-adventurer`, `flashforge-ad5x`) share `flashforge-utils.js` instead since they speak a different native protocol.

### `remote-access/`: isolated subsystem, one entry point

`RemoteAccessService.js` is the *only* module `server.js` talks to for Remote Access (the managed Cloudflare Tunnel feature). It owns `RemoteAccessStore` (persistence), `SecureCredentialStore` (secrets), `CloudflaredManager` (child-process supervision of the `cloudflared` binary), `RemoteAccessApiClient` (talks to the provisioning backend), and `Ed25519Identity` (per-installation signed identity). Nothing outside this module ever touches a `child_process`, a secret, or the provisioning backend directly — the `requireAdmin` routes `server.js` registers for `/api/remote-access/*` are the entire surface the browser can reach. Requires `usersEnabled` to be on first (SnapCon refuses to expose a login-less instance to the internet). This is the one area of the codebase with real test coverage (`test/remote-access/`); `fixtures/fake-cloudflared.js` stands in for the real binary in those tests.

### `parser.js`: gcode metadata extraction

Reads a sliced gcode file's header comments to report which filament **colors** (not physical toolheads) a print needs — Snapmaker U1 gcode uses logical palette indices (`T<n>`) that the printer maps to physical heads at print start, so the parser's job is "which colors does this file need," not "which toolhead."

### Frontend: `public/`, no build step

`index.html` + `style.css` + `app.js` (~3300 lines) — hand-written, no framework, no bundler, served directly via `express.static`. Notable conventions:

- `style.css` uses a `:root` CSS custom-property token system (`--chassis`, `--panel`, `--ink*`, `--signal`, `--ok`, `--bad`, `--busy`, `--violet*`, etc. — a dark "control-room" theme with an amber accent). Prefer extending these tokens (or adding new ones + using `color-mix()` the way existing rules do) over hardcoding new hex values, since app.js also references some of them directly via inline `--status-color` custom properties.
- `statusColorText()` in `app.js` is the single source of truth for the status-badge color/label mapping, shared by both the card grid and the list-view table render paths — update it there, not per-view.
- Body classes (`body.compact`, `body.camview`, `body.listview`, `body.showfiles`) toggle the four fleet display modes and the file-browser sidebar via CSS, rather than swapping DOM structure — check existing `body.<mode>` selectors in `style.css` before adding new per-mode overrides.
- Fonts: `--mono` is self-hosted JetBrains Mono (`public/fonts/JetBrainsMono-Variable.woff2`, loaded via `@font-face`) to keep the app's local-first, no-external-request posture — don't switch this to a CDN-hosted font.

### Packaging & deployment

Three ways SnapCon ships: `npm start` from source, a `pkg`-built standalone executable per OS (see `package.json`'s `pkg` config and the BASE_DIR/ASSET_DIR split above), or Docker (`Dockerfile` + `docker-compose.yml`, config/gcode mounted as volumes). `IS_DOCKER` (checked via `/.dockerenv`) gates whether the Settings "Restart App" button is safe to expose — it only actually recovers the app when something supervises the process (Docker's `restart: unless-stopped`), not under a bare `node server.js` or the packaged binary.

### Misc

- `capture-proxy.js` is a standalone diagnostic tool (not wired into `server.js`) for capturing the raw HTTP traffic between Snapmaker Orca and a real U1 printer — run directly with `node capture-proxy.js http://<printer-ip> [port]`.
