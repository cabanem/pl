Same format as the Phase 3 session, but structured as three acts with a prediction before each — because this walkthrough's real product isn't the diffs, it's *calibrated trust* in the diff machinery: one true-negative, one live demonstration of the conflation trap, one true-positive you manufacture yourself.

**Step 0 — setup.** Your local `facts.db` already holds all three fossils (the bucket artifact does too if you've been syncing after each derive — the db accumulates snapshots, which is the whole point). Open it read-only, and check one version gate:

```bash
sqlite3 --version    # need ≥ 3.39 for FULL OUTER JOIN; Cloud Shell's is newer
sqlite3 "file:facts.db?mode=ro"
```

```sql
.headers on
.mode box
SELECT snapshot_id, captured_at, recipe_count, notes FROM snapshots;
```

Keep a `diff.sql` scratch file going as you work (`.read diff.sql` replays it) — winners get promoted at the end.

**Act 1 — the true-negative.** Snapshots 1, 2, 3 were derived from the *same recipe dumps* by three versions of the pipeline. Fingerprints hash only the code tree, which none of the pipeline fixes touched. **Prediction: zero rows.** Diff the extremes:

```sql
WITH a AS (SELECT * FROM recipes WHERE snapshot_id=1),
     b AS (SELECT * FROM recipes WHERE snapshot_id=3)
SELECT COALESCE(b.name, a.name) AS recipe,
       CASE WHEN a.recipe_id IS NULL THEN 'added'
            WHEN b.recipe_id IS NULL THEN 'removed'
            WHEN a.fingerprint <> b.fingerprint THEN 'edited'
            ELSE 'unchanged' END AS status
FROM a FULL OUTER JOIN b ON a.recipe_id = b.recipe_id
WHERE status <> 'unchanged';
```

Empty result = the machinery correctly reports "nothing happened" when nothing happened — the diff equivalent of a clean control group. If anything *does* appear, that's interesting rather than wrong: `added`/`removed` would mean the two derive runs saw different file sets (compare `raw_path`s), and `edited` would mean fingerprinting isn't deterministic — either one worth bringing to me before proceeding.

**Act 2 — watch the conflation trap fire, on purpose.** Now the Level 3 field-writers diff between snapshots **2 and 3**. Prediction first, and reason it out: the writers CTE joins `edges.dst_id` to `tables.table_id` — in snapshot 2 the manifest still carried UUIDs, so that join produces *nothing* on the `a` side, while snapshot 3 resolves fully. So the diff should scream that **every field writer in the corpus was "added"** — dozens of rows of apparent drift, none of it real:

```sql
WITH w AS (
  SELECT e.snapshot_id, t.name AS table_name, tf.field_name, r.name AS recipe
  FROM edges e
  JOIN tables t  ON t.snapshot_id=e.snapshot_id AND t.table_id=e.dst_id
  JOIN recipes r ON r.snapshot_id=e.snapshot_id AND r.recipe_id=e.src_recipe_id
  JOIN json_each(e.detail_json,'$.columns') c
  JOIN table_fields tf ON tf.snapshot_id=e.snapshot_id AND tf.table_id=e.dst_id
                      AND tf.field_key=c.value
  WHERE e.kind='table_write')
SELECT COALESCE(b.recipe,a.recipe) AS recipe,
       COALESCE(b.table_name,a.table_name) AS tbl,
       COALESCE(b.field_name,a.field_name) AS field,
       CASE WHEN a.recipe IS NULL THEN 'writer added' ELSE 'writer removed' END AS drift
FROM (SELECT * FROM w WHERE snapshot_id=2) a
FULL OUTER JOIN (SELECT * FROM w WHERE snapshot_id=3) b
  ON a.table_name=b.table_name AND a.field_name=b.field_name AND a.recipe=b.recipe
WHERE a.recipe IS NULL OR b.recipe IS NULL;
```

Sit with that output for a moment — it's what derivation drift looks like when it masquerades as corpus drift, and it's why the discipline is *only diff same-pipeline snapshots*. Make the discipline enforceable going forward by tagging every future derive: `--notes "${SNAP} derive=r3"`. (For the three untagged fossils, I'd just record the mapping in your phase notes rather than opening a write session — bending the derive-is-the-only-writer rule to annotate history isn't worth it for three rows you'll soon stop diffing against.)

**Act 3 — manufacture a true-positive.** In Workato, make one *revertible, code-tree-touching* edit to a sandbox or low-stakes recipe — renaming a step or editing a step comment is ideal, because it lands inside the step node (so the fingerprint moves) without inserting anything (so Act 3 stays clean of the positional-shift effect — that gets its own moment below). Recipe *description* won't work: it's metadata outside `code`, invisible to the fingerprint by design. Then the full pipeline, tagged:

```bash
export WORKATO_API_TOKEN="$(gcloud secrets versions access latest --secret="${SECRET}")"
SNAP2="snap_$(date -u +%Y%m%dT%H%M%SZ)"
python3 dump_recipes.py --folder <id> --dest dumps/${SNAP2}
python3 derive.py --dumps dumps/${SNAP2} --manifest dumps/${SNAP2}/manifest.json \
  --db facts.db --notes "${SNAP2} derive=r3 test-edit"
```

**Prediction: exactly one `edited` row.** Run the Act 1 query with `snapshot_id=3` and `snapshot_id=4` — same-pipeline snapshots now, so the comparison is legitimate. One row, your sandbox recipe: the machinery detects a real edit against a background of 57 unchanged. That's your true-positive, and the pair of acts together is the validation.

Then localize it with Level 2, scoped to just that recipe — note the `IS NOT` comparisons, which is SQLite's null-safe "differs" (plain `<>` silently swallows NULL-vs-value differences):

```sql
WITH a AS (SELECT * FROM steps WHERE snapshot_id=3 AND recipe_id='<rid>'),
     b AS (SELECT * FROM steps WHERE snapshot_id=4 AND recipe_id='<rid>')
SELECT COALESCE(b.step_path,a.step_path) AS step_path,
       CASE WHEN a.step_path IS NULL THEN 'added'
            WHEN b.step_path IS NULL THEN 'removed'
            WHEN a.input_json IS NOT b.input_json OR a.name IS NOT b.name
              OR a.provider IS NOT b.provider OR a.keyword IS NOT b.keyword
            THEN 'modified' ELSE 'same' END AS status,
       COALESCE(b.provider,a.provider) AS provider,
       COALESCE(b.name,a.name) AS name
FROM a FULL OUTER JOIN b ON a.step_path = b.step_path
WHERE status <> 'same';
```

One `modified` row at the step you touched. And if you want to *feel* the caveat rather than take my word for it: as an optional epilogue, insert a step early in the same sandbox recipe, dump, derive snapshot 5, rerun Level 2 — and watch one insertion read as a cascade of "modified" rows as every positional identity after it shifts. Seeing that once inoculates you against ever over-trusting step-level diffs. Revert the sandbox recipe when done.

**Promotion, if and only if both acts pass.** Level 1's latest-vs-previous shape is parameter-free, so it's catalog-eligible — append to `schema_catalog.sql`:

```sql
-- Drift: recipes changed between the latest two snapshots. Only meaningful
-- when both snapshots share a derive version (check snapshots.notes).
CREATE VIEW IF NOT EXISTS v_recipe_drift AS
WITH latest AS (SELECT MAX(snapshot_id) AS s FROM snapshots),
     prev   AS (SELECT MAX(snapshot_id) AS s FROM snapshots
                 WHERE snapshot_id < (SELECT s FROM latest)),
     a AS (SELECT * FROM recipes WHERE snapshot_id=(SELECT s FROM prev)),
     b AS (SELECT * FROM recipes WHERE snapshot_id=(SELECT s FROM latest))
SELECT COALESCE(b.name, a.name) AS recipe,
       COALESCE(b.recipe_id, a.recipe_id) AS recipe_id,
       CASE WHEN a.recipe_id IS NULL THEN 'added'
            WHEN b.recipe_id IS NULL THEN 'removed'
            ELSE 'edited' END AS status
  FROM a FULL OUTER JOIN b ON a.recipe_id = b.recipe_id
 WHERE a.recipe_id IS NULL OR b.recipe_id IS NULL
    OR a.fingerprint <> b.fingerprint;
```

Exit criteria for the afternoon: Act 1 empty, Act 2's noise understood (and the tagging habit adopted), Act 3 catching exactly your one edit, `v_recipe_drift` in the catalog. At that point the drift machinery is *validated*, and what remains for real M2 is only cadence and workflow — scheduled dumps so snapshots track calendar time, and findings review. The Level 2/3 shapes stay in `diff.sql` as proven-but-unpromoted, which is exactly where they belong until a real question pulls them up.
