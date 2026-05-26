# SDC Platform — Build Status

**Scope:** 26 Workato recipes (Supplier Data Collection), reviewed from recipe JSON exports.
**Date:** 2026-05-26
**Method:** Static read of trigger types, step trees, recipe-to-recipe calls, and embedded Python/connector steps. This is a descriptive snapshot, not a code audit — line-level logic was spot-checked, not exhaustively verified.

---

## 1. Executive summary

The platform is past scaffolding. Two complete, fully-wired flows exist end to end:

- **Initial-version provisioning** — `PRV-01 → PRV-02 → PRV-03 → PRV-04 → PRV-05`, with `CFG-01`, `CAN-01`, `TPL-01/TPL-02`, and `DASH-01` all present. A template can be provisioned, validated, hydrated into the CFG/EAV tables, rendered to XLSX, published, and staged into the dashboard.
- **Supplier happy-path round-trip** — invite (`R-1 → INV-01`), upload + validate (`UPL-01 → VAL-01`), advance state (`STS-01`), and approve/rework (`WFA-06 → REV-01`). All three runtime entry points converge on `STS-01`, the single writer of request status/display fields, which enforces a documented transition table.

Cross-cutting strengths: `OBS-01` gives uniform event/error logging across every recipe; state writes are centralized in `STS-01`; the build shows consistent return-contract discipline and clean separation of concerns (orchestration vs. pure transforms).

The remaining work is concentrated and identifiable:

1. **PRV-04 version-update branch is unfinished** (explicit `::TODO::`) — re-publishing a v2 template is unsupported.
2. **WFA-03 has an unwired step** and **WFA-02 has no DB reads** — both degrade the analyst-facing UI, not the pipeline.
3. **R-1 is a temporary harness** — the production invitation trigger has no permanent home yet.

Alpha-test behavior ("all submissions go to the analyst") is produced by `VAL-01`'s config-driven `force_manual_review` flag, not a code stub.

---

## 2. Architecture at a glance

The system is two pipelines plus a shared event sink.

**Entry points (4):**

| Recipe | Trigger | Role |
|---|---|---|
| `PRV-01` | Webhook | Provisioning request received |
| `UPL-01` | Data Tables realtime | Supplier file upload detected (`pending_upload_file` empty→non-empty) |
| `WFA-06` | WFA app-function | Analyst clicks approve/reject |
| `R-1 (Temp)` | Webhook | **Temporary** manual trigger for invitations |
| `LNK-01` | WFA app-function | Portal "refresh link" button (standalone utility) |
| `WFA-01/02/03/05/07` | WFA app-fn / load-table | Read-side page/table hydration |

**Handoff conventions observed:**

- **Async `call_recipe_async`** advances the provisioning chain stage-to-stage (fire-and-forget; no stage blocks on its successor) and emits every `OBS-01` event.
- **Sync `call_recipe`** is used when the caller needs the result inline (validation verdicts, rendered files, state transitions, link generation).
- **FileStorage snapshots** are the handoff medium for large artifacts (config JSON → parsed config → canonical model → extracted rows).
- **`OBS-01`** is called (almost always async) by nearly every recipe as the single observability sink.

---

## 3. Recipe inventory

Status legend: ✅ complete · ⚠️ complete (initial path only) · 🔶 thin / verify · ❌ unfinished · 🧪 temporary (test scaffold)

| Recipe | Trigger | Ver | Calls (excl. OBS-01) | Status |
|---|---|---|---|---|
| PRV-01 Provisioning webhook | webhook | 42 | PRV-02 | ✅ |
| PRV-02 Parse config & build canonical model | callable | 85 | CFG-01, CAN-01, PRV-03 | ✅ |
| CFG-01 Validate config | callable | 37 | — | ✅ |
| CAN-01 Build canonical model | callable | 13 | — | ✅ |
| PRV-03 Hydrate CFG tables | callable | 52 | PRV-04 | ✅ |
| PRV-04 Publish template version | callable | 101 | TPL-01, PRV-05 | ⚠️ version-update branch is `::TODO::` |
| PRV-05 Initialize engagement dashboard | callable | 9 | DASH-01 | ✅ (thin wrapper) |
| TPL-01 Build XLSX template | callable | 50 | TPL-02 | ✅ |
| TPL-02 Build XLSX | callable | 4 | — | ✅ |
| DASH-01 Dashboard synchronization | callable | 29 | — | ✅ |
| R-1 (Temp) | webhook | 26 | INV-01 | 🧪 temporary harness |
| INV-01 Invite supplier users | callable | 91 | INV-01a, STS-01 | ✅ |
| INV-01a Assign task to user in WFA | callable | 30 | — | ✅ |
| UPL-01 File submission intake | DT realtime | 74 | VAL-01, STS-01, INV-01a | ✅ |
| VAL-01 Validate supplier input | callable | 102 | — | ✅ |
| STS-01 Status-change handler | callable | 33 | UTL-01 | ✅ |
| REV-01 Analyst review handler | callable | 85 | STS-01 | ✅ |
| WFA-06 Record human approval | WFA app-fn | 7 | REV-01 | ✅ |
| UTL-01 Generate shareable link | callable | 4 | — | ✅ |
| LNK-01 Generate download link | WFA app-fn | 16 | — | ✅ |
| OBS-01 Event emitter | callable | 14 | — | ✅ |
| WFA-01 Hydrate WFA page with context | WFA app-fn | 9 | — | ✅ |
| WFA-05 Load uploads to analyst review page | WFA load-table | 14 | — | ✅ |
| WFA-07 Hydrate WFA with analyst context | WFA app-fn | 10 | — | ✅ |
| WFA-02 Hydrate supplier input context table | WFA load-table | 18 | — | 🔶 no DB reads — verify |
| WFA-03 Hydrate invite suppliers (analyst) | WFA load-table | 7 | — | ❌ unwired mapping step |

---

## 4. Provisioning chain

Linear pipeline kicked off by one webhook; each stage hands off asynchronously to the next, with synchronous sub-calls where a result is needed inline.

`PRV-01` (webhook) → `PRV-02` → `PRV-03` → `PRV-04` → `PRV-05`

- **PRV-01** — Entry + sole gatekeeper. Validates payload, checks project existence, **mints the version number, UUIDs, and FileStorage paths** (version minting lives only here), stages config to FileStorage, creates the singleton Project row + CFG_TemplateVersion row, invites the analyst, then async-fires PRV-02.
- **PRV-02** — Guards against being called with an unversioned `template_version_id`. Reads config from FileStorage, parses via the SDC connector, sync-calls **CFG-01** (validation gate) and **CAN-01** (canonical model), persists the model, then async-fires PRV-03.
- **CFG-01** — Pure validator. All failure modes return the same typed `{status, error_count, warning_count, checks[]}` shape rather than throwing.
- **CAN-01** — Smallest recipe: a single Python transform in try/catch. Pure function, no side effects beyond catch-path event emission.
- **PRV-03** — Batch-inserts the EAV/config tables (CFG_Field, CFG_Rule, CFG_Lookup, CFG_Variant, CFG_VariantField, CFG_FormSlotMapping, CFG_ErrorMessage). CFG_Lookup is wrapped in a foreach batch loop because lookups routinely exceed 1000 rows. Async-fires PRV-04.
- **PRV-04** — Heaviest stage (most-iterated, v101). Foreach over variants sync-calls **TPL-01** to render each XLSX; aborts if any fail. On the initial path it flips status to `published` and stages SUP_Supplier / SUP_SupplierUser / SUP_SupplierRequest, then async-fires PRV-05. **The `is_e2` version-update / deprecation branch is explicitly incomplete (`::TODO::`)**, and supplier staging runs only on the initial branch.
- **PRV-05** — Thin try/catch wrapper that sync-calls **DASH-01** and emits.

---

## 5. Supplier lifecycle

Three independent entry points, all converging on `STS-01`.

**Invitation:** `R-1` (temp) → `INV-01` → `INV-01a` (async task assignment) + `STS-01` (→ `sent`).
`INV-01` enforces 60-second idempotency and the `pending` precondition, partitions users into exactly one primary + secondaries, invites via WFA, and tracks per-user disposition.

**Submission:** `UPL-01` (DT realtime) → `VAL-01` (sync) → `STS-01` (sync) → `INV-01a` (async).
`UPL-01` guards eligibility (status must be `sent` or `supplier_action_required`), bridges the file into FileStorage, writes a RUN_Upload row, runs validation, maps the verdict to a target state, transitions, then routes the request to the analyst (on pass) or back to the supplier (on fail).
`VAL-01` extracts rows (XLSX→EAV for file mode, JSON for manual), runs the SDC connector's `validate_upload`, writes RUN_ValidationResult + one RUN_FieldError per error, and returns the verdict envelope.

**Review:** `WFA-06` (analyst UI) → `REV-01` → `STS-01`.
`REV-01` validates the decision, and on approve copies the submitted file to an `/approved/` path and records a review note before transitioning to `approved`; on reject it transitions to `supplier_action_required` (rework).

---

## 6. STS-01 state machine

`STS-01` is the single writer of `status`, `supplier_display_status`, and `supplier_message`. Every transition is validated against the table below (source of truth: `sdc-state-machines-v1.md`, last synced 2026-05-08). Illegal tuples are rejected with `illegal_transition`; per-target field preconditions gate each edge.

| From | To | Trigger context |
|---|---|---|
| _(no row)_ | pending | initial_creation |
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

`approved` and `cancelled` are terminal (no outbound transitions). Field preconditions enforced before transition: `template_path` before `sent`; a passed `current_validation_result_id` before `pending_review`; `approved_at` + `approved_path` before `approved`; `cancellation_reason` before `cancelled`.

---

## 7. Shared infrastructure & utilities

- **OBS-01** — Owns the event/error taxonomy in its own Python (deliberately self-contained, no external taxonomy dependency). Validates `phase`, writes EventLog, returns `{event_id, timestamp}`.
- **UTL-01** — "Single owner of TTL knowledge." Generates a 7-day (`604800`) download link; returns `{link, expires_at}`. Called internally (e.g. by STS-01).
- **LNK-01** — Same 7-day link generation, WFA-facing (portal refresh button). Overlaps with UTL-01; differs only by caller surface.
- **TPL-01 / TPL-02** — Orchestration wrapper (precondition checks, variant resolution) vs. pure XLSX render. Clean split.
- **DASH-01** — Rebuilds `DASH_SuppliersStaging` via truncate-and-reload from SUP_SupplierRequest + SUP_SupplierUser.

---

## 8. Read-side (WFA hydration)

All WFA-triggered leaves that feed portal pages; none call other recipes except OBS-01.

- **WFA-01** ✅ — Page context (customer / supplier / analyst).
- **WFA-05** ✅ — A request's uploads + validation results for the analyst review page.
- **WFA-07** ✅ — Analyst-side context, branching on whether a validation result exists.
- **WFA-02** 🔶 — Declares a list and returns it with **no data-table reads** (connectors are variable + WFA only). Either intentionally input-driven or a placeholder — verify it actually hydrates from the DB.
- **WFA-03** ❌ — Reads SUP_Supplier + SUP_SupplierUser, but its third step ("map supplier users to suppliers, return suppliers without users") has **no provider/action selected** — an unwired placeholder. The analyst "invite suppliers" table will not render its core data until this is completed.

---

## 9. Test / alpha configuration

- **`VAL-01` `force_manual_review`** (Project-level flag, step 42): when true and the verdict is `failed` or `empty`, the verdict is overwritten to `passed`, routing the submission to `pending_review` (the analyst queue) regardless of validation outcome. This is the mechanism that "passes all results to the analyst" for the analysts-as-suppliers alpha. **Caveat:** it only rescues `failed`/`empty` — a `structural_failure` (unparseable XLSX) or engine `error` still will not pass.
- **`R-1 (Temp)`** — Manual webhook that batch-invites supplier users for a published version. Test scaffold; not a production trigger.

---

## 10. Master backlog

Single consolidated list across the whole build: structural/wiring findings (the four chains) plus the line-level findings from the `VAL-01` / `STS-01` review (§ tags **[VS]**). Severity order. The summary table is the index; the detail subsections below carry the specifics and proposed fixes.

| # | Severity | Item | Recipe | Impact |
|---|---|---|---|---|
| 1 | **Blocker** | Version-update / deprecation branch incomplete | PRV-04 | Re-publishing a v2 template unsupported |
| 2 | **Functional** | Unwired mapping step | WFA-03 | Analyst "invite suppliers" table won't render data |
| 3 | **Functional** | `submission_attempt` null-write **[VS]** | VAL-01 | Resubmission counter never accumulates past 1 |
| 4 | **Functional** | Raw timestamps in supplier-facing messages **[VS]** | STS-01 | Suppliers see ISO timestamps, not friendly dates |
| 5 | **Verify** | No DB reads in hydration recipe | WFA-02 | Possibly returns empty/placeholder table |
| 6 | **Verify** | `RUN_FieldError` drops `strict` / `source` **[VS]** | VAL-01 | Error report can't distinguish blocking vs. warning |
| 7 | **Cleanup** | Dead block (steps 23–25) **[VS]** | STS-01 | Wasted DB read + redundant link generation per failed validation |
| 8 | **Robustness** | `data_only=True` returns cached formula values **[VS]** | VAL-01 | Silently-blank cells from some supplier workbooks |
| 9 | **Robustness** | Exact, case-sensitive header matching **[VS]** | VAL-01 | Fragile if a supplier retypes a header |
| 10 | **Process** | Temporary invitation trigger | R-1 | No production path to start invitations |
| 11 | **Consistency** | Link TTL (7-day) vs. planned reminder TTL | UTL-01 / LNK-01 | Reconcile if reminder workflow assumes 10 days |
| 12 | **Consistency** | Duplicate link generation | UTL-01 + LNK-01 | Maintenance overlap (two surfaces) |
| 13 | **Known limit** | `force_manual_review` rescues only `failed`/`empty` **[VS]** | VAL-01 | Structural/engine errors still don't reach the analyst |
| 14 | **Cosmetic** | Manual-mode parser asymmetry **[VS]** | VAL-01 | `content` passed through as `rows_json`; missing `error_code` |
| 15 | **Cosmetic** | Duplicated derivation message string **[VS]** | STS-01 | DRY nit; comment already acknowledges it |
| 16 | **Cosmetic** | Stale comment | PRV-03 | Step 22 says "call PRV-02" but correctly calls PRV-04 |
| 17 | **Cosmetic** | "Dashbaord" typo | PRV-05 | Catch-branch error message |

### Detail

**1 — PRV-04 version-update branch incomplete (Blocker).** Explicit `::TODO::` on the `is_e2` branch; supplier staging runs only on the initial-version branch. Re-publishing a v2 of a template hits incomplete logic. This is the one gap inside an otherwise-complete chain.

**2 — WFA-03 unwired mapping step (Functional).** Reads SUP_Supplier + SUP_SupplierUser, but its third step ("map supplier users to suppliers, return suppliers without users") has no provider/action selected — an unwired placeholder. The analyst "invite suppliers" table won't render its core data until completed.

**3 — VAL-01 `submission_attempt` null-write (Functional).** The `SUP_SupplierRequest` update (step 14, alias `a7703a9f`) binds `submission_attempt` to a bare `=` (empty formula → null), clobbering the counter `UPL-01` increments one step earlier. *Fix:* remove `submission_attempt` from VAL-01's update mapping — `UPL-01` owns that field.

**4 — STS-01 raw timestamps in supplier messages (Functional).** The derivation step string-coerces `invalid_row_count` but passes the five `date_time` fields (`due_date`, `validated_at`, `reviewed_at`, `submitted_at`, `approved_at`) into `str.format()` unformatted, so suppliers likely see an ISO timestamp instead of a friendly date. *Fix:* format the dates inside the derivation step, where the substitution context already lives.

**5 — WFA-02 no DB reads (Verify).** Declares a list and returns it with no data-table reads (connectors are variable + WFA only). Either intentionally input-driven or a placeholder — verify it actually hydrates from the DB; wire up the lookup if not.

**6 — VAL-01 `RUN_FieldError` drops `strict` / `source` (Verify).** The connector returns eight fields per error and `verdict_errors` carries all eight, but the batch insert persists only five — dropping `field_name` (derivable from `field_id`, fine), `strict` (hard vs. soft/warning), and `source` (structural vs. field-level). Confirm the table schema omits `strict`/`source` deliberately; otherwise the error report can't distinguish blocking errors from warnings.

**7 — STS-01 dead block, steps 23–25 (Cleanup).** A redundant `RUN_ValidationResult` lookup plus a UTL-01 shareable-link generation for `system_validation_failed`; the generated link is referenced nowhere, and the real work is the 35–38 block (which correctly covers both `system_validation_failed` and `display_refresh`). The dead block's condition is also narrower than its own comment claims. *Fix:* delete steps 23–25.

**8 — VAL-01 `data_only=True` cached values (Robustness).** Correct for resolving formulas, but a supplier workbook saved by a tool that doesn't persist cached results yields `None` for formula cells — surfacing as silently-blank data, not an error.

**9 — VAL-01 exact header matching (Robustness).** Missing-header detection is `fn not in headers` after `.strip()`. Whitespace is handled, but a header differing in case or carrying a stray Unicode character won't match. Fine for system-generated templates; fragile if a supplier retypes one.

**10 — R-1 temporary invitation trigger (Process).** Manual webhook standing in for production invitation triggering. Replace with a provisioning-completion hook, schedule, or analyst action.

**11 — UTL-01 / LNK-01 link TTL (Consistency).** Both mint 7-day links (`expires_in=604800`). If the planned reminder workflow assumes a 10-day TTL, reconcile the two.

**12 — UTL-01 + LNK-01 duplicate link generation (Consistency).** Same logic on two surfaces (internal callable vs. WFA app-function). Acceptable, but a candidate for consolidation.

**13 — `force_manual_review` rescue scope (Known limit).** The override flips the verdict to `passed` only when it's `failed` or `empty`. A `structural_failure` (unparseable XLSX) or engine `error` still routes to `supplier_action_required`, not the analyst — relevant so a genuinely broken upload in the alpha isn't mistaken for a routing bug.

**14 — VAL-01 manual-mode parser asymmetry (Cosmetic).** Returns the input `content` straight through as `rows_json` (could carry a bytes object into a string field) and omits the `error_code` the file-mode path includes.

**15 — STS-01 duplicated derivation message (Cosmetic).** The `system_validation_failed` and `display_refresh` derivation rows repeat the same full message string rather than aliasing; the code comment already acknowledges it.

**16 — PRV-03 stale comment (Cosmetic).** Step 22 comment says "call PRV-02 to publish" but correctly calls PRV-04.

**17 — PRV-05 "Dashbaord" typo (Cosmetic).** Catch-branch error message.

> **Reviewed and clean (VAL-01 / STS-01 line-level pass):** both VAL-01 Python extractors (XLSX→EAV and manual JSON), the connector call and `verdict_errors` projection, the `RUN_ValidationResult` / `RUN_Upload` / return writes; STS-01's transition validator and derivation Python, all four target-state preconditions, and the validation-result lookups (correctly filtered by `validation_result_id` — an earlier empty-`where` concern was a false alarm; this connector filters via a `filters` array). The items above are the exceptions, not a verdict on the recipes.

---

## 11. Appendix — version maturity & conventions

**Iteration depth** (recipe version as a proxy for churn): the most-worked recipes are the validation/publish core — `VAL-01` (v102), `PRV-04` (v101), `INV-01` (v91), `PRV-02` / `REV-01` (v85), `UPL-01` (v74). The youngest cluster on the periphery — `TPL-02` (v4), `UTL-01` (v4), `WFA-06` (v7), `WFA-03` (v7), `PRV-05` (v9), `WFA-01` (v9), `WFA-07` (v10). This is the signature of a core-first build now filling in its edges, which matches what's unfinished.

**Conventions observed across the build:**

- One callable recipe per responsibility, with typed `result_schema_json` return contracts.
- Provisioning as "hydrate data," not "create infrastructure."
- FileStorage snapshots as the inter-recipe handoff for large artifacts.
- Centralized state transitions (STS-01) and centralized observability (OBS-01).
- Defensive boundary coding in Python steps (e.g. duck-typed boolean coercion mirroring the Ruby SDK's `is_true?`).
- Consistent failure pattern: emit an `OBS-01` event, then return a typed result — rather than throwing.

---

*Generated from a static review of recipe exports. The line-level pass on `VAL-01` and `STS-01` is complete (findings folded into the §10 master backlog, tagged **[VS]**); the other 24 recipes have had structural and wiring review but not a full line-level read. The natural next targets for that deeper pass are the recipes that own the most state writes and external calls — `UPL-01`, `REV-01`, and `PRV-04` (whose version-update branch is the one known-incomplete path).*
