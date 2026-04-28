/**
 * Recipe operations extractor — pure tree walk.
 *
 * Walks the recursive step tree and collects steps that match a predicate.
 * The default profile recognizes Workato Data Tables operations; the
 * walker is generic.
 *
 * Pure functions. No I/O.
 */


const DATA_TABLES_PROFILE = {
  // Match any step whose provider (lowercased) is in this set.
  // RUN inspectConnectorUsage() FIRST to verify these match your workspace.
  providerNames: ['workato_data_tables', 'data_tables'],

  // Action name → direction (lowercased).
  readActions:  ['search_records', 'lookup_record', 'list_records', 'get_record'],
  writeActions: ['create_record', 'update_record', 'upsert_record', 'delete_record',
                 'batch_create_records', 'batch_update_records', 'batch_delete_records'],

  // Input field names that carry the table reference. First match wins.
  tableIdKeys: ['data_table_id', 'table_id', 'data_table']
};


/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

function extractDataTableOps(recipe, profile) {
  profile = profile || DATA_TABLES_PROFILE;
  if (!recipe || !recipe.code) return [];

  const providerSet = toSet_(profile.providerNames);
  const readSet     = toSet_(profile.readActions);
  const writeSet    = toSet_(profile.writeActions);

  const matches = [];
  walkSteps_(recipe.code, '', function (node, path) {
    if (!isDataTableStep_(node, providerSet)) return;

    matches.push({
      recipe_id:   recipe.id,
      recipe_name: recipe.name,
      step_path:   path || '(root)',
      keyword:     node.keyword || null,
      provider:    node.provider || null,
      name:        node.name || null,
      direction:   classifyDirection_(node.name, readSet, writeSet),
      table_id:    extractTableId_(node, profile),
      input_keys:  node.input ? Object.keys(node.input) : []
    });
  });

  return matches;
}


function extractDataTableOpsBulk(recipes, profile) {
  const out = [];
  (recipes || []).forEach(function (r) {
    const ops = extractDataTableOps(r, profile);
    for (let i = 0; i < ops.length; i++) out.push(ops[i]);
  });
  return out;
}


/**
 * Generic walker. Pass any predicate.
 *
 * @param {Object}   recipe
 * @param {Function} predicate - (node) => boolean
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
/* Tree walker — exported for inspection helpers                              */
/* -------------------------------------------------------------------------- */

function walkSteps_(node, path, visit) {
  if (!node || typeof node !== 'object') return;

  visit(node, path);

  if (Array.isArray(node.block)) {
    for (let i = 0; i < node.block.length; i++) {
      walkSteps_(node.block[i], `${path}block[${i}].`, visit);
    }
  }
}


/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function toSet_(arr) {
  const s = {};
  (arr || []).forEach(function (v) { s[String(v).toLowerCase()] = true; });
  return s;
}


function isDataTableStep_(node, providerSet) {
  if (!node || !node.provider) return false;
  return !!providerSet[String(node.provider).toLowerCase()];
}


function classifyDirection_(actionName, readSet, writeSet) {
  if (!actionName) return null;
  const n = String(actionName).toLowerCase();
  if (readSet[n])  return 'read';
  if (writeSet[n]) return 'write';
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
