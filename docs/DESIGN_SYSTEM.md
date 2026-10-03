# ARRIVE Design System — لوحة المتابعة

المرجع: ARRIVE Design System V2.0 (Project Instructions V1.0).

## تغيير لون/خط من مكان واحد
1. عدّل `design-system/arrive-tokens.css`.
2. شغّل `python3 design-system/build.py` (يدمج الملفات داخل `index.html`).
3. ألوان Chart.js وPDF تُقرأ من نفس الـ tokens وقت التشغيل.

## الملفات
| الملف | الدور |
|---|---|
| arrive-tokens.css | ألوان، خطوط، مسافات، أنصاف أقطار، ظلال (نسخة حرفية من الـ tokens المعتمدة) |
| arrive-components.css | Button، Input، Card، KPICard، DataTable، StatusBadge، Alert، Empty/Error/Loading |
| arrive-dashboard.css | الـ Shell، Sidebar، Header، الفلاتر، التخطيط، الطباعة، الاستجابة |
| arrive-ds.js | `ARRIVE_DS`: ألوان الرسوم، الشارات، تحسين الجداول (بحث/ترقيم) |
| logos.js | الشعار المعتمد (PNG شفاف، بدون تعديل) |

## قواعد
- الحالة = لون + أيقونة + نص. «مخالفة / حرجة» = #EF4444 حالة واحدة.
- شارة الحالة لا تظهر إلا لو الحالة مُمرَّرة فعليًا.
- القيم الناقصة: «غير محدد بالمصدر».
- الشعار على الأزرق/النيلي مباشرة؛ على الفاتح داخل بلاطة ARRIVE Blue.
