#!/usr/bin/env python3
"""
trace_mapping.py - Static trace: is `_mapping` consumed anywhere in the SDC recipe corpus?

Layers (run in order; each is a subcommand):

  inventory   Corpus sanity: count recipes, normalize shapes, report parse failures.
  scan        Layer 1: literal scan for a needle (default `_mapping`) with step-level locus.
  fetch       Layer 2a: inventory of file-content-acquiring steps (heuristic, name-based).
  consumers   Layer 2b: filter fetch steps to config/variant JSON consumers, with
              fixpoint propagation of tracked field names across call_recipe edges
              (handles the caller-output -> callee-parameter rename problem).
  pycode      Layer 4 helper: dump embedded Python source from consumer recipes to
              files for human reading.
  all         Run every layer in sequence, write a combined report.

Input handling (API vs zip export):
  * A directory of per-recipe .json files, OR a single .json file containing an
    array of recipe objects (typical of a raw API list response).
  * `code` may be a dict (zip export) or a JSON string (API payload). Normalized.
  * call_recipe callee binding may be:
      - input.flow_id as dict with zip_name (zip export; zip_name authoritative)
      - input.flow_id as scalar recipe id (API payload)
    Both are resolved; id-based bindings are mapped via each recipe's own `id`.

Stdlib only. Python 3.8+.

Usage:
  python3 trace_mapping.py all <recipes_dir_or_file> [--out trace_out] [--needle _mapping]
  python3 trace_mapping.py scan <recipes> --needle _mapping
  python3 trace_mapping.py consumers <recipes> --seed drive_id_config_json \
      --seed config_json_file_id --seed template_file_ids
"""

import argparse
import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DEFAULT_NEEDLE = "_mapping"

# Wire field names that identify config / variant JSON files at their origin
# (Payload.provision / validate / preview in the GAS library).
DEFAULT_SEED_FIELDS = [
    "drive_id_config_json",
    "config_json_file_id",
    "template_file_ids",
]

# Name fragments that suggest a step acquires file content. Deliberately broad;
# `consumers` narrows by data flow, so false positives here are cheap.
FETCH_WORDS = (
    "download", "get_file", "file_content", "export_file",
    "read_file", "fetch_file", "get file", "download file",
)

# Providers whose call steps create recipe->recipe edges.
CALL_PROVIDERS = {"workato_recipe_function"}
CALL_ACTION_NAMES = {"call_recipe", "call_recipe_async"}

# Wildcard-consumption patterns worth flagging when reading Python step source.
WILDCARD_PATTERNS = [
    (re.compile(r"for\s+\w+\s+in\s+(\w+)\s*:"), "iterates a dict/list directly"),
    (re.compile(r"\.items\(\)"), ".items() over a parsed object"),
    (re.compile(r"\.keys\(\)"), ".keys() over a parsed object"),
    (re.compile(r"len\(\s*\w+\s*\)"), "len() on a parsed object"),
    (re.compile(r"json\.dumps\("), "re-serializes an object onward"),
    (re.compile(r"sha256|sha1|md5|hashlib"), "hashes content"),
]

# ---------------------------------------------------------------------------
# Corpus loading / normalization
# ---------------------------------------------------------------------------

def _normalize_code(raw_code):
    """API payloads carry code as a JSON string; zip exports as a dict."""
    if raw_code is None:
        return None
    if isinstance(raw_code, dict):
        return raw_code
    if isinstance(raw_code, str):
        try:
            parsed = json.loads(raw_code)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None
    return None


# Filename convention for API-fetched content: <PREFIX>_<recipeId>.recipe.json
# e.g. "WFA-015_2121648.recipe.json" -> name "WFA-015", id 2121648.
FILENAME_RE = re.compile(r"^(?P<name>.+?)_(?P<id>\d+)(?:\.recipe)?\.json$",
                         re.IGNORECASE)


def _identity_from_filename(filename):
    """Returns (name, id) parsed from the filename convention, or (stem, None)."""
    m = FILENAME_RE.match(filename)
    if m:
        return m.group("name"), m.group("id")
    return Path(filename).stem, None


def _is_bare_code_tree(obj):
    """
    True when the file IS the recipe's code tree (no {id, name, code} envelope):
    a root step object carrying `block` and/or a trigger keyword. This is the
    shape you get when saving the API's `code` payload directly, one per file.
    """
    if not isinstance(obj, dict) or "code" in obj:
        return False
    return isinstance(obj.get("block"), list) or obj.get("keyword") == "trigger"


def _recipe_label(obj, fallback):
    """Human-readable recipe label: prefer name, fall back to id/file stem."""
    name = obj.get("name") or obj.get("title")
    rid = obj.get("id")
    if name and rid is not None:
        return f"{name} (id={rid})"
    return name or (f"id={rid}" if rid is not None else fallback)


def load_corpus(path):
    """
    Returns (recipes, failures).
    recipes: list of dicts: {label, id, name, code, source_file}
    failures: list of (source, reason)
    """
    p = Path(path)
    raw_objects = []   # (obj, source_label)
    failures = []

    # Optional identity manifest for bare code-tree corpora: _index.json in the
    # folder, mapping filename-stem OR recipe name -> {"id": ..., "name": ...}.
    # Produced trivially from GET /recipes (the list endpoint); lets numeric
    # flow_id call bindings resolve when the per-file payloads carry no id.
    index = {}
    if p.is_dir():
        idx_file = p / "_index.json"
        if idx_file.exists():
            try:
                index = json.loads(idx_file.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                failures.append(("_index.json", f"unparseable, ignored: {e}"))

    if p.is_dir():
        files = sorted(f for f in p.glob("*.json") if f.name != "_index.json")
        if not files:
            failures.append((str(p), "no .json files found in directory"))
        for f in files:
            try:
                obj = json.loads(f.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                failures.append((f.name, f"unparseable: {e}"))
                continue
            if isinstance(obj, list):
                # A per-file array (some API dumps write one page per file)
                for i, item in enumerate(obj):
                    raw_objects.append((item, f"{f.name}[{i}]"))
            else:
                raw_objects.append((obj, f.name))
    elif p.is_file():
        try:
            obj = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            return [], [(p.name, f"unparseable: {e}")]
        if isinstance(obj, list):
            for i, item in enumerate(obj):
                raw_objects.append((item, f"{p.name}[{i}]"))
        elif isinstance(obj, dict) and isinstance(obj.get("result"), list):
            # API list envelope: {"result": [...]}
            for i, item in enumerate(obj["result"]):
                raw_objects.append((item, f"{p.name}.result[{i}]"))
        else:
            raw_objects.append((obj, p.name))
    else:
        return [], [(str(p), "path does not exist")]

    recipes = []
    for obj, source in raw_objects:
        if not isinstance(obj, dict):
            failures.append((source, "not a JSON object"))
            continue

        if _is_bare_code_tree(obj):
            # File IS the code tree (API content payload saved directly).
            # Identity must come from outside the file, in priority order:
            #   1. filename convention <PREFIX>_<recipeId>.recipe.json
            #      (e.g. "WFA-015_2121648.recipe.json" -> WFA-015 / 2121648)
            #   2. _index.json manifest (stem or filename keyed)
            #   3. bare numeric stem as the recipe id
            stem = Path(source).stem
            fn_name, fn_id = _identity_from_filename(source)
            meta = index.get(stem) or index.get(source) or {}
            rid = fn_id if fn_id is not None else meta.get("id")
            if rid is None and stem.isdigit():
                rid = int(stem)
            name = meta.get("name") or fn_name
            code = obj
        else:
            code = _normalize_code(obj.get("code"))
            if code is None:
                failures.append((source, "no parseable `code` (missing, or code string is not valid JSON)"))
                continue
            rid = obj.get("id")
            name = obj.get("name")

        recipes.append({
            "label": _recipe_label({"id": rid, "name": name}, source),
            "id": rid,
            "name": name,
            "code": code,
            "source_file": source,
        })
    return recipes, failures


def iter_steps(code):
    """
    Yield (step, path) for every step in the tree, depth-first.
    Handles both shapes: code == root step with nested block, or
    code == {"block": [...]} wrapper.
    path is like "/0:Download file/2:If condition/0:Python".
    """
    def walk(block, path):
        for i, step in enumerate(block or []):
            if not isinstance(step, dict):
                continue
            name = step.get("name") or step.get("keyword") or "?"
            loc = f"{path}/{i}:{name}"
            yield step, loc
            yield from walk(step.get("block"), loc)

    root_block = code.get("block")
    if root_block:
        # The root object itself is usually the trigger; include it.
        root_name = code.get("name") or code.get("keyword") or "trigger"
        yield code, f"/{root_name}"
        yield from walk(root_block, "")
    else:
        yield code, "/root"


# ---------------------------------------------------------------------------
# Layer 0: inventory
# ---------------------------------------------------------------------------

def cmd_inventory(recipes, failures, out_dir, args):
    lines = []
    lines.append(f"Recipes loaded : {len(recipes)}")
    lines.append(f"Load failures  : {len(failures)}")
    for src, reason in failures:
        lines.append(f"  FAIL  {src}: {reason}")
    lines.append("")
    for r in recipes:
        n_steps = sum(1 for _ in iter_steps(r["code"]))
        lines.append(f"  {r['label']:<60} steps={n_steps}  [{r['source_file']}]")
    report = "\n".join(lines)
    (out_dir / "00_inventory.txt").write_text(report, encoding="utf-8")
    print(report)
    if failures:
        print("\n!! Resolve load failures before trusting any verdict below.")
    return {"recipes": len(recipes), "failures": len(failures)}


# ---------------------------------------------------------------------------
# Layer 1: literal scan
# ---------------------------------------------------------------------------

def cmd_scan(recipes, failures, out_dir, args):
    needle = args.needle
    hits = []
    for r in recipes:
        for step, loc in iter_steps(r["code"]):
            for k, v in (step.get("input") or {}).items():
                blob = json.dumps(v)
                if needle in blob:
                    kind = "PYTHON-CODE" if k == "code" else "input"
                    hits.append((r["label"], loc, f"{kind}.{k}"))
            for sk in ("extended_input_schema", "extended_output_schema"):
                if needle in json.dumps(step.get(sk) or []):
                    hits.append((r["label"], loc, sk))
            # step names / comments can carry it too - weak signal, still report
            for meta_key in ("name", "description", "comment"):
                val = step.get(meta_key)
                if isinstance(val, str) and needle in val:
                    hits.append((r["label"], loc, f"meta.{meta_key}"))

    lines = [f"Literal scan for {needle!r} - {len(hits)} hit(s)", ""]
    for label, loc, field in hits:
        lines.append(f"HIT  {label}")
        lines.append(f"     step  : {loc}")
        lines.append(f"     field : {field}")
        lines.append("")
    if not hits:
        lines.append(f"No literal occurrences of {needle!r} anywhere in the corpus.")
        lines.append("(Necessary condition met. Sufficiency requires `consumers` + `pycode`.)")
    report = "\n".join(lines)
    (out_dir / "01_literal_scan.txt").write_text(report, encoding="utf-8")
    print(report)
    return {"hits": len(hits)}


# ---------------------------------------------------------------------------
# Layer 2a: fetch-step inventory
# ---------------------------------------------------------------------------

def _looks_like_fetch(step):
    name = str(step.get("name", "")).lower().replace("_", " ")
    # also check the raw name with underscores intact
    raw = str(step.get("name", "")).lower()
    return any(w in name or w in raw for w in FETCH_WORDS)


def cmd_fetch(recipes, failures, out_dir, args):
    rows = []
    for r in recipes:
        for step, loc in iter_steps(r["code"]):
            # fetch steps are actions; skip if/foreach/try/etc.
            # (keyword can be absent on some root objects - allow None through)
            if step.get("keyword") not in (None, "action"):
                continue
            if _looks_like_fetch(step):
                rows.append({
                    "recipe": r["label"],
                    "loc": loc,
                    "provider": step.get("provider", "?"),
                    "action": step.get("name", "?"),
                    "input_keys": sorted((step.get("input") or {}).keys()),
                })
    lines = [f"File-content-acquiring steps (heuristic) - {len(rows)} found", ""]
    for row in rows:
        lines.append(f"{row['recipe']}")
        lines.append(f"    step     : {row['loc']}")
        lines.append(f"    provider : {row['provider']}   action: {row['action']}")
        lines.append(f"    inputs   : {', '.join(row['input_keys']) or '(none)'}")
        lines.append("")
    if not rows:
        lines.append("No fetch-like steps matched the name heuristic.")
        lines.append("If that seems wrong, check FETCH_WORDS against your actual step names")
        lines.append("(see 00_inventory.txt for the step census).")
    report = "\n".join(lines)
    (out_dir / "02_fetch_inventory.txt").write_text(report, encoding="utf-8")
    print(report)
    return {"fetch_steps": len(rows)}


# ---------------------------------------------------------------------------
# Layer 2b: config/variant JSON consumers, with cross-recipe field propagation
# ---------------------------------------------------------------------------

def _resolve_callee(step, by_id, by_zip, by_name):
    """
    Resolve a call_recipe step to a recipe label, or None.
    Priority: flow_id dict zip_name (authoritative in zip exports) ->
              flow_id scalar id (API) -> dynamicPickListSelection name (last resort).
    """
    inp = step.get("input") or {}
    flow = inp.get("flow_id")
    if isinstance(flow, dict):
        zn = flow.get("zip_name")
        if zn:
            # zip_name is like "recipes/PRV-03 ... .recipe.json"
            stem = Path(str(zn)).name
            for key, label in by_zip.items():
                if key in stem or stem in key:
                    return label
        nm = flow.get("name")
        if nm and nm in by_name:
            return by_name[nm]
        fid = flow.get("id")
        if fid is not None and str(fid) in by_id:
            return by_id[str(fid)]
    elif flow is not None:
        if str(flow) in by_id:
            return by_id[str(flow)]
    # last resort: cached display label (can drift after renames - flagged upstream)
    dpl = (step.get("dynamicPickListSelection") or {}).get("flow_id")
    if isinstance(dpl, str) and dpl in by_name:
        return by_name[dpl]
    return None


def cmd_consumers(recipes, failures, out_dir, args):
    seeds = list(dict.fromkeys(args.seed or DEFAULT_SEED_FIELDS))

    # --- Build call-edge index -------------------------------------------
    by_id = {str(r["id"]): r["label"] for r in recipes if r.get("id") is not None}
    by_name = {r["name"]: r["label"] for r in recipes if r.get("name")}
    by_zip = {r["source_file"]: r["label"] for r in recipes}

    call_sites = []  # {caller, loc, callee, input: {param: value_blob}}
    unresolved = []
    for r in recipes:
        for step, loc in iter_steps(r["code"]):
            if step.get("provider") in CALL_PROVIDERS and \
               any(a in str(step.get("name", "")) for a in CALL_ACTION_NAMES):
                callee = _resolve_callee(step, by_id, by_zip, by_name)
                params = {k: json.dumps(v) for k, v in (step.get("input") or {}).items()
                          if k not in ("flow_id",)}
                if callee is None:
                    unresolved.append((r["label"], loc))
                call_sites.append({
                    "caller": r["label"], "loc": loc,
                    "callee": callee, "params": params,
                })

    # --- Fixpoint propagation of tracked field names ---------------------
    # tracked[recipe_label] = set of field-name substrings that, within THAT
    # recipe, identify config/variant JSON file IDs. Seeds are global.
    tracked = {r["label"]: set(seeds) for r in recipes}
    propagation_log = []

    changed = True
    passes = 0
    while changed and passes < 20:  # bound: corpus chains are shallow
        changed = False
        passes += 1
        for cs in call_sites:
            if cs["callee"] is None:
                continue
            caller_fields = tracked.get(cs["caller"], set())
            for param_name, blob in cs["params"].items():
                if any(f in blob for f in caller_fields):
                    if param_name not in tracked[cs["callee"]]:
                        tracked[cs["callee"]].add(param_name)
                        propagation_log.append(
                            f"pass {passes}: {cs['caller']} -> {cs['callee']}: "
                            f"tracked field enters as parameter '{param_name}' "
                            f"(at {cs['loc']})"
                        )
                        changed = True

    # --- Schema label -> UUID alias expansion -----------------------------
    # Data-table pills reference columns by UUID-ish internal names
    # (e.g. "ff89e5c6_b5b9_..."), while the human field name appears only as
    # a `label` in step schemas. If a tracked field name shows up as a schema
    # label, adopt its internal name (both underscore and hyphen spellings)
    # so pills carrying it still match. Table column ids are workspace-global,
    # so aliases apply corpus-wide.
    def _iter_schema_entries(schema):
        stack = list(schema or [])
        while stack:
            e = stack.pop()
            if not isinstance(e, dict):
                continue
            yield e
            stack.extend(e.get("properties") or [])
            if isinstance(e.get("toggle_field"), dict):
                stack.append(e["toggle_field"])

    all_tracked_names = set()
    for s in tracked.values():
        all_tracked_names |= s
    aliases = {}  # internal name -> the tracked label it stands for
    for r in recipes:
        for step, _loc in iter_steps(r["code"]):
            for sk in ("extended_output_schema", "extended_input_schema"):
                for entry in _iter_schema_entries(step.get(sk)):
                    label = str(entry.get("label", ""))
                    if label in all_tracked_names:
                        internal = str(entry.get("name", ""))
                        if internal and internal != label:
                            aliases[internal] = label
                            aliases[internal.replace("_", "-")] = label
    if aliases:
        for s in tracked.values():
            s |= set(aliases.keys())

    # --- Identify consumer steps -----------------------------------------
    consumers = []
    for r in recipes:
        fields = tracked[r["label"]]
        for step, loc in iter_steps(r["code"]):
            if not _looks_like_fetch(step):
                continue
            blob = json.dumps(step.get("input") or {})
            matched = sorted(f for f in fields if f in blob)
            if matched:
                consumers.append({
                    "recipe": r["label"], "loc": loc,
                    "provider": step.get("provider", "?"),
                    "action": step.get("name", "?"),
                    "matched_fields": matched,
                })

    # --- Report -----------------------------------------------------------
    lines = []
    lines.append(f"Seed fields          : {', '.join(seeds)}")
    lines.append(f"Call sites found     : {len(call_sites)} "
                 f"({len(unresolved)} unresolved callee binding(s))")
    lines.append(f"Propagation passes   : {passes}")
    lines.append("")
    if propagation_log:
        lines.append("Cross-recipe field propagation (caller output -> callee parameter):")
        lines.extend(f"  {l}" for l in propagation_log)
        lines.append("")
    if aliases:
        lines.append("Schema label -> internal (UUID) name aliases adopted:")
        for internal, label in sorted(set(aliases.items()), key=lambda x: (x[1], x[0])):
            if "-" not in internal:  # report each once; hyphen twin is implied
                lines.append(f"  {label}  ->  {internal}")
        lines.append("")
    if unresolved:
        lines.append("UNRESOLVED call sites (verify manually - a consumer could hide here):")
        lines.extend(f"  {c} at {l}" for c, l in unresolved)
        lines.append("")
    lines.append(f"CONFIG/VARIANT JSON CONSUMERS - {len(consumers)} step(s):")
    lines.append("")
    for c in consumers:
        lines.append(f"  {c['recipe']}")
        lines.append(f"      step     : {c['loc']}")
        lines.append(f"      provider : {c['provider']}   action: {c['action']}")
        lines.append(f"      matched  : {', '.join(c['matched_fields'])}")
        lines.append("")
    if not consumers:
        lines.append("  (none - no fetch step's inputs reference a tracked field)")
        lines.append("")
        lines.append("  Caveat: if fetch steps exist (02_fetch_inventory.txt) but none matched,")
        lines.append("  either config JSONs are truly never downloaded by recipes, or the")
        lines.append("  file-ID travels under a name not captured by seeds/propagation")
        lines.append("  (e.g., read from a Data Table column). Check the fetch inventory's")
        lines.append("  input keys against your data model before accepting a clean verdict.")

    report = "\n".join(lines)
    (out_dir / "03_consumers.txt").write_text(report, encoding="utf-8")
    print(report)

    # persist consumer recipe labels for the pycode stage
    (out_dir / "03_consumer_recipes.json").write_text(
        json.dumps(sorted({c["recipe"] for c in consumers}), indent=2), encoding="utf-8")
    return {"call_sites": len(call_sites), "unresolved": len(unresolved),
            "consumers": len(consumers)}


# ---------------------------------------------------------------------------
# Layer 4 helper: dump Python step source from consumer recipes
# ---------------------------------------------------------------------------

def cmd_pycode(recipes, failures, out_dir, args):
    consumer_file = out_dir / "03_consumer_recipes.json"
    scope = None
    if consumer_file.exists():
        scope = set(json.loads(consumer_file.read_text(encoding="utf-8")))
        if not scope:
            msg = ("Consumer list is empty (03_consumers.txt found no consumers), so there\n"
                   "is no Python source to review. Nothing to do.")
            print(msg)
            (out_dir / "04_pycode_review.txt").write_text(msg, encoding="utf-8")
            return {"python_steps": 0}
    else:
        print("No 03_consumer_recipes.json found - dumping Python from ALL recipes.\n"
              "(Run `consumers` first to narrow scope.)")

    py_dir = out_dir / "python_steps"
    py_dir.mkdir(exist_ok=True)

    dumped = []
    for r in recipes:
        if scope is not None and r["label"] not in scope:
            continue
        for step, loc in iter_steps(r["code"]):
            code_src = (step.get("input") or {}).get("code")
            if not isinstance(code_src, str) or not code_src.strip():
                continue
            safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", f"{r['label']}{loc}")[:120]
            f = py_dir / f"{safe}.py"
            f.write_text(code_src, encoding="utf-8")

            flags = []
            for pat, why in WILDCARD_PATTERNS:
                if pat.search(code_src):
                    flags.append(why)
            if args.needle in code_src:
                flags.insert(0, f"CONTAINS LITERAL {args.needle!r}")
            dumped.append({"recipe": r["label"], "loc": loc,
                           "file": f.name, "flags": flags})

    lines = [f"Python step sources dumped: {len(dumped)} (to {py_dir}/)", ""]
    for d in dumped:
        lines.append(f"{d['recipe']}  {d['loc']}")
        lines.append(f"    file  : python_steps/{d['file']}")
        if d["flags"]:
            lines.append(f"    FLAGS : {'; '.join(d['flags'])}")
            lines.append("            ^ read this one - wildcard patterns are where a")
            lines.append("              consumer hides without naming the key")
        else:
            lines.append("    flags : none (likely named-key destructuring; skim to confirm)")
        lines.append("")
    if not dumped:
        lines.append("No embedded Python steps in scope.")
    report = "\n".join(lines)
    (out_dir / "04_pycode_review.txt").write_text(report, encoding="utf-8")
    print(report)
    return {"python_steps": len(dumped), "flagged": sum(1 for d in dumped if d["flags"])}


# ---------------------------------------------------------------------------
# all: run everything, then summarize toward a verdict
# ---------------------------------------------------------------------------

def cmd_all(recipes, failures, out_dir, args):
    print("=" * 72); print("LAYER 0 - INVENTORY"); print("=" * 72)
    inv = cmd_inventory(recipes, failures, out_dir, args)
    print(); print("=" * 72); print("LAYER 1 - LITERAL SCAN"); print("=" * 72)
    scan = cmd_scan(recipes, failures, out_dir, args)
    print(); print("=" * 72); print("LAYER 2a - FETCH INVENTORY"); print("=" * 72)
    fetch = cmd_fetch(recipes, failures, out_dir, args)
    print(); print("=" * 72); print("LAYER 2b - CONFIG JSON CONSUMERS"); print("=" * 72)
    cons = cmd_consumers(recipes, failures, out_dir, args)
    print(); print("=" * 72); print("LAYER 4 - PYTHON SOURCE REVIEW"); print("=" * 72)
    py = cmd_pycode(recipes, failures, out_dir, args)

    verdict = []
    verdict.append("=" * 72)
    verdict.append("SUMMARY TOWARD VERDICT")
    verdict.append("=" * 72)
    verdict.append(f"  recipes loaded        : {inv['recipes']}  (failures: {inv['failures']})")
    verdict.append(f"  literal hits          : {scan['hits']}")
    verdict.append(f"  fetch-like steps      : {fetch['fetch_steps']}")
    verdict.append(f"  config JSON consumers : {cons['consumers']}  "
                   f"(unresolved call bindings: {cons['unresolved']})")
    verdict.append(f"  python steps in scope : {py['python_steps']}  "
                   f"(flagged for reading: {py.get('flagged', 0)})")
    verdict.append("")
    if scan["hits"] > 0:
        verdict.append("  -> LITERAL HITS EXIST. `_mapping` is (at least nominally) live.")
        verdict.append("     Read each hit in 01_literal_scan.txt before any removal.")
    elif inv["failures"] > 0:
        verdict.append("  -> Load failures present. Verdict is NOT trustworthy until the")
        verdict.append("     corpus loads cleanly (see 00_inventory.txt).")
    elif cons["unresolved"] > 0:
        verdict.append("  -> No literal hits, but some call_recipe bindings could not be")
        verdict.append("     resolved. Verify those manually (03_consumers.txt) before")
        verdict.append("     accepting a dead-cargo verdict.")
    elif py.get("flagged", 0) > 0:
        verdict.append("  -> No literal hits; consumers exist and some Python steps show")
        verdict.append("     wildcard patterns. Read the flagged files in python_steps/.")
        verdict.append("     Named-key-only reading = dead cargo. Wildcard = classify per")
        verdict.append("     copy-through vs behavior-changing (len/hash).")
    elif cons["consumers"] == 0 and fetch["fetch_steps"] > 0:
        verdict.append("  -> No consumer matched a tracked field, but fetch steps exist.")
        verdict.append("     Confirm config JSON file IDs don't travel via a channel the")
        verdict.append("     seeds miss (e.g., Data Table column) - see 03_consumers.txt.")
    else:
        verdict.append("  -> All layers clean: no literal, all consumers named-key or none.")
        verdict.append("     Recipe-corpus verdict: `_mapping` is DEAD CARGO.")
        verdict.append("     Remaining coverage: full connector DSL (Ruby analyzer / grep)")
        verdict.append("     and any non-recipe consumers of the Drive JSONs.")
    report = "\n".join(verdict)
    (out_dir / "05_verdict.txt").write_text(report, encoding="utf-8")
    print(); print(report)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command",
                    choices=["inventory", "scan", "fetch", "consumers", "pycode", "all"])
    ap.add_argument("recipes", help="Directory of recipe .json files, or a single "
                                    ".json file containing an array / API envelope")
    ap.add_argument("--out", default="trace_out", help="Output directory (default: trace_out)")
    ap.add_argument("--needle", default=DEFAULT_NEEDLE,
                    help=f"Literal to scan for (default: {DEFAULT_NEEDLE})")
    ap.add_argument("--seed", action="append",
                    help="Tracked field name (repeatable). Defaults to the three "
                         "config/variant file-ID wire names.")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    recipes, failures = load_corpus(args.recipes)
    if not recipes and args.command != "inventory":
        print("No recipes loaded. Run `inventory` for diagnostics:", file=sys.stderr)
        for src, reason in failures:
            print(f"  {src}: {reason}", file=sys.stderr)
        sys.exit(1)

    {"inventory": cmd_inventory, "scan": cmd_scan, "fetch": cmd_fetch,
     "consumers": cmd_consumers, "pycode": cmd_pycode, "all": cmd_all,
     }[args.command](recipes, failures, out_dir, args)


if __name__ == "__main__":
    main()
