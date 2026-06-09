"""
Reconcile a seed file against the supplier roster (the fan-out 'decide' step).

Parses the seed CSV, takes the distinct values in the index_key column, and matches
them against the roster -- suppliers in SUP_Supplier that have a corresponding
SUP_SupplierRequest row. The data model allows at most one request per supplier, so
a name match resolves to exactly one supplier_request_id.

Partitions the distinct keys into three buckets:
    matched    -> exactly one roster supplier   (carries the request to build)
    unmatched  -> no roster supplier             (flagged; nothing built)
    ambiguous  -> more than one roster supplier  (flagged; only possible if
                  supplier_name is NOT unique in SUP_Supplier)

Two deliberate choices:
  * Matching normalizes case + internal whitespace ONLY, never punctuation --
    stripping punctuation could merge two genuinely different suppliers, so
    'Acme Inc' vs 'Acme, Inc.' surface as unmatched for review rather than fusing.
  * Each matched entry carries the seed's VERBATIM index value as `seed_value`.
    The worker filters the seed with a strip-only, case-sensitive compare, so
    handing it the verbatim value (not the roster's canonical name) guarantees it
    re-selects exactly the rows counted here -- this closes the normalization-drift
    trap between the two recipes.

`reconcile` is Workato-agnostic and unit-testable; the entrypoint is a thin adapter.
"""

import csv
import io
import re


# --- normalization ----------------------------------------------------------
_REQUIRED_MARKER = re.compile(r"\s*\*\s*$")
_WS_RUN = re.compile(r"\s+")


def _field_key(name):
    """Canonical column-name key (drops TPL-02's ' *' marker; trims)."""
    return _REQUIRED_MARKER.sub("", str(name if name is not None else "")).strip()


def _match_key(value):
    """Lenient key for matching a name VALUE: casefold + trim + collapse internal
    whitespace. Punctuation is left intact on purpose."""
    return _WS_RUN.sub(" ", str(value if value is not None else "").strip()).casefold()


def _first(row, *keys):
    """First present, non-empty key. Tolerates Workato's sibling-array auto-suffix
    (supplier_id -> supplier_id1) when two passed arrays share a field name."""
    for k in keys:
        if k in row and row[k] not in (None, ""):
            return row[k]
    return None


# --- seed parsing -----------------------------------------------------------
def _to_bytes(content):
    if isinstance(content, (bytes, bytearray)):
        return bytes(content)
    if isinstance(content, str):
        return content.encode("latin-1")
    raise TypeError(f"Unexpected file content type: {type(content)}")


def _distinct_index_values(seed_bytes, index_key):
    """Distinct VERBATIM values in the index column, in first-seen order."""
    reader = csv.DictReader(io.StringIO(_to_bytes(seed_bytes).decode("utf-8-sig")))
    header_for_key = {_field_key(h): h for h in (reader.fieldnames or [])}
    index_norm = _field_key(index_key)
    if index_norm not in header_for_key:
        raise ValueError(
            f"index_key '{index_key}' not in seed columns: {list(header_for_key)}"
        )
    index_header = header_for_key[index_norm]

    seen, distinct = set(), []
    for row in reader:
        value = str(row.get(index_header) or "").strip()
        if value and value not in seen:
            seen.add(value)
            distinct.append(value)
    return distinct


# --- pure core --------------------------------------------------------------
def reconcile(seed_bytes, index_key, supplier_rows, supplier_request_rows):
    """Return a dict of buckets + counts."""

    # supplier_id -> canonical name
    name_by_id = {}
    for s in (supplier_rows or []):
        sid = _first(s, "supplier_id", "supplier_id1")
        name = _first(s, "supplier_name", "supplier_name1")
        if sid is not None and name is not None:
            name_by_id[str(sid)] = str(name)

    # normalized name -> [roster entries]  (a list so duplicate names are detectable)
    roster_by_norm = {}
    for r in (supplier_request_rows or []):
        sid = _first(r, "supplier_id", "supplier_id1")
        req_id = _first(r, "supplier_request_id", "supplier_request_id1")
        if sid is None or req_id is None:
            continue
        name = name_by_id.get(str(sid))
        if name is None:
            continue  # request whose supplier_id has no SUP_Supplier row -> unmatchable by name
        roster_by_norm.setdefault(_match_key(name), []).append({
            "supplier_id": str(sid),
            "supplier_name": name,
            "supplier_request_id": str(req_id),
        })

    matched, unmatched, ambiguous = [], [], []
    for value in _distinct_index_values(seed_bytes, index_key):
        candidates = roster_by_norm.get(_match_key(value), [])
        if not candidates:
            unmatched.append(value)
        elif len(candidates) == 1:
            entry = dict(candidates[0])
            entry["seed_value"] = value          # verbatim -> worker's match_value
            matched.append(entry)
        else:
            ambiguous.append({
                "seed_value": value,
                "supplier_request_ids": [c["supplier_request_id"] for c in candidates],
            })

    return {
        "matched": matched,
        "unmatched": unmatched,
        "ambiguous": ambiguous,
        "matched_count": len(matched),
        "unmatched_count": len(unmatched),
        "ambiguous_count": len(ambiguous),
    }


# --- Workato entrypoint (thin adapter) --------------------------------------
# Inputs to wire:
#   seed_file              : get_file_contents(seed_data_file_path)
#   index_key              : parameters.seed_data.index_key
#   supplier_rows          : get_records(SUP_Supplier)         -> supplier_id, supplier_name
#   supplier_request_rows  : get_records(SUP_SupplierRequest)  -> supplier_id, supplier_request_id
#                            (filter to your in-scope / open requests at the get_records step;
#                             this action treats the roster it's handed as authoritative)
#
# IMPORTANT: give 'matched' an explicit output schema -- array of objects with
# seed_value / supplier_id / supplier_name / supplier_request_id -- so its sub-fields
# are drillable as datapills in the repeat step. Loop over 'matched' synchronously
# and call the worker recipe, passing match_value = seed_value.
def main(input):
    result = reconcile(
        seed_bytes=input["seed_file"],
        index_key=input["index_key"],
        supplier_rows=input.get("supplier_rows") or [],
        supplier_request_rows=input.get("supplier_request_rows") or [],
    )
    result["unmatched_keys"] = ", ".join(result["unmatched"])   # display convenience
    return result
