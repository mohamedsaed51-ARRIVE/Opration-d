// Run: node tests/test_group_rates_consistency.js
// Branch/customer/province/area return & reject rates must use the same denominator (total - pending)
// in single-month results and in the All-Months merge, even when unclassified statuses exist.
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('PASS -', name); } else { fail++; console.log('FAIL -', name, extra === undefined ? '' : JSON.stringify(extra)); } }

const header = ['رقم البوليصة', 'الراسل', 'المحافظة', 'المنطقة', 'فرع المنطقة', 'حالة الشحنة', 'الحالة النهائية', 'تاريخ استلام البيك أب', 'تاريخ اخر حالة'];
const rows = [header];
const mk = (n, status, fin) => { for (let i = 0; i < n; i++) rows.push(['W' + rows.length, 'عميل', 'القاهرة', 'مدينة نصر', 'مدينة نصر', status, fin, new Date(2026, 9, 1 + (rows.length % 5)), new Date(2026, 9, 3 + (rows.length % 5))]); };
mk(50, 'تسليم ناجح', 'تم التسليم'); mk(10, 'مرتجعات', 'تم تسليم المرتجع'); mk(10, 'قيد التشغيل', ''); mk(30, 'حالة جديدة غريبة', '');
const sheets = { October: { rows } }, store = {};
const sb = { console, Date, Math, JSON, Object, Number, String, isFinite, Array,
  Session: { getScriptTimeZone: () => 'Africa/Cairo', getActiveUser: () => ({ getEmail: () => '' }) },
  Utilities: { formatDate: (d) => { const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }, computeDigest: (a, s) => Array.from(String(s)).slice(0, 8).map(c => c.charCodeAt(0) & 127), DigestAlgorithm: { MD5: 1 } },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, getAll: () => ({}), putAll: () => {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => store[k] || null, setProperty: (k, v) => { store[k] = v; } }) },
  SpreadsheetApp: { openById: () => ({ getSheetByName: n => sheets[n] ? { getLastRow: () => sheets[n].rows.length, getLastColumn: () => header.length, getRange: () => ({ getValues: () => sheets[n].rows }) } : null }) } };
vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sb);

const live = sb.getMonthDashboardSummary('October', { refresh: '1', __buildPersistentSummary: true });
const lb = live.branchSummary[0];
check('live branch: 100 shipments, 10 pending, 30 unclassified', lb.shipments === 100 && lb.pending === 10 && live.kpis.unknown === 30, [lb.shipments, lb.pending, live.kpis.unknown]);
check('live branch returnRate = returned / (total - pending) = 10/90', Math.abs(lb.returnRate - 10 / 90 * 100) < 1e-9, lb.returnRate);

const cube = sb.summaryComputeFromCube_([live.filterCube], {}, '', '');
check('cube branch returnRate equals live', Math.abs(cube.branchSummary[0].returnRate - lb.returnRate) < 1e-9, cube.branchSummary[0].returnRate);

const merged = sb.summaryMergeGroupLists([[lb], [lb]], 100)[0];
check('All-Months merge keeps the same returnRate as one month', Math.abs(merged.returnRate - lb.returnRate) < 1e-9, merged.returnRate);
check('All-Months merge keeps the same rejectedRate', Math.abs(merged.rejectedRate - lb.rejectedRate) < 1e-9, merged.rejectedRate);

// older snapshot (no pending field): documented fallback to delivered+returned+rejected
const legacy = Object.assign({}, lb); delete legacy.pending;
const mixed = sb.summaryMergeGroupLists([[lb], [legacy]], 100)[0];
check('legacy entry without pending falls back to resolved denominator (documented approximation)', Math.abs(mixed.returnRate - 20 / 120 * 100) < 1e-9, mixed.returnRate);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
