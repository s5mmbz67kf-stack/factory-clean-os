import { NextRequest } from 'next/server';
import { staff,response,failure,jsonBody,uuid,str,ApiError } from '@/lib/partner-server';
import { normalizePhone,validDay,SERVICES } from '@/lib/partners';
const requestColumns='id,partner_id,reference,service,status,customer_name,phone,city,address,notes,source,requested_day,scheduled_day,start_minute,duration_minutes,buffer_minutes,hold_until,contacted_at,agreed_price,customer_paid,commission_rate,commission_settled_at,outcome_note,version,created_at,updated_at';
export async function GET(req:NextRequest) {
 try {
  const {db,profile,admin,partnerId}=await staff(req);
  if(req.nextUrl.searchParams.get('destination')==='1')return response({destination:admin?'/':'/partners'});
  let requestsQuery=db.from('partner_requests').select(requestColumns);
  let exceptionsQuery=db.from('partner_day_exceptions').select('*');
  let blocksQuery=db.from('partner_time_blocks').select('*');
  if(!admin){ requestsQuery=requestsQuery.eq('partner_id',partnerId!); exceptionsQuery=exceptionsQuery.eq('partner_id',partnerId!); blocksQuery=blocksQuery.eq('partner_id',partnerId!); }
  const partnersQuery=db.from('service_partners').select('*').order('created_at');
  const results=await Promise.all([
   admin?partnersQuery:partnersQuery.eq('id',partnerId!),
   requestsQuery.order('created_at',{ascending:false}).limit(2000),
   exceptionsQuery,
   blocksQuery.order('day'),
  ]);
  const err=results.find(r=>r.error)?.error; if(err) throw err;
  const requests=results[1].data||[];
  const ids=requests.map(r=>r.id);
  const events=ids.length ? await db.from('partner_request_events').select('id,request_id,action,actor_name,details,created_at').in('request_id',ids).order('created_at',{ascending:false}).limit(2000) : {data:[],error:null};
  if(events.error) throw events.error;
  return response({role:admin?'admin':'technician',name:profile.full_name,partners:results[0].data,requests,exceptions:results[2].data,blocks:results[3].data,events:events.data});
 }catch(e){return failure(e);}
}
export async function POST(req:NextRequest) {
 try {
  const {db,profile,admin}=await staff(req); const body=await jsonBody(req); const action=str(body.action);
  if(action==='create_partner') {
   if(!admin) throw new ApiError(403,'מנהל בלבד.');
   const name=str(body.name,100),phone=normalizePhone(str(body.phone)),password=typeof body.password==='string'?body.password:'';
   if(name.length<2||!/^05\d{8}$/.test(phone)||password.length<12||password.length>128) throw new ApiError(400,'יש למלא שם, נייד וסיסמה של 12 תווים לפחות.');
   const {data:created,error}=await db.auth.admin.createUser({email:`${phone}@workers.factoryclean.co.il`,password,email_confirm:true,user_metadata:{full_name:name,phone}});
   if(error||!created.user) throw new ApiError(400,'לא ניתן ליצור חשבון. ייתכן שמספר הטלפון כבר קיים.');
   const userId=created.user.id;
   try {
    const pr=await db.from('profiles').upsert({id:userId,role:'employee',full_name:name,phone,active:true}); if(pr.error) throw pr.error;
    const p=await db.from('service_partners').insert({user_id:userId,name,phone}).select('id').single(); if(p.error) throw p.error;
    return response({ok:true,id:p.data.id});
   }catch(e){await db.auth.admin.deleteUser(userId);throw e;}
  }
  if(action==='request') {
   const requestId=uuid(body.id),version=Number(body.version),operation=str(body.operation);
   if(!Number.isInteger(version)||version<1) throw new ApiError(400,'גרסה לא תקינה.');
   const data=(body.data||{}) as Record<string,unknown>;
   if(operation==='confirm' && (!validDay(str(data.day))||!Number.isInteger(data.start)||Number(data.start)<0||Number(data.start)>1439||typeof data.price!=='number'||!Number.isFinite(data.price)||Number(data.price)<0||Number(data.price)>100000)) throw new ApiError(400,'בדקו את המועד והמחיר.');
   if(operation==='confirm' && data.duration!==undefined && (!Number.isInteger(data.duration)||Number(data.duration)<15||Number(data.duration)>720))throw new ApiError(400,'משך העבודה אינו תקין.');
   const {data:result,error}=await db.rpc('partner_change_request',{p_actor:profile.id,p_request:requestId,p_action:operation,p_version:version,p_data:data});
   if(error) throw error; return response({ok:true,request:result});
  }
  if(action==='schedule') {
   const partnerId=uuid(body.partnerId),operation=str(body.operation),data=(body.data||{}) as Record<string,unknown>;
   if(operation==='settings') {
    const weekly=data.weekly as {enabled:boolean;start:number;end:number}[];
    const durations=data.durations as Record<string,number>;
    if(!Array.isArray(data.services)||!data.services.length||data.services.length>4||data.services.some(s=>typeof s!=='string'||!Object.hasOwn(SERVICES,s)||s==='ac_cleaning'))throw new ApiError(400,'בחרו לפחות שירות אחד.');
    if(!Array.isArray(weekly)||weekly.length!==7||weekly.some(h=>typeof h.enabled!=='boolean'||!Number.isInteger(h.start)||!Number.isInteger(h.end)||h.start<0||h.end>1440||h.start>=h.end)||!durations||Object.keys(SERVICES).some(s=>!Number.isInteger(durations[s])||durations[s]<15||durations[s]>720)||!Number.isInteger(data.buffer_minutes)||Number(data.buffer_minutes)<0||Number(data.buffer_minutes)>180||typeof data.accepting!=='boolean'||!Array.isArray(data.cities)||data.cities.length>100||data.cities.some(c=>typeof c!=='string'||c.length<2||c.length>80)) throw new ApiError(400,'בדקו את שעות העבודה ואת משך השירותים.');
    if(data.accepting && (!weekly.some(h=>h.enabled)||data.cities.length===0)) throw new ApiError(400,'כדי לפתוח הזמנות צריך לבחור ימי עבודה וערי שירות.');
   }else if(['exception','block'].includes(operation)) {
    if(!validDay(str(data.day))||typeof data.closed!=='boolean'&&operation==='exception'||!Number.isInteger(data.start)||!Number.isInteger(data.end)||Number(data.start)<0||Number(data.end)>1440||Number(data.start)>=Number(data.end)) throw new ApiError(400,'בדקו את התאריך והשעות.');
   }else if(operation==='remove_exception') {if(!validDay(str(data.day)))throw new ApiError(400,'תאריך לא תקין.');}
   else if(operation==='remove_block') uuid(data.id);
   else throw new ApiError(400,'פעולה לא מוכרת.');
   const {error}=await db.rpc('partner_schedule_change',{p_actor:profile.id,p_partner:partnerId,p_action:operation,p_data:data}); if(error) throw error;
   return response({ok:true});
  }
  throw new ApiError(400,'פעולה לא מוכרת.');
 }catch(e){return failure(e);}
}
