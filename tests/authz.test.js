// اختبارات قبول طبقة التفويض المقترحة (security-design/Authz.gs) — Code.gs الحقيقي + Authz.gs داخل vm، بيانات اصطناعية، لا شبكة.
// التشغيل: node tests/authz.test.js
const fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto');
let pass = 0, fail = 0;
const check = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + ' - ' + n + (c || extra === undefined ? '' : ' ' + JSON.stringify(extra).slice(0, 300))); };
const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const AUTHZ = fs.readFileSync(path.join(__dirname, '..', 'security-design', 'Authz.gs'), 'utf8');
const CLIENT = 'test-client.apps.googleusercontent.com';
const now = () => Math.floor(Date.now() / 1000);
const tok = (label) => label.padEnd(130, 'x');
const TOKENS = {
  viewer: { aud: CLIENT, email: 'viewer@test.example', email_verified: 'true', exp: now() + 3000 },
  analyst: { aud: CLIENT, email: 'analyst@test.example', email_verified: 'true', exp: now() + 3000 },
  admin: { aud: CLIENT, email: 'Admin@Test.Example', email_verified: 'true', exp: now() + 3000 },
  stranger: { aud: CLIENT, email: 'nobody@test.example', email_verified: 'true', exp: now() + 3000 },
  badaud: { aud: 'other-client', email: 'admin@test.example', email_verified: 'true', exp: now() + 3000 },
  expired: { aud: CLIENT, email: 'admin@test.example', email_verified: 'true', exp: now() - 10 },
  unverified: { aud: CLIENT, email: 'admin@test.example', email_verified: 'false', exp: now() + 3000 },
  http500: 500, throws: 'throw',
};
function make(props) {
  const store = Object.assign({ AUTHZ_MODE: 'enforce', OAUTH_CLIENT_ID: CLIENT, ACCESS_JSON: JSON.stringify({ 'viewer@test.example': 'viewer', 'analyst@test.example': 'analyst', 'admin@test.example': 'admin' }) }, props || {});
  const cache = {}; let fetches = 0; const logs = [];
  const sb = { console: { log: (m) => logs.push(String(m)), info() {}, warn() {}, error() {} }, Date, Math, JSON, Object, Number, String, isFinite, Array, parseInt, parseFloat, isNaN, RegExp, Error, Set, Map, encodeURIComponent,
    Session: { getScriptTimeZone: () => 'Africa/Cairo', getActiveUser: () => ({ getEmail: () => '' }) },
    Utilities: { getUuid: () => 'u', DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (a, s) => Array.from(crypto.createHash(a === 'sha256' ? 'sha256' : 'md5').update(String(s)).digest()).map((b) => b > 127 ? b - 256 : b), formatDate: () => '2026-10-01' },
    CacheService: { getScriptCache: () => ({ get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; }, getAll: () => ({}), putAll() {}, remove() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = v; }, deleteProperty: (k) => { delete store[k]; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) },
    UrlFetchApp: { fetch: (url) => { fetches++; const t = decodeURIComponent(url.split('id_token=')[1]); const k = Object.keys(TOKENS).find((x) => tok(x) === t); const v = TOKENS[k];
      if (v === 'throw') throw new Error('net'); if (typeof v === 'number') return { getResponseCode: () => v, getContentText: () => '{}' };
      if (!v) return { getResponseCode: () => 400, getContentText: () => '{}' };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(v) }; } },
    SpreadsheetApp: { openById: (id) => ({ getId: () => id, getSheets: () => [], getSheetByName: () => null }), getActiveSpreadsheet: () => ({ getId: () => 'x' }), getUi: () => ({ createMenu: () => ({}) }) } };
  vm.createContext(sb);
  vm.runInContext(CODE, sb);
  vm.runInContext(AUTHZ + '\nvar doGetInner_ = doGet; doGet = function (e) { var d = authzGate_(e); return d ? jsonResponse(d) : doGetInner_(e); };', sb);
  const call = (params, who) => { const p = Object.assign({}, params); if (who) p.idToken = tok(who); return JSON.parse(sb.doGet({ parameter: p }).s); };
  return { sb, store, call, logs, fetches: () => fetches };
}
const denied = (r) => r && (r.code === 401 || r.code === 403);
const SLA = { action: 'saveSlaSettings', slaTargetDefault: '3', branchSlaTargets: JSON.stringify({ 'فرع اختبار': 4 }) };

// 0) ضابط سالب: الوضع الحالي (off) = السلوك الحالي، أي مجهول يستطيع الكتابة
{ const t = make({ AUTHZ_MODE: 'off' }); const r = t.call(SLA);
  check('ضابط سالب (الوضع off = السلوك الحالي): مجهول يغيّر إعدادات SLA بلا مصادقة', r.success === true && t.store.SLA_SETTINGS_JSON.includes('فرع اختبار')); }

// 1) اكتمال السياسة: كل action في doGet الحقيقي موجود في AUTHZ_POLICY
{ const acts = [...CODE.slice(CODE.indexOf('function doGet'), CODE.indexOf('5B. DASHBOARD')).matchAll(/action === "(\w+)"/g)].map((m) => m[1]);
  const t = make(); const pol = vm.runInContext('AUTHZ_POLICY', t.sb);
  const missing = acts.filter((a) => !(a in pol)); check('السياسة تغطي كل actions في doGet (' + acts.length + ')', acts.length >= 12 && missing.length === 0, missing);
  const writes = vm.runInContext('Object.keys(AUTHZ_WRITE_ACTIONS)', t.sb);
  check('كل actions الكتابة/إعادة البناء مصنفة admin', writes.every((a) => pol[a] === 'admin'), writes); }

// 2) بلا توكن/توكن سيئ ⇒ 401 لكل action ولا تسرب بيانات
{ const t = make(); const all = ['listSheets', 'dashboard', 'ageReport', 'getSlaSettings', 'diagnose', 'diagnoseStatuses', 'diagnoseJuneStatuses', 'saveSlaSettings', 'buildSummary', 'buildQuarterSummaries', 'buildMissingSummaries', 'buildAgeSnapshot', 'unknownAction'];
  const bad = all.filter((a) => { const r = t.call({ action: a, sheet: 'October', slaTargetDefault: '3' }); return r.code !== 401 || Object.keys(r).some((k) => /rows|kpis|summary|payload|stack/i.test(k)); });
  check('بلا توكن: 401 لكل action (حتى غير المعروف) بلا أي بيانات', bad.length === 0, bad);
  check('بلا توكن: التصدير الخام ?sheet=X ⇒ 401', t.call({ sheet: 'October' }).code === 401);
  check('الإعدادات لم تتغير بعد محاولات الرفض', !t.store.SLA_SETTINGS_JSON); }
for (const k of ['badaud', 'expired', 'unverified', 'http500', 'throws']) { const t = make(); const r = t.call({ action: 'listSheets' }, k); check('توكن غير صالح (' + k + ') ⇒ 401', r.code === 401, r); }
{ const t = make(); check('توكن مجهول للخادم (غير معروف) ⇒ 401', t.call({ action: 'listSheets' }, 'nonexistent').code === 401); }
{ const t = make(); const r = t.call({ action: 'listSheets' }, 'stranger'); check('مستخدم صالح غير مدرج في القائمة ⇒ 403', r.code === 403, r); }
{ const t = make({ ALLOWED_HD: 'corp.example' }); check('قيد النطاق ALLOWED_HD يرفض توكنًا بلا hd', t.call({ action: 'listSheets' }, 'viewer').code === 401); }

// 3) مصفوفة الأدوار
{ const t = make();
  check('viewer: listSheets/dashboard/ageReport/getSlaSettings مسموحة', ['listSheets', 'dashboard', 'ageReport', 'getSlaSettings'].every((a) => !denied(t.call({ action: a, sheet: 'October' }, 'viewer'))));
  check('viewer: التصدير الخام مرفوض 403', t.call({ sheet: 'October' }, 'viewer').code === 403);
  check('viewer: refresh=1 مرفوض (يفتح مسار الحساب الثقيل)', t.call({ action: 'dashboard', sheet: 'October', refresh: '1' }, 'viewer').code === 403);
  check('viewer: debug=1 مرفوض', t.call({ action: 'dashboard', sheet: 'October', debug: '1' }, 'viewer').code === 403);
  check('viewer: diagnose* / build* / saveSlaSettings مرفوضة', ['diagnose', 'diagnoseStatuses', 'diagnoseJuneStatuses', 'buildSummary', 'buildQuarterSummaries', 'buildMissingSummaries', 'buildAgeSnapshot', 'saveSlaSettings'].every((a) => t.call(Object.assign({}, SLA, { action: a, sheet: 'October' }), 'viewer').code === 403));
  check('analyst: التصدير الخام وrefresh=1 مسموحان', !denied(t.call({ sheet: 'October' }, 'analyst')) && !denied(t.call({ action: 'dashboard', sheet: 'October', refresh: '1' }, 'analyst')));
  check('analyst: build*/saveSla/diagnose/debug مرفوضة', ['buildSummary', 'saveSlaSettings', 'diagnose'].every((a) => t.call(Object.assign({}, SLA, { action: a, sheet: 'October' }), 'analyst').code === 403) && t.call({ action: 'dashboard', sheet: 'October', debug: '1' }, 'analyst').code === 403);
  check('الإعدادات لم تتغير بعد محاولات viewer/analyst', !t.store.SLA_SETTINGS_JSON); }

// 4) admin: الكتابة عبر الويب مغلقة افتراضيًا (WEB_WRITES_ENABLED)
{ const t = make(); const r = t.call(SLA, 'admin'); check('admin: الكتابة عبر الويب مغلقة افتراضيًا ⇒ 403 web-writes-disabled', r.code === 403 && r.reason === 'web-writes-disabled', r);
  check('admin: القراءة والتشخيص مسموحان', !denied(t.call({ action: 'diagnose', sheet: 'October' }, 'admin')));
  check('admin (بريد بحروف كبيرة) يُطابَق بلا حساسية لحالة الأحرف', !denied(t.call({ action: 'listSheets' }, 'admin'))); }
{ const t = make({ WEB_WRITES_ENABLED: 'true' }); const r = t.call(SLA, 'admin');
  check('admin + تفعيل صريح: saveSlaSettings (الدالة الأصلية) تعمل', r.success === true);
  const s = vm.runInContext('saveSlaSettingsSafe_', t.sb);
  const run = (p) => s(p, 'abc123');
  check('الحفظ الآمن: يرفض 0 و 9999 و NaN وقيم فرع خارج النطاق', [run({ slaTargetDefault: '0' }), run({ slaTargetDefault: '9999' }), run({ slaTargetDefault: 'abc' }), run({ slaTargetDefault: '3', branchSlaTargets: JSON.stringify({ x: 500 }) }), run({ slaTargetDefault: '3', branchSlaTargets: '{bad' })].every((x) => x.success === false));
  const ok = run({ slaTargetDefault: '4', branchSlaTargets: JSON.stringify({ A: 2 }) });
  const hist = JSON.parse(t.store.SLA_SETTINGS_HISTORY || '[]');
  check('الحفظ الآمن: يسجّل قبل/بعد/من في التاريخ', ok.success === true && hist.length === 1 && hist[0].by === 'abc123' && hist[0].after.slaTargetDefault === 4 && hist[0].before.slaTargetDefault !== undefined, hist);
  for (let i = 0; i < 40; i++) run({ slaTargetDefault: String(1 + (i % 5)), branchSlaTargets: JSON.stringify({ ['فرع' + i]: 2 }) });
  check('التاريخ محدود (≤20 وأقل من 9KB)', JSON.parse(t.store.SLA_SETTINGS_HISTORY).length <= 20 && t.store.SLA_SETTINGS_HISTORY.length < 9000); }

// 5) وضع report: يسمح ويسجّل ما كان سيُرفض (لمرحلة الانتقال دون كسر المستخدمين)
{ const t = make({ AUTHZ_MODE: 'report' }); const r = t.call({ action: 'listSheets' });
  check('report: طلب بلا توكن يمرّ (لا كسر للمستخدمين الحاليين)', !denied(r));
  check('report: القرار المحجوب مسجّل deny:401', t.logs.some((l) => l.includes('[AUTHZ]') && l.includes('deny:401')));
  check('السجل لا يحتوي التوكن ولا البريد الصريح', !t.logs.some((l) => l.includes('xxxxxxxx') || l.includes('@'))); }

// 6) الكاش: التحقق لا يتكرر لنفس التوكن
{ const t = make(); t.call({ action: 'listSheets' }, 'viewer'); t.call({ action: 'listSheets' }, 'viewer'); t.call({ action: 'ageReport', sheet: 'October' }, 'viewer');
  check('التوكن الصالح يُتحقَّق منه مرة واحدة (كاش)', t.fetches() === 1, t.fetches()); }
// 7) وضع off لا يستدعي الشبكة ولا يغيّر الاستجابة
{ const a = make({ AUTHZ_MODE: 'off' }), c = make({ AUTHZ_MODE: 'off' }); const r1 = a.call({ action: 'getSlaSettings' }), r2 = JSON.parse(c.sb.doGetInner_({ parameter: { action: 'getSlaSettings' } }).s);
  check('off: الاستجابة مطابقة للدالة الأصلية ولا استدعاء شبكة', JSON.stringify(r1) === JSON.stringify(r2) && a.fetches() === 0); }

console.log(`\n${pass}/${pass + fail} اختبارًا ناجحًا`); process.exit(fail ? 1 : 0);
