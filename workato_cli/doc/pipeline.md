The pipeline, in dependency order:

1. **Fetch + registries** (`fetch.py`, `registries.py`) — pulls the raw inputs and freezes a snapshot. Three outputs: the recipe-JSON corpus (list → detail, double-parse `code`, throttle, cache by `id@updated_at`), the recipe registry from `folder_assets` (`flow_id → handle`), and the table-schema registry from the data-tables GET (`(table_id, field_id) → name/type`). This is the only stage that touches the network and the only one that isn't deterministic — everything below is a pure function of its frozen output. **This is where your GAS context lands.**

2. **Normalize** (`normalize.py`) — per recipe, JSON `code` → a deterministic control-flow tree. This is the stage the path anchor depends on: same JSON must yield the same tree and the same positional indices every run. No edges yet — just the framed, ordered step skeleton with each step's uuid, action_type, frame, and (for `py_eval`) the captured body. Pure, per-recipe.

3. **Extract** (`extract.py`) — per recipe, walk the tree and emit `Edge` objects per the contract. Control frames are skipped; effect-bearing steps emit typed edges with durable-key targets and `resolution` still pending; `py_eval` steps emit nothing semantic yet but capture their I/O. Pure, per-recipe, parallelizable.

4. **Resolve** (`resolve.py`) — corpus-scoped join. Attach labels by resolving each keyed target against the registries, set `resolved`/`unresolved`, and assemble the `RecipeModel`. This is the one stage that *cannot* be per-recipe — you need every recipe's handle in hand before you can resolve any call edge — and it's where the cross-project edges honestly fall out as `unresolved`. Its serialized output is the canonical model; cache it as a snapshot.

5. **Projections** (`projections/`) — one small module per artifact, each `RecipeModel → output`. Independent of each other, built incrementally; you don't need all of them for a working system.

Deferred: **py_eval interior analysis** — the asserted-edge filler that reads captured bodies and feeds edges back into the model. The slot's reserved; it's enrichment, not a blocker, so it stays out of v1.
