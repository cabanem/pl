None — and that's worth saying with a little ceremony, because this is the middle path cashing its first extensibility check: a brand-new question class arrives, and the answer is a query, not a tool. Every step of every recipe is already in `steps`, WFA actions included. What stands between you and the answer isn't capability but *vocabulary*: "Update a request in a workflow app" and "Change workflow stage" are display labels, and `steps.provider`/`steps.name` hold the machine names underneath them. So the method is discover-then-census.

**Discovery — find the real strings.** Two routes; I'd run both because the first is generally useful anyway. The provider census, which doubles as an orientation artifact for the whole corpus:

```sql
SELECT provider, name, COUNT(*) AS uses
FROM steps
WHERE snapshot_id=(SELECT snapshot_id FROM v_latest_snapshot)
GROUP BY provider, name
ORDER BY provider, uses DESC;
```

The WFA provider will announce itself (something in the `workato_workflow`/`workflow_apps` neighborhood), with the two action names sitting under it. And the anchored route, using a recipe you already know cold — STS-01 *is* the status machine, so it necessarily contains the stage-change action:

```sql
SELECT step_path, provider, name
FROM steps
WHERE snapshot_id=(SELECT snapshot_id FROM v_latest_snapshot)
  AND recipe_id=(SELECT recipe_id FROM recipes
                 WHERE snapshot_id=(SELECT snapshot_id FROM v_latest_snapshot)
                   AND name LIKE 'STS-01%')
ORDER BY step_path;
```

Read the provider/name pair straight off the step you recognize. Where the labels agree between routes, you have ground truth.

**Census — the actual answer.** Substitute the discovered strings:

```sql
SELECT r.name AS recipe, s.step_path, s.name AS action
FROM steps s
JOIN recipes r ON r.snapshot_id=s.snapshot_id AND r.recipe_id=s.recipe_id
WHERE s.snapshot_id=(SELECT snapshot_id FROM v_latest_snapshot)
  AND s.provider='<wfa provider>'
  AND s.name IN ('<update_request_name>', '<change_stage_name>')
ORDER BY recipe, step_path;
```

If you then want to distinguish *which* app or request type each step touches, that identity lives in the step's input — in your hand session, `SELECT input_json FROM steps WHERE …` and eyeball one (the shielding only applies through `corpus.py`; the agent would use `get_step` for the same look). Once you've seen the input shape, a `json_extract` of the relevant key can join the census, and per the ritual, if this question recurs it becomes `v_wfa_actions` in the catalog — a fifteen-second promotion, steps-based, no derivation change.

One architectural observation while you're here, because your question brushes against a real boundary in the current design: WFA actions exist in `steps` but **cast no edges**. Derive's edge extraction knows two providers — recipe functions and db tables — so "Update a request" is invisible to the impact graph: `v_table_use` won't show it touching `WFA_SupplierRequest`'s workflow state, and a blast-radius question about requests won't traverse it. For today's census that's irrelevant. It starts mattering when you ask *impact*-shaped WFA questions — "everything that mutates supplier-facing request state" — at which point the promotion is a new edge kind (`wfa_write`, say) extracted in derive from these steps' inputs. Note the deliberate friction there: `edges.kind` has a CHECK constraint, so a new kind means editing `schema.sql` — and note also why that friction is nearly free in this design: `facts.db` is a pure derivation, so schema migration is `rm facts.db`, rebuild, re-derive. No data migration, ever; the dumps are the truth. That's the parse-once-at-boundary architecture quietly making future-you's life easy.

So: view promotion if the census question recurs, edge promotion only when an impact question demands it, and nothing at all if today's answer suffices. The system's extension ladder, working exactly as priced.
