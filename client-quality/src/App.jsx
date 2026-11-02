import React, { useEffect, useMemo, useState } from 'react';
import { fetchClientMonthly } from './api.js';
import { demoData } from './demo.js';
import { managementSummary } from './lib/summary.js';
import {
  LEVELS, MONTH_AR, MONTH_ORDER, evaluateAllMonths, evaluateMonth,
} from './lib/quality.js';

const pct = (v, d = 1) => (v === null || v === undefined ? '—' : `${v.toFixed(d)}%`);
const pts = (v, d = 2) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)} نقطة`);
const num = (v) => (v ?? 0).toLocaleString('en-US');
const ICON = { excellent: '★', required: '✔', acceptable: '◐', below: '✖' };

function Badge({ level }) {
  if (!level) return <span className="muted">—</span>;
  return <span className={`badge lv-${level.key}`}><span aria-hidden>{ICON[level.key]}</span> {level.label}</span>;
}

function Kpi({ title, value, sub, tone }) {
  return (
    <div className={`kpi ${tone || ''}`}>
      <div className="kpi-title">{title}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

/** Baseline bars + average line + the 3 / 5 / 7 point target lines. */
function BaselineChart({ result }) {
  const g = result.group;
  if (g.baseline === null) return null;
  const bars = [
    ...result.prev.map((m, i) => ({ label: MONTH_AR[m], value: g.histMonthRates[i], kind: 'hist' })),
    { label: MONTH_AR[result.month], value: g.current, kind: 'cur' },
  ];
  const lines = [
    { y: g.baseline, label: 'خط الأساس', cls: 'base' },
    ...[3, 5, 7].map((d, i) => ({ y: g.baseline + d, label: `+${d}`, cls: ['l3', 'l5', 'l7'][i] })),
  ];
  const all = [...bars.map((b) => b.value), ...lines.map((l) => l.y)];
  const lo = Math.max(0, Math.floor(Math.min(...all) - 4));
  const hi = Math.min(100, Math.ceil(Math.max(...all) + 3));
  const W = 700, H = 300, L = 54, R = 120, T = 16, B = 40;
  const x = (i) => L + ((W - L - R) / bars.length) * (i + 0.5);
  const bw = Math.min(70, ((W - L - R) / bars.length) * 0.55);
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) / 4) * i);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="مقارنة نسبة النجاح بخط الأساس">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="grid" />
          <text x={L - 8} y={y(t) + 4} textAnchor="end" className="axis">{t.toFixed(0)}%</text>
        </g>
      ))}
      {bars.map((b, i) => (
        <g key={b.label}>
          <rect x={x(i) - bw / 2} y={y(b.value)} width={bw} height={y(lo) - y(b.value)} rx="4" className={b.kind === 'cur' ? 'bar-cur' : 'bar-hist'} />
          <text x={x(i)} y={y(b.value) - 6} textAnchor="middle" className="bar-val">{b.value.toFixed(1)}%</text>
          <text x={x(i)} y={H - 16} textAnchor="middle" className="axis">{b.label}</text>
        </g>
      ))}
      {lines.map((l) => (
        <g key={l.label}>
          <line x1={L} x2={W - R + 6} y1={y(l.y)} y2={y(l.y)} className={`tline ${l.cls}`} />
          <text x={W - R + 10} y={y(l.y) + 4} className={`tlabel ${l.cls}`}>{l.label === 'خط الأساس' ? `الأساس ${l.y.toFixed(1)}` : `${l.label} (${l.y.toFixed(1)})`}</text>
        </g>
      ))}
    </svg>
  );
}

function TrendTable({ rows, selected, onSelect }) {
  if (!rows.length) return <p className="muted">مفيش شهور فيها 3 شهور سابقة متاحة لعرض الاتجاه.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>الشهر</th><th>خط الأساس</th><th>النسبة الحالية</th><th>الفرق</th><th>التقييم</th><th>عملاء محسوبين</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month} className={r.month === selected ? 'sel' : ''} onClick={() => onSelect(r.month)} style={{ cursor: 'pointer' }}>
              <td><b>{MONTH_AR[r.month]}</b></td>
              <td className="n">{pct(r.baseline)}</td>
              <td className="n">{pct(r.current)}</td>
              <td className="n">{pts(r.delta)}</td>
              <td><Badge level={r.level} /></td>
              <td className="n">{num(r.customers)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CustomersTable({ result }) {
  const [q, setQ] = useState('');
  const [lv, setLv] = useState('all');
  const [sort, setSort] = useState({ key: 'delta', dir: 'desc' });
  const [limit, setLimit] = useState(50);
  const rows = useMemo(() => {
    const f = result.rows.filter((r) => (lv === 'all' || r.level.key === lv) && (!q || r.name.includes(q.trim())));
    const val = (r) => (sort.key === 'name' ? r.name : sort.key === 'curTotal' ? r.curTotal : r[sort.key]);
    return f.sort((a, b) => {
      const A = val(a), B = val(b);
      const c = typeof A === 'string' ? A.localeCompare(B, 'ar') : A - B;
      return sort.dir === 'asc' ? c : -c;
    });
  }, [result, q, lv, sort]);
  const th = (key, label) => (
    <th onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))} className="sortable">
      {label}{sort.key === key ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}
    </th>
  );
  const exportCsv = () => {
    const head = ['العميل', ...result.prev.map((m) => `نسبة ${MONTH_AR[m]}`), 'خط الأساس', `نسبة ${MONTH_AR[result.month]}`, 'الفرق (نقطة)', 'التقييم', `شحنات ${MONTH_AR[result.month]}`];
    const lines = rows.map((r) => [r.name, ...r.monthlyRates.map((x) => x.toFixed(2)), r.baseline.toFixed(2), r.current.toFixed(2), r.delta.toFixed(2), r.level.label, r.curTotal]);
    const csv = '﻿' + [head, ...lines].map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `client-quality-${result.month}.csv`; a.click();
  };
  return (
    <>
      <div className="toolbar">
        <input placeholder="ابحث باسم العميل…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={lv} onChange={(e) => setLv(e.target.value)}>
          <option value="all">كل التقييمات ({result.rows.length})</option>
          {LEVELS.map((l) => <option key={l.key} value={l.key}>{l.label} ({result.levelCounts[l.key]})</option>)}
        </select>
        <button className="btn" onClick={exportCsv}>تصدير CSV</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {th('name', 'العميل')}
              {result.prev.map((m) => <th key={m}>{MONTH_AR[m]}</th>)}
              {th('baseline', 'خط الأساس')}
              {th('current', `نسبة ${MONTH_AR[result.month]}`)}
              {th('delta', 'الفرق')}
              <th>التقييم</th>
              {th('curTotal', 'الشحنات')}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                {r.monthlyRates.map((x, i) => <td key={i} className="n muted">{pct(x)}</td>)}
                <td className="n">{pct(r.baseline)}</td>
                <td className="n"><b>{pct(r.current)}</b></td>
                <td className="n">{pts(r.delta)}</td>
                <td><Badge level={r.level} /></td>
                <td className="n">{num(r.curTotal)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={result.prev.length + 6} className="muted center">مفيش نتائج</td></tr>}
          </tbody>
        </table>
      </div>
      {rows.length > limit && <button className="btn ghost" onClick={() => setLimit((l) => l + 100)}>عرض المزيد ({rows.length - limit} متبقي)</button>}
    </>
  );
}

function SummaryBox({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  return (
    <>
      <pre className="summary">{text}</pre>
      <button className="btn ghost" onClick={copy}>{copied ? 'تم النسخ ✔' : 'نسخ الملخص'}</button>
      <button className="btn ghost" style={{ marginInlineStart: 8 }} onClick={() => window.print()}>طباعة / PDF</button>
    </>
  );
}

export default function App() {
  const demo = new URLSearchParams(location.search).has('demo');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState('');
  const [method, setMethod] = useState('pooled');
  const [minShipments, setMin] = useState(1);

  const load = () => {
    setLoading(true); setError('');
    (demo ? Promise.resolve(demoData()) : fetchClientMonthly())
      .then((d) => { setData(d); })
      .catch((e) => setError(e.message || String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const opts = { method, minShipments };
  const trend = useMemo(() => (data ? evaluateAllMonths(data.clients, data.months, opts) : []), [data, method, minShipments]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (data && trend.length && !trend.some((t) => t.month === month)) setMonth(trend[trend.length - 1].month);
  }, [data, trend, month]);
  const result = useMemo(() => (data && month ? evaluateMonth(data.clients, month, opts) : null), [data, month, method, minShipments]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="app">
      <header className="top">
        <div>
          <div className="brand">ARRIVE</div>
          <h1>جودة أداء العملاء</h1>
          <p className="sub">نسبة النجاح = (التسليم + «رفض الاستلام وتم دفع الشحن») ÷ إجمالي الشحنات، مقارنة بمتوسط آخر 3 شهور للعملاء المكررين</p>
        </div>
        <button className="btn" onClick={load} disabled={loading}>{loading ? 'جاري التحميل…' : 'تحديث'}</button>
      </header>

      {demo && <div className="alert warn">⚠ بيانات تجريبية للمعاينة فقط (<code>?demo=1</code>) — مش أرقام ARRIVE الحقيقية.</div>}
      {error && <div className="alert err"><b>تعذر تحميل البيانات.</b> {error}</div>}
      {loading && !data && <div className="alert">جاري تحميل البيانات من Google Sheets… (أول مرة ممكن ياخد وقت)</div>}

      {data && (
        <>
          {(data.missingMonths?.length > 0 || data.skippedMonths?.length > 0) && (
            <div className="alert warn">
              شهور مفيهاش ملخص محفوظ (Snapshot) ومش داخلة في الحساب: {[...data.missingMonths, ...(data.skippedMonths || [])].map((m) => MONTH_AR[m]).join('، ')}.
              لتضمينها شغّل «تحديث الداش بورد» للشهر ده في الداش القديمة.
            </div>
          )}

          <section className="controls">
            <label>الشهر المقاس
              <select value={month} onChange={(e) => setMonth(e.target.value)}>
                {trend.map((t) => <option key={t.month} value={t.month}>{MONTH_AR[t.month]}</option>)}
              </select>
            </label>
            <label>طريقة المتوسط
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="pooled">مجمّع (إجمالي ÷ إجمالي)</option>
                <option value="mean">متوسط النسب الشهرية</option>
              </select>
            </label>
            <label>أقل عدد شحنات للعميل في كل شهر
              <input type="number" min="1" value={minShipments} onChange={(e) => setMin(Math.max(1, Number(e.target.value) || 1))} />
            </label>
          </section>

          {!trend.length && <div className="alert warn">مفيش شهر معاه 3 شهور سابقة متاحة. الشهور المتاحة: {data.months.map((m) => MONTH_AR[m]).join('، ') || 'لا يوجد'}.</div>}

          {result && !result.error && (
            <>
              <section className="kpis">
                <Kpi title={`خط الأساس (متوسط ${result.prev.map((m) => MONTH_AR[m]).join(' + ')})`} value={pct(result.group.baseline)} />
                <Kpi title={`نسبة ${MONTH_AR[result.month]}`} value={pct(result.group.current)} sub={`${num(result.group.curDelivered)} تسليم + ${num(result.group.curPaid)} دفع شحن من ${num(result.group.curTotal)} شحنة`} />
                <Kpi title="الفرق عن خط الأساس" value={pts(result.group.delta)} />
                <div className={`kpi verdict ${result.group.level ? `lv-${result.group.level.key}` : ''}`}>
                  <div className="kpi-title">التقييم</div>
                  <div className="kpi-value"><Badge level={result.group.level} /></div>
                  <div className="kpi-sub">مقبول ≥ +3 · المطلوب ≥ +5 · ممتاز ≥ +7</div>
                </div>
                <Kpi title="العملاء المحسوبين" value={num(result.group.customers)}
                  sub={`مستبعد: ${num(result.excluded.notInAllMonths)} (مش موجودين في الـ4 شهور)${result.excluded.belowMinimum ? ` + ${num(result.excluded.belowMinimum)} (أقل من الحد الأدنى)` : ''}`} />
              </section>

              <section className="card">
                <h2>ملخص للإدارة</h2>
                <SummaryBox text={managementSummary(result)} />
              </section>

              <section className="card">
                <h2>النسبة الحالية مقابل خط الأساس</h2>
                <BaselineChart result={result} />
                <div className="levels">
                  {LEVELS.map((l) => <span key={l.key} className="lvl-chip"><Badge level={l} /> {num(result.levelCounts[l.key])} عميل</span>)}
                </div>
              </section>

              <section className="card">
                <h2>النتيجة شهر بشهر</h2>
                <TrendTable rows={trend} selected={month} onSelect={setMonth} />
              </section>

              <section className="card">
                <h2>تفصيل العملاء — {MONTH_AR[result.month]}</h2>
                <CustomersTable result={result} />
              </section>
            </>
          )}

          <details className="card">
            <summary>مراجعة تصنيف الحالات (للتأكد من أن «دفع الشحن» محسوب صح)</summary>
            <p className="muted">تُحسب «دفع شحن» فقط الحالات النهائية اللي نصها فيه: {(data.paidKeywords || []).join('، ')}. أي رفض تاني (زي رفض الدفع) لا يُحسب نجاح.</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>الحالة</th><th>التصنيف هنا</th><th>عدد الشحنات (كل الشهور)</th></tr></thead>
                <tbody>
                  {data.statusClassification.map((s) => (
                    <tr key={s.status}>
                      <td>{s.status}</td>
                      <td>{s.cls === 'delivered' ? 'تسليم' : s.cls === 'paid' ? 'رفض + دفع شحن (يُحسب نجاح)' : 'رفض آخر (لا يُحسب)'}</td>
                      <td className="n">{num(s.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      <footer>المصدر: Google Sheets عبر نفس Web App الداش بورد التشغيلية — <code>action=clientMonthly</code></footer>
    </div>
  );
}
