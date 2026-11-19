-- ============================================================
-- 20261119_release_delete_any.sql
-- Let the admin delete any release (folder), not only a never-public draft.
--
-- Replaces the guard from 20261109_release_delete_guard.sql. That guard
-- refused to delete anything that was scheduled, launched, live or archived.
-- Test folders that went live could therefore never be removed. The admin
-- screen now asks for the folder title to be typed before it deletes a
-- release that has been public, so the status check here is no longer needed.
--
-- Deleting a release still:
--   * detaches its notes and lookbook sets and turns them into private drafts
--     (they are kept, not deleted, and no longer visible to visitors),
--   * cascades to its placements (products stay in inventory), updates and
--     activity log through the existing foreign keys,
--   * keeps every order: orders.edit_id is "on delete set null".
-- Only the admin can delete: the "Admin manages edits" policy is unchanged.
--
-- Safe to re-run: function is "or replace", trigger is dropped and recreated.
-- No table is dropped and no existing row is touched by running this file.
-- ============================================================

create or replace function public.edits_delete_guard()
returns trigger
language plpgsql
as $$
begin
  -- Keep attached notes and sets, release them from this folder and make them
  -- private drafts. A published note with no folder is public on its own, so
  -- without the draft step it would stay visible after the folder is gone.
  update public.notes
     set data = jsonb_set(jsonb_set(data, '{folderId}', '""'), '{status}', '"draft"')
   where data->>'folderId' = old.id::text;

  update public.studies
     set data = jsonb_set(jsonb_set(data, '{relatedDropId}', '""'), '{status}', '"draft"')
   where data->>'relatedDropId' = old.id::text;

  return old;
end;
$$;

drop trigger if exists edits_delete_guard_trg on public.edits;
create trigger edits_delete_guard_trg
  before delete on public.edits
  for each row execute function public.edits_delete_guard();

-- ------------------------------------------------------------
-- Check to run afterwards (read-only). The function body should no longer
-- mention "Only a draft release":
--   select prosrc from pg_proc where proname = 'edits_delete_guard';
-- ------------------------------------------------------------
