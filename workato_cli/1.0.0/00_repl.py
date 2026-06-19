PYTHONPATH=sdc_recipe_model.py python - <<'PY' >> output.txt
import os, json
from collections import defaultdict
from workato_client import WorkatoClient, WorkatoConfig, safe_parse_json, load_dotenv
from corpus_pass import _resolve_scope_folder
from inspect_corpus import walk_steps
load_dotenv()
client = WorkatoClient(config=WorkatoConfig.from_env())
folder = os.environ["SDC_FOLDER_ID"]
rf = os.environ.get("SDC_RECIPES_FOLDER_ID") or _resolve_scope_folder(client, folder, "Recipes")

WANT = {("workato_api_platform","return_response"), ("workato_workflow_task","app_function_return")}
samples = defaultdict(list)
for r in client.list_recipes(folder_id=rf):
    if str(r.get("folder_id")) != str(rf): continue
    if all(len(samples[k]) >= 2 for k in WANT): break
    code = safe_parse_json(client.get_recipe(r["id"])["code"])
    for n in walk_steps(code):
        key = (n.get("provider"), n.get("name"))
        if key in WANT and len(samples[key]) < 2:
            samples[key].append({k: n.get(k) for k in
                ("provider","name","input","extended_output_schema","extended_input_schema")})
for key, exs in samples.items():
    print("="*60, key)
    for ex in exs: print(json.dumps(ex, indent=2)[:2000])
PY
