-- ============================================================
-- 20261120_release_emails.sql
-- Support for the drop, Index and reminder emails.
--
--   release_email_log  one row for every broadcast: which release, which Index
--                      set, how many went out. It stops the same email being
--                      sent twice by accident and feeds the daily send count.
--   release_reminders  the two timed reminders for a drop: the morning of the
--                      drop and 30 minutes before. The Worker's cron trigger
--                      sends each one when its time comes.
--
-- Admin only, like release_events. The cron job runs with the service key,
-- which bypasses these policies.
--
-- Safe to re-run: every statement is "if not exists" or drops and recreates a
-- policy. No existing row is touched.
-- ============================================================

create table if not exists public.release_email_log (
  id          uuid primary key default gen_random_uuid(),
  edit_id     uuid references public.edits(id) on delete set null,
  study_id    text,
  kind        text not null
                check (kind in ('drop', 'index', 'reminder_morning', 'reminder_soon')),
  subject     text,
  attempted   integer not null default 0,
  succeeded   integer not null default 0,
  failed      integer not null default 0,
  status      text not null default 'completed',
  admin_email text,
  created_at  timestamptz not null default now()
);

create index if not exists release_email_log_edit_idx
  on public.release_email_log (edit_id, kind, created_at desc);
create index if not exists release_email_log_day_idx
  on public.release_email_log (created_at desc);

create table if not exists public.release_reminders (
  id         uuid primary key default gen_random_uuid(),
  edit_id    uuid not null references public.edits(id) on delete cascade,
  kind       text not null check (kind in ('morning', 'soon')),
  send_at    timestamptz not null,
  drop_at    timestamptz not null,   -- the drop time when this was scheduled
  status     text not null default 'scheduled'
               check (status in ('scheduled', 'sending', 'sent', 'cancelled', 'skipped', 'failed')),
  note       text,
  attempted  integer,
  succeeded  integer,
  failed     integer,
  sent_at    timestamptz,
  created_at timestamptz not null default now(),
  unique (edit_id, kind)
);

create index if not exists release_reminders_due_idx
  on public.release_reminders (send_at) where status = 'scheduled';

alter table public.release_email_log enable row level security;
alter table public.release_reminders enable row level security;

drop policy if exists "Admin manages release email log" on public.release_email_log;
create policy "Admin manages release email log"
  on public.release_email_log for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admin manages release reminders" on public.release_reminders;
create policy "Admin manages release reminders"
  on public.release_reminders for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------
-- Checks to run afterwards (read-only):
--   select count(*) from public.release_email_log;
--   select count(*) from public.release_reminders;
-- ------------------------------------------------------------
