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

import re

import sdc_recipe_model as M
from normalize import NormStep, CONTROL_KEYWORDS

# --- candidate input keys ---------------------------------------------------
# CONFIRMED against the live STS-01 recipe code:
#   input.flow_id    -> call target (string; coerced to int for registry lookup)
#   input.table_id   -> data-table reference (value is the table's numeric_id)
#   input.parameters -> column->value map; keys are field UUIDs in datapill-safe
#                       (underscored) form, normalized to hyphens before resolving
FLOW_ID_KEYS = ("flow_id", "recipe_id")                    # flow_id confirmed; recipe_id kept as fallback
TABLE_KEYS = ("data_table_id", "table_id", "data_table")   # table_id matches; value = numeric_id
RECORD_KEYS = ("parameters",)                              # the column->value map on writes
RETURN_NAMES = ("return_result",)                          # recipe-function output (the return side of exposed_via)

# data-table provider, confirmed: workato_db_table.
DB_PROVIDERS = {"workato_db_table", "data_tables"}
# Python provider, confirmed from datapill provenance: py_eval.
PY_PROVIDERS = {"py_eval", "workato_python", "python"}
# Recipe-internal state: declare/mutate variables and lists. Intentionally
# edge-less — these cross no boundary. The values they hold are sourced from
# other steps' datapills and, where they later reach a table/call/return, that
# effect is already edged at its own boundary. Edging the variable too would be
# dataflow/taint tracking, which is a different model than effects-and-interfaces.
STATE_PROVIDERS = {"workato_variable"}

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


# Recipe `code` renders UUIDs in datapill-safe form (underscores); the data-tables
# API returns them hyphenated. Normalize an underscored-UUID-shaped key to hyphens;
# leave anything else (e.g. a column referenced by name) untouched.
_UUID_USCORE = re.compile(r"^[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$", re.I)


def _norm_field_id(key: str) -> str:
    return key.replace("_", "-") if _UUID_USCORE.match(str(key)) else key


def _as_flow_id(value) -> object:
    s = str(value)
    return int(s) if s.isdigit() else value


def _output_fields(s) -> list:
    """Field names a return_result step exposes. Prefer the step's own schema
    labels (distilled by normalize); else the keys of the output value map."""
    if s.field_labels:
        return sorted(set(s.field_labels.values()))
    payload = s.input.get("result") or s.input.get("parameters") or s.input
    return sorted(payload.keys()) if isinstance(payload, dict) else []


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

        if s.provider in STATE_PROVIDERS:
            continue                                        # recipe-internal state; effects edged at their boundaries

        # Call detection accepts BOTH representations until inspectRecipeKeywords
        # settles it: keyword 'call' (toolkit's labelStep_) or the
        # workato_recipe_function action names (the OpenAPI spec's shape).
        is_call = s.keyword == "call" or (
            s.provider == "workato_recipe_function" and s.name in ("call_recipe", "call_recipe_async")
        )
        if is_call:
            callee = _as_flow_id(_first(s.input, FLOW_ID_KEYS))
            mode = M.CallMode.async_ if (s.name or "").endswith("_async") else M.CallMode.sync
            params = list((s.input.get("parameters") or s.input.get("input") or {}).keys())
            edges.append(M.Edge(
                source_flow_id, anchor, M.Relation.calls,
                _keyed(M.TargetKind.recipe, callee),
                M.CallAttrs(mode=mode, params=params),
            ))
            continue

        # return_result — the recipe-function's OUTPUT contract; the return side of
        # exposed_via, paired with the trigger's input side.
        if s.provider == "workato_recipe_function" and s.name in RETURN_NAMES:
            edges.append(M.Edge(
                source_flow_id, anchor, M.Relation.exposed_via,
                M.Target(M.TargetKind.trigger, s.name, s.name, M.Resolution.not_applicable),
                M.ExposedAttrs(trigger_type=M.TriggerType.recipe_function, auth=M.Auth.none,
                               direction="out", fields=tuple(_output_fields(s))),
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
                    for col_key in record:
                        field_id = _norm_field_id(col_key)
                        edges.append(M.Edge(
                            source_flow_id, anchor, M.Relation.writes_column,
                            M.Target(M.TargetKind.column, (table, field_id), None, M.Resolution.unresolved),
                            M.ColumnAttrs(write_kind=col_kind, recipe_label=s.field_labels.get(field_id)),
                        ))
            continue

        # connector / wfa / files / pubsub / email / csv providers -> later relations; out of slice scope
    return edges
