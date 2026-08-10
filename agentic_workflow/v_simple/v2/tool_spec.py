"""Tool surface for the SDC corpus Q&A agent — Milestone 1.

Single source of truth for the six tools: names, descriptions, parameter
schemas, and output shapes. One spec, two uses:

    from tool_spec import TOOLS, gemini_declarations
    tools = gemini_declarations()   # -> pass to google-genai as function decls
    TOOLS                           # -> the contract your dispatch code implements

Design rules encoded here (violating one is a design bug, not a style choice):

  1. No tool ever returns a raw code tree. Bounded summaries by default,
     drill-down (get_step) on demand.
  2. Every list result is bounded: a `limit` parameter with a default, and
     `count` + `truncated` in the output so the model knows what it didn't see.
  3. Every row carries enough identity to drill down: recipe_id and
     step_path travel with everything.
  4. `snapshot_id` is accepted everywhere, defaults to latest, and is
     ECHOED in every result — a tool answer that doesn't say which snapshot
     produced it can silently be a fossil. M1 only uses latest; the
     parameter exists so M2 diffing needs no signature change.
  5. Errors are returned, not raised: {"error": "...", "hint": "..."} with the
     hint naming the tool call that would fix it. An agent can act on a hint;
     it can only apologize for a stack trace.
  6. Empty must explain itself. count=0 is not an error, but it is not
     self-evident either: name-filtered queries that match nothing include a
     `hint` with nearby known names, so "no rows" is distinguishable from
     "misspelled filter" without a debugging cycle.

The `returns` block on each tool is documentation for the implementer AND is
folded into the description Gemini sees (models call tools better when they
know what comes back). gemini_declarations() handles the folding and strips
the non-standard key.
"""

import copy
import json

# Shared parameter fragments -------------------------------------------------

_SNAPSHOT_PARAM = {
    "type": "integer",
    "description": "Snapshot to query. Omit for the latest snapshot (the normal case).",
}

def _limit_param(default, cap):
    return {
        "type": "integer",
        "description": f"Max rows to return. Default {default}, cap {cap}.",
    }

# The six tools ---------------------------------------------------------------

TOOLS = [
    {
        "name": "list_recipes",
        "description": (
            "List recipes in the corpus with identity and trigger info. "
            "Start here to resolve a human name ('UPL-01', 'the MARS join recipe') "
            "to a recipe_id before calling anything else."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name_contains": {
                    "type": "string",
                    "description": "Case-insensitive substring filter on recipe name, e.g. 'UPL' or 'validate'.",
                },
                "trigger_provider": {
                    "type": "string",
                    "description": "Filter by trigger provider, e.g. 'workato_recipe_function', 'workato_webhooks'.",
                },
                "project": {"type": "string", "description": "Filter by project name."},
                "unfinished_only": {
                    "type": "boolean",
                    "description": "If true, return only recipes flagged unfinished.",
                },
                "limit": _limit_param(50, 100),
                "snapshot_id": _SNAPSHOT_PARAM,
            },
            "required": [],
        },
        "returns": {
            "snapshot_id": "int — snapshot actually queried",
            "count": "int — rows returned",
            "truncated": "bool — true if more rows matched than limit",
            "hint": "str|absent — on count=0 with name_contains: nearest known recipe names",
            "recipes": [
                {
                    "recipe_id": "str",
                    "name": "str",
                    "project": "str|null",
                    "trigger": "str — 'provider.name (keyword)'",
                    "step_count": "int",
                    "unfinished": "bool",
                }
            ],
        },
    },
    {
        "name": "get_recipe_summary",
        "description": (
            "Structural summary of one recipe: trigger, step skeleton (paths, "
            "keywords, providers — no inputs), edge counts, and callers. This is "
            "the orientation view; use get_step for the detail of any one step."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "recipe_id": {"type": "string", "description": "Recipe id from list_recipes."},
                "snapshot_id": _SNAPSHOT_PARAM,
            },
            "required": ["recipe_id"],
        },
        "returns": {
            "snapshot_id": "int — snapshot actually queried",
            "recipe_id": "str",
            "name": "str",
            "project": "str|null",
            "trigger": {"provider": "str", "name": "str", "keyword": "str"},
            "fingerprint": "str",
            "skeleton": [
                {
                    "step_path": "str — e.g. '0/2/1'; pass to get_step",
                    "depth": "int",
                    "keyword": "str — action|if|foreach|catch|...",
                    "provider": "str",
                    "name": "str",
                }
            ],
            "edges_out": "dict — counts by kind, e.g. {'call_sync': 2, 'table_write': 3}",
            "edges_in": "dict — counts by kind",
            "callers": ["str — names of recipes that call this one"],
        },
    },
    {
        "name": "get_step",
        "description": (
            "Full detail for exactly one step: its input with data-table field "
            "UUIDs resolved to human field names, the datapills it references, "
            "and any edges originating at this step. The only tool that returns "
            "step inputs — everything else returns locations."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "recipe_id": {"type": "string", "description": "Recipe id from list_recipes."},
                "step_path": {
                    "type": "string",
                    "description": "Tree position from get_recipe_summary, e.g. '0/2/1'.",
                },
                "snapshot_id": _SNAPSHOT_PARAM,
            },
            "required": ["recipe_id", "step_path"],
        },
        "returns": {
            "snapshot_id": "int — snapshot actually queried",
            "recipe_id": "str",
            "step_path": "str",
            "number": "int — Workato display number (for talking to humans; not stable)",
            "keyword": "str",
            "provider": "str",
            "name": "str",
            "input": "dict — input subtree; keys matching table_fields.field_key rewritten to 'field_name (field_key)'",
            "datapills": [
                {
                    "provider": "str",
                    "pill_path": "str",
                    "table": "str|null — resolved table name",
                    "field": "str|null — resolved field name",
                }
            ],
            "edges_from_step": [
                {"kind": "str", "dst_type": "str", "dst_name": "str",
                 "resolved": "bool — false: target not in this snapshot"}
            ],
        },
    },
    {
        "name": "find_edges",
        "description": (
            "Query typed relationships across the corpus. The workhorse for "
            "impact questions. Examples: who writes WFA_SupplierRequest -> "
            "kind='table_write', dst_name_contains='WFA_SupplierRequest'. "
            "What does UPL-01 call -> src_recipe_id=<id>, kind omitted, "
            "dst_type='recipe'. Rows where resolved=false mean the target is "
            "NOT PRESENT in this snapshot — an external call, a deleted table, "
            "or a cross-workspace reference. That is a finding: report it, "
            "don't drop it. (Names resolvable within the snapshot are already "
            "backfilled at derive time.)"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["call_sync", "call_async", "table_read",
                             "table_write", "connection", "property"],
                    "description": "Edge kind. Omit for all kinds.",
                },
                "src_recipe_id": {"type": "string", "description": "Filter: edges originating in this recipe."},
                "dst_type": {
                    "type": "string",
                    "enum": ["recipe", "table", "connection", "property"],
                    "description": "Filter: destination category.",
                },
                "dst_id": {
                    "type": "string",
                    "description": "Filter: exact destination id. Recipe ids and NUMERIC table ids (the id-space recipe code uses) — never table UUIDs.",
                },
                "dst_name_contains": {
                    "type": "string",
                    "description": "Case-insensitive substring filter on destination name.",
                },
                "limit": _limit_param(100, 300),
                "snapshot_id": _SNAPSHOT_PARAM,
            },
            "required": [],
        },
        "returns": {
            "snapshot_id": "int — snapshot actually queried",
            "count": "int",
            "truncated": "bool",
            "hint": "str|absent — on count=0 with dst_name_contains: nearest known dst names",
            "edges": [
                {
                    "kind": "str",
                    "src_recipe_id": "str",
                    "src_recipe_name": "str",
                    "src_step_path": "str|null — null means recipe-level dependency",
                    "dst_type": "str",
                    "dst_id": "str|null",
                    "dst_name": "str|null",
                    "detail": "dict|null — e.g. {'columns': ['field_name', ...]} with keys resolved",
                    "resolved": "bool — false: target not in this snapshot",
                }
            ],
        },
    },
    {
        "name": "trace_datapill",
        "description": (
            "Blast radius for one data-table field: every step that writes it "
            "(from table_write edges) and every step that consumes it via a "
            "datapill reference. THE tool for 'what breaks if I rename or "
            "repurpose this column' — and for any field-level question, since "
            "raw step inputs key columns by UUID, not name (search_steps will "
            "not find field names in table writes)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "table_name": {
                    "type": "string",
                    "description": "Data table name, e.g. 'WFA_SupplierRequest'. Exact match, case-insensitive.",
                },
                "field_name": {
                    "type": "string",
                    "description": "Field name within the table, e.g. 'template_file_id'. Exact match, case-insensitive.",
                },
                "snapshot_id": _SNAPSHOT_PARAM,
            },
            "required": ["table_name", "field_name"],
        },
        "returns": {
            "snapshot_id": "int — snapshot actually queried",
            "table_id": "str — numeric code-side id",
            "table_name": "str",
            "field_uuid": "str",
            "field_name": "str",
            "writers": [
                {"recipe_id": "str", "recipe_name": "str", "step_path": "str"}
            ],
            "consumers": [
                {"recipe_id": "str", "recipe_name": "str", "step_path": "str",
                 "step_provider": "str — where the pill is used"}
            ],
        },
    },
    {
        "name": "search_steps",
        "description": (
            "Text search over step inputs, including py_eval code bodies. "
            "Returns locations with a short context window, never full bodies — "
            "follow up with get_step. Use for: finding hardcoded literals "
            "('pending_review'), locating a function name, finding every step "
            "that mentions a schema version. NOT for data-table field names: "
            "raw inputs key columns by UUID, so field-name text will miss "
            "table writes — use trace_datapill for field references."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "Literal text to find (case-insensitive). Not a regex.",
                },
                "provider": {
                    "type": "string",
                    "description": "Restrict to one provider, e.g. 'py_eval', 'workato_db_table'.",
                },
                "limit": _limit_param(50, 100),
                "snapshot_id": _SNAPSHOT_PARAM,
            },
            "required": ["text"],
        },
        "returns": {
            "snapshot_id": "int — snapshot actually queried",
            "count": "int",
            "truncated": "bool",
            "matches": [
                {
                    "recipe_id": "str",
                    "recipe_name": "str",
                    "step_path": "str",
                    "provider": "str",
                    "context": "str — ±80 chars around the first match in that step",
                    "match_count_in_step": "int",
                }
            ],
        },
    },
]

# Error contract (implemented by the dispatch layer, documented here) ----------
#
# Any tool, on failure, returns instead of its normal shape:
#     {"error": "<what went wrong>", "hint": "<the call that would fix it>"}
# Examples:
#     {"error": "recipe_id '999' not found in snapshot 12",
#      "hint": "call list_recipes(name_contains=...) to resolve the id"}
#     {"error": "field 'template_fileid' not found on WFA_SupplierRequest",
#      "hint": "closest field names: template_file_id, template_project_id"}
#
# Distinct from rule 6: an invalid REFERENCE (unknown table, unknown recipe)
# is an error with a hint; a valid reference with zero matches is a legitimate
# empty result — itself a fact — carrying a hint only when a name filter
# suggests a near-miss.


def gemini_declarations(fold_returns=True):
    """TOOLS -> function declarations for google-genai.

    Deep-copies, optionally folds each tool's `returns` shape into its
    description (models select and chain tools better when they know the
    output shape), and strips the non-standard `returns` key.

    Usage:
        from google import genai
        from google.genai import types
        client = genai.Client(vertexai=True, project=..., location=...)
        cfg = types.GenerateContentConfig(tools=[
            types.Tool(function_declarations=gemini_declarations())
        ])
    """
    decls = []
    for tool in copy.deepcopy(TOOLS):
        returns = tool.pop("returns", None)
        if fold_returns and returns is not None:
            tool["description"] = (
                tool["description"].rstrip()
                + " Returns: " + json.dumps(returns, separators=(",", ":"))
            )
        decls.append(tool)
    return decls


if __name__ == "__main__":
    decls = gemini_declarations()
    print(f"{len(decls)} tool declarations, all JSON-serializable:")
    for d in decls:
        req = ", ".join(d["parameters"].get("required", [])) or "-"
        print(f"  {d['name']:<20} required: {req}")
    json.dumps(decls)  # raises if anything non-serializable slipped in