import { NextRequest } from 'next/server';
import { bookingInput,dbClient,response,failure,rateLimit,jsonBody } from '@/lib/partner-server';
export async function POST(req:NextRequest) {
 try {
  await rateLimit(req,'booking',12); const body=await jsonBody(req);
  if(body.website) return response({reference:'FC-RECEIVED',status:'pending'});
  const payload=bookingInput(body);
  const {data,error}=await dbClient().rpc('partner_submit_request',{p_payload:payload});
  if(error) throw error;
  return response(data);
 }catch(e){return failure(e);}
}
