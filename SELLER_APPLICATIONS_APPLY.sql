-- ============================================================
-- SELLER_APPLICATIONS_APPLY.sql
-- Private storage for "Sell with poda" applications.
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run.
-- Safe to re-run. Deletes nothing and does not touch existing data.
--
-- What it sets up:
--   1. seller_applications: one row per application. RLS is on and the
--      only policy is admin-only, so the public can neither read nor
--      write the table directly.
--   2. A private "applications" storage bucket. The public can add
--      photos (and nothing else: no list, read, overwrite or delete).
--      Only the admin can read them, through signed links.
--   3. submit_seller_application(): the only way the public creates a
--      row. It checks the input, checks each photo really exists in
--      storage, ignores a repeated send of the same application, and
--      limits repeat applications from one email.
-- Applying creates no seller account, profile or product.
-- ============================================================

-- ===== 1. Table =====
create table if not exists public.seller_applications (
  id           uuid primary key,
  name         text not null check (char_length(name) between 1 and 120),
  email        text not null check (char_length(email) between 3 and 200),
  instagram    text check (instagram is null or char_length(instagram) <= 200),
  photo_paths  text[] not null check (cardinality(photo_paths) between 1 and 12),
  offering     text check (offering is null or char_length(offering) <= 1000),
  seller_type  text check (seller_type is null or seller_type in ('closet', 'store', 'brand')),
  status       text not null default 'new'
               check (status in ('new', 'accepted', 'declined', 'reviewed', 'archived')),
  created_at   timestamptz not null default now()
);

-- Added after the first version of this file; harmless if it already exists.
alter table public.seller_applications add column if not exists offering text
  check (offering is null or char_length(offering) <= 1000);
alter table public.seller_applications add column if not exists seller_type text
  check (seller_type is null or seller_type in ('closet', 'store', 'brand'));

-- Accept / decline: widen the status list if the table came from an earlier version.
alter table public.seller_applications drop constraint if exists seller_applications_status_check;
alter table public.seller_applications add constraint seller_applications_status_check
  check (status in ('new', 'accepted', 'declined', 'reviewed', 'archived'));

create index if not exists seller_applications_created_idx
  on public.seller_applications (created_at desc);

alter table public.seller_applications enable row level security;

drop policy if exists "Admin manages applications" on public.seller_applications;
create policy "Admin manages applications"
  on public.seller_applications for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ===== 2. Private photo bucket =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('applications', 'applications', false, 8388608, array['image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = 8388608,
      allowed_mime_types = array['image/jpeg'];

-- Add only. Path must be <application id>/<number>.jpg.
drop policy if exists "Public can add application photos" on storage.objects;
create policy "Public can add application photos"
  on storage.objects for insert to anon, authenticated
  with check (
    bucket_id = 'applications'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9]{1,2}\.jpg$'
  );

-- Read (and so list and sign) is admin only.
drop policy if exists "Admin reads application photos" on storage.objects;
create policy "Admin reads application photos"
  on storage.objects for select to authenticated
  using (bucket_id = 'applications' and public.is_admin());

drop policy if exists "Admin deletes application photos" on storage.objects;
create policy "Admin deletes application photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'applications' and public.is_admin());

-- ===== 3. The one door in =====
-- Returns: 'ok'        saved (also returned when the same application is sent again)
--          'invalid'   a field or photo did not pass the checks
--          'photos'    a listed photo is not in storage yet
--          'duplicate' this email already applied in the last 24 hours
--          'busy'      too many applications in the last hour
-- Earlier versions took five and six arguments; replace them with the seven-argument one.
drop function if exists public.submit_seller_application(uuid, text, text, text, text[]);
drop function if exists public.submit_seller_application(uuid, text, text, text, text[], text);

create or replace function public.submit_seller_application(
  app_id          uuid,
  app_name        text,
  app_email       text,
  app_instagram   text,
  app_photo_paths text[],
  app_offering    text,
  app_seller_type text
)
returns text
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  clean_name  text := btrim(coalesce(app_name, ''));
  clean_email text := lower(btrim(coalesce(app_email, '')));
  clean_ig    text := nullif(btrim(coalesce(app_instagram, '')), '');
  clean_what  text := btrim(coalesce(app_offering, ''));
  p           text;
begin
  -- Same application sent twice (retry, double tap): already saved.
  if exists (select 1 from public.seller_applications where id = app_id) then
    return 'ok';
  end if;

  if app_id is null
     or char_length(clean_name) not between 1 and 120
     or clean_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     or char_length(clean_email) > 200
     or (clean_ig is not null and char_length(clean_ig) > 200)
     or char_length(clean_what) not between 1 and 1000
     or app_seller_type is null or app_seller_type not in ('closet', 'store', 'brand')
     or app_photo_paths is null
     or cardinality(app_photo_paths) not between 1 and 12 then
    return 'invalid';
  end if;

  foreach p in array app_photo_paths loop
    if p !~ ('^' || app_id::text || '/[0-9]{1,2}\.jpg$') then
      return 'invalid';
    end if;
    if not exists (select 1 from storage.objects where bucket_id = 'applications' and name = p) then
      return 'photos';
    end if;
  end loop;

  if exists (
    select 1 from public.seller_applications
    where lower(email) = clean_email and created_at > now() - interval '24 hours'
  ) then
    return 'duplicate';
  end if;

  if (select count(*) from public.seller_applications where created_at > now() - interval '1 hour') >= 60 then
    return 'busy';
  end if;

  insert into public.seller_applications (id, name, email, instagram, photo_paths, offering, seller_type)
  values (app_id, clean_name, clean_email, clean_ig, app_photo_paths, clean_what, app_seller_type);

  return 'ok';
end;
$$;

revoke all on function public.submit_seller_application(uuid, text, text, text, text[], text, text) from public;
grant execute on function public.submit_seller_application(uuid, text, text, text, text[], text, text) to anon, authenticated;
