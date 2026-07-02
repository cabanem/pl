/**
 * @file 21_UI_Menu.gs
 */
// -------------------------------------------------------------------------------------------------------
// USER INTERFACE
// -------------------------------------------------------------------------------------------------------
/**
 * @class
 * @classdesc Manages all direct interactions with the user (Menus, Prompts, Alerts).
 * Encapsulates UI logic to keep the global namespace clean.
 */
class UserInterfaceService {
  constructor() {
    this.ui = SpreadsheetApp.getUi();
    // this.props = PropertiesService.getScriptProperties(); // scriptProps
    this.scriptProps = PropertiesService.getScriptProperties();
    this.userProps = PropertiesService.getUserProperties();
  }

  /**
   * Builds and displays the custom menu.
   *
   * Structure:
   *   - Grouped by TASK (one entry per capability), not by input source.
   *   - Every label names its output destination (-> sheet / -> Drive).
   *   - Basic mode: one verb per capability, acting on the current selection.
   *   - Advanced mode: the same capabilities, each a submenu exposing input
   *     source (selection vs Input_Requests) and, for process maps, the mode.
   *   - Max two menu levels; every leaf maps to an existing global entry point.
   */
  createMenu() {
    const isAdv = (typeof UiMode !== "undefined") ? UiMode.isAdvanced() : false;

    const root = this.ui.createMenu("Workato Sync");

    // --- Inventory (always visible) -----------------------------------------
    root.addItem("Sync workspace inventory", "syncInventory");
    root.addSeparator();

    if (!isAdv) {
      // ===== BASIC: one clear verb per capability, acting on the selection =====
      root.addItem("Recipe step breakdown -> sheet", "fetchRecipeLogicSelected");
      root.addItem("AI analysis -> sheet", "fetchRecipeAnalysisSelected");
      root.addItem("Process maps -> sheet", "generateProcessMapsSelected");
      root.addItem("Recipe reference doc -> Drive", "generateCompanionDocSelected");
      root.addItem("System architecture doc -> Drive", "generateSystemDocSelected");
    } else {
      // ===== ADVANCED: capability first, then input source (+ map mode) =====
      root.addSubMenu(
        this.ui.createMenu("Recipe step breakdown -> sheet")
          .addItem("From selection", "fetchRecipeLogicSelected")
          .addItem("From Input_Requests", "fetchRecipeLogic")
      );
      root.addSubMenu(
        this.ui.createMenu("AI analysis -> sheet")
          .addItem("From selection", "fetchRecipeAnalysisSelected")
          .addItem("From Input_Requests", "fetchRecipeAnalysis")
      );
      root.addSubMenu(
        this.ui.createMenu("Process maps -> sheet")
          .addItem("Selection: calls + full", "generateProcessMapsSelected")
          .addItem("Selection: calls only", "generateProcessMapsSelectedCalls")
          .addItem("Selection: full only", "generateProcessMapsSelectedFull")
          .addSeparator()
          .addItem("Requests: calls + full", "generateProcessMaps")
          .addItem("Requests: calls only", "generateProcessMapsCalls")
          .addItem("Requests: full only", "generateProcessMapsFull")
      );
      root.addSubMenu(
        this.ui.createMenu("Recipe reference doc -> Drive")
          .addItem("From selection", "generateCompanionDocSelected")
          .addItem("From Input_Requests", "generateCompanionDoc")
      );
      root.addSubMenu(
        this.ui.createMenu("System architecture doc -> Drive")
          .addItem("From selection", "generateSystemDocSelected")
          .addItem("From Input_Requests", "generateSystemDocRequest")
      );

      // --- Tools ------------------------------------------------------------
      root.addSeparator();
      root.addItem("Test connectivity", "testWorkatoConnectivity");
      root.addSubMenu(
        this.ui.createMenu("Diagnostics")
          .addItem("Debug property report (logs)", "debugPropertyReport")
          .addItem("Migrate scriptProps -> userProps", "migrateMyScriptPropsToUserProps")
      );
      root.addSubMenu(
        this.ui.createMenu("Maintenance")
          .addItem("Reset inventory sheets (keep headers)", "resetInventorySheets")
          .addItem("Prune System_Logs (keep last 500)", "pruneSystemLogs")
          .addItem("Clear Drive debug files older than 30 days", "purgeOldDriveLogs")
      );
    }

    // --- Configuration (always visible) -------------------------------------
    root.addSeparator();
    root.addSubMenu(
      this.ui.createMenu("Configuration")
        .addItem("Set Workato API token", "promptToken")
        .addItem("Set base URL", "promptBaseUrl")
        .addItem("Set GCP project ID", "promptVertexProject")
        .addItem("Set debug folder ID", "promptFolderId")
        .addSeparator()
        .addItem("Show current config", "showCurrentConfig")
        .addSeparator()
        .addItem("Rebuild dashboard & views", "rebuildDashboard")
        .addItem("Apply sheet visibility", "applySheetVisibility")
    );

    // --- Mode toggle (always visible) ---------------------------------------
    root.addSeparator();
    if (isAdv) root.addItem("Switch to Basic menu", "setUiModeBasic");
    else root.addItem("Switch to Advanced menu", "setUiModeAdvanced");

    root.addToUi();
  }

  /**
   * Prompts the user to update a specific script property.
   * Handles validation, user cancellation, and masking of secrets.
   * @param {string} key - The ScriptProperty key to update.
   * @param {string} title - The title of the prompt dialog.
   * @param {{ isSecret?: boolean, scope?: "user"|"script" }} [opts]
   */
  promptUpdate(key, title, opts = {}) {
    const isSecret = Boolean(opts.isSecret);
    const scope = (opts.scope === "script") ? "script" : "user";
    const result = this.ui.prompt(title, `Enter new value for ${key}:`, this.ui.ButtonSet.OK_CANCEL);

    if (result.getSelectedButton() === this.ui.Button.OK) {
      const input = result.getResponseText().trim();

      // Handle Empty Input (Delete vs Cancel)
      if (input === "") {
        const confirm = this.ui.alert(
          'Delete Property?', 
          `Input was empty. Do you want to DELETE the existing '${key}'?`, 
          this.ui.ButtonSet.YES_NO
        );
        if (confirm === this.ui.Button.YES) {
          if (scope === "script") this.scriptProps.deleteProperty(key);
          else this.userProps.deleteProperty(key);
          this.ui.alert('Property deleted. Script will use code-level defaults.');
        }
        return;
      }

      // Save
      if (scope === "script") this.scriptProps.setProperty(key, input);
      else this.userProps.setProperty(key, input);
      
      // Feedback
      const displayValue = isSecret 
        ? `${input.substring(0, 4)}...${input.substring(input.length - 4)}` 
        : input;
      
      this.ui.alert(`Saved ${key} (${scope}): ${displayValue}`);
    }
  }
  /**
   * Displays the current configuration state in a formatted alert.
   */
  showConfiguration() {
    const user = this.userProps.getProperties();
    const script = this.scriptProps.getProperties();
    const defaults = AppConfig.get().API;
    
    // Logic to determine display strings (Set vs Default vs Missing)
    const tokenStatus =
      user['WORKATO_TOKEN'] ? "******** (User)" :
      script['WORKATO_TOKEN'] ? "******** (Script)" :
      "âŒ NOT SET";

    const urlStatus =
      user['WORKATO_BASE_URL'] ? `${user['WORKATO_BASE_URL']} (User)` :
      script['WORKATO_BASE_URL'] ? `${script['WORKATO_BASE_URL']} (Script)` :
      `${defaults.BASE_URL} (Default)`;

    const folderStatus =
      user['DEBUG_FOLDER_ID'] ? `${user['DEBUG_FOLDER_ID']} (User)` :
      script['DEBUG_FOLDER_ID'] ? `${script['DEBUG_FOLDER_ID']} (Script)` :
      "(Auto-generated)";

    const vertexStatus =
      script['GOOGLE_CLOUD_PROJECT_ID'] ? `${script['GOOGLE_CLOUD_PROJECT_ID']} (Script)` :
      user['GOOGLE_CLOUD_PROJECT_ID'] ? `${user[GOOGLE_CLOUD_PROJECT_ID]} (User)` :
      "NOT SET";
    
    const msg = [
      `API Token: ${tokenStatus}`,
      `Base URL: ${urlStatus}`,
      `Vertex project: ${vertexStatus}`,
      `Debug Folder ID: ${folderStatus}`,
      ``,
      `Precedence: User settings override Script settings.`
    ].join('\n');
    
    this.ui.alert('Current Configuration', msg, this.ui.ButtonSet.OK);
  }
  /**
   * Formats and displays connectivity test results.
   * @param {Array<string>} results - Array of status messages.
   */
  showConnectivityReport(results) {
    this.ui.alert("Connectivity Test Results", results.join("\n"), this.ui.ButtonSet.OK);
  }
  /**
   * Displays an HTML modal with a clickable link.
   * @param {string} title - The modal window title.
   * @param {string} message - The text body.
   * @param {string} url - The URL to link to.
   */
  showLinkModal(title, message, url) {
    const html = HtmlService.createHtmlOutput(`
      <div style="font-family: Arial, sans-serif; padding: 10px; color: #333;">
        <p>${message}</p>
        <br>
        <a href="${url}" target="_blank" style="background-color: #1a73e8; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; font-weight: bold;">
          Open Document in Drive
        </a>
      </div>
    `)
    .setWidth(350)
    .setHeight(150);

    this.ui.showModalDialog(html, title);
  }
}