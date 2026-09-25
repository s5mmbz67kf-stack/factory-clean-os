import { NextRequest } from 'next/server';
import { createHash,randomBytes } from 'node:crypto';
import { dbClient,staff,response,failure,ApiError } from '@/lib/partner-server';
import { addDays,dateInIsrael,WorkRequest } from '@/lib/partners';
import { calendarFeed } from '@/lib/partner-calendar';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export async function POST(req:NextRequest){
 try{const {db,admin,profile}=await staff(req);if(!admin)throw new ApiError(403,'החיבור מיועד לבעל העסק.');
 const token=randomBytes(32).toString('hex');const {error}=await db.from('partner_calendar_feeds').upsert({user_id:profile.id,token_hash:hash(token),created_at:new Date().toISOString()});if(error)throw error;
 return response({url:`${req.nextUrl.origin}/api/partner-calendar?token=${token}`});
 }catch(e){return failure(e);}
}
export async function DELETE(req:NextRequest){
 try{const {db,admin,profile}=await staff(req);if(!admin)throw new ApiError(403,'מנהל בלבד.');const {error}=await db.from('partner_calendar_feeds').delete().eq('user_id',profile.id);if(error)throw error;return response({ok:true});}catch(e){return failure(e);}
}
export async function GET(req:NextRequest){
 try{const token=req.nextUrl.searchParams.get('token')||'';if(!/^[a-f0-9]{64}$/.test(token))throw new ApiError(401,'קישור יומן לא תקין.');
 const db=dbClient();const {data:feed}=await db.from('partner_calendar_feeds').select('user_id').eq('token_hash',hash(token)).maybeSingle();if(!feed)throw new ApiError(401,'קישור היומן אינו פעיל.');
 const {data:owner}=await db.from('profiles').select('role,active').eq('id',feed.user_id).single();if(owner?.role!=='admin'||!owner.active)throw new ApiError(403,'הגישה ליומן בוטלה.');
 const {data,error}=await db.from('partner_requests').select('*').gte('scheduled_day',addDays(dateInIsrael(),-30)).lte('scheduled_day',addDays(dateInIsrael(),90)).order('scheduled_day').limit(5000);if(error)throw error;
 return new Response(calendarFeed(data as WorkRequest[],req.nextUrl.origin),{headers:{'Content-Type':'text/calendar; charset=utf-8','Cache-Control':'private, no-store','Content-Disposition':'inline; filename="factory-clean-technicians.ics"','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'}});
 }catch(e){return failure(e);}
}
