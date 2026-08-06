
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
