# ============================================================================
# Functional core — customer block from `_customer`, drift fixes, seed-row checks
#
# Supersedes the earlier patch. Drop-in replacements/additions for the methods,
# object definitions, and action fragments named in each section header.
# Written against GAS library 1.7.0 (schema 1.6, payload 10.0).
# Not executed here (no Workato SDK); review before pasting.
#
# Key names: the wire-name rename (customer.* -> provision payload names) is ON HOLD.
# Existing connector keys are kept; new keys use the same style. reminder_days_1/2/3
# are derived from reminder_days for compatibility until the rename lands.
# ============================================================================


# --- methods.coerce_boolean (REPLACE) ---------------------------------------
# Aligns with the library's TRUTHY_VALUES (true/1/yes). The grid fallback for
# 1_customer sees "Yes"; every other sheet emits native booleans.
coerce_boolean: lambda do |value|
  return false if value.blank?

  normalized = value.to_s.strip.downcase
  %w[1 true yes y].include?(normalized)
end,


# --- methods.default_sheet_config (REPLACE the "customer" entry) ------------
# label_col / value_col are 0-indexed, like header_row. Used only by the grid
# fallback (exports without a `_customer` block). v0.9.9 layout: [ , row_no, label, value, marker ].
"customer" => { "sheet_name" => "1_customer", "label_col" => 2, "value_col" => 3 },


# --- methods.customer_key_map (NEW) -----------------------------------------
# CUSTOMER_FIELDS registry key (as emitted in `_customer.values`) -> connector key.
# ONE place to flip when the wire-name rename is decided.
customer_key_map: lambda do
  {
    "clientName"           => "client_name",
    "analystEmail"         => "analyst_email",
    "applicationName"      => "application_title",
    "targetVms"            => "target_vms",
    "outputDriveFolderId"  => "drive_folder_id",
    "reminderDays"         => "reminder_days",
    "supplierInstructions" => "wfa_instructions",
    "kickoffEmailBody"     => "pre_invite_message_body",
    "lastDayForSubmission" => "submission_deadline",
    "hasSeedData"          => "has_incumbent_data",
    "seedDataDriveId"      => "incumbent_file_id",
    "seedDataSheetName"    => "incumbent_sheet_name",
    "seedDataIndexKey"     => "incumbent_split_field",
    "seedDataHeaderRow"    => "seed_header_row",
    "seedDataFirstDataRow" => "seed_data_start_row",
    "expectedDate"         => "expected_date",
    "variantCount"         => "variant_count"
  }
end,


# --- methods.customer_label_map (NEW) ---------------------------------------
# Grid-fallback only: 1_customer label (downcased, v0.9.9 wording) -> registry key.
# Mirrors Labels in 003_Schema.js. Feeds customer_key_map above.
customer_label_map: lambda do
  {
    "analyst email address"        => "analystEmail",
    "application name"             => "applicationName",
    "customer name"                => "clientName",
    "drive folder id"              => "outputDriveFolderId",
    "last day for data submission" => "lastDayForSubmission",
    "expected completion date"     => "expectedDate",
    "kick off email instructions"  => "kickoffEmailBody",
    "portal instructions"          => "supplierInstructions",
    "reminder cadence"             => "reminderDays",
    "incumbent data flag"          => "hasSeedData",
    "seed data drive file id"      => "seedDataDriveId",
    "seed data sheet name"         => "seedDataSheetName",
    "seed data index key"          => "seedDataIndexKey",
    "seed data header row"         => "seedDataHeaderRow",
    "seed data first data row"     => "seedDataFirstDataRow",
    "target vms"                   => "targetVms",
    "variant count"                => "variantCount"
  }
end,


# --- methods.parse_customer_sheet (REPLACE) ---------------------------------
# Returns { "customer" => {...}, "warnings" => [...] }, or nil when neither a
# `_customer` block nor the 1_customer sheet is present.
#
# Primary path: `_customer.values` (library >= 1.7.0) — the same named-range read
# that feeds the provision webhook, so the two cannot disagree. Fallback: parse the
# raw 1_customer grid by label (pre-1.7.0 exports), surfacing drift as warnings.
parse_customer_sheet: lambda do |sheets, cfg|
  warnings = []
  by_key   = {}          # registry key -> raw value

  if sheets["_customer"].is_a?(Hash) && sheets["_customer"]["values"].is_a?(Hash)
    by_key = sheets["_customer"]["values"]
    (sheets["_customer"]["unresolved"] || []).each do |k|
      warnings << { "sheet" => cfg["sheet_name"],
                    "issue" => "Customer field '#{k}' unresolved in the workbook (named range and label both missing); read as nil." }
    end
  else
    raw = sheets[cfg["sheet_name"]]
    return nil if raw.blank?

    warnings << { "sheet" => cfg["sheet_name"],
                  "issue" => "Export has no `_customer` block (library < 1.7.0); customer values parsed from the grid by label." }
    label_col = (cfg["label_col"] || 2).to_i
    value_col = (cfg["value_col"] || 3).to_i
    label_map = call(:customer_label_map)

    raw.each do |row|
      next if row.blank? || row.size <= value_col
      label = row[label_col].to_s.strip
      next if label.empty?
      key = label_map[label.downcase]
      if key.nil?
        if row[value_col].to_s.strip.present?
          warnings << { "sheet" => cfg["sheet_name"], "issue" => "Unmapped label '#{label}'; value discarded." }
        end
        next
      end
      by_key[key] = row[value_col]
    end
    (label_map.values - by_key.keys).each do |k|
      warnings << { "sheet" => cfg["sheet_name"], "issue" => "No row labelled for '#{k}'; read as nil." }
    end
  end

  # Registry key -> connector key, with boundary coercion. `_customer` already carries
  # typed values; the grid fallback carries raw cells. Both go through the same coercers.
  text = ->(k) { by_key[k].to_s.strip }
  opt  = ->(k) { by_key[k].to_s.strip.presence }
  int  = ->(k) { by_key[k].to_s.strip.presence&.to_i }
  ints = lambda do |k|
    v = by_key[k]
    list = v.is_a?(Array) ? v : v.to_s.split(/[,;\s]+/)
    list.map { |x| x.to_s.strip }.reject(&:empty?).map(&:to_i).select { |n| n > 0 }
  end

  reminder_days = ints.call("reminderDays")
  header_row    = int.call("seedDataHeaderRow") || 1               # blank = plain file; same rule as Preflight

  customer = {
    "client_name"             => text.call("clientName"),
    "analyst_email"           => text.call("analystEmail"),
    "application_title"       => text.call("applicationName"),
    "target_vms"              => text.call("targetVms"),
    "drive_folder_id"         => text.call("outputDriveFolderId"),
    "reminder_days"           => reminder_days,
    "reminder_days_1"         => reminder_days[0],                  # compatibility until the rename lands
    "reminder_days_2"         => reminder_days[1],
    "reminder_days_3"         => reminder_days[2],
    "wfa_instructions"        => text.call("supplierInstructions"),
    "pre_invite_message_body" => opt.call("kickoffEmailBody"),
    "submission_deadline"     => opt.call("lastDayForSubmission"),
    "has_incumbent_data"      => call(:coerce_boolean, by_key["hasSeedData"]),
    "incumbent_file_id"       => opt.call("seedDataDriveId"),
    "incumbent_sheet_name"    => opt.call("seedDataSheetName"),
    "incumbent_split_field"   => opt.call("seedDataIndexKey"),
    "seed_header_row"         => header_row,
    "seed_data_start_row"     => int.call("seedDataFirstDataRow") || header_row + 1,
    "expected_date"           => opt.call("expectedDate"),
    "variant_count"           => int.call("variantCount") || 0
  }

  { "customer" => customer, "warnings" => warnings }
end,


# --- methods.rules_column_map (REPLACE) -------------------------------------
# v0.9.9 renamed two 4_complex_validations headers. With the old map every rule
# would parse with conditional_value = nil and strict_enforcement = false.
rules_column_map: lambda do
  {
    "Target field"          => "target_field_name",
    "Rule or action"        => "rule",
    "Condition field"       => "condition_field_name",
    "Condition value"       => "conditional_value",      # was "Conditional value"
    "Default error message" => "error_message",
    "Custom error message"  => "error_message_custom",
    "Strict?"               => "strict_enforcement"      # was "Strict enforcement"
  }
end,


# --- methods.header_drift_warnings (NEW) ------------------------------------
# The net parse_fields_sheet already carries inline, factored out so every tabular
# parser gets it. parse_rules_sheet had none, which is why the renames above were invisible.
header_drift_warnings: lambda do |sheet_name, headers, col_map|
  seen = (headers || []).map { |h| h.to_s.strip }
                        .reject { |h| h.empty? || h.start_with?("_pk_") }
  warnings = []
  col_map.keys.reject { |k| seen.include?(k) }.each do |k|
    warnings << { "sheet" => sheet_name,
                  "issue" => "Mapped column '#{k}' not found in sheet headers; values read as nil." }
  end
  seen.reject { |h| col_map.key?(h) }.each do |h|
    warnings << { "sheet" => sheet_name,
                  "issue" => "Sheet column '#{h}' is not mapped; values discarded." }
  end
  warnings
end,
# In parse_rules_sheet, right after `warnings = []`:
#   warnings.concat(call(:header_drift_warnings, cfg["sheet_name"], extracted["headers"], col_map))
# parse_fields_sheet can replace its inline block with the same call.


# --- methods.suppliers_column_map / parse_suppliers_sheet (REPLACE) ---------
# "Has incumbent data?" was retired at schema 1.3 (per-supplier seeding is derived
# by INC-01's reconcile). has_seeded_data is dropped from the output entirely.
suppliers_column_map: lambda do
  {
    "Supplier name"      => "supplier_name",
    "Template variation" => "variant_name"
  }
end,

parse_suppliers_sheet: lambda do |sheets, cfg|
  extracted = call(:extract_sheet_rows, sheets, cfg)
  return { "rows" => [], "skipped" => 0, "error" => extracted["error"] } if extracted["error"].present?

  col_map  = call(:suppliers_column_map)
  warnings = call(:header_drift_warnings, cfg["sheet_name"], extracted["headers"], col_map)
              .reject { |w| w["issue"].start_with?("Sheet column 'Number of users'") }   # derived column, expected

  rows = extracted["rows"].map do |raw|
    {
      "supplier_name" => raw["Supplier name"].to_s.strip,
      "variant_name"  => raw["Template variation"].to_s.strip.presence
    }
  end

  { "rows" => rows, "skipped" => extracted["skipped"], "warnings" => warnings }
end,
# parse_config_file.execute, step 7: also `warnings.concat(suppliers_result["warnings"] || [])`.


# --- methods.users_column_map / parse_users_sheet (REPLACE) -----------------
# "Primary contact" was dropped from 3_users in the v0.9.9 template. primary is now
# DERIVED: the first user listed per supplier. Extra users are warned about so the
# analyst knows who owns the request task. (Confirm this rule — see reminders.)
users_column_map: lambda do
  {
    "Supplier user email"   => "user_email",
    "Supplier name"         => "supplier_name",
    "Supplier contact name" => "contact_name"
  }
end,

parse_users_sheet: lambda do |sheets, cfg|
  extracted = call(:extract_sheet_rows, sheets, cfg)
  return { "rows" => [], "skipped" => 0, "error" => extracted["error"] } if extracted["error"].present?

  col_map  = call(:users_column_map)
  warnings = call(:header_drift_warnings, cfg["sheet_name"], extracted["headers"], col_map)

  rows = extracted["rows"].map do |raw|
    {
      "user_email"    => raw["Supplier user email"].to_s.strip,
      "supplier_name" => raw["Supplier name"].to_s.strip,
      "contact_name"  => raw["Supplier contact name"].to_s.strip.presence
    }
  end.reject { |u| u["user_email"].empty? && u["supplier_name"].empty? }   # phantom rows

  seen = {}
  rows.each do |u|
    u["primary"] = !seen[u["supplier_name"]]
    seen[u["supplier_name"]] = true
  end
  rows.group_by { |u| u["supplier_name"] }.each do |s_name, s_users|
    next if s_name.to_s.strip.empty? || s_users.size < 2
    warnings << { "sheet" => cfg["sheet_name"],
                  "issue" => "Supplier '#{s_name}' lists #{s_users.size} users; the first listed " \
                             "('#{s_users.first['user_email']}') is primary." }
  end

  { "rows" => rows, "skipped" => extracted["skipped"], "warnings" => warnings }
end,
# validate_config: DELETE the exactly_one_primary_user_per_supplier check — it is
# now true by construction. user_supplier_exists and no_duplicate_user_per_supplier stay.


# --- object_definitions.customer_definition (REPLACE) -----------------------
customer_definition: {
  fields: lambda do |_connection, _config|
    [
      { name: "client_name",             type: "string" },
      { name: "analyst_email",           type: "string" },
      { name: "application_title",       type: "string" },
      { name: "target_vms",              type: "string" },
      { name: "drive_folder_id",         type: "string" },
      { name: "reminder_days",           type: "array",   of: "integer",
        hint: "Reminder cadence as entered on 1_customer: day offsets from the initial request, analyst order." },
      { name: "reminder_days_1",         type: "integer", optional: true, hint: "Derived: reminder_days[0]. Compatibility only." },
      { name: "reminder_days_2",         type: "integer", optional: true, hint: "Derived: reminder_days[1]. Compatibility only." },
      { name: "reminder_days_3",         type: "integer", optional: true, hint: "Derived: reminder_days[2]. Compatibility only." },
      { name: "wfa_instructions",        type: "string",  optional: true },
      { name: "pre_invite_message_body", type: "string",  optional: true },
      { name: "submission_deadline",     type: "string",  optional: true,
        hint: "Last day for data submission, YYYY-MM-DD. String for the same reason as expected_date." },
      { name: "has_incumbent_data",      type: "boolean" },
      { name: "incumbent_file_id",       type: "string",  optional: true },
      { name: "incumbent_sheet_name",    type: "string",  optional: true },
      { name: "incumbent_split_field",   type: "string",  optional: true,
        hint: "Seed column whose distinct values are matched to the supplier roster (INC-01 index_key)." },
      { name: "seed_header_row",         type: "integer",
        hint: "1-based Excel row holding the seed file's column headers. Defaults to 1 when blank on 1_customer." },
      { name: "seed_data_start_row",     type: "integer",
        hint: "1-based Excel row where seed data begins. Defaults to header row + 1. Lets VMS template sheets skip description rows." },
      { name: "expected_date",           type: "string",
        hint: "Expected completion date, YYYY-MM-DD (date-only, workbook-timezone rendering). Deliberately a string, " \
              "not date_time - convert to datetime only at a date_time table-column write, where the timezone decision is explicit." },
      { name: "variant_count",           type: "integer" }
    ]
  end
},


# --- object_definitions.supplier_definition (REPLACE) -----------------------
supplier_definition: {
  fields: lambda do |_connection, _config|
    [
      { name: "supplier_name", type: "string" },
      { name: "variant_name",  type: "string", optional: true }
    ]
  end
},


# --- object_definitions.sheet_config_entry (REPLACE) ------------------------
sheet_config_entry: {
  fields: lambda do |_connection, _config|
    [
      { name: "sheet_name",            type: "string" },
      { name: "header_row",            type: "integer", optional: true },
      { name: "data_start_row",        type: "integer", optional: true },
      { name: "variant_columns_start", type: "integer", optional: true },
      { name: "label_col",             type: "integer", optional: true, hint: "Key-value sheets only (1_customer grid fallback)." },
      { name: "value_col",             type: "integer", optional: true, hint: "Key-value sheets only (1_customer grid fallback)." }
    ]
  end
},


# --- actions.parse_config_file.execute — step "2. Customer" (REPLACE) -------
customer_result = call(:parse_customer_sheet, sheets, config["customer"])
if customer_result.nil?
  return {
    "status" => "error",
    "error"  => { "message" => "Neither a `_customer` block nor sheet '#{config.dig('customer', 'sheet_name')}' found",
                  "sheet"   => config.dig("customer", "sheet_name") }
  }
end
customer = customer_result["customer"]
warnings.concat(customer_result["warnings"] || [])


# --- actions.validate_config.execute — ADD before "# CALCULATE AND RETURN" --

# customer_required_attributes
#   Mirrors the `required: true` entries of the library's CUSTOMER_FIELDS. A blank customer
#   block used to pass as "valid": only variant_count_matches noticed, and only as a warn.
required_customer = %w[client_name analyst_email application_title drive_folder_id
                       submission_deadline expected_date]
missing_customer = required_customer.select { |k| customer[k].blank? }
missing_customer << "reminder_days" if (customer["reminder_days"] || []).empty?
checks << {
  "check_name" => "customer_required_attributes",
  "status"     => missing_customer.empty? ? "pass" : "fail",
  "message"    => missing_customer.empty? ? "All required customer attributes present" :
                    "#{missing_customer.size} required customer attribute(s) blank",
  "details"    => missing_customer.map { |k|
    { "entity" => "customer", "name" => k, "issue" => "required attribute is blank on 1_customer" } }
}

# seed_data_config
#   Only meaningful when incumbent data is flagged. Validates the knobs INC-01/INC-02 consume,
#   so a typo'd index key or row number fails here, at config time, not inside the seed integration.
seed_issues = []
if customer["has_incumbent_data"]
  if customer["incumbent_file_id"].blank?
    seed_issues << { "entity" => "customer", "name" => "incumbent_file_id",
                     "issue" => "incumbent data flagged but no Drive file ID" }
  end
  if customer["incumbent_split_field"].blank?
    seed_issues << { "entity" => "customer", "name" => "incumbent_split_field",
                     "issue" => "incumbent data flagged but no index key" }
  elsif !field_names.include?(customer["incumbent_split_field"])
    seed_issues << { "entity" => "customer", "name" => "incumbent_split_field",
                     "issue" => "'#{customer['incumbent_split_field']}' is not a configured field name" }
  end
  hr = customer["seed_header_row"].to_i
  ds = customer["seed_data_start_row"].to_i
  if hr < 1
    seed_issues << { "entity" => "customer", "name" => "seed_header_row", "issue" => "must be >= 1 (got #{hr})" }
  end
  if ds <= hr
    seed_issues << { "entity" => "customer", "name" => "seed_data_start_row",
                     "issue" => "must be after seed_header_row (header #{hr}, data start #{ds})" }
  end
end
checks << {
  "check_name" => "seed_data_config",
  "status"     => seed_issues.empty? ? "pass" : "fail",
  "message"    => seed_issues.empty? ? "Seed data configuration consistent" :
                    "#{seed_issues.size} seed data configuration issue(s)",
  "details"    => seed_issues
}
