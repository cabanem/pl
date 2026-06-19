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

CAP = {"store_file":2, "get_file_contents":2, "ensure_dir_exists":2, "create_shareable_link":2,
       "delete_file":1, "delete_directory":1, "append_to_file":1, "search_files":1}
samples = defaultdict(list)
for r in client.list_recipes(folder_id=rf):
    if str(r.get("folder_id")) != str(rf): continue
    if all(len(samples[k]) >= v for k, v in CAP.items()): break
    code = safe_parse_json(client.get_recipe(r["id"])["code"])
    for n in walk_steps(code):
        if n.get("provider") == "workato_files":
            nm = n.get("name")
            if len(samples[nm]) < CAP.get(nm, 1):
                samples[nm].append({"name": nm, "input": n.get("input")})
for nm, exs in samples.items():
    print("="*60, nm)
    for ex in exs:
        print(json.dumps(ex, indent=2)[:1500])
PY
