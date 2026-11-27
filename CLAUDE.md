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
npm run test:update-golden     # rewrite the fleet card golden files (test/fixtures/card-golden/) from the current app.js
npm run build                  # pkg: builds standalone win/mac/linux binaries into dist/
```

`test/compactCard.test.js` compares the Full (classic and new layout), Camera and List view card HTML against those golden files, so a Compact-only change can't alter the other views. Run `npm run test:update-golden` only when a change to Full, Camera or List is intended, and say so in the commit message.

No lint/format command is defined — no script, no `.eslintrc`/`.prettierrc`, no eslint/prettier dependency.

The provisioning backend's commands are in `CLAUDE.local.md`.

## Reference docs — read the named part before working in an area

The detailed architecture and UI conventions are project rules with the same force as this file. They
live in two tracked reference files so they are not loaded into every session. **Before reading or
changing code in an area below, read the named part first. Do not rely on memory of it, and do not
skip it because a change looks small.**

| Working on | Read first |
|---|---|
| Anything, when you need to find where something lives | `docs/architecture.md` → "Directory map" |
| `server.js`, config handling, the CLI `--load` mode, printer status / fleet probing, route auth layering | `docs/architecture.md` → "Backend: one process, `server.js` is the hub" |
| `connectors/`, printer addresses, cameras, capabilities, `verifyUpload` | `docs/architecture.md` → "Printer connectors: the plugin boundary" |
| `remote-access/` | `docs/architecture.md` → "`remote-access/`: isolated subsystem, one entry point" (and Section 8 here, and `CLAUDE.local.md`) |
| `sync/`, `queue/`, `audit/`, `transfers/`, uploads, deferred sends, transfer results, read-back | `docs/architecture.md` → "`sync/`, `queue/`, `audit/`: the other isolated subsystems" |
| Any file access to the G-code folder, sync/firmware folders, a Library location or a user-typed path | `docs/architecture.md` → "`netfs/`: filesystem access that may be on a NAS" |
| `library/`, the Model Library | `docs/architecture.md` → "`library/`: the Model Library", then `docs/library-design.md` (the specification; it wins) |
| `parser.js` | `docs/architecture.md` → "`parser.js`: gcode metadata extraction" |
| `public/` (HTML, CSS, `app.js`), any UI | `docs/ui-conventions.md` (all of it) and `docs/architecture.md` → "Frontend: `public/`, no build step"; Sections 4 and 5 here |
| `Dockerfile`, `package.json` `pkg` config, a new top-level module, the Restart button | `docs/architecture.md` → "Packaging & deployment" |
| Code review, audit or planning-only tasks | `docs/review-and-planning.md` |
| A structural refactor (moving code between modules) | `docs/refactoring-policy.md` |

A tracked path-scoped rule, `.claude/rules/ui-conventions.md`, puts the critical UI checklist into context automatically when a file under `public/` is worked on. It is a checklist only; it does not replace reading `docs/ui-conventions.md`.

## Critical constraints (always in force; the detail is in `docs/architecture.md`)

One line each, so that none is missed when the reference was not opened. The reference text governs.

- **BASE_DIR vs ASSET_DIR:** user-editable state lives beside the executable (`BASE_DIR`); bundled assets stay on `__dirname` (`ASSET_DIR`). Never conflate them when reading or writing files.
- **Config is live:** `CFG`/`FOLDER`/`PRINTERS` are module-level globals mutated in place; no restart is assumed.
- **Printer status has two paths, never mixed:** `probeCached(p)` for every decision and action; `probeForDisplay(p)` for `GET /api/fleet` only.
- **Routes:** every `/api/*` route passes `auth.makeAuthMiddleware()`; enforcement is the `requireAuth` / `requireRegular` / `requireAdmin` layer plus printer/group visibility (Section 8).
- **CLI `--load` mode is a second process** beside the running server: it never starts Express, and it loads no store — not the queue store, the deferred-send store or the transfer-result store (each is created above the CLI block in `server.js` and loaded only below it, at real server start-up). Loading a store acts on files the running server may be writing, so keep every store load below that block.
- **Connectors are the plugin boundary:** a new brand is one file in `connectors/` plus one `REGISTRY` line; the UI reads `capabilities`, never brands. Every connector exports `verifyUpload`.
- **Uploads:** a file is started or staged only on a `verified`/`acknowledged` read-back; "verified" by content means sampled, never every byte; nothing is reused on a sampled match (no skip-identical); deferred sends never start a print.
- **Remote Access:** `RemoteAccessService.js` is the only module `server.js` talks to; nothing else touches a child process, a secret or the provisioning backend.
- **SQLite:** only Node's built-in `node:sqlite`, wrapped to degrade to no-ops — never a native-addon package.
- **Persistence:** the JSON stores save through temporary file → `.bak` copy → rename. `queue/QueueStore.js` and the `transfers/` stores also flush the file contents and the folder (in the `transfers/` stores the folder flush is best effort). The folder flush is skipped where a folder cannot be flushed (Windows, some filesystems), so a completed save is not guaranteed to survive a power loss there; none of this has been tested against a real power loss. A store that cannot load a valid file holds recovery for an admin instead of guessing (Section 7); the queue store keeps that state across restarts with a marker file (`docs/queue-recovery.md`).
- **netfs:** any fs call that can touch the G-code folder, sync/firmware folders, a Library location or a user-typed path goes through `require("./netfs").getNetFs()` — never `fs.*Sync` on the main thread, never `fs.promises` in a loop. The availability breaker is never proof a file exists.
- **Library:** `docs/library-design.md` is the specification and wins; authored tables are never dropped; file parsing and index writes happen in the worker, never on the main thread.
- **Frontend:** no framework, no build step (Section 4); extend the CSS tokens; `statusColorText()` is the single status-colour source; fonts are self-hosted.
- **Packaging:** a new top-level module needs a `Dockerfile` `COPY` (kept honest by `test/docker.test.js`); worker scripts go in `package.json` → `pkg.scripts`.


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

**The detailed conventions are in `docs/ui-conventions.md` and are part of this section** — read that file before adding or changing any UI. It holds the Named shared things table (exact helpers, classes and file references) and these subsections: Controls; Labels and helper text; Destructive actions; Action scope; Disabled controls; Settings; Filenames; Toolhead naming; Empty toolheads; Secrets; Durations.


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
