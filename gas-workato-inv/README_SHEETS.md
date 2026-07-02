# Workato Sync — Sheet Structure Guide

This workbook is organized by tab-name **prefix**, and the prefix tells you the tab's role
and how it behaves:

| Prefix | Role | Behavior |
|---|---|---|
| `Dashboard_` / `View_` | User-facing surfaces | Formula-driven; rebuilt on each sync |
| `Inventory_` | Raw workspace snapshot | Overwritten on each sync |
| `Analysis_` | Derived relationships | Overwritten on each sync |
| `Debug_` | Recipe logic breakdown | Overwritten on each run |
| `Input_` | The one sheet **you** edit | Never overwritten by the tool |
| `Output_` | Generated results | Overwritten on each run (history lives in Drive) |
| `System_` | Run log | Append-only (grows until pruned) |

"Write mode" below means:
- **Overwrite** — cleared and rewritten in full each time the action runs (latest run only).
- **Formula-driven** — rebuilt on sync; cells are live formulas reading other tabs.
- **Append** — new rows added, nothing removed (until Maintenance → Prune).
- **User input** — you type into it; the tool only reads it.

---

## At a glance

| Sheet | Group | Populated by | Write mode |
|---|---|---|---|
| Dashboard_Home | Dashboard | Sync workspace inventory | Formula-driven |
| View_Recipes | Dashboard | Sync workspace inventory | Formula-driven |
| Inventory_Projects | Inventory | Sync workspace inventory | Overwrite |
| Inventory_Folders | Inventory | Sync workspace inventory | Overwrite |
| Inventory_Recipes | Inventory | Sync workspace inventory | Overwrite |
| Inventory_Properties | Inventory | Sync workspace inventory | Overwrite |
| Inventory_Data_Tables | Inventory | Sync workspace inventory | Overwrite |
| Inventory_Lookup_Tables | Inventory | Sync workspace inventory | Overwrite |
| Analysis_Dependencies | Analysis | Sync workspace inventory | Overwrite |
| Analysis_Call_Edges | Analysis | Sync workspace inventory | Overwrite |
| Debug_Recipe_Logic | Debug | Recipe step breakdown | Overwrite |
| Input_Requests | Input | **You** | User input |
| Output_AI_Analysis | Output | AI analysis | Overwrite |
| Output_Process_Maps | Output | Process maps | Overwrite |
| System_Logs | System | Step breakdown + both doc actions | Append |
| Output_System_Docs | Output | *(reserved — see note)* | *(not written)* |
| test_results | System | Test suite | Overwrite |

---

## Dashboard surfaces

### Dashboard_Home
At-a-glance summary and navigation. Not a table — it's a laid-out panel with a status block
(last sync time, base URL, current user), a **Counts** block that tallies each inventory and
output sheet with live `COUNTA` formulas, and quick links to the main tabs. Rebuilt on every
sync.

### View_Recipes
The curated surface you'll usually **select rows on** to drive the per-recipe actions. Fully
formula-driven from the other tabs, so it always reflects the latest sync.

| Column | Meaning |
|---|---|
| Recipe ID, Name, Status, Project, Folder, Last run at | Pulled from *Inventory_Recipes* (columns A–F) via `QUERY` |
| # Dependencies | Count of this recipe's rows in *Analysis_Dependencies* |
| # Calls out | Count of this recipe's rows in *Analysis_Call_Edges* |
| Has AI? | "YES" if the recipe appears in *Output_AI_Analysis* |
| Has maps? | "YES" if the recipe appears in *Output_Process_Maps* |

Note: it reads only the first six columns of *Inventory_Recipes*, so the newer recipe
metadata (Version, Updated At, job counts, Applications) shows on *Inventory_Recipes*, not
here. Columns L–O are hidden helper tables that feed the counts.

---

## Inventory (raw workspace snapshot)

Overwritten in full on every **Sync workspace inventory**. A recipe deleted in Workato simply
stops appearing after the next sync.

### Inventory_Projects
| Column | Meaning |
|---|---|
| Project ID | Workato project id |
| Name | Project name |
| Description | Project description |
| Created At | Creation timestamp |

### Inventory_Folders
| Column | Meaning |
|---|---|
| Folder ID | Workato folder id |
| Name | Folder name |
| Parent Folder | Resolved parent name — "Workspace Root (Home)" for a project root, "TOP LEVEL" if none |
| Project | Resolved project name |

### Inventory_Recipes
| Column | Meaning |
|---|---|
| Recipe ID | Workato recipe id |
| Name | Recipe name |
| Status | "ACTIVE" or "STOPPED" (from the API's `running` flag) |
| Project | Resolved project name |
| Folder | Resolved folder name |
| Last Run At | Last run timestamp, or "NEVER" |
| Version | `version_no` |
| Updated At | Last-modified timestamp |
| Jobs Succeeded | `job_succeeded_count` |
| Jobs Failed | `job_failed_count` |
| Lifetime Tasks | `lifetime_task_count` |
| Applications | Trigger + action apps, comma-joined |

### Inventory_Properties
| Column | Meaning |
|---|---|
| Property ID, Name, Value, Created At, Updated At | Workspace properties |

May be empty if the token lacks permission to read properties (the error is caught and the
sheet is left blank rather than failing the sync).

### Inventory_Data_Tables
| Column | Meaning |
|---|---|
| Table ID, Name | Data table identity |
| Description | Description, with a "Folder: …" note appended when applicable |
| Columns | Column names, comma-joined |
| Record count | Always blank — the list endpoint doesn't return it |
| Updated at | Last-modified timestamp |

### Inventory_Lookup_Tables
Same shape as Data Tables, except the Description carries a "Project: …" or "Scope: Global"
note, and Columns are parsed from the lookup table's JSON schema.

---

## Analysis (derived relationships)

Also written by **Sync workspace inventory**, overwritten each time. Important limit: these
are computed only for the **first 100 recipes** (`RECIPE_LIMIT_DEBUG`). The recipe *list* is
complete, but the relationship analysis below covers that first slice.

### Analysis_Dependencies
One row per dependency a recipe has (connections, tables, called recipes, etc.).

| Column | Meaning |
|---|---|
| Parent Recipe ID | The recipe that has the dependency |
| Project, Folder | The parent recipe's location (resolved) |
| Dependency Type | Kind of dependency |
| Dependency ID | The dependency's id |
| Dependency Name | Resolved name where available |

### Analysis_Call_Edges
One row per recipe-to-recipe call (a recipe invoking another recipe).

| Column | Meaning |
|---|---|
| Parent Recipe ID / Parent Recipe Name | The calling recipe |
| Project, Folder | Caller's location (resolved) |
| Step Path | Position of the calling step in the recipe tree (e.g. "0/1") |
| Step Name | Name of the calling step |
| Branch Context | The conditional path the call sits under (e.g. "IF … = P1", "ELSE"), blank if top-level |
| Provider | The provider making the call (e.g. `workato_recipe_function`) |
| Child Recipe ID / Child Recipe Name | The called recipe |
| ID Key | Which input field carried the child id (`flow_id` / `recipe_id` / `callable_recipe_id`) |

---

## Debug

### Debug_Recipe_Logic
Flattened, step-by-step view of the recipes you ran **Recipe step breakdown** on. Overwritten
each run.

| Column | Meaning |
|---|---|
| Recipe ID / Recipe Name | The recipe |
| Step # | Step sequence number |
| Indentation | Nesting depth marker (shows block structure) |
| Provider | App/provider for the step |
| Action | The action or control keyword |
| Description | Step description |
| Details/Code | Raw step detail |

A recipe that fails to fetch gets a single row with "ERROR" and the message.

---

## Input

### Input_Requests
The one sheet **you** write to. Paste recipe IDs down column A (one per row, under the header)
to drive any action's "From Input_Requests" mode. Created automatically the first time, and
its header is repaired if changed. The tool only ever *reads* this sheet.

| Column | Meaning |
|---|---|
| Recipe ID (Input List) | One recipe id per row |

---

## Output (generated results)

Each is overwritten on its run, so the sheet shows your **most recent** run. Every run's
artifacts are also written to Drive with timestamped names, so history lives there.

### Output_AI_Analysis
Gemini's structured read of each recipe (one row per recipe). Written by **AI analysis**.

| Column | Meaning |
|---|---|
| Recipe ID / Recipe Name | The recipe |
| Objective | One-line purpose |
| Trigger | What starts the recipe |
| High Level Flow | Step-level summary |
| Hotspots | Control-flow hotspots (branches, loops, error paths) |
| External Apps | Apps the recipe touches |
| Called Recipes | Recipes it invokes |
| Risks & Notes | Cautions the model surfaced |
| Structured Preview | Truncated JSON of the full structured result |
| Graph Metrics | Node/edge counts and related metrics (JSON) |
| Link: AI Analysis | Drive link to the full `.ai.json` |
| Link: Call Graph / Full Graph | Drive links to the `.mmd` graph files |
| Timestamp | When the row was written |

A recipe that errors gets Recipe Name = "Error" and the message in Objective.

### Output_Process_Maps
Graph-analyzer output (not AI) — one row per root recipe. Written by **Process maps**.

| Column | Meaning |
|---|---|
| Root Recipe ID / Root Name | The recipe the map is rooted at |
| Mode | "calls", "full", or "calls+full" |
| Depth | Transitive expansion depth used |
| Call Graph (Mermaid) | Mermaid text of the recipe-to-recipe call graph |
| Process Graph (Mermaid) | Mermaid text of the step-level process graph |
| Generation Notes | Notes (cycles detected, truncation, node caps) |
| Link: Call Graph / Full Graph | Drive links, used when a graph is too large for a cell |
| Timestamp | When the row was written |

Both output sheets are created as header-only rows during a sync (the dashboard needs them to
exist), so you may see them empty before you've run these actions.

### Output_System_Docs *(reserved — not currently used)*
Defined in the schema but **not written by any action**. The system-architecture and
reference-doc actions record their runs in *System_Logs* instead, so this tab normally never
appears. Left in place as a reserved slot; safe to ignore.

---

## System

### System_Logs
Append-only run log — the one sheet that grows over time. Written by **Recipe step
breakdown** (one row per recipe, with a Drive link to that recipe's JSON) and by both
document actions.

| Column | Meaning |
|---|---|
| Timestamp | When the entry was written |
| Recipe ID | The recipe id — or, for the doc actions, "Batch Run" |
| Recipe Name | The recipe name — or "Aggregated Documentation" for docs |
| Status | e.g. "Saved to Drive" |
| Drive Link | Hyperlink to the saved artifact |
| JSON Payload | Full JSON body (spills into extra columns when very large) |

The doc actions reuse the Recipe ID / Recipe Name columns as a document label, so don't read
those two columns literally for "Batch Run" rows. Trim this sheet with **Maintenance → Prune
System_Logs**.

### test_results
Written by the test suite when run with sheet reporting on: Timestamp, Test, Status, Duration
(ms), Error. Overwritten each run. Not part of the workspace data.