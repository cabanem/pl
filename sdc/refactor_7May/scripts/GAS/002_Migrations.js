/**
 * @file Migrations.gs (SDC library)
 * Workbook schema migration framework.
 *
 * For v1.0 this is structurally complete but functionally a no-op â€”
 * there are no prior schema versions to migrate FROM. The plumbing is
 * here on purpose so v2.0 can add a real migration step without
 * retrofitting the framework.
 *
 * How it works:
 *   - The chain is a list of {from, to, run} entries, ordered.
 *   - Migrations.run walks the chain from the workbook's current schema
 *     to SDC_SCHEMA_VERSION, applying each step in turn.
 *   - Each step's run(ss) function does the structural work (rename a
 *     sheet, add a column, rewrite a setting) and returns a summary.
 *   - On success, schema_version in _developer_settings is bumped.
 *   - On dryRun, the chain is reported but no changes are written.
 *
 * Container shim:
 *   onOpen detects a schema mismatch via Migrations.isMigrationNeeded(ss)
 *   and adds a "Migrate workbook schema" menu item that calls
 *   Migrations.run(ss). Workbooks self-detect the upgrade prompt; no
 *   manual coordination across N workbooks.
 *
 * Public:
 *   Migrations.run(ss, options)              â†’ Result   (canonical Result shape)
 *   Migrations.isMigrationNeeded(ss)         â†’ boolean
 *   Migrations.currentWorkbookVersion(ss)    â†’ string
 */

var Migrations = {};

// --- Migration chain -------------------------------------------------

/**
 * Ordered list of migration steps. Each step:
 *   - from:    schema version this step migrates FROM (e.g., '1.0')
 *   - to:      schema version this step migrates TO   (e.g., '1.1')
 *   - run(ss): performs the migration. Returns { changed: [...], notes: [...] }.
 *              Throws on unrecoverable failure.
 *
 * Empty for v1.0 â€” there is nothing to migrate from. Future entries
 * land here in chronological order. Migrations.run walks them in order
 * to compose multi-step upgrades (e.g., 1.0 â†’ 1.1 â†’ 2.0).
 */
var MIGRATION_CHAIN = [
  // No migrations defined yet. v1.0 is the baseline.
  //
  // Example future shape (do not uncomment until needed):
  //
  // {
  //   from: '1.0',
  //   to:   '1.1',
  //   run:  function(ss) {
  //     // Add a new structural sheet, rewrite a setting, etc.
  //     return { changed: ['Added _new_structural_sheet'], notes: [] };
  //   }
  // }
];

// --- Public API ------------------------------------------------------

/**
 * Run all applicable migrations to bring the workbook to SDC_SCHEMA_VERSION.
 *
 * Returns a canonical Result. Structured migration detail (fromVersion,
 * toVersion, applied steps, skipped steps) is carried on Result.data.
 *
 * @param {Spreadsheet} ss
 * @param {Object}      [options]
 * @param {boolean}     [options.dryRun=false] - When true, report the chain
 *                                                that would run but make no changes.
 * @returns {Object} canonical Result
 */
Migrations.run = function(ss, options) {
  if (!ss) throw new Error('Migrations.run: ss is required.');
  var opts   = options || {};
  var dryRun = Boolean(opts.dryRun);

  var correlationId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);

  var fromVersion, toVersion;
  try {
    fromVersion = Migrations.currentWorkbookVersion(ss);
    toVersion   = SDC_SCHEMA_VERSION;
  } catch (e) {
    // Cannot read the workbook's version (e.g., _developer_settings missing).
    // Fail before any work and log the diagnostic.
    log('ERROR', 'Migration aborted: ' + e.message);
    return Result.fail({
      flow:          'migration',
      correlationId: correlationId,
      message:       'Migration aborted before starting: ' + e.message,
      error: {
        stage:   'version-lookup',
        message: e.message
      }
    });
  }

  log('INFO', (dryRun ? 'DRY RUN â€” ' : '') +
              'Starting migration: v' + fromVersion + ' â†’ v' + toVersion);

  var applied = [];
  var skipped = [];
  var path    = Migrations._planPath(fromVersion, toVersion);

  if (path.length === 0) {
    var noPathMessage = fromVersion === toVersion
      ? 'Workbook is already at schema v' + toVersion + '. No migration needed.'
      : 'No migration path from v' + fromVersion + ' to v' + toVersion +
        '. Workbook may need manual remediation or a newer library version.';

    log('SUCCESS', noPathMessage);

    return Result.ok({
      flow:          'migration',
      correlationId: correlationId,
      message:       noPathMessage,
      data: {
        fromVersion: fromVersion,
        toVersion:   toVersion,
        applied:     [],
        skipped:     [],
        dryRun:      dryRun
      }
    });
  }

  // Apply each step in order.
  for (var i = 0; i < path.length; i++) {
    var step = path[i];

    if (dryRun) {
      applied.push({
        from:    step.from,
        to:      step.to,
        changed: ['(dry run â€” not executed)'],
        notes:   []
      });
      log('INFO', 'DRY RUN â€” would migrate v' + step.from + ' â†’ v' + step.to);
      continue;
    }

    try {
      var stepResult = step.run(ss);
      var changed    = (stepResult && stepResult.changed) || [];
      var notes      = (stepResult && stepResult.notes)   || [];

      applied.push({ from: step.from, to: step.to, changed: changed, notes: notes });
      Migrations._stampSchemaVersion(ss, step.to);

      log('INFO', 'Migrated v' + step.from + ' â†’ v' + step.to + ': ' +
                  (changed.length ? changed.join(', ') : 'no changes recorded'));
    } catch (e) {
      skipped.push({ from: step.from, to: step.to, reason: e.message });
      log('ERROR', 'Migration v' + step.from + ' â†’ v' + step.to + ' failed: ' + e.message);
      // Stop the chain on first failure â€” partial migration is worse
      // than no migration. The schema_version reflects whatever was
      // last successfully applied.
      break;
    }
  }

  var ok            = skipped.length === 0;
  var finalVersion  = ok ? toVersion : Migrations.currentWorkbookVersion(ss);
  var resultMessage = Migrations._buildMessage(fromVersion, toVersion, applied, skipped, dryRun);

  log(ok ? 'SUCCESS' : 'WARNING',
      'Migration finished. Applied: ' + applied.length + ', skipped: ' + skipped.length +
      '. Now at v' + finalVersion + '.');

  if (ok) {
    return Result.ok({
      flow:          'migration',
      correlationId: correlationId,
      message:       resultMessage,
      data: {
        fromVersion: fromVersion,
        toVersion:   finalVersion,
        applied:     applied,
        skipped:     [],
        dryRun:      dryRun
      }
    });
  }

  return Result.fail({
    flow:          'migration',
    correlationId: correlationId,
    message:       resultMessage,
    error: {
      stage:   'migration-step',
      message: skipped.length + ' migration step(s) failed. Workbook is at v' +
               finalVersion + '. See _script_logs for details.'
    }
  });
};

/**
 * Returns true when the workbook's declared schema version differs from
 * the library's expected major version. Cheap â€” used by onOpen to decide
 * whether to surface the migration menu item.
 */
Migrations.isMigrationNeeded = function(ss) {
  try {
    if (!ss) return false;
    var workbookVersion = Migrations.currentWorkbookVersion(ss);
    var wMajor = parseInt(String(workbookVersion).split('.')[0], 10);
    var lMajor = parseInt(String(SDC_SCHEMA_VERSION).split('.')[0], 10);
    return wMajor !== lMajor || workbookVersion !== SDC_SCHEMA_VERSION;
  } catch (e) {
    // If we can't read the version (e.g., _developer_settings missing),
    // don't surface the migration menu â€” the workbook has bigger problems
    // and Config.build will fail loudly with a clearer message.
    return false;
  }
};

/**
 * Read the workbook's declared schema version from _developer_settings.
 * Defaults to '1.0' when the meta.schema_version row is absent â€” this
 * matches Config.build's behavior so pre-v1.0 workbooks (which don't
 * declare a version) are treated as v1.0.
 */
Migrations.currentWorkbookVersion = function(ss) {
  if (!ss) throw new Error('Migrations.currentWorkbookVersion: ss is required.');

  var devSheet = ss.getSheetByName('_developer_settings');
  if (!devSheet) {
    throw new Error("'_developer_settings' tab is missing from the workbook.");
  }

  var data = devSheet.getDataRange().getValues();
  var row  = data.find(function(r) { return r[1] === 'meta' && r[2] === 'schema_version'; });
  return row ? String(row[3]) : '1.0';
};

// --- Private helpers -------------------------------------------------

/**
 * Walk the chain from `fromVersion` to `toVersion`, returning the ordered
 * subset of MIGRATION_CHAIN entries that compose the path. Returns []
 * if no path exists or none is needed.
 */
Migrations._planPath = function(fromVersion, toVersion) {
  if (fromVersion === toVersion) return [];

  var path    = [];
  var current = fromVersion;

  // Up to MIGRATION_CHAIN.length hops â€” guards against malformed chains
  // creating infinite loops if from/to entries are misordered.
  for (var hop = 0; hop < MIGRATION_CHAIN.length + 1; hop++) {
    if (current === toVersion) return path;

    var next = MIGRATION_CHAIN.find(function(step) { return step.from === current; });
    if (!next) return [];

    path.push(next);
    current = next.to;
  }

  return [];
};

/**
 * Write the new schema_version into _developer_settings. Adds the row
 * if missing, updates it in place if present.
 */
Migrations._stampSchemaVersion = function(ss, version) {
  var devSheet = ss.getSheetByName('_developer_settings');
  if (!devSheet) {
    throw new Error("Cannot stamp schema_version: '_developer_settings' is missing.");
  }

  var data = devSheet.getDataRange().getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][1] === 'meta' && data[i][2] === 'schema_version') {
      devSheet.getRange(i + 1, 4).setValue(version);
      return;
    }
  }

  // Not found â€” append it. Column layout matches the existing developer
  // settings convention: A=description (optional), B=category, C=key, D=value.
  devSheet.appendRow(['', 'meta', 'schema_version', version]);
};

Migrations._buildMessage = function(fromVersion, toVersion, applied, skipped, dryRun) {
  var lines = [];
  lines.push((dryRun ? 'DRY RUN â€” ' : '') +
             'Schema migration: v' + fromVersion + ' â†’ v' + toVersion);

  if (applied.length > 0) {
    lines.push('');
    lines.push('Applied:');
    applied.forEach(function(a) {
      lines.push('  v' + a.from + ' â†’ v' + a.to);
      a.changed.forEach(function(c) { lines.push('    â€¢ ' + c); });
    });
  }

  if (skipped.length > 0) {
    lines.push('');
    lines.push('Skipped (chain stopped at first failure):');
    skipped.forEach(function(s) {
      lines.push('  v' + s.from + ' â†’ v' + s.to + ': ' + s.reason);
    });
  }

  if (applied.length === 0 && skipped.length === 0) {
    lines.push('');
    lines.push('No migration steps to apply.');
  }

  return lines.join('\n');
};
