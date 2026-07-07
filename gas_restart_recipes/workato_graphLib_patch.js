/**
 * @file WorkatoGraphLib (patched core, for verification)
 * @description RecipeAnalyzer with the four watchdog-hardening deltas applied.
 * This is a verification build containing the constructor, cache, and
 * extraction paths — the surface the OrderLib depends on. Mermaid/process
 * graph methods from v1.0.0 are unchanged and omitted here for brevity;
 * apply the deltas to your full file via WorkatoGraphLib_deltas.md.
 */

class RecipeAnalyzer {
  constructor(client, config = {}) {
    if (!client || typeof client.get !== 'function') {
      throw new Error("GraphLib: 'client' dependency with .get() method is required.");
    }
    this.client = client;
    this._recipeDetailCache = new Map();

    // Default constants (can be overridden)                       [Delta 1]
    this.CONSTANTS = {
      RECIPE_PROVIDERS: config.RECIPE_PROVIDERS || ['workato_recipe_function', 'workato_callable_recipe'],
      FLOW_ID_KEYS: config.FLOW_ID_KEYS || ['flow_id', 'recipe_id', 'callable_recipe_id'],
      CALL_ACTION_NAMES: config.CALL_ACTION_NAMES || ['call_recipe', 'call_recipe_async'],
      MERMAID_LABEL_MAX: config.MERMAID_LABEL_MAX || 80,
      STRICT: config.STRICT || false
    };
  }

  // ----- Public interface -------------------------------------------------

  getRecipeDetails(recipeId) {
    const key = String(recipeId);
    if (this._recipeDetailCache.has(key)) return this._recipeDetailCache.get(key);
    try {
      const json = this.client.get(`recipes/${key}`);
      this._recipeDetailCache.set(key, json);
      return json;
    } catch (e) {                                                //  [Delta 2]
      if (this.CONSTANTS.STRICT) {
        throw new Error(`GraphLib[strict]: fetch failed for recipe ${key}: ${e.message}`);
      }
      console.warn(`GraphLib: Could not fetch details for recipe ${key}: ${e.message}`);
      return null;
    }
  }

  /** Pre-populates the detail cache from list-endpoint results.     [Delta 4] */
  primeCache(recipes) {
    (recipes || []).forEach(r => {
      if (r && r.id !== undefined && r.id !== null) {
        this._recipeDetailCache.set(String(r.id), r);
      }
    });
    return this._recipeDetailCache.size;
  }

  getCallEdges(recipeId) {
    const json = this.getRecipeDetails(recipeId);
    if (!json || !json.code) {                                    //  [Delta 2]
      if (this.CONSTANTS.STRICT) {
        throw new Error(`GraphLib[strict]: recipe ${recipeId} has no retrievable code.`);
      }
      return [];
    }

    let edges = [];
    try {
      const codeObj = (typeof json.code === 'string') ? JSON.parse(json.code) : json.code;
      const rootBlock = codeObj.block || codeObj.line || [];
      this._scanBlockForCallEdges(rootBlock, edges, {
        parentId: String(json.id || recipeId),
        parentName: json.name || "",
        stepPathPrefix: "",
        branchStack: []
      });
    } catch (e) {                                                //  [Delta 2]
      if (this.CONSTANTS.STRICT) {
        throw new Error(`GraphLib[strict]: code parse failed for recipe ${recipeId}: ${e.message}`);
      }
      console.warn(`GraphLib: Error parsing call edges for ${recipeId}: ${e.message}`);
    }
    return edges;
  }

  // ----- Logic parsing internals ------------------------------------------

  /** @private Recursive walker for Call Edges                       [Delta 3] */
  _scanBlockForCallEdges(steps, edges, ctx) {
    if (!Array.isArray(steps)) return;
    steps.forEach((step, index) => {
      const stepPath = ctx.stepPathPrefix ? `${ctx.stepPathPrefix}/${index}` : `${index}`;
      const input = step?.input || {};
      const found = this._findIdKeyAndValue(input, this.CONSTANTS.FLOW_ID_KEYS, 3);

      const isRecipeProvider = this.CONSTANTS.RECIPE_PROVIDERS.includes(step?.provider);
      const isCallAction = isRecipeProvider &&
        this.CONSTANTS.CALL_ACTION_NAMES.includes(String(step?.name || ""));

      if (found && found.value) {
        const ref = this._classifyCalleeRef(found.value);
        const strength = isCallAction
          ? (ref.kind === "dynamic" ? "dynamic" : "strong")
          : "weak";

        edges.push({
          parent_recipe_id: ctx.parentId, parent_recipe_name: ctx.parentName,
          child_recipe_id: (ref.kind === "id") ? ref.id : "",
          child_ref: ref,
          strength: strength,
          call_type: String(step.name || "").includes("async") ? "async" : "sync",
          id_key: found.key,
          provider: step.provider || "unknown", step_name: step.name || step.as || "Unknown",
          step_path: stepPath, branch_context: (ctx.branchStack || []).join(" / ")
        });
      } else if (isCallAction) {
        edges.push({
          parent_recipe_id: ctx.parentId, parent_recipe_name: ctx.parentName,
          child_recipe_id: "", child_ref: { kind: "dynamic", raw: null },
          strength: "dynamic",
          call_type: String(step.name || "").includes("async") ? "async" : "sync",
          id_key: null,
          provider: step.provider || "unknown", step_name: step.name || step.as || "Unknown",
          step_path: stepPath, branch_context: (ctx.branchStack || []).join(" / ")
        });
      }

      // Branch Context (unchanged from v1.0.0)
      const keyword = String(step?.keyword || "").toLowerCase();
      const cond = (keyword === "if" || keyword === "elsif") ? this._formatConditionSummary(step) : "";

      if (step.block) {
        const next = ctx.branchStack.slice();
        if (cond) next.push(`IF ${cond}`.trim());
        this._scanBlockForCallEdges(step.block, edges, { ...ctx, stepPathPrefix: stepPath, branchStack: next });
      }
      if (step.else_block) {
        const next = ctx.branchStack.slice().concat(["ELSE"]);
        this._scanBlockForCallEdges(step.else_block, edges, { ...ctx, stepPathPrefix: stepPath, branchStack: next });
      }
      if (step.error_block) {
        const next = ctx.branchStack.slice().concat(["ON_ERROR"]);
        this._scanBlockForCallEdges(step.error_block, edges, { ...ctx, stepPathPrefix: stepPath, branchStack: next });
      }
    });
  }

  // ----- Internal utilities -----------------------------------------------

  /** @private Normalizes a callee reference.                        [Delta 3] */
  _classifyCalleeRef(value) {
    if (value && typeof value === "object") {
      if (value.zip_name || value.name) {
        return { kind: "symbolic",
                 zip_name: value.zip_name || "", name: value.name || "" };
      }
      return { kind: "dynamic", raw: JSON.stringify(value).slice(0, 200) };
    }
    const s = String(value);
    if (/^\d+$/.test(s)) return { kind: "id", id: s };
    return { kind: "dynamic", raw: s.slice(0, 200) };
  }

  _findIdKeyAndValue(obj, keys, depth) {
    if (!obj || typeof obj !== "object" || depth <= 0) return null;
    for (const k of keys) if (obj[k]) return { key: k, value: obj[k] };
    if (obj.parameters) {
      for (const k of keys) if (obj.parameters[k]) return { key: k, value: obj.parameters[k] };
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") {
        const hit = this._findIdKeyAndValue(v, keys, depth - 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  _formatConditionSummary(step) {
    try {
      const c = step?.input?.conditions || [];
      if (!c.length) return "";
      const p = c.slice(0, 2).map(x => `${this._cleanDataPill(x.lhs)} ${x.operand} ${this._cleanDataPill(x.rhs)}`);
      return p.join(" AND ") + (c.length > 2 ? "..." : "");
    } catch(e) { return ""; }
  }

  _cleanDataPill(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/#\{_dp\('(.*?)'\)\}/g, (_, esc) => {
      try { return `{{${JSON.parse(esc.replace(/\\"/g, '"')).label}}}`; } catch(e) { return "{{var}}"; }
    });
  }
}

function newAnalyzer(client, config) {
  return new RecipeAnalyzer(client, config);
}

if (typeof module !== 'undefined') module.exports = { RecipeAnalyzer, newAnalyzer };
