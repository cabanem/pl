# lib_sdc 1.7.0 — schema 1.6, payload 10.0

Seed-row configuration, `_customer` export block, label alignment to the v0.9.9 template.
Eight files changed; the rest are byte-identical to 1.6.0. Load-time guards and the
1.5→1.6 migration were exercised under node against a mock of the v0.9.9 `1_customer` grid.

## Changed files

| File | Change |
|---|---|
| `008_Version.js` | `LIBRARY 1.7.0`, `PAYLOAD 10.0`, `SCHEMA 1.6`. Added 10.0 to the payload history, plus a placeholder for the unrecorded 9.0 entry — **confirm and reword**. |
| `003_Schema.js` | `Labels` aligned to v0.9.9 wording (+ two seed-row labels). `CUSTOMER_FIELDS`: `seedDataHeaderRow`, `seedDataFirstDataRow` (int, optional); `expectedDate.valueOffset` 2 → 1. Guard list extended. Doc comment on `Labels` rewritten: a wording change is now a minor bump with re-stamp, not a major bump. |
| `004_Customer.js` | New `Customer.serialize(ss, config)` → `{ values, unresolved }`, JSON-safe, keyed by registry key. Same named-range read as `Customer.read`. |
| `001_Drive.js` | `serializeConfig` emits `output['_customer'] = Customer.serialize(...)` (step 2c) before the fingerprint. Header doc updated. |
| `005_Preflight.js` | 5f: `Seed data index key` now required when seeded. New 5g: seed row geometry — non-integer rejected, blank defaults (header 1, first data row header+1), `header >= 1`, `first > header`; results written back to `customerData`. |
| `003_Payload.js` | `provision`: `seeded_data_header_row`, `seeded_data_first_data_row` (integer \| null via new `Payload._intOrNull`). Doc comment for 10.0. |
| `005_Provision.js` | Passes `pf.seedDataHeaderRow` / `pf.seedDataFirstDataRow` into `Payload.provision`. |
| `002_Migrations.js` | New `1.5 → 1.6` step: derives the sheet layout from `cfg_customer_name` (never hardcodes B/D), re-stamps every anchored label to current `Labels` wording, appends the two seed rows below content (row number, label, `>= 1` validation, conditional `*` marker mirroring the seed-Drive-ID row), then `ensureNamedRanges`. Idempotent. |

## Wire contract (payload 10.0)

    seeded_data_header_row      integer | null   # null when has_seeded_data is false
    seeded_data_first_data_row  integer | null

## Config JSON (`_customer`)

    "_customer": {
      "values": { "<CUSTOMER_FIELDS key>": <string|number|boolean|number[]|null>, ... },
      "unresolved": [ "<key>", ... ]
    }

Keys are the registry keys (`clientName`, `seedDataIndexKey`, …). The connector maps them
in one table (`customer_key_map`); that table is where the wire-name rename lands when decided.

## Deploy order

1. R-1 must accept `payload_version` 10.0 (behaviour on a mismatch is unconfirmed — check before pushing).
2. Connector release (reads `_customer`; grid parse is fallback only).
3. `clasp push` this library; bump the library version pinned in the container script.
4. Open the v0.9.9 template → "Migrate workbook schema" → verify 17 `cfg_*` ranges resolve.
5. Fill `Seed data header row` = 5 and `Seed data first data row` = 7 for the Sony VNDLY seed; provision.

## Known limits

- Sheets data validation cannot enforce "whole number"; `>= 1` blocks text and zero, and
  `parseInt` truncates a decimal silently (5.5 → 5). Acceptable for now; Preflight names the field on any other error.
- New rows are appended below existing content. Move them beside rows 14–16 by hand if you
  want them grouped; the named ranges follow.
