// يتحقق من سلوك نقطة Google العامة tokeninfo مع توكنات مشوّهة (لا حسابات ولا أسرار ولا موارد إنتاج): يجب أن تُرفض كلها بـ401 من طبقة التفويض.
// يُتخطى (SKIP) تلقائيًا إن لم تتوفر الشبكة. التشغيل: node tests/authz-live-tokeninfo.test.js
const fs = require('fs'), vm = require('vm'), path = require('path'), { execFileSync } = require('child_process'), crypto = require('crypto');
const A = fs.readFileSync(path.join(__dirname, '..', 'security-design', 'Authz.gs'), 'utf8');
let pass = 0, fail = 0; const check = (n, c, e) => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + ' - ' + n + (c || e === undefined ? '' : ' ' + JSON.stringify(e).slice(0, 200))); };
const store = { AUTHZ_MODE: 'enforce', OAUTH_CLIENT_ID: 'x.apps.googleusercontent.com', ACCESS_JSON: '{}' }, cache = {}; let calls = [];
const sb = { console: { log() {} }, Date, Math, JSON, Object, Number, String, Array, Set, encodeURIComponent, decodeURIComponent,
  Utilities: { DigestAlgorithm: { SHA_256: 's' }, computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(String(s)).digest()).map((x) => x > 127 ? x - 256 : x) },
  CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => store[k] || null }) },
  UrlFetchApp: { fetch: (url) => { calls.push(url); const out = execFileSync('curl', ['-sS', '-m', '15', '-o', '/dev/null', '-w', '%{http_code}', url], { stdio: ['ignore', 'pipe', 'pipe'] }); return { getResponseCode: () => Number(out.toString()), getContentText: () => '{}' }; } } };
vm.createContext(sb); vm.runInContext(A, sb);
try { execFileSync('curl', ['-sS', '-m', '8', '-o', '/dev/null', 'https://oauth2.googleapis.com/tokeninfo?id_token=probe'], { stdio: 'ignore' }); } catch (e) { console.log('SKIP - لا اتصال بـ oauth2.googleapis.com'); process.exit(0); }
const toks = ['x'.repeat(150), 'aaa.bbb.ccc' + 'd'.repeat(120), Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from('{"aud":"x.apps.googleusercontent.com","email":"a@b.c","email_verified":"true","exp":9999999999}').toString('base64url') + '.' + 'z'.repeat(60)];
toks.forEach((t, i) => { const r = vm.runInContext('authzVerifyIdToken_(' + JSON.stringify(t) + ')', sb); check('توكن مشوّه #' + (i + 1) + ' (بما فيه alg=none مزوَّر): Google ترفضه ⇒ ok=false (invalid-token)', r.ok === false && r.reason === 'invalid-token', r); });
check('تم استدعاء نقطة Google الحقيقية فعلًا', calls.length === 3 && calls.every((u) => u.startsWith('https://oauth2.googleapis.com/tokeninfo?id_token=')), calls.length);
console.log(`\n${pass}/${pass + fail} اختبارًا ناجحًا`); process.exit(fail ? 1 : 0);
