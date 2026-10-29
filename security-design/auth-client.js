/* auth-client.js — جانب المتصفح لطبقة التفويض (نموذج أولي — غير موصول بـ index.html).
 * يعتمد Google Identity Services (google.accounts.id). لا يخزّن التوكن في localStorage (ذاكرة فقط) ولا يسجّله.
 *   ArriveAuth.init({ clientId, onState })     state: 'signedOut' | 'signedIn' | 'forbidden' | 'error'
 *   ArriveAuth.fetchJson(url, opts)            يضيف idToken، ويعالج 401 (تجديد ثم إعادة محاولة واحدة) و403 (رفض بلا إعادة)
 * رد Apps Script يظل HTTP 200؛ الرفض يأتي في JSON: {success:false, code:401|403, reason}.
 */
(function (global) {
  'use strict';
  var S = { token: null, exp: 0, clientId: '', onState: function () {}, pending: null, timer: null };

  function parseExp(jwt) {
    try { var p = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return Number(p.exp) || 0; } catch (e) { return 0; }
  }
  function setState(s, detail) { try { S.onState(s, detail || null); } catch (e) { /* واجهة المستخدم لا تكسر المسار */ } }
  function nowSec() { return Math.floor(Date.now() / 1000); }
  function valid(skew) { return !!S.token && S.exp - (skew || 0) > nowSec(); }

  function onCredential(resp) {
    var t = resp && resp.credential;
    if (!t) return fail();
    S.token = t; S.exp = parseExp(t);
    if (S.pending) { var p = S.pending; S.pending = null; p.resolve(t); }
    schedule(); setState('signedIn');
  }
  function fail() { S.token = null; S.exp = 0; if (S.pending) { var p = S.pending; S.pending = null; p.reject(new Error('signin-failed')); } setState('signedOut'); }

  function schedule() {            // تجديد صامت قبل الانتهاء بدقيقتين
    if (S.timer) clearTimeout(S.timer);
    var ms = (S.exp - 120 - nowSec()) * 1000;
    if (S.exp && ms > 0) S.timer = setTimeout(function () { refresh().catch(function () {}); }, Math.min(ms, 2147483000));
  }

  function refresh() {             // يطلب توكنًا جديدًا (طلب واحد في نفس الوقت)
    if (S.pending) return S.pending.promise;
    var p = {}; p.promise = new Promise(function (res, rej) { p.resolve = res; p.reject = rej; }); S.pending = p;
    try { global.google.accounts.id.prompt(function (n) { if (n && (n.isNotDisplayed && n.isNotDisplayed() || n.isSkippedMoment && n.isSkippedMoment()) && S.pending === p) fail(); }); }
    catch (e) { fail(); }
    return p.promise;
  }

  function AuthError(code, reason) { var e = new Error('auth-' + code); e.name = 'AuthError'; e.code = code; e.reason = reason || ''; return e; }

  function send(url, opts, token) {
    var u = new URL(url, global.location && global.location.href); u.searchParams.set('idToken', token);
    return global.fetch(u.toString(), opts).then(function (r) { return r.text(); }).then(function (t) { return JSON.parse(t); });
  }

  function fetchJson(url, opts) {
    var step = valid(30) ? Promise.resolve(S.token) : refresh();
    return step.then(function (tok) {
      return send(url, opts, tok).then(function (j) {
        if (j && j.success === false && j.code === 401) {              // انتهت الجلسة/رفض التوكن ⇒ تجديد مرة واحدة
          S.token = null; S.exp = 0;
          return refresh().catch(function () { throw AuthError(401, 'refresh-failed'); }).then(function (t2) { return send(url, opts, t2); }).then(function (j2) {
            if (j2 && j2.success === false && j2.code === 401) { setState('signedOut'); throw AuthError(401, j2.reason); }
            return finish(j2);
          });
        }
        return finish(j);
      });
    }, function () { throw AuthError(401, 'signed-out'); });
  }
  function finish(j) {
    if (j && j.success === false && j.code === 403) { setState('forbidden', j.reason); throw AuthError(403, j.reason); }
    return j;
  }

  function init(o) {
    S.clientId = o.clientId; S.onState = o.onState || S.onState;
    global.google.accounts.id.initialize({ client_id: o.clientId, callback: onCredential, auto_select: true });
    setState('signedOut');
  }
  function signOut() { S.token = null; S.exp = 0; if (S.timer) clearTimeout(S.timer); try { global.google.accounts.id.disableAutoSelect(); } catch (e) {} setState('signedOut'); }

  global.ArriveAuth = { init: init, fetchJson: fetchJson, signOut: signOut, _state: S, _parseExp: parseExp };
})(typeof window !== 'undefined' ? window : this);
