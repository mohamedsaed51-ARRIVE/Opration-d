// Run: node tests/test_status_cards.js — the 8-card status taxonomy end to end (live aggregation, saved cube, All-Months merge).
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('PASS -', name); } else { fail++; console.log('FAIL -', name, extra === undefined ? '' : JSON.stringify(extra)); } }

const header = ['رقم البوليصة', 'الراسل', 'المحافظة', 'المنطقة', 'فرع المنطقة', 'حالة الشحنة', 'الحالة النهائية', 'تاريخ استلام البيك أب', 'تاريخ اخر حالة'];
const rows = [header];
const mk = (n, status, fin) => { for (let i = 0; i < n; i++) rows.push(['W' + rows.length, 'عميل', 'القاهرة', 'مدينة نصر', 'مدينة نصر', status, fin, new Date(2026, 9, 1 + (rows.length % 5)), new Date(2026, 9, 3 + (rows.length % 5))]); };
mk(10, 'تسليم ناجح', 'تم التسليم');
mk(4, 'مرتجعات', 'تم تسليم المرتجع');          // closed returns
mk(3, 'مرتجع مفتوح', '');                       // open returns
mk(2, 'مرتجع معلق', '');                        // on-hold returns
mk(5, 'قيد التشغيل', '');                       // in progress
mk(6, 'مرتجعات', 'رفض الاستلام و تم دفع الشحن'); // rejected by FINAL status (takes precedence over the return status)
mk(7, 'حالة جديدة غريبة', '');                  // unclassified
const total = rows.length - 1;

const sheets = { October: { rows } };
const store = {};
const sb = { console, Date, Math, JSON, Object, Number, String, isFinite, Array,
  Session: { getScriptTimeZone: () => 'Africa/Cairo', getActiveUser: () => ({ getEmail: () => '' }) },
  Utilities: { formatDate: (d) => { const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }, computeDigest: (a, s) => Array.from(String(s)).slice(0, 8).map(c => c.charCodeAt(0) & 127), DigestAlgorithm: { MD5: 1 }, getUuid: () => 'u' },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, getAll: () => ({}), putAll: () => {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => store[k] || null, setProperty: (k, v) => { store[k] = v; } }) },
  SpreadsheetApp: { openById: () => ({ getSheetByName: n => sheets[n] ? { getLastRow: () => sheets[n].rows.length, getLastColumn: () => header.length, getRange: () => ({ getValues: () => sheets[n].rows }) } : null }) } };
vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sb);

const live = sb.getMonthDashboardSummary('October', { refresh: '1', __buildPersistentSummary: true });
const k = live.kpis;
check('live: total', k.total === total, k.total);
check('live: delivered', k.delivered === 10, k.delivered);
check('live: closed / open / hold returns', k.returnClosed === 4 && k.returnOpen === 3 && k.returnHold === 2, [k.returnClosed, k.returnOpen, k.returnHold]);
check('live: returned = closed + open + hold', k.returned === 9, k.returned);
check('live: rejected comes from the final-status column only', k.rejected === 6, k.rejected);
check('live: in progress', k.pending === 5, k.pending);
check('live: unclassified', k.unknown === 7, k.unknown);
check('live: the 7 buckets reconcile to the total', k.delivered + k.returned + k.rejected + k.pending + k.unknown === k.total);
check('live: unknown statuses reported in data quality', live.dataQuality.unknownStatusList.indexOf('حالة جديدة غريبة') >= 0, live.dataQuality.unknownStatusList);
check('live: rejected rows show the effective label in the status breakdown', Object.keys(live.statusSummary).some(s => s.indexOf('رفض (الحالة النهائية)') === 0), Object.keys(live.statusSummary));

// saved cube must give the same numbers (this is the path the dashboard uses after «تحديث الداش بورد»)
const fromCube = sb.summaryComputeFromCube_([live.filterCube], {}, '', '');
const c = fromCube.kpis;
check('cube: same split as live', c.returnClosed === 4 && c.returnOpen === 3 && c.returnHold === 2 && c.rejected === 6 && c.unknown === 7 && c.delivered === 10 && c.pending === 5, c);
check('cube: branch groups carry the sub-kinds too', fromCube.branchSummary.length === 1 && fromCube.branchSummary[0].returned === 9);
const merged = sb.summaryMergeTopKpis([k, c]);
check('all-months merge doubles every card', merged.returnClosed === 8 && merged.rejected === 12 && merged.unknown === 14 && merged.total === total * 2, merged);

// fallback switch
sb.SUMMARY_REJECT_FALLBACK_TO_STATUS = true; sb.SUMMARY_STATUS_LOOKUP = null;
check('fallback flag: a rejection written in the status column counts as rejected', sb.summaryClassifyKind('رفض الاستلام و تم دفع الشحن') === 'rejected');
sb.SUMMARY_REJECT_FALLBACK_TO_STATUS = false; sb.SUMMARY_STATUS_LOOKUP = null;
check('fallback flag off (default): the same status text is unclassified', sb.summaryClassifyKind('رفض الاستلام و تم دفع الشحن') === 'unknown');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
