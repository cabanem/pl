# SDC form renderer — input contract v1.0

**Function under contract:**

```python
def render(config: dict, values: dict, errors: dict) -> str:
    """Pure function. Config + state in, complete HTML document out.
    No I/O, no clock, no randomness. Raises RenderContractError on
    invariant violations; never raises on bad *data* (that is VAL-01's job)."""
```

This document is simultaneously: (1) the renderer's spec, (2) the submit
endpoint's error-output schema, (3) the test fixture format. One contract,
three consumers — change it in one place or not at all.

**Provenance rule (governs everything below):** the recipe assembling `config`
*projects* existing SDC truth — field definitions, option rows, `cfg_rule`
records — into this shape. Nothing in this contract is authored by hand except
the projection logic itself. The renderer never invents constraints, options,
or labels.

---

## 1. `config`

Two sections with deliberately different scopes:

- `template` — **version-scoped.** Byte-identical for every request on the same
  `template_version_id`. This property is load-bearing: it enables golden-file
  tests and config caching.
- `request` — **request-scoped.** Everything that varies per supplier.

```json
{
  "contract_version": "1.0",
  "request": {
    "correlation_token": "8f14e45f-ceea-4671-a5b9-6d3d6f1c2a9e",
    "action_url": "https://script.google.com/macros/s/DEPLOY_ID/exec",
    "template_version_id": "1.3",
    "display": {
      "project_name": "MARS RC Data Collection",
      "supplier_name": "Acme Staffing LLC",
      "due_date": "2026-08-15"
    }
  },
  "template": {
    "template_version_id": "1.3",
    "title": "Supplier rate card submission",
    "fields": [ "...see §1.1..." ],
    "options": { "...see §1.2..." }
  }
}
```

Rules:

- `contract_version` — the renderer asserts it understands this value. Bump on
  any breaking change to this document.
- `request.template_version_id` MUST equal `template.template_version_id`. The
  renderer asserts equality and raises on mismatch. This is the version-drift
  tripwire: if a request's template was bumped after the config slice was
  assembled, the render fails loudly instead of producing a stale form.
- `display` values are informational only — rendered in the page header,
  escaped like everything else, never used in logic.

### 1.1 Field definition

```json
{
  "field_id": "job_family",
  "label": "Job family",
  "type": "dropdown",
  "required": true,
  "help_text": "Select the family this rate card covers.",
  "parent_field_id": null,
  "sort_order": 10,
  "constraints": {}
}
```

- `field_id` — `^[a-z][a-z0-9_]*$`, unique within `fields`. Doubles as the HTML
  input `name`. This identity is what makes the round-trip law (§5) hold.
- `type` — v1 set: `text` | `textarea` | `number` | `date` | `dropdown`.
  Unknown type → `RenderContractError` (a new type is a contract bump, not a
  silent fallback to text).
- `parent_field_id` — the cascade edge. `null` for root fields. Non-null only
  when `type` is `dropdown` and the referenced field is also a `dropdown`.
- `sort_order` — display order, ascending. Ties broken by `field_id` so output
  stays deterministic.
- `constraints` — type-specific, projected from `cfg_rule`:

| type | allowed keys | HTML5 projection |
|---|---|---|
| `text` | `max_length`, `pattern` | `maxlength`, `pattern` |
| `textarea` | `max_length` | `maxlength` |
| `number` | `min`, `max`, `step` | `min`, `max`, `step` |
| `date` | `min`, `max` (ISO 8601) | `min`, `max` |
| `dropdown` | *(none — options are the constraint)* | — |

Constraints are courtesy guardrails. VAL-01 re-derives every rule server-side
from the same `cfg_rule` rows; a supplier who strips the attributes changes
nothing about what gets accepted.

### 1.2 Options map

Flat dictionary, consumed verbatim by the embedded cascade script:

```json
{
  "job_family|": ["Engineering", "Finance", "Operations"],
  "role|Engineering": ["Integration developer", "Data engineer"],
  "role|Finance": ["Financial analyst"],
  "seniority|Integration developer": ["Level I", "Level II", "Level III"]
}
```

- Key format: `"{field_id}|{parent_value}"`. Root dropdowns use the empty
  parent value: `"{field_id}|"`.
- **Completeness invariant:** for every dropdown field F and every option value
  V reachable on F's parent, the key `"F|V"` MUST exist. Missing key →
  `RenderContractError` at config-validation time, not a broken form at
  supplier time.
- An **empty array is legal** and means "not applicable for this parent value" —
  the child renders disabled with a "Not applicable" placeholder, and the
  submit payload carries `null` for it. VAL-01 must treat that combination as
  valid absence, not a missing required field. (Same semantics the XLSX
  template expresses with an empty named range.)
- v1 options are plain strings — value and label are identical, matching
  TPL-02's reference sheet. `{value, label}` pairs are a reserved v2 extension;
  do not partially adopt.

### 1.3 Dependency graph invariant

The `parent_field_id` edges MUST form a forest: no cycles, single parent per
node, all references resolvable. Validate with a topological pass before
rendering (the same check `WorkatoOrderLib`'s toposort performs on recipe
graphs — reuse the idea, not the library). Violation → `RenderContractError`.

---

## 2. `values`

Field-id-keyed, flat, nullable strings:

```json
{
  "job_family": "Engineering",
  "role": "Integration developer",
  "seniority": null,
  "effective_date": "2026-08-01"
}
```

- Missing key ≡ `null`. First render passes `{}`.
- All values are strings (or null) regardless of field type — the browser
  speaks strings; typing is VAL-01's concern, not the renderer's.
- Keys not matching any `field_id` are ignored silently (defensive: a version
  bump between submit and re-render may orphan a value; dropping it is correct).
- **Cascade rehydration requirement:** when a child dropdown has a value, the
  renderer's emitted init script must populate it *after* running the parent
  lookup, so a resubmitted form shows the supplier's prior selections instead
  of reset dropdowns. This is the single fiddliest renderer behavior — it gets
  its own fixture (§6).

---

## 3. `errors`

The shape the submit recipe produces by projecting `validate_upload` findings
(single-record form ⇒ findings for row 1) into field terms:

```json
{
  "field_errors": {
    "seniority": ["Required."],
    "effective_date": ["Must be on or before 2026-12-31."]
  },
  "form_errors": [
    "Rate exceeds the engagement ceiling for this role."
  ]
}
```

- Empty state is `{"field_errors": {}, "form_errors": []}`; first render passes
  the empty state.
- `field_errors` keys that match a `field_id` render adjacent to that field.
- **Unmatched keys are not swallowed** — their messages are appended to
  `form_errors` with the stray key prefixed (`"seniority_v2: Required."`).
  If VAL-01 ever reports on a field this template version doesn't know about,
  the supplier sees *something* and you see a diagnostic, instead of a
  silently clean form that keeps failing.
- Messages are plain text, escaped at render. No HTML in messages, ever.

---

## 4. Output guarantees

`render` returns one complete, self-contained HTML document:

1. **Zero external resources.** Inline CSS, inline JS, no fonts, no images, no
   CDN. Supplier networks and email-link scanners are hostile territory;
   self-containment is the only portable answer.
2. **Escape totality.** Every string originating in `config`, `values`, or
   `errors` is HTML-escaped in markup context. The options map embedded in the
   `<script>` block is JSON-serialized with `<` escaped as `\u003c` (the
   `</script>` breakout is the classic hole).
3. **Structure per field**, in `sort_order`: label → control → help text →
   error list (when present). Control `name` = `field_id`, verbatim.
4. Hidden input `token` carrying `request.correlation_token`; `<form
   method="POST" action="{action_url}">`.
5. Cascading dropdowns carry `data-parent="{parent_field_id}"`; one generic
   cascade script (field-agnostic, identical across all templates) reads the
   embedded options map.
6. `template_version_id` and `contract_version` embedded as `data-` attributes
   on `<form>` — diagnostics, not behavior.
7. **Determinism:** identical `(config, values, errors)` → byte-identical
   output. No timestamps, no generated IDs, no dict-ordering leaks (sort
   everything sortable).

Renderer failures (`RenderContractError`) are 500-class events: the recipe maps
them to a static apology page and an internal alert. A supplier never sees a
traceback; a config error never masquerades as a validation error.

---

## 5. Contract laws

The testable properties. Each becomes a test, most become golden files.

| # | Law | Test shape |
|---|---|---|
| L1 | Purity — same inputs, byte-identical HTML | golden file |
| L2 | Round-trip — posting the rendered form unchanged yields `fields` ≡ `values` (modulo nulls); the submit payload's `fields` object and §2 `values` are the *same schema* | property test |
| L3 | Escape totality — a config seeded with `<script>` in every string field renders no unescaped occurrence | adversarial fixture |
| L4 | Field completeness — every field renders exactly once | DOM count |
| L5 | Error adjacency + stray-key surfacing per §3 | fixture |
| L6 | Graph validity — cyclic or dangling `parent_field_id` raises before any output | unit |
| L7 | Version match — request/template mismatch raises | unit |
| L8 | Option completeness per §1.2 | unit |
| L9 | Cascade rehydration — child values survive re-render | fixture + DOM assert |

L2 is the architectural keystone: it is the formal statement that the form is a
second ingestion adapter, not a second pipeline. The shim's conversion
(form-encoded → `{"token": t, "fields": {...}}`) contains no field knowledge;
the submit recipe normalizes `""` → `null` before VAL-01 so both adapters
present identical absence semantics.

---

## 6. Reference fixture — resubmit scenario

Exercises: cascade chain with rehydration (L9), a field error, a form error,
constraints, and a null child. This is the canonical golden-file input.

```json
{
  "config": {
    "contract_version": "1.0",
    "request": {
      "correlation_token": "8f14e45f-ceea-4671-a5b9-6d3d6f1c2a9e",
      "action_url": "https://script.google.com/macros/s/DEPLOY_ID/exec",
      "template_version_id": "1.3",
      "display": {
        "project_name": "MARS RC Data Collection",
        "supplier_name": "Acme Staffing LLC",
        "due_date": "2026-08-15"
      }
    },
    "template": {
      "template_version_id": "1.3",
      "title": "Supplier rate card submission",
      "fields": [
        {"field_id": "job_family", "label": "Job family", "type": "dropdown",
         "required": true, "help_text": null, "parent_field_id": null,
         "sort_order": 10, "constraints": {}},
        {"field_id": "role", "label": "Role", "type": "dropdown",
         "required": true, "help_text": null, "parent_field_id": "job_family",
         "sort_order": 20, "constraints": {}},
        {"field_id": "seniority", "label": "Seniority", "type": "dropdown",
         "required": true, "help_text": null, "parent_field_id": "role",
         "sort_order": 30, "constraints": {}},
        {"field_id": "bill_rate", "label": "Bill rate (USD/hr)", "type": "number",
         "required": true, "help_text": "Standard rate before markup.",
         "parent_field_id": null, "sort_order": 40,
         "constraints": {"min": 0, "max": 500, "step": 0.01}},
        {"field_id": "effective_date", "label": "Effective date", "type": "date",
         "required": true, "help_text": null, "parent_field_id": null,
         "sort_order": 50, "constraints": {"max": "2026-12-31"}}
      ],
      "options": {
        "job_family|": ["Engineering", "Finance"],
        "role|Engineering": ["Integration developer", "Data engineer"],
        "role|Finance": ["Financial analyst"],
        "seniority|Integration developer": ["Level I", "Level II", "Level III"],
        "seniority|Data engineer": ["Level I", "Level II"],
        "seniority|Financial analyst": []
      }
    }
  },
  "values": {
    "job_family": "Engineering",
    "role": "Integration developer",
    "seniority": null,
    "bill_rate": "612.50",
    "effective_date": "2027-02-01"
  },
  "errors": {
    "field_errors": {
      "seniority": ["Required."],
      "bill_rate": ["Must be at most 500."],
      "effective_date": ["Must be on or before 2026-12-31."]
    },
    "form_errors": []
  }
}
```

Expected renderer behavior worth eyeballing in the golden file: `job_family`
and `role` arrive pre-selected via cascade rehydration; `seniority` is
populated with three options, unselected, error adjacent; `bill_rate` shows the
out-of-range value the supplier typed (never discard their input on error);
the `Financial analyst → seniority` empty-array branch is present in the
embedded map even though this request never reaches it — the map is
template-scoped, not values-scoped.

---

## 7. Non-goals (v1)

Named so their absence reads as a decision, not an oversight:

- **File upload fields** — supporting documents stay on the existing channel.
- **Multi-record grids** — the form serves record-per-request submissions;
  bulk populations keep the XLSX path. (Established scoping decision.)
- **`{value, label}` option pairs, i18n, draft persistence, multi-select** —
  reserved extension points; each is a `contract_version` bump.

---

## 8. Change control

Any change to a schema, law, or guarantee in this document bumps
`contract_version` and requires regenerating golden files. The renderer
supports exactly one contract version at a time; the config-assembly recipe and
renderer deploy together.
