# SDC Recipe ↔ Table Reference

Two views of the same data: which recipes touch which tables, and
which tables are touched by which recipes. Generated from
`recipe_catalog.json` (24 recipes, 23 tables in the data model).

This is a reference, not a guide. Use it to answer:

- "If I change *table*, which recipes are affected?" → look up the
  table in *§ Tables → recipes*.
- "If I change *recipe*, which tables does it touch?" → look up the
  recipe in *§ Recipes → tables*.
- "Where in the system is *table* read but never written?" or
  *vice versa* → see *§ Coverage notes*.

---

## Tables → recipes

Grouped by purpose. For each table: which recipes read, write
(insert), or update it.

### State machines

#### `HOME_Requests`
| Op | Recipes |
|---|---|
| read | B-01, B-02, P-01 |
| write | B-01 |
| update | B-02, P-01 |

#### `WFA_SupplierRequest`
| Op | Recipes |
|---|---|
| read | P-01, P-02b, P-03a, RW-01, V-01b, V-02, WFA-03b, WFA-04b, WFA-04c, WFA-05b, WFA-06a, WFA-06b |
| write | P-01 |
| update | P-01, P-02b, P-03a, RW-01, V-02, WFA-06a |

The most-touched table in the system. Every workflow boundary reads
it; six recipes update it. Vocabulary changes here have the widest
blast radius.

#### `RUN_ValidationResult`
| Op | Recipes |
|---|---|
| read | RW-01, V-02 |
| write | V-01a |
| update | RW-01 *(removing under state-machine rationalization)* |

Single writer (V-01a), narrow reader set. Easy to reason about.

#### `VER_TemplateVersion`
| Op | Recipes |
|---|---|
| read | P-01, P-02b, P-03a, WFA-05c |
| write | P-01 |
| update | P-01 |

P-01 owns this entirely. Other recipes read for context (which
version is published, which template_file_id to use).

### Configuration (template-version-scoped)

These tables are written by P-01 during config persistence, then
read by the validation and form layers. None are updated post-creation
within the recipe set — version-scoped data is immutable per version.

#### `CFG_Field`
| Op | Recipes |
|---|---|
| read | V-01b, V-02 |
| write | P-01 |

#### `CFG_Rule`
| Op | Recipes |
|---|---|
| read | V-01b |
| write | P-01 |

#### `CFG_Lookup`
| Op | Recipes |
|---|---|
| read | V-01b |
| write | P-01 |

#### `CFG_Variant`
| Op | Recipes |
|---|---|
| read | P-01, P-02b, P-03a |
| write | P-01 |
| update | P-01 |

The only CFG_* table that's updated — P-01 modifies variant rows during republish (e.g., to update `template_file_id` after rebuilding XLSX templates).

#### `CFG_VariantField`
| Op | Recipes |
|---|---|
| read | P-01 |
| write | P-01 |

#### `CFG_FormSlot`
| Op | Recipes |
|---|---|
| read | P-03a, WFA-04b |
| write | P-01 |

#### `CFG_ErrorTranslation`
| Op | Recipes |
|---|---|
| read | V-01b |
| write | P-01 |

### Identity & registry

#### `WFA_TemplateProject`
| Op | Recipes |
|---|---|
| read | P-01, WFA-03b, WFA-04c, WFA-05a, WFA-05c, WFA-06a |
| write | B-02 |
| update | P-01 |

B-02 creates the project row; P-01 enriches it during provisioning. Most other recipes read it for context (project_completion_status, output_drive_folder_id, etc.).

#### `WFA_SupplierUser`
| Op | Recipes |
|---|---|
| read | P-03a |
| write | P-01 |

Per the state-machine analysis, this is identity/access — not a workflow machine. Narrow recipe coverage matches that framing.

#### `HOME_WorkspaceRegistry`
| Op | Recipes |
|---|---|
| (no recipe in this set touches it) | — |

Either managed manually, by a recipe outside the upload set, or vestigial. Open question.

#### `HOME_Manifests`
| Op | Recipes |
|---|---|
| (no recipe in this set touches it) | — |

The data model declares this table but no recipe in the set reads or writes it. Possibly used outside this set, or vestigial.

### Submission & validation runtime

#### `RUN_Upload`
| Op | Recipes |
|---|---|
| read | RW-01, V-01b, V-02, WFA-06a |
| write | WFA-03b, WFA-04c |
| update | WFA-03b |

Two writers (file path and form path). Read by the validation pipeline and the rework/review recipes.

#### `RUN_ManualEntry`
| Op | Recipes |
|---|---|
| read | WFA-04b, WFA-04c |
| write | P-03a, WFA-04b |

Form-side detail records. P-03a creates initial rows during onboarding; WFA-04b updates them as the supplier fills the form.

#### `RUN_FieldError`
| Op | Recipes |
|---|---|
| read | V-02 |
| write | V-01a |

Validation error detail. V-01a writes errors during validation; V-02 reads them when routing the result.

### Audit & event chronicles

#### `SYS_EventLogs`
| Op | Recipes |
|---|---|
| read | (none in recipe set — UI/dashboard reads happen elsewhere) |
| write | B-01, B-05 |

Currently sparse — only intake recipes write phase events. After the state-machine implementation work lands, every recipe with a phase emit will write here.

#### `RUN_ReviewNote`
| Op | Recipes |
|---|---|
| read | (none in recipe set) |
| write | WFA-06a |

Specialized event log for analyst review actions.

#### `RUN_PipelineError`
| Op | Recipes |
|---|---|
| read | (none in recipe set) |
| write | U-01 |

Being dropped under the state-machine rationalization. SYS_EventLogs absorbs the role.

### Form/UI staging

#### `WFA_Cache`
| Op | Recipes |
|---|---|
| read | (none in recipe set — likely read by the WFA app layer) |
| write | WFA-04a |

WFA app form staging. The catalog showed WFA-03b's `cache_record_id` parameter implies the WFA layer reads it, but no Workato recipe in this set does.

### Provisioning records

#### `MAIN_ProvisioningResults`
| Op | Recipes |
|---|---|
| (no recipe in this set touches it) | — |

The data model declares this table but no recipe in the set reads or writes it. Possibly used outside this set, or vestigial.

---

## Recipes → tables

For each recipe: tables it reads, writes (inserts), or updates.
Recipes that don't touch any table are omitted (B-05, WFA-03a, etc.).

### Base intake & routing

#### `B-01` — Receive request via webhook
| Op | Tables |
|---|---|
| read | HOME_Requests |
| write | HOME_Requests, SYS_EventLogs |

#### `B-02` — Route data collection request
| Op | Tables |
|---|---|
| read | HOME_Requests |
| write | WFA_TemplateProject |
| update | HOME_Requests |

#### `B-05` — Request analyst portal access
| Op | Tables |
|---|---|
| write | SYS_EventLogs |

### Provisioning

#### `P-01` — Provision project (the orchestrator)
| Op | Tables |
|---|---|
| read | CFG_Variant, CFG_VariantField, HOME_Requests, VER_TemplateVersion, WFA_SupplierRequest, WFA_TemplateProject |
| write | CFG_ErrorTranslation, CFG_Field, CFG_FormSlot, CFG_Lookup, CFG_Rule, CFG_Variant, CFG_VariantField, VER_TemplateVersion, WFA_SupplierRequest, WFA_SupplierUser |
| update | CFG_Variant, HOME_Requests, VER_TemplateVersion, WFA_SupplierRequest, WFA_TemplateProject |

P-01 touches 13 distinct tables. Roughly half the data model. This is what makes it the recipe most worth decomposing.

#### `P-02b` — Seed incumbent data
| Op | Tables |
|---|---|
| read | CFG_Variant, VER_TemplateVersion, WFA_SupplierRequest |
| update | WFA_SupplierRequest |

#### `P-03a` — Onboard suppliers
| Op | Tables |
|---|---|
| read | CFG_FormSlot, CFG_Variant, VER_TemplateVersion, WFA_SupplierRequest, WFA_SupplierUser |
| write | RUN_ManualEntry |
| update | WFA_SupplierRequest |

(P-02a, P-03b have no table interactions — file/orchestration only.)

### Config validation

C-01 has no direct table interactions in this set — it returns validation results to its caller (P-01).

### Supplier workflow

#### `WFA-03b` — Submit supplier input from file upload
| Op | Tables |
|---|---|
| read | WFA_SupplierRequest, WFA_TemplateProject |
| write | RUN_Upload |
| update | RUN_Upload |

#### `WFA-04a` — Accept supplier input from form and stage
| Op | Tables |
|---|---|
| write | WFA_Cache |

#### `WFA-04b` — Save a single worker entry
| Op | Tables |
|---|---|
| read | CFG_FormSlot, RUN_ManualEntry, WFA_SupplierRequest |
| write | RUN_ManualEntry |

#### `WFA-04c` — Submit supplier input from form
| Op | Tables |
|---|---|
| read | RUN_ManualEntry, WFA_SupplierRequest, WFA_TemplateProject |
| write | RUN_Upload |

(WFA-03a is a table-listener trigger only — no table interactions of its own.)

### Supplier validation

#### `V-01a` — Validate supplier input (orchestrator)
| Op | Tables |
|---|---|
| write | RUN_FieldError, RUN_ValidationResult |

#### `V-01b` — Prepare validation context
| Op | Tables |
|---|---|
| read | CFG_ErrorTranslation, CFG_Field, CFG_Lookup, CFG_Rule, RUN_Upload, WFA_SupplierRequest |

V-01b is a pure read recipe — gathers the context V-01a needs to run validation.

#### `V-02` — Route validation results
| Op | Tables |
|---|---|
| read | CFG_Field, RUN_FieldError, RUN_Upload, RUN_ValidationResult, WFA_SupplierRequest |
| update | WFA_SupplierRequest |

### Analyst review

#### `WFA-05a` — Get data for project selector
| Op | Tables |
|---|---|
| read | WFA_TemplateProject |

#### `WFA-05b` — Get data for page event dropdown
| Op | Tables |
|---|---|
| read | WFA_SupplierRequest |

#### `WFA-05c` — Seed incumbent data (late arriving)
| Op | Tables |
|---|---|
| read | VER_TemplateVersion, WFA_TemplateProject |

#### `WFA-06a` — Analyst review: approve submission
| Op | Tables |
|---|---|
| read | RUN_Upload, WFA_SupplierRequest, WFA_TemplateProject |
| write | RUN_ReviewNote |
| update | WFA_SupplierRequest |

#### `WFA-06b` — Analyst review: request supplier rework
| Op | Tables |
|---|---|
| read | WFA_SupplierRequest |

### Supplier rework

#### `RW-01` — Request supplier rework (incomplete)
| Op | Tables |
|---|---|
| read | RUN_Upload, RUN_ValidationResult, WFA_SupplierRequest |
| update | RUN_ValidationResult, WFA_SupplierRequest |

### Utility

#### `U-01` — Handle errors
| Op | Tables |
|---|---|
| write | RUN_PipelineError *(redirecting to SYS_EventLogs under the rationalization)* |

---

## Coverage notes

### Tables with no recipe coverage

Three tables exist in the data model but no recipe in this upload set
touches them:

| Table | Hypothesis |
|---|---|
| `HOME_WorkspaceRegistry` | Managed manually, or by a recipe outside the upload set, or vestigial. |
| `HOME_Manifests` | Possibly used by tooling outside this recipe set. |
| `MAIN_ProvisioningResults` | Possibly used by tooling outside this recipe set. |

If any of these turn out to be needed, the missing recipes should be
sourced and added to the catalog. If they're vestigial, drop from the
data model.

### Tables written but never read (within recipe set)

| Table | Writer | Reader | Notes |
|---|---|---|---|
| `WFA_Cache` | WFA-04a | (none in recipes) | Read by the WFA app layer outside Workato recipes. |
| `RUN_ReviewNote` | WFA-06a | (none in recipes) | Read by analyst dashboards / reports outside the recipe set. |
| `SYS_EventLogs` | B-01, B-05 | (none in recipes) | Read by operations dashboards outside the recipe set. After phase-emission work, more recipes will write. |
| `RUN_PipelineError` | U-01 | (none in recipes) | Being dropped under the rationalization. |

This pattern (write-only from recipes, read elsewhere) is correct for
audit/log/staging tables. The reads happen in dashboards, UIs, or
admin queries — not in recipes.

### Tables with single writer, multiple readers

A few tables have exactly one recipe responsible for their content:

- **All CFG_* tables** — written only by P-01. The provisioning
  recipe is the single source of truth for configuration.
- **VER_TemplateVersion** — written and updated only by P-01.
- **RUN_FieldError** — written only by V-01a.
- **RUN_ValidationResult** — written only by V-01a (currently updated
  by RW-01, but that update is being removed).

This single-writer pattern is healthy — it makes the contract for
the table clear and makes "what populates this?" easy to answer.

### Tables with multiple updaters

A few tables have multiple recipes writing UPDATEs:

- **HOME_Requests** — updated by B-02, P-01. Will remain so under
  the rationalization (P-01 owns the terminal succeeded/failed
  transition).
- **WFA_SupplierRequest** — updated by P-01, P-02b, P-03a, RW-01,
  V-02, WFA-06a. Six updaters. Different stages of the supplier
  lifecycle each transition the row. Worth understanding *which step
  of which recipe* writes which transition — the state implementation
  guide covers that in detail.
- **WFA_TemplateProject** — updated by P-01. Combined with B-02 as
  writer, this is the project-record lifecycle.
- **CFG_Variant** — updated by P-01 only. Single updater, but worth
  noting it's the only CFG_* table that takes UPDATEs (during
  republish for variant template_file_id refresh).
- **VER_TemplateVersion** — updated by P-01 only. Single updater.
- **RUN_Upload** — updated by WFA-03b only. Single updater.
- **RUN_ValidationResult** — updated by RW-01 *(being removed under
  the rationalization)*. After the change, no recipe will UPDATE this
  table — it becomes write-once.

WFA_SupplierRequest's six updaters is the only place where multiple
recipes contend for the same row. That's intrinsic to the supplier
workflow design — many lifecycle stages, many recipes that own a
specific transition. The state implementation guide partitions the
transitions cleanly across recipes; understanding which recipe owns
which transition is the antidote to "who changed this row?"
confusion.

---

*Generated from `recipe_catalog.json` by inspection. Re-run the
recipe catalog generator and regenerate this reference whenever
recipes change.*
