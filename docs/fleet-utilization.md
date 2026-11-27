# Fleet Utilization: accounting rules

The reference for how SnapCon turns printer readings and printer job history into time and job figures. Code: `utilization/` (classification `classify.js`, ledger and KPIs `formulas.js`, recording `Tracker.js`/`Writer.js`, history `HistorySync.js`/`reconcile.js`). Owner decisions are dated where they were made.

## Principles

1. **Every millisecond of a printer's eligible time lands in exactly one bucket.** A ledger that does not add up, or intervals that overlap, are errors, never numbers.
2. **What SnapCon observed is never overwritten.** Printer history may add time only where nothing was recorded, never later than the moment it was read.
3. **Absence of evidence is shown as such.** Not recorded, unknown and uncertain are categories, never folded into a state.
4. **Conservative on purpose.** Where the evidence does not settle something, it is left unknown or uncertain. **Productive utilization can therefore be understated, never overstated.** (Owner, Phase 2 closeout, 2026-11-03.)

## The buckets

| Bucket | Kind | Meaning |
|---|---|---|
| Printing | operational | A job running that ended completed |
| Failed print | operational | A job running that ended failed or cancelled (machine time, not productive time) |
| Paused | operational | A job paused (by the user, filament runout, M600 and so on) |
| Error | operational | The printer in an error or shutdown state |
| Idle | operational | Online, no job |
| Offline | operational | **Unreachable from SnapCon** (two polls without an answer). Not proof the printer was inactive |
| Running (provisional) | provisional | A job still running: its outcome is not known yet |
| Outcome unknown | provisional | A job whose outcome is not known and may never be (see below) |
| Unobserved | coverage gap | The printer answered with a state SnapCon cannot read |
| Historically uncertain | coverage gap | Part of a job the printer's history confirms, but whose state (printing, paused, heating) cannot be known |
| Not recorded | coverage gap | Nothing was recorded: SnapCon was not running, or before it was installed |

Utilization is Printing time divided by eligible time, and null when nothing was recorded.

## Where each figure comes from

Every interval carries a **provenance**, and may be **estimated**:

| Provenance | Meaning |
|---|---|
| Observed | SnapCon saw it in its own polls (every 30 s) |
| Inferred | The printer's own job timestamps confirm a job in a stretch SnapCon did not record |
| Backfilled | Taken from the printer's job history, for a job SnapCon did not see at all |

**Estimated**: history gives a job's span and its `print_duration`, not when inside the span it printed. The `print_duration` share of the span is counted as the job's outcome state, spread evenly: that spreading is an estimate and is labelled so. The rest of the span is Historically uncertain.

## Job outcomes

A job's outcome is one of completed, failed (error or shutdown), cancelled, running, or **unknown**. Unknown has distinct causes, kept on the job:

| Cause | When |
|---|---|
| Ended without an outcome | The printer went back to standby without saying how the job ended |
| Interrupted | The printer's own history says interrupted, disconnected, or similar |
| **Unresolved** | What SnapCon saw and the printer's history disagree, and nothing establishes which job is which. Neither side is preferred; both answers are kept. Resolved later if a delayed history page brings the evidence (owner, closeout option ii) |
| **Ambiguous** | Two prints under one observed job: the same file printed again while SnapCon was not running, which the tracker can only continue by file name. Unknown for good: a later ending cannot confirm it |

An unknown outcome is never counted as a success. Its time is Outcome unknown, not Printing and not Failed.

## How printer history is reconciled

**Off unless configured** (owner, pre-deployment safeguards): `config.json` `utilization.readPrinterHistory` is `true` (every printer whose connector has a job history: Snapmaker U1, Klipper/Moonraker, Creality K), a list of printer ids (only those: a pilot), or anything else, the key absent included, which reads none. Off means no history request at all, scheduled or after a job ends; it is checked on every poll and before every page, so turning it off stops a pass in progress. Recording, rollups, the API and the page go on; every report says `printerHistory: { reading: "off" | "on" | "pilot", printersRead }` (a count of the printers in that report, never another printer's id), each printer row says `historyRead`, the page says so above the figures, and the log says it once at start and on every change. With it off, everything below about history does not happen: outcomes and times are only what SnapCon observed, and the figures understate more.

When on, a pass is a read-only `GET /server/history/list`: one request at a time across the fleet, at least 2 s apart, 8 s timeout, only while the printer is online and not printing or paused; the first pass two minutes after start, then every 10 minutes per printer (a minute after one of its jobs ends), at most 4 pages of 50 records, the first looking back 90 days.

- A record belongs to a job SnapCon observed when the file matches, the job was first seen within two minutes before to three minutes after the record's start, and **not after the record's end**.
- Such a record settles a running or unknown outcome with what the printer reported, and corrects an observed outcome only with evidence that the ending SnapCon saw was a later job's.
- The matched job's Not recorded stretches get job time bounded by `print_duration` less the printing SnapCon saw, estimated; the rest is Historically uncertain.
- A record SnapCon did not see fills only Not recorded time, estimated.
- **A job during observed Offline** (or unobserved) time counts as a job, with its outcome, **but adds no time**: the Offline time stays Offline (owner, closeout).
- **A short job entirely between two Idle readings** counts as a job, with its outcome, **but adds no time**: the Idle time stays Idle (owner, closeout).
- A record over observed Error, over another observed job, over another record, or claiming more of observed Idle than a poll could miss, is skipped and counted as a conflict.
- Every record is applied once (the printer's job id with its start time).

## Where the figures understate (by design)

1. Jobs during Offline: their productive time is not counted.
2. Short jobs between polls: their time (under 30 s) stays Idle.
3. Estimated job time is only the `print_duration` share; the rest is Historically uncertain.
4. Ambiguous, unresolved and interrupted jobs: their time is Outcome unknown, never Printing.
5. An observed job's interval runs to the poll that saw it end (up to 30 s past the real end).
6. A second print merged into an ambiguous job is counted as a job, but its time is not separated out.

"Print time lost to failures" likewise only counts failed time SnapCon could place.

## Phase 3 help-text requirements

Implemented in Phase 4 (`public/utilization.js`, keys under `utilization.*` in `locales-default/`). Requirements for the Utilization page's help, all strings through the locale files (English and Spanish at least):

1. **Every bucket** in the legend and the state table has a one-line description, in the words of the table above, including that **Offline means unreachable from SnapCon, not that the printer was idle**.
2. **Estimated** values are marked (a hatched fill and "≈"), with help: "Spread from the printer's job history: the printer reports how long a job printed, not when."
3. **Inferred** time is distinguishable from observed in the tooltip and state table, with help: "Confirmed by the printer's own job times while SnapCon was not recording."
4. **Running (provisional)** and **Outcome unknown** are named separately. Outcome unknown says why, using the causes above, in plain words (for example "SnapCon and the printer's history disagree about this job").
5. **Coverage** is shown beside every KPI: telemetry coverage, outcome coverage, and jobs with a known outcome; with help: "How much of this period SnapCon recorded. Figures can only describe what was recorded."
6. **A standing note** where the KPIs are shown: "These figures are conservative: where the evidence is incomplete, time is shown as unknown or uncertain rather than as printing, so utilization may be understated."
7. Job counts distinguish observed jobs from jobs recovered from the printer's history (short, during Offline, backfilled), and show reconciliation conflicts per printer.

## Reporting (Phase 3)

Code: `utilization/rollup.js` (one printer's local days), `utilization/Reporting.js` (cache, KPIs, series, per printer, CSV), `utilization/routes.js` (the API).

### Rollups

One per printer, local day, time zone and basis: the Phase 0 ledger for that day (`accountPrinter` over the printer's eligible span, `eligibleSpan`), its printer-days and recorded printer-days (Phase 0 `metrics`), and its jobs. A job counts on the local day it ended, or the day it started if it has no end time; a job still running counts as running. Rollups of complete days are kept in a bounded in-memory cache (20,000 entries); the current day is always computed afresh. After each commit the store reports, per printer, the earliest moment that changed; every cached day ending after it is dropped and recomputed when next asked for. Not written to the database, so reporting never writes outside the Writer and its WAL controls; after a restart, the first report recomputes what it needs. Computation is through indexed reads only, a few days of one printer at a time, with the event loop free between chunks; one computation at a time.

### KPIs

All against **eligible time**: the time each printer existed in the period (from its first sighting or first job in its history, until removed), inside the basis (24 hours, or the configured farm hours). Estimated time (the spread `print_duration` share) is **never** in a headline figure: each figure that could include it gives `value` (confirmed only) and `withEstimates`.

The four tiles (owner, Phase 3 closeout) and one secondary figure. **Confirmed** Printing and Failed time is job time with that outcome, observed or inferred, and not estimated: never Running (provisional), Outcome unknown, Historically uncertain or Not recorded time, nor the estimated share.

| KPI | Formula | Null when |
|---|---|---|
| Utilization | confirmed Printing hours / eligible hours | nothing was recorded |
| Avg print time per printer | confirmed Printing hours / printer-days; a printer-day is eligible time / the day's basis, summed (for farm hours, per scheduled day: owner decision D7) | nothing recorded, or no printer-days |
| Failure loss | confirmed Failed hours / (confirmed Printing + confirmed Failed hours) | no job time with a known outcome |
| Paused + error per printer | (Paused + Error hours) / recorded printer-days, where a recorded printer-day is observed or inferred operational or provisional time / the day's basis (paused and error are only known where SnapCon watched) | no recorded printer-days |
| *Secondary:* job success rate | completed / (completed + failed + cancelled) jobs; unknown and running jobs are not in it; reported with its outcome coverage (jobs with a known outcome / all ended jobs) | no job with a known outcome |

Coverage beside them: `telemetry` (recorded / eligible time), `outcomes` (Printing + Failed / all job time), `jobsWithOutcome` (jobs with a known outcome / all ended jobs). Deltas against the previous period of the same length use Phase 0's `delta`, with `partialCoverage` when either side's telemetry coverage is below 100%.

### API

Read only, signed-in users (`requireAuth`); a report runs SELECT statements only (a test checks every statement), through indexed reads bounded by a few days of one printer at a time; every printer as visible to the user (`printerVisibleTo`); a printer since removed from SnapCon, admins only; virtual printers only with `includeVirtual=1`. A printer the user may not see is answered exactly like one that does not exist.

| Endpoint | Returns |
|---|---|
| `GET /api/utilization/summary` | the fleet: hours per bucket (total, observed, inferred, backfilled, estimated), shares of eligible time, coverage, the KPIs, the previous period and deltas, job counts by outcome, unknown cause and evidence, reconciliation counters and conflicts, flags, limitations |
| `GET /api/utilization/series` | the same aggregate per day (7 or 30 days) or per week (90 days; the oldest block can be shorter and says its real dates) |
| `GET /api/utilization/printers` | the same aggregate per printer, with its deltas and reconciliation counters |
| `GET /api/utilization/export.csv?view=printers\|fleet` | one row per day and printer, or per day for the fleet; the same calculations |

Query: `range=7|30|90` (default 7), `basis=24h|farm` (default 24h), `end=YYYY-MM-DD` (default today in the report's time zone; not in the future; the range and the period before it within the last 399 days, the oldest day pruning leaves whole), `includeVirtual=0|1`, `printers=id,id` (1 to 200). Errors: 400 with a `code` for a bad parameter, 409 when the farm hours or the time zone in `config.json` are missing or unusable, 503 when the utilization data is not available.

Configuration (`config.json`, until Settings exist): `utilization.timeZone` (an IANA zone; default the host's, owner decision D8), `utilization.farmHours` (`{ "days": [0-6], "start": "HH:MM", "end": "HH:MM" }`) and `utilization.readPrinterHistory` (above; off when absent). Neither is ever invented: `basis=farm` without a usable schedule is a 409, as is a start equal to the end.

### Farm hours

A shift starts on each day named, at `start`. An `end` not after the `start` is **overnight** (owner, Phase 3 closeout): the shift ends on the next day (22:00 to 06:00; an end of 00:00 is the next midnight). Each local day gets the parts of shifts inside it: an unscheduled morning still gets the tail of the night before. A shift is **one scheduled day** however midnight or a period edge cuts it: each part counts its share of the whole shift as printer-days (owner decision D7), so a night split between two reporting periods adds up to one printer-day across them. Clock changes: a start takes the earlier of a repeated local time and an end the later (a repeated hour is working time); a start in the skipped hour is where the clock resumes; a night across spring-forward is an hour shorter, across fall-back an hour longer.

CSV: column names carry their units (`_hours`, `_pct` as 0-100, counts); numbers are numbers, an unknown is an empty cell; text that a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`, a tab or a carriage return) gets a leading apostrophe; quotes, commas and line breaks are quoted.

## The page (Phase 4)

Code: `public/utilization.js`, an in-app page like the Library at `/utilization` (filters in the query: `range`, `basis=farm`, `end`, `virtual=1`), opened from the top bar's Fleet utilization cell (every signed-in role; not on a single printer's `/orca/<name>` link). Read only: it sends GET requests to `/api/utilization/*` and nothing else, and it never recomputes a KPI; printer visibility is entirely the API's.

- **Tiles:** the four confirmed KPIs, each with its value "with estimates" beside it (≈, hatched mark) when that differs, the change against the previous period in words (better, worse, no change; "partial coverage" when either side was not fully recorded), coverage, and how it is calculated. Job success rate is a secondary line with its outcome coverage.
- **Chart:** one column per day (per week for 90 days), each column **all of that period's eligible time**: Not recorded, Unobserved and Historically uncertain are drawn as textures in the column, never left out, so a column is never stretched to 100% recorded. Estimated parts are their bucket's colour, hatched. The eight state colours are one categorical palette validated for both themes in this stack order. Each column has a text description, keyboard focus (one tab stop, arrow keys) with the tooltip, and the whole chart is one button away as a table.
- **Machine time, jobs, per printer:** every bucket with its description and its observed, inferred, backfilled and estimated hours; job outcomes, unknown causes and where each job came from (short and Offline jobs say their time stays Idle or Offline); a sortable per-printer table. History conflicts are counted since SnapCon began reading the printer's history (the API's counters are not per period), and the page says so.
- **Errors:** farm hours missing or unusable name `config.json utilization.farmHours`, offer the 24-hour figures, and offer no CSV; Settings has no option for them yet.

## Protecting the analytics data (deploying, backing up, rolling back)

Everything is in `utilization-data/` next to `server.js` (in Docker, its own volume):

| File | What it is |
|---|---|
| `utilization.db` | The database (SQLite, WAL mode) |
| `utilization.db-wal`, `utilization.db-shm` | Its write-ahead log and index. **Part of the database**: what was saved since the last checkpoint is only in the `-wal`. A clean stop folds it in and removes both; a forced stop leaves them |
| `backups/utilization-<time>-nightly.db` | A consistent snapshot (`VACUUM INTO`) a day, 7 kept |
| `backups/utilization-<time>-pre-migration.db` | A consistent snapshot before every schema migration, never rotated |
| `utilization.db.corrupt-<time>*` | A database found damaged at start, moved aside (never deleted) |

**Restore sources, in order of authority:**
1. A `backups/utilization-*.db` snapshot: consistent by construction, self-contained (no `-wal`).
2. A copy of the whole folder taken with SnapCon **stopped**: the `.db` with its `-wal` and `-shm`, together.
3. Never authoritative: a file-level copy of the live folder taken while SnapCon runs (`rsync`, `cp`, a NAS sync, a backup agent). The `.db` and its `-wal` are read at different moments, so the copy may be torn. Such tools do carry the `backups/` snapshots consistently, which is what makes them useful.

**Restoring** (SnapCon stopped): move `utilization.db`, `-wal` and `-shm` **together** aside (never delete them); then either copy one snapshot to `utilization.db` with no `-wal` or `-shm` beside it, or put back the three files of a stopped copy together. Never pair a `.db` with a `-wal` from another moment. At the next start the log says `analytics checkpoints: ok`; a file it cannot read as a database is moved aside and kept, never deleted.

**What SnapCon does with it on its own:** a database written by a newer SnapCon (higher schema) is left untouched and nothing is recorded; a database that is locked or unreadable at start is left where it is and nothing is recorded until the next start; only a damaged file is moved aside. **A full disk** while SnapCon runs is retried (after 30 s, 1, 2, 5 and 15 minutes, then every 15 minutes, for up to 24 hours): what was read waits in memory, up to 2000 steps, and is saved with its real times once there is space; past that, or when SnapCon stops before there is space, the time from the last saved checkpoint is Not recorded, never invented. Printer monitoring, the queue and printing are not affected. A start with the disk still full leaves the database where it is (never moved aside) and records nothing until the next start. A migration runs only after its snapshot is written, one transaction per step; the schema is never downgraded.

**Deploying and rolling back:** back up the whole folder with the service stopped, and check the copy (`PRAGMA quick_check` on the restored `.db` with its `-wal`). A SnapCon version from before Fleet utilization does not read the folder at all, so rolling back to it leaves the database as it was; but its `.gitignore` does not list `utilization-data/`, so add `utilization-data/` to `.git/info/exclude` before rolling back, or `git clean -fd` would remove it. Returning to a version with Fleet utilization reuses the database; the time in between is shown as Not recorded.

