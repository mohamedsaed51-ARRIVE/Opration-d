import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMonth } from '../src/lib/quality.js';
import { managementSummary } from '../src/lib/summary.js';

const clients = [
  { n: 'A', v: { July: [100, 80, 0], August: [100, 80, 0], September: [100, 80, 0], October: [100, 90, 0] } },
  { n: 'B', v: { July: [100, 90, 0], August: [100, 90, 0], September: [100, 90, 0], October: [100, 80, 0] } },
  { n: 'C', v: { September: [10, 9, 0], October: [10, 9, 0] } },
];
test('summary states only calculated facts', () => {
  const s = managementSummary(evaluateMonth(clients, 'October'), { topN: 1 });
  assert.match(s, /2 عميل مكرر/);
  assert.match(s, /استُبعد 1 عميل/);
  assert.match(s, /85\.0%/);       // baseline (240+270)/600
  assert.match(s, /الفرق: 0\.00/); // current (90+80)/200 = 85 -> delta 0
  assert.match(s, /غير مقبول/);
  assert.match(s, /B \(-10\.00\)/);
  assert.match(s, /A \(\+10\.00\)/);
});
test('empty on error', () => assert.equal(managementSummary({ error: 'x' }), ''));
