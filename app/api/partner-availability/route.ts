import { NextRequest } from 'next/server';
import { dbClient,response,failure,rateLimit,ApiError,str } from '@/lib/partner-server';
import { validDay,dateInIsrael,addDays,SERVICES } from '@/lib/partners';
export async function GET(req:NextRequest) {
 try {
  await rateLimit(req,'availability',180);
  if(req.nextUrl.searchParams.get('catalog')==='1') {
    const {data,error}=await dbClient().from('service_partners').select('cities').eq('active',true).eq('accepting',true); if(error)throw error;
    return response({cities:[...new Set((data||[]).flatMap(p=>p.cities as string[]))].sort((a,b)=>a.localeCompare(b,'he'))});
  }
  const from=req.nextUrl.searchParams.get('from') || dateInIsrael();
  const service=req.nextUrl.searchParams.get('service') || 'installation';
  const city=str(req.nextUrl.searchParams.get('city'),80);
  if(!validDay(from)||from<dateInIsrael()||from>addDays(dateInIsrael(),62)||!(service in SERVICES)||city.length<2) throw new ApiError(400,'בחרו שירות ועיר תקינים.');
  const {data,error}=await dbClient().rpc('partner_available_days',{p_from:from,p_to:addDays(from,27),p_service:service,p_city:city});
  if(error) throw error; return response(data);
 }catch(e){return failure(e);}
}
