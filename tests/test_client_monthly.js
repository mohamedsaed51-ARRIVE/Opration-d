// Run: node tests/test_client_monthly.js — per-customer monthly counts (delivered / rejected-with-shipping-paid) from saved cubes.
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('PASS -', name); } else { fail++; console.log('FAIL -', name, extra === undefined ? '' : JSON.stringify(extra)); } }

const header = ['رقم البوليصة', 'الراسل', 'المحافظة', 'المنطقة', 'فرع المنطقة', 'حالة الشحنة', 'الحالة النهائية', 'تاريخ استلام البيك أب', 'تاريخ اخر حالة'];
const PAID = 'رفض الاستلام و تم دفع الشحن', NOPAY = 'رفض الاستلام و رفض والدفع';
function build(spec) { // spec: [client, status, final, n]
  const rows = [header];
  spec.forEach(([client, status, fin, n, branch, gap]) => { for (let i = 0; i < n; i++) rows.push(['W' + rows.length + client, client, 'القاهرة', 'مدينة نصر', branch || 'مدينة نصر', status, fin, new Date(2026, 9, 1 + (rows.length % 5)), new Date(2026, 9, 1 + (rows.length % 5) + (gap === undefined ? 2 : gap))]); });
  return rows;
}
const store = {};
const sb = { console, Date, Math, JSON, Object, Number, String, isFinite, Array,
  Session: { getScriptTimeZone: () => 'Africa/Cairo', getActiveUser: () => ({ getEmail: () => '' }) },
  Utilities: { formatDate: (d) => { const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }, computeDigest: (a, s) => Array.from(String(s)).slice(0, 8).map(c => c.charCodeAt(0) & 127), DigestAlgorithm: { MD5: 1 }, getUuid: () => 'u' },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, getAll: () => ({}), putAll: () => {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => store[k] || null, setProperty: (k, v) => { store[k] = v; } }) } };
let currentRows = null;
sb.SpreadsheetApp = { openById: () => ({ getSheetByName: () => ({ getLastRow: () => currentRows.length, getLastColumn: () => header.length, getRange: () => ({ getValues: () => currentRows }) }) }) };
vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sb);

const months = {
  August:    [['A', 'تسليم ناجح', 'تم التسليم', 5, 'الإسكندرية'], ['A', 'تسليم ناجح', 'تم التسليم', 3, undefined, 1], ['A', 'مرتجعات', PAID, 1], ['A', 'مرتجعات', NOPAY, 1], ['B', 'تسليم ناجح', 'تم التسليم', 5]],
  September: [['A', 'تسليم ناجح', 'تم التسليم', 9], ['A', 'قيد التشغيل', '', 1], ['C', 'تسليم ناجح', 'تم التسليم', 3]],
};
const snaps = {};
Object.keys(months).forEach(m => { currentRows = build(months[m]); snaps[m] = sb.getMonthDashboardSummary(m, { refresh: '1', __buildPersistentSummary: true }); });
sb.getSavedMonthSummary_ = (m) => snaps[m] || null;

const r = sb.getClientMonthlyPayload({});
check('success', r.success === true, r);
check('only months with snapshots are returned, in calendar order', JSON.stringify(r.months) === '["August","September"]', r.months);
check('other months reported as missing', r.missingMonths.length === 10 && r.missingMonths.indexOf('October') >= 0, r.missingMonths);
const byName = {}; r.clients.forEach(c => byName[c.n] = c.v);
check('client A August: total 10, delivered 8, paid 1 (refused-and-not-paid is NOT counted)', JSON.stringify(byName.A.August) === '[10,8,1,3]', byName.A.August);
check('client A September: total 10, delivered 9, paid 0, in-progress only in total', JSON.stringify(byName.A.September) === '[10,9,0,0]', byName.A.September);
check('client B only in August', byName.B.August[0] === 5 && !byName.B.September, byName.B);
check('client C only in September', byName.C.September[0] === 3 && !byName.C.August, byName.C);
const cls = {}; r.statusClassification.forEach(s => cls[s.status.replace('رفض (الحالة النهائية): ', '')] = s.cls);
check('status diagnostics classify paid vs not-paid rejection', cls[PAID] === 'paid' && cls[NOPAY] === 'rejectedOther', cls);
check('first attempt = delivered with a gap <= 1 day (3 of client A\'s 8 delivered in August)', byName.A.August[3] === 3, byName.A.August);
check('branches are NOT returned unless asked', r.branches === undefined && r.clients[0].b === undefined);
const rb = sb.getClientMonthlyPayload({ withBranches: '1' });
const bn = rb.branches, byB = {}; rb.clients.forEach(c => byB[c.n] = c);
check('branch list returned', JSON.stringify(bn.slice().sort()) === JSON.stringify(['الإسكندرية', 'مدينة نصر']), bn);
const aAug = byB.A.b; const cell = (name, month) => { const i = bn.indexOf(name); return aAug[i] && aAug[i][month]; };
check('client A August split by branch: Alexandria 5 delivered', JSON.stringify(cell('الإسكندرية', 'August')) === '[5,5,0,0]', aAug);
check('client A August other branch: 3 delivered + 1 paid + 1 not-paid-rejection (5 shipments)', JSON.stringify(cell('مدينة نصر', 'August')) === '[5,3,1,3]', aAug);
let sumOk = true; rb.clients.forEach(c => { Object.keys(c.v).forEach(m => { const t = Object.keys(c.b).reduce((s, i) => s + (c.b[i][m] ? c.b[i][m][0] : 0), 0); if (t !== c.v[m][0]) sumOk = false; }); });
check('branch totals add up to the client totals for every month', sumOk);
const only = sb.getClientMonthlyPayload({ months: 'September' });
check('months param restricts the result', JSON.stringify(only.months) === '["September"]', only.months);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
