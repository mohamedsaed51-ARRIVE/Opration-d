'use strict';
// KPI BASELINE tests — Code.gs (backend), which produces every number the
// dashboard actually displays.
//
// IMPORTANT: these tests pin down what the CURRENT code does. They are NOT a
// statement that the behavior is correct or approved. Tests marked
// needsApproval=true assert rules for which no approved ARRIVE definition
// exists in the repository; if management approves a different rule, the
// test must be updated together with the code change — a failure then is
// the expected, visible signal of that change.
//
// Data: tests/fixtures/fakeShipments.js (fictitious). Pipeline tests run the
// real getMonthDashboardSummary() end-to-end against an in-memory fake sheet.

const { createSuite, assertEqual, assertClose, assertTrue } = require('./helpers/harness');
const { loadBackend } = require('./helpers/loadBackend');
const F = require('./fixtures/fakeShipments');

const suite = createSuite('test_kpi_baseline');
const E = F.JULY_EXPECTED_BACKEND;

function julySummary() {
  const ctx = loadBackend({ workbooks: { Q3: { July: [F.HEADERS, ...F.julyRows()] } } });
  const r = ctx.getMonthDashboardSummary('July', {});
  if (!r || r.success === false) throw new Error('getMonthDashboardSummary failed: ' + (r && r.error));
  return { ctx, r };
}

// Minimal already-deduped row shape consumed by summaryComputeKPIs.
function row(bucket, slaDays, branch) {
  return { bucket, slaDays: slaDays === undefined ? null : slaDays, branch: branch || 'فرع تجريبي أ' };
}

(async () => {
  const { r } = julySummary();
  const k = r.kpis;

  // ---------------------------------------------------------------- status
  await suite.test('K1 — Status classification (summaryClassifyStatus)', {
    behavior: 'Maps raw status text to delivered/returned/rejected/pending/unknown via SUMMARY_STATUS_MAP (exact match after whitespace trim + Arabic letter normalization أ/إ/آ→ا, ى→ي, ة→ه)',
    expected: 'The 7 listed texts and their spacing/hamza variants map to their bucket; anything else → unknown',
    needsApproval: true,
  }, () => {
    const ctx = loadBackend();
    const cases = [
      ['تسليم ناجح', 'delivered'], ['التسليم ناجح', 'delivered'], ['  تسليم   ناجح ', 'delivered'],
      ['مرتجعات', 'returned'],
      ['رفض الاستلام و تم دفع الشحن', 'rejected'], ['رفض الاستلام و رفض والدفع', 'rejected'],
      ['رفض الإستلام و تم دفع الشحن', 'rejected'], // hamza variant — normalized by backend
      ['قيد التشغيل', 'pending'], ['قيد  التشغيل', 'pending'],
      ['تسليم ناجحة', 'unknown'], // normalizes to "ناجحه" — a different word, not in the map
      ['Delivered', 'unknown'], ['مرتجع', 'unknown'], ['', 'unknown'], [null, 'unknown'],
    ];
    for (const [input, bucket] of cases) assertEqual(ctx.summaryClassifyStatus(input), bucket, 'classify ' + JSON.stringify(input));
  });

  // ----------------------------------------------------------------- dedup
  await suite.test('K2 — Duplicate AWBs: latest "last status date" wins; ties → later row wins', {
    behavior: 'AWB dedup inside getMonthDashboardSummary (TEST-011: pending→delivered by date; TEST-012: identical dates, returned then pending)',
    expected: 'TEST-011 counted once as delivered; TEST-012 counted once as pending; 13 unique of 15 AWB rows; 2 duplicated AWBs',
    needsApproval: true, // tie-break rule (">=" keeps the later sheet row) is not documented
  }, () => {
    assertEqual(r.dataQuality.distinctAwb, 13, 'distinctAwb');
    assertEqual(r.dataQuality.dupAwbCount, 2, 'dupAwbCount');
    assertEqual(r.dataQuality.reconciliation.validAwbRows, 15, 'rows with an AWB');
    assertEqual(r.dataQuality.reconciliation.duplicateExtraRows, 2, 'duplicate extra rows');
    assertEqual(k.pending, E.pending, 'pending (TEST-009 + TEST-012 resolved to its later row)');
    assertEqual(k.delivered, E.delivered, 'delivered (includes TEST-011 resolved to delivered)');
  });

  // ----------------------------------------------------------------- total
  await suite.test('K3 — Total shipments = unique AWBs within the month', {
    behavior: 'Rows with no AWB and fully blank rows are excluded; duplicates counted once',
    expected: 'total = 13 (blank-AWB row and blank row ignored, physical rows = 17)',
    needsApproval: true, // cross-month duplicates are NOT deduped — see test_consistency C5
  }, () => {
    assertEqual(k.total, E.total, 'kpis.total');
    assertEqual(r.dataQuality.reconciliation.physicalRows, 17, 'physicalRows');
    assertEqual(r.dataQuality.reconciliation.blankAwbRows, 1, 'blankAwbRows');
    assertEqual(r.dataQuality.reconciliation.fullyBlankRows, 1, 'fullyBlankRows');
    assertEqual(k.delivered + k.returned + k.rejected + k.pending + k.unknown, k.total, 'buckets sum to total');
  });

  // ---------------------------------------------------------------- rates
  await suite.test('K4 — Delivery rate = delivered ÷ total (pending and unknown stay in the denominator)', {
    behavior: 'kpis.deliveryRate', expected: '7 ÷ 13 × 100 = 53.846%', needsApproval: true,
  }, () => assertClose(k.deliveryRate, E.deliveryRate, 'deliveryRate'));

  await suite.test('K5 — Return rate = returned ÷ (total − pending) (unknown stays in the denominator)', {
    behavior: 'kpis.returnRate at month level', expected: '1 ÷ 11 × 100 = 9.091%', needsApproval: true,
  }, () => {
    assertEqual(k.eligible, E.eligible, 'eligible = total − pending');
    assertClose(k.returnRate, E.returnRate, 'returnRate');
  });

  await suite.test('K6 — Rejection rate = rejected ÷ (total − pending); hamza spelling variant counted as rejected', {
    behavior: 'kpis.rejectedRate at month level', expected: '2 ÷ 11 × 100 = 18.182%', needsApproval: true,
  }, () => {
    assertEqual(k.rejected, E.rejected, 'rejected (TEST-007 + TEST-008 hamza variant)');
    assertClose(k.rejectedRate, E.rejectedRate, 'rejectedRate');
  });

  await suite.test('K7 — Success rate = (delivered + rejected) ÷ total', {
    behavior: 'kpis.successRate — rejected-on-delivery counts as success', expected: '9 ÷ 13 × 100 = 69.231%', needsApproval: true,
  }, () => assertClose(k.successRate, E.successRate, 'successRate'));

  await suite.test('K8 — Unknown statuses are counted and listed, not dropped', {
    behavior: 'kpis.unknown and dataQuality.unknownStatusBreakdown', expected: 'unknown = 1 ("حالة تجريبية غير معروفة")',
  }, () => {
    assertEqual(k.unknown, E.unknown, 'kpis.unknown');
    assertEqual(r.dataQuality.unknownStatusCount, 1, 'unknownStatusCount');
  });

  // ------------------------------------------------------------------ SLA
  await suite.test('K9 — SLA on the month pipeline: delivered only, fractional days, target 2 days, "≤" is within', {
    behavior: 'withinSla / slaBreach / slaAchievement / missingSlaData over the fixture',
    expected: 'deliveredWithDate 6 (TEST-005 has no pickup date → excluded, missingSlaData 1); within 4 (1.0, 2.0, 0.33, 1.5 days); breach 2 (2.04, 3.0 days); 66.667%',
    needsApproval: true, // fractional-day measurement and same-day handling are not documented
  }, () => {
    assertEqual(k.deliveredWithDate, E.deliveredWithDate, 'deliveredWithDate');
    assertEqual(k.withinSla, E.withinSla, 'withinSla');
    assertEqual(k.slaBreach, E.slaBreach, 'slaBreach');
    assertClose(k.slaAchievement, E.slaAchievement, 'slaAchievement');
    assertEqual(r.dataQuality.missingSlaData, 1, 'missingSlaData');
    assertEqual(r.dataQuality.invalidDates, 1, 'invalidDates (missing pickup)');
  });

  await suite.test('K10 — SLA boundary cases (summaryComputeKPIs)', {
    behavior: 'Exact boundary, 1 minute over, same day, missing date, branch override, non-delivered rows',
    expected: '2.0 within; 2.0007 (≈1 min over) breach; 0 within; null excluded; branch target 3 makes 2.5 within; returned rows never enter SLA',
    needsApproval: true,
  }, () => {
    const ctx = loadBackend();
    const oneMinute = 1 / 1440;
    let x = ctx.summaryComputeKPIs([row('delivered', 2), row('delivered', 2 + oneMinute), row('delivered', 0), row('delivered', null), row('returned', 9)], {}, 2);
    assertEqual(x.withinSla, 2, 'within (2.0 and 0)');
    assertEqual(x.slaBreach, 1, 'breach (2 days + 1 minute)');
    assertEqual(x.deliveredWithDate, 3, 'deliveredWithDate excludes null');
    assertClose(x.slaAchievement, 2 / 3 * 100, 'slaAchievement');
    x = ctx.summaryComputeKPIs([row('delivered', 2.5, 'فرع تجريبي ب'), row('delivered', 2.5, 'فرع تجريبي أ')], { 'فرع تجريبي ب': 3 }, 2);
    assertEqual(x.withinSla, 1, 'only the branch with a 3-day override is within');
    x = ctx.summaryComputeKPIs([row('delivered', 1)], {}, undefined);
    assertEqual(x.withinSla, 1, 'default target falls back to SUMMARY_DEFAULT_SLA_DAYS (2)');
    x = ctx.summaryComputeKPIs([], {}, 2);
    assertEqual(x.slaAchievement, null, 'no delivered rows → null, not 0%');
    assertEqual(x.deliveryRate, null, 'no rows → deliveryRate null');
  });

  await suite.test('K11 — Average / median / max delivery days', {
    behavior: 'avgDays = arithmetic mean; medianDays = element floor(n/2) of the sorted list (upper median for even n)',
    expected: 'avg 1.6458 days; median 2 (a conventional median would be 1.75); max 3',
    needsApproval: true,
  }, () => {
    assertClose(k.avgDays, E.avgDays, 'avgDays', 1e-12);
    assertEqual(k.medianDays, E.medianDays, 'medianDays');
    assertEqual(k.maxDays, E.maxDays, 'maxDays');
  });

  await suite.test('K12 — Delivery-attempt category (summaryClassifyAttempt) uses fractional days', {
    behavior: 'Thresholds T1=1, T2=2 applied to (last status − pickup) in fractional days, for every bucket',
    expected: '1.0 first; 1.5 second; 2.0 second; 2.04 other; null na',
    needsApproval: true, // frontend uses calendar days instead — see test_consistency C2
  }, () => {
    const ctx = loadBackend();
    assertEqual(ctx.summaryClassifyAttempt(1, 1, 2), 'first', '1.0');
    assertEqual(ctx.summaryClassifyAttempt(1.5, 1, 2), 'second', '1.5');
    assertEqual(ctx.summaryClassifyAttempt(2, 1, 2), 'second', '2.0');
    assertEqual(ctx.summaryClassifyAttempt(2 + 1 / 24, 1, 2), 'other', '2.04');
    assertEqual(ctx.summaryClassifyAttempt(null, 1, 2), 'na', 'null');
    assertEqual(r.attemptSummary.total, 13, 'attemptSummary covers every deduped shipment');
  });

  // ----------------------------------------------------- column detection
  await suite.test('K13 — Column detection: fuzzy "contains" match (baseline of a risk)', {
    behavior: 'summaryDetectColumnMap falls back to substring matching when no exact header matches',
    expected: 'A column named "تاريخ التسليم المتوقع" (expected delivery date) is taken as the delivery date used for SLA; an empty header cell blocks every fuzzy match after it',
    needsApproval: true,
  }, () => {
    const ctx = loadBackend();
    const m1 = ctx.summaryDetectColumnMap(['رقم البوليصة', 'حالة الشحنة', 'تاريخ التسليم المتوقع']);
    assertEqual(m1.delivery, 'تاريخ التسليم المتوقع', 'expected-delivery column mapped as delivery date');
    const m2 = ctx.summaryDetectColumnMap(['رقم البوليصة', '', 'حالة الشحنة', 'تاريخ التسليم المتوقع']);
    assertEqual(m2.delivery, undefined, 'empty header blocks the fuzzy match');
  });

  suite.finish();
})();
