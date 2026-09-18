/**
 * @file ConfigTools.gs — operator conveniences for the Config spreadsheet.
 *
 * @summary Two things: a live list of the Gemini models this project can call, written to a `_models` tab and
 * offered as a dropdown on the Config `model` cell; and a "Contract Intake" menu in the Config spreadsheet so the
 * team can refresh that list and validate the config without opening the script editor.
 *
 * @description
 *   1. The model list comes from Vertex AI Model Garden's publisher-models endpoint, called with the running
 *      user's OAuth token exactly as callGemini_ does, against the same location the pipeline uses. The raw
 *      catalogue is large (embedding, image, live-audio and TTS models included); parseModelList_() keeps only
 *      Gemini models a text/document generateContent call can use, and drops deprecated ones.
 *   2. The dropdown ALLOWS values not in the list. A newer preview, or a model the catalogue lags on, must still
 *      be typeable; the list is a convenience, not a gate. readConfig_ is unchanged and still reads the cell.
 *   3. The menu (onOpen) appears only when this project is BOUND to the Config spreadsheet. If Config is reached
 *      via Script Property CONFIG_SHEET_ID instead, run refreshModelList() from the editor or on a time trigger.
 *
 * DEPLOY: clasp push only. Nothing here is served by the web app. Reload the Config spreadsheet to see the menu.
 */

/** @const {string} Tab that holds the fetched model catalogue, inside the config spreadsheet. */
const MODELS_SHEET_NAME = '_models';
/** @const {string[]} Header row of the `_models` tab. */
const MODELS_HEADERS = ['Model', 'Launch stage', 'Version', 'Fetched'];
/** @const {RegExp} Gemini variants that cannot do text/document extraction; excluded from the dropdown. */
const MODEL_EXCLUDE = /embedding|tts|image|live|audio|native|computer-use|robotics/i;
/** @const {number} Safety cap on catalogue pages. */
const MODELS_MAX_PAGES = 10;

// --- MENU (bound spreadsheet only) --------------------------------------------------------

/**
 * Adds the "Contract Intake" menu when the Config spreadsheet opens. Simple trigger: runs only if this project is
 * bound to that spreadsheet, and only with the opener's authorization. Menu items call the functions below.
 * @return {void}
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Contract Intake')
      .addItem('Refresh model list', 'refreshModelList')
      .addItem('Validate config', 'validateConfigUi')
      .addToUi();
  } catch (e) { /* no UI (editor run, or not bound) */ }
}

/**
 * validateConfig() with the result shown in the spreadsheet rather than the log.
 * @return {void}
 */
function validateConfigUi() {
  let msg;
  try {
    const cfg = readConfig_();
    msg = 'Config OK.\n\nModel: ' + (cfg.model || '(default)') + '\nFields: ' + cfg.output_fields.join(', ');
  } catch (err) {
    msg = 'Config problem:\n\n' + err.message;
  }
  try { SpreadsheetApp.getUi().alert('Contract Intake', msg, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { Logger.log(msg); }
}

// --- MODEL LIST -----------------------------------------------------------------------------

/**
 * Fetch the Gemini catalogue, write it to `_models`, and put a dropdown on the Config `model` cell.
 * Safe to run any time; it rewrites the tab wholesale. Logs and (when a UI exists) shows a one-line result.
 * @return {number} Models written.
 */
function refreshModelList() {
  const cfg = readConfig_();
  const models = listPublisherModels_(cfg);
  if (!models.length) throw new Error('Vertex returned no usable Gemini models for location "' + (cfg.location || 'global') + '".');

  const ss = getConfigSpreadsheet_();
  let sheet = ss.getSheetByName(MODELS_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(MODELS_SHEET_NAME);
  sheet.clearContents();
  const fetched = new Date();
  sheet.getRange(1, 1, 1, MODELS_HEADERS.length).setValues([MODELS_HEADERS]).setFontWeight('bold');
  sheet.getRange(2, 1, models.length, MODELS_HEADERS.length)
    .setValues(models.map(function (m) { return [m.id, m.stage, m.version, fetched]; }));
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, MODELS_HEADERS.length);

  const listRange = sheet.getRange(2, 1, models.length, 1);
  const cell = configValueCell_(ss, 'model');
  if (cell) {
    cell.setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInRange(listRange, true)
      .setAllowInvalid(true)                                   // a convenience, not a gate
      .setHelpText('Gemini models available to this project (Contract Intake > Refresh model list). You may type one that is not listed.')
      .build());
    cell.setNote('List refreshed ' + fetched.toISOString() + ' · ' + models.length + ' models · location ' + (cfg.location || 'global'));
  }

  const summary = models.length + ' models written to ' + MODELS_SHEET_NAME + (cell ? '; dropdown set on Config > model.' : '; Config has no "model" row, so no dropdown was set.');
  logInfo_('refreshModelList', summary);
  try { SpreadsheetApp.getUi().alert('Contract Intake', summary, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* no UI */ }
  return models.length;
}

/**
 * The Config value cell (column B) for a given key in column A, or null if the key is absent.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} key
 * @return {?GoogleAppsScript.Spreadsheet.Range}
 * @private
 */
function configValueCell_(ss, key) {
  const sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) return null;
  const keys = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues();
  for (let i = 0; i < keys.length; i++) {
    if (sameLabel_(keys[i][0], key)) return sheet.getRange(i + 1, 2);
  }
  return null;
}

/**
 * Call Model Garden for Google's publisher models at the pipeline's location and reduce them to usable Gemini ids.
 * Uses the running user's token, like callGemini_, and names the project for quota.
 * @param {Config} cfg
 * @return {Array<{id:string, stage:string, version:string}>}
 * @throws {Error} On a non-200 response, with the first part of Vertex's message.
 * @private
 */
function listPublisherModels_(cfg) {
  const location = cfg.location || 'global';
  const host = (location === 'global') ? 'aiplatform.googleapis.com' : location + '-aiplatform.googleapis.com';
  const base = 'https://' + host + '/v1beta1/publishers/google/models?listAllVersions=false&pageSize=200';
  const headers = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  if (cfg.project_id) headers['x-goog-user-project'] = cfg.project_id;

  let all = [];
  let token = '';
  for (let page = 0; page < MODELS_MAX_PAGES; page++) {
    const resp = UrlFetchApp.fetch(base + (token ? '&pageToken=' + encodeURIComponent(token) : ''), { headers: headers, muteHttpExceptions: true });
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    if (code !== 200) throw new Error('Vertex ' + code + ' listing publisher models: ' + body.slice(0, 300));
    const json = JSON.parse(body);
    all = all.concat(parseModelList_(json));
    token = json.nextPageToken || '';
    if (!token) break;
  }
  return dedupeModels_(all);
}

/**
 * Reduce one page of the publisher-models response to Gemini models fit for text/document generateContent. Pure.
 * Keeps: name starts with "gemini", launch stage not deprecated, not an embedding/TTS/image/live/audio variant.
 * @param {{publisherModels:Array<Object>}} json One page of the API response.
 * @return {Array<{id:string, stage:string, version:string}>} Sorted by id.
 * @private
 */
function parseModelList_(json) {
  const items = (json && json.publisherModels) || [];
  const out = [];
  items.forEach(function (m) {
    const id = String((m && m.name) || '').split('/').pop().trim();
    const stage = String((m && m.launchStage) || '');
    if (!/^gemini/i.test(id)) return;
    if (/DEPRECATED/i.test(stage)) return;
    if (MODEL_EXCLUDE.test(id)) return;
    out.push({ id: id, stage: stage || 'UNKNOWN', version: String((m && m.versionId) || '') });
  });
  return dedupeModels_(out);
}

/**
 * Unique by id, sorted so GA models come first and each stage is alphabetical. Pure.
 * @param {Array<{id:string, stage:string, version:string}>} models
 * @return {Array<{id:string, stage:string, version:string}>}
 * @private
 */
function dedupeModels_(models) {
  const seen = {};
  const out = models.filter(function (m) { if (seen[m.id]) return false; seen[m.id] = true; return true; });
  const rank = function (s) { return s === 'GA' ? 0 : (/PREVIEW/i.test(s) ? 1 : 2); };
  out.sort(function (a, b) { return rank(a.stage) - rank(b.stage) || a.id.localeCompare(b.id); });
  return out;
}
