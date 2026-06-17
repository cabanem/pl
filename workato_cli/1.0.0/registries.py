"""registries — build the two resolution registries from fetched responses.

  recipe_registry        : folder_assets  -> flow_id -> {handle, name, source_file}
  table_schema_registry  : data_tables + per-table schema GET -> ids -> names

The <DOM>-NN handle parsing is the one layer the GAS toolkit does NOT do: it
carries raw `name` + `id`. Handle derivation sits on top, turning the resolved
label (name) into the handle the rest of the platform uses. The exact pattern
must be confirmed against real folder_assets output (see derive_handle).
"""
from __future__ import annotations

import re

import sdc_recipe_model as M

# Leading code token: STS-01, API-00, PRV-04, INV-01A, R-1, WFA-13, ...
# NOTE: no-number handles (INV-USER) and filename collision suffixes (a second
# WFA-13) may need a workspace-specific rule once real names are in hand.
HANDLE_RE = re.compile(r"^\s*([A-Z][A-Z0-9]*-[A-Z0-9]+)")


def derive_handle(asset: dict) -> str:
    """Parse a <DOM>-NN handle from the asset name; fall back to the raw name."""
    name = str(asset.get("name") or "")
    m = HANDLE_RE.match(name)
    return m.group(1) if m else name


def build_recipe_registry(assets: list, derive=derive_handle) -> M.RecipeRegistry:
    """folder_assets -> RecipeRegistry. Filters to type=='recipe' (drops
    connections/pages/lookups) and flags handles that collide across recipes."""
    by_flow_id: dict[int, dict] = {}
    handle_counts: dict[str, int] = {}

    for a in assets:
        if a.get("type") != "recipe":
            continue
        fid = a.get("id")
        handle = derive(a)
        handle_counts[handle] = handle_counts.get(handle, 0) + 1
        by_flow_id[fid] = {
            "handle": handle,
            "name": a.get("name"),
            "type": a.get("type"),
            "source_file": a.get("zip_name"),
            "collision": False,
        }

    for entry in by_flow_id.values():
        if handle_counts.get(entry["handle"], 0) > 1:
            entry["collision"] = True

    return M.RecipeRegistry(by_flow_id=by_flow_id)


def build_table_schema_registry(table_list: list, schemas_by_table_id: dict) -> M.TableSchemaRegistry:
    """data_tables list (id->name) plus per-table schema GETs ((id,field_id)->name).

    Table names come cheaply from the one paged /api/data_tables sweep
    (replicateTableDiscovery). Column names require the per-table schema GET, so
    pass only the schemas for tables that actually need column resolution."""
    tables: dict[str, str] = {}
    for t in table_list:
        if t and t.get("id"):
            tables[t["id"]] = t.get("name") or "(unnamed)"

    columns: dict[tuple, dict] = {}
    for tid, schema in schemas_by_table_id.items():
        for col in (schema.get("schema") or []):
            fid = col.get("field_id")
            if fid:
                columns[(tid, fid)] = {"name": col.get("name"), "type": col.get("type")}
        # schema GET also carries the table name; backfill if the list missed it
        if schema.get("name") and tid not in tables:
            tables[tid] = schema["name"]

    return M.TableSchemaRegistry(tables=tables, columns=columns)


def fetch_needed_schemas(client, table_ids) -> dict:
    """On-demand: fetch schemas only for tables that need column resolution
    (the write targets), not every table in the workspace."""
    return {tid: client.get_table_schema(tid) for tid in table_ids}
