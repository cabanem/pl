/**
 * @file Schema.gs (SDC library)
 * Structural facts about the SDC workbook. Library-owned and immutable
 * within a major schema version. Workbook owners do NOT override these
 * via _developer_settings — that's the contract boundary established
 * for v1.0.
 *
 * Anything in this file changing means the schema_version must bump and
 * a corresponding entry must land in Migrations.
 *
 * Exports (all top-level for cross-file access within the library):
 *   CONNECTOR_SHEETS         - Set of sheet names the connector reads.
 *   CONNECTOR_SHEETS_ORDER   - Array of the same names in canonical order.
 *   FORM_LAYOUT              - 7_form sheet structural constants.
 *   VARIANT_LAYOUT           - 6_variants sheet structural constants.
 *   PRIMARY_KEY_COLUMNS      - PK column definitions per sheet.
 *   Labels                   - Label strings used in 1_customer.
 *
 * Co-located here because they all answer the same question: "what is
 * the structural shape of an SDC workbook?" Splitting them across files
 * would obscure the fact that they version together.
 */

// --- Connector sheets ------------------------------------------------

/**
 * Sheets the SDC Platform Connector expects in the serialized JSON.
 * Everything else (START_HERE, .user_guide, .math_notation, .regex,
 * _script_logs, _developer_settings) is excluded.
 *
 * Membership is checked via Set.has() in preflight; serialization
 * iterates CONNECTOR_SHEETS_ORDER for stable JSON output.
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
 * Canonical iteration order for serialization. Producing JSON with
 * stable key order makes diffs across re-publishes meaningful and
 * removes "why did the JSON change when I didn't change anything"
 * surprises caused by user tab reordering.
 *
 * Must contain exactly the same names as CONNECTOR_SHEETS — guarded
 * at library load (see bottom of file).
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

// --- 7_form layout ---------------------------------------------------

/**
 * 0-indexed row/column positions in the 7_form sheet. Used by
 * Drive.buildFieldVisibilityMap to extract the field-name → visible
 * map without inline magic numbers.
 *
 *   HEADER_ROW:  index of the header row containing
 *                "All fields | Data type | … | Visible?"
 *   DATA_START:  index of the first field row
 *   FIELD_COL:   column B — field name (cast from 4_fields)
 *   VISIBLE_COL: column G — checkbox boolean
 */
var FORM_LAYOUT = Object.freeze({
  HEADER_ROW:  4,
  DATA_START:  5,
  FIELD_COL:   1,
  VISIBLE_COL: 6
});

// --- 6_variants layout -----------------------------------------------

/**
 * 0-indexed row/column positions in the 6_variants sheet. Used by
 * Variant.serializeAll to extract per-variant field inclusion.
 *
 *   HEADER_ROW:        row 5 (index 4) — "All fields | Data type | … | Variants"
 *                      Variant names cascade from G5 via TRANSPOSE formula.
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
 * Primary-key column definitions. Each entry: in this sheet, this
 * 0-indexed column gets a PK named this, and data starts at this row.
 *
 * Replaces the four parallel comma-separated arrays under the
 * primary_keys category in pre-v1.0 _developer_settings.
 *
 * NOTE (v1.0 reconciliation pending): the values below are placeholders
 * lifted from an early draft. The actual workbook shows _pk_<name>_
 * fieldName conventions and varying dataStartRow values per sheet. To
 * be reconciled before v1.0 ship — see the SDC reconciliation thread.
 */
var PRIMARY_KEY_COLUMNS = Object.freeze([
  Object.freeze({ sheetName: '4_fields',   colIndex: 1, fieldName: '_pk_fields_',         dataStartRow: 9 }),
  Object.freeze({ sheetName: '5_lookups',  colIndex: 1, fieldName: '_pk_lookup_table_',   dataStartRow: 9 }),
  Object.freeze({ sheetName: '6_variants', colIndex: 1, fieldName: '_pk_variants_',       dataStartRow: 6 }),
  Object.freeze({ sheetName: '3_users',    colIndex: 1, fieldName: '_pk_users_',          dataStartRow: 9 })
]);

// --- 1_customer labels -----------------------------------------------

/**
 * Label strings searched for in the 1_customer sheet via
 * Util.findValueRightOfLabel. Structural per the v1.0 contract:
 * the workbook template owns these strings and clients don't edit them.
 *
 * Renaming any of these is a major schema bump because every workbook
 * built against v1.x has the old text in cell B<n>, and Util.findValueRightOfLabel
 * matches case-insensitively but exactly otherwise.
 */
var Labels = Object.freeze({
  customerName:      'Customer name',
  analystEmail:      'Analyst email address',
  folderId:          'Where should we save the template (Google Drive folder ID)?',
  separateWorkspace: 'Is a separate Workato workspace required?',
  targetVMS:         'What is the target vendor management system (VMS)?'
});

// --- Load-time guards ------------------------------------------------

/**
 * Self-check: Set and ordered array must agree. Catches the case where
 * a sheet is added to one but not the other — a silent bug in
 * serialization or preflight that would otherwise only surface in
 * production output.
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
})();
