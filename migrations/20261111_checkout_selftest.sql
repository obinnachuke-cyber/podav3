-- ============================================================
-- 20261111_checkout_selftest.sql
-- Run this in the Supabase SQL editor AFTER 20261111_checkout.sql.
--
-- It builds its own test seller, release and pieces, then checks the hold,
-- the sale, the late-payment conflict and the permissions. At the end it
-- raises an error ON PURPOSE. That error is the report, and it makes
-- Postgres roll everything back, so no test data is left behind.
--
-- Read the last line of the red error box:
--   "SELF-TEST RESULT: 26 passed, 0 failed."   all good
--   anything with FAIL lines                    send me the whole message
-- ============================================================

do $selftest$
declare
  passed  integer := 0;
  fails   text := '';
  sup_c   uuid;  sup_p  uuid;
  ed_live uuid;  ed_future uuid;
  p1 uuid; p2 uuid; p3 uuid; p_hidden uuid; p_unplaced uuid; p_future uuid; p_poda uuid;
  h jsonb; hb jsonb; c jsonb;
  v_msg   text;
  v_avail text;
  v_qty   integer;
  v_int   integer;
  v_bool  boolean;
  o       public.orders%rowtype;
begin
  -- Test data -----------------------------------------------------
  insert into public.suppliers (name, type, commission_bps)
    values ('SELFTEST consignor', 'consignor', 2500) returning id into sup_c;
  insert into public.suppliers (name, type, commission_bps)
    values ('SELFTEST poda', 'poda', 0) returning id into sup_p;

  insert into public.edits (number, title, status, launched_at)
    values (99991, 'SELFTEST live release', 'live', now()) returning id into ed_live;
  insert into public.edits (number, title, status, publish_at)
    values (99992, 'SELFTEST future release', 'scheduled', now() + interval '3 days') returning id into ed_future;

  insert into public.products (supplier_id, state, title, brand, price_cents, quantity, is_available)
    values (sup_c, 'accepted', 'SELFTEST jacket', 'Test Brand', 42000, 1, true) returning id into p1;
  insert into public.products (supplier_id, state, title, brand, price_cents, quantity, is_available)
    values (sup_c, 'accepted', 'SELFTEST trouser', 'Test Brand', 26500, 1, true) returning id into p2;
  insert into public.products (supplier_id, state, title, brand, price_cents, quantity, is_available)
    values (sup_c, 'accepted', 'SELFTEST tote', 'Test Brand', 17500, 1, true) returning id into p3;
  insert into public.products (supplier_id, state, title, price_cents, quantity, is_available, is_hidden)
    values (sup_c, 'accepted', 'SELFTEST hidden', 10000, 1, true, true) returning id into p_hidden;
  insert into public.products (supplier_id, state, title, price_cents, quantity, is_available)
    values (sup_c, 'accepted', 'SELFTEST unplaced', 10000, 1, true) returning id into p_unplaced;
  insert into public.products (supplier_id, state, title, price_cents, quantity, is_available)
    values (sup_c, 'accepted', 'SELFTEST future', 10000, 1, true) returning id into p_future;
  insert into public.products (supplier_id, state, title, price_cents, quantity, is_available)
    values (sup_p, 'accepted', 'SELFTEST poda piece', 30000, 1, true) returning id into p_poda;

  insert into public.edit_placements (edit_id, product_id) values (ed_live, p1);
  insert into public.edit_placements (edit_id, product_id) values (ed_live, p2);
  insert into public.edit_placements (edit_id, product_id) values (ed_live, p3);
  insert into public.edit_placements (edit_id, product_id) values (ed_live, p_hidden);
  insert into public.edit_placements (edit_id, product_id) values (ed_live, p_poda);
  insert into public.edit_placements (edit_id, product_id) values (ed_future, p_future);

  -- 1. A hold records the order and freezes the split --------------
  h := public.create_order_hold(p1);
  select * into o from public.orders where id = (h->>'order_id')::uuid;
  if o.status = 'pending' and o.price_cents = 42000 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 1: hold did not create a pending order at the right price'; end if;
  if o.commission_bps = 2500 and o.commission_cents = 10500 and o.seller_payout_cents = 31500 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 2: split should be 10500 commission and 31500 to the seller, got ' || o.commission_cents || ' and ' || o.seller_payout_cents; end if;
  if o.payout_status = 'unpaid' and o.hold_expires_at > now() + interval '30 minutes' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 3: payout should start unpaid and the hold should last over 30 minutes'; end if;

  -- 2. While held, the public view says held and nobody else can buy
  select availability into v_avail from public.public_products where product_id = p1;
  if v_avail = 'held' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 4: public view should say held, said ' || coalesce(v_avail, 'nothing'); end if;

  begin
    perform public.create_order_hold(p1);
    v_msg := 'no error';
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg = 'poda_held' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 5: a second buyer should get poda_held, got ' || v_msg; end if;

  -- 3. Releasing the hold frees the piece, and it can be held again
  perform public.release_order((h->>'order_id')::uuid);
  select availability into v_avail from public.public_products where product_id = p1;
  if v_avail = 'available' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 6: after release the view should say available, said ' || coalesce(v_avail, 'nothing'); end if;

  h := public.create_order_hold(p1);
  if (h->>'order_id') is not null then passed := passed + 1;
  else fails := fails || E'\n  FAIL 7: could not hold the piece again after a release'; end if;

  -- 4. Paying completes the order and takes the piece off sale -----
  c := public.complete_order(
    (h->>'order_id')::uuid, 'cs_selftest_1', 'buyer@example.com', 'Pat Buyer',
    '{"line1":"1 Main St","city":"Brooklyn","state":"NY","postal_code":"11201","country":"US"}'::jsonb,
    1500, 43500);
  select * into o from public.orders where id = (h->>'order_id')::uuid;
  if (c->>'newly_paid')::boolean and o.status = 'paid' and not o.conflict then passed := passed + 1;
  else fails := fails || E'\n  FAIL 8: complete_order should mark the order paid with no conflict'; end if;
  if o.buyer_email = 'buyer@example.com' and o.shipping_cents = 1500 and o.amount_total_cents = 43500
     and o.shipping_address->>'city' = 'Brooklyn' and o.paid_at is not null then passed := passed + 1;
  else fails := fails || E'\n  FAIL 9: buyer, address and amounts were not saved on the order'; end if;

  select quantity into v_qty from public.products where id = p1;
  if v_qty = 0 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 10: the sale should take quantity to 0, it is ' || v_qty; end if;

  select availability into v_avail from public.public_products where product_id = p1;
  if v_avail = 'sold' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 11: public view should say sold, said ' || coalesce(v_avail, 'nothing'); end if;

  -- 5. The same payment delivered twice changes nothing ------------
  c := public.complete_order(
    (h->>'order_id')::uuid, 'cs_selftest_1', 'buyer@example.com', 'Pat Buyer', null, 1500, 43500);
  select quantity into v_qty from public.products where id = p1;
  if not (c->>'newly_paid')::boolean and v_qty = 0 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 12: a repeated payment must not take stock twice or report newly_paid'; end if;

  begin
    perform public.create_order_hold(p1);
    v_msg := 'no error';
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg = 'poda_sold' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 13: buying a sold piece should give poda_sold, got ' || v_msg; end if;

  -- 6. The product guard still stops everyone else ------------------
  -- The sale switched its bypass on for its own transaction step and then
  -- off. An ordinary non-admin update must be refused again.
  begin
    update public.products set title = 'tampered' where id = p2;
    v_msg := 'no error';
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg like 'Suppliers cannot set product state%' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 14: the product guard should still block non-admin edits, got: ' || v_msg; end if;

  -- 7. Pieces that must not be buyable ------------------------------
  begin perform public.create_order_hold(p_hidden); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  if v_msg = 'poda_unavailable' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 15: a hidden piece should be unavailable, got ' || v_msg; end if;

  begin perform public.create_order_hold(p_unplaced); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  if v_msg = 'poda_unavailable' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 16: a piece not in any release should be unavailable, got ' || v_msg; end if;

  begin perform public.create_order_hold(p_future); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  if v_msg = 'poda_unavailable' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 17: a piece in a drop that has not opened should be unavailable, got ' || v_msg; end if;

  begin perform public.create_order_hold(gen_random_uuid()); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  if v_msg = 'poda_unavailable' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 18: an unknown piece should be unavailable, got ' || v_msg; end if;

  -- 8. A hold that ran out stops counting --------------------------
  hb := public.create_order_hold(p2);
  update public.orders set hold_expires_at = now() - interval '1 minute' where id = (hb->>'order_id')::uuid;
  select availability into v_avail from public.public_products where product_id = p2;
  if v_avail = 'available' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 19: an expired hold should not keep the piece held, view said ' || coalesce(v_avail, 'nothing'); end if;
  begin perform public.create_order_hold(p2); v_msg := 'no error';
  exception when others then v_msg := sqlerrm; end;
  if v_msg = 'no error' then passed := passed + 1;
  else fails := fails || E'\n  FAIL 20: a new buyer should be able to hold the piece after the old hold ran out, got ' || v_msg; end if;

  -- 9. Late payment: the hold lapsed and someone else bought the piece
  h  := public.create_order_hold(p3);                                     -- buyer A holds
  perform public.release_order((h->>'order_id')::uuid);                   -- A's hold lapses
  hb := public.create_order_hold(p3);                                     -- buyer B holds
  perform public.complete_order((hb->>'order_id')::uuid, 'cs_selftest_b', 'b@example.com', 'B', null, 0, 17500);
  c := public.complete_order((h->>'order_id')::uuid, 'cs_selftest_a', 'a@example.com', 'A', null, 0, 17500);
  select quantity into v_qty from public.products where id = p3;
  select * into o from public.orders where id = (h->>'order_id')::uuid;
  if o.status = 'paid' and o.conflict and (c->>'conflict')::boolean and v_qty = 0 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 21: a late payment for a gone piece should be recorded as paid with conflict and stock left at 0'; end if;

  -- 10. poda's own pieces have no seller to pay ---------------------
  h := public.create_order_hold(p_poda);
  select * into o from public.orders where id = (h->>'order_id')::uuid;
  if o.payout_status = 'none' and o.commission_cents = 0 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 22: a poda piece should have payout_status none'; end if;

  -- 11. Who can call what -------------------------------------------
  v_bool := has_function_privilege('anon', 'public.create_order_hold(uuid,integer)', 'execute')
         or has_function_privilege('authenticated', 'public.create_order_hold(uuid,integer)', 'execute')
         or has_function_privilege('anon', 'public.complete_order(uuid,text,text,text,jsonb,integer,integer)', 'execute')
         or has_function_privilege('authenticated', 'public.complete_order(uuid,text,text,text,jsonb,integer,integer)', 'execute');
  if not v_bool then passed := passed + 1;
  else fails := fails || E'\n  FAIL 23: visitors and signed-in users must not be able to call the checkout functions'; end if;

  if has_function_privilege('service_role', 'public.create_order_hold(uuid,integer)', 'execute')
     and has_function_privilege('service_role', 'public.complete_order(uuid,text,text,text,jsonb,integer,integer)', 'execute') then passed := passed + 1;
  else fails := fails || E'\n  FAIL 24: the service role must be able to call the checkout functions'; end if;

  -- 12. Orders are private ------------------------------------------
  select relrowsecurity into v_bool from pg_class where oid = 'public.orders'::regclass;
  select count(*) into v_int from pg_policies where schemaname = 'public' and tablename = 'orders';
  if v_bool and v_int = 1 then passed := passed + 1;
  else fails := fails || E'\n  FAIL 25: orders should have row security on and exactly one policy (admin), found policies: ' || v_int; end if;

  begin
    execute 'set local role anon';
    execute 'select count(*) from public.orders' into v_int;
    execute 'reset role';
    if v_int = 0 then passed := passed + 1;
    else fails := fails || E'\n  FAIL 26: a visitor can read ' || v_int || ' orders'; end if;
  exception when others then
    execute 'reset role';
    -- No access at all is just as private as reading zero rows.
    passed := passed + 1;
  end;

  raise exception E'SELF-TEST RESULT: % passed, % failed.%\nEverything was rolled back, so no test data is left.',
    passed, (26 - passed), fails;
end
$selftest$;
