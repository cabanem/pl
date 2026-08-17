Full source absorbed — and reading it changed the plan in ways the skeleton couldn't show. Three design deltas before the edit list, because they're the reasoning you'll want at review time:

**Delta 1 — most raises stay.** The self-check raises (3a–3d: missing lookup, no consuming field, ambiguous parent, cycles) and the two name-resolution raises (rules, variants) describe configs that can't produce a coherent model for *any* channel — cascades drive the XLSX INDIRECT pattern too, not just the form. Those are the "contradictory config" rejections API-00 is allowed to keep. Exactly **two** raises are form-channel-only and convert to viability outcomes: the required-field pool-exhaustion raise (line 332) and the 5b cascade-parent-without-slot raise (line 390). Line 319's vocabulary-drift raise stays — it's a code defect, and raising is correct.

**Delta 2 — closure walks `cascade_parent_field_id`, not `depends_on`.** Phase 1b already resolves lookup names to gating field ids, so the must-fit closure is a walk over that resolved chain. It needs its own cycle guard, though: must-fit computation runs *before* phase 7, so a cyclic config would loop the walk before check 3d gets to raise its good error message.

**Delta 3 — the 5b conversion splits by requiredness, and one branch is a repair.** Parent-without-slot where the dependent is on a required chain → dependency defect → `unavailable`. Where the dependent is *optional* → drop the child's mapping too, record why, `degraded`. Note this second branch is a new capability: today that config raises and can't provision at all.

Also noted while reading: `built_by_recipe: "PRV-02"` is hardcoded, but API-01 already calls CAN-01 — the evidence trail lies today. Optional fix included below. And the SLOT_POOL comment block says "20 slot columns" and "4-slot sel pool" (both stale), but carries one fact worth preserving: `slot_sel_11` is held out for a future multi-select.

---

## CAN-01 change list (exact anchors, v2)

### R — Recipe shell

**R1. Trigger — `parameters_schema_json`.** Append two entries to the existing five-entry array:
```json
{"control_type":"text","label":"slot_capacities","name":"slot_capacities","type":"string","optional":true,
 "hint":"JSON per-family capacities, e.g. {\"text\":10,\"num\":4,\"bool\":2,\"sel\":10,\"date\":4}. Optional; Python defaults match current SUP_SupplierRequest slot columns."},
{"control_type":"text","label":"caller","name":"caller","type":"string","optional":true,
 "hint":"Recipe handle for _meta.built_by_recipe. Optional; defaults to PRV-02."}
```

**R2. Step 2 (py_eval, line id `a614c394`) — `code_input`.** Add matching schema entries (same shape as `expected_sheet_name`'s, `parent: ["code_input","data"]`) and map both `data` keys to trigger pills (line `5324cc25`, path `["parameters","slot_capacities"]` / `["parameters","caller"]`).

**R3. Step 2 — `code_output_schema_json`.** Add two top-level fields:
```json
{"control_type":"text","label":"Form channel status","name":"form_channel_status","type":"string"},
{"control_type":"text","label":"Form channel detail json","name":"form_channel_detail_json","type":"string"}
```
Datapills, not buried JSON: PRV-02 maps `form_channel_detail_json` straight onto the string column with zero formula work, and API-02 pills it into the response.

**R4. Trigger — `result_schema_json`.** Same two fields at top level (beside `canonical_model_json`).

**R5. Step 7 (return_result).** Map both new pills from `a614c394` → `["output","form_channel_status"]` and `["output","form_channel_detail_json"]`.

**R6 (optional). Step 3 logger** currently logs `cfg_form_slot_mappings` with `user_logs_enabled=false`; append the status pill if you ever flip it on. Skippable.

### P — Python (step 2, anchored to the 693-line source)

**P1. Lines 22–36 — replace the SLOT_POOL literal.**
```python
# ----------------------------------------------------------------------------------------------
# SLOT POOL LAYOUT
# ----------------------------------------------------------------------------------------------
# Slot columns on SUP_SupplierRequest, grouped by family. Capacities arrive as input
# (slot_capacities JSON) so PRV-02 / API-01 / API-02 share one truth; DEFAULT_CAPACITIES
# mirrors today's physical columns and applies when the input is absent.
# (slot_sel_11 remains held out for a future multi_select control type.)
DEFAULT_CAPACITIES = {"text": 10, "num": 4, "bool": 2, "sel": 10, "date": 4}

def build_slot_pool(capacities):
    return {fam: ["slot_%s_%02d" % (fam, n) for n in range(1, count + 1)]
            for fam, count in capacities.items()}
```
The prose about optional-drop vs required-raise in the old comment is now wrong both ways; the new behavior is documented at P4. `SLOT_POOL` as a module global is gone — it threads as a parameter (the file's own pure-helper style).

**P2. After line 191 (end of `resolve_cascade_parents`) — new function.**
```python
def build_must_fit(cfg_fields, field_by_id):
    """Required visible fields plus their visible cascade ancestors, walked to root.

    A required dependent cannot render unless its whole gating chain holds slots, so the
    chain joins the must-fit set. Cycle-guarded locally: this runs before the phase-7
    self check, whose 3d raise owns the good error message — the guard here only
    prevents an infinite walk, it does not report.

    Returns (must_fit_ids, defects). Defects here are dependency defects only:
    a required chain that traverses an invisible field is unmappable by construction.
    """
    must_fit, defects = set(), []
    for field in cfg_fields:
        if not (field["required"] and field["visible"]):
            continue
        current, seen = field["field_id"], set()
        while current and current not in seen:
            seen.add(current)
            record = field_by_id.get(current)
            if record is None:
                break
            if not record["visible"]:
                defects.append({
                    "type": "dependency_parent_not_visible",
                    "field_name": field["field_name"],
                    "parent_field_name": record["field_name"],
                })
                break
            must_fit.add(current)
            current = record["cascade_parent_field_id"]
    return must_fit, defects
```

**P3. Lines 294–366 — `assign_form_slots` becomes assignment-preserving two-pass.**
New signature: `assign_form_slots(cfg_fields, slot_pool, must_fit)`. Replace the body's allocation loop with the per-family form:
```python
    from collections import OrderedDict
    by_family = OrderedDict()
    unmapped_control_types = []
    for field in visible_fields:                      # keep lines 306-309 sort exactly
        slot_type = CONTROL_TYPE_TO_SLOT_TYPE.get(field["control_type"])
        if slot_type is None:
            raise ValueError(...)                     # keep the line 319-325 raise verbatim
        by_family.setdefault(slot_type, []).append(field)

    deficits = {}
    for slot_type, fam_fields in by_family.items():
        pool = slot_pool[slot_type]
        if len(fam_fields) <= len(pool):
            ordered = fam_fields                      # fast path: today's order, verbatim
        else:
            must = [f for f in fam_fields if f["field_id"] in must_fit]
            rest = [f for f in fam_fields if f["field_id"] not in must_fit]
            ordered = must + rest                     # both halves keep position order
            if len(must) > len(pool):
                deficits[slot_type] = len(must) - len(pool)
        for field in ordered:
            cursor = slot_pool_cursor[slot_type]
            if cursor >= len(pool):
                fields_without_slots.append({
                    "field_name":   field["field_name"],
                    "control_type": field["control_type"],
                    "required":     field["required"],
                    "reason":       "%s slot pool exhausted (%d slots)" % (slot_type, len(pool)),
                })
                continue
            slot_pool_cursor[slot_type] = cursor + 1
            cfg_form_slot_mappings.append({...})      # dict literal from lines 349-363, unchanged
            # form_position += 1 stays inside the assignment branch
```
Delete the line 330–338 required-field raise entirely. Return becomes `(cfg_form_slot_mappings, slot_pool_cursor, fields_without_slots, deficits)`. Two invariants this preserves: the `<= pool` fast path makes every currently-provisionable config allocate byte-identically, and `form_position` still numbers only assigned slots. One behavior change to know about: a `required` field can now appear in `fields_without_slots` (hence the new `required` key) — it does so exactly when its family has a deficit.

**P4. Lines 372–397 — `resolve_slot_cascades` conversion.**
New signature: `resolve_slot_cascades(cfg_form_slot_mappings, field_by_id, must_fit)`, returning `(surviving_mappings, cascade_defects, cascade_dropped)`. Replace the line 389–396 raise with:
```python
        if parent_slot is None:
            if mapping["field_id"] in must_fit:
                cascade_defects.append({
                    "type": "dependency_parent_unmappable",
                    "field_name": _field_name(field_by_id, mapping["field_id"]),
                    "parent_field_name": _field_name(field_by_id, parent_field_id),
                })
            else:
                cascade_dropped.append({
                    "field_name": _field_name(field_by_id, mapping["field_id"]),
                    "control_type": mapping["control_type"],
                    "required": False,
                    "reason": "cascade parent '%s' holds no form slot"
                              % _field_name(field_by_id, parent_field_id),
                })
                doomed.add(mapping["form_slot_id"])
            continue
```
then `surviving_mappings = [m for m in cfg_form_slot_mappings if m["form_slot_id"] not in doomed]`. The parent's slot stays allocated-but-unused (cursor already advanced) — deliberate: reclaiming it would break assignment determinism against the fast path. Positions keep their gaps; they're ordering keys, not indices.

**P5. After `build_error_messages` (~line 411) — the block builder.**
```python
def build_form_channel(cfg_fields, must_fit, capacities, slot_pool_cursor,
                       fields_without_slots, cascade_dropped, defects):
    per_type = {}
    for fam, cap in capacities.items():
        fam_fields = [f for f in cfg_fields if f["visible"]
                      and CONTROL_TYPE_TO_SLOT_TYPE.get(f["control_type"]) == fam]
        required = sum(1 for f in fam_fields if f["required"])
        in_must  = sum(1 for f in fam_fields if f["field_id"] in must_fit)
        per_type[fam] = {
            "capacity": cap,
            "required": required,
            "closure_added": in_must - required,
            "optional": len(fam_fields) - in_must,
            "allocated": slot_pool_cursor[fam],
            "deficit": 0,   # overwritten below from the deficits dict
        }
    dropped_optional = ([f for f in fields_without_slots if not f.get("required")]
                        + cascade_dropped)
    if defects or any(f.get("required") for f in fields_without_slots):
        status = "unavailable"
    elif dropped_optional:
        status = "degraded"
    else:
        status = "viable"
    return status, {"status": status, "capacities_used": capacities,
                    "per_type": per_type, "dropped_optional": dropped_optional,
                    "defects": defects}
```
(Wire `deficits[fam]` into `per_type[fam]["deficit"]` in main — passing the dict in is fine too; your call on which reads better.)

**P6. `main()` (lines 612–693) — wiring.**
After line 622:
```python
    raw_caps = (input.get("slot_capacities") or "").strip()
    capacities = json.loads(raw_caps) if raw_caps else dict(DEFAULT_CAPACITIES)
    if set(capacities) != set(DEFAULT_CAPACITIES):
        raise ValueError("slot_capacities keys must be exactly "
                         "text/num/bool/sel/date; got %s" % sorted(capacities))
    slot_pool = build_slot_pool(capacities)
    caller = (input.get("caller") or "").strip() or "PRV-02"
```
(The key-mismatch case is a *caller contradiction*, not a config condition — raising is right.) After line 631: `must_fit, dependency_defects = build_must_fit(cfg_fields, field_by_id)`. Lines 641–644 become the new-signature calls, collecting `deficits`, `cascade_defects`, `cascade_dropped`, and reassigning `cfg_form_slot_mappings` to the survivors *before* phase 7 runs. Then `status, form_channel = build_form_channel(...)` with `defects = dependency_defects + cascade_defects`; `meta["form_channel"] = form_channel`; line 662's `"built_by_recipe": "PRV-02"` → `caller`; `summary["form_channel_status"] = status` after line 676's build (or add the param); and the return dict gains:
```python
        "form_channel_status":      status,
        "form_channel_detail_json": json.dumps(form_channel, default=str),
```
Also pass `slot_pool` into `build_summary` (lines 571–573 signature, 598–604 usage) so `slot_pool_usage.available` reflects the input capacities.

### V — Verify (anchored)

1. **Assignment-compat (the release gate):** old vs new `main` over every stored parsed_config for `build_stage` ≥ published; assert `cfg_form_slot_mappings` slot assignments identical (mint UUIDs aside — compare `(field_name, slot_name, position)` triples) and status ∈ {viable, degraded}.
2. 11 required text fields → `unavailable`, `per_type.text.deficit == 1`, no exception.
3. Optional parent + required dependent → both in must-fit, `closure_added ≥ 1`.
4. Required dependent whose parent is `visible: false` → `dependency_parent_not_visible` defect, `unavailable` (fires from must-fit, before allocation).
5. Required text field at position 15 behind 10 optional texts → `viable`, and its slot comes from displacing optionals (fast path *not* taken).
6. Optional dependent, parent dropped by capacity → child absent from mappings, present in `dropped_optional` with the cascade reason, status `degraded` — *this config raises on current code; confirm it now provisions.*
7. `caller` unset → `_meta.built_by_recipe == "PRV-02"`; set to `API-02` → reflected.
8. Same input twice → identical model modulo minted UUIDs and `built_at`.
9. Cyclic cascade config → still raises from check 3d with the chain message (must-fit guard didn't eat it).
10. TPL-02 over a new-format model → identical XLSX.

Test 6 is the one to savor — it's the moment the gate stops being a wall and becomes a report. Ping me with PRV-02 when this lands.
