// Run: node tests/test_age_report.js   (loads Code.gs in a sandbox; no Google services needed)
const fs = require('fs'), vm = require('vm'), path = require('path');
const sandbox = { console, Date, Math, JSON, Object, Number, String, isFinite, Utilities: {}, CacheService: {}, SpreadsheetApp: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sandbox);

let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('PASS -', name); } else { fail++; console.log('FAIL -', name, extra === undefined ? '' : JSON.stringify(extra)); } }

const d = (s) => new Date(s + 'T00:00:00');
const groups = sandbox.ageResolveGroups_({});
const asOf = sandbox.ageDayNumFromIso_('2026-10-24');
let n = 0;
const rec = (branch, status, pickup, last) => ({ awb: 'A' + (++n), branch, status, pickup: d(pickup), lastStatus: last ? d(last) : null });

const records = [
  // Cairo: delivered in 1 day (within market 2), 2 days (within), 3 days (over market, within company), 16 days (over company)
  rec('فرع مدينة نصر', 'تسليم ناجح', '2026-10-01', '2026-10-02'),
  rec('مدينة نصر', 'تسليم ناجح', '2026-10-01', '2026-10-03'),
  rec('مدينة نصر', 'التسليم ناجح', '2026-10-01', '2026-10-04'),
  rec('مدينة نصر', 'تسليم ناجح', '2026-10-01', '2026-10-17'),
  // Cairo closed returns: 5 days (within 5), 6 days (over)
  rec('الهرم', 'مرتجعات', '2026-10-02', '2026-10-07'),
  rec('الهرم', 'مرتجعات', '2026-10-02', '2026-10-08'),
  // Cairo open return -> age vs asOf = 22 days, over 5
  rec('الهرم', 'مرتجع بالفرع', '2026-10-02', '2026-10-03'),
  // Cairo in progress, age 23 > 15 over ; and 10 <= 15 within
  rec('الاسكندريه', 'قيد التشغيل', '2026-10-01', null),
  rec('الإسكندرية', 'قيد التشغيل', '2026-10-14', null),
  // Delta
  rec('طنطا', 'تسليم ناجح', '2026-10-05', '2026-10-08'),   // 3 days within market 3
  rec('طنطا', 'تسليم ناجح', '2026-10-05', '2026-10-09'),   // 4 days over market
  // Upper
  rec('فرع الصعيد', 'مرتجعات', '2026-10-05', '2026-10-12'), // 7 > 6 over
  // Rejected -> other ; unmapped branch ; no pickup
  rec('فرع الصعيد', 'رفض الاستلام و تم دفع الشحن', '2026-10-05', '2026-10-06'),
  rec('فرع غير معروف', 'تسليم ناجح', '2026-10-05', '2026-10-06'),
  { awb: 'Z1', branch: 'الهرم', status: 'تسليم ناجح', pickup: null, lastStatus: null },
  // Same-day delivery -> age 0
  rec('المعادي', 'تسليم ناجح', '2026-10-03', '2026-10-03'),
];
const out = sandbox.ageReportCompute_(records, groups, asOf);
const g = (k) => out.groups.find(x => x.key === k);
const cairo = g('cairo'), delta = g('delta'), upper = g('upper');

check('total shipments = 16', out.kpis.shipments === 16, out.kpis.shipments);
check('cairo delivered count = 6 (incl. no-pickup + same-day)', cairo.kinds.delivered.count === 6, cairo.kinds.delivered.count);
check('cairo delivered within market (<=2d) = 3 (1d,2d,0d)', cairo.kinds.delivered.withinMarket === 3, cairo.kinds.delivered.withinMarket);
check('cairo delivered within company (<=15d) = 4 (1,2,3,0d)', cairo.kinds.delivered.withinCompany === 4, cairo.kinds.delivered.withinCompany);
check('cairo delivered over company = 1 (16d)', cairo.kinds.delivered.over === 1, cairo.kinds.delivered.over);
check('cairo delivered without age = 1 (missing pickup)', cairo.kinds.delivered.noAge === 1, cairo.kinds.delivered.noAge);
check('cairo closed returns: 2, within 1, over 1', cairo.kinds.returnClosed.count === 2 && cairo.kinds.returnClosed.withinCompany === 1 && cairo.kinds.returnClosed.over === 1);
check('cairo open return: 1 and overdue (22d > 5d)', cairo.kinds.returnOpen.count === 1 && cairo.kinds.returnOpen.over === 1 && cairo.kinds.returnOpen.avgAge === 22, cairo.kinds.returnOpen);
check('cairo in progress: 2, one over (23d), one within (10d)', cairo.kinds.inProgress.count === 2 && cairo.kinds.inProgress.over === 1 && cairo.kinds.inProgress.withinCompany === 1, cairo.kinds.inProgress);
check('delta delivered within market (3d ok, 4d not) = 1', delta.kinds.delivered.withinMarket === 1);
check('upper closed return 7d over 6', upper.kinds.returnClosed.over === 1);
check('rejected goes to other (not delivered/return)', upper.kinds.other.count === 1 && out.kpis.other === 1);
check('unmapped branch reported, not silently dropped', out.unassigned && out.unassigned.total === 1 && out.dq.unmappedBranches['فرع غير معروف'] === 1, out.dq);
check('unassigned never judged against a standard', out.unassigned.kinds.delivered.over === 0 && out.unassigned.kinds.delivered.withinCompany === 0);
check('missing pickup counted in dq', out.dq.invalidPickup === 1);
check('open total = 3 (2 in progress + 1 open return)', out.kpis.open === 3, out.kpis.open);
check('open overdue = 2', out.kpis.openOverdue === 2, out.kpis.openOverdue);
check('open list: overdue first, sorted by age desc', out.open.list[0].overdue && out.open.list[0].age >= out.open.list[1].age, out.open.list.map(x => x.age));
check('returns = closed + open (3) ; kpi pct of all returns', out.kpis.returns === 4 && out.kpis.returnClosed === 3 && out.kpis.returnOpen === 1, out.kpis);
check('branch label strips "فرع " and uses configured spelling', cairo.branches.some(b => b.name === 'مدينة نصر') && cairo.branches.some(b => b.name === 'الإسكندرية'));
check('Arabic variants (ه/ة, ا/إ) map to same branch', cairo.branches.filter(b => b.name === 'الإسكندرية').length === 1);
check('sum of group totals + unassigned = shipments', out.groups.reduce((a, x) => a + x.total, 0) + out.unassigned.total === out.kpis.shipments);
check('standards override applied', sandbox.ageResolveGroups_({ cairo: { market: 4 } })[0].market === 4 && sandbox.ageResolveGroups_({ cairo: { market: -1 } })[0].market === 2);
check('months in range Sep 25 - Oct 3', JSON.stringify(sandbox.ageReportMonthsInRange_(sandbox.ageDayNumFromIso_('2026-09-25'), sandbox.ageDayNumFromIso_('2026-10-03'))) === '["September","October"]');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
