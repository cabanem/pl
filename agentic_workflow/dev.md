# Workato Workspace Inspector — Development Infrastructure Plan

**Version:** 1.1-draft · **Date:** 2026-08-21 · **Author:** Emily (Integration Developer, Automation CoE)
**Companion to:** `SOLUTION_DESIGN.md` (references its D1–D9 decisions and M1–M6 milestones)
**Changed in 1.1:** Adapted to the BigQuery standardization (D9): fixture pipeline targets a
dev-project dataset; determinism split into dump byte-identity (local) and derivation
manifest-identity (BigQuery); credential firewall clarified as Workato-absolute with a
sanctioned GCP dev-dataset path; Cloud Build's native identity noted as the CI synergy.

---

## 1. Purpose and governing principle

This document specifies the infrastructure that makes agent-delegated development safe and
productive for this project. Its governing principle:

> **An agent-friendly repo is one where "done" is verifiable without trusting the agent's
> word for it.**

The same commitments that shape the product — deterministic ground truth, bounded tools,
machine-checkable evidence — apply to its construction. Every component below exists to
make some class of task delegable by making its exit condition executable.

Three working principles fall out of this:

- **P1 — Fixture-first.** Builder agents never touch real workspaces or Workato
  credentials — ever. All acquisition- and derivation-adjacent work runs against the
  synthetic fixture, derived into the **dev project's fixture dataset** (`wwi_fixture`).
  The dev dataset is the sanctioned GCP surface; production and standing datasets are
  off-limits to builder agents.
- **P2 — Executable exit tests.** A task is delegable when, and only when, its completion
  criterion is a command the agent can run and the reviewer can re-run.
- **P3 — Invariants as fences, not folklore.** The solution spec's decision log (D1–D9) is
  restated where agents will read it, phrased as prohibitions, so no agent "helpfully"
  refactors an invariant away.

## 2. Component inventory

### 2.1 Ground truth agents can run against

**C1 — Fixture workspace.** A small, sanitized, fully synthetic Workato snapshot checked
into the repo (`fixtures/snapshot/`), exercising every structure `derive.py` handles:
recipe call edges, data-table reads and writes, both enrichment styles, the sidecar file
guard case, and a UUID-keyed table write. `make derive-fixture` stages it to the dev
bucket's fixture prefix and derives it into `wwi_fixture` in the dev project. This remains
the highest-leverage component: it makes the dump→derive→query→answer pipeline verifiable
without any Workato credential, in well under a minute, at negligible query cost (the
fixture is deliberately tiny). *Build note:* derive it from a real snapshot once, then
sanitize and shrink by hand; document the sanitization pass so provenance is auditable.
*Exit:* `make derive-fixture` completes and `make test-bq`'s manifest check passes.

**C2 — Determinism tests, split by layer.** (a) **Dump byte-identity, local:** two runs of
the dump logic over the same input produce byte-identical snapshot files — this remains a
pure local test. (b) **Derivation manifest-identity, BigQuery:** deriving the fixture
twice yields identical table contents, asserted as manifest equivalence — per-table row
counts plus content fingerprints (e.g., `BIT_XOR(FARM_FINGERPRINT(...))` per table) —
because load jobs have no byte-identity notion. Together these keep the project's
foundational property executable. *Exit:* (a) runs in `make test`; (b) runs in
`make test-bq`; both run in CI on every change.

**C3 — View tests as SQL assertions.** Every view in `views.sql` gets at least one
known-answer query against the fixture dataset. Because D3 makes "add a view" the
system's entire extension model, this turns the most common future change into a fully
self-checking agent task. *Exit:* a view without an assertion fails CI.

**C4 — Calibration harness (dual role).** The M1 calibration set, wired into ADK's
evaluation framework at M2, doubles as the acceptance harness for any delegated
judgment-layer task: an agent claiming completion runs the eval and reports the score
with transcripts. Gold answers are verified against the fixture dataset where possible
(portable, shareable) and against the standing SDC dataset only where a question is
estate-specific. *Exit:* `make eval` runs the set end-to-end and emits a scored report.

### 2.2 Context agents read

**C5 — `AGENTS.md` (builder-agent brief).** Deliberately distinct from `BRIEF.md`, which
instructs the agent *inside* the product. Contents: the spine diagram; D1–D9 restated as
prohibitions ("never write to Workato", "never break dump determinism", "never add a tool
where a view suffices", "never touch Workato credentials — fixture only", "never touch a
non-fixture dataset"); the blessed command vocabulary (C6); pointers to `views.sql` as
the view catalog of record; and the task-brief format (C11). Mirrored into Antigravity's
rules mechanism so both surfaces read the same fences. *Exit:* the file exists, and a
spot-check task confirms an agent cites it unprompted when declining an
invariant-violating instruction.

**C6 — Canonical command vocabulary.** A Makefile exposing the blessed verbs:
`make setup`, `make test` (local: unit, dump determinism, canary), `make test-bq`
(fixture derive-dependent: manifest check, view assertions), `make derive-fixture`,
`make eval`, `make lint`, `make scan-secrets`. Agents perform markedly better with a
handful of blessed commands than with freedom to invent invocations, and reviewers get
reproducibility for free. *Exit:* every exit test in this document and the solution
spec's roadmap is expressible as one of these commands.

**C7 — Doc currency as a task-exit requirement.** Any delegated task that changes
behavior updates the affected doc (`README.md`, `GUIDE.md`, `BRIEF.md`, or this file) in
the same change. Rationale: stale docs mislead agents worse than they mislead their
author — the author knows what's outdated; the agent doesn't. *Exit:* the task-brief
template (C11) carries a docs checkbox that reviewers actually enforce.

### 2.3 Guardrails bounding the blast radius

**C8 — Credential firewall (Workato-absolute).** Three layers: (1) policy — builder
agents never see Workato credentials, stated in C5 and never excepted; GCP-side, agents
use ambient ADC against the dev project's fixture dataset only; (2) prevention — secret
scanning (gitleaks) as a pre-commit hook *and* a CI job; (3) detection — a canary test
that runs the pipeline against the fixture with a canary token pattern in env and greps
all produced logs, snapshot files, and artifacts for it. Layer 3 mechanizes milestone
M4's exit test instead of leaving it a manual audit. *Exit:* the canary test exists and
fails loudly when a deliberate leak is introduced.

**C9 — CI as the neutral referee.** Cloud Build, triggered on every change, with
`cloudbuild.yaml` written as a thin wrapper over the same Makefile targets used locally
(C6) — running lint, `make test`, and the secret scan always; `make test-bq` using Cloud
Build's own service identity (granted `dataEditor` on `wwi_fixture` and nothing else —
**no secrets to manage**, the quiet payoff of GCP-native CI); and the eval (C4) on
judgment-layer changes. The honest rationale: AI leverage moves the bottleneck from
writing code to reviewing it, and CI spends review attention on substance rather than
"does it run." *Exit:* no change lands without a green pipeline, including the author's
own.

**C10 — Lint, format, and type configuration.** Ruff and pyright configs checked into
the repo with the strictness decided once, up front. Agents follow configured standards
near-perfectly and remembered standards barely at all; this is the cheapest consistency
purchase available. *Exit:* `make lint` is green and CI-enforced from the first commit.

### 2.4 Workflow shape

**C11 — Task-brief template.** Every delegated task states, up front: objective, files in
scope, invariants touched (by D-number), the executable exit test, and the docs to
update. A worked template lives at the end of this document.

**C12 — Reusable Antigravity workflows for recurring change types.** First candidate:
the "add a view" pipeline — write view in `views.sql` → add SQL assertion (C3) → run
eval (C4) → update `BRIEF.md` → green CI. Since D3 makes view promotion the system's
entire extension model, this single workflow covers the majority of expected future
changes. Second candidate, later: "extend the fixture" for when derivation gains a new
structure. *Exit:* the add-a-view workflow has run end-to-end at least once (this is
milestone M6's exit test, delegated).

## 3. Sequencing against the roadmap

| Component | Build when | Rationale |
|---|---|---|
| C1 fixture, C2 determinism, C6 commands, C10 lint | **Before/alongside M1** | M1 gold answers verified against the fixture dataset are portable; everything downstream assumes these exist |
| C5 AGENTS.md, C11 template | Before the first delegated task | The fences precede the agents |
| C3 view assertions, C8 firewall, C9 CI | Alongside M2 | The judgment layer is the first substantial delegated build |
| C4 harness | M2 (per solution spec) | — |
| C7 doc currency, C12 workflows | By M6 | Hardening-phase machinery |

The load-bearing observation stands: C1 wants to exist *before* M1 completes. Gold
answers verified against the fixture dataset are rerunnable by anyone — including
agents and CI — in a way that answers verified against the standing estate are not.

## 4. Risks specific to AI-leveraged development

- **Over-delegation.** Tasks without executable exit tests get delegated anyway and come
  back plausible-but-wrong. Control: P2 is a hard rule — no runnable exit test, no
  delegation.
- **Review bottleneck.** Agent throughput exceeds review capacity and pressure builds to
  rubber-stamp. Control: C9 filters mechanical issues; C11 keeps tasks review-sized;
  accept that review is now the job.
- **Invariant erosion.** An agent optimizes away a property it doesn't understand (dump
  determinism and the `input_json` nulling guard are the likeliest casualties). Control:
  C2 and C3 make invariants fail tests instead of failing silently; C5 makes them
  legible.
- **Cloud-coupled tests.** D9's accepted cost: `test-bq` needs ADC and network, adds
  seconds of latency, and incurs (tiny) query cost. Controls: the local/`test-bq` split
  keeps the fast loop fast; the fixture stays small. The community BigQuery emulator was
  considered and rejected — its dialect coverage gaps would make green tests untrustworthy
  precisely where dialect fidelity matters most.
- **Fixture drift.** The fixture stops resembling real workspaces as Workato evolves.
  Control: when M3 runs against a real second workspace, diff the structures encountered
  against fixture coverage and extend deliberately (C12's second workflow).

## 5. Task-brief template (worked example)

    Task: Add v_datapill_consumers view
    Objective: Promote the proven datapill-trace query to a named view.
    In scope: views.sql, tests/views/test_datapill_consumers.sql, BRIEF.md
    Invariants touched: D3 (views are the API), D2/D4 (no derivation or role changes
      expected; flag if that assumption breaks)
    Exit test: make test-bq && make eval — new assertion passes, eval score does not
      regress
    Docs: BRIEF.md view catalog updated in the same change
    Out of scope: corpus.py tool changes of any kind (would violate D3's promotion
      condition)

## 6. References

- `SOLUTION_DESIGN.md` — decisions D1–D9, milestones M1–M6
- ADK evaluation framework: https://google.github.io/adk-docs/
- Antigravity workflows and rules: https://antigravity.google/product
