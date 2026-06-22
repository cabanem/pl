Let me verify the two load-bearing assumptions behind a couple of these patches — that the data sheet is reliably identifiable by visibility after a round-trip, and that the column format reads back cleanly — so I'm not recommending something subtly wrong.All assumptions check out: the data sheet is reliably the single visible sheet after a round-trip, the column format reads back via `.get()`, and the base64-xlsx prefix is `UEsD`. Here is the full set of changes, grouped by script and ordered top-to-bottom through each file.

## Script 1 — `hydrate_template` (the seeding script)

**1. Imports — top of file, with the other imports.** `_coerce` and the `_cell_text` fix need `datetime`.

```python
from datetime import date, datetime
```

**2. Constants block — remove the hardcoded sheet name.** The data sheet name is computed by TPL-02 from `_meta.expected_sheet_name`; hydrate shouldn't keep a second copy of it. Delete the `DATA_ENTRY_SHEET` line (Change 6 reads the name from the file instead). Also reword the two docstring mentions of the `"Data Entry"` / `"Data"` sheet to "the data-entry sheet (resolved from the template)."

```python
# before
DATA_ENTRY_SHEET 	= "Data"
HEADER_ROW 			= 1
DATA_START_ROW 		= 3
# after
HEADER_ROW     = 1
DATA_START_ROW = 3
```

**3. Delete `_decode_csv_text`.** It sits between `_decode_xlsx` and `_column_locked` and is never called (`_read_seed_rows` does its own decoding). Dead code — remove the whole function.

**4. Add `_column_number_format` — alongside `_column_locked`.** This is the missing piece behind both symptoms: openpyxl does not copy a column's default format onto a freshly written cell, so we read it here to re-apply it per cell.

```python
def _column_number_format(ws, col_letter, default="General"):
    """Read a column's display number_format from the loaded template. openpyxl
    does NOT copy the column default onto a cell it writes — that cell lands as
    'General' — so seeded cells must re-stamp this themselves."""
    dim = ws.column_dimensions.get(col_letter)
    if dim is not None and dim.number_format:
        return dim.number_format
    return default
```

**5. Add `_find_data_sheet` — near the other helpers (e.g. just above `hydrate_template`).** Replaces the hardcoded-name lookup; reads the truth from the artifact (the data sheet is the one visible sheet; Reference is veryHidden).

```python
def _find_data_sheet(wb):
    """The TPL-02 data sheet is the single visible sheet (Reference is veryHidden),
    so resolve it from the file rather than a hardcoded name that can drift from
    TPL-02's _meta.expected_sheet_name."""
    visible = [ws for ws in wb.worksheets if ws.sheet_state == "visible"]
    if len(visible) != 1:
        raise ValueError(
            "expected exactly one visible sheet (the data sheet); found: {0}".format(
                [(ws.title, ws.sheet_state) for ws in wb.worksheets]
            )
        )
    return visible[0]
```

**6. `_read_seed_rows` — add the base64-xlsx branch.** Makes the seed boundary as forgiving as `_decode_xlsx`; a base64-encoded xlsx (`UEsD…`) currently falls through to the CSV reader and produces garbage instead of a clear path.

```python
def _read_seed_rows(content):
    """Return (rows, fieldnames) from the seed file, dispatching on magic number.
    Mirrors _decode_xlsx: raw XLSX (zip), base64-encoded XLSX, then CSV text."""
    raw = _to_bytes(content)
    if raw[:4] == b"PK\x03\x04":              # raw XLSX / zip
        return _read_seed_rows_xlsx(raw)
    if raw[:4] == b"UEsD":                     # base64-encoded XLSX ('PK\x03\x04')
        return _read_seed_rows_xlsx(base64.b64decode(raw))
    if raw[:2] == b"PK":                       # zip, but not a standard XLSX
        raise ValueError("seed file looks like a zip but not a standard XLSX")
    return _read_seed_rows_csv(raw)            # text CSV
```

**7. `_cell_text` — stop manufacturing the `00:00:00`.** This is the literal source of "dates render as date-time" on the xlsx seed path: `str(datetime(2024,3,15))` → `'2024-03-15 00:00:00'`. Emit a clean date string at the boundary.

```python
def _cell_text(value):
    if value is None:
        return ""
    if isinstance(value, datetime):
        # str(datetime) appends '00:00:00' -> the date-time artifact downstream.
        # Emit date-only when there's no meaningful time component.
        if value.hour == value.minute == value.second == 0:
            return value.date().isoformat()
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()
```

**8. Add `_coerce` — just above `hydrate_template`.** The core fix. Turns the seed *string* into the type its column expects (so the format can actually act on it), inferring type from the template's `number_format` — the single source of truth for shape — and falling back to the raw text on any parse failure, so a malformed value is left visible, never dropped or corrupted.

```python
# Excel number_format tokens -> how to coerce the seed text for that column.
_DATE_FORMAT_TOKENS    = ("y", "d")
_NUMERIC_FORMAT_TOKENS = ("#", "0", "%")
_SEED_DATE_INPUTS      = ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y")

def _coerce(text, number_format):
    """Coerce a seed string to the Python type its template column expects, so
    Excel can apply the column's display format. Falls back to the original text
    on any parse failure (malformed values stay visible, never corrupted)."""
    s = str(text).strip()
    if not s:
        return text
    fmt = (number_format or "").lower()

    if any(tok in fmt for tok in _DATE_FORMAT_TOKENS):
        head = s.split(" ")[0]                 # tolerate a trailing time component
        for pattern in _SEED_DATE_INPUTS:
            try:
                return datetime.strptime(head, pattern).date()
            except ValueError:
                continue
        return text

    if any(tok in fmt for tok in _NUMERIC_FORMAT_TOKENS):
        cleaned = s.replace(",", "")
        pct = cleaned.endswith("%")
        if pct:
            cleaned = cleaned[:-1].strip()
        try:
            num = float(cleaned)
        except ValueError:
            return text
        return num / 100.0 if pct else num     # literal '%' in the seed means percent

    return text                                # General / text column -> unchanged
```

A note on the date branch's `split(" ")[0]`: it's deliberately redundant with Change 7. Change 7 cleans the xlsx boundary; the split tolerates a CSV that already contains `2024-03-15 00:00:00` as literal text. Either path lands on a clean date.

**9. `hydrate_template` body — three edits.** Open via `_find_data_sheet`, carry `number_format` through `col_for_key`, add the empty-write tripwire, and coerce + stamp the format in the write loop.

```python
    # 2) Open the template, preserving every structural feature.
    wb = openpyxl.load_workbook(io.BytesIO(_decode_xlsx(template_bytes)))
    ws = _find_data_sheet(wb)

    # 3) Map seed key -> (column, letter, locked, number_format) from row 1 only.
    col_for_key = {}
    for col in range(1, ws.max_column + 1):
        key = _field_key(ws.cell(row=HEADER_ROW, column=col).value)
        if key and key in key_to_header and key not in col_for_key:
            letter = get_column_letter(col)
            col_for_key[key] = (
                col, letter, _column_locked(ws, letter), _column_number_format(ws, letter)
            )

    writable = list(col_for_key.keys())                       # template column order
    skipped = [k for k in key_to_header if k not in col_for_key and k != index_norm]

    # Tripwire: rows matched but no seed column lines up with a template header —
    # usually the seed was authored against field_id while TPL-02 writes field_name
    # to row 1. Fail loud instead of shipping a blank-but-"successful" template.
    if matched and not writable:
        raise ValueError(
            "Matched {0} row(s) but no seed column matched a template header. "
            "Seed columns: {1}; template headers: {2}.".format(
                len(matched),
                sorted(key_to_header),
                sorted(
                    _field_key(ws.cell(row=HEADER_ROW, column=c).value)
                    for c in range(1, ws.max_column + 1)
                ),
            )
        )

    # 4) Write matched rows. Coerce text -> the column's type and re-stamp the
    # column's display format (openpyxl won't copy the column default onto a cell).
    for i, row in enumerate(matched):
        excel_row = DATA_START_ROW + i
        for key in writable:
            col, letter, locked, num_fmt = col_for_key[key]
            raw = row.get(key_to_header[key], "")
            if raw is None or raw == "":
                continue
            cell = ws.cell(row=excel_row, column=col, value=_coerce(raw, num_fmt))
            cell.number_format = num_fmt
            cell.protection = Protection(locked=locked)
```

## Script 2 — TPL-02 (the build script)

**10. `main` — remove the password leak.** The temporary diagnostic ships the plaintext password and its hash into the recipe output and job logs. Delete the comment and both keys, ending the return dict at `"error": None,`.

```python
# remove these three lines:
        # --- TEMPORARY DIAGNOSTIC (remove after confirming the password) ---
        "debug_pw_repr": repr(protection_password),
        "debug_pw_hash": hash_password(str(protection_password or "")),
```

**11. Imports — drop the now-unused `hash_password`.** Once Change 10 is in, this import has no remaining use.

```python
# remove:
from openpyxl.utils.protection import hash_password
```

## Lower-priority (your call, not bugs)

These three are decisions rather than fixes, so I'm flagging rather than patching:

- **Date DV bound (TPL-02, `_build_advisory_validation`, date branch).** `formula1="1900-01-01"` is a string passed to a `type="date"` validation; Excel may not honor it as a date bound. If you want it reliable, `formula1="DATE(1900,1,1)"` evaluates to the serial. Advisory-only, so low stakes.
- **Percentage value convention.** With the new `_coerce`, a seed value `0.5` in a `%` column displays as `50%`, while `50` displays as `5000%` (a trailing `%` like `"50%"` is handled correctly). That's a question of what your seed stores; VAL-01 stays the authority either way.
- **Currency symbol.** TPL-02 omits it by design (locale unknown). If "slightly off" partly meant "no `$`", that's the spot to revisit — but it's a deliberate choice, not a regression.
