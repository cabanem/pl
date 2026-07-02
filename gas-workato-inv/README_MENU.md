# Workato Sync — Usage Guide

Workato Sync reads a Workato workspace through the developer API, writes an inventory
and analysis into this spreadsheet, and — for some actions — sends recipe data to
Gemini for summarization. Everything runs from the **Workato Sync** menu.

---

## First-time setup

Open **Workato Sync → Configuration** and set these, roughly in order:

| Setting | What it is | Notes |
|---|---|---|
| Set Workato API token | Your Workato developer API token | Stored per-user. Required for everything. |
| Set base URL | Your Workato region endpoint | Defaults to `https://app.eu.workato.com/api`. Change it if you're on the US (or another) region. |
| Set GCP project ID | Google Cloud project for Vertex / Gemini | Needed only for the AI actions. Stored at the script level. |
| Set debug folder ID | Drive folder for JSON dumps and docs | Optional — auto-created on first use if left unset. |

**Show current config** tells you what's set and where it came from. Precedence: for the
token, base URL, and debug folder, a user-level value wins over a script-level one. The
GCP project ID is the exception — it's read script-first.

---

## Choosing which recipes to act on

Every action except *Sync workspace inventory* runs against a set of recipe IDs, picked
one of two ways:

- **From selection** — select whole rows (or the ID cells) on any sheet that has a
  recipe-ID column: *View_Recipes*, *Inventory_Recipes*, and *Analysis_Call_Edges* all
  qualify. The tool finds the ID column by its header and reads the IDs from your
  selected rows.
- **From Input_Requests** — paste recipe IDs down column A of the *Input_Requests* sheet,
  one per row under the header. The tool creates that sheet the first time if it's missing.

In the **Basic** menu, the actions always use your selection. In **Advanced**, each action
lets you choose selection vs. Input_Requests.

---

## Basic vs. Advanced

The toggle at the bottom of the menu switches between them, and the choice is remembered
per-user:

- **Basic** — one clear action per capability, always acting on your selection. Backend
  inventory sheets are hidden to keep the workbook tidy (the hiding is applied on the next
  sync, or on demand via *Configuration → Apply sheet visibility*).
- **Advanced** — the same capabilities, but each expands to expose input source and
  options, plus Test connectivity, Diagnostics, and Maintenance.

---

## What each action does

| Action | Reads | Produces | Gemini calls |
|---|---|---|---|
| **Sync workspace inventory** | Projects, folders, recipes, properties, data & lookup tables; dependencies + call edges per recipe | Overwrites the *Inventory_\** and *Analysis_\** sheets; refreshes Dashboard & View_Recipes | 0 |
| **Recipe step breakdown → sheet** | Full recipe detail per ID | Overwrites *Debug_Recipe_Logic* (flattened steps); saves each recipe's JSON to Drive; a row per recipe in *System_Logs* | 0 |
| **AI analysis → sheet** | Recipe detail + call/process graph + step digest per ID | Overwrites *Output_AI_Analysis*; saves per-recipe `.ai.json` / `.mmd` to Drive | 1 per recipe |
| **Process maps → sheet** | Transitive call graph per root ID | Overwrites *Output_Process_Maps* (Mermaid); saves `.mmd` to Drive when too large for a cell | 0 |
| **Recipe reference doc → Drive** | Recipe detail + graph + digest per ID | One aggregated Markdown file in Drive; a row in *System_Logs* | 1 per recipe |
| **System architecture doc → Drive** | Recipe metadata + call edges across the whole batch | One Markdown file in Drive; a row in *System_Logs* | 1 for the whole batch |

Two things worth internalizing:

- **Process maps are not AI-generated.** They're built by the graph analyzer, so they cost
  no Gemini calls and don't require a GCP project. The AI-backed actions are *AI analysis*
  and the two documents.
- **The reference doc calls Gemini once per recipe; the architecture doc calls it once
  total.** A 40-recipe reference doc is ~40 calls; a 40-recipe architecture doc is one.
  For the per-recipe actions, batch size is what drives cost and quota.

---

## Where results live, and what persists

- **Sheets are latest-only.** Sync and the three sheet-writing actions *clear and rewrite*
  their sheet on every run. *Output_AI_Analysis* and *Output_Process_Maps* show your most
  recent run, not a cumulative history — analyze a new selection and the prior sheet is
  replaced.
- **Drive keeps every run.** JSON dumps, `.mmd` graphs, and the generated docs are written
  with timestamped names, so history accumulates in the debug folder. That's where to look
  if you need to compare runs.

---

## Limits & gotchas

- Sync lists *all* recipes, but the dependency and call-edge analysis covers only the first
  100 (`RECIPE_LIMIT_DEBUG`). A large workspace gets a complete recipe list but partial
  graph analysis.
- The AI actions need a valid GCP project ID and Vertex access. Without them, Sync, step
  breakdown, and process maps still work.
- Selection mode needs a sheet with a recognizable ID header; if it can't find one, it
  falls back to reading the selected cells as raw IDs.

---

## Maintenance (Advanced → Maintenance)

All three prompt for confirmation before acting.

- **Reset inventory sheets** — clears the inventory/analysis sheets back to headers.
  Reversible: a sync regenerates them.
- **Prune System_Logs** — keeps the most recent 500 rows, deletes older.
- **Clear Drive debug files older than 30 days** — moves them to Trash (recoverable ~30 days).