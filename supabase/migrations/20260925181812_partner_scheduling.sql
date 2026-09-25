-- Partner scheduling. All mutations go through authenticated server routes.
-- Public customers see aggregate dates only; no client role has table access.
create table public.service_partners (
 id uuid primary key default gen_random_uuid(), user_id uuid not null unique references public.profiles(id),
 name text not null, phone text not null, active boolean not null default true, accepting boolean not null default false,
 cities text[] not null default '{}', weekly jsonb not null default '[{"enabled":false,"start":540,"end":1020},{"enabled":false,"start":540,"end":1020},{"enabled":false,"start":540,"end":1020},{"enabled":false,"start":540,"end":1020},{"enabled":false,"start":540,"end":1020},{"enabled":false,"start":540,"end":780},{"enabled":false,"start":540,"end":780}]',
 durations jsonb not null default '{"ac_cleaning":90,"installation":180,"repair":90,"dismantling":90}',
 buffer_minutes integer not null default 30 check(buffer_minutes between 0 and 180), created_at timestamptz not null default now()
);
create table public.partner_day_exceptions (
 partner_id uuid not null references public.service_partners(id), day date not null, closed boolean not null,
 start_minute integer, end_minute integer, primary key(partner_id,day),
 check(closed or (start_minute >= 0 and end_minute <= 1440 and end_minute > start_minute))
);
create table public.partner_time_blocks (
 id uuid primary key default gen_random_uuid(), partner_id uuid not null references public.service_partners(id), day date not null,
 start_minute integer not null check(start_minute>=0), end_minute integer not null check(end_minute<=1440),
 note text not null default '', check(end_minute>start_minute)
);
create index partner_time_blocks_day on public.partner_time_blocks(partner_id,day);
create table public.partner_requests (
 id uuid primary key default gen_random_uuid(), partner_id uuid not null references public.service_partners(id),
 reference text not null unique default ('FC-AC-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
 idempotency_key uuid not null unique, request_hash text not null,
 service text not null check(service in ('ac_cleaning','installation','repair','dismantling')),
 status text not null default 'pending' check(status in ('pending','contacted','confirmed','completed','rejected','cancelled')),
 customer_name text not null, phone text not null, city text not null, address text not null, notes text not null default '',
 source text not null default 'factoryclean_website' check(source='factoryclean_website'),
 requested_day date not null, scheduled_day date not null, start_minute integer not null,
 duration_minutes integer not null check(duration_minutes between 15 and 720), buffer_minutes integer not null check(buffer_minutes between 0 and 180),
 hold_until timestamptz not null default (now()+interval '24 hours'), contacted_at timestamptz,
 agreed_price numeric(12,2) check(agreed_price>=0), customer_paid boolean not null default false,
 commission_rate numeric not null default 0.10 check(commission_rate=0.10), commission_settled_at timestamptz,
 outcome_note text, version integer not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(start_minute>=0 and start_minute+duration_minutes+buffer_minutes<=1440)
);
create index partner_requests_calendar on public.partner_requests(partner_id,scheduled_day,status);
create index partner_requests_phone on public.partner_requests(phone,created_at);
create table public.partner_request_events (
 id bigint generated always as identity primary key, request_id uuid not null references public.partner_requests(id),
 action text not null, actor_id uuid references public.profiles(id), actor_name text not null,
 details jsonb not null default '{}', created_at timestamptz not null default now()
);
create index partner_request_events_request on public.partner_request_events(request_id,created_at);
create table public.partner_rate_limits (key text primary key, started_at timestamptz not null, hits integer not null);

alter table public.service_partners enable row level security;
alter table public.partner_day_exceptions enable row level security;
alter table public.partner_time_blocks enable row level security;
alter table public.partner_requests enable row level security;
alter table public.partner_request_events enable row level security;
alter table public.partner_rate_limits enable row level security;
revoke all on public.service_partners,public.partner_day_exceptions,public.partner_time_blocks,public.partner_requests,public.partner_request_events,public.partner_rate_limits from anon,authenticated;
grant all on public.service_partners,public.partner_day_exceptions,public.partner_time_blocks,public.partner_requests,public.partner_request_events,public.partner_rate_limits to service_role;
grant usage,select on sequence public.partner_request_events_id_seq to service_role;

-- SECURITY INVOKER: executable by service_role only; no public privilege elevation.
create function public.partner_rate_limit(p_key text,p_limit integer,p_seconds integer) returns boolean
language plpgsql set search_path='' as $$
declare n integer;
begin
 insert into public.partner_rate_limits as r values(p_key,clock_timestamp(),1)
 on conflict(key) do update set
 hits=case when r.started_at < clock_timestamp()-make_interval(secs=>p_seconds) then 1 else r.hits+1 end,
 started_at=case when r.started_at < clock_timestamp()-make_interval(secs=>p_seconds) then clock_timestamp() else r.started_at end
 returning hits into n;
 return n<=p_limit;
end $$;

create function public.partner_hours(p_partner uuid,p_day date) returns table(start_minute integer,end_minute integer)
language plpgsql stable set search_path='' as $$
declare e public.partner_day_exceptions; w jsonb;
begin
 select * into e from public.partner_day_exceptions where partner_id=p_partner and day=p_day;
 if found then
  if not e.closed then return query select e.start_minute,e.end_minute; end if;
  return;
 end if;
 select weekly->extract(dow from p_day)::integer into w from public.service_partners where id=p_partner and active;
 if coalesce((w->>'enabled')::boolean,false) then return query select (w->>'start')::integer,(w->>'end')::integer; end if;
end $$;

create function public.partner_find_slot(p_partner uuid,p_day date,p_duration integer,p_buffer integer,p_exclude uuid default null,p_start integer default null)
returns integer language plpgsql stable set search_path='' as $$
declare h record; candidate integer; first_minute integer; last_minute integer; localnow timestamp := now() at time zone 'Asia/Jerusalem';
begin
 if p_day<localnow::date or p_day>localnow::date+90 then return null; end if;
 select * into h from public.partner_hours(p_partner,p_day);
 if not found then return null; end if;
 first_minute:=h.start_minute;
 if p_day=localnow::date then first_minute:=greatest(first_minute,ceil((extract(hour from localnow)*60+extract(minute from localnow)+60)/15.0)::integer*15); end if;
 last_minute:=h.end_minute-p_duration-p_buffer;
 if p_start is not null then
  if p_start<first_minute or p_start>last_minute then return null; end if;
  first_minute:=p_start; last_minute:=p_start;
 end if;
 for candidate in select generate_series(first_minute,last_minute,15) loop
  if not exists(select 1 from public.partner_time_blocks b where b.partner_id=p_partner and b.day=p_day and b.start_minute<candidate+p_duration+p_buffer and b.end_minute>candidate)
  and not exists(select 1 from public.partner_requests r where r.partner_id=p_partner and r.scheduled_day=p_day and r.id is distinct from p_exclude
    and (r.status in ('confirmed','completed') or (r.status in ('pending','contacted') and r.hold_until>now()))
    and r.start_minute<candidate+p_duration+p_buffer and r.start_minute+r.duration_minutes+r.buffer_minutes>candidate)
  then return candidate; end if;
 end loop;
 return null;
end $$;

create function public.partner_available_days(p_from date,p_to date,p_service text,p_city text) returns jsonb
language plpgsql stable set search_path='' as $$
declare d date; p record; available boolean; result jsonb:='[]'; any_partner boolean;
begin
 if p_service not in ('ac_cleaning','installation','repair','dismantling') or p_from<(now() at time zone 'Asia/Jerusalem')::date or p_to>p_from+41 then raise exception 'INVALID_RANGE'; end if;
 select exists(select 1 from public.service_partners where active and accepting and (cardinality(cities)=0 or p_city=any(cities))) into any_partner;
 for d in select generate_series(p_from::timestamp,p_to::timestamp,interval '1 day')::date loop
  available:=false;
  for p in select * from public.service_partners where active and accepting and (cardinality(cities)=0 or p_city=any(cities)) loop
   if public.partner_find_slot(p.id,d,(p.durations->>p_service)::integer,p.buffer_minutes) is not null then available:=true; exit; end if;
  end loop;
  result:=result || jsonb_build_array(jsonb_build_object('date',d,'available',available));
 end loop;
 return jsonb_build_object('days',result,'configured',any_partner);
end $$;

create function public.partner_submit_request(p_payload jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare r public.partner_requests; p public.service_partners; slot integer; day date; service text; v_phone text; dur integer;
begin
 -- A shared pool lock makes date assignment atomic across simultaneous requests.
 perform pg_advisory_xact_lock(hashtextextended('factory_partner_schedule',0));
 select * into r from public.partner_requests where idempotency_key=(p_payload->>'key')::uuid;
 if found then
  if r.request_hash<>p_payload->>'hash' then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return jsonb_build_object('reference',r.reference,'status',r.status);
 end if;
 day:=(p_payload->>'day')::date; service:=p_payload->>'service'; v_phone:=p_payload->>'phone';
 if service not in ('ac_cleaning','installation','repair','dismantling') or day<(now() at time zone 'Asia/Jerusalem')::date or day>(now() at time zone 'Asia/Jerusalem')::date+90 then raise exception 'INVALID_REQUEST'; end if;
 if (select count(*) from public.partner_requests where partner_requests.phone=v_phone and created_at>now()-interval '1 day')>=3 then raise exception 'TOO_MANY_REQUESTS'; end if;
 for p in select * from public.service_partners where active and accepting and (cardinality(cities)=0 or (p_payload->>'city')=any(cities)) order by created_at,id loop
  dur:=(p.durations->>service)::integer;
  slot:=public.partner_find_slot(p.id,day,dur,p.buffer_minutes);
  if slot is null then continue; end if;
  insert into public.partner_requests(partner_id,idempotency_key,request_hash,service,customer_name,phone,city,address,notes,requested_day,scheduled_day,start_minute,duration_minutes,buffer_minutes)
  values(p.id,(p_payload->>'key')::uuid,p_payload->>'hash',service,p_payload->>'name',v_phone,p_payload->>'city',p_payload->>'address',coalesce(p_payload->>'notes',''),day,day,slot,dur,p.buffer_minutes) returning * into r;
  insert into public.partner_request_events(request_id,action,actor_name,details) values(r.id,'submitted','הלקוח',jsonb_build_object('day',day,'source','factoryclean_website'));
  return jsonb_build_object('reference',r.reference,'status',r.status);
 end loop;
 raise exception 'DAY_UNAVAILABLE';
end $$;

create function public.partner_change_request(p_actor uuid,p_request uuid,p_action text,p_version integer,p_data jsonb default '{}') returns jsonb
language plpgsql set search_path='' as $$
declare r public.partner_requests; pr public.profiles; p public.service_partners; d date; m integer; price numeric; details jsonb:='{}';
begin
 perform pg_advisory_xact_lock(hashtextextended('factory_partner_schedule',0));
 select * into pr from public.profiles where id=p_actor and active;
 if not found then raise exception 'FORBIDDEN'; end if;
 select * into r from public.partner_requests where id=p_request for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into p from public.service_partners where id=r.partner_id;
 if pr.role::text<>'admin' and (p.user_id<>p_actor or not p.active) then raise exception 'FORBIDDEN'; end if;
 if r.version<>p_version then raise exception 'STALE_VERSION'; end if;
 if p_action='contact' then
  if r.status not in ('pending','contacted') then raise exception 'INVALID_STATE'; end if;
  update public.partner_requests set status='contacted',contacted_at=coalesce(contacted_at,now()) where id=r.id;
 elsif p_action='confirm' then
  if r.status not in ('pending','contacted','confirmed') or r.contacted_at is null or coalesce((p_data->>'customerConfirmed')::boolean,false)=false then raise exception 'CONTACT_REQUIRED'; end if;
  d:=(p_data->>'day')::date; m:=(p_data->>'start')::integer; price:=(p_data->>'price')::numeric;
  if d is null or m is null or price is null or price<0 or price>100000 then raise exception 'INVALID_REQUEST'; end if;
  if public.partner_find_slot(r.partner_id,d,r.duration_minutes,r.buffer_minutes,r.id,m) is null then raise exception 'DAY_UNAVAILABLE'; end if;
  update public.partner_requests set status='confirmed',scheduled_day=d,start_minute=m,agreed_price=price,outcome_note=left(coalesce(p_data->>'note',''),1000) where id=r.id;
  details:=jsonb_build_object('day',d,'start',m,'priceBeforeVat',price,'customerConfirmed',true,'previousDay',r.scheduled_day,'previousPrice',r.agreed_price);
 elsif p_action='complete' then
  if r.status<>'confirmed' then raise exception 'INVALID_STATE'; end if;
  update public.partner_requests set status='completed',customer_paid=coalesce((p_data->>'paid')::boolean,false),outcome_note=left(coalesce(p_data->>'note',''),1000) where id=r.id;
 elsif p_action='paid' then
  if r.status<>'completed' or r.customer_paid then raise exception 'INVALID_STATE'; end if;
  update public.partner_requests set customer_paid=true where id=r.id;
 elsif p_action in ('cancel','reject') then
  if r.status in ('completed','rejected','cancelled') or (p_action='reject' and r.status='confirmed') then raise exception 'INVALID_STATE'; end if;
  if length(trim(coalesce(p_data->>'note','')))<3 then raise exception 'REASON_REQUIRED'; end if;
  update public.partner_requests set status=case p_action when 'reject' then 'rejected' else 'cancelled' end,outcome_note=left(p_data->>'note',1000) where id=r.id;
  details:=jsonb_build_object('reason',left(p_data->>'note',1000));
 elsif p_action='settle' then
  if pr.role::text<>'admin' then raise exception 'FORBIDDEN'; end if;
  if r.status<>'completed' or not r.customer_paid or r.commission_settled_at is not null then raise exception 'INVALID_STATE'; end if;
  update public.partner_requests set commission_settled_at=now() where id=r.id;
 else raise exception 'INVALID_ACTION'; end if;
 update public.partner_requests set version=version+1,updated_at=now() where id=r.id returning * into r;
 insert into public.partner_request_events(request_id,action,actor_id,actor_name,details) values(r.id,p_action,p_actor,pr.full_name,details);
 return to_jsonb(r)-'idempotency_key'-'request_hash';
end $$;

create function public.partner_schedule_change(p_actor uuid,p_partner uuid,p_action text,p_data jsonb) returns boolean
language plpgsql set search_path='' as $$
declare p public.service_partners; admin boolean; pr public.profiles; d date; s integer; e integer; entry jsonb; service text;
begin
 perform pg_advisory_xact_lock(hashtextextended('factory_partner_schedule',0));
 select * into pr from public.profiles where id=p_actor and active;
 if not found then raise exception 'FORBIDDEN'; end if;
 admin:=pr.role::text='admin';
 select * into p from public.service_partners where id=p_partner for update;
 if not found or (not admin and (p.user_id<>p_actor or not p.active)) then raise exception 'FORBIDDEN'; end if;
 if p_action='settings' then
  if jsonb_array_length(p_data->'weekly')<>7 then raise exception 'INVALID_REQUEST'; end if;
  for entry in select jsonb_array_elements(p_data->'weekly') loop
   if (entry->>'start')::integer<0 or (entry->>'end')::integer>1440 or (entry->>'end')::integer<=(entry->>'start')::integer then raise exception 'INVALID_HOURS'; end if;
  end loop;
  foreach service in array array['ac_cleaning','installation','repair','dismantling'] loop
   if coalesce((p_data->'durations'->>service)::integer,0) not between 15 and 720 then raise exception 'INVALID_DURATION'; end if;
  end loop;
  update public.service_partners set weekly=p_data->'weekly',durations=p_data->'durations',buffer_minutes=(p_data->>'buffer_minutes')::integer,
   cities=array(select jsonb_array_elements_text(p_data->'cities')),accepting=(p_data->>'accepting')::boolean where id=p_partner;
 elsif p_action='exception' then
  d:=(p_data->>'day')::date; s:=(p_data->>'start')::integer; e:=(p_data->>'end')::integer;
  insert into public.partner_day_exceptions values(p_partner,d,(p_data->>'closed')::boolean,s,e)
  on conflict(partner_id,day) do update set closed=excluded.closed,start_minute=excluded.start_minute,end_minute=excluded.end_minute;
 elsif p_action='remove_exception' then
  delete from public.partner_day_exceptions where partner_id=p_partner and day=(p_data->>'day')::date;
 elsif p_action='block' then
  d:=(p_data->>'day')::date; s:=(p_data->>'start')::integer; e:=(p_data->>'end')::integer;
  if exists(select 1 from public.partner_requests where partner_id=p_partner and scheduled_day=d and (status='confirmed' or (status in ('pending','contacted') and hold_until>now())) and start_minute<e and start_minute+duration_minutes+buffer_minutes>s) then raise exception 'EXISTING_BOOKING'; end if;
  insert into public.partner_time_blocks(partner_id,day,start_minute,end_minute,note) values(p_partner,d,s,e,left(coalesce(p_data->>'note',''),300));
 elsif p_action='remove_block' then
  delete from public.partner_time_blocks where partner_id=p_partner and id=(p_data->>'id')::uuid;
 else raise exception 'INVALID_ACTION'; end if;
 -- Changes never invalidate accepted bookings or active holds silently.
 if exists(select 1 from public.partner_requests r where r.partner_id=p_partner and r.scheduled_day>=(now() at time zone 'Asia/Jerusalem')::date
   and (r.status='confirmed' or (r.status in ('pending','contacted') and r.hold_until>now()))
   and not exists(select 1 from public.partner_hours(p_partner,r.scheduled_day) h where h.start_minute<=r.start_minute and h.end_minute>=r.start_minute+r.duration_minutes+r.buffer_minutes)) then raise exception 'EXISTING_BOOKING'; end if;
 return true;
end $$;

revoke all on function public.partner_rate_limit(text,integer,integer),public.partner_hours(uuid,date),public.partner_find_slot(uuid,date,integer,integer,uuid,integer),public.partner_available_days(date,date,text,text),public.partner_submit_request(jsonb),public.partner_change_request(uuid,uuid,text,integer,jsonb),public.partner_schedule_change(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.partner_rate_limit(text,integer,integer),public.partner_hours(uuid,date),public.partner_find_slot(uuid,date,integer,integer,uuid,integer),public.partner_available_days(date,date,text,text),public.partner_submit_request(jsonb),public.partner_change_request(uuid,uuid,text,integer,jsonb),public.partner_schedule_change(uuid,uuid,text,jsonb) to service_role;
