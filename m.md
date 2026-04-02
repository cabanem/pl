# Master Config v0.9.1 — Sheet Updates

These updates bring START_HERE and .user_guide into alignment with the current system architecture (system manifest v2.1, data table manifest v5.1, SDC Platform Connector).

---

## Changes Summary

### START_HERE

| What changed | Old | New |
|---|---|---|
| Tab reference | `3_field_matrix` | `4_fields` |
| Tab reference | `4_rule_matrix` | `4_complex_validations` |
| Tab reference | `5_lookup_tables` | `5_lookups` |
| Missing tab | — | `3_users` (supplier portal users) |
| Missing tab | — | `6_variants` (field visibility per variant) |
| Workflow step | (not present) | Initialize workspace before generating template |
| Workflow step | Template generation fires webhook | Template generation fires webhook + registers version |
| Overview bullet | "Automate outreach" only | Updated to reflect workspace provisioning and portal access |

### .user_guide

| What changed | Old | New |
|---|---|---|
| Section 2 header | `3_field_matrix` | `4_fields` |
| Section 3 header | `4_rule_matrix` | `4_complex_validations` |
| Missing section | — | Section on `3_users` and supplier portal user model |
| Missing section | — | Section on `6_variants` and field visibility matrix |
| Rule reference table | 7 rule types | 11 rule types (added `step_increment`, `restricted_values`, `domain_restriction`, `date_compare`) |
| Implementation workflow | 4 steps | 5 steps (workspace init added before template gen) |
| Best practices table | 4 rows | 6 rows (added `Variants` and `Portal users` rows) |

---

## Updated START_HERE Content

> Cell positions are approximate — layout preserved from the existing sheet structure.

### Title (B2)
Supplier Data Collection — Configuration Workbook

### Intro paragraph (C4)
This workbook is your Mission Control for automating supplier data collection. It replaces manual Excel template creation and disjointed email chains, allowing you to define validation rules, generate client-specific templates, provision Workato workspaces, and manage supplier outreach — all from a single spreadsheet.

### Overview section (C6–G10)

**Overview** (C6)

This tool allows you to: (C7)

| Feature | Description |
|---|---|
| Define project rules | Specify exact data formats, required fields, cross-field validations, and dropdown options for your client. |
| Generate templates | Automatically generate strictly validated Excel files ready for supplier data collection. |
| Manage supplier users | Define which users at each supplier organization will access the portal to submit data. |
| Configure variants | Control which fields are visible to which supplier groups when templates differ across the engagement. |
| Provision workspaces | Initialize an isolated Workato workspace with all tables, rules, and lookups pre-configured from this workbook. |
| Automate outreach | Track which suppliers need to be contacted and sync them directly to the Workato integration platform. |

### Guides section (C12–G14)

**Guides** (C12)

| # | Guide | Location |
|---|---|---|
| 1. User guide | You will find a comprehensive user guide in the tab, `.user_guide` |
| 2. Mathematical notation | You will find a guide on relevant mathematical notation in the tab, `.math_notation` |
| 3. Regular expressions | Reference for regex-based field validation patterns in the tab, `.regex` |

### Your workspace section (C16–G22)

**Your workspace (the numbered tabs)** (C16)

| Tab | Description |
|---|---|
| `1_customer` | High-level implementation details. Define the client name, target VMS, Drive folder, variant count, and outreach cadence. This data is packaged with every template and supplier sync you trigger. |
| `2_suppliers` | Your operational roster. Add suppliers, indicate seed data relevance, and assign template variants. The tool tracks request status and logs edits automatically. |
| `3_users` | Supplier portal users. For each supplier, list the individual contacts who will receive portal access to upload data. Multiple users per supplier are supported. |
| `4_fields` | The blueprint for your Excel templates. Each row defines a column in the template — its data type, format, validations, lookup references, and cleaning rules. |
| `4_complex_validations` | Cross-field and advanced validation rules. Define relationships between two or more fields (e.g., "Bill rate must be greater than Employee pay rate") or single-field rules too complex for the field matrix. |
| `5_lookups` | The master list for all dropdown menus (e.g., US States, Country Codes, Job Classes). Group entries by table name and mark active rows with `1`. |
| `6_variants` | Field visibility matrix. When templates have multiple variants (set in `1_customer`), this tab controls which fields appear in each variant. Each column is a variant; each row is a field; `1` = visible, `0` = hidden. |

**NOTE** (E24): Please do not edit tabs starting with an underscore `_` or a period `.`, as these relate directly to the backend and reference documentation.

### Using the tool section (C26–G36)

**Using the tool** (C26)

#### Initialize the workspace (D28–E31)
| Step | Instruction |
|---|---|
| 1 | Complete all numbered tabs (`1_customer` through `6_variants`) with your client's configuration. |
| 2 | In the top toolbar, click **Supplier integration > Initialize workspace**. |
| 3 | The system will package your configuration, provision a Workato workspace, create all data tables, and hydrate them with your field definitions, rules, lookups, variants, suppliers, and users. A success message will confirm the assigned workspace and version. |

#### Generate and register a template (D33–E36)
| Step | Instruction |
|---|---|
| 1 | Ensure `4_fields` and `5_lookups` are configured, and the workspace has been initialized. |
| 2 | In the top toolbar, click **Supplier integration > Generate and export blank template**. |
| 3 | A temporary sheet will appear, format itself, and be exported as an Excel (.xlsx) file to Google Drive. The webhook fires to register the template version with Workato. |

#### Send outreach to new suppliers (D38–E41)
| Step | Instruction |
|---|---|
| 1 | Add new suppliers to `2_suppliers`. Ensure "Supplier name" is filled out. Add their users in `3_users` with email addresses. Leave "Request status" blank. |
| 2 | In the top toolbar, click **Supplier integration > Send supplier outreach**. |
| 3 | The system will find all suppliers with a blank status, sync them (and their users) to Workato, and update their status to "Sent". |

---

## Updated .user_guide Content

### 1. System overview and best practices (B4)

| Category | Principle | Description |
|---|---|---|
| Workspace | Numbered tabs | This is your safe zone. You will build client profiles, manage supplier rosters, define field/validation rules, configure variants, and list portal users in tabs `1` through `6`. |
| System | Underscore / dot tabs | Do not manually edit tabs prefixed with `_` or `.` unless instructed. They hold internal configurations, execution logs, reference guides, and dictionaries used by the backend code. |
| Automation | Cache delay | The script caches `_developer_settings` for speed. If you manually change a webhook URL or target folder, the change won't take effect for up to an hour unless you trigger a cache reset. |
| Syncing | Audit trail | When you edit `2_suppliers` or `3_users`, an automated trigger assigns a UUID, timestamp, and records your email. |
| Variants | Visibility matrix | If `1_customer` specifies more than 0 variants, configure `6_variants` to control which fields each supplier group sees. Unconfigured variants default to showing all fields. |
| Portal users | Multi-user model | Each supplier can have multiple portal users (defined in `3_users`). Portal access is scoped by user email — each user sees only the supplier requests they're associated with. |

### 2. Field configuration ("4_fields") and interval notation (B12)

| Column name | Validates | Permitted syntax | Example | Description |
|---|---|---|---|---|
| `length_constraint` | String character counts | `exact: X`, `[X, Y]`, `<`, `<=`, `>`, `>=` | `[5, 20]` | Text must be between 5 and 20 characters long (inclusive). |
| `value_range` | Numeric/decimal bounds | `exact: X`, `[X, Y]`, `<`, `<=`, `>`, `>=` | `>= 0` | The numeric value must be zero or positive. |
| `date_constraint` | Chronological timeline | `<`, `<=`, `>`, `>=` + `TODAY` or `YYYY-MM-DD` | `< TODAY` | The date must be in the past. |

**Syntax hint**: Square brackets `[x, y]` = inclusive. Parentheses `(x, y)` = exclusive. See `.math_notation` for the full reference.

### 3. Rule configuration ("4_complex_validations") and advanced logic (B22)

**A. Cross-field validations** — rules that evaluate the relationship between two columns:

| Rule type | Action performed | How to configure parameters |
|---|---|---|
| `Required if` | Makes Target required if Condition is met. | Condition field: triggering column. Condition val: triggering answer. |
| `Must be empty if` | Forbids data in Target if Condition is met. | Condition field: triggering column. Condition val: triggering answer. |
| `At least one required` | At least one of the grouped columns must contain data. | Condition field: 2nd column. |
| `Mutually exclusive` | Target and Condition cannot both contain data (XOR). | Condition field: the opposing column. Leave values blank. |
| `Combined fields must be unique` | Ensures the combination of 2+ columns is unique across all rows. | Condition field: 2nd column. |
| `Must match` | Target must exactly equal Condition. | Condition field: the baseline column. |
| `Must not match` | Target cannot be identical to Condition. | Condition field: the opposing column. |
| `Must be greater than` | Target must be strictly greater than Condition. | Condition field: baseline column. |
| `Must be greater than or equal to` | Target ≥ Condition. | Condition field: baseline column. |
| `Must be less than` | Target must be strictly less than Condition. | Condition field: baseline column. |
| `Must be less than or equal to` | Target ≤ Condition. | Condition field: baseline column. |

**B. Advanced validations** — single-column rules too complex for the field matrix (leave Condition fields blank):

| Rule type | Action performed | How to configure parameters |
|---|---|---|
| `step_increment` | Ensures a number is a multiple of a specific step (e.g., 15-minute increments). | Condition val: the required numeric step (e.g., `0.25`). |
| `restricted_values` | A blocklist of dummy values the supplier cannot use. | Condition val: comma-separated banned text (e.g., `TBD, N/A, NA`). |
| `domain_restriction` | Enforces an email address ends with an approved domain. | Condition val: the required domain suffix (e.g., `@randstad.com`). |

### 4. Supplier users ("3_users") and portal access (NEW SECTION — B, after section 3)

Each supplier in `2_suppliers` can have one or more portal users defined in `3_users`. When the workspace is initialized, each user row becomes a `WFA_SupplierUser` record in Workato. Portal access is scoped by `user_email` — the portal authenticates the user, resolves their supplier association, and shows only the relevant requests and uploads.

| Column | Purpose |
|---|---|
| Supplier user email | The email address used for portal login and notifications. |
| Supplier name | Links this user to a supplier in `2_suppliers` (dropdown). |
| Supplier contact name | First and last name of the contact (optional but recommended). |
| Request status | Managed by the system — do not edit manually. |

### 5. Variants ("6_variants") and field visibility (NEW SECTION)

When `1_customer` specifies a variant count greater than 0, the `6_variants` tab activates. It displays a matrix where each row is a field from `4_fields` and columns 7+ represent variant slots. Enter `1` to include a field in that variant, `0` to exclude it.

The "All fields" column and associated attribute columns (Data type, Data format, etc.) are auto-populated from `4_fields` via formulas. Do not edit these directly — they will update when you modify `4_fields`.

When Workato parses this config, it creates `CFG_Variant` and `CFG_VariantField` records linking each variant to its visible fields.

### 6. Implementation workflow (B — renumbered from old section 4)

| Step | Action | Instructions |
|---|---|---|
| 1. Configuration | Map out the rules | Complete `1_customer`. Define columns in `4_fields`. Add complex logic in `4_complex_validations`. Populate dropdown values in `5_lookups`. Configure `6_variants` if applicable. Add suppliers in `2_suppliers` and their users in `3_users`. |
| 2. Workspace init | Provision Workato | Click **Supplier integration > Initialize workspace**. The system packages your config, provisions a workspace, creates 13 data tables, and hydrates them with your field definitions, rules, lookups, variants, suppliers, and users. Wait for the success confirmation. |
| 3. Template generation | Create the template | Click **Supplier integration > Generate and export blank template**. Wait for the success popup. The .xlsx file is created in Drive and the template version is registered with Workato. |
| 4. Staging | Add suppliers | If not already done, add suppliers to `2_suppliers` and their users to `3_users`. Ensure names and emails are filled out. Leave "Request status" blank. |
| 5. Outreach | Sync to Workato | Click **Supplier integration > Send supplier outreach**. The system finds all blank-status suppliers, sends them to Workato, and writes "Sent" to the status column. |
