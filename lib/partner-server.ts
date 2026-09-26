import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { SERVICES, normalizePhone, validDay, dateInIsrael, addDays } from './partners';

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export function dbClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new ApiError(503, 'החיבור למערכת עדיין לא הוגדר.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
export async function staff(request: NextRequest) {
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new ApiError(401, 'יש להתחבר למערכת.');
  const db = dbClient();
  const { data: auth, error } = await db.auth.getUser(token);
  if (error || !auth.user) throw new ApiError(401, 'ההתחברות פגה. יש להיכנס שוב.');
  const { data: profile } = await db.from('profiles').select('id,role,active,full_name').eq('id', auth.user.id).single();
  if (!profile?.active) throw new ApiError(403, 'אין גישה למערכת.');
  const admin = profile.role === 'admin';
  const { data: partner } = await db.from('service_partners').select('id').eq('user_id', profile.id).eq('active', true).maybeSingle();
  if (!admin && !partner) throw new ApiError(403, 'החשבון אינו משויך לטכנאי פעיל.');
  return { db, profile, admin, partnerId: partner?.id as string | undefined };
}
export function response(value: unknown, status = 200) { return NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } }); }
const errors: Record<string, [number,string]> = {
  DAY_UNAVAILABLE: [409,'היום או השעה כבר אינם פנויים. בחרו מועד אחר.'],
  EXISTING_BOOKING: [409,'קיימת בקשה או עבודה בשעות האלה. יש לתאם אותה מחדש לפני חסימת הזמינות.'],
  STALE_VERSION: [409,'העבודה עודכנה בינתיים. רעננו ונסו שוב.'],
  CONTACT_REQUIRED: [400,'יש לסמן שנוצר קשר ולאשר שהלקוח הסכים למועד ולמחיר.'],
  REASON_REQUIRED: [400,'נא לציין סיבה.'], FORBIDDEN: [403,'אין הרשאה לפעולה הזאת.'],
  TOO_MANY_REQUESTS: [429,'נשלחו מספר בקשות. אנא המתינו או צרו קשר.'],
  IDEMPOTENCY_CONFLICT: [409,'פרטי הבקשה השתנו. רעננו ושלחו מחדש.'],
  INVALID_STATE: [409,'מצב העבודה אינו מאפשר את הפעולה.'], NOT_FOUND:[404,'העבודה לא נמצאה.'],
};
export function failure(error: unknown) {
  if (error instanceof ApiError) return response({ error: error.message }, error.status);
  const message = error instanceof Error ? error.message : String((error as {message?:string})?.message || '');
  for (const [code,[status,text]] of Object.entries(errors)) if (message.includes(code)) return response({error:text}, status);
  if (/INVALID_/.test(message)) return response({error:'חלק מהפרטים אינם תקינים.'},400);
  console.error('[partners]', { message: 'Partner operation failed', code: (error as {code?:string})?.code });
  return response({error:'לא הצלחנו להשלים את הפעולה. נסו שוב.'},500);
}
export async function jsonBody(request: NextRequest) {
  const raw = await request.text();
  if (raw.length>16000) throw new ApiError(413,'הבקשה גדולה מדי.');
  try { const obj=JSON.parse(raw); if (!obj || typeof obj!=='object' || Array.isArray(obj)) throw new Error(); return obj as Record<string,unknown>; }
  catch { throw new ApiError(400,'בקשה לא תקינה.'); }
}
export const str = (v: unknown, max=200) => typeof v==='string' ? v.trim().slice(0,max) : '';
export function uuid(v: unknown) { const s=str(v,36); if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) throw new ApiError(400,'מזהה לא תקין.'); return s; }
export function bookingInput(body: Record<string,unknown>) {
  const name=str(body.name,100), phone=normalizePhone(str(body.phone,30)), city=str(body.city,80), address=str(body.address,200), notes=str(body.notes,1200), service=str(body.service), day=str(body.day,10), key=uuid(body.key);
  if(name.length<2 || !/^0(?:5\d{8}|[23489]\d{7})$/.test(phone) || city.length<2 || address.length<3 || !(service in SERVICES) || !validDay(day) || day<dateInIsrael() || day>addDays(dateInIsrael(),90) || body.consent!==true) throw new ApiError(400,'נא למלא פרטי קשר, כתובת ויום תקינים ולאשר העברת הפרטים לטכנאי.');
  if(service==='ac_cleaning') throw new ApiError(400,'ניקוי מזגן מבוצע על ידי איציק. הזמינו דרך טופס הניקיון באתר Factory Clean.');
  const payload={name,phone,city,address,notes,service,day,key};
  return {...payload, hash:createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
}
export async function rateLimit(request:NextRequest, scope:string, limit:number) {
  const ip=request.headers.get('x-vercel-forwarded-for')?.split(',')[0] || request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const key=createHash('sha256').update(scope+':'+ip).digest('hex');
  const db=dbClient(); const {data,error}=await db.rpc('partner_rate_limit',{p_key:key,p_limit:limit,p_seconds:3600});
  if(error) throw error;
  if(!data) throw new ApiError(429,'יותר מדי בקשות. נסו שוב מאוחר יותר.');
}
