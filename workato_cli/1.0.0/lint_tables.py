PYTHONPATH=/path/to/sdc-recipe-model python3 - <<'PY'
import os, json
from workato_client import WorkatoClient, WorkatoConfig, WorkatoHTTPError, load_dotenv
from inspect_corpus import walk_steps
load_dotenv()

client = WorkatoClient(config=WorkatoConfig.from_env())
print("records_host:", client.config.records_host, " (must match your data center)")

tables = client.list_data_tables()
print("\n/api/data_tables first row — ALL fields:")
print(json.dumps(tables[0], indent=2))

recipes = client.get_structured_recipes(folder_id=os.environ["SDC_FOLDER_ID"], include_code=True)
tids = []
for r in recipes:
    for node in walk_steps(r.get("code") or {}):
        if node.get("provider") in ("workato_db_table", "data_tables"):
            di = node.get("input") or {}
            t = di.get("data_table_id") or di.get("table_id") or di.get("data_table")
            if t:
                tids.append(t)
print("\nrecipe data_table_id(s) actually in use:", tids[:3])

tid = tids[0] if tids else tables[0].get("id")
print("\nlist id == recipe id ?", any(t == tables[0].get("id") for t in tids))
try:
    s = client.get_table_schema(tid)
    print("schema GET OK — name:", s.get("name"), "| first column:", (s.get("schema") or [None])[0])
except WorkatoHTTPError as e:
    print("schema GET FAILED:", e)
PY
