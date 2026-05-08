# SDC Data Collection — Capability Deep Dive: Validate Config (v1, Phase 0)

## Status

First of four per-capability plain-language deep dives. Companion to the workflow inventory, data model, and the stage-by-stage workflow document. Where the stage doc described workflows by their lifecycle steps, this doc takes one shared capability and asks: what exactly does it take in, what does it produce, and what does it check?

The forcing function continues: writing this in plain language exposes assumptions about input shape, error reporting, and where the boundary sits between this capability and its callers.

## Intent

**Validate config** answers a single question: *is the analyst's configuration workbook coherent enough to provision (or re-provision) a project?*

It checks structural correctness — required parts exist, references between parts resolve, no internal contradictions — and reports back what's wrong in a form the analyst can act on. It does *not* check whether the configuration makes business sense (whether the supplier list is the right one, whether the field set is the right one, whether the validation rules match the client's actual data shape). That's analyst judgment, not system judgment.

## Where it's called from

Three callsites:

1. **From the configuration workbook itself.** The analyst, while iterating on the workbook, runs validation to know if their changes are coherent before committing. Surfaces errors inline; the analyst keeps editing.
2. **From E1 (Initial provisioning), stage 4.** The system validates before recording the project, before publishing the first version, before building the template, before staging suppliers. A failure here stops the workflow.
3. **From E2 (Config update / re-publish), as part of its parsing/checking stage.** Same role as in E1: gate before committing the new version.

The capability behaves the same in all three callsites. What differs is what the caller does with the result. Callsite 1 displays errors back in the workbook UI. Callsites 2 and 3 either continue the workflow on success or halt and surface errors on failure.

## What goes in

A parsed configuration object — the workbook's contents, already converted from spreadsheet rows into structured data. Validate config does not parse the workbook itself; it expects parsing to have happened upstream and to have succeeded.

The parsed configuration contains, in plain terms:

- **Project-level settings.** Client name, target downstream system, output folder, reminder cadence (three tier values), and other engagement metadata.
- **Field definitions.** For each field the suppliers will be asked to fill in: a name, description, expected data type and format, whether it's required, what validation applies, and whether it depends on another field.
- **Lookups.** Named sets of valid values for dropdown fields. Some lookups are simple lists; others are cascading (the valid values depend on what was picked in another field).
- **Cross-field validation rules.** Rules of the shape "if this field has this value, then that other field must (or must not) have a value", and similar.
- **Variants.** Optional. A variant is a flavor of the template containing a subset of the fields, useful when different supplier categories should see different sets of fields.
- **Form slot mapping.** Tells the system which template field maps to which form slot in the workspace app's manual-entry form.
- **Error message overrides.** Optional. Per-rule custom error messages that override system defaults.
- **Supplier list.** Each supplier with at least one supplier user (email and name).

## What comes out

Two shapes, only one of which applies on any given call:

**Success.** A signal that the configuration is coherent, plus a summary of what was validated — counts of fields, lookups, rules, variants, suppliers. The summary lets the analyst confirm the workbook scope was read as expected (catching cases where, for example, a sheet was forgotten or a row was outside the parsed range).

**Failure.** A list of validation errors. Each error has:

- **Where** in the workbook the problem is (sheet plus row, or field name plus property).
- **What** is wrong, in language the analyst can act on.
- **Severity** — does this stop provisioning, or is it a warning the analyst should know about?

The output does not partial-commit. There is no "validate the project-level settings, then validate the fields, return on first failure." The capability runs every check on every call and returns the full list. An analyst with five errors should see all five at once, not be asked to re-run after each fix.

## What it checks (the actual work)

Eight categories of checks. They run in this order so that earlier-category failures don't generate noise in later categories (e.g., no point checking variant references against fields that themselves haven't passed structural checks).

1. **Project-level settings are present and well-formed.** Required engagement fields exist. Reminder tiers are positive integers in increasing order. The target downstream system is one the export workflow knows about.

2. **Each field definition is internally consistent.** A field can't be both required and must-be-empty. A field's data type and format are compatible (e.g., a date format only applies to a date type). A field declared as a dropdown has a data type that supports lookups.

3. **Field-to-field references resolve.** A field's "depends on" points at another field defined in this same configuration. A field's lookup reference matches a lookup that's also defined here. References that point nowhere are caught here.

4. **Lookups are well-formed.** No duplicate values within a single lookup. Cascading lookups have valid parent values (every parent value mentioned is actually a value in the lookup it claims to depend on).

5. **Cross-field validation rules are well-formed.** Each rule's structure parses. The rule's target field exists, and so does any condition field referenced. Custom error messages have the placeholder structure they claim (e.g., a message that references `{value}` is matched against a rule shape that supplies `{value}`).

6. **Variants are well-formed.** Each variant's name is unique within this version. Every field a variant references is one that's defined in the field definitions.

7. **Form slot mapping is well-formed.** Each mapped field exists. Each mapped slot is one the form actually has. No two fields map to the same slot. The control type chosen for a slot matches the field's data type (a date field doesn't end up on a checkbox slot).

8. **Supplier list is well-formed.** Each supplier has a name. Each supplier has at least one supplier user. Each supplier user has an email and a name. Emails pass a basic format check.

After all eight categories run, **dependency-cycle detection** runs across the "depends on" chain (catching configurations where field A depends on B, B depends on C, and C depends back on A).

## Edge cases & open questions

- **Workbook with zero fields.** Syntactically valid (project-level settings present, empty field section). Should validation reject it? Currently unspecified.
- **Lookup with zero values.** Same question. A defined-but-empty lookup is technically structurally valid but probably not what the analyst meant.
- **Variant with zero fields.** Same. A variant that excludes every field collapses to nothing usable.
- **Supplier with zero supplier users.** Hard-fail or analyst-override warning? Today's data model says a supplier "needs" at least one user, but the validation behavior on this isn't pinned down.
- **Duplicate supplier names.** Two rows with the same supplier name. The same supplier with two contacts (which should have been one row with two users)? Or a data-entry error?
- **Cascade depth.** Cascading lookups can chain (lookup A's parent is lookup B's value, B's parent is C's value, etc.). Is there a maximum depth the system supports? Where does it stop accepting?
- **Soft-fail vs. hard-fail threshold.** The validation result has a severity field. Some categories of issue should warn but not stop (analyst can choose to proceed); others should stop unconditionally. Which is which isn't fully specified yet.
- **Validation against the prior version (E2 only).** When re-publishing, should validation also check compatibility with the version being deprecated — for example, warn if a field that suppliers were already asked for is being removed, or if a lookup value in active use is no longer present? Currently: no. Worth asking.
- **Workbook ranges and trailing data.** What happens when a sheet has populated rows beyond what the parsing layer captured? That's a parsing concern, but the validate-config response should make clear when the summary counts disagree with what the analyst expects to see.
- **Output language.** The validation reports back text. Whose language? Today's assumption: English, single language, no localization.

## What this capability deliberately does not do

- **Parse the workbook.** Parsing happens upstream; validate config receives an already-structured input.
- **Persist anything.** Validate config is read-only against the system. It produces a result; the caller decides what to do with it.
- **Check business sense.** Whether the right suppliers are listed, whether the right fields are being collected, whether the validation rules reflect actual client requirements — all outside scope.
- **Resolve ambiguity in the input.** If two fields share a name, validate config flags the duplication; it does not pick one and proceed.

## Inputs and outputs at a glance

| | Input | Output (success) | Output (failure) |
|---|---|---|---|
| Shape | Parsed configuration object | "Coherent" + summary counts | List of errors (where, what, severity) |
| Side effects | None | None | None |
| Idempotency | Yes — same input, same result | Yes | Yes |

---

## What's next

The natural next deep dive is **Build XLSX template**, since it's the immediate downstream consumer of a successful config validation: once the configuration is known coherent, the template can be built from it.
