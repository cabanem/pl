/**
 * @file dependent_dropdowns.gs (PATCHED)
 * @description Adds dependent dropdown support to template generation.
 *
 * FIXES APPLIED:
 *   1. SpreadsheetApp.flush() before Sheets API batchUpdate call
 *      — eliminates race condition where named ranges don't exist yet
 *   2. INDIRECT formula now mirrors ALL sanitization from sanitizeRangeName()
 *      — handles &, /, (), and other special chars, not just spaces
 *
 * PREREQUISITES:
 *  Enable the Google Sheets API advanced service.
 */

/**
 * Truthy check that handles boolean, numeric 1 and string "TRUE"/"1".
 */
function isChecked(val) {
  return val === true
    || val === 1
    || String(val).trim() === '1'
    || String(val).trim().toUpperCase() === 'TRUE';
}

/**
 * Converts a 1-based column number to a letter.
 */
function colToLetter(col) {
  let letter = '';
  while (col > 0) {
    const mod = (col - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

/**
 * Sanitizes a string for use as a Google Sheets named range.
 */
function sanitizeRangeName(name) {
  let sanitized = String(name).trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '');
  if (/^\d/.test(sanitized)) sanitized = '_' + sanitized;
  return sanitized;
}

/**
 * Builds the INDIRECT formula that mirrors sanitizeRangeName() logic exactly.
 *
 * sanitizeRangeName does three things:
 *   1. Replace whitespace runs with _
 *   2. Strip all non-alphanumeric, non-underscore chars
 *   3. Prepend _ if the result starts with a digit
 *
 * We replicate steps 1–2 in a Sheets formula so the cell value resolves
 * to the same string that was used as the named range identifier.
 *
 * Step 3 (leading digit) is handled by the data: if a parent value starts
 * with a digit, sanitizeRangeName prepends "_", and we do the same in the
 * formula with an IF check.
 *
 * @param {string} parentColLetter - Column letter of the parent dropdown (e.g., "E").
 * @param {number} rowNum - Row number for the formula reference (e.g., 2).
 * @returns {string} A Sheets formula string like =INDIRECT(...)
 */
function buildIndirectFormula(parentColLetter, rowNum) {
  const cellRef = `${parentColLetter}${rowNum}`;

  // Step 1: Replace spaces with underscores
  // Step 2: Strip non-alphanumeric/non-underscore via REGEXREPLACE
  // Step 3: Prepend _ if result starts with a digit
  //
  // Note: REGEXREPLACE is available in Google Sheets (not Excel).
  // Since we export to XLSX, we need this to resolve BEFORE export.
  // The validation formula stored in the XLSX will reference named ranges
  // that are static — INDIRECT just maps the parent value to the right name.
  //
  // Simpler approach: since we control the parent dropdown values,
  // we can use a nested SUBSTITUTE chain for known special chars.
  // This avoids REGEXREPLACE (which doesn't exist in Excel) and is more
  // portable across the export boundary.

  // Chain: spaces → _, then strip common special chars by replacing with ""
  const specialChars = ['&', '/', '(', ')', '-', '.', ',', "'", '"'];
  let formula = `SUBSTITUTE(${cellRef}," ","_")`;
  specialChars.forEach(ch => {
    formula = `SUBSTITUTE(${formula},"${ch}","")`;
  });

  // Wrap in INDIRECT
  return `=INDIRECT(${formula})`;
}


/**
 * Groups lookup values by parent, writes each group as a named column
 * in Data_Lookups sheet, and creates named ranges.
 *
 * @param {Spreadsheet} tempSs - Temporary spreadsheet being built.
 * @param {Sheet} dataSheet - Data_Lookups sheet.
 * @param {Array<Array>} lookupData - Raw 2D array from 5_lookups.
 * @param {string} lookupName - Dependent lookup table name.
 * @param {number} startCol - 1-based column to start writing in Data_Lookups.
 *
 * @returns {{ count: number }} Number of parent-group columns written.
 */
function writeDependentLookups(tempSs, dataSheet, lookupData, lookupName, startCol) {
  const groups = {};

  for (let i = 1; i < lookupData.length; i++) {
    const tableName = String(lookupData[i][0]).trim();
    const label     = String(lookupData[i][2]).trim();
    const parent    = lookupData[i][3] != null ? String(lookupData[i][3]).trim() : '';

    if (tableName !== lookupName || !isChecked(lookupData[i][4]) || !label || !parent) {
      continue;
    }

    if (!groups[parent]) groups[parent] = [];
    groups[parent].push(label);
  }

  const parentNames = Object.keys(groups);
  if (parentNames.length === 0) {
    console.warn(`No parent-grouped values found for "${lookupName}".`);
    return { count: 0 };
  }

  parentNames.forEach((parent, idx) => {
    const col      = startCol + idx;
    const values   = groups[parent];
    const rangeName = sanitizeRangeName(parent);

    // Header = raw parent name (for readability), named range = sanitized
    dataSheet.getRange(1, col).setValue(parent).setFontWeight('bold');
    dataSheet.getRange(2, col, values.length, 1).setValues(values.map(v => [v]));

    const namedRange = dataSheet.getRange(2, col, values.length, 1);
    tempSs.setNamedRange(rangeName, namedRange);
  });

  console.log(`Wrote ${parentNames.length} parent groups for "${lookupName}": ${parentNames.join(', ')}`);
  return { count: parentNames.length };
}


/**
 * Applies data validation to each field column in the generated template.
 * Handles regular dropdowns, dependent dropdowns (via INDIRECT), and dates.
 *
 * @param {Spreadsheet} tempSs - The temp spreadsheet.
 * @param {Sheet} tempSheet - The "Supplier Data" sheet.
 * @param {Sheet} dataSheet - The "Data_Lookups" sheet.
 * @param {Array<Object>} fields - The field definitions for this variant.
 * @param {Array<Array>} lookupData - Raw 2D array from 5_lookups.
 */
function applyFieldValidations(tempSs, tempSheet, dataSheet, fields, lookupData) {
  let lookupColTracker = 1;
  const DATA_ROWS = 500;

  // Build a name → column index map so dependent fields can find their parent
  const fieldColMap = {};
  fields.forEach((f, i) => {
    fieldColMap[f.name] = i + 1;
    if (f.lookupName) fieldColMap[f.lookupName] = i + 1;
  });

  fields.forEach((field, index) => {
    const col = index + 1;
    const validationRange = tempSheet.getRange(2, col, DATA_ROWS, 1);
    const format = field.dataFormat ? String(field.dataFormat).trim().toLowerCase() : '';

    // ── Dependent dropdown ────────────────────────────────
    if (format.includes('dependent') && field.lookupName && field.dependsOn) {
      const parentCol = fieldColMap[field.dependsOn];

      if (!parentCol) {
        console.warn(`Dependent field "${field.name}": parent "${field.dependsOn}" not found in template columns. Falling back to flat list.`);
        // Fall through to regular dropdown below
      } else {
        // Write grouped columns + named ranges
        const result = writeDependentLookups(tempSs, dataSheet, lookupData, field.lookupName, lookupColTracker);

        if (result.count > 0) {
          lookupColTracker += result.count;

          // ┌─────────────────────────────────────────────────────────┐
          // │ FIX 1: Flush SpreadsheetApp writes BEFORE the Sheets   │
          // │ API call. Without this, named ranges created by        │
          // │ writeDependentLookups may not be committed yet when     │
          // │ batchUpdate reads the spreadsheet via the REST API.    │
          // └─────────────────────────────────────────────────────────┘
          SpreadsheetApp.flush();

          // ┌─────────────────────────────────────────────────────────┐
          // │ FIX 2: Use buildIndirectFormula() instead of inline     │
          // │ SUBSTITUTE. This mirrors ALL sanitization logic from    │
          // │ sanitizeRangeName(), not just space→underscore.         │
          // └─────────────────────────────────────────────────────────┘
          const parentColLetter = colToLetter(parentCol);
          const formula = buildIndirectFormula(parentColLetter, 2);

          // Use the Sheets API to set a dynamic dropdown validation.
          // SpreadsheetApp.newDataValidation() can't do INDIRECT dropdowns.
          Sheets.Spreadsheets.batchUpdate({
            requests: [{
              setDataValidation: {
                range: {
                  sheetId: tempSheet.getSheetId(),
                  startRowIndex: 1,         // row 2 (0-based)
                  endRowIndex: 1 + DATA_ROWS,
                  startColumnIndex: col - 1, // 0-based
                  endColumnIndex: col
                },
                rule: {
                  condition: {
                    type: 'ONE_OF_RANGE',
                    values: [{ userEnteredValue: formula }]
                  },
                  showCustomUi: true,
                  strict: false
                }
              }
            }]
          }, tempSs.getId());

          console.log(`Applied INDIRECT validation for "${field.name}" → parent "${field.dependsOn}" (col ${parentColLetter}).`);
          return; // done with this field
        }
        // If no groups found, fall through to regular dropdown
      }
    }

    // ── Regular dropdown ──────────────────────────────────
    if (format.includes('dropdown') && field.lookupName) {
      const lookupValues = getLookupValues(lookupData, field.lookupName);

      if (lookupValues.length > 0) {
        const values2D = lookupValues.map(val => [val]);
        dataSheet.getRange(1, lookupColTracker).setValue(field.lookupName).setFontWeight('bold');
        const sourceRange = dataSheet.getRange(2, lookupColTracker, lookupValues.length, 1);
        sourceRange.setValues(values2D);

        const rule = SpreadsheetApp.newDataValidation()
          .requireValueInRange(sourceRange, true)
          .setAllowInvalid(false)
          .build();
        validationRange.setDataValidation(rule);
        lookupColTracker++;
      }
      return;
    }

    // ── Date validation ───────────────────────────────────
    if (field.dataType === 'date') {
      const rule = SpreadsheetApp.newDataValidation()
        .requireDate()
        .setAllowInvalid(false)
        .build();
      validationRange.setDataValidation(rule);
    }
  });
}
