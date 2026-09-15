/**
 * @file 003_Schema.gs
 * Structural facts about the SDC workbook. Library-owned and immutable within a major schema version. 
 * Boundary contract: Workbook owners do NOT override these via _developer_settings.
 *
 * Anything in this file changing means the schema_version must bump and a corresponding entry must land in Migrations.
 *
 * Exports (all top-level for cross-file access within the library):
 *   CONNECTOR_SHEETS         - Set of sheet names the connector reads.
 *   CONNECTOR_SHEETS_ORDER   - Array of the same names in canonical order.
 *   FORM_LAYOUT              - 7_form sheet structural constants.
 *   VARIANT_LAYOUT           - 6_variants sheet structural constants.
 *   PRIMARY_KEY_COLUMNS      - PK column definitions per sheet.
 *   Labels                   - Label strings used in 1_customer.
 *
 * Co-located here because they all answer the same question: "what is the structural shape of an SDC workbook?" 
 * Splitting them across files would obscure the fact that they version together.
 */


// --- Connector sheets ------------------------------------------------
/**
 * Sheets the SDC Platform Connector expects in the serialized JSON.
 * Everything else (START_HERE, .user_guide, .math_notation, .regex, _script_logs, _developer_settings) is excluded.
 *
 * Membership is checked via Set.has() in preflight; serialization iterates CONNECTOR_SHEETS_ORDER for stable JSON output.
 */
var CONNECTOR_SHEETS = Object.freeze(new Set([
  '1_customer',
  '2_suppliers',
  '3_users',
  '4_fields',
  '4_complex_validations',
  '5_lookups',
  '6_variants',
  '7_form',
  '_error_translation',
  '_mapping'
]));

/**
 * Canonical iteration order for serialization. Producing JSON with stable key order makes diffs across re-publishes 
 * meaningful and removes "why did the JSON change when I didn't change anything" surprises caused by user tab reordering.
 *
 * Must contain exactly the same names as CONNECTOR_SHEETS — guarded at library load (see bottom of file).
 */
var CONNECTOR_SHEETS_ORDER = Object.freeze([
  '1_customer',
  '2_suppliers',
  '3_users',
  '4_fields',
  '4_complex_validations',
  '5_lookups',
  '6_variants',
  '7_form',
  '_error_translation',
  '_mapping'
]);

var FIELDS_LAYOUT = Object.freeze({
  HEADER_ROW:           7,  // 0-indexed, this is row 8
  DATA_START:           8,  // row 9
  FIELD_NAME_COL:       2,  // column C - "Field name"
  SUPPLIER_HIDDEN_COL:  17
});


// --- 7_form layout ---------------------------------------------------
/**
 * 0-indexed row/column positions in the 7_form sheet. Used by Drive.buildFieldVisibilityMap to extract the
 * field-name → visible map without inline magic numbers.
 *
 *   HEADER_ROW:  index of the header row containing "All fields | Data type | … | Visible?"
 *   DATA_START:  index of the first field row
 *   FIELD_COL:   column B — field name (cast from 4_fields)
 *   VISIBLE_COL: column G — checkbox boolean
 */
var FORM_LAYOUT = Object.freeze({
  HEADER_ROW:         4,
  DATA_START:         5,
  FIELD_COL:          1,
  VISIBLE_COL:        6
});


// --- 6_variants layout -----------------------------------------------
/**
 * 0-indexed row/column positions in the 6_variants sheet. Used by
 * Variant.serializeAll to extract per-variant field inclusion.
 *
 *   HEADER_ROW:        row 5 (index 4) — "All fields | Data type | … | Variants" Variant names cascade from G5 via TRANSPOSE formula.
 *   DATA_START:        row 6 (index 5) — first field row
 *   FIELD_NAME_COL:    column B (index 1) — field name (cast from 4_fields)
 *   VARIANT_COL_START: column G (index 6) — first variant inclusion column
 */
var VARIANT_LAYOUT = Object.freeze({
  HEADER_ROW:        4,
  DATA_START:        5,
  FIELD_NAME_COL:    1,
  VARIANT_COL_START: 6
});


// --- Primary-key columns ---------------------------------------------
/**
 * Primary-key column definitions. Each entry: in this sheet, this 0-indexed column gets a PK named this, and data starts at this row.
 *
 * Replaces the four parallel comma-separated arrays under the primary_keys category in pre-v1.0 _developer_settings.
 *
 * NOTE (v1.0 reconciliation pending): the values below are placeholders lifted from an early draft. The actual workbook shows _pk_<name>_
 * fieldName conventions and varying dataStartRow values per sheet.
 */
var PRIMARY_KEY_COLUMNS = Object.freeze([
  Object.freeze({ sheetName: '4_fields',   colIndex: 1, fieldName: '_pk_fields_',         dataStartRow: 9 }),
  Object.freeze({ sheetName: '5_lookups',  colIndex: 1, fieldName: '_pk_lookup_table_',   dataStartRow: 9 }),
  Object.freeze({ sheetName: '6_variants', colIndex: 1, fieldName: '_pk_variants_',       dataStartRow: 6 }),
  Object.freeze({ sheetName: '3_users',    colIndex: 1, fieldName: '_pk_users_',          dataStartRow: 9 })
]);

// --- 1_customer labels -----------------------------------------------
/**
 * Label strings printed in the 1_customer sheet (column C in the v0.9.9 template layout:
 * B = row number, C = label, D = value, E = required marker).
 *
 * Since schema 1.4 the NAMED RANGE is the read contract and these strings are presentation copy, the self-heal
 * fallback (Util.findLabelCell), and the migration anchor. A wording change is therefore a MINOR schema bump:
 * the migration re-stamps each label cell at its named range's row so every workbook converges on the current text.
 * Historical wording lives in the migration that retired it, never here.
 *
 * Schema 1.6: all labels aligned to the v0.9.9 template wording; two seed-row labels added.
 */
var Labels = Object.freeze({
  analystEmail:         'Analyst email address',
  applicationName:      'Application name',
  customerName:         'Customer name',
  expectedDate:         'Expected completion date',
  folderId:             'Drive folder ID',
  hasSeedData:          'Incumbent data flag',
  kickoffEmailBody:     'Kick off email instructions',
  lastDayForSubmission: 'Last day for data submission',
  reminderDays:         'Reminder cadence',
  seedDataDriveId:      'Seed data Drive file ID',
  seedDataSheetName:    'Seed data sheet name',
  seedDataIndexKey:     'Seed data index key',
  seedDataHeaderRow:    'Seed data header row',
  seedDataFirstDataRow: 'Seed data first data row',
  supplierInstructions: 'Portal instructions',
  targetVMS:            'Target VMS',
  variantCount:         'Variant count'
});

// --- 1_customer field registry (schema 1.4+) --------------------------
/**
 * Machine-addressable definitions for every value the library reads off 1_customer. As of schema 1.4 the NAMED RANGE is the 
 * read contract; the label string is presentation copy, a self-heal fallback, and migration anchor. Editing question wording in a workbook no longer breaks reads.
 *
 * Each entry:
 *   key         - property name on the customerData object (Preflight result).
 *   rangeName   - workbook-scoped named range anchored on the VALUE cell.
 *   label       - Labels.* question text (fallback + heal + error copy).
 *   friendly    - short field name used in "missing fields" error messages.
 *   valueOffset - columns right of the label cell where the value lives. Used ONLY when (re)creating the named range from a label
 *                 hit; once the range exists, layout is irrelevant.
 *   type        - 'string' | 'int' | 'intList' | 'date' | 'bool'
 *   required    - required for the PROVISION flow (validate/preview pass requireCustomerData: false and skip these checks).
 *
 */
var CUSTOMER_FIELDS = Object.freeze([
  Object.freeze({ key: 'clientName',           rangeName: 'cfg_customer_name',            label: Labels.customerName,         friendly: 'Customer name',             valueOffset: 1, type: 'string',  required: true  }),
  Object.freeze({ key: 'analystEmail',         rangeName: 'cfg_analyst_email',            label: Labels.analystEmail,         friendly: 'Analyst email address',     valueOffset: 1, type: 'string',  required: true  }),
  Object.freeze({ key: 'applicationName',      rangeName: 'cfg_application_name',         label: Labels.applicationName,      friendly: 'Application name',          valueOffset: 1, type: 'string',  required: true  }),
  Object.freeze({ key: 'targetVms',            rangeName: 'cfg_target_vms',               label: Labels.targetVMS,            friendly: 'Target VMS',                valueOffset: 1, type: 'string',  required: false }),
  Object.freeze({ key: 'outputDriveFolderId',  rangeName: 'cfg_output_folder_id',         label: Labels.folderId,             friendly: 'Drive folder ID',           valueOffset: 1, type: 'string',  required: true  }),
  Object.freeze({ key: 'reminderDays',         rangeName: 'cfg_reminder_days',            label: Labels.reminderDays,         friendly: 'Reminder cadence',          valueOffset: 1, type: 'intList', required: true  }),
  Object.freeze({ key: 'supplierInstructions', rangeName: 'cfg_supplier_instructions',    label: Labels.supplierInstructions, friendly: 'Supplier instructions',     valueOffset: 1, type: 'string',  required: false }),
  Object.freeze({ key: 'kickoffEmailBody',     rangeName: 'cfg_kickoff_email_body',       label: Labels.kickoffEmailBody,     friendly: 'Kick off email body',       valueOffset: 1, type: 'string',  required: false }),
  Object.freeze({ key: 'lastDayForSubmission', rangeName: 'cfg_last_day_for_submission',  label: Labels.lastDayForSubmission, friendly: 'Last day for submission',   valueOffset: 1, type: 'date',    required: true  }),
  Object.freeze({ key: 'hasSeedData',          rangeName: 'cfg_has_seed_data',            label: Labels.hasSeedData,          friendly: 'Incumbent data flag',       valueOffset: 1, type: 'bool',    required: false }),
  Object.freeze({ key: 'seedDataDriveId',      rangeName: 'cfg_seed_data_drive_id',       label: Labels.seedDataDriveId,      friendly: 'Seed data Drive file ID',   valueOffset: 1, type: 'string',  required: false }),
  Object.freeze({ key: 'seedDataSheetName',    rangeName: 'cfg_seed_data_sheet_name',     label: Labels.seedDataSheetName,    friendly: 'Seed data sheet name',      valueOffset: 1, type: 'string',  required: false }),
  Object.freeze({ key: 'seedDataIndexKey',     rangeName: 'cfg_seed_data_index_key',      label: Labels.seedDataIndexKey,     friendly: 'Seed data index key',       valueOffset: 1, type: 'string',  required: false }),
  Object.freeze({ key: 'seedDataHeaderRow',    rangeName: 'cfg_seed_data_header_row',     label: Labels.seedDataHeaderRow,    friendly: 'Seed data header row',      valueOffset: 1, type: 'int',     required: false }),
  Object.freeze({ key: 'seedDataFirstDataRow', rangeName: 'cfg_seed_data_first_data_row', label: Labels.seedDataFirstDataRow, friendly: 'Seed data first data row',  valueOffset: 1, type: 'int',     required: false }),
  Object.freeze({ key: 'expectedDate',         rangeName: 'cfg_expected_date',            label: Labels.expectedDate,         friendly: 'Expected completion date',  valueOffset: 1, type: 'date',    required: true  }),
  Object.freeze({ key: 'variantCount',         rangeName: 'cfg_variant_count',            label: Labels.variantCount,         friendly: 'Variant count',             valueOffset: 1, type: 'int',     required: false })
]);
// --- Load-time guards ------------------------------------------------
/**
 * Self-check: Set and ordered array must agree. Catches the case where a sheet is added to one but not the other.
 */
(function() {
  if (CONNECTOR_SHEETS_ORDER.length !== CONNECTOR_SHEETS.size) {
    throw new Error(
      'SDC library Schema.gs: CONNECTOR_SHEETS (size ' + CONNECTOR_SHEETS.size +
      ') and CONNECTOR_SHEETS_ORDER (length ' + CONNECTOR_SHEETS_ORDER.length +
      ') are out of sync.'
    );
  }
  for (var i = 0; i < CONNECTOR_SHEETS_ORDER.length; i++) {
    var name = CONNECTOR_SHEETS_ORDER[i];
    if (!CONNECTOR_SHEETS.has(name)) {
      throw new Error(
        'SDC library Schema.gs: "' + name + '" is in CONNECTOR_SHEETS_ORDER ' +
        'but not in CONNECTOR_SHEETS. Add it to both, or remove from order.'
      );
    }
  }

  // PK columns: each must reference a known connector sheet.
  PRIMARY_KEY_COLUMNS.forEach(function(cfg) {
    if (!CONNECTOR_SHEETS.has(cfg.sheetName)) {
      throw new Error(
        'SDC library Schema.gs: PRIMARY_KEY_COLUMNS references "' + cfg.sheetName +
        '" which is not in CONNECTOR_SHEETS.'
      );
    }
  });

  // Labels keys referenced by library code must exist - a missing key reads as undefined and produces silent nulls, not errors.
  ['customerName','analystEmail','targetVMS','applicationName','folderId','reminderDays','supplierInstructions', 'lastDayForSubmission',
   'kickoffEmailBody','hasSeedData','seedDataDriveId','seedDataSheetName', 'seedDataIndexKey','seedDataHeaderRow','seedDataFirstDataRow',
   'expectedDate','variantCount'].forEach(function(k) {
    if (!(k in Labels)) {
      throw new Error('Schema.gs: Labels.' + k +
        ' is referenced by library code but not defined.');
    }
  });
})();

// Customer fields integrity
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

// Chain contract
(function() {
  for (var i = 0; i < MIGRATION_CHAIN.length; i++) {
    var s = MIGRATION_CHAIN[i];
    if (!s.from || !s.to || typeof s.run !== 'function') {
      throw new Error('Migrations.gs: MIGRATION_CHAIN[' + i + '] (' +
        (s.from || '?') + ' -> ' + (s.to || '?') +
        ') must declare from, to, and run(ss). Found keys: [' + Object.keys(s).join(', ') + '].');
    }
    if (i > 0 && s.from !== MIGRATION_CHAIN[i - 1].to) {
      throw new Error('Migrations.gs: MIGRATION_CHAIN[' + i + '] from "' + s.from +
        '" does not continue from "' + MIGRATION_CHAIN[i - 1].to + '".');
    }
  }
})();
