# frozen_string_literal: true
#
# x Compute - patch for WFA-005 "Load uploads to table component on analyst review page"
#
# Adds one pure-compute action, build_upload_history_rows, that replaces the per-upload loop in WFA-005
# (one RUN_ValidationResult query + one list append per upload). Rows in, table rows out. No I/O.
#
# Two blocks to paste into the connector:
#   BLOCK 1  object_definitions  -> upload_row, validation_result_row, template_version_row, upload_history_row
#            paste after `migration_row: { ... },` (the last entry of object_definitions)
#   BLOCK 2  actions             -> build_upload_history_rows
#            paste after `plan_user_migration: { ... }` (the last entry of actions); add a comma after that entry
#
# No new methods. Uses the existing rows / clean / to_int / parse_time / iso / ok / fail.
#
# Design notes
#   - Input rows use the tables' own column names (RUN_Upload, RUN_ValidationResult, CFG_TemplateVersion), so a
#     data_table_query(...)["records"].pluck("fields") result slots in with no renaming.
#   - `uploads` is a list field: it comes from the native Search-records step, whose keys are column ids, so the
#     columns are mapped by pill once. `validation_results` and `template_versions` are JSON text: Workato list
#     fields do not accept formula mode, and the $in fetch only exists as a formula (or as a pill + .to_json).
#   - One row per upload, in arrival order. Several validation results for one upload -> latest completed_at wins.
#     No validation result -> the row is still returned, validation fields blank, has_validation_result = false.
#   - Unparseable JSON text fails the action (recipe_invariant) instead of quietly producing a table with no
#     validation columns.
# =====================================================================================================================


# =====================================================================================================================
# BLOCK 1 - object_definitions
# =====================================================================================================================

    # ---- WFA-005 -----------------------------------------------------------------------------------------------------
    # RUN_Upload row, keyed by the table's column names. Map the Search-records columns onto these once.
    upload_row: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'record_id', type: 'string', label: 'Record ID', hint: 'Optional' },
          { name: 'upload_id', type: 'string', label: 'Upload ID' },
          { name: 'template_version_id', type: 'string', label: 'Template version ID' },
          { name: 'submitted_path', type: 'string', label: 'Submitted path' },
          { name: 'extracted_path', type: 'string', label: 'Extracted path' },
          { name: 'status', type: 'string', label: 'Status' },
          { name: 'submitted_at', type: 'string', label: 'Submitted at', hint: 'ISO 8601 or a date-time pill' }
        ]
      end
    },

    # RUN_ValidationResult row, keyed by the table's column names.
    validation_result_row: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'validation_result_id', type: 'string', label: 'Validation result ID' },
          { name: 'upload_id', type: 'string', label: 'Upload ID' },
          { name: 'template_version_id', type: 'string', label: 'Template version ID' },
          { name: 'status', type: 'string', label: 'Status' },
          { name: 'valid_row_count', type: 'integer', label: 'Valid row count' },
          { name: 'invalid_row_count', type: 'integer', label: 'Invalid row count' },
          { name: 'report_path', type: 'string', label: 'Report path' },
          { name: 'completed_at', type: 'string', label: 'Completed at' },
          { name: 'count_errors_all_fields', type: 'integer', label: 'Count of errors (all fields)', hint: 'Read when the table carries it' }
        ]
      end
    },

    # CFG_TemplateVersion row - only the two columns this join needs.
    template_version_row: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'template_version_id', type: 'string', label: 'Template version ID' },
          { name: 'version_number', type: 'string', label: 'Version number' }
        ]
      end
    },

    # One row of the analyst review table. Names match the table component's columns, so the Return step maps name for name.
    upload_history_row: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'upload_id', type: 'string', label: 'Upload ID' },
          { name: 'template_version_id', type: 'string', label: 'Template version ID' },
          { name: 'validation_result_id', type: 'string', label: 'Validation result ID' },
          { name: 'upload_time', type: 'date_time', control_type: 'date_time', label: 'Upload date' },
          { name: 'template_version', type: 'string', label: 'Template version', hint: 'CFG_TemplateVersion.version_number; blank when not resolved' },
          { name: 'submitted_path', type: 'string', label: 'Submitted path' },
          { name: 'extracted_path', type: 'string', label: 'Extracted path' },
          { name: 'status', type: 'string', label: 'Status' },
          { name: 'validation_status', type: 'string', label: 'Validation status' },
          { name: 'validation_valid_row_count', type: 'integer', label: 'Validation valid row count' },
          { name: 'validation_invalid_row_count', type: 'integer', label: 'Validation invalid row count' },
          { name: 'validation_report_path', type: 'string', label: 'Validation report path' },
          { name: 'validation_result_time', type: 'date_time', control_type: 'date_time', label: 'Validation result time' },
          { name: 'count_errors_across_all_rows', type: 'integer', label: 'Count of errors across all fields' },
          { name: 'has_validation_result', type: 'boolean', control_type: 'checkbox', label: 'Has validation result' },
          { name: 'validation_result_count', type: 'integer', label: 'Validation result count', hint: '> 1 means the upload was validated more than once; the latest is shown' }
        ]
      end
    }


# =====================================================================================================================
# BLOCK 2 - actions
# =====================================================================================================================

    # ---- WFA-005 -----------------------------------------------------------------------------------------------------
    build_upload_history_rows: {
      title: 'Build upload history rows',
      subtitle: 'Join a request\'s uploads to their latest validation result and template version - one row per upload',
      help: lambda do |_input, _picklist_label|
        {
          body: 'Replaces the WFA-005 per-upload loop. Rows in, table rows out: one row per upload, in the order the uploads arrive. ' \
                'When an upload has more than one validation result the latest completed_at wins. Uploads without a result are ' \
                'still returned (validation fields blank, has_validation_result = false). Validation results and template versions ' \
                'arrive as JSON text so they can come from a data_table_query formula ($in on the upload ids); a list pill in ' \
                'formula mode followed by .to_json works too. Unparseable JSON text fails the action rather than returning a table ' \
                'with empty validation columns.'
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: 'uploads', type: 'array', of: 'object', optional: false, label: 'Uploads',
            hint: 'RUN_Upload rows for the request - the Search records output, columns mapped once',
            properties: object_definitions['upload_row'] },
          { name: 'validation_results', type: 'string', control_type: 'text-area', optional: true, label: 'Validation results (JSON list)',
            hint: 'RUN_ValidationResult rows keyed by column name, as JSON text. Typical: data_table_query(...)["records"].pluck("fields").to_json' },
          { name: 'template_versions', type: 'string', control_type: 'text-area', optional: true, label: 'Template versions (JSON list)',
            hint: 'CFG_TemplateVersion rows (template_version_id, version_number) as JSON text. Leave blank to leave template_version empty' }
        ]
      end,

      execute: lambda do |_connection, input|
        blank = { 'count' => 0, 'matched_count' => 0, 'unmatched_count' => 0, 'rows' => [], 'log' => '' }
        log = []

        # JSON-text inputs: an array passes through; JSON text is parsed; anything else is a mapping mistake and must not
        # be read as "no rows". Local for now - promote to methods when a second action takes JSON-text rows.
        json_list = lambda do |value|
          return [true, value.select { |x| x.is_a?(Hash) }] if value.is_a?(Array)
          s = call(:clean, value)
          return [true, []] if s.empty?
          parsed = begin
            JSON.parse(s)
          rescue StandardError
            nil
          end
          parsed.is_a?(Array) ? [true, parsed.select { |x| x.is_a?(Hash) }] : [false, []]
        end

        uploads = call(:rows, input['uploads']).select { |x| x.is_a?(Hash) }
        results_ok, results = json_list.call(input['validation_results'])
        versions_ok, versions = json_list.call(input['template_versions'])

        unless results_ok
          next call(:fail, 'recipe_invariant',
                    "validation_results is not a JSON list (starts with: #{call(:clean, input['validation_results'])[0, 60]}). " \
                    'End the formula with .to_json.',
                    blank)
        end
        unless versions_ok
          next call(:fail, 'recipe_invariant',
                    "template_versions is not a JSON list (starts with: #{call(:clean, input['template_versions'])[0, 60]}). " \
                    'End the formula with .to_json.',
                    blank)
        end

        log << "arrivals: uploads=#{uploads.length} validation_results=#{results.length} template_versions=#{versions.length}"

        # Rows that arrive without their key were mapped onto the wrong names. Say so; do not return a blank table.
        if !uploads.empty? && uploads.none? { |u| !call(:clean, u['upload_id']).empty? }
          next call(:fail, 'recipe_invariant',
                    "BOUNDARY| uploads arrived (#{uploads.length} rows) but 'upload_id' is blank on all rows -- map RUN_Upload.upload_id " \
                    "onto uploads[].upload_id. First row keys: #{uploads.first.keys.sort}",
                    blank.merge('log' => log.join("\n")))
        end
        if !results.empty? && results.none? { |r| !call(:clean, r['upload_id']).empty? }
          next call(:fail, 'recipe_invariant',
                    "BOUNDARY| validation_results arrived (#{results.length} rows) but 'upload_id' is blank on all rows -- rows must use " \
                    "RUN_ValidationResult column names. First row keys: #{results.first.keys.sort}",
                    blank.merge('log' => log.join("\n")))
        end

        # Latest validation result per upload, by completed_at. A row with no parseable time never beats one that has one.
        latest = {}
        result_count = Hash.new(0)
        results.each do |r|
          uid = call(:clean, r['upload_id'])
          next if uid.empty?
          result_count[uid] += 1
          t = call(:parse_time, r['completed_at'])
          cur = latest[uid]
          latest[uid] = { 'row' => r, 'time' => t } if cur.nil? || (!t.nil? && (cur['time'].nil? || t >= cur['time']))
        end
        result_count.each { |uid, n| log << "upload #{uid}: #{n} validation results; keeping the latest completed_at" if n > 1 }

        version_by_id = {}
        versions.each do |v|
          vid = call(:clean, v['template_version_id'])
          version_by_id[vid] = call(:clean, v['version_number']) unless vid.empty?
        end
        log << 'template_versions not provided; template_version left blank' if versions.empty?

        # ISO 8601 or nil. A non-blank value that does not parse is logged, not passed through as text.
        stamp = lambda do |value, what|
          t = call(:parse_time, value)
          log << "#{what} '#{value}' is not a parseable time; left blank" if t.nil? && !call(:clean, value).empty?
          t.nil? ? nil : call(:iso, t)
        end

        missing_versions = {}
        rows = uploads.map do |u|
          uid = call(:clean, u['upload_id'])
          tvid = call(:clean, u['template_version_id'])
          hit = latest[uid]
          vr = hit.nil? ? {} : hit['row']
          missing_versions[tvid] = true if !tvid.empty? && !versions.empty? && !version_by_id.key?(tvid)
          {
            'upload_id' => uid,
            'template_version_id' => tvid,
            'validation_result_id' => call(:clean, vr['validation_result_id']),
            'upload_time' => stamp.call(u['submitted_at'], "upload #{uid} submitted_at"),
            'template_version' => (version_by_id[tvid] || ''),
            'submitted_path' => call(:clean, u['submitted_path']),
            'extracted_path' => call(:clean, u['extracted_path']),
            'status' => call(:clean, u['status']),
            'validation_status' => call(:clean, vr['status']),
            'validation_valid_row_count' => call(:to_int, vr['valid_row_count'], nil),
            'validation_invalid_row_count' => call(:to_int, vr['invalid_row_count'], nil),
            'validation_report_path' => call(:clean, vr['report_path']),
            'validation_result_time' => stamp.call(vr['completed_at'], "upload #{uid} completed_at"),
            'count_errors_across_all_rows' => call(:to_int, vr['count_errors_all_fields'], nil),
            'has_validation_result' => !hit.nil?,
            'validation_result_count' => result_count[uid]
          }
        end

        matched = rows.count { |r| r['has_validation_result'] }
        log << "template versions not found in template_versions: #{missing_versions.keys.sort.join(', ')}" unless missing_versions.empty?
        log << "built #{rows.length} rows | with validation result=#{matched} | without=#{rows.length - matched}"

        call(:ok,
             'count' => rows.length,
             'matched_count' => matched,
             'unmatched_count' => rows.length - matched,
             'rows' => rows,
             'log' => log.join("\n"))
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['result_envelope'] + [
          { name: 'count', type: 'integer', label: 'Row count' },
          { name: 'matched_count', type: 'integer', label: 'Uploads with a validation result' },
          { name: 'unmatched_count', type: 'integer', label: 'Uploads without a validation result' },
          { name: 'rows', type: 'array', of: 'object', label: 'Rows', hint: 'One per upload, in arrival order; map straight into the table component',
            properties: object_definitions['upload_history_row'] },
          { name: 'log', type: 'string', label: 'Log' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          'ok' => true, 'error' => { 'code' => '', 'message' => '' }, 'count' => 1, 'matched_count' => 1, 'unmatched_count' => 0,
          'rows' => [{ 'upload_id' => 'upl-1', 'template_version_id' => 'ver-3', 'validation_result_id' => 'vr-1',
                       'upload_time' => '2026-09-10T18:00:00+00:00', 'template_version' => '3', 'submitted_path' => 'uploads/acme/1.xlsx',
                       'extracted_path' => 'extracted/acme/1.json', 'status' => 'validated', 'validation_status' => 'failed',
                       'validation_valid_row_count' => 40, 'validation_invalid_row_count' => 2, 'validation_report_path' => 'reports/acme/1.xlsx',
                       'validation_result_time' => '2026-09-10T18:05:00+00:00', 'count_errors_across_all_rows' => 5,
                       'has_validation_result' => true, 'validation_result_count' => 1 }],
          'log' => "arrivals: uploads=1 validation_results=1 template_versions=1\nbuilt 1 rows | with validation result=1 | without=0"
        }
      end
    }
