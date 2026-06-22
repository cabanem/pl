"""projections — read-only views over the resolved edge set.

Pure functions: resolved edges (plus registries / params) in, structures out.
No I/O, no registry mutation. Lifted from slice_run so the slice, the corpus
pass, and the oracle share one set of views.

The bridge projection (column_writers / single_owner_audit) is the point the
whole model was built toward: it joins the two write paths to the supplier-
request columns — direct table-API writes_column edges, and WFA add/update
whose sets_fields carry the same field_ids — so "who writes this column, and by
which path" is answerable, and the STS-01 single-writer invariant becomes a
report rather than a belief.
"""
from __future__ import annotations

from collections import defaultdict

import sdc_recipe_model as M


# --- the original slice views ---------------------------------------------
def call_graph(edges):
    return [(e.target.resolved_label, e.attrs.mode.value)
            for e in edges if e.relation == M.Relation.calls]


def table_access_matrix(edges):
    out = defaultdict(set)
    for e in edges:
        if e.relation == M.Relation.accesses_table:
            out[e.attrs.access.value].add(e.target.resolved_label)
    return {k: sorted(v) for k, v in out.items()}


def status_writers(edges):
    return sorted({e.target.resolved_label for e in edges if e.relation == M.Relation.writes_column})


# --- the bridge -----------------------------------------------------------
def field_index(treg: M.TableSchemaRegistry) -> dict:
    """field_id -> (table_name, column_name). field_ids are globally unique
    UUIDs, so this reverse index is well-defined; the table registry is dual-
    indexed (UUID and numeric table ids) but both resolve to the same names."""
    idx = {}
    for (table_id, field_id), col in treg.columns.items():
        idx[field_id] = (treg.resolve_table(table_id).resolved_label, col.get("name"))
    return idx


def column_writers(edges, rreg: M.RecipeRegistry, treg: M.TableSchemaRegistry) -> dict:
    """field_id -> {table, column, writers: [(handle, path, op)]}.

    Unions the two write paths to a column: direct table-API writes_column
    edges, and WFA add/update_request whose sets_fields resolve to that column.
    The field_id is the join key (stable through label drift)."""
    idx = field_index(treg)
    out = defaultdict(lambda: {"table": None, "column": None, "writers": []})

    def handle_of(flow_id):
        return rreg.resolve(flow_id).resolved_label or str(flow_id)

    for e in edges:
        if e.relation == M.Relation.writes_column:
            tid, fid = e.target.durable_key
            rec = out[fid]
            rec["table"] = treg.resolve_table(tid).resolved_label
            rec["column"] = e.target.resolved_label
            rec["writers"].append((handle_of(e.source_recipe), "table-api", e.attrs.write_kind.value))
        elif e.relation == M.Relation.performs_wfa:
            for fid in e.attrs.sets_fields:
                table, col = idx.get(fid, (None, None))
                rec = out[fid]
                rec["table"] = rec["table"] or table
                rec["column"] = rec["column"] or col
                rec["writers"].append((handle_of(e.source_recipe), "wfa", e.attrs.operation))
    return dict(out)


def stage_movers(edges, rreg: M.RecipeRegistry) -> list:
    """(handle, workflow_stage_id, op) for every performs_wfa carrying a stage."""
    def handle_of(flow_id):
        return rreg.resolve(flow_id).resolved_label or str(flow_id)
    return sorted({(handle_of(e.source_recipe), e.attrs.workflow_stage_id, e.attrs.operation)
                   for e in edges
                   if e.relation == M.Relation.performs_wfa and e.attrs.workflow_stage_id})


def single_owner_audit(edges, rreg, treg, owner: str, guarded_columns: set) -> dict:
    """Surface every writer of the guarded columns that isn't `owner`, by path.

    `guarded_columns` is a set of column LABELS (e.g. the oracle's status_columns).
    These are flagged for REVIEW, not asserted as bugs: a non-owner writer may be
    legitimate (a creation-time write via WFA add_request) or a genuine leak past
    the single writer — the report makes the distinction visible; the human judges.
    """
    cw = column_writers(edges, rreg, treg)
    other_writers = []
    for fid, rec in cw.items():
        if rec["column"] in guarded_columns:
            for handle, path, op in rec["writers"]:
                if handle != owner:
                    other_writers.append((rec["table"], rec["column"], handle, path, op))
    return {
        "owner": owner,
        "guarded_columns": sorted(guarded_columns),
        "other_writers": sorted(set(other_writers)),
        "stage_movers": stage_movers(edges, rreg),
    }
