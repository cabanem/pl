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

from dataclasses import dataclass, field
from typing import Optional

CONTROL_KEYWORDS = {"if", "else", "elsif", "try", "catch", "foreach"}


@dataclass
class NormStep:
    uuid: str
    path: str                  # positional path through the tree, e.g. "0/8" ; PRIMARY anchor is uuid
    keyword: str               # trigger | action | if | else | try | catch | foreach
    provider: Optional[str]
    name: Optional[str]        # get_records, call_recipe, invoke_custom_py_code, ...
    frame: str                 # enclosing control keyword, else "none"
    input: dict = field(default_factory=dict)


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
        ))
        kw = node.get("keyword")
        child_frame = kw if kw in CONTROL_KEYWORDS else frame
        for i, child in enumerate(node.get("block", []) or []):
            walk(child, f"{prefix}block[{i}].", child_frame)

    walk(code, "", "none")
    return out
