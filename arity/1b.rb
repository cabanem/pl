# EXPERIMENT 1b — bisect_1 with nil api_call opts replaced by {} (call() still in input_fields)
# ================================================
# Full CRUD connector for Workato Data Tables.
# Covers table management, record operations, batch operations,
# workspace navigation, and a polling trigger.
# Supports all six Workato regions via a single connection.
#
# Author: emily.cabaniss@randstadsourceright.com
# Spec:   workato_data_tables_connector_spec.yaml v1.5
#
# v1.6.0 — foundation refactor (no new actions)
# ---------------------------------------------
# Goal: one owner per concern, so the query builder (v1.6.1) plugs in
# without copying code. Action set is unchanged.
#
#   api_call            one place that sends a request and formats errors
#   run_query           one place that calls POST /tables/:id/query
#   records_from_query  reads the query response (columnar schema+data)
#   record_from_document reads create/update responses (document triplets)
#   column_key          one identifier for a column, used everywhere
#   table_schema        one fetch of a table's schema
#   record_fields_for   dynamic record schema for ANY table id
#   filter_block        the filter input block, reusable per hop
#   list_all            paginates Developer API lists for pick lists
#
# Behaviour changes (all driven by the Records API docs):
#   - Query response is read as columnar {schema, data} and turned into
#     hashes keyed by column NAME plus $record_id/$created_at/$updated_at.
#     A legacy {records:[...]} shape is still accepted.
#   - Create/update send {"document": {...}} and read data.document.
#   - order uses "direction" (was "order"). limit clamps to 200.
#   - Retries on 429 are declared at action level (retry_on_response);
#     the five hand-rolled rescue blocks are gone.
#   - Dynamic record fields are keyed by column name (were field_id||name).
#     Pick lists already used name; the two now agree.
#   - Relation columns are typed as object {record_id, value}.
#   - Pick lists read every page (were page 1 only) and sort by name.
#   - Trigger: type :paging_desc removed (poll is ascending), $gte cursor.
#   - Batch actions cap at MAX_BATCH items with a clear error.

{
  title: 'Workato Data Tables API',

  # --- CONNECTION --------------------------------------------------
  connection: {
    fields: [
      {
        name: 'environment',
        label: 'Environment',
        control_type: 'select',
        optional: false,
        default: 'app.eu',
        pick_list: [
          ['US (www.workato.com)',       'www'],
          ['EU (app.eu.workato.com)',    'app.eu'],
          ['JP (app.jp.workato.com)',    'app.jp'],
          ['SG (app.sg.workato.com)',    'app.sg'],
          ['AU (app.au.workato.com)',    'app.au'],
          ['IL (app.il.workato.com)',    'app.il']
        ],
        hint: 'Select the Workato data center region your workspace ' \
              'is hosted in. Check your browser URL bar — the subdomain ' \
              'before .workato.com tells you the region.'
      },
      {
        name: 'api_token',
        label: 'API Token',
        control_type: 'password',
        optional: false,
        hint: 'Bearer token from an API client in this workspace. ' \
              'Navigate to Settings → API clients → Access tokens to ' \
              'generate one. The token must have Data Tables scopes for ' \
              'record and table operations, and Projects & folders scope ' \
              'for workspace navigation.'
      }
    ],

    authorization: {
      type: 'custom_auth',

      apply: lambda do |connection|
        headers(
          'Authorization' => "Bearer #{connection['api_token']}",
          'Accept' => 'application/json'
        )
      end
    },

    base_uri: lambda do |connection|
      "https://#{connection['environment']}.workato.com"
    end
  },

  test: lambda do |_connection|
    user_access = true
    tables_access = true

    user = get('/api/users/me').after_error_response(/.*/) do |code, body, headers, _message|
      if code.to_i == 403
        user_access = false
        nil
      else
        error(call(:error_context, 'test/users_me', code, body, headers))
      end
    end

    get('/api/data_tables').params(page: 1, per_page: 1).after_error_response(/.*/) do |code, body, headers, _message|
      if code.to_i == 403
        tables_access = false
        nil
      else
        error(call(:error_context, 'test/data_tables', code, body, headers))
      end
    end

    if !user_access && !tables_access
      error('Connected, but this API client has no access to ' \
            'Users or Data Tables. Check API client scopes.')
    end

    account_name = user && (user['name'] || user['email'] || user['id'].to_s)

    {
      user_access: user_access,
      tables_access: tables_access,
      account_name: account_name || 'Unknown'
    }
  end,

  # --- METHODS -----------------------------------------------------
  methods: {

    # ── Limits (inlined; the SDK has no shared constant scope) ──────
    #   query limit  200  Records API ceiling per docs
    #   batch size   200  sequential calls per action (rate limit 60/min)
    #   pages         25  safety cap for run_query_all / list_all

    # ── Hosts ──────────────────────────────────────────────────────
    records_base: lambda do |connection|
      env = connection['environment']
      suffix = case env
               when 'www'    then ''
               when 'app.eu' then '.eu'
               when 'app.jp' then '.jp'
               when 'app.sg' then '.sg'
               when 'app.au' then '.au'
               when 'app.il' then '.il'
               else '.eu'
               end
      "https://data-tables#{suffix}.workato.com"
    end,

    records_url: lambda do |connection, table_id, tail|
      "#{call(:records_base, connection)}/api/v1/tables/#{table_id}#{tail}"
    end,

    # ── Errors ─────────────────────────────────────────────────────
    # One string format everywhere. Takes the values after_error_response
    # hands us, so code and correlation id are real, not guessed.
    error_context: lambda do |label, code, body, headers|
      cid = begin
              (headers || {})['x-correlation-id'] || (headers || {})['X-Correlation-Id'] || 'n/a'
            rescue
              'n/a'
            end
      text = body.to_s[0, 300]
      "#{label} | HTTP #{code || 'unknown'} | cid=#{cid} | #{text}"
    end,

    # ── Requests ───────────────────────────────────────────────────
    # The single place a request is sent. Every action goes through here
    # unless it needs per-item failure capture (batch actions).
    #   verb: :get | :post | :put | :delete
    #   opts: { 'payload' => {...}, 'params' => {...} }
    api_call: lambda do |verb, url, opts, label|
      opts = opts || {}
      req = case verb
            when :get    then get(url)
            when :post   then post(url)
            when :put    then put(url)
            when :delete then delete(url)
            else error("api_call: unknown verb #{verb}")
            end
      req = req.params(opts['params'])   if opts['params'].present?
      req = req.payload(opts['payload']) if opts.key?('payload')
      req.after_error_response(/.*/) do |code, body, headers, _message|
        error(call(:error_context, label, code, body, headers))
      end
    end,

    # Read every page of a Developer API list endpoint (tables, folders, projects).
    # Bounded iteration: the SDK does not allow while/until/loop.
    list_all: lambda do |path, per_page, label|
      out = []
      (1..25).each do |page|
        resp = call(:api_call, :get, path,
                    { 'params' => { page: page, per_page: per_page } }, label)
        chunk = call(:normalize_response, resp, :array)
        out = out + chunk
        break if chunk.length < per_page
      end
      out
    end,

    # ── Coercion (unchanged from v1.5 except the nil-safe boolean) ──
    # CRITICAL: Never use Array(value) — it calls .to_a on Hash-like
    # wrappers and produces [key, value] pairs. Use .to_ary or [value].
    coerce: lambda do |value, target_type|
      case target_type
      when :array
        if value.nil? || (value.respond_to?(:blank?) && value.blank?)
          []
        elsif value.respond_to?(:keys)
          if value.keys.all? { |k| k.to_s =~ /\A\d+\z/ }
            value.values
          else
            [value]
          end
        elsif value.respond_to?(:to_ary)
          value.to_ary
        else
          [value]
        end
      when :hash
        if value.nil? || !value.respond_to?(:keys) ||
           (value.respond_to?(:blank?) && value.blank?)
          nil
        else
          value
        end
      when :integer
        if value.nil? || (value.respond_to?(:blank?) && value.blank?)
          nil
        else
          value.to_i
        end
      when :boolean
        if value.nil? || (value.respond_to?(:blank?) && value.blank?)
          false
        else
          value.is_true?
        end
      when :string
        if value.nil? || (value.respond_to?(:blank?) && value.blank?)
          nil
        else
          value.to_s
        end
      else
        value
      end
    end,

    # Safely extract a key from any response-like object.
    unwrap_envelope: lambda do |response, key|
      begin
        val = response[key]
        val.nil? ? response : val
      rescue
        response
      end
    end,

    # Developer API envelopes ({data: {...}} or {data: [...]}).
    # Records API responses use records_from_query / record_from_document.
    normalize_response: lambda do |response, mode|
      case mode
      when :single
        call(:unwrap_envelope, response, 'data')
      when :array
        raw = begin
                val = response['data']
                val.nil? ? [] : val
              rescue
                response
              end
        call(:coerce, raw, :array)
      else
        response
      end
    end,

    # ── Records API readers ────────────────────────────────────────
    # Query response per docs:
    #   { "schema": [[{name:"$record_id"},...], [{name:"Col", id:"uuid"},...]],
    #     "data":   [[[rid, created, updated], [v1, v2, ...]], ...],
    #     "count": n, "limit": l, "continuation_token": "..."? }
    # We zip schema names with row values → one hash per record, keyed by
    # column name. Relation values stay {record_id, value}; multivalue stays
    # an array. A legacy {records: [...]} shape passes through unchanged.
    records_from_query: lambda do |response|
      schema = begin; response['schema']; rescue; nil; end
      data   = begin; response['data'];   rescue; nil; end

      if schema.present? && !data.nil?
        names = call(:coerce, schema, :array)
                  .map { |group| call(:coerce, group, :array) }
                  .flatten(1)
                  .map { |col| col.respond_to?(:keys) ? col['name'] : col.to_s }
        call(:coerce, data, :array).map do |row|
          values = call(:coerce, row, :array)
                     .map { |group| call(:coerce, group, :array) }
                     .flatten(1)
          rec = {}
          names.each_with_index { |name, idx| rec[name] = values[idx] }
          rec
        end
      else
        legacy = begin; response['records']; rescue; nil; end
        call(:coerce, legacy, :array)
      end
    end,

    # Create/update response per docs:
    #   { "data": { "record_id", "created_at", "updated_at",
    #               "document": [ {field_id, field_name, value}, ... ] } }
    # Flattened to the same shape records_from_query produces, so the
    # output datatree is identical across query/create/update.
    record_from_document: lambda do |response|
      data = call(:unwrap_envelope, response, 'data')
      doc  = begin; data['document']; rescue; nil; end
      return data unless doc.present?

      base = {
        '$record_id'  => data['record_id'],
        '$created_at' => data['created_at'],
        '$updated_at' => data['updated_at']
      }
      fields = call(:coerce, doc, :array).each_with_object({}) do |f, h|
        next unless f.respond_to?(:keys)
        h[f['field_name'] || f['field_id']] = f['value']
      end
      base.merge(fields)
    end,

    # ── Query building ─────────────────────────────────────────────
    # Build $-operator where clause from the UI filter structure.
    build_where: lambda do |filters|
      return nil if filters.blank?

      operator = (filters['operator'] || 'and').downcase
      conditions = filters['conditions']
      return nil if conditions.blank?

      op_map = {
        'eq' => '$eq', 'ne' => '$ne',
        'gt' => '$gt', 'lt' => '$lt',
        'gte' => '$gte', 'lte' => '$lte',
        'in' => '$in', 'starts_with' => '$starts_with',
        'equals' => '$eq', 'not equals' => '$ne',
        'greater than' => '$gt', 'less than' => '$lt',
        'greater or equal' => '$gte', 'less or equal' => '$lte',
        'in list' => '$in', 'starts with' => '$starts_with'
      }

      built = call(:coerce, conditions, :array).map do |cond|
        next nil unless cond.respond_to?(:keys)
        next nil if cond['column'].blank? || cond['operator'].blank?

        api_op = op_map[cond['operator'].downcase] || "$#{cond['operator'].downcase}"
        val = cond['value']

        if api_op == '$in'
          # $in needs an array. Accept an array, or a comma-separated string.
          val = if val.respond_to?(:to_ary)
                  val.to_ary
                else
                  val.to_s.split(',').map(&:strip).reject(&:empty?)
                end
        elsif %w[$eq $starts_with].include?(api_op) && cond.key?('case_sensitive')
          val = { 'value' => val, 'case_sensitive' => call(:coerce, cond['case_sensitive'], :boolean) }
        end

        { cond['column'] => { api_op => val } }
      end.compact

      return nil if built.empty?
      return built.first if built.length == 1

      { "$#{operator}" => built }
    end,

    # Build the order clause. API key is "direction", not "order".
    build_order: lambda do |order_input|
      return nil unless order_input.respond_to?(:keys) && order_input['column'].present?
      {
        by: order_input['column'],
        direction: (order_input['order'] || order_input['direction'] || 'asc').to_s.downcase,
        case_sensitive: call(:coerce, order_input['case_sensitive'], :boolean)
      }
    end,

    # ── run_query: THE query call ──────────────────────────────────
    # One page. Returns { 'records' => [...], 'continuation_token' => tok }.
    #   opts: 'select', 'order' (built), 'limit', 'continuation_token',
    #         'timezone_offset_secs', 'label'
    run_query: lambda do |connection, table_id, where, opts|
      opts  = opts || {}
      limit = call(:coerce, opts['limit'], :integer) || 100
      limit = [[limit, 1].max, 200].min

      body = {
        select: opts['select'].present? ? call(:coerce, opts['select'], :array) : nil,
        where:  where,
        order:  opts['order'],
        limit:  limit,
        continuation_token: opts['continuation_token'].presence,
        timezone_offset_secs: call(:coerce, opts['timezone_offset_secs'], :integer)
      }.compact

      response = call(:api_call, :post,
                      call(:records_url, connection, table_id, '/query'),
                      { 'payload' => body },
                      opts['label'] || "query[#{table_id}]")

      token = begin
                response['continuation_token'] || response['next_page_token']
              rescue
                nil
              end

      { 'records' => call(:records_from_query, response), 'continuation_token' => token }
    end,

    # All pages, bounded. Used by the builder (v1.6.1) and anywhere a full
    # result set is needed. Returns a plain Array.
    run_query_all: lambda do |connection, table_id, where, opts|
      opts  = (opts || {}).merge('continuation_token' => nil)
      pages = [[call(:coerce, opts['max_pages'], :integer) || 10, 1].max, 25].min
      out   = []
      (1..pages).each do |_page|
        result = call(:run_query, connection, table_id, where, opts)
        out = out + result['records']
        token = result['continuation_token']
        break if token.blank?
        opts = opts.merge('continuation_token' => token)
      end
      out
    end,

    # Split a value list into $in-sized chunks. Ceiling is undocumented;
    # 100 is a conservative default until measured.
    chunk_values: lambda do |values, size|
      call(:coerce, values, :array).compact.uniq.each_slice(size || 100).to_a
    end,

    # ── Schema ─────────────────────────────────────────────────────
    # THE column identifier. The Records API accepts names or $field_id in
    # where/select; query responses carry names. We use names everywhere.
    column_key: lambda do |col|
      col.respond_to?(:keys) ? col['name'] : col.to_s
    end,

    # One fetch of a table's column list.
    table_schema: lambda do |_connection, table_id|
      return [] if table_id.blank?
      resp  = call(:api_call, :get, "/api/data_tables/#{table_id}", {}, "table_schema[#{table_id}]")
      table = call(:normalize_response, resp, :single)
      raw   = begin; table['schema']; rescue; []; end || []
      call(:coerce, raw, :array).select { |c| c.respond_to?(:keys) }
    end,

    # Normalize schema column inputs for create/update table.
    normalize_schema_input: lambda do |raw_schema|
      cols = call(:coerce, raw_schema, :array)
      cols.map do |col|
        col = col.respond_to?(:keys) ? col : {}
        col['relation']   = call(:coerce, col['relation'], :hash)
        col['optional']   = call(:coerce, col['optional'], :boolean)
        if col.key?('multivalue')
          col['multivalue'] = call(:coerce, col['multivalue'], :boolean)
        end
        col.compact
      end
    end,

    # Dynamic record fields for ANY table id. This is what the builder
    # calls once per hop; dynamic_record is a thin wrapper over it.
    #   all_optional: true for update forms
    #   with_meta:    include $record_id/$created_at/$updated_at
    record_fields_for: lambda do |connection, table_id, all_optional, with_meta|
      meta = with_meta ? [
        { name: '$record_id',  type: 'string',    label: 'Record ID' },
        { name: '$created_at', type: 'date_time', label: 'Created At' },
        { name: '$updated_at', type: 'date_time', label: 'Updated At' }
      ] : []
      return meta if table_id.blank?

      type_map = {
        'string'    => 'string',
        'integer'   => 'integer',
        'number'    => 'number',
        'boolean'   => 'boolean',
        'date'      => 'date',
        'date_time' => 'date_time'
      }

      cols = call(:table_schema, connection, table_id).map do |col|
        key   = call(:column_key, col)
        label = key.to_s.gsub('_', ' ').split.map(&:capitalize).join(' ')
        is_optional = all_optional ? true : (col['optional'] != false)
        field = { name: key, label: label, optional: is_optional, hint: col['hint'] }

        typed = if col['type'] == 'relation'
                  field.merge(type: 'object', properties: [
                    { name: 'record_id', type: 'string', label: 'Related Record ID' },
                    { name: 'value',     type: 'string', label: 'Related Value' }
                  ])
                elsif col['type'] == 'file'
                  field.merge(type: 'object')
                else
                  field.merge(type: type_map[col['type']] || 'string')
                end
        typed.compact
      end

      meta + cols
    end,

    # The filter input block, as one reusable fragment.
    filter_block: lambda do |name, label|
      {
        name: name, label: label, type: 'object', optional: true,
        properties: [
          {
            name: 'operator', control_type: 'select', optional: true,
            default: 'and', pick_list: [%w[AND and], %w[OR or]],
            hint: 'Combine conditions with AND or OR.'
          },
          {
            name: 'conditions', type: 'array', of: 'object', optional: true,
            properties: [
              { name: 'column', type: 'string', hint: 'Column name to filter on.' },
              {
                name: 'operator', control_type: 'select',
                pick_list: [
                  %w[Equals eq], ['Not equals', 'ne'],
                  ['Greater than', 'gt'], ['Less than', 'lt'],
                  ['Greater or equal', 'gte'], ['Less or equal', 'lte'],
                  ['In list', 'in'], ['Starts with', 'starts_with']
                ]
              },
              { name: 'value', type: 'string',
                hint: 'For "In list", separate values with commas.' },
              { name: 'case_sensitive', type: 'boolean', optional: true,
                hint: 'Applies to Equals and Starts with.' }
            ]
          }
        ]
      }
    end,

    # Shared "pick a table" field (select + toggle to raw ID).
    table_select_field: lambda do |hint|
      {
        name: 'table_id', label: 'Table', optional: false,
        control_type: 'select', pick_list: 'tables',
        toggle_hint: 'Select from list',
        toggle_field: {
          name: 'table_id', label: 'Table ID', type: 'string',
          control_type: 'text', optional: false,
          toggle_hint: 'Enter table ID', hint: 'Enter the table ID directly.'
        },
        hint: hint
      }
    end
  },

  # --- OBJECT DEFINITIONS ------------------------------------------
  object_definitions: {

    table: {
      fields: lambda do |_connection, _config_fields|
        [
          { name: 'id',          type: 'string',    label: 'Table ID' },
          { name: 'name',        type: 'string',    label: 'Table Name' },
          { name: 'description', type: 'string',    label: 'Description' },
          { name: 'folder_id',   type: 'integer',   label: 'Folder ID' },
          { name: 'created_at',  type: 'date_time', label: 'Created At' },
          { name: 'updated_at',  type: 'date_time', label: 'Updated At' },
          {
            name: 'schema', type: 'array', of: 'object', label: 'Schema',
            properties: [
              { name: 'field_id',   type: 'string',  label: 'Field ID' },
              { name: 'name',       type: 'string',  label: 'Field Name' },
              { name: 'type',       type: 'string',  label: 'Data Type' },
              { name: 'optional',   type: 'boolean', label: 'Optional' },
              { name: 'hint',       type: 'string',  label: 'Hint' },
              { name: 'multivalue', type: 'boolean', label: 'Multi-value' },
              { name: 'metadata',   type: 'object',  label: 'Metadata' },
              {
                name: 'relation', type: 'object', label: 'Relation',
                properties: [
                  { name: 'table_id', type: 'string', label: 'Related Table ID' },
                  { name: 'field_id', type: 'string', label: 'Related Field ID' }
                ]
              }
            ]
          }
        ]
      end
    },

    schema_column_input: {
      fields: lambda do |_connection, _config_fields|
        [
          { name: 'name', type: 'string', optional: false,
            hint: 'Column name (snake_case recommended).' },
          {
            name: 'type', optional: false, control_type: 'select',
            pick_list: [
              %w[String string], %w[Integer integer],
              ['Number (decimal)', 'number'],
              %w[Boolean boolean], %w[Date date],
              %w[Datetime date_time], %w[File file],
              %w[Relation relation]
            ],
            hint: 'Select or map the column data type.',
            toggle_hint: 'Select from list',
            toggle_field: {
              name: 'type', label: 'Data Type', type: 'string',
              control_type: 'text', optional: false,
              toggle_hint: 'Enter custom value',
              hint: 'Enter the column data type as text.'
            }
          },
          { name: 'optional', type: 'boolean', optional: true, default: 'true',
            hint: 'Whether this column allows empty values.' },
          { name: 'hint', type: 'string', optional: true,
            hint: 'Tooltip text shown to users entering data.' },
          { name: 'default_value', type: 'string', optional: true,
            hint: 'Default value for new records.' },
          { name: 'multivalue', type: 'boolean', optional: true,
            hint: 'Allow multiple values in this column.' },
          {
            name: 'relation', type: 'object', optional: true,
            hint: "Required when type is 'Relation'.",
            properties: [
              { name: 'table_id', type: 'string', hint: 'UUID of the related table.' },
              { name: 'field_id', type: 'string', hint: 'Field ID in the related table.' }
            ]
          }
        ]
      end
    },

    folder: {
      fields: lambda do |_connection, _config_fields|
        [
          { name: 'id',         type: 'string',    label: 'Folder ID' },
          { name: 'name',       type: 'string',    label: 'Folder Name' },
          { name: 'parent_id',  type: 'string',    label: 'Parent Folder ID' },
          { name: 'created_at', type: 'date_time', label: 'Created At' },
          { name: 'updated_at', type: 'date_time', label: 'Updated At' }
        ]
      end
    },

    project: {
      fields: lambda do |_connection, _config_fields|
        [
          { name: 'id',          type: 'string', label: 'Project ID' },
          { name: 'name',        type: 'string', label: 'Project Name' },
          { name: 'description', type: 'string', label: 'Description' },
          { name: 'folder_id',   type: 'string', label: 'Folder ID' }
        ]
      end
    },

    # Thin wrappers. The worker is record_fields_for, which takes any
    # table id — that is what the builder will call per hop.
    dynamic_record: {
      fields: lambda do |connection, config_fields|
        call(:record_fields_for, connection, config_fields&.dig('table_id'), false, true)
      end
    },

    dynamic_record_input: {
      fields: lambda do |connection, config_fields|
        call(:record_fields_for, connection, config_fields&.dig('table_id'), false, false)
      end
    },

    dynamic_record_update: {
      fields: lambda do |connection, config_fields|
        call(:record_fields_for, connection, config_fields&.dig('table_id'), true, false)
      end
    },

    batch_result: {
      fields: lambda do |_connection, _config_fields|
        [
          { name: 'success_count', type: 'integer', label: 'Succeeded' },
          { name: 'error_count',   type: 'integer', label: 'Failed' },
          { name: 'results', type: 'array', of: 'object', label: 'Results' },
          {
            name: 'errors', type: 'array', of: 'object', label: 'Errors',
            properties: [
              { name: 'index',     type: 'integer', label: 'Item Index' },
              { name: 'record_id', type: 'string',  label: 'Record ID' },
              { name: 'http_code', type: 'integer', label: 'HTTP Code' },
              { name: 'message',   type: 'string',  label: 'Error Message' }
            ]
          }
        ]
      end
    }
  },

  # --- PICK LISTS --------------------------------------------------
  pick_lists: {

    tables: lambda do |_connection|
      call(:list_all, '/api/data_tables', 100, 'pick_list/tables')
        .select { |t| t.respond_to?(:keys) }
        .map { |t| [t['name'], t['id']] }
        .sort_by { |name, _id| name.to_s.downcase }
    end,

    # Dependent pick list: pick_list_params: { table_id: '<field name>' }.
    # $record_id first so a builder key column can be the row ID.
    table_columns: lambda do |connection, table_id:|
      cols = call(:table_schema, connection, table_id)
               .map { |col| [call(:column_key, col), call(:column_key, col)] }
      [['$record_id (row ID)', '$record_id']] + cols
    end,

    folders: lambda do |_connection|
      call(:list_all, '/api/folders', 100, 'pick_list/folders')
        .select { |f| f.respond_to?(:keys) }
        .map { |f| [f['name'] || f['id'].to_s, f['id']] }
        .sort_by { |name, _id| name.to_s.downcase }
    end,

    projects: lambda do |_connection|
      call(:list_all, '/api/projects', 100, 'pick_list/projects')
        .select { |p| p.respond_to?(:keys) }
        .map { |p| [p['name'] || p['id'].to_s, p['id']] }
        .sort_by { |name, _id| name.to_s.downcase }
    end
  },

  # --- ACTIONS -----------------------------------------------------
  actions: {
    # ── Table management (Developer API) ──────────────────────────

    list_tables: {
      title: 'List data tables',
      subtitle: 'List all data tables in this workspace',
      description: 'Returns all data tables visible to this API client. ' \
                   'Requires the Data Tables → List scope.',
      help: 'Returns a paginated list of data tables.',

      input_fields: lambda do |_object_definitions|
        [
          { name: 'page', type: 'integer', optional: true, default: '1',
            hint: 'Page number for pagination.' },
          { name: 'per_page', type: 'integer', optional: true, default: '100',
            hint: 'Results per page. Maximum 100.' }
        ]
      end,

      execute: lambda do |_connection, input|
        page = call(:coerce, input['page'], :integer) || 1
        per_page = call(:coerce, input['per_page'], :integer) || 100
        per_page = [[per_page, 1].max, 100].min

        resp = call(:api_call, :get, '/api/data_tables',
                    { 'params' => { page: page, per_page: per_page } }, 'list_tables')
        { 'data' => call(:normalize_response, resp, :array) }
      end,

      output_fields: lambda do |object_definitions|
        [{ name: 'data', type: 'array', of: 'object', label: 'Tables',
           properties: object_definitions['table'] }]
      end
    },

    get_table: {
      title: 'Get data table',
      subtitle: 'Get a single data table by ID',
      description: "Retrieve a single table's metadata and full column schema by ID.",

      input_fields: lambda do |_object_definitions|
        [call(:table_select_field, 'Select or map the table to retrieve.')]
      end,

      execute: lambda do |_connection, input|
        resp = call(:api_call, :get, "/api/data_tables/#{input['table_id']}", {}, 'get_table')
        call(:normalize_response, resp, :single)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['table']
      end
    },

    create_table: {
      title: 'Create data table',
      subtitle: 'Create a new data table with schema',
      description: 'Create a new data table with the specified schema. ' \
                   'Requires Data Tables → Create scope.',

      input_fields: lambda do |object_definitions|
        [
          { name: 'name', type: 'string', optional: false,
            hint: 'Display name for the new table.' },
          {
            name: 'folder_id', label: 'Folder', type: 'integer', optional: false,
            control_type: 'select', pick_list: 'folders',
            toggle_hint: 'Select from list',
            toggle_field: {
              name: 'folder_id', label: 'Folder ID', type: 'string',
              control_type: 'text', optional: false,
              toggle_hint: 'Enter folder ID', hint: 'Enter the folder ID directly.'
            },
            hint: 'Folder to create the table in.'
          },
          { name: 'schema', type: 'array', of: 'object', optional: false,
            label: 'Columns', properties: object_definitions['schema_column_input'] }
        ]
      end,

      execute: lambda do |_connection, input|
        payload = {
          name: input['name'],
          folder_id: call(:coerce, input['folder_id'], :integer),
          schema: call(:normalize_schema_input, input['schema'])
        }
        resp = call(:api_call, :post, '/api/data_tables', { 'payload' => payload }, 'create_table')
        call(:normalize_response, resp, :single)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['table']
      end
    },

    update_table: {
      title: 'Update data table',
      subtitle: 'Rename, move, or modify schema',
      description: 'Rename, move, or modify the schema of an existing table. ' \
                   'Supply only the fields you want to change. ' \
                   'WARNING: the schema field is a full replacement — ' \
                   'include ALL columns, not just changes.',

      input_fields: lambda do |object_definitions|
        [
          call(:table_select_field, 'The table to update.'),
          { name: 'name', type: 'string', optional: true,
            hint: 'New display name. Leave blank to keep current.' },
          {
            name: 'folder_id', label: 'Folder', type: 'integer', optional: true,
            control_type: 'select', pick_list: 'folders',
            toggle_hint: 'Select from list',
            toggle_field: {
              name: 'folder_id', label: 'Folder ID', type: 'string',
              control_type: 'text', optional: true, toggle_hint: 'Enter folder ID'
            },
            hint: 'Move to this folder. Leave blank to keep current.'
          },
          { name: 'schema', type: 'array', of: 'object', optional: true,
            label: 'Schema changes',
            hint: 'Full replacement schema — include all columns, not just changes.',
            properties: object_definitions['schema_column_input'] }
        ]
      end,

      execute: lambda do |_connection, input|
        payload = {}
        payload[:name] = input['name'] if input['name'].present?
        payload[:folder_id] = call(:coerce, input['folder_id'], :integer) if input['folder_id'].present?
        payload[:schema] = call(:normalize_schema_input, input['schema']) if input['schema'].present?
        error('Nothing to update.') if payload.empty?

        resp = call(:api_call, :put, "/api/data_tables/#{input['table_id']}",
                    { 'payload' => payload }, 'update_table')
        call(:normalize_response, resp, :single)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['table']
      end
    },

    truncate_table: {
      title: 'Truncate data table',
      subtitle: 'Delete all records, keep schema',
      description: 'Delete ALL records from a table while preserving its schema. ' \
                   'This is irreversible.',

      input_fields: lambda do |_object_definitions|
        [
          call(:table_select_field, 'The table to truncate.'),
          { name: 'confirm', type: 'boolean', optional: false,
            hint: 'Must be true to proceed — safety guard against accidental truncation.' }
        ]
      end,

      execute: lambda do |_connection, input|
        error('Confirm must be true to truncate.') unless call(:coerce, input['confirm'], :boolean)
        call(:api_call, :post, "/api/data_tables/#{input['table_id']}/truncate", {}, 'truncate_table')
        { success: true, truncated_at: now }
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'success',      type: 'boolean',   label: 'Success' },
          { name: 'truncated_at', type: 'date_time', label: 'Truncated At' }
        ]
      end
    },

    delete_table: {
      title: 'Delete data table',
      subtitle: 'Permanently delete a table and all records',
      description: 'Permanently delete a data table and all its records. ' \
                   'This is irreversible. Requires Data Tables → Delete scope.',

      input_fields: lambda do |_object_definitions|
        [
          call(:table_select_field, 'The table to delete.'),
          { name: 'confirm', type: 'boolean', optional: false,
            hint: 'Must be true to proceed — safety guard against accidental deletion.' }
        ]
      end,

      execute: lambda do |_connection, input|
        error('Confirm must be true to delete.') unless call(:coerce, input['confirm'], :boolean)
        call(:api_call, :delete, "/api/data_tables/#{input['table_id']}", {}, 'delete_table')
        { table_id: input['table_id'], success: true }
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'table_id', type: 'string',  label: 'Deleted Table ID' },
          { name: 'success',  type: 'boolean', label: 'Success' }
        ]
      end
    },

  },

  triggers: {}
}
