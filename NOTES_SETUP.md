# Market Notes — Supabase Setup

Run this SQL once in your Supabase project:
**Supabase Dashboard → SQL Editor → New query → paste → Run**

```sql
-- 1. Create the notes table (mirrors the items table pattern)
create table if not exists notes (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

-- 2. Public can read published notes; only signed-in admin can write
alter table notes enable row level security;

create policy "Public read published notes"
  on notes for select
  using ( (data->>'status') = 'published' );

create policy "Admin full access to notes"
  on notes for all
  using ( auth.role() = 'authenticated' )
  with check ( auth.role() = 'authenticated' );
```

That's it — no other config needed. The admin JS handles the rest.
