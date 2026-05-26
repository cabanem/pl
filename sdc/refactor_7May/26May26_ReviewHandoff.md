# Handoff — SDC Workato Recipe Review

Paste this to resume. It assumes the two companion files are re-attached: `SDC_Build_Status.md` (narrative status + master backlog) and `SDC_Recipe_Reference.md` (collapsed structural reference for all 26 recipes). The recipe JSONs may also be re-attached at `/mnt/user-data/uploads/*.json`.

---

## What this is

I'm Emily. We're doing a line-level code review of my Supplier Data Collection (SDC) platform — 26 Workato recipes (custom-connector-driven, Ruby SDK + Python steps). I'm in early alpha: analysts role-play as suppliers and submit completed templates. The "all submissions reach the analyst" behavior is the config-driven `force_manual_review` flag in VAL-01, not a stub.

The goal of the review: walk each recipe's actual logic (steps, datapills, calls, Python), confirm what's correct, and catch the subtle silent-failure bugs (schema/casing mismatches, missing `code_input`, serialization quirks, dead branches, contract mismatches between recipes). Surgical patches over rewrites. I like understanding *why*, so explain the mechanism, not just the verdict.

## How we work

- The collapsed reference (`SDC_Recipe_Reference.md`) has the schema decoder, full inventory, dependency graph, per-recipe one-liners, the STS-01 transition table, and resolved column UUIDs. **Read it first** — it saves re-parsing.
- Parser: rebuild `/home/claude/rx.py` from §8 of the reference if needed (it resets between sessions). Decode `_dp('...')` datapills to `«provider/line:path»`; recipe edges are `call_recipe[_async]` → `input.flow_id.name`; DB filters live in `input.filters[]` not `where`.
- Findings format: group by severity (Blocker / Functional / Verify / Cleanup / Robustness / Cosmetic). State the mechanism and a proposed fix. Distinguish confirmed bugs from "verify intent." Retract false alarms explicitly.
- Don't fold findings into the backlog until I say so — I sometimes want to wait for a dependent recipe before confirming.

## State of the review

**Done (line-level, complete):**
- **VAL-01** — clean except: `submission_attempt` null-write (backlog #3); drops `strict`/`source` on RUN_FieldError (#6); `data_only=True` cached-value risk (#8); exact header matching (#9); `force_manual_review` rescues only failed/empty (#13); manual-parser asymmetry (#14).
- **STS-01** — clean except: raw timestamps in supplier messages (#4); dead block steps 23–25 (#7); duplicated derivation message (#15). All 4 preconditions + transition validator + derivation wiring confirmed correct. (Earlier empty-`where` worry was a FALSE ALARM — connector filters via `filters[]`.)

**Done (line-level), findings NOT yet folded into backlog — fold these next:**
- **UPL-01** — two findings:
  1. **(Functional, worth fixing)** Step-19 verdict→state Python maps verdict `error` (and fallback) to `trigger_context = "pipeline_error_alert"`, which is **NOT in STS-01's legal transition table**. Result: STS-01 returns `illegal_transition`, `sts_result_success` is false, UPL-01 silently skips both the analyst-share and INV-01a task assignment → submission dead-ends with only an OBS-01 `illegal_transition` trace. Fix options: (a) add `pipeline_error_alert` self-transitions to STS-01's table mirroring the `display_refresh` no-op pattern, or (b) cleaner — branch in UPL-01 so an `error` verdict emits an OBS-01 alert and returns WITHOUT calling STS-01.
  2. **(Verify, provisional — pending INV-01a)** UPL-01 passes `workflow_stage: "human review"` (step 28, lowercase) and `"New"` (step 30, capitalized) to INV-01a. INV-01a branches on this string. Casing must match INV-01a's actual comparison or it's a silent-branch bug. **Confirm when reviewing INV-01a, then fold.**
  - Confirmed clean in UPL-01: eligibility guard AND-logic (the comment's AND-not-OR worry is correctly handled); the `submission_attempt++` here is the legitimate owner (reinforces that #3's fix belongs in VAL-01).

**Next up:** INV-01a (resolves the UPL-01 casing question #2 above, then fold both UPL-01 findings). After that, REV-01 and the PRV-04 version-update branch (#1, the one blocker) are the highest-value remaining line-level targets.

**Not yet line-level reviewed:** all of the provisioning chain (PRV-01/02/03/04/05, CFG-01, CAN-01, TPL-01/02, DASH-01), INV-01, INV-01a, REV-01, OBS-01, UTL-01, LNK-01, and all WFA recipes (structural/wiring review only).

## Backlog at a glance (full detail in SDC_Build_Status.md §10)

17 items, severity-ordered. #1 PRV-04 version-update incomplete (Blocker, `::TODO::`). #2 WFA-03 unwired step. #3–4 VAL-01 null-write / STS-01 raw timestamps (Functional). #5–6 WFA-02 no DB reads / VAL-01 dropped error fields (Verify). #7 STS-01 dead block. #8–9 VAL-01 robustness. #10 R-1 temp trigger. #11–12 link TTL / dup. #13 force_manual_review scope. #14–17 cosmetic. Items from the line-level pass are tagged **[VS]**. UPL-01's two findings are NOT in here yet.
