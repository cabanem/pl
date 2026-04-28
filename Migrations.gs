/**
 * @file Migrations.gs (SDC library)
 * Workbook schema migration framework.
 *
 * For v1.0 this is structurally complete but functionally a no-op —
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
 *   Migrations.run is safe to retry — partial chains resume from the
 *   last successfully-applied step.
 *
 * Container shim:
 *   onOpen detects a schema mismatch via Migrations.isMigrationNeeded(ss)
 *   and adds a "Migrate workbook schema" menu item that calls
 *   Migrations.run(ss). Workbooks self-detect the upgrade prompt; no
 *   manual coordination across N workbooks.
 *
 * Pre-v1.0 = v1.0 by default: workbooks without an explicit
 * meta.schema_version row are treated as v1.0. This is a deliberate
 * convenience justified because the v1.0 differences from earlier
 * states (legacy primary_keys rows, missing correlation_id column) are
 * either ignored or self-healed elsewhere. If a future schema change
 * cannot be self-healed, this default has to change to '0.x' and a
 * v0.x→v1.0 migration becomes mandatory.
 *
 * Public:
 *   Migrations.run(ss, options)            → { ok, fromVersion, toVersion, applied, skipped, message }
 *   Migrations.isMigrationNeeded(ss)       → boolean
 *   Migrations.currentWorkbookVersion(ss)  → string
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
 * Empty for v1.0 — there is nothing to migrate from. Future entries
 * land here in chronological order. Migrations.run walks them in order
 * to compose multi-step upgrades (e.g., 1.0 → 1.1 → 2.0).
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
 * @param {Spreadsheet} ss
 * @param {Object}      [options]
 * @param {boolean}     [options.dryRun=false] - When true, report the chain
 *                                                that would run but make no changes.
 * @returns {{
 *   ok: boolean,
 *   fromVersion: string,
 *   toVersion: string,
 *   applied: Array<{from: string, to: string, changed: string[], notes: string[]}>,
 *   skipped: Array<{from: string, to: string, reason: string}>,
 *   message: string
 * }}
 */
Migrations.run = function(ss, options) {
  if (!ss) throw new Error('Migrations.run: ss is required.');
  var opts   = options || {};
  var dryRun = Boolean(opts.dryRun);

  var fromVersion = Migrations.currentWorkbookVersion(ss);
  var toVersion   = SDC_SCHEMA_VERSION;

  var applied = [];
  var skipped = [];

  var path = Migrations._planPath(fromVersion, toVersion);

  if (path.length === 0) {
    return {
      ok:          true,
      fromVersion: fromVersion,
      toVersion:   toVersion,
      applied:     [],
      skipped:     [],
      message:     fromVersion === toVersion
        ? 'Workbook is already at schema v' + toVersion + '. No migration needed.'
        : 'No migration path from v' + fromVersion + ' to v' + toVersion +
          '. Workbook may need manual remediation or a newer library version.'
    };
  }

  for (var i = 0; i < path.length; i++) {
    var step = path[i];

    if (dryRun) {
      applied.push({
        from:    step.from,
        to:      step.to,
        changed: ['(dry run — not executed)'],
        notes:   []
      });
      continue;
    }

    try {
      var result = step.run(ss);
      applied.push({
        from:    step.from,
        to:      step.to,
        changed: (result && result.changed) || [],
        notes:   (result && result.notes)   || []
      });
      Migrations._stampSchemaVersion(ss, step.to);
    } catch (e) {
      skipped.push({
        from:   step.from,
        to:     step.to,
        reason: e.message
      });
      // Stop the chain on first failure — partial migration is worse
      // than no migration. The schema_version reflects whatever was
      // last successfully applied.
      break;
    }
  }

  var ok = skipped.length === 0;
  return {
    ok:          ok,
    fromVersion: fromVersion,
    toVersion:   ok ? toVersion : Migrations.currentWorkbookVersion(ss),
    applied:     applied,
    skipped:     skipped,
    message:     Migrations._buildMessage(fromVersion, toVersion, applied, skipped, dryRun)
  };
};

/**
 * Returns true when the workbook's declared schema version differs from
 * the library's expected version. Cheap — used by onOpen to decide
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
    // If we can't read the version, don't surface the migration menu —
    // the workbook has bigger problems and Config.build will fail
    // loudly with a clearer message.
    return false;
  }
};

/**
 * Read the workbook's declared schema version from _developer_settings.
 * Defaults to '1.0' when the meta.schema_version row is absent — this
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

  // Up to MIGRATION_CHAIN.length hops — guards against malformed chains
  // creating infinite loops if from/to entries are misordered.
  for (var hop = 0; hop < MIGRATION_CHAIN.length + 1; hop++) {
    if (current === toVersion) return path;

    var next = MIGRATION_CHAIN.find(function(step) { return step.from === current; });
    if (!next) return [];   // no path forward from `current`

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

  // Not found — append it. Column layout matches the existing developer
  // settings convention: A=description (optional), B=category, C=key, D=value.
  devSheet.appendRow(['', 'meta', 'schema_version', version]);
};

Migrations._buildMessage = function(fromVersion, toVersion, applied, skipped, dryRun) {
  var lines = [];
  lines.push((dryRun ? 'DRY RUN — ' : '') +
             'Schema migration: v' + fromVersion + ' → v' + toVersion);

  if (applied.length > 0) {
    lines.push('');
    lines.push('Applied:');
    applied.forEach(function(a) {
      lines.push('  v' + a.from + ' → v' + a.to);
      a.changed.forEach(function(c) { lines.push('    • ' + c); });
    });
  }

  if (skipped.length > 0) {
    lines.push('');
    lines.push('Skipped (chain stopped at first failure):');
    skipped.forEach(function(s) {
      lines.push('  v' + s.from + ' → v' + s.to + ': ' + s.reason);
    });
  }

  if (applied.length === 0 && skipped.length === 0) {
    lines.push('');
    lines.push('No migration steps to apply.');
  }

  return lines.join('\n');
};
