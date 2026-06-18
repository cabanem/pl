PYTHONPATH=sdc_recipe_model.py python - <<'PY'
import json, os
from workato_client import WorkatoClient, WorkatoConfig, safe_parse_json, load_dotenv
from inspect_corpus import walk_steps
load_dotenv()
client = WorkatoClient(config=WorkatoConfig.from_env())

folders = client.list_folders(parent_id=os.environ["SDC_FOLDER_ID"])
rec_id = next((f["id"] for f in folders if (f.get("name") or "").lower() == "recipes"), None)
recipes = client.list_recipes(folder_id=rec_id) if rec_id else []

shown = 0
for r in recipes:
    if shown >= 2:
        break
    code = safe_parse_json(client.get_recipe(r["id"]).get("code"))
    for n in walk_steps(code):
        if n.get("provider") == "workato_recipe_function" and n.get("name") == "return_result":
            print(f"# from {r.get('name')}")
            print(json.dumps({k: v for k, v in n.items() if k != "block"}, indent=2))
            print("-" * 48)
            shown += 1
            break
PY
