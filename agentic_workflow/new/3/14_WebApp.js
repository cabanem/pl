/**
 * @file 14_WebApp.gs
 * @description The web-app front door (WEBAPP_PLAN §3): sidebar parity plus a URL.
 *
 *   doGet serves CorpusWebApp.html and nothing else -- the page talks to the same two globals the
 *   sidebar uses (askCorpus / getRecentQa) via google.script.run, so there is exactly one server
 *   API with two front doors. Execution identity is USER_DEPLOYING (manifest): teammates need the
 *   link and nothing else -- no Vertex rights, no OAuth consent, no digest access, no spreadsheet
 *   share. Every ask still records the visitor via Session.getActiveUser() in the audit and QA_LOG
 *   rows; verify that attribution with one ask from a second domain account on day one -- if it
 *   comes back as the deployer, history's "who" needs a fallback (decide then, not now).
 *
 *   Deployment mechanics (container-bound script):
 *     first time:   Deploy -> New deployment -> Web app (Execute as: Me, Access: Anyone in domain)
 *     every change: Deploy -> Manage deployments -> Edit -> New version  (the /exec URL stays stable)
 *   Then store the URL once via the menu (Corpus Q&A -> Open web app); it lands in ConfigStore as
 *   WEBAPP_URL, which the dashboard's quick links also read.
 */

/** Serves the Q&A page. Everything dynamic goes over google.script.run -- nothing is templated. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile("CorpusWebApp")
    .setTitle("SDC Corpus Q&A")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}
