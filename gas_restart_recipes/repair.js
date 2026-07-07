function crossValidateLiveCorpus() {
  const client = WorkatoLib.newClient(
    PropertiesService.getScriptProperties().getProperty('WORKATO_TOKEN'),
    'https://app.eu.workato.com/api'
  );
  const analyzer = WorkatoGraphLib.newAnalyzer(client, { STRICT: true });

  const recipes = client.fetchPaginated('recipes?folder_id=YOUR_SDC_FOLDER');
  analyzer.primeCache(recipes);

  // Manifest DERIVED from the same list call — same IDs, by construction.
  const manifest = recipes.map(r => ({ id: r.id, name: r.name }));

  const orderer = WorkatoOrderLib.newOrderer({ strict: true });
  const graph = orderer.buildCorpusGraph(analyzer, manifest);

  const nameById = new Map(manifest.map(m => [String(m.id), m.name]));
  Logger.log(JSON.stringify({
    recipe_count: manifest.length,
    fingerprint: orderer.fingerprint(graph.edges),
    edges_by_id: graph.edges.map(e => e.join('->')).sort(),
    edges_by_name: graph.edges.map(e =>
      `${nameById.get(e[0])} -> ${nameById.get(e[1])}`).sort(),  // diff THIS vs Python
    findings: graph.findings
  }, null, 2));
}
