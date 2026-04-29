# Supplier Reminder System — Implementation Guide

**Platform:** SDC on Workato  
**Prerequisite:** Fix CRIT-1 (B-02 step 11 `project_storage_path` nil) before starting — reminders depend on a valid storage path.

---

## Phase 1: Data Model Changes

### Step 1 — Add reminder fields to WFA_TemplateProject

Add two columns to support the full reminder cadence from `1_customer`:

| Field | Type | Optional | Hint |
|-------|------|----------|------|
| `reminder_days_2` | integer | true | Days before second reminder. Null = disabled. |
| `reminder_days_3` | integer | true | Days before third reminder. Null = disabled. |

`reminder_days_1` already exists in the manifest and on the table.

### Step 2 — Add reminder state fields to WFA_SupplierRequest

Add two columns to track where each supplier is in the reminder sequence:

| Field | Type | Optional | Default | Hint |
|-------|------|----------|---------|------|
| `last_reminder_tier` | integer | true | 0 | 0 = no reminder sent. 1/2/3 = tier of last reminder. |
| `last_reminder_sent_at` | date_time | true | null | Timestamp of the most recent reminder. |

### Step 3 — Update the manifest

Add the new fields to the `WFA_TemplateProject` and `WFA_SupplierRequest` schemas in the data table manifest. Bump the version.

---

## Phase 2: Config Hydration

### Step 4 — Verify `parse_config_file` extracts reminder values

The `1_customer` sheet already has three reminder cadence rows:

- "How many days before we send the first [reminder]" → `reminder_days_1`
- "When should we send the second reminder?" → `reminder_days_2`
- "When should we send a third reminder?" → `reminder_days_3`

Confirm the connector's `parse_config_file` action includes these in its output. If not, update the connector action to extract them from the customer section of the parsed config.

### Step 5 — Persist reminder values in P-01

In P-01, after the config is parsed and the WFA_TemplateProject record is updated (around the config hydration steps), ensure `reminder_days_1`, `reminder_days_2`, and `reminder_days_3` are written to WFA_TemplateProject.

If P-01 already writes `reminder_days_1` via a batch update whose UUID mapping the parser couldn't resolve, add the two new fields to the same step. If it doesn't write any of them yet, add all three to the `update_record` call that hydrates WFA_TemplateProject after parsing.

---

## Phase 3: Build the Reminder Recipe (R-07)

### Step 6 — Create the recipe shell

Create a new recipe: **R-07: Send supplier reminders**

- **Trigger:** Workato scheduled trigger (daily, e.g., 08:00 UTC)
- **Concurrency:** 1
- **Tags:** RUN

No input parameters — this recipe self-discovers eligible work.

### Step 7 — Query active projects with reminders configured

**Step 1 in recipe:** `get_records` → WFA_TemplateProject

- Filter: `project_completion_status` = `active`
- Filter: `reminder_days_1` is present (not blank)

This returns all projects that have at least one reminder tier configured.

### Step 8 — For each project, find eligible suppliers

**Step 2:** `For each` loop over the project records from step 1.

**Step 3 (inside loop):** `get_records` → WFA_SupplierRequest

- Filter: `template_project_id` = current project's `template_project_id`
- Filter: `status_StateMachine` in (`sent`, `supplier_action_required`)

This returns suppliers who haven't completed their submission.

### Step 9 — Evaluate reminder eligibility

**Step 4:** `py_eval` — Determine which suppliers are due for a reminder.

Input: the supplier request records from step 3, plus `reminder_days_1`, `reminder_days_2`, `reminder_days_3` from the current project, plus today's date.

```python
def main(input):
    from datetime import datetime, timedelta

    today = datetime.utcnow().date()
    tiers = []
    for key in ['reminder_days_1', 'reminder_days_2', 'reminder_days_3']:
        val = input.get(key)
        if val:
            tiers.append(int(val))

    eligible = []
    for supplier in input.get('suppliers', []):
        current_tier = int(supplier.get('last_reminder_tier') or 0)
        # Determine reference date: last reminder, or last status change
        ref_date_str = supplier.get('last_reminder_sent_at') or supplier.get('last_updated_at')
        if not ref_date_str:
            continue
        ref_date = datetime.fromisoformat(ref_date_str.replace('Z', '+00:00')).date()
        
        # Check if the next tier is due
        next_tier = current_tier + 1
        if next_tier > len(tiers):
            continue  # All configured tiers exhausted
        
        days_threshold = tiers[next_tier - 1]
        if (today - ref_date).days >= days_threshold:
            eligible.append({
                'supplier_request_id': supplier.get('supplier_request_id'),
                'supplier_name': supplier.get('supplier_name'),
                'primary_user_email': supplier.get('primary_user_email'),
                'template_project_id': supplier.get('template_project_id'),
                'assigned_variant_id': supplier.get('assigned_variant_id'),
                'next_tier': next_tier,
                'days_elapsed': (today - ref_date).days,
            })

    return {
        'eligible': eligible,
        'eligible_count': len(eligible),
    }
```

Output schema: `eligible` (array of objects), `eligible_count` (integer).

### Step 10 — Skip if no eligible suppliers

**Step 5:** `If` condition — `eligible_count` > 0. Wrap the remaining steps inside this block.

### Step 11 — Refresh template links and send reminders

**Step 6:** `For each` over the `eligible` array.

Inside the loop, for each supplier:

**Step 7 — Resolve the template file.** This follows the three-tier resolution from P-03: `seeded_template_file_id` → variant `template_file_id` → master `template_file_id`. You'll need to read the supplier request record (or carry the fields from step 3) to determine which file to refresh.

If the supplier has a `seeded_template_file_id`, use that. Otherwise, look up `CFG_Variant.template_file_id` by `assigned_variant_id` (if set), or fall back to `VER_TemplateVersion.master_template_file_id`.

**Step 8 — Regenerate the shareable link.** Use the Workato FileStorage `get_file_link` action (or equivalent) on the resolved file ID. This produces a fresh shareable URL with a new 10-day TTL.

**Step 9 — Update WFA_SupplierRequest.** `update_record`:

| Field | Value |
|-------|-------|
| `template_file_id` | New shareable link from step 8 |
| `last_reminder_tier` | `next_tier` from the py_eval output |
| `last_reminder_sent_at` | `now()` |
| `last_updated_at` | `now()` |

**Step 10 — Send the reminder notification.** Use Workato's email connector (or SendGrid/SMTP):

- **To:** `primary_user_email`
- **Subject:** Config-driven (could add a `reminder_email_subject` field to WFA_TemplateProject, or hardcode for v1)
- **Body:** Include the supplier name, customer name, and the refreshed template download link

### Step 12 — Add error handling

Wrap the for-each loop in a try/catch block. On catch, log the error with the supplier_request_id and continue to the next supplier (don't let one failure stop all reminders).

### Step 13 — Add job report columns

Add custom job report columns for observability:

| Column | Value |
|--------|-------|
| Project count | Number of active projects evaluated |
| Eligible suppliers | Total eligible count across all projects |
| Reminders sent | Count of successful sends |
| Errors | Count of failures |

---

## Phase 4: Testing

### Step 14 — Unit test the py_eval

Test the eligibility logic with edge cases:

- Supplier with `last_reminder_tier` = 0 and `last_updated_at` = 2 days ago, `reminder_days_1` = 1 → eligible (tier 1)
- Supplier with `last_reminder_tier` = 1 and `last_reminder_sent_at` = 1 day ago, `reminder_days_2` = 3 → not eligible yet
- Supplier with `last_reminder_tier` = 2 and `reminder_days_3` = null → all tiers exhausted, skip
- Supplier with `status_StateMachine` = `validated` → should not appear in step 3 query (filtered out)

### Step 15 — Integration test

1. Create a test project with `reminder_days_1` = 0 (immediate trigger) via the config file
2. Add a test supplier with `status_StateMachine` = `sent` and `last_updated_at` in the past
3. Run R-07 manually
4. Verify: `template_file_id` refreshed, `last_reminder_tier` = 1, `last_reminder_sent_at` = now, email received

### Step 16 — Validate FileStorage TTL behavior

Confirm that the regenerated shareable link works by:

1. Generating a link via R-07
2. Accessing it immediately (should work)
3. Waiting 10+ days and accessing the old link (should fail)
4. Running R-07 again to generate tier 2 link (should work)

---

## Summary of Changes

| Layer | What | Where |
|-------|------|-------|
| Data model | Add `reminder_days_2`, `reminder_days_3` | WFA_TemplateProject |
| Data model | Add `last_reminder_tier`, `last_reminder_sent_at` | WFA_SupplierRequest |
| Manifest | Add 4 new fields, bump version | data_table_manifest.json |
| Config parsing | Ensure 3 reminder values extracted | SDC Platform Connector / P-01 |
| Config hydration | Persist 3 reminder values | P-01 (update_record on WFA_TemplateProject) |
| New recipe | R-07: daily scheduled reminder | New recipe |
| Email | Reminder notification | R-07 (email connector) |
