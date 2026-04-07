# ── Phase 7: Form slot assignment ────────────────────────────

SLOT_POOL = {
    "text":             [f"text_{i:02d}" for i in range(1, 9)],
    "email":            [f"text_{i:02d}" for i in range(1, 9)],   # shares text slots
    "number":           [f"num_{i:02d}" for i in range(1, 4)],
    "currency":         [f"num_{i:02d}" for i in range(1, 4)],    # shares number slots
    "date":             [f"date_{i:02d}" for i in range(1, 4)],
    "select":           [f"sel_{i:02d}" for i in range(1, 5)],
    "dependent_select": [f"sel_{i:02d}" for i in range(1, 5)],    # shares select slots
    "checkbox":         [f"chk_{i:02d}" for i in range(1, 3)],
}

# Track which slots have been claimed
claimed = set()
cfg_form_slots = []
slot_warnings = []

visible_fields = sorted(
    [f for f in cfg_fields if f.get("visible")],
    key=lambda f: f.get("position", 999)
)

for f in visible_fields:
    ct = f.get("control_type", "text")
    pool = SLOT_POOL.get(ct, SLOT_POOL["text"])

    assigned = None
    for candidate in pool:
        if candidate not in claimed:
            assigned = candidate
            claimed.add(candidate)
            break

    if assigned is None:
        slot_warnings.append(f"No slot available for {f['field_name']} (type: {ct})")
        continue

    cfg_form_slots.append({
        "form_slot_id":         gen_id(),
        "template_version_id":  tv_id,
        "field_id":             f["field_id"],
        "field_name":           f["field_name"],
        "slot_name":            assigned,
        "control_type":         ct,
        "required":             f.get("required", False),
        "lookup_name":          f.get("lookup_name"),
        "position":             f.get("position", 0),
    })
