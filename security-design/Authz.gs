// ============================================================
// Authz.gs — طبقة التفويض المقترحة لـ Opration-d  (نموذج أولي — غير منشور)
// ------------------------------------------------------------
// لا يُفعَّل شيء إلا بإضافة هذا الملف للمشروع وتغيير doGet إلى:
//     function doGet(e) { var d = authzGate_(e); return d ? jsonResponse(d) : doGetInner_(e); }
// (وإعادة تسمية doGet الحالية إلى doGetInner_). الوضع الافتراضي AUTHZ_MODE=off ⇒ لا تغيير في السلوك.
// الأوضاع:  off = لا شيء | report = يسجّل ما كان سيُرفض ويسمح | enforce = يرفض.
// ============================================================
var AUTHZ_ROLE_RANK = { none: 0, viewer: 1, analyst: 2, admin: 3 };

// سياسة كل action. أي action غير مذكور يُرفض (deny by default) في وضع enforce.
var AUTHZ_POLICY = {
  listSheets: 'viewer', dashboard: 'viewer', ageReport: 'viewer', getSlaSettings: 'viewer',
  '(raw)': 'analyst',                       // ?sheet=X بلا action = تصدير الصفوف الخام
  diagnose: 'admin', diagnoseStatuses: 'admin', diagnoseJuneStatuses: 'admin',
  saveSlaSettings: 'admin', buildSummary: 'admin', buildQuarterSummaries: 'admin',
  buildMissingSummaries: 'admin', buildAgeSnapshot: 'admin'
};
var AUTHZ_WRITE_ACTIONS = { saveSlaSettings: 1, buildSummary: 1, buildQuarterSummaries: 1, buildMissingSummaries: 1, buildAgeSnapshot: 1 };
var AUTHZ_SLA_MIN = 0.5, AUTHZ_SLA_MAX = 30, AUTHZ_MAX_BRANCH_OVERRIDES = 300;

function authzProp_(k) { try { return PropertiesService.getScriptProperties().getProperty(k) || ''; } catch (e) { return ''; } }
function authzMode_() { var m = authzProp_('AUTHZ_MODE'); return (m === 'report' || m === 'enforce') ? m : 'off'; }

function authzActionKey_(p) {
  var a = p && p.action;
  if (a) return a;
  return (p && p.sheet) ? '(raw)' : '(none)';
}

// الدور الأدنى المطلوب للطلب (يشمل المعاملات الثقيلة refresh/debug)
function authzRequiredRole_(p) {
  var need = AUTHZ_POLICY[authzActionKey_(p)] || 'admin';
  if (p && (p.debug === '1' || p.debug === 'true')) need = 'admin';
  else if (p && (p.refresh === '1' || p.refresh === 'true') && AUTHZ_ROLE_RANK[need] < AUTHZ_ROLE_RANK.analyst) need = 'analyst';
  return need;
}

function authzSha256_(s) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s);
  return d.map(function (b) { return ((b < 0 ? b + 256 : b)).toString(16).padStart(2, '0'); }).join('');
}

// تحقق من Google ID token. يعيد {ok, email, reason}.
function authzVerifyIdToken_(token) {
  if (!token || typeof token !== 'string' || token.length < 100 || token.length > 4096) return { ok: false, reason: 'no-token' };
  var cache = CacheService.getScriptCache(), key = 'tok_' + authzSha256_(token);
  var hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* fall through */ } }
  var resp;
  try {
    resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  } catch (e) { return { ok: false, reason: 'verify-unavailable' }; }
  if (resp.getResponseCode() !== 200) return { ok: false, reason: 'invalid-token' };
  var t; try { t = JSON.parse(resp.getContentText()); } catch (e) { return { ok: false, reason: 'invalid-token' }; }
  var clientId = authzProp_('OAUTH_CLIENT_ID');
  if (!clientId || t.aud !== clientId) return { ok: false, reason: 'bad-audience' };
  if (String(t.email_verified) !== 'true' || !t.email) return { ok: false, reason: 'email-unverified' };
  var exp = Number(t.exp) || 0, now = Math.floor(Date.now() / 1000);
  if (exp <= now) return { ok: false, reason: 'expired' };
  var hd = authzProp_('ALLOWED_HD'); if (hd && t.hd !== hd) return { ok: false, reason: 'wrong-domain' };
  var out = { ok: true, email: String(t.email).toLowerCase() };
  cache.put(key, JSON.stringify(out), Math.max(1, Math.min(300, exp - now)));
  return out;
}

// الأدوار: خريطة بريد -> دور من خاصية ACCESS_JSON (أو ورقة ACCESS في ملف إداري منفصل — انظر التصميم).
function authzRoleFor_(email) {
  var raw = authzProp_('ACCESS_JSON'), map = {};
  try { map = raw ? JSON.parse(raw) : {}; } catch (e) { map = {}; }
  var r = map[String(email).toLowerCase()];
  return AUTHZ_ROLE_RANK.hasOwnProperty(r) ? r : 'none';
}

function authzToken_(e) {
  var p = (e && e.parameter) || {};
  if (p.idToken) return p.idToken;
  try { if (e && e.postData && e.postData.contents) return JSON.parse(e.postData.contents).idToken || ''; } catch (x) { /* ignore */ }
  return '';
}

function authzDeny_(code, reason) { return { success: false, error: code === 401 ? 'unauthorized' : 'forbidden', code: code, reason: reason }; }

// يعيد null للسماح، أو كائن رفض. لا يسرّب أي بيانات.
function authzGate_(e) {
  var mode = authzMode_();
  if (mode === 'off') return null;
  var p = (e && e.parameter) || {}, action = authzActionKey_(p), need = authzRequiredRole_(p);
  var v = authzVerifyIdToken_(authzToken_(e)), role = v.ok ? authzRoleFor_(v.email) : 'none', denial = null;
  if (!v.ok) denial = authzDeny_(401, v.reason);
  else if (AUTHZ_ROLE_RANK[role] < AUTHZ_ROLE_RANK[need]) denial = authzDeny_(403, 'role');
  else if (AUTHZ_WRITE_ACTIONS[action] && authzProp_('WEB_WRITES_ENABLED') !== 'true') denial = authzDeny_(403, 'web-writes-disabled');
  // سجل بلا بيانات حساسة: هاش البريد فقط
  console.log('[AUTHZ] ' + JSON.stringify({ mode: mode, action: action, need: need, role: role, who: v.ok ? authzSha256_(v.email).slice(0, 12) : null, decision: denial ? ('deny:' + denial.code + ':' + denial.reason) : 'allow' }));
  if (denial && mode === 'enforce') return denial;
  return null;
}

// حفظ إعدادات SLA بقيود وتاريخ تدقيق (يُستدعى بدل saveSlaSettingsPayload من مسار الويب أو القائمة)
function saveSlaSettingsSafe_(params, actorHash) {
  var t = Number(params && params.slaTargetDefault);
  if (!(t >= AUTHZ_SLA_MIN && t <= AUTHZ_SLA_MAX)) return { success: false, error: 'قيمة SLA خارج النطاق المسموح' };
  var b = {}; try { b = params.branchSlaTargets ? JSON.parse(params.branchSlaTargets) : {}; } catch (e) { return { success: false, error: 'branchSlaTargets غير صالح' }; }
  var keys = Object.keys(b);
  if (keys.length > AUTHZ_MAX_BRANCH_OVERRIDES) return { success: false, error: 'عدد التجاوزات كبير' };
  for (var i = 0; i < keys.length; i++) { var v = Number(b[keys[i]]); if (!(v >= AUTHZ_SLA_MIN && v <= AUTHZ_SLA_MAX)) return { success: false, error: 'قيمة SLA لفرع خارج النطاق' }; }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { success: false, error: 'النظام مشغول، أعد المحاولة' };
  try {
    var before = getPersistedSlaSettings_();
    var res = saveSlaSettingsPayload(params);
    if (res && res.success) {
      var props = PropertiesService.getScriptProperties(), h = [];
      try { h = JSON.parse(props.getProperty('SLA_SETTINGS_HISTORY') || '[]'); } catch (e) { h = []; }
      h.push({ at: new Date().toISOString(), by: actorHash || 'menu', before: before, after: { slaTargetDefault: res.slaTargetDefault, branchSlaTargets: res.branchSlaTargets } });
      h = h.slice(-20); while (h.length > 1 && JSON.stringify(h).length > 8000) h.shift(); // حد خاصية Script Properties ≈ 9KB للقيمة
      props.setProperty('SLA_SETTINGS_HISTORY', JSON.stringify(h));
    }
    return res;
  } finally { lock.releaseLock(); }
}
