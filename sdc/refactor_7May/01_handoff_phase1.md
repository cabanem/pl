# SDC Data Collection — Session Handoff (Phase 0 close, into Phase 1) — v1

## Where we are

Phase 0 is closed. The four capability deep dives, the workflow inventory, the data model, the workflow stages document, the callable triage, and the open-questions resolutions are all complete. The substantive design surface for Phase 1 is settled.

The natural next step is **data model v2** — folding the two schema additions from the cluster resolutions into the authoritative data model document. This is the only piece of Phase 0 work left, and it blocks Phase 1: nothing builds against an unsettled schema.

After that, **sibling capability scoping** for the eight capabilities surfaced by the deep dives and the cluster resolutions. Lighter than the four primary deep dives but needs the same plain-language forcing function. Then **build queue sequencing**, which is build-session work, not Phase 0 work.

## Stance

Three things to carry forward unchanged:

- **Rebuild is the default.** Set during the triage handoff. The carry-forward list is small on purpose — the SDC Platform Connector's actions and methods, plus nothing from the recipe catalog. Everything else gets built from the capability specs.
- **Plain-language scoping is the forcing function.** When jargon gets stripped out, hidden assumptions surface. This worked for the four primaries; the eight sibling capabilities get the same treatment, just in less depth.
- **Strictness, partial-success, normalization, and cross-row scope are settled.** The cluster resolutions doc is the source of truth for these. They aren't decisions to relitigate at the start of the next session.

## Files to attach to the next session

The full Phase 0 set, plus the artifact summarizing the Invite cluster:

1. The workflow inventory (the 10 workflows: E1–E3, R1–R6, X1).
2. The data model — `sdc-data-model-v1.md` (will become v2 after the next session).
3. `sdc-workflow-stages-v1.md` — plain-language stages for all 10 workflows.
4. `sdc-capability-validate-config-v1.md`
5. `sdc-capability-build-xlsx-template-v1.md`
6. `sdc-capability-invite-supplier-users-v1.md`
7. `sdc-capability-validate-supplier-input-v1.md`
8. `sdc-callable-triage-v2.md` — the carry-forward list, capability-coverage map, and open-questions resolutions.
9. The SDC Platform Connector code (Ruby SDK, the version with `parse_config_file`, `validate_config`, `validate_upload`, `extract_form_fields`, `generate_validation_report`, `build_storage_path`).

The two YAML-spec connectors (CI/CD and Data Tables API) are out of scope for the rebuild itself — see the triage doc.

## Suggested opening message

> Continuing the SDC Data Collection work into the Phase 0 close-out. I've attached the workflow inventory, data model v1, workflow stages, all four capability deep dives, the callable triage v2 with cluster resolutions folded in, and the SDC Platform Connector code. The triage's carry-forward list is final and the open-questions resolutions for Invite and Validate are settled.
>
> First task: data model v2, folding in the two schema additions from the cluster resolutions — `SupplierUser.primary` (boolean, exactly-one-per-supplier validated at config time) and `ValidationRule.scope` (enum of `submission` / `supplier` / `engagement`, default `submission`). Ready to start.

## What the next session produces

In order:

### 1. Data model v2

The two additions:

- **`SupplierUser.primary`** — boolean. Validated as exactly-one-per-supplier at config time. Drives the designated-assignee logic in *Invite supplier users*.
- **`ValidationRule.scope`** — enum of `submission` / `supplier` / `engagement`, defaulting to `submission`. Drives cross-row uniqueness scope in *Validate supplier input*.

Both are additive. Neither breaks anything. The change is small enough to do in one pass, but it bumps the data model to v2 because the authoritative schema document is the kind of thing that gets referenced and a v1 reader needs to know to look for v2.

While the doc is open, also worth re-checking: the data model v1 was drafted before the cluster resolutions, so the `Invariants` section may want a small update mentioning the primary-user invariant. Light touch — don't relitigate the v1 invariants, just add the new one.

### 2. Sibling capability scoping

Eight sibling capabilities surfaced across the deep dives and the cluster resolutions. Each needs a plain-language scope — lighter than the four primary deep dives (half a page each is probably right) but enough to surface assumptions before the build queue pulls from them.

The eight, grouped by what they're for:

*Cross-cutting (probably do first, since other capabilities reference them):*

- **Status-change handler.** The single-writer rule from the data model's invariant 1. Owns `SupplierRequest.status`, `supplier_display_status`, and `supplier_message`. Called from R1, R2, R3, R5, R6, and from R2 again on display-refresh.
- **Event emission utility.** A U-01-equivalent. Cross-cutting, called from essentially every capability that wants to write to `EventLog`.

*Invite cluster siblings (cluster together):*

- **Refresh outreach.** Regenerate link, send fresh emails. Subsumes the link-refresh / re-hydration sibling the deep dive flagged for the FileStorage 10-day TTL.
- **Add user to request.** Grant access to a new user, send them outreach, leave the rest alone.
- **Reassign request.** Move the task to a new assignee using the platform's reassign mechanism. Notify both old and new.

*Independent siblings:*

- **Incumbent data seeding.** P-02b's job today. Sibling of *Build XLSX template*; runs after the empty template is built.
- **Resubmission template generation.** Sibling, runs against a built template plus prior valid rows. The system-driven path on R2 failure (carry-forward template, distinct from R5's blank-on-rework).
- **Reminder eligibility evaluation.** R-07's py_eval is reference. Eligibility is a state-machine concern, firing is a policy-layer concern (workstream 2 invariant 4); the scope needs to make the contract between them explicit.

### 3. Build queue sequencing

This is build-session work, not Phase 0 work, but it's the natural close-out before Phase 1 starts cutting code. The proposed dependency order:

1. Data model v2.
2. Status-change handler and event emission utility.
3. *Validate config* (no upstream dependencies once the schema is settled).
4. *Build XLSX template* (depends on validated configuration shape).
5. *Validate supplier input* (depends on configuration structure for the rules and lookups).
6. *Invite supplier users* (depends on templates existing).
7. The three Invite siblings (Refresh, Add user, Reassign).
8. *Incumbent data seeding* (after Build XLSX template).
9. *Resubmission template generation* (after Build XLSX template and Validate supplier input).
10. *Reminder eligibility evaluation* (late — depends on the request lifecycle being substantively in place).

X1 (Export to target system) sits outside this ordering. Its specification depth is the least-defined work in the system and probably needs its own design pass before it joins the build queue.

## What's in scope for the next session

- Data model v2.
- Sibling capability scoping (all eight, or as many as fit).
- Build queue sequencing if there's time.

What's *not* in scope:

- Relitigating any of the cluster resolutions. They're settled in `sdc-callable-triage-v2.md`.
- CI/CD or Data Tables API connector dispositions. Treated as feature work for after the rebuild is coherent.
- X1 specification depth. Its own work, separately.
- The "can defer to later in Phase 1" list from the triage doc. Surface during build if a specific capability touches them, otherwise leave alone.

## Test cases worth capturing during sibling scoping

Two test specs the triage doc named, worth writing while the relevant capabilities are being scoped (not after):

- **Resubmit-after-failure with supplier-scope uniqueness.** Catches the "filter to successful prior submissions" trap in *Validate supplier input*. The pre-fetch query has to filter to validated/approved prior submissions, not "any prior submission" — otherwise the supplier gets uniqueness errors against their own failed prior attempts. Easy to get wrong, easy to miss in casual testing.
- **Dependent-dropdown parents with awkward characters.** `R&D`, `IT/Security`, `1st Quarter`, leading punctuation, Unicode. Locks in the shared-sanitization invariant for *Build XLSX template* — the bug the triage's P-02a close-read found in the existing implementation.

Worth adding others as the sibling capabilities surface their own bug classes during scoping.

## Working principles, restated for continuity

These have shaped Phase 0 and should continue:

- **Capability descriptions are the source of truth.** Recipe decomposition is implementation; the capability spec is the contract.
- **Side-effect signature matters.** Each capability has a clean stance on what it touches (pure inspection, pure construction, outward-facing, internal persistence). The four primaries cover the spectrum; the siblings should be equally clean.
- **Frozen-at-issuance configuration.** Each supplier request is stamped with a configuration version at invitation time. New versions don't migrate in-flight suppliers. This invariant survives the refactor unchanged.
- **Single-writer rule for status.** Only the status-change handler writes `status`, `supplier_display_status`, and `supplier_message`. Drift between the three is impossible by construction.
- **Snapshot semantics for published versions.** Once published, no row scoped to that version is ever updated. Typo fixes flow forward via new versions.

## Pending after the next session

- Per-capability detailed scoping for any siblings that surface enough complexity to need it.
- Build queue execution — actually starting Phase 1's code work.
- ADR triage against the new design (deferred from the original Phase 0 list, still alive).
- Naming and prefix conventions finalization for the new schema (the data model v1 used conceptual names; the build needs settled prefixes).

The ADR triage and naming conventions are both worth surfacing before the build session starts pulling capabilities off the queue, but they don't block the next session.
