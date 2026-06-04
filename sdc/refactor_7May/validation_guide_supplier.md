# Why Your Upload Was Returned — and How to Fix It

*When you submit your completed template, we check it and send it back with notes if anything needs adjusting. Each note points to a specific cell and tells you what to change. This guide explains how to read those notes and the most common fixes — most submissions go through on the second try once these are sorted.*

---

## How to read a note

Every note answers three things:

- **Where** — the row number and the column name.
- **What** — what isn't accepted about that value.
- **Fix** — what an accepted value looks like.

For example: *"Row 14, Worker Email: 'jsmith#acme' isn't a valid email address — please enter something like name@company.com."* That tells you the exact cell (row 14, the Worker Email column), the problem (it's not a valid email), and the fix (the expected shape).

Work down the list row by row, correct each cell, and re-submit.

---

## The most common reasons, and how to fix each

**A required field is empty.** A column needed a value and the cell was blank. → Fill it in. Required columns are marked with an asterisk (`*`) in the header.

**The value is the wrong kind.** A column expects a number or a date but got text (e.g. "N/A" in a number column, or "next week" in a date column). → Enter a number where a number is expected, and dates as `YYYY-MM-DD` (e.g. `2026-03-01`).

**The format doesn't match.** The value is the right idea but the wrong shape — an email without an `@`, a date in the wrong layout, a currency or percentage with stray characters. → Match the format shown in the grey instruction row (row 2) for that column. Emails look like `name@company.com`; dates like `2026-03-01`; amounts as plain numbers.

**The value is too long, out of range, or doesn't match a required pattern.** The field has a limit — a maximum length, a number or date range, or a specific pattern (like a phone number layout). → Check the instruction row for that column; it describes what's expected.

**It isn't one of the allowed options.** The column only accepts values from a set list, and the entry wasn't on it. → Use the drop-down arrow in the cell to pick a valid option rather than typing. For linked drop-downs, pick the first field's value before the second — the second list narrows based on the first.

**A duplicate value.** A column (or a combination of columns) has to be unique, and the same value appeared twice. → Find the duplicate and correct or remove one.

**It conflicts with another field.** Some columns depend on each other — two that can't both be filled, or one that becomes required when another has a certain value. → The note names the related column; adjust so the two agree.

**Nothing to submit.** The file came through with no data rows. → Add your data starting in the first open row beneath the headings, then re-submit.

---

## A few habits that prevent a return trip

- **Use the drop-down menus** instead of typing, wherever a cell offers one — it's the easiest way to stay within the allowed values.
- **Read the grey instruction row** (row 2). It carries the expected format for the trickier columns, like email or specific date layouts.
- **Fill every column marked `*`** — those are required.
- **If you paste data in, double-check it afterward.** Pasting can skip the in-cell prompts, so values that look fine on screen may still be flagged when you submit. A quick scan after pasting saves a round trip.
- **Leave the locked cells and any greyed areas alone** — the headings, the instruction row, and any pre-filled identifier columns aren't meant to be edited.

If a note isn't clear, reply to the request with the row and column and we'll help you sort it out.
