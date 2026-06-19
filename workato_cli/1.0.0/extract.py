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
# The three return surfaces — each is the OUTPUT side of exposed_via for one way a
# recipe is invoked. Keyed (provider, action) -> the exposure surface it returns to.
RETURN_SURFACE = {
    ("workato_recipe_function", "return_result"): "recipe_function",
    ("workato_workflow_task", "app_function_return"): "workflow_app_function",
    ("workato_api_platform", "return_response"): "api_platform_http",
}

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
# Pure data-shaping transforms (rows<->CSV, JSON parse). Like py_eval: recipe-internal
# compute, no boundary crossed. Edge-less.
TRANSFORM_PROVIDERS = {"csv_parser", "json_parser"}
FILES_PROVIDER = "workato_files"
WFA_PROVIDER = "workato_workflow_task"
# A custom-connector provider carries a "_connector_<id>..." instance suffix
# (e.g. functional_core_for_sdc..._connector_500787859_1778246042). Built-in
# providers never do. Strip the suffix for an environment-independent identity.
_CONNECTOR_RE = re.compile(r"_+connector_\d.*$")
FILE_LOC_KEYS = ("file_path", "directory_path", "path")    # the location (parent dir / full path)
FILE_NAME_KEYS = ("file_name", "directory_name")           # the leaf, when given separately

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


def _leaf_paths(obj, prefix: str = "") -> set:
    """Dotted leaf paths of a nested dict (the actual shape of a returned value)."""
    out: set = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{prefix}{k}"
            if isinstance(v, dict):
                out |= _leaf_paths(v, p + ".")
            else:
                out.add(p)
    return out


def _output_fields(s) -> list:
    """Field name-paths a return-style step exposes. The schema gives declared
    names (field_labels KEYS are the names; values are display labels, which can
    differ — e.g. http_status_code vs 'Response'). Union in the body actually
    mapped under result/response, so a body not re-declared in the schema (the
    api_platform case) is still captured."""
    out = set(s.field_labels.keys())
    for key in ("result", "response"):
        body = s.input.get(key)
        if isinstance(body, dict):
            out |= _leaf_paths(body)
    return sorted(out)


# touches_external surface builders: each returns (target_key, attrs) for a step.
# The target_key is the surface's identity (path / file id / topic / template id /
# recipient) — frequently a raw datapill formula, kept verbatim.
def _ext_files(s):
    loc = _first(s.input, FILE_LOC_KEYS)
    return loc, M.StorageAttrs(operation=s.name or "", path=loc,
                               name=_first(s.input, FILE_NAME_KEYS),
                               expires_in=s.input.get("expires_in"))


def _ext_drive(s):
    fid = s.input.get("fileId") or s.input.get("file_id")
    return fid, M.DriveAttrs(operation=s.name or "download_file_contents", drive_file_id=fid)


def _ext_pubsub(s):
    topic = s.input.get("topic_id") or s.input.get("topic")
    return topic, M.PubsubAttrs(topic=topic, in_catch=(s.frame == "catch"))


def _ext_template(s):
    tid = s.input.get("template_id")
    return tid, M.TemplateAttrs(operation=s.name or "create_document", template_id=tid)


def _ext_email(s):
    to = s.input.get("to")
    return to, M.EmailAttrs(to=to, subject=s.input.get("subject"))


EXTERNAL_SURFACES = {
    FILES_PROVIDER: _ext_files,
    "google_drive": _ext_drive,
    "workato_pub_sub": _ext_pubsub,
    "workato_template": _ext_template,
    "email": _ext_email,
}


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

        if s.provider in TRANSFORM_PROVIDERS:
            continue                                        # pure data-shaping (csv/json); no boundary crossed

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

        # return_result / app_function_return / return_response — the OUTPUT side of
        # exposed_via, one branch per exposure surface. Paired with the trigger's input side.
        surface = RETURN_SURFACE.get((s.provider, s.name))
        if surface is not None:
            edges.append(M.Edge(
                source_flow_id, anchor, M.Relation.exposed_via,
                M.Target(M.TargetKind.trigger, s.name, s.name, M.Resolution.not_applicable),
                M.ExposedAttrs(trigger_type=M.TriggerType(surface), auth=M.Auth.none,
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

        # touches_external — boundary effects to non-table surfaces (FileStorage, Drive,
        # pub/sub, template render, email). One edge per step, target keyed on the
        # surface's identity, surface-specific attrs via dispatch. Read/write is
        # derivable from the operation, so it isn't stored separately.
        ext = EXTERNAL_SURFACES.get(s.provider)
        if ext is not None:
            key, attrs = ext(s)
            edges.append(M.Edge(
                source_flow_id, anchor, M.Relation.touches_external,
                M.Target(M.TargetKind.external, key, key, M.Resolution.not_applicable),
                attrs,
            ))
            continue

        # performs_wfa — Workflow App request/task ops against the single WFA app (app_id).
        # Triggers (app_function_*_request) are caught above by the trigger branch;
        # app_function_return is caught above as exposed_via(out). What remains here are
        # the request/task operations. The parameters keys are the backing table's column
        # field_ids — bridging WFA writes to columns is left to a projection over sets_fields.
        if s.provider == WFA_PROVIDER:
            params = s.input.get("parameters")
            sets_fields = tuple(_norm_field_id(k) for k in params) if isinstance(params, dict) else ()
            app_id = s.input.get("app_id")
            group = s.input.get("user_group_ids")
            if app_id and s.input.get("record_id") is not None:
                addressing = "app_id+record_id"
            elif app_id:
                addressing = "app_id"
            elif group:
                addressing = "user_group"
            else:
                addressing = ""
            key = app_id or group
            edges.append(M.Edge(
                source_flow_id, anchor, M.Relation.performs_wfa,
                M.Target(M.TargetKind.wfa_task, key, key, M.Resolution.not_applicable),
                M.WfaAttrs(operation=s.name or "", addressing=addressing,
                           sets_fields=sets_fields,
                           workflow_stage_id=s.input.get("workflow_stage_id")),
            ))
            continue

        # invokes_connector — a call into a CUSTOM connector (your functional_core, etc.),
        # a separately-versioned artifact the recipe depends on. Built-in transforms
        # (csv/json) are edge-less; a custom connector is a tracked dependency. Target
        # is the env-independent connector::action; args are the supplied argument keys.
        if s.provider and _CONNECTOR_RE.search(s.provider):
            connector = _CONNECTOR_RE.sub("", s.provider)
            edges.append(M.Edge(
                source_flow_id, anchor, M.Relation.invokes_connector,
                M.Target(M.TargetKind.connector_action, (connector, s.name),
                         f"{connector}::{s.name}", M.Resolution.not_applicable),
                M.ConnectorAttrs(connector=connector, action=s.name or "",
                                 args=tuple(s.input.keys())),
            ))
            continue

        # custom connectors -> invokes_connector (next)
    return edges
