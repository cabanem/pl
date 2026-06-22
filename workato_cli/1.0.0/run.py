"""run — the whole pipeline in one command.

  1. preflight (offline): run the STS-01 slice and the stage-1 self-test. Fails
     fast if the spine or fetch wiring regressed — no point hitting the API.
  2. live corpus pass: spine over every production recipe, with the full report
     (coverage partition, edges by relation, column drift, single-owner audit).
  3. freeze the IR: persist the resolved edge set to out/edges.json — the single
     source every downstream artifact (the spec regen especially) reads from,
     and a frozen model the projections can re-run against offline.

  PYTHONPATH=/path/to/sdc-recipe-model python3 run.py

Honors SDC_FOLDER_ID and the optional SDC_RECIPES_FOLDER_ID / _NAME overrides,
exactly like corpus_pass. Fetch is the only impure step; everything the report
shows is a pure function of that one snapshot.
"""
from __future__ import annotations

import dataclasses
import json
import os
import sys
from enum import Enum
from pathlib import Path

import slice_run
import fetch_selftest
import corpus_pass
from workato_client import WorkatoClient, WorkatoConfig, load_dotenv


def preflight() -> None:
    """Offline end-to-end check. Raises (via assert) if anything regressed."""
    slice_run.main()        # spine -> oracle diff on the fixture; asserts determinism + provenance
    fetch_selftest.main()   # stage-1 fetch / registry / inspector wiring vs canned responses


def _enc(o):
    if isinstance(o, Enum):
        return o.value
    raise TypeError(f"not JSON-serializable: {type(o).__name__}")


def serialize_edges(edges) -> list:
    """Edges -> plain dicts (dataclasses unfolded, enums to their .value)."""
    return [dataclasses.asdict(e) for e in edges]


def full_run(client, folder_id, out_dir="out", scope_name="Recipes", scope_id=None):
    edges = corpus_pass.run(client, folder_id, scope_name=scope_name, scope_id=scope_id)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    path = out / "edges.json"
    with open(path, "w") as f:
        json.dump(serialize_edges(edges), f, default=_enc, indent=2)
    print(f"\nfrozen IR: {len(edges)} resolved edges -> {path}")
    return edges


def main():
    load_dotenv()
    folder_id = os.environ.get("SDC_FOLDER_ID")
    if not folder_id:
        sys.exit("STOP: set SDC_FOLDER_ID (the project / top-level folder).")

    print("=== preflight (offline) ===")
    preflight()

    print("\n=== live corpus pass ===")
    client = WorkatoClient(config=WorkatoConfig.from_env())
    full_run(
        client, folder_id,
        scope_name=os.environ.get("SDC_RECIPES_FOLDER_NAME", "Recipes"),
        scope_id=os.environ.get("SDC_RECIPES_FOLDER_ID"),
    )


if __name__ == "__main__":
    main()
