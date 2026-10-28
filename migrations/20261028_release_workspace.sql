-- ============================================================
-- 20261028_release_workspace.sql
-- Targeted, repeatable migration for the release workspace, the timed
-- Shop drop, private working revisions, and the access fixes from the audit.
--
-- PREREQUISITES: the marketplace tables from MARKETPLACE_APPLY_PART1.sql
-- (edits, edit_placements, products, suppliers, folder_updates) and your
-- admin row in public.profiles (MARKETPLACE_APPLY_PART2_ADMIN.sql).
-- Do NOT run the old aggregate setup files; this file supersedes the
-- public_products view in FOLDERS_PUBLIC_SETUP.sql.
--
-- Safe to re-run: columns/tables are "if not exists", functions are
-- "or replace", policies are dropped and recreated, views are dropped and
-- recreated (views hold no data). No table is dropped and no row is deleted.
-- The only data change is the study backfill in section 8, which marks the
-- studies that are public today as published so they stay public.
--
-- Run it in the Supabase SQL editor, then deploy the matching site code.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Preconditions. Fail early with a clear message instead of halfway.
-- ------------------------------------------------------------
do $$
declare
  missing text;
begin
  select string_agg(t, ', ') into missing
  from unnest(array[
    'profiles', 'suppliers', 'supplier_users', 'products', 'product_images',
    'edits', 'edit_placements', 'folder_updates',
    'items', 'notes', 'studies', 'drops', 'subscribers', 'archive_images'
  ]) as t
  where to_regclass('public.' || t) is null;

  if missing is not null then
    raise exception 'Missing tables: %. Create the base tables first (SUPABASE_FOUNDATION.sql, then MARKETPLACE_APPLY_PART1.sql); this migration does not create them.', missing;
  end if;

  if to_regprocedure('public.is_admin()') is null then
    raise exception 'public.is_admin() is missing. Run MARKETPLACE_APPLY_PART1.sql first.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. Release columns
--    publish_at (existing, timestamptz = UTC) is the scheduled drop moment.
--    launched_at is a manual launch; it wins over publish_at.
-- ------------------------------------------------------------
alter table public.edits
  add column if not exists is_working    boolean not null default false,
  add column if not exists launched_at   timestamptz,
  add column if not exists cover_image   text,
  add column if not exists drop_timezone text;

-- At most one release is "the one being prepared".
create unique index if not exists edits_one_working_idx
  on public.edits (is_working) where is_working;

-- ------------------------------------------------------------
-- 2. Guard: a release cannot be scheduled while missing essentials.
-- ------------------------------------------------------------
create or replace function public.edits_guard()
returns trigger
language plpgsql
as $$
declare
  drop_changed   boolean := false;
  status_changed boolean := false;
  launch_new     boolean := false;
begin
  new.updated_at := now();

  -- OLD does not exist on INSERT, so it is only read inside the UPDATE branch.
  if tg_op = 'INSERT' then
    drop_changed   := new.publish_at is not null;
    launch_new     := new.launched_at is not null;
  else
    drop_changed   := new.publish_at is distinct from old.publish_at;
    status_changed := new.status is distinct from old.status;
    launch_new     := new.launched_at is not null and old.launched_at is null;
  end if;

  -- Scheduling (or rescheduling) a drop.
  if new.publish_at is not null and drop_changed then
    if coalesce(btrim(new.title), '') = '' or new.number is null then
      raise exception 'A release needs a title and a number before a drop can be scheduled.';
    end if;
    if new.status = 'draft' then
      raise exception 'Open the release before scheduling its drop.';
    end if;
    if tg_op = 'UPDATE' then
      if not exists (select 1 from public.edit_placements where edit_id = new.id) then
        raise exception 'Select at least one product before scheduling the drop.';
      end if;
    end if;
  end if;

  -- A release that has a drop (or has launched) cannot go back to draft.
  if tg_op = 'UPDATE' and new.status = 'draft'
     and (status_changed or drop_changed or launch_new)
     and (new.publish_at is not null or new.launched_at is not null) then
    raise exception 'Cancel the drop before returning a release to draft.';
  end if;

  -- Manual launch.
  if launch_new then
    if new.status in ('draft', 'archived') then
      raise exception 'Only an open release can be launched.';
    end if;
    new.published_at := coalesce(new.published_at, new.launched_at);
  end if;

  return new;
end;
$$;

drop trigger if exists edits_guard_trg on public.edits;
create trigger edits_guard_trg
  before insert or update on public.edits
  for each row execute function public.edits_guard();

-- ------------------------------------------------------------
-- 3. Switching the working release is atomic (the unique index above
--    would otherwise reject a two-step swap).
-- ------------------------------------------------------------
create or replace function public.set_working_release(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;
  update public.edits set is_working = false where is_working and id <> p_id;
  update public.edits set is_working = true where id = p_id;
end;
$$;

revoke all on function public.set_working_release(uuid) from public;
grant execute on function public.set_working_release(uuid) to authenticated;

-- Give an existing install a working release: the newest unfinished one.
update public.edits set is_working = true
where id = (
  select id from public.edits
  where status <> 'archived'
  order by (status = 'draft') desc, created_at desc
  limit 1
)
and not exists (select 1 from public.edits where is_working);

-- ------------------------------------------------------------
-- 4. Release activity, and private working revisions of published notes.
--    Both admin-only.
-- ------------------------------------------------------------
create table if not exists public.release_events (
  id         bigserial primary key,
  edit_id    uuid not null references public.edits(id) on delete cascade,
  event      text not null,
  detail     jsonb,
  actor_id   uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists release_events_edit_idx
  on public.release_events (edit_id, created_at desc);

alter table public.release_events enable row level security;
drop policy if exists "Admin manages release events" on public.release_events;
create policy "Admin manages release events"
  on public.release_events for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Unpublished edits to an already-published note live here, never in
-- public.notes (whose rows are world-readable once published).
create table if not exists public.note_revisions (
  note_id    text primary key references public.notes(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.note_revisions enable row level security;
drop policy if exists "Admin manages note revisions" on public.note_revisions;
create policy "Admin manages note revisions"
  on public.note_revisions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------
-- 5. Public views. Both run with the owner's rights so visitors never get
--    read access to the underlying tables, and both use now() so the
--    database - not the browser - decides when a drop is open.
-- ------------------------------------------------------------
drop view if exists public.public_releases;
create view public.public_releases as
with open_edits as (
  select e.*,
         (e.launched_at is not null
          or (e.publish_at is not null and e.publish_at <= now())) as dropped
  from public.edits e
  where e.status in ('scheduled', 'live', 'archived')
),
shop as (
  -- The release currently shown in Shop: the most recent drop that has
  -- happened and has not been archived. A newer drop replaces an older one.
  select id from open_edits
  where dropped and status <> 'archived'
  order by coalesce(launched_at, publish_at) desc, number desc nulls last
  limit 1
)
select o.id, o.number, o.title, o.standfirst, o.status,
       o.publish_at, o.published_at, o.launched_at,
       o.cover_image, o.drop_timezone, o.created_at,
       o.dropped                           as drop_open,
       (o.id = (select id from shop))      as is_shop,
       now()                               as server_now
from open_edits o;

grant select on public.public_releases to anon, authenticated;

drop view if exists public.public_products;
create view public.public_products as
select
  pl.id                                   as placement_id,
  pl.edit_id,
  pl.position,
  p.id                                    as product_id,
  coalesce(pl.editorial_title, p.title)   as title,
  case when p.state = 'accepted' and p.is_available
       then coalesce(pl.editorial_copy, p.description) end  as copy,
  p.brand,
  p.category,
  p.color,
  p.material,
  case when p.state = 'accepted' and p.is_available
       then p.condition end               as condition,
  case when p.state = 'accepted' and p.is_available
       then p.condition_notes end         as condition_notes,
  case when p.state = 'accepted' and p.is_available
       then p.measurements end            as measurements,
  case when p.state = 'accepted' and p.is_available
       then p.price_cents end             as price_cents,
  p.currency,
  p.is_unique,
  p.quantity,
  coalesce(p.state = 'accepted' and p.is_available and p.quantity > 0, false) as is_available,
  case when p.state = 'accepted' and p.is_available and p.quantity > 0 then 'available'
       when p.state = 'accepted' and p.is_available then 'sold'
       else 'unavailable' end             as availability,
  case when p.state = 'accepted' and p.is_available
       then coalesce((
         select array_agg(i.path
                  order by coalesce(i.id = pl.hero_image_id, false) desc,
                           i.position, i.id)
         from public.product_images i
         where i.product_id = pl.product_id
       ), '{}'::text[])
       else '{}'::text[] end              as image_paths,
  case when s.type = 'consignor' then null else s.name end as supplier_name,
  s.type                                  as supplier_type
from public.edit_placements pl
join public.edits e
  on e.id = pl.edit_id
 and e.status in ('scheduled', 'live', 'archived')
 and (e.launched_at is not null
      or (e.publish_at is not null and e.publish_at <= now()))
left join public.products  p on p.id = pl.product_id
left join public.suppliers s on s.id = p.supplier_id;

grant select on public.public_products to anon, authenticated;

-- Placements are no longer readable by visitors directly; the view above
-- is the only public path (and it applies the drop-time gate).
drop policy if exists "Public reads live placements" on public.edit_placements;

-- ------------------------------------------------------------
-- 6. Supplier product guard. Same rules as before, plus:
--    - a supplier can no longer flip is_available back to true (only an
--      admin clears a hold) or rewrite review fields;
--    - changing category also triggers the re-review hold.
-- ------------------------------------------------------------
create or replace function public.products_guard()
returns trigger language plpgsql as $$
declare
  false_change  boolean;
  price_change  boolean;
begin
  false_change :=
       new.condition      is distinct from old.condition
    or new.condition_notes is distinct from old.condition_notes
    or new.title          is distinct from old.title
    or new.brand          is distinct from old.brand
    or new.category       is distinct from old.category
    or new.currency       is distinct from old.currency
    or new.color          is distinct from old.color
    or new.material       is distinct from old.material
    or new.description    is distinct from old.description
    or new.measurements   is distinct from old.measurements;

  price_change := new.price_cents is distinct from old.price_cents;

  if public.is_admin() then
    if new.state is distinct from old.state then
      new.reviewed_at := now();
    end if;
    new.updated_at := now();
    return new;
  end if;

  if new.state not in ('draft','submitted','withdrawn') then
    raise exception 'Suppliers cannot set product state to %', new.state;
  end if;

  if new.commission_bps_override is distinct from old.commission_bps_override then
    raise exception 'Suppliers cannot change commission terms';
  end if;

  if new.supplier_id is distinct from old.supplier_id then
    raise exception 'Products cannot change owner';
  end if;

  -- Only an admin can clear an availability hold or write review fields.
  if new.is_available and not old.is_available then
    new.is_available := false;
  end if;
  new.review_note := old.review_note;
  new.reviewed_at := old.reviewed_at;

  if old.state = 'accepted' then
    if price_change then
      new.proposed_price_cents := new.price_cents;
      new.price_cents := old.price_cents;
    end if;
    if false_change then
      new.is_available := false;
    end if;
  end if;

  if old.state = 'draft' and new.state = 'submitted' then
    new.submitted_at := now();
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- ------------------------------------------------------------
-- 7. Legacy tables: admin-only. Today several allow any signed-in user
--    (and sign-up is open), and items/studies/drops are world-readable
--    including internal pricing, commission, owner and private notes.
--    No rows are touched; the old public pages that read them are retired.
-- ------------------------------------------------------------
-- items
drop policy if exists "Public can read items"   on public.items;
drop policy if exists "Admin can read items"    on public.items;
drop policy if exists "Admin can insert items"  on public.items;
drop policy if exists "Admin can update items"  on public.items;
drop policy if exists "Admin can delete items"  on public.items;
create policy "Admin can read items"
  on public.items for select to authenticated using (public.is_admin());
create policy "Admin can insert items"
  on public.items for insert to authenticated with check (public.is_admin());
create policy "Admin can update items"
  on public.items for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Admin can delete items"
  on public.items for delete to authenticated using (public.is_admin());

-- subscribers (anonymous INSERT stays: that is the signup form)
drop policy if exists "Admin can read subscribers"   on public.subscribers;
drop policy if exists "Admin can update subscribers" on public.subscribers;
drop policy if exists "Admin can delete subscribers" on public.subscribers;
create policy "Admin can read subscribers"
  on public.subscribers for select to authenticated using (public.is_admin());
create policy "Admin can update subscribers"
  on public.subscribers for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Admin can delete subscribers"
  on public.subscribers for delete to authenticated using (public.is_admin());

-- archive_images
drop policy if exists "Public can read archive images" on public.archive_images;
drop policy if exists "Authenticated users can manage archive images" on public.archive_images;
drop policy if exists "Admin manages archive images" on public.archive_images;
create policy "Admin manages archive images"
  on public.archive_images for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- legacy drops (the admin policy already requires is_admin())
drop policy if exists "Public can read drops" on public.drops;

-- storage: legacy item photos are admin-write
drop policy if exists "Admin can upload item images" on storage.objects;
drop policy if exists "Admin can update item images" on storage.objects;
drop policy if exists "Admin can delete item images" on storage.objects;
create policy "Admin can upload item images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'item-images' and public.is_admin());
create policy "Admin can update item images"
  on storage.objects for update to authenticated
  using (bucket_id = 'item-images' and public.is_admin());
create policy "Admin can delete item images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'item-images' and public.is_admin());

-- storage: supplier photos. The anonymous SELECT policy let anyone LIST the
-- bucket (including photos of products that have not dropped). Listing is
-- now limited to the admin and the owning supplier. Objects stay fetchable
-- by their exact URL (the bucket is public so the Shop can show them), and
-- those URLs contain two random UUIDs, so they cannot be guessed.
drop policy if exists "Public views supplier media" on storage.objects;
drop policy if exists "Admin or owner reads supplier media" on storage.objects;
create policy "Admin or owner reads supplier media"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'supplier-media'
    and (public.is_admin()
         or (storage.foldername(name))[1]::uuid in (select public.my_supplier_ids()))
  );

-- ------------------------------------------------------------
-- 8. Notes and studies: private until published, and never public through a
--    release that is still a draft.
--    A note/study with no folder is "independently published" (public once
--    its own status is published). One attached to a release also needs that
--    release to be open.
-- ------------------------------------------------------------
drop policy if exists "Public read published notes" on public.notes;
create policy "Public read published notes"
  on public.notes for select to anon, authenticated
  using (
    (data->>'status') = 'published'
    and (
      coalesce(data->>'folderId', '') = ''
      or exists (
        select 1 from public.edits e
        where e.id::text = data->>'folderId'
          and e.status in ('scheduled', 'live', 'archived')
      )
    )
  );

-- Studies had no status: keep today's public studies public by marking them
-- published (the only data change in this file). New sets start as drafts.
update public.studies
set data = jsonb_set(data, '{status}', '"published"')
where coalesce(data->>'status', '') = '';

drop policy if exists "Public can read studies"    on public.studies;
drop policy if exists "Public read published studies" on public.studies;
create policy "Public read published studies"
  on public.studies for select to anon, authenticated
  using (
    (data->>'status') = 'published'
    and (
      coalesce(data->>'relatedDropId', '') = ''
      or exists (
        select 1 from public.edits e
        where e.id::text = data->>'relatedDropId'
          and e.status in ('scheduled', 'live', 'archived')
      )
    )
  );

drop view if exists public.public_folder_studies;
create view public.public_folder_studies
with (security_invoker = true) as
select e.id as edit_id, s.id as study_id, s.data
from public.studies s
join public.edits e
  on e.id::text = s.data->>'relatedDropId'
where e.status in ('scheduled', 'live', 'archived')
  and s.data->>'status' = 'published';
grant select on public.public_folder_studies to anon, authenticated;

drop view if exists public.public_folder_notes;
create view public.public_folder_notes
with (security_invoker = true) as
select e.id as edit_id, n.id as note_id, n.data
from public.notes n
join public.edits e
  on e.id::text = n.data->>'folderId'
where e.status in ('scheduled', 'live', 'archived')
  and n.data->>'status' = 'published';
grant select on public.public_folder_notes to anon, authenticated;

-- ------------------------------------------------------------
-- Checks to run afterwards (read-only):
--   select count(*) filter (where is_working) as working from public.edits;   -- 0 or 1
--   select id, number, title, drop_open, is_shop from public.public_releases;
--   select count(*) from public.studies where data->>'status' = 'published';
--   select policyname from pg_policies where tablename = 'items';             -- admin-only names
-- ------------------------------------------------------------
