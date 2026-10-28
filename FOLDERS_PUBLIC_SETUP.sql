-- ============================================================
-- FOLDERS_PUBLIC_SETUP.sql  —  SUPERSEDED. DO NOT RUN.
--
-- Its public_products view (products for a 'live' folder, with photos and
-- seller name) is now defined, with the drop-time gate and further fixes, by:
--
--     migrations/20261028_release_workspace.sql
--
-- Running this old script after that migration would replace the gated view
-- with one that ignores the scheduled drop time, so it now stops immediately.
-- ============================================================
do $$
begin
  raise exception 'FOLDERS_PUBLIC_SETUP.sql is superseded by migrations/20261028_release_workspace.sql. Run that migration instead.';
end $$;
