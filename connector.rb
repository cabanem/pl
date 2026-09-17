CASCADE_SUFFIX_DELIM = "~".freeze

{
  title:       "Functional core",
  description: "Utility connector for the Supplier Data Collection platform. Handles config parsing, validation, and report generation. " \
               "No external API calls; all logic is pure computation.",
  author:      "",

  # --- CONNECTION -----------------------------------------------------------
  connection: {
    type: "custom_auth",
    authorization: { type: "custom_auth" },
    base_uri: lambda do |_connection|
      ""
    end
  },

  test: lambda do |_connection|
    { success: true }
  end,

  # --- PICK LISTS -----------------------------------------------------------
  pick_lists: {
    data_types: lambda do |_connection|
      [
        %w[Boolean boolean],
        %w[Date date],
        ["Float (2)", "float (2)"],
        %w[Integer integer],
        %w[String string],
        %w[None none]
      ]
    end,

    data_formats: lambda do |_connection|
      [
        %w[Currency currency],
        ["Date (YYYY-MM-DD)", "date (YYYY-MM-DD)"],
        %w[Dropdown dropdown],
        ["Dropdown (dependent)", "dropdown (dependent)"],
        ["Email address", "email address"],
        %w[Percentage percentage]
      ]
    end,

    rule_verbs: lambda do |_connection|
      [
        ["Combined fields must be unique", "Combined fields must be unique"],
        ["Must not match",                 "Must not match"],
        ["Must match",                     "Must match"],
        ["Must be greater than",           "Must be greater than"],
        ["Must be greater than or equal to", "Must be greater than or equal to"],
        ["Must be less than",              "Must be less than"],
        ["Must be less than or equal to",  "Must be less than or equal to"],
        ["Must be empty if",               "Must be empty if"],
        ["Required if",                    "Required if"],
        ["Mutually exclusive",             "Mutually exclusive"],
        ["At least one required",          "At least one required"]
      ]
    end,

    cleaning_flags: lambda do |_connection|
      [
        ["Trim whitespace",       "trim_whitespace"],
        ["Remove control chars",  "remove_control_chars"],
        ["Normalize spaces",      "normalize_spaces"],
        ["Force upper",           "force_upper"],
        ["Force lower",           "force_lower"],
        ["Strip non-numeric",     "strip_non_numeric"]
      ]
    end,

    error_codes: lambda do |_connection|
      [
        %w[err_required            err_required],
        %w[err_must_be_empty       err_must_be_empty],
        %w[err_data_type           err_data_type],
        %w[err_standard_format     err_standard_format],
        %w[err_length_constraint   err_length_constraint],
        %w[err_value_range         err_value_range],
        %w[err_date_constraint     err_date_constraint],
        %w[err_lookup_mismatch     err_lookup_mismatch],
        %w[err_column_unique       err_column_unique],
        %w[err_composite_unique    err_composite_unique],
        %w[err_must_not_match      err_must_not_match],
        %w[err_must_match          err_must_match],
        %w[err_greater_than        err_greater_than],
        %w[err_greater_than_equal  err_greater_than_equal],
        %w[err_less_than           err_less_than],
        %w[err_less_than_equal     err_less_than_equal],
        %w[err_conditional_empty   err_conditional_empty],
        %w[err_conditional_required err_conditional_required],
        %w[err_mutually_exclusive  err_mutually_exclusive],
        %w[err_require_one_of     err_require_one_of]
      ]
    end,

    report_group_by: lambda do |_connection|
      [
        %w[Row row],
        %w[Field field]
      ]
    end
  },

  # --- METHODS --------------------------------------------------------------
  methods: {

    # ── Boolean coercion ──────────────────────
    # Spec: 1/TRUE/true/yes/y (any case) → true; everything else, including blank → false.
    # Mirrors the GAS library's TRUTHY_VALUES. The other sheets emit native booleans
    # (→ "true"); the 1_customer grid fallback is where "Yes" shows up.
    coerce_boolean: lambda do |value|
      return false if value.blank?

      normalized = value.to_s.strip.downcase
      %w[1 true yes y].include?(normalized)
    end,

    # ── Blank row detection ───────────────────
    # Returns true if every value in the hash is blank
    blank_row?: lambda do |row_hash|
      row_hash.values.all? { |v| v.to_s.strip.empty? }
    end,

    # ── Interval notation parser ──────────────
    # Returns a structured hash describing the constraint.
    # Examples:
    #   "exact: 9"    → { type: "exact", value: 9 }
    #   "[5, 10]"     → { type: "range", lower: 5, upper: 10, lower_inc: true, upper_inc: true }
    #   ">=0"         → { type: "gte", value: 0 }
    #   "< TODAY"     → { type: "lt", value: "TODAY" }
    #   ">= 2024-01-01" → { type: "gte", value: "2024-01-01" }
    parse_interval: lambda do |notation|
      return nil if notation.blank?

      s = notation.strip

      # exact: X
      if s.match?(/\Aexact:\s*.+\z/i)
        val = s.sub(/\Aexact:\s*/i, "").strip
        return { "type" => "exact", "value" => val }
      end

      # Range: [X, Y], (X, Y), [X, Y), (X, Y]
      range_match = s.match(/\A([\[\(])\s*(.+?)\s*,\s*(.+?)\s*([\]\)])\z/)
      if range_match
        return {
          "type" => "range",
          "lower" => range_match[2],
          "upper" => range_match[3],
          "lower_inclusive" => range_match[1] == "[",
          "upper_inclusive" => range_match[4] == "]"
        }
      end

      # Inequality: >=X, >X, <=X, <X (with optional space, supports TODAY and dates)
      ineq_match = s.match(/\A(>=|>|<=|<)\s*(.+)\z/)
      if ineq_match
        op = ineq_match[1]
        val = ineq_match[2].strip
        type_map = { ">=" => "gte", ">" => "gt", "<=" => "lte", "<" => "lt" }
        return { "type" => type_map[op], "value" => val }
      end

      # Unparseable
      { "type" => "invalid", "raw" => s }
    end,

    # ── Interval evaluation ───────────────────
    # Takes a parsed interval (from parse_interval) and a numeric/date value.
    # Returns { "pass" => bool, "message" => string }.
    # Caller is responsible for resolving TODAY before calling this.
    evaluate_interval: lambda do |parsed, value|
      return { "pass" => true } if parsed.nil?

      case parsed["type"]
      when "exact"
        target = parsed["value"].to_f
        passed = value.to_f == target
        {
          "pass" => passed,
          "message" => passed ? nil : "Expected exactly #{parsed['value']}, got #{value}"
        }

      when "range"
        v = value.to_f
        lower = parsed["lower"].to_f
        upper = parsed["upper"].to_f
        lower_ok = parsed["lower_inclusive"] ? v >= lower : v > lower
        upper_ok = parsed["upper_inclusive"] ? v <= upper : v < upper
        passed = lower_ok && upper_ok
        {
          "pass" => passed,
          "message" => passed ? nil : "#{value} outside #{parsed['lower_inclusive'] ? '[' : '('}#{parsed['lower']}, #{parsed['upper']}#{parsed['upper_inclusive'] ? ']' : ')'}"
        }

      when "gt"
        passed = value.to_f > parsed["value"].to_f
        { "pass" => passed, "message" => passed ? nil : "#{value} must be > #{parsed['value']}" }
      when "gte"
        passed = value.to_f >= parsed["value"].to_f
        { "pass" => passed, "message" => passed ? nil : "#{value} must be >= #{parsed['value']}" }
      when "lt"
        passed = value.to_f < parsed["value"].to_f
        { "pass" => passed, "message" => passed ? nil : "#{value} must be < #{parsed['value']}" }
      when "lte"
        passed = value.to_f <= parsed["value"].to_f
        { "pass" => passed, "message" => passed ? nil : "#{value} must be <= #{parsed['value']}" }

      when "invalid"
        { "pass" => false, "message" => "Invalid interval notation: #{parsed['raw']}" }

      else
        { "pass" => false, "message" => "Unknown interval type: #{parsed['type']}" }
      end
    end,

    # ── Date interval evaluation ──────────────
    # Like evaluate_interval but operates on date strings (YYYY-MM-DD).
    # Resolves "TODAY" to the current date at call time.
    # Lexicographic comparison works because YYYY-MM-DD sorts correctly.
    evaluate_date_interval: lambda do |parsed, date_value|
      return { "pass" => true } if parsed.nil?
      return { "pass" => false, "message" => "Invalid interval notation: #{parsed['raw']}" } if parsed["type"] == "invalid"

      today_str = Time.now.utc.strftime("%Y-%m-%d")
      resolve = lambda { |v| v.to_s.strip.upcase == "TODAY" ? today_str : v.to_s.strip }

      val = date_value.to_s.strip

      case parsed["type"]
      when "exact"
        target = resolve.call(parsed["value"])
        passed = val == target
        { "pass" => passed, "message" => passed ? nil : "Expected exactly #{target}, got #{val}" }

      when "range"
        lower = resolve.call(parsed["lower"])
        upper = resolve.call(parsed["upper"])
        lower_ok = parsed["lower_inclusive"] ? val >= lower : val > lower
        upper_ok = parsed["upper_inclusive"] ? val <= upper : val < upper
        passed = lower_ok && upper_ok
        {
          "pass" => passed,
          "message" => passed ? nil : "#{val} outside #{parsed['lower_inclusive'] ? '[' : '('}#{lower}, #{upper}#{parsed['upper_inclusive'] ? ']' : ')'}"
        }

      when "gt"
        target = resolve.call(parsed["value"])
        passed = val > target
        { "pass" => passed, "message" => passed ? nil : "#{val} must be after #{target}" }
      when "gte"
        target = resolve.call(parsed["value"])
        passed = val >= target
        { "pass" => passed, "message" => passed ? nil : "#{val} must be on or after #{target}" }
      when "lt"
        target = resolve.call(parsed["value"])
        passed = val < target
        { "pass" => passed, "message" => passed ? nil : "#{val} must be before #{target}" }
      when "lte"
        target = resolve.call(parsed["value"])
        passed = val <= target
        { "pass" => passed, "message" => passed ? nil : "#{val} must be on or before #{target}" }

      else
        { "pass" => false, "message" => "Unknown interval type: #{parsed['type']}" }
      end
    end,

    # ── Error message resolution ──────────────
    # Priority: custom > default > error_translation lookup.
    # Substitutes placeholders: {field_name}, {provided_value},
    # {expected_value}, {condition_field}, {expected_interval}.
    resolve_error_message: lambda do |rule, error_translations, context|
      template = if rule["error_message_custom"].present?
                   rule["error_message_custom"]
                 elsif rule["error_message"].present?
                   rule["error_message"]
                 else
                   translation = (error_translations || []).find do |t|
                     t["error_code"] == context["error_code"]
                   end
                   translation ? translation["human_readable_message"] : "Validation failed"
                 end

      # Substitute placeholders
      (context || {}).each do |key, val|
        template = template.gsub("{#{key}}", val.to_s)
      end

      template
    end,

    # ── Data type check ───────────────────────
    # Returns true if value is coercible to the declared data_type.
    check_data_type: lambda do |value, data_type|
      return true if value.blank?  # blank handling is the required check's job
      return true if %w[string none].include?(data_type)

      case data_type
      when "integer"
        value.to_s.strip.match?(/\A-?\d+\z/)
      when "float (2)"
        value.to_s.strip.match?(/\A-?\d+(\.\d{1,2})?\z/)
      when "boolean"
        %w[0 1 true false].include?(value.to_s.strip.downcase)
      when "date"
        # Accept YYYY-MM-DD
        value.to_s.strip.match?(/\A\d{4}-\d{2}-\d{2}\z/)
      else
        true  # unknown type — don't block, let validate_config catch it
      end
    end,

    # ── Data format check ─────────────────────
    check_data_format: lambda do |value, data_format|
      return true if value.blank? || data_format.blank?

      case data_format
      when "email address"
        value.to_s.strip.match?(/\A[^@\s]+@[^@\s]+\.[^@\s]+\z/)
      when "date (YYYY-MM-DD)"
        value.to_s.strip.match?(/\A\d{4}-\d{2}-\d{2}\z/)
      when "currency"
        value.to_s.strip.match?(/\A-?\d+(\.\d{1,2})?\z/)
      when "percentage"
        value.to_s.strip.match?(/\A-?\d+(\.\d+)?\z/)
      else
        true  # dropdown, dropdown (dependent) checked via lookup membership
      end
    end,

    # ── Cleaning flag application ─────────────
    apply_cleaning_flag: lambda do |value, flag|
      return value if value.blank?

      case flag
      when "trim_whitespace"
        value.to_s.strip
      when "remove_control_chars"
        value.to_s.gsub(/[\n\r\t\u200B]/, "")
      when "normalize_spaces"
        value.to_s.gsub(/\s{2,}/, " ")
      when "force_upper"
        value.to_s.upcase
      when "force_lower"
        value.to_s.downcase
      when "strip_non_numeric"
        value.to_s.gsub(/[^\d]/, "")
      else
        value
      end
    end,

    # ── Default sheet_config ──────────────────
    default_sheet_config: lambda do
      {
        "fields"            => { "sheet_name" => "4_fields",               "header_row" => 7,  "data_start_row" => 8 },
        "validations"       => { "sheet_name" => "4_complex_validations",  "header_row" => 9,  "data_start_row" => 11 },
        "lookups"           => { "sheet_name" => "5_lookups",              "header_row" => 4,  "data_start_row" => 5 },
        "variants"          => { "sheet_name" => "6_variants",             "header_row" => 4,  "data_start_row" => 5, "variant_columns_start" => 7 },
        "suppliers"         => { "sheet_name" => "2_suppliers",            "header_row" => 7,  "data_start_row" => 8 },
        "users"             => { "sheet_name" => "3_users",                "header_row" => 7,  "data_start_row" => 8 },
        "customer"          => { "sheet_name" => "1_customer",             "label_col" => 2,    "value_col" => 3 },
        "error_translation" => { "sheet_name" => "_error_translation",     "header_row" => 0,  "data_start_row" => 1 }
      }
    end,

    # ── Sheet data extraction ─────────────────
    # Given the full sheets hash and a sheet_config entry, returns an
    # array of hashes (one per data row) keyed by header names.
    # Skips blank rows. Returns { "rows" => [...], "headers" => [...], "skipped" => int }.
    extract_sheet_rows: lambda do |sheets, cfg|
      sheet_name = cfg["sheet_name"]
      raw = sheets[sheet_name]
      return { "rows" => [], "headers" => [], "skipped" => 0, "error" => "Sheet '#{sheet_name}' not found" } if raw.blank?

      header_idx = cfg["header_row"].to_i   # 0-indexed row in the 2D array
      data_start = cfg["data_start_row"].to_i

      headers = (raw[header_idx] || []).map { |h| h.to_s.strip }
      rows = []
      skipped = 0

      (data_start..(raw.size - 1)).each do |i|
        raw_row = raw[i] || []
        # Build hash from headers
        row_hash = {}
        headers.each_with_index do |h, ci|
          row_hash[h] = raw_row[ci]
        end

        if call(:blank_row?, row_hash)
          skipped += 1
          next
        end

        # Trim all string values
        row_hash.each { |k, v| row_hash[k] = v.to_s.strip if v.is_a?(String) }
        rows << row_hash
      end

      { "rows" => rows, "headers" => headers, "skipped" => skipped }
    end,

    # ── Customer sheet parser ─────────────────
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

    # ── Fields sheet parser ───────────────────
    # Column mapping from header text → output key.
    # Adjust header strings to match your actual spreadsheet headers.
    fields_column_map: lambda do
      {
        "Field name"                => "field_name",
        "Data type"                 => "data_type",
        "Data format"               => "data_format",
        "Description"               => "description",
        "Required"                  => "required",
        "Read-only"                 => "read_only",
        "Hidden"                    => "supplier_hidden",
        "Unique"                    => "column_unique",
        "Lookup name"               => "lookup_name",
        "Depends on"                => "depends_on_lookup_name",
        "Field length validation"   => "field_length_validation",
        "Numeric field validation"  => "numeric_field_validation",
        "Date field validation"     => "date_field_validation",
        "Field input validation"    => "field_input_validation",
        "Data cleaning flags"       => "data_cleaning_flags",
        "Strict?"                   => "strict"
      }
    end,

    parse_fields_sheet: lambda do |sheets, cfg|
      extracted = call(:extract_sheet_rows, sheets, cfg)
      return { "rows" => [], "skipped" => 0, "error" => extracted["error"] } if extracted["error"].present?

      col_map = call(:fields_column_map)
      known_data_types = %w[boolean date float\ (2) integer string none]
      boolean_keys = %w[required read_only supplier_hidden column_unique strict]

      # Declared before the drift net below pushes onto `warnings`. Adding/renaming
      # a 4_fields column is exactly when a mismatch can occur, so the net comes first.
      rows = []
      warnings = call(:header_drift_warnings, cfg["sheet_name"], extracted["headers"], col_map)

      extracted["rows"].each_with_index do |raw, idx|
        field = { "_index" => idx }
        col_map.each do |header, key|
          field[key] = raw[header]
        end

        # Boolean coercion
        boolean_keys.each { |k| field[k] = call(:coerce_boolean, field[k]) }

        # Nullify blanks for optional string fields
        %w[data_format description lookup_name depends_on_lookup_name
           field_length_validation numeric_field_validation date_field_validation
           field_input_validation data_cleaning_flags].each do |k|
          field[k] = nil if field[k].to_s.strip.empty?
        end

        # Validate data_type
        unless known_data_types.include?(field["data_type"].to_s.downcase)
          warnings << { "sheet" => "4_fields", "row" => idx, "issue" => "Unknown data_type: #{field['data_type']}" }
        end
        field["data_type"] = field["data_type"].to_s.downcase

        rows << field
      end

      { "rows" => rows, "skipped" => extracted["skipped"], "warnings" => warnings }
    end,

    # ── Header drift net ──────────────────────
    # Shared by every tabular parser: warns on mapped columns missing from the sheet
    # (values read as nil) and on sheet columns no map consumes (values discarded).
    # parse_rules_sheet had no net before v0.9.9, which is why its renames were invisible.
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

    # ── Validations (rules) sheet parser ──────
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

    parse_rules_sheet: lambda do |sheets, cfg, error_translations|
      extracted = call(:extract_sheet_rows, sheets, cfg)
      return { "rows" => [], "skipped" => 0, "error" => extracted["error"] } if extracted["error"].present?

      col_map = call(:rules_column_map)
      known_verbs = [
        "Combined fields must be unique", "Must not match", "Must match",
        "Must be greater than", "Must be greater than or equal to",
        "Must be less than", "Must be less than or equal to",
        "Must be empty if", "Required if", "Mutually exclusive",
        "At least one required"
      ]
      rows = []
      warnings = []
      warnings.concat(call(:header_drift_warnings, cfg["sheet_name"], extracted["headers"], col_map))

      extracted["rows"].each_with_index do |raw, idx|
        rule = {}
        col_map.each { |header, key| rule[key] = raw[header] }

        rule["strict_enforcement"] = call(:coerce_boolean, rule["strict_enforcement"])

        # Nullify blanks
        %w[conditional_value error_message_custom].each do |k|
          rule[k] = nil if rule[k].to_s.strip.empty?
        end

        # Auto-generate error_message from error_translations if blank
        if rule["error_message"].to_s.strip.empty? && error_translations.present?
          translation = error_translations.find { |t| t["error_code"] == rule["rule"] }
          rule["error_message"] = translation ? translation["human_readable_message"] : nil
        end

        unless known_verbs.include?(rule["rule"])
          warnings << { "sheet" => "4_complex_validations", "row" => idx, "issue" => "Unknown rule verb: #{rule['rule']}" }
        end

        rows << rule
      end

      { "rows" => rows, "skipped" => extracted["skipped"], "warnings" => warnings }
    end,

    # ── Lookups sheet parser ──────────────────
    parse_lookups_sheet: lambda do |sheets, cfg|
      extracted = call(:extract_sheet_rows, sheets, cfg)
      return { "rows" => [], "skipped" => 0, "error" => extracted["error"] } if extracted["error"].present?

      # Type-safe cell readers. Plain `.to_s` silently coerces non-strings
      # (TrueClass, Numeric, Date) into their stringified form — a boolean
      # `true` cell becomes the literal string "true", indistinguishable
      # from real text content downstream. Restricting to `is_a?(String)`
      # turns type mismatches into nil/"" so V-00 catches them via its
      # required-field rules instead of producing broken canonical models.
      required_string = ->(v) { v.is_a?(String) ? v.strip : "" }
      optional_string = ->(v) { v.is_a?(String) ? v.strip.presence : nil }

      rows = []
      skipped_inactive = 0
      extracted["rows"].each do |raw|
        unless call(:coerce_boolean, raw["Record active?"])
          skipped_inactive += 1
          next
        end
        rows << {
          "lookup_name"      => required_string.call(raw["Table name"]),
          "valid_value"      => required_string.call(raw["Value"]),
          "display_label"    => optional_string.call(raw["Label"]),
          "parent_value"     => optional_string.call(raw["Parent value"]),
          "project_specific" => call(:coerce_boolean, raw["Project specific?"])
        }
      end
      { "rows" => rows, "skipped" => extracted["skipped"] + skipped_inactive }
    end,

    # ── Variants sheet parser ─────────────────
    parse_variants_sheet: lambda do |sheets, cfg, parsed_fields|
      sheet_name = cfg["sheet_name"]
      raw = sheets[sheet_name]
      
      # Missing sheet is a different case from missing-variant-columns.
      # If the sheet doesn't exist at all, treat as zero variants (not an error).
      # Synthesis below will handle producing a base variant.
      if raw.blank?
        return call(:synthesize_base_variant, parsed_fields, sheet_name, "Sheet not found")
      end
      
      header_idx = cfg["header_row"].to_i
      data_start = cfg["data_start_row"].to_i
      var_col_start = (cfg["variant_columns_start"] || 7).to_i
    
      headers = raw[header_idx] || []
    
      # Discover variant names from columns var_col_start onward
      variant_names = []
      (var_col_start..(headers.size - 1)).each do |ci|
        vname = headers[ci].to_s.strip
        variant_names << { "col" => ci, "name" => vname } if vname.present?
      end
    
      # No variant columns defined → synthesize base variant from parsed fields
      if variant_names.empty?
        return call(:synthesize_base_variant, parsed_fields, sheet_name, 
                    "No variants defined in config")
      end
    
      # ── Existing per-variant parsing logic below, unchanged ──
      variant_fields = {}
      variant_names.each { |v| variant_fields[v["name"]] = [] }
      warnings = []
    
      (data_start..(raw.size - 1)).each_with_index do |row_idx, position|
        row = raw[row_idx] || []
        field_name = row[1].to_s.strip
    
        if field_name.include?("Err:512") || field_name.empty?
          resolved = (parsed_fields || []).find { |f| f["_index"] == position }
          if resolved
            field_name = resolved["field_name"]
          else
            warnings << { "sheet" => sheet_name, "row" => row_idx, 
                          "issue" => "Unresolvable field name (Err:512) at position #{position}" }
            next
          end
        end
    
        variant_names.each do |v|
          flag = row[v["col"]]
          variant_fields[v["name"]] << field_name if call(:coerce_boolean, flag)
        end
      end
    
      rows = variant_names.map do |v|
        { 
          "variant_name" => v["name"], 
          "visible_field_names" => variant_fields[v["name"]],
          "is_synthesized" => false
        }
      end
    
      { "rows" => rows, "skipped" => 0, "warnings" => warnings, "synthesized" => false }
    end,

    # ── Base variant synthesis ────────────────
    # Emits a single synthetic "base" variant containing every parsed field.
    # Triggered when the analyst has defined fields but no variants ensures provisioning always produces at least one deliverable template.
    synthesize_base_variant: lambda do |parsed_fields, sheet_name, reason|
      field_names = (parsed_fields || []).map { |f| f["field_name"].to_s }.reject(&:empty?)
      
      # No fields → no base variant worth synthesizing.
      # validate_config will produce a clearer error for "no fields defined".
      if field_names.empty?
        return { "rows" => [], "skipped" => 0, "synthesized" => false,
                 "warnings" => [ { "sheet" => sheet_name, 
                   "issue" => "No variants defined and no fields available; synthesis skipped." } ] }
      end
      
      base_variant = {
        "variant_name"        => "base",
        "visible_field_names" => field_names,
        "is_synthesized"      => true
      }
      
      warning = {
        "sheet" => sheet_name,
        "issue" => "No variants defined; synthesized base variant with #{field_names.size} field(s). Reason: #{reason}."
      }
      
      { "rows" => [base_variant], "skipped" => 0, "warnings" => [warning], "synthesized" => true }
    end,

    # ── Suppliers sheet parser ────────────────
    # "Has incumbent data?" was retired at schema 1.3: per-supplier seeding is derived
    # downstream by INC-01's reconcile, so has_seeded_data is no longer emitted here.
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

    # ── Users sheet parser ────────────────────
    # "Primary contact" was dropped from 3_users in the v0.9.9 template. primary is now
    # DERIVED: the first user listed per supplier. Extra users are warned about so the
    # analyst knows who owns the request task.
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
      end.reject { |u| u["user_email"].empty? && u["supplier_name"].empty? } # guard against phantom data in the users sheet

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

    # ── Error translation sheet parser ────────
    parse_error_translations_sheet: lambda do |sheets, cfg|
      extracted = call(:extract_sheet_rows, sheets, cfg)
      return { "rows" => [], "skipped" => 0, "error" => extracted["error"] } if extracted["error"].present?

      rows = extracted["rows"].map do |raw|
        {
          "error_code"             => raw["failure_name"].to_s.strip,
          "human_readable_message" => raw["error_message"].to_s.strip,
          "required_placeholders"  => raw["required_placeholders"].to_s.strip
        }
      end

      { "rows" => rows, "skipped" => extracted["skipped"] }
    end,

    # ── Field visibility merger ───────────────
    # Stamps a "visible" boolean onto each parsed field row using the
    # _field_visibility map produced by GAS.  Falls back to true when
    # the map is absent (backward compat with older GAS versions).
    merge_field_visibility: lambda do |fields, visibility_map|
      return fields if fields.blank?

      fields.each do |f|
        if visibility_map.present? && visibility_map.key?(f["field_name"])
          # GAS writes native booleans; handle string "true"/"false" too
          f["visible"] = visibility_map[f["field_name"]] == true ||
                         visibility_map[f["field_name"]].to_s.strip.downcase == "true"
        else
          # No visibility data → default visible (backward compat)
          f["visible"] = true
        end
      end

      fields
    end,
  
  
    # ── File storage path resolution ──────────
    sanitize_slug: lambda do |name|
      return "" if name.blank?
      name.to_s.strip.downcase
        .gsub(/[^a-z0-9]+/, '-')
        .gsub(/\A-|-\z/, '')
    end
  },

  # --- OBJECT DEFINITIONS ---------------------------------------------------
  object_definitions: {

    # ── Shared sub-schemas ────────────────────
    field_definition: {
      fields: lambda do |_connection, _config|
        [
          { name: "_index",                    type: "integer", label: "Position index" },
          { name: "field_name",                type: "string" },
          { name: "data_type",                 control_type: "select", pick_list: "data_types", 
            toggle_hint: "Select from the list",
            toggle_field: {
              name: "data_type", label: "Data type", type: "string", control_type: "text",
              toggle_hint: "Use custom value" } },
          { name: "data_format", control_type: "select", pick_list: "data_formats", 
            toggle_hint: "Select from the list",
            toggle_field: {
              name: "data_format", control_type: "text", type: "string", 
              toggle_hint: "Use custom value" }},
          { name: "description",               type: "string",  optional: true },
          { name: "required",                  type: "boolean" },
          { name: "must_be_empty",             type: "boolean" },
          { name: "column_unique",             type: "boolean" },
          { name: "read_only",                 type: "boolean" },
          { name: "supplier_hidden",           type: "boolean",                 
            hint: "Field is hidden from suppliers, independent of 7_form visibility and of variant inclusion; " \
                  "read directly from the 4_fields 'Hidden' column." },
          { name: "lookup_name",               type: "string",  optional: true },
          { name: "depends_on_lookup_name",    type: "string",  optional: true },
          { name: "field_length_validation",   type: "string",  optional: true },
          { name: "numeric_field_validation",  type: "string",  optional: true },
          { name: "date_field_validation",     type: "string",  optional: true },
          { name: "field_input_validation",    type: "string",  optional: true },
          { name: "data_cleaning_flags",       type: "string",  optional: true },
          { name: "strict",                    type: "boolean" },
          { name: "visible",                   type: "boolean", optional: true,
            hint: "Whether the field is shown on the manual-input form. " \
                  "Derived from the 7_form tab. Defaults to true if " \
                  "visibility data is not present in the config JSON." }
        ]
      end
    },
     
    rule_definition: {
      fields: lambda do |_connection, _config|
        [
          { name: "target_field_name",    type: "string" },
          { name: "rule",                 type: "string", control_type: "select",
            pick_list: "rule_verbs", toggle_hint: "Select from the list", control_type: "select",
            toggle_field: {
              name: "rule", label: "Rule or action", type: "string", control_type: "text",
              toggle_hint: "Use custom value" } },
          { name: "condition_field_name", type: "string" },
          { name: "conditional_value",    type: "string",  optional: true },
          { name: "error_message",        type: "string" },
          { name: "error_message_custom", type: "string",  optional: true },
          { name: "strict_enforcement", type: "boolean" },
          { name: "scope", type: "string", optional: true,
            hint: "submission (default), supplier, or engagement. " \
                  "Supplier/engagement-scope rules evaluate against prior_values." }
        ]
      end
    },

    lookup_definition: {
      fields: lambda do |_connection, _config|
        [
          { name: "lookup_name",       type: "string" },
          { name: "valid_value",       type: "string" },
          { name: "display_label",     type: "string",  optional: true },
          { name: "parent_value",      type: "string",  optional: true },
          { name: "project_specific",  type: "boolean" }
        ]
      end
    },

    variant_definition: {
      fields: lambda do |_connection, _config|
        [
          { name: "variant_name",        type: "string" },
          { name: "visible_field_names", type: "array", of: "string" },
          { name: "is_synthesized",      type: "boolean", optional: true, hint: "True when the base variant was synthesized because no variants were defined in the config." }
        ]
      end
    },

    supplier_definition: {
      fields: lambda do |_connection, _config|
        [
          { name: "supplier_name", type: "string" },
          { name: "variant_name",  type: "string", optional: true }
        ]
      end
    },

    user_definition: {
      fields: lambda do |_connection, _config|
        [
          { name: "user_email",     type: "string" },
          { name: "supplier_name",  type: "string" },
          { name: "contact_name",   type: "string", optional: true },
          { name: "primary",        type: "boolean" }
        ]
      end
    },

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

    error_translation_definition: {
      fields: lambda do |_connection, _config|
        [
          { name: "error_code",             type: "string" },
          { name: "human_readable_message", type: "string" },
          { name: "required_placeholders",  type: "string" }
        ]
      end
    },

    # ── Shared: parse summary ─────────────────
    parse_summary: {
      fields: lambda do |_connection, _config|
        [
          { name: "field_count",             type: "integer" },
          { name: "visible_field_count",     type: "integer",
            hint: "Number of fields marked visible on the manual-input form " \
                  "(from 7_form). Equals field_count when visibility data is absent." },
          { name: "rule_count",              type: "integer" },
          { name: "lookup_count",            type: "integer" },
          { name: "variant_count",           type: "integer" },
          { name: "supplier_count",          type: "integer" },
          { name: "user_count",              type: "integer" },
          { name: "error_translation_count", type: "integer" },
          { name: "skipped_rows", type: "object", properties: [
            { name: "fields",    type: "integer" },
            { name: "lookups",   type: "integer" },
            { name: "suppliers", type: "integer" },
            { name: "users",     type: "integer" }
          ] },
          { name: "variant_synthesized",   type: "boolean", optional: true, hint: "True when variants output was synthesized rather than parsed." },
          { name: "warnings",              type: "array",   optional: true, of: "object",properties: [
            { name: "sheet", type: "string", optional: true },
            { name: "row", type: "integer", optional: true },
            { name: "issue", type: "string" }
          ]}
        ]
      end
    },

    # ── Shared: validation error detail ───────
    validation_error: {
      fields: lambda do |_connection, _config|
        [
          { name: "row_number",       type: "integer" },
          { name: "field_id",         type: "string" },
          { name: "field_name",       type: "string" },
          { name: "submitted_value",  type: "string",  optional: true },
          { name: "error_code",       type: "string" },
          { name: "error_message",    type: "string" },
          { name: "strict",           type: "boolean" },
          { name: "source",           type: "string" }  # single_field | cross_field
        ]
      end
    },

    # ── Shared: validation check (Action 2) ───
    validation_check: {
      fields: lambda do |_connection, _config|
        [
          { name: "check_name", type: "string" },
          { name: "status",     type: "string" },  # pass | fail | warn
          { name: "message",    type: "string" },
          { name: "details",    type: "array", of: "object", properties: [
            { name: "entity", type: "string" },
            { name: "name",   type: "string" },
            { name: "issue",  type: "string" }
          ] }
        ]
      end
    },

    # ── Sheet config override ─────────────────
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
    }
  },

  # --- ACTIONS --------------------------------------------------------------
  actions: {

    # ── Parse config file ─────────────────────────────────────
    parse_config_file: {
      title: "Parse config file",
      subtitle: "Parse and extract structured data from master config spreadsheet",
      help: lambda do |input, picklist_label|
        {
          body: "Called after GAS exports the config spreadsheet as JSON. Takes JSON sheet data (exported by GAS) and returns normalized JSON: customer settings, fields, rules, lookups, variants, suppliers, users, and error translations."
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: "sheet_data", type: "string", control_type: "text-area", label: "Sheet data (JSON)", 
            hint: "JSON object keyed by sheet name. Each value is a 2D array (array of row arrays) representing the raw cell grid. " \
                  "May also contain a '_field_visibility' key with a {field_name: boolean} map derived from the 7_form tab, " \
                  "and (library >= 1.7.0) a '_customer' key with the typed 1_customer values read via named ranges. " \
                  "Exported by GAS from the master config spreadsheet." },
          { name: "sheet_config", type: "object", optional: true, label: "Sheet config overrides",
            hint: "Override default header_row / data_start_row per sheet. Omit to use defaults.",
            properties: [
              { name: "fields",            type: "object", properties: object_definitions["sheet_config_entry"] },
              { name: "validations",       type: "object", properties: object_definitions["sheet_config_entry"] },
              { name: "lookups",           type: "object", properties: object_definitions["sheet_config_entry"] },
              { name: "variants",          type: "object", properties: object_definitions["sheet_config_entry"] },
              { name: "suppliers",         type: "object", properties: object_definitions["sheet_config_entry"] },
              { name: "users",             type: "object", properties: object_definitions["sheet_config_entry"] },
              { name: "customer",          type: "object", properties: object_definitions["sheet_config_entry"] },
              { name: "error_translation", type: "object", properties: object_definitions["sheet_config_entry"] }
            ] }
        ]
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: "status",             type: "string" },
          { name: "error",              type: "object", optional: true, properties: [ { name: "message", type: "string" },
            { name: "sheet",   type: "string", optional: true },
            { name: "row",     type: "integer", optional: true },
            { name: "field",   type: "string",  optional: true } ] },
          { name: "parsed_config_json", type: "string", optional: true, hint: "Serialized JSON of the parsed configuration. Suitable for FileStorage persistence or evaluation with Python. Deliberately absent on error returns." },
          { name: "customer",           type: "object",              properties: object_definitions["customer_definition"] },
          { name: "fields",             type: "array", of: "object", properties: object_definitions["field_definition"] },
          { name: "rules",              type: "array", of: "object", properties: object_definitions["rule_definition"] },
          { name: "lookups",            type: "array", of: "object", properties: object_definitions["lookup_definition"] },
          { name: "variants",           type: "array", of: "object", properties: object_definitions["variant_definition"] },
          { name: "suppliers",          type: "array", of: "object", properties: object_definitions["supplier_definition"] },
          { name: "users",              type: "array", of: "object", properties: object_definitions["user_definition"] },
          { name: "error_translations", type: "array", of: "object", properties: object_definitions["error_translation_definition"] },
          { name: "parse_summary",      type: "object",              properties: object_definitions["parse_summary"] }
        ]
      end,

      execute: lambda do |_connection, input, _eis, _eos, _continue|
        # Merge sheet_config with defaults
        config = call(:default_sheet_config)
        if input["sheet_config"].present?
          input["sheet_config"].each do |key, overrides|
            config[key] = (config[key] || {}).merge(overrides) if overrides.present?
          end
        end

        sheets = input["sheet_data"].is_a?(String) ? JSON.parse(input["sheet_data"]) : input["sheet_data"]
        
        if sheets.blank?
          return {
            "status" => "error",
            "error"  => { "message" => "sheet_data is empty or missing" }
          }
        end

        # Extract the derived visibility map (may be absent in older exports)
        visibility_map = sheets["_field_visibility"]

        warnings = []

        # ── 1. Error translations (parse first — rules may need them) ──
        et_result = call(:parse_error_translations_sheet, sheets, config["error_translation"])
        if et_result["error"].present?
          warnings << { "sheet" => config.dig("error_translation", "sheet_name"), "issue" => et_result["error"] }
        end
        error_translations = et_result["rows"]

        # ── 2. Customer ──
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

        # ── 3. Fields ──
        fields_result = call(:parse_fields_sheet, sheets, config["fields"])
        if fields_result["error"].present?
          return {
            "status" => "error",
            "error"  => { "message" => fields_result["error"], "sheet" => config.dig("fields", "sheet_name") }
          }
        end
        fields = fields_result["rows"]
        warnings.concat(fields_result["warnings"] || [])

        # ── 3b. Merge field visibility from 7_form ──
        call(:merge_field_visibility, fields, visibility_map)

        # ── 4. Rules ──
        rules_result = call(:parse_rules_sheet, sheets, config["validations"], error_translations)
        if rules_result["error"].present?
          warnings << { "sheet" => config.dig("validations", "sheet_name"), "issue" => rules_result["error"] }
        end
        rules = rules_result["rows"]
        warnings.concat(rules_result["warnings"] || [])

        # ── 5. Lookups ──
        lookups_result = call(:parse_lookups_sheet, sheets, config["lookups"])
        if lookups_result["error"].present?
          warnings << { "sheet" => config.dig("lookups", "sheet_name"), "issue" => lookups_result["error"] }
        end
        lookups = lookups_result["rows"]

        # ── 6. Variants (needs parsed fields for Err:512 resolution) ──
        variants_result = call(:parse_variants_sheet, sheets, config["variants"], fields)
        if variants_result["error"].present?
          warnings << { "sheet" => config.dig("variants", "sheet_name"), "issue" => variants_result["error"] }
        end
        variants = variants_result["rows"]
        warnings.concat(variants_result["warnings"] || [])

        # ── 7. Suppliers ──
        suppliers_result = call(:parse_suppliers_sheet, sheets, config["suppliers"])
        if suppliers_result["error"].present?
          warnings << { "sheet" => config.dig("suppliers", "sheet_name"), "issue" => suppliers_result["error"] }
        end
        suppliers = suppliers_result["rows"]
        warnings.concat(suppliers_result["warnings"] || [])

        # ── 8. Users ──
        users_result = call(:parse_users_sheet, sheets, config["users"])
        if users_result["error"].present?
          warnings << { "sheet" => config.dig("users", "sheet_name"), "issue" => users_result["error"] }
        end
        warnings.concat(users_result["warnings"] || [])
        users = users_result["rows"]

        # ── Build output ──
        result = {
          "status" => "success",

          "customer"              => customer,
          "fields"                => fields,
          "rules"                 => rules,
          "lookups"               => lookups,
          "variants"              => variants,
          "suppliers"             => suppliers,
          "users"                 => users,
          "error_translations"    => error_translations,

          "parse_summary" => {
            "field_count"             => fields.size,
            "visible_field_count"     => fields.count { |f| f["visible"] },
            "rule_count"              => rules.size,
            "lookup_count"            => lookups.size,
            "variant_count"           => variants.size,
            "supplier_count"          => suppliers.size,
            "user_count"              => users.size,
            "error_translation_count" => error_translations.size,
            "variant_synthesized"    => variants_result["synthesized"] == true, 
            "skipped_rows" => {
              "fields"    => fields_result["skipped"].to_i,
              "lookups"   => lookups_result["skipped"].to_i,
              "suppliers" => suppliers_result["skipped"].to_i,
              "users"     => users_result["skipped"].to_i
            },
            "warnings" => warnings
          }
        }
        
        # Serialized form for downstream FileStorage consumption
        result["parsed_config_json"] = {
          "customer"            => customer,
          "fields"              => fields,
          "rules"               => rules,
          "lookups"             => lookups,
          "variants"            => variants,
          "suppliers"           => suppliers,
          "users"               => users,
          "error_translations"  => error_translations
        }.to_json
        
        result
      end
    },


    # ── Validate configuration ────────────────────────────────
    validate_config: {
      title: "Validate config",
      subtitle: "Perform referential integrity and constraint checks on parsed config",
      help: lambda do
        {
          body: "Called after parsing, before writing to Data Tables. \n" \
          "Takes the parsed config from Action 1 and runs cross-entity validation: FK references, uniqueness, syntax checks. Returns a structured pass/fail report."
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


        # --- REFERENTIAL INTEGRITY CHECKS
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
        #   A lookup consumed by multiple fields AND used as a cascade source is unresolvable: 
        #   we cannot tell which consuming field gates the dependent. Mirrors CAN-01 self-check 3c,
        #   so the contradiction surfaces at preflight with a structured message instead of a model-build failure.
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

        # (exactly_one_primary_user_per_supplier retired: primary is derived in parse_users_sheet,
        #  first user listed per supplier, so the invariant now holds by construction.)

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

        # --- CONSTRAINT CHECKS
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


        # --- SYNTAX CHECKS
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


        # --- CUSTOMER CHECKS
        # customer_required_attributes
        #   Mirrors the `required: true` entries of the library's CUSTOMER_FIELDS (the starred rows
        #   on 1_customer). A blank customer block used to pass as "valid": only variant_count_matches
        #   noticed, and only as a warn.
        required_customer = %w[client_name analyst_email application_title target_vms drive_folder_id
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


        # CALCULATE AND RETURN
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
    

    # ── Validate supplier upload ──────────────────────────────
    validate_upload: {
      title: "Validate upload",
      subtitle: "Validate supplier upload data against frozen config",
      help: lambda do
        { 
          body: "Called after extracting uploaded file content. Core validation engine. Takes frozen field/rule/lookup config and parsed upload rows. Returns one of three verdicts: 'passed' (no strict errors), 'failed' (one or more strict errors), or 'empty' (zero rows submitted — hard-fail with a summary error)."
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: "canonical_model_json", type: "string", control_type: "text-area", label: "Canonical model JSON",
            hint: "Resolved configuration JSON content. Contains cfg_fields, cfg_rules, cfg_lookups, cfg_error_translations " \
                  "with FK resolution applied. Read from FileStorage by the caller." },
          { name: "upload_data_json", type: "string", control_type: "text-area", label: "Upload rows (JSON)",
            hint: "JSON-serialized array of {field_name: value} row objects. Recipes produce this from a Python step that calls json.dumps on the extracted rows array." },
          { name: "variant_field_ids", type: "array", of: "string", optional: true,
            hint: "If set, only these field_ids are validated." },
          { name: "prior_values", type: "object", optional: true,
            label: "Prior values (for supplier/engagement scope rules)",
            hint: "Object keyed by field_id. Each value is an array of " \
                  "{value, row_number, submission_id} from prior validated " \
                  "submissions. Required when canonical model contains rules " \
                  "with scope=supplier or scope=engagement." },
          { name: "options", type: "object", optional: true, properties: [
            { name: "max_errors_per_row",       type: "integer", optional: true },
            { name: "max_total_errors",         type: "integer", optional: true },
            { name: "stop_on_first_row_failure", type: "boolean", optional: true },
            { name: "apply_cleaning",           type: "boolean", optional: true }
          ] }
        ]
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: "status",  type: "string" },  # passed | failed | empty
          { name: "summary", type: "object", properties: [
            { name: "total_rows",       type: "integer" },
            { name: "valid_rows",       type: "integer" },
            { name: "invalid_rows",     type: "integer" },
            { name: "total_errors",     type: "integer" },
            { name: "truncated",        type: "boolean" },
            { name: "cleaning_applied", type: "boolean" }
          ] },
          { name: "errors",         type: "array", of: "object", properties: object_definitions["validation_error"] },
          { name: "valid_payload",  type: "array", of: "object", hint: "Rows that passed all strict validations." },
          { name: "validation_result_json", type: "string",
            hint: "status + summary + errors, serialized (no valid_payload). Persist to FileStorage; " \
                  "feed it back to generate_validation_report's validation_result_json input to re-render later." }
        ]
      end,

      execute: lambda do |_connection, input, _eis, _eos, _continue|
        # Parse canonical model — defensive against Workato's string-vs-hash pill quirk
        raw_model = input["canonical_model_json"]
        model = case raw_model
                when String
                  begin
                    JSON.parse(raw_model)
                  rescue JSON::ParserError => e
                    error("Invalid canonical_model_json: #{e.message}")
                  end
                when Hash
                  raw_model
                else
                  error("canonical_model_json is required (string or hash)")
                end

        fields          = model["cfg_fields"]               || []
        rules           = model["cfg_rules"]                || []
        lookups         = model["cfg_lookups"]              || []
        err_trans       = model["cfg_error_messages"]   || []
        variant_ids     = input["variant_field_ids"]        || []
        prior_values    = input["prior_values"]             || {}
        opts            = input["options"]                  || {}

        apply_cleaning  = opts["apply_cleaning"].nil? ? true : opts["apply_cleaning"]
        max_per_row     = opts["max_errors_per_row"]
        max_total       = opts["max_total_errors"]
        stop_first      = opts["stop_on_first_row_failure"] || false

        rows           = input["upload_data"]               || []
        raw_rows       = input["upload_data_json"]
        rows           = case raw_rows
                         when String
                          begin
                            JSON.parse(raw_rows)
                          rescue JSON::ParserError => e
                            error("Invalid upload data_json: #{e.message}")
                          end
                         when Array
                          raw_rows
                         when NilClass
                          []
                        else
                          error("upload_data_json is required (JSON string or array).")
                        end

        # ── Empty-submission gate ─────────────────
        # Zero rows is hard-fail by default per the capability deep dive.
        # Return early with status='empty' and a single summary error so the
        # recipe persists it through the same path as other failures.
        if rows.empty?
          result = {
            "status" => "empty",
            "summary" => {
              "total_rows"       => 0,
              "valid_rows"       => 0,
              "invalid_rows"     => 0,
              "total_errors"     => 1,
              "truncated"        => false,
              "cleaning_applied" => false
            },
            "errors" => [{
              "row_number"      => 0,
              "field_id"        => nil,
              "field_name"      => nil,
              "submitted_value" => nil,
              "error_code"      => "err_empty_submission",
              "error_message"   => "Submission contains no rows",
              "strict"          => true,
              "source"          => "structural"
            }]
          }
          # validation_result_json is the persisted shape: status + summary + errors, no payload.
          return result.merge("valid_payload" => [], "validation_result_json" => result.to_json)
        end

        # Filter fields by variant if applicable
        active_fields = if variant_ids.present?
                          fields.select { |f| variant_ids.include?(f["field_id"]) }
                        else
                          fields
                        end

        # Build lookup index: { lookup_name => [{ valid_value, parent_value }] }
        lookup_index = lookups.group_by { |l| l["lookup_name"] }

        all_errors     = []
        processed_rows = [] # every cleaned row retained w/row number. 
        truncated      = false

        # Per-field working data for column uniqueness (Phase 3)
        col_values = {}  # { field_id => { value => [row_numbers] } }
        active_fields.each { |f| col_values[f["field_id"]] = {} if f["column_unique"] }

        # Per-rule composite key tracking for "Combined fields must be unique" (Phase 3)
        # Submission-scope composite rules only — supplier/engagement-scope rules
        # check against prior_values inline in the rule loop.
        # { rule_index => { composite_key_string => [row_numbers] } }
        composite_keys = {}
        composite_rules = rules.each_with_index.select { |r, _|
          r["rule"] == "Combined fields must be unique" &&
            !%w[supplier engagement].include?(r["scope"])
        }
        composite_rules.each { |_, ri| composite_keys[ri] = {} }

        rows.each_with_index do |raw_row, idx|
          row_num = idx + 1
          row = raw_row.dup
          row_errors = []

          # ── Phase 0: Cleaning ─────────────────
          if apply_cleaning
            active_fields.each do |f|
              next if f["data_cleaning_flags"].blank?
              flags = f["data_cleaning_flags"].split(",").map(&:strip)
              flags.each do |flag|
                row[f["field_name"]] = call(:apply_cleaning_flag, row[f["field_name"]], flag)
              end
            end
          end

          # ── Phase 1 & 2: Per-field checks ─────
          active_fields.each do |f|
            fname = f["field_name"]
            fid   = f["field_id"]
            val   = row[fname]
            original_val = raw_row[fname]
            phase1_failed = false

            # -- Phase 1: Structural --

            # 1. Required
            if f["required"] && val.to_s.strip.empty?
              row_errors << {
                "row_number" => row_num, "field_id" => fid, "field_name" => fname,
                "submitted_value" => original_val, "error_code" => "err_required",
                "error_message" => "#{fname} is required",
                "strict" => f["strict"].nil? ? true : f["strict"],
                "source" => "single_field"
              }
              phase1_failed = true
            end

            # 2. Must be empty
            if !phase1_failed && f["must_be_empty"] && val.to_s.strip.present?
              row_errors << {
                "row_number" => row_num, "field_id" => fid, "field_name" => fname,
                "submitted_value" => original_val, "error_code" => "err_must_be_empty",
                "error_message" => "#{fname} must be empty",
                "strict" => f["strict"].nil? ? true : f["strict"],
                "source" => "single_field"
              }
              phase1_failed = true
            end

            # Skip further checks if blank and not required
            next if val.to_s.strip.empty?

            # 3. Data type
            if !phase1_failed && !call(:check_data_type, val, f["data_type"])
              row_errors << {
                "row_number" => row_num, "field_id" => fid, "field_name" => fname,
                "submitted_value" => original_val, "error_code" => "err_data_type",
                "error_message" => "#{fname}: '#{val}' is not a valid #{f['data_type']}",
                "strict" => f["strict"].nil? ? true : f["strict"],
                "source" => "single_field"
              }
              phase1_failed = true
            end

            # 4. Data format
            if !phase1_failed && !call(:check_data_format, val, f["data_format"])
              row_errors << {
                "row_number" => row_num, "field_id" => fid, "field_name" => fname,
                "submitted_value" => original_val, "error_code" => "err_standard_format",
                "error_message" => "#{fname}: '#{val}' doesn't match format #{f['data_format']}",
                "strict" => f["strict"].nil? ? true : f["strict"],
                "source" => "single_field"
              }
              phase1_failed = true
            end

            next if phase1_failed

            # -- Phase 2: Constraints --

            # 5. Field length
            if f["field_length_validation"].present?
              parsed = call(:parse_interval, f["field_length_validation"])
              result = call(:evaluate_interval, parsed, val.to_s.length)
              unless result["pass"]
                row_errors << {
                  "row_number" => row_num, "field_id" => fid, "field_name" => fname,
                  "submitted_value" => original_val, "error_code" => "err_length_constraint",
                  "error_message" => "#{fname}: length #{val.to_s.length} — #{result['message']}",
                  "strict" => f["strict"].nil? ? true : f["strict"],
                  "source" => "single_field"
                }
              end
            end

            # 6. Numeric range
            if f["numeric_field_validation"].present? && %w[integer float\ (2)].include?(f["data_type"])
              parsed = call(:parse_interval, f["numeric_field_validation"])
              result = call(:evaluate_interval, parsed, val)
              unless result["pass"]
                row_errors << {
                  "row_number" => row_num, "field_id" => fid, "field_name" => fname,
                  "submitted_value" => original_val, "error_code" => "err_value_range",
                  "error_message" => "#{fname}: #{result['message']}",
                  "strict" => f["strict"].nil? ? true : f["strict"],
                  "source" => "single_field"
                }
              end
            end

            # 7. Date range
            if f["date_field_validation"].present? && f["data_type"] == "date"
              parsed = call(:parse_interval, f["date_field_validation"])
              result = call(:evaluate_date_interval, parsed, val)
              unless result["pass"]
                row_errors << {
                  "row_number" => row_num, "field_id" => fid, "field_name" => fname,
                  "submitted_value" => original_val, "error_code" => "err_date_constraint",
                  "error_message" => "#{fname}: #{result['message']}",
                  "strict" => f["strict"].nil? ? true : f["strict"],
                  "source" => "single_field"
                }
              end
            end

            # 8. Regex
            if f["field_input_validation"].present?
              begin
                unless val.to_s.match?(Regexp.new(f["field_input_validation"]))
                  row_errors << {
                    "row_number" => row_num, "field_id" => fid, "field_name" => fname,
                    "submitted_value" => original_val, "error_code" => "err_regex",
                    "error_message" => "#{fname}: '#{val}' doesn't match pattern",
                    "strict" => f["strict"].nil? ? true : f["strict"],
                    "source" => "single_field"
                  }
                end
              rescue => _e
                # Invalid regex — should have been caught by validate_config
              end
            end

            # 9. Lookup membership
            if f["lookup_name"].present?
              valid_set = lookup_index[f["lookup_name"]] || []
              if f["data_format"] == "dropdown (dependent)" && f["depends_on_lookup_name"].present?
                parent_field = active_fields.find { |pf| pf["lookup_name"] == f["depends_on_lookup_name"] }
                parent_val   = parent_field ? row[parent_field["field_name"]] : nil
                valid_set    = valid_set.select { |l| l["parent_value"].to_s == parent_val.to_s }
              end
              valid_values = valid_set.map { |l| l["valid_value"] }
              unless valid_values.include?(val.to_s.strip)
                row_errors << {
                  "row_number" => row_num, "field_id" => fid, "field_name" => fname,
                  "submitted_value" => original_val, "error_code" => "err_lookup_mismatch",
                  "error_message" => "#{fname}: '#{val}' is not a valid option",
                  "strict" => f["strict"].nil? ? true : f["strict"],
                  "source" => "single_field"
                }
              end
            end

            # Track for column uniqueness (Phase 3)
            if f["column_unique"] && val.to_s.strip.present?
              col_values[fid][val.to_s.strip] ||= []
              col_values[fid][val.to_s.strip] << row_num
            end
          end

          # ── Phase 4: Cross-field rules ────────
          rules.each do |rule|
            target_field = active_fields.find { |f| f["field_id"] == rule["field_id"] || f["field_name"] == rule["target_field_name"] }
            next unless target_field

            t_val = row[target_field["field_name"]]
            c_field = active_fields.find { |f| f["field_id"] == rule["condition_field_id"] || f["field_name"] == rule["condition_field_name"] }
            c_val = c_field ? row[c_field["field_name"]] : nil

            # ── Cross-submission scope branch (supplier | engagement) ──
            # Rules with scope=supplier or scope=engagement evaluate against
            # prior_values rather than within-submission. The caller is
            # responsible for filtering prior_values to validated/approved
            # prior submissions (the resubmit-after-failure trap).
            if rule["scope"].present? && %w[supplier engagement].include?(rule["scope"])
              prior = prior_values[rule["field_id"]] || []

              case rule["rule"]
              when "Combined fields must be unique"
                composite = [t_val.to_s.strip, c_val.to_s.strip].join("\x1F")
                prior_match = prior.any? { |p| p["composite_key"] == composite }

                if prior_match
                  msg = call(:resolve_error_message, rule, err_trans, {
                    "error_code"      => "err_composite_unique",
                    "field_name"      => target_field["field_name"],
                    "condition_field" => c_field&.dig("field_name"),
                    "provided_value"  => composite.gsub("\x1F", " + ")
                  })
                  row_errors << {
                    "row_number" => row_num, "field_id" => target_field["field_id"],
                    "field_name" => target_field["field_name"],
                    "submitted_value" => raw_row[target_field["field_name"]],
                    "error_code" => "err_composite_unique",
                    "error_message" => msg,
                    "strict" => rule["strict_enforcement"].nil? ? true : rule["strict_enforcement"],
                    "source" => "cross_field"
                  }
                end

              when "Must not match"
                if prior.any? { |p| p["value"].to_s == t_val.to_s }
                  msg = call(:resolve_error_message, rule, err_trans, {
                    "error_code"     => "err_must_not_match",
                    "field_name"     => target_field["field_name"],
                    "provided_value" => t_val
                  })
                  row_errors << {
                    "row_number" => row_num, "field_id" => target_field["field_id"],
                    "field_name" => target_field["field_name"],
                    "submitted_value" => raw_row[target_field["field_name"]],
                    "error_code" => "err_must_not_match",
                    "error_message" => msg,
                    "strict" => rule["strict_enforcement"].nil? ? true : rule["strict_enforcement"],
                    "source" => "cross_field"
                  }
                end
              end

              # Cross-submission rule handled — skip within-submission dispatch
              next
            end

            # ── Within-submission dispatch (default scope) ──
            failed = false
            error_code = nil

            case rule["rule"]
            when "Must match"
              failed = t_val.to_s != c_val.to_s
              error_code = "err_must_match"
            when "Must not match"
              failed = t_val.to_s == c_val.to_s && t_val.to_s.present?
              error_code = "err_must_not_match"
            when "Must be greater than"
              failed = t_val.to_f <= c_val.to_f if t_val.present? && c_val.present?
              error_code = "err_greater_than"
            when "Must be greater than or equal to"
              failed = t_val.to_f < c_val.to_f if t_val.present? && c_val.present?
              error_code = "err_greater_than_equal"
            when "Must be less than"
              failed = t_val.to_f >= c_val.to_f if t_val.present? && c_val.present?
              error_code = "err_less_than"
            when "Must be less than or equal to"
              failed = t_val.to_f > c_val.to_f if t_val.present? && c_val.present?
              error_code = "err_less_than_equal"
            when "Must be empty if"
              if c_val.to_s == rule["conditional_value"].to_s
                failed = t_val.to_s.strip.present?
                error_code = "err_conditional_empty"
              end
            when "Required if"
              if c_val.to_s == rule["conditional_value"].to_s
                failed = t_val.to_s.strip.empty?
                error_code = "err_conditional_required"
              end
            when "Mutually exclusive"
              failed = t_val.to_s.strip.present? && c_val.to_s.strip.present?
              error_code = "err_mutually_exclusive"
            when "At least one required"
              failed = t_val.to_s.strip.empty? && c_val.to_s.strip.empty?
              error_code = "err_require_one_of"
            when "Combined fields must be unique"
              # Collect composite key — duplicate detection is deferred to Phase 3
              rule_idx = rules.index(rule)
              if composite_keys[rule_idx]
                key_parts = [t_val.to_s.strip, c_val.to_s.strip]
                composite_key = key_parts.join("\x1F")  # unit separator — won't appear in data
                composite_keys[rule_idx][composite_key] ||= []
                composite_keys[rule_idx][composite_key] << row_num
              end
              next
            end

            if failed
              msg = call(:resolve_error_message, rule, err_trans, {
                "error_code"      => error_code,
                "field_name"      => target_field["field_name"],
                "provided_value"  => t_val,
                "condition_field" => c_field&.dig("field_name")
              })
              row_errors << {
                "row_number" => row_num, "field_id" => target_field["field_id"],
                "field_name" => target_field["field_name"],
                "submitted_value" => raw_row[target_field["field_name"]],
                "error_code" => error_code, "error_message" => msg,
                "strict" => rule["strict_enforcement"].nil? ? true : rule["strict_enforcement"],
                "source" => "cross_field"
              }
            end
          end

          # Apply per-row error cap
          if max_per_row && row_errors.size > max_per_row
            row_errors = row_errors.first(max_per_row)
          end

          all_errors.concat(row_errors)

          # Keep the cleaned row; defer valid/invalid decision until after integrity errors are propagated
          processed_rows << { "row_number" => row_num, "data" => row }

          # Global caps
          has_strict_error = row_errors.any? { |e| e["strict"] }
          if max_total && all_errors.size >= max_total
            truncated = true
            break
          end
          break if stop_first && has_strict_error
        end

        # ── Phase 3: Column uniqueness ──────────
        col_values.each do |fid, val_map|
          f = active_fields.find { |af| af["field_id"] == fid }
          next unless f

          val_map.each do |val, row_nums|
            next unless row_nums.size > 1
            # Flag duplicates (not the first occurrence)
            row_nums[1..].each do |rn|
              all_errors << {
                "row_number" => rn, "field_id" => fid,
                "field_name" => f["field_name"],
                "submitted_value" => val, "error_code" => "err_column_unique",
                "error_message" => "#{f['field_name']}: duplicate value '#{val}'",
                "strict" => f["strict"].nil? ? true : f["strict"],
                "source" => "single_field"
              }
            end
          end
        end

        # ── Phase 3b: Composite uniqueness (submission-scope only) ──
        # Supplier-scope and engagement-scope composite rules were evaluated
        # inline against prior_values; only submission-scope rules accumulated
        # composite_keys for within-submission duplicate detection.
        composite_rules.each do |rule, ri|
          key_map = composite_keys[ri] || {}
          target_field = active_fields.find { |f| f["field_id"] == rule["field_id"] || f["field_name"] == rule["target_field_name"] }
          c_field = active_fields.find { |f| f["field_id"] == rule["condition_field_id"] || f["field_name"] == rule["condition_field_name"] }

          key_map.each do |composite_val, row_nums|
            next unless row_nums.size > 1

            # Flag duplicates (not the first occurrence)
            row_nums[1..].each do |rn|
              msg = call(:resolve_error_message, rule, err_trans, {
                "error_code"      => "err_composite_unique",
                "field_name"      => target_field&.dig("field_name"),
                "condition_field" => c_field&.dig("field_name"),
                "provided_value"  => composite_val.gsub("\x1F", " + ")
              })
              all_errors << {
                "row_number"      => rn,
                "field_id"        => target_field&.dig("field_id"),
                "field_name"      => target_field&.dig("field_name"),
                "submitted_value" => composite_val.gsub("\x1F", " + "),
                "error_code"      => "err_composite_unique",
                "error_message"   => msg,
                "strict"          => rule["strict_enforcement"].nil? ? true : rule["strict_enforcement"],
                "source"          => "cross_field"
              }
            end
          end
        end

        # Phase 5: Promote integrity violations to strict
        # A row missing a required field, carrying the wrong data type, failing its format/lookup, or breaking
        # uniqueness guarantee is not a "soft" finding and should not be persisted, regardless of the per-field 
        # "strict" flag. The flag still governs the optional layer (length, range, date, regex, cross-field rules).
        integrity_codes = %w[
          err_required err_data_type err_standard_format err_lookup_mismatch err_column_unique err_composite_unique
        ]
        all_errors.each do |e|
          e["strict"] = true if integrity_codes.include?(e["error_code"])
        end

        invalid_row_nums = all_errors.select { |e| e["strict"] }
                                     .map    { |e| e["row_number"] }
                                     .uniq
        valid_payload    = processed_rows
                                     .reject { |r| invalid_row_nums.include?(r["row_number"]) }
                                     .map    { |r| r["data"] }
        invalid_count    = invalid_row_nums.size

        # The persisted shape: status + summary + errors. valid_payload stays
        # out of validation_result_json — the report never needs it and it's
        # the bulk of the size.
        result = {
          "status" => invalid_row_nums.any? ? "failed" : "passed",
          "summary" => {
            "total_rows"       => rows.size,
            "valid_rows"       => valid_payload.size,
            "invalid_rows"     => invalid_count,
            "total_errors"     => all_errors.size,
            "truncated"        => truncated,
            "cleaning_applied" => apply_cleaning
          },
          "errors" => all_errors
        }

        result.merge("valid_payload" => valid_payload, "validation_result_json" => result.to_json)
      end
    },


    # ── Generate validation report ────────────────────────────
    generate_validation_report: {
      title: "Generate validation report",
      subtitle: "Shape validation results into a report-ready structure",
      help: lambda do
        {
          body: "Called after upload validation completes, or later on demand. Takes Action 3 output — either the live " \
                "object or its validation_result_json read back from FileStorage — and produces sorted report rows, " \
                "per-field and per-row error counts, and a bounded row summary for XLSX/PDF rendering."
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: "validation_result", type: "object", optional: true,
            label: "Validation output (Action 3)",
            hint: "Live output of validate_upload. Omit when passing validation_result_json instead.",
            properties: [
              { name: "status",  type: "string" },
              { name: "summary", type: "object", properties: [
                { name: "total_rows",   type: "integer" },
                { name: "valid_rows",   type: "integer" },
                { name: "invalid_rows", type: "integer" },
                { name: "total_errors", type: "integer" },
                { name: "truncated",    type: "boolean" }
              ] },
              { name: "errors", type: "array", of: "object",
                properties: object_definitions["validation_error"] }
            ] },
          { name: "validation_result_json", type: "string", optional: true, control_type: "text-area",
            label: "Validation output (JSON)",
            hint: "Alternative to validation_result: validate_upload's validation_result_json, " \
                  "read back from FileStorage. Takes precedence when present." },
          { name: "fields", type: "array", of: "object", optional: true,
            label: "CFG_Field rows (for display ordering)",
            properties: [
              *object_definitions["field_definition"],
              { name: "field_id", type: "string" }
            ] },
          { name: "report_options", type: "object", optional: true, properties: [
            { name: "max_errors_in_report",  type: "integer", optional: true },
            { name: "max_rows_in_summary",   type: "integer", optional: true,
              hint: "Worst-offending rows listed in row_error_summary. Default 10." },
            { name: "group_by", optional: true, control_type: "select",
              pick_list: "report_group_by", default: "row", toggle_hint: "Select from list",
              toggle_field: {
                name: "group_by", label: "Group by", type: "string",
                control_type: "text", optional: true, toggle_hint: "Use custom value" }},
            { name: "include_summary_section", type: "boolean", optional: true },
            { name: "include_passed_rows",     type: "boolean", optional: true }
          ] }
        ]
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: "summary", type: "object", properties: [
            { name: "status",             type: "string" },
            { name: "total_rows",         type: "integer" },
            { name: "valid_rows",         type: "integer" },
            { name: "invalid_rows",       type: "integer" },
            { name: "total_errors",       type: "integer" },
            { name: "errors_in_report",   type: "integer" }
          ] },
          { name: "report_rows", type: "array", of: "object", properties: [
            { name: "row_number",         type: "integer" },
            { name: "field_name",         type: "string" },
            { name: "submitted_value",    type: "string", optional: true },
            { name: "error_message",      type: "string" },
            { name: "severity",           type: "string" }
          ] },
          { name: "field_error_counts",   type: "array", of: "object", properties: [
            { name: "field_name",         type: "string" },
            { name: "error_count",        type: "integer" },
            { name: "most_common_error",  type: "string" }
          ] },
          { name: "row_error_counts",     type: "array", of: "object", properties: [
            { name: "row_number",         type: "integer" },
            { name: "error_count",        type: "integer" },
            { name: "strict_error_count", type: "integer" }
          ] },
          { name: "row_error_summary",    type: "object",
            hint: "Bounded projection of row_error_counts for the report's summary section. " \
                  "Height is fixed by max_rows_in_summary, not by the data.",
            properties: [
              { name: "rows_with_errors", type: "integer",
                hint: "Rows carrying at least one error or warning. Differs from invalid_rows when a row has only warnings." },
              { name: "rows_not_shown",   type: "integer",
                hint: "rows_with_errors minus the rows listed in worst_rows." },
              { name: "worst_rows",       type: "array", of: "object", properties: [
                { name: "row_number",         type: "integer" },
                { name: "error_count",        type: "integer" },
                { name: "strict_error_count", type: "integer" }
              ] }
            ] },
          { name: "row_error_table",        type: "array", of: "object",
            hint: "One line per data row carrying at least one error. count_errors is distinct from fields on the row, not error events.",
            properties: [
              { name: "row_with_error",     type: "integer" },
              { name: "count_errors",       type: "integer" },
              { name: "fields_with_errors", type: "string" }
            ] }
        ]
      end,

      execute: lambda do |_connection, input, _eis, _eos, _continue|
        # Accept either the live validate_upload object or its serialized form —
        # same string-vs-hash defensiveness as validate_upload's own inputs.
        raw = input["validation_result_json"].presence
        vr  = case raw
              when String
                # FileStorage content can arrive base64-encoded — the same boundary quirk as XLSX
                raw = raw.decode_base64 unless raw.lstrip.start_with?("{")
                begin
                  JSON.parse(raw)
                rescue JSON::ParserError => e
                  error("Invalid validation_result_json: #{e.message}")
                end
              when Hash
                raw
              else
                input["validation_result"] || {}
              end
        error("validation_result or validation_result_json is required") if vr.blank?

        flds = input["fields"] || []
        opts = input["report_options"] || {}

        errors         = vr["errors"] || []
        group_by       = opts["group_by"] || "row"
        max_in_report  = opts["max_errors_in_report"]
        max_in_summary = opts["max_rows_in_summary"] || 10

        # Build field position index for sorting
        field_position = {}
        flds.each_with_index { |f, i| field_position[f["field_name"]] = i }
        if field_position.empty?
          errors.each { |e| field_position[e["field_name"]] ||= field_position.size }
        end

        # Map to report rows
        report_rows = errors.map do |e|
          {
            "row_number"      => e["row_number"],
            "field_name"      => e["field_name"],
            "submitted_value" => e["submitted_value"],
            "error_message"   => e["error_message"],
            "severity"        => e["strict"] ? "error" : "warning"
          }
        end

        # Sort
        report_rows = if group_by == "field"
                        report_rows.sort_by { |r| [field_position[r["field_name"]] || 999, r["row_number"]] }
                      else
                        report_rows.sort_by { |r| [r["row_number"], field_position[r["field_name"]] || 999] }
                      end

        # Truncate
        if max_in_report && report_rows.size > max_in_report
          report_rows = report_rows.first(max_in_report)
        end

        # Field error counts
        field_error_counts = errors
          .group_by { |e| e["field_name"] }
          .map do |fname, errs|
            most_common = errs
              .group_by { |e| e["error_code"] }
              .max_by { |_, v| v.size }
            {
              "field_name"        => fname,
              "error_count"       => errs.size,
              "most_common_error" => most_common ? most_common[0] : "unknown"
            }
          end
          .sort_by { |fc| -(fc["error_count"]) }

        # Row error counts — same basis as field_error_counts: the full error
        # set, not the truncated report_rows, so per-row totals stay true when
        # max_errors_in_report cuts detail lines.
        row_error_counts = errors
          .group_by { |e| e["row_number"] }
          .map do |rn, errs|
            {
              "row_number"         => rn,
              "error_count"        => errs.size,
              "strict_error_count" => errs.count { |e| e["strict"] }
            }
          end
          .sort_by { |rc| rc["row_number"] }

        # Bounded row summary for the report's summary section. Blocking
        # errors sort first: those rows were rejected, while a warnings-only
        # row still landed in valid_payload.
        worst_rows = row_error_counts
          .sort_by { |rc| [-rc["strict_error_count"], -rc["error_count"], rc["row_number"]] }
          .first(max_in_summary)

        row_error_summary = {
          "rows_with_errors" => row_error_counts.size,
          "rows_not_shown"   => row_error_counts.size - worst_rows.size,
          "worst_rows"       => worst_rows
        }

        row_error_table = errors
          .group_by { |e| e["row_number"] }
          .sort_by  { |rn, _| rn }
          .map do |rn, errs|
            fnames = errs.map { |e| e["field_name"] }.compact.uniq
                         .sort_by { |fn| field_position[fn] || 999 }

            {
              "row_with_error"      => rn,
              "count_errors"        => fnames.size,
              "fields_with_errors"  => fnames.join(", ")
            }
          end

        {
          "summary" => {
            "status"           => vr["status"],
            "total_rows"       => vr.dig("summary", "total_rows"),
            "valid_rows"       => vr.dig("summary", "valid_rows"),
            "invalid_rows"     => vr.dig("summary", "invalid_rows"),
            "total_errors"     => vr.dig("summary", "total_errors"),
            "errors_in_report" => report_rows.size
          },
          "report_rows"        => report_rows,
          "field_error_counts" => field_error_counts,
          "row_error_counts"   => row_error_counts,
          "row_error_summary"  => row_error_summary,
          "row_error_table"    => row_error_table
        }
      end
    },

    # ── Finalize verdict ──────────────────────────────────────
    finalize_verdict: {
      title: "Finalize verdict",
      subtitle: "Map a validation verdict to canonical transition tokens",
      help: lambda do
        { body: "Pure function and single source of truth for the verdict -> STS-01 transition mapping " \
                "(sdc-state-machines-v3.md, D9). Prior-state independent: every verdict, including error, " \
                "exits pending_validation through STS-01 (invariant 8). is_error means 'route via the error " \
                "exit and raise the recipe_failed observability event', not 'skip STS-01'. When " \
                "submission_attempt and max_submission are both supplied and the attempt has reached the " \
                "limit, a failed verdict routes to pending_review via submission_limit_reached instead of " \
                "back to the supplier. Pilot override retired 2026-08-07." }
      end,
      input_fields: lambda do |_object_definitions|
        [
          { name: "verdict_status", type: "string", optional: false,
            hint: "passed | failed | empty | structural_failure | error. " \
                  "Unrecognized values are collapsed to error (defensive)." },
          { name: "submission_attempt", type: "integer", optional: true,
            hint: "Attempt number of THIS submission (post-increment). Omit to disable the limit." },
          { name: "max_submission", type: "integer", optional: true,
            hint: "Project.max_submission. Blank or 0 = unlimited." }
        ]
      end,
      output_fields: lambda do |_object_definitions|
        [
          { name: "verdict",         type: "string" },
          { name: "trigger_context", type: "string" },
          { name: "target_state",    type: "string" },
          { name: "is_error",        type: "boolean", control_type: "checkbox" }
        ]
      end,
      execute: lambda do |_connection, input, _eis, _eos, _continue|
        raw       = input["verdict_status"].to_s.strip
        attempts  = input["submission_attempt"].to_i
        limit     = input["max_submission"].to_i
        exhausted = limit > 0 && attempts >= limit   # >= : counter drift fails toward the analyst

        if raw == "passed"
          { "verdict" => "passed", "trigger_context" => "system_validation_passed",
            "target_state" => "pending_review", "is_error" => false }
        elsif %w[failed empty structural_failure].include?(raw)
          # Option A (C2): structural_failure and empty ride the failed path.
          if exhausted
            { "verdict" => raw, "trigger_context" => "submission_limit_reached",
              "target_state" => "pending_review", "is_error" => false }
          else
            { "verdict" => raw, "trigger_context" => "system_validation_failed",
              "target_state" => "supplier_action_required", "is_error" => false }
          end
        else
          # "error" and any unexpected value: real STS-01 trigger as of v3 (D3).
          { "verdict" => "error", "trigger_context" => "system_validation_error",
            "target_state" => "supplier_action_required", "is_error" => true }
        end
      end
    },


    # ── Build file storage path ────────────────────────────────
    build_storage_path: {
      title: "Build storage path",
      subtitle: "Generate a standardized FileStorage path and file name",
      help: lambda do
        {
          body: "Returns a canonical FileStorage path from project context. " \
                "All recipes call this instead of constructing paths locally, " \
                "ensuring consistent directory structure and slug format."
        }
      end,

      input_fields: lambda do |_object_definitions|
        [
          { name: "root", type: "string", label: "Storage root",
            hint: "Account property ENV_FILE_STORAGE_ROOT_ID value (e.g., /sdc)" },
          { name: "client_name", type: "string" },
          { name: "template_project_id", type: "string", hint: "Full UUID — first 8 characters used for folder name" },
          { name: "subfolder", type: "string", optional: true, control_type: "select",
            pick_list: [
              %w[Config config],
              %w[Templates templates],
              %w[Seeded seeded],
              %w[Uploads uploads],
              %w[Reports reports]
            ],
            toggle_hint: "Select from list",
            toggle_field: { name: "subfolder", label: "Subfolder", type: "string", control_type: "text", toggle_hint: "Use custom value" },
            hint: "Omit to get the project root path" },
          { name: "file_name", type: "string", optional: true, hint: "Raw file name — will be slugified. Extension preserved." },
          { name: "file_name_suffix", type: "string", optional: true,
            hint: "Optional suffix appended before extension (e.g., upload_id short). Not slugified." }
        ]
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: "project_path", type: "string", hint: "Full path to project root: {root}/{client_slug}/{project_short}" },
          { name: "full_path", type: "string", hint: "Path including subfolder (if provided)" },
          { name: "parent_path", type: "string", hint: "Parent directory path for ensure_dir_exists" },
          { name: "leaf_name", type: "string", hint: "Directory name for ensure_dir_exists" },
          { name: "file_name", type: "string", optional: true, hint: "Slugified file name (if file_name input provided)" },
          { name: "file_path_with_name", type: "string", optional: true,  hint: "full_path + file_name combined" },
          { name: "client_slug", type: "string" },
          { name: "project_short", type: "string" }
        ]
      end,

      execute: lambda do |_connection, input, _eis, _eos, _continue|
        root = input["root"].to_s.strip.chomp("/")
        client_slug = call(:sanitize_slug, input["client_name"])
        project_short = input["template_project_id"].to_s.strip[0..7]

        project_path = "#{root}/#{client_slug}/#{project_short}"

        full_path = if input["subfolder"].present?
                      "#{project_path}/#{input['subfolder'].strip.downcase}"
                    else
                      project_path
                    end

        # Build file name if provided
        file_name = nil
        if input["file_name"].present?
          raw = input["file_name"].to_s.strip
          ext = File.extname(raw)
          base = raw.chomp(ext)
          slug = call(:sanitize_slug, base)

          if input["file_name_suffix"].present?
            slug = "#{slug}_#{input['file_name_suffix'].to_s.strip}"
          end

          file_name = "#{slug}#{ext}"
        end

        result = {
          "project_path"  => project_path,
          "full_path"     => full_path,
          "client_slug"   => client_slug,
          "project_short" => project_short
        }

        if file_name.present?
          result["file_name"] = file_name
          result["file_path_with_name"] = "#{full_path}/#{file_name}"
        end
      
        # Split for ensure_dir_exists compatibility
        parts = full_path.split("/")
        leaf_name = parts.pop
        parent_path = parts.join("/")

        result["parent_path"] = parent_path
        result["leaf_name"] = leaf_name

        result
      end
    }
  }
}
