// اختبارات أمان Opration-d — بيانات اصطناعية فقط.
// يشغّل Code.gs الحقيقي داخل vm بشيت اصطناعي ضار، ويمرّر ردوده إلى الواجهة في متصفح حقيقي (الشبكة محجوبة).
// التشغيل: node tests/security.test.js     INDEX=<مسار> لاختبار نسخة أخرى.   (playwright + chromium)
const { chromium } = require('playwright');
const fs = require('fs'), vm = require('vm'), path = require('path');
const INDEX = process.env.INDEX || path.join(__dirname, '..', 'index.html');
const X = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
let pass = 0, fail = 0;
const check = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + ' - ' + n + (c || extra === undefined ? '' : ' ' + JSON.stringify(extra))); };

// ---- Backend الحقيقي في vm ----
const header = ['رقم البوليصة', 'الراسل', 'المحافظة', 'المنطقة', 'فرع المنطقة', 'حالة الشحنة', 'الحالة النهائية', 'تاريخ استلام البيك أب', 'تاريخ اخر حالة'];
const rows = [header];
const add = (n, o) => { for (let i = 0; i < n; i++) rows.push([`W${rows.length}`, o.sender || 'عميل', o.gov || 'القاهرة', o.area || 'مدينة نصر', o.branch || 'مدينة نصر', o.status, o.fin || '', new Date(2026, 9, 1 + (rows.length % 5)), new Date(2026, 9, 3 + (rows.length % 5))]); };
add(6, { status: 'تسليم ناجح', fin: 'تم التسليم', sender: X + 'S', gov: X + 'G', area: X + 'A', branch: X + 'B' });
add(4, { status: 'تسليم ناجح', fin: 'تم التسليم' });
add(3, { status: 'حالة جديدة ' + X });          // حالة غير مصنّفة تظهر في جودة البيانات
add(2, { status: 'مرتجعات', fin: 'تم تسليم المرتجع', sender: '=HYPERLINK("http://x","c")' });
const store = {};
const sheet = { getName: () => 'October', getLastRow: () => rows.length, getLastColumn: () => header.length, getSheetId: () => 1, getRange: () => ({ getValues: () => rows, getDisplayValues: () => rows }) };
const sb = { console: { log() {}, info() {}, warn() {}, error() {} }, Date, Math, JSON, Object, Number, String, isFinite, Array, parseInt, parseFloat, isNaN, RegExp, Error, Set, Map,
  Session: { getScriptTimeZone: () => 'Africa/Cairo', getActiveUser: () => ({ getEmail: () => '' }) },
  Utilities: { getUuid: () => 'u', formatDate: (d) => { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }, computeDigest: (a, s) => Array.from(String(s)).slice(0, 8).map((c) => c.charCodeAt(0) & 127), DigestAlgorithm: { MD5: 1 } },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, getAll: () => ({}), putAll() {}, remove() {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => store[k] || null, setProperty: (k, v) => { store[k] = v; } }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) },
  SpreadsheetApp: { openById: (id) => ({ getId: () => id, getSheets: () => (id === '1EosPPKKZ549a6cEGcF_7sCuG9W_ZQmbi6s0MQgehdTs' ? [sheet] : []), getSheetByName: (n) => (id === '1EosPPKKZ549a6cEGcF_7sCuG9W_ZQmbi6s0MQgehdTs' && n === 'October' ? sheet : null) }) } };
vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sb);
const api = (params) => JSON.parse(sb.doGet({ parameter: params }).s);

(async () => {
  const lst = api({ action: 'listSheets' });
  check('الخادم الحقيقي (vm) أعاد قائمة الشهور', lst && lst.success !== false, lst && lst.error);
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
  const seen = []; if (process.env.DBG) pg.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log('CONSOLE', m.text().slice(0, 160)); });
  await pg.route('**/*', (r) => { const u = new URL(r.request().url());
    if (u.hostname === 'script.google.com') { const params = Object.fromEntries(u.searchParams); if (params.action === 'dashboard') { if (params.sheet === 'ALL_MONTHS') params.sheet = 'October'; /* لا يوجد تبويب ملخصات في الـ mock */ params.refresh = '1'; params.__buildPersistentSummary = true; } // يتجنب كتابة تبويب الملخص المخزَّن (غير موجود في الـ mock)
    let body; try { body = JSON.stringify(api(params)); seen.push((params.action || 'sheet=' + params.sheet) + ' => ' + body.slice(0, 100)); } catch (e) { body = JSON.stringify({ success: false, error: String(e) }); } return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body }); }
    return r.request().url().startsWith('file:') ? r.continue() : r.abort(); });
  await pg.addInitScript(() => { window.__blobs = []; const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__blobs.push(b); return o.call(URL, b); }; });
  await pg.goto('file://' + INDEX, { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(6000);
  const tabs = await pg.evaluate(() => [...document.querySelectorAll('.tab-btn')].map((t) => t.dataset.tab));
  for (const t of tabs) { await pg.evaluate((k) => { const el = document.querySelector('.tab-btn[data-tab="' + k + '"]'); el && el.click(); }, t); await pg.waitForTimeout(700); }
  await pg.evaluate(() => { document.querySelectorAll('select').forEach((s) => { for (let i = 0; i < s.options.length; i++) { s.selectedIndex = i; s.dispatchEvent(new Event('change', { bubbles: true })); } }); });
  await pg.waitForTimeout(1500);
  // مواضع المرحلة 1 مباشرة (دفاع على المخرجات حتى لو وصلت قيم غير معقّمة)
  await pg.evaluate((x) => { try { MGMT.monthsData = { July: { summary: { branchSummary: [{ name: x }], customerSummary: [{ name: x }] } } }; mgmtPopulateEntityFilters(['July']); const d = document.createElement('div'); d.id = '__t'; document.body.appendChild(d); mgmtRenderEntityAnalysis('__t', new Map(), x, ['July'], 'عميل'); } catch (e) {} }, X);
  await pg.waitForTimeout(500);
  if (process.env.DBG) { console.log(seen); console.log((await pg.evaluate(() => document.body.innerText)).slice(0, 300)); }
  const loaded = await pg.evaluate(() => document.body.innerText.length);
  check('الواجهة حمّلت بيانات من الخادم الحقيقي (صفحة غير فارغة)', loaded > 3000, loaded);
  const n = await pg.evaluate('window.__xss||0');
  check('XSS: لا تنفيذ (بيانات ضارة عبر Code.gs الحقيقي + مواضع المرحلة 1)', n === 0, n);
  check('XSS: لا img[onerror] في DOM', (await pg.evaluate("document.querySelectorAll('img[onerror]').length")) === 0);
  check('الوظيفة: الاسم الضار يظهر كنص ظاهر في الواجهة (لا يُحذف)', await pg.evaluate("/img src=x onerror/.test(document.body.innerText)"));
  check('لا أخطاء JavaScript', errs.length === 0, errs.slice(0, 2));
  // CSV
  const csvText = await pg.evaluate(async () => { try { downloadCSV('t.csv', [['a', '=HYPERLINK("http://x","c")', '+1+1', '-2+3', '@SUM(1)', 5, -5, 'عادي - A+B']]); } catch (e) { return 'ERR ' + e.message; } const b = window.__blobs[window.__blobs.length - 1]; return b ? await b.text() : ''; });
  check("CSV: الصيغ سبقها ' والأرقام الحقيقية (5 و -5 رقمية) والنص العادي لم تتغير", csvText.includes("\"'=HYPERLINK(") && csvText.includes("'+1+1") && csvText.includes("'-2+3") && csvText.includes("'@SUM(1)") && csvText.includes(',5,-5,') && csvText.includes('عادي - A+B'), csvText);
  await b.close();
  console.log(`\n${pass}/${pass + fail} اختبارًا ناجحًا`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
