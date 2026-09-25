'use strict';
// Loads the REAL, complete Code.gs from the project root into an isolated
// Node.js `vm` context — nothing is copied or re-typed by hand. The path is
// resolved from this file's own location (__dirname), so it works no matter
// which directory the tests are launched from.
//
// Every Google Apps Script service Code.gs touches is replaced by a small
// in-memory fake. None of them can reach Google or the network:
//   SpreadsheetApp   — reads/writes plain JS arrays supplied by the test
//   CacheService     — in-memory Map
//   PropertiesService— in-memory object
//   LockService      — no-op lock
//   Utilities        — local MD5 (node:crypto) + Intl date formatting
//   UrlFetchApp      — throws if ever called
// The vm context also gets no `require`, `process` or `fetch`, so the loaded
// code has no path to the file system or the network.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CODE_GS_PATH = path.join(PROJECT_ROOT, 'Code.gs');

// ------------------------------------------------------------------
// Fake SpreadsheetApp — backed by { spreadsheetId: { sheetName: [][] } }
// ------------------------------------------------------------------
function makeFakeSheet(name, grid) {
  const sheet = {
    __grid: grid,
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    getRange: (row, col, numRows, numCols) => {
      numRows = numRows || 1;
      numCols = numCols || 1;
      return {
        getValues: () => {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const src = grid[row - 1 + r] || [];
            const line = [];
            for (let c = 0; c < numCols; c++) {
              const v = src[col - 1 + c];
              line.push(v === undefined ? '' : v);
            }
            out.push(line);
          }
          return out;
        },
        setValues: (values) => {
          for (let r = 0; r < values.length; r++) {
            const target = row - 1 + r;
            while (grid.length <= target) grid.push([]);
            for (let c = 0; c < values[r].length; c++) grid[target][col - 1 + c] = values[r][c];
          }
        },
      };
    },
    deleteRow: (rowIndex) => { grid.splice(rowIndex - 1, 1); },
    setFrozenRows: () => {},
  };
  return sheet;
}

function makeFakeSpreadsheetApp(workbooks) {
  const books = {};
  for (const id of Object.keys(workbooks || {})) {
    const sheets = {};
    for (const name of Object.keys(workbooks[id])) {
      sheets[name] = makeFakeSheet(name, workbooks[id][name]);
    }
    books[id] = {
      getId: () => id,
      getSheetByName: (n) => sheets[n] || null,
      getSheets: () => Object.values(sheets),
      insertSheet: (n) => { sheets[n] = makeFakeSheet(n, []); return sheets[n]; },
      __sheets: sheets,
    };
  }
  return {
    __books: books,
    openById: (id) => {
      if (!books[id]) throw new Error('FAKE SpreadsheetApp: no test workbook for id ' + id);
      return books[id];
    },
    flush: () => {},
    getActiveSpreadsheet: () => { throw new Error('FAKE SpreadsheetApp: no active spreadsheet in tests'); },
    getUi: () => { throw new Error('FAKE SpreadsheetApp: no UI in tests'); },
  };
}

// ------------------------------------------------------------------
// Other fake services
// ------------------------------------------------------------------
function makeFakeCacheService() {
  const store = new Map();
  const cache = {
    get: (k) => (store.has(k) ? store.get(k) : null),
    getAll: (keys) => { const o = {}; keys.forEach((k) => { if (store.has(k)) o[k] = store.get(k); }); return o; },
    put: (k, v) => { store.set(k, v); },
    putAll: (obj) => { Object.keys(obj).forEach((k) => store.set(k, obj[k])); },
    remove: (k) => { store.delete(k); },
    removeAll: (keys) => { keys.forEach((k) => store.delete(k)); },
  };
  return { __store: store, getScriptCache: () => cache };
}

function makeFakePropertiesService(initial) {
  const props = Object.assign({}, initial || {});
  const api = {
    getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
    setProperty: (k, v) => { props[k] = String(v); return api; },
    deleteProperty: (k) => { delete props[k]; return api; },
    getProperties: () => Object.assign({}, props),
  };
  return { __props: props, getScriptProperties: () => api };
}

function formatDateInTz(d, tz, pattern) {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  // Quoted segments ('T') are literals, as in Apps Script / SimpleDateFormat.
  return pattern.split(/('[^']*')/).map((seg) => {
    if (seg.startsWith("'")) return seg.slice(1, -1);
    return seg
      .replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
      .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
  }).join('');
}

function makeFakeUtilities() {
  let uuid = 0;
  return {
    DigestAlgorithm: { MD5: 'md5' },
    computeDigest: (alg, s) => Array.from(crypto.createHash(alg).update(String(s), 'utf8').digest())
      .map((b) => (b > 127 ? b - 256 : b)), // Apps Script returns signed bytes
    formatDate: (d, tz, pattern) => formatDateInTz(d, tz, pattern),
    getUuid: () => 'test-uuid-' + (++uuid),
  };
}

// ------------------------------------------------------------------
// Loader
// ------------------------------------------------------------------
/**
 * @param {object} [opts]
 * @param {object} [opts.workbooks]  { spreadsheetId: { sheetName: [][] } } fake sheet data
 * @param {object} [opts.properties] initial Script Properties
 * @param {boolean} [opts.verbose]   print Code.gs console.log/Logger.log output
 * @returns {object} the vm context — every top-level function/var of Code.gs
 *                   is a property on it (e.g. ctx.summaryComputeKPIs).
 */
function loadBackend(opts) {
  opts = opts || {};
  const source = fs.readFileSync(CODE_GS_PATH, 'utf8');
  const logs = [];
  const log = (...args) => { logs.push(args.join(' ')); if (opts.verbose) console.log('[Code.gs]', ...args); };

  const sandbox = {
    console: { log, info: log, warn: log, error: log },
    Logger: { log },
    SpreadsheetApp: makeFakeSpreadsheetApp(opts.workbooks),
    CacheService: makeFakeCacheService(),
    PropertiesService: makeFakePropertiesService(opts.properties),
    LockService: { getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {} }) },
    Session: { getScriptTimeZone: () => 'Africa/Cairo', getActiveUser: () => ({ getEmail: () => '' }) },
    Utilities: makeFakeUtilities(),
    ContentService: {
      MimeType: { TEXT: 'text/plain', JSON: 'application/json' },
      createTextOutput: (s) => ({ __text: s, setMimeType() { return this; }, getContent() { return s; } }),
    },
    UrlFetchApp: { fetch: () => { throw new Error('NETWORK BLOCKED IN TESTS: UrlFetchApp.fetch'); } },
    __logs: logs,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: CODE_GS_PATH });

  // Test workbooks may be keyed by quarter ("Q3") instead of a spreadsheet
  // id, so no test file ever has to repeat the real ids. They are resolved
  // here from Code.gs's own SPREADSHEET_IDS — used only as in-memory map
  // keys for the fake, never opened on Google.
  if (opts.workbooks) {
    const byId = {};
    for (const key of Object.keys(opts.workbooks)) {
      const id = /^Q[1-4]$/.test(key) ? sandbox.SPREADSHEET_IDS[key] : key;
      byId[id] = opts.workbooks[key];
    }
    sandbox.SpreadsheetApp = makeFakeSpreadsheetApp(byId);
  }
  return sandbox;
}

module.exports = { loadBackend, CODE_GS_PATH, PROJECT_ROOT };
