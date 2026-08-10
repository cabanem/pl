## Diagnose table ID mismatch
Three quick looks to characterize it:

```sql
SELECT snapshot_id, COUNT(*) FROM tables GROUP BY snapshot_id;
-- rules out the boring cause: derive rerun without --manifest → empty tables → guaranteed no-op

SELECT DISTINCT dst_id FROM edges WHERE snapshot_id=2 AND dst_type='table' LIMIT 5;
SELECT table_id, name FROM tables WHERE snapshot_id=2 LIMIT 5;
-- the side-by-side: numeric vs UUID? UUID vs UUID-in-different-dress?
```

And the escape hatch built for exactly this moment — inventory every id-ish key the raw API response actually carries:

```bash
python3 -c "
import json
t = json.load(open('dumps/${SNAP}/_tables_raw.json'))[0]
print('keys:', sorted(t.keys()))
print({k: t[k] for k in t if 'id' in k.lower() or 'uuid' in k.lower()})"
```

## Rederive
That settles it, and the diagnosis lands exactly where the principle pointed: the data-tables listing carries **two identities** — `id` (a UUID) and `numeric_id` (25830) — and `build_table_manifest` grabbed `id`, while recipe code's `table_id` inputs speak the *numeric* space. One glance at `SELECT DISTINCT dst_id FROM edges WHERE snapshot_id=2 AND dst_type='table' LIMIT 5;` should show 25830-style numerics, confirming it. The manifest canonicalized on the identity code never uses; every table join went dark; the backfill's `EXISTS` guard correctly refused to pretend otherwise.

The fix is one line at the acquisition boundary — canonicalize on the id-space code speaks:Patched, verified, attached. Now the pleasant part: **you don't need to re-dump anything.** This is `_tables_raw.json` earning its keep as the escape hatch — it holds the untransformed listing including `numeric_id`, so the corrected manifest regenerates locally, zero API calls:

```bash
python3 - <<'PY'
import json
from dump_recipes import build_table_manifest        # the patched one
snap = "dumps/SNAP"                                  # your snapshot dir
raw = json.load(open(f"{snap}/_tables_raw.json"))
with open(f"{snap}/manifest.json", "w") as fh:
    json.dump(build_table_manifest(raw), fh, indent=2)
print("manifest.json rebuilt on numeric_id")
PY
```

Then re-derive — snapshot 3 — and run the contrast:

```sql
SELECT snapshot_id, SUM(dst_name IS NULL) AS unnamed
FROM edges WHERE kind IN ('table_read','table_write') GROUP BY snapshot_id;
```

Expected: snapshot 3 at or near zero, because the fix cascades through everything the one join key was blocking — the backfill's `EXISTS` now matches so `dst_name` fills, `v_table_access` resolves names, and Q1's column expansion through `table_fields` comes alive, since `tf.table_id` now lives in the same numeric space as `e.dst_id`. Any *residual* unnamed edge in snapshot 3 is no longer noise but a genuine finding: code referencing a table absent from the current listing — deleted, or outside this workspace. Sync the corrected manifest back so the bucket's snapshot is self-consistent (`gcloud storage cp dumps/SNAP/manifest.json "${BUCKET}/snapshots/SNAP/"` — versioning keeps the flawed one as history), and push the fresh `facts.db` to `artifacts/` once the contrast query confirms.

And the boundary-doc entry, now in its final sharpened form: *Workato data tables carry two identities — the data-tables API returns `id` (UUID) and `numeric_id`; recipe code's `table_id` inputs use only the numeric one. Any manifest feeding reference resolution must canonicalize on `numeric_id`, or every table join silently returns NULL.* Two sessions, two entries for that writeup — the corpus agent is documenting the platform's traps as a side effect of being built, which is about as on-brand for this project as it gets.
