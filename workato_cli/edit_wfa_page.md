# WFA Page Edit Runbook — RLCM Package Round-Trip

**Objective:** Edit a Workflow Apps page (and, when wiring changes, its paired recipe) as JSON — no page-builder edits.

**How resumability works:** Your working directory *is* the state machine. Every stage ends by leaving a numbered artifact on disk. If you get pulled away, `ls` the directory when you come back: the highest-numbered artifact tells you which stage completed last. Pick up at the next one. The resume table at the bottom maps artifacts → next action.

**Rollback guarantee:** `02_package.zip` (the pristine export) is never modified. Rolling back = importing it unchanged via Stage 6.

---

## Stage 0 — Setup (one-time per edit session)

Create the working directory and record credentials/targets. You need an API client token (Workspace admin → API clients) with the **Recipe lifecycle management** scope, and the **folder ID** of the SDC project (visible in the workspace URL when the project is open).

```bash
mkdir page-edit-$(date +%Y%m%d)-<slug> && cd page-edit-$(date +%Y%m%d)-<slug>

cat > env.sh << 'EOF'
export W_BASE="https://www.workato.com"     # EU data center: https://app.eu.workato.com
export W_TOKEN="<paste API client token>"
export W_FOLDER_ID="<SDC project folder id>"
EOF
source env.sh
```

Do not commit `env.sh` anywhere. Every later stage assumes `source env.sh` has been run in the current shell — after any interruption, re-source it first.

**✓ Checkpoint:** `env.sh` exists; `echo $W_FOLDER_ID` prints the id.

---

## Stage 1 — Enumerate assets, choose what travels

```bash
curl -s "$W_BASE/api/export_manifests/folder_assets?folder_id=$W_FOLDER_ID" \
  -H "Authorization: Bearer $W_TOKEN" > 01_assets.json

python -c "import json; [print(a['type'].ljust(14), str(a['id']).ljust(8), a['name']) \
  for a in json.load(open('01_assets.json'))['result']['assets']]"
```

Identify the page (`type: page`) you're editing.

**Co-versioning rule:** if the edit touches an app-function call (adding/removing parameters, changing bindings — e.g., the `sel_slot_*` wiring), the page and the recipe are two halves of one contract and must travel **in the same package**. Note both. A page-only cosmetic edit can travel alone.

**✓ Checkpoint:** `01_assets.json` exists; you've noted the asset names involved.

---

## Stage 2 — Export and download the package

```bash
# 2a. Create a manifest covering the folder (auto-selects assets + dependencies)
curl -s -X POST "$W_BASE/api/export_manifests" \
  -H "Authorization: Bearer $W_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"export_manifest\": {\"name\": \"page-edit $(date +%F)\", \"folder_id\": $W_FOLDER_ID, \"auto_generate_assets\": true}}" \
  > 02a_manifest.json
export MANIFEST_ID=$(python -c "import json; print(json.load(open('02a_manifest.json'))['result']['id'])")

# 2b. Run the export
curl -s -X POST "$W_BASE/api/packages/export/$MANIFEST_ID" \
  -H "Authorization: Bearer $W_TOKEN" > 02b_export_job.json
export PKG_ID=$(python -c "import json; d=json.load(open('02b_export_job.json')); print(d.get('id') or d['result']['id'])")

# 2c. Poll until status = completed, then grab download_url
curl -s "$W_BASE/api/packages/$PKG_ID" -H "Authorization: Bearer $W_TOKEN" > 02c_status.json
python -c "import json; d=json.load(open('02c_status.json')); print(d['status'], d.get('download_url'))"

# 2d. Download (repeat 2c until completed first)
curl -sL "<download_url from 2c>" -o 02_package.zip
```

**UI alternative** (equally valid): Tools → Recipe lifecycle management → Export → build the manifest → download. Save the file as `02_package.zip` in this directory so the state machine stays intact.

**⚠ `02_package.zip` is the rollback artifact. Treat it as read-only from this moment.**

**✓ Checkpoint:** `02_package.zip` exists and `python -c "import zipfile; print(len(zipfile.ZipFile('02_package.zip').namelist()), 'files')"` succeeds.

---## Stage 3 — Extract and locate the target files

```bash
python << 'EOF'
import zipfile, os
zipfile.ZipFile('02_package.zip').extractall('03_work')
for root, _, files in os.walk('03_work'):
    for f in sorted(files):
        print(os.path.join(root, f))
EOF
```

Page files carry a `.page.json`-style suffix (list output confirms the exact pattern, same convention as `*.recipe.json` / `*.workato_db_table.json`). Confirm you can see **both** the page file and, if co-versioning, the recipe file.

Optional but recommended — makes Stage 4 self-documenting and diffable:

```bash
cd 03_work && git init -q && git add -A && git commit -qm "pristine export" && cd ..
```

**✓ Checkpoint:** `03_work/` exists; target file paths noted (write them in a `notes.md` if you're about to context-switch).

---

## Stage 4 — Edit the JSON

Editing discipline — the three rules that keep an import healthy:

1. **Never regenerate existing IDs.** Component IDs, UUIDs, and line IDs are how everything cross-references. Edit values in place; when adding a new element, copy an adjacent sibling and give only the *new* element a fresh UUID.
2. **Change both halves of a contract together.** New/renamed function parameters → the recipe trigger schema *and* the page's call bindings, in this same package. An import with one half updated succeeds silently and breaks at runtime.
3. **Validate every file you touched:**

```bash
python -m json.tool 03_work/<path/to/file>.page.json > /dev/null && echo VALID
```

If you initialized git in Stage 3: `cd 03_work && git diff` should show *exactly* the intended edits and nothing else. Commit when done: `git commit -am "describe the edit"`.

**✓ Checkpoint:** all touched files print `VALID`; diff (or `notes.md`) records what changed.

---

## Stage 5 — Repack

```bash
python << 'EOF'
import zipfile, os
src, out = '03_work', '05_repack.zip'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(src):
        if '.git' in root.split(os.sep):
            continue
        for f in files:
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, src))
print('wrote', out)

# sanity: file list must match the original exactly
orig = set(zipfile.ZipFile('02_package.zip').namelist())
new  = set(zipfile.ZipFile(out).namelist())
print('missing from repack:', orig - new or 'none')
print('unexpected extras:  ', new - orig or 'none')
EOF
```

The #1 import failure is archive paths gaining an extra top-level folder (zipping the directory instead of its contents). The script above writes paths relative to the extraction root, so the internal structure matches the original — the sanity check proves it.

**✓ Checkpoint:** `05_repack.zip` exists; both sanity lines print `none` (or only intentional additions).

---

## Stage 6 — Import

Preconditions: the destination **project name must match** the project name in the package (a Workflow-app-specific constraint), the target folder must already exist, and the package must be under 100 MB.

```bash
curl -s -X POST "$W_BASE/api/packages/import/$W_FOLDER_ID?restart_recipes=true" \
  -H "Authorization: Bearer $W_TOKEN" -H 'Content-Type: application/octet-stream' \
  --data-binary @05_repack.zip > 06_import_job.json

export IMPORT_ID=$(python -c "import json; d=json.load(open('06_import_job.json')); print(d.get('id') or d['result']['id'])")

# Poll until completed, then inspect per-recipe results — "completed" alone is not success
curl -s "$W_BASE/api/packages/$IMPORT_ID" -H "Authorization: Bearer $W_TOKEN" > 06_import_result.json
python -m json.tool 06_import_result.json
```

Check `status: completed` **and** each entry's `import_result` in the recipe status list.

**UI alternative:** RLCM → Import tab → drop `05_repack.zip` → review the preview tags (`Overwrites recipe`, `Overwrites running recipe`, `No change`) → import. For a riskier edit the preview screen is a worthwhile extra gate — anything tagged as changing that you *didn't* edit is a stop signal.

**✓ Checkpoint:** `06_import_result.json` shows completed + clean per-recipe results.

---

## Stage 7 — Verify (and rollback if needed)

Open the app page in preview and exercise the paths the edit touched. For dependent-dropdown wiring, the minimum set:

- initial page load (dependent dropdown should sit in awaiting-parent state, not show the full union)
- select the parent → child options filter correctly
- change a *non-parent* slot that triggers a refresh → child options survive (the original edge case)
- job history of the dropdown recipe: `parent_source` should read `page_snapshot`, not `prior_slot`/`unresolved`

**Rollback:** run Stage 6 again with `02_package.zip` in place of `05_repack.zip`. Nothing else required.

---

## Resume table

| Highest artifact present | State | Do next |
|---|---|---|
| `env.sh` only | setup done | `source env.sh` → Stage 1 |
| `01_assets.json` | assets chosen | `source env.sh` → Stage 2 |
| `02_package.zip` | pristine export in hand | Stage 3 |
| `03_work/` | extracted | Stage 4 (check `git status` / `notes.md` for partial edits) |
| edits VALID + committed | edit done | Stage 5 |
| `05_repack.zip` | repacked | `source env.sh` → Stage 6 |
| `06_import_result.json` | imported | Stage 7 verification |

One directory per edit session; never reuse a directory for a second round of edits — export fresh (the workspace may have moved underneath you, and a stale `03_work/` would silently revert someone's changes on import).
