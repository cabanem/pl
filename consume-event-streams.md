# Consuming Workato Event Streams from Google Apps Script

A reference for reading messages off a Workato Event topic from a Google Apps Script (GAS)
project. Apps Script lives outside Workato, so it consumes through the **public consume API**
rather than a recipe trigger. The practical consequence drives the whole design: a Workato
recipe trigger has its read position managed for it by the platform, but an external consumer
owns its own cursor — and a GAS project is stateless between trigger runs, so that cursor has
to be persisted somewhere durable.

This document covers the consume endpoint, the cursor-and-idempotency discipline, the GAS
execution constraints that shape the polling design, and a complete annotated consumer.

---

## How it works

The consume endpoint is a cursor-based pull. You ask for "everything after message X," process
what comes back, then remember the ID of the last message you handled so the next call resumes
from there. Workato orders messages within a topic by publish time, so reading by
`after_message_id` walks the topic in order.

Three facts shape the GAS implementation:

- **GAS is stateless across runs.** A time-driven trigger gives you a fresh execution each
  time, so the cursor must live in `PropertiesService` (or a sheet/Drive file), not in a script
  variable. This is the single most important thing to get right.
- **Delivery is at-least-once.** You can receive the same message twice (e.g. if a run advances
  the cursor but a later step fails, or two runs overlap). Your handler must be idempotent,
  keyed on a stable field in the payload — the `event_id` in the message envelope.
- **GAS bounds your time and your fetches.** Runs are capped (about 6 minutes on consumer
  accounts, 30 on Workspace), triggers fire at most once per minute, and `UrlFetchApp` has no
  reliable, configurable request deadline. So you do not hold a long-poll open from GAS; you
  poll on the trigger cadence and let a bounded catch-up loop drain any backlog.

---

## Prerequisites

- Event streams enabled on the Workato workspace (an admin grants this feature).
- A Workato API token (from an API client) scoped for Event streams.
- The numeric topic ID of the topic you are consuming.
- The base URL for your data center (below). The consume/publish endpoints live on the
  `event-streams` domain, which is separate from the Developer API domain used to manage topics.

| Data center | Base URL |
| --- | --- |
| US | `https://event-streams.workato.com` |
| EU | `https://event-streams.eu.workato.com` |
| JP | `https://event-streams.jp.workato.com` |
| SG | `https://event-streams.sg.workato.com` |
| AU | `https://event-streams.au.workato.com` |
| Developer sandbox | `https://event-streams.trial.workato.com` |

---

## Endpoint reference

```
POST {base_url}/api/v1/topics/{topic_id}/consume
Authorization: Bearer {api_token}
Content-Type: application/json
```

Request body (all fields optional):

| Field | Type | Notes |
| --- | --- | --- |
| `after_message_id` | string | Returns messages after this ID. The recommended cursor. The ID must still exist in the topic. |
| `since_time` | string (RFC 3339) | Returns messages after a timestamp. **First-request-only.** Combined with batch publish or long polling it can reorder or skip messages, so do not use it as your steady-state cursor. |
| `batch_size` | integer | Max messages per response. Ceiling and default are both 50. |
| `timeout_secs` | integer | Long-poll wait, 0–60. `0` (default) disables long polling. Keep this low from GAS — see limits below. |

Response — messages are ordered by publish time; the last element's `message_id` is your next
cursor:

```json
{
  "messages": [
    { "message_id": "A12y", "payload": { "event_id": "…", "event_type": "…" }, "time": "2023-04-14T15:07:14.437+00:00" },
    { "message_id": "A12z", "payload": { "event_id": "…", "event_type": "…" }, "time": "2023-04-14T15:43:40.227+00:00" }
  ]
}
```

`payload` is the message body as defined by the topic schema. If you publish an observability
envelope (`event_id`, `event_type`, `occurred_at`, `correlation_id`, `recipe_name`, `status`,
`status_message`, `error_details`, `job_url`), that object is what arrives here.

---

## The consumer

Idiomatic GAS: configuration in Script Properties, trailing-underscore private helpers,
exponential backoff on transient errors, a preflight check, a script lock to prevent overlapping
runs from racing the cursor, and a bounded catch-up loop that respects both the execution-time
budget and the 60-requests-per-minute API limit.

```javascript
/**
 * Workato Event Streams consumer for Google Apps Script.
 * Entry point: consumeEventStream()  — wire this to a time-driven trigger.
 * One-time setup:  installTrigger_()
 */

const CURSOR_PROP_PREFIX = 'WORKATO_ES_CURSOR_';

// ---- Configuration (Script Properties) ----------------------------------

function getConfig_() {
  const p = PropertiesService.getScriptProperties();
  return {
    baseUrl:     (p.getProperty('WORKATO_ES_BASE_URL') || 'https://event-streams.workato.com')
                   .replace(/\/+$/, ''),
    token:       p.getProperty('WORKATO_ES_TOKEN'),
    topicId:     p.getProperty('WORKATO_ES_TOPIC_ID'),
    batchSize:   Number(p.getProperty('WORKATO_ES_BATCH_SIZE')   || 50),
    timeoutSecs: Number(p.getProperty('WORKATO_ES_TIMEOUT_SECS') || 0),
  };
}

function runPreflight_(cfg) {
  const missing = ['token', 'topicId'].filter(function (k) { return !cfg[k]; });
  if (missing.length) {
    throw new Error('Missing Script Properties: WORKATO_ES_' + missing.join(', WORKATO_ES_'));
  }
  if (cfg.batchSize < 1 || cfg.batchSize > 50) throw new Error('batch_size must be 1..50');
  if (cfg.timeoutSecs < 0 || cfg.timeoutSecs > 60) throw new Error('timeout_secs must be 0..60');
}

// ---- Cursor persistence (survives across stateless trigger runs) --------

function getCursor_(topicId) {
  return PropertiesService.getScriptProperties().getProperty(CURSOR_PROP_PREFIX + topicId);
}

function setCursor_(topicId, messageId) {
  PropertiesService.getScriptProperties().setProperty(CURSOR_PROP_PREFIX + topicId, messageId);
}

// ---- Entry point --------------------------------------------------------

function consumeEventStream() {
  const lock = LockService.getScriptLock();
  // If a previous run is still going, skip this tick rather than double-read.
  if (!lock.tryLock(5000)) return;
  try {
    const cfg = getConfig_();
    runPreflight_(cfg);
    drainTopic_(cfg);
  } finally {
    lock.releaseLock();
  }
}

// ---- Bounded catch-up loop ----------------------------------------------

function drainTopic_(cfg) {
  const startMs   = Date.now();
  const BUDGET_MS = 4 * 60 * 1000; // stay well under the ~6-min execution cap
  const MAX_PAGES = 20;            // also keep within 60 req/min

  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() - startMs > BUDGET_MS) break;

    const cursor = getCursor_(cfg.topicId);     // null on first run → reads from topic start
    const batch  = consumePage_(cfg, cursor);
    if (!batch.length) break;                    // topic drained

    for (let i = 0; i < batch.length; i++) {
      const msg = batch[i];
      processMessage_(msg);                      // must be idempotent on event_id
      setCursor_(cfg.topicId, msg.message_id);   // advance only AFTER successful processing
    }

    if (batch.length < cfg.batchSize) break;     // last (partial) page — caught up
  }
}

// ---- One consume call ---------------------------------------------------

function consumePage_(cfg, afterMessageId) {
  const body = { batch_size: cfg.batchSize, timeout_secs: cfg.timeoutSecs };
  if (afterMessageId) body.after_message_id = afterMessageId;
  // First-request-only alternative to start from a timestamp instead of the topic start:
  //   else if (cfg.sinceTime) body.since_time = cfg.sinceTime;

  const url = cfg.baseUrl + '/api/v1/topics/' + encodeURIComponent(cfg.topicId) + '/consume';

  const resp = fetchWithBackoff_(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.token },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  const data = JSON.parse(resp.getContentText() || '{}');
  return data.messages || [];
}

// ---- Exponential backoff on 429 / 5xx -----------------------------------

function fetchWithBackoff_(url, options) {
  const MAX_ATTEMPTS = 5;
  let delay = 500;
  for (let attempt = 1; ; attempt++) {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) return resp;

    const retriable = (code === 429 || code >= 500);
    if (!retriable || attempt >= MAX_ATTEMPTS) {
      throw new Error('Consume failed: HTTP ' + code + ' — ' + resp.getContentText());
    }
    Utilities.sleep(delay + Math.floor(Math.random() * 250)); // jitter
    delay = Math.min(delay * 2, 8000);
  }
}

// ---- Your handler -------------------------------------------------------

function processMessage_(msg) {
  const e = msg.payload;       // the message body, per the topic schema
  const eventId = e.event_id;  // idempotency key — make the write below a no-op on replay

  // Do the real work here. Whatever you write downstream (a sheet row, a Drive
  // file, another API) should be an upsert keyed on eventId so that re-delivery
  // or a re-run from an un-advanced cursor produces no duplicates.
}

// ---- One-time trigger install -------------------------------------------

function installTrigger_() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'consumeEventStream'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('consumeEventStream').timeBased().everyMinutes(1).create();
}
```

---

## Cursor and idempotency

The two rules that keep this correct:

1. **Advance the cursor only after a message is fully processed.** The loop above persists
   `message_id` immediately after `processMessage_` returns. If processing throws, the cursor
   stays put and the message is retried on the next run.

2. **Make the downstream write idempotent on `event_id`.** Because delivery is at-least-once and
   because a crash between "did the work" and "saved the cursor" forces a replay, you will
   sometimes see a message twice. An upsert keyed on `event_id` turns those replays into no-ops.
   Do not try to solve this by accumulating a set of seen IDs in `PropertiesService` — a single
   property value caps at roughly 9 KB and the whole store at about 500 KB, so a growing ID set
   will eventually overflow. The cursor plus an idempotent write is the bounded approach.

`after_message_id` is the only cursor you should rely on for steady-state reads. `since_time` is
a first-request convenience for starting at a timestamp; it can reorder or skip messages under
batch publish and long polling, so it is not safe as an ongoing cursor.

---

## Scheduling and limits

- **Trigger cadence.** A time-driven trigger fires at most once per minute, which sets your
  worst-case latency. The bounded catch-up loop handles bursts: a single run keeps paging until
  the topic is drained, the page is partial, the page cap is hit, or the time budget is spent.
- **Execution budget.** Runs are capped (about 6 minutes consumer / 30 minutes Workspace). The
  `BUDGET_MS` guard stops paging early so the run finishes cleanly and the cursor reflects real
  progress.
- **API rate limit.** All Event streams public API endpoints share a 60-requests-per-minute
  limit. `MAX_PAGES` keeps one run from exhausting it; `fetchWithBackoff_` handles a `429` if you
  brush against it anyway.
- **Long polling.** Apps Script does not expose a dependable, configurable `UrlFetchApp` timeout,
  and short or variable fetch deadlines are commonly reported, so do not depend on holding a
  60-second long-poll. Keep `timeout_secs` at `0` (plain polling) or a small value, and let the
  trigger cadence do the draining.
- **Payload size.** The public API caps payloads at 1 MB, and a response returns at most 50
  messages. Keep published messages small — emit references (a `job_url`, a `file_id`, a
  FileStorage link) rather than large bodies — so a single consume call comfortably fits.
- **Overlap.** `LockService` prevents a slow run and the next scheduled tick from reading
  concurrently and racing the cursor.

---

## Setup checklist

1. In the Apps Script project, open Project Settings and add Script Properties:
   - `WORKATO_ES_TOKEN` — your Workato API token
   - `WORKATO_ES_TOPIC_ID` — the numeric topic ID
   - `WORKATO_ES_BASE_URL` — your data center base URL (defaults to US if omitted)
   - `WORKATO_ES_BATCH_SIZE` — optional, 1–50 (defaults to 50)
   - `WORKATO_ES_TIMEOUT_SECS` — optional, 0–60 (defaults to 0)
2. Implement `processMessage_` for your downstream target, keyed on `event_id`.
3. Run `installTrigger_` once to create the every-minute trigger and authorize the project.
4. Watch the first executions to confirm the cursor advances and downstream writes land.

---

## Where this fits

This API-pull pattern is the right tool specifically because the consumer is outside Workato. If
the same logic lived inside Workato, a recipe's new-message trigger would manage the read
position for you and you would not write any cursor code at all — that is the trade you accept by
consuming from GAS: more control over an external system, in exchange for owning the cursor and
the idempotency yourself.

If you want a holding area for messages your handler cannot process (a malformed payload, a
downstream outage), add a lightweight dead-letter step inside `processMessage_` — append the raw
message to a sheet or Drive file and return normally, so a single bad message does not wedge the
cursor behind it. That keeps the consumer making forward progress while preserving anything it
could not handle for later inspection.
