/* ==========================================================================
   ARRIVE DESIGN SYSTEM — JS LAYER (V2.0)
   Single source for everything that CSS cannot reach: Chart.js, jsPDF/report colours,
   status semantics, number/date formatting and the shared table enhancer.
   Colours are READ FROM the CSS tokens at runtime (arrive-tokens.css) — so changing
   --arrive-blue there re-colours charts and PDF reports too. The fallbacks below are the
   approved V2.0 values and are used only if the CSS variable cannot be read.
   ========================================================================== */
const ARRIVE_DS = (function(){
  const FALLBACK = {
    '--arrive-blue':'#0837C9','--arrive-teal':'#00C7E6','--arrive-navy':'#0F172A','--arrive-light-blue':'#E6F4FF','--arrive-gray':'#64748B',
    '--arrive-blue-700':'#062BA0','--arrive-blue-800':'#05237F','--arrive-blue-900':'#0A1E6B','--arrive-blue-50':'#F2F8FF','--arrive-teal-600':'#00A9C4',
    '--gray-50':'#F8FAFC','--gray-100':'#F1F5F9','--gray-200':'#E2E8F0','--gray-300':'#CBD5E1','--gray-400':'#94A3B8','--gray-500':'#64748B','--gray-700':'#334155',
    '--status-success':'#22C55E','--status-in-progress':'#3B82F6','--status-under-action':'#F59E0B','--status-violation':'#EF4444','--status-closed':'#64748B',
    '--status-success-bg':'#DCFCE7','--status-in-progress-bg':'#DBEAFE','--status-under-action-bg':'#FEF3C7','--status-violation-bg':'#FEE2E2','--status-closed-bg':'#F1F5F9',
    '--status-success-fg':'#15803D','--status-in-progress-fg':'#1D4ED8','--status-under-action-fg':'#B45309','--status-violation-fg':'#B91C1C','--status-closed-fg':'#475569'
  };
  const cache = {};
  function tok(name){
    if(cache[name]) return cache[name];
    let v = '';
    try{ v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }catch(e){}
    if(!/^#[0-9a-fA-F]{6}$/.test(v)) v = FALLBACK[name] || '#000000';
    return (cache[name] = v);
  }
  function rgb(hex){ const h = String(hex).replace('#',''); return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; }
  function rgba(hex, a){ const c = rgb(hex); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; }

  /* Operational status — five states only. «حرج» is the SAME state as «مخالفة» (one colour, no separate critical). */
  const STATUS = {
    success:        { label:'مطابق',          icon:'circle-check',          color:()=>tok('--status-success'),       bg:()=>tok('--status-success-bg'),       fg:()=>tok('--status-success-fg') },
    'in-progress':  { label:'قيد التنفيذ',    icon:'clock',                 color:()=>tok('--status-in-progress'),   bg:()=>tok('--status-in-progress-bg'),   fg:()=>tok('--status-in-progress-fg') },
    'under-action': { label:'تحت الإجراء',    icon:'triangle-exclamation',  color:()=>tok('--status-under-action'),  bg:()=>tok('--status-under-action-bg'),  fg:()=>tok('--status-under-action-fg') },
    violation:      { label:'مخالفة / حرجة',  icon:'circle-exclamation',    color:()=>tok('--status-violation'),     bg:()=>tok('--status-violation-bg'),     fg:()=>tok('--status-violation-fg') },
    closed:         { label:'مغلق',           icon:'circle-xmark',          color:()=>tok('--status-closed'),        bg:()=>tok('--status-closed-bg'),        fg:()=>tok('--status-closed-fg') }
  };
  /* Legacy dashboard classes (pos / warn / neg / neu) → approved status keys. */
  const CLS_TO_STATUS = { pos:'success', warn:'under-action', neg:'violation', neu:'closed' };

  /* Chart palette — brand first, status colours only when the series IS a status (scales.css --chart-*). */
  const chart = {
    get accent(){ return tok('--arrive-blue'); },
    get teal(){ return tok('--arrive-teal'); },
    get navy(){ return tok('--arrive-navy'); },
    get positive(){ return tok('--status-success'); },
    get warning(){ return tok('--status-under-action'); },
    get negative(){ return tok('--status-violation'); },
    get inProgress(){ return tok('--status-in-progress'); },
    get neutral(){ return tok('--status-closed'); },
    get grid(){ return tok('--gray-200'); },
    get text(){ return tok('--arrive-gray'); },
    series(){ return [tok('--arrive-blue'), tok('--arrive-teal'), tok('--arrive-navy'), tok('--gray-400'), tok('--arrive-teal-600'), tok('--arrive-blue-700'), tok('--gray-500'), tok('--arrive-blue-900')]; }
  };

  /* Chart.js global defaults: Cairo, RTL tooltips/legends, navy tooltip, rounded bars. Idempotent and guarded. */
  function applyChartDefaults(){
    if(typeof Chart === 'undefined') return;
    const d = Chart.defaults;
    d.font.family = "'Cairo','Inter',system-ui,sans-serif";
    d.font.size = 12;
    d.color = chart.text;
    d.borderColor = chart.grid;
    d.plugins.legend.rtl = true;
    d.plugins.legend.textDirection = 'rtl';
    d.plugins.legend.labels.usePointStyle = true;
    d.plugins.legend.labels.pointStyle = 'rectRounded';
    d.plugins.legend.labels.boxWidth = 10;
    d.plugins.legend.labels.boxHeight = 10;
    d.plugins.tooltip.rtl = true;
    d.plugins.tooltip.textDirection = 'rtl';
    d.plugins.tooltip.backgroundColor = tok('--arrive-navy');
    d.plugins.tooltip.titleColor = '#FFFFFF';
    d.plugins.tooltip.bodyColor = '#FFFFFF';
    d.plugins.tooltip.titleFont = { family:"'Cairo','Inter',sans-serif", weight:'700', size:13 };
    d.plugins.tooltip.bodyFont = { family:"'Cairo','Inter',sans-serif", size:12 };
    d.plugins.tooltip.padding = 10;
    d.plugins.tooltip.cornerRadius = 6;
    d.plugins.tooltip.boxPadding = 4;
    d.plugins.tooltip.caretSize = 5;
    if(d.elements && d.elements.bar) d.elements.bar.borderRadius = 4;
    if(d.elements && d.elements.line){ d.elements.line.borderWidth = 2.25; }
    if(d.elements && d.elements.point){ d.elements.point.radius = 3; d.elements.point.hoverRadius = 5; }
  }

  /* Number & date formatting (mirrors ArriveFormat in components/data/Num.jsx): Latin digits, thousands separators, 1-decimal %, signed deltas. */
  const LRI = '⁦', PDI = '⁩', MINUS = '−';
  const isNum = v => typeof v === 'number' && isFinite(v);
  const fixed = (n, d) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits:d, maximumFractionDigits:d });
  const fmt = {
    number(v, decimals){ if(!isNum(v)) return '—'; return (v<0?'-':'') + fixed(v, decimals||0); },
    percent(v, decimals){ if(!isNum(v)) return '—'; return (v<0?'-':'') + fixed(v, decimals==null?1:decimals) + '%'; },
    delta(v, unit, decimals){ if(!isNum(v)) return '—'; const s = v>0?'+':v<0?MINUS:''; const body = s + fixed(v, decimals==null?1:decimals); return unit==='%' ? body+'%' : (unit ? body+' '+unit : body); },
    isolate(s){ return s==null||s==='' ? '' : LRI + s + PDI; }
  };

  const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  /* Component helpers (return HTML strings so existing innerHTML-based renderers can reuse them). */
  function badge(status, text, opts){
    const st = STATUS[status] ? status : 'closed';
    return `<span class="ds-badge ${st}">${esc(text || STATUS[st].label)}</span>`;
  }
  function emptyState(title, reason, icon){
    return `<div class="ds-empty"><div class="ds-ico"><i class="fa-solid fa-${icon||'box-open'}" aria-hidden="true"></i></div><b>${esc(title||'لا توجد بيانات')}</b>${reason?`<span>${esc(reason)}</span>`:''}</div>`;
  }
  const EMPTY_FILTER_MSG = 'لا توجد بيانات متاحة وفقًا للفلاتر المحددة.';

  /* ---------- DataTable enhancer: search + pagination for every .table-scroll > table.data-table ----------
     Presentation only: it hides/shows <tr> elements already rendered by the app; it never reads or changes data,
     sorting or exports. Re-applies automatically whenever the app re-renders the table (MutationObserver). */
  function enhanceTable(table){
    if(!table || table._dsEnh) return;
    table._dsEnh = true;
    const wrap = table.parentElement;
    if(!wrap || !wrap.parentNode) return;
    const st = { q:'', page:1, size:25 };
    const tools = document.createElement('div');
    tools.className = 'dt-tools';
    tools.innerHTML = '<div class="dt-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" placeholder="بحث في الجدول…" aria-label="بحث في الجدول"></div>' +
      '<label class="ds-field-label" style="display:flex;align-items:center;gap:6px;">عدد الصفوف<select class="dt-size" aria-label="عدد الصفوف في الصفحة"><option>10</option><option selected>25</option><option>50</option><option>100</option></select></label>' +
      '<span class="dt-count" aria-live="polite"></span>';
    const pager = document.createElement('div');
    pager.className = 'dt-pager';
    wrap.parentNode.insertBefore(tools, wrap);
    wrap.parentNode.insertBefore(pager, wrap.nextSibling);
    const input = tools.querySelector('input'), sizeSel = tools.querySelector('select'), count = tools.querySelector('.dt-count');
    let busy = false;

    function dataRows(body){
      return Array.from(body.rows).filter(r => !r.classList.contains('dt-noresult') && !(r.cells.length === 1 && r.cells[0].colSpan > 1));
    }
    function apply(){
      if(busy) return; busy = true;
      try{
        const body = table.tBodies[0];
        if(!body){ tools.style.display = 'none'; pager.style.display = 'none'; return; }
        const old = body.querySelector('.dt-noresult'); if(old) old.remove();
        // convert the app's plain "no data" row into the ARRIVE EmptyState (idempotent)
        if(body.rows.length === 1 && body.rows[0].cells.length === 1 && body.rows[0].cells[0].colSpan > 1 && !body.rows[0].querySelector('.ds-empty')){
          const c = body.rows[0].cells[0]; c.removeAttribute('style'); c.innerHTML = emptyState('لا توجد بيانات', EMPTY_FILTER_MSG);
          body.rows[0].className = 'dt-empty';
        }
        const rows = dataRows(body);
        const q = st.q.trim().toLowerCase();
        const match = rows.filter(r => !q || r.textContent.toLowerCase().includes(q));
        const pages = Math.max(1, Math.ceil(match.length / st.size));
        if(st.page > pages) st.page = pages;
        const from = (st.page - 1) * st.size, to = from + st.size;
        const show = new Set(match.slice(from, to));
        rows.forEach(r => { r.hidden = !show.has(r); });
        tools.style.display = rows.length > 8 || q ? '' : 'none';
        count.textContent = rows.length ? (q ? `${match.length.toLocaleString('en-US')} من ${rows.length.toLocaleString('en-US')} صف` : `${rows.length.toLocaleString('en-US')} صف`) : '';
        if(rows.length && !match.length){
          const tr = document.createElement('tr'); tr.className = 'dt-noresult dt-empty';
          const td = document.createElement('td'); td.colSpan = Math.max(1, (table.tHead && table.tHead.rows[0] ? table.tHead.rows[0].cells.length : 1));
          td.innerHTML = emptyState('لا توجد نتائج مطابقة', 'جرّب تغيير كلمات البحث.', 'magnifying-glass');
          tr.appendChild(td); body.appendChild(tr);
        }
        // pager
        pager.innerHTML = '';
        if(match.length > st.size){
          const mk = (label, p, cls, dis) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if(cls) b.className = cls; if(dis) b.disabled = true; b.addEventListener('click', () => { st.page = p; apply(); }); return b; };
          pager.appendChild(mk('السابق', st.page - 1, '', st.page === 1));
          const nums = new Set([1, pages, st.page, st.page - 1, st.page + 1]);
          let last = 0;
          Array.from(nums).filter(n => n >= 1 && n <= pages).sort((a, b) => a - b).forEach(n => {
            if(n - last > 1){ const g = document.createElement('span'); g.className = 'gap'; g.textContent = '…'; pager.appendChild(g); }
            pager.appendChild(mk(String(n), n, n === st.page ? 'on' : '')); last = n;
          });
          pager.appendChild(mk('التالي', st.page + 1, '', st.page === pages));
          pager.style.display = '';
        }else{ pager.style.display = 'none'; }
      } finally { busy = false; }
    }
    input.addEventListener('input', () => { st.q = input.value; st.page = 1; apply(); });
    sizeSel.addEventListener('change', () => { st.size = parseInt(sizeSel.value, 10) || 25; st.page = 1; apply(); });
    new MutationObserver(() => apply()).observe(table, { childList:true });
    apply();
  }
  function enhanceTables(root){
    (root || document).querySelectorAll('.table-scroll > table.data-table').forEach(enhanceTable);
  }

  return { tok, rgb, rgba, STATUS, CLS_TO_STATUS, chart, applyChartDefaults, fmt, esc, badge, emptyState, EMPTY_FILTER_MSG, enhanceTables, enhanceTable };
})();
