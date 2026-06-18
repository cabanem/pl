"""real_oracle — the live oracle, one command.

Captures the real STS-01 recipe from the workspace, runs it through the same
spine the slice uses (normalize -> extract -> resolve -> project), and diffs the
regenerated facts against the OpenAPI spec's STS-01 rows (imported from
slice_run, so there's one answer key). Unlike slice_run, both sides are now
independent: the recipe JSON is live, the spec was authored separately.

  PYTHONPATH=/path/to/sdc-recipe-model python3 real_oracle.py [STS-01 | <flow_id>]

Target defaults to the handle "STS-01" (resolved to a flow_id via folder_assets);
pass a numeric flow_id to skip the lookup, or set STS01_FLOW_ID in the env.
Reads SDC_FOLDER_ID. GET-only; exits 0 on green, 1 on mismatch.
"""
from __future__ import annotations

import os
import sys

import sdc_recipe_model as M
from workato_client import WorkatoClient, WorkatoConfig, safe_parse_json, load_dotenv
from registries import build_recipe_registry, build_table_schema_registry
from normalize import normalize
from extract import extract
from slice_run import resolve, table_access_matrix, status_writers, call_graph, ORACLE


def _resolve_target(rreg, target) -> int:
    """Accept a numeric flow_id or a handle like 'STS-01'."""
    s = str(target).strip()
    if s.isdigit():
        return int(s)
    for fid, info in rreg.by_flow_id.items():
        if info.get("handle") == s:
            return fid
    raise SystemExit(
        f"No recipe with handle {s!r} in folder_assets. Pass the numeric flow_id "
        f"instead, or check the handle against the folder."
    )


def run(client, target, folder_id) -> bool:
    """Inject the client so this is testable offline. Returns True on green."""
    rreg = build_recipe_registry(client.folder_assets(folder_id))
    flow_id = _resolve_target(rreg, target)
    handle = (rreg.by_flow_id.get(flow_id) or {}).get("handle", "?")
    print(f"captured: {handle} (flow_id {flow_id})")

    code = safe_parse_json(client.get_recipe(flow_id)["code"])
    edges = extract(normalize(code), flow_id)

    treg = build_table_schema_registry(client.list_data_tables())   # list carries schemas inline
    resolve(edges, rreg, treg)

    tam = table_access_matrix(edges)
    got = {
        "reads": set(tam.get("read", [])),
        "writes": set(tam.get("write", [])),
        "status_columns": set(status_writers(edges)),
    }

    print("\n--- regenerated ---")
    print("reads :", sorted(got["reads"]))
    print("writes:", sorted(got["writes"]))
    print("status:", sorted(got["status_columns"]))
    print("calls :", call_graph(edges))            # informational; not part of the diff

    # surface column-name drift: where the recipe's logical label differs from the
    # live data-table column name (same field_id, two names).
    drift = []
    for e in edges:
        if e.relation == M.Relation.writes_column:
            tid, fid = e.target.durable_key
            live = treg.resolve_column(tid, fid).resolved_label
            rec = getattr(e.attrs, "recipe_label", None)
            if live and rec and live != rec:
                drift.append((rec, live, fid))
    if drift:
        print("\n--- column-name drift (recipe label vs live table name) ---")
        for rec, live, fid in drift:
            print(f"  {rec}  ~=  {live!r}   ({fid})")

    print("\n--- oracle diff ---")
    ok = True
    for key, expected in ORACLE.items():
        missing, extra = expected - got[key], got[key] - expected
        good = not missing and not extra
        ok = ok and good
        print(f"[{'ok' if good else 'MISMATCH'}] {key}"
              + ("" if good else f"  missing={missing} extra={extra}"))

    if not (got["reads"] | got["writes"] | got["status_columns"]):
        print("\nhint: no table/status edges were produced. extract.py's DB_PROVIDERS / "
              "TABLE_KEYS probably aren't reconciled to your recipes yet — run the "
              "connector-usage inspector and confirm the data-table provider and key first.")
    return ok


def main(argv):
    load_dotenv()
    folder_id = os.environ.get("SDC_FOLDER_ID")
    if not folder_id:
        sys.exit("STOP: set SDC_FOLDER_ID.")
    target = argv[1] if len(argv) > 1 else os.environ.get("STS01_FLOW_ID", "STS-01")

    client = WorkatoClient(config=WorkatoConfig.from_env())
    ok = run(client, target, folder_id)
    print("\nreal oracle:",
          "green — live STS-01 reproduces the spec facts." if ok
          else "RED — see the mismatches above.")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main(sys.argv)
