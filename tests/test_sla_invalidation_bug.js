'use strict';
// Regression test for buildNextSummaryBatch(): after SLA settings change,
// a batch run that is cut short by its time budget must NOT report
// allMonthsComplete: true, and must resume from the first month that was not
// yet rebuilt under the new SLA.
//
// Runs the REAL buildNextSummaryBatch / snapshotIsCurrentlyCompatible_ /
// getSnapshotBuildProgress_ / saveSnapshotBuildProgress_ /
// summaryBranchTargetsEqual_ / SNAPSHOT_BUILD_TIME_BUDGET_MS from Code.gs
// (loaded in full by tests/helpers/loadBackend.js — previously this test read
// a temporary copy from /tmp that no longer existed). Only the heavy
// per-month build, the snapshot store, the persisted SLA settings and the
// clock are replaced, so the test never reads a sheet or touches Google.

const { createSuite, assertTrue } = require('./helpers/harness');
const { loadBackend } = require('./helpers/loadBackend');

const suite = createSuite('test_sla_invalidation_bug');
const SIMULATED_BUILD_MS = 25000; // ~25s per month, the realistic duration assumed in the original bug report

// One "execution" of buildNextSummaryBatch: a fresh Code.gs context (as a new
// Apps Script execution would be), sharing Script Properties and saved
// snapshots with previous executions, with a fake clock starting at 0.
function runBatch(state, sla) {
  const ctx = loadBackend({ properties: state.props });
  const RealDate = Date;
  const clock = { now: 0 };
  function FakeDate(...args) {
    if (args.length === 0) return new RealDate(clock.now);
    return new RealDate(...args);
  }
  FakeDate.now = () => clock.now;
  FakeDate.prototype = RealDate.prototype;
  ctx.Date = FakeDate;

  const buildLog = [];
  ctx.getPersistedSlaSettings_ = () => sla;
  ctx.getSavedMonthSummary_ = (month) => state.snapshots[month] || null;
  ctx.buildAndSaveMonthSummary = (month) => {
    buildLog.push(month);
    clock.now += SIMULATED_BUILD_MS;
    state.snapshots[month] = {
      filterCube: { buildConfig: { attemptT1: 1, attemptT2: 2, slaTargetDefault: sla.slaTargetDefault, branchSlaTargets: sla.branchSlaTargets } },
    };
    return { success: true, month, generatedAt: new RealDate(clock.now).toISOString(), totalRows: 1000, grandTotal: 1000, durationMs: SIMULATED_BUILD_MS };
  };

  const report = ctx.buildNextSummaryBatch();
  state.props = ctx.PropertiesService.__props;
  return { report, buildLog, ctx };
}

(async () => {
  const state = { props: {}, snapshots: {} };
  const SLA2 = { slaTargetDefault: 2, branchSlaTargets: {} };
  const SLA3 = { slaTargetDefault: 3, branchSlaTargets: {} };

  // Step 1 — build all 12 months under SLA=2 (the real 4-minute budget fits 10, so two runs).
  let r = runBatch(state, SLA2);
  const budgetMs = r.ctx.SNAPSHOT_BUILD_TIME_BUDGET_MS;
  if (!r.report.allMonthsComplete) r = runBatch(state, SLA2);

  await suite.test('Setup: all 12 months completed under SLA=2', {
    behavior: 'Resumable batch completes all 12 months across repeated runs',
    expected: 'allMonthsComplete === true after at most two runs',
  }, () => assertTrue(r.report.allMonthsComplete === true, 'allMonthsComplete'));

  // Steps 2–3 — SLA changes to 3; every saved snapshot is now stale. Fresh run.
  const run1 = runBatch(state, SLA3);
  const rr1 = run1.report;

  await suite.test('Fake clock is honoured by the real Code.gs (time budget stops the run)', {
    behavior: `Real SNAPSHOT_BUILD_TIME_BUDGET_MS (${budgetMs} ms) is enforced between months`,
    expected: 'Fewer than 12 months attempted in one run',
  }, () => assertTrue(rr1.monthsAttempted.length < 12, 'monthsAttempted.length < 12 — got ' + rr1.monthsAttempted.length));

  await suite.test('BUG FIX — after SLA change, run cut short by budget: allMonthsComplete === false', {
    behavior: 'Completion requires the snapshot to be compatible with the CURRENT SLA, not just a "completed" flag',
    expected: 'allMonthsComplete === false',
  }, () => assertTrue(rr1.allMonthsComplete === false, 'allMonthsComplete'));

  await suite.test('BUG FIX — nextMonthToProcess === "November" (first month not yet rebuilt under new SLA)', {
    behavior: 'Resume point after a budget stop', expected: 'November',
  }, () => assertTrue(rr1.nextMonthToProcess === 'November', 'nextMonthToProcess — got ' + rr1.nextMonthToProcess));

  await suite.test('10 months were rebuilt under the new SLA this run', {
    behavior: 'Budget arithmetic: 25s per month, checked between months', expected: '10',
  }, () => assertTrue(rr1.monthsCompletedThisRun.length === 10, 'monthsCompletedThisRun — got ' + rr1.monthsCompletedThisRun.length));

  await suite.test('No month was wrongly skipped this run (all 12 were stale, none should skip)', {
    behavior: 'Stale snapshots are never skipped', expected: 'monthsSkipped.length === 0',
  }, () => assertTrue(rr1.monthsSkipped.length === 0, 'monthsSkipped — got ' + JSON.stringify(rr1.monthsSkipped)));

  // Step 4 — second run rebuilds November and December.
  const rr2 = runBatch(state, SLA3).report;

  await suite.test('Second run attempts exactly November and December', {
    behavior: 'Only incompatible months are rebuilt', expected: '["November","December"]',
  }, () => assertTrue(rr2.monthsAttempted.length === 2 && rr2.monthsAttempted.includes('November') && rr2.monthsAttempted.includes('December'),
    'monthsAttempted — got ' + JSON.stringify(rr2.monthsAttempted)));

  await suite.test('Second run skips the 10 already-rebuilt (now compatible) months', {
    behavior: 'Compatible months are skipped', expected: '10 skipped',
  }, () => assertTrue(rr2.monthsSkipped.length === 10, 'monthsSkipped — got ' + rr2.monthsSkipped.length));

  await suite.test('BUG FIX — after finishing the rebuild: allMonthsComplete === true', {
    behavior: 'Completion after the full rebuild', expected: 'true',
  }, () => assertTrue(rr2.allMonthsComplete === true, 'allMonthsComplete'));

  await suite.test('nextMonthToProcess === null now', {
    behavior: 'Nothing left to process', expected: 'null',
  }, () => assertTrue(rr2.nextMonthToProcess === null, 'nextMonthToProcess — got ' + rr2.nextMonthToProcess));

  suite.finish();
})();
