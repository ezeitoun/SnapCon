# Queue Management — Full Design Summary (v4, final pre-implementation)

Status: **design settled.** Formal implementation plan is in the companion file `queue-management-implementation-plan.md`. No code written yet — waiting on "OK to Dev."

**v4 note:** a third review round found `queue_stopped` was still modeled as a state that overwrites `dispatching`/`printing`/etc. — the exact same class of bug `queuePaused` already got fixed for in v3, just not carried through consistently to Stop. Fixed below by making Stop orthogonal too. It also found the persistence-guarantee language in v3 directly contradicted itself (claimed "always persisted before connector activity," then described a case where dispatch proceeds without it). Resolved with a single, explicit fail-closed policy — see Part D3 and the implementation plan's revision log.

---

## Part A — Product decisions

### A1. Core direction
Per-printer queue first (extends the existing `queuedFile`/`pendingLoad` single-slot mechanism in `server.js` into a real ordered list), Shared Queue auto-assignment second, as a layer on the same dispatch/bed-clear machinery.

### A2. Settings → Queue Management tab
Global mode: **Per-Printer** or **Shared Queue**. A **Printer Pools** manager.

### A3. Printer Pools
- Each printer belongs to exactly one pool.
- **Default Manual** is a built-in, protected pool, auto-created the moment Queue Management is first enabled. Every existing printer is auto-assigned to it at that moment. **Any printer added while Queue Management is already enabled also auto-joins it**, with a notice: *"Added to the 'Default Manual' queue pool. Change this under Queue Management settings."* If Queue Management is disabled when a printer is added, assignment simply waits until the feature is turned on (the enable-time migration then covers it).
- Cannot be deleted while printers remain assigned to it. Persists at zero assigned printers.

### A4. Three pool types
| Type | Config | Confirmation | Notes |
|---|---|---|---|
| **Manual** | none | human taps "Bed Clear — Print Next" | Default type. |
| **G-CODE** | macro name (preferred) or raw script (advanced) | `/printer/gcode/script` blocks until finished — see limitation in Part D | Klipper-family only. |
| **API** | one-way call (method/URL/headers/body) + timeout + post-success wait | HTTP 2xx required, no redirects followed | See Part D for full security posture. |

### A5. Queue mechanics
- Queued jobs inherit the printer's default print options.
- Quantity is expanded into individual queue items **at enqueue time** — the engine never re-interprets a "×N" multiplier later; every stored item represents exactly one dispatch. Under Print on All, each printer's own list gets N entries; under Distribute, N entries get round-robined across the pool's printers before storage.
- Full effective dispatch context is snapshotted per item at dispatch time (Part D).

### A6. File-manager integration
New button in the multiselect bar (Queue Management enabled only) → "Send to Queue" modal: selected files with a quantity field each, one target Printer Pool, **Print on All** / **Distribute**, live dispatch preview, then:
- **Add to Queue** — stage only.
- **Add & Start Now** — with tooltip *"Starts eligible idle printers immediately. Jobs for busy printers remain queued."*

Multiselect banner drops the "— drag onto a folder to move" hint phrase; keeps the count + Clear.

### A7. Queue Management view — operational control panel
```
┌─ Printer Pool: "PLA Farm"  [G-CODE bed-clear]         [Pause All Queues] [Edit] ─┐
│                                                                                       │
│  ┌─ U1-01 ────────────────────────────────────────────────────────────────────────┐ │
│  │ ● printing   Bracket_v3.gcode   62%  ~18m left        [Pause] [Cancel]          │ │
│  │ queue: ▸ awaiting bed-clear → 3 queued              [Reorder ⋮] [Pause Queue]   │ │
│  │   1. Bracket_v3.gcode ×2                                                         │ │
│  │   2. Mount_bracket.gcode ×1                                                      │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│  ┌─ U1-02 ────────────────────────────────────────────────────────────────────────┐ │
│  │ ⚠ REQUIRES ACTION — bed-clear failed (API call: connection refused)             │ │
│  │   [Retry Bed-Clear] [Skip Bed-Clear & Proceed] [Stop Queue]                      │ │
│  │ queue: 2 queued                                                                  │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│  ┌─ U1-03 ────────────────────────────────────────────────────────────────────────┐ │
│  │ ○ idle   queue empty                                            [Add files]     │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────────────┘
```
Per printer row, priority order: required operator action (loudest) → current job + live printer status → queue-specific state badge (never collapsed into raw printer status) → upcoming list (reorderable/removable) → per-printer controls. Pool-level controls sit in the header. Fleet-view printer cards keep only a small contextual affordance (Manual bed-clear button, or a "queue: N pending" chip linking here) — the full workflow lives only in this view.

---

## Part B — State machines (revised per Correction 1, and again in v4)

### B1. Printer Queue State
**7 states** (down from 8 — `queue_stopped` is no longer a state, see below), plus **three** orthogonal fields: `queuePaused: boolean`, `queueStopped: boolean`, and on `queue_attention_required` only: `attentionReason` + `attentionDetail`.

```
unmanaged ⇄ idle ⇄ dispatching → printing
                 ↑        ↓ (fail)              ↓ (complete)          ↓ (fail)
                 |  queue_attention_required ←───────────────  awaiting_bed_clear
                 |        ↑ (fail)                                    ↓
                 |__ dispatching/idle (resolved) ←── bed_clear_running
```
`queuePaused` and `queueStopped` can each independently be `true` alongside *any* of the 7 states above except `unmanaged` — they never replace or interrupt the active state, they only gate whether the *next* auto-advance is allowed to happen.

| State | Meaning | Left via |
|---|---|---|
| `unmanaged` | No pool assigned | pool assignment → `idle` |
| `idle` | Nothing in flight | atomic claim → `dispatching` (blocked if `queuePaused` or `queueStopped`) |
| `dispatching` | Claimed; upload/mapping/start in progress | success → `printing`; **failure → `queue_attention_required` (reason: `dispatch-failed`)** — this no longer auto-advances to the next item |
| `printing` | Actively printing | probe complete → `awaiting_bed_clear`; probe error/cancelled → `queue_attention_required` (reason: `print-failed`) |
| `awaiting_bed_clear` | Bed-clear about to run, or (Manual) waiting on a human tap | Manual: **audited confirm action** (Correction 2) → `dispatching`/`idle`; G-code/API: auto → `bed_clear_running` |
| `bed_clear_running` | Macro executing, or API call sent + waiting out its delay | success → `dispatching`/`idle`; failure → `queue_attention_required` (reason: `bed-clear-failed`) |
| `queue_attention_required` | **Unified "needs a human" state** — see below | resolved per `attentionReason`, below (`queueStopped`/`queuePaused`, if set, are untouched by resolving the reason — they're independent decisions) |

**`queuePaused`** never interrupts anything in flight — it only blocks the *next* auto-advance. UI copy: *"The current print will continue. No additional jobs will start."* Cleared by Resume Queue.

**`queueStopped`** — *(v4 fix: this was previously modeled as a `queue_stopped` state that would overwrite `dispatching`/`printing`/etc., which directly contradicted the requirement that active work keep reporting its true progress. Corrected to an orthogonal boolean, the exact same fix already applied to `queuePaused` — Stop just hadn't been carried through consistently.)* Same blocking mechanism as `queuePaused` — an in-flight dispatch, print, or bed-clear is never interrupted and continues to transition normally through the real state machine while `queueStopped=true` sits alongside it. The only difference from Pause is what's required to clear it: **Resume Queue always re-probes the printer live before clearing `queueStopped`** (reusing the same reconciliation logic startup uses), since a printer that sat stopped for a while could have had something started on it manually in the meantime — Resume never just trusts stale state. Stopping while already `idle` simply produces `idle` + `queueStopped=true`. Stopping while in `queue_attention_required` leaves the reason/detail fully intact — **an unresolved failure does not disappear because the queue was stopped**; Stop just additionally ensures nothing auto-advances even after that failure eventually gets resolved.

### `queue_attention_required` — reasons and resolutions
**Revised — now 10 reasons** (up from 6), after a follow-up implementation review. `attentionDetail` is now formalized as `{ code, message, resumable? }`, where `code` is a stable machine-readable identifier the UI switches on (e.g. `"printer-offline"`, `"connection-refused"`, `"http-timeout"`), not just free text. Full reasoning for each addition is in `queue-management-implementation-plan.md`'s revision log, issue #9.

| `attentionReason` | When | Resolution options |
|---|---|---|
| `print-failed` | Print errored or was cancelled after actually starting | **Resume** (only if the printer's live probe shows a genuinely resumable `paused` state) / **Retry Job** / **Skip Job** / **Stop Queue** — Retry/Skip both route through mandatory bed-clear (extrusion had started) |
| `dispatch-failed` | Upload/mapping/start itself failed, before the printer ever began printing (includes "printer offline," carried as `attentionDetail.code`, not a separate reason) | **Retry Job** / **Skip Job** / **Stop Queue** — no Resume; bed-clear is *skippable* here per the pool's toggle, since nothing was deposited |
| `bed-clear-failed` | G-code macro errored, or API call failed to send | **Retry Bed-Clear** / **Skip Bed-Clear & Proceed Anyway** / **Stop Queue** |
| **`file-missing`** *(new)* | Pre-dispatch check found the queued file no longer exists at its path | **Skip Job** / **Stop Queue** only — *(v4 fix: "Use Current File" removed; there is no current file to use. "Locate Replacement File" — picking a substitute — is explicitly out of scope for Phase 1)* |
| **`file-changed`** *(new)* | Pre-dispatch check found the file's content differs from what was queued (re-sliced under the same name), using a **forced, uncached** hash — see implementation plan issue #7 | **Use Current File** (accepts the new hash, records who/when accepted it — see B2) / **Skip Job** / **Stop Queue** |
| **`pool-invalid`** *(new)* | The printer's assigned pool was deleted or is otherwise broken | **Reassign Pool** (deep-links to Settings) / **Stop Queue** — no Retry/Skip, retrying against a broken pool fails identically |
| `recovery-mismatch` | Startup reconciliation found the printer printing something SnapCon didn't dispatch | **Acknowledge & Resume Queue** / **Stop Queue** — no Retry/Skip, there's no failed item to act on |
| `recovery-interrupted` | Startup reconciliation found a `dispatching` state with the printer now idle — outcome unknown | Same as `dispatch-failed` |
| `recovery-unknown-outcome` | Startup reconciliation found a `printing` state with the printer now idle — outcome unknown | Same as `print-failed`, but Resume only offered if the live probe genuinely still shows resumable |

**Not a runtime reason:** `pool-capability-mismatch` (e.g. assigning a G-code pool to a printer whose connector can't run macros) is rejected at *assignment time* instead — never allowed to become a dispatch-time surprise.

**New orthogonal flag — `reconciliationPending: boolean`:** set when a startup probe times out/fails, distinct from a confirmed `recovery-*` mismatch. The printer's persisted state is left as-is (not escalated to `queue_attention_required`) until a subsequent regular fleet poll actually reaches it, at which point reconciliation runs for real. Shown in the UI as "Reconnecting — will resolve automatically," not the attention banner, since nothing needs a human yet. Full reasoning: implementation plan, issue #11.

**New global conditions — `storeDegraded: boolean` and `storeStoppedByAdmin: boolean`** *(QueueStore-wide, not per-printer)*: `storeDegraded` is set automatically the instant any atomic save of `queue-data.json` fails. While set, **no printer** may begin a new dispatch or automated bed-clear — durability is broken for the one shared file every printer's state lives in, so treating it as isolated to whichever printer happened to trigger the failure first would be misleading (a `persistence-failed` per-printer reason existed in an earlier draft and was removed for exactly this reason). Already-active work on any printer continues normally (never interrupted), tracked accurately in memory even though it can't be written to disk yet; the save is retried continuously, and the flag clears the moment one succeeds. Two global admin controls: **Retry Save** (forces an immediate retry) and **Stop All Queue Automation**, which sets the second, independent `storeStoppedByAdmin` flag — deliberately separate, so automation can be kept deliberately halted even after saves start succeeding again. UI banner: *"Queue state is not currently durable — automatic retry in progress."* Full reasoning: implementation plan issue #1 (round 4).

**New global condition — `queueStoreRecoveryRequired: boolean`** *(v4 addition, replaces the earlier per-printer "flag on next probe" idea for this specific case)*: set if `queue-data.json` **and** its backup are both unreadable at startup. All queue automation is disabled system-wide, a prominent admin warning is shown, the corrupt file(s) are preserved and downloadable for inspection, and only an explicit admin "acknowledge and reset" action clears it — the system never silently synthesizes empty per-printer queues and continues as if nothing happened. Full reasoning: implementation plan issue #8.

### B2. Queue Item State
`queued | dispatching | printing | completed | failed | cancelled | skipped | removed`

Retry does not mutate a failed item's state — it marks the original `failed` and creates a **new** item at the front of the queue (own fresh dispatch-context snapshot, own `retryOfItemId` lineage pointer back to the original), carrying forward the original's file path and *expected* hash as its starting assumption.

**v4 precision on file identity** (the exact rule, clarified after review): every dispatch — original or retry — re-verifies the file against that expected hash immediately before upload, using a **forced, uncached** hash specifically for this check (see implementation plan issue #7 for why the routine dispatch-path cache isn't trusted here). Missing → blocks (`file-missing`). Changed → blocks (`file-changed`) until a human explicitly accepts the current file. Accepting updates the item's `sizeBytes`/`sha256` to the new values while *preserving* evidence of the original:
```js
file: {
  name, sub, sizeBytes, sha256,
  originallyExpectedSha256,   // only present if a replacement was ever accepted
  replacementAcceptedBy, replacementAcceptedAt
}
```

---

## Part C — Atomic dispatch
Unchanged from v2: `claimNextForDispatch(printerId)` is the only code path allowed to move a printer's `queueState` out of `idle`, and does so in a single synchronous block (no `await` between the idle/queue-non-empty check and the `dispatching` write) — Node's event loop can't interleave two synchronous blocks, so this needs no locking library, matching the existing `offlineCache`/`pendingLoad` Map pattern already in `server.js`.

---

## Part D — Confirmed decisions and corrections

### D1 — Correction 1: dispatch failures no longer auto-drain the queue
Adopted the broader `queue_attention_required(reason: "dispatch-failed")` approach over a narrow standalone state — see the reasoning at the top of this conversation turn. Concretely: a failed upload/mapping/start marks that one item `failed`, and the printer enters `queue_attention_required` instead of returning to `idle`. Since the atomic claim (`claimNextForDispatch`) only ever fires from `idle`, this **inherently** halts automatic advancement for that printer — no separate "queue paused" flag needs to be set as a side effect, it falls directly out of the state machine.

### D2 — Correction 2: Manual bed-clear confirmation is a real, audited, server-side action
`awaiting_bed_clear` → confirm is not a client-only state flip. `POST /api/queue/:printerId/confirm-bed-clear` performs the transition server-side and logs an audit event carrying:
- the confirming user (`actorFromReq`)
- confirmation timestamp (automatic, via `auditLog`)
- the completed/failed job it followed (item id + filename + outcome)
- printer + pool (id/name for both)
- whether `queuePaused` was set at the moment of confirmation
- whether the confirmation led straight into a new dispatch, or left the printer idle/paused with nothing queued behind it

### D3. Pause and Stop semantics — both orthogonal flags, not states
*(v4: this section is rewritten — v3 still described Stop Queue as entering a `queue_stopped` *state*, which directly contradicted "an active print continues," since overwriting `queueState` with `queue_stopped` would lose the very workflow state needed to process that print's eventual completion. Fixed by giving Stop the exact same orthogonal-flag treatment Pause already had.)*

**Pause Queue** (single control, not two — decision unchanged from v3): sets `queuePaused=true`. UI copy: *"The current print will continue. No additional jobs will start."* **Resume Queue** clears it, no reconciliation needed (nothing about Pause required re-verifying reality).

**Stop Queue**: sets `queueStopped=true` — a materially stronger *intent* than Pause, but mechanically the same kind of flag: it never interrupts anything in flight and never replaces the active `queueState`. Never cancels an active print (only the existing Cancel Print action does that). An in-progress bed-clear is allowed to finish; nothing *new* starts after. A `dispatching` item that already passed the atomic claim is likewise never interrupted — it finishes naturally (success→`printing`, failure→`queue_attention_required`); Stop only blocks what would come *after*. Pending items keep their order untouched. If the printer is currently in `queue_attention_required`, the reason/detail stay exactly as they are — Stop doesn't resolve or hide the failure, it just also ensures nothing auto-advances once that failure eventually does get resolved. **Resume Queue clears `queueStopped` only after re-probing the printer live** (reusing the startup reconciliation logic) — unlike Pause, since a printer that sat stopped for a while could plausibly have had something started on it manually in the meantime, and Resume must never just trust stale state for an action this deliberate.

Pool-level bulk action is labeled **Pause All Queues** (not "Pause All," to avoid implying active prints get paused).

### D4. API bed-clear security — approved with metadata-endpoint blocking added
Full posture: admin-only editing; HTTP 2xx required (3xx/4xx/5xx all count as failure); no redirects followed; strict configurable timeout with a hard-capped maximum; request/response size limits (via the existing `fetchTimeout` helper); secrets masked using the exact printer-token convention (never round-trip to the browser); secrets redacted in audit-log diffs and error text; optional hostname/IP allowlist for anyone who wants extra hardening; audit logging on every pool change.

**Localhost/private-network targets are allowed by default** — they're the actual expected use case (a local Home Assistant instance, an ESP32 on the LAN, or a service on the SnapCon box itself), not an attack surface, given SnapCon's local-first/admin-controlled trust model.

**New: cloud metadata endpoints are blocked by default.** `169.254.169.254` (the link-local address used for instance-credential metadata across AWS, Azure, GCP, OpenStack, and DigitalOcean) is blocked unconditionally unless an explicit advanced override is enabled. This is a narrow, well-targeted addition — it's never a legitimate target for the local-automation use case this feature exists for, and it's specifically the address a real SSRF exploit chain would aim at to steal cloud credentials. Blocking it costs nothing for the intended use case while closing the one genuinely dangerous default target.

Encryption at rest matches SnapCon's existing plaintext-in-`config.json` secret-storage convention (same as printer tokens, Resend key, Telegram bot token) — not elevated specifically for this feature. Treated as a future cross-cutting credential-storage initiative if ever pursued, not something to implement only here.

### D5. G-code bed-clear
Unchanged from v2: macro-name preferred over raw script, Klipper-family only, configurable execution timeout (proposed 3–5 min default), Test Bed-Clear action with a pre-flight warning, audit logging on test/edit. Moonraker's `/printer/gcode/script` reliably blocks for synchronous gcode (homing, moves, purges, dwells, nested macros) but **not** for anything a macro deliberately backgrounds (`RUN_SHELL_COMMAND`, `[delayed_gcode]`) — a real, documented limitation the Test Bed-Clear action exists to catch.

### D6. Dispatch-context snapshot
Unchanged from v2, plus three follow-up review resolutions:
- **SHA-256 hash is kept**, cached by (file path, size, mtime) for the routine case so an unchanged file isn't rehashed on every dispatch. **v4 precision:** the cache is only trusted for the *first-pass* pre-dispatch check. The moment identity itself is what's actually being decided — resolving a `file-changed` warning, accepting a replacement, or a retry of a previously-failed job — hashing is **forced fresh, bypassing the cache**, since size+mtime matching isn't a cryptographic guarantee and trusting a cache at exactly the moment identity is in question would defeat the point of checking at all.
- **The bed-clear payload snapshot splits into two fields**: an internal `bedClearExecutable` (the real, secret-including payload needed to actually run the action — server-side only, never returned by any route or audit entry, scrubbed once that item's bed-clear resolves) and a `bedClearSummary` (redacted, safe to return everywhere). A fully-redacted snapshot alone can't later *execute* the bed-clear action, which the original v2 wording glossed over — see implementation plan issue #3 for the full reasoning.
- **Persistence of every transition is now a single, explicit fail-closed policy**, not an implied-but-then-contradicted guarantee. For any transition that can trigger physical printer activity — claim, dispatch start, bed-clear confirmation, resolving into a retry/proceed action, starting an automated bed-clear — the write to `queue-data.json` must succeed **before** the connector call happens. If it fails, the connector is never called, the in-memory state is reverted to a safe non-dispatched value, and (per the `storeDegraded` condition above) no printer dispatches anything further until a save succeeds again. See implementation plan issue #2 for the full ordering.

### D7. Button wording — confirmed
**Add to Queue** / **Add & Start Now**, with the tooltip text specified in §A6.

### D8. Reordering, dispatch preview, Shared Queue schema
Unchanged from v2 — see the implementation plan for how these map to routes/data.

---

## Part E — Restart / crash recovery (revised)

Same core principle: never trust in-memory "mid-something" state across a restart; reconcile against the printer's live probe; when genuinely uncertain, surface for a human rather than guess. Every ambiguous outcome now funnels into `queue_attention_required` with a specific `attentionReason`, rather than needing bespoke recovery-only state names — a direct benefit of the Correction 1 consolidation.

| Persisted state at crash | Probe result | Resolution |
|---|---|---|
| `dispatching` | Printing the expected file | Assume dispatch succeeded before the crash → `printing`, no duplicate, no skip |
| `dispatching` | Printing something else | `queue_attention_required` (reason: `recovery-mismatch`) — never claim ownership of an unrecognized print |
| `dispatching` | Idle | `queue_attention_required` (reason: `recovery-interrupted`) — **revised from v2**, which auto-requeued this silently; per Correction 1's spirit, an unexplained interrupted dispatch could be a systemic problem, so it now surfaces for a human rather than auto-retrying |
| `printing` | Idle | `queue_attention_required` (reason: `recovery-unknown-outcome`) — outcome unknown while SnapCon was down; mandatory bed-clear applies once resolved |
| `bed_clear_running` | — | `queue_attention_required` (reason: `bed-clear-failed`, detail: "interrupted by restart") — never guess whether a macro/API call actually completed |
| `awaiting_bed_clear` (Manual) | — | Trivially safe, just resume waiting for the tap |
| `queue_attention_required` | — | Trivially safe, resume showing the same banner/reason |
| any state, `queueStopped=true` | — | Trivially safe — `queueStopped` is orthogonal to `queueState` (v4), so it round-trips through a restart exactly like any other persisted field, no special handling needed |

Every recovery-triggered `queue_attention_required` also logs a `queue-recovery-review-needed` audit event. If `queue-data.json` **and** its backup are both unreadable at startup, none of the above applies — see the `queueStoreRecoveryRequired` global condition in Part B instead.

---

## Part F — Implementation phases
Unchanged from v2 — see the implementation plan for the concrete build order within Phase 1.

**Phase 1 — Persistent per-printer manual queue** (full state machine, Manual pool type only, operational view, recovery, audit).
**Phase 2 — Automated bed-clear** (G-code + API pool types, Test Bed-Clear).
**Phase 3 — Shared Queue** (unassigned pool, requirements matching, atomic claiming reused from Phase 1).

---

Design is settled through three review rounds — v2 resolved six open questions, v3 fixed two state-machine contradictions (dispatch-failure cascading, unaudited manual confirmation), v4 fixed two more (Stop Queue's state-vs-flag conflict, the persistence-guarantee self-contradiction) plus ten implementation-level precision issues. See `queue-management-implementation-plan.md` for the file-by-file plan and full reasoning on every point. Still waiting on **"OK to Dev."**
