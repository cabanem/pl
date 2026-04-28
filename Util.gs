/**
 * @file Util.gs (SDC library)
 * Small, pure (or near-pure) primitives used across the library and
 * available to consumers. Nothing here knows about the SDC domain;
 * if it does, it belongs in a domain namespace.
 *
 * Public:
 *   Util.coerceTruthy(value)              → boolean
 *   Util.isValidEmailShape(email)         → boolean
 *   Util.newCorrelationId()               → string
 *   Util.findValueRightOfLabel(sheet, lbl) → * | null
 *   Util.getActiveUserEmail(fallback)     → string
 */

var Util = {};

var TRUTHY_VALUES = Object.freeze(new Set(['true', '1', 'yes']));

/**
 * Coerce a cell value to boolean. Recognizes native true, and the strings
 * "true" / "1" / "yes" (case-insensitive, trimmed). Everything else → false.
 */
Util.coerceTruthy = function(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined || value === '') return false;
  return TRUTHY_VALUES.has(String(value).trim().toLowerCase());
};

/**
 * Lightweight email shape validator. Catches blanks, missing @, missing TLD.
 * Not a full RFC 5322 validator — that's a different problem.
 */
Util.isValidEmailShape = function(email) {
  if (typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
};

/**
 * Generate a new correlation ID for tracing a request across the SDC stack.
 * Currently a UUID; centralized here so future changes (prefixes, traceparent
 * compatibility, alternate ID schemes) are a single-function update.
 */
Util.newCorrelationId = function() {
  return Utilities.getUuid();
};

/**
 * Search a sheet for a label string and return the first non-empty value
 * found in the up-to-three columns to its right.
 *
 * Designed for the 1_customer layout: labels in column B, values in C
 * (with D/E as fallbacks for two-column-wide value cells or merged cells).
 *
 * The "right of" in the name is load-bearing — this function works because
 * of how labels are positioned in the sheet, not because of any magical
 * lookup. If your sheet has labels with values below or beside-but-left,
 * this is not the function you want.
 *
 * Treats 0 and false as valid values — only null, undefined, and '' are blank.
 *
 * @param {Sheet}  sheet
 * @param {string} label - Matched case-insensitively after trim.
 * @returns {*} Value or null.
 */
Util.findValueRightOfLabel = function(sheet, label) {
  if (!sheet || !label) return null;

  var data   = sheet.getDataRange().getValues();
  var target = String(label).toLowerCase().trim();

  var notBlank = function(v) { return v !== null && v !== undefined && v !== ''; };

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    for (var j = 0; j < row.length; j++) {
      if (String(row[j]).toLowerCase().trim() === target) {
        var maxOffset = Math.min(3, row.length - j - 1);
        for (var k = 1; k <= maxOffset; k++) {
          if (notBlank(row[j + k])) return row[j + k];
        }
        return null;
      }
    }
  }
  return null;
};

/**
 * Read the active user's email with defensive try/catch and fallback.
 *
 * Session.getActiveUser().getEmail() can throw in some trigger contexts
 * (where the user identity isn't available) and can return empty string
 * when scopes aren't granted. Both cases collapse to the fallback here.
 *
 * Three call sites in v1.0: Log.append, Validate.run, Portal.run.
 *
 * @param {string} [fallback='unknown'] - Returned on missing identity.
 * @returns {string}
 */
Util.getActiveUserEmail = function(fallback) {
  fallback = fallback === undefined ? 'unknown' : fallback;
  try {
    return Session.getActiveUser().getEmail() || fallback;
  } catch (e) {
    return fallback;
  }
};
