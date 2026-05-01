# Writing Data Table Queries

A short, practical guide to authoring queries in the **DT Queries** sheet.
For the underlying API reference, see Workato's docs:
https://docs.workato.com/en/workato-api/data-tables.html#query-records

---

## The shape of a query row

Each row in **DT Queries** is one query. Eleven columns:

| Column | What it does |
|---|---|
| `enabled` | Checkbox. If checked, "Run all enabled" picks it up. |
| `name` | Human label. Shown in toasts. Doesn't affect the query. |
| `table_id` | The data table's UUID. Required. Get this from the **Data Tables Inventory** sheet (or the URL of the table in Workato). |
| `output_sheet` | Name of the sheet to write results to. Created if it doesn't exist; overwritten on each run. |
| `limit` | Max records to fetch. The API caps a single page at 200; multi-page fetching is automatic. |
| `select_json` | *Optional.* JSON array of column names to return. Empty = all columns. |
| `where_json` | *Optional.* JSON hash of filter conditions. Empty = no filter. |
| `order_json` | *Optional.* JSON string or hash for sorting. Empty = unordered. |
| `tz_offset_secs` | Required when filtering on date or date-time. `0` for UTC. |
| `last_run_at` / `last_run_count` | Stamped automatically after each run. Don't edit. |

---

## Three building blocks

### 1. Filtering — `where_json`

A hash keyed by **field name**, where each value is a hash keyed by an
operator. Operators are `$`-prefixed.

```json
{ "Status": { "$eq": "open" } }
```

**Multiple conditions are AND-ed** when you list them in the same hash:

```json
{
  "Status": { "$eq": "open" },
  "Priority": { "$gte": 3 }
}
```

**Operators reference:**

| Operator | Meaning | Example |
|---|---|---|
| `$eq` | equals | `{"Name": {"$eq": "Josh"}}` |
| `$ne` | not equal | `{"Status": {"$ne": "closed"}}` |
| `$gt` | greater than | `{"Score": {"$gt": 90}}` |
| `$gte` | greater than or equal | `{"Score": {"$gte": 75}}` |
| `$lt` | less than | `{"Amount": {"$lt": 10}}` |
| `$lte` | less than or equal | `{"Amount": {"$lte": 13}}` |
| `$in` | matches any in list | `{"Name": {"$in": ["Josh","Bob"]}}` |
| `$starts_with` | string prefix | `{"Email": {"$starts_with": "admin@"}}` |

**Meta-fields** (built-in record metadata) start with `$` and can be
filtered on like any other field:

- `$record_id` — the record's UUID
- `$created_at` — when the record was first created
- `$updated_at` — when the record was last modified

```json
{ "$created_at": { "$gte": "2026-04-24T00:00:00Z" } }
```

Set `tz_offset_secs` to `0` whenever your `where_json` filters on dates
or datetimes — the API requires it, and `0` (UTC) matches ISO timestamps.

### 2. Ordering — `order_json`

Either a string (the field name to sort by, ascending):

```json
"$created_at"
```

…or a hash for descending or case-sensitive ordering:

```json
{ "by": "$created_at", "order": "desc" }
```

```json
{ "by": "Name", "order": "asc", "case_sensitive": true }
```

### 3. Column selection — `select_json`

A JSON array of column names. Empty means "return everything." Useful
for log tables with many columns when you only need a few:

```json
["$record_id", "$created_at", "Status", "Message"]
```

The output sheet's columns will follow this order. If `select_json` is
empty, columns appear in whatever order the API returns them.

---

## Common queries, ready to paste

### Last 50 log entries from a table

| Column | Value |
|---|---|
| `limit` | `50` |
| `where_json` | *(empty)* |
| `order_json` | `{"by": "$created_at", "order": "desc"}` |
| `tz_offset_secs` | `0` |

### Errors only, last 7 days

| Column | Value |
|---|---|
| `limit` | `200` |
| `where_json` | `{"Severity": {"$eq": "error"}, "$created_at": {"$gte": "2026-04-24T00:00:00Z"}}` |
| `order_json` | `{"by": "$created_at", "order": "desc"}` |
| `tz_offset_secs` | `0` |

(Replace the date with whatever you consider "7 days ago" at run time.
Apps Script doesn't substitute a "today minus 7" placeholder for you —
edit the date when the window slides forward.)

### Just a few columns from a wide table

| Column | Value |
|---|---|
| `limit` | `100` |
| `select_json` | `["$record_id", "$created_at", "Status", "Message"]` |
| `where_json` | `{"Status": {"$ne": "ok"}}` |
| `order_json` | `"$created_at"` |
| `tz_offset_secs` | *(empty — no date filter)* |

### Records belonging to a specific category

| Column | Value |
|---|---|
| `where_json` | `{"Category": {"$in": ["billing", "refunds", "disputes"]}}` |

---

## Running a query

1. Click anywhere in the row you want to run.
2. **Workato → Run Data Table query (current row)**.
3. Results appear in the sheet named in `output_sheet`.

For batch refresh of multiple queries, check `enabled` on each one and
use **Workato → Run all enabled Data Table queries**. Disabled rows are
saved but skipped — useful for keeping experimental queries around
without having them run on every batch.

---

## Editing JSON in cells

A few practical things:

- **Spreadsheet cells don't enforce JSON syntax.** A typo gives you
  *"where_json is not valid JSON: Unexpected token"* on run. Fix the
  cell, run again.
- **Use double quotes inside JSON, not single quotes.** `{"Name": "Josh"}`
  is valid; `{'Name': 'Josh'}` is not.
- **Multi-line JSON works.** You can put line breaks inside a cell
  (Alt+Enter on most platforms) without breaking the JSON. Sheets
  preserves the linebreaks; `JSON.parse` accepts whitespace.
- **The `@` plain-text format is already applied** to the JSON columns,
  so Sheets won't try to reinterpret your brackets or quotes. If you
  see weird formatting after pasting, retype the cell value.

---

## When a query doesn't return what you expected

In rough order of likelihood:

1. **Field name spelling.** The API matches field names exactly,
   including case. "status" and "Status" are different. Check the
   table's schema — either in Workato's UI or by listing the table's
   columns from your existing tables sync.
2. **Operator vs. value type mismatch.** `{"Score": {"$gte": "75"}}`
   (string) and `{"Score": {"$gte": 75}}` (number) compare differently
   if the column is a number type. Match the type to the column.
3. **Date format.** The API accepts ISO 8601 datetimes
   (`"2026-04-24T00:00:00Z"`) and YYYY-MM-DD dates (`"2026-04-24"`).
   Other formats fail silently or return nothing.
4. **Missing `tz_offset_secs`.** Required for any date or datetime
   comparison. Set to `0` for UTC.
5. **`limit` cap.** The API enforces a per-page max of 200. The runner
   handles pagination automatically up to `limit` total records, but if
   you set `limit: 50000` and the table has fewer rows, you'll just get
   what's there.

---

## What's intentionally not in the queries sheet

- **No `$or` or `$not` operators.** The API supports `$and` (which is
  also implicit when you list multiple conditions), but I haven't
  found documented support for `$or`/`$not`. If you need them, run two
  queries with different `where_json` and combine the output sheets
  manually.
- **No live timestamp variables.** `"$created_at": {"$gte": "now()-7d"}`
  isn't a thing. The dates are literal ISO strings; you edit them when
  the window changes.
- **No row-level result joining.** If you want logs joined to user
  records, run two queries to two output sheets and use `VLOOKUP` or
  `QUERY` formulas across them. Server-side joins aren't part of this
  API.

These limitations are tradeoffs. The queries sheet is meant to be a
flat, declarative description of what to fetch — not a query language.
For richer logic, write Apps Script that calls `fetchDataTableRecords`
directly and composes whatever you need.
