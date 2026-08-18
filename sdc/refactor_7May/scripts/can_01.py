import json
import uuid
from datetime import datetime, timezone

# --- Slot pool layout --------------------------------------------------
"""
Allocation policy (form-channel viability):
    Fields are assigned to the first available slot whose 
    type family matches, in template order. When a family is oversubscribed, must-fit fields (required + 
    cascade dependencies) are allocated first; 
    - OPTIONAL fields that do not fit are dropped from the form (recorded in fields_without_slots / dropped_optional)
    - REQUIRED fields that no longer fit raise (becoming per-family deficits)
"""

DEFAULT_CAPACITIES = {"text": 10, "num": 4, "bool": 2, "sel": 10, "date": 4}

def build_slot_pool(capacities):
    return {fam: ["slot_%s_%02d" % (fam, n) for n in range(1, count + 1)]
            for fam, count in capacities.items()}

"""
Canonical control vocabulary (canonical model shape spec, cfg_fields):
    text | number | dropdown | dependent_select | date | checkbox | email | currency
"""
CONTROL_TYPE_TO_SLOT_TYPE = {
    "text":             "text",
    "email":            "text",
    "currency":         "text",
    "number":           "num",
    "checkbox":         "bool",
    "dropdown":         "sel",
    "dependent_select": "sel",
    "date":             "date",
}

DEPENDS_ON_KEYS = ("depends_on", "depends_on_lookup_name", "depends_on_field_name")


# --- HELPERS ----------------------------------------------------------------------------------
def _depends_on_value(parsed_field):
    """The lookup name this field cascades from, or None."""
    for key in DEPENDS_ON_KEYS:
        value = parsed_field.get(key)
        if value:
            return str(value).strip() or None
    return None

def _resolve_control_type(parsed_field):
    """Derive the form control type for a parsed field.

    The master config does not carry control_type — it is a canonical-model concept, derived here from what the analyst did author.

    Lookup presence dominates: 
        A field backed by a lookup renders as a select regardless of its underlying data type. 
        A lookup plus a depends-on value is a cascade child. Everything else falls back to data_type/data_format.

    Returns exactly one member of the canonical vocabulary, so a missing entry in CONTROL_TYPE_TO_SLOT_TYPE is a code defect rather than a data condition.

    NOTE: the data_type / data_format value lists below must match the vocabulary your parser actually emits. Verify against the distinct values
    in CFG_Field before trusting this on a new config.
    """
    lookup_name = (parsed_field.get("lookup_name") or "").strip()
    if lookup_name:
        return "dependent_select" if _depends_on_value(parsed_field) else "dropdown"

    data_type = (parsed_field.get("data_type") or "").strip().lower()
    data_format = (parsed_field.get("data_format") or "").strip().lower()

    if data_type in ("date", "datetime", "timestamp"):
        return "date"
    if data_type in ("boolean", "bool"):
        return "checkbox"
    if data_type in ("integer", "int", "decimal", "number", "float"):
        return "currency" if data_format in ("currency", "money") else "number"
    if data_format in ("email", "e-mail"):
        return "email"
    if data_format in ("currency", "money"):
        return "currency"
    return "text"

def _field_name(field_by_id, field_id):
    """Field name for error messages; falls back to the id if unknown."""
    record = field_by_id.get(field_id)
    return record["field_name"] if record else field_id


# --- PHASE 1  - cfg_fields --------------------------------------------------------------------
def build_fields(parsed_fields):
    """Mint a field_id per field and derive control_type.

    `position` is the field's index in parsed_fields, which mirrors row order in the master config's `4_fields` sheet 
    (blank rows already skipped by the parser). No input key is read for position: the field's place in the list IS
    its position. Intentional — position is form display order, and the analyst's spreadsheet row order is the authoritative source.

    Returns (cfg_fields, field_name_to_id, lookup_name_to_using_field_ids). The last map is keyed by lookup_name with a LIST of 
    consuming field_ids, so the self check can detect the ambiguous-parent case.
    """
    cfg_fields = []
    field_name_to_id = {}
    lookup_name_to_using_field_ids = {}

    for position, source in enumerate(parsed_fields):
        field_id = str(uuid.uuid4())
        field_name = source.get("field_name")
        field_name_to_id[field_name] = field_id

        lookup_name = source.get("lookup_name")
        if lookup_name:
            lookup_name_to_using_field_ids.setdefault(lookup_name, []).append(field_id)

        cfg_fields.append({
            "field_id":                 field_id,
            "field_name":               field_name,
            "description":              source.get("description"),
            "data_type":                source.get("data_type"),
            "data_format":              source.get("data_format"),
            "position":                 position,
            "required":                 bool(source.get("required", False)),
            "read_only":                bool(source.get("read_only", False)),
            "column_unique":            bool(source.get("column_unique", False)),
            "strict":                   bool(source.get("strict", False)),
            "visible":                  bool(source.get("visible", True)),
            "hidden":                   bool(source.get("supplier_hidden", False)),
            "field_length_validation":  source.get("field_length_validation"),
            "numeric_field_validation": source.get("numeric_field_validation"),
            "date_field_validation":    source.get("date_field_validation"),
            "field_input_validation":   source.get("field_input_validation"),
            "data_cleaning_flags":      source.get("data_cleaning_flags"),
            "lookup_name":              lookup_name,
            # Captured here from the raw config; resolved to a field_id in 1b.
            "depends_on_lookup_name":   _depends_on_value(source),
            "cascade_parent_field_id":  None,
            # Prefer an explicit value if the parser ever emits one, else derive.
            "control_type":             source.get("control_type") or _resolve_control_type(source),
        })

    return cfg_fields, field_name_to_id, lookup_name_to_using_field_ids


# --- PHASE 1b - cascade parents ---------------------------------------------------------------
def resolve_cascade_parents(cfg_fields, lookup_name_to_using_field_ids):
    """Resolve each field's depends_on lookup to its gating field_id.

    A dependent dropdown's `depends_on` value (sheet `4_fields`, column 11) names a LOOKUP, not a field. The gating field — the one whose value filters
    this field's options — is the field whose `lookup_name` matches it.

    Real example (MARS):
        Job Title:  lookup_name=job_title, depends_on=job_class
        Job Class:  lookup_name=job_class, depends_on=country_iso
    Selecting a Job Class filters Job Title to lookup rows in `job_title` whose parent_value matches the selection.

    Resolution is one hop; chains form by following multiple hops. Runs as a second pass because a gating field may appear later in the sheet than the
    field depending on it.

    If the lookup has multiple consuming fields the first is recorded; the self check's ambiguous-parent rule raises if that ambiguity would matter. If it
    has none, cascade_parent_field_id stays None and the self check reports it with full context.
    """
    for record in cfg_fields:
        lookup_name = record["depends_on_lookup_name"]
        if not lookup_name:
            continue
        candidates = lookup_name_to_using_field_ids.get(lookup_name, [])
        if candidates:
            record["cascade_parent_field_id"] = candidates[0]


# --- PHASE 1c - must-fit set (form-channel viability) -----------------------------------------
def build_must_fit(cfg_fields, field_by_id):
    """Required visible fields plus their visible cascade ancestors, walked to root.

    A required dependent cannot render unless its whole gating chain holds slots, so the
    chain joins the must-fit set. Cycle-guarded locally: this runs before the phase-7 self
    check, whose 3d raise owns the good error message -- the guard here only prevents an
    infinite walk, it does not report.

    Returns (must_fit_ids, defects). Defects here are dependency defects only: a required
    chain that traverses an invisible field is unmappable by construction, regardless of
    capacity.
    """
    must_fit = set()
    defects = []
    for field in cfg_fields:
        if not (field["required"] and field["visible"]):
            continue
        current = field["field_id"]
        seen = set()
        while current and current not in seen:
            seen.add(current)
            record = field_by_id.get(current)
            if record is None:
                break
            if not record["visible"]:
                defects.append({
                    "type":              "dependency_parent_not_visible",
                    "field_name":        field["field_name"],
                    "parent_field_name": record["field_name"],
                })
                break
            must_fit.add(current)
            current = record["cascade_parent_field_id"]
    return must_fit, defects


# --- PHASE 2  - cfg_lookups -------------------------------------------------------------------
def build_lookups(parsed_lookups):
    """Name-keyed pass-through.

    Naming bridge: the parser emits the row value under the plural key `valid_values` (one cell 
    from the sheet's "Value" column; plural for legacy reasons). The canonical model uses singular 
    `valid_value`, matching the data table column and reflecting that each row holds exactly one value. 
    Same pattern as `_index` -> `position` and `depends_on_field_name` -> `depends_on_lookup_name`.
    """
    return [{
        "lookup_id":        str(uuid.uuid4()),
        "lookup_name":      lookup.get("lookup_name"),
        "valid_value":      lookup.get("valid_values") or lookup.get("valid_value"),
        "display_label":    lookup.get("display_label"),
        "parent_value":     lookup.get("parent_value"),
        "project_specific": bool(lookup.get("project_specific", False)),
    } for lookup in parsed_lookups]


# --- PHASE 3  - cfg_rules ---------------------------------------------------------------------
def build_rules(parsed_rules, field_name_to_id):
    """Resolve target_field_name and condition_field_name to field ids."""
    cfg_rules = []

    for rule in parsed_rules:
        target_name = rule.get("target_field_name") or rule.get("target_field")
        condition_name = rule.get("condition_field_name") or rule.get("condition_field")

        target_id = field_name_to_id.get(target_name) if target_name else None
        if target_name and target_id is None:
            raise ValueError(
                f"Rule references target_field_name '{target_name}' "
                f"but no field with that name exists."
            )

        condition_id = field_name_to_id.get(condition_name) if condition_name else None
        if condition_name and condition_id is None:
            raise ValueError(
                f"Rule references condition_field_name '{condition_name}' "
                f"but no field with that name exists."
            )

        cfg_rules.append({
            "rule_id":              str(uuid.uuid4()),
            "field_id":             target_id,
            "rule":                 rule.get("rule"),
            "condition_field_id":   condition_id,
            "conditional_value":    rule.get("conditional_value"),
            "error_message":        rule.get("error_message"),
            "error_message_custom": rule.get("error_message_custom"),
            "strict_enforcement":   bool(rule.get("strict_enforcement", False)),
            "scope":                rule.get("scope") or "submission",
            "target_field_name":    target_name,
            "condition_field_name": condition_name,
        })

    return cfg_rules


# --- PHASE 4  - cfg_variants + cfg_variant_fields ---------------------------------------------
def build_variants(parsed_variants, field_name_to_id):
    """Mint variant ids and flatten the parser's nested visible_field_names."""
    cfg_variants = []
    cfg_variant_fields = []

    for variant in parsed_variants:
        variant_id = str(uuid.uuid4())
        variant_name = variant.get("variant_name")

        cfg_variants.append({
            "variant_id":     variant_id,
            "variant_name":   variant_name,
            "description":    variant.get("description"),
            "is_synthesized": bool(variant.get("is_synthesized", False)),
        })

        for field_name in variant.get("visible_field_names", []):
            field_id = field_name_to_id.get(field_name)
            if field_id is None:
                raise ValueError(
                    f"Variant '{variant_name}' references field '{field_name}' "
                    f"but no field with that name exists."
                )
            cfg_variant_fields.append({
                "variant_field_id": str(uuid.uuid4()),
                "variant_id":       variant_id,
                "field_id":         field_id,
            })

    return cfg_variants, cfg_variant_fields


# --- PHASE 5  - cfg_form_slot_mappings --------------------------------------------------------
def assign_form_slots(cfg_fields, slot_pool, must_fit):
    """Allocate typed slot columns to visible fields, in template order.

    Two-phase, assignment-preserving:

    Phase A decides WHO gets a slot, per family. When a family's visible demand fits its
    capacity, allocation order is plain template order -- byte-identical to the historical
    allocator for every config that fully fits (which is every config provisioned before
    viability shipped, since the old allocator raised on overflow). Only when a family is
    oversubscribed does priority activate: must-fit fields (required + cascade ancestors)
    allocate first, then optional fields, both halves in template order. Must-fit overflow
    becomes a per-family deficit; optional overflow is dropped and recorded.

    Phase B emits the mappings in global template order, so `position` remains the visible
    display order regardless of how priority reordered allocation. A required field rescued
    from position 15 still displays at position 15.

    Slot-pool position mirrors template position on the fast path (canonical model shape
    spec); under oversubscription, must-fit fields claim earlier pool slots by design.

    Returns (cfg_form_slot_mappings, slot_pool_cursor, fields_without_slots, deficits).
    """
    slot_pool_cursor = {slot_type: 0 for slot_type in slot_pool}
    fields_without_slots = []  # visible fields that didn't fit; includes a `required` flag
    deficits = {}              # slot_type -> count of must-fit fields beyond capacity

    visible_fields = sorted(
        (f for f in cfg_fields if f["visible"]),
        key=lambda f: (f["position"], f["field_name"]),
    )

    # ---- Phase A: group by family, allocate within each family -------------------------
    fields_by_family = {}
    for field in visible_fields:
        control_type = field["control_type"]
        slot_type = CONTROL_TYPE_TO_SLOT_TYPE.get(control_type)

        # Derivation returns only vocabulary members, so a miss here means
        # _resolve_control_type and CONTROL_TYPE_TO_SLOT_TYPE have drifted
        # apart — a code defect, not a data condition.
        if slot_type is None:
            raise ValueError(
                f"Field '{field['field_name']}' has control_type "
                f"'{control_type}', which has no slot-pool mapping. "
                f"_resolve_control_type and CONTROL_TYPE_TO_SLOT_TYPE have "
                f"drifted apart."
            )
        fields_by_family.setdefault(slot_type, []).append(field)

    slot_by_field_id = {}
    for slot_type, family_fields in fields_by_family.items():
        pool = slot_pool[slot_type]

        if len(family_fields) <= len(pool):
            ordered = family_fields  # fast path: historical order, verbatim
        else:
            must = [f for f in family_fields if f["field_id"] in must_fit]
            rest = [f for f in family_fields if f["field_id"] not in must_fit]
            ordered = must + rest    # both halves keep template order
            if len(must) > len(pool):
                deficits[slot_type] = len(must) - len(pool)

        for field in ordered:
            cursor = slot_pool_cursor[slot_type]
            if cursor >= len(pool):
                fields_without_slots.append({
                    "field_name":   field["field_name"],
                    "control_type": field["control_type"],
                    "required":     field["required"],
                    "reason":       f"{slot_type} slot pool exhausted "
                                    f"({len(pool)} slots available)",
                })
                continue
            slot_pool_cursor[slot_type] = cursor + 1
            slot_by_field_id[field["field_id"]] = pool[cursor]

    # ---- Phase B: emit mappings in global template order -------------------------------
    cfg_form_slot_mappings = []
    form_position = 0
    for field in visible_fields:
        slot_name = slot_by_field_id.get(field["field_id"])
        if slot_name is None:
            continue
        cfg_form_slot_mappings.append({
            "form_slot_id":       str(uuid.uuid4()),
            "field_id":           field["field_id"],
            "slot_name":          slot_name,
            "display_label":      field["field_name"],
            "description":        field["description"],
            "control_type":       field["control_type"],
            "required":           field["required"],
            "supplier_readonly":  field["read_only"],
            "lookup_name":        field["lookup_name"],  # required for dropdown/dependent_select
            "position":           form_position,
            # Populated by resolve_slot_cascades once every slot is assigned.
            "depends_on_field_id":  None,
            "depends_on_slot_name": None,
        })
        form_position += 1

    return cfg_form_slot_mappings, slot_pool_cursor, fields_without_slots, deficits


# --- PHASE 5b - cascade parents as slot names -------------------------------------------------
def resolve_slot_cascades(cfg_form_slot_mappings, field_by_id, must_fit):
    """Record each dependent slot's gating SLOT, not just its gating field.

    Without this, populating a dependent dropdown at runtime costs a two-hop join: slot -> CFG_Field 
    -> cascade_parent_field_id -> back to the slot map. Resolved once here instead.

    Runs as a second pass because a gating field may be allocated after the field that depends on it.

    A dependent whose parent holds no slot cannot render its cascade. This is no longer a
    raise; it resolves by requiredness (form-channel viability):
      - dependent in the must-fit set  -> dependency defect (form_channel 'unavailable');
        the mapping is kept, defected, so diagnostics can show what the form would need.
      - dependent optional             -> the dependent's own mapping is dropped too
        (form_channel 'degraded'), recorded in cascade_dropped with the reason.
    Optional drops iterate to a fixpoint so a dropped parent cascades the drop to its own
    optional dependents (grandchildren) rather than leaving them pointing at a removed slot.
    Cycles cannot loop this: cyclic chains among allocated fields all resolve slots, and the
    phase-7 self check (3d) still owns the cycle raise.

    Returns (surviving_mappings, cascade_defects, cascade_dropped).
    """
    doomed = set()            # form_slot_ids of optional dependents dropped here
    handled_defects = set()   # form_slot_ids already defected (must-fit, unrenderable)
    cascade_defects = []
    cascade_dropped = []

    resolved = False
    while not resolved:
        resolved = True
        field_id_to_slot = {
            m["field_id"]: m["slot_name"]
            for m in cfg_form_slot_mappings if m["form_slot_id"] not in doomed
        }
        for mapping in cfg_form_slot_mappings:
            if mapping["form_slot_id"] in doomed or mapping["form_slot_id"] in handled_defects:
                continue
            parent_field_id = field_by_id[mapping["field_id"]]["cascade_parent_field_id"]
            mapping["depends_on_field_id"] = parent_field_id
            if not parent_field_id:
                continue

            parent_slot = field_id_to_slot.get(parent_field_id)
            if parent_slot is not None:
                mapping["depends_on_slot_name"] = parent_slot
                continue

            if mapping["field_id"] in must_fit:
                cascade_defects.append({
                    "type":              "dependency_parent_unmappable",
                    "field_name":        _field_name(field_by_id, mapping["field_id"]),
                    "parent_field_name": _field_name(field_by_id, parent_field_id),
                })
                mapping["depends_on_slot_name"] = None
                handled_defects.add(mapping["form_slot_id"])
            else:
                cascade_dropped.append({
                    "field_name":   _field_name(field_by_id, mapping["field_id"]),
                    "control_type": mapping["control_type"],
                    "required":     False,
                    "reason":       (f"cascade parent "
                                     f"'{_field_name(field_by_id, parent_field_id)}' "
                                     f"holds no form slot"),
                })
                doomed.add(mapping["form_slot_id"])
                resolved = False

    surviving = [m for m in cfg_form_slot_mappings if m["form_slot_id"] not in doomed]
    return surviving, cascade_defects, cascade_dropped


# --- PHASE 6  - cfg_error_messages ------------------------------------------------------------
def build_error_messages(parsed_error_translations):
    """Mint ids; otherwise pass-through from the parser."""
    return [{
        "error_translation_id":   str(uuid.uuid4()),
        "error_code":             entry.get("error_code"),
        "human_readable_message": entry.get("human_readable_message"),
        "required_placeholders":  entry.get("required_placeholders"),
    } for entry in parsed_error_translations]


# --- PHASE 6b - form_channel viability verdict ------------------------------------------------
def build_form_channel(cfg_fields, must_fit, capacities, slot_pool_cursor,
                       fields_without_slots, cascade_dropped, deficits, defects):
    """Assemble the form_channel block: status + per-family breakdown + drop/defect detail.

    Status semantics:
      unavailable -- a required field (or its gating chain) cannot be represented on the
                     form: capacity deficit on the must-fit set, or a dependency defect.
      degraded    -- everything required fits, but one or more OPTIONAL fields were dropped
                     (pool exhausted, or cascade parent unmappable). Upload path unaffected.
      viable      -- every visible field holds a slot.

    Detail payload contract (serialized as form_channel_detail_json; consumed by the
    GAS library's FormChannel module -- keep the two in sync):
      status            -- same vocabulary as above.
      capacities_used   -- the slot capacities this allocation ran against.
      per_type          -- {family: {capacity, required, closure_added, optional,
                           allocated, deficit}}. closure_added counts cascade ancestors
                           pulled into the must-fit set beyond the required fields
                           themselves; deficit counts must-fit fields beyond capacity.
      required_unplaced -- [{field_name, control_type, required: true, reason}]. The
                           REQUIRED fields that hold no slot -- the fields that made the
                           status 'unavailable'. Named explicitly so the caller can say
                           which fields to fix, not just how many.
      dropped_optional  -- [{field_name, control_type, required: false, reason}].
                           Optional fields dropped from the form (pool exhausted, or
                           cascade parent unmappable).
      defects           -- [{type, field_name, parent_field_name}] with type one of
                           dependency_parent_not_visible | dependency_parent_unmappable.
    """
    per_type = {}
    for family, capacity in capacities.items():
        family_fields = [
            f for f in cfg_fields
            if f["visible"] and CONTROL_TYPE_TO_SLOT_TYPE.get(f["control_type"]) == family
        ]
        required_count = sum(1 for f in family_fields if f["required"])
        must_count = sum(1 for f in family_fields if f["field_id"] in must_fit)
        per_type[family] = {
            "capacity":      capacity,
            "required":      required_count,
            "closure_added": must_count - required_count,
            "optional":      len(family_fields) - must_count,
            "allocated":     slot_pool_cursor.get(family, 0),
            "deficit":       deficits.get(family, 0),
        }

    dropped_optional = (
        [f for f in fields_without_slots if not f.get("required")] + cascade_dropped
    )
    required_unplaced = [f for f in fields_without_slots if f.get("required")]

    if defects or deficits or required_unplaced:
        status = "unavailable"
    elif dropped_optional:
        status = "degraded"
    else:
        status = "viable"

    return status, {
        "status":            status,
        "capacities_used":   capacities,
        "per_type":          per_type,
        "required_unplaced": required_unplaced,
        "dropped_optional":  dropped_optional,
        "defects":           defects,
    }


# --- PHASE 7  - self check --------------------------------------------------------------------
def check_foreign_keys(cfg_rules, cfg_variant_fields, cfg_form_slot_mappings,
                       field_by_id, variant_ids):
    """Invariant 1 — every id reference resolves."""
    for rule in cfg_rules:
        if rule["field_id"] and rule["field_id"] not in field_by_id:
            raise ValueError(
                f"Rule {rule['rule_id']} field_id unresolved: {rule['field_id']}"
            )
        if rule["condition_field_id"] and rule["condition_field_id"] not in field_by_id:
            raise ValueError(
                f"Rule {rule['rule_id']} condition_field_id unresolved: "
                f"{rule['condition_field_id']}"
            )

    for variant_field in cfg_variant_fields:
        if variant_field["variant_id"] not in variant_ids:
            raise ValueError(
                f"Variant_field references missing variant: "
                f"{variant_field['variant_id']}"
            )
        if variant_field["field_id"] not in field_by_id:
            raise ValueError(
                f"Variant_field references missing field: "
                f"{variant_field['field_id']}"
            )

    for mapping in cfg_form_slot_mappings:
        if mapping["field_id"] not in field_by_id:
            raise ValueError(
                f"Form_slot_mapping {mapping['form_slot_id']} field_id "
                f"unresolved: {mapping['field_id']}"
            )

    # Defensive: cascade parents are only ever populated from the map of known
    # field ids, so this should not fire. Kept for symmetry with the checks
    # above — if it ever does fire, something upstream is very wrong.
    for field in field_by_id.values():
        parent_id = field["cascade_parent_field_id"]
        if parent_id and parent_id not in field_by_id:
            raise ValueError(
                f"Field {field['field_id']} cascade_parent_field_id "
                f"unresolved: {parent_id}"
            )

def check_lookup_references(cfg_fields, cfg_form_slot_mappings, lookup_names):
    """Invariant 2 — every lookup_name reference resolves."""
    for field in cfg_fields:
        if field["lookup_name"] and field["lookup_name"] not in lookup_names:
            raise ValueError(
                f"Field {field['field_name']} references lookup_name "
                f"'{field['lookup_name']}' but no lookup with that name exists."
            )

    for mapping in cfg_form_slot_mappings:
        if mapping["lookup_name"] and mapping["lookup_name"] not in lookup_names:
            raise ValueError(
                f"Form_slot_mapping {mapping['form_slot_id']} references "
                f"lookup_name '{mapping['lookup_name']}' but no lookup with "
                f"that name exists."
            )

def check_cascade_graph(cfg_fields, field_by_id, lookup_names,
                        lookup_name_to_using_field_ids):
    """Invariant 3 — cascade validity, four checks with distinct messages so
    the config author can fix the right thing."""

    # 3a: every depends_on names a lookup that exists.
    for field in cfg_fields:
        lookup_name = field["depends_on_lookup_name"]
        if lookup_name and lookup_name not in lookup_names:
            raise ValueError(
                f"Field '{field['field_name']}' depends_on '{lookup_name}' but "
                f"no lookup with that name exists in cfg_lookups. Either add "
                f"the lookup to sheet 5_lookups (Table name = '{lookup_name}') "
                f"or correct the 'Depends on' value in sheet 4_fields for this "
                f"field."
            )

    # 3b: every depends_on lookup has a consuming field to cascade from.
    for field in cfg_fields:
        lookup_name = field["depends_on_lookup_name"]
        if lookup_name and not lookup_name_to_using_field_ids.get(lookup_name):
            raise ValueError(
                f"Field '{field['field_name']}' depends_on lookup "
                f"'{lookup_name}', but no field uses '{lookup_name}' as its "
                f"'Lookup name' (sheet 4_fields, column 'Lookup name'). The "
                f"cascade has no gating field. Either add a field that uses "
                f"'{lookup_name}' as its lookup, or change this field's "
                f"'Depends on' to a lookup that does have a consuming field."
            )

    # 3c: ambiguous parent. Multiple fields sharing a lookup is fine on its own;
    # it only matters when that lookup is also somebody's cascade source, since
    # then we cannot tell which sibling's value gates the dependent.
    for lookup_name, using_field_ids in lookup_name_to_using_field_ids.items():
        if len(using_field_ids) < 2:
            continue
        dependents = [f for f in cfg_fields
                      if f["depends_on_lookup_name"] == lookup_name]
        if not dependents:
            continue
        raise ValueError(
            f"Ambiguous cascade parent: lookup '{lookup_name}' is used by "
            f"multiple fields "
            f"({[_field_name(field_by_id, fid) for fid in using_field_ids]}) "
            f"AND is the cascade source for other fields "
            f"({[f['field_name'] for f in dependents]}). Cannot determine "
            f"which of the consuming fields gates the cascade. Either "
            f"consolidate to a single consuming field, or split "
            f"'{lookup_name}' into distinct per-role lookups."
        )

    # 3d: cycles. A field whose cascade chain returns to itself cannot render.
    for field in cfg_fields:
        if not field["cascade_parent_field_id"]:
            continue
        visited = [field["field_id"]]
        current = field["cascade_parent_field_id"]
        while current:
            if current in visited:
                chain = " -> ".join(
                    _field_name(field_by_id, fid) for fid in visited + [current]
                )
                raise ValueError(
                    f"Cascade cycle detected starting at field "
                    f"'{field['field_name']}': {chain}. Remove the cycle by "
                    f"correcting one field's 'Depends on' value."
                )
            visited.append(current)
            parent = field_by_id.get(current)
            current = parent["cascade_parent_field_id"] if parent else None

def self_check(cfg_fields, cfg_rules, cfg_variants, cfg_variant_fields,
               cfg_form_slot_mappings, cfg_lookups, field_by_id,
               lookup_name_to_using_field_ids):
    """Verify the canonical model is internally consistent before returning.

    CFG-01 has already validated the parsed config; this verifies we built a
    well-formed canonical model from it.
    """
    variant_ids = {v["variant_id"] for v in cfg_variants}
    lookup_names = {l["lookup_name"] for l in cfg_lookups}

    check_foreign_keys(cfg_rules, cfg_variant_fields, cfg_form_slot_mappings,
                       field_by_id, variant_ids)
    check_lookup_references(cfg_fields, cfg_form_slot_mappings, lookup_names)
    check_cascade_graph(cfg_fields, field_by_id, lookup_names,
                        lookup_name_to_using_field_ids)

    return lookup_names


# --- SUMMARY ----------------------------------------------------------------------------------
def build_summary(cfg_fields, cfg_rules, cfg_lookups, lookup_names, cfg_variants,
                  cfg_variant_fields, cfg_form_slot_mappings, cfg_error_messages,
                  slot_pool_cursor, fields_without_slots, slot_pool,
                  form_channel_status):
    """Diagnostic payload, emitted with the config_parsed event.

    control_type_counts is the direct signal that derivation ran: an all-empty or single-bucket distribution
    means _resolve_control_type is not seeing the data_type/data_format vocabulary it expects.
    """
    control_type_counts = {}
    for field in cfg_fields:
        key = field["control_type"] or "(none)"
        control_type_counts[key] = control_type_counts.get(key, 0) + 1

    return {
        "field_count":              len(cfg_fields),
        "visible_field_count":      sum(1 for f in cfg_fields if f["visible"]),
        "rule_count":               len(cfg_rules),
        "lookup_value_count":       len(cfg_lookups),
        "unique_lookup_name_count": len(lookup_names),
        "variant_count":            len(cfg_variants),
        "variant_field_count":      len(cfg_variant_fields),
        "form_slot_count":          len(cfg_form_slot_mappings),
        "error_message_count":      len(cfg_error_messages),
        "control_type_counts":      control_type_counts,
        "cascade_slot_count":       sum(
            1 for m in cfg_form_slot_mappings if m["depends_on_slot_name"]
        ),
        "slot_pool_usage": {
            slot_type: {
                "used":      slot_pool_cursor[slot_type],
                "available": len(slot_pool[slot_type]),
            }
            for slot_type in slot_pool
        },
        "fields_without_slots":     fields_without_slots,
        "form_channel_status":      form_channel_status,
    }


# --- WORKATO ENTRY-POINT ----------------------------------------------------------------------
def main(input):
    parsed_raw = input.get("parsed_config_json")
    if not parsed_raw:
        raise ValueError("parsed_config_json input is empty or missing")

    parsed = json.loads(parsed_raw) if isinstance(parsed_raw, str) else parsed_raw

    template_version_id = input["template_version_id"]
    version_number      = input["version_number"]
    project_id          = input["project_id"]
    expected_sheet_name = (input.get("expected_sheet_name") or "Data").strip()

    raw_capacities = (input.get("slot_capacities") or "").strip()
    capacities = json.loads(raw_capacities) if raw_capacities else dict(DEFAULT_CAPACITIES)
    if set(capacities) != set(DEFAULT_CAPACITIES):
        # A malformed capacities input is a CALLER contradiction, not a config condition.
        raise ValueError(
            "slot_capacities keys must be exactly text/num/bool/sel/date; got %s"
            % sorted(capacities)
        )
    slot_pool = build_slot_pool(capacities)
    caller = (input.get("caller") or "").strip() or "PRV-02"

    built_at = datetime.now(timezone.utc).isoformat()

    # Phase 1 / 1b — fields and cascade parents
    cfg_fields, field_name_to_id, lookup_name_to_using_field_ids = build_fields(
        parsed.get("fields", [])
    )
    resolve_cascade_parents(cfg_fields, lookup_name_to_using_field_ids)
    field_by_id = {f["field_id"]: f for f in cfg_fields}

    # Phase 1c — must-fit set for form-channel viability
    must_fit, dependency_defects = build_must_fit(cfg_fields, field_by_id)

    # Phases 2-4
    cfg_lookups = build_lookups(parsed.get("lookups", []))
    cfg_rules = build_rules(parsed.get("rules", []), field_name_to_id)
    cfg_variants, cfg_variant_fields = build_variants(
        parsed.get("variants", []), field_name_to_id
    )

    # Phase 5 / 5b — slot allocation and cascade slot resolution
    cfg_form_slot_mappings, slot_pool_cursor, fields_without_slots, deficits = (
        assign_form_slots(cfg_fields, slot_pool, must_fit)
    )
    cfg_form_slot_mappings, cascade_defects, cascade_dropped = resolve_slot_cascades(
        cfg_form_slot_mappings, field_by_id, must_fit
    )

    # Phase 6
    cfg_error_messages = build_error_messages(parsed.get("error_translations", []))

    # Phase 6b — form-channel viability verdict
    form_channel_status, form_channel = build_form_channel(
        cfg_fields, must_fit, capacities, slot_pool_cursor,
        fields_without_slots, cascade_dropped, deficits,
        dependency_defects + cascade_defects,
    )

    # Phase 7
    lookup_names = self_check(
        cfg_fields, cfg_rules, cfg_variants, cfg_variant_fields,
        cfg_form_slot_mappings, cfg_lookups, field_by_id,
        lookup_name_to_using_field_ids,
    )

    meta = {
        "template_version_id": template_version_id,
        "version_number":      version_number,
        "project_id":          project_id,
        "expected_sheet_name": expected_sheet_name,
        "built_at":            built_at,
        "built_by_recipe":     caller,
        "form_channel":        form_channel,
    }

    canonical_model = {
        "_meta":                  meta,
        "cfg_fields":             cfg_fields,
        "cfg_lookups":            cfg_lookups,
        "cfg_rules":              cfg_rules,
        "cfg_variants":           cfg_variants,
        "cfg_variant_fields":     cfg_variant_fields,
        "cfg_form_slot_mappings": cfg_form_slot_mappings,
        "cfg_error_messages":     cfg_error_messages,
    }

    summary = build_summary(
        cfg_fields, cfg_rules, cfg_lookups, lookup_names, cfg_variants,
        cfg_variant_fields, cfg_form_slot_mappings, cfg_error_messages,
        slot_pool_cursor, fields_without_slots, slot_pool,
        form_channel_status,
    )

    return {
        "canonical_model_json":   json.dumps(canonical_model, default=str),
        "cfg_fields":             cfg_fields,
        "cfg_lookups":            cfg_lookups,
        "cfg_rules":              cfg_rules,
        "cfg_variants":           cfg_variants,
        "cfg_variant_fields":     cfg_variant_fields,
        "cfg_form_slot_mappings": cfg_form_slot_mappings,
        "cfg_error_messages":     cfg_error_messages,
        "meta":                   meta,
        "summary":                summary,
        "form_channel_status":      form_channel_status,
        "form_channel_detail_json": json.dumps(form_channel, default=str),
    }
