/**
 * Probes data table schema endpoints and returns full response details.
 * Run this from the Apps Script editor to diagnose 401/404/endpoint issues.
 * 
 * @param {string} [tableName] - Optional: also attempt a by-name lookup.
 */
function RUN_diagnoseDataTableEndpoints(tableName) {
  const ctx        = new AppContext();
  const config     = AppConfig.get();
  const baseUrl    = config.API.BASE_URL;
  const token      = config.API.TOKEN;
  const targetName = tableName || 'VER_TemplateVersion';

  const results = [];

  // Helper: raw fetch with full response detail
  function probe(label, url) {
    try {
      const response = UrlFetchApp.fetch(url, {
        method:             'get',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        'application/json'
        },
        muteHttpExceptions: true
      });

      const code = response.getResponseCode();
      let   body = response.getContentText();
      let   parsed = null;

      try { parsed = JSON.parse(body); } catch (_) {}

      // Summarize rather than dump entire payload
      const summary = parsed
        ? (Array.isArray(parsed.data)  ? `data[]: ${parsed.data.length} items`
         : Array.isArray(parsed)       ? `array: ${parsed.length} items`
         : typeof parsed === 'object'  ? `keys: ${Object.keys(parsed).join(', ')}`
         : String(parsed))
        : body.slice(0, 300);

      results.push({ label, url, status: code, summary });

    } catch (e) {
      results.push({ label, url, status: 'EXCEPTION', summary: e.message });
    }
  }

  // --- Probe 1: list all tables (the path getDataTables uses)
  probe('list /api/data_tables',
    `${baseUrl}/data_tables`);

  // --- Probe 2: list with explicit per_page
  probe('list /api/data_tables?per_page=5',
    `${baseUrl}/data_tables?per_page=5`);

  // --- Probe 3: detail by ID — need a real ID, so fetch list first
  try {
    const allTables = ctx.inventoryService.getDataTables();
    const match     = allTables.find(t => t.name === targetName) || allTables[0];

    if (match) {
      // Probe the corrected endpoint (data_tables, not data_dtables)
      probe(`detail /api/data_tables/${match.id} (corrected)`,
        `${baseUrl}/data_tables/${match.id}`);

      // Probe the original misspelled endpoint so we can confirm the difference
      probe(`detail /api/data_dtables/${match.id} (original — expected to fail)`,
        `${baseUrl}/data_dtables/${match.id}`);
    } else {
      results.push({ label: 'detail probe', url: 'n/a', status: 'SKIP', summary: 'No tables found in list response' });
    }
  } catch (e) {
    results.push({ label: 'detail probe setup', url: 'n/a', status: 'EXCEPTION', summary: e.message });
  }

  // --- Probe 4: confirm token identity
  try {
    const me = ctx.inventoryService.getCurrentUser();
    results.push({
      label:   'token identity /api/users/me',
      url:     `${baseUrl}/users/me`,
      status:  me ? 200 : 'null response',
      summary: me ? `id: ${me.id}, email: ${me.email || me.name || '(no email in response)'}` : 'null'
    });
  } catch (e) {
    results.push({ label: 'token identity', url: 'n/a', status: 'EXCEPTION', summary: e.message });
  }

  Logger.log('\n=== DATA TABLE ENDPOINT DIAGNOSTICS ===\n' + JSON.stringify(results, null, 2));
  return results;
}
