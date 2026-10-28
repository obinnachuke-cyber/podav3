-- ============================================================
-- SUPABASE_FOUNDATION.sql
-- The base tables and storage buckets the site needs BEFORE the marketplace
-- scripts (MARKETPLACE_APPLY_PART1.sql) can run. Consolidates the SQL from
-- SUPABASE_SETUP.md, NOTES_SETUP.md, ARCHIVE_SETUP.md, OVERHAUL_SETUP.md,
-- SUBSCRIBERS_SETUP.md and MARKET_NOTES_STUDIO_SETUP.md.
--
-- Safe to run on a project that already has some or all of these: every
-- table is "if not exists" and every policy is dropped and recreated, so
-- existing rows are never touched.
--
-- Note: write access for note-media and for notes/studies/drops is
-- tightened to admin-only by MARKETPLACE_APPLY_PART1.sql, which runs next.
-- ============================================================

-- ===== items (SUPABASE_SETUP.md) =====
create table if not exists public.items (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists items_touch_updated_at on public.items;
create trigger items_touch_updated_at
  before update on public.items
  for each row execute function public.touch_updated_at();

alter table public.items enable row level security;

drop policy if exists "Public can read items" on public.items;
create policy "Public can read items"
  on public.items for select using (true);

drop policy if exists "Admin can insert items" on public.items;
create policy "Admin can insert items"
  on public.items for insert to authenticated with check (true);

drop policy if exists "Admin can update items" on public.items;
create policy "Admin can update items"
  on public.items for update to authenticated using (true) with check (true);

drop policy if exists "Admin can delete items" on public.items;
create policy "Admin can delete items"
  on public.items for delete to authenticated using (true);

-- ===== notes (NOTES_SETUP.md) =====
create table if not exists public.notes (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.notes enable row level security;

drop policy if exists "Public read published notes" on public.notes;
create policy "Public read published notes"
  on public.notes for select
  using ( (data->>'status') = 'published' );

drop policy if exists "Admin full access to notes" on public.notes;
create policy "Admin full access to notes"
  on public.notes for all
  using ( auth.role() = 'authenticated' )
  with check ( auth.role() = 'authenticated' );

create unique index if not exists notes_slug_unique_idx
  on public.notes ((data->>'slug'))
  where (data->>'slug') is not null and (data->>'slug') <> '';

-- ===== archive_images (ARCHIVE_SETUP.md) =====
create table if not exists public.archive_images (
  id          text        primary key,
  data        jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

alter table public.archive_images enable row level security;

drop policy if exists "Public can read archive images" on public.archive_images;
create policy "Public can read archive images"
  on public.archive_images for select using (true);

drop policy if exists "Authenticated users can manage archive images" on public.archive_images;
create policy "Authenticated users can manage archive images"
  on public.archive_images for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- ===== drops and studies (OVERHAUL_SETUP.md) =====
create table if not exists public.drops (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.drops enable row level security;

drop policy if exists "Public can read drops" on public.drops;
create policy "Public can read drops"
  on public.drops for select using (true);

drop policy if exists "Admin full access to drops" on public.drops;
create policy "Admin full access to drops"
  on public.drops for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

create table if not exists public.studies (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.studies enable row level security;

drop policy if exists "Public can read studies" on public.studies;
create policy "Public can read studies"
  on public.studies for select using (true);

drop policy if exists "Admin full access to studies" on public.studies;
create policy "Admin full access to studies"
  on public.studies for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- ===== subscribers (SUBSCRIBERS_SETUP.md) =====
create table if not exists public.subscribers (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

create unique index if not exists subscribers_email_unique
  on public.subscribers ((lower(data->>'email')));

alter table public.subscribers enable row level security;

drop policy if exists "Anyone can subscribe" on public.subscribers;
create policy "Anyone can subscribe"
  on public.subscribers for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Admin can read subscribers" on public.subscribers;
create policy "Admin can read subscribers"
  on public.subscribers for select
  to authenticated using (true);

drop policy if exists "Admin can update subscribers" on public.subscribers;
create policy "Admin can update subscribers"
  on public.subscribers for update
  to authenticated using (true) with check (true);

drop policy if exists "Admin can delete subscribers" on public.subscribers;
create policy "Admin can delete subscribers"
  on public.subscribers for delete
  to authenticated using (true);

-- ===== storage: item-images (SUPABASE_SETUP.md) =====
insert into storage.buckets (id, name, public)
values ('item-images', 'item-images', true)
on conflict (id) do nothing;

drop policy if exists "Public can view item images" on storage.objects;
create policy "Public can view item images"
  on storage.objects for select using (bucket_id = 'item-images');

drop policy if exists "Admin can upload item images" on storage.objects;
create policy "Admin can upload item images"
  on storage.objects for insert to authenticated with check (bucket_id = 'item-images');

drop policy if exists "Admin can update item images" on storage.objects;
create policy "Admin can update item images"
  on storage.objects for update to authenticated using (bucket_id = 'item-images');

drop policy if exists "Admin can delete item images" on storage.objects;
create policy "Admin can delete item images"
  on storage.objects for delete to authenticated using (bucket_id = 'item-images');

-- ===== storage: submissions — public form uploads (OVERHAUL_SETUP.md) =====
insert into storage.buckets (id, name, public)
values ('submissions', 'submissions', true)
on conflict (id) do nothing;

drop policy if exists "Public can view submissions" on storage.objects;
create policy "Public can view submissions"
  on storage.objects for select using (bucket_id = 'submissions');

drop policy if exists "Anyone can upload a submission" on storage.objects;
create policy "Anyone can upload a submission"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'submissions');

-- ===== storage: note-media (MARKET_NOTES_STUDIO_SETUP.md) =====
-- Public read only here. The broader "any signed-in user may write" policies
-- from the original guide are removed on purpose; MARKETPLACE_APPLY_PART1
-- adds the admin-only write policies once is_admin() exists.
insert into storage.buckets (id, name, public)
values ('note-media', 'note-media', true)
on conflict (id) do nothing;

drop policy if exists "Public can view note media" on storage.objects;
create policy "Public can view note media"
  on storage.objects for select using (bucket_id = 'note-media');

drop policy if exists "Admin can upload note media" on storage.objects;
drop policy if exists "Admin can update note media" on storage.objects;
drop policy if exists "Admin can delete note media" on storage.objects;
