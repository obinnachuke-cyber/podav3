-- ============================================================
-- 20261113_payouts.sql
-- What the admin Payouts dashboard needs from the database:
--   * a payouts record, so each payment to a seller is one entry you can look
--     back on, with the method, your reference, and the orders it covered
--   * create_payout() and void_payout(), which pay or undo a whole batch of
--     orders in one step: all of it happens or none of it does
--   * a Stripe fee on each order, and the date an order was refunded
--
-- Run it AFTER migrations/20261111_checkout.sql. Safe to re-run. It adds a
-- table, three columns and three functions, and deletes nothing.
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null then
    raise exception 'public.orders is missing. Run migrations/20261111_checkout.sql first.';
  end if;
  if to_regprocedure('public.is_admin()') is null then
    raise exception 'public.is_admin() is missing. Run MARKETPLACE_APPLY_PART1.sql first.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. One row per payment to a seller. A mistake is voided, never deleted,
--    so the history stays honest.
-- ------------------------------------------------------------
create table if not exists public.payouts (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid not null references public.suppliers(id) on delete restrict,
  amount_cents  integer not null check (amount_cents > 0),
  currency      text not null default 'USD',
  method        text,
  reference     text,
  note          text,
  paid_at       timestamptz not null default now(),
  voided_at     timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists payouts_supplier_idx on public.payouts (supplier_id, paid_at desc);

alter table public.payouts enable row level security;
drop policy if exists "Admin manages payouts" on public.payouts;
create policy "Admin manages payouts"
  on public.payouts for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------
-- 2. What an order now records.
-- ------------------------------------------------------------
alter table public.orders
  add column if not exists payout_id        uuid references public.payouts(id) on delete set null,
  add column if not exists stripe_fee_cents integer check (stripe_fee_cents is null or stripe_fee_cents >= 0),
  add column if not exists refunded_at      timestamptz;

create index if not exists orders_payout_idx on public.orders (payout_id);

-- ------------------------------------------------------------
-- 3. Pay a seller for a batch of orders. Admin only (checked here, because
--    the admin's own session calls this). Every order must be this seller's,
--    paid, not waiting for a refund, and not already paid out; otherwise
--    nothing changes. Returns the payout's id and amount.
-- ------------------------------------------------------------
create or replace function public.create_payout(
  p_supplier   uuid,
  p_order_ids  uuid[],
  p_method     text,
  p_reference  text,
  p_note       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids     uuid[];
  v_found   integer;
  v_total   integer;
  v_cur     integer;
  v_currency text;
  v_id      uuid;
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;

  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(p_order_ids) as x;
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    raise exception 'Choose at least one order.';
  end if;

  -- Lock these orders so two payouts cannot claim the same one.
  perform 1 from public.orders where id = any(v_ids) for update;

  select count(*), coalesce(sum(seller_payout_cents), 0), count(distinct currency), min(currency)
    into v_found, v_total, v_cur, v_currency
  from public.orders
  where id = any(v_ids)
    and supplier_id = p_supplier
    and status = 'paid'
    and not conflict
    and payout_status = 'unpaid';

  if v_found <> array_length(v_ids, 1) then
    raise exception 'Some of these orders cannot be paid out for this seller. They may already be paid, refunded or belong to someone else.';
  end if;
  if v_cur <> 1 then
    raise exception 'These orders are in different currencies. Pay them out separately.';
  end if;
  if v_total <= 0 then
    raise exception 'There is nothing to pay on these orders.';
  end if;

  insert into public.payouts (supplier_id, amount_cents, currency, method, reference, note)
  values (p_supplier, v_total, v_currency, nullif(btrim(p_method), ''), nullif(btrim(p_reference), ''), nullif(btrim(p_note), ''))
  returning id into v_id;

  update public.orders
     set payout_status  = 'paid',
         payout_paid_at = now(),
         payout_id      = v_id
   where id = any(v_ids);

  return jsonb_build_object('payout_id', v_id, 'amount_cents', v_total, 'orders', v_found);
end;
$$;

-- ------------------------------------------------------------
-- 4. Undo a payout that was recorded by mistake: every order in it goes back
--    to unpaid, and the payout stays in the history marked voided.
-- ------------------------------------------------------------
create or replace function public.void_payout(p_payout uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;

  update public.payouts set voided_at = now() where id = p_payout and voided_at is null;
  if not found then
    raise exception 'That payout was not found or is already voided.';
  end if;

  update public.orders
     set payout_status  = 'unpaid',
         payout_paid_at = null,
         payout_id      = null
   where payout_id = p_payout;
end;
$$;

-- ------------------------------------------------------------
-- 5. The Worker records Stripe's processing fee after each sale.
--    Service role only.
-- ------------------------------------------------------------
create or replace function public.record_order_fee(p_order uuid, p_fee integer)
returns void
language sql
security definer
set search_path = public
as $$
  update public.orders set stripe_fee_cents = p_fee where id = p_order;
$$;

revoke all on function public.create_payout(uuid, uuid[], text, text, text) from public, anon;
revoke all on function public.void_payout(uuid) from public, anon;
revoke all on function public.record_order_fee(uuid, integer) from public, anon, authenticated;

grant execute on function public.create_payout(uuid, uuid[], text, text, text) to authenticated;
grant execute on function public.void_payout(uuid) to authenticated;
grant execute on function public.record_order_fee(uuid, integer) to service_role;
