# Spec Extraction Prompt — GAS Monday.com ↔ Smartsheet Bridge

> Paste this prompt into a conversation, followed by your script code.

---

## Prompt

You are a technical architect performing a **spec extraction** — reverse-engineering a declarative specification from existing code. The goal is NOT to fix or improve the code. The goal is to produce a spec that accurately describes **what the code currently does**, including any bugs, gaps, or questionable assumptions. I will audit the spec separately and correct it before regenerating code from it.

The code I'm providing is a **Google Apps Script** that bridges **Monday.com** and **Smartsheet**, with Google Sheets potentially acting as an intermediary or configuration layer.

Analyze the code and produce the spec as a **single structured YAML document**. Use the exact schema below — do not merge, rename, reorder, or omit sections.

```yaml
# ── Spec Extraction Output Schema ──

overview:
  summary: >
    # One-paragraph description of what this script does end-to-end.
  data_flow_direction: # e.g., "Monday → Sheets → Smartsheet", "bidirectional"
  trigger_mechanism: # e.g., "time-driven (every 5 min)", "onOpen menu item", "manual execution"

external_dependencies:
  # One entry per external system (Monday.com, Smartsheet, Google Sheets, any others)
  - system: # e.g., "Monday.com"
    authentication:
      method: # e.g., "API key from Script Properties", "OAuth", "hardcoded"
      credential_location: # e.g., "PropertiesService.getScriptProperties().getProperty('MONDAY_API_KEY')"
    api_surface:
      - endpoint_or_method: # e.g., "POST https://api.monday.com/v2 (GraphQL)"
        purpose: # what this call accomplishes
    assumed_permissions: [] # scopes or access levels the script requires

configuration_and_state:
  config_sources:
    - location: # e.g., "Script Properties", "sheet named 'Config'", "hardcoded constant"
      values:
        - name: # property/constant name
          type: # string, number, boolean, JSON, etc.
          hardcoded: # true/false
          description: # what it controls
  persistent_state:
    - name: # e.g., "last_sync_timestamp"
      storage: # where it's stored between runs
      purpose: # why the script needs to remember this

data_model_and_mapping:
  entities_transferred:
    - entity: # e.g., "Monday item → Smartsheet row"
      description: # what this entity represents in business terms
  field_mappings:
    - source_system: # e.g., "Monday.com"
      source_field: # column/field name or ID
      target_system: # e.g., "Smartsheet"
      target_field: # column/field name or ID
      transformation: # any formatting, type coercion, or logic applied (or "none")
  id_resolution:
    strategy: # how unique identifiers are matched across systems
    details: # specifics — mapping table location, key fields, lookup logic

function_inventory:
  # One entry for EVERY function, no matter how trivial
  - name: # function name
    purpose: # one sentence
    parameters:
      - name:
        type: # expected type
        description:
    return_value:
      type: # or "void"
      description: # meaning of the return value
    side_effects: [] # external calls, sheet writes, property mutations, logging
    dependencies:
      functions_called: [] # other functions this one invokes
      external_state_read: [] # properties, sheets, APIs it reads
    assumptions: [] # anything it assumes about inputs or environment

control_flow:
  entry_points:
    - function: # entry point function name
      trigger: # how it gets invoked
  execution_order:
    # Ordered list describing normal-run sequence
    - step: 1
      function:
      description:
  call_graph: |
    # Text-based representation of the call graph
    # e.g.:
    # main()
    #   ├─ fetchMondayItems()
    #   │    └─ mondayApiCall()
    #   ├─ transformData()
    #   └─ writeToSmartsheet()
    #        └─ smartsheetApiCall()

error_handling:
  api_error_strategy: # e.g., "try/catch with Logger.log", "HTTP status check", "unhandled"
  missing_record_behavior: # what happens if a record exists in one system but not the other
  partial_failure_behavior: # what happens when some but not all records sync
  rate_limit_handling: # any throttling, backoff, or batching logic (or "none observed")

observations:
  # Flags for potential issues — do NOT suggest fixes
  - location: # function name or line range
    observation: # what you noticed, stated factually
    potential_impact: # why it matters if this is indeed a problem
```

## Rules
- **Output the YAML document and nothing else.** No preamble, no summary, no markdown wrapping. Start with `overview:` and end with the last observation.
- Cover **every** function in `function_inventory`, no matter how trivial.
- Prefer concrete values over vague descriptions (e.g., `"reads MONDAY_API_KEY from Script Properties"` not `"reads config"`).
- If something is ambiguous in the code, say so explicitly in the relevant field rather than guessing.
- Use YAML block scalars (`>` or `|`) for multi-line text. Keep all values as valid YAML.

---

> **[Paste your Apps Script code below this line]**
