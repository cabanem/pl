Right — the elegant move here is **a single source of truth for the payload**. If the mock and the real write don't go through the same code path, the mock is by definition a guess. Once they share the function, "true rendering" comes for free.

Here's the shape of the change:

**1. Have `getMondaySchema_` keep the column type and title.** You're already fetching `type` from the API and discarding it. Keep it:

```javascript
function getMondaySchema_(boardId) {
  const query = `query { boards (ids: ${boardId}) { columns { id title type } } }`;
  const response = mondayRequest_(query, `Schema:${boardId}`);
  const columns = response.data?.boards?.[0]?.columns;
  if (!columns) throw new Error(`Could not fetch columns for board ${boardId}.`);

  const schema = {};
  columns.forEach(col => {
    schema[col.title.toLowerCase().trim()] = { id: col.id, type: col.type, title: col.title };
  });
  return schema;
}
```

**2. Make `validateHeaders_` bidirectional and richer.** Two changes: read from the new schema shape, and add the reverse pass that surfaces Monday columns with no sheet source. The mapping sheet now answers three questions per row, not one.

```javascript
function validateHeaders_(sheetHeaders, mondaySchema, config, tag) {
  const mapping = {};
  const missingInMonday = [];
  const outputMap = [['Sheets Header', 'Monday Title', 'Monday Column ID', 'Monday Type', 'Status']];

  let nameIndex = sheetHeaders.findIndex(h => {
    const norm = String(h).toLowerCase().trim();
    return norm === 'name' || norm === 'item name';
  });
  if (nameIndex === -1) nameIndex = 0;
  mapping._nameIndex = nameIndex;

  const matchedMondayKeys = new Set();

  sheetHeaders.forEach((header, index) => {
    const normHeader = String(header).toLowerCase().trim();
    if (!normHeader) return;

    if (index === nameIndex) {
      outputMap.push([header, '(Item Name)', '—', 'name', '✓ Mapped to item name']);
      return;
    }

    const mondayCol = mondaySchema[normHeader];
    if (mondayCol) {
      mapping[index] = mondayCol.id; // keep flat shape so writeToMonday_ stays simple
      matchedMondayKeys.add(normHeader);
      outputMap.push([header, mondayCol.title, mondayCol.id, mondayCol.type, '✓ Mapped']);
    } else {
      missingInMonday.push(header);
      outputMap.push([header, '—', '—', '—', '❌ Sheet column has no match — DATA WILL BE DROPPED']);
    }
  });

  // Reverse pass: Monday columns with no sheet source.
  // These are the silent killers — they go blank after truncate with zero warning today.
  const unmatchedMonday = [];
  Object.keys(mondaySchema).forEach(key => {
    if (matchedMondayKeys.has(key)) return;
    const col = mondaySchema[key];
    unmatchedMonday.push(col);
    outputMap.push(['—', col.title, col.id, col.type, '⚠ Monday column has no source — WILL BE BLANK AFTER WRITEBACK']);
  });

  let mapSheet;
  if (config.staging_mapping_tab_name) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    mapSheet = ss.getSheetByName(config.staging_mapping_tab_name);
    if (!mapSheet) mapSheet = ss.insertSheet(config.staging_mapping_tab_name);
    mapSheet.clear();
    mapSheet.getRange(1, 1, outputMap.length, outputMap[0].length).setValues(outputMap);
    mapSheet.getRange(1, 1, 1, outputMap[0].length).setFontWeight('bold').setBackground('#efefef');
    mapSheet.autoResizeColumns(1, outputMap[0].length);
  }

  return { mapping, missing: missingInMonday, unmatchedMonday, mapSheet };
}
```

**3. Extract `buildColumnValues_` — the single source of truth.** This is the load-bearing piece. Both the real write and the mock now produce the exact same object.

```javascript
function buildColumnValues_(row, mapping) {
  const columnValues = {};
  Object.keys(mapping).forEach(sheetIndex => {
    if (sheetIndex === '_nameIndex') return;
    const colId = mapping[sheetIndex];
    let value = row[sheetIndex];

    if (Object.prototype.toString.call(value) === '[object Date]') {
      value = !isNaN(value.getTime())
        ? Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : '';
    }

    if (value !== '' && value != null) {
      columnValues[colId] = String(value);
    }
  });
  return columnValues;
}
```

**4. `writeToMonday_` now delegates to it** (this is just a swap, behavior is identical):

```javascript
function writeToMonday_(boardId, data, mapping, tag) {
  const rows = data.slice(1);
  let successCount = 0;

  for (const row of rows) {
    const itemName = String(row[mapping._nameIndex] || 'Untitled Item').replace(/"/g, '\\"');
    const columnValues = buildColumnValues_(row, mapping);
    const escapedColVals = JSON.stringify(JSON.stringify(columnValues));

    const mutation = `
      mutation {
        create_item (
          board_id: ${boardId},
          item_name: "${itemName}",
          column_values: ${escapedColVals}
        ) { id }
      }
    `;

    try {
      mondayRequest_(mutation, tag);
      successCount++;
    } catch (e) {
      logToAuditSheet('ERROR', `Failed to write item "${itemName}": ${e.message}`, tag);
    }
  }

  logToAuditSheet('INFO', `Successfully pushed ${successCount} out of ${rows.length} rows to Monday.`, tag);
}
```

**5. `generateMockPayloadSheet_` becomes a full ledger, not a projection.** Every sheet column appears (mapped or dropped). Every unmatched Monday column appears as a "will be blank" column. The final column is the literal JSON payload Monday will receive — produced by `buildColumnValues_`, so it cannot lie.

```javascript
function generateMockPayloadSheet_(data, mapping, mondaySchema, validation) {
  const sheetHeaders = data[0];
  const rows = data.slice(1);

  const headerRow = ['Item Name'];
  const subHeaderRow = ['(built-in)'];
  const sheetColRenderOrder = [];

  // All sheet columns — mapped and unmapped
  sheetHeaders.forEach((header, idx) => {
    if (idx === mapping._nameIndex) return;
    if (!String(header).trim()) return;
    sheetColRenderOrder.push(idx);

    if (mapping[idx]) {
      const normKey = String(header).toLowerCase().trim();
      const mondayCol = mondaySchema[normKey];
      headerRow.push(`${mondayCol.title}\n[${mondayCol.type}]`);
      subHeaderRow.push(`Monday ID: ${mondayCol.id}\n← from "${header}"`);
    } else {
      headerRow.push(`⚠ ${header}`);
      subHeaderRow.push('DROPPED — no Monday match');
    }
  });

  // Monday columns with no sheet source
  validation.unmatchedMonday.forEach(col => {
    headerRow.push(`${col.title}\n[${col.type}]`);
    subHeaderRow.push(`Monday ID: ${col.id}\n⚠ BLANK — no sheet source`);
  });

  // The truth column: actual JSON sent to Monday
  headerRow.push('Actual JSON payload');
  subHeaderRow.push('(what column_values receives)');

  const outputData = [headerRow, subHeaderRow];

  for (const row of rows) {
    const outRow = [String(row[mapping._nameIndex] || 'Untitled Item')];

    sheetColRenderOrder.forEach(idx => {
      let value = row[idx];
      if (Object.prototype.toString.call(value) === '[object Date]') {
        value = !isNaN(value.getTime())
          ? Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : '';
      }
      outRow.push(value !== '' && value != null ? String(value) : '');
    });

    validation.unmatchedMonday.forEach(() => outRow.push('(blank)'));

    // Single source of truth — same call writeToMonday_ uses
    outRow.push(JSON.stringify(buildColumnValues_(row, mapping)));
    outputData.push(outRow);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mockTabName = '.dry_run_payload';
  let mockSheet = ss.getSheetByName(mockTabName);
  if (!mockSheet) mockSheet = ss.insertSheet(mockTabName);
  mockSheet.clear();
  mockSheet.getRange(1, 1, outputData.length, outputData[0].length).setValues(outputData);

  mockSheet.getRange(1, 1, 1, outputData[0].length).setFontWeight('bold').setBackground('#fff2cc');
  mockSheet.getRange(2, 1, 1, outputData[0].length).setFontStyle('italic').setBackground('#fef7e0');

  // Color the problem columns so a glance is enough
  let col = 2;
  sheetColRenderOrder.forEach(idx => {
    if (!mapping[idx]) {
      mockSheet.getRange(1, col, outputData.length, 1).setBackground('#fce5cd'); // dropped
    }
    col++;
  });
  validation.unmatchedMonday.forEach(() => {
    mockSheet.getRange(1, col, outputData.length, 1).setBackground('#f4cccc'); // blank
    col++;
  });

  mockSheet.setFrozenRows(2);
  mockSheet.setFrozenColumns(1);
  mockSheet.autoResizeColumns(1, outputData[0].length);
  return mockSheet;
}
```

**6. One-line wiring change in `runDryRun`** — pass the schema and the whole validation result through:

```javascript
const mockSheet = generateMockPayloadSheet_(data, validation.mapping, mondaySchema, validation);
```

---

What you get from this: the dry run tab now reads left-to-right as "here's every sheet column, here's every Monday column that won't get fed, here's the literal JSON we'll send." Nothing is hidden because nothing is filtered — every column on both sides has a place in the grid, and the problematic ones are color-coded so a five-second glance tells your colleague whether to proceed.

The one thing this *still* won't tell you the truth about: typed Monday columns (status, date, dropdown, etc.) need structured JSON, not strings — and `buildColumnValues_` currently stringifies everything. The mock will now honestly show you `{"status_col": "Done"}` going out the door, and Monday will silently ignore it. The `[type]` annotation in the header row at least flags which columns are at risk. Fixing that is a separate, contained change in `buildColumnValues_` — happy to layer it on if your colleague's board has typed columns, but it's worth doing only after this dry run is in their hands and they can tell you which types actually appear.


```javascript
function stageIncumbentData_(config) {
  if (!config.incumbent_file_id || !config.incumbent_tab_name) {
    throw new Error('Missing incumbent file ID or tab name in configuration.');
  }

  // 1-indexed row where headers live. Defaults to 1 for back-compat.
  // Set to 2 when row 1 is a banner/title and row 2 holds the actual headers.
  const headerRow = Number(config.incumbent_header_row) || 1;

  const sourceFile = SpreadsheetApp.openById(config.incumbent_file_id);
  const sourceSheet = sourceFile.getSheetByName(config.incumbent_tab_name);
  if (!sourceSheet) throw new Error(`Tab "${config.incumbent_tab_name}" not found in external Incumbent file.`);

  const raw = sourceSheet.getDataRange().getValues();

  if (raw.length < headerRow) {
    throw new Error(`Source has ${raw.length} row(s) but incumbent_header_row=${headerRow}. Nothing to read.`);
  }

  // Drop everything above the header row. After this, data[0] = headers, data[1+] = rows.
  const data = raw.slice(headerRow - 1);

  // Staging mirrors what the pipeline actually processes — not the raw source.
  // (If you ever want raw fidelity for debugging, open the source file directly.)
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stagingName = config.staging_new_tab_name || '.staging_incumbent';
  let stagingSheet = ss.getSheetByName(stagingName);
  if (!stagingSheet) stagingSheet = ss.insertSheet(stagingName);

  stagingSheet.clear();
  if (data.length > 0) {
    stagingSheet.getRange(1, 1, data.length, data[0].length).setValues(data);
  }

  return data;
}
```
