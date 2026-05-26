# SDC Recipe Set — Collapsed Parsing Reference

Compact reference distilled from full line-level parsing of all 26 recipe JSON exports. Purpose: let a future session reason about the system without re-parsing every file. Pairs with `SDC_Build_Status.md` (the narrative status + master backlog). Where they overlap, the build-status doc wins on findings; this doc wins on structural facts.

**Reviewed line-level so far:** VAL-01, STS-01 (complete); UPL-01 (complete, findings pending fold). All others: structural + wiring review only.

---

## 1. Recipe JSON schema (how to read these files)

Top-level keys: `name`, `description`, `version`, `private`, `concurrency`, `code`, `config`.

- `code` is the **trigger** node (`keyword: "trigger"`). Its nested `block` array is the ordered step tree.
- Each step: `keyword` (`action` | `if` | `elsif` | `else` | `foreach` | `try` | `catch`), `provider`, `name`, `as` (alias — the datapill handle), `number`, `comment`, `input`, optional nested `block`.
- **Datapills** are string-embedded: `_dp('{"pill_type":"output","provider":"<prov>","line":"<alias>","path":[...]}')`. `pill_type` is `output` (another step's result), `job_context`, etc. `line` matches a step's `as`.
- **Recipe-to-recipe calls:** `provider: workato_recipe_function`, `name: call_recipe` (sync) or `call_recipe_async`. Target is at `input.flow_id.name`.
- **DB filters** live in an `input.filters` array (`field_id`, `op_default`, `value_default`) — *not* in a `where` key. (An empty `where` is normal and not a bug.)
- **Python steps:** `provider: py_eval`. Code at `input.code`; input bindings at `input.code_input` (with a `schema` sub-key listing declared field names). A missing/empty `code_input` = the script gets an empty dict at runtime (a known bug class — not present in the reviewed recipes).
- `config` lists connector providers used.

Connector provider string for the custom SDC connector: `functional_core_for_sdc_multi_workspace__connector_500787859_1778246042`.

---

## 2. Full inventory (26 recipes)

Format: **short** · trigger · version · concurrency · calls `(s)`=sync `(a)`=async. Every recipe also emits to OBS-01 unless noted; OBS-01 calls omitted below except where structurally notable.

| Short | Trigger | Ver | Conc | Calls (excl. OBS-01) |
|---|---|---|---|---|
| PRV-01 | webhook | 42 | 1 | PRV-02 (a) |
| PRV-02 | callable | 85 | 1 | CFG-01 (s), CAN-01 (s), PRV-03 (a) |
| CFG-01 | callable | 37 | 1 | — |
| CAN-01 | callable | 13 | 1 | — |
| PRV-03 | callable | 52 | 1 | PRV-04 (a) |
| PRV-04 | callable | 101 | 1 | TPL-01 (s), PRV-05 (a) |
| PRV-05 | callable | 9 | 1 | DASH-01 (s) |
| TPL-01 | callable | 50 | 1 | TPL-02 (s) |
| TPL-02 | callable | 4 | 1 | — |
| DASH-01 | callable | 29 | 1 | — |
| R-1 (Temp) | webhook | 26 | 1 | INV-01 (s) |
| INV-01 | callable | 91 | 1 | INV-01a (a), STS-01 (s) |
| INV-01a | callable | 30 | 1 | — |
| UPL-01 | DT realtime | 74 | 2 | VAL-01 (s), STS-01 (s), INV-01a (a) |
| VAL-01 | callable | 102 | 1 | — |
| STS-01 | callable | 33 | 1 | UTL-01 (s) |
| REV-01 | callable | 85 | 1 | STS-01 (s) |
| WFA-06 | WFA app-fn | 7 | 1 | REV-01 (s) |
| UTL-01 | callable | 4 | 1 | — |
| LNK-01 | WFA app-fn | 16 | 1 | — |
| OBS-01 | callable | 14 | 1 | — (sink) |
| WFA-01 | WFA app-fn | 9 | 1 | — |
| WFA-02 | WFA load-table | 18 | 1 | — |
| WFA-03 | WFA load-table | 7 | 1 | — |
| WFA-05 | WFA load-table | 14 | 1 | — |
| WFA-07 | WFA app-fn | 10 | 1 | — |

---

## 3. Dependency graph

**Provisioning chain** (one webhook, async stage-to-stage hand-off; sync sub-calls where a result is needed inline):

```
PRV-01 (webhook) --a--> PRV-02 --a--> PRV-03 --a--> PRV-04 --a--> PRV-05
                          |  \                         |            |
                       (s)|   \(s)                  (s)|         (s)|
                        CFG-01 CAN-01               TPL-01        DASH-01
                                                       |(s)
                                                     TPL-02
```

**Supplier lifecycle** (3 entry points, all converge on STS-01, the sole status writer):

```
R-1 (webhook) --s--> INV-01 --s--> STS-01(->sent)
                        \--a--> INV-01a

UPL-01 (DT realtime) --s--> VAL-01
                       --s--> STS-01(->pending_review | supplier_action_required)
                       --a--> INV-01a

WFA-06 (WFA) --s--> REV-01 --s--> STS-01(->approved | supplier_action_required)

STS-01 --s--> UTL-01   (link generation)
```

**Shared sink:** every recipe → OBS-01 (almost always async). Entry points (never called internally): PRV-01, UPL-01, WFA-06, R-1, plus the WFA read-side leaves (WFA-01/02/03/05/07, LNK-01). Graph is closed — nothing references-but-absent.

---

## 4. Per-recipe one-liners

- **PRV-01** — Provisioning entry + sole gatekeeper. Validates payload, checks project existence, **mints version number + UUIDs + FileStorage paths (version minting lives only here)**, stages config to FileStorage, creates singleton Project + CFG_TemplateVersion rows, invites analyst, async-fires PRV-02.
- **PRV-02** — Guards against unversioned `template_version_id`. Reads config from FileStorage, parses via connector, sync-calls CFG-01 (gate) + CAN-01, persists model, async-fires PRV-03.
- **CFG-01** — Pure validator. All failure modes return the same typed `{status, error_count, warning_count, checks[]}` shape.
- **CAN-01** — Smallest recipe: single Python transform in try/catch. Pure function.
- **PRV-03** — Batch-inserts EAV/config tables (CFG_Field, CFG_Rule, CFG_Lookup [foreach batch loop, >1000 rows], CFG_Variant, CFG_VariantField, CFG_FormSlotMapping, CFG_ErrorMessage). Async-fires PRV-04. *(Step-22 comment stale: says PRV-02, calls PRV-04.)*
- **PRV-04** — Heaviest. Foreach variants → sync-calls TPL-01; aborts if any fail. Initial path flips to `published`, stages SUP_Supplier/SupplierUser/SupplierRequest, async-fires PRV-05. **`is_e2` version-update branch is `::TODO::` incomplete; supplier staging only on initial branch.**
- **PRV-05** — Thin try/catch wrapper → sync-calls DASH-01. *(Catch msg typo "Dashbaord".)*
- **TPL-01** — Orchestration wrapper: version-is-draft check, variant resolution, reads canonical model, sync-calls TPL-02, handles `empty_variant`.
- **TPL-02** — Pure XLSX render: one Python step → `file_content` + filename + metadata.
- **DASH-01** — Rebuilds DASH_SuppliersStaging via truncate-and-reload from SUP_SupplierRequest + SUP_SupplierUser.
- **R-1 (Temp)** — Alpha test harness. Webhook → reads published version's requests → loops sync-calling INV-01 per request (per-iter catch), threads `analyst_email`. Not a production trigger.
- **INV-01** — 60s idempotency + `pending` precondition; partitions users into exactly 1 primary + secondaries (rejects if not exactly 1 primary); invites primary via WFA, async-fires INV-01a, loops secondaries, sync-calls STS-01→`sent`.
- **INV-01a** — Long-running task assignment (waits for resolution; no happy-path emit). Branches on `workflow_stage` (`new` vs `human review`) → creates WFA `human_review_on_existing_record` task on the right page. *(UPL-01 passes "human review" and "New" — casing match to INV-01a's comparison NOT yet verified.)*
- **UPL-01** — Submission engine. DT realtime trigger (`pending_upload_file` empty→non-empty). Eligibility guard (status ∈ {sent, supplier_action_required}, AND-logic correct), store file → FileStorage, complete WFA task, `submission_attempt++`, write RUN_Upload, sync-call VAL-01, denormalize verdict, map verdict→target_state (Python), sync-call STS-01, on success share to analyst + async INV-01a (or reassign supplier on fail).
- **VAL-01** — Loads upload + canonical model, sets RUN_Upload `validating`, extracts rows (XLSX→EAV [file] or JSON [manual]), runs connector `validate_upload` w/ cleaning, **`force_manual_review` override (step 42)**, mints validation result, writes RUN_ValidationResult + one RUN_FieldError per error, updates request, returns verdict envelope.
- **STS-01** — Hub + sole writer of status/display fields. Loads request, Python-validates (from,to,context) vs legal table (else `illegal_transition`), per-target preconditions, per-trigger derivation vars (some via UTL-01 links), writes row, returns `{success, prior_state, new_state, display_status, display_message}`.
- **REV-01** — Validates decision (approve/reject; rework needs note), maps to target_state. Approve: copy file to `/approved/`, record RUN_ReviewNote, STS-01→`approved`. Reject: record note, STS-01→`supplier_action_required`. Maps STS-01 errors back to own taxonomy.
- **WFA-06** — Thin bridge: analyst approve/reject → sync-calls REV-01.
- **UTL-01** — "Single owner of TTL knowledge." 7-day (`604800`) link → `{link, expires_at}`. Internal caller surface.
- **LNK-01** — Same 7-day link, WFA-facing (portal refresh button). Overlaps UTL-01.
- **OBS-01** — Owns event/error taxonomy in own Python. Validates `phase`, writes EventLog, returns `{event_id, timestamp}`.
- **WFA-01** ✅ — Page context (customer/supplier/analyst).
- **WFA-05** ✅ — Request's uploads + validation results for analyst review page.
- **WFA-07** ✅ — Analyst-side context, branches on whether a validation result exists.
- **WFA-02** 🔶 — Returns a list with NO data-table reads (variable + WFA connectors only). Verify it hydrates from DB.
- **WFA-03** ❌ — Reads SUP_Supplier + SUP_SupplierUser, but step 3 ("map users to suppliers, return suppliers w/o users") has NO provider/action selected — unwired placeholder.

---

## 5. STS-01 legal transition table (authoritative)

Source of truth: `sdc-state-machines-v1.md`, last synced 2026-05-08. Validator is a flat set-membership check on `(prior, target, trigger_context)`.

| from | to | trigger_context |
|---|---|---|
| _(none)_ | pending | initial_creation |
| pending | sent | invitation_issued |
| pending | cancelled | analyst_cancel |
| sent | pending_review | system_validation_passed |
| sent | supplier_action_required | system_validation_failed |
| sent | cancelled | analyst_cancel |
| supplier_action_required | pending_review | system_validation_passed |
| supplier_action_required | supplier_action_required | display_refresh (no-op) |
| supplier_action_required | cancelled | analyst_cancel |
| pending_review | approved | analyst_approve |
| pending_review | supplier_action_required | analyst_rework |
| pending_review | cancelled | analyst_cancel |

`approved` and `cancelled` are terminal. **`pipeline_error_alert` is NOT in this table** (relevant to the UPL-01 finding — see build-status backlog when folded).

Field preconditions (gate each edge, all return `precondition_failed`): `template_path` before `sent`; `current_validation_result_id` present AND linked `RUN_ValidationResult.status=="passed"` before `pending_review`; `approved_at` + `approved_path` before `approved`; `cancellation_reason` before `cancelled`.

STS-01 derivation context vars (declared step 26, fed to display Python): `due_date, invalid_row_count, validated_at, validation_report_link, review_note_text, reviewed_at, submitted_at, approved_at, analyst_email` + trigger params `target_state, trigger_context`.

---

## 6. Key column UUIDs (resolved during parsing)

These data-table column ids came up in the reviews and are tedious to re-derive:

- **SUP_SupplierRequest** (trigger/lookup alias varies; table read alias `0a085a14` in STS-01, `2d8bb1ba` trigger in UPL-01):
  - `status` = `84d52734_cdab_48c5_af42_76a3f72575e4`
  - `template_path` = `ff89e5c6_b5b9_4c72_...`
  - `current_validation_result_id` = `a4be8f3b_f894_46cb_...`
  - `approved_at` = `74ae7101_f35a_4ca6_...`
  - `approved_path` = `7b62107d_c482_4db5_...`
  - `due_date` = `28edd8d7_c5e8_4ccc_...`
  - `submission_attempt` = `3d776ce0_5e77_4827_ba28_6efef6c8a694` (integer)
  - supplier primary-user email (UPL-01 rework assignee) = `69322695_f2a3_49b6_...`
- **RUN_ValidationResult** (`run_validationresult.workato_db_table.json`):
  - `validation_result_id` (filter key) = `055bdafc_0349_4e00_b49a_1342a8027515`
  - `status` = `5e7c483d_fd53_4c66_...` (precond checks `== "passed"`)

---

## 7. Verdict → state mapping (UPL-01 step 19 Python)

```
passed                          -> pending_review,            system_validation_passed
failed | empty | structural_failure -> supplier_action_required, system_validation_failed
error (and fallback)            -> <prior_status>,            pipeline_error_alert   # <- illegal in STS-01
```

Note: `structural_failure` is handled here for state purposes but is NOT in VAL-01's `force_manual_review` rescue set (which only rescues `failed`/`empty`).

---

## 8. Reusable parser

The analyzer used for all outlines lives at `/home/claude/rx.py` (regenerable; resets between sessions). Core moves if rebuilding:
- Walk `code` recursively; render `keyword` nodes with indentation by depth.
- Decode `_dp('...')` → `«provider/line:path»` tokens; collapse `[item]` for list-projection paths.
- Recipe edges: `workato_recipe_function` + `call_recipe[_async]` → `input.flow_id.name`.
- Conditions: `input.conditions[]` with `lhs`/`operand`/`rhs`, joined by `input.operand` (and/or).
- Python: dump `input.code` + decode `input.code_input` bindings; check declared `schema` names match the script's `data.get(...)` keys.
- DB filters: read `input.filters[]`, not `where`.

Files are at `/mnt/user-data/uploads/*.json` (read-only).
