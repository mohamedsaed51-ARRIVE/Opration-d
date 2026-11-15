// Run: node tests/test_summary_save_safety.js
// A month summary must never be lost when a save is interrupted: the new chunk set is written first, the old one
// deleted after, and readers take the newest complete set.
const fs = require('fs'), vm = require('vm'), path = require('path');
function fakeSheet() {
  return { rows: [], failDelete: 0, failWrite: false,
    getLastRow() { return this.rows.length; },
    getRange(r, c, n, w) { const self = this; return {
      getValues() { const out = []; for (let i = 0; i < n; i++) { const row = self.rows[r - 1 + i] || []; const v = []; for (let j = 0; j < w; j++) v.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]); out.push(v); } return out; },
      setValues(vals) { if (self.failWrite) throw new Error('Service Spreadsheets failed'); vals.forEach((v, i) => { const idx = r - 1 + i; while (self.rows.length <= idx) self.rows.push([]); v.forEach((x, j) => { self.rows[idx][c - 1 + j] = x; }); }); } }; },
    deleteRows(n, c) { if (this.failDelete-- > 0) throw new Error('Those rows are out of bounds.'); if (n - 1 + c > this.rows.length) throw new Error('Those rows are out of bounds.'); this.rows.splice(n - 1, c); },
    setFrozenRows() {} };
}
const sheets = {};
const ss = { getSheetByName(n) { return sheets[n] || null; }, insertSheet(n) { return (sheets[n] = fakeSheet()); } };
let clock = Date.parse('2026-11-15T10:00:00Z');
class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock += 1000); } }
const props = {};
const sandbox = { console: { log() {} }, Date: FakeDate, Math, JSON, Object, Number, String, isFinite, Utilities: {}, CacheService: {},
  Session: { getActiveUser() { return { getEmail() { return ''; } }; } },
  PropertiesService: { getScriptProperties() { return { getProperty(k) { return props[k] || null; }, setProperty(k, v) { props[k] = v; } }; } },
  SpreadsheetApp: { openById() { return ss; }, flush() {} } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sandbox);

let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('PASS -', name); } else { fail++; console.log('FAIL -', name, extra === undefined ? '' : JSON.stringify(extra)); } }
const big = (tag) => ({ success: true, totalRows: 5, grandTotal: 5, tag, pad: 'x'.repeat(120000) }); // several chunks
const get = (m) => sandbox.getSavedMonthSummary_(m);
const monthRows = (sh, m) => sh.rows.filter(r => r[0] === m).length;

sandbox.saveMonthSummary_('August', big('v1'));
sandbox.saveMonthSummary_('September', big('s1'));
const sh = sheets[Object.keys(sheets)[0]];
const chunks = monthRows(sh, 'August');
check('summary saved in several chunks', chunks > 1, chunks);
check('saved summary reads back', get('August').tag === 'v1' && get('September').tag === 's1');

sandbox.saveMonthSummary_('August', big('v2'));
check('re-save replaces the old set (no leftovers)', get('August').tag === 'v2' && monthRows(sh, 'August') === chunks, monthRows(sh, 'August'));
check('other month untouched', get('September').tag === 's1');

sh.failWrite = true; let threw = false;
try { sandbox.saveMonthSummary_('August', big('v3')); } catch (e) { threw = true; }
sh.failWrite = false;
check('write failure: error surfaces and the previous summary is still there', threw && get('August').tag === 'v2');

sh.failDelete = 99; // deleting the old set keeps failing (another execution / Sheets error)
sandbox.saveMonthSummary_('August', big('v4'));
sh.failDelete = 0;
check('delete failure: save still succeeds, both sets on the tab', monthRows(sh, 'August') === chunks * 2, monthRows(sh, 'August'));
check('reader takes the newest set', get('August').tag === 'v4');
sandbox.saveMonthSummary_('August', big('v5'));
check('next save cleans every older set', get('August').tag === 'v5' && monthRows(sh, 'August') === chunks, monthRows(sh, 'August'));

sh.failDelete = 1; // one transient failure -> retried
sandbox.saveMonthSummary_('September', big('s2'));
check('transient delete failure is retried', get('September').tag === 's2' && monthRows(sh, 'September') === chunks, monthRows(sh, 'September'));

// age summary uses the same write-first rule
const snap = (tag, at) => ({ generatedAt: at, tag, pad: 'y'.repeat(120000) });
sandbox.ageSaveSnapshot_('August', snap('a1', '2026-11-15T10:00:00.000Z'));
const ash = sheets[Object.keys(sheets).find(k => sheets[k] !== sh)];
const an = monthRows(ash, 'August');
ash.failWrite = true; threw = false;
try { sandbox.ageSaveSnapshot_('August', snap('a2', '2026-11-15T11:00:00.000Z')); } catch (e) { threw = true; }
ash.failWrite = false;
const readAge = () => { const parts = sandbox.summaryNewestRows_(ash.rows.filter(r => r[0] === 'August'), 2).sort((a, b) => a[3] - b[3]); return JSON.parse(parts.map(p => p[5]).join('')); };
check('age: write failure keeps the previous summary', threw && readAge().tag === 'a1' && monthRows(ash, 'August') === an);
sandbox.ageSaveSnapshot_('August', snap('a3', '2026-11-15T12:00:00.000Z'));
check('age: re-save replaces the old set', readAge().tag === 'a3' && monthRows(ash, 'August') === an, monthRows(ash, 'August'));
sandbox.ageSaveSnapshot_('August', snap('a4', '2026-11-15T12:00:00.000Z'));
check('age: same stamp saved twice does not duplicate', readAge().tag === 'a4' && monthRows(ash, 'August') === an, monthRows(ash, 'August'));

// batch loops stop before the 6-minute limit instead of starting a month they cannot finish
let built = [];
sandbox.buildAndSaveMonthSummary = (m) => { built.push(m); clock += 90000; return { success: true, month: m }; };
const all = sandbox.buildAllDashboardSummaries();
check('Update All 12: stops starting months after the budget', built.length === 3 && all.notReached.length === 9 && all.complete === false, { built, notReached: all.notReached });
built = []; sandbox.getSavedMonthSummary_ = () => null;
const miss = sandbox.buildMissingMonthSnapshots();
check('Build Missing: stops starting months after the budget', built.length === 3 && miss.notReached.length === 9 && miss.complete === false, { built, notReached: miss.notReached });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
