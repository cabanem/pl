# SDC Provisioning — Context for Humans

**Entry point:** `API-00` (synchronous API Platform endpoint, `API-TOKEN` header)
**Scope:** the call tree reachable from API-00 up to its `200` response.
**Out of scope:** issuing invitations. API-00 finishes by signalling `send_invitations.ready`; the caller then fires `R-1` separately. Anything past that boundary is not covered here.

---

## How to read this document

- Plain statements describe what the spec states directly (table access, recipe calls, response shapes, control flow).
- Anything marked **(inferred)** is my reading of the control flow or a recipe's name — plausible, but not stated in the spec and worth confirming against the recipe JSON.
- "Hard" failure = aborts the whole provision (API-00 gates out and returns a 4xx/5xx). "Soft" failure = contained; provisioning continues and the outcome is reported in the response body.

---

## The big picture in one paragraph

API-00 runs a fixed sequence of provisioning steps **in series, synchronously**, with an error gate after each one. Each step either succeeds and hands off to the next, or fails and short-circuits the whole call into an error response. Two things break that strict pattern: seed data (`INC-01`) is wrapped so its failure can't abort the provision, and observability (`OBS-01`) is fired async almost everywhere so it sits off to the side. Because the chain is synchronous, the caller waits for *everything* — which is why API-00 declares a `504` and returns a rich summary the analyst can read.

---

## Call chain

```
API-00  (sync API endpoint)
│
├─ [guard] validate payload ───────────────(fail)→ 400 + OBS-01
│
├─ PRV-01  read config · create dirs · write Project + CFG_TemplateVersion · invite analyst
│   ├─ Google Drive : download config file
│   ├─ FileStorage  : ensure_dir ×3 · store config
│   ├─ WFA          : invite_user (analyst)        [try/catch — SOFT]
│   └─ OBS-01 (async)
│   └────────────────────────────────────────(fail)→ 5xx + OBS-01
│
├─ PRV-02  parse config · validate · build canonical model
│   ├─ Connector : parse_config_file
│   ├─ CFG-01    validate config ──────────────→ validate_summary
│   │   └─ Connector : validate_config
│   ├─ CAN-01    build canonical model ─────────→ canonical_model_json
│   ├─ FileStorage : store parsed config · store canonical model
│   └────────────────────────(invalid config or parse/build fail)→ 5xx + OBS-01
│
├─ PRV-03  hydrate the 7 CFG_* tables  (batch writes)
│   └─ CFG_Field · CFG_Rule · CFG_Lookup · CFG_Variant · CFG_VariantField
│      · CFG_FormSlotMapping · CFG_ErrorMessage
│   └────────────────────────────────────────(fail)→ 5xx + OBS-01
│
├─ PRV-04  build XLSX per variant · publish · populate suppliers/users/requests
│   ├─ foreach variant : TPL-01 → TPL-02  (build XLSX)
│   ├─ FileStorage : store templates
│   ├─ DB write    : CFG_Variant (template_path) · CFG_TemplateVersion
│   ├─ [if initial run] : create SUP_Supplier · SUP_SupplierUser (batch)
│   │                     · WFA add_request (creates SUP_SupplierRequest, sets stage)
│   │                     · write table_id:20605  (unnamed table)
│   ├─ flow_id:2066426 (async)  ← UNRESOLVED call, passes template_version_id
│   └────────────────────────────────────────(fail)→ 5xx + OBS-01
│
├─ [if seed required] INC-01  seed data            [try/catch — SOFT FAIL]
│   ├─ Drive / FileStorage : locate + read seed file
│   ├─ match seed rows → requests : matched / unmatched / ambiguous
│   └─ foreach matched : INC-02 integrate          [per-supplier try/catch]
│       └─ inject seed rows into template · write seeded path → SUP_SupplierRequest
│
├─ PRV-05  "prepare for invitations"
│   └─ DASH-01  rebuild DASH_SuppliersStaging (truncate + batch)
│   └────────────────────────────────(fail appears to)→ 5xx   ⚠ see note
│
└─ 200 OK  { parse_summary, validate_summary, seed_data, send_invitations.ready: true }
           → caller may now fire R-1 (invitations) — OUT OF SCOPE
```

`OBS-01` (event emitter → `EventLog`) is called from nearly every recipe, almost always async. Treat it as a cross-cutting sink rather than a step in the line.

---

## Execution model & the four response codes

API-00 wraps the whole sequence in a try/catch. The flow is: validate the payload, then call each PRV step in order, checking the result after each call. A failed check returns immediately with `error_details` (`errored_action`, `errored_step`, `failed_recipe_url`, `error_message`) plus `request_details` and `workato_job_url`.

- **400 — Bad Request.** The early payload guard rejected the request before any provisioning work began.
- **500 — Internal Server Error.** A provisioning step failed and the gate after it short-circuited, *or* the outer catch fired. Carries the same `error_details` shape so you can see which action/step blew up.
- **504 — Gateway Timeout.** Declared because the synchronous chain (especially `PRV-04`) can outrun the endpoint's time budget. If you see this, the work may have partially committed even though the caller got no usable body.
- **200 — OK.** Everything that's allowed to be fatal succeeded. The body aggregates `parse_summary` + `validate_summary` (from PRV-02) and `seed_data` (from INC-01), and flips `send_invitations.ready`.

**The key consequence:** there is no transaction across steps. A failure in `PRV-03` or `PRV-04` aborts the *call* but leaves behind whatever rows were already written. Re-running is the recovery path, which is why initial-vs-repeat detection matters (see PRV-01 and PRV-04).

---

## Per-recipe reference (execution order)

### API-00 — Provisioning (the caller)
**Does:** Orchestrates the provisioning sequence synchronously, gates after every step, and assembles the final summary response. Emits OBS-01 events around the major transitions.
**Touches:** No tables directly — it delegates. Reads/writes happen inside the PRV steps.
**Fails when:**
- Payload guard rejects input → **400** (hard, before any work).
- Any of PRV-01…PRV-05 returns not-ok → early **5xx** at that gate (hard).
- The synchronous chain exceeds the time budget → **504** (hard, possible partial commit).
- Seed data is the one failure it *won't* abort on — `INC-01` is wrapped (soft).

---

### PRV-01 — Read config, create directories, invite analyst
**Does:** Reads existing `Project` and `CFG_TemplateVersion` (to orient the run), runs two python guards that validate inputs and determine initial-vs-repeat *(inferred)*, downloads the config file from Google Drive, creates the FileStorage directory structure (3 dirs), stores the config, creates the `Project` and `CFG_TemplateVersion` rows, and invites the analyst to the workspace.
**Touches:** R: `Project`, `CFG_TemplateVersion`. W(create): `Project`, `CFG_TemplateVersion`. External: Drive (download), FileStorage (dirs + store), WFA (invite).
**Returns:** `ok`, `correlation_id` (required); `template_version_id`, `project_id`, `error` (nullable on success).
**Fails when:**
- Either python guard rejects (bad/missing inputs, duplicate detection) → ok=false → **hard**.
- Drive download fails (bad file id, permissions) → **hard**.
- Row creation fails → **hard**.
- **Analyst invite fails → SOFT.** The `invite_user` call is in its own try/catch, so a failed workspace invite is logged but does *not* abort provisioning. Worth knowing: a fully "successful" provision can still leave the analyst un-invited.

---

### PRV-02 — Parse and build canonical model
**Does:** Fetches the stored config, parses it via the connector (`parse_config_file`), stores the parsed result, validates it via **CFG-01**, then builds the canonical model via **CAN-01** and persists `canonical_model_path`. Updates `Project` and `CFG_TemplateVersion` along the way.
**Touches:** R: `CFG_TemplateVersion`, `Project`. W(update): `Project`, `CFG_TemplateVersion`. Connector: `parse_config_file`. FileStorage: store ×2. Calls: CFG-01, CAN-01.
**Returns:** `ok` (required); `template_version_id`, `canonical_model_path`, `failure{error_type, human_message, failed_at_step, details_json}`, `parse_summary`, `validate_summary`.
**Fails when:**
- Parse throws on a malformed config → **hard**.
- **CFG-01 returns `status: invalid`** (config has structural errors) → PRV-02 short-circuits ok=false → **hard**. This is the important one: a config validation error halts provisioning *before any CFG_\* tables are hydrated*. Nothing downstream commits.
- CAN-01 build fails → **hard**.
- `failure` and `validate_summary` are the human-readable breadcrumbs when this step is the culprit.

---

### CFG-01 — Validate config
**Does:** Reads the parsed config from FileStorage and runs the connector's `validate_config`, producing a verdict: `status` (valid/invalid), `error_count`, `warning_count`, and per-check results (`checks[]`, `warnings[]`) across the full check suite (lookup references, depends-on references, rule target/condition fields, variant fields, user/supplier integrity, duplicates, required fields, form field limit, email format, etc.).
**Touches:** FileStorage: get. Connector: `validate_config`. Calls: OBS-01 (several).
**Fails when:**
- It mostly *doesn't throw* — it returns a verdict. The meaningful "failure" is `status: invalid`, which is what makes PRV-02 gate.
- A thrown connector exception is caught and reported via OBS-01 + an early return. *(inferred: this is the catch path, distinct from a clean invalid verdict.)*

---

### CAN-01 — Build canonical model
**Does:** Pure-python transform of the parsed/validated config into the canonical model JSON, plus a `summary` including slot-pool usage per type (text/num/bool/sel/date, used vs available).
**Touches:** python only. Calls: OBS-01 (async).
**Returns:** `canonical_model_json`, `meta`, `summary` (field/rule/lookup/variant counts + `slot_pool_usage`).
**Fails when:**
- The python build raises → caught → OBS-01 + early return → propagates up as a hard PRV-02 failure.
- Watch the `slot_pool_usage` numbers in the summary: nearing capacity in any type is an early warning even on success. *(inferred that exhaustion would surface as an error; the spec only shows it reporting usage.)*

---

### PRV-03 — Hydrate CFG_* tables
**Does:** Reads the canonical model and fans it out into the seven configuration tables as batch writes, in order: `CFG_Field`, `CFG_Rule`, `CFG_Lookup`, `CFG_Variant`, `CFG_VariantField`, `CFG_FormSlotMapping`, `CFG_ErrorMessage`. Returns per-table counts.
**Touches:** W(create-batch) ×7 (the CFG_* tables). FileStorage: get (canonical model). python ×2.
**Returns:** `ok` (required); `result`, `hydration_summary{...counts}`, `template_version_id`, `error_message`.
**Fails when:**
- Canonical model read fails → **hard**.
- Any batch write fails → **hard**, **with partial-commit risk.** Because the seven writes are sequential and not transactional, a failure midway (say, fields and rules written, lookups fail) leaves the CFG_* set internally inconsistent. Re-running needs to tolerate or clean up those partial rows. *(inferred from the sequential write structure.)*

---

### PRV-04 — Publish template and variants; populate suppliers/users/requests
**Does:** The heavy step. For each variant it builds an XLSX (**TPL-01 → TPL-02**) and stores it, then writes the template path back to `CFG_Variant` and updates `CFG_TemplateVersion`. On an initial run *(inferred from the `is_e2` branch)* it then batch-creates `SUP_Supplier` and `SUP_SupplierUser`, creates the supplier requests via WFA `add_request` (which sets `workflow_stage_id`), and writes the unnamed `table_id:20605`. Also fires `flow_id:2066426` async.
**Touches:** R: `CFG_TemplateVersion`, `Project`, `CFG_Variant`. W(update): `CFG_Variant`, `CFG_TemplateVersion`. W(create-batch): `SUP_Supplier`, `SUP_SupplierUser`, `table_id:20605`. WFA: `add_request`. FileStorage: get + store. python ×3. Calls: TPL-01, OBS-01, flow_id:2066426.
**Returns:** `status`, `template_version_id` (required); `variant_count`, `error_message`.
**Fails when:**
- A variant's XLSX build fails → **hard** (note `empty_variant` is a *non-error* outcome from TPL-02 — a variant with nothing visible isn't a crash).
- Supplier/user/request batch creation fails → **hard**, again **with partial-commit risk**: some variants published, some suppliers created, some requests not.
- `add_request` to the WFA fails → **hard**.
- **Two unresolved dependencies live here:** the async `flow_id:2066426` (raw workspace-local flow id, not traceable from recipe JSON) and the write to `table_id:20605` (unnamed table). Both should be repackaged as named references at source so this step is fully auditable.
- The initial-vs-repeat branch (`is_e2`) means a re-run may *skip* supplier population — confirm the intended idempotency before relying on re-provisioning to fix a partial PRV-04. *(inferred.)*

---

### TPL-01 — Build XLSX template
**Does:** Resolves the variant and canonical model, then delegates the actual workbook construction to **TPL-02**. Returns a verdict and the file content + metadata.
**Touches:** R: `CFG_TemplateVersion`, `CFG_Variant`. FileStorage: get. Calls: TPL-02, OBS-01.
**Returns:** `verdict{status, error{where, what, severity}}` (required); `file_content`, `suggested_filename`, `metadata`.
**Fails when:** verdict status is non-success; the `error.where/what/severity` triplet localizes the problem for a human.

---

### TPL-02 — Build XLSX
**Does:** Pure-python workbook builder (the openpyxl layer). Either succeeds with file content or returns the explicit `empty_variant` status.
**Touches:** python only.
**Returns:** `status` (success / empty_variant) (required); `file_content`, `suggested_filename`, `metadata`, `error{code, message}`.
**Fails when:** the build raises → reported via `status` + `error{code, message}`. `empty_variant` is expected, not a fault.

---

### INC-01 — Seed data (the only soft step)
**Does:** Locates the seed file (Drive download or an existing FileStorage path), reads it, loads the supplier roster (`SUP_Supplier`, `SUP_SupplierRequest`), matches seed rows to requests by an index key (typically supplier name), then for each matched supplier calls **INC-02** to integrate. Returns match counts and per-supplier results.
**Touches:** R: `SUP_Supplier`, `SUP_SupplierRequest`. External: Drive, FileStorage. python ×1. Calls: INC-02, OBS-01.
**Returns:** `ok` (required); `counts{matched/unmatched/ambiguous, unmatched_keys}`, `ambiguous_keys[]`, `matched[]`, `unmatched[]`, `integration_results[]`.
**Fails when:**
- **The whole step is wrapped by API-00 as soft** — any failure here is caught and provisioning still returns 200. The *only* signal of trouble is `seed_data.ok` (and the counts) in the response body. If a human isn't reading that field, a partial or failed seed looks like a clean provision.
- Internally: file location/read failures gate INC-01 early; **per-supplier** INC-02 failures are collected into `integration_results[]` rather than aborting the batch.
- **Ambiguous matches** (one seed value mapping to multiple requests) and **unmatched keys** are reported, not errors — but they mean some suppliers got no seed data.

---

### INC-02 — Integrate seed data for a single supplier
**Does:** Reads the supplier's request and variant, fetches the blank template, injects that supplier's seed rows into the XLSX, stores the seeded template, and writes the seeded path back to `SUP_SupplierRequest`.
**Touches:** R: `SUP_SupplierRequest`, `CFG_Variant`. W(update): `SUP_SupplierRequest`. FileStorage: get + store. python ×1.
**Returns:** `ok` (required); `error_message`, `error_details{workato_error_uuid, error_action, msg, error_step_number}`.
**Fails when:** any read/build/store step fails → returns ok=false with `error_details`; the parent INC-01 catches it per-supplier so the rest of the batch proceeds.

---

### PRV-05 — Prepare for supplier user invitations
**Does:** Despite the name, what it actually does per the spec is call **DASH-01** to rebuild the dashboard staging table, then return.
**Touches:** Calls: DASH-01, OBS-01.
**Returns:** `ok` (required); `error`, `rows_written`.
**Fails when:**
- ⚠ **Based on the control flow, a PRV-05 failure appears to trigger an error return from API-00** — which would put dashboard sync on the critical path at the very finish line, *after* every heavyweight step has already committed. That means a cosmetic dashboard-rebuild failure could turn a fully-provisioned run into a 5xx for the caller. This is worth confirming against the recipe JSON, because if true it's a surprising place to fail hard. *(inferred from the gate following the PRV-05 call.)*

---

### DASH-01 — Dashboard synchronization
**Does:** Reads current `Project` / `SUP_SupplierRequest` / `SUP_SupplierUser` state and rebuilds `DASH_SuppliersStaging` by **truncate + batch insert**.
**Touches:** R: `Project`, `SUP_SupplierRequest`, `SUP_SupplierUser`, `DASH_SuppliersStaging`. W: `DASH_SuppliersStaging` (truncate, then create-batch). python ×1.
**Returns:** `ok` (required); `error`, `rows_written`.
**Fails when:** read or the truncate/rebuild fails. Note the truncate-then-rebuild pattern means a failure *after* truncate but *before* rebuild would leave the staging table empty until the next successful sync. *(inferred from the truncate→batch order.)*

---

### OBS-01 — Event emitter (cross-cutting)
**Does:** Writes a single `EventLog` row for an event (severity, source recipe, step, phase, message, details). The observability backbone.
**Touches:** W(create): `EventLog`. python ×1.
**Returns:** `event_id`, `timestamp`.
**Fails when:** rarely consequential — almost every caller invokes it async (fire-and-forget). A few call sites use it sync (e.g. within CFG-01); a sync OBS failure there could propagate, but that's the exception.

---

## Cross-cutting things to watch

1. **No transaction across steps.** PRV-01→04 each commit independently. A hard failure in 03 or 04 leaves partial rows behind; recovery is a re-run, so initial-vs-repeat detection (`is_initial` / `is_e2`) is load-bearing.
2. **Synchronous chain → 504 risk.** PRV-04 (per-variant XLSX builds + batched writes + a foreach of WFA `add_request`) is the time sink on the critical path. The 504 is declared for a reason.
3. **Seed failures are nearly invisible.** Only `seed_data.ok` and the counts in the 200 body reveal a seed problem. Anything consuming the response should surface that field to a human.
4. **Dashboard sync may sit on the critical path.** See PRV-05 — confirm whether a DASH-01 failure should really be allowed to fail the whole provision at the end.
5. **Two unresolved identifiers in PRV-04.** `flow_id:2066426` (untraceable async call) and `table_id:20605` (unnamed table). Until these are named references, PRV-04 isn't fully auditable from the recipe set.
6. **Config validation is an early hard gate (good).** An invalid config stops everything in PRV-02 before any CFG_* / SUP_* writes — failures land before they can leave a mess.

---

## Open items / confirm against recipe JSON

- The exact status code (400 vs 500) each error gate returns — control flow shows the gates and `error_details` shape, but the code-per-gate mapping should be verified.
- Whether a PRV-05 / DASH-01 failure truly aborts the provision (item 4 above).
- PRV-04 re-run idempotency under the `is_e2` branch (item 1).
- Whether CAN-01 slot-pool exhaustion is an error or a silent over-capacity report.
- Naming the two unresolved PRV-04 identifiers.
