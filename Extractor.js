/**
 * Recipe operations extractor — pure tree walk over recipe `code`.
 *
 * Walks the recursive step tree and collects steps that match a predicate.
 * The default profile recognizes Workato Data Tables operations and
 * classifies each as a read or a write, but the walker is generic — pass
 * a different profile to extract Salesforce ops, HTTP calls, sub-recipe
 * references, or anything else with a stable (provider, name) signature.
 *
 * Pure functions. No I/O. Operates on the same recipe shape returned by
 * getStructuredRecipes({ includeCode: true }) and survives trim_recipe.
 *
 * Output shape per match:
 *   {
 *     recipe_id, recipe_name,           // for joining back to inventory
 *     step_path:  "block[0].block[2]",  // structural address inside code
 *     keyword:    "action" | "trigger",
 *     provider:   "workato_data_tables",
 *     name:       "search_records",
 *     direction:  "read" | "write" | null,
 *     table_id:   "184edd5e-...",       // null if not extractable
 *     input_keys: ["data_table_id", "where", ...]   // top-level input keys
 *   }
 */


/* -------------------------------------------------------------------------- */
/* Profile config — single edit surface for what counts as a "match"          */
/* -------------------------------------------------------------------------- */

const DATA_TABLES_PROFILE = {
  // Match any step whose provider is in this set.
  providers: new Set(['workato_data_tables', 'data_tables']),

  // Action name → direction. Anything not listed gets direction: null.
  // (Add custom connector actions here when you extract from custom-built
  // Data Tables operations.)
  reads:  new Set(['search_records', 'lookup_record', 'list_records', 'get_record']),
  writes: new Set(['create_record', 'update_record', 'upsert_record', 'delete_record',
                   'batch_create_records', 'batch_update_records', 'batch_delete_records']),

  // Input field names that carry the table reference. Checked in order;
  // first match wins. The connector has used different names across
  // versions — be tolerant.
  tableIdKeys: ['data_table_id', 'table_id', 'data_table']
};


/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Extract Data Tables operations from a single recipe.
 *
 * @param {Object} recipe - structured recipe (output of getStructuredRecipes)
 * @param {Object} [profile=DATA_TABLES_PROFILE]
 * @returns {Array<Object>}
 */
function extractDataTableOps(recipe, profile) {
  profile = profile || DATA_TABLES_PROFILE;
  if (!recipe || !recipe.code) return [];

  const matches = [];
  walkSteps_(recipe.code, '', function (node, path) {
    if (!isDataTableStep_(node, profile)) return;

    matches.push({
      recipe_id:   recipe.id,
      recipe_name: recipe.name,
      step_path:   path || '(root)',
      keyword:     node.keyword || null,
      provider:    node.provider || null,
      name:        node.name || null,
      direction:   classifyDirection_(node.name, profile),
      table_id:    extractTableId_(node, profile),
      input_keys:  node.input ? Object.keys(node.input) : []
    });
  });

  return matches;
}


/**
 * Extract from a list of recipes. Returns a flat array suitable for
 * writing to a Sheet or joining against a data-table inventory.
 *
 * @param {Array<Object>} recipes
 * @returns {Array<Object>}
 */
function extractDataTableOpsBulk(recipes, profile) {
  const out = [];
  (recipes || []).forEach(function (r) {
    const ops = extractDataTableOps(r, profile);
    for (let i = 0; i < ops.length; i++) out.push(ops[i]);
  });
  return out;
}


/**
 * Generic walker — pass any predicate to extract whatever you want.
 * Useful for ad-hoc queries: "every HTTP call", "every sub-recipe call",
 * "every step using connection X".
 *
 * @param {Object}   recipe
 * @param {Function} predicate - (node) => boolean
 * @returns {Array<{recipe_id, recipe_name, step_path, node}>}
 */
function extractStepsMatching(recipe, predicate) {
  if (!recipe || !recipe.code) return [];
  const out = [];
  walkSteps_(recipe.code, '', function (node, path) {
    if (predicate(node)) {
      out.push({
        recipe_id:   recipe.id,
        recipe_name: recipe.name,
        step_path:   path || '(root)',
        node:        node
      });
    }
  });
  return out;
}


/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Depth-first walk over the step tree. Visits every node (including the
 * root trigger) and tracks a structural path string for traceability.
 */
function walkSteps_(node, path, visit) {
  if (!node || typeof node !== 'object') return;

  visit(node, path);

  if (Array.isArray(node.block)) {
    for (let i = 0; i < node.block.length; i++) {
      walkSteps_(node.block[i], `${path}block[${i}].`, visit);
    }
  }
}


function isDataTableStep_(node, profile) {
  if (!node || !node.provider) return false;
  return profile.providers.has(String(node.provider).toLowerCase());
}


function classifyDirection_(actionName, profile) {
  if (!actionName) return null;
  const n = String(actionName).toLowerCase();
  if (profile.reads.has(n))  return 'read';
  if (profile.writes.has(n)) return 'write';
  return null;
}


function extractTableId_(node, profile) {
  if (!node || !node.input) return null;
  const input = node.input;

  for (let i = 0; i < profile.tableIdKeys.length; i++) {
    const key = profile.tableIdKeys[i];
    if (input.hasOwnProperty(key) && input[key] != null && input[key] !== '') {
      return String(input[key]);
    }
  }
  return null;
}



// ops rep

/**
 * Data Tables operations report — extracts every Data Tables read/write
 * across cached recipes, joins against the data-table inventory by id,
 * writes a single sheet you can sort and filter.
 *
 * Reads from Drive cache (no API calls for recipes). Calls Workato once
 * for the table inventory (cheap — one paginated list, no per-table
 * detail).
 *
 * Sheet written: "Data Table Ops"
 *
 * Depends on: workato_recipes.js (uses replicateTableDiscovery — already
 *             in your codebase — to fetch the table inventory),
 *             recipe_drive_cache.js, recipe_extractor.js.
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

  // Static extraction — pure, no I/O.
  const ops = extractDataTableOpsBulk(recipes);

  // Reference resolution — single API call for the inventory.
  const tableNameById = buildTableNameIndex_();

  // Join.
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

/**
 * One Workato API call to build a {table_id: table_name} lookup.
 * Reuses replicateTableDiscovery from your existing codebase.
 */
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
  const sheet = SpreadsheetApp.getActive().getSheetByName(DT_OPS_SHEET)
             || SpreadsheetApp.getActive().insertSheet(DT_OPS_SHEET);

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


/* -------------------------------------------------------------------------- */
/* onOpen update — add this menu item to the existing onOpen                  */
/* -------------------------------------------------------------------------- */
//
// .addItem('Report Data Table operations', 'reportDataTableOps')
