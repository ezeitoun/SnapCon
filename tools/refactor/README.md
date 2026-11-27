# tools/refactor — SnapCon refactoring tooling

Policy: `docs/refactoring-policy.md`. These tools are never part of the app: they have their own
`package.json`, are installed only in approved refactor worktrees, and are not copied into the Docker
image or the `pkg` builds.

## Setup (in an approved refactor worktree only)
    cd tools/refactor && npm ci --ignore-scripts
    # local, gitignored: tools/refactor/local/approved-paths.json
    #   {"production": "<production checkout>", "worktrees": ["<this worktree>"]}
ast-grep's npm launcher needs its install script, so it is not used; `lib/tools.js` calls the platform
binary (`@ast-grep/cli-<platform>`) directly.

## Commands (from tools/refactor/)
| Command | What |
|---|---|
| `npm test` | guard, rule-validation and mapper tests |
| `npm run guard` | is this an approved, isolated worktree? |
| `npm run depcruise` | dependency rules over the app's own files, against the reviewed baseline |
| `npm run sg-scan` | ast-grep enforcement rules over the app's own files |
| `npm run sg-test` | ast-grep rules against their valid/invalid examples |
| `npm run map` | Architecture Mapper analysis → `out/assessment/` |
| `npm run verify -- --base <sha> --head <sha> --manifest manifests/<b>.json` | V1–V11 (+ V12 manual, V13 Guardian) → `out/verify/<run>/` |
| `npm run harness -- --commit <sha> --label <name>` | one isolated contract run |
| `npm run selftest-scratch` | builds a scratch repository with deliberately broken heads (`selftest/variants.js`) |

## Layout
- `lib/guard.js` — fail-closed worktree check; `lib/tools.js` — tool launcher and guarded report writer;
  `lib/appPaths.js` — the app's own source paths.
- `.dependency-cruiser.cjs` + `depcruise-fixtures/<rule>/{pass,fail}` — dependency rules and their proofs.
  The known-violations baseline (`.dependency-cruiser-known-violations.json`) is created or changed only
  through a reviewed commit; `npm run depcruise -- --write-baseline-proposal` writes a proposal to `out/`.
- `sgconfig.yml`, `ast-grep-rules/enforce/` + `ast-grep-rules/tests/` — ast-grep rules and their examples.
- `mapper/` — read-only analysis (jscodeshift parser; never transforms).
- `harness/` — the isolated contract harness: `Dockerfile` (base pinned by digest; the build's `npm ci`
  of the app's lock file is its only network use), `run.js` (host side: one container per run,
  `--network none`, read-only root, no capabilities, resource limits, source read-only, only the run's
  out folder writable), `run-in-container.js` (isolation self-check, fake printers, SnapCon, replay),
  `fake-moonraker.js`, `requests/` (health, smoke, declared volatile fields), `json-reporter.mjs` and
  `run-tests-in-container.js` (the app's suite, test by test).
- `lib/identity.js` (V3), `lib/testPreservation.js` (V6), `lib/contracts.js` (V8/V9).
- `manifests/` — one per boundary; `selftest/` — verifier validation against broken scratch heads.
- `out/`, `local/` — gitignored.
