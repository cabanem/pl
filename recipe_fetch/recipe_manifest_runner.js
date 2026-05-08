/**
 * Recipe manifest — sheet-driven entry point.
 *
 * Bridges the menu (zero-arg) to the pure builder (recipes + notes) by
 * reading the active sheet. Any sheet whose name starts with "Manifest:"
 * is recognized as a manifest sheet — new manifests are new sheets.
 *
 * Workflow:
 *   1. "Initialize manifest sheet" creates a fresh "Manifest: <name>" sheet
 *      with headers and a checkbox column for `included`.
 *   2. User fills in recipe_ids (one per row), optionally adds notes and
 *      unchecks rows to exclude them.
 *   3. With the manifest sheet active, "Generate manifest from active sheet"
 *      reads rows, validates against the cache, calls buildRecipeManifest,
 *      writes the envelope to Drive, and stamps the per-row metadata.
 *
 * Drive output:
 *   {RECIPE_DRIVE_FOLDER_ID}/manifests/manifest_{slug}_{timestamp}.json
 *
 * Depends on: recipe_manifest.js, recipe_drive_cache.js, recipe_sync.js
 *             (uses getOrThrowDriveFolder_), canonical_hash.js
 *
 * Menu wiring (add to onOpen in recipe_sync.js):
 *   .addSeparator()
 *   .addItem('Initialize manifest sheet',          'initManifestSheet')
 *   .addItem('Generate manifest from active sheet', 'generateManifestFromActiveSheet')
 *   .addItem('Re-generate all manifest sheets',     'regenerateAllManifestSheets')
 */


const MANIFEST_SHEET_PREFIX = 'Manifest: ';
const MANIFEST_HEADERS = [
  'recipe_id',          // user-authored, required
  'recipe_name',        // stamped from cache on run
  'notes',              // user-authored, optional
  'included',           // checkbox, default TRUE
  'trimmed_hash',       // stamped on run
  'trimmed_bytes',      // stamped on run
  'last_generated_at',  // stamped on run
  'error'               // stamped on run if this row failed
];


/* -------------------------------------------------------------------------- */
/* Public entry points                                                        */
/* -------------------------------------------------------------------------- */

function initManifestSheet() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'New manifest',
    'Manifest name (e.g. "SDC base review"):',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() !== ui.Button.OK) return;

  const rawName = String(response.getResponseText() || '').trim();
  if (!rawName) {
    ui.alert('Manifest name is required.');
    return;
  }

  const ss = SpreadsheetApp.getActive();
  const sheetName = MANIFEST_SHEET_PREFIX + rawName;

  if (ss.getSheetByName(sheetName)) {
    ui.alert(`A sheet named "${sheetName}" already exists.`);
    return;
  }

  const sheet = ss.insertSheet(sheetName);
  sheet.getRange(1, 1, 1, MANIFEST_HEADERS.length)
       .setValues([MANIFEST_HEADERS])
       .setFontWeight('bold');
  sheet.setFrozenRows(1);

  // Checkbox validation on `included`. Default TRUE for new rows means
  // adding a recipe id is sufficient — no extra click to opt in.
  const includedCol = MANIFEST_HEADERS.indexOf('included') + 1;
  sheet.getRange(2, includedCol, sheet.getMaxRows() - 1, 1)
       .setDataValidation(SpreadsheetApp.newDataValidation()
                           .requireCheckbox().build());

  // Plain-text format on notes so JSON / brackets / equals signs survive.
  const notesCol = MANIFEST_HEADERS.indexOf('notes') + 1;
  sheet.getRange(2, notesCol, sheet.getMaxRows() - 1, 1)
       .setNumberFormat('@');

  sheet.autoResizeColumns(1, MANIFEST_HEADERS.length);
  ss.setActiveSheet(sheet);
  ss.toast(`Created "${sheetName}". Add recipe ids and run.`, 'Manifest', 5);
}


function generateManifestFromActiveSheet() {
  const ss          = SpreadsheetApp.getActive();
  const activeSheet = ss.getActiveSheet();

  if (!isManifestSheet_(activeSheet)) {
    ss.toast(
      `Switch to a "${MANIFEST_SHEET_PREFIX}…" sheet, then re-run.`,
      'Manifest', 6
    );
    return;
  }

  const result = generateManifestForSheet_(activeSheet);
  ss.toast(
    `${result.manifestName}: ${result.includedCount} recipes → ${result.fileName}` +
      (result.missingCount ? ` (${result.missingCount} missing)` : ''),
    'Manifest', 8
  );
}


function regenerateAllManifestSheets() {
  const ss = SpreadsheetApp.getActive();
  const sheets = ss.getSheets().filter(isManifestSheet_);

  if (sheets.length === 0) {
    ss.toast('No manifest sheets found.', 'Manifest', 5);
    return;
  }

  let succeeded = 0, failed = 0;
  sheets.forEach(function (sheet) {
    try {
      generateManifestForSheet_(sheet);
      succeeded++;
    } catch (err) {
      failed++;
      Logger.log(`Manifest "${sheet.getName()}" failed: ${err.message}`);
    }
  });

  ss.toast(
    `Regenerated ${succeeded} manifest${succeeded === 1 ? '' : 's'}` +
      (failed ? `, ${failed} failed (see Logs)` : ''),
    'Manifest', 6
  );
}


/* -------------------------------------------------------------------------- */
/* Core                                                                       */
/* -------------------------------------------------------------------------- */

function generateManifestForSheet_(sheet) {
  const manifestName = sheet.getName().substring(MANIFEST_SHEET_PREFIX.length);
  const rows = readManifestRows_(sheet);
  const includedRows = rows.filter(function (r) { return r.included !== false; });

  if (includedRows.length === 0) {
    throw new Error(`Manifest "${manifestName}" has no included rows.`);
  }

  // Resolve recipes from the Drive cache.
  const cache = loadRecipesFromDrive();
  const requestedIds = includedRows.map(function (r) { return String(r.recipe_id); });
  const resolvedRecipes = selectRecipesByIds(cache, requestedIds);

  // Build per-recipe notes map and the requested-id list (for missing detection).
  const notesById = {};
  includedRows.forEach(function (r) {
    if (r.notes) notesById[String(r.recipe_id)] = r.notes;
  });

  // Pure build.
  const envelope = buildRecipeManifest({
    name:         manifestName,
    recipes:      resolvedRecipes,
    notesById:    notesById,
    requestedIds: requestedIds
  });

  // Persist.
  const file = saveManifestToDrive_(manifestName, envelope);

  // Stamp per-row metadata.
  stampManifestRows_(sheet, rows, envelope, file);

  return {
    manifestName:  manifestName,
    includedCount: envelope.recipe_count,
    missingCount:  envelope.recipes_missing.length,
    fileName:      file.getName()
  };
}


/* -------------------------------------------------------------------------- */
/* Sheet IO                                                                   */
/* -------------------------------------------------------------------------- */

function isManifestSheet_(sheet) {
  if (!sheet) return false;
  return sheet.getName().indexOf(MANIFEST_SHEET_PREFIX) === 0;
}


/**
 * Read every data row from a manifest sheet, returning typed objects.
 * Includes row numbers so the stamper can write back to the same row.
 */
function readManifestRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, MANIFEST_HEADERS.length).getValues();
  const rows = [];

  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    const row = { _row: i + 2 };
    MANIFEST_HEADERS.forEach(function (h, j) { row[h] = raw[j]; });

    // Skip entirely empty rows.
    if (!row.recipe_id || String(row.recipe_id).trim() === '') continue;

    // Default `included` to true for rows where it's blank (e.g. user just
    // typed an id and didn't touch the checkbox yet).
    if (row.included === '' || row.included === null || row.included === undefined) {
      row.included = true;
    }

    rows.push(row);
  }

  return rows;
}


/**
 * Stamp recipe_name, trimmed_hash, trimmed_bytes, last_generated_at, error
 * back into the manifest sheet. Excluded rows get cleared stamps; included
 * rows get either the resolved values or an error string.
 */
function stampManifestRows_(sheet, rows, envelope, file) {
  const now = new Date();
  const byId = {};
  envelope.recipes.forEach(function (e) { byId[String(e.id)] = e; });
  const missingSet = {};
  envelope.recipes_missing.forEach(function (id) { missingSet[String(id)] = true; });

  // Map header → column index for cleaner writes.
  const col = {};
  MANIFEST_HEADERS.forEach(function (h, i) { col[h] = i + 1; });

  rows.forEach(function (row) {
    const id = String(row.recipe_id);
    const entry = byId[id];

    // Always clear prior error before re-stamping.
    sheet.getRange(row._row, col.error).setValue('');

    if (row.included === false) {
      // Excluded rows: clear stamps so the sheet doesn't show stale data.
      sheet.getRange(row._row, col.recipe_name).setValue('');
      sheet.getRange(row._row, col.trimmed_hash).setValue('');
      sheet.getRange(row._row, col.trimmed_bytes).setValue('');
      sheet.getRange(row._row, col.last_generated_at).setValue('');
      return;
    }

    if (missingSet[id] || !entry) {
      sheet.getRange(row._row, col.error).setValue('not in cache');
      return;
    }

    sheet.getRange(row._row, col.recipe_name).setValue(entry.name || '');
    sheet.getRange(row._row, col.trimmed_hash).setValue(entry.trimmed_hash);
    sheet.getRange(row._row, col.trimmed_bytes).setValue(entry.trimmed_bytes);
    sheet.getRange(row._row, col.last_generated_at).setValue(now);
  });

  // Optional convenience: stamp a hyperlink to the Drive file in cell A1's
  // note, so the user can find the latest output without leaving the sheet.
  sheet.getRange(1, 1).setNote(
    `Latest output: ${file.getName()}\n${file.getUrl()}\nGenerated: ${now.toISOString()}`
  );
}


/* -------------------------------------------------------------------------- */
/* Drive IO                                                                   */
/* -------------------------------------------------------------------------- */

function saveManifestToDrive_(manifestName, envelope) {
  const subfolder = getOrCreateManifestsSubfolder_();
  const slug      = slugify_(manifestName);
  const safeTs    = envelope.generated_at.replace(/[:.]/g, '-');
  const filename  = `manifest_${slug}_${safeTs}.json`;
  return subfolder.createFile(filename, canonicalJson(envelope), MimeType.PLAIN_TEXT);
}


function getOrCreateManifestsSubfolder_() {
  const parent   = getOrThrowDriveFolder_();
  const existing = parent.getFoldersByName('manifests');
  return existing.hasNext() ? existing.next() : parent.createFolder('manifests');
}


function slugify_(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'manifest';
}
