/**
 * @file Test suite: WorkatoGraphLib (patched extraction) + WorkatoOrderLib
 * @description Fixture-driven tests, runnable two ways:
 *   - In GAS: paste alongside the libs, run runAllOrderTests() from the editor.
 *   - In Node: `node Test_OrderLib.js` (used to verify this sketch).
 *
 * Fixture provenance:
 *   FIXTURE_PRV01 is a trimmed skeleton of the REAL PRV-01 export you shared —
 *   structure, nesting, providers, and symbolic {zip_name,name,folder} flow_id
 *   refs preserved verbatim; schemas/params stripped. The API-shape fixtures
 *   (numeric flow_id, stringified code) are synthetic but mirror the live
 *   GET /recipes/:id format.
 */

/* eslint-disable no-var */

// -------------------------------------------------------------------------------------------------------
// TINY ASSERT KIT (no framework; works in GAS and Node)
// -------------------------------------------------------------------------------------------------------

var __results = [];
function check(label, fn) {
  try { fn(); __results.push(['PASS', label]); }
  catch (e) { __results.push(['FAIL', label + ' :: ' + e.message]); }
}
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'assertEq'}: got ${a}, want ${b}`);
}
function assertTrue(v, msg) { if (!v) throw new Error(msg || 'assertTrue failed'); }
function assertThrows(fn, contains, msg) {
  try { fn(); } catch (e) {
    if (contains && String(e.message).indexOf(contains) === -1) {
      throw new Error(`${msg || 'assertThrows'}: threw, but message '${e.message}' lacks '${contains}'`);
    }
    return e;
  }
  throw new Error(`${msg || 'assertThrows'}: did not throw`);
}

// -------------------------------------------------------------------------------------------------------
// MOCK CLIENT + FIXTURES
// -------------------------------------------------------------------------------------------------------

/** Mock WorkatoLib client: serves recipes from a map; counts network calls. */
function newMockClient(recipesById) {
  return {
    calls: 0,
    get: function (endpoint) {
      this.calls++;
      const m = String(endpoint).match(/^recipes\/(.+)$/);
      const r = m && recipesById[m[1]];
      if (!r) { const e = new Error('404'); throw e; }
      return r;
    }
  };
}

// --- SDC ID conventions used by fixtures ---
// 90001 PRV-01   90004 PRV-04   90010 OBS-01   90020 UTL-02
// 90030 TPL-01   90040 REQ-01   90050 STS-01 (synthetic API-shape)

// FIXTURE_PRV01: trimmed from the real export. Symbolic flow_id refs, object code.
// (Loaded from JSON string to mirror how GAS test fixtures are usually stored.)
var FIXTURE_PRV01 = /* injected below in Node; in GAS, paste fixture JSON here */ null;

// Synthetic live-API shape: numeric flow_id, STRINGIFIED code — the format
// GET /api/recipes/:id actually returns.
var FIXTURE_STS01_API = {
  id: 90050,
  name: 'STS-01 State transition service',
  code: JSON.stringify({
    provider: 'workato_recipe_function', name: 'execute', keyword: 'trigger',
    block: [
      { provider: 'workato_recipe_function', name: 'call_recipe_async', keyword: 'action',
        input: { flow_id: 90010, parameters: {} } },                   // -> OBS-01 (numeric)
      { provider: 'workato_recipe_function', name: 'return_result', keyword: 'action',
        input: { result: 'ok' } }                                       // NOT a call
    ]
  })
};

// Weak-edge fixture: a non-call step whose input MENTIONS a recipe_id (config blob).
var FIXTURE_WEAK = {
  id: 90060, name: 'CFG-99 Config echo (weak edge trap)',
  code: {
    provider: 'workato_recipe_function', name: 'execute', keyword: 'trigger',
    block: [
      { provider: 'workato_variable', name: 'set_var', keyword: 'action',
        input: { value: { some_config: { recipe_id: 90010 } } } }       // depth-2 mention
    ]
  }
};

// Dynamic-callee fixture: call step whose flow_id is a datapill expression.
var FIXTURE_DYNAMIC = {
  id: 90070, name: 'DSP-01 Dynamic dispatcher',
  code: {
    provider: 'workato_recipe_function', name: 'execute', keyword: 'trigger',
    block: [
      { provider: 'workato_recipe_function', name: 'call_recipe', keyword: 'action',
        input: { flow_id: "#{_dp('{\"pill\":true}')}", parameters: {} } }
    ]
  }
};

// Leaf recipes (no outgoing calls).
function leaf(id, name) {
  return { id: id, name: name, code: {
    provider: 'workato_recipe_function', name: 'execute', keyword: 'trigger',
    block: [ { provider: 'workato_recipe_function', name: 'return_result',
               keyword: 'action', input: { result: 'ok' } } ] } };
}
var FIXTURE_OBS01 = leaf(90010, 'OBS-01 Event emitter');
var FIXTURE_UTL02 = leaf(90020, 'UTL-02 Create directories in FileStorage');
var FIXTURE_TPL01 = leaf(90030, 'TPL-01 Build XLSX template');
var FIXTURE_REQ01 = leaf(90040, 'REQ-01 Create supplier request');

// Cycle pair (synthetic): A calls B, B calls A.
var FIXTURE_CYCLE_A = { id: 90081, name: 'CYC-A', code: {
  provider: 'workato_recipe_function', name: 'execute', keyword: 'trigger',
  block: [ { provider: 'workato_recipe_function', name: 'call_recipe',
             keyword: 'action', input: { flow_id: 90082 } } ] } };
var FIXTURE_CYCLE_B = { id: 90082, name: 'CYC-B', code: {
  provider: 'workato_recipe_function', name: 'execute', keyword: 'trigger',
  block: [ { provider: 'workato_recipe_function', name: 'call_recipe',
             keyword: 'action', input: { flow_id: 90081 } } ] } };

// The corpus manifest used across tests (names enable symbolic resolution).
function corpusManifest() {
  return [
    { id: 90001, name: 'PRV-01 Provisioning (read config file, create directories, invite analyst to workspace)' },
    { id: 90010, name: 'OBS-01 Event emitter' },
    { id: 90020, name: 'UTL-02 Create directories in FileStorage' },
    { id: 90050, name: 'STS-01 State transition service' }
  ];
}

// -------------------------------------------------------------------------------------------------------
// TESTS
// -------------------------------------------------------------------------------------------------------

function runAllOrderTests() {
  __results = [];

  // ---------- Extraction: real export skeleton (symbolic refs) ----------
  check('PRV-01 export: extracts strong symbolic edges to OBS-01 and UTL-02, no phantoms', function () {
    const an = newAnalyzer(newMockClient({}), { STRICT: true });
    an.primeCache([FIXTURE_PRV01]);
    const edges = an.getCallEdges(90001);

    const strong = edges.filter(e => e.strength === 'strong');
    assertTrue(strong.length >= 2, 'expected multiple strong edges, got ' + strong.length);
    strong.forEach(e => assertEq(e.child_ref.kind, 'symbolic', 'export refs must classify symbolic'));

    const targets = new Set(strong.map(e => e.child_ref.name));
    assertTrue(targets.has('OBS-01 Event emitter'), 'missing OBS-01 target');
    assertTrue(targets.has('UTL-02 Create directories in FileStorage'), 'missing UTL-02 target');
    assertEq(targets.size, 2, 'unexpected extra call targets: ' + [...targets].join(', '));

    // return_result steps share the provider but must produce NO edges.
    const fromReturns = edges.filter(e => e.step_name === 'return_result');
    assertEq(fromReturns.length, 0, 'return_result must never emit edges');
  });

  check('PRV-01 export: sync/async call_type captured', function () {
    const an = newAnalyzer(newMockClient({}), { STRICT: true });
    an.primeCache([FIXTURE_PRV01]);
    const edges = an.getCallEdges(90001);
    const types = new Set(edges.filter(e => e.strength === 'strong').map(e => e.call_type));
    assertTrue(types.has('async'), 'OBS-01 emits should be async');
    assertTrue(types.has('sync'), 'UTL-02 calls should be sync');
  });

  // ---------- Extraction: live-API shape (numeric, stringified) ----------
  check('STS-01 API shape: stringified code parsed, numeric ref classified id', function () {
    const an = newAnalyzer(newMockClient({}), { STRICT: true });
    an.primeCache([FIXTURE_STS01_API]);
    const edges = an.getCallEdges(90050);
    assertEq(edges.length, 1, 'exactly one edge expected');
    assertEq(edges[0].child_ref, { kind: 'id', id: '90010' }, 'numeric ref');
    assertEq(edges[0].child_recipe_id, '90010', 'back-compat field populated for numeric');
    assertEq(edges[0].strength, 'strong');
  });

  // ---------- Extraction: traps ----------
  check('Weak edge: id-like key on non-call step is flagged weak, not strong', function () {
    const an = newAnalyzer(newMockClient({}), { STRICT: true });
    an.primeCache([FIXTURE_WEAK]);
    const edges = an.getCallEdges(90060);
    assertEq(edges.length, 1);
    assertEq(edges[0].strength, 'weak', 'config mention must not be a strong edge');
  });

  check('Dynamic callee: datapill flow_id classified dynamic', function () {
    const an = newAnalyzer(newMockClient({}), { STRICT: true });
    an.primeCache([FIXTURE_DYNAMIC]);
    const edges = an.getCallEdges(90070);
    assertEq(edges.length, 1);
    assertEq(edges[0].strength, 'dynamic');
    assertEq(edges[0].child_ref.kind, 'dynamic');
  });

  check('Strict mode: unreadable recipe throws instead of returning []', function () {
    const an = newAnalyzer(newMockClient({}), { STRICT: true }); // empty backing map -> 404
    assertThrows(function () { an.getCallEdges(99999); }, 'strict');
  });

  check('Non-strict mode: unreadable recipe degrades to [] (doc-consumer behavior preserved)', function () {
    const an = newAnalyzer(newMockClient({}), { STRICT: false });
    assertEq(an.getCallEdges(99999), [], 'legacy degradation intact');
  });

  check('primeCache: zero network calls after priming', function () {
    const mock = newMockClient({});
    const an = newAnalyzer(mock, { STRICT: true });
    an.primeCache([FIXTURE_PRV01, FIXTURE_OBS01, FIXTURE_UTL02]);
    an.getCallEdges(90001); an.getCallEdges(90010); an.getCallEdges(90020);
    assertEq(mock.calls, 0, 'all reads must hit cache');
  });

  // ---------- Ordering: graph build + resolution ----------
  check('buildCorpusGraph: symbolic refs resolve via manifest names; edges dedupe', function () {
    const an = newAnalyzer(newMockClient({}), { STRICT: true });
    an.primeCache([FIXTURE_PRV01, FIXTURE_OBS01, FIXTURE_UTL02, FIXTURE_STS01_API]);
    const ord = newOrderer({ strict: true });
    const g = ord.buildCorpusGraph(an, corpusManifest());

    // PRV-01 calls OBS-01 many times and UTL-02 twice -> deduped to 2 edges,
    // plus STS-01 -> OBS-01 (numeric). Total 3.
    const key = g.edges.map(e => e.join('->')).sort();
    assertEq(key, ['90001->90010', '90001->90020', '90050->90010']);
  });

  check('buildCorpusGraph: external callee is a warn finding, not an edge', function () {
    const an = newAnalyzer(newMockClient({}), { STRICT: true });
    an.primeCache([FIXTURE_STS01_API]);
    const ord = newOrderer({ strict: true });
    // Manifest lacks OBS-01: STS-01's callee is external.
    const g = ord.buildCorpusGraph(an, [{ id: 90050, name: 'STS-01 State transition service' }]);
    assertEq(g.edges, []);
    assertTrue(g.findings.some(f => f.code === 'EXTERNAL_CALLEE'), 'expected EXTERNAL_CALLEE finding');
  });

  check('buildCorpusGraph strict: unresolvable symbolic ref aborts', function () {
    const an = newAnalyzer(newMockClient({}), { STRICT: true });
    an.primeCache([FIXTURE_PRV01, FIXTURE_OBS01, FIXTURE_UTL02]);
    const ord = newOrderer({ strict: true });
    // Manifest includes PRV-01 + OBS-01 but omits UTL-02's NAME -> symbolic miss.
    const badManifest = [
      { id: 90001, name: 'PRV-01 Provisioning (read config file, create directories, invite analyst to workspace)' },
      { id: 90010, name: 'OBS-01 Event emitter' },
      { id: 90020 } // no name: symbolic ref to UTL-02 cannot resolve
    ];
    const err = assertThrows(function () { ord.buildCorpusGraph(an, badManifest); }, 'fatal');
    assertTrue(err.findings.some(f => f.code === 'UNRESOLVED_SYMBOLIC'), 'expected UNRESOLVED_SYMBOLIC');
  });

  check('buildCorpusGraph strict: dynamic callee aborts (statically unorderable)', function () {
    const an = newAnalyzer(newMockClient({}), { STRICT: true });
    an.primeCache([FIXTURE_DYNAMIC]);
    const ord = newOrderer({ strict: true });
    const err = assertThrows(function () {
      ord.buildCorpusGraph(an, [{ id: 90070, name: 'DSP-01 Dynamic dispatcher' }]);
    }, 'fatal');
    assertTrue(err.findings.some(f => f.code === 'DYNAMIC_CALLEE'), 'expected DYNAMIC_CALLEE');
  });

  check('buildCorpusGraph: manage:false excludes a node and its edges', function () {
    const an = newAnalyzer(newMockClient({}), { STRICT: true });
    an.primeCache([FIXTURE_PRV01, FIXTURE_OBS01, FIXTURE_UTL02, FIXTURE_STS01_API]);
    const ord = newOrderer({ strict: false }); // non-strict: external refs warn only
    const manifest = corpusManifest();
    manifest.find(m => m.id === 90001).manage = false; // hold PRV-01
    const g = ord.buildCorpusGraph(an, manifest);
    assertEq(g.nodes.indexOf('90001'), -1, 'PRV-01 must not be a managed node');
    assertTrue(g.edges.every(e => e[0] !== '90001'), 'held recipe contributes no edges');
  });

  // ---------- Ordering: topo sort ----------
  check('topoSort: callees before callers; deterministic ties; stop = reverse', function () {
    const ord = newOrderer();
    const nodes = ['90001', '90010', '90020', '90050'];
    const edges = [['90001', '90010'], ['90001', '90020'], ['90050', '90010']];
    const start = ord.topoSort(nodes, edges);
    // Property 1 (correctness): every callee precedes its caller.
    edges.forEach(function (e) {
      assertTrue(start.indexOf(e[1]) < start.indexOf(e[0]),
        'callee ' + e[1] + ' must precede caller ' + e[0]);
    });
    // Property 2 (determinism): same graph -> same order, even with edges shuffled.
    const shuffled = [edges[2], edges[0], edges[1]];
    assertEq(ord.topoSort(nodes.slice().reverse(), shuffled), start,
      'order must be independent of input ordering');
    // Pin the current deterministic output so any algorithm change is a visible diff.
    assertEq(start, ['90010', '90020', '90001', '90050'], 'deterministic reference order');
  });

  check('topoSort: cycle throws and names members', function () {
    const an = newAnalyzer(newMockClient({}), { STRICT: true });
    an.primeCache([FIXTURE_CYCLE_A, FIXTURE_CYCLE_B]);
    const ord = newOrderer({ strict: true });
    const g = ord.buildCorpusGraph(an, [{ id: 90081, name: 'CYC-A' }, { id: 90082, name: 'CYC-B' }]);
    const err = assertThrows(function () { ord.topoSort(g.nodes, g.edges); }, 'Cycle');
    assertTrue(err.message.indexOf('90081') !== -1 && err.message.indexOf('90082') !== -1,
      'cycle members must be named');
  });

  // ---------- Pins ----------
  check('Pins: after-constraint reorders; contradictory pin becomes a cycle', function () {
    const an = newAnalyzer(newMockClient({}), { STRICT: true });
    an.primeCache([FIXTURE_OBS01, FIXTURE_UTL02]);
    const ord = newOrderer({ strict: true });

    // Two leaves, no call edges. Pin: OBS-01 starts after UTL-02.
    const g1 = ord.buildCorpusGraph(an, [
      { id: 90010, name: 'OBS-01 Event emitter', after: [90020] },
      { id: 90020, name: 'UTL-02 Create directories in FileStorage' }
    ]);
    assertEq(ord.topoSort(g1.nodes, g1.edges), ['90020', '90010'], 'pin must order UTL-02 first');

    // Contradiction: mutual pins -> cycle -> abort.
    const g2 = ord.buildCorpusGraph(an, [
      { id: 90010, name: 'OBS-01 Event emitter', after: [90020] },
      { id: 90020, name: 'UTL-02 Create directories in FileStorage', after: [90010] }
    ]);
    assertThrows(function () { ord.topoSort(g2.nodes, g2.edges); }, 'Cycle',
      'contradictory pins must be caught, not guessed around');
  });

  // ---------- Fingerprint / drift ----------
  check('fingerprint: order-insensitive, content-sensitive; diffEdges reports drift', function () {
    const ord = newOrderer();
    const a = [['1', '2'], ['3', '4']];
    const b = [['3', '4'], ['1', '2']];       // same set, different order
    const c = [['1', '2'], ['3', '5']];       // one edge changed
    assertEq(ord.fingerprint(a), ord.fingerprint(b), 'canonicalization must ignore order');
    assertTrue(ord.fingerprint(a) !== ord.fingerprint(c), 'content change must change hash');
    assertEq(ord.diffEdges(a, c), { added: ['3->5'], removed: ['3->4'] });
  });

  // ---------- Report ----------
  const lines = __results.map(r => r[0] + '  ' + r[1]);
  const fails = __results.filter(r => r[0] === 'FAIL').length;
  const summary = `\n${__results.length} checks, ${fails} failures\n` + lines.join('\n');
  if (typeof Logger !== 'undefined') Logger.log(summary); else console.log(summary);
  if (fails > 0 && typeof process !== 'undefined') process.exitCode = 1;
  return summary;
}

// ----- Node harness (ignored by GAS) -----
if (typeof module !== 'undefined' && typeof require !== 'undefined') {
  const fs = require('fs');
  const g = require('./WorkatoGraphLib_patched_core.js');
  const o = require('./WorkatoOrderLib.js');
  globalThis.newAnalyzer = g.newAnalyzer;
  globalThis.newOrderer = o.newOrderer;
  FIXTURE_PRV01 = JSON.parse(fs.readFileSync('./fixture_prv01_trimmed.json', 'utf8'));
  runAllOrderTests();
}
