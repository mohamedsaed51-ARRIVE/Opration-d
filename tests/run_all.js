'use strict';
// Runs every tests/test_*.js file in its own Node.js process, twice:
//   1. with the project root as the working directory
//   2. with the filesystem root as the working directory
// to prove no test depends on where it is launched from.
//
// Usage (from anywhere):  node tests/run_all.js
// Requirements: Node.js only (no npm install, no network, no Google access).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TESTS_DIR = __dirname;
const PROJECT_ROOT = path.resolve(TESTS_DIR, '..');
const FS_ROOT = path.parse(PROJECT_ROOT).root;

const files = fs.readdirSync(TESTS_DIR).filter((f) => /^test_.*\.js$/.test(f)).sort();
const runs = [];

for (const cwd of [PROJECT_ROOT, FS_ROOT]) {
  console.log(`\n=== Working directory: ${cwd} ===`);
  for (const f of files) {
    const res = spawnSync(process.execPath, [path.join(TESTS_DIR, f)], { cwd, encoding: 'utf8' });
    const out = (res.stdout || '') + (res.stderr || '');
    const summary = (out.match(/\[[^\]]+\] \d+ passed, \d+ failed/) || ['(no summary — crashed?)'])[0];
    const ok = res.status === 0;
    runs.push({ cwd, file: f, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${f}  ${summary}`);
    if (!ok || process.argv.includes('--verbose')) console.log(out.replace(/^/gm, '    '));
  }
}

const failed = runs.filter((r) => !r.ok);
console.log(`\n${runs.length - failed.length}/${runs.length} test-file runs passed`);
process.exit(failed.length ? 1 : 0);
