-- ============================================================
-- 20261121_order_delivery.sql
-- When an order was delivered. A seller becomes ready to pay 3 days after
-- delivery, so the admin records delivery with Mark delivered in Orders.
-- Run it after 20261112_order_shipping.sql. Safe to re-run. Adds one empty
-- column to public.orders and changes nothing else.
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null then
    raise exception 'public.orders is missing. Run migrations/20261111_checkout.sql first.';
  end if;
end $$;

alter table public.orders
  add column if not exists delivered_at timestamptz;

-- Check afterwards (read-only): should return one row.
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name = 'orders' and column_name = 'delivered_at';
