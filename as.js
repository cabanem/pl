<!DOCTYPE html>
<html>
<head>
  <base target="_top">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: 13px;
      color: #202124;
      padding: 16px 20px 20px;
      margin: 0;
      line-height: 1.5;
    }
    h3 {
      margin: 20px 0 10px;
      font-size: 14px;
      font-weight: 600;
      color: #3c4043;
    }
    .summary {
      padding: 12px 14px;
      margin-bottom: 16px;
      border-radius: 6px;
      font-weight: 500;
    }
    .summary.pass {
      background: #e6f4ea;
      color: #137333;
      border-left: 4px solid #34a853;
    }
    .summary.fail {
      background: #fce8e6;
      color: #c5221f;
      border-left: 4px solid #ea4335;
    }
    .summary.warn {
      background: #fef7e0;
      color: #b06000;
      border-left: 4px solid #fbbc04;
    }
    .count-badge {
      display: inline-block;
      padding: 2px 8px;
      background: rgba(0,0,0,0.08);
      border-radius: 10px;
      font-size: 11px;
      margin-left: 6px;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      font-size: 12px;
      background: white;
    }
    th, td {
      text-align: left;
      padding: 8px 12px;
      border-bottom: 1px solid #e8eaed;
      vertical-align: top;
    }
    th {
      background: #f8f9fa;
      font-weight: 600;
      color: #5f6368;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.3px;
      border-bottom: 2px solid #e8eaed;
    }
    .error-type {
      white-space: nowrap;
      font-weight: 600;
      color: #c5221f;
      width: 1%;
    }
    .warning-item {
      padding: 6px 0;
      border-bottom: 1px solid #f1f3f4;
    }
    .warning-item:last-child {
      border-bottom: none;
    }
    .empty-state {
      color: #5f6368;
      font-style: italic;
      padding: 10px 0;
    }
  </style>
</head>
<body>

<? 
  var errors = (data && data.template_errors) || [];
  var warnings = (data && data.slot_warnings) || [];
  var errorCount = errors.length;
  var warningCount = warnings.length;
  var hasErrors = errorCount > 0;
  var hasWarnings = warningCount > 0;
?>

<? if (!hasErrors && !hasWarnings) { ?>
  <div class="summary pass">
    ✓ Validation passed. Configuration is ready to submit.
  </div>
<? } else if (!hasErrors && hasWarnings) { ?>
  <div class="summary warn">
    Validation passed with <?= warningCount ?> warning<?= warningCount === 1 ? '' : 's' ?>. 
    Configuration can be submitted; warnings are informational.
  </div>
<? } else { ?>
  <div class="summary fail">
    Found <?= errorCount ?> error<?= errorCount === 1 ? '' : 's' ?> that must be resolved before submitting.
  </div>
<? } ?>

<? if (hasErrors) { ?>
  <h3>Errors <span class="count-badge"><?= errorCount ?></span></h3>
  <table>
    <thead>
      <tr>
        <th>Type</th>
        <th>Detail</th>
      </tr>
    </thead>
    <tbody>
      <? errors.forEach(function(e) { ?>
        <tr>
          <td class="error-type"><?= e.error_type || 'Unknown' ?></td>
          <td><?= e.details || '' ?></td>
        </tr>
      <? }); ?>
    </tbody>
  </table>
<? } ?>

<? if (hasWarnings) { ?>
  <h3>Warnings <span class="count-badge"><?= warningCount ?></span></h3>
  <div>
    <? warnings.forEach(function(w) { ?>
      <div class="warning-item"><?= w ?></div>
    <? }); ?>
  </div>
<? } ?>

</body>
</html>
