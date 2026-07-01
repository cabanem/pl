/**
 * @file 00_README
 * @description
 *   Workato Inventory Sync — fetches all resources from a Workato workspace,
 *   parses/packages them, and calls Gemini (Vertex) for summarization. Output
 *   lands in a dedicated Google Sheet (inventory tabs, analysis tabs, dashboard).
 *
 * @author Emily Cabaniss
 *
 * @see README   https://docs.google.com/document/d/18mk8sphXwC7bTRrDj09rnL4FNVuiBNS1oVeM3zuyUcg/edit?tab=t.0
 * @see Diagrams https://lucid.app/lucidchart/8af28952-b1ae-4eb2-a486-343a0162a587/edit
 * @see Workato developer API https://docs.workato.com/en/workato-api.html
 *
 * ---------------------------------------------------------------------------
 * PROJECT / LIBRARY SCRIPT IDS
 * ---------------------------------------------------------------------------
 *   This project (WorkatoSyncApp):
 *     1sl2ZfkgwX57EIygRwEP7nkXTK8BEXaB60cnFKsqhg2DWic3V0SVAzrYS
 *
 *   External Apps Script libraries this code binds to (referenced in
 *   03_Workato_Services.js and 06_Gemini_Service.js):
 *     WorkatoLib       — WorkatoClient  (client.get / fetchPaginated)
 *     WorkatoGraphLib  — RecipeAnalyzerService engine  ("RecipeAnalyzer" project)
 *                        1zQz8lK_00xJiyVweBiNUfhr54HqAGY0isdck0lQCYyr134Xmm7fx_ahW
 *     GeminiLib        — GeminiService client            ("GeminiService" project)
 *                        1mc_Jm9FmSo2yMzjAaVdtD7Ww95Fa2RPLQ1-4Kb5kTtEwkuSfrOBCIzKZ
 *   (If any of the above bindings aren't configured under Libraries in the
 *   Apps Script editor, the corresponding service will throw at construction.)
 *
 * ---------------------------------------------------------------------------
 * FILE MAP
 * ---------------------------------------------------------------------------
 *   00_README.js            This file. Overview, doc links, library deps.
 *   00_Core_Context.js      AppContext (DI container), AppFactory, Commands (registry/dispatch).
 *   01_Core_Config.js       SchemaDef (sheets/headers/constants), AppConfig, ConfigStore.
 *   02_Core_Logging.js      Logger (console + spreadsheet toast).
 *   03_Workato_Services.js  WorkatoClient, InventoryService, RecipeAnalyzerService.
 *   04_Google_IO.js         SheetService, DriveService.
 *   05_DataMapper.js        DataMapper (raw API objects -> 2D sheet rows).
 *   06_Gemini_Service.js    GeminiService (Vertex/Gemini summarization).
 *   09_Core_Helpers.js      AppHelpers (lookup maps, logic digest, error handling).
 *   10_Feature_Runners.js   Inventory / Logic / AI / ProcessMaps / Companion / System runners.
 *   11_App_Controller.js    WorkatoSyncApp (legacy orchestrator; delegates to runners).
 *   20_UI_Mode.js           UiMode (basic/advanced) + menu-mode handlers.
 *   21_UI_Menu.js           UserInterfaceService (menus, prompts, config display, modals).
 *   22_UI_Selection.js      SelectionUtils (extract recipe IDs from the active selection).
 *   30_DashboardService.js  DashboardService (dashboard/view tabs, visibility, protection).
 *   40_Diagnostics.js       SheetAudit + probes (auditSheets, vertexProbe, dumpAllConfig, ...).
 *   50_Tests_Integration.js Assert, TestRunner, Fixtures, Fakes -> runAllTests().
 *   51_Tests_Unit.js        SimpleTestRunner -> runUnitTests().
 *   99_EntryPoints.js       Global functions: onOpen, menu handlers, entry points.
 *
 * ---------------------------------------------------------------------------
 * FLOW AT A GLANCE
 * ---------------------------------------------------------------------------
 *   onOpen -> UserInterfaceService.createMenu -> menu item calls a global in
 *   99_EntryPoints.js -> Commands.run("name", args) -> a Runner in
 *   10_Feature_Runners.js -> services (Workato / Gemini / Sheet / Drive) +
 *   DataMapper. WorkatoSyncApp (11_) is a thin compatibility layer over the
 *   same runners and is not on the live path.
 */
