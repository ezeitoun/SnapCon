# Model Library — implementation specification (v3.2, canonical)

**Status:** APPROVED. OK to Dev given 2026-09-30. M0 and M1 done (§21, §22); waiting for the owner's
approval before M2. The owner approves each milestone before the next begins.

**History:**
- v1–v3: 2026-09-28.
- v3.1: 2026-09-30. The canonical cleanup: one confidence policy (§4), one schema (§5), an
  audited authored/derived boundary (§4.6), the u1hub / 3MF Explorer ideas placed on the roadmap
  (§6.3, §6.4, §16), and a consistency audit (§19).
- v3.2: 2026-09-30. The M0 findings P1–P5 are accepted and folded into the sections they affect:
  - §5: the `files_container` index, the derived `model_families` table, and the
    `models_grid` index;
  - §6.2: an adaptive G-code read window;
  - §4.6 / §14: rebuild by drop-and-recreate, and keyset paging;
  - §15: an explicit worker entry in `pkg.scripts`, and packaged-build checks for other
    platforms.

  The measurements are in §21.

This document is the single implementation reference. Where any earlier draft or conversation
disagrees with it, this document wins.

Claims about SnapCon were checked against current source. Claims about the library were measured
on `\\192.168.2.18\SnapCon\Files` (58 G-code, 2 3MF, 5.8 GB).

### Canonical terminology

| Term | Meaning |
|---|---|
| **Model** | The thing a person thinks of ("Beardie"). Authored; owns tags, collections, notes, cover. |
| **File** | One real file on disk, or one entry inside a container (3MF picture). Has a *role*. |
| **Project** | A 3MF file's project-level data (sliced or not). One per 3MF. |
| **Plate** | One plate of a Project. |
| **Variant** | Anything printable: a plain G-code file, or one sliced Plate. |
| **Print** | One print attempt, linked to a File (and so a Variant and Model) by content key. |
| **Claim** | Something automation believes: `subject —relation→ object`, with Evidence, confidence, state. Derived. |
| **Decision** | Something a person decided. Same shape as a Claim. Authoritative. Authored. |
| **Evidence** | One observed fact supporting a Claim (§4.3). |
| **Review Item** | A question SnapCon asks the user. Shown in the UI under *Needs attention*. |

**Relations (the complete set):**
- `member_of`: File → Model.
- `same_model_as`: Model ↔ Model, merge suggestions. **Claims only**, intentionally retained,
  because a merge suggestion is naturally model-level. An accepted merge is written as
  `member_of` Decisions.
- `distinct_from`: Model ↔ Model, a rejected merge. **Decision only**.
- `source_of`: source mesh File → derived File (project or sliced).
- `sliced_from`: Variant → Project.
- `targets_printer`: Variant → printer family.
- `printed_as`: Print → File (+ plate).
- `duplicate_of`: location ↔ location.
- `moved_from`: File → previous location.
- `converted_from`: Project → Project (future).

Decisions may also carry the **attribute** `hidden` (File or Model).

---

## 1. Decisions recorded (owner)

| # | Decision |
|---|---|
| D1 | Regular and Admin users edit tags, collections, covers and grouping. View users are read-only. Permissions are refinable later without changing the data architecture (§11). |
| D2 | No physical deletion, rename or move of files in Phase 1. The only "destructive" action is **Hide from Library**. Admin-only deletion may come later (quarantine model, §16). |
| D3 | No new dependency unless necessary. Result: none needed (§10). |
| D4 | Automation follows the canonical confidence policy (§4.4). Decisions are `authoritative` and always win. Merge / split / move / approve / reject must be easy (§7). |
| D5 | A printable slice on an approved library location prints directly, with every existing compatibility, permission and safety check (§12). |
| D6 | Aggregate print counts are shown to everyone. Individual history is filtered to printers the user may see. |
| D7 | Import 90 days of past prints where reasonably confident. A filename match is never equal to a content or Variant match (§9). |
| D8 | The G-code folder uses **files** grouping. Its folders are organisational, never "one folder = one Model". |
| D9 | Phase 1 is split into 1a/1b. 3MF understanding (Bambu, Orca, Snapmaker Orca, Creality-family, where practical) is in 1a. Prusa 3MF is in 1b. No 3D viewer in Phase 1. |
| D10 | Filename-matched historical prints **count in the headline, visibly distinguished**: "17 prints · 13 confirmed · 4 matched by filename". Full provenance is kept internally. |
| D11 | Regular users may submit browser-generated covers under `library.edit.cover`. |
| D12 | The **full** Phase 1a milestone plan is selected (~40 working days). The Review Items UI in 1a is a basic list; the full page, large-photo shrinking and Prusa 3MF are in 1b. **1a still creates and stores every Review Item** with its Evidence. |
| D13 | 1a is usable end to end (§15): locations, cards, search/filter, Model page (Files, Projects, Plates, Variants, covers, printer family), basic history and counts, Print, Queue, merge / split / move / approve / reject, basic Needs attention, rescan, offline status. |
| D14 | Claims, Evidence and provenance are foundational (§4). Decisions survive moves, renames and full rebuilds wherever technically possible (§4.5, §4.6). |
| D15 | Send printer compatibility is a **separate prerequisite** (TODO §16). Its centralised printer-identity resolver is reused by the Library. **The Library contains no printer-detection logic of its own.** |
| D16 | **M4 Library Diagnostics is the hard checkpoint.** M5 does not start until the owner signs off the M4 review. Grouping-rule problems found there are fixed in M4. |
| D17 | u1hub / 3MF Explorer ideas are adopted **without expanding Phase 1a** (§18). **No geometry column is added in 1a.** Rejected u1hub behaviours are listed in §18. |
| D18 | Future "Convert for another printer / Prepare for U1" must not be blocked by the schema. It is not built now (§16.3). |
| D19 | M0 findings P1–P5 are accepted as measured implementation requirements (§21). `model_families` is a query and display optimisation only, never the source of printer identity. |

---

## 2. Research summary

**Meshory** (closed desktop app):
- File-first; ignores G-code by design. Grouping came late: archive "rollups" and folder covers.
- Tags follow a moved file only on a one-to-one fingerprint match.
- An offline source keeps its index.

**Manyfold** (open source):
- Library → Model → File with folder = model; common subfolders roll up into the parent.
- A Relationship table (`supported_version_of`, `alternative_format_of`).
- A Problems list with fix actions.
- No move detection.

**Converters** (studied only; bl2u1 and 3mf-to-u1 are GPL, OrcaSlicer is AGPL; no code copied):
- Conversion operates on the **Project** 3MF.
- "Printer-specific" means printer, process and filament profile ids, bed area/height/exclusions,
  nozzle, and machine G-code.
- Known tool flaws to avoid:
  - discarding the user's settings;
  - not re-centring objects;
  - leaving stale `plate_N.gcode`;
  - overwriting.

**OrcaSlicer format facts:**
- **Project 3MF:** object names, parts, plates and `source_file` (the original mesh basename) are
  in the small `model_settings.config`. Meshes are in `3D/Objects/*.model` and are never needed
  for metadata.
- **Sliced `.gcode.3mf`:** no `<object>` / `source_file`. Object names are in
  `slice_info.config`, and each plate has `plate_N.gcode.md5`.
- **Prusa 3MF:** INI config, inline meshes (can be huge), no plates.
- **G-code** never contains the project filename. Its config block is optional
  (`gcode_skip_config_block`).
- **Zip:**
  - sizes come from the central directory;
  - data descriptors are used;
  - zip64 is possible outside the GUI;
  - only STORE/DEFLATE;
  - the unicode-path extra field is used.

**u1hub and 3MF Explorer** (both MIT):
- **u1hub's Models tab** is a per-file 3MF browser:
  - one root and a JSON index;
  - "model" is a folder name;
  - path-keyed attributes;
  - disk rename and hard delete;
  - U1-only apart from Convert to U1.
- **3MF Explorer** is a separate localhost app:
  - SQLite, several roots;
  - content-hash-keyed tags and overrides;
  - byte and geometry duplicate detection;
  - quarantine instead of delete.
- Adopted ideas and rejected behaviours are listed in §18.

**Evidence from the real library:**
- Every G-code states its printer and profile: `printer_model`, `printer_settings_id`,
  `print_settings_id`, `filament_settings_id`, `layer_height`, `nozzle_diameter`, slicer and
  version.
- **Folders lie:** `K1C/HollowLog` is sliced for an Ender-3 V3 Plus.
- **`printer_model` can be generic:** `5M PRO/skelly` says "Generic Klipper Printer", while its
  settings id names the 5M Pro.
- MakerWorld 3MFs carry `DesignModelId` (Model identity) and `DesignProfileId` (Project
  identity).
- 3MF pictures are 12–270 KB WebP.
- `EXCLUDE_OBJECT_DEFINE` names carry the source STL filename, identical across slicers. Grouping
  on object names alone falsely merged 7 Models under `Assembly`.

---

## 3. Entity model

**Model → Files (role: `source` / `project` / `sliced` / `image` / `document` / `archive` /
`other`) → Project (one per 3MF) → Plates → Variants → Prints**, plus lineage Claims between
Files.

- A **Project** is a thin row, one per 3MF, sliced or not. A sliced 3MF gets a Project **and**
  one Variant per sliced Plate. An unsliced 3MF is a Project with no Variants.
- There is **no SourceAsset table**. A source is a File with `role='source'`. Being the source of
  something is a `source_of` Claim.

```
Model "Flexi Dragon"
 ├─ File Dragon.stl          role=source
 ├─ File Orca project.3mf    role=project → Project(orca, U1, 2 unsliced plates)
 │      Dragon.stl —source_of→ Orca project.3mf          [source_file_meta · high · applied]
 ├─ File U1-0.20-PLA.gcode   role=sliced  → Variant(U1 · 0.20 mm · PLA)
 │      Dragon.stl —source_of→ U1-0.20-PLA.gcode         [source_object_name · medium · suggested]
 │      Variant —sliced_from→ Orca project               [object_names · medium · suggested]
 ├─ File plate.gcode.3mf     role=sliced  → Project(sliced) + Plate 1 → Variant
 └─ Prints —printed_as→ File                             [snapcon_variant · exact | filename · medium]

Future: Project —converted_from→ Project                 [snapcon · exact, with a conversion manifest]
```

---

## 4. Claims, Evidence and provenance (canonical)

### 4.1 Claims and Decisions

```
resolve(subject, relation) =
    latest active DECISION (affirm or reject)           → authoritative
      (active = not superseded by a later Decision, not withdrawn by an undo)
  else strongest Claim in state 'applied'  (§4.4)
  else unresolved (Claims remain 'suggested' / 'recorded')
```

- A **reject** Decision blocks every Claim with the same subject, relation and object, now and
  after any rescan. Its state becomes `overridden`.
- Resolved results are cached on derived rows (`files.model_id`, `variants.printer_family`), each
  with the `claim_key` or `decision_id` that produced it.

### 4.2 What every Claim records

| Field | Meaning |
|---|---|
| `method` | The rule that produced the Claim (e.g. `object_names+title`, `source_file_meta`) |
| `evidence` | The Evidence list (§4.3), each item carrying its source and independence group |
| `groups` | The independence groups present |
| `confidence` | `exact` / `high` / `medium` / `low` (Decisions are implicitly `authoritative`) |
| `state` | `applied` / `suggested` / `recorded` / `overridden` / `superseded` |
| `rule_version` | The version of the rule set that produced it |
| `claim_key` | `sha1(subject_type‖subject_key‖relation‖object_type‖object_key)`: the stable reference authored rows use instead of a row id |

### 4.3 Evidence

```json
{ "signal": "source_object_name",
  "value": "MMM_Beardie_Body_v08R.stl",
  "source": "gcode:EXCLUDE_OBJECT_DEFINE",
  "excerpt": "EXCLUDE_OBJECT_DEFINE NAME=MMM_Beardie_Body_v08R.stl_id_1_copy_0",
  "group": "internal-content",
  "strength": "strong",
  "matches": "content:q:3f9a…",
  "compare": null }
```

- **`group`** is the independence group: `identity`, `internal-content`, `filename`,
  `location`, `session` or `history`.
- **`strength`** is `identity` / `strong` / `medium` / `weak` / `none`. Generic object names and
  generic titles are recorded at `none` or `weak`.
- **Filename comparisons** carry `compare: { original_a, original_b, normalized_a, normalized_b,
  transformations_a[], transformations_b[], method, score, result }` (§6.3).
- **Caps:** excerpts ≤ 200 characters; ≤ 12 items per Claim.

### 4.4 Canonical confidence policy
1. A **Decision** is `authoritative` and always wins. Automation never overrides, removes or
   re-homes it.
2. **`exact`** identity Evidence (byte identity, or SnapCon's own record of an action) may
   auto-apply.
3. A genuinely strong **identity** signal may auto-apply **only where that relation's row below
   explicitly allows it**.
4. Otherwise auto-apply needs **corroboration from at least two different independence groups**,
   each at `medium` strength or stronger. `weak` Evidence explains but never corroborates. **Two
   signals from the same group never count as independent confirmation.**
5. A single `strong` or `medium` signal alone gives `medium` confidence: a **suggestion** and a
   Review Item. Nothing changes.
6. `low` or ambiguous Evidence is **recorded only**. It is visible in Explain and Diagnostics
   and never changes the library.
7. **Generic object names never count** as corroboration: `assembly`, `object`, `body`, `part`,
   bare numbers, and any name that appears in files with unrelated titles. Generic or common
   titles are down-weighted (§6.3).
8. Automation may **raise** confidence when stronger Evidence appears (a suggestion becomes
   applied, and its Review Item auto-closes with the reason). It may lower its **own** Claims.
   It never touches a Decision.

**Relation policy, including every exception:**

| Relation | Subject → Object keys | Auto-apply allowed on | Suggestion (`medium`) | Recorded (`low`) | Explicit exceptions |
|---|---|---|---|---|---|
| `member_of` | File content key → Model uuid | exact: plate md5 = file md5 (joins the Project's Model). identity: MakerWorld `design_model_id`, or `source_file` meta naming a File already in the Model. structural: folders-mode model folder. Otherwise 2 groups corroborating | One signal (equal non-generic object set only; title only) | Weak or generic only | Folders-mode membership is structural. Nested model folders are ambiguous. |
| `same_model_as` (Claims only) | Model uuid ↔ Model uuid | Never auto-merges an existing, decided Model. Undecided automatic Models merge under the `member_of` rules | Any single signal | Weak | An accepted merge writes `member_of` Decisions. A rejection writes `distinct_from`. |
| `source_of` | source File key → derived File key | identity: `source_file` meta equals exactly **one** mesh basename in the same Model or root (a project). exact name + second group (a sliced File) | Non-generic object name = mesh basename, alone | Generic names | `source_file` is slicer-written, so identity-grade when unique. 2+ candidates are ambiguous. |
| `sliced_from` | Variant (file key#plate) → Project file key | exact: plate md5. high: object names + same `design_profile_id`. future: slicer-watch, one candidate (§16.2) | Object names alone | — | |
| `targets_printer` | Variant → printer family key | identity: Bambu `printer_model_id`. high: non-generic `printer_model` consistent with settings id / compatible printers (resolver) | Generic `printer_model` + settings-id match ("likely"); internal fields disagree | No internal evidence | **Folder names are never Evidence for this relation** (§6.4). Resolver only (D15). |
| `printed_as` | Print id → File key (+ plate) | exact: `snapcon_variant`. exact: queue `sha256` = file `sha256`. high: `content_fp` | **A unique filename is `medium`, applied as *unconfirmed*** (counted, labelled "matched by filename") | Ambiguous filename → *Unlinked print* | Only exact/high are "confirmed". |
| `duplicate_of` | location ↔ location (`root:rel_path`) | exact: equal `sha256`. high: equal `quick_fp` | — | — | Keyed by **location**, because identical files share a content key. Applying **only records** the duplicate and raises *Possible duplicate*. It never hides, merges or deletes. |
| `moved_from` | File key → previous `root:rel_path` | exact: a unique 1:1 `quick_fp` within one scan | — | Ambiguous → missing + new | |
| `converted_from` (future) | Project key → Project key | exact: `snapcon`, with a conversion manifest (§16.3) | — | — | |

### 4.5 Decisions that survive rebuilds
Deleting every derived table and rescanning re-derives the Claims, then re-applies the Decisions.
Authored rows refer only to **stable keys**:

| Decision | Stored as | Key |
|---|---|---|
| Confirmed grouping | `member_of` affirm | file content key → Model uuid |
| Confirmed separation | `member_of` reject | file content key → Model uuid |
| Rejected merge | `distinct_from` affirm | Model uuid ↔ Model uuid |
| Printer chosen by hand | `targets_printer` affirm, `value_json.printer_family` | file content key (+ plate) |
| Confirmed / rejected lineage | `source_of` / `sliced_from` affirm or reject | both content keys (+ plates) |
| Print link confirmed / changed | `printed_as` affirm | print id → content key |
| Hidden File | attribute `hidden` | file content key |
| Hidden Model, name, notes, cover | columns on `models` (`hidden`, `name` with `name_source='user'`, `notes`, `cover_content_key` with `cover_source='user'`) | Model uuid (the row itself) |
| Review Item resolution / dismissal | `review_items.status` + `resolution_decision_id` | `subject_key` built from uuids and content keys |

- The **content key** is `sha256` when known, else `q:` + `quick_fp`.
- When the full hash arrives later, authored rows keyed on the quick key are **re-keyed in
  place**. `content_aliases` resolves either form meanwhile.

**Durable identity cache (added in M4, §26).** Once a file is hashed, its authored rows are keyed
by `sha256`. A derived rebuild drops `files.sha256` and `content_aliases`, so without help every
rediscovered file would carry a quick key until the idle re-hash (hours on a NAS), and nothing
authored would match it. `identity_cache` keeps the bridge:
- **Meaning:** "the last time SnapCon fully hashed content with this fingerprint and size, the
  verified key was X". It is a reconciliation cache, **not** authored truth and **not** proof.
- **Written** by every full hash (`setHash`); seeded from the existing hashes by migration 2.
- **Used** when a scan meets new or changed content: if the (fingerprint, size) maps to
  **exactly one** verified key, the file takes that key, and its MD5, at once. `files.sha256`
  stays NULL, so the file is still hashed in the background. Diagnostics shows such a file as
  "restored from identity cache (unverified)".
- **Ambiguous:** a fingerprint that maps to two or more verified keys (a real collision, while a
  file still holds each) restores nothing. The file keeps its quick key until its own hash
  decides, and Diagnostics lists the fingerprint.
- **Verification:** when the file's own hash arrives:
  - it **matches**: the entry is confirmed; nothing moves;
  - it **differs**: the cache was wrong (stale, or a collision). The file takes its verified key
    and its own derived Claims go with it. Authored rows **stay on the old key** — an identity is
    never transferred — and grouping raises *File changed* (same location) or *Decision no
    longer matches* for them. The stale entry is dropped.
- **Never overrides** a contradictory verified hash, and never makes a key "verified":
  `duplicate_of` is `exact` only when every copy was verified by its own hash.
- **While identity is pending** (files known only by a quick key whose hash is still to come),
  grouping does not raise *File changed*, *Decision no longer matches* or *Empty model* for
  Decisions and Models on verified keys: absence proves nothing until the hash is in.

**Honest limitation:**
- A file that is **both moved and modified while unavailable** has a new location and new
  content, so nothing stable links it to its Decisions.
- SnapCon **does not guess**. The Decision is kept, and after a completed scan of that root a
  *Decision no longer matches* Review Item is raised, with Re-link / Discard.

### 4.6 Authored / identity cache / derived boundary (audited)

Three kinds of data, each with its own lifetime:

| Authored — survives any rebuild | Identity cache — survives a normal rebuild | Derived — dropped and rebuilt freely |
|---|---|---|
| `roots` (configuration columns) | `identity_cache` | `roots` runtime status columns, `scan_runs` |
| `models`, `model_anchors` | | `files`, `content_aliases`, `file_objects`, `file_titles`, `folder_classes` |
| `decisions`, `actions` (M6) | | `projects`, `plates`, `variants` |
| `review_items` | | `claims` |
| `tags`, `model_tags`, `collections`, `collection_models` | | `model_stats`, `model_families` |
| `prints` | | `thumbs`, `model_fts` |
| `permission_grants` | | |

- **Authored durable data:** what people decided and what happened.
- **Durable identity / reconciliation cache:** what full hashes verified about content (§4.5).
  Nobody's decision, and never proof: it lets rediscovered files find their stable content keys
  before the re-hash. A normal derived rebuild keeps it. Only the explicit **identity reset**
  (`resetIdentityCache()`, no Phase 1 UI) empties it, to rebuild identity from full hashes
  alone; that never touches authored rows, which re-attach as files are hashed again.
- **Rebuildable derived index:** what the indexer recomputes from the files.

**Rules:**
1. **Authored → derived:** never by row id, and **no foreign keys**. Only content keys, plate
   numbers, locations, `claim_key`, Model uuids and print ids.
2. **Authored → authored:** integer ids are allowed (same lifetime). Export/import re-maps them
   through uuids.
3. **Derived → authored:** ids are allowed (`files.model_id`, `files.model_decision_id`,
   `variants.printer_decision_id`, `model_stats.model_id`). Derived rows are rebuilt after
   authored ones.
4. **Automatic Models are authored rows**, so tags and notes on them survive. `model_anchors`
   keeps each Model's last-known member content keys. After a rebuild:
   - an automatic cluster is matched to the existing Model with the **largest unique overlap**
     (at least half of the cluster);
   - no match creates a new Model;
   - a conflict raises *Ambiguous grouping*;
   - a Model left with no present Files raises *Empty model*.

   **Nothing authored is deleted automatically.**
5. **Counters** live in derived `model_stats`, recomputed from `prints` + resolution.
   **`model_families`** (P3) caches which printer families each Model has Variants for, for the
   grid's printer filter and facets.
   - It is a query and display optimisation only, **never** the source of printer identity. That
     stays with the shared resolver (D15) and `targets_printer` Claims and Decisions.
   - It is recomputed from `variants.printer_family`, itself a resolution cache (§4.1).
   - Dropping it loses nothing.
6. **Removing a root** (admin) cascades only its derived rows. Its Decisions, Prints and Models
   are kept. The files show as missing and the Decisions remain for Re-link.
7. **Rebuilding the derived index** (P4) drops and recreates every derived table inside one
   transaction, instead of deleting rows.
   - M0 measured a `DELETE` cascade at 12 s for 100k files, and quadratic without the
     `files_container` index.
   - Foreign-key enforcement is switched off for the drop only. That is safe because no
     authored table references a derived one (rule 1).
   - The authored tables, the runtime status columns of `roots` and the identity cache are not
     touched.
   - A test proves every authored row survives; another that the identity cache does.

---

## 5. SQLite schema (canonical; `library-data/library.db`, WAL, `PRAGMA foreign_keys=ON`)

```sql
-- ================================ AUTHORED ================================

CREATE TABLE roots (
  id TEXT PRIMARY KEY,                       -- 'gcode' = implicit root mirroring CFG.gcodeFolder
  name TEXT NOT NULL, path TEXT NOT NULL,
  grouping TEXT NOT NULL DEFAULT 'folders' CHECK (grouping IN ('folders','files')),
  enabled INTEGER NOT NULL DEFAULT 1,
  scan_every_min INTEGER NOT NULL DEFAULT 30,
  full_hash TEXT NOT NULL DEFAULT 'idle' CHECK (full_hash IN ('off','idle')),
  created_at INTEGER NOT NULL, created_by TEXT,
  -- runtime status, written by the indexer:
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','scanning','ok','offline','error')),
  last_scan_at INTEGER, last_ok_at INTEGER, last_error TEXT);

CREATE TABLE models (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('auto','user')),        -- who created the row
  name TEXT NOT NULL,
  name_source TEXT NOT NULL DEFAULT 'auto' CHECK (name_source IN ('auto','user')),
  anchor_root TEXT, anchor_path TEXT,        -- folders-mode anchor (a location, not a row id)
  design_model_id TEXT,
  designer TEXT, source_url TEXT, license TEXT, notes TEXT,
  cover_content_key TEXT, cover_plate INTEGER,
  cover_source TEXT NOT NULL DEFAULT 'auto' CHECK (cover_source IN ('auto','user')),
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT,
  merged_into TEXT);                         -- M6: the surviving Model's uuid after a merge; the row is kept
CREATE INDEX models_design ON models(design_model_id);
CREATE INDEX models_grid   ON models(hidden, updated_at, id);   -- P3: keyset paging of the grid

CREATE TABLE model_anchors (                 -- last-known membership, used to re-find Models after a rebuild
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  content_key TEXT NOT NULL, last_seen INTEGER NOT NULL,
  PRIMARY KEY (model_id, content_key));
CREATE INDEX model_anchors_key ON model_anchors(content_key);

CREATE TABLE actions (                      -- M6: what a person did in the Library: history and undo
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('merge','split','move','approve','reject','dismiss',
    'hide','unhide','hide_file','unhide_file','rename','cover','set_printer')),
  model_uuid TEXT, other_model_uuid TEXT,
  detail_json TEXT NOT NULL,                 -- what changed: Decisions written and superseded, prior values
  user_id TEXT, user_label TEXT,
  created_at INTEGER NOT NULL,
  undone_at INTEGER, undone_by TEXT);
CREATE INDEX actions_model ON actions(model_uuid, created_at);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('file','variant','model','print')),
  subject_key TEXT NOT NULL,                 -- content key | content key#plate | model uuid | print id
  relation TEXT NOT NULL CHECK (relation IN
    ('member_of','distinct_from','source_of','sliced_from','targets_printer','printed_as','hidden')),
  polarity TEXT NOT NULL DEFAULT 'affirm' CHECK (polarity IN ('affirm','reject')),
  object_type TEXT,                          -- model|file|variant|project|printer_family|NULL (attribute)
  object_key TEXT,
  value_json TEXT,                           -- e.g. {"printer_family":"snapmaker-u1"}, {"plate":2}
  subject_hint TEXT,                         -- last known "root:rel_path", for display and Re-link
  reason TEXT,
  from_claim_key TEXT,                       -- the Claim this confirmed or rejected
  evidence_snapshot_json TEXT,               -- that Claim's Evidence at decision time
  created_by TEXT, created_at INTEGER NOT NULL,
  superseded_by INTEGER REFERENCES decisions(id),    -- replaced by a later Decision; history kept
  action_id INTEGER REFERENCES actions(id),          -- the M6 action that wrote it
  withdrawn_at INTEGER);                     -- undone with no replacement; history kept
CREATE INDEX decisions_subject ON decisions(subject_type, subject_key, relation);
CREATE INDEX decisions_object  ON decisions(object_type, object_key);

CREATE TABLE prints (
  id INTEGER PRIMARY KEY,
  content_key TEXT,                          -- linked File; NULL = unlinked
  plate_no INTEGER,
  model_uuid_at_link TEXT,                   -- snapshot fallback; the current Model is resolved via content_key
  printer_id TEXT NOT NULL, printer_name TEXT, remote_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('library','send','queue','printer_storage','external','backfill')),
  link_method TEXT NOT NULL CHECK (link_method IN ('snapcon_variant','queue_sha256','content_fp','filename','none')),
  link_confidence TEXT NOT NULL CHECK (link_confidence IN ('exact','high','medium','low','none')),
  link_evidence_json TEXT, link_rule_version INTEGER,
  link_decision_id INTEGER REFERENCES decisions(id),
  user_id TEXT, user_label TEXT,
  started_at INTEGER, ended_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'printing'
    CHECK (outcome IN ('printing','completed','failed','cancelled','unknown')),
  elapsed_sec INTEGER, filament_g REAL, cost_est REAL,
  audit_ref INTEGER,                         -- audit_log row id (observed or backfilled events)
  via TEXT CHECK (via IN ('print','queue')), -- M7: how SnapCon started it; NULL = not by SnapCon, or not known
  location TEXT,                             -- M7: 'root:rel_path' of the file SnapCon sent, when known
  queue_item_id TEXT,                        -- M7: the queue item it came from
  job_key TEXT);                             -- M7: one row per job, however many times it is reported
CREATE INDEX prints_key  ON prints(content_key, started_at);
CREATE INDEX prints_open ON prints(printer_id, remote_name, outcome);
CREATE UNIQUE INDEX prints_job ON prints(job_key);
CREATE INDEX prints_audit ON prints(audit_ref);

CREATE TABLE print_imports (                 -- M7: each import of print history from the audit log (§9)
  id INTEGER PRIMARY KEY, ran_at INTEGER NOT NULL,
  from_ts INTEGER, to_ts INTEGER, created INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
  report_json TEXT NOT NULL);

CREATE TABLE review_items (                  -- shown as "Needs attention"
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                        -- §8
  subject_key TEXT NOT NULL UNIQUE,          -- stable: kind + uuids / content keys / locations
  claim_key TEXT,                            -- the raising Claim (stable key, not a row id)
  model_uuid TEXT, other_model_uuid TEXT,
  content_key TEXT, other_content_key TEXT,
  location TEXT, other_location TEXT,        -- 'root:rel_path' where a location matters
  print_id INTEGER REFERENCES prints(id) ON DELETE SET NULL,
  confidence TEXT, summary TEXT,
  evidence_json TEXT,                        -- Evidence snapshot when raised or last updated
  priority INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed','auto_closed')),
  resolution_decision_id INTEGER REFERENCES decisions(id),
  resolution_note TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  resolved_by TEXT, resolved_at INTEGER);
CREATE INDEX review_open ON review_items(status, kind);

CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT);
CREATE TABLE model_tags (
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  added_by TEXT, added_at INTEGER, PRIMARY KEY (model_id, tag_id));
CREATE TABLE collections (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT,
  cover_model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
  owner_user_id TEXT,                        -- NULL = shared; private collections later
  created_by TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE collection_models (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  position INTEGER, added_by TEXT, PRIMARY KEY (collection_id, model_id));

CREATE TABLE permission_grants (
  subject_type TEXT NOT NULL CHECK (subject_type IN ('role','group','user')),
  subject_id TEXT NOT NULL, capability TEXT NOT NULL, allow INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (subject_type, subject_id, capability));

-- ============================ IDENTITY CACHE (durable) ============================
-- Neither authored nor derived (§4.6): what full hashes verified. Kept by a
-- normal rebuild; emptied only by the explicit identity reset.

CREATE TABLE identity_cache (
  quick_fp TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, md5 TEXT,
  verified_at INTEGER NOT NULL,              -- when the full hash last confirmed it
  PRIMARY KEY (quick_fp, size, sha256));

-- ================================ DERIVED (rebuildable) ================================

CREATE TABLE scan_runs (
  id INTEGER PRIMARY KEY, root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  started_at INTEGER, finished_at INTEGER,
  seen INTEGER, added INTEGER, changed INTEGER, moved INTEGER, missing INTEGER, errors INTEGER,
  outcome TEXT);

CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  entry_path TEXT NOT NULL DEFAULT '',       -- '' = real file; else an entry inside the container
  container_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL, ext TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('source','project','sliced','image','document','archive','other')),
  size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
  quick_fp TEXT NOT NULL, sha256 TEXT, md5 TEXT,
  content_key TEXT NOT NULL,                 -- sha256 if known, else 'q:'||quick_fp
  meta_version INTEGER NOT NULL DEFAULT 0, meta_json TEXT,
  thumb_key TEXT,
  state TEXT NOT NULL DEFAULT 'present' CHECK (state IN ('present','missing','unreadable')),
  hidden INTEGER NOT NULL DEFAULT 0,         -- cache of a 'hidden' Decision
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, missing_since INTEGER,
  model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,     -- resolution cache (§4.1)
  model_claim_key TEXT, model_decision_id INTEGER REFERENCES decisions(id),
  UNIQUE (root_id, rel_path, entry_path));
CREATE INDEX files_ck  ON files(content_key);  CREATE INDEX files_fp    ON files(quick_fp);
CREATE INDEX files_md5 ON files(md5);          CREATE INDEX files_model ON files(model_id);
-- P1 (M0): required, not optional. Without it, deleting files scans the whole table once per row
-- (the self-referencing container_id foreign key), and a 10k-file rebuild never finished.
CREATE INDEX files_container ON files(container_id);

CREATE TABLE content_aliases (alias TEXT PRIMARY KEY, content_key TEXT NOT NULL);   -- 'q:…' → sha256

CREATE TABLE file_objects (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name_norm TEXT NOT NULL, raw_name TEXT, copies INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL CHECK (origin IN
    ('exclude_object','printing_object','m486','slice_info','model_settings','source_file','mesh_basename')),
  generic INTEGER NOT NULL DEFAULT 0, excerpt TEXT,
  PRIMARY KEY (file_id, name_norm, origin));
CREATE INDEX file_objects_name ON file_objects(name_norm);

CREATE TABLE file_titles (                   -- title normalisation, kept for Explain/Diagnostics (§6.3)
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  original TEXT NOT NULL, normalized TEXT NOT NULL,
  transformations_json TEXT NOT NULL,        -- [{"rule":"copy_count","removed":"4x"}, …]
  token_count INTEGER NOT NULL, generic_score REAL NOT NULL DEFAULT 0,
  rule_version INTEGER NOT NULL);
CREATE INDEX file_titles_norm ON file_titles(normalized);

CREATE TABLE folder_classes (                -- folder classification, with provenance (§6.4)
  root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('format','printer_family_like','designer','unknown')),
  method TEXT NOT NULL, evidence_json TEXT NOT NULL, rule_version INTEGER NOT NULL,
  PRIMARY KEY (root_id, rel_path));

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE,
  flavour TEXT NOT NULL CHECK (flavour IN ('bambu','orca','snapmaker_orca','creality','prusa','other')),
  producer TEXT, producer_version TEXT, title TEXT, designer TEXT, license TEXT, origin TEXT,
  design_model_id TEXT, design_profile_id TEXT, profile_title TEXT,
  printer_model TEXT, printer_model_id TEXT, printer_settings_id TEXT, print_settings_id TEXT,
  filament_settings_json TEXT, layer_height REAL, nozzle REAL,
  plate_count INTEGER, sliced_plate_count INTEGER, config_hash TEXT);
CREATE INDEX projects_design ON projects(design_model_id);

CREATE TABLE plates (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plate_no INTEGER NOT NULL, name TEXT, sliced INTEGER NOT NULL,
  objects_json TEXT, thumb_key TEXT, gcode_md5 TEXT,
  UNIQUE (project_id, plate_no));
CREATE INDEX plates_md5 ON plates(gcode_md5);

CREATE TABLE variants (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  plate_no INTEGER,                          -- NULL = plain G-code
  printer_family TEXT,                       -- resolution cache (§4.1)
  printer_claim_key TEXT, printer_decision_id INTEGER REFERENCES decisions(id),
  printer_model TEXT, printer_model_id TEXT, printer_settings_id TEXT, print_settings_id TEXT,
  compatible_printers TEXT, filament_settings_json TEXT, filaments_json TEXT,
  layer_height REAL, nozzle REAL, bed_json TEXT,
  slicer TEXT, slicer_version TEXT,
  config_block INTEGER NOT NULL DEFAULT 0, config_hash TEXT,
  est_seconds INTEGER, weight_g REAL, copies INTEGER, color_count INTEGER,
  UNIQUE (file_id, plate_no));
CREATE INDEX variants_family ON variants(printer_family);

CREATE TABLE claims (
  id INTEGER PRIMARY KEY,
  claim_key TEXT NOT NULL UNIQUE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('file','variant','model','print','location')),
  subject_key TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN
    ('member_of','same_model_as','source_of','sliced_from','targets_printer',
     'printed_as','duplicate_of','moved_from','converted_from')),
  object_type TEXT NOT NULL CHECK (object_type IN
    ('model','file','variant','project','printer_family','location')),
  object_key TEXT NOT NULL,
  method TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('exact','high','medium','low')),
  state TEXT NOT NULL CHECK (state IN ('applied','suggested','recorded','overridden','superseded')),
  automatic INTEGER NOT NULL DEFAULT 1,
  groups TEXT NOT NULL,                      -- e.g. 'internal-content,filename'
  evidence_json TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX claims_subject ON claims(subject_type, subject_key, relation);
CREATE INDEX claims_object  ON claims(object_type, object_key);
CREATE INDEX claims_state   ON claims(state, confidence);

CREATE TABLE print_links (                   -- M7: each Print's current Model and Variant, resolved (§9)
  print_id INTEGER PRIMARY KEY REFERENCES prints(id) ON DELETE CASCADE,
  model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
  variant_key TEXT,                          -- content key (#plate); NULL = linked to the Model only
  confidence TEXT NOT NULL, method TEXT NOT NULL,
  by_decision INTEGER NOT NULL DEFAULT 0);
CREATE INDEX print_links_model ON print_links(model_id);

CREATE TABLE model_stats (                   -- recomputed from prints + resolution
  model_id INTEGER PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  print_count INTEGER NOT NULL DEFAULT 0,
  print_count_confirmed INTEGER NOT NULL DEFAULT 0,    -- exact|high
  print_count_filename INTEGER NOT NULL DEFAULT 0,     -- medium, "matched by filename"
  last_printed_at INTEGER);

-- P3 (M0): the grid's printer filter and facet counts read this, not variants. M0 measured
-- 363 ms for facet counts over variants at 100k files. A query cache only: recomputed from
-- variants.printer_family, never the source of printer identity (§4.6 rule 5).
CREATE TABLE model_families (
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  printer_family TEXT NOT NULL,
  variant_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model_id, printer_family));
CREATE INDEX model_families_family ON model_families(printer_family, model_id);

CREATE TABLE thumbs (
  key TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('embedded','original','client','render')),
  mime TEXT NOT NULL, bytes INTEGER NOT NULL, w INTEGER, h INTEGER,
  created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);

CREATE VIRTUAL TABLE model_fts USING fts5(name, designer, tags, collections, file_names,
  object_names, project_titles, notes, search_terms, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
```

**Size (measured in M0):** 39.7 MB at 10k files, 198 MB at 50k, 398 MB at 100k. Claims are 36% of
that and Evidence 18% (§21).

---

## 6. Indexing and extraction

### 6.1 Pipeline
One worker thread, one root at a time:
1. reachability check;
2. enumerate and stat;
3. `quick_fp` for new or changed files (full hash later, at idle);
4. `moved_from` Claims;
5. extraction;
6. title normalisation (`file_titles`) and folder classification (`folder_classes`);
7. Claim evaluation for changed subjects;
8. resolution and anchor matching;
9. Review Items;
10. `model_stats`, `model_families` and FTS.

Rules that apply throughout:
- **Offline** changes no rows. A **missing** file gets a 30-day grace period, and Decisions
  survive a purge.
- **Throttling:** a bandwidth budget, concurrency 1, and **a pause while SnapCon uploads to a
  printer**.
- Unchanged files cost one stat.

### 6.2 Extraction
- **G-code**, read through an **adaptive window** (P2):
  - **Initial window: the first 512 KB and the last 256 KB.**
  - **Why:** in M0, across all 58 real G-code files, the furthest thumbnail and
    `EXCLUDE_OBJECT_DEFINE` data ended 135 KB into the file, and the config block started at most
    32 KB from its end. Over the NAS this window cost 15–74 ms per file, against 228–274 ms for
    the former 3 MB + 3 MB.
  - **Adaptive:**
    - If the head window ends inside the thumbnail or object-definition section, or ends before
      the print body starts (no `; EXECUTABLE_BLOCK_START` / first move seen), the head is grown
      (×4 each time) up to 3 MB.
    - If the tail window holds no config block (no `; CONFIG_BLOCK_START` and no
      `; printer_model =`), the tail is grown the same way up to 3 MB.
    - Past 3 MB, extraction falls back to the parser's existing streamed parse, as `/api/map`
      does today.
    - The window actually used is recorded in `meta_json`, so Diagnostics can show files that
      needed more than the initial window.

  Nothing assumes that future G-code matches the 58-file sample. Fields read from the window:
  - thumbnails and `generated by`;
  - object names from `EXCLUDE_OBJECT_DEFINE` / `; printing object` / `M486`, with copy counts
    and excerpts;
  - config-block profile identity (a missing block gives nulls and `config_block=0`);
  - palette, time and weight from `parser.js`.
- **3MF (1a)** — Bambu / Orca / Snapmaker Orca / Creality-family where practical; Prusa in 1b:
  - Central-directory **range reads** (as in u1hub): STORE/DEFLATE, zip64, unicode names, entry
    caps.
  - `3dmodel.model` metadata only when small; otherwise a head-only read.
  - `model_settings.config` (objects, `source_file`, plates), `project_settings.config`
    (profile), `slice_info.config` (sliced plates, printer id, prediction, weight, filaments,
    object names).
  - `plate_N.gcode.md5` and thumbnails (the small plate PNG first, then plate, then
    `thumbnail_3mf`).
  - `Auxiliaries/*` pictures and documents become entry Files (`container_id`, `entry_path`).
  - Anything unrecognised is `flavour='other'`. **Unreadable is a Review Item, never a crash.**
- **`threemf.js`:** `read()` stays byte-identical for the Bambu connector; new functions sit
  beside it.
- **Printer family:** only from internal Evidence through the centralised resolver (D15), under
  the `targets_printer` policy (§4.4).

### 6.3 Filename and title normalisation (M4, M7)
**Two separate uses, never mixed:**
1. **Candidate discovery.** Aggressive normalisation is allowed. Its only job is to find pairs
   worth comparing.
2. **Evidence.** A comparison becomes an Evidence item (group `filename`) whose strength is set
   by the conservative rules below. **Normalisation never manufactures strong Evidence.**
   Stripping terms does not make two Files the same Model.

**Stored:**
- per File (`file_titles`): original, normalised value, each transformation (the rule and what it
  removed), token count, generic score, rule version;
- per comparison (`compare` in the Evidence): both originals, both normalised values, both
  transformation lists, the method, the score and the result.

**Transformations** (candidate discovery):
- copy counts (`4x`, `x24`, `24x`);
- `plate N`;
- Orca material/time tails (`_PLA_3h55m`) and trailing time, weight, colour or temperature
  parentheticals;
- filament words;
- known designer and collection names;
- known format-folder tokens.

**Evidence strength:**

| Comparison | Strength |
|---|---|
| Exact normalised title, ≥ 2 meaningful tokens, not generic | `medium` |
| Whole-word containment | `weak` |
| Other similarity | `weak` or none |
| One-word titles | Exact only; otherwise `none` |
| Names under 4 characters | Never fuzzy-matched |
| Generic or common titles (`stand`, `holder`, `test`, `benchy`, `calibration`, …) | At most `weak`, by `generic_score` |

- **Ties never share credit.** Ambiguity becomes a Review Item.
- **Prints:** a unique filename match is `medium`, visibly "matched by filename". An ambiguous one
  is `low` → *Unlinked print*. Reports state **"matched N of M"**.
- **Copies** come from G-code object metadata (`_copy_M` counts). A filename count is weak
  corroboration only.

### 6.4 Folder classification (M2, M4)
- Each folder level is classified as `format` / `printer_family_like` / `designer` / `unknown`,
  with method, Evidence and rule version (`folder_classes`).
- **How:**
  - a format-token pattern;
  - a match against printer-family names **supplied by the resolver** (no separate list);
  - "subfolders appear as designers elsewhere".
- **Uses:** navigation, candidate discovery, Diagnostics, and weak `location` Evidence for
  grouping (a designer folder).
- **Never:** **a folder is never Evidence for `targets_printer`.** A printer-looking folder may
  only:
  - help navigation;
  - help candidate discovery;
  - raise *Folder disagrees with file*;
  - appear in Diagnostics.

---

## 7. Grouping and manual control

- **Root modes:** `folders` (a downloaded pack; the model folder is structural; common subfolders
  roll up into the parent; nested model folders are ambiguous) and `files` (the G-code folder,
  D8).
- Automatic grouping follows §4.4 exactly. Diagnostics shows, for every non-applied Claim, **the
  requirement that was missing**, e.g. "only one independence group" or "generic object name".
- **Checked against the real library:**
  - Beardie (object names + title) groups across AD5X/I7.
  - The `Assembly` files form an ambiguous cluster, not a merge.
  - Butterfly Dragon 3 vs 4 colours and Lupa vs "Lupa, 3 Colors" become suggestions.

**Manual tools (M6, as built).** Each writes authored state — a Decision, or an authored `models`
column — and is recorded in `actions` (who, when, what it wrote and replaced). Grouping runs in the
same transaction, so the Library shows at once what a rebuild would show. All requests address
stable keys (Model uuids, content keys, Review Item ids) and answer **409 with a code** when they
no longer apply (`stale_file`, `model_merged`, `review_resolved`, `undo_blocked`, …).

| Action | Where | What is written | Capability |
|---|---|---|---|
| Merge A into B | Model → More… → "Merge into another model…" (pick B, the name, the cover) | `member_of` affirm for every File of A → B (earlier placements superseded); A keeps its row with `merged_into = B` (never deleted); B's authored values win, A's fill only what B lacks unless the person chose A's name or cover; tags and collections united; `distinct_from` with a third Model carried to B; suggestions between A and B resolved | `library.edit.grouping` |
| Separate (split) | File ⋯ or ticked files → "Separate N files into a new model…" | new Model (`origin='user'`, the given name); `member_of` affirm → new; `member_of` reject → old | `library.edit.grouping` |
| Move | File ⋯ or ticked files → "Move N files…"; an ambiguous file → "Choose model…" | `member_of` affirm → target; `member_of` reject → source | `library.edit.grouping` |
| Approve a suggestion | Model page or Needs attention → "Merge…" (pick which stays) | a merge, its Decisions keeping the Claim (`from_claim_key`) and its Evidence (`evidence_snapshot_json`); the item resolved | `library.edit.grouping` |
| Reject a suggestion | "Keep apart…" | `distinct_from` (Models), with the Claim and Evidence; the item resolved; never suggested again, and a later automatic merge between them is blocked | `library.edit.grouping` |
| Dismiss | any Review Item | `review_items.status = 'dismissed'` | `library.review` |
| Set printer | File ⋯ → "Set printer…" | `targets_printer` affirm, `value_json` `{printer_family, fileSays}`; the file's own Claim is kept and shown ("file says X → set to Y") | `library.edit.metadata` |
| Hide / unhide a File | File ⋯ / Hidden files | `hidden` affirm / withdrawn (files.hidden is a cache of it) | `library.hide` |
| Hide / unhide a Model | Model → More… / the hidden banner; "Show hidden models" in the grid | `models.hidden` | `library.hide` |
| Rename | Model → Rename… ("Use the automatic name again" returns it to grouping) | `models.name` + `name_source='user'` | `library.edit.metadata` |
| Cover | Model → Change cover… (any picture of the Model: images, plate pictures, file thumbnails) | `models.cover_*` + `cover_source='user'`; a picture that disappears falls back to the §10 order, and the page says so | `library.edit.cover` |

**Structure is not grouping.** A Plate, a Variant or an entry inside a 3MF belongs to its file:
it moves with the file and is never moved, separated or hidden on its own (`structural`, 400).
Identical files share a content key, so their copies move together.

**Undo (M6).** Every action can be undone from the flash that follows it or from the Model's
Changes list, after a reload or a rebuild, by anyone holding the same capability. Undo reverses
that one action exactly: the Decisions it wrote are **withdrawn** (`withdrawn_at`, kept), the
Decisions it replaced are in force again, `models` columns return to their earlier values,
Review Items it closed reopen (grouping closes them again if the condition is gone), each moved
file's last-known membership anchor returns to its earlier Model, and a Model it created is kept
with `merged_into` its origin. Automatic grouping then recomputes everything not decided. Undo is
refused (409 `undo_blocked`) while a later action depends on it — a later Decision replaced one of
its own, or a `models` column it set has changed since — and the action stays in the history
marked undone.

Not in Phase 1a M6: confirming or rejecting lineage (`source_of` / `sliced_from` Decisions; the
real library has no lineage suggestion to act on), merging several Models at once from the grid,
notes, tags and collections (1b), browser-made covers (1b, §10), approve/reject inside Diagnostics
(the Library page does it; Diagnostics shows the result).

A Model with any grouping Decision is pinned: automation may add newly matching Files, but never
remove or re-home a decided one. A merged-away Model never takes a cluster again; a Decision that
still names it follows `merged_into` to the survivor.

---

## 8. Review Items ("Needs attention")

1a **creates and stores every kind**, with an Evidence snapshot:
- M4 shows them in Diagnostics.
- M5 adds a basic Library list with Explain and the primary actions, plus a header count.
- 1b adds the full page.

| Kind | Raised when | Actions → what is written |
|---|---|---|
| `suggested_match` | `member_of` / `same_model_as` at `medium` | Merge → `member_of` affirm · Not the same → `distinct_from` / `member_of` reject |
| `ambiguous_grouping` | A File matches 2+ Models equally; a generic-name cluster; nested model folders; an anchor conflict | Choose → `member_of` affirm · Keep separate → `distinct_from` |
| `possible_duplicate` | `duplicate_of` applied | Keep all → dismiss · Hide copy → `hidden` · Show locations → none |
| `source_may_match` | `source_of` at `medium` | Link → `source_of` affirm · Not related → `source_of` reject |
| `unknown_printer` | `targets_printer` below `high` | Set printer → `targets_printer` affirm · Dismiss |
| `folder_disagrees` | A printer-like folder contradicts the File's resolved printer | Dismiss (informational) |
| `missing_file` | Root reachable, file gone | Rescan → none · Remove now → purge the derived row (Decisions kept) · Dismiss |
| `source_offline` | Root unreachable | Recheck (admin) → none |
| `no_cover` | No image or embedded thumbnail | Choose cover → `models.cover_*` · Dismiss |
| `file_changed` | Content changed **and** the File has Prints, Decisions or queued jobs | Accept new version → Decisions re-keyed to the new content key · Details |
| `unreadable_file` | Corrupt or over-limit container, parse error | Rescan · Dismiss |
| `unlinked_print` | A print whose name fits files of several Models (`low`), or a generic name with Library candidates (`none`, informational) | Link → `printed_as` affirm on the Print, to one of the Models offered (the `approve` action; undoable) · Dismiss |
| `decision_unmatched` | A Decision's key is not found after a completed scan | Re-link → Decision re-keyed · Discard → Decision superseded |
| `empty_model` | A Model with no present Files | Hide → `models.hidden` · Merge into… → `member_of` affirm · Keep → dismiss |

Items are keyed by `subject_key`, so resolutions and dismissals persist through rescans and
rebuilds. They auto-close, with the reason, when the condition clears.

---

## 9. Print history
A Print (`prints`, authored) is a fact: a job ran on a printer, at a time, with a file of some name.
The row is written once, when the job starts (or when it is imported, below), and afterwards only
gains how it ended. **One row per job:** `job_key` is unique (`print:<job id>`, `queue:<item id>`,
`printfile:…`, `observed:…`, `audit:<audit row>`), and `audit_ref` keeps the audit row that reported
it, so the same job reported twice changes nothing.

- **Links** (`printed_as`, stored on `prints`, with method, confidence, Evidence and rule version):
  | Method | Confidence | When |
  |---|---|---|
  | `snapcon_variant` | `exact` | Printed or queued from a Model page; the server checked the file is still that Variant (index key; size and modified time; sha256 known or computed before sending). |
  | `queue_sha256` | `exact` | The queue's verified hash (at dispatch) is a Library file's. |
  | `content_fp` | `high` | Sent from a file the index had read, unchanged since (location, size, modified time). |
  | `filename` | `medium` | The only Library content with this file name, "matched by filename": never verified. Several files with the name, all in one Model: the Model only. |
  | `filename` | `low` | The name fits files of several Models: **unlinked**, uncounted, an `unlinked_print` Review Item. |
  | `none` | `none` | Not in the Library, or a **generic name** (`genericNames.js`, the title rules of §6.3: "Assembly", "Benchy", "… Stand", "… Body"): never linked by name; a Review Item (informational) when the Library has candidates. |
  A person's `printed_as` Decision on the Print wins over all of it, and is undone like any action.
- **Where it is now** (`print_links`, derived, recomputed after every grouping and every recorded
  Print): the Model that holds the Print's content now, through the files that hold it. Rename, move
  by Decision, merge and its undo therefore show the same Print in the right place without rewriting
  it; `model_uuid_at_link` keeps which Model it was in when it ran ("Printed while it was part of …",
  "Printed as …, since merged into this model"). A Model-only link follows `merged_into`.
- **The copy sent:** `location` (`root:rel_path`) records the physical file SnapCon sent, when it
  sent one, besides its content identity.
- **Sent now, started later (M7.1):** a send deferred until the printer is free, or uploaded now and
  started later from the printer, keeps what was sent — plate, location, Library Variant and its
  verified hash — through the deferred state, the printer's "ready" file (persisted across
  restarts) and the start from the printer's storage. The Print is then `snapcon_variant`/`exact`
  ("sent from the Library, started later from the printer"), unless the printer's copy is no longer
  SnapCon's (gone, or another size: linked by name like any other); a printer that cannot list its
  files keeps what SnapCon recorded and says it was not checked. A Variant whose file changed before
  the deferred upload is not sent as that Variant. Another upload of the same name replaces the
  staged entry.
- **Outcome hooks** sit next to the `notifyTick` audit calls. An outcome closes the job open on that
  printer if the names match (compared without folder and extension) or it started within 3 days. A
  new start ends a job still open on the printer as `unknown` — never guessed as completed.
- **Import from the audit log (D7):** a minute after every start, and on request (Diagnostics
  capability), the last 90 days of `print-started`, `queue-print-started`, `print-completed`,
  `-cancelled`, `-error`. Starts are paired with the outcomes that follow on the same printer; an
  outcome with no start in the window is a Print with an unknown start; a printer's last start stays
  `printing` only if it began within 3 days. Links: by name at most `medium`; `queue_sha256` where
  the queue's recent history recorded the hash. Repeating it adds nothing (each event is behind at
  most one Print); it also fills in jobs from while the Library was down. Each run is kept in
  `print_imports` with its report.
- **Display (D10):** "17 prints · 13 confirmed · 4 matched by filename" on the Model page and a count
  on the card; each row says Confirmed or Matched by filename, how it started (sent from SnapCon,
  from the queue, from the printer's storage, started on the printer, found in the log) and the
  outcome where it is known. Counts come from `model_stats` (confirmed = `exact`/`high`/a Decision).
- **Visibility (D6):** counts are global; rows, and `unlinked_print` items, only for printers
  `printerVisibleTo` the person (a printer since removed: admins only). Nothing says which or how many
  other printers there are, beyond "Only prints on printers you can see are listed."

---

## 10. Covers and thumbnails (no dependency)
- **Embedded PNGs** (G-code, 3MF plates, `thumbnail_3mf`) are copied byte-for-byte.
- **Images ≤ 300 KB** are served as-is.
- **Large images:**
  - 1a: the embedded thumbnail or a placeholder.
  - 1b: the browser downscales via `OffscreenCanvas` (JPEG ~480 px) and POSTs it under
    `library.edit.cover` (D11), validated for magic bytes, ≤ 200 KB and ≤ 512 px.
- **Cover order:**
  1. user choice (`cover_source='user'`);
  2. an image in the Model;
  3. 3MF plate / `thumbnail_3mf`;
  4. the largest G-code thumbnail;
  5. a render (Phase 2);
  6. a placeholder and `no_cover`.
- **Cache:** content-keyed (`thumbs`), long cache + ETag, evicted least-recently-used above a cap
  (default 1 GB).

---

## 11. Permissions

Code checks capabilities (`libraryCan(user, cap)`). `permission_grants` is seeded with role rows
only.

| Capability | view | regular | admin |
|---|---|---|---|
| `library.view`, `library.download` | ✓ | ✓ | ✓ |
| `library.edit.metadata` · `library.edit.collections` · `library.edit.cover` · `library.edit.grouping` · `library.review` · `library.hide` | | ✓ | ✓ |
| `library.rescan` (rescan a location from the Library page; answers never carry its folder) | | ✓ | ✓ |
| `library.sources.manage` · `library.backup` · `library.diagnostics` · `library.files.delete` (future) | | | ✓ |

- Printing stays on the existing `requireRegular` + `printerVisibleTo` + maintenance +
  busy/active-file/dedup/brand checks.
- Library edits are written to the audit log (category `library`): `model-merge`, `model-move`,
  `model-split`, `model-approve`, `model-reject`, `model-dismiss`, `model-hide`/`-unhide`,
  `model-hide-file`/`-unhide-file`, `model-rename`, `model-cover`, `model-set-printer`,
  `model-change-undone`, with the person, the action id and Model names — never folder paths.
- Every M6 action checks its capability on the server (§7 table); undo needs the same one.
- M7: a print or queue from the Library adds `library: { model, modelName, location (the location
  id), content (key prefix) }` to the existing `print-started`, `queue-item-added`, `queue-bulk-send`
  and `queue-print-started` events (the last also `relocated: { from, to }` location ids); linking an
  unlinked print is `model-approve` with `print: { id, file }`; running the import is
  `print-history-imported`. Stable ids and file names, never a folder path.
- With users off, everything is implicitly admin.

---

## 12. Printing from any approved location
- File references are `(rootId, relPath)`. No root, or `gcode`, is the G-code folder exactly as
  before (`safePath`). Any other location resolves through `resolveWithinFolder` **and** realpath
  containment (a link or junction inside the location can't lead out of it), for enabled locations
  that answer; using one needs `library.view`.
- `/api/print`, `/api/map`, `/api/local-thumbnail`, `/api/queue/:printer/items` and `/api/queue/send`
  take an **optional** `root`; print and queue requests also take `library: { key, plate }`, the
  Variant chosen on a Model page. Queue items store `file.root` and `library` (Model uuid and name,
  content and Variant key, plate, location — no folder path); retries keep both; accepting a changed
  file drops `library` (it is other content now).
- **Safety paths are unchanged:** `uploadDisposition`, `assertNotActiveJobFile`, `decideUpload`,
  brand and Bambu checks, maintenance mode, group visibility. The same Send and Queue dialogs are used,
  with a "From the Library: Model · location" line.
- **Plates (M7.1):** a Bambu project holds one G-code per sliced plate, and `project_file` names the
  one to run. The plate a print starts is resolved once, on the server, for the Send dialog and the
  Library alike: the plate asked for (absent: the first sliced plate, which is what `/api/map` shows)
  must be a sliced plate of the file (`no_such_plate`), and a plate other than 1 only goes to a
  connector declaring `capabilities.plateSelect` (`plate_unsupported`). The same plate feeds the
  filament mapping (trays chosen for one plate are never applied to another) and the start command,
  and the Library Variant recorded is that plate's. `/api/map` marks used only the filaments the
  plate's `slice_info` block lists, and the AMS mapping is indexed by the project's filament number
  with -1 for unused ones (the printer's own report of a job: `"mapping": [65535, 3]`). The queue
  starts plate 1 only, so a Variant for another plate is printed directly, not queued.
- **Dispatch** re-verifies every item from its own location, with the forced full hash. A file that
  changed is refused (`file-changed` attention; nothing is printed). A file that moved is dispatched
  from another present copy only after that copy's full hash matches, recorded with its location and
  audited as `relocated`. A location that is offline, or whose folder does not answer at all, makes
  the item wait first in the queue (never "missing"); one that answers but can't be used fails it with
  the reason. While offline, Print/Queue are disabled with a `title` and direct requests answer 503.

---

## 13. UI

### 13.1 Library Diagnostics (M4 hard checkpoint; `library.diagnostics`; `/library/diagnostics`)
Plain and functional. It validates grouping on the real library before M5, and may be kept as
Admin → Library Diagnostics.

- **Summary:** Files, Models, auto-grouped, suggestions, ambiguous, unknown printer, unreadable;
  rule version; last scan.
- **Models tab:** Model → Files → Projects → Plates → Variants. Each link shows:
  - relation, method, confidence and state;
  - every Evidence item (value, excerpt, source, group);
  - **filename transformations** (original → normalised, with the rules applied);
  - **printer identity and why** (`targets_printer` Evidence);
  - for non-applied Claims, **the missing requirement**.
- **Suggestions tab:** both sides, the Evidence, and what's missing for auto-apply.
- **Ambiguous tab:** generic-name clusters (`Assembly` **listed, not merged**), multi-Model
  matches, nested folders, anchor conflicts.
- **Folders tab:** the classification of each level, with method and Evidence.
- **Other Review Items tab:** everything else in §8, and "matched N of M" for prints.
- **Filters and export:** by root, confidence, method, state, kind and path text. **JSON
  export** so grouping runs can be compared.
- **Read-only at M4.** Approve/reject is added in M6.

```
Beardie                                    5 files · 0 projects · 5 variants
  AD5X/MatMireMakes/Beardie (5h41m).gcode    member_of · high · applied · object_names+title
     ✓ object names  MMM_Beardie_Body_v08R.stl + MMM_Beardie_Head_preSupported_v08R.stl  [internal-content]
     ✓ title         "Beardie (5h41m)" → "beardie"  (removed: time "(5h41m)")  = "beardie"  [filename]
     · designer dir  MatMireMakes  [location, weak]
     targets_printer → flashforge-ad5x · high · printer_model "Flashforge AD5X" agrees with settings id
Ambiguous — generic object name "Assembly" (NOT merged)
  U1/Cinderwin 3D/Alicorn Dragon (19h24m).gcode
  U1/Cinderwin 3D/Cherry Blossom (1d1h).gcode   …
```

### 13.2 Library (M5 onwards)
Full-page view at `/library`, `/library/m/<uuid>` and `/library/attention`, in the existing theme
and components. The File Browser is unchanged.

- **Grid:**
  - search;
  - filters: Printer, Material, Type, Tag (1b), Collection (1b), Printed, Source, Show hidden;
  - cards: cover, name, "N variants" or "N files", "17 prints · 13 confirmed", and a fleet-fit
    strip;
  - multi-select: "Merge 2 models", "Hide 2 models";
  - a Needs-attention link, an offline bar with Recheck, and an indexing pill.
- **Model page:**
  - gallery;
  - facts: designer, licence, "Fits", prints;
  - Variants: printer ("likely" / "unknown" where applicable), profile, colours, time
    (`fmtDuration`), weight, copies, source, last printed, **Print / Queue**;
  - Projects and Plates;
  - Files by role, with ⋯ Move / Split / Hide / **Why is this here?** (Explain);
  - history (filtered, filename matches marked).
- **Conventions:**
  - scoped button labels;
  - confirmations that name what is affected;
  - disabled actions carry a `title`;
  - checkboxes use `.checkbox-input`;
  - the filename convention.

---

## 14. Offline, backup, search
- **Offline:** no rows change, the missing timer does not run, a named bar with Recheck appears,
  and Print/Download are disabled with a `title`.
- **Backup:**
  - Nightly `VACUUM INTO` (keep 7), plus a snapshot before each migration (1a).
  - JSON export/import of **authored** tables keyed by uuid and content key (1b).
  - A corrupt DB is quarantined and the newest backup restored, never recreated silently.
  - A missing DB is a first run.
- **Rebuild:** "Rebuild index" drops and recreates the derived tables in one transaction (§4.6
  rule 7, P4), then rescans. It never touches authored tables or the identity cache, so Models
  and Decisions re-attach as soon as the rescan finds their files (§4.5), before any re-hash.
- **Identity reset** (deeper, no Phase 1 UI): empties `identity_cache`. Content identity is then
  rebuilt from full hashes only; authored rows re-attach as files are re-hashed.
- **Search:** FTS5 over names, designers, tags, collections, file and object names, project
  titles and notes. SQL filters with facets and server-side paging. "Fits my idle printers" is
  applied client-side.
  - **Paging is keyset**: `WHERE (updated_at, id) < (?, ?) ORDER BY updated_at DESC, id DESC` on
    `models_grid`, never `OFFSET`. M0 measured 92 ms at a deep offset at 100k files.
  - **The printer filter and printer facets read `model_families`** as a set (`m.id IN (…)`),
    never a correlated `EXISTS` over `variants`. M0 measured that form at 15.7 s at 10k files
    (P3).

---

## 15. Phase 1a — milestones (final)

**Prerequisites (before M2):**
- Commit 0.7.3.
- **TODO §16**: the centralised printer-identity resolver and a model-level Send check
  (2–3 days).

| M | Delivers | Owner test / checkpoint | Days | Main risks | Depends on |
|---|---|---|---|---|---|
| **M0 Spike** | `worker_threads` + `node:sqlite` in a pkg build; synthetic 100k DB with Claims; SMB enumeration rate; zip64 3MF through the range-read reader | Numbers report | 2 | pkg worker → fallback decided here | — |
| **M1 Foundation** | `library/` subsystem, canonical schema, migrations, nightly backup, derived-index rebuild (drop/recreate), capabilities, roots CRUD (overlap/realpath checks), runtime location status, Settings → Library, Docker/compose, and the worker foundation with its entry **listed in `pkg.scripts`** (P5) | Add locations; see offline; Rescan | 4 | Docker test | M0 |
| **M2 Indexer + G-code** | Worker indexer (fingerprints, `moved_from`, missing/offline, throttle + pause during uploads), G-code extraction (profile identity, object Evidence), `targets_printer` Claims via the resolver, **folder classification**, thumbnails | **Checkpoint 1: read-only indexing of the real library** | 5 | SMB load vs uploads; parse speed | M1, §16 |
| **M3 3MF** | Range-read zip reader; Bambu/Orca/Snapmaker Orca/Creality-family extraction; Projects, Plates, Variants, entry Files, `source_of` / `sliced_from` Claims | **Checkpoint 2: 3MF extraction on real files** | 4 | Flavour variety; Bambu connector regression | M2 |
| **M4 Claims, grouping, Diagnostics** | Canonical policy engine, **title normalisation with stored transformations**, Decisions + resolution + anchor matching, Review Item creation, **rebuild-survival test**, Diagnostics + JSON export | **Checkpoint 3 (HARD): owner reviews grouping, Evidence, transformations, printer identity, suggestions and ambiguous clusters. M5 is blocked until sign-off.** | 6 | False merges; tuning time | M2, M3 |
| **M5 Library UI** | Grid, search/filters, Model page, offline bar, basic Needs-attention list, Explain popover | **Checkpoint 4: the real Library experience** | 6 | UI size | **M4 sign-off** |
| **M6 Grouping tools** | Merge, split, move, hide, approve/reject, set printer, lineage confirm/reject, cover, rename, undo; approve/reject in Diagnostics | Fixes survive rescan and rebuild | 4 | Decision edge cases | M5 |
| **M7 Print, queue, history** | Root-aware routes and queue, safety regression tests, `printed_as` links, outcome hooks, 90-day backfill ("matched N of M"), counts, history | **Checkpoint 5: controlled printer tests, idle printers only** | 6 | Safety paths; backfill ambiguity | M5 |
| **M8 Hardening** | Full real-library pass, performance, Spanish strings, release notes, full suite; **packaged worker + `node:sqlite` verified on macOS (x64, arm64) and Linux x64** (P5; Windows proven in M0) | Everything on real data | 3 | Real-data surprises | M6, M7 |

**Total: ~40 working days (≈ 8 weeks)**, plus 2–3 days for §16. The u1hub ideas add no milestone
time (§18).

**Phase 1b (~2.5 weeks):**
- the full Needs-attention page;
- browser photo downscaling;
- Prusa 3MF;
- tags, collections, notes;
- JSON export/import;
- the full Explain view.

**Phase 2 (~3 weeks):**
- mesh thumbnails;
- 3D viewer;
- ZIP containers;
- presupported pairing;
- Open in slicer + slicer-watch (§16.2);
- geometry Evidence (§16.1);
- admin deletion (quarantine model);
- Moonraker reconciliation.

**Phase 3:** conversion (§16.3).

---

## 16. Future work (adopted in principle; nothing implemented in Phase 1a)

### 16.1 Geometry Evidence — Phase 2
- **Concept** (from 3MF Explorer): a mesh identity independent of vertex order, to recognise the
  same geometry across renames, re-exports and reslices.
- **Not in the 1a schema.** The algorithm is not final, and a migration is expected when it is
  designed.
- **Policy:** geometry identity is a **strong single signal**, a *suggestion*. It does not by
  itself prove the same Model, because of:
  - generic primitives;
  - calibration objects;
  - reused components;
  - licensed copies;
  - mirrored or derived models;
  - common geometry in different products.

  Geometry plus independent Evidence may reach `high`.
- **For the Phase 2 design to consider:** exact/near-exact vs transformed vs mirrored vs
  component/contained geometry. Not designed now.

### 16.2 Slicer-watch lineage — Phase 2
- **Flow:** SnapCon opens Project X in a slicer → watches the expected output location(s) → a
  newly generated G-code may produce a `sliced_from` Claim.
- **Confidence:** `high` (not `exact`) with strong session context and **exactly one** valid
  candidate. Multiple plausible candidates → a Review Item. **Never "the first changed file".**
- **Evidence:**
  - launch/session id;
  - source Project content key;
  - slicer and version;
  - launch time and watch window;
  - watched location(s);
  - candidates observed and their count;
  - the filename comparison (§6.3);
  - the selected candidate;
  - rule version (group `session`).
- **Research note:** can Orca / Snapmaker Orca supply a *deterministic* source-project identity
  (post-processing environment, the existing `--load` hook, or another mechanism)? If so, the
  relation could become `exact`. Unverified.

### 16.3 Conversion — Phase 3 design note
- **Never blindly copy machine-dependent settings between printers.**
- **Potentially portable when validated:**
  - walls/perimeters;
  - infill;
  - supports;
  - brim;
  - seam;
  - ironing;
  - prime tower where compatible;
  - other safe geometry or process-intent settings.
- **Destination/profile-controlled unless explicitly mapped:**
  - speed and acceleration;
  - temperature and flow;
  - pressure advance;
  - retraction;
  - cooling;
  - machine start/end G-code;
  - post-processing;
  - bed geometry;
  - purge/tool-change behaviour;
  - firmware-specific commands.
- **Never guess** material or profile mappings. **Never overwrite** the original Project.
  Re-centre and revalidate geometry against the destination bed where necessary.
- **Output:** a **new** File + Project and an `exact` `converted_from` Claim.
- **Conversion manifest** (reserved concept; the Evidence for `converted_from`, making
  conversions explainable and reproducible):
  - source Project content key/hash;
  - destination printer/profile and profile version;
  - converter/rule version;
  - settings preserved, replaced, and intentionally dropped;
  - material mappings;
  - geometry transformations / re-centring;
  - warnings;
  - output content key/hash.

  **Storage is decided in Phase 3.** The manifest can live in the Claim's Evidence, or in a
  sidecar table added by a migration then.

---

## 17. Technical risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Wrong grouping (proven) | Canonical policy, independence groups, generic-name/title handling, suggestions, sticky Decisions, **M4 hard checkpoint** |
| R2 | Indexer vs uploads on one SMB share | Bandwidth budget, concurrency 1, pause during transfers |
| R3 | `worker_threads` under pkg | M0; in-process fallback |
| R4 | Root-aware paths touch send/queue safety | Optional parameter defaulting to today's behaviour; regression tests per guard |
| R5 | Filename-only history | `printed_as` provenance, "matched by filename", "matched N of M", ambiguity → Review Item |
| R6 | 3MF variety and size | Central-directory range reads, head-only XML, caps, `unreadable_file`, fixtures per flavour |
| R7 | `threemf.js` changes break the Bambu connector | `read()` unchanged; connector tests stay green |
| R8 | Symlink escape on NAS roots | Realpath containment; overlapping roots refused |
| R9 | History leaking other groups' printers | `printerVisibleTo`; counts aggregate only |
| R10 | Evidence bloat | Caps; measured in M0 |
| R11 | Moved-and-modified-offline files lose their Decisions | Documented limit; `decision_unmatched`; never guessed |
| R12 | Brand-level Send compatibility | Separate prerequisite §16; one shared resolver (D15) |
| R13 | GPL/AGPL code | Studied only; u1hub/3MF Explorer are MIT, and ideas are reimplemented with a credit |
| R14 | Anchor re-matching after a rebuild attaches a cluster to the wrong automatic Model | Largest unique overlap ≥ half; conflicts → `ambiguous_grouping`; covered by the rebuild-survival test |

---

## 18. Sources, adopted ideas and rejected behaviours

**Sources:**
- Meshory
- Manyfold
- OrcaSlicer (format facts)
- bl2u1, 3mf-to-u1, Panda2Prusa, parse3MF, gcode-to-bambu-preset (studied)
- u1hub and 3MF Explorer (MIT)

**Adopted (u1hub / 3MF Explorer) and where each lives:**

| Idea | Where |
|---|---|
| Filename normalisation, made conservative (candidate discovery ≠ Evidence) | §6.3 — M4 (grouping), M7 (print history) |
| Folder classification with provenance; never printer Evidence | §6.4 — M2 (classify), M4 (use) |
| Range-read zip parsing; small-plate-first thumbnails | §6.2 — M3 |
| Geometry Evidence | §16.1 — Phase 2 |
| Slicer-watch lineage | §16.2 — Phase 2 |
| Conservative conversion rules + conversion manifest | §16.3 — Phase 3 note |

**Rejected (not adopted):**
- destructive Rename / Move / Delete as normal Library behaviour;
- attributes keyed only by file path;
- sharing credit between ambiguous filename matches;
- first-file-changed slicer matching;
- a single shared password as the security model.

---

## 19. Consistency audit (performed 2026-09-30)

1. **Schema fields referenced exist.** Every field named in §4–§15 exists in §5.
   - `files.hidden`, `models.hidden`, `models.cover_*`, `variants.printer_family`,
     `file_titles.*`, `folder_classes.*` and `model_stats.*` are all checked.
   - `origin`, `name_source` and `cover_source` values are constrained to the ones the text uses.
2. **Relations.** UI, grouping and Review Items use only the set in "Canonical terminology".
   - `claims.relation` and `decisions.relation` are CHECK-constrained to it.
   - `same_model_as` is Claims-only and `distinct_from` Decisions-only, both deliberately.
3. **Review actions.** Every action in §8 maps to a Decision relation/polarity, a `models` column,
   a dismissal, or "no write".
4. **Milestones** M0–M8 use the final terms (Claims, Decisions, Review Items, `source_of`,
   `printed_as`, `folder_classes`, `file_titles`).
5. **Derived vs authored** (§4.6) matches the rebuild behaviour.
   - `roots` is authored (config) with runtime status columns.
   - Counters moved to derived `model_stats`.
6. **Rebuild cannot destroy authored data.**
   - No authored table has a foreign key into a derived table.
   - Authored → derived references are text keys only (`content_key`, `claim_key`, location,
     `subject_key`).
7. **Foreign keys match the promise.**
   - Derived tables cascade only among themselves, or from `roots` (removing a root drops only
     derived rows).
   - Authored rows reference authored rows only.
8. **One `CREATE TABLE` per table** (24 tables + 1 FTS table, including `model_families` from P3). The §5 block was executed as-is
   in `node:sqlite` with `foreign_keys=ON` (see §19.11).
9. **No duplicate columns.**
10. **No obsolete v2 structures.**
    - Removed:
      - `file_pins`, `merge_suggestions`, `grouping_locked`;
      - `*_method` / `*_confidence` pairs (other than `prints.link_*`);
      - `sliced_from_source`, `not_member_of`, `lineage_reject`;
      - `files.geometry_fp`;
      - the derived row ids in authored tables (`review_items.claim_id/file_id`,
        `prints.variant_id/file_id/model_id`, `decisions.from_claim_id`).
11. **Executed check (2026-09-30).** The §5 SQL block was run verbatim in Node 22.23
    `node:sqlite` with `PRAGMA foreign_keys=ON`:
    - All 24 tables were created, including the FTS table.
    - `pragma foreign_key_list` found **0 authored → derived foreign keys**.
    - A rebuild simulation (seed authored + derived rows, delete every derived row) left every
      authored row intact: roots, models, decisions, prints, review_items.
    - An obsolete relation (`not_member_of`) is rejected by the CHECK constraint.

---

## 20. Open items
- **None blocking.** Implementation waits for the owner's explicit **OK to Dev**.

---

## 21. M0 spike results (2026-09-30, commit 4311c47)

Measured on the owner's Windows machine and NAS (`\192.168.2.18\SnapCon`). The spike code is in
`spike/library-m0/`. §1–§20 above are unchanged. The changes proposed below await the owner's
approval before M1.

**R3 — worker_threads + node:sqlite under pkg: RESOLVED (win-x64).**
- A pkg build with the same flags as `npm run build` starts a Worker from the snapshot
  (`C:\snapshot\…\worker.js`). `node:sqlite` works inside the worker (Node 22.23.1, SQLite 3.51.3),
  and the DB is written next to the exe.
- 20k inserts + FTS: 360–400 ms.
- Longest main-thread stall while the worker ran: 17–23 ms, which is Windows timer granularity.
- The eval fallback works too. pkg found `worker.js` even without a `pkg.scripts` entry, but only
  through its path-literal heuristic.
- macOS/Linux builds were not executed here, since they cannot run on this machine.

**Synthetic DB** (canonical schema; ~1.8 Claims per file, Evidence ~360 bytes per Claim):

| Files | DB size | Without Evidence | Without Claims | Claims share | Evidence share |
|---|---|---|---|---|---|
| 10k | 39.7 MB | 32.7 | 25.5 | 14.2 MB (36%) | 7.0 MB (18%) |
| 50k | 198.2 MB | 163.0 | 127.0 | 71.2 MB (36%) | 35.2 MB (18%) |
| 100k | 397.7 MB | 326.7 | 254.4 | 143.3 MB (36%) | 70.9 MB (18%) |

Within the §5 estimate (250–450 MB at 100k), at the upper end. Largest tables at 100k: claims
143 MB, files 99, file_objects 57, variants 23, model_anchors 23, FTS 20.

**Query timings** (median, 100k files):
- Model page (Files + Claims, Variants + Claims, Prints): 0.28 ms.
- FTS search: 2–7 ms.
- Grid page 1: 15 ms.
- Needs-attention page: 0.9 ms.
- Diagnostics (Claims for 60 Models): 3.5 ms.
- Anchor match: 0.1 ms.
- Incremental scan: 27 µs per path lookup.
- Slow:
  - printer facet counts: **363 ms**;
  - grid at a deep offset: 92 ms;
  - grid filtered by printer: 79 ms.

**Defects found and fixed in the spike:**
- **Missing index `files(container_id)`.** The self-referencing foreign key made deleting files
  scan the whole table once per row, so the rebuild never finished at 10k. With the index, deleting
  every derived row takes 0.55 s at 10k and 12 s at 100k. Authored rows are intact in all runs.
- **A correlated `EXISTS` for "grid filtered by printer" took 15.7 s at 10k files.** Written as
  `m.id IN (…)` it takes 7 ms. The Diagnostics query likewise dropped from 67 ms to 1.4 ms when
  keyed on the Claim's object instead of its subject.

**Network share enumeration** (read-only; the largest real tree on the share has 238 files, so
these are per-file rates, not a 100k-file run):
- Stat: 2.1–6.6 ms per file at concurrency 1; 0.8–2.1 ms at concurrency 8.
- Extrapolated for 100k files: about 3.5–11 min at concurrency 1, 1.3–3.5 min at concurrency 8.
- Quick fingerprint (3 × 64 KB): 2–40 ms, with occasional outliers around 220 ms.
- **The §6.2 G-code reads (3 MB head + 3 MB tail) cost 230–450 ms per file** (~20 MB/s).
  - Across all 58 real G-code files, the extractor needs at most the **first 135 KB** (thumbnails
    + `EXCLUDE_OBJECT_DEFINE`) and the **last 32 KB** (config block).
  - A 512 KB + 256 KB window costs **15–74 ms** against 228–274 ms for 3 + 3 MB.

**ZIP64 / 3MF:**
- The range-read reader passes:
  - libarchive-written fixtures (deflate, zip64, zip64-stored, data descriptors, a UTF-8 name);
  - a hand-built zip64 fixture with saturated 32-bit fields, 0x0001 extras and a 0x7075 unicode
    name, extracted byte-identically by both bsdtar and .NET `Expand-Archive`;
  - both real 3MFs: every entry CRC-verified, entry lists identical to `threemf.js`.
- Metadata extraction read **134 KB of a 3.0 MB 3MF (4.3%) in 7 ms**, and 110 KB of 1.7 MB in 21 ms.
- **The current `threemf.js` rejects a zip64 3MF with saturated fields** ("zip64 archives are not
  supported"), while reading libarchive's non-saturated zip64 fine. This confirms the M3 hardening
  item.

**Where the spike differs from the design assumptions:**
1. §6.2's 3 MB + 3 MB G-code read window is ~20× more than real files need, and dominates a first
   index over SMB.
2. §5 lacked the `files(container_id)` index. It is an omission, not a conflict.
3. Facet counts over `variants` are too slow to run on every filter change at 100k.
4. Rebuild by `DELETE` cascade is slow at 100k (12 s). Acceptable for a rare operation, but
   dropping and recreating the derived tables is simpler and faster.
5. The DB lands at the top of the §5 size estimate. Claims are 36% of it and Evidence 18%, as
   designed.

**Accepted (owner, 2026-09-30), now part of the specification above:**
- **P1.** `files_container` index — §5. A measured requirement, not an optimisation.
- **P2.** Adaptive G-code read window: 512 KB head and 256 KB tail initially, grown when the
  markers are not found — §6.2.
- **P3.** Derived `model_families` table, the `models_grid` index, and keyset paging — §5,
  §14. A query optimisation only; printer identity stays with the resolver and
  Claims/Decisions (§4.6 rule 5).
- **P4.** Rebuild by drop-and-recreate of the derived tables — §4.6 rule 7, §14.
- **P5.** Worker entry listed in `pkg.scripts` — §15 M1. macOS/Linux packaged worker +
  `node:sqlite` verification — §15 M8. Neither blocks Windows M1 development.

---

## 22. M1 results (2026-09-30)

**Commits:** 97e3480 (subsystem), 515309c (server + Docker), e0392c2 (Settings > Library),
ee8c635 (backup failures). Nothing from M2 or later was implemented.

**Implemented vs. specification:**
- The schema is §5, statement for statement. `library/schema.js` is generated from it, and
  `test/library/schema.test.js` fails if they differ.
- `roots.status` never takes the value `scanning` in M1, and `last_scan_at` stays null: there is
  no indexing yet. In M1, **Rescan re-checks reachability**; M2 makes it index.
- A location's folder cannot be edited. Remove it and add the new one; decisions are keyed by
  content, so they survive that.

**Measured and decided during M1:**
- **Windows holds the first contact with an unreachable host for ~21 s**, and a JS timeout does
  not release the libuv thread it occupies.
  - libuv has four such threads, shared by the whole process, worker threads included.
  - Five unreachable probes at once stalled every file operation in SnapCon for 21 s (a local
    `readFile` took 20.9 s).
  - A repeat probe of a host already known to be down fails in 3 ms.
  - **Decision:** reachability checks are serialised process-wide (one in flight), so the Library
    can occupy at most one of the four threads. Measured live: while an unreachable add ran,
    `/api/fleet` answered in 363 ms and the NAS file list in 6 ms.
- **The worker gives no filesystem isolation** (the thread pool is shared).
  - Reachability checks therefore stay async on the main thread.
  - The worker's M1 job is backups: `VACUUM INTO` is synchronous in `node:sqlite`.
  - M2's worker-side enumeration of network locations must stay at concurrency 1 (§6.1) for the
    same reason.
- **A plain open reads only the header and schema.** A full `quick_check` costs 3.75 s at 100k
  files. It runs once, on the next start, after a backup was refused for failing it; a damaged
  database is then quarantined and the newest good backup restored.
- **Rebuild by drop-and-recreate (P4): 456 ms at 100k files**, against 12 s for the M0 `DELETE`
  cascade. Authored rows intact, no foreign-key violations.
- **Packaged Windows build** of the real app:
  - the worker runs as a thread;
  - `library-data/` is created next to the executable;
  - a backup ran through the worker in 30 ms;
  - the database persisted across a restart.

  A dynamic `require` in the fallback path, which pkg could not bundle, was replaced with a static
  one.
- **UNC behaviour (live, on the owner's NAS):**

  | Case | Result |
  |---|---|
  | Real share | `ok` in 9–11 ms |
  | Missing folder on a live share | `error`, "folder not found", 3 ms |
  | Missing share | `offline`, ~5 ms |
  | Unreachable host | `offline` at the 10 s timeout |
  | Parent share containing the G-code folder | refused, overlap |
  | Same folder with different case or a trailing slash | refused, overlap |

**Known limits, not fixed in M1:**
- A mapped drive letter (for example `Z:`) and the UNC path it maps are not recognised as the
  same folder: `realpath` does not resolve drive mappings. UNC paths are recommended. A Windows
  service may not see drive mappings at all.
- Docker behaviour is verified statically only (Dockerfile `COPY`, compose mount,
  `docker.test.js`). No Docker engine was available on this machine.

## 23. Prerequisite: network-filesystem resilience (2026-10-02, before M2)

**Requirement (owner):** a dead or slow NAS may make NAS-backed features unavailable, but it must
never make the SnapCon server itself unavailable or freeze unrelated local, API or UI work.

**Finding.** The problem was not the Library's; it was the G-code folder's, everywhere in
`server.js`. Measured on Windows, Node 22.23.1, packaged app, G-code folder on an unreachable share:
- about 50 synchronous fs calls on the G-code folder ran on the main thread; each one that touched
  the dead share froze the whole server for ~21 s, at any thread-pool size;
- the file browser's 15 s `/api/files` poll alone produced 40 of 160 samples over 1 s, max 21 s;
- async calls are no cure: libuv's four threads are process-wide, so four hung calls starve every
  file operation; a larger pool only moves the cliff, and `UV_THREADPOOL_SIZE` cannot be set from
  JS. The relaunch approach was rejected.

**Design (`netfs/`).** Shared by the G-code folder, the sync folders, the firmware folder and the
Library — one availability concept, not competing ones.
- Synchronous fs runs inside dedicated **worker threads**, in lanes: interactive 2, background 1,
  probe 1. A hung SMB call blocks one worker of one lane — never the main thread, never libuv's
  pool. A background scan cannot take interactive capacity.
- **Timeouts** start when a worker takes the job. Waiting for a worker is bounded separately and
  never counts against the storage.
- **Availability breaker**, per registered root or UNC share: `online`, `offline`, `checking`,
  with last success, last failure and the last error. A network error code or a timeout marks it
  offline. While offline, operations fail at once with `NAS_UNREACHABLE` (HTTP 503
  `gcode_folder_unreachable`), and jobs already queued for it fail immediately. One probe at a
  time on the probe lane re-checks it; any success marks it online. No permanent stale-offline
  state.
- **The breaker is an optimisation, never proof that a file exists.** Every route still checks
  every file on every use: containment, lstat/symlink rules, the forced pre-dispatch hash, and
  exclusive-create on upload are unchanged.

**What changed in behaviour.**
- G-code-folder routes answer 503 with a clear message while the share is down, instead of
  hanging.
- Queue dispatch claims nothing while the folder is known to be down. An outage discovered by
  the forced identity check puts the item back at the front, unverified
  (`QueueEngine.onDispatchDeferred`), instead of a false "file missing".
- A local read that fails mid-upload tears the request down, so a printer never receives a
  short file that looks complete.
- Sync runs to a network destination go one at a time and stop when the destination goes down.
- Startup creates network folders asynchronously.

**Measured after (same packaged build, same unreachable share):**
- 196 samples over 100 s: max 85 ms, none over 1 s (before: max 21 s, 40 of 160 over 1 s).
- Once the outage is known, `/api/files`, `/api/map`, thumbnails and search answer 503 in about
  2 ms. The single request that discovers the outage waits up to the 10 s operation timeout.

**Consequences for M2 (supersedes the related lines in §22):**
- Library reachability checks now run through netfs (probe lane), not async on the main thread.
- M2's enumeration and reads of network locations go through netfs's **background** lane, one
  operation at a time. It shares the breaker: an offline location stops the scan, and nothing is
  purged.

**Remaining bounded exposure, deliberately not converted:**
- The sync download's write stream and the U1 firmware deploy's image reads use `fs.promises`.
  Each is one at a time, so at most one libuv thread can hang.
- A mapped drive letter is recognised as network storage only when it is a registered root; the
  G-code folder always is.

## 24. M2 results (2026-10-02)

**Commits:** 2e436ec (G-code extraction, folder classification), 9c672e1 (indexer, raw view,
thumbnails). Nothing from M3 or later was implemented. Prerequisite: §23 (cd006bc).

**Implemented vs. specification:**
- Pipeline §6.1 steps 1–6 and the `targets_printer` part of step 7. Grouping (`member_of`),
  Review Items, Models, `model_stats`/`model_families` and FTS are M4 and later; nothing writes
  them yet.
- File access is on the main thread through netfs's background lane; parsing and every database
  write are in the Library worker (§23 superseded the M1 note that the worker gives no
  filesystem isolation — the worker does no file access at all).
- 3MF files are indexed as files (role, fingerprint, hash) but not opened: that is M3.
- `duplicate_of` Claims are not written yet; identical files are visible in the raw view by
  their shared content key.
- Thumbnails: embedded PNG/JPEG, content-addressed, orphans removed after each complete scan.
  The 1 GB least-recently-used cap and `last_used_at` updates are not implemented (the real
  library uses 7.9 MB).
- The raw diagnostic view (`/library-raw.html`, admin, `library.diagnostics`) is the M2
  checkpoint tool; the full Diagnostics of §13.1 is M4.

**Real library, first scan (owner's NAS, 3 locations, 299 files, 28.8 GB):**

| Location | Files | Scan | Read |
|---|---|---|---|
| G-code folder | 60 | 8.0 s | 56 MB |
| U1 Files | 67 | 7.9 s | 50 MB |
| V3 PLUS | 172 | 22.4 s | 163 MB |

- Per file: window read p50 19–57 ms (max 261), parse p50 12–17 ms (max 36), write p50
  16–20 ms, quick fingerprint p50 32–39 ms. No file needed more than the initial window; nothing
  was streamed.
- Rescan of unchanged files: listing only, 0 bytes read.
- Full hash: ~28.8 GB at the 16 MB/s budget (~14–15 MB/s achieved), resumed by itself after a
  hard kill and after yielding to scans.
- Responsiveness during the scan (sampled every 250 ms): library status p95 19 ms, max 85 ms;
  static files max 34 ms; file browser max 142 ms. `/api/fleet`'s ~3.5 s stalls are printer
  polling and identical to the pre-M2 baseline (202 vs 208 of ~915 samples).
- Upload pause, live: during an upload into the G-code folder the indexer reported itself
  paused; ~3 MB in flight completed, then nothing until the upload ended.
- DB 1.9 MB (+ WAL), 262 thumbnails 7.9 MB. Queries: a location's manifest 0.5 ms, Claims of
  one key 0.1 ms, variants by family 0.2 ms, the whole raw view 35 ms.
- Packaged Windows build: same results, worker as a thread, thumbnails next to the exe.

**Printer identity on the real files (276 G-code):**
- 272 high / applied, 3 medium / suggested (`5M PRO/skelly`, `5M PRO/boat` — byte-identical —
  and `K1C/K1C.gcode`: generic `printer_model`, family from the settings fields), 1 unknown
  (`[CP] TinyTREX`: "Creality Ender-3 V3 KE", no such family in the resolver).
- `K1C/HollowLog` → Ender-3 V3 Plus, high, applied (printer_model and settings agree).
- `5M PRO/skelly` → Adventurer 5M Pro, medium, suggested.
- Folder disagreements: none raised. `K1C` is classified `unknown` because the resolver has no
  K1C family, so HollowLog's folder/file disagreement is not visible — a resolver question for
  the owner, not something a folder list should paper over.

**Folder classes (42):** 6 printer-family-like, 16 designer, 1 format, 19 unknown. Near-miss
spellings ("MatMires Make", "Cinderwing 3D") stay unknown: that is M4 candidate discovery.

**Found and fixed during M2** (each with a regression test that fails without the fix):
- A halt (Rebuild, Remove location) did not stop the idle hash that followed a stopped scan.
- Orphan-thumbnail cleanup was quadratic without an index on `files.thumb_key` (108 s at 100k
  files); now only this scan's candidates are checked, in one pass.
- One unreadable file ended the full hash every tick; an unreadable folder failed the whole
  location; a file that could not be fingerprinted or stat'ed could be marked missing.
- Whole-window reads up to 6 MB in one operation could time out on a slow link and mark the
  shared share unreachable; reads are now at most 1 MB.
- Re-keying missed `ck#plate` object keys, Claim-key references and review-item subject keys,
  and a Decision held on a quick key was lost for the copy hashed first (now resolved through
  `content_aliases`).
- Removing a location deleted its rows on the main thread in one transaction; now batched in the
  worker.
- The first scan waited for the next 15 s tick; the idle hash did not resume after a restart;
  Creality thumbnail block forms were not recognised.

**Real data worth knowing for M4:** five byte-identical pairs (e.g. `5M PRO/skelly` =
`5M PRO/boat`, `U1/Hippocampus` = `U1/Cinderwin 3D/Hippocampus (Unicorn)`).

**Known limits:** a location's first scan reads every file (~1 MB each for G-code); main-thread
writes (location status) wait on the worker's write lock for at most one short transaction.

## 25. M3 results (2026-10-02)

**Commits:** c49b1bb (K1C and Ender-3 V3 KE families, a separate resolver change), 2d11e7a (zip
reader, also behind `threemf.js`), 88b12cc (3MF extraction, Projects/Plates/Variants, lineage).
Nothing from M4 was implemented: no Models, no `member_of`, no Review Items.

**Resolver (before M3):** `K1C` folders are printer-family folders (Creality K1C);
`[CP] TinyTREX` now resolves to the Ender-3 V3 KE, high. A printer-family folder is what the
folder says, never Evidence: `K1C/HollowLog` keeps its identical Ender-3 V3 Plus Claim (high,
applied) and the raw view reports the disagreement. Tests prove the folder neither raises nor
lowers a Claim. Live: four folder disagreements, all in `K1C/` (three V3 Plus files, and
`K1C.gcode` itself, sliced with the `Creality@K1` profile).

**Implemented vs. specification:**
- §6.2 3MF: range reads (directory + small entries; zip64, unicode names, data descriptors,
  STORE/DEFLATE, CRC, caps on every untrusted length); `3dmodel.model` read whole only below
  2 MB, else its head (never inflating more than the head); `model_settings.config`,
  `project_settings.config`, `slice_info.config`, `plate_N.gcode.md5`, plate pictures (small
  first), `thumbnail_3mf` as fallback, Auxiliaries as entry Files. Unreadable is an unreadable
  File, never a failed scan.
- Projects for every 3MF; Plates as the file lists them; a Variant only for a plate whose G-code
  is inside. Role is by content (`sliced` when a plate's G-code is present, else `project`).
- `targets_printer` per printable plate (`content#plate`) from the profile plus the plate's Bambu
  `printer_model_id` (identity group). An unsliced project's printer is shown as "set up for",
  from its own settings, and is not a Claim.
- Lineage (`source_of`, `sliced_from`) per the §4.4 table, recomputed after each complete scan and
  after full hashes (MD5s). Ties are recorded, never shared.
- `threemf.js`'s API is unchanged; the Bambu connector's FTPS reader is untouched.

**Real 3MFs (17: 2 in the G-code folder, 15 in U1 Files; 346 MB):**

| | Bambu (2) | Snapmaker Orca (15) |
|---|---|---|
| Application | `BambuStudio-02.0x.xx.xx` | `BambuStudio-2.3.x` + Snapmaker printer + settings version 2.3.x |
| MakerWorld metadata | both: Title, Designer, License, DesignModelId, DesignProfileId, ProfileTitle, ProfileUserName (+ DesignRegion, DesignerUserId, ProfileUserId) | none (empty fields) |
| Sliced | `ams.gcode.3mf`: 1 plate, P2S N7, high/applied, 2 PETG filaments with grams | none: all unsliced projects |
| Plates | 1 + 1 | 32 in total (`soniverine` 12, `Sea Turtle` 6, `santa` 2) |
| Auxiliaries | 16 entry Files (pictures) | none |

- MakerWorld values verified: Benchy `US988acfe8c03702` / `272525070`, "Speed Benchy!",
  barbasnoo, CC0; Keyrambit `USec11953facc500` / `808246553`, TR10_, BY-NC-SA.
- Read: 2.46 MB of 346 MB (0.7%); 80–617 KB per file (the Bambu files carry their pictures);
  12–40 reads; parse 2–24 ms; read 2–31 ms with NAS outliers to 217 ms.
- Source references: recorded as written. Most point at paths that cannot exist here
  (`C:\Users\…\Temp\…`, `Z:\…`, `F:\…`) or at other 3MFs not in the library: no `source_of`
  Claim results, correctly.
- Lineage on the real library: one suggestion, `5x Grinch… .gcode` sliced_from
  `5x Flexy Grinch @ 98.3mf` (same object "Flexy_Grinch_Standard_STL_No Hat Version2.stl",
  medium, suggested). A Benchy-vs-Benchy match appeared first and was a false positive: common
  test prints are now generic names.
- Packaged Windows build: same results.

**Data-model findings (none contradicts v3.2):**
- MakerWorld fields beyond the `projects` columns (ProfileUserName, DesignRegion, user ids, dates)
  are kept in `files.meta_json`; no column is needed until something filters on them.
- `projects.printer_model_id` is one value, while Bambu records it per plate: the per-plate value
  is on each Variant; the Project keeps the first sliced plate's.
- Entry Files are fingerprinted from the archive's own record (size + CRC-32), not from content
  reads, so their content key is not comparable with a loose file's.
- Snapmaker Orca names itself "BambuStudio" in 3MFs. The `snapmaker_orca` flavour is therefore an
  inference with its method recorded, not a field the file states.

**Recommendations before M4:**
- Treat `source_file` as weak: on the real files it is mostly an unresolvable path.
- Object-name lineage needs the generic-name list kept honest (the Benchy case); M4's generic
  scoring by "appears under unrelated titles" (§4.4 rule 7) will matter.
- Consolidate `connectors/zip-reader.js` (the Bambu FTPS reader) onto `library/zipReader.js` as a
  separate, connector-tested change.

## 26. M4 results (2026-10-03)

**Commits:** 9f867b4 (grouping into Models, grouping Diagnostics; grouping rule v2), 3cd3016 (an
edge lists only the groups that count), 819a099 (the durable identity cache, schema 2).
Nothing from M5 was implemented.

**Implemented vs. specification:**
- §4.4 policy exactly: identity Evidence (MakerWorld design id, `plate_md5`, a resolved
  `source_file`) or two independent groups at medium groups automatically; one group is a
  `same_model_as` suggestion with what is missing; weak or generic Evidence is recorded only. A
  conflict (different object sets, different design ids) is recorded and never acted on.
- §6.3 titles: every transformation is stored (`file_titles`): extension, tags, material/time,
  print stats, colours, temperature, copy count, plate, designer, filament, format words. Exact
  multi-word titles are medium; an exact one-word title of four or more characters is medium
  (Beardie, TinyTREX); generic titles are weak; containment is weak; under four characters is
  nothing.
- §4.4 rule 7 generic names: a fixed list, each entry with its reason (Assembly, Body, Plate,
  3DBenchy, …), plus "common": a name used under three or more unrelated title groups. Titles
  that differ only in spacing, word order or containment are related, so a model's own colourways
  do not make its part names common. Diagnostics shows every term ignored and why.
- Folders: a shared designer folder is weak; a folders-mode model folder is medium location
  Evidence (rule v2, below); a printer-family folder is never grouping or printer Evidence.
- Lineage Claims from M3 are not counted twice: `sliced_from`/`source_of` by object names are the
  object-name Evidence, compared once.
- Determinism: content-key nodes, candidate blocks, union-find over edges in a fixed order; a test
  proves three scan orders give identical Models and Claims.
- Decisions are hard constraints: a confirmed file joins its Model (it never takes the Model from
  the files anchored there), a separated file never counts towards that Model, `distinct_from`
  suppresses the suggestion and blocks the merge. Models are re-found through `model_anchors`.
- Review Items of the M4 kinds, synchronised by subject key: dismissed and resolved items stay
  so; cleared conditions auto-close. `file_changed` (a Decision's file changed in place) and
  `decision_unmatched` (moved and changed while unseen) wait until every location is indexed and
  the identities involved are verified.
- Diagnostics (admin only, `library.diagnostics`): `/library-diagnostics.html` and
  `/api/library/diagnostics/grouping` — Models with Files, Projects, Plates, Variants, printers,
  Claims, Decisions and Evidence; suggestions with both sides and what is missing; protected and
  ambiguous cases; duplicates; unresolved sources; other Review Items; content identity. Filters:
  location, confidence, method, review type and status, text. `?export=1` is a stable export with
  the grouping and title rule versions and no run timestamps.

**Rule evolution during the checkpoint (evidence that it tested the architecture):**
1. *Folder grouping merged different animals (rule v1 → v2).* v1 followed §4.4/§7 as written: in
   a folders-mode location a top-level folder was a model folder, structural Evidence that grouped
   on its own. The owner's U1 Files location is organised by **designer**, so `Cinderwin/` became
   one Model of Butterfly Dragon, Crystal Dragon ×2 and Crystal Wing Dragon, and `Zou/` one of
   Axolotl, Bearded Dragon and Sea Turtle. v2 makes the folder **medium location Evidence**: it
   corroborates one other independent group and never groups alone. Before/after (dry runs on a
   copy of the live index): v1 255 Models, 20 multi-file (53 files), `member_of` by model folder
   7; v2 258, 20 (50), 0 by folder alone.
2. *Over-protection by the "common name" rule.* Counting distinct titles made a model's own
   colourways (TinyTREX, Tiny T-REX, Kitty Flexi / Flexi Kitty) count as unrelated, so their part
   names became generic. Counting unrelated **title groups** restored them: 258 → 253 Models,
   20 → 23 multi-file (58 files); each restored group was checked by hand (object names + title).
3. *A rebuild lost every identity (schema 2).* The design had two kinds of data, authored and
   derived; the bridge between a rediscovered file and its stable identity (quick fingerprint →
   verified sha256: `files.sha256` and `content_aliases`) was classed as derived and dropped by a
   rebuild. The first live rebuild test (example 9) failed:
   once hashed, authored rows are keyed by `sha256`, but a rebuild drops `files.sha256` and
   `content_aliases`, so the rescanned files carried quick keys until the idle re-hash. Grouping
   created a new Model for every file (507 Models, 254 *Empty model* items), raised a false
   *File changed*, and Decision #1 stopped applying. The unit test had re-inserted the same keys
   and missed it. Correction: the durable identity cache (§4.5, §4.6), a third kind of data
   between authored and derived. The 254 debris Models were removed only after each passed every
   check (no files, anchors, Decisions, authored customisation, tags, collections, prints or
   acted-on Review Items); 562 Review Items produced solely by the failure were removed after
   the repaired state proved each invalid (an empty Model that has files again, a quick key no
   file holds). Backups were taken before (pre-migration and manual).
4. Smaller fixes found by the checkpoint's tests: the worker never actually ran grouping; a
   partial index during a rebuild could erase a Model's anchors; a suggestion listed weak groups
   as if they counted.

**Real library (3 locations, 299 files, 293 model files):**

| | Before rebuild | Right after rescan (no re-hash) | After full re-hash |
|---|---|---|---|
| Models with files (+ empty) | 252 (+1) | 252 (+1) | 252 (+1) |
| Multi-file / one-file Models | 27 / 225 | 27 / 225 | 27 / 225 |
| Files grouped automatically / by Decision / standalone | 59 / 1 / 233 | 59 / 1 / 233 | 59 / 1 / 233 |
| `member_of` (high) | object_names+title 56, object_names+model_folder 2 | same | same |
| Suggestions | 30 (object names 18, title 9, model folder 3) | same | same |
| Ambiguous files / protected generic cases | 21 / 8 | same | same |
| Duplicates | 5 (sha256, exact) | 5 (quick_fp, high: unverified) | 5 (sha256, exact) |
| Unresolved source paths | 63 | 63 | 63 |
| Open Review Items | ambiguous 29, suggested 30, duplicate 5, folder disagrees 3, unknown printer 2, empty model 1 | identical | identical |
| Content identity | 299 verified | 7 verified, 292 restored (unverified) | 299 verified, 0 contradicted |

- The same Models with the same members and uuids in all three states; no Model created again.
- Non-model files: 6 (images and documents). Multi-file counts are by file location (a duplicate
  pair is one content node); the grouping report counts 23 multi-node clusters with 58 files.
- **The "+1" empty Model** is `1d0d33cc-ee93-4f9f-a023-d5801d43a92a` ("Beardie"): the automatic
  one-file Model the first live grouping gave Beardie @ 160, **before** the failed rebuild.
  Decision #1 then moved that file into Beardie `a6ab47d7…`, which left it empty. It is not
  failed-rebuild debris (it predates the rebuild and the cleanup considered only Models created
  after Decision #1), and it carries nothing authored. It is kept because nothing authored is
  deleted automatically (§4.6 rule 4); its *Empty model* item (information level) is open for the
  owner, and hiding or merging it is an M6 action.
- Rescan after the rebuild: 30 s; the full re-hash on the NAS: 33 min.

**The nine examples:**
1. Correct automatic group: Skeleton T-Rex, 4 files in 3 locations — object names
   (Body_Curved …) + title "skeleton t-rex" (designer, copy count, temperature, stats removed).
2. Multi-printer Model: Beardie, AD5X + SPARKX i7 ×4, each Variant with its own printer.
3. `Assembly` not merged: 24 files in 24 Models, plus three "Assembly_PLA_…" titles; reason
   "default name for a multi-part object".
4. Benchy protected: `3DBenchy_PLA_51m47s.gcode` and the Bambu 3DBenchy 3MF stay apart.
5. Medium suggestion: Grinch ↔ Flexy Grinch @ 98 (object names only; missing "e.g. the same
   title"). Beardie ↔ Beardie @ 160 (title only) was the other, until Decision #1 settled it.
6. Duplicate pair: `5M PRO/boat_pla_14m3s` = `5M PRO/skelly`, byte-identical; recorded, nothing
   hidden.
7. HollowLog: the `K1C` folder says K1C, the file says Ender-3 V3 Plus — informational only.
8. 3MF lineage: `5x Grinch … .gcode` sliced_from `5x Flexy Grinch @ 98.3mf` (object names,
   medium, suggested) — the only lineage in the real library.
9. Decision #1 (Beardie @ 160 member_of Beardie `a6ab47d7…`) survived a full rebuild: applied
   immediately after the rescan through the restored identity, and after the verified re-hash.

**Tests:** grouping (21), identity cache (12, including the service end to end), store
(migration 2, rebuild keeps the cache, reset keeps authored rows), schema (three kinds of table),
routes (admin only, export). Each regression test was checked to fail without its fix.

**Open for later milestones:**
- `connectors/zip-reader.js` (the Bambu FTPS reader) should be consolidated onto
  `library/zipReader.js` as a separate, connector-tested change.
- The Diagnostics page is read-only; Review Item actions arrive with M5/M6.

## 27. M5 results (2026-10-03)

**Scope:** the Library UI only (§13.2): grid, search and filters, the Model page, Needs attention,
explanations, offline behaviour. Nothing from M6 (merge, split, move, approve/reject, set printer,
hide, rename, cover editing, undo) and nothing from M7 (root-aware printing, history, counts).

**Implemented:**
- An in-app page like Health: `/library`, `/library/m/<uuid>`, `/library/attention` (a topbar
  button; Back/Forward; Library, Health, Queue and Settings close one another; first-run
  onboarding wins over a deep link). `/library/diagnostics` redirects to the M4 Diagnostics page.
  `public/library.js` (no framework), styles in `style.css` using the existing tokens, strings in
  `library.*` (English and Spanish).
- Read-only API, `library.view`: `/api/library/overview`, `/facets`, `/models` (keyset paging,
  search, filters), `/models/:uuid`, `/attention` (`library/libraryView.js`). Everything comes
  from the index; no request reads a file. A location's folder is never part of an answer.
- Grouping now fills the two derived query caches the grid needs: `model_families` (printer
  filter and facets, §14 P3) and `model_fts` (search: name, designers, file names, non-generic
  object names, project titles).
- **Grid:** cover, name (two lines), "N printable files" / "N files" / "N projects", materials,
  the fleet-fit strip (each printer family the Model has files for, outlined when the fleet has
  such a printer, with how many are idle — §14 "Fits my idle printers", client-side), and
  badges: *Needs you* / *Check* (action / review items), *Offline*, *Missing* / *Unreadable*.
- **Filters:** search, Printer, Location, Type (ready to print / 3MF project / source), Material,
  Needs attention; sort by name or recently added. Not offered: Printed (M7), Tag and Collection
  (1b), Show hidden (M6), multi-select actions (M6).
- **Model page:** gallery (cover, Model images, plate pictures, file thumbnails); facts
  (designer, licence, MakerWorld design, locations, "Fits" with the printers by name); its own
  attention items; suggestions with "Why only a suggestion?"; printable files **grouped by
  printer family** (never flattened), each with plate, printer confidence (Confident / Likely /
  Unknown / Set by a person), profile, slicer, time (`fmtDuration`), weight, copies, layer and
  nozzle, filament swatches, location and path, availability, duplicates, "Why is this here?"
  and "Why this printer?"; Projects with every Plate and what the project is set up for; other
  files. Admins get a link to Diagnostics.
- **Print / Queue:** through the File Browser's own path — `selectFile()` then the existing Send
  dialog, or the existing Queue dialog — so every existing check applies. Only files in the
  G-code folder can be sent (the existing routes know only that folder); other locations show a
  disabled button with the reason until root-aware printing (§12, M7). View users see the
  buttons disabled with a reason.
- **Needs attention:** every open Review Item in plain words, grouped by level — *Needs you*
  (`decision_unmatched`, `file_changed`, `unreadable_file`), *Worth a look* (suggestions,
  ambiguous files, uncertain printers, missing files, offline locations), *For your information*
  (folder disagreements, duplicates, generic names kept apart, empty Models) — then by kind, each
  linked to its Models. It explains; resolving is M6, and the page says so.
- **Offline:** a named bar per offline location (Recheck for those who manage locations); its
  Models stay, greyed, marked Offline; a file there is "Offline — still known", never missing;
  Print is disabled with the reason. The indexing pill shows a running scan or verification.
- **Covers (§10 order):** the owner's choice, an image in the Model, a plate picture, the
  largest G-code thumbnail, else a placeholder (also used for any image that fails to load).
- **Names:** an automatic Model's name is now its title as the file wrote it, minus exactly what
  normalisation removed ("TinyTREX", "HollowLog", "3DBenchy"; a generic title keeps its words:
  "Assembly", "The Plate 1"). Presentation only; never Evidence.

**Real Library:** 252 Models (27 with several files, 225 one-file; 7 across several printer
types); covers for all 252 (235 G-code thumbnails, 15 plate pictures, 2 Model images).
Facets: Ender-3 V3 Plus 158, Snapmaker U1 73, AD5X 7, SPARKX i7 2, P2S 1, Ender-3 V3 KE 1;
G-code folder 49, U1 Files 62, V3 PLUS 148; ready to print 236, 3MF project 17; PLA 234, PETG 2,
TPU 1. Needs attention: 70 items (0 needs you, 53 worth a look, 17 information); 69 Models carry
a Check badge.

**Performance (real Library, localhost):** every Library request 15–17 ms median (overview,
facets, first page and next page of 60 cards, search, printer/material/location/attention
filters, Model detail including the 12-plate project, Needs attention), worst 16–31 ms; the same
~15 ms floor applies to a cached thumbnail, so it is the HTTP round trip on Windows, not the
queries (6–15 ms measured in-process). Cards appear about 1 s after a cold page load once the
app's splash has gone. Browsing made no file-reading request: the only file-system traffic seen
was the app's existing 15-second File Browser refresh and fleet thumbnails, present on every page.

**Permissions (HTTP, packaged build, users on):** anonymous 401 everywhere; view, regular and
admin browse (overview, facets, models, Model page, attention); Diagnostics, rescan and rebuild
403 except admin; no editing endpoint exists for anyone (404). No answer to a non-manager carries
a location's folder. Found and fixed: `/api/library/roots` hid `path` from non-managers but
returned `lastError`, whose network message names the share (`\\host\share is unreachable`);
it is now withheld as well.

**Problems found (for the owner):**
- Search is word-prefix: "trex" finds "Tiny TREX" but not "TinyTREX". An infix (trigram) index
  would fix it; not done without a decision.
- 69 of 252 Models carry a Check badge, mostly 21 "looks like two Models" files and 30
  suggestions. Accurate, but busy until M6 can resolve them.
- Same-named Models (three "Assembly", two "Axolotl Redux", two "Baby Alicorn Egg", and the empty
  "Beardie") are told apart only by cover and location; merging is M6.
- Printing from locations other than the G-code folder waits for M7.
- Spanish installs show the new Library strings in English until `locales/es.json` is reseeded
  (the existing locale rule).

## 28. M6 results (2026-10-04)

**Commits:** 7dd02dc (a deterministic tie-break between equally matched Models — an M4 bug found
by the M6 undo tests), 8b7bf39 (schema 3), 3f307f8 (search: camel-case and punctuated names),
ff97fe5 (the grouping tools and undo), b033cd6 (the UI). Nothing from M7 was implemented.

**Implemented (§7 table, as built):** merge (A into B, the survivor chosen and named before
confirming; A kept with `merged_into`), separate into a new Model, move (one or several files;
"Choose model…" for an ambiguous file), approve and reject a suggestion, dismiss a Review Item,
hide and unhide Models and Files, rename (and back to the automatic name), choose a cover (and
back to automatic), set a printer (and back to what the file says), undo of every one of them.
Each is a Decision or an authored `models` column, recorded in `actions`, checked against the
current state (409 with a code), checked for its capability on the server, audited.

**Deferred, and why:** confirming/rejecting lineage (`source_of` / `sliced_from` Decisions): the
real library has no lineage suggestion to act on, and `lineage()` would have to honour Decisions
— better done with a real case; multi-select merge of several Models from the grid (merge works
one pair at a time from the Model page); notes, tags and collections (Phase 1b); browser-made
covers (Phase 1b, §10); approve/reject inside Diagnostics (done from the Library; Diagnostics
shows the Decisions and what they control).

**Specification changes:**
- §4.1: a Decision is in force unless superseded **or withdrawn** (undo).
- §4.6 and §5: `actions` (authored); `decisions.action_id`, `decisions.withdrawn_at`;
  `models.merged_into`; `model_fts.search_terms` (derived). Schema 3.
- §7: the tools as built, their capabilities, structure versus grouping, and undo semantics.
- §11: the capability of each action and the audit events.

**Undo semantics:** undo reverses one action exactly — its Decisions withdrawn, those it
replaced in force again, `models` columns restored, Review Items it closed reopened, each moved
file's last-known membership anchor returned, a Model it created folded back — and automatic
grouping recomputes the rest. It is refused (`undo_blocked`) while a later change depends on it.
History and audit keep the undone action.

**Real Library checkpoint (2026-10-03/04):** after a manual backup and the migration snapshot,
schema 3 was applied to the live Library; then:

| # | Action | Real example | Result |
|---|---|---|---|
| 1 | Approve | "WhitesTree Frog" ↔ "Whites Tree Frog" (same body and head objects) | merged into "Whites Tree Frog"; item resolved; **kept** |
| 2 | Reject | "Zou Sea Turtle Ready" ↔ "Zou Axolotl Ready" (folder only) | kept apart, never suggested again; **kept** |
| 3 | Merge | the two "Baby Butterfly Dragon" Models | `519dd09d…` merged into `e5f295c3…` (survivor uuid kept, absorbed row kept); undone afterwards |
| 4 | Separate | "Skeleton T-Rex @ 192" out of Skeleton T-Rex (4 → 3) | new Model `7161f051…` (origin user); undone afterwards |
| 5 | Move | "Beardie (9h28m)" into Leopard Gecko, against object names + title | stayed there; Diagnostics lists the merge the Decision prevented; undone afterwards |
| 6 | Hide | 3DBenchy | only in "Show hidden models"; file untouched; undone afterwards |
| 7 | Rename | Beardie → "Bearded Dragon (MatMire Makes)" | file names and title Evidence unchanged; undone afterwards |
| 8 | Cover | U1 soniverine → plate 3 | kept through the rebuild; undone afterwards |
| 9 | Printer | HollowLog: file says Ender-3 V3 Plus → set K1C | "Set by a person", "The file says: Creality Ender-3 V3 Plus" with every extracted signal; undone afterwards |
| 10 | Undo | a move and a rename, before the rebuild | both back, and still back after it |
| 11 | Empty "Beardie" | `1d0d33cc…` merged into Beardie | no more empty-Model item; **kept** |

The 22 checks of these states passed three times: right after the actions, right after a full
derived rebuild (31 s rescan, 292 identities restored from the cache, before any re-hash), and
after the full re-hash (299 verified). The rebuild kept 254 Model rows and 11 active Decisions,
and created no Model. The seven test actions were then undone; the Library is back to its
organisation except the three deliberate resolutions (251 visible Models; open items 0 needs you,
51 worth a look, 16 information). The audit trail has every action and undo, with Model names and
uuids, no folder paths.

**Permissions:** every action and undo tried directly over HTTP: signed out 401, view 403
(`forbidden`) for all twelve kinds, regular and admin allowed, undo needs the same capability; no
other editing endpoint exists. The packaged Windows build (worker thread) behaved the same.

**Found and fixed during M6:**
- the anchor tie-break never ran (M4 determinism; separate commit with a regression test);
- undoing a merge or a move left the file in a new Model: undo now returns the file's anchor;
- on a direct page load the Model page could render before the user's permissions arrived and
  show no tools: the first view now waits for them;
- search "t rex" also found "the": a one-letter word matches whole.

**Search (M5 follow-up):** "trex", "t rex", "t-rex", "T-REX" find TinyTREX, Tiny TREX, Tiny T-REX,
Skeleton T-Rex, T-Rex and the rest (9 Models on the real Library); display names unchanged.

## 29. M7 results (2026-10-03)

**Delivered:** printing and queueing from any Library location through the existing Send and Queue
dialogs; every Print recorded with its identity (§9); the Model page's print history and counts;
cards' counts; unlinked prints in Needs attention, linked by a person and undoable; the 90-day import.
Nothing from M8 was started.

**Schema 4** (§5): `prints.via`, `location`, `queue_item_id`, `job_key` (unique), index on `audit_ref`;
`print_imports` (authored); `print_links` (derived). Migration 4 is idempotent. Found on the real
database copy before it reached the live one: the migration's statement extraction stopped at a
`(#plate);` inside a comment — fixed (comments are stripped first) with a v3→v4 regression test.

**Real-Library checkpoint** (packaged build, worker thread, a copy of the live Library and audit log,
two **simulator** printers only — no job was sent to a real printer; a "Test shelf" location of real
files copied to a `subst` drive for rename/move/change/offline):

| # | Case | Print → Variant/content → Model → method/confidence → location |
|---|---|---|
| 1 | Print, G-code folder | `print:…` → `2f4d1948…` → K1C → snapcon_variant/exact → gcode:K1C/K1C.gcode |
| 2 | Queue, G-code folder | `queue:qi_6b5e…` → `2f4d1948…` → K1C → snapcon_variant/exact → gcode:K1C/K1C.gcode |
| 3 | Print, "V3 PLUS" (NAS) | → `fd82fbb1…` → Shadow Dragon Box → exact → V3 PLUS:CraftyKid3D/[Biqu] Shadow Dragon Box (…).gcode; queue from the shelf likewise exact |
| 4 | Beardie | the 9h28m Variant → `eec1bd49…` → Beardie → exact → gcode:I7/Beardie (9h28m).gcode; the page: "14 prints · 1 confirmed · 13 matched by filename" |
| 5 | Restart | the queued item kept `library` and `file.root` in `queue-data.json`, dispatched after the restart as exact |
| 6 | Rename + move on disk | after printing, the shelf file renamed and moved into a folder: same Model, same Print, still exact; location keeps where it was sent from |
| 7 | Model rename | the same 14 rows, same counts; undone |
| 8 | Merge + undo | 3 Prints shown through the survivor ("Printed as …, since merged"); undo: each Model its own; 705 Prints / 705 links before, after and after undo |
| 9 | Duplicate content | `skelly.gcode` (byte-identical to `boat_pla_14m3s.gcode`) → location gcode:5M PRO/skelly.gcode; a shelf copy of Shadow Dragon Box → the shelf location |
| 10 | Offline before dispatch | `subst` removed: the item waited first in the queue (no attention, no Print), the location went offline, the Model page showed "offline" with Print disabled, a direct print answered 503; SnapCon answered in ≤ 31 ms throughout; back online → dispatched, exact |
| 11 | Changed content | a direct print with the stale Variant: 409 `library_file_changed` (and a rescan); a queued item: `file-changed` attention at dispatch, 0 Prints |
| — | Moved before dispatch | the queued shelf file renamed away: dispatched from the NAS copy after its full hash matched; audited `relocated` |
| 12 | Import examples | see below |
| 13 | Ambiguous refused | a printer-storage start of `K1C.gcode` (two different K1C files, two Models): filename/low, uncounted, Review Item offering both; a person linked it (exact by Decision), undo unlinked it |
| 14 | Counts | before the import every Model had none; after: 33 Models with counts (live) |

**Import on the live Library** (schema 4 applied after a manual backup and the pre-migration
snapshot): 1313 audit events (the log holds ~62 days) → 680 starts, 633 outcomes → **697 Prints**
(17 known only by their outcome); 616 outcomes paired. Linked **159**: 2 exact (`queue_sha256`, the
queue's recent history), 157 matched by filename; ambiguous 0 (no name in the real Library is shared
by two Models); generic names refused 151 ("Assembly…", "Lupa-Back of Body", "Tree Stand", "Cube",
"3DBenchy"); not in the Library 387 (e.g. Orca-renamed "MatMireMakes - Beardie (PLA_5h41m)" — not the
Library's "Beardie (5h41m)", left unlinked rather than loosening the match); 11 Review Items (generic
names with candidates: "Tree Stand" ×7, "Gnome Stand" ×3, "3DBenchy" ×1); outcomes 515 completed,
110 cancelled, 8 failed, 50 unknown, 14 printing (all started today). Most counted: boat 20 (by
filename: printed as `skelly.gcode`, the Library's byte-identical copy), Tiny Skeleton T-Rex 17,
Ferret 17, Hippocampus 15, Beardie 13.

**Rebuild and restart:** a derived rebuild (31 s rescan; identities from the cache) and a restart
left the Prints, every `print_links` row, every count, the 3 active Decisions and the M6 merges
identical; job keys unique; a Library item held in a paused queue across both kept its identity and
printed as exact afterwards.

**Permissions over HTTP:** signed out 401 everywhere; view: Library pages and `/api/map` on another
location 200, print/queue 403, linking 403, the import report 403; regular: print/queue allowed on
visible printers, 403 on a printer outside their groups; path traversal and unknown locations 404.
Counts identical for everyone (3 / 14); rows only for visible printers ("Sim A" for regular, "Sim B"
for the shop user, all for admin, who alone sees prints on printers since removed); `unlinked_print`
items likewise (admin 12, regular 1, shop 0).

**Performance** (index only; 707 Prints, 252 Models): grid with counts median 15 ms, Model page with
21 Prints 15 ms, filtered for a regular user 14 ms, Needs attention 16 ms, overview 15 ms.

**Found and fixed during M7:**
- a queue retry rebuilt the item without its location, so it would have looked in the G-code folder
  (regression test);
- a Library location whose folder vanished (not a timeout) would have failed a queued item as
  "missing" — it now waits as offline;
- the migration statement extraction (above);
- imported jobs with no outcome stayed "printing" for weeks — only a start within 3 days may.

**Known, not changed in M7:** SnapCon starts plate 1 of a Bambu project whatever the Send dialog's
plate picker shows (connector behaviour; recorded in docs/TODO.md); one Review Item per generic-named
print, so a much-printed "Tree Stand" lists several.

## 30. M7.1 results (2026-10-03)

Four operational issues found in M7, fixed before M8.

**1. Bambu plates.** The Send dialog offered a plate picker and mapped the chosen plate's filaments,
but the connector always started `Metadata/plate_1.gcode`. Selecting a plate is part of the protocol
(`project_file`'s `param` names the plate's G-code; the printer reports the running one as
`gcode_file`), so it is now done (§12): the plate travels from the request (and the "ready" file) to
the mapping and the start command, and an impossible plate is refused before anything is sent. The
AMS mapping is now indexed by filament number with -1 for unused filaments — evidenced by the P2S's
own report — and identical to the hardware-verified array whenever a plate uses all of the project's
filaments. The Library's plate-1 rule is gone for printing (the server decides per printer); the
queue keeps it. Verified: connector tests (plate 3 sent as `plate_3`, trays for one plate refused for
another, sparse mapping `[-1, 3, -1, 0]`), a two-plate project built from the owner's real
`ams.gcode.3mf` over real HTTP (plate 2 maps only filament 2; plate 2 to a printer that cannot choose
plates and plate 9 refused with nothing sent; plate 1 printed and recorded as plate 1, exact). **Not
verified on hardware:** no multi-plate sliced Bambu file exists in the Library and no print was sent
to a Bambu printer.

**2. A root that is gone.** A G-code folder that vanished at once (not a timeout) made dispatch fail
every queued file as missing. Now, for the G-code folder and Library locations alike, a root that
does not answer means nothing is claimed — the item keeps its place — and the Library checks the root;
when it answers, validation is as before, and a file really absent from a root that answers is
"missing". Checkpoint: G-code folder removed (`subst`) → item waited 16 s in place, folder shown
offline, the fleet API answered in ≤ 17 ms; folder back → dispatched; a file renamed away in a folder
that answers → `file-missing`.

**3. Queue saves on Windows.** Replacing `queue-data.json` fails with EPERM while any other process
has it open — measured here: a Node reader holding it open blocks the rename, not a copy from it.
The atomic temp-file + rename design is kept; each step now retries a transient EPERM/EBUSY/EACCES
briefly (10, 25, 50, 100, 200 ms; at most 385 ms, synchronously, as all queue persistence is).
Checkpoint on the packaged server: a 150 ms hold → the action succeeded after 3 retries (logged); a
2 s hold → 503 `queue_save_failed`, the store degraded, the file still the last valid queue; once
released, a save recovered and the action succeeded. A retry never re-runs a transition.

**4. Deferred Library sends** (§9). Checkpoint: K1C sent from the Library to a printing simulator →
pending → uploaded when free → the "ready" entry persisted with its Variant and hash → restart →
started from the printer → Print `snapcon_variant`/`exact`, "sent from the Library, started later from
the printer", audit `staged: true`.

No job was sent to a real printer; every print above went to a simulator.

## 31. M8 results — hardening (2026-10-03)

No new Library feature. What was checked, what it found, and what is left.

**Real Library (live, read-only):** `quick_check` ok, no foreign-key violations, schema 4; 299 files
(all hashed, none missing), 251 Models (3 merged away, none still holding files), 277 Variants,
698 Prints (159 linked; the counts equal the links), 78 open items. Every Library read endpoint
answers in ~15 ms median (the measurement floor here), Diagnostics in 67 ms; the process holds
156 MB. A live print was recorded while it ran.

**Scale (100 printers × 90 days, 27,000 jobs, on a copy of the real Library):** the audit import takes
13 s once (worker); recording one job took ~5 s because every job recomputed every Print's link —
**fixed**: a recorded job now updates only its own link and Model (5 ms; a test checks it agrees with
a full recompute), and the full recompute after grouping memoises shared content (4.8 s → 2.1 s).
Model page with the most-printed history 78 ms, grid 82 ms, Needs attention 77 ms.

**Upgrade and recovery (copies of every real backup):** all ten backups — schemas 1, 2 and 3 —
migrate to 4 with every authored row kept, a pre-migration snapshot each, `quick_check` ok, and
grouping working. A database from a newer SnapCon is left byte-for-byte untouched (Library
unavailable, SnapCon running). A file that is not a database is quarantined and replaced by the
newest good backup (or a new Library, said so). **Found and fixed:** a damaged page that the open
probe does not reach but preparation does ("malformed") left the Library unavailable beside a good
backup; it now gets the same quarantine-and-restore, once (regression test on a damaged root page).

**Security review** (independent, of M5–M7.1). Fixed:
- a crafted Bambu project (`<filament id="4294967295"/>` in `slice_info`) made `/api/map` build a
  four-billion-slot array on the main thread — minutes of a frozen server, then out of memory.
  Filament ids are now bounded (1–64) where they are read and where they index;
- Library actions on an `unlinked_print` item, and their undo, did not check printer visibility: they
  answer 404 now for a printer the person may not see, and the Model's changes no longer show such a
  print's job name and time to them;
- "Accept file change" hashed the G-code folder's path for an item queued from a Library location, so
  such an item could never be accepted; it now uses the item's own location (as the person);
- the queue now refuses a file no printer can start (an STL in a location) before reading it;
- a location's own error text (which can name a share path) is no longer repeated to those who may
  only use the location.
Found sound: location containment (lexical + realpath, junctions), every route's capability and
printer-visibility check, escaping of every value in the Library UI, audit details without paths,
parameterised SQL. Not changed: the realpath check and the later read are not atomic (exploiting it
needs write access to the location itself); M1's admin `location-added`/`-removed` audit events
carry the folder path by design.

**Packaged builds:** win-x64, linux-x64, macos-x64 and macos-arm64 all build. Verified from scratch
on **Windows x64** and **Linux x64** (WSL2 Ubuntu, kernel 6.18): worker thread, `node:sqlite`,
schema 4, indexing and hashing, and a Library print recorded exact. **macOS (x64, arm64) builds
compile, but their runtime behaviour is unverified** — no Mac was available; a packaged macOS smoke
test is a post-release item. **Docker:** its configuration and build inputs were checked statically
(`test/docker.test.js` checks the image's COPY lines); the image was **not** built or run, because
Docker was not available.

**Localisation:** every Library string has a real Spanish translation (the 35 strings identical in
both languages are words like "Material" and placeholders). An installation upgraded from an earlier
version keeps its existing runtime `locales/es.json` (never overwritten, by design), so it shows every
string added since in English — on the owner's instance, the Spanish file is at version 20 of 69.
Release notes say so; changing that policy is the owner's decision.

**Release:** approved by the owner as **SnapCon 0.8.0** (2026-10-04). The Library, printing from it,
print history, the Bambu plate fix and the queue fixes are in RELEASE_NOTES.md under 0.8.0 (the
unreleased 0.7.3 section, never tagged or shipped, became 0.8.0).

**Still unverified on hardware:** starting a Bambu plate other than 1 (no multi-plate sliced Bambu file
exists in the Library, and no print was sent to a Bambu printer).
