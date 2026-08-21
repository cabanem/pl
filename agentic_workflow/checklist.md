# CHECKLIST.md — Decisions, Tasks, and the Things That Bite

Synthesized from the full planning thread and the deployment-debugging session.
Cross-references: D1–D9 (decisions), Q1–Q6 (open questions), M1–M6 (milestones),
C1–C12 (dev infrastructure), R1–R12 (agent rules), P0–P3 (repo setup phases).
Section E is the "don't know what you don't know" section — read it first, once,
so nothing in it is a surprise later.

---

## A. Immediate loose ends (this week, before repo work)

- [ ] **Verify the deployed bundle** (~20 min, high value — it's now the standardized
      architecture). Mint inline: `curl -H "Authorization: Bearer $(gcloud auth
      print-identity-token)" "$URL/healthz"`. First confirm
      `CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT` is unset in that shell. If still 401,
      interrogate the token via the tokeninfo endpoint (`{email, aud, exp}`); if it
      becomes 403, that's progress — re-check the invoker binding matches the token's
      principal. Success = HTTP 200 with `brief_loaded: true`.
- [ ] **Read `dumps.py` and settle Q5** — is folder filtering server-side (`folder_id`
      param on the recipes list) or client-side post-filter? Write the answer into
      SOLUTION_DESIGN.md §4.4 and the snapshot manifest format.
- [ ] **Inventory what else `dumps.py` assumes** — any hardcoded workspace/host/env
      beyond the four documented env vars (the M3 "zero code edits" exit depends on
      knowing this now).
- [ ] **Record the 401 saga in Field Notes** — stale/empty `$TOKEN`, impersonation
      override → wrong-audience tokens, tokeninfo as the one-command verdict, 401-vs-403
      semantics. Paid for once; never pay again.

## B. Decision register

Decisions still open, with defaults and deadlines. "Default" = what happens if you
decide nothing; make defaults conscious.

| # | Decision | Options | Default | Make by |
|---|---|---|---|---|
| B1 | Repo host (Cloud Build needs a connected host) | GitHub / GitLab | — none; blocks CI | P0 |
| B2 | Dev dataset placement | Dev *dataset* in existing project / separate dev *project* | Dev dataset (`wwi_fixture`) in existing project; separate project only if org policy or blast-radius worry says so | P2 |
| B3 | GCP region pair | Bucket + BQ dataset locations | Co-locate bucket and dataset in one region (see E1) | P2 |
| B4 | Session dataset naming + session-id scheme | `wwi_s_<uuid>` etc. | UUID4-suffixed, prefix-scoped for the sweep job | M3 |
| B5 | Calibration rubric detail | What counts as "evidence-backed correct" per question | Answer matches gold AND cites ≥1 correct row/snapshot id | M1 |
| B6 | ADK model choice + pin | Which Gemini model, pinned where | Pin in one env var; record in README | M2 |
| B7 | Q2 — dataset reuse across sessions | Fresh always / workspace-keyed reuse | Fresh | M3, revisit M6 |
| B8 | Q3 — session dataset retention | Eager delete / expiration lapse | Eager delete + expiration floor + sweep backstop | M4 |
| B9 | Q1 — serving platform | Agent Engine / Cloud Run bundle | Written memo required (prompt 2.2); no default | M5 |
| B10 | Q4 — colleague front door | Agent Engine surface / thin UI / Gemini Enterprise | Decide with B9; build nothing before | M5 |
| B11 | Q6 — token scoping guidance | Minimal Workato API-client scope set | Document the scopes `dumps.py` actually calls | M5, before colleague use |
| B12 | Evidence-log retention + access (see E4) | Cloud Logging retention, who can read session logs | 30-day retention, access = you until decided | M4 |
| B13 | Review policy | Solo review of agent changes / second reviewer for IAM+security paths | Solo, except M4 security paths get a colleague read | M2 |
| B14 | M5 test partner | Which colleague + which unfamiliar workspace | — none; M3 and M5 exits both need this | Before M3 finishes |

## C. Build sequence (linearized, with exits)

### Phase 0 — Local scaffold
- [ ] Repo created on chosen host (B1); skeleton per AGENTS.md map (bin/, scripts/,
      terraform/, fixtures/, tests/views/, eval/calibration/)
- [ ] Docs seeded: AGENTS.md, SOLUTION_DESIGN.md, DEVELOPMENT_INFRASTRUCTURE.md,
      PROMPTS.md, CHECKLIST.md
- [ ] venv + `pip install google-adk google-cloud-bigquery ruff pyright pytest` +
      freeze; Makefile (v1.1 with test/test-bq split), cloudbuild.yaml, .gitignore
      (terraform state; deliberately NOT ignoring *.db), pyproject.toml
- [ ] gitleaks installed locally (binary/brew — it is not a pip package; Makefile
      assumes it on PATH)
- [ ] First commit — fences before workers

### Phase 1 — Seed proven code
- [ ] Copy the bundle in: bin/dumps.py, bin/derive.py, bin/corpus.py, bin/agent.py,
      bin/BRIEF.md, views.sql, Dockerfile, scripts/run_pipeline.sh, terraform/,
      DEPLOY.md (copy, don't migrate history)
- [ ] Confirm the Makefile's derive invocation matches derive.py's real flags
      (`--bucket/--prefix/--dataset/--source`)
- [ ] `make lint` green on seeded code (fix or consciously baseline-exempt)

### Phase 2 — GCP wiring
- [ ] B2 + B3 decided; dev bucket path + `wwi_fixture` dataset created, co-located
- [ ] Cloud Build: host connected, trigger on main, SA granted `dataEditor` +
      `jobUser` on `wwi_fixture` and object access on the dev fixture prefix — nothing
      else
- [ ] Budget alert on the project (see E5); `maximum_bytes_billed` set in corpus.py's
      client calls as the per-query ceiling
- [ ] ADC refreshed (`gcloud auth application-default login` — the ADC plane, not the
      gcloud plane)

### Phase 3 — First delegation + M-track
- [ ] AGENTS.md mirrored into Antigravity rules; fence spot-check run (prompt 1.5) —
      expected outcome: refusal citing R7/R5
- [ ] **C1** fixture built via prompt 1.1 → `make derive-fixture && make test-bq` green
- [ ] **C2/C3** determinism split + view assertions (prompt 1.3)
- [ ] **M1** calibration set: 10 questions, gold answers hand-verified, B5 rubric
      written down (prompt 2.3 to generate candidates)
- [ ] **M2** ADK agent (prompt 1.2) → `make eval` ≥ rubric; Cloud Build gains eval on
      judgment-layer changes
- [ ] **M3** session acquisition → second-workspace dump+derive, zero code edits
      (needs B14)
- [ ] **M4** session/security → canary green, concurrent-session isolation shown,
      B8/B12 implemented
- [ ] **M5** serving → B9 memo, deploy, colleague completes real analysis unaided
      (B10, B11 done)
- [ ] **M6** hardening → one view lands end-to-end through the C12 workflow

## D. Recurring cadence

**Per change (enforced by CI, listed for completeness):** lint + local tests + secret
scan; test-bq when derivation/views/tools touched; eval on judgment-layer changes; docs
current (R11).

**Per milestone:**
- [ ] Case-study chapter drafted while decisions are fresh (prompt 2.5 — near-zero
      cost now, expensive to reconstruct later)
- [ ] Field Notes updated with any trap found
- [ ] Checklist section E re-read — items graduate from "watch" to "task" as they
      become real

**Monthly-ish:**
- [ ] D6 honesty metric: hours spent framework-chasing (ADK/Agent Engine churn) —
      the number that would justify revisiting buy-over-build
- [ ] Dependency + model pin review (deliberate upgrades, not drift)
- [ ] Sweep check: any session datasets or dev-bucket fixture objects outliving
      their policy

## E. The watch-list — things neither thread has settled that will bite

Read once now; none of these needs action today, but each is cheaper to know than to
discover.

- [ ] **E1 — Cross-region load failure.** BigQuery load jobs require the dataset and
      the GCS bucket to be location-compatible; a US-multiregion bucket feeding a
      regional dataset (or vice versa) fails with an error that looks like a
      permissions problem and isn't. This is why B3 says co-locate, and it's worth
      one deliberate check against the *existing* bucket + `workato_agent_store_prd`
      before assuming the seeded Terraform has it right.
- [ ] **E2 — The session provisioner is a real identity design, not a detail.**
      Someone has to create `wwi_s_<id>`, grant the agent `dataViewer` on it, and
      later delete it. That "someone" is a provisioner identity holding dataset-create
      and IAM-set rights — more privilege than the agent, less than admin. M4's design
      must name it, scope it, and keep it out of the query path. (Agent Engine vs
      Cloud Run changes *where* this runs, not whether it exists — it belongs in the
      B9 memo.)
- [ ] **E3 — Foreign workspace scale is unbounded.** Your estate is ~58–77 recipes; a
      colleague's client workspace might be 800. Dump duration, Workato API rate
      limits/pagination behavior, and derive load times are all untested beyond your
      scale. Cheap early probe: at M3, pick the *largest* second workspace available,
      not the most convenient one.
- [ ] **E4 — Client data will flow into your logs.** Evidence logs of sessions over
      client workspaces contain client recipe names, table fields, and query text
      about them — in Cloud Logging, under your project, under Randstad data-handling
      expectations. B12 (retention + access) is a compliance question wearing an
      engineering costume; settle it before the first colleague session, and consider
      whether workspace names belong in log labels at all.
- [ ] **E5 — Cost surprises come from queries, not storage.** The corpus is tiny; the
      risk is an agent-generated `SELECT` scanning wide or a runaway eval loop.
      `maximum_bytes_billed` per query (Phase 2 item) turns surprise into a clean
      per-query error; the budget alert is the backstop. Set both before M2, when
      the model starts writing SQL.
- [ ] **E6 — Org policy may pre-empt design choices.** If this project lives under a
      corporate GCP org: policies can restrict dataset locations, SA creation,
      external ingress, or Secret Manager usage — any of which silently invalidates a
      Terraform apply that worked in a personal project. One `gcloud resource-manager
      org-policies list` reconnaissance before Phase 2 beats discovering it inside a
      failed apply.
- [ ] **E7 — Two BRIEF degradation modes, not one.** The spec notes the brief must
      degrade from "knows the SDC estate" to "knows Workato generally" for foreign
      workspaces — but there's a second mode: a foreign workspace using Workato
      features your estate never used (unknown adapters, structures derive skips).
      The agent should be instructed to say "the fact store doesn't capture this"
      rather than improvising; add one calibration question that tests exactly that.
- [ ] **E8 — INT64 epoch-second snapshot ids collide if two derives start in the same
      second.** Per-session datasets make collisions mostly moot (one deriver per
      dataset), but the standing dataset with a scheduler plus any manual run is the
      edge. Cheap fix when convenient: milliseconds, or a uniqueness check in derive.
- [ ] **E9 — Workato token validation needs a chosen endpoint.** §4.3 step 2 says
      "one cheap authenticated GET" — pick which (the users/me-style whoami is the
      usual candidate), confirm it's inside the minimal scope set (B11), and make it
      the *only* pre-pull call so a bad token fails fast and cleanly.
- [ ] **E10 — Antigravity rules mechanics.** "Mirror AGENTS.md into Antigravity" is
      one line in the plan; the actual mechanism (rules file location, whether it
      auto-loads per workspace, size limits) is unverified. Ten minutes of testing
      with a trivial rule before trusting it with the real fences.
