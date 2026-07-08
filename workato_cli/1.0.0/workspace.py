"""workspace — the interactive facade over the pipeline.

Formalizes the throwaway heredocs: one Workspace object per session, on which
every question we used to answer with raw pasted python is a method call.

    from workspace import Workspace
    ws = Workspace.connect()            # env-driven (SDC_FOLDER_ID etc.)

    ws.facts("STS-01")                  # {reads, writes, status_columns, calls}
    ws.oracle("STS-01")                 # facts diffed against the shared ORACLE
    ws.oracle(84, expected={...})       # numeric flow_id; custom answer key
    ws.vocabulary()                     # the flag-settling inspector readout
    ws.edges("UPL-01")                  # raw resolved Edge list, project it yourself
    ws.audit()                          # single-owner audit over the production set
    ws.dump("recipes")                  # snapshot -> disk: one fixture-format file per recipe

How this squares with the one design rule (fetch is the only impure stage;
everything downstream is a pure function of a frozen snapshot): the Workspace
holds the client, and every fetch it performs is memoized — folder_assets, the
table list, each recipe's code, the inspector corpus. So within a session all
questions are answered from ONE captured state; the snapshot is simply
materialized lazily, on first touch, instead of eagerly up front. Everything
after the memoized fetch is the same pure spine the scripts use (normalize ->
extract -> resolve -> projections); this module adds no analysis logic of its
own, it only sequences what already exists. Call refresh() to drop the snapshot
and re-capture — e.g. after editing a recipe, so a stale memoized code can't
lie to the oracle.

Constructed with an injected client (the fake transport from fetch_selftest),
the whole facade runs offline — see workspace_selftest.py.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import sdc_recipe_model as M
from workato_client import WorkatoClient, WorkatoConfig, safe_parse_json, load_dotenv
from registries import build_recipe_registry, build_table_schema_registry
from normalize import normalize, NormStep
from extract import extract
from resolve import resolve
from projections import call_graph, table_access_matrix, status_writers, single_owner_audit
from inspect_corpus import (
    inspect_connector_usage, inspect_recipe_keywords,
    inspect_provider_input_keys, inspect_provider_samples,
)
from slice_run import ORACLE


# ---------------------------------------------------------------------------
# Result objects — small, printable, and shaped like the script readouts.
# ---------------------------------------------------------------------------
@dataclass
class OracleResult:
    """One recipe's regenerated facts diffed against an answer key.

    Truthy exactly when green, so `if ws.oracle("STS-01"): ...` reads naturally.
    str() reproduces the real_oracle readout.
    """
    target: str
    facts: dict
    expected: dict
    drift: list = field(default_factory=list)      # (recipe_label, live_name, field_id)

    @property
    def diff(self) -> dict:
        """Only the mismatched keys: {key: {'missing': set, 'extra': set}}."""
        out = {}
        for key, exp in self.expected.items():
            got = set(self.facts.get(key) or set())
            missing, extra = exp - got, got - exp
            if missing or extra:
                out[key] = {"missing": missing, "extra": extra}
        return out

    @property
    def ok(self) -> bool:
        return not self.diff

    def __bool__(self) -> bool:
        return self.ok

    def __str__(self) -> str:
        lines = [f"=== oracle: {self.target} ===",
                 f"reads : {sorted(self.facts.get('reads') or [])}",
                 f"writes: {sorted(self.facts.get('writes') or [])}",
                 f"status: {sorted(self.facts.get('status_columns') or [])}",
                 f"calls : {self.facts.get('calls')}"]
        if self.drift:
            lines.append("--- column-name drift (recipe label vs live table name) ---")
            lines += [f"  {rec}  ~=  {live!r}   ({fid})" for rec, live, fid in self.drift]
        diff = self.diff
        lines.append("--- diff vs expected ---")
        for key in self.expected:
            if key in diff:
                lines.append(f"[MISMATCH] {key}  missing={diff[key]['missing']} extra={diff[key]['extra']}")
            else:
                lines.append(f"[ok] {key}")
        lines.append("green" if self.ok else "RED")
        return "\n".join(lines)


@dataclass
class Vocabulary:
    """The step-3 inspector readout as data: what the corpus actually says.

    Reconcile against extract.py — PY_PROVIDERS, the call encoding, TABLE_KEYS,
    and the writes_column record key.
    """
    providers: list
    keywords: dict
    usage: dict            # Counter[(provider, action)] -> count
    table_keys: dict       # db provider -> {action: {input_key: count}}

    def __str__(self) -> str:
        lines = [f"providers: {self.providers}", f"keywords : {self.keywords}"]
        for prov, actions in self.table_keys.items():
            lines.append(f"{prov} input keys:")
            for action, keys in actions.items():
                lines.append(f"   {action}: {keys}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# The facade
# ---------------------------------------------------------------------------
class Workspace:
    def __init__(self, client: WorkatoClient, folder_id):
        self.client = client
        self.folder_id = str(folder_id)
        self._assets = None      # folder_assets response
        self._rreg = None        # RecipeRegistry
        self._treg = None        # TableSchemaRegistry
        self._codes: dict = {}   # flow_id -> parsed code tree
        self._corpus = None      # structured recipes with code (inspector input)
        self._prod: dict = {}    # (scope_name, scope_id) -> [(flow_id, handle)]

    @classmethod
    def connect(cls, folder_id=None, client=None) -> "Workspace":
        """Env-driven constructor: .env + WORKATO_* + SDC_FOLDER_ID, exactly like
        the scripts. Pass client= to inject a fake transport for offline use."""
        load_dotenv()
        folder_id = folder_id or os.environ.get("SDC_FOLDER_ID")
        if not folder_id:
            raise ValueError("set SDC_FOLDER_ID or pass folder_id=")
        client = client or WorkatoClient(config=WorkatoConfig.from_env())
        return cls(client, folder_id)

    def __repr__(self) -> str:
        # Reports only what is already materialized — repr must never fetch.
        bits = [f"folder {self.folder_id}",
                f"{len(self._rreg.by_flow_id)} recipes" if self._rreg else "recipes not yet fetched",
                f"{len(set(self._treg.tables.values()))} tables" if self._treg else "tables not yet fetched",
                f"{len(self._codes)} codes cached"]
        return f"<Workspace {' | '.join(bits)}>"

    # -- the snapshot, materialized lazily -----------------------------------
    @property
    def recipes(self) -> M.RecipeRegistry:
        if self._rreg is None:
            self._rreg = build_recipe_registry(self._get_assets())
        return self._rreg

    @property
    def tables(self) -> M.TableSchemaRegistry:
        if self._treg is None:
            self._treg = build_table_schema_registry(self.client.list_data_tables())
        return self._treg

    def _get_assets(self) -> list:
        if self._assets is None:
            self._assets = self.client.folder_assets(self.folder_id)
        return self._assets

    def _get_corpus(self) -> list:
        if self._corpus is None:
            self._corpus = self.client.get_structured_recipes(
                folder_id=self.folder_id, include_code=True)
        return self._corpus

    def refresh(self) -> "Workspace":
        """Drop the snapshot; the next question re-captures live state. Use after
        editing a recipe or table so the memoized code can't lie to the oracle."""
        self._assets = self._rreg = self._treg = self._corpus = None
        self._codes.clear()
        self._prod.clear()
        return self

    # -- identity -------------------------------------------------------------
    def flow_id(self, target) -> int:
        """Handle ('STS-01') or numeric flow_id -> flow_id. Ambiguous handles
        (registry collisions) refuse politely rather than guessing."""
        s = str(target).strip()
        if s.isdigit():
            return int(s)
        matches = [fid for fid, info in self.recipes.by_flow_id.items()
                   if info.get("handle") == s]
        if not matches:
            raise KeyError(f"no recipe with handle {s!r} in folder_assets; "
                           f"pass the numeric flow_id or check the folder")
        if len(matches) > 1:
            raise KeyError(f"handle {s!r} is ambiguous (flow_ids {sorted(matches)}); "
                           f"pass the numeric flow_id")
        return matches[0]

    def handle(self, target) -> str:
        fid = self.flow_id(target)
        return (self.recipes.by_flow_id.get(fid) or {}).get("handle", str(fid))

    # -- the spine, per recipe --------------------------------------------------
    def code(self, target) -> dict:
        """The recipe's parsed code tree (fetched once, memoized). If the
        inspector corpus is already materialized, its copy is used — the
        snapshot never fetches the same recipe twice by two routes."""
        fid = self.flow_id(target)
        if fid not in self._codes:
            if self._corpus is not None:
                hit = next((r for r in self._corpus if r.get("id") == fid), None)
                if hit is not None and hit.get("code") is not None:
                    self._codes[fid] = hit["code"]
                    return self._codes[fid]
            self._codes[fid] = safe_parse_json(self.client.get_recipe(fid)["code"])
        return self._codes[fid]

    def steps(self, target) -> "list[NormStep]":
        return normalize(self.code(target))

    def edges(self, target) -> "list[M.Edge]":
        """normalize -> extract -> resolve for one recipe. Recomputed each call
        (pure and cheap); only the code fetch behind it is memoized."""
        fid = self.flow_id(target)
        return resolve(extract(normalize(self.code(fid)), fid), self.recipes, self.tables)

    # -- facts + oracle ---------------------------------------------------------
    def facts(self, target) -> dict:
        """The four regenerated facts the oracle diffs: reads, writes,
        status_columns (sets) and calls (informational list)."""
        edges = self.edges(target)
        tam = table_access_matrix(edges)
        return {
            "reads": set(tam.get("read", [])),
            "writes": set(tam.get("write", [])),
            "status_columns": set(status_writers(edges)),
            "calls": call_graph(edges),
        }

    def drift(self, target) -> list:
        """(recipe_label, live_name, field_id) where the recipe's logical column
        name differs from the live data-table name for the same field_id."""
        out = []
        for e in self.edges(target):
            if e.relation == M.Relation.writes_column:
                tid, fid = e.target.durable_key
                live = self.tables.resolve_column(tid, fid).resolved_label
                rec = getattr(e.attrs, "recipe_label", None)
                if live and rec and live != rec:
                    out.append((rec, live, fid))
        return out

    def oracle(self, target="STS-01", expected=None) -> OracleResult:
        """Regenerate one recipe's facts and diff them against an answer key
        (default: the shared ORACLE from slice_run). print() it for the full
        readout; truth-test it for green/red."""
        expected = {k: set(v) for k, v in (expected or ORACLE).items()}
        return OracleResult(target=self.handle(target), facts=self.facts(target),
                            expected=expected, drift=self.drift(target))

    # -- corpus-level questions ---------------------------------------------------
    def vocabulary(self) -> Vocabulary:
        """The step-3 readout: which providers/keywords/input-keys the corpus
        actually uses. Fetches the corpus once (N+1 calls), then memoized."""
        corpus = self._get_corpus()
        usage = inspect_connector_usage(corpus)
        providers = sorted({p for p, _n in usage})
        table_keys = {p: {a: dict(c) for a, c in inspect_provider_input_keys(corpus, p).items()}
                      for p in providers if "db_table" in p or p == "data_tables"}
        return Vocabulary(providers=providers,
                          keywords=dict(sorted(inspect_recipe_keywords(corpus).items())),
                          usage=usage, table_keys=table_keys)

    def samples(self, provider: str, limit: int = 3) -> list:
        """Eyeball full step payloads for one provider (inspect_provider_samples)."""
        return inspect_provider_samples(self._get_corpus(), provider, limit)

    def production_recipes(self, scope_name=None, scope_id=None) -> list:
        """(flow_id, handle) for recipes directly in the production scope folder
        — same rule as corpus_pass: SDC_RECIPES_FOLDER_ID / _NAME (default
        'Recipes'), falling back to every recipe in the subtree. Memoized per
        scope, like every other fetch; refresh() drops it."""
        key = (scope_name, scope_id)
        if key in self._prod:
            return self._prod[key]
        scope_id = scope_id if scope_id is not None else os.environ.get("SDC_RECIPES_FOLDER_ID")
        scope_name = scope_name or os.environ.get("SDC_RECIPES_FOLDER_NAME", "Recipes")
        if scope_id is None:
            for f in self.client.list_folders(parent_id=self.folder_id):
                if (f.get("name") or "").strip().lower() == scope_name.strip().lower():
                    scope_id = f.get("id")
                    break
        if scope_id is not None:
            ids = [r["id"] for r in self.client.list_recipes(folder_id=scope_id)
                   if str(r.get("folder_id")) == str(scope_id)]
        else:
            ids = [a["id"] for a in self._get_assets() if a.get("type") == "recipe"]
        self._prod[key] = [(fid, self.handle(fid)) for fid in ids]
        return self._prod[key]

    def all_edges(self, targets=None) -> "list[M.Edge]":
        """The resolved edge set across many recipes (default: the production
        set). Each recipe's code fetch is memoized, so re-asking is free."""
        if targets is None:
            targets = [fid for fid, _h in self.production_recipes()]
        out: list = []
        for t in targets:
            out.extend(self.edges(t))
        return out

    def audit(self, owner="STS-01", guarded=None, edges=None) -> dict:
        """Single-owner audit: who writes the guarded status columns, by path
        (table-api vs WFA). Defaults to the ORACLE's status_columns and the
        production edge set."""
        guarded = set(guarded) if guarded is not None else set(ORACLE["status_columns"])
        edges = edges if edges is not None else self.all_edges()
        return single_owner_audit(edges, self.recipes, self.tables, owner, guarded)

    # -- the snapshot, flowing to disk ------------------------------------------
    def dump(self, dest="recipes", targets=None) -> dict:
        """Write each recipe's parsed code tree to `dest/`, one file per recipe.

        This is the snapshot flowing to disk: the API side stays GET-only and
        memoized (a recipe already in the snapshot costs zero calls), and the
        only new impurity is the local write into `dest`.

        The files are BARE code trees — byte-for-byte the fixture format — so
        every dumped recipe feeds straight back into normalize()/the spine, or
        drops into fixtures/ as-is. Output is deterministic (stable names,
        stable formatting): re-dumping an unchanged corpus produces identical
        bytes, which makes a committed dump git-diffable over time. Provenance
        (folder, timestamp, file -> recipe map, errors) lives in
        `dest/_manifest.json`, NOT inside the artifacts, so the round-trip
        json.load(file) == ws.code(flow_id) stays exact.

        targets: None -> the production set (production_recipes());
                 else any iterable of handles / flow_ids.
        Files are named {handle}__{flow_id}.recipe.json (unique even when
        handles collide). Existing files are overwritten — it's a snapshot.
        One bad recipe doesn't abort the dump; it's recorded in errors.

        Returns {"written": [paths], "errors": [(target, error)], "manifest": path}.
        """
        dest_path = Path(dest)
        dest_path.mkdir(parents=True, exist_ok=True)
        if targets is None:
            targets = [fid for fid, _h in self.production_recipes()]

        written, errors, entries = [], [], []
        for t in targets:
            try:
                fid = self.flow_id(t)
                handle = self.handle(fid)
                code = self.code(fid)
                if not isinstance(code, dict):
                    raise ValueError(f"code did not parse to a dict (got {type(code).__name__})")
                path = dest_path / self._dump_name(handle, fid)
                path.write_text(json.dumps(code, indent=2, ensure_ascii=False) + "\n",
                                encoding="utf-8")
                written.append(str(path))
                entries.append({"file": path.name, "flow_id": fid, "handle": handle,
                                "name": (self.recipes.by_flow_id.get(fid) or {}).get("name")})
            except Exception as ex:               # keep going; record, don't abort
                errors.append((str(t), repr(ex)))

        manifest = {
            "folder_id": self.folder_id,
            "dumped_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "recipes": sorted(entries, key=lambda e: e["file"]),
            "errors": errors,
        }
        mpath = dest_path / "_manifest.json"
        mpath.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                         encoding="utf-8")
        return {"written": written, "errors": errors, "manifest": str(mpath)}

    _FILE_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")

    def _dump_name(self, handle: str, fid: int) -> str:
        safe = self._FILE_UNSAFE.sub("_", handle).strip("_") or "recipe"
        return f"{safe}__{fid}.recipe.json"
