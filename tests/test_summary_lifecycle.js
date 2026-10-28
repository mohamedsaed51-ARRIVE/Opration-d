// Run: node tests/test_summary_lifecycle.js
// Saved-summary lifecycle: build -> store -> read -> rebuild (idempotent) -> All Months merge, with classified,
// unclassified, pending and legacy (pre-`pending`) data. Uses the real Code.gs against in-memory sheets.
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('PASS -', name); } else { fail++; console.log('FAIL -', name, extra === undefined ? '' : JSON.stringify(extra)); } }

const header = ['رقم البوليصة', 'الراسل', 'المحافظة', 'المنطقة', 'فرع المنطقة', 'حالة الشحنة', 'الحالة النهائية', 'تاريخ استلام البيك أب', 'تاريخ اخر حالة'];
function mkRows(withUnknown) {
  const rows = [header]; let n = 0;
  const add = (c, st, fin, br) => { for (let i = 0; i < c; i++) { n++; rows.push(['AWB' + n, 'عميل' + (n % 5), n % 2 ? 'القاهرة' : 'الجيزة', 'منطقة' + (n % 3), br || ['مدينة نصر', 'الهرم'][n % 2], st, fin, new Date(2026, 9, 1 + (n % 15)), new Date(2026, 9, 2 + (n % 15) + (n % 3))]); } };
  add(120, 'تسليم ناجح', 'تم التسليم'); add(30, 'مرتجعات', 'تم تسليم المرتجع'); add(14, 'مرتجع مفتوح', ''); add(6, 'مرتجع معلق', '');
  add(25, 'قيد التشغيل', ''); add(8, 'مرتجعات', 'رفض الاستلام و تم دفع الشحن');
  if (withUnknown) add(37, 'حالة جديدة غريبة', '');
  const unique = n;
  for (let i = 1; i <= 10; i++) { const r = rows[i].slice(); r[8] = new Date(2026, 9, 28); rows.push(r); } // 10 duplicate AWBs
  return { rows, unique };
}
function memSheet(name, rs) { rs = rs || []; return { getName: () => name, rows: rs, getLastRow: () => rs.length, getLastColumn: () => rs.reduce((m, r) => Math.max(m, r.length), 0),
  getRange(r, c, nr, nc) { return { getValues: () => Array.from({ length: nr || 1 }, (_, i) => Array.from({ length: nc || 1 }, (_, j) => { const v = (rs[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
    setValues: vals => vals.forEach((v, i) => { const ix = r - 1 + i; while (rs.length <= ix) rs.push([]); v.forEach((x, j) => { rs[ix][c - 1 + j] = x; }); }) }; },
  deleteRow: k => { rs.splice(k - 1, 1); }, deleteRows: (k, c) => { rs.splice(k - 1, c); }, setFrozenRows() {}, hideSheet() {} }; }

function makeEnv(withUnknown) {
  const d = mkRows(withUnknown), sheets = { October: memSheet('October', d.rows) }, props = {};
  const ss = { insertSheet: n => (sheets[n] = memSheet(n)), getSheetByName: n => sheets[n] || null, getSheets: () => Object.values(sheets), getName: () => 'Q4' };
  const sb = { console: { log() {} }, Date, Math, JSON, Object, Number, String, isFinite, Array, parseInt, parseFloat, RegExp, Error, isNaN,
    Session: { getScriptTimeZone: () => 'Africa/Cairo', getActiveUser: () => ({ getEmail: () => '' }) },
    Utilities: { getUuid: () => 'u', formatDate: dt => { const p = n => String(n).padStart(2, '0'); return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()); }, computeDigest: (a, s) => Array.from(String(s)).slice(0, 8).map(c => c.charCodeAt(0) & 127), DigestAlgorithm: { MD5: 1 } },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, getAll: () => ({}), putAll() {}, remove() {}, removeAll() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
    SpreadsheetApp: { openById: () => ss, flush() {} }, Logger: { log() {} } };
  vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sb);
  return { sb, sheets, unique: d.unique, rawRows: d.rows.length - 1 };
}
const groupKeys = ['branchSummary', 'customerSummary', 'provinceSummary', 'areaSummary'];
const monthRows = (e) => (e.sheets.DASHBOARD_SUMMARY ? e.sheets.DASHBOARD_SUMMARY.rows.filter(r => r[0] === 'October').length : 0);
const sumBranch = (s, f) => s.branchSummary.reduce((a, b) => a + (b[f] || 0), 0);

for (const withUnknown of [false, true]) {
  const tag = withUnknown ? 'with unclassified' : 'fully classified';
  const e = makeEnv(withUnknown), sb = e.sb;
  const b1 = sb.buildAndSaveMonthSummary('October');
  check(`[${tag}] build succeeds`, b1.success && b1.totalRows === e.rawRows, b1);
  const snap = sb.getSavedMonthSummary_('October');
  check(`[${tag}] duplicates removed: grandTotal = unique AWB (${e.unique})`, snap.grandTotal === e.unique && snap.kpis.total === e.unique, [snap.grandTotal, snap.kpis.total]);
  check(`[${tag}] every group list in the saved summary carries numeric pending`, groupKeys.every(k => snap[k].length > 0 && snap[k].every(x => typeof x.pending === 'number')));
  const k = snap.kpis;
  check(`[${tag}] buckets reconcile to total`, k.delivered + k.returned + k.rejected + k.pending + k.unknown === k.total, k);
  check(`[${tag}] branch rows sum to the totals (shipments & pending)`, sumBranch(snap, 'shipments') === k.total && sumBranch(snap, 'pending') === k.pending);
  check(`[${tag}] unclassified = ${withUnknown ? 37 : 0}`, k.unknown === (withUnknown ? 37 : 0), k.unknown);
  const rowsAfter1 = monthRows(e);
  const b2 = sb.buildAndSaveMonthSummary('October');
  const snap2 = sb.getSavedMonthSummary_('October');
  check(`[${tag}] rebuild is idempotent: same chunk count, no duplicated rows`, b2.success && monthRows(e) === rowsAfter1 && b2.chunks === b1.chunks, [rowsAfter1, monthRows(e)]);
  check(`[${tag}] rebuild gives identical KPIs`, JSON.stringify(snap2.kpis) === JSON.stringify(k));
  const single = sb.getMonthDashboardSummary('October', {});
  const all = sb.getAllMonthsDashboardSummary({});
  check(`[${tag}] All Months (one month saved) KPIs == single month`, all.kpis.total === single.kpis.total && all.kpis.delivered === single.kpis.delivered && all.kpis.unknown === single.kpis.unknown, [all.kpis.total, single.kpis.total]);
  const same = groupKeys.every(g => single[g].every(x => { const y = all[g].find(z => z.name === x.name); return y && Math.abs(y.returnRate - x.returnRate) < 1e-9 && Math.abs(y.rejectedRate - x.rejectedRate) < 1e-9 && y.shipments === x.shipments; }));
  check(`[${tag}] group return/reject rates identical in single-month and All Months`, same);
  check(`[${tag}] fresh summary is not flagged legacy`, Array.isArray(all.legacyGroupRateMonths) && all.legacyGroupRateMonths.length === 0, all.legacyGroupRateMonths);

  // legacy snapshot: rewrite the saved summary exactly as an older build would have stored it (no pending in groups)
  const legacy = JSON.parse(JSON.stringify(snap)); groupKeys.forEach(g => legacy[g].forEach(x => { delete x.pending; }));
  delete legacy.persistent; delete legacy.snapshot;
  sb.saveMonthSummary_('October', legacy);
  check(`[${tag}] legacy rewrite replaced (not appended to) the stored rows`, monthRows(e) >= 1 && sb.getSavedMonthSummary_('October').branchSummary.every(x => x.pending === undefined));
  const allLegacy = sb.getAllMonthsDashboardSummary({});
  check(`[${tag}] legacy snapshot is flagged`, JSON.stringify(allLegacy.legacyGroupRateMonths) === '["October"]', allLegacy.legacyGroupRateMonths);
  check(`[${tag}] legacy snapshot keeps every count (nothing lost)`, allLegacy.kpis.total === k.total && allLegacy.branchSummary.reduce((a, b) => a + b.shipments, 0) === k.total);
  const drift = allLegacy.branchSummary.some(x => { const y = single.branchSummary.find(z => z.name === x.name); return Math.abs(x.returnRate - y.returnRate) > 1e-9; });
  check(`[${tag}] legacy rates ${withUnknown ? 'drift (documented approximation) until rebuilt' : 'equal (no unclassified => same denominator)'}`, drift === withUnknown, drift);
  sb.buildAndSaveMonthSummary('October');
  const allFixed = sb.getAllMonthsDashboardSummary({});
  check(`[${tag}] after «تحديث الداش بورد» rebuild: flag cleared and rates equal single month`, allFixed.legacyGroupRateMonths.length === 0 && allFixed.branchSummary.every(x => { const y = single.branchSummary.find(z => z.name === x.name); return Math.abs(x.returnRate - y.returnRate) < 1e-9; }));
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
