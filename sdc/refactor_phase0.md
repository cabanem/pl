# SDC Phase 0 — Plan and Progress

## What Phase 0 is

The design work before any recipe gets built in the new SDC workspace. Five workstreams. The output of each is a small reference document; the output of the whole phase is a coherent set of those documents that anchors the implementation work in Phase 1+.

The discipline of Phase 0: decisions get made once, written down, and not relitigated mid-build.

---

## Workstream status

### 1. Data model redesign — **Done**

Output: `sdc-data-model-v1.md`

Eighteen tables across six groups (Project, Configuration, Supplier, Runtime, Observability, plus a deliberately empty Operational group). Five invariants documented. Two items deferred forward — state machine values and naming conventions — to other workstreams.

### 2. State machine design — **Next**

Output: `sdc-state-machine-v1.md` (not yet created)

Scope: status values across SupplierRequest, Upload, ValidationResult, TemplateVersion; transition graph; derivation rule for `supplier_display_status` and `supplier_message`.

Approach: deep on analysis, lean on output. Open with the two-sentence test (see Working Principles) applied to every status value in the current model. The ones that pass become states; the ones that fail get redirected to EventLog phases, derived display fields, or queries.

Expected length: one focused session, possibly bleeding into a second.

### 3. Naming and prefix conventions — **Pending**

Output: `sdc-naming-conventions-v1.md` (not yet created)

Scope: whether to use prefixes (CFG_, VER_, RUN_, etc.), simpler prefixes, or no prefixes. Field naming. Recipe naming. File and folder conventions in FileStorage and Drive.

Mostly mechanical once the state machine is set, since status values inherit the convention. Probably a short session.

### 4. ADR triage — **Pending**

Output: `sdc-adr-triage-v1.md` (not yet created)

Scope: pass through AD-1 through AD-38. For each, mark as still-applies, obsolete, or needs-revisiting. Some will collapse with the cross-project FKs gone; some will survive intact; a handful may need rewriting against the new model.

One session.

### 5. Callable reuse-vs-rebuild — **Pending**

Output: `sdc-callable-triage-v1.md` (not yet created)

Scope: per existing callable (C-01, C-02, V-00, U-01, plus the SDC Platform Connector and any others), decide port-as-is, port-with-changes, or rebuild. The Connector is already flagged as port-as-is; the rest depends on the three sessions above.

One session. The actual porting/rebuilding is implementation work, not Phase 0.

---

## Dependencies

```
Data model (done)
    │
    ▼
State machine (next)
    │
    ▼
Naming and prefixes
    │
    ▼
ADR triage
    │
    ▼
Callable reuse-vs-rebuild
    │
    ▼
Phase 1: build
```

The chain isn't strictly required — naming could in principle run in parallel with the state machine — but the suggested order keeps each session's decisions consistent with the one before it.

---

## Decisions locked

These came out of the data model session and are settled. Captured here so they're easy to find.

**From workstream 1 (data model):**

1. One project per workspace. `Project` is a singleton; no client-isolation FKs anywhere.
2. Form labels live on `FormSlotMapping`, joined via linked table at WFA render time. The 20 `*_label` columns on the old request table are gone.
3. One observability table. `EventLog` covers both audit logs and incidents; severity plus optional resolution fields distinguish them.
4. `Supplier` extracted from `SupplierRequest`. Survives across template versions; SupplierUser now FKs to Supplier, not Request.
5. `ErrorMessage` per-version copies (snapshot integrity over storage savings).
6. The `current_validation_result_id` relation bug is fixed in v1.
7. `WFA_Cache` is dropped; its responsibilities move to `EventLog` or are handled by the WFA app's own session state.

---

## Working principles

How we run Phase 0 sessions:

**Each session produces its own artifact.** Per-session documents are easier to reference selectively than one accumulating mega-doc. An index doc at the end of Phase 0 ties them together.

**Deep on analysis, lean on output.** Take the time to derive things from scratch and compare against the existing model — that's where the real improvements come from — but the deliverable itself stays small. A reference doc, not a treatise.

**Plain-language framing.** If a concept can't be stated in plain English without hedging, it usually isn't ready yet. This is also a forcing function — clarity in the framing tends to surface vague or redundant design.

**The two-sentence test (for state machine and similar work).** Every candidate state must answer two sentences:

> *The system enters this state when ___.*
> *Being in this state, the system can ___ and cannot ___.*

If the second sentence is empty or redundant with another state, it isn't a real state — it's observability, a derived display, or a query.

**No invented complexity.** States, tables, columns, and ADRs all earn their keep by answering a real question someone needs to ask, or corresponding to a real action the system takes. The default is "leave it out unless something pulls it back in."

---

## Open questions to noodle on

No homework. Just things to surface naturally between sessions if they come up:

- States or transitions in the current model that already feel wrong, missing, or redundant. Even a vague "I don't trust how rejected and rework relate" is useful direction for the state machine session.
- Naming preferences. If you have a strong instinct on prefixes vs no-prefixes, worth saying early.
- ADRs you already know are obsolete or need rewriting.

---

## Artifact index

| File | Workstream | Status |
|------|------------|--------|
| `sdc-data-model-v1.md` | Data model | Complete |
| `sdc-state-machine-v1.md` | State machine | Pending |
| `sdc-naming-conventions-v1.md` | Naming | Pending |
| `sdc-adr-triage-v1.md` | ADR triage | Pending |
| `sdc-callable-triage-v1.md` | Callable reuse-vs-rebuild | Pending |
| `sdc-phase-0-plan.md` | This document | Live |

When all five workstream docs are complete, a short index document will tie them together as the Phase 0 reference set.

---

## Picking up where we left off

When you start the next session, reference the data model doc and say "starting the state machine session." That plus this plan should be enough to resume cleanly.
