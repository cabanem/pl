"""
Unlock a submitted SDC template for analyst download.

Entry point:
    main(input) -> dict

Why this is trivial (and needs no password):
    TPL-02 applies *sheet protection* + *workbook-structure protection*, NOT file
    encryption. Those are advisory flags in the OOXML, not cryptography -- openpyxl
    reads the file without any password, and "unlocking" is just clearing the flags
    and re-emitting the workbook. (This is also why a supplier can hand back an
    unlocked file: protection was never a hard lock.) So the protection_password is
    deliberately NOT plumbed through here.

Idempotent:
    If the supplier already stripped protection, clearing it again is a no-op --
    the output is an unlocked file either way.

Input:
    file_content : binary datapill (bytes) OR base64 str -- the *submitted* xlsx

Output:
    {
      'status'       : 'success',
      'file_content' : base64 str (unlocked xlsx),
      'byte_size'    : int,
      'log'          : str,          # boundary diagnostics; never print()
    }

Precondition violations propagate (consistent with TPL-02's stance on malformed
input): a file that isn't an xlsx, or an *encrypted* OLE2 workbook openpyxl cannot
open, means the stored artifact isn't what we think it is -- fail loud.
"""

import base64
import binascii
import io

from openpyxl import load_workbook
from openpyxl.worksheet.protection import SheetProtection
from openpyxl.workbook.protection import WorkbookProtection


def _normalize_to_xlsx_bytes(content):
    """str->bytes via latin-1, then magic-number dispatch, asserting a real zip at
    the boundary. Mirrors the SDC Python<->Workato file-handling rule."""
    if isinstance(content, str):
        content = content.encode("latin-1")

    if content[:4] == b"UEsD":               # base64 *text* of a zip ('UEsD' = b64 of b'PK\x03')
        content = base64.b64decode(content)

    if content[:4] != b"PK\x03\x04":         # must now be a raw zip / xlsx (504b0304)
        head = binascii.hexlify(content[:8]).decode("ascii")
        if head.lower().startswith("d0cf11e0"):
            raise ValueError(
                "Submitted file is an encrypted/OLE2 workbook (header d0cf11e0); "
                "openpyxl cannot open it. The template uses sheet protection, not "
                "file encryption, so this is a supplier deviation."
            )
        raise ValueError("Not an XLSX: leading bytes {0}".format(head))

    return content


def main(input):
    raw = _normalize_to_xlsx_bytes(input["file_content"])

    wb = load_workbook(io.BytesIO(raw))

    # Strip protection. Replacing with fresh defaults is version-robust:
    #   - a default SheetProtection has sheet=False
    #   - a default WorkbookProtection has lockStructure=False
    # Cell-level locked/unlocked flags only matter while sheet protection is ON, so
    # once it's off they're irrelevant; we leave them (and sheet visibility, e.g. the
    # veryHidden Reference sheet) untouched.
    were_locked = [ws.title for ws in wb.worksheets if ws.protection.sheet]
    for ws in wb.worksheets:
        ws.protection = SheetProtection()
    wb.security = WorkbookProtection()

    buf = io.BytesIO()
    wb.save(buf)
    out = buf.getvalue()

    return {
        "status": "success",
        "file_content": base64.b64encode(out).decode("ascii"),
        "byte_size": len(out),
        "log": "cleared structure protection; unlocked sheets: {0}".format(
            ", ".join(were_locked) or "(none were locked)"
        ),
    }
