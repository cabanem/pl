/**
 * SDC library — schema 1.4 changeset
 * ===================================
 * (1) 1_customer reads move from label-text search to named ranges, with
 *     label search retained as a self-healing fallback (Log.ensureSchema pattern).
 * (2) reminderDays1/2/3 collapse into one field: a comma-separated list in a
 *     single cell, shipped on the wire as reminder_days (array of positive ints).
 *
 * Version axes: LIBRARY 1.4.0 -> 1.5.0, PAYLOAD 7.0 -> 8.0, SCHEMA 1.3 -> 1.4.
 *
 * Sections below are ordered to match the existing file layout. Each banner
 * names the target file and whether the block is an ADD, REPLACE, or NEW FILE.
 *
 * RECONCILIATION REQUIRED before shipping (marked ⚠ inline):
 *   - CUSTOMER_FIELDS valueOffset per field (verify against the live template;
 *     I assumed value-in-C (offset 1) except expectedDate value-in-D (offset 2),
 *     per the 1.3 migration).
 *   - Labels.reminderDays final wording.
 *   - friendly names if you want different short names in error messages.
 */


// ################################################################################
// ### 000_Util.js — ADD Util.findLabelCell, REPLACE Util.findValueRightOfLabel
// ################################################################################

/**
 * Locate the CELL containing a label string. 1-based row/col, matching
 * Range coordinates. Case-insensitive after trim, first match wins
 * (top-to-bottom, left-to-right) — same match semantics as the old
 * findValueRightOfLabel, factored out so callers that need the position
 * (named-range creation, migration rewrites) share one implementation
 * with callers that need the value.
 *
 * @param {Sheet}  sheet
 * @param {string} label
 * @returns {{row: number, col: number} | null}
 */
Util.findLabelCell = function(sheet, label) {
  if (!sheet || !label) return null;

  var data   = sheet.getDataRange().getValues();
  var target = String(label).toLowerCase().trim();

  for (var i = 0; i < data.length; i++) {
    for (var j = 0; j < data[i].length; j++) {
      if (String(data[i][j]).toLowerCase().trim() === target) {
        return { row: i + 1, col: j + 1 };
      }
    }
  }
  return null;
};

/**
 * Search a sheet for a label string and return the first non-empty value
 * in the up-to-three columns to its right.
 *
 * As of schema 1.4 this is the FALLBACK read path (and the migration's
 * historical-value reader) — the primary path is named ranges via
 * Customer.read. Behavior is unchanged from 1.3; it now delegates label
 * location to Util.findLabelCell.
 *
 * Treats 0 and false as valid values — only null, undefined, and '' are blank.
 */
Util.findValueRightOfLabel = function(sheet, label) {
  var cell = Util.findLabelCell(sheet, label);
  if (!cell) return null;

  var lastCol   = sheet.getLastColumn();
  var maxOffset = Math.min(3, lastCol - cell.col);
  if (maxOffset < 1) return null;

  var notBlank = function(v) { return v !== null && v !== undefined && v !== ''; };
  var vals = sheet.getRange(cell.row, cell.col + 1, 1, maxOffset).getValues()[0];

  for (var k = 0; k < vals.length; k++) {
    if (notBlank(vals[k])) return vals[k];
  }
  return null;
};


// ################################################################################
// ### 003_Schema.js — REPLACE Labels (reminder keys), ADD CUSTOMER_FIELDS + guards
// ################################################################################

// --- Labels: REPLACE the three reminder entries with one --------------
// Remove: reminderDays1, reminderDays2, reminderDays3
// Add:
//
//   ⚠ PLACEHOLDER WORDING — set the final analyst-facing question text.
//   Post-1.4 this string is presentation + fallback, no longer the primary
//   contract, but the template and the fallback path must agree on it.
//
//   reminderDays: 'After the initial request, on which days should we remind ' +
//                 'each non-compliant supplier? (comma-separated, e.g. 7, 14, 21)',
//
// Also update the load-time Labels guard list at the bottom of Schema.gs:
// replace 'reminderDays1','reminderDays2','reminderDays3' with 'reminderDays'.


// --- 1_customer field registry (schema 1.4+) --------------------------
/**
 * Machine-addressable definitions for every value the library reads off
 * 1_customer. As of schema 1.4 the NAMED RANGE is the read contract; the
 * label string is presentation copy, a self-heal fallback, and migration
 * anchor. Editing question wording in a workbook no longer breaks reads.
 *
 * Each entry:
 *   key         - property name on the customerData object (Preflight result).
 *   rangeName   - workbook-scoped named range anchored on the VALUE cell.
 *   label       - Labels.* question text (fallback + heal + error copy).
 *   friendly    - short field name used in "missing fields" error messages.
 *   valueOffset - columns right of the label cell where the value lives.
 *                 Used ONLY when (re)creating the named range from a label
 *                 hit; once the range exists, layout is irrelevant.
 *   type        - 'string' | 'int' | 'intList' | 'date' | 'bool'
 *   required    - required for the PROVISION flow (validate/preview pass
 *                 requireCustomerData: false and skip these checks).
 *
 * ⚠ RECONCILIATION PENDING: valueOffset values below assume label-in-B /
 * value-in-C (offset 1) except expectedDate, whose value cell is D per the
 * 1.3 migration (offset 2). Verify each against the live template — merged
 * label cells shift the offset. Same status as the PRIMARY_KEY_COLUMNS note.
 */
var CUSTOMER_FIELDS = Object.freeze([
  Object.freeze({ key: 'clientName',           rangeName: 'cfg_customer_name',        label: Labels.customerName,         friendly: 'Customer name',             valueOffset: 1, type: 'string',  required: true  }),
  Object.freeze({ key: 'analystEmail',         rangeName: 'cfg_analyst_email',        label: Labels.analystEmail,         friendly: 'Analyst email address',     valueOffset: 1, type: 'string',  required: true  }),
  Object.freeze({ key: 'applicationName',      rangeName: 'cfg_application_name',     label: Labels.applicationName,      friendly: 'Application name',          valueOffset: 1, type: 'string',  required: true  }),
  Object.freeze({ key: 'targetVms',            rangeName: 'cfg_target_vms',           label: Labels.targetVMS,            friendly: 'Target VMS',                valueOffset: 1, type: 'string',  required: false }),
  Object.freeze({ key: 'outputDriveFolderId',  rangeName: 'cfg_output_folder_id',     label: Labels.folderId,             friendly: 'Drive folder ID',           valueOffset: 1, type: 'string',  required: true  }),
  Object.freeze({ key: 'reminderDays',         rangeName: 'cfg_reminder_days',        label: Labels.reminderDays,         friendly: 'Reminder cadence',          valueOffset: 1, type: 'intList', required: true  }),
  Object.freeze({ key: 'supplierInstructions', rangeName: 'cfg_supplier_instructions',label: Labels.supplierInstructions, friendly: 'Supplier instructions',     valueOffset: 1, type: 'string',  required: false }),
  Object.freeze({ key: 'kickoffEmailBody',     rangeName: 'cfg_kickoff_email_body',   label: Labels.kickoffEmailBody,     friendly: 'Kick off email body',       valueOffset: 1, type: 'string',  required: true  }),
  Object.freeze({ key: 'hasSeedData',          rangeName: 'cfg_has_seed_data',        label: Labels.hasSeedData,          friendly: 'Incumbent data flag',       valueOffset: 1, type: 'bool',    required: false }),
  Object.freeze({ key: 'seedDataDriveId',      rangeName: 'cfg_seed_data_drive_id',   label: Labels.seedDataDriveId,      friendly: 'Seed data Drive file ID',   valueOffset: 1, type: 'string',  required: false }),
  Object.freeze({ key: 'seedDataSheetName',    rangeName: 'cfg_seed_data_sheet_name', label: Labels.seedDataSheetName,    friendly: 'Seed data sheet name',      valueOffset: 1, type: 'string',  required: false }),
  Object.freeze({ key: 'seedDataIndexKey',     rangeName: 'cfg_seed_data_index_key',  label: Labels.seedDataIndexKey,     friendly: 'Seed data index key',       valueOffset: 1, type: 'string',  required: false }),
  Object.freeze({ key: 'expectedDate',         rangeName: 'cfg_expected_date',        label: Labels.expectedDate,         friendly: 'Expected completion date',  valueOffset: 2, type: 'date',    required: true  }),
  Object.freeze({ key: 'variantCount',         rangeName: 'cfg_variant_count',        label: Labels.variantCount,         friendly: 'Variant count',             valueOffset: 1, type: 'int',     required: false })
]);

// --- Load-time guard: CUSTOMER_FIELDS integrity -----------------------
// Same philosophy as the CONNECTOR_SHEETS guard: catch registry mistakes
// at library load, not mid-flow.
(function() {
  var VALID_TYPES = { string: 1, int: 1, intList: 1, date: 1, bool: 1 };
  var seenKey = {}, seenRange = {};

  CUSTOMER_FIELDS.forEach(function(d) {
    ['key', 'rangeName', 'label', 'friendly', 'type'].forEach(function(prop) {
      if (!d[prop]) {
        throw new Error('Schema.gs: CUSTOMER_FIELDS entry "' + (d.key || '?') +
          '" is missing "' + prop + '".');
      }
    });
    if (seenKey[d.key])         throw new Error('Schema.gs: duplicate CUSTOMER_FIELDS key "' + d.key + '".');
    if (seenRange[d.rangeName]) throw new Error('Schema.gs: duplicate CUSTOMER_FIELDS rangeName "' + d.rangeName + '".');
    seenKey[d.key] = 1;
    seenRange[d.rangeName] = 1;

    if (!VALID_TYPES[d.type]) {
      throw new Error('Schema.gs: CUSTOMER_FIELDS "' + d.key + '" has unknown type "' + d.type + '".');
    }
    if (typeof d.valueOffset !== 'number' || d.valueOffset < 1 || d.valueOffset > 3) {
      throw new Error('Schema.gs: CUSTOMER_FIELDS "' + d.key + '" valueOffset must be 1..3.');
    }
  });
})();


// ################################################################################
// ### 004_Customer.js — NEW FILE
// ################################################################################

/**
 * @file 004_Customer.gs (SDC library)
 * Typed reads of 1_customer, driven by the CUSTOMER_FIELDS registry.
 *
 * Read contract per field (schema 1.4+):
 *   1. Named range (rangeName)      — primary; survives label edits and
 *                                      row/column insertion, copies with the file.
 *   2. Label search + self-heal     — fallback; on a hit, the value cell is
 *                                      derived from valueOffset and the named
 *                                      range is recreated on the spot.
 *   3. Neither found                — reported on `unresolved`; the caller
 *                                      decides whether that's fatal (Preflight
 *                                      does, for required fields).
 *
 * The heal-on-read mutation is deliberate and consistent with the library's
 * existing self-healing sheets (Log.ensureSchema, ValidationReport) and with
 * PK stamping during validate.
 *
 * Broken named ranges (e.g. the anchored row was deleted, leaving a #REF!)
 * behave inconsistently across runtimes — getRangeByName may return null or
 * return a range that throws on read. Both are handled: any throw on the
 * named-range path drops to the label fallback.
 *
 * Public:
 *   Customer.read(ss, config)                  -> { values, raw, healed, unresolved }
 *   Customer.readOne(ss, config, key)          -> coerced value (null-ish when absent)
 *   Customer.ensureNamedRanges(ss, sheetName?) -> { created, existing, unresolved }
 *   Customer.parseIntList(raw)                 -> { ints, invalid }
 */

var Customer = {};

/**
 * Read every registered 1_customer field.
 *
 * @param {Spreadsheet} ss
 * @param {Object}      config - From Config.build (for config.sheets.customer).
 * @returns {{
 *   values:     Object,             // key -> coerced value (see _coerce)
 *   raw:        Object,             // key -> raw cell value (blank-vs-invalid checks)
 *   healed:     string[],           // rangeNames recreated from a label hit this read
 *   unresolved: Array<{key: string, rangeName: string, label: string}>
 * }}
 */
Customer.read = function(ss, config) {
  if (!ss)     throw new Error('Customer.read: ss is required.');
  if (!config) throw new Error('Customer.read: config is required.');

  var sheet = ss.getSheetByName(config.sheets.customer);
  if (!sheet) {
    throw new Error('Customer.read: sheet "' + config.sheets.customer + '" not found.');
  }

  var tz  = ss.getSpreadsheetTimeZone();
  var out = { values: {}, raw: {}, healed: [], unresolved: [] };

  CUSTOMER_FIELDS.forEach(function(def) {
    var r = Customer._readField(ss, sheet, def);

    if (!r.found) {
      out.unresolved.push({ key: def.key, rangeName: def.rangeName, label: def.label });
      out.raw[def.key]    = null;
      out.values[def.key] = Customer._coerce(null, def.type, tz);
      return;
    }
    if (r.healed) out.healed.push(def.rangeName);

    out.raw[def.key]    = r.raw;
    out.values[def.key] = Customer._coerce(r.raw, def.type, tz);
  });

  if (out.healed.length > 0) {
    console.log('Customer.read: recreated named range(s) from label fallback: ' +
                out.healed.join(', '));
  }
  return out;
};

/**
 * Read a single registered field. Used where reading the full set is
 * overkill (Variant._readVariantCount). Missing sheet or unresolved field
 * coerces from null (e.g. int -> null; caller maps to its own default).
 */
Customer.readOne = function(ss, config, key) {
  var def = null;
  for (var i = 0; i < CUSTOMER_FIELDS.length; i++) {
    if (CUSTOMER_FIELDS[i].key === key) { def = CUSTOMER_FIELDS[i]; break; }
  }
  if (!def) throw new Error('Customer.readOne: unknown field key "' + key + '".');

  var tz    = ss.getSpreadsheetTimeZone();
  var sheet = ss.getSheetByName(config.sheets.customer);
  if (!sheet) return Customer._coerce(null, def.type, tz);

  var r = Customer._readField(ss, sheet, def);
  return Customer._coerce(r.found ? r.raw : null, def.type, tz);
};

/**
 * Idempotently create named ranges for every registered field whose label
 * can be located. Called by the 1.3 -> 1.4 migration; safe to also call
 * best-effort from the container's onOpen shim.
 *
 * @param {Spreadsheet} ss
 * @param {string}      [customerSheetName] - Defaults to DEFAULT_SHEETS.customer.
 *                       Pass config.sheets.customer for workbooks that override it.
 * @returns {{created: string[], existing: string[],
 *            unresolved: Array<{rangeName: string, label: string}>}}
 */
Customer.ensureNamedRanges = function(ss, customerSheetName) {
  var name  = customerSheetName || DEFAULT_SHEETS.customer;
  var sheet = ss.getSheetByName(name);
  var out   = { created: [], existing: [], unresolved: [] };

  if (!sheet) {
    CUSTOMER_FIELDS.forEach(function(def) {
      out.unresolved.push({ rangeName: def.rangeName, label: def.label });
    });
    return out;
  }

  CUSTOMER_FIELDS.forEach(function(def) {
    try {
      var existing = ss.getRangeByName(def.rangeName);
      if (existing) {
        existing.getValue();   // probe: a broken (#REF!) range throws here
        out.existing.push(def.rangeName);
        return;
      }
    } catch (e) { /* broken -> recreate below */ }

    var cell = Util.findLabelCell(sheet, def.label);
    if (!cell) {
      out.unresolved.push({ rangeName: def.rangeName, label: def.label });
      return;
    }
    ss.setNamedRange(def.rangeName, sheet.getRange(cell.row, cell.col + def.valueOffset));
    out.created.push(def.rangeName);
  });

  return out;
};

/**
 * Parse a comma/semicolon/whitespace-separated list of positive integers.
 * "7, 14, 21" -> { ints: [7,14,21], invalid: [] }
 * "7, soon"   -> { ints: [7],       invalid: ['soon'] }
 * Order is preserved as entered; the wire contract carries analyst order.
 */
Customer.parseIntList = function(raw) {
  var tokens = String(raw === null || raw === undefined ? '' : raw)
    .split(/[,;\s]+/)
    .map(function(t) { return t.trim(); })
    .filter(function(t) { return t !== ''; });

  var ints = [], invalid = [];
  tokens.forEach(function(t) {
    var n = Number(t);
    if (Number.isInteger(n) && n > 0) ints.push(n);
    else invalid.push(t);
  });
  return { ints: ints, invalid: invalid };
};

// --- Private ---------------------------------------------------------

/**
 * Resolve and read one field's value cell: named range first, label
 * fallback second (healing the named range on a hit).
 *
 * @returns {{found: boolean, raw: *, healed: boolean}}
 */
Customer._readField = function(ss, sheet, def) {
  // 1. Named range — the primary contract.
  try {
    var r = ss.getRangeByName(def.rangeName);
    if (r) return { found: true, raw: r.getValue(), healed: false };
  } catch (e) {
    console.warn('Named range "' + def.rangeName + '" unreadable (' + e.message +
                 '); falling back to label search.');
  }

  // 2. Label fallback + heal.
  var cell = Util.findLabelCell(sheet, def.label);
  if (!cell) return { found: false, raw: null, healed: false };

  var valueRange = sheet.getRange(cell.row, cell.col + def.valueOffset);
  var healed = false;
  try {
    ss.setNamedRange(def.rangeName, valueRange);
    healed = true;
  } catch (e) {
    // Read still succeeds this run; the heal just didn't stick.
    console.warn('Could not recreate named range "' + def.rangeName + '": ' + e.message);
  }
  return { found: true, raw: valueRange.getValue(), healed: healed };
};

/**
 * Normalize a raw cell value at the boundary. Downstream code never sees
 * a Date object, an untrimmed string, or an unparsed list.
 */
Customer._coerce = function(raw, type, tz) {
  switch (type) {
    case 'string': {
      var s = String(raw === null || raw === undefined ? '' : raw).trim();
      return s === '' ? null : s;
    }
    case 'int': {
      var t = String(raw === null || raw === undefined ? '' : raw).trim();
      if (t === '') return null;
      var n = parseInt(t, 10);
      return isNaN(n) ? null : n;
    }
    case 'intList': return Customer.parseIntList(raw);
    case 'date':    return Util.toIsoDate(raw, tz);
    case 'bool':    return Util.coerceTruthy(raw);
    default:        return raw;
  }
};


// ################################################################################
// ### 005_Preflight.js — REPLACE the `if (options.requireCustomerData)` block
// ################################################################################

  // 5. Optional: customer data fields (provision path only).
  //    Schema 1.4+: reads go through Customer.read (named ranges with
  //    label fallback + self-heal). Required-ness and coercion are driven
  //    by the CUSTOMER_FIELDS registry.
  var customerData = {};
  if (options.requireCustomerData) {
    var read = Customer.read(ss, config);
    customerData = read.values;

    var defsByKey = {};
    CUSTOMER_FIELDS.forEach(function(d) { defsByKey[d.key] = d; });

    // 5a. Fields that could not be LOCATED at all (named range AND label
    //     both missing). Distinct from "located but blank" — and the error
    //     finally names the real cause instead of claiming the value is missing.
    var lost = read.unresolved.filter(function(u) { return defsByKey[u.key].required; });
    if (lost.length > 0) {
      throw new Error(
        'Could not locate these fields on the ' + config.sheets.customer + ' tab: ' +
        lost.map(function(u) { return '"' + u.label + '"'; }).join(', ') + '. ' +
        'Each field is read through a workbook named range (' +
        lost.map(function(u) { return u.rangeName; }).join(', ') + ') with the printed ' +
        'question text as a fallback; neither was found. This usually means the ' +
        'question wording was edited and the named range was also removed. Restore ' +
        'the wording, or recreate the named range via Data \u2192 Named ranges, then retry.'
      );
    }

    // 5b. Required-but-blank, registry-driven.
    var missingFields = [];
    CUSTOMER_FIELDS.forEach(function(def) {
      if (!def.required) return;
      var v = customerData[def.key];
      var blank;
      switch (def.type) {
        case 'intList':
          blank = v.ints.length === 0 && v.invalid.length === 0;
          break;
        case 'date': {
          var rd = read.raw[def.key];
          blank = rd === null || rd === undefined || rd === '';
          break;
        }
        case 'bool':
          blank = false;  // booleans coerce blank -> false; never "missing"
          break;
        default:
          blank = v === null;
      }
      if (blank) missingFields.push(def.friendly);
    });
    if (missingFields.length > 0) {
      throw new Error(
        'Required customer fields missing in the ' + config.sheets.customer + ' tab: ' +
        missingFields.join(', ') + '. ' +
        'All required fields must be filled in before the configuration can be sent to Workato.'
      );
    }

    // 5c. Expected date: present but not a usable date. Same semantics as 1.3 —
    //     the analyst can SEE a value; tell them why it doesn't count.
    var rawExpectedDate = read.raw.expectedDate;
    var rawDateBlank = rawExpectedDate === null || rawExpectedDate === undefined || rawExpectedDate === '';
    if (!rawDateBlank && customerData.expectedDate === null) {
      throw new Error(
        'The "' + Labels.expectedDate + '" value in the ' + config.sheets.customer +
        ' tab is not a recognizable date. Enter it via the date picker (yyyy-mm-dd). ' +
        'Text in another format, or a number formatted to look like a date, cannot be used.'
      );
    }

    // 5d. Reminder cadence: reject bad tokens, then flatten to the int array
    //     that Payload.provision ships as reminder_days.
    var cadence = customerData.reminderDays;   // { ints, invalid } from parseIntList
    if (cadence.invalid.length > 0) {
      throw new Error(
        'The "' + Labels.reminderDays + '" value contains entries that are not ' +
        'positive whole numbers: ' + cadence.invalid.join(', ') + '. ' +
        'Enter a comma-separated list of day counts, e.g. "7, 14, 21".'
      );
    }
    customerData.reminderDays = cadence.ints;
    // Optional — enable if semantics stay "offsets from the initial request":
    // for (var d = 1; d < customerData.reminderDays.length; d++) {
    //   if (customerData.reminderDays[d] <= customerData.reminderDays[d - 1]) {
    //     throw new Error('Reminder days must be strictly increasing offsets from ' +
    //                     'the initial request; got: ' + cadence.ints.join(', ') + '.');
    //   }
    // }

    // 5e. Seed data — required only when the analyst declared it. Unchanged.
    if (Util.coerceTruthy(customerData.hasSeedData)) {
      var seedMissing = [];
      if (!String(customerData.seedDataDriveId || '').trim())   seedMissing.push('Seed data Drive file ID');
      if (!String(customerData.seedDataSheetName || '').trim()) seedMissing.push('Seed data sheet name');
      if (seedMissing.length > 0) {
        throw new Error(
          'Incumbent data was marked as provided ("' + Labels.hasSeedData + '" = yes), ' +
          'but these required seed-data fields are missing in the ' + config.sheets.customer +
          ' tab: ' + seedMissing.join(', ') + '. ' +
          'Either provide these values or set the incumbent-data question to no.'
        );
      }
    }
  }

  // (return statement unchanged: Object.assign({customerSheet, integrationAccountEmail}, customerData))


// ################################################################################
// ### 003_Payload.js — REPLACE Payload.provision (reminder fields only; shown whole)
// ################################################################################

/**
 * Build the provision webhook payload.
 *
 * Wire-format change in payload_version 8.0:
 *   - reminder_days_1 / reminder_days_2 / reminder_days_3 REMOVED.
 *   - reminder_days ADDED: non-empty array of positive integers, in
 *     analyst-entered order. Semantics (offsets from initial request vs.
 *     intervals) are owned by R-1; the library ships what was entered.
 *     Variable length: one reminder or five are equally valid.
 *
 * @param {number[]} args.reminderDays - Validated by Preflight (positive ints, non-empty).
 * (all other params unchanged from 7.0)
 */
Payload.provision = function(args) {
  Payload._requireArgs(args,
    [ 'correlationId', 'clientName', 'analystEmail', 'applicationName', 'configFileId', 'expectedDate',
      'configJsonFileId', 'configFingerprint', 'isInitial', 'kickoffEmailBody', 'outputDriveFolderId',
      'reminderDays', 'hasSeedData', 'spreadsheetId'], 'provision');

  // Arrays pass the generic null/blank check; assert shape explicitly.
  if (!Array.isArray(args.reminderDays) || args.reminderDays.length === 0) {
    throw new Error('Payload.provision: "reminderDays" must be a non-empty array of positive integers.');
  }

  return {
    correlation_id:              args.correlationId,
    client_name:                 args.clientName,
    analyst_email:               args.analystEmail,
    expected_date:               args.expectedDate,
    target_vms:                  args.targetVms || '',
    config_file_id:              args.configFileId,
    drive_id_config_json:        args.configJsonFileId,
    config_fingerprint:          args.configFingerprint,
    template_file_ids:           args.templateFileIds || [],
    application_name:            args.applicationName,
    is_initial:                  Boolean(args.isInitial),
    output_drive_folder_id:      args.outputDriveFolderId,
    reminder_days:               args.reminderDays,
    supplier_instructions:       args.supplierInstructions || '',
    kick_off_email_body:         args.kickoffEmailBody,
    timestamp:                   new Date().toISOString(),
    has_seeded_data:             args.hasSeedData || false,
    seeded_data_drive_id:        args.seedDataDriveId || '',
    seeded_data_index_key:       args.seedDataIndexKey || '',
    seeded_data_sheet_name:      args.seedDataSheetName || '',
    seeded_data_xlsx_file_id:    args.seedDataXlsxFileId || '',
    spreadsheet_id:              args.spreadsheetId
  };
};


// ################################################################################
// ### 005_Provision.js — EDIT the Payload.provision call site
// ################################################################################

//  Replace:
//      reminderDays1:       pf.reminderDays1,
//      reminderDays2:       pf.reminderDays2,
//      reminderDays3:       pf.reminderDays3,
//  With:
//      reminderDays:        pf.reminderDays,     // int[]; validated + flattened by Preflight


// ################################################################################
// ### 008_Variant.js — REPLACE Variant._readVariantCount
// ################################################################################

/**
 * Read variant count via the CUSTOMER_FIELDS registry (schema 1.4+):
 * named range cfg_variant_count, with the label as fallback. Replaces the
 * direct label read, so the variant count now survives label edits like
 * every other 1_customer field. Blank / missing / negative -> 0
 * (variantCount = 0 is a legitimate state).
 */
Variant._readVariantCount = function(ss, config) {
  var n = Customer.readOne(ss, config, 'variantCount');   // int | null
  return (n === null || n < 0) ? 0 : n;
};


// ################################################################################
// ### 002_Migrations.js — ADD to MIGRATION_CHAIN (after the 1.2 -> 1.3 entry)
// ################################################################################

  {
    from: '1.3',
    to:   '1.4',
    run:  function(ss) {
      var changed = [];
      var notes   = [];
      var sheet   = ss.getSheetByName(DEFAULT_SHEETS.customer);
      if (!sheet) throw new Error('1_customer not found; cannot migrate schema to 1.4.');

      // Historical label text as LITERALS — Labels no longer carries these
      // (Labels now holds only the new single-field wording). Migrations must
      // never read historical strings from the live Labels object.
      var OLD_R1 = 'From the initial request, how many days before we send the first reminder to each non-compliant supplier?';
      var OLD_R2 = 'Second reminder?';
      var OLD_R3 = 'Third reminder?';

      // --- 1. Merge the three reminder fields into one -------------------
      var newPresent = !!Util.findLabelCell(sheet, Labels.reminderDays);
      var r1         = Util.findLabelCell(sheet, OLD_R1);

      if (newPresent) {
        notes.push('Reminder cadence field already present; merge skipped (idempotent).');
      } else if (!r1) {
        notes.push('Old first-reminder label not found; reminder merge skipped. ' +
                   'Verify 1_customer manually and add the "' + Labels.reminderDays +
                   '" field by hand if needed.');
      } else {
        // Read historical values BEFORE any rewrite (tolerant 3-column scan,
        // since pre-1.4 layouts weren't declared).
        var v1 = Util.findValueRightOfLabel(sheet, OLD_R1);
        var v2 = Util.findValueRightOfLabel(sheet, OLD_R2);
        var v3 = Util.findValueRightOfLabel(sheet, OLD_R3);
        var merged = [v1, v2, v3]
          .filter(function(v) { return v !== null && v !== undefined && String(v).trim() !== ''; })
          .join(', ');

        // Locate the registry entry for the new field's declared value offset.
        var def = null;
        for (var i = 0; i < CUSTOMER_FIELDS.length; i++) {
          if (CUSTOMER_FIELDS[i].key === 'reminderDays') { def = CUSTOMER_FIELDS[i]; break; }
        }

        // Rewrite label in place; clear the row's old value area (up to 3
        // right) so a stale single number can't sit beside the merged list.
        sheet.getRange(r1.row, r1.col).setValue(Labels.reminderDays);
        sheet.getRange(r1.row, r1.col + 1, 1, 3).clearContent();

        // The old cells likely carry NUMERIC data validation, which would
        // reject the comma-separated string. Clear validation on the target
        // before writing.
        var target = sheet.getRange(r1.row, r1.col + def.valueOffset);
        target.clearDataValidations();
        target.setValue(merged);
        changed.push('Merged reminder days into one field ("' + merged + '") at row ' + r1.row + '.');

        // Clear the now-orphaned second and third reminder rows (label +
        // value area). Content-clear rather than row-delete: preserves any
        // template formatting/merges, and post-1.3 nothing reads 1_customer
        // positionally, so empty rows are harmless. Swap to deleteRow if you
        // prefer a tighter sheet.
        [OLD_R2, OLD_R3].forEach(function(lbl) {
          var c = Util.findLabelCell(sheet, lbl);
          if (c) {
            sheet.getRange(c.row, c.col, 1, 4).clearContent();
            changed.push('Cleared retired field "' + lbl + '" at row ' + c.row + '.');
          } else {
            notes.push('Retired label "' + lbl + '" not found; nothing to clear.');
          }
        });
      }

      // --- 2. Stamp named ranges for every registered field ---------------
      // From this point forward, question wording is presentation copy;
      // reads go through the named ranges.
      var nr = Customer.ensureNamedRanges(ss, DEFAULT_SHEETS.customer);
      if (nr.created.length > 0) {
        changed.push('Created named range(s): ' + nr.created.join(', ') + '.');
      }
      if (nr.unresolved.length > 0) {
        notes.push('Could not anchor named range(s) — label text not found: ' +
          nr.unresolved.map(function(u) { return u.rangeName + ' ("' + u.label + '")'; }).join('; ') +
          '. Restore the wording (or create the range manually), then re-run this ' +
          'migration or any provision/validate — both paths self-heal.');
      }

      // --- 3. Coordination notes ------------------------------------------
      notes.push('Payload contract bumps to 8.0 with this schema: reminder_days_1/2/3 ' +
                 'replaced by reminder_days (int array). R-1 must handshake 8.0 before ' +
                 'workbooks on this library provision.');
      notes.push('If any recipe parses reminder values from the serialized 1_customer ' +
                 'GRID (config JSON) rather than the provision payload, that parse must ' +
                 'change in the same coordinated release.');

      return { changed: changed, notes: notes };
    }
  }


// ################################################################################
// ### 008_Version.js — REPLACE version block + append history
// ################################################################################

/**
 * --- Payload version history (append) --------------------------------
 *   8.0 - Provision payload: removed reminder_days_1/2/3; added reminder_days
 *         (required, non-empty array of positive integers, analyst-entered
 *         order preserved; sourced from the single reminder-cadence field on
 *         1_customer via Preflight/Customer). Validate and portal-invite
 *         payloads unchanged.
 *
 * --- Schema 1.4 (for the file header) --------------------------------
 *   1_customer reads move to named ranges (CUSTOMER_FIELDS registry) with
 *   label fallback + self-heal. Three reminder fields merge into one.
 *   NOTE: from 1.4 on, a label REWORDING alone is a MINOR schema bump
 *   (cosmetic migration rewrites the text; the read contract — the named
 *   range — is unaffected). Adding/removing/retargeting a named range
 *   remains a major bump.
 */

var Version = Object.freeze({
  LIBRARY: '1.5.0',
  PAYLOAD: '8.0',
  SCHEMA:  '1.4'
});

var SDC_LIBRARY_VERSION = Version.LIBRARY;
var SDC_PAYLOAD_VERSION = Version.PAYLOAD;
var SDC_SCHEMA_VERSION  = Version.SCHEMA;


// ################################################################################
// ### Container shim (onOpen) — OPTIONAL one-liner
// ################################################################################

// Best-effort, sibling to Log.ensureSchema; heals deleted named ranges on
// open instead of waiting for the next flow's read-path heal:
//
//   try { SDC.Customer.ensureNamedRanges(ss); } catch (e) { console.warn(e.message); }
//
// Optional hardening beyond this changeset: warning-only protection on the
// label cells in column B (the PK-column pattern) — it won't stop edits, but
// the "are you sure?" dialog cuts casual rewording dramatically. With named
// ranges as the contract it's belt-and-suspenders, so I left it out of 1.4.
