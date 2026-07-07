function crossValidateLiveCorpus() {
  const client = WorkatoLib.newClient(
    PropertiesService.getScriptProperties().getProperty('WORKATO_TOKEN'),
    'https://app.eu.workato.com/api'
  ); // attach WorkatoLib as a third library
  const analyzer = WorkatoGraphLib.newAnalyzer(client, { STRICT: true });
  analyzer.primeCache(client.fetchPaginated('recipes?folder_id=YOUR_SDC_FOLDER'));

  const manifest = /* your 58 rows: [{id, name}, ...] */ [];
  const orderer = WorkatoOrderLib.newOrderer({ strict: true });
  const graph = orderer.buildCorpusGraph(analyzer, manifest);

  Logger.log(JSON.stringify({
    fingerprint: orderer.fingerprint(graph.edges),
    edges: graph.edges.map(e => e.join('->')).sort(),
    findings: graph.findings
  }, null, 2));
}
