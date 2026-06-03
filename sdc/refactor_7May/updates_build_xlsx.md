# TPL-02 Repair Spec — Advisory Validation Resolver

*Replaces the dead `_build_type_validation` path; collapses the two conflicting `data_format` readers into one; routes the shapes Excel can't block to instruction hints. Implements the follow-ups in ADR-NNNN (template advisory / server authoritative).*

---

## Summary

TPL-02's field-level validation was written against a `data_format`-as-dict schema the pipeline never produces, and branched on `data_type` values (`"number"`, `"text"`) that don't exist in the real vocabulary. The result: of the 27 non-dropdown fields in the current canonical model, only the 4 date fields received any in-cell validation; numbers, currency, and percentages received none, and the `email address` shape was neither blocked nor hinted.

This repair makes TPL-02 emit the **strongest advisory check Excel can honestly express** for each field, derived from a **single** interpretation of `data_format`, and surfaces the inexpressible shapes (email, and later regex/uniqueness/cross-field) as **instruction hints**. The server (VAL-01 `validate_upload`) remains the sole authority; nothing here is or pretends to be a gate.

**Proven effect against `canonical_model-2.json`:** in-cell numeric/date blocks rise from 4 fields to 16 (the integer, 9 percentages, 2 currencies, 4 dates); currency gains display formatting it never had; the email field gains a hint. No regressions to the dropdown paths.

---

## What changes (and why)

1. **Vocabulary fix.** Numeric detection now matches the real primitives (`integer`, `float (2)`) *and* the numeric shapes (`currency`, `percentage`). This matters because `currency` carries `data_type: "string"` in the model — its numeric-ness lives in the *shape*, exactly as VAL-01's `check_data_format` treats it.
2. **Single `data_format` reader.** The dead `_parse_data_format` (dict/JSON reader) is deleted. One normalized label feeds both the DV resolver and the display-format function. No more two-readers-that-disagree.
3. **Honest advisory scope.** Numbers/dates get native in-cell blocks. Email gets a hint. Regex/uniqueness/cross-field get nothing in-cell by design (Excel can't, and the server already enforces).

---

## Scope & non-goals

- **In scope now:** type-level numeric and date blocks; currency/percentage/date display formats; the email instruction hint; removal of the dead reader.
- **Deferred (not parsed here):** length / numeric-range / date-range *bounds*. All three `*_field_validation` columns are `null` in the current config. When the PRV chain emits **resolved structured bounds** at config-freeze, tighten the resolver in one place (see *Forward path*). The template never parses the raw analyst interval notation — that would re-create the server/template drift this design exists to prevent.
- **Explicit non-goal:** custom Excel "is-this-an-email / phone" formulas. They fail silently on paste and break on perpetual-license Excel (per ADR evidence). Rejected as false confidence.

---

## The edits

All edits are surgical. Apply in order.

### Edit 1 — DELETE the dead reader

Remove `_parse_data_format` entirely. It is referenced only by `_build_type_validation`, which Edit 4 replaces.

```python
# DELETE this whole function:
def _parse_data_format(field):
    """Normalise data format to a dict."""
    raw = field.get("data_format") or {}
    if isinstance(raw, str):
        try:
            return json.loads(raw) if raw.strip() else {}
        except (ValueError, TypeError):
            return {}
    return raw
```

### Edit 2 — ADD the single label normalizer

Place near the other small helpers (e.g. just above `_parse_data_format`'s old location, or beside `_safe_identifier`).

```python
def _format_label(field):
    """Normalized data_format label (lowercased, trimmed); '' when absent.
    The single source of truth for interpreting the analyst's shape dropdown."""
    return str(field.get("data_format") or "").strip().lower()
```

### Edit 3 — REPLACE the display-format reader

Replace `_excel_number_format` with `_display_number_format` (clearer name, same call site shape, no dependency on the deleted reader). Then update its one caller.

```python
def _display_number_format(field):
    """
    DISPLAY (number) format for a column, from the single data_format label.
    Display only: governs how Excel RENDERS a value — never what is accepted
    (that is the DV) nor what the server ingests (the stored value).
    Returns an Excel format code or None.
    """
    label     = _format_label(field)
    data_type = str(field.get("data_type") or "").strip().lower()

    if label.startswith("date") or data_type == "date":
        m = _DATE_MASK.search(field.get("data_format") or "")
        return m.group(1).strip().lower() if m else _DEFAULT_DATE_FORMAT

    if label == "percentage":
        m = _FLOAT_PREC.search(data_type)            # 'float (2)' -> 2
        decimals = int(m.group(1)) if m else 2
        return "0%" if decimals <= 0 else "0.{0}%".format("0" * decimals)

    if label == "currency":
        return "#,##0.00"   # symbol intentionally omitted — locale/currency unknown;
                            # cosmetic only, server is the authority for currency shape

    return None
```

In `_apply_column_formats`, update the call:

```python
    for col_idx, field in enumerate(fields, start=1):
        code = _display_number_format(field)   # was: _excel_number_format(field)
        if code is None:
            continue
        data_ws.column_dimensions[get_column_letter(col_idx)].number_format = code
```

### Edit 4 — REPLACE the validation resolver

Replace `_build_type_validation` with `_build_advisory_validation`. It runs only for non-lookup fields (the dropdown paths in `_apply_data_validations` `continue` before reaching it).

```python
def _build_advisory_validation(field, cell_range, display):
    """
    Strongest *advisory* in-cell check Excel can express for a non-lookup field.
    Returns a DataValidation or None.

    The authority for every field constraint is the server (VAL-01
    validate_upload). This layer exists only to block easy mistakes at type-time
    and cut reject/resubmit round-trips. It deliberately does NOT attempt
    email / regex / uniqueness / cross-field shapes — Excel cannot block those
    in-cell, so they are surfaced as instruction hints (see _advisory_hint) and
    enforced server-side.

    Numeric-ness is driven by the *shape* as well as the primitive type, because
    'currency' carries data_type 'string' in the model yet is numeric in
    practice (mirrors VAL-01's check_data_format).

    Range/length bounds are intentionally NOT parsed here. When the PRV chain
    emits resolved structured bounds at config-freeze, tighten this in ONE place
    (see the Forward path section) so template and server never drift.
    """
    label     = _format_label(field)
    data_type = str(field.get("data_type") or "").strip().lower()
    allow_blank = not _is_truthy(field.get("required"))
    top_left  = cell_range.split(":")[0]

    is_numeric = data_type in ("integer", "float (2)") or label in ("currency", "percentage")
    is_integer = data_type == "integer"
    is_date    = data_type == "date" or label.startswith("date")

    # ── Numeric (incl. currency / percentage) ──
    if is_numeric:
        if is_integer:
            formula = "AND(ISNUMBER({0}), {0}=INT({0}))".format(top_left)
        else:
            formula = "ISNUMBER({0})".format(top_left)
        dv = DataValidation(type="custom", formula1=formula, allow_blank=allow_blank)
        dv.error = "{0} must be a number.".format(display)
        dv.errorTitle = "Invalid value"
        dv.showErrorMessage = True
        dv.add(cell_range)
        return dv

    # ── Date ──
    if is_date:
        dv = DataValidation(
            type="date", operator="greaterThanOrEqual",
            formula1="1900-01-01", allow_blank=allow_blank,
        )
        dv.error = "{0} must be a valid date.".format(display)
        dv.errorTitle = "Invalid date"
        dv.showErrorMessage = True
        dv.add(cell_range)
        return dv

    # ── string / email / boolean / unshaped ──
    # No in-cell block. Guidance (if any) goes to the instruction banner.
    return None
```

In `_apply_data_validations`, update the final branch's call:

```python
        # ── Type / format constraint (advisory; authority is VAL-01) ──
        dv = _build_advisory_validation(field, cell_range, display)   # was: _build_type_validation(...)
        if dv is not None:
            data_ws.add_data_validation(dv)
```

### Edit 5 — ADD hints, compose the instruction banner

Add two helpers, then change one line in `_write_instruction_row`.

```python
def _advisory_hint(field):
    """
    Optional human-readable guidance appended to the locked instruction banner
    for constraints Excel cannot block in-cell. Keep hints generic and
    parse-free; the analyst's description stays the primary guidance lever, and
    VAL-01 stays the authority. Extend by adding cases.
    """
    label = _format_label(field)
    if label == "email address":
        return "Must be a valid email address (e.g. name@example.com)."
    # Future: a field carrying field_input_validation (regex) has no safe generic
    # hint — the raw pattern is meaningless to a supplier. Rely on the analyst's
    # description to state the expected format in words.
    return None


def _instruction_text(field):
    """Instruction-banner text: analyst description, plus any advisory hint."""
    parts = []
    desc = field.get("description")
    if desc and str(desc).strip():
        parts.append(str(desc).strip())
    hint = _advisory_hint(field)
    if hint:
        parts.append(hint)
    return "\n".join(parts)
```

In `_write_instruction_row`, change only the cell value:

```python
        cell = data_ws.cell(
            row=INSTRUCTION_ROW, column=col_idx, value=_instruction_text(field)
        )                                    # was: value=field.get("description") or ""
```

*(The banner row height is 56 with wrap; the one email hint adds a line and fits. If you later add longer hints, bump `row_dimensions[INSTRUCTION_ROW].height`.)*

---

## Verification (run against `canonical_model-2.json`)

Outcome by field class. "Before" = current code; "After" = this repair.

| Field class (count) | Before | After |
|---|---|---|
| Plain `string`, no shape (8) | none | none (correct — free text) |
| `string` / **email address** (1) | none | no DV + **email hint** in banner |
| **integer** (1) | none | custom `AND(ISNUMBER, =INT)` |
| `float (2)` / **percentage** (9) | none | custom `ISNUMBER` + `0.00%` display |
| `string`/`float (2)` / **currency** (2) | none | custom `ISNUMBER` + `#,##0.00` display |
| **date** / date mask (4) | weak date DV | date DV + `yyyy-mm-dd` display |
| Flat dropdown (`lookup_name`) (7) | list DV | list DV (unchanged) |
| Dependent dropdown (5) | INDIRECT list DV | INDIRECT list DV (unchanged) |

Totals: in-cell DV coverage on non-lookup fields **4 → 16**; display formats **11 → 15** (currency added); hints **0 → 1**. Dropdown paths untouched.

---

## Sidebar finding (separate from this spec)

Two fields — **"Active worker?"** and **"MSP/Outsorced worker"** — carry `data_format: "dropdown"` but `lookup_name: null` and `depends_on_lookup_name: null`. They therefore get **no list anywhere**: not in the template (no lookup to bind), and not at upload (VAL-01's membership check #9 only fires when `lookup_name` is present). They behave as free-text fields wearing a dropdown label.

This is a **config/authoring gap**, not a shape gap, so it's deliberately out of this resolver. The right home is the connector's `validate_config` — a "format is `dropdown(/dependent)` but no lookup is bound" check, surfaced to the analyst at authoring time. Flagging for the backlog.

---

## Forward path

1. **Bounds at config-freeze (the one place to tighten).** When the PRV chain parses the `*_field_validation` interval notation once and writes resolved bounds onto each field, e.g.
   ```
   field["_resolved_bounds"] = {
     "numeric": {"min": 0, "max": 100, "min_inclusive": True, "max_inclusive": False},
     "date":    {"min": "2024-01-01", "max": None},
     "length":  {"max": 255},
   }
   ```
   add a single reader and consume it inside `_build_advisory_validation` (numeric → `decimal`/`whole` with operator; date → `date` with operator; otherwise `textLength`). Both VAL-01 and TPL-02 then read the same parsed result — no second parser, no drift. Insertion points are marked in the resolver's docstring.

2. **`check_data_format` fail-closed guard (server, ADR follow-up).** It must recognize every label the `_mapping` shape dropdown can emit (`email address`, all four date masks, `currency`, `percentage`). An unrecognized label currently fails *open* (silently passes). If emails aren't being caught in the pilot, this is where the bug lives — not the template.

3. **Optional cleanup.** `_date_format_code` and `_percent_format_code` appear unused after this change; remove if confirmed dead.
