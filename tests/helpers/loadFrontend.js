'use strict';
// Extracts SELECTED functions and constants from the REAL index.html (read
// fresh on every run — nothing is copied by hand) and evaluates them inside
// an isolated Node.js `vm` context.
//
// Why not load the whole page? index.html is a full browser application: its
// top-level code touches the DOM, IndexedDB, localStorage, Chart.js, jsPDF
// and calls the live Web App on boot. Running it would need a browser and a
// network. The KPI logic, however, lives in plain functions with no DOM
// access, so those functions can be lifted out verbatim and run on their own.
//
// Safety checks: each requested name must occur EXACTLY ONCE as a top-level
// declaration (otherwise the extractor refuses instead of guessing), and the
// extracted text must compile. If index.html is refactored so a name moves
// or disappears, the tests fail loudly rather than testing stale code.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX_HTML_PATH = path.resolve(__dirname, '..', '..', 'index.html');

// Scans forward from `start`, skipping strings, template literals and
// comments, and returns the index just past the end of the declaration:
//   mode 'block' — the closing brace that balances the first '{'
//   mode 'stmt'  — the first ';' at brace/paren/bracket depth 0
function scanToEnd(src, start, mode) {
  let depth = 0;
  let seenOpen = false;
  let i = start;
  const templateStack = []; // brace depth at which each open `${` began
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (ch === '/' && next === '*') { i = src.indexOf('*/', i + 2) + 2; if (i < 2) return -1; continue; }
    if (ch === '"' || ch === "'") {
      i++;
      while (i < src.length && src[i] !== ch) { if (src[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (ch === '`') {
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { templateStack.push(depth); depth++; i += 2; break; }
        i++;
      }
      if (src[i] === '`') i++;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; if (ch === '{') seenOpen = true; }
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (ch === '}' && templateStack.length && templateStack[templateStack.length - 1] === depth) {
        // end of a `${ ... }` — resume scanning the rest of the template literal
        templateStack.pop();
        i++;
        while (i < src.length && src[i] !== '`') {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '$' && src[i + 1] === '{') { templateStack.push(depth); depth++; i += 2; break; }
          i++;
        }
        if (src[i] === '`') i++;
        continue;
      }
      if (mode === 'block' && seenOpen && depth === 0) return i + 1;
    } else if (ch === ';' && mode === 'stmt' && depth === 0) return i + 1;
    i++;
  }
  return -1;
}

function findUnique(src, regex, label) {
  const matches = [...src.matchAll(regex)];
  if (matches.length !== 1) {
    throw new Error(`loadFrontend: expected exactly 1 top-level declaration of "${label}" in index.html, found ${matches.length}`);
  }
  return matches[0].index;
}

function extractFunction(src, name) {
  const start = findUnique(src, new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'gm'), name);
  const end = scanToEnd(src, start, 'block');
  if (end < 0) throw new Error(`loadFrontend: could not find the end of function ${name}`);
  return src.slice(start, end);
}

function extractDeclaration(src, name) {
  const start = findUnique(src, new RegExp(`^(?:let|const|var)\\s+${name}\\b`, 'gm'), name);
  const end = scanToEnd(src, start, 'stmt');
  if (end < 0) throw new Error(`loadFrontend: could not find the end of declaration ${name}`);
  return src.slice(start, end);
}

/**
 * @param {object} spec
 * @param {string[]} spec.declarations top-level let/const names to lift (in order)
 * @param {string[]} spec.functions    top-level function names to lift
 * @returns {object} { api, source } — api exposes every lifted name, plus
 *          setGlobal(name, value) to reassign a lifted `let` (e.g. SLA targets).
 */
function loadFrontend(spec) {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const parts = [];
  for (const d of spec.declarations || []) parts.push(extractDeclaration(html, d));
  for (const f of spec.functions || []) parts.push(extractFunction(html, f));

  const names = [...(spec.declarations || []), ...(spec.functions || [])];
  const setters = (spec.declarations || [])
    .map((d) => `if (name === ${JSON.stringify(d)}) { ${d} = value; return; }`).join('\n');
  const source =
    '(function(){\n"use strict";\n' + parts.join('\n\n') +
    `\nreturn { ${names.join(', ')}, setGlobal: function(name, value){ ${setters}\n throw new Error('not settable: ' + name); } };\n})()`;

  // Only timers are provided (yieldToUI uses setTimeout). No DOM, no fetch,
  // no require, no process — the lifted code cannot reach the network.
  const sandbox = { setTimeout, Promise, console: { log() {}, info() {}, warn() {}, error() {} } };
  vm.createContext(sandbox);
  const api = vm.runInContext(source, sandbox, { filename: INDEX_HTML_PATH + ' (extracted)' });
  return { api, source, sandbox };
}

module.exports = { loadFrontend, extractFunction, extractDeclaration, INDEX_HTML_PATH };
