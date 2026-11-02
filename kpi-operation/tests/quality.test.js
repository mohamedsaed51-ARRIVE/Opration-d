import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMonth, evaluateAllMonths, levelFor, previousMonths } from '../src/lib/quality.js';

// cell = [total, delivered, paid]
const clients = [
  // included: Jul 100 (80+0), Aug 100 (80+0), Sep 100 (80+0) -> baseline 80 ; Oct 100 (85+3) -> 88 ; delta 8 -> ممتاز
  { n: 'A', v: { July: [100, 80, 0], August: [100, 78, 2], September: [100, 80, 0], October: [100, 85, 3] } },
  // included: baseline pooled = (270)/(300)=90 ; Oct 94 -> delta 4 -> مقبول
  { n: 'B', v: { July: [100, 90, 0], August: [100, 90, 0], September: [100, 90, 0], October: [100, 94, 0] } },
  // only 2 prior months -> excluded
  { n: 'C', v: { August: [50, 40, 0], September: [50, 40, 0], October: [50, 45, 0] } },
  // not present in October -> excluded
  { n: 'D', v: { July: [10, 9, 0], August: [10, 9, 0], September: [10, 9, 0] } },
  // included: baseline 80, Oct 78 -> delta -2 -> غير مقبول
  { n: 'E', v: { July: [100, 80, 0], August: [100, 80, 0], September: [100, 80, 0], October: [100, 76, 2] } },
  // included: baseline 50 ; Oct 55 -> delta 5 -> المطلوب (boundary is inclusive)
  { n: 'F', v: { July: [100, 50, 0], August: [100, 50, 0], September: [100, 50, 0], October: [100, 55, 0] } },
];

test('levels and boundaries', () => {
  assert.equal(levelFor(7).key, 'excellent');
  assert.equal(levelFor(6.99).key, 'required');
  assert.equal(levelFor(5).key, 'required');
  assert.equal(levelFor(4.99).key, 'acceptable');
  assert.equal(levelFor(3).key, 'acceptable');
  assert.equal(levelFor(2.99).key, 'below');
  assert.equal(levelFor(-10).key, 'below');
});

test('previous months', () => {
  assert.deepEqual(previousMonths('October'), ['July', 'August', 'September']);
  assert.equal(previousMonths('March'), null);
});

test('October: inclusion rule and per-customer results', () => {
  const r = evaluateMonth(clients, 'October');
  assert.deepEqual(r.prev, ['July', 'August', 'September']);
  assert.deepEqual(r.rows.map((x) => x.name).sort(), ['A', 'B', 'E', 'F']);
  assert.equal(r.excluded.notInAllMonths, 2); // C (2 months) and D (not in the measured month)
  const by = Object.fromEntries(r.rows.map((x) => [x.name, x]));
  assert.equal(by.A.baseline, 80); assert.equal(by.A.current, 88); assert.equal(by.A.delta, 8); assert.equal(by.A.level.key, 'excellent');
  assert.equal(by.B.level.key, 'acceptable');
  assert.equal(by.E.level.key, 'below'); assert.equal(by.E.delta, -2);
  assert.equal(by.F.level.key, 'required');
});

test('October: group result is pooled over the included customers only', () => {
  const r = evaluateMonth(clients, 'October');
  // baseline: success Jul/Aug/Sep = A 240+... compute: A 80+80+80=240, B 270, E 240, F 150 = 900 of 1200 -> 75
  assert.equal(r.group.baseline, 75);
  // current: A 88 + B 94 + E 78 + F 55 = 315 of 400 -> 78.75
  assert.equal(r.group.current, 78.75);
  assert.equal(r.group.delta, 3.75);
  assert.equal(r.group.level.key, 'acceptable');
  assert.equal(r.group.customers, 4);
  assert.equal(r.group.histMonthRates.length, 3);
});

test('mean method averages the 3 monthly rates instead of pooling', () => {
  const uneven = [{ n: 'X', v: { July: [10, 10, 0], August: [10, 10, 0], September: [1000, 500, 0], October: [10, 8, 0] } }];
  const pooled = evaluateMonth(uneven, 'October', { method: 'pooled' });
  const mean = evaluateMonth(uneven, 'October', { method: 'mean' });
  assert.ok(Math.abs(pooled.group.baseline - (520 / 1020) * 100) < 1e-9);
  assert.ok(Math.abs(mean.group.baseline - (100 + 100 + 50) / 3) < 1e-9);
});

test('paid shipping counts as success, and minShipments excludes small customers', () => {
  const c = [{ n: 'P', v: { July: [10, 5, 0], August: [10, 5, 0], September: [10, 5, 0], October: [10, 0, 6] } }];
  const r = evaluateMonth(c, 'October');
  assert.equal(r.rows[0].current, 60); assert.equal(r.rows[0].delta, 10);
  const strict = evaluateMonth(c, 'October', { minShipments: 30 });
  assert.equal(strict.rows.length, 0); assert.equal(strict.excluded.belowMinimum, 1); assert.equal(strict.group.delta, null);
});

test('month without 3 prior months returns an explicit error, never a guess', () => {
  assert.equal(evaluateMonth(clients, 'February').error, 'no-history');
});

test('month-by-month trend only includes months whose history is available', () => {
  const t = evaluateAllMonths(clients, ['July', 'August', 'September', 'October']);
  assert.deepEqual(t.map((x) => x.month), ['October']);
  assert.equal(evaluateAllMonths(clients, ['August', 'September', 'October']).length, 0);
});
