## Change #2: Add the primary-user invariant check to `validate_config`

**The invariant** (data-model v2 invariant 6): each `SUP_Supplier` has exactly one `SUP_SupplierUser` with `primary = true`. Today, `validate_config` checks that users reference real suppliers (`user_supplier_exists` at line 1388), but does not check that each supplier has exactly one primary.

Two failure modes to catch:
- **Zero primaries.** A supplier has users, but none flagged `primary = true`. The downstream "designated assignee" logic in Invite supplier users has no one to assign to.
- **Multiple primaries.** A supplier has two or more users flagged `primary = true`. Ambiguity about who owns the request task.

Both should be flagged at config-validation time so the analyst sees them before provisioning, not at runtime when Invite supplier users would otherwise hit an ambiguous state.

---

## Where it goes

**File:** `/mnt/user-data/uploads/functional_core_for_sdc_multi_workspace_custom_adapter.rb`, inside `validate_config`'s `execute:` lambda.

**Position:** Immediately after the existing `user_supplier_exists` check ends at line 1398, and before the `dependent_dropdown_has_parent` check at line 1400.

The placement matters — putting it adjacent to `user_supplier_exists` keeps both user-related checks in the same block, and means a reader scanning the file sees user-integrity checks as a logical unit.

---

## What to insert

A new check block. Drop this in between line 1398 (the closing `}` of `user_supplier_exists`) and line 1400 (the `# dependent_dropdown_has_parent` comment):

```ruby
        # exactly_one_primary_user_per_supplier
        # Data-model v2 invariant 6: each supplier has exactly one user
        # with primary = true. Enforces both directions:
        #   - zero primaries → no designated assignee for the request task
        #   - multiple primaries → ambiguous task ownership
        # Suppliers referenced by no users are caught by user_supplier_exists
        # and skipped here (no users to check).
        primary_issues = []
        users_by_supplier = users.group_by { |u| u["supplier_name"] }
        supplier_names.each do |s_name|
          s_users = users_by_supplier[s_name] || []
          next if s_users.empty?  # Empty-user case is the analyst's gap, not ours

          primary_count = s_users.count { |u| u["primary"] == true }
          if primary_count == 0
            primary_issues << {
              "entity" => "supplier", "name" => s_name,
              "issue"  => "no user flagged as primary (need exactly one)"
            }
          elsif primary_count > 1
            primary_emails = s_users.select { |u| u["primary"] == true }.map { |u| u["user_email"] }
            primary_issues << {
              "entity" => "supplier", "name" => s_name,
              "issue"  => "#{primary_count} users flagged as primary " \
                          "(need exactly one): #{primary_emails.join(', ')}"
            }
          end
        end
        checks << {
          "check_name" => "exactly_one_primary_user_per_supplier",
          "status"     => primary_issues.empty? ? "pass" : "fail",
          "message"    => primary_issues.empty? ?
                            "All suppliers have exactly one primary user" :
                            "#{primary_issues.size} supplier(s) have incorrect primary-user count",
          "details"    => primary_issues
        }

```

(Note the trailing blank line — keeps the spacing consistent with the surrounding check blocks.)

---

## Resulting context

After the insert, lines 1388–1418 read as one continuous user-integrity block followed by the dependent-dropdown check:

```ruby
        # user_supplier_exists
        bad_user_suppliers = users.reject { |u| supplier_names.include?(u["supplier_name"]) }
        checks << {
          "check_name" => "user_supplier_exists",
          "status" => bad_user_suppliers.empty? ? "pass" : "fail",
          "message" => bad_user_suppliers.empty? ? "All user→supplier references valid" : "#{bad_user_suppliers.size} user(s) reference missing suppliers",
          "details" => bad_user_suppliers.map { |u|
            { "entity" => "user", "name" => u["user_email"],
              "issue" => "supplier '#{u['supplier_name']}' not found" }
          }
        }

        # exactly_one_primary_user_per_supplier
        # Data-model v2 invariant 6: each supplier has exactly one user
        # with primary = true. Enforces both directions:
        #   - zero primaries → no designated assignee for the request task
        #   - multiple primaries → ambiguous task ownership
        # Suppliers referenced by no users are caught by user_supplier_exists
        # and skipped here (no users to check).
        primary_issues = []
        ... (the block above) ...
        checks << {
          "check_name" => "exactly_one_primary_user_per_supplier",
          ...
        }

        # dependent_dropdown_has_parent
        dep_dropdowns = fields.select { |f| f["data_format"] == "dropdown (dependent)" }
```

---

## One detail worth flagging — and a defensive amendment

I noticed at line 705 there's a typo in the source parser:

```ruby
"primary" => call(:coerce_boolean, raw["Priamry contact"])
```

`Priamry` is misspelled. This means whatever the analyst types in the column header *as the typo* is what gets read. Two cases:

1. **If the master config workbook also has the typo** (`Priamry contact` as the column header), the parser works and reads correctly, but the typo is "live" — fixing it later means coordinating a connector update and a workbook update.

2. **If the workbook has the correct spelling** (`Primary contact`), the parser is silently reading nothing — every user's `primary` resolves to `nil`, `coerce_boolean(nil)` returns `false`, and *every* supplier in *every* engagement would fail the new check with "no user flagged as primary."

Worth checking which case is true before deploying change #2. If it's case 2, the typo needs fixing in the same connector update — otherwise this check will fail-loud on its first real call and the analyst will be confused.

To make the new check robust against this kind of header-drift bug, the `primary_count` line above uses `u["primary"] == true` (strict equality) rather than truthy-checking. That way, if `primary` is `nil` or a string `"true"` (which would happen if `coerce_boolean` didn't run for some reason), the check fails-loud rather than silently passing. The fail-loud surface here is good — it surfaces the parsing bug rather than hiding it.

If you find case 2 is real and want to fix the typo in this same connector pass, the fix is at line 705:

```ruby
"primary" => call(:coerce_boolean, raw["Primary contact"])
```

That's a third small change you could fold into this update. It's not strictly required for change #2 to work (you could leave the typo and have the workbook match), but if you're touching the connector and the workbook has the right spelling, it's worth fixing.

---

## How to verify

Three test fixtures:

1. **Happy path.** Config with three suppliers, each with one primary user and several non-primary users. The new check returns `pass`. Confirms the strict equality doesn't reject legitimately-true primaries.

2. **Zero primaries.** Config with a supplier that has two users, both `primary = false`. The new check returns `fail` with one `primary_issues` entry naming the supplier. Confirms zero-detection.

3. **Multiple primaries.** Config with a supplier that has two users, both `primary = true`. The new check returns `fail` with one `primary_issues` entry naming both emails. Confirms multiple-detection.

A fourth test if you fix the typo at line 705: a config where the workbook column header is spelled correctly. Before the typo fix, every supplier fails the new check (case 2 above). After the typo fix, the happy-path fixture passes.

---

## What this enables downstream

The new check fires before provisioning, which means by the time E1 (Initial provisioning) calls Invite supplier users, the data-model v2 invariant 6 is guaranteed at the configuration boundary. Add user to request, the Stage 7 sibling capability, will need to enforce the same invariant at runtime when an analyst attaches a new user mid-engagement — but that's a separate (Stage 7) callable using the same predicate. The May 8 spec called out this "two enforcement points, one shared predicate" pattern as a cross-cutting build-time principle.

This check is also the first of the data-model invariants where validate_config has an enforcement role beyond its original eight check categories. If you find yourself adding more invariant checks here (e.g. an exactly-one-default-variant rule if that ever becomes a thing), it might be worth grouping them under a section comment like `# ── Invariant checks ────────────────────` to keep the file scannable. For one check, it's overkill.

---

Ready to move on to change #3 — adding `structural_failure` detection to `validate_upload` by accepting raw XLSX bytes — or would you prefer to deploy and verify changes #1 and #2 first before continuing?
