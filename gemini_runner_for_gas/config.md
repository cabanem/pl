This lands cleanly because of something the runner already does: Run 1's results become *columns* in the Names sheet, and the template engine binds `{{Placeholder}}` to any column by name. So the second pass isn't a new engine — it's the same engine reading a second config that references Run 1's output columns (`{{Risk Level}}`, `{{Recommendation}}`, etc.) and writes new ones. The only code change is letting the runner read a config sheet other than `Config`. Let me wire that in, then give you the sheet contents.Now the entry point becomes a thin wrapper over a shared core that takes the config sheet name:Now parameterize `readConfig_`:Now the reset functions, parameterized the same way:The code now supports a second config sheet via a "Run recommendations" menu item. Here's the `Recommendations` sheet to pair with it. It points at the **same `Names` tab**, so it reads each name plus the columns Run 1 wrote, and appends new ones.

Scalar keys (column A / column B):

| Key | Value |
|---|---|
| `data_sheet` | `Names` |
| `model` | `gemini-2.5-pro` |
| `temperature` | `0.4` |
| `max_tokens` | `4096` |
| `grounding` | `false` |
| `skip_if_filled` | `true` |

`output_fields` (one per line):

```
Alternative Names
Rationale & Trade-offs
```

`system_instruction`:

```
You are an experienced Intellectual Property and Trademark Attorney advising on brand selection for B2B software and HR-tech tools. You help an applicant move from a screened name to stronger, more registrable options.

Favor marks that are distinctive (coined, arbitrary, or suggestive) over descriptive or generic ones, and that avoid the specific conflicts surfaced in the screening. Be concrete and practical. Never assert that a suggested name is "clear" — a new name always needs its own screen. Frame every suggestion as a candidate to screen next, not a conclusion.
```

`prompt_template`:

```
A proposed name has already been screened for trademark risk. Using the requirements and that screening result, propose stronger options.

Requirements:
- The tool is a B2B data-collection / HR-tech software product; the applicant is REDACTED.
- The name must be defensible and registrable in the US and the UK, in or around Nice Class 9 (Software), Class 42 (SaaS / Data Services), and Class 35 (Employment / HR Services).
- Prefer distinctive marks (coined, arbitrary, or suggestive) over descriptive or generic ones.

Screened name: "{{ProposedName}}"
Screening result:
- Risk level: {{Risk Level}}
- Recommendation: {{Recommendation}}
- Exact matches found: {{Exact Matches}}
- Similar / phonetic matches found: {{Similar / Phonetic}}
- Common-law / marketplace usage found: {{Common Law & Marketplace}}

Produce:

[[Alternative Names]] A short list of stronger candidates: first, modified forms of "{{ProposedName}}" that reduce the specific risks above (a distinctive prefix, a coined spelling, a suggestive addition); then a few net-new names that fit the requirements and avoid the conflict patterns found. Keep each to a word or short phrase.

[[Rationale & Trade-offs]] For the strongest 2-3 options, briefly explain why each is more distinctive or lower-risk given the findings, and what it trades off (e.g., less descriptive but harder to market). End by noting that every suggestion still requires its own clearance screen.
```

A few mechanics worth knowing. The `{{Risk Level}}`, `{{Recommendation}}`, and finding columns only exist after Run 1 has written them, so the recommendations pass has to run second — and if you run it first, `validateTemplate_` throws a clear "references unknown column(s): Risk Level…" rather than producing garbage. That ordering guardrail is free. I nudged `temperature` to 0.4 since this is generative naming rather than the cautious 0.2 of the screen, and left `grounding` off because this pass reasons over results you already gathered rather than fetching new register data — flip it on if you want the model to sanity-check its suggestions against the live web, though the cleaner loop is to drop the promising alternatives back into the `Names` tab and re-run the screening pass to clear them properly.

One thing to confirm about intent: this is **per-name** — each row gets alternatives tailored to its own result. If what you actually wanted is an **aggregate** synthesis — one set of recommendations reading *all* the screened names together (e.g., "across these ten, here are the three strongest paths") — that's a genuinely different shape: one call over the whole result set writing to a summary, not a per-row pass. Say the word and I'll build that as a third menu action.
