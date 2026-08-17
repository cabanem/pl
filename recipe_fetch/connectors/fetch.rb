{
  title: "Workato Developer API",

  # --- CONNECTION --------------------------------------------------
  connection: {
    fields: [
      { name: 'workato_environments', type: :array, of: :object, label: 'Workato environments', item_label: 'Environment', list_mode: 'static',
        help: 'Register each Workato workspace you want this connector to manage. Add one row per environment (e.g. DEV, TEST, PROD). ' \
              'The connector uses these entries to route API calls to the correct workspace and to determine the promotion path when ' \
              'deploying packages between environments.',
        properties: [
          { name: 'name', control_type: 'select', optional: false,
            options: [
              %w[DEV DEV],
              %w[TEST TEST],
              %w[PROD PROD]
            ],
            hint: 'A unique label for this environment. Used by all actions ' \
                  'to identify which workspace to target. Select each ' \
                  'environment only once.' },
          { name: 'data_center', control_type: 'select', optional: false, default: 'https://www.workato.com/api',
            options: [
              ['US', 'https://www.workato.com/api'],
              ['EU', 'https://app.eu.workato.com/api'],
              ['SG', 'https://app.sg.workato.com/api'],
              ['JP', 'https://app.jp.workato.com/api']
            ],
            hint: 'The Workato data center region this workspace is hosted in. Must match the region shown in your workspace URL.' },
          { name: 'is_production', type: :boolean, control_type: 'checkbox', default: 'false',
            hint: 'Mark exactly one environment as production. This flag is used by promotion logic. Only one environment can be marked as production.'
          },
          { name: 'level', type: :integer, control_type: 'select', optional: false, options: (1..10).map { |n| [n.to_s, n] },
            hint: 'Promotion order. Level 1 is the lowest environment (e.g. DEV). Packages promote from lower levels to higher levels. Levels must start at 1 and be ' \
                  'sequential; gaps greater than 1 are not allowed, but duplicates are OK (e.g. 1, 2, 2, 3).' },
          { name: 'api_token', control_type: 'password', optional: false,
            hint: 'Bearer token for this workspace. Generate one from Settings > API Clients in the target workspace.' } ]
      }
    ],

    authorization: {
      type: 'custom_auth',

      apply: lambda do |_connection|
        # No-op: auth is applied per-request via get_auth_headers
        # because each environment has its own token.
      end
    },

    base_uri: lambda do |connection|
      # Not used directly — each action resolves its own datacenter.
      # Default to first environment's DC for pick list calls.
      envs = connection['workato_environments']
      envs&.first&.[]('data_center') || 'https://www.workato.com/api'
    end
  },

  test: lambda do |connection|
    envs = connection['workato_environments'] || []

    # Validation rules
    call('connection_validation', envs)

    # Connectivity check
    envs.each do |env|
      get(env['data_center'] + '/users/me')
        .headers('Authorization' => "Bearer #{env['api_token']}")
        .after_error_response(/.*/) do |_code, body, _header, message|
          error("Connection test failed for #{env['name']}: #{message} — #{body}")
        end
    end

    true
  end,

  # --- METHODS -----------------------------------------------------
  methods: {

    # ── connection_validation ─────────────────────────────────
    connection_validation: lambda do |envs|
      envs = envs || []

      # Rule: Max 1 production environment
      prod_count = envs.count { |e| e['is_production'].is_true? }
      if prod_count > 1
        error("More than one production environment isn't allowed.")
      end

      # Rule: All environment names must be unique (case-insensitive)
      names = envs.map { |e| (e['name'] || '').strip.downcase }
      if names.length != names.uniq.length
        error('Environment name must be unique.')
      end

      # Rule: No environment may have an empty level
      envs.each do |e|
        if e['level'].blank?
          error('Level cannot be empty.')
        end
      end

      # Rule: Levels must start at 1
      levels = envs.map { |e| e['level'].to_i }.sort
      if levels.present? && levels.first != 1
        error('Starting level is missing.')
      end

      # Rule: Levels must be sequential (gaps > 1 not allowed, duplicates OK)
      if levels.present?
        levels.uniq.sort.each_cons(2) do |a, b|
          if (b - a) > 1
            error('Levels not in allowed sequence. ' \
                  'Eg.:[1,2,3], [1,2,2], [1,1,2]')
          end
        end
      end

      nil
    end,

    # ── resolve_environment ───────────────────────────────────
    resolve_environment: lambda do |connection, env_name|
      envs = connection['workato_environments'] || []
      env = envs.find { |e| e['name'] == env_name }

      if env.nil?
        error("Environment '#{env_name}' not found in connection. " \
              'Check your environment configuration.')
      end

      env
    end,

    # ── get_auth_headers ──────────────────────────────────────
    get_auth_headers: lambda do |connection, env_name|
      env = call('resolve_environment', connection, env_name)
      { 'Authorization' => "Bearer #{env['api_token']}" }
    end,

    # ── get_datacenter ────────────────────────────────────────
    get_datacenter: lambda do |connection, env_name|
      env = call('resolve_environment', connection, env_name)
      env['data_center']
    end,

    # ── normalize_status ──────────────────────────────────────
    normalize_status: lambda do |api_response, is_projects_mode|
      if is_projects_mode.is_true?
        raw = api_response['state'] || ''
        case raw
        when 'pending'  then 'in_progress'
        when 'success'  then 'success'
        else 'failed'
        end
      else
        raw = api_response['status'] || ''
        case raw
        when 'in_progress' then 'in_progress'
        when 'completed'   then 'success'
        else 'failed'
        end
      end
    end,

    # ── build_endpoint ────────────────────────────────────────
    build_endpoint: lambda do |datacenter, id, is_projects_mode, action|
      base = datacenter

      case action
      when 'build'
        if is_projects_mode.is_true?
          "#{base}/projects/f#{id}/build"
        else
          "#{base}/packages/export/#{id}"
        end
      when 'status'
        if is_projects_mode.is_true?
          "#{base}/project_builds/#{id}"
        else
          "#{base}/packages/#{id}"
        end
      when 'deploy'
        if is_projects_mode.is_true?
          "#{base}/project_builds/#{id}/deploy"
        else
          "#{base}/packages/import/#{id}"
        end
      when 'download'
        "#{base}/packages/#{id}/download"
      else
        error("Unknown endpoint action: #{action}")
      end
    end,

    # ── get_target_environments ───────────────────────────────
    get_target_environments: lambda do |connection, args|
      envs = connection['workato_environments'] || []
      source_env_name = args['source_env']
      exclude_prod = args['exclude_prod']

      result = envs

      if source_env_name.present?
        source = call('resolve_environment', connection, source_env_name)
        if source['is_production'].is_true?
          # From production → all non-production envs
          result = envs.reject { |e| e['is_production'].is_true? }
        else
          # From non-prod → next level only
          source_level = source['level'].to_i
          result = envs.select { |e| e['level'].to_i == source_level + 1 }
        end
      end

      if exclude_prod.is_true?
        result = result.reject { |e| e['is_production'].is_true? }
      end

      result.map do |e|
        {
          'name'          => e['name'],
          'is_production' => e['is_production'],
          'level'         => e['level']
        }
      end
    end,

    # ── poll_or_reinvoke ──────────────────────────────────────
    poll_or_reinvoke: lambda do |input|
      status       = input['status']
      response     = input['response']
      continue     = input['continue'] || {}
      current_step = (continue['current_step'] || 1).to_i
      max_steps    = (input['max_steps'] || 10).to_i

      case status
      when 'in_progress'
        if current_step < max_steps
          reinvoke_after(
            seconds: current_step * 10,
            continue: {
              'current_step' => current_step + 1,
              'job_id'       => response['id']
            }
          )
        else
          error('Operation timed out — job took too long.')
        end
      when 'failed'
        msg = response['error'] || 'Operation failed.'
        error(msg)
      when 'success'
        response
      else
        error("Unexpected normalized status: #{status}")
      end
    end,

    # ── download_package ──────────────────────────────────────
    download_package: lambda do |input|
      headers         = input['headers']
      download_url    = input['download_url']
      env_name        = input['env_name']
      package_id      = input['package_id']
      deployment_mode = input['deployment_mode']

      # Step 1: GET download URL, capture redirect location
      redirect_response = get(download_url)
        .headers(headers)
        .follow_redirection(false)
        .after_response do |_code, _body, resp_headers|
          resp_headers
        end

      redirect_location = redirect_response['location'] ||
                          redirect_response['Location']

      if redirect_location.blank?
        error('Package download did not return a redirect URL.')
      end

      # Step 2: GET the redirect URL (no auth header — it's S3/GCS)
      binary_content = get(redirect_location)
        .headers('Accept' => '*/*')
        .after_response do |_code, body, _headers|
          body
        end
        .response_format_raw

      {
        'workato_environment' => env_name,
        'package_id'          => package_id,
        'deployment_mode'     => deployment_mode,
        'content'             => binary_content
      }
    end,

    # ── compact_schema ────────────────────────────────────────
    # Reduce Workato's verbose per-step schema array to a compact
    # field contract.
    compact_schema: lambda do |schema|
      Array(schema).map do |f|
        {
          'name'         => f['name'],
          'label'        => f['label'],
          'type'         => f['type'],
          'control_type' => f['control_type'],
          'optional'     => f['optional'].nil? ? true : f['optional'],
          'hint'         => f['hint']
        }.compact
      end
    end,

    # ── flatten_steps ─────────────────────────────────────────
    # Pre-order flatten of a recipe step tree. Carries `schema` so
    # build_spec can read it off the trigger / output step; it is
    # stripped from the final step inventory.
    flatten_steps: lambda do |step, path, depth|
      here = {
        'path'     => path,
        'depth'    => depth,
        'keyword'  => step['keyword'] || (depth.zero? ? 'trigger' : 'action'),
        'provider' => step['provider'],
        'name'     => step['name'],
        'as'       => step['as'],
        'title'    => step['title'],
        'schema'   => step['extended_input_schema']
      }

      children = []
      (step['block'] || []).each_with_index do |child, idx|
        children.concat(call('flatten_steps', child, "#{path}.#{idx}", depth + 1))
      end

      [here] + children
    end,

    # ── build_spec ────────────────────────────────────────────
    # The single home for the code-tree → contract-spec transform.
    # Both recipe_to_spec (pure) and inspect_recipe (fetch + spec)
    # are thin shells over this method.
    #
    # args:
    #   code                (required) recipe code JSON string
    #   recipe_id           (optional) stamped into spec.recipe
    #   recipe_name         (optional) stamped into spec.recipe
    #   folder              (optional) stamped into spec.recipe
    #   environment         (optional) provenance; stamped into spec.recipe
    #   output_step_hint    (optional) substring to pin the output step
    #   connection_bindings (optional) array folded into the spec
    build_spec: lambda do |args|
      log  = []
      tree = parse_json(args['code'])
      error('Recipe code did not parse to a step tree') unless tree.is_a?(::Hash)

      flat    = call('flatten_steps', tree, '0', 0)
      trigger = flat.first
      actions = flat[1..-1] || []

      providers = flat.map { |s| s['provider'] }.compact.uniq.sort

      # Input contract == trigger's declared schema (authoritative).
      input_contract = call('compact_schema', trigger['schema'])
      log << 'trigger declares no input schema' if input_contract.empty?

      # Output contract == return/response step's declared schema (heuristic).
      hint = args['output_step_hint'].to_s.strip.downcase
      out_step =
        if hint.empty?
          actions.last
        else
          actions.find { |s| "#{s['name']} #{s['title']}".downcase.include?(hint) } || actions.last
        end
      output_contract = out_step ? call('compact_schema', out_step['schema']) : []
      log << 'no output/return contract detected' if output_contract.empty?

      # Clean inventory (drop the carried schema blob).
      steps = flat.map { |s| s.reject { |k, _v| k == 'schema' } }

      spec = {
        'recipe' => {
          'id'          => args['recipe_id'],
          'name'        => args['recipe_name'],
          'folder'      => args['folder'],
          'environment' => args['environment']
        }.compact,
        'trigger' => {
          'provider' => trigger['provider'],
          'name'     => trigger['name'],
          'as'       => trigger['as']
        }.compact,
        'input_contract'  => input_contract,
        'output_contract' => output_contract,
        'connectors_used' => providers,
        'step_count'      => steps.length,
        'steps'           => steps
      }

      if args['connection_bindings'].present?
        spec['connection_bindings'] = args['connection_bindings']
      end

      {
        'spec_json'           => spec.to_json,
        'recipe_name'         => args['recipe_name'],
        'trigger_provider'    => trigger['provider'],
        'trigger_name'        => trigger['name'],
        'step_count'          => steps.length,
        'connectors_used'     => providers,
        'input_contract'      => input_contract,
        'output_contract'     => output_contract,
        'steps'               => steps,
        'connection_bindings' => args['connection_bindings'],
        'log'                 => log.join('; ')
      }.compact
    end
  },

  # --- OBJECT DEFINITIONS ------------------------------------------
  object_definitions: {

    environment_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'name', label: 'Environment name' },
          { name: 'is_production', type: :boolean },
          { name: 'level', type: :integer }
        ]
      end
    },

    build_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'status',
            hint: 'Normalized: in_progress | success | failed' },
          { name: 'deployment_mode' },
          { name: 'workato_environment' },
          { name: 'source_reference',
            hint: 'Project ID or manifest ID' },
          { name: 'download_url' }
        ]
      end
    },

    package_content_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'workato_environment' },
          { name: 'package_id' },
          { name: 'deployment_mode' },
          { name: 'content', label: 'Binary package content' }
        ]
      end
    },

    deployment_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'status',
            hint: 'Normalized: in_progress | success | failed' }
        ]
      end
    },

    recipe_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'name' },
          { name: 'folder_id' },
          { name: 'running', type: :boolean }
        ]
      end
    },

    recipe_detail_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'name' },
          { name: 'description' },
          { name: 'folder_id', type: :integer },
          { name: 'project_id', type: :integer },
          { name: 'running', type: :boolean },
          { name: 'version_no', type: :integer },
          { name: 'trigger_application' },
          { name: 'action_applications', type: :array, of: :string },
          { name: 'applications', type: :array, of: :string },
          { name: 'code',
            hint: 'JSON string of the recipe step tree. Feed this to the ' \
                  'Recipe to spec action to build a contract.' },
          { name: 'config', type: :array, of: :object,
            hint: 'Connection bindings, one per application.',
            properties: [
              { name: 'keyword' },
              { name: 'name' },
              { name: 'provider' },
              { name: 'account_id', type: :integer },
              { name: 'skip_validation', type: :boolean }
            ] },
          { name: 'job_succeeded_count', type: :integer },
          { name: 'job_failed_count', type: :integer },
          { name: 'lifetime_task_count', type: :integer },
          { name: 'created_at' },
          { name: 'updated_at' },
          { name: 'last_run_at' },
          { name: 'stopped_at' },
          { name: 'author_name' },
          { name: 'version_author_name' },
          { name: 'version_comment' },
          { name: 'tags', type: :array, of: :string,
            hint: 'Populated only when Include tags is enabled.' }
        ]
      end
    },

    folder_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'name' },
          { name: 'parent_id', type: :integer },
          { name: 'created_at' },
          { name: 'updated_at' }
        ]
      end
    },

    api_result_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'result', type: :boolean }
        ]
      end
    },

    contract_field: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'name' },
          { name: 'label' },
          { name: 'type' },
          { name: 'control_type' },
          { name: 'optional', type: :boolean },
          { name: 'hint' }
        ]
      end
    }
  },

  # --- ACTIONS -----------------------------------------------------
  actions: {

    # Get environments
    get_environments: {
      title: 'Get environments',
      subtitle: 'Get list of configured environments',
      description: 'Returns the environments configured in this connection, ' \
                   'optionally filtered by promotion rules. Use Source ' \
                   'environment to get only the valid promotion targets for ' \
                   'that environment. Use Exclude production to omit ' \
                   'production environments from the result.',

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'source_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: true,
            hint: 'Optional. When set, returns only environments eligible ' \
                  'as the next promotion target. Leave blank to return all.'
          },
          {
            name: 'exclude_prod',
            type: :boolean,
            control_type: 'checkbox',
            default: 'false',
            optional: true,
            hint: 'When Yes, production environments are excluded from ' \
                  'the results. Defaults to No.'
          }
        ]
      end,

      execute: lambda do |connection, input|
        result = call('get_target_environments', connection, {
          'source_env'   => input['source_environment'],
          'exclude_prod' => input['exclude_prod']
        })

        { 'environments' => result }
      end,

      output_fields: lambda do |object_definitions|
        [
          {
            name: 'environments',
            type: :array,
            of: :object,
            properties: object_definitions['environment_obj']
          }
        ]
      end
    },

    # Get environment by name
    get_environment_by_name: {
      title: 'Get environment by name',
      subtitle: 'Get details for a single environment',
      description: 'Returns the name, promotion level, and production flag for one configured environment. Useful for branching ' \
                   'logic based on environment properties.',

      input_fields: lambda do |object_definitions|
        [
          { name: 'workato_environment', control_type: 'select', pick_list: 'environments', toggle_hint: 'Use datapill', optional: false, hint: 'The environment to look up.' }
        ]
      end,

      execute: lambda do |connection, input|
        env = call('resolve_environment', connection,
                   input['workato_environment'])
        {
          'name'          => env['name'],
          'is_production' => env['is_production'],
          'level'         => env['level']
        }
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['environment_obj']
      end
    },

    # Build package (async)
    build_package: {
      title: 'Build package (async)',
      subtitle: 'Start a build and return immediately',
      description: 'Kicks off a package build in the selected environment and returns the build ID and initial status without ' \
                   'waiting for completion. Use Get build status in a loop or Build and download package if you need to wait.',

      input_fields: lambda do |object_definitions|
        [
          { name: 'deployment_mode', control_type: 'select', pick_list: 'deployment_mode', toggle_hint: 'Use datapill', optional: false,
            hint: 'Select Projects if your workspace uses the Environments feature, or RLCM if it uses Recipe Lifecycle Management.'  },
          { name: 'workato_environment', control_type: 'select', pick_list: 'environments', toggle_hint: 'Use datapill', optional: false, hint: 'The environment where the build runs.' },
          { name: 'id', label: 'Source ID', optional: false, hint: 'For Projects mode, the project folder ID. For RLCM mode, the manifest ID.'
          },
          { name: 'description', optional: true, ngIf: 'input.deployment_mode == "projects"', hint: 'Optional. A note attached to the build. Projects mode only.' }
        ]
      end,

      execute: lambda do |connection, input|
        env_name        = input['workato_environment']
        is_projects     = input['deployment_mode'] == 'projects'
        headers         = call('get_auth_headers', connection, env_name)
        dc              = call('get_datacenter', connection, env_name)
        url             = call('build_endpoint', dc, input['id'],
                               is_projects, 'build')

        body = if is_projects
                 { 'description' => input['description'] }.compact
               else
                 {}
               end

        response = post(url)
                     .headers(headers)
                     .payload(body)
                     .after_error_response(/.*/) do |_code, resp_body, _h, msg|
                       error("Build failed: #{msg} — #{resp_body}")
                     end

        status = call('normalize_status', response, is_projects)

        {
          'id'                  => response['id'],
          'status'              => status,
          'deployment_mode'     => input['deployment_mode'],
          'workato_environment' => env_name,
          'source_reference'    => input['id'],
          'download_url'        => response['download_url']
        }
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['build_obj']
      end
    },

    # Get build status
    get_build: {
      title: 'Get build status',
      subtitle: 'Check the status of an existing build',
      description: 'Returns the current status of a build. Status is ' \
                   'normalized across both deployment modes: in_progress, ' \
                   'success, or failed.',

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'deployment_mode',
            control_type: 'select',
            pick_list: 'deployment_mode',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'Must match the mode used when the build was started.'
          },
          {
            name: 'workato_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment where the build is running.'
          },
          {
            name: 'id',
            label: 'Build or package ID',
            optional: false,
            hint: 'The ID returned by Build package or Build and download.'
          }
        ]
      end,

      execute: lambda do |connection, input|
        env_name    = input['workato_environment']
        is_projects = input['deployment_mode'] == 'projects'
        headers     = call('get_auth_headers', connection, env_name)
        dc          = call('get_datacenter', connection, env_name)
        url         = call('build_endpoint', dc, input['id'],
                           is_projects, 'status')

        response = get(url)
                     .headers(headers)
                     .after_error_response(/.*/) do |_code, body, _h, msg|
                       error("Get build status failed: #{msg} — #{body}")
                     end

        status = call('normalize_status', response, is_projects)

        {
          'id'                  => response['id'],
          'status'              => status,
          'deployment_mode'     => input['deployment_mode'],
          'workato_environment' => env_name,
          'source_reference'    => input['id'],
          'download_url'        => response['download_url']
        }
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['build_obj']
      end
    },

    # Build and download package (long action)
    build_and_download: {
      title: 'Build and download package',
      subtitle: 'Build, wait for completion, and download the result',
      description: 'Starts a package build, polls until it completes, then ' \
                   'downloads the binary package content. This is a long ' \
                   'action — the recipe job pauses and resumes automatically. ' \
                   'Returns the raw package binary, which can be passed ' \
                   'directly to Deploy package.',

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'deployment_mode',
            control_type: 'select',
            pick_list: 'deployment_mode',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'Select Projects or RLCM to match your workspace setup.'
          },
          {
            name: 'workato_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment to build from.'
          },
          {
            name: 'id',
            label: 'Source ID',
            optional: false,
            hint: 'The project folder ID (Projects) or manifest ID (RLCM).'
          },
          {
            name: 'description',
            optional: true,
            ngIf: 'input.deployment_mode == "projects"',
            hint: 'Optional build note. Projects mode only.'
          }
        ]
      end,

      execute: lambda do |connection, input, _eis, _eos, continue|
        continue    = continue || {}
        env_name    = input['workato_environment']
        is_projects = input['deployment_mode'] == 'projects'
        headers     = call('get_auth_headers', connection, env_name)
        dc          = call('get_datacenter', connection, env_name)

        if continue['job_id'].blank?
          # ── First invocation: kick off the build ──────────
          build_url = call('build_endpoint', dc, input['id'],
                           is_projects, 'build')

          body = if is_projects
                   { 'description' => input['description'] }.compact
                 else
                   {}
                 end

          response = post(build_url)
                       .headers(headers)
                       .payload(body)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("Build failed: #{m} — #{b}")
                       end

          status = call('normalize_status', response, is_projects)

          if status == 'success'
            # Build completed immediately (rare but possible)
            download_url = if is_projects
                             response['download_url']
                           else
                             call('build_endpoint', dc, response['id'],
                                  is_projects, 'download')
                           end

            call('download_package', {
              'headers'         => headers,
              'download_url'    => download_url,
              'env_name'        => env_name,
              'package_id'      => response['id'].to_s,
              'deployment_mode' => input['deployment_mode']
            })
          else
            call('poll_or_reinvoke', {
              'status'   => status,
              'response' => response,
              'continue' => continue
            })
          end

        else
          # ── Reinvocation: check build status ──────────────
          status_url = call('build_endpoint', dc, continue['job_id'],
                            is_projects, 'status')

          response = get(status_url)
                       .headers(headers)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("Build status check failed: #{m} — #{b}")
                       end

          status = call('normalize_status', response, is_projects)

          if status == 'success'
            download_url = if is_projects
                             response['download_url']
                           else
                             call('build_endpoint', dc, response['id'],
                                  is_projects, 'download')
                           end

            call('download_package', {
              'headers'         => headers,
              'download_url'    => download_url,
              'env_name'        => env_name,
              'package_id'      => response['id'].to_s,
              'deployment_mode' => input['deployment_mode']
            })
          else
            call('poll_or_reinvoke', {
              'status'   => status,
              'response' => response,
              'continue' => continue
            })
          end
        end
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['package_content_obj']
      end
    },

    # Download package
    download_existing_package: {
      title: 'Download package',
      subtitle: 'Download a previously completed build',
      help: lambda do
        'Downloads the binary content of a build that has already completed. Use this when you have ' \
        'confirmed a build succeeded via Get build status and want to retrieve the package separately.'
      end,

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'deployment_mode',
            control_type: 'select',
            pick_list: 'deployment_mode',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'Must match the mode used when the build was created.'
          },
          {
            name: 'workato_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment where the build exists.'
          },
          {
            name: 'id',
            label: 'Build or package ID',
            optional: false,
            hint: 'The ID of the completed build.'
          }
        ]
      end,

      execute: lambda do |connection, input|
        env_name    = input['workato_environment']
        is_projects = input['deployment_mode'] == 'projects'
        headers     = call('get_auth_headers', connection, env_name)
        dc          = call('get_datacenter', connection, env_name)

        # Get the build/package to retrieve download URL
        status_url = call('build_endpoint', dc, input['id'],
                          is_projects, 'status')

        response = get(status_url)
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Failed to get package info: #{m} — #{b}")
                     end

        download_url = if is_projects
                         response['download_url']
                       else
                         call('build_endpoint', dc, input['id'],
                              is_projects, 'download')
                       end

        call('download_package', {
          'headers'         => headers,
          'download_url'    => download_url,
          'env_name'        => env_name,
          'package_id'      => response['id'].to_s,
          'deployment_mode' => input['deployment_mode']
        })
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['package_content_obj']
      end
    },

    # Deploy package (long action)
    deploy_package: {
      title: 'Deploy package',
      subtitle: 'Deploy a package to a target environment',
      help: lambda do
        'Deploys a built package from one environment to another.  This is a long action;' \
        'the recipe job pauses and resumes automatically while waiting for completion. ' \
        'Projects mode sends a deploy command referencing an existing build. RLCM mode ' \
        'downloads the package binary from the source and uploads it to the target folder.'
      end,
      input_fields: lambda do |object_definitions|
        [
          {
            name: 'deployment_mode',
            control_type: 'select',
            pick_list: 'deployment_mode',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'Must match the mode used when the package was built.'
          },
          {
            name: 'id',
            label: 'Build or package ID',
            optional: false,
            hint: 'The ID from a completed build.'
          },
          {
            name: 'source_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment the package was built in.'
          },
          {
            name: 'target_environment',
            control_type: 'select',
            pick_list: 'target_environments',
            pick_list_params: { source_environment: 'source_environment' },
            toggle_hint: 'Use datapill',
            optional: true,
            hint: 'Optional. The environment to deploy to. If blank, ' \
                  'promotes to the next environment by level.'
          },
          {
            name: 'folder_id',
            label: 'Target folder ID',
            optional: true,
            ngIf: 'input.deployment_mode == "rlcm"',
            hint: 'RLCM only. The folder in the target environment to ' \
                  'import into.'
          },
          {
            name: 'restart_recipes',
            type: :boolean,
            control_type: 'checkbox',
            default: 'false',
            optional: true,
            ngIf: 'input.deployment_mode == "rlcm"',
            hint: 'RLCM only. When Yes, recipes are automatically restarted ' \
                  'after import. Defaults to No. Use with caution in production.'
          },
          {
            name: 'env_type',
            control_type: 'select',
            pick_list: 'target_environment_types',
            optional: true,
            ngIf: 'input.deployment_mode == "projects"',
            hint: 'Projects only. Select Test or Production to match the ' \
                  'target environment type.'
          },
          {
            name: 'description',
            optional: true,
            ngIf: 'input.deployment_mode == "projects"',
            hint: 'Projects only. Optional note attached to the deployment.'
          }
        ]
      end,

      execute: lambda do |connection, input, _eis, _eos, continue|
        continue    = continue || {}
        is_projects = input['deployment_mode'] == 'projects'

        # Determine target environment
        target_env = if input['target_environment'].present?
                       input['target_environment']
                     else
                       targets = call('get_target_environments', connection, {
                         'source_env' => input['source_environment']
                       })
                       if targets.blank?
                         error('No valid promotion target found for ' \
                               "#{input['source_environment']}.")
                       end
                       targets.first['name']
                     end

        if continue['job_id'].blank?
          # ── First invocation: start deployment ────────────
          if is_projects
            headers = call('get_auth_headers', connection, target_env)
            dc      = call('get_datacenter', connection, target_env)
            url     = call('build_endpoint', dc, input['id'],
                           is_projects, 'deploy')

            payload = {
              'environment_type' => input['env_type'],
              'description'      => input['description']
            }.compact

            response = post(url)
                         .headers(headers)
                         .payload(payload)
                         .after_error_response(/.*/) do |_c, b, _h, m|
                           error("Deploy failed: #{m} — #{b}")
                         end
          else
            # RLCM: download from source, upload to target
            src_headers = call('get_auth_headers', connection,
                               input['source_environment'])
            src_dc      = call('get_datacenter', connection,
                               input['source_environment'])

            download_url = call('build_endpoint', src_dc, input['id'],
                                false, 'download')

            pkg = call('download_package', {
              'headers'         => src_headers,
              'download_url'    => download_url,
              'env_name'        => input['source_environment'],
              'package_id'      => input['id'],
              'deployment_mode' => 'rlcm'
            })

            tgt_headers = call('get_auth_headers', connection, target_env)
            tgt_dc      = call('get_datacenter', connection, target_env)

            folder_id      = input['folder_id']
            restart_flag   = input['restart_recipes'].is_true? ? 'true' : 'false'
            import_url     = "#{tgt_dc}/packages/import/#{folder_id}" \
                             "?restart_recipes=#{restart_flag}"

            response = post(import_url)
                         .headers(tgt_headers.merge(
                           'Content-Type' => 'application/octet-stream'
                         ))
                         .request_body(pkg['content'])
                         .request_format_raw
                         .after_error_response(/.*/) do |_c, b, _h, m|
                           error("RLCM import failed: #{m} — #{b}")
                         end
          end

          status = call('normalize_status', response, is_projects)

          if status == 'success'
            { 'id' => response['id'], 'status' => status }
          else
            call('poll_or_reinvoke', {
              'status'   => status,
              'response' => response,
              'continue' => continue
            })
          end

        else
          # ── Reinvocation: check deployment status ─────────
          headers = call('get_auth_headers', connection, target_env)
          dc      = call('get_datacenter', connection, target_env)

          status_url = if is_projects
                         "#{dc}/project_builds/#{continue['job_id']}/deploy"
                       else
                         "#{dc}/packages/#{continue['job_id']}"
                       end

          response = get(status_url)
                       .headers(headers)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("Deployment status check failed: #{m} — #{b}")
                       end

          status = call('normalize_status', response, is_projects)

          if status == 'success'
            { 'id' => response['id'], 'status' => status }
          else
            call('poll_or_reinvoke', {
              'status'   => status,
              'response' => response,
              'continue' => continue
            })
          end
        end
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['deployment_obj']
      end
    },

    # Deploy package (async)
    deploy_package_async: {
      title: 'Deploy package (async)',
      subtitle: 'Start a deployment and return immediately',
      description: 'Starts a deployment without waiting for it to finish. ' \
                   'Returns the deployment ID and initial status. Use Get ' \
                   'deployment status to check progress. Useful when ' \
                   'deploying to multiple environments in parallel.',

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'deployment_mode',
            control_type: 'select',
            pick_list: 'deployment_mode',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'Must match the mode used when the package was built.'
          },
          {
            name: 'id',
            label: 'Build or package ID',
            optional: false,
            hint: 'The ID from a completed build.'
          },
          {
            name: 'source_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment the package was built in.'
          },
          {
            name: 'target_environment',
            control_type: 'select',
            pick_list: 'target_environments',
            pick_list_params: { source_environment: 'source_environment' },
            toggle_hint: 'Use datapill',
            optional: true,
            hint: 'Optional. If blank, promotes to the next level.'
          },
          {
            name: 'folder_id',
            label: 'Target folder ID',
            optional: true,
            ngIf: 'input.deployment_mode == "rlcm"',
            hint: 'RLCM only. Target folder for import.'
          },
          {
            name: 'restart_recipes',
            type: :boolean,
            control_type: 'checkbox',
            default: 'false',
            optional: true,
            ngIf: 'input.deployment_mode == "rlcm"',
            hint: 'RLCM only. Auto-restart recipes after import. ' \
                  'Defaults to No.'
          },
          {
            name: 'env_type',
            control_type: 'select',
            pick_list: 'target_environment_types',
            optional: true,
            ngIf: 'input.deployment_mode == "projects"',
            hint: 'Projects only. Target environment type.'
          },
          {
            name: 'description',
            optional: true,
            ngIf: 'input.deployment_mode == "projects"',
            hint: 'Projects only. Optional deployment note.'
          }
        ]
      end,

      execute: lambda do |connection, input|
        is_projects = input['deployment_mode'] == 'projects'

        target_env = if input['target_environment'].present?
                       input['target_environment']
                     else
                       targets = call('get_target_environments', connection, {
                         'source_env' => input['source_environment']
                       })
                       if targets.blank?
                         error('No valid promotion target found.')
                       end
                       targets.first['name']
                     end

        if is_projects
          headers = call('get_auth_headers', connection, target_env)
          dc      = call('get_datacenter', connection, target_env)
          url     = call('build_endpoint', dc, input['id'],
                         is_projects, 'deploy')

          payload = {
            'environment_type' => input['env_type'],
            'description'      => input['description']
          }.compact

          response = post(url)
                       .headers(headers)
                       .payload(payload)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("Deploy failed: #{m} — #{b}")
                       end
        else
          src_headers = call('get_auth_headers', connection,
                             input['source_environment'])
          src_dc      = call('get_datacenter', connection,
                             input['source_environment'])

          download_url = call('build_endpoint', src_dc, input['id'],
                              false, 'download')

          pkg = call('download_package', {
            'headers'         => src_headers,
            'download_url'    => download_url,
            'env_name'        => input['source_environment'],
            'package_id'      => input['id'],
            'deployment_mode' => 'rlcm'
          })

          tgt_headers = call('get_auth_headers', connection, target_env)
          tgt_dc      = call('get_datacenter', connection, target_env)

          restart_flag = input['restart_recipes'].is_true? ? 'true' : 'false'
          import_url   = "#{tgt_dc}/packages/import/#{input['folder_id']}" \
                         "?restart_recipes=#{restart_flag}"

          response = post(import_url)
                       .headers(tgt_headers.merge(
                         'Content-Type' => 'application/octet-stream'
                       ))
                       .request_body(pkg['content'])
                       .request_format_raw
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("RLCM import failed: #{m} — #{b}")
                       end
        end

        status = call('normalize_status', response, is_projects)
        { 'id' => response['id'], 'status' => status }
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['deployment_obj']
      end
    },

    # Get deployment status
    get_deployment: {
      title: 'Get deployment status',
      subtitle: 'Check the status of a deployment',
      description: 'Returns the current status of a deployment. Status is ' \
                   'normalized across both modes: in_progress, success, ' \
                   'or failed.',

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'deployment_mode',
            control_type: 'select',
            pick_list: 'deployment_mode',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'Must match the mode used for the deployment.'
          },
          {
            name: 'workato_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment the deployment was sent to.'
          },
          {
            name: 'id',
            label: 'Deployment ID',
            optional: false,
            hint: 'The ID returned by Deploy package.'
          }
        ]
      end,

      execute: lambda do |connection, input|
        env_name    = input['workato_environment']
        is_projects = input['deployment_mode'] == 'projects'
        headers     = call('get_auth_headers', connection, env_name)
        dc          = call('get_datacenter', connection, env_name)

        url = if is_projects
                "#{dc}/project_builds/#{input['id']}/deploy"
              else
                "#{dc}/packages/#{input['id']}"
              end

        response = get(url)
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Get deployment status failed: #{m} — #{b}")
                     end

        status = call('normalize_status', response, is_projects)
        { 'id' => response['id'], 'status' => status }
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['deployment_obj']
      end
    },

    # List folders
    list_folders: {
      title: 'List folders',
      subtitle: 'List folders in an environment',
      description: 'Returns folders from the selected environment. ' \
                   'Optionally filter by parent folder. Results are ' \
                   'paginated at 100 per page.',

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'workato_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment to list folders from.'
          },
          {
            name: 'parent_id',
            optional: true,
            hint: 'Optional. Folder ID to list only its children. ' \
                  'Leave blank for root-level folders.'
          },
          {
            name: 'page',
            type: :integer,
            default: '1',
            hint: 'Page number for pagination. Defaults to 1.'
          }
        ]
      end,

      execute: lambda do |connection, input|
        env_name = input['workato_environment']
        headers  = call('get_auth_headers', connection, env_name)
        dc       = call('get_datacenter', connection, env_name)

        page = input['page'] || 1
        url  = "#{dc}/folders?page=#{page}&per_page=100"
        url  = "#{url}&parent_id=#{input['parent_id']}" if input['parent_id'].present?

        response = get(url)
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("List folders failed: #{m} — #{b}")
                     end

        { 'folders_list' => response }
      end,

      output_fields: lambda do |object_definitions|
        [
          {
            name: 'folders_list',
            type: :array,
            of: :object,
            properties: object_definitions['folder_obj']
          }
        ]
      end
    },

    # Create folder
    create_folder: {
      title: 'Create folder',
      subtitle: 'Create a new folder in an environment',
      description: 'Creates a folder in the selected environment. ' \
                   'Optionally nest it under a parent folder.',

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'workato_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment to create the folder in.'
          },
          {
            name: 'folder_name',
            optional: false,
            hint: 'The name for the new folder.'
          },
          {
            name: 'parent_id',
            optional: true,
            hint: 'Optional. Parent folder ID. Leave blank for root level.'
          }
        ]
      end,

      execute: lambda do |connection, input|
        env_name = input['workato_environment']
        headers  = call('get_auth_headers', connection, env_name)
        dc       = call('get_datacenter', connection, env_name)

        post("#{dc}/folders")
          .headers(headers)
          .payload({
            'name'      => input['folder_name'],
            'parent_id' => input['parent_id']
          }.compact)
          .after_error_response(/.*/) do |_c, b, _h, m|
            error("Create folder failed: #{m} — #{b}")
          end
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['folder_obj']
      end
    },

    # ── Get recipe ────────────────────────────────────────────
    get_recipe: {
      title: 'Get recipe',
      subtitle: 'Get full details for a single recipe, including its code',
      help: lambda do |input, picklist_label|
        {
          body: 'Returns the full definition of one recipe, including the code field (the JSON step tree). Unlike List recipes, the single-recipe endpoint always returns code, so this is the action to use when you need the recipe body for inspection or spec generation.'
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: 'workato_environment', control_type: 'select', pick_list: 'environments', toggle_hint: 'Use datapill', optional: false, hint: 'The environment the recipe is in.' },
          { name: 'recipe_id', label: 'Recipe ID', optional: false, hint: 'The ID of the recipe to fetch.' },
          { name: 'include_tags', type: :boolean, control_type: 'checkbox', default: 'false', optional: true, hint: 'When Yes, includes tag handles in the response. Defaults to No.' }
        ]
      end,

      execute: lambda do |connection, input|
        env_name = input['workato_environment']
        headers  = call('get_auth_headers', connection, env_name)
        dc       = call('get_datacenter', connection, env_name)

        url = "#{dc}/recipes/#{input['recipe_id']}"
        url = "#{url}?includes[]=tags" if input['include_tags'].is_true?

        get(url)
          .headers(headers)
          .after_error_response(/.*/) do |_c, b, _h, m|
            error("Get recipe failed: #{m} — #{b}")
          end
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['recipe_detail_obj']
      end
    },

    # ── Recipe to spec (pure transform) ───────────────────────
    recipe_to_spec: {
      title: 'Recipe to spec',
      subtitle: "Walk a recipe's code tree into a contract spec",
      description: 'Pure transform: takes a recipe code JSON string (from ' \
                   'Get recipe, a package export, or a stored snapshot) and ' \
                   'emits a contract-style spec. No API call is made. When ' \
                   'inspecting a live recipe, prefer Inspect recipe, which ' \
                   'fetches and transforms in one step.',

      input_fields: lambda do |_object_definitions|
        [
          { name: 'code',             label: 'Recipe code (JSON string)', optional: false, hint: 'The <b>code</b> field from GET /api/recipes/:id.' },
          { name: 'recipe_id',        label: 'Recipe ID',                 optional: true },
          { name: 'recipe_name',      label: 'Recipe name',               optional: true },
          { name: 'folder',           label: 'Folder or project path',    optional: true },
          { name: 'output_step_hint', label: 'Output step hint',          optional: true,  hint: 'Substring matched against a step name/title to choose the return/response step (e.g. "return", "respond"). Leave blank to use the last step.' }
        ]
      end,

      execute: lambda do |_connection, input|
        call('build_spec', {
          'code'             => input['code'],
          'recipe_id'        => input['recipe_id'],
          'recipe_name'      => input['recipe_name'],
          'folder'           => input['folder'],
          'output_step_hint' => input['output_step_hint']
        })
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: 'spec_json',        label: 'Spec (JSON string)' },
          { name: 'recipe_name' },
          { name: 'trigger_provider' },
          { name: 'trigger_name' },
          { name: 'step_count', type: 'integer' },
          { name: 'connectors_used', type: 'array', of: 'string' },
          { name: 'input_contract',  type: 'array', of: 'object', properties: object_definitions['contract_field'] },
          { name: 'output_contract', type: 'array', of: 'object', properties: object_definitions['contract_field'] },
          { name: 'steps', type: 'array', of: 'object', properties: [
            { name: 'path' },
            { name: 'depth', type: 'integer' },
            { name: 'keyword' },
            { name: 'provider' },
            { name: 'name' },
            { name: 'as' },
            { name: 'title' }
          ] },
          { name: 'log' }
        ]
      end
    },

    # ── Inspect recipe (fetch + spec composite) ───────────────
    inspect_recipe: {
      title: 'Inspect recipe',
      subtitle: 'Fetch a recipe and emit its contract spec in one call',
      description: 'Composite of Get recipe and Recipe to spec: fetches the ' \
                   'full recipe definition from the selected environment, ' \
                   'then walks its code tree into a contract spec. Recipe ' \
                   'ID, name, folder, and environment are stamped into the ' \
                   'spec from the live fetch, and connection bindings from ' \
                   'the recipe config block are folded in. Use in a List ' \
                   'recipes → repeat loop for estate-wide spec generation ' \
                   'and drift detection.',

      input_fields: lambda do |_object_definitions|
        [
          { name: 'workato_environment', control_type: 'select', pick_list: 'environments', toggle_hint: 'Use datapill', optional: false, hint: 'The environment the recipe is in.' },
          { name: 'recipe_id',        label: 'Recipe ID', optional: false, hint: 'The ID of the recipe to fetch and inspect.' },
          { name: 'output_step_hint', label: 'Output step hint', optional: true, hint: 'Substring matched against a step name/title to choose the return/response step (e.g. "return", "respond"). Leave blank to use the last step.' },
          { name: 'include_tags',     type: :boolean, control_type: 'checkbox', default: 'false', optional: true, hint: 'When Yes, tag handles are fetched and passed through in the output. Defaults to No.' }
        ]
      end,

      execute: lambda do |connection, input|
        env_name = input['workato_environment']
        headers  = call('get_auth_headers', connection, env_name)
        dc       = call('get_datacenter', connection, env_name)

        url = "#{dc}/recipes/#{input['recipe_id']}"
        url = "#{url}?includes[]=tags" if input['include_tags'].is_true?

        recipe = get(url)
                   .headers(headers)
                   .after_error_response(/.*/) do |_c, b, _h, m|
                     error("Inspect recipe fetch failed: #{m} — #{b}")
                   end

        if recipe['code'].blank?
          error("Recipe #{input['recipe_id']} returned no code field.")
        end

        bindings = (recipe['config'] || []).map do |c|
          {
            'keyword'    => c['keyword'],
            'provider'   => c['provider'],
            'name'       => c['name'],
            'account_id' => c['account_id']
          }.compact
        end

        spec = call('build_spec', {
          'code'                => recipe['code'],
          'recipe_id'           => recipe['id'].to_s,
          'recipe_name'         => recipe['name'],
          'folder'              => recipe['folder_id'].to_s,
          'environment'         => env_name,
          'output_step_hint'    => input['output_step_hint'],
          'connection_bindings' => bindings
        })

        spec.merge(
          'workato_environment' => env_name,
          'recipe_id'           => recipe['id'],
          'folder_id'           => recipe['folder_id'],
          'running'             => recipe['running'],
          'version_no'          => recipe['version_no'],
          'updated_at'          => recipe['updated_at'],
          'tags'                => recipe['tags']
        ).compact
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: 'spec_json', label: 'Spec (JSON string)' },
          { name: 'workato_environment' },
          { name: 'recipe_id', type: :integer },
          { name: 'recipe_name' },
          { name: 'folder_id', type: :integer },
          { name: 'running', type: :boolean },
          { name: 'version_no', type: :integer },
          { name: 'updated_at' },
          { name: 'trigger_provider' },
          { name: 'trigger_name' },
          { name: 'step_count', type: :integer },
          { name: 'connectors_used', type: :array, of: :string },
          { name: 'connection_bindings', type: :array, of: :object, properties: [
            { name: 'keyword' },
            { name: 'provider' },
            { name: 'name' },
            { name: 'account_id', type: :integer }
          ] },
          { name: 'input_contract',  type: :array, of: :object, properties: object_definitions['contract_field'] },
          { name: 'output_contract', type: :array, of: :object, properties: object_definitions['contract_field'] },
          { name: 'steps', type: :array, of: :object, properties: [
            { name: 'path' },
            { name: 'depth', type: :integer },
            { name: 'keyword' },
            { name: 'provider' },
            { name: 'name' },
            { name: 'as' },
            { name: 'title' }
          ] },
          { name: 'tags', type: :array, of: :string },
          { name: 'log' }
        ]
      end
    },

    # List recipes
    list_recipes: {
      title: 'List recipes',
      subtitle: 'List recipes in an environment',
      description: 'Returns recipes from the selected environment. ' \
                   'Optionally filter to a specific folder.',

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'workato_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment to list recipes from.'
          },
          {
            name: 'folder_id',
            optional: true,
            hint: 'Optional. Folder ID to list only recipes in that folder.'
          }
        ]
      end,

      execute: lambda do |connection, input|
        env_name = input['workato_environment']
        headers  = call('get_auth_headers', connection, env_name)
        dc       = call('get_datacenter', connection, env_name)

        url = "#{dc}/recipes"
        url = "#{url}?folder_id=#{input['folder_id']}" if input['folder_id'].present?

        response = get(url)
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("List recipes failed: #{m} — #{b}")
                     end

        { 'items' => response['items'] || response }
      end,

      output_fields: lambda do |object_definitions|
        [
          {
            name: 'items',
            type: :array,
            of: :object,
            properties: object_definitions['recipe_obj']
          }
        ]
      end
    },

    # Manage recipe
    manage_recipe: {
      title: 'Manage recipe',
      subtitle: 'Start, stop, or delete a recipe',
      description: 'Performs a lifecycle action on a single recipe. Start ' \
                   'activates the recipe. Stop pauses it. Delete ' \
                   'permanently removes it.',

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'workato_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment the recipe is in.'
          },
          {
            name: 'recipe_action',
            control_type: 'select',
            pick_list: 'recipe_actions',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The action to perform: Start, Stop, or Delete.'
          },
          {
            name: 'recipe_id',
            optional: false,
            hint: 'The ID of the recipe to manage.'
          }
        ]
      end,

      execute: lambda do |connection, input|
        env_name = input['workato_environment']
        headers  = call('get_auth_headers', connection, env_name)
        dc       = call('get_datacenter', connection, env_name)
        action   = input['recipe_action']
        url      = "#{dc}/recipes/#{input['recipe_id']}"

        response = if action == 'delete'
                     delete(url)
                       .headers(headers)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("Delete recipe failed: #{m} — #{b}")
                       end
                   else
                     put("#{url}/#{action}")
                       .headers(headers)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("#{action.capitalize} recipe failed: " \
                               "#{m} — #{b}")
                       end
                   end

        { 'result' => response['success'] || true }
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['api_result_obj']
      end
    },

    # Upsert account properties
    upsert_properties: {
      title: 'Upsert account properties',
      subtitle: 'Create or update environment-level properties',
      description: 'Sets one or more account properties in the selected ' \
                   'environment. Existing properties are updated; new ones ' \
                   'are created. Commonly used to push environment-specific ' \
                   'configuration during deployment.',

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'workato_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment to set properties in.'
          },
          {
            name: 'properties',
            type: :array,
            of: :object,
            optional: false,
            hint: 'A list of name/value pairs.',
            properties: [
              { name: 'name', optional: false },
              { name: 'value', optional: false }
            ]
          }
        ]
      end,

      execute: lambda do |connection, input|
        env_name = input['workato_environment']
        headers  = call('get_auth_headers', connection, env_name)
        dc       = call('get_datacenter', connection, env_name)

        # Transform [{name:k, value:v}] → { k: v }
        props_hash = (input['properties'] || []).each_with_object({}) do |p, h|
          h[p['name']] = p['value']
        end

        response = post("#{dc}/properties")
                     .headers(headers)
                     .payload({ 'properties' => props_hash })
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Upsert properties failed: #{m} — #{b}")
                     end

        { 'result' => response['success'] || true }
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['api_result_obj']
      end
    },

    # List connections
    list_connections: {
      title: 'List connections',
      subtitle: 'List all connections in an environment',
      description: 'Returns all connections configured in the selected ' \
                   'environment, including provider type and connection status.',

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'workato_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment to list connections from.'
          }
        ]
      end,

      execute: lambda do |connection, input|
        env_name = input['workato_environment']
        headers  = call('get_auth_headers', connection, env_name)
        dc       = call('get_datacenter', connection, env_name)

        response = get("#{dc}/connections")
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("List connections failed: #{m} — #{b}")
                     end

        { 'connections' => response }
      end,

      output_fields: lambda do |object_definitions|
        [
          {
            name: 'connections',
            type: :array,
            of: :object,
            properties: [
              { name: 'id', type: :integer },
              { name: 'name' },
              { name: 'provider' },
              { name: 'connected', type: :boolean }
            ]
          }
        ]
      end
    },

    # List account properties
    list_properties: {
      title: 'List account properties',
      subtitle: 'List all properties in an environment',
      description: 'Returns all account-level properties configured in the ' \
                   'selected environment.',

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'workato_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment to list properties from.'
          }
        ]
      end,

      execute: lambda do |connection, input|
        env_name = input['workato_environment']
        headers  = call('get_auth_headers', connection, env_name)
        dc       = call('get_datacenter', connection, env_name)

        response = get("#{dc}/properties")
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("List properties failed: #{m} — #{b}")
                     end

        { 'properties' => response }
      end,

      output_fields: lambda do |object_definitions|
        [
          {
            name: 'properties',
            type: :array,
            of: :object,
            properties: [
              { name: 'name' },
              { name: 'value' }
            ]
          }
        ]
      end
    },

    # Lookup folder by path
    lookup_folder_by_path: {
      title: 'Lookup folder by path',
      subtitle: 'Resolve a folder path to a folder ID',
      description: 'Walks the folder tree to find a folder by its path ' \
                   '(e.g. /Team/Project/Subfolder). Returns the folder ' \
                   'details including its ID. Each path segment is matched ' \
                   'by exact folder name.',

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'workato_environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment to search in.'
          },
          {
            name: 'path',
            optional: false,
            hint: 'Forward-slash separated folder path. Example: ' \
                  '/Client Automations/Onboarding/Templates'
          }
        ]
      end,

      execute: lambda do |connection, input|
        env_name = input['workato_environment']
        headers  = call('get_auth_headers', connection, env_name)
        dc       = call('get_datacenter', connection, env_name)

        segments = input['path']
                     .split('/')
                     .reject(&:blank?)

        if segments.blank?
          error('Path cannot be empty.')
        end

        current_parent_id = nil
        current_folder    = nil

        segments.each do |segment|
          url = "#{dc}/folders?per_page=100"
          url = "#{url}&parent_id=#{current_parent_id}" if current_parent_id.present?

          folders = get(url)
                      .headers(headers)
                      .after_error_response(/.*/) do |_c, b, _h, m|
                        error("Folder lookup failed at '#{segment}': " \
                              "#{m} — #{b}")
                      end

          # folders may be an array or wrapped in a key
          folder_list = folders.is_a?(Array) ? folders : (folders['items'] || folders)

          match = folder_list.find { |f| f['name'] == segment }

          if match.nil?
            error("Folder '#{segment}' not found under " \
                  "#{current_parent_id || 'root'}.")
          end

          current_folder    = match
          current_parent_id = match['id']
        end

        current_folder
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['folder_obj']
      end
    }
  },

  # --- TRIGGERS ----------------------------------------------------
  triggers: {

    new_build_completed: {
      title: 'New completed build',
      subtitle: 'Triggers when a build completes successfully',
      description: 'Polls for newly completed builds in the selected ' \
                   'environment. Only successful builds trigger the recipe. ' \
                   'Checks every 5 minutes by default.',
      type: :paging_desc,

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'deployment_mode',
            control_type: 'select',
            pick_list: 'deployment_mode',
            optional: false,
            hint: 'Select Projects or RLCM to match your workspace setup.'
          },
          {
            name: 'workato_environment',
            control_type: 'select',
            pick_list: 'environments',
            optional: false,
            hint: 'The environment to monitor for completed builds.'
          }
        ]
      end,

      poll: lambda do |connection, input, closure|
        closure    = closure || {}
        env_name   = input['workato_environment']
        is_projects = input['deployment_mode'] == 'projects'
        headers    = call('get_auth_headers', connection, env_name)
        dc         = call('get_datacenter', connection, env_name)

        since = closure['since'] || (now - 1.hour).utc.iso8601

        url = if is_projects
                "#{dc}/project_builds?since=#{since}"
              else
                "#{dc}/packages?since=#{since}"
              end

        response = get(url)
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Trigger poll failed: #{m} — #{b}")
                     end

        items = (response.is_a?(Array) ? response : (response['items'] || []))

        # Filter to successful builds and normalize
        completed = items.select do |item|
          status = call('normalize_status', item, is_projects)
          status == 'success'
        end

        builds = completed.map do |item|
          {
            'id'                  => item['id'],
            'status'              => 'success',
            'deployment_mode'     => input['deployment_mode'],
            'workato_environment' => env_name,
            'source_reference'    => item['project_id'] || item['manifest_id'],
            'download_url'        => item['download_url']
          }
        end

        next_since = if builds.present?
                       now.utc.iso8601
                     else
                       since
                     end

        {
          events: builds,
          next_poll: { 'since' => next_since },
          can_poll_more: false
        }
      end,

      dedup: lambda do |record|
        record['id']
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['build_obj']
      end
    }
  },

  # --- PICK LISTS --------------------------------------------------
  pick_lists: {

    deployment_mode: lambda do
      [
        ['Projects (Environments)', 'projects'],
        ['Recipe Lifecycle Management', 'rlcm']
      ]
    end,

    environments: lambda do |connection|
      (connection['workato_environments'] || []).map do |env|
        [env['name'], env['name']]
      end
    end,

    target_environments: lambda do |connection, source_environment:|
      targets = call('get_target_environments', connection, {
        'source_env' => source_environment
      })
      targets.map { |env| [env['name'], env['name']] }
    end,

    target_environment_types: lambda do
      [
        %w[Test test],
        %w[Production prod]
      ]
    end,

    recipe_actions: lambda do
      [
        %w[Start start],
        %w[Stop stop],
        %w[Delete delete]
      ]
    end
  }
}
