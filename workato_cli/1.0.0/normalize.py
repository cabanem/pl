"""normalize — stage 2: recipe JSON `code` tree -> deterministic step list.

Pure, per-recipe. Same JSON in -> same NormStep list out, every run and every
workspace. Emits NO edges; just the framed, ordered step skeleton.

Built against the Workato `code` shape from the documented Create-a-recipe
sample (number / provider / name / as / keyword / input / block / uuid). The
exact if/else/elsif branch encoding is the one piece to reconcile against real
recipe JSON at stage 1 — here branches are keyword'd child steps indexed
positionally, which keeps normalize a plain deterministic index walk.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

CONTROL_KEYWORDS = {"if", "else", "elsif", "try", "catch", "foreach", "stop"}

# UUID rendered in datapill-safe (underscored) form, as it appears in recipe code.
_UUID_USCORE = re.compile(r"^[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$", re.I)


@dataclass
class NormStep:
    uuid: str
    path: str                  # positional path through the tree, e.g. "0/8" ; PRIMARY anchor is uuid
    keyword: str               # trigger | action | if | else | try | catch | foreach
    provider: Optional[str]
    name: Optional[str]        # get_records, call_recipe, invoke_custom_py_code, ...
    frame: str                 # enclosing control keyword, else "none"
    input: dict = field(default_factory=dict)
    # field_id (hyphenated) -> the recipe author's label, distilled from the step's
    # extended schema. This is the column's logical name as the recipe sees it; it
    # is preferred over the (drift-prone) live data-table column name at resolve.
    field_labels: dict = field(default_factory=dict)


def _field_labels(node: dict) -> dict:
    """Distill {field_id -> label} from a step's extended_output/input schema.

    Schema rows carry `name` = the field UUID in datapill-safe (underscored) form
    and `label` = the author's logical name. Hyphenate the name to the canonical
    field_id so it joins the table registry / write-step parameter keys.

    Recurses into nested objects, emitting dotted leaf paths (e.g. the key and
    label `planes.data_row`). Data-table column schemas are flat, so their entries
    stay bare field_ids; only genuinely nested return schemas produce dotted keys,
    and those never match a column lookup, so column resolution is unaffected.
    """
    out: dict = {}

    def walk(props, key_prefix: str, label_prefix: str) -> None:
        for prop in props or []:
            name, label = prop.get("name"), prop.get("label")
            if not name:
                continue
            fid = name.replace("_", "-") if _UUID_USCORE.match(name) else name
            key = key_prefix + fid
            lbl = label_prefix + (label or name)
            sub = prop.get("properties")
            if sub:
                walk(sub, key + ".", lbl + ".")     # descend; the object node itself isn't a leaf
            elif label:
                out.setdefault(key, lbl)

    for src in ("extended_output_schema", "extended_input_schema"):
        for entry in node.get(src) or []:
            if entry.get("properties"):
                walk(entry.get("properties"), "", "")   # envelope/container (`result`/`record`/a list): take its leaves
            else:
                walk([entry], "", "")                   # a top-level field with no wrapper (e.g. http_status_code)
    return out


def normalize(code: dict) -> list[NormStep]:
    out: list[NormStep] = []

    # Path format ported verbatim from the GAS walkSteps_: children are
    # addressed as `block[i].`-chained prefixes, root visited with "". This
    # keeps Python anchors identical to what inspectProviderSamples emits.
    def walk(node: dict, prefix: str, frame: str) -> None:
        out.append(NormStep(
            uuid=node.get("uuid", ""),
            path=prefix if prefix else "(root)",
            keyword=node.get("keyword", "action"),
            provider=node.get("provider"),
            name=node.get("name"),
            frame=frame,
            input=node.get("input", {}) or {},
            field_labels=_field_labels(node),
        ))
        kw = node.get("keyword")
        child_frame = kw if kw in CONTROL_KEYWORDS else frame
        for i, child in enumerate(node.get("block", []) or []):
            walk(child, f"{prefix}block[{i}].", child_frame)

    walk(code, "", "none")
    return out
