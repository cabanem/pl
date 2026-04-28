/**
 * @file Webhook.gs (SDC library)
 * Single HTTP transport for all SDC webhook calls. Uniform retry policy,
 * uniform error contract, library-stamped payload_version.
 *
 * Public:
 *   Webhook.call(url, payload, options) → { statusCode, body, parsed }
 *
 * Retry policy:
 *   - 2xx        → success, return
 *   - 3xx        → returned as success (UrlFetchApp follows redirects;
 *                  if one slips through, pass it through unchanged)
 *   - 4xx (≠429) → permanent, throw immediately, no retry
 *   - 429        → retry with backoff (rate limit)
 *   - 5xx        → retry with backoff (transient server)
 *   - exception  → retry with backoff (network)
 *
 *   Backoff: 1s, 2s, 4s between attempts (max 3 attempts total).
 *
 * payload_version is injected by the library and cannot be overridden by
 * the caller — even if the caller's payload contains a payload_version key,
 * the library's value wins.
 */

var Webhook = {};

var WEBHOOK_MAX_ATTEMPTS = 3;
var WEBHOOK_BASE_DELAY_MS = 1000;

/**
 * POST a JSON payload to a webhook URL. Returns parsed response if JSON,
 * raw body otherwise.
 *
 * @param {string} url
 * @param {Object} payload                  - Caller payload. payload_version
 *                                            will be stamped by the library.
 * @param {Object} [options]
 * @param {number} [options.maxAttempts=3]  - Total attempts including the first.
 * @returns {{statusCode: number, body: string, parsed: (Object|null)}}
 * @throws  Error on permanent failure or after exhausting retries.
 */
Webhook.call = function(url, payload, options) {
  if (!url)     throw new Error('Webhook.call: url is required.');
  if (!payload) throw new Error('Webhook.call: payload is required.');

  var opts        = options || {};
  var maxAttempts = opts.maxAttempts || WEBHOOK_MAX_ATTEMPTS;

  // Library-controlled payload_version — non-spoofable from caller.
  var enriched = {};
  for (var k in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, k)) {
      enriched[k] = payload[k];
    }
  }
  enriched.payload_version = SDC_PAYLOAD_VERSION;

  var fetchOptions = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(enriched),
    muteHttpExceptions: true
  };

  var lastError = null;

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    var response, statusCode, body;

    try {
      response   = UrlFetchApp.fetch(url, fetchOptions);
      statusCode = response.getResponseCode();
      body       = response.getContentText();
    } catch (e) {
      lastError = new Error('Network exception on attempt ' + (attempt + 1) + ': ' + e.message);
      if (attempt < maxAttempts - 1) {
        Utilities.sleep(Webhook._backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    // 2xx and 3xx → success
    if (statusCode >= 200 && statusCode < 400) {
      return {
        statusCode: statusCode,
        body:       body,
        parsed:     Webhook._tryParseJson(body)
      };
    }

    // 4xx except 429 → permanent
    if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
      throw new Error('Webhook ' + statusCode + ' (permanent): ' + Webhook._truncate(body, 500));
    }

    // 429 or 5xx → retry-eligible
    lastError = new Error('Webhook ' + statusCode + ' on attempt ' + (attempt + 1) +
                          ': ' + Webhook._truncate(body, 500));
    if (attempt < maxAttempts - 1) {
      Utilities.sleep(Webhook._backoffMs(attempt));
    }
  }

  throw new Error('Webhook failed after ' + maxAttempts + ' attempts. Last error: ' +
                  lastError.message);
};

// --- Private helpers -------------------------------------------------

Webhook._backoffMs = function(attempt) {
  return Math.pow(2, attempt) * WEBHOOK_BASE_DELAY_MS;
};

Webhook._tryParseJson = function(body) {
  if (!body) return null;
  try { return JSON.parse(body); }
  catch (e) { return null; }
};

Webhook._truncate = function(s, max) {
  s = String(s || '');
  return s.length > max ? s.substring(0, max) + '…' : s;
};
