#!/usr/bin/env node
/**
 * Run the hermetic Apps Script test suite (runTests) locally under Node, no editor needed.
 *   node run-tests-node.js
 * Apps Script shares one global scope across files, so the files are concatenated. Every Google service is
 * replaced by a proxy that throws on touch, which proves the suite stays hermetic. Exit code 1 on any failure.
 */
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'gemini-2-sf');
const files = ['ContractIntake.js', 'Logging.js', 'WorkatoPush.js', 'Snapshot.js', 'WebApp.js', 'Tests.js', 'WorkatoTests.js'];
const src = files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n;\n');

globalThis.Logger = { log: s => console.log(s) };
for (const svc of ['SpreadsheetApp', 'DriveApp', 'UrlFetchApp', 'PropertiesService', 'ScriptApp', 'LockService',
                   'HtmlService', 'Utilities', 'DocumentApp', 'Drive', 'MimeType']) {
  globalThis[svc] = new Proxy({}, { get(_, p) { throw new Error(`hermetic test touched ${svc}.${String(p)}`); } });
}
new Function(src + '\n;globalThis.__runTests = runTests;')();
const summary = globalThis.__runTests();
if (!/ 0 failed/.test(summary)) process.exitCode = 1;
