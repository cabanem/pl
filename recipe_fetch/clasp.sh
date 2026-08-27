#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Rebuild clasp project directories from scratch.
#
# For each pair below: delete the directory, recreate it,
# and run `clasp clone <script_id>` inside it.
#
# Format: dir_name, script_id   (one per line; trailing ';' ok,
# blank lines and lines starting with # are ignored)
# ─────────────────────────────────────────────────────────────
PAIRS="
# my-first-project, 1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890
# another-project,  1ZyXwVuTsRqPoNmLkJiHgFeDcBa0987654321
"

command -v clasp >/dev/null 2>&1 || {
  echo "ERROR: clasp not found in PATH" >&2
  exit 1
}

BASE_DIR="$(pwd)"          # everything is relative to where you run this
declare -A seen            # dedupe: only process each directory once
failures=()

while IFS=',' read -r dir script_id; do
  # trim whitespace and stray semicolons from both fields
  dir="$(echo "${dir:-}" | tr -d ';' | xargs)"
  script_id="$(echo "${script_id:-}" | tr -d ';' | xargs)"

  # skip blank lines and comments
  [[ -z "$dir" || "$dir" == \#* ]] && continue

  if [[ -z "$script_id" ]]; then
    echo "!! Skipping '$dir' — no script ID on that line" >&2
    continue
  fi

  # only clone each distinct directory once
  if [[ -n "${seen[$dir]:-}" ]]; then
    echo "-- Skipping duplicate entry for '$dir'"
    continue
  fi
  seen[$dir]=1

  # safety: refuse absolute paths or anything with '..'
  if [[ "$dir" == /* || "$dir" == *..* ]]; then
    echo "!! Skipping suspicious path '$dir'" >&2
    continue
  fi

  echo "== Rebuilding $dir =="
  rm -rf -- "${BASE_DIR:?}/${dir:?}"
  mkdir -p -- "$BASE_DIR/$dir"

  if ! ( cd "$BASE_DIR/$dir" && clasp clone "$script_id" ); then
    echo "!! clasp clone failed for '$dir'" >&2
    failures+=("$dir")
  fi
done <<< "$PAIRS"

echo
if (( ${#failures[@]} )); then
  echo "Finished with failures: ${failures[*]}" >&2
  exit 1
fi
echo "All directories rebuilt successfully."
