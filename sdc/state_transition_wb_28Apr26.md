Here's a starter workbook structure with headers, data validation values, and seed rows for each tab. Paste these into a fresh Google Sheet — one tab per section. I've populated enough rows from our conversation to give you the shape; you'll fill in the rest as you work through it.

## Tab 1 — `States`

Headers (row 1):

```
Machine | State | Description | Terminal? | Entry condition | Typical dwell time | Pertinent fields | Notes
```

Seed rows:

```
HOME_Requests | PENDING | Webhook arrived, structurally valid, awaiting routing or work | No | B-01 step 7 creates row with this status | seconds | correlation_id, config_file_id, analyst_email | Brief; usually transitions same-recipe-execution
HOME_Requests | REJECTED | Webhook payload failed structural validation | Yes | B-01 step 7 sets when is_valid=false | indefinite | error_message, correlation_id | No downstream work happens
HOME_Requests | PROVISIONING | Active provisioning in progress (new project path) | No | B-02 starts (or set by B-01 before calling B-02) | minutes | correlation_id, project_id, manifest_id | Today: stays here forever on failure (gap)
HOME_Requests | CONFIG_UPDATE | Republish audit row for an existing project | No | B-01 step 11 sets when ACTIVE row found for config_file_id | minutes | correlation_id, project_id | Open question: transitions to ACTIVE/FAILED or stays?
HOME_Requests | ACTIVE | Project is provisioned and live (project root row) | No | B-02 step 13 transitions PENDING→ACTIVE on success | indefinite | All fields populated | Persistent across republishes
HOME_Requests | FAILED | Provisioning could not complete | Yes | Should be set by error branches in B-02/P-01 (currently missing) | indefinite | error_message populated | Gap: no recipe currently writes this
HOME_Requests | CLOSED | Terminal end-of-life for the project | Yes | T-layer recipe (future) | indefinite | All fields populated | T-layer not yet built
VER_TemplateVersion | draft | Newly created version, not yet published | No | P-01 step 21 inserts row | seconds to minutes | template_version_id, template_project_id, version_number | Stays draft if P-01 fails before step 49
VER_TemplateVersion | published | Version is live for the project | No | P-01 step 49 transitions draft→published | indefinite | All fields plus published_at | Invariant: at most one per template_project_id
VER_TemplateVersion | deprecated | Was previously published, superseded by newer version | Yes | P-01 step 20 transitions on republish | indefinite | All fields | Cannot be revived
WFA_SupplierRequest | draft | Row exists but supplier not yet notified | No | P-01 step 53 (or equivalent) creates row | seconds | supplier_request_id, supplier_name, assigned_variant_id | Brief; transitions to invited same-recipe
WFA_SupplierRequest | invited | Supplier was notified, awaiting first interaction | No | After invitation email dispatched | days | invitation_sent_at, template_url | Reminder workflow targets this state
WFA_SupplierRequest | acknowledged | Supplier opened invitation but hasn't started filling | No | First detected interaction (download, portal access) | hours to days | acknowledged_at | Optional; skip if not detectable
WFA_SupplierRequest | in_progress | Supplier actively filling data | No | First data save | days to weeks | last_activity_at | Longest-lived state in practice
WFA_SupplierRequest | submitted | Supplier formally submitted | No | Explicit submission action | seconds (until validation runs) | submitted_at, submission_payload | Triggers V-layer validation
WFA_SupplierRequest | validated | Submission passed all rules | No | V-layer recipe completes with no errors | minutes to hours | validated_at, warning_count | Awaits analyst acceptance
WFA_SupplierRequest | invalid | Submission failed validation | No | V-layer found errors | minutes | error_count, error_details_ref | Auto-reverts to in_progress (TBD)
WFA_SupplierRequest | accepted | Submission accepted as final-good | No | Analyst accepts (or auto) | indefinite | accepter, accepted_at | No more changes expected
WFA_SupplierRequest | closed | Supplier participation concluded | Yes | T-layer or analyst action | indefinite | closure_reason | Distinct from accepted
WFA_SupplierRequest | abandoned | Supplier didn't engage in time | Yes | SC-layer cleanup detects staleness | indefinite | abandoned_at, last_activity_at | SC-layer not yet built
```

Data validation on `Machine`: `HOME_Requests, VER_TemplateVersion, WFA_SupplierRequest`.
Data validation on `Terminal?`: `Yes, No`.

## Tab 2 — `Transitions`

Headers:

```
Machine | From state | To state | Trigger | Triggering recipe | Recipe step | Phase emitted | Severity | Currently implemented? | Notes
```

Seed rows:

```
HOME_Requests | (none) | PENDING | Webhook arrives, structurally validated | B-01 | step 7 | webhook_received + webhook_validated | info | Yes | Two phases on entry
HOME_Requests | (none) | REJECTED | Webhook arrives, structural validation fails | B-01 | step 7 | webhook_rejected | error | Yes | Terminal
HOME_Requests | PENDING | PROVISIONING | New-project routing, B-02 starts | B-01 → B-02 | B-01 step 9 | provisioning_started | info | Partial | Status update may not happen
HOME_Requests | PENDING | CONFIG_UPDATE | Existing project found, republish path | B-01 | step 11 | request_routed | info | Yes | New audit row, not transition on existing
HOME_Requests | PROVISIONING | ACTIVE | Provisioning succeeds | B-02 | step 13 | request_marked_active | info | Yes | New-project happy path
HOME_Requests | PROVISIONING | FAILED | Provisioning fails | B-02 or P-01 (error branch) | TBD | recipe_failed | error | NO | Gap to fix
HOME_Requests | CONFIG_UPDATE | ACTIVE | Republish succeeds | P-01 | TBD | recipe_completed | info | Open question | Decide whether transition or stay
HOME_Requests | CONFIG_UPDATE | FAILED | Republish fails | P-01 (error branch) | TBD | recipe_failed | error | NO | Gap to fix
HOME_Requests | ACTIVE | CLOSED | Project closed | T-layer | TBD | project_closed | info | Future | T-layer not built
VER_TemplateVersion | (none) | draft | New version created | P-01 | step 21 | version_drafted (optional) | info | Yes (state) / Optional (phase) | 
VER_TemplateVersion | draft | published | Provisioning publishes | P-01 | step 49 | version_published | info | Yes | Major milestone
VER_TemplateVersion | published | deprecated | Republish supersedes | P-01 | step 20 | version_deprecated | info | Yes | Happens during republish
WFA_SupplierRequest | (none) | draft | P-01 creates supplier row | P-01 | step 53 | supplier_request_created | info | Yes (state) / TBD (phase) | 
WFA_SupplierRequest | draft | invited | Invitation dispatched | P-01 or N-layer | TBD | supplier_invited | info | Partial | Email send currently inline
WFA_SupplierRequest | invited | acknowledged | First interaction detected | (portal/email tracker) | TBD | supplier_acknowledged | info | Future | Depends on UX
WFA_SupplierRequest | invited | in_progress | First data save | (portal) | TBD | submission_started | info | Future | 
WFA_SupplierRequest | acknowledged | in_progress | First data save | (portal) | TBD | submission_started | info | Future | 
WFA_SupplierRequest | in_progress | submitted | Supplier submits | (portal) | TBD | submission_submitted | info | Future | Triggers V-layer
WFA_SupplierRequest | submitted | validated | Validation passes | V-01 | TBD | submission_validated | info | Future | 
WFA_SupplierRequest | submitted | invalid | Validation fails | V-01 | TBD | submission_invalid | error | Future | 
WFA_SupplierRequest | invalid | in_progress | Supplier resumes work | (portal) | TBD | submission_resumed (TBD) | info | Future | Auto-revert (decide)
WFA_SupplierRequest | validated | accepted | Analyst accepts (or auto) | (analyst action or rule) | TBD | submission_accepted | info | Future | 
WFA_SupplierRequest | accepted | closed | Project closes | T-layer | TBD | supplier_request_closed | info | Future | 
WFA_SupplierRequest | (any non-terminal) | abandoned | Stale timeout | SC-layer | TBD | supplier_request_abandoned | warn | Future | SC-layer not built
WFA_SupplierRequest | (any non-terminal) | closed | Explicit closure | analyst action | TBD | supplier_request_closed | info | Future | 
```

Data validation on `Severity`: `info, warn, error`.
Data validation on `Currently implemented?`: `Yes, No, Partial, Future, NO (gap)`.

## Tab 3 — `Phases`

Headers:

```
Phase name | Layer | Severity (typical) | Triggered by recipe | Triggered when | State change emitted? | Linked transition (Machine:From→To) | Audience | Pertinent details to log | Example human_message
```

Seed rows:

```
webhook_received | Intake | info | B-01 | Top of B-01, before validation | No (logging only) | (none, pre-state) | analyst, operator | analyst_email, config_file_id, payload size | "Config submission received from emily@..."
webhook_validated | Intake | info | B-01 | After is_valid passes | Yes | HOME_Requests:none→PENDING | operator | validation result | "Payload validated successfully"
webhook_rejected | Intake | error | B-01 | After is_valid fails | Yes | HOME_Requests:none→REJECTED | analyst, operator | rejection reason, missing fields | "Payload rejected: missing required field 'config_file_id'"
request_routed | Intake | info | B-01 | After routing decision | No (informational) | (none) | operator | route_taken (new/config_update) | "Routed as config update for existing project"
provisioning_started | Provisioning | info | B-02 or P-01 | Top of provisioning recipe | Yes | HOME_Requests:PENDING→PROVISIONING | analyst, operator | template_project_id (if known) | "Provisioning started for project Acme-Q4"
workspace_provisioned | Provisioning | info | B-02 | After WFA_TemplateProject row inserted | No (milestone) | (none, parallel state) | operator | template_project_id, folder_path | "Workspace provisioned for Acme-Q4"
request_marked_active | Provisioning | info | B-02 | After HOME_Requests update | Yes | HOME_Requests:PROVISIONING→ACTIVE | analyst | template_project_id | "Project Acme-Q4 is now active"
config_validated | Provisioning | info | P-01 | After C-01 returns valid | No (milestone) | (none) | analyst | warning_count, field_count | "Config validated, 3 warnings"
config_invalid | Provisioning | error | P-01 | After C-01 returns invalid | Yes (HOME_Requests→FAILED) | HOME_Requests:PROVISIONING→FAILED | analyst | error_count, error_summary | "Config validation failed: 5 errors"
config_failed_to_parse | Provisioning | error | P-01 | After C-01 parse failure | Yes | HOME_Requests:PROVISIONING→FAILED | analyst, operator | parse_error_message | "Could not parse config file"
schema_persisted | Provisioning | info | P-01 | All CFG_* batch inserts complete | No (milestone) | (none) | operator | counts (fields, rules, lookups, variants) | "Schema loaded: 47 fields, 12 rules, 3 variants"
templates_generated | Provisioning | info | P-01 | All variant XLSX builds succeed | No (milestone) | (none) | analyst | variant_count, total_size | "3 templates generated"
templates_failed | Provisioning | error | P-01 | One or more variant builds failed | Yes | HOME_Requests:PROVISIONING→FAILED | analyst, operator | failed_variants, error_messages | "1 of 3 variant builds failed"
suppliers_bootstrapped | Provisioning | info | P-01 | Initial supplier rows created | No (milestone) | (none, multiple WFA_SupplierRequest:none→draft) | analyst | supplier_count, user_count | "5 supplier requests created"
suppliers_migrated | Provisioning | info | P-01 | Pending suppliers updated to new version | No (milestone) | (none, batch update) | analyst | migrated_count, new_supplier_count | "5 pending suppliers migrated to v3"
incumbent_data_seeded | Provisioning | info | P-01 | Incumbent file processed | No (milestone) | (none) | analyst | row_count, supplier_split_count | "Incumbent data seeded for 3 suppliers"
version_drafted | Provisioning | info | P-01 | VER_TemplateVersion row inserted | Yes | VER_TemplateVersion:none→draft | operator | template_version_id | (often skipped — implementation detail)
version_published | Provisioning | info | P-01 | VER_TemplateVersion → published | Yes | VER_TemplateVersion:draft→published | analyst | version_number, published_at | "Version 3 published for Acme-Q4"
version_deprecated | Provisioning | info | P-01 | Old version deprecated on republish | Yes | VER_TemplateVersion:published→deprecated | operator | deprecated_version_number | "Version 2 deprecated"
recipe_failed | Cross-cutting | error | any | Generic failure not covered above | Yes (HOME_Requests→FAILED) | (varies) | operator, analyst (if relevant) | failed_recipe, failed_step, error_message | "Provisioning failed in P-01 step 32"
project_closed | Provisioning | info | T-layer (future) | Project closed | Yes | HOME_Requests:ACTIVE→CLOSED | analyst | closure_reason | "Project Acme-Q4 closed"
supplier_request_created | Submission | info | P-01 | New supplier row inserted | Yes | WFA_SupplierRequest:none→draft | operator | supplier_request_id, supplier_name | "Supplier request created for Vendor X"
supplier_invited | Submission | info | P-01 or N-layer | Invitation email sent | Yes | WFA_SupplierRequest:draft→invited | analyst, supplier | invitation_sent_at, template_url | "Vendor X has been invited to submit data"
supplier_acknowledged | Submission | info | (portal) | Supplier opens invitation | Yes | WFA_SupplierRequest:invited→acknowledged | analyst | acknowledged_at | "Vendor X opened the invitation"
submission_started | Submission | info | (portal) | First data save | Yes | WFA_SupplierRequest:invited/acknowledged→in_progress | analyst | started_at | "Vendor X started filling out the template"
submission_submitted | Submission | info | (portal) | Supplier submits | Yes | WFA_SupplierRequest:in_progress→submitted | analyst | submitted_at, file_size, row_count | "Vendor X submitted their data"
submission_validation_started | Submission | info | V-01 | V-layer begins validation | No | (none) | operator | (optional, skip if fast) | "Validating Vendor X submission"
submission_validated | Submission | info | V-01 | All rules pass | Yes | WFA_SupplierRequest:submitted→validated | analyst, supplier | warning_count | "Vendor X submission validated"
submission_invalid | Submission | error | V-01 | Rules failed | Yes | WFA_SupplierRequest:submitted→invalid | analyst, supplier | error_count, error_details_ref | "Vendor X submission has 3 errors"
submission_validated_with_warnings | Submission | warn | V-01 | Hard rules pass, soft rules warn | Yes | WFA_SupplierRequest:submitted→validated | analyst | warning_count, warning_details | "Vendor X submission valid with 2 warnings"
submission_accepted | Submission | info | (analyst action or rule) | Submission accepted | Yes | WFA_SupplierRequest:validated→accepted | analyst, supplier | accepter, accepted_at | "Vendor X submission accepted"
supplier_request_closed | Submission | info | T-layer or analyst | Closure | Yes | WFA_SupplierRequest:any→closed | analyst | closure_reason | "Vendor X request closed"
supplier_request_abandoned | Submission | warn | SC-layer | Stale timeout | Yes | WFA_SupplierRequest:any→abandoned | analyst, operator | idle_duration, last_state | "Vendor X request abandoned (no activity for 30 days)"
```

Data validation on `Layer`: `Intake, Provisioning, Submission, Cross-cutting`.
Data validation on `Severity (typical)`: `info, warn, error`.

## Tab 4 — `Recipe → state changes`

Headers:

```
Recipe | Step | Machine touched | Transition | Action type | Phase to emit | Currently emitted? | Notes
```

Seed rows (focused on the recipes that exist today; future recipes can be added when built):

```
B-01 | step 7 | HOME_Requests | (none)→PENDING or REJECTED | add_record | webhook_received, webhook_validated, webhook_rejected | NO | Gap: no event emission today
B-01 | step 9 | HOME_Requests | PENDING→PROVISIONING | (none — implicit via B-02 call) | provisioning_started | NO | Should the status update happen in B-01 or B-02?
B-01 | step 11 | HOME_Requests | (none)→CONFIG_UPDATE | add_record | request_routed | NO | 
B-02 | step 12 | WFA_TemplateProject | (none)→(created) | add_record | workspace_provisioned | NO | 
B-02 | step 13 | HOME_Requests | PENDING→ACTIVE | update_record | request_marked_active | NO | 
P-01 | step 7 (error branch) | HOME_Requests | PROVISIONING→FAILED | update_record (NEW) | config_invalid or recipe_failed | NO | Critical gap — error branch needs HOME_Requests update
P-01 | step 21 | VER_TemplateVersion | (none)→draft | add_record | version_drafted (optional) | NO | 
P-01 | step 22-31 | (CFG_* tables) | inserts | create_records_batch (multiple) | schema_persisted (after all complete) | NO | Single phase after the batch completes
P-01 | step 36-46 | (variant XLSX in foreach) | (file storage) | (file ops) | templates_generated or templates_failed | NO | Aggregate after foreach
P-01 | step 49 | VER_TemplateVersion | draft→published | update_record | version_published | NO | Major milestone
P-01 | step 20 | VER_TemplateVersion | published→deprecated | update_record | version_deprecated | NO | Republish path only
P-01 | step 53 | WFA_SupplierRequest | (none)→draft | create_records_batch | supplier_request_created (per row) | NO | Bootstrap path
P-01 | step 58 | WFA_SupplierRequest | (multiple)→(updated) | update_records_batch | suppliers_migrated | NO | Republish path
P-01 | step 60 | WFA_SupplierRequest | (none)→draft | create_records_batch | supplier_request_created (per row) | NO | New suppliers on republish
P-01 | step 62 | (incumbent processing) | (varies) | call_recipe | incumbent_data_seeded | NO | If applicable
```

Data validation on `Currently emitted?`: `Yes, No, Partial`.

This tab is the wiring checklist. As you instrument U-01 calls, flip the `Currently emitted?` column from `No` to `Yes`. When all rows are Yes, instrumentation is complete.

## Tab 5 — `Open questions`

Headers:

```
Question | Affects | Status | Decision | Date decided | Notes
```

Seed rows from our conversation:

```
Does CONFIG_UPDATE transition to ACTIVE on success or stay forever as audit row? | HOME_Requests state machine | Open | | | Recommend: transition to ACTIVE on success, FAILED on failure (symmetric with new path)
Do we need an `acknowledged` state for suppliers, or skip straight to in_progress? | WFA_SupplierRequest state machine | Open | | | Depends on whether portal can detect "opened but not started"
Should `invalid` auto-revert to `in_progress`, or require explicit supplier acknowledgment? | WFA_SupplierRequest state machine | Open | | | UX decision; recommend auto-revert
Is `CLOSED` a state if T-layer doesn't exist yet? | HOME_Requests state machine | Open | | | Recommend: drop until T-layer built
Where does HOME_Requests→FAILED get written from on P-01 failure? | HOME_Requests + provisioning recipes | Open | | | Critical gap — must decide before next test session
Is `submission_validated_with_warnings` separate from `validated`, or is it just `validated` with warning_count > 0? | WFA_SupplierRequest state machine | Open | | | Recommend: same state, distinguish via warning_count
Should `version_drafted` emit a phase, or stay implementation-only? | Phase taxonomy | Open | | | Recommend: skip for analyst-facing narrative; keep for operator debugging
Should `acknowledged` state exist before `in_progress`, or fold? | WFA_SupplierRequest state machine | Open | | | Linked to portal capability question above
Where do reminder events sit — phase or just side effect? | Phase taxonomy | Open | | | Suggest: phase `supplier_reminded`, no state change
What's the relationship between PENDING/CONFIG_UPDATE rows and the project's persistent ACTIVE row? | HOME_Requests dual-purpose model | Decided | They're separate audit entries; the original ACTIVE row persists as project root | (use today's date) | Per existing ADR
```

Data validation on `Status`: `Open, Decided, Deferred`.

## Setup tips

**For the data validation:**
- Select the column.
- Data → Data validation → Criteria: List of items.
- Paste the comma-separated values.
- Hit Save.

**For frozen headers:**
- View → Freeze → 1 row.

**For filter views:**
- Data → Create a filter view.
- Save it with a descriptive name like "Gaps to fix" (filter `Currently emitted? = NO` on Tab 4).

**Worth doing immediately:** Add a header at the top of the workbook (above row 1, in a frozen row 0) saying:

> "This document is the source of truth for state machines and event phases on the SDC platform. Keep in sync with recipe changes."

Just so future-you (or anyone else) knows the artifact is canonical.

## What I'd do next

1. Paste these into a fresh workbook. Probably 30 minutes including the validation setup.
2. Read through what's there. Does it match your mental model? Where I made assumptions about your workflow (acknowledged state, abandonment, T-layer), see if you agree or want to adjust.
3. Fill in the "Open questions" tab as you go. Don't decide everything now — capture the question and move on.
4. Use Tab 4 (Recipe Cross-reference) as your instrumentation checklist when you start wiring U-01 emit calls. Filter for `Currently emitted? = NO` and that's your todo list, prioritized roughly in pipeline order.

The seed data above represents maybe 70% of what'll eventually live in this sheet. As you find new states, transitions, or phases during real work, add rows. As decisions get made on Tab 5, mark them Decided and link to whatever ADR or message captures the decision.

If you want, when this is in place, you could share read access with your testers or future collaborators. It's a much better orientation document than the recipes themselves.

Want me to draft any of the tab content differently, or is this enough to get started?
