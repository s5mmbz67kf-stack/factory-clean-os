create table public.partner_calendar_feeds (
 user_id uuid primary key references public.profiles(id),
 token_hash text not null unique check(length(token_hash)=64),
 created_at timestamptz not null default now()
);
alter table public.partner_calendar_feeds enable row level security;
revoke all on public.partner_calendar_feeds from anon,authenticated;
grant all on public.partner_calendar_feeds to service_role;
