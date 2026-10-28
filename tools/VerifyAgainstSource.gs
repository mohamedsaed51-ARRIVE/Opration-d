// ============================================================
// ARRIVE — أداة مطابقة الداش بورد مع الشيت الخام (قراءة فقط)
// ============================================================
// الاستخدام: الصق هذا الملف كملف إضافي في مشروع Apps Script نفسه (بجانب Code.gs) ثم شغّل من المحرر:
//     verifyOctober()                       ← شهر كامل
//     verifyMonthAgainstSource('October', { branch: 'فرع الهرم' })
//     verifyMonthAgainstSource('October', { dateFrom: '2026-10-01', dateTo: '2026-10-10' })
// ثم افتح «Execution log». الأداة:
//   • لا تكتب في أي شيت ولا تغيّر Properties/Cache ولا تحذف شيئًا (قراءة فقط).
//   • تعيد حساب الأرقام من الصفوف الخام بمنطق مستقل (حذف التكرار + التصنيف + التجميع) ولا تستدعي دوال حساب الداش بورد.
//   • تقارن النتيجة بالملخص المحفوظ (DASHBOARD_SUMMARY) وبالحساب الحي للداش بورد، وتطبع الفروق.
//   • لا تطبع أسماء عملاء أو أرقام موبايل — أعدادًا وأسماء فروع وحالات فقط.
// قواعد العمل المُطبّقة (كما في CHANGELOG): حذف تكرار رقم البوليصة مع الإبقاء على الأحدث بتاريخ «اخر حالة»؛
// الرفض من «الحالة النهائية» فقط (تحتوي «رفض») وتسبق حالة الشحنة؛ التسليم = «تسليم ناجح»؛ قيد التشغيل = «قيد التشغيل»؛
// المرتجع = حالة تحتوي «مرتجع» (مغلق/مفتوح/معلق) أو «مرتجعات»؛ غير ذلك = غير مصنف (يدخل في الإجمالي).
// النسب: التسليم = التسليمات ÷ الإجمالي؛ المرتجع والرفض = العدد ÷ (الإجمالي − قيد التشغيل).

function verifyOctober() { return verifyMonthAgainstSource('October', {}); }

function verifyMonthAgainstSource(month, opts) {
  opts = opts || {};
  var out = { month: month, opts: opts, checks: [], notes: [] };
  var q = MONTH_SOURCE[month];
  if (!q) throw new Error('شهر غير معروف: ' + month);
  var sh = SpreadsheetApp.openById(SPREADSHEET_IDS[q]).getSheetByName(month);
  if (!sh) throw new Error('الشيت غير موجود: ' + month);
  var last = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (last < 2) { Logger.log('الشيت فارغ'); return out; }
  var values = sh.getRange(1, 1, last, lastCol).getValues();
  var H = values[0].map(function (h) { return String(h).replace(/\s+/g, ' ').trim(); });
  function col(names) { for (var i = 0; i < names.length; i++) { var ix = H.indexOf(names[i]); if (ix >= 0) return ix; } return -1; }
  var C = {
    awb: col(['رقم البوليصة']), branch: col(['فرع المنطقة']), status: col(['حالة الشحنة']), fin: col(['الحالة النهائية']),
    pickup: col(['تاريخ استلام البيك أب']), last: col(['تاريخ اخر حالة'])
  };
  Object.keys(C).forEach(function (k) { if (C[k] < 0) throw new Error('عمود غير موجود: ' + k); });

  function norm(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[ً-ٟـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim();
  }
  function has(n, w) { return n.indexOf(norm(w)) !== -1; }
  function classify(status, fin) {
    var f = norm(fin), s = norm(status);
    if (f && has(f, 'رفض')) return 'rejected';
    if (!s) return 'unknown';
    if (s === norm('تسليم ناجح') || s === norm('التسليم ناجح')) return 'delivered';
    if (s === norm('قيد التشغيل')) return 'pending';
    if (has(s, 'مرتجع') || has(s, 'رجيع')) {
      if (has(s, 'معلق')) return 'returned';
      if (has(s, 'مفتوح')) return 'returned';
      if (s === norm('مرتجعات') || has(s, 'مغلق')) return 'returned';
    }
    return 'unknown';
  }
  function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
  function iso(d) { return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Africa/Cairo', 'yyyy-MM-dd'); }

  // 1) جودة الصفوف الخام
  var rawRows = values.length - 1, blankAwb = 0, textPickup = 0, invalidPickup = 0, textLast = 0, invalidLast = 0;
  var map = {};
  for (var r = 1; r < values.length; r++) {
    var row = values[r], awb = String(row[C.awb] === null || row[C.awb] === undefined ? '' : row[C.awb]).trim();
    var pk = row[C.pickup], ls = row[C.last];
    if (typeof pk === 'string' && pk.trim()) textPickup++;
    if (!isDate(pk)) invalidPickup++;
    if (typeof ls === 'string' && ls.trim()) textLast++;
    if (!isDate(ls)) invalidLast++;
    if (!awb) { blankAwb++; continue; }
    var t = isDate(ls) ? ls.getTime() : -Infinity;
    var ex = map[awb];
    if (!ex || t >= ex.t) map[awb] = { t: t, row: row };
  }
  var distinct = Object.keys(map).length;

  // 2) الفلاتر (اختيارية)
  var from = opts.dateFrom ? new Date(opts.dateFrom + 'T00:00:00') : null;
  var to = opts.dateTo ? new Date(opts.dateTo + 'T23:59:59') : null;
  var acc = { total: 0, delivered: 0, returned: 0, rejected: 0, pending: 0, unknown: 0 }, byBranch = {}, statusCounts = {}, unknownStatuses = {};
  Object.keys(map).forEach(function (a) {
    var row = map[a].row;
    var br = String(row[C.branch] || '').replace(/\s+/g, ' ').trim();
    if (opts.branch && br !== opts.branch) return;
    var pk = row[C.pickup];
    if (from || to) {
      if (!isDate(pk)) return;
      if (from && pk < from) return;
      if (to && pk > to) return;
    }
    var kind = classify(row[C.status], row[C.fin]);
    acc.total++; acc[kind]++;
    var b = byBranch[br] = byBranch[br] || { total: 0, delivered: 0, returned: 0, rejected: 0, pending: 0, unknown: 0 };
    b.total++; b[kind]++;
    var st = norm(row[C.status]) || '(فارغ)';
    statusCounts[st] = (statusCounts[st] || 0) + 1;
    if (kind === 'unknown') unknownStatuses[st] = (unknownStatuses[st] || 0) + 1;
  });
  var eligible = acc.total - acc.pending;
  var rates = {
    deliveryRate: acc.total ? acc.delivered / acc.total * 100 : null,
    returnRate: eligible ? acc.returned / eligible * 100 : null,
    rejectedRate: eligible ? acc.rejected / eligible * 100 : null
  };

  // 3) مقارنة بالداش بورد (الحي + المحفوظ)
  var params = { refresh: '1' };
  if (opts.branch) params.filters = JSON.stringify({ branch: [opts.branch] });
  if (opts.dateFrom) params.dateFrom = opts.dateFrom;
  if (opts.dateTo) params.dateTo = opts.dateTo;
  var live = null, saved = null;
  try { live = getMonthDashboardSummary(month, params); } catch (e) { out.notes.push('تعذر الحساب الحي: ' + e.message); }
  try { if (!opts.branch && !opts.dateFrom && !opts.dateTo) saved = getSavedMonthSummary_(month); } catch (e2) { out.notes.push('تعذر قراءة الملخص المحفوظ: ' + e2.message); }
  function cmp(label, mine, theirs, tol) {
    var ok = (theirs !== undefined && theirs !== null) && Math.abs(mine - theirs) <= (tol || 0);
    out.checks.push({ item: label, independent: mine, dashboard: theirs === undefined ? null : theirs, diff: (theirs === undefined || theirs === null) ? null : mine - theirs, ok: ok });
  }
  [['الحي', live], ['المحفوظ', saved]].forEach(function (p) {
    var s = p[1]; if (!s || !s.kpis) return; var k = s.kpis, tag = '[' + p[0] + '] ';
    cmp(tag + 'الإجمالي (شحنات فريدة)', acc.total, k.total);
    cmp(tag + 'التسليمات', acc.delivered, k.delivered);
    cmp(tag + 'المرتجعات', acc.returned, k.returned);
    cmp(tag + 'الرفض', acc.rejected, k.rejected);
    cmp(tag + 'قيد التشغيل', acc.pending, k.pending);
    cmp(tag + 'غير مصنف', acc.unknown, k.unknown);
    if (rates.returnRate !== null) cmp(tag + 'نسبة المرتجعات %', rates.returnRate, k.returnRate, 1e-6);
    if (rates.rejectedRate !== null) cmp(tag + 'نسبة الرفض %', rates.rejectedRate, k.rejectedRate, 1e-6);
    if (!opts.branch && !opts.dateFrom && !opts.dateTo && rates.deliveryRate !== null) cmp(tag + 'نسبة التسليم %', rates.deliveryRate, k.deliveryRate, 1e-6);
    (s.branchSummary || []).forEach(function (bs) {
      var m = byBranch[bs.name]; if (!m) { out.checks.push({ item: tag + 'فرع غير موجود في الحساب المستقل: ' + bs.name, independent: null, dashboard: bs.shipments, diff: null, ok: false }); return; }
      cmp(tag + 'فرع ' + bs.name + ' — الشحنات', m.total, bs.shipments);
      cmp(tag + 'فرع ' + bs.name + ' — التسليمات', m.delivered, bs.delivered);
    });
  });
  if (live && live.dataQuality) {
    cmp('[الحي] عدد الصفوف الخام', rawRows, live.totalRows);
  }

  out.raw = { rawRows: rawRows, blankAwb: blankAwb, distinctAwb: distinct, duplicateRowsRemoved: rawRows - blankAwb - distinct, pickupNotDate: invalidPickup, pickupTextValues: textPickup, lastStatusNotDate: invalidLast, lastStatusTextValues: textLast };
  out.independent = acc; out.rates = rates; out.unknownStatuses = unknownStatuses;
  var bad = out.checks.filter(function (c) { return !c.ok; });
  var lines = [];
  lines.push('==== مطابقة ' + month + ' ====  الفلاتر: ' + JSON.stringify(opts));
  lines.push('الصفوف الخام: ' + rawRows + ' | بدون رقم بوليصة: ' + blankAwb + ' | بوليصات فريدة: ' + distinct + ' | تكرار محذوف: ' + out.raw.duplicateRowsRemoved);
  lines.push('تاريخ البيك أب غير صالح/فارغ: ' + invalidPickup + ' (نصية: ' + textPickup + ') | تاريخ آخر حالة غير صالح/فارغ: ' + invalidLast + ' (نصية: ' + textLast + ')');
  lines.push('المستقل: ' + JSON.stringify(acc) + ' | نسب: ' + JSON.stringify(rates));
  lines.push('حالات غير مصنفة: ' + JSON.stringify(unknownStatuses));
  lines.push('عدد الفحوصات: ' + out.checks.length + ' | غير مطابق: ' + bad.length);
  bad.forEach(function (c) { lines.push('  ✗ ' + c.item + ' | مستقل=' + c.independent + ' | داش بورد=' + c.dashboard + ' | فرق=' + c.diff); });
  if (!bad.length) lines.push('  ✓ كل الفحوصات مطابقة');
  out.notes.forEach(function (n) { lines.push('ملاحظة: ' + n); });
  Logger.log(lines.join('\n'));
  return out;
}
