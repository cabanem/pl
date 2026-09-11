# frozen_string_literal: true

# =====================================================================================================================
# SDC Compute - Wave 1
#
# Pure compute actions that replace six Python steps in the SDC recipes:
#   plan_primary_user_change   <- INV-04 "Evaluate verdict (promote || create)"
#   plan_task_ensure           <- INV-02 "Ensure task"
#   classify_requests_by_task  <- UTL-06 "Filter and emit lists"
#   compute_reminders          <- REM-02 "Compute reminders"
#   build_request_rows         <- REQ-01 "Resolve variant path and build rows"
#   plan_user_migration        <- MIG-01 "Plan migration"
#
# Three layers, composed in the order the SDK reads them:
#   object_definitions  one vocabulary per entity (supplier, supplier_user, supplier_request, variant) and one
#                       result envelope. Every action's input_fields and output_fields are built from these.
#   methods             one implementation of each helper the Python steps had re-written per step
#                       (to_bool, clean, norm, to_int, rows, parse_time, iso, ok/fail, new_uuid, now_iso).
#   actions             rows in, decision out. No I/O. The recipe still queries the tables (pure compute, decision 1).
#
# Contract rules every action follows:
#   - Output = result_envelope (ok, error{code, message}) + payload. On failure the payload is present and blank,
#     so downstream pills always resolve to something.
#   - Payload field names keep the names the recipes already read (plan.mode, plan.task_action, rows, pending_reminders ...)
#     except where the design record documents a deliberate change (REQ-01 supplier_user_row.user_email;
#     UTL-06 matched_count / requests).
#   - Booleans go through to_bool. Strings go through clean / norm. Nothing raises on a nil or an int where a string
#     was expected.
#   - Every boolean INPUT is built by toggleable_boolean: a checkbox with a text toggle, so it can be ticked or mapped.
#
# Runtime notes: the SDK runs full Ruby 2.7 with `require` for standard libraries (whitelist removal, 2025). The three
# requires below cover JSON.parse, SecureRandom.uuid and Time. String#to_time is the SDK's own (ActiveSupport) method.
# =====================================================================================================================
require 'json'
require 'securerandom'
require 'time'

{
  title: 'SDC Compute',

  connection: {
    fields: [],
    authorization: { type: 'custom_auth' }
  },

  test: lambda do |_connection|
    true
  end,

  # -------------------------------------------------------------------------------------------------------------------
  # OBJECT DEFINITIONS
  # -------------------------------------------------------------------------------------------------------------------
  object_definitions: {

    # The envelope every action returns. `error` is an object so a code and a message travel together;
    # recipes branch on `ok` and alert with `error.message`.
    result_envelope: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'ok', type: 'boolean', control_type: 'checkbox', label: 'OK' },
          { name: 'error', type: 'object', label: 'Error', properties: [
            { name: 'code', type: 'string', label: 'Code', hint: 'Machine-readable: recipe_invariant, state_inconsistent, unexpected_error ...' },
            { name: 'message', type: 'string', label: 'Message' }
          ] }
        ]
      end
    },

    supplier: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'supplier_id', type: 'string', label: 'Supplier ID' },
          { name: 'supplier_name', type: 'string', label: 'Supplier name' },
          { name: 'status', type: 'string', label: 'Status' }
        ]
      end
    },

    # One column vocabulary for SUP_SupplierUser. Map the table's columns onto these names once per recipe;
    # the per-step accessor code (user_supplier_id / su_user_email / USER_user_id ...) is gone.
    supplier_user: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'record_id', type: 'string', label: 'Record ID', hint: 'Data table record id, when the action must write back' },
          { name: 'supplier_user_id', type: 'string', label: 'Supplier user ID' },
          { name: 'supplier_id', type: 'string', label: 'Supplier ID' },
          { name: 'user_email', type: 'string', label: 'User email' },
          { name: 'contact_name', type: 'string', label: 'Contact name' },
          call(:toggleable_boolean, 'primary', 'Primary', 'true / 1 / yes / y / t are all read as true'),
          { name: 'status', type: 'string', label: 'Status', hint: 'active, inactive, invited ...' },
          { name: 'kick_off_email_sent_time', type: 'string', label: 'Kick-off email sent at' }
        ]
      end
    },

    # One vocabulary for a WFA request row (SUP_SupplierRequest + the task columns the WFA exposes).
    supplier_request: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'record_id', type: 'string', label: 'Record ID' },
          { name: 'supplier_request_id', type: 'string', label: 'Supplier request ID' },
          { name: 'supplier_id', type: 'string', label: 'Supplier ID' },
          { name: 'supplier_name', type: 'string', label: 'Supplier name', hint: 'Optional, when the query already joined it' },
          { name: 'assignee_email', type: 'string', label: 'Assignee email' },
          { name: 'status', type: 'string', label: 'Status', hint: 'pending, sent, supplier_action_required, pending_validation, pending_review, approved, cancelled' },
          { name: 'stage_id', type: 'string', label: 'Stage ID' },
          { name: 'stage_name', type: 'string', label: 'Stage name' },
          { name: 'assigned_version_id', type: 'string', label: 'Assigned version ID' },
          { name: 'assigned_variant_id', type: 'string', label: 'Assigned variant ID' },
          { name: 'template_path', type: 'string', label: 'Template path' },
          { name: 'current_state_entered_at', type: 'string', label: 'Current state entered at' },
          { name: 'submission_attempt', type: 'integer', label: 'Submission attempt' },
          { name: 'reminder_count', type: 'integer', label: 'Reminder count' },
          { name: 'last_reminder_sent_at', type: 'string', label: 'Last reminder sent at' },
          call(:toggleable_boolean, 'reminders_enabled', 'Reminders enabled', 'Blank counts as enabled'),
          call(:toggleable_boolean, 'has_seeded_data', 'Has seeded data'),
          { name: 'task_id', type: 'string', label: 'Task ID' },
          { name: 'task_name', type: 'string', label: 'Task name' },
          { name: 'task_status', type: 'string', label: 'Task status' },
          { name: 'task_expires_at', type: 'string', label: 'Task expires at' },
          { name: 'task_link', type: 'string', label: 'Task link' },
          { name: 'assigned_user_id', type: 'string', label: 'Assigned user ID' },
          { name: 'assigned_user_name', type: 'string', label: 'Assigned user name' },
          { name: 'assigned_user_email', type: 'string', label: 'Assigned user email' },
          { name: 'assigned_user_status', type: 'string', label: 'Assigned user status', hint: 'invited = never completed portal registration' }
        ]
      end
    },

    variant: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'variant_id', type: 'string', label: 'Variant ID' },
          { name: 'variant_name', type: 'string', label: 'Variant name', hint: 'The only identity that survives a re-publish' },
          { name: 'template_version_id', type: 'string', label: 'Template version ID' },
          { name: 'template_path', type: 'string', label: 'Template path' }
        ]
      end
    },

    # Payload shapes specific to one action, kept here so output_fields and sample_output share them.
    primary_user_plan: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'mode', type: 'string', label: 'Mode', hint: 'promote | create' },
          { name: 'disposition', type: 'string', label: 'Disposition', hint: 'promoted_existing | invited_new | already_primary' },
          { name: 'reassign', type: 'boolean', control_type: 'checkbox', label: 'Reassign task', hint: 'true = call INV-02 with the new primary as assignee' },
          { name: 'task_action', type: 'string', label: 'Task action', hint: 'delegated_to_inv02 | left_in_place' },
          { name: 'skip_reason', type: 'string', label: 'Skip reason' },
          { name: 'target_record_id', type: 'string', label: 'Target record ID' },
          { name: 'supplier_user_id', type: 'string', label: 'Supplier user ID' },
          { name: 'demote_rows', type: 'array', of: 'object', label: 'Rows to demote', properties: [
            { name: 'record_id', type: 'string', label: 'Record ID' }
          ] },
          { name: 'demote_count', type: 'integer', label: 'Demote count' },
          { name: 'drift_detected', type: 'boolean', control_type: 'checkbox', label: 'Drift detected' },
          { name: 'drift_note', type: 'string', label: 'Drift note' },
          { name: 'old_primary_email', type: 'string', label: 'Old primary email' },
          { name: 'new_primary_email', type: 'string', label: 'New primary email' },
          { name: 'contact_name', type: 'string', label: 'Contact name' },
          { name: 'new_user_supplier_user_id', type: 'string', label: 'New user supplier user ID' },
          { name: 'new_user_created_at', type: 'string', label: 'New user created at' }
        ]
      end
    },

    task_plan: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'assignee_email', type: 'string', label: 'Assignee email' },
          { name: 'contact_name', type: 'string', label: 'Contact name' },
          { name: 'workflow_app_stage', type: 'string', label: 'Workflow app stage', hint: 'awaiting_data_submission | under_review (INV-01a tokens)' },
          { name: 'is_reassignment', type: 'boolean', control_type: 'checkbox', label: 'Is reassignment' },
          { name: 'currently_assigned_user_email', type: 'string', label: 'Currently assigned user email' },
          { name: 'task_name', type: 'string', label: 'Task name' },
          { name: 'days_to_complete_task', type: 'integer', label: 'Days to complete task' },
          { name: 'send_email', type: 'boolean', control_type: 'checkbox', label: 'Send email' }
        ]
      end
    },

    request_task_view: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'supplier_request_id', type: 'string', label: 'Supplier request ID' },
          { name: 'supplier_id', type: 'string', label: 'Supplier ID' },
          { name: 'supplier_name', type: 'string', label: 'Supplier name' },
          { name: 'assignee_email', type: 'string', label: 'Assignee email' },
          { name: 'primary_contact_name', type: 'string', label: 'Primary contact name' },
          { name: 'primary_contact_email', type: 'string', label: 'Primary contact email' },
          { name: 'status', type: 'string', label: 'Status (as stored)' },
          { name: 'request_status', type: 'string', label: 'Request status (normalised)' },
          { name: 'condition', type: 'string', label: 'Condition', hint: 'expired | stranded | active' },
          { name: 'task_status', type: 'string', label: 'Task status' },
          { name: 'task_holder_email', type: 'string', label: 'Task holder email' },
          { name: 'task_holder_status', type: 'string', label: 'Task holder status' },
          { name: 'current_state_entered_at', type: 'string', label: 'Current state entered at' },
          { name: 'stage_id', type: 'string', label: 'Stage ID' },
          { name: 'stage_name', type: 'string', label: 'Stage name' },
          { name: 'note', type: 'string', label: 'Note' },
          { name: 'active_task', type: 'object', label: 'Active task', properties: [
            { name: 'active_task_id', type: 'string', label: 'Task ID' },
            { name: 'active_task_name', type: 'string', label: 'Task name' },
            { name: 'active_task_due_date', type: 'string', label: 'Due date' },
            { name: 'active_task_url', type: 'string', label: 'URL' },
            { name: 'active_task_status', type: 'string', label: 'Status' },
            { name: 'assigned_user', type: 'object', label: 'Assigned user', properties: [
              { name: 'assigned_user_id', type: 'string', label: 'ID' },
              { name: 'assigned_user_name', type: 'string', label: 'Name' },
              { name: 'assigned_user_email', type: 'string', label: 'Email' }
            ] }
          ] }
        ]
      end
    },

    supplier_stats_row: {
      fields: lambda do |_connection, _config_fields, object_definitions|
        [
          { name: 'supplier_id', type: 'string', label: 'Supplier ID' },
          { name: 'supplier_name', type: 'string', label: 'Supplier name' },
          { name: 'has_request', type: 'boolean', control_type: 'checkbox', label: 'Has request' },
          { name: 'request_ids', type: 'array', of: 'string', label: 'Request IDs' },
          { name: 'request_statuses', type: 'array', of: 'string', label: 'Request statuses' },
          { name: 'total_submission_attempts', type: 'integer', label: 'Total submission attempts' },
          { name: 'last_reminder_sent_at', type: 'string', label: 'Last reminder sent at' },
          { name: 'first_kick_off_sent_at', type: 'string', label: 'First kick-off sent at' },
          { name: 'reminder_eligible', type: 'boolean', control_type: 'checkbox', label: 'Reminder eligible' },
          { name: 'users', type: 'array', of: 'object', label: 'Users', properties: object_definitions['supplier_user'] }
        ]
      end
    },

    pending_reminder: {
      fields: lambda do |_connection, _config_fields, object_definitions|
        [
          { name: 'supplier_request_id', type: 'string', label: 'Supplier request ID' },
          { name: 'supplier_id', type: 'string', label: 'Supplier ID' },
          { name: 'supplier_name', type: 'string', label: 'Supplier name' },
          { name: 'status', type: 'string', label: 'Status' },
          { name: 'submission_attempt', type: 'integer', label: 'Submission attempt' },
          { name: 'reminder_count', type: 'integer', label: 'Reminder count', hint: 'Current count; REM-01 increments' },
          { name: 'state_entered_time', type: 'string', label: 'State entered time' },
          { name: 'last_reminder_sent', type: 'string', label: 'Last reminder sent' },
          { name: 'interval_days', type: 'integer', label: 'Interval days' },
          { name: 'days_waiting', type: 'integer', label: 'Days waiting' },
          { name: 'recipient_emails', type: 'string', label: 'Recipient emails', hint: 'Comma-joined, deduplicated; a plain pill for the email step' },
          { name: 'users', type: 'array', of: 'object', label: 'Users', properties: object_definitions['supplier_user'] }
        ]
      end
    },

    migration_row: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'record_id', type: 'string', label: 'Record ID' },
          { name: 'supplier_request_id', type: 'string', label: 'Supplier request ID' },
          { name: 'supplier_id', type: 'string', label: 'Supplier ID' },
          { name: 'supplier_name', type: 'string', label: 'Supplier name' },
          { name: 'status', type: 'string', label: 'Status' },
          { name: 'old_version_id', type: 'string', label: 'Old version ID' },
          { name: 'old_variant_id', type: 'string', label: 'Old variant ID' },
          { name: 'new_variant_id', type: 'string', label: 'New variant ID' },
          { name: 'new_template_path', type: 'string', label: 'New template path' },
          { name: 'reason', type: 'string', label: 'Reason' }
        ]
      end
    }
  },

  # -------------------------------------------------------------------------------------------------------------------
  # METHODS - one implementation each. Decisions baked in are noted on the line.
  # -------------------------------------------------------------------------------------------------------------------
  methods: {

    # true / 1 / yes / y / t (any case) => true; booleans pass through; blank or nil => default.
    # Replaces _truthy x4, _is_truthy, _is_true, _as_bool x2, _flag / TRUTHY. (Decision 3.)
    to_bool: lambda do |value, default = false|
      return value if value == true || value == false
      s = value.to_s.strip.downcase
      return default if s.empty?
      %w[true 1 yes y t].include?(s)
    end,

    # Any value -> stripped string; nil -> "". Never raises on an int. Replaces _s, _clean, _text, _cell_text.
    clean: lambda do |value|
      value.nil? ? '' : value.to_s.strip
    end,

    # clean + downcase. Every email and status comparison goes through this. Replaces _norm, _norm_email, _email.
    norm: lambda do |value|
      call(:clean, value).downcase
    end,

    # "12" / "12.0" / 12.0 -> 12; blank or garbage -> default. Truncates (the majority reading; PRV-01 rounded).
    to_int: lambda do |value, default = 0|
      s = value.to_s.strip
      return default if s.empty?
      begin
        Integer(s, 10)
      rescue ArgumentError, TypeError
        begin
          Float(s).to_i
        rescue ArgumentError, TypeError
          default
        end
      end
    end,

    # JSON string or array -> array; anything else -> []. Replaces _rows x3 and INV-04's inline users parse.
    rows: lambda do |value|
      return [] if value.nil?
      if value.is_a?(String)
        s = value.strip
        return [] if s.empty?
        parsed = begin
          JSON.parse(s)
        rescue StandardError
          nil
        end
        return parsed.is_a?(Array) ? parsed : []
      end
      value.is_a?(Array) ? value : []
    end,

    # ISO 8601 (with or without Z or offset) -> Time; unparseable -> nil. Naive times are read as UTC.
    parse_time: lambda do |value|
      return nil if value.nil?
      return value if value.is_a?(Time)
      s = value.to_s.strip
      return nil if s.empty?
      begin
        s.to_time
      rescue StandardError
        nil
      end
    end,

    # Python's isoformat() shape for an aware time: 2026-09-01T10:00:00+00:00
    iso: lambda do |time|
      time.nil? ? nil : time.strftime('%Y-%m-%dT%H:%M:%S%:z')
    end,

    now_iso: lambda do
      Time.now.utc.strftime('%Y-%m-%dT%H:%M:%SZ')
    end,

    new_uuid: lambda do
      SecureRandom.uuid
    end,

    # A boolean input the recipe builder can either tick or map. A bare checkbox has no text surface, so Workato cannot
    # drop a datapill on it; toggle_field swaps the control for a text box with the SAME name, and boolean_conversion turns
    # "true"/"false"/a pill's text into a real boolean before execute runs. to_bool still guards the value inside execute.
    # Used for every boolean input, including the ones inside entity object definitions (list mapping shows them too).
    toggleable_boolean: lambda do |name, label, hint = nil, optional = true|
      field = {
        name: name, type: 'boolean', control_type: 'checkbox', label: label, optional: optional,
        toggle_hint: 'Use a value or pill',
        toggle_field: {
          name: name, type: 'boolean', control_type: 'text', label: label, optional: optional,
          convert_input: 'boolean_conversion',
          toggle_hint: 'Use checkbox',
          hint: 'true or false, or map a pill'
        }
      }
      field[:hint] = hint if hint
      field
    end,

    # The envelope. `payload` is the action's blank payload on failure, or its real payload on success.
    ok: lambda do |payload|
      { 'ok' => true, 'error' => { 'code' => '', 'message' => '' } }.merge(payload || {})
    end,

    fail: lambda do |code, message, payload|
      { 'ok' => false, 'error' => { 'code' => code.to_s, 'message' => message.to_s } }.merge(payload || {})
    end
  },

  # -------------------------------------------------------------------------------------------------------------------
  # ACTIONS
  # -------------------------------------------------------------------------------------------------------------------
  actions: {

    # ---- INV-04 -----------------------------------------------------------------------------------------------------
    plan_primary_user_change: {
      title: 'Plan primary user change',
      subtitle: 'Decide who becomes primary, who is demoted, whether a user row is created',
      help: lambda do |_input, _picklist_label|
        {
          body: 'Replaces the INV-04 Python step. Rows in (the supplier\'s users), plan out. Task handling stays delegated: ' \
                'when plan.reassign is true the recipe calls INV-02 with the new primary as assignee. ' \
                'The plan is returned nested under `plan`, which is what every downstream step already reads.'
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: 'new_primary_email', type: 'string', optional: false, label: 'New primary email' },
          { name: 'contact_name', type: 'string', optional: true, label: 'Contact name' },
          { name: 'request_status', type: 'string', optional: true, label: 'Request status' },
          { name: 'current_assignee_email', type: 'string', optional: true, label: 'Current assignee email', hint: 'Fallback for old_primary_email when no primary row exists' },
          { name: 'wfa_count', type: 'integer', optional: true, label: 'WFA request count', hint: 'Leave blank to skip the check' },
          { name: 'project_count', type: 'integer', optional: true, label: 'Project row count' },
          { name: 'supplier_count', type: 'integer', optional: true, label: 'Supplier row count' },
          call(:toggleable_boolean, 'move_task', 'Move task to new primary', 'Default true. (Was read but never declared in the Python step.)'),
          { name: 'users', type: 'array', of: 'object', optional: true, label: 'Supplier users', properties: object_definitions['supplier_user'] }
        ]
      end,

      execute: lambda do |_connection, input|
        blank = {
          'noop' => false,
          'plan' => {
            'mode' => '', 'disposition' => '', 'reassign' => false, 'task_action' => '', 'skip_reason' => '',
            'target_record_id' => '', 'supplier_user_id' => '', 'demote_rows' => [], 'demote_count' => 0,
            'drift_detected' => false, 'drift_note' => '', 'old_primary_email' => '', 'new_primary_email' => '',
            'contact_name' => '', 'new_user_supplier_user_id' => '', 'new_user_created_at' => ''
          }
        }
        terminal = %w[approved cancelled]

        users = call(:rows, input['users'])
        new_email_raw = call(:clean, input['new_primary_email'])
        new_email = call(:norm, new_email_raw)
        contact_name = call(:clean, input['contact_name'])
        status = call(:norm, input['request_status'])
        move_task = call(:to_bool, input['move_task'], true)
        request_assignee = call(:norm, input['current_assignee_email'])
        wfa_count_in = input['wfa_count']
        project_count = call(:to_int, input['project_count'])
        supplier_count = call(:to_int, input['supplier_count'])

        if new_email.empty? || !new_email.include?('@')
          next call(:fail, 'recipe_invariant', 'A valid new_primary_email is required.', blank)
        end
        if terminal.include?(status)
          next call(:fail, 'recipe_invariant', "Request has invariant status (#{status}). Cannot change primary.", blank)
        end
        if !call(:clean, wfa_count_in).empty? && call(:to_int, wfa_count_in) == 0
          next call(:fail, 'state_inconsistent', 'Request not found in the Workflow App.', blank)
        end
        if project_count == 0
          next call(:fail, 'state_inconsistent', "Project context is absent from the 'Project' table.", blank)
        end
        if supplier_count == 0
          next call(:fail, 'state_inconsistent', 'Supplier not found in SUP_Supplier.', blank)
        end

        target = users.find { |u| call(:norm, u['user_email']) == new_email }
        primaries = users.select { |u| call(:to_bool, u['primary']) }
        others = primaries.reject { |u| call(:norm, u['user_email']) == new_email }
        demote = others.map { |u| { 'record_id' => call(:clean, u['record_id']) } }

        target_is_primary = !target.nil? && call(:to_bool, target['primary'])
        if target_is_primary && others.empty?
          plan = blank['plan'].merge('disposition' => 'already_primary')
          next call(:ok, 'noop' => true, 'plan' => plan)
        end

        mode = target ? 'promote' : 'create'
        old_primary = others.map { |u| call(:clean, u['user_email']) }.reject(&:empty?).join(', ')
        old_primary = request_assignee if old_primary.empty?

        plan = {
          'mode' => mode,
          'disposition' => (mode == 'promote' ? 'promoted_existing' : 'invited_new'),
          'reassign' => move_task,
          'task_action' => (move_task ? 'delegated_to_inv02' : 'left_in_place'),
          'skip_reason' => (move_task ? '' : 'move_task is false; primary flag changed only.'),
          'target_record_id' => call(:clean, (target || {})['record_id']),
          'supplier_user_id' => call(:clean, (target || {})['supplier_user_id']),
          'demote_rows' => demote,
          'demote_count' => demote.length,
          'drift_detected' => primaries.length > 1,
          'drift_note' => (primaries.length > 1 ? "Found #{primaries.length} primary rows for this supplier; repaired by demotion." : ''),
          'old_primary_email' => old_primary,
          'new_primary_email' => new_email_raw,
          'contact_name' => (contact_name.empty? ? new_email_raw : contact_name),
          'new_user_supplier_user_id' => '',
          'new_user_created_at' => ''
        }
        if mode == 'create'
          plan['new_user_supplier_user_id'] = call(:new_uuid)
          plan['supplier_user_id'] = plan['new_user_supplier_user_id']
          plan['new_user_created_at'] = call(:now_iso)
        end

        call(:ok, 'noop' => false, 'plan' => plan)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['result_envelope'] + [
          { name: 'noop', type: 'boolean', control_type: 'checkbox', label: 'No-op', hint: 'true when the target is already the one and only primary' },
          { name: 'plan', type: 'object', label: 'Plan', properties: object_definitions['primary_user_plan'] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          'ok' => true, 'error' => { 'code' => '', 'message' => '' }, 'noop' => false,
          'plan' => { 'mode' => 'promote', 'disposition' => 'promoted_existing', 'reassign' => true, 'task_action' => 'delegated_to_inv02',
                      'skip_reason' => '', 'target_record_id' => '1234', 'supplier_user_id' => 'c0ffee', 'demote_rows' => [{ 'record_id' => '1233' }],
                      'demote_count' => 1, 'drift_detected' => false, 'drift_note' => '', 'old_primary_email' => 'old@supplier.example',
                      'new_primary_email' => 'new@supplier.example', 'contact_name' => 'New Contact', 'new_user_supplier_user_id' => '', 'new_user_created_at' => '' }
        }
      end
    },

    # ---- INV-02 -----------------------------------------------------------------------------------------------------
    plan_task_ensure: {
      title: 'Plan task on request',
      subtitle: 'Read the request\'s real state and pick recover, reassign, renew, noop or refuse',
      help: lambda do |_input, _picklist_label|
        {
          body: 'Replaces the INV-02 Python step. Never trusts the button the analyst pressed: no task on a task-bearing status ' \
                'is recover; a task held by someone other than the target is reassign; an expired task held by the target is renew; ' \
                'a live task held by the target is noop; a task-less status is refuse (ok = false). Stage token comes from status, ' \
                'mirroring STS-01, never from the request\'s current stage name.'
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: 'request_status', type: 'string', optional: false, label: 'Request status' },
          { name: 'stage_name', type: 'string', optional: true, label: 'Current WFA stage name', hint: 'Used only to report drift' },
          { name: 'task_id', type: 'string', optional: true, label: 'Task ID' },
          { name: 'task_name', type: 'string', optional: true, label: 'Task name' },
          { name: 'task_status', type: 'string', optional: true, label: 'Task status' },
          { name: 'task_holder_email', type: 'string', optional: true, label: 'Task holder email' },
          { name: 'requested_assignee_email', type: 'string', optional: true, label: 'Requested assignee email' },
          { name: 'supplier_name', type: 'string', optional: true, label: 'Supplier name' },
          { name: 'client_name', type: 'string', optional: true, label: 'Client name' },
          { name: 'analyst_email', type: 'string', optional: true, label: 'Analyst email', hint: 'Required for under-review requests' },
          { name: 'days_param', type: 'integer', optional: true, label: 'Days to complete (override)' },
          { name: 'project_default_days', type: 'integer', optional: true, label: 'Days to complete (project default)', hint: 'Falls back to 7' },
          { name: 'users', type: 'array', of: 'object', optional: true, label: 'Supplier users', properties: object_definitions['supplier_user'] }
        ]
      end,

      execute: lambda do |_connection, input|
        status_to_token = { 'sent' => 'awaiting_data_submission', 'supplier_action_required' => 'awaiting_data_submission', 'pending_review' => 'under_review' }
        status_to_stage = { 'sent' => 'Awaiting data submission', 'supplier_action_required' => 'Awaiting data submission', 'pending_review' => 'Under review' }
        blank = {
          'mode' => '', 'reason' => '', 'drift_detected' => false, 'drift_note' => '',
          'plan' => { 'assignee_email' => '', 'contact_name' => '', 'workflow_app_stage' => '', 'is_reassignment' => false,
                      'currently_assigned_user_email' => '', 'task_name' => '', 'days_to_complete_task' => 0, 'send_email' => false }
        }
        refuse = lambda do |code, message|
          call(:fail, code, message, blank.merge('mode' => 'refuse', 'reason' => message))
        end

        status = call(:norm, input['request_status'])
        stage_name = call(:clean, input['stage_name'])
        task_id = call(:clean, input['task_id'])
        task_status = call(:norm, input['task_status'])
        task_name = call(:clean, input['task_name'])
        holder = call(:norm, input['task_holder_email'])
        requested = call(:norm, input['requested_assignee_email'])
        supplier_name = call(:clean, input['supplier_name'])
        client_name = call(:clean, input['client_name'])
        analyst_email = call(:clean, input['analyst_email'])
        days = call(:to_int, input['days_param'], call(:to_int, input['project_default_days'], 7))
        users = call(:rows, input['users'])

        token = status_to_token[status]
        next refuse.call('recipe_invariant', "Status '#{status.empty? ? 'blank' : status}' carries no task; nothing to assign.") if token.nil?

        if token == 'under_review'
          target = call(:norm, analyst_email)
          next refuse.call('state_inconsistent', 'Project has no analyst_email.') if target.empty?
          contact_name = 'Implementation team'
        else
          by_email = {}
          users.each do |u|
            e = call(:norm, u['user_email'])
            by_email[e] = u unless e.empty?
          end
          primary = users.find { |u| call(:to_bool, u['primary']) && ['', 'active'].include?(call(:norm, u['status'])) }
          target = requested
          target = holder if target.empty?
          target = call(:norm, (primary || {})['user_email']) if target.empty?
          next refuse.call('state_inconsistent', 'No assignee: none requested, no task holder, no primary active user.') if target.empty?
          unless by_email.key?(target)
            next refuse.call('recipe_invariant', "#{target} is not a user of #{supplier_name.empty? ? 'this supplier' : supplier_name}; add them first via 'add a user' on this page.")
          end
          contact_name = call(:clean, by_email[target]['contact_name'])
          contact_name = target if contact_name.empty?
        end

        if task_id.empty?
          mode = 'recover'
        elsif token != 'under_review' && target != holder
          mode = 'reassign'
        elsif task_status == 'expired'
          mode = 'renew'
        else
          next call(:ok, blank.merge('mode' => 'noop', 'reason' => "Task already held by #{holder.empty? ? 'the Implementation team' : holder} and not expired."))
        end

        if task_name.empty?
          task_name = if token == 'under_review'
                        "Review submission for #{supplier_name}"
                      else
                        "Supplier data collection request for #{supplier_name} on behalf of #{client_name}"
                      end
        end

        expected_stage = status_to_stage[status] || ''
        drift = !stage_name.empty? && stage_name != expected_stage
        reason = case mode
                 when 'recover' then "No active task on a '#{status}' request; creating one for #{target}."
                 when 'reassign' then "Moving task from #{holder.empty? ? '(unassigned)' : holder} to #{target}."
                 else "Renewing expired task for #{target}."
                 end

        call(:ok,
             'mode' => mode,
             'reason' => reason,
             'drift_detected' => drift,
             'drift_note' => (drift ? "WFA stage is '#{stage_name}', expected '#{expected_stage}' for status '#{status}'." : ''),
             'plan' => {
               'assignee_email' => target,
               'contact_name' => contact_name,
               'workflow_app_stage' => token,
               'is_reassignment' => mode != 'recover',
               'currently_assigned_user_email' => (holder.empty? ? call(:norm, analyst_email) : holder),
               'task_name' => task_name,
               'days_to_complete_task' => days,
               'send_email' => true
             })
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['result_envelope'] + [
          { name: 'mode', type: 'string', label: 'Mode', hint: 'recover | reassign | renew | noop | refuse' },
          { name: 'reason', type: 'string', label: 'Reason', hint: 'Human-readable explanation of the mode' },
          { name: 'drift_detected', type: 'boolean', control_type: 'checkbox', label: 'Stage drift detected' },
          { name: 'drift_note', type: 'string', label: 'Drift note' },
          { name: 'plan', type: 'object', label: 'Plan', properties: object_definitions['task_plan'] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          'ok' => true, 'error' => { 'code' => '', 'message' => '' }, 'mode' => 'renew',
          'reason' => 'Renewing expired task for user@supplier.example.', 'drift_detected' => false, 'drift_note' => '',
          'plan' => { 'assignee_email' => 'user@supplier.example', 'contact_name' => 'Supplier User', 'workflow_app_stage' => 'awaiting_data_submission',
                      'is_reassignment' => true, 'currently_assigned_user_email' => 'user@supplier.example',
                      'task_name' => 'Supplier data collection request for Acme on behalf of Client', 'days_to_complete_task' => 7, 'send_email' => true }
        }
      end
    },

    # ---- UTL-06 -----------------------------------------------------------------------------------------------------
    classify_requests_by_task: {
      title: 'Classify requests by task condition',
      subtitle: 'One pass over WFA requests: expired, stranded, active - joined to supplier and primary contact',
      help: lambda do |_input, _picklist_label|
        {
          body: 'Replaces the UTL-06 Python step. expired = task present with status expired; active = task present, any other status; ' \
                'stranded = no task on a task-bearing status (sent, supplier_action_required, pending_review). Task-less statuses are skipped. ' \
                '`condition` selects which rows are returned; counts always cover all three.'
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: 'condition', type: 'string', control_type: 'select', optional: true, label: 'Condition', hint: 'Default expired',
            pick_list: [%w[Expired expired], %w[Stranded stranded], %w[Active active], %w[All all]],
            toggle_hint: 'Use a pill', toggle_field: { name: 'condition', type: 'string', control_type: 'text', label: 'Condition (text)', optional: true } },
          { name: 'requests', type: 'array', of: 'object', optional: true, label: 'WFA requests', properties: object_definitions['supplier_request'] },
          { name: 'suppliers', type: 'array', of: 'object', optional: true, label: 'Suppliers', properties: object_definitions['supplier'] },
          { name: 'supplier_users', type: 'array', of: 'object', optional: true, label: 'Supplier users', properties: object_definitions['supplier_user'] }
        ]
      end,

      execute: lambda do |_connection, input|
        task_bearing = %w[sent supplier_action_required pending_review]
        conditions = %w[expired stranded active all]

        requests = call(:rows, input['requests'])
        suppliers = call(:rows, input['suppliers'])
        supplier_users = call(:rows, input['supplier_users'])
        condition = call(:norm, input['condition'])
        condition = 'expired' if condition.empty?

        log = []
        unless conditions.include?(condition)
          log << "condition '#{condition}' not recognised; using 'expired'."
          condition = 'expired'
        end
        log << "arrivals: requests=#{requests.length} suppliers=#{suppliers.length} supplier_users=#{supplier_users.length} condition=#{condition}"

        if !suppliers.empty? && suppliers.none? { |s| !call(:clean, s['supplier_id']).empty? }
          log << "BOUNDARY| suppliers arrived (#{suppliers.length} rows) but 'supplier_id' is blank on all rows -- first row keys: #{suppliers.first.keys.sort}"
        end
        if !supplier_users.empty? && supplier_users.none? { |u| !call(:clean, u['supplier_id']).empty? }
          log << "BOUNDARY| supplier_users arrived (#{supplier_users.length} rows) but 'supplier_id' is blank on all rows -- first row keys: #{supplier_users.first.keys.sort}"
        end

        supplier_by_id = {}
        suppliers.each do |s|
          sid = call(:clean, s['supplier_id'])
          supplier_by_id[sid] = s unless sid.empty?
        end

        primary_by_supplier = {}
        supplier_users.each do |u|
          sid = call(:clean, u['supplier_id'])
          next if sid.empty? || !call(:to_bool, u['primary'])
          next unless ['', 'active'].include?(call(:norm, u['status']))
          if primary_by_supplier.key?(sid)
            log << "Supplier #{sid} has multiple primary active users; keeping #{primary_by_supplier[sid]['user_email']}."
            next
          end
          primary_by_supplier[sid] = u
        end

        counts = { 'expired' => 0, 'stranded' => 0, 'active' => 0 }
        detail = []
        supplier_misses = 0

        requests.each do |r|
          task_id = call(:clean, r['task_id'])
          task_status = call(:norm, r['task_status'])
          request_status = call(:norm, r['status'])

          cond = if task_status == 'expired' then 'expired'
                 elsif !task_id.empty? then 'active'
                 elsif task_bearing.include?(request_status) then 'stranded'
                 else ''
                 end
          next if cond.empty?
          counts[cond] += 1
          next if condition != 'all' && cond != condition

          req_id = call(:clean, r['supplier_request_id'])
          sid = call(:clean, r['supplier_id'])
          supplier = supplier_by_id[sid]
          contact = primary_by_supplier[sid]
          if supplier.nil?
            supplier_misses += 1
            log << "Request #{req_id}: supplier_id '#{sid}' not found in SUP_Supplier."
          end

          holder_status = call(:norm, r['assigned_user_status'])
          never_registered = holder_status == 'invited'

          detail << {
            'supplier_request_id' => r['supplier_request_id'],
            'supplier_id' => r['supplier_id'],
            'supplier_name' => (supplier || {})['supplier_name'],
            'assignee_email' => r['assignee_email'],
            'primary_contact_name' => (contact || {})['contact_name'],
            'primary_contact_email' => (contact || {})['user_email'],
            'status' => r['status'],
            'request_status' => request_status,
            'condition' => cond,
            'task_status' => task_status,
            'task_holder_email' => r['assigned_user_email'],
            'task_holder_status' => holder_status,
            'current_state_entered_at' => r['current_state_entered_at'],
            'stage_id' => r['stage_id'],
            'stage_name' => r['stage_name'],
            'note' => if never_registered then 'User never completed portal registration.'
                      elsif cond == 'stranded' then 'No task on a task-bearing request.'
                      else 'Active user'
                      end,
            'active_task' => {
              'active_task_id' => r['task_id'],
              'active_task_name' => r['task_name'],
              'active_task_due_date' => r['task_expires_at'],
              'active_task_url' => r['task_link'],
              'active_task_status' => r['task_status'],
              'assigned_user' => {
                'assigned_user_id' => r['assigned_user_id'],
                'assigned_user_name' => r['assigned_user_name'],
                'assigned_user_email' => r['assigned_user_email']
              }
            }
          }
        end

        log << "classified: expired=#{counts['expired']} stranded=#{counts['stranded']} active=#{counts['active']} | returned=#{detail.length} (#{condition}) | supplier misses=#{supplier_misses}"

        call(:ok, 'matched_count' => detail.length, 'counts' => counts, 'requests' => detail, 'log' => log.join("\n"))
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['result_envelope'] + [
          { name: 'matched_count', type: 'integer', label: 'Matched count', hint: 'Rows returned for the chosen condition (was expired_tasks_count)' },
          { name: 'counts', type: 'object', label: 'Counts', properties: [
            { name: 'expired', type: 'integer', label: 'Expired' },
            { name: 'stranded', type: 'integer', label: 'Stranded' },
            { name: 'active', type: 'integer', label: 'Active' }
          ] },
          { name: 'requests', type: 'array', of: 'object', label: 'Requests', hint: 'Was expired_task_detail', properties: object_definitions['request_task_view'] },
          { name: 'log', type: 'string', label: 'Log' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          'ok' => true, 'error' => { 'code' => '', 'message' => '' }, 'matched_count' => 1,
          'counts' => { 'expired' => 1, 'stranded' => 0, 'active' => 3 },
          'requests' => [{ 'supplier_request_id' => 'req-1', 'supplier_id' => 'sup-1', 'supplier_name' => 'Acme', 'assignee_email' => 'a@acme.example',
                           'primary_contact_name' => 'A', 'primary_contact_email' => 'a@acme.example', 'status' => 'sent', 'request_status' => 'sent',
                           'condition' => 'expired', 'task_status' => 'expired', 'task_holder_email' => 'a@acme.example', 'task_holder_status' => 'active',
                           'current_state_entered_at' => '2026-09-01T10:00:00Z', 'stage_id' => '1', 'stage_name' => 'Awaiting data submission',
                           'note' => 'Active user', 'active_task' => { 'active_task_id' => 't-1', 'active_task_name' => 'Supplier data collection request',
                                                                        'active_task_due_date' => '2026-09-08', 'active_task_url' => 'https://...', 'active_task_status' => 'expired',
                                                                        'assigned_user' => { 'assigned_user_id' => 'u-1', 'assigned_user_name' => 'A', 'assigned_user_email' => 'a@acme.example' } } }],
          'log' => 'arrivals: requests=4 suppliers=2 supplier_users=3 condition=expired'
        }
      end
    },

    # ---- REM-02 -----------------------------------------------------------------------------------------------------
    compute_reminders: {
      title: 'Compute reminders',
      subtitle: 'Supplier stats plus the requests due a reminder under the project cadence',
      help: lambda do |_input, _picklist_label|
        {
          body: 'Replaces the REM-02 Python step. A request is due when its status is sent or supplier_action_required, reminders are ' \
                'enabled, the reminder count is under the project cap, it has assigned users with usable emails, and the calendar days since ' \
                'max(state entered, last reminder sent) reach the cadence. A missing clock or a zero cadence fails the job on purpose ' \
                '(REM-01 should hear about it as an error, not a quiet zero).'
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: 'current_time', type: 'string', optional: false, label: 'Current time', hint: 'ISO 8601; the clock every comparison uses' },
          { name: 'reminder_cadence_days', type: 'integer', optional: false, label: 'Reminder cadence (days)', hint: 'Project.reminder_cadence' },
          { name: 'max_reminders', type: 'integer', optional: true, label: 'Max reminders', hint: 'Project.max_reminders; falls back to 3' },
          { name: 'requests', type: 'array', of: 'object', optional: true, label: 'Requests', properties: object_definitions['supplier_request'] },
          { name: 'supplier_users', type: 'array', of: 'object', optional: true, label: 'Supplier users', properties: object_definitions['supplier_user'] }
        ]
      end,

      execute: lambda do |_connection, input|
        remindable = %w[sent supplier_action_required]
        default_max = 3

        current_time = call(:parse_time, input['current_time'])
        requests = call(:rows, input['requests'])
        supplier_users = call(:rows, input['supplier_users'])
        log = []

        error('current_time missing or unparseable - cannot evaluate reminder cadence') if current_time.nil?
        interval = call(:to_int, input['reminder_cadence_days'], 0)
        error('Project.reminder_cadence missing or zero - reminders cannot be evaluated') if interval <= 0
        max_reminders = call(:to_int, input['max_reminders'], 0)
        if max_reminders <= 0
          max_reminders = default_max
          log << "Project.max_reminders missing/zero - defaulting to #{default_max}"
        end

        users_by_supplier = {}
        supplier_users.each do |u|
          sid = call(:clean, u['supplier_id'])
          next if sid.empty?
          (users_by_supplier[sid] ||= []) << {
            'supplier_user_id' => call(:clean, u['supplier_user_id']),
            'user_email' => call(:clean, u['user_email']),
            'contact_name' => call(:clean, u['contact_name']),
            'primary' => call(:to_bool, u['primary']),
            'status' => call(:clean, u['status']),
            'kick_off_email_sent_time' => (call(:clean, u['kick_off_email_sent_time']).empty? ? nil : u['kick_off_email_sent_time'])
          }
        end

        pending = []
        rollup = {}
        name_by_id = {}

        requests.each do |r|
          sid = call(:clean, r['supplier_id'])
          rid = call(:clean, r['supplier_request_id'])
          next if sid.empty?
          name_by_id[sid] = call(:clean, r['supplier_name']) unless name_by_id.key?(sid)
          roll = (rollup[sid] ||= { 'request_ids' => [], 'statuses' => [], 'attempts' => 0, 'last_reminder_sent_at' => nil, 'any_eligible' => false })
          next if rid.empty?

          status = call(:clean, r['status'])
          attempt = call(:to_int, r['submission_attempt'], 0)
          rcount = call(:to_int, r['reminder_count'], 0)
          state_entered = call(:parse_time, r['current_state_entered_at'])
          last_sent = call(:parse_time, r['last_reminder_sent_at'])

          roll['request_ids'] << rid
          roll['statuses'] << status
          roll['attempts'] += attempt
          roll['last_reminder_sent_at'] = last_sent if last_sent && (roll['last_reminder_sent_at'].nil? || last_sent > roll['last_reminder_sent_at'])

          next unless remindable.include?(status)
          next unless call(:to_bool, r['reminders_enabled'], true)
          next if rcount >= max_reminders

          users = users_by_supplier[sid] || []
          if users.empty?
            log << "request #{rid} (supplier #{sid}): no assigned users - skipped"
            next
          end
          anchors = [state_entered, last_sent].compact
          if anchors.empty?
            log << "request #{rid}: no anchor (state_entered_time and last_reminder_sent both empty) - skipped"
            next
          end
          anchor = anchors.max
          days_waiting = (current_time.to_date - anchor.to_date).to_i
          next if days_waiting < interval

          seen = {}
          recipients = []
          users.each do |u|
            e = call(:clean, u['user_email'])
            next if e.empty? || seen[e.downcase]
            seen[e.downcase] = true
            recipients << e
          end
          if recipients.empty?
            log << "request #{rid} (supplier #{sid}): users present but no usable email addresses - skipped"
            next
          end

          roll['any_eligible'] = true
          pending << {
            'supplier_request_id' => rid,
            'supplier_id' => sid,
            'supplier_name' => '',
            'status' => status,
            'submission_attempt' => attempt,
            'reminder_count' => rcount,
            'state_entered_time' => call(:iso, state_entered),
            'last_reminder_sent' => call(:iso, last_sent),
            'interval_days' => interval,
            'days_waiting' => days_waiting,
            'recipient_emails' => recipients.join(', '),
            'users' => users
          }
        end

        rows = name_by_id.map do |sid, name|
          roll = rollup[sid] || { 'request_ids' => [], 'statuses' => [], 'attempts' => 0, 'last_reminder_sent_at' => nil, 'any_eligible' => false }
          users = users_by_supplier[sid] || []
          kick_offs = users.map { |u| call(:parse_time, u['kick_off_email_sent_time']) }.compact
          {
            'supplier_id' => sid,
            'supplier_name' => name,
            'has_request' => !roll['request_ids'].empty?,
            'request_ids' => roll['request_ids'],
            'request_statuses' => roll['statuses'],
            'total_submission_attempts' => roll['attempts'],
            'last_reminder_sent_at' => call(:iso, roll['last_reminder_sent_at']),
            'first_kick_off_sent_at' => (kick_offs.empty? ? nil : call(:iso, kick_offs.min)),
            'reminder_eligible' => roll['any_eligible'],
            'users' => users
          }
        end
        rows.sort_by! { |r| r['supplier_name'].to_s.downcase }

        pending.each { |p| p['supplier_name'] = name_by_id[p['supplier_id']] || '' }
        pending.sort_by! { |p| [p['supplier_name'].to_s.downcase, p['supplier_request_id']] }

        call(:ok, 'rows' => rows, 'pending_reminders' => pending, 'log' => log)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['result_envelope'] + [
          { name: 'rows', type: 'array', of: 'object', label: 'Supplier rows', properties: object_definitions['supplier_stats_row'] },
          { name: 'pending_reminders', type: 'array', of: 'object', label: 'Pending reminders', properties: object_definitions['pending_reminder'] },
          { name: 'log', type: 'array', of: 'string', label: 'Log' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          'ok' => true, 'error' => { 'code' => '', 'message' => '' },
          'rows' => [{ 'supplier_id' => 'sup-1', 'supplier_name' => 'Acme', 'has_request' => true, 'request_ids' => ['req-1'], 'request_statuses' => ['sent'],
                       'total_submission_attempts' => 0, 'last_reminder_sent_at' => nil, 'first_kick_off_sent_at' => '2026-09-01T10:00:00+00:00',
                       'reminder_eligible' => true, 'users' => [] }],
          'pending_reminders' => [{ 'supplier_request_id' => 'req-1', 'supplier_id' => 'sup-1', 'supplier_name' => 'Acme', 'status' => 'sent', 'submission_attempt' => 0,
                                    'reminder_count' => 0, 'state_entered_time' => '2026-09-01T10:00:00+00:00', 'last_reminder_sent' => nil, 'interval_days' => 3,
                                    'days_waiting' => 9, 'recipient_emails' => 'a@acme.example', 'users' => [] }],
          'log' => []
        }
      end
    },

    # ---- REQ-01 -----------------------------------------------------------------------------------------------------
    build_request_rows: {
      title: 'Build supplier request rows',
      subtitle: 'Compose the primary user row and the pending request row for a parked supplier',
      help: lambda do |_input, _picklist_label|
        {
          body: 'Replaces the REQ-01 Python step. Fails loud on a blank supplier, assignee, variant or version, and on an unresolved ' \
                'template path (blank or "tbd"), rather than composing a half-row. The user row now carries user_email and contact_name - ' \
                'the supplier_user vocabulary - where the Python emitted assignee_email / assignee_contact_name.'
        }
      end,

      input_fields: lambda do |_object_definitions|
        [
          { name: 'supplier_id', type: 'string', optional: false, label: 'Supplier ID' },
          { name: 'assignee_email', type: 'string', optional: false, label: 'Assignee email', hint: 'First user; becomes primary and assignee' },
          { name: 'assignee_contact_name', type: 'string', optional: true, label: 'Assignee contact name' },
          { name: 'assigned_variant_id', type: 'string', optional: false, label: 'Assigned variant ID' },
          { name: 'assigned_version_id', type: 'string', optional: false, label: 'Assigned version ID' },
          { name: 'template_path', type: 'string', optional: true, label: 'Template path', hint: 'Resolved path for the chosen variant' }
        ]
      end,

      execute: lambda do |_connection, input|
        blank = {
          'supplier_user_row' => {}, 'supplier_request_row' => {},
          'supplier_user_id' => '', 'supplier_request_id' => '', 'assignee_email' => ''
        }
        supplier_id = call(:clean, input['supplier_id'])
        assignee_email = call(:norm, input['assignee_email'])
        contact_name = call(:clean, input['assignee_contact_name'])
        assigned_variant_id = call(:clean, input['assigned_variant_id'])
        assigned_version_id = call(:clean, input['assigned_version_id'])
        template_path = call(:clean, input['template_path'])

        next call(:fail, 'recipe_invariant', 'supplier_id is empty', blank) if supplier_id.empty?
        next call(:fail, 'recipe_invariant', 'assignee_email is empty', blank) if assignee_email.empty?
        next call(:fail, 'recipe_invariant', 'assigned_variant_id is required (analyst must pick a variant)', blank) if assigned_variant_id.empty?
        next call(:fail, 'recipe_invariant', 'assigned_version_id is empty', blank) if assigned_version_id.empty?
        if template_path.empty? || template_path.downcase == 'tbd'
          next call(:fail, 'state_inconsistent',
                    "variant '#{assigned_variant_id}' has no resolved template path (value: '#{template_path}'). Republish the version to populate CFG_Variant paths.",
                    blank)
        end

        now_iso = call(:now_iso)
        supplier_user_id = call(:new_uuid)
        supplier_request_id = call(:new_uuid)

        call(:ok,
             'supplier_user_row' => {
               'supplier_user_id' => supplier_user_id,
               'supplier_id' => supplier_id,
               'user_email' => assignee_email,
               'contact_name' => contact_name,
               'primary' => true,
               'status' => 'active',
               'created_at' => now_iso
             },
             'supplier_request_row' => {
               'supplier_request_id' => supplier_request_id,
               'supplier_id' => supplier_id,
               'assigned_version_id' => assigned_version_id,
               'assigned_variant_id' => assigned_variant_id,
               'assignee_email' => assignee_email,
               'status' => 'pending',
               'current_state_entered_at' => now_iso,
               'supplier_display_status' => 'Not yet sent',
               'supplier_message' => '',
               'reminders_enabled' => true,
               'has_seeded_data' => false,
               'submission_attempt' => 0,
               'last_reminder_tier' => 0,
               'template_path' => template_path
             },
             'supplier_user_id' => supplier_user_id,
             'supplier_request_id' => supplier_request_id,
             'assignee_email' => assignee_email)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['result_envelope'] + [
          { name: 'supplier_user_row', type: 'object', label: 'Supplier user row', properties: [
            { name: 'supplier_user_id', type: 'string', label: 'Supplier user ID' },
            { name: 'supplier_id', type: 'string', label: 'Supplier ID' },
            { name: 'user_email', type: 'string', label: 'User email' },
            { name: 'contact_name', type: 'string', label: 'Contact name' },
            { name: 'primary', type: 'boolean', control_type: 'checkbox', label: 'Primary' },
            { name: 'status', type: 'string', label: 'Status' },
            { name: 'created_at', type: 'string', label: 'Created at' }
          ] },
          { name: 'supplier_request_row', type: 'object', label: 'Supplier request row', properties: [
            { name: 'supplier_request_id', type: 'string', label: 'Supplier request ID' },
            { name: 'supplier_id', type: 'string', label: 'Supplier ID' },
            { name: 'assigned_version_id', type: 'string', label: 'Assigned version ID' },
            { name: 'assigned_variant_id', type: 'string', label: 'Assigned variant ID' },
            { name: 'assignee_email', type: 'string', label: 'Assignee email' },
            { name: 'status', type: 'string', label: 'Status' },
            { name: 'current_state_entered_at', type: 'string', label: 'Current state entered at' },
            { name: 'supplier_display_status', type: 'string', label: 'Supplier display status' },
            { name: 'supplier_message', type: 'string', label: 'Supplier message' },
            { name: 'reminders_enabled', type: 'boolean', control_type: 'checkbox', label: 'Reminders enabled' },
            { name: 'has_seeded_data', type: 'boolean', control_type: 'checkbox', label: 'Has seeded data' },
            { name: 'submission_attempt', type: 'integer', label: 'Submission attempt' },
            { name: 'last_reminder_tier', type: 'integer', label: 'Last reminder tier' },
            { name: 'template_path', type: 'string', label: 'Template path' }
          ] },
          { name: 'supplier_user_id', type: 'string', label: 'Supplier user ID' },
          { name: 'supplier_request_id', type: 'string', label: 'Supplier request ID' },
          { name: 'assignee_email', type: 'string', label: 'Assignee email' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          'ok' => true, 'error' => { 'code' => '', 'message' => '' },
          'supplier_user_row' => { 'supplier_user_id' => '6f1c...', 'supplier_id' => 'sup-1', 'user_email' => 'a@acme.example', 'contact_name' => 'A',
                                   'primary' => true, 'status' => 'active', 'created_at' => '2026-09-10T18:00:00Z' },
          'supplier_request_row' => { 'supplier_request_id' => '9b2e...', 'supplier_id' => 'sup-1', 'assigned_version_id' => 'ver-3', 'assigned_variant_id' => 'var-1',
                                      'assignee_email' => 'a@acme.example', 'status' => 'pending', 'current_state_entered_at' => '2026-09-10T18:00:00Z',
                                      'supplier_display_status' => 'Not yet sent', 'supplier_message' => '', 'reminders_enabled' => true, 'has_seeded_data' => false,
                                      'submission_attempt' => 0, 'last_reminder_tier' => 0, 'template_path' => 'templates/v3/base.xlsx' },
          'supplier_user_id' => '6f1c...', 'supplier_request_id' => '9b2e...', 'assignee_email' => 'a@acme.example'
        }
      end
    },

    # ---- MIG-01 -----------------------------------------------------------------------------------------------------
    plan_user_migration: {
      title: 'Plan request migration',
      subtitle: 'Partition open requests into to_migrate, held and flagged for a new template version',
      help: lambda do |_input, _picklist_label|
        {
          body: 'Replaces the MIG-01 Python step. Variant mapping is by name (variant ids are minted fresh every build). ' \
                'Terminal requests are skipped; pending_review and supplier_action_required are held; seeded requests are flagged unless this ' \
                'run re-seeds; anything name-matching cannot resolve unambiguously is flagged, never guessed.'
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: 'template_version_id', type: 'string', optional: false, label: 'New template version ID' },
          call(:toggleable_boolean, 'will_reseed', 'This run re-seeds', 'true when INC-01 runs after this step'),
          { name: 'requests', type: 'array', of: 'object', optional: true, label: 'Requests', properties: object_definitions['supplier_request'] },
          { name: 'variants', type: 'array', of: 'object', optional: true, label: 'Variants (all versions)', properties: object_definitions['variant'] },
          { name: 'suppliers', type: 'array', of: 'object', optional: true, label: 'Suppliers', properties: object_definitions['supplier'] }
        ]
      end,

      execute: lambda do |_connection, input|
        terminal = %w[approved cancelled]
        hold = %w[pending_review supplier_action_required]
        blank = { 'to_migrate' => [], 'held' => [], 'flagged' => [], 'migrate_count' => 0, 'held_count' => 0, 'flagged_count' => 0 }

        new_version_id = call(:clean, input['template_version_id'])
        next call(:fail, 'recipe_invariant', 'template_version_id is empty', blank) if new_version_id.empty?
        will_reseed = call(:to_bool, input['will_reseed'])
        requests = call(:rows, input['requests'])
        variants = call(:rows, input['variants'])
        suppliers = call(:rows, input['suppliers'])

        name_by_variant_id = {}
        new_by_name = {}
        dup_new_names = {}
        variants.each do |v|
          vid = call(:clean, v['variant_id'])
          vname = call(:clean, v['variant_name'])
          vversion = call(:clean, v['template_version_id'])
          next if vid.empty?
          name_by_variant_id[vid] = vname unless vname.empty?
          next unless vversion == new_version_id && !vname.empty?
          if new_by_name.key?(vname)
            dup_new_names[vname] = true
          else
            new_by_name[vname] = { 'variant_id' => vid, 'template_path' => call(:clean, v['template_path']) }
          end
        end
        if new_by_name.empty?
          next call(:fail, 'state_inconsistent',
                    "no variants found for version '#{new_version_id}' -- run MIG-01 after PRV-03/04 have created and published the new version's variants",
                    blank)
        end

        supplier_name_by_id = {}
        suppliers.each do |s|
          sid = call(:clean, s['supplier_id'])
          supplier_name_by_id[sid] = call(:clean, s['supplier_name']) unless sid.empty?
        end

        to_migrate = []
        held = []
        flagged = []
        requests.each do |r|
          base = {
            'record_id' => call(:clean, r['record_id']),
            'supplier_request_id' => call(:clean, r['supplier_request_id']),
            'supplier_id' => call(:clean, r['supplier_id']),
            'supplier_name' => '',
            'status' => call(:norm, r['status']),
            'old_version_id' => call(:clean, r['assigned_version_id']),
            'old_variant_id' => call(:clean, r['assigned_variant_id']),
            'new_variant_id' => '',
            'new_template_path' => '',
            'reason' => ''
          }
          base['supplier_name'] = supplier_name_by_id[base['supplier_id']] || ''

          next if base['old_version_id'] == new_version_id
          next if terminal.include?(base['status'])
          if hold.include?(base['status'])
            base['reason'] = 'mid-review; completes its cycle on the old version'
            held << base
            next
          end
          if call(:to_bool, r['has_seeded_data']) && !will_reseed
            base['reason'] = 'seeded request but this run has no seed data; re-run provisioning with the seed file, or migrate manually'
            flagged << base
            next
          end
          old_name = name_by_variant_id[base['old_variant_id']]
          if old_name.nil? || old_name.empty?
            base['reason'] = "old variant '#{base['old_variant_id'].empty? ? '<blank>' : base['old_variant_id']}' not found; cannot resolve its name"
            flagged << base
            next
          end
          if dup_new_names[old_name]
            base['reason'] = "variant name '#{old_name}' is duplicated in the new version"
            flagged << base
            next
          end
          target = new_by_name[old_name]
          if target.nil?
            base['reason'] = "no variant named '#{old_name}' in the new version; analyst must re-pick"
            flagged << base
            next
          end
          path = target['template_path']
          if path.empty? || path.downcase == 'tbd'
            base['reason'] = "new variant '#{old_name}' has no resolved template path; republish the version"
            flagged << base
            next
          end
          base['new_variant_id'] = target['variant_id']
          base['new_template_path'] = path
          to_migrate << base
        end

        call(:ok,
             'to_migrate' => to_migrate, 'held' => held, 'flagged' => flagged,
             'migrate_count' => to_migrate.length, 'held_count' => held.length, 'flagged_count' => flagged.length)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['result_envelope'] + [
          { name: 'to_migrate', type: 'array', of: 'object', label: 'To migrate', properties: object_definitions['migration_row'] },
          { name: 'held', type: 'array', of: 'object', label: 'Held', properties: object_definitions['migration_row'] },
          { name: 'flagged', type: 'array', of: 'object', label: 'Flagged', properties: object_definitions['migration_row'] },
          { name: 'migrate_count', type: 'integer', label: 'Migrate count' },
          { name: 'held_count', type: 'integer', label: 'Held count' },
          { name: 'flagged_count', type: 'integer', label: 'Flagged count' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          'ok' => true, 'error' => { 'code' => '', 'message' => '' },
          'to_migrate' => [{ 'record_id' => '1', 'supplier_request_id' => 'req-1', 'supplier_id' => 'sup-1', 'supplier_name' => 'Acme', 'status' => 'sent',
                             'old_version_id' => 'ver-2', 'old_variant_id' => 'var-a', 'new_variant_id' => 'var-a2', 'new_template_path' => 'templates/v3/base.xlsx', 'reason' => '' }],
          'held' => [], 'flagged' => [], 'migrate_count' => 1, 'held_count' => 0, 'flagged_count' => 0
        }
      end
    }
  }
}
