# REQ-01 — Create Supplier Request (Refactor Spec)

**Kind:** callable recipe (`workato_recipe_function.execute`)
**Domain:** Supplier Lifecycle
**Status:** DRAFT — for review against recipe JSON before build
**Invariant established:** *All `SUP_SupplierRequest` births go through REQ-01. STS-01 owns transitions; REQ-01 owns births. Nothing else writes `status`.*

> Convention: plain statements are grounded in the spec (notably `x-status-writers` and the PRV-04/SUP-01/SUP-02 recipe entries). **(inferred)** marks a reading of control flow or naming. **(decision)** marks a design choice this spec is making that is not derivable from the spec — these are the items to consciously ratify or veto.

---

## 1. Problem statement

`SUP_SupplierRequest` rows are born through three doors today, each with a different shape:

| Door | Mechanism | Birth quality |
|---|---|---|
| SUP-02 | data-table `add_record` | **Complete** — writes the full birth column set (the de facto contract) |
| SUP-01 | data-table `create_records_batch` | **Indeterminate** — batch payload is a list pill; per-column writes not statically auditable; "may set status at creation" (spec's own flag) |
| PRV-04 (~step 47) | WFA `add_request` | **Partial** — initializes the WFA plane (`workflow_stage_id`); the data-table birth columns SUP-02 would write are never set |

The system has a single-writer invariant for *transitions* (STS-01) but none for *births*. Every door improvises a birth; improvisations drift. PRV-04 has already drifted.

REQ-01 collapses the three implementations into one, using SUP-02's column set — the only complete one — as the explicit contract.

---

## 2. Request schema

```yaml
REQ-01_Request:
  type: object
  properties:
    supplier_id:
      type: string
      description: PK of SUP_Supplier. Caller must have created/resolved the supplier first — REQ-01 does NOT create suppliers.
    template_version_id:
      type: string
      description: Becomes assigned_version_id. Also the key REQ-01 uses to resolve Project context.
    variant_id:
      type: string
      description: Becomes assigned_variant_id. REQUIRED — confirmed against live SUP-02 JSON ("analyst must pick"). Default-variant resolution belongs to callers that have one (SUP-01's per-supplier default_variant_id), not to REQ-01.
    assignee_email:
      type: string
      description: The supplier user who owns the request.
    has_seeded_data:
      type: boolean
      description: Default false.
    reminders_enabled:
      type: boolean
      description: Default true. (decision — confirm the actual default SUP-02 writes)
    wfa:
      type: object
      description: WFA-plane initialization parameters.
      properties:
        workflow_stage:
          type: string
          description: Initial stage token (e.g. 'new'). Mirrors INV-01A's enumerated stage input.
        send_email:
          type: boolean
          description: Whether the WFA add_request notifies. Default false — kickoff email is INV-01's job, not birth's. (decision)
    analyst_email:
      type: string
      description: For OBS-01 enrichment on failure.
  required:
  - supplier_id
  - template_version_id
  - variant_id
  - assignee_email
```

**`template_path` is resolved by REQ-01, not caller-supplied** — confirmed pattern from live SUP-02 JSON (step 21): resolve the variant's `template_path` from `CFG_Variant` and apply the **tbd tripwire** (refuse an empty/'tbd' path with "republish the version" rather than stamping a broken path that INV-01/UTL-01 will trip over later). REQ-01 owning this means every door gets the tripwire.

**CONFIRMED birth values (from live SUP-02 step 21 — resolves former open item #2):** `status: "pending"`, `supplier_display_status: "Not yet sent"`, `supplier_message: ""`, `submission_attempt: 0`, `last_reminder_tier: 0`, `reminders_enabled: true`, `has_seeded_data: false`. Note `supplier_message` is composed but **unmapped** in current SUP-02 step 27 — add it to the contract.

**Implementation note — retain the compose-in-python pattern:** SUP-02's step 21 (compose both rows in one py_eval: guards → resolution → tripwire → row dicts) is the core of REQ-01, not a shortcut to replace. The hazard is the *seam* — the hand-wired pill mapping from python output to `add_record`, where the live SUP-02 has a status↔assignee_email mis-mapping (see §9). Mitigate with the name-parity lint rule (§7, rule 4).

**Deliberately absent:** `status`. The birth state is **not caller-selectable** — REQ-01 always writes the canonical initial state (`pending` per the STS-01 state enum *(inferred — confirm the intended birth token; SUP-02's actual written value isn't visible in the spec)*). Letting callers pick a birth state would reintroduce the drift this primitive exists to stop.

---

## 3. Response schema (canonical result envelope)

```yaml
REQ-01_Response:
  type: object
  properties:
    ok:
      type: boolean
    supplier_request_id:
      type: string
      description: PK of the created row. Populated on full AND partial success (see error_code).
    error_code:
      type: string
      description: >
        Empty on success. Otherwise one of:
        'supplier_not_found' | 'version_not_found' | 'variant_resolution_failed' |
        'duplicate_request' | 'row_create_failed' | 'wfa_create_failed'.
    error_message:
      type: string
    planes:
      type: object
      description: Per-plane outcome — the honest partial-state report.
      properties:
        data_row:
          type: string
          description: created | failed | skipped_duplicate
        wfa_task:
          type: string
          description: created | failed | not_attempted
  required:
  - ok
```

The `planes` object is the load-bearing part: REQ-01 can partially succeed (row created, WFA failed), and the envelope must say so explicitly rather than collapsing it into a boolean. `ok: false` + `data_row: created` + `wfa_task: failed` is a *healable* state, and callers (and the cleanup runbook) need to distinguish it from nothing-happened.

---

## 4. Birth-column contract

Source: `x-status-writers` → SUP-02 `add_record` `all_columns_written`. This is the de facto contract being promoted to explicit. The **Source** column is the per-column decision this spec makes — ratify or veto each. *(decision, per row, except where marked grounded)*

| Column | Source | Notes |
|---|---|---|
| `supplier_request_id` | **minted in the compose python (pre-write)** | PK. RATIFIED: `uuid.uuid4()` in the compose step (as live SUP-02 step 21 does), NOT a formula in the `add_record` pill. Pre-write minting lets one value thread through the data row, the WFA call, the duplicate-retry logic, and the envelope with no read-back; on a failed write, REQ-01 still holds the *attempted* ID for the OBS event and `planes` report. Principle: **identity is born where the row is born.** |
| `supplier_id` | input | |
| `assigned_version_id` | input (`template_version_id`) | The teardown/linchpin key — every birth carries it. |
| `assigned_variant_id` | input (required) | RATIFIED per live SUP-02: caller must supply; REQ-01 validates it against `CFG_Variant` for the version (and resolves `template_path` from the match — see §2). |
| `assignee_email` | input | |
| `status` | constant — canonical birth token | NOT caller-selectable. CONFIRMED: `pending` (live SUP-02 step 21). |
| `supplier_display_status` | constant — derived from birth status | CONFIRMED: `"Not yet sent"`. |
| `supplier_message` | constant `""` | CONFIRMED in compose; **unmapped in live SUP-02 step 27** — REQ-01 must map it. |
| `current_state_entered_at` | now() (minted in compose python) | Same pre-write minting as the PK — one timestamp, no drift between planes. |
| `submission_attempt` | constant `0` | CONFIRMED. |
| `has_seeded_data` | input, default false | CONFIRMED default. |
| `last_reminder_tier` | constant `0` | CONFIRMED. |
| `reminders_enabled` | input, default true | CONFIRMED default. |
| `template_path` | **resolved by REQ-01** from the matched `CFG_Variant` row | RATIFIED per live SUP-02: not caller-supplied. Apply the **tbd tripwire**: empty/`'tbd'` path → refuse with `variant_resolution_failed` ("republish the version"). |

The compose step returns this row as one dict whose **keys exactly match column names** — that name-parity is what lint rule 4 (§7) enforces at the compose→map seam, where the live SUP-02 bug lives.

---

## 5. Internal sequence

```
trigger: workato_recipe_function.execute
  <try>
    1. get_records SUP_Supplier        ← guard: supplier_not_found
    2. get_records CFG_TemplateVersion ← guard: version_not_found
    3. get_records CFG_Variant (for the version)
    4. get_records SUP_SupplierRequest ← duplicate check (supplier_id + version):
                                          guard: duplicate_request → return
                                          ok:false, planes.data_row: skipped_duplicate,
                                          supplier_request_id of the EXISTING row
                                          (decision — return the existing id so callers
                                          can converge instead of erroring blind)
    5. py_eval COMPOSE                 ← the heart (lifted from live SUP-02 step 21):
                                          input guards → validate variant_id against
                                          the version's CFG_Variant rows → resolve
                                          template_path + tbd tripwire →
                                          MINT supplier_request_id (uuid4) +
                                          current_state_entered_at (now) →
                                          return supplier_request_row (keys = column
                                          names) + echoes for envelope/OBS
                                          ← guard: variant_resolution_failed
    6. add_record SUP_SupplierRequest  ← THE data-plane birth: pill-map the composed
                                          row 1:1 by name (lint rule 4 enforces parity)
       on failure → ok:false, row_create_failed, planes both failed/not_attempted
                    (envelope still carries the ATTEMPTED supplier_request_id —
                    the payoff of pre-write minting)
    7. add_request (WFA)               ← THE task-plane birth (workflow_stage_id),
                                          addressed by the SAME minted id
       on failure → ok:false, wfa_create_failed,
                    planes: data_row created / wfa_task failed   ← PARTIAL, healable
       (NO rollback of step 6 — see §6)
    8. OBS-01 async (info on success; error with planes detail on any failure)
    9. return envelope
    <catch>
      OBS-01 async + return ok:false with best-known planes state
```

### §6 The ordering decision — data row first **(decision)**

Data-table row first, WFA second. Rationale: a failure between 6 and 7 leaves a **well-formed data row with no WFA task** — exactly the partial that INV-01A-style assignment can heal later, and that the cleanup probes can see (the row exists, keyed by `assigned_version_id`). The reverse order (WFA first) recreates today's PRV-04 pathology: a WFA-born row with malnourished data columns, invisible to version-keyed probes.

**No rollback on WFA failure** — REQ-01 does not delete the row it just created. Two reasons: (a) deleting/updating `SUP_SupplierRequest` risks the UPL-01 trigger (per the cleanup runbook — though a freshly-born row in birth state should fail UPL-01's entry guard, *inferred*, this is not a footgun worth arming); (b) the partial is healable forward (re-attempt WFA), which is cheaper and safer than unwinding. The envelope's `planes` object is what makes forward-healing possible.

### Idempotency

The duplicate check (step 4) keyed on `supplier_id` + `assigned_version_id` makes REQ-01 safely re-callable: a retry after `wfa_create_failed` finds the existing row, returns its id, and — *(decision, recommended)* — proceeds to re-attempt only the WFA plane if `wfa_task` was the failed plane. That single behavior turns every provisioning re-run question from "did we duplicate requests?" into "did the retry converge?" If implementing plane-aware retry in v1 is too much, the minimum viable version is: duplicate → return existing id, ok:false, skipped_duplicate, and let the caller decide. Do not silently create a second row.

---

## 6. Migration plan (per door, independently shippable)

**Order: PRV-04 → SUP-02 → SUP-01.** The broken door first; the trade-off door last. Drift stops at door one even if you pause there.

### Door 1 — PRV-04 (~step 47 foreach)
- Replace the `add_request` loop body with `call_recipe REQ-01` per supplier, passing `template_version_id`, the supplier's id, assignee, the just-published `template_path`, and `wfa.workflow_stage: new`.
- PRV-04's `SUP_Supplier` / `SUP_SupplierUser` batch creates are **unchanged** — REQ-01 owns requests only.
- Net effect: the "semi-correct partial" becomes the canonical birth immediately; PRV-04's `wfa_request_actions: add_request` entry disappears from the spec.
- Collect per-supplier envelopes; surface any `planes.wfa_task: failed` in PRV-04's error path instead of today's silence.
- **Watch:** this changes provisioning's failure surface from "WFA add_request throws inside PRV-04's try" to "REQ-01 returns a structured partial" — update the API-00 gate check accordingly.

### Door 2 — SUP-02 (activation)
- Nearly a cut-over: SUP-02 already does steps 1–5 of REQ-01's sequence; extract them, replace with `call_recipe REQ-01`, keep SUP-02's user-creation (`SUP_SupplierUser add_record`) and its INV-01 call.
- SUP-02 becomes: create user → REQ-01 → INV-01. Its response envelope maps directly (`ok`, `supplier_request_id`, `disposition`).
- **Watch:** SUP-02 currently writes the WFA plane *not at all* (no `add_request` in its actions — grounded). After migration it will. Confirm that's desired — i.e. that activation-born requests *should* get a WFA record at birth rather than at INV-01A time. *(This is a behavior change, not just a refactor. If today's INV-01→INV-01A path is what creates/advances the WFA side for activation-born requests, decide whether REQ-01's WFA step is skipped for this door (`wfa` input optional) or becomes the new normal. Recommended: make `wfa` optional, SUP-02 omits it in v1, converge later.)*

### Door 3 — SUP-01 (bulk add from configuration)
- The only door with a real trade-off: batch → loop costs N calls. At realistic supplier counts this is noise next to PRV-04's XLSX builds, but it's SUP-01's bulk path, so measure once.
- Replace the `SUP_SupplierRequest create_records_batch` with a foreach over REQ-01 (suppliers/users batches unchanged). `skipped_supplier_names` semantics map to `skipped_duplicate` envelopes.
- This retires the spec's `batch_create_indeterminate` flag — SUP-01 births become auditable for the first time.

---

## 7. Enforcement (what keeps this from drifting again)

Add to `sdc_recipe_lint.py`:
1. **Birth rule:** no recipe other than REQ-01 may `add_record` / `create_records_batch` against `SUP_SupplierRequest`.
2. **WFA-birth rule:** no recipe other than REQ-01 may call `add_request` against the SDC app.
3. **Status rule (existing, restated):** no recipe other than STS-01 (transitions) and REQ-01 (birth constant) may write `SUP_SupplierRequest.status`.
4. **Name-parity rule (NEW — would have caught the live SUP-02 bug):** for every `add_record` / `update_record`, the pill path's last element must equal the target column's label (uuid→name resolved from table definitions). Flags any column fed by a differently-named source field.
5. **PK-minting rule (NEW):** no `add_record` against `SUP_SupplierRequest` may bind the PK column to a trigger/caller input — only to a locally minted value (py_eval output or formula). Enforcement form of *identity is born where the row is born.*

The spec regenerator should then show `SUP_SupplierRequest.written_by` births = `[REQ-01]` only — that diff is the acceptance check for the whole refactor.

---

## 8. Explicitly out of scope

- INV-01-inline vs INV-USER duplication — real, separate decision, do not bundle.
- A generic "two-plane writer" abstraction — no second consumer exists; don't build it.
- Supplier/user creation — stays with current owners.
- Any change to STS-01.

---

## 9. Open items before build

0. **URGENT, independent of REQ-01 — fix the live SUP-02 mapping bug:** step 27 binds column `84d52734…` (**status**) to `supplier_request_row.assignee_email` instead of `.status`. Every activation-born request gets an email address as its state token (free-text column, nothing catches it; surfaces later as STS-01 transition failures). One-pill fix. Also map the currently-unmapped `supplier_message`, and **audit existing rows** for `status` containing `@` — those are stalled activation-born requests needing repair.
1. ~~Diff §4 against live SUP-02 recipe JSON~~ **DONE** — contract confirmed; `supplier_message` added (composed but unmapped today).
2. ~~Confirm the canonical birth `status` token~~ **DONE** — `pending` / `"Not yet sent"` / `submission_attempt 0` / `last_reminder_tier 0` / `reminders_enabled true` / `has_seeded_data false`, from live step 21.
3. **Ratify the remaining (decision) items:** data-first ordering + no rollback; `wfa` optional (for SUP-02's door); duplicate returns existing id; plane-aware retry in v1 or deferred. (RATIFIED: PK + timestamp minted in the compose python, pre-write; `variant_id` required; `template_path` resolved by REQ-01 with the tbd tripwire.)
4. **Confirm UPL-01's entry guard ignores birth-state rows** — required for the no-rollback stance to be fully safe.
5. **SUP-02 WFA behavior change** (Door 2 watch item) — decide before, not during, migration.
6. **Implement lint rule 4 (name-parity) before migrating any door** — it's the regression guard for the compose→map seam REQ-01 inherits from SUP-02.
