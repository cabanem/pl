`derive.py`'s design notes encode an expectation from the July analysis: `flow_id` is "normally a dict with a name, degrading to a bare value" — and the same enrichment assumption sits under table targets (`extract_table_target` gets a name only when `table_id` is a dict). But that expectation was learned from *package-style exports*, where Workato resolves references at export time. Your snapshot came through the new standalone `dump_recipes.py`, which pulls **raw code from the Developer API** — and raw code carries bare IDs, no name enrichment. Run that through derive and you get exactly your two symptoms: every call edge marked degraded (bare `flow_id` → `resolved=0`, corpus-wide, hence 100%), and every table edge carrying `dst_id` but a NULL `dst_name` — which is why they show as "fine" in the survey (`resolved=1` needs only the id) while your Q1 filter `e.dst_name='WFA_SupplierRequest'` matches nothing. Same root cause, two presentations. And note what just happened: the honesty line and the empty result *correctly surfaced a source-format shift* instead of papering over it. The system is behaving exactly as designed; the acquisition path changed underneath it.

Confirm it in three cheap looks:

```sql
SELECT dst_id, dst_name, resolved FROM edges WHERE snapshot_id=1 AND kind='call_sync' LIMIT 5;
-- expect: ids populated, names NULL

SELECT COUNT(*) AS external_targets
FROM edges e LEFT JOIN recipes r
  ON r.snapshot_id=e.snapshot_id AND r.recipe_id=e.dst_id
WHERE e.snapshot_id=1 AND e.kind IN ('call_sync','call_async') AND r.recipe_id IS NULL;
-- expect: ~0 — every call target is in the corpus, so "degraded" is cosmetic

SELECT DISTINCT e.dst_id FROM edges e WHERE e.snapshot_id=1 AND e.kind='table_write' LIMIT 5;
SELECT table_id, name FROM tables WHERE snapshot_id=1 LIMIT 5;
-- eyeball: do the id spaces match? this gates the table-name fix below
```

And for ground truth straight from the source: `grep -o '"flow_id":[^,{}]*' dumps/${SNAP}/*.recipe.json | head` — bare numbers confirm the diagnosis.

**Unblocking Q1 right now** — resolve names through the *manifest* rather than expecting the export to carry them, which is arguably how it should have been written anyway (single source of truth for table names is `tables`, exactly per derive's own note that "name resolution is the tool layer's job"):

```sql
SELECT r.name AS recipe, e.src_step_path AS step, tf.field_name AS col
FROM edges e
JOIN tables t        ON t.snapshot_id=e.snapshot_id AND t.table_id=e.dst_id
                    AND t.name='WFA_SupplierRequest'
JOIN recipes r       ON r.snapshot_id=e.snapshot_id AND r.recipe_id=e.src_recipe_id
JOIN json_each(e.detail_json,'$.columns') c
JOIN table_fields tf ON tf.snapshot_id=e.snapshot_id AND tf.table_id=e.dst_id
                    AND tf.field_key=c.value
WHERE e.snapshot_id=1 AND e.kind='table_write'
ORDER BY recipe, step;
```

If the third diagnostic showed mismatched id spaces (numeric vs UUID), tell me what each side looks like — that'd be an adapter fix, not a query fix.

**The durable fix belongs in derive, not in every query.** Resolving a bare id against names *this snapshot already knows* is deterministic work — precisely what the deterministic layer exists for. Paste this after the file loop, just before the `recipe_count` UPDATE:

```python
    # Within-snapshot resolution: raw Developer API code carries bare ids;
    # backfill names from what this snapshot already knows. resolved=0 then
    # means the sharper fact "target not in this snapshot."
    cur.execute("""
        UPDATE edges SET
          dst_name=(SELECT name FROM recipes r WHERE r.snapshot_id=edges.snapshot_id
                    AND r.recipe_id=edges.dst_id), resolved=1
        WHERE snapshot_id=? AND kind IN ('call_sync','call_async') AND dst_name IS NULL
          AND EXISTS (SELECT 1 FROM recipes r WHERE r.snapshot_id=edges.snapshot_id
                      AND r.recipe_id=edges.dst_id)""", (sid,))
    counts["backfilled_calls"] = cur.rowcount
    cur.execute("""
        UPDATE edges SET
          dst_name=(SELECT name FROM tables t WHERE t.snapshot_id=edges.snapshot_id
                    AND t.table_id=edges.dst_id)
        WHERE snapshot_id=? AND kind IN ('table_read','table_write') AND dst_name IS NULL
          AND EXISTS (SELECT 1 FROM tables t WHERE t.snapshot_id=edges.snapshot_id
                      AND t.table_id=edges.dst_id)""", (sid,))
```

The `EXISTS` guards make both no-ops if nothing matches, so they're safe even before you've confirmed the id spaces. Add a report line for `backfilled_calls` in `main()` in the same register as the other NOTEs, then clean rebuild (`rm facts.db`, re-create from `schema.sql`, rerun derive — the single-commit property means there's never partial state to worry about). Afterward your survey should show degradation near zero, with any *remaining* `resolved=0` edges meaning something real: calls out of the corpus. Happy to re-render the full `derive.py` with this folded in once your diagnostics confirm.

One last thing worth saving: "package exports enrich references with names; raw Developer API code carries bare ids" is a genuine entry for that Python↔Workato boundary-knowledge writeup you've been meaning to compile — it's exactly the class of trap that costs an afternoon the first time and thirty seconds every time after it's written down.
