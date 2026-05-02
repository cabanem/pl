# Recipe Trim Profile — `context_reduction` v0.1

> Declarative spec for trimming Workato recipe `code` trees before passing
> them to an LLM for analysis. The goal is to reduce context size without
> changing what the recipe *does* from the model's perspective.

---

## Purpose

Workato recipe `code` is verbose. It contains internal bookkeeping
(auto-generated step aliases, UUIDs, extended input schemas, IDE state)
that costs tokens, that the model has no use for, and that can actively
mislead it ("this `unfinished: true` flag must mean something").

This profile defines a **single, uniform trim** applied to every recipe before
analysis. It is intentionally *not* question-specific. The model sees a
consistent, minimal shape; downstream prompts don't have to know which trim
was used.

---

## Design principles

**P-1. Strip fields, never structure.**
The tree shape — `keyword`, `block`, nesting — *is* the recipe's logic. The
trimmer removes keys from objects. It never collapses, unwraps, reorders, or
otherwise mutates the tree topology. `block` arrays in particular are
positionally meaningful and are walked but never modified in length or order.

**P-2. When in doubt, keep.**
False positives on stripping (removing a field that turns out to matter)
silently degrade analysis quality and are hard to detect. False negatives
(keeping a field that turns out not to matter) just cost tokens. Asymmetric
risk → bias toward keeping.

**P-3. Identifiers stay; aliases go.**
The model needs to map its findings back to a real recipe and a real step.
`recipe.id` and structural step path (derived from position in `block`) are
how we do that. Auto-generated string aliases (`as: "step_4"`) are not
identifiers — they're scratch labels.

**P-4. Connector identity over connector internals.**
For each step, the model needs to know *what* connector and *what* action
(`provider`, `name`). It does not need the connector's full input schema,
extended_input_schema, hidden config, or UI-only metadata.

**P-5. User intent over IDE state.**
Fields the user authored (descriptions they wrote, conditions they
configured) stay. Fields Workato's editor adds for its own bookkeeping
(`unfinished`, `dynamicPickListSelection`, schema previews) go.

---

## Trim rules

### Top-level recipe envelope

| Keep | Strip |
|---|---|
| `id` | `user_id` |
| `name` | `copy_count` |
| `description` (if non-empty and not auto-generated) | `webhook_url` |
| `folder_id` | `webhook_subscribe_url` |
| `running` | `lifetime_task_count` |
| `trigger_application` | `last_run_at` (use the sheet for this) |
| `action_applications` | `job_succeeded_count` / `job_failed_count` |
| `code` (trimmed; see below) | `config` (see note below) |
| `version_no` | `parameters_count` |
|  | `created_at` / `updated_at` |

**Note on `config`:** the connection-binding object is *probably* not
needed for analysis ("recipe X uses connection Y" is rarely the question).
Default: strip. Override per-call if a specific analysis needs it.

### Step nodes (every node in the `code` tree)

**Always keep:**
- `keyword` — `trigger`, `action`, `if`, `foreach`, `try`, `catch`, etc.
  This is the structural backbone. Never touched.
- `provider` — connector identifier (`salesforce`, `http`, `sftp`, …)
- `name` — action/trigger identifier within the connector
- `block` — the ordered child-step array. Walked, not modified.
- `input` — user-configured input fields (trimmed; see below)
- `condition` (on `if` / `elsif` / `where` clauses) — the actual logic
- `description` — only if non-empty and not the default `"Step N"` pattern

**Always strip:**
- `as` — auto-generated step alias
- `uuid`, `recipe_step_uuid`, any `*_uuid` field
- `unfinished` — IDE state flag for in-progress edits
- `extended_input_schema` — connector's runtime schema (large; not user content)
- `extended_output_schema` — same
- `dynamic_pick_list_selection`, `dynamicPickListSelection` — UI-only state
- `visible_config_fields`, `hidden_config_fields` — IDE display hints
- `toggle_cfg`, `toggleCfg` — IDE toggle state

### `input` field contents

The `input` object is where most of the unnecessary verbosity lives.

**Keep:**
- All user-authored values, regardless of nesting depth. These are what
  the model needs to understand what the step actually does.

**Strip:**
- Schema preview blobs (often keyed `__bracketed`, `__schema`, or shipped
  alongside as sibling keys with leading underscore)
- Empty strings, `null` values, and empty objects/arrays (they convey
  nothing and inflate token count)
- Workato datapill metadata (the actual datapill reference string stays;
  the surrounding metadata wrapper goes)

---

## Datapill handling — special case

Workato encodes references between steps as **datapills**: strings like
`"#{_dp('data.salesforce.account_id')}"`. The string itself is meaningful and
must be preserved verbatim — it's how the model understands data flow between
steps.

**Rule:** datapill strings are leaves. Don't parse them, don't normalize them,
don't pretty-print them. Pass through unchanged. If a key's value matches
the datapill pattern (`/^#\{_dp\(.*\)\}$/`), it's a leaf — recursion stops.

---

## Output shape

A trimmed recipe is the same recursive structure as the input, with the
fields above removed. No new fields added. No keys renamed. No structure
flattened.

A typical reduction is **40–70%** by character count, depending on how
heavily the original recipe uses dynamic pick lists and how many connector
schemas got embedded. Reductions below 30% suggest a recipe that's mostly
user content already (good — nothing to trim); reductions above 80% suggest
something may be getting stripped that shouldn't be (worth a spot check).

---

## What this profile does NOT do

- **Does not summarize.** The trimmer is mechanical key removal, not
  semantic compression. "This recipe processes orders" is a job for the
  LLM, not the trimmer.
- **Does not validate.** A trimmed recipe is not guaranteed to be a
  Workato-importable recipe. It's an analysis input, not a deployment
  artifact. Round-tripping is out of scope.
- **Does not strip by step count or depth.** Every step is trimmed; no
  step is dropped. If recipes are too large *after* trimming, that's a
  pagination/chunking problem for the AI stage to solve, not a trim
  problem.
- **Does not strip `code` from sub-recipes / called recipes.** If a step
  references another recipe, the reference (the recipe id) is preserved.
  Whether to fetch and inline that sub-recipe is an orchestration
  decision, not a trim decision.

---

## Open questions (to resolve before v1.0)

- **Q-1.** Should `description` fields that look auto-generated (e.g. exact
  match to `"Step \d+"`, or empty after `.trim()`) be stripped, or kept as
  empty strings to preserve key presence? *Tentative: strip.*
- **Q-2.** Should `config` be strippable per-call rather than always-off?
  Likely yes, but defer until a real use case shows up.
- **Q-3.** Are there connector-specific verbose fields (e.g. HTTP connector
  request/response schemas) worth special-casing? Wait for data — run the
  trim on a representative sample first and look at what's left.

---

## Versioning

This is `v0.1` because the field lists above are best-guess and will need
empirical tuning. The plan:

1. Implement the trim as a pure function over the canonical recipe shape.
2. Run it on the SDC base-project recipes (R-00, R-1, R-1b, R-2a, R-2b)
   and at least one client folder.
3. Spot-check trimmed output: for each recipe, can a human still tell
   what it does? Is anything obviously missing? Is anything obviously
   still bloat?
4. Adjust the keep/strip lists. Bump to v0.2.
5. Lock to v1.0 once two consecutive iterations don't change the lists.

The version number on the trim profile gets stored alongside the AI
analysis output, so we can always tell which trim a given analysis was
based on.
