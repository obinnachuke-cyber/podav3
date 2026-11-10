-- ============================================================
-- 20261110_supplier_instagram.sql
-- Lets a seller save their Instagram handle on their own supplier record.
--
-- Sellers cannot update the suppliers table directly (it holds commission
-- and status), so they go through set_my_instagram(), which can change only
-- the instagram column and only on a supplier linked to the caller.
--
-- Safe to re-run. Adds one nullable column, deletes nothing.
-- ============================================================

alter table public.suppliers add column if not exists instagram text;

create or replace function public.set_my_instagram(p_handle text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  h text := nullif(btrim(coalesce(p_handle, '')), '');
begin
  -- Accept "@name", "name" or a full instagram.com URL; store the bare name.
  if h is not null then
    h := regexp_replace(h, '^(https?://)?(www\.)?instagram\.com/', '', 'i');
    h := regexp_replace(h, '[/?#].*$', '');
    h := regexp_replace(h, '^@', '');
    if h !~ '^[A-Za-z0-9._]{1,30}$' then
      raise exception 'Enter a valid Instagram handle, for example @yourname.';
    end if;
  end if;

  update public.suppliers
     set instagram = h, updated_at = now()
   where id in (select public.my_supplier_ids());

  if not found then
    raise exception 'Your account is not linked to a supplier yet.';
  end if;

  return h;
end;
$$;

revoke all on function public.set_my_instagram(text) from public;
grant execute on function public.set_my_instagram(text) to authenticated;

-- ------------------------------------------------------------
-- Check afterwards (read-only):
--   select column_name from information_schema.columns
--   where table_name = 'suppliers' and column_name = 'instagram';
-- ------------------------------------------------------------
