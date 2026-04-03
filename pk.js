/**
 * @file dependent_dropdowns.gs
 * @description Adds dependent dropdown support to template generation.
 *
 * PREREQUISITES:
 *   Enable the Google Sheets API advanced service:
 *   Extensions > Apps Script > Services > + > Google Sheets API > Add
 *
 * CHANGES TO EXISTING CODE (in main.gs / buildExcelVariants):
 *
 *   1. Both field-push blocks (default path ~line 218, variant path ~line 248)
 *      must add dependsOn to the field object.
 *
 *   2. The validation loop (~line 289) is replaced with the new version below.
 *
 *   3. getLookupValues gets the fixed isActive check.
 */


// ── Shared utility ────────────────────────────────────────────

/**
 * Truthy check that handles boolean, numeric 1, and string "TRUE"/"1".
 * Use everywhere you currently check === true || === 'TRUE'.
 */
function isChecked(val) {
  return val === true
      || val === 1
      || String(val).trim() === '1'
      || String(val).trim().toUpperCase() === 'TRUE';
}


// ── Helpers for dependent dropdowns ───────────────────────────

/**
 * Converts a 1-based column number to a letter (1→A, 27→AA).
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
 * Named ranges: letters, digits, underscores only; must start with letter/underscore.
 */
function sanitizeRangeName(name) {
  let sanitized = String(name).trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '');
  if (/^\d/.test(sanitized)) sanitized = '_' + sanitized;
  return sanitized;
}


/**
 * Groups lookup values by parent, writes each group as a named column
 * in the Data_Lookups sheet, and creates named ranges.
 *
 * @param {Spreadsheet} tempSs - The temp spreadsheet being built.
 * @param {Sheet} dataSheet - The Data_Lookups sheet.
 * @param {Array<Array>} lookupData - Raw 2D array from 5_lookups.
 * @param {string} lookupName - The dependent lookup table name (e.g., "job_title").
 * @param {number} startCol - 1-based column to start writing in Data_Lookups.
 * @returns {{ count: number }} Number of parent-group columns written.
 */
function writeDependentLookups(tempSs, dataSheet, lookupData, lookupName, startCol) {
  // Group values by their parent
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

  // Write each group as a column and create a named range
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


// ── Updated field object push ─────────────────────────────────
//
// In buildExcelVariants, BOTH places where you push to activeFields
// (the default path and the variant path), add dependsOn:
//
//   activeFields.push({
//     name: fieldName,
//     dataType:   variantData[r][2],
//     dataFormat: variantData[r][3],
//     lookupName: variantData[r][4],
//     dependsOn:  variantData[r][5] || null    // ← ADD THIS
//   });


// ── Replacement validation loop ───────────────────────────────
//
// Replace the existing variant.fields.forEach validation block
// (~lines 289–308) with the function below. Call it from
// buildExcelVariants after writing the headers:
//
//   applyFieldValidations(tempSs, tempSheet, dataSheet, variant.fields, lookupDataMaster);

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
  fields.forEach((f, i) => { fieldColMap[f.name] = i + 1; }); // 1-based

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

          // Build the INDIRECT formula:
          //   =INDIRECT(SUBSTITUTE(E2, " ", "_"))
          // where E is the parent column. The SUBSTITUTE handles parent values
          // with spaces (e.g., "General Management" → named range "General_Management").
          const parentColLetter = colToLetter(parentCol);
          const formula = `=INDIRECT(SUBSTITUTE(${parentColLetter}2," ","_"))`;

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
                  showCustomUi: true,  // show as dropdown
                  strict: false        // allow empty while parent is unselected
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


// ── Updated getLookupValues ───────────────────────────────────
// Replace the existing function with this version (fixed isActive check).

/**
 * Get distinct values for a specific dropdown lookup table.
 *
 * @param {Array<Array>} lookupData - The 2D array from the lookups sheet.
 * @param {string} tableName - The lookup table name to filter by.
 * @returns {Array<string>} Non-blank, active dropdown labels.
 */
function getLookupValues(lookupData, tableName) {
  const values = [];

  for (let i = 1; i < lookupData.length; i++) {
    const rowTableName = String(lookupData[i][0]).trim();
    const labelValue   = String(lookupData[i][2]).trim();

    if (rowTableName === tableName && isChecked(lookupData[i][4]) && labelValue !== '') {
      values.push(labelValue);
    }
  }

  return values;
}
