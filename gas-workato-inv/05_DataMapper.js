/**
 * @file 05_DataMapper.gs
 */
/**
 * @class
 * @classdesc Pure utility class for transforming raw API data into 2D arrays for Google Sheets.
 * Decouples business logic (Controllers) from I/O logic (SheetService).
 */
class DataMapper {
  /**
   * Transforms Project objects into sheet rows.
   * @param {Array<Object>} projects - Raw API response.
   * @returns {Array<Array<string>>}
   */
  static mapProjectsToRows(projects) {
    return projects.map(p => [p.id, p.name, p.description, p.created_at]);
  }
  /**
   * Transforms Folder objects into sheet rows, resolving Parent/Project names.
   * @param {Array<Object>} folders - Raw API response.
   * @param {Object} folderMap - Lookup {id: name}.
   * @param {Object} projectMap - Lookup {id: name}.
   * @returns {Array<Array<string>>}
   */
  static mapFoldersToRows(folders, folderMap, projectMap) {
    return folders.map(f => {
      let parentName = "TOP LEVEL";
      if (f.is_project) parentName = "Workspace Root (Home)";
      else if (f.parent_id) parentName = DataMapper._safeLookup(folderMap, f.parent_id);
      
      const projectName = DataMapper._safeLookup(projectMap, f.project_id);
      return [f.id, f.name, parentName, projectName];
    });
  }
  /**
   * Transforms Recipe objects into sheet rows.
   * Columns 1-6 are the original inventory fields; columns 7+ surface additional
   * metadata that the List recipes endpoint already returns (same fields as
   * Get recipe details): version, last-updated, job counts, and combined apps.
   * @param {Array<Object>} recipes - Raw API response.
   * @param {Object} projectMap - Lookup {id: name}.
   * @param {Object} folderMap - Lookup {id: name}.
   * @returns {Array<Array<string>>}
   */
  static mapRecipesToRows(recipes, projectMap, folderMap) {
    return recipes.map(r => [
      r.id,
      r.name,
      r.running ? "ACTIVE" : "STOPPED",
      DataMapper._safeLookup(projectMap, r.project_id),
      DataMapper._safeLookup(folderMap, r.folder_id),
      r.last_run_at || "NEVER",
      // --- workspace metadata (from the list endpoint) ---
      // Use ?? (not ||) for counts so a real 0 is preserved rather than blanked.
      r.version_no ?? "",
      r.updated_at || "",
      r.job_succeeded_count ?? "",
      r.job_failed_count ?? "",
      r.lifetime_task_count ?? "",
      Array.isArray(r.applications) ? r.applications.join(", ") : ""
    ]);
  }
  /**
   * Transforms Property objects into sheet rows.
   * @param {Array<Object>} properties - Raw API response.
   * @returns {Array<Array<string>>}
   */
  static mapPropertiesToRows(properties) {
    return properties.map(p => [p.id, p.name, p.value, p.created_at, p.updated_at]);
  }
  // Data tables: schema is an array
  static mapDataTablesToRows(dataTables, folderMap = null) {
    return (dataTables || []).map(t => {
      const cols = DataMapper._columnsFromAnySchema_(t.schema);
      const folderNote = t.folder_id
        ? `Folder: ${DataMapper._safeLookup(folderMap, t.folder_id)}`
        : "";
      const desc = [String(t.description || ""), folderNote].filter(Boolean).join(" | ");
      return [
        String(t.id || ""),
        String(t.name || ""),
        desc,
        cols,
        "", // record count not provided by list endpoint
        String(t.updated_at || "")
      ];
    });
  }
  // Lookup tables: schema is a JSON string
  static mapLookupTablesToRows(lookupTables, projectMap = null) {
    return (lookupTables || []).map(t => {
      const cols = DataMapper._columnsFromAnySchema_(t.schema);
      const scopeNote = t.project_id
        ? `Project: ${DataMapper._safeLookup(projectMap, t.project_id)}`
        : "Scope: Global";
      const desc = [String(t.description || ""), scopeNote].filter(Boolean).join(" | ");
      return [
        String(t.id || ""),
        String(t.name || ""),
        desc,
        cols,
        "", // record count not provided by list endpoint
        String(t.updated_at || "")
      ];
    });
  }
  /**
   * Transforms dependency objects (calculated in Analyzer) into sheet rows.
   * @param {Object} recipe - The parent recipe object.
   * @param {Array<Object>} dependencies - List of deps {type, id, name}.
   * @param {Object} projectMap - Lookup.
   * @param {Object} folderMap - Lookup.
   * @returns {Array<Array<string>>}
   */
  static mapDependenciesToRows(recipe, dependencies, projectMap, folderMap, tableNameMap = null) {
    const projectName = DataMapper._safeLookup(projectMap, recipe.project_id);
    const folderName = DataMapper._safeLookup(folderMap, recipe.folder_id);

    return dependencies.map(dep => {
      const depName =
        String(dep.name || "") ||
        String(
          (tableNameMap && /table/i.test(String(dep.type || "")))
            ? (tableNameMap[String(dep.id)] || "")
            : ""
        );
      return [String(recipe.id), projectName, folderName, String(dep.type || ""), String(dep.id || ""), depName];
    });

  }
  /**
   * Transforms a batch of debug log entries into rows.
   * Handles "Chunking" of large JSON strings to fit into cell limits.
   * * @param {Array<Object>} logEntries - Objects {id, name, json, driveUrl, status}.
   * @returns {Array<Array<string>>}
   */
  static mapDebugLogsToRows(logEntries) {
    const config = AppConfig.get();
    const CHAR_LIMIT = config.CONSTANTS.CELL_CHAR_LIMIT || 48000;
    const LOG_TO_DRIVE = config.DEBUG.LOG_TO_DRIVE;

    return logEntries.map(log => {
      const timestamp = new Date().toISOString();
      
      // Handle Drive status, hyperlink
      let status = log.status || "OK";
      let driveLink = "Not saved";

      if (LOG_TO_DRIVE) {
        if (log.driveUrl) {
          status = "Saved to Drive";
          driveLink = `=HYPERLINK("${log.driveUrl}", "View JSON")`;
        } else if (!log.status) {
          status = "Drive error";
        }
      }

      const row = [timestamp, log.id, log.name, status, driveLink];

      // Handle JSON body
      if (log.json) {
        const jsonString = typeof log.json === 'string' ? log.json : JSON.stringify(log.json, null, 2);
        if (jsonString.length <= CHAR_LIMIT) {
          row.push(jsonString);
        } else {
          let offset = 0;
          while (offset < jsonString.length) {
            row.push(jsonString.substring(offset, offset + CHAR_LIMIT));
            offset += CHAR_LIMIT;
          }
        }
      }
      return row;
    });
  }
  /**
   * Transforms recipe call edge objects into sheet rows.
   * @param {Object} recipe - Parent recipe (from /recipes list).
   * @param {Array<Object>} edges - Call edge objects from RecipeAnalyzerService.getCallEdges().
   * @param {Object} projectMap - Lookup.
   * @param {Object} folderMap - Lookup.
   * @param {Object} recipeNameMap - Lookup {id: name} for child recipe name resolution.
   * @returns {Array<Array<string>>}
   */
  static mapCallEdgesToRows(recipe, edges, projectMap, folderMap, recipeNameMap) {
    const projectName = DataMapper._safeLookup(projectMap, recipe.project_id);
    const folderName = DataMapper._safeLookup(folderMap, recipe.folder_id);

    return (edges || []).map(e => ([
      String(e.parent_recipe_id || recipe.id || ""),
      String(e.parent_recipe_name || recipe.name || ""),
      projectName,
      folderName,
      String(e.step_path || ""),
      String(e.step_name || ""),
      String(e.branch_context || ""),
      String(e.provider || ""),
      String(e.child_recipe_id || ""),
      DataMapper._safeLookup(recipeNameMap, e.child_recipe_id),
      String(e.id_key || "")
    ]));
  }
  /**
   * Transforms a process graph's nodes into sheet rows.
   * @param {string|number} rootId
   * @param {string} rootName
   * @param {{ nodes: Map<string, any> }} graph
   * @returns {Array<Array<string>>}
   */
  static mapProcessNodesToRows(rootId, rootName, graph) {
    const rows = [];
    const nodes = graph?.nodes ? Array.from(graph.nodes.values()) : [];
    nodes.forEach(n => {
      rows.push([
        String(rootId || ""),
        String(rootName || ""),
        String(n.id || ""),
        String(n.step_path || ""),
        String(n.kind || ""),
        String(n.provider || ""),
        String(n.label || ""),
        String(n.branch_context || "")
      ]);
    });
    return rows;
  }
  /**
   * Transforms a process graph's edges into sheet rows.
   * @param {string|number} rootId
   * @param {{ edges: Array<any> }} graph
   * @returns {Array<Array<string>>}
   */
  static mapProcessEdgesToRows(rootId, graph) {
    const rows = [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    edges.forEach(e => {
      rows.push([
        String(rootId || ""),
        String(e.from || ""),
        String(e.to || ""),
        String(e.label || ""),
        String(e.kind || "")
      ]);
    });
    return rows;
  }

  // --- INTERNALS ---------------------------------------------------------------------------------------
  static _columnsFromAnySchema_(schema) {
    // Lookup tables: schema is a stringified JSON array
    if (typeof schema === "string") {
      try {
        const arr = JSON.parse(schema);
        if (Array.isArray(arr)) {
          return arr.map(c => c.label || c.name).filter(Boolean).join(", ");
        }
      } catch (e) {
        return "";
      }
      return "";
    }
    // Data tables: schema is an array of objects
    if (Array.isArray(schema)) {
      return schema.map(c => c.name).filter(Boolean).join(", ");
    }
    // Some APIs might return columns: [...]
    if (schema && Array.isArray(schema.columns)) {
      return schema.columns.map(c => c.name).filter(Boolean).join(", ");
    }
    return "";
  }
  /**
   * Safely looks up an ID in a map, returning a fallback if missing.
   * @private
   */
  static _safeLookup(map, id) {
    if (!id) return "-";
    const strId = String(id);
    return map && map[strId] ? map[strId] : `[ID: ${id}]`;
  }
}