/**
 * Recipe sync — writes metadata to a Sheet, structured JSON to Drive.
 *
 * Designed as a container-bound script attached to a Google Sheet. The
 * active spreadsheet is the index; Drive holds the canonicalized recipe
 * code so it stays diffable.
 *
 * Setup (one-time):
 *   1. Set Script Properties:
 *        WORKATO_API_TOKEN
 *        WORKATO_BASE_URL          (optional; defaults to EU)
 *        RECIPE_DRIVE_FOLDER_ID    (folder where JSON files are written)
 *   2. Add this file plus workato_recipes.js and canonical_hash.js to the
 *      script project.
 *   3. Reload the sheet to pick up the custom menu.
 */

const RECIPE_SHEET_NAME = 'Recipes';
const RECIPE_HEADERS = [
  'id',
  'name',
  'folder_id',
  'running',
  'trigger_application',
  'action_applications',
  'step_count',
  'logical_hash',
  'last_run_at',
  'updated_at',
  'last_synced_at',
  'workato_link',
  'json_file'
];


/* -------------------------------------------------------------------------- */
/* Menu                                                                       */
/* -------------------------------------------------------------------------- */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Workato')
    .addItem('Sync recipes (metadata only)', 'syncRecipesMetadata')
    .addItem('Sync recipes (full structure)', 'syncRecipesFull')
    .addToUi();
}


/* -------------------------------------------------------------------------- */
/* Entry points                                                               */
/* -------------------------------------------------------------------------- */

/** Fast: metadata only, no per-recipe detail calls, no Drive writes. */
function syncRecipesMetadata() {
  const recipes = getStructuredRecipes(); // from workato_recipes.js
  writeSheet_(recipes, /* withCode */ false);
}

/** Full: detail call per recipe, canonical JSON written to Drive, hashes in sheet. */
function syncRecipesFull() {
  const recipes = getStructuredRecipes({ includeCode: true });
  writeSheet_(recipes, /* withCode */ true);
}


/* -------------------------------------------------------------------------- */
/* Sheet writer                                                               */
/* -------------------------------------------------------------------------- */

function writeSheet_(recipes, withCode) {
  const ss    = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(RECIPE_SHEET_NAME) || ss.insertSheet(RECIPE_SHEET_NAME);
  const baseUrl = (PropertiesService.getScriptProperties().getProperty('WORKATO_BASE_URL')
                   || 'https://app.eu.workato.com').replace(/\/$/, '');

  const folder  = withCode ? getOrThrowDriveFolder_() : null;
  const now     = new Date();

  const rows = recipes.map(function (r) {
    let stepCount    = '';
    let logicalHash  = '';
    let jsonFileLink = '';

    if (withCode && r.code) {
      stepCount   = countSteps_(r.code);
      logicalHash = recipeLogicalHash(r.code); // from canonical_hash.js
      const file  = writeRecipeJsonFile_(folder, r);
      jsonFileLink = `=HYPERLINK("${file.getUrl()}","${file.getName()}")`;
    }

    const workatoLink = `=HYPERLINK("${baseUrl}/recipes/${r.id}","open in Workato")`;

    return [
      r.id,
      r.name,
      r.folder_id,
      r.running,
      r.trigger_application || '',
      (r.action_applications || []).join(', '),
      stepCount,
      logicalHash,
      r.last_run_at || '',
      r.updated_at || '',
      now,
      workatoLink,
      jsonFileLink
    ];
  });

  // Reset and write everything in two range calls (fast).
  sheet.clear();
  sheet.getRange(1, 1, 1, RECIPE_HEADERS.length).setValues([RECIPE_HEADERS])
       .setFontWeight('bold');

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, RECIPE_HEADERS.length).setValues(rows);
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, RECIPE_HEADERS.length);

  SpreadsheetApp.getActive().toast(
    `Synced ${rows.length} recipes${withCode ? ' (with code)' : ''}`,
    'Workato sync',
    5
  );
}


/* -------------------------------------------------------------------------- */
/* Drive writer                                                               */
/* -------------------------------------------------------------------------- */

function getOrThrowDriveFolder_() {
  const id = PropertiesService.getScriptProperties().getProperty('RECIPE_DRIVE_FOLDER_ID');
  if (!id) {
    throw new Error('Set RECIPE_DRIVE_FOLDER_ID in Script Properties before running a full sync.');
  }
  return DriveApp.getFolderById(id);
}

/**
 * Write one canonicalized JSON file per recipe. Filename uses the recipe id
 * so re-syncing overwrites in place — keeps Drive version history intact.
 */
function writeRecipeJsonFile_(folder, recipe) {
  const filename = `recipe_${recipe.id}.json`;
  const payload  = canonicalJson({   // from canonical_hash.js
    id:                  recipe.id,
    name:                recipe.name,
    folder_id:           recipe.folder_id,
    trigger_application: recipe.trigger_application,
    action_applications: recipe.action_applications,
    code:                recipe.code,
    config:              recipe.config
  });

  const existing = folder.getFilesByName(filename);
  if (existing.hasNext()) {
    const file = existing.next();
    file.setContent(payload); // creates a new Drive revision
    return file;
  }
  return folder.createFile(filename, payload, MimeType.PLAIN_TEXT);
}


/* -------------------------------------------------------------------------- */
/* Tree helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Total number of step nodes in a recipe code tree (excludes the root trigger). */
function countSteps_(codeNode) {
  if (!codeNode || typeof codeNode !== 'object') return 0;
  let count = 0;
  const blocks = Array.isArray(codeNode.block) ? codeNode.block : [];
  for (let i = 0; i < blocks.length; i++) {
    count += 1 + countSteps_(blocks[i]);
  }
  return count;
}
