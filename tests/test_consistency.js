'use strict';
// CONSISTENCY tests — do the different code paths produce the same numbers
// for the same (fictitious) shipments?
//
//   C1–C3  backend (Code.gs) vs frontend (index.html)
//   C4     same KPI formula, both sides, on identical pre-classified rows
//   C5     backend live aggregation vs backend Filter Cube
//   C6     backend single month vs backend "All Months" merge
//
// Where the paths are known to DIFFER today, the test asserts the difference
// exactly (baseline). Such tests are marked needsApproval: the difference is
// documented, not endorsed. When the code is unified, they will fail on
// purpose and must be updated in the same change.
//
// C1 follows the real production path of the frontend's raw-data export:
// fake sheet → real getMonthPage() (dates formatted as text by Code.gs) →
// JSON round trip (as over HTTP) → real buildRowsAndDQFromHeaderedData() and
// computeKPIs() lifted from index.html.

const { createSuite, assertEqual, assertClose, assertDeepEqual } = require('./helpers/harness');
const { loadBackend } = require('./helpers/loadBackend');
const { loadFrontend } = require('./helpers/loadFrontend');
const F = require('./fixtures/fakeShipments');

const suite = createSuite('test_consistency');

const FRONTEND_SPEC = {
  declarations: ['COLUMN_ALIASES', 'FIELD_LABELS', 'REQUIRED_FIELDS', 'STATUS_MAP', 'SLA_TARGET_DAYS',
    'BRANCH_SLA_TARGETS', 'ATTEMPT_T1_DAYS', 'ATTEMPT_T2_DAYS', 'ATTEMPT_LABELS', 'PROCESS_CHUNK_SIZE'],
  functions: ['normText', 'classifyStatus', 'dedupeForKPI', 'computeKPIs', 'getSlaTarget', 'classifyAttempt',
    'dateOnly', 'parseExcelDate', 'detectColumnMap', 'yieldToUI', 'buildRowsAndDQFromHeaderedData'],
};

const SAME_FIELDS = ['total', 'delivered', 'returned', 'pending', 'eligible', 'deliveryRate', 'returnRate',
  'withinSla', 'slaBreach', 'slaAchievement', 'avgDays', 'medianDays', 'maxDays', 'deliveredWithDate'];

(async () => {
  const fe = loadFrontend(FRONTEND_SPEC).api;
  const be = loadBackend({ workbooks: { Q3: { July: [F.HEADERS, ...F.julyRows()] } } });
  const beKpis = be.getMonthDashboardSummary('July', {}).kpis;

  const page = JSON.parse(JSON.stringify(be.getMonthPage('July', {})));
  const feParsed = await fe.buildRowsAndDQFromHeaderedData(page.rows[0], page.rows.slice(1));
  const feKpis = fe.computeKPIs(feParsed.rows);

  await suite.test('C1a — Backend dashboard vs frontend raw path: identical on every field not affected by status spelling', {
    behavior: 'Same fake month through Code.gs aggregation and through index.html raw-row parsing + computeKPIs',
    expected: 'total, delivered, returned, pending, eligible, delivery/return rate and all SLA fields are equal',
  }, () => {
    for (const f of SAME_FIELDS) {
      if (typeof beKpis[f] === 'number') assertClose(feKpis[f], beKpis[f], f, 1e-9);
      else assertEqual(feKpis[f], beKpis[f], f);
    }
    assertEqual(feParsed.dq.distinctAwb, 13, 'frontend distinctAwb');
    assertEqual(feParsed.dq.invalidDates, 1, 'frontend invalidDates');
  });

  await suite.test('C1b — KNOWN DIFFERENCE: hamza variant of "رفض الاستلام" is rejected in backend, unknown in frontend', {
    behavior: 'Backend normalizes أ/إ/آ/ى/ة before matching; frontend classifyStatus does not',
    expected: 'rejected 2 vs 1; unknown 1 vs 2; rejectedRate 18.18% vs 9.09%; successRate 69.23% vs 61.54%',
    needsApproval: true,
  }, () => {
    assertEqual(beKpis.rejected, 2, 'backend rejected');
    assertEqual(feKpis.rejected, 1, 'frontend rejected');
    assertEqual(beKpis.unknown, 1, 'backend unknown');
    assertEqual(feKpis.unknown, 2, 'frontend unknown');
    assertClose(beKpis.rejectedRate, 2 / 11 * 100, 'backend rejectedRate');
    assertClose(feKpis.rejectedRate, 1 / 11 * 100, 'frontend rejectedRate');
    assertClose(beKpis.successRate, 9 / 13 * 100, 'backend successRate');
    assertClose(feKpis.successRate, 8 / 13 * 100, 'frontend successRate');
  });

  await suite.test('C2 — KNOWN DIFFERENCE: delivery-attempt category (fractional days vs calendar days)', {
    behavior: 'Backend summaryClassifyAttempt uses elapsed fractional days; frontend classifyAttempt uses calendar-date difference',
    expected: 'TEST-013 (1.5 days, next calendar day): backend second / frontend first. TEST-003 (2 days + 1 h): backend other / frontend second. Totals backend {first 4, second 5, other 3, na 1} vs frontend {5, 5, 2, 1}',
    needsApproval: true,
  }, () => {
    const beAttempt = be.getMonthDashboardSummary('July', {}).attemptSummary;
    assertDeepEqual({ first: beAttempt.first, second: beAttempt.second, other: beAttempt.other, na: beAttempt.na },
      { first: 4, second: 5, other: 3, na: 1 }, 'backend attemptSummary');
    const L = fe.ATTEMPT_LABELS;
    const counts = { first: 0, second: 0, other: 0, na: 0 };
    const labelToKey = { [L.first]: 'first', [L.second]: 'second', [L.other]: 'other', [L.na]: 'na' };
    for (const r of fe.dedupeForKPI(feParsed.rows)) counts[labelToKey[fe.classifyAttempt(r)]]++;
    assertDeepEqual(counts, { first: 5, second: 5, other: 2, na: 1 }, 'frontend attempt counts');
    const t013 = feParsed.rows.find((r) => r.awb === 'TEST-013');
    assertEqual(fe.classifyAttempt(t013), L.first, 'frontend TEST-013');
    assertEqual(be.summaryClassifyAttempt(t013.slaDays, 1, 2), 'second', 'backend TEST-013');
  });

  await suite.test('C3 — Status classification table: backend vs frontend', {
    behavior: 'Both classifiers on the same list of status spellings',
    expected: 'Identical for exact texts and whitespace variants; differ ONLY for Arabic letter variants (إ/أ/آ, ى, ة)',
    needsApproval: true,
  }, () => {
    const same = ['تسليم ناجح', 'التسليم ناجح', ' تسليم  ناجح ', 'مرتجعات', 'رفض الاستلام و تم دفع الشحن',
      'رفض الاستلام و رفض والدفع', 'قيد التشغيل', 'قيد  التشغيل', 'Delivered', 'حالة تجريبية', ''];
    for (const s of same) assertEqual(fe.classifyStatus(s), be.summaryClassifyStatus(s), 'same result for ' + JSON.stringify(s));
    assertEqual(be.summaryClassifyStatus('رفض الإستلام و تم دفع الشحن'), 'rejected', 'backend إ variant');
    assertEqual(fe.classifyStatus('رفض الإستلام و تم دفع الشحن'), 'unknown', 'frontend إ variant');
    assertEqual(be.summaryClassifyStatus('رفض الأستلام و تم دفع الشحن'), 'rejected', 'backend أ variant');
    assertEqual(fe.classifyStatus('رفض الأستلام و تم دفع الشحن'), 'unknown', 'frontend أ variant');
  });

  await suite.test('C4 — Same KPI formulas on identical pre-classified rows (frontend computeKPIs vs backend summaryComputeKPIs)', {
    behavior: 'Pure formula comparison with parsing/classification removed, including a branch SLA override',
    expected: 'Every KPI field identical',
  }, () => {
    const base = F.d('2026-07-01T08:00:00');
    const spec = [['delivered', 1, 'أ'], ['delivered', 2, 'أ'], ['delivered', 2.5, 'ب'], ['delivered', 3.2, 'أ'],
      ['delivered', null, 'ب'], ['returned', 4, 'أ'], ['rejected', 2, 'ب'], ['pending', 1, 'أ'], ['unknown', 1, 'ب']];
    const rows = spec.map(([bucket, days, br], i) => ({
      awb: 'TEST-C4-' + i, bucket, slaDays: days, branch: 'فرع تجريبي ' + br,
      lastStatus: new Date(base.getTime() + i * 3600000),
    }));
    const overrides = { 'فرع تجريبي ب': 3 };
    fe.setGlobal('SLA_TARGET_DAYS', 2);
    fe.setGlobal('BRANCH_SLA_TARGETS', overrides);
    const a = fe.computeKPIs(rows);
    const b = be.summaryComputeKPIs(rows, overrides, 2);
    fe.setGlobal('BRANCH_SLA_TARGETS', {});
    for (const key of Object.keys(b)) {
      if (typeof b[key] === 'number') assertClose(a[key], b[key], key, 1e-12);
      else assertEqual(a[key], b[key], key);
    }
    assertEqual(Object.keys(a).sort().join(','), Object.keys(b).sort().join(','), 'same output fields');
  });

  await suite.test('C5 — Backend live aggregation vs Filter Cube for the same filter', {
    behavior: 'Branch filter answered live (no snapshot) and from the cube (after buildAndSaveMonthSummary into the in-memory fake sheet)',
    expected: 'Identical KPIs and branch row, except medianDays (null from the cube — documented limitation)',
  }, () => {
    const filterParams = { filters: JSON.stringify({ branch: [F.BR_B] }) };
    const liveCtx = loadBackend({ workbooks: { Q3: { July: [F.HEADERS, ...F.julyRows()] } } });
    const live = liveCtx.getMonthDashboardSummary('July', filterParams);
    const cubeCtx = loadBackend({ workbooks: { Q3: { July: [F.HEADERS, ...F.julyRows()] } } });
    const built = cubeCtx.buildAndSaveMonthSummary('July');
    assertEqual(built.success, true, 'in-memory snapshot build');
    const cube = cubeCtx.getMonthDashboardSummary('July', filterParams);
    assertEqual(live.success !== false && cube.success !== false, true, 'both succeeded');
    assertEqual(!!live.filteredFromCube, false, 'first result really came from live aggregation');
    assertEqual(cube.filteredFromCube, true, 'second result really came from the Filter Cube');
    for (const key of Object.keys(live.kpis)) {
      if (key === 'medianDays') continue;
      if (typeof live.kpis[key] === 'number') assertClose(cube.kpis[key], live.kpis[key], 'kpis.' + key, 1e-9);
      else assertEqual(cube.kpis[key], live.kpis[key], 'kpis.' + key);
    }
    assertEqual(cube.kpis.medianDays, null, 'cube medianDays');
    assertEqual(live.kpis.total, 6, 'branch ب total');
    assertDeepEqual(cube.branchSummary, live.branchSummary, 'branchSummary');
  });

  await suite.test('C6 — KNOWN DIFFERENCES: single month vs "All Months" merge', {
    behavior: 'July and August hold the SAME 13 fictitious AWBs; both snapshots built in memory, then getAllMonthsDashboardSummary()',
    expected: '(a) total 26 — AWBs repeated across months are counted twice; (b) branch ب rejected rate 33.33% in the month view (÷ total − pending, unknown included) but 40% in All Months (÷ delivered + returned + rejected, unknown excluded)',
    needsApproval: true,
  }, () => {
    const ctx = loadBackend({ workbooks: { Q1: {}, Q2: {}, Q4: {}, Q3: { July: [F.HEADERS, ...F.julyRows()], August: [F.HEADERS, ...F.julyRows()] } } });
    assertEqual(ctx.buildAndSaveMonthSummary('July').success, true, 'July snapshot');
    assertEqual(ctx.buildAndSaveMonthSummary('August').success, true, 'August snapshot');
    const month = ctx.getMonthDashboardSummary('July', {});
    const all = ctx.getAllMonthsDashboardSummary({});
    assertDeepEqual(all.includedMonths, ['July', 'August'], 'includedMonths');
    assertEqual(all.kpis.total, 26, 'All Months total (13 unique AWBs counted twice)');
    const mB = month.branchSummary.find((x) => x.name === F.BR_B);
    const aB = all.branchSummary.find((x) => x.name === F.BR_B);
    assertClose(mB.rejectedRate, 2 / 6 * 100, 'month-view branch ب rejectedRate');
    assertClose(aB.rejectedRate, 4 / 10 * 100, 'All-Months branch ب rejectedRate');
    // Month-level (company-wide) rates stay consistent because the merge keeps pending/unknown there:
    assertClose(all.kpis.rejectedRate, month.kpis.rejectedRate, 'company-level rejectedRate unchanged by merge');
    assertEqual(all.kpis.medianDays, null, 'All Months medianDays (documented limitation)');
  });

  suite.finish();
})();
