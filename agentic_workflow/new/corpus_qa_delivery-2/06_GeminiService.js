/**
 * @file 06_Gemini_Service.js
 * @description Service for interacting with Google Vertex AI via the GeminiLib library.
 */

/**
 * @class
 * @classdesc Service for interacting with Google Vertex AI via the GeminiClient library.
 * GeminiService ID: 1mc_Jm9FmSo2yMzjAaVdtD7Ww95Fa2RPLQ1-4Kb5kTtEwkuSfrOBCIzKZ
 */
class GeminiService {
  constructor() {
    const config = AppConfig.get().VERTEX;
    this.config = config;

    if (!config.GOOGLE_CLOUD_PROJECT_ID) {
      throw new Error(
        "Vertex project not configured. Set it via WorkatoSync -> Configuration -> Set Vertex project ID."
      );
    }

    this.client = GeminiLib.newClient(
      config.GOOGLE_CLOUD_PROJECT_ID,
      config.LOCATION,
      config.MODEL_ID
    );

    this.genConfig = config.GENERATION_CONFIG;
  }
  /**
   * Generates a natural language summary of a Workato recipe.
   * @param {Object} recipe - The full recipe object.
   * @returns {string} The AI-generated summary.
   */
  explainRecipe(recipe, graphPack = null, logicDigest = "") {
    const ctx = this._prepareContext(recipe, graphPack, logicDigest);
    const prompt = this._buildPrompt(ctx);

    // Delegate to library
    return this.client.generateContent(prompt, {
      generationConfig: this.genConfig
    });
  }
  /**
   * Returns a structured analysis object (JSON) so we can split into columns.
   * @returns {{objective:string,trigger:string,high_level_flow:string[],hotspots:string[],external_apps:string[],called_recipes:string[],risks_notes:string[]}}
   */
  explainRecipeStructured(recipe, graphPack = null, logicDigest = "") {
    const ctx = this._prepareContext(recipe, graphPack, logicDigest);
    const prompt = this._buildStructuredPrompt(ctx);

    // Delegate to Library (using the structured helper)
    const result = this.client.generateStructured(prompt, {
      generationConfig: this.genConfig
    });

    // Fallback if AI fails to return valid JSON
    return result || {
      objective: "Analysis failed",
      trigger: "Unknown",
      high_level_flow: [],
      hotspots: [],
      external_apps: [],
      called_recipes: [],
      risks_notes: ["AI output could not be parsed."]
    };
  }

  /**
   * Generates a system-level architecture document explaining how multiple recipes interact.
   * @param {Array<Object>} recipesData - Basic metadata and logic digests for all recipes.
   * @param {Array<string>} globalEdges - Deduplicated list of call edges between the recipes.
   */
  generateSystemDoc(recipesData, globalEdges) {
    const prompt = `
      You are an expert integration architect reviewing a Workato workspace.
      I will provide a list of recipes and a list of call edges (dependencies) representing how they trigger one another.

      Write a comprehensive "System Architecture Overview" in Markdown.
      Your document must include:
      1. **Executive Summary:** A high-level overview of the entire multi-recipe workflow.
      2. **Core Orchestration:** Detail how the connected recipes interact to achieve the main business process based on the call edges.
      3. **Standalone / Isolated Recipes:** Explicitly identify any recipes provided in the context that DO NOT have incoming or outgoing call edges connecting them to the rest of this specific set. Explain what their standalone purpose is based on their logic summary.
      4. **Risks & Bottlenecks:** Systemic risks (e.g., circular dependencies, tight coupling).

      Here is the Context:

      --- RECIPES ---
      ${JSON.stringify(recipesData, null, 2)}

      --- CALL EDGES (DEPENDENCIES) ---
      ${JSON.stringify(globalEdges, null, 2)}
    `.trim();

    return this.client.generateContent(prompt, {
      generationConfig: this.genConfig
    });
  }

  /**
   * ***UPDATED*** Corpus Q&A: answer one question from the whole-estate digest in ONE structured call.
   * The digest legitimately trips GeminiLib's 100k-char _validateTokenLoad check — that check only
   * WARNS, and VERTEX.PROMPT_MAX_CHARS is not enforced on this path. Never route the digest through
   * anything that truncates: a silently clipped corpus breaks the evidence contract.
   * @param {string} corpusDigest - Full digest text (all seven blocks).
   * @param {string} question
   * @returns {Object|null} {answer, citations, not_in_corpus} — null when the lib can't parse the
   *   reply (CorpusQaService turns null into a graceful "unparseable" message, never a throw).
   */
  answerFromCorpus(corpusDigest, question) {
    const prompt = this._buildCorpusPrompt(corpusDigest, question);
    return this.client.generateStructured(prompt, {
      generationConfig: this.genConfig
    });
  }

  // --- STATIC ------------------------------------------------------------------------------------------
  /**
   * Lists Model Garden publisher models. Catalog metadata, not a serveability check.
   * @param {{ publisher?: string, location?: string, pageSize?: number }} [opts]
   * @returns {Array<{id:string, name:string, versionId:string, launchStage:string}>}
   */
  static listPublisherModels(opts = {}) {
    const cfg = AppConfig.get().VERTEX;
    const publisher = opts.publisher || "google";
    // "global" has no region prefix and shows the broadest catalog;
    // a regional host reflects what's serveable there.
    const location = opts.location || "global";
    const host = (location === "global")
      ? "aiplatform.googleapis.com"
      : `${location}-aiplatform.googleapis.com`;

    const token = ScriptApp.getOAuthToken();
    const out = [];
    let pageToken = "", safety = 0;

    do {
      const url =
        `https://${host}/v1beta1/publishers/${publisher}/models` +
        `?pageSize=${opts.pageSize || 200}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");

      const resp = UrlFetchApp.fetch(url, {
        method: "get",
        headers: {
          Authorization: `Bearer ${token}`,
          "x-goog-user-project": cfg.GOOGLE_CLOUD_PROJECT_ID  // quota/billing attribution
        },
        muteHttpExceptions: true
      });

      const code = resp.getResponseCode();
      const body = resp.getContentText();
      if (code !== 200) throw new Error(`publishers.models.list ${code}: ${body}`);

      const json = JSON.parse(body);
      (json.publisherModels || []).forEach(m => out.push({
        id: String(m.name || "").split("/").pop(),  // e.g. gemini-2.5-pro
        name: m.name,                                 // publishers/google/models/...
        versionId: m.versionId || "",
        launchStage: m.launchStage || ""
      }));
      pageToken = json.nextPageToken || "";
    } while (pageToken && ++safety < 20);

    return out;
  }

  // --- INTERNALS ---------------------------------------------------------------------------------------
  /**
   * Strips raw recipe data down to the essential logic for the LLM.
   * @private
   */
  _prepareContext(recipe, graphPack, logicDigest) {
    // If 'code' is still a string (hasn't been parsed by DriveService yet), parse it temporarily
    let logicBlock = recipe.code;
    if (typeof logicBlock === 'string') {
      try { logicBlock = JSON.parse(logicBlock); } catch (e) { }
    }

    return {
      name: recipe.name,
      description: recipe.description, // existing manual description
      trigger_app: recipe.trigger_application,
      connected_apps: recipe.action_applications,
      logic_digest: String(logicDigest || ""),
      graphs: graphPack || null
    };
  }
  /** @private ***UPDATED*** citation form is now the literal (step N) — restores agreement with the 52 evidence-contract test */
  _buildPrompt(ctx) {
    const caps = this.config;
    const mermaidCap = Number(caps.MERMAID_PROMPT_MAX_CHARS || 12000);

    const graphs = ctx.graphs || {};
    const call = graphs.call || {};
    const proc = graphs.process || {};

    const callMermaid = (call.mermaid && String(call.mermaid).length <= mermaidCap) ? call.mermaid : "";
    const procMermaid = (proc.mermaid && String(proc.mermaid).length <= mermaidCap) ? proc.mermaid : "";

    const graphMetrics = {
      call: {
        depth: call.depth,
        node_count: call.node_count,
        edge_count: call.edge_count,
        notes: call.notes
      },
      process: {
        node_count: proc.node_count,
        edge_count: proc.edge_count,
        kind_counts: proc.kind_counts,
        call_targets: proc.call_targets,
        notes: proc.notes
      }
    };

    return `
      You are an expert Workato developer and systems architect.
      Only use the provided context. If something isn't present, say "Unknown from provided data."
      Cite the supporting step inline as (step N) for every behavioral claim, using the step numbers from
      "Flattened steps". Never speculate about intent.

      Produce:
      1) Objective (1 sentence)
      2) Trigger (what starts it)
      3) High-level flow (5-12 bullets)
      4) Control-flow hotspots (IF/ELSE chains, loops, ON_ERROR paths)
      5) Dependencies
        - External apps
        - Called recipes (from call graph + step-level call nodes)
      6) Risks / notes (cycles, large fan-out, truncation, node caps)

      Recipe meta:
      - Name: ${ctx.name || ""}
      - Description: ${ctx.description || ""}
      - Trigger app: ${ctx.trigger_app || ""}
      - Connected apps: ${JSON.stringify(ctx.connected_apps || [])}

      Flattened steps (may be truncated):
      ${ctx.logic_digest || "(none)"}

      Graph metrics:
      ${JSON.stringify(graphMetrics, null, 2)}

      Call graph edges sample:
      ${(call.edges_sample || []).join("\n")}

      Process graph edges sample:
      ${(proc.edges_sample || []).join("\n")}

      ${callMermaid ? `Mermaid (call graph):\n${callMermaid}\n` : "Mermaid (call graph): (omitted due to size cap)\n"}
      ${procMermaid ? `Mermaid (process graph):\n${procMermaid}\n` : "Mermaid (process graph): (omitted due to size cap)\n"}
      `.trim();
  }
  /** @private ***UPDATED*** citation form is now the literal (step N) — restores agreement with the 52 evidence-contract test */
  _buildStructuredPrompt(ctx) {
    const graphs = ctx.graphs || {};
    const call = graphs.call || {};
    const proc = graphs.process || {};

    // Keep the prompt compact; send summaries + samples, not full Mermaid.
    const graphMetrics = {
      call: {
        depth: call.depth,
        node_count: call.node_count,
        edge_count: call.edge_count,
        notes: call.notes
      },
      process: {
        node_count: proc.node_count,
        edge_count: proc.edge_count,
        kind_counts: proc.kind_counts,
        call_targets: proc.call_targets,
        notes: proc.notes
      }
    };

    return `
      Return ONLY valid JSON (no markdown, no code fences).
      Schema:
      {
        "objective": "string",
        "trigger": "string",
        "high_level_flow": ["string", ...],
        "hotspots": ["string", ...],
        "external_apps": ["string", ...],
        "called_recipes": ["string", ...],
        "risks_notes": ["string", ...]
      }

      Use ONLY the provided context. If unknown, use "" or [].

      Evidence contract:
        Every behavioral claim (e.g., items in high_level_flow, hotspots, and risks_notes), must cite
        the supporting step inline as (step N), using the step numbers shown in "Flattened steps" below. If the provided facts
        do not establish something, write "not determinable from recipe code" for that item, rather than
        inferring. Never speculate about intent.

      Recipe meta:
      - Name: ${ctx.name || ""}
      - Description: ${ctx.description || ""}
      - Trigger app: ${ctx.trigger_app || ""}
      - Connected apps: ${JSON.stringify(ctx.connected_apps || [])}

      Flattened steps (may be truncated):
      ${ctx.logic_digest || "(none)"}

      Graph metrics:
      ${JSON.stringify(graphMetrics)}

      Call graph edges sample:
      ${(call.edges_sample || []).join("\n")}

      Process graph edges sample:
      ${(proc.edges_sample || []).join("\n")}
      `.trim();
  }

  /**
   * ***UPDATED*** Corpus Q&A prompt: the answer contract first (verbatim — tests assert on it),
   * then the corpus, then the question. Joined lines rather than a template literal, so the
   * multi-hundred-KB digest never picks up indentation noise.
   * @private
   */
  _buildCorpusPrompt(corpusDigest, question) {
    return [
      CORPUS_ANSWER_CONTRACT,
      "",
      "--- CORPUS DOCUMENT (sole source of truth) ---",
      String(corpusDigest || ""),
      "",
      "--- QUESTION ---",
      String(question || "")
    ].join("\n");
  }
}
