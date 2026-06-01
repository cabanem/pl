Same discipline as before — let me verify the three column-level styles (width, number format, protection) actually coexist in the real call order before handing you code that assumes they do.Verified — width, number format, and the protection unlock all merge into one column xf in the real call order, body cells stay unmaterialised (so they inherit the format), and the header keeps its own style and stays `General`/locked, untouched. Notably `0.00%` resolved to Excel's built-in format id 10, so percent needs no custom registration. Here's the patch.

**1. Factor out the `data_format` parse** (both the validation builder and the new format step need it — single source, no drift):

```python
def _parse_data_format(field):
    """Normalise data_format to a dict (it may arrive as a JSON string)."""
    raw = field.get("data_format") or {}
    if isinstance(raw, str):
        try:
            return json.loads(raw) if raw.strip() else {}
        except (ValueError, TypeError):
            return {}
    return raw
```

Then the top of `_build_type_validation` collapses to:

```python
def _build_type_validation(field, cell_range, display):
    fmt = _parse_data_format(field)
    data_type = field.get("data_type", "text")
    required = _is_truthy(field.get("required"))
    allow_blank = not required
    # ... unchanged from here
```

**2. Display-format helpers and the application step:**

```python
# --- Display (number) formats ----------------------------------------------
_DEFAULT_DATE_FORMAT = "yyyy-mm-dd"           # ISO; unambiguous across locales
_STRFTIME_TO_EXCEL = {                         # only the date tokens
    "%Y": "yyyy", "%y": "yy",
    "%B": "mmmm", "%b": "mmm", "%m": "mm",
    "%d": "dd",
}

def _date_format_code(fmt):
    # CONFIRM the key 4_fields/CAN-01 actually uses for the date mask:
    mask = fmt.get("display_format") or fmt.get("pattern") or fmt.get("format")
    if not mask:
        return _DEFAULT_DATE_FORMAT
    mask = str(mask)
    if "%" in mask:                            # analyst supplied strftime — translate
        for token, repl in _STRFTIME_TO_EXCEL.items():
            mask = mask.replace(token, repl)
    return mask                                # else assume it's already an Excel code

def _percent_format_code(fmt):
    try:
        decimals = int(fmt.get("decimals"))
    except (TypeError, ValueError):
        decimals = 2
    return "0%" if decimals <= 0 else "0.{0}%".format("0" * decimals)

def _excel_number_format(field):
    """Excel display-format code for a field, or None if it needs no formatting."""
    data_type = (field.get("data_type") or "text").lower()
    fmt = _parse_data_format(field)
    if data_type == "date":
        return _date_format_code(fmt)
    # CONFIRM how the model expresses percentage — handle both shapes for now:
    is_percent = (
        data_type in ("percent", "percentage")
        or _is_truthy(fmt.get("percent"))
        or str(fmt.get("format", "")).lower() == "percent"
    )
    if is_percent:
        return _percent_format_code(fmt)
    return None

def _apply_column_formats(data_ws, fields):
    """
    Apply display (number) formats at the column-default level so the
    unmaterialised entry cells inherit them. Display only: governs how Excel
    RENDERS a value, not what is accepted (validation) nor what the server
    ingests (the stored value). Coexists with column width and the unlock.
    """
    for col_idx, field in enumerate(fields, start=1):
        code = _excel_number_format(field)
        if code is None:
            continue
        data_ws.column_dimensions[get_column_letter(col_idx)].number_format = code
```

**3. Wire it into `main`,** right after the header (before or after validations is fine — separate style slot):

```python
    _write_data_header(data_ws, fields)
    _apply_column_formats(data_ws, fields)        # ← display formats: date, percent
    _write_reference_content(ref_ws, lookups, layout)
```

That's the whole change. Now the two things that will bite if unspoken, both about the gap between *display* and *stored value*:

The sharp one is **percent units**. A percent-formatted cell stores the *proportion* — 10% is stored as `0.1`. So two things must be in proportion units, not 0–100: the validation `min`/`max` your number branch emits for that field, and whatever range the server enforces on ingestion. If an analyst writes `min:0, max:100` thinking "0 to 100 percent," the DV compares against the stored `0.1` and a 5000%-equivalent (`50.0`) sails through `≤100`. The display format and the bounds have to agree that the unit is the proportion. Worth a guard in CAN-01 or a note to analysts: percent bounds are 0–1.

The softer one is **percent entry**. Pre-formatting a cell as percent changes how Excel interprets a typed bare number, and the exact mapping depends on Excel's "automatic percent entry" option — so "10", "10%", and "0.1" can store different things. Don't reason about it; trust only the stored value (which is what the server reads anyway) and tell suppliers the field is a percentage. The smoke test should type all three into the percent column and record what actually lands in the cell.

Two confirmations I'm assuming blind: the `data_format` key carrying the date mask (I probe `display_format`/`pattern`/`format`), and how the model flags a percentage (dedicated `data_type` vs a `number` field with a `percent` flag — I handle both). Align those to the real CAN-01 output and the helpers won't need to change. And the locale note from last turn still holds: `mmmm` renders localized month names, so ISO stays the safer default for an international supplier base.

For the smoke test, add: a date column displays its mask for a typed date and for a pre-existing differently-shaped date; the percent column shows the three entry forms and you log the stored result of each.
