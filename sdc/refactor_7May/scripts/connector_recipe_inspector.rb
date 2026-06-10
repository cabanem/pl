# SDC Recipe Inspector — connectionless transform connector
#
# Pure function: takes a recipe `code` JSON string (the value of the `code`
# field from GET /api/recipes/:id) and emits a contract-style spec.
#
# Fold `recipe_to_spec` and the two methods into your existing SDC connector.
# The connection/test stubs exist only so this runs standalone in the SDK
# console — paste a real `code` string into the input and you get the spec back
# with no connection required.
#
# DSL notes (verified against the current SDK docs):
#   * authorization { type: 'none' } is the supported no-auth form.
#   * `test` lives at the top level, beside `title`/`connection`.
#   * `parse_json(str)` is the bare helper; `obj.to_json` serializes back.
#   * Recursion is via methods + `call('name', args...)`, the idiomatic pattern.
#
# Design:
#   * Structural, not string-matching. We never interpret provider/name; they
#     pass through as opaque labels. We only read fields universal to every
#     step: number, keyword, as, block, extended_input_schema.
#   * `flatten_steps` is one pre-order pass returning a flat descriptor list.
#   * input_contract is authoritative (trigger's declared schema).
#     output_contract is a heuristic (return/response step) — `output_step_hint`
#     pins it; `log` reports when nothing convincing was found.

{
  title: 'SDC Recipe Inspector',

  connection: {
    fields: [],
    authorization: { type: 'none' }
  },

  test: lambda do |_connection|
    true
  end,

  methods: {
    # Reduce Workato's verbose per-step schema array to a compact field contract.
    compact_schema: lambda do |schema|
      (schema || []).map do |f|
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

    # Pre-order flatten of the step tree. Recurses on itself via `call`.
    # Carries `schema` so execute can read it off the trigger / output step;
    # it is stripped from the final inventory.
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

    # Fresh field list on every call. Never share one array across two
    # `properties:` slots — Workato tags/namespaces schema objects in place,
    # so a shared reference makes the second field collide with the first.
    contract_fields: lambda do
      [
        { name: 'name' },
        { name: 'label' },
        { name: 'type' },
        { name: 'control_type' },
        { name: 'optional', type: 'boolean' },
        { name: 'hint' }
      ]
    end
  },

  actions: {
    recipe_to_spec: {
      title: 'Recipe to spec',
      subtitle: "Walk a recipe's code tree into a contract spec",

      input_fields: lambda do |_object_definitions|
        [
          { name: 'code', label: 'Recipe code (JSON string)', optional: false,
            hint: 'The <b>code</b> field from GET /api/recipes/:id' },
          { name: 'recipe_id',   label: 'Recipe ID',   optional: true },
          { name: 'recipe_name', label: 'Recipe name', optional: true },
          { name: 'folder',      label: 'Folder / project path', optional: true },
          { name: 'output_step_hint', label: 'Output step hint', optional: true,
            hint: 'Substring matched against a step name/title to choose the ' \
                  'return/response step (e.g. "return", "respond"). ' \
                  'Leave blank to use the last step.' }
        ]
      end,

      execute: lambda do |_connection, input|
        log  = []
        tree = parse_json(input['code'])
        error('Recipe code did not parse to a step tree') unless tree.is_a?(::Hash)

        flat    = call('flatten_steps', tree, '0', 0)
        trigger = flat.first
        actions = flat[1..-1] || []

        providers = flat.map { |s| s['provider'] }.compact.uniq.sort

        # Input contract == trigger's declared schema (authoritative).
        input_contract = call('compact_schema', trigger['schema'])
        log << 'trigger declares no input schema' if input_contract.empty?

        # Output contract == return/response step's declared schema (heuristic).
        hint = input['output_step_hint'].to_s.strip.downcase
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
            'id'     => input['recipe_id'],
            'name'   => input['recipe_name'],
            'folder' => input['folder']
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

        {
          'spec_json'        => spec.to_json,
          'recipe_name'      => input['recipe_name'],
          'trigger_provider' => trigger['provider'],
          'trigger_name'     => trigger['name'],
          'step_count'       => steps.length,
          'connectors_used'  => providers,
          'input_contract'   => input_contract,
          'output_contract'  => output_contract,
          'steps'            => steps,
          'log'              => log.join('; ')
        }
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'spec_json',        label: 'Spec (JSON string)' },
          { name: 'recipe_name' },
          { name: 'trigger_provider' },
          { name: 'trigger_name' },
          { name: 'step_count', type: 'integer' },
          { name: 'connectors_used', type: 'array', of: 'string' },
          { name: 'input_contract',  type: 'array', of: 'object', properties: call('contract_fields') },
          { name: 'output_contract', type: 'array', of: 'object', properties: call('contract_fields') },
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
    }
  }
}
