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
        // Write grouped columns + named ranges via SpreadsheetApp
        const result = writeDependentLookups(tempSs, dataSheet, lookupData, field.lookupName, lookupColTracker);

        if (result.count > 0) {
          lookupColTracker += result.count;

          // ── THE FIX ─────────────────────────────────────────
          // writeDependentLookups just created named ranges via
          // SpreadsheetApp. Those writes may still be queued.
          // The Sheets REST API (batchUpdate below) reads the
          // spreadsheet over a separate channel — it won't see
          // uncommitted SpreadsheetApp writes. Flush first.
          SpreadsheetApp.flush();
          // ────────────────────────────────────────────────────

          const parentColLetter = colToLetter(parentCol);
          const formula = `=INDIRECT(SUBSTITUTE(${parentColLetter}2," ","_"))`;

          Sheets.Spreadsheets.batchUpdate({
            requests: [{
              setDataValidation: {
                range: {
                  sheetId: tempSheet.getSheetId(),
                  startRowIndex: 1,
                  endRowIndex: 1 + DATA_ROWS,
                  startColumnIndex: col - 1,
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
          return;
        }
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
