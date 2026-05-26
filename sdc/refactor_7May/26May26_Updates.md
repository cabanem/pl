# `recipes` tab — paste-ready edit text

Scope: the **`recipes` tab only** (per your ask). The `file_struct` / `conventions` / `state_mgt` / `phases` edits from the reconciliation live in other tabs and are not here. The phase-name fixes in Group 4 have a matching `phases`-tab side noted at the end.

**How to paste:** cells use real in-cell newlines (Alt+Enter), not a literal `\n` token. To keep a multi-line block in one cell, enter the cell first (double-click or F2) and paste into edit mode, or paste into the formula bar — otherwise Excel splits the lines across rows. (If you'd rather skip the paste friction entirely, I can apply all of this to a copy of the workbook and hand you the .xlsx.)

Confidence tags: **[JSON]** confirmed from the recipe JSON this session · **[ref]** from `SDC_Recipe_Reference.md` (confirm against the JSON before committing) · **[decision]** needs a call from you.

Header map for reference: A Code · B Name · C Domain · D Role · E Iteration · F Completed? · G Build queue stage · H Capability · I Trigger schema · J Return schema · K Substage outline · L Cross-cutting recipes · M Phase emitted · N Error types · O State transitions · P Invariants honored · Q Recipe-specific items.

---

## Group 1 — JSON-confirmed (paste directly)

### PRV-01 (row 10) — analyst invite + `/templates/` paths

**K10** *(changed: step 2 E1 gains the analyst invite; step 5 path `/versions/`→`/templates/` + dir-ensure)*
```
(1) Validate payload shape. Required fields present and typed correctly. On malformed payload, emit recipe_failed with recipe_invariant and return HTTP 400. 
(2) Determine project context. 
      (-) E1: verify no Project exists, create one with project_id, analyst_email, customer_name. Invite the analyst (analyst_email) to the portal via WFA invite_user (user group: Implementation team). E1 only; wrapped in its own try/catch — an invite failure emits to OBS-01 but does NOT abort provisioning. 
      (-) E2: resolve singleton Project. (Analyst already has portal access; no invite.) 
(3) Create CFG_TemplateVersion row in draft. 
      (-) E1: version_number=1. 
      (-) E2: version_number=MAX+1. 
(4) Fetch config JSON from Drive via drive_id_config_json. 
(5) Ensure FileStorage dirs /templates/v<NNN>/ and /templates/v<NNN>/variants/, then write the raw sheet_data to CFG_TemplateVersion.gas_export_path. Path convention: /templates/v<NNN>/gas_export.json. 
(6) Emit provisioning_triggered via OBS-01 with project_id and template_version_id in details_json. 
(7) Fire PRV-02 with template_version_id (async). 
(8) Return HTTP 200 to GAS with project_id and template_version_id.
```

**L10** *(changed: add WFA invite_user)*
```
(-) OBS-01 (for trigger event, any failure), 
(-) PRV-02 (async, chain), 
(-) WFA invite_user (analyst portal access — E1 only, non-fatal), 
(-) Data table ops: Project create/read, CFG_TemplateVersion create/update
```

**M10** — no change. (PRV-01 emits only `provisioning_triggered` + `recipe_failed`; it does **not** emit `project_recorded` — that orphan lives in the `phases` tab, not here. Also closes **OQ-009** on the OQ tab.)

---

### UPL-01 (row 15) — trigger, sync STS-01 + return-gating, INV-01a, success path

**I15** *(changed: `new_records_realtime`→`updated_records_realtime`)*
```
(-) Data Tables updated_records_realtime trigger on SUP_SupplierRequest
(-) Filter: pending_upload_file.file_content present
(-) Trigger payload: SUP_SupplierRequest row
```

**K15** *(changed: step 8 sync + return-gating + verdict-table fix; new step 9 success path; emit note renumbered to 10)*
```
(1) Capture trigger context. The trigger delivers the full SUP_SupplierRequest row including the file column's filename and file_content. Capture supplier_request_id (the row PK), status, assigned_version_id, submission_attempt, and submitted_filename into recipe variables. Mint upload_id as a fresh UUID.
(2) State-eligibility check. Verify status is sent or supplier_action_required. If not (already pending_review, approved, cancelled, etc.), emit recipe_failed with state_inconsistent, clear pending_upload_file on the request row (to prevent trigger refire loops), and stop.
(3) Bridge bytes to FileStorage. Read pending_upload_file.file_content from the trigger pill, write to FileStorage at /uploads/<supplier_request_id>/<upload_id>.xlsx. Wrap in a monitor block; on FileStorage failure, emit recipe_failed with external_action_failed and return early. Do NOT clear pending_upload_file on this failure path — the bytes need to remain available for retry.
(4) Create the RUN_Upload row. Stamp upload_id, supplier_request_id, template_version_id (from the request's assigned_version_id - frozen at issuance), submitted_path (the FileStorage path from substage 3), status=received, submitted_at=now.
(5) Clear trigger column and increment submission_attempt. Update SUP_SupplierRequest with pending_upload_file=null and submission_attempt=prior+1 in one update_record call. Both fields are non-state-protected per IV-1. The clear closes the trigger refire window before the synchronous VAL-01 call.
(6) Call VAL-01 synchronously. Pass upload_id and submission_source=file. VAL-01 reads the RUN_Upload row, parses the XLSX, validates, persists RUN_ValidationResult and RUN_FieldError rows, returns verdict + validation_result_id + count fields + trigger_context.
(7) Write denormalized fields to SUP_SupplierRequest. Update current_validation_result_id, last_valid_row_count, last_invalid_row_count from VAL-01's return. Non-state fields, IV-1 permitted.
(8) Resolve target_state and route to STS-01. Map verdict to target_state (Python step):
  | VAL-01 verdict      | target_state                          | trigger_context
  | passed                   | pending_review                    | system_validation_passed
  | failed                      | supplier_action_required    | system_validation_failed
  | empty                     | supplier_action_required    | system_validation_failed
  | structural_failure  | supplier_action_required    | system_validation_failed  (lumped — the distinct system_structural_failure was never implemented and is not in STS-01's table)
  | error / fallback     | <prior_status> (refresh)       | pipeline_error_alert
Call STS-01 SYNCHRONOUSLY (call_recipe). UPL-01 needs the return: it captures sts_result_success and gates all downstream side effects on it. NOTE: pipeline_error_alert is not in STS-01's legal table, so an error verdict currently yields illegal_transition → sts_result_success=false → step (9) is skipped and the submission dead-ends (reconciliation B1).
(9) On STS-01 success (sts_result_success true): read project-scoped context (default_due_days, customer_name, analyst_email). If target_state == pending_review, share the request to the analyst via WFA share_request, then async-fire INV-01a with workflow_stage="human review". Otherwise (supplier_action_required), async-fire INV-01a with workflow_stage="New". (INV-01a case-folds workflow_stage, so the mixed casing is harmless.)
(10) No terminal emit. UPL-01 does not emit its own success phase — VAL-01 emits validation_passed/validation_failed/etc., STS-01 emits state_transition, so a UPL-01 emit would be redundant. The recipe only emits recipe_failed if substage 2 or substage 3 fail.
```

**L15** *(changed: add INV-01a; annotate STS-01 sync)*
```
(-) VAL-01 (to run the validation pipeline), 
(-) STS-01 (to transition based on the verdict; called SYNC — return gates downstream), 
(-) INV-01a (async, task assignment on STS-01 success — both branches), 
(-) OBS-01 (for recipe_failed on infrastructure or invariant failure)
```

---

## Group 2 — Reference-grounded (verify against the JSON before committing)

These reflect the decomposition per the reference; I haven't re-read PRV-02 / PRV-04 / TPL-01 / INV-01 this session. The `/templates/` path swap in PRV-02 is high-confidence (PRV-01's code and the `file_struct` tab both use it); the CAN-01 / TPL-02 / PRV-05 / INV-01a *calls* are [ref].

### PRV-02 (row 11) — `/templates/` paths + CAN-01 call

**K11** *(changed: steps 4 & 9 paths; step 8 inline build → CAN-01 call)*
```
(1)   Read version row from CFG_TemplateVersion by template_version_id. Get gas_export_path and version_number. Derive is_initial = (version_number == 1). 
(2)   Read GAS export from FileStorage at gas_export_path. 
(3)   Call connector parse_config_file with sheet_data content. Returns parsed_config_json, structured arrays, parse_summary. On parse failure, emit recipe_failed with config_unparseable, return early. Version stays in draft with gas_export_path set, downstream paths null. 
(4)   Write parsed_config_json to FileStorage at /templates/v<NNN>/parsed_config.json. Update CFG_TemplateVersion.parsed_config_path. 
(5)   Emit config_parsed via OBS-01 with template_version_id and parse_summary. 
(6)   Call CFG-01 with parsed_config_path. CFG-01 returns the verdict. 
(7)   Branch on verdict. If invalid, CFG-01 already emitted config_rejected; PRV-02 returns early. PRV-03 not called. Version stays in draft. If valid, continue. 
(8)   Call CAN-01 (sync) to build the canonical model. CAN-01 mints UUIDs for each entity (fields, rules, lookups, variants, variant_fields, form_slot_mappings, error_messages), resolves FK references from names, and assigns slot pool positions. 
(9)   Write canonical model to FileStorage at /templates/v<NNN>/canonical_model.json. Update CFG_TemplateVersion.canonical_model_path. 
(10) Fire PRV-03 with template_version_id (async). (11) Return.
```

**L11** *(changed: add CAN-01)*
```
(-) OBS-01 (for config_parsed, recipe_failed, or parse/canon fail)
(-) CFG-01 (for validation)
(-) CAN-01 (sync, builds the canonical model)
(-) PRV-03 (async)
```

### PRV-04 (row 13) — fire PRV-05 → DASH-01

**K13** *(changed: insert step 10 PRV-05 fire; Return becomes 11)*  — keep steps (1)–(9) verbatim, then:
```
(10) Async-fire PRV-05 (dashboard staging). PRV-05 sync-calls DASH-01 to rebuild DASH_SuppliersStaging from SUP_SupplierRequest + SUP_SupplierUser.
(11) Return.
```

**L13** *(changed: add PRV-05)*
```
(-) OBS-01 (for template_built (one per variant, emitted by TPL-01), version_deprecated (E2 only), suppliers_staged (E1 only), version_published, provisioning_complete), 
(-) TPL-01 (once per variant), 
(-) PRV-05 (async, dashboard staging → DASH-01)
```
**M13** — no change (DASH-01's emit is DASH-01's, not PRV-04's).

### TPL-01 (row 8) — delegate render to TPL-02

**K8** *(changed: step 4 inline openpyxl → TPL-02 call; serialize folded in; renumbered)*
```
(1) Read the canonical model. FileStorage read at canonical_model_path. Parse JSON. (Also: confirm the version is draft; handle empty_variant.), 
(2) Resolve the variant. Filter cfg_fields to those claimed by variant_id. Sort by position. The result is the column list for the data entry sheet., 
(3) Resolve the lookups. For each field that references a lookup, collect the values from cfg_lookups. Group dependent-lookup values by parent., 
(4) Render the workbook via TPL-02 (sync). TPL-01 is the orchestration wrapper; TPL-02 does the pure XLSX render (one openpyxl Python step) — reference sheet with sanitized column names, data entry sheet with headers/validation rules, serialize to bytes/base64 — and returns file_content + suggested_filename + sheet_metadata. The shared sanitization function lives in TPL-02., 
(5) Emit. OBS-01 with phase template_built. details_json carries variant_id, field count, lookup count., 
(6) Return the bytes, filename, and metadata.
```

**L8** *(changed: add TPL-02)*
```
(-) OBS-01 (for success)
(-) TPL-02 (sync, pure XLSX render)
```

### INV-01 (row 14) — task placement via INV-01a

**K14** — keep all steps verbatim except substep 5(b), which becomes:
```
  (b) Assign the task by async-firing INV-01a (the task-assignment recipe), passing workflow_stage for a new request. Assignee only — secondary users get access but not the task. INV-01a creates the WFA human_review_on_existing_record task on the correct page/stage.
```

**L14** *(changed: add INV-01a)*
```
(-) UTL-01 (generate link), 
(-) INV-01a (async, assignee task assignment), 
(-) STS-01 (for pending >> sent transition), 
(-) OBS-01 (for invitation_sent and recipe_failed)
```

---

## Group 3 — New rows

### INV-01a [JSON] — append a new row
```
A: INV-01a
B: Assign task to user in Workflow App
C: INV (invitations)
D: Callable
E: (set to its build date)
F: TRUE
G: Stage 4 (invite)  — also used by UPL-01 (Stage 5)
H: Task-assignment helper. Creates a WFA human_review_on_existing_record task on the correct page/stage for a supplier request. Called async by INV-01 (initial invite) and UPL-01 (post-validation). No happy-path emit.
I: Callable (recipe_function.execute). Params: supplier_request_id, client_name, days_to_complete_task, workflow_stage (enumerated: new | human review), task_name, assignee_email.
J: None (no-op return).
K: (1) get_requests from the WFA portal filtered by supplier_request_id (limit 1).
(2) Guard: if not exactly one request (length != 1), return no-op.
(3) Branch on workflow_stage.to_s.downcase:
   (-) "new" -> human_review_on_existing_record on page "Submit data for validation", stage "New", send_email_notification=false, due_in_days=7.
   (-) "human review" -> human_review_on_existing_record on page "Human review", stage "Human review", send_email_notification=true, due_in_days=7.
   (-) neither -> falls through to no-op (no else branch).
(4) Return no-op.
(5) catch: async-fire OBS-01 on technical failure only; return no-op.
L: (-) OBS-01 (on technical failure only)
M: None on happy path; OBS-01 emit on catch.
N: (-) external_action_failed / unexpected_error (WFA task creation failed)
O: None (does not write SupplierRequest state; places a WFA task).
P: Case-insensitive workflow_stage match (downcase) — tolerant of caller casing.
Q: Branch is case-folded vs "new"/"human review", so UPL-01's "New"/"human review" both match (finding #2 = false alarm). No else branch — an unrecognized workflow_stage no-ops silently. due_in_days hardcoded to 7; the declared days_to_complete_task param is unused by the task action.
```

### LNK-01 [JSON] — append a new row
```
A: LNK-01
B: Generate download link for FileStorage file
C: LNK (WFA-facing link)  — note: LNK domain missing from conventions tab
D: Trigger (WFA app function)
E: (set to its build date)
F: TRUE
G: Stage 1 (foundational utilities)  — overlaps UTL-01
H: WFA-facing link refresh. The portal "refresh link" button calls this app function to regenerate a download link for a path. Overlaps UTL-01 and currently generates the link itself rather than delegating to UTL-01 — see Q / reconciliation B2.
I: WFA app function (app_function_generic_request). Params: supplier_request_id, file_storage_path.
J: (-) refreshed_link
K: (1) try: workato_files.create_shareable_link (scope=download, expires_in=604800 [7 days]) against file_storage_path.
(2) Return success with refreshed_link to the WFA caller.
(3) catch: async-fire OBS-01 with error details; return is_success=false, message "Error generating link."
L: (-) OBS-01 (on failure only)
M: (-) recipe_failed (error case only — no success emit)
N: (-) external_action_failed (FileStorage link API error/timeout)
O: None (read-only)
P: IV-08 (Path is canonical, link is volatile) — INTENDED, but currently VIOLATES the single-owner clause by calling create_shareable_link directly instead of via UTL-01. Reconcile (fold into UTL-01) or amend IV-08.
Q: TTL hardcoded 604800 (7-day) — conflicts with IV-13/SI-005/SI-006 which say 10-day (Decision D1). Returns only refreshed_link, where UTL-01 returns {link, expires_at}.
```

### PRV-05 / TPL-02 / DASH-01 / WFA-06 [ref] — skeleton rows (fill K/N/O/P from the JSON at line-level review)
```
PRV-05  | Dashboard staging wrapper | C: PRV | D: Callable | F: TRUE | G: Stage 3 (PRV chain)
  H: Thin try/catch wrapper. Async-fired by PRV-04; sync-calls DASH-01 to rebuild the supplier dashboard staging table. (Reference notes a catch-message typo "Dashbaord".)
  L: (-) DASH-01 (sync), (-) OBS-01 | K/N/O/P: [pending line-level review]

TPL-02  | Render XLSX template | C: TPL | D: Callable | F: TRUE | G: Stage 2 (pure-compute)
  H: Pure XLSX render. One openpyxl Python step -> file_content + suggested_filename + sheet_metadata. Called sync by TPL-01. Holds the shared column-name sanitization function.
  L: (none — pure function), (-) OBS-01 if it emits | K/N/O/P: [pending line-level review]

DASH-01 | Rebuild dashboard staging | C: DASH (domain missing from conventions) | D: Callable | F: TRUE | G: Stage 3 (PRV chain)
  H: Rebuilds DASH_SuppliersStaging via truncate-and-reload from SUP_SupplierRequest + SUP_SupplierUser. Called sync by PRV-05.
  L: (-) OBS-01 | K/N/O/P: [pending line-level review]

WFA-06  | Analyst review bridge | C: REV | D: Trigger (WFA app function) | F: TRUE | G: Stage 5 (review and submit)
  H: Thin bridge. Analyst approve/reject action in the WFA portal -> sync-calls REV-01.
  L: (-) REV-01 (sync), (-) OBS-01 | K/N/O/P: [pending line-level review]
```
*(R-1(Temp) and the WFA read-leaves WFA-01/02/03/05/07 are optional — say if you want skeletons for those too.)*

### CAN-01 (row 24) [ref] — flesh out the stub
```
C24: CAN (canonical model build)  — domain missing from conventions tab
G24: Stage 2 (pure-compute)  — invoked within the PRV chain by PRV-02
H24: Pure function. Single Python transform in try/catch. Builds the canonical model from the parsed config: mints UUIDs for all entities, resolves FK references from names, assigns slot pool positions. Called sync by PRV-02.
I24: Callable (recipe_function.execute).
J24: (-) canonical_model (verify exact field name in the JSON)
K24: [pending line-level review]
L24: (-) OBS-01 (on failure)   [verify]
M24/N24/O24/P24/Q24: [pending line-level review]
```

---

## Group 4 — Phase-name fixes (M column)

These align the recipe rows to the canonical names already in the `phases` tab and drop the false "needs taxonomy addition" notes. (Each also has a `phases`-tab side, outside this scope.) Clean 1:1 renames:

**M17 (UPL-02)** — `corrections_template_built` → `resubmission_template_generated`
```
(-) resubmission_template_generated (success), 
(-) recipe_failed (on failure)
```
**M19 (INV-02)** — `refresh_outreach_sent` → `outreach_refreshed`
```
(-) outreach_refreshed (one per user), 
(-) recipe_failed (on infrastructure failure)
```
**M20 (INV-03)** — `user_added` → `user_added_to_request`
```
(-) user_added_to_request, 
(-) recipe_failed (on infrastructure or invariant failure)
```
**M21 (INV-04)** — `reassignment_complete` → `request_reassigned`
```
(-) request_reassigned, 
(-) recipe_failed (on infrastructure or invariant failure)
```

**M18 (INC-01) [decision]** — `supplier_seeded` maps to the canonical `incumbent_data_seeded`, but `seeding_complete` (a summary emit) has **no** canonical equivalent in the `phases` tab. Rename the first; decide whether to add a summary phase or drop it:
```
(-) incumbent_data_seeded (per seeded supplier), 
(-) seeding_complete (SUMMARY — no canonical phase exists; add to taxonomy or drop), 
(-) recipe_failed (on infrastructure failure)
```

**M22 (REM-02) [decision]** — the canonical phase for REM-02 is `reminder_cycle_triggered` (a *start-of-run* marker), but the row invents two *mid/end* markers (`eligibility_evaluated`, `reminder_dispatch_complete`). This isn't a rename — the taxonomy has one phase where the recipe wants a lifecycle. Decide whether to (a) use `reminder_cycle_triggered` at the start and drop the other two, or (b) add the two lifecycle phases to the taxonomy. Left as-is pending that call.

---

## Group 5 — Cosmetic

**E17 (UPL-02 Iteration)** and **E18 (INC-01 Iteration)** — year typo `2016` → `2026` (both currently `2016-05-13`).

---

### Not in scope here (other tabs, from the reconciliation)
`phases` tab: define/prune the three orphan phases (`project_recorded`, `submission_received`, `upload_extracted`) and the C4 collisions' canonical side. `conventions`: add DASH/LNK domains + `DASH_SuppliersStaging`. `file_struct`: reconcile the uploads/seeded/corrections paths. `state_mgt`: SI-012 fix, `*_file_id`→`*_path`. `invariants`: collapse IV-11/IV-13. Decision D1 (7- vs 10-day TTL) gates the LNK-01/UTL-01 TTL wording.
