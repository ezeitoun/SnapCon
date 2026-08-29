# FlashForge dual-transport connectors — design

**Status:** implemented; camera clause corrected against hardware (§6)
**Date:** 2026-08-28, camera correction 2026-08-29
**Scope:** FlashForge connectors only (`flashforge-ad5x`, `flashforge-adventurer`)

---

## 1. Problem

FlashForge printers can run stock firmware or a third-party firmware mod. The two
expose completely different network interfaces:

| Firmware | Transport | Port |
|---|---|---|
| FlashForge stock | native FlashForge JSON API | 8898 |
| ZMOD (`ghzserg/zmod`, `ghzserg/z_ad5x`) | Moonraker | 7125 |
| Forge-X (`DrA1ex/ff5m`) | Moonraker | 7125 |

Both mods take port 8898 down. SnapCon's two FlashForge connectors declare
`address = { defaultPort: 8898, portEditable: false }`, so a modded printer is
unreachable and shows permanently offline with no field the user can change.

This was not hypothetical when the design was written — the fleet's `5M PRO`
(`flashforge-adventurer`) was offline with
`Could not reach 5M PRO: fetch failed` because 8898 was closed.

### The axis is transport, not vendor mod

ZMOD supports FF5M / FF5M Pro **and** AD5X, so this affects both connectors, not
just the AD5X one. Forge-X is a second, unrelated mod reaching the same endpoint.
Designing against "ZMOD" specifically would leave Forge-X printers broken; the
real distinction is **native API vs Moonraker**, with mod-specific enrichment
layered on only where live evidence supports it.

---

## 2. Evidence

All findings below were captured live on 2026-08-28 by read-only HTTP GETs
against idle printers. Re-verify before relying on any of it.

### Printers observed

| Host | Model | Firmware | Ports observed |
|---|---|---|---|
| `printer-ad5x-a` | AD5X | ZMOD `1.7.1-53` (`ghzserg/z_ad5x`, branch 1.7), stock `AD5X 3.0.3` | 80, 7125 |
| `printer-adventurer-a` | 5M Pro | Forge-X `1.4.1-25` (`DrA1ex/ff5m`, `580843c @ 26.08.2026`) | 80, 7125 |
| `printer-adventurer-b` | 5M Pro | Forge-X `1.4.1-0` (`DrA1ex/ff5m`, `02951bf @ 18.02.2026`) | 7125, **later** 8898 |

`printer-adventurer-a` and `printer-adventurer-b` are distinct printers (different Forge-X builds), not a DHCP
reassignment.

### Identification markers

`GET /machine/system_info` → `distribution` is the cleanest discriminator:

```
ZMOD    name: "zmod 1.7.0 -> 1.7.1-53"   codename: "AD5X 3.0.3"
Forge-X name: "Forge-X 1.4.1"            codename: "FF5M 3.1.5 / 1.4.1-main-…"
```

`GET /machine/update/status` names the repo (`ghzserg/z_ad5x`, `DrA1ex/ff5m`).

### The observed transport flip — why invalidation is mandatory

`printer-adventurer-b` was seen with **Moonraker up / 8898 closed**, and later in the same session
with **8898 open / Moonraker closed**. The intermediate `online: true, standby`
reading came from a genuine live probe, not a cache: `probeCached`
(`server.js:1511-1519`) stores only *offline* results
(`if (result.online) offlineCache.delete(...)`).

The cause was not observed and is not claimed here. What matters for the design
is that a single printer presented **both transports within one session**. Cache
invalidation and anti-flap behavior are therefore **required, not optional**.

### AD5X IFS (ZMOD)

```
zmod_ifs_switch_sensor _ifs_port_sensor_1..4  → filament_detected: true,true,false,false
gcode_macro _IFS_VARS                          → current_tool: -1  (idle)
                                                 tools:  [2,1,3,4]   (tool -> slot)
                                                 colors: ["FFFF00","",…]  (tool-indexed)
config/Adventurer5M.json → FFMInfo.ffmColor1..4 / ffmType1..4  (slot-indexed)
```

**Gotcha:** these objects appear in `objects/list` under both
`filament_switch_sensor _ifs_port_sensor_N` and
`zmod_ifs_switch_sensor _ifs_port_sensor_N`, but **only the
`zmod_ifs_switch_sensor` prefix returns data**. Querying the intuitive name
yields an empty status block and silently zero slots.

**Index semantics, cross-checked:** `tools[0] = 2` with `colors[0] = "FFFF00"`
(yellow) and `ffmColor2 = "#FFEB3B"` (yellow). Therefore `colors[]` is
**tool-indexed**, `tools[]` maps tool → slot, and `ffmColorN` is **slot-indexed**.

### Multi-color start interface (ZMOD `lesswaste.cfg`)

```
_IFS_COLORS_ASSIGN TOOL=<n> PORT=<slot>   → writes _IFS_VARS.tools[]
_IFS_COLORS_PRINT                          → BASE_SDCARD_PRINT_FILE FILENAME="…"
```

Two separate calls, which maps onto SnapCon's
`applyHeadMapping()` → `startPrintFile()` interface directly.

### Adventurer / Forge-X

Object list contains only `filament_switch_sensor e0_sensor` / `e1_sensor` on
**both** Forge-X boxes. No IFS objects, no `extruderN`. `exclude_object` **is**
loaded and queryable. `fan` returns `{}` (empty) — `fanPct` resolves to `null`
through the existing `typeof fan.speed === "number"` guard.

### Webcam configuration — three different shapes

| Printer | `/server/webcams/list` |
|---|---|
| `printer-ad5x-a` ZMOD | 1 entry, `enabled: true`, `stream_url: "/webcam/?action=stream"` — **relative**, on the printer |
| `printer-adventurer-b` Forge-X | 1 entry `"Example"`, `enabled: false`, `http://your_IP:8080/…` — placeholder |
| `printer-adventurer-a` Forge-X | disabled `"Example"` placeholder **plus** `"FF Purple"`, `enabled: true`, `snapshot_url: "http://advertised-foreign-host/webcam/?action=snapshot"` |

`printer-adventurer-a`'s enabled entry points at a **different host on a different subnet** which
does not resolve (`Destination host unreachable`) — stale operator config. But
the printer **does** serve a real camera at that same path on itself: rebuilding
the URL onto `printer-adventurer-a` returns HTTP 200, `image/jpeg`, 76,837 bytes (confirmed
live). Both halves matter: the supplied host must never be contacted, *and* the
entry must not be discarded because of it. This drives the security invariant in
§6.

---

## 3. Scope

### In scope

- `connectors/flashforge-ad5x.js` — mode dispatch, IFS semantics, multi-color
- `connectors/flashforge-adventurer.js` — mode dispatch
- `connectors/flashforge-mode.js` — **new**, transport detection + cache
- `connectors/flashforge-moonraker.js` — **new**, Moonraker transport helper
- `server.js` — one line in the printer config allowlist
- `public/app.js`, `public/style.css`, `locales-default/*.json` — the transport
  override control in Settings
- `test/connectors/` — new and regression tests

### Not in scope

`klipper-moonraker.js`, `creality-klipper.js`, all `snapmaker-*` connectors,
`http-utils.js` (reused unchanged), `flashforge-utils.js` (native path
unchanged). No changes to the connector registry, no new connector types, no
config migration.

### Non-goals

- Supporting mods other than ZMOD and Forge-X by name. Detection is by
  transport, so other Moonraker-based mods work incidentally but are untested.
- Feature parity between native and Moonraker mode. Each mode reports what its
  transport actually supports (CLAUDE.md §3).

---

## 4. Architecture

Four modules with strict, non-overlapping responsibilities.

```
flashforge-ad5x.js ───────┐                      ┌── flashforge-utils.js    (native :8898)
                          ├── flashforge-mode.js ┤
flashforge-adventurer.js ─┘   (which transport?) └── flashforge-moonraker.js (Moonraker :7125)
```

| Module | Owns | Must NOT own |
|---|---|---|
| `flashforge-mode.js` | the detection **state machine**: cache state, invalidation, re-probe, anti-flap, transition logging | model semantics, capabilities, IFS, print behavior, transport operations |
| `flashforge-moonraker.js` | Moonraker base URL, common probe, config-file reads, macro dispatch, camera URL resolution | mode detection, FlashForge model semantics, IFS knowledge |
| `flashforge-ad5x.js` | AD5X semantics: IFS slots, `heads[]`, multi-color mapping, per-mode capabilities | the detection state machine |
| `flashforge-adventurer.js` | 5M/5M Pro semantics, per-mode capabilities | the detection state machine |
| `flashforge-utils.js` | native 8898 transport (**unchanged**) | anything Moonraker |

The detection state machine lives in exactly one place. Both model connectors
call it; neither reimplements it.

### `flashforge-mode.js` performs no I/O of its own

To keep it free of transport knowledge, it never calls `flashforge-utils` or
`flashforge-moonraker`. The **caller supplies both liveness probes as thunks**:

```js
mode.resolve(p, {
  native:    () => ff.ffPost(p, "/detail", {}, 3500),
  moonraker: () => fm.ping(p, 3500)
})  // -> "native" | "moonraker" | null
```

`flashforge-mode.js` decides *which* to trust and *when* to re-decide. It never
knows what a FlashForge or a Moonraker request looks like.

`detect()` is the same call returning `{ mode, nativeError, moonrakerError }`;
`resolve()` is a thin wrapper over it. Connectors use `detect()` so a failed
detection can surface the transport's own message: FlashForge reports real,
user-actionable auth failures ("SN is different", "Lan mode error"), and
replacing those with a generic "could not reach" would hide the one thing that
tells the user what to fix.

`resolve()` **short-circuits before touching either thunk** when the printer is
pinned (`p.transport` is `"native"` or `"moonraker"`) or when a valid cached
entry already covers `p.url`. Thunks are invoked only when a detection genuinely
has to happen — which is what makes "a pin fires no liveness probes" (§5) an
enforced property of this one function rather than a rule every caller has to
remember.

### Opaque profile storage

`getCapabilities` is synchronous (§6) and needs post-detection facts — the
resolved camera URL, IFS presence, and ZMOD version.

**Who does what** (the table above assigns camera URL resolution to
`flashforge-moonraker.js`, and capability decisions to the model connector —
these are different jobs and must not be conflated):

- `flashforge-moonraker.resolveWebcam(p)` performs the **mechanics**: read
  `/server/webcams/list`, drop disabled entries, discard the printer-supplied
  host, rebuild against the configured host. It returns a safe URL or `null`. It
  makes no capability decision.
- The **model connector** calls it, decides what that means for
  `camera` / `cameraSnapshot`, gathers IFS presence and ZMOD version, assembles
  the capability set, and stores the whole thing as an opaque blob.

```js
mode.setProfile(p.id, profileObject)   // stored verbatim, never inspected
mode.getProfile(p.id)                  // -> the same object, or undefined
```

```js
mode.setProfile(p.id, profileObject)   // stored verbatim, never inspected
mode.getProfile(p.id)                  // -> the same object, or undefined
```

`flashforge-mode.js` treats the profile as bytes: it stores it and returns it,
never interpreting anything inside. Storage is not ownership.

**Profile lifetime is deliberately not the same as mode lifetime.** Invalidating
the mode means "re-detect", not "forget everything":

- **Mode invalidated** (3 failures, §5) → the profile is **retained** and still
  served by `getProfile`. This is what makes capabilities sticky while a printer
  is offline, so its controls do not reshuffle on every blip.
- **A different mode is resolved** → the profile is **discarded** at that moment,
  because every fact in it was derived from the old transport. The model
  connector writes a fresh one during post-detection enrichment (§5 step 4).
- **`p.url` changed** → discarded immediately. A new address may be a different
  machine entirely, so nothing derived from the old one may carry over.

---

## 5. Detection and caching

### Config field

New optional printer field `transport`: `"auto"` (default when absent) |
`"native"` | `"moonraker"`.

Persisting it requires one line in the printer allowlist in `server.js`
(~line 2779, beside the existing `if (p.filamentMode === "cfs")`):

```js
if (p.transport === "native" || p.transport === "moonraker") o.transport = p.transport;
```

Absent means auto. Existing `config.json` entries are untouched.

### Cache

Module-level `Map` in `flashforge-mode.js`, keyed by `p.id` — the stable
generated id (`server.js:126` `newPrinterId()`, preserved across edits at
`server.js:2785`). **Not** the `id: i` array index used in API responses, and
**not** `p.url`.

```js
// p.id -> { mode, url, ts, fails, pendingMode, pendingCount, profile }
```

`profile` is the opaque blob described in §4 — written by the model connector and
never inspected here. Its lifetime is **not** tied to the mode's: see §4 and
§12.2 for why a failure retains it while a mode change or address change
discards it.

`url` is stored in the entry so an address edit invalidates by comparison.
In-memory only — nothing is written to `config.json`, so there is no new
persistence failure mode and no migration (CLAUDE.md §7).

### Detection algorithm

When `p.transport` is auto and the entry is missing or `entry.url !== p.url`:

1. Fire **both caller-supplied probe thunks in parallel** (§4), each bounded at
   3500 ms (the existing probe budget). The model connector supplies:
   - native — `ff.ffPost(p, "/detail")` via `ff.baseUrl(p)` (appends `:8898`)
   - moonraker — `GET /printer/info` via `fm.baseUrl(p)` (appends `:7125`)
2. **Both answer → native wins.** Deliberate: preserves current behavior for any
   printer still speaking 8898, so no working printer can be rerouted by this
   change.
3. Neither answers → **cache nothing**, return the normal offline shape. Not
   caching a failure prevents a transient outage from pinning a wrong mode.
4. On a resolved mode, the **model connector** performs its own post-detection
   enrichment (webcam resolution per §6, IFS object presence per §7, ZMOD
   version per §8), builds its capability set, and stores it via
   `mode.setProfile(p.id, …)`. `flashforge-mode.js` takes no part in this
   beyond holding the result.

Parallel is a correctness requirement, not style: an offline printer must cost
~3.5 s, not 7 s (CLAUDE.md §6).

### Manual override versus auto-detection

`transport: "native" | "moonraker"` is a **pin**, not a hint. When set:

- **Detection never runs.** No liveness probes are fired for mode purposes at
  all — not on first use, not after failures, not ever while the pin stands.
- **There is no fallback to the other transport.** A pinned printer whose
  transport is unreachable reports offline with the normal error shape (§9). It
  does **not** silently try the other port. Silently overriding an explicit user
  choice would make the setting meaningless and would hide a real
  misconfiguration behind a working-looking printer.
- **Anti-flap and the failure counter do not apply** — there is no mode to flap
  between and nothing to invalidate. Repeated failures are just failures.
- **Post-detection enrichment still runs** (§5 step 4) on first successful
  contact, so a pinned printer gets correct per-mode capabilities. The resulting
  profile is discarded on a `p.url` change, exactly as in auto mode.
- **Changing the pin** (including switching back to `auto`) discards the cache
  entry and profile for that printer immediately; auto mode then re-detects on
  the next probe.

E-Stop's cross-transport retry (§9) is the single exception that still applies
under a pin — deliberately, because an emergency stop must not be lost to a
stale or mistaken setting.

### Invalidation

- **Address edited** (`entry.url !== p.url`) → re-detect on next probe, and
  discard the profile immediately (§4 — a new address may be a different
  machine).
- **Active transport fails 3 consecutive probes** → invalidate the mode →
  re-detect on next probe, **retaining the profile** (§4) so capabilities stay
  stable while the printer is unreachable. Three, not one, so a single timeout
  does not trigger a fleet-wide detection storm.
- Any success resets `fails` to 0.

### Anti-flap

Required by the observed `printer-adventurer-b` transport flip (§2).

- **Hysteresis on change.** A re-detection may only *change* an established
  mode if the new transport succeeds on **2 consecutive** detections
  (`pendingMode` / `pendingCount`). One success on the other port re-detects but
  does not switch.
- **The native tie-break feeds hysteresis, it does not bypass it.** Step 2's
  "both answer → native wins" decides what a *single* detection concluded. On a
  printer already established as Moonraker, two consecutive such detections are
  still required before the mode actually changes. The tie-break is only
  unconditional on **first** detection, where there is no established mode to
  protect.
- **Sticky capabilities while offline.** Keep serving the last known mode's
  capabilities rather than reverting to static native, so a Moonraker printer's
  controls do not reshuffle on every blip.
- **Log transitions**: `[FlashForge] <name> transport native → moonraker`,
  following `snapmaker-u1-klipper-ws.js`'s WS/HTTP fallback logging. A
  repeatedly-flipping box must be visible in logs, not silently absorbed.

### AD5X vs Adventurer

Detection is identical. `flashforge-ad5x.js` additionally records IFS presence
(§7) so capabilities can report `filamentHeads` honestly; `flashforge-adventurer.js`
has no such step.

---

## 6. Capabilities per mode and model

### Synchronous constraint

`server.js:1770` and `:1780` call `getCapabilities(p.connector, p)`
**synchronously** while building each fleet row. Detection is async, so
`getCapabilities` cannot await it. It reads the cache synchronously and returns,
in priority order:

1. explicit `p.transport` → that mode's capabilities
2. `mode.getProfile(p.id)` → the capability set the model connector stored
   after detection (§4, §5 step 4)
3. no profile → the existing static `exports.capabilities` (native)

**Accepted behavior change:** immediately after a SnapCon restart, a
Moonraker-mode printer's first fleet render shows native capabilities, corrected
on the next poll (rows recompute capabilities every poll). Brief and
self-correcting, but real.

### Camera trust boundary — security invariant

`snapshot_url` / `stream_url` from `/server/webcams/list` are
**printer-returned strings crossing a trust boundary** and are untrusted input
(CLAUDE.md §8). `printer-adventurer-a` proves the practical risk: an `enabled: true` entry
pointing at an unrelated, unreachable host on another subnet.

Fetching such a URL server-side would make SnapCon an SSRF proxy — anything able
to write a printer's Moonraker webcam database could make the SnapCon host issue
GETs to arbitrary internal addresses — and would add a dead-host timeout to every
camera poll across the fleet.

**The invariant, in one line:** *the printer may supply the camera's path and
query, but it never gets to choose the host SnapCon contacts.*

**Clauses — all required:**

1. Entries with `enabled: false` are ignored entirely.
2. A supplied URL is parsed **only** to obtain its `pathname` and `search`.
3. Any supplied host, scheme, credentials and port are **discarded**. The
   candidate is rebuilt against the printer's own configured host, following
   `creality-klipper.js`'s `detectCamera()` — including its multi-port
   candidates (the standard web port, the printer's own configured port, and
   MJPG-Streamer's 8080), since a camera proxy does not necessarily sit on the
   same port as Moonraker.
4. An otherwise usable entry is **never rejected merely because its supplied
   host differs** from the printer's. Rejecting it would disable a working
   camera — see the `printer-adventurer-a` hardware evidence below.
5. `camera` / `cameraSnapshot` are advertised **only after the rebuilt candidate
   is verified** to return a real image response (2xx **and** an `image/*`
   content type — a 200 `text/html` is Fluidd's SPA answering an unknown path,
   not a camera). On failure, try the next eligible candidate; if none verify,
   report `camera: false`.
6. The printer-supplied host **never receives a request** — not during
   discovery, verification, snapshot retrieval, redirects, or fallback.
7. **Redirects are manual, validated per hop, same-host only, and bounded.**
   Validating only the initial URL is insufficient — Node's `fetch` defaults to
   `redirect: "follow"`, so a same-host URL returning `302` to another host
   would be followed silently. There is currently **no redirect handling
   anywhere** in `connectors/` or `server.js`, so all of the following must be
   added explicitly, not assumed:

   - the camera fetch uses **`redirect: "manual"`** — never automatic following;
   - **every** redirect target is validated **before** it is followed, applying
     the same host rule as clause 3;
   - a target is followed **only** if it resolves back to the printer's
     configured host;
   - **any** cross-host redirect target ends the attempt — it is not followed,
     and the camera path fails per clause 5;
   - at most **3** redirects are followed. The 4th ends the attempt. The budget
     is independent of the host rule, so a printer redirecting to *itself*
     indefinitely — which passes the host check on every hop — still terminates
     on the count rather than hanging the poll.

**Follow the existing pattern.** `creality-klipper.js:546-563` (`detectCamera`)
already solves clauses 2–3 and the verification in clause 5: it takes only
`u.pathname` and `u.search` from the printer-supplied URL, **discards the host**,
rebuilds against `new URL(http.baseUrl(p)).hostname` over several candidate
ports, and takes the first that returns a real image. Reuse that approach rather
than inventing a new URL-sanitization abstraction (CLAUDE.md §1). Clauses 1 and
7 are the additions on top of it, and they live in the FlashForge camera path —
the Creality implementation is not modified (§13).

**Applying the invariant — corrected against hardware.** An earlier draft of
this section said a cross-host entry yields `camera: false`, and predicted
`printer-adventurer-a → camera: false`. **That prediction was falsified.** `printer-adventurer-a` advertises
`http://advertised-foreign-host/webcam/?action=snapshot` — a host that does not resolve —
while serving a genuine 76,837-byte JPEG at that same path **on itself**.
Rejecting the entry for its host would have disabled a camera that demonstrably
works, and the security position is identical either way because the foreign
host is never contacted. Rebuild-then-verify is therefore both safer and
strictly more useful than reject-on-host. Verified end to end:

```
advertised : http://advertised-foreign-host/webcam/?action=snapshot
rebuilt    : http://printer-adventurer-a/webcam/?action=snapshot
verified   : HTTP 200, image/jpeg, 76,837 bytes -> camera: true
```

`printer-ad5x-a` → `camera: true`. `printer-adventurer-b` → `camera: false` (its only entry is a disabled
placeholder). `printer-adventurer-a` → `camera: true`, by evidence rather than assumption.

### Matrix

| Capability | AD5X native | AD5X Moonraker | Adv native | Adv Moonraker |
|---|---|---|---|---|
| `camera` / `cameraSnapshot` | true | **derived + verified** (true on `printer-ad5x-a`) | true | **derived + verified** (true on `printer-adventurer-a`, false on `printer-adventurer-b`) |
| `filamentHeads` | true | **derived** — live `zmod_ifs_*` objects | false | **derived** — false on all observed hardware (§7) |
| `headMapping` | true | ⚠️ gate — **false** until print-start is verified (§8, §11 #1) | false | false |
| `setColor` | true | ⚠️ gate | false | false |
| `unloadFilament` | true | ⚠️ gate | false | ⚠️ gate |
| `excludeObject` | false | **true** | false | **true** — confirmed on Forge-X |
| `firmwareInfo` | false | **true** | false | **true** |
| `health` | — | **true** | — | **true** |
| `fileSync` | — | **true** | — | **true** |
| `webUi` | false | **true** — Fluidd on :80 | false | **true** |
| `autoLevel` | false | ⚠️ gate | false | ⚠️ gate |
| `singleToolhead` | true | true | true | true |
| `maxBedTemp` | 110 | 110 | 110 | 110 |

⚠️ = ships **false** until confirmed on hardware (§11). An unverified capability
ships off (CLAUDE.md §2).

**derived** = computed at detection time from live evidence and stored in the
profile (§5 step 4), never hardcoded from the model or connector type. A bare
`true`/`false` in a Moonraker column is a fixed property of that transport, not
an observation — e.g. `headMapping: false` for Adventurer, because no
mapping macro path exists for that model in either mode (§8).

### Reuse `http.queryFirmwareInfo` — do not add parallel version logic

`http-utils.js:327-374` already reads `/printer/info`, `/machine/system_info`
and the MCU list, and emits `os: dist.name + " · kernel " + dist.kernel_version`
— yielding `"Forge-X 1.4.1 · kernel 5.4.61"` and
`"zmod 1.7.0 -> 1.7.1-53 · kernel 5.10.186+"` with **no new code**.

`klipper: info.software_version` reports `"?"` on both mods. That is the
printer's own answer and must be surfaced as-is, not replaced with a
better-looking guess (CLAUDE.md §2). `product_info` is absent on both, so
`machine` / `firmware` / `software` are `null` — absence of data is valid state.

---

## 7. Probe and `heads[]` mapping

### `flashforge-moonraker.js` — transport helper

```js
baseUrl(p)                       // p.url, appending :7125 when no explicit port
ping(p, ms)                      // liveness; requires a real Moonraker `result`
probeCommon(p, extra, ms)        // one Moonraker query -> normalized status shape
listObjects(p)                   // live object list, read once at detection
readConfigJson(p, name, ttlMs)   // GET /server/files/config/<name>, TTL-cached
sendMacro(p, script, ms)         // via http-utils' shared gcode sink
resolveWebcam(p)                 // §6 invariant: rebuild, verify, or null
fetchSnapshot(p, url, ms)        // host-locked, redirect-manual, 3-hop bounded
onPrinterHost(p, raw, port)      // path+query only, rebuilt on the printer
```

**Control operations are dispatched in the model connectors**, not re-exported
here: each of `uploadFile` / `pause` / `resume` / `cancel` / `eject` / `bedTemp`
/ `startPrintFile` / `listFiles` / `getThumbnail` / `getFileMetadata` /
`getCameraSnapshot` routes to `flashforge-utils` (native) or `http-utils`
(Moonraker) through a `byMode()` helper. This is not optional polish: a modded
printer has **:8898 closed**, so a control call left on the native path does not
degrade — it fails outright. The Moonraker-only capabilities the matrix
advertises (`getPlate`, `excludeObject`, `getHealth`, `getFirmwareInfo`,
`querySyncFiles`, `downloadSyncFile`, `deleteSyncFile`) are exported too, since
advertising a capability with no function behind it makes the UI offer a control
the backend then refuses.

`baseUrl` must be its own function. `http.baseUrl` (`http-utils.js:11`) is
`String(p.url)` verbatim and appends nothing; a FlashForge printer stored as
`http://printer-adventurer-b` (exactly how they are stored today) would resolve to port
80 and hit Fluidd instead of Moonraker. This mirrors `ff.baseUrl`
(`flashforge-utils.js:22`), which appends `:8898` the same way.

`probeCommon` returns the same normalized shape `klipper-moonraker.js`'s
`probe()` builds, and deliberately contains **no** `heads`, no IFS, and no
FlashForge model specifics.

### AD5X Moonraker probe — in `flashforge-ad5x.js`

```
/printer/objects/query?print_stats&display_status&virtual_sdcard&heater_bed
  &extruder&fan&gcode_move&toolhead&exclude_object
  &gcode_macro%20_IFS_VARS
  &zmod_ifs_switch_sensor%20_ifs_port_sensor_1..4
```

Colors from `readConfigJson(p, "Adventurer5M.json", 30_000)` → `FFMInfo`.

**The IFS portion of this query is conditional on detected evidence.** An AD5X
is not guaranteed to expose `zmod_ifs_*` — it may run a mod without the IFS
module, a ZMOD build older than the floor in §8, or a future variant. When the
profile records no IFS (§5 step 4):

- the `zmod_ifs_switch_sensor` terms and the `Adventurer5M.json` read are
  **omitted** — no wasted request per poll;
- `heads` is `[]` and `filamentHeads` is `false`;
- `activeExt` is `null`.

Absent IFS objects are a **valid state**, not an error: Moonraker returns an
empty status block for an unknown object rather than failing the whole query
(confirmed live — querying `filament_switch_sensor _ifs_port_sensor_1`, the
wrong prefix, returned empty rather than erroring). So a mis-detection degrades
to "no slots", never to a fabricated or partially-populated `heads[]`
(CLAUDE.md §2).

`heads[i]`, i = 0..3, slot = i+1 — producing the **identical shape** the native
path already produces (`flashforge-ad5x.js:53-64`):

```js
loaded   = zmod_ifs_switch_sensor _ifs_port_sensor_{slot}.filament_detected
hex      = loaded ? normHex(FFMInfo["ffmColor" + slot]) || null : null
material = loaded ? (FFMInfo["ffmType" + slot] || null)         : null
sub: null, official: false
```

**Presence gates color, never the reverse.** `ffmColorN` persists after a spool
is removed — `printer-ad5x-a` currently has `ffmColor3`/`ffmColor4` set while
`_ifs_port_sensor_3`/`_4` read `filament_detected: false`. Rendering those would
violate CLAUDE.md §5 ("never render a spool graphic merely because the toolhead
exists"). This matches native, where `hasFilament` gates the same fields.

**Semantic note:** native reads colors from live `/detail`; Moonraker reads them
from a config file with a 30 s TTL. Both are stored slot metadata — equivalent
semantics, different staleness. The TTL exists for CLAUDE.md §9: at 100 printers
an untimed second request per poll would double Moonraker load for data that
changes on the order of days.

### `activeExt` — a real mapping difference

- Native: `matlStationInfo.currentSlot - 1` — a **slot** index.
- Moonraker: `_IFS_VARS.current_tool` is a **tool** index (`-1` when idle), and
  `_IFS_VARS.tools[]` maps tool → slot.

So `activeExt = tools[current_tool] - 1`, not `current_tool`. Passing
`current_tool` straight through mislabels the active slot whenever the mapping
is not identity — and on `printer-ad5x-a` it is not (`tools: [2,1,3,4]`). See §11.

### IFS detection must stay evidence-based

`filamentHeads` is derived from the **live presence of `zmod_ifs_*` objects**,
never from the model, the connector type, or a filename.

`Adventurer5M.json` exists on **both** models under **both** mods — `printer-adventurer-a` has it
alongside `ad5m.json` and `guider3Ultra.json` — but only the AD5X's contains an
`FFMInfo` block (`printer-adventurer-a`'s starts at `cameraInfo`). **File existence is not a model
or IFS signal** and must never be used as one.

### Adventurer Moonraker probe

`probeCommon` + `heads: []`. No per-poll IFS query, no `Adventurer5M.json` read —
one request per poll, same cost as native.

**`heads: []` here is an evidence-backed conclusion, not a model assumption.**
Both Forge-X boxes were checked and expose only `filament_switch_sensor
e0_sensor` / `e1_sensor` — no per-slot objects of any kind (§2). The conclusion
is recorded where evidence is actually gathered:

- **`objects/list` is read once at detection**, not per poll, and the presence of
  per-slot objects is stored in the profile (§5 step 4). This is the same single
  read `flashforge-ad5x.js` already performs to decide `filamentHeads`, so it
  costs one request per detection on both connectors, not one per poll.
- `filamentHeads` is reported from that stored evidence. On every machine
  observed it resolves to `false` — which is why §6's Adventurer column reads
  `false` rather than "derived": that is the observed outcome, not a shortcut.
- If a 5M-family machine ever does expose per-slot objects, the detection-time
  check sees them and `filamentHeads` becomes true without a code change. What
  would then need writing is the `heads[]` mapping itself — and that must be
  built against that machine's real objects, never generalized from the AD5X's
  `zmod_ifs_*` shape.

What is explicitly forbidden either way: inferring heads from the model name,
the connector type, or the presence of `Adventurer5M.json` / `ad5m.json` (§7,
"IFS detection must stay evidence-based").

---

## 8. Multi-color start

The native path is **untouched** — `pendingMapping`, its TTL stash, and
`issuePrintAndConfirm` (`flashforge-ad5x.js:87-131`) all stay as they are.

### Moonraker path

```js
applyHeadMapping(p, tools, map)   // per tool: _IFS_COLORS_ASSIGN TOOL=<t> PORT=<slot> DIALOG=0
startPrintFile(p, filename)       // GATED — see below. Not implemented until verified.
```

**No `pendingMapping` stash in Moonraker mode.** That stash exists only because
FlashForge's `/printGcode` bundles mapping into the print-start request. ZMOD
does not, so the workaround is not carried over — which also removes the
5-minute TTL leak window on this path.

### Print-start is a hard gate, not a runtime fallback

An earlier draft proposed "try `SDCARD_PRINT_FILE`, fall back to
`BASE_SDCARD_PRINT_FILE` if it prompts." **That approach is rejected.**

The failure mode it is supposed to handle is a touchscreen confirmation dialog
that blocks an unattended start. A runtime fallback can only detect that by
*observing the print fail to start* — which means the discovery mechanism is a
hung queue job on real hardware, possibly overnight. A guess that fails silently
and expensively is worse than no feature.

**The gate is keyed on evidence, not on model.** Implementation established
which firmware actually carries the risk:

- **ZMOD replaces the command.** `lesswaste.cfg:1862-1863` declares
  `[gcode_macro SDCARD_PRINT_FILE]` with `rename_existing:
  BASE_SDCARD_PRINT_FILE`. That override is the thing that may prompt on the
  touchscreen.
- **Forge-X does not.** `printer-adventurer-a`'s object list has no
  `gcode_macro SDCARD_PRINT_FILE`, leaving Klipper's built-in `virtual_sdcard`
  command — the identical call `klipper-moonraker.js:109` and
  `creality-klipper.js:329` already make in production.

Gating by model would miss a case: **ZMOD also supports the FF5M**, so a 5M Pro
on ZMOD uses the *Adventurer* connector and must be gated too. Detection
therefore records `printStartOverridden` from the live object list, and:

- **Override present → print-start refuses**, with a user-facing explanation.
  No macro is sent at all.
- **Override absent → stock Klipper `SDCARD_PRINT_FILE`**, the same call two
  shipping connectors already make.
- **AD5X `headMapping` reports `false`** in Moonraker mode regardless, so the UI
  never offers a mapping picker that cannot be acted on. Multi-colour start
  stays gated on items 1–2 below even where single-colour start is allowed.
- `applyHeadMapping` is implemented and tested, because `_IFS_COLORS_ASSIGN`
  writes state without starting motion. It stays inert while `headMapping` is
  false.

**Verification required before the gate lifts** (all four, on real AD5X/ZMOD
hardware):

1. Determine which of `SDCARD_PRINT_FILE` / `BASE_SDCARD_PRINT_FILE` starts a
   print **without** a touchscreen confirmation.
2. Determine whether `assigned_tools` must be populated alongside `tools[]`, or
   the touchscreen re-prompts.
3. Verify with an **actual multi-color file**, not an idle API query — an idle
   query cannot reveal a dialog that only appears at print start.
4. Record the **exact request/macro sent and the observed printer behavior** in
   `docs/superpowers/specs/flashforge-hardware-verification.md`, referenced from
   the tests that depend on it.

**If the hardware cannot be reached, the gate stays closed.** No behavior is
invented, inferred from the macro source, or extrapolated from the native path.
An unverified unattended-print path is not shipped in any form.

### Argument safety

`tools` / `map` values are `parseInt`-coerced and range-checked (tool 0–15,
slot 1–4) **before** interpolation, not merely passed through
`assertSafeGcodeArg`. A range check is strictly stronger than a character-class
check for a value that must be an integer. The filename still goes through
`assertSafeGcodeArg` (`http-utils.js:105`), the shared sink for every
Klipper-family connector (CLAUDE.md §8, defense in depth at the dangerous sink).

### Version gating

`_IFS_VARS.min_version` is `1.2.3`; `printer-ad5x-a` runs `1.7.1-53`
(`config/mod/version_5x.txt`). The macro interface moves between ZMOD releases,
so `headMapping` reports **false** below a known-good floor rather than sending
macros that may not exist. Version is read once at detection and cached in the
mode entry.

### Adventurer

No multi-color path in either mode. No `applyHeadMapping`, `headMapping: false`.
Unchanged from today.

---

## 9. Error handling and fallback

- **Timeouts.** Moonraker calls reuse the existing 3500 ms probe budget; control
  calls reuse `http-utils`' existing values. No new unbounded operation.
  `readConfigJson` is bounded and TTL-cached, so a hung file read cannot stall a
  poll cycle.
- **Probe failure** returns today's exact shape —
  `{name, online:false, error: e.name === "AbortError" ? "timeout" : e.message}`
  — so the fleet UI, notifications, and queue see no new error vocabulary.
- **No silent cross-transport retry on ordinary control actions.** If a printer
  is cached Moonraker and `pause` fails, it fails and reports. Retrying against
  8898 would double latency on every failure and could reach a *different*
  machine if the address were mistyped. Failure isolation over aggressive retry
  (CLAUDE.md §6).
- **E-Stop is the one deliberate exception.** Native `estop`
  (`flashforge-utils.js:202`) is a raw TCP sequence via `sendTcpSequence`;
  Moonraker `estop` is `http.estop`. These are unrelated mechanisms and a stale
  cached mode must not swallow an emergency stop. `estop` attempts the cached
  transport and, on failure, attempts the other before reporting. Bounded, worst
  case ~2× a single timeout — the right trade for this operation and no other.
- **Actions before first probe.** A control action arriving with no cached mode
  runs detection first (bounded, §5), then dispatches. Never guess.
- **Detection never poisons on total failure** — §5 step 3.

### Neither transport reachable

The common case — printer off, unplugged, or wrong address — must stay ordinary
and cheap.

- **Both thunks fail → return the standard offline shape**, identical to what
  the connector returns today: `{ name, online: false, error }`, with `error`
  being `"timeout"` on abort or the underlying message otherwise. No new field,
  no new error string, no "mode unknown" state leaking to the UI, the queue, or
  notifications.
- **Nothing is cached** (§5 step 3), so the next probe retries cleanly rather
  than inheriting a guess.
- **Cost is one detection window, ~3.5 s**, because the thunks run in parallel.
  Sequential probing would make every offline FlashForge printer cost ~7 s and
  double the fleet's worst-case poll time.
- **`server.js`'s `offlineCache` (`server.js:1511-1519`) applies unchanged**, so
  a printer that is genuinely down is not re-probed every poll — the existing
  `OFFLINE_RETRY_MS` backoff governs retry rate exactly as it does now, for both
  modes.
- **A retained profile does not imply reachability.** Capabilities stay sticky
  while offline (§5 anti-flap), but `online: false` is what the fleet row
  reports; the two are independent and must not be conflated.

---

## 10. Tests and backward compatibility

### Backward compatibility

| Concern | Status |
|---|---|
| Registered connector types | **Unchanged** |
| Stored `url` | **Unchanged** — port still omitted; each transport appends its own |
| Config migration | **None required** |
| `address.portEditable` | `false` → `true` (adds a Port field; `defaultPort` stays 8898) |
| New field | `transport`, optional, absent = auto |
| Existing native printers | Detect native (tie-break favors native), behave identically |
| Modded printers | Heal to Moonraker on first poll, no user action |

The `portEditable` flip is the only user-visible Settings change for stock
printers. `composeAddressUrl` (`connectors/address.js`) writes a port only when
one is set, so existing config entries stay byte-identical — the guarantee that
file's header comment exists to protect.

### Native `:8898` invariant

A stock FlashForge printer must behave **identically** after this change. The
native path is not refactored, not re-timed, and not re-routed.

- **`flashforge-utils.js` is not modified.** Not one line. Every native request
  — `ffPost`, `ffDetail`, `ffControl`, `baseUrl`'s `:8898` default,
  `issuePrintAndConfirm`, `sendTcpSequence`, `getCameraSnapshot` — is byte-for-
  byte what it is today.
- **The native branch calls the same functions with the same arguments.** The
  only change inside `flashforge-ad5x.js` / `flashforge-adventurer.js` is that
  each exported function first asks which mode applies, then delegates. The
  native delegate target is the existing expression, unchanged.
- **`pendingMapping` and its TTL stay exactly as they are** (§8). The Moonraker
  path does not reuse, share, or reset that Map.
- **Native capabilities are unchanged.** Every ⚠️ gate and every derived value in
  §6 applies to the Moonraker column only; the native columns match today's
  static `exports.capabilities` exactly.
- **No new latency on the native path.** A printer cached as native fires one
  request per probe, as today. Dual probing happens only during detection —
  once per printer per address, plus after an invalidation.
- **`getCameraSnapshot` in native mode keeps using `ff.getCameraSnapshot`**,
  which derives the stream URL from the printer's own host
  (`flashforge-utils.js:403-404`) and uses `http.get` (no automatic redirect
  following). The §6 webcam invariant applies to the **Moonraker** camera path
  only; it neither modifies nor wraps the native one.

**Enforcement:** `test/connectors/flashforge-utils.test.js` and
`flashforge-print-confirm.test.js` must pass **unmodified**. If either needs
editing to stay green, the native path changed and the change is wrong.

### Tests

`test/connectors/flashforge-mode.test.js`
- native-only → native; moonraker-only → moonraker; **both → native**; neither →
  offline with **nothing cached**
- `p.url` change invalidates; 3 consecutive failures invalidate, 2 do not;
  success resets the counter
- anti-flap: one success on the other transport does not switch; two consecutive
  do
- explicit `p.transport` skips detection entirely (assert no probe fired)
- **pinned mode, transport unreachable** → reports offline and **never probes
  the other transport** (assert the other thunk was not called); repeated
  failures do not invalidate or switch
- **changing the pin**, including back to `auto`, discards entry and profile
- **neither reachable** → standard `{online:false, error}` shape, nothing
  cached, both thunks ran in parallel (assert elapsed ≈ one timeout, not two)
- **profile lifetime** (§4): retained across a 3-failure mode invalidation;
  discarded when a *different* mode resolves; discarded immediately on a
  `p.url` change
- `flashforge-mode.js` performs no I/O — the module is driven entirely by
  injected probe thunks, so its tests need no network stubbing at all

`test/connectors/flashforge-ad5x-moonraker.test.js`
- `heads[]` from fixtures mirroring `printer-ad5x-a`: slots 1,2 loaded / 3,4 empty **with
  `ffmColor3`/`ffmColor4` set** — asserting empty slots yield `hex: null`
- `activeExt` maps through `tools[]`, not raw `current_tool`; `-1` → `null`
- objects queried under the `zmod_ifs_switch_sensor` prefix
- **AD5X with no IFS evidence** (§7): IFS terms and the `Adventurer5M.json` read
  are omitted from the query, `heads: []`, `filamentHeads: false`,
  `activeExt: null` — degrades to "no slots", never a partial `heads[]`
- `applyHeadMapping` sends one `_IFS_COLORS_ASSIGN` per tool and stores **no**
  pending mapping
- non-integer / out-of-range tool or slot rejected; filename containing `"` or a
  newline rejected

`test/connectors/flashforge-capabilities.test.js`
- the §6 matrix per mode × model
- camera derivation across all three observed webcam shapes: `printer-ad5x-a` relative
  enabled → true; `printer-adventurer-b` disabled placeholder → false; `printer-adventurer-a` enabled but
  cross-host → **false**
**Camera URL and redirect handling (clause 6) — five required cases:**

| # | Case | Expected |
|---|---|---|
| 1 | same-host **direct** URL, no redirect | fetched, snapshot returned |
| 2 | same-host URL → `302` → **same host** (within budget) | followed, snapshot returned |
| 3 | **off-host absolute** initial URL (the `printer-adventurer-a` shape) | never fetched; `camera: false` |
| 4 | same-host URL → `302` → **off host** | redirect **not** followed; attempt fails |
| 5 | redirect **loop / budget exceeded** (>3 same-host hops) | aborts on the 4th; does not hang |

Case 4 is the one that silently defeats initial-URL-only validation, and case 5
is the one the host rule alone cannot catch — both are asserted explicitly, not
folded into a general "bad URL" test.

Additionally: the printer-supplied host is **never** used as a fetch target. A
webcam entry whose host differs from the printer's results in a fetch to the
**printer's** host or no fetch at all — asserted by inspecting the requested URL,
not just the outcome.
- `getCapabilities` with no cache returns static native capabilities (no throw,
  no await)
- `heads: []` for Adventurer in both modes

**Regression:** `test/connectors/flashforge-utils.test.js` and
`flashforge-print-confirm.test.js` must pass **unchanged** — that is the proof
the native path was not disturbed. `test/docker.test.js` walks the `require()`
graph and picks up new modules via the existing `connectors/` COPY; confirm it
stays green rather than assuming.

Each test would fail before the change and exercises behavior, not
implementation shape (CLAUDE.md §10).

---

## 11. Validation items — implementation gates

These do not block this design. Each must be resolved on hardware **before the
corresponding behavior ships**, and each ships **off** until then.

| # | Item | Gate | Ships as | Risk |
|---|---|---|---|---|
| 1 | **Print-start macro.** Which of `SDCARD_PRINT_FILE` / `BASE_SDCARD_PRINT_FILE` starts a print without a touchscreen confirmation, on firmware that overrides it. **No runtime fallback** — see §8. | §8 Moonraker `startPrintFile` | **refuses** where `printStartOverridden` (ZMOD); stock Klipper command where not (Forge-X). `headMapping: false` either way | **High** |
| 2 | **`assigned_tools`.** Whether `variable_assigned_tools` must be populated alongside `tools[]` or the touchscreen re-prompts. | §8 `applyHeadMapping` | implemented but inert while #1 is gated | Medium |
| 3 | **`activeExt` mapping.** Confirm `tools[current_tool] - 1`. Status reporting only — no motion, no unattended risk — so it may remain a separate item, but verify it during the same controlled print if possible. | §7 | `activeExt: null` until verified | Medium |
| 4 | **`setColor`** in Moonraker mode (ZMOD `COLOR` macro semantics). | §6 capability | `false` | Low |
| 5 | **`unloadFilament`** in Moonraker mode (`UNLOAD_FILAMENT` / `_IFS_UNLOAD`). | §6 capability | `false` | Low |
| 6 | **`autoLevel`** in Moonraker mode (`AUTO_FULL_BED_LEVEL` semantics). | §6 capability | `false` | Low |

Items 1–3 require `printer-ad5x-a` idle plus a controlled **multi-color** test print
(item 1 cannot be settled by an idle API query — the dialog it tests for only
appears at print start). Items 4–6 require an idle printer only, and are
verified **individually**: confirming one does not enable another.

Observations from any verification session are recorded in
`docs/superpowers/specs/flashforge-hardware-verification.md` — exact request or
macro sent, exact printer response, and observed physical behavior. A gate lifts
only on a recorded observation, never on inference from macro source.

---

## 12. Resolved contradictions

Two internal contradictions were found by the spec self-review and resolved
before implementation. Recorded here because in both cases a plausible-looking
alternative would have violated a stated constraint.

### 12.1 The cache entry owned things the module was forbidden to own

**Conflict.** §4 stated `flashforge-mode.js` "must not own model semantics,
capabilities, IFS behavior, or transport operations." But §5's cache entry was
`{ mode, url, caps, ifs, zmodVersion, … }` — `caps` is capabilities, `ifs` is IFS
behavior, `zmodVersion` is model semantics — and §5's detection algorithm called
`ff.ffPost(...)` and `fm.baseUrl(...)` directly, which are transport operations.
Three of the four forbidden categories, in the module forbidden to hold them.

**Chosen behavior.** `flashforge-mode.js` performs **no I/O and holds no
interpreted state**:

- Both liveness probes are **injected as thunks** by the model connector
  (`mode.resolve(p, { native, moonraker })`). The module decides *which* to trust
  and *when* to re-decide; it never knows what either request looks like.
- Post-detection facts live in an **opaque profile** (`setProfile`/`getProfile`)
  that the module stores verbatim and never inspects.

**Why this and not the alternative.** The obvious alternative — let
`flashforge-mode.js` import both transports and compute capabilities, since it
already knows the mode — is what the constraint exists to prevent: it would make
the module depend on both transports and on model semantics, so a change to
either would ripple into the detection state machine. The injected-thunk form
also makes the module **testable with no network stubbing at all**, which the
direct-import form could not be.

### 12.2 Invalidation destroyed the state that anti-flap depended on

**Conflict.** §5's anti-flap rule required "sticky capabilities while offline —
keep serving the last known mode's capabilities rather than reverting to static
native." But §5's invalidation rule dropped the whole cache entry after 3
consecutive failures, and §4 said the profile is discarded whenever the entry is
invalidated. Going offline would therefore have discarded exactly the
capabilities anti-flap promised to keep — the two rules cancelled each other out,
and the observable result would have been the control-reshuffling that anti-flap
was written to prevent.

**Chosen behavior.** Mode lifetime and profile lifetime are **separated**.
Invalidating the mode means "re-detect", not "forget everything":

| Event | Mode | Profile |
|---|---|---|
| 3 consecutive failures | invalidated → re-detect | **retained** |
| a *different* mode resolves | replaced | **discarded** (derived from the old transport) |
| `p.url` changed | invalidated → re-detect | **discarded** (may be a different machine) |

**Why this and not the alternative.** The alternative — drop everything on
invalidation and accept the flicker — is simpler, but it would reintroduce the
exact user-visible symptom anti-flap exists to remove, and the `printer-adventurer-b` flip (§2)
shows this is a real fleet condition rather than a hypothetical. Retaining the
profile across a *failure* is safe because nothing about the printer has been
observed to change; discarding it on a *mode change* or an *address change* is
required because in both cases the facts genuinely no longer apply.

---

## 13. Adjacent issues found — out of scope

Reported per CLAUDE.md §1 scope discipline. Neither affects this task; both
warrant separate tasks.

1. **`creality-klipper.js:551` takes `webcams[0]` regardless of `enabled`.** On a
   printer shaped like `printer-adventurer-a` — where index 0 is a disabled `"Example"`
   placeholder and the real camera is index 1 — it would pick the placeholder's
   path. Host rebuilding makes this safe, but it can still select the wrong
   entry.
2. **No redirect guard on Creality's camera fetches.**
   `creality-klipper.js:566` (`http.fetchTimeout(url, 2500)`) and `:652`
   (`http.fetchTimeout(p.cameraUrl, 5000)`) inherit `fetch`'s default
   `redirect: "follow"`. `p.cameraUrl` is host-rebuilt at save time so the
   initial host is safe, but a redirect could still leave it. Lower severity than
   the FlashForge case (the URL is not printer-supplied at fetch time), but the
   same class.
