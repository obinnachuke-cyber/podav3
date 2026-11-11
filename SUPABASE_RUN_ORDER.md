# Supabase: what to run, in order

Every file below is repeatable and deletes no data, except where noted. Run each
one in Supabase Dashboard → SQL Editor → New query: open the file from this repo,
copy the whole contents, paste, Run. Stop at the first error and read the message.

Do NOT run: `FOLDERS_PUBLIC_SETUP.sql` (superseded, it stops itself),
`SUPABASE_FULL_SETUP.sql` (a pasted copy of other files, can drift).

## Step 0. See what is already applied

Paste this first. It tells you which steps you can skip.

```sql
select
  to_regclass('public.profiles')            is not null as base_marketplace,
  to_regclass('public.note_revisions')      is not null as release_workspace,
  to_regclass('public.seller_applications') is not null as seller_applications,
  exists (select 1 from information_schema.columns
          where table_name = 'products' and column_name = 'size') as seller_cards,
  exists (select 1 from pg_trigger
          where tgname = 'edits_delete_guard_trg') as delete_guard,
  (select count(*) from public.profiles where role = 'admin') as admin_rows;
```

If a column reads `false`, run that step. `admin_rows` must be at least 1.

## Order

| # | File | Needed for |
|---|------|-----------|
| 1 | `SUPABASE_FOUNDATION.sql` | Base tables and storage buckets |
| 2 | `MARKETPLACE_APPLY_PART1.sql` | Marketplace tables, roles, RLS |
| 3 | `MARKETPLACE_APPLY_PART2_ADMIN.sql` | Makes your login the admin (UID already filled in; change it if you use a different login) |
| 4 | `migrations/20261028_release_workspace.sql` | Release workspace, timed drops, note revisions (autosave fix), folder gating for notes and studies |
| 5 | `SELLER_INVITES_APPLY.sql` | Closes the invite-listing hole |
| 6 | `SELLER_INVITE_LINKS_APPLY.sql` | Short invite links |
| 7 | `SELLER_CARDS_APPLY.sql` | Seller cards. Run after step 4, and again if you ever re-run steps 2 or 4 |
| 8 | `SELLER_APPLICATIONS_APPLY.sql` | Sell-with-poda applications and the private photo bucket |
| 9 | `migrations/20261109_release_delete_guard.sql` | Archive-safe delete (below) |
| 10 | `migrations/20261110_supplier_instagram.sql` | Seller Instagram handle |
| 11 | `migrations/20261111_checkout.sql` | Real checkout: orders, the 30-minute hold, the sale. Run after steps 4 and 7. It replaces the public product view and the product guard, so run it again after any re-run of step 7. Setup: `CHECKOUT_SETUP.md` |
| 13 | `migrations/20261112_order_shipping.sql` | Carrier and tracking columns on orders, for the shipping email. Run after step 11. Safe to run at any time |
| 12 | `migrations/20261111_checkout_selftest.sql` | Checks step 11 and rolls itself back. Ends in a red error box on purpose. The last line should say 26 passed, 0 failed |

Steps 1 to 3 are first-time setup. If Step 0 shows `base_marketplace` true and
`admin_rows` at least 1, skip them.

## Step 9 SQL (new)

A release can be deleted only while it is a draft with no drop and no launch.
Deleting detaches its notes and lookbook sets so they are kept.

```sql
create or replace function public.edits_delete_guard()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft' or old.publish_at is not null or old.launched_at is not null then
    raise exception 'Only a draft release that was never scheduled or launched can be deleted. Archive it instead.';
  end if;

  update public.notes
     set data = jsonb_set(data, '{folderId}', '""')
   where data->>'folderId' = old.id::text;

  update public.studies
     set data = jsonb_set(data, '{relatedDropId}', '""')
   where data->>'relatedDropId' = old.id::text;

  return old;
end;
$$;

drop trigger if exists edits_delete_guard_trg on public.edits;
create trigger edits_delete_guard_trg
  before delete on public.edits
  for each row execute function public.edits_delete_guard();
```

## Checks after running everything

```sql
-- Policies that gate notes and studies. Expect the two "Public read published" names.
select tablename, policyname from pg_policies where tablename in ('notes','studies');

-- Exactly 0 or 1 working release.
select count(*) filter (where is_working) as working from public.edits;

-- Delete guard installed.
select tgname from pg_trigger where tgrelid = 'public.edits'::regclass and not tgisinternal;

-- Items must not be publicly readable. Expect admin-only policy names.
select policyname from pg_policies where tablename = 'items';
```

## Test the delete guard (in the admin, not SQL)

1. Create a throwaway release, attach a note, delete it. The note should still exist.
2. Open a release to the public, then try Delete. The button is gone and the database refuses a direct delete.

## Supabase settings to check by hand (not SQL)

- Authentication → Providers → Email: decide whether "Confirm email" is on, and
  whether open sign-up should be disabled. The audit flagged open sign-up.
- Storage: buckets `item-images`, `note-media`, `supplier-media` and `applications`
  exist (the files above create them).
- Project Settings → API: the anon key in `supabase-config.js` is the anon key,
  never the service_role key.
