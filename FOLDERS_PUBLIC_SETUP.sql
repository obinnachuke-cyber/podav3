-- ============================================================
-- FOLDERS_PUBLIC_SETUP.sql
-- Run once in the Supabase SQL editor (after MARKETPLACE_APPLY_PART1/2).
-- Idempotent: safe to re-run.
--
-- Why this exists
--   The public folder page (folder.html) shows the product drop for a
--   'live' edit. The original public_products view was created with
--   security_invoker = true, which makes it run with the *visitor's*
--   permissions — and signed-out visitors have no SELECT policy on
--   public.products, so the left join to products came back all NULL
--   (no brand, no price, is_available NULL). It also never exposed
--   product photos, which live in product_images (own-supplier RLS only).
--
--   This version runs with the view owner's rights instead, and is the
--   one place the storefront is allowed to see product data. It is still
--   deliberately narrow:
--     • only placements in a 'live' edit are ever returned;
--     • only shopper-facing columns are selected;
--     • a product that is pulled / under re-review (is_available = false)
--       keeps its grid position and its title/brand, but its copy, price,
--       condition notes and photos are withheld — fields a supplier has
--       just changed are not shown to the public until you re-review;
--     • a private closet (supplier type 'consignor') never has its name
--       exposed; only 'brand' / 'boutique' / 'poda' sellers are named.
--
-- New columns are appended at the end so the existing column order
-- (required by CREATE OR REPLACE VIEW) is unchanged.
-- ============================================================

create or replace view public.public_products as
select
  pl.id                                   as placement_id,
  pl.edit_id,
  pl.position,
  p.id                                    as product_id,
  coalesce(pl.editorial_title, p.title)   as title,
  case when p.state = 'accepted' and p.is_available
       then coalesce(pl.editorial_copy, p.description) end  as copy,
  p.brand,
  p.category,
  p.color,
  p.material,
  case when p.state = 'accepted' and p.is_available
       then p.condition end               as condition,
  case when p.state = 'accepted' and p.is_available
       then p.condition_notes end         as condition_notes,
  case when p.state = 'accepted' and p.is_available
       then p.measurements end            as measurements,
  case when p.state = 'accepted' and p.is_available
       then p.price_cents end             as price_cents,
  p.currency,
  p.is_unique,
  p.quantity,
  coalesce(p.state = 'accepted' and p.is_available, false) as is_available,
  -- Photo storage paths in supplier-media, editor's hero image first.
  case when p.state = 'accepted' and p.is_available
       then coalesce((
         select array_agg(i.path
                  order by coalesce(i.id = pl.hero_image_id, false) desc,
                           i.position, i.id)
         from public.product_images i
         where i.product_id = pl.product_id
       ), '{}'::text[])
       else '{}'::text[] end              as image_paths,
  case when s.type = 'consignor' then null else s.name end as supplier_name,
  s.type                                  as supplier_type
from public.edit_placements pl
join public.edits e
  on e.id = pl.edit_id and e.status = 'live'
left join public.products  p on p.id = pl.product_id
left join public.suppliers s on s.id = p.supplier_id;

-- Run with the owner's rights (see header). The WHERE-equivalent join on
-- e.status = 'live' above is what keeps drafts/scheduled drops private.
alter view public.public_products set (security_invoker = false);

grant select on public.public_products to anon, authenticated;

-- ------------------------------------------------------------
-- Quick check (run signed-out via the API, or in the SQL editor):
--   select edit_id, position, title, brand, price_cents, is_available,
--          array_length(image_paths, 1) as photos, supplier_name
--   from public.public_products order by edit_id, position;
-- Expect rows only for edits whose status = 'live', with real values
-- (not NULLs) for available products.
-- ------------------------------------------------------------
