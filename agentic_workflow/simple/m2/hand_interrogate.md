This is the itch the schema was built to scratch — "M2 diffing is a self-join" has been a promissory note since July, and you're now holding everything it needs. No new derivation, no new tables: recipe edits are already sitting in `facts.db` as differences between snapshot rows. Let me show you the query family, plus two honest caveats and one experiment your existing fossils make possible.

**Level 1 — *that* something changed.** The `fingerprint` column exists precisely for this: a hash of the normalized code tree, so any edit anywhere in a recipe changes it. Latest-vs-previous is a full outer self-join:

```sql
WITH a AS (SELECT * FROM recipes WHERE snapshot_id=(SELECT MAX(snapshot_id)-1 FROM snapshots)),
     b AS (SELECT * FROM recipes WHERE snapshot_id=(SELECT MAX(snapshot_id) FROM snapshots))
SELECT COALESCE(b.name, a.name) AS recipe,
       CASE WHEN a.recipe_id IS NULL THEN 'added'
            WHEN b.recipe_id IS NULL THEN 'removed'
            WHEN a.fingerprint <> b.fingerprint THEN 'edited'
            ELSE 'unchanged' END AS status
FROM a FULL OUTER JOIN b ON a.recipe_id = b.recipe_id
WHERE status <> 'unchanged';
```

(`FULL OUTER JOIN` needs SQLite ≥3.39 — Cloud Shell's is newer, fine.)

**Level 2 — roughly *where*.** Same shape over `steps` on `(recipe_id, step_path)`, comparing `provider/name/keyword/input_json`. But here's caveat one, worth internalizing before you trust it: **`step_path` is positional identity**, so inserting one step shifts every sibling after it, and a single insertion reads as N "modifications." Level 2 answers "what region of the recipe moved," not "the precise edit." The M2-grade refinement, when it's earned, is per-step content hashes in derive — but even those don't fully solve insertion shift; that's the classic tree-diff problem, and resisting solving it before a real question demands it is exactly your guard working.

**Level 3 — the semantic diff, and honestly the gem.** Diff *edges* instead of steps: because typed relationships ignore position, set-comparing them is stable where Level 2 is noisy, and it speaks your platform's language directly:

```sql
-- writers gained or lost per (table, field) between the last two snapshots
WITH w AS (
  SELECT e.snapshot_id, t.name AS table_name, tf.field_name, r.name AS recipe
  FROM edges e
  JOIN tables t  ON t.snapshot_id=e.snapshot_id AND t.table_id=e.dst_id
  JOIN recipes r ON r.snapshot_id=e.snapshot_id AND r.recipe_id=e.src_recipe_id
  JOIN json_each(e.detail_json,'$.columns') c
  JOIN table_fields tf ON tf.snapshot_id=e.snapshot_id AND tf.table_id=e.dst_id
                      AND tf.field_key=c.value
  WHERE e.kind='table_write')
SELECT COALESCE(b.table_name,a.table_name) AS tbl,
       COALESCE(b.field_name,a.field_name) AS field,
       COALESCE(b.recipe,a.recipe) AS recipe,
       CASE WHEN a.recipe IS NULL THEN 'writer added' ELSE 'writer removed' END AS drift
FROM (SELECT * FROM w WHERE snapshot_id=(SELECT MAX(snapshot_id)-1 FROM snapshots)) a
FULL OUTER JOIN (SELECT * FROM w WHERE snapshot_id=(SELECT MAX(snapshot_id) FROM snapshots)) b
  ON a.table_name=b.table_name AND a.field_name=b.field_name AND a.recipe=b.recipe
WHERE a.recipe IS NULL OR b.recipe IS NULL;
```

"REM-02 stopped writing `last_reminder_sent_at`" as a query result is drift diagnosis — capability #2 on your own ranking — falling out of M1's schema for free. Same pattern works for call edges and connections.

**Caveat two, and it matters for your existing data:** snapshots 1, 2, and 3 differ by *derivation*, not by corpus — same dumps, three versions of the pipeline. So a snapshot diff conflates two kinds of change: recipe edits and derive.py edits. Level 1 across your fossils should report **zero edited recipes** (fingerprints hash the code tree, untouched by the backfill or manifest fixes) — run it; it's a free true-negative test of the diff machinery. But Level 3 across them will light up with the backfill and id-space changes, which demonstrates the conflation live. The discipline that follows: only diff snapshots derived by the same pipeline version, and make that checkable by tagging derive's version in `--notes` (you already pass `--notes`; something like `"${SNAP} derive=r3"` costs nothing and makes the constraint queryable).

Where the boundary sits: run these by hand now — it's Phase 3 methodology applied forward, and the true-negative check plus one deliberate test edit (touch a sandbox recipe, re-dump, re-derive, watch Level 1 catch exactly it) would validate the whole family in an afternoon. The Level 1 query is even eligible for the catalog as `v_recipe_drift` since "latest vs previous" needs no parameters. What stays firmly M2: scheduling dumps so snapshots track real time, drift *findings* with review flow, and step-level precision. The agent, notably, needs nothing new to participate — `query` already reaches all of this, and one paragraph in BRIEF.md ("for change questions, diff snapshots; beware derivation-version conflation") would make it drift-capable the day snapshots start accumulating for real. That last part I'd genuinely hold until calibration passes — but the hand-run experiment costs an afternoon and pays for itself in trust.
