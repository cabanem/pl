PYTHONPATH=/path/to/sdc-recipe-model python3 - <<'PY'
import os
from workato_client import WorkatoClient, WorkatoConfig, load_dotenv
from inspect_corpus import (
    inspect_connector_usage, inspect_provider_input_keys, inspect_provider_samples,
)
load_dotenv()
client = WorkatoClient(config=WorkatoConfig.from_env())
recipes = client.get_structured_recipes(folder_id=os.environ["SDC_FOLDER_ID"], include_code=True)

usage = inspect_connector_usage(recipes)
print("provider :: action   (count)")
for (prov, name), n in usage.most_common():
    print(f"  {n:4}  {prov} :: {name}")

# drill into anything that looks like a data-table op
suspects = {p for (p, n) in usage
            if any(w in f"{p} {n}".lower() for w in ("table", "data", "record", "row"))}
for prov in sorted(suspects):
    print(f"\n--- {prov} ---")
    for action, keys in inspect_provider_input_keys(recipes, prov).items():
        print(f"  {action}: {dict(keys)}")
    s = inspect_provider_samples(recipes, prov, limit=1)
    if s:
        print("  sample input:", s[0]["input"])
PY






PYTHONPATH=/path/to/sdc-recipe-model python3 - <<'PY'
import json
from workato_client import WorkatoClient, WorkatoConfig, safe_parse_json, load_dotenv
from inspect_corpus import walk_steps
from extract import DB_PROVIDERS, WRITE_KIND_BY_NAME
load_dotenv()
client = WorkatoClient(config=WorkatoConfig.from_env())

code = safe_parse_json(client.get_recipe(2044854)["code"])   # STS-01

def shallow(n):                      # node without its child block
    return {k: v for k, v in n.items() if k != "block"}

print("=== WRITE steps — where do column values live? UUIDs or names? ===")
for n in walk_steps(code):
    if n.get("provider") in DB_PROVIDERS and n.get("name") in WRITE_KIND_BY_NAME:
        print(json.dumps(shallow(n), indent=2)); print("-" * 48)

print("\n=== CALL steps — where does the target recipe id live? ===")
for n in walk_steps(code):
    if n.get("keyword") == "call" or n.get("name") in ("call_recipe", "call_recipe_async"):
        print(json.dumps(shallow(n), indent=2)); print("-" * 48)
PY
