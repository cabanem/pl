#!/usr/bin/env python3
"""
fix_mojibake.py — find and repair UTF-8-read-as-Windows-1252 mojibake
in the Apps Script source (.js / .gs).

  Dry run (default) — report what WOULD change, and flag any non-ASCII
  the script doesn't recognize so nothing slips through:

      python3 fix_mojibake.py

  Apply the fixes in place:

      python3 fix_mojibake.py --apply

  Keep a .bak beside each changed file:

      python3 fix_mojibake.py --apply --backup

Run it from the repo root. Commit first (or use --backup) so it's reversible.
"""

import argparse
import pathlib
import sys

# Each KEY is the corrupted sequence exactly as it appears when the file is read
# as UTF-8; each VALUE is the character it should have been. Keys use explicit
# code points so there's no ambiguity about which bytes are being matched.
FIXES = {
    "\u00e2\u20ac\u201d": "\u2014",   # em dash              ->  —   (UTF-8 E2 80 94)
    "\u00e2\u20ac\u201c": "\u2013",   # en dash              ->  –   (E2 80 93)
    "\u00e2\u20ac\u00a6": "\u2026",   # ellipsis             ->  …   (E2 80 A6)
    "\u00e2\u20ac\u2122": "\u2019",   # right single quote   ->  '   (E2 80 99)
    "\u00e2\u20ac\u0153": "\u201c",   # left double quote    ->  "   (E2 80 9C)
    "\u00e2\u20ac\u009d": "\u201d",   # right double quote   ->  "   (E2 80 9D)
    "\u00e2\u2020\u2019": "\u2192",   # right arrow          ->  →   (E2 86 92)
    # Emoji: restored to the real glyph. If your pipeline keeps re-mangling
    # UTF-8, swap these two values for ASCII (e.g. "[OK]" / "[X]") for durability.
    "\u00e2\u0153\u2026": "\u2705",   # check mark           ->  ✅  (E2 9C 85)
    "\u00e2\u009d\u0152": "\u274c",   # cross mark           ->  ❌  (E2 9D 8C)
}

EXTS = {".js", ".gs"}


def repair(text):
    """Return (fixed_text, num_replacements)."""
    n = 0
    for bad, good in FIXES.items():
        c = text.count(bad)
        if c:
            text = text.replace(bad, good)
            n += c
    return text, n


def residual_nonascii(text):
    """Non-ASCII characters left after the known fixes (unmapped mojibake, etc.)."""
    return sorted({ch for ch in text if ord(ch) > 127})


def main():
    ap = argparse.ArgumentParser(description="Repair UTF-8-as-cp1252 mojibake.")
    ap.add_argument("--apply", action="store_true", help="write fixes in place")
    ap.add_argument("--backup", action="store_true", help="write a .bak beside each changed file")
    ap.add_argument("root", nargs="?", default=".", help="directory to scan (default: .)")
    args = ap.parse_args()

    total_fixed = 0
    changed_files = 0

    for path in sorted(pathlib.Path(args.root).rglob("*")):
        if path.suffix not in EXTS or not path.is_file():
            continue

        original = path.read_text(encoding="utf-8")
        fixed, n = repair(original)
        leftover = residual_nonascii(fixed)  # what's still non-ASCII after fixes

        if n or leftover:
            print(path)
            if n:
                print(f"    {n} mojibake sequence(s) fixable")
            if leftover:
                shown = "  ".join(f"U+{ord(c):04X} '{c}'" for c in leftover)
                print(f"    !! unmapped non-ASCII remains: {shown}")

        if n:
            total_fixed += n
            changed_files += 1
            if args.apply:
                if args.backup:
                    path.with_suffix(path.suffix + ".bak").write_text(original, encoding="utf-8")
                path.write_text(fixed, encoding="utf-8")

    mode = "applied" if args.apply else "dry run"
    print(f"\n{mode}: {total_fixed} replacement(s) across {changed_files} file(s).")
    if total_fixed and not args.apply:
        print("Re-run with --apply to write the changes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
