# Python step inventory — apply guide

Phase 1 of the Python → Ruby connector work. It adds one menu action to DataBridge:
**Python step inventory → sheet + Drive**. The action writes one row per Python step to a new tab,
saves each step's code to Drive as a `.py` file, and saves a `manifest.json` with the full record per step.
The manifest is the input for Phase 2 (the connector design).

Two projects change. Do them in this order.

## 1. GraphLib (project "RecipeAnalyzer")

Script ID: `1zQz8lK_00xJiyVweBiNUfhr54HqAGY0isdck0lQCYyr134Xmm7fx_ahW`

1. Open the project. Open `Code.js`.
2. Replace the whole file with `lib_workato-graph/Code.js` from this package.
   Or paste the three blocks by hand (see `CHANGES.diff`, last section):
   - the version line in the header (`1.0.0` → `1.1.0`),
   - `collectSteps(...)` and `extractPillRefs(...)`, placed right before `primeCache(...)`,
   - `_walkSteps(...)`, placed right before `_scanBlockForCalls(...)`.
3. Save. Deploy → Manage deployments → the library deployment → Edit → Version: **New version**.
   Description: `1.1.0 collectSteps + extractPillRefs`. Deploy.
4. Note the new version number. You need it in step 2.1.

Nothing existing in the library changed. The two public methods and the one private walker are additions.

## 2. DataBridge (project "WorkatoSyncApp")

Script ID: `1sl2ZfkgwX57EIygRwEP7nkXTK8BEXaB60cnFKsqhg2DWic3V0SVAzrYS`

1. Libraries (left sidebar, "+") → `WorkatoGraphLib` → set **Version** to the number from step 1.4. Save.
   This is the pinning step. Without it the runner stops with a clear message and does nothing.
2. Add two new files (File → "+" → Script):
   - `15_Feature_PythonSteps` — paste `app_workato-workspace-inv_DataBridge/15_Feature_PythonSteps.js`
   - `54_Tests_PythonSteps` — paste `app_workato-workspace-inv_DataBridge/54_Tests_PythonSteps.js`
3. Update seven existing files. Either replace each file with the version in this package, or apply the
   edits by hand from `CHANGES.diff`. The edits, in plain words:

   | File | Change |
   |---|---|
   | `01_CoreConfig` | `SHEETS.PYTHON_STEPS: "Analysis_Python_Steps"`; `HEADERS.PYTHON_STEPS` (24 columns); a `PYTHON_STEPS: { SAVE_PY_TO_DRIVE: true }` block next to `QA` |
   | `03_WorkatoServices` | two delegate methods on `RecipeAnalyzerService`: `collectSteps`, `extractPillRefs` |
   | `05_DataMapper` | one new method `mapPythonStepsToRows(records, timestamp)` |
   | `00_CoreContext` | one `Commands.register("python.extract", …)` block |
   | `99_EntryPoints` | two globals: `extractPythonSteps()`, `extractPythonStepsSelected()` |
   | `21_UIMenu` | one submenu in Advanced mode: "Python step inventory -> sheet + Drive" (Whole workspace / From selection) |
   | `30_DashboardService` | `PYTHON_STEPS: C.analysis` in the tab-colour map (cosmetic; purple like the other Analysis tabs) |

4. Save everything.

## 3. Verify before the first run

1. In the editor, pick the function `runPythonStepTests` and run it.
2. Expected in the execution log: `PYTHON STEP TESTS: 12 passed, 0 failed.`
   - 8 hermetic tests exercise the analyzer and the mapper against a reduced copy of TPL-02 Build XLSX.
   - 4 integration tests exercise the new library methods through `RecipeAnalyzerService`.
   - If the integration tier prints `SKIP: bound WorkatoGraphLib predates collectSteps`, step 2.1 was missed.

## 4. First run

1. Reload the spreadsheet so the menu rebuilds. Switch to Advanced mode if you are in Basic.
2. Workato Sync → Python step inventory -> sheet + Drive → **Whole workspace**.
3. What happens: one paginated `recipes` sweep; recipes whose `applications` list lacks `py_eval` are skipped
   without parsing; every remaining recipe is walked; each Python step becomes a row; each step's code is saved
   to the debug Drive folder as `<timestamp>_ID-<recipe id>_<recipe name>__<step alias>.py`; the manifest is
   saved as `<timestamp>_ID-python_steps_manifest.json`; System_Logs gets a row with the manifest link.
4. The toast tells you the counts. It also flags two things if they occur: steps whose `payload_asset_type`
   is not `inline` (the code is not in the recipe JSON — worth a look), and recipes that failed to parse
   (they get an `ERROR` row with the message in the Comment column).

## 5. Read the tab

`Analysis_Python_Steps` (hidden in Basic mode, like the other Analysis tabs). Columns worth knowing:

- **Code FP** — SHA-256 of the code, same digest as the change ledger. Re-run after each conversion; a changed
  or vanished row is the progress signal.
- **Imports** — root modules. `openpyxl` / `pandas` here means "inventory only, not for conversion".
- **Functions / Classes** — top-level names. Phase 2 clusters these across steps to find shared methods.
- **Declared Inputs / Declared Outputs** — the step's own schema.
- **Upstream (provider:step)** — which step feeds it, from the datapills in its input mapping.
- **Consumers (step#:name)** — which steps in the same recipe read its output. The manifest also records
  *which output paths* each consumer reads.
- **Payload** — should read `inline`.

## 6. Hand-off to Phase 2

Share the `manifest.json` from Drive here. It holds, per step: the code, both parsed schemas, the raw input
mapping, upstream refs, consumers with the paths they read, and — for recipe functions — the function's own
`parameters` / `result` schema. That is everything the function-clustering, schema-drift and consumer-graph
analysis needs; no further Workato access required.

## Notes

- Re-runs add new Drive files (the toolkit names every save with a timestamp). "Clear Drive debug files
  older than 30 days" in Maintenance keeps the folder tidy. Set `PYTHON_STEPS.SAVE_PY_TO_DRIVE` to `false`
  to save only the manifest.
- `python.extract` accepts `{ ids: [...] }` for a subset (that is what "From selection" passes) and
  `{ options: { savePy: false } }` to override the Drive knob for one run.
- FYI, unrelated to this change: the existing `*Selected()` entry points in `99_EntryPoints` call
  `Logger.notify(...)` when nothing is selected. `Logger` is the Apps Script built-in and has no `notify`,
  so that path throws instead of toasting. The two new entry points use `AppLog.notify`.
