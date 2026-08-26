-- Factory Clean OS — Migration 002: VAT support for jobs
-- Run once in the Supabase SQL Editor, AFTER schema.sql is already applied.
--
-- Design goals (per FACTORY OS — FINANCE + VAT + EMPLOYEE SYSTEM UPDATE spec):
--   * Purely additive. No existing column, function, trigger, view, policy,
--     or row is dropped, renamed, or rewritten.
--   * gross_amount keeps meaning exactly what it means today: the job price
--     BEFORE VAT. That is the single source of truth calculate_job_money()
--     already uses for employee_pay and factory_net — this migration does
--     not touch that function at all, so employee pay and factory net are
--     mathematically guaranteed to stay VAT-free with zero risk of the two
--     calculations drifting apart in the future.
--   * vat_amount and total_with_vat are PostgreSQL generated (computed)
--     columns, not trigger-maintained fields. That means: (a) there is no
--     second code path that can fall out of sync with gross_amount/vat_rate,
--     and (b) Postgres backfills them automatically for every existing job
--     the moment the column is added — no manual UPDATE, no risk of missing
--     a row.
--   * Existing jobs (no VAT info today) automatically get vat_enabled=false,
--     vat_amount=0, total_with_vat=gross_amount — i.e. treated as "no VAT",
--     exactly as requested, with no data rewritten.
--   * vat_rate lives per-job (not hardcoded in any function), defaulting to
--     18. Changing the site-wide default later is a single
--     "alter column ... set default" statement — no code/function changes.

begin;

-- Step 1: plain columns. vat_rate is stored even when vat_enabled is false
-- (it's simply ignored by the generated columns below in that case) so the
-- UI always has a sensible prefilled rate the moment VAT is toggled on.
alter table public.jobs
  add column if not exists vat_enabled boolean not null default false;

alter table public.jobs
  add column if not exists vat_rate numeric(5,2) not null default 18
    check (vat_rate >= 0 and vat_rate <= 100);

-- Step 2: generated columns, added in a separate statement so they can
-- reference the columns from step 1. Never set directly by the app —
-- Postgres rejects any insert/update that tries to write to them, which is
-- an extra guardrail against ever inventing a second source of truth.
alter table public.jobs
  add column if not exists vat_amount numeric(12,2)
    generated always as (
      case when vat_enabled then round(gross_amount * vat_rate / 100.0, 2) else 0 end
    ) stored;

alter table public.jobs
  add column if not exists total_with_vat numeric(12,2)
    generated always as (
      gross_amount + case when vat_enabled then round(gross_amount * vat_rate / 100.0, 2) else 0 end
    ) stored;

commit;

-- ---------- Sanity check ----------
-- Confirms the migration applied and that every existing job (VAT info did
-- not exist before this migration) landed on the safe "no VAT" default.
select
  'Migration 002 (VAT) applied successfully' as result,
  count(*) as total_jobs,
  count(*) filter (where vat_enabled) as jobs_with_vat_enabled,
  count(*) filter (where not vat_enabled and total_with_vat = gross_amount) as legacy_jobs_correctly_defaulted
from public.jobs;
