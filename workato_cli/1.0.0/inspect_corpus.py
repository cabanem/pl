"""inspect_corpus — the empirical instruments, ported from 010_recipe_inspector.js.

Pure functions over a corpus (recipes each with a parsed `code`). These are what
settle the open vocabulary flags against ground truth instead of guesswork:

  inspect_connector_usage    -> py_eval vs workato_python; the data-table provider
  inspect_recipe_keywords    -> is a recipe call `keyword: call`? are else/elsif siblings?
  inspect_provider_input_keys-> the table key; the writes_column record-map key
  inspect_provider_samples   -> eyeball full steps for a provider

No I/O. Run them over the fetched corpus; the answers replace the candidate-key
lists in extract.py with confirmed values.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Iterator


def walk_steps(code: dict) -> Iterator[dict]:
    """Pre-order walk over the recursive `block` tree (matches walkSteps_)."""
    if not isinstance(code, dict):
        return
    stack = [code]
    while stack:
        node = stack.pop()
        yield node
        block = node.get("block")
        if isinstance(block, list):
            for child in reversed(block):       # reversed so pop() yields in order
                if isinstance(child, dict):
                    stack.append(child)


def inspect_connector_usage(recipes: list) -> Counter:
    """Distinct (provider, name) pairs with counts. THE first thing to run."""
    c: Counter = Counter()
    for r in recipes:
        for node in walk_steps(r.get("code") or {}):
            prov = node.get("provider")
            if prov:
                c[(prov, node.get("name") or "")] += 1
    return c


def inspect_recipe_keywords(recipes: list) -> Counter:
    """Distinct `keyword` values with counts."""
    c: Counter = Counter()
    for r in recipes:
        for node in walk_steps(r.get("code") or {}):
            c[node.get("keyword") or "(none)"] += 1
    return c


def inspect_provider_input_keys(recipes: list, provider: str) -> dict:
    """For one provider: {action_name: Counter(input_key -> count)}."""
    out: dict = defaultdict(Counter)
    for r in recipes:
        for node in walk_steps(r.get("code") or {}):
            if node.get("provider") != provider:
                continue
            action = node.get("name") or "(no name)"
            for k in (node.get("input") or {}).keys():
                out[action][k] += 1
    return dict(out)


def inspect_provider_samples(recipes: list, provider: str, limit: int = 3) -> list:
    """Up to `limit` full step samples for a provider."""
    samples: list = []
    for r in recipes:
        for node in walk_steps(r.get("code") or {}):
            if len(samples) >= limit:
                return samples
            if node.get("provider") != provider:
                continue
            samples.append({
                "recipe_id": r.get("id"),
                "keyword": node.get("keyword"),
                "provider": node.get("provider"),
                "name": node.get("name"),
                "input": node.get("input"),
            })
    return samples
