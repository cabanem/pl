"""fetch_selftest — offline proof of stage 1.

Network is not required (and not used). A fake transport serves responses shaped
per the GAS toolkit + Developer API docs, and the whole stage runs against them:

  config/host derivation -> list+detail+pagination -> safe_parse_json boundary
  -> folder_assets -> recipe_registry (+ handle parse, connection filter, collision)
  -> data_tables + schema GET -> table_schema_registry
  -> inspectors over the fetched corpus (the flag-settling instruments)
  -> fetched STS-01 through normalize -> extract -> resolve -> oracle diff

What this proves: the wiring, host split, pagination, parse boundary, registry
build, handle layer, inspectors, and spine integration are correct. What it does
NOT prove: that the LIVE API shapes match these canned ones — that needs a real
token, at which point the inspectors settle the three open vocabulary flags.
"""
from __future__ import annotations

import json
import re

import sdc_recipe_model as M
from workato_client import WorkatoClient, WorkatoConfig, safe_parse_json
from registries import build_recipe_registry, build_table_schema_registry, fetch_needed_schemas
from inspect_corpus import (
    inspect_connector_usage, inspect_recipe_keywords, inspect_provider_input_keys,
)
from normalize import normalize
from extract import extract
from slice_run import resolve, call_graph, table_access_matrix, status_writers

FOLDER_ID = 111
STS01_FLOW_ID = 84

ORACLE = {
    "reads": {"SUP_SupplierRequest", "RUN_ValidationResult", "Project", "RUN_ReviewNote"},
    "writes": {"SUP_SupplierRequest"},
    "status_columns": {"current_state_entered_at", "status", "supplier_display_status", "supplier_message"},
}


# --- canned workspace ------------------------------------------------------
def _trivial_code(uuid):
    return {"number": 0, "keyword": "trigger", "provider": "workato_recipe_function",
            "name": "execute", "uuid": uuid, "block": []}


def _load_sts01_code():
    with open("fixtures/sts_01.recipe.fixture.json") as f:
        code = json.load(f)
    code.pop("_fixture_note", None)
    return code


def make_fake_transport():
    sts01_code = _load_sts01_code()

    recipes_list = [
        {"id": 84, "name": "STS-01 Status-change handler", "folder_id": FOLDER_ID,
         "running": True, "updated_at": "2026-06-01T00:00:00Z", "action_applications": ["workato_db_table"]},
        {"id": 4, "name": "UTL-01 Generate shareable link", "folder_id": FOLDER_ID,
         "running": True, "updated_at": "2026-05-01T00:00:00Z", "action_applications": []},
        {"id": 16, "name": "OBS-01 Event emitter", "folder_id": FOLDER_ID,
         "running": True, "updated_at": "2026-05-15T00:00:00Z", "action_applications": []},
    ]
    details = {
        84: {"id": 84, "code": json.dumps(sts01_code), "config": [{"name": "supplier_request_id"}]},  # code as STRING
        4:  {"id": 4, "code": json.dumps(_trivial_code("t-4")), "config": "[]"},                       # config as STRING
        16: {"id": 16, "code": json.dumps(_trivial_code("t-16")), "config": None},
    }
    folder_assets = {"result": {"assets": [
        {"id": 84, "name": "STS-01 — Status-change handler", "type": "recipe", "zip_name": "sts_01_status_change_handler_recipe.json"},
        {"id": 4,  "name": "UTL-01 — Generate shareable link", "type": "recipe", "zip_name": "utl_01_generate_shareable_link_recipe.json"},
        {"id": 16, "name": "OBS-01 — Event emitter", "type": "recipe", "zip_name": "obs_01_event_emitter_recipe.json"},
        {"id": 900, "name": "SDC Connection", "type": "connection", "zip_name": "sdc_connection.json"},  # must be filtered out
    ]}}
    data_tables = {"data": [
        {"id": "tbl-supreq", "name": "SUP_SupplierRequest"},
        {"id": "tbl-valres", "name": "RUN_ValidationResult"},
        {"id": "tbl-project", "name": "Project"},
        {"id": "tbl-revnote", "name": "RUN_ReviewNote"},
    ]}
    schemas = {
        "tbl-supreq": {"data": {"id": "tbl-supreq", "name": "SUP_SupplierRequest", "schema": [
            {"field_id": "84d52734-0000-0000-0000-000000000000", "name": "status", "type": "string"},
            {"field_id": "col-disp-0001", "name": "supplier_display_status", "type": "string"},
            {"field_id": "col-msg-0002", "name": "supplier_message", "type": "string"},
            {"field_id": "col-entered-0003", "name": "current_state_entered_at", "type": "date_time"},
        ]}},
    }

    def transport(method, url, headers, body):
        # auth must be stamped on every call
        assert headers.get("Authorization", "").startswith("Bearer "), "missing bearer auth"
        if "/api/export_manifests/folder_assets" in url:
            return 200, json.dumps(folder_assets)
        m = re.search(r"/api/recipes/(\d+)(?:\?|$)", url)
        if m:
            return 200, json.dumps(details[int(m.group(1))])
        if "/api/recipes" in url:
            return 200, json.dumps({"items": recipes_list})
        if "/api/data_tables" in url:
            return 200, json.dumps(data_tables)
        m = re.search(r"/api/v1/tables/([^/?]+)$", url)
        if m:
            return 200, json.dumps(schemas.get(m.group(1), {"data": {"schema": []}}))
        return 404, json.dumps({"error": "no route", "url": url})

    return transport


# --- checks ----------------------------------------------------------------
def check_host_derivation():
    cfg = WorkatoConfig.from_env({"WORKATO_API_TOKEN": "x", "WORKATO_BASE_URL": "https://app.eu.workato.com/"})
    assert cfg.base_url == "https://app.eu.workato.com"
    assert cfg.records_host == "https://data-tables.eu.workato.com", cfg.records_host
    over = WorkatoConfig.from_env({"WORKATO_API_TOKEN": "x", "WORKATO_RECORDS_URL": "https://dt.example.com/"})
    assert over.records_host == "https://dt.example.com"
    print("[ok] host derivation: app. -> data-tables., explicit override honored")


def check_collision_detection():
    reg = build_recipe_registry([
        {"id": 1, "name": "WFA-13 populate roster", "type": "recipe", "zip_name": "wfa_13_a.json"},
        {"id": 2, "name": "WFA-13 reconcile roster", "type": "recipe", "zip_name": "wfa_13_b.json"},
        {"id": 3, "name": "API-00 provision", "type": "recipe", "zip_name": "api_00.json"},
    ])
    assert reg.by_flow_id[1]["collision"] and reg.by_flow_id[2]["collision"]
    assert not reg.by_flow_id[3]["collision"]
    print("[ok] handle collision: duplicate WFA-13 flagged, unique API-00 not")


def main():
    check_host_derivation()
    check_collision_detection()

    client = WorkatoClient(
        config=WorkatoConfig.from_env({"WORKATO_API_TOKEN": "fake-token"}),
        transport=make_fake_transport(),
        sleep=lambda _s: None,
    )

    # -- fetch: list + detail + parse boundary -----------------------------
    recipes = client.get_structured_recipes(folder_id=FOLDER_ID, include_code=True)
    assert len(recipes) == 3, len(recipes)
    sts01 = next(r for r in recipes if r["id"] == STS01_FLOW_ID)
    assert isinstance(sts01["code"], dict), "code did not parse from its JSON string"
    assert sts01["config"] == [{"name": "supplier_request_id"}]                 # list passthrough
    assert next(r for r in recipes if r["id"] == 4)["config"] == []             # parsed from "[]"
    print(f"[ok] fetch: {len(recipes)} recipes, STS-01 code parsed, config boundary handled")

    # -- recipe_registry from fetched folder_assets ------------------------
    rreg = build_recipe_registry(client.folder_assets(FOLDER_ID))
    assert set(rreg.by_flow_id) == {84, 4, 16}, "connection asset not filtered"
    assert rreg.by_flow_id[84]["handle"] == "STS-01"
    assert rreg.resolve(4).resolved_label == "UTL-01"
    print("[ok] recipe_registry: handles parsed, connection filtered, calls resolvable")

    # -- spine on the FETCHED STS-01 ---------------------------------------
    steps = normalize(sts01["code"])
    edges = extract(steps, STS01_FLOW_ID)

    # table_schema_registry: names from the list, columns only for write targets
    write_tables = {
        e.target.durable_key[0] if e.relation == M.Relation.writes_column else e.target.durable_key
        for e in edges
        if e.relation in (M.Relation.writes_column, M.Relation.accesses_table)
        and getattr(e.attrs, "access", None) == M.Access.write
    }
    write_tables = {t for t in write_tables if t}
    treg = build_table_schema_registry(
        client.list_data_tables(),
        fetch_needed_schemas(client, write_tables),
    )
    assert write_tables == {"tbl-supreq"}, write_tables
    resolve(edges, rreg, treg)

    # -- inspectors over the fetched corpus (the flag-settlers) ------------
    usage = inspect_connector_usage(recipes)
    keywords = inspect_recipe_keywords(recipes)
    providers = sorted({p for (p, _n) in usage})
    print("\n--- inspectors (what would settle the open flags) ---")
    print("providers seen   :", providers)
    print("keywords seen    :", dict(sorted(keywords.items())))
    db_provider = next((p for p in providers if "db_table" in p or p == "data_tables"), None)
    if db_provider:
        print(f"{db_provider} input keys:",
              {a: dict(c) for a, c in inspect_provider_input_keys(recipes, db_provider).items()})
    print("note: against a real corpus this is the readout that confirms py_eval vs")
    print("      workato_python, the call-step encoding, and the writes_column key.")

    # -- oracle diff on the fetched-and-resolved edges ---------------------
    tam = table_access_matrix(edges)
    got = {
        "reads": set(tam.get("read", [])),
        "writes": set(tam.get("write", [])),
        "status_columns": set(status_writers(edges)),
    }
    print("\n--- oracle diff (fetched path) ---")
    for key, expected in ORACLE.items():
        ok = got[key] == expected
        print(f"[{'ok' if ok else 'MISMATCH'}] {key}"
              + ("" if ok else f"  missing={expected - got[key]} extra={got[key] - expected}"))
        assert ok, f"oracle diff failed for {key}"

    print("\nstage 1 green: fetched STS-01 flows through the spine and reproduces the oracle.")


if __name__ == "__main__":
    main()
