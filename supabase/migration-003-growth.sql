-- Factory Clean OS — Migration 003: Growth OS foundation
-- Run once in the Supabase SQL Editor, AFTER schema.sql and migration-002-vat.sql
-- are already applied.
--
-- Design goals (per FACTORY GROWTH OS — FINAL MASTER BUILD spec, sections 14-17):
--   * Purely additive. No existing table, column, function, trigger, view,
--     policy, or row is dropped, renamed, or altered. Nothing here touches
--     profiles/employees/customers/jobs/employee_payments/job_events.
--   * growth_events matches EXACTLY the payload already sent today by
--     src/assets/js/growth-tracker.js (browser) and lib/growthTrack.js
--     (server, booking_confirmed only) on the website, forwarded through
--     api/track.js. This migration does not invent new event fields — it
--     persists what is already being sent and (per audit) currently
--     dropped for lack of a destination table/endpoint.
--   * Event allowlist matches the 10 events the website actually emits.
--     job_completed / revenue_recorded are deliberately NOT growth_events
--     rows: Factory OS's own `jobs` table is already the authoritative
--     source for completion + revenue (see metric definitions, section 19).
--     Funnel/Profitability read those last two stages by joining
--     growth_booking_job_links -> jobs, not via a duplicated event stream.
--     This avoids adding a second, easy-to-desync source of truth and
--     avoids any new trigger on the live jobs table.
--   * Admin-only end to end: every growth_* table reuses the existing
--     public.is_admin() function for RLS (same primitive employees/
--     customers/jobs already use) and revokes all anon access. No new
--     auth model, no new roles.
--   * Nothing here is writable by "authenticated" for growth_events itself
--     -- only the service-role key (used exclusively by the new
--     /api/growth-ingest server route, never shipped to a browser) can
--     insert. Admins can read. This matches "no public Growth reads" and
--     "service role server-side only" (section 17) precisely.
--   * All other growth_* tables (campaigns, creatives, experiments,
--     actions, ai_insights, alerts, import_runs, source_rules) ARE
--     admin-writable directly from the browser via RLS, exactly like
--     customers/jobs already are today — no new API route needed for
--     those, consistent with how the rest of Factory OS already works.

begin;

-- ---------- growth_events ----------
-- Live introspection on 2026-08-26 found this table ALREADY EXISTS in this
-- Supabase project (created out-of-band in some earlier attempt), with a
-- schema that is column-for-column compatible with everything this app
-- writes/reads, except:
--   * the event-timestamp column is named occurred_at, not received_at
--   * there is an additional created_at (row-insert time) column
--   * id is uuid (default-generated), not bigint generated always as identity
-- None of that requires altering the table, so we deliberately do NOT
-- create/alter it here. app/api/growth-ingest/route.ts never sets
-- id/occurred_at/created_at explicitly (relies on their own defaults), and
-- components/growth/growth-os.tsx reads occurred_at instead of received_at.
-- We only add the indexes this app needs, all idempotent.
create unique index if not exists growth_events_client_event_id_unique
  on public.growth_events(client_event_id);
create index if not exists growth_events_session_idx on public.growth_events(session_id);
create index if not exists growth_events_booking_ref_idx
  on public.growth_events(booking_ref) where booking_ref is not null;
create index if not exists growth_events_event_name_idx on public.growth_events(event_name);
create index if not exists growth_events_occurred_at_idx on public.growth_events(occurred_at desc);
create index if not exists growth_events_current_source_idx on public.growth_events(current_source);
create index if not exists growth_events_first_source_idx on public.growth_events(first_source);

-- ---------- growth_booking_job_links (section 7) ----------
create table if not exists public.growth_booking_job_links (
  id uuid primary key default gen_random_uuid(),
  booking_ref text not null,
  website_order_id text,
  factory_customer_id uuid references public.customers(id) on delete set null,
  factory_job_id uuid references public.jobs(id) on delete set null,
  link_method text not null default 'manual'
    check (link_method in ('automatic', 'phone_match', 'manual', 'imported')),
  status text not null default 'unlinked'
    check (status in ('unlinked', 'linked', 'ambiguous', 'rejected')),
  confidence numeric(5, 2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists growth_booking_job_links_booking_ref_unique
  on public.growth_booking_job_links(booking_ref);
create index if not exists growth_booking_job_links_job_idx
  on public.growth_booking_job_links(factory_job_id);

-- ---------- growth_campaigns / growth_campaign_daily_metrics (sections 5, 16) ----------
create table if not exists public.growth_campaigns (
  id uuid primary key default gen_random_uuid(),
  platform text not null
    check (platform in ('google_ads', 'meta_ads', 'tiktok', 'manual', 'organic', 'influencer', 'referral', 'other')),
  campaign_external_id text,
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  service_type text,
  city text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.growth_import_runs (
  id uuid primary key default gen_random_uuid(),
  import_type text not null default 'campaign_spend_csv',
  file_name text,
  row_count integer not null default 0,
  inserted_count integer not null default 0,
  skipped_count integer not null default 0,
  error_count integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.growth_campaign_daily_metrics (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references public.growth_campaigns(id) on delete cascade,
  metric_date date not null,
  spend numeric(12, 2) not null default 0,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  source text not null default 'manual_csv' check (source in ('manual_csv', 'api')),
  import_run_id uuid references public.growth_import_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (campaign_id, metric_date, source)
);

-- ---------- growth_creatives / growth_creative_daily_metrics (section 6) ----------
create table if not exists public.growth_creatives (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.growth_campaigns(id) on delete set null,
  platform text,
  organic boolean not null default false,
  service_type text,
  hook text,
  angle text,
  offer text,
  format text,
  creator text,
  cta text,
  city text,
  launch_date date,
  external_ad_id text,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.growth_creative_daily_metrics (
  id bigint generated always as identity primary key,
  creative_id uuid not null references public.growth_creatives(id) on delete cascade,
  metric_date date not null,
  spend numeric(12, 2) not null default 0,
  impressions bigint not null default 0,
  reach bigint,
  video_views bigint,
  watch_time_seconds bigint,
  clicks bigint not null default 0,
  shares bigint,
  saves bigint,
  comments bigint,
  profile_visits bigint,
  source text not null default 'manual_csv' check (source in ('manual_csv', 'api')),
  created_at timestamptz not null default now(),
  unique (creative_id, metric_date, source)
);

-- ---------- growth_experiments (section 10) ----------
create table if not exists public.growth_experiments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  hypothesis text,
  area text,
  control text,
  variant text,
  primary_metric text,
  guardrail text,
  start_date date,
  end_date date,
  status text not null default 'draft'
    check (status in ('draft', 'running', 'won', 'lost', 'inconclusive', 'archived')),
  result text,
  decision text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- growth_ai_insights (section 11) ----------
create table if not exists public.growth_ai_insights (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in (
    'opportunity', 'problem', 'anomaly', 'budget_efficiency', 'funnel_leak',
    'retention', 'creative', 'data_quality', 'experiment_suggestion'
  )),
  finding text not null,
  evidence jsonb not null default '{}'::jsonb,
  likely_explanation text,
  confidence numeric(5, 2),
  business_impact text,
  recommended_action text,
  measurement_plan text,
  period_from date,
  period_to date,
  dismissed boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- growth_actions (section 12) ----------
create table if not exists public.growth_actions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  insight_id uuid references public.growth_ai_insights(id) on delete set null,
  type text not null check (type in ('do_now', 'test', 'watch', 'ignore')),
  priority integer not null default 3 check (priority between 1 and 5),
  owner uuid references public.profiles(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'dismissed')),
  due_date date,
  expected_impact text,
  metric text,
  notes text,
  outcome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- growth_alerts (section 13, data health history) ----------
create table if not exists public.growth_alerts (
  id uuid primary key default gen_random_uuid(),
  check_name text not null,
  severity text not null default 'yellow' check (severity in ('red', 'yellow', 'green')),
  message text not null,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------- growth_source_rules (section 15, source/medium normalization) ----------
create table if not exists public.growth_source_rules (
  id uuid primary key default gen_random_uuid(),
  match_pattern text not null,
  canonical_source text not null,
  canonical_medium text,
  created_at timestamptz not null default now()
);

-- ---------- updated_at triggers (reusing the existing function) ----------
drop trigger if exists growth_booking_job_links_set_updated_at on public.growth_booking_job_links;
create trigger growth_booking_job_links_set_updated_at
  before update on public.growth_booking_job_links
  for each row execute procedure public.set_updated_at();

drop trigger if exists growth_campaigns_set_updated_at on public.growth_campaigns;
create trigger growth_campaigns_set_updated_at
  before update on public.growth_campaigns
  for each row execute procedure public.set_updated_at();

drop trigger if exists growth_creatives_set_updated_at on public.growth_creatives;
create trigger growth_creatives_set_updated_at
  before update on public.growth_creatives
  for each row execute procedure public.set_updated_at();

drop trigger if exists growth_experiments_set_updated_at on public.growth_experiments;
create trigger growth_experiments_set_updated_at
  before update on public.growth_experiments
  for each row execute procedure public.set_updated_at();

drop trigger if exists growth_actions_set_updated_at on public.growth_actions;
create trigger growth_actions_set_updated_at
  before update on public.growth_actions
  for each row execute procedure public.set_updated_at();

-- ---------- Row Level Security ----------
alter table public.growth_events enable row level security;
alter table public.growth_booking_job_links enable row level security;
alter table public.growth_campaigns enable row level security;
alter table public.growth_campaign_daily_metrics enable row level security;
alter table public.growth_creatives enable row level security;
alter table public.growth_creative_daily_metrics enable row level security;
alter table public.growth_experiments enable row level security;
alter table public.growth_ai_insights enable row level security;
alter table public.growth_actions enable row level security;
alter table public.growth_alerts enable row level security;
alter table public.growth_import_runs enable row level security;
alter table public.growth_source_rules enable row level security;

revoke all on
  public.growth_events, public.growth_booking_job_links, public.growth_campaigns,
  public.growth_campaign_daily_metrics, public.growth_creatives, public.growth_creative_daily_metrics,
  public.growth_experiments, public.growth_ai_insights, public.growth_actions, public.growth_alerts,
  public.growth_import_runs, public.growth_source_rules
from anon;

-- growth_events: admin can READ ONLY. Insert happens exclusively through
-- the service-role key inside /api/growth-ingest — deliberately no insert
-- policy for "authenticated" at all here.
revoke all on public.growth_events from authenticated;
drop policy if exists growth_events_admin_select on public.growth_events;
create policy growth_events_admin_select on public.growth_events
  for select to authenticated using (public.is_admin());
grant select on public.growth_events to authenticated;
-- (no sequence grant here: this table's id is uuid-based, not an identity
-- column, so there is no growth_events_id_seq to grant on)

-- All other growth_* tables: full admin CRUD from the browser, same shape
-- as employees/customers/jobs policies already in schema.sql. Employees
-- get nothing (no policy for them at all -> RLS default-denies).
do $$
declare
  t text;
begin
  foreach t in array array[
    'growth_booking_job_links', 'growth_campaigns', 'growth_campaign_daily_metrics',
    'growth_creatives', 'growth_creative_daily_metrics', 'growth_experiments',
    'growth_ai_insights', 'growth_actions', 'growth_alerts', 'growth_import_runs',
    'growth_source_rules'
  ]
  loop
    execute format('drop policy if exists %I_admin_all on public.%I;', t, t);
    execute format(
      'create policy %I_admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin());',
      t, t
    );
    execute format('grant select, insert, update, delete on public.%I to authenticated;', t);
  end loop;
end $$;

grant usage, select on sequence public.growth_campaign_daily_metrics_id_seq to authenticated;
grant usage, select on sequence public.growth_creative_daily_metrics_id_seq to authenticated;

commit;

-- ---------- Sanity check ----------
select
  'Migration 003 (Growth OS foundation) applied successfully' as result,
  (select count(*) from public.growth_events) as growth_events_rows,
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_name like 'growth_%') as growth_tables_created;
