-- ============================================================
-- SELLER_CARDS_APPLY.sql — run in the Supabase SQL editor.
--
-- Run it AFTER migrations/20261028_release_workspace.sql. It is
-- repeatable and deletes no data. If you ever re-run the base
-- scripts or the release migration, run this file again afterwards:
-- they replace public_products and products_guard().
--
-- What it adds for the seller card portal:
--   1. products.size       a plain size field for the lean card
--   2. products.is_hidden  the seller's own "not for sale" switch.
--                          Separate from is_available, which stays
--                          poda's re-review hold.
--   3. products_guard()    now treats a size change on a live piece
--                          as a disclosure change. Hiding is not one.
--   4. public_products     a hidden piece is treated as unavailable,
--                          and the view exposes size.
--   5. A delete policy     sellers can delete their own drafts,
--                          declined and withdrawn pieces. A piece
--                          placed in a release cannot be deleted:
--                          edit_placements.product_id is
--                          "on delete restrict".
-- ============================================================

-- 1 + 2. Columns -------------------------------------------------
alter table public.products
  add column if not exists size text,
  add column if not exists is_hidden boolean not null default false;

-- 3. Guard -------------------------------------------------------
-- Same rules as the release migration, plus size in the disclosure
-- list. is_hidden is deliberately not in the list: hiding a live
-- piece takes it off sale without a re-review.
create or replace function public.products_guard()
returns trigger language plpgsql as $$
declare
  false_change  boolean;
  price_change  boolean;
begin
  -- Set only by complete_order() in migrations/20261111_checkout.sql, for
  -- the length of one sale. Kept here so re-running this file never breaks
  -- recording a payment.
  if current_setting('poda.checkout', true) = 'on' then
    new.updated_at := now();
    return new;
  end if;

  false_change :=
       new.condition      is distinct from old.condition
    or new.condition_notes is distinct from old.condition_notes
    or new.title          is distinct from old.title
    or new.brand          is distinct from old.brand
    or new.category       is distinct from old.category
    or new.currency       is distinct from old.currency
    or new.color          is distinct from old.color
    or new.material       is distinct from old.material
    or new.description    is distinct from old.description
    or new.measurements   is distinct from old.measurements
    or new.size           is distinct from old.size;

  price_change := new.price_cents is distinct from old.price_cents;

  if public.is_admin() then
    if new.state is distinct from old.state then
      new.reviewed_at := now();
    end if;
    new.updated_at := now();
    return new;
  end if;

  if new.state not in ('draft','submitted','withdrawn') then
    raise exception 'Suppliers cannot set product state to %', new.state;
  end if;

  if new.commission_bps_override is distinct from old.commission_bps_override then
    raise exception 'Suppliers cannot change commission terms';
  end if;

  if new.supplier_id is distinct from old.supplier_id then
    raise exception 'Products cannot change owner';
  end if;

  -- Only an admin can clear an availability hold or write review fields.
  if new.is_available and not old.is_available then
    new.is_available := false;
  end if;
  new.review_note := old.review_note;
  new.reviewed_at := old.reviewed_at;

  if old.state = 'accepted' then
    if price_change then
      new.proposed_price_cents := new.price_cents;
      new.price_cents := old.price_cents;
    end if;
    if false_change then
      new.is_available := false;
    end if;
  end if;

  if old.state = 'draft' and new.state = 'submitted' then
    new.submitted_at := now();
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- 4. Public view -------------------------------------------------
-- Identical to the release migration's view, with "and not p.is_hidden"
-- wherever availability is decided, plus the size column at the end.
drop view if exists public.public_products;
create view public.public_products as
select
  pl.id                                   as placement_id,
  pl.edit_id,
  pl.position,
  p.id                                    as product_id,
  coalesce(pl.editorial_title, p.title)   as title,
  case when p.state = 'accepted' and p.is_available and not p.is_hidden
       then coalesce(pl.editorial_copy, p.description) end  as copy,
  p.brand,
  p.category,
  p.color,
  p.material,
  case when p.state = 'accepted' and p.is_available and not p.is_hidden
       then p.condition end               as condition,
  case when p.state = 'accepted' and p.is_available and not p.is_hidden
       then p.condition_notes end         as condition_notes,
  case when p.state = 'accepted' and p.is_available and not p.is_hidden
       then p.measurements end            as measurements,
  case when p.state = 'accepted' and p.is_available and not p.is_hidden
       then p.price_cents end             as price_cents,
  p.currency,
  p.is_unique,
  p.quantity,
  coalesce(p.state = 'accepted' and p.is_available and not p.is_hidden
           and p.quantity > 0, false)     as is_available,
  case when p.state = 'accepted' and p.is_available and not p.is_hidden
            and p.quantity > 0 then 'available'
       when p.state = 'accepted' and p.is_available and not p.is_hidden
            then 'sold'
       else 'unavailable' end             as availability,
  case when p.state = 'accepted' and p.is_available and not p.is_hidden
       then coalesce((
         select array_agg(i.path
                  order by coalesce(i.id = pl.hero_image_id, false) desc,
                           i.position, i.id)
         from public.product_images i
         where i.product_id = pl.product_id
       ), '{}'::text[])
       else '{}'::text[] end              as image_paths,
  case when s.type = 'consignor' then null else s.name end as supplier_name,
  s.type                                  as supplier_type,
  p.size
from public.edit_placements pl
join public.edits e
  on e.id = pl.edit_id
 and e.status in ('scheduled', 'live', 'archived')
 and (e.launched_at is not null
      or (e.publish_at is not null and e.publish_at <= now()))
left join public.products  p on p.id = pl.product_id
left join public.suppliers s on s.id = p.supplier_id;

grant select on public.public_products to anon, authenticated;

-- 5. Supplier delete ---------------------------------------------
-- Until now only the admin could delete products. A supplier may now
-- delete a piece that was never live. A placed piece is protected by
-- the restrict foreign key on edit_placements, so the delete fails
-- instead of orphaning a release. Images, variants and events cascade.
drop policy if exists "Supplier deletes own unlive products" on public.products;
create policy "Supplier deletes own unlive products"
  on public.products for delete to authenticated
  using (
    supplier_id in (select public.my_supplier_ids())
    and state in ('draft', 'declined', 'withdrawn')
  );

-- Quick check: should return two rows, size and is_hidden.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'products'
  and column_name in ('size', 'is_hidden');
