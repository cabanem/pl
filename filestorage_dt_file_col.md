# File Column Variant — Change Guide

## Purpose

This document maps the changes required if `seeded_template_file_id` on `WFA_SupplierRequest` is implemented as a **File column** instead of a **Short text column** holding a FileStorage path. The main build guide (P-02b) remains the canonical reference; apply these deltas on top of it.

---

## Data Model Change

### WFA_SupplierRequest

| Field | Current type | New type |
|---|---|---|
| `seeded_template_file_id` (`b3f69785_1e5e_4c19_b870_9d4e7658dbb7`) | Short text | **File** |

No other table changes required. `template_file_id` and all other `*_file_id` fields remain Short text (FileStorage paths).

---

## P-02b Changes

### Steps affected: 17 and 18 collapse into one

**Build guide (current — text field approach):**

```
Step 17: [action] FileStorage — Store file
         Path: {workato_file_storage_path}/seeded/{supplier_request_id}.xlsx
         Content: merged_b64 (decoded)
Step 18: [action] Data Tables — Update record (WFA_SupplierRequest)
         Record ID: current foreach item Record ID
         Fields:
           seeded_template_file_id = Step 17 output path
```

**File column approach — replace with a single step:**

```
Step 17: [action] Data Tables — Update record (WFA_SupplierRequest)
         Record ID: current foreach item Record ID
         Fields:
           seeded_template_file_id (File column):
             file_content = decoded bytes from py_eval merged_b64
             file_name    = "Seeded_{supplier_name}_{supplier_request_id}.xlsx"
```

**What changes:**
- FileStorage store step is removed entirely — the file goes directly into the Data Table.
- The variable `seeded_count` increment (Step 19) becomes Step 18.
- The else branch (Step 20–21) becomes Step 19–20.
- Return step becomes Step 21.

**Step renumbering summary:**

| Build guide step | File column step | Action |
|---|---|---|
| 17 | *removed* | FileStorage store — no longer needed |
| 18 | 17 | Update record (now includes file upload) |
| 19 | 18 | Update seeded_count |
| 20–21 | 19–20 | Else branch |
| 22 | 21 | Return result |

---

## P-03 Changes

### Current logic (from build guide):

```
Step 6:  [if] seeded_template_file_id is present
  Step 6a: → Set current_template_file_id = seeded_template_file_id
```

This works when `seeded_template_file_id` is a text field containing a FileStorage path. Step 11 (`Create shareable link`) accepts that path directly.

### File column approach — expand Step 6 block:

```
Step 6:  [if] seeded_template_file_id is present (File column is not null)

  Step 6a: [action] FileStorage — Store file
           Content: current foreach item → seeded_template_file_id.file_content
           File name: current foreach item → seeded_template_file_id.file_name
           Path: {ENV_FILE_STORAGE_ROOT_ID}
           Note: This bridges the File column content into FileStorage
                 so Step 11 can generate a shareable link.

  Step 6b: [action] Variable — Update current_template_file_id
           Value: Step 6a → output path (FileStorage path)

Step 6c: [elsif] assigned_variant_id is present        ← unchanged
  Step 7:  → Get CFG_Variant → variant template_file_id
  Step 8:  → Set current_template_file_id = variant template

Step 9:  [else]                                         ← unchanged
  Step 10: → Set current_template_file_id = master template

Step 11: Create shareable link from current_template_file_id  ← unchanged
```

**What this means:** Every seeded supplier incurs one FileStorage write during onboarding. The shareable link mechanism (Step 11) remains untouched — it always receives a FileStorage path regardless of the source.

### File naming convention for the bridge

Use a deterministic path so the file is traceable in FileStorage:

```
{ENV_FILE_STORAGE_ROOT_ID}/seeded/{supplier_request_id}.xlsx
```

This mirrors what P-02b would have done in the text-field approach, just deferred to P-03.

---

## Workflow 7 (Future Reminder Flow) Impact

Workflow 7 regenerates shareable links for non-responsive suppliers. With the text-field approach, the FileStorage path is already on the record — just call `Create shareable link` with it.

With the File column approach, Workflow 7 has two options:

**Option A — Re-bridge every reminder cycle:**

```
1. Read seeded_template_file_id.file_content from WFA_SupplierRequest
2. Store in FileStorage (same deterministic path)
3. Create shareable link from that path
```

The FileStorage store uses `overwrite: true` since the file content hasn't changed — it's just refreshing the shareable link.

**Option B — Cache the FileStorage path:**

Add a separate text field (e.g., `seeded_template_fs_path`) that P-03 Step 6a writes after bridging. Workflow 7 then reads this cached path directly, skipping the bridge. This is essentially the text-field approach running in parallel with the File column.

**Recommendation:** Option B is cleaner for Workflow 7 but adds a field. Option A is simpler if reminder frequency is low (the extra FileStorage write is cheap).

---

## Recipes with No Changes

| Recipe | Why unaffected |
|---|---|
| P-01 | Calls P-02b and P-03 — no direct file handling |
| P-02 | Builds blank templates — unrelated to seeding |
| WFA-01 through WFA-04 | Supplier-facing workflows — don't touch seeded templates |
| V-01, V-02 | Validation pipeline — operates on supplier uploads, not seeded templates |

---

## Summary

| Area | Text field (build guide) | File column (this guide) |
|---|---|---|
| P-02b step count | 22 steps | 21 steps (one fewer) |
| P-03 step count in seeded branch | 1 step (set variable) | 2 steps (bridge + set variable) |
| Workflow 7 complexity | Direct path reference | Bridge or cache field |
| New fields needed | None | None (Option A) or 1 (Option B) |
| Operational benefit | — | File preview in Data Tables UI |
| Pattern alignment | Matches `template_file_id`, `master_template_file_id` | Matches `upload_from_ui` |
