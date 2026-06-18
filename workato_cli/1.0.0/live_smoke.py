"""live_smoke — staged, READ-ONLY verification of stage 1 against a real workspace.

Run order is cheapest-first: each gate confirms one assumption the next depends
on, and the run halts at the first surprise, printing the actual shape it found.
Every call is a GET (list, detail, folder_assets, table list, table schema) — no
/query, no writes — so this cannot mutate anything.

Prereqs (stdlib only, no pip install):
  export WORKATO_API_TOKEN=...        # required
  export WORKATO_BASE_URL=...         # only if you are NOT on app.eu.workato.com
  export SDC_FOLDER_ID=...            # the folder to test against

  python3 live_smoke.py

Each stage is a standalone function returning what the next one needs, so you can
also import them and run one at a time in a REPL.
"""
from __future__ import annotations

import os
import sys

from workato_client import WorkatoClient, WorkatoConfig, WorkatoHTTPError, safe_parse_json
from registries import derive_handle, build_recipe_registry, build_table_schema_registry, fetch_needed_schemas
from inspect_corpus import inspect_connector_usage, inspect_recipe_keywords, inspect_provider_input_keys


def _hr(title):
    print(f"\n{'=' * 4} {title} {'=' * 4}")


# Stage 0 — config / host derivation (no network) ---------------------------
def stage0_config():
    _hr("0  config + host derivation")
    cfg = WorkatoConfig.from_env()
    if not cfg.api_token:
        sys.exit("STOP: WORKATO_API_TOKEN is not set.")
    print("base_url    :", cfg.base_url)
    print("records_host:", cfg.records_host)
    print("LOOK: is records_host the right data-tables host for your data center?")
    return WorkatoClient(config=cfg)


# Stage 1 — auth + list envelope (1 call) -----------------------------------
def stage1_auth(client):
    _hr("1  auth + list shape  (1 call)")
    data = client.get("/api/recipes?page=1&per_page=1", "smoke: list one recipe")
    batch = data.get("items") if isinstance(data, dict) else data
    if not batch:
        sys.exit("STOP: list returned no recipes. Check the token's scope / workspace.")
    first = batch[0]
    print("envelope    :", "items[]" if isinstance(data, dict) and "items" in data else type(data).__name__)
    print("first recipe:", {k: first.get(k) for k in ("id", "name", "folder_id", "running")})
    print("PASS: auth works and the list shape is understood.")
    return first["id"]


# Stage 2 — detail + parse boundary (1 call) --------------------------------
def stage2_parse_boundary(client, recipe_id):
    _hr("2  detail + parse boundary  (1 call)")
    detail = client.get_recipe(recipe_id)
    code_raw, config_raw = detail.get("code"), detail.get("config")
    code, config = safe_parse_json(code_raw), safe_parse_json(config_raw)
    print(f"code   : {type(code_raw).__name__} -> {type(code).__name__}")
    print(f"config : {type(config_raw).__name__} -> {type(config).__name__}")
    if not isinstance(code, dict):
        sys.exit("STOP: code did not parse to a dict. Inspect detail['code'] raw shape.")
    print("PASS: the second parse at the boundary yields a real code tree.")


# Stage 3 — folder_assets + handle layer (1 call) ---------------------------
def stage3_folder_assets(client, folder_id):
    _hr("3  folder_assets + handle parse  (1 call)")
    try:
        assets = client.folder_assets(folder_id)
    except WorkatoHTTPError as e:
        sys.exit(f"STOP: folder_assets failed — {e}\n"
                 "If this endpoint is unavailable on your plan, the fallback is to\n"
                 "name recipes from /api/recipes directly and derive handles there.")
    if not assets:
        sys.exit("STOP: folder_assets returned empty. Check SDC_FOLDER_ID.")
    types = sorted({a.get("type") for a in assets})
    print("asset count :", len(assets))
    print("asset types :", types, " (recipe registry keeps only 'recipe')")
    print("first asset keys:", sorted(assets[0].keys()))
    print("handle parse (first 5 recipes):")
    for a in [x for x in assets if x.get("type") == "recipe"][:5]:
        print(f"   {a.get('name')!r:45} -> {derive_handle(a)!r}")
    print("LOOK: do those handles match your <DOM>-NN convention? If not, adjust\n"
          "      registries.derive_handle (it may need to read zip_name instead).")
    return build_recipe_registry(assets)


# Stage 4 — data tables + schema GET (2 calls, records host) ----------------
def stage4_tables(client):
    _hr("4  data tables + schema GET  (2 calls; schema is on the records host)")
    tables = client.list_data_tables()
    if not tables:
        print("note: no data tables returned — skipping schema check.")
        return
    print("table count :", len(tables))
    print("first table :", {k: tables[0].get(k) for k in ("id", "name")})
    tid = tables[0].get("id")
    try:
        schema = client.get_table_schema(tid)
    except WorkatoHTTPError as e:
        sys.exit(f"STOP: schema GET failed on the records host — {e}\n"
                 "Confirm records_host (stage 0) is reachable and the path is /api/v1/tables/:id.")
    cols = schema.get("schema") or []
    print(f"schema for {tid}: {len(cols)} columns")
    if cols:
        print("first column keys:", sorted(cols[0].keys()), " (need 'field_id' + 'name')")
    print("PASS: records host reachable and column shape understood." if cols
          else "LOOK: schema had no columns — verify the response shape.")


# Stage 5 — the inspectors (the flag-settlers; N+1 calls for the folder) -----
def stage5_inspectors(client, folder_id):
    _hr("5  inspectors over the real corpus  (N+1 calls; 429s self-heal)")
    recipes = client.get_structured_recipes(folder_id=folder_id, include_code=True)
    print(f"fetched {len(recipes)} recipes with code.")

    usage = inspect_connector_usage(recipes)
    keywords = inspect_recipe_keywords(recipes)
    providers = sorted({p for (p, _n) in usage})
    print("\nproviders seen :", providers)
    print("keywords seen  :", dict(sorted(keywords.items())))

    print("\nConfirm against extract.py:")
    print("  PY_PROVIDERS — which of py_eval / workato_python / python appears?")
    print("  call encoding — is there a 'call' keyword, or workato_recipe_function/call_recipe?")
    for p in providers:
        if "db_table" in p or p == "data_tables":
            keys = {a: dict(c) for a, c in inspect_provider_input_keys(recipes, p).items()}
            print(f"  {p} input keys (confirms TABLE_KEYS + the writes_column record key):")
            for action, kc in keys.items():
                print(f"     {action}: {kc}")
    return recipes


def main():
    folder_id = os.environ.get("SDC_FOLDER_ID")
    if not folder_id:
        sys.exit("STOP: set SDC_FOLDER_ID to the folder you want to test against.")

    client = stage0_config()
    recipe_id = stage1_auth(client)
    stage2_parse_boundary(client, recipe_id)
    stage3_folder_assets(client, folder_id)
    stage4_tables(client)
    stage5_inspectors(client, folder_id)

    _hr("done")
    print("All gates passed. Reconcile any LOOK notes above into extract.py /")
    print("registries.derive_handle, then run the real STS-01 oracle (see guide).")


if __name__ == "__main__":
    main()
