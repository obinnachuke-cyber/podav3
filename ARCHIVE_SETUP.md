# Archive Images — Supabase Setup

Run this SQL in your Supabase SQL editor (Dashboard → SQL Editor → New query):

```sql
-- Create the archive_images table
create table if not exists archive_images (
  id          text        primary key,
  data        jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- Enable Row Level Security
alter table archive_images enable row level security;

-- Anyone can read archive images (public gallery)
create policy "Public can read archive images"
  on archive_images for select
  using (true);

-- Only authenticated users can insert / update / delete
create policy "Authenticated users can manage archive images"
  on archive_images for all
  using (auth.role() = 'authenticated');
```

Images are uploaded to the existing `item-images` Supabase Storage bucket
(same one used for closet item photos). No new bucket needed.
