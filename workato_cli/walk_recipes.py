#!/usr/bin/env python3
"""Layer 1: literal scan for _mapping across the recipe corpus."""
import json
from pathlib import Path

NEEDLE = "_mapping"
RECIPES = Path("recipes")

hits = []

def walk(block, recipe, path=""):
    for i, step in enumerate(block or []):
        loc = f"{path}/{i}:{step.get('name', step.get('keyword','?'))}"

        for k, v in (step.get("input") or {}).items():
            blob = json.dumps(v)
            if NEEDLE in blob:
                kind = "PYTHON-CODE" if k == "code" else "input"
                hits.append((recipe, loc, f"{kind}.{k}"))

        for sk in ("extended_input_schema", "extended_output_schema"):
            if NEEDLE in json.dumps(step.get(sk) or []):
                hits.append((recipe, loc, sk))

        walk(step.get("block"), recipe, loc)

for p in sorted(RECIPES.glob("*.json")):
    r = json.loads(p.read_text(encoding="utf-8"))
    code = r["code"] if isinstance(r["code"], dict) else json.loads(r["code"])
    walk(code.get("block") or [code], p.stem)

if hits:
    for recipe, loc, field in hits:
        print(f"HIT  {recipe}  {loc}  [{field}]")
else:
    print("No literal occurrences of '_mapping' in the corpus.")
