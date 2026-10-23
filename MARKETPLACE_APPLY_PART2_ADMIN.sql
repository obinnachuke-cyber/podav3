-- ============================================================
-- MARKETPLACE_APPLY_PART2_ADMIN.sql — run this AFTER Part 1 succeeds.
--
-- Where to get the UUID: Supabase Dashboard -> Authentication -> Users
-- -> find the row for the email you use to log into admin.html today
-- -> copy the value under "UID" (looks like 8 chars - 4 - 4 - 4 - 12
-- chars, e.g. 3fa85f64-5717-4562-b3fc-2c963f66afa6).
--
-- Replace BOTH the UUID below and 'Chuke' with your real name if you
-- want, then run just this file.
-- ============================================================

insert into public.profiles (user_id, role, full_name)
values ('YOUR-AUTH-USER-UUID', 'admin', 'Chuke')
on conflict (user_id) do update set role = 'admin';

-- Your own inventory as a first-class supplier record, not a typed name.
insert into public.suppliers (name, type, commission_bps, status)
values ('poda', 'poda', 0, 'active')
on conflict do nothing;

-- Quick check — should return one row with role = 'admin'.
select * from public.profiles where role = 'admin';
