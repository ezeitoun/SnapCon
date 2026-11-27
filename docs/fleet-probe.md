# Fleet status probing: the non-blocking offline display path

The reference for how SnapCon asks printers for their status. Code: `fleetProbe.js` (the cache, identity and both paths) and its wiring in `server.js` (`probeCached`, `probeForDisplay`, `finishProbe`, `GET/POST /api/fleet-fast-offline`). Tests: `test/fleetProbe.test.js`, `test/lastSeen.test.js`. Backlog: `docs/TODO.md` §48 (the slowdown) and §43 (identity).

## Why

`GET /api/fleet` builds every row with `Promise.all`, so its answer waits for the slowest printer. An offline result was remembered for only 10 s, and every caller whose memory had expired started its own probe. An unreachable printer whose probe takes several seconds to fail (an AD5X: up to ~7 s) therefore slowed most fleet requests: on 2026-11-07, three unreachable AD5Xs took the median from 0.36 s to 6.6 s.

## The two paths

| | `probeCached(p)` — authoritative | `probeForDisplay(p)` — the fleet cards |
|---|---|---|
| Used by | every decision and action: sends and uploads (`isPrinterIdle`, `assertNotActiveJobFile`), waiting sends, Loaded-file checks, printer file delete, firmware gate and probe, the Health page, `notifyTick` (notifications, utilization, queue idle counting) | `GET /api/fleet` only (both of its row builders) |
| Offline printer | its offline result is reused for 10 s, then probed again and awaited | answered at once from its last offline result (with `statusCheckedAt`); once 10 s have passed, one re-check runs in the background |
| Online or printing printer | probed every call | probed every call and awaited — never served from memory |
| Concurrent callers | each probes on its own | share one probe per printer |
| A probe that throws | throws to the caller | shown as offline with the error; not stored |

A test fails if a new caller of `probeForDisplay` appears outside `GET /api/fleet`, or if the list of `probeCached` callers changes.

Unchanged on purpose: the 10 s retry (no backoff — owner, 2026-11-08: measure first), connector timeouts, and every direct `connector.probe()` call (queue resume/resolve, notify test, test connection, startup queue reconciliation), which never used the cache.

## Guarantees

- **No stale online state.** Only an offline result is ever served from memory, and only to the cards.
- **Identity (§43).** Results are kept per printer id, not per URL; printers without a URL no longer share one entry. Temperature smoothing and the "completed at" stamp use the same key.
- **Nothing obsolete is recorded.** A result is stored only if the printer still exists with the same probe-relevant configuration (everything except display-only fields such as name, tags, camera and print preferences) that it had when its probe started, and only if no probe started later has been stored already. Removing, re-addressing, rediscovering or re-transporting a printer mid-probe therefore cannot be overwritten by the old probe; removed printers are forgotten on the next fleet poll.
- **Last seen.** Moves only on a real, current, successful probe — never on a failure, a served offline result, a timeout or an obsolete probe.
- **Bounded.** One display probe per printer; at most 4 background re-checks fleet-wide (the rest wait for a later poll); a display probe that never answers is abandoned after 30 s and its late answer ignored; no unhandled rejections.

## The switch

`config.json` → `"fleetFastOffline"`:

| Value | Behaviour |
|---|---|
| absent or `true` (**the default**) | the display path above |
| `false` | `GET /api/fleet` uses the authoritative path for every printer — the behaviour before this change |

Change it live, without a restart, as an admin:

```
GET  /api/fleet-fast-offline              → { enabled, stats }
POST /api/fleet-fast-offline {"enabled": false}
```

The change is saved to `config.json` (refused with 409 if the config could not be read at startup), audited as `fleet-fast-offline-changed`, and carried through later Settings saves. Editing `config.json` by hand is not picked up until a restart (SnapCon does not watch the file), and a Settings save made before then would write the in-memory value back — use the route.

**Switching off while probes are running:** new fleet requests use the authoritative path at once. Display probes already running finish (bounded by their timeout) and are stored like any other real result about the printer as it is configured; nothing keeps running afterwards.

## Rollback

1. Live: `POST /api/fleet-fast-offline {"enabled": false}` — no restart, no data change.
2. Code: stop the service, `git reset --keep` to the previous commit, start. No data or config format changed; a leftover `"fleetFastOffline"` key is ignored by older versions.
