/**
 * @file 20_UI_Mode.gs
 * @description UI mode controls (basic vs advanced) stored in UserProperties.
 */

class UiMode {
  static key_() { return "UI_MODE"; } // user property
  static get_() {
    return String(ConfigStore.get(this.key_(), { preferUser: true, defaultValue: "basic" }) || "basic")
      .trim()
      .toLowerCase();
  }
  static isAdvanced() { return this.get_() === "advanced"; }

  static set(mode) {
    const m = (String(mode || "").toLowerCase() === "advanced") ? "advanced" : "basic";
    ConfigStore.setUser(this.key_(), m);
    return m;
  }

  static toggle() {
    return this.set(this.isAdvanced() ? "basic" : "advanced");
  }

  static rebuildMenu_() {
    try {
      new UserInterfaceService().createMenu();
      SpreadsheetApp.getActiveSpreadsheet().toast("Menu updated.", "Workato Sync", 3);
    } catch (e) {
      // Swallow UI issues for headless runs
    }
  }

  /**
   * Re-apply sheet visibility to match the current mode, so switching to Basic
   * hides the backend sheets immediately rather than waiting for the next sync.
   */
  static applyVisibility_() {
    try {
      DashboardService.applyVisibility(new AppContext());
    } catch (e) {
      // Not configured / headless — leave visibility as-is.
    }
  }
}

// Global handlers (used by menu)
function setUiModeBasic() {
  UiMode.set("basic");
  UiMode.rebuildMenu_();
  UiMode.applyVisibility_();
}
function setUiModeAdvanced() {
  UiMode.set("advanced");
  UiMode.rebuildMenu_();
  UiMode.applyVisibility_();
}
function toggleUiMode() {
  UiMode.toggle();
  UiMode.rebuildMenu_();
  UiMode.applyVisibility_();
}
