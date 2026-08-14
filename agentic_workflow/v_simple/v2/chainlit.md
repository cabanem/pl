# SDC Corpus Agent

Ask questions about the SDC Workato platform — structure, dependencies,
impact, and change over time. Answers come with an evidence trail: expand
the steps under any reply to see exactly which queries support each claim,
and download the attached log for the full record.

## Asking well

The agent works from a fact database, so precision is speed: **name the
artifact** — a table (`WFA_SupplierRequest`), a field, a recipe prefix
(`UPL-01`), an action — and answers take one or two steps instead of a
search. One question per message beats compound questions. For a new topic,
start a new chat; short sessions stay sharp.

Question shapes this system is built for:

- **Who writes / reads a table or field** — "Who writes
  `WFA_SupplierRequest`, and which fields?"
- **Rename / repurpose impact** — "What breaks if I rename a field on
  `CFG_FormSlotMapping`?"
- **Call chains** — "Show the call chain below `UPL-01`."
- **Change over time** — "What changed between the last two snapshots?"
- **Usage census** — "Which recipes use the workflow-app update-request
  action?"
- **One step in depth** — "Show me step `0/2/1` of `STS-01`."

## Reading answers

Facts are cited to queries; judgment is marked as judgment. `resolved=0`
on an edge means the target isn't in the current snapshot — a finding, not
an error. If a result says `truncated`, the answer says so too.
