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
    deleteRow(n) { this.rows.splice(n - 1, 1); }, deleteRows(n, c) { this.rows.splice(n - 1, c); }, setFrozenRows() {} };
  return sh;
}
const rnd = (() => { let s = 11; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
const branches = ['مدينة نصر', 'الهرم', 'طنطا', 'الصعيد', 'فرع غريب', 'فرع الاسكندريه'];
const statuses = ['تسليم ناجح', 'مرتجعات', 'قيد التشغيل', 'مرتجع مفتوح', 'رفض الاستلام و تم دفع الشحن'];
const header = ['رقم البوليصة', 'فرع المنطقة', 'حالة الشحنة', 'تاريخ استلام البيك أب', 'تاريخ اخر حالة'];
const oct = [header];
for (let i = 0; i < 3000; i++) {
  const st = statuses[Math.floor(rnd() * statuses.length)], day = 1 + Math.floor(rnd() * 20);
  const open = st === 'قيد التشغيل' || st === 'مرتجع مفتوح';
  oct.push(['A' + i, branches[Math.floor(rnd() * branches.length)], st, i % 97 === 0 ? '' : new Date(2026, 9, day), open ? '' : (i % 89 === 0 ? '' : new Date(2026, 9, day + Math.floor(rnd() * 9) - (i % 200 === 0 ? 12 : 0)))]);
}
for (let i = 0; i < 40; i++) oct.push(['A' + i, 'الهرم', 'تسليم ناجح', new Date(2026, 9, 3), new Date(2026, 9, 5 + i)]); // duplicates (later last-status wins)

const sheets = { October: memSheet(oct) }, store = { AGE_SUMMARY: memSheet([]) };
const props = {};
const sb = { console, Date, Math, JSON, Object, Number, String, isFinite, Array,
  Utilities: { computeDigest: (a, s) => Array.from(String(s)).slice(0, 8).map(c => c.charCodeAt(0) & 127), DigestAlgorithm: { MD5: 1 } },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, getAll: () => ({}), putAll: () => {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
  Logger: { log() {} },
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
  check('known status classified in dashboard + age report', byName['تسليم ناجح'] && byName['تسليم ناجح'].dashboard === 'تسليم' && byName['تسليم ناجح'].age === 'تسليم ناجح');
  check('open return classified in both', byName['مرتجع مفتوح'] && byName['مرتجع مفتوح'].dashboard === 'مرتجع مفتوح' && byName['مرتجع مفتوح'].age === 'مرتجع مفتوح', byName['مرتجع مفتوح']);
  check('status-text rejection without a rejecting final status is «غير مصنف» (strict: rejection comes from the final status)', Object.values(byName).some(r => /^رفض الاستلام/.test(r.status) && r.dashboard === 'غير مصنف'));
  check('counts are per unique AWB', res.rows.reduce((a, r) => a + r.count, 0) === 3000, res.rows.reduce((a, r) => a + r.count, 0));
}

// ---- profileColumns data ----
{
  const prof = sb.profileColumnsData_([['الحالة النهائية', 'رقم', 'تاريخ'], ['مغلق', 1, new Date(2026, 9, 1)], ['مفتوح', 2, new Date(2026, 9, 2)], ['مغلق', 3, ''], ['', 4, new Date(2026, 9, 3)]]);
  check('profile: low-cardinality column lists values with counts', prof[0][4] === 'مغلق (2) | مفتوح (1)' && prof[0][2] === 3 && prof[0][3] === 2, prof[0]);
  check('profile: dates collapsed, empties not counted', prof[2][2] === 3 && prof[2][4] === '(تاريخ) (3)', prof[2]);
}

// ---- 8-card taxonomy ----
{
  const K = s => sb.summaryClassifyKind(s);
  check('kind: delivered both spellings', K('تسليم ناجح') === 'delivered' && K('التسليم ناجح') === 'delivered');
  check('kind: in progress (double-space variant too)', K('قيد التشغيل') === 'inProgress' && K('قيد  التشغيل') === 'inProgress');
  check('kind: «مرتجعات» = closed return', K('مرتجعات') === 'returnClosed');
  check('kind: closed / open / hold returns by keyword', K('مرتجع مغلق') === 'returnClosed' && K('مرتجع مفتوح') === 'returnOpen' && K('مرتجع معلق') === 'returnHold' && K('مرتجع معلّق'.replace('ّ','')) === 'returnHold');
  check('kind: an unrecognised return wording is «غير مصنف» (never guessed)', K('مرتجع بالفرع') === 'unknown' && K('شيء آخر') === 'unknown' && K('') === 'unknown');
  const eff = (st, fs) => sb.summaryEffectiveStatus_(st, fs);
  check('rejection is read from the FINAL status and takes precedence', K(eff('مرتجعات', 'رفض الاستلام و تم دفع الشحن')) === 'rejected' && K(eff('تسليم ناجح', 'رفض الاستلام')) === 'rejected');
  check('final status without «رفض» leaves the status classification untouched', eff('مرتجعات', 'تم التسليم') === 'مرتجعات' && K(eff('قيد التشغيل', '')) === 'inProgress');
  check('bucket mapping keeps legacy buckets', sb.summaryClassifyStatus('مرتجع معلق') === 'returned' && sb.summaryClassifyStatus('قيد التشغيل') === 'pending' && sb.summaryClassifyStatus(eff('x', 'رفض')) === 'rejected');
  // acc: return sub-kinds roll up into `returned`
  const acc = sb.summaryNewGroupAcc();
  ['returnClosed', 'returnClosed', 'returnOpen', 'returnHold'].forEach(k => sb.summaryAccumulateRow(acc, { bucket: 'returned', kind: k, slaDays: null, branch: 'b' }, 2));
  check('acc: returned = closed + open + hold', acc.returned === 4 && acc.returnClosed === 2 && acc.returnOpen === 1 && acc.returnHold === 1, acc);
  const accC = sb.summaryNewGroupAcc();
  sb.summaryAccumulateCubeRecord_(accC, [0,0,0,0,0,0,'',5,0,0,0,0,0,0,0], 'returned', 'returnHold');
  check('cube acc: counts the record multiplicity per sub-kind', accC.returned === 5 && accC.returnHold === 5, accC);
  const m = sb.summaryMergeTopKpis([{ total: 10, returned: 4, returnClosed: 2, returnOpen: 1, returnHold: 1 }, { total: 5, returned: 2, returnClosed: 2, returnOpen: 0, returnHold: 0 }]);
  check('merge: sub-kinds are summed', m.returnClosed === 4 && m.returnOpen === 1 && m.returnHold === 1 && m.returned === 6, m);
  const old = sb.summaryMergeTopKpis([{ total: 10, returned: 4, returnClosed: 2, returnOpen: 1, returnHold: 1 }, { total: 5, returned: 2 }]);
  check('merge: a month saved before the taxonomy leaves the split undefined (never faked)', old.returnClosed === undefined && old.returned === 6, old);
}

// ---- clearAllSummaries ----
{
  const dash = memSheet([['Month'], ['October'], ['October'], ['September']]);
  const quarterSheets = { DASHBOARD_SUMMARY: dash };
  const prevOpen = sb.SpreadsheetApp.openById;
  sb.SpreadsheetApp.openById = () => ({ getSheetByName: n => n === 'AGE_SUMMARY' ? store.AGE_SUMMARY : (quarterSheets[n] || sheets[n] || null) });
  props['SNAPSHOT_BUILD_PROGRESS_JSON'] = '{"completed":{"October":{}}}';
  // make sure AGE_SUMMARY has rows
  store.AGE_SUMMARY.created = true; store.AGE_SUMMARY.rows = [['Month'], ['October'], ['September']];
  const before = props['SNAPSHOT_GENERATION_STAMP'];
  const res = sb.clearAllSummaries();
  check('clearAllSummaries succeeds without UI (editor run)', res.success === true, res);
  check('dashboard summary rows deleted, header kept', dash.rows.length === 1 && dash.rows[0][0] === 'Month', dash.rows);
  check('age summary rows deleted, header kept', store.AGE_SUMMARY.rows.length === 1);
  check('raw month sheets untouched', sheets.October.rows.length > 3000);
  check('batch progress reset', !props['SNAPSHOT_BUILD_PROGRESS_JSON']);
  check('cache stamp bumped (cached dashboards invalidated)', props['SNAPSHOT_GENERATION_STAMP'] !== before, [before, props['SNAPSHOT_GENERATION_STAMP']]);
  sb.SpreadsheetApp.openById = prevOpen;
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
