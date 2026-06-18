"""workato_client — stage 1 fetch. Ported from the GAS toolkit
(000_workato_lib.js getWorkatoConfig_/httpJson_ + 002_workato_recipes.js
getStructuredRecipes/replicateTableDiscovery/safeParseJson_).

This is the ONLY impure stage. The network call is injected as `transport`, so
every downstream stage stays a pure function of this module's frozen output and
the whole client is testable offline against canned responses.

Two hosts (from getWorkatoConfig_):
  platform : WORKATO_BASE_URL        -> recipes, table list, folder_assets
  records  : app. -> data-tables.    -> table schema, table /query
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional


class WorkatoHTTPError(RuntimeError):
    pass


# --- .env loader (stdlib; no python-dotenv dependency) ---------------------
def load_dotenv(path=None, override: bool = False) -> dict:
    """Populate os.environ from a KEY=VALUE .env file.

    Defaults to the .env next to this module (the project root), so it works
    regardless of your shell's current directory. Existing environment variables
    are NOT overwritten unless override=True, so a real `export` always wins.
    Returns the keys it set, for debugging. A missing file is a no-op.
    """
    path = Path(path) if path else Path(__file__).resolve().parent / ".env"
    if not path.exists():
        return {}
    loaded = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        if "=" not in line:
            continue
        key, _, val = line.partition("=")          # split on first '=' only
        key = key.strip()
        val = val.strip().strip('"').strip("'")     # tolerate quoted values
        if override or key not in os.environ:
            os.environ[key] = val
            loaded[key] = val
    return loaded


# --- config (getWorkatoConfig_) -------------------------------------------
@dataclass(frozen=True)
class WorkatoConfig:
    api_token: str
    base_url: str
    records_host: str

    @staticmethod
    def from_env(env: Optional[dict] = None) -> "WorkatoConfig":
        env = env if env is not None else os.environ
        token = env.get("WORKATO_API_TOKEN", "")
        base = (env.get("WORKATO_BASE_URL") or "https://app.eu.workato.com").rstrip("/")
        explicit = env.get("WORKATO_RECORDS_URL")
        records = (explicit.rstrip("/") if explicit
                   else re.sub(r"^https?://app\.", "https://data-tables.", base))
        return WorkatoConfig(api_token=token, base_url=base, records_host=records)


# --- transport (injectable; default uses stdlib urllib) --------------------
# Signature: (method, url, headers, body_or_None) -> (status_code, response_text)
Transport = Callable[[str, str, dict, Optional[str]], "tuple[int, str]"]


def urllib_transport(method: str, url: str, headers: dict, body: Optional[str]) -> "tuple[int, str]":
    data = body.encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.getcode(), resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


# --- parse-once boundary (safeParseJson_) ----------------------------------
def safe_parse_json(value):
    """object -> passthrough, string -> json.loads, null -> None.
    The `code`/`config` fields arrive as JSON strings; `config` may arrive
    already-decoded. This handles both, matching the GAS safeParseJson_."""
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return value


# --- client (httpJson_ retry + the recipe/table endpoints) -----------------
RETRY_DELAYS = (1.0, 2.0, 4.0)   # ported from httpJson_: retry 429/5xx, else fail fast


@dataclass
class WorkatoClient:
    config: WorkatoConfig
    transport: Transport = urllib_transport
    sleep: Callable[[float], None] = time.sleep

    # -- HTTP ----------------------------------------------------------------
    def _url(self, path: str, host: str) -> str:
        if path.startswith("http"):
            return path
        base = self.config.records_host if host == "records" else self.config.base_url
        return f"{base}{path}"

    def _request(self, method: str, path: str, body=None, label="request", host="platform"):
        url = self._url(path, host)
        headers = {"Authorization": f"Bearer {self.config.api_token}", "Accept": "application/json"}
        payload = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body)

        for attempt in range(len(RETRY_DELAYS) + 1):
            status, text = self.transport(method, url, headers, payload)
            if 200 <= status < 300:
                return json.loads(text) if text else None
            transient = status == 429 or (500 <= status <= 599)
            if transient and attempt < len(RETRY_DELAYS):
                self.sleep(RETRY_DELAYS[attempt])
                continue
            raise WorkatoHTTPError(f"{label} failed (HTTP {status}): {str(text)[:500]}")

    def get(self, path: str, label="GET", host="platform"):
        return self._request("GET", path, None, label, host)

    def post(self, path: str, body, label="POST", host="records"):
        return self._request("POST", path, body, label, host)

    # -- recipes (getStructuredRecipes) -------------------------------------
    def list_recipes(self, folder_id=None, running=False, per_page=100) -> Iterator[dict]:
        page = 1
        while True:
            params = {"page": page, "per_page": per_page}
            if folder_id is not None:
                params["folder_id"] = folder_id
            if running:
                params["running"] = "true"
            data = self.get(f"/api/recipes?{urllib.parse.urlencode(params)}", "List recipes")
            batch = data.get("items") if isinstance(data, dict) else data
            batch = batch or []
            yield from batch
            if len(batch) < per_page:
                break
            page += 1

    def get_recipe(self, recipe_id) -> dict:
        return self.get(f"/api/recipes/{recipe_id}", f"Recipe {recipe_id} detail")

    def get_structured_recipes(self, folder_id=None, running=False, include_code=False) -> list:
        out = []
        for r in self.list_recipes(folder_id=folder_id, running=running):
            rec = {
                "id":                  r.get("id"),
                "name":                r.get("name"),
                "folder_id":           r.get("folder_id"),
                "running":             r.get("running"),
                "description":         r.get("description") or "",
                "trigger_application": r.get("trigger_application"),
                "action_applications": r.get("action_applications") or [],
                "created_at":          r.get("created_at"),
                "updated_at":          r.get("updated_at"),
            }
            if include_code:
                detail = self.get_recipe(r["id"])
                rec["code"] = safe_parse_json(detail.get("code"))      # second parse at the boundary
                rec["config"] = safe_parse_json(detail.get("config"))
            out.append(rec)
        return out

    # -- data tables (replicateTableDiscovery + schema GET) -----------------
    def list_data_tables(self, per_page=100) -> list:
        page, out = 1, []
        while True:
            data = self.get(f"/api/data_tables?page={page}&per_page={per_page}", "List data tables")
            if isinstance(data, dict):
                batch = data.get("data") or data.get("records") or []
            else:
                batch = data or []
            out.extend(batch)
            if len(batch) < per_page:
                break
            page += 1
        return out

    def get_table_schema(self, table_id) -> dict:
        # records host, GET /api/v1/tables/:id -> { data: { id, name, schema: [...] } }
        data = self.get(f"/api/v1/tables/{table_id}", f"Table {table_id} schema", host="records")
        return (data or {}).get("data") or data or {}

    # -- handle authority (folder_assets) -----------------------------------
    def folder_assets(self, folder_id) -> list:
        data = self.get(
            f"/api/export_manifests/folder_assets?folder_id={folder_id}", "Folder assets"
        )
        return ((data or {}).get("result") or {}).get("assets") or []

    # -- folders (for production scoping) -----------------------------------
    def list_folders(self, parent_id=None) -> list:
        # GET /api/folders?parent_id= -> flat list of {id, name, parent_id, ...}
        path = "/api/folders"
        if parent_id is not None:
            path += f"?parent_id={urllib.parse.quote(str(parent_id))}"
        data = self.get(path, "List folders")
        if isinstance(data, dict):
            return data.get("result") or data.get("items") or []
        return data or []
