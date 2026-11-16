-- ============================================================
-- 20261114_index_clicks.sql
-- Counts clicks on an Index entry's Instagram link. The Worker writes one row
-- per click with the service key; only the admin can read them. Safe to
-- re-run. Run it any time: without it the links still work, they just are not
-- counted.
-- ============================================================

create table if not exists public.index_clicks (
  id         bigserial primary key,
  study_id   text not null,
  created_at timestamptz not null default now()
);

create index if not exists index_clicks_study_idx on public.index_clicks (study_id, created_at desc);

alter table public.index_clicks enable row level security;
drop policy if exists "Admin reads index clicks" on public.index_clicks;
create policy "Admin reads index clicks"
  on public.index_clicks for select to authenticated
  using (public.is_admin());

-- No insert policy on purpose: only the Worker's service key writes here.
