import { createClient } from "@supabase/supabase-js";

export function createBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error("חסרים משתני Supabase. יש להגדיר אותם ב-Vercel.");
  }

  // אבחון זמני לבעיית ההתחברות (למחוק אחרי שהתקלה נפתרת בפועל): מדפיס
  // לקונסול של הדפדפן לאיזה פרויקט Supabase ועם איזה מפתח (מוצג חלקית
  // בלבד, לא מלא) הלקוח באמת מתחבר. חשוב כדי לוודא שהערכים שמוגדרים
  // ב-Vercel תואמים בדיוק לפרויקט שבו בוצע עדכון הסיסמה של המנהל - אם
  // ה-URL כאן שונה מהפרויקט הנכון, או המפתח לא תואם, זה בדיוק ההסבר לכך
  // שהתחברות נכשלת בלי שום רישום ב-Auth Logs (הבקשה נדחית עוד לפני שהיא
  // מגיעה לשירות ה-Auth עצמו).
  console.log("[FactoryCleanOS] מתחבר ל-Supabase:", {
    url,
    keyPreview: key.length > 12 ? `${key.slice(0, 8)}...${key.slice(-4)}` : "(קצר מהצפוי)",
  });

  return createClient(url, key);
}

export function workerEmailFromPhone(phone: string) {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("972")) digits = `0${digits.slice(3)}`;
  if (!digits.startsWith("0") && digits.length === 9) digits = `0${digits}`;
  return `${digits}@workers.factoryclean.co.il`;
}
