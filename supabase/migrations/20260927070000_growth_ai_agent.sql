-- Factory Growth AI agent: durable runs, settings and human approval queue.
-- Additive only. The service role runs the agent; admins read/manage its output.

begin;

create table if not exists public.growth_agent_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default true,
  autonomy_level text not null default 'balanced'
    check (autonomy_level in ('observe', 'balanced', 'aggressive')),
  daily_run_hour integer not null default 5 check (daily_run_hour between 0 and 23),
  max_actions_per_run integer not null default 5 check (max_actions_per_run between 1 and 10),
  require_approval_for_external_changes boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.growth_agent_settings (id)
values (true)
on conflict (id) do nothing;

create table if not exists public.growth_agent_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null check (trigger in ('manual', 'scheduled')),
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'skipped')),
  period_from date not null,
  period_to date not null,
  data_snapshot jsonb not null default '{}'::jsonb,
  executive_summary text,
  insights_created integer not null default 0,
  actions_created integer not null default 0,
  approvals_created integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.growth_agent_approvals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.growth_agent_runs(id) on delete set null,
  action_type text not null,
  title text not null,
  rationale text not null,
  payload jsonb not null default '{}'::jsonb,
  expected_impact text,
  risk_level text not null default 'medium' check (risk_level in ('low', 'medium', 'high')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'executed', 'failed')),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  execution_result jsonb,
  created_at timestamptz not null default now()
);

create index if not exists growth_agent_runs_started_idx on public.growth_agent_runs(started_at desc);
create index if not exists growth_agent_approvals_status_idx on public.growth_agent_approvals(status, created_at desc);

alter table public.growth_agent_settings enable row level security;
alter table public.growth_agent_runs enable row level security;
alter table public.growth_agent_approvals enable row level security;

revoke all on public.growth_agent_settings, public.growth_agent_runs, public.growth_agent_approvals from anon;

do $$
declare t text;
begin
  foreach t in array array['growth_agent_settings', 'growth_agent_runs', 'growth_agent_approvals']
  loop
    execute format('drop policy if exists %I_admin_all on public.%I;', t, t);
    execute format(
      'create policy %I_admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin());',
      t, t
    );
  end loop;
end $$;

grant select, insert, update, delete on
  public.growth_agent_settings, public.growth_agent_runs, public.growth_agent_approvals
to authenticated;

commit;
