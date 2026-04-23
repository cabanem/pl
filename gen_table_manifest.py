#!/usr/bin/env python3
"""
SDC Data Model — JSON Schema Generator
======================================

Consumes Workato data-table JSON exports and emits JSON Schema 2020-12
documents that re-state the data model in a machine-validatable form.

One schema file per project (two projects: Base, Data collection).
Each table lives under $defs/<TableName>. Relations use $ref where
single-pass resolvable; name-based and cross-project joins are
annotated (x-soft-join, x-deferred-relation) rather than ref'd.

Re-run whenever the source tables change.
"""

import json
from pathlib import Path
from collections import OrderedDict

# ----------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------

UPLOADS_DIR = Path("/mnt/user-data/uploads")
OUT_DIR = Path("/mnt/user-data/outputs/sdc-data-model")

BASE_ID = "https://sdc.local/schemas/base.json"
APP_ID = "https://sdc.local/schemas/data-collection.json"

# Workato system fields common to every table. Emitted once and $ref'd.
SYSTEM_FIELD_IDS = {
    "11fbe9a6-a16d-4d7e-86ea-afe42ec03005": "record_id",
    "a5612739-5401-4ae7-bd07-782c1a6fb2d1": "created_time",
    "61aae604-a95e-4519-9091-bb0bf754a67f": "last_modified_time",
}

# Workato native types → JSON Schema
TYPE_MAP = {
    "short-text": {"type": "string"},
    "long-text": {"type": "string", "x-workato-type": "long-text"},
    "date-time": {"type": "string", "format": "date-time"},
    "boolean": {"type": "boolean"},
    "integer": {"type": "integer"},
    "file": {"type": "string", "x-workato-type": "file",
             "description": "Workato FileStorage reference"},
    "relation": {"type": "string", "x-workato-type": "relation"},
}

# ----------------------------------------------------------------------
# Project classification
# ----------------------------------------------------------------------
# Rule from Emily: files prefixed "home_" or "main_" → base project;
# everything else → data-collection (application) project.

def project_of(filename: str) -> str:
    name = filename.lower()
    if name.startswith("home_") or name.startswith("main_"):
        return "base"
    return "data_collection"

# ----------------------------------------------------------------------
# Name normalization
# ----------------------------------------------------------------------
# Source `name` values are mostly snake/Pascal hybrids like
# "HOME_WorkspaceRegistry" — except "HOME - Manifests" (legacy typo).
# We normalize $def keys for schema hygiene while preserving the raw
# source name in x-workato-table-name so it round-trips.

NAME_OVERRIDES = {
    "HOME - Manifests": "HOME_Manifests",
}

def normalize_name(source_name: str) -> str:
    if source_name in NAME_OVERRIDES:
        return NAME_OVERRIDES[source_name]
    return source_name

# ----------------------------------------------------------------------
# Curated FK / enum / constraint overlay
# ----------------------------------------------------------------------
# Rather than regex-parsing hint text, we curate the cross-references
# explicitly. Keyed by (table_name, field_title). Keeps the generator
# deterministic and makes the data model auditable at a glance.

# target_ref values use table names; the generator resolves them to the
# correct $ref (same-file vs cross-file) based on project membership.

FK_OVERLAY = {
    # ── Base project ────────────────────────────────────────────────
    ("HOME_Requests", "manifest_id"):       {"target": "HOME_Manifests", "field": "manifest_id"},
    ("HOME_Requests", "workspace_id"):      {"target": "HOME_WorkspaceRegistry", "field": "workspace_id"},

    ("MAIN_ProvisioningResults", "correlation_id"): {"target": "HOME_Requests", "field": "correlation_id"},

    # ── Data collection: WFA layer ──────────────────────────────────
    ("WFA_TemplateProject", "correlation_id"): {"target": "HOME_Requests", "field": "correlation_id", "deferred": True},

    ("WFA_SupplierRequest", "template_project_id"): {"target": "WFA_TemplateProject", "field": "template_project_id"},
    ("WFA_SupplierRequest", "assigned_version_id"): {"target": "VER_TemplateVersion", "field": "template_version_id"},
    ("WFA_SupplierRequest", "assigned_variant_id"): {"target": "CFG_Variant", "field": "variant_id"},
    ("WFA_SupplierRequest", "correlation_id"):      {"target": "HOME_Requests", "field": "correlation_id", "deferred": True},
    ("WFA_SupplierRequest", "current_validation_result_id"): {
        "target": "RUN_ValidationResult",
        "field": "validation_result_id",
        "note": "SOURCE ANOMALY: Workato schema has this relation wired to RUN_FieldError.field_id. "
                "Named target RUN_ValidationResult is almost certainly correct. Flag for repair.",
    },

    ("WFA_SupplierUser", "supplier_request_id"): {"target": "WFA_SupplierRequest", "field": "supplier_request_id"},

    # ── Versioning ──────────────────────────────────────────────────
    ("VER_TemplateVersion", "template_project_id"): {"target": "WFA_TemplateProject", "field": "template_project_id"},
    ("VER_TemplateVersion", "manifest_id"):         {"target": "HOME_Manifests", "field": "manifest_id", "deferred": True},

    # ── CFG layer (all version-scoped) ──────────────────────────────
    ("CFG_Field", "template_version_id"): {"target": "VER_TemplateVersion", "field": "template_version_id"},
    ("CFG_Field", "depends_on"):          {"target": "CFG_Field", "field": "field_id", "self": True},
    ("CFG_Field", "lookup_name"):         {"target": "CFG_Lookup", "field": "lookup_name", "soft_join": True},

    ("CFG_Variant", "template_version_id"): {"target": "VER_TemplateVersion", "field": "template_version_id"},

    ("CFG_VariantField", "variant_id"): {"target": "CFG_Variant", "field": "variant_id"},
    ("CFG_VariantField", "field_id"):   {"target": "CFG_Field", "field": "field_id"},

    ("CFG_Lookup", "template_version_id"): {"target": "VER_TemplateVersion", "field": "template_version_id"},

    ("CFG_Rule", "template_version_id"):  {"target": "VER_TemplateVersion", "field": "template_version_id"},
    ("CFG_Rule", "field_id"):             {"target": "CFG_Field", "field": "field_id"},
    ("CFG_Rule", "condition_field_id"):   {"target": "CFG_Field", "field": "field_id"},

    ("CFG_FormSlot", "template_version_id"): {"target": "VER_TemplateVersion", "field": "template_version_id"},
    ("CFG_FormSlot", "field_id"):            {"target": "CFG_Field", "field": "field_id"},
    ("CFG_FormSlot", "slot_name"):           {"target": "WFA_SupplierRequest", "field": "slot_name",
                                              "soft_join": True,
                                              "note": "Maps logical slot_name to a fixed slot column on WFA_SupplierRequest (e.g. slot_text_01)."},
    ("CFG_FormSlot", "lookup_name"):         {"target": "CFG_Lookup", "field": "lookup_name", "soft_join": True},

    ("CFG_ErrorTranslation", "template_version_id"): {"target": "VER_TemplateVersion", "field": "template_version_id"},

    # ── RUN layer ───────────────────────────────────────────────────
    ("RUN_Upload", "supplier_request_id"):  {"target": "WFA_SupplierRequest", "field": "supplier_request_id"},
    ("RUN_Upload", "template_version_id"):  {"target": "VER_TemplateVersion", "field": "template_version_id"},

    ("RUN_ValidationResult", "upload_id"):           {"target": "RUN_Upload", "field": "upload_id"},
    ("RUN_ValidationResult", "template_version_id"): {"target": "VER_TemplateVersion", "field": "template_version_id"},

    ("RUN_FieldError", "validation_result_id"): {"target": "RUN_ValidationResult", "field": "validation_result_id"},
    ("RUN_FieldError", "field_id"):             {"target": "CFG_Field", "field": "field_id"},

    ("RUN_ManualEntry", "field_id"): {"target": "CFG_Field", "field": "field_id"},
    # supplier_request_id on RUN_ManualEntry is a Workato explicit relation; handled via relation block.

    ("RUN_PipelineError", "supplier_request_id"):  {"target": "WFA_SupplierRequest", "field": "supplier_request_id"},
    ("RUN_PipelineError", "template_project_id"):  {"target": "WFA_TemplateProject", "field": "template_project_id"},
    ("RUN_PipelineError", "correlation_id"):       {"target": "HOME_Requests", "field": "correlation_id", "deferred": True},
}

# Enumerations extracted from hints. Curated to avoid accidental
# overfitting to hint prose.
ENUM_OVERLAY = {
    ("HOME_Requests", "status"):              ["PENDING", "PROVISIONING", "ACTIVE", "FAILED", "CLOSED"],
    ("HOME_WorkspaceRegistry", "status"):     ["AVAILABLE", "UNAVAILABLE"],
    ("WFA_TemplateProject", "project_completion_status"): ["active", "inactive"],
    ("WFA_SupplierRequest", "status"):        ["pending", "sent", "in_progress", "submitted", "validated", "accepted", "rejected"],
    ("WFA_SupplierUser", "status"):           ["active", "deactivated"],
    ("VER_TemplateVersion", "status"):        ["draft", "published", "deprecated"],
    ("CFG_Field", "data_type"):               ["string", "integer", "date", "decimal", "boolean"],
    ("CFG_FormSlot", "control_type"):         ["text", "number", "dropdown", "date", "checkbox"],
    ("RUN_Upload", "status"):                 ["received", "extracting", "validating", "validated", "failed"],
    ("RUN_ValidationResult", "status"):       ["running", "passed", "failed", "error"],
}

# Fields whose hints mark them Immutable / Write-once. Annotated
# rather than enforced (JSON Schema has no "immutable" keyword).
def derive_lifecycle_flags(hint: str) -> dict:
    flags = {}
    if not hint:
        return flags
    low = hint.lower()
    if "immutable" in low:
        flags["x-immutable"] = True
    if "write-once" in low or "write once" in low:
        flags["x-write-once"] = True
    return flags

# Slot fields: annotate semantic type even though storage is string.
SLOT_SEMANTIC_TYPE = {
    "slot_text_": "string",
    "slot_num_":  "number",
    "slot_bool_": "boolean",
    "slot_sel_":  "string",   # dropdown value
    "slot_date_": "string",   # ISO date string
}

def slot_semantic(field_title: str) -> str | None:
    if field_title.endswith("_label"):
        return None  # labels are genuinely strings
    for prefix, semantic in SLOT_SEMANTIC_TYPE.items():
        if field_title.startswith(prefix):
            return semantic
    return None

# ----------------------------------------------------------------------
# Ref resolution
# ----------------------------------------------------------------------

def resolve_ref(target_table: str, table_to_project: dict, current_project: str) -> str:
    """Return a $ref pointing at the target table's $def."""
    target_project = table_to_project[target_table]
    if target_project == current_project:
        return f"#/$defs/{target_table}"
    # Cross-project
    target_id = BASE_ID if target_project == "base" else APP_ID
    return f"{target_id}#/$defs/{target_table}"

# ----------------------------------------------------------------------
# Field → JSON Schema property
# ----------------------------------------------------------------------

def build_property(table_name: str, field: dict, table_to_project: dict, current_project: str) -> dict:
    title = field["title"]
    wtype = field["type"]
    hint = field.get("hint", "")
    field_uuid = field["id"]

    # Start from the type map
    prop = OrderedDict()
    base = TYPE_MAP.get(wtype, {"type": "string", "x-workato-type": wtype})
    prop.update(base)

    # Description from hint
    if hint:
        prop["description"] = hint

    # FK overlay → reference instead of raw string
    fk = FK_OVERLAY.get((table_name, title))
    if fk:
        target = fk["target"]
        target_field = fk["field"]
        ref = resolve_ref(target, table_to_project, current_project)
        fk_meta = OrderedDict()
        fk_meta["$ref"] = ref
        fk_meta["target_field"] = target_field
        if fk.get("self"):
            fk_meta["self_reference"] = True
        if fk.get("soft_join"):
            fk_meta["soft_join"] = True
            fk_meta["rationale"] = "Name-based join, not UUID-based. Resolved at runtime by shared value."
        if fk.get("deferred"):
            fk_meta["deferred_relation"] = True
            fk_meta["rationale"] = "Cross-project reference. Resolved in two-pass provisioning."
        if fk.get("note"):
            fk_meta["note"] = fk["note"]
        prop["x-fk"] = fk_meta

    # Native Workato relation block (explicit relation type)
    rel = field.get("relation")
    if rel:
        rel_target = rel.get("table_id", {}).get("name")
        prop["x-workato-relation"] = OrderedDict([
            ("target_table", rel_target),
            ("target_field_id", rel.get("field_id")),
        ])
        # If FK_OVERLAY hasn't already added a $ref and we know the target, add one
        if "x-fk" not in prop and rel_target and rel_target in table_to_project:
            ref = resolve_ref(rel_target, table_to_project, current_project)
            prop["x-fk"] = OrderedDict([("$ref", ref), ("via", "workato-relation")])

    # Enum overlay
    enum = ENUM_OVERLAY.get((table_name, title))
    if enum:
        prop["enum"] = list(enum)

    # Slot-field semantic hint
    semantic = slot_semantic(title)
    if semantic:
        prop["x-semantic-type"] = semantic
        prop["x-slot-note"] = (
            "Stored as short-text for WFA widget compatibility; "
            "semantic type enforced downstream in validation."
        )

    # Default
    if "default_value" in field and field["default_value"] is not None:
        prop["default"] = field["default_value"]

    # Provenance / Workato-specific metadata
    prop["x-workato-field-id"] = field_uuid
    if wtype not in ("short-text",):
        prop.setdefault("x-workato-type", wtype)
    if field.get("read_only"):
        prop["x-workato-readonly"] = True
    if field.get("hidden"):
        prop["x-workato-hidden"] = True

    # Lifecycle flags from hint prose
    prop.update(derive_lifecycle_flags(hint))

    return prop

# ----------------------------------------------------------------------
# Table → JSON Schema $def
# ----------------------------------------------------------------------

def build_table_schema(source: dict, table_to_project: dict, current_project: str) -> dict:
    raw_name = source["name"]
    table_name = normalize_name(raw_name)
    schema = OrderedDict()
    schema["type"] = "object"
    schema["title"] = table_name
    schema["x-workato-table-name"] = raw_name
    if raw_name != table_name:
        schema["x-name-normalized-from"] = raw_name
    schema["x-workato-project"] = source.get("project_name", "")
    tags = source.get("tags") or []
    if tags:
        schema["x-workato-tags"] = list(tags)

    properties = OrderedDict()
    required = []
    workato_system = []

    for field in source["schema"]:
        field_id = field["id"]
        title = field["title"]

        # Collect system fields under their natural titles
        if field_id in SYSTEM_FIELD_IDS:
            workato_system.append(title)
            # Still emit the property so the schema is self-contained
            properties[title] = build_property(table_name, field, table_to_project, current_project)
            continue

        prop = build_property(table_name, field, table_to_project, current_project)
        properties[title] = prop

        if field.get("required"):
            required.append(title)

    schema["properties"] = properties
    if required:
        schema["required"] = required
    if workato_system:
        schema["x-workato-system-fields"] = workato_system

    schema["additionalProperties"] = False
    return schema

# ----------------------------------------------------------------------
# Build top-level project documents
# ----------------------------------------------------------------------

def build_project_document(project_id: str, project_title: str, defs: dict) -> dict:
    doc = OrderedDict()
    doc["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    doc["$id"] = project_id
    doc["title"] = project_title
    doc["description"] = (
        f"SDC platform — {project_title}. "
        "Auto-generated from Workato data-table exports. "
        "One $def per table. Cross-project refs resolve via $id."
    )
    doc["type"] = "object"
    doc["properties"] = OrderedDict()  # intentionally empty; this is a container
    doc["x-generated"] = True
    doc["$defs"] = OrderedDict(sorted(defs.items()))
    return doc

# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------

def main():
    # 1. Load all source files
    sources = []
    for p in sorted(UPLOADS_DIR.glob("*_workato_db_table.json")):
        with p.open() as f:
            data = json.load(f)
        sources.append((p.name, data))

    # 2. Build project membership map (normalized table name → project)
    table_to_project = {}
    for filename, data in sources:
        table_to_project[normalize_name(data["name"])] = project_of(filename)

    # 3. Build $defs per project (keyed by normalized name)
    base_defs = {}
    app_defs = {}
    for filename, data in sources:
        project = project_of(filename)
        defn = build_table_schema(data, table_to_project, project)
        target = base_defs if project == "base" else app_defs
        target[normalize_name(data["name"])] = defn

    # 4. Emit project documents
    base_doc = build_project_document(BASE_ID, "SDC Base Project", base_defs)
    app_doc = build_project_document(APP_ID, "SDC Data Collection Project", app_defs)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with (OUT_DIR / "sdc-base.schema.json").open("w") as f:
        json.dump(base_doc, f, indent=2)
    with (OUT_DIR / "sdc-data-collection.schema.json").open("w") as f:
        json.dump(app_doc, f, indent=2)

    # Also copy the generator itself alongside the output for posterity
    import shutil
    shutil.copy(__file__, OUT_DIR / "generate_schemas.py")

    # 5. Summary
    print(f"Base project tables:            {len(base_defs)}")
    for n in sorted(base_defs): print(f"  - {n}")
    print(f"Data collection project tables: {len(app_defs)}")
    for n in sorted(app_defs): print(f"  - {n}")
    print(f"\nOutput: {OUT_DIR}")

if __name__ == "__main__":
    main()
