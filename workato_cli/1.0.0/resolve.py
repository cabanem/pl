"""resolve — bind edge targets to the registries.

Targets arrive from extract carrying durable keys (flow_id, table_id, the
(table_id, field_id) pair); resolve swaps in the resolved label, preferring the
recipe author's logical column name over the live table name, which can drift.
Lifted out of slice_run so the slice, the corpus pass, and the oracle all
resolve identically.
"""
from __future__ import annotations

import sdc_recipe_model as M


def resolve(edges, rreg: M.RecipeRegistry, treg: M.TableSchemaRegistry):
    for e in edges:
        t = e.target
        if t.durable_key is None:
            continue
        if t.kind == M.TargetKind.recipe:
            e.target = rreg.resolve(t.durable_key)
        elif t.kind == M.TargetKind.table:
            e.target = treg.resolve_table(t.durable_key)
        elif t.kind == M.TargetKind.column:
            tid, fid = t.durable_key
            resolved = treg.resolve_column(tid, fid)
            # Prefer the recipe author's logical name; the live table name can drift.
            label = getattr(e.attrs, "recipe_label", None)
            if label:
                resolved = M.Target(M.TargetKind.column, t.durable_key, label, M.Resolution.resolved)
            e.target = resolved
    return edges
