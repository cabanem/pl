# Spec Extraction Prompt — GAS Monday.com ↔ Smartsheet Bridge

> Paste this prompt into a conversation, followed by your script code.

---

## Prompt

You are a technical architect performing a **spec extraction** — reverse-engineering a declarative specification from existing code. The goal is NOT to fix or improve the code. The goal is to produce a spec that accurately describes **what the code currently does**, including any bugs, gaps, or questionable assumptions. I will audit the spec separately and correct it before regenerating code from it.

The code I'm providing is a **Google Apps Script** that bridges **Monday.com** and **Smartsheet**, with Google Sheets potentially acting as an intermediary or configuration layer.

Analyze the code and produce a structured spec with the following sections:

### 1. Overview
- One-paragraph summary of what this script does end-to-end.
- The direction(s) of data flow (Monday → Sheets → Smartsheet, bidirectional, etc.).
- Trigger mechanism (time-driven, event-driven, manual, onOpen menu, etc.).

### 2. External Dependencies
For each external system (Monday.com, Smartsheet, Google Sheets, any others):
- How authentication is handled (API key in properties, OAuth, hardcoded, etc.).
- Which API endpoints or SDK methods are called.
- What permissions/scopes are assumed.

### 3. Configuration & State
- Where configuration lives (script properties, a config sheet, hardcoded constants, etc.).
- What values are configurable vs. hardcoded.
- Any persistent state the script relies on between executions (e.g., last-sync timestamps, ID mappings, cursor positions).

### 4. Data Model & Mapping
- What entities/records are being moved (items, columns, rows, cells, etc.).
- The field-level mapping between Monday.com columns and Smartsheet columns.
- Any transformations, formatting, or type coercions applied during mapping.
- How IDs, keys, or unique identifiers are resolved across systems.

### 5. Function Inventory
For **each function**, document:
| Field | Description |
|---|---|
| **Name** | Function name |
| **Purpose** | What it does in one sentence |
| **Parameters** | Name, expected type, and meaning of each parameter |
| **Return value** | Type and meaning (or "void / side-effect only") |
| **Side effects** | External calls, sheet writes, property mutations, logging |
| **Dependencies** | Other functions it calls, and external state it reads |
| **Assumptions** | Anything the function assumes to be true about its inputs or environment |

### 6. Control Flow & Orchestration
- What is the entry point (or entry points)?
- In what order do functions execute in a normal run?
- Represent the call graph as a simple text diagram or ordered list.

### 7. Error Handling & Edge Cases
- How are API errors handled (try/catch, HTTP status checks, retry logic, silent failure)?
- What happens if a record exists in one system but not the other?
- What happens on partial failure (e.g., 3 of 10 rows sync successfully)?
- Are there any rate-limit considerations?

### 8. Observations (NOT Fixes)
Flag anything that looks like it **might** be a bug, an unhandled edge case, a race condition, or a mismatch between apparent intent and actual behavior. **Do not suggest fixes** — just state the observation factually so I can evaluate it during spec review. Format each observation as:
- **Location:** function name or line range
- **Observation:** what you noticed
- **Why it matters:** potential impact if this is indeed a problem

---

## Formatting Rules
- Use the exact section structure above — do not merge, rename, or reorder sections.
- In the Function Inventory, cover **every** function, no matter how trivial.
- Prefer concrete values over vague descriptions (e.g., "reads `MONDAY_API_KEY` from Script Properties" not "reads config").
- If something is ambiguous in the code, say so explicitly rather than guessing.

---

> **[Paste your Apps Script code below this line]**
