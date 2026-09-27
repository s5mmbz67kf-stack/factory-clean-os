begin;
create index if not exists growth_agent_approvals_run_idx on public.growth_agent_approvals(run_id);
create index if not exists growth_agent_approvals_decided_by_idx on public.growth_agent_approvals(decided_by);
commit;
