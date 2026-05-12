# SDC Data Collection — PRV-02 Output Schema (v1, Stage 3)

## Status

Small companion to `sdc-prv-02-construction-spec-v1.md` and `sdc-prv-02-step-inventory-v1.md`. Settles the callable-output schema PRV-02 returns to its caller across all four termination paths.

The recipe plan named three output fields: `template_version_id`, `canonical_model_path`, `validation_summary`. That's the success path only. The full schema needs to accommodate all four paths uniformly because Workato callable outputs are defined once at the recipe level — every return populates the same shape, with path-specific fields nulled where they don't apply.

---

## Who consumes this output?

A practical question that shapes the design.

PRV-01 invokes PRV-02 **asynchronously** and returns its own acknowledgment to GAS immediately. PRV-01 does not consume PRV-02's output. So the schema is not optimized for production downstream consumption — it's optimized for:

- **Test harnesses** asserting on outcomes
- **Synchronous diagnostic invocations** (re-running PRV-02 directly for debugging)
- **Operator inspection** when a job appears in Workato's job history

These audiences care about discriminability ("did this succeed and why?") and traceability ("what state did the system end up in?"). The schema leans toward verbose and self-describing rather than minimal.

---

## The four termination paths

| # | Path | Where it terminates | Status value |
|---|---|---|---|
| 1 | Parser rejected the config | Step 3.2 | `failed` |
| 2 | CFG-01 returned invalid | Step 6.1 | `rejected` |
| 3 | Infrastructure or invariant failure | Monitor block A, B, C, or D | `failed` |
| 4 | Full success | Step 16 | `success` |

`rejected` and `failed` are deliberately separate top-level values. **Decision: `rejected` means "the analyst's configuration was invalid"; `failed` means "the system couldn't complete its work."** A caller (or an operator scanning job history) sees `rejected` and knows the next step is "talk to the analyst about their workbook"; sees `failed` and knows the next step is "investigate why the system broke."

Path 1 (parser failure) routes to `failed` rather than `rejected` because a parser error usually indicates a malformed export, not a configuration mistake. The boundary is fuzzy — a workbook with a missing required sheet could be called either — but `failed` is the safer default because the parser doesn't surface the same kind of diagnostic the analyst can act on directly.

---

## Schema

```
{
  status: "success" | "rejected" | "failed",
  
  // Always populated — echoed from trigger inputs
  project_id: string (UUID),
  correlation_id: string | null,
  is_initial: boolean,
  
  started_at: datetime (ISO 8601),
  ended_at:   datetime (ISO 8601),
  
  // Populated when the parser produced structured output
  // (success, rejected, and most failed paths after Step 2)
  parse_summary: {
    field_count:             integer,
    visible_field_count:     integer,
    rule_count:              integer,
    lookup_count:            integer,
    variant_count:           integer,
    supplier_count:          integer,
    user_count:              integer,
    error_translation_count: integer,
    variants_synthesized:    boolean
  } | null,
  
  // Populated when validate_config ran
  // (success and rejected paths; absent on parser-failed and on
  //  failures occurring after validation itself)
  validation_summary: {
    status:        "valid" | "invalid",
    error_count:   integer,
    warning_count: integer,
    checks:        array of check objects   // full validate_config detail
  } | null,
  
  // Populated when the version row was created
  // (success path; absent on rejected and on failures before Step 8)
  template_version_id: string (UUID) | null,
  version_number:      integer        | null,
  
  // Populated when the corresponding file was written
  // (success path; partial population possible on failures
  //  in monitor block C between writes)
  parsed_config_path:    string | null,
  canonical_model_path:  string | null,
  
  // Populated only on failed
  failure: {
    error_type:     string,    // one of the taxonomy values
    human_message:  string,
    failed_at_step: integer,   // the step number from the inventory
    details_json:   object     // step-specific structured details
  } | null
}
```

---

## What each path populates

A field-by-field matrix. `✓` = always populated on this path; `~` = sometimes populated (depends on where exactly the failure occurred); `—` = always null.

| Field | success | rejected | parser-failed | monitor-failed |
|---|:-:|:-:|:-:|:-:|
| `status` | ✓ | ✓ | ✓ | ✓ |
| `project_id`, `correlation_id`, `is_initial` | ✓ | ✓ | ✓ | ✓ |
| `started_at`, `ended_at` | ✓ | ✓ | ✓ | ✓ |
| `parse_summary` | ✓ | ✓ | — | ~ |
| `validation_summary` | ✓ | ✓ | — | ~ |
| `template_version_id` | ✓ | — | — | ~ |
| `version_number` | ✓ | — | — | ~ |
| `parsed_config_path` | ✓ | — | — | ~ |
| `canonical_model_path` | ✓ | — | — | ~ |
| `failure` | — | — | ✓ | ✓ |

**On monitor-failed `~` fields:** the four monitor blocks catch at different points in the recipe. Block A catches before parsing, so it produces a near-empty payload. Block C catches after the version row exists and possibly after one or both file writes, so `template_version_id` and `parsed_config_path` are populated but `canonical_model_path` may be null. The schema accommodates partial state; the `failure.failed_at_step` discriminator tells the caller which fields to trust.

**On `validation_summary.checks`:** the field carries the full CFG-01 check list, including passing ones. **Lean toward**: include even on success path despite verbosity. The warnings (which can fire even on a `valid` verdict) are the primary diagnostic surface, and stripping the passing checks to compact the output would force callers to re-derive what CFG-01 already knows. If the verbosity ever becomes a problem (e.g., a workbook with 200 rules produces a multi-kilobyte success payload), revisit.

---

## Example payloads

### Success

```json
{
  "status": "success",
  "project_id": "a3f9c812-...",
  "correlation_id": "gas-2026-05-11-1437-acme",
  "is_initial": true,
  "started_at": "2026-05-11T14:37:02Z",
  "ended_at":   "2026-05-11T14:37:18Z",
  "parse_summary": {
    "field_count": 47, "visible_field_count": 18, "rule_count": 12,
    "lookup_count": 134, "variant_count": 3, "supplier_count": 22,
    "user_count": 28, "error_translation_count": 20,
    "variants_synthesized": false
  },
  "validation_summary": {
    "status": "valid", "error_count": 0, "warning_count": 1,
    "checks": [ /* ... full check list including the one warning ... */ ]
  },
  "template_version_id": "8b2e4f01-...",
  "version_number": 1,
  "parsed_config_path":   "/templates/v001/parsed_config.json",
  "canonical_model_path": "/templates/v001/canonical_model.json",
  "failure": null
}
```

### Rejected (CFG-01 invalid)

```json
{
  "status": "rejected",
  "project_id": "a3f9c812-...",
  "correlation_id": "gas-2026-05-11-1437-acme",
  "is_initial": true,
  "started_at": "2026-05-11T14:37:02Z",
  "ended_at":   "2026-05-11T14:37:05Z",
  "parse_summary": { /* ... */ },
  "validation_summary": {
    "status": "invalid", "error_count": 2, "warning_count": 0,
    "checks": [ /* ... including the 2 failing checks ... */ ]
  },
  "template_version_id": null,
  "version_number": null,
  "parsed_config_path": null,
  "canonical_model_path": null,
  "failure": null
}
```

### Parser-failed

```json
{
  "status": "failed",
  "project_id": "a3f9c812-...",
  "correlation_id": "gas-2026-05-11-1437-acme",
  "is_initial": true,
  "started_at": "2026-05-11T14:37:02Z",
  "ended_at":   "2026-05-11T14:37:03Z",
  "parse_summary": null,
  "validation_summary": null,
  "template_version_id": null,
  "version_number": null,
  "parsed_config_path": null,
  "canonical_model_path": null,
  "failure": {
    "error_type": "config_unparseable",
    "human_message": "Parser rejected configuration: Required sheet '1_customer' not found",
    "failed_at_step": 2,
    "details_json": { "sheet": "1_customer", "row": null }
  }
}
```

### Monitor-failed mid-build (Block C catches after parsed_config_path written, before canonical_model written)

```json
{
  "status": "failed",
  "project_id": "a3f9c812-...",
  "correlation_id": "gas-2026-05-11-1437-acme",
  "is_initial": false,
  "started_at": "2026-05-11T14:37:02Z",
  "ended_at":   "2026-05-11T14:37:14Z",
  "parse_summary": { /* ... */ },
  "validation_summary": { "status": "valid", "error_count": 0, /* ... */ },
  "template_version_id": "9c7d3a22-...",
  "version_number": 4,
  "parsed_config_path":   "/templates/v004/parsed_config.json",
  "canonical_model_path": null,
  "failure": {
    "error_type": "recipe_invariant",
    "human_message": "Canonical model self-check failed: cfg_rules[3].field_id does not resolve",
    "failed_at_step": 13,
    "details_json": {
      "self_check": "field_id_references_resolve",
      "rule_id": "d8a1...", "unresolved_field_id": "ff77..."
    }
  }
}
```

This last payload is the most informative case the schema is designed for: an operator sees `version_number: 4` with `parsed_config_path` populated but `canonical_model_path: null`, and immediately understands the cleanup path — a draft v4 row exists with a parsed-config file but no canonical model. They can either retry PRV-02 (idempotency permitting) or manually clean up the orphan.

---

## Workato output-schema construction

In Workato, the callable's output schema is defined declaratively. All fields above are declared at the top level; nested objects (`parse_summary`, `validation_summary`, `failure`) are object-typed pills.

**Decision: every field below `status` is declared optional.** Workato's pill model handles null gracefully but does not enforce required/optional at runtime; declaring optional everywhere matches the actual nullability pattern in the matrix above.

**Decision: don't use Workato's "result pill picker" to define output structure step-by-step.** Define the schema once at the recipe level (the callable's output configuration) and have each termination step populate it. Otherwise the schema fragments across return statements and drifts.

A small helper Python step before each return constructs the output object cleanly:

```
def build_output(status, **kwargs):
    return {
        "status": status,
        "project_id": kwargs.get("project_id"),
        "correlation_id": kwargs.get("correlation_id"),
        "is_initial": kwargs.get("is_initial"),
        "started_at": kwargs.get("started_at"),
        "ended_at": now_utc_iso(),
        "parse_summary": kwargs.get("parse_summary"),
        "validation_summary": kwargs.get("validation_summary"),
        "template_version_id": kwargs.get("template_version_id"),
        "version_number": kwargs.get("version_number"),
        "parsed_config_path": kwargs.get("parsed_config_path"),
        "canonical_model_path": kwargs.get("canonical_model_path"),
        "failure": kwargs.get("failure"),
    }
```

Each return path calls this with the fields it knows about; everything else is null. The Workato return step then maps the single object pill to the recipe's output. This avoids the "did I remember to null out X on the failure path" bookkeeping that scattered returns invite.

**Lean toward** placing the helper as a function in the canonical-model Python step (Step 13) and exposing it as a pill-returning function the return paths invoke. **Alternative**: a dedicated Python step right before each return. Lean is the former — fewer steps on the canvas, but it requires Step 13's Python step to be in scope at return time, which Workato may or may not support cleanly. Confirm during build.

---

## Open questions

1. **`validation_summary.checks` verbosity.** Including the full check list on success path is verbose. Worth confirming the payload size is acceptable for the rare large-config case (200+ rules). Defer; revisit if it becomes a problem.

2. **`started_at` source.** Workato exposes job-level timestamps, but the recipe-level "started at" needs to be captured at Step 0 (trigger time) for the schema. **Lean toward**: an explicit ✦ variable assignment immediately after Step 0 capturing `now_utc_iso()`, threaded into the build_output helper. Add as Step 0.5 in the inventory at build time.

3. **`ended_at` on monitor-caught paths.** Monitor blocks emit `recipe_failed` and stop the recipe. The build needs to ensure the monitor block's emit-and-stop path also constructs and returns the output object (not just stops). Workato monitor blocks support this but the exact configuration varies. Confirm during build.

4. **Distinguishing `rejected` vs. `failed` for an empty workbook.** A workbook with the customer sheet present but no fields produces a parser success (no error) and a CFG-01 failure (`required_fields_present` check fails). This routes to `rejected`. Compare with a workbook missing the customer sheet entirely, which routes to `failed` via the parser. The semantic boundary holds — the empty-fields case is a configuration mistake the analyst can fix — but worth flagging that "the workbook is malformed in different ways" produces different top-level statuses. Acceptable; documented for operator awareness.

---

## What this locks down vs. defers

| Locked | Deferred |
|---|---|
| The three-value `status` enum | `validation_summary.checks` verbosity if it becomes a problem |
| Full field list and nullability matrix | Workato helper-function scope mechanics |
| The four termination paths and their populated fields | Whether to add a `recipe_version` field for schema versioning |
| Use of a `build_output` helper for uniform shape | Whether `failure.details_json` should be a string or a structured object — currently structured, Workato pill model may force string |

The schema is now suitable for build. Test cases in the step inventory (Section "Test plan — step-level") assert against this shape; each test's expected payload follows one of the four example structures above.