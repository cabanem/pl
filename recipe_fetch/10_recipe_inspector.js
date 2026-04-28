/**
 * Inspection helpers — diagnostic tools for tuning the extractor profile
 * against real data.
 *
 * If extractDataTableOpsBulk returns 0 matches when you expect matches,
 * the profile's provider names or action names don't line up with what's
 * in your recipes. Run inspectConnectorUsage() to see the truth.
 *
 * Run these from the Apps Script editor, not from the menu.
 *
 * Depends on: recipe_drive_cache.js, recipe_extractor.js (uses walkSteps_)
 */


/**
 * Show every distinct (provider, name) pair across cached recipes.
 * Logs to View → Logs and writes a "Connector Usage" sheet.
 *
 * THIS IS THE FIRST THING TO RUN when extraction returns nothing.
 */
function inspectConnectorUsage() {
  const recipes = loadRecipesFromDrive();
  if (recipes.length === 0) {
    Logger.log('No cached recipes. Run "Sync recipes (full structure)" first.');
    return;
  }

  const counts = {};

  recipes.forEach(function (recipe) {
    if (!recipe.code) return;
    walkSteps_(recipe.code, '', function (node) {
      if (!node || !node.provider) return;
      const key = `${node.provider}::${node.name || ''}`;
      counts[key] = (counts[key] || 0) + 1;
    });
  });

  const rows = Object.keys(counts)
    .map(function (k) {
      const parts = k.split('::');
      return { provider: parts[0], name: parts[1], count: counts[k] };
    })
    .sort(function (a, b) {
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return b.count - a.count;
    });

  Logger.log(`Found ${rows.length} distinct (provider, name) pairs across ${recipes.length} recipes.`);
  rows.forEach(function (r) {
    Logger.log(`  ${r.provider} :: ${r.name} (${r.count})`);
  });

  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('Connector Usage') || ss.insertSheet('Connector Usage');
  sheet.clear();
  sheet.getRange(1, 1, 1, 3).setValues([['provider', 'name', 'count']]).setFontWeight('bold');
  if (rows.length) {
    const data = rows.map(function (r) { return [r.provider, r.name, r.count]; });
    sheet.getRange(2, 1, data.length, 3).setValues(data);
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 3);
}


/**
 * For a specific provider, show input keys per action and their counts.
 *
 *   inspectProviderInputKeys('workato_data_tables')
 */
function inspectProviderInputKeys(providerName) {
  if (!providerName) {
    Logger.log('Pass a provider name. Example: inspectProviderInputKeys("workato_data_tables")');
    return;
  }

  const recipes = loadRecipesFromDrive();
  const seen    = {};

  recipes.forEach(function (recipe) {
    if (!recipe.code) return;
    walkSteps_(recipe.code, '', function (node) {
      if (!node || node.provider !== providerName) return;
      const action = node.name || '(no name)';
      if (!seen[action]) seen[action] = {};
      const keys = node.input ? Object.keys(node.input) : [];
      keys.forEach(function (k) { seen[action][k] = (seen[action][k] || 0) + 1; });
    });
  });

  const actions = Object.keys(seen).sort();
  if (actions.length === 0) {
    Logger.log(`No steps found with provider "${providerName}".`);
    return;
  }

  Logger.log(`Provider "${providerName}":`);
  actions.forEach(function (a) {
    Logger.log(`  ${a}:`);
    Object.keys(seen[a]).sort().forEach(function (k) {
      Logger.log(`    - ${k} (${seen[a][k]})`);
    });
  });
}


/**
 * Dump up to N full step samples for a provider.
 *
 *   inspectProviderSamples('workato_data_tables', 3)
 */
function inspectProviderSamples(providerName, limit) {
  limit = limit || 3;
  const recipes = loadRecipesFromDrive();
  let shown = 0;

  for (let i = 0; i < recipes.length && shown < limit; i++) {
    const recipe = recipes[i];
    if (!recipe.code) continue;

    walkSteps_(recipe.code, '', function (node, path) {
      if (shown >= limit) return;
      if (!node || node.provider !== providerName) return;

      Logger.log(`--- Sample ${shown + 1}: recipe ${recipe.id} (${recipe.name}) at ${path || '(root)'} ---`);
      Logger.log(JSON.stringify({
        keyword:  node.keyword,
        provider: node.provider,
        name:     node.name,
        input:    node.input
      }, null, 2));
      shown++;
    });
  }

  if (shown === 0) {
    Logger.log(`No steps found with provider "${providerName}".`);
  }
}
