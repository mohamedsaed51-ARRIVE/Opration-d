'use strict';
// Verifies the test environment itself before any KPI test is trusted:
// the real Code.gs loads completely, loading does not depend on the current
// working directory or on /tmp, nothing can reach the network, test data is
// fictitious, and index.html functions are extracted verbatim and safely.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createSuite, assertEqual, assertTrue } = require('./helpers/harness');
const { loadBackend, CODE_GS_PATH } = require('./helpers/loadBackend');
const { loadFrontend, extractFunction, INDEX_HTML_PATH } = require('./helpers/loadFrontend');

const suite = createSuite('test_loader');
const TESTS_DIR = __dirname;

function listJsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

(async () => {
  await suite.test('L1 — Code.gs loads completely: every top-level function is defined', {
    behavior: 'Loads the full real Code.gs (not a copied fragment) into the vm context',
    expected: 'Each `function name(` declared at top level of Code.gs is a function on the context',
  }, () => {
    const src = fs.readFileSync(CODE_GS_PATH, 'utf8');
    const names = [...src.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]);
    assertTrue(names.length > 50, 'found top-level functions in Code.gs (' + names.length + ')');
    const ctx = loadBackend();
    const missing = names.filter((n) => typeof ctx[n] !== 'function');
    assertEqual(missing.length, 0, 'functions missing after load: ' + missing.join(', '));
  });

  await suite.test('L2 — Loading does not depend on the working directory', {
    behavior: 'Paths are resolved from __dirname; loader is run from the filesystem root',
    expected: 'Child process started in "/" loads Code.gs and index.html extraction successfully',
  }, () => {
    const script =
      `require(${JSON.stringify(path.join(TESTS_DIR, 'helpers', 'harness.js'))});` +
      `const b=require(${JSON.stringify(path.join(TESTS_DIR, 'helpers', 'loadBackend.js'))}).loadBackend();` +
      `const f=require(${JSON.stringify(path.join(TESTS_DIR, 'helpers', 'loadFrontend.js'))}).loadFrontend({functions:['normText']});` +
      `if(typeof b.summaryComputeKPIs!=='function'||typeof f.api.normText!=='function')process.exit(2);`;
    const res = spawnSync(process.execPath, ['-e', script], { cwd: path.parse(process.cwd()).root, encoding: 'utf8' });
    assertEqual(res.status, 0, 'child exit code (stderr: ' + (res.stderr || '').slice(0, 300) + ')');
  });

  await suite.test('L3 — No test depends on /tmp or on temporary files from earlier sessions', {
    behavior: 'Static scan of every .js file under tests/',
    expected: 'No file references the /tmp directory',
  }, () => {
    const needle = '/' + 'tmp' + '/'; // built so this file does not match itself
    const offenders = listJsFiles(TESTS_DIR).filter((f) => fs.readFileSync(f, 'utf8').includes(needle));
    assertEqual(offenders.length, 0, 'files referencing /tmp: ' + offenders.join(', '));
  });

  await suite.test('L4 — The loaded code has no route to the network', {
    behavior: 'vm context exposes no fetch/require/process; UrlFetchApp and Node network APIs throw',
    expected: 'All network entry points are absent or throw',
  }, () => {
    const ctx = loadBackend();
    assertEqual(typeof ctx.fetch, 'undefined', 'fetch inside Code.gs context');
    assertEqual(typeof ctx.require, 'undefined', 'require inside Code.gs context');
    assertEqual(typeof ctx.process, 'undefined', 'process inside Code.gs context');
    let threw = false;
    try { ctx.UrlFetchApp.fetch('https://example.invalid'); } catch (e) { threw = /NETWORK BLOCKED/.test(e.message); }
    assertTrue(threw, 'UrlFetchApp.fetch throws');
    threw = false;
    try { require('https').request('https://example.invalid'); } catch (e) { threw = /NETWORK BLOCKED/.test(e.message); }
    assertTrue(threw, 'https.request throws in the test process');
    threw = false;
    try { ctx.SpreadsheetApp.openById('any-id'); } catch (e) { threw = /FAKE SpreadsheetApp/.test(e.message); }
    assertTrue(threw, 'SpreadsheetApp is the in-memory fake');
  });

  await suite.test('L5 — Test data is fictitious; no production URLs in tests', {
    behavior: 'Static scan of fixtures and test files',
    expected: 'Every fixture AWB starts with TEST-, every name contains "تجريبي"; no Web App / Google Docs URL in tests/',
  }, () => {
    const F = require('./fixtures/fakeShipments');
    for (const row of F.julyRows()) {
      const [awb, client, province, area, branch] = row;
      if (!awb && !client) continue; // intentionally blank rows
      if (awb) assertTrue(/^TEST-\d+$/.test(awb), 'fictitious AWB ' + awb);
      for (const v of [client, province, area, branch]) assertTrue(v.includes('تجريبي') || v.includes('تجريبية'), 'fictitious name ' + v);
    }
    // Built by concatenation so this file does not match its own patterns.
    const needles = ['script.google' + '.com/macros', 'docs.google' + '.com', 'AKfy' + 'cb'];
    const offenders = listJsFiles(TESTS_DIR).filter((f) => {
      const s = fs.readFileSync(f, 'utf8');
      return needles.some((n) => s.includes(n));
    });
    assertEqual(offenders.length, 0, 'files with production URLs: ' + offenders.join(', '));
  });

  await suite.test('L6 — index.html functions are extracted verbatim and compile', {
    behavior: 'Extractor lifts the exact source text of named functions from the real index.html',
    expected: 'Extracted text appears byte-for-byte in index.html and the lifted functions are callable',
  }, () => {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    for (const name of ['computeKPIs', 'classifyStatus', 'dedupeForKPI', 'buildRowsAndDQFromHeaderedData', 'classifyAttempt']) {
      const text = extractFunction(html, name);
      assertTrue(html.includes(text), name + ' extracted verbatim');
      assertTrue(text.trimEnd().endsWith('}'), name + ' extraction ends at its closing brace');
    }
    const { api } = loadFrontend({ declarations: ['STATUS_MAP'], functions: ['normText', 'classifyStatus'] });
    assertEqual(api.classifyStatus('تسليم ناجح'), 'delivered', 'lifted classifyStatus runs');
  });

  await suite.test('L7 — Extractor refuses missing names instead of guessing', {
    behavior: 'A name that does not exist in index.html', expected: 'Throws "expected exactly 1"',
  }, () => {
    let msg = '';
    try { loadFrontend({ functions: ['thisFunctionDoesNotExist_'] }); } catch (e) { msg = e.message; }
    assertTrue(/expected exactly 1/.test(msg), 'error message: ' + msg);
  });

  suite.finish();
})();
