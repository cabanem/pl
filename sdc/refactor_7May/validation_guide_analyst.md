# Supplier Upload Validation — What You Can Configure

*A guide for analysts. When a supplier submits their filled-in template, the upload check inspects every row against the rules you set in the config sheet. This is the menu of what you can turn on, in plain terms, and where you set each one.*

> The upload check is the **authoritative** layer — it's what actually accepts or rejects a supplier's data. The in-template helpers (dropdowns, the grey instruction row, locked cells) only guide the supplier while they type; they don't decide. So everything below is enforced at submission regardless of what the supplier does to the spreadsheet.

---

## The checks, grouped by what they ask

### Is it filled in correctly?
| You want to… | Set it in |
|---|---|
| Make a field mandatory | `4_fields` → **Required** |

### Is it the right kind of value?
| You want to… | Set it in |
|---|---|
| Require a whole number, 2-decimal number, date (YYYY-MM-DD), yes/no, or text | `4_fields` → **Data type** |
| Require a recognized shape: email, currency, percentage, or a date mask | `4_fields` → **Data format** |

### Is it within bounds?
| You want to… | Set it in |
|---|---|
| Limit character count (text) | `4_fields` → **Field length validation** |
| Set a number range (e.g. `>= 0`, `(0, 100]`) | `4_fields` → **Numeric field validation** |
| Set a date range (supports `TODAY`, e.g. `< TODAY`) | `4_fields` → **Date field validation** |
| Enforce a custom pattern (e.g. a phone format) | `4_fields` → **Field input validation** (regex) |

### Is it a valid choice?
| You want to… | Set it in |
|---|---|
| Restrict to a list of options | `4_fields` → **Lookup name** (→ `5_lookups`) |
| Restrict options based on another field's choice | `4_fields` → **Depends on** (dependent dropdown) |

### Is it unique?
| You want to… | Set it in |
|---|---|
| No duplicate value within a column | `4_fields` → **Unique** |
| No duplicate *combination* across fields | `4_complex_validations` → "Combined fields must be unique" |

### Does it agree with other fields?
Set in `4_complex_validations`. The available rules: must match / must not match; greater-than / less-than (and the "or equal" forms); required-if and must-be-empty-if (conditional on another field's value); mutually exclusive (not both filled); at least one required.

### Cleaning — the one that *changes* data instead of rejecting it
| You want to… | Set it in |
|---|---|
| Auto-tidy values before checking & storing: trim spaces, remove control characters, collapse double spaces, force upper/lowercase, strip non-numeric characters | `4_fields` → **Data cleaning flags** |

Call this one out in your own head when you use it: it silently rewrites the supplier's value before anything else happens. Useful, but use it deliberately — a supplier won't see that their `" 5,000 "` became `5000`.

---

## Blocking vs. advisory

Each field (and each cross-field rule) is either **blocking** or **advisory**:

- **Blocking** — a failure rejects that row; the row doesn't count as valid data.
- **Advisory** — the failure is recorded in the report, but the row is still accepted.

You control this per field with **Strict?** (`4_fields`) and per rule with **Strict enforcement** (`4_complex_validations`). The intended default, when you leave it blank, is **blocking** — bad data should stop, not slip through.

---

## Status notes (current pilot — read before relying on a check to *block*)

These capabilities are configurable, but a few aren't fully enforcing yet while fixes land. Treat the list above as "what you can set," not "all blocking today":

- **Blocking vs advisory isn't live yet.** A config-parsing fix is in flight; until it lands, field- and rule-level failures are treated as *advisory* regardless of **Strict?**, so a row failing only these checks is still accepted. Confirm this is fixed before depending on a check to reject.
- **Column uniqueness (Unique) doesn't fire yet** — the column is currently dropped during parsing. Being fixed.
- **Cross-field rules scoped to a supplier or engagement** (checking against that supplier's *past* submissions) only run when prior submissions are supplied to the check — not yet wired.
- **Read-only** locks a field in the template, but the upload check doesn't yet verify a read-only value wasn't altered; that guard is server-side and pending. Don't rely on the template lock alone for identifier fields.

When in doubt about whether a given check is currently blocking, the honest answer is to run a sample upload and look at the verdict rather than trusting this page — the live result is the source of truth.
