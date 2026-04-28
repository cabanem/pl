/**
 * Recipe Drive cache — read-side operations on the canonical recipe JSON
 * files written by syncRecipesFull (recipe_sync.js).
 *
 * Lets the trim / measure / inspect loop run against locally-cached recipes
 * without spending Workato API bandwidth. After one full sync, all
 * subsequent trim tuning is free of UrlFetchApp quota cost.
 *
 * Files read:    recipe_{id}.json     (in RECIPE_DRIVE_FOLDER_ID)
 * Files written: trimmed_recipe_{id}.json
 *                (in {RECIPE_DRIVE_FOLDER_ID}/trimmed/ — for inspection)
 *
 * Setup:
 *   - Run "Sync recipes (full structure)" once to populate the cache.
 *   - All operations in this file then run on the cache.
 *
 * Depends on: recipe_sync.js (for getOrThrowDriveFolder_),
 *             recipe_trimmer.js, trim_measurement.js,
 *             trim_measurement_sheet.js, canonical_hash.js.
 *
 * Note on shape alignment:
 *   The cached recipe shape is whatever writeRecipeJsonFile_ chose to
 *   persist (currently: id, name, folder_id, trigger_application,
 *   action_applications, code, config). If you want additional envelope
 *   fields visible to the trim — e.g. description, running — extend the
 *   payload in recipe_sync.js. The trim measurement here works on
 *   whatever shape is in the cache.
 */


/* -------------------------------------------------------------------------- */
/* Public entry points (wire to menu)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Same outputs as measureTrimAndWrite, but reads recipes from Drive cache
 * instead of the Workato API. Zero bandwidth cost.
 */
function measureTrimFromDrive() {
  const recipes = loadRecipesFromDrive();
  if (recipes.length === 0) {
    SpreadsheetApp.getActive().toast(
      'No recipe_*.json files in cache. Run "Sync recipes (full structure)" first.',
      'Trim measurement', 5
    );
    return;
  }

  const report = measureTrimDistribution(recipes);
  const file   = saveTrimReportToDrive_(report);
  writeTrimLatestSheet_(report);
  appendTrimSnapshotRow_(report, file);

  SpreadsheetApp.getActive().toast(
    `Measured ${report.recipe_count} cached recipes — median ${report.reduction_pct.median}%`,
    'Trim measurement', 5
  );
}


/**
 * Trim every cached recipe and write the trimmed result to a "trimmed"
 * subfolder for visual inspection. Useful during empirical tuning — lets
 * you eyeball what the model would actually see, side by side with the
 * untrimmed source.
 */
function writeTrimmedRecipesToDrive() {
  const recipes = loadRecipesFromDrive();
  if (recipes.length === 0) {
    SpreadsheetApp.getActive().toast(
      'No recipe_*.json files in cache. Run "Sync recipes (full structure)" first.',
      'Trim', 5
    );
    return;
  }

  const subfolder = getOrCreateTrimmedSubfolder_();
  let written = 0;

  recipes.forEach(function (recipe) {
    const trimmed  = trimRecipe(recipe);
    const filename = `trimmed_recipe_${recipe.id}.json`;
    const payload  = canonicalJson(trimmed);

    const existing = subfolder.getFilesByName(filename);
    if (existing.hasNext()) {
      existing.next().setContent(payload);   // new Drive revision
    } else {
      subfolder.createFile(filename, payload, MimeType.PLAIN_TEXT);
    }
    written++;
  });

  SpreadsheetApp.getActive().toast(
    `Wrote ${written} trimmed recipes to "trimmed" subfolder.`,
    'Trim', 5
  );
}


/**
 * Convenience: read one cached recipe by id. Useful from the script editor
 * for ad-hoc inspection — e.g. trimRecipe(loadRecipeFromDrive('2006728')).
 */
function loadRecipeFromDrive(recipeId) {
  const folder   = getOrThrowDriveFolder_();
  const filename = `recipe_${recipeId}.json`;
  const files    = folder.getFilesByName(filename);
  if (!files.hasNext()) {
    throw new Error(`No cached recipe found: ${filename}`);
  }
  return JSON.parse(files.next().getBlob().getDataAsString());
}


/* -------------------------------------------------------------------------- */
/* Bulk read                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Read all recipe_*.json files from the cache folder.
 *
 * Returns recipes in the same shape as getStructuredRecipes({ includeCode: true })
 * — restricted to whatever fields writeRecipeJsonFile_ persists.
 *
 * @returns {Array<Object>}
 */
function loadRecipesFromDrive() {
  const folder  = getOrThrowDriveFolder_();
  const files   = folder.getFiles();
  const recipes = [];

  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    if (!/^recipe_.*\.json$/.test(name)) continue;

    try {
      const text = file.getBlob().getDataAsString();
      recipes.push(JSON.parse(text));
    } catch (err) {
      Logger.log(`Failed to parse ${name}: ${err.message}`);
    }
  }

  return recipes;
}


/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function getOrCreateTrimmedSubfolder_() {
  const parent   = getOrThrowDriveFolder_();
  const existing = parent.getFoldersByName('trimmed');
  return existing.hasNext() ? existing.next() : parent.createFolder('trimmed');
}


/* -------------------------------------------------------------------------- */
/* onOpen update — paste this over the existing onOpen in recipe_sync.js      */
/* -------------------------------------------------------------------------- */
//
// function onOpen() {
//   SpreadsheetApp.getUi()
//     .createMenu('Workato')
//       .addItem('Sync recipes (metadata only)',   'syncRecipesMetadata')
//       .addItem('Sync recipes (full structure)',  'syncRecipesFull')
//       .addSeparator()
//       .addItem('Measure trim (from cache)',      'measureTrimFromDrive')
//       .addItem('Measure trim (refetch from API)','measureTrimAndWrite')
//       .addItem('Write trimmed recipes to Drive', 'writeTrimmedRecipesToDrive')
//       .addItem('Compare last two snapshots',     'compareLastTwoTrimSnapshots')
//     .addToUi();
// }
