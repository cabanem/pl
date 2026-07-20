/**
 * SDC form shim - spike build. This IS the production shim shape;
 * STUB_MODE is the only spike-specific thing in it.
 *
 * STUB_MODE = true  : serves the embedded golden form, echoes POSTs locally.
 *                     Proves Seam 1 (HtmlService serving + POST round trip).
 *                     Zero Workato involvement.
 * STUB_MODE = false : relays to Workato. Proves Seams 3 and 4 once the two
 *                     spike recipes exist.
 *
 * Script properties required when STUB_MODE = false:
 *   WORKATO_BASE   e.g. https://apim.workato.com/<prefix>/sdc
 *   API_TOKEN      key from the spike API client
 *
 * Deploy: New deployment > Web app > Execute as: Me > Access: Anyone.
 */
var STUB_MODE = true;

function doGet(e) {
  if (STUB_MODE) {
    var html = GOLDEN_HTML.replace(
      'https://script.google.com/macros/s/DEPLOY_ID/exec',
      ScriptApp.getService().getUrl());
    return HtmlService.createHtmlOutput(html);
  }
  var props = PropertiesService.getScriptProperties();
  var r = UrlFetchApp.fetch(
    props.getProperty('WORKATO_BASE') + '/form?token=' +
      encodeURIComponent((e.parameter && e.parameter.token) || ''),
    { headers: { 'api-token': props.getProperty('API_TOKEN') },
      muteHttpExceptions: true });
  return HtmlService.createHtmlOutput(r.getContentText());
}

function doPost(e) {
  var fields = {};
  Object.keys(e.parameter || {}).forEach(function (k) {
    fields[k] = e.parameter[k];
  });
  var token = fields.token || '';
  delete fields.token;

  if (STUB_MODE) {
    var body = '<!DOCTYPE html><html><body style="font-family:monospace;padding:24px">' +
      '<h2>Seam 1 PASS &mdash; doPost received:</h2><pre>' +
      esc_(JSON.stringify({ token: token, fields: fields }, null, 2)) +
      '</pre><p>This JSON is byte-for-byte the envelope the shim forwards to /submit.<br>' +
      'Expected: seniority is ABSENT (its dropdown was disabled &mdash; contract: missing &equiv; null).</p>' +
      '</body></html>';
    return HtmlService.createHtmlOutput(body);
  }
  var props = PropertiesService.getScriptProperties();
  var r = UrlFetchApp.fetch(props.getProperty('WORKATO_BASE') + '/submit', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'api-token': props.getProperty('API_TOKEN') },
    payload: JSON.stringify({ token: token, fields: fields }),
    muteHttpExceptions: true });
  return HtmlService.createHtmlOutput(r.getContentText());
}

function esc_(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

var GOLDEN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Supplier rate card submission</title>
<style>:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px;
  font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  background: #f4f5f7; color: #1c2530; font-size: 16px; line-height: 1.5; }
main { max-width: 640px; margin: 0 auto; }
header { margin: 0 0 20px; }
h1 { font-size: 22px; font-weight: 600; margin: 0 0 6px; }
.meta { font-size: 14px; color: #5c6873; margin: 0; }
.meta span + span::before { content: " \\00b7 "; }
form { background: #ffffff; border: 1px solid #d8dde3; border-radius: 8px;
  padding: 24px 24px 28px; }
.form-errors { background: #fdf1f0; border: 1px solid #c8564a;
  border-radius: 6px; padding: 12px 16px; margin: 0 0 20px; }
.form-errors p { margin: 0 0 4px; font-weight: 600; color: #8f2f26; font-size: 15px; }
.form-errors ul { margin: 0; padding-left: 20px; color: #8f2f26; font-size: 14px; }
.field { margin: 0 0 20px; }
label { display: block; font-size: 14px; font-weight: 600; margin: 0 0 6px; }
.req { color: #8f2f26; }
input, select, textarea { width: 100%; padding: 9px 12px; font-size: 15px;
  font-family: inherit; color: inherit; background: #ffffff;
  border: 1px solid #c3cad2; border-radius: 6px; }
textarea { min-height: 96px; resize: vertical; }
select:disabled { background: #eef0f3; color: #7a8590; }
input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible {
  outline: 2px solid #2b5d9c; outline-offset: 1px; }
.invalid { border-color: #c8564a; }
.help { font-size: 13px; color: #5c6873; margin: 6px 0 0; }
.errors { list-style: none; margin: 6px 0 0; padding: 0;
  font-size: 13px; color: #8f2f26; }
.actions { margin: 28px 0 0; }
button { padding: 11px 24px; font-size: 15px; font-weight: 600;
  color: #ffffff; background: #24476f; border: 1px solid #24476f;
  border-radius: 6px; cursor: pointer; width: auto; }
button:hover { background: #1c3a5c; }
footer { max-width: 640px; margin: 16px auto 0; font-size: 12px;
  color: #7a8590; }</style>
</head>
<body>
<main>
<header>
<h1>Supplier rate card submission</h1>
<p class="meta"><span>MARS RC Data Collection</span><span>Acme Staffing LLC</span><span>Due 2026-08-15</span></p>
</header>
<form method="POST" action="https://script.google.com/macros/s/DEPLOY_ID/exec" data-template-version="1.3" data-contract-version="1.0">
<input type="hidden" name="token" value="8f14e45f-ceea-4671-a5b9-6d3d6f1c2a9e">
<div class="field" id="field_job_family"><label for="fld_job_family">Job family <span class="req" aria-hidden="true">*</span></label><select id="fld_job_family" name="job_family" required><option value="">Select…</option><option value="Engineering" selected>Engineering</option><option value="Finance">Finance</option></select></div>
<div class="field" id="field_role"><label for="fld_role">Role <span class="req" aria-hidden="true">*</span></label><select id="fld_role" name="role" required data-parent="job_family" disabled><option value="">Select…</option></select></div>
<div class="field" id="field_seniority"><label for="fld_seniority">Seniority <span class="req" aria-hidden="true">*</span></label><select id="fld_seniority" name="seniority" required aria-invalid="true" class="invalid" aria-describedby="err_seniority" data-parent="role" disabled><option value="">Select…</option></select><ul class="errors" id="err_seniority"><li>Required.</li></ul></div>
<div class="field" id="field_bill_rate"><label for="fld_bill_rate">Bill rate (USD/hr) <span class="req" aria-hidden="true">*</span></label><input type="number" id="fld_bill_rate" name="bill_rate" required aria-invalid="true" class="invalid" aria-describedby="help_bill_rate err_bill_rate" value="612.50" min="0" max="500" step="0.01"><p class="help" id="help_bill_rate">Standard rate before markup.</p><ul class="errors" id="err_bill_rate"><li>Must be at most 500.</li></ul></div>
<div class="field" id="field_effective_date"><label for="fld_effective_date">Effective date <span class="req" aria-hidden="true">*</span></label><input type="date" id="fld_effective_date" name="effective_date" required aria-invalid="true" class="invalid" aria-describedby="err_effective_date" value="2027-02-01" max="2026-12-31"><ul class="errors" id="err_effective_date"><li>Must be on or before 2026-12-31.</li></ul></div>
<div class="actions"><button type="submit">Submit rate card</button></div>
</form>
</main>
<footer>Submitted data is reviewed before acceptance. Reply to the request email with any questions.</footer>
<script>
var SDC_OPTIONS = {"job_family|":["Engineering","Finance"],"role|Engineering":["Integration developer","Data engineer"],"role|Finance":["Financial analyst"],"seniority|Data engineer":["Level I","Level II"],"seniority|Financial analyst":[],"seniority|Integration developer":["Level I","Level II","Level III"]};
var SDC_VALUES = {"job_family":"Engineering","role":"Integration developer","seniority":null};
var SDC_CHAIN = [["job_family",null],["role","job_family"],["seniority","role"]];
(function () {
  function byId(fid) { return document.getElementById("fld_" + fid); }
  function fill(sel, opts, saved) {
    while (sel.firstChild) { sel.removeChild(sel.firstChild); }
    var ph = document.createElement("option");
    ph.value = "";
    if (opts === null || opts === undefined) {
      ph.textContent = "Select\\u2026";
      sel.appendChild(ph);
      sel.disabled = true;
      return;
    }
    if (opts.length === 0) {
      ph.textContent = "Not applicable";
      sel.appendChild(ph);
      sel.disabled = true;
      return;
    }
    ph.textContent = "Select\\u2026";
    sel.appendChild(ph);
    for (var i = 0; i < opts.length; i++) {
      var el = document.createElement("option");
      el.value = opts[i];
      el.textContent = opts[i];
      sel.appendChild(el);
    }
    sel.disabled = false;
    if (saved !== null && saved !== undefined && opts.indexOf(saved) !== -1) {
      sel.value = saved;
    }
  }
  function childrenOf(fid) {
    var out = [];
    for (var i = 0; i < SDC_CHAIN.length; i++) {
      if (SDC_CHAIN[i][1] === fid) { out.push(SDC_CHAIN[i][0]); }
    }
    return out;
  }
  function refreshChild(cid, saved) {
    var child = byId(cid);
    var parentValue = byId(child.getAttribute("data-parent")).value;
    var opts = parentValue === "" ? null : SDC_OPTIONS[cid + "|" + parentValue];
    fill(child, opts === undefined ? null : opts, saved);
  }
  function clearDown(fid) {
    var kids = childrenOf(fid);
    for (var i = 0; i < kids.length; i++) {
      fill(byId(kids[i]), null, null);
      clearDown(kids[i]);
    }
  }
  function initCascade() {
    for (var i = 0; i < SDC_CHAIN.length; i++) {
      var fid = SDC_CHAIN[i][0];
      var parent = SDC_CHAIN[i][1];
      if (parent !== null) {
        refreshChild(fid, SDC_VALUES[fid]);
      }
      (function (id) {
        byId(id).addEventListener("change", function () {
          clearDown(id);
          var kids = childrenOf(id);
          for (var k = 0; k < kids.length; k++) { refreshChild(kids[k], null); }
        });
      })(fid);
    }
  }
  initCascade();
})();
</script>
</body>
</html>`;
