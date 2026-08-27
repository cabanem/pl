#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Zip files of the given type(s) from a directory.
#
# Usage:
#   zip_by_type.sh <input_dir> <extensions> <output_zip>
#
#   input_dir    directory to pull files from (searched recursively)
#   extensions   comma-separated, dot optional: "js" or "js,sh,html"
#   output_zip   where to write the zip; parent dirs created as
#                needed, ".zip" appended if missing
#
# Example:
#   ./zip_by_type.sh ./my-project js,gs /tmp/backups/project-src.zip
# ─────────────────────────────────────────────────────────────

usage() {
  sed -n '4,16p' "$0"   # print the header comment above
  exit 1
}

[[ $# -eq 3 ]] || usage

input_dir="$1"
ext_list="$2"
output_zip="$3"

command -v zip >/dev/null 2>&1 || {
  echo "ERROR: zip is not installed (try: apt install zip)" >&2
  exit 1
}

[[ -d "$input_dir" ]] || {
  echo "ERROR: input directory '$input_dir' not found" >&2
  exit 1
}

# ensure the output name ends in .zip
[[ "$output_zip" == *.zip ]] || output_zip="${output_zip}.zip"

# create the output directory if needed, then make the path absolute
# (we cd into input_dir later, so a relative path would break)
out_dir="$(dirname -- "$output_zip")"
mkdir -p -- "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"
output_zip="$out_dir/$(basename -- "$output_zip")"

# build zip include patterns from the comma-separated extension list
patterns=()
IFS=',' read -ra exts <<< "$ext_list"
for ext in "${exts[@]}"; do
  ext="$(echo "$ext" | xargs)"   # trim whitespace
  ext="${ext#.}"                 # accept ".js" or "js"
  [[ -n "$ext" ]] && patterns+=("*.${ext}")
done

(( ${#patterns[@]} )) || {
  echo "ERROR: no valid extensions found in '$ext_list'" >&2
  exit 1
}

# zip *adds to* an existing archive by default; remove any old one
# so every run produces a fresh, deterministic result
rm -f -- "$output_zip"

# run from inside input_dir so paths in the archive are relative to it
cd "$input_dir"

set +e
zip -r "$output_zip" . -i "${patterns[@]}"
status=$?
set -e

if [[ $status -eq 12 ]]; then
  # zip's exit code 12 means "nothing to do" — no files matched
  echo "No files matching (${patterns[*]}) in '$input_dir'. No zip created." >&2
  exit 1
elif [[ $status -ne 0 ]]; then
  echo "ERROR: zip failed with exit code $status" >&2
  exit "$status"
fi

echo "Created: $output_zip"
