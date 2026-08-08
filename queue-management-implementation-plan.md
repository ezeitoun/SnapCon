# Queue Management — Implementation Plan (v3)

Companion to `queue-management-design.md`. v2 resolved twelve implementation-level issues. This revision (v3) resolves ten more — two are genuine remaining contradictions (Stop Queue's state-vs-flag conflict, self-contradictory persistence guarantees), the rest are precision/completeness gaps in what v2 specified. **No code written yet — waiting on "OK to Dev."**

---

## Revision log round 2 (v2) — twelve issues, resolved previously

### 1. Atomic claim conflicts with the pure-QueueEngine design — **Accepted, this was a real bug**
The contradiction is real: a genuinely pure function, called twice with the *same* input object, cannot produce a race-free result — purity means no shared mutable state exists between the two calls to contend over, so both would independently compute "yes, claimable." Atomicity requires a stateful coordinator.

**Chosen implementation:** split into two layers.
- `QueueEngine.claimTransition(printerState)` — stays pure: given a state, returns `{ canClaim, item?, nextState? }`. No mutation, just a calculation. Used for unit-testing "given this exact input, what *should* happen," not for real dispatch.
- `QueueStore.claimNextForDispatch(printerId)` — the real, stateful, synchronous coordinator. `QueueStore.js` owns an authoritative in-memory `Map<printerId, PrinterQueueState>` (same role `pendingLoad`/`queuedFile` already play in `server.js` today). This function synchronously (a) reads the current state from that Map, (b) calls `QueueEngine.claimTransition` on it, (c) if claimable, **immediately overwrites the Map with the new state and persists it to disk — both before any `await`** — then returns. Both the idle-sweep timer and any manual "start now" action call *only* this one function; there is no second code path that can make the same decision differently.

**Why `Promise.all` still safely tests this:** `claimNextForDispatch` is declared `async` but performs its entire read-check-mutate-persist block with zero `await` inside it. Calling an async function executes it synchronously up to its first `await`. So `Promise.all([QueueStore.claimNextForDispatch(id), QueueStore.claimNextForDispatch(id)])` calls the first invocation, which runs the full synchronous critical section to completion (claiming the item, mutating the Map, persisting) *before* the second invocation even begins executing — so the second call correctly observes the already-claimed state and reports failure. This is a property of the *coordinator*, not of two independent pure calculations.

**Persistence-failure-after-claim question:** if the synchronous disk write throws *after* the in-memory Map has already been mutated but *before* the async `uploadFile`/`startPrintFile` calls begin, dispatch is **not blocked on the write's success** — the in-memory claim already happened, so the dispatch proceeds regardless (a disk hiccup shouldn't stall a print that's ready to go). The failure is logged loudly (`console.error` + a `queue-persist-failed` audit event, see issue #9). Two outcomes if the process then crashes before the *next* successful persist: (a) the crash also happened before the real dispatch reached the printer → on restart, the stale on-disk record still shows the item as `queued`/printer as `idle`, so it's simply re-claimed on the next sweep tick — no duplicate, no loss; (b) the crash happened *after* the dispatch actually reached the printer → on restart, the printer probes as printing something the stale on-disk record doesn't expect, which is exactly the existing `recovery-mismatch` case — surfaced for a human, never silently assumed. A transient persist failure in this narrow window never produces silent duplication or data loss either way.

**Schema/API change:** none beyond the module split. **Tests:** rewritten concurrency test targets `QueueStore.claimNextForDispatch` against a real `QueueStore` instance (not two pure calls over a static object); a separate `QueueEngine.test.js` test covers `claimTransition`'s pure logic directly.

---

### 2. Queue-data persistence must be crash-safe — **Accepted**
**Chosen implementation:** atomic write via write-temp-then-rename, done **synchronously** (`fs.writeFileSync` + `fs.renameSync`, not the `fs.promises` async variants) — matching how nearly every other persisted file in this codebase already writes (`saveQueuedFiles`, `saveUsers`, `fs.writeFileSync(CONFIG_PATH, ...)` throughout `server.js`). Rename is atomic at the filesystem level (POSIX and NTFS both guarantee the destination is either the fully-old or fully-new content, never a torn mix). One rolling backup (`queue-data.json.bak`, overwritten each successful save — not a full history) is kept as a defense against a *logically* bad write (a bug in our own serialization), separate from the corruption protection the rename already provides.

**This single choice also resolves the "persist before or after connector activity" question uniformly**, rather than needing six separate case-by-case answers: **every state transition is computed and persisted synchronously, as one block, strictly before any connector call that logically follows it begins.** Claim→upload/start, dispatch-success, print-completion-detected, bed-clear-confirmation, attention-resolution, and stop/pause all follow this one rule. Because the writes are synchronous, there is also no concurrent-write ordering problem to solve separately — two synchronous critical sections cannot interleave in Node's single-threaded model, so no explicit write-queue/mutex is needed.

**Malformed-file-at-startup handling:** on load, if `queue-data.json` fails to parse, fall back to `queue-data.json.bak`; if that also fails, do **not** silently reset to empty. Instead: rename the corrupt file to `queue-data.json.corrupt-<timestamp>` (preserved for manual inspection), start with an empty in-memory state, but flag *every* printer that has a `printerPoolId` assigned as needing review — logged loudly at startup and surfaced as a `queue_attention_required` once that printer's live probe comes back (folds into the recovery-mismatch-style review path already designed, rather than inventing a new mechanism just for this).

**Schema/API change:** none. **Tests:** write-then-simulated-crash-mid-write (verify `.tmp` never gets renamed over the real file if the process is killed before rename — test this by asserting the rename step is the last operation and that a `readFileSync` on the real path returns old, valid content up until the rename actually happens); corrupt-file and corrupt-file-and-corrupt-backup startup tests; a test asserting persisted content exactly matches in-memory state immediately after any transition function runs (no async gap between mutation and persistence).

---

### 3. Bed-clear snapshots need executable secrets — **Accepted, this was a real gap**
Confirmed conflation: a redacted snapshot can't later *execute* the bed-clear action, but the design also requires the snapshot to be immune to concurrent pool edits. These are two different needs.

**Chosen implementation:** split `dispatchSnapshot.bedClear` into two sibling fields.
- **`bedClearExecutable`** — the full, real payload (URL/headers/body *including* any secret value, or the macro name/script) needed to actually run the action. Lives **only** in `queue-data.json`, the same trust boundary printer tokens already live in inside `config.json` — never returned by any GET route, never included in an audit-log `detail` blob. Only `queue/BedClear.js`'s actual execution code reads this field; no route handler ever touches it.
- **`bedClearSummary`** — secrets redacted to a boolean (`hasSecrets`), matching the exact convention already used for printer tokens/Resend key everywhere else. This is what `GET /api/queue/:printerId` returns and what audit-log entries reference.

This means the job's bed-clear behavior really is frozen at dispatch time, immune to a concurrent pool edit — a live re-read of the current pool would violate exactly the guarantee the design requires.

**Secret-retention hygiene:** `bedClearExecutable` only needs to exist while that item's bed-clear might still be retried. Once the item reaches a truly terminal bed-clear outcome (succeeded, or resolved past `bed-clear-failed` some other way), `bedClearExecutable` is **scrubbed (nulled) from the stored record** — `bedClearSummary` remains forever for history, but the duplicated secret doesn't sit around in `queue-data.json` indefinitely once it's no longer operationally needed.

**Schema/API change:** `dispatchSnapshot.bedClearPayload` (v1's single field) becomes `dispatchSnapshot.bedClearExecutable` (server-internal only) + `dispatchSnapshot.bedClearSummary` (safe, returnable). **Tests:** assert `GET /api/queue/:printerId` and audit-log `detail` payloads never contain `bedClearExecutable` under any circumstance (including error paths — a naive `JSON.stringify(item)` bug would leak it, so this needs an explicit response-shaping test, not just a happy-path check); assert the field is nulled once an item's bed-clear resolves.

---

### 4. File hash and immutable retry — **Accepted Option A (verify before every dispatch) for Phase 1**
Agreed this is simpler for Phase 1, with the honest limitation stated plainly rather than implied.

**Chosen implementation:** immediately before every dispatch attempt (original or retry), before calling `uploadFile`, re-stat the file and recompute/cache-fetch its hash, compared against the item's stored `sha256`:
- File missing → `queue_attention_required(reason: "file-missing")`.
- File present, hash differs → `queue_attention_required(reason: "file-changed")`.
- Match → proceed normally.

Resolution options for both (narrower than the general failure set, since nothing has started printing yet): **Use Current File** (re-snapshot with the new hash/size and proceed — this is the "explicitly select/confirm a newer version" the review asked for) / **Skip Job** / **Stop Queue**. No Retry (this check *is* the dispatch attempt) or Resume (nothing printing).

**Honest residual risk, stated explicitly:** Option A does not close the TOCTOU gap between the hash-check and the `uploadFile` read itself — a file changed in the few seconds an upload takes could still slip through. This is a narrow window (seconds) versus the problem actually being solved (a file sitting queued and possibly stale for hours/days), and Option B (an immutable spool copy) remains available later if this residual ever proves to matter in practice — not worth the disk-duplication and complexity cost for Phase 1.

**Schema/API change:** two new `attentionReason` values (`file-missing`, `file-changed`) with their own resolution set, added to the state-machine reasons table. **Tests:** dispatch attempt against a deleted file; dispatch attempt against a file whose content changed since enqueue (same name, different bytes) — both assert the correct reason and that `uploadFile` is never called.

---

### 5. Queue item history storage — **Accepted, redesigned as bounded + reusing the Audit log**
Agreed unbounded growth is a real problem. Rather than inventing a second retention/pruning system, `queue-data.json`'s per-printer record is split into three buckets:
- **`queue: QueueItem[]`** — only `queued`-status items (the actual pending list, naturally small).
- **`currentItem`** — the single item currently `dispatching`/`printing`/awaiting bed-clear for that printer (at most one, trivially bounded).
- **`recentHistory: QueueItem[]`** — a small ring buffer (last 20 terminal items per printer, capped by count, not by date) purely for the Queue Management view's "what just happened" convenience.

**The Audit log is the actual permanent history**, not `queue-data.json` — every terminal transition is already audit-logged (§7) with the sanitized dispatch snapshot in its `detail` field, and the Audit feature already has retention management (`auditRetentionDays`) built and working. Building a second, parallel, day-based retention system inside `queue-data.json` would duplicate a job the Audit log already does well. `retryOfItemId` lineage is preserved in both the ring buffer (short-term UI) and every audit-log entry (long-term queryable history).

**Schema/API change:** per-printer record in `queue-data.json` becomes `{ queueState, queuePaused, attentionReason, attentionDetail, queue: [], currentItem: null|QueueItem, recentHistory: [] (max 20), updatedAt }`. **Tests:** enqueue/complete 25 items on one printer, assert `recentHistory` never exceeds 20 and the oldest entries are dropped first (FIFO); assert every dropped entry has a corresponding permanent audit-log row.

---

### 6. Pool GET authorization is too restrictive — **Accepted**
**Chosen implementation:** reuse the exact `publicCfg(role)` pattern already established for `/api/config` — one route, response shape varies by caller role, rather than two separate route surfaces.
- Non-admin (`requireAuth`): `{ id, name, type, isDefault }` per pool — enough for the Send to Queue modal's picker and the Queue Management view's grouping headers. No `gcode`/`api` config at all.
- Admin: full shape, **but** `api.headers`/`api.body` secret values still never round-trip even to an admin — same `hasSecrets`-boolean + 3-state replace/clear/keep convention as printer tokens today. This isn't a new rule, just applying the existing one consistently.

**Schema/API change:** `GET /api/printer-pools` auth changes from `requireAdmin` to `requireAuth`, with role-conditional response shaping (mirrors `app.get("/api/config", requireAuth, (req,res) => res.json(publicCfg(req.user.role)))` directly). **Tests:** a Regular-role request never sees `api.url`/`api.headers`/`gcode.rawScript`; an Admin-role request never sees the literal secret value, only `hasSecrets`.

---

### 7. Existing queuedFile/pendingLoad cutover needs an explicit strategy — **Accepted, and the code check changed the answer**
Verified directly against `server.js` (lines ~807–836): `saveQueuedFiles()` **only writes entries where `qf.status === "ready"`** into `queued-files.json`, and `loadQueuedFiles()` restores exactly those on startup. So: **`queuedFile`'s `"ready"`-status entries genuinely persist across restarts; `pendingLoad` and `queuedFile`'s `"uploading"`/`"error"` statuses are transient, in-memory only.** My v1 plan's blanket "the old Maps are transient" claim was correct for `pendingLoad` but wrong for `queuedFile`'s `"ready"` entries — exactly the case that matters, since it represents a real, physical fact (a file already sitting on a printer).

**Chosen cutover strategy**, triggered once, at the moment `queueManagement.enabled` flips `false → true` (idempotent — safe on every enable, not just the first ever):
1. **For every printer with a `queuedFile` "ready" entry**: create a corresponding `QueueItem` (status `queued`) in that printer's new queue, flagged `alreadyUploaded: true` so its eventual dispatch calls `startPrintFile` directly rather than re-uploading — faithful to the actual physical state, not a wasted re-upload. Clear the old `queuedFile` entry and rewrite `queued-files.json` (via the existing `saveQueuedFiles()`) so there is exactly one system of record going forward, never two representations of the same physical fact.
2. **`pendingLoad` entries** (transient, a printer currently busy with something else) are left to resolve under the *existing* retry sweep exactly as today — no migration needed, since it's a short-lived, already-in-flight, one-shot operation, not an ongoing queue.
3. **The overlap race** the review flagged (old sweep and new claim both seeing "idle" at nearly the same moment): `claimNextForDispatch` gets an explicit interlock — it refuses to claim for any printer that still has a `pendingLoad` entry, deferring until that entry resolves (uploads successfully or errors) under the old mechanism. Since `pendingLoad` only exists for printers the live probe already shows as busy, this interlock only matters in the narrow window right as a printer *becomes* idle — exactly where it's needed.
4. Disabling Queue Management afterward is **not** symmetric — it doesn't reconstruct old-format single-slot entries from whatever's still queued in the new system. Existing queue items just sit inert (printers revert to `unmanaged`); anything *new* going forward uses the old mechanism again. This is a deliberate, scoped simplification for a user's own choice to turn a feature off mid-use, not an oversight.

**Schema/API change:** the enable-toggle handler gains a migration step (as above); `QueueItem` gains an `alreadyUploaded: boolean` field. **Tests:** enable Queue Management with a mix of `queuedFile` "ready", `pendingLoad", and clean printers; assert exactly the "ready" ones get migrated queue items with `alreadyUploaded: true`, `queued-files.json` no longer references them afterward, and a `pendingLoad`-holding printer is correctly excluded from claiming until its old entry resolves.

---

### 8. Phase 1 move compatibility depends on a Phase 3 matcher — **Accepted, defined now**
**Chosen implementation:** a small, self-contained Phase 1 rule with zero dependency on the future Shared Queue matcher — `printersCompatibleForMove(source, target) = source.connector === target.connector`. Reasoning: a color/tool `map` is built against a specific printer's toolhead/slot layout (a 4-toolhead U1 mapping is meaningless moved to a single-nozzle FlashForge); same-connector-type is the simplest, honest proxy for "this mapping still makes sense here," and it's a pure, trivially testable function living in `QueueEngine.js`. Cross-pool moves stay disallowed regardless (different bed-clear policies). Phase 3's future matcher *may* choose to reuse this same check as one of several criteria — noted as a natural extension point, not a current dependency.

**Schema/API change:** none beyond the new pure function. **Tests:** move between two same-connector printers in the same pool (allowed); move between different-connector printers (blocked with a clear message); move across pools (blocked, existing rule).

---

### 9. Missing attention reasons — **Modified — most folded into existing reasons as structured codes, two genuinely new**
Went through each proposed reason individually rather than adding all six as top-level states:
- **`file-missing` / `file-changed`** — genuinely new top-level reasons (different resolution buttons than any existing case) — see issue #4.
- **`printer-offline`** — **not** a new top-level reason; folded into `dispatch-failed` as `attentionDetail.code: "printer-offline"`. Its resolution options (Retry Job/Skip Job/Stop Queue) are identical to any other dispatch failure — only the *displayed reason text* needs to differ, which a structured code handles without a new state.
- **`pool-invalid`** — genuinely new top-level reason. A deleted/broken pool assignment isn't something Retry/Skip can fix (retrying just fails identically) — its real resolution is fixing the assignment in Settings. Resolution options: **Reassign Pool** (deep-links to Settings → Printers) / **Stop Queue**.
- **`pool-capability-mismatch`** — **not a runtime reason at all.** Prevented upfront instead: assigning a G-code pool to a printer whose connector lacks `capabilities.gcodeMacro` is rejected at assignment time (same posture as blocking Remote Access without User Access Management) — catches the problem before it can ever surface as a dispatch-time failure.
- **`persistence-failed`** — genuinely new top-level reason, but only escalates after *repeated* failure. A single transient write failure is logged (see issue #1/#2) and tolerated — halting automation over one blip is worse than the problem it prevents. Two consecutive persist failures for the same printer within a short window escalate to `queue_attention_required(reason: "persistence-failed")`, blocking further automatic dispatch for that printer until a human acknowledges (which itself triggers a fresh persist attempt).

**Final reason set (10):** `print-failed | dispatch-failed | bed-clear-failed | file-missing | file-changed | pool-invalid | persistence-failed | recovery-mismatch | recovery-interrupted | recovery-unknown-outcome`

**Machine-readable codes:** `attentionDetail` is formalized as `{ code, message, resumable? }` — `code` is a stable identifier (`"connection-refused"`, `"printer-offline"`, `"upload-rejected"`, `"http-timeout"`, etc.) the UI switches on for icon/copy; `message` stays free-text for raw display. This is what makes "the UI needs stable machine-readable error codes, not only free-text message" actually true.

**Schema/API change:** `attentionReason` enum grows to 10 values (from 6); `attentionDetail` gains a formal `code` field. **Tests:** one test per new reason's trigger condition; a test asserting a second consecutive persist failure (not a first) is what triggers `persistence-failed`.

---

### 10. Stop Queue semantics — **Accepted your recommendation as-is**
- Stop Queue never cancels an active print — only Cancel Print does that (existing action).
- An in-progress bed-clear is allowed to finish; nothing *new* starts after.
- A `dispatching` item that already passed the atomic claim is **not** interrupted — it's allowed to finish (success→`printing`, or failure→`queue_attention_required` as normal); Stop Queue only prevents anything *after* that from auto-starting. Chose "let anything already committed finish naturally" over building a safe-cancellation boundary for an in-flight dispatch — that's real added complexity (cleanly aborting a half-completed upload) for a narrow timing window, and "boring and safe" is the right posture for physical hardware automation.
- Pending items keep their existing order — Stop Queue never touches queue contents.
- **Resume Queue always re-probes the printer live before transitioning** — it reuses the same reconciliation logic startup uses (issue #11's mechanism), rather than blindly assuming whatever was last known is still true. A printer could have sat stopped for a long time and had something printed on it manually via its own touchscreen in the meantime; re-checking prevents exactly the duplicate-dispatch risk the review is asking about, and reuses code already being built rather than inventing a second check.

**Schema/API change:** none beyond what issue #1/#11 already define. **Tests:** Stop Queue while `dispatching` — assert the in-flight dispatch completes normally and only the *next* claim is blocked; Resume Queue after a printer's state visibly changed while stopped — assert it re-probes rather than trusting stale state.

---

### 11. Startup reconciliation timing — **Accepted, needs a genuine soft state**
Agreed a probe timeout/unreachable printer is a *different*, softer signal than a confirmed mismatch and must not be treated the same.

**Chosen implementation:** a `reconciliationPending: boolean` flag (not a new top-level `queueState`) rather than guessing. If the startup probe for a printer fails/times out, that printer's persisted `queueState` is left exactly as it was, `reconciliationPending: true` is set, and no `queue_attention_required` transition happens yet. The existing regular fleet poll (`probeCached`'s own retry cadence, `OFFLINE_RETRY_MS`) is what eventually gets a real probe result — the moment it does, the deferred reconciliation runs against that live result and resolves normally (recovery-mismatch, recovery-interrupted, etc., or simply confirms all is well), clearing the flag. No new polling loop needed — this rides on infrastructure that already exists and already retries offline printers.

Automation stays blocked **only for that one printer** (its `queueState`, whatever it was, naturally excludes it from claiming — `dispatching`/`printing`/etc. are none of them `idle`) — every other printer's queue proceeds completely normally. UI shows a distinct "Reconnecting — will resolve automatically" indicator for a `reconciliationPending` printer, deliberately *not* the "REQUIRES ACTION" banner, since this isn't yet something a human needs to do anything about.

**Schema/API change:** `reconciliationPending: boolean` added to the per-printer persisted record. **Tests:** startup with a printer that times out on its first probe but responds normally on the next regular poll — assert it stays in its persisted state with the pending flag set, then resolves correctly once probed; assert other printers' queues are unaffected while one sits pending.

---

### 12. Docker persistence approach — **Accepted, switched to a directory mount**
**Chosen implementation:** `./data:/app/data`, with `queue-data.json` (plus its `.tmp`/`.bak` siblings) living at `/app/data/queue-data.json`. This also directly strengthens issue #2's atomic-rename guarantee — rename is only atomic within the same filesystem/mount, and a directory mount guarantees the temp file and the final file share one mount point, where juggling separate single-file bind mounts risks them landing on different underlying mounts depending on platform/Docker version.

**Scoped narrowly:** this only applies to `queue-data.json`, which is new in this feature and has no backward-compatibility constraint. Existing single-file mounts (`config.json`, `users.json`, `queued-files.json`) are left exactly as they are — restructuring already-shipped, already-working mounts as a side effect of this feature isn't warranted. This isn't a new pattern for this codebase either — `audit-data/` already uses directory-mount treatment for exactly this reason (SQLite's WAL sidecar files), so `data/` for queue state follows an established precedent, not a new one.

**Schema/API change:** none. `docker-compose.yml` gets `./data:/app/data` instead of a single-file mount for `queue-data.json`. **Tests:** covered by the existing `test/docker.test.js` pattern — extend its volume-mount assertions to require `./data` is mounted once Queue Management ships, same as the existing `audit-data`/`users.json` checks.

---

## Revision log round 3 — ten more issues

### 1. Stop Queue is still incompatible with the single `queueState` field — **Accepted, real bug, adopted your recommended structure**
Confirmed: v2's plan had Stop Queue enter a `queue_stopped` state from *any* state, while simultaneously requiring active prints/bed-clears/dispatches to keep progressing and eventually transition normally (e.g. "dispatch may finish with success → printing") — which would silently overwrite `queue_stopped` and lose the stop request. Directly contradictory, and exactly the same class of bug `queuePaused` had already been fixed for one round earlier — Stop just hadn't received the same fix.

**Chosen implementation:** adopted the recommended structure exactly.
```js
queueState: "unmanaged" | "idle" | "dispatching" | "printing" |
            "awaiting_bed_clear" | "bed_clear_running" | "queue_attention_required"
queuePaused: boolean
queueStopped: boolean
```
`queueStopped=true` blocks all future claims and post-operation advancement, the same enforcement point `queuePaused` already uses (`claimNextForDispatch` checks `!queuePaused && !queueStopped`). It never replaces `dispatching`/`printing`/`bed_clear_running` — those continue reporting their true state throughout. After an active print completes, mandatory bed-clear (if applicable) still runs as normal; only the step *after* that — claiming the next item — is blocked, leaving the printer at `idle` with `queueStopped=true`. Stop Queue while already `idle` simply sets the flag with no other change. **Stop Queue while `queue_attention_required`:** the reason/detail are untouched — the unresolved failure doesn't disappear; Stop only adds "and don't auto-advance once this eventually gets resolved" on top. Resolving the attention (Retry/Skip/etc.) does **not** implicitly clear `queueStopped` — they're independent decisions a human might want to make separately. **Resume Queue clears `queueStopped` only after live reconciliation** (reusing the startup-reconciliation logic), unlike Resume from Pause, which needs no reconciliation since pausing never required re-verifying anything.

Chose the direct orthogonal-flag model over the alternative "`stopRequested` becomes `stopped` at a safe boundary" two-phase design — there's no actual need to distinguish "requested" from "in effect," since the flag being true is immediately and fully in effect for its only real job (blocking the next claim); it simply doesn't retroactively touch already-committed work, exactly like Pause.

**Schema/API change:** `queueState` enum drops `queue_stopped` (7 states, not 8); adds top-level `queueStopped: boolean` alongside `queuePaused`. **Tests:** see round-3 §10 below — one test per active state showing Stop Queue leaves that state's real progression untouched; a Resume-Queue-reconciles-before-clearing test.

---

### 2. Persistence policy remains contradictory — **Accepted Policy A (fail closed) for every dispatch-critical transition**
Confirmed the contradiction: round 2 stated an absolute rule ("every transition persisted before connector activity begins") and then, in the very next paragraph, described dispatch proceeding after a claim-persist failure — which is the opposite guarantee for exactly the highest-stakes case. Your recommendation (fail closed for anything that can cause physical activity) is the right call for equipment automation, and it's what the design has been leaning toward throughout (mandatory bed-clear, "when uncertain assume the worse case") — adopted without reservation.

**Chosen implementation — Policy A, for these five dispatch-critical transitions:** claim item, begin dispatch, confirm bed-clear, resolve attention into Retry/Proceed, begin automated bed-clear.
- The transition must be **successfully persisted before the connector action starts.**
- If persistence fails: the connector is never called; the in-memory state is reverted to the safe pre-transition value (e.g. a failed claim-persist puts the item back at the front of the queue and reverts `queueState` to `idle`); **the failure is treated as a global condition, not a per-printer one** — see issue #3 immediately below, which supersedes round 2's original "two consecutive failures per printer" design entirely.
- Non-physical UI actions (setting `queuePaused`, reading state for display) are explicitly **not** held to this fail-closed standard — a failed persist of a pause flag doesn't risk physical harm, so it's logged and retried on the normal cadence without blocking anything.

This is a direct, explicit replacement of round 2's contradictory language, not an addition alongside it.

**Schema/API change:** none beyond issue #3's `storeDegraded` flag. **Tests:** a failed claim-persist must be provably followed by zero connector calls (mock the connector, assert it's never invoked); a failed pause-flag persist must **not** block anything.

---

### 3. Persistence failure escalation — **Modified: replaced the per-printer counter with a global `storeDegraded` condition**
Agreed with the core insight: `queue-data.json` is one shared file, so a write failure isn't really isolated to whichever printer happened to trigger it first — if the disk is full or the file's unwritable, every printer's *next* save attempt would fail too. Treating it as per-printer (round 2's original "two consecutive failures") would let printer B keep dispatching while printer A already knows the disk is broken, which is inconsistent with the file's own actual state.

**Chosen implementation:** a single in-memory `storeDegraded: boolean`, owned by `QueueStore` (not per-printer, never itself written to the broken file — trivially resolved on process restart, which gets a clean slate to try writing again). **One** failed atomic save sets it immediately — no counter, no "wait for a second failure" threshold, since the earlier threshold was designed to avoid over-reacting to one printer's transient blip at the cost of *that printer's* automation; here the cost of reacting immediately is protecting *every* printer's durability, which is worth reacting to on the first sign. While `storeDegraded=true`: no printer may begin a **new** dispatch or automated bed-clear. Already-active work on any printer (a print in progress, a bed-clear already running) continues uninterrupted and is tracked accurately in memory — just not durably on disk yet — matching your suggested "buffered in memory, displayed as not durably saved." The save is retried continuously (attempted again on the next transition, or a lightweight background timer); the flag clears the instant one succeeds, and normal dispatch resumes everywhere at that point automatically. Audit events: `queue-store-degraded` / `queue-store-recovered`, both global-scope (no `printerId`).

**Answers to the specific sub-questions:** consecutive-ness is now moot (single-failure trigger, no counter to reset or scope); the flag lives purely in-memory, never on the broken file itself; a failed save affects **every** printer equally, regardless of which one initiated the write; no printer may dispatch anything new while degraded, full stop.

**Schema/API change:** `storeDegraded: boolean`, global (not per-printer). **Tests:** simulate a write failure triggered by printer A's transition, assert printer B is *also* blocked from a fresh claim while degraded; assert an already-printing printer C's in-flight print is unaffected and its eventual completion is buffered in memory; assert the flag clears and dispatch resumes globally the moment one save succeeds.

---

### 4. Backup write ordering must be explicit — **Accepted, exact sequence adopted**
```
1. Serialize the new state; sanity-check it round-trips through JSON.parse(JSON.stringify(...)) without throwing
2. fs.writeFileSync(queue-data.json.tmp, newContent)
3. fs.copyFileSync(queue-data.json, queue-data.json.bak)   // back up the OLD, still-good file — BEFORE step 5
4. fs.renameSync(queue-data.json.tmp, queue-data.json)     // atomic
5. (POSIX only, best-effort) fsync the containing directory — no equivalent on Windows, wrapped in try/catch, never blocking
```
The critical ordering fix: **the backup captures the previous, known-good file, not a copy of the new (possibly-bad) content** — backing up *after* the rename would risk both files preserving the same logically-bad state if the new content itself turned out to be wrong (a bug in serialization, not a filesystem-level corruption, which the rename alone doesn't protect against).

**Startup stale-`.tmp` cleanup:** if `queue-data.json.tmp` exists at startup, it's safe to just delete it — its presence means a previous write was interrupted *before* the rename step, so the real `queue-data.json` was never touched and remains fully authoritative; the abandoned tmp file represents zero committed data.

**Schema/API change:** none. **Tests:** assert `.bak` after a successful save contains the *previous* generation's content, not the new one; assert a leftover `.tmp` file from a simulated crash is deleted (and ignored) on the next startup without affecting the loaded state.

---

### 5. File-missing resolution text is contradictory — **Accepted, fixed; "Locate Replacement File" out of Phase 1**
"Use Current File" is removed from `file-missing` — there is no current file. Final Phase 1 actions for `file-missing`: **Skip Job** / **Stop Queue** only. "Locate Replacement File" (a file-picker recovery flow) is explicitly deferred — it's a genuinely new UI flow, and a missing file is rare enough that "skip it, re-queue properly once it's actually back" is a reasonable Phase 1 answer; noted as a plausible later UI-polish addition, not core to the engine.

**Schema/API change:** the `file-missing` resolution set in the state-machine table (Part B) now lists only Skip Job / Stop Queue. **Tests:** assert the resolve-attention route rejects an attempted "use current file" action when `attentionReason === "file-missing"`.

---

### 6. Retry file identity wording — **Accepted, precise rule adopted**
Exact rule, replacing the ambiguous v2 wording: a Retry Job initially carries forward the **original** item's path and *expected* hash. Before dispatch (original or retry, no exception), the path is re-verified. Missing → blocks (`file-missing`). Changed → blocks (`file-changed`) until a human explicitly accepts the current file. Accepting updates that item's live `sizeBytes`/`sha256` **while preserving** what changed, not silently overwriting the evidence:
```js
file: {
  name, sub, sizeBytes, sha256,           // current/effective values
  originallyExpectedSha256,               // only present once a replacement was accepted
  replacementAcceptedBy, replacementAcceptedAt
}
```
The extra three fields are only ever added at the moment a replacement is accepted — absent entirely for the common case where the hash matched cleanly on the first check.

**Schema/API change:** `QueueItem.file` gains the three optional fields above. **Tests:** accept-a-changed-file flow asserts all three new fields are populated correctly and `sha256` reflects the new content, not the old.

---

### 7. Hash cache must not bypass actual verification — **Accepted, cached-vs-forced rule adopted exactly as suggested**
- **Normal pre-dispatch check** (the routine, common-case path taken on every dispatch): cached hash allowed when path/size/mtime match the cache entry — this remains a reasonable heuristic for the overwhelmingly common "nothing changed" case, avoiding needless full-file reads on every single dispatch.
- **After a mismatch is found, at replacement-acceptance time, or for a retry of a previously-failed job:** hashing is **forced fresh**, bypassing the cache entirely — these are exactly the moments where file identity itself is what's being decided, and trusting a heuristic there would defeat the point of checking at all.

**Schema/API change:** the file-hash cache lookup function gains a `force: boolean` parameter, `true` for the three cases above. **Tests:** a file whose size/mtime are artificially preserved but content differs (simulated) — assert the *routine* path (cache allowed) doesn't catch it, but the *forced* path (replacement acceptance / retry) does — demonstrating the cache's real, accepted limitation and confirming the forced path actually closes it where it matters.

---

### 8. Corrupt queue-data recovery should not fabricate queue states too early — **Accepted, replaced with a global `queueStoreRecoveryRequired` condition**
Agreed a corrupt primary-and-backup is a store-level failure, not a per-printer recovery mismatch, and starting with a silently-empty state (round 2's original design) loses pending jobs, current-item identity, retry lineage, and executable bed-clear snapshots without ever telling anyone that happened.

**Chosen implementation:** a global `queueStoreRecoveryRequired: boolean`, set when both `queue-data.json` and `queue-data.json.bak` fail to parse at startup.
- **All** queue automation disabled system-wide (not just the printers that happen to get probed) until this clears.
- A prominent, impossible-to-miss admin warning in the Queue Management view (and the Settings gear, matching how other critical banners already surface in this app).
- Both corrupt files are preserved (renamed with a timestamp suffix, never deleted) and made downloadable via a new admin route (`GET /api/queue-recovery/corrupt-files`) for manual inspection.
- Clearing it requires an **explicit** admin action (`POST /api/queue-recovery/acknowledge-reset`, `requireAdmin`, requiring a confirmation string to guard against a misclick) — only then does a genuinely fresh, empty `queue-data.json` get initialized and every printer starts clean at `idle`. Logged as a loud `queue-store-reset-acknowledged` audit event. There is no way to actually recover the lost data — only to move forward safely and honestly, on purpose, not by accident.

**Schema/API change:** new global `queueStoreRecoveryRequired: boolean`; two new admin routes. **Tests:** corrupt-both-files startup — assert `queueStoreRecoveryRequired=true`, zero dispatch activity anywhere, corrupt files retained; assert the acknowledge-reset route requires the exact confirmation string and produces a clean, empty, working store afterward.

---

### 9. QueueStore save scope and performance — **Accepted, codified as explicit rules**
- Live progress/ETA (percentage, remaining time) **never** triggers a `queue-data.json` write — it stays purely a live, always-re-derived-from-probe value read through the existing fleet-status mechanism (`probeCached`/`/api/fleet`), exactly like the rest of the app already treats progress. `queue-data.json` only ever stores workflow-relevant fields (`queueState`, flags, queue contents/order, `currentItem`'s identity) — never a live number.
- Only genuine workflow transitions and explicit queue edits (add/remove/reorder/pause/stop) trigger a persist.
- Repeated identical probe results cause no write — this falls out naturally rather than needing a separate dedup check, because a persist only ever fires from *inside* a `QueueEngine` transition function's success path, and those functions are only invoked when `notifyTick`'s existing state-diffing (`prev.state !== st.state`, the same comparison already driving the Audit feature's completion/error logging) detects an actual change. A poll that finds "still printing, nothing new" never calls into a transition function at all, so it never persists.
- Bulk enqueue persists **once for the entire transaction**, not once per affected printer — **superseded in round 4, issue #2**, see below.

**Schema/API change:** none — these are implementation rules, not schema changes. **Tests:** superseded by round 4 issue #2's test.

---

### 10. Testing additions — **Accepted, folded into each issue's own Tests note above, consolidated here**
Every test the review requested is now attached to its specific issue above. Consolidated list for convenience: Stop Queue during `dispatching`/`printing`/`bed_clear_running`/`queue_attention_required` (issue #1); active operation completing while stop is requested (issue #1); Resume Queue reconciling before clearing stopped status (issue #1); failed claim persistence triggering zero connector activity (issue #2); global persistence degradation blocking every printer, not just the trigger (issue #3); corrupt primary+backup producing the global recovery-required state (issue #8); file-missing never offering "Use Current File" (issue #5); accepting a changed file recording both original and replacement hashes (issue #6); bulk enqueue performing one persist per printer (issue #9); repeated identical probes causing zero persists (issue #9).

---

## Revision log round 4 — four final corrections, all accepted

### 1. Remove `persistence-failed` from the per-printer `attentionReason` enum — **Accepted, leftover inconsistency**
Correct catch: once `storeDegraded` existed as a global condition (round 3, issue #3), a per-printer `persistence-failed` reason was a leftover from before that redesign — genuinely inconsistent, since a shared-file write failure was never really isolated to one printer in the first place.

**Chosen implementation:** removed `"persistence-failed"` from the per-printer `attentionReason` enum entirely. Global controls instead, surfaced on a store-wide banner (not any printer's card): **Retry Save** (`POST /api/queue-store/retry-save`, requireAdmin — forces an immediate retry rather than waiting for the next natural attempt) and **Stop All Queue Automation** (`POST /api/queue-store/stop-all`, requireAdmin). The latter sets a second, independent global flag, `storeStoppedByAdmin: boolean` — deliberately separate from `storeDegraded` (which is auto-managed, reflecting whether persistence is *currently* broken) so an admin can explicitly keep automation halted even after a save starts succeeding again, mirroring the same `queueStopped`-vs-`queuePaused` orthogonality already used per-printer. Dispatch is blocked globally while *either* flag is true. Automatic retry continues in the background regardless, with a persistent banner: *"Queue state is not currently durable — automatic retry in progress."* Printer-specific failures that occur while the store is degraded remain represented by their real, in-memory `queueState` (per round 4 issue #4's Category B handling) — never forced into a fabricated per-printer attention state that doesn't reflect what's actually happening on that printer.

**Schema/API change:** `attentionReason` enum drops `"persistence-failed"` (9 values, not 10); new global `storeStoppedByAdmin: boolean`; two new admin routes. **Tests:** assert no route or transition can ever set a printer's `attentionReason` to a persistence-related value; assert `storeStoppedByAdmin` independently blocks dispatch even after `storeDegraded` clears on its own.

---

### 2. Bulk enqueue persists once for the entire transaction — **Accepted**
Correct: persisting once *per affected printer* still rewrites the same shared file multiple times per bulk request, and — more importantly — risks partial distribution if a later printer in the batch fails validation or persistence after earlier ones already committed.

**Chosen implementation**, exactly as specified:
1. Validate the entire request up front (every target printer, file, pool membership) — **before touching any state**. Any single invalid target fails the whole request with a clear error; nothing partially applies.
2. Compute the full file expansion (quantity) and distribution (Print on All / Distribute round-robin) in memory.
3. Apply every affected printer's update to a **cloned** in-memory snapshot of the whole store — the live authoritative Map is untouched at this point.
4. Persist the complete candidate store exactly once.
5. Commit the cloned snapshot as the new authoritative state **only if** that single persist succeeds.
6. Return the full result.

This is the multi-printer generalization of the same candidate-then-commit pattern issue #4 (below) defines for single-item transitions — not a separate mechanism. The same transactional rule applies to pool-level bulk actions (Pause All Queues, etc.): compute every target printer's update against a clone, persist once, commit once.

**Schema/API change:** none beyond what issue #4 already introduces (a store-level clone/candidate helper in `QueueStore.js`, reused here). **Tests:** replaces the round-2 test — one bulk-enqueue request across 3 printers now asserts **exactly one** successful store persistence, not three; a bulk request where one of several target printers is invalid asserts *zero* printers received any items (no partial distribution).

---

### 3. First-save backup behavior — **Accepted, precise handling for the no-primary-yet case**
Correct: `fs.copyFileSync` throws if the source doesn't exist, which is exactly the state on the very first save (Queue Management just enabled, or right after an acknowledged store reset) — the backup step as originally written would crash on its very first real invocation.

**Chosen implementation:**
- If `queue-data.json` exists and can be read → copy it to `.bak` before installing the new file (unchanged from round 3).
- If `queue-data.json` does not exist yet (`ENOENT` specifically) → **skip the backup step entirely** and atomically install the new file as the primary. No backup exists yet — expected and fine; a backup only becomes meaningful once there's a prior generation worth protecting. It becomes available starting with the *second* successful save.
- If `queue-data.json` exists but the copy fails for any **other** reason (permissions, I/O error — not "doesn't exist") → **fail closed**: do not proceed with the save at all, don't touch the primary, surface it the same way any other persist failure is surfaced (`storeDegraded`). Never blindly overwrite a primary file we couldn't even verify/back up.

**Schema/API change:** none. **Tests:** first-ever save (neither primary nor backup exists) succeeds and produces a valid primary with no backup; a save immediately after an acknowledged store reset behaves identically; a simulated non-ENOENT backup-copy failure (e.g. a permissions error) asserts the primary is left completely untouched and `storeDegraded` is set.

---

### 4. Candidate-state/commit ordering — **Accepted, replaces the earlier mutate-then-revert design**
This is a genuinely better model than what round 3 specified — persisting a cloned candidate *before* ever touching the authoritative in-memory state eliminates rollback logic entirely (there's nothing to roll back if the authoritative state was never mutated in the failure case), and it closes a subtler gap: under the old mutate-then-persist-then-maybe-revert design, an observer reading the authoritative state in the narrow window between "memory mutated" and "persist confirmed" could see a claimed/advanced state that was never actually made durable. The candidate-first model makes that window not exist.

**Verified this still preserves atomicity (issue #1, round 3):** the read → compute-candidate → persist → commit sequence is still one unbroken synchronous block, zero `await` before the connector call. A second concurrent call still can't interleave — Node's single-threaded execution can't preempt a synchronous block, even one that includes a blocking disk write. If anything, this *strengthens* the original guarantee rather than complicating it.

**The two categories, exactly as specified — this is the key distinction the round-3 design didn't draw clearly enough:**

**Intent-driven physical actions** ("we are about to do something") — persist the candidate first, commit to the authoritative Map only on success, *then* call the connector:
- `claimNextForDispatch` — the decision to attempt a dispatch, before `uploadFile` is ever called
- `resolveAttention` — any outcome (Resume/Retry/Skip/Stop); persisted before whatever it triggers proceeds
- `confirmManualBedClear` — persisted before any resulting claim proceeds
- Starting an automated bed-clear — persisted before the macro/API call actually fires
- Bulk enqueue, bulk pool actions (issue #2, above)

**Observed physical events** ("something already happened, we're just recording it") — update the authoritative Map immediately to stay truthful about reality, *then* attempt to persist; if that fails, set `storeDegraded` and leave the newer, not-yet-durable state buffered in memory for the next successful save to catch up on:
- `onDispatchSuccess` / `onDispatchFailure` — recording what an *already-executed* connector call reported back (the physical attempt already happened by the time this runs; there's nothing left to gate behind persistence)
- `onProbeComplete` / `onProbeFailedOrCancelled` — recording what `notifyTick`'s poll observed on the real printer
- `onBedClearSuccess` / `onBedClearFailure` — recording what an already-fired bed-clear action reported
- `reconcileOnStartup` — recording what a startup probe found

The reasoning for the split: SnapCon has full control over whether an intent-driven action proceeds (so it's safe and correct to gate it behind durability), but zero control over whether an observed event happened (the print already finished or failed regardless of what SnapCon's disk says) — refusing to update memory over a persistence hiccup wouldn't undo that fact, it would just make SnapCon's own model of reality wrong, which is strictly worse than a temporarily-undurable-but-accurate record.

**Schema/API change:** `QueueStore.js` gains a `cloneCandidate()`/`commitCandidate()` pair used by every Category-A function; Category-B functions call a `updateThenPersistBestEffort()` helper instead. No data-shape changes. **Tests:** for a Category-A function, assert a failed persist leaves the authoritative Map completely untouched (not reverted — untouched, since it was never mutated) and the connector is never called; for a Category-B function, assert the authoritative Map *is* updated even when the persist immediately following it is made to fail, and `storeDegraded` becomes true.

---

## Updated sections (final, post round 4)

### Data structures (supersedes both earlier versions)
```js
// config.json
CFG.queueManagement = { enabled: boolean, mode: "per-printer" | "shared-queue" };
CFG.printerPools = [{
  id, name, type: "manual" | "gcode" | "api", isDefault, bedClearOnDispatchFailure,
  gcode: { macroName, rawScript, timeoutSec },
  api: { method, url, headers, body, hasSecrets, timeoutSec, waitSec, allowlist? },
  createdAt, updatedAt
}];
// CFG.printers[i].printerPoolId

// QueueStore-global, in-memory only (never written to queue-data.json itself):
//   storeDegraded: boolean               — issue #3
//   queueStoreRecoveryRequired: boolean  — issue #8

// /app/data/queue-data.json
{
  "<printerId>": {
    queueState: "unmanaged" | "idle" | "dispatching" | "printing" |
                "awaiting_bed_clear" | "bed_clear_running" | "queue_attention_required",
    queuePaused: boolean, queueStopped: boolean,        // both orthogonal — issue #1
    reconciliationPending: boolean,                      // issue #11 (round 2)
    attentionReason: null | "print-failed" | "dispatch-failed" | "bed-clear-failed" |
                     "file-missing" | "file-changed" | "pool-invalid" | "persistence-failed" |
                     "recovery-mismatch" | "recovery-interrupted" | "recovery-unknown-outcome",
    attentionDetail: null | { code, message, resumable },
    queue: [QueueItem],        // status: "queued" only
    currentItem: null | QueueItem,
    recentHistory: [QueueItem], // max 20, FIFO — terminal statuses only; permanent history is the Audit log
    updatedAt
  }
}

// QueueItem
{
  id, status, alreadyUploaded: boolean,
  file: {
    name, sub, sizeBytes, sha256,
    originallyExpectedSha256,             // issue #6 — only present once a replacement was accepted
    replacementAcceptedBy, replacementAcceptedAt
  },
  map, prefs, createdAt, dispatchedAt, finishedAt,
  queuedBy: { userId, userLabel }, retryOfItemId: null | string,
  dispatchSnapshot: null | {
    poolId, poolName, poolType,
    bedClearExecutable,   // server-internal ONLY — never returned by any route, scrubbed once bed-clear resolves
    bedClearSummary,      // redacted, safe — what routes/audit actually return
    printerDefaults: { autoLevel, flowCalibrate, timelapse },
    connectorType, printerModel, printerFirmware, queueMode,
    dispatchedBy: { userId, userLabel }
  }
}
```

### State-transition functions (final)
`QueueEngine.js` (pure): `claimTransition`, `onDispatchSuccess`, `onDispatchFailure`, `onProbeComplete`, `onProbeFailedOrCancelled`, `onBedClearStarted/Success/Failure`, `resolveAttention`, `confirmManualBedClear`, `pauseQueue`/`resumeQueue`, **`stopQueue`/`resumeFromStop`** (issue #1 — `resumeFromStop` explicitly requires a live-probe argument, distinct from `resumeQueue`, which doesn't), `reconcileOnStartup`, `printersCompatibleForMove`, `verifyFileIdentity(item, { force })` (issue #7).

`QueueStore.js` (stateful): owns the authoritative in-memory Map + the global `storeDegraded`/`queueStoreRecoveryRequired` flags, `claimNextForDispatch` (the real coordinator, Policy A fail-closed per issue #2), `persist()` (atomic write-temp-then-rename-with-backup-first, per issue #4's exact ordering), `load()` (with corrupt-file fallback chain → `queueStoreRecoveryRequired` per issue #8).

### API routes (final)
Same table as the original plan, with: `GET /api/printer-pools` at `requireAuth` with role-conditional shaping (round 2 issue #6); every route's response builder explicitly excludes `bedClearExecutable` (round 2 issue #3); two new admin routes for store-recovery (`GET /api/queue-recovery/corrupt-files`, `POST /api/queue-recovery/acknowledge-reset`, round 3 issue #8).

### Testing strategy (final)
All tests from round 2's revision log, plus every test listed per-issue in round 3's revision log above (consolidated in round 3 issue #10). No test list is duplicated here a third time — see the two revision logs for the authoritative, issue-by-issue test set.

---

Still waiting on **"OK to Dev"** before any of this gets written.
