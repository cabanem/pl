/**
 * @file 11_App_Controller.js
 * @description
 *   WorkatoSyncApp — main application controller. Moved here from the former
 *   code.js. Behavior unchanged.
 *
 *   NOTE: This is now a thin compatibility layer. Every method delegates to a
 *   Runner in 10_Feature_Runners.js. The live path (menu -> 99_EntryPoints ->
 *   Commands.run) does not go through this class; only the integration test in
 *   50_Tests_Integration.js still instantiates it. Kept as-is for now.
 */

/**
 * @class
 * @classdesc Main Application Controller.
 * Orchestrates the fetching, transformation, and writing of Workato data.
 * WorkatoSyncApp ID: 1sl2ZfkgwX57EIygRwEP7nkXTK8BEXaB60cnFKsqhg2DWic3V0SVAzrYS
 */
class WorkatoSyncApp {
  constructor(ctx = null) {
    // Backwards compatible: if no ctx provided, behave exactly as before.
    const context = ctx || new AppContext();
    this.ctx = context;

    this.config = context.config;
    this.client = context.client; // stable direct fetch handle
    this.inventoryService = context.inventoryService;
    this.analyzerService = context.analyzerService;
    this.sheetService = context.sheetService;
    this.driveService = context.driveService;
  }
  /**
   * The main execution method.
   * Performs authentication check, fetches all resources, transforms data,
   * resolves dependencies, and writes to Sheets.
   */
  runInventorySync() {
    return new InventorySyncRunner().run(this.ctx);
  }
  /**
   * Reads specific IDs from the input sheet and fetches step-by-step logic.
   */
  runLogicDebug(idsOverride = null) {
    return new LogicDebugRunner().run(this.ctx, idsOverride);
  }
  /**
   * Reads IDs from 'logic_requests', fetches them, sends to Gemini, and writes output.
   */
  runAiAnalysis(idsOverride = null) {
    return new AiAnalysisRunner().run(this.ctx, idsOverride);
  }
  /**
   * Reads recipe IDs from 'logic_requests' and generates process maps using the Library.
   * @param {{ mode?: string, callDepth?: number, maxNodes?: number }} [options]
   */
  runProcessMaps(options = {}, idsOverride = null) {
    return new ProcessMapsRunner().run(this.ctx, options, idsOverride);
  }
}
