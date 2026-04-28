/**
 * Recipe sync — writes metadata to a Sheet, structured JSON to Drive.
 *
 * Container-bound. The single onOpen for the whole project lives here.
 *
 * Setup:
 *   - WORKATO_API_TOKEN          (script property)
 *   - WORKATO_BASE_URL           (optional, defaults to EU)
 *   - RECIPE_DRIVE_FOLDER_ID     (required for full sync)
 */


const RECIPE_SHEET_NAME = 'Recipes';
const RECIPE_HEADERS = [
  'id', 'name', 'folder_id', 'running',
  'trigger_application', 'action_applications',
  'step_count', 'logical_hash',
  'last_run_at', 'updated_at', 'last_synced_at',
  'workato_link', 'json_file'
];


/* -------------------------------------------------------------------------- */
/* Single onOpen for the whole project                                        */
/* -------------------------------------------------------------------------- */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Workato')
      .addItem('Sync recipes (metadata only)',     'syncRecipesMetadata')
      .addItem('Sync recipes (full structure)',    'syncRecipesFull')
      .addSeparator()
      .addItem('Measure trim (from cache)',        'measureTrimFromDrive')
      .addItem('Measure trim (refetch from API)',  'measureTrimAndWrite')
      .addItem('Write trimmed recipes to Drive',   'writeTrimmedRecipesToDrive')
      .addItem('Compare last two snapshots',       'compareLastTwoTrimSnapshots')
      .addSeparator()
      .addItem('Report Data Table operations',     'reportDataTableOps')
    .addToUi();
}


/* -------------------------------------------------------------------------- */
/* Sync entry points                                                          */
/* -------------------------------------------------------------------------- */

function syncRecipesMetadata() {
  const recipes = getStructuredRecipes();
  writeSheet_(recipes, /* withCode */ false);
}

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
      logicalHash = recipeLogicalHash(r.code);
      const file  = writeRecipeJsonFile_(folder, r);
      jsonFileLink = `=HYPERLINK("${file.getUrl()}","${file.getName()}")`;
    }

    const workatoLink = `=HYPERLINK("${baseUrl}/recipes/${r.id}","open in Workato")`;

    return [
      r.id, r.name, r.folder_id, r.running,
      r.trigger_application || '',
      (r.action_applications || []).join(', '),
      stepCount, logicalHash,
      r.last_run_at || '', r.updated_at || '', now,
      workatoLink, jsonFileLink
    ];
  });

  sheet.clear();
  sheet.getRange(1, 1, 1, RECIPE_HEADERS.length).setValues([RECIPE_HEADERS])
       .setFontWeight('bold');

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, RECIPE_HEADERS.length).setValues(rows);
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, RECIPE_HEADERS.length);

  ss.toast(
    `Synced ${rows.length} recipes${withCode ? ' (with code)' : ''}`,
    'Workato sync', 5
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


function writeRecipeJsonFile_(folder, recipe) {
  const filename = `recipe_${recipe.id}.json`;
  const payload  = canonicalJson({
    id:                  recipe.id,
    name:                recipe.name,
    folder_id:           recipe.folder_id,
    running:             recipe.running,
    description:         recipe.description,
    trigger_application: recipe.trigger_application,
    action_applications: recipe.action_applications,
    code:                recipe.code,
    config:              recipe.config
  });

  const existing = folder.getFilesByName(filename);
  if (existing.hasNext()) {
    const file = existing.next();
    file.setContent(payload);
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
