#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Zip files of the given type(s) from a directory — bsdtar edition.
#
# Uses Windows' built-in bsdtar (System32), which can write real
# .zip files via its -a flag. No `zip` install required.
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
#   ./zip_by_type.sh /c/projects/src js,gs /c/backups/src.zip
# ─────────────────────────────────────────────────────────────

# pinned to Windows' bsdtar; override per-run with TAR=... if needed
TAR="${TAR:-/c/Windows/System32/tar.exe}"

usage() {
  sed -n '4,19p' "$0"
  exit 1
}

[[ $# -eq 3 ]] || usage

input_dir="$1"
ext_list="$2"
output_zip="$3"

[[ -x "$TAR" ]] || {
  echo "ERROR: tar not found at '$TAR' (set TAR=/path/to/tar.exe to override)" >&2
  exit 1
}

# zip output via -a requires bsdtar; GNU tar's -a means something else
"$TAR" --version 2>/dev/null | grep -qi bsdtar || {
  echo "ERROR: '$TAR' is not bsdtar — zip output needs bsdtar's -a flag" >&2
  exit 1
}

[[ -d "$input_dir" ]] || {
  echo "ERROR: input directory '$input_dir' not found" >&2
  exit 1
}

# ensure the output name ends in .zip (this is also how bsdtar's
# -a flag knows to write zip format)
[[ "$output_zip" == *.zip ]] || output_zip="${output_zip}.zip"

# create the output directory if needed, then make the path absolute
# (we cd into input_dir later, so a relative path would break)
out_dir="$(dirname -- "$output_zip")"
mkdir -p -- "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"
output_zip="$out_dir/$(basename -- "$output_zip")"

# build `find` name filters from the comma-separated extension list:
# each extension contributes "-o -name *.ext"; we slice off the
# leading -o when we use the array
name_filters=()
IFS=',' read -ra exts <<< "$ext_list"
for ext in "${exts[@]}"; do
  ext="$(echo "$ext" | xargs)"   # trim whitespace
  ext="${ext#.}"                 # accept ".js" or "js"
  [[ -n "$ext" ]] && name_filters+=(-o -name "*.${ext}")
done

(( ${#name_filters[@]} )) || {
  echo "ERROR: no valid extensions found in '$ext_list'" >&2
  exit 1
}

# run from inside input_dir so paths in the archive are relative to it
cd "$input_dir"

# cheap probe: is there at least one matching file? (-quit stops
# find at the first hit, so this costs almost nothing)
if [[ -z "$(find . -type f \( "${name_filters[@]:1}" \) -print -quit)" ]]; then
  echo "No files matching ($ext_list) in '$input_dir'. No zip created." >&2
  exit 1
fi

# find selects the files (null-delimited, so spaces in names are
# safe); bsdtar reads the list from stdin and writes a real .zip
find . -type f \( "${name_filters[@]:1}" \) -print0 \
  | "$TAR" --null -T - -a -cf "$output_zip"

echo "Created: $output_zip"
