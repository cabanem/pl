PYTHONPATH=/path/to/sdc-recipe-model python3 - <<'PY'
import os, json
from workato_client import WorkatoClient, WorkatoConfig, safe_parse_json, load_dotenv
from corpus_pass import _resolve_scope_folder
from normalize import normalize, CONTROL_KEYWORDS
from extract import extract, PY_PROVIDERS, STATE_PROVIDERS, TRANSFORM_PROVIDERS
load_dotenv()
client = WorkatoClient(config=WorkatoConfig.from_env())
folder = os.environ["SDC_FOLDER_ID"]
rf = os.environ.get("SDC_RECIPES_FOLDER_ID") or _resolve_scope_folder(client, folder, "Recipes")

for r in client.list_recipes(folder_id=rf):
    if str(r.get("folder_id")) != str(rf): continue
    code = safe_parse_json(client.get_recipe(r["id"])["code"])
    steps = normalize(code)
    edged = {e.anchor.uuid for e in extract(steps, r["id"]) if e.anchor and e.anchor.uuid}
    for s in steps:
        if (s.keyword not in CONTROL_KEYWORDS and s.provider not in PY_PROVIDERS
                and s.provider not in STATE_PROVIDERS and s.provider not in TRANSFORM_PROVIDERS
                and s.uuid not in edged and s.keyword != "trigger"
                and (not s.provider or not s.name)):
            print(f"{r.get('name','?')[:24]:24} keyword={s.keyword!r:12} provider={s.provider!r} name={s.name!r}")
PY
