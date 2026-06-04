Here's the full inventory in its current state — 20 checks across four groups. I'll mark each as **fail** (any one flips `status` to `"invalid"` and blocks) or **warn** (surfaces in the report, doesn't block). Your new `dropdown_has_lookup` is in place, slotted right after `cascade_parent_values_populated`.

**Referential integrity — do the cross-references resolve?**
- `lookup_references` (fail): a field names a lookup table that doesn't exist in the lookups.
- `depends_on_references` (fail): a field's parent-lookup reference (`depends_on`) names a lookup that doesn't exist.
- `rule_target_field_exists` (fail): a cross-field rule targets a field name that isn't defined.
- `rule_condition_field_exists` (fail): a rule's condition field isn't a defined field.
- `variant_field_exists` (fail): a variant lists a visible field that isn't among the defined fields.
- `variant_has_visible_fields` (fail): a variant has zero visible fields (it would build an empty template).
- `user_supplier_exists` (fail): a user is attached to a supplier that isn't defined.
- `exactly_one_primary_user_per_supplier` (fail): each supplier that has users must have exactly one primary — zero leaves the request task with no assignee, more than one makes ownership ambiguous. Suppliers with no users are skipped (already caught by `user_supplier_exists`).
- `dependent_dropdown_has_parent` (fail): a dependent dropdown is fully wired — it has its own lookup, names a parent lookup that exists, and some field actually uses that parent (so there's something to cascade from).
- `cascade_parent_values_populated` (fail): for dependent dropdowns, the child lookup has rows, every child row carries a `parent_value`, and those parent values are real members of the parent lookup — otherwise the cascade renders flat or points at nothing.
- `dropdown_has_lookup` (warn) — *new*: a plain `dropdown` field with no lookup bound; it would render as free text, constrained nowhere.

**Constraint — uniqueness and presence**
- `no_duplicate_field_names` (fail).
- `no_duplicate_supplier_names` (fail).
- `no_duplicate_user_per_supplier` (fail): the same email appears twice under one supplier.
- `no_duplicate_lookup_entries` (fail): a duplicate `(value, parent_value)` pair within a lookup. Note it's the *composite* — the same value under two different parents is allowed (that's normal for cascades).
- `required_fields_present` (fail): at least one field and at least one supplier must exist.
- `variant_count_matches` (warn): the number of parsed variants vs. the count the customer declared on the customer sheet.

**Form limit**
- `form_field_limit` (warn): the count of *visible* fields must be within the limit (default 20) — that's the WFA form's slot-pool ceiling. This is the one place `visible` is consumed.

**Syntax**
- `interval_notation_valid` (fail): the `field_length`, `numeric`, and `date` validation columns, where present, parse cleanly through `parse_interval` (not `"invalid"`).
- `email_format_valid` (warn): the analyst email and each user email match the email shape.

The tally: 16 of the 20 are fail-level, so any of them blocks provisioning. Four are warn-only and pass the config through — `dropdown_has_lookup`, `variant_count_matches`, `form_field_limit`, and `email_format_valid`.

Two framing points worth holding alongside the list. First, this is entirely *config-time integrity* — does the spec hang together and fit the platform's shape — which is a different question from VAL-01's *upload-time* checking of supplier values; the two never overlap. Second, the checks are about references, uniqueness, and syntax, not field-attribute semantics: nothing here reasons about whether `read_only`, `strict`, or `must_be_empty` are coherent (e.g., a read-only-but-required field, or the strict default), which is consistent with why those issues slipped past — they were never in this action's remit.
