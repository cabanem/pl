Gladly — this is Phase 3, and it's worth doing with a bit of ceremony, because its output isn't just answers: it's the view catalog (which becomes the agent's API under D1) and the answer key (which becomes the agent's grading rubric in Phase 6). You're not just querying; you're discovering the tool surface. Here's the walkthrough.

**Step 0 — session setup.** Work on a fresh copy from the bucket, opened read-only, with the shell made pleasant:

```bash
gcloud storage cp "${BUCKET}/artifacts/facts.db" .
sqlite3 "file:facts.db?mode=ro"
```

(If Cloud Shell somehow lacks the CLI — my container did — `sudo apt-get install -y sqlite3` fixes it; you have sudo there.) Then inside the shell:

```sql
.headers on
.mode box        -- .mode column if your sqlite3 predates box
.timer on
```

The read-only URI is deliberate discipline: it makes this session physically incapable of the "I'll just fix this one row" temptation, and it's the same mode the Phase 4 tool will use — you're rehearsing the agent's exact vantage point.

**Step 1 — orient before interrogating.** Two habits: anchor the snapshot, and trust `.schema` over memory. Every table is keyed by `snapshot_id`, so every query needs the filter; find yours once:

```sql
SELECT snapshot_id, captured_at, recipe_count FROM snapshots ORDER BY snapshot_id DESC LIMIT 3;
```

Note the id (probably `1`) and use it as a literal below — cleaner for hand-work than subselects everywhere. Then survey the terrain, which doubles as your Phase 2 spot-check:

```sql
SELECT kind, COUNT(*), SUM(resolved=0) AS degraded FROM edges WHERE snapshot_id=1 GROUP BY kind;
```

If a column name I use below doesn't match, `.schema edges` (etc.) is the authority — your `schema.sql` is canonical, and my names come from derive's insert order.

**Question 1 — who writes `WFA_SupplierRequest`, and which columns?** Build it in two moves, because the second move teaches the most useful trick in the whole database. First the naive version — writers only:

```sql
SELECT r.name, e.src_step_path, e.detail_json
FROM edges e
JOIN recipes r ON r.snapshot_id=e.snapshot_id AND r.recipe_id=e.src_recipe_id
WHERE e.snapshot_id=1 AND e.kind='table_write' AND e.dst_name='WFA_SupplierRequest';
```

That answers "who," but the columns are sitting in `detail_json` as underscore-form UUIDs — derive deliberately left resolution to the query layer. The trick is `json_each()`, which explodes a JSON array into rows you can join, and `table_fields.field_key` was built as exactly the underscore form to receive it:

```sql
SELECT r.name AS recipe, e.src_step_path AS step, tf.field_name AS col
FROM edges e
JOIN recipes r      ON r.snapshot_id=e.snapshot_id AND r.recipe_id=e.src_recipe_id
JOIN json_each(e.detail_json, '$.columns') c
JOIN table_fields tf ON tf.snapshot_id=e.snapshot_id AND tf.table_id=e.dst_id
                    AND tf.field_key=c.value
WHERE e.snapshot_id=1 AND e.kind='table_write' AND e.dst_name='WFA_SupplierRequest'
ORDER BY recipe, step;
```

Sanity-check this one against something you know cold — STS-01's status writes, say. If a writer you *know* exists is missing, check whether its edge has `dst_id` NULL (degraded table target) — the join through `table_id` drops those, which is itself a finding.

**Question 2 — every consumer of one `CFG_` field.** This is the `datapills` table's reason for existing, and it's almost embarrassingly direct:

```sql
SELECT r.name, d.step_path, d.pill_path
FROM datapills d
JOIN recipes r ON r.snapshot_id=d.snapshot_id AND r.recipe_id=d.recipe_id
WHERE d.snapshot_id=1 AND d.field_name='rule_scope';
```

Pair it with Q1's shape filtered to the same field and you have the complete read/write picture of one column across 58 recipes — which is the "what breaks if I rename this" answer, your highest-value question class. Feel how *cheap* that was: this is the payoff of putting joins in the deterministic layer.

**Question 3 — the call chain from UPL-01 downward.** The one that needs SQL's power feature, a recursive CTE — worth understanding because graph traversal is what the agent would otherwise burn eight tool calls doing:

```sql
WITH RECURSIVE chain(rid, label, kind, depth) AS (
  SELECT recipe_id, name, 'root', 0
  FROM recipes WHERE snapshot_id=1 AND name LIKE 'UPL-01%'
  UNION ALL
  SELECT e.dst_id, COALESCE(r2.name, e.dst_name, e.dst_id||' (degraded)'), e.kind, c.depth+1
  FROM chain c
  JOIN edges e ON e.snapshot_id=1 AND e.src_recipe_id=c.rid
             AND e.kind IN ('call_sync','call_async')
  LEFT JOIN recipes r2 ON r2.snapshot_id=1 AND r2.recipe_id=e.dst_id
  WHERE c.depth < 8
)
SELECT depth, kind, label FROM chain ORDER BY depth;
```

Three details doing quiet work: the `LEFT JOIN` plus `COALESCE` keeps degraded edges (bare `flow_id`, `resolved=0`) visible instead of silently pruning the chain; `kind` in the output marks sync vs async; and the depth cap is cycle insurance.

**The promotion ritual — this is the actual point.** Keep a running `phase3.sql` file in your repo as you go (in the sqlite shell, `.read phase3.sql` replays it). Each time a join shape recurs — and Q1's json_each-to-field_name resolution will recur *constantly* — strip its WHERE clause and promote it to a named view: Q1 becomes `v_field_writes`, Q2 becomes `v_datapill_consumers`, Q3's inner shape becomes `v_call_graph` if your existing one doesn't already cover it. One wrinkle from our own read-only discipline: you can't `CREATE VIEW` in an `mode=ro` session, and that's correct — views belong in `schema.sql`, not ad-hoc in a db file that regenerates. So the ritual is: prototype the SELECT read-only, and when it earns view-hood, add the `CREATE VIEW` to `schema.sql` and rebuild (or apply once via a brief read-write connection). The catalog stays canonical either way.

Exit test, as the guide says: each question answered in ≤3 statements. But hold the two artifacts as the real deliverable — the view definitions accumulated in `schema.sql`, and your worked answers saved as the calibration key. When Phase 5's agent gets the same questions, its answers get graded against *these*, and its `query()` calls should land on the very views this session discovered. If a question fights you for more than a few minutes, that's signal too: paste the question and what you tried, and we'll work out whether it's a missing view, a derivation gap, or a genuinely hard join.
