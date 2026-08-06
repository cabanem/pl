"""dump_recipes — capture a Workato recipe corpus snapshot, one file per recipe.

Standalone Cloud Shell edition (stdlib only). The original was a thin CLI over
Workspace.dump() in sdc-recipe-model; this version talks to the Developer API
directly so Phase 1 has zero repo dependencies. Output conventions are kept
compatible: one `{handle}__{id}.recipe.json` per recipe (code tree parsed,
pretty, deterministic — a committed dump diffs cleanly against the next one),
provenance in `_manifest.json`. New here: it also fetches the data-table
schemas and writes `manifest.json` in the shape derive.py expects
([{table_id, name, fields:[{uuid, name, type}]}]).

Two manifests, deliberately distinct:
    _manifest.json   provenance of THIS dump (what, when, errors)
    manifest.json    the table schema map (uuid -> field name) for derive.py

Usage (per GUIDE.md Phase 1 — token comes from Secret Manager, never a file):

    export WORKATO_API_TOKEN="$(gcloud secrets versions access latest --secret=${SECRET})"
    python3 dump_recipes.py --folder 12345 --dest dumps/${SNAP}
    python3 dump_recipes.py --folder 12345 --dest dumps/${SNAP} STS-01 UPL-01 84

Environment:
    WORKATO_API_TOKEN   required. Bearer token for the Developer API.
    WORKATO_API_BASE    default https://www.workato.com
                        (EU data center: https://app.eu.workato.com)
    SDC_FOLDER_ID       default for --folder
    SDC_DUMP_DIR        default for --dest (falls back to ./dumps)

GET-only toward the API. Writes only inside --dest. Exit 1 if any errors.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = os.environ.get("WORKATO_API_BASE", "https://www.workato.com").rstrip("/")
PER_PAGE = 100
PACING_S = 0.5          # ~58 recipes + listings stays well under 60 req/min
RETRIES = 3
_FILE_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


# ---- API access (GET-only) ---------------------------------------------------

def api_get(path: str, token: str, params: dict | None = None):
    """One GET with honest retry on 429/5xx. Returns parsed JSON."""
    url = f"{BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    last_err: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < RETRIES:
                wait = int(e.headers.get("Retry-After", 2 ** attempt))
                time.sleep(wait)
                last_err = e
                continue
            raise
        except urllib.error.URLError as e:
            if attempt < RETRIES:
                time.sleep(2 ** attempt)
                last_err = e
                continue
            raise
    raise RuntimeError(f"unreachable after retries: {url}") from last_err


def unwrap_list(payload) -> list:
    """The API wraps lists inconsistently ({'items': [...]}, {'data': [...]},
    or a bare array). Normalize at the boundary, once."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("items", "data", "result", "recipes"):
            if isinstance(payload.get(key), list):
                return payload[key]
    raise ValueError(f"unrecognized list envelope: {type(payload).__name__} "
                     f"keys={list(payload)[:5] if isinstance(payload, dict) else '-'}")


def paged(path: str, token: str, params: dict) -> list:
    out: list = []
    page = 1
    while True:
        batch = unwrap_list(api_get(path, token, {**params,
                                                 "per_page": PER_PAGE,
                                                 "page": page}))
        out.extend(batch)
        if len(batch) < PER_PAGE:
            return out
        page += 1


# ---- Recipes -----------------------------------------------------------------

def dump_name(handle: str, rid) -> str:
    safe = _FILE_UNSAFE.sub("_", handle).strip("_") or "recipe"
    return f"{safe}__{rid}.recipe.json"


def parse_code_in_place(recipe: dict) -> dict:
    """`code` arrives as a JSON string from the API; downstream wants the tree.
    Tolerate already-parsed code (fixture round-trips)."""
    code = recipe.get("code")
    if isinstance(code, str):
        recipe["code"] = json.loads(code)
    return recipe


def select_targets(listed: list[dict], targets: list[str]) -> list[dict]:
    """Positional args: numeric -> recipe id, anything else -> name prefix
    (case-insensitive), matching the original CLI's `STS-01 UPL-01 84` form."""
    if not targets:
        return listed
    by_id = {str(r.get("id")): r for r in listed}
    chosen: dict[str, dict] = {}
    misses: list[str] = []
    for t in targets:
        if t in by_id:
            chosen[t] = by_id[t]
            continue
        hits = [r for r in listed
                if str(r.get("name", "")).lower().startswith(t.lower())]
        if hits:
            for r in hits:
                chosen[str(r["id"])] = r
        else:
            misses.append(t)
    if misses:
        print(f"  !! no match for targets: {', '.join(misses)}", file=sys.stderr)
    return list(chosen.values())


# ---- Data-table manifest -----------------------------------------------------

def field_uuid(field: dict):
    """Key name for the field uuid has varied across API versions; take the
    first plausible. If all miss, the raw dump is the escape hatch."""
    for k in ("field_id", "uuid", "id"):
        if field.get(k):
            return field[k]
    return None


def build_table_manifest(tables: list[dict]) -> list[dict]:
    """Map the API response into derive.py's canonical shape. load_manifest()
    in derive.py remains the adapter point if this mapping ever degrades."""
    out = []
    for t in tables:
        fields = t.get("schema") or t.get("fields") or []
        out.append({
            "table_id": t.get("id"),
            "name": t.get("name"),
            "fields": [{
                "uuid": field_uuid(f),
                "name": f.get("name"),
                "type": f.get("type"),
            } for f in fields if isinstance(f, dict)],
        })
    return out


# ---- Main --------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("targets", nargs="*",
                    help="recipe ids or name prefixes; empty = whole folder")
    ap.add_argument("--folder", default=os.environ.get("SDC_FOLDER_ID"),
                    help="folder_id to scope the listing (default: $SDC_FOLDER_ID; "
                         "omit to dump everything the token can see)")
    ap.add_argument("--dest", default=os.environ.get("SDC_DUMP_DIR", "dumps"),
                    help="output directory (default: $SDC_DUMP_DIR or ./dumps)")
    ap.add_argument("--no-tables", action="store_true",
                    help="skip the data-table manifest fetch")
    args = ap.parse_args()

    token = os.environ.get("WORKATO_API_TOKEN")
    if not token:
        print("WORKATO_API_TOKEN is unset — fetch it from Secret Manager first "
              "(see GUIDE.md Phase 1).", file=sys.stderr)
        return 1

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)

    # 1. Enumerate.
    list_params = {"folder_id": args.folder} if args.folder else {}
    if not args.folder:
        print("  note: no --folder / SDC_FOLDER_ID — dumping every recipe "
              "visible to this token", file=sys.stderr)
    listed = paged("/api/recipes", token, list_params)
    picked = select_targets(listed, args.targets)
    print(f"listed {len(listed)} recipe(s); dumping {len(picked)}")

    # 2. Fetch each once, parse code at the boundary, write deterministically.
    entries: list[dict] = []
    errors: list[list[str]] = []
    for r in picked:
        rid = r.get("id")
        try:
            detail = api_get(f"/api/recipes/{rid}", token)
            recipe = detail.get("recipe", detail) if isinstance(detail, dict) else detail
            recipe = parse_code_in_place(recipe)
            fname = dump_name(str(recipe.get("name", rid)), rid)
            (dest / fname).write_text(
                json.dumps(recipe, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8")
            entries.append({"file": fname, "id": rid,
                            "name": recipe.get("name"),
                            "running": recipe.get("running")})
            print(f"  {fname}")
        except Exception as ex:                                  # noqa: BLE001
            errors.append([str(rid), repr(ex)])
            print(f"  !! {rid}: {ex!r}", file=sys.stderr)
        time.sleep(PACING_S)

    # 3. Data-table manifest for derive.py (+ raw escape hatch).
    tables_note = "skipped (--no-tables)"
    if not args.no_tables:
        try:
            raw_tables = paged("/api/data_tables", token, {})
            (dest / "_tables_raw.json").write_text(
                json.dumps(raw_tables, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8")
            manifest = build_table_manifest(raw_tables)
            (dest / "manifest.json").write_text(
                json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8")
            unresolved = sum(1 for t in manifest for f in t["fields"]
                             if f["uuid"] is None)
            tables_note = (f"{len(manifest)} table(s); "
                           f"{unresolved} field(s) without uuid"
                           + (" — check _tables_raw.json and adapt "
                              "load_manifest()" if unresolved else ""))
        except Exception as ex:                                  # noqa: BLE001
            tables_note = f"FAILED: {ex!r} (token may lack data-table scope)"
            errors.append(["data_tables", repr(ex)])
            print(f"  !! data tables: {ex!r}", file=sys.stderr)

    # 4. Provenance (original _manifest.json shape, plus tables note).
    provenance = {
        "folder_id": args.folder,
        "dumped_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "api_base": BASE,
        "recipes": sorted(entries, key=lambda e: e["file"]),
        "tables": tables_note,
        "errors": errors,
    }
    (dest / "_manifest.json").write_text(
        json.dumps(provenance, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8")

    # 5. Honest report.
    print(f"\nwrote {len(entries)} recipe file(s) to {dest}/")
    print(f"tables: {tables_note}")
    if errors:
        print(f"errors: {len(errors)} (see _manifest.json)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
