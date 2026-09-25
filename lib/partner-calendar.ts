import { addDays,SERVICES,STATUS,WorkRequest } from './partners';
export function escapeIcs(value:string){return value.replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r/g,'');}
export function foldIcs(line:string){let part='',bytes=0;const lines:string[]=[];for(const ch of line){const size=Buffer.byteLength(ch);if(bytes+size>74){lines.push(part);part=' ';bytes=1;}part+=ch;bytes+=size;}lines.push(part);return lines.join('\r\n');}
export function israelInstant(day:string,minute:number){
 const [y,m,d]=day.split('-').map(Number);const wanted=Date.UTC(y,m-1,d,Math.floor(minute/60),minute%60);let utc=wanted;
 const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 for(let i=0;i<4;i++){const parts=Object.fromEntries(fmt.formatToParts(new Date(utc)).map(p=>[p.type,p.value]));const shown=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute));if(shown===wanted)return new Date(utc);utc+=wanted-shown;}
 throw new Error('Nonexistent local calendar time');
}
const stamp=(d:Date)=>d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
export function calendarFeed(requests:WorkRequest[],origin:string){
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Factory Clean//Partner Jobs//HE','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:Factory Clean - עבודות טכנאים','X-WR-TIMEZONE:Asia/Jerusalem'];
 for(const r of requests){
  const cancelled=['cancelled','rejected'].includes(r.status);const pending=['pending','contacted'].includes(r.status);
  lines.push('BEGIN:VEVENT',`UID:${r.id}@factoryclean-partners`,`SEQUENCE:${r.version}`,`DTSTAMP:${stamp(new Date(r.updated_at))}`,`LAST-MODIFIED:${stamp(new Date(r.updated_at))}`);
  if(pending)lines.push(`DTSTART;VALUE=DATE:${r.scheduled_day.replace(/-/g,'')}`,`DTEND;VALUE=DATE:${addDays(r.scheduled_day,1).replace(/-/g,'')}`);
  else lines.push(`DTSTART:${stamp(israelInstant(r.scheduled_day,r.start_minute))}`,`DTEND:${stamp(israelInstant(r.scheduled_day,r.start_minute+r.duration_minutes))}`);
  lines.push(`SUMMARY:${escapeIcs(`${STATUS[r.status]} · ${SERVICES[r.service]} · ${r.city}`)}`,`DESCRIPTION:${escapeIcs(`מספר עבודה: ${r.reference}\nפרטי הלקוח והעבודה זמינים במערכת לאחר כניסה: ${origin}/partners`)}`,`STATUS:${cancelled?'CANCELLED':pending?'TENTATIVE':'CONFIRMED'}`,'TRANSP:TRANSPARENT','CLASS:PRIVATE','END:VEVENT');
 }
 lines.push('END:VCALENDAR');return lines.map(foldIcs).join('\r\n')+'\r\n';
}
