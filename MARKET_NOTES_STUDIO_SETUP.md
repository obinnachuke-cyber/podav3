# Market Note Publishing Studio — Supabase setup (one time)

This module (the Tiptap-based editor for Market Notes) needs **one new thing**
in Supabase: a dedicated Storage bucket for images uploaded from inside the
editor. Everything else — the `notes` table, its RLS policies, the admin
login — already exists from `NOTES_SETUP.md` and needs no changes: every new
field the Studio uses (`slug`, `contentJson`, `websiteHtml`, `emailHtml`,
`coverImageAlt`, `emailSubject`, `emailPreviewText`, `updatedAt`) lives inside
the same `data jsonb` column every note already uses, so there is no table
migration to run and no existing Note can be affected.

This takes about a minute.

## Step 1 — Run the setup SQL

1. Open your project at **supabase.com** → your `poda` project.
2. Left sidebar → **SQL Editor** → **New query**.
3. Paste **everything** in the code block below and click **Run**.

```sql
-- Dedicated bucket for Market Note Studio images (cover images + in-body
-- images). Kept separate from item-images so this module's access rules
-- are independent of the item photo bucket's.
insert into storage.buckets (id, name, public)
values ('note-media', 'note-media', true)
on conflict (id) do nothing;

-- Anyone can VIEW note images (they're embedded in the public website and
-- in emails sent to subscribers) — but only a signed-in admin may upload
-- or delete them. Unlike item-images, there is no anonymous write path
-- to this bucket at all.
drop policy if exists "Public can view note media" on storage.objects;
create policy "Public can view note media"
  on storage.objects for select using (bucket_id = 'note-media');

drop policy if exists "Admin can upload note media" on storage.objects;
create policy "Admin can upload note media"
  on storage.objects for insert to authenticated with check (bucket_id = 'note-media');

drop policy if exists "Admin can update note media" on storage.objects;
create policy "Admin can update note media"
  on storage.objects for update to authenticated using (bucket_id = 'note-media');

drop policy if exists "Admin can delete note media" on storage.objects;
create policy "Admin can delete note media"
  on storage.objects for delete to authenticated using (bucket_id = 'note-media');
```

You should see **"Success. No rows returned."**

## Step 2 (optional) — Enforce unique slugs at the database level

The Studio already checks for duplicate slugs against the notes already
loaded in the admin (the same approach the existing Note-ID generator
uses), so this step is **not required** for the feature to work. If you'd
like the database itself to reject a duplicate slug as a second line of
defense, you can add a functional unique index. This is safe to run at any
time — it only rejects *new* writes that collide; it does not touch or
validate any existing row (older notes have no `slug` yet, and Postgres
treats every `NULL` as distinct, so they never conflict with each other or
with a new slug):

```sql
create unique index if not exists notes_slug_unique_idx
  on public.notes ((data->>'slug'))
  where (data->>'slug') is not null and (data->>'slug') <> '';
```

If you add this, a save from the Studio that collides with another note's
slug will fail with a database error in addition to the in-app check.

## Step 3 — Nothing else to configure

- `RESEND_API_KEY` / `ADMIN_EMAIL` — already set up per `RESEND_SETUP.md`;
  the Studio's "Send Test Email" / "Send Broadcast" actions reuse that
  exact same server-side send path (`/api/notes-send` in `_worker.js`)
  unchanged.
- No new Cloudflare environment variables, secrets, or build-command
  changes are needed — `poda-editor.bundle.js` and `poda-dompurify.min.js`
  are committed files, deployed the same way `supabase.min.js` already is.
- If `note-media` doesn't exist yet, image uploads inside the Studio will
  fail with a clear "Upload failed" message in the editor until you run
  Step 1 above — nothing else in the admin (items, drops, studies,
  subscribers) is affected either way.
