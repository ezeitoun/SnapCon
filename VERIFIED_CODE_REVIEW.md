# SnapCon Code Review — Verified

Scope: re-verification of `CODE_REVIEW.md` (full repo, `review/baseline`
branch, commit `5c0b67e`) against the actual source. Every finding below was
re-checked by reading the exact cited lines in the current tree; the ReDoS
(C-2) and the two `http.request` protocol claims (M-7, and its `flashforge-
utils.js` sibling) were re-reproduced by executing the actual code. No
application files were modified.

## Summary

Of the 5 Critical, 5 High, 9 Medium, and 11 Low findings in `CODE_REVIEW.md`,
**one (M-6) has a materially incorrect impact claim** — the scenario it
describes is already prevented by a try/catch one layer up that the original
review didn't trace far enough to find. Every other finding checked out
against the current source, including the specific line numbers, code
snippets, and (where re-executed) timings cited. No findings were double-
counted or misattributed, and severities are all reasonable except one
borderline call noted under C-5. One new observation is added at the end.

---

## Corrections

### M-6 — Impact claim is wrong: the described failure is already caught one layer up

`CODE_REVIEW.md` is correct that `connectors/snapmaker-u1-klipper.js:259-267`
and `connectors/creality-klipper.js:127-133`'s module-level `discoverAt()`
functions have no local try/catch, unlike every connector's `probe()`. **But**
the claimed consequence — "this can abort/poison the whole scan rather than
simply skipping that one non-matching IP" — does not hold up. `server.js`
itself defines a *second*, same-named wrapper:

```js
// server.js:2024-2034
async function discoverAt(base) {
  for (const { type } of listConnectorTypes()) {
    const c = getConnector(type);
    if (!c.discoverAt) continue;
    try {
      const hit = await c.discoverAt(base);
      if (hit) return { ...hit, connector: type };
    } catch { /* try the next connector */ }
  }
  return null;
}
async function discoverIp(ip) {
  for (const port of DISCOVER_PORTS) {
    const base = port === 80 ? `http://${ip}` : `http://${ip}:${port}`;
    try {
      const hit = await discoverAt(base);
      if (hit) return { ip, ...hit };
    } catch { /* try the next port */ }
  }
  return null;
}
```

Every call into a connector's `discoverAt` is wrapped in try/catch **twice**
before it ever reaches `/api/discover`'s `Promise.all(ips.slice(i, i + B).map(discoverIp))`
(`server.js:2098`). A malformed/non-JSON response from an unrelated LAN
device makes `c.discoverAt()` throw, `server.js`'s `discoverAt()` catches it
and tries the next connector, and `discoverIp()` catches any remaining
failure and tries the next port — the offending IP is simply skipped, exactly
like every other non-matching candidate. The batch-level `Promise.all` never
sees a rejection, so the scan is not poisoned or aborted.

- **Verdict**: the code-hygiene observation (missing local try/catch,
  inconsistent with `probe()`'s convention) is real and worth fixing for
  defense-in-depth/consistency, but the finding's actual "Scenario" and
  user-facing impact are **false** — already mitigated by `server.js`'s own
  double-wrapped caller. Severity should drop from Medium to a style/
  consistency nit, not a functional bug.

---

## Findings confirmed accurate (spot-check evidence)

The following were independently re-verified. Evidence is summarized rather
than repeated in full — see `CODE_REVIEW.md` for the complete writeup of
each.

- **C-1** (Dockerfile missing `auth.js`/`connectors/`/`remote-access/`):
  confirmed — `Dockerfile:16-17` copies only `server.js parser.js` and
  `public/`; `server.js` requires all three missing paths.
- **C-2** (ReDoS in `parser.js`'s `CFG_RE`): confirmed by direct execution —
  reproduced `379ms → 713ms → 2394ms → 5656ms` for 500/1000/1500/2000-char
  inputs, matching the review's own reported numbers almost exactly. Route
  gating (`requireAuth` on `GET /api/map`) confirmed at `server.js:377`.
- **C-3** (gcode injection via unsanitized upload filename): confirmed
  end-to-end — `/api/files/upload` (`server.js:361-375`) only regex-checks
  the extension; `/api/print` (`server.js:495`) derives `name =
  path.basename(fp)` from that same unsanitized name and passes it to
  `c.startPrintFile`; all three Klipper-family connectors
  (`klipper-moonraker.js:73`, `creality-klipper.js:87`,
  `snapmaker-u1-klipper.js:118`) re-export `http.startPrintFile` unchanged,
  confirming it's the shared sink. Contrast routes' validation confirmed:
  `/api/printfile` (`server.js:574`) and `/api/exclude` (`server.js:628`)
  both reject `/["\r\n]/`; the upload route has no equivalent check.
- **C-4** (stored XSS via FlashForge `materialColor`): confirmed —
  `flashforge-utils.js:198-199` uses `t.materialColor || null` with no
  `normHex()` call, while the sibling `flashforge-ad5x.js:115-116` *does*
  wrap the same field in `normHex()` for a different code path — showing the
  omission is inconsistent, not a deliberate design choice. Sink confirmed
  unescaped at `app.js:2189` (`style="background:${n.hex||'#3a3f49'}"` inside
  an `innerHTML` template, no `esc()`), while `app.js:2311` does correctly
  call `esc(c.hex)` for a different color source, exactly as the review
  states.
- **C-5** (`cloudflared` spawn failure deadlocks Remote Access): confirmed —
  `CloudflaredManager.js:251-252` sets `running = true` right after
  `spawnFn()`, the `error` handler (`:278`) only sets `lastError` (doesn't
  reset `running`/`child`, unlike `exit` at `:270-277`), and `stop()`
  (`:291-306`) takes the wait-for-exit branch and can hang forever. One
  caveat: blast radius is confined to the admin-gated Remote Access
  subsystem (`requireAdmin`) — it does not freeze fleet management, print
  control, or the rest of the Express server the way C-2 does. Still
  Critical-worthy since recovery requires killing the whole SnapCon process,
  but readers should note it's a narrower failure mode than the other four
  Criticals, which affect broadly-reachable or whole-process-blocking paths.
- **H-1** (`Math.max(...used)` stack overflow / unbounded `paletteCount`):
  confirmed by execution — `Math.max(...set)` on a 200,000-entry `Set`
  throws `RangeError: Maximum call stack size exceeded`. The unbounded
  `T<n>` → huge `paletteCount` → unbounded loop path is confirmed by
  reading `parser.js:73-74,98,101` directly.
- **H-2** (unhandled rejection in registration poll can crash the process):
  confirmed — `RemoteAccessService.js:184-229`'s `runRegistrationPoll` only
  try/catches the `getRegistrationSessionStatus` call; the
  `completeRegistrationAndProvision` call at line 228 and the unguarded
  `Ed25519Identity.importPrivateKeyJwk` at line 251 are outside any
  try/catch. Repo-wide grep confirms no `process.on('unhandledRejection', …)`
  handler exists anywhere.
- **H-3** (Docker doesn't persist `users.json`/Remote Access data):
  confirmed — `docker-compose.yml:29-31` mounts only `config.json` and
  `gcode/`.
- **H-4** (thumbnail/snapshot fetches unbounded after headers): confirmed —
  `http-utils.js:114-120`'s `getThumbnail` and
  `snapmaker-u1-klipper.js:221-231`'s `getCameraSnapshot` both call
  `fetchTimeout` then `await r.arrayBuffer()` with no further bound, despite
  the file's own header comment (`http-utils.js:12-14`) documenting that
  `fetchTimeout` only covers time-to-headers.
- **H-5** (fleet re-render orphans in-flight upload/print DOM nodes):
  confirmed — `pushTo()`/`pollJob()` (`app.js:1895-1941`) capture `st` and
  `progressBtn` once and mutate them throughout the polling loop; the
  `visibilitychange` handler (`app.js:512`) calls `loadFleet()`
  unconditionally, with no `PUSHES` guard, unlike the auto-refresh timer
  (`app.js:4218`) which explicitly checks `PUSHES>0`.
- **M-1** (`safePath` prefix-boundary bypass): confirmed — `server.js:235`
  (`p.startsWith(FOLDER)`) and the duplicated inline checks at `:326`
  (mkdir) and `:370` (upload) all share the same non-boundary-respecting
  pattern.
- **M-2** (2GB unbounded raw-body buffering): confirmed —
  `server.js:198`: `express.raw({ type: "application/octet-stream", limit:
  "2gb" })`, used by both `/api/files/upload` and `/api/notify-load`.
- **M-3** (non-atomic writes for Remote Access secrets/config): confirmed —
  `RemoteAccessStore.js:57` and both `SecureCredentialStore.js` paths
  (DPAPI `:194`, insecure-fallback `:244`) call `fs.writeFileSync` directly
  on the final path, unlike `CloudflaredManager.js:117-118`'s
  `.part` + `renameSync` pattern.
- **M-4** (full-binary re-hash blocks the event loop): confirmed —
  `CloudflaredManager.js:147-150`'s `ensureInstalled()` does synchronous
  `fs.readFileSync(finalPath)` + `sha256()` on every call, and is awaited
  directly from `RemoteAccessService.js:295` and `:553` (`enable()`'s
  `startTunnelProcess` and `startupInit()`'s equivalent).
- **M-5** (AD5X `pendingMapping` keyed only by URL): confirmed —
  `flashforge-ad5x.js:81` (`pendingMapping = new Map(); // p.url -> {...}`)
  and `:89-91` read-and-delete without checking the mapping matches the file
  being started.
- **M-7** (upload path hardcodes `http`, breaks TLS-fronted printers):
  confirmed by execution — `http.request({ protocol: 'https:', ... })`
  throws synchronously (`Protocol "https:" not supported. Expected
  "http:"`), matching both `http-utils.js:54-55` and the equivalent in
  `flashforge-utils.js:218-219`.
- **M-8** (combinatorial color-mapping search unbounded on `n`): confirmed —
  `app.js:1216` (`k=Math.min(n,m)`) caps `m` (heads) at whatever's loaded but
  not `n` (needed colors), so `choose(cIdxs,k)` at `app.js:1227` scales as
  `C(n,k)` with no ceiling on `n`.
- **M-9** (Docker ignores lockfile): confirmed — `Dockerfile:10-12` copies
  only `package.json` and runs `npm install`, not `npm ci`;
  `package-lock.json` is in `.dockerignore`.
- **L-1** through **L-11**: spot-checked a representative sample —
  `auth.js:1458-1464`'s login timing gap (L-1), the plain `!==` OTP
  comparison at `auth.js:100` (L-2), the hardcoded `ws://` at
  `snapmaker-u1-klipper.js:188` (L-3), `flashforge-utils.js:177`'s
  `size: null, modified: null` (L-4), the unbounded `stdoutBuf`/`stderrBuf`
  in `CloudflaredManager.js:255-269` (L-5), `rotateTunnelToken`/
  `getHubStatus` defined in `RemoteAccessApiClient.js:238,251` but never
  referenced in `RemoteAccessService.js` (L-6), `refreshPlate()`
  (`app.js:2863-2873`) polling every 3s with no in-flight/sequence guard
  (L-7), `capture-proxy.js:13,88,130` using `http.request` unconditionally
  (L-10), and `parser.js`'s uncapped `cfg`/`hist` objects (L-11) — all
  confirmed as described. `docker-compose.yml`'s missing-file-becomes-a-
  directory behavior (L-8) and the release-workflow version check (L-9) are
  standard, well-known Docker/CI behaviors and match the cited files.

---

## New observation

### N-1. `/api/notify-load`'s loopback path is a documented, intentional trust boundary — not a new bug, but worth flagging as a boundary to keep an eye on

`server.js:814-834`: the JSON-body branch of `/api/notify-load` (used by the
same-machine `--load` CLI hook) accepts an arbitrary absolute filesystem
`file` path once `isLoopback(req)` passes, deliberately bypassing the
`gcodeFolder` jail (`safePath`) that constrains every other file-reading
route. This is already called out in `CODE_REVIEW.md`'s own architecture
summary as trust boundary (4), and `isLoopback()`'s check
(`ip === "127.0.0.1" || "::1" || "::ffff:127.0.0.1"`) is a reasonable,
narrowly-scoped gate for a same-machine CLI integration — this is not a new
finding, just confirmation that the boundary is exactly as documented, with
no gap beyond what the review already described. No action needed beyond
what's already noted in the architecture summary.

---

## Net effect on `CODE_REVIEW.md`

- Downgrade **M-6** from "Medium — can abort/poison a subnet scan" to a minor
  code-hygiene/consistency note: the missing local try/catch in
  `discoverAt()` should still be fixed for defense-in-depth, but the
  scenario as written (a bad LAN device aborting the whole scan) does not
  occur — `server.js`'s `discoverAt()`/`discoverIp()` wrappers already catch
  it per-candidate.
- Note the narrower blast radius of **C-5** relative to the other four
  Critical findings (confined to the Remote Access subsystem, not the whole
  server) as a severity caveat, not a reason to fully downgrade it.
- All other findings (C-1–C-4, H-1–H-5, M-1–M-5, M-7–M-9, L-1–L-11) are
  confirmed accurate as originally described, with no changes to severity or
  scope.
