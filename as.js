// =============================================================================
// ADR Tracker — Google Sheets + Apps Script Implementation
// =============================================================================
//
// Architecture:
//   - Each "table" is a named sheet (tab)
//   - Row 1 = headers (frozen)
//   - Column A = UUID primary key (auto-generated)
//   - Apps Script enforces all business rules that PG triggers handled
//   - Computed "view" sheets refresh on demand or via time trigger
//
// Files:
//   Setup.gs      — This file. Sheet creation, menus, data validation.
//   Core.gs       — UUID gen, timestamp helpers, lookup utilities.
//   Triggers.gs   — onEdit / onChange handlers for live validation.
//   Rules.gs      — Business rule enforcement (outcome↔decided, etc.)
//   Views.gs      — Computed view generation (readiness, progress).
//   Queries.gs    — "Report" functions callable from menu or sidebar.
//
// =============================================================================

// ---------------------------------------------------------------------------
// SHEET DEFINITIONS — Single source of truth for structure
// ---------------------------------------------------------------------------

const SCHEMA = {
  projects: {
    headers: ['id', 'name', 'description', 'status', 'created_at', 'updated_at', 'deleted_at'],
    validations: {
      status: ['Active', 'Archived', 'OnHold']
    },
    required: ['name']
  },
  requirement_groups: {
    headers: ['id', 'project_id', 'name', 'description', 'sort_order', 'created_at', 'updated_at', 'deleted_at'],
    validations: {},
    required: ['project_id', 'name'],
    fks: { project_id: 'projects' }
  },
  requirements: {
    headers: ['id', 'project_id', 'group_id', 'title', 'body', 'type', 'status', 'priority', 'rationale', 'sort_order', 'created_at', 'updated_at', 'deleted_at'],
    validations: {
      type: ['Functional', 'NonFunctional', 'Constraint'],
      status: ['Draft', 'Ready', 'InProgress', 'Done', 'Dropped'],
      priority: ['P0', 'P1', 'P2', 'P3']
    },
    required: ['project_id', 'title'],
    fks: { project_id: 'projects', group_id: 'requirement_groups' },
    nullableFks: ['group_id']
  },
  decisions: {
    headers: ['id', 'project_id', 'title', 'context', 'status', 'decided_at', 'created_at', 'updated_at', 'deleted_at'],
    validations: {
      status: ['Open', 'Decided', 'Deferred']
    },
    required: ['project_id', 'title'],
    fks: { project_id: 'projects' }
  },
  decision_outcomes: {
    headers: ['id', 'decision_id', 'chosen_option_id', 'summary', 'consequences', 'created_at', 'updated_at', 'deleted_at'],
    validations: {},
    required: ['decision_id', 'summary'],
    fks: { decision_id: 'decisions', chosen_option_id: 'options' },
    nullableFks: ['chosen_option_id']
  },
  options: {
    headers: ['id', 'decision_id', 'title', 'description', 'pros', 'cons', 'sort_order', 'created_at', 'updated_at', 'deleted_at'],
    validations: {},
    required: ['decision_id', 'title'],
    fks: { decision_id: 'decisions' }
  },
  tradeoffs: {
    headers: ['id', 'option_id', 'dimension', 'assessment', 'severity', 'created_at', 'updated_at', 'deleted_at'],
    validations: {
      severity: ['Low', 'Medium', 'High', 'Critical']
    },
    required: ['option_id', 'dimension'],
    fks: { option_id: 'options' }
  },
  risks: {
    headers: ['id', 'project_id', 'decision_id', 'title', 'description', 'likelihood', 'impact', 'mitigation', 'status', 'created_at', 'updated_at', 'deleted_at'],
    validations: {
      likelihood: ['Low', 'Medium', 'High'],
      impact: ['Low', 'Medium', 'High', 'Critical'],
      status: ['Open', 'Mitigated', 'Accepted', 'Closed']
    },
    required: ['project_id', 'title'],
    fks: { project_id: 'projects', decision_id: 'decisions' },
    nullableFks: ['decision_id']
  },
  questions: {
    headers: ['id', 'project_id', 'decision_id', 'question', 'answer', 'status', 'answered_at', 'created_at', 'updated_at', 'deleted_at'],
    validations: {
      status: ['Open', 'Answered', 'Deferred']
    },
    required: ['project_id', 'question'],
    fks: { project_id: 'projects', decision_id: 'decisions' },
    nullableFks: ['decision_id']
  },
  requirement_decision_links: {
    headers: ['id', 'requirement_id', 'decision_id', 'relationship', 'notes', 'created_at', 'updated_at', 'deleted_at'],
    validations: {
      relationship: ['Requires', 'EnabledBy', 'ConstrainedBy', 'BlockedBy', 'Impacts']
    },
    required: ['requirement_id', 'decision_id', 'relationship'],
    fks: { requirement_id: 'requirements', decision_id: 'decisions' }
  },
  decision_interactions: {
    headers: ['id', 'decision_id', 'related_decision_id', 'interaction_type', 'notes', 'created_at', 'updated_at', 'deleted_at'],
    validations: {
      interaction_type: ['DependsOn', 'ConflictsWith', 'Supersedes', 'InformedBy']
    },
    required: ['decision_id', 'related_decision_id', 'interaction_type'],
    fks: { decision_id: 'decisions', related_decision_id: 'decisions' }
  },
  entity_links: {
    headers: ['id', 'project_id', 'source_type', 'source_id', 'target_type', 'target_id', 'relationship', 'notes', 'created_at', 'updated_at', 'deleted_at'],
    validations: {
      source_type: ['project', 'requirement_group', 'requirement', 'decision', 'option', 'tradeoff', 'risk', 'question', 'decision_outcome'],
      target_type: ['project', 'requirement_group', 'requirement', 'decision', 'option', 'tradeoff', 'risk', 'question', 'decision_outcome']
    },
    required: ['project_id', 'source_type', 'source_id', 'target_type', 'target_id', 'relationship'],
    fks: { project_id: 'projects' }
  }
};

// View sheets (computed, not user-editable)
const VIEW_SHEETS = ['_decision_readiness', '_project_progress', '_next_actions'];

// Tab colors for visual organization
const TAB_COLORS = {
  projects: '#4285F4',             // Blue — top level
  requirement_groups: '#34A853',   // Green — requirements family
  requirements: '#34A853',
  decisions: '#FBBC04',            // Yellow — decisions family
  decision_outcomes: '#FBBC04',
  options: '#FBBC04',
  tradeoffs: '#FBBC04',
  risks: '#EA4335',                // Red — risks
  questions: '#FF6D01',            // Orange — questions
  requirement_decision_links: '#9334E6',  // Purple — junctions
  decision_interactions: '#9334E6',
  entity_links: '#9334E6',
  _decision_readiness: '#A8A8A8',  // Gray — computed views
  _project_progress: '#A8A8A8',
  _next_actions: '#A8A8A8'
};

// ---------------------------------------------------------------------------
// MENU
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🏗️ ADR Tracker')
    .addItem('📋 Initial Setup (create all sheets)', 'setupAllSheets')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('📊 Refresh Views')
      .addItem('Decision Readiness', 'refreshDecisionReadiness')
      .addItem('Project Progress', 'refreshProjectProgress')
      .addItem('Next Actions', 'refreshNextActions')
      .addItem('All Views', 'refreshAllViews'))
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('🔍 Reports')
      .addItem('Unlinked Requirements', 'reportUnlinkedRequirements')
      .addItem('Decisions Missing Options', 'reportDecisionsMissingOptions')
      .addItem('Blocked Requirements', 'reportBlockedRequirements'))
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('🛠️ Utilities')
      .addItem('Validate All Data', 'validateAllData')
      .addItem('Generate UUIDs for empty rows', 'backfillUuids')
      .addItem('Load Seed Data', 'loadSeedData'))
    .addToUi();
}

// ---------------------------------------------------------------------------
// SETUP — Creates all sheets with headers, validation, formatting
// ---------------------------------------------------------------------------

function setupAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  const response = ui.alert(
    'Setup ADR Tracker',
    'This will create all data sheets and view sheets. Existing sheets with matching names will be skipped.\n\nContinue?',
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) return;

  // Create data sheets
  for (const [sheetName, config] of Object.entries(SCHEMA)) {
    createDataSheet_(ss, sheetName, config);
  }

  // Create view sheets
  for (const viewName of VIEW_SHEETS) {
    getOrCreateSheet_(ss, viewName);
    const sheet = ss.getSheetByName(viewName);
    if (TAB_COLORS[viewName]) sheet.setTabColor(TAB_COLORS[viewName]);
    sheet.getRange('A1').setValue('Run "Refresh Views" from the ADR Tracker menu to populate.');
    sheet.protect().setWarningOnly(true); // Warn on manual edits to view sheets
  }

  // Reorder sheets logically
  reorderSheets_(ss);

  // Install edit trigger (if not already)
  installEditTrigger_();

  ui.alert('✅ Setup complete! All sheets created.\n\nUse the ADR Tracker menu to load seed data or start entering data.');
}

// ---------------------------------------------------------------------------
// SHEET CREATION HELPER
// ---------------------------------------------------------------------------

function createDataSheet_(ss, sheetName, config) {
  const sheet = getOrCreateSheet_(ss, sheetName);

  // Set tab color
  if (TAB_COLORS[sheetName]) sheet.setTabColor(TAB_COLORS[sheetName]);

  // Write headers if row 1 is empty
  if (sheet.getRange('A1').getValue() === '') {
    const headerRange = sheet.getRange(1, 1, 1, config.headers.length);
    headerRange.setValues([config.headers]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#E8EAED');
    sheet.setFrozenRows(1);
  }

  // Apply data validation for enum-like columns
  for (const [colName, values] of Object.entries(config.validations || {})) {
    const colIdx = config.headers.indexOf(colName) + 1;
    if (colIdx === 0) continue;

    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(values, true) // true = show dropdown
      .setAllowInvalid(false)
      .setHelpText(`Valid values: ${values.join(', ')}`)
      .build();

    // Apply to rows 2–500 (expandable)
    sheet.getRange(2, colIdx, 499, 1).setDataValidation(rule);
  }

  // Light gray background on system columns (id, timestamps, deleted_at)
  const systemCols = ['id', 'created_at', 'updated_at', 'deleted_at'];
  for (const colName of systemCols) {
    const colIdx = config.headers.indexOf(colName) + 1;
    if (colIdx === 0) continue;
    sheet.getRange(2, colIdx, 499, 1).setBackground('#F8F9FA');
    sheet.getRange(1, colIdx).setFontColor('#5F6368');
  }

  // Auto-resize columns
  for (let i = 1; i <= config.headers.length; i++) {
    sheet.autoResizeColumn(i);
  }

  // Set minimum column widths for readability
  for (let i = 1; i <= config.headers.length; i++) {
    if (sheet.getColumnWidth(i) < 100) sheet.setColumnWidth(i, 100);
  }
}

// ---------------------------------------------------------------------------
// UTILITY: Get or create sheet by name
// ---------------------------------------------------------------------------

function getOrCreateSheet_(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

// ---------------------------------------------------------------------------
// REORDER: Arrange tabs in logical order
// ---------------------------------------------------------------------------

function reorderSheets_(ss) {
  const desiredOrder = [
    'projects',
    'requirement_groups',
    'requirements',
    'decisions',
    'options',
    'decision_outcomes',
    'tradeoffs',
    'risks',
    'questions',
    'requirement_decision_links',
    'decision_interactions',
    'entity_links',
    '_decision_readiness',
    '_project_progress',
    '_next_actions'
  ];

  for (let i = 0; i < desiredOrder.length; i++) {
    const sheet = ss.getSheetByName(desiredOrder[i]);
    if (sheet) {
      ss.setActiveSheet(sheet);
      ss.moveActiveSheet(i + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// INSTALL EDIT TRIGGER
// ---------------------------------------------------------------------------

function installEditTrigger_() {
  // Remove any existing onEdit triggers from this project to avoid dupes
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'onEditHandler') {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  // Install installable trigger (needed for operations that require auth)
  ScriptApp.newTrigger('onEditHandler')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();
}


// =============================================================================
// Core.gs — UUID Generation, Timestamps, Lookup Utilities
// =============================================================================
// ---------------------------------------------------------------------------
// UUID v4 generation (no external dependencies)
// ---------------------------------------------------------------------------

function generateUuid() {
  const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  return template.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Sheet data access — reads a sheet into an array of objects
// ---------------------------------------------------------------------------
// This is the workhorse function. Everything that needs to "query"
// a sheet calls this. Returns [{header: value, ...}, ...] for all
// non-empty rows (skips rows where column A is empty).
//
// Performance note: at ADR scale (<500 rows per sheet), reading the
// entire sheet into memory is fine. If you ever hit thousands of rows,
// you'd want to use a real database — but at that point you have
// bigger problems than performance.
// ---------------------------------------------------------------------------

function getSheetData(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return []; // Headers only or empty

  const headers = data[0];
  const rows = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    // Skip completely empty rows (no id)
    if (!row[0] || String(row[0]).trim() === '') continue;

    const obj = { _rowIndex: i + 1 }; // 1-indexed sheet row number
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = row[j];
    }
    rows.push(obj);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Get LIVE (non-soft-deleted) records from a sheet
// ---------------------------------------------------------------------------

function getLiveRecords(sheetName) {
  return getSheetData(sheetName).filter(r => !r.deleted_at);
}

// ---------------------------------------------------------------------------
// Find a single record by ID
// ---------------------------------------------------------------------------

function findById(sheetName, id) {
  return getSheetData(sheetName).find(r => String(r.id) === String(id) && !r.deleted_at);
}

// ---------------------------------------------------------------------------
// Find records matching a filter object
// ---------------------------------------------------------------------------
// Usage: findWhere('risks', { project_id: 'xxx', status: 'Open' })
// Returns all live records matching ALL specified key-value pairs.
// ---------------------------------------------------------------------------

function findWhere(sheetName, filters) {
  return getLiveRecords(sheetName).filter(row => {
    return Object.entries(filters).every(([key, value]) => {
      if (value === null || value === undefined || value === '') {
        return !row[key] || String(row[key]).trim() === '';
      }
      return String(row[key]) === String(value);
    });
  });
}

// ---------------------------------------------------------------------------
// Count records matching a filter
// ---------------------------------------------------------------------------

function countWhere(sheetName, filters) {
  return findWhere(sheetName, filters).length;
}

// ---------------------------------------------------------------------------
// Check if an ID exists (live) in a sheet
// ---------------------------------------------------------------------------

function existsInSheet(sheetName, id) {
  return findById(sheetName, id) !== undefined;
}

// ---------------------------------------------------------------------------
// Get column index (1-based) for a header name in a sheet
// ---------------------------------------------------------------------------

function getColIndex(sheetName, headerName) {
  const config = SCHEMA[sheetName];
  if (!config) return -1;
  return config.headers.indexOf(headerName) + 1;
}

// ---------------------------------------------------------------------------
// Set a cell value by sheet name, row number, and column header
// ---------------------------------------------------------------------------

function setCellByHeader(sheetName, rowIndex, headerName, value) {
  const colIdx = getColIndex(sheetName, headerName);
  if (colIdx < 1) return;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return;
  sheet.getRange(rowIndex, colIdx).setValue(value);
}

// ---------------------------------------------------------------------------
// Backfill UUIDs for rows that have data but no ID
// ---------------------------------------------------------------------------

function backfillUuids() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let count = 0;

  for (const sheetName of Object.keys(SCHEMA)) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) continue;

    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const hasData = row.slice(1).some(cell => cell !== '' && cell !== null);
      const hasId = row[0] !== '' && row[0] !== null;

      if (hasData && !hasId) {
        sheet.getRange(i + 1, 1).setValue(generateUuid());
        count++;
      }
    }
  }

  if (count > 0) {
    SpreadsheetApp.getUi().alert(`Generated ${count} UUID(s).`);
  } else {
    SpreadsheetApp.getUi().alert('All rows already have IDs.');
  }
}

// =============================================================================
// Triggers.gs — onEdit Handler for Live Validation & Auto-Population
// =============================================================================
// This is the "trigger layer" that replaces PostgreSQL's BEFORE INSERT/UPDATE
// triggers. It runs on every edit and handles:
//   1. Auto-generating UUIDs for new rows
//   2. Setting created_at on first edit
//   3. Updating updated_at on every edit
//   4. Running business rule validation
// =============================================================================
function onEditHandler(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();

  // Only process data sheets, not view sheets
  if (!SCHEMA[sheetName]) return;

  const row = e.range.getRow();
  const col = e.range.getColumn();

  // Ignore header row edits
  if (row < 2) return;

  const config = SCHEMA[sheetName];
  const headers = config.headers;

  // --- Auto-populate system fields ---

  // 1. Generate UUID if column A (id) is empty but row has data
  const idCol = 1;
  const currentId = sheet.getRange(row, idCol).getValue();
  if (!currentId || String(currentId).trim() === '') {
    // Check if the row actually has data (not just a stray edit)
    const rowData = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
    const hasData = rowData.slice(1).some(cell => cell !== '' && cell !== null);
    if (hasData) {
      sheet.getRange(row, idCol).setValue(generateUuid());
    }
  }

  // 2. Set created_at if empty
  const createdAtCol = headers.indexOf('created_at') + 1;
  if (createdAtCol > 0) {
    const createdAt = sheet.getRange(row, createdAtCol).getValue();
    if (!createdAt || String(createdAt).trim() === '') {
      sheet.getRange(row, createdAtCol).setValue(nowIso());
    }
  }

  // 3. Always update updated_at
  const updatedAtCol = headers.indexOf('updated_at') + 1;
  if (updatedAtCol > 0) {
    sheet.getRange(row, updatedAtCol).setValue(nowIso());
  }

  // --- Business rule validation on specific edits ---

  const editedHeader = headers[col - 1];

  // Decision status changes
  if (sheetName === 'decisions' && editedHeader === 'status') {
    onDecisionStatusChange_(sheet, row, e.oldValue, e.value);
  }

  // Decision outcome creation/update
  if (sheetName === 'decision_outcomes' && (editedHeader === 'decision_id' || editedHeader === 'summary')) {
    onOutcomeEdit_(sheet, row);
  }

  // Chosen option must belong to the same decision
  if (sheetName === 'decision_outcomes' && editedHeader === 'chosen_option_id') {
    onChosenOptionEdit_(sheet, row);
  }

  // Cross-project checks for links
  if (sheetName === 'requirement_decision_links' && (editedHeader === 'requirement_id' || editedHeader === 'decision_id')) {
    onLinkEdit_(sheet, row, sheetName);
  }

  // Self-reference check for decision interactions
  if (sheetName === 'decision_interactions' && (editedHeader === 'decision_id' || editedHeader === 'related_decision_id')) {
    onInteractionEdit_(sheet, row);
  }
}

// ---------------------------------------------------------------------------
// Decision Status Change — mirrors enforce_decided_has_outcome_integrity
// ---------------------------------------------------------------------------

function onDecisionStatusChange_(sheet, row, oldValue, newValue) {
  const headers = SCHEMA.decisions.headers;
  const rowData = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
  const decisionId = rowData[0];

  // Auto-set decided_at when transitioning TO Decided
  if (newValue === 'Decided') {
    const decidedAtCol = headers.indexOf('decided_at') + 1;
    sheet.getRange(row, decidedAtCol).setValue(nowIso());
  }

  // Clear decided_at when transitioning AWAY from Decided
  if (oldValue === 'Decided' && newValue !== 'Decided') {
    // Check if outcome exists
    const outcomes = findWhere('decision_outcomes', { decision_id: decisionId });
    if (outcomes.length > 0) {
      // Revert the change
      const statusCol = headers.indexOf('status') + 1;
      sheet.getRange(row, statusCol).setValue('Decided');

      SpreadsheetApp.getUi().alert(
        '⚠️ Cannot Change Status',
        `This decision has an outcome record. Delete the outcome in the decision_outcomes sheet first, then change the status.`,
        SpreadsheetApp.getUi().ButtonSet.OK
      );
      return;
    }

    // Clear decided_at
    const decidedAtCol = headers.indexOf('decided_at') + 1;
    sheet.getRange(row, decidedAtCol).setValue('');
  }
}

// ---------------------------------------------------------------------------
// Outcome Edit — mirrors enforce_outcome_requires_decided
// ---------------------------------------------------------------------------

function onOutcomeEdit_(sheet, row) {
  const headers = SCHEMA.decision_outcomes.headers;
  const decisionIdCol = headers.indexOf('decision_id') + 1;
  const decisionId = sheet.getRange(row, decisionIdCol).getValue();

  if (!decisionId) return;

  const decision = findById('decisions', decisionId);
  if (!decision) {
    SpreadsheetApp.getUi().alert(
      '⚠️ Invalid Decision',
      `Decision ID "${decisionId}" not found.`,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    sheet.getRange(row, decisionIdCol).setValue('');
    return;
  }

  if (decision.status !== 'Decided') {
    SpreadsheetApp.getUi().alert(
      '⚠️ Decision Not Decided',
      `Cannot create an outcome for decision "${decision.title}" — its status is "${decision.status}". Change the decision status to "Decided" first.`,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    sheet.getRange(row, decisionIdCol).setValue('');
    return;
  }
}

// ---------------------------------------------------------------------------
// Chosen Option — mirrors enforce_chosen_option_belongs_to_decision
// ---------------------------------------------------------------------------

function onChosenOptionEdit_(sheet, row) {
  const headers = SCHEMA.decision_outcomes.headers;
  const decisionIdCol = headers.indexOf('decision_id') + 1;
  const chosenOptionCol = headers.indexOf('chosen_option_id') + 1;

  const decisionId = sheet.getRange(row, decisionIdCol).getValue();
  const chosenOptionId = sheet.getRange(row, chosenOptionCol).getValue();

  if (!chosenOptionId || !decisionId) return;

  const option = findById('options', chosenOptionId);
  if (!option) {
    SpreadsheetApp.getUi().alert(
      '⚠️ Invalid Option',
      `Option ID "${chosenOptionId}" not found.`,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    sheet.getRange(row, chosenOptionCol).setValue('');
    return;
  }

  if (String(option.decision_id) !== String(decisionId)) {
    SpreadsheetApp.getUi().alert(
      '⚠️ Option Mismatch',
      `Option "${option.title}" belongs to a different decision. The chosen option must belong to this outcome's decision.`,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    sheet.getRange(row, chosenOptionCol).setValue('');
    return;
  }
}

// ---------------------------------------------------------------------------
// Link Edit — mirrors enforce_rdl_same_project
// ---------------------------------------------------------------------------

function onLinkEdit_(sheet, row, sheetName) {
  const headers = SCHEMA[sheetName].headers;
  const reqIdCol = headers.indexOf('requirement_id') + 1;
  const decIdCol = headers.indexOf('decision_id') + 1;

  const reqId = sheet.getRange(row, reqIdCol).getValue();
  const decId = sheet.getRange(row, decIdCol).getValue();

  if (!reqId || !decId) return;

  const req = findById('requirements', reqId);
  const dec = findById('decisions', decId);

  if (!req) {
    SpreadsheetApp.getUi().alert('⚠️ Requirement not found', `ID: ${reqId}`, SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  if (!dec) {
    SpreadsheetApp.getUi().alert('⚠️ Decision not found', `ID: ${decId}`, SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }

  if (String(req.project_id) !== String(dec.project_id)) {
    SpreadsheetApp.getUi().alert(
      '⚠️ Cross-Project Link',
      `The requirement and decision belong to different projects. Links must be within the same project.`,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    // Clear the most recently edited field
    const col = sheet.getActiveCell().getColumn();
    sheet.getRange(row, col).setValue('');
  }
}

// ---------------------------------------------------------------------------
// Interaction Edit — self-reference check
// ---------------------------------------------------------------------------

function onInteractionEdit_(sheet, row) {
  const headers = SCHEMA.decision_interactions.headers;
  const decCol = headers.indexOf('decision_id') + 1;
  const relCol = headers.indexOf('related_decision_id') + 1;

  const decId = sheet.getRange(row, decCol).getValue();
  const relId = sheet.getRange(row, relCol).getValue();

  if (decId && relId && String(decId) === String(relId)) {
    SpreadsheetApp.getUi().alert(
      '⚠️ Self-Reference',
      'A decision cannot interact with itself.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    // Clear the related_decision_id
    sheet.getRange(row, relCol).setValue('');
  }

  // Also check same-project
  if (decId && relId) {
    const dec1 = findById('decisions', decId);
    const dec2 = findById('decisions', relId);
    if (dec1 && dec2 && String(dec1.project_id) !== String(dec2.project_id)) {
      SpreadsheetApp.getUi().alert(
        '⚠️ Cross-Project Interaction',
        'Both decisions must belong to the same project.',
        SpreadsheetApp.getUi().ButtonSet.OK
      );
      sheet.getRange(row, relCol).setValue('');
    }
  }
}

// =============================================================================
// Rules.gs — Batch Validation (Full-Sheet Integrity Checks)
// =============================================================================
// Triggers.gs handles per-edit validation in real time.
// This file handles "run a full scan" validation — useful for:
//   - After bulk pastes or imports
//   - Before generating reports
//   - As a periodic health check
// =============================================================================
function validateAllData() {
  const errors = [];

  // --- FK integrity ---
  for (const [sheetName, config] of Object.entries(SCHEMA)) {
    if (!config.fks) continue;

    const records = getLiveRecords(sheetName);
    const nullableFks = config.nullableFks || [];

    for (const [fkCol, targetSheet] of Object.entries(config.fks)) {
      for (const record of records) {
        const fkValue = record[fkCol];

        // Skip nullable FKs that are empty
        if (nullableFks.includes(fkCol) && (!fkValue || String(fkValue).trim() === '')) {
          continue;
        }

        if (fkValue && String(fkValue).trim() !== '') {
          if (!existsInSheet(targetSheet, fkValue)) {
            errors.push({
              sheet: sheetName,
              row: record._rowIndex,
              field: fkCol,
              message: `References ${targetSheet} ID "${fkValue}" which does not exist`,
              severity: 'ERROR'
            });
          }
        } else if (!nullableFks.includes(fkCol)) {
          errors.push({
            sheet: sheetName,
            row: record._rowIndex,
            field: fkCol,
            message: `Required FK "${fkCol}" is empty`,
            severity: 'ERROR'
          });
        }
      }
    }
  }

  // --- Decision outcomes must reference Decided decisions ---
  const outcomes = getLiveRecords('decision_outcomes');
  for (const outcome of outcomes) {
    if (outcome.decision_id) {
      const decision = findById('decisions', outcome.decision_id);
      if (decision && decision.status !== 'Decided') {
        errors.push({
          sheet: 'decision_outcomes',
          row: outcome._rowIndex,
          field: 'decision_id',
          message: `Outcome exists but decision "${decision.title}" has status "${decision.status}" (must be "Decided")`,
          severity: 'ERROR'
        });
      }
    }
  }

  // --- Chosen option must belong to the same decision ---
  for (const outcome of outcomes) {
    if (outcome.chosen_option_id && outcome.decision_id) {
      const option = findById('options', outcome.chosen_option_id);
      if (option && String(option.decision_id) !== String(outcome.decision_id)) {
        errors.push({
          sheet: 'decision_outcomes',
          row: outcome._rowIndex,
          field: 'chosen_option_id',
          message: `Chosen option belongs to decision "${option.decision_id}", not "${outcome.decision_id}"`,
          severity: 'ERROR'
        });
      }
    }
  }

  // --- Cross-project links ---
  const links = getLiveRecords('requirement_decision_links');
  for (const link of links) {
    const req = findById('requirements', link.requirement_id);
    const dec = findById('decisions', link.decision_id);
    if (req && dec && String(req.project_id) !== String(dec.project_id)) {
      errors.push({
        sheet: 'requirement_decision_links',
        row: link._rowIndex,
        field: 'requirement_id / decision_id',
        message: `Cross-project link: requirement in project "${req.project_id}", decision in project "${dec.project_id}"`,
        severity: 'ERROR'
      });
    }
  }

  // --- Self-referencing interactions ---
  const interactions = getLiveRecords('decision_interactions');
  for (const di of interactions) {
    if (String(di.decision_id) === String(di.related_decision_id)) {
      errors.push({
        sheet: 'decision_interactions',
        row: di._rowIndex,
        field: 'related_decision_id',
        message: 'Decision interacts with itself',
        severity: 'ERROR'
      });
    }
  }

  // --- Duplicate active links (unique constraint equivalent) ---
  const activeLinkKeys = new Set();
  for (const link of links) {
    const key = `${link.requirement_id}|${link.decision_id}|${link.relationship}`;
    if (activeLinkKeys.has(key)) {
      errors.push({
        sheet: 'requirement_decision_links',
        row: link._rowIndex,
        field: 'relationship',
        message: `Duplicate link: same requirement + decision + relationship already exists`,
        severity: 'WARNING'
      });
    }
    activeLinkKeys.add(key);
  }

  // --- Missing required fields ---
  for (const [sheetName, config] of Object.entries(SCHEMA)) {
    if (!config.required) continue;
    const records = getLiveRecords(sheetName);
    for (const record of records) {
      for (const reqField of config.required) {
        if (!record[reqField] || String(record[reqField]).trim() === '') {
          errors.push({
            sheet: sheetName,
            row: record._rowIndex,
            field: reqField,
            message: `Required field "${reqField}" is empty`,
            severity: 'WARNING'
          });
        }
      }
    }
  }

  // --- Report results ---
  if (errors.length === 0) {
    SpreadsheetApp.getUi().alert('✅ Validation Passed', 'No integrity issues found.', SpreadsheetApp.getUi().ButtonSet.OK);
  } else {
    const errorCount = errors.filter(e => e.severity === 'ERROR').length;
    const warnCount = errors.filter(e => e.severity === 'WARNING').length;

    let report = `Found ${errorCount} error(s) and ${warnCount} warning(s):\n\n`;
    for (const err of errors.slice(0, 20)) { // Cap at 20 to avoid huge alerts
      report += `[${err.severity}] ${err.sheet} row ${err.row}: ${err.message}\n`;
    }
    if (errors.length > 20) {
      report += `\n... and ${errors.length - 20} more.`;
    }

    SpreadsheetApp.getUi().alert('⚠️ Validation Issues Found', report, SpreadsheetApp.getUi().ButtonSet.OK);
  }

  return errors;
}

// =============================================================================
// Views.gs — Computed View Sheet Generation
// =============================================================================
// These replace the PostgreSQL views. Each function reads from data sheets,
// computes aggregates, and writes results to the corresponding view sheet.
// Called from the menu or a time-based trigger.
// =============================================================================
function refreshAllViews() {
  refreshDecisionReadiness();
  refreshProjectProgress();
  refreshNextActions();
  SpreadsheetApp.getUi().alert('✅ All views refreshed.');
}

// ---------------------------------------------------------------------------
// decision_readiness_v
// ---------------------------------------------------------------------------

function refreshDecisionReadiness() {
  const decisions = getLiveRecords('decisions');
  const options = getLiveRecords('options');
  const outcomes = getLiveRecords('decision_outcomes');
  const questions = getLiveRecords('questions');
  const risks = getLiveRecords('risks');

  const headers = [
    'decision_id', 'project_id', 'title', 'status',
    'option_count', 'has_minimum_options', 'has_outcome',
    'open_question_count', 'total_question_count',
    'open_risk_count', 'total_risk_count', 'critical_risk_count',
    'readiness', 'created_at', 'decided_at'
  ];

  const rows = decisions.map(d => {
    const decOptions = options.filter(o => String(o.decision_id) === String(d.id));
    const decOutcome = outcomes.find(o => String(o.decision_id) === String(d.id));
    const decQuestions = questions.filter(q => String(q.decision_id) === String(d.id));
    const decRisks = risks.filter(r => String(r.decision_id) === String(d.id));

    const optionCount = decOptions.length;
    const openQuestionCount = decQuestions.filter(q => q.status === 'Open').length;
    const criticalRiskCount = decRisks.filter(r => r.status === 'Open' && r.impact === 'Critical').length;

    let readiness;
    if (d.status === 'Decided') readiness = 'Decided';
    else if (d.status === 'Deferred') readiness = 'Deferred';
    else if (optionCount < 2) readiness = 'NeedsOptions';
    else if (openQuestionCount > 0) readiness = 'HasOpenQuestions';
    else if (criticalRiskCount > 0) readiness = 'HasCriticalRisks';
    else readiness = 'Ready';

    return [
      d.id, d.project_id, d.title, d.status,
      optionCount, optionCount >= 2, !!decOutcome,
      openQuestionCount, decQuestions.length,
      decRisks.filter(r => r.status === 'Open').length, decRisks.length, criticalRiskCount,
      readiness, d.created_at, d.decided_at || ''
    ];
  });

  writeViewSheet_('_decision_readiness', headers, rows);
}

// ---------------------------------------------------------------------------
// project_progress_v
// ---------------------------------------------------------------------------

function refreshProjectProgress() {
  const projects = getLiveRecords('projects');
  const groups = getLiveRecords('requirement_groups');
  const reqs = getLiveRecords('requirements');
  const decisions = getLiveRecords('decisions');
  const options = getLiveRecords('options');
  const links = getLiveRecords('requirement_decision_links');
  const risks = getLiveRecords('risks');
  const questions = getLiveRecords('questions');

  const headers = [
    'project_id', 'project_name', 'project_status',
    'requirement_group_count', 'has_frame',
    'requirements_count', 'functional_count', 'nfr_count', 'constraint_count',
    'draft_requirements', 'completed_requirements', 'dropped_requirements',
    'unlinked_requirements',
    'decisions_count', 'open_decisions', 'decided_decisions', 'deferred_decisions',
    'open_decisions_missing_options',
    'floating_risks', 'open_risks',
    'floating_questions', 'open_questions'
  ];

  const rows = projects.map(p => {
    const pid = String(p.id);
    const pGroups = groups.filter(g => String(g.project_id) === pid);
    const pReqs = reqs.filter(r => String(r.project_id) === pid);
    const pDecs = decisions.filter(d => String(d.project_id) === pid);
    const pRisks = risks.filter(r => String(r.project_id) === pid);
    const pQuestions = questions.filter(q => String(q.project_id) === pid);

    // Unlinked: requirements (non-Dropped) with no link
    const linkedReqIds = new Set(links.map(l => String(l.requirement_id)));
    const unlinked = pReqs.filter(r => r.status !== 'Dropped' && !linkedReqIds.has(String(r.id)));

    // Decisions missing 2+ options
    const openMissing = pDecs.filter(d => {
      if (d.status !== 'Open') return false;
      const optCount = options.filter(o => String(o.decision_id) === String(d.id)).length;
      return optCount < 2;
    });

    return [
      p.id, p.name, p.status,
      pGroups.length, pGroups.length > 0,
      pReqs.length,
      pReqs.filter(r => r.type === 'Functional').length,
      pReqs.filter(r => r.type === 'NonFunctional').length,
      pReqs.filter(r => r.type === 'Constraint').length,
      pReqs.filter(r => r.status === 'Draft').length,
      pReqs.filter(r => r.status === 'Done').length,
      pReqs.filter(r => r.status === 'Dropped').length,
      unlinked.length,
      pDecs.length,
      pDecs.filter(d => d.status === 'Open').length,
      pDecs.filter(d => d.status === 'Decided').length,
      pDecs.filter(d => d.status === 'Deferred').length,
      openMissing.length,
      pRisks.filter(r => !r.decision_id || String(r.decision_id).trim() === '').length,
      pRisks.filter(r => r.status === 'Open').length,
      pQuestions.filter(q => !q.decision_id || String(q.decision_id).trim() === '').length,
      pQuestions.filter(q => q.status === 'Open').length
    ];
  });

  writeViewSheet_('_project_progress', headers, rows);
}

// ---------------------------------------------------------------------------
// next_actions (the "inbox" view)
// ---------------------------------------------------------------------------

function refreshNextActions() {
  const decisions = getLiveRecords('decisions');
  const options = getLiveRecords('options');
  const questions = getLiveRecords('questions');
  const risks = getLiveRecords('risks');
  const reqs = getLiveRecords('requirements');

  const headers = ['priority', 'action_type', 'item', 'description', 'project_id'];

  const actions = [];

  // Decisions needing options
  for (const d of decisions.filter(d => d.status === 'Open')) {
    const optCount = options.filter(o => String(o.decision_id) === String(d.id)).length;
    if (optCount < 2) {
      actions.push([1, 'Add options to decision', d.title,
        `Has ${optCount} option(s) — needs at least 2`, d.project_id]);
    }
  }

  // Decisions ready to decide
  for (const d of decisions.filter(d => d.status === 'Open')) {
    const optCount = options.filter(o => String(o.decision_id) === String(d.id)).length;
    const openQs = questions.filter(q => String(q.decision_id) === String(d.id) && q.status === 'Open').length;
    const critRisks = risks.filter(r => String(r.decision_id) === String(d.id) && r.status === 'Open' && r.impact === 'Critical').length;
    if (optCount >= 2 && openQs === 0 && critRisks === 0) {
      actions.push([2, 'Ready to decide', d.title,
        'Has options, no blockers — ready for a call', d.project_id]);
    }
  }

  // Critical open risks
  for (const r of risks.filter(r => r.status === 'Open' && r.impact === 'Critical')) {
    actions.push([1, 'Mitigate critical risk', r.title, r.description, r.project_id]);
  }

  // Open questions
  for (const q of questions.filter(q => q.status === 'Open')) {
    const dec = q.decision_id ? findById('decisions', q.decision_id) : null;
    const ctx = dec ? `Linked to: ${dec.title}` : 'Floating (not linked to any decision)';
    actions.push([3, 'Answer question', q.question, ctx, q.project_id]);
  }

  // Draft requirements
  for (const r of reqs.filter(r => r.status === 'Draft')) {
    const prio = r.priority === 'P0' ? 1 : r.priority === 'P1' ? 2 : r.priority === 'P2' ? 3 : 4;
    actions.push([prio, 'Refine requirement', r.title,
      `Status: Draft, Priority: ${r.priority}`, r.project_id]);
  }

  // Sort by priority
  actions.sort((a, b) => a[0] - b[0]);

  writeViewSheet_('_next_actions', headers, actions);
}

// ---------------------------------------------------------------------------
// Report Functions (callable from menu)
// ---------------------------------------------------------------------------

function reportUnlinkedRequirements() {
  const reqs = getLiveRecords('requirements').filter(r => r.status !== 'Dropped');
  const links = getLiveRecords('requirement_decision_links');
  const linkedIds = new Set(links.map(l => String(l.requirement_id)));

  const unlinked = reqs.filter(r => !linkedIds.has(String(r.id)));

  if (unlinked.length === 0) {
    SpreadsheetApp.getUi().alert('✅ All active requirements are linked to at least one decision.');
    return;
  }

  let report = `Found ${unlinked.length} unlinked requirement(s):\n\n`;
  for (const r of unlinked) {
    report += `• [${r.priority}] ${r.title} (${r.type}, ${r.status})\n`;
  }
  SpreadsheetApp.getUi().alert('📋 Unlinked Requirements', report, SpreadsheetApp.getUi().ButtonSet.OK);
}

function reportDecisionsMissingOptions() {
  const decisions = getLiveRecords('decisions').filter(d => d.status === 'Open');
  const options = getLiveRecords('options');

  const missing = decisions.filter(d => {
    return options.filter(o => String(o.decision_id) === String(d.id)).length < 2;
  });

  if (missing.length === 0) {
    SpreadsheetApp.getUi().alert('✅ All open decisions have at least 2 options.');
    return;
  }

  let report = `Found ${missing.length} decision(s) missing options:\n\n`;
  for (const d of missing) {
    const count = options.filter(o => String(o.decision_id) === String(d.id)).length;
    report += `• ${d.title} (${count} option(s))\n`;
  }
  SpreadsheetApp.getUi().alert('📋 Decisions Missing Options', report, SpreadsheetApp.getUi().ButtonSet.OK);
}

function reportBlockedRequirements() {
  const links = getLiveRecords('requirement_decision_links').filter(l => l.relationship === 'BlockedBy');
  const decisions = getLiveRecords('decisions');

  const blocked = [];
  for (const link of links) {
    const dec = decisions.find(d => String(d.id) === String(link.decision_id));
    if (dec && dec.status !== 'Decided') {
      const req = findById('requirements', link.requirement_id);
      if (req) {
        blocked.push({ req, dec });
      }
    }
  }

  if (blocked.length === 0) {
    SpreadsheetApp.getUi().alert('✅ No requirements are blocked by undecided decisions.');
    return;
  }

  let report = `Found ${blocked.length} blocked requirement(s):\n\n`;
  for (const { req, dec } of blocked) {
    report += `• [${req.priority}] "${req.title}" blocked by "${dec.title}" (${dec.status})\n`;
  }
  SpreadsheetApp.getUi().alert('📋 Blocked Requirements', report, SpreadsheetApp.getUi().ButtonSet.OK);
}

// ---------------------------------------------------------------------------
// HELPER: Write data to a view sheet (clear + rewrite)
// ---------------------------------------------------------------------------

function writeViewSheet_(sheetName, headers, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;

  sheet.clearContents();
  sheet.clearFormats();

  // Headers
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#E8EAED');
  sheet.setFrozenRows(1);

  // Data
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  // Auto-resize
  for (let i = 1; i <= headers.length; i++) {
    sheet.autoResizeColumn(i);
  }

  // Conditional formatting for readiness column (if present)
  const readinessCol = headers.indexOf('readiness');
  if (readinessCol >= 0) {
    applyReadinessFormatting_(sheet, readinessCol + 1, rows.length + 1);
  }
}

// ---------------------------------------------------------------------------
// Conditional formatting for readiness status
// ---------------------------------------------------------------------------

function applyReadinessFormatting_(sheet, colNum, lastRow) {
  const range = sheet.getRange(2, colNum, Math.max(lastRow - 1, 1), 1);

  const rules = [
    { text: 'Ready', bg: '#CEEAD6', fg: '#137333' },         // Green
    { text: 'Decided', bg: '#D2E3FC', fg: '#1967D2' },       // Blue
    { text: 'NeedsOptions', bg: '#FCE8E6', fg: '#C5221F' },  // Red
    { text: 'HasOpenQuestions', bg: '#FEF7E0', fg: '#E37400' }, // Yellow
    { text: 'HasCriticalRisks', bg: '#FCE8E6', fg: '#C5221F' }, // Red
    { text: 'Deferred', bg: '#F1F3F4', fg: '#5F6368' }       // Gray
  ];

  const existingRules = sheet.getConditionalFormatRules();
  const newRules = rules.map(r => {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(r.text)
      .setBackground(r.bg)
      .setFontColor(r.fg)
      .setRanges([range])
      .build();
  });

  sheet.setConditionalFormatRules([...existingRules, ...newRules]);
}

// =============================================================================
// Seed.gs — Load sample data matching the PostgreSQL seed
// =============================================================================

function loadSeedData() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    'Load Seed Data',
    'This will add sample data to all sheets. Existing data will NOT be overwritten.\n\nContinue?',
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) return;

  const now = nowIso();

  // --- Projects ---
  appendRows_('projects', [
    ['a0000000-0000-0000-0000-000000000001', 'Email Responder Platform',
     'RAG-based email automation system using Workato, Vertex AI, and GCS.',
     'Active', now, now, '']
  ]);

  // --- Requirement Groups ---
  appendRows_('requirement_groups', [
    ['b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
     'Core Pipeline', 'Ingestion, classification, and response generation', 1, now, now, ''],
    ['b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001',
     'Quality & Compliance', 'Accuracy, auditability, and regulatory constraints', 2, now, now, '']
  ]);

  // --- Requirements ---
  appendRows_('requirements', [
    ['c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
     'b0000000-0000-0000-0000-000000000001',
     'Email Classification', 'System must classify inbound emails by intent within 2 seconds.',
     'Functional', 'Ready', 'P0', '', 1, now, now, ''],
    ['c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001',
     'b0000000-0000-0000-0000-000000000001',
     'Response Generation Latency', 'End-to-end response generation must complete within 10 seconds p95.',
     'NonFunctional', 'Ready', 'P1', '', 2, now, now, ''],
    ['c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001',
     'b0000000-0000-0000-0000-000000000002',
     'PII Redaction', 'All generated responses must pass PII redaction before send.',
     'Constraint', 'InProgress', 'P0', '', 1, now, now, ''],
    ['c0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001',
     '',  // No group — intentionally unassigned
     'Attachment Handling', 'System should handle email attachments up to 25MB.',
     'Functional', 'Draft', 'P2', '', 0, now, now, '']
  ]);

  // --- Decisions ---
  appendRows_('decisions', [
    ['d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
     'LLM Provider Selection',
     'Choose between Vertex AI Gemini and external providers for response generation.',
     'Open', '', now, now, ''],
    ['d0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001',
     'Knowledge Store Backend',
     'Choose retrieval backend for the RAG knowledge base.',
     'Open', '', now, now, '']
  ]);

  // --- Options ---
  appendRows_('options', [
    ['e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
     'Vertex AI Gemini 1.5 Pro', 'Google-native LLM via Vertex AI.',
     'Native GCP integration; data residency; Workato connector exists',
     'Token limits on large emails; cost at scale', 1, now, now, ''],
    ['e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001',
     'Anthropic Claude via API', 'External LLM provider via REST API.',
     'Strong instruction-following; large context window',
     'External data transfer; custom connector needed; added latency', 2, now, now, ''],
    ['e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000002',
     'Vertex AI Vector Search', 'Managed vector DB on GCP.',
     'Managed service; native embeddings integration',
     'Cost per query; limited filtering', 1, now, now, ''],
    ['e0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000002',
     'GCS + Metadata in Sheets', 'Simple file-based retrieval with Sheet-driven metadata.',
     'Zero infrastructure cost; familiar tooling; easy to update',
     'Keyword search only; no semantic retrieval; scale ceiling', 2, now, now, '']
  ]);

  // --- Tradeoffs ---
  appendRows_('tradeoffs', [
    [generateUuid(), 'e0000000-0000-0000-0000-000000000001',
     'Cost', 'Vertex AI pricing is per-token; high-volume email could be expensive.',
     'High', now, now, ''],
    [generateUuid(), 'e0000000-0000-0000-0000-000000000002',
     'Data Residency', 'External API means email content leaves GCP boundary.',
     'Critical', now, now, ''],
    [generateUuid(), 'e0000000-0000-0000-0000-000000000004',
     'Scalability', 'Sheet-based metadata will hit API rate limits above ~5000 docs.',
     'High', now, now, '']
  ]);

  // --- Risks ---
  appendRows_('risks', [
    [generateUuid(), 'a0000000-0000-0000-0000-000000000001',
     'd0000000-0000-0000-0000-000000000001',
     'LLM Hallucination in Responses',
     'Generated responses may contain fabricated information.',
     'Medium', 'Critical', '', 'Open', now, now, ''],
    [generateUuid(), 'a0000000-0000-0000-0000-000000000001',
     '',  // Floating risk — not linked to any decision
     'Workato Recipe Concurrency Limits',
     'High email volume may exceed Workato concurrent job limits.',
     'High', 'High', '', 'Open', now, now, '']
  ]);

  // --- Questions ---
  appendRows_('questions', [
    [generateUuid(), 'a0000000-0000-0000-0000-000000000001',
     'd0000000-0000-0000-0000-000000000001',
     'What is the maximum acceptable cost per email processed?',
     '', 'Open', '', now, now, ''],
    [generateUuid(), 'a0000000-0000-0000-0000-000000000001',
     '',  // Floating question
     'Do we need to support multi-language email responses in v1?',
     '', 'Open', '', now, now, '']
  ]);

  // --- Requirement-Decision Links ---
  appendRows_('requirement_decision_links', [
    [generateUuid(), 'c0000000-0000-0000-0000-000000000001',
     'd0000000-0000-0000-0000-000000000001',
     'Requires', 'Classification accuracy depends on LLM capability.', now, now, ''],
    [generateUuid(), 'c0000000-0000-0000-0000-000000000002',
     'd0000000-0000-0000-0000-000000000001',
     'ConstrainedBy', 'Latency requirement constrains which LLM we can use.', now, now, ''],
    [generateUuid(), 'c0000000-0000-0000-0000-000000000003',
     'd0000000-0000-0000-0000-000000000001',
     'BlockedBy', 'PII redaction approach depends on which LLM is chosen.', now, now, '']
  ]);

  // --- Decision Interactions ---
  appendRows_('decision_interactions', [
    [generateUuid(), 'd0000000-0000-0000-0000-000000000001',
     'd0000000-0000-0000-0000-000000000002',
     'InformedBy', 'LLM choice may influence whether we need semantic search or keyword is sufficient.',
     now, now, '']
  ]);

  ui.alert('✅ Seed data loaded! Try refreshing views from the ADR Tracker menu.');
}

// ---------------------------------------------------------------------------
// Helper: Append rows to a named sheet
// ---------------------------------------------------------------------------

function appendRows_(sheetName, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || rows.length === 0) return;

  const lastRow = Math.max(sheet.getLastRow(), 1); // At least row 1 (headers)
  sheet.getRange(lastRow + 1, 1, rows.length, rows[0].length).setValues(rows);
}
