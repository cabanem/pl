"""slice_run — the STS-01 vertical slice, end to end.

normalize -> extract -> resolve (stubbed registries) -> projections, then a
miniature of the validation strategy: diff the regenerated table-access and
status-writer facts against the OpenAPI spec's STS-01 rows (the oracle).

Also asserts the two contract invariants on this one recipe:
  * determinism  — normalize(code) == normalize(code)
  * honest provenance — no keyed target is silently unlabeled
"""
from __future__ import annotations

import json
from collections import defaultdict

import sdc_recipe_model as M
from normalize import normalize
from extract import extract

STS01_FLOW_ID = 84
FIXTURE = "fixtures/sts_01.recipe.fixture.json"


# --- resolve (stage 4, inlined for the slice; becomes resolve.py) ----------
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
            e.target = treg.resolve_column(tid, fid)
    return edges


# --- stub registries (real ones arrive at stage 1 from the GAS) ------------
def stub_registries():
    rreg = M.RecipeRegistry({
        84: {"handle": "STS-01", "name": "Status-change handler", "type": "recipe", "source_file": "sts_01.json"},
        4:  {"handle": "UTL-01", "name": "Generate shareable link", "type": "recipe", "source_file": "utl_01.json"},
        16: {"handle": "OBS-01", "name": "Event emitter", "type": "recipe", "source_file": "obs_01.json"},
    })
    treg = M.TableSchemaRegistry(
        tables={
            "tbl-supreq": "SUP_SupplierRequest",
            "tbl-valres": "RUN_ValidationResult",
            "tbl-project": "Project",
            "tbl-revnote": "RUN_ReviewNote",
        },
        columns={
            ("tbl-supreq", "84d52734-0000-0000-0000-000000000000"): {"name": "status", "type": "string"},
            ("tbl-supreq", "col-disp-0001"): {"name": "supplier_display_status", "type": "string"},
            ("tbl-supreq", "col-msg-0002"): {"name": "supplier_message", "type": "string"},
            ("tbl-supreq", "col-entered-0003"): {"name": "current_state_entered_at", "type": "date_time"},
        },
    )
    return rreg, treg


# --- projections (stage 5, two small ones) ---------------------------------
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


# --- run -------------------------------------------------------------------
def main():
    with open(FIXTURE) as f:
        code = json.load(f)

    steps = normalize(code)
    edges = extract(steps, STS01_FLOW_ID)
    rreg, treg = stub_registries()
    resolve(edges, rreg, treg)

    print("=== STS-01 vertical slice ===")
    print(f"steps normalized : {len(steps)}")
    print(f"edges extracted  : {len(edges)}  "
          f"({sum(1 for e in edges if e.provenance == M.Provenance.derived)} derived)")
    print()
    print("call_graph         :", call_graph(edges))
    tam = table_access_matrix(edges)
    print("table_access reads :", tam.get("read", []))
    print("table_access writes:", tam.get("write", []))
    print("status_writers     :", status_writers(edges))
    print()

    # --- invariant 1: determinism ---
    assert normalize(code) == steps, "normalize is not deterministic"
    print("[ok] determinism: normalize(code) reproduces identical step tree")

    # --- invariant 2: honest provenance (no keyed target silently unlabeled) ---
    keyed = (M.TargetKind.recipe, M.TargetKind.table, M.TargetKind.column)
    for e in edges:
        if e.target.kind in keyed:
            assert e.target.resolution in (M.Resolution.resolved, M.Resolution.unresolved)
            if e.target.resolution == M.Resolution.resolved:
                assert e.target.resolved_label is not None
    print("[ok] honest provenance: every keyed target is resolved-with-label or flagged unresolved")
    print()

    # --- miniature validation: diff regenerated facts vs the OpenAPI oracle ---
    # Ground truth read straight from the spec's STS-01 rows (x-data-tables / x-status-writers).
    ORACLE = {
        "reads": {"SUP_SupplierRequest", "RUN_ValidationResult", "Project", "RUN_ReviewNote"},
        "writes": {"SUP_SupplierRequest"},
        "status_columns": {"current_state_entered_at", "status", "supplier_display_status", "supplier_message"},
    }
    got = {
        "reads": set(tam.get("read", [])),
        "writes": set(tam.get("write", [])),
        "status_columns": set(status_writers(edges)),
    }
    for key, expected in ORACLE.items():
        diff_missing = expected - got[key]
        diff_extra = got[key] - expected
        status = "ok" if not diff_missing and not diff_extra else "MISMATCH"
        print(f"[{status}] {key}: regenerated == oracle"
              + ("" if status == "ok" else f"  missing={diff_missing} extra={diff_extra}"))
        assert status == "ok", f"oracle diff failed for {key}"

    print("\nslice green: spine runs end to end and reproduces the STS-01 oracle facts.")


if __name__ == "__main__":
    main()
