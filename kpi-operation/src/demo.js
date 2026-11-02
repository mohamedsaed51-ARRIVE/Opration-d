// Deterministic SAMPLE data — only used with ?demo=1 to preview the layout. NOT real ARRIVE data.
const MONTHS = ['July', 'August', 'September', 'October'];
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
export function demoData() {
  const r = rng(7);
  const clients = [];
  for (let i = 1; i <= 60; i++) {
    const v = {};
    const base = 0.68 + r() * 0.22, size = Math.round(20 + r() * 400), lift = (r() - 0.35) * 0.12;
    const present = r() < 0.85 ? MONTHS : MONTHS.slice(1 + Math.floor(r() * 2));
    present.forEach((m, k) => {
      const t = Math.max(5, Math.round(size * (0.8 + r() * 0.4)));
      const p = Math.min(0.98, base + (k === 3 ? lift : 0) + (r() - 0.5) * 0.04);
      const ok = Math.round(t * p), paid = Math.round(ok * 0.05);
      v[m] = [t, ok - paid, paid];
    });
    clients.push({ n: `عميل تجريبي ${i}`, v });
  }
  return {
    success: true, months: MONTHS, missingMonths: [], skippedMonths: [], clients,
    statusClassification: [
      { status: 'تسليم ناجح', cls: 'delivered', count: 0 },
      { status: 'رفض (الحالة النهائية): رفض الاستلام و تم دفع الشحن', cls: 'paid', count: 0 },
      { status: 'رفض (الحالة النهائية): رفض الاستلام و رفض والدفع', cls: 'rejectedOther', count: 0 },
    ],
    paidKeywords: ['تم دفع الشحن'], demo: true,
  };
}
