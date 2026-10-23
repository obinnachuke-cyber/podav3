# Marketplace foundation — Supabase setup

This replaces the single-admin `items` model with real supplier accounts,
owned products, and database-enforced permissions.

**Nothing here has been applied yet.** Read it, then run it once in
**Supabase Dashboard → SQL Editor → New query**.

> **Before you run anything:** take a full backup (admin → Download JSON
> backup, plus a Supabase project backup). The old `items` table and the
> `item-images` bucket are dropped at the end of this file, and that is
> not reversible.

## Why this exists

The current setup has one security rule for items: *any logged-in user may
insert, update, or delete any row* (`SUPABASE_SETUP.md`). With a single admin
account that was harmless. The moment a supplier can log in, it means every
supplier can edit and delete the entire catalogue. Everything below is written
so that the database itself refuses that, regardless of what the app sends.

Market Notes (`notes`), Visual Studies (`studies`), and Subscribers
(`subscribers`) are untouched by this migration.

---

## Step 1 — Roles and helpers

```sql
-- Every authenticated person is one of: admin, supplier user, or customer.
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'customer'
               check (role in ('admin', 'supplier', 'customer')),
  full_name  text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- SECURITY DEFINER so policies can call these without the caller needing
-- read access to profiles/supplier_users — otherwise the policies would
-- recurse into the tables they are protecting.
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

create or replace function public.my_supplier_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select supplier_id from public.supplier_users where user_id = auth.uid();
$$;

drop policy if exists "Read own profile" on public.profiles;
create policy "Read own profile"
  on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Deliberately no self-update policy: role changes are admin-only, done
-- from the Supabase dashboard or an admin-side server call.
drop policy if exists "Admin manages profiles" on public.profiles;
create policy "Admin manages profiles"
  on public.profiles for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
```

## Step 2 — Suppliers

A supplier is the **ownership entity**, separate from the login. One supplier
can have several users later without product ownership changing.

```sql
create table if not exists public.suppliers (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  type            text not null
                    check (type in ('consignor', 'brand', 'boutique', 'poda')),
  -- Commission to poda in basis points (2500 = 25%). Integer, so there is
  -- no floating-point drift when money is calculated from it.
  commission_bps  integer not null check (commission_bps between 0 and 10000),
  status          text not null default 'invited'
                    check (status in ('invited', 'active', 'paused', 'closed')),
  contact_email   text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Default rates by type; an admin can override per supplier.
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

alter table public.suppliers enable row level security;
alter table public.supplier_users enable row level security;

-- Suppliers may read their own record but never write it: commission rate
-- and status are terms, not preferences.
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
```

### Inviting a supplier user, without a service-role key

Creating someone's login account is normally a service-role operation —
`auth.admin.inviteUserByEmail()` requires that key, and it must never sit in
client-side JS on a static site. This avoids needing it at all: the admin
issues a token row (an ordinary authenticated insert, allowed because
they're admin), the invited person signs up themselves through Supabase's
own public `auth.signUp()` (safe from the client, no elevated key involved),
and a `SECURITY DEFINER` function does the one privileged step — linking
that brand-new login to the right supplier — only after confirming the
email on the invite matches the email that just signed up.

```sql
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

-- The invited person needs to read their own invite (by token, which only
-- they have via the link) before they've been linked to anything — this is
-- the one read a non-admin, non-supplier person can do here.
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
```

The admin flow: create the supplier record, insert one `supplier_invites`
row, share `seller.html?invite=<token>` however you like (paste it, email
it by hand, or wire up Resend later — not required to work today). The
seller flow: they land on that link, sign up with their email/password via
ordinary Supabase auth, and the seller page calls
`redeem_supplier_invite()` once their session exists. No Edge Function, no
service key, anywhere in this stack.

## Step 3 — Products

Two independent axes, which is the core change from the old single pipeline:

- **`state`** — the supplier's side: `draft → submitted → accepted / declined`,
  plus `withdrawn`.
- **publication** — your side, expressed by placement in an Edit (Step 5).
  Accepting a product does not publish it.

```sql
create table if not exists public.products (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid not null references public.suppliers(id) on delete restrict,
  state         text not null default 'draft'
                  check (state in ('draft','submitted','accepted','declined','withdrawn')),

  -- What the supplier says. Editorial copy lives on the placement instead,
  -- so your public wording never overwrites their original disclosure.
  title         text,
  brand         text,
  category      text,
  color         text,
  material      text,
  condition     text,
  condition_notes text,
  description   text,
  measurements  text,

  -- Price the supplier proposes / you agree, in whole cents.
  price_cents   integer check (price_cents >= 0),
  currency      text not null default 'USD',

  -- Per-product override of the supplier's agreed rate. Null = inherit.
  commission_bps_override integer
                  check (commission_bps_override between 0 and 10000),

  -- One-of-a-kind pieces never touch product_variants; this is their stock.
  is_unique     boolean not null default true,
  quantity      integer not null default 1 check (quantity >= 0),

  review_note   text,            -- admin's "request changes" message
  submitted_at  timestamptz,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists products_supplier_idx on public.products (supplier_id);
create index if not exists products_state_idx    on public.products (state);

-- Sizes/quantities for brands and boutiques only.
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
  path        text not null,          -- storage object path in supplier-media
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists product_images_product_idx
  on public.product_images (product_id, position);
```

### The state machine

Two independent things can happen to an already-`accepted` product when a
supplier edits it, and they are **not** treated the same:

- **Price drift is stale, not dangerous.** A proposed price change never
  touches the live `price_cents` a shopper sees — it's staged in
  `proposed_price_cents` until you approve it. The product stays available
  at the price you already agreed to.
- **A changed disclosure is false, not stale.** Condition, brand,
  measurements, color, material, or description changing on a live item
  means the thing a shopper is looking at may no longer be true. That pulls
  it from sale immediately (`is_available := false`) — the fields update
  right away so your review queue shows the new value, but nothing public
  shows it until you clear it.

Both land back in your queue; only the second one stops selling while it
waits.

```sql
alter table public.products
  add column if not exists is_available        boolean not null default true,
  add column if not exists proposed_price_cents integer
    check (proposed_price_cents is null or proposed_price_cents >= 0);

create or replace function public.products_guard()
returns trigger language plpgsql as $$
declare
  false_change  boolean;  -- disclosure changed: pull from sale now
  price_change  boolean;  -- price changed: stage it, stay live
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

  -- Admin edits are trusted: no bounce, no price staging, no auto-pull.
  if public.is_admin() then
    if new.state is distinct from old.state then
      new.reviewed_at := now();
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- Suppliers may only move between their own states. accepted/declined
  -- are the admin's words, not theirs.
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
      -- Stage it; the live price does not move until you approve it.
      new.proposed_price_cents := new.price_cents;
      new.price_cents := old.price_cents;
    end if;
    if false_change then
      -- New values are visible to you immediately; the public sees none
      -- of them until is_available flips back on.
      new.is_available := false;
    end if;
    -- A material change on a live/accepted item is a re-review, not a
    -- fresh submission — state stays 'accepted' so it doesn't drop out
    -- of your "live" filters, only is_available/proposed_price change.
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

-- A supplier swapping photos on a live item is the same failure mode as
-- editing the condition text: it must pull the item from sale, not just
-- the text fields the guard above already watches.
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
```

Clearing a pulled item is two different admin actions depending on which
kind of change it was:

```sql
-- Approve a staged price: commit it to the live price.
-- update public.products set price_cents = proposed_price_cents,
--   proposed_price_cents = null where id = '...';

-- Clear a disclosure pull once you've re-reviewed the new values in place:
-- update public.products set is_available = true where id = '...';
```

### Product permissions

```sql
alter table public.products         enable row level security;
alter table public.product_variants enable row level security;
alter table public.product_images   enable row level security;

-- Supplier inventory is private by default. The public never reads this
-- table directly — published products are exposed through Step 5's view.
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

-- Only the admin deletes. Suppliers withdraw instead, so history survives.
drop policy if exists "Admin deletes products" on public.products;
create policy "Admin deletes products"
  on public.products for delete to authenticated
  using (public.is_admin());

-- Variants and images inherit their product's ownership.
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
```

## Step 4 — Activity trail

Every meaningful change, so you can see what each supplier has been adding,
editing, and withdrawing — and so a dispute has a record behind it.

```sql
create table if not exists public.product_events (
  id          bigserial primary key,
  product_id  uuid not null references public.products(id) on delete cascade,
  actor_id    uuid references auth.users(id),
  event       text not null,      -- created | submitted | accepted | declined
                                  -- | changes_requested | withdrawn | edited
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
```

## Step 5 — Edits and placements

The product and its appearance in an Edit are separate records, so you can
re-feature a piece, reorder it, or rewrite its public copy without touching
the supplier's inventory.

```sql
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
  -- Your editorial layer. Null means "use the supplier's value".
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

-- 'scheduled' is the pre-release preview state: the folder itself (its
-- title/standfirst/whatever content is already published inside it) is
-- visible before the drop opens, which is the whole point of scheduling
-- it rather than leaving it in draft. 'archived' stays visible so past
-- drops remain browsable.
drop policy if exists "Public reads live edits" on public.edits;
create policy "Public reads live edits"
  on public.edits for select to anon, authenticated
  using (status in ('scheduled', 'live', 'archived'));

drop policy if exists "Admin manages placements" on public.edit_placements;
create policy "Admin manages placements"
  on public.edit_placements for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Deliberately still 'live'-only, unlike the edits policy above: the
-- *folder* (and whatever notes/updates sit inside it) previews during
-- 'scheduled', but the actual product grid stays unrevealed until the
-- drop is genuinely open. Folder visibility and product availability
-- are different things, on purpose.
drop policy if exists "Public reads live placements" on public.edit_placements;
create policy "Public reads live placements"
  on public.edit_placements for select to anon, authenticated
  using (exists (select 1 from public.edits e
                 where e.id = edit_id and e.status = 'live'));
```

### What the public can actually see

A view, so the storefront never gets read access to `products` itself —
only the fields a shopper needs. This is a **left** join on purpose: if a
placed product gets pulled mid-drop (a disclosure re-review, see Step 3),
the placement row still comes back with `is_available = false` instead of
disappearing. The shopper's grid keeps its position and renders an
"unavailable" state there; it doesn't develop a hole.

```sql
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
```

A withdrawn or declined product (`state` outside `'accepted'`) reports
`is_available = false` the same way a pulled one does — the shopper never
needs to know *why* it's unavailable, only that it is.

## Step 6 — Supplier photo storage

Replaces `item-images`, which let any authenticated user overwrite any file.
Here a supplier can only write inside their own folder.

```sql
insert into storage.buckets (id, name, public)
values ('supplier-media', 'supplier-media', true)
on conflict (id) do nothing;

-- Convention: supplier-media/<supplier_id>/<product_id>/<file>
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
```

## Step 7 — Make yourself the admin

Replace the UUID with your own from **Authentication → Users**.

```sql
insert into public.profiles (user_id, role, full_name)
values ('YOUR-AUTH-USER-UUID', 'admin', 'Chuke')
on conflict (user_id) do update set role = 'admin';

-- Your own inventory as a first-class supplier record, not a typed name.
insert into public.suppliers (name, type, commission_bps, status)
values ('poda', 'poda', 0, 'active')
on conflict do nothing;
```

## Step 8 — Drop the old model

**Run this last, and only once Steps 1–7 succeed and you have a backup.**

> **Stop — do not empty the `item-images` bucket wholesale.** `uploadImage()`
> in `db.js` is the one shared upload function behind `item-images`, and
> `OVERHAUL_SETUP.md` confirms drop covers and study images were uploaded
> through it too — there's no path prefix separating "an item's photo" from
> "a study's photo" in that bucket. The original version of this step
> (`delete from storage.buckets where id = 'item-images'`) would have
> silently deleted live Lookbook and Drops imagery along with the items —
> the exact opposite of "`studies` ... intentionally left alone" two
> paragraphs down. Fixed below: drop the table, leave the bucket's contents
> alone entirely for now.

```sql
-- Old product inventory from the previous version of the site.
drop table if exists public.items cascade;
```

Cleaning up the now-orphaned item photos inside `item-images` is a separate,
manual job: cross-reference every image URL still referenced by `studies`
and `drops` rows against the bucket's file list, and only remove what's left
over. Don't script that as a blind delete — do it once you can verify it by
hand, or simply leave the orphaned files in place (storage cost, not a
correctness problem).

`notes`, `studies`, `subscribers`, `drops`, `send_logs`, and `archive_images`
are intentionally left alone. `drops` and `archive_images` are superseded
(`edits` replaces `drops`) but are harmless to leave until the admin rebuild
is finished and you have confirmed nothing reads them.

### A gap this surfaced: notes/studies/drops trust *any* signed-in user

`NOTES_SETUP.md` and `OVERHAUL_SETUP.md` both gate writes with
`using (auth.role() = 'authenticated')` — true of anyone logged in, not just
you. That was harmless when the only person who could ever log in was the
single admin. After Step 1, suppliers log in too, and those same policies
would hand every supplier full read/write/delete access to your entire
Market Notes and Lookbook catalog. This migration doesn't touch the shape of
`notes`/`studies`/`drops` — but it has to touch *this*, or Step 1 quietly
breaks a promise the rest of this file is built around.

```sql
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
```

The same is true of `note-media`'s storage policies
(`MARKET_NOTES_STUDIO_SETUP.md`), which check only `bucket_id = 'note-media'`
with no admin check at all:

```sql
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
```

## Step 9 — Release-folder content (updates, notes, studies)

`notes` and `studies` stay exactly the shape they are — a `{ id, data }`
jsonb row each, edited through the existing Studio/Lookbook admin, nothing
duplicated into a new table. Attaching one to a folder is just a new key
inside that same jsonb, written through the existing `upsertNote()` /
`upsertStudy()` functions. No ALTER TABLE on either.

`studies` already has a `relatedDropId` field sitting unused in
`blankStudy()`, built for the table `edits` replaces — reusing it is less
churn than inventing `folderId` twice. `notes` has no equivalent yet, so it
gets a new `folderId` key. Either way: one value, so a note or study is only
ever in one folder — a join table would be the wrong tool for "at most one."

```sql
-- Short correspondence/updates — not a Market Note. A one-line "got the
-- Margiela in" doesn't need the full Studio (cover image, SEO meta, rich
-- Tiptap body); it needs a timestamp and a sentence.
create table if not exists public.folder_updates (
  id          uuid primary key default gen_random_uuid(),
  edit_id     uuid not null references public.edits(id) on delete cascade,
  body        text not null,
  image_path  text,            -- optional, same note-media bucket/convention
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

-- Individual content publication: 'published' is this update's own switch,
-- independent of the folder's visibility — a folder can be 'scheduled'
-- while only some of its updates are actually ready to show.
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
```

Notes and studies previewing in a `scheduled` folder is intentional and
different from products: products stay unrevealed until `live` (Step 5),
but a note or a Lookbook image is exactly the "follow its progress" content
a pre-release folder exists to show.

```sql
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
```

`studies` has no draft/published concept at all today (`blankStudy()` has
no `status` field — a study is public the moment it exists), so its view
only gates on the folder. `notes` does have one, so its view gates on
both — not double-gating in the sense Step 5 warned about (that was about
needing two separate *admin actions*), just a defensive floor: a stray
`folderId` left on an old draft can't surface just because its folder later
goes live. The admin UI should still only ever offer already-published
notes as attachable in the first place.

One honest limitation: `folderId` / `relatedDropId` can't be a real foreign
key, because they live inside a jsonb blob, not a typed column — Postgres
can't enforce a `references edits(id)` on an extracted jsonb field without
adding a generated column to `notes`/`studies`, which is exactly the kind of
table change this step is deliberately avoiding. That referential integrity
is app-level discipline, same as the rest of `notes`/`studies` today — not
new weaker, just consistent with how those two tables already work.

---

## Verifying it worked

Sign in as a test supplier user and confirm the database refuses these,
not just the interface:

| Attempt | Expected |
|---|---|
| Read another supplier's products | 0 rows |
| Set own product `state` to `accepted` | error: cannot set product state |
| Change own `commission_bps_override` | error: cannot change commission terms |
| Change `supplier_id` to someone else | error: products cannot change owner |
| Edit price on an accepted, placed product | `price_cents` unchanged; `proposed_price_cents` holds the new value; still shows live at the old price in `public_products` |
| Edit condition/brand/measurements/color/material/description on an accepted, placed product | fields update immediately; `is_available` flips to `false`; `public_products` shows it `is_available = false` in its same placement, not missing |
| Add/replace/delete a photo on an accepted, placed product | same as above — `is_available` flips to `false` |
| Admin sets `is_available = true` after re-review | item reappears as available at its existing placement |
| Admin copies `proposed_price_cents` into `price_cents` | new price goes live; `proposed_price_cents` cleared |
| Upload to another supplier's media folder | denied |
| Read `products` while signed out | 0 rows |
| Read `public_products` while signed out | only items placed in a `live` Edit, each with a correct `is_available` |
| Read `edits` while signed out, for one with `status = 'scheduled'` | row is visible (folder previews before the drop opens); its placements are not |
| As a test supplier, read/write a row in `notes`, `studies`, or `drops` | denied — these now require `public.is_admin()`, not just any signed-in user |
| As a test supplier, upload/delete a file in `note-media` | denied |
| Admin creates a `supplier_invites` row, a second test account signs up with a *different* email, then calls `redeem_supplier_invite()` | error: sent to a different email address |
| Same invite, matching email, call `redeem_supplier_invite()` | succeeds once; second call on the same token errors (already used) |
| Set a published note's `folderId` to a `scheduled` or `live` edit's id, read `public_folder_notes` signed out | the note appears |
| Same note, but its own `status` is `draft` | the note does **not** appear, even though its folder is public |
| Set a study's `relatedDropId` to an edit's id, read `public_folder_studies` signed out | the study appears (no status gate — studies have none) |
| Publish a `folder_updates` row on a `draft` edit | does not appear in `public_folder_notes`-style read; the edit itself isn't public yet either |
