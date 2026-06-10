Let me confirm the exact shape the recipe detail endpoint returns so the output schema is accurate — especially that `code` comes back on a GET.Confirmed against the API docs: a GET on `/api/recipes/:id` returns the full recipe object, and the `code` field comes back as a JSON string describing each step — so the single-recipe endpoint is exactly what feeds the `recipe_to_spec` transform. Worth noting the asymmetry: the list endpoint accepts an `exclude_code` flag to avoid timeouts on lengthy recipes, but the single GET always includes `code`, which is why fetching one at a time is the right call for inspection.

Two additions, both matching your existing conventions (env resolution via `get_auth_headers`/`get_datacenter`, the `after_error_response(/.*/)` pattern, `is_true?` for booleans, output via an object definition).

First, a detail-level object definition. Drop this into `object_definitions`, right after `recipe_obj` — it's richer than the list shape because it carries `code` and `config`:

```ruby
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
```

Second, the action. Drop this into `actions`, alongside the other recipe actions (e.g. right after `list_recipes`):

```ruby
    # ── Get recipe ────────────────────────────────────────────
    get_recipe: {
      title: 'Get recipe',
      subtitle: 'Get full details for a single recipe, including its code',
      description: 'Returns the full definition of one recipe, including ' \
                   'the code field — the JSON step tree. Unlike List ' \
                   'recipes, the single-recipe endpoint always returns code, ' \
                   'so this is the action to use when you need the recipe ' \
                   'body for inspection or spec generation.',

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
            name: 'recipe_id',
            label: 'Recipe ID',
            optional: false,
            hint: 'The ID of the recipe to fetch.'
          },
          {
            name: 'include_tags',
            type: :boolean,
            control_type: 'checkbox',
            default: 'false',
            optional: true,
            hint: 'When Yes, includes tag handles in the response. ' \
                  'Defaults to No.'
          }
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
```

The execute returns the recipe object straight through, so it maps cleanly onto `recipe_detail_obj` the same way `get_environment_by_name` maps onto `environment_obj`.

That closes the loop on the pipeline from a few turns back: `list_recipes` to enumerate, `get_recipe` to pull each `code`, then the inspector connector's `recipe_to_spec` to turn that `code` pill into a contract. The one thing this connector and that one don't yet share is a workspace — if you'd rather not split across two connectors, the `recipe_to_spec` action folds into this file just as cleanly, since it's connectionless and wouldn't touch your `custom_auth` setup.
