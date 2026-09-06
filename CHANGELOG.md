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

## [Unreleased] — Bug #4: تعامل الفلاتر الفارغة (`branch:[""]`) كفلتر حقيقي (انظر docs/production-debug-fixes.md)
### Fixed
- **Bug #4 (مؤكَّد بـ Diagnostic إنتاج فعلي):** `summaryParseFilters()` في `Code.gs` أصبحت تُعيد `sanitizeFilters_(filters)` بدل `filters` الخام. دالة جديدة `sanitizeFilters_()` تحذف من كل بُعد القيم `""`/فراغ فقط/`null`/`undefined` (مع الحفاظ على `0`/`false`/أي قيمة حقيقية أخرى كما هي). إصلاح جانبي: فحص `hasServerFilters` للمُعامل القديم `params.branch` أصبح يستخدم `summaryNormText(params.branch)` بدل القيمة الخام. هذه نقطة عنق واحدة تغطي تلقائياً: `hasServerFilters` في كلا الدالتين، Filter Cube، `summaryRowMatchesFilters`، ومسار All Months المفلتر لكل شهر.

### Verified (Code-level — نُفِّذت فعلياً بالكود الحقيقي المنسوخ من Code.gs)
- كل أمثلة التطبيع الثمانية من الطلب + الاختبارات الثلاثة المطلوبة (Request A مقابل B، فلاتر متعددة فارغة، فلتر مختلط Cairo) + اختبار عدم-Regression لـ `dateFrom` — كلها PASSED. Syntax Check PASSED.

### Not verified
- لا يوجد Live Google Validation لرقم `total` الفعلي (870509) — يتطلب تنفيذ Mohamed لنفس أداة التشخيص بعد رفع `Code.gs`.
- لم يُعثر على مسار Frontend حالي يُنتج فعلياً `filters:{branch:[""]}` (كل المسارات المفحوصة محمية بالفعل) — لم يُعدَّل أي شيء في `index.html` لعدم وجود دليل.

## [Unreleased] — Bug #5: أداء August (aggregatePassMs) — انظر docs/production-debug-fixes.md
### Fixed
- **Bug #5 (أداء، مؤكَّد بحساب رياضي من القياس الفعلي):** `getMonthDashboardSummary()` في `Code.gs` — دالة جديدة `formatDayKeyCached(d)` تحفظ نتيجة `Utilities.formatDate` بمفتاح "ساعة UTC" بدل استدعائها لكل صف. استبدال استدعاءي `Utilities.formatDate` داخل حلقة الـ aggregate (لـ `dayKey` و `cubeDayKey`) بالدالة الجديدة. لا تغيير في أي رقم Summary/KPI/فلتر/All Months.

### Verified (Code-level — بمنسّق توقيت Intl حقيقي على Africa/Cairo، وليس Mock مبسّط)
- 106,767 صف اختبار (شاملة نافذة 22:00–24:00 UTC الحرجة) → صفر اختلاف في القيمة الناتجة، وانخفاض استدعاءات `Utilities.formatDate` الحقيقية من 106,767 إلى 744 (99.30%-). اكتُشف وأُصلح Bug حقيقي في محاولة أولى بنسخة Cache يومية (بدل الساعة) أثناء هذا الاختبار نفسه، قبل وصولها لملف الإنتاج.
- كل اختبارات Bug #1–#4 السابقة أُعيد تشغيلها: لا Regression.

### Not verified
- الرقم الفعلي الحقيقي لـ `aggregatePassMs` بعد الإصلاح على August — يتطلب رفع الكود وتشغيل نفس أداة التشخيص. September–December: لا تغيير، بناءً على توجيه صريح بحصر النطاق في August فقط.

## [Unreleased] — Bug #6: كاش All Months قديم + بناء Snapshots April-August + تمييز الشهور الفارغة (انظر docs/production-debug-fixes.md)
### Fixed
- **Cache Invalidation:** `getSnapshotGenerationStamp_()`/`bumpSnapshotGenerationStamp_()` [جديدتان] في `Code.gs` — طابع نسخة يُخزَّن في PropertiesService، يُحدَّث مرة واحدة داخل `saveMonthSummary_()` بعد كل حفظ ناجح، ويدخل الآن في مفتاح الكاش لكل من `getMonthDashboardSummary` و `getAllMonthsDashboardSummary`. بناء أي Snapshot جديد يُبطل تلقائياً كل نتيجة مخزَّنة سابقاً، بدل انتظار انتهاء TTL (5 دقائق).
- **`buildMissingMonthSnapshots()` [جديدة]:** تبني فقط الشهور بلا Snapshot متوافق (أبريل-أغسطس حالياً)، تتخطى يناير-مارس تماماً. تعيد استخدام `buildAndSaveMonthSummary()` الموجودة أصلاً بدون أي بنية موازية. متاحة عبر قائمة الشيت وعبر `action=buildMissingSummaries`.
- **`renderAllMonthsCompletenessWarning()` في `index.html`:** أصبحت تُميّز شهراً فارغاً (رسالة محايدة رمادية، بدون ⚠، تُحسب ديناميكياً من آخر شهر متضمن) عن شهر فاشل فعلياً (نفس التحذير الكهرماني ⚠ كما كان).

### Verified (Code-level)
- منطق تصنيف emptyMonths/missingSnapshotMonths/partial في `getAllMonthsDashboardSummary` **لم يتغيّر** — تحقّقت بمحاكاة الحالة المطلوبة (Jan-Aug snapshot، Sep-Dec empty) أنه يُنتج `includedMonths=[Jan..Aug], emptyMonths=[Sep..Dec], partial=false` بالضبط، أي أنه كان صحيحاً من الأساس.
- اختبارات Cache-Invalidation، buildMissingMonthSnapshots، والبانر — كلها PASSED (Code-level، Mocks). Syntax Check PASSED. لا Regression على اختبارات Bug #1-#5.

### Not verified
- الرقم الفعلي الحقيقي (870509) والأداء الفعلي بعد بناء الـ Snapshots — يتطلب تنفيذ Mohamed لخطوات النشر والبناء الموثّقة في production-debug-fixes.md.

## [Unreleased] — ميزة جديدة: تنبيهات نشاط العملاء ومخاطر انخفاض الطلبات (PDF) — انظر docs/production-debug-fixes.md
### Added
- صفحة PDF جديدة "تنبيهات نشاط العملاء ومخاطر انخفاض الطلبات" داخل `mgmtGenerateExecutivePdfReport()` (بعد صفحة "حركة العملاء" الموجودة، قبل "التوصيات الإدارية").
- `mgmtClassifyCustomerRisk()`, `mgmtPreviousCalendarMonth()` [دالتان جديدتان، منطق خالص قابل للاختبار بمعزل عن jsPDF/DOM]، `CUSTOMER_ALERT_MIN_PREVIOUS_ORDERS` [ثابت جديد = 20].
- يقارن الشهر الحالي (آخر شهر في فترة تقرير الإدارة) مقابل الشهر التقويمي السابق مباشرة (يُحمَّل عند الحاجة عبر `mgmtEnsureMonthsLoaded()` الموجودة أصلاً)، يعيد استخدام `mgmtBuildSeries('client', ...)` الموجودة أصلاً — بدون أي تعديل في `Code.gs`.

### Verified (Code-level — 21 تأكيداً)
- كل حدود الشرائح (Stopped/Mild/Significant/Critical) مُختبرة بدقة عند القيم الحدّية بالضبط (10%، 25%، 50%). عميل جديد مُستبعَد تماماً، عميل تحت الحد الأدنى مُستبعَد حتى لو توقف، لا احتساب مزدوج، الفرز صحيح. Syntax Check PASSED. لا Regression على Bug #1-#6.

### Not verified
- لا اختبار بصري فعلي لملف PDF الناتج ولا اختبار على بيانات حقيقية — يتطلب تشغيل Mohamed للتقرير من الداشبورد الفعلي.

## [Unreleased] — Audit شامل: June + SLA End-Date Priority + Unknown Status Breakdown + Arabic Normalization (انظر docs/production-debug-fixes.md)
### Fixed
- **Bug #7:** `unknownStatusBreakdown` [حقل جديد] — تفاصيل كل حالة غير مصنفة (عدد + نسبة)، بدل رقم إجمالي مبهم.
- **Bug #8:** `summaryNormalizeArabicForMatch_()` [جديدة] — تطبيع فروق إملائية عربية (أ/إ/آ، ى، ة) عند مقارنة/تصنيف الحالة فقط، بدون تغيير القيمة المعروضة أو اختراع Mapping جديد.
- **Bug #9:** أولوية `Delivery Date` على `Last Status Date` في حساب SLA (Fallback فقط لو الشحنة Delivered وبلا Delivery Date). عمود `delivery` أُضيف كـ Alias تجريبي يحتاج تأكيد الاسم الحقيقي. عداد `missingSlaData` جديد.
- **تصحيح ذاتي حرج:** أول محاولة لـ Bug #9 كسرت `attemptCat` (ميزة Attempt Category الموجودة، تُطبَّق على كل الصفوف) عن طريق الخطأ. اكتُشف وأُصلح قبل التسليم — `attemptDays`/`attemptCat` الآن منفصلان تماماً عن `slaDays` الجديد.
- تحسين `diagnoseMonth` ليشمل حالة الـ Snapshot المباشرة (موجود/فارغ/متوافق) لأي شهر.
- SLA Explanation Tooltip مُضاف أعلى تبويب SLA بالواجهة (Section 9).

### Verified (Code-level)
- All Months Weighted Calculation (Section 11): تحقّقت أنه صحيح أصلاً، بدون تعديل.
- Hardcoded Month List (Section 12): تحقّقت أنه لا يوجد Bug عملي (12 شهراً كاملة مُعرَّفة دائماً).
- اختبار مخصص أثبت أن `attemptCat` غير متأثر إطلاقاً بإصلاح SLA (القيمة نفسها في كل السيناريوهات قبل/بعد). كل اختبارات Bug #1-#6 السابقة: لا Regression.

### Not verified
- **سبب مشكلة June تحديداً** — لم يُعثر على كود خاص بـ June نفسه؛ يتطلب تشغيل `?action=diagnose&sheet=June` من Mohamed لتأكيد حالة الـ Snapshot الفعلية. اسم عمود Delivery Date الحقيقي غير مؤكَّد.

## [Unreleased] — حسم نهائي: أداة تشخيص June كاملة + تأكيد قطعي بعدم وجود عمود Delivery Date
### Fixed/Added
- `diagnoseMonth` أصبحت تُرجع تقريراً كاملاً: Raw Data (rowCount) + Snapshot (exists/empty/compatible) + Summary (total/delivered/deliveryRate) + All Months (included/source/reason) — وعند غياب Snapshot متوافق، تُنفِّذ فعلياً نفس Live Fallback الذي تنفّذه All Months بدل التخمين.
- حُسم نهائياً: لا يوجد عمود "تاريخ التسليم" منفصل في بيانات المشروع — مؤكَّد بنص موجود مسبقاً في index.html (شرح SLA بالإعدادات) يسبق هذه الجلسة، ومؤكَّد إضافياً بفحص SUMMARY_COLUMN_ALIASES/COLUMN_ALIASES المستقلين. SLA End Date الحقيقي دائماً = Last Status Date للشحنات Delivered فقط.

### Not verified
- الأرقام الفعلية الحية (June Total, All Months Total, SLA...) — لا يوجد اتصال شبكي من بيئتي؛ أداة diagnoseMonth المُحسَّنة تعطي Mohamed الإجابة الكاملة بضغطة واحدة بعد الرفع.

## [Unreleased] — Customer Activity Alerts: فصل عدّاد Significant عن Critical (فحص فعلي مؤكِّد لا تغيير في تعريف الشهر)
### Verified (no change needed)
- alertCurrentMonth = آخر شهر فعلي في فترة التقرير، alertPreviousMonth = الشهر التقويمي قبله مباشرة — كان صحيحاً بالفعل ومؤكَّد بكود واختبار فعليين جديدين هذه الجولة.

### Fixed
- `mgmtClassifyCustomerRisk()`: فصل `significantDeclineCount` (Significant فقط الآن) عن `criticalDeclineCount` [حقل جديد] بدل دمجهما.
- `mgmtGenerateExecutivePdfReport()`: بطاقة KPI رابعة "تراجع حرج (Critical)" أُضيفت لصف ملخص الصفحة.

### Not modified
- Code.gs: صفر تعديل. كل منطق الشهر/الحدود/الحد الأدنى/عدم التكرار: بدون تغيير (كان صحيحاً).

### Verified (Code-level — استخراج فعلي جديد من index.html الحالي)
14 حالة اختبار حرفية من رسالة المستخدم، كلها PASSED. صفر Regression على كل اختبارات الجلسة.
