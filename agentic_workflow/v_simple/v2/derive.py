#!/usr/bin/env python3
"""derive.py — walk a directory of Workato recipe JSON exports into facts.db.

Usage (Cloud Shell or anywhere with Python 3.9+, stdlib only):

    sqlite3 facts.db < schema.sql          # once
    python3 derive.py --dumps ./recipes --manifest manifest.json \
        --db facts.db --workspace sdc --source manual

Design notes (the parts that encode hard-won recipe-JSON knowledge):

  * The root `code` object is the trigger node; steps nest recursively under
    `block` arrays. `code` may arrive as a dict (parsed export) or as a
    stringified JSON blob (Developer API) — both are handled.
  * step_path is position-in-parent joined with '/', e.g. '1/0'. It is the
    identity. Workato's display `number` is captured but never joined on.
  * `flow_id` (and friends `recipe_id`, `callable_recipe_id`) is normally a
    dict but degrades to a bare numeric string in exports where the target
    couldn't be resolved. Degraded edges are stored with resolved=0, not
    dropped — an unresolvable edge is itself a fact worth surfacing.
  * Data-table column references appear as input keys in UUID form with
    hyphens replaced by underscores. They are detected by shape, recorded in
    detail_json as-is; name resolution is the tool layer's job via
    table_fields.
  * Datapills are `#{_dp('<json descriptor>')}` inside *string values*. We
    regex each string value during the walk (never the serialized whole —
    escaping would corrupt the payload) and parse the descriptor JSON.
  * The manifest format varies; load_manifest() is the single adapter point.
    Without a manifest everything still derives — pill/field resolution just
    degrades to NULLs.
  * The filename contract: recipes end in `.recipe.json`. A snapshot
    directory also carries sidecars (manifest.json, _manifest.json,
    _tables_raw.json) — ignored by ingest and reported, never derived.
    Legacy dumps of plain `.json` recipes still work; sidecar names and
    non-recipe shapes (list root, or no `code` key) are excluded there too.
"""

import argparse
import glob
import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

UUID_HYPHEN_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
UUID_UNDERSCORE_RE = re.compile(
    r"^[0-9a-fA-F]{8}_[0-9a-fA-F]{4}_[0-9a-fA-F]{4}_[0-9a-fA-F]{4}_[0-9a-fA-F]{12}$")
DP_RE = re.compile(r"#\{_dp\('(.*?)'\)\}", re.DOTALL)
CALL_ID_KEYS = ("flow_id", "recipe_id", "callable_recipe_id")
DB_WRITE_WORDS = ("add", "update", "upsert", "delete", "create", "insert", "batch")


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------

def select_recipe_files(dumps_dir):
    """The filename contract, applied. Returns (files, ignored).

    Modern layout: `*.recipe.json` are the recipes; every other .json in the
    directory is a sidecar. Legacy layout (no .recipe.json present): treat
    plain .json as recipes, minus known sidecar names — underscore-prefixed
    files and manifest.json are never recipes. load_recipe_file()'s shape
    guard backstops whatever slips through either way."""
    all_json = sorted(glob.glob(os.path.join(dumps_dir, "*.json")))
    modern = [p for p in all_json if p.endswith(".recipe.json")]
    if modern:
        return modern, [p for p in all_json if not p.endswith(".recipe.json")]
    files, ignored = [], []
    for p in all_json:
        base = os.path.basename(p)
        if base.startswith("_") or base == "manifest.json":
            ignored.append(p)
        else:
            files.append(p)
    return files, ignored


def load_recipe_file(path):
    """Return (recipe_id, top-level dict, code dict). Never raises on shape —
    returns None on unusable files so one bad export doesn't kill the run."""
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError) as e:
        print(f"  SKIP {os.path.basename(path)}: {e}", file=sys.stderr)
        return None
    # A recipe export is a dict WITH a code key. A list root (manifest.json,
    # _tables_raw.json) or a code-less dict (_manifest.json provenance) is a
    # sidecar; the old `data.get("code", {})` let the latter through as a
    # phantom zero-step recipe.
    if not isinstance(data, dict) or "code" not in data:
        shape = "list root" if isinstance(data, list) else "no code key"
        print(f"  SKIP {os.path.basename(path)}: not a recipe export ({shape})",
              file=sys.stderr)
        return None
    code = data["code"]
    if isinstance(code, str):
        try:
            code = json.loads(code)
        except json.JSONDecodeError:
            print(f"  SKIP {os.path.basename(path)}: code is a non-JSON string",
                  file=sys.stderr)
            return None
    if not isinstance(code, dict):
        print(f"  SKIP {os.path.basename(path)}: no code object", file=sys.stderr)
        return None
    rid = data.get("id")
    if rid is None:
        m = re.search(r"\d{4,}", os.path.basename(path))  # id often in filename
        rid = m.group(0) if m else os.path.splitext(os.path.basename(path))[0]
    return str(rid), data, code


def load_manifest(path):
    """Adapter: manifest file -> list of (table_id, table_name, fields),
    fields = list of {uuid, name, type}. Canonical accepted shape:

        [{"table_id": "...", "name": "CFG_...",
          "fields": [{"uuid": "...", "name": "...", "type": "..."}]}]

    Also tolerates {"tables": [...]} wrapping and common key aliases.
    If your manifest differs, this function is the only thing to edit.
    """
    with open(path) as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        data = data.get("tables", [])
    out = []
    for t in data:
        if not isinstance(t, dict):
            continue
        tid = t.get("table_id") or t.get("id")
        name = t.get("name") or t.get("table_name")
        raw_fields = t.get("fields") or t.get("schema") or []
        fields = []
        for f in raw_fields:
            if not isinstance(f, dict):
                continue
            uuid = f.get("uuid") or f.get("field_uuid") or f.get("id")
            fname = f.get("name") or f.get("label") or f.get("field_name")
            if uuid and fname:
                fields.append({"uuid": str(uuid), "name": str(fname),
                               "type": f.get("type") or f.get("field_type")})
        if tid and name:
            out.append((str(tid), str(name), fields))
    return out


# --------------------------------------------------------------------------
# Walking and extraction
# --------------------------------------------------------------------------

def walk_steps(block, parent_path=""):
    """Depth-first over the step tree, yielding (step_path, depth, node)."""
    if not isinstance(block, list):
        return
    for idx, node in enumerate(block):
        if not isinstance(node, dict):
            continue
        path = f"{parent_path}/{idx}" if parent_path else str(idx)
        yield path, path.count("/"), node
        yield from walk_steps(node.get("block"), path)


def iter_string_values(obj):
    """Yield every string value anywhere inside a nested structure."""
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from iter_string_values(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from iter_string_values(v)


def extract_datapills(step_input):
    """All _dp descriptors in a step's input, parsed where possible.
    Returns list of {provider, pill_path, elements} (elements = raw path list)."""
    pills = []
    for s in iter_string_values(step_input):
        for m in DP_RE.finditer(s):
            payload = m.group(1)
            try:
                d = json.loads(payload)
            except json.JSONDecodeError:
                pills.append({"provider": None, "pill_path": payload[:200],
                              "elements": []})
                continue
            path = d.get("path")
            elements = [str(p) for p in path] if isinstance(path, list) else (
                [str(path)] if path is not None else [])
            pills.append({"provider": d.get("provider"),
                          "pill_path": ".".join(elements) or payload[:200],
                          "elements": elements})
    return pills


def extract_call_target(step_input):
    """(dst_id, dst_name, resolved) from whichever call-id key is present.
    Handles the dict-vs-bare-value degradation."""
    for key in CALL_ID_KEYS:
        if key not in step_input:
            continue
        v = step_input[key]
        if isinstance(v, dict):
            dst_id = v.get("id") or v.get("recipe_id")
            return (str(dst_id) if dst_id is not None else None,
                    v.get("name"), 1)
        return str(v), None, 0  # degraded: bare id, name unresolvable
    return None, None, 0


def extract_table_target(step_input):
    """(table_id, table_name) from a workato_db_table step, defensively."""
    v = step_input.get("table_id")
    if isinstance(v, dict):
        tid = v.get("id") or v.get("table_id")
        return (str(tid) if tid is not None else None), v.get("name")
    if v is not None:
        return str(v), None
    return None, None


def classify_db_action(action_name):
    name = (action_name or "").lower()
    return "table_write" if any(w in name for w in DB_WRITE_WORDS) else "table_read"


def fingerprint(code):
    return hashlib.sha256(
        json.dumps(code, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:16]


def prefix_class(table_name):
    return table_name.split("_", 1)[0] if "_" in table_name else "other"


# --------------------------------------------------------------------------
# Main derivation
# --------------------------------------------------------------------------

def derive(db, dumps_dir, manifest_path, workspace, source, notes):
    files, ignored = select_recipe_files(dumps_dir)
    if not files:
        sys.exit(f"No recipe .json files in {dumps_dir}")
    if ignored:
        names = ", ".join(os.path.basename(p) for p in ignored[:5])
        more = f" +{len(ignored) - 5} more" if len(ignored) > 5 else ""
        print(f"ignoring {len(ignored)} sidecar file(s): {names}{more}")

    cur = db.cursor()
    cur.execute(
        "INSERT INTO snapshots (captured_at, workspace, source, notes) VALUES (?,?,?,?)",
        (datetime.now(timezone.utc).isoformat(timespec="seconds"),
         workspace, source, notes))
    sid = cur.lastrowid

    # Manifest first, so pill resolution maps exist during the walk.
    field_by_hyphen, field_by_key = {}, {}
    n_tables = n_fields = 0
    if manifest_path:
        for tid, tname, fields in load_manifest(manifest_path):
            cur.execute("INSERT INTO tables VALUES (?,?,?,?)",
                        (sid, tid, tname, prefix_class(tname)))
            n_tables += 1
            for f in fields:
                hyphen = f["uuid"].replace("_", "-")
                key = f["uuid"].replace("-", "_")
                cur.execute("INSERT INTO table_fields VALUES (?,?,?,?,?,?)",
                            (sid, tid, hyphen, key, f["name"], f["type"]))
                field_by_hyphen[hyphen] = (tid, f["name"])
                field_by_key[key] = (tid, f["name"])
                n_fields += 1

    counts = {"recipes": 0, "steps": 0, "edges": 0, "datapills": 0,
              "unresolved_edges": 0, "unresolved_pills": 0, "skipped": 0}

    for path in files:
        loaded = load_recipe_file(path)
        if loaded is None:
            counts["skipped"] += 1
            continue
        rid, data, code = loaded
        steps = list(walk_steps(code.get("block", [])))

        cur.execute(
            "INSERT INTO recipes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, rid, data.get("name") or rid, None, data.get("folder_id"),
             code.get("provider"), code.get("name"), code.get("keyword"),
             1 if code.get("unfinished") else 0, fingerprint(code),
             len(steps), path))
        counts["recipes"] += 1

        # Recipe-level connection edges from the export's config array.
        for entry in (data.get("config") or []):
            if isinstance(entry, dict) and entry.get("provider"):
                acct = entry.get("account_id")
                acct_name = acct.get("name") if isinstance(acct, dict) else (
                    str(acct) if acct is not None else None)
                cur.execute(
                    "INSERT INTO edges (snapshot_id, kind, src_recipe_id, src_step_path,"
                    " dst_type, dst_id, dst_name, detail_json, resolved)"
                    " VALUES (?,?,?,?,?,?,?,?,?)",
                    (sid, "connection", rid, None, "connection", None,
                     acct_name or entry["provider"],
                     json.dumps({"provider": entry["provider"]}), 1))
                counts["edges"] += 1

        for step_path, depth, node in steps:
            provider = node.get("provider")
            action = node.get("name")
            step_input = node.get("input") or {}
            cur.execute("INSERT INTO steps VALUES (?,?,?,?,?,?,?,?,?)",
                        (sid, rid, step_path, node.get("number"), depth,
                         node.get("keyword"), provider, action,
                         json.dumps(step_input)))
            counts["steps"] += 1

            # -- call edges
            if provider == "workato_recipe_function" and any(
                    k in step_input for k in CALL_ID_KEYS):
                dst_id, dst_name, resolved = extract_call_target(step_input)
                kind = "call_async" if "async" in (action or "") else "call_sync"
                cur.execute(
                    "INSERT INTO edges (snapshot_id, kind, src_recipe_id, src_step_path,"
                    " dst_type, dst_id, dst_name, detail_json, resolved)"
                    " VALUES (?,?,?,?,?,?,?,?,?)",
                    (sid, kind, rid, step_path, "recipe", dst_id, dst_name,
                     json.dumps({"action": action}), resolved))
                counts["edges"] += 1
                counts["unresolved_edges"] += 0 if resolved else 1

            # -- table edges
            if provider == "workato_db_table":
                tid, tname = extract_table_target(step_input)
                columns = sorted(k for k in step_input
                                 if UUID_UNDERSCORE_RE.match(k))
                cur.execute(
                    "INSERT INTO edges (snapshot_id, kind, src_recipe_id, src_step_path,"
                    " dst_type, dst_id, dst_name, detail_json, resolved)"
                    " VALUES (?,?,?,?,?,?,?,?,?)",
                    (sid, classify_db_action(action), rid, step_path, "table",
                     tid, tname, json.dumps({"action": action, "columns": columns}),
                     1 if (tid or tname) else 0))
                counts["edges"] += 1

            # -- datapills (and property edges derived from them)
            for seq, pill in enumerate(extract_datapills(step_input)):
                t_id = f_uuid = f_name = None
                for el in pill["elements"]:
                    norm = el.replace("_", "-") if UUID_UNDERSCORE_RE.match(el) else el
                    if UUID_HYPHEN_RE.match(norm) and norm in field_by_hyphen:
                        t_id, f_name = field_by_hyphen[norm]
                        f_uuid = norm
                        break
                cur.execute("INSERT INTO datapills VALUES (?,?,?,?,?,?,?,?,?)",
                            (sid, rid, step_path, seq, pill["provider"],
                             pill["pill_path"], t_id, f_uuid, f_name))
                counts["datapills"] += 1
                if f_uuid is None and pill["elements"]:
                    counts["unresolved_pills"] += 1
                if pill["provider"] and "propert" in pill["provider"]:
                    cur.execute(
                        "INSERT INTO edges (snapshot_id, kind, src_recipe_id,"
                        " src_step_path, dst_type, dst_id, dst_name, detail_json,"
                        " resolved) VALUES (?,?,?,?,?,?,?,?,?)",
                        (sid, "property", rid, step_path, "property", None,
                         pill["elements"][-1] if pill["elements"] else pill["pill_path"],
                         None, 1))
                    counts["edges"] += 1

    cur.execute("UPDATE snapshots SET recipe_count=? WHERE snapshot_id=?",
                (counts["recipes"], sid))
    db.commit()
    return sid, n_tables, n_fields, counts


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dumps", required=True, help="directory of recipe .json exports")
    ap.add_argument("--manifest", help="table manifest .json (optional but recommended)")
    ap.add_argument("--db", default="facts.db")
    ap.add_argument("--workspace", default="sdc")
    ap.add_argument("--source", default="manual",
                    choices=["manual", "scheduled", "webhook"])
    ap.add_argument("--notes", default=None)
    args = ap.parse_args(argv)

    if not os.path.exists(args.db):
        sys.exit(f"{args.db} not found — create it first: sqlite3 {args.db} < schema.sql")

    db = sqlite3.connect(args.db)
    db.execute("PRAGMA foreign_keys = ON")
    sid, n_tables, n_fields, counts = derive(
        db, args.dumps, args.manifest, args.workspace, args.source, args.notes)

    print(f"snapshot {sid}: {counts['recipes']} recipes, {counts['steps']} steps, "
          f"{counts['edges']} edges, {counts['datapills']} datapills")
    print(f"manifest: {n_tables} tables, {n_fields} fields"
          if n_tables else "manifest: none (pill/field resolution degraded)")
    if counts["skipped"]:
        print(f"NOTE: {counts['skipped']} file(s) skipped as unusable "
              f"(see SKIP lines above)")
    if counts["unresolved_edges"]:
        print(f"NOTE: {counts['unresolved_edges']} call edge(s) with degraded "
              f"targets (resolved=0) — bare flow_id in export")
    if counts["unresolved_pills"]:
        print(f"NOTE: {counts['unresolved_pills']} datapill(s) reference paths "
              f"not resolvable to manifest fields")


if __name__ == "__main__":
    main()