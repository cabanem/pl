# SDC Data Collection — Capability Deep Dive: Build XLSX Template (v1, Phase 0)

## Status

Second of four per-capability plain-language deep dives. Companion to the workflow inventory, the data model, the stage-by-stage workflow document, and the first deep dive (Validate config).

Where Validate config is a pure-inspection capability — it reads a configuration and returns a verdict — Build XLSX template is a pure-construction capability: it reads an already-validated configuration and returns a file. The two are paired. Validate config is the gate that decides whether Build template will be asked to run; Build template is one of the things that gate exists to protect.

---

## Intent

Take a validated template version (or one of its variants) and produce the master XLSX workbook a supplier will fill in.

---

## Where it's called from

- **Initial provisioning (E1, after the configuration is validated and the new version is published).** Once per variant the version defines. If the version has no variants, once for the base case.
- **Config update (E2, after the new version is validated and published).** Same pattern — once per variant on the new version. The previous version's templates are not regenerated; in-flight suppliers stay on the file they were originally given.

In both callsites this capability is called from inside a loop over variants. From the loop's perspective, this capability looks like: *give me one variant's worth of configuration, hand me back one file.*

There is no callsite that asks for "all variants in one workbook." Each variant is its own file.

---

## What goes in

The capability needs three things, in plain language:

1. **The validated configuration of a single template version.** This is the shape of what the supplier will be asked to provide:
   - The set of fields the supplier should see, with their display names, data types, formats, positions, required flags, and any lookup or parent relationships.
   - The set of lookup values for any field that should be a dropdown — both flat lookups (one parent-less list) and dependent lookups (a list of children grouped by parent value).
   - Any cross-field rules that can be enforced inside the workbook itself (for example, "this column must be filled in only if that other column equals X"). Most rules will be re-checked later when the supplier submits, but some are usefully expressed in the file as data validation so the supplier sees the constraint immediately.
   - The error-message text the supplier should see when they violate a rule, where that text is meant to surface in the workbook itself.

2. **A variant identifier — or the explicit "no variant" signal.** The variant identifier names which subset of the version's fields belongs in this file. "No variant" means: include every field the version defines. With variants, each call sees only the fields that variant claims plus any common fields the version marks as always-included.

3. **A small amount of context for labelling the file.** The client name and the variant name are used to compose the workbook's filename and may appear in a header on the data entry sheet.

The capability assumes the configuration handed to it has already passed validation. It does not re-check that lookup names resolve, that parent fields exist, that dependencies are acyclic, or any of the other things Validate config exists to guarantee. If those guarantees aren't true, this capability will produce a broken file or fail mid-build — but it won't notice the underlying configuration problem on its own.

---

## What comes out

**Success:** a single XLSX workbook, returned as bytes (in-memory, ready to be handed to the caller for storage). The workbook contains:

- A **data entry sheet** — the visible sheet the supplier types into. Columns ordered by position, headers formatted, dropdowns wired up, frozen header row.
- A **reference sheet** — hidden by default, holding the lookup values the dropdowns reference. For flat lookups it's a single column per lookup; for dependent lookups it's one column per parent value, named so a formula can find it by parent.
- **Data validation rules** on the data entry sheet's columns — a flat dropdown for simple lookups, an indirect-resolved dropdown for dependent lookups (the child column reads its parent cell, looks up the matching column in the reference sheet, and offers those values), and where useful, type-and-format validation (date format, numeric range) on columns that have those constraints.
- A suggested **filename** — derived from the variant name (or the word "base" when there's no variant).

The capability itself does not store the file. It hands the bytes back; the caller is responsible for putting them somewhere durable and recording where it put them.

**Failure:** a structured error that names which substage failed and why. No partial file is returned — either the bytes are complete and well-formed, or the call failed and the caller decides how to react. The caller's most important branch is "did the build succeed at all" — partial files are not a state this capability produces.

---

## What it does — substages

1. **Resolve the field list for this variant.** Filter the version's full field list down to the fields this variant claims, plus any always-included fields. Sort by position. The result is the list of columns the data entry sheet will have, in order.

2. **Resolve the lookups needed.** Walk the resolved field list. For each field that points at a lookup, collect the values for that lookup. For each lookup that's dependent (has a parent), collect the values *grouped by parent value*.

3. **Lay out the reference sheet.** Decide which lookup values go where on the hidden sheet. For each flat lookup, allocate a column. For each dependent lookup, allocate one column per parent value (so every parent value's children sit in their own column). Give each column a name a formula can address.

4. **Create the workbook in memory.** Two sheets: the data entry sheet (visible) and the reference sheet (hidden). No file on disk yet.

5. **Write the data entry sheet's header row.** Display names, formatted, frozen so the supplier can scroll without losing context. Optionally a banner row above the headers showing project / client / variant name.

6. **Write the reference sheet's content.** The lookup values, in the layout decided in step 3. Done before validation rules are applied so the rules have something to point at.

7. **Apply the data validation rules.**
   - Flat dropdown: the column gets a list-validation that points at the corresponding column on the reference sheet.
   - Dependent dropdown: the column gets a list-validation that uses an indirect-resolution formula. The formula reads the parent column's cell on the same row, sanitizes that value into a column name, and points at that column on the reference sheet. The same sanitization rule (spaces and special characters → underscores) must be used both when the reference sheet's columns are named and when the formula resolves them, or the dropdown silently goes blank.
   - Type-and-format rules: applied where the field's type implies a constraint (date format, numeric range, length cap).

8. **Apply column-level formatting.** Column widths reasonable for the field's data type, header styling, any conditional formatting the configuration calls for.

9. **Serialize the workbook to bytes.** In memory, no temporary file on disk. The result is what gets handed back.

10. **Return.** The bytes, plus the suggested filename and any small metadata the caller asked for (e.g., sheet names, size).

The substages above are listed in the order they have to run for the file to come out coherent. Steps 1–3 are pure resolution — no workbook exists yet. Steps 4–8 build the workbook. Steps 9–10 hand it back.

---

## Edge cases & open questions

**Empty variant.** A variant with zero claimed fields produces a workbook with header row only and no data entry columns. Probably not what anyone wants. Caller-side decision: should an empty variant be a Validate config error, or should it produce a zero-column file that someone notices later? *Connects to the "Empty edge cases" open question carried over from Validate config.*

**Special characters in parent values.** A parent value of `R&D` or `IT/Security` is fine in human terms and fine as a cell value. But the reference sheet's columns can't be named with arbitrary characters — they have to be sanitized. The sanitization rule used to name the columns and the sanitization rule used inside the indirect-resolving formula must match exactly, or selecting `R&D` in the parent column resolves to a column name that doesn't exist and the child dropdown goes blank. This is a known historical bug pattern and the rule needs to be one shared definition, not two parallel ones.

**Orphan fields.** A field that exists in the version but is not claimed by any variant has no callsite. Not technically broken, but probably a misconfiguration. *Validate config's job to catch.*

**Dependent dropdowns whose parent isn't in the same variant.** If a variant claims a child field but not its parent, the child's dropdown has nothing to depend on. Same answer: Validate config should catch.

**Cross-version compatibility.** When a config is republished and a new version's templates are built, the previous version's already-issued files are not touched. In-flight suppliers keep filling in the file they were originally given. This is the right default behaviour for a single supplier mid-cycle, but it means the file the supplier is filling in can drift from the latest configuration. *Connects to the "Cross-version compatibility checks" open question.*

**File regeneration on link expiry.** Where the file is stored, the shareable link the supplier uses to download it has a fixed lifetime. Refreshing that link does not require regenerating the file — the file itself is unchanged. So the future reminder workflow that re-issues stale links is not a callsite for this capability.

**Static reference content vs. dynamic.** It is unsettled whether this capability also writes a "Read me" or "Instructions" sheet, with content that's the same across all suppliers (header text, contact info, glossary), or whether that's a separate concern. Currently treated as in scope but trivial — if the configuration provides instruction text, this capability writes it; if not, it skips.

**Pre-filled rows.** A separate capability seeds prior-row data for resubmission or rework cycles. That capability runs *after* this one, against the file this one produced. Build XLSX template itself does not seed any rows — it produces an empty data area. *See "What it deliberately does not do."*

**Filename collisions.** If the caller stores files by a path that depends only on variant name, a republish would overwrite the previous version's file. That's a caller-side concern (the storage path should include the version), not a Build template concern.

---

## What it deliberately does not do

- **Does not store the file.** Hands bytes back; the caller stores.
- **Does not register the file in the database.** Whatever record needs to know "this variant's template lives at this path" is the caller's responsibility to write.
- **Does not seed prior-row data.** A different capability does that, against the workbook this one produces. The split exists because seeding is conditional (only happens for resubmission or late entry) and changes between cycles, while the empty template itself is stable for the version's lifetime.
- **Does not validate the configuration.** Assumes the configuration was already validated. If something is broken, this capability fails or produces a broken file; it does not diagnose.
- **Does not invite suppliers.** The fact that a template now exists is not by itself an invitation. A separate capability turns existing files plus existing supplier records into actual outreach.
- **Does not validate supplier input.** The data validation embedded in the workbook is a supplier-facing convenience, not the system of record. The real validation runs server-side when the supplier submits, against the same configuration, and is the only validation whose verdict the system trusts.
- **Does not generate all variants at once.** One call, one variant, one file. The loop over variants lives in the caller.
- **Does not refresh expired download links.** Storage-layer concern, not a build-time concern. The same file can be re-linked without being regenerated.

---

## Inputs / outputs at a glance

| | Shape |
|---|---|
| **In: configuration** | The fields, lookups, rules, and error-text from one validated template version. |
| **In: variant identifier** | Which variant within that version to build for, or "no variant" for the base case. |
| **In: labelling context** | Client name, variant name (used for filename and header banner). |
| **Out (success)** | XLSX bytes, in memory, plus a suggested filename and small metadata. Caller stores. |
| **Out (failure)** | Structured error naming the failed substage. No partial file. |
| **Side effects** | None. Pure construction. |
| **Idempotent?** | Yes — same input produces the same bytes. Useful property: a regeneration produces the same file the original did. |

---

## Where this leaves us

Two of the four deep dives are now done. The remaining two — **Invite supplier users** and **Validate supplier input** — both depend on this one in different ways. Invite supplier users assumes a stored file with a shareable link; Validate supplier input enforces the same configuration this capability rendered into the file. Worth keeping in view as we move on:

- The **filename / storage-path convention** decided here (or punted to the caller) constrains what Invite supplier users does with the link.
- The **data validation that's embedded in the file** is supplier-facing only — the authoritative validation lives in Validate supplier input, against the same configuration. Any drift between the two is a bug class to watch for.
- The **variant-per-file** decision means Invite supplier users has to know which variant a given supplier is on before it can hand them a link.

Open items still alive after this pass, carried forward to the next deep dive:

- Empty edge cases (added: empty variant after field filtering).
- Cross-version compatibility (added: file drift for in-flight suppliers when a new version is published).
- Special-character handling in parent values for dependent dropdowns — needs to be one shared sanitization rule, not two parallel ones.
- The instruction / "Read me" sheet question — in scope or separate concern?
