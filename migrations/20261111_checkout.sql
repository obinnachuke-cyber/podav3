-- ============================================================
-- 20261111_checkout.sql
-- Real checkout with Stripe: an orders table, a 30-minute hold on a piece
-- while someone pays, and the functions the Cloudflare Worker calls.
--
-- Run it AFTER migrations/20261028_release_workspace.sql and
-- SELLER_CARDS_APPLY.sql. It replaces two things those files define:
--   * public.public_products  (adds "held": a piece someone is paying for)
--   * public.products_guard() (adds one narrow bypass for the sale itself)
-- so if you ever re-run SELLER_CARDS_APPLY.sql, run this file again after it.
--
-- Safe to re-run. Adds a table and functions, replaces a view and a trigger
-- function, and deletes no rows.
-- ============================================================

do $$
begin
  if to_regclass('public.products') is null or to_regclass('public.edit_placements') is null
     or to_regclass('public.edits') is null or to_regclass('public.suppliers') is null then
    raise exception 'Missing marketplace tables. Run MARKETPLACE_APPLY_PART1.sql and migrations/20261028_release_workspace.sql first.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'products' and column_name = 'is_hidden') then
    raise exception 'products.is_hidden is missing. Run SELLER_CARDS_APPLY.sql first.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. Orders. One row per checkout attempt. A "pending" order whose
--    hold_expires_at is in the future is the hold on the piece.
--    Only the admin can read or change orders; the Worker uses the service
--    role, which bypasses these policies.
-- ------------------------------------------------------------
create table if not exists public.orders (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null references public.products(id) on delete restrict,
  supplier_id         uuid not null references public.suppliers(id) on delete restrict,
  edit_id             uuid references public.edits(id) on delete set null,
  status              text not null default 'pending'
                        check (status in ('pending', 'paid', 'expired', 'refunded')),
  stripe_session_id   text unique,

  -- What was sold, frozen at the moment of checkout.
  title               text not null,
  brand               text,
  price_cents         integer not null check (price_cents > 0),
  currency            text not null default 'USD',

  -- The split, frozen too. Shipping is poda's and is not shared.
  commission_bps      integer not null check (commission_bps between 0 and 10000),
  commission_cents    integer not null check (commission_cents >= 0),
  seller_payout_cents integer not null check (seller_payout_cents >= 0),

  hold_expires_at     timestamptz not null,

  -- Filled in when the payment completes.
  buyer_email         text,
  buyer_name          text,
  shipping_address    jsonb,
  shipping_cents      integer not null default 0,
  amount_total_cents  integer,
  paid_at             timestamptz,

  -- True when the payment arrived after the hold lapsed and the piece was
  -- already gone. The buyer has paid and needs a refund.
  conflict            boolean not null default false,

  -- 'none' for poda's own pieces, which have no seller to pay.
  payout_status       text not null default 'unpaid'
                        check (payout_status in ('unpaid', 'paid', 'none')),
  payout_paid_at      timestamptz,
  shipped_at          timestamptz,

  created_at          timestamptz not null default now()
);

create index if not exists orders_product_idx on public.orders (product_id, status, hold_expires_at);
create index if not exists orders_created_idx on public.orders (created_at desc);

alter table public.orders enable row level security;
drop policy if exists "Admin manages orders" on public.orders;
create policy "Admin manages orders"
  on public.orders for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------
-- 2. Product guard. Identical to SELLER_CARDS_APPLY.sql plus one bypass at
--    the top: complete_order() switches on the transaction-local setting
--    poda.checkout so a sale can lower a piece's quantity. Nothing a
--    visitor or seller can reach sets that value.
-- ------------------------------------------------------------
create or replace function public.products_guard()
returns trigger language plpgsql as $$
declare
  false_change  boolean;
  price_change  boolean;
begin
  if current_setting('poda.checkout', true) = 'on' then
    new.updated_at := now();
    return new;
  end if;

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
    or new.measurements   is distinct from old.measurements
    or new.size           is distinct from old.size;

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
-- 3. Public view. Same as SELLER_CARDS_APPLY.sql, except a piece someone is
--    paying for now reads "held" (and is not available) until the hold ends.
-- ------------------------------------------------------------
drop view if exists public.public_products;
create view public.public_products as
select
  pl.id                                   as placement_id,
  pl.edit_id,
  pl.position,
  p.id                                    as product_id,
  coalesce(pl.editorial_title, p.title)   as title,
  case when p.state = 'accepted' and p.is_available and not p.is_hidden
       then coalesce(pl.editorial_copy, p.description) end  as copy,
  p.brand,
  p.category,
  p.color,
  p.material,
  case when p.state = 'accepted' and p.is_available and not p.is_hidden
       then p.condition end               as condition,
  case when p.state = 'accepted' and p.is_available and not p.is_hidden
       then p.condition_notes end         as condition_notes,
  case when p.state = 'accepted' and p.is_available and not p.is_hidden
       then p.measurements end            as measurements,
  case when p.state = 'accepted' and p.is_available and not p.is_hidden
       then p.price_cents end             as price_cents,
  p.currency,
  p.is_unique,
  p.quantity,
  coalesce(p.state = 'accepted' and p.is_available and not p.is_hidden
           and p.quantity - h.held > 0, false)  as is_available,
  case when p.state = 'accepted' and p.is_available and not p.is_hidden
            and p.quantity - h.held > 0 then 'available'
       when p.state = 'accepted' and p.is_available and not p.is_hidden
            and p.quantity > 0 then 'held'
       when p.state = 'accepted' and p.is_available and not p.is_hidden
            then 'sold'
       else 'unavailable' end             as availability,
  case when p.state = 'accepted' and p.is_available and not p.is_hidden
       then coalesce((
         select array_agg(i.path
                  order by coalesce(i.id = pl.hero_image_id, false) desc,
                           i.position, i.id)
         from public.product_images i
         where i.product_id = pl.product_id
       ), '{}'::text[])
       else '{}'::text[] end              as image_paths,
  case when s.type = 'consignor' then null else s.name end as supplier_name,
  s.type                                  as supplier_type,
  p.size
from public.edit_placements pl
join public.edits e
  on e.id = pl.edit_id
 and e.status in ('scheduled', 'live', 'archived')
 and (e.launched_at is not null
      or (e.publish_at is not null and e.publish_at <= now()))
left join public.products  p on p.id = pl.product_id
left join public.suppliers s on s.id = p.supplier_id
left join lateral (
  select count(*)::integer as held
  from public.orders o
  where o.product_id = p.id
    and o.status = 'pending'
    and o.hold_expires_at > now()
) h on true;

grant select on public.public_products to anon, authenticated;

-- ------------------------------------------------------------
-- 4. Functions the Worker calls (service role only).
-- ------------------------------------------------------------

-- Takes a hold on one unit of a piece and records the order. Raises
-- poda_unavailable, poda_sold or poda_held, which the Worker turns into a
-- message for the buyer. The row lock means two buyers cannot take the last
-- unit at the same moment.
create or replace function public.create_order_hold(p_product uuid, p_hold_minutes integer default 32)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p       public.products%rowtype;
  s       public.suppliers%rowtype;
  v_edit  uuid;
  v_holds integer;
  v_bps   integer;
  v_comm  integer;
  v_id    uuid;
  v_exp   timestamptz;
begin
  select * into p from public.products where id = p_product for update;
  if not found then
    raise exception 'poda_unavailable';
  end if;

  if p.state <> 'accepted' or not p.is_available or p.is_hidden
     or p.price_cents is null or p.price_cents <= 0 then
    raise exception 'poda_unavailable';
  end if;
  if p.quantity <= 0 then
    raise exception 'poda_sold';
  end if;

  -- Only a piece in a release whose drop is open can be bought.
  select pl.edit_id into v_edit
  from public.edit_placements pl
  join public.edits e
    on e.id = pl.edit_id
   and e.status in ('scheduled', 'live', 'archived')
   and (e.launched_at is not null
        or (e.publish_at is not null and e.publish_at <= now()))
  where pl.product_id = p.id
  order by e.publish_at desc nulls last
  limit 1;
  if v_edit is null then
    raise exception 'poda_unavailable';
  end if;

  select count(*) into v_holds
  from public.orders
  where product_id = p.id and status = 'pending' and hold_expires_at > now();
  if v_holds >= p.quantity then
    raise exception 'poda_held';
  end if;

  select * into s from public.suppliers where id = p.supplier_id;
  v_bps  := coalesce(p.commission_bps_override, s.commission_bps, 0);
  v_comm := round(p.price_cents::numeric * v_bps / 10000)::integer;
  v_exp  := now() + make_interval(mins => p_hold_minutes);

  insert into public.orders (
    product_id, supplier_id, edit_id, status, title, brand, price_cents, currency,
    commission_bps, commission_cents, seller_payout_cents, hold_expires_at, payout_status
  ) values (
    p.id, p.supplier_id, v_edit, 'pending',
    coalesce(p.title, 'Untitled'), p.brand, p.price_cents, coalesce(p.currency, 'USD'),
    v_bps, v_comm, p.price_cents - v_comm, v_exp,
    case when s.type = 'poda' then 'none' else 'unpaid' end
  ) returning id into v_id;

  return jsonb_build_object(
    'order_id', v_id,
    'title', coalesce(p.title, 'Untitled'),
    'brand', p.brand,
    'price_cents', p.price_cents,
    'currency', coalesce(p.currency, 'USD'),
    'hold_expires_at', v_exp
  );
end;
$$;

-- Remembers which Stripe session belongs to an order, so it can be expired.
create or replace function public.attach_order_session(p_order uuid, p_session text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.orders
     set stripe_session_id = p_session
   where id = p_order and status = 'pending';
$$;

-- The Stripe session of a still-pending order, or null.
create or replace function public.order_session(p_order uuid)
returns text
language sql
security definer
set search_path = public
as $$
  select stripe_session_id from public.orders where id = p_order and status = 'pending';
$$;

-- Frees the hold: the session expired, was cancelled, or could not be created.
create or replace function public.release_order(p_order uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.orders set status = 'expired'
   where id = p_order and status = 'pending';
$$;

-- Marks an order paid and takes one unit off the piece. Safe to call twice
-- for the same payment: the second call changes nothing. If the payment
-- arrived after the hold lapsed and the last unit was already taken, the
-- order is still recorded as paid but flagged conflict, so the admin refunds it.
create or replace function public.complete_order(
  p_order           uuid,
  p_session         text,
  p_email           text,
  p_name            text,
  p_address         jsonb,
  p_shipping_cents  integer,
  p_amount_total    integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o         public.orders%rowtype;
  prod      public.products%rowtype;
  s         public.suppliers%rowtype;
  v_newly   boolean := false;
  v_conflict boolean := false;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then
    raise exception 'poda_no_order';
  end if;

  if o.status <> 'paid' then
    v_newly := true;

    select * into prod from public.products where id = o.product_id for update;
    if prod.quantity <= 0 then
      v_conflict := true;
    else
      -- The only place a sale lowers stock. products_guard() honours this
      -- setting for the rest of this transaction.
      perform set_config('poda.checkout', 'on', true);
      update public.products
         set quantity = quantity - 1
       where id = prod.id;
      perform set_config('poda.checkout', 'off', true);
    end if;

    update public.orders
       set status             = 'paid',
           stripe_session_id  = coalesce(stripe_session_id, p_session),
           buyer_email        = p_email,
           buyer_name         = p_name,
           shipping_address   = p_address,
           shipping_cents     = coalesce(p_shipping_cents, 0),
           amount_total_cents = p_amount_total,
           paid_at            = now(),
           conflict           = v_conflict
     where id = o.id
    returning * into o;
  end if;

  select * into s from public.suppliers where id = o.supplier_id;

  return jsonb_build_object(
    'order_id', o.id,
    'newly_paid', v_newly,
    'conflict', o.conflict,
    'title', o.title,
    'brand', o.brand,
    'price_cents', o.price_cents,
    'currency', o.currency,
    'shipping_cents', o.shipping_cents,
    'commission_cents', o.commission_cents,
    'seller_payout_cents', o.seller_payout_cents,
    'supplier_name', s.name,
    'payout_status', o.payout_status
  );
end;
$$;

revoke all on function public.create_order_hold(uuid, integer) from public, anon, authenticated;
revoke all on function public.attach_order_session(uuid, text) from public, anon, authenticated;
revoke all on function public.order_session(uuid) from public, anon, authenticated;
revoke all on function public.release_order(uuid) from public, anon, authenticated;
revoke all on function public.complete_order(uuid, text, text, text, jsonb, integer, integer) from public, anon, authenticated;

grant execute on function public.create_order_hold(uuid, integer) to service_role;
grant execute on function public.attach_order_session(uuid, text) to service_role;
grant execute on function public.order_session(uuid) to service_role;
grant execute on function public.release_order(uuid) to service_role;
grant execute on function public.complete_order(uuid, text, text, text, jsonb, integer, integer) to service_role;

-- ------------------------------------------------------------
-- Checks to run afterwards (read-only):
--   select count(*) from public.orders;                                  -- 0
--   select availability, count(*) from public.public_products group by 1;
--   select proname from pg_proc where proname in
--     ('create_order_hold','complete_order','release_order','order_session','attach_order_session');
-- ------------------------------------------------------------
