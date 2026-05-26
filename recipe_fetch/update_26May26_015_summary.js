/**
 * Recipe plain-language summaries.
 *
 * Pipeline, in three layers:
 *   1. summarizeRecipe()   PURE. Walks the code tree into a faithful, ordered
 *                          text outline + a "systems touched" footer. No I/O,
 *                          no model. This alone is a usable summary.
 *   2. narrateSummary_()   Sends the outline (not raw recipe JSON) to a model
 *                          and gets back plain prose. The model can't invent
 *                          structure because the structure is handed to it.
 *   3. summarizeRecipesToDrive()  Hash-gates on recipeLogicalHash so the model
 *                          is called only for recipes whose logic changed, then
 *                          writes one committable Markdown file per recipe.
 *
 * The deterministic outline is both the model's input and its zero-cost
 * fallback. Run previewRecipeOutline(id) to eyeball faithfulness before
 * spending a single token; run inspectRecipeKeywords() first to confirm the
 * keyword vocabulary below actually matches your recipes.
 *
 * Depends on: 00_workato_lib (httpJson_, getOrCreateSubfolder_, getOrCreateSheet_),
 *             01_canonical_hash (recipeLogicalHash), 03_recipe_trimmer
 *             (isMeaningfulDescription_), 04_recipe_extractor (walkSteps_,
 *             extractDataTableOps), 07_recipe_drive_cache (loadRecipesFromDrive,
 *             loadRecipeFromDrive, getOrThrowDriveFolder_), 09_data_table_ops_report
 *             (buildTableNameIndex_).
 */


// --- VOCABULARY ----------------------------------------------------------------------
// Friendly labels for provider strings. Fallback humanizes the raw value, so an
// unmapped provider is never dropped — extend this from inspectConnectorUsage output.
const FRIENDLY_PROVIDERS = {
  workato_db_table:     'Data Tables',
  data_tables:          'Data Tables',
  workato_file_storage: 'FileStorage',
  file_storage:         'FileStorage',
  google_mail:          'Gmail',
  gmail:                'Gmail',
  workato_python:       'Python',
  python:               'Python',
  workato_workflow_app: 'Workflow App',
  http:                 'HTTP',
  rest:                 'HTTP'
};


// --- PURE: OUTLINE BUILD -------------------------------------------------------------
/**
 * Build a faithful, plain-text outline of a recipe plus its systems footer.
 *
 * @param {Object} recipe                 Structured recipe (with .code)
 * @param {Object} [tableNameById]        Optional id -> name map for friendly
 *                                        table names in the reads/writes footer
 * @returns {{ id, name, logical_hash, outline_text, providers, reads, writes }}
 */
function summarizeRecipe(recipe, tableNameById) {
  tableNameById = tableNameById || {};

  const lines     = [];
  const providers = {};

  walkSteps_(recipe.code, '', function (node, path) {
    const depth = (path.match(/block\[/g) || []).length;
    lines.push('  '.repeat(depth) + labelStep_(node));
    if (node && node.provider) providers[friendlyProvider_(node.provider)] = true;
  });

  // Reads / writes from the existing pure extractor, name-enriched if a map is given.
  const reads  = {};
  const writes = {};
  extractDataTableOps(recipe).forEach(function (op) {
    if (!op.table_id) return;
    const name = tableNameById[op.table_id] || op.table_id;
    if (op.direction === 'read')  reads[name]  = true;
    if (op.direction === 'write') writes[name] = true;
  });

  return {
    id:           recipe.id,
    name:         recipe.name || '',
    logical_hash: recipeLogicalHash(recipe.code),
    outline_text: lines.join('\n'),
    providers:    Object.keys(providers).sort(),
    reads:        Object.keys(reads).sort(),
    writes:       Object.keys(writes).sort()
  };
}
/**
 * One outline line for a step. Prefers an authored, meaningful description
 * (already filtered of auto "Step N" labels by the trimmer's helper); otherwise
 * derives a clause from the keyword/provider/name. Unknown keywords degrade to a
 * generic clause rather than disappearing.
 */
function labelStep_(node) {
  if (!node || typeof node !== 'object') return '(empty step)';
  if (isMeaningfulDescription_(node.description)) return String(node.description).trim();

  const kw = String(node.keyword || '').toLowerCase();
  switch (kw) {
    case 'trigger': return `Trigger: ${friendlyAction_(node)}`;
    case 'if':      return 'If a condition is met:';
    case 'elsif':   return 'Otherwise, if another condition is met:';
    case 'else':    return 'Otherwise:';
    case 'foreach': return 'For each item in the list:';
    case 'repeat':  return 'Repeat for each item:';
    case 'while':   return 'While a condition holds:';
    case 'try':     return 'Try:';
    case 'catch':
    case 'rescue':  return 'On error:';
    case 'stop':    return 'Stop the job.';
    case 'return':  return 'Return a result to the caller.';
    case 'call':
      return 'Call another recipe'
        + (node.input && node.input.recipe_id ? ` (#${node.input.recipe_id})` : '') + '.';
    case 'action':  return friendlyAction_(node);
    default:
      if (node.provider || node.name) return friendlyAction_(node);
      return kw ? `A "${kw}" step.` : '(unlabeled step)';
  }
}
function friendlyAction_(node) {
  const provider = friendlyProvider_(node.provider);
  const action   = humanizeName_(node.name);
  if (action && provider) return `${action} in ${provider}`;
  if (action)             return action;
  if (provider)           return `Use ${provider}`;
  return 'Perform a step';
}
function friendlyProvider_(p) {
  if (!p) return '';
  const key = String(p).toLowerCase();
  return FRIENDLY_PROVIDERS[key] || humanizeName_(p);
}
function humanizeName_(s) {
  if (!s) return '';
  const t = String(s).replace(/_/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}


// --- NARRATION (the only model-facing layer) -----------------------------------------
function narrateSummary_(summary) {
  const system =
    'You write plain-language summaries of automation "recipes" for a non-technical ' +
    'audience (analysts, project managers). You are given the recipe name and a ' +
    'faithful, ordered outline of its steps. Write 2-4 short sentences in plain ' +
    'English describing what the recipe does and which systems it touches. Rules: ' +
    'describe only what is in the outline — never invent steps; avoid technical ' +
    'jargon and any "#{...}" datapill syntax; do not use bullet points or headings; ' +
    'output the summary text only, with no preamble.';

  const user = `Recipe: ${summary.name || ('#' + summary.id)}\n\nOutline:\n${summary.outline_text}`;
  return callModel_(system, user);
}
/**
 * PROVIDER SEAM. Implemented against the Anthropic Messages API for minimal
 * setup. To repoint at Vertex AI or any other provider, this is the ONLY
 * function to change: build that provider's request body/headers and extract
 * its text. The transport (httpJson_) gives you 429/5xx backoff for free.
 *
 * Script Properties:
 *   LLM_API_KEY   required
 *   LLM_MODEL     optional, defaults to a low-cost model
 */
function callModel_(systemPrompt, userPrompt) {
  const props  = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('LLM_API_KEY');
  if (!apiKey) throw new Error('Set LLM_API_KEY in Script Properties to enable narration.');
  const model = props.getProperty('LLM_MODEL') || 'claude-haiku-4-5-20251001';

  const json = httpJson_('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model:       model,
      max_tokens:  400,
      temperature: 0.2,            // low, for stable wording run-to-run
      system:      systemPrompt,
      messages:    [{ role: 'user', content: userPrompt }]
    })
  }, 'LLM narration');

  const block = (json && Array.isArray(json.content))
    ? json.content.filter(function (b) { return b.type === 'text'; })[0]
    : null;
  if (!block || !block.text) throw new Error('Model returned no text content.');
  return block.text;
}


// --- PUBLIC: DRIVE WRITE -------------------------------------------------------------
/**
 * Summarize every cached recipe to Drive as Markdown. Hash-gated: a recipe is
 * re-narrated only when its logical hash differs from the one stamped in the
 * existing file, so token spend tracks actual logic changes.
 */
function summarizeRecipesToDrive() {
  const recipes = loadRecipesFromDrive();
  if (recipes.length === 0) {
    SpreadsheetApp.getActive().toast(
      'No cached recipes. Run "Sync recipes (full structure)" first.', 'Summaries', 5
    );
    return;
  }

  const tableNameById = buildTableNameIndex_();   // one API pass for friendly table names
  const subfolder     = getOrCreateSubfolder_(getOrThrowDriveFolder_(), 'summaries');
  const stats         = { written: 0, reused: 0, failed: 0 };

  recipes.forEach(function (recipe) {
    try {
      const summary  = summarizeRecipe(recipe, tableNameById);
      const filename = `summary_${summary.id}.md`;

      if (readExistingSummaryHash_(subfolder, filename) === summary.logical_hash) {
        stats.reused += 1;
        return;
      }

      const prose = narrateSummary_(summary);
      upsertTextFile_(subfolder, filename, renderSummaryMarkdown_(summary, prose));
      stats.written += 1;
    } catch (err) {
      stats.failed += 1;
      Logger.log(`Summary failed for ${recipe.id}: ${err.message}`);
    }
  });

  let msg = `Summaries: ${stats.written} written, ${stats.reused} unchanged`;
  if (stats.failed) msg += `, ${stats.failed} failed (see Logs)`;
  SpreadsheetApp.getActive().toast(msg, 'Summaries', 8);
}


// --- EDITOR-RUN DIAGNOSTICS ----------------------------------------------------------
/**
 * Tally distinct `keyword` values across the cache. RUN THIS FIRST to confirm
 * the keyword set in labelStep_ covers what your recipes actually use.
 */
function inspectRecipeKeywords() {
  const recipes = loadRecipesFromDrive();
  if (recipes.length === 0) {
    Logger.log('No cached recipes. Run "Sync recipes (full structure)" first.');
    return;
  }

  const counts = {};
  recipes.forEach(function (r) {
    if (!r.code) return;
    walkSteps_(r.code, '', function (node) {
      const kw = node && node.keyword ? String(node.keyword) : '(none)';
      counts[kw] = (counts[kw] || 0) + 1;
    });
  });

  const rows = Object.keys(counts)
    .map(function (k) { return { keyword: k, count: counts[k] }; })
    .sort(function (a, b) { return b.count - a.count; });

  Logger.log(`Distinct keywords across ${recipes.length} recipes:`);
  rows.forEach(function (r) { Logger.log(`  ${r.keyword} (${r.count})`); });

  const sheet = getOrCreateSheet_('Recipe Keywords');
  sheet.clear();
  sheet.getRange(1, 1, 1, 2).setValues([['keyword', 'count']]).setFontWeight('bold');
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 2)
         .setValues(rows.map(function (r) { return [r.keyword, r.count]; }));
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 2);
}
/** Log the zero-LLM outline for one recipe, to check faithfulness before narrating. */
function previewRecipeOutline(recipeId) {
  if (!recipeId) {
    Logger.log('Pass a recipe id, e.g. previewRecipeOutline(12345)');
    return;
  }
  const summary = summarizeRecipe(loadRecipeFromDrive(recipeId), {});
  Logger.log(summary.outline_text);
  Logger.log('--- systems ---');
  Logger.log(`providers: ${summary.providers.join(', ')}`);
  Logger.log(`reads:     ${summary.reads.join(', ')}`);
  Logger.log(`writes:    ${summary.writes.join(', ')}`);
}


// --- INTERNALS -----------------------------------------------------------------------
/**
 * Markdown for one recipe. The logical hash is stamped as an HTML comment so the
 * next run can hash-gate. No generated-at timestamp on purpose: the hash records
 * provenance, and omitting the clock means a committed file diffs only when the
 * recipe's logic actually changed.
 */
function renderSummaryMarkdown_(summary, prose) {
  const lines = [];
  lines.push(`# ${summary.name || ('Recipe ' + summary.id)}`);
  lines.push('');
  lines.push(`<!-- logical_hash: ${summary.logical_hash} -->`);
  lines.push('');
  lines.push(String(prose).trim());
  lines.push('');
  if (summary.providers.length) lines.push(`**Systems touched:** ${summary.providers.join(', ')}`);
  if (summary.reads.length)     lines.push(`**Reads:** ${summary.reads.join(', ')}`);
  if (summary.writes.length)    lines.push(`**Writes:** ${summary.writes.join(', ')}`);
  lines.push('');
  lines.push('<details><summary>Structure outline</summary>');
  lines.push('');
  lines.push('```');
  lines.push(summary.outline_text);
  lines.push('```');
  lines.push('</details>');
  return lines.join('\n');
}
function readExistingSummaryHash_(folder, filename) {
  const files = folder.getFilesByName(filename);
  if (!files.hasNext()) return null;
  const text = files.next().getBlob().getDataAsString();
  const m = text.match(/<!--\s*logical_hash:\s*([0-9a-f]+)\s*-->/i);
  return m ? m[1] : null;
}
function upsertTextFile_(folder, filename, payload) {
  const existing = folder.getFilesByName(filename);
  if (existing.hasNext()) {
    existing.next().setContent(payload);
    return;
  }
  folder.createFile(filename, payload, MimeType.PLAIN_TEXT);
}

function callModel_(systemPrompt, userPrompt) {
  const props    = PropertiesService.getScriptProperties();
  const project  = props.getProperty('GCP_PROJECT');
  const location = props.getProperty('GCP_LOCATION') || 'us-central1';
  if (!project) throw new Error('Set GCP_PROJECT in Script Properties for Vertex AI.');
  const model = props.getProperty('LLM_MODEL') || 'gemini-2.5-flash';

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}`
            + `/locations/${location}/publishers/google/models/${model}:generateContent`;

  const json = httpJson_(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': `Bearer ${ScriptApp.getOAuthToken()}` },
    payload: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 512,
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  }, 'Vertex Gemini narration');

  return extractGeminiText_(json);
}
