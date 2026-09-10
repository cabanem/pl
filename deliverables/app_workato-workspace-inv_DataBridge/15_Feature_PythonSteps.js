/**
 * @file 15_Feature_PythonSteps.gs
 * @description Python step inventory. One row per `py_eval` step in the workspace, the code saved to Drive as .py,
 *              and a manifest.json holding the full structured record per step (code, both schemas, the input
 *              mapping, who feeds it, who reads it). Input to the Python -> Ruby connector design.
 *
 *   Two classes, one seam:
 *     PythonStepAnalyzer -- pure. Turns a located step (from GraphLib.collectSteps) into a record. No I/O, no GAS
 *       services; the two things it needs from outside (a sha256, a pill-ref extractor) are injected, so it tests
 *       hermetically and its output is byte-for-byte reproducible.
 *     PythonStepsRunner  -- orchestration, same shape as the other runners: fetch, prime cache, walk, map, write.
 *
 *   Why the recipe-level pre-filter: the list endpoint's `applications` array names every provider a recipe uses, so
 *   recipes without "py_eval" are skipped before any code is parsed. Recipes with no `applications` field are kept
 *   (the walk simply finds nothing), so an API shape change degrades to "slower", never to "silently incomplete".
 *
 *   Contract with the recipe JSON (pinned against recipe 2071421 TPL-02 Build XLSX, Aug 2026):
 *     step.provider                         "py_eval"
 *     step.name                             "invoke_custom_py_code"
 *     step.as                               alias; datapills reference it as `line`
 *     step.input.code                       the Python source
 *     step.input.name                       the step's display name (step.description is HTML)
 *     step.input.code_output_schema_json    JSON string: array of output fields
 *     step.input.code_input.schema          JSON string: array of input fields
 *     step.input.code_input.data            { field_name: mapped value } -- datapills or literals
 *     step.input.payload_asset_type         "inline" (anything else means the code is not in the JSON: flagged)
 *     step.extended_*_schema                parsed mirrors of the two strings; ignored here
 *   Output datapills read a Python step as path ["output", <field>, ...].
 */

/** Provider/action names of the Workato Python connector, as they appear in recipe code. */
const PY_STEP = Object.freeze({
  PROVIDER: "py_eval",
  ACTION: "invoke_custom_py_code",
  OUTPUT_ROOT: "output",
  INLINE: "inline"
});

// -------------------------------------------------------------------------------------------------------
// ANALYZER (pure)
// -------------------------------------------------------------------------------------------------------
class PythonStepAnalyzer {

  /** True for a Workato Python step. */
  static isPythonStep(step) {
    return Boolean(step) && step.provider === PY_STEP.PROVIDER;
  }

  /**
   * Builds the record for one located Python step.
   *
   * @param {Object} recipe        - Full recipe object (list endpoint or getRecipeDetails).
   * @param {{step:Object, step_path:string, branch_context:string}} located - One entry from collectSteps.
   * @param {Array<{step:Object, step_path:string}>} allSteps - Every step of the recipe (collectSteps with no predicate),
   *                                                             used to resolve upstream aliases and find consumers.
   * @param {{sha256:Function, pillRefs:Function}} deps - Injected: sha256(str)->hex, pillRefs(value)->[{provider,line,path}].
   * @param {{project?:string, folder?:string}} [names] - Display names resolved by the caller (from the RECIPES tab).
   * @returns {Object} record (see manifest shape in the file header)
   */
  static describe(recipe, located, allSteps, deps, names = {}) {
    const step = located.step || {};
    const input = step.input || {};
    const code = String(input.code || "");
    const codeInput = input.code_input || {};

    const inputSchema = PythonStepAnalyzer.parseSchemaJson(codeInput.schema);
    const outputSchema = PythonStepAnalyzer.parseSchemaJson(input.code_output_schema_json);
    const mapping = (codeInput.data && typeof codeInput.data === "object") ? codeInput.data : {};

    const aliasIndex = PythonStepAnalyzer.aliasIndex(allSteps, recipe);
    const upstream = deps.pillRefs(mapping).map(r => ({
      provider: r.provider,
      line: r.line,
      path: r.path,
      step_name: aliasIndex[r.line] || ""
    }));
    const consumers = PythonStepAnalyzer.consumersOf(step.as, allSteps, deps.pillRefs);
    const defs = PythonStepAnalyzer.scanDefs(code);
    const payload = String(input.payload_asset_type || "");

    return {
      recipe_id: String(recipe.id || ""),
      recipe_name: String(recipe.name || ""),
      recipe_kind: PythonStepAnalyzer.recipeKind(recipe),
      recipe_running: Boolean(recipe.running),
      recipe_version_no: recipe.version_no ?? "",
      project: names.project || "",
      folder: names.folder || "",
      function_contract: PythonStepAnalyzer.functionContract(recipe),
      step: {
        number: step.number ?? "",
        step_path: located.step_path || "",
        branch_context: located.branch_context || "",
        as: String(step.as || ""),
        name: String(input.name || step.name || ""),
        comment: String(step.comment || ""),
        uuid: String(step.uuid || ""),
        payload_asset_type: payload,
        inline: payload === PY_STEP.INLINE
      },
      code: code,
      code_fp: deps.sha256(code),
      line_count: code ? code.split("\n").length : 0,
      imports: PythonStepAnalyzer.scanImports(code),
      functions: defs.functions,
      classes: defs.classes,
      input_schema: inputSchema,
      output_schema: outputSchema,
      declared_inputs: PythonStepAnalyzer.fieldNames(inputSchema),
      declared_outputs: PythonStepAnalyzer.fieldNames(outputSchema),
      input_mapping: mapping,
      upstream_refs: upstream,
      consumers: consumers
    };
  }

  /** "function" for recipe functions, otherwise the trigger application (or "recipe" when unknown). */
  static recipeKind(recipe) {
    const t = String(recipe.trigger_application || "");
    if (t === "workato_recipe_function") return "function";
    return t || "recipe";
  }

  /**
   * The enclosing recipe function's own contract, when the recipe is one: the trigger's parameters_schema_json and
   * result_schema_json. For a thin-wrapper function (one Python step between the trigger and return_result) this
   * is the natural candidate for the connector action's input/output, so it rides along in the record.
   * @returns {{parameters:Array, result:Array}|null}
   */
  static functionContract(recipe) {
    let root = recipe.code;
    try { if (typeof root === "string") root = JSON.parse(root); } catch (e) { return null; }
    if (!root || root.provider !== "workato_recipe_function") return null;
    const inp = root.input || {};
    return {
      parameters: PythonStepAnalyzer.parseSchemaJson(inp.parameters_schema_json),
      result: PythonStepAnalyzer.parseSchemaJson(inp.result_schema_json)
    };
  }

  /** Parses a schema JSON string to an array; a missing or malformed string is an empty array, never a throw. */
  static parseSchemaJson(str) {
    if (Array.isArray(str)) return str;
    if (typeof str !== "string" || !str.trim()) return [];
    try {
      const v = JSON.parse(str);
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }

  /** Top-level field names of a schema array, in declared order. */
  static fieldNames(schema) {
    return (Array.isArray(schema) ? schema : []).map(f => String((f && f.name) || "")).filter(Boolean);
  }

  /**
   * Root module of every import, unique, in order of first appearance.
   *   "import base64"                  -> base64
   *   "from openpyxl.styles import X"  -> openpyxl
   *   "import numpy as np"             -> numpy
   */
  static scanImports(code) {
    const out = [];
    const seen = new Set();
    const re = /^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import\b|import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*))/gm;
    let m;
    while ((m = re.exec(code)) !== null) {
      const names = m[1] ? [m[1]] : String(m[2]).split(",").map(s => s.trim());
      names.forEach(n => {
        const root = n.split(".")[0];
        if (root && !seen.has(root)) { seen.add(root); out.push(root); }
      });
    }
    return out;
  }

  /** Top-level `def` and `class` names (column 0 only, so methods and nested helpers are not counted). */
  static scanDefs(code) {
    const functions = [];
    const classes = [];
    const re = /^(def|class)[ \t]+([A-Za-z_]\w*)/gm;
    let m;
    while ((m = re.exec(code)) !== null) {
      (m[1] === "def" ? functions : classes).push(m[2]);
    }
    return { functions, classes };
  }

  /**
   * { as: display name } for every step in the recipe, so an upstream `line` reads as a name. The trigger is the
   * root of recipe.code (not part of the step walk) and is the usual upstream of a function's first step, so it is
   * indexed too.
   */
  static aliasIndex(allSteps, recipe) {
    const idx = {};
    let root = recipe && recipe.code;
    try { if (typeof root === "string") root = JSON.parse(root); } catch (e) { root = null; }
    if (root && root.as) idx[String(root.as)] = String(root.name || root.keyword || "trigger");
    (allSteps || []).forEach(l => {
      const s = l.step || {};
      if (s.as) idx[String(s.as)] = String((s.input && s.input.name) || s.name || s.keyword || "");
    });
    return idx;
  }

  /**
   * Steps in the same recipe that read this step's output, with the output paths they read (relative to "output").
   * This is the within-recipe consumer graph: it tells the connector design which declared outputs are actually used.
   * @returns {Array<{number:*, step_path:string, as:string, name:string, paths:Array<string>}>}
   */
  static consumersOf(alias, allSteps, pillRefs) {
    const out = [];
    if (!alias) return out;
    (allSteps || []).forEach(l => {
      const s = l.step || {};
      if (String(s.as || "") === String(alias)) return; // itself
      const refs = pillRefs(s.input || {}).filter(r => String(r.line) === String(alias));
      if (!refs.length) return;
      const paths = [];
      refs.forEach(r => {
        const p = (r.path[0] === PY_STEP.OUTPUT_ROOT ? r.path.slice(1) : r.path).join(".");
        if (p && !paths.includes(p)) paths.push(p);
      });
      out.push({
        number: s.number ?? "",
        step_path: l.step_path || "",
        as: String(s.as || ""),
        name: String((s.input && s.input.name) || s.name || s.keyword || ""),
        paths
      });
    });
    return out;
  }
}

// -------------------------------------------------------------------------------------------------------
// RUNNER
// -------------------------------------------------------------------------------------------------------
class PythonStepsRunner {
  /**
   * @param {AppContext} ctx
   * @param {Array<string>|null} [idsOverride] - Specific recipe IDs (selection). Null = whole workspace, pre-filtered
   *                                             by `applications` containing "py_eval".
   * @param {{savePy?:boolean}} [options]      - savePy defaults to config PYTHON_STEPS.SAVE_PY_TO_DRIVE.
   */
  run(ctx, idsOverride = null, options = {}) {
    try {
      const cfg = ctx.config;
      const engine = ctx.analyzerService && ctx.analyzerService.engine;
      if (!engine || typeof engine.collectSteps !== "function" || typeof engine.extractPillRefs !== "function") {
        ctx.logger.notify("Python steps: the bound WorkatoGraphLib predates collectSteps. Deploy GraphLib 1.1.0 and bump the library version in this project.", true);
        return null;
      }
      const savePy = (options.savePy !== undefined)
        ? Boolean(options.savePy)
        : Boolean((cfg.PYTHON_STEPS || {}).SAVE_PY_TO_DRIVE);

      // 1. Recipes: whole workspace (one paginated sweep, pre-filtered) or the requested IDs.
      let recipes;
      if (Array.isArray(idsOverride) && idsOverride.length > 0) {
        recipes = idsOverride
          .map(id => ctx.analyzerService.getRecipeDetails(id) || ctx.client.get(`recipes/${id}`))
          .filter(Boolean);
      } else {
        const all = ctx.client.fetchPaginated("recipes");
        recipes = all.filter(r => !Array.isArray(r.applications) || r.applications.includes(PY_STEP.PROVIDER));
        ctx.logger.verbose(`Python steps: ${recipes.length} of ${all.length} recipes use ${PY_STEP.PROVIDER}.`);
      }
      ctx.analyzerService.primeCache(recipes);

      // 2. Display names from the inventory tab (as fresh as the last sync; "-" when absent).
      const names = this.readRecipeNames_();

      // 3. Walk, describe, save.
      const deps = {
        sha256: ChangeLedgerRunner.sha256_,
        pillRefs: (v) => ctx.analyzerService.extractPillRefs(v)
      };
      const records = [];
      const errors = [];

      recipes.forEach((recipe, idx) => {
        try {
          const allSteps = ctx.analyzerService.collectSteps(recipe.id);
          const pySteps = allSteps.filter(l => PythonStepAnalyzer.isPythonStep(l.step));
          pySteps.forEach(located => {
            const rec = PythonStepAnalyzer.describe(recipe, located, allSteps, deps, names[String(recipe.id)] || {});
            rec.drive_url = savePy
              ? (ctx.driveService.saveText(rec.recipe_id, `${rec.recipe_name}__${rec.step.as}`, "py", rec.code) || "")
              : "";
            records.push(rec);
          });
        } catch (e) {
          console.warn(`Python steps: failed recipe ${recipe.id}: ${e.message}`);
          errors.push({ recipe_id: String(recipe.id), recipe_name: String(recipe.name || ""), message: String(e.message || e) });
        }
        if (idx % 10 === 0) Utilities.sleep(cfg.API.THROTTLE_MS);
      });

      // 4. Manifest to Drive (the Phase 2 input), sheet rows, audit row.
      const generatedAt = new Date().toISOString();
      const manifest = {
        generated_at: generatedAt,
        recipe_count: recipes.length,
        step_count: records.length,
        non_inline_count: records.filter(r => !r.step.inline).length,
        errors,
        steps: records
      };
      const manifestUrl = ctx.driveService.saveText("python_steps", "manifest", "json", JSON.stringify(manifest, null, 2)) || "";

      const rows = [cfg.HEADERS.PYTHON_STEPS]
        .concat(DataMapper.mapPythonStepsToRows(records, generatedAt))
        .concat(errors.map(e => {
          const row = Array(cfg.HEADERS.PYTHON_STEPS.length).fill("");
          // Same positions DataMapper.mapPythonStepsToRows uses for Step Name / Comment.
          row[0] = e.recipe_id; row[1] = e.recipe_name; row[10] = "ERROR"; row[11] = e.message; row[row.length - 1] = generatedAt;
          return row;
        }));
      ctx.sheetService.write("PYTHON_STEPS", rows);

      if (cfg.DEBUG.LOG_TO_SHEET) {
        ctx.sheetService.appendDebugRows([[
          generatedAt, "Batch Run", "Python step inventory",
          manifestUrl ? "Manifest saved to Drive" : "Manifest not saved (LOG_TO_DRIVE off)",
          manifestUrl ? `=HYPERLINK("${manifestUrl}", "View manifest")` : ""
        ]]);
      }

      const nonInline = manifest.non_inline_count ? `; ${manifest.non_inline_count} NOT inline (check Payload column)` : "";
      const failed = errors.length ? `; ${errors.length} recipe(s) failed` : "";
      ctx.logger.notify(`Python steps: ${records.length} step(s) in ${recipes.length} recipe(s)${nonInline}${failed}.`, errors.length > 0);
      return manifest;
    } catch (e) {
      AppHelpers.handleError(e);
      return null;
    }
  }

  /** { recipe_id: {project, folder} } from Inventory_Recipes (columns: ID, Name, Status, Project, Folder, …). */
  readRecipeNames_() {
    const out = {};
    try {
      new ChangeLedgerRunner().readRows_("RECIPES").forEach(r => {
        if (r[0]) out[String(r[0])] = { project: String(r[3] || "-"), folder: String(r[4] || "-") };
      });
    } catch (e) {
      console.warn(`Python steps: could not read RECIPES tab for names: ${e.message}`);
    }
    return out;
  }
}
