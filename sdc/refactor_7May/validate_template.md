Here's the supplier-input inventory, drawn from `validate_upload`, in the same shape as the config one — but with one structural difference up front: in `validate_config` each *check* had a fixed fail/warn severity. Here, severity is **data-driven** — every check produces an error whose `strict` flag is inherited from the field's `strict` setting (or a rule's `strict_enforcement`), defaulting to strict when unset. The verdict is `passed | failed | empty`: any *strict* error makes the submission `failed` and drops that row from `valid_payload`; a non-strict error is recorded but the row still counts as valid. So I'll mark each check by what it tests and give its error code (the analog of `check_name`), and handle severity as a single model at the end.

There are ~22 distinct error conditions, plus a cleaning pre-pass, across five groups.

**Submission gate (hardcoded strict)**
- `err_empty_submission`: zero rows submitted → verdict `empty`, single summary error. The one check whose strictness isn't data-driven.

**Pre-pass — cleaning (a transform, not a check)**
- Per `data_cleaning_flags`, each value is rewritten before validation: `trim_whitespace`, `remove_control_chars`, `normalize_spaces`, `force_upper`, `force_lower`, `strip_non_numeric`. This mutates what's then checked and stored; it never raises an error.

**Per-field, structural (Phase 1)**
- `err_required`: a required field is blank.
- `err_must_be_empty`: a must-be-empty field has a value.
- *Short-circuit*: a field that's blank and not required skips everything below.

**Per-field, type & shape (Phase 1)**
- `err_data_type`: value not coercible to the declared primitive (`integer`, `float (2)` ≤2 decimals, `boolean` as 0/1/true/false, `date` as YYYY-MM-DD; `string`/`none` always pass).
- `err_standard_format`: value fails the `data_format` shape — `email address`, `date (YYYY-MM-DD)`, `currency` (number ≤2 dp), `percentage` (numeric). Dropdown shapes aren't checked here; they're enforced by lookup membership below.

**Per-field, constraints (Phase 2)**
- `err_length_constraint`: character-count outside `field_length_validation` (interval notation).
- `err_value_range`: value outside `numeric_field_validation` — only fires for `integer`/`float (2)`.
- `err_date_constraint`: value outside `date_field_validation` (resolves `TODAY`) — only fires for `date`.
- `err_regex`: value doesn't match the `field_input_validation` pattern. (An invalid pattern is swallowed silently — worth noting, since `validate_config` doesn't actually validate regex syntax, only the three interval columns.)
- `err_lookup_mismatch`: value isn't in the field's lookup set; for dependent dropdowns the valid set is first filtered to the chosen parent's children.

**Per-field, uniqueness (Phase 3)**
- `err_column_unique`: a `column_unique` field has a repeated value within the submission (flags the 2nd+ occurrence).

**Cross-field rules (Phase 4) — eleven verbs**
- `err_must_match`, `err_must_not_match`, `err_greater_than`, `err_greater_than_equal`, `err_less_than`, `err_less_than_equal` (numeric comparisons via `to_f`), `err_conditional_empty` (Must be empty if), `err_conditional_required` (Required if), `err_mutually_exclusive`, `err_require_one_of` (At least one required), and `err_composite_unique` (Combined fields must be unique — collected here, duplicate-flagged in Phase 3b).

**Cross-submission scope (against `prior_values`)**
- For rules scoped `supplier`/`engagement`, two verbs check against *prior* submissions rather than within the batch: `err_composite_unique` (the combined key already used in a past submission) and `err_must_not_match` (the value already used before).

**Governance, not checks:** per-row and total error caps (`max_errors_per_row`, `max_total_errors` → `truncated`), `stop_on_first_row_failure`, and the `apply_cleaning` toggle.

Three framing points, mirroring what I said about the config side — and these are the ones that determine whether the inventory above actually *bites*:

This is the **upload-time authority** layer, the counterpart to `validate_config`'s config-time integrity. The two never overlap: that side asks "does the spec hang together"; this side asks "is this supplier's value acceptable." Everything an analyst can configure has an enforcement home in the list above — which is what makes "the server is the authority" true *on paper*.

But three things we've already surfaced this session decide whether it's true *in practice*, and all three currently weaken it. The `strict` default — the open policy item — is the big one: because the parser coerces blank `Strict?` to `false`, every per-field and cross-field error is currently non-strict, so a row failing only these checks still returns `passed` and lands in `valid_payload`. `err_column_unique` can never fire because the parser drops the `Unique` column (the check is armed by `column_unique`, which is always false). And the cross-submission scope rules silently no-op unless the caller passes `prior_values` — your standing backlog item. So the inventory is complete as written; its real-world teeth depend on those three fixes.

And the same gap I'd name on this side that I named on the config side: nothing here reasons about `read_only`. VAL-01 validates a submitted value's type/shape/membership, but it has no concept of "this field was read-only — did the supplier change it from what we seeded?" So an unlocked-and-edited identifier like RSRUID isn't caught by any check in this list — which is exactly why that one has to be handled as server-authoritative substitution rather than left to template protection.
