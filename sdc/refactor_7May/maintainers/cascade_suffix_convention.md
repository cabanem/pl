# Cascade suffix convention (`~`) — specification and enforcement

Reviewed against `validate_config`, `parse_lookups_sheet`, and the live
`5_lookups` data (3,420 rows, v0.9.7).

---

## 1. The convention

When a lookup's values would otherwise collide across different parents, the
authored value carries a disambiguating suffix:

```
country_iso   value "Belgium"                  parent  (none)
job_class     value "Finance~UK"               parent  "United Kingdom"
job_title     value "Accounting B3-I"          parent  "Finance~UK"
```

Live usage: 69 `job_class` values carry `~`; 3,187 `job_title` rows reference
them as parents. No other table uses the character.

**The invariant that matters:** a suffixed value maps to exactly one
`parent_value`. Verified — zero violations across the corpus.

**The suffix content is opaque.** It is a mnemonic, not a key. The data proves
this: 12 `job_class` rows are suffixed `~NL` while `country_iso` codes the
Netherlands as `NE`. Nothing breaks, because `job_title` references the
job_class *value* (`Finance~NL`), which exists. Any future check or join that
assumes the suffix encodes the parent will break on exactly these 12 rows.
Treat the suffix as an opaque uniquifier and the convention is sound.

*(Separate data note: `NE` is Niger's ISO code; the Netherlands is `NL`. The
`Code` column is currently unread by the connector, so this is latent, not
active.)*

---

## 2. Why it already works — the thing worth not breaking

`validate_config` **never sees the `~`.** Every cascade check is plain string
equality between a child's `parent_value` and the parent lookup's
`valid_value`:

```ruby
child_rows.reject { |l| l["parent_value"].blank? }
          .reject { |l| parent_set.include?(l["parent_value"]) }
```

`"Finance~UK"` is a member of `parent_set` because it *is* a job_class value.
The convention works by making values unique **within the existing
string-equality model**, so it needs no special-casing anywhere: not in the
parser, not in validation, not in CAN-01, not in the options recipe, not in
VAL-01.

That is the whole argument for keeping it.

---

## 3. Keep vs. change

| | Keep `~` | Move to a `parent_path` column |
|---|---|---|
| **Connector** | no change | `parse_lookups_sheet` reads a new column; `cascade_parent_values_populated` and `cascade_parent_has_children` become path-aware |
| **Canonical model** | no change | CAN-01 carries paths; Phase 7 cascade checks change |
| **Tables** | no change | `CFG_Lookup.parent_path`; PRV-03 projection |
| **Runtime** | no change | options recipe walks the ancestor chain and joins; VAL-01 membership check changes |
| **Analyst** | authors a suffix per colliding value (already habitual) | authors `US\|Engineering` paths; migration for 3,187 rows |
| **Supplier** | sees `Finance~UK` | sees `Finance` |
| **Depth limit** | none | none |

**Recommendation: keep.** Six layers change for one cosmetic gain, and the
cosmetic gain is available anyway (§5). The convention is battle-tested on
3,187 rows and is invisible to every consumer.

Worth noting for the user-perspective question: suppliers **already** see
`Finance~UK` in the XLSX template today. The form matching that is consistency,
not regression. Improving it (§5) improves both channels or neither.

---

## 4. Checks to add to `validate_config`

Three gaps found. Each is a real config state that passes today and produces a
broken form.

### 4a. `cascade_suffix_disambiguates` (fail)

The load-bearing invariant, currently unenforced. If a suffixed value ever
appears under two parents, the suffix has stopped doing its job and the
cascade silently merges two branches.

```ruby
# A suffixed value must resolve to exactly one parent. This is the invariant
# the '~' convention exists to maintain; nothing else enforces it.
suffix_collisions = lookups
  .select { |l| l["valid_value"].to_s.include?(CASCADE_SUFFIX_DELIM) }
  .group_by { |l| [l["lookup_name"], l["valid_value"]] }
  .select { |_, group| group.map { |l| l["parent_value"] }.compact.uniq.size > 1 }
  .map do |(ln, val), group|
    parents = group.map { |l| l["parent_value"] }.compact.uniq
    { "entity" => "lookup", "name" => ln,
      "issue"  => "value '#{val}' appears under #{parents.size} parents " \
                  "(#{parents.join(', ')}). The '#{CASCADE_SUFFIX_DELIM}' suffix " \
                  "exists to make each value unique to one parent; give these " \
                  "rows distinct suffixes." }
  end

checks << {
  "check_name" => "cascade_suffix_disambiguates",
  "status"     => suffix_collisions.empty? ? "pass" : "fail",
  "message"    => suffix_collisions.empty? ?
                    "Suffixed lookup values each resolve to one parent" :
                    "#{suffix_collisions.size} suffixed value(s) span multiple parents",
  "details"    => suffix_collisions
}
```

### 4b. `plain_dropdown_lookup_has_root_values` (warn)

**Live example: "MSP/outsourced worker."** It is `data_format = dropdown` (not
dependent) bound to `worker_type` — but all 21 `worker_type` rows carry a
`parent_value`, so a root query returns nothing and the supplier gets an empty
dropdown. `cascade_parent_values_populated` skips it (that check only runs for
`dropdown (dependent)`), and `lookup_has_values` passes (there *are* values).
Nothing catches it.

Note "Resource Type" is the dependent twin of the same lookup — gated on
`country_iso`, but hidden. This looks like the visible field should have been
the dependent one.

```ruby
# A plain dropdown whose lookup has no unparented rows renders empty.
flat_dropdown_issues = fields
  .select { |f| f["data_format"].to_s == "dropdown" && f["lookup_name"].present? }
  .reject { |f| (lookup_rows_by_name[f["lookup_name"]] || [])
                  .any? { |l| l["parent_value"].blank? } }
  .map do |f|
    ln = f["lookup_name"]
    distinct = (lookup_rows_by_name[ln] || []).map { |l| l["valid_value"] }.uniq.size
    { "entity" => "field", "name" => f["field_name"],
      "issue"  => "plain dropdown bound to '#{ln}', but every row in that lookup " \
                  "carries a parent_value. The field renders empty unless the " \
                  "options are flattened (#{distinct} distinct value(s)). Either " \
                  "set data_format to 'dropdown (dependent)' with the correct " \
                  "'Depends on', or add unparented rows." }
  end

checks << {
  "check_name" => "plain_dropdown_lookup_has_root_values",
  "status"     => flat_dropdown_issues.empty? ? "pass" : "warn",
  "message"    => flat_dropdown_issues.empty? ?
                    "All plain dropdowns have unparented lookup values" :
                    "#{flat_dropdown_issues.size} plain dropdown(s) bound to fully-parented lookups",
  "details"    => flat_dropdown_issues
}
```

**Companion runtime rule (required either way):** the options recipe must
define behavior for this case. Recommended — when a *non-dependent* slot's
lookup has no root rows, return the distinct values across all parents
(deduped) rather than an empty list. Degrades gracefully; the warning above is
what prompts the config fix.

### 4c. `form_field_limit` → per-slot-type capacity

The current check is a flat 20 visible fields. The real constraint is per pool:
`SUP_SupplierRequest` now carries 10 text, 4 num, 2 bool, 10 sel (+1
multi-select), 4 date. A template can sit well under 20 fields and still not
fit — six dates against four date slots, for instance.

REDACTED today: 9 visible lookup-backed fields against 10 sel slots. Fits, with one
spare. Tight enough to be worth measuring rather than assuming.

Replace the flat count with a per-type tally using the same
control-type → slot-type mapping CAN-01 uses, and report each pool separately.

---

## 5. Display: keeping the value, losing the suffix

`Label` is empty on all 3,420 rows, so suppliers see `Finance~UK` verbatim.
Since `~` appears only in `job_class`, splitting is safe:

```
stored value:  "Finance~UK"     ← what VAL-01 validates against, unchanged
display label: "Finance"        ← what the supplier sees
```

Two prerequisites, both small:

1. `CFG_Lookup` needs a `display_label` column, and PRV-03 must stop dropping
   it (`parse_lookups_sheet` already parses it; the manifest has no column, so
   it's discarded at persistence).
2. The options recipe returns `{value, label}` pairs, deriving the label when
   `display_label` is blank:
   `value.split(CASCADE_SUFFIX_DELIM, 1)[0]`.

**Do not store the stripped value.** VAL-01 membership is against
`valid_value`; storing `Finance` would fail validation. Value and label are
distinct all the way through.

No ambiguity is introduced in the visible list — it is already filtered to one
parent, so only one `Finance~*` can appear at a time.

---

## 6. The delimiter constant

`~` currently exists only as an authoring habit. It must become one named
constant, referenced by:

- the connector (`parse_lookups_sheet`, `validate_config`)
- CAN-01 (if any suffix-aware logic lands there)
- the WFA options recipe (label derivation)
- VAL-01 (only if it ever needs to strip; today it should not)

```ruby
CASCADE_SUFFIX_DELIM = "~".freeze
```

A mismatch between copies produces empty dropdowns with no error, which is the
failure mode this whole system keeps rediscovering.

**Analyst-facing documentation** belongs in the workbook — a note in the
`5_lookups` header block (row 3 already carries guidance text) and in
`.user_guide`. State the rule as: *when the same value can appear under more
than one parent, append `~` and a short discriminator, and use the full
suffixed value as the child's Parent value.*

---

## 7. Unrelated defect found in review: `control_type` vocabulary mismatch

The connector's `resolve_form_control_type` returns **`select`**;
`CONTROL_TYPE_TO_SLOT_TYPE` in CAN-01 expects **`dropdown`**. If that helper is
ever wired into the canonical model, every plain dropdown raises the
drift-detector.

More immediately, my CAN-01 `_resolve_control_type` guessed at the type
vocabulary. The real one, from `parse_fields_sheet`, is:

- `data_type`: `boolean | date | float (2) | integer | string | none`
- `data_format`: `dropdown | dropdown (dependent) | email address | currency |
  percentage | date (YYYY-MM-DD)` (or blank)

Corrected — `float (2)` and `email address` were both being missed:

```python
def _resolve_control_type(f):
    """Derive control type from the vocabulary the parser actually emits.

    data_format is authoritative where it names a control; lookup presence
    covers fields with a lookup but no declared format; data_type is the
    fallback.
    """
    data_format = (f.get("data_format") or "").strip().lower()
    if data_format == "dropdown (dependent)":
        return "dependent_select"
    if data_format == "dropdown":
        return "dropdown"
    if data_format == "email address":
        return "email"
    if data_format == "currency":
        return "currency"
    if data_format == "percentage":
        return "number"
    if data_format == "date (yyyy-mm-dd)":
        return "date"

    if (f.get("lookup_name") or "").strip():
        return "dependent_select" if _depends_on_value(f) else "dropdown"

    data_type = (f.get("data_type") or "").strip().lower()
    if data_type == "boolean":
        return "checkbox"
    if data_type == "date":
        return "date"
    if data_type in ("integer", "float (2)"):
        return "number"
    return "text"          # string, none, unknown
```

Live check against REDACTED's 20 visible fields: 5 `dropdown`, 4
`dependent_select`, 1 `email`, 1 `date`, 9 falling to `text` — matching the
`data_format` distribution in the config.

One gap this leaves: a field with `data_format = dropdown` *and* a
`Depends on` value is a config error that nothing currently flags
(`dependent_dropdown_has_parent` only inspects
`data_format = "dropdown (dependent)"`). Worth a fourth check if it ever
appears in practice.
