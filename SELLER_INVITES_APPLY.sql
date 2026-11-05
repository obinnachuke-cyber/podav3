-- ============================================================
-- SELLER_INVITES_APPLY.sql — run in the Supabase SQL editor.
--
-- Closes a hole in the supplier invites. The old policy
-- "Read invite by token" let ANY visitor list every unused invite,
-- including each invited email and its token. This replaces it with
-- a function that returns one invite, and only to someone who already
-- holds that invite's token. Repeatable; deletes no data.
--
-- After running it, the seller page reads invites through
-- get_invite_by_token(), so deploy the matching code before or right
-- after running this file.
-- ============================================================

-- 1. Remove the open read. Only the admin can read the table directly now.
drop policy if exists "Read invite by token" on public.supplier_invites;

-- 2. One invite, by token. SECURITY DEFINER so it can read past RLS, but it
--    returns a single row and only for an unused invite.
create or replace function public.get_invite_by_token(invite_token uuid)
returns table (email text, supplier_name text)
language sql
stable
security definer
set search_path = public
as $$
  select i.email, s.name
  from public.supplier_invites i
  join public.suppliers s on s.id = i.supplier_id
  where i.token = invite_token
    and i.used_at is null
  limit 1;
$$;

revoke all on function public.get_invite_by_token(uuid) from public;
grant execute on function public.get_invite_by_token(uuid) to anon, authenticated;

-- 3. Quick check. Signed out, a direct read of the table should now return
--    nothing, and this should return exactly the policies below.
select policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'supplier_invites';
