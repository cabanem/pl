/**
 * @file 99_EntryPoints.gs
 * @description Functions outside of classes that act as entry points.
 */

// -------------------------------------------------------------------------------------------------------
// HANDLES
// -------------------------------------------------------------------------------------------------------
function onOpen() {
  new UserInterfaceService().createMenu();
}
function promptToken() {
  new UserInterfaceService().promptUpdate('WORKATO_TOKEN', 'Update API Token', { isSecret: true, scope: "user" });
}
function promptBaseUrl() {
  // Base URL can be user-specific or shared; defaulting to user avoids surprises across environments.
  new UserInterfaceService().promptUpdate('WORKATO_BASE_URL', 'Update Base URL', { isSecret: false, scope: "user" });
}
function promptFolderId() {
  new UserInterfaceService().promptUpdate('DEBUG_FOLDER_ID', 'Update Debug Folder ID', { isSecret: false, scope: "user" });
}
function showCurrentConfig() {
  new UserInterfaceService().showConfiguration();
}

// -------------------------------------------------------------------------------------------------------
// GLOBAL EXECUTABLES
// -------------------------------------------------------------------------------------------------------
/**
 * Primary entry point for the script.
 * Initializes the WorkatoSyncApp controller and runs the sync.
 */
function syncInventory() {
  Commands.run("inventory.sync");
}
/** Analyze recipe */
function fetchRecipeLogic() {
  Commands.run("logic.debug");
}
/** Analyze recipe with AI */
function fetchRecipeAnalysis() {
  Commands.run("ai.analyze");
}
/** Generates process maps: calls + full (default). */
function generateProcessMaps() {
  Commands.run("process.maps", { options: { mode: "calls+full" } });
}
/** Generates process maps: calls only. */
function generateProcessMapsCalls() {
  Commands.run("process.maps", { options: { mode: "calls" } });
}
/** Generates process maps: full process only. */
function generateProcessMapsFull() {
  Commands.run("process.maps", { options: { mode: "full" } });
}
/** Generates companion document describing all recipes. */
function generateCompanionDoc() {
  Commands.run("docs.companion");
}
/** Generates system-level documentation. */
function generateSystemDocRequest() {
  Commands.run("docs.system");
}

// --- Corpus Q&A ---------------------------------------------------------------------------------------
/** Interim ask box (O2) until the web-app UI lands. */
function askCorpusPrompt() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt("Ask the corpus", "Question about the recipe estate:", ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const q = resp.getResponseText().trim();
  if (!q) return;
  try {
    const r = askCorpus(q);
    const cited = (r.citations || []).map(c => c.ref).join("; ");
    const asOf = r.as_of ? `as of ${r.as_of.generated_at} · corpus fp ${r.as_of.corpus_fp12}` : "";
    ui.alert("Corpus answer", `${r.answer}\n\n${cited ? `Cited: ${cited}\n` : ""}${asOf}`, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("Corpus Q&A failed", String((e && e.message) || e), ui.ButtonSet.OK);
  }
}
/** Manual digest rebuild (the same build cron_digest runs nightly, fingerprint-gated). */
function rebuildCorpusDigest() {
  Commands.run("corpus.digest");
}
/** Opens the Q&A sidebar: ask box, rendered cited answers, recent history from Output_QA_Log. */
function showCorpusSidebar() {
  const html = HtmlService.createHtmlOutputFromFile("CorpusSidebar").setTitle("Corpus Q&A");
  SpreadsheetApp.getUi().showSidebar(html);
}
/**
 * ***UPDATED*** Opens the deployed web app (WEBAPP_PLAN §3). First run stores the URL once for
 * everyone (ConfigStore: WEBAPP_URL, script scope); it survives redeploys because "New version"
 * keeps the /exec URL stable. To redo setup, clear WEBAPP_URL from script properties.
 */
function openCorpusWebApp() {
  const ui = SpreadsheetApp.getUi();
  let url = ConfigStore.get("WEBAPP_URL", { preferUser: false, defaultValue: "" });
  if (!url) {
    const resp = ui.prompt("Web app URL (one-time setup)",
      "Paste the deployed web app URL (Deploy -> Manage deployments -> Web app, ends in /exec):",
      ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    url = resp.getResponseText().trim();
    if (!/^https:\/\/script\.google\.com\//.test(url)) {
      ui.alert("That doesn't look like an Apps Script web app URL (expected https://script.google.com/…).");
      return;
    }
    ConfigStore.setScript("WEBAPP_URL", url);
    AppLog.notify("Web app URL stored. The dashboard's quick links will show it on the next dashboard rebuild.");
  }
  new UserInterfaceService().showLinkModal("Corpus Q&A web app",
    "Shareable with anyone in the domain — they need the link and nothing else.", url, "Open Corpus Q&A");
}


// --- Selection-driven actions -------------------------------------------------------------------------
function fetchRecipeLogicSelected() {
  const ids = SelectionUtils.getSelectedRecipeIds();
  if (!ids.length) {
    Logger.notify("Select rows (or ID cells) in a sheet with recipe IDs first.", true);
    return;
  }
  Commands.run("logic.debug", { ids });
}
function fetchRecipeAnalysisSelected() {
  const ids = SelectionUtils.getSelectedRecipeIds();
  if (!ids.length) {
    Logger.notify("Select rows (or ID cells) in a sheet with recipe IDs first.", true);
    return;
  }
  Commands.run("ai.analyze", { ids });
}
function generateProcessMapsSelected() {
  const ids = SelectionUtils.getSelectedRecipeIds();
  if (!ids.length) {
    Logger.notify("Select rows (or ID cells) in a sheet with recipe IDs first.", true);
    return;
  }
  Commands.run("process.maps", { options: { mode: "calls+full" }, ids });
}
function generateProcessMapsSelectedCalls() {
  const ids = SelectionUtils.getSelectedRecipeIds();
  if (!ids.length) {
    Logger.notify("Select rows (or ID cells) in a sheet with recipe IDs first.", true);
    return;
  }
  Commands.run("process.maps", { options: { mode: "calls" }, ids });
}
function generateProcessMapsSelectedFull() {
  const ids = SelectionUtils.getSelectedRecipeIds();
  if (!ids.length) {
    Logger.notify("Select rows (or ID cells) in a sheet with recipe IDs first.", true);
    return;
  }
  Commands.run("process.maps", { options: { mode: "full" }, ids });
}
function generateCompanionDocSelected() {
  const ids = SelectionUtils.getSelectedRecipeIds();
  if (!ids.length) {
    Logger.notify("Select rows (or ID cells) in a sheet with recipe IDs first.", true);
    return;
  }
  Commands.run("docs.companion", { ids });
}
function generateSystemDocSelected() {
  const ids = SelectionUtils.getSelectedRecipeIds();
  if (!ids.length) {
    Logger.notify("Select rows (or ID cells) in a sheet with recipe IDs first.", true);
    return;
  }
  Commands.run("docs.system", { ids });
}

/**
 * Migrate from scriptProperties to userProperties
 */
function migrateMyScriptPropsToUserProps() {
  const keys = ["WORKATO_TOKEN", "WORKATO_BASE_URL", "DEBUG_FOLDER_ID"];
  const s = PropertiesService.getScriptProperties();
  const u = PropertiesService.getUserProperties();
  keys.forEach(k => {
    const v = s.getProperty(k);
    if (v && !u.getProperty(k)) u.setProperty(k, v);
  });
  SpreadsheetApp.getUi().alert("Migrated script props to your user props (only for missing values).");
}

// --- Debugging and testing ----------------------------------------------------------------------------
/**
 * Validates the connection to the Workato API across all primary endpoints.
 * Uses the Class-based WorkatoClient.
 */
function testWorkatoConnectivity() {
  console.log("--- TESTING CONNECTIVITY ---");
  const client = new WorkatoClient();
  const endpoints = ['projects', 'folders', 'recipes', 'properties', 'lookup_tables', 'data_tables'];
  const results = [];

  endpoints.forEach(endpoint => {
    try {
      const path = `${endpoint}?page=1&per_page=1`;
      const json = client.get(path);

      let count = 0;
      if (Array.isArray(json)) count = json.length;
      else if (json.data) count = json.data.length;
      else if (json.items) count = json.items.length;
      else if (json.result) count = json.result.length;

      const msg = `[${endpoint.toUpperCase()}] Status: OK (${count}) samples`;
      console.log(msg);
      results.push("✅ " + msg);
    } catch (e) {
      const msg = `[${endpoint.toUpperCase()}] FAILED: ${e.message}`;
      console.error(msg);
      results.push("❌ " + msg);
    }
  });
  try {
    new UserInterfaceService().showConnectivityReport(results);
  } catch {
    console.log(results);
  }
}
function debugPropertyReport() {
  const u = PropertiesService.getUserProperties().getProperties();
  const s = PropertiesService.getScriptProperties().getProperties();
  console.log("USER PROPS:", JSON.stringify(u, null, 2));
  console.log("SCRIPT PROPS:", JSON.stringify(s, null, 2));
  SpreadsheetApp.getUi().alert("Logged user/script properties to execution logs.");
}

// --- Miscellaneous ------------------------------------------------------------------------------------
function promptVertexProject() {
  new UserInterfaceService().promptUpdate('GOOGLE_CLOUD_PROJECT_ID', 'Update your Vertex (GCP) project ID', { isSecret: false, scope: "script" });
}
function listVertexModels() {
  const models = GeminiService.listPublisherModels({ location: "global" });
  const gemini = models.filter(m => /^gemini/.test(m.id)).sort((a, b) => a.id.localeCompare(b.id));
  console.log(`Found ${models.length} publisher models (${gemini.length} Gemini):`);
  gemini.forEach(m => console.log(`  ${m.id}  [${m.launchStage}]`));
  SpreadsheetApp.getActiveSpreadsheet().toast(`${gemini.length} Gemini models. See logs.`, "Vertex", 5);
  return models;
}
