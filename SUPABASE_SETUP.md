# Poda — Supabase setup (one time)

Your Project URL and anon key are already filled into `supabase-config.js`.
You just need to create the database table + photo storage. This takes ~2 minutes.

## Step 1 — Run the setup SQL

1. Open your project at **supabase.com** → your `poda` project.
2. Left sidebar → **SQL Editor** → **New query**.
3. Paste **everything** in the code block below and click **Run**.

```sql
-- 1. Items table: each clothing piece is stored as one row of JSON.
create table if not exists public.items (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keep updated_at fresh on every change.
create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists items_touch_updated_at on public.items;
create trigger items_touch_updated_at
  before update on public.items
  for each row execute function public.touch_updated_at();

-- 2. Security: the public can READ items; only a logged-in admin can change them.
alter table public.items enable row level security;

drop policy if exists "Public can read items" on public.items;
create policy "Public can read items"
  on public.items for select using (true);

drop policy if exists "Admin can insert items" on public.items;
create policy "Admin can insert items"
  on public.items for insert to authenticated with check (true);

drop policy if exists "Admin can update items" on public.items;
create policy "Admin can update items"
  on public.items for update to authenticated using (true) with check (true);

drop policy if exists "Admin can delete items" on public.items;
create policy "Admin can delete items"
  on public.items for delete to authenticated using (true);

-- 3. Photo storage bucket (publicly viewable images).
insert into storage.buckets (id, name, public)
values ('item-images', 'item-images', true)
on conflict (id) do nothing;

drop policy if exists "Public can view item images" on storage.objects;
create policy "Public can view item images"
  on storage.objects for select using (bucket_id = 'item-images');

drop policy if exists "Admin can upload item images" on storage.objects;
create policy "Admin can upload item images"
  on storage.objects for insert to authenticated with check (bucket_id = 'item-images');

drop policy if exists "Admin can update item images" on storage.objects;
create policy "Admin can update item images"
  on storage.objects for update to authenticated using (bucket_id = 'item-images');

drop policy if exists "Admin can delete item images" on storage.objects;
create policy "Admin can delete item images"
  on storage.objects for delete to authenticated using (bucket_id = 'item-images');
```

You should see **"Success. No rows returned."**

## Step 2 — Make sure your admin user exists

Left sidebar → **Authentication** → **Users**. You should see the email you created.
If not: **Add user → Create new user**, enter an email + password, and tick **Auto Confirm User**.
That email + password is what you'll type on the admin login screen.

## Step 3 — Open the site

Open `index.html` in your browser (or run a local server — see README notes).
- The **public page** loads with no login.
- Click **Admin** → sign in with your email + password.
- Click **Import from this browser** once to pull in any items you'd already added.

That's it. Items now live in the database and show up on every device.
