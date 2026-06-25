Happy to. The mapping is clean: the only thing that varies per row is the **proposed name**, so that's your single placeholder (`{{ProposedName}}`) and your data sheet is one column. The applicant company is constant across every name, so I baked it into the template as a literal rather than repeating it on every row — more on that below. I also split the attorney persona into `system_instruction` and the task into `prompt_template`, which is the idiomatic split.

Here are the scalar settings for the **Config** tab (column A = key, column B = value):

| Key | Value |
|---|---|
| `data_sheet` | `Names` |
| `model` | `gemini-2.5-pro` |
| `output_column` | `ClearanceReport` |
| `temperature` | `0.2` |
| `max_tokens` | `8192` |
| `skip_if_filled` | `true` |

Set `model` to whatever string your `GeminiLib` is actually pointed at — for legal reasoning you want the strongest model your Vertex project allows, not flash. The two long values go in their own cells:

`system_instruction`:
```
You are an experienced Intellectual Property (IP) and Trademark Attorney specializing in B2B software, HR technology, and corporate enterprise tools. You produce careful, well-structured preliminary clearance assessments. When you are not certain a specific registration exists, say so explicitly rather than inventing registration or application numbers.
```

`prompt_template`:
```
Conduct a preliminary trademark clearance and risk assessment for a new B2B data collection / HR-tech software tool. The owner and applicant will be REDACTED (along with its groups and affiliates).

Proposed name to analyze: "{{ProposedName}}"

Focus on the US market (USPTO) and the UK market (UKIPO). Structure your response using exactly these headers:

1. EXACT MATCHES (US & UK): Identify any active, pending, or recently abandoned trademarks in the US or UK for this exact name. Pay specific attention to Nice Class 9 (Software), Class 42 (SaaS / Data Services), and Class 35 (Employment / HR Services). Include the company name and registration/application number where one is found; if you cannot confirm a specific filing, state that explicitly rather than guessing a number.

2. SIMILAR OR PHONETIC MATCHES: Identify existing brands or trademarks that sound identical, have highly similar spellings, or share the same semantic meaning within the software, data management, or HR/staffing sectors.

3. COMMON LAW & MARKETPLACE USAGE: Identify active, unregistered software tools, SaaS platforms, or tech startups using this name in the B2B or HR-tech space (e.g., GitHub, LinkedIn, Crunchbase, or general web presence) that could pose a prior-use or common-law trademark risk.

4. INFRINGEMENT & SELECTION RISK LEVEL: Give a final risk rating (Low, Moderate, High, or Very High) for REDACTED's ability to safely use, register, and defend this trademark in the US and UK, and briefly explain your reasoning.

5. REGISTRATION RECOMMENDATION: Give a strategic recommendation on whether to pursue this name as-is, modify it (e.g., add a prefix or descriptive word), or abandon it entirely.

Note any limitations in your confidence, and treat this as a preliminary screen rather than a definitive legal opinion.
```

For the **Names** tab, put `ProposedName` in A1 and one candidate name per row beneath it. That's the whole setup — the output lands in a `ClearanceReport` column the runner creates automatically.

Two things worth flagging, because this prompt is the kind where the framework's default behavior can mislead you:

The bigger one is grounding. `callGemini_` calls plain `GeminiLib.generate`, which has no live access to USPTO TESS or UKIPO's register. So sections 1–3 — especially the registration and application numbers — will be generated from the model's training memory, and it will confidently produce plausible-looking numbers that don't exist. I added a line to both the persona and the prompt telling it to say "I can't confirm a filing" instead of guessing, which helps, but the honest framing is: treat sections 1–3 as *leads to verify against the official registers*, not findings. If your `GeminiLib`/Vertex setup supports the Google Search grounding tool, wiring it into that one `callGemini_` seam would materially improve reliability here — I'm happy to help you add it. And as you'd expect, this is a screening pass, not a clearance opinion you'd file on.

Two small notes on choices I made: I hard-coded "REDACTED" as the applicant — change that single literal if the filing entity should be REDACTED N.V. or another affiliate, or promote it to a `{{CompanyName}}` column if you ever want to vary it per name. And the full report lands in one cell; if you'd rather have the five sections and the risk rating split into their own columns, that's the structured-output variant I mentioned, and this prompt is a good candidate for it.

Want me to add the grounding call to `callGemini_`, or set up the structured-column version?
