-- ============================================================
-- 20261124_unfiled_photos.sql
-- Holding tray for photos uploaded in bulk that are not yet attached to an
-- item (Supply -> My inventory -> Unfiled). The admin tags them one by one:
-- each photo is moved onto an item, or deleted. Admin only. The files live in
-- the supplier-media bucket under <poda supplier id>/unfiled/, which the
-- existing admin storage policies already cover.
-- Safe to re-run. Deletes nothing.
-- ============================================================

create table if not exists public.unfiled_photos (
  id          uuid primary key default gen_random_uuid(),
  path        text not null,
  label       text,                       -- original file name, for reference
  created_at  timestamptz not null default now()
);

alter table public.unfiled_photos enable row level security;

drop policy if exists "Admin manages unfiled photos" on public.unfiled_photos;
create policy "Admin manages unfiled photos"
  on public.unfiled_photos for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Quick check: should return one row.
select count(*) as unfiled_photos_table_ready from public.unfiled_photos;
