-- ============================================================
-- 20261113_payouts_selftest.sql
-- Run in the Supabase SQL editor AFTER 20261113_payouts.sql.
--
-- It builds its own test seller and orders, acts as your admin for a moment,
-- and tries to break each payout rule. At the end it raises an error ON
-- PURPOSE. That error is the report, and it rolls everything back, so no test
-- data is left. Read the last line of the red box:
--   "PAYOUT SELF-TEST RESULT: 24 passed, 0 failed."   all good
--   anything with FAIL lines                           send me the whole message
-- ============================================================

do $selftest$
declare
  passed  integer := 0;
  total   integer := 0;
  fails   text := '';
  v_admin uuid;
  sup_a uuid; sup_b uuid;
  prod_a uuid; prod_b uuid;
  o1 uuid; o2 uuid; o3 uuid; o4 uuid; o5 uuid; o6 uuid;
  r jsonb; r2 jsonb;
  pay1 uuid;
  v_msg text;
  v_int integer;
  v_bool boolean;
  v_status text;
  ord public.orders%rowtype;
  pay public.payouts%rowtype;
begin
  -- Act as your admin for the length of this test. ------------------------
  select user_id into v_admin from public.profiles where role = 'admin' limit 1;
  if v_admin is null then
    raise exception 'No admin row in public.profiles, so the test cannot run. Run MARKETPLACE_APPLY_PART2_ADMIN.sql first.';
  end if;
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  if not public.is_admin() then
    raise exception 'Could not act as the admin in this editor, so the test cannot run.';
  end if;

  -- Test data -------------------------------------------------------------
  insert into public.suppliers (name, type, commission_bps) values ('SELFTEST A', 'consignor', 2500) returning id into sup_a;
  insert into public.suppliers (name, type, commission_bps) values ('SELFTEST B', 'consignor', 2500) returning id into sup_b;
  insert into public.products (supplier_id, state, title, price_cents, quantity, is_available)
    values (sup_a, 'accepted', 'SELFTEST piece A', 42000, 1, true) returning id into prod_a;
  insert into public.products (supplier_id, state, title, price_cents, quantity, is_available)
    values (sup_b, 'accepted', 'SELFTEST piece B', 26500, 1, true) returning id into prod_b;

  -- o1, o2: seller A, paid, owed.  o3: already paid out.  o4: still pending.
  -- o5: refund needed.  o6: seller B, owed.
  insert into public.orders (product_id, supplier_id, status, title, price_cents, commission_bps, commission_cents, seller_payout_cents, hold_expires_at, paid_at)
    values (prod_a, sup_a, 'paid', 'o1', 42000, 2500, 10500, 31500, now(), now()) returning id into o1;
  insert into public.orders (product_id, supplier_id, status, title, price_cents, commission_bps, commission_cents, seller_payout_cents, hold_expires_at, paid_at)
    values (prod_a, sup_a, 'paid', 'o2', 17500, 2500, 4375, 13125, now(), now()) returning id into o2;
  insert into public.orders (product_id, supplier_id, status, title, price_cents, commission_bps, commission_cents, seller_payout_cents, hold_expires_at, paid_at, payout_status, payout_paid_at)
    values (prod_a, sup_a, 'paid', 'o3', 10000, 2500, 2500, 7500, now(), now(), 'paid', now()) returning id into o3;
  insert into public.orders (product_id, supplier_id, status, title, price_cents, commission_bps, commission_cents, seller_payout_cents, hold_expires_at)
    values (prod_a, sup_a, 'pending', 'o4', 10000, 2500, 2500, 7500, now() + interval '30 minutes') returning id into o4;
  insert into public.orders (product_id, supplier_id, status, title, price_cents, commission_bps, commission_cents, seller_payout_cents, hold_expires_at, paid_at, conflict)
    values (prod_a, sup_a, 'paid', 'o5', 10000, 2500, 2500, 7500, now(), now(), true) returning id into o5;
  insert into public.orders (product_id, supplier_id, status, title, price_cents, commission_bps, commission_cents, seller_payout_cents, hold_expires_at, paid_at)
    values (prod_b, sup_b, 'paid', 'o6', 26500, 2500, 6625, 19875, now(), now()) returning id into o6;

  -- 1-3. A payout covers exactly the chosen orders and adds them up ---------
  r := public.create_payout(sup_a, array[o1, o2], '  Zelle ', ' ZL-1 ', '  first batch  ');
  pay1 := (r->>'payout_id')::uuid;

  total := total + 1;
  if (r->>'amount_cents')::integer = 44625 and (r->>'orders')::integer = 2 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 1: payout should total 44625 over 2 orders, got ' || r::text; end if;

  select * into pay from public.payouts where id = pay1;
  total := total + 1;
  if pay.supplier_id = sup_a and pay.amount_cents = 44625 and pay.method = 'Zelle' and pay.reference = 'ZL-1'
     and pay.note = 'first batch' and pay.voided_at is null and pay.paid_at is not null then passed := passed + 1;
  else fails := fails || E'\n  FAIL 2: the payout record is wrong (method, reference and note should be trimmed)'; end if;

  select count(*) into v_int from public.orders
   where id in (o1, o2) and payout_status = 'paid' and payout_id = pay1 and payout_paid_at is not null;
  total := total + 1;
  if v_int = 2 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 3: both orders should now be paid out and linked to the payout, found ' || v_int; end if;

  select payout_status into v_status from public.orders where id = o6;
  total := total + 1;
  if v_status = 'unpaid' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 4: another seller''s order must not be touched, it is ' || v_status; end if;

  -- 4-8. Nothing that should not be paid can slip through, and a refusal changes nothing
  begin perform public.create_payout(sup_a, array[o1, o2], 'Zelle', null, null); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  total := total + 1;
  if v_msg like 'Some of these orders cannot be paid out%' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 5: paying the same orders twice must be refused, got: ' || v_msg; end if;

  begin perform public.create_payout(sup_a, array[o3], 'Zelle', null, null); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  total := total + 1;
  if v_msg like 'Some of these orders cannot be paid out%' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 6: an order that was already paid out must be refused, got: ' || v_msg; end if;

  begin perform public.create_payout(sup_a, array[o4], 'Zelle', null, null); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  total := total + 1;
  if v_msg like 'Some of these orders cannot be paid out%' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 7: a pending order must be refused, got: ' || v_msg; end if;

  begin perform public.create_payout(sup_a, array[o5], 'Zelle', null, null); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  total := total + 1;
  if v_msg like 'Some of these orders cannot be paid out%' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 8: an order waiting for a refund must be refused, got: ' || v_msg; end if;

  begin perform public.create_payout(sup_a, array[o6], 'Zelle', null, null); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  select payout_status into v_status from public.orders where id = o6;
  select count(*) into v_int from public.payouts where supplier_id in (sup_a, sup_b);
  total := total + 1;
  if v_msg like 'Some of these orders cannot be paid out%' and v_status = 'unpaid' and v_int = 1 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 9: another seller''s order must be refused and leave no payout behind, got: ' || v_msg || ' payouts=' || v_int; end if;

  -- 9. A mixed batch with one bad order pays nothing at all
  begin perform public.create_payout(sup_b, array[o6, o3], 'Zelle', null, null); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  select payout_status into v_status from public.orders where id = o6;
  total := total + 1;
  if v_msg like 'Some of these orders%' and v_status = 'unpaid' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 10: one bad order must stop the whole batch, got: ' || v_msg || ' o6=' || v_status; end if;

  -- 10-11. Empty and missing lists are refused
  begin perform public.create_payout(sup_a, '{}'::uuid[], null, null, null); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  total := total + 1;
  if v_msg = 'Choose at least one order.' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 11: an empty list must be refused, got: ' || v_msg; end if;

  begin perform public.create_payout(sup_a, null, null, null, null); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  total := total + 1;
  if v_msg = 'Choose at least one order.' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 12: a missing list must be refused, got: ' || v_msg; end if;

  -- 12. The same order listed twice is paid once
  r2 := public.create_payout(sup_b, array[o6, o6], null, null, null);
  total := total + 1;
  if (r2->>'amount_cents')::integer = 19875 and (r2->>'orders')::integer = 1 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 13: an order listed twice must be paid once, got ' || r2::text; end if;

  -- 13-16. Voiding undoes the batch, exactly once, and the orders can be paid again
  perform public.void_payout(pay1);
  select count(*) into v_int from public.orders
   where id in (o1, o2) and payout_status = 'unpaid' and payout_id is null and payout_paid_at is null;
  total := total + 1;
  if v_int = 2 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 14: voiding should put both orders back to unpaid, found ' || v_int; end if;

  select * into pay from public.payouts where id = pay1;
  total := total + 1;
  if pay.voided_at is not null then passed := passed + 1;
  else fails := fails || E'\n  FAIL 15: a voided payout should stay in the history with a voided date'; end if;

  begin perform public.void_payout(pay1); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  total := total + 1;
  if v_msg like 'That payout was not found or is already voided%' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 16: voiding twice must be refused, got: ' || v_msg; end if;

  r := public.create_payout(sup_a, array[o1, o2], 'Venmo', null, null);
  total := total + 1;
  if (r->>'amount_cents')::integer = 44625 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 17: voided orders should be payable again, got ' || r::text; end if;

  -- 17-18. Only the admin can pay or void
  perform set_config('request.jwt.claim.sub', '', true);
  begin perform public.create_payout(sup_a, array[o1], null, null, null); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  total := total + 1;
  if v_msg = 'Admins only.' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 18: someone who is not the admin must not be able to pay out, got: ' || v_msg; end if;

  begin perform public.void_payout((r->>'payout_id')::uuid); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  total := total + 1;
  if v_msg = 'Admins only.' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 19: someone who is not the admin must not be able to void, got: ' || v_msg; end if;

  -- 19-21. Who may call what
  v_bool := has_function_privilege('anon', 'public.create_payout(uuid,uuid[],text,text,text)', 'execute')
         or has_function_privilege('anon', 'public.void_payout(uuid)', 'execute');
  total := total + 1;
  if not v_bool then passed := passed + 1;
  else fails := fails || E'\n  FAIL 20: visitors must not be able to call create_payout or void_payout'; end if;

  v_bool := has_function_privilege('anon', 'public.record_order_fee(uuid,integer)', 'execute')
         or has_function_privilege('authenticated', 'public.record_order_fee(uuid,integer)', 'execute');
  total := total + 1;
  if not v_bool and has_function_privilege('service_role', 'public.record_order_fee(uuid,integer)', 'execute') then passed := passed + 1;
  else fails := fails || E'\n  FAIL 21: only the service role may record a Stripe fee'; end if;

  -- 22. The Stripe fee is stored, and a negative one is refused
  perform public.record_order_fee(o1, 1300);
  select stripe_fee_cents into v_int from public.orders where id = o1;
  total := total + 1;
  if v_int = 1300 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 22: the fee should be stored as 1300, it is ' || coalesce(v_int::text, 'empty'); end if;

  begin perform public.record_order_fee(o1, -5); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  total := total + 1;
  if v_msg <> 'no error' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 23: a negative fee must be refused'; end if;

  -- 23. Payouts are private to the admin
  select relrowsecurity into v_bool from pg_class where oid = 'public.payouts'::regclass;
  select count(*) into v_int from pg_policies where schemaname = 'public' and tablename = 'payouts';
  total := total + 1;
  if v_bool and v_int = 1 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 24: payouts should have row security on and exactly one policy, found ' || v_int; end if;

  raise exception E'PAYOUT SELF-TEST RESULT: % passed, % failed.%\nEverything was rolled back, so no test data is left.',
    passed, (total - passed), fails;
end
$selftest$;
