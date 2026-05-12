# SDC Data Collection — PRV-02 Step Inventory (v1, Stage 3)

## Status

Companion to `sdc-prv-02-construction-spec-v1.md`. The construction spec describes *what each substage does and why*. This inventory lists *the concrete recipe steps that implement it*, in order, with their inputs, outputs, and error paths.

The build is largely mechanical from this list: each row corresponds to one step on the Workato canvas. Variable names use snake_case and match the naming the canonical-model build expects (matching the construction spec where possible).

This document is **at the recipe-step level, not the Workato-configuration level**. Step types are named by function ("Data Tables create", "FileStorage write", "Python step") rather than by exact connector action name, because some of those names depend on the connector version installed and Workato's pill picker.

---

## Step type legend

| Symbol | Type | Notes |
|---|---|---|
| ▶ | Callable trigger | The recipe's entry point |
| ◆ | Action (connector or built-in) | Single connector action, Data Tables op, FileStorage op |
| ƒ | Python step | Inline computation |
| ⇢ | Callable invocation | Synchronous or asynchronous call to another recipe |
| ⊕ | OBS-01 emit | A specific kind of callable invocation, frequent enough to mark separately |
| ⋔ | IF / conditional branch | Recipe-level branching |
| ✦ | Variable | Stored intermediate value |
| ⨯ | Stop | Early-return path |
| ⚠ | Monitor block | Wraps a step with error handling |

Step numbers are flat across the recipe, not nested under substages. Sub-steps inside conditional branches use a dot suffix (`7.1`, `7.2`).

---

## Master step list

| # | Type | Step | Substage |
|---|---|---|---|
| 0 | ▶ | Callable trigger from PRV-01 | — |
| 1 | ◆ | FileStorage read: parsed config JSON | 1 |
| 2 | ◆ | Connector: `parse_config_file` | 1 |
| 3 | ⋔ | Branch on parser status | 1 |
| 3.1 | ⊕ | Emit `recipe_failed` (config_unparseable) | 1 |
| 3.2 | ⨯ | Stop recipe | 1 |
| 4 | ⊕ | Emit `config_parsed` | 2 |
| 5 | ⇢ | Call CFG-01 | 3 |
| 6 | ⋔ | Branch on CFG-01 verdict | 4 |
| 6.1 | ⨯ | Stop recipe (no emit) | 4 |
| 7 | ⋔ | Branch on `is_initial` | 5 |
| 7.1 | ✦ | Set `new_version_number = 1` | 5 (E1) |
| 7.2 | ◆ | Data Tables search: prior versions | 5 (E2) |
| 7.3 | ƒ | Compute `new_version_number` | 5 (E2) |
| 8 | ◆ | Data Tables create: CFG_TemplateVersion (draft) | 5 |
| 9 | ✦ | Capture `template_version_id` | 5 |
| 10 | ✦ | Compute `version_path_segment` | 5 |
| 11 | ◆ | FileStorage write: parsed_config.json | 5 |
| 12 | ◆ | Data Tables update: parsed_config_path | 5 |
| 13 | ƒ | Python step: build canonical model | 6 |
| 14 | ◆ | FileStorage write: canonical_model.json | 7 |
| 15 | ◆ | Data Tables update: canonical_model_path | 7 |
| 16 | ⇢ | Fire PRV-03 (async) | 8 |

Plus three monitor blocks wrapping risky step groups — see "Error handling" below.

---

## Per-step detail

### Step 0 — Callable trigger

**Type:** ▶ Callable trigger.

**Input schema:**
- `project_id` (string, UUID, required)
- `parsed_config_path` (string, required) — FileStorage path written by PRV-01
- `is_initial` (boolean, required)
- `correlation_id` (string, optional)

**Output:** None (callable returns when recipe completes). For synchronous test paths, the recipe may return `{template_version_id, canonical_model_path, validation_summary}` per the construction spec; in production the caller fires asynchronously and doesn't consume the return.

---

### Substage 1 — Parse config via connector

#### Step 1 — FileStorage read

**Type:** ◆ FileStorage read.

**Path:** `trigger.parsed_config_path`.

**Output captured as:** `parsed_config_raw_content` (the file's JSON content as a string).

**Failure:** Wrapped in monitor block A (see Error handling). FileStorage 404 → `recipe_failed` with `error_type=external_action_failed`.

#### Step 2 — Connector: `parse_config_file`

**Type:** ◆ Action (SDC Platform Connector).

**Action:** `parse_config_file`.

**Inputs:**
- `sheet_data` ← `parsed_config_raw_content` (string)
- `sheet_config` — omit; the connector's defaults are correct for the standard workbook template

**Output captured as:** the structured response. Critical fields for downstream:
- `status` — `"success"` or `"error"`
- `error` — populated on failure
- `parsed_config_json` — serialized JSON of the parsed configuration (the canonical handoff form)
- `parse_summary` — counts; used in Step 4's emit

**Note on shape**: the connector returns `parsed_config_json` even on success-with-warnings. PRV-02 captures it regardless and treats it as authoritative.

#### Step 3 — Branch on parser status

**Type:** ⋔ Conditional.

**Condition:** `step_2.status == "error"`.

**True branch:**

##### Step 3.1 — Emit `recipe_failed` (config_unparseable)

**Type:** ⊕ OBS-01 invocation.

**Payload:**
- `source_recipe`: `"PRV-02"`
- `step_number`: 2
- `phase`: `"recipe_failed"`
- `severity`: `"error"`
- `error_type`: `"config_unparseable"`
- `human_message`: `"Parser rejected configuration: {step_2.error.message}"`
- `details_json`: `{ sheet: step_2.error.sheet, row: step_2.error.row, project_id: trigger.project_id }`

##### Step 3.2 — Stop

**Type:** ⨯ Early return.

Return `{status: "failed", reason: "config_unparseable"}` to the synchronous caller. The recipe ends here; nothing downstream runs.

**False branch:** Fall through to Step 4.

---

### Substage 2 — Emit `config_parsed`

#### Step 4 — Emit `config_parsed`

**Type:** ⊕ OBS-01 invocation.

**Payload:**
- `source_recipe`: `"PRV-02"`
- `step_number`: 2 (the lifecycle moment is "parser produced structured output")
- `phase`: `"config_parsed"`
- `severity`: `"info"`
- `error_type`: null (the phase taxonomy forbids `error_type` on success phases)
- `human_message`: `"Configuration parsed: {field_count} fields, {variant_count} variants, {supplier_count} suppliers"`
- `details_json`: the full `parse_summary` object from Step 2, plus `project_id: trigger.project_id`

`template_version_id` is **deliberately not in the payload** — it doesn't yet exist. See construction spec Substage 2 for the rationale.

---

### Substage 3 — Call CFG-01

#### Step 5 — Call CFG-01

**Type:** ⇢ Callable invocation (synchronous).

**Target:** CFG-01 (whichever recipe wraps `validate_config`).

**Inputs:**
- `parsed_config_json` ← `step_2.parsed_config_json`

**Output captured as:** `cfg01_verdict` with fields `{status, error_count, warning_count, checks}`.

**Failure:** If CFG-01 itself crashes (not an `invalid` verdict but an actual recipe failure), wrapped in monitor block B → `recipe_failed` with `error_type=external_action_failed`.

---

### Substage 4 — Branch on verdict

#### Step 6 — Branch on CFG-01 verdict

**Type:** ⋔ Conditional.

**Condition:** `cfg01_verdict.status != "valid"`.

**True branch:**

##### Step 6.1 — Stop (no emit)

**Type:** ⨯ Early return.

CFG-01 has already emitted `config_rejected`. PRV-02 does not duplicate the emit. Return `{status: "rejected", validation_summary: cfg01_verdict}` to the synchronous caller.

**False branch:** Fall through to Step 7.

---

### Substage 5 — Create or update TemplateVersion

#### Step 7 — Branch on `is_initial`

**Type:** ⋔ Conditional.

**Condition:** `trigger.is_initial == true`.

**True branch (E1):**

##### Step 7.1 — Set `new_version_number = 1`

**Type:** ✦ Variable assignment.

`new_version_number = 1`.

**False branch (E2):**

##### Step 7.2 — Data Tables search: prior versions

**Type:** ◆ Data Tables search.

**Table:** `CFG_TemplateVersion`.

**Filter:** `project_id == trigger.project_id`.

**Sort:** `version_number` descending.

**Limit:** 1.

**Output captured as:** `prior_version_row` (may be empty if E2 was fired against a project with no published versions — a `recipe_invariant` condition; see below).

##### Step 7.3 — Compute `new_version_number`

**Type:** ƒ Python step.

**Logic:**
```
if not prior_version_row:
  raise InvariantError("E2 invoked but no prior version exists for project")
new_version_number = prior_version_row.version_number + 1
```

The invariant violation here is the case where `is_initial=false` but the project has no prior versions — PRV-01 should have caught this, but defense-in-depth. Routes to monitor block B as `recipe_invariant`.

#### Step 8 — Data Tables create: CFG_TemplateVersion

**Type:** ◆ Data Tables create.

**Table:** `CFG_TemplateVersion`.

**Fields:**
- `project_id` ← `trigger.project_id`
- `version_number` ← `new_version_number`
- `status` ← `"draft"`
- `master_template_path` ← null (set later, if at all — PRV-04 may write this)
- `parsed_config_path` ← null (set in Step 12)
- `canonical_model_path` ← null (set in Step 15)

**Output captured as:** the new row, particularly its primary key.

**Failure:** Wrapped in monitor block B → `recipe_failed` with `error_type=external_action_failed`.

#### Step 9 — Capture `template_version_id`

**Type:** ✦ Variable assignment.

`template_version_id = step_8.template_version_id`.

This is referenced by Steps 11, 12, 13, 14, 15, 16. Naming it explicitly avoids repeated pill drilling.

#### Step 10 — Compute `version_path_segment`

**Type:** ✦ Variable assignment (or small ƒ Python step if pill formula is awkward).

**Logic:** `version_path_segment = "v" + str(new_version_number).zfill(3)`.

Three-digit zero-pad per the construction spec's lean. v1 → `v001`; v10 → `v010`; v100 → `v100`.

#### Step 11 — FileStorage write: parsed_config.json

**Type:** ◆ FileStorage write.

**Path:** `"/templates/" + version_path_segment + "/parsed_config.json"`.

**Content:** `step_2.parsed_config_json`.

**Options:** `overwrite: false`.

**Output captured as:** the resolved path (for the next step's update).

**Failure:** Monitor block C → `recipe_failed` with `error_type=external_action_failed`.

#### Step 12 — Data Tables update: parsed_config_path

**Type:** ◆ Data Tables update.

**Table:** `CFG_TemplateVersion`.

**Where:** `template_version_id == step_9.template_version_id`.

**Set:** `parsed_config_path = step_11.path`.

**Failure:** Monitor block C.

---

### Substage 6 — Build canonical model

#### Step 13 — Python step: build canonical model

**Type:** ƒ Python step.

**Inputs (pills):**
- `parsed_config_json_str` ← `step_2.parsed_config_json`
- `template_version_id` ← `step_9.template_version_id`
- `version_number` ← `new_version_number`
- `project_id` ← `trigger.project_id`

**Logic:** Implements the algorithm described in construction spec Substage 6. The Python step is self-contained — it does not call back into Workato. The five cross-collection self-checks run inside this step and raise on violation.

**Output:** `canonical_model_json` — a single JSON string suitable for FileStorage write.

**Failure surfaces:**
- Self-check raises → `recipe_invariant` (algorithm produced an inconsistent canonical model — typically a bug)
- Slot pool overflow (type-specific) → `recipe_invariant` (until CFG-01 extends to catch this)
- JSON parsing of the input fails → `unexpected_error`
- Any other Python exception → `unexpected_error`

The Python step's exception message should include enough context (which check failed, which entity, which UUID/name) for diagnostic emits. Monitor block C catches and routes.

---

### Substage 7 — Write canonical model to FileStorage

#### Step 14 — FileStorage write: canonical_model.json

**Type:** ◆ FileStorage write.

**Path:** `"/templates/" + version_path_segment + "/canonical_model.json"`.

**Content:** `step_13.canonical_model_json`.

**Options:** `overwrite: false`.

**Output captured as:** the resolved path.

**Failure:** Monitor block C → `recipe_failed` with `error_type=external_action_failed`.

#### Step 15 — Data Tables update: canonical_model_path

**Type:** ◆ Data Tables update.

**Table:** `CFG_TemplateVersion`.

**Where:** `template_version_id == step_9.template_version_id`.

**Set:** `canonical_model_path = step_14.path`.

**Failure:** Monitor block C.

---

### Substage 8 — Fire PRV-03

#### Step 16 — Fire PRV-03

**Type:** ⇢ Callable invocation (asynchronous — fire-and-forget).

**Target:** PRV-03 (Hydrate CFG Tables).

**Inputs:**
- `template_version_id` ← `step_9.template_version_id`
- `canonical_model_path` ← `step_14.path`

**Failure:** Monitor block D → `recipe_failed` with `error_type=external_action_failed`. Note that "PRV-03 failed" is *not* a PRV-02 failure — only "couldn't dispatch the call" is. Once PRV-03 receives the trigger, its failure is its own concern.

The recipe ends after Step 16. Return value (for synchronous test paths) is `{template_version_id, canonical_model_path, validation_summary: cfg01_verdict}`.

---

## Error handling — monitor blocks

Workato monitor blocks wrap step groups and provide a single error path for the group. The recipe needs four:

| Block | Wraps | Error type on failure | Notes |
|---|---|---|---|
| A | Step 1 | `external_action_failed` | FileStorage read of parsed_config_path. Failure means PRV-01 wrote a bad path or FileStorage is unavailable. |
| B | Steps 5, 7.2, 7.3, 8 | varies | CFG-01 call, version-number computation, and the version row create. Errors include `external_action_failed` (CFG-01 crash, Data Tables errors) and `recipe_invariant` (E2 with no prior version). |
| C | Steps 11, 12, 13, 14, 15 | varies | The file/data writes plus the Python algorithm. Errors include `external_action_failed` (FileStorage or Data Tables) and `recipe_invariant`/`unexpected_error` (Python step). The error_type depends on the inner failure; the monitor catches it and forwards. |
| D | Step 16 | `external_action_failed` | Async dispatch only. PRV-03's own failures are not in scope. |

Each monitor block, on catching, performs:

1. ⊕ Emit `recipe_failed` with the appropriate `error_type`, the inner failure's `human_message`, and `details_json` carrying `{template_version_id (if known), step_number, project_id, original_error}`.
2. ⨯ Stop recipe.

**Step 3.1's explicit emit** (parser status=error) sits *outside* monitor blocks because the parser returning status=error is a normal control flow, not an exception. The branch in Step 3 handles it directly.

**Note on Step 13's error type routing.** A monitor block catches all exceptions but typically can't distinguish `recipe_invariant` from `unexpected_error` without inspecting the exception. Two construction options:

- **Lean toward**: Step 13's Python step catches its own self-check failures and packages them as a structured output `{status: "invariant_violation", details: ...}`, returning that instead of raising. Step 13's success-path output is `{status: "ok", canonical_model_json: ...}`. A small Step 13.5 inspects the status and emits/stops accordingly. This way, `recipe_invariant` and `unexpected_error` are routed distinctly.
- **Alternative**: Let Python raise on self-check failures; the monitor block defaults `error_type` to `unexpected_error`. Sacrifices the `recipe_invariant` distinction for simplicity.

Lean is the structured-output path — the routing precision is worth the small extra step.

---

## Variables in scope by step

For build reference. "In scope" means a subsequent step can pill-reference it.

| Variable | Set at step | Used at steps |
|---|---|---|
| `parsed_config_raw_content` | 1 | 2 |
| `step_2.status`, `step_2.error`, `step_2.parsed_config_json`, `step_2.parse_summary` | 2 | 3, 4, 5, 13 |
| `cfg01_verdict` | 5 | 6 (and synchronous return value) |
| `new_version_number` | 7.1 / 7.3 | 8, 10, 13 |
| `prior_version_row` | 7.2 | 7.3 |
| `template_version_id` | 9 | 11, 12, 13, 14, 15, 16 |
| `version_path_segment` | 10 | 11, 14 |
| `step_11.path` | 11 | 12 |
| `step_14.path` | 14 | 15, 16 |

`step_13.canonical_model_json` is in scope at Step 14 but not used elsewhere.

---

## Test plan — step-level

Beyond the algorithm test cases in the construction spec, the step inventory itself warrants integration coverage:

1. **End-to-end E1 happy path.** Fire Step 0 with a clean parsed-config path. Verify Steps 1–16 all fire, Step 4 emits `config_parsed`, Step 16 dispatches PRV-03. Verify the new `CFG_TemplateVersion` row has both `parsed_config_path` and `canonical_model_path` populated.

2. **End-to-end E2 happy path.** Same as above but `is_initial=false` against a project with an existing v1. Verify Step 7.3 computes `new_version_number=2`, Step 8 creates a v2 draft, the v1 row is untouched.

3. **Parser failure routing.** Feed a parsed-config file that the parser will reject (e.g., missing customer sheet). Verify Steps 3.1 and 3.2 fire; no `config_parsed` emit; no version row created.

4. **CFG-01 invalid verdict.** Feed a parsed-config file that parses cleanly but fails CFG-01 (e.g., a field referencing a missing lookup). Verify Step 4 fires (`config_parsed` emitted), then Step 6.1 fires (stop, no emit). CFG-01 owns the `config_rejected` emit. No version row created.

5. **FileStorage write failure in Step 11.** Simulate FileStorage unavailability. Verify monitor block C catches, emits `recipe_failed` with `error_type=external_action_failed`, and the version row exists but with null `parsed_config_path`. This is the partial-failure case flagged in PRV-02's recipe-plan open questions.

6. **Python step self-check failure in Step 13.** Inject a parsed config that slips through CFG-01 but produces an algorithm-detectable inconsistency (hard to do naturally — possible via direct test injection). Verify Step 13.5 routes to `recipe_invariant`, not `unexpected_error`.

7. **PRV-03 dispatch failure in Step 16.** Simulate a Workato dispatch error. Verify monitor D catches; the version row is fully populated with paths, but PRV-03 never ran. Manual recovery: an operator re-fires PRV-03 against the version row.

8. **E2 with no prior version (invariant).** Fire with `is_initial=false` against a project where no `CFG_TemplateVersion` rows exist. Step 7.2 returns empty; Step 7.3's Python step raises; monitor B catches as `recipe_invariant`.

9. **Concurrent E1 invocations** (idempotency open question). Fire Step 0 twice for the same project with `is_initial=true`. Without an idempotency guard, two draft versions get created. Document the observed behavior; the fix is the open question in the construction spec.

---

## Open questions specific to step-level construction

1. **Step 13.5 explicit routing vs. monitor-block default.** Lean is for Step 13 to return structured status and Step 13.5 to route. The alternative — exception-only routing — drops the `recipe_invariant` / `unexpected_error` distinction. Confirm the lean during build.

2. **Step 7.2's empty-result handling in Workato.** The Data Tables search with limit 1 may return an empty list or a null value. Step 7.3's Python step needs to handle both. Worth a small construction check that Workato's pill model surfaces "no rows" consistently — historically there have been quirks here.

3. **Step 10's variable assignment vs. inline computation.** A formula pill (`"v" + lpad(new_version_number, 3, "0")`) might work without a separate Python step, depending on Workato's formula support for `lpad`. If it doesn't, a one-line Python step takes its place. Either way, the version path segment is computed once and reused; the inline-vs-step decision is build-time cosmetic.

4. **Variable naming for `step_N.field` references.** Workato's pill model uses datapill names that aren't always identical to the variable names here. Build resolves these to whatever the pill picker surfaces; this inventory's names are the intent, not the verbatim pill labels.

---

## Defers and locks

| Locked | Deferred |
|---|---|
| Step order and types | Pill names (build resolves) |
| Branch points (Steps 3, 6, 7) | Monitor block boundaries (lean confirmed at build) |
| Variable scopes and dependencies | Step 13.5 routing implementation |
| Failure → error_type mapping | Workato-specific formula vs. Python for Step 10 |
| Test plan structure | Idempotency guard mechanism |

This inventory takes the construction spec's substage-level decisions and pins them to concrete Workato steps. The build is a translation pass: each row above becomes one block on the canvas, configured with the connector/action/table that matches its row.