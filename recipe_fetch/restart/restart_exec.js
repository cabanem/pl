/**
 * @file Workato restart executor
 * @description Side-effecting companion to WorkatoOrderLib. Consumes the pure start order produced by the
 *              Orderer and performs verified stop/start sequences against the Workato Developer API.
 *              Planning stays pure (no I/O); only executeStop / executeStart / execute touch the network.
 *
 * Design invariants (inherited from the ordering lib):
 *  - PLAN, THEN ACT. Every execution consumes an explicit, inspectable plan object.
 *    describePlan() before execute-anything; runners should surface the plan for a human read.
 *  - STALE PLANS ARE REFUSED. Edits made while recipes are stopped can change the call graph the
 *    plan was derived from. executeStart() compares the corpus fingerprint (Orderer.fingerprint)
 *    against the plan's and aborts on drift in strict mode. Deploy flow is therefore:
 *      makePlan -> executeStop -> edit in the builder -> rebuild graph -> makePlan -> executeStart
 *    execute(plan) runs both phases off one plan and is for PURE restarts (no edit window).
 *  - FAILURE HALTS DESCENT. A callee that will not start means its callers are never started
 *    above it, regardless of strictness. Half-started chains are worse than a stopped corpus.
 *  - ALL I/O IS INJECTABLE. newWorkatoClient() speaks UrlFetchApp by default; tests inject
 *    fetchImpl/sleepImpl, and an existing Workato client lib can be adapted at the four-method
 *    seam: fleetState(), startRecipe(id), stopRecipe(id), listJobs(id).
 *
 * Why order matters (execution-model recap):
 *  - A started recipe executes the version it was started with; saves publish, restarts deploy.
 *  - A function call binds to the callee RECIPE, not a version: each call runs whatever version
 *    the callee is currently started on. A call into a stopped function fails the caller's job.
 *  - Therefore: STOP callers before callees (reverse start order), START callees before callers.
 *  - Jobs paused mid-flight resume on the version they started with even after redeploy; use the
 *    drain option when that matters for a given change.
 *
 * Script properties used by the default client:
 *   WORKATO_API_TOKEN  (required)  API client token; needs recipe read + start/stop privileges.
 *   WORKATO_API_BASE   (optional)  Data-center base URL. Defaults to https://www.workato.com
 *
 * @version 0.1.0
 */

// -------------------------------------------------------------------------------------------------------
// PUBLIC FACTORIES
// -------------------------------------------------------------------------------------------------------

/**
 * Creates a new Executor.
 * @param {Object} client - Anything satisfying the client seam (see newWorkatoClient).
 * @param {Object} [options]
 * @param {boolean} [options.strict=true]        - Abort runs on staleness, unknown recipes, and stop failures.
 *                                                 (Start failures always halt; see invariants.)
 * @param {number}  [options.verifyTimeoutMs=30000] - Max wait for a recipe to reach the wanted state.
 * @param {number}  [options.verifyPollMs=2500]     - Poll interval while verifying.
 * @param {Object}  [options.drain]              - { enabled:false, timeoutMs:180000, pollMs:5000 }
 *                                                 Wait for in-flight jobs to complete before each stop.
 * @param {Function} [options.log]               - Line logger. Defaults to Logger.log / console.log.
 * @return {Executor}
 */
function newExecutor(client, options) {
  return new Executor(client, options);
}

/**
 * Creates the default Developer API client (UrlFetchApp).
 * @param {Object} [config]
 * @param {string}   [config.token]         - Overrides WORKATO_API_TOKEN script property.
 * @param {string}   [config.base]          - Overrides WORKATO_API_BASE script property.
 * @param {number}   [config.minIntervalMs=1100] - Pacing between calls; recipe endpoints allow 60 req/min.
 * @param {Function} [config.fetchImpl]     - (url, params) => HTTPResponse-like. Injectable for tests.
 * @param {Function} [config.sleepImpl]     - (ms) => void. Injectable for tests.
 * @return {WorkatoClient}
 */
function newWorkatoClient(config) {
  return new WorkatoClient(config);
}

// -------------------------------------------------------------------------------------------------------
// CUSTOM ERROR
// -------------------------------------------------------------------------------------------------------

/** Raised when a run cannot proceed honestly. Carries the partial report for the log. */
class ExecutionError extends Error {
  constructor(message, report) {
    super(message);
    this.name = 'ExecutionError';
    this.report = report || null;
  }
}

// -------------------------------------------------------------------------------------------------------
// EXECUTOR
// -------------------------------------------------------------------------------------------------------

class Executor {
  constructor(client, options = {}) {
    if (!client) throw new ExecutionError('Executor requires a client.');
    this.client = client;
    this.options = {
      strict: (options.strict !== undefined) ? options.strict : true,
      verifyTimeoutMs: options.verifyTimeoutMs || 30000,
      verifyPollMs: options.verifyPollMs || 2500,
      drain: Object.assign({ enabled: false, timeoutMs: 180000, pollMs: 5000 }, options.drain || {}),
      log: options.log || Executor._defaultLog
    };
  }

  // ----- Planning (pure — no I/O) -----------------------------------------

  /**
   * Builds an executable plan for a set of target recipe IDs.
   *
   * @param {Object} orderer - A WorkatoOrderLib Orderer (used for topoSort + fingerprint).
   * @param {Object} graph   - Output of orderer.buildCorpusGraph(): { nodes, edges, findings }.
   * @param {Array<string|number>} targetIds - Recipes whose versions changed (or must be recycled).
   * @param {Object} [opts]
   * @param {string} [opts.scope='upstream'] - 'upstream': targets plus every transitive caller
   *                                           (quiesce the chain; nothing calls into the window).
   *                                           'targets': only the targets; running upstream callers
   *                                           WILL fail calls while targets are down.
   * @param {Array<Object>} [opts.manifest]  - Orderer manifest rows; used only to label the report.
   * @returns {Object} plan: { createdAt, scope, targets, fingerprint, startOrder, stopOrder, names, notes }
   * @throws {ExecutionError} when a target is not a managed node of the graph.
   */
  makePlan(orderer, graph, targetIds, opts = {}) {
    const scopeMode = opts.scope || 'upstream';
    const nodeSet = new Set(graph.nodes.map(String));
    const targets = (targetIds || []).map(String);

    const unknown = targets.filter(t => !nodeSet.has(t));
    if (unknown.length) {
      throw new ExecutionError(
        `Target(s) not in the managed graph: ${unknown.join(', ')}. ` +
        `Add them to the manifest (or check manage:false exclusions) and re-plan.`);
    }

    const scopeSet = Executor._selectScope(graph, targets, scopeMode);

    // Any topological order restricted to a subset is a valid topological order of the
    // induced subgraph — so the full deterministic start order filters down for free.
    const fullStart = orderer.topoSort(graph.nodes, graph.edges);
    const startOrder = fullStart.filter(id => scopeSet.has(id));
    const stopOrder = startOrder.slice().reverse();

    const names = {};
    (opts.manifest || []).forEach(m => { names[String(m.id)] = m.name || ''; });

    const notes = [];
    if (scopeMode === 'targets') {
      const upstreamOnly = [...Executor._selectScope(graph, targets, 'upstream')]
        .filter(id => !scopeSet.has(id));
      if (upstreamOnly.length) {
        notes.push(`scope=targets leaves ${upstreamOnly.length} upstream caller(s) running: ` +
                   `${upstreamOnly.join(', ')} — their calls will fail while targets are down.`);
      }
    }

    return {
      createdAt: new Date().toISOString(),
      scope: scopeMode,
      targets,
      fingerprint: orderer.fingerprint(graph.edges),
      startOrder,
      stopOrder,
      names,
      notes
    };
  }

  /**
   * Human-readable plan, for the runner sheet / log. Read this before executing anything.
   * @param {Object} plan
   * @returns {string}
   */
  describePlan(plan) {
    const label = id => plan.names[id] ? `${id} ${plan.names[id]}` : id;
    const lines = [
      `RESTART PLAN  created ${plan.createdAt}`,
      `  scope=${plan.scope}  targets=[${plan.targets.join(', ')}]  fingerprint=${plan.fingerprint}`,
      `  STOP  (callers first): ${plan.stopOrder.map(label).join('  ->  ')}`,
      `  START (callees first): ${plan.startOrder.map(label).join('  ->  ')}`
    ];
    (plan.notes || []).forEach(n => lines.push(`  NOTE: ${n}`));
    return lines.join('\n');
  }

  // ----- Execution (side-effecting) ---------------------------------------

  /**
   * Phase 1: stop in reverse start order (callers first), verifying each transition.
   * Strict: halts on the first recipe that cannot be verified stopped — continuing to stop
   * callees under a still-running caller is exactly the failure mode this tool exists to prevent.
   * @param {Object} plan
   * @returns {Object} report
   */
  executeStop(plan) {
    return this._runPhase(plan, 'stop', plan.stopOrder);
  }

  /**
   * Phase 2: start in start order (callees first), verifying each transition.
   * ALWAYS halts on failure: callers are never started above a callee that is not running.
   * Start rejections surface Workato's own error text — a recipe refusing to start over an
   * invalid datapill is this system catching a broken function contract at deploy time.
   *
   * @param {Object} plan
   * @param {Object} [opts]
   * @param {string} [opts.currentFingerprint] - Orderer.fingerprint(freshGraph.edges). When provided
   *                                             and different from plan.fingerprint, the run is refused
   *                                             in strict mode: the call graph changed since planning
   *                                             (an edit added/removed a call step) — re-plan.
   * @returns {Object} report
   */
  executeStart(plan, opts = {}) {
    if (opts.currentFingerprint && opts.currentFingerprint !== plan.fingerprint) {
      const msg = `Plan is stale: corpus fingerprint ${opts.currentFingerprint} != plan ` +
                  `${plan.fingerprint}. The call graph changed since this plan was made — re-plan.`;
      if (this.options.strict) throw new ExecutionError(msg);
      this.options.log(`WARN ${msg}`);
    }
    return this._runPhase(plan, 'start', plan.startOrder);
  }

  /**
   * Pure restart convenience: stop phase then start phase off one plan.
   * Only for restarts with no edit window in between; deploys should re-plan before starting.
   * @param {Object} plan
   * @returns {{stop: Object, start: Object}}
   */
  execute(plan) {
    const stop = this.executeStop(plan);
    const start = this.executeStart(plan);
    return { stop, start };
  }

  /**
   * One-line-per-step rendering of a report for Logger / sheet cells.
   * @param {Object} report
   * @returns {string}
   */
  formatReport(report) {
    const lines = [`${report.phase.toUpperCase()} ${report.ok ? 'OK' : 'FAILED'}  ` +
                   `${report.startedAt} -> ${report.finishedAt}`];
    report.steps.forEach(s => {
      const mark = s.ok ? 'ok  ' : 'FAIL';
      const ver = (s.versionNo !== undefined && s.versionNo !== null) ? ` v${s.versionNo}` : '';
      lines.push(`  ${mark} ${s.action} ${s.id}${s.name ? ' ' + s.name : ''}${ver}` +
                 `${s.skipped ? ' [' + s.skipped + ']' : ''}` +
                 `${s.detail ? ' — ' + s.detail : ''} (${s.ms}ms)`);
    });
    return lines.join('\n');
  }

  // ----- Internal ---------------------------------------------------------

  /** @private Shared phase runner. */
  _runPhase(plan, action, order) {
    const wantRunning = (action === 'start');
    const report = {
      phase: action,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ok: true,
      steps: []
    };

    let fleet = this.client.fleetState();

    for (const id of order) {
      const t0 = Date.now();
      const name = plan.names[id] || '';
      const state = fleet.get(id);

      // Not visible in the workspace at all — manifest drift. Fatal in strict.
      if (!state) {
        const step = this._step(id, name, action, false, null,
          'recipe not found in workspace list — manifest/workspace drift', t0);
        report.steps.push(step);
        if (this.options.strict || wantRunning) {
          return this._fail(report, `Recipe ${id} not found in workspace; refusing to continue.`);
        }
        report.ok = false;
        continue;
      }

      // Already in the desired state: record and move on (idempotent re-runs).
      if (state.running === wantRunning) {
        report.steps.push(this._step(id, name, action, true,
          state.version_no, null, t0, wantRunning ? 'already_running' : 'already_stopped'));
        continue;
      }

      // Optional drain gate before stopping: let in-flight jobs finish so nothing
      // resumes later on a pre-deploy version. First-page heuristic (most recent jobs).
      if (!wantRunning && this.options.drain.enabled) {
        const drained = this._waitForDrain(id);
        if (!drained.ok) {
          const step = this._step(id, name, action, false, state.version_no,
            `${drained.active} job(s) still in flight after ${this.options.drain.timeoutMs}ms drain window`, t0);
          report.steps.push(step);
          if (this.options.strict) {
            return this._fail(report, `Drain timeout on ${id}; refusing to stop under load.`);
          }
          this.options.log(`WARN proceeding to stop ${id} with jobs in flight (non-strict).`);
        }
      }

      // Transition + verify.
      let detail = null;
      let ok = false;
      try {
        if (wantRunning) this.client.startRecipe(id);
        else this.client.stopRecipe(id);
        const verified = this._verify(id, wantRunning);
        ok = verified.ok;
        fleet = verified.fleet; // reuse the freshest sweep for subsequent iterations
        if (!ok) detail = `state did not reach running=${wantRunning} within ${this.options.verifyTimeoutMs}ms`;
      } catch (err) {
        detail = String(err && err.message ? err.message : err);
      }

      const versionNo = (fleet.get(id) || state).version_no;
      report.steps.push(this._step(id, name, action, ok, versionNo, detail, t0));

      if (!ok) {
        // Start failures always halt (never start callers above a dead callee).
        // Stop failures halt in strict mode (never stop callees under a live caller).
        if (wantRunning || this.options.strict) {
          return this._fail(report,
            `${action} failed for ${id}${detail ? ': ' + detail : ''}. Halting ${action} phase.`);
        }
        report.ok = false;
      }
    }

    report.finishedAt = new Date().toISOString();
    this.options.log(this.formatReport(report));
    return report;
  }

  /** @private Poll the fleet until `id` reaches the wanted running state, or time out. */
  _verify(id, wantRunning) {
    const deadline = Date.now() + this.options.verifyTimeoutMs;
    let fleet = this.client.fleetState();
    while (Date.now() < deadline) {
      const st = fleet.get(id);
      if (st && st.running === wantRunning) return { ok: true, fleet };
      this.client.sleep(this.options.verifyPollMs);
      fleet = this.client.fleetState();
    }
    return { ok: false, fleet };
  }

  /** @private Wait for the recipe's in-flight jobs to complete. */
  _waitForDrain(id) {
    const deadline = Date.now() + this.options.drain.timeoutMs;
    let active = this._activeJobCount(id);
    while (active > 0 && Date.now() < deadline) {
      this.options.log(`drain ${id}: ${active} job(s) in flight…`);
      this.client.sleep(this.options.drain.pollMs);
      active = this._activeJobCount(id);
    }
    return { ok: active === 0, active };
  }

  /** @private Jobs on the first page without a completed_at are treated as in flight. */
  _activeJobCount(id) {
    const res = this.client.listJobs(id);
    const items = (res && res.items) || [];
    return items.filter(j => !j.completed_at).length;
  }

  /** @private */
  _step(id, name, action, ok, versionNo, detail, t0, skipped) {
    return { id, name, action, ok, versionNo, detail: detail || null,
             skipped: skipped || null, ms: Date.now() - t0 };
  }

  /** @private Close out a failed report, log it, throw with the report attached. */
  _fail(report, message) {
    report.ok = false;
    report.finishedAt = new Date().toISOString();
    this.options.log(this.formatReport(report));
    throw new ExecutionError(message, report);
  }

  /**
   * @private Scope selection.
   * 'targets'  -> exactly the targets.
   * 'upstream' -> targets plus every transitive caller (walk edges [caller, callee] backwards).
   * Callees of targets are never included: an unchanged running callee is unaffected by the window.
   */
  static _selectScope(graph, targets, mode) {
    const scope = new Set(targets.map(String));
    if (mode === 'targets') return scope;

    const callersOf = new Map(); // calleeId -> [callerIds]
    graph.edges.forEach(([caller, callee]) => {
      if (!callersOf.has(callee)) callersOf.set(callee, []);
      callersOf.get(callee).push(caller);
    });

    const queue = [...scope];
    while (queue.length) {
      const id = queue.shift();
      (callersOf.get(id) || []).forEach(c => {
        if (!scope.has(c)) { scope.add(c); queue.push(c); }
      });
    }
    return scope;
  }

  /** @private */
  static _defaultLog(line) {
    if (typeof Logger !== 'undefined' && Logger.log) Logger.log(line);
    else if (typeof console !== 'undefined') console.log(line);
  }
}

// -------------------------------------------------------------------------------------------------------
// DEFAULT DEVELOPER API CLIENT
// -------------------------------------------------------------------------------------------------------

/**
 * Minimal Developer API client. The seam the Executor actually needs is four methods —
 * fleetState(), startRecipe(id), stopRecipe(id), listJobs(id) — plus sleep(ms), so an existing
 * Workato client lib can stand in by exposing the same surface (adapter of a few lines).
 */
class WorkatoClient {
  constructor(config = {}) {
    const props = (typeof PropertiesService !== 'undefined')
      ? PropertiesService.getScriptProperties() : null;
    this.token = config.token || (props && props.getProperty('WORKATO_API_TOKEN'));
    this.base = (config.base || (props && props.getProperty('WORKATO_API_BASE'))
      || 'https://www.workato.com').replace(/\/+$/, '');
    if (!this.token) {
      throw new ExecutionError('No API token: set WORKATO_API_TOKEN or pass config.token.');
    }
    this.minIntervalMs = config.minIntervalMs || 1100; // recipe endpoints: 60 req/min
    this._fetch = config.fetchImpl || ((url, params) => UrlFetchApp.fetch(url, params));
    this._sleep = config.sleepImpl ||
      ((ms) => { if (typeof Utilities !== 'undefined') Utilities.sleep(ms); });
    this._lastCallAt = 0;
  }

  sleep(ms) { this._sleep(ms); }

  /**
   * One paged, code-free sweep of every recipe in the workspace.
   * @returns {Map<string, {running:boolean, version_no:number, name:string,
   *                        stop_cause:?string, stopped_at:?string}>}
   */
  fleetState() {
    const fleet = new Map();
    for (let page = 1; page <= 10; page++) { // 10 pages = 1,000 recipes; raise if the estate grows
      const res = this._request('GET',
        `/api/recipes?per_page=100&page=${page}&exclude_code=true`);
      const items = (res && res.items) || [];
      items.forEach(r => fleet.set(String(r.id), {
        running: !!r.running,
        version_no: r.version_no,
        name: r.name,
        stop_cause: r.stop_cause || null,
        stopped_at: r.stopped_at || null
      }));
      if (items.length < 100) break;
    }
    return fleet;
  }

  startRecipe(id) { return this._request('PUT', `/api/recipes/${id}/start`); }
  stopRecipe(id)  { return this._request('PUT', `/api/recipes/${id}/stop`); }
  listJobs(id)    { return this._request('GET', `/api/recipes/${id}/jobs`); }

  /** @private Paced request with 429/5xx handling. */
  _request(method, path, attempt = 0) {
    const wait = this._lastCallAt + this.minIntervalMs - Date.now();
    if (wait > 0) this._sleep(wait);
    this._lastCallAt = Date.now();

    const resp = this._fetch(this.base + path, {
      method: method.toLowerCase(),
      headers: { Authorization: `Bearer ${this.token}` },
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    const body = resp.getContentText();

    if (code === 429 && attempt < 3) {
      const headers = resp.getHeaders ? resp.getHeaders() : {};
      const retryAfter = Number(headers['Retry-After'] || headers['retry-after'] || 0);
      this._sleep(Math.min((retryAfter || Math.pow(2, attempt + 1)) * 1000, 60000));
      return this._request(method, path, attempt + 1);
    }
    if (code >= 500 && attempt < 1) {
      this._sleep(2000);
      return this._request(method, path, attempt + 1);
    }
    if (code >= 300) {
      throw new ExecutionError(
        `${code} ${method} ${path}: ${String(body).slice(0, 300)}`);
    }
    try { return JSON.parse(body); }
    catch (e) { throw new ExecutionError(`Unparseable response from ${path}: ${String(body).slice(0, 120)}`); }
  }
}

// -------------------------------------------------------------------------------------------------------
// COMPOSITION EXAMPLE (runner-side; lives in WorkatoSyncApp / Watchdog, not here)
// -------------------------------------------------------------------------------------------------------
//
//   const orderer  = WorkatoOrderLib.newOrderer();
//   const graph    = orderer.buildCorpusGraph(analyzer, manifest);   // analyzer: WorkatoGraphLib, cache-primed
//   const exec     = newExecutor(newWorkatoClient());
//
//   const plan = exec.makePlan(orderer, graph, ['4211'], { scope: 'upstream', manifest });
//   Logger.log(exec.describePlan(plan));        // <- read this before anything runs
//
//   exec.executeStop(plan);
//   // ... edit Build XLSX and its callers in the builder ...
//   const graph2 = orderer.buildCorpusGraph(analyzer2, manifest);    // fresh analyzer: edges may have changed
//   const plan2  = exec.makePlan(orderer, graph2, ['4211'], { scope: 'upstream', manifest });
//   exec.executeStart(plan2, { currentFingerprint: orderer.fingerprint(graph2.edges) });
//
//   // Pure recycle (no edits), e.g. Watchdog recovering a stopped subgraph:
//   //   exec.execute(exec.makePlan(orderer, graph, stoppedIds, { scope: 'upstream', manifest }));
//
// -------------------------------------------------------------------------------------------------------

if (typeof module !== 'undefined') {
  module.exports = { Executor, WorkatoClient, ExecutionError, newExecutor, newWorkatoClient };
}
