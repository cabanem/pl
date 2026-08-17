# validate_config — v2 (form-channel viability release)
# Deltas from v1:
#   - REMOVED: form_field_limit input field
#   - REMOVED: form_field_limit variable read in execute
#   - REMOVED: "FORM FIELD LIMIT CHECK" block (superseded by CAN-01's per-family,
#              closure-aware form_channel viability computation)
#   - ADDED:   ambiguous_cascade_parent check (mirrors CAN-01 self-check 3c so the
#              contradiction surfaces at preflight with a structured message instead
#              of a model-build failure)
#   - UPDATED: help text
# No changes required to any method, pick list, or object definition used by this
# action (parse_interval and validation_check are consumed unchanged).

    # Validate config
    validate_config: {
      title: "Validate config",
      subtitle: "Perform referential integrity and constraint checks on parsed config",
      help: lambda do
        {
          body: "Called after parsing, before writing to Data Tables. \n" \
          "Takes the parsed config from Action 1 and runs cross-entity validation: FK references, uniqueness, syntax checks. Returns a structured pass/fail report. \n" \
          "Form-channel capacity is NOT checked here: slot-level viability (per control-type family, with cascade closure) is computed by CAN-01 and stamped as CFG_TemplateVersion.form_channel_status."
        }
      end,

      input_fields: lambda do |_object_definitions|
        [
          { name: "parsed_config_json", type: "string",   label: "Parsed config JSON", control_type: "text-area",
            hint: "Output of parse_config_file (parsed_config_json field). Read from FileStorage by the caller." }
        ]
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: "status",        type: "string" },  # valid | invalid
          { name: "error_count",   type: "integer" },
          { name: "warning_count", type: "integer" },
          { name: "warnings",      type: "array", of: "object", properties: object_definitions["validation_check"] },
          { name: "checks",        type: "array", of: "object", properties: object_definitions["validation_check"] }
        ]
      end,

      execute: lambda do |_connection, input, _eis, _eos, _continue|
        raw_config = input["parsed_config_json"]
        pc = case raw_config
             when String
               begin
                 JSON.parse(raw_config)
               rescue JSON::ParserError => e
                 error("Invalid parsed_config_json: #{e.message}")
               end
             when Hash
               raw_config
             else
               error("parsed_config_json is required (string or hash)")
             end

        fields    = pc["fields"]    || []
        rules     = pc["rules"]     || []
        lookups   = pc["lookups"]   || []
        variants  = pc["variants"]  || []
        suppliers = pc["suppliers"] || []
        users     = pc["users"]     || []
        customer  = pc["customer"]  || {}

        field_names   = fields.map { |f| f["field_name"] }
        lookup_names  = lookups.map { |l| l["lookup_name"] }.uniq
        supplier_names = suppliers.map { |s| s["supplier_name"] }

        checks = []


        # --- REFERENTIAL INTEGRITY CHECKS -------------------------------------------------------------------
        # lookup_references
        bad_lookups = fields
          .select { |f| f["lookup_name"].present? }
          .reject { |f| lookup_names.include?(f["lookup_name"]) }

        checks << {
          "check_name" => "lookup_references",
          "status" => bad_lookups.empty? ? "pass" : "fail",
          "message" => bad_lookups.empty? ? "All lookup references valid" : "#{bad_lookups.size} field(s) reference missing lookups",
          "details" => bad_lookups.map { |f|
            { "entity" => "field", "name" => f["field_name"],
              "issue" => "lookup_name '#{f['lookup_name']}' not found in lookups" }
          }
        }

        # bound_lookup_names
        bound_lookup_names = (
          fields.map { |f| f["lookup_name"] } +
          fields.map { |f| f["depends_on_lookup_name"] }
        ).reject(&:blank?).uniq

        values_by_lookup = lookups.group_by { |l| l["lookup_name"] }
        empty_bound = bound_lookup_names
          .select { |ln| values_by_lookup.key?(ln) }
          .reject { |ln| values_by_lookup[ln].any? { |l| l["valid_value"].present? } }
        checks << {
          "check_name"  => "lookup_has_values",
          "status"      => empty_bound.empty? ? "pass" : "fail",
          "message"     => empty_bound.empty? ? "All bound lookups have values." : "#{empty_bound.size} bound lookup(s) have no values.",
          "details"     => empty_bound.map { |ln|
            bound_by = fields.select { |f| [f["lookup_name"], f["depends_on_lookup_name"]].include?(ln) }
                          .map { |f| f["field_name"] }
            { "entity"  => "lookup",
              "name"    => ln,
              "issue"   => "Lookup '#{ln}' has rows but no non-blank values (bound by: #{bound_by.join(', ')}). Populate at least one value " \
                  "in the lookups sheet, or unbind the field(s)." }
            }
          }

        # depends_on_references
        bad_deps = fields
          .select { |f| f["depends_on_lookup_name"].present? }
          .reject { |f| lookup_names.include?(f["depends_on_lookup_name"]) }
        checks << {
          "check_name" => "depends_on_references",
          "status" => bad_deps.empty? ? "pass" : "fail",
          "message" => bad_deps.empty? ? "All depends_on references valid" : "#{bad_deps.size} broken depends_on reference(s)",
          "details" => bad_deps.map { |f|
            { "entity" => "field", "name" => f["field_name"],
              "issue" => "depends_on '#{f['depends_on_lookup_name']}' is not a known lookup name" }
          }
        }

        # lookup_no_self_reference
        self_refs = fields.select { |f|
          f["depends_on_lookup_name"].present? &&
          f["lookup_name"] == f["depends_on_lookup_name"]
        }
        checks << {
          "check_name"  => "lookup_name_no_self_reference",
          "status"      => self_refs.empty? ? "pass" : "fail",
          "message"     => self_refs.empty? ? "No self-referential cascade." : "#{self_refs.size} field(s) cascade from their own lookup",
          "details"     => self_refs.map { |f|
            {
              "entity"  => "field",
              "name"    => f["field_name"],
              "issue"   => "depends_on_lookup '#{f['depends_on_lookup_name']}' is the field's own lookup"
            }
          }
        }

        # ambiguous_cascade_parent
        # A lookup consumed by multiple fields AND used as a cascade source is
        # unresolvable: we cannot tell which consuming field gates the dependent.
        # Mirrors CAN-01 self-check 3c so the contradiction surfaces at preflight
        # with a structured message instead of a model-build failure.
        consumers_by_lookup = fields.select { |f| f["lookup_name"].present? }
                                    .group_by { |f| f["lookup_name"] }
        ambiguous = fields
          .select { |f| f["depends_on_lookup_name"].present? }
          .map    { |f| f["depends_on_lookup_name"] }.uniq
          .select { |ln| (consumers_by_lookup[ln] || []).size > 1 }
          .map do |ln|
            consumers  = consumers_by_lookup[ln].map { |f| f["field_name"] }
            dependents = fields.select { |f| f["depends_on_lookup_name"] == ln }
                               .map { |f| f["field_name"] }
            { "entity" => "lookup", "name" => ln,
              "issue"  => "lookup '#{ln}' is used by multiple fields (#{consumers.join(', ')}) " \
                          "AND is the cascade source for (#{dependents.join(', ')}). Cannot " \
                          "determine which consuming field gates the cascade. Consolidate to " \
                          "one consuming field or split '#{ln}' into per-role lookups." }
          end
        checks << {
          "check_name" => "ambiguous_cascade_parent",
          "status"     => ambiguous.empty? ? "pass" : "fail",
          "message"    => ambiguous.empty? ? "All cascade parents unambiguous" :
                            "#{ambiguous.size} ambiguous cascade parent(s)",
          "details"    => ambiguous
        }

        # lookup_rows_by_name
        lookup_rows_by_name = lookups.group_by { |l| l["lookup_name"] }
        childless_parents = []
        fields.select { |f| f["depends_on_lookup_name"].present? && f["lookup_name"].present? }.each do |f|
          child_lookup  = f["lookup_name"]
          parent_lookup = f["depends_on_lookup_name"]

          parent_values = (lookup_rows_by_name[parent_lookup] || []).map { |l| l["valid_value"] }.compact.uniq
          referenced    = (lookup_rows_by_name[child_lookup]  || []).map { |l| l["parent_value"] }.compact.uniq

          (parent_values - referenced).each do |pv|
            childless_parents << {
              "entity" => "lookup",
              "name" => child_lookup,
              "issue"  => "parent value '#{pv}' (from '#{parent_lookup}') has no '#{child_lookup}' options — " \
                          "a supplier selecting it gets an empty dropdown. Add child rows or confirm it's intentional."
            }
          end
        end
        checks << {
          "check_name" => "cascade_parent_has_children",
          "status"     => childless_parents.empty? ? "pass" : "warn",
          "message"    => childless_parents.empty? ?
                            "Every cascade parent value has child options" :
                            "#{childless_parents.size} parent value(s) lead to an empty dependent dropdown",
          "details"    => childless_parents
        }

        # suffix collisions
        suffix_collisions = lookups
          .select { |l| l["valid_value"].to_s.include?(CASCADE_SUFFIX_DELIM) }
          .group_by { |l| [l["lookup_name"], l["valid_value"]] }
          .select { |_, group| group.map { |l| l["parent_value"] }.compact.uniq.size > 1 }
          .map do |(ln, val), group|
            parents = group.map { |l| l["parent_value"] }.compact.uniq
            { "entity" => "lookup", "name" => ln,
              "issue"  => "value '#{val}' appears under #{parents.size} parents " \
                          "(#{parents.join(', ')}). The '#{CASCADE_SUFFIX_DELIM}' suffix " \
                          "exists to make each value unique to one parent; give these " \
                          "rows distinct suffixes." }
          end

        checks << {
          "check_name" => "cascade_suffix_disambiguates",
          "status"     => suffix_collisions.empty? ? "pass" : "fail",
          "message"    => suffix_collisions.empty? ?
                            "Suffixed lookup values each resolve to one parent" :
                            "#{suffix_collisions.size} suffixed value(s) span multiple parents",
          "details"    => suffix_collisions
        }

        # rule_target_field_exists
        bad_targets = rules.reject { |r| field_names.include?(r["target_field_name"]) }
        checks << {
          "check_name" => "rule_target_field_exists",
          "status" => bad_targets.empty? ? "pass" : "fail",
          "message" => bad_targets.empty? ? "All rule targets valid" : "#{bad_targets.size} rule(s) target missing fields",
          "details" => bad_targets.map { |r|
            { "entity" => "rule", "name" => r["target_field_name"],
              "issue" => "target field not found" }
          }
        }

        # rule_condition_field_exists
        bad_conds = rules
          .select { |r| r["condition_field_name"].present? }
          .reject { |r| field_names.include?(r["condition_field_name"]) }
        checks << {
          "check_name" => "rule_condition_field_exists",
          "status" => bad_conds.empty? ? "pass" : "fail",
          "message" => bad_conds.empty? ? "All rule condition fields valid" : "#{bad_conds.size} rule(s) reference missing condition fields",
          "details" => bad_conds.map { |r|
            { "entity" => "rule", "name" => r["target_field_name"],
              "issue" => "condition field '#{r['condition_field_name']}' not found" }
          }
        }

        # variant_field_exists
        bad_variant_fields = variants.flat_map { |v|
          (v["visible_field_names"] || [])
            .reject { |fn| field_names.include?(fn) }
            .map { |fn| { "entity" => "variant", "name" => v["variant_name"], "issue" => "field '#{fn}' not found" } }
        }
        checks << {
          "check_name" => "variant_field_exists",
          "status" => bad_variant_fields.empty? ? "pass" : "fail",
          "message" => bad_variant_fields.empty? ? "All variant field references valid" : "#{bad_variant_fields.size} broken variant field reference(s)",
          "details" => bad_variant_fields
        }

        # variant_has_visible_fields
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
        # Data-model v2 invariant 6: each supplier has exactly one user with primary = true. Enforces both directions:
        #   - zero primaries      → no designated assignee for the request task
        #   - multiple primaries  → ambiguous task ownership
        # Suppliers referenced by no users are caught by user_supplier_exists and skipped here (no users to check).
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

        # dependent_dropdown_has_parent
        dep_dropdowns = fields.select { |f| f["data_format"] == "dropdown (dependent)" }
        bad_dep = dep_dropdowns.map do |f|
          problems = []
          problems << "no lookup_name on the dependent field" if f["lookup_name"].blank?

          if f["depends_on_lookup_name"].blank?
            problems << "no depends_on (parent lookup) set"
          else
            parent_lookup = f["depends_on_lookup_name"]
            problems << "parent lookup '#{parent_lookup}' not found" unless lookup_names.include?(parent_lookup)
            parent_field = fields.find { |pf| pf["lookup_name"] == parent_lookup }
            problems << "no field uses parent lookup '#{parent_lookup}' (nothing to cascade from)" if parent_field.nil?
          end

          problems.empty? ? nil : { "entity" => "field", "name" => f["field_name"], "issue" => problems.join("; ") }
        end.compact
        checks << {
          "check_name" => "dependent_dropdown_has_parent",
          "status" => bad_dep.empty? ? "pass" : "fail",
          "message" => bad_dep.empty? ? "All dependent dropdowns have valid parents" : "#{bad_dep.size} dependent dropdown(s) missing parent config",
          "details" => bad_dep
        }

        # cascade_parent_values_populated
        lookup_rows_by_name = lookups.group_by { |l| l["lookup_name"] }
        cascade_issues = []
        fields.select { |f| f["data_format"] == "dropdown (dependent)" }.each do |f|
          child_lookup  = f["lookup_name"]
          parent_lookup = f["depends_on_lookup_name"]
          next if child_lookup.blank? || parent_lookup.blank?  # shape errors already caught above

          parent_set = (lookup_rows_by_name[parent_lookup] || []).map { |l| l["valid_value"] }.compact
          child_rows = lookup_rows_by_name[child_lookup] || []

          if child_rows.empty?
            cascade_issues << { "entity" => "field", "name" => f["field_name"],
              "issue" => "child lookup '#{child_lookup}' has no rows" }
            next
          end

          missing = child_rows.count { |l| l["parent_value"].blank? }
          if missing > 0
            cascade_issues << { "entity" => "lookup", "name" => child_lookup,
              "issue" => "#{missing} of #{child_rows.size} row(s) have no parent_value — cascade would render flat. " \
                        "Map each '#{child_lookup}' value to a '#{parent_lookup}' value." }
          end

          child_rows.reject { |l| l["parent_value"].blank? }
                    .reject { |l| parent_set.include?(l["parent_value"]) }
                    .each do |l|
            cascade_issues << { "entity" => "lookup", "name" => child_lookup,
              "issue" => "parent_value '#{l['parent_value']}' for value '#{l['valid_value']}' " \
                        "is not a valid '#{parent_lookup}' value" }
          end
        end
        checks << {
          "check_name" => "cascade_parent_values_populated",
          "status"     => cascade_issues.empty? ? "pass" : "fail",
          "message"    => cascade_issues.empty? ?
                            "All dependent dropdowns have fully mapped parents" :
                            "#{cascade_issues.size} cascade mapping issue(s)",
          "details"    => cascade_issues
        }

        # dropdown_has_lookup
        unbound_dropdowns = fields.select { |f| f["data_format"].to_s == "dropdown" && f["lookup_name"].blank? }
        checks << {
          "check_name"  => "dropdown_has_lookup",
          "status"      => unbound_dropdowns.empty? ? "pass" : "warn",
          "message"     => unbound_dropdowns.empty? ?
                            "All dropdown fields bind a lookup" :
                            "#{unbound_dropdowns.size} dropdown field(s) have no lookup bound",
          "details"    => unbound_dropdowns.map { |f|
            { "entity" => "field",
              "name"   => f["field_name"],
              "issue"  => "data_format 'dropdown' but no lookup_name; field is rendered as free text" }
          }
        }

        # plain dropdown whose lookup has no unparented rows renders empty.
        flat_dropdown_issues = fields
          .select { |f| f["data_format"].to_s == "dropdown" && f["lookup_name"].present? }
          .reject { |f| (lookup_rows_by_name[f["lookup_name"]] || [])
                          .any? { |l| l["parent_value"].blank? } }
          .map do |f|
            ln = f["lookup_name"]
            distinct = (lookup_rows_by_name[ln] || []).map { |l| l["valid_value"] }.uniq.size
            { "entity" => "field", "name" => f["field_name"],
              "issue"  => "plain dropdown bound to '#{ln}', but every row in that lookup " \
                          "carries a parent_value. The field renders empty unless the " \
                          "options are flattened (#{distinct} distinct value(s)). Either " \
                          "set data_format to 'dropdown (dependent)' with the correct " \
                          "'Depends on', or add unparented rows." }
          end

        checks << {
          "check_name" => "plain_dropdown_lookup_has_root_values",
          "status"     => flat_dropdown_issues.empty? ? "pass" : "warn",
          "message"    => flat_dropdown_issues.empty? ?
                            "All plain dropdowns have unparented lookup values" :
                            "#{flat_dropdown_issues.size} plain dropdown(s) bound to fully-parented lookups",
          "details"    => flat_dropdown_issues
        }
        # --- CONSTRAINT CHECKS ------------------------------------------------------------------------------
        # no_duplicate_field_names
        dupes = field_names.group_by { |n| n }.select { |_, v| v.size > 1 }.keys
        checks << {
          "check_name" => "no_duplicate_field_names",
          "status" => dupes.empty? ? "pass" : "fail",
          "message" => dupes.empty? ? "All field names unique" : "#{dupes.size} duplicate field name(s)",
          "details" => dupes.map { |d| { "entity" => "field", "name" => d, "issue" => "duplicate" } }
        }

        # no_duplicate_supplier_names
        sup_dupes = supplier_names.group_by { |n| n }.select { |_, v| v.size > 1 }.keys
        checks << {
          "check_name" => "no_duplicate_supplier_names",
          "status" => sup_dupes.empty? ? "pass" : "fail",
          "message" => sup_dupes.empty? ? "All supplier names unique" : "#{sup_dupes.size} duplicate supplier name(s)",
          "details" => sup_dupes.map { |d| { "entity" => "supplier", "name" => d, "issue" => "duplicate" } }
        }

        # no_duplicate_user_per_supplier
        user_dupes = users
          .group_by { |u| u["supplier_name"] }
          .flat_map { |sup, group|
            email_dupes = group.map { |u| u["user_email"] }
                               .group_by { |e| e }
                               .select { |_, v| v.size > 1 }
                               .keys
            email_dupes.map { |e| { "entity" => "user", "name" => e, "issue" => "duplicate email within supplier '#{sup}'" } }
          }
        checks << {
          "check_name" => "no_duplicate_user_per_supplier",
          "status" => user_dupes.empty? ? "pass" : "fail",
          "message" => user_dupes.empty? ? "No duplicate users per supplier" : "#{user_dupes.size} duplicate user(s)",
          "details" => user_dupes
        }

        # no_duplicate_lookup_entries
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

        # required_fields_present
        req_issues = []
        req_issues << { "entity" => "field", "name" => "-", "issue" => "No fields defined" } if fields.empty?
        req_issues << { "entity" => "supplier", "name" => "-", "issue" => "No suppliers defined" } if suppliers.empty?
        checks << {
          "check_name" => "required_fields_present",
          "status" => req_issues.empty? ? "pass" : "fail",
          "message" => req_issues.empty? ? "Required entities present" : "Missing required entities",
          "details" => req_issues
        }

        # variant_count_matches (warning)
        actual_variant_count = variants.size
        expected = customer["variant_count"].to_i
        vc_match = actual_variant_count == expected
        checks << {
          "check_name" => "variant_count_matches",
          "status" => vc_match ? "pass" : "warn",
          "message" => vc_match ? "Variant count matches" : "Expected #{expected} variants, found #{actual_variant_count}",
          "details" => vc_match ? [] : [{ "entity" => "variant", "name" => "-", "issue" => "count mismatch" }]
        }


        # --- SYNTAX CHECKS ----------------------------------------------------------------------------------
        # interval_notation_valid
        interval_fields = %w[field_length_validation numeric_field_validation date_field_validation]
        bad_intervals = fields.flat_map { |f|
          interval_fields
            .select { |iv| f[iv].present? }
            .map { |iv| { field: f, prop: iv, parsed: call(:parse_interval, f[iv]) } }
            .select { |r| r[:parsed]["type"] == "invalid" }
            .map { |r| { "entity" => "field", "name" => r[:field]["field_name"], "issue" => "Invalid #{r[:prop]}: #{f[r[:prop]]}" } }
        }
        checks << {
          "check_name" => "interval_notation_valid",
          "status" => bad_intervals.empty? ? "pass" : "fail",
          "message" => bad_intervals.empty? ? "All interval notations valid" : "#{bad_intervals.size} invalid interval(s)",
          "details" => bad_intervals
        }

        # email_format_valid (warning)
        email_regex = /\A[^@\s]+@[^@\s]+\.[^@\s]+\z/
        bad_emails = []
        bad_emails << { "entity" => "customer", "name" => "analyst_email", "issue" => "invalid format" } if customer["analyst_email"].present? && !customer["analyst_email"].match?(email_regex)
        users.each do |u|
          bad_emails << { "entity" => "user", "name" => u["user_email"], "issue" => "invalid format" } if u["user_email"].present? && !u["user_email"].match?(email_regex)
        end
        checks << {
          "check_name" => "email_format_valid",
          "status" => bad_emails.empty? ? "pass" : "warn",
          "message" => bad_emails.empty? ? "All emails valid" : "#{bad_emails.size} invalid email(s)",
          "details" => bad_emails
        }

        # redundancy
        redundant = fields.select { |f| f["supplier_hidden"] && f["read_only"] }
        checks << {
          "check_name"  => "hidden_field_readonly_redundant",
          "status"      => redundant.empty? ? "pass" : "warn",
          "message"     => redundant.empty? ? "No redundant read-only flags on hidden fields" : "#{redundant.size} hidden field(s) also marked read-only (redundant)",
          "details"     => redundant.map { |f|
            { "entity"  => "field", "name" => f["field_name"], "issue" => "Field is hidden from suppliers, so read-only has no effect. Leave read-only off unless the field may be later un-hidden." }
          }
        }


        # --- CALCULATE AND RETURN ---------------------------------------------------------------------------
        error_count       = checks.count { |c| c["status"] == "fail" }
        warning_count     = checks.count { |c| c["status"] == "warn" }
        flagged_warnings  = checks.select { |c| c["status"] == "warn" }

        {
          "status"        => error_count > 0 ? "invalid" : "valid",
          "error_count"   => error_count,
          "warning_count" => warning_count,
          "warnings"      => flagged_warnings,
          "checks"        => checks
        }
      end
    },
