# TPL-02 Local Test Harness

Generate SDC XLSX templates on your laptop — no workspace, no provisioning, no FileStorage.

## Why this exists
TPL-02 (the XLSX builder) is effectively a pure function: canonical model in, .xlsx out.
This harness runs its **verbatim** code against canonical models you write by hand, so you
can iterate on config shapes in seconds and open the results in Excel to judge them.

## Setup
```
pip install openpyxl
```

## Run
```
python build.py                   # build every sample (base + variants) into ./output/
python build.py realistic         # one model, base case
python build.py realistic v_short # one model, a specific variant_id
python build.py --list            # list sample models
```

## Files
- `tpl02_builder.py` — TPL-02's py_eval code, extracted verbatim. **Do not edit** unless you're
  testing a fix; if you patch it here, mirror the change back into the recipe.
- `sample_models.py` — hand-written canonical models, same shape CAN-01 emits. **Edit / add freely.**
- `build.py` — the runner (stands in for the TPL-01 wrapper + FileStorage read).
- `output/` — generated .xlsx files.

## What the three starter models exercise
- `realistic` — many fields, flat + dependent (cascading) dropdowns, a number bound, a date,
  a text max-length, and a `v_short` variant. Your round-2 "several realistic configs" baseline.
- `collision` — two parent values differing only by punctuation. Demonstrates **T1**: they
  sanitize to the same named range and one silently overwrites the other (a dropdown shows the
  wrong list). Open it: the dependent dropdown will be wrong for one parent.
- `unbounded` — a number and a date field with no min/max. Demonstrates **T2**: produces a
  malformed DataValidation (operator/formula = None) that can trigger Excel's
  "repaired unreadable content" dialog. Open it in your analysts' Excel to see the real behavior.

## How to test a fix
Patch `tpl02_builder.py`, re-run, re-open. When the fix is right, port the exact change into
the TPL-02 recipe's py_eval step. Keep harness and recipe in sync.

## Limits (what this does NOT cover)
- Upstream: it does not run CAN-01 — you supply the model directly. If a bug is in how CAN-01
  *builds* the model, this won't catch it (the contract between them is verified separately).
- It does not test TPL-01's orchestration (draft-check, variant-name resolution, empty_variant
  routing) — only the builder. TPL-01 is a thin wrapper; its logic was reviewed separately.
- `data_only`-style cached-formula concerns don't apply here (this writes files, doesn't read them).
