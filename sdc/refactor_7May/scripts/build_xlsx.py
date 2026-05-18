"""
TPL-02 Build XLSX template — py_eval snippet.

Paste the entire contents into the py_eval action's `code` field.

Entry point:
    main(input) -> dict

Expected `input` keys (per the recipe's input mapping):
    canonical_model_json : str   — JSON content of the canonical model
                                    (output of validate-config, read from
                                    FileStorage in recipe step 5)
    variant_id           : str   — empty string for the base case
    customer_name        : str
    variant_name         : str   — resolved name; "base" when no variant_id

Returns:
    {
      'status'             : 'success' | 'empty_variant',
      'file_content'       : base64 str or None,
      'suggested_filename' : str or None,
      'metadata'           : dict or None,
      'error'              : {'code': str, 'message': str} or None,
    }

Failure modes:
    - 'empty_variant'         — soft outcome. Returned as a status value,
                                with error.code = 'empty_variant'. Recipe
                                step 11 picks this up; OBS-01 does NOT fire.
    - Any other BuildError    — raised as exception. Recipe's catch block
                                fires OBS-01 with phase=recipe_failed.
                                These indicate Validate config let through
                                a configuration it shouldn't have.

Assumed canonical model shape (cfg_* keys are lists of records):
    cfg_fields[i]          = { field_id, field_name, position, data_type,
                               required, lookup_name?, parent_field_id?,
                               data_format? }
    cfg_variant_fields[i]  = { variant_id, field_id }
    cfg_lookups[i]         = { lookup_name, value, parent_value? }
                              (one row per value; parent_value present
                               means this row is a child of a dependent
                               lookup)
    cfg_rules[i]           = { field_id, ... }              # not used here
    cfg_error_translations = list or dict                   # not used here
"""

import base64
import io
import json
import re
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation


# ──────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────

DATA_ROWS = 1000
DATA_SHEET_NAME = "Data Entry"
REFERENCE_SHEET_NAME = "Reference"
NAMED_RANGE_PREFIX = "LU_"  # prefix every named range, avoids collisions
                            # with cell-reference patterns like "Q4"

_HEADER_FONT = Font(bold=True, color="FFFFFF")
_HEADER_FILL = PatternFill("solid", fgColor="4F81BD")
_HEADER_ALIGN = Alignment(horizontal="center", vertical="center", wrap_text=True)
_REQUIRED_FILL = PatternFill("solid", fgColor="C0504D")


# ──────────────────────────────────────────────────────────────────────
# Error type — caught only for empty_variant; everything else propagates
# ──────────────────────────────────────────────────────────────────────

class BuildError(Exception):
    def __init__(self, code, message):
        self.code = code
        self.message = message
        super().__init__("[{0}] {1}".format(code, message))


# ──────────────────────────────────────────────────────────────────────
# Robust truthy check — handles bool, int 1, "1", "TRUE", "true"
# (canonical model may serialise booleans as numerics or strings)
# ──────────────────────────────────────────────────────────────────────

def _is_truthy(val):
    if val is True:
        return True
    if val == 1:
        return True
    s = str(val).strip().upper() if val is not None else ""
    return s in ("1", "TRUE", "YES")


# ──────────────────────────────────────────────────────────────────────
# Shared sanitization — load-bearing invariant
#
# The same substitution map is used twice:
#   (a) in Python, to name the defined ranges on the reference sheet;
#   (b) inside the INDIRECT formula's SUBSTITUTE chain at runtime.
# They cannot drift because they're both derived from the same list of
# (char, replacement) pairs computed once from the actual parent values.
# ──────────────────────────────────────────────────────────────────────

_NAMED_RANGE_SAFE = re.compile(r"[A-Za-z0-9_]")


def _compute_substitutions(parent_values):
    """Find every disallowed char across the parent values, paired with '_'."""
    disallowed = set()
    for value in parent_values:
        for char in str(value):
            if not _NAMED_RANGE_SAFE.match(char):
                disallowed.add(char)
    return [(c, "_") for c in sorted(disallowed)]


def _sanitize_for_named_range(value, substitutions):
    """Python-side: apply the substitution map to a parent value."""
    result = str(value)
    for char, replacement in substitutions:
        result = result.replace(char, replacement)
    return result


def _build_indirect_formula(parent_cell_ref, substitutions):
    """Formula-side: build the SUBSTITUTE chain mirroring _sanitize_for_named_range."""
    expr = parent_cell_ref
    for char, replacement in substitutions:
        esc_char = char.replace('"', '""')
        esc_repl = replacement.replace('"', '""')
        expr = 'SUBSTITUTE({0},"{1}","{2}")'.format(expr, esc_char, esc_repl)
    return 'INDIRECT("{0}"&{1})'.format(NAMED_RANGE_PREFIX, expr)


def _named_range_name(parent_value, substitutions):
    return "{0}{1}".format(
        NAMED_RANGE_PREFIX,
        _sanitize_for_named_range(parent_value, substitutions),
    )


def _safe_identifier(name):
    """Sanitize an arbitrary string into a safe identifier suffix."""
    return re.sub(r"[^A-Za-z0-9_]", "_", str(name))


# ──────────────────────────────────────────────────────────────────────
# Substages 1–2: slice fields by variant, then narrow lookups
# ──────────────────────────────────────────────────────────────────────

def _resolve_fields(model, variant_id):
    """
    Return the variant's fields, sorted by position. Base case (no
    variant_id) returns all fields from the version.
    """
    all_fields = model.get("cfg_fields", [])
    if variant_id:
        included_ids = {
            vf["field_id"] for vf in model.get("cfg_variant_fields", [])
            if vf.get("variant_id") == variant_id
        }
        fields = [f for f in all_fields if f.get("field_id") in included_ids]
    else:
        fields = list(all_fields)
    return sorted(fields, key=lambda f: int(f.get("position", 0)))


def _index_lookups(cfg_lookups_rows, needed_names):
    """
    Convert the flat lookup-row list into a per-lookup structure.

    For each needed lookup, returns either:
        {'kind': 'flat', 'values': [v1, v2, ...]}
    or
        {'kind': 'dependent', 'groups': {parent: [child1, child2], ...}}

    Raises BuildError if a needed lookup has zero values.
    """
    flat = {}
    dependent = {}

    for row in cfg_lookups_rows:
        name = row.get("lookup_name")
        if name not in needed_names:
            continue
        value = row.get("value")
        parent = row.get("parent_value")
        if parent:
            dependent.setdefault(name, {}).setdefault(parent, []).append(value)
        else:
            flat.setdefault(name, []).append(value)

    indexed = {}
    for name in needed_names:
        if name in dependent:
            indexed[name] = {"kind": "dependent", "groups": dependent[name]}
        elif name in flat:
            indexed[name] = {"kind": "flat", "values": flat[name]}
        else:
            raise BuildError(
                "LOOKUP_HAS_NO_VALUES",
                "Field references lookup '{0}' but it has no values.".format(name),
            )
    return indexed


# ──────────────────────────────────────────────────────────────────────
# Substage 3: lay out the reference sheet
# ──────────────────────────────────────────────────────────────────────

def _lay_out_reference(lookups):
    """
    Decide column placement on the reference sheet. Build the
    substitution map from the union of all parent values across all
    dependent lookups. Returns a layout dict with everything the
    workbook construction needs.
    """
    flat_columns = {}              # lookup_name -> col_idx
    dependent_columns = {}         # (lookup_name, parent_value) -> col_idx
    defined_ranges = []            # list of (range_name, range_ref)

    all_parents = []
    for lookup in lookups.values():
        if lookup["kind"] == "dependent":
            all_parents.extend(lookup["groups"].keys())
    substitutions = _compute_substitutions(all_parents)

    next_col = 1
    for name, lookup in lookups.items():
        if lookup["kind"] == "flat":
            flat_columns[name] = next_col
            col_letter = get_column_letter(next_col)
            range_ref = "'{0}'!${1}$2:${1}${2}".format(
                REFERENCE_SHEET_NAME, col_letter, 1 + len(lookup["values"])
            )
            defined_ranges.append(
                ("{0}FLAT_{1}".format(NAMED_RANGE_PREFIX, _safe_identifier(name)),
                 range_ref)
            )
            next_col += 1
        else:
            for parent_value, children in lookup["groups"].items():
                dependent_columns[(name, parent_value)] = next_col
                col_letter = get_column_letter(next_col)
                range_ref = "'{0}'!${1}$2:${1}${2}".format(
                    REFERENCE_SHEET_NAME, col_letter, 1 + len(children)
                )
                defined_ranges.append(
                    (_named_range_name(parent_value, substitutions), range_ref)
                )
                next_col += 1

    return {
        "flat_columns": flat_columns,
        "dependent_columns": dependent_columns,
        "substitutions": substitutions,
        "defined_ranges": defined_ranges,
    }


# ──────────────────────────────────────────────────────────────────────
# Substages 4–6: workbook, header row, reference content
# ──────────────────────────────────────────────────────────────────────

def _create_workbook():
    wb = Workbook()
    data_ws = wb.active
    data_ws.title = DATA_SHEET_NAME
    ref_ws = wb.create_sheet(REFERENCE_SHEET_NAME)
    ref_ws.sheet_state = "hidden"
    return wb, data_ws, ref_ws


def _write_data_header(data_ws, fields):
    for col_idx, field in enumerate(fields, start=1):
        display = field.get("field_name", field.get("field_id", ""))
        required = _is_truthy(field.get("required"))
        header_text = display + (" *" if required else "")
        cell = data_ws.cell(row=1, column=col_idx, value=header_text)
        cell.font = _HEADER_FONT
        cell.fill = _REQUIRED_FILL if required else _HEADER_FILL
        cell.alignment = _HEADER_ALIGN
        data_ws.column_dimensions[get_column_letter(col_idx)].width = max(
            len(header_text) + 4, 14
        )
    data_ws.freeze_panes = "A2"


def _write_reference_content(ref_ws, lookups, layout):
    substitutions = layout["substitutions"]

    for name, lookup in lookups.items():
        if lookup["kind"] == "flat":
            col_idx = layout["flat_columns"][name]
            ref_ws.cell(row=1, column=col_idx, value=name).font = _HEADER_FONT
            for row_offset, value in enumerate(lookup["values"], start=2):
                ref_ws.cell(row=row_offset, column=col_idx, value=value)
        else:
            for parent_value, children in lookup["groups"].items():
                col_idx = layout["dependent_columns"][(name, parent_value)]
                sanitized = _sanitize_for_named_range(parent_value, substitutions)
                ref_ws.cell(row=1, column=col_idx, value=sanitized).font = _HEADER_FONT
                for row_offset, child_value in enumerate(children, start=2):
                    ref_ws.cell(row=row_offset, column=col_idx, value=child_value)


def _register_defined_names(wb, layout):
    for name, range_ref in layout["defined_ranges"]:
        wb.defined_names[name] = DefinedName(name=name, attr_text=range_ref)


# ──────────────────────────────────────────────────────────────────────
# Substage 7: data validations
# ──────────────────────────────────────────────────────────────────────

def _apply_data_validations(data_ws, fields, lookups, layout):
    field_col_index = {f["field_id"]: idx for idx, f in enumerate(fields, start=1)}
    last_row = 1 + DATA_ROWS

    for col_idx, field in enumerate(fields, start=1):
        col_letter = get_column_letter(col_idx)
        cell_range = "{0}2:{0}{1}".format(col_letter, last_row)
        field_id = field.get("field_id")
        display = field.get("field_name", field_id or "")
        lookup_name = field.get("lookup_name")
        parent_id = field.get("parent_field_id")

        # ── Dependent dropdown ──
        if lookup_name and parent_id:
            lookup = lookups.get(lookup_name)
            if lookup is None or lookup["kind"] != "dependent":
                raise BuildError(
                    "DEPENDENT_FIELD_FLAT_LOOKUP",
                    "Field '{0}' declares parent '{1}' but lookup '{2}' is flat or missing.".format(
                        field_id, parent_id, lookup_name
                    ),
                )
            parent_col_idx = field_col_index.get(parent_id)
            if parent_col_idx is None:
                raise BuildError(
                    "PARENT_FIELD_NOT_IN_VARIANT",
                    "Dependent field '{0}' references parent '{1}' which is not in the resolved field set.".format(
                        field_id, parent_id
                    ),
                )
            parent_letter = get_column_letter(parent_col_idx)
            formula1 = _build_indirect_formula(
                "{0}2".format(parent_letter), layout["substitutions"]
            )
            dv = DataValidation(type="list", formula1=formula1, allow_blank=True)
            dv.error = "Select a valid {0}".format(display)
            dv.errorTitle = "Invalid selection"
            dv.showErrorMessage = True
            dv.add(cell_range)
            data_ws.add_data_validation(dv)
            continue

        # ── Flat dropdown ──
        if lookup_name:
            range_name = "{0}FLAT_{1}".format(
                NAMED_RANGE_PREFIX, _safe_identifier(lookup_name)
            )
            dv = DataValidation(
                type="list", formula1="={0}".format(range_name), allow_blank=True
            )
            dv.error = "Select a valid {0}".format(display)
            dv.errorTitle = "Invalid selection"
            dv.showErrorMessage = True
            dv.add(cell_range)
            data_ws.add_data_validation(dv)
            continue

        # ── Type / format constraint ──
        dv = _build_type_validation(field, cell_range, display)
        if dv is not None:
            data_ws.add_data_validation(dv)


def _build_type_validation(field, cell_range, display):
    raw_format = field.get("data_format") or {}
    if isinstance(raw_format, str):
        try:
            fmt = json.loads(raw_format) if raw_format.strip() else {}
        except (ValueError, TypeError):
            fmt = {}
    else:
        fmt = raw_format

    data_type = field.get("data_type", "text")
    required = _is_truthy(field.get("required"))
    allow_blank = not required

    if data_type == "number":
        dv_type = "whole" if _is_truthy(fmt.get("integer")) else "decimal"
        has_min = "min" in fmt
        has_max = "max" in fmt
        if has_min and has_max:
            op = "between"
            f1, f2 = str(fmt["min"]), str(fmt["max"])
        elif has_min:
            op, f1, f2 = "greaterThanOrEqual", str(fmt["min"]), None
        elif has_max:
            op, f1, f2 = "lessThanOrEqual", str(fmt["max"]), None
        else:
            op, f1, f2 = None, None, None
        dv = DataValidation(
            type=dv_type, operator=op, formula1=f1, formula2=f2, allow_blank=allow_blank
        )
        dv.error = "{0} must be a number".format(display)
        dv.errorTitle = "Invalid value"
        dv.showErrorMessage = True
        dv.add(cell_range)
        return dv

    if data_type == "date":
        has_min = "min" in fmt
        has_max = "max" in fmt
        if has_min and has_max:
            op, f1, f2 = "between", fmt["min"], fmt["max"]
        elif has_min:
            op, f1, f2 = "greaterThanOrEqual", fmt["min"], None
        elif has_max:
            op, f1, f2 = "lessThanOrEqual", fmt["max"], None
        else:
            op, f1, f2 = None, None, None
        dv = DataValidation(
            type="date", operator=op, formula1=f1, formula2=f2, allow_blank=allow_blank
        )
        dv.error = "{0} must be a valid date".format(display)
        dv.errorTitle = "Invalid date"
        dv.showErrorMessage = True
        dv.add(cell_range)
        return dv

    if data_type == "text" and "max_length" in fmt:
        dv = DataValidation(
            type="textLength",
            operator="lessThanOrEqual",
            formula1=str(fmt["max_length"]),
            allow_blank=allow_blank,
        )
        dv.error = "{0} cannot exceed {1} characters".format(display, fmt["max_length"])
        dv.errorTitle = "Too long"
        dv.showErrorMessage = True
        dv.add(cell_range)
        return dv

    return None


# ──────────────────────────────────────────────────────────────────────
# Substage 9–10: serialize, compose output
# ──────────────────────────────────────────────────────────────────────

def _serialize_to_bytes(wb):
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _build_filename(customer_name, variant_name):
    safe_customer = _safe_identifier(customer_name)
    safe_variant = _safe_identifier(variant_name) if variant_name else "base"
    stamp = datetime.utcnow().strftime("%Y%m%d")
    return "{0}_{1}_{2}.xlsx".format(safe_customer, safe_variant, stamp)


def _empty_variant_outcome():
    return {
        "status": "empty_variant",
        "file_content": None,
        "suggested_filename": None,
        "metadata": None,
        "error": {
            "code": "empty_variant",
            "message": (
                "Variant resolved to zero fields. Check the variant's "
                "field associations or the version's field definitions."
            ),
        },
    }


# ──────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────

def main(input):
    # Parse the canonical model. A malformed JSON here is a precondition
    # violation (FileStorage held something invalid) — let it propagate.
    model = json.loads(input["canonical_model_json"])

    variant_id = input.get("variant_id") or None
    customer_name = input["customer_name"]
    variant_name = input.get("variant_name") or "base"

    # Substage 1: slice fields by variant
    fields = _resolve_fields(model, variant_id)
    if not fields:
        return _empty_variant_outcome()

    # Substage 2: narrow lookups to those the resolved fields reference
    needed_lookup_names = {
        f["lookup_name"] for f in fields if f.get("lookup_name")
    }
    lookups = _index_lookups(model.get("cfg_lookups", []), needed_lookup_names)

    # Substage 3: lay out the reference sheet, derive substitution map
    layout = _lay_out_reference(lookups)

    # Substages 4–6: workbook scaffold, header row, reference content
    wb, data_ws, ref_ws = _create_workbook()
    _write_data_header(data_ws, fields)
    _write_reference_content(ref_ws, lookups, layout)
    _register_defined_names(wb, layout)

    # Substage 7: data validations (flat dropdowns, dependent dropdowns,
    # type/format constraints)
    _apply_data_validations(data_ws, fields, lookups, layout)

    # Substages 9–10: serialize, compose output
    file_bytes = _serialize_to_bytes(wb)
    return {
        "status": "success",
        "file_content": base64.b64encode(file_bytes).decode("ascii"),
        "suggested_filename": _build_filename(customer_name, variant_name),
        "metadata": {
            "sheet_names": [DATA_SHEET_NAME, REFERENCE_SHEET_NAME],
            "byte_size": len(file_bytes),
            "row_count": 0,
            "field_count": len(fields),
        },
        "error": None,
    }
