#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Zip many directories, driven by a manifest file.
#
# Usage:
#   zip_many.sh <manifest_file>
#
# Manifest format — one job per line, pipe-separated:
#
#   input_dir | extensions | output_zip
#
#   /c/projects/src      | js,gs   | /c/backups/src.zip
#   /c/projects/scripts  | sh      | /c/backups/scripts.zip
#   # comments and blank lines are ignored
#
# Fields are pipe-separated (not comma) because the extensions
# field already uses commas internally.
# ─────────────────────────────────────────────────────────────

# find zip_by_type.sh sitting next to this script, regardless of
# what the current working directory is when we're invoked
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIP_ONE="$SCRIPT_DIR/zip_by_type.sh"

manifest="${1:?Usage: $(basename "$0") <manifest_file>}"

[[ -f "$manifest" ]] || {
  echo "ERROR: manifest '$manifest' not found" >&2
  exit 1
}

[[ -x "$ZIP_ONE" ]] || {
  echo "ERROR: $ZIP_ONE not found or not executable" >&2
  exit 1
}

failures=()
lineno=0

# the `|| [[ -n "$dir" ]]` clause makes the loop still process a
# final line that has no trailing newline
while IFS='|' read -r dir exts out || [[ -n "${dir:-}" ]]; do
  ((++lineno))

  # trim whitespace around each field
  dir="$(echo "${dir:-}" | xargs)"
  exts="$(echo "${exts:-}" | xargs)"
  out="$(echo "${out:-}" | xargs)"

  # skip blanks and comments
  [[ -z "$dir" || "$dir" == \#* ]] && continue

  if [[ -z "$exts" || -z "$out" ]]; then
    echo "!! Line $lineno malformed (need: dir | exts | out.zip) — skipping" >&2
    failures+=("line $lineno")
    continue
  fi

  echo "== Zipping $dir  ->  $out =="
  if ! "$ZIP_ONE" "$dir" "$exts" "$out"; then
    failures+=("$dir")
  fi
done < "$manifest"

echo
if (( ${#failures[@]} )); then
  echo "Completed with failures: ${failures[*]}" >&2
  exit 1
fi
echo "All archives created successfully."
