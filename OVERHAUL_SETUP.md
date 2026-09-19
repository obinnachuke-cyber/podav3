# poda — overhaul setup (one time)

The overhaul adds two new content types managed from the admin: **Drops** and
**Visual Studies**. They follow the exact same `{ id, data }` + Row Level
Security pattern as your existing `items` and `notes` tables, so nothing about
the current data changes.

New **product fields** (transaction type, source, measurements, etc.) and new
**market-note fields** (issue number, subtitle, tags) live *inside* the existing
`items.data` / `notes.data` JSON — no column migration needed. Only the two new
tables below require a one-time SQL run.

## Run this once

**Supabase Dashboard → SQL Editor → New query → paste → Run.**

```sql
-- ============================================================
-- DROPS: each drop (e.g. DROP 001) is one row of JSON.
-- ============================================================
create table if not exists public.drops (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.drops enable row level security;

drop policy if exists "Public can read drops" on public.drops;
create policy "Public can read drops"
  on public.drops for select using (true);

drop policy if exists "Admin full access to drops" on public.drops;
create policy "Admin full access to drops"
  on public.drops for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- ============================================================
-- STUDIES: each Visual Study is one row of JSON.
-- ============================================================
create table if not exists public.studies (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.studies enable row level security;

drop policy if exists "Public can read studies" on public.studies;
create policy "Public can read studies"
  on public.studies for select using (true);

drop policy if exists "Admin full access to studies" on public.studies;
create policy "Admin full access to studies"
  on public.studies for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
```

You should see **"Success. No rows returned."** That's it — the admin handles
everything else. Reuses the existing `item-images` storage bucket for all
imagery (drop covers, study images, product photos).

## Public form uploads (Sell with poda + Sourcing)

The Sell and Source forms let visitors attach photos. Since a `mailto:` can't
carry attachments, the photos are uploaded to a **public `submissions` bucket**
and their links are added to the email. Run this once so anonymous visitors can
upload (read-only otherwise):

```sql
-- Public bucket for form photo uploads.
insert into storage.buckets (id, name, public)
values ('submissions', 'submissions', true)
on conflict (id) do nothing;

drop policy if exists "Public can view submissions" on storage.objects;
create policy "Public can view submissions"
  on storage.objects for select using (bucket_id = 'submissions');

-- Anyone (even signed-out visitors) may upload a submission photo.
drop policy if exists "Anyone can upload a submission" on storage.objects;
create policy "Anyone can upload a submission"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'submissions');
```

Note: this intentionally allows anonymous uploads (that's how a public form
works). Photos are auto-shrunk in the browser before upload. If you ever get
spam, delete the `insert` policy above to turn uploads off — the forms still
work, just without photos.

## Data shapes (for reference)

**Drop** — `id, number, slug, title, thesis, question, status, releaseDate,
coverImage, marketNoteId, visualStudyId, sourceMix, productIds[]`
Status values: `In Assembly` · `Live` · `Archived`.

**Visual Study** — `id, studyNumber, slug, title, framing, date, coverImage,
images[], captions[], relatedNoteId, relatedDropId, relatedProductIds[]`
