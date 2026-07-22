# SDC Persona Test Scripts — Per-Script Scoring Rubrics

*Companion to `sdc-persona-test-scripts-v1.md`. One rubric table per script. Each
criterion row is projected from that script's expected results; nothing is scored
here that isn't specified there.*

---

## How to read the rubrics

**Universal scoring bands** — apply to every script; per-script tables don't repeat them.

| Instrument | Strong | Acceptable | Concern |
|---|---|---|---|
| Completion | Unaided (U) | Assisted (A) — intervention noted | Failed (F) |
| Ease (SEQ 1–7) | 6–7 | 5 | ≤ 4 |
| Comprehension probe | 1.0 (matches key) | 0.5 (partial) | 0 (missed) |
| Time-on-task | Recorded, not graded, until run 1 sets the baseline; thereafter ±25% of baseline is Acceptable | | |

**Script verdict rule** — a script **passes** when every criterion row meets its
standard and no Blocker or Major defect was logged during it. One Concern-band
instrument with all criteria met = pass with a noted watch item.

**Severity column** — the defect severity to log if that criterion is missed
(Blocker / Major / Minor, matching the tracker vocabulary).

---

## Supplier persona

### S-01 · Invitation receipt and orientation — *Supplier · Probes P1, P2 · no gate*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Invitation usable | Observation | Email renders; template downloads on first attempt | Broken layout, dead or multi-step link | Major |
| Portal findable | Observation | Task located from the email without help | Coordinator had to point | Major |
| Ask understood | Probe P1 | States the ask and deadline correctly | Wrong or missing either | Major |
| Status understood | Probe P2 | "Action is mine — complete and submit" | Believes they're waiting on us | Major |
| Read-only browsing | Backend check | Protected status columns byte-identical before/after | Any change | Blocker |

### S-02 · Template comprehension and data entry — *Supplier · no probes · no gate*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Instructions land | Observation | Enters data guided by the banner alone | Hunts for editable cells, asks for help | Minor |
| Protection holds | Observation | Locked cells refuse edits with the protection message | Any locked cell editable | Major |
| Dependent dropdowns | Observation | Child list narrows to the chosen parent; re-choosing parent refreshes it | Full unfiltered list, or stale child options | Major |
| Validation enforces | Observation | Non-list entries rejected at entry | Free text accepted in a list field | Major |
| Formats hydrate | File inspection | Dates and currency render in intended formats | Raw serials or plain numbers | Minor |
| Reference sheet hidden | Observation | Tester never needs or sees it | Visible or required | Minor |

### S-03 · First submission, clean file — *Supplier · Probe P3 · no gate*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Upload succeeds | Observation | Accepted first attempt, confirmation shown | Retry needed, or no confirmation | Major |
| Status advances | Observation | Surface moves to neutral "received / under review" | Stale, blank, or error status | Major |
| Next step understood | Probe P3 | "Nothing — it's with them now" | Believes further action is theirs | Major |
| Pipeline completes | Backend check | Upload + validation rows persisted; verdict `passed`; state `pending_review` | Any stage missing | Blocker |
| Latency tolerable | Timestamps | Submit → visible status change recorded (baseline metric) | — (recorded, not graded, run 1) | — |

### S-04 · Status comprehension and information exposure — *Supplier · Probe P4 (thesis) · expectation depends on E3*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Blind pair indistinguishable | Probe P4 | Cannot tell passed from failed submission | Distinguishes them, for any reason | Major |
| No verdict exposure | Exposure inventory | No element shows verdict tokens, invalid-row counts, or field errors | Any leak, however indirect | Major |
| Message quality | Observation | Neutral copy reads professional and truthful | Alarming, evasive, or broken copy | Minor |
| E3 = no mode | Evidence capture | Leaking elements screenshotted and logged against WFA-013 as one Major | Treated as a new finding | — |

### S-05 · Rework loop — *Supplier · Probe P5 (thesis) · chained from A-04*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Rework noticed | Observation | Found via email/portal unprompted | Coordinator had to prompt | Major |
| Feedback understood | Probe P5 | Restates the analyst's note accurately | Misreads what to change | Major |
| Correction made | File inspection | The noted issue — and only it — corrected | Wrong or additional changes from confusion | Minor |
| Resubmission lands | Observation + backend | Accepted; status returns to under-review; state loop SAR → pending_review; attempt counter +1 | Any step absent | Blocker |
| Time split | Timestamps | Time-to-notice and time-to-resubmit recorded separately | — | — |

### S-06 · Still-failing resubmission from rework — *Supplier · no probes · **GATED: E2 = yes** · HAZARD*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Gate respected | Pre-flight | Run with a tester only when E2 = yes | Run against known stall | — |
| Upload accepted | Observation | No error page, no rejection | Visible failure | Major |
| State advances | Backend check (headline) | Request reaches `pending_review`; no stall after writes | Accepted upload that never advances | Blocker |
| Supplier messaging | Observation | Neutral under-review copy; failure is the analyst's to discover | Verdict exposed or status stuck | Major |

### S-07 · Approval and terminal comprehension — *Supplier · Probe P6 · chained from A-02*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Closure noticed | Observation | Confirmation found unprompted | Missed it | Minor |
| Done-ness understood | Probe P6 | "Nothing left — complete" | Expects further steps | Major |
| No residual CTAs | Observation | No lingering upload button or open task inviting action | Any actionable leftover | Major |

### S-08 · Bad-file submission — *Supplier · Probe P7 per file · mode-sensitive*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Never a dead end | Observation, all 3 files | Every attempt yields an intelligible outcome | Raw error, stack trace, or silence | Blocker |
| Unmodified template | Observation + backend | Handled as empty/no-data with clear message (pilot: neutral routing) | Confusing or missing outcome | Major |
| Wrong file type | Observation + backend | Rejected or handled as structural failure, message actionable | Accepted silently or crashes | Major |
| Next move inferable | Probe P7 per file | Tester states correct next step each time | Guesses wrong | Major |
| Verdict hygiene | Backend check | Verdicts land `empty` / `structural_failure`; never `error` | Any `error` verdict | Blocker |
| Default-mode delta | Observation | Corrective feedback returns directly; feedback text itself scored actionable | — | Major |

### S-09 · Expired template link — *Supplier · documentation probe · known gap (E5 = no)*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Failure surface captured | Screenshot + notes | Exact error experience recorded | Not reproduced | — |
| Recovery path assessed | Observation | Presence/absence of any recovery documented | — | — |
| Support-load datum | Tester statement | Tester's stated next action recorded (typically "email the sender") | — | — |
| Logged correctly | Defect log | One Major, tagged known-gap / Workflow 7 | Logged as new finding | — |

---

## Analyst persona

### A-01 · Queue discovery and triage — *Analyst · Probe P8 · mode-sensitive*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Queue exact | Observation vs staging | Shows exactly the pending_review items; no terminal or supplier-owned states | Any extra or missing item | Major |
| Count correct | Probe P8 | Pilot: 2, both named; default: 1 | Wrong count or items | Major |
| Triage data visible | Observation | Supplier, arrival time, wait time readable per item | Any of the three absent | Minor |
| Found unaided | Observation | Workspace and queue located without help | Coordinator pointed | Major |

### A-02 · Review and approve a clean submission — *Analyst · no probes · no gate*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Materials reachable | Observation | Verdict and submitted file both reached without hunting | Either required searching or help | Major |
| File intact | Observation | Downloads, opens, contains the staged data | Corrupt or wrong file | Blocker |
| Approve completes | Observation | Action succeeds with note; item exits queue (note if refresh needed) | Fails or item lingers | Major |
| Consistency triad | Backend check | State `approved` + snapshot at `/approved/…` byte-matching submission + note persisted with action `approve` | Any leg missing | Blocker |
| Supplier surface | Backend check | Terminal derivation shown supplier-side | Stale status | Major |

### A-03 · Review a failed submission — *Analyst · Probes P9, P10 · pilot-specific*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Verdict visible | Probe P9 | States failed + correct problem count from the surface alone | Cannot answer without help | Major |
| Error recall | Findings vs key | All 3 planted errors found, attributed to row and field | < 3/3 with data present = findability defect | Major |
| Rework-ready detail | Observation | Errors specific enough to write a rework note from | Vague or unattributed errors | Major |
| Decision reasoned | Probe P10 | Chooses rework, citing at least one planted error | Approves, or cannot justify | Major |

### A-04 · Request rework with a note — *Analyst · feeds S-05/P5 · no gate*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Action completes | Observation | Rework sent with specific note; item leaves active queue | Fails, or note optional-skipped | Major |
| Note persisted | Backend check | Stored with action `rework`, visible in history | Missing or mislabeled | Major |
| Handoff fires | Backend check | State `supplier_action_required` via analyst context; supplier surface shows corrective copy + note | Any step absent | Blocker |
| In-flight visibility | Observation | Where the item is now trackable analyst-side recorded | Vanishes entirely | Minor |
| Handoff fidelity | Downstream S-05 / P5 | Supplier's P5 score is this script's true fidelity measure | — | — |

### A-05 · Full-cycle history integrity — *Analyst · Probe P11 · chained from A-04 → S-05 → A-02*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Timeline reconstructable | Probe P11 | Both submissions and both decisions, in order, with dates, from the record alone | Gaps or wrong order | Major |
| Notes complete | Observation | Rework note then approval note, in sequence | Either missing | Major |
| Attempts distinguishable | Observation | The two uploads clearly separate entities | Conflated | Major |
| Approved-file mapping | Observation + backend | Snapshot unambiguously maps to the second submission | Any ambiguity about which file was approved | Major |

### A-06 · Seeded-data review gate — *Analyst · Probe P12 · **GATED: E4 = yes***

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Pending list exact | Probe P12 | Exactly the staged item (control absent); manifest summary legible unopened | Wrong list or unreadable manifest | Major |
| Bytes verifiable | Observation | Seeded template downloads; spot-check matches manifest | Mismatch | Major |
| Block is absolute | Backend check | Pre-approval invitation refused with **zero side effects** — no email sent, no link shared | Anything left the building | **Blocker** |
| Approval unlocks | Observation | Invitation proceeds normally post-approval | Still blocked | Major |
| Reseed voids | Observation + backend | Item reappears pending; stored fingerprint ≠ current bytes; no manual flag-clearing involved | Stale approval honored | Blocker |
| Audit trail | Backend check | Approval stamped (fingerprint, who, when) with events emitted | Missing stamps | Major |

### A-07 · Validation report actionability — *Analyst · Probe P13 · no gate*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Report usable | Observation | Downloads and opens without help | Format friction | Minor |
| Errors translatable | Instructions vs key | Every planted error (missing, format, cross-field) becomes a concrete supplier instruction | Any error locatable but not explainable | Major* |
| Gaps identified | Probe P13 | Correctly flags any error a supplier couldn't fix from description alone | Misses a gap | Minor |

*\*Log per instance as a message-catalog gap rather than failing the script.*

### A-08 · Guards on out-of-order actions — *Analyst · no probes · no gate*

| Criterion | Evidence | Meets standard | Falls short | If missed |
|---|---|---|---|---|
| Re-approve refused | Observation | Approving an approved request refused with readable reason | Silent success or silent no-op | Major |
| Rework-on-cancelled refused | Observation | Same standard | Same | Major |
| Race handled | Observation, 2 sessions | Second analyst's action on a just-decided item refused with readable reason | Double-write or silent outcome | Major |
| No partial writes | Backend check, per attempt | Protected columns byte-identical before/after every refusal | Any drift | **Blocker** |
| Reason comprehensible | Tester statement | Analyst can say *why* it was refused without seeing an error code | Raw token surfaced (e.g. `illegal_transition`) | Minor |

---

## Roll-up reminder

Script verdicts feed the tracker as usual — this document changes how results are
*judged*, not how they're *recorded*. The three headline numbers (loop completion,
neutrality via P4, handoff fidelity via P5) are unchanged and map to the shaded
thesis rows in S-04, S-05, and A-04.
