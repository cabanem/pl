"""
Workato Code by Workato (Python) — XLSX Template Generator
============================================================
Receives the field definitions and lookup data from the GAS webhook payload,
then generates an Excel file with native dependent dropdowns.

INPUT (from Workato recipe datapills — passed as `input` dict):
  - fields:    list of field objects from 6_variants
  - lookups:   list of lookup rows from 5_lookups
  - client_name: string
  - variant_name: string

OUTPUT:
  - file_content: base64-encoded XLSX bytes (hand off to Google Drive "Upload file" action)
  - file_name: string
"""

import base64
import io
import re
from openpyxl import Workbook
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.utils import get_column_letter, quote_sheetname


def sanitize_range_name(name):
    """Mirror the GAS sanitizeRangeName() logic exactly."""
    sanitized = re.sub(r'\s+', '_', str(name).strip())
    sanitized = re.sub(r'[^A-Za-z0-9_]', '', sanitized)
    if sanitized and sanitized[0].isdigit():
        sanitized = '_' + sanitized
    return sanitized


def generate_template(fields, lookups, client_name, variant_name):
    wb = Workbook()

    # ── Supplier Data sheet (the one suppliers fill out) ──
    ws = wb.active
    ws.title = "Supplier Data"

    # ── Hidden Data_Lookups sheet ──
    lookup_ws = wb.create_sheet("Data_Lookups")
    lookup_ws.sheet_state = 'hidden'

    DATA_ROWS = 500
    lookup_col = 1  # tracks next available column in Data_Lookups

    # Build field-name → column index map (1-based)
    field_col_map = {}
    for i, f in enumerate(fields):
        field_col_map[f['name']] = i + 1
        if f.get('lookup_name'):
            field_col_map[f['lookup_name']] = i + 1

    # ── Write headers ──
    for i, f in enumerate(fields):
        cell = ws.cell(row=1, column=i + 1, value=f['name'])
        cell.font = cell.font.copy(bold=True)

    # ── Apply validations per field ──
    for i, field in enumerate(fields):
        col = i + 1
        col_letter = get_column_letter(col)
        fmt = str(field.get('data_format') or '').strip().lower()

        # ── Dependent dropdown ──
        if 'dependent' in fmt and field.get('lookup_name') and field.get('depends_on'):
            parent_col_idx = field_col_map.get(field['depends_on'])
            if not parent_col_idx:
                print(f"WARN: parent '{field['depends_on']}' not found, falling back to flat list")
                # fall through to regular dropdown
            else:
                # Group lookup values by parent
                groups = {}
                for row in lookups:
                    table_name = str(row.get('table_name', '')).strip()
                    label = str(row.get('label', '')).strip()
                    parent = str(row.get('parent_value', '')).strip()
                    is_active = row.get('is_active', False)

                    if (table_name == field['lookup_name']
                            and is_active and label and parent):
                        groups.setdefault(parent, []).append(label)

                if groups:
                    # Write each parent group as a column + named range
                    for parent_name, values in groups.items():
                        range_name = sanitize_range_name(parent_name)

                        # Write header
                        lookup_ws.cell(
                            row=1, column=lookup_col, value=parent_name
                        ).font = lookup_ws.cell(
                            row=1, column=lookup_col
                        ).font.copy(bold=True)

                        # Write values
                        for r, val in enumerate(values, start=2):
                            lookup_ws.cell(row=r, column=lookup_col, value=val)

                        # Create workbook-scoped named range
                        lk_letter = get_column_letter(lookup_col)
                        ref = (
                            f"{quote_sheetname('Data_Lookups')}"
                            f"!${lk_letter}$2:${lk_letter}${1 + len(values)}"
                        )
                        defn = DefinedName(range_name, attr_text=ref)
                        wb.defined_names.add(defn)

                        lookup_col += 1

                    # Set data validation with INDIRECT formula
                    parent_letter = get_column_letter(parent_col_idx)
                    formula = f'INDIRECT(SUBSTITUTE({parent_letter}2," ","_"))'

                    dv = DataValidation(
                        type="list",
                        formula1=formula,
                        allow_blank=True
                    )
                    dv.error = f"Select a valid {field['name']}"
                    dv.errorTitle = "Invalid selection"
                    dv.showErrorMessage = True

                    # Apply to data rows
                    dv.add(f"{col_letter}2:{col_letter}{1 + DATA_ROWS}")
                    ws.add_data_validation(dv)

                    continue  # done with this field

        # ── Regular dropdown ──
        if 'dropdown' in fmt and field.get('lookup_name'):
            values = [
                str(row.get('label', '')).strip()
                for row in lookups
                if (str(row.get('table_name', '')).strip() == field['lookup_name']
                    and row.get('is_active', False)
                    and str(row.get('label', '')).strip())
            ]

            if values:
                # Write to Data_Lookups
                lookup_ws.cell(
                    row=1, column=lookup_col, value=field['lookup_name']
                ).font = lookup_ws.cell(
                    row=1, column=lookup_col
                ).font.copy(bold=True)

                for r, val in enumerate(values, start=2):
                    lookup_ws.cell(row=r, column=lookup_col, value=val)

                # Validation referencing the lookup range
                lk_letter = get_column_letter(lookup_col)
                ref = f"{quote_sheetname('Data_Lookups')}!${lk_letter}$2:${lk_letter}${1 + len(values)}"
                dv = DataValidation(
                    type="list",
                    formula1=f"={ref}",
                    allow_blank=True
                )
                dv.add(f"{col_letter}2:{col_letter}{1 + DATA_ROWS}")
                ws.add_data_validation(dv)

                lookup_col += 1

            continue

        # ── Date validation ──
        if field.get('data_type') == 'date':
            dv = DataValidation(type="date", allow_blank=True)
            dv.add(f"{col_letter}2:{col_letter}{1 + DATA_ROWS}")
            ws.add_data_validation(dv)

    # ── Auto-fit column widths (approximate) ──
    for i, f in enumerate(fields):
        ws.column_dimensions[get_column_letter(i + 1)].width = max(len(f['name']) + 4, 15)

    # ── Serialize to bytes ──
    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)

    return buffer.getvalue()


# ── Workato entry point ──
# In Code by Workato, `input` is the dict of datapills from the recipe.

fields = input.get('fields', [])
lookups = input.get('lookups', [])
client_name = input.get('client_name', 'Client')
variant_name = input.get('variant_name', 'Default')

xlsx_bytes = generate_template(fields, lookups, client_name, variant_name)

file_name = f"Supplier_Template_{client_name}_{variant_name}.xlsx"

output = {
    'file_content': base64.b64encode(xlsx_bytes).decode('utf-8'),
    'file_name': file_name
}
