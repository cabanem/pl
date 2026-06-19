PYTHONPATH=/path/to/sdc-recipe-model python3 - <<'PY'
import os, json
from collections import defaultdict
from workato_client import WorkatoClient, WorkatoConfig, safe_parse_json, load_dotenv
from corpus_pass import _resolve_scope_folder
from inspect_corpus import walk_steps
load_dotenv()
client = WorkatoClient(config=WorkatoConfig.from_env())
folder = os.environ["SDC_FOLDER_ID"]
rf = os.environ.get("SDC_RECIPES_FOLDER_ID") or _resolve_scope_folder(client, folder, "Recipes")

samples = defaultdict(list)                       # keyed (provider, name)
for r in client.list_recipes(folder_id=rf):
    if str(r.get("folder_id")) != str(rf):
        continue
    code = safe_parse_json(client.get_recipe(r["id"])["code"])
    for n in walk_steps(code):
        prov = n.get("provider") or ""
        if prov.startswith("functional_core_for_sdc"):
            key = (prov, n.get("name"))
            if len(samples[key]) < 2:
                samples[key].append({"provider": prov, "name": n.get("name"), "input": n.get("input")})
for key, exs in sorted(samples.items()):
    print("="*60, f"{key[1]}")
    for ex in exs:
        print(json.dumps(ex, indent=2)[:1800])
PY
