'use strict';
// Minimal dependency-free test harness (Node.js only, no npm packages).
//
// Every test records three pieces of metadata alongside its result:
//   behavior      — what the test exercises.
//   expected      — the result the CURRENT code is expected to produce.
//   needsApproval — true when the asserted behavior is only a baseline of
//                   the current code and has NOT been confirmed as an
//                   approved business rule. A passing test with
//                   needsApproval=true means "the code still behaves as it
//                   did", never "the behavior is correct".

// ------------------------------------------------------------------
// Network guard — installed as soon as any test file loads this harness.
// Tests must never reach the network (no Web App, no Google APIs). Any
// attempt throws immediately instead of silently connecting.
// ------------------------------------------------------------------
function blockNetwork() {
  const blocked = (name) => function () {
    throw new Error('NETWORK BLOCKED IN TESTS: ' + name + ' was called');
  };
  const net = require('net');
  const http = require('http');
  const https = require('https');
  net.connect = blocked('net.connect');
  net.createConnection = blocked('net.createConnection');
  net.Socket.prototype.connect = blocked('net.Socket.connect');
  http.request = blocked('http.request');
  http.get = blocked('http.get');
  https.request = blocked('https.request');
  https.get = blocked('https.get');
  globalThis.fetch = blocked('fetch');
}
blockNetwork();

// All date-based fixtures are written in Cairo local time — the same
// timezone Code.gs falls back to ("Africa/Cairo"). Fixing TZ here makes
// results identical on any machine, regardless of its own timezone.
process.env.TZ = 'Africa/Cairo';

function createSuite(suiteName) {
  const results = [];

  async function test(name, meta, fn) {
    const entry = {
      name,
      behavior: meta.behavior,
      expected: meta.expected,
      needsApproval: !!meta.needsApproval,
      ok: false,
      error: null,
    };
    try {
      await fn();
      entry.ok = true;
    } catch (e) {
      entry.error = e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : String(e);
    }
    results.push(entry);
    const tag = entry.ok ? 'PASS' : 'FAIL';
    const approval = entry.needsApproval ? ' [baseline — needs business-rule approval]' : '';
    console.log(`${tag} - ${name}${approval}`);
    if (!entry.ok) console.log('       ' + entry.error.replace(/\n/g, '\n       '));
  }

  function finish() {
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n[${suiteName}] ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
    return { passed, failed, results };
  }

  return { test, finish };
}

// ------------------------------------------------------------------
// Assertions
// ------------------------------------------------------------------
function fmt(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'value'}: expected ${fmt(expected)}, got ${fmt(actual)}`);
  }
}
function assertClose(actual, expected, label, eps) {
  eps = eps === undefined ? 1e-9 : eps;
  if (typeof actual !== 'number' || Math.abs(actual - expected) > eps) {
    throw new Error(`${label || 'value'}: expected ≈${expected}, got ${fmt(actual)}`);
  }
}
function assertTrue(cond, label) {
  if (!cond) throw new Error(`${label || 'condition'} was false`);
}
function assertDeepEqual(actual, expected, label) {
  const a = fmt(actual), b = fmt(expected);
  if (a !== b) throw new Error(`${label || 'value'}: expected ${b}, got ${a}`);
}

module.exports = { createSuite, assertEqual, assertClose, assertTrue, assertDeepEqual };
