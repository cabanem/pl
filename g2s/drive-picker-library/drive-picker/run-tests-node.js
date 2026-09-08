#!/usr/bin/env node
/**
 * Run the library's hermetic tests under Node:  node run-tests-node.js
 * Google services are replaced by proxies that throw on touch, proving the suite never reaches them.
 */
const fs = require('fs');
const path = require('path');
const src = ['Code.js', 'Tests.js'].map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n;\n');

globalThis.Logger = { log: s => console.log(s) };
for (const svc of ['UrlFetchApp', 'HtmlService', 'Utilities', 'DriveApp', 'Session', 'PropertiesService']) {
  globalThis[svc] = new Proxy({}, { get(_, p) { throw new Error(`hermetic test touched ${svc}.${String(p)}`); } });
}
new Function(src + '\n;globalThis.__runTests = runTests;')();
if (!/ 0 failed/.test(globalThis.__runTests())) process.exitCode = 1;
