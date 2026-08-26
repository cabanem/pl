/**
 * @file 10_Feature_Runners.gs
 * @description Feature runners. These own orchestration per capability.
 */

class InventorySyncRunner {
  run(ctx) {
    try {
      ctx.logger.verbose("Starting full workspace sync...");

      const currentUser = ctx.inventoryService.getCurrentUser();
      if (currentUser) console.log(`Authenticated as ${currentUser.name || "Unknown user"}`);

      const projects = ctx.inventoryService.getProjects();
      const folders = ctx.inventoryService.getFoldersRecursive(projects);
      const recipes = ctx.inventoryService.getRecipes();
      const properties = ctx.inventoryService.getProperties();

      // If you added tables in your previous PR, keep these lines.
      const dataTables = ctx.inventoryService.getDataTables ? ctx.inventoryService.getDataTables() : [];
      const lookupTables = ctx.inventoryService.getLookupTables ? ctx.inventoryService.getLookupTables() : [];

      ctx.logger.verbose(
        `Fetched totals: ${projects.length} projects, ${folders.length} folders, ${recipes.length} recipes, ${properties.length} properties, ${dataTables.length} data tables, ${lookupTables.length} lookup tables`
      );

      // Lookup maps
      const projectMap = AppHelpers.createLookupMap(projects);
      const folderMap = AppHelpers.createLookupMap(folders);
      const recipeNameMap = AppHelpers.createLookupMap(recipes);
      const recipeProjectMap = Object.fromEntries(
        (recipes || []).map(r => [String(r.id), projectMap[String(r.project_id)] || ""])
      );
      const dataTableMap = AppHelpers.createLookupMap(dataTables);
      const lookupTableMap = AppHelpers.createLookupMap(lookupTables);
      const tableNameMap = { ...dataTableMap, ...lookupTableMap };

      const cfg = ctx.config;

      const projectRows = [cfg.HEADERS.PROJECTS, ...DataMapper.mapProjectsToRows(projects)];
      const folderRows = [cfg.HEADERS.FOLDERS, ...DataMapper.mapFoldersToRows(folders, folderMap, projectMap)];
      const recipeRows = [cfg.HEADERS.RECIPES, ...DataMapper.mapRecipesToRows(recipes, projectMap, folderMap)];
      const propertyRows = [cfg.HEADERS.PROPERTIES, ...DataMapper.mapPropertiesToRows(properties)];

      // Tables (only if you implemented those mappers/headers)
      const dataTableRows = cfg.HEADERS.TABLES && DataMapper.mapDataTablesToRows
        ? [cfg.HEADERS.TABLES, ...DataMapper.mapDataTablesToRows(dataTables, folderMap)]
        : null;

      const lookupTableRows = cfg.HEADERS.LOOKUP_TABLES && DataMapper.mapLookupTablesToRows
        ? [cfg.HEADERS.LOOKUP_TABLES, ...DataMapper.mapLookupTablesToRows(lookupTables, projectMap)]
        : null;

      // Dependencies + call edges
      let dependencyRows = [cfg.HEADERS.DEPENDENCIES];
      let callEdgeRows = [cfg.HEADERS.CALL_EDGES];
      const depLimit = cfg.API.RECIPE_LIMIT_DEBUG;

      recipes.forEach((recipe, index) => {
        if (index >= depLimit) return;

        const rawDeps = ctx.analyzerService.getDependencies(recipe.id);
        if (rawDeps.length > 0) {
          const rows = DataMapper.mapDependenciesToRows.length >= 5
            ? DataMapper.mapDependenciesToRows(recipe, rawDeps, projectMap, folderMap, tableNameMap)
            : DataMapper.mapDependenciesToRows(recipe, rawDeps, projectMap, folderMap);
          dependencyRows = dependencyRows.concat(rows);
        }

        const callEdges = ctx.analyzerService.getCallEdges(recipe.id);
        if (callEdges.length > 0) {
          callEdgeRows = callEdgeRows.concat(
            DataMapper.mapCallEdgesToRows(recipe, callEdges, projectMap, folderMap, recipeNameMap, recipeProjectMap)
          );
        }

        if (index % 10 === 0) Utilities.sleep(50);
      });

      ctx.logger.verbose("Writing to Sheets...");
      ctx.sheetService.write("PROJECTS", projectRows);
      ctx.sheetService.write("FOLDERS", folderRows);
      ctx.sheetService.write("RECIPES", recipeRows);
      ctx.sheetService.write("PROPERTIES", propertyRows);

      if (dataTableRows) ctx.sheetService.write("TABLES", dataTableRows);
      if (lookupTableRows) ctx.sheetService.write("LOOKUP_TABLES", lookupTableRows);

      ctx.sheetService.write("DEPENDENCIES", dependencyRows);
      ctx.sheetService.write("CALL_EDGES", callEdgeRows);

      ctx.logger.notify("Sync complete. Workspace inventory updated...", false);

      // Dashboard automation (UX-only)
      if (ctx.config.DASHBOARD && ctx.config.DASHBOARD.ENABLE) {
        DashboardService.postInventorySync(ctx, {
          projects: projects.length,
          folders: folders.length,
          recipes: recipes.length,
          properties: properties.length,
          data_tables: dataTables.length,
          lookup_tables: lookupTables.length,
          dependencies: Math.max(0, dependencyRows.length - 1), // exclude header
          call_edges: Math.max(0, callEdgeRows.length - 1)      // exclude header
        });
      }
    } catch (e) {
      AppHelpers.handleError(e);
    }
  }
}

class LogicDebugRunner {
  run(ctx, idsOverride = null) {
    try {
      ctx.logger.verbose("Starting recipe logic debugging...");

      const requestedIds = (Array.isArray(idsOverride) && idsOverride.length > 0)
        ? idsOverride
        : ctx.sheetService.readRequests();

      if (requestedIds.length === 0) {
        ctx.logger.notify("No recipe IDs found (select rows with IDs, or use 'logic_requests').", true);
        return;
      }
      ctx.logger.notify(`Fetching logic for ${requestedIds.length} recipes...`);

      const logicRows = [ctx.config.HEADERS.LOGIC];
      const debugLogs = [];

      requestedIds.forEach((reqId, index) => {
        try {
          const fullRecipe =
            ctx.analyzerService.getRecipeDetails(reqId) ||
            ctx.client.get(`recipes/${reqId}`);
          const recipeName = fullRecipe.name || "Unknown";

          // A. Save to Drive
          let driveUrl = "";
          if (ctx.config.DEBUG.LOG_TO_DRIVE) {
            driveUrl = ctx.driveService.saveLog(reqId, fullRecipe.name, fullRecipe);
          }

          // B. Emit to Sheet
          if (ctx.config.DEBUG.LOG_TO_SHEET) {
            debugLogs.push({ id: reqId, name: recipeName, driveUrl: driveUrl });
          }

          // C. Parse
          const parsedRows = ctx.analyzerService.parseLogicRows(fullRecipe);
          logicRows.push(...parsedRows);

        } catch (e) {
          console.warn(`Failed ID ${reqId}: ${e.message}`);
          logicRows.push([reqId, "ERROR", "-", "-", "-", "-", String(e.message || e), "-"]);
        }

        if (index % 5 === 0) Utilities.sleep(ctx.config.API.THROTTLE_MS);
      });

      ctx.logger.verbose("Writing data to sheets...");
      ctx.sheetService.write("LOGIC", logicRows);

      const debugRows = DataMapper.mapDebugLogsToRows(debugLogs);
      ctx.sheetService.appendDebugRows(debugRows);

      ctx.logger.notify("Logic debugging complete.");
    } catch (e) {
      AppHelpers.handleError(e);
    }
  }
}

class AiAnalysisRunner {
  run(ctx, idsOverride = null) {
    const gemini = new GeminiService();
    const ids = (Array.isArray(idsOverride) && idsOverride.length > 0)
      ? idsOverride
      : ctx.sheetService.readRequests();

    if (ids.length === 0) {
      ctx.logger.notify("No recipe IDs found (select rows with IDs, or use 'logic_requests').");
      return;
    }

    const cfg = ctx.config;
    const charLimit = cfg.CONSTANTS.CELL_CHAR_LIMIT || 48000;
    const maxLines = Number(cfg.VERTEX.LOGIC_DIGEST_MAX_LINES || 220);
    const depth = Number(cfg.API.PROCESS_MAP_DEPTH ?? 2);
    const maxNodes = Number(cfg.API.PROCESS_MAP_MAX_NODES ?? 250);

    const rows = [cfg.HEADERS.AI_ANALYSIS];

    // ***UPDATED*** Merge: preserve analyses for recipes NOT in this run — the previous write rebuilt the
    // sheet from only this run's ids, so analyzing X wiped yesterday's rows for Y and Z. Old rows are
    // padded to the new 16-column header width. (This is the block that was mispasted into
    // ProcessMapsRunner; the corrected version lives here, where `ids` and `cfg` exist.)
    const idSet = new Set(ids.map(String));
    const width = cfg.HEADERS.AI_ANALYSIS.length;
    new ChangeLedgerRunner().readRows_('AI_ANALYSIS')
      .filter(r => r[0] && !idSet.has(String(r[0])))
      .forEach(r => { while (r.length < width) r.push(''); rows.push(r); });
    const fpMap = AiGate.fpMap(); // ***UPDATED*** current code fingerprints, stamped onto each new row

    ids.forEach((id, idx) => {
      ctx.logger.notify(`Asking Gemini to analyze Recipe ${id}...`);
      try {
        const recipe =
          ctx.analyzerService.getRecipeDetails(id) ||
          ctx.client.get(`recipes/${id}`);
        const name = recipe?.name || "";

        const graphPack = ctx.analyzerService.buildGraphPack(id, { callDepth: depth, maxNodes, edgeSampleLimit: 70 });

        const logicRows = ctx.analyzerService.parseLogicRows(recipe);
        const digest = AppHelpers.logicDigestFromRows(logicRows, maxLines);

        const structured = gemini.explainRecipeStructured(recipe, graphPack, digest);

        const objective = String(structured.objective || "");
        const trigger = String(structured.trigger || "");
        const flow = Array.isArray(structured.high_level_flow) ? structured.high_level_flow.join("\n") : String(structured.high_level_flow || "");
        const hotspots = Array.isArray(structured.hotspots) ? structured.hotspots.join("\n") : String(structured.hotspots || "");
        const externalApps = Array.isArray(structured.external_apps) ? structured.external_apps.join("\n") : String(structured.external_apps || "");
        const calledRecipes = Array.isArray(structured.called_recipes) ? structured.called_recipes.join("\n") : String(structured.called_recipes || "");
        const risks = Array.isArray(structured.risks_notes) ? structured.risks_notes.join("\n") : String(structured.risks_notes || "");

        const rawPreview = JSON.stringify(structured, null, 2).slice(0, 4000);

        const aiUrl = ctx.driveService.saveText(id, name || `recipe_${id}`, "ai.json", JSON.stringify(structured, null, 2));
        const callsUrl = ctx.driveService.saveText(id, name || `recipe_${id}`, "calls.mmd", graphPack?.call?.mermaid || "");
        const fullUrl = ctx.driveService.saveText(id, name || `recipe_${id}`, "full.mmd", graphPack?.process?.mermaid || "");

        const aiLink = aiUrl ? `=HYPERLINK("${aiUrl}", "View AI full")` : "";
        const callsLink = callsUrl ? `=HYPERLINK("${callsUrl}", "View calls mermaid")` : "";
        const fullLink = fullUrl ? `=HYPERLINK("${fullUrl}", "View full mermaid")` : "";

        const preview = rawPreview.length >= 4000
          ? rawPreview + "\n…(truncated preview; see Drive link)"
          : rawPreview;

        const metricsJson = JSON.stringify({
          call: {
            depth: graphPack?.call?.depth,
            node_count: graphPack?.call?.node_count,
            edge_count: graphPack?.call?.edge_count
          },
          process: {
            node_count: graphPack?.process?.node_count,
            edge_count: graphPack?.process?.edge_count,
            kind_counts: graphPack?.process?.kind_counts,
            call_targets: graphPack?.process?.call_targets
          }
        });

        rows.push([
          String(recipe?.id || id),
          name,
          objective,
          trigger,
          flow,
          hotspots,
          externalApps,
          calledRecipes,
          risks,
          preview,
          metricsJson.length > charLimit ? metricsJson.slice(0, 2000) + "…(truncated)" : metricsJson,
          aiLink,
          callsLink,
          fullLink,
          fpMap.get(String(recipe?.id || id)) || '', // ***UPDATED*** Source FP (col 15) — the gate's comparison key
          new Date().toISOString()
        ]);

      } catch (e) {
        console.error(e);
        const errRow = Array(cfg.HEADERS.AI_ANALYSIS.length).fill("");
        errRow[0] = String(id);
        errRow[1] = "Error";
        errRow[2] = String(e.message || e);
        errRow[14] = fpMap.get(String(id)) || ''; // ***UPDATED*** Source FP — deliberate: failures re-run on change or manual force, not nightly
        errRow[15] = new Date().toISOString();    // ***UPDATED*** Timestamp moved to its own (new) column
        rows.push(errRow);
      }

      if (idx % 2 === 0) Utilities.sleep(cfg.API.THROTTLE_MS);
    });

    ctx.sheetService.write("AI_ANALYSIS", rows);
    ctx.logger.notify("AI analysis complete.");
  }
}
// ***UPDATED*** AiGate rewritten. The earlier draft (plan(recipes, …)) expected a recipes list the
// runner never has, and read the analysis tab by its literal key. This version matches how the runner
// actually works: cron_ai asks staleIds() for candidates and passes them as idsOverride; the runner
// itself never knows the gate exists. Reads go through ChangeLedgerRunner's key-resolved readers.
class AiGate {
  /** Index of "Source FP" in HEADERS.AI_ANALYSIS (16 columns, 0-based). */
  static get SOURCE_FP_COL() { return 14; }

  /** Recipes whose ledger code_fp differs from the analysis row's Source FP (or that have no row). */
  static staleIds(cap) {
    const led = new ChangeLedgerRunner();
    const fresh = led.readFingerprints_();               // id -> {name, fp}
    const analyzed = new Map();
    led.readRows_('AI_ANALYSIS').forEach(r => {
      if (r[0]) analyzed.set(String(r[0]), String(r[AiGate.SOURCE_FP_COL] || ''));
    });
    const stale = [];
    fresh.forEach((v, id) => { if (analyzed.get(id) !== v.fp) stale.push(id); });
    return stale.slice(0, Number(cap || 10));
  }

  /** id -> current code_fp, for stamping generated rows. */
  static fpMap() {
    const m = new Map();
    new ChangeLedgerRunner().readFingerprints_().forEach((v, id) => m.set(id, v.fp));
    return m;
  }
}

class ProcessMapsRunner {
  run(ctx, options = {}, idsOverride = null) {
    try {
      ctx.logger.verbose("Starting process map generation (v2 - Library)...");

      const requestedIds = (Array.isArray(idsOverride) && idsOverride.length > 0)
        ? idsOverride
        : ctx.sheetService.readRequests();

      if (requestedIds.length === 0) {
        ctx.logger.notify("No recipe IDs found (select rows with IDs, or use 'logic_requests').", true);
        return;
      }

      const mode = String(options.mode || ctx.config.API.PROCESS_MAP_MODE_DEFAULT || "calls+full");
      const depth = Number(options.callDepth ?? ctx.config.API.PROCESS_MAP_DEPTH ?? 0);
      const maxNodes = Number(options.maxNodes ?? ctx.config.API.PROCESS_MAP_MAX_NODES ?? 250);
      const CHAR_LIMIT = ctx.config.CONSTANTS.CELL_CHAR_LIMIT || 48000;

      const rows = [ctx.config.HEADERS.PROCESS_MAPS];

      // ***UPDATED*** removed a mispasted merge block here — it referenced `ids` and `cfg` (undefined in
      // this runner: they're `requestedIds` and `ctx.config`), called a non-existent `.hasString()`, and
      // merged AI_ANALYSIS rows into the PROCESS_MAPS sheet. The corrected block lives in
      // AiAnalysisRunner, the runner it was written for.

      requestedIds.forEach((rootId, idx) => {
        const pack = ctx.analyzerService.buildGraphPack(rootId, { callDepth: depth, maxNodes: maxNodes });

        const rootName = pack.root_name || "";
        let callMermaid = "";
        let fullMermaid = "";
        let notes = [];
        let callDriveLink = "";
        let fullDriveLink = "";

        if (mode.includes("calls")) {
          callMermaid = pack.call.mermaid || "";
          notes = notes.concat(pack.call.notes || []);

          if (callMermaid.length > CHAR_LIMIT) {
            const url = ctx.driveService.saveText(rootId, rootName, "calls.mmd", callMermaid);
            callDriveLink = url ? `=HYPERLINK("${url}", "View calls mermaid")` : "Save failed";
            callMermaid = callMermaid.substring(0, CHAR_LIMIT - 200) + "\n...(TRUNCATED)";
            notes.push("Calls mermaid truncated.");
          }
        }

        if (mode.includes("full")) {
          fullMermaid = pack.process.mermaid || "";
          notes = notes.concat(pack.process.notes || []);

          if (fullMermaid.length > CHAR_LIMIT) {
            const url = ctx.driveService.saveText(rootId, rootName, "full.mmd", fullMermaid);
            fullDriveLink = url ? `=HYPERLINK("${url}", "View full mermaid")` : "Save failed";
            fullMermaid = fullMermaid.substring(0, CHAR_LIMIT - 200) + "\n...(TRUNCATED)";
            notes.push("Full mermaid truncated.");
          }
        }

        rows.push([
          String(rootId),
          rootName,
          mode,
          String(depth),
          callMermaid,
          fullMermaid,
          notes.slice(0, 20).join("\n"),
          callDriveLink,
          fullDriveLink,
          new Date().toISOString()
        ]);

        if (idx % 2 === 0) Utilities.sleep(ctx.config.API.THROTTLE_MS);
      });

      ctx.sheetService.write("PROCESS_MAPS", rows);
      ctx.logger.notify("Process maps generated.");
    } catch (e) {
      AppHelpers.handleError(e);
    }
  }
}

class CompanionDocRunner {
  run(ctx, idsOverride = null) {
    const gemini = new GeminiService();
    const ids = (Array.isArray(idsOverride) && idsOverride.length > 0)
      ? idsOverride
      : ctx.sheetService.readRequests();

    if (ids.length === 0) {
      ctx.logger.notify("No recipe IDs found.");
      return;
    }

    ctx.logger.notify(`Generating aggregated document for ${ids.length} recipes...`);

    const cfg = ctx.config;
    const depth = Number(cfg.API.PROCESS_MAP_DEPTH ?? 2);
    const maxNodes = Number(cfg.API.PROCESS_MAP_MAX_NODES ?? 250);
    const maxLines = Number(cfg.VERTEX.LOGIC_DIGEST_MAX_LINES || 220);

    const analyzedRecipes = [];

    // 1. Collect AI Analysis for each recipe
    ids.forEach((id, idx) => {
      try {
        const recipe = ctx.analyzerService.getRecipeDetails(id) || ctx.client.get(`recipes/${id}`);
        const name = recipe?.name || "Unknown Recipe";

        const graphPack = ctx.analyzerService.buildGraphPack(id, { callDepth: depth, maxNodes, edgeSampleLimit: 70 });
        const logicRows = ctx.analyzerService.parseLogicRows(recipe);
        const digest = AppHelpers.logicDigestFromRows(logicRows, maxLines);

        const structured = gemini.explainRecipeStructured(recipe, graphPack, digest);

        analyzedRecipes.push({ id, name, data: structured });
      } catch (e) {
        console.error(`Failed to analyze recipe ${id}:`, e);
      }

      if (idx % 2 === 0) Utilities.sleep(cfg.API.THROTTLE_MS);
    });

    // 2. Assemble the Markdown Document
    const markdownText = this._generateMarkdown(analyzedRecipes);

    // 3. Save to Google Drive
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmm");
    const docUrl = ctx.driveService.saveMarkdownAsDoc("Batch", `Companion_Doc_${timestamp}`, markdownText);

    if (docUrl) {
      ctx.logger.notify(`Document saved to Drive!`, false);

      // A. Write a permanent record to the System_Logs sheet
      if (cfg.DEBUG.LOG_TO_SHEET) {
        ctx.sheetService.appendDebugRows([
          [
            new Date().toISOString(),
            "Batch Run",
            "Aggregated Documentation",
            "Saved to Drive",
            `=HYPERLINK("${docUrl}", "View Document")`
          ]
        ]);
      }

      // B. Show the clickable modal to the user
      try {
        const ui = new UserInterfaceService();
        ui.showLinkModal(
          "Generation Complete",
          "Your AI-generated document has been successfully created.",
          docUrl
        );
      } catch (e) {
        // Failsafe in case this is run on a time-driven trigger without a UI
        console.warn("Could not display UI modal. Document URL: " + docUrl);
      }

    } else {
      ctx.logger.notify("Failed to save Document to Drive.", true);
    }
  }

  _generateMarkdown(recipes) {
    let md = "# Workato recipe functionality and behavior overview\n\n";

    // Build Index
    md += "## Index\n";
    recipes.forEach((r, i) => {
      md += `${i + 1}. ${r.name} (ID: ${r.id})\n`;
    });

    md += "\n## Recipes\n";

    // Build Details
    recipes.forEach((r, i) => {
      const d = r.data;
      md += `### ${i + 1}. ${r.name} (ID: ${r.id})\n`;
      md += `**Objective:** ${d.objective || "N/A"}\n\n`;
      md += `**Trigger:** ${d.trigger || "N/A"}\n\n`;

      const flow = Array.isArray(d.high_level_flow) ? d.high_level_flow.join(" ") : String(d.high_level_flow || "");
      md += `**High-Level Flow:** ${flow}\n\n`;

      if (d.called_recipes && d.called_recipes.length > 0) {
        const deps = Array.isArray(d.called_recipes) ? d.called_recipes.join(", ") : String(d.called_recipes);
        md += `**Dependencies:** ${deps}\n\n`;
      }

      const apps = Array.isArray(d.external_apps) ? d.external_apps.join(", ") : String(d.external_apps || "");
      md += `**External Apps:** ${apps}\n\n`;

      if (d.hotspots && d.hotspots.length > 0) {
        const hot = Array.isArray(d.hotspots) ? d.hotspots.join(" ") : String(d.hotspots);
        md += `**Hotspots:** ${hot}\n\n`;
      }

      const risks = Array.isArray(d.risks_notes) ? d.risks_notes.join(" ") : String(d.risks_notes || "");
      md += `**Risks & Notes:** ${risks}\n\n`;

      md += "---\n\n";
    });

    return md;
  }
}

class SystemDocRunner {
  run(ctx, idsOverride = null) {
    const gemini = new GeminiService();
    const ids = (Array.isArray(idsOverride) && idsOverride.length > 0)
      ? idsOverride
      : ctx.sheetService.readRequests();

    if (ids.length === 0) {
      ctx.logger.notify("No recipe IDs found.");
      return;
    }

    ctx.logger.notify(`Analyzing system architecture for ${ids.length} recipes...`);

    const cfg = ctx.config;
    // Keep max lines lower for system docs to save context window space
    const maxLines = 50;

    const recipesData = [];
    let allEdges = [];

    // 1. Gather all data
    ids.forEach((id, idx) => {
      try {
        const recipe = ctx.analyzerService.getRecipeDetails(id) || ctx.client.get(`recipes/${id}`);
        const name = recipe?.name || "Unknown Recipe";

        // Depth 1 is fine here because we are scanning the selected batch
        const graphPack = ctx.analyzerService.buildGraphPack(id, { callDepth: 1, maxNodes: 100 });
        const logicRows = ctx.analyzerService.parseLogicRows(recipe);
        const digest = AppHelpers.logicDigestFromRows(logicRows, maxLines);

        recipesData.push({
          id,
          name,
          trigger: recipe.trigger_application || "Unknown",
          description: recipe.description || "",
          logic_summary: digest
        });

        // Collect call edges
        if (graphPack && graphPack.call && graphPack.call.edges_sample) {
          allEdges = allEdges.concat(graphPack.call.edges_sample);
        }
      } catch (e) {
        console.error(`Failed to analyze recipe ${id}:`, e);
      }

      if (idx % 2 === 0) Utilities.sleep(cfg.API.THROTTLE_MS);
    });

    // Deduplicate edges so the LLM doesn't get confused by overlapping paths
    const uniqueEdges = [...new Set(allEdges)];

    // 2. Ask Gemini for the System Architecture Document
    ctx.logger.notify("Sending aggregated data to Gemini...");
    const markdownText = gemini.generateSystemDoc(recipesData, uniqueEdges);

    // 3. Save to Google Drive
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmm");
    const docUrl = ctx.driveService.saveMarkdownAsDoc("System", `Architecture_Overview_${timestamp}`, markdownText);

    if (docUrl) {
      ctx.logger.notify(`Document saved to Drive!`, false);

      // A. Write a permanent record to the System_Logs sheet
      if (cfg.DEBUG.LOG_TO_SHEET) {
        ctx.sheetService.appendDebugRows([
          [
            new Date().toISOString(),
            "Batch Run",
            "Aggregated Documentation",
            "Saved to Drive",
            `=HYPERLINK("${docUrl}", "View Document")`
          ]
        ]);
      }

      // B. Show the clickable modal to the user
      try {
        const ui = new UserInterfaceService();
        ui.showLinkModal(
          "Generation Complete",
          "Your AI-generated document has been successfully created.",
          docUrl
        );
      } catch (e) {
        // Failsafe in case this is run on a time-driven trigger without a UI
        console.warn("Could not display UI modal. Document URL: " + docUrl);
      }

    } else {
      ctx.logger.notify("Failed to save Document to Drive.", true);
    }
  }
}
