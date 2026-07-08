"""dump_recipes — capture recipe code trees to ./recipes/, one file per recipe.

A thin CLI over Workspace.dump(): connect, enumerate, fetch each recipe once,
write its parsed code tree as pretty JSON. The files are the fixture format —
each one feeds normalize()/the spine directly — and the output is deterministic,
so a committed dump diffs cleanly against the next one. Provenance is written to
recipes/_manifest.json.

  PYTHONPATH=/path/to/sdc-recipe-model python3 dump_recipes.py              # the production set
  python3 dump_recipes.py STS-01 UPL-01 84                                  # explicit targets
  SDC_DUMP_DIR=snapshots/2026-07-08 python3 dump_recipes.py                 # dated snapshot

Reads SDC_FOLDER_ID (+ the optional SDC_RECIPES_FOLDER_* scoping, same rule as
corpus_pass) and SDC_DUMP_DIR (default: recipes, relative to the working
directory). GET-only toward the API; writes only inside the dest folder.
Exits 0 when every target dumped, 1 if any recipe errored.
"""
from __future__ import annotations

import os
import sys

from workspace import Workspace


def main(argv):
    ws = Workspace.connect()
    dest = os.environ.get("SDC_DUMP_DIR", "recipes")
    targets = argv[1:] or None            # handles or flow_ids; default = production set

    result = ws.dump(dest=dest, targets=targets)

    print(f"dumped {len(result['written'])} recipes -> {dest}/")
    for p in result["written"]:
        print(f"  {p}")
    if result["errors"]:
        print(f"\nerrors ({len(result['errors'])}):")
        for t, ex in result["errors"]:
            print(f"  {t}: {ex}")
    print(f"\nmanifest: {result['manifest']}")
    sys.exit(1 if result["errors"] else 0)


if __name__ == "__main__":
    main(sys.argv)
