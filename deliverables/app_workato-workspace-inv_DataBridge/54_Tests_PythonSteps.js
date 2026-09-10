/**
 * @file 54_Tests_PythonSteps.js
 * @description Tests for the Python step inventory (15_Feature_PythonSteps) and the GraphLib step walker it relies on.
 *
 *   TIER 1 — HERMETIC   runPythonStepUnitTests()
 *     PythonStepAnalyzer + DataMapper.mapPythonStepsToRows against a reduced copy of recipe 2071421 (TPL-02 Build XLSX).
 *     The two injected dependencies (sha256, pill extractor) are local stubs, so nothing crosses a library boundary.
 *
 *   TIER 2 — INTEGRATION   runPythonStepIntegrationTests()
 *     collectSteps / extractPillRefs through RecipeAnalyzerService (WorkatoGraphLib >= 1.1.0) with a fake client, then
 *     the analyzer with the REAL pill extractor, asserting it agrees with the hermetic stub. Self-skips if the library
 *     is not bound or is an older version.
 *
 *   runPythonStepTests() runs both.
 *
 *   Fixture notes: `code` is stored as a STRING, the way the API returns it (the Drive save from logic.debug parses it
 *   into an object; GraphLib accepts both). The Python step's body is a short stand-in with the same shape as the real
 *   ~700-line script — imports, a class, top-level defs, a nested def, a main returning a dict. The extended_*_schema
 *   mirrors were dropped; the analyzer never reads them.
 */

// =======================================================================================
// FIXTURE
// =======================================================================================
class PythonStepFixtures {
  /** Recipe 2071421 "TPL-02 Build XLSX": recipe function -> try -> py_eval -> catch -> return_result. */
  static tpl02() {
    return {
      "id": 2071421,
      "name": "TPL-02 Build XLSX",
      "created_at": "2026-05-20T22:55:42.707-07:00",
      "updated_at": "2026-08-17T16:38:15.248-07:00",
      "trigger_application": "workato_recipe_function",
      "action_applications": [
        "py_eval"
      ],
      "applications": [
        "workato_recipe_function",
        "py_eval"
      ],
      "description": "",
      "project_id": 1122793,
      "folder_id": 1533922,
      "running": true,
      "job_succeeded_count": 221,
      "job_failed_count": 11,
      "lifetime_task_count": 449,
      "last_run_at": "2026-08-17T16:39:05.738-07:00",
      "stopped_at": "2026-08-17T16:25:28.803-07:00",
      "code": "{\"number\": 0, \"provider\": \"workato_recipe_function\", \"name\": \"execute\", \"as\": \"ee00569c\", \"keyword\": \"trigger\", \"input\": {\"parameters_schema_json\": \"[{\\\"name\\\":\\\"canonical_model_json\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":false,\\\"label\\\":\\\"canonical_model_json\\\",\\\"control_type\\\":\\\"text\\\"},{\\\"name\\\":\\\"variant_id\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true,\\\"label\\\":\\\"variant_id\\\",\\\"control_type\\\":\\\"text\\\"},{\\\"name\\\":\\\"customer_name\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":false,\\\"label\\\":\\\"customer_name\\\",\\\"control_type\\\":\\\"text\\\"},{\\\"name\\\":\\\"variant_name\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true,\\\"label\\\":\\\"variant_name\\\",\\\"control_type\\\":\\\"text\\\"},{\\\"name\\\":\\\"protection_password\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":false,\\\"label\\\":\\\"protection_password\\\",\\\"control_type\\\":\\\"text\\\"}]\", \"result_schema_json\": \"[{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"status\\\",\\\"name\\\":\\\"status\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":false,\\\"hint\\\":\\\"success | empty_variant\\\"},{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"file_content\\\",\\\"name\\\":\\\"file_content\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true,\\\"hint\\\":\\\"Populated on success\\\"},{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"suggested_filename\\\",\\\"name\\\":\\\"suggested_filename\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true},{\\\"properties\\\":[{\\\"label\\\":\\\"sheet_names\\\",\\\"name\\\":\\\"sheet_names\\\",\\\"type\\\":\\\"array\\\",\\\"optional\\\":true,\\\"of\\\":\\\"string\\\"},{\\\"control_type\\\":\\\"integer\\\",\\\"label\\\":\\\"byte_size\\\",\\\"parse_output\\\":\\\"integer_conversion\\\",\\\"name\\\":\\\"byte_size\\\",\\\"type\\\":\\\"integer\\\",\\\"optional\\\":true,\\\"render_input\\\":\\\"integer_conversion\\\"},{\\\"control_type\\\":\\\"integer\\\",\\\"label\\\":\\\"row_count\\\",\\\"parse_output\\\":\\\"integer_conversion\\\",\\\"name\\\":\\\"row_count\\\",\\\"type\\\":\\\"integer\\\",\\\"optional\\\":true,\\\"render_input\\\":\\\"integer_conversion\\\"},{\\\"control_type\\\":\\\"integer\\\",\\\"label\\\":\\\"field_count\\\",\\\"parse_output\\\":\\\"integer_conversion\\\",\\\"name\\\":\\\"field_count\\\",\\\"type\\\":\\\"integer\\\",\\\"optional\\\":true,\\\"render_input\\\":\\\"integer_conversion\\\"}],\\\"label\\\":\\\"metadata\\\",\\\"name\\\":\\\"metadata\\\",\\\"type\\\":\\\"object\\\",\\\"optional\\\":true},{\\\"properties\\\":[{\\\"properties\\\":[{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"error_uuid\\\",\\\"name\\\":\\\"error_uuid\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true,\\\"hint\\\":\\\"Workato-generated error unique identifier.\\\"},{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"error_message\\\",\\\"name\\\":\\\"error_message\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true,\\\"hint\\\":\\\"Error message from catch.\\\"},{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"error_type\\\",\\\"name\\\":\\\"error_type\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true,\\\"hint\\\":\\\"Workato-generated error type\\\"}],\\\"label\\\":\\\"technical_failure\\\",\\\"name\\\":\\\"technical_failure\\\",\\\"type\\\":\\\"object\\\",\\\"optional\\\":true},{\\\"properties\\\":[{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"code\\\",\\\"name\\\":\\\"code\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true,\\\"hint\\\":\\\"Machine-readable: empty_variant, ...\\\"},{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"message\\\",\\\"name\\\":\\\"message\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true,\\\"hint\\\":\\\"Human-readable detail\\\"}],\\\"label\\\":\\\"logical_failure\\\",\\\"name\\\":\\\"logical_failure\\\",\\\"type\\\":\\\"object\\\",\\\"optional\\\":true,\\\"hint\\\":\\\"Emitted by the Python action\\\"}],\\\"label\\\":\\\"error\\\",\\\"name\\\":\\\"error\\\",\\\"type\\\":\\\"object\\\",\\\"optional\\\":true,\\\"hint\\\":\\\"Populated when status != 'success'\\\"}]\"}, \"block\": [{\"number\": 1, \"keyword\": \"try\", \"input\": {}, \"block\": [{\"number\": 2, \"provider\": \"py_eval\", \"name\": \"invoke_custom_py_code\", \"as\": \"07c380e4\", \"keyword\": \"action\", \"input\": {\"code\": \"\\\"\\\"\\\"TPL-02 stand-in body (reduced for tests; the real step is ~700 lines).\\\"\\\"\\\"\\nimport base64, json\\nimport io\\nfrom openpyxl.styles import Font\\nfrom openpyxl import Workbook\\nimport re\\n\\nDATA_START_ROW = 3\\n\\nclass BuildError(Exception):\\n    def __init__(self, code, message):\\n        self.code = code\\n\\ndef _is_truthy(val):\\n    def inner(x):\\n        return bool(x)\\n    return inner(val)\\n\\ndef plan_fields(fields):\\n    return [f for f in fields]\\n\\ndef main(input):\\n    model = json.loads(input[\\\"canonical_model_json\\\"])\\n    return {\\\"status\\\": \\\"success\\\", \\\"file_content\\\": None, \\\"suggested_filename\\\": \\\"x.xlsx\\\",\\n            \\\"metadata\\\": {\\\"hidden_field_count\\\": 0}, \\\"error\\\": None}\\n\", \"name\": \"Slice and build\", \"code_output_schema_json\": \"[{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"status\\\",\\\"name\\\":\\\"status\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":false,\\\"hint\\\":\\\"success | empty_variant\\\"},{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"file_content\\\",\\\"name\\\":\\\"file_content\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true,\\\"hint\\\":\\\"Populated on success\\\"},{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"suggested_filename\\\",\\\"name\\\":\\\"suggested_filename\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true},{\\\"properties\\\":[{\\\"label\\\":\\\"sheet_names\\\",\\\"name\\\":\\\"sheet_names\\\",\\\"type\\\":\\\"array\\\",\\\"optional\\\":true,\\\"of\\\":\\\"string\\\"},{\\\"control_type\\\":\\\"integer\\\",\\\"label\\\":\\\"byte_size\\\",\\\"parse_output\\\":\\\"integer_conversion\\\",\\\"name\\\":\\\"byte_size\\\",\\\"type\\\":\\\"integer\\\",\\\"optional\\\":true,\\\"render_input\\\":\\\"integer_conversion\\\"},{\\\"control_type\\\":\\\"integer\\\",\\\"label\\\":\\\"row_count\\\",\\\"parse_output\\\":\\\"integer_conversion\\\",\\\"name\\\":\\\"row_count\\\",\\\"type\\\":\\\"integer\\\",\\\"optional\\\":true,\\\"render_input\\\":\\\"integer_conversion\\\"},{\\\"control_type\\\":\\\"integer\\\",\\\"label\\\":\\\"field_count\\\",\\\"parse_output\\\":\\\"integer_conversion\\\",\\\"name\\\":\\\"field_count\\\",\\\"type\\\":\\\"integer\\\",\\\"optional\\\":true,\\\"render_input\\\":\\\"integer_conversion\\\"},{\\\"control_type\\\":\\\"integer\\\",\\\"label\\\":\\\"locked_field_count\\\",\\\"parse_output\\\":\\\"integer_conversion\\\",\\\"name\\\":\\\"locked_field_count\\\",\\\"type\\\":\\\"integer\\\",\\\"optional\\\":true,\\\"render_input\\\":\\\"integer_conversion\\\"}],\\\"label\\\":\\\"metadata\\\",\\\"name\\\":\\\"metadata\\\",\\\"type\\\":\\\"object\\\",\\\"optional\\\":true},{\\\"properties\\\":[{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"code\\\",\\\"name\\\":\\\"code\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":false,\\\"hint\\\":\\\"Machine-readable: empty_variant, ...\\\"},{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"message\\\",\\\"name\\\":\\\"message\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":false,\\\"hint\\\":\\\"Human-readable detail\\\"}],\\\"label\\\":\\\"error\\\",\\\"name\\\":\\\"error\\\",\\\"type\\\":\\\"object\\\",\\\"optional\\\":true,\\\"hint\\\":\\\"Populated when status != 'success'\\\"}]\", \"code_input\": {\"schema\": \"[{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"canonical_model_json\\\",\\\"name\\\":\\\"canonical_model_json\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true,\\\"hint\\\":\\\"From FileStorage read of file at 'canonical_model_path'\\\",\\\"details\\\":{\\\"real_name\\\":\\\"canonical_model_json\\\"},\\\"parent\\\":[\\\"code_input\\\",\\\"data\\\"]},{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"variant_id\\\",\\\"name\\\":\\\"variant_id\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true,\\\"details\\\":{\\\"real_name\\\":\\\"variant_id\\\"},\\\"parent\\\":[\\\"code_input\\\",\\\"data\\\"]},{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"customer_name\\\",\\\"name\\\":\\\"customer_name\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true,\\\"details\\\":{\\\"real_name\\\":\\\"customer_name\\\"},\\\"parent\\\":[\\\"code_input\\\",\\\"data\\\"]},{\\\"control_type\\\":\\\"text\\\",\\\"label\\\":\\\"variant_name\\\",\\\"name\\\":\\\"variant_name\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true,\\\"hint\\\":\\\"Resolved as 'resolved_variant_name'\\\",\\\"details\\\":{\\\"real_name\\\":\\\"variant_name\\\"},\\\"parent\\\":[\\\"code_input\\\",\\\"data\\\"]},{\\\"name\\\":\\\"protection_password\\\",\\\"type\\\":\\\"string\\\",\\\"optional\\\":true,\\\"label\\\":\\\"protection_password\\\",\\\"details\\\":{\\\"real_name\\\":\\\"protection_password\\\"},\\\"control_type\\\":\\\"text\\\",\\\"parent\\\":[\\\"code_input\\\",\\\"data\\\"]}]\", \"data\": {\"canonical_model_json\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"workato_recipe_function\\\",\\\"line\\\":\\\"ee00569c\\\",\\\"path\\\":[\\\"parameters\\\",\\\"canonical_model_json\\\"]}')}\", \"variant_id\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"workato_recipe_function\\\",\\\"line\\\":\\\"ee00569c\\\",\\\"path\\\":[\\\"parameters\\\",\\\"variant_id\\\"]}')}\", \"customer_name\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"workato_recipe_function\\\",\\\"line\\\":\\\"ee00569c\\\",\\\"path\\\":[\\\"parameters\\\",\\\"customer_name\\\"]}')}\", \"variant_name\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"workato_recipe_function\\\",\\\"line\\\":\\\"ee00569c\\\",\\\"path\\\":[\\\"parameters\\\",\\\"variant_name\\\"]}')}\", \"protection_password\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"workato_recipe_function\\\",\\\"line\\\":\\\"ee00569c\\\",\\\"path\\\":[\\\"parameters\\\",\\\"protection_password\\\"]}')}\"}}, \"payload_asset_type\": \"inline\"}, \"visible_config_fields\": [\"name\", \"code_input\", \"code_output_schema_json\", \"code\", \"code_input.data.canonical_model_json\", \"code_input.schema\", \"code_input.data.variant_id\", \"code_input.data.customer_name\", \"code_input.data.variant_name\", \"code_input.data\", \"payload_asset_type\", \"code_input.data.protection_password\"], \"comment\": \"Build template\", \"uuid\": \"cc1c1f1a-c565-4af8-b335-658e4951be4b\", \"title\": null, \"description\": \"Execute <span class=\\\"provider\\\">Python</span> code: <span class=\\\"provider\\\">Slice and build</span>\"}, {\"number\": 3, \"as\": \"558ff0b9\", \"keyword\": \"catch\", \"input\": {\"max_retry_count\": \"0\", \"retry_interval\": \"2\"}, \"block\": [], \"uuid\": \"680c639c-c283-4f22-9efd-5c83592d5df9\"}], \"uuid\": \"ddda345d-e219-46b8-9bde-721db910c7dc\"}, {\"number\": 4, \"provider\": \"workato_recipe_function\", \"name\": \"return_result\", \"as\": \"723a2db2\", \"keyword\": \"action\", \"input\": {\"result\": {\"status\": \"=_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"py_eval\\\",\\\"line\\\":\\\"07c380e4\\\",\\\"path\\\":[\\\"output\\\",\\\"status\\\"]}').present? ? _dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"py_eval\\\",\\\"line\\\":\\\"07c380e4\\\",\\\"path\\\":[\\\"output\\\",\\\"status\\\"]}') : \\\"error\\\"\", \"file_content\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"py_eval\\\",\\\"line\\\":\\\"07c380e4\\\",\\\"path\\\":[\\\"output\\\",\\\"file_content\\\"]}')}\", \"suggested_filename\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"py_eval\\\",\\\"line\\\":\\\"07c380e4\\\",\\\"path\\\":[\\\"output\\\",\\\"suggested_filename\\\"]}')}\", \"metadata\": {\"sheet_names\": \"=_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"py_eval\\\",\\\"line\\\":\\\"07c380e4\\\",\\\"path\\\":[\\\"output\\\",\\\"metadata\\\",\\\"sheet_names\\\"]}')\", \"byte_size\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"py_eval\\\",\\\"line\\\":\\\"07c380e4\\\",\\\"path\\\":[\\\"output\\\",\\\"metadata\\\",\\\"byte_size\\\"]}')}\", \"row_count\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"py_eval\\\",\\\"line\\\":\\\"07c380e4\\\",\\\"path\\\":[\\\"output\\\",\\\"metadata\\\",\\\"row_count\\\"]}')}\", \"field_count\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"py_eval\\\",\\\"line\\\":\\\"07c380e4\\\",\\\"path\\\":[\\\"output\\\",\\\"metadata\\\",\\\"field_count\\\"]}')}\"}, \"error\": {\"technical_failure\": {\"error_uuid\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"catch\\\",\\\"line\\\":\\\"558ff0b9\\\",\\\"path\\\":[\\\"uuid\\\"]}')}\", \"error_message\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"catch\\\",\\\"line\\\":\\\"558ff0b9\\\",\\\"path\\\":[\\\"message\\\"]}')}\", \"error_type\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"catch\\\",\\\"line\\\":\\\"558ff0b9\\\",\\\"path\\\":[\\\"type\\\"]}')}\"}, \"logical_failure\": {\"code\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"py_eval\\\",\\\"line\\\":\\\"07c380e4\\\",\\\"path\\\":[\\\"output\\\",\\\"error\\\",\\\"code\\\"]}')}\", \"message\": \"#{_dp('{\\\"pill_type\\\":\\\"output\\\",\\\"provider\\\":\\\"py_eval\\\",\\\"line\\\":\\\"07c380e4\\\",\\\"path\\\":[\\\"output\\\",\\\"error\\\",\\\"message\\\"]}')}\"}}}}, \"visible_config_fields\": [\"result.verdict.error.where\", \"result.verdict.error.what\", \"result.verdict.error.severity\", \"result.file_content\", \"result.suggested_filename\", \"result.metadata.sheet_names\", \"result.metadata.byte_size\", \"result.metadata.row_count\", \"result.metadata.field_count\", \"result\", \"result.status\", \"result.metadata\", \"result.error\", \"result.error.technical_failure.error_uuid\", \"result.error.technical_failure.error_message\", \"result.error.logical_failure.code\", \"result.error.logical_failure.message\", \"result.error.technical_failure\", \"result.error.technical_failure.error_type\", \"result.error.logical_failure\", \"result.debug_pw.debug_pw_repr\", \"result.debug_pw.debug_pw_hash\"], \"uuid\": \"4d6eed88-dbd9-40c5-81d5-69b42db5fe81\", \"title\": null, \"description\": null}], \"uuid\": \"281f90f8-8865-4d24-86bd-58ad044217f8\", \"title\": null, \"description\": null}",
      "version_no": 50,
      "version_author_name": "Emily Cabaniss",
      "version_author_email": "emily.cabaniss@randstadsourceright.com",
      "version_comment": null,
      "author_name": "Enterprise Professional Services",
      "last_job_started_at": "2026-08-18T12:47:02.172-07:00"
    };
  }

  /** The Python step's `as` alias inside tpl02(). */
  static get PY_AS() { return "07c380e4"; }
  /** The trigger's `as` alias inside tpl02(). */
  static get TRIGGER_AS() { return "ee00569c"; }
  /** The catch step's `as` alias inside tpl02(). */
  static get CATCH_AS() { return "558ff0b9"; }
}

// =======================================================================================
// LOCAL STUBS (hermetic tier)
// =======================================================================================
/** Deterministic, obviously-not-a-hash fingerprint: the tests only need "same code -> same value". */
function stubSha256_(str) { return `len${String(str).length}`; }

/**
 * Minimal pill extractor with the same contract as WorkatoGraphLib.extractPillRefs. Kept deliberately naive so the
 * integration tier can assert the library agrees with it on the fixture.
 */
function stubPillRefs_(value) {
  const refs = [], seen = new Set();
  const visit = (v) => {
    if (typeof v === "string") {
      const re = /_dp\('(.*?)'\)/g; let m;
      while ((m = re.exec(v)) !== null) {
        let ref; try { ref = JSON.parse(m[1]); } catch (e) { continue; }
        const norm = { pill_type: String(ref.pill_type || ""), provider: String(ref.provider || ""), line: String(ref.line || ""), path: (ref.path || []).map(String) };
        const sig = `${norm.provider}|${norm.line}|${norm.path.join(".")}`;
        if (!seen.has(sig)) { seen.add(sig); refs.push(norm); }
      }
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
  return refs;
}

/** Walks a fixture's code the way collectSteps does, without the library (hermetic tier only). */
function stubCollectSteps_(recipe) {
  const code = typeof recipe.code === "string" ? JSON.parse(recipe.code) : recipe.code;
  const out = [];
  const walk = (steps, prefix, stack) => {
    (steps || []).forEach((step, i) => {
      const p = prefix ? `${prefix}/${i}` : `${i}`;
      out.push({ step, step_path: p, branch_context: stack.join(" / ") });
      const kw = String(step.keyword || "").toLowerCase();
      const label = (kw && kw !== "action" && kw !== "trigger" && kw !== "if" && kw !== "elsif") ? kw.toUpperCase() : "";
      if (step.block) walk(step.block, p, label ? stack.concat([label]) : stack);
      if (step.else_block) walk(step.else_block, `${p}/else`, stack.concat(["ELSE"]));
      if (step.error_block) walk(step.error_block, `${p}/error`, stack.concat(["ON_ERROR"]));
    });
  };
  walk(code.block || [], "", []);
  return out;
}

class FakePyClient_ {
  constructor(recipe) { this.recipe = recipe; }
  get(endpoint) {
    if (endpoint === `recipes/${this.recipe.id}`) return this.recipe;
    throw new Error(`FakePyClient_: 404 for ${endpoint}`);
  }
  fetchPaginated(endpoint) { return endpoint === "recipes" ? [this.recipe] : []; }
}

// =======================================================================================
// TIER 1 — HERMETIC
// =======================================================================================
function runPythonStepUnitTests() {
  const t = new SimpleTestRunner();
  const deps = { sha256: stubSha256_, pillRefs: stubPillRefs_ };
  console.log("PYTHON STEP UNIT TESTS...");

  t.test("isPythonStep - provider gate", () => {
    t.assert(PythonStepAnalyzer.isPythonStep({ provider: "py_eval" }) === true, "py_eval is a Python step");
    t.assert(PythonStepAnalyzer.isPythonStep({ provider: "python" }) === false, "'python' is not the provider name");
    t.assert(PythonStepAnalyzer.isPythonStep(null) === false, "null is safe");
  });

  t.test("scanImports - root modules, unique, in order", () => {
    const recipe = PythonStepFixtures.tpl02();
    const py = stubCollectSteps_(recipe).find(l => PythonStepAnalyzer.isPythonStep(l.step)).step;
    const imports = PythonStepAnalyzer.scanImports(py.input.code);
    t.assert(JSON.stringify(imports) === JSON.stringify(["base64", "json", "io", "openpyxl", "re"]),
      `Expected [base64,json,io,openpyxl,re], got ${JSON.stringify(imports)}`);
  });

  t.test("scanDefs - top-level only; methods and nested defs excluded", () => {
    const recipe = PythonStepFixtures.tpl02();
    const py = stubCollectSteps_(recipe).find(l => PythonStepAnalyzer.isPythonStep(l.step)).step;
    const defs = PythonStepAnalyzer.scanDefs(py.input.code);
    t.assert(JSON.stringify(defs.functions) === JSON.stringify(["_is_truthy", "plan_fields", "main"]),
      `functions: ${JSON.stringify(defs.functions)}`);
    t.assert(JSON.stringify(defs.classes) === JSON.stringify(["BuildError"]), `classes: ${JSON.stringify(defs.classes)}`);
  });

  t.test("parseSchemaJson - tolerant", () => {
    t.assert(PythonStepAnalyzer.parseSchemaJson("not json").length === 0, "malformed -> []");
    t.assert(PythonStepAnalyzer.parseSchemaJson("").length === 0, "empty -> []");
    t.assert(PythonStepAnalyzer.parseSchemaJson('{"a":1}').length === 0, "object (not array) -> []");
    t.assert(PythonStepAnalyzer.parseSchemaJson([{ name: "x" }]).length === 1, "array passes through");
  });

  t.test("describe - schemas, mapping, upstream, consumers, function contract", () => {
    const recipe = PythonStepFixtures.tpl02();
    const all = stubCollectSteps_(recipe);
    const located = all.find(l => PythonStepAnalyzer.isPythonStep(l.step));
    const rec = PythonStepAnalyzer.describe(recipe, located, all, deps, { project: "SDC", folder: "Templates" });

    t.assert(rec.recipe_id === "2071421" && rec.recipe_name === "TPL-02 Build XLSX", "recipe identity");
    t.assert(rec.recipe_kind === "function", `kind should be function, got ${rec.recipe_kind}`);
    t.assert(rec.project === "SDC" && rec.folder === "Templates", "names pass through");
    t.assert(rec.step.as === PythonStepFixtures.PY_AS && rec.step.number === 2, "step alias + number");
    t.assert(rec.step.name === "Slice and build", `step name from input.name, got '${rec.step.name}'`);
    t.assert(rec.step.comment === "Build template", "step comment");
    t.assert(rec.step.step_path === "0/0" && rec.step.branch_context === "TRY", `location ${rec.step.step_path} / ${rec.step.branch_context}`);
    t.assert(rec.step.inline === true && rec.step.payload_asset_type === "inline", "inline payload");
    t.assert(rec.code_fp === stubSha256_(rec.code) && rec.line_count > 10, "fingerprint + line count");

    t.assert(JSON.stringify(rec.declared_inputs) === JSON.stringify(["canonical_model_json", "variant_id", "customer_name", "variant_name", "protection_password"]),
      `declared_inputs ${JSON.stringify(rec.declared_inputs)}`);
    t.assert(JSON.stringify(rec.declared_outputs) === JSON.stringify(["status", "file_content", "suggested_filename", "metadata", "error"]),
      `declared_outputs ${JSON.stringify(rec.declared_outputs)}`);
    t.assert(rec.input_schema.length === 5 && rec.output_schema.length === 5, "parsed schema arrays");
    t.assert(Object.keys(rec.input_mapping).length === 5, "raw mapping kept");

    t.assert(rec.upstream_refs.length === 5, `5 upstream refs, got ${rec.upstream_refs.length}`);
    t.assert(rec.upstream_refs.every(u => u.line === PythonStepFixtures.TRIGGER_AS && u.provider === "workato_recipe_function"), "all fed by the trigger");
    t.assert(rec.upstream_refs.every(u => u.step_name === "execute"), `trigger alias resolves to its name, got '${rec.upstream_refs[0].step_name}'`);

    t.assert(rec.consumers.length === 1, `one consumer (return_result), got ${rec.consumers.length}`);
    const c = rec.consumers[0];
    t.assert(c.number === 4 && c.name === "return_result", `consumer identity ${JSON.stringify(c)}`);
    const expectPaths = ["status", "file_content", "suggested_filename", "metadata.sheet_names", "metadata.byte_size",
      "metadata.row_count", "metadata.field_count", "error.code", "error.message"];
    t.assert(JSON.stringify(c.paths) === JSON.stringify(expectPaths), `consumed paths ${JSON.stringify(c.paths)}`);

    t.assert(rec.function_contract && rec.function_contract.parameters.length === 5 && rec.function_contract.result.length === 5,
      "function contract carried (5 params, 5 result fields)");
  });

  t.test("describe - evidence of the three-layer schema drift is visible in the record", () => {
    const recipe = PythonStepFixtures.tpl02();
    const all = stubCollectSteps_(recipe);
    const located = all.find(l => PythonStepAnalyzer.isPythonStep(l.step));
    const rec = PythonStepAnalyzer.describe(recipe, located, all, deps);
    const stepMeta = rec.output_schema.find(f => f.name === "metadata").properties.map(p => p.name);
    const fnMeta = rec.function_contract.result.find(f => f.name === "metadata").properties.map(p => p.name);
    t.assert(stepMeta.includes("locked_field_count") && !fnMeta.includes("locked_field_count"),
      "step schema declares locked_field_count; function result does not (drift the record must expose)");
    t.assert(/hidden_field_count/.test(rec.code) && !stepMeta.includes("hidden_field_count"),
      "code emits hidden_field_count; no schema declares it");
  });

  t.test("describe - non-inline payload is flagged, missing pieces degrade to empty", () => {
    const recipe = PythonStepFixtures.tpl02();
    const all = stubCollectSteps_(recipe);
    const located = all.find(l => PythonStepAnalyzer.isPythonStep(l.step));
    located.step.input.payload_asset_type = "file";
    delete located.step.input.code_output_schema_json;
    delete located.step.input.code_input;
    const rec = PythonStepAnalyzer.describe(recipe, located, all, deps);
    t.assert(rec.step.inline === false && rec.step.payload_asset_type === "file", "non-inline flagged");
    t.assert(rec.declared_inputs.length === 0 && rec.declared_outputs.length === 0 && rec.upstream_refs.length === 0, "absent schema/mapping -> empty");
  });

  t.test("DataMapper.mapPythonStepsToRows - width matches HEADERS and error-row positions hold", () => {
    const recipe = PythonStepFixtures.tpl02();
    const all = stubCollectSteps_(recipe);
    const located = all.find(l => PythonStepAnalyzer.isPythonStep(l.step));
    const rec = PythonStepAnalyzer.describe(recipe, located, all, deps, { project: "SDC", folder: "Templates" });
    rec.drive_url = "https://drive.example/x";
    const header = SchemaDef.HEADERS.PYTHON_STEPS;
    const rows = DataMapper.mapPythonStepsToRows([rec], "2026-09-10T00:00:00.000Z");
    t.assert(rows.length === 1 && rows[0].length === header.length, `row width ${rows[0].length} vs header ${header.length}`);
    t.assert(header[10] === "Step Name" && header[11] === "Comment", "error rows write into Step Name / Comment (10, 11)");
    t.assert(rows[0][0] === "2071421" && rows[0][2] === "function" && rows[0][5] === "ACTIVE", "identity columns");
    t.assert(rows[0][9] === PythonStepFixtures.PY_AS && rows[0][10] === "Slice and build", "alias + name");
    t.assert(rows[0][14] === "base64, json, io, openpyxl, re", `imports column '${rows[0][14]}'`);
    t.assert(rows[0][19] === "workato_recipe_function:execute", `upstream column '${rows[0][19]}'`);
    t.assert(rows[0][20] === "4:return_result", `consumers column '${rows[0][20]}'`);
    t.assert(rows[0][22].startsWith('=HYPERLINK('), "drive link formula");
    t.assert(rows[0][23] === "2026-09-10T00:00:00.000Z", "timestamp");
  });

  t.finish();
  return t;
}

// =======================================================================================
// TIER 2 — INTEGRATION (WorkatoGraphLib >= 1.1.0)
// =======================================================================================
function runPythonStepIntegrationTests() {
  const t = new SimpleTestRunner();
  console.log("PYTHON STEP INTEGRATION TESTS...");

  if (typeof WorkatoGraphLib === "undefined") {
    console.log("SKIP: WorkatoGraphLib not bound.");
    t.finish(); return t;
  }
  const recipe = PythonStepFixtures.tpl02();
  const service = new RecipeAnalyzerService(new FakePyClient_(recipe));
  if (typeof service.collectSteps !== "function" || typeof service.engine.collectSteps !== "function") {
    console.log("SKIP: bound WorkatoGraphLib predates collectSteps (needs >= 1.1.0).");
    t.finish(); return t;
  }

  t.test("collectSteps - every step, paths and branch context", () => {
    const all = service.collectSteps(recipe.id);
    const summary = all.map(l => `${l.step_path}:${l.step.keyword}:${l.branch_context}`);
    t.assert(JSON.stringify(summary) === JSON.stringify(["0:try:", "0/0:action:TRY", "0/1:catch:TRY", "1:action:"]),
      `walk summary ${JSON.stringify(summary)}`);
    t.assert(all[1].depth === 1 && all[3].depth === 0, "depth");
  });

  t.test("collectSteps - predicate filter + agrees with the hermetic walker", () => {
    const py = service.collectSteps(recipe.id, s => PythonStepAnalyzer.isPythonStep(s));
    t.assert(py.length === 1 && py[0].step.as === PythonStepFixtures.PY_AS, "one Python step");
    const mine = stubCollectSteps_(recipe).map(l => `${l.step_path}|${l.branch_context}`);
    const libs = service.collectSteps(recipe.id).map(l => `${l.step_path}|${l.branch_context}`);
    t.assert(JSON.stringify(mine) === JSON.stringify(libs), "library walk == stub walk on the fixture");
  });

  t.test("extractPillRefs - template and formula forms, dedup, both producers", () => {
    const all = service.collectSteps(recipe.id);
    const ret = all.find(l => l.step.name === "return_result").step;
    const refs = service.extractPillRefs(ret.input);
    const byLine = {};
    refs.forEach(r => { byLine[r.line] = (byLine[r.line] || 0) + 1; });
    t.assert(byLine[PythonStepFixtures.PY_AS] === 9, `9 refs to the Python step (formula-form status included), got ${byLine[PythonStepFixtures.PY_AS]}`);
    t.assert(byLine[PythonStepFixtures.CATCH_AS] === 3, `3 refs to the catch step, got ${byLine[PythonStepFixtures.CATCH_AS]}`);
    t.assert(refs.length === 12, `12 unique refs, got ${refs.length}`);
    const stub = stubPillRefs_(ret.input);
    t.assert(JSON.stringify(stub) === JSON.stringify(refs), "library extractor == stub extractor on the fixture");
  });

  t.test("describe with the real extractor - identical to hermetic result", () => {
    const all = service.collectSteps(recipe.id);
    const located = all.find(l => PythonStepAnalyzer.isPythonStep(l.step));
    const realDeps = { sha256: stubSha256_, pillRefs: v => service.extractPillRefs(v) };
    const a = PythonStepAnalyzer.describe(recipe, located, all, realDeps);
    const b = PythonStepAnalyzer.describe(recipe, stubCollectSteps_(recipe).find(l => PythonStepAnalyzer.isPythonStep(l.step)), stubCollectSteps_(recipe), { sha256: stubSha256_, pillRefs: stubPillRefs_ });
    t.assert(JSON.stringify(a) === JSON.stringify(b), "records identical");
  });

  t.finish();
  return t;
}

/** Both tiers. */
function runPythonStepTests() {
  const u = runPythonStepUnitTests();
  const i = runPythonStepIntegrationTests();
  const failed = u.failed + i.failed;
  console.log(`PYTHON STEP TESTS: ${u.passed + i.passed} passed, ${failed} failed.`);
  return failed === 0;
}
