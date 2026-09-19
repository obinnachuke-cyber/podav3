# Subscribers — Supabase setup (Module 1: capture only)

This adds one table so visitors can join poda's email list from the homepage,
Market Note pages, and the site footer. **No email is actually sent yet** —
this module only captures and stores the signup. Sending (via Resend) is a
separate, later module.

Run this SQL once in your Supabase project:
**Supabase Dashboard → SQL Editor → New query → paste → Run**

```sql
create table if not exists public.subscribers (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

-- Real, case-insensitive uniqueness on email — this is what actually
-- prevents duplicate signups, not the app code.
create unique index if not exists subscribers_email_unique
  on public.subscribers ((lower(data->>'email')));

alter table public.subscribers enable row level security;

-- Anyone (signed out) may join the list — insert only, no read-back.
-- This means a visitor can add a row but can never read the subscriber
-- list back out — that's what keeps it private.
drop policy if exists "Anyone can subscribe" on public.subscribers;
create policy "Anyone can subscribe"
  on public.subscribers for insert
  to anon, authenticated
  with check (true);

-- Only the signed-in admin (your Supabase Auth account) may read,
-- update, or delete subscriber records.
drop policy if exists "Admin can read subscribers" on public.subscribers;
create policy "Admin can read subscribers"
  on public.subscribers for select
  to authenticated
  using (true);

drop policy if exists "Admin can update subscribers" on public.subscribers;
create policy "Admin can update subscribers"
  on public.subscribers for update
  to authenticated
  using (true) with check (true);

drop policy if exists "Admin can delete subscribers" on public.subscribers;
create policy "Admin can delete subscribers"
  on public.subscribers for delete
  to authenticated
  using (true);
```

That's it — no environment variables, no Edge Function, no external service
for this module. The admin JS and public signup form handle the rest.

## Data shape (for reference)

Each row's `data` column holds:

```
{
  email:       "person@example.com",   // normalized: trimmed + lowercased
  firstName:   "",                     // optional
  source:      "homepage" | "footer" | "note-detail",
  status:      "ACTIVE" | "UNSUBSCRIBED" | "SUPPRESSED",
  consent:     true,
  consentAt:   "2026-...",             // ISO timestamp
  createdAt:   "2026-...",             // ISO timestamp (signup date)
  updatedAt:   "2026-..."              // set only after an admin edit
}
```

## Known limitation

If someone unsubscribes (status set to `UNSUBSCRIBED` by the admin) and later
tries to sign up again with the same email, the public form will tell them
"you're already on the list" rather than silently reactivating them — the
public form can only *insert*, never *update* (that's an intentional RLS
restriction so a stranger can't flip anyone's status). To bring someone back,
the admin re-activates them manually from Admin → Subscribers.

## What's next (not built in this module)

Actually emailing subscribers (Resend integration, broadcast sending, a
self-serve unsubscribe link/page) is a separate module — this one only
covers capture, storage, and admin visibility/export.
