#!/usr/bin/env python3
"""corpus.py — the two-tool surface over facts.db (D1: middle path).

    python3 corpus.py query "SELECT * FROM v_field_writes WHERE table_name='WFA_SupplierRequest'"
    python3 corpus.py get-step 12345 0/2/1

Tool 1, query(sql): read-only SQL over the fact store. The catalog views
(schema_catalog.sql) are the recommended surface; base tables remain open
for anything the catalog doesn't cover. Invariants, enforced not suggested:

  * connection is mode=ro — writes are physically impossible
  * SELECT/WITH only (courtesy error before SQLite would refuse anyway)
  * steps.input_json reads are nulled by an authorizer — big detail flows
    only through get_step, one step at a time (rule: no raw code trees)
  * rows capped (default 200) with an explicit truncated marker
  * every result echoes latest_snapshot — evidence carries its vintage

Tool 2, get_step(recipe_id, step_path): the sanctioned drill-down. Full
input with data-table field keys rewritten to 'field_name (field_key)',
the step's datapills, and its outgoing edges. Errors return {error, hint}.

The canonical traversal pattern (query-authored; depth cap is cycle
insurance; COALESCE keeps out-of-snapshot targets visible):

    WITH RECURSIVE chain(rid, label, kind, depth) AS (
      SELECT recipe_id, name, 'root', 0 FROM recipes
       WHERE snapshot_id=(SELECT snapshot_id FROM v_latest_snapshot)
         AND name LIKE 'UPL-01%'
      UNION ALL
      SELECT c2.dst_recipe_id,
             COALESCE(c2.dst_recipe_name, c2.dst_recipe_id||' (external)'),
             c2.kind, c.depth+1
        FROM chain c JOIN v_calls c2 ON c2.src_recipe_id = c.rid
       WHERE c.depth < 8)
    SELECT depth, kind, label FROM chain ORDER BY depth;
"""

import argparse
import difflib
import json
import re
import sqlite3
import sys

DB_PATH = "facts.db"
ROW_CAP = 200
_SELECT_RE = re.compile(r"^\s*(--[^\n]*\n\s*)*(SELECT|WITH)\b", re.IGNORECASE)


# ---- connections -------------------------------------------------------------

def _connect(db_path, shield_inputs):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    if shield_inputs:
        def authorizer(action, arg1, arg2, dbname, trigger):
            if action == sqlite3.SQLITE_READ and (arg1, arg2) == ("steps", "input_json"):
                return sqlite3.SQLITE_IGNORE          # column reads as NULL
            if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH,
                          sqlite3.SQLITE_PRAGMA):
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        con.set_authorizer(authorizer)
    return con


def _latest(con):
    row = con.execute("SELECT MAX(snapshot_id) AS s FROM snapshots").fetchone()
    return row["s"]


# ---- tool 1: query -----------------------------------------------------------

def query(sql, db_path=DB_PATH, row_cap=ROW_CAP):
    if not _SELECT_RE.match(sql or ""):
        return {"error": "only SELECT/WITH statements are accepted",
                "hint": "read paths only; for step inputs use get_step"}
    con = _connect(db_path, shield_inputs=True)
    try:
        latest = _latest(con)
        cur = con.execute(sql)
        rows = cur.fetchmany(row_cap + 1)
        truncated = len(rows) > row_cap
        rows = rows[:row_cap]
        return {"latest_snapshot": latest,
                "columns": [d[0] for d in cur.description] if cur.description else [],
                "rows": [dict(r) for r in rows],
                "count": len(rows),
                "truncated": truncated}
    except sqlite3.Error as e:
        return {"error": str(e),
                "hint": "check names against the catalog: "
                        "SELECT name FROM sqlite_master WHERE type IN ('table','view')"}
    finally:
        con.close()


# ---- tool 2: get_step --------------------------------------------------------

def _rewrite_keys(obj, key_map):
    """Recursively rewrite dict keys matching table_fields.field_key to
    'field_name (field_key)'. Values are untouched."""
    if isinstance(obj, dict):
        return {(f"{key_map[k]} ({k})" if k in key_map else k): _rewrite_keys(v, key_map)
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [_rewrite_keys(v, key_map) for v in obj]
    return obj


def get_step(recipe_id, step_path, snapshot_id=None, db_path=DB_PATH):
    con = _connect(db_path, shield_inputs=False)     # the sanctioned door
    try:
        sid = snapshot_id or _latest(con)
        row = con.execute(
            "SELECT * FROM steps WHERE snapshot_id=? AND recipe_id=? AND step_path=?",
            (sid, str(recipe_id), step_path)).fetchone()
        if row is None:
            names = [r["name"] for r in con.execute(
                "SELECT name FROM recipes WHERE snapshot_id=?", (sid,))]
            rid_known = con.execute(
                "SELECT 1 FROM recipes WHERE snapshot_id=? AND recipe_id=?",
                (sid, str(recipe_id))).fetchone()
            if rid_known:
                paths = [r["step_path"] for r in con.execute(
                    "SELECT step_path FROM steps WHERE snapshot_id=? AND recipe_id=? "
                    "ORDER BY step_path LIMIT 40", (sid, str(recipe_id)))]
                return {"error": f"step '{step_path}' not found in recipe "
                                 f"{recipe_id} (snapshot {sid})",
                        "hint": f"known step_paths: {', '.join(paths)}"}
            close = difflib.get_close_matches(str(recipe_id), names, n=3)
            return {"error": f"recipe_id '{recipe_id}' not found in snapshot {sid}",
                    "hint": "resolve ids by name: SELECT recipe_id, name FROM recipes"
                            + (f" — close names: {', '.join(close)}" if close else "")}

        key_map = {r["field_key"]: r["field_name"] for r in con.execute(
            "SELECT field_key, field_name FROM table_fields WHERE snapshot_id=?",
            (sid,))}
        step_input = json.loads(row["input_json"] or "{}")

        pills = [dict(r) for r in con.execute(
            "SELECT seq, provider, pill_path, table_id, field_name "
            "FROM datapills WHERE snapshot_id=? AND recipe_id=? AND step_path=? "
            "ORDER BY seq", (sid, str(recipe_id), step_path))]
        edges = [dict(r) for r in con.execute(
            "SELECT kind, dst_type, dst_id, dst_name, resolved "
            "FROM edges WHERE snapshot_id=? AND src_recipe_id=? AND src_step_path=?",
            (sid, str(recipe_id), step_path))]

        return {"snapshot_id": sid,
                "recipe_id": str(recipe_id),
                "step_path": step_path,
                "number": row["number"],
                "keyword": row["keyword"],
                "provider": row["provider"],
                "name": row["name"],
                "input": _rewrite_keys(step_input, key_map),
                "datapills": pills,
                "edges_from_step": edges}
    finally:
        con.close()


# ---- CLI ---------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", default=DB_PATH)
    sub = ap.add_subparsers(dest="cmd", required=True)
    q = sub.add_parser("query", help="read-only SQL over facts.db")
    q.add_argument("sql")
    q.add_argument("--cap", type=int, default=ROW_CAP)
    g = sub.add_parser("get-step", help="full detail for exactly one step")
    g.add_argument("recipe_id")
    g.add_argument("step_path")
    g.add_argument("--snapshot", type=int, default=None)
    args = ap.parse_args(argv)

    if args.cmd == "query":
        out = query(args.sql, db_path=args.db, row_cap=args.cap)
    else:
        out = get_step(args.recipe_id, args.step_path,
                       snapshot_id=args.snapshot, db_path=args.db)
    try:
        print(json.dumps(out, indent=2, ensure_ascii=False))
    except BrokenPipeError:                      # downstream closed (| head): fine
        sys.stderr.close()
    return 1 if "error" in out else 0


if __name__ == "__main__":
    sys.exit(main())