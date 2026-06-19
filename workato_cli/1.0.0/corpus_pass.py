"""corpus_pass — run the spine over every recipe in a project folder and report
coverage + gaps. Read-only.

Enumerates via folder_assets (spans subfolders — the same source real_oracle uses
to reach a nested recipe), fetches each recipe, runs normalize -> extract ->
resolve with one shared pair of registries, and aggregates:

  * edges by relation
  * per-step coverage: covered / control / py_eval / UNHANDLED
  * UNHANDLED (provider :: action) ranked  -> the worklist for extending extract
  * unresolved targets (cross-project calls; unresolved tables/columns)
  * column-name drift (recipe label vs live data-table name)
  * zero-edge recipes (the tell for a fully-unhandled provider)

  PYTHONPATH=/path/to/sdc-recipe-model python3 corpus_pass.py

Reads SDC_FOLDER_ID (the project / top-level folder). One folder_assets call,
one data_tables call, and one detail fetch per recipe (~N+2); 429s self-heal.
"""
from __future__ import annotations

import os
import sys
from collections import Counter

import sdc_recipe_model as M
from workato_client import WorkatoClient, WorkatoConfig, safe_parse_json, load_dotenv
from registries import build_recipe_registry, build_table_schema_registry
from normalize import normalize, CONTROL_KEYWORDS
from extract import extract, PY_PROVIDERS, STATE_PROVIDERS, TRANSFORM_PROVIDERS
from slice_run import resolve


def classify_steps(steps, edges):
    """Per-step coverage. A step is covered if any edge carries its uuid; control
    frames, py_eval bodies, recipe-internal state (workato_variable), and pure
    transforms (csv/json parsers) are intentionally edge-less (known); anything else
    an action step leaves behind is UNHANDLED — a relation extract doesn't model yet."""
    edge_uuids = {e.anchor.uuid for e in edges if e.anchor and e.anchor.uuid}
    covered = control = py = state = transform = 0
    unhandled = []                                    # (provider, action)
    for s in steps:
        if s.keyword in CONTROL_KEYWORDS:
            control += 1
        elif s.provider in PY_PROVIDERS:
            py += 1
        elif s.provider in STATE_PROVIDERS:
            state += 1
        elif s.provider in TRANSFORM_PROVIDERS:
            transform += 1
        elif s.uuid in edge_uuids or s.keyword == "trigger":
            covered += 1
        else:
            unhandled.append((s.provider or "(none)", s.name or "(none)"))
    return covered, control, py, state, transform, unhandled


def _resolve_scope_folder(client, project_folder_id, name) -> object:
    """Find the folder named `name` directly under the project folder. Returns
    its id, or None if absent (caller falls back to the whole subtree)."""
    for f in client.list_folders(parent_id=project_folder_id):
        if (f.get("name") or "").strip().lower() == name.strip().lower():
            return f.get("id")
    return None


def run(client, folder_id, scope_name="Recipes", scope_id=None) -> bool:
    # Registry spans the FULL subtree, so call targets in subfolders still resolve.
    assets = client.folder_assets(folder_id)
    rreg = build_recipe_registry(assets)
    treg = build_table_schema_registry(client.list_data_tables())
    n_subtree = sum(1 for a in assets if a.get("type") == "recipe")

    # Processing set is scoped: recipes whose PARENT folder is "Recipes", excluding
    # its subfolders. Filtering on folder_id makes this exact whether the list
    # endpoint returns the folder flat or its subtree.
    if scope_id is None:
        scope_id = _resolve_scope_folder(client, folder_id, scope_name)
    if scope_id is not None:
        recipes = [r for r in client.list_recipes(folder_id=scope_id)
                   if str(r.get("folder_id")) == str(scope_id)]
        print(f"corpus: {len(recipes)} recipes directly in folder {scope_name!r} (id {scope_id}); "
              f"excluded {n_subtree - len(recipes)} of {n_subtree} subtree recipes "
              f"(subfolders + dev/test).\n")
    else:
        recipes = [a for a in assets if a.get("type") == "recipe"]
        print(f"corpus: scope folder {scope_name!r} not found under {folder_id}; "
              f"falling back to all {len(recipes)} recipes in the subtree.\n")

    rel_counts: Counter = Counter()
    unhandled: Counter = Counter()
    unresolved_calls = []
    unresolved_other: Counter = Counter()
    drift = []
    zero_edge = []
    per_recipe = []
    errors = []
    cov_tot = ctrl_tot = py_tot = state_tot = xform_tot = unh_tot = 0

    for a in recipes:
        fid = a.get("id")
        handle = (rreg.by_flow_id.get(fid) or {}).get("handle", str(fid))
        try:
            code = safe_parse_json(client.get_recipe(fid).get("code"))
            steps = normalize(code)
            edges = extract(steps, fid)
            resolve(edges, rreg, treg)
        except Exception as ex:                       # keep going; one bad recipe shouldn't abort the pass
            errors.append((handle, repr(ex)))
            continue

        for e in edges:
            rel_counts[e.relation.value] += 1
            t = e.target
            if t.resolution == M.Resolution.unresolved and t.durable_key is not None:
                if e.relation == M.Relation.calls:
                    unresolved_calls.append((handle, t.durable_key))
                else:
                    unresolved_other[e.relation.value] += 1
            if e.relation == M.Relation.writes_column:
                tid, fcol = t.durable_key
                live = treg.resolve_column(tid, fcol).resolved_label
                rec = getattr(e.attrs, "recipe_label", None)
                if live and rec and live != rec:
                    drift.append((handle, rec, live, fcol))

        cov, ctrl, py, state, xform, unh = classify_steps(steps, edges)
        cov_tot += cov; ctrl_tot += ctrl; py_tot += py; state_tot += state; xform_tot += xform; unh_tot += len(unh)
        for prov_name in unh:
            unhandled[prov_name] += 1
        if not edges:
            zero_edge.append(handle)
        per_recipe.append((handle, len(steps), len(edges), len(unh)))

    # ---------------- report ----------------
    total = cov_tot + ctrl_tot + py_tot + state_tot + xform_tot + unh_tot
    print(f"coverage (steps): {total} total = {cov_tot} covered, {ctrl_tot} control, "
          f"{py_tot} py, {state_tot} state, {xform_tot} transform, {unh_tot} unhandled\n")

    print("edges by relation:")
    for rel, n in rel_counts.most_common():
        print(f"  {n:5}  {rel}")

    print("\nUNHANDLED step types (provider :: action) — the worklist:")
    if unhandled:
        for (prov, name), n in unhandled.most_common():
            print(f"  {n:5}  {prov} :: {name}")
    else:
        print("  (none — every action step produced an edge)")

    if unresolved_calls:
        print(f"\nunresolved calls (likely cross-project): {len(unresolved_calls)}")
        for caller, callee in unresolved_calls[:12]:
            print(f"  {caller} -> flow_id {callee}")

    if unresolved_other:
        print("\nunresolved non-call targets:", dict(unresolved_other))

    if drift:
        print(f"\ncolumn-name drift (recipe label ~= live name): {len(drift)}")
        for handle, rec, live, fcol in drift:
            print(f"  {handle}: {rec} ~= {live!r} ({fcol})")

    if zero_edge:
        print(f"\nzero-edge recipes ({len(zero_edge)}): {', '.join(zero_edge)}")

    if errors:
        print(f"\nerrors ({len(errors)}):")
        for handle, ex in errors:
            print(f"  {handle}: {ex}")

    print("\nper-recipe  (handle | steps | edges | unhandled):")
    for handle, nsteps, nedges, nunh in sorted(per_recipe):
        print(f"  {handle:16} {nsteps:4} {nedges:4} {nunh:4}" + ("   <-- has unhandled" if nunh else ""))

    return True


def main():
    load_dotenv()
    folder_id = os.environ.get("SDC_FOLDER_ID")
    if not folder_id:
        sys.exit("STOP: set SDC_FOLDER_ID (the project / top-level folder).")
    scope_name = os.environ.get("SDC_RECIPES_FOLDER_NAME", "Recipes")
    scope_id = os.environ.get("SDC_RECIPES_FOLDER_ID")          # optional fast-path override
    client = WorkatoClient(config=WorkatoConfig.from_env())
    run(client, folder_id, scope_name=scope_name, scope_id=scope_id)


if __name__ == "__main__":
    main()
