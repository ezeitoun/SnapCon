# Refactoring policy

How SnapCon moves code toward clearer module boundaries without changing what it does. It supplements
CLAUDE.md; nothing here relaxes it. Tooling lives in `tools/refactor/` (see its README).

## 1. Definition
A refactor changes where code lives, never what SnapCon does. If anything observable from outside the
moved code differs, it is a behavior change and follows the normal plan → OK to Dev → release path in
its own commit.

## 2. External contracts (must stay identical)
- **HTTP:** paths, methods, authentication and group visibility, status codes, JSON, error codes,
  deadlines.
- **Persisted files:** config.json (and the Settings-save rebuild), users.json, the queue,
  deferred-send and transfer-result stores, live locales.
- **Databases:** audit, sync, utilization, library — schema, SQL, migrations, backups.
- **Side effects:** audit events, printer commands/uploads/G-code, notifications, file operations,
  log lines.
- **CLI:** output and exit codes.
- **Frontend:** golden cards, DOM ids, CSS classes, shared globals between browser scripts.
- **Lifecycle:** start-up order, `require` order, timers and polling, locks, single-flight probes,
  netfs lanes, work kept off the main thread.
- **Module state:** when each piece of state is created, how long it lives, and what resets it — not
  only its initial value.

## 3. Rules
1. **Pin before moving.** Every contract a boundary reaches has a test or contract check that would
   fail if it changed, passing on the old structure first.
2. **One boundary per commit; exact text moves.** Only the rewrites declared in the boundary's manifest.
3. **Never data and code together.** No schema, format, file-location or config-key change.
4. **Shared state keeps one owner.** Bindings server.js reassigns (`CFG`, `PRINTERS`, `FOLDER`) reach
   modules through injected getters, never as captured values.
5. **Module state keeps its timing and lifetime.** State moved into a module is created once at module
   level (never inside a register function), and the module is `require`d at the moved code's original
   position, so creation order relative to start-up is unchanged.
6. **Follow existing patterns:** `register<Area>Routes(app, deps)` as in `library/routes.js`.
7. **Tests move with the code, assertions unchanged.** Every test change is reviewed individually:
   test names, each assertion and the fixtures are compared before/after; only declared harness lines
   (how the code under test is loaded) may differ; a mutation check confirms the same tests still fail.
   Counts alone are never evidence. Golden files are never regenerated in a refactor.
8. **Packaging stays whole:** Dockerfile COPY, plain requires, `pkg.scripts`, BASE_DIR/ASSET_DIR. Real
   Docker and `pkg` builds are mandatory before deployment, each download/build approved by the owner.
9. **Tools:** dependency-cruiser, ast-grep and jscodeshift, pinned in `tools/refactor/`, installed with
   `--ignore-scripts` only in approved refactor worktrees. jscodeshift only for declared mechanical
   rewrites inside moved code. A rule gates a refactor only after its positive/negative tests pass and
   its hits on the real repository have been reviewed.
10. **Known failures are never a pass.** Tests that fail in the verification environment are listed with
    reviewed signatures in `tools/refactor/harness/known-failures.json` and reported explicitly in every
    run. A test declared `{ todo }` (a documented known bug) is reported as `todo-fail`/`todo-pass`, never
    as a failure, and is listed with `"kind": "todo"`: it must fail as a todo, the other entries as genuine
    failures. Any new failure or failing todo, a changed signature or kind, or a known entry that passes or
    disappears blocks.
11. **Masking is explicit.** A response field is masked only if it is declared volatile and differs between
    the two base runs. The one exception: a declared measured duration at an exact log-line position
    (anchored, literal text, plain-number group), masked even when the base runs happen to agree. Every
    masked value is reported. No other exception.
12. **Lifecycle is compared.** Timers and process listeners per start (creator, delay, unref, cleared),
    the tracked per-request timers and the intervals still active at exit must match the base; what the
    probe does not see is listed as UNVERIFIED for the Guardian.
13. **Fail closed.** Every tool runs `tools/refactor/lib/guard.js` first and refuses to run outside an
    approved, isolated refactor worktree. Nothing writes to production configuration, data, databases,
    NAS storage or real printers. Reports, local paths and temporary data stay gitignored.

## 4. Roles
Architecture Mapper (read-only agent) → Executor (main session, worktree only) → deterministic
verification (`scripts/verify-refactor.js`, Phase 2) → Refactor Guardian (independent, read-only,
Phase 2).

## 5. Gates (each needs the owner's explicit approval)
1. Architecture assessment and extraction plan.
2. Test baseline and contract coverage (the manifest's pinning tests and request set).
3. "OK to Dev" for the extraction.
4. Verification report + Guardian review; any FAIL or UNVERIFIED blocks.
5. Deployment through the normal release procedure. Never automatic.

## 6. Stop conditions
A contract cannot be pinned; a move needs a logic change; a test would need weakening; any run differs;
the diff stops reading as a move; a tool reports a new violation; the guard refuses. Stop and report.

## 7. Scope of first work
Small, well-tested server route groups first (pilot: Health). Not without a separate reviewed plan:
send, queue, transfers, file delete, printer commands, Remote Access, authentication, `public/app.js`.
