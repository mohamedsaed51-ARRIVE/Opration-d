# ARRIVE Operations Dashboard — Google Apps Script Backend + Frontend

## الملفات الحقيقية المستخدمة في التشغيل
- `Code.gs` — الـ Backend الفعلي (Google Apps Script، doGet، الكاش، ملخصات الشهور، Filter Cube).
- `index.html` — الواجهة الفعلية (Vanilla JS، Chart.js، jsPDF، SheetJS).

هذان الملفان هما فقط ما يُنشر فعلياً كـ Web App. أي ملف آخر داخل `archive/` هو نسخة تاريخية سابقة وليس جزءاً من التشغيل الحالي.

## لماذا لا يوجد عدة نسخ من Code.gs / index.html في الجذر؟
كان المشروع الأصلي يحتوي على 15 ملف ZIP متراكم في نفس المجلد (كل واحد يمثل مرحلة تطوير: AllMonths → AllMonths-Fix → MgmtFix → MgmtReport → PdfImageFix → Reports-Rebuild → Arabic-Reports → Excel-Rotated → PDF-Arabic-Fix → PDF-RTL-Fix → PDF-Arabic-VERIFIED → Filters-V2-CompatFix → AllMonths-CompatFix → LiveFallback-Fix)، بالإضافة إلى نسخة Code.gs/index.html في الجذر.

تم التحقق بالـ checksum: ملفا الجذر (`Code.gs` و `index.html`) **متطابقان تماماً (MD5)** مع محتوى `Operations-Dashboard-LiveFallback-Fix.zip`، وهو الأحدث زمنياً بين كل الـ ZIPs (بحسب الطابع الزمني الداخلي للملفات: 2026-09-05 19:03). لذلك هذه هي النسخة الحالية الوحيدة المعتمدة، وكل الباقي أُرشف في `archive/` دون حذف.

## بنية المشروع
```
Project/
├── Code.gs              ← Backend الحالي (مطابق لآخر نسخة LiveFallback-Fix)
├── index.html           ← Frontend الحالي (مطابق لآخر نسخة LiveFallback-Fix)
├── README.md
├── CHANGELOG.md
├── docs/
│   └── audit.md         ← تقرير الفحص (AUDIT) الكامل
├── archive/             ← كل نسخ الـ ZIP القديمة (15 ملف) — لم يُحذف شيء
└── tests/                ← لا توجد ملفات اختبار آلية في المشروع الأصلي
```

## نشر التحديثات (Google Apps Script)
هذا مشروع Apps Script وليس Node/Vite: لا يوجد `package.json` ولا `.git`. النشر يتم عبر لصق `Code.gs` و `index.html` داخل محرر Apps Script المرتبط بحساب Google الحالي ثم عمل Deploy جديد (New Deployment) أو تحديث الـ Deployment الحالي المرتبط بالرابط:
`https://script.google.com/macros/s/AKfycby.../exec`
