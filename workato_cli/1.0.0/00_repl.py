PYTHONPATH=/path/to/sdc-recipe-model python3 - <<'PY'
import os
from collections import Counter
from workato_client import WorkatoClient, WorkatoConfig, safe_parse_json, load_dotenv
from corpus_pass import _resolve_scope_folder
from normalize import normalize
load_dotenv()
client = WorkatoClient(config=WorkatoConfig.from_env())
folder = os.environ["SDC_FOLDER_ID"]
rf = os.environ.get("SDC_RECIPES_FOLDER_ID") or _resolve_scope_folder(client, folder, "Recipes")

seen = Counter()
rows = []
for r in client.list_recipes(folder_id=rf):
    if str(r.get("folder_id")) != str(rf): continue
    steps = normalize(safe_parse_json(client.get_recipe(r["id"])["code"]))
    trig = next((s for s in steps if s.keyword == "trigger"), None)
    if trig is None:
        rows.append((r.get("name","?")[:28], "(no trigger step found)", "")); continue
    seen[(trig.provider, trig.name)] += 1
    rows.append((r.get("name","?")[:28], trig.provider, trig.name))

print("=== trigger (provider, name) counts across the corpus ===")
for (prov, name), n in seen.most_common():
    print(f"  {n:3}  {prov} :: {name}")
print("\n=== per recipe ===")
for handle, prov, name in sorted(rows):
    print(f"  {handle:28} {prov} :: {name}")
PY
