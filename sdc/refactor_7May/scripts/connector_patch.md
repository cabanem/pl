# Connector patch — variant emptiness + lookup duplicate detection

Two scoped, surgical edits to
`functional_core_for_sdc_multi_workspace_custom_adapter.rb`, both inside
the `validate_config` action's execute lambda. Both are additions/fixes to
the analyst-facing validation layer, so the analyst sees the errors at
config-validation time before any provisioning starts.

The two changes:

1. **Add `variant_has_visible_fields` check** — catches variants declared
   with no fields marked visible. Currently this slips past all
   validation and only surfaces at template-render time in PRV-04, after
   provisioning has completed.

2. **Fix `no_duplicate_lookup_entries` to use composite key** — current
   check false-positives on cascading lookups where the same value
   legitimately appears under different parent values. Also incorporates
   the pending `valid_values` → `valid_value` rename (which is part of
   the broader renames patch that hasn't shipped yet).

Both changes are confined to `validate_config`. No method additions, no
schema changes, no other action changes.

## Edit 1 — Add `variant_has_visible_fields` check

**Location:** Insert immediately after the `variant_field_exists` check
(currently ending at line 1387 with the closing `}` of the check hash),
and immediately before the `user_supplier_exists` check (currently
starting at line 1389).

**Why this placement:** the new check is logically the sibling of
`variant_field_exists`. That check answers "are all named fields real?"
This one answers "does each variant have at least one named field?"
They're both about variant integrity. Placing them adjacent makes the
intent clear when someone reads the validate_config body in file order.

**The code to insert:**

```ruby

        # variant_has_visible_fields
        # Catches "analyst declared a variant column but didn't mark any
        # fields visible for it." The XLSX renderer would otherwise
        # produce a degenerate template with no data columns, and PRV-04
        # would fail the entire publication after all provisioning work
        # completes. Earlier is cheaper.
        #
        # Note on synthesis: synthesize_base_variant either emits one
        # base variant containing every parsed field OR no variant at
        # all (when there are no fields to include). The empty-visible-
        # field-list case only arises from explicit-but-incomplete
        # variant columns in `6_variants`.
        empty_variants = variants.select { |v| (v["visible_field_names"] || []).empty? }
        checks << {
          "check_name" => "variant_has_visible_fields",
          "status"     => empty_variants.empty? ? "pass" : "fail",
          "message"    => empty_variants.empty? ?
                            "All variants have at least one visible field" :
                            "#{empty_variants.size} variant(s) have no visible fields",
          "details"    => empty_variants.map { |v|
            { "entity" => "variant", "name" => v["variant_name"],
              "issue"  => "Variant '#{v['variant_name']}' has no fields marked visible. " \
                          "In master config sheet 6_variants, mark at least one field " \
                          "as TRUE for this variant, or remove the variant's column " \
                          "entirely." }
          }
        }
```

**Result after edit:** the file gets one new check, in the referential
integrity section between `variant_field_exists` and `user_supplier_exists`.
The check fails the config (returns `status: "invalid"` overall) when any
variant has no visible fields, with a sheet-specific actionable error
message.

## Edit 2 — Fix `no_duplicate_lookup_entries`

**Location:** Replace the existing `no_duplicate_lookup_entries` check
block at lines 1488-1503.

**Why this needs fixing:** the current implementation has two distinct
problems:

First, it reads `l["valid_values"]` (plural) on line 1492. After the
recent PRV-02 patches and the parser rename to `valid_value` (singular),
this reads a key that doesn't exist on the parsed lookup rows. The
duplicate detection runs against a list of nils, which produces a single
duplicate group `[nil, nil, nil, ...]` and fires the check with one
spurious "duplicate" entry for every lookup. (This is part of the
broader renames-patch that hasn't shipped yet; consolidating the fix
here lets you ship the duplicate-detection fix without waiting for the
full renames patch.)

Second — and more importantly — even with the rename applied, the check
groups duplicates by `valid_value` only, not by `(valid_value, parent_value)`.
For cascading lookups where the same value legitimately appears under
different parents (e.g., "Finance" appears under both "US" and "CA"
country parents in a `job_class` lookup), the check fires false positives.

**The replacement code:**

Current block (lines 1488-1503):

```ruby
        # no_duplicate_lookup_entries
        lookup_dupes = lookups
          .group_by { |l| l["lookup_name"] }
          .flat_map { |ln, group|
            val_dupes = group.map { |l| l["valid_values"] }
                             .group_by { |v| v }
                             .select { |_, vs| vs.size > 1 }
                             .keys
            val_dupes.map { |v| { "entity" => "lookup", "name" => ln, "issue" => "duplicate value '#{v}'" } }
          }
        checks << {
          "check_name" => "no_duplicate_lookup_entries",
          "status" => lookup_dupes.empty? ? "pass" : "fail",
          "message" => lookup_dupes.empty? ? "No duplicate lookup values" : "#{lookup_dupes.size} duplicate lookup value(s)",
          "details" => lookup_dupes
        }
```

Replace with:

```ruby
        # no_duplicate_lookup_entries
        # Detects duplicate entries within a lookup. The uniqueness key
        # depends on whether the lookup is cascading:
        #
        # - Non-cascading lookup (all rows have parent_value == nil):
        #     uniqueness on valid_value alone.
        #     Example: country_iso lookup. "US" must appear once.
        #
        # - Cascading lookup (rows have parent_value populated):
        #     uniqueness on (valid_value, parent_value) tuple.
        #     Example: job_class lookup. "Finance" can appear once
        #     under each parent country, but not twice under the same
        #     parent.
        #
        # The composite key handles both cases uniformly: for
        # non-cascading lookups, parent_value is nil for every row, so
        # the tuple collapses to (valid_value, nil) which preserves the
        # original semantics. For cascading lookups, the tuple correctly
        # disambiguates legitimate cross-parent repetition from genuine
        # within-parent duplication.
        lookup_dupes = lookups
          .group_by { |l| l["lookup_name"] }
          .flat_map { |ln, group|
            composite_dupes = group
              .map { |l| [l["valid_value"], l["parent_value"]] }
              .group_by { |k| k }
              .select { |_, ks| ks.size > 1 }
              .keys
            composite_dupes.map { |val, parent|
              issue = parent ?
                        "duplicate value '#{val}' under parent '#{parent}'" :
                        "duplicate value '#{val}'"
              { "entity" => "lookup", "name" => ln, "issue" => issue }
            }
          }
        checks << {
          "check_name" => "no_duplicate_lookup_entries",
          "status"     => lookup_dupes.empty? ? "pass" : "fail",
          "message"    => lookup_dupes.empty? ?
                            "No duplicate lookup values" :
                            "#{lookup_dupes.size} duplicate lookup value(s)",
          "details"    => lookup_dupes
        }
```

**Two changes in this replacement:**

1. `group.map { |l| l["valid_values"] }` → `group.map { |l| [l["valid_value"], l["parent_value"]] }`. Fixes both the plural→singular rename and switches to composite key.

2. The detail entry's `issue` string now distinguishes cascading from non-cascading: with a parent, it says "duplicate value 'X' under parent 'Y'"; without, it says "duplicate value 'X'". The conditional keeps non-cascading error messages identical to before, preserving operator familiarity.

## Verification after applying

Three checks worth running before declaring done.

**1. Ruby syntax check.** A misapplied edit (missing brace, unbalanced
quote) shows up here.

```bash
ruby -c functional_core_for_sdc_multi_workspace_custom_adapter.rb
```

Expected: `Syntax OK`.

**2. Spot check the new check fires on an empty variant.** Construct a
small parsed_config with one variant whose `visible_field_names` is an
empty array. Run `validate_config` against it. Expected: `status: "invalid"`,
`error_count: 1`, the failing check is `variant_has_visible_fields` with
a detail entry naming the variant.

**3. Spot check the duplicate-lookup fix on a cascading lookup.**
Construct a parsed_config with a `job_class` lookup containing
`{value: "Finance", parent: "US"}` and `{value: "Finance", parent: "CA"}`.
Run `validate_config`. Expected: `no_duplicate_lookup_entries` passes
(both legitimate). Then add `{value: "Finance", parent: "US"}` a second
time (genuine duplicate). Re-run. Expected: `no_duplicate_lookup_entries`
fails with detail "duplicate value 'Finance' under parent 'US'".

## What this patch does NOT address

A few items intentionally out of scope, surfaced for tracking:

1. **The pending three-rename patch** (cascade rename + valid_values
   rename + cfg_error_translations rename). The valid_value rename is
   *partially* applied here as a side-effect of the lookup-duplicate
   fix, but the other rename sites still need the broader patch from
   `connector_three_renames_patch.md`. Apply the broader patch when
   you're ready; nothing about this patch precludes it.

2. **The semantic bug in `dependent_dropdown_has_parent`** (treats
   depends_on value as a field name when it's a lookup name). Documented
   in the renames patch with a recommendation to remove the check after
   the rename ships, deferring to PRV-02's invariants 3a-3d.

3. **Cascade-row-consistency check** — verifying that every
   `parent_value` in a cascading lookup references a real value in the
   parent lookup. Cleaner to add as a PRV-02 Phase 7 invariant where the
   cascade resolution is already in scope; tracked as a separate follow-up.

4. **Case-sensitivity of lookup_name** — analyst typing "Country_ISO"
   in one place and "country_iso" in another would be treated as
   different lookups. Behavioral change; needs an ADR if pursued.

5. **`project_specific` semantics** — flag is captured and threaded
   through but not consumed by any connector action. Either dead state
   or used downstream of the connector. Worth investigating; not blocking.

These are documented in the audit thread; none is urgent.

## Estimated effort

Ten minutes to apply both edits in a real editor, plus three minutes for
the verification checks. The edits are small and localized; the risk is
mistyping the new strings or pasting in the wrong place. The line
numbers above are accurate against the current source.

After save, the connector version bumps from v11 to v12 (assuming a
version-on-save policy). Note the version bump when releasing; the
release notes should mention both checks.
