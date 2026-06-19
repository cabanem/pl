"""sdc_recipe_model — canonical contract (Python realization).

Typed mirror of ``sdc_recipe_model.contract.yaml``. The extractor emits these
objects; every projection imports them. One definition, read everywhere.

Identity is two-tier:
  * durable keys (flow_id, table_id+field_id, step uuid) are authoritative —
    the things projections join on;
  * resolved labels (handle, column name, path) are denormalized conveniences,
    re-derived from registries, never authoritative.

Two orthogonal axes ride on edges/steps:
  * provenance  — how an edge is known to exist (derived | asserted);
  * resolution  — whether a keyed target was found in a registry.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Union


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------
class RecipeKind(str, Enum):
    api_endpoint = "api_endpoint"
    event_webhook = "event_webhook"
    data_table_trigger = "data_table_trigger"
    callable_recipe = "callable_recipe"
    workflow_app_function = "workflow_app_function"


class TriggerType(str, Enum):
    api_platform_http = "api_platform_http"
    workato_webhook = "workato_webhook"
    data_table_realtime = "data_table_realtime"
    recipe_function = "recipe_function"
    workflow_app_function = "workflow_app_function"


class WfaFunctionType(str, Enum):
    generic = "generic"
    load_table = "load_table"
    load_dropdown = "load_dropdown"


class Auth(str, Enum):
    api_token = "api_token"
    webhook_suffix = "webhook_suffix"
    none = "none"


class VarType(str, Enum):
    string = "string"
    integer = "integer"
    boolean = "boolean"
    date_time = "date_time"
    object = "object"
    array = "array"


class Relation(str, Enum):
    calls = "calls"
    accesses_table = "accesses_table"
    writes_column = "writes_column"
    invokes_connector = "invokes_connector"
    performs_wfa = "performs_wfa"
    touches_external = "touches_external"
    exposed_via = "exposed_via"


class Provenance(str, Enum):
    derived = "derived"      # statically read from recipe JSON
    asserted = "asserted"    # filled from analysis of an opaque interior


class Resolution(str, Enum):
    resolved = "resolved"
    unresolved = "unresolved"          # key not in registry scope; raw key retained
    not_applicable = "not_applicable"  # bare-label target; no registry


class AnalysisStatus(str, Enum):
    derived = "derived"      # full effect set statically visible
    opaque = "opaque"        # interior (py_eval) not yet analyzed


class TargetKind(str, Enum):
    recipe = "recipe"
    table = "table"
    column = "column"
    connector_action = "connector_action"
    wfa_task = "wfa_task"
    trigger = "trigger"
    external = "external"


class Access(str, Enum):
    read = "read"
    write = "write"


class WriteKind(str, Enum):
    update = "update"
    create = "create"
    create_batch = "create_batch"
    update_batch = "update_batch"
    truncate = "truncate"


class CallMode(str, Enum):
    sync = "sync"
    async_ = "async"


class WfaOp(str, Enum):
    read = "read"
    update = "update"
    create = "create"
    share = "share"
    return_ = "return"


class Surface(str, Enum):
    storage = "storage"
    drive = "drive"
    pubsub = "pubsub"
    template = "template"
    email = "email"
    csv = "csv"


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class StepAnchor:
    uuid: str                 # PRIMARY  — same-workspace, edit-stable, unambiguous
    path: str                 # SECONDARY — cross-workspace-portable, human-legible


@dataclass
class Target:
    kind: TargetKind
    durable_key: object       # flow_id:int | table_id:str | (table_id, field_id) | label:str
    resolved_label: Optional[str] = None
    resolution: Resolution = Resolution.not_applicable


# ---------------------------------------------------------------------------
# Per-relation attribute payloads (discriminated by relation / surface)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class CallAttrs:
    mode: CallMode
    params: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class TableAttrs:
    access: Access
    action: str
    write_kind: Optional[WriteKind] = None      # None when access == read


@dataclass(frozen=True)
class ColumnAttrs:
    write_kind: WriteKind
    recipe_label: Optional[str] = None     # the recipe author's logical name for this field


@dataclass(frozen=True)
class ConnectorAttrs:
    action: str


@dataclass(frozen=True)
class WfaAttrs:
    op: WfaOp
    addressing: str = "app_id+record_id"
    sets_fields: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ExposedAttrs:
    trigger_type: TriggerType
    auth: Auth
    direction: str = "in"          # "in" = trigger/input contract, "out" = return/output contract
    fields: tuple = ()             # field names captured for this side of the interface


# touches_external: a union of per-surface payloads. The attributes follow the
# tag (the class identity IS the discriminator) — deliberately not flattened.
@dataclass(frozen=True)
class StorageAttrs:
    surface: Surface = field(default=Surface.storage, init=False)
    operation: str = ""       # store_file | get_file_contents | ensure_dir_exists | create_shareable_link | ...
    path: Optional[str] = None       # location: file_path / directory_path, raw (often a datapill formula)
    name: Optional[str] = None       # leaf: file_name / directory_name, when supplied separately
    expires_in: Optional[str] = None  # create_shareable_link TTL in seconds (e.g. "604800" = 7d)


@dataclass(frozen=True)
class DriveAttrs:
    surface: Surface = field(default=Surface.drive, init=False)
    operation: str = "download_file_contents"
    drive_file_id: Optional[str] = None


@dataclass(frozen=True)
class PubsubAttrs:
    surface: Surface = field(default=Surface.pubsub, init=False)
    topic: Optional[str] = None
    in_catch: bool = False    # pubsub here is usually the failure-signalling channel inside <catch>


@dataclass(frozen=True)
class TemplateAttrs:
    surface: Surface = field(default=Surface.template, init=False)
    operation: str = "create_document"


@dataclass(frozen=True)
class EmailAttrs:
    surface: Surface = field(default=Surface.email, init=False)
    template_ref: Optional[str] = None
    recipient_role: Optional[str] = None


@dataclass(frozen=True)
class CsvAttrs:
    surface: Surface = field(default=Surface.csv, init=False)
    operation: str = "create_csv_lines"


ExternalAttrs = Union[
    StorageAttrs, DriveAttrs, PubsubAttrs, TemplateAttrs, EmailAttrs, CsvAttrs
]
EdgeAttrs = Union[
    CallAttrs, TableAttrs, ColumnAttrs, ConnectorAttrs, WfaAttrs, ExposedAttrs, ExternalAttrs
]


# ---------------------------------------------------------------------------
# Edge — the atom every projection reads
# ---------------------------------------------------------------------------
@dataclass
class Edge:
    source_recipe: int        # flow_id of the emitting recipe
    anchor: StepAnchor
    relation: Relation
    target: Target
    attrs: EdgeAttrs
    provenance: Provenance = Provenance.derived


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------
@dataclass
class Variable:
    name: str
    type: VarType


@dataclass
class Trigger:
    type: TriggerType
    auth: Auth
    wfa_function_type: Optional[WfaFunctionType] = None
    trigger_table: Optional[str] = None


@dataclass
class PyEvalBody:
    """Reserved slot. I/O boundary is DERIVED now; semantics ASSERTED later."""
    code: str
    inputs: list[str] = field(default_factory=list)
    outputs: list[Variable] = field(default_factory=list)
    analysis_status: AnalysisStatus = AnalysisStatus.opaque
    asserted_effects: list[Edge] = field(default_factory=list)


@dataclass
class Step:
    anchor: StepAnchor
    action_type: str
    frame: str = "none"       # none | if | else | elsif | try | catch | foreach
    python: Optional[PyEvalBody] = None


@dataclass
class Recipe:
    flow_id: int              # durable key
    handle: str               # resolved label
    kind: RecipeKind
    trigger: Trigger
    version: int
    source_file: str
    request_schema: Optional[str] = None
    response_schema: Optional[str] = None
    declares: list[Variable] = field(default_factory=list)
    collision: bool = False
    steps: list[Step] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Registries — fetched once per workspace snapshot; resolve opaque keys.
# Both share one shape: fetch a table, then join keys against it.
# ---------------------------------------------------------------------------
@dataclass
class RecipeRegistry:
    """flow_id -> {handle, name, type, source_file}.

    Source: GET /api/export_manifests/folder_assets?folder_id=<id>
    Powers BOTH node naming and call-edge resolution — one fetch, one table.
    """
    by_flow_id: dict[int, dict] = field(default_factory=dict)

    def resolve(self, flow_id: int) -> Target:
        hit = self.by_flow_id.get(flow_id)
        if hit is None:                                   # cross-project / out of scope
            return Target(TargetKind.recipe, flow_id, None, Resolution.unresolved)
        return Target(TargetKind.recipe, flow_id, hit["handle"], Resolution.resolved)


@dataclass
class TableSchemaRegistry:
    """table_id -> name; (table_id, field_id) -> {name, type}.

    Source: GET /api/data_tables  (the list carries each table's schema inline).
    """
    tables: dict[str, str] = field(default_factory=dict)            # table_id -> table_name
    columns: dict[tuple, dict] = field(default_factory=dict)        # (table_id, field_id) -> {name, type}

    def resolve_table(self, table_id: str) -> Target:
        name = self.tables.get(table_id)
        res = Resolution.resolved if name else Resolution.unresolved
        return Target(TargetKind.table, table_id, name, res)

    def resolve_column(self, table_id: str, field_id: str) -> Target:
        hit = self.columns.get((table_id, field_id))
        if hit is None:
            return Target(TargetKind.column, (table_id, field_id), None, Resolution.unresolved)
        return Target(TargetKind.column, (table_id, field_id), hit["name"], Resolution.resolved)


# ---------------------------------------------------------------------------
# A model is the recipe set plus the registries used to resolve it.
# ---------------------------------------------------------------------------
@dataclass
class RecipeModel:
    recipes: list[Recipe] = field(default_factory=list)
    recipe_registry: RecipeRegistry = field(default_factory=RecipeRegistry)
    table_registry: TableSchemaRegistry = field(default_factory=TableSchemaRegistry)

    def all_edges(self) -> list[Edge]:
        """Every edge, including asserted edges promoted from py_eval interiors."""
        out: list[Edge] = []
        for r in self.recipes:
            out.extend(r.edges)
            for s in r.steps:
                if s.python:
                    out.extend(s.python.asserted_effects)
        return out
