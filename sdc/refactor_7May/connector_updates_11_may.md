I've read the connector. Two things stood out beyond the refactor target — worth flagging before drafting the changes.

## Latent gaps I noticed

Both are existing inconsistencies, not refactor work, but they're adjacent enough that I'd fix them in the same pass:

**`prior_values` is read but not declared.** The execute lambda has `prior_values = input["prior_values"] || {}`, but `prior_values` doesn't appear in `input_fields`. Workato will still pass it through if the recipe sets it, but the pill isn't visible in the editor and the schema lies about the action's interface. Refactor should declare it.

**`scope` is read on rules but not declared.** The execute lambda branches on `rule["scope"]` to dispatch cross-submission rules, and `composite_rules` filters by `%w[supplier engagement].include?(r["scope"])`. But neither `rule_definition` nor the extended rule properties in `validate_upload`'s `input_fields` declares `scope`. Same shape of issue as `prior_values`.

Both should be fixed when we touch the schema anyway.

## Refactor: `validate_upload`

### New `input_fields`

```ruby
input_fields: lambda do |object_definitions|
  [
    { name: "canonical_model_json", type: "string", control_type: "text-area",
      label: "Canonical model JSON",
      hint: "Resolved configuration JSON content. Contains cfg_fields, " \
            "cfg_rules, cfg_lookups, cfg_error_translations with FK resolution " \
            "applied. Read from FileStorage by the caller." },
    { name: "upload_data", type: "array", of: "object",
      label: "Upload rows",
      hint: "Array of {field_name: value} row objects." },
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
```

Gone: `fields`, `rules`, `lookups`, `error_translations` as discrete inputs. They now come from the canonical model.

### New execute lambda — parse section only

Replace the top of the existing execute with:

```ruby
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

  fields    = model["cfg_fields"]             || []
  rules     = model["cfg_rules"]              || []
  lookups   = model["cfg_lookups"]            || []
  err_trans = model["cfg_error_translations"] || []

  rows         = input["upload_data"]       || []
  variant_ids  = input["variant_field_ids"] || []
  prior_values = input["prior_values"]      || {}
  opts         = input["options"]           || {}

  apply_cleaning = opts["apply_cleaning"].nil? ? true : opts["apply_cleaning"]
  max_per_row    = opts["max_errors_per_row"]
  max_total      = opts["max_total_errors"]
  stop_first     = opts["stop_on_first_row_failure"] || false

  # ... rest of execute unchanged from here ...
end
```

Everything below the parse section — variant filtering, lookup index, the row loop, phase 3 column uniqueness, phase 3b composite uniqueness, the final return — stays identical. The engine doesn't care where its inputs came from.

The `error()` calls produce a crash that VAL-02's monitor catches. That matches the existing contract (status is `passed | failed`, not `error`).

## Refactor: `validate_config`

The change is the same shape, but the keys inside the parsed JSON stay un-prefixed (parsed config is pre-canonical-model, pre-FK-resolution).

### New `input_fields`

```ruby
input_fields: lambda do |_object_definitions|
  [
    { name: "parsed_config_json", type: "string", control_type: "text-area",
      label: "Parsed config JSON",
      hint: "Output of parse_config_file (parsed_config_json field). " \
            "Read from FileStorage by the caller." },
    { name: "form_field_limit", type: "integer", optional: true,
      label: "Form field limit",
      hint: "Maximum number of visible fields the manual-input form " \
            "supports. Defaults to 20.",
      default: "20" }
  ]
end,
```

Note: the deeply-nested `parsed_config` object schema is gone. The recipe just passes the JSON string content from FileStorage.

### New execute lambda — parse section only

Replace the top of the existing execute with:

```ruby
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

  form_field_limit = (input["form_field_limit"] || 20).to_i

  # ... rest of execute unchanged from here ...
end,
```

All the checks below — referential integrity, constraints, syntax — stay identical.

## Schema additions for the latent gaps

Two small things to add somewhere when you make these changes:

**Add `scope` to `rule_definition`** in `object_definitions`:

```ruby
rule_definition: {
  fields: lambda do |_connection, _config|
    [
      # ... existing fields ...
      { name: "strict_enforcement", type: "boolean" },
      { name: "scope", type: "string", optional: true,
        hint: "submission (default), supplier, or engagement. " \
              "Supplier/engagement-scope rules evaluate against prior_values." }
    ]
  end
},
```

This propagates into `validate_upload`'s rule input declaration automatically since it spreads from `rule_definition`.

## One naming decision needed

I've drafted with the convention that the **canonical model** uses `cfg_*` prefixed keys (`cfg_fields`, `cfg_rules`, etc.) and the **parsed config** stays un-prefixed (`fields`, `rules`, etc.). The prefix is the visible signal of "FK-resolved, ready for runtime."

This is consistent with how I sketched VAL-02's step 2 Python earlier (which reads `model['cfg_rules']`, `model['cfg_fields']`). It's also consistent with the data table naming (CFG_Field, CFG_Rule, CFG_Lookup).

If you'd rather keep both un-prefixed (canonical model uses `fields`/`rules`/`lookups`), the refactor's three-line change is in the parse section of `validate_upload`:

```ruby
fields    = model["fields"]             || []
rules     = model["rules"]              || []
lookups   = model["lookups"]            || []
err_trans = model["error_translations"] || []
```

Both work. The prefix is honest about what the model is (resolved); the absence is simpler. I lean prefixed for the signal value, but it's your call.

## Spec alignment

You mentioned uncertainty about whether the YAML spec is still aligned. I'd treat the connector code as truth for now — it's the deployed shape — and queue a spec re-alignment as a separate pass after these changes are in. Trying to keep both in sync during the refactor doubles the surface area for mistakes.

## What's next

If the refactor above looks right:

1. Pick a naming convention for canonical model keys (`cfg_*` vs unprefixed).
2. Apply the changes to both actions in the connector.
3. Add `scope` to `rule_definition` and confirm `prior_values` lands in the input schema.
4. Test the connector standalone — small canonical model fixture, a few rows, confirm verdict shape unchanged.
5. Return to VAL-02 implementation against the refactored action.

The actual edits are localized — two `input_fields` lambdas and two execute-lambda parse sections. Everything else in the connector is untouched. Ready to proceed when you've picked the naming?
