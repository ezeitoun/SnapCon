// connectors/flashforge-mode.js — which transport a FlashForge printer speaks.
//
// A FlashForge printer runs either stock firmware (native JSON API on 8898) or
// a third-party mod — ZMOD (ghzserg/zmod), Forge-X (DrA1ex/ff5m) — which takes
// 8898 down and exposes Moonraker on 7125 instead. Both connectors need to know
// which, and the answer can change under them: a printer was observed serving
// Moonraker and, later the same session, serving 8898 instead.
//
// This module is ONLY the state machine for that decision: cache, invalidation,
// re-probe, anti-flap, transition logging. It deliberately performs no I/O and
// interprets no printer data — the caller injects both liveness probes as
// thunks, so this file has no idea what a FlashForge or a Moonraker request
// looks like, and its tests need no network stubbing at all.
//
// It must never grow model semantics, capabilities, IFS knowledge, print
// behavior, or transport calls. Those live in flashforge-ad5x.js /
// flashforge-adventurer.js (model) and flashforge-moonraker.js (transport).

// Consecutive probe failures before the cached mode is re-checked. Three, not
// one, so a single timeout on a busy printer doesn't trigger a re-detection
// storm across the fleet.
const FAILS_BEFORE_RECHECK = 3;
// Consecutive detections of a DIFFERENT transport before an established mode
// actually changes. Without this, a printer that flaps would drag the fleet
// card's controls in and out with it.
const DETECTIONS_BEFORE_SWITCH = 2;

// p.id -> { mode, url, pin, fails, stale, pendingMode, pendingCount, profile }
//
// Keyed by the stable generated printer id (server.js newPrinterId()), which
// survives edits — NOT the array-index `id` in API responses, and not the url
// (that's stored inside the entry so an address change invalidates by
// comparison rather than by silently orphaning a key).
const entries = new Map();

const pinOf = p => (p && (p.transport === "native" || p.transport === "moonraker")) ? p.transport : null;

// Returns the live entry for this printer, dropping it first if anything it was
// derived from has changed. A new address may be a different machine entirely,
// and a changed pin is an explicit instruction to stop using what we decided
// before — in both cases nothing derived from the old state may carry over,
// profile included.
function entryFor(p) {
  const e = entries.get(p.id);
  if (!e) return null;
  if (e.url !== p.url || e.pin !== pinOf(p)) { entries.delete(p.id); return null; }
  return e;
}

function ensureEntry(p) {
  let e = entryFor(p);
  if (!e) {
    e = { mode: null, url: p.url, pin: pinOf(p), fails: 0, stale: false, pendingMode: null, pendingCount: 0, profile: undefined };
    entries.set(p.id, e);
  }
  return e;
}

// Which transport to use. `probes` supplies the two liveness thunks; neither is
// called unless a detection genuinely has to happen, which is what makes "a
// pinned printer fires no probes" a property of this function rather than a
// rule every caller has to remember.
//
// Returns "native" | "moonraker", or null when nothing answered and no mode was
// previously established.
// As resolve(), but also reports why detection failed. A FlashForge auth
// failure ("SN is different", "check code error") is the only thing that tells
// a user their serial/checkCode is wrong, so it must not be swallowed behind a
// generic "could not reach" — the caller decides which error to show.
//
// Returns { mode, nativeError, moonrakerError }. The error fields are only
// populated when a detection actually ran and that transport rejected.
async function detect(p, probes) {
  const pin = pinOf(p);
  if (pin) {
    ensureEntry(p).mode = pin;
    return { mode: pin, nativeError: null, moonrakerError: null };
  }
  const cached = entryFor(p);
  if (cached && cached.mode && !cached.stale) {
    return { mode: cached.mode, nativeError: null, moonrakerError: null };
  }
  const [nat, moon] = await Promise.allSettled([probes.native(), probes.moonraker()]);
  const errOf = r => r.status === "rejected" ? (r.reason && r.reason.message) || String(r.reason) : null;
  const mode = applyDetection(p, nat, moon, cached);
  return { mode, nativeError: errOf(nat), moonrakerError: errOf(moon) };
}

async function resolve(p, probes) {
  return (await detect(p, probes)).mode;
}

// The decision half, split out so detect() can report the raw probe outcomes
// alongside it without running them twice.
function applyDetection(p, nat, moon, cached) {
  // Native wins a tie: a printer still answering on 8898 is one this change
  // must not re-route.
  const detected = nat.status === "fulfilled" ? "native"
    : moon.status === "fulfilled" ? "moonraker"
      : null;

  if (detected === null) {
    // Cache nothing on a total failure — a transient outage must not pin a
    // wrong mode. An already-established mode is kept (and stays stale, so the
    // next probe re-checks) so dispatch and capabilities remain stable while
    // the printer is unreachable.
    return cached ? cached.mode : null;
  }

  const e = ensureEntry(p);
  e.stale = false;
  e.fails = 0;

  if (!e.mode) { e.mode = detected; e.pendingMode = null; e.pendingCount = 0; return e.mode; }
  if (detected === e.mode) { e.pendingMode = null; e.pendingCount = 0; return e.mode; }

  // A different transport answered. Require it twice running before believing
  // it — including when it won only by the native tie-break above, which
  // decides what a single detection concluded, not whether to switch.
  e.pendingCount = e.pendingMode === detected ? e.pendingCount + 1 : 1;
  e.pendingMode = detected;
  if (e.pendingCount < DETECTIONS_BEFORE_SWITCH) return e.mode;

  const from = e.mode;
  e.mode = detected;
  e.pendingMode = null;
  e.pendingCount = 0;
  // Every fact the model connector derived came from the old transport.
  e.profile = undefined;
  console.log(`[FlashForge] ${p.name} transport ${from} → ${detected}`);
  return e.mode;
}

// Probe/act outcome reporting. Kept separate from resolve() so a caller can
// report the result of its own real work rather than this module inventing a
// second round of network traffic to find out.
function noteFailure(p) {
  const e = entryFor(p);
  if (!e || !e.mode) return;
  e.fails++;
  // Invalidate the MODE only. The profile is deliberately retained: nothing
  // about the printer has been observed to change, and dropping it here would
  // make capabilities flicker every time a printer blips — the exact symptom
  // the anti-flap rule exists to prevent.
  if (e.fails >= FAILS_BEFORE_RECHECK) e.stale = true;
}

function noteSuccess(p) {
  const e = entryFor(p);
  if (!e) return;
  e.fails = 0;
  e.stale = false;
}

// ---- opaque profile storage ----
// The model connector computes capabilities, the resolved camera URL, IFS
// presence and firmware version, and hands the lot over as one blob. Nothing
// here reads inside it. Storage is not ownership — it lives here only so its
// lifetime can be tied correctly to the mode's (see entryFor and resolve).
function setProfile(p, profile) { ensureEntry(p).profile = profile; }
function getProfile(p) { const e = entryFor(p); return e ? e.profile : undefined; }

// exported for tests only
function _resetAll() { entries.clear(); }

module.exports = {
  resolve, detect, noteFailure, noteSuccess, setProfile, getProfile,
  FAILS_BEFORE_RECHECK, DETECTIONS_BEFORE_SWITCH,
  _resetAll
};
