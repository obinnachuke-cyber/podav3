# Module 2 — Resend email delivery: Supabase setup

This adds what's needed to actually send a Market Note by email: a per-subscriber
unsubscribe token, a table that logs every send attempt, and a narrow function
that lets a stranger unsubscribe using only their own link — without ever
weakening the existing `subscribers` RLS policies from Module 1.

**No service-role key is used anywhere in this module.** The Cloudflare Function
that sends email authenticates as your existing admin Supabase session for
reads/writes that need it, and the public unsubscribe link only ever calls the
one narrow function below — nothing else about `subscribers` becomes more open.

Run this SQL once in your Supabase project:
**Supabase Dashboard → SQL Editor → New query → paste → Run**

```sql
-- 1. Give every subscriber an unguessable unsubscribe token.
--    (New signups already get one automatically going forward — this just
--    backfills anyone who joined before this change.)
update public.subscribers
set data = jsonb_set(data, '{unsubscribeToken}', to_jsonb(gen_random_uuid()::text))
where not (data ? 'unsubscribeToken');

create unique index if not exists subscribers_unsubscribe_token_unique
  on public.subscribers ((data->>'unsubscribeToken'));

-- 2. Send log — one row per test or broadcast attempt.
create table if not exists public.send_logs (
  id             uuid primary key default gen_random_uuid(),
  note_id        text not null,
  subject        text not null,
  type           text not null check (type in ('test', 'broadcast')),
  attempted      integer not null default 0,
  succeeded      integer not null default 0,
  failed         integer not null default 0,
  resend_ids     jsonb not null default '[]'::jsonb,
  admin_email    text not null,
  status         text not null check (status in ('completed', 'failed', 'partial')),
  created_at     timestamptz not null default now()
);

alter table public.send_logs enable row level security;

-- Same convention as every other admin-only table in this app: the one
-- trusted admin (authenticated) has full access; nobody else has any.
drop policy if exists "Admin can read send logs" on public.send_logs;
create policy "Admin can read send logs"
  on public.send_logs for select
  to authenticated
  using (true);

drop policy if exists "Admin can write send logs" on public.send_logs;
create policy "Admin can write send logs"
  on public.send_logs for insert
  to authenticated
  with check (true);

-- 3. Self-service unsubscribe — a narrow, explicit exception, not an RLS change.
--    SECURITY DEFINER lets this one function bypass RLS internally to do
--    exactly one thing (flip status to UNSUBSCRIBED for the matching token);
--    it grants no other access, and the subscribers table's RLS policies
--    themselves are completely unchanged.
create or replace function public.unsubscribe_by_token(p_token text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
  v_status text;
begin
  select id, data->>'status' into v_id, v_status
  from public.subscribers
  where data->>'unsubscribeToken' = p_token
  limit 1;

  if v_id is null then
    return 'not_found';
  end if;

  if v_status = 'UNSUBSCRIBED' then
    return 'already';
  end if;

  update public.subscribers
  set data = jsonb_set(data, '{status}', '"UNSUBSCRIBED"')
  where id = v_id;

  return 'ok';
end;
$$;

revoke all on function public.unsubscribe_by_token(text) from public;
grant execute on function public.unsubscribe_by_token(text) to anon, authenticated;
```

You should see **"Success. No rows returned."**

## What this does NOT change

- The `subscribers` table's RLS policies from `SUBSCRIBERS_SETUP.md` are untouched —
  anon still can't read, update, or delete subscriber rows directly.
- Nothing here grants broader access to anyone; the new function does exactly
  one thing (unsubscribe-by-token) and nothing else.

## Cloudflare setup (separate from Supabase)

Two secrets should already exist (per your setup): `RESEND_API_KEY`, `ADMIN_EMAIL`.
Two more values are needed by the new Cloudflare Pages Functions — these are
**not secret** (they're the same public URL/key already sitting in
`supabase-config.js`), but Pages Functions need them passed in as environment
variables since they can't read your site's client-side JS:

| Variable | Value | Type |
|---|---|---|
| `RESEND_API_KEY` | (already set) | Secret |
| `ADMIN_EMAIL` | (already set) | Secret |
| `SUPABASE_URL` | same value as `PODA_SUPABASE_URL` in `supabase-config.js` | Plain variable |
| `SUPABASE_ANON_KEY` | same value as `PODA_SUPABASE_ANON_KEY` in `supabase-config.js` | Plain variable |
| `SITE_URL` | `https://podapodapoda.co` | Plain variable |

Set these in the Cloudflare Pages dashboard → your project → Settings →
Environment variables (Production, and Preview if you test there too).
