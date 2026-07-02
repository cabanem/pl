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
   */
  createMenu() {
    const isAdv = (typeof UiMode !== "undefined") ? UiMode.isAdvanced() : false;

    const root = this.ui.createMenu("Workato Sync");

    // --- Quick Actions (always visible) -------------------------------------
    root.addSubMenu(
      this.ui.createMenu("Quick Actions")
        .addItem("Run workspace inventory sync", "syncInventory")
        .addSeparator()
        .addItem("Analyze selected rows using AI", "fetchRecipeAnalysisSelected")
        .addItem("Generate process maps for selection (calls + full)", "generateProcessMapsSelected")
    );

    // --- Selection-driven tools (always visible) ----------------------------
    root.addSubMenu(
      this.ui.createMenu("Selection-driven")
        .addItem("Debug logic for selected rows", "fetchRecipeLogicSelected")
        .addItem("Analyze selected rows using AI", "fetchRecipeAnalysisSelected")
        .addSeparator()
        .addItem("Generate process maps for selection (calls only)", "generateProcessMapsSelectedCalls")
        .addItem("Generate process maps for selection (full only)", "generateProcessMapsSelectedFull")
        .addItem("Generate process maps for selection (calls + full)", "generateProcessMapsSelected")
        .addSeparator()
        .addItem("Generate aggregated companion doc (selection)", "generateCompanionDocSelected")
        .addItem("Generate system architecture doc (selection)", "generateSystemDocSelected")
    );

    // --- Advanced tools ------------------------------------------------------
    if (isAdv) {
      root.addSubMenu(
        this.ui.createMenu("Advanced")
          .addSubMenu(
            this.ui.createMenu("Requests-sheet driven")
              .addItem("Debug logic (from Input_Requests)", "fetchRecipeLogic")
              .addItem("Analyze using AI (from Input_Requests)", "fetchRecipeAnalysis")
              .addSeparator()
              .addItem("Generate process maps (calls only)", "generateProcessMapsCalls")
              .addItem("Generate process maps (full only)", "generateProcessMapsFull")
              .addItem("Generate process maps (calls + full)", "generateProcessMaps")
              .addSeparator()
              .addItem("Generate aggregated companion doc (requests)", "generateCompanionDoc")
              .addItem("Generate system architecture doc (requests)", "generateSystemDocRequest")
          )
          .addSeparator()
          .addItem("Test connectivity", "testWorkatoConnectivity")
          .addSeparator()
          .addSubMenu(
            this.ui.createMenu("Diagnostics")
              .addItem("Debug property report (logs)", "debugPropertyReport")
              .addItem("Migrate scriptProps â†’ userProps", "migrateMyScriptPropsToUserProps")
          )
          .addSeparator()
          .addSubMenu(
            this.ui.createMenu("Maintenance")
              .addItem("Reset inventory sheets (keep headers)", "resetInventorySheets")
              .addItem("Prune System_Logs (keep last 500)", "pruneSystemLogs")
              .addItem("Clear Drive debug files older than 30 days", "purgeOldDriveLogs")
          )
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