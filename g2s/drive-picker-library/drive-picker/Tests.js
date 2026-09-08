/**
 * @file Tests.gs — hermetic tests for the DrivePicker library.
 * RUN: select runTests() in the editor and Run, or `node run-tests-node.js` locally.
 *
 * COVERED: downloadPlan_, isGoogleNative_, withExt_, describeDriveError_.
 * NOT: fetchPicked (UrlFetchApp), clientHtml (HtmlService), and everything in Client.html — exercise those from a
 * host page; see README "Smoke test".
 */

function runTests() {
  var cases = [];
  function t(name, fn) { cases.push([name, fn]); }

  registerPlanTests_(t);
  registerErrorTests_(t);

  var pass = 0, fail = 0, lines = [];
  cases.forEach(function (c) {
    try { c[1](); pass++; lines.push('ok    ' + c[0]); }
    catch (e) { fail++; lines.push('FAIL  ' + c[0] + '\n        ' + e.message); }
  });
  var summary = pass + ' passed, ' + fail + ' failed';
  Logger.log(lines.join('\n') + '\n\n' + summary);
  return summary;
}

function assert_(cond, msg) { if (!cond) throw new Error('assert failed: ' + (msg || '')); }
function assertEq_(actual, expected, msg) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error((msg ? msg + ' — ' : '') + 'expected ' + e + ', got ' + a);
}
function assertThrows_(fn, includes, msg) {
  var threw = false, m = '';
  try { fn(); } catch (e) { threw = true; m = e.message; }
  if (!threw) throw new Error((msg || '') + ' expected a throw, got none');
  if (includes && m.toLowerCase().indexOf(includes.toLowerCase()) === -1) {
    throw new Error((msg || '') + ' threw "' + m + '", expected to include "' + includes + '"');
  }
}

// --- downloadPlan_ -------------------------------------------------------------------------------
function registerPlanTests_(t) {
  t('plan: a PDF is fetched as media, across shared drives, name and type preserved', function () {
    var p = downloadPlan_({ id: 'abc 123', name: 'MSA.pdf', mimeType: 'application/pdf' });
    assertEq_(p.url, 'https://www.googleapis.com/drive/v3/files/abc%20123?alt=media&supportsAllDrives=true');
    assertEq_(p.name, 'MSA.pdf');
    assertEq_(p.mimeType, 'application/pdf');
    assertEq_(p.exported, false);
  });

  t('plan: a Word file is fetched as media with its own type', function () {
    var docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    var p = downloadPlan_({ id: 'x', name: 'sow.docx', mimeType: docx });
    assert_(p.url.indexOf('alt=media') !== -1);
    assertEq_(p.mimeType, docx);
  });

  t('plan: unknown MIME still downloads; type left to Drive', function () {
    var p = downloadPlan_({ id: 'x', name: 'scan', mimeType: '' });
    assertEq_(p.mimeType, null);
    assertEq_(p.exported, false);
  });

  t('plan: a Google Doc is exported to PDF by default and gets .pdf', function () {
    var p = downloadPlan_({ id: 'd1', name: 'Contract MSA', mimeType: 'application/vnd.google-apps.document' });
    assertEq_(p.url, 'https://www.googleapis.com/drive/v3/files/d1/export?mimeType=application%2Fpdf');
    assertEq_(p.name, 'Contract MSA.pdf');
    assertEq_(p.mimeType, 'application/pdf');
    assertEq_(p.exported, true);
  });

  t('plan: host may choose the export format; extension follows', function () {
    var docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    var p = downloadPlan_({ id: 'd1', name: 'Contract.v2', mimeType: 'application/vnd.google-apps.document' }, docx);
    assertEq_(p.name, 'Contract.v2.docx');
    assertEq_(p.mimeType, docx);
    assert_(p.url.indexOf(encodeURIComponent(docx)) !== -1, 'export mime in url');
  });

  t('plan: a Sheet exports to PDF; a Form is refused with a readable reason', function () {
    assertEq_(downloadPlan_({ id: 's', name: 'Rates', mimeType: 'application/vnd.google-apps.spreadsheet' }).name, 'Rates.pdf');
    assertThrows_(function () {
      downloadPlan_({ id: 'f', name: 'Survey', mimeType: 'application/vnd.google-apps.form' });
    }, 'cannot be downloaded or exported');
  });

  t('plan: nothing picked / no id', function () {
    assertThrows_(function () { downloadPlan_(null); }, 'nothing was picked');
    assertThrows_(function () { downloadPlan_({ name: 'x' }); }, 'nothing was picked');
  });

  t('plan: missing name falls back to the id', function () {
    assertEq_(downloadPlan_({ id: 'zz', mimeType: 'application/pdf' }).name, 'zz');
  });

  t('isGoogleNative_ / withExt_', function () {
    assert_(isGoogleNative_('application/vnd.google-apps.document'));
    assert_(!isGoogleNative_('application/pdf'));
    assert_(!isGoogleNative_(''));
    assertEq_(withExt_('a', 'pdf'), 'a.pdf');
    assertEq_(withExt_('a.PDF', 'pdf'), 'a.PDF', 'case-insensitive match keeps the name');
    assertEq_(withExt_('a.doc', 'pdf'), 'a.doc.pdf');
    assertEq_(withExt_('a', undefined), 'a');
  });
}

// --- describeDriveError_ -------------------------------------------------------------------------
function registerErrorTests_(t) {
  var body = function (reason, message) {
    return JSON.stringify({ error: { errors: [{ reason: reason }], message: message || reason } });
  };

  t('errors: 401 says the token is the problem', function () {
    assert_(/token/i.test(describeDriveError_(401, body('authError'), 'x.pdf')));
  });
  t('errors: 403 explains drive.file and names the file', function () {
    var m = describeDriveError_(403, body('insufficientFilePermissions'), 'MSA.pdf');
    assert_(m.indexOf('MSA.pdf') !== -1 && /drive\.file/.test(m), m);
    assert_(m.indexOf('insufficientFilePermissions') !== -1, 'reason surfaced');
  });
  t('errors: 403 rate limit is distinguished', function () {
    assert_(/rate-limiting/.test(describeDriveError_(403, body('userRateLimitExceeded'), 'x')));
  });
  t('errors: 404', function () {
    assert_(/not found/.test(describeDriveError_(404, body('notFound'), 'x')));
  });
  t('errors: other codes include the code and reason; non-JSON body tolerated', function () {
    assert_(/500/.test(describeDriveError_(500, '<html>boom</html>', 'x')));
    assert_(/backendError/.test(describeDriveError_(500, body('backendError'), 'x')));
  });
}
