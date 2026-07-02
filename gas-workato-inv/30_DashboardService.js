/**
 * @file 30_DashboardService.gs
 * @description Creates/refreshes dashboard + view tabs and manages visibility/protection.
 *              Also owns the "friendly surface" polish: tab colors, a start-here
 *              dashboard, health formatting on View_Recipes, and header tooltips.
 */

class DashboardService {
  /** Days after which the dashboard flags the inventory as stale. */
  static get STALE_SYNC_DAYS() { return 7; }

  static ensureAll(ctx, stats = null) {
    const cfg = ctx.config;
    if (!cfg.DASHBOARD || !cfg.DASHBOARD.ENABLE) return;

    const ss = ctx.sheetService.getSpreadsheet();
    this._ensureOutputSheets_(ss, ctx);

    // 1) Build/refresh views
    this._ensureViewRecipes_(ss, ctx);

    // 2) Build/refresh dashboard
    this._ensureDashboardHome_(ss, ctx, stats);

    // 3) Friendly-surface polish (idempotent)
    this._applyTabColors_(ctx);
    this._applyHeaderNotes_(ctx);

    // 4) Apply sheet visibility rules
    this.applyVisibility(ctx);

    // 5) Apply protections (warning-only by default)
    this.applyProtections(ctx);
  }
  /**
   * Call after a successful inventory sync.
   * @param {AppContext} ctx
   * @param {Object} stats counts/metadata to show on dashboard
   */
  static postInventorySync(ctx, stats = {}) {
    const now = new Date();
    const iso = now.toISOString();

    // Store a "last sync" stamp for humans + debugging
    try {
      ConfigStore.setScript("LAST_INVENTORY_SYNC_AT", iso);
    } catch (e) {}

    // Inject the stamp into the dashboard as well
    const merged = Object.assign({ last_sync_at: iso }, stats || {});
    this.ensureAll(ctx, merged);
  }
  static applyVisibility(ctx) {
    const cfg = ctx.config;
    if (!cfg.DASHBOARD || !cfg.DASHBOARD.ENABLE) return;
    if (!cfg.DASHBOARD.HIDE_BACKEND_IN_BASIC) return;

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheets = ss.getSheets();

    const isAdv = (typeof UiMode !== "undefined") ? UiMode.isAdvanced() : false;
    const showOutputs = Boolean(cfg.DASHBOARD.SHOW_OUTPUT_SHEETS_IN_BASIC);

    const visibleInBasic = new Set([
      cfg.SHEETS.DASHBOARD_HOME,
      cfg.SHEETS.VIEW_RECIPES,
      ...(showOutputs ? [cfg.SHEETS.AI_ANALYSIS, cfg.SHEETS.PROCESS_MAPS] : [])
    ].filter(Boolean));

    // If we're about to hide the active sheet, switch to Dashboard first
    if (!isAdv) {
      const active = ss.getActiveSheet();
      if (active && !visibleInBasic.has(active.getName())) {
        const dash = ss.getSheetByName(cfg.SHEETS.DASHBOARD_HOME) || ss.getSheets()[0];
        if (dash) ss.setActiveSheet(dash);
      }
    }

    sheets.forEach(sh => {
      const name = sh.getName();
      if (isAdv) {
        sh.showSheet();
      } else {
        if (visibleInBasic.has(name)) sh.showSheet();
        else sh.hideSheet();
      }
    });
  }
  static applyProtections(ctx) {
    const cfg = ctx.config;
    if (!cfg.DASHBOARD || !cfg.DASHBOARD.ENABLE) return;

    const warningOnly = Boolean(cfg.DASHBOARD.PROTECT_BACKEND_WARNING_ONLY);
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const backendKeys = [
      "PROJECTS",
      "FOLDERS",
      "RECIPES",
      "PROPERTIES",
      "TABLES",
      "LOOKUP_TABLES",
      "DEPENDENCIES",
      "CALL_EDGES",
      "LOGIC",
      "DEBUG",
      "LOGIC_INPUT"
    ];

    backendKeys.forEach(k => {
      const name = cfg.SHEETS[k];
      if (!name) return;
      const sh = ss.getSheetByName(name);
      if (!sh) return;

      this._ensureProtection_(sh, `WorkatoSync backend: ${name}`, warningOnly);
    });
  }

  // ---------------------------------------------------------------------------------------
  // Dashboard_Home  (start-here surface)
  // ---------------------------------------------------------------------------------------
  static _ensureDashboardHome_(ss, ctx, stats) {
    const cfg = ctx.config;
    const name = cfg.SHEETS.DASHBOARD_HOME || "Dashboard_Home";
    const sh = ctx.sheetService.getOrCreateByName(name);

    if (cfg.DASHBOARD.OVERWRITE_VIEWS) {
      sh.clear();
      sh.setFrozenRows(0);
      sh.setFrozenColumns(0);
    }

    // --- Title + what-it-is -------------------------------------------------
    sh.getRange("A1").setValue("Workato Sync Dashboard").setFontWeight("bold").setFontSize(14);
    sh.getRange("A2").setValue("Inventory and analysis for your Workato workspace.").setFontColor("#666666");

    // --- Getting started ----------------------------------------------------
    sh.getRange("A4").setValue("Getting started").setFontWeight("bold");
    sh.getRange("A5").setValue('1.  Run "Sync workspace inventory" from the Workato Sync menu.');
    sh.getRange("A6").setValue("2.  Open View_Recipes and select the rows you want.");
    sh.getRange("A7").setValue("3.  Use the menu to break down, analyze, or map them.");

    // --- Status + freshness -------------------------------------------------
    const last = (stats && stats.last_sync_at)
      ? String(stats.last_sync_at)
      : String(ConfigStore.get("LAST_INVENTORY_SYNC_AT", { preferUser: false, defaultValue: "" }) || "");

    let freshness = 'Never synced. Run "Sync workspace inventory".';
    let stale = true;
    if (last) {
      const d = new Date(last);
      if (!isNaN(d.getTime())) {
        const days = Math.floor((Date.now() - d.getTime()) / 86400000);
        freshness = days <= 0 ? "Synced today" : `Last synced ${days} day(s) ago`;
        stale = days > this.STALE_SYNC_DAYS;
      }
    }

    sh.getRange("A9").setValue("Status").setFontWeight("bold");
    sh.getRange("A10").setValue("Freshness").setFontWeight("bold");
    sh.getRange("B10").setValue(freshness).setBackground(stale ? "#f4cccc" : "#d9ead3");
    sh.getRange("A11").setValue("Base URL").setFontWeight("bold");
    sh.getRange("B11").setValue(String(cfg.API.BASE_URL || ""));
    sh.getRange("A12").setValue("User").setFontWeight("bold");
    try {
      const u = ctx.inventoryService.getCurrentUser();
      sh.getRange("B12").setValue(u && u.name ? u.name : "(unknown)");
    } catch (e) {
      sh.getRange("B12").setValue("(unknown)");
    }

    // --- Counts -------------------------------------------------------------
    sh.getRange("A14").setValue("Counts").setFontWeight("bold");
    const rows = [
      ["Projects", `=IFERROR(COUNTA(${cfg.SHEETS.PROJECTS}!A2:A),0)`],
      ["Folders", `=IFERROR(COUNTA(${cfg.SHEETS.FOLDERS}!A2:A),0)`],
      ["Recipes", `=IFERROR(COUNTA(${cfg.SHEETS.RECIPES}!A2:A),0)`],
      ["Properties", `=IFERROR(COUNTA(${cfg.SHEETS.PROPERTIES}!A2:A),0)`],
      ["Data tables", `=IFERROR(COUNTA(${cfg.SHEETS.TABLES}!A2:A),0)`],
      ["Lookup tables", `=IFERROR(COUNTA(${cfg.SHEETS.LOOKUP_TABLES}!A2:A),0)`],
      ["Dependencies (rows)", `=IFERROR(COUNTA(${cfg.SHEETS.DEPENDENCIES}!A2:A),0)`],
      ["Call edges (rows)", `=IFERROR(COUNTA(${cfg.SHEETS.CALL_EDGES}!A2:A),0)`],
      ["AI analyses (rows)", `=IFERROR(COUNTA(${cfg.SHEETS.AI_ANALYSIS}!A2:A),0)`],
      ["Process maps (rows)", `=IFERROR(COUNTA(${cfg.SHEETS.PROCESS_MAPS}!A2:A),0)`]
    ];
    sh.getRange(15, 1, rows.length, 2).setValues(rows);
    sh.getRange(15, 1, rows.length, 1).setFontWeight("bold");

    // --- Quick links --------------------------------------------------------
    sh.getRange("D9").setValue("Quick links").setFontWeight("bold");
    DashboardService._setSheetLink_(sh, ss, "D10", cfg.SHEETS.VIEW_RECIPES, "Go to View_Recipes");
    DashboardService._setSheetLink_(sh, ss, "D11", cfg.SHEETS.AI_ANALYSIS, "Go to Output_AI_Analysis");
    DashboardService._setSheetLink_(sh, ss, "D12", cfg.SHEETS.PROCESS_MAPS, "Go to Output_Process_Maps");

    try { sh.autoResizeColumns(1, 5); } catch (e) {}
  }

  // ---------------------------------------------------------------------------------------
  // View_Recipes  (curated selection surface, now with health signals)
  // ---------------------------------------------------------------------------------------
  static _ensureViewRecipes_(ss, ctx) {
    const cfg = ctx.config;
    const name = cfg.SHEETS.VIEW_RECIPES || "View_Recipes";
    const sh = ctx.sheetService.getOrCreateByName(name);

    if (cfg.DASHBOARD.OVERWRITE_VIEWS) {
      sh.clear();
    }

    const headers = cfg.HEADERS.VIEW_RECIPES || [
      "Recipe ID", "Name", "Status", "Project", "Folder", "Last run at",
      "# Dependencies", "# Calls out", "Has AI?", "Has maps?", "Jobs Failed"
    ];

    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#d9d9d9");
    sh.setFrozenRows(1);

    // Main recipe table (A2:F) as a single QUERY so rows always align.
    sh.getRange("A2").setFormula(
      `=QUERY(${cfg.SHEETS.RECIPES}!A2:F, "select Col1,Col2,Col3,Col4,Col5,Col6 where Col1 is not null", 0)`
    );

    // Helper tables (hidden) for counts
    sh.getRange("L1").setValue("dep_recipe_id");
    sh.getRange("M1").setValue("dep_count");
    sh.getRange("L2").setFormula(
      `=QUERY(${cfg.SHEETS.DEPENDENCIES}!A2:F, "select Col1, count(Col1) where Col1 is not null group by Col1 label count(Col1) ''", 0)`
    );

    sh.getRange("N1").setValue("call_recipe_id");
    sh.getRange("O1").setValue("call_count");
    sh.getRange("N2").setFormula(
      `=QUERY(${cfg.SHEETS.CALL_EDGES}!A2:K, "select Col1, count(Col1) where Col1 is not null group by Col1 label count(Col1) ''", 0)`
    );

    // Dependencies (G) / Calls Out (H)
    sh.getRange("G2").setFormula(`=ARRAYFORMULA(IF(A2:A="",,IFERROR(VLOOKUP(A2:A, L2:M, 2, FALSE), 0)))`);
    sh.getRange("H2").setFormula(`=ARRAYFORMULA(IF(A2:A="",,IFERROR(VLOOKUP(A2:A, N2:O, 2, FALSE), 0)))`);

    // Has AI? (I) / Has Maps? (J)
    sh.getRange("I2").setFormula(
      `=ARRAYFORMULA(IF(A2:A="",,IF(IFERROR(COUNTIF(${cfg.SHEETS.AI_ANALYSIS}!A2:A, A2:A),0)>0, "YES", "")))`
    );
    sh.getRange("J2").setFormula(
      `=ARRAYFORMULA(IF(A2:A="",,IF(IFERROR(COUNTIF(${cfg.SHEETS.PROCESS_MAPS}!A2:A, A2:A),0)>0, "YES", "")))`
    );

    // Jobs Failed (K) — pulled from Inventory_Recipes column J (10th column).
    // Populates after a sync that includes the newer recipe-metadata columns.
    sh.getRange("K2").setFormula(
      `=ARRAYFORMULA(IF(A2:A="",,IFERROR(VLOOKUP(A2:A, ${cfg.SHEETS.RECIPES}!$A:$J, 10, FALSE), 0)))`
    );

    // Health formatting: STOPPED red, never-run greyed, any failed jobs amber.
    // setConditionalFormatRules replaces the full rule set, so this stays idempotent.
    try {
      sh.setConditionalFormatRules([
        SpreadsheetApp.newConditionalFormatRule()
          .whenTextEqualTo("STOPPED").setBackground("#f4cccc")
          .setRanges([sh.getRange("C2:C")]).build(),
        SpreadsheetApp.newConditionalFormatRule()
          .whenTextEqualTo("NEVER").setBackground("#efefef").setFontColor("#999999")
          .setRanges([sh.getRange("F2:F")]).build(),
        SpreadsheetApp.newConditionalFormatRule()
          .whenNumberGreaterThan(0).setBackground("#fce8b2")
          .setRanges([sh.getRange("K2:K")]).build()
      ]);
    } catch (e) {}

    // Hide helper columns (L:O) so humans don't see plumbing
    sh.hideColumns(12, 4); // L=12, hide L,M,N,O

    // Add a filter for humans (now spans the extra health column)
    try {
      const lastCol = headers.length; // 11 with Jobs Failed
      const lastRow = Math.max(2, sh.getLastRow());
      const range = sh.getRange(1, 1, lastRow, lastCol);
      if (!range.getFilter()) range.createFilter();
    } catch (e) {}

    try { sh.autoResizeColumns(1, headers.length); } catch (e) {}
  }

  // ---------------------------------------------------------------------------------------
  // Friendly-surface polish
  // ---------------------------------------------------------------------------------------
  /** Color tabs by group so the workbook reads as an app, not a schema. */
  static _applyTabColors_(ctx) {
    const cfg = ctx.config;
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const C = {
      primary:   "#188038", // dashboard + curated view
      inventory: "#1a73e8", // raw workspace snapshot
      analysis:  "#8e24aa", // derived relationships
      output:    "#e8710a", // generated results
      input:     "#f9ab00", // you edit this
      system:    "#9aa0a6"  // logs / debug / scratch
    };

    const byKey = {
      DASHBOARD_HOME: C.primary, VIEW_RECIPES: C.primary,
      PROJECTS: C.inventory, FOLDERS: C.inventory, RECIPES: C.inventory,
      PROPERTIES: C.inventory, TABLES: C.inventory, LOOKUP_TABLES: C.inventory,
      DEPENDENCIES: C.analysis, CALL_EDGES: C.analysis,
      AI_ANALYSIS: C.output, PROCESS_MAPS: C.output,
      LOGIC_INPUT: C.input,
      LOGIC: C.system, DEBUG: C.system
    };

    Object.keys(byKey).forEach(k => {
      const name = cfg.SHEETS[k];
      const sh = name && ss.getSheetByName(name);
      if (sh) { try { sh.setTabColor(byKey[k]); } catch (e) {} }
    });

    const tr = ss.getSheetByName("test_results");
    if (tr) { try { tr.setTabColor(C.system); } catch (e) {} }
  }

  /** Hover tooltips (cell notes) on the columns whose names don't explain themselves. */
  static _applyHeaderNotes_(ctx) {
    const cfg = ctx.config;
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const NOTES = {
      RECIPES: {
        "Lifetime Tasks": "Total tasks the recipe has consumed over its lifetime.",
        "Applications": "Trigger + action apps this recipe connects to."
      },
      DEPENDENCIES: {
        "Dependency Type": "Kind of dependency: connection, table, called recipe, etc."
      },
      CALL_EDGES: {
        "Step Path": "Position of the calling step within the recipe's step tree (e.g. 0/1).",
        "Branch Context": "The conditional path the call sits under (IF / ELSE / error), or blank if top-level.",
        "Provider": "The Workato provider that performs the call.",
        "ID Key": "Which input field carried the child recipe id: flow_id, recipe_id, or callable_recipe_id."
      },
      AI_ANALYSIS: {
        "Structured Preview": "Truncated JSON of the full AI result; the complete version is in the linked Drive file.",
        "Graph Metrics": "Node/edge counts and related graph stats, as JSON."
      },
      PROCESS_MAPS: {
        "Depth": "Transitive expansion depth used when building the graph.",
        "Call Graph (Mermaid)": "Mermaid source for the recipe-to-recipe call graph; render it at mermaid.live."
      }
    };

    Object.keys(NOTES).forEach(key => {
      const name = cfg.SHEETS[key];
      const sh = name && ss.getSheetByName(name);
      if (!sh) return;
      const headers = cfg.HEADERS[key] || [];
      const notes = NOTES[key];
      Object.keys(notes).forEach(headerText => {
        const col = headers.indexOf(headerText) + 1;
        if (col > 0) { try { sh.getRange(1, col).setNote(notes[headerText]); } catch (e) {} }
      });
    });
  }

  // ---------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------
  static _ensureOutputSheets_(ss, ctx) {
    // These are referenced by View_Recipes + Dashboard_Home formulas
    this._ensureSheetWithHeaderKey_(ss, ctx, "AI_ANALYSIS", "AI_ANALYSIS");
    this._ensureSheetWithHeaderKey_(ss, ctx, "PROCESS_MAPS", "PROCESS_MAPS");
  }
  static _ensureSheetWithHeaderKey_(ss, ctx, sheetKey, headerKey) {
    const cfg = ctx.config;
    const sheetName = cfg.SHEETS[sheetKey];
    if (!sheetName) return;

    const headers = cfg.HEADERS[headerKey];
    const sh = ctx.sheetService.getOrCreate(sheetKey);

    // If sheet is empty, initialize header row (don't clear existing data)
    if (headers && sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.getRange(1, 1, 1, headers.length)
        .setFontWeight("bold")
        .setBackground(cfg.CONSTANTS.STYLE_HEADER_BG || "#d9d9d9");
      sh.setFrozenRows(1);
    }
  }
  static _setSheetLink_(dashSheet, ss, cellA1, targetSheetName, label) {
    const cell = dashSheet.getRange(cellA1);

    if (!targetSheetName) {
      cell.setValue("Missing target sheet name");
      return;
    }

    const target = ss.getSheetByName(targetSheetName);
    if (!target) {
      cell.setValue(`Missing sheet: ${targetSheetName}`);
      return;
    }

    const gid = target.getSheetId();
    const safeLabel = String(label || targetSheetName).replace(/"/g, '""'); // escape quotes for formulas
    cell.setFormula(`=HYPERLINK("#gid=${gid}", "${safeLabel}")`);
  }
  static _ensureProtection_(sheet, desc, warningOnly) {
    const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET) || [];
    let p = protections.find(x => String(x.getDescription() || "") === desc);
    if (!p) {
      p = sheet.protect();
      p.setDescription(desc);
    }

    // Warning-only avoids permissions headaches in shared sheets
    p.setWarningOnly(Boolean(warningOnly));
  }
  static _getOrCreateSheet_(ss, name) {
    return ss.getSheetByName(name) || ss.insertSheet(name);
  }
}

// ---------------------------------------------------------------------------------------
// Manual entrypoints (optional but useful)
// ---------------------------------------------------------------------------------------
function rebuildDashboard() {
  const ctx = new AppContext();
  DashboardService.ensureAll(ctx, { last_sync_at: new Date().toISOString(), manual: true });
  SpreadsheetApp.getActiveSpreadsheet().toast("Dashboard rebuilt.", "Workato Sync", 3);
}

function applySheetVisibility() {
  const ctx = new AppContext();
  DashboardService.applyVisibility(ctx);
  SpreadsheetApp.getActiveSpreadsheet().toast("Sheet visibility applied.", "Workato Sync", 3);
}
