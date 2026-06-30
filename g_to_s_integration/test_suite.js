/**
 * Tests.gs — test suite for ContractIntake.gs
 * -----------------------------------------------------------------------------
 * Add this as a second file in the SAME Apps Script project (all .gs files share
 * one global scope, so these call ContractIntake's functions directly).
 *
 * RUN:   select runTests() in the editor and Run. Results print to the log.
 *
 * WHAT'S COVERED (real, deterministic unit tests, no Google services):
 *   parseResult_, extractSources_, buildPayload_, parseList_, asBool_,
 *   isFilled_, str_, fieldInstruction_, escapeRegex_, and the sheet read-back
 *   (readApproval_/readMeta_) exercised against an in-memory fake sheet.
 *
 * WHAT'S NOT (needs real services -> see the INTEGRATION_* helpers + the manual
 * smoke procedure at the bottom): processIngestion, processApprovals,
 * the Vertex fetch in callGemini_, createReviewSheet_, Drive moves, Chat,
 * the Workato POST.
 *
 * The Gemini branch logic (the "no poison success" guarantee — throw on
 * safety/recitation/empty) is unit-testable IF you adopt the small refactor
 * described at the bottom. Those tests auto-SKIP until interpretGeminiResponse_
 * exists, then turn green.
 * -----------------------------------------------------------------------------
 */

function runTests() {
  var cases = [];
  function t(name, fn) { cases.push([name, fn]); }

  registerParseTests_(t);
  registerSourceTests_(t);
  registerPayloadTests_(t);
  registerConfigCoercionTests_(t);
  registerMiscTests_(t);
  registerSheetReadTests_(t);
  registerGeminiTests_(t);

  var pass = 0, fail = 0, skip = 0, lines = [];
  cases.forEach(function (c) {
    try {
      var r = c[1]();
      if (r === 'SKIP') { skip++; lines.push('SKIP  ' + c[0]); }
      else              { pass++; lines.push('ok    ' + c[0]); }
    } catch (e) {
      fail++; lines.push('FAIL  ' + c[0] + '\n        ' + e.message);
    }
  });
  var summary = pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped';
  Logger.log(lines.join('\n') + '\n\n' + summary);
  return summary;
}


// ===== ASSERTIONS =============================================================

function assert_(cond, msg) { if (!cond) throw new Error('assert failed: ' + (msg || '')); }
function assertEq_(actual, expected, msg) {
  if (__stable(actual) !== __stable(expected)) {
    throw new Error((msg ? msg + ' — ' : '') +
      'expected ' + __stable(expected) + ', got ' + __stable(actual));
  }
}
function assertThrows_(fn, includes, msg) {
  var threw = false, m = '';
  try { fn(); } catch (e) { threw = true; m = e.message; }
  if (!threw) throw new Error((msg || '') + ' expected a throw, got none');
  if (includes && m.toLowerCase().indexOf(includes.toLowerCase()) === -1) {
    throw new Error((msg || '') + ' threw "' + m + '", expected to include "' + includes + '"');
  }
}
function __stable(v) {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return '[' + v.map(__stable).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(function (k) {
      return JSON.stringify(k) + ':' + __stable(v[k]);
    }).join(',') + '}';
  }
  return JSON.stringify(v);
}


// ===== parseResult_ ===========================================================

function registerParseTests_(t) {
  t('parse: clean labels in order', function () {
    var text = '[[Party]]\nAcme\n[[Amount]]\n$100\n[[Term]]\n12 months';
    var out = parseResult_(text, ['Party', 'Amount', 'Term']);
    assertEq_(out, { Party: 'Acme', Amount: '$100', Term: '12 months' });
  });

  t('parse: labels out of config order still map correctly', function () {
    var text = '[[Term]]\n12 months\n[[Party]]\nAcme';
    var out = parseResult_(text, ['Party', 'Term']);
    assertEq_(out, { Party: 'Acme', Term: '12 months' });
  });

  t('parse: missing field becomes blank', function () {
    var text = '[[Party]]\nAcme\n[[Term]]\n12 months';
    var out = parseResult_(text, ['Party', 'Amount', 'Term']);
    assertEq_(out.Amount, '');
  });

  t('parse: tolerates markdown noise around labels', function () {
    var text = '## [[Party]]:\nAcme Corp\n**[[Amount]]**\n$500';
    var out = parseResult_(text, ['Party', 'Amount']);
    assertEq_(out, { Party: 'Acme Corp', Amount: '$500' });
  });

  t('parse: field name with regex-special chars', function () {
    var out = parseResult_('[[Amount ($)]]\n500', ['Amount ($)']);
    assertEq_(out['Amount ($)'], '500');
  });

  t('parse: no markers -> whole body lands in field[0] (never lose text)', function () {
    var out = parseResult_('free text, model ignored the format', ['Party', 'Amount']);
    assertEq_(out.Party, 'free text, model ignored the format');
    assertEq_(out.Amount, '');
  });

  t('parse: multi-line content captured and trimmed', function () {
    var text = '[[Party]]\n  Acme Corp\nSubsidiary of X  \n[[Term]]\n12 months';
    var out = parseResult_(text, ['Party', 'Term']);
    assertEq_(out.Party, 'Acme Corp\nSubsidiary of X');
  });

  t('parse: empty text -> all blank', function () {
    var out = parseResult_('', ['Party', 'Amount']);
    assertEq_(out, { Party: '', Amount: '' });
  });
}


// ===== extractSources_ ========================================================

function registerSourceTests_(t) {
  t('sources: null meta -> empty', function () { assertEq_(extractSources_(null), ''); });
  t('sources: no chunks -> empty', function () { assertEq_(extractSources_({}), ''); });

  t('sources: title and uri formatted', function () {
    var meta = { groundingChunks: [{ web: { uri: 'http://a', title: 'Site A' } }] };
    assertEq_(extractSources_(meta), 'Site A — http://a');
  });

  t('sources: duplicate uris deduped', function () {
    var meta = { groundingChunks: [
      { web: { uri: 'http://a', title: 'A' } },
      { web: { uri: 'http://a', title: 'A again' } }
    ] };
    assertEq_(extractSources_(meta), 'A — http://a');
  });

  t('sources: missing title falls back to uri; chunk without web skipped', function () {
    var meta = { groundingChunks: [
      { web: { uri: 'http://b' } },
      { somethingElse: true }
    ] };
    assertEq_(extractSources_(meta), 'http://b — http://b');
  });
}


// ===== buildPayload_ ==========================================================

function registerPayloadTests_(t) {
  t('payload: shape, approved-vs-extracted split, correlation passthrough', function () {
    var approval = {
      correlationId: 'corr-9', fileId: 'FID', fileName: 'c.pdf',
      model: 'gemini-2.5-pro', extractedAt: '2026-01-01T00:00:00.000Z',
      fields:    { Party: 'Acme Corp' },   // human-approved truth
      extracted: { Party: 'Acme' }         // original
    };
    var p = buildPayload_(approval, {});
    assertEq_(p.correlation_id, 'corr-9');
    assertEq_(p.fields.Party, 'Acme Corp');
    assertEq_(p.provenance.extracted.Party, 'Acme');
    assertEq_(p.source.file_id, 'FID');
    assert_(p.source.drive_url.indexOf('FID') !== -1, 'drive_url should embed file id');
  });
}


// ===== config coercion ========================================================

function registerConfigCoercionTests_(t) {
  t('parseList_: newline-separated', function () {
    assertEq_(parseList_('A\nB\nC'), ['A', 'B', 'C']);
  });
  t('parseList_: comma-separated, trimmed, blanks dropped', function () {
    assertEq_(parseList_(' A , B ,,\nC '), ['A', 'B', 'C']);
  });
  t('parseList_: empty -> []', function () { assertEq_(parseList_(''), []); });

  t('asBool_: truthy strings and booleans', function () {
    ['true', 'TRUE', 'yes', '1'].forEach(function (v) { assert_(asBool_(v) === true, v); });
    ['false', 'no', '0', ''].forEach(function (v) { assert_(asBool_(v) === false, v); });
    assert_(asBool_(true) === true && asBool_(false) === false, 'native bools');
  });

  t('isFilled_: zero is filled, empty/null/undefined are not', function () {
    assert_(isFilled_(0) === true, 'temperature 0 must be respected');
    assert_(isFilled_('') === false && isFilled_(null) === false && isFilled_(undefined) === false);
  });

  t('str_: trims, stringifies, null -> empty', function () {
    assertEq_(str_('  x '), 'x');
    assertEq_(str_(5), '5');
    assertEq_(str_(null), '');
  });
}


// ===== misc pure helpers ======================================================

function registerMiscTests_(t) {
  t('fieldInstruction_: contains each label in order', function () {
    var s = fieldInstruction_(['Party', 'Amount']);
    assert_(s.indexOf('[[Party]]') < s.indexOf('[[Amount]]'), 'order preserved');
    assert_(s.indexOf('[[ ]]') === -1 || s.indexOf('except as these labels') !== -1, 'guard present');
  });
  t('escapeRegex_: escapes specials', function () {
    assertEq_(escapeRegex_('a.b($)'), 'a\\.b\\(\\$\\)');
  });
}


// ===== sheet read-back (fake sheet, real parsing logic) =======================

function registerSheetReadTests_(t) {
  t('readApproval_: unchecked box, fields read in grid order', function () {
    var ss = fakeReviewSpreadsheet_(false, true);
    var a = readApproval_(ss);
    assertEq_(a.approved, false);
    assertEq_(a.correlationId, 'corr-1');
    assertEq_(a.fileId, 'FILE123');
    assertEq_(a.fileName, 'contract.pdf');
    assertEq_(a.fields, { Party: 'Acme Corp', Amount: '$100', Term: '24 months' });
    assertEq_(a.extracted, { Party: 'Acme', Amount: '$100', Term: '12 months' });
  });

  t('readApproval_: checked box -> approved true', function () {
    assertEq_(readApproval_(fakeReviewSpreadsheet_(true, true)).approved, true);
  });

  t('readApproval_: grid stops at Sources sentinel when no blank separator', function () {
    var a = readApproval_(fakeReviewSpreadsheet_(false, false));
    assertEq_(a.fields, { Party: 'Acme Corp', Amount: '$100', Term: '24 months' });
  });

  t('readApproval_: falls back to sheet[0] when named tab absent', function () {
    // nameMap empty -> getSheetByName returns null -> getSheets()[0] used.
    var sheet = makeFakeSheet_(reviewGrid_(false, true));
    var ss = { getSheetByName: function () { return null; }, getSheets: function () { return [sheet]; } };
    assertEq_(readApproval_(ss).fileId, 'FILE123');
  });

  t('readMeta_: returns blank for an unknown label', function () {
    var sheet = makeFakeSheet_(reviewGrid_(false, true));
    assertEq_(readMeta_(sheet, 'No Such Label'), '');
  });
}

/** A faithful in-memory copy of what createReviewSheet_ writes. */
function reviewGrid_(approved, withBlankBeforeSources) {
  var g = [
    ['Original File',    '(hyperlink)',  ''],
    ['Source File ID',   'FILE123',      ''],
    ['Source File Name', 'contract.pdf', ''],
    ['Correlation ID',   'corr-1',       ''],
    ['Extracted At',     '2026-01-01T00:00:00.000Z', ''],
    ['Model',            'gemini-2.5-pro', ''],
    ['Status',           'Pending Review', ''],
    ['Approved?',        approved,       ''],
    ['', '', ''],                                   // row 9 blank (headerRow = 10)
    ['Field', 'Extracted', 'Approved'],
    ['Party',  'Acme',      'Acme Corp'],           // corrected
    ['Amount', '$100',      '$100'],
    ['Term',   '12 months', '24 months']            // corrected
  ];
  if (withBlankBeforeSources) g.push(['', '', '']);
  g.push(['Grounding Sources', '(none)', '']);
  return g;
}
function fakeReviewSpreadsheet_(approved, withBlankBeforeSources) {
  var sheet = makeFakeSheet_(reviewGrid_(approved, withBlankBeforeSources));
  return makeFakeSpreadsheet_(sheet, { Review: sheet });
}

/** Minimal fake of the Sheet surface readApproval_/readMeta_ actually call. */
function makeFakeSheet_(grid) {
  return {
    _g: grid,
    getLastRow: function () { return this._g.length; },
    getLastColumn: function () {
      return this._g.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    },
    getDataRange: function () {
      var g = this._g;
      return { getValues: function () { return g.map(function (r) { return r.slice(); }); } };
    },
    getRange: function (row, col, numRows, numCols) {
      var g = this._g;
      return { getValues: function () {
        var out = [];
        for (var r = row - 1; r < row - 1 + numRows; r++) {
          var src = g[r] || [], line = [];
          for (var c = col - 1; c < col - 1 + numCols; c++) {
            line.push(src[c] === undefined ? '' : src[c]);
          }
          out.push(line);
        }
        return out;
      }};
    }
  };
}
function makeFakeSpreadsheet_(sheet, nameMap) {
  return {
    getSheetByName: function (n) { return (nameMap && nameMap[n]) || null; },
    getSheets: function () { return [sheet]; }
  };
}


// ===== Gemini branch logic (auto-skips until the refactor is adopted) =========

function registerGeminiTests_(t) {
  var has = (typeof interpretGeminiResponse_ === 'function');
  function skipIfAbsent() { return has ? null : 'SKIP'; }

  t('gemini: non-200 throws with code', function () {
    if (!has) return 'SKIP';
    assertThrows_(function () { interpretGeminiResponse_(500, { error: { message: 'boom' } }, false); }, '500');
  });
  t('gemini: no candidates throws', function () {
    if (!has) return 'SKIP';
    assertThrows_(function () { interpretGeminiResponse_(200, { candidates: [] }, false); }, 'candidates');
  });
  t('gemini: SAFETY throws (no poison success)', function () {
    if (!has) return 'SKIP';
    assertThrows_(function () {
      interpretGeminiResponse_(200, { candidates: [{ finishReason: 'SAFETY' }] }, false);
    }, 'safety');
  });
  t('gemini: RECITATION throws', function () {
    if (!has) return 'SKIP';
    assertThrows_(function () {
      interpretGeminiResponse_(200, { candidates: [{ finishReason: 'RECITATION' }] }, false);
    }, 'recitation');
  });
  t('gemini: empty text throws', function () {
    if (!has) return 'SKIP';
    assertThrows_(function () {
      interpretGeminiResponse_(200, { candidates: [{ content: { parts: [{ text: '' }] } }] }, false);
    }, 'empty');
  });
  t('gemini: happy path returns text + empty sources', function () {
    if (!has) return 'SKIP';
    var r = interpretGeminiResponse_(200, { candidates: [{ content: { parts: [{ text: 'hello' }] } }] }, false);
    assertEq_(r.text, 'hello');
    assertEq_(r.sources, '');
  });
  t('gemini: grounded response surfaces sources', function () {
    if (!has) return 'SKIP';
    var json = { candidates: [{
      content: { parts: [{ text: 'answer' }] },
      groundingMetadata: { groundingChunks: [{ web: { uri: 'http://x', title: 'X' } }] }
    }] };
    assertEq_(interpretGeminiResponse_(200, json, false).sources, 'X — http://x');
  });
}


// ===== INTEGRATION HELPERS (touch real services — run by hand, NOT in runTests) =

/**
 * Extract one real file into the pending folder so you can eyeball the review
 * sheet immediately. Costs one Vertex call and writes a real sheet. Does NOT
 * move the original, so it's repeatable (each run leaves another review sheet).
 */
function INTEGRATION_dryRunOneFile() {
  var FILE_ID = 'PUT_A_REAL_INGESTION_FILE_ID';
  var cfg = readConfig_();
  var sheet = extractOneFile_(DriveApp.getFileById(FILE_ID), cfg,
                              DriveApp.getFolderById(cfg.folder_id_pending));
  Logger.log('Review sheet created: ' + sheet.url);
}

/**
 * Push one real review sheet to Workato regardless of its checkbox. This really
 * hits the webhook (and Salesforce) — point workato_webhook_url at a TEST recipe,
 * or rely on the correlation_id upsert to keep repeats from duplicating records.
 * Does not mark/move the sheet, so it's repeatable.
 */
function INTEGRATION_pushOneSheet() {
  var SHEET_ID = 'PUT_A_REAL_REVIEW_SHEET_ID';
  var cfg = readConfig_();
  var approval = readApproval_(SpreadsheetApp.openById(SHEET_ID));
  approval.approved = true;                       // force, to exercise the POST
  pushToWorkato_(approval, cfg);
  Logger.log('Pushed correlation_id ' + approval.correlationId);
}


/* -----------------------------------------------------------------------------
 * OPTIONAL REFACTOR to make the Gemini branch logic unit-testable
 * -----------------------------------------------------------------------------
 * In ContractIntake.gs, replace the body of callGemini_ AFTER the fetch with:
 *
 *     var json = JSON.parse(resp.getContentText());
 *     return interpretGeminiResponse_(resp.getResponseCode(), json, cfg.grounding_debug);
 *
 * and add this pure function (it's the same logic, just lifted out of the I/O):
 *
 *     function interpretGeminiResponse_(code, json, groundingDebug) {
 *       if (code !== 200) {
 *         throw new Error('Vertex ' + code + ': ' +
 *           ((json.error && json.error.message) || JSON.stringify(json)));
 *       }
 *       var cand = json.candidates && json.candidates[0];
 *       if (!cand) throw new Error('Gemini returned no candidates.');
 *       if (cand.finishReason === 'SAFETY')     throw new Error('Gemini blocked: safety.');
 *       if (cand.finishReason === 'RECITATION') throw new Error('Gemini blocked: recitation.');
 *       var text = ((cand.content && cand.content.parts) || [])
 *         .map(function (p) { return p.text || ''; }).join('').trim();
 *       if (!text) throw new Error('Gemini returned an empty response.');
 *       var debug = groundingDebug
 *         ? (cand.groundingMetadata
 *             ? 'keys=' + JSON.stringify(Object.keys(cand.groundingMetadata))
 *             : '(no groundingMetadata)')
 *         : '';
 *       return { text: text, sources: extractSources_(cand.groundingMetadata), debug: debug };
 *     }
 *
 * Once added, the gemini: tests above stop skipping and turn green.
 *
 * -----------------------------------------------------------------------------
 * MANUAL END-TO-END SMOKE TEST (the service-bound paths)
 * -----------------------------------------------------------------------------
 * 1. validateConfig()                  — config keys present and typed.
 * 2. Drop a known PDF in the ingestion folder. Run processIngestion() manually.
 *    Expect: a review sheet in pending, the original in processed, a Chat ping.
 * 3. Drop a deliberately garbled/blank file. Run processIngestion().
 *    Expect: original in FAILED, a Chat failure ping, no review sheet.
 * 4. Open the review sheet, change one Approved cell, tick Approved?.
 *    Run processApprovals(). Expect: Workato receives the corrected value (not
 *    the extracted one), sheet Status=Pushed, sheet moved to pushed.
 * 5. Run processApprovals() again immediately. Expect: nothing re-sent (sheet
 *    already in pushed). If you re-push the same correlation_id by hand, confirm
 *    Salesforce upserts rather than duplicating.
 * --------------------------------------------------------------------------- */
