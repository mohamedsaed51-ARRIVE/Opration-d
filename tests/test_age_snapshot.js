// Run: node tests/test_age_snapshot.js — snapshot (AGE_SUMMARY) results must equal the live raw-sheet results.
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('PASS -', name); } else { fail++; console.log('FAIL -', name, extra === undefined ? '' : JSON.stringify(extra)); } }

function memSheet(rows) {
  const sh = { rows: rows || [],
    getLastRow() { return this.rows.length; }, getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); },
    getRange(r, c, nr, nc) { const self = this; return {
      getValues() { const out = []; for (let i = 0; i < (nr || 1); i++) { const row = self.rows[r - 1 + i] || []; out.push(Array.from({ length: nc || 1 }, (_, j) => row[c - 1 + j] === undefined ? '' : row[c - 1 + j])); } return out; },
      setValues(vals) { vals.forEach((v, i) => { const idx = r - 1 + i; while (self.rows.length <= idx) self.rows.push([]); v.forEach((x, j) => { self.rows[idx][c - 1 + j] = x; }); }); } }; },
    deleteRow(n) { this.rows.splice(n - 1, 1); }, setFrozenRows() {} };
  return sh;
}
const rnd = (() => { let s = 11; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
const branches = ['مدينة نصر', 'الهرم', 'طنطا', 'الصعيد', 'فرع غريب', 'فرع الاسكندريه'];
const statuses = ['تسليم ناجح', 'مرتجعات', 'قيد التشغيل', 'مرتجع بالفرع', 'رفض الاستلام و تم دفع الشحن'];
const header = ['رقم البوليصة', 'فرع المنطقة', 'حالة الشحنة', 'تاريخ استلام البيك أب', 'تاريخ اخر حالة'];
const oct = [header];
for (let i = 0; i < 3000; i++) {
  const st = statuses[Math.floor(rnd() * statuses.length)], day = 1 + Math.floor(rnd() * 20);
  const open = st === 'قيد التشغيل' || st === 'مرتجع بالفرع';
  oct.push(['A' + i, branches[Math.floor(rnd() * branches.length)], st, i % 97 === 0 ? '' : new Date(2026, 9, day), open ? '' : (i % 89 === 0 ? '' : new Date(2026, 9, day + Math.floor(rnd() * 9) - (i % 200 === 0 ? 12 : 0)))]);
}
for (let i = 0; i < 40; i++) oct.push(['A' + i, 'الهرم', 'تسليم ناجح', new Date(2026, 9, 3), new Date(2026, 9, 5 + i)]); // duplicates (later last-status wins)

const sheets = { October: memSheet(oct) }, store = { AGE_SUMMARY: memSheet([]) };
const props = {};
const sb = { console, Date, Math, JSON, Object, Number, String, isFinite, Array,
  Utilities: { computeDigest: (a, s) => Array.from(String(s)).slice(0, 8).map(c => c.charCodeAt(0) & 127), DigestAlgorithm: { MD5: 1 } },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, getAll: () => ({}), putAll: () => {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  Session: { getActiveUser: () => ({ getEmail: () => '' }) },
  SpreadsheetApp: { flush() {}, openById: () => ({
    getSheetByName: n => n === 'AGE_SUMMARY' ? (store.AGE_SUMMARY.created ? store.AGE_SUMMARY : null) : (sheets[n] || null),
    insertSheet: n => { store.AGE_SUMMARY.created = true; return store.AGE_SUMMARY; } }) } };
vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sb);

const live = sb.getAgeReport({ sheets: 'October', asOf: '2026-10-28', live: '1' });
check('live report works', live.success && live.sources[0].source === 'live', live.error);
const none = sb.getAgeReport({ sheets: 'October', asOf: '2026-10-28' });
check('no snapshot yet -> falls back to live', none.success && none.sources[0].source === 'live');

const built = sb.buildAgeSnapshot('October');
check('snapshot built', built.success && built.chunks >= 1 && built.openShipments > 0, built);
check('snapshot stored in AGE_SUMMARY tab', store.AGE_SUMMARY.rows.length === built.chunks + 1 && store.AGE_SUMMARY.rows[0][0] === 'Month');

const snap = sb.getAgeReport({ sheets: 'October', asOf: '2026-10-28' });
check('report now reads the snapshot', snap.success && snap.sources[0].source === 'snapshot', snap.sources);
const strip = o => JSON.stringify({ k: o.kpis, g: o.groups.map(x => [x.key, x.total, x.kinds, x.dist, x.branches.map(b => [b.name, b.total, b.kinds])]), u: o.unassigned && o.unassigned.total, op: [o.open.byGroup, o.open.topBranches], dq: o.dq && { i: o.dq.invalidPickup, c: o.dq.closedWithoutEndDate, n: o.dq.negativeAge, m: o.dq.missingBranch, u: o.dq.unmappedBranches }, sb: o.statusBreakdown });
check('snapshot KPIs / groups / branches / open == live', strip(snap) === strip(live));
check('snapshot period range == live range', snap.params.dateFrom === live.params.dateFrom && snap.params.dateTo === live.params.dateTo, [snap.params, live.params]);
check('duplicates removed counted', snap.dq.duplicatesRemoved === live.dq.duplicatesRemoved && snap.dq.duplicatesRemoved === 40, snap.dq.duplicatesRemoved);
const later = sb.getAgeReport({ sheets: 'October', asOf: '2026-11-10' });
check('measurement date change recomputes open ages from the snapshot', later.sources[0].source === 'snapshot' && later.kpis.avgOpenAge > snap.kpis.avgOpenAge, [later.kpis.avgOpenAge, snap.kpis.avgOpenAge]);
const bounded = sb.getAgeReport({ sheets: 'October', asOf: '2026-10-28', dateFrom: '2026-10-01', dateTo: '2026-10-05' });
check('date filter bypasses snapshot (needs raw rows)', bounded.success && bounded.sources[0].source === 'live');
const re = sb.buildAgeSnapshot('October');
check('rebuild replaces rows (no duplicate chunks)', re.success && store.AGE_SUMMARY.rows.length === re.chunks + 1, store.AGE_SUMMARY.rows.length);
check('unknown month rejected', sb.buildAgeSnapshot('Foo').success === false);

// ---- the existing dashboard update (buildAndSaveMonthSummary) also refreshes the age summary ----
store.AGE_SUMMARY.rows.length = 1; // keep header only
sb.getMonthDashboardSummary = () => ({ success: true, totalRows: 10, grandTotal: 10 });
sb.saveMonthSummary_ = () => ({ chunks: 1 });
sb.getPersistedSlaSettings_ = () => ({ slaTargetDefault: 2, branchSlaTargets: {} });
const upd = sb.buildAndSaveMonthSummary('October');
check('main update succeeds and reports the age summary', upd.success && upd.ageSnapshot && upd.ageSnapshot.success, upd.ageSnapshot);
check('main update refreshed AGE_SUMMARY rows', store.AGE_SUMMARY.rows.length > 1);
sb.getMonthDashboardSummary = () => ({ success: true, empty: true, noData: true });
const emp = sb.buildAndSaveMonthSummary('October');
check('empty month skips the age summary without failing', emp.success && emp.ageSnapshot.skipped === 'empty-month');
sb.ageGetSnapshot_ = () => { throw new Error('boom'); };
sb.buildAgeSnapshot = () => { throw new Error('age failed'); };
sb.getMonthDashboardSummary = () => ({ success: true, totalRows: 10, grandTotal: 10 });
const bad = sb.buildAndSaveMonthSummary('October');
check('age summary failure never fails the main update', bad.success && bad.ageSnapshot.success === false && /age failed/.test(bad.ageSnapshot.error), bad.ageSnapshot);

// ---- listStatusNames: distinct status names with counts and classification ----
{
  const res = sb.collectStatusNames_({ getSheetByName: n => sheets[n] || null }, ['September', 'October']);
  const byName = Object.fromEntries(res.rows.map(r => [r.status, r]));
  check('status names collected for the month that has data', res.monthsRead.join() === 'October');
  check('known status classified in dashboard + age report', byName['تسليم ناجح'] && byName['تسليم ناجح'].dashboard === 'تم التسليم' && byName['تسليم ناجح'].age === 'تسليم ناجح');
  check('unknown status flagged as «غير مصنف» yet classified for the age report', byName['مرتجع بالفرع'] && byName['مرتجع بالفرع'].dashboard === 'غير مصنف' && byName['مرتجع بالفرع'].age === 'مرتجع مفتوح', byName['مرتجع بالفرع']);
  check('counts are per unique AWB', res.rows.reduce((a, r) => a + r.count, 0) === 3000, res.rows.reduce((a, r) => a + r.count, 0));
}

// ---- profileColumns data ----
{
  const prof = sb.profileColumnsData_([['الحالة النهائية', 'رقم', 'تاريخ'], ['مغلق', 1, new Date(2026, 9, 1)], ['مفتوح', 2, new Date(2026, 9, 2)], ['مغلق', 3, ''], ['', 4, new Date(2026, 9, 3)]]);
  check('profile: low-cardinality column lists values with counts', prof[0][4] === 'مغلق (2) | مفتوح (1)' && prof[0][2] === 3 && prof[0][3] === 2, prof[0]);
  check('profile: dates collapsed, empties not counted', prof[2][2] === 3 && prof[2][4] === '(تاريخ) (3)', prof[2]);
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
