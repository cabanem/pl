# Workato Recipe Export — Setup Guide

Capture your Workato recipes as clean, normalized, **git-diffable JSON**.
Two scripts, no third-party packages, no cloud dependencies:

- **`dump_recipes.py`** — pulls recipe code and data-table schemas from the
  Workato Developer API into one snapshot directory. The output is
  deterministic pretty JSON: run it twice with no recipe changes and the
  files are byte-identical, so committing a dump to git gives you clean,
  reviewable diffs whenever a recipe actually changes.
- **`derive.py`** *(optional)* — walks a snapshot into a queryable SQLite
  database and prints a verification report (counts + anomaly lines). Useful
  as a sanity gate before committing, and as a bonus you can answer
  questions like "which recipes write this table?" with SQL.

## Requirements

- Python 3.9+ (standard library only — nothing to pip install)
- A Workato API client token with **read** scope on *Recipes* and
  *Data tables* (Workspace admin → API clients → create client). Data-table
  scope is optional — see `--no-tables` below.

## Install

Copy the files anywhere; a layout that works well for a git repo:

    your-repo/
      tools/
        dump_recipes.py
        derive.py          # optional
        schema.sql         # only needed by derive.py
      recipes/             # dump target — this is what git versions

## Configure

Everything is environment variables — the token never lives in a file:

    export WORKATO_API_TOKEN='<your token>'      # required
    export WORKATO_API_BASE='https://www.workato.com'
    #   EU data center workspaces MUST use: https://app.eu.workato.com
    #   (wrong host = 401 even with a valid token)

Find your folder id in the Workato UI URL when viewing the folder
(or omit `--folder` to dump every recipe the token can see).

## First run

    python3 tools/dump_recipes.py --folder <FOLDER_ID> --dest recipes

Expected output: one line per recipe, then a summary. The directory now
contains:

    {RecipeName}__{id}.recipe.json   one per recipe — code tree parsed,
                                     pretty-printed, deterministic
    manifest.json                    data-table schema map (table + field
                                     names, ids canonicalized to the id-space
                                     recipe code uses)
    _manifest.json                   provenance: what was dumped, when, errors
    _tables_raw.json                 untransformed data-tables API response
                                     (diagnostic escape hatch)

Exit code is nonzero if any recipe failed — failures are listed in
`_manifest.json` under `errors`.

Targeting specific recipes (ids, or name prefixes):

    python3 tools/dump_recipes.py --dest recipes STS-01 UPL-01 84

## Using it with git

- **Dump to one fixed directory** (`recipes/`) and let git be the history —
  don't create timestamped directories; commits are your timeline.
- **Wipe recipe files before each dump** in a scheduled pipeline:
  `rm -f recipes/*.recipe.json` first. The dumper writes files but never
  deletes, so a recipe deleted in Workato would otherwise linger as a stale
  file (and its disappearance is exactly the diff you want git to show).
- **Commit the sidecars too.** `_manifest.json`'s `dumped_at` line changes
  every run — that one-line diff is provenance, not noise. If it bothers
  you, `.gitignore` `_manifest.json`, but you lose the error record.
- **Never commit the token.** It exists only as an environment variable; in
  GitLab CI, store it as a masked CI/CD variable. (Wiring the pipeline
  itself is outside this guide.)
- Runs are paced to respect Workato's API rate limit (~0.5s per recipe);
  a 60-recipe folder takes under a minute.

## Optional: verify with derive.py

Before committing, build the fact database and read its report:

    sqlite3 facts.db < tools/schema.sql        # once (or after deleting facts.db)
    python3 tools/derive.py --dumps recipes --manifest recipes/manifest.json \
        --db facts.db --notes "$(date -u +%F)"

The report prints recipe/step/edge counts plus honesty lines: sidecar files
ignored, degraded references (targets not present in the dump), unresolvable
field references. Nonzero anomaly counts are normal — what matters is that
they're *stable* run to run; a jump is your cue to look before committing.
`facts.db` is disposable and rebuildable — don't commit it; the JSON is the
source of truth.

Bonus queries once it exists (`sqlite3 "file:facts.db?mode=ro"`):

    -- who writes a given data table?
    SELECT DISTINCT r.name FROM edges e
    JOIN recipes r ON r.snapshot_id=e.snapshot_id AND r.recipe_id=e.src_recipe_id
    WHERE e.kind='table_write' AND e.dst_name='YOUR_TABLE_NAME';

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `WORKATO_API_TOKEN is unset` | The variable wasn't **export**ed (assignment alone isn't inherited by Python). |
| 401 on every call | Wrong data center host (set `WORKATO_API_BASE`) — or the token was rotated/revoked. Check which host works in your browser/curl first. |
| `data tables: FAILED ... may lack data-table scope` | Token has no data-tables read scope. Recipes still dump fine; add the scope, or run with `--no-tables`. |
| `unrecognized list envelope: ... keys=[...]` | The API wrapped a list in a key the script doesn't know. Add the printed key to `unwrap_list()` in `dump_recipes.py` (one word). |
| `SKIP <file>: not a recipe export` during derive | Normal — sidecar or non-recipe JSON in the dump directory; it's excluded and counted, not ingested. |
| Fields "without uuid" in the dump report | The schema field key shape differs on your instance. Inspect `_tables_raw.json`; `field_uuid()` in `dump_recipes.py` and `load_manifest()` in `derive.py` are the two adapter points. |

## Things already handled (so you don't re-discover them)

- The Developer API returns recipe `code` as a JSON **string**; it's parsed
  at the boundary, and already-parsed code is tolerated.
- Data tables have two identities (`id` = UUID, `numeric_id`); everything
  here canonicalizes on `numeric_id` — the id recipe code actually uses.
- Table-write inputs key columns by underscore-form field UUIDs, not names;
  `derive.py` stores both forms so name resolution never needs string
  surgery.
- Sidecar files share the `.json` suffix with recipes; the `.recipe.json`
  filename contract plus shape guards keep them out of derivation.
