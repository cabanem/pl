/**
 * @fileoverview WorkatoPush.gs — HMAC-signed push to the Workato API endpoint.
 *
 * REPLACES pushToWorkato_ in ContractIntake.gs. Delete the old one there: Apps
 * Script concatenates files and lets the last-loaded duplicate win silently, so
 * two definitions is a trap, not an error.
 *
 * Scheme: HMAC-SHA256 over the canonical string "<correlation_id>.<timestamp>",
 * sent as lowercase hex in X-Signature with the timestamp in X-Timestamp. The
 * secret never travels. Workato verifies with
 *     (correlation_id + "." + timestamp).hmac_sha256(secret).encode_hex
 * and compares to X-Signature. Both ends MUST use hex — don't mix in base64.
 *
 * The secret lives in Script Property WORKATO_WEBHOOK_SECRET, never the Config
 * sheet. The X-Webhook-Secret header and the workato_shared_secret config key
 * are retired.
 */

/** @const {string} Script Property holding the shared HMAC secret. */
const WORKATO_SECRET_PROP = 'WORKATO_WEBHOOK_SECRET';

/**
 * Lowercase-hex HMAC-SHA256 of "<correlationId>.<timestamp>".
 * @param {string} secret Shared secret.
 * @param {string} correlationId
 * @param {string} timestamp Epoch milliseconds as a string.
 * @return {string} 64-character lowercase hex.
 * @private
 */
function signPush_(secret, correlationId, timestamp) {
  const canonical = correlationId + '.' + timestamp;
  const raw = Utilities.computeHmacSha256Signature(canonical, secret);
  // The bytes are SIGNED — mask each one or negative values corrupt the hex.
  return raw.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

/**
 * The HMAC secret from Script Properties.
 * @return {string}
 * @throws {Error} If the property is unset.
 * @private
 */
function workatoSecret_() {
  const s = PropertiesService.getScriptProperties().getProperty(WORKATO_SECRET_PROP);
  if (!s) throw new Error('Script Property ' + WORKATO_SECRET_PROP + ' is not set.');
  return s;
}

/**
 * Signed request headers for one push.
 * @param {string} correlationId
 * @param {string} timestamp Epoch ms string.
 * @return {Object.<string,string>}
 * @private
 */
function workatoHeaders_(correlationId, timestamp) {
  return {
    'X-Correlation-Id': correlationId,
    'X-Timestamp': timestamp,
    'X-Signature': signPush_(workatoSecret_(), correlationId, timestamp)
  };
}

/**
 * Raw POST to Workato. Returns status + body and never throws on HTTP status
 * (only on transport failure), so callers and tests can inspect any outcome.
 * @param {string} url
 * @param {Object} payload JSON-serializable body.
 * @param {Object.<string,string>} headers
 * @return {{code:number, body:string}}
 * @private
 */
function sendToWorkato_(url, payload, headers) {
  const resp = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: headers, payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  return { code: resp.getResponseCode(), body: resp.getContentText() };
}

/**
 * Production push: sign, send, throw on non-2xx so the sheet stays in pending.
 * @param {Approval} approval
 * @param {Config} cfg
 * @throws {Error} On any non-2xx response.
 * @private
 */
function pushToWorkato_(approval, cfg) {
  const ts = String(Date.now());
  const r  = sendToWorkato_(cfg.workato_webhook_url, buildPayload_(approval, cfg),
                            workatoHeaders_(approval.correlationId, ts));
  if (r.code < 200 || r.code >= 300) {
    throw new Error('Workato ' + r.code + ': ' + r.body.slice(0, 300));
  }
}
