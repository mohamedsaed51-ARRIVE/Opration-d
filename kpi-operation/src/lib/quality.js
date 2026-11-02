// Client Quality KPI — pure calculation (no UI, no network).
//
// Rule (as agreed with Mohamed Saeed):
//   success rate of a customer in a month = (delivered + rejected-with-shipping-paid) / all shipments of that month
//   For a measured month M, take the 3 calendar months before it. A customer is INCLUDED only if it has shipments
//   in all 3 of those months AND in M. Baseline = average success rate of the 3 previous months; current = rate of M.
//   delta (percentage points) = current - baseline:
//        >= 7  ممتاز        >= 5  المطلوب        >= 3  مقبول        otherwise  غير مقبول
//
// Input row shape (from Apps Script action=clientMonthly):  { n: "customer", v: { October: [total, delivered, paid], ... } }

export const MONTH_ORDER = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const MONTH_AR = {
  January: 'يناير', February: 'فبراير', March: 'مارس', April: 'أبريل', May: 'مايو', June: 'يونيو',
  July: 'يوليو', August: 'أغسطس', September: 'سبتمبر', October: 'أكتوبر', November: 'نوفمبر', December: 'ديسمبر',
};

export const LEVELS = [
  { key: 'excellent', label: 'ممتاز', minDelta: 7 },
  { key: 'required', label: 'المطلوب', minDelta: 5 },
  { key: 'acceptable', label: 'مقبول', minDelta: 3 },
  { key: 'below', label: 'غير مقبول', minDelta: -Infinity },
];

export const HISTORY_MONTHS = 3;

export function levelFor(deltaPoints) {
  if (deltaPoints === null || deltaPoints === undefined || Number.isNaN(deltaPoints)) return null;
  for (const l of LEVELS) if (deltaPoints >= l.minDelta) return l;
  return LEVELS[LEVELS.length - 1];
}

/** The `HISTORY_MONTHS` calendar months immediately before `month` (oldest first), or null when the year start is hit. */
export function previousMonths(month, count = HISTORY_MONTHS) {
  const i = MONTH_ORDER.indexOf(month);
  if (i - count < 0) return null;
  return MONTH_ORDER.slice(i - count, i);
}

const ok = (cell) => (cell ? cell[1] + cell[2] : 0);
const tot = (cell) => (cell ? cell[0] : 0);
const rate = (success, total) => (total > 0 ? (success / total) * 100 : null);

/**
 * method:
 *   'pooled' (default) — baseline = sum(success over the 3 months) / sum(total over the 3 months)
 *   'mean'             — baseline = simple average of the 3 monthly rates
 * minShipments — a customer needs at least this many shipments in EACH of the 4 months to be included (default 1).
 */
export function evaluateMonth(clients, month, { method = 'pooled', minShipments = 1 } = {}) {
  const prev = previousMonths(month);
  if (!prev) return { month, error: 'no-history', message: 'الشهر ده معندوش 3 شهور سابقة في نفس السنة.' };
  const needed = [...prev, month];
  const min = Math.max(1, Number(minShipments) || 1);

  const rows = [];
  const excluded = { notInAllMonths: 0, belowMinimum: 0 };
  for (const c of clients) {
    const cells = needed.map((m) => c.v[m]);
    const present = cells.every((cell) => tot(cell) > 0);
    if (!present) { if (cells.some((cell) => tot(cell) > 0)) excluded.notInAllMonths++; continue; }
    if (cells.some((cell) => tot(cell) < min)) { excluded.belowMinimum++; continue; }

    const histRates = prev.map((m) => rate(ok(c.v[m]), tot(c.v[m])));
    const histTotal = prev.reduce((s, m) => s + tot(c.v[m]), 0);
    const histSuccess = prev.reduce((s, m) => s + ok(c.v[m]), 0);
    const baseline = method === 'mean' ? histRates.reduce((s, r) => s + r, 0) / histRates.length : rate(histSuccess, histTotal);
    const cur = c.v[month];
    const current = rate(ok(cur), tot(cur));
    const delta = current - baseline;
    rows.push({
      name: c.n,
      monthlyRates: histRates, // aligned with `prev`
      baseline, current, delta,
      level: levelFor(delta),
      curTotal: tot(cur), curDelivered: cur[1], curPaid: cur[2],
      histTotal,
      _v: c.v,
    });
  }

  // Group result over the included customers.
  const sum = (months, f) => rows.reduce((s, r) => s + months.reduce((t, m) => t + f(r._v[m]), 0), 0);
  const monthRate = (m) => rate(sum([m], ok), sum([m], tot));
  const histMonthRates = prev.map(monthRate);
  const baseline = rows.length === 0 ? null
    : method === 'mean' ? histMonthRates.reduce((s, r) => s + r, 0) / histMonthRates.length
      : rate(sum(prev, ok), sum(prev, tot));
  const current = rows.length === 0 ? null : monthRate(month);
  const delta = baseline === null ? null : current - baseline;
  const levelCounts = Object.fromEntries(LEVELS.map((l) => [l.key, 0]));
  rows.forEach((r) => { levelCounts[r.level.key]++; });

  return {
    month, prev, method, minShipments: min,
    group: {
      baseline, current, delta, level: levelFor(delta),
      histMonthRates, // aligned with `prev`
      customers: rows.length,
      curTotal: rows.reduce((s, r) => s + r.curTotal, 0),
      curDelivered: rows.reduce((s, r) => s + r.curDelivered, 0),
      curPaid: rows.reduce((s, r) => s + r.curPaid, 0),
    },
    rows, excluded, levelCounts,
  };
}

/** Group result for every month that has its 3 previous months available — the month-by-month trend. */
export function evaluateAllMonths(clients, availableMonths, opts) {
  const have = new Set(availableMonths);
  const out = [];
  for (const m of MONTH_ORDER) {
    const prev = previousMonths(m);
    if (!prev || !have.has(m) || !prev.every((p) => have.has(p))) continue;
    const r = evaluateMonth(clients, m, opts);
    if (!r.error) out.push({ month: m, ...r.group, excluded: r.excluded });
  }
  return out;
}
