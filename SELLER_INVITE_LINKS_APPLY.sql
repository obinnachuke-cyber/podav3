-- ============================================================
-- SELLER_INVITE_LINKS_APPLY.sql
-- Short, readable invite links: podapodapoda.co/join/ada-k7m2x9q
-- instead of seller.html?invite=<long uuid>.
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run.
-- Safe to re-run. Deletes nothing. Old uuid links keep working.
--
-- The code is the supplier's name plus 7 random characters, so it
-- reads like a name but cannot be guessed. It is single use: once the
-- invite is accepted the code stops resolving.
-- ============================================================

alter table public.supplier_invites add column if not exists code text;
create unique index if not exists supplier_invites_code_key on public.supplier_invites (code);

-- name -> "ada-closet-k7m2x9q"
create or replace function public.make_invite_code(base text)
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';   -- no 0/o/1/i/l
  slug   text;
  suffix text;
  raw    bytea;
  candidate text;
  i int;
begin
  slug := regexp_replace(lower(coalesce(base, '')), '[^a-z0-9]+', '-', 'g');
  slug := btrim(left(slug, 18), '-');
  if slug = '' then slug := 'invite'; end if;

  loop
    -- gen_random_uuid() is cryptographically random; use its bytes.
    raw := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    suffix := '';
    for i in 0..6 loop
      suffix := suffix || substr(alphabet, (get_byte(raw, i) % length(alphabet)) + 1, 1);
    end loop;
    candidate := slug || '-' || suffix;
    exit when not exists (select 1 from public.supplier_invites where code = candidate);
  end loop;
  return candidate;
end;
$$;

-- Every new invite gets a code from its supplier's name.
create or replace function public.supplier_invites_set_code()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.code is null then
    new.code := public.make_invite_code(
      (select name from public.suppliers where id = new.supplier_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists supplier_invites_set_code on public.supplier_invites;
create trigger supplier_invites_set_code
  before insert on public.supplier_invites
  for each row execute function public.supplier_invites_set_code();

-- Give invites that already exist a code too.
update public.supplier_invites i
   set code = public.make_invite_code(s.name)
  from public.suppliers s
 where s.id = i.supplier_id and i.code is null;

-- The join page turns a code into the invite it belongs to. Only unused
-- invites resolve, and only the exact code does.
create or replace function public.resolve_invite_code(invite_code text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select token from public.supplier_invites
  where code = lower(btrim(invite_code)) and used_at is null
  limit 1;
$$;

revoke all on function public.resolve_invite_code(text) from public;
grant execute on function public.resolve_invite_code(text) to anon, authenticated;
