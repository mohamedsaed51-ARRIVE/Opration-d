# Changelog

## [Unreleased] — تنظيم الأرشيف + فحص شامل (بدون تعديل كود)
### Added
- `README.md`, `CHANGELOG.md`, `docs/audit.md`.
- مجلد `archive/` يحوي 15 نسخة ZIP تاريخية (AllMonths, AllMonths-Fix, MgmtFix, MgmtReport, PdfImageFix, Reports-Rebuild, Arabic-Reports, Excel-Rotated, PDF-Arabic-Fix, PDF-RTL-Fix, PDF-Arabic-VERIFIED, Filters-V2-CompatFix, AllMonths-CompatFix, LiveFallback-Fix, Perf-Hotfix2).

### Changed
- لا شيء في `Code.gs` أو `index.html` — تم التأكد (MD5) أن نسخة الجذر مطابقة تماماً لآخر نسخة (`LiveFallback-Fix`)، وهي المعتمدة كما هي.

### Verified via code review (بدون تشغيل فعلي)
- White screen / error handling، Apps Script routing، listSheets caching، All Months live-fallback، Cache/Snapshot compatibility check، Filter AND/OR logic، Filter Cube compatibility، Topbar min/max date، PDF/Excel Arabic RTL support.
  انظر `docs/audit.md` للتفاصيل والأدلة (رقم السطر/الدالة لكل بند).

### Not verified (يتطلب بيئة حقيقية)
- التشغيل الفعلي على Google Apps Script المنشور، واختبارات 1–13 المطلوبة على بيانات حية.

## [Unreleased] — Production Debug: 3 إصلاحات حقيقية (انظر docs/production-debug-fixes.md)
### Fixed
- **Bug #1 (White Screen):** `init()` في `index.html` — كل استدعاء init*Handler أصبح معزولاً بـ try/catch، و`bootDashboard()` محمي بـ try/catch يستدعي `showGsheetError()` عند أي استثناء غير متوقع.
- **Bug #2 (Stale cache بدون تحذير):** إضافة `SUMMARY_CACHE_TTL_MS` (6 ساعات) و `isCacheFresh()`. `ensureMonthSummaryCached()` يعيد التحقق الحي عند تجاوز 6 ساعات (لأي شهر فردي أو All Months)، ويعرض تحذير `'stale'` واضح عند فشل التحقق الحي والاعتماد على كاش قديم.
- **Bug #3 (listSheets بدون قفل تزامن):** `listSheetsPayload()` في `Code.gs` أصبح يستخدم `LockService.getScriptLock()` عند Cache Miss، مع إعادة فحص الكاش بعد الحصول على القفل، و`buildSheetsListAndCache_()` الجديدة تحمل منطق البناء نفسه دون تغيير.

### Verified (Code-level tests فقط — انظر التقرير للتفاصيل)
TEST 1–8 كلها PASSED (منطق منسوخ حرفياً من الملفات الحقيقية + Mocks لـ Node.js)، بالإضافة إلى Syntax Check لكلا الملفين.

### Not verified
- لا يوجد Live Apps Script Validation ولا اختبار متصفح حقيقي — انظر قسم "ما لم أستطع اختباره" في `docs/production-debug-fixes.md` والخطوات المطلوبة من Mohamed هناك.
