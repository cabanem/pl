# Supplier Data Collection — Configuration Workbook

This workbook is your Mission Control for automating supplier data collection. It replaces manual Excel template creation and disjointed email chains, allowing you to define validation rules, generate client-specific templates, and provision a Workato workspace.

---

## Overview

This tool allows you to:

| | |
|---|---|
| **Define project rules** | Specify exact data formats, required fields, cross-field validations, and dropdown options for your client. |
| **Generate templates** | Automatically generate strictly validated Excel files ready for supplier data collection. |
| **Manage supplier users** | Define which users at each supplier organization will access the portal to submit data. |
| **Configure variants** | Control which fields are visible to which supplier groups when templates differ across the engagement. |
| **Provision workspaces** | Initialize an isolated Workato workspace with all tables, rules, and lookups pre-configured from this workbook. |

---

## Guides

| # | Guide | Location |
|---|---|---|
| 1 | User guide | `.user_guide` tab |
| 2 | Mathematical notation | `.math_notation` tab |
| 3 | Regular expressions | `.regex` tab |

---

## Your workspace (the numbered tabs)

| Tab | Description |
|---|---|
| `1_customer` | High-level implementation details. Define the client name, target VMS, Drive folder, variant count, and outreach cadence. This data is packaged with every template and supplier sync you trigger. |
| `2_suppliers` | Your operational roster. Add suppliers, indicate seed data relevance, and assign template variants. The tool tracks request status and logs edits automatically. |
| `3_users` | Supplier portal users. For each supplier, list the contacts who will access the Workato portal to submit data. Multiple users per supplier are supported. |
| `4_fields` | The blueprint for your Excel templates. Each row defines a column in the template — its data type, format, validations, lookup references, and cleaning rules. |
| `4_complex_validations` | (Advanced) Define complex, cross-field validation rules that the downstream integration engine will check. |
| `5_lookups` | The master list for all dropdown menus (e.g., US States, Country Codes). To add a new dropdown option, set is_active to TRUE. |
| `6_variants` | If you've indicated that there are multiple versions/variants of the template, you'll specify which fields to include here. |

> **NOTE:** Please do not edit tabs starting with an underscore `_` or a period `.`, as these relate directly to the backend and reference documentation.

---

## Using the tool

### Generate template(s) and initialize Workato

| Step | Instruction |
|---|---|
| 1 | Complete all numbered tabs (`1_customer` through `6_variants`) with your client's configuration. |
| 2 | In the top toolbar, click **Supplier data collection > Generate template(s) and initialize Workato**. |
| 3 | The system will package your configuration, provision a Workato workspace, create all data tables, and hydrate them with your field definitions, rules, lookups, variants, suppliers, and users. A success message will confirm the assigned workspace and version. |

### Draft a specific variant

| Step | Instruction |
|---|---|
| 1 | If you only need to generate one specific version of the template (instead of all of them), ensure your configurations are set. |
| 2 | In the top toolbar, click **Supplier data collection > Draft specific variant...** |
| 3 | When prompted, type the exact name of the variant you want to build (e.g., Variant_1) and click OK. Wait for the success popup. |


# User Guide

---

## 1. System overview and best practices

| Category | Principle | Description |
|---|---|---|
| Workspace | Numbered tabs | This is your safe zone. You will build client profiles, manage supplier rosters, and define all field/validation rules in tabs 1 through 6. |
| System | Underscore / dot tabs | Do not manually edit these tabs unless instructed. They hold internal configurations, execution logs, and dictionaries used by the backend code. |
| Automation | Cache delay | The script memorizes `_developer_settings` in order to work quickly. If you manually change a webhook URL or target folder, the script won't see the change for up to an hour unless you trigger a cache reset. |

---

## 2. Fields ("4_fields") and interval notation

| Column name | Validates | Permitted syntax | Example | Description |
|---|---|---|---|---|
| `length_constraint` | String character counts | `exact: X`, `[X, Y]`, `<`, `<=`, `>`, `>=` | `[5, 20]` | Text must be between 5 and 20 characters long (inclusive). |
| `value_range` | Numeric/decimal bounds | `exact: X`, `[X, Y]`, `<`, `<=`, `>`, `>=` | `>= 0` | The numeric value must be zero or a positive number (no negatives). |
| `date_constraint` | Chronological timeline | `<`, `<=`, `>`, `>=` + `TODAY` or `YYYY-MM-DD` | `< TODAY` | The date submitted must be in the past. |

**Syntax hint:** Square brackets (e.g., `[x, y]`) means inclusive. Parentheses (e.g., `(x, y)`) means exclusive. See the `.math_notation` tab for the full reference.

---

## 2b. Supplier users ("3_users")

Each supplier in `2_suppliers` can have one or more portal users defined in `3_users`. When the workspace is initialized, each user row becomes a record in Workato's supplier user table. Portal access is scoped by email — the portal authenticates the user, resolves their supplier, and shows only matching requests and uploads.

| Column | Purpose |
|---|---|
| Supplier user email | Email used for portal login and notifications. |
| Supplier name | Links this user to a supplier in `2_suppliers` (dropdown). |
| Supplier contact name | First and last name (optional but recommended). |
| Request status | Managed by the system — do not edit. |

---

## 2c. Variants ("6_variants")

When `1_customer` specifies a variant count greater than 0, configure `6_variants`. Each row is a field from `4_fields`; columns starting at G represent variant slots. Enter `1` to include a field in that variant, `0` to exclude it.

The leftmost reference columns (field name, data type, data format, etc.) are formula-driven from `4_fields` — don't edit them directly.

---

## 3. Rules ("4_complex_validations") and advanced logic

### A. Cross-field validations

These rules evaluate the relationship between two different columns.

| Rule (as shown in dropdown) | Action performed | How to configure |
|---|---|---|
| Required if | Makes Target required when Condition is met. | Condition field: triggering column. Condition val: triggering answer. |
| Must be empty if | Forbids data in Target when Condition is met. | Condition field: triggering column. Condition val: triggering answer. |
| At least one required | At least one of the grouped columns must have data. | Condition field: 2nd column. |
| Mutually exclusive | Target and Condition cannot both contain data (XOR). | Condition field: opposing column. Leave values blank. |
| Combined fields must be unique | The combination of 2+ columns must be unique across all rows. | Condition field: 2nd column. |
| Must match | Target must exactly equal Condition. | Condition field: baseline column. |
| Must not match | Target cannot be identical to Condition. | Condition field: opposing column. |
| Must be greater than | Target must be strictly greater than Condition. | Condition field: baseline column. |
| Must be greater than or equal to | Target ≥ Condition. | Condition field: baseline column. |
| Must be less than | Target must be strictly less than Condition. | Condition field: baseline column. |
| Must be less than or equal to | Target ≤ Condition. | Condition field: baseline column. |

### B. Advanced validations (coming soon)

Single-column rules defined in the backend but not yet available in the dropdown:

| Rule | Action performed | How to configure |
|---|---|---|
| step_increment | Ensures a number is a multiple of a specific step (e.g., 0.25 for 15-min increments). | Condition val: the required step. |
| restricted_values | A blocklist of values the supplier cannot use. | Condition val: comma-separated banned text (e.g., `TBD, N/A, NA`). |
| domain_restriction | Enforces an email ends with an approved domain. | Condition val: required suffix (e.g., `@randstad.com`). |

---

## 4. Implementation workflow

| Step | Action | Instructions |
|---|---|---|
| 1. Configuration | Map out the rules | Complete `1_customer` (client name, VMS, Drive folder, variant count). Define columns in `4_fields` and their attributes. Add complex rules in `4_complex_validations`. Populate dropdowns in `5_lookups`. If variants > 0, configure `6_variants`. List suppliers in `2_suppliers` and their portal users in `3_users`. |
| 2. Generation | Create the template and initialize | Click **Supplier data collection > Generate template(s) and initialize Workato**. You can also generate a single variant by clicking **Supplier data collection > Draft specific variant...** Note: Generated Excel files will contain a hidden `Data_Lookups` sheet — do not delete this. |
