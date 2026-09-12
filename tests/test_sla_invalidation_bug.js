const fs = require('fs');
const newCode = fs.readFileSync('/tmp/new_batch_code.js', 'utf8');
const RealDateCtor = Date;

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('PASS -', name); } else { fail++; console.log('FAIL -', name); } }

function buildSandbox(sharedProps, sharedSnapshots, startNow, slaBoxValue, failMonths) {
  const sandboxCode = `
(function(__RealDateCtor, __startNow){
  var __buildLog = [];
  var __props = ${JSON.stringify(sharedProps)};
  var __savedSnapshots = ${JSON.stringify(sharedSnapshots)};
  var __fakeNow = __startNow;
  var __sla = ${JSON.stringify(slaBoxValue)};
  var __failMonths = ${JSON.stringify(failMonths || {})};

  function Date(){
    if (arguments.length === 0) return new __RealDateCtor(__fakeNow);
    return new (Function.prototype.bind.apply(__RealDateCtor, [null].concat(Array.prototype.slice.call(arguments))))();
  }
  Date.prototype = __RealDateCtor.prototype;
  Date.now = function(){ return __fakeNow; };

  var Logger = { log: function(s){ __buildLog.push('[LOG]'+String(s)); } };
  var PropertiesService = {
    getScriptProperties: function(){
      return {
        getProperty: function(key){ return __props.hasOwnProperty(key) ? __props[key] : null; },
        setProperty: function(key, val){ __props[key] = val; },
        deleteProperty: function(key){ delete __props[key]; }
      };
    }
  };

  var MONTH_ORDER = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  var MONTH_SOURCE = {}; MONTH_ORDER.forEach(function(m){ MONTH_SOURCE[m] = "Q"; });

  function getPersistedSlaSettings_(){ return __sla; }
  function summaryBranchTargetsEqual_(a, b){
    a = a || {}; b = b || {};
    var ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (var i=0;i<ak.length;i++){ if (a[ak[i]] !== b[ak[i]]) return false; }
    return true;
  }
  function getSavedMonthSummary_(month){ return __savedSnapshots[month] || null; }

  function buildAndSaveMonthSummary(month){
    __buildLog.push('BUILD:'+month);
    __fakeNow += 25000; // ~25s per month, same realistic assumption as the reported bug
    if (__failMonths[month]) return { success:false, month:month, error:'اختبار فشل متعمد' };
    var sla = __sla;
    __savedSnapshots[month] = { filterCube: { buildConfig: { attemptT1:1, attemptT2:2, slaTargetDefault: sla.slaTargetDefault, branchSlaTargets: sla.branchSlaTargets } } };
    return { success:true, month:month, generatedAt: new Date().toISOString(), totalRows: 1000, grandTotal: 1000, durationMs: 25000 };
  }

  ${newCode}

  return {
    buildNextSummaryBatch: buildNextSummaryBatch,
    __getProps: function(){ return __props; },
    __getSnapshots: function(){ return __savedSnapshots; }
  };
})
`;
  const factory = eval(sandboxCode);
  return factory(RealDateCtor, startNow);
}

// ===================================================================
// EXACT SCENARIO FROM THE BUG REPORT:
// 1. All 12 months already marked completed (built under SLA=2).
// 2. SLA settings change (now SLA=3) -- every saved snapshot becomes stale.
// 3. Batch run: can only rebuild 10 months within the time budget.
// 4. Expected: allMonthsComplete === false, nextMonthToProcess === "November"
// 5. Second run rebuilds November and December.
// 6. Expected: allMonthsComplete === true
// ===================================================================

let props = {};
let snapshots = {};

console.log('--- Step 1: build all 12 months under SLA=2 (may take 2 runs due to the same 4-min budget) ---');
let sbInit = buildSandbox(props, snapshots, 0, { slaTargetDefault: 2, branchSlaTargets: {} });
let rInit = sbInit.buildNextSummaryBatch();
props = sbInit.__getProps();
snapshots = sbInit.__getSnapshots();
if (!rInit.allMonthsComplete) {
  sbInit = buildSandbox(props, snapshots, 0, { slaTargetDefault: 2, branchSlaTargets: {} });
  rInit = sbInit.buildNextSummaryBatch();
  props = sbInit.__getProps();
  snapshots = sbInit.__getSnapshots();
}
check('Setup: all 12 months completed under SLA=2', rInit.allMonthsComplete === true);

console.log('\n--- Step 2: SLA changes to 3 — every existing snapshot is now stale ---');
console.log('--- Step 3: run the batch again (fresh execution, fake clock resets to 0) — budget only fits 10 months ---');
const sbRebuild1 = buildSandbox(props, snapshots, 0, { slaTargetDefault: 3, branchSlaTargets: {} });
const rRebuild1 = sbRebuild1.buildNextSummaryBatch();
props = sbRebuild1.__getProps();
snapshots = sbRebuild1.__getSnapshots();
console.log(JSON.stringify({
  monthsCompletedThisRun: rRebuild1.monthsCompletedThisRun,
  nextMonthToProcess: rRebuild1.nextMonthToProcess,
  allMonthsComplete: rRebuild1.allMonthsComplete
}, null, 2));

check('BUG FIX — after SLA change, run cut short by budget: allMonthsComplete === false', rRebuild1.allMonthsComplete === false);
check('BUG FIX — nextMonthToProcess === "November" (first month not yet rebuilt under new SLA)', rRebuild1.nextMonthToProcess === 'November');
check('10 months were rebuilt under the new SLA this run', rRebuild1.monthsCompletedThisRun.length === 10);
check('No month was wrongly skipped this run (all 12 were stale, none should skip)', rRebuild1.monthsSkipped.length === 0);

console.log('\n--- Step 4: second run rebuilds November and December ---');
const sbRebuild2 = buildSandbox(props, snapshots, 0, { slaTargetDefault: 3, branchSlaTargets: {} });
const rRebuild2 = sbRebuild2.buildNextSummaryBatch();
console.log(JSON.stringify({
  monthsAttempted: rRebuild2.monthsAttempted,
  monthsSkipped: rRebuild2.monthsSkipped,
  allMonthsComplete: rRebuild2.allMonthsComplete
}, null, 2));

check('Second run attempts exactly November and December', rRebuild2.monthsAttempted.length === 2 && rRebuild2.monthsAttempted.includes('November') && rRebuild2.monthsAttempted.includes('December'));
check('Second run skips the 10 already-rebuilt (now compatible) months', rRebuild2.monthsSkipped.length === 10);
check('BUG FIX — after finishing the rebuild: allMonthsComplete === true', rRebuild2.allMonthsComplete === true);
check('nextMonthToProcess === null now', rRebuild2.nextMonthToProcess === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
