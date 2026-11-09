-- ============================================================
-- 20261109_release_delete_guard.sql
-- Archive-safe delete for releases (folders).
--
-- A release may be deleted only while it has never been public:
--   status = 'draft', no scheduled drop, no manual launch.
-- Anything that has been opened, scheduled, launched or archived must be
-- archived instead; the delete is refused by the database, not just the UI.
--
-- Deleting a release also:
--   * detaches its notes and lookbook sets (they are kept; they store the
--     release id in jsonb with no foreign key, so without this they would
--     point at a missing release and the public policies would hide them),
--   * cascades to its placements (products stay in inventory), updates and
--     activity log through the existing foreign keys.
--
-- Safe to re-run: function is "or replace", trigger is dropped and recreated.
-- No table is dropped and no existing row is touched by running this file.
-- ============================================================

create or replace function public.edits_delete_guard()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft' or old.publish_at is not null or old.launched_at is not null then
    raise exception 'Only a draft release that was never scheduled or launched can be deleted. Archive it instead.';
  end if;

  -- Keep attached notes and sets; just release them from this folder.
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

-- ------------------------------------------------------------
-- Checks to run afterwards (read-only):
--   select tgname from pg_trigger where tgrelid = 'public.edits'::regclass and not tgisinternal;
-- ------------------------------------------------------------
