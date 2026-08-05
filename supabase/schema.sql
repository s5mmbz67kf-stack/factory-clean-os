-- Factory Clean OS 2 — Database schema, security and realtime
-- Run once in the Supabase SQL Editor.

begin;

create extension if not exists pgcrypto;

-- ---------- Enum types ----------
do $$ begin
  create type public.account_role as enum ('admin', 'employee');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.job_source as enum ('regular', 'midrag', 'owner');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.job_status as enum ('pending', 'approved', 'completed', 'rejected', 'cancelled');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.pay_mode as enum ('percentage', 'fixed', 'none');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.marketing_consent as enum ('unknown', 'approved', 'declined');
exception when duplicate_object then null;
end $$;

-- ---------- Core tables ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.account_role not null default 'employee',
  full_name text not null default '',
  phone text,
  avatar_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references public.profiles(id) on delete set null,
  name text not null,
  phone text,
  regular_rate numeric(5,2) not null default 45 check (regular_rate between 0 and 100),
  midrag_rate numeric(5,2) not null default 37.5 check (midrag_rate between 0 and 100),
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists employees_phone_unique
  on public.employees(phone)
  where phone is not null and btrim(phone) <> '';

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  business_name text,
  contact_person text,
  phone text,
  email text,
  city text,
  address text,
  business_number text,
  marketing_consent public.marketing_consent not null default 'unknown',
  tags text[] not null default '{}',
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customers_phone_idx on public.customers(phone);
create index if not exists customers_name_idx on public.customers(customer_name);
create index if not exists customers_city_idx on public.customers(city);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete set null,
  job_date date not null default current_date,
  service_type text not null,
  city text,
  source public.job_source not null default 'regular',
  status public.job_status not null default 'pending',

  gross_amount numeric(12,2) not null default 0 check (gross_amount >= 0),
  direct_expenses numeric(12,2) not null default 0 check (direct_expenses >= 0),

  pay_mode public.pay_mode not null default 'percentage',
  use_default_rate boolean not null default true,
  rate_percent numeric(5,2) check (rate_percent between 0 and 100),
  fixed_pay numeric(12,2) not null default 0 check (fixed_pay >= 0),

  employee_pay numeric(12,2) not null default 0,
  factory_net numeric(12,2) not null default 0,

  notes text,
  submitted_by uuid references public.profiles(id) on delete set null,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_employee_date_idx on public.jobs(employee_id, job_date desc);
create index if not exists jobs_customer_idx on public.jobs(customer_id);
create index if not exists jobs_status_idx on public.jobs(status);
create index if not exists jobs_created_at_idx on public.jobs(created_at desc);

create table if not exists public.employee_payments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  payment_date date not null default current_date,
  payment_method text,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists employee_payments_employee_date_idx
  on public.employee_payments(employee_id, payment_date desc);

create table if not exists public.job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.jobs(id) on delete cascade,
  event_type text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists job_events_job_idx on public.job_events(job_id, created_at desc);

-- ---------- Utility functions ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
      and p.active = true
  );
$$;

create or replace function public.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id
  from public.employees e
  where e.user_id = auth.uid()
    and e.active = true
  limit 1;
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.phone, new.raw_user_meta_data ->> 'phone')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.calculate_job_money()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_regular numeric(5,2);
  v_midrag numeric(5,2);
  v_is_admin boolean;
begin
  v_is_admin := coalesce(public.is_admin(), false);

  select e.regular_rate, e.midrag_rate
    into v_regular, v_midrag
  from public.employees e
  where e.id = new.employee_id;

  if not found then
    raise exception 'Employee does not exist';
  end if;

  -- Employees cannot approve their own work or manipulate their pay settings.
  if auth.uid() is not null and not v_is_admin then
    new.status := 'pending';
    new.approved_by := null;
    new.approved_at := null;
    new.pay_mode := 'percentage';
    new.use_default_rate := true;
    new.fixed_pay := 0;
  end if;

  new.gross_amount := greatest(coalesce(new.gross_amount, 0), 0);
  new.direct_expenses := greatest(coalesce(new.direct_expenses, 0), 0);

  if new.pay_mode = 'none' or new.source = 'owner' then
    new.rate_percent := 0;
    new.employee_pay := 0;
  elsif new.pay_mode = 'fixed' then
    new.rate_percent := 0;
    new.employee_pay := greatest(coalesce(new.fixed_pay, 0), 0);
  else
    if new.use_default_rate or new.rate_percent is null then
      new.rate_percent := case
        when new.source = 'midrag' then v_midrag
        else v_regular
      end;
    end if;
    new.employee_pay := round(new.gross_amount * new.rate_percent / 100.0, 2);
  end if;

  new.factory_net := round(new.gross_amount - new.direct_expenses - new.employee_pay, 2);

  if new.status in ('approved', 'completed') and new.approved_at is null then
    new.approved_at := now();
    if v_is_admin and new.approved_by is null then
      new.approved_by := auth.uid();
    end if;
  elsif new.status not in ('approved', 'completed') then
    new.approved_at := null;
    new.approved_by := null;
  end if;

  return new;
end;
$$;

create or replace function public.log_job_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.job_events(job_id, event_type, actor_id, details)
    values (new.id, 'created', auth.uid(), jsonb_build_object('status', new.status));
    return new;
  elsif tg_op = 'UPDATE' then
    if old.status is distinct from new.status then
      insert into public.job_events(job_id, event_type, actor_id, details)
      values (
        new.id,
        'status_changed',
        auth.uid(),
        jsonb_build_object('from', old.status, 'to', new.status)
      );
    else
      insert into public.job_events(job_id, event_type, actor_id, details)
      values (new.id, 'updated', auth.uid(), '{}'::jsonb);
    end if;
    return new;
  end if;
  return null;
end;
$$;

-- ---------- Triggers ----------
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();

drop trigger if exists employees_set_updated_at on public.employees;
create trigger employees_set_updated_at
  before update on public.employees
  for each row execute procedure public.set_updated_at();

drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at
  before update on public.customers
  for each row execute procedure public.set_updated_at();

drop trigger if exists jobs_calculate_money on public.jobs;
create trigger jobs_calculate_money
  before insert or update on public.jobs
  for each row execute procedure public.calculate_job_money();

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute procedure public.set_updated_at();

drop trigger if exists jobs_log_insert on public.jobs;
create trigger jobs_log_insert
  after insert on public.jobs
  for each row execute procedure public.log_job_change();

drop trigger if exists jobs_log_update on public.jobs;
create trigger jobs_log_update
  after update on public.jobs
  for each row execute procedure public.log_job_change();

-- ---------- Reporting views ----------
create or replace view public.employee_financial_summary
with (security_invoker = true)
as
select
  e.id as employee_id,
  e.name,
  e.regular_rate,
  e.midrag_rate,
  count(j.id) filter (where j.status in ('approved', 'completed')) as approved_jobs,
  coalesce(sum(j.gross_amount) filter (where j.status in ('approved', 'completed')), 0)::numeric(12,2) as gross_total,
  coalesce(sum(j.employee_pay) filter (where j.status in ('approved', 'completed')), 0)::numeric(12,2) as earned_total,
  coalesce(p.paid_total, 0)::numeric(12,2) as paid_total,
  (
    coalesce(sum(j.employee_pay) filter (where j.status in ('approved', 'completed')), 0)
    - coalesce(p.paid_total, 0)
  )::numeric(12,2) as balance_due
from public.employees e
left join public.jobs j on j.employee_id = e.id
left join lateral (
  select sum(ep.amount) as paid_total
  from public.employee_payments ep
  where ep.employee_id = e.id
) p on true
group by e.id, e.name, e.regular_rate, e.midrag_rate, p.paid_total;

create or replace view public.customer_activity_summary
with (security_invoker = true)
as
select
  c.id as customer_id,
  c.customer_name,
  c.business_name,
  c.phone,
  c.city,
  count(j.id) filter (where j.status in ('approved', 'completed')) as total_jobs,
  count(j.id) filter (
    where j.status in ('approved', 'completed')
      and extract(year from j.job_date) = extract(year from current_date)
  ) as jobs_this_year,
  coalesce(sum(j.gross_amount) filter (where j.status in ('approved', 'completed')), 0)::numeric(12,2) as lifetime_revenue,
  coalesce(avg(j.gross_amount) filter (where j.status in ('approved', 'completed')), 0)::numeric(12,2) as average_order,
  max(j.job_date) filter (where j.status in ('approved', 'completed')) as last_job_date
from public.customers c
left join public.jobs j on j.customer_id = c.id
group by c.id, c.customer_name, c.business_name, c.phone, c.city;

-- ---------- Row Level Security ----------
alter table public.profiles enable row level security;
alter table public.employees enable row level security;
alter table public.customers enable row level security;
alter table public.jobs enable row level security;
alter table public.employee_payments enable row level security;
alter table public.job_events enable row level security;

-- Profiles
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
for select to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
for update to authenticated
using (id = auth.uid() or public.is_admin())
with check (id = auth.uid() or public.is_admin());

-- Employees
drop policy if exists employees_select on public.employees;
create policy employees_select on public.employees
for select to authenticated
using (public.is_admin() or user_id = auth.uid());

drop policy if exists employees_admin_insert on public.employees;
create policy employees_admin_insert on public.employees
for insert to authenticated
with check (public.is_admin());

drop policy if exists employees_admin_update on public.employees;
create policy employees_admin_update on public.employees
for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists employees_admin_delete on public.employees;
create policy employees_admin_delete on public.employees
for delete to authenticated
using (public.is_admin());

-- Customers
drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers
for select to authenticated
using (
  public.is_admin()
  or created_by = auth.uid()
  or exists (
    select 1 from public.jobs j
    where j.customer_id = customers.id
      and j.employee_id = public.current_employee_id()
  )
);

drop policy if exists customers_insert on public.customers;
create policy customers_insert on public.customers
for insert to authenticated
with check (public.is_admin() or created_by = auth.uid());

drop policy if exists customers_update on public.customers;
create policy customers_update on public.customers
for update to authenticated
using (
  public.is_admin()
  or created_by = auth.uid()
  or exists (
    select 1 from public.jobs j
    where j.customer_id = customers.id
      and j.employee_id = public.current_employee_id()
  )
)
with check (
  public.is_admin()
  or created_by = auth.uid()
  or exists (
    select 1 from public.jobs j
    where j.customer_id = customers.id
      and j.employee_id = public.current_employee_id()
  )
);

drop policy if exists customers_admin_delete on public.customers;
create policy customers_admin_delete on public.customers
for delete to authenticated
using (public.is_admin());

-- Jobs
drop policy if exists jobs_select on public.jobs;
create policy jobs_select on public.jobs
for select to authenticated
using (public.is_admin() or employee_id = public.current_employee_id());

drop policy if exists jobs_insert on public.jobs;
create policy jobs_insert on public.jobs
for insert to authenticated
with check (
  public.is_admin()
  or (
    employee_id = public.current_employee_id()
    and submitted_by = auth.uid()
    and status = 'pending'
  )
);

drop policy if exists jobs_update on public.jobs;
create policy jobs_update on public.jobs
for update to authenticated
using (
  public.is_admin()
  or (
    employee_id = public.current_employee_id()
    and submitted_by = auth.uid()
    and status = 'pending'
  )
)
with check (
  public.is_admin()
  or (
    employee_id = public.current_employee_id()
    and submitted_by = auth.uid()
    and status = 'pending'
  )
);

drop policy if exists jobs_admin_delete on public.jobs;
create policy jobs_admin_delete on public.jobs
for delete to authenticated
using (public.is_admin());

-- Payments
drop policy if exists payments_select on public.employee_payments;
create policy payments_select on public.employee_payments
for select to authenticated
using (public.is_admin() or employee_id = public.current_employee_id());

drop policy if exists payments_admin_insert on public.employee_payments;
create policy payments_admin_insert on public.employee_payments
for insert to authenticated
with check (public.is_admin());

drop policy if exists payments_admin_update on public.employee_payments;
create policy payments_admin_update on public.employee_payments
for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists payments_admin_delete on public.employee_payments;
create policy payments_admin_delete on public.employee_payments
for delete to authenticated
using (public.is_admin());

-- Job events
drop policy if exists job_events_select on public.job_events;
create policy job_events_select on public.job_events
for select to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.jobs j
    where j.id = job_events.job_id
      and j.employee_id = public.current_employee_id()
  )
);

drop policy if exists job_events_admin_insert on public.job_events;
create policy job_events_admin_insert on public.job_events
for insert to authenticated
with check (public.is_admin());

-- ---------- API grants ----------
revoke all on public.profiles, public.employees, public.customers, public.jobs,
  public.employee_payments, public.job_events from anon;

revoke all on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant update (full_name, phone, avatar_url) on public.profiles to authenticated;

grant select, insert, update, delete on public.employees to authenticated;
grant select, insert, update, delete on public.customers to authenticated;
grant select, insert, update, delete on public.jobs to authenticated;
grant select, insert, update, delete on public.employee_payments to authenticated;
grant select, insert on public.job_events to authenticated;
grant select on public.employee_financial_summary, public.customer_activity_summary to authenticated;
grant usage, select on sequence public.job_events_id_seq to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.current_employee_id() to authenticated;

-- ---------- Initial owner employee record ----------
insert into public.employees (name, regular_rate, midrag_rate, notes)
select 'יצחק', 0, 0, 'בעל העסק — ללא שכר עובד'
where not exists (
  select 1 from public.employees where name = 'יצחק'
);

commit;

-- ---------- Enable Realtime safely ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'jobs'
  ) then
    alter publication supabase_realtime add table public.jobs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'employee_payments'
  ) then
    alter publication supabase_realtime add table public.employee_payments;
  end if;
end $$;

-- Success check
select
  'Factory Clean OS schema installed successfully' as result,
  (select count(*) from public.employees) as employees_created;
