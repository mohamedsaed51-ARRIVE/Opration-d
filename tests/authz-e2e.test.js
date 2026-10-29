// اختبار طرفي محلي: Code.gs الحقيقي + Authz.gs (vm) + auth-client.js في متصفح حقيقي مع GIS مُحاكى. بيانات اصطناعية، لا شبكة، لا Apps Script حي.
// يغطي: غير مسجّل، مسجّل بلا صلاحية، Viewer/Analyst/Admin، رفض action غير مصرّح، منع الكتابة افتراضيًا، 401 وانتهاء الجلسة والتجديد، فشل التجديد، عدم تخزين التوكن.
const { chromium } = require('playwright');
const fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto');
let pass = 0, fail = 0;
const check = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + ' - ' + n + (c || extra === undefined ? '' : ' ' + JSON.stringify(extra).slice(0, 300))); };
const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), AUTHZ = fs.readFileSync(path.join(__dirname, '..', 'security-design', 'Authz.gs'), 'utf8');
const CLIENT = 'test-client.apps.googleusercontent.com';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => 'h.' + b64(Object.assign({ pad: 'x'.repeat(80) }, claims)) + '.s';
const now = () => Math.floor(Date.now() / 1000);

function makeServer(props) {
  const store = Object.assign({ AUTHZ_MODE: 'enforce', OAUTH_CLIENT_ID: CLIENT, ACCESS_JSON: JSON.stringify({ 'v@t.example': 'viewer', 'a@t.example': 'analyst', 'ad@t.example': 'admin' }) }, props || {});
  const cache = {}; const log = [];
  const sb = { console: { log: (m) => log.push(String(m)), info() {}, warn() {}, error() {} }, Date, Math, JSON, Object, Number, String, isFinite, Array, parseInt, parseFloat, isNaN, RegExp, Error, Set, Map, encodeURIComponent,
    Session: { getScriptTimeZone: () => 'Africa/Cairo', getActiveUser: () => ({ getEmail: () => '' }) },
    Utilities: { getUuid: () => 'u', DigestAlgorithm: { SHA_256: 's' }, computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(String(s)).digest()).map((x) => x > 127 ? x - 256 : x), formatDate: () => '2026-10-01' },
    CacheService: { getScriptCache: () => ({ get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; }, getAll: () => ({}), putAll() {}, remove() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = v; }, deleteProperty: (k) => { delete store[k]; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) },
    UrlFetchApp: { fetch: (url) => { const t = decodeURIComponent(url.split('id_token=')[1]); let c; try { c = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()); } catch (e) { return { getResponseCode: () => 400, getContentText: () => '{}' }; }
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(c) }; } },
    SpreadsheetApp: { openById: (id) => ({ getId: () => id, getSheets: () => [], getSheetByName: () => null }), getActiveSpreadsheet: () => ({ getId: () => 'x' }), getUi: () => ({ createMenu: () => ({}) }) } };
  vm.createContext(sb); vm.runInContext(CODE, sb);
  vm.runInContext(AUTHZ + '\nvar doGetInner_ = doGet; doGet = function (e) { var d = authzGate_(e); return d ? jsonResponse(d) : doGetInner_(e); };', sb);
  return { sb, store, log, hits: [] };
}
const claims = (email, extra) => Object.assign({ aud: CLIENT, email, email_verified: 'true', exp: now() + 3000 }, extra || {});

(async () => {
  const srv = makeServer();
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const pg = await b.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(String(e))); const consoleLog = []; pg.on('console', (m) => consoleLog.push(m.text()));
  let served = 0;
  await pg.route('**/*', (r) => { const u = new URL(r.request().url());
    if (u.hostname === 'script.google.com') { served++; const params = Object.fromEntries(u.searchParams); const body = srv.sb.doGet({ parameter: params }).s; return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body }); }
    return u.protocol === 'file:' ? r.continue() : r.abort(); });
  await pg.addInitScript(() => {   // محاكاة GIS: طابور توكنات يتحكم بها الاختبار
    window.__queue = []; window.__prompts = 0; window.__cb = null;
    window.google = { accounts: { id: { initialize: (c) => { window.__cb = c.callback; }, prompt: (cb) => { window.__prompts++; const t = window.__queue.shift(); if (t) setTimeout(() => window.__cb({ credential: t }), 5); else if (cb) cb({ isNotDisplayed: () => true, isSkippedMoment: () => false }); }, disableAutoSelect() {} } } };
  });
  await pg.goto('file://' + path.join(__dirname, '..', 'security-design', 'auth-test.html'), { waitUntil: 'domcontentloaded' });
  await pg.addScriptTag({ path: path.join(__dirname, '..', 'security-design', 'auth-client.js') });
  await pg.evaluate((cid) => { window.__states = []; ArriveAuth.init({ clientId: cid, onState: (s, d) => window.__states.push(s + (d ? ':' + d : '')) }); }, CLIENT);
  const call = (params) => pg.evaluate(async (p) => { try { const u = 'https://script.google.com/macros/s/TEST/exec?' + new URLSearchParams(p); return { ok: true, j: await ArriveAuth.fetchJson(u) }; } catch (e) { return { ok: false, name: e.name, code: e.code, reason: e.reason, msg: e.message }; } }, params);
  const queue = (...t) => pg.evaluate((a) => { window.__queue.push(...a); }, t);
  const states = () => pg.evaluate('window.__states.slice()');

  // 1) غير مسجّل: لا طلب يخرج بلا توكن
  const s0 = served; let r = await call({ action: 'listSheets' });
  check('غير مسجّل: الطلب يُرفض في العميل (401 signed-out) ولا يصل أي طلب للخادم', !r.ok && r.code === 401 && served === s0, [r, served - s0]);
  check('غير مسجّل: الحالة signedOut', (await states()).includes('signedOut'));
  // 2) مسجّل بلا صلاحية
  await queue(jwt(claims('nobody@t.example'))); r = await call({ action: 'listSheets' });
  check('مسجّل غير مدرج: 403 ولا بيانات، والحالة forbidden', !r.ok && r.code === 403 && (await states()).some((s) => s.startsWith('forbidden')), r);
  // 3) Viewer
  await pg.evaluate("ArriveAuth.signOut()"); await queue(jwt(claims('v@t.example'))); r = await call({ action: 'listSheets' });
  check('Viewer: listSheets مسموح', r.ok && r.j.success !== false, r);
  r = await call({ action: 'dashboard', sheet: 'October' }); check('Viewer: dashboard لا يُرفض', r.ok || r.code !== 403);
  for (const a of ['buildSummary', 'saveSlaSettings', 'diagnose', 'buildQuarterSummaries', 'unknownAction']) { r = await call({ action: a, sheet: 'October', slaTargetDefault: '3' }); check('Viewer: ' + a + ' مرفوض 403', !r.ok && r.code === 403, r); }
  r = await call({ sheet: 'October' }); check('Viewer: التصدير الخام مرفوض 403', !r.ok && r.code === 403, r);
  check('Viewer: لم تتغير إعدادات SLA', !srv.store.SLA_SETTINGS_JSON);
  // 4) Analyst
  await pg.evaluate("ArriveAuth.signOut()"); await queue(jwt(claims('a@t.example'))); r = await call({ sheet: 'October' });
  check('Analyst: التصدير الخام مسموح', r.ok, r); r = await call({ action: 'buildSummary', sheet: 'October' }); check('Analyst: buildSummary مرفوض 403', !r.ok && r.code === 403, r);
  // 5) Admin: الكتابة مغلقة افتراضيًا
  await pg.evaluate("ArriveAuth.signOut()"); await queue(jwt(claims('ad@t.example'))); r = await call({ action: 'saveSlaSettings', slaTargetDefault: '3' });
  check('Admin: الكتابة عبر الويب مغلقة افتراضيًا (403 web-writes-disabled)', !r.ok && r.code === 403 && r.reason === 'web-writes-disabled', r);
  check('Admin: لا تغيير في الإعدادات', !srv.store.SLA_SETTINGS_JSON);
  srv.store.WEB_WRITES_ENABLED = 'true'; r = await call({ action: 'saveSlaSettings', slaTargetDefault: '3' }); check('Admin + تفعيل صريح: الحفظ يعمل', r.ok && r.j.success === true, r);
  srv.store.WEB_WRITES_ENABLED = '';
  // 6) انتهاء الجلسة: الخادم يرفض 401 expired ⇒ العميل يجدّد ويعيد مرة واحدة
  await pg.evaluate("ArriveAuth.signOut()");
  const expired = jwt(claims('v@t.example', { exp: now() - 5 })), fresh = jwt(claims('v@t.example', { exp: now() + 3000 }));
  await queue(expired, fresh); const p0 = await pg.evaluate('window.__prompts'); r = await call({ action: 'listSheets' });
  check('انتهاء الجلسة: 401 ⇒ تجديد توكن ⇒ إعادة محاولة واحدة ناجحة', r.ok && r.j.success !== false && (await pg.evaluate('window.__prompts')) - p0 === 2, [r, (await pg.evaluate('window.__prompts')) - p0]);
  // 7) فشل التجديد: لا حلقة لا نهائية
  await pg.evaluate("ArriveAuth.signOut()"); await queue(expired); const s1 = served; r = await call({ action: 'listSheets' });
  check('فشل التجديد بعد 401: يُرفع AuthError 401، الحالة signedOut، وبحد أقصى طلبين للخادم (بلا حلقة)', !r.ok && r.code === 401 && served - s1 <= 2 && (await states()).slice(-1)[0] === 'signedOut', [r, served - s1]);
  // 8) توكن بجمهور خاطئ/غير موثّق
  await pg.evaluate("ArriveAuth.signOut()"); await queue(jwt(claims('ad@t.example', { aud: 'other' })), jwt(claims('ad@t.example', { aud: 'other' }))); r = await call({ action: 'listSheets' });
  check('جهة مستهدفة (aud) خاطئة ⇒ 401 (حتى لو البريد Admin)', !r.ok && r.code === 401, r);
  await pg.evaluate("ArriveAuth.signOut()"); await queue(jwt(claims('ad@t.example', { email_verified: 'false' })), jwt(claims('ad@t.example', { email_verified: 'false' }))); r = await call({ action: 'listSheets' });
  check('بريد غير موثّق ⇒ 401', !r.ok && r.code === 401, r);
  // 9) التوكن لا يُخزَّن ولا يُسجَّل
  const ls = await pg.evaluate(() => { try { return JSON.stringify(localStorage) + JSON.stringify(sessionStorage) + document.cookie; } catch (e) { return ''; } });
  check('التوكن لا يُخزَّن في localStorage/sessionStorage/cookies ولا يظهر في سجل الكونسول', !/h\.ey|xxxxxxxx/.test(ls) && !consoleLog.some((l) => /xxxxxxxx|idToken/.test(l)), ls.slice(0, 100));
  check('سجل الخادم لا يحوي التوكن ولا البريد', !srv.log.some((l) => /xxxxxxxx|@t\.example/.test(l)) && srv.log.some((l) => l.includes('[AUTHZ]')));
  check('تحليل exp من JWT صحيح', (await pg.evaluate("ArriveAuth._parseExp('" + fresh + "')")) > now());
  check('لا أخطاء JavaScript', errs.length === 0, errs);
  await b.close();
  console.log(`\n${pass}/${pass + fail} اختبارًا ناجحًا`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(2); });
