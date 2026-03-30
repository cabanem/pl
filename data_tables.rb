{
  title: "Workato Data Tables",

  # --- CONNECTION ---------------------------------------------------------------------
  connection: {
    fields: [
      {
        name: "environment",
        label: "Environment",
        control_type: "select",
        pick_list: [
          ["US (www.workato.com)",       "www"],
          ["EU (app.eu.workato.com)",    "app.eu"],
          ["JP (app.jp.workato.com)",    "app.jp"],
          ["SG (app.sg.workato.com)",    "app.sg"],
          ["AU (app.au.workato.com)",    "app.au"],
          ["IL (app.il.workato.com)",    "app.il"]
        ],
        default: "app.eu",
        optional: false,
        hint: "Select your Workato environment region"
      },
      {
        name: "api_token",
        label: "API Token",
        control_type: "password",
        optional: false,
        hint: "Workspace admin → Settings → API clients → Access tokens"
      }
    ],

    authorization: {
      type: "custom_auth",
      apply: lambda do |connection|
        headers(
          "Authorization" => "Bearer #{connection['api_token']}",
          "Accept"        => "application/json"
        )
      end
    },

    base_uri: lambda do |connection|
      "https://#{connection['environment']}.workato.com"
    end
  },

  # --- TEST ---------------------------------------------------------------------------
  test: lambda do |connection|
    # Both calls are soft — a Forbidden just means the scope is limited,
    # not that the connection is bad.
    user_access   = true
    tables_access = true
    account_name  = nil

    begin
      me = get("/api/users/me")
      account_name = me["name"] || me["email"] || me["id"].to_s
    rescue RestClient::Forbidden
      user_access = false
    end

    begin
      get("/api/data_tables").params(page: 1, per_page: 1)
    rescue RestClient::Forbidden
      tables_access = false
    end

    unless user_access || tables_access
      error("Connected, but this API client has no access to Users or " \
            "Data Tables. Grant at least one scope and retry.")
    end

    {
      user_access:   user_access,
      tables_access: tables_access,
      account_name:  account_name || "(limited scope)"
    }
  end,

  # --- METHODS ------------------------------------------------------------------------
  methods: {

    # ----------------------------------------------------------
    # records_base
    #
    # The Records API lives on a separate global host from the
    # Developer API. Regional mapping:
    #   US  → data-tables.workato.com
    #   EU  → data-tables.eu.workato.com
    #   JP  → data-tables.jp.workato.com   (verify in your env)
    #   SG  → data-tables.sg.workato.com   (verify in your env)
    #   AU  → data-tables.au.workato.com   (verify in your env)
    #   IL  → data-tables.il.workato.com   (verify in your env)
    #
    # If your region uses the global host for records, override
    # the mapping here.
    # ----------------------------------------------------------
    records_base: lambda do |connection|
      region_map = {
        "www"    => "",       # US — no subdomain prefix
        "app.eu" => ".eu",
        "app.jp" => ".jp",
        "app.sg" => ".sg",
        "app.au" => ".au",
        "app.il" => ".il"
      }
      suffix = region_map[connection["environment"]] || ""
      "https://data-tables#{suffix}.workato.com"
    end,

    # ----------------------------------------------------------
    # build_where
    #
    # Translates a UI-friendly filter structure into the $-operator
    # query body the Records API expects.
    #
    # Input shape:
    #   { "operator" => "and"|"or",
    #     "conditions" => [
    #       { "column" => "name", "operator" => "eq", "value" => "Acme",
    #         "case_sensitive" => false }
    #     ] }
    #
    # Returns nil when filters are blank (caller uses .compact).
    # ----------------------------------------------------------
    build_where: lambda do |filters|
      return nil unless filters.present?

      op_map = {
        "eq"          => "$eq",
        "ne"          => "$ne",
        "gt"          => "$gt",
        "lt"          => "$lt",
        "gte"         => "$gte",
        "lte"         => "$lte",
        "in"          => "$in",
        "starts_with" => "$starts_with"
      }

      conditions = (filters["conditions"] || []).map do |c|
        next nil unless c["column"].present? && c["operator"].present?
        oper = op_map[c["operator"]]
        next nil unless oper

        val = c["value"]
        # Wrap value with case_sensitive flag when the API supports it
        if c.key?("case_sensitive") && %w[eq starts_with].include?(c["operator"])
          val = { "value" => val, "case_sensitive" => !!c["case_sensitive"] }
        end

        { c["column"] => { oper => val } }
      end.compact

      return nil if conditions.empty?
      return conditions.first if conditions.length == 1

      joiner = (filters["operator"] || "and") == "or" ? "$or" : "$and"
      { joiner => conditions }
    end,

    # ----------------------------------------------------------
    # error_context
    #
    # Single helper for consistent error enrichment. Every rescue
    # block in the connector should route through this.
    #
    # Returns a formatted string; caller passes it to error().
    # ----------------------------------------------------------
    error_context: lambda do |label, exception|
      parts = [label]

      if exception.respond_to?(:http_code)
        parts << "HTTP #{exception.http_code}"
      end

      if exception.respond_to?(:response) && exception.response
        hdrs = exception.response.headers || {}
        cid  = hdrs["x-correlation-id"] || hdrs[:x_correlation_id]
        parts << "cid=#{cid}" if cid.present?

        body = exception.response.body.to_s
        parts << body[0, 300] if body.present?
      else
        parts << exception.message.to_s[0, 300]
      end

      parts.join(" | ")
    end
  }

  # --- PICK LISTS ---------------------------------------------------------------------
  pick_lists: {

    # Used by config_fields on every record action + table management actions
    tables: lambda do |_connection|
      response = get("/api/data_tables").params(page: 1, per_page: 100)
      (response["data"] || []).map { |t| [t["name"], t["id"]] }
    end,

    # Dynamic column list for a selected table — useful in filter UIs
    table_columns: lambda do |_connection, table_id:|
      return [] unless table_id.present?
      table = get("/api/data_tables/#{table_id}")
      cols  = table["schema"] || table.dig("data", "schema") || []
      cols.map { |col| [col["name"], col["name"]] }
    end,

    folders: lambda do |_connection|
      response = get("/api/folders").params(page: 1, per_page: 200)
      arr = response.is_a?(Array) ? response : (response["data"] || [])
      arr.map { |f| [f["name"] || f["id"].to_s, f["id"]] }
    end,

    projects: lambda do |_connection|
      response = get("/api/projects").params(page: 1, per_page: 200)
      arr = response.is_a?(Array) ? response : (response["data"] || [])
      arr.map { |p| [p["name"] || p["id"].to_s, p["id"]] }
    end
  },

  # --- OBJECT DEFINITIONS -------------------------------------------------------------
  object_definitions: {

    # ----------------------------------------------------------
    # table — full metadata shape from GET /api/data_tables/:id
    # ----------------------------------------------------------
    table: {
      fields: lambda do |_connection, _config_fields|
        [
          { name: "id",          type: "string",    label: "Table ID" },
          { name: "name",                           label: "Table Name" },
          { name: "description",                    label: "Description" },
          { name: "folder_id",   type: "integer",   label: "Folder ID" },
          { name: "created_at",  type: "timestamp", label: "Created At" },
          { name: "updated_at",  type: "timestamp", label: "Updated At" },
          { name: "schema", type: "array", of: "object", label: "Schema",
            properties: [
              { name: "field_id",   label: "Field ID" },
              { name: "name",       label: "Field Name" },
              { name: "type",       label: "Data Type" },
              { name: "optional",   type: "boolean", label: "Optional" },
              { name: "hint",       label: "Hint" },
              { name: "multivalue", type: "boolean", label: "Multi-value" },
              { name: "metadata",   type: "object",  label: "Metadata" },
              { name: "relation",   type: "object",  label: "Relation",
                properties: [
                  { name: "table_id", label: "Related Table ID" },
                  { name: "field_id", label: "Related Field ID" }
                ] }
            ] }
        ]
      end
    },

    # ----------------------------------------------------------
    # folder
    # ----------------------------------------------------------
    folder: {
      fields: lambda do |_connection, _config_fields|
        [
          { name: "id",         label: "Folder ID" },
          { name: "name",       label: "Folder Name" },
          { name: "parent_id",  label: "Parent Folder ID" },
          { name: "created_at", type: "timestamp", label: "Created At" },
          { name: "updated_at", type: "timestamp", label: "Updated At" }
        ]
      end
    },

    # ----------------------------------------------------------
    # project
    # ----------------------------------------------------------
    project: {
      fields: lambda do |_connection, _config_fields|
        [
          { name: "id",          label: "Project ID" },
          { name: "name",        label: "Project Name" },
          { name: "description", label: "Description" },
          { name: "folder_id",   label: "Folder ID" }
        ]
      end
    },

    # ----------------------------------------------------------
    # record_system_fields
    #
    # The three meta-fields the Records API returns on every
    # record, regardless of table schema. Used as the static
    # base that dynamic_record extends.
    # ----------------------------------------------------------
    record_system_fields: {
      fields: lambda do |_connection, _config_fields|
        [
          { name: "$record_id",  type: "string",    label: "Record ID" },
          { name: "$created_at", type: "timestamp",  label: "Created At" },
          { name: "$updated_at", type: "timestamp",  label: "Updated At" }
        ]
      end
    },

    # ----------------------------------------------------------
    # dynamic_record
    #
    # This is the key object definition for record actions.
    # It requires config_fields to supply table_id, then fetches
    # that table's schema and exposes every column as a typed
    # data pill alongside the system fields.
    #
    # Type mapping: Data Tables type → Workato field type
    #   string    → string
    #   integer   → integer
    #   number    → number
    #   boolean   → boolean
    #   date      → date
    #   date_time → date_time
    #   file      → object  (file reference)
    #   relation  → string  (related record ID)
    # ----------------------------------------------------------
    dynamic_record: {
      fields: lambda do |connection, config_fields|
        # System fields — always present
        base = [
          { name: "$record_id",  type: "string",    label: "Record ID" },
          { name: "$created_at", type: "timestamp",  label: "Created At" },
          { name: "$updated_at", type: "timestamp",  label: "Updated At" }
        ]

        table_id = config_fields["table_id"]
        return base unless table_id.present?

        # Fetch table schema
        table = get("/api/data_tables/#{table_id}")
        cols  = table["schema"] || table.dig("data", "schema") || []

        type_map = {
          "string"    => "string",
          "integer"   => "integer",
          "number"    => "number",
          "boolean"   => "boolean",
          "date"      => "date",
          "date_time" => "date_time",
          "file"      => "object",
          "relation"  => "string"
        }

        dynamic = cols.map do |col|
          {
            name:     col["name"],
            label:    (col["name"] || "").gsub("_", " ").split.map(&:capitalize).join(" "),
            type:     type_map[col["type"]] || "string",
            optional: col["optional"] != false
          }
        end

        base.concat(dynamic)
      end
    },

    # ----------------------------------------------------------
    # batch_result — standard shape for all batch actions
    # ----------------------------------------------------------
    batch_result: {
      fields: lambda do |_connection, _config_fields|
        [
          { name: "success_count", type: "integer", label: "Succeeded" },
          { name: "error_count",   type: "integer", label: "Failed" },
          { name: "results", type: "array", of: "object", label: "Results" },
          { name: "errors",  type: "array", of: "object", label: "Errors",
            properties: [
              { name: "index",     type: "integer", label: "Item Index" },
              { name: "record_id",                  label: "Record ID" },
              { name: "http_code", type: "integer", label: "HTTP Code" },
              { name: "message",                    label: "Error Message" }
            ] }
        ]
      end
    }
  },

  # --- ACTIONS ------------------------------------------------------------------------
  actions: {
    # --- Table management (developer API) ---------------------------------------------
    # list_tables
    list_tables: {
      title: "List data tables",
      description: "Returns all data tables visible to this API client.",
      help: "Requires the Data Tables → List scope on your API client.",

      input_fields: lambda do |_object_definitions|
        [
          { name: "page",     type: "integer", default: 1,   optional: true },
          { name: "per_page", type: "integer", default: 100, optional: true,
            hint: "Max 100" }
        ]
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: "data", type: "array", of: "object",
            properties: object_definitions["table"] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          data: [
            {
              id: "a1b2c3d4-0000-0000-0000-000000000000",
              name: "Sample Table",
              description: "Example table",
              folder_id: 12345,
              created_at: "2025-01-01T00:00:00.000Z",
              updated_at: "2025-01-01T00:00:00.000Z",
              schema: []
            }
          ]
        }
      end,

      execute: lambda do |_connection, input|
        page     = (input["page"] || 1).to_i
        per_page = [[( input["per_page"] || 100 ).to_i, 1].max, 100].min

        response = get("/api/data_tables")
                     .params(page: page, per_page: per_page)
                     .after_error_response(403) do |_code, body, headers, _msg|
                       cid = (headers || {})["x-correlation-id"]
                       error("Permission denied listing tables | cid=#{cid} | #{body}")
                     end

        # Normalize — API returns { "data": [...] }
        { "data" => response["data"] || [] }
      end
    },

    # get_table
    get_table: {
      title: "Get data table",
      description: "Retrieve a single table's metadata and schema by ID.",

      input_fields: lambda do |_object_definitions|
        [
          { name: "table_id", label: "Table", optional: false,
            control_type: "select", pick_list: "tables" }
        ]
      end,

      output_fields: lambda do |object_definitions|
        object_definitions["table"]
      end,

      sample_output: lambda do |_connection, _input|
        {
          id: "a1b2c3d4-0000-0000-0000-000000000000",
          name: "Sample Table",
          description: "Example table",
          folder_id: 12345,
          created_at: "2025-01-01T00:00:00.000Z",
          updated_at: "2025-01-01T00:00:00.000Z",
          schema: [
            { field_id: "f1", name: "company_name", type: "string",
              optional: false, multivalue: false }
          ]
        }
      end,

      execute: lambda do |_connection, input|
        get("/api/data_tables/#{input['table_id']}")
          .after_error_response(404) do |_code, body, _headers, _msg|
            error("Table not found: #{input['table_id']} | #{body}")
          end
          .after_error_response(403) do |_code, body, headers, _msg|
            cid = (headers || {})["x-correlation-id"]
            error("Permission denied | cid=#{cid} | #{body}")
          end
      end
    },

    # create_table
    create_table: {
      title: "Create data table",
      description: "Create a new data table with the specified schema.",
      help: "Requires Data Tables → Create scope. The table is created " \
            "in the folder specified by folder_id.",

      input_fields: lambda do |_object_definitions|
        [
          { name: "name", optional: false,
            hint: "Display name for the new table" },
          { name: "folder_id", type: "integer", optional: false,
            control_type: "select", pick_list: "folders",
            hint: "Folder to create the table in" },
          { name: "schema", type: "array", of: "object", optional: false,
            label: "Columns",
            properties: [
              { name: "name", optional: false,
                hint: "Column name (snake_case recommended)" },
              { name: "type", optional: false,
                control_type: "select",
                pick_list: [
                  %w[String string],
                  %w[Integer integer],
                  ["Number (decimal)", "number"],
                  %w[Boolean boolean],
                  %w[Date date],
                  %w[Datetime date_time],
                  %w[File file],
                  %w[Relation relation]
                ] },
              { name: "optional", type: "boolean", default: true },
              { name: "hint", optional: true },
              { name: "default_value", optional: true },
              { name: "multivalue", type: "boolean", optional: true,
                hint: "Allow multiple values" },
              { name: "relation", type: "object", optional: true,
                hint: "Required when type is 'relation'",
                properties: [
                  { name: "table_id", hint: "UUID of the related table" },
                  { name: "field_id", hint: "Field ID in the related table" }
                ] }
            ] }
        ]
      end,

      output_fields: lambda do |object_definitions|
        object_definitions["table"]
      end,

      sample_output: lambda do |_connection, _input|
        {
          id: "a1b2c3d4-0000-0000-0000-000000000000",
          name: "New Table",
          folder_id: 12345,
          created_at: "2025-01-01T00:00:00.000Z",
          updated_at: "2025-01-01T00:00:00.000Z",
          schema: []
        }
      end,

      execute: lambda do |_connection, input|
        response = post("/api/data_tables")
                     .payload(
                       name:      input["name"],
                       folder_id: input["folder_id"],
                       schema:    input["schema"]
                     )
                     .after_error_response(400) do |_code, body, _headers, _msg|
                       error("Invalid table definition | #{body}")
                     end
                     .after_error_response(403) do |_code, body, headers, _msg|
                       cid = (headers || {})["x-correlation-id"]
                       error("Permission denied creating table | cid=#{cid} | #{body}")
                     end

        # Normalize — unwrap if API returns { "data": { ... } }
        response["data"] || response
      end
    },

    # update_table
    #
    # Covers rename, move to different folder, and schema changes
    # in a single action. Supply only the fields you want to change.
    # (Replaces the old separate move_or_rename_table action.)
    update_table: {
      title: "Update data table",
      description: "Rename, move, or modify the schema of an existing table. " \
                   "Supply only the fields you want to change.",

      input_fields: lambda do |_object_definitions|
        [
          { name: "table_id", label: "Table", optional: false,
            control_type: "select", pick_list: "tables" },
          { name: "name", optional: true,
            hint: "New display name (leave blank to keep current)" },
          { name: "folder_id", type: "integer", optional: true,
            control_type: "select", pick_list: "folders",
            hint: "Move to this folder (leave blank to keep current)" },
          { name: "schema", type: "array", of: "object", optional: true,
            label: "Schema changes",
            hint: "Full replacement schema — include all columns, not just changes",
            properties: [
              { name: "name", optional: false },
              { name: "type", optional: false,
                control_type: "select",
                pick_list: [
                  %w[String string],
                  %w[Integer integer],
                  ["Number (decimal)", "number"],
                  %w[Boolean boolean],
                  %w[Date date],
                  %w[Datetime date_time],
                  %w[File file],
                  %w[Relation relation]
                ] },
              { name: "optional", type: "boolean" },
              { name: "hint", optional: true },
              { name: "default_value", optional: true },
              { name: "multivalue", type: "boolean", optional: true },
              { name: "relation", type: "object", optional: true,
                properties: [
                  { name: "table_id" },
                  { name: "field_id" }
                ] }
            ] }
        ]
      end,

      output_fields: lambda do |object_definitions|
        object_definitions["table"]
      end,

      execute: lambda do |_connection, input|
        body = {}
        body[:name]      = input["name"]      if input["name"].present?
        body[:folder_id] = input["folder_id"] if input["folder_id"].present?
        body[:schema]    = input["schema"]    if input["schema"].present?

        if body.empty?
          error("Nothing to update — supply at least one of: name, folder_id, schema")
        end

        response = put("/api/data_tables/#{input['table_id']}")
                     .payload(body)
                     .after_error_response(400) do |_code, body_str, _headers, _msg|
                       error("Invalid update | #{body_str}")
                     end
                     .after_error_response(404) do |_code, _body, _headers, _msg|
                       error("Table not found: #{input['table_id']}")
                     end
                     .after_error_response(403) do |_code, body_str, headers, _msg|
                       cid = (headers || {})["x-correlation-id"]
                       error("Permission denied | cid=#{cid} | #{body_str}")
                     end

        response["data"] || response
      end
    },

    # truncate_table
    truncate_table: {
      title: "Truncate data table",
      description: "Delete all records from a table while preserving its schema.",
      help: "This is irreversible. The 'confirm' field must be set to true.",

      input_fields: lambda do |_object_definitions|
        [
          { name: "table_id", label: "Table", optional: false,
            control_type: "select", pick_list: "tables" },
          { name: "confirm", type: "boolean", optional: false,
            hint: "Must be true to proceed — safety guard against accidental truncation" }
        ]
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: "success",      type: "boolean",   label: "Success" },
          { name: "truncated_at", type: "timestamp",  label: "Truncated At" }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { success: true, truncated_at: "2025-01-01T00:00:00.000Z" }
      end,

      execute: lambda do |_connection, input|
        unless input["confirm"] == true
          error("Truncation not confirmed — set 'confirm' to true to proceed")
        end

        post("/api/data_tables/#{input['table_id']}/truncate")
          .after_error_response(404) do |_code, _body, _headers, _msg|
            error("Table not found: #{input['table_id']}")
          end
          .after_error_response(403) do |_code, body, headers, _msg|
            cid = (headers || {})["x-correlation-id"]
            error("Permission denied truncating table | cid=#{cid} | #{body}")
          end

        { success: true, truncated_at: now }
      end
    },

    # --- Record management (regional API) -----------------------------------------------
  
    # - These hit the Records API on the regional data-tables host (not the Developer API).
    # - Every action builds its own full URL via call(:records_base, connection).

    # query_records
    query_records: {
      title: "Query records",
      description: "Search and filter records in a data table. " \
                   "Returns a page of results and a continuation token " \
                   "for the next page.",
      help: "To paginate: pass the continuation_token from the previous " \
            "response into the next call. Leave it blank for the first page.",

      config_fields: [
        { name: "table_id", label: "Table", optional: false,
          control_type: "select", pick_list: "tables" }
      ],

      input_fields: lambda do |_connection, config_fields|
        fields = [
          { name: "select", type: "array", of: "string", optional: true,
            label: "Columns to return",
            hint: "Field names or meta-fields: $record_id, $created_at, " \
                  "$updated_at. Leave blank to return all columns." },
          { name: "filters", type: "object", optional: true,
            label: "Filters",
            properties: [
              { name: "operator",
                control_type: "select",
                pick_list: [%w[AND and], %w[OR or]],
                default: "and",
                hint: "Combine conditions with AND or OR" },
              { name: "conditions", type: "array", of: "object",
                properties: [
                  { name: "column",
                    hint: "Field name to filter on" },
                  { name: "operator",
                    control_type: "select",
                    pick_list: [
                      %w[Equals eq],          ["Not equals", "ne"],
                      ["Greater than", "gt"],  ["Less than", "lt"],
                      ["Greater or equal", "gte"], ["Less or equal", "lte"],
                      ["In list", "in"],       ["Starts with", "starts_with"]
                    ] },
                  { name: "value" },
                  { name: "case_sensitive", type: "boolean", optional: true,
                    hint: "Applies to eq and starts_with operators" }
                ] }
            ] },
          { name: "order", type: "object", optional: true,
            label: "Sort",
            properties: [
              { name: "column", hint: "Field name to sort by" },
              { name: "order",
                control_type: "select",
                pick_list: [%w[Ascending asc], %w[Descending desc]],
                default: "asc" },
              { name: "case_sensitive", type: "boolean", default: false }
            ] },
          { name: "limit", type: "integer", default: 100, optional: true,
            hint: "Records per page (max varies by API plan)" },
          { name: "continuation_token", optional: true,
            hint: "From a previous query response — leave blank for first page" },
          { name: "timezone_offset_secs", type: "integer", optional: true,
            hint: "Required when comparing a datetime field to a date value" }
        ]

        fields
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: "records", type: "array", of: "object",
            properties: object_definitions["dynamic_record"] },
          { name: "continuation_token", label: "Continuation Token",
            hint: "Pass this to the next query call to get the next page. " \
                  "Blank when no more pages remain." }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          records: [
            { "$record_id" => "rec-001",
              "$created_at" => "2025-01-01T00:00:00.000Z",
              "$updated_at" => "2025-01-01T00:00:00.000Z" }
          ],
          continuation_token: nil
        }
      end,

      execute: lambda do |connection, input|
        base = call(:records_base, connection)
        url  = "#{base}/api/v1/tables/#{input['table_id']}/query"

        # Build order clause only if a column is specified
        order = if input.dig("order", "column").present?
                  { by:             input["order"]["column"],
                    order:          input["order"]["order"] || "asc",
                    case_sensitive: !!input["order"]["case_sensitive"] }
                end

        body = {
          select:               input["select"],
          where:                call(:build_where, input["filters"]),
          order:                order,
          limit:                input["limit"] || 100,
          continuation_token:   input["continuation_token"],
          timezone_offset_secs: input["timezone_offset_secs"]
        }.compact

        response = post(url)
                     .payload(body)
                     .after_error_response(400) do |_code, resp_body, _h, _msg|
                       error("Invalid query | #{resp_body}")
                     end
                     .after_error_response(404) do |_code, resp_body, _h, _msg|
                       error("Table not found: #{input['table_id']} | #{resp_body}")
                     end
                     .after_error_response(429) do |_code, _body, headers, _msg|
                       ra = (headers || {})["retry-after"] || "60"
                       error("Rate limited — retry after #{ra}s")
                     end

        {
          records:            response["records"] || response["data"] || [],
          continuation_token: response["continuation_token"]
        }
      end
    },

    # create_record
    create_record: {
      title: "Create record",
      description: "Insert a new record into a data table.",

      config_fields: [
        { name: "table_id", label: "Table", optional: false,
          control_type: "select", pick_list: "tables" }
      ],

      input_fields: lambda do |connection, config_fields|
        table_id = config_fields["table_id"]
        return [] unless table_id.present?

        table = get("/api/data_tables/#{table_id}")
        cols  = table["schema"] || table.dig("data", "schema") || []

        type_map = {
          "string"    => "string",
          "integer"   => "integer",
          "number"    => "number",
          "boolean"   => "boolean",
          "date"      => "date",
          "date_time" => "date_time",
          "file"      => "object",
          "relation"  => "string"
        }

        cols.map do |col|
          {
            name:     col["name"],
            label:    (col["name"] || "").gsub("_", " ").split.map(&:capitalize).join(" "),
            type:     type_map[col["type"]] || "string",
            optional: col["optional"] != false
          }
        end
      end,

      output_fields: lambda do |object_definitions|
        object_definitions["dynamic_record"]
      end,

      sample_output: lambda do |_connection, _input|
        {
          "$record_id"  => "rec-001",
          "$created_at" => "2025-01-01T00:00:00.000Z",
          "$updated_at" => "2025-01-01T00:00:00.000Z"
        }
      end,

      execute: lambda do |connection, input|
        base = call(:records_base, connection)
        url  = "#{base}/api/v1/tables/#{input['table_id']}/records"

        # Build field payload — everything except table_id
        data = input.reject { |k, _| k == "table_id" }

        response = post(url)
                     .payload(data)
                     .after_error_response(400) do |_code, body, _h, _msg|
                       error("Invalid record data | #{body}")
                     end
                     .after_error_response(404) do |_code, body, _h, _msg|
                       error("Table not found: #{input['table_id']} | #{body}")
                     end
                     .after_error_response(429) do |_code, _body, headers, _msg|
                       ra = (headers || {})["retry-after"] || "60"
                       error("Rate limited — retry after #{ra}s")
                     end

        # API sometimes returns an array; normalize to single record
        rec = response.is_a?(Array) ? (response.first || {}) : response
        rec
      end
    },

    # update_record
    update_record: {
      title: "Update record",
      description: "Update an existing record's field values.",

      config_fields: [
        { name: "table_id", label: "Table", optional: false,
          control_type: "select", pick_list: "tables" }
      ],

      input_fields: lambda do |connection, config_fields|
        # Record ID is always required
        fields = [
          { name: "record_id", optional: false,
            label: "Record ID",
            hint: "The $record_id of the record to update" }
        ]

        table_id = config_fields["table_id"]
        return fields unless table_id.present?

        table = get("/api/data_tables/#{table_id}")
        cols  = table["schema"] || table.dig("data", "schema") || []

        type_map = {
          "string"    => "string",
          "integer"   => "integer",
          "number"    => "number",
          "boolean"   => "boolean",
          "date"      => "date",
          "date_time" => "date_time",
          "file"      => "object",
          "relation"  => "string"
        }

        # All columns optional on update — you only send what changed
        dynamic = cols.map do |col|
          {
            name:     col["name"],
            label:    (col["name"] || "").gsub("_", " ").split.map(&:capitalize).join(" "),
            type:     type_map[col["type"]] || "string",
            optional: true
          }
        end

        fields.concat(dynamic)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions["dynamic_record"]
      end,

      sample_output: lambda do |_connection, _input|
        {
          "$record_id"  => "rec-001",
          "$created_at" => "2025-01-01T00:00:00.000Z",
          "$updated_at" => "2025-01-01T12:00:00.000Z"
        }
      end,

      execute: lambda do |connection, input|
        base      = call(:records_base, connection)
        record_id = input["record_id"]
        url       = "#{base}/api/v1/tables/#{input['table_id']}/records/#{record_id}"

        # Build field payload — exclude table_id and record_id
        data = input.reject { |k, _| %w[table_id record_id].include?(k) }

        response = put(url)
                     .payload(data)
                     .after_error_response(400) do |_code, body, _h, _msg|
                       error("Invalid update data | #{body}")
                     end
                     .after_error_response(404) do |_code, body, _h, _msg|
                       error("Record not found: #{record_id} | #{body}")
                     end
                     .after_error_response(429) do |_code, _body, headers, _msg|
                       ra = (headers || {})["retry-after"] || "60"
                       error("Rate limited — retry after #{ra}s")
                     end

        response.is_a?(Array) ? (response.first || {}) : response
      end
    },

    # delete_record
    delete_record: {
      title: "Delete record",
      description: "Permanently delete a single record by ID.",

      config_fields: [
        { name: "table_id", label: "Table", optional: false,
          control_type: "select", pick_list: "tables" }
      ],

      input_fields: lambda do |_connection, _config_fields|
        [
          { name: "record_id", optional: false,
            label: "Record ID",
            hint: "The $record_id of the record to delete" }
        ]
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: "record_id", label: "Deleted Record ID" },
          { name: "success",   type: "boolean", label: "Success" }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { record_id: "rec-001", success: true }
      end,

      execute: lambda do |connection, input|
        base      = call(:records_base, connection)
        record_id = input["record_id"]
        url       = "#{base}/api/v1/tables/#{input['table_id']}/records/#{record_id}"

        delete(url)
          .after_error_response(404) do |_code, body, _h, _msg|
            error("Record not found: #{record_id} | #{body}")
          end
          .after_error_response(429) do |_code, _body, headers, _msg|
            ra = (headers || {})["retry-after"] || "60"
            error("Rate limited — retry after #{ra}s")
          end

        { record_id: record_id, success: true }
      end
    },

    # Batch actions that include sequential per-item calls with error capture. 
    # batch_create_records
    batch_create_records: {
      title: "Batch create records",
      description: "Create multiple records in a data table. Each record " \
                   "is inserted individually; failures are captured " \
                   "without stopping the batch.",

      config_fields: [
        { name: "table_id", label: "Table", optional: false,
          control_type: "select", pick_list: "tables" }
      ],

      input_fields: lambda do |connection, config_fields|
        table_id = config_fields["table_id"]
        col_fields = []

        if table_id.present?
          table = get("/api/data_tables/#{table_id}")
          cols  = table["schema"] || table.dig("data", "schema") || []

          type_map = {
            "string" => "string", "integer" => "integer",
            "number" => "number", "boolean" => "boolean",
            "date" => "date", "date_time" => "date_time",
            "file" => "object", "relation" => "string"
          }

          col_fields = cols.map do |col|
            {
              name:     col["name"],
              label:    (col["name"] || "").gsub("_", " ").split.map(&:capitalize).join(" "),
              type:     type_map[col["type"]] || "string",
              optional: col["optional"] != false
            }
          end
        end

        [
          { name: "records", type: "array", of: "object",
            optional: false,
            label: "Records",
            hint: "List of records to create",
            properties: col_fields }
        ]
      end,

      output_fields: lambda do |object_definitions|
        object_definitions["batch_result"]
      end,

      sample_output: lambda do |_connection, _input|
        {
          success_count: 2,
          error_count: 1,
          results: [{ "$record_id" => "rec-001" }, { "$record_id" => "rec-002" }],
          errors: [{ index: 2, record_id: nil, http_code: 400,
                     message: "Required field missing: company_name" }]
        }
      end,

      execute: lambda do |connection, input|
        base = call(:records_base, connection)
        url  = "#{base}/api/v1/tables/#{input['table_id']}/records"

        successes = []
        errors    = []

        (input["records"] || []).each_with_index do |record, idx|
          begin
            result = post(url).payload(record)
            rec = result.is_a?(Array) ? (result.first || {}) : result
            successes << rec
          rescue => e
            errors << {
              index:     idx,
              record_id: nil,
              http_code: e.respond_to?(:http_code) ? e.http_code : nil,
              message:   call(:error_context, "Create failed (item #{idx})", e)
            }
          end
        end

        {
          success_count: successes.length,
          error_count:   errors.length,
          results:       successes,
          errors:        errors
        }
      end
    },

    # batch_update_records
    batch_update_records: {
      title: "Batch update records",
      description: "Update multiple records in a data table. Each record " \
                   "is updated individually; failures are captured " \
                   "without stopping the batch.",

      config_fields: [
        { name: "table_id", label: "Table", optional: false,
          control_type: "select", pick_list: "tables" }
      ],

      input_fields: lambda do |connection, config_fields|
        table_id = config_fields["table_id"]

        # record_id is always the first field in each item
        item_fields = [
          { name: "record_id", optional: false,
            label: "Record ID",
            hint: "The $record_id of the record to update" }
        ]

        if table_id.present?
          table = get("/api/data_tables/#{table_id}")
          cols  = table["schema"] || table.dig("data", "schema") || []

          type_map = {
            "string" => "string", "integer" => "integer",
            "number" => "number", "boolean" => "boolean",
            "date" => "date", "date_time" => "date_time",
            "file" => "object", "relation" => "string"
          }

          # All optional on update — send only what changed
          dynamic = cols.map do |col|
            {
              name:     col["name"],
              label:    (col["name"] || "").gsub("_", " ").split.map(&:capitalize).join(" "),
              type:     type_map[col["type"]] || "string",
              optional: true
            }
          end

          item_fields.concat(dynamic)
        end

        [
          { name: "records", type: "array", of: "object",
            optional: false,
            label: "Records to update",
            properties: item_fields }
        ]
      end,

      output_fields: lambda do |object_definitions|
        object_definitions["batch_result"]
      end,

      sample_output: lambda do |_connection, _input|
        {
          success_count: 2,
          error_count: 0,
          results: [{ "$record_id" => "rec-001" }, { "$record_id" => "rec-002" }],
          errors: []
        }
      end,

      execute: lambda do |connection, input|
        base = call(:records_base, connection)

        successes = []
        errors    = []

        (input["records"] || []).each_with_index do |item, idx|
          begin
            record_id = item["record_id"]
            url  = "#{base}/api/v1/tables/#{input['table_id']}/records/#{record_id}"
            data = item.reject { |k, _| k == "record_id" }

            result = put(url).payload(data)
            rec = result.is_a?(Array) ? (result.first || {}) : result
            successes << rec
          rescue => e
            errors << {
              index:     idx,
              record_id: item["record_id"],
              http_code: e.respond_to?(:http_code) ? e.http_code : nil,
              message:   call(:error_context, "Update failed (item #{idx})", e)
            }
          end
        end

        {
          success_count: successes.length,
          error_count:   errors.length,
          results:       successes,
          errors:        errors
        }
      end
    },

    # batch_delete_records
    batch_delete_records: {
      title: "Batch delete records",
      description: "Delete multiple records from a data table. Each delete " \
                   "is processed individually; failures are captured " \
                   "without stopping the batch.",

      config_fields: [
        { name: "table_id", label: "Table", optional: false,
          control_type: "select", pick_list: "tables" }
      ],

      input_fields: lambda do |_connection, _config_fields|
        [
          { name: "record_ids", type: "array", of: "string",
            optional: false,
            label: "Record IDs",
            hint: "List of $record_id values to delete" }
        ]
      end,

      output_fields: lambda do |object_definitions|
        object_definitions["batch_result"]
      end,

      sample_output: lambda do |_connection, _input|
        {
          success_count: 3,
          error_count: 0,
          results: [
            { record_id: "rec-001", success: true },
            { record_id: "rec-002", success: true },
            { record_id: "rec-003", success: true }
          ],
          errors: []
        }
      end,

      execute: lambda do |connection, input|
        base = call(:records_base, connection)

        successes = []
        errors    = []

        (input["record_ids"] || []).each_with_index do |record_id, idx|
          begin
            url = "#{base}/api/v1/tables/#{input['table_id']}/records/#{record_id}"
            delete(url)
            successes << { record_id: record_id, success: true }
          rescue => e
            errors << {
              index:     idx,
              record_id: record_id,
              http_code: e.respond_to?(:http_code) ? e.http_code : nil,
              message:   call(:error_context, "Delete failed (item #{idx})", e)
            }
          end
        end

        {
          success_count: successes.length,
          error_count:   errors.length,
          results:       successes,
          errors:        errors
        }
      end
    },
  
    # --- Workspace management -----------------------------------------------------------
    # list_folders
    list_folders: {
      title: "List folders",
      description: "Returns folders visible to this API client.",
      help: "Requires Projects & folders → List scope. " \
            "Use parent_id to list children of a specific folder; " \
            "leave blank for the Home folder.",

      input_fields: lambda do |_object_definitions|
        [
          { name: "parent_id", optional: true,
            control_type: "select", pick_list: "folders",
            label: "Parent Folder",
            hint: "List children of this folder. Defaults to Home." },
          { name: "page",     type: "integer", default: 1,   optional: true },
          { name: "per_page", type: "integer", default: 100, optional: true,
            hint: "Max 100" }
        ]
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: "data", type: "array", of: "object",
            properties: object_definitions["folder"] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          data: [
            { id: "12345", name: "Integrations",
              parent_id: nil,
              created_at: "2025-01-01T00:00:00.000Z",
              updated_at: "2025-01-01T00:00:00.000Z" }
          ]
        }
      end,

      execute: lambda do |_connection, input|
        page     = (input["page"] || 1).to_i
        per_page = [[(input["per_page"] || 100).to_i, 1].max, 100].min

        params = { page: page, per_page: per_page }
        params[:parent_id] = input["parent_id"] if input["parent_id"].present?

        response = get("/api/folders")
                     .params(params)
                     .after_error_response(403) do |_code, body, headers, _msg|
                       cid = (headers || {})["x-correlation-id"]
                       error("Permission denied listing folders | cid=#{cid} | " \
                             "Enable: Projects & folders → List | #{body}")
                     end

        # Normalize bare array to envelope
        arr = response.is_a?(Array) ? response : (response["data"] || [])
        { "data" => arr }
      end
    },

    # list_projects
    list_projects: {
      title: "List projects",
      description: "Returns projects visible to this API client.",
      help: "Requires Projects & folders → List scope.",

      input_fields: lambda do |_object_definitions|
        [
          { name: "page",     type: "integer", default: 1,   optional: true },
          { name: "per_page", type: "integer", default: 100, optional: true,
            hint: "Max 100" }
        ]
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: "data", type: "array", of: "object",
            properties: object_definitions["project"] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          data: [
            { id: "67890", name: "Supplier Platform",
              description: "Multi-tenant supplier data collection",
              folder_id: "12345" }
          ]
        }
      end,

      execute: lambda do |_connection, input|
        page     = (input["page"] || 1).to_i
        per_page = [[(input["per_page"] || 100).to_i, 1].max, 100].min

        response = get("/api/projects")
                     .params(page: page, per_page: per_page)
                     .after_error_response(403) do |_code, body, headers, _msg|
                       cid = (headers || {})["x-correlation-id"]
                       error("Permission denied listing projects | cid=#{cid} | " \
                             "Enable: Projects & folders → List | #{body}")
                     end

        # Normalize bare array to envelope
        arr = response.is_a?(Array) ? response : (response["data"] || [])
        { "data" => arr }
      end
    },

    # create_folder
    create_folder: {
      title: "Create folder",
      description: "Create a new folder in the workspace.",

      input_fields: lambda do |_object_definitions|
        [
          { name: "name", optional: false,
            hint: "Display name for the new folder" },
          { name: "parent_id", optional: true,
            control_type: "select", pick_list: "folders",
            label: "Parent Folder",
            hint: "Create inside this folder. Defaults to Home." }
        ]
      end,

      output_fields: lambda do |object_definitions|
        object_definitions["folder"]
      end,

      sample_output: lambda do |_connection, _input|
        {
          id: "12345", name: "New Folder",
          parent_id: nil,
          created_at: "2025-01-01T00:00:00.000Z",
          updated_at: "2025-01-01T00:00:00.000Z"
        }
      end,

      execute: lambda do |_connection, input|
        payload = { name: input["name"] }
        payload[:parent_id] = input["parent_id"] if input["parent_id"].present?

        response = post("/api/folders")
                     .payload(payload)
                     .after_error_response(400) do |_code, body, _h, _msg|
                       error("Invalid folder definition | #{body}")
                     end
                     .after_error_response(403) do |_code, body, headers, _msg|
                       cid = (headers || {})["x-correlation-id"]
                       error("Permission denied creating folder | cid=#{cid} | #{body}")
                     end

        # Normalize — API may return bare object or { "data": { ... } }
        response.is_a?(Hash) && response.key?("data") ? response["data"] : response
      end
    }
  },

  # --- TRIGGERS -----------------------------------------------------------------------
  triggers: {

    # ----------------------------------------------------------
    # new_or_updated_record
    #
    # Polls for records where $updated_at > last seen timestamp.
    # Ordered ascending so the oldest unseen records come first,
    # and the closure always advances forward.
    #
    # Dedup key combines $record_id + $updated_at so that:
    #   - A new record is processed once
    #   - An updated record is processed again (new $updated_at)
    #   - A re-polled page doesn't duplicate already-seen records
    # ----------------------------------------------------------
    new_or_updated_record: {
      title: "New or updated record",
      description: "Triggers when a record is created or updated in the " \
                   "selected data table.",
      help: "Set 'Since' to control how far back the first poll looks. " \
            "Subsequent polls automatically pick up from where they left off.",

      config_fields: [
        { name: "table_id", label: "Table", optional: false,
          control_type: "select", pick_list: "tables" }
      ],

      input_fields: lambda do |_connection, _config_fields|
        [
          { name: "since", type: "date_time", optional: true,
            label: "Since",
            hint: "Only process records updated after this time. " \
                  "Defaults to one hour ago if left blank." },
          { name: "limit", type: "integer", optional: true,
            default: 100,
            hint: "Records per poll (higher = fewer polls, more memory)" }
        ]
      end,

      output_fields: lambda do |object_definitions|
        object_definitions["dynamic_record"]
      end,

      sample_output: lambda do |_connection, _input|
        {
          "$record_id"  => "rec-001",
          "$created_at" => "2025-01-01T00:00:00.000Z",
          "$updated_at" => "2025-01-01T12:00:00.000Z"
        }
      end,

      poll: lambda do |connection, input, closure|
        closure  = closure || {}
        limit    = (input["limit"] || 100).to_i
        table_id = input["table_id"]

        # First poll: use the user-supplied 'since' or default to 1 hour ago
        since = closure["since"] ||
                input["since"] ||
                (now - 1.hours).utc.iso8601

        base = call(:records_base, connection)
        url  = "#{base}/api/v1/tables/#{table_id}/query"

        body = {
          where: {
            "$updated_at" => { "$gt" => since }
          },
          order: {
            by:    "$updated_at",
            order: "asc"
          },
          limit: limit
        }

        response = post(url).payload(body)

        records = response["records"] || response["data"] || []

        # Advance the cursor to the last record's $updated_at.
        # If the page was empty, keep the current cursor.
        next_since = if records.any?
                       records.last["$updated_at"] || since
                     else
                       since
                     end

        # If we got a full page, there may be more records to fetch
        can_poll_more = records.length >= limit

        {
          events:        records,
          next_poll:     { "since" => next_since },
          can_poll_more: can_poll_more
        }
      end,

      dedup: lambda do |record|
        "#{record['$record_id']}_#{record['$updated_at']}"
      end
    }
  }
}
