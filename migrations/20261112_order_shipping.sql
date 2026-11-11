-- ============================================================
-- 20261112_order_shipping.sql
-- Tracking details on an order, for the shipping email to the buyer.
-- Run it after 20261111_checkout.sql. Safe to re-run. Adds three empty
-- columns to public.orders and changes nothing else.
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null then
    raise exception 'public.orders is missing. Run migrations/20261111_checkout.sql first.';
  end if;
end $$;

alter table public.orders
  add column if not exists carrier               text,
  add column if not exists tracking_number       text,
  add column if not exists shipped_email_sent_at timestamptz;

-- Check afterwards (read-only): should return three rows.
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name = 'orders'
--   and column_name in ('carrier', 'tracking_number', 'shipped_email_sent_at');
