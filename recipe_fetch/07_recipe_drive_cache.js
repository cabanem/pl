/**
 * Recipe Drive cache — read-side operations on canonical recipe JSON.
 *
 * After one full sync, all subsequent trim / measure / extract operations
 * run against the Drive cache without API bandwidth cost.
 *
 * Depends on: recipe_sync.js, recipe_trimmer.js, canonical_hash.js,
 *             trim_measurement.js, trim_measurement_sheet.js
 */


/* -------------------------------------------------------------------------- */
/* Public entry points (wired in recipe_sync.js onOpen)                       */
/* -------------------------------------------------------------------------- */

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
  const stats     = { written: 0, skipped: 0, failed: 0 };
  const failures  = [];

  recipes.forEach(function (recipe) {
    const filename = `trimmed_recipe_${recipe.id}.json`;
    const trimmed  = trimRecipe(recipe);
    const payload  = canonicalJson(trimmed);

    try {
      const result = withDriveRetry_(function () {
        return upsertTrimmedFile_(subfolder, filename, payload);
      });
      stats[result] += 1;
    } catch (err) {
      stats.failed += 1;
      failures.push(`${recipe.id}: ${err.message}`);
      Logger.log(`Failed to write ${filename}: ${err.message}`);
    }
  });

  let msg = `Trimmed: ${stats.written} written, ${stats.skipped} unchanged`;
  if (stats.failed) msg += `, ${stats.failed} failed (see Logs)`;
  SpreadsheetApp.getActive().toast(msg, 'Trim', 8);
}


/** Read one cached recipe by id. For ad-hoc work in the script editor. */
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
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function getOrCreateTrimmedSubfolder_() {
  const parent   = getOrThrowDriveFolder_();
  const existing = parent.getFoldersByName('trimmed');
  return existing.hasNext() ? existing.next() : parent.createFolder('trimmed');
}


function upsertTrimmedFile_(folder, filename, payload) {
  const existing = folder.getFilesByName(filename);

  if (existing.hasNext()) {
    const file        = existing.next();
    const currentText = file.getBlob().getDataAsString();
    if (currentText === payload) return 'skipped';
    file.setContent(payload);
    return 'written';
  }

  folder.createFile(filename, payload, MimeType.PLAIN_TEXT);
  return 'written';
}


function withDriveRetry_(operation) {
  const delays = [1000, 2000, 4000];
  let lastErr;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return operation();
    } catch (err) {
      lastErr = err;
      if (!isTransientDriveError_(err) || attempt === delays.length) throw err;
      Utilities.sleep(delays[attempt]);
    }
  }

  throw lastErr;
}


function isTransientDriveError_(err) {
  const msg = String(err && err.message || err || '');
  return /Service error: Drive/i.test(msg)
      || /backend error/i.test(msg)
      || /\b(500|502|503|504)\b/.test(msg)
      || /try again/i.test(msg);
}
