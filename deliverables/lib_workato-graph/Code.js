/**
 * @file Workato graph and analysis library
 * @description Parses Workato recipe code into traversable graphs, logic summaries, and Mermaid diagrams.
 * 
 * @author emily.cabaniss@randstadsourceright.com
 * @version 1.1.0  (adds collectSteps + extractPillRefs — generic step access for consumers that need step bodies)
 *
 * For internal technical documentation, see the file linked below:
 * @link{https://docs.google.com/document/d/10_5Dqr4r5CiK-0aCdDXFFcKqeKcJanzT8NqlQMAJv9g/edit?tab=t.0#heading=h.av2sef6b7pef}
 */

// -------------------------------------------------------------------------------------------------------
// PUBLIC FACTORY
// -------------------------------------------------------------------------------------------------------

/**
 * Creates a new instance of the Recipe Analyzer.
 * @param {Object} client - A Workato Client instance (must have a .get(url) method).
 * @param {Object} [config] - Optional overrides for constants.
 * @return {RecipeAnalyzer} Initialized analyzer.
 */

function newAnalyzer(client, config) {
  return new RecipeAnalyzer(client, config);
}

// -------------------------------------------------------------------------------------------------------
// PRIMARY ANALYSIS CLASS
// -------------------------------------------------------------------------------------------------------

class RecipeAnalyzer {
  /**
   * @param {Object} client - Injected WorkatoClient (Lib_WorkatoClient wrapper).
   * @param {Object} [config] - Optional configuration overrides.
   */
  constructor(client, config = {}) {
    if (!client || typeof client.get !== 'function') {
      throw new Error("GraphLib: 'client' dependency with .get() method is required.");
    }
    this.client = client;
    this._recipeDetailCache = new Map();

    // Default constants (can be overridden)
    this.CONSTANTS = {
      RECIPE_PROVIDERS: config.RECIPE_PROVIDERS || ['workato_recipe_function', 'workato_callable_recipe'],
      FLOW_ID_KEYS: config.FLOW_ID_KEYS || ['flow_id', 'recipe_id', 'callable_recipe_id'],
      // Step names (on RECIPE_PROVIDERS steps) that constitute an invocation. Excludes 'return_result', which shares the provider but calls nothing.
      CALL_ACTION_NAMES: config.CALL_ACTION_NAMES || ['call_recipe', 'call_recipe_async'],
      MERMAID_LABEL_MAX: config.MERMAID_LABEL_MAX || 80,
      // Strict mode: parse/fetch failures THROW instead of warn-and-degrade.
      // Documentation callers keep the default (false). The watchdog sets true, because "no edges" and "couldn't read" must never be the same answer.
      STRICT: config.STRICT || false
    };
  }

  // ----- Public interface -------------------------------------------------
  /**
   * Fetches recipe details (utilizing internal cache to prevent redundant API calls).
   * @param {string|number} recipeId
   * @returns {Object|null}
   */
  getRecipeDetails(recipeId) {
    const key = String(recipeId);
    if (this._recipeDetailCache.has(key)) return this._recipeDetailCache.get(key);
    try {
      const json = this.client.get(`recipes/${key}`);
      this._recipeDetailCache.set(key, json);
      return json;
    } catch (e) {
      if (this.CONSTANTS.STRICT) {
        throw new Error(`GraphLib[strict]: fetch failed for recipe ${key}: ${e.message}`);
      }
      console.warn(`GraphLib: Could not fetch details for recipe ${key}: ${e.message}`);
      return null;
    }
  }
  /**
   * Scans a recipe's code for external dependencies (Apps and Child Recipes).
   * @param {string|number} recipeId
   * @returns {Array<Object>} List of { type, id, name }
   */
  getDependencies(recipeId) {
    const json = this.getRecipeDetails(recipeId);
    if (!json) return [];

    let dependencies = [];

    // 1. Standard apps (metadata)
    if (json.applications && Array.isArray(json.applications)) {
      json.applications.forEach(app => {
        if (!this.CONSTANTS.RECIPE_PROVIDERS.includes(app)) {
          dependencies.push({ type: 'Connection', id: app, name: app });
        }
      });
    }

    // 2. Recipe calls (code scan)
    if (json.code) {
      try {
        const codeObj = (typeof json.code === 'string') ? JSON.parse(json.code) : json.code;
        const rootBlock = codeObj.block || codeObj.line || [];
        this._scanBlockForCalls(rootBlock, dependencies);
      } catch (e) {
        console.warn(`GraphLib: Error parsing code for ${recipeId}: ${e.message}`);
      }
    }
    return dependencies;
  }
  /**
   * Extracts direct call edges (Parent -> Child) from a recipe's logic.
   * @param {string|number} recipeId
   * @returns {Array<Object>} List of edge objects.
   */
  getCallEdges(recipeId) {
    const json = this.getRecipeDetails(recipeId);
    if (!json || !json.code) {
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
    } catch (e) {
      if (this.CONSTANTS.STRICT) {
        throw new Error(`GraphLib[strict]: code parse failed for recipe ${recipeId}: ${e.message}`);
      }
      console.warn(`GraphLib: Error parsing call edges for ${recipeId}: ${e.message}`);
    }
    return edges;
  }
  /**
   * Generates a flat list of logic rows (step-by-step) for documentation.
   * @param {Object} recipe - Full recipe object.
   * @returns {Array<Array<string>>} Rows [id, name, step#, indent, provider, action, desc, details]
   */
  parseLogicRows(recipe) {
    if (!recipe.code) return [];
    let rows = [];
    try {
      const codeObj = (typeof recipe.code === 'string') ? JSON.parse(recipe.code) : recipe.code;
      const rootBlock = codeObj.block || codeObj.line || [];
      this._scanBlockForLogic(rootBlock, 0, recipe.id, recipe.name, rows);
    } catch (e) {
      console.warn(`GraphLib: Error parsing logic rows for ${recipe.id}: ${e.message}`);
    }
    return rows;
  }
  /**
   * Collects the raw step OBJECTS of a recipe that satisfy a predicate, each with its location.
   *
   * This is the first generic walker: the other four each summarise steps for one purpose (dependencies, call edges,
   * logic rows, process graph). Anything that needs a step's body — code, schemas, input mappings — is a filter on top
   * of this rather than a fifth private recursion. Same tree rules as the others: block / else_block / error_block.
   *
   * Location conventions (match the process-graph walker, which is the unambiguous one):
   *   step_path      "1/0"  = index 1 at root, then index 0 inside its block
   *                  "1/else/0", "1/error/0" for the else and error branches
   *   branch_context "TRY / IF x = y / ELSE" — the enclosing keywords, outermost first
   *
   * The trigger (the root of recipe.code) is not a step in this walk; read it from getRecipeDetails(id).code directly.
   *
   * @param {string|number} recipeId
   * @param {Function} [predicate] - (step, location) => boolean. Omit to collect every step.
   * @returns {Array<{step:Object, step_path:string, branch_context:string, depth:number}>}
   */
  collectSteps(recipeId, predicate) {
    const recipe = this.getRecipeDetails(recipeId);
    if (!recipe || !recipe.code) {
      if (this.CONSTANTS.STRICT) {
        throw new Error(`GraphLib[strict]: recipe ${recipeId} has no retrievable code.`);
      }
      return [];
    }
    const keep = (typeof predicate === "function") ? predicate : (() => true);
    const out = [];
    try {
      const codeObj = (typeof recipe.code === "string") ? JSON.parse(recipe.code) : recipe.code;
      const rootBlock = codeObj.block || codeObj.line || [];
      this._walkSteps(rootBlock, { stepPathPrefix: "", branchStack: [], depth: 0 }, (step, loc) => {
        if (keep(step, loc)) out.push({ step, ...loc });
      });
    } catch (e) {
      if (this.CONSTANTS.STRICT) {
        throw new Error(`GraphLib[strict]: code parse failed for recipe ${recipeId}: ${e.message}`);
      }
      console.warn(`GraphLib: Error collecting steps for ${recipeId}: ${e.message}`);
    }
    return out;
  }
  /**
   * Finds every datapill reference inside a value. Strings are scanned; arrays and objects are searched recursively,
   * so passing a step's whole `input` finds everything it reads.
   *
   * Handles both encodings Workato uses for the same pill:
   *   template form   #{_dp('{"pill_type":"output","provider":"py_eval","line":"07c380e4","path":["output","status"]}')}
   *   formula form    =_dp('{…}').present? ? _dp('{…}') : "error"
   * `line` is the `as` alias of the producing step — that is the join key for step-level data flow.
   *
   * @param {*} value
   * @returns {Array<{pill_type:string, provider:string, line:string, path:Array<string>}>} unique refs, in order found
   */
  extractPillRefs(value) {
    const refs = [];
    const seen = new Set();
    const visit = (v) => {
      if (typeof v === "string") {
        const re = /_dp\('(.*?)'\)/g;
        let m;
        while ((m = re.exec(v)) !== null) {
          let ref = null;
          try { ref = JSON.parse(m[1]); }
          catch (e1) {
            try { ref = JSON.parse(m[1].replace(/\\"/g, '"')); } catch (e2) { ref = null; }
          }
          if (!ref || typeof ref !== "object") continue;
          const norm = {
            pill_type: String(ref.pill_type || ""),
            provider: String(ref.provider || ""),
            line: String(ref.line || ""),
            path: Array.isArray(ref.path) ? ref.path.map(String) : []
          };
          const sig = `${norm.provider}|${norm.line}|${norm.path.join(".")}`;
          if (!seen.has(sig)) { seen.add(sig); refs.push(norm); }
        }
      } else if (Array.isArray(v)) {
        v.forEach(visit);
      } else if (v && typeof v === "object") {
        Object.values(v).forEach(visit);
      }
    };
    visit(value);
    return refs;
  }
  /**
   * Pre-populates the recipe detail cache from list-endpoint results,
   * so subsequent getCallEdges/getRecipeDetails calls are cache hits.
   * @param {Array<Object>} recipes - e.g. client.fetchPaginated('recipes?folder_id=...')
   * @returns {number} Cache size after priming.
   */
  primeCache(recipes) {
    let skipped = 0;
    (recipes || []).forEach(r => {
      if (r && r.id !== undefined && r.id !== null) {
        this._recipeDetailCache.set(String(r.id), r);
      } else { skipped++; }
    });
    if (skipped && this.CONSTANTS.STRICT) {
      throw new Error(`GraphLib[strict]: primeCache skipped ${skipped} record(s) without an id.`);
    }
    if (skipped) console.warn(`GraphLib: primeCache skipped ${skipped} record(s) without an id.`);
    return this._recipeDetailCache.size;
  }
  /**
   * Builds a full "Graph Pack" containing both Call Graph (high level) and Process Graph (low level).
   * This is the main entry point for generating comprehensive documentation.
   * @param {string|number} rootId
   * @param {Object} [options]
   * @param {number} [options.callDepth=0] - How deep to recurse for sub-recipes.
   * @param {number} [options.maxNodes=250] - Max nodes for process graph.
   */
  buildGraphPack(rootId, options = {}) {
    const depth = options.callDepth || 0;
    const maxNodes = options.maxNodes || 250;
    const edgeSampleLimit = options.edgeSampleLimit || 60;

    const rootRecipe = this.getRecipeDetails(rootId);
    const rootName = rootRecipe?.name || "";

    // 1. Build Graphs
    const callGraph = this._buildTransitiveCallGraph(rootId, depth);
    const procGraph = this._buildProcessGraph(rootId, { maxNodes });

    // 2. Render Mermaid
    const callMermaid = this.renderMermaidCallGraph(rootId, callGraph);
    const procMermaid = this.renderMermaidProcessGraph(rootId, procGraph);

    return {
      root_id: String(rootId),
      root_name: rootName,
      call: {
        depth,
        node_count: callGraph?.nodes?.size || 0,
        edge_count: Array.isArray(callGraph?.edges) ? callGraph.edges.length : 0,
        notes: (callGraph?.notes || []).slice(0, 20),
        edges_sample: this._summarizeCallEdges(callGraph, edgeSampleLimit),
        mermaid: callMermaid
      },
      process: {
        maxNodes,
        node_count: procGraph?.nodes?.size || 0,
        edge_count: Array.isArray(procGraph?.edges) ? procGraph.edges.length : 0,
        notes: (procGraph?.notes || []).slice(0, 20),
        kind_counts: this._summarizeProcessKinds(procGraph),
        call_targets: this._summarizeProcessCallTargets(procGraph, 12),
        edges_sample: this._summarizeProcessEdges(procGraph, edgeSampleLimit),
        mermaid: procMermaid
      }
    };
  }

  // ----- Graph rendering methods ------------------------------------------
  /** Renders a Mermaid flowchart from a Call Graph object. */
  renderMermaidCallGraph(rootId, graph) {
    const lines = ["flowchart TD"];
    const rootKey = String(rootId);
    if (!graph.nodes.has(rootKey)) graph.nodes.set(rootKey, {id: rootKey, name: "" });

    // Nodes
    graph.nodes.forEach(n => {
      const nodeId = `R${String(n.id).replace(/[^0-9a-zA-Z_]/g, "_")}`;
      const label = this._mNormalizeNodeLabel(`${n.name || "Recipe"} (${n.id})`);
      lines.push(`  ${nodeId}["${label}"]`);
    });

    const nodeRef = (id) => `R${String(id).replace(/[^0-9a-zA-Z_]/g, "_")}`;

    // Edges
    const seen = new Set();
    graph.edges.forEach(e => {
      const p = String(e.parent_recipe_id || "");
      const c = String(e.child_recipe_id || "");
      if (!p || !c) return;

      const labelBits = [];
      if (e.branch_context) labelBits.push(this._mNormalizeEdgeLabel(e.branch_context));
      if (e.step_name) labelBits.push(this._mNormalizeEdgeLabel(e.step_name));
      const edgeLabel = labelBits.join(" · ");

      const sig = `${p}->${c}|${edgeLabel}`;
      if (seen.has(sig)) return;
      seen.add(sig);

      const left = nodeRef(p);
      const right = nodeRef(c);
      if (edgeLabel) lines.push(` ${left} -->|${edgeLabel}| ${right}`);
      else lines.push(` ${left} --> ${right}`);
    });

    return lines.join("\n");
  }
  /** Renders a Mermaid flowchart from a Process Graph object. */
  renderMermaidProcessGraph(recipeId, graph) {
    const lines = ["flowchart TD"];

    // Nodes
    for (const n of Array.from(graph.nodes.values())) {
      const id = n.id;
      const label = this._mNormalizeNodeLabel(n.label || id);
      const kind = String(n.kind || "step");

      if (kind === "start" || kind === "end") lines.push(`  ${id}(["${label}"])`);
      else if (kind === "decision" || kind === "loop") lines.push(`  ${id}{"${label}"}`);
      else if (kind === "call") lines.push(`  ${id}[["${label}"]]`);
      else if (kind === "merge") lines.push(`  ${id}(("${label}"))`);
      else lines.push(`  ${id}["${label}"]`);
    }

    // Edges
    const seen = new Set();
    for (const e of (graph.edges || [])) {
      const from = e.from;
      const to = e.to;
      if (!from || !to) continue;
      const lbl = e.label ? this._mNormalizeEdgeLabel(e.label) : "";
      const sig = `${from}->${to}|${lbl}|${e.kind || ""}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      if (lbl) lines.push(`  ${from} -->|${lbl}| ${to}`);
      else lines.push(`  ${from} --> ${to}`);
    }

    return lines.join("\n");
  }

  // ----- Internal graph builders ------------------------------------------
  /** @private Builds transitive call graph with cycle detection. */
  _buildTransitiveCallGraph(rootId, depthLimit) {
    const nodes = new Map();
    const edges = [];
    const notes = [];
    const expandedAtDepth = new Map();

    const expand = (id, remainingDepth, stack) => {
      const key = String(id);
      const currentStack = stack || [];
      
      if (currentStack.includes(key)) {
        notes.push(`Cycle detected: ${currentStack.join(" -> ")} -> ${key}`);
        return;
      }

      const prev = expandedAtDepth.get(key);
      if (prev !== undefined && prev >= remainingDepth) return;
      expandedAtDepth.set(key, remainingDepth);

      const recipe = this.getRecipeDetails(key);
      nodes.set(key, {id: key, name: recipe ? (recipe.name || "") : ""});

      const localEdges = this.getCallEdges(key);
      localEdges.forEach(e => edges.push(e));

      if (remainingDepth <= 0) return;

      const nextStack = currentStack.concat([key]); 
      for (const e of localEdges) {
        const child = String(e.child_recipe_id || "");
        if (child) expand(child, remainingDepth - 1, nextStack); 
      }
    };

    expand(String(rootId), Math.max(0, Number(depthLimit || 0)), []);
    return { nodes, edges, notes };
  }
  /** @private Builds step-level process graph. */
  _buildProcessGraph(recipeId, options = {}) {
    const maxNodes = options.maxNodes || 250;
    const recipe = this.getRecipeDetails(recipeId);
    const nodes = new Map();
    const edges = [];
    const notes = [];

    const meta = {
      recipe_id: String(recipe?.id || recipeId),
      recipe_name: recipe?.name || ""
    };

    if (!recipe || !recipe.code) {
      notes.push("No recipe code available.");
      return { nodes, edges, notes, meta };
    }

    let codeObj = (typeof recipe.code === "string") ? JSON.parse(recipe.code) : recipe.code;
    const rootBlock = codeObj.block || codeObj.line || [];

    const startId = this._pNodeId(`START_${meta.recipe_id}`);
    const endId = this._pNodeId(`END_${meta.recipe_id}`);

    this._pAddNode(nodes, startId, {
      id: startId, kind: "start", provider: "system", step_path: "", 
      label: `Start: ${meta.recipe_name || "Recipe"}`, branch_context: ""
    });
    this._pAddNode(nodes, endId, {
      id: endId, kind: "end", provider: "system", step_path: "", 
      label: "End", branch_context: ""
    });

    const ctx = {
      recipeId: meta.recipe_id, branchStack: [], stepPathPrefix: "", maxNodes
    };

    const res = this._scanBlockForProcessGraph(rootBlock, ctx, { nodes, edges, notes }, startId, "");
    const last = res?.last || startId;
    this._pAddEdge(edges, last, endId, "", "flow");

    if (nodes.size >= maxNodes) notes.push(`Node cap reached (${maxNodes}).`);

    return { nodes, edges, notes, meta };
  }

  // ----- Logic parsing internals ------------------------------------------
  /**
   * @private Generic recursive walker behind collectSteps. Visits every step in document order and calls
   * visit(step, location). Branch labels: IF/ELSIF carry their condition summary; every other keyword that opens a
   * block (TRY, FOREACH, REPEAT, …) contributes its upper-cased keyword; else_block adds ELSE; error_block adds ON_ERROR.
   */
  _walkSteps(steps, ctx, visit) {
    if (!Array.isArray(steps)) return;
    steps.forEach((step, index) => {
      const stepPath = ctx.stepPathPrefix ? `${ctx.stepPathPrefix}/${index}` : `${index}`;
      visit(step, {
        step_path: stepPath,
        branch_context: (ctx.branchStack || []).join(" / "),
        depth: ctx.depth || 0
      });

      const keyword = String(step?.keyword || "").toLowerCase();
      let label = "";
      if (keyword === "if" || keyword === "elsif") {
        label = `${keyword.toUpperCase()} ${this._formatConditionSummary(step)}`.trim();
      } else if (keyword && keyword !== "action" && keyword !== "trigger") {
        label = keyword.toUpperCase();
      }

      if (Array.isArray(step.block) && step.block.length) {
        const next = label ? ctx.branchStack.concat([label]) : ctx.branchStack.slice();
        this._walkSteps(step.block, { stepPathPrefix: stepPath, branchStack: next, depth: (ctx.depth || 0) + 1 }, visit);
      }
      if (Array.isArray(step.else_block) && step.else_block.length) {
        const next = ctx.branchStack.concat(["ELSE"]);
        this._walkSteps(step.else_block, { stepPathPrefix: `${stepPath}/else`, branchStack: next, depth: (ctx.depth || 0) + 1 }, visit);
      }
      if (Array.isArray(step.error_block) && step.error_block.length) {
        const next = ctx.branchStack.concat(["ON_ERROR"]);
        this._walkSteps(step.error_block, { stepPathPrefix: `${stepPath}/error`, branchStack: next, depth: (ctx.depth || 0) + 1 }, visit);
      }
    });
  }
  /** @private Recursive walker for Dependencies */
  _scanBlockForCalls(steps, resultsArray) {
    if (!Array.isArray(steps)) return;
    steps.forEach(step => {
      if (this.CONSTANTS.RECIPE_PROVIDERS.includes(step.provider)) {
        const input = step.input || {};
        const idKey = this.CONSTANTS.FLOW_ID_KEYS.find(key => input[key]);
        if (idKey) {
          resultsArray.push({
            type: 'RECIPE CALL', id: input[idKey],
            name: `Called via step: "${step.name || 'Unknown'}"`
          });
        }
      }
      if (step.block) this._scanBlockForCalls(step.block, resultsArray);
      if (step.else_block) this._scanBlockForCalls(step.else_block, resultsArray);
      if (step.error_block) this._scanBlockForCalls(step.error_block, resultsArray);
    });
  }
  /** @private Recursive walker for Call Edges */
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
          : "weak"; // ID-shaped key on a non-call step: report, don't order

        edges.push({
          parent_recipe_id: ctx.parentId, parent_recipe_name: ctx.parentName,
          // Backward compat: numeric refs keep the old field populated;
          // symbolic/dynamic refs leave it "" and consumers use child_ref.
          child_recipe_id: (ref.kind === "id") ? ref.id : "",
          child_ref: ref,
          strength: strength,
          call_type: String(step.name || "").includes("async") ? "async" : "sync",
          id_key: found.key,
          provider: step.provider || "unknown", step_name: step.name || step.as || "Unknown",
          step_path: stepPath, branch_context: (ctx.branchStack || []).join(" / ")
        });
      } else if (isCallAction) {
        // A call step with NO resolvable target at all — worst case, always surface.
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

      // Branch Context
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
  /** @private Recursive walker for Logic Rows */
  _scanBlockForLogic(steps, indentLevel, recipeId, recipeName, rows) {
    if (!Array.isArray(steps)) return;
    steps.forEach((step, index) => {
      const visualIndent = "> ".repeat(indentLevel);
      let actionName = step.name || step.as || "Unknown Action";
      if (step.keyword) actionName = `[${step.keyword.toUpperCase()}] ${actionName}`;
      
      const details = this._extractStepDetails(step);

      rows.push([
        String(recipeId), recipeName, index + 1, visualIndent,
        step.provider || "System", actionName,
        step.description || step.comment || "", details
      ]);

      if (step.block)       this._scanBlockForLogic(step.block, indentLevel + 1, recipeId, recipeName, rows);
      if (step.else_block)  this._scanBlockForLogic(step.else_block, indentLevel + 1, recipeId, recipeName, rows);
      if (step.error_block) this._scanBlockForLogic(step.error_block, indentLevel + 1, recipeId, recipeName, rows);
    });
  }

  // ----- Process graph builder internals ----------------------------------
  _scanBlockForProcessGraph(steps, ctx, graph, entryFromNodeId, entryEdgeLabel = "") {
    if (!Array.isArray(steps) || steps.length === 0) return { first: null, last: entryFromNodeId };
    
    let prev = entryFromNodeId;
    let first = null;

    for (let index = 0; index < steps.length; index++) {
      if (graph.nodes.size >= ctx.maxNodes) {
        graph.notes.push(`Stopped parsing at node cap (${ctx.maxNodes}).`);
        break;
      }

      const step = steps[index];
      const stepPath = ctx.stepPathPrefix ? `${ctx.stepPathPrefix}/${index}` : `${index}`;
      const kind = this._pClassifyStep(step);
      const kw = this._pKeyword(step);

      // --- LOOP ---
      if (kind === "loop") {
        const loopId = this._pNodeId(`S_${ctx.recipeId}_${stepPath}`);
        this._pAddNode(graph.nodes, loopId, {
          id: loopId, kind: "loop", provider: step.provider, step_path: stepPath,
          label: this._pStepLabel(step, "loop"), branch_context: (ctx.branchStack || []).join(" / ")
        });
        
        const isFirst = (prev === entryFromNodeId && !first);
        this._pAddEdge(graph.edges, prev, loopId, isFirst ? entryEdgeLabel : "", "flow");
        if (!first) first = loopId;

        const loopCtx = { ...ctx, stepPathPrefix: stepPath, branchStack: [...(ctx.branchStack||[]), `LOOP`] };
        const bodyRes = this._scanBlockForProcessGraph(step.block || [], loopCtx, graph, loopId, "iterate");
        
        if (bodyRes.first) this._pAddEdge(graph.edges, bodyRes.last, loopId, "repeat", "loop");
        else graph.notes.push(`Loop body empty at ${stepPath}`);

        const afterLoopId = this._pNodeId(`M_${ctx.recipeId}_${stepPath}_after`);
        this._pAddNode(graph.nodes, afterLoopId, {
          id: afterLoopId, kind: "merge", provider: "system", step_path: `${stepPath}/after`, label: "After Loop"
        });
        this._pAddEdge(graph.edges, loopId, afterLoopId, "done", "flow");

        // Loop Else
        if (Array.isArray(step.else_block) && step.else_block.length > 0) {
           const elseCtx = { ...ctx, stepPathPrefix: `${stepPath}/else`, branchStack: [...(ctx.branchStack||[]), "LOOP_ELSE"] };
           const elseRes = this._scanBlockForProcessGraph(step.else_block, elseCtx, graph, loopId, "empty");
           this._pAddEdge(graph.edges, (elseRes.first ? elseRes.last : loopId), afterLoopId, "", "flow");
        }
        prev = afterLoopId;
        continue;
      }

      // --- DECISION CHAIN (IF/ELSIF) ---
      if (kind === "decision" && kw === "if") {
        const chain = [{ step, stepPath }];
        let j = index + 1;
        while (j < steps.length && this._pIsElsif(steps[j])) {
          chain.push({ step: steps[j], stepPath: ctx.stepPathPrefix ? `${ctx.stepPathPrefix}/${j}` : `${j}` });
          j++;
        }

        if (chain.length > 1) {
          let lastDecisionId = null;
          const thenExits = [];

          for (let ci = 0; ci < chain.length; ci++) {
            const c = chain[ci];
            const decisionId = this._pNodeId(`S_${ctx.recipeId}_${c.stepPath}`);
            this._pAddNode(graph.nodes, decisionId, {
              id: decisionId, kind: "decision", provider: c.step.provider, step_path: c.stepPath,
              label: this._pStepLabel(c.step, "decision"), branch_context: (ctx.branchStack || []).join(" / ")
            });

            if (ci === 0) {
              const isFirst = (prev === entryFromNodeId && !first);
              this._pAddEdge(graph.edges, prev, decisionId, isFirst ? entryEdgeLabel : "", "flow");
              if (!first) first = decisionId;
            } else {
              this._pAddEdge(graph.edges, lastDecisionId, decisionId, "false", "flow");
            }

            const thenCtx = { ...ctx, stepPathPrefix: c.stepPath, branchStack: [...(ctx.branchStack||[]), this._pDecisionBranchLabel(c.step)] };
            const thenRes = this._scanBlockForProcessGraph(c.step.block || [], thenCtx, graph, decisionId, "true");
            thenExits.push(thenRes.first ? thenRes.last : decisionId);
            lastDecisionId = decisionId;
          }

          // Chain Merge
          const chainMergeId = this._pNodeId(`M_${ctx.recipeId}_${chain[0].stepPath}_chain_merge`);
          this._pAddNode(graph.nodes, chainMergeId, { id: chainMergeId, kind: "merge", label: "Merge" });
          thenExits.forEach(exitId => this._pAddEdge(graph.edges, exitId, chainMergeId, "", "flow"));

          // Else handling
          let elseBlock = chain.find(c => c.step.else_block && c.step.else_block.length > 0)?.step.else_block;
          if (elseBlock) {
             const elseCtx = { ...ctx, stepPathPrefix: `${chain[0].stepPath}/else`, branchStack: [...(ctx.branchStack||[]), "ELSE"] };
             const elseRes = this._scanBlockForProcessGraph(elseBlock, elseCtx, graph, lastDecisionId, "false");
             this._pAddEdge(graph.edges, (elseRes.first ? elseRes.last : lastDecisionId), chainMergeId, "", "flow");
          } else {
             this._pAddEdge(graph.edges, lastDecisionId, chainMergeId, "false", "flow");
          }

          prev = chainMergeId;
          index = j - 1;
          continue;
        }
      }

      // --- SINGLE STEP / SIMPLE DECISION ---
      const nodeId = this._pNodeId(`S_${ctx.recipeId}_${stepPath}`);
      this._pAddNode(graph.nodes, nodeId, {
        id: nodeId, kind, provider: step.provider, step_path: stepPath,
        label: this._pStepLabel(step, kind), branch_context: (ctx.branchStack || []).join(" / ")
      });

      const isFirst = (prev === entryFromNodeId && !first);
      this._pAddEdge(graph.edges, prev, nodeId, isFirst ? entryEdgeLabel : "", "flow");
      if (!first) first = nodeId;

      let mainExit = nodeId;
      
      // Blocks (If/Else)
      if (kind === "decision") {
         const mergeId = this._pNodeId(`M_${ctx.recipeId}_${stepPath}_merge`);
         this._pAddNode(graph.nodes, mergeId, { id: mergeId, kind: "merge", label: "Merge" });

         const thenCtx = { ...ctx, stepPathPrefix: stepPath, branchStack: [...(ctx.branchStack||[]), "TRUE"] };
         const thenRes = this._scanBlockForProcessGraph(step.block || [], thenCtx, graph, nodeId, "true");
         
         const elseCtx = { ...ctx, stepPathPrefix: `${stepPath}/else`, branchStack: [...(ctx.branchStack||[]), "FALSE"] };
         const elseRes = this._scanBlockForProcessGraph(step.else_block || [], elseCtx, graph, nodeId, "false");
         
         this._pAddEdge(graph.edges, (thenRes.first ? thenRes.last : nodeId), mergeId, "", "flow");
         this._pAddEdge(graph.edges, (elseRes.first ? elseRes.last : nodeId), mergeId, "", "flow");
         mainExit = mergeId;
      } 
      // Sequential block (e.g. groups)
      else if (Array.isArray(step.block) && step.block.length > 0) {
         const childCtx = { ...ctx, stepPathPrefix: stepPath };
         const childRes = this._scanBlockForProcessGraph(step.block, childCtx, graph, nodeId, "");
         mainExit = childRes.last || nodeId;
      }

      // Error Handling
      if (step.error_block && step.error_block.length > 0) {
        const errMergeId = this._pNodeId(`M_${ctx.recipeId}_${stepPath}_err_merge`);
        this._pAddNode(graph.nodes, errMergeId, { id: errMergeId, kind: "merge", label: "Error Merge" });
        this._pAddEdge(graph.edges, mainExit, errMergeId, "ok", "flow");
        
        const errCtx = { ...ctx, stepPathPrefix: `${stepPath}/error`, branchStack: [...(ctx.branchStack||[]), "ON_ERROR"] };
        const errRes = this._scanBlockForProcessGraph(step.error_block, errCtx, graph, nodeId, "error");
        this._pAddEdge(graph.edges, (errRes.first ? errRes.last : nodeId), errMergeId, "", "flow");
        prev = errMergeId;
      } else {
        prev = mainExit;
      }
    }
    return { first, last: prev };
  }

  // ----- Internal utilities -----------------------------------------------
  _pNodeId(raw) { return `N_${String(raw||"").replace(/[^0-9a-zA-Z_]/g, "_").replace(/^([0-9])/, "_$1")}`; }
  _pAddNode(nodes, id, node) { if (!nodes.has(id)) nodes.set(id, node); }
  _pAddEdge(edges, from, to, label="", kind="flow") { edges.push({ from, to, label, kind }); }
  _pClassifyStep(step) {
    if (this._pIsLoopStep(step)) return "loop";
    const kw = this._pKeyword(step);
    if (kw === "if" || kw === "elsif") return "decision";
    const input = step?.input || {};
    const found = this._findIdKeyAndValue(input, this.CONSTANTS.FLOW_ID_KEYS, 3);
    if ((found && found.value) || this.CONSTANTS.RECIPE_PROVIDERS.includes(step.provider)) return "call";
    return "step";
  }
  _pKeyword(step) { return String(step?.keyword || "").toLowerCase(); }
  _pIsElsif(step) { return this._pKeyword(step) === "elsif"; }
  _pIsLoopStep(step) {
    const kw = this._pKeyword(step);
    const name = String(step?.name || step?.as || "").toLowerCase();
    return ["repeat","while","foreach"].some(k => kw.includes(k) || name.includes(k));
  }
  _pStepLabel(step, kind) {
    const name = step?.name || step?.as || "Step";
    if (kind === "call") return `${name} -> Call`;
    if (kind === "decision") return `${this._pKeyword(step).toUpperCase()} ${this._formatConditionSummary(step)}`;
    return name;
  }
  _pDecisionBranchLabel(step) { return this._formatConditionSummary(step) || "THEN"; }
  /**
   * Normalizes a callee reference into a discriminated shape.
   * Live API: numeric ID. Package export: {zip_name, name, folder}.
   * Anything else (datapill, expression): dynamic — statically unorderable.
   * @private
   */
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
  _extractStepDetails(step) {
    let d = [];
    const inp = step.input || {};
    if (inp.conditions) d.push(`Conditions: ${this._formatConditionSummary(step)}`);
    ['to','subject','from','sql'].forEach(k => { if(inp[k]) d.push(`${k}: ${this._cleanDataPill(inp[k])}`); });
    return d.join('\n');
  }
  _cleanDataPill(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/#\{_dp\('(.*?)'\)\}/g, (_, esc) => {
      try { return `{{${JSON.parse(esc.replace(/\\"/g, '"')).label}}}`; } catch(e) { return "{{var}}"; }
    });
  }
  _mNormalizeNodeLabel(s) { return String(s||"").replace(/["\n]/g, " ").slice(0, this.CONSTANTS.MERMAID_LABEL_MAX); }
  _mNormalizeEdgeLabel(s) { return String(s||"").replace(/[|"\n]/g, " ").slice(0, this.CONSTANTS.MERMAID_LABEL_MAX); }

  // Summarizers
  _summarizeCallEdges(g, lim) { return (g.edges||[]).slice(0, lim).map(e => `${e.parent_recipe_id}->${e.child_recipe_id}`); }
  _summarizeProcessKinds(g) { 
    const c = {start:0,end:0,step:0,decision:0,loop:0,call:0,merge:0,other:0};
    (g.nodes ? Array.from(g.nodes.values()) : []).forEach(n => c[n.kind||"other"] = (c[n.kind||"other"]||0)+1);
    return c;
  }
  _summarizeProcessCallTargets(g, lim) {
    const t = new Set();
    (g.nodes ? Array.from(g.nodes.values()) : []).filter(n => n.kind === "call").forEach(n => t.add(n.label));
    return Array.from(t).slice(0, lim);
  }
  _summarizeProcessEdges(g, lim) { return (g.edges||[]).slice(0, lim).map(e => `${e.from}->${e.to}`); }
}