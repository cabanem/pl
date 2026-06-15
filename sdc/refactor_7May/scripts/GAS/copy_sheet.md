This slots cleanly into the existing seed-data plumbing you already have (`Labels`, `Preflight` reads, the `seeded_data_*` payload fields). The work is one new Drive primitive plus a conditional call in `Provision.run`.

## The new Drive function

There's one non-obvious constraint worth knowing up front: Google's xlsx export (`export?format=xlsx`) always emits the *whole* workbook — only CSV/TSV honor a per-sheet `gid`. So to get a single-sheet xlsx you copy the one sheet into a throwaway Google Sheet, export *that*, and trash it. `Sheet.copyTo` carries values, formatting, and data validation, but not cross-sheet formula references — which is exactly what you want for an incumbent-data table.

Drop this into `001_Drive.js`:

```javascript
/**
 * Copy a single named sheet from a source spreadsheet into a new,
 * standalone XLSX file on Drive. Returns the new file's ID.
 *
 * Mechanism: no Drive/Sheets export yields a single-sheet XLSX directly
 * (xlsx export is always whole-workbook; only CSV/TSV honor a per-sheet
 * gid). So we copy the one sheet into a fresh throwaway Google Sheet,
 * export THAT to XLSX, then trash it. Sheet.copyTo carries values,
 * formatting, and data validation; it does NOT carry cross-sheet formula
 * references (they would point at sheets absent from the new single-sheet
 * workbook). For incumbent/seed data tables this is the desired behavior.
 *
 * Assumes the source is a native Google Sheet. A source that is itself an
 * uploaded .xlsx cannot be opened by SpreadsheetApp.openById and will
 * throw here; convert it to a Google Sheet first if that case appears.
 *
 * Requires the Drive scope (already in use library-wide) for the export
 * fetch's OAuth token.
 *
 * @param {string} sourceFileId - Drive ID of the source spreadsheet.
 * @param {string} sheetName    - Tab to extract (matched exactly).
 * @param {Object} [options]
 * @param {Folder} [options.destinationFolder] - Where to write the XLSX.
 *                                                Defaults to the source
 *                                                file's first parent.
 * @param {string} [options.fileName]           - Output name WITHOUT
 *                                                extension. Defaults to sheetName.
 * @returns {{fileId: string, fileName: string}}
 * @throws  If the source can't be opened, the named sheet is absent, or export fails.
 */
Drive.copySheetToXlsx = function(sourceFileId, sheetName, options) {
  if (!sourceFileId) throw new Error('Drive.copySheetToXlsx: sourceFileId is required.');
  if (!sheetName)    throw new Error('Drive.copySheetToXlsx: sheetName is required.');

  var opts = options || {};

  // 1. Open source + locate the named sheet.
  var source;
  try {
    source = SpreadsheetApp.openById(sourceFileId);
  } catch (e) {
    throw new Error(
      'Could not open the seed-data source spreadsheet (id "' + sourceFileId + '"). ' +
      'Verify the ID, that the running user has access, and that it is a native ' +
      'Google Sheet (not an uploaded .xlsx). Underlying error: ' + e.message
    );
  }

  var srcSheet = source.getSheetByName(sheetName);
  if (!srcSheet) {
    throw new Error(
      'Sheet "' + sheetName + '" was not found in the seed-data source ' +
      '(id "' + sourceFileId + '"). Check the sheet name in the customer tab.'
    );
  }

  // 2. Copy just that sheet into a fresh throwaway spreadsheet.
  var temp = SpreadsheetApp.create('._seed_export_tmp_' + Utilities.getUuid());
  try {
    var originalSheets = temp.getSheets();          // the default sheet(s)
    var copied = srcSheet.copyTo(temp);             // arrives as "Copy of <name>"
    originalSheets.forEach(function(s) { temp.deleteSheet(s); });
    copied.setName(sheetName);                      // after delete: no name collision
    SpreadsheetApp.flush();                         // persist before the export read

    // 3. Export the throwaway workbook as XLSX.
    var exportUrl = 'https://docs.google.com/spreadsheets/d/' + temp.getId() +
                    '/export?format=xlsx';
    var resp = UrlFetchApp.fetch(exportUrl, {
      headers:            { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      throw new Error('XLSX export returned HTTP ' + resp.getResponseCode() + ': ' +
                      String(resp.getContentText() || '').substring(0, 300));
    }

    // 4. Write the XLSX into the destination folder.
    var folder = opts.destinationFolder;
    if (!folder) {
      var parents = DriveApp.getFileById(sourceFileId).getParents();
      if (!parents.hasNext()) {
        throw new Error('Drive.copySheetToXlsx: no destinationFolder given and the ' +
          'source file has no accessible parent folder to fall back to.');
      }
      folder = parents.next();
    }
    var baseName = String(opts.fileName || sheetName).replace(/\.xlsx$/i, '');
    var blob     = resp.getBlob().setName(baseName + '.xlsx');
    var outFile  = folder.createFile(blob);

    return { fileId: outFile.getId(), fileName: outFile.getName() };
  } finally {
    // 5. Always trash the throwaway, even if export/write threw.
    try {
      DriveApp.getFileById(temp.getId()).setTrashed(true);
    } catch (e) {
      console.warn('Drive.copySheetToXlsx: could not trash temp spreadsheet ' +
                   temp.getId() + ': ' + e.message);
    }
  }
};
```

Capturing the original sheets and deleting them *after* the copy (rather than deleting "Sheet1" by name) keeps it locale-independent and handles the edge where `sheetName` itself is "Sheet1".

## Wiring it into `Provision.run`

Add this conditional block after step 6 (audit-share) and before step 7 (payload build). It mirrors your config-JSON pattern: create, then share with the Workato OAuth account — which Workato needs in order to read the file by ID.

```javascript
    // 6b. Seed data: if the customer provided incumbent data, copy the
    //     named sheet into a standalone XLSX and share it with Workato.
    //     The new file ID rides along on the provision payload.
    var seedDataFileId = '';
    if (Util.coerceTruthy(pf.hasSeedData) &&
        String(pf.seedDataDriveId || '').trim() &&
        String(pf.seedDataSheetName || '').trim()) {

      var seed = Stage.run('seed-data-export', function() {
        return Drive.copySheetToXlsx(
          String(pf.seedDataDriveId).trim(),
          String(pf.seedDataSheetName).trim(),
          { destinationFolder: Drive.resolveDestinationFolder(ss, config),
            fileName:          'seed_' + ss.getId() }
        );
      });
      seedDataFileId = seed.fileId;

      Stage.run('share-seed-with-workato', function() {
        Drive.shareWithIntegrationAccount(seedDataFileId, pf.integrationAccountEmail);
      });

      log('INFO', 'Seed sheet "' + pf.seedDataSheetName +
                  '" exported to XLSX. File ID: ' + seedDataFileId);
    }
```

Then add `seedDataXlsxFileId: seedDataFileId` to the `Payload.provision({...})` call and to `Result.data` so it surfaces to the container.

This makes the seed export **fatal** to the provision if it fails (consistent with `share-with-workato`). If you'd rather let provisioning proceed without seed data on failure, wrap it in its own try/catch and push a `Result.warnings` entry instead — your call based on whether Workato can run without it.

## Two contract decisions

The Drive function and the orchestrator wiring are unambiguous. The wire contract is where you have a choice:

Adding `seeded_data_xlsx_file_id` to `Payload.provision` is additive — one line, defaulting to `''`, not in `_requireArgs`:

```javascript
    seeded_data_xlsx_file_id: args.seedDataXlsxFileId || '',
```

But by your own versioning discipline (3.0 and 4.0 both bumped for additive provision fields), this is a `PAYLOAD` bump to `5.0` with a history entry in `008_Version.js`, since R-1's handshake reads it. I'd make that bump rather than slip a silent field onto the wire — it keeps the contract honest. Whether you want Workato consuming the new pre-split xlsx file ID versus the raw `seeded_data_drive_id` it already gets is the real question; the split-by-supplier work (your `seedDataIndexKey`) presumably happens downstream, so passing the clean single-sheet xlsx is the natural input for that.

One caveat to flag: this assumes the customer-provided source is a native Google Sheet. If a client ever hands you an uploaded `.xlsx`, `SpreadsheetApp.openById` throws — the error message points at that, so it'll surface clearly rather than silently, but you'd need a convert-first branch if that case becomes real.
