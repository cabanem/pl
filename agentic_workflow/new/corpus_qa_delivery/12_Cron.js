/**
 * @file 12_Cron.gs
 * @description Unattended schedule. Handlers wrap existing runners with a script lock and email-on-failure.
 *              Install once via installNightlyTriggers(); idempotent.
 *
 * Ordering matters in two places:
 *  - ledger BEFORE ai: the gate reads FINGERPRINTS written the same night.
 *  - hours, not minutes, between jobs: time triggers fire within a ±15 min window of the hour, so adjacent hours are the real spacing unit.
 */
const CRON_NIGHTLY = [
  { handler: 'cron_ledger', hour: 4 },      // fingerprints + change log + ambiguity
  { handler: 'cron_inventory', hour: 5 },   // existing InventorySyncRunner
  { handler: 'cron_maps', hour: 6 },        // existing ProcessMapsRunner
  { handler: 'cron_ai', hour: 7 },          // gated AiAnalysisRunner
  { handler: 'cron_digest', hour: 9 },      // ***UPDATED*** corpus digest — after cron_ai's analyses land; hour 8 belongs to Monday's cron_docs_weekly
];

function installNightlyTriggers() {
  uninstallNightlyTriggers();
  CRON_NIGHTLY.forEach(c =>
    ScriptApp.newTrigger(c.handler).timeBased().everyDays(1).atHour(c.hour).create());
  ScriptApp.newTrigger('cron_docs_weekly')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  console.log(`Installed ${CRON_NIGHTLY.length + 1} triggers.`);
}

function uninstallNightlyTriggers() {
  const names = new Set(CRON_NIGHTLY.map(c => c.handler).concat(['cron_docs_weekly']));
  ScriptApp.getProjectTriggers().forEach(t => {
    if (names.has(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  });
}

function cron_ledger() { runGuarded_('ChangeLedger', ctx => new ChangeLedgerRunner().run(ctx)); }
function cron_inventory() { runGuarded_('InventorySync', ctx => new InventorySyncRunner().run(ctx)); }
function cron_maps() {
  runGuarded_('ProcessMaps', ctx => {
    const ids = ChangeLedgerRunner.changedRecipeIds(1);
    if (!ids.length) { ctx.logger.verbose('Maps: nothing changed since yesterday.'); return; }
    new ProcessMapsRunner().run(ctx, {}, ids);
  });
}
function cron_ai() {
  runGuarded_('AiAnalysis', ctx => {
    const cap = ctx.config.INTEGRATION.AI_MAX_PER_RUN;
    const ids = AiGate.staleIds(cap);
    if (!ids.length) { ctx.logger.verbose('AI gate: nothing is stale.'); return; }
    new AiAnalysisRunner().run(ctx, ids); // ***UPDATED*** bug fix: was run(ctx.ids) — passed undefined as ctx and dropped the gated ids
  });
}
// ***UPDATED*** nightly corpus digest — fingerprint-gated; a quiet night logs "unchanged" and writes nothing.
function cron_digest() { runGuarded_('CorpusDigest', ctx => new CorpusDigestBuilder().run(ctx)); }

function cron_docs_weekly() {
  const ids = ChangeLedgerRunner.changedRecipeIds(7);
  if (!ids.length) { console.log('Weekly docs: nothing changed this week; skipping...'); return; }
  runGuarded_('CompanionDoc', ctx => new CompanionDocRunner().run(ctx, ids));
  if (ids.length >= 2) {
    runGuarded_('SystemDoc', ctx => new SystemDocRunner().run(ctx, ids));
  }
}

/** Lock + build ctx + run + alert on failure. */
function runGuarded_(label, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    console.warn(`${label}: another run holds the lock; skipping this window.`);
    return;
  }
  try {
    fn(AppFactory.createContext());
  } catch (e) {
    console.error(`${label} failed: ${e && e.stack ? e.stack : e}`);
    const to = AppConfig.get().INTEGRATION.ALERT_EMAIL; // ***UPDATED*** removed a stray no-op '' expression left from an earlier edit
    if (to) MailApp.sendEmail(to, `[SDC docs] ${label} failed`,
      String((e && e.stack) || e));
  } finally {
    lock.releaseLock();
  }
}
