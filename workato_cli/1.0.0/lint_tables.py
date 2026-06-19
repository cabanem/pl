PYTHONPATH=/path/to/sdc-recipe-model python3 - <<'PY'
import os, json
from collections import defaultdict
from workato_client import WorkatoClient, WorkatoConfig, safe_parse_json, load_dotenv
from corpus_pass import _resolve_scope_folder
from inspect_corpus import walk_steps
load_dotenv()
client = WorkatoClient(config=WorkatoConfig.from_env())
folder = os.environ["SDC_FOLDER_ID"]
recipes_folder = os.environ.get("SDC_RECIPES_FOLDER_ID") or _resolve_scope_folder(client, folder, "Recipes")

WANT = {"update_variables","declare_variable","declare_list","insert_to_list","insert_to_list_batch"}
samples = defaultdict(list)
for r in client.list_recipes(folder_id=recipes_folder):
    if str(r.get("folder_id")) != str(recipes_folder):
        continue
    if all(len(samples[w]) >= 2 for w in WANT):
        break
    code = safe_parse_json(client.get_recipe(r["id"])["code"])
    for n in walk_steps(code):
        if n.get("provider") == "workato_variable" and len(samples[n.get("name")]) < 2:
            samples[n["name"]].append({k: n.get(k) for k in
                ("name","input","extended_output_schema","extended_input_schema")})
for name, exs in samples.items():
    print("="*60, name)
    for ex in exs:
        print(json.dumps(ex, indent=2)[:1800])
PY
