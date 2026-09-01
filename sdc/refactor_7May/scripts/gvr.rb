# ── Generate validation report ────────────────────────────
    generate_validation_report: {
      title: "Generate validation report",
      subtitle: "Shape validation results into a report-ready structure",
      help: lambda do
        {
          body: "Called after upload validation completes. Takes Action 3 output and produces sorted report rows, " \
                "per-field and per-row error counts, and a bounded row summary for XLSX/PDF rendering."
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: "validation_result", type: "object",
            label: "Validation output (Action 3)",
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
          { name: "fields", type: "array", of: "object",
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
            ] }
        ]
      end,

      execute: lambda do |_connection, input, _eis, _eos, _continue|
        vr   = input["validation_result"]
        flds = input["fields"] || []
        opts = input["report_options"] || {}

        errors         = vr["errors"] || []
        group_by       = opts["group_by"] || "row"
        max_in_report  = opts["max_errors_in_report"]
        max_in_summary = opts["max_rows_in_summary"] || 10

        # Build field position index for sorting
        field_position = {}
        flds.each_with_index { |f, i| field_position[f["field_name"]] = i }

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
          "row_error_summary"  => row_error_summary
        }
      end
    },
