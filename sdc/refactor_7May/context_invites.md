# SDC Invitations — Context for Humans

**Entry point:** `R-1` (Workato webhook, suffix `issue-invitations`, authenticated by the unguessable URL — **not** API-TOKEN).
**Scope:** the call tree reachable from R-1 — the bulk/initial invite path that runs after provisioning signals `send_invitations.ready`.
**Out of scope:** the *other* doors into the invitation machinery (portal add-user and activation). They're summarized at the end under "The second door" so they're not conflated, but they don't start at R-1.

> Convention: plain statements are grounded in the spec. **(inferred)** marks my reading of control flow / naming, not something the spec states. Verify inferred items against recipe JSON before trusting them in anything destructive or irreversible.

---

## The shape, in one paragraph

Where provisioning was a deep synchronous *chain*, invitations are a shallow *fan-out*. R-1 is a dispatcher: it resolves which requests are in scope and loops over them, isolating each one. Almost all the actual work lives one level down in INV-01, which for a single request sends the kickoff email, issues the WFA invites, transitions the request to `sent`, and assigns the WFA task. The spine is just three recipes — **R-1 dispatches → INV-01 does the work → STS-01 + INV-01A finish it** — and everything else INV-01 touches is reads.

---

## Call chain

```
R-1  (webhook "issue-invitations" — auth by URL suffix, NOT API-TOKEN)
│   reads CFG_TemplateVersion + SUP_SupplierRequest  (resolve scope from ssId)
│
├─ [guard] no requests in scope ──────────────→ early return + OBS-01
│
└─ foreach request:                            ← fan-out, each item isolated
   └─ INV-01  invite supplier user(s) for ONE request   [per-item try/catch in R-1]
      │
      ├─ resolve request → Project → users; pick assignee, due date, secondaries (py_eval)
      ├─ [guards ×5] not found / ineligible / no users / already invited → early return + OBS
      │
      ├─ create_document + send_mail   ← KICKOFF EMAIL to assignee   [try/catch — SOFT]
      ├─ update SUP_SupplierUser (batch)   ← record invite disposition
      │
      ├─ WFA invite_user (+ share_request)  ← PRIMARY   [try/catch — isolated]
      ├─ foreach secondary: invite_user + share_request   [try/catch each — isolated]
      │
      ├─ STS-01  transition → "sent"  (trigger_context: invitation_issued)   [SYNC]
      │   └─ writes .status plane; refuses illegal re-transition
      │
      └─ [if transitioned] INV-01A  assign WFA task/stage   [ASYNC — fire-and-forget]
          └─ writes workflow_stage_id (the WFA plane)
   │
   └─ accumulate batch_results
   └─ final OBS-01 → return (webhook: NO response body to caller)
```

OBS-01 is called async throughout (and once sync inside STS-01). Treat it as the cross-cutting sink, as before.

---

## Execution model & where the failure surface sits

R-1 wraps the whole batch in a try/catch and loops with a **per-item** try/catch inside, so one supplier's failure emits an OBS event and the loop continues — the same soft-isolation as INC-01's seed loop. Two structural facts shape everything:

**1. It's the two-plane pattern again — split across a sync/async boundary.** Completing an invite means writing *both* planes of the request: the data-table `.status` → `sent` (via STS-01, **sync**, on the critical path) and the WFA task/stage `workflow_stage_id` (via INV-01A, **async**, fire-and-forget). STS-01 gates whether INV-01A even runs, but INV-01A's result is never seen by INV-01. So the most likely silent partial in this flow is **state says `sent`, WFA task never got assigned** — visible only in EventLog.

**2. The least-reversible action happens first, and is non-fatal.** The kickoff email goes out *before* the state transition and *before* the WFA invites — and its try/catch is soft, so an email failure is logged and the flow continues anyway. That cuts two ways: a request can be emailed ("please act") and then fail to reach `sent`; or a request can reach `sent` with no email ever delivered. The email is the one thing you can't take back, and it's both earliest and non-blocking.

**3. Batch reporting is blind.** R-1 is a webhook with **no response body** — "3 of 10 invited, 7 failed" exists only in EventLog. There is no human-facing aggregate the way provisioning's 200 carried `seed_data.ok`. If nobody reads the log, a half-failed batch looks like nothing happened.

---

## Per-recipe reference

### R-1 — Issue invitations (the dispatcher)
**Does:** Receives the webhook (`analyst_email`, `ssId`), resolves scope by reading `CFG_TemplateVersion` (matched via `ssId` — likely a spreadsheet id *(inferred)*) and the in-scope `SUP_SupplierRequest` rows, then loops, calling INV-01 once per request inside a per-item try/catch. Accumulates `batch_results`, emits a summary OBS event, returns.
**Touches:** R: `CFG_TemplateVersion`, `SUP_SupplierRequest`. Calls: INV-01 (sync), OBS-01 (async).
**Returns:** nothing to the caller (webhook trigger; `200` is just "event accepted").
**Fails when:**
- No requests resolve in scope → early return + OBS (clean no-op).
- A single INV-01 throws → caught per-item, OBS event, loop continues (soft isolation).
- The whole handler throws → outer catch → OBS, return.
- **The eligibility filter isn't visible in the spec** — whether R-1 selects only un-invited requests, or invites all-for-version and relies on INV-01/STS-01 to skip already-`sent` ones, can't be told from the recipe JSON. *(inferred: downstream idempotency is the safety net either way — see re-run note.)*

---

### INV-01 — Invite supplier user(s) for one request (the workhorse)
**Does:** For a single request: loads the request, Project, and users; picks the assignee, computes the due date, and gathers secondary users (py_eval). Then sends the kickoff email, records invite dispositions on `SUP_SupplierUser`, issues WFA invites for the primary and each secondary, transitions the request to `sent` via STS-01, and — only if that transition succeeded — assigns the WFA task via INV-01A.
**Touches:** R: `SUP_SupplierRequest`, `Project`, `SUP_SupplierUser`, `CFG_VariantField`, `CFG_Variant`. W(update-batch): `SUP_SupplierUser`. WFA: `invite_user`, `share_request`. Email: `create_document` + `send_mail`. Calls: STS-01 (sync), INV-01A (async), OBS-01 (async).
**Returns:** `transitioned` (required, bound from STS-01 success); `assignee_disposition` (`sent` | `failed` | `already_invited`); `secondary_dispositions[]` (per secondary user).
**Fails when / how it degrades:**
- **Five early guards** (request not found, ineligible state, no users, already-invited, py_eval) each return before any side effect. The existence of the `already_invited` disposition confirms an idempotency check exists; the control flow places a `SUP_SupplierUser`-reading guard *before* the email block. *(inferred: that guard is the already-invited check — if so, re-runs short-circuit before re-emailing.)*
- **Email failure is SOFT** — caught, logged, flow continues. The request can still reach `sent` with no email delivered.
- **WFA invite failures are recorded, not fatal** — the primary invite and each secondary sit in isolated try/catch blocks; failures become dispositions (`failed`) rather than aborting. So `transitioned: true` does **not** guarantee every user was actually invited in WFA. The primary-invite catch appears to swallow without recording *(inferred from an empty catch body — worth confirming)*.
- **STS-01 is the gate.** It's the only thing here that's on the critical path for `transitioned`, and INV-01A only runs if it succeeds. An STS-01 refusal (e.g. `illegal_transition` on an already-`sent` request) leaves `transitioned: false` — *after* the email already went out.

---

### INV-01A — Assign task to user in Workflow App (the WFA-plane writer)
**Does:** Looks up the WFA request record (`get_requests` by app_id+record_id) and sets its `workflow_stage_id` via `human_review_on_existing_record`, choosing the stage (the `new` vs `human review` if/elsif). This is the recipe that advances the *WFA task/stage* plane.
**Touches:** WFA: `get_requests` (read), `human_review_on_existing_record` (update → `workflow_stage_id`). Calls: OBS-01 (async).
**Returns:** no response schema — **fire-and-forget**.
**Fails when:**
- WFA request not found → guarded early return.
- The stage write fails → caught → OBS, return.
- **Because INV-01 calls it async, every failure here is invisible to the invite flow except via EventLog.** This is the silent partial: `.status = sent` but the WFA task never assigned.
- **Not invite-specific:** UPL-01 also calls INV-01A (to assign the analyst review task after an upload). It's a generic "advance the WFA task plane" primitive, so changes to it ripple beyond invitations.

---

### STS-01 — Status-change handler (touchpoint, not invite-specific)
**Does (for this flow):** Called by INV-01 with `target_state: sent`, `trigger_context: invitation_issued`. Reads the request, validates the transition from its prior state, and writes the `.status` plane (`status`, `supplier_display_status`, `supplier_message`, `current_state_entered_at`). Also derives a shareable link via UTL-01.
**Touches:** R: `SUP_SupplierRequest` (+ validation/project/review reads). W(update): `SUP_SupplierRequest`. Calls: UTL-01 (sync), OBS-01 (sync).
**Returns:** `success` (required); `prior_state`, `new_state`, `error_code` (`request_not_found` | `illegal_transition` | `precondition_failed` | `derivation_lookup_failed`).
**Why it matters here:** it's the **single writer** of request state and the **state-level re-run guard** — an already-`sent` request gets `illegal_transition` and is refused, which is what makes re-firing R-1 safe at the state layer (but not the email layer — see below). Full treatment of STS-01 belongs to a state-machine doc; here it's the gate between "invited" and "assigned."

---

### INV-USER — Atomic WFA invite leaf (related, NOT on the R-1 path)
**Does:** Invites exactly one user to one request in the WFA (`invite_user` + `share_request`), guarded and isolated, returning a disposition. The clean primitive form of what INV-01 does inline.
**Touches:** R: `SUP_SupplierRequest`. WFA: `invite_user`, `share_request`. Calls: OBS-01.
**Returns:** `disposition` (`sent` | `failed`), `email`, `error`.
**Why it's here:** **INV-01 does not call INV-USER** — it issues invites inline in its own loop. So the WFA-invite logic lives in *two* places. If folding INV-01's loop into INV-USER was ever the plan, this spec version doesn't show it done. (Called by INV-03 on the portal path.)

---

## The second door (boundary — does not start at R-1)

The invitation *machinery* has a portal-driven entry path that's easy to conflate with the R-1 flow. Keep them separate:

- **Bulk / initial (this doc):** R-1 → INV-01 (inline WFA invites) → STS-01 + INV-01A.
- **Incremental add-user:** WFA-09 → INV-03 (creates the user if missing, writes `SUP_SupplierUser`) → INV-USER (the atomic leaf). Returns `already_existed` for idempotency.
- **Activation:** WFA-09 → SUP-02 (creates user + request) → loops back to **INV-01**.

So INV-01 is reachable two ways (R-1 and SUP-02), and the WFA-invite step exists in two implementations (INV-01 inline, INV-USER). Both are drift risks worth a note at source.

---

## Cross-cutting risks / things to watch

1. **Sent-but-unassigned (the headline).** STS-01 (sync) moves state; INV-01A (async) assigns the WFA task and its result is never checked. A failure leaves `.status = sent` with no WFA task — visible only in EventLog. This is the invite-flow twin of the two-plane divergence from the cleanup work.
2. **Email is earliest and non-fatal.** The least-reversible action (kickoff email) happens before state and before WFA invites, and its failure doesn't block the transition. Decide whether "email eagerly, reconcile state after" is intentional.
3. **`transitioned: true` ≠ everyone invited.** WFA invite failures are recorded as dispositions, not fatal. Read `assignee_disposition` / `secondary_dispositions[]`, not just `transitioned`.
4. **Blind batch outcome.** R-1 returns no body; partial-batch results live only in EventLog. No `seed_data.ok` equivalent — anything triggering R-1 should surface the per-item dispositions to a human.
5. **Re-run safety hinges on guard-before-email.** STS-01 refuses illegal re-transitions (state-level safety net), and the control flow places a user-reading guard before the email — so re-firing R-1 is *probably* clean. The open question is whether that guard is specifically the already-invited check; if already-invited is only caught at STS-01, a re-run re-emails before the transition refuses.
6. **Shared / duplicated machinery.** INV-01A is generic (UPL-01 uses it too); WFA-invite logic is duplicated (INV-01 inline vs INV-USER). Changes need to account for both call sites.

---

## Open items / confirm against recipe JSON

- What `ssId` resolves to, and the **eligibility filter** R-1 applies when selecting requests (item: spec doesn't show it).
- Whether INV-01's pre-email guard (guard 4) is the already-invited check — the hinge for clean re-runs (risk 5).
- Whether the primary WFA-invite catch records a `failed` disposition or silently swallows (INV-01 failure mode).
- The exact `target_state` / `trigger_context` INV-01 passes to STS-01 (assumed `sent` / `invitation_issued`).
- Whether folding INV-01's inline invite loop into INV-USER is still intended (de-duplication).
