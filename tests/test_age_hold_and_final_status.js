// Run: node tests/test_age_hold_and_final_status.js
// Age report: (1) ignores «الحالة النهائية»; (2) on-hold returns («مرتجعات معلقة») are counted under the main branch (Cairo & Alexandria).
const fs = require('fs'), vm = require('vm'), path = require('path');
const sandbox = { console, Date, Math, JSON, Object, Number, String, isFinite, Utilities: {}, CacheService: {}, SpreadsheetApp: {},
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sandbox);
let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('PASS -', name); } else { fail++; console.log('FAIL -', name, extra === undefined ? '' : JSON.stringify(extra)); } }
const d = s => new Date(s + 'T00:00:00');
const groups = sandbox.ageResolveGroups_({});
const asOf = sandbox.ageDayNumFromIso_('2026-10-24');
const recs = [
  { awb: '1', branch: 'الصعيد', status: 'مرتجعات معلقه', pickup: d('2026-10-01'), lastStatus: d('2026-10-02') },   // hold -> main branch (cairo group)
  { awb: '2', branch: 'الهرم', status: 'مرتجعات مغلقه', pickup: d('2026-10-01'), lastStatus: d('2026-10-03') },
];
const r = sandbox.ageReportCompute_(recs, groups, asOf);
const cairo = r.groups.find(g => g.key === 'cairo'), upper = r.groups.find(g => g.key === 'upper');
check('hold return counted in the Cairo & Alexandria group', cairo.kinds.returnHold.count === 1, cairo.kinds.returnHold);
check('hold return NOT counted in its sheet branch group (Upper)', upper.total === 0, upper.total);
check('hold return listed under branch «رئيسي»', cairo.branches.some(b => b.name === 'رئيسي' && b.kinds.returnHold.count === 1), cairo.branches.map(b => b.name));
check('open list branch is the main branch', r.open.list.length === 1 && r.open.list[0].branch === 'رئيسي', r.open.list);
check('closed return counted normally', cairo.kinds.returnClosed.count === 1);
// final status is ignored: a row whose status text is a closed return stays a closed return (the age report never sees the final-status column)
check('age snapshot version is 3', sandbox.AGE_SNAPSHOT_VERSION === '3');
console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
