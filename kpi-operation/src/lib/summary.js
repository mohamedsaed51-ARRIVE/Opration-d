import { MONTH_AR } from './quality.js';

const p = (v) => `${v.toFixed(1)}%`;
const d = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;

/** Plain-Arabic management summary built only from the calculated result (no assumptions beyond the stated rule). */
export function managementSummary(result, { topN = 5 } = {}) {
  if (!result || result.error || result.group.baseline === null) return '';
  const g = result.group, m = MONTH_AR[result.month];
  const prev = result.prev.map((x) => MONTH_AR[x]).join(' و');
  const lines = [];
  lines.push(`ملخص جودة أداء العملاء — ${m}`);
  lines.push(`• نطاق القياس: ${g.customers} عميل مكرر (لديهم شحنات في ${prev} و${m})، واستُبعد ${result.excluded.notInAllMonths} عميل لعدم توافر الأشهر الأربعة.`);
  lines.push(`• نسبة النجاح (التسليم + رفض الاستلام مع دفع الشحن): ${p(g.current)} في ${m} مقابل خط أساس ${p(g.baseline)} (متوسط ${prev}).`);
  lines.push(`• الفرق: ${d(g.delta)} نقطة مئوية ← التقييم: ${g.level.label}.`);
  const lc = result.levelCounts;
  lines.push(`• توزيع العملاء: ممتاز ${lc.excellent} · المطلوب ${lc.required} · مقبول ${lc.acceptable} · غير مقبول ${lc.below}.`);
  const byDelta = [...result.rows].sort((a, b) => a.delta - b.delta);
  const worst = byDelta.slice(0, topN).filter((r) => r.delta < 0);
  if (worst.length) lines.push(`• أكبر تراجع عن الخط الأساسي: ${worst.map((r) => `${r.name} (${d(r.delta)})`).join('، ')}.`);
  const best = byDelta.slice(-topN).reverse().filter((r) => r.delta > 0);
  if (best.length) lines.push(`• أكبر تحسن: ${best.map((r) => `${r.name} (${d(r.delta)})`).join('، ')}.`);
  return lines.join('\n');
}
