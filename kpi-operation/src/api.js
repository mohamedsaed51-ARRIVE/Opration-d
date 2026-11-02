import { API_URL } from './config.js';

export async function fetchClientMonthly() {
  const res = await fetch(`${API_URL}?action=clientMonthly`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`فشل الاتصال بالسيرفر (HTTP ${res.status})`);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('الرد من السيرفر مش JSON — اتأكد إن الـ Deployment متاح للجميع (Anyone) وإنه نسخة محدّثة.'); }
  if (data.success === false) throw new Error(data.error || 'السيرفر رجّع خطأ');
  if (!Array.isArray(data.clients)) throw new Error('السيرفر لسه على نسخة قديمة من Code.gs (مفيش action=clientMonthly). اعمل Deploy جديد.');
  return data;
}
