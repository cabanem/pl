# Workato Workspace Inspector — Solution Design Specification

**Version:** 1.1-draft · **Date:** 2026-08-21 · **Author:** Emily (Integration Developer, Automation CoE)
**Status:** Facts layer built and proven (BigQuery-native); Cloud Run serving bundle built,
awaiting verification; ADK agent and session model specified here, not yet built.
**Changed in 1.1:** Standardized on BigQuery as the sole fact store (D9); asset inventory
aligned to the actual deployment bundle (`dumps.py`, `derive.py`, `views.sql`, `corpus.py`,
Terraform); tool-surface guards promoted into the contract (§4.1).

---

## 1. Purpose of this document

This spec defines the **Workato Workspace Inspector**: a read-only Q&A agent that answers
structural, dependency, and impact questions about any Workato workspace a teammate can
present credentials for — with a machine-readable evidence trail. It records what already
exists, what remains to be built, and the goals, invariants, and sequenced milestones for
building it. It is written decision-log style: each choice states what was decided, why,
and what would earn revisiting it.

## 2. Background and problem statement

Workato estates at scale (the SDC platform alone is ~58 production recipes; the wider
analyzed estate ≈77) generate questions that recipe-by-recipe reading answers slowly and
unreliably: "who writes `WFA_SupplierRequest.template_file_id`?", "what's the call chain
below UPL-01?", "what changed since last week?" Earlier tooling attempts were unwieldy for
a diagnosable reason: acquisition, parsing, and answering all lived in one place with no
query layer, so every new question meant new traversal code.

The solution rests on one architectural commitment:

    facts  →  tools  →  judgment  →  evidence

A deterministic pipeline turns recipe JSON into queryable facts (BigQuery). A bounded,
read-only two-tool surface exposes those facts. A model adds judgment on top. Every claim
traces back through a logged tool call to a row to a raw capture in versioned object
storage. The model is never asked to parse recipe JSON, and nothing the model does can
write anything.

Three sizing decisions shape everything downstream:

1. **Multi-workspace by design.** The tool accepts a Workato API token and folder ID at
   runtime, so any authorized teammate can inspect any workspace they hold credentials
   for. Acquisition is therefore on-demand and session-scoped, and credential handling is
   a first-class design constraint.
2. **Framework over hand-roll.** The agent loop, evaluation harness, and serving runtime
   are bought, not built: ADK for the agent and evals, a managed runtime for serving.
   First-party code is domain logic — derivation, views, tool guards — not plumbing.
3. **One store, one dialect.** BigQuery is the only fact store; SQLite is retired (D9).
   Dataset lifecycle — ephemeral per-session vs standing per-workspace — is the sole mode
   knob, which is what lets one codebase serve both interactive inspection and scheduled
   estate monitoring.

## 3. Mission, goals, non-goals

**Mission.** Give any authorized teammate evidence-backed answers to structural,
dependency, and impact questions about any Workato workspace they can present credentials
for.

**Goals.**

- G1 — Deterministic, read-only fact acquisition over any workspace/folder at runtime;
  single-writer derivation.
- G2 — Every answer traceable through a logged tool call to a row to a captured snapshot.
- G3 — Prefer known GCP patterns (ADK agent, managed runtime, BigQuery) so first-party
  code is domain logic, not plumbing.
- G4 — Session-scoped multi-tenancy; interactive credentials never at rest; no
  cross-session reads.
- G5 — Extension stays declarative: new capability = new SQL view, gated by calibration.

**Non-goals.**

- Writing to Workato in any form (the acquisition client is GET-only by construction).
- Real-time sync or change notification. Snapshots are point-in-time; drift detection
  between snapshots (§4.5) is a query over history, not a sync mechanism.
- Storing *interactive* workspace tokens at rest. Standing-mode credentials are a
  separate, opt-in class (D5).
- Replacing anything Workato's own UI already does well.

## 4. Architecture

### 4.1 The spine

- **Facts.** `dumps.py` pulls recipe code and data-table schemas from the Workato
  Developer API into deterministic snapshot dumps in GCS (stdlib-only, GET-only;
  configured by env: `WORKATO_API_TOKEN`, `GCS_BUCKET`, `SDC_DUMP_DIR`, folder ID).
- **Derivation.** `derive.py` loads a GCS snapshot into a BigQuery dataset. It is the
  **only writer** — enforced by IAM, not convention: the deriving identity alone holds
  `bigquery.dataEditor` on the dataset. Snapshot ids are INT64 epoch seconds, so `MAX()`
  is a real ordering. `views.sql` (deployed alongside derivation) is the authoritative
  view catalog.
- **Tools.** Two, deliberately, implemented in `corpus.py` with contract-level guards:
  `query(sql)` — SELECT/WITH only, single-statement enforced, row-capped with an explicit
  `truncated` marker, `steps.input_json` nulled in results so bulk payloads cannot flow
  through the query path, and every result echoing `latest_snapshot` — and
  `get_step(recipe_id, step_path)` — the one sanctioned drill-down, with data-table field
  keys rewritten to readable names. The **views are the API**; extending the system means
  writing a view in `views.sql` — declarative, testable in a SQL console, no dispatch
  code. Real read-only enforcement is IAM: the answering identity holds
  `bigquery.dataViewer` + `jobUser` only; the SQL regex is a courtesy error, not the fence.
- **Judgment.** An ADK agent reasons over tool results, instructed by `BRIEF.md`
  (BigQuery dialect — the single brief; the SQLite-dialect brief is retired). It never
  parses raw recipe JSON.
- **Evidence.** Tool calls are logged to stdout for native Cloud Logging ingestion;
  answers cite rows; rows trace to snapshot ids; snapshot dumps live in versioned GCS.

### 4.2 Components

| Layer | Component | Status |
|---|---|---|
| Acquisition | `bin/dumps.py` (env-driven: token, bucket, prefix, folder) | Built and proven |
| Derivation | `bin/derive.py` (GCS snapshot → BigQuery dataset) + `views.sql` | Built and proven |
| Tool surface | `bin/corpus.py` — `query` + `get_step` with the §4.1 guards | Built and proven |
| Judgment | ADK agent wrapping `corpus.py`'s functions; instruction from `BRIEF.md` | To build (M2); FastAPI loop exists as interim |
| Serving | Vertex AI Agent Engine (leading candidate) vs the existing Terraform Cloud Run bundle (service + pipeline Job, IAM invoker auth) | Bundle built, unverified (one token check from proof); decision at M5 (Q1) |
| Session model | Per-session dataset lifecycle, credential handling | To build (M3–M4) |
| Storage | Versioned GCS snapshot bucket; BigQuery datasets (ephemeral or standing) | Bucket + standing dataset built; session lifecycle to build |
| Infra-as-code | Terraform (service, job, dataset, bucket, IAM) | Built |
| Dev-time | Antigravity as workshop; ADK dev UI for local runs | Available; not the serving layer |

### 4.3 Session runtime flow

1. Session opens; user supplies Workato API token + folder ID.
2. Credential check: one cheap authenticated GET validates the token and resolves
   workspace identity. Failure ends the session before any pull.
3. Acquisition: `dumps.py` runs scoped to the folder; the snapshot lands in versioned GCS
   under a workspace/session prefix.
4. Derivation: `derive.py` loads the snapshot into a **per-session BigQuery dataset**
   (e.g., `wwi_s_<session>`), created with a default table expiration as a
   belt-and-suspenders TTL.
5. Q&A loop: the ADK agent answers through `corpus.py`'s two tools; the agent's identity
   holds `dataViewer` + `jobUser` on that dataset only; every tool call is logged to the
   session's evidence trail.
6. Session close: token discarded from memory; the session dataset is deleted (or lapses
   via expiration — Q3); the snapshot remains in GCS as evidence per bucket versioning.

**Standing mode** (the estate-monitor shape, e.g., the SDC platform itself): identical
pipeline, but the dataset is durable (e.g., `workato_agent_store_prd`), acquisition runs
as a scheduled Cloud Run Job with credentials in Secret Manager (the D5 opt-in class),
and snapshot history accumulates — enabling drift analysis (§4.5).

### 4.4 Acquisition parameterization

`dumps.py` is already env-driven, including a folder-ID input — so runtime
parameterization is largely built. **To verify at M3:** the folder input's exact
semantics (server-side `folder_id` filtering vs client-side post-filter), and that no
single-workspace assumption survives anywhere else. The snapshot manifest records scope
either way, so evidence claims stay honest.

### 4.5 Drift analysis (standing mode only)

Where a dataset retains multiple snapshots, `v_recipe_drift` classifies every recipe as
added / removed / changed / unchanged between the two most recent captures — turning a
scheduler into a change monitor for the whole estate. Ephemeral session datasets, holding
one snapshot, do not offer drift; repeat inspection of the same foreign workspace earns
history only if Q2 resolves toward workspace-keyed dataset reuse.

## 5. Existing assets

**Built and proven.** The full acquisition-to-tools chain: `dumps.py`, `derive.py`,
`views.sql`, `corpus.py` (guards included), the deterministic snapshot format, the
versioned GCS bucket, and the standing SDC dataset. The Terraform bundle: Cloud Run
service + pipeline Job sharing one image, dataset, bucket, single runtime SA, invoker
IAM — deployed, container healthy (uvicorn confirmed), pending one client-side token
verification. `Dockerfile` and `scripts/run_pipeline.sh` encode the proven build/run
shape, including the `__file__`-anchored BRIEF resolution (a documented trap — see §10).

**Written and reusable.** `BRIEF.md` (BigQuery dialect — the canonical brief),
`README.md`, `GUIDE.md`, `CASE_STUDY.md` (PMLE-mapped), a `DEPLOY.md` runbook, and the
calibration question set (partially authored — completing it is M1).

**Banked knowledge feeding this build.** GCP identity traps (ADC vs gcloud credential
planes; identity-token audience under SA impersonation; stale-token 401 vs
invoker-binding 403); Workato data-layer traps (two table identities, enrichment styles,
sidecar file guard, UUID-keyed table writes); the CWD-vs-`__file__` doctrine-loss trap;
Python↔Workato boundary knowledge. These inventories are inputs to the security model,
the test suite, and the Field Notes.

## 6. Security and multi-tenancy model

- **Interactive tokens are ephemeral.** Session memory only; never written to snapshots,
  logs, evidence artifacts, or the dataset; redaction guard on all outbound logging
  paths. Standing-mode credentials are the explicit exception: Secret Manager, scoped to
  the pipeline Job's identity, one per monitored workspace (D5).
- **GET-only is a stated invariant,** not an implementation detail: the acquisition
  client is incapable of writes against Workato. This is the load-bearing claim that
  makes "point it at any workspace" a reasonable thing to allow.
- **Isolation is a dataset boundary.** One BigQuery dataset per session; the agent
  identity is granted `dataViewer` on that dataset alone, so cross-session reads are an
  IAM impossibility, not a code promise. Any cache (Q2) is keyed by workspace identity +
  folder + snapshot content hash — never anything credential-derived.
- **Single-writer and read-only are IAM facts.** Deriver identity: `dataEditor`. Agent
  identity: `dataViewer` + `jobUser`. No identity holds both roles on the same dataset.
- **Audit.** Tool-call log per session (query text, row counts, snapshot id, timestamps —
  no credentials) to Cloud Logging, satisfying G2 without expanding the attack surface.

## 7. Design decision log

- **D1 — Facts/judgment split.** The model never parses recipe JSON. *Revisit:* never;
  this is the spine.
- **D2 — Single-writer derivation.** Only the deriving identity can write the dataset,
  enforced by IAM role separation. *Revisit:* never.
- **D3 — Two tools; views are the API.** Growth path is SQL views in `views.sql`
  promoted from proven queries. *Revisit:* only if calibration shows the agent fumbling
  a question class despite brief + view — then, and only then, mirror that view as a
  declared tool.
- **D4 — Read-only everywhere.** GET-only against Workato; `dataViewer`-only agent
  identity against BigQuery, with `corpus.py`'s SELECT/WITH guard as fast-feedback
  courtesy. *Revisit:* never for Workato; the store side relaxes only if a future
  feature writes agent annotations, which would get its own dataset instead.
- **D5 — Interactive credentials never at rest.** Standing scheduled monitoring is a
  separate, opt-in credential class: Secret Manager, Job-scoped, per-workspace. The SDC
  estate monitor is the first member of that class. *Revisit:* n/a — the class now
  exists; membership stays opt-in per workspace.
- **D6 — Buy the chassis, build the domain.** ADK for the agent loop and evals; a
  managed runtime for serving; BigQuery for the store; first-party code is derivation,
  views, and tool guards. *Revisit:* if framework churn ever costs more than the
  plumbing it replaces — measure by time spent framework-chasing per quarter.
- **D7 — Antigravity is the workshop, not the product.** *Revisit:* if Google ships a
  sanctioned way to share Antigravity-hosted agents org-wide with credential handling
  that meets §6.
- **D8 — Calibration as the promotion gate.** *Revisit:* never; grow the set instead.
- **D9 — One store, one dialect.** BigQuery everywhere; SQLite retired; one BRIEF.
  Dataset lifecycle (ephemeral session vs standing workspace) is the only mode knob.
  Accepted cost: tests that exercise derivation and views require a dev-project dataset
  rather than running hermetically offline (see `DEVELOPMENT_INFRASTRUCTURE.md` C1–C3).
  *Revisit:* if per-session dataset churn hits quota or cost walls, shift to
  per-workspace datasets with snapshot-scoped access instead of reopening the store
  question.

## 8. Roadmap — milestones with exit tests

- **M1 — Calibration set.** Finish authoring the question set (ten questions to start)
  with gold answers verified by hand against the fixture dataset. *Exit:* every question
  has a documented gold answer and the evidence rows that support it.
- **M2 — ADK agent, locally.** Wrap `corpus.py`'s `query` and `get_step` as ADK function
  tools (guards intact, verbatim where possible); seed the instruction from `BRIEF.md`;
  wire M1 into ADK's evaluation framework. The FastAPI loop remains untouched as the
  interim reference implementation. *Exit:* the calibration set passes the agreed rubric
  (target: ≥8/10 evidence-backed correct) through ADK eval.
- **M3 — Session acquisition.** Verify `dumps.py`'s folder semantics (Q5); remove any
  residual single-workspace assumptions; derive into a per-session dataset. *Exit:*
  dump + derive against a second, unfamiliar workspace with zero code edits, landing in
  an ephemeral dataset.
- **M4 — Session and security model.** Ephemeral credential handling, dataset-boundary
  isolation, IAM role separation, audit log, redaction guard. *Exit:* token provably
  absent from logs, snapshots, and artifacts; two concurrent sessions demonstrably
  unable to read each other's datasets.
- **M5 — Deploy for colleagues.** Resolve Q1 with a short written comparison — the
  Terraform bundle (verified by then, ideally) vs Agent Engine — and ship the winner.
  *Exit:* a colleague completes a real analysis of a workspace the author has never
  seen, unaided.
- **M6 — Hardening.** Calibration becomes a regression gate on every view change; Field
  Notes updated with traps found during the build. *Exit:* one full change (a new view
  in `views.sql`) lands through the gate end-to-end.

## 9. Open questions and decision points

- **Q1 — Agent Engine vs the Cloud Run bundle for serving.** The bundle exists and is
  one token check from verified; Agent Engine offers managed sessions and less identity
  plumbing (which this project has demonstrably paid for in debugging time). Decide at
  M5 with a short written comparison — cost model, session-dataset lifecycle management,
  and how colleagues actually reach the tool.
- **Q2 — Dataset reuse across sessions.** Always derive into a fresh ephemeral dataset
  (simplest, honest) vs reuse a workspace-keyed dataset when the snapshot content hash
  matches (cheaper for repeat sessions, and it accrues drift history for foreign
  workspaces). Default: fresh, until repeat-session frequency proves reuse worth its
  lifecycle logic.
- **Q3 — Session dataset retention.** Delete at close vs lapse via table expiration.
  Expiration is the belt-and-suspenders floor either way; the question is whether
  deletion is eager. Interacts with Q2.
- **Q4 — Colleague front door.** ADK's dev UI is dev-time only; the bundle's `/ask` API
  has no UI. Options ordered by effort: Agent Engine's own surfaces, a minimal thin UI,
  or Gemini Enterprise integration if the org adopts it. Decide at M5; do not build a
  UI before then.
- **Q5 — Folder scoping semantics.** `dumps.py` already accepts a folder ID; verify at
  M3 whether filtering is server-side or client-side, and record the answer in the
  snapshot manifest.
- **Q6 — Token scoping guidance.** Recommend colleagues mint least-privilege Workato
  API clients (read-only roles) rather than personal full-scope tokens; document the
  minimal scope set the dump actually needs.

## 10. Known limitations

Recorded properties of the facts layer: positional-diff noise in snapshot comparisons;
two-provider edge blindness in the call graph; derivation-version conflation across
snapshots. Multi-workspace operation adds two: (1) a session snapshot of an unfamiliar
workspace arrives with none of the SDC estate's curated context, so the agent brief must
degrade gracefully from "knows this platform" to "knows Workato structures generally";
(2) drift analysis requires snapshot history and therefore exists only in standing mode
or under Q2-style dataset reuse. One trap is now a standing test requirement: ancillary
files (`BRIEF.md`, `views.sql`) must resolve via `__file__`, never CWD, and their absence
must fail loudly at startup — silent doctrine loss is the failure mode this guards.

## 11. Risks

- **Framework churn.** ADK and Agent Engine are evolving quickly; pin versions, adopt on
  a cadence, and measure D6's revisit metric honestly.
- **Credential mishandling** is the highest-severity risk class; M4's exit test is the
  control, and it runs before any colleague touches the tool. Standing-mode secrets add
  a second, smaller surface: Secret Manager bindings audited per workspace.
- **Dataset lifecycle leaks.** Ephemeral datasets that outlive their sessions accumulate
  cost and data; table expiration is the floor, deletion-at-close the policy (Q3), and a
  sweep job the backstop.
- **Scope creep via "any workspace."** The tool answers structural questions; it is not
  a linter, a migration tool, or a governance dashboard. New question classes earn views
  through D8, nothing else.
- **Eval set staleness.** A set calibrated on one estate under-tests foreign workspaces;
  grow it with a few questions per new workspace class inspected.

## 12. References

- ADK documentation: https://google.github.io/adk-docs/
- Vertex AI Agent Builder overview: 
  https://cloud.google.com/vertex-ai/generative-ai/docs/agent-builder/overview
- Antigravity: https://antigravity.google/product
- Repo artifacts: `README.md`, `GUIDE.md`, `BRIEF.md`, `CASE_STUDY.md`, `DEPLOY.md`,
  `views.sql`, `terraform/`, extraction bundle `SETUP.md`
