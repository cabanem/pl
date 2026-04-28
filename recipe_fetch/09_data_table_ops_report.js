/**
 * Data Tables operations report.
 *
 * Reads recipes from Drive cache (no API bandwidth), runs the pure
 * extractor, joins against the data-table inventory by id, writes a
 * single sheet you can sort and filter.
 *
 * Depends on: workato_recipes.js (replicateTableDiscovery),
 *             recipe_drive_cache.js, recipe_extractor.js
 */


const DT_OPS_SHEET = 'Data Table Ops';
const DT_OPS_HEADERS = [
  'recipe_id', 'recipe_name', 'step_path',
  'keyword', 'provider', 'name', 'direction',
  'table_id', 'table_name', 'input_keys'
];


/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

function reportDataTableOps() {
  const recipes = loadRecipesFromDrive();
  if (recipes.length === 0) {
    SpreadsheetApp.getActive().toast(
      'No cached recipes. Run "Sync recipes (full structure)" first.',
      'Data Table Ops', 5
    );
    return;
  }

  const ops = extractDataTableOpsBulk(recipes);

  if (ops.length === 0) {
    SpreadsheetApp.getActive().toast(
      'No Data Tables operations matched the profile. Run inspectConnectorUsage() to see actual provider names.',
      'Data Table Ops', 8
    );
    // Still write an empty sheet so the column headers are visible.
    writeDataTableOpsSheet_([]);
    return;
  }

  const tableNameById = buildTableNameIndex_();

  const enriched = ops.map(function (op) {
    return Object.assign({}, op, {
      table_name: op.table_id ? (tableNameById[op.table_id] || '(unknown)') : ''
    });
  });

  writeDataTableOpsSheet_(enriched);

  SpreadsheetApp.getActive().toast(
    `Found ${enriched.length} Data Tables operations across ${recipes.length} recipes.`,
    'Data Table Ops', 5
  );
}


/* -------------------------------------------------------------------------- */
/* Reference resolution                                                       */
/* -------------------------------------------------------------------------- */

function buildTableNameIndex_() {
  const tables = replicateTableDiscovery();
  const idx = {};
  tables.forEach(function (t) {
    if (t && t.id) idx[t.id] = t.name || '(unnamed)';
  });
  return idx;
}


/* -------------------------------------------------------------------------- */
/* Sheet writer                                                               */
/* -------------------------------------------------------------------------- */

function writeDataTableOpsSheet_(ops) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(DT_OPS_SHEET) || ss.insertSheet(DT_OPS_SHEET);

  sheet.clear();
  sheet.getRange(1, 1, 1, DT_OPS_HEADERS.length)
       .setValues([DT_OPS_HEADERS]).setFontWeight('bold');

  if (ops.length) {
    const rows = ops.map(function (op) {
      return [
        op.recipe_id, op.recipe_name, op.step_path,
        op.keyword, op.provider, op.name, op.direction || '',
        op.table_id || '', op.table_name || '',
        (op.input_keys || []).join(', ')
      ];
    });
    sheet.getRange(2, 1, rows.length, DT_OPS_HEADERS.length).setValues(rows);
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, DT_OPS_HEADERS.length);
}
