Here’s a battle-tested way to make “mystery XLSX” reliably importable into Smartsheet: **treat the incoming file as untrusted**, aggressively **sniff what it actually is**, then **rebuild a clean, values-only XLSX** that stays inside Smartsheet’s rules/limits, and finally **POST it to Smartsheet’s import endpoint**.

## 0) Smartsheet constraints you need to design around

These are the gotchas that should shape the automation:

* **Import API expects CSV or XLSX (not XLS)**, and the data should be “basic text” (formulas/images/hierarchy won’t import the way Excel does). ([Smartsheet Developers][1])
* **Only the first (left-most) worksheet imports**, and **merged cells are excluded** (so don’t rely on them). ([Smartsheet Help Center][2])
* **Sheet hard limits**: max **20,000 rows**, **400 columns**, and **500,000 cells** (rows × columns). ([Smartsheet Developers][3])
* **API upload size** is capped (commonly **30 MB**). ([Smartsheet Developers][4])
* **sheetName and filename must be ASCII** when importing via API. ([Smartsheet Developers][1])
* Import endpoints you’ll use:

  * `POST /folders/{folderId}/sheets/import`
  * `POST /workspaces/{workspaceId}/sheets/import`
  * (`/sheets/import` is deprecated) ([Smartsheet Developers][1])

## 1) Automation architecture (simple + robust)

**Recommended pattern (works great with Workato/GCP/etc.):**

1. **Ingest** the file (email attachment / SFTP / upload form / Workato Files / bucket event).
2. **Repair & normalize service** (Cloud Run / Lambda / container):

   * Detect actual format (real XLSX zip? old XLS? CSV? HTML disguised as XLSX?)
   * Convert to a **clean, values-only XLSX**
   * Trim to real used range (kills the “Smartsheet thinks I have 1556 columns” style bugs)
   * Enforce Smartsheet limits (split into multiple sheets/files if needed)
   * ASCII-safe naming
3. **Upload to Smartsheet** via import API (folder/workspace import). ([Smartsheet Developers][1])

The key idea: **don’t “fix” the original**. **Rebuild** a new workbook from extracted values. This eliminates most encoding/formatting weirdness in one swing.

## 2) Repair strategy (the “triage ladder”)

### Step A — Sniff what the file *really* is

Check magic bytes:

* **XLSX**: starts with `PK\x03\x04` (ZIP container)
* **XLS (old Excel)**: starts with OLE header `D0 CF 11 E0 A1 B1 1A E1`
* **CSV/TSV**: plain text, lots of delimiters/newlines
* **HTML** (common lie): starts with `<html` / `<table` etc (often exported from systems then renamed `.xlsx`)

### Step B — Convert/repair into something readable

* If **XLS** → convert to XLSX (best fallback: **LibreOffice headless** in a container).
* If **XLSX but “bad”** (zip errors, broken XML, encoding errors) → try:

  1. load with `openpyxl`
  2. if it fails, fallback to LibreOffice “open + resave” (it often salvages corrupt OOXML better than pure Python)
* If **CSV/TSV/HTML** disguised as XLSX → parse and write XLSX.

### Step C — Normalize for Smartsheet (non-negotiable)

* Use **only left-most sheet** (or explicitly pick one).
* **Flatten to values** (no formulas; Smartsheet import wants “basic text”). ([Smartsheet Developers][1])
* **Remove merged cells** by rebuilding (merged cells are excluded on import anyway). ([Smartsheet Help Center][2])
* **Trim unused rows/cols** to real data bounds.
* Enforce:

  * cols ≤ 400
  * rows ≤ 20,000
  * rows × cols ≤ 500,000 ([Smartsheet Developers][3])
* ASCII-safe `sheetName` + `filename`. ([Smartsheet Developers][1])

If limits are exceeded: **split into multiple outputs** (usually chunk rows).

## 3) Smartsheet upload call (what your automation ultimately does)

Smartsheet’s import is a “file-in-body” POST with query params like `sheetName`, `headerRowIndex`, `primaryColumnIndex`, and strict content-type. ([Smartsheet Developers][1])

Example (folder import):

```bash
curl -X POST \
  "https://api.smartsheet.com/2.0/folders/${FOLDER_ID}/sheets/import?sheetName=MySheet&headerRowIndex=0&primaryColumnIndex=0" \
  -H "Authorization: Bearer ${SMARTSHEET_TOKEN}" \
  -H 'Content-Disposition: attachment; filename="MySheet.xlsx"' \
  -H "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" \
  --data-binary "@./MySheet.xlsx"
```

(Use `/workspaces/{workspaceId}/sheets/import` if you’re importing into a workspace.) ([Smartsheet Developers][1])

## 4) Practical Python “repair + normalize” core (values-only rebuild)

This is the heart of the repair service. It intentionally **rebuilds** a fresh workbook.

```python
import io
import os
import re
import csv
import zipfile
import subprocess
from typing import List, Tuple, Optional

from openpyxl import load_workbook, Workbook

ILLEGAL_XML_CHARS_RE = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F]")

def ascii_slug(s: str, default: str = "Sheet") -> str:
    if not s:
        return default
    s = s.strip()
    # Replace non-ascii with underscore, collapse runs
    s = s.encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^A-Za-z0-9._ -]+", "_", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s or default

def sniff_kind(b: bytes) -> str:
    if b.startswith(b"PK\x03\x04"):
        return "xlsx_zip"
    if b.startswith(bytes.fromhex("D0CF11E0A1B11AE1")):
        return "xls_ole"
    head = b[:4096].lstrip().lower()
    if head.startswith(b"<html") or b"<table" in head:
        return "html"
    # crude text sniff
    if b"\n" in head and (head.count(b",") + head.count(b"\t") + head.count(b";")) > 10:
        return "delimited_text"
    return "unknown"

def libreoffice_convert_to_xlsx(src_path: str, out_dir: str) -> str:
    """
    Requires LibreOffice installed in the runtime image.
    Produces an .xlsx in out_dir with same basename.
    """
    cmd = [
        "soffice",
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--convert-to", "xlsx",
        "--outdir", out_dir,
        src_path,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    base = os.path.splitext(os.path.basename(src_path))[0]
    out_path = os.path.join(out_dir, base + ".xlsx")
    if not os.path.exists(out_path):
        # LibreOffice sometimes changes casing; find newest xlsx
        cands = [os.path.join(out_dir, f) for f in os.listdir(out_dir) if f.lower().endswith(".xlsx")]
        out_path = max(cands, key=os.path.getmtime)
    return out_path

def parse_delimited_to_rows(b: bytes) -> List[List[str]]:
    text = b.decode("utf-8", errors="replace")
    sample = text[:4096]
    dialect = csv.Sniffer().sniff(sample, delimiters=[",", "\t", ";", "|"])
    reader = csv.reader(io.StringIO(text), dialect)
    return [[cell for cell in row] for row in reader]

def normalize_xlsx_values_only(
    xlsx_path: str,
    out_path: str,
    sheet_name: str = "Imported",
    max_rows: int = 20000,
    max_cols: int = 400,
    max_cells: int = 500000,
) -> Tuple[int, int]:
    wb = load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb.worksheets[0]  # left-most sheet (Smartsheet behavior)
    out_wb = Workbook()
    out_ws = out_wb.active
    out_ws.title = ascii_slug(sheet_name, "Imported")[:31]  # Excel title limit

    row_count = 0
    col_count = 0

    for row in ws.iter_rows(values_only=True):
        # Trim trailing Nones
        row = list(row)
        while row and row[-1] is None:
            row.pop()

        if not row:
            # Keep empty rows? Usually no—skip to avoid “phantom range” issues.
            continue

        # Enforce max cols
        if len(row) > max_cols:
            row = row[:max_cols]

        clean = []
        for v in row:
            if v is None:
                clean.append(None)
                continue
            if isinstance(v, str):
                clean.append(ILLEGAL_XML_CHARS_RE.sub("", v))
            else:
                clean.append(v)

        out_ws.append(clean)
        row_count += 1
        col_count = max(col_count, len(clean))

        if row_count >= max_rows:
            break

        if row_count * max(col_count, 1) >= max_cells:
            break

    out_wb.save(out_path)
    return row_count, col_count

def repair_for_smartsheet(
    in_bytes: bytes,
    work_dir: str,
    desired_sheet_name: str,
) -> List[str]:
    os.makedirs(work_dir, exist_ok=True)

    kind = sniff_kind(in_bytes)
    src_path = os.path.join(work_dir, "input.bin")
    with open(src_path, "wb") as f:
        f.write(in_bytes)

    # Step 1: obtain a readable XLSX on disk
    if kind == "xlsx_zip":
        # verify zip integrity quickly
        try:
            with zipfile.ZipFile(io.BytesIO(in_bytes)) as z:
                z.testzip()
            readable_xlsx = src_path
            # Try openpyxl; if it fails, fall back to LO conversion
            try:
                load_workbook(readable_xlsx, read_only=True, data_only=True)
            except Exception:
                readable_xlsx = libreoffice_convert_to_xlsx(src_path, work_dir)
        except Exception:
            readable_xlsx = libreoffice_convert_to_xlsx(src_path, work_dir)
    elif kind == "xls_ole":
        readable_xlsx = libreoffice_convert_to_xlsx(src_path, work_dir)
    elif kind in ("delimited_text", "html"):
        # Simplest: treat as delimited text; if HTML, utf-8 decode will still pull text,
        # but for real HTML tables you’d ideally use pandas.read_html in a fuller version.
        rows = parse_delimited_to_rows(in_bytes)
        temp_xlsx = os.path.join(work_dir, "from_text.xlsx")
        wb = Workbook()
        ws = wb.active
        ws.title = "Imported"
        for r in rows:
            ws.append(r)
        wb.save(temp_xlsx)
        readable_xlsx = temp_xlsx
    else:
        # Last-ditch: try LibreOffice anyway
        readable_xlsx = libreoffice_convert_to_xlsx(src_path, work_dir)

    # Step 2: normalize into a clean, values-only XLSX inside Smartsheet limits
    outputs = []
    safe_name = ascii_slug(desired_sheet_name, "Imported")
    out_path = os.path.join(work_dir, f"{safe_name}.xlsx")

    rows, cols = normalize_xlsx_values_only(
        readable_xlsx,
        out_path,
        sheet_name=safe_name,
    )
    outputs.append(out_path)

    # If you want true splitting (when source exceeds limits), expand normalize_xlsx_values_only
    # to chunk into multiple output files based on rows/cols/cells thresholds.

    return outputs
```

### Why this works

* Rebuilding values-only nukes most of the weird stuff that breaks Smartsheet imports:

  * phantom formatting ranges that make Smartsheet think you have thousands of columns
  * illegal XML control characters
  * merged cells (which Smartsheet drops anyway) ([Smartsheet Help Center][2])
  * formulas (Smartsheet import is “basic text” oriented) ([Smartsheet Developers][1])

## 5) “Tell it like it is” failure cases you should explicitly handle

These should produce a clear error + quarantine path (don’t silently “fix”):

* **Password-protected / encrypted XLSX** (you can detect; you can’t legally/cleanly recover without the password)
* Files that exceed limits and you haven’t implemented splitting yet (row/col/cell caps) ([Smartsheet Developers][3])
* Over **30 MB** when using API upload ([Smartsheet Developers][4])
* HTML “.xlsx” that isn’t actually parseable as delimited text (use `pandas.read_html` if this is common)

## 6) If you’re doing this in Workato (quick mapping)

* **Trigger**: New file (email / SFTP / Workato Files / Box/Drive)
* **Action**: HTTP → call your “repair service” (Cloud Run) with file content
* **Action**: HTTP → Smartsheet import (`/folders/{folderId}/sheets/import`), send the repaired XLSX bytes as request body and set headers exactly as required ([Smartsheet Developers][1])
* **Logging**: store a JSON “repair report” (kind detected, rows/cols, whether LO fallback used, output filenames, split count, etc.)

---

If you implement just one principle: **rebuild a new XLSX from extracted values** (and trim hard). It’s the Excel equivalent of “turn it off and back on again,” except it actually works.

[1]: https://developers.smartsheet.com/api/smartsheet/openapi/imports/import-sheet-into-sheets-folder "Import sheet from CSV / XLSX"
[2]: https://help.smartsheet.com/articles/504553-import-files-to-create-new-sheets?utm_source=chatgpt.com "Import file data to new sheets"
[3]: https://developers.smartsheet.com/api/smartsheet/guides/basics/limitations?utm_source=chatgpt.com "Limitations"
[4]: https://developers.smartsheet.com/api/smartsheet/openapi/sheets/create-sheet-in-folder "Create sheet in folder"
