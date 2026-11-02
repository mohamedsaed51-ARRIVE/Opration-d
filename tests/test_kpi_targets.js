// Run: node tests/test_kpi_targets.js — branch targets (get / save) for the KPI dashboard.
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('PASS -', name); } else { fail++; console.log('FAIL -', name, extra === undefined ? '' : JSON.stringify(extra)); } }
const store = {};
const sb = { console, Date, Math, JSON, Object, Number, String, isFinite, Array,
  Session: { getScriptTimeZone: () => 'Africa/Cairo', getActiveUser: () => ({ getEmail: () => '' }) },
  Utilities: { getUuid: () => 'u', computeDigest: () => [], DigestAlgorithm: { MD5: 1 } },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => store[k] || null, setProperty: (k, v) => { store[k] = v; } }) } };
vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sb);

const empty = sb.getKpiTargetsPayload();
check('empty by default', empty.success && JSON.stringify(empty.targets) === '{"delivery":{},"firstAttempt":{}}', empty);
const saved = sb.saveKpiTargetsPayload({ targets: JSON.stringify({
  delivery: { 'فرع طنطا': 92, 'فرع الهرم': '88.5', 'فرع X': 120, 'فرع Y': -1, 'فرع Z': '', 'فرع W': 'abc' },
  firstAttempt: { 'فرع طنطا': 45 }, other: { a: 1 } }) });
check('valid numbers are kept (strings parsed)', saved.success && saved.targets.delivery['فرع طنطا'] === 92 && saved.targets.delivery['فرع الهرم'] === 88.5, saved);
check('out-of-range / empty / non-numeric targets are dropped', Object.keys(saved.targets.delivery).length === 2, saved.targets.delivery);
check('unknown KPI keys are ignored', saved.targets.other === undefined && saved.targets.firstAttempt['فرع طنطا'] === 45, saved.targets);
const again = sb.getKpiTargetsPayload();
check('what was saved is what is read back', again.targets.delivery['فرع الهرم'] === 88.5 && again.targets.firstAttempt['فرع طنطا'] === 45, again);
const bad = sb.saveKpiTargetsPayload({ targets: '{not json' });
check('invalid JSON is rejected without touching the stored targets', bad.success === false && sb.getKpiTargetsPayload().targets.delivery['فرع الهرم'] === 88.5, bad);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
