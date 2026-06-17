"""extract — stage 3: normalized step list -> Edge objects (targets keyed,
resolution pending).

Pure, per-recipe, parallelizable. Control-frame steps emit nothing. py_eval
steps emit no semantic edge yet (their body is captured for later assertion).
Targets are emitted with their DURABLE KEY and resolution=unresolved; the
resolve stage attaches labels.

Where a target id lives inside `input` is read via candidate-key lists,
mirroring the FLOW_ID_KEYS approach in the GAS analyzer. These key sets are the
thing to finalize from the GAS at stage 1 — they are isolated here on purpose.
"""
from __future__ import annotations

import sdc_recipe_model as M
from normalize import NormStep, CONTROL_KEYWORDS

# --- candidate input keys ---------------------------------------------------
# CONFIRMED from the GAS toolkit:
#   recipe_id           -> labelStep_ reads node.input.recipe_id for calls
#   data_table_id/...   -> DATA_TABLES_PROFILE.tableIdKeys, first match wins
FLOW_ID_KEYS = ("recipe_id",)                              # toolkit-confirmed call target key
TABLE_KEYS = ("data_table_id", "table_id", "data_table")   # ported from tableIdKeys
# UNCONFIRMED: the toolkit never cracks the record map (extractDataTableOps stops
# at input_keys), so the column-write key stays a guess until inspectProviderSamples.
RECORD_KEYS = ("record", "fields", "data")                 # column->value map; keys are column UUIDs

# data-table provider: workato_db_table per spec + FRIENDLY_PROVIDERS.
# (The GAS extractor profile has 'workato_dB_table' — a latent typo that matches nothing.)
DB_PROVIDERS = {"workato_db_table", "data_tables"}
# Python provider is contested: spec says py_eval, FRIENDLY_PROVIDERS says workato_python/python.
# Accept all three until inspectConnectorUsage() settles it.
PY_PROVIDERS = {"py_eval", "workato_python", "python"}

# Read/write action vocab ported from DATA_TABLES_PROFILE.
READ_NAMES = {"search_records", "lookup_record", "list_records", "get_record", "get_records"}
WRITE_KIND_BY_NAME = {
    "add_record": M.WriteKind.create,
    "create_record": M.WriteKind.create,
    "upsert_record": M.WriteKind.create,
    "batch_create_records": M.WriteKind.create_batch,
    "create_records_batch": M.WriteKind.create_batch,
    "update_record": M.WriteKind.update,
    "update_records_batch": M.WriteKind.update_batch,
    "batch_update_records": M.WriteKind.update_batch,
    "delete_record": M.WriteKind.update,
    "batch_delete_records": M.WriteKind.update_batch,
    "truncate_table": M.WriteKind.truncate,
}


def _first(input_: dict, keys) -> object:
    for k in keys:
        if k in input_ and input_[k] not in (None, ""):
            return input_[k]
    return None


def _keyed(kind: M.TargetKind, key) -> M.Target:
    return M.Target(kind, key, None, M.Resolution.unresolved)


def extract(steps: list[NormStep], source_flow_id: int) -> list[M.Edge]:
    edges: list[M.Edge] = []

    for s in steps:
        anchor = M.StepAnchor(uuid=s.uuid, path=s.path)

        if s.keyword == "trigger":
            edges.append(M.Edge(
                source_flow_id, anchor, M.Relation.exposed_via,
                M.Target(M.TargetKind.trigger, s.name, s.name, M.Resolution.not_applicable),
                M.ExposedAttrs(trigger_type=M.TriggerType.recipe_function, auth=M.Auth.none),
            ))
            continue

        if s.keyword in CONTROL_KEYWORDS:
            continue                                        # frame, not an effect

        if s.provider in PY_PROVIDERS:
            continue                                        # body captured at the step layer; no semantic edge yet

        # Call detection accepts BOTH representations until inspectRecipeKeywords
        # settles it: keyword 'call' (toolkit's labelStep_) or the
        # workato_recipe_function action names (the OpenAPI spec's shape).
        is_call = s.keyword == "call" or (
            s.provider == "workato_recipe_function" and s.name in ("call_recipe", "call_recipe_async")
        )
        if is_call:
            callee = _first(s.input, FLOW_ID_KEYS)
            mode = M.CallMode.async_ if (s.name or "").endswith("_async") else M.CallMode.sync
            params = list((s.input.get("input") or {}).keys())
            edges.append(M.Edge(
                source_flow_id, anchor, M.Relation.calls,
                _keyed(M.TargetKind.recipe, callee),
                M.CallAttrs(mode=mode, params=params),
            ))
            continue

        if s.provider in DB_PROVIDERS:
            table = _first(s.input, TABLE_KEYS)
            if s.name in READ_NAMES:
                edges.append(M.Edge(
                    source_flow_id, anchor, M.Relation.accesses_table,
                    _keyed(M.TargetKind.table, table),
                    M.TableAttrs(access=M.Access.read, action=s.name),
                ))
            elif s.name in WRITE_KIND_BY_NAME:
                wk = WRITE_KIND_BY_NAME[s.name]
                edges.append(M.Edge(
                    source_flow_id, anchor, M.Relation.accesses_table,
                    _keyed(M.TargetKind.table, table),
                    M.TableAttrs(access=M.Access.write, action=s.name, write_kind=wk),
                ))
                # column writes — only when the per-column mapping is statically visible.
                # A batch payload that is a single list pill (no column map) stays an
                # opaque step rather than a false edge.
                record = _first(s.input, RECORD_KEYS)
                if isinstance(record, dict):
                    col_kind = M.WriteKind.create if wk in (M.WriteKind.create, M.WriteKind.create_batch) else M.WriteKind.update
                    for col_uuid in record:
                        edges.append(M.Edge(
                            source_flow_id, anchor, M.Relation.writes_column,
                            M.Target(M.TargetKind.column, (table, col_uuid), None, M.Resolution.unresolved),
                            M.ColumnAttrs(write_kind=col_kind),
                        ))
            continue

        # connector / wfa / files / pubsub / email / csv providers -> later relations; out of slice scope
    return edges
