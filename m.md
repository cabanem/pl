Absolutely. Let me trace through everything we settled in this conversation.

---

**ADR-001: Field visibility is authored in the spreadsheet, derived in the pipeline**

The `7_form` tab is the single source of truth for which fields appear on the manual-input form. The GAS serializer extracts a flat `_field_visibility` map (field name → boolean) and includes it in the JSON payload alongside the raw sheet data. The connector's Parse Config action merges visibility onto each parsed field record. Downstream consumers never parse the raw `7_form` 2D array — they read the `visible` boolean on each field.

*Rationale:* The analyst owns the "which fields?" decision in a UI they already understand (checkboxes in a spreadsheet). The system owns the "how to represent it?" decision. Keeps the GAS layer thin (pure extraction, no business logic) and the connector layer authoritative (single merge point).

---

**ADR-002: Form field extraction is a separate connector action**

Extract Form Fields is its own action in the SDC Platform Connector, distinct from Parse Config and Validate Config. It accepts the parsed fields and lookups, filters to visible fields, resolves control types, and returns only the lookups the form actually needs.

*Rationale:* Separation of concerns. Parse Config answers "what does the config say?" Validate Config answers "is it consistent?" Extract Form Fields answers "what does the form need?" Each has a different consumer and a different reason to change. C-01 calls all three, but they're independently testable and independently evolvable.

---

**ADR-003: Control type is derived from data type + data format, resolved in the connector**

The `resolve_form_control_type` method maps `data_type` and `data_format` to a form control string (text, number, email, date, select, dependent_select, checkbox, currency). Data format takes precedence where it implies a specific control. The mapping lives in the connector, not in the spreadsheet or in recipe formulas.

*Rationale:* The analyst shouldn't have to specify control types — they already declared the data type and format. Deriving the control type is a pure function of those two inputs. Keeping the derivation in the connector means it's versioned with the connector code, testable in the SDK, and consistent across all recipes that consume field metadata.

---

**ADR-004: The form uses a fixed slot pool with config-driven assignment**

The Workflow App form has a pre-provisioned pool of 20 generic input slots (8 text, 2 number, 4 date, 4 select, 2 boolean), each with a companion label column. Visible fields are assigned to slots by control type at publish time. The assignment is deterministic (sorted by position, first-available within the type pool) and written to CFG_FormSlot.

*Rationale:* Workflow App form fields are bound to data table columns at design time — you can't create them dynamically at runtime. The slot pool is the bridge between a config-driven field model and a fixed-schema form. The `slot_` prefix on all 40 columns distinguishes them from operational fields in WFA_SupplierRequest.

---

**ADR-005: Slot metadata is stamped onto each supplier request record**

Each WFA_SupplierRequest record carries the full set of slot label columns (e.g., `slot_text_01_label = "Employee name"`). The form reads these labels to determine which slots are active and how to label them. Unassigned slots have null labels, which drives conditional visibility on the form page.

*Rationale:* The form needs to resolve its layout from the request record itself, not from a join to CFG_FormSlot, because the Workflow App's form builder binds directly to data table columns. Denormalizing the labels onto the request record makes the form self-contained per supplier, per version. It also enables version-pinning: each supplier's form layout is frozen to the version they were assigned.

---

**ADR-006: Supplier request records are version-pinned and status-gated**

Each WFA_SupplierRequest carries an `assigned_version_id` and a `status_StateMachine`. On re-publish, only records with `status = pending` are re-stamped with the new version's slot layout. Records that have transitioned to `in_progress` (supplier opened the form) or beyond are frozen — their version, slot labels, and form layout are immutable.

*Rationale:* Prevents mid-flight disruption. If a supplier is actively entering data, changing their form layout would invalidate partial input and break trust. The version pin means each supplier experiences a stable interface from first touch through submission, regardless of how many times the analyst re-publishes.

---

**ADR-007: Re-publish detects new suppliers and creates missing request records**

The ELSE branch of the bootstrap conditional (Steps 52–56) queries all existing request records for the project, re-stamps pending ones, and compares the supplier list from the new config against all existing supplier names (not just pending) to detect additions. New suppliers get fresh request records with the current version's slot layout.

*Rationale:* Analysts frequently add suppliers between publishes. The system needs to handle this without requiring a full re-initialization. Comparing against all statuses (not just pending) prevents duplicate request records for suppliers who are already in progress.

---

**ADR-008: Template file naming encodes client, variant, version, and date**

Generated XLSX files follow the pattern `{client-slug}_{variant-slug}_{version-short}_{date}.xlsx`, stored under `{base_path}/{client-slug}/{version-short}/`. The naming components are computed in the Python transform (Step 36), not in the FileStorage step. The `sanitize` function normalizes names to lowercase hyphenated slugs.

*Rationale:* Version isolation (each publish gets its own folder, no overwrites), human readability (you can identify the file's provenance at a glance), and single ownership of naming logic (Step 36 computes it, Step 41 just receives the resolved strings).

---

**ADR-009: The GAS layer is a thin serializer, not an orchestrator**

The Apps Script has two jobs: serialize the spreadsheet to JSON and fire a webhook. It does not parse config, validate referential integrity, generate templates, assign form slots, or provision supplier records. All of that lives in Workato (connector + recipes). The GAS layer derives exactly one thing beyond raw serialization: the `_field_visibility` map, which is a pure extraction (no business logic).

*Rationale:* GAS has a 6-minute execution limit, limited error handling, and no transactional semantics. Workato has retry logic, version management, data tables, and observable job history. Moving all business logic to Workato means the spreadsheet is a UI, not a runtime — and the pipeline is testable, auditable, and recoverable independent of Google's execution environment.

---

**ADR-010: Spreadsheet-minted UUIDs are informational, not authoritative**

The PK stamper writes UUIDs into `4_fields`, `5_lookups`, etc. when rows are added. These IDs are not consumed by any downstream system. The connector's Parse Config action ignores them. The Python transform in C-01 generates its own `field_id` UUIDs scoped to the template version. The spreadsheet UUIDs exist for analyst traceability only.

*Rationale:* Identifiers must be version-scoped — the same field in version 3 and version 4 needs distinct IDs so they can coexist in the data tables. The spreadsheet has no concept of versions. Letting the pipeline mint authoritative IDs at publish time keeps versioning clean and avoids the complexity of tracking which spreadsheet UUID maps to which version's record.

---

**ADR-011: Toggle fields on enumerated connector inputs for pill-mappable flexibility**

All `control_type: "select"` fields in the connector's object definitions (`data_type`, `data_format`, `rule`, `group_by`) include a `toggle_field` block. This allows recipe builders to switch between pick-list selection and data pill mapping. The `type` attribute is omitted from the parent field when a `toggle_field` is present (Workato SDK constraint).

*Rationale:* The connector is used both interactively (analyst testing in the SDK panel, where pick lists help) and programmatically (recipes piping data between steps, where pills are required). Toggle fields serve both modes without separate field definitions.

---

**ADR-012: Validation of form field count is a warning, not a blocker**

The connector's `validate_config` action checks visible field count against a configurable `form_field_limit` (default 20). Exceeding the limit emits a `warn` status, not a `fail`. However, the recipe's Extract Form Fields gate (Steps 7–8) treats `over_limit` as a hard block that returns an error.

*Rationale:* The connector is a general-purpose tool — it reports facts. The recipe is a specific workflow — it enforces policy. The connector says "you have 23 visible fields and the limit is 20." The recipe decides whether that's a dealbreaker. This lets different recipes apply different thresholds without changing the connector.
