-- ============================================================
-- MARKETPLACE_APPLY_PART1.sql
-- Everything from MARKETPLACE_SETUP.md EXCEPT Step 7 (needs your real
-- admin UUID pasted in) and the "drop table items" line of Step 8.
-- Paste this whole file into Supabase Dashboard -> SQL Editor -> New
-- query -> Run. Safe to re-run if something fails partway (every
-- statement is "if not exists" / "or replace" / "drop ... if exists").
-- ============================================================

-- ===== Step 1 — Roles and helpers =====
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'customer'
               check (role in ('admin', 'supplier', 'customer')),
  full_name  text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and role = 'admin'
  );
$$;

-- (public.my_supplier_ids() is defined in Step 2, right after the
-- supplier_users table it reads from — a SQL-language function's body is
-- checked at creation, so it can't come before that table exists.)

drop policy if exists "Read own profile" on public.profiles;
create policy "Read own profile"
  on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Admin manages profiles" on public.profiles;
create policy "Admin manages profiles"
  on public.profiles for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ===== Step 2 — Suppliers =====
create table if not exists public.suppliers (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  type            text not null
                    check (type in ('consignor', 'brand', 'boutique', 'poda')),
  commission_bps  integer not null check (commission_bps between 0 and 10000),
  status          text not null default 'invited'
                    check (status in ('invited', 'active', 'paused', 'closed')),
  contact_email   text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create or replace function public.default_commission_bps(supplier_type text)
returns integer language sql immutable as $$
  select case supplier_type
    when 'consignor' then 2500
    when 'brand'     then 1500
    when 'boutique'  then 1500
    when 'poda'      then 0
  end;
$$;

create table if not exists public.supplier_users (
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (supplier_id, user_id)
);

create or replace function public.my_supplier_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select supplier_id from public.supplier_users where user_id = auth.uid();
$$;

alter table public.suppliers enable row level security;
alter table public.supplier_users enable row level security;

drop policy if exists "Supplier reads own record" on public.suppliers;
create policy "Supplier reads own record"
  on public.suppliers for select to authenticated
  using (public.is_admin() or id in (select public.my_supplier_ids()));

drop policy if exists "Admin manages suppliers" on public.suppliers;
create policy "Admin manages suppliers"
  on public.suppliers for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Read own membership" on public.supplier_users;
create policy "Read own membership"
  on public.supplier_users for select to authenticated
  using (public.is_admin() or user_id = auth.uid());

drop policy if exists "Admin manages membership" on public.supplier_users;
create policy "Admin manages membership"
  on public.supplier_users for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Supplier invites (no service-role key needed anywhere in this stack)
create table if not exists public.supplier_invites (
  token       uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  email       text not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.supplier_invites enable row level security;

drop policy if exists "Admin manages invites" on public.supplier_invites;
create policy "Admin manages invites"
  on public.supplier_invites for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Read invite by token" on public.supplier_invites;
create policy "Read invite by token"
  on public.supplier_invites for select to anon, authenticated
  using (used_at is null);

create or replace function public.redeem_supplier_invite(invite_token uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  inv record;
  my_email text;
begin
  select * into inv from public.supplier_invites
    where token = invite_token and used_at is null;

  if inv is null then
    raise exception 'This invite is invalid or has already been used.';
  end if;

  select email into my_email from auth.users where id = auth.uid();
  if my_email is null or lower(my_email) is distinct from lower(inv.email) then
    raise exception 'This invite was sent to a different email address.';
  end if;

  insert into public.supplier_users (supplier_id, user_id)
  values (inv.supplier_id, auth.uid())
  on conflict do nothing;

  insert into public.profiles (user_id, role)
  values (auth.uid(), 'supplier')
  on conflict (user_id) do nothing;

  update public.supplier_invites set used_at = now() where token = invite_token;
end;
$$;

grant execute on function public.redeem_supplier_invite(uuid) to authenticated;

-- ===== Step 3 — Products =====
create table if not exists public.products (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid not null references public.suppliers(id) on delete restrict,
  state         text not null default 'draft'
                  check (state in ('draft','submitted','accepted','declined','withdrawn')),

  title         text,
  brand         text,
  category      text,
  color         text,
  material      text,
  condition     text,
  condition_notes text,
  description   text,
  measurements  text,

  price_cents   integer check (price_cents >= 0),
  currency      text not null default 'USD',

  commission_bps_override integer
                  check (commission_bps_override between 0 and 10000),

  is_unique     boolean not null default true,
  quantity      integer not null default 1 check (quantity >= 0),

  review_note   text,
  submitted_at  timestamptz,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists products_supplier_idx on public.products (supplier_id);
create index if not exists products_state_idx    on public.products (state);

create table if not exists public.product_variants (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  size        text not null,
  sku         text,
  quantity    integer not null default 0 check (quantity >= 0),
  created_at  timestamptz not null default now()
);

create table if not exists public.product_images (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  path        text not null,
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists product_images_product_idx
  on public.product_images (product_id, position);

alter table public.products
  add column if not exists is_available        boolean not null default true,
  add column if not exists proposed_price_cents integer
    check (proposed_price_cents is null or proposed_price_cents >= 0);

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

drop trigger if exists products_guard_trg on public.products;
create trigger products_guard_trg
  before update on public.products
  for each row execute function public.products_guard();

create or replace function public.product_images_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  pid uuid := coalesce(new.product_id, old.product_id);
begin
  update public.products
  set is_available = false, updated_at = now()
  where id = pid and state = 'accepted' and not public.is_admin();
  return coalesce(new, old);
end;
$$;

drop trigger if exists product_images_guard_trg on public.product_images;
create trigger product_images_guard_trg
  after insert or update or delete on public.product_images
  for each row execute function public.product_images_guard();

alter table public.products         enable row level security;
alter table public.product_variants enable row level security;
alter table public.product_images   enable row level security;

drop policy if exists "Supplier reads own products" on public.products;
create policy "Supplier reads own products"
  on public.products for select to authenticated
  using (public.is_admin() or supplier_id in (select public.my_supplier_ids()));

drop policy if exists "Supplier creates own products" on public.products;
create policy "Supplier creates own products"
  on public.products for insert to authenticated
  with check (
    public.is_admin()
    or (supplier_id in (select public.my_supplier_ids())
        and state = 'draft'
        and commission_bps_override is null)
  );

drop policy if exists "Supplier updates own products" on public.products;
create policy "Supplier updates own products"
  on public.products for update to authenticated
  using (public.is_admin() or supplier_id in (select public.my_supplier_ids()))
  with check (public.is_admin() or supplier_id in (select public.my_supplier_ids()));

drop policy if exists "Admin deletes products" on public.products;
create policy "Admin deletes products"
  on public.products for delete to authenticated
  using (public.is_admin());

drop policy if exists "Own variants" on public.product_variants;
create policy "Own variants"
  on public.product_variants for all to authenticated
  using (
    public.is_admin() or exists (
      select 1 from public.products p
      where p.id = product_id and p.supplier_id in (select public.my_supplier_ids())
    )
  )
  with check (
    public.is_admin() or exists (
      select 1 from public.products p
      where p.id = product_id and p.supplier_id in (select public.my_supplier_ids())
    )
  );

drop policy if exists "Own images" on public.product_images;
create policy "Own images"
  on public.product_images for all to authenticated
  using (
    public.is_admin() or exists (
      select 1 from public.products p
      where p.id = product_id and p.supplier_id in (select public.my_supplier_ids())
    )
  )
  with check (
    public.is_admin() or exists (
      select 1 from public.products p
      where p.id = product_id and p.supplier_id in (select public.my_supplier_ids())
    )
  );

-- ===== Step 4 — Activity trail =====
create table if not exists public.product_events (
  id          bigserial primary key,
  product_id  uuid not null references public.products(id) on delete cascade,
  actor_id    uuid references auth.users(id),
  event       text not null,
  from_state  text,
  to_state    text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists product_events_product_idx
  on public.product_events (product_id, created_at desc);

create or replace function public.log_product_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.product_events (product_id, actor_id, event, to_state)
    values (new.id, auth.uid(), 'created', new.state);
    return new;
  end if;

  if new.state is distinct from old.state then
    insert into public.product_events
      (product_id, actor_id, event, from_state, to_state)
    values (new.id, auth.uid(), new.state, old.state, new.state);
  elsif new.updated_at is distinct from old.updated_at then
    insert into public.product_events (product_id, actor_id, event, detail)
    values (new.id, auth.uid(), 'edited',
            jsonb_build_object('price_cents', new.price_cents));
  end if;
  return new;
end;
$$;

drop trigger if exists log_product_event_ins on public.products;
create trigger log_product_event_ins
  after insert on public.products
  for each row execute function public.log_product_event();

drop trigger if exists log_product_event_upd on public.products;
create trigger log_product_event_upd
  after update on public.products
  for each row execute function public.log_product_event();

alter table public.product_events enable row level security;

drop policy if exists "Read own product events" on public.product_events;
create policy "Read own product events"
  on public.product_events for select to authenticated
  using (
    public.is_admin() or exists (
      select 1 from public.products p
      where p.id = product_id and p.supplier_id in (select public.my_supplier_ids())
    )
  );

-- ===== Step 5 — Edits and placements =====
create table if not exists public.edits (
  id           uuid primary key default gen_random_uuid(),
  number       integer,
  title        text not null,
  standfirst   text,
  status       text not null default 'draft'
                 check (status in ('draft','scheduled','live','archived')),
  publish_at   timestamptz,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.edit_placements (
  id                uuid primary key default gen_random_uuid(),
  edit_id           uuid not null references public.edits(id) on delete cascade,
  product_id        uuid not null references public.products(id) on delete restrict,
  position          integer not null default 0,
  editorial_title   text,
  editorial_copy    text,
  hero_image_id     uuid references public.product_images(id),
  created_at        timestamptz not null default now(),
  unique (edit_id, product_id)
);

create index if not exists edit_placements_edit_idx
  on public.edit_placements (edit_id, position);

alter table public.edits          enable row level security;
alter table public.edit_placements enable row level security;

drop policy if exists "Admin manages edits" on public.edits;
create policy "Admin manages edits"
  on public.edits for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Public reads live edits" on public.edits;
create policy "Public reads live edits"
  on public.edits for select to anon, authenticated
  using (status in ('scheduled', 'live', 'archived'));

drop policy if exists "Admin manages placements" on public.edit_placements;
create policy "Admin manages placements"
  on public.edit_placements for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Public reads live placements" on public.edit_placements;
create policy "Public reads live placements"
  on public.edit_placements for select to anon, authenticated
  using (exists (select 1 from public.edits e
                 where e.id = edit_id and e.status = 'live'));

create or replace view public.public_products
with (security_invoker = true) as
select
  pl.id                                   as placement_id,
  pl.edit_id,
  pl.position,
  p.id                                    as product_id,
  coalesce(pl.editorial_title, p.title)   as title,
  coalesce(pl.editorial_copy, p.description) as copy,
  p.brand, p.category, p.color, p.material,
  p.condition, p.condition_notes, p.measurements,
  p.price_cents, p.currency,
  p.is_unique, p.quantity,
  (p.state = 'accepted' and p.is_available) as is_available
from public.edit_placements pl
join public.edits     e on e.id = pl.edit_id and e.status = 'live'
left join public.products p on p.id = pl.product_id;

grant select on public.public_products to anon, authenticated;

-- ===== Step 6 — Supplier photo storage =====
insert into storage.buckets (id, name, public)
values ('supplier-media', 'supplier-media', true)
on conflict (id) do nothing;

drop policy if exists "Public views supplier media" on storage.objects;
create policy "Public views supplier media"
  on storage.objects for select
  using (bucket_id = 'supplier-media');

drop policy if exists "Supplier writes own folder" on storage.objects;
create policy "Supplier writes own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'supplier-media'
    and (public.is_admin()
         or (storage.foldername(name))[1]::uuid in (select public.my_supplier_ids()))
  );

drop policy if exists "Supplier updates own folder" on storage.objects;
create policy "Supplier updates own folder"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'supplier-media'
    and (public.is_admin()
         or (storage.foldername(name))[1]::uuid in (select public.my_supplier_ids()))
  );

drop policy if exists "Supplier deletes own folder" on storage.objects;
create policy "Supplier deletes own folder"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'supplier-media'
    and (public.is_admin()
         or (storage.foldername(name))[1]::uuid in (select public.my_supplier_ids()))
  );

-- ===== Step 8 (security-fix part only — NOT the destructive part) =====
-- notes/studies/drops currently trust ANY signed-in user. Harmless with
-- one admin account; not harmless once suppliers can log in.
drop policy if exists "Admin full access to notes" on public.notes;
create policy "Admin full access to notes"
  on public.notes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admin full access to studies" on public.studies;
create policy "Admin full access to studies"
  on public.studies for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admin full access to drops" on public.drops;
create policy "Admin full access to drops"
  on public.drops for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admin uploads note media" on storage.objects;
create policy "Admin uploads note media"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'note-media' and public.is_admin());

drop policy if exists "Admin updates note media" on storage.objects;
create policy "Admin updates note media"
  on storage.objects for update to authenticated
  using (bucket_id = 'note-media' and public.is_admin());

drop policy if exists "Admin deletes note media" on storage.objects;
create policy "Admin deletes note media"
  on storage.objects for delete to authenticated
  using (bucket_id = 'note-media' and public.is_admin());

-- ===== Step 9 — Release-folder content (updates, notes, studies) =====
create table if not exists public.folder_updates (
  id          uuid primary key default gen_random_uuid(),
  edit_id     uuid not null references public.edits(id) on delete cascade,
  body        text not null,
  image_path  text,
  position    integer not null default 0,
  published   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists folder_updates_edit_idx
  on public.folder_updates (edit_id, position);

alter table public.folder_updates enable row level security;

drop policy if exists "Admin manages folder updates" on public.folder_updates;
create policy "Admin manages folder updates"
  on public.folder_updates for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Public reads published folder updates" on public.folder_updates;
create policy "Public reads published folder updates"
  on public.folder_updates for select to anon, authenticated
  using (
    published
    and exists (
      select 1 from public.edits e
      where e.id = edit_id and e.status in ('scheduled', 'live', 'archived')
    )
  );

create or replace view public.public_folder_notes
with (security_invoker = true) as
select e.id as edit_id, n.id as note_id, n.data
from public.notes n
join public.edits e
  on e.id = nullif(n.data->>'folderId', '')::uuid
where e.status in ('scheduled', 'live', 'archived')
  and n.data->>'status' = 'published';

grant select on public.public_folder_notes to anon, authenticated;

create or replace view public.public_folder_studies
with (security_invoker = true) as
select e.id as edit_id, s.id as study_id, s.data
from public.studies s
join public.edits e
  on e.id = nullif(s.data->>'relatedDropId', '')::uuid
where e.status in ('scheduled', 'live', 'archived');

grant select on public.public_folder_studies to anon, authenticated;

-- ============================================================
-- Done. Do NOT run Step 7 or Step 8's "drop table items" here —
-- those are separate, deliberate, manual steps. See
-- MARKETPLACE_APPLY_PART2_ADMIN.sql for Step 7.
-- ============================================================
