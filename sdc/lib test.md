Good question. Test generation prompts are tricky because the model needs three things: enough context to know what *to* test, enough constraints to not generate garbage, and enough structure to produce something you can actually run.

For Apps Script specifically, the testing situation is a bit unusual. There's no native unit test framework — most teams either (a) write manual smoke tests via menu items in a dev workbook, (b) use an in-Apps-Script harness like GasT or QUnitGS2, or (c) extract pure logic into testable modules and run them in Node with Jest. Each has different prompt needs.

Before I draft something, two questions that change the prompt significantly:

**Q1: What's your testing target?**

(a) **Manual smoke tests** — a checklist of scenarios to run by hand against a real workbook, with expected observable outcomes (toast text, alert title, log entries, file presence on Drive). Lowest setup, no new infrastructure.

(b) **In-Apps-Script test runners** — functions in the library or container that mock minimal Apps Script services and assert on Result shapes. Catches regressions, requires a test harness file.

(c) **Extract-and-test** — pull pure logic (e.g. `Result.ok`/`Result.fail`, `Util.coerceTruthy`, `Variant._extractIncludedFields`, `Migrations._planPath`) into Node-runnable modules and test with Jest. Highest setup, best regression coverage on the pure pieces, doesn't cover the parts that actually touch Drive/Sheets.

For this refactor, I'd lean (a) for the integration paths — the five smoke tests I listed at the end of step 5 — and (c) for the pure pieces we just introduced (the Result factories especially, since they're the contract everything else assumes). (b) is the highest-value but also highest-effort, and Apps Script's testing ergonomics are bad enough that most teams skip it.

**Q2: Do you want one prompt that generates everything, or separate prompts per scenario?**

A single mega-prompt tends to produce diluted output — the model spreads attention thin across many tests. Separate prompts per flow (one for Provision, one for Validate, etc.) tend to produce more thorough scenarios per flow. For five flows that's five prompts, which is fine if you're running them once.

I'd recommend the latter, but with a *shared context block* you paste at the top of each prompt so the model has the canonical Result shape, the flow inventory, and the testing target without you re-explaining each time.

---

Here's a draft of what I think the strongest prompt would look like, assuming **(a) manual smoke tests** as the target and **separate prompts per flow** with a shared context block. If you want a different shape, tell me and I'll redraft.

---

### Shared context block (paste at top of every test-generation prompt)

```
You are generating manual smoke tests for the SDC Apps Script library.
Tests will be executed by hand against a real Google Sheets workbook
bound to the SDC library; pass/fail is determined by observable outcomes
(toast text, alert title and body, _script_logs entries, files on Drive,
mutations to specific cells).

Library architecture:
- Container shim (main.gs) translates library Result objects into
  spreadsheet UI (toasts, alerts, modal dialogs).
- Library exposes five flows: Provision, Validate, Portal (invite),
  PrimaryKey (setup), Migrations.
- All flows return a canonical Result:
    { ok, flow, correlationId, message, data, warnings, error }
- Logging goes to a hidden _script_logs sheet with columns:
  Timestamp | Status | User | Message | CorrelationId
- showResult_ in main.gs renders:
    Title:  "<Flow label> — success" | "— success with warnings" | "— failed"
    Body:   message + optional Warnings block + optional Correlation ID line
  Correlation ID is shown only for provision/validate/portalInvite flows.

Output format:
For each test scenario, produce:
  Test ID: short-slug
  Setup: bullet list of preconditions (workbook state, _developer_settings
         values, prior _script_logs entries, files on Drive, etc.)
  Steps: numbered list of user actions
  Expected observable outcomes:
    - Toast: exact expected text (or "none")
    - Alert title: exact expected text
    - Alert body: key phrases that must appear (not the full body verbatim
      unless short)
    - _script_logs entries: list of (Status, message-key-phrase) tuples
    - Drive side effects: files created/trashed/shared (or "none")
    - Workbook mutations: cells changed (or "none")
  Notes: anything subtle (e.g. "verify correlation ID matches the one
         shown in the alert and in _script_logs")

Constraints:
- Cover happy path AND at least two distinct failure paths.
- Each scenario should be runnable in <5 minutes by a developer with
  access to the workbook and Drive folder.
- Do not invent fields, methods, or flow names not listed here.
- If a scenario requires data you don't know (e.g. a real Workato webhook
  URL), say "[provide test webhook]" rather than fabricating a value.
```

### Per-flow prompt template

```
Generate manual smoke tests for the [FLOW NAME] flow.

What this flow does:
[paste relevant pipeline comment from the orchestrator's @file block]

Public entry point:
SDC.[Module].[method](ss) → Result

Flow-specific Result.data shape on success:
[paste the Result.ok({...}) call's data block from the orchestrator]

Failure stages this flow can fail at (from the @file or pipeline comment):
[list the stage names: 'config', 'preflight', etc.]

Required scenarios:
1. Happy path — clean success, no warnings.
2. [flow-specific failure 1, e.g. "missing _developer_settings"]
3. [flow-specific failure 2, e.g. "webhook returns 5xx"]
4. [flow-specific edge case, e.g. "audit-share email malformed → warning, not failure"]

For Provision specifically, also cover:
- variantsGenerated > 0 (workbook has 1_customer!D6 = 2)
- Audit-share with one bad email → success with warnings
- Workato OAuth account email blocked by domain policy → fatal failure at share-with-workato stage

[Substitute the flow-specific block per flow.]
```

---

A few things this prompt does deliberately:

**It frontloads the Result contract.** Without it, the model will invent fields ("status: 'pending'", "errorCode: ..."). With it, the test assertions stay grounded.

**It asks for *observable* outcomes.** Apps Script tests fail in ways that are surprisingly hard to assert on programmatically (e.g. you can't easily inspect the alert dialog's contents from another script). Tests have to be written for a human runner. Asking for "exact expected text" forces the model to commit to specifics rather than vague "the alert should indicate failure."

**It refuses fabrication.** "Say `[provide test webhook]` rather than fabricating a value" is the line that prevents the model from confidently generating `https://workato.com/webhooks/abc123` and you then wondering whether that's real.

**It scopes to <5 minutes per test.** Without this, the model will generate scenarios like "test the migration path from v1.0 through v1.1 to v2.0 with three intermediate steps" — fine in principle, but currently you have no v1.1 or v2.0 to migrate through.

**Two things it deliberately doesn't do:**

It doesn't ask the model to *run* tests. The model will hallucinate results if you ask. Generation only.

It doesn't ask for code (test harness, mocks). For (a) manual tests, code isn't the artifact. If you switch to (b) or (c), the prompt needs to ask for code and the constraints change substantially — let me know if you want that variant.

---

If you want, I can also draft the (c) variant — Jest-style tests for the pure pieces. The Result factories are an especially good candidate since they're 100% pure logic, the contract is locked, and a regression there breaks every flow. Want me to do that one too?
