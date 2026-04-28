/**
 * Patch for recipe_drive_cache.js — replace writeTrimmedRecipesToDrive
 * with this version, and add the two helper functions below.
 *
 * Changes:
 *
 *   1. Each Drive op runs through withDriveRetry_, which catches transient
 *      "Service error: Drive" exceptions and retries with exponential
 *      backoff (1s, 2s, 4s — three attempts total).
 *
 *   2. If a trimmed file already exists and its content matches the new
 *      trimmed content, the write is skipped entirely. This makes the
 *      operation idempotent, resumable on partial failure, and cheap to
 *      re-run when only a few recipes changed.
 *
 *   3. The toast reports written / skipped / failed counts so a partial
 *      success is visible rather than masquerading as a clean run.
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
  const stats = { written: 0, skipped: 0, failed: 0 };
  const failures = [];

  recipes.forEach(function (recipe) {
    const filename = `trimmed_recipe_${recipe.id}.json`;
    const trimmed  = trimRecipe(recipe);
    const payload  = canonicalJson(trimmed);

    try {
      const result = withDriveRetry_(function () {
        return upsertTrimmedFile_(subfolder, filename, payload);
      });
      stats[result] += 1;   // 'written' or 'skipped'
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


/**
 * Create or update the trimmed file for one recipe.
 * Returns 'written' if the file was created or updated,
 * or 'skipped' if the existing content already matched.
 */
function upsertTrimmedFile_(folder, filename, payload) {
  const existing = folder.getFilesByName(filename);

  if (existing.hasNext()) {
    const file        = existing.next();
    const currentText = file.getBlob().getDataAsString();
    if (currentText === payload) return 'skipped';
    file.setContent(payload);   // new Drive revision
    return 'written';
  }

  folder.createFile(filename, payload, MimeType.PLAIN_TEXT);
  return 'written';
}


/**
 * Run a Drive operation with exponential-backoff retry on transient
 * service errors. Three attempts at 1s / 2s / 4s. Non-Drive errors
 * (auth, quota, validation) propagate immediately — only transient
 * service errors get retried.
 */
function withDriveRetry_(operation) {
  const delays = [1000, 2000, 4000];
  let lastErr;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return operation();
    } catch (err) {
      lastErr = err;
      if (!isTransientDriveError_(err) || attempt === delays.length) {
        throw err;
      }
      Utilities.sleep(delays[attempt]);
    }
  }

  throw lastErr;
}


function isTransientDriveError_(err) {
  const msg = String(err && err.message || err || '');
  // Apps Script reports these as "Service error: Drive" or generic 5xx.
  // We retry on transient signals only — never on auth/quota/validation.
  return /Service error: Drive/i.test(msg)
      || /backend error/i.test(msg)
      || /\b(500|502|503|504)\b/.test(msg)
      || /try again/i.test(msg);
}
