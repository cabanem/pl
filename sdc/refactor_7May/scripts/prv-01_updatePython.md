# PRV-02 patch — `depends_on` is a lookup name, not a field name

Patches Phase 1, Phase 1b, and Phase 7 of PRV-02's canonical-model builder
to correctly model dependent dropdowns.

## What changes

**Model correction.** A field's `depends_on` value is the *name of another lookup*,
not the name of another field. The field that gates the cascade is inferred:
it's the field whose `lookup_name` matches `depends_on`. The original code
resolved `depends_on` against the field-name map, which produced wrong results
whenever the value was a lookup name that happened not to also be a field name
(every real case).

**Column rename.** `depends_on_field_id` → `cascade_parent_field_id`. The new
name reflects what the column actually holds (the gating field's id, derived
from the cascade structure) and frees `depends_on` as a label for the raw
input column.

**Column add.** `depends_on_lookup_name` is added to `cfg_fields` to preserve
the raw config value. The canonical model is the snapshot audit artifact for
a template version; keeping the literal input alongside the derived field id
costs almost nothing and pays off for debugging and future inference-rule
changes.

**New self-checks.** Phase 7 grows three checks:
1. Every `depends_on_lookup_name` must exist in `cfg_lookups`.
2. Every `depends_on_lookup_name` must have exactly one consuming field
   (i.e., one field with that `lookup_name`) *if* any other field depends on
   it. Multiple consuming fields plus a dependent on the same lookup =
   ambiguous cascade parent = error.
3. Cascade chains must not contain cycles.

## Unified diff against the original

```diff
@@ Phase 1 — Build cfg_fields @@
     cfg_fields = []
     field_name_to_id = {}
+    lookup_name_to_using_field_ids = {}  # built alongside cfg_fields; used in Phase 1b

     for f in parsed_fields:
         fid = str(uuid.uuid4())
         field_name = f.get("field_name")
         field_name_to_id[field_name] = fid
+
+        # Track which field(s) use each lookup_name as their plain-dropdown
+        # source. Phase 1b uses this map to resolve cascade parents.
+        # A list per lookup_name (not a single value) so we can detect the
+        # ambiguous-parent case in Phase 7.
+        lookup_name = f.get("lookup_name")
+        if lookup_name:
+            lookup_name_to_using_field_ids.setdefault(lookup_name, []).append(fid)

         cfg_fields.append({
             "field_id":                  fid,
             "field_name":                field_name,
             # ... (unchanged field assignments) ...
             "lookup_name":               f.get("lookup_name"),
-            "depends_on_field_id":       None,  # resolved in phase 1b
+            "depends_on_lookup_name":    None,  # populated below from raw config
+            "cascade_parent_field_id":   None,  # resolved in phase 1b
             "control_type":              f.get("control_type"),
         })

@@ Phase 1b — Resolve cascade parents @@
-    # Phase 1b — resolve depends_on_field_id from depends_on_field_name.
-    # Done in a second pass so forward references (where the parent field
-    # appears later in the position order) resolve correctly.
+    # Phase 1b — resolve cascade_parent_field_id from depends_on (a lookup name).
+    #
+    # The model: a dependent dropdown's `depends_on` value names a LOOKUP, not a
+    # field. The gating field — the one whose value filters this field's options —
+    # is inferred by finding the field whose `lookup_name` matches `depends_on`.
+    #
+    # Example from a real config:
+    #   Field "Job Title": lookup_name=job_title, depends_on=job_class
+    #   Field "Job Class": lookup_name=job_class, depends_on=country_iso
+    # When the supplier selects a Job Class value, the Job Title dropdown filters
+    # to lookup rows in `job_title` where parent_value matches the selected class.
+    #
+    # Phase 7 validates that the resolution succeeded for every populated
+    # depends_on; here we just resolve what we can and record the raw value.
     for f_record, f_source in zip(cfg_fields, parsed_fields):
-        depends_on_name = f_source.get("depends_on_field_name") or f_source.get("depends_on")
-        if depends_on_name:
-            resolved = field_name_to_id.get(depends_on_name)
-            if resolved is None:
-                raise ValueError(
-                    f"Field '{f_record['field_name']}' depends_on '{depends_on_name}' "
-                    f"but no field with that name exists. CFG-01 should have caught this."
-                )
-            f_record["depends_on_field_id"] = resolved
+        depends_on_lookup = f_source.get("depends_on")
+        if not depends_on_lookup:
+            continue
+
+        f_record["depends_on_lookup_name"] = depends_on_lookup
+
+        # Resolve to the gating field via the lookup_name → field_id map.
+        # If the lookup has multiple consuming fields, pick the first for now;
+        # Phase 7's ambiguous-parent check will raise if this matters.
+        candidates = lookup_name_to_using_field_ids.get(depends_on_lookup, [])
+        if candidates:
+            f_record["cascade_parent_field_id"] = candidates[0]
+        # If no candidates, leave cascade_parent_field_id=None. Phase 7's
+        # missing-parent check produces the error with full context.

@@ Phase 7 — Self-check @@
     # Invariant 1: FK resolution complete on form_slot_mappings.
     for fsm in cfg_form_slot_mappings:
         if fsm["field_id"] not in field_ids_set:
             raise ValueError(
                 f"Form_slot_mapping {fsm['form_slot_id']} field_id unresolved: {fsm['field_id']}"
             )

-    # Invariant 1: depends_on_field_id resolves.
-    for f in cfg_fields:
-        if f["depends_on_field_id"] and f["depends_on_field_id"] not in field_ids_set:
-            raise ValueError(
-                f"Field {f['field_id']} depends_on_field_id unresolved: "
-                f"{f['depends_on_field_id']}"
-            )
+    # Invariant 1: cascade_parent_field_id (when populated) resolves to a known field.
+    for f in cfg_fields:
+        if f["cascade_parent_field_id"] and f["cascade_parent_field_id"] not in field_ids_set:
+            raise ValueError(
+                f"Field {f['field_id']} cascade_parent_field_id unresolved: "
+                f"{f['cascade_parent_field_id']}"
+            )
+
+    # Invariant 3 — Cascade validity (three checks, distinct messages so the
+    # config author can fix the right thing).
+    #
+    # 3a: every depends_on_lookup_name names a lookup that exists in cfg_lookups.
+    for f in cfg_fields:
+        lname = f["depends_on_lookup_name"]
+        if lname and lname not in lookup_names_set:
+            raise ValueError(
+                f"Field '{f['field_name']}' depends_on '{lname}' but no lookup "
+                f"with that name exists in cfg_lookups. Either add the lookup "
+                f"to sheet 5_lookups (Table name = '{lname}') or correct the "
+                f"'Depends on' value in sheet 4_fields for this field."
+            )
+
+    # 3b: every depends_on_lookup_name has at least one consuming field
+    # (a field with lookup_name == depends_on_lookup_name). Without one, there's
+    # no gating field to cascade from.
+    for f in cfg_fields:
+        lname = f["depends_on_lookup_name"]
+        if lname and not lookup_name_to_using_field_ids.get(lname):
+            raise ValueError(
+                f"Field '{f['field_name']}' depends_on lookup '{lname}', but no "
+                f"field uses '{lname}' as its 'Lookup name' (sheet 4_fields, "
+                f"column 'Lookup name'). The cascade has no gating field. "
+                f"Either add a field that uses '{lname}' as its lookup, or "
+                f"change this field's 'Depends on' to a lookup that does have "
+                f"a consuming field."
+            )
+
+    # 3c: ambiguous-parent check. If multiple fields use the same lookup_name
+    # AND any other field depends on that lookup, the cascade parent is
+    # ambiguous — the canonical model can't know which sibling's value gates
+    # the dependent. The pure case (multiple consumers, no dependent) is fine;
+    # the error only fires when the ambiguity would matter at runtime.
+    for lname, using_fids in lookup_name_to_using_field_ids.items():
+        if len(using_fids) < 2:
+            continue
+        dependents = [f for f in cfg_fields if f["depends_on_lookup_name"] == lname]
+        if dependents:
+            using_field_names = [
+                next(f["field_name"] for f in cfg_fields if f["field_id"] == fid)
+                for fid in using_fids
+            ]
+            dependent_names = [f["field_name"] for f in dependents]
+            raise ValueError(
+                f"Ambiguous cascade parent: lookup '{lname}' is used by multiple "
+                f"fields ({using_field_names}) AND is the cascade source for "
+                f"other fields ({dependent_names}). Cannot determine which of "
+                f"the consuming fields gates the cascade. Either consolidate to "
+                f"a single consuming field, or split '{lname}' into distinct "
+                f"per-role lookups."
+            )
+
+    # 3d: cycle detection on the cascade graph. A field whose cascade chain
+    # eventually points back at itself is broken — the form can't render.
+    # Walk each field's cascade chain; raise if we revisit a field.
+    for f in cfg_fields:
+        if not f["cascade_parent_field_id"]:
+            continue
+        visited = [f["field_id"]]
+        current = f["cascade_parent_field_id"]
+        while current:
+            if current in visited:
+                chain = " → ".join(
+                    next(ff["field_name"] for ff in cfg_fields if ff["field_id"] == fid)
+                    for fid in visited + [current]
+                )
+                raise ValueError(
+                    f"Cascade cycle detected starting at field "
+                    f"'{f['field_name']}': {chain}. Remove the cycle by "
+                    f"correcting one field's 'Depends on' value."
+                )
+            visited.append(current)
+            parent_record = next(
+                (ff for ff in cfg_fields if ff["field_id"] == current),
+                None,
+            )
+            current = parent_record["cascade_parent_field_id"] if parent_record else None
```

## Full revised functions

If you'd rather drop in the corrected sections wholesale, here they are.

### Phase 1 — Build cfg_fields (revised)

```python
# ──────────────────────────────────────────────────────────────────
# Phase 1 — Build cfg_fields
# ──────────────────────────────────────────────────────────────────
# Mint a UUID per field. Build two maps as we go:
#   - field_name_to_id: for any future field-name → field-id resolution.
#   - lookup_name_to_using_field_ids: for Phase 1b's cascade-parent resolution.
#     Keyed by lookup_name, values are lists of field_ids that use it. A list
#     (not a single value) so Phase 7 can detect the ambiguous-parent case.

cfg_fields = []
field_name_to_id = {}
lookup_name_to_using_field_ids = {}

for f in parsed_fields:
    fid = str(uuid.uuid4())
    field_name = f.get("field_name")
    field_name_to_id[field_name] = fid

    lookup_name = f.get("lookup_name")
    if lookup_name:
        lookup_name_to_using_field_ids.setdefault(lookup_name, []).append(fid)

    cfg_fields.append({
        "field_id":                  fid,
        "field_name":                field_name,
        "description":               f.get("description"),
        "data_type":                 f.get("data_type"),
        "data_format":               f.get("data_format"),
        "position":                  f.get("position"),
        "required":                  bool(f.get("required", False)),
        "must_be_empty":             bool(f.get("must_be_empty", False)),
        "column_unique":             bool(f.get("column_unique", False)),
        "strict":                    bool(f.get("strict", False)),
        "visible":                   bool(f.get("visible", True)),
        "field_length_validation":   f.get("field_length_validation"),
        "numeric_field_validation":  f.get("numeric_field_validation"),
        "date_field_validation":     f.get("date_field_validation"),
        "field_input_validation":    f.get("field_input_validation"),
        "data_cleaning_flags":       f.get("data_cleaning_flags"),
        "lookup_name":               lookup_name,
        "depends_on_lookup_name":    None,  # populated in phase 1b from raw config
        "cascade_parent_field_id":   None,  # resolved in phase 1b
        "control_type":              f.get("control_type"),
    })
```

### Phase 1b — Resolve cascade parents (revised)

```python
# ──────────────────────────────────────────────────────────────────
# Phase 1b — Resolve cascade parents
# ──────────────────────────────────────────────────────────────────
# A dependent dropdown's `depends_on` value names a LOOKUP, not a field. The
# gating field — the one whose value filters this field's options — is
# inferred by finding the field whose `lookup_name` matches `depends_on`.
#
# Example from a real master config:
#   Field "Job Title": lookup_name=job_title, depends_on=job_class
#   Field "Job Class": lookup_name=job_class, depends_on=country_iso
# When the supplier selects a Job Class value, the Job Title dropdown filters
# to lookup rows in `job_title` where parent_value matches the selected class.
#
# Resolution is one-hop here; chains form naturally by following multiple hops.
# Phase 7 validates that the resolution succeeded and that the chain has no
# cycles.
#
# If `depends_on` names a lookup with multiple consuming fields, the first
# is recorded here. Phase 7's ambiguous-parent check fires if that ambiguity
# would matter (i.e., the multi-consumer lookup is also somebody's cascade
# source).

for f_record, f_source in zip(cfg_fields, parsed_fields):
    depends_on_lookup = f_source.get("depends_on")
    if not depends_on_lookup:
        continue

    f_record["depends_on_lookup_name"] = depends_on_lookup

    candidates = lookup_name_to_using_field_ids.get(depends_on_lookup, [])
    if candidates:
        f_record["cascade_parent_field_id"] = candidates[0]
    # If no candidates, leave cascade_parent_field_id=None.
    # Phase 7's missing-parent check raises with full context.
```

### Phase 7 — Self-check (revised section only; other checks unchanged)

Replace the original "Invariant 1: depends_on_field_id resolves" block with:

```python
    # Invariant 1 (cascade): cascade_parent_field_id (when populated) resolves
    # to a known field. Defensive — Phase 1b only populates from the map of
    # known field ids, so this should never fire; kept for symmetry with the
    # other FK checks.
    for f in cfg_fields:
        if f["cascade_parent_field_id"] and f["cascade_parent_field_id"] not in field_ids_set:
            raise ValueError(
                f"Field {f['field_id']} cascade_parent_field_id unresolved: "
                f"{f['cascade_parent_field_id']}"
            )

    # Invariant 3a (cascade): every depends_on_lookup_name names a lookup
    # that exists in cfg_lookups.
    for f in cfg_fields:
        lname = f["depends_on_lookup_name"]
        if lname and lname not in lookup_names_set:
            raise ValueError(
                f"Field '{f['field_name']}' depends_on '{lname}' but no lookup "
                f"with that name exists in cfg_lookups. Either add the lookup "
                f"to sheet 5_lookups (Table name = '{lname}') or correct the "
                f"'Depends on' value in sheet 4_fields for this field."
            )

    # Invariant 3b (cascade): every depends_on_lookup_name has at least one
    # consuming field (a field with lookup_name == depends_on_lookup_name).
    # Without one, there's no gating field to cascade from.
    for f in cfg_fields:
        lname = f["depends_on_lookup_name"]
        if lname and not lookup_name_to_using_field_ids.get(lname):
            raise ValueError(
                f"Field '{f['field_name']}' depends_on lookup '{lname}', but no "
                f"field uses '{lname}' as its 'Lookup name' (sheet 4_fields, "
                f"column 'Lookup name'). The cascade has no gating field. "
                f"Either add a field that uses '{lname}' as its lookup, or "
                f"change this field's 'Depends on' to a lookup that does have "
                f"a consuming field."
            )

    # Invariant 3c (cascade): ambiguous-parent check. If multiple fields use
    # the same lookup_name AND any other field depends on that lookup, the
    # cascade parent is ambiguous — the canonical model can't know which
    # sibling's value gates the dependent. The pure case (multiple consumers
    # of one lookup, but no dependent on it) is fine; the error only fires
    # when the ambiguity would matter at runtime.
    for lname, using_fids in lookup_name_to_using_field_ids.items():
        if len(using_fids) < 2:
            continue
        dependents = [f for f in cfg_fields if f["depends_on_lookup_name"] == lname]
        if dependents:
            using_field_names = [
                next(f["field_name"] for f in cfg_fields if f["field_id"] == fid)
                for fid in using_fids
            ]
            dependent_names = [f["field_name"] for f in dependents]
            raise ValueError(
                f"Ambiguous cascade parent: lookup '{lname}' is used by multiple "
                f"fields ({using_field_names}) AND is the cascade source for "
                f"other fields ({dependent_names}). Cannot determine which of "
                f"the consuming fields gates the cascade. Either consolidate to "
                f"a single consuming field, or split '{lname}' into distinct "
                f"per-role lookups."
            )

    # Invariant 3d (cascade): cycle detection. A field whose cascade chain
    # eventually points back at itself is broken — the form can't render.
    for f in cfg_fields:
        if not f["cascade_parent_field_id"]:
            continue
        visited = [f["field_id"]]
        current = f["cascade_parent_field_id"]
        while current:
            if current in visited:
                chain = " → ".join(
                    next(ff["field_name"] for ff in cfg_fields if ff["field_id"] == fid)
                    for fid in visited + [current]
                )
                raise ValueError(
                    f"Cascade cycle detected starting at field "
                    f"'{f['field_name']}': {chain}. Remove the cycle by "
                    f"correcting one field's 'Depends on' value."
                )
            visited.append(current)
            parent_record = next(
                (ff for ff in cfg_fields if ff["field_id"] == current),
                None,
            )
            current = parent_record["cascade_parent_field_id"] if parent_record else None
```

## Notes on what didn't change

The original code had a fallback `f_source.get("depends_on_field_name") or f_source.get("depends_on")`. The `depends_on_field_name` alias appears to come from an older parser version that named the column differently. Removing the alias is intentional — there's only one real column, and supporting two names invites the next reader to wonder which is canonical. If the parser still emits both keys for some configs, the parser should be updated to emit only `depends_on`.

The `cfg_form_slot_mappings` table is unchanged. Slot assignment doesn't care about cascade relationships; the WFA renders the dependent dropdown using the cascade_parent_field_id at form-load time.

VAL-01 will also need to learn the new column shape if it consults the cascade. Worth a separate check on VAL-01's canonical-model consumer code; the field name change (`depends_on_field_id` → `cascade_parent_field_id`) is a breaking rename. If VAL-01 doesn't actually use the cascade for validation (cascading is a UX-shaping concern, not a validity-checking one), there's nothing to update.

## Worth flagging upstream

This patch fixes PRV-02, but the parser that produces `parsed_config_json` is what reads master-config sheets and emits the `depends_on` key. Worth confirming the parser already treats column 11 of `4_fields` as the lookup-name reference (not as a field-name reference). If the parser is also confused, the upstream fix is to make the parser preserve column 11 verbatim into a `depends_on` key with no transformation, and let PRV-02 own the cascade-resolution logic. From the existing code's expectations (`f.get("depends_on")` directly), it looks like the parser is doing the right thing — the bug was purely in PRV-02's interpretation. But worth a spot-check.

## Worth flagging downstream

The MARS config has cascade chains two hops deep (`Worker's Location` → `wk_city` → `country_iso`). The canonical model stores only the one-hop link; consumers (WFA form, VAL-01 if it ever needs the chain) walk the chain at runtime. The cycle-detection code in 3d also walks the chain, so it naturally handles arbitrary depth. No code change needed for deeper chains — the model and the validation both already support them.
