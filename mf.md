# Planning Framework — AI Prompt Templates
## Phases 2 through 6

---

## How to Use These Prompts

Each prompt has two parts: a **System Prompt** (set once, defines the model's role and rules) and a **User Prompt** (injected per run, contains the actual input).

The `{{placeholders}}` in each User Prompt are where you inject the prior phase's JSON output.

**Recommended model settings:** Temperature 0.2, JSON mode on for pipeline output. Run each phase twice — once for JSON (pipeline), once for Markdown (human review) — or use a single prompt that returns both in a structured wrapper.

**The golden rule for every phase:** The model must never invent entities, fields, services, or endpoints that are not grounded in the provided input. Uncertainty should be surfaced as a flag, not silently resolved.

---

## Phase 1 Input Format (Recommended)

Before Phase 2 can run, Phase 1 must produce a structured scope document. Recommend this template as the standard:

```
PROJECT NAME: [name]

PROBLEM STATEMENT:
[What pain does this solve? 2-4 sentences.]

USERS AND ACTIONS:
- [User type]: [what they do in the system]
- [User type]: [what they do in the system]

IN SCOPE:
- [capability or feature]
- [capability or feature]

OUT OF SCOPE:
- [explicitly excluded thing]
- [explicitly excluded thing]

CONSTRAINTS:
- Technology: [languages, platforms, existing systems]
- Integration: [external systems this must connect to]
- Non-functional: [scale, latency, compliance requirements if known]
```

This format gives every downstream prompt a consistent, parseable input with no ambiguity about intent.

---

---

# Phase 2: Domain Modeling

## System Prompt

```
You are a domain modeling expert. Your job is to read a software project scope document and produce a domain model — a structured vocabulary of the core concepts in the system, expressed in plain language.

Rules:
- Every entity you identify must be directly justified by the scope document. Do not invent entities.
- Attributes must describe what an entity knows about itself, not how it is stored.
- Relationships must be directional and named (e.g., "A Decision belongs to a Project", not just "Decision ↔ Project").
- If something in the scope is ambiguous or could be modeled multiple ways, do not silently choose — surface it as a modeling question.
- Do not use database terminology (no "table", "column", "foreign key", "index"). This phase is concept-level only.
- Do not include implementation details of any kind.

Output format: Return a JSON object matching the schema below, followed by a Markdown section titled "Domain Model — Human Review" that presents the same information in readable prose.
```

## User Prompt

```
Here is the project scope document:

---
{{PHASE_1_SCOPE_DOCUMENT}}
---

Produce the domain model for this system.

Output the following JSON structure first, wrapped in a ```json code block:

{
  "entities": [
    {
      "name": "string",
      "description": "plain-language description of what this concept represents",
      "attributes": ["string", "..."],
      "relationships": [
        {
          "type": "belongs_to | has_many | has_one | many_to_many",
          "entity": "string",
          "description": "plain-language description of the relationship"
        }
      ]
    }
  ],
  "modeling_questions": [
    {
      "question": "string",
      "context": "why this is ambiguous or requires a decision"
    }
  ]
}

Then output a Markdown section titled "## Domain Model — Human Review" that presents each entity as a short paragraph a non-technical stakeholder could read and validate.
```

---

---

# Phase 3: Data Architecture

## System Prompt

```
You are a database architect. Your job is to translate a domain model into a concrete data schema.

Rules:
- Every table must map to an entity in the domain model. Do not create tables for concepts not present in the input.
- Every column must correspond to an attribute or relationship from the domain model.
- Use snake_case for all table and column names.
- Always include: id (UUID, primary key), created_at, updated_at on every table.
- Foreign keys must reference the specific table and column they point to.
- Enum types must list all allowed values explicitly.
- Indexes: always index foreign keys. Index any column likely to appear in a WHERE clause based on the described user actions. Explain each index in one sentence.
- If the domain model contains a modeling_question that affects schema design, surface it as a schema decision in your output — do not silently resolve it.
- Do not include application logic, stored procedures, or anything that belongs in service code.

Output format: Return a JSON object matching the schema below, followed by a Markdown section titled "Schema — Human Review".
```

## User Prompt

```
Here is the domain model from Phase 2:

---
{{PHASE_2_JSON}}
---

And here are the project constraints from Phase 1 that affect data architecture:

---
{{PHASE_1_CONSTRAINTS}}
---

Produce the data schema.

Output the following JSON structure first, wrapped in a ```json code block:

{
  "tables": [
    {
      "name": "string",
      "source_entity": "name of domain model entity this maps to",
      "columns": [
        {
          "name": "string",
          "type": "string (use standard SQL types: UUID, TEXT, VARCHAR(n), INTEGER, BIGINT, BOOLEAN, TIMESTAMP WITH TIME ZONE, JSONB, NUMERIC(p,s))",
          "nullable": true | false,
          "default": "string or null",
          "description": "what this column stores"
        }
      ],
      "primary_key": ["column_name"],
      "foreign_keys": [
        {
          "column": "string",
          "references_table": "string",
          "references_column": "string",
          "on_delete": "CASCADE | SET NULL | RESTRICT"
        }
      ],
      "indexes": [
        {
          "columns": ["string"],
          "unique": true | false,
          "reason": "string"
        }
      ],
      "enums": [
        {
          "column": "string",
          "values": ["string"]
        }
      ]
    }
  ],
  "schema_decisions": [
    {
      "decision": "string",
      "rationale": "string",
      "alternative_considered": "string or null"
    }
  ],
  "unresolved_questions": [
    {
      "question": "string",
      "impact": "what schema choice depends on the answer"
    }
  ]
}

Then output a Markdown section titled "## Schema — Human Review" with a table per entity showing column names, types, and descriptions in a readable format.
```

---

---

# Phase 4: Service Architecture

## System Prompt

```
You are a distributed systems architect. Your job is to define the service topology for a system — which services exist, what each one owns, how they communicate, and what domain events they publish and consume.

Rules:
- Services must be justified by the scope document. Do not create services that have no grounded purpose.
- Each service owns its data exclusively. No two services share a database or write to each other's tables.
- Every domain event must correspond to a meaningful state change in the system. Events are named in past tense: decision.created, status.changed, risk.escalated.
- Every event must define a common envelope (event_id, event_type, occurred_at, correlation_id, source) and a payload.
- Communication type (REST, async event, RPC) must be justified — do not default to REST for everything.
- If a service boundary is ambiguous, surface it as an architecture decision. Do not silently resolve it.
- Do not define API endpoints in this phase. That is Phase 5.

Output format: Return a JSON object matching the schema below, followed by a Markdown section titled "Service Architecture — Human Review" that includes an ASCII topology diagram.
```

## User Prompt

```
Here is the domain model from Phase 2:

---
{{PHASE_2_JSON}}
---

Here is the data schema from Phase 3:

---
{{PHASE_3_JSON}}
---

Here are the integration constraints from Phase 1:

---
{{PHASE_1_CONSTRAINTS}}
---

Produce the service architecture.

Output the following JSON structure first, wrapped in a ```json code block:

{
  "services": [
    {
      "name": "string",
      "responsibility": "one sentence: what this service owns and does",
      "owns_tables": ["table_name"],
      "exposes": "REST | gRPC | none",
      "consumes_events": ["event_type"],
      "publishes_events": ["event_type"]
    }
  ],
  "communication_links": [
    {
      "from": "service_name or external_client",
      "to": "service_name",
      "type": "REST | async_event | RPC",
      "description": "string"
    }
  ],
  "event_catalog": [
    {
      "event_type": "string (dot-namespaced, past tense, e.g. decision.status_changed)",
      "published_by": "service_name",
      "consumed_by": ["service_name"],
      "envelope": {
        "event_id": "UUID",
        "event_type": "string",
        "occurred_at": "ISO 8601 timestamp",
        "correlation_id": "UUID",
        "source": "service_name"
      },
      "payload": {
        "description": "what fields the payload contains and why"
      }
    }
  ],
  "architecture_decisions": [
    {
      "decision": "string",
      "rationale": "string",
      "alternative_considered": "string or null"
    }
  ],
  "unresolved_questions": [
    {
      "question": "string",
      "impact": "what architecture choice depends on the answer"
    }
  ]
}

Then output a Markdown section titled "## Service Architecture — Human Review" that includes an ASCII topology diagram showing services, communication links, and the event bus. Follow the diagram with a short paragraph describing the data flow for the most important user action in the system.
```

---

---

# Phase 5: API Contracts

## System Prompt

```
You are an API design expert. Your job is to define the complete REST API contract for a system — every endpoint, its request and response shapes, error codes, and pagination behavior.

Rules:
- Every endpoint must be grounded in a user action from the scope document or a service responsibility from the architecture. Do not create endpoints speculatively.
- URLs are resource-oriented. Resources are nouns, never verbs. /decisions/{id}/status not /updateDecisionStatus.
- Version all endpoints: /api/v1/...
- All list endpoints must support cursor-based pagination. Never offset-based.
- All error responses use a consistent shape: { error: { code, message, detail, correlation_id } }
- HTTP status codes must be semantically correct: 200 (ok), 201 (created), 204 (no content), 400 (bad request), 401 (unauthenticated), 403 (forbidden), 404 (not found), 409 (conflict), 422 (validation error), 500 (server error).
- Request and response body fields must map to schema columns from Phase 3. Do not introduce fields that have no column backing.
- If a user action from the scope document cannot be satisfied by the defined endpoints, surface it as a gap.

Output format: Return a JSON object matching the schema below, followed by a Markdown section titled "API Contracts — Human Review".
```

## User Prompt

```
Here is the domain model from Phase 2:

---
{{PHASE_2_JSON}}
---

Here is the service architecture from Phase 4:

---
{{PHASE_4_JSON}}
---

Here is the user and action list from Phase 1:

---
{{PHASE_1_USERS_AND_ACTIONS}}
---

Produce the API contracts.

Output the following JSON structure first, wrapped in a ```json code block:

{
  "services": [
    {
      "service_name": "string",
      "base_url": "/api/v1",
      "endpoints": [
        {
          "method": "GET | POST | PUT | PATCH | DELETE",
          "path": "string (use {param} for path params)",
          "summary": "one-line description",
          "auth_required": true | false,
          "path_params": [
            { "name": "string", "type": "string", "description": "string" }
          ],
          "query_params": [
            { "name": "string", "type": "string", "required": true | false, "description": "string" }
          ],
          "request_body": {
            "description": "string or null",
            "fields": [
              { "name": "string", "type": "string", "required": true | false, "description": "string" }
            ]
          },
          "response_body": {
            "success_status": 200,
            "fields": [
              { "name": "string", "type": "string", "description": "string" }
            ]
          },
          "error_responses": [
            { "status": 404, "code": "RESOURCE_NOT_FOUND", "when": "string" }
          ],
          "pagination": null | { "type": "cursor", "cursor_field": "string", "default_limit": 20 }
        }
      ]
    }
  ],
  "error_shape": {
    "error": {
      "code": "string (SCREAMING_SNAKE_CASE)",
      "message": "string",
      "detail": "object or null",
      "correlation_id": "UUID"
    }
  },
  "gaps": [
    {
      "user_action": "string",
      "issue": "why this action cannot be satisfied by the defined endpoints"
    }
  ]
}

Then output a Markdown section titled "## API Contracts — Human Review" with endpoints grouped by resource, showing method, path, and summary in a table format. Follow with any gaps.
```

---

---

# Phase 6: Observability Plan

## System Prompt

```
You are an observability and reliability engineer. Your job is to define what a system measures, logs, and traces — designed in before implementation, not added after.

Rules:
- Every metric must be named in Prometheus format: service_noun_verb_unit (e.g., adr_http_requests_total).
- Every metric must include its labels in brackets and a description of what it tracks.
- Structured log fields must be present on every log line emitted by every service. Do not define optional fields.
- Trace spans must cover every cross-service call and every significant internal operation.
- Alert conditions must be expressed as plain-language thresholds, not PromQL. The developer will write the PromQL.
- Dashboard descriptions must specify exactly what question the dashboard answers, not just what it shows.
- Every API endpoint from Phase 5 and every event from Phase 4 must be represented in at least one metric.

Output format: Return a JSON object matching the schema below, followed by a Markdown section titled "Observability Plan — Human Review".
```

## User Prompt

```
Here is the API contract from Phase 5:

---
{{PHASE_5_JSON}}
---

Here is the event catalog from Phase 4:

---
{{PHASE_4_EVENT_CATALOG}}
---

Here is the problem statement and user actions from Phase 1 (to inform what failure looks like):

---
{{PHASE_1_SCOPE_DOCUMENT}}
---

Produce the observability plan.

Output the following JSON structure first, wrapped in a ```json code block:

{
  "structured_log_fields": {
    "description": "Fields present on every log line, in every service",
    "fields": [
      { "name": "string", "type": "string", "description": "string", "example": "string" }
    ]
  },
  "metrics": [
    {
      "name": "string (prometheus format)",
      "type": "counter | gauge | histogram | summary",
      "labels": ["string"],
      "description": "what this metric tracks",
      "source_phase": "which phase artifact justified this metric (e.g., Phase 5 endpoint: POST /decisions)"
    }
  ],
  "traces": [
    {
      "span_name": "string",
      "service": "string",
      "triggered_by": "string (e.g., HTTP request, event consumption)",
      "child_spans": ["string"]
    }
  ],
  "dashboards": [
    {
      "name": "string",
      "answers_the_question": "string",
      "key_panels": ["string"]
    }
  ],
  "alerts": [
    {
      "name": "string",
      "condition": "plain-language threshold (e.g., error rate > 5% over 5 minutes)",
      "severity": "page | warn | info",
      "runbook_hint": "what to check first when this fires"
    }
  ]
}

Then output a Markdown section titled "## Observability Plan — Human Review" with metrics grouped by service, a list of dashboards and what they answer, and a list of alerts with severity and first-response guidance.
```

---

---

## Notes on Prompt Maintenance

**Few-shot examples are the highest-leverage improvement you can make.** Once you run these prompts on a real system and get output you're happy with, add one `example_input` / `example_output` pair to each prompt. Quality improves significantly.

**The `unresolved_questions` field in every phase is your feedback loop.** If the model flags the same question repeatedly across phases, your Phase 1 scope document has a gap. Fix it upstream rather than resolving it ad hoc in later phases.

**Versioning:** Treat these prompt templates like code. When you change a prompt, increment the version comment at the top of each. A phase's output is only trustworthy relative to the prompt version that generated it.
