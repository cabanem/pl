# SDC Implicit State Machines — A Catalog-Driven Analysis

**Purpose.** Use the recipe catalog (24 recipes, 493 steps) and the
data model (23 tables) as empirical evidence to enumerate every state
machine that *implicitly* exists in the SDC platform — not just the
ones already captured in the state-machine workbook.

**Companion to.** The starter workbook from your prior conversation
(`States` / `Transitions` / `Phases` / `Recipe → state changes` /
`Open questions`). This analysis validates, corrects, and *extends*
the seed data using catalog evidence.

---

## Headline findings

1. **There are eight real state machines, not three.** The seed sheet
   captures `HOME_Requests`, `VER_TemplateVersion`, and (incorrectly,
   as registry-only) `WFA_TemplateProject`. The other five are
   implicit but unmistakable in the data model:

   - `WFA_TemplateProject.project_completion_status` (the seed sheet
     misclassified this table as state-free; it has `active|inactive`
     and recipes filter on it).
   - `WFA_SupplierUser.status` (`active|deactivated`).
   - `RUN_Upload.status` (`received|extracting|validating|validated|failed`).
   - `RUN_ValidationResult.status` (`running|passed|failed|error`).
   - `HOME_WorkspaceRegistry.status` (`AVAILABLE|UNAVAILABLE`).

2. **Five recipes write status values that aren't in the data model
   enum.** This is a contract drift between the data model and the
   recipes. Concrete cases:

   | Table | Field | Enum says | Recipes also write |
   |---|---|---|---|
   | WFA_SupplierRequest | status | `pending, sent, in_progress, submitted, validated, accepted, rejected` | `supplier_action_required` (V-02 #17), `validation_success` (V-02 #21), `data_entry` (RW-01 #21) |
   | RUN_ValidationResult | status | `running, passed, failed, error` | `superseded` (RW-01 #12) |

   Workato Data Tables don't enforce enums at write time, so this
   silently accumulates. Either the enum hints in the source schema
   are stale, or the recipes drifted and need rationalization. Either
   way, the seed sheet's Tab 1 should reflect what *actually happens*,
   not what the enum *claims*.

3. **Three states are declared but never written by any recipe.**
   `RUN_Upload.extracting`, `RUN_Upload.validated`, and
   `WFA_SupplierUser.deactivated` exist as enum values but no recipe
   in the set transitions an entity into them. This may be by design
   (manual processes), or vestigial, or genuine gaps. Worth deciding
   per-machine.

4. **`HOME_WorkspaceRegistry` has zero recipe coverage.** Either it's
   set up out of band, or it's vestigial. Confirm before relying on
   the seed sheet's intuition that it participates in the lifecycle.

---

## State machine inventory

For each machine: states from the data model, states empirically
observed in recipe writes, transitions with catalog evidence (recipe
+ step), and gaps.

### 1. `HOME_Requests.status` — request lifecycle

**Data model enum.** `PENDING | PROVISIONING | ACTIVE | FAILED | CLOSED`.

**Recipe evidence (from step summaries).**

| Recipe | Step | Op | Effect on status (per comment) |
|---|---|---|---|
| B-01 | 8 | INSERT | `rejected` (the seed sheet's `REJECTED` state — note casing) |
| B-01 | 13 | INSERT | new request row (initial value not stated; presumably `pending`) |
| B-01 | 17 | INSERT | "Use existing request data where applicable" (republish path) |
| B-02 | 13 | UPDATE | `active` (seed sheet's `ACTIVE`) |
| B-02 | 19 | UPDATE | "Update status and error_reason" — the failure path; value unstated, presumably `failed` |
| P-01 | 10 | UPDATE | unspecified — likely `provisioning` or `active`; needs source inspection |

**Catalog confirms vs. seed-sheet revisions.**

- ✅ The seed's `PENDING` initial state is correct (B-01 inserts).
- ✅ The seed's `REJECTED` state is correct (B-01 #8 explicitly).
- ✅ The seed's `PENDING → ACTIVE` (via B-02 #13) is correct.
- 🆕 **The seed says "FAILED is a gap — no recipe writes this."
  Catalog disagrees.** B-02 #19 has an UPDATE explicitly described as
  "status and error_reason" — this is a failure path. The seed's
  Tab 4 row for `B-02 step 13 → ACTIVE` should get a *sibling* row
  for `B-02 step 19 → FAILED`. (Whether the catalog summary is
  trustworthy on the value is a separate question — please confirm.)
- ❓ The seed's `CONFIG_UPDATE` state isn't a real state — it's a
  routing decision in B-01. The data model has no such enum value.
  The seed sheet itself notes this is an "audit row" pattern; that's
  worth keeping as a *concept* but not promoting to a state.
- ❓ `CLOSED` is declared but no recipe writes it. Per your manifest:
  "T-layer not yet built." Mark it as future-state in the seed.

**Transitions per catalog:**

```
                      (B-01 #8)
                        │
                        ▼
   (B-01 #13)     ┌──────────┐
   (B-01 #17) ───▶│ rejected │  (terminal)
        │         └──────────┘
        ▼
   ┌─────────┐    (B-02 #13)    ┌────────┐
   │ pending │ ──────────────▶  │ active │
   └────┬────┘                  └────────┘
        │                            │
        │       (B-02 #19)           │  (P-01 #10? — TBD)
        └────────────┬───────────────┘
                     ▼
                ┌────────┐
                │ failed │   (presumed; verify value written)
                └────────┘
```

### 2. `VER_TemplateVersion.status` — template versioning

**Data model enum.** `draft | published | deprecated`.

**Recipe evidence.**

| Recipe | Step | Op | Effect |
|---|---|---|---|
| P-01 | 22 | UPDATE | "Deprecate old version" → `published → deprecated` |
| P-01 | 23 | INSERT | `status = 'draft'` (explicit in comment) |
| P-01 | 51 | UPDATE | "Publish template version" → `draft → published` |
| P-02b | 8 | SELECT | reads (no transition) |
| P-03a | 2 | SELECT | reads (no transition) |
| WFA-05c | 7 | SELECT | reads (no transition) |

**Conclusion: the seed sheet for this machine is fully accurate.**
Every transition in the seed has a matching catalog step. The seed's
note "Invariant: at most one per template_project_id" cannot be
verified by the catalog (it's a semantic invariant, not a transition)
but is well-stated.

**Transitions:**

```
   (P-01 #23)      (P-01 #51)         (P-01 #22, on republish)
        │              │                       │
        ▼              ▼                       ▼
   ┌───────┐      ┌───────────┐         ┌────────────┐
   │ draft │ ──▶  │ published │ ────▶   │ deprecated │
   └───────┘      └───────────┘         └────────────┘
                                          (terminal)
```

### 3. `WFA_TemplateProject.project_completion_status` — project active/inactive

**Data model enum.** `active | inactive`.

**Recipe evidence.**

| Recipe | Step | Op | Effect |
|---|---|---|---|
| B-02 | 12 | INSERT | creates row (initial value: presumably `active`) |
| P-01 | 19 | UPDATE | writes `parsed_config_file_id` — status not mentioned |
| WFA-05a | 1 | SELECT | filters where `project_completion_status = 'active'` |
| (others) | various | SELECT | reads only |

**Seed sheet was wrong about this table.** It described
`WFA_TemplateProject` as "barely a state machine" with "no status
field that I'm aware of." The data model says otherwise: there's a
real `project_completion_status` field, and `WFA-05a` actively
filters on it. **No recipe in this set transitions to `inactive`** —
that's either manual or a gap.

This is a small but real state machine that should be added to the
seed sheet's Tab 1. Recommended seed-sheet entry:

```
WFA_TemplateProject | active   | Project is operational | No  | B-02 step 12 inserts row | indefinite | template_project_id, project_name | Default state on creation
WFA_TemplateProject | inactive | Project closed or paused | Yes | (no recipe writes today) | indefinite | template_project_id | Gap: no automated transition
```

### 4. `WFA_SupplierRequest.status` — supplier lifecycle (the busiest)

**Data model enum.** `pending | sent | in_progress | submitted | validated | accepted | rejected`.

**Empirical states (what recipes actually write).** These differ from
the enum:

- `pending` (presumed initial; P-01 #55 INSERT)
- `sent` (P-03a #14 — invitation dispatched)
- `data_entry` (RW-01 #21 — explicit; **not in enum**)
- `supplier_action_required` (V-02 #17 — explicit; **not in enum**)
- `validation_success` (V-02 #21 — explicit; **not in enum**)
- (WFA-06a #6 writes a status, value not in summary — analyst approval path)

**Recipe evidence (full).**

| Recipe | Step | Op | Effect (per comment) |
|---|---|---|---|
| P-01 | 55 | INSERT | "Batch create records" — initial state |
| P-01 | 61 | UPDATE | "Update existing configuration for suppliers who haven't started" (republish path) |
| P-01 | 63 | INSERT | "Update existing configuration for suppliers who haven't started" — yes the comment is the same; this is the new-supplier branch on republish |
| P-02b | 22 | UPDATE | "Add new file path to the record" — non-status update |
| P-03a | 14 | UPDATE | `status = 'sent'` |
| RW-01 | 20 | UPDATE | "Regenerated links written to request record" |
| RW-01 | 21 | UPDATE | `status = 'data_entry'` for resubmission |
| V-02 | 17 | UPDATE | `status = 'supplier_action_required'` (validation failed) |
| V-02 | 21 | UPDATE | `status = 'validation_success'` (validation passed) |
| WFA-06a | 6 | UPDATE | "Update with new status, approval file ID" — value unstated |

**This is the vocabulary mismatch in concentrated form.** The seed
sheet has 9 conceptual states (`draft, invited, acknowledged,
in_progress, submitted, validated, invalid, accepted, closed,
abandoned`). The data model has 7. The recipes empirically write 5+,
and only `pending` and `sent` align with the enum.

**My recommendation:** before populating the seed sheet's Tab 1 for
this machine, **do the rationalization first**. Either:

- **(a)** Update the data model enum hint to reflect what recipes
  actually write, then update the seed sheet to match; or
- **(b)** Refactor the recipes to emit canonical state names, then
  the seed and the data model already align.

Option (b) is the right long-term move (less drift), but option (a)
is the right immediate move (lower risk, captures current reality).
Either way, the seed sheet's Tab 1 should *not* claim the 9 states
without evidence — that's aspiration, not reality.

**Probable mapping** (subject to your judgment):

| Seed-sheet conceptual state | Empirical status value | Notes |
|---|---|---|
| `draft` | (initial state, value `pending`?) | The seed says "Brief; transitions to invited same-recipe" — confirm whether P-01 #55 writes `pending` or no value |
| `invited` | `sent` | P-03a #14 writes `sent`; the seed's `invited` is a clean rename |
| `acknowledged` | (not written by any recipe) | Seed's open question; depends on portal |
| `in_progress` | `data_entry`? | RW-01 resets to this; possibly the working state for active filling |
| `submitted` | (not written explicitly in this set) | Likely written by WFA-04* /WFA-03* on submission action |
| `validated` | `validation_success` | V-02 #21 writes this; rename likely |
| `invalid` | `supplier_action_required` | V-02 #17 writes this on validation failure |
| `accepted` | (WFA-06a #6, value unstated) | Analyst approval path |
| `rejected` | (no recipe writes this) | Enum has it; may be vestigial |
| `closed` | (no recipe writes) | Future T-layer |
| `abandoned` | (no recipe writes) | Future SC-layer |

### 5. `RUN_Upload.status` — validation pipeline (NEW machine)

**Data model enum.** `received | extracting | validating | validated | failed`.

**Recipe evidence.**

| Recipe | Step | Op | Effect |
|---|---|---|---|
| WFA-03b | 11 | INSERT | "Create a new row" — initial state (presumably `received`) |
| WFA-03b | 20 | UPDATE | conditional: `validating` or `failed` |
| WFA-04c | 14 | INSERT | initial state from form path |

**Two states never written.** `extracting` and `validated` exist in
the enum but no recipe transitions an upload into them. Possible
explanations:

- `extracting` is a phase-name confused with a status — files don't
  go through an "extract" state distinctly; might have been
  speculative when the table was designed.
- `validated` should plausibly be set by V-01a or V-02 when validation
  completes successfully — but neither recipe writes back to
  `RUN_Upload`. This may be a real gap: the upload row stays at
  `validating` indefinitely after a successful validation.

**Transitions (catalog evidence):**

```
                           (WFA-03b #20 if no error)
   (WFA-03b #11)                       │
   (WFA-04c #14)                       ▼
        │                       ┌────────────┐
        ▼                       │ validating │ ──── (no transition out!)
   ┌──────────┐                 └────────────┘
   │ received │ ─────────┬─────▶
   └──────────┘          │      ┌────────┐
                         └────▶ │ failed │ (terminal)
                       (WFA-03b #20 if error)
                                └────────┘

   ┌────────────┐    ┌───────────┐    
   │ extracting │    │ validated │     (declared but unreached)
   └────────────┘    └───────────┘
```

**Recommendation.** Either V-01a/V-02 should update `RUN_Upload.status`
to `validated`/`failed` to mirror the validation result, or the
`RUN_Upload` machine should be simplified to `received | failed` and
the validation status read from `RUN_ValidationResult`. The latter is
cleaner architecturally (single source of truth).

### 6. `RUN_ValidationResult.status` — validation outcome (NEW machine)

**Data model enum.** `running | passed | failed | error`.

**Recipe evidence.**

| Recipe | Step | Op | Effect |
|---|---|---|---|
| V-01a | 44 | INSERT | initial state (presumably `running`) |
| V-01a | 51 | INSERT | initial state (parallel insert path) |
| RW-01 | 12 | UPDATE | `status = 'superseded'` (**not in enum**) |

**Findings.**

- V-01a inserts the row at start of validation. The transition out of
  `running` to `passed/failed/error` is **not visible in the catalog**
  — it must happen in V-01a or V-01b internally before the row is
  inserted, OR via a step whose comment doesn't mention status. Worth
  inspecting V-01a's step inputs directly.
- RW-01 introduces a **sixth state**, `superseded`, that isn't in the
  enum. Semantically this is reasonable (when a supplier reworks a
  submission, prior validation results are superseded) but the enum
  needs to be expanded.

**Recommended enum update:** `running | passed | failed | error |
superseded`.

### 7. `WFA_SupplierUser.status` — supplier user lifecycle

**Data model enum.** `active | deactivated`.

**Recipe evidence.**

| Recipe | Step | Op | Effect |
|---|---|---|---|
| P-01 | 56 | INSERT | "Batch create records" — initial state (presumably `active`) |
| P-03a | 17 | SELECT | reads — no transition |

**No recipe deactivates supplier users.** The `deactivated` state
exists in the enum but is unreachable from the recipes in this set.
Either:

- Deactivation is manual (an analyst flips it via the workspace UI), or
- A future recipe (T-layer cleanup) will handle it, or
- The state is vestigial.

Confirm what's intended; if manual, the seed sheet should note that.

### 8. `HOME_WorkspaceRegistry.status` — workspace availability

**Data model enum.** `AVAILABLE | UNAVAILABLE`.

**Recipe evidence.** None. **Zero recipes in this set read or write
this table.**

This means one of:

- The table is set up manually during workspace bootstrap.
- A recipe outside this upload set manages it (e.g., a setup recipe
  or admin tool).
- The table is vestigial.

The seed sheet doesn't mention this machine at all, which is
appropriate given the catalog evidence — but if a future provisioning
flow uses it (e.g., to find an "available" workspace before
provisioning), the recipes that do that should be sourced and the
machine added.

---

## The vocabulary mismatch — what to do about it

Three of the eight state machines have a misalignment between the
data model enum and what recipes actually write:

| Machine | Enum says | Recipes write |
|---|---|---|
| `HOME_Requests.status` | uppercase (`PENDING`, `ACTIVE`...) | lowercase (`rejected`, `active`...) |
| `WFA_SupplierRequest.status` | 7 specific values | a different 5+ values |
| `RUN_ValidationResult.status` | 4 values | 4 + `superseded` |

**Why this matters.**

- The seed sheet's Tab 1 (states) was populated from a mix of memory,
  the previous conversation, and assumed alignment with the data
  model. The catalog reveals the recipes have drifted, so populating
  the sheet from the data model alone would record fiction.
- The data model's `additionalProperties: false` setting (in the JSON
  Schema artifact) means *validators* would reject the values
  recipes actually write — even though Workato Data Tables let them
  through silently. This is a real risk for any future tooling that
  validates against the schema.

**Three concrete next actions:**

1. **Pick a vocabulary per machine.** For
   `HOME_Requests`, decide between `PENDING/ACTIVE/...` (enum) or
   `pending/active/...` (recipes). For `WFA_SupplierRequest`, pick a
   coherent set; the recipe vocabulary is rich
   (`data_entry`, `supplier_action_required`, `validation_success`)
   but inconsistent with itself (mix of past/present/imperative). The
   seed sheet's vocabulary (`invited`, `validated`, `accepted`) is
   cleaner if you can afford the recipe edits.
2. **Update the data model hints to match.** Once the canonical
   vocabulary is chosen, edit the source table's `hint` field in
   Workato so the JSON Schema regen produces the right enum. The
   `generate_schemas.py` overlay is the second-best place to encode
   it; the source hint is the best.
3. **Mark Tab 4 of the seed sheet** with the rename plan. Each
   recipe row that writes a non-canonical status value gets a "needs
   rename" flag. That becomes a small refactoring backlog separate
   from the U-01 instrumentation work.

---

## How to update the seed sheet

Concrete additions and corrections, by tab:

### Tab 1 — `States`

**Add rows for the missing machines:**

```
WFA_TemplateProject  | active       | Project is operational                  | No  | B-02 step 12 inserts row    | indefinite          | template_project_id, project_name | Default on creation
WFA_TemplateProject  | inactive     | Project closed or paused                | Yes | (no recipe writes today)    | indefinite          | template_project_id               | Gap: no automated transition
WFA_SupplierUser     | active       | User can authenticate against the WFA   | No  | P-01 step 56 inserts row    | indefinite          | supplier_user_id, supplier_request_id | Default on creation
WFA_SupplierUser     | deactivated  | User cannot authenticate                | Yes | (no recipe writes today)    | indefinite          | supplier_user_id                  | Gap: no automated transition; possibly manual
RUN_Upload           | received     | Upload row created, file referenced     | No  | WFA-03b step 11 / WFA-04c step 14 | seconds        | upload_id, supplier_request_id, submitted_file_id | Initial state
RUN_Upload           | validating   | Upload handed off to validation pipeline | No | WFA-03b step 20 (success branch) | minutes         | extracted_file_version_id, status | Stays here forever today (gap)
RUN_Upload           | failed       | Upload could not be ingested            | Yes | WFA-03b step 20 (error branch)   | indefinite      | error reference                   | Terminal
RUN_Upload           | extracting   | (declared, never written)               | -   | (none)                       | -                   | -                                 | Vestigial?
RUN_Upload           | validated    | (declared, never written)               | -   | (none)                       | -                   | -                                 | Gap: V-layer doesn't update RUN_Upload
RUN_ValidationResult | running      | Validation in progress                  | No  | V-01a step 44/51 inserts    | seconds-minutes     | validation_result_id, upload_id   | Initial state on insert
RUN_ValidationResult | passed       | Validation succeeded                    | No  | (V-01a internal — verify)   | indefinite          | result counts                     | Catalog can't see the transition
RUN_ValidationResult | failed       | Validation failed (rule violations)     | No  | (V-01a internal — verify)   | indefinite          | error counts                      | Catalog can't see the transition
RUN_ValidationResult | error        | Validation crashed                      | Yes | (V-01a internal — verify)   | indefinite          | error message                     | Catalog can't see the transition
RUN_ValidationResult | superseded   | Earlier result superseded by rework     | Yes | RW-01 step 12               | indefinite          | (none)                            | Set when supplier reworks; not in enum but should be
HOME_WorkspaceRegistry | AVAILABLE  | Workspace can accept new projects       | No  | (no recipe in set)          | indefinite          | workspace_id, capacity            | Manual or out-of-set
HOME_WorkspaceRegistry | UNAVAILABLE| Workspace at capacity / paused          | Yes | (no recipe in set)          | indefinite          | workspace_id                      | Manual or out-of-set
```

**Correct one row:**

The seed sheet currently classifies `WFA_TemplateProject` as
registry-only ("not really a state machine"). Replace with the rows
above.

**Open question to add to existing rows:** for every row in Tab 1
where `Pertinent fields` mentions a `status` value, double-check the
casing against catalog evidence. The seed has uppercase
(`PROVISIONING`, `ACTIVE`); recipes write lowercase. Pick one.

### Tab 2 — `Transitions`

**Add the missing transitions** captured in the per-machine sections
above. Notably:

- `HOME_Requests | PROVISIONING | FAILED | B-02 step 19` — the seed
  marked this `NO (gap)`; catalog suggests it's `Partial` (the UPDATE
  exists; verify the value written).
- All transitions for the five new machines.

### Tab 3 — `Phases`

The phase taxonomy in the seed is well-developed and largely
catalog-agnostic. One observation: the seed's
`submission_validation_started` phase has no current emit point and
maps neatly onto V-01a #44/#51 (the RUN_ValidationResult INSERT).
Worth confirming this is where you'd want it emitted.

### Tab 4 — `Recipe → state changes`

**Append rows for the new machines.** Concrete additions:

```
B-02     | step 19 | HOME_Requests        | PROVISIONING→FAILED      | update_record    | recipe_failed | NO | Verify the value B-02 writes
P-03a    | step 14 | WFA_SupplierRequest  | pending→sent             | update_record    | supplier_invited | NO | Today emits no phase
RW-01    | step 21 | WFA_SupplierRequest  | (any)→data_entry         | update_record    | submission_resumed | NO | Vocabulary mismatch with enum
V-02     | step 17 | WFA_SupplierRequest  | submitted→supplier_action_required | update_record | submission_invalid | NO | Vocabulary mismatch
V-02     | step 21 | WFA_SupplierRequest  | submitted→validation_success | update_record | submission_validated | NO | Vocabulary mismatch
WFA-06a  | step 6  | WFA_SupplierRequest  | validated→accepted (?)   | update_record    | submission_accepted | NO | Verify value written
WFA-03b  | step 11 | RUN_Upload           | (none)→received          | add_record       | (new)           | NO | Pipeline machine entry
WFA-03b  | step 20 | RUN_Upload           | received→validating | failed | update_record | (new) | NO | Conditional branch
WFA-04c  | step 14 | RUN_Upload           | (none)→received          | add_record       | (new)           | NO | Form path entry
V-01a    | step 44 | RUN_ValidationResult | (none)→running           | add_record       | (new)           | NO | Validation start
V-01a    | step 51 | RUN_ValidationResult | (none)→running           | add_record       | (new)           | NO | Parallel insert path
RW-01    | step 12 | RUN_ValidationResult | (any)→superseded         | update_record    | (new)           | NO | Rework supersedes prior result
P-01     | step 22 | VER_TemplateVersion  | published→deprecated     | update_record    | version_deprecated | NO | (already in seed at step 20 — verify step number)
```

**Note on step numbers.** The seed sheet referenced step numbers like
"P-01 step 20" for the deprecate transition; catalog says step 22.
Step numbers in the seed should be re-verified against the current
recipe versions before instrumentation work begins.

### Tab 5 — `Open questions`

**New questions surfaced by this analysis:**

```
What canonical vocabulary should WFA_SupplierRequest.status use? Recipes write 5+ values that don't match the data model enum. | WFA_SupplierRequest | Open | | | Affects three recipes (P-03a, V-02, RW-01) plus the data model enum hint
Is RUN_Upload.extracting a real intended state, or vestigial? | RUN_Upload | Open | | | No recipe writes it
Is RUN_Upload.validated a gap (V-layer should write it back) or by-design (pipeline reads RUN_ValidationResult instead)? | RUN_Upload | Open | | | Affects whether V-01a/V-02 need an UPDATE step
Is `superseded` a legitimate state for RUN_ValidationResult, or should the prior-result row be deleted instead of updated? | RUN_ValidationResult | Open | | | Currently RW-01 #12 writes a non-enum value
Who manages HOME_WorkspaceRegistry — manual, or a recipe outside this set? | HOME_WorkspaceRegistry | Open | | | If automated elsewhere, source those recipes and add to catalog
What is the canonical casing for HOME_Requests.status? Enum is uppercase, recipes write lowercase. | HOME_Requests | Open | | | Cosmetic but real
Where does WFA_SupplierUser.deactivated get set? | WFA_SupplierUser | Open | | | Manual? Future T-layer? Vestigial?
What value does B-02 step 19 write to HOME_Requests.status on failure? | HOME_Requests | Open | | | Catalog comment says "status and error_reason" but doesn't name the value
```

---

## What the catalog can't tell you (and why)

Two things to be aware of:

1. **The status *value* an UPDATE writes is sometimes invisible.**
   Step comments often (but not always) name the value
   (`status = 'sent'`). When they don't, the catalog records "this
   step updates table X" but not the new value. Three steps in this
   analysis (B-02 #19, P-01 #10, WFA-06a #6) need direct inspection
   of the recipe JSON's step input to confirm the value written.

2. **State transitions inside a single step are invisible.** If
   V-01a's INSERT for `RUN_ValidationResult` initially writes
   `running` and then a later UPDATE in the same recipe sets it to
   `passed`/`failed`, the catalog records both as separate steps.
   But if V-01a internally computes the final state and inserts it
   directly (no UPDATE), the catalog only sees one INSERT and the
   transition appears to happen "out of nowhere." This is likely
   what's happening in V-01a — the running state may exist only
   instantaneously, or not at all.

For both cases, the resolution is the same: when you instrument U-01
emit calls, you'll be reading and writing status values explicitly,
and the catalog will improve in lockstep on the next regen.

---

## Suggested workflow

1. **Resolve the vocabulary mismatch** (top of Open Questions).
   Pick canonical state names per machine. Document the decision in
   an ADR. This is a 30-minute decision that unblocks everything else.
2. **Update the seed sheet's Tab 1** with the five missing machines
   from this document. Use canonical vocabulary throughout.
3. **Update Tab 4** with the new rows above, plus rename rows where
   the seed step numbers have drifted from current recipe versions.
4. **Verify the three "value unknown" cases** (B-02 #19, P-01 #10,
   WFA-06a #6) by direct recipe inspection. Update Tab 4 accordingly.
5. **Then** start U-01 instrumentation. With Tab 4 accurate, the
   `Currently emitted? = NO` filter is your prioritized work list.

The goal isn't to capture every possible state machine in formal
detail before doing anything else — it's to make sure the
instrumentation work doesn't get pinned to a state vocabulary that
doesn't match what the system actually does.