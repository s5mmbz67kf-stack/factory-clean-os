import { createClient } from "@supabase/supabase-js";

export function createBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error("חסרים משתני Supabase. יש להגדיר אותם ב-Vercel.");
  }

  return createClient(url, key);
}

export function workerEmailFromPhone(phone: string) {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("972")) digits = `0${digits.slice(3)}`;
  if (!digits.startsWith("0") && digits.length === 9) digits = `0${digits}`;
  return `${digits}@workers.factoryclean.co.il`;
}
