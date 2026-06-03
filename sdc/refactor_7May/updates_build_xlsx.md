# TPL-02 Reorganization Spec — Plan / Render Split in a Single Blob

*Structural refactor only. No behavior changes: the same workbook comes out. This reorganizes the existing functions into a decide-phase and a render-phase within one Workato Python code field, and replaces two informal dicts with explicit records.*

---

## What the deployment constraints dictate

From the Workato "Execute Python code" action docs:

- **One `main(input)`, one dict parameter, helpers live at module level in the same code field.** No `import` of sibling modules (user-provided libraries aren't supported). → The *only* organizing mechanism is intra-file: section banners, source ordering, and records. The blob is the unit; source order is the reader's only map.
- **Python 3.9+** → `@dataclass` (stdlib since 3.7) is available. Use `Optional[...]` from `typing`, not `X | None` (3.10+).
- **1 MB max code-field size** → not binding (current file ≈ 25 KB). Don't optimize for it.

Net: the refactor is sectioning + a decide/render split + two dataclasses. Nothing more.

---

## Section map (top → bottom of the blob, in `main`'s execution order)

```
# 1. IMPORTS
# 2. CONSTANTS & STYLES            (DATA_ROWS, *_ROW, fonts/fills/borders, NAMED_RANGE_PREFIX)
# 3. ERROR TYPE                    (BuildError)
# 4. SMALL HELPERS                 (_is_truthy, _format_label, _safe_identifier)
# 5. SANITIZATION INVARIANT  ⚠     (the coupled pair — see banner below)
# 6. RECORD TYPES                  (ReferenceLayout, FieldPlan)
# 7. PLAN PHASE  (decide)          (interpret config → records; NO openpyxl writes)
# 8. RENDER PHASE (emit)           (records → workbook; NO decisions)
# 9. OUTPUT HELPERS                (_serialize_to_bytes, _build_filename, _empty_variant_outcome, _require_sheet_name)
# 10. MAIN                         (parse → plan → render → serialize)
```

The one section that earns a loud banner is the sanitization invariant — it's the highest-risk unit in the file (a bug there silently corrupts dropdowns, which has bitten before):

```python
# ============================================================================
# SANITIZATION INVARIANT — load-bearing, do not edit one half alone
# ----------------------------------------------------------------------------
# _sanitize_for_named_range (Python side) and _build_indirect_formula
# (Excel SUBSTITUTE side) MUST apply the same (char -> replacement) map, both
# derived from _compute_substitutions over the SAME parent values. If they
# drift, dependent dropdowns resolve to the wrong named range and silently
# show the wrong options. Change both halves together or neither.
# ============================================================================
```

---

## Record types (Section 6)

Two dataclasses replace the two informal dicts. They are the contract between plan and render.

```python
from dataclasses import dataclass, field as dc_field
from typing import Dict, List, Optional, Tuple
from openpyxl.worksheet.datavalidation import DataValidation


@dataclass
class ReferenceLayout:
    """Placement + named ranges for the (veryHidden) Reference sheet.
    Was the dict returned by _lay_out_reference."""
    flat_columns: Dict[str, int]                       # lookup_name -> col_idx
    dependent_columns: Dict[Tuple[str, str], int]      # (lookup_name, parent_value) -> col_idx
    substitutions: List[Tuple[str, str]]               # the shared (char, replacement) map
    defined_ranges: List[Tuple[str, str]]              # (range_name, range_ref)


@dataclass
class FieldPlan:
    """Everything the Data sheet needs for ONE column, decided once.
    Replaces the per-field re-derivation scattered across the old
    _write_data_header / _write_instruction_row / _apply_column_formats /
    _apply_data_validations / _apply_protection loops."""
    col_idx: int
    col_letter: str
    field_id: str
    header_text: str                                   # display + " *" if required
    is_required: bool
    is_locked: bool
    instruction_text: str                              # description + advisory hint
    number_format: Optional[str] = None                # display mask, or None
    data_validation: Optional[DataValidation] = None   # built in plan, attached in render
```

Holding the `DataValidation` object on the plan is intentional and safe: `dv.add(cell_range)` only records the range string on the object, so the DV can be fully built during planning (no worksheet yet) and merely *attached* during render.

---

## Plan phase (Section 7) — decide, no writes

`plan_fields` is the heart of the refactor: one loop, two passes. Pass 1 assigns columns and the static attributes; pass 2 builds validations, so a dependent dropdown can reference its parent's already-assigned column without rebuilding a `field_col_index` mid-loop.

```python
def plan_reference(lookups) -> ReferenceLayout:
    # Body is the current _lay_out_reference, returning ReferenceLayout(**...)
    # instead of a bare dict. Pure; no openpyxl.
    ...


def plan_fields(fields, lookups, layout: ReferenceLayout) -> List[FieldPlan]:
    last_row = DATA_START_ROW + DATA_ROWS - 1

    # ── Pass 1: columns + static attributes ──
    plans: List[FieldPlan] = []
    for col_idx, f in enumerate(fields, start=1):
        display  = f.get("field_name", f.get("field_id", ""))
        required = _is_truthy(f.get("required"))
        plans.append(FieldPlan(
            col_idx=col_idx,
            col_letter=get_column_letter(col_idx),
            field_id=f.get("field_id"),
            header_text=display + (" *" if required else ""),
            is_required=required,
            is_locked=_is_truthy(f.get("locked")),
            instruction_text=_instruction_text(f),
            number_format=_display_number_format(f),
        ))

    field_col_index = {p.field_id: p.col_idx for p in plans}

    # ── Pass 2: validations (may reference a parent column) ──
    for plan, f in zip(plans, fields):
        cell_range = "{0}{1}:{0}{2}".format(plan.col_letter, DATA_START_ROW, last_row)
        plan.data_validation = _plan_validation(f, cell_range, field_col_index, lookups, layout)

    return plans


def _plan_validation(field, cell_range, field_col_index, lookups, layout) -> Optional[DataValidation]:
    """The three branches moved verbatim (logic-wise) out of the old
    _apply_data_validations: dependent dropdown (INDIRECT), flat dropdown
    (named range), then _build_advisory_validation for type/format. Returns the
    DV or None. This is the ONLY place field validation is decided."""
    ...
```

Everything else in this section is existing code, relocated and pure: `_resolve_fields`, `_index_lookups`, `_display_number_format`, `_build_advisory_validation`, `_advisory_hint`, `_instruction_text`.

---

## Render phase (Section 8) — emit, no decisions

The five independent `fields` loops collapse into one walk over `plans`. The writers make no choices; every choice already lives on the plan.

```python
def render_data_sheet(data_ws, plans: List[FieldPlan]) -> None:
    for p in plans:
        # header
        cell = data_ws.cell(row=HEADER_ROW, column=p.col_idx, value=p.header_text)
        _format_header_cell(cell, p.is_required)
        data_ws.column_dimensions[p.col_letter].width = max(len(p.header_text) + 4, 14)
        # instruction banner
        ic = data_ws.cell(row=INSTRUCTION_ROW, column=p.col_idx, value=p.instruction_text)
        ic.font = _INSTRUCTION_FONT; ic.fill = _INSTRUCTION_FILL
        ic.border = _INSTRUCTION_BORDER; ic.alignment = _INSTRUCTION_ALIGN
        ic.protection = Protection(locked=True)
        # display format
        if p.number_format:
            data_ws.column_dimensions[p.col_letter].number_format = p.number_format
        # validation
        if p.data_validation is not None:
            data_ws.add_data_validation(p.data_validation)

    data_ws.row_dimensions[INSTRUCTION_ROW].height = 56
    data_ws.freeze_panes = "A{0}".format(DATA_START_ROW)


def apply_protection(wb, data_ws, ref_ws, plans: List[FieldPlan]) -> None:
    for p in plans:
        if p.is_locked:
            continue
        data_ws.column_dimensions[p.col_letter].protection = Protection(locked=False)
    data_ws.protection.sheet = True
    ref_ws.protection.sheet = True
    wb.security = WorkbookProtection(lockStructure=True)
```

`render_reference_sheet` (= current `_write_reference_content`), `register_defined_names` (= `_register_defined_names`), and `_create_workbook` move here unchanged.

---

## Main (Section 10) — the five-line story

```python
def main(input):
    model        = json.loads(input["canonical_model_json"])
    sheet_name   = _require_sheet_name(model)
    variant_id   = input.get("variant_id") or None
    customer     = input["customer_name"]
    variant_name = input.get("variant_name") or "base"

    # ── PLAN (decide) ──
    fields = _resolve_fields(model, variant_id)
    if not fields:
        return _empty_variant_outcome()
    needed  = {f["lookup_name"] for f in fields if f.get("lookup_name")}
    lookups = _index_lookups(model.get("cfg_lookups", []), needed)
    layout  = plan_reference(lookups)
    plans   = plan_fields(fields, lookups, layout)

    # ── RENDER (emit) ──
    wb, data_ws, ref_ws = _create_workbook(sheet_name)
    render_data_sheet(data_ws, plans)
    render_reference_sheet(ref_ws, lookups, layout)
    register_defined_names(wb, layout)
    apply_protection(wb, data_ws, ref_ws, plans)

    # ── SERIALIZE ──
    file_bytes = _serialize_to_bytes(wb)
    return {
        "status": "success",
        "file_content": base64.b64encode(file_bytes).decode("ascii"),
        "suggested_filename": _build_filename(customer, variant_name),
        "metadata": {
            "sheet_names": [sheet_name, REFERENCE_SHEET_NAME],
            "byte_size": len(file_bytes),
            "row_count": 0,
            "field_count": len(plans),
            "locked_field_count": sum(1 for p in plans if p.is_locked),
        },
        "error": None,
    }
```

---

## Migration map (it's mostly *moving* code)

| Current function | New home | Change |
|---|---|---|
| `_is_truthy`, `_safe_identifier`, `_format_label` | §4 Helpers | none |
| `_compute_substitutions`, `_sanitize_for_named_range`, `_build_indirect_formula`, `_named_range_name` | §5 Sanitization (bannered) | none — just isolated |
| `_lay_out_reference` | §7 → `plan_reference` | returns `ReferenceLayout` not dict |
| `_resolve_fields`, `_index_lookups` | §7 Plan | none |
| `_display_number_format`, `_build_advisory_validation`, `_advisory_hint`, `_instruction_text` | §7 Plan | none (already from repair spec) |
| *new* `plan_fields`, `_plan_validation` | §7 Plan | new — absorb the per-field derivations + the DV branches from `_apply_data_validations` |
| `_create_workbook` | §8 Render | none |
| `_write_data_header` + `_write_instruction_row` + `_apply_column_formats` + DV-attach loop | §8 → `render_data_sheet` | **merged** into one loop over plans |
| `_format_header_cell` | §8 Render | none |
| `_write_reference_content` | §8 → `render_reference_sheet` | rename |
| `_register_defined_names` | §8 → `register_defined_names` | rename |
| `_apply_protection` | §8 → `apply_protection` | reads `plan.is_locked` |
| `_serialize_to_bytes`, `_build_filename`, `_empty_variant_outcome`, `_require_sheet_name` | §9 Output | none |
| `_parse_data_format` | — | already deleted (repair spec) |
| `_date_format_code`, `_percent_format_code` | — | delete if confirmed dead |

---

## Guardrail

Stop at two dataclasses and the decide/render seam. This is a linear, single-purpose pipeline; a `TemplateBuilder` class, a stage registry, or pluggable validators would add ceremony without carrying state across methods — a namespace with extra steps. The whole complexity budget goes to (a) the plan/render split and (b) isolating the sanitization invariant. Everywhere else stays plain functions.

**Free win this unlocks:** `plan_fields` returns plain records, so the per-field decision is now assertable in a test without ever building a workbook — the same thing the verification harness did by hand becomes the natural unit test for TPL-02.
