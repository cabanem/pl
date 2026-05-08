# Repository catalog

Twenty-two files, all under `sdc/refactor_7May/`. Grouping by purpose:

**Phase planning and status**
- `phase0.md` — five-workstream Phase 0 plan and progress
- `handoff_phase1.md` — handoff into Phase 1 close-out
- `memo_timeline_8May.md` — stakeholder-facing status memo

**Workflow and capability scoping**
- `sdc-workflow-inventory-v1.md` — the 10 workflows (E1–E3, R1–R6, X1)
- `sdc_workflow_stages_v1.md` — plain-language stage walkthrough of all 10
- `sdc-capability-validate-config_v1.md` — primary deep dive 1
- `sdc-capability-build-xlsx_v1.md` — primary deep dive 2
- `sdc-capability-invite-supplier-users_v1.md` — primary deep dive 3
- `sdc-capability-validate-supplier-input_v1.md` — primary deep dive 4
- `sdc-capability-siblings_v1.md` — eight sibling capability scopes (incl. OBS-01)

**Data model and schema**
- `sdc-data-model-v1.md` — initial 18-table model
- `sdc-data-model-v2.md` — v2 additions (`SupplierUser.primary`, `ValidationRule.scope`)
- `sdc-data-table-schema-v1.md` — consolidated Stage 0 build-target spec
- `sdc-data-table-build-manifest.json` — machine-readable table build manifest

**State machine, naming, observability vocabulary**
- `sdc-state-machine-v1.md` — six-state SupplierRequest machine + derivation table
- `sdc-naming-conventions-v1.md` — prefixes, fields, file model, recipe handles
- `sdc-event-phase-taxonomy.md` — canonical `phase` enum for EventLog

**Triage**
- `sdc-adr-triage-v1.md` — pass-through triage of 61 ADRs
- `sdc-callable-triage_v2.md` — carry-forward list and capability-coverage map

**Build planning and implementation**
- `sdc-build-queue-v1.md` — 10-stage sequenced build queue
- `obs-01_python.py` — three Workato Python steps (OBS-01 + STS-01 transition + STS-01 derivation)

**Testing**
- `tests/connector_spec.md` — Stage 1 test harness connector spec


**The honest gap.** Unlike `phase` — which has a full canonical taxonomy locked down in `sdc-event-phase-taxonomy.md` and is validated against a closed set inside the OBS-01 Python — `error_type` has no controlled vocabulary defined anywhere. It's a free-form string with the label "categorical." If you want to use it consistently across recipes (which is the whole point of having it), it needs the same treatment `phase` got: a short doc that names the legal values, what each one means, and when to set it.

This looks like a worthwhile small follow-up artifact — call it `sdc-event-error-type-taxonomy.md`, mirror the structure of the phase taxonomy doc — before recipes start writing `error_type` values ad-hoc and you end up with `"network"`, `"network_error"`, `"NETWORK"`, and `"transient_network"` all in the wild.
