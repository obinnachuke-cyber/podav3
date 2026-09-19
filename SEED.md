# poda — sample seed content (replaceable)

Run this AFTER `OVERHAUL_SETUP.md`. It inserts one drop, one market note,
one visual study, and 10 sample products so the site looks complete out of
the box. Everything here is **replaceable sample content** — no real brand has
authorized poda; sources are neutral labels (Independent Brand 01, etc.).

To remove it later: delete rows whose `id` starts with `poda-001`, `seed-`.

**Supabase Dashboard → SQL Editor → New query → paste → Run.**

```sql
-- ————————————————————————————————————————————————
-- DROP 001
-- ————————————————————————————————————————————————
insert into public.drops (id, data) values
('drop-001', '{
  "id":"drop-001","number":"001","title":"The new uniform",
  "question":"After hype, what remains?",
  "thesis":"The new uniform does not need a uniform. The first selection looks at pieces that stay useful after trend cycles lose intensity.",
  "status":"In Assembly","releaseDate":"","coverImage":"",
  "marketNoteId":"seed-note-001","visualStudyId":"seed-study-001"
}'::jsonb)
on conflict (id) do nothing;

-- ————————————————————————————————————————————————
-- MARKET NOTE (published)
-- ————————————————————————————————————————————————
insert into public.notes (id, data) values
('seed-note-001', '{
  "id":"seed-note-001","issueNumber":"001","category":"watch","status":"published",
  "title":"After hype, what remains","subtitle":"On the pieces that outlast the cycle they arrived in.",
  "coverImage":"","publishedAt":"2026-09-01",
  "body":"Hype compresses attention. When it lifts, most product loses its reason to exist. A small share does not.\n\nThis note looks at what stays: low profiles, long lines, restrained color, quietly technical construction. The pieces that read as background until you use them.\n\n[Placeholder research — replace with the final note.]"
}'::jsonb)
on conflict (id) do nothing;

-- ————————————————————————————————————————————————
-- VISUAL STUDY
-- ————————————————————————————————————————————————
insert into public.studies (id, data) values
('seed-study-001', '{
  "id":"seed-study-001","studyNumber":"001","title":"Used well",
  "framing":"The same five pieces, worn until they read as background.",
  "date":"2026-09-02","coverImage":"","images":[],"captions":[],
  "relatedNoteId":"seed-note-001","relatedDropId":"drop-001"
}'::jsonb)
on conflict (id) do nothing;

-- ————————————————————————————————————————————————
-- PRODUCTS (10) — all Live in Drop 001
-- ————————————————————————————————————————————————
insert into public.items (id, data) values
('poda-001-ot-001','{"id":"poda-001-ot-001","itemCode":"PODA-001-OT-001","status":"Live","dropNumber":"001","brand":"Independent Brand 01","itemName":"Panelled Shell Jacket","category":"Jacket","categoryCode":"OT","size":"M","measurements":"Chest 22in · Length 28in","material":"Nylon shell","color":"Charcoal","condition":"New","sourceType":"brand","sourceName":"Independent Brand 01","transactionType":"poda_sale","verified":true,"publicDescription":"A restrained technical shell with clean paneling and no branding.","selectionReason":"Selected for its low profile and ability to sit between workwear and daily uniform.","pricing":{"currentListPrice":420},"soldActuals":{"finalSalePrice":0}}'::jsonb),
('poda-001-ot-002','{"id":"poda-001-ot-002","itemCode":"PODA-001-OT-002","status":"Live","dropNumber":"001","brand":"Vintage Seller 01","itemName":"Deconstructed Wool Coat","category":"Jacket","categoryCode":"OT","size":"L","measurements":"Chest 23in · Length 40in","material":"Wool","color":"Slate","condition":"Excellent","sourceType":"vintage","sourceName":"Vintage Seller 01","transactionType":"assisted","verified":true,"publicDescription":"A long-line wool coat with a quiet, undone shoulder.","selectionReason":"Selected for its long line and the way it reads as restraint, not costume.","pricing":{"currentListPrice":560},"soldActuals":{"finalSalePrice":0}}'::jsonb),
('poda-001-tp-001','{"id":"poda-001-tp-001","itemCode":"PODA-001-TP-001","status":"Live","dropNumber":"001","brand":"Independent Brand 01","itemName":"Boxy Oxford Shirt","category":"Shirt","categoryCode":"TP","size":"M","measurements":"Chest 21in · Length 29in","material":"Cotton oxford","color":"Bone","condition":"New","sourceType":"brand","sourceName":"Independent Brand 01","transactionType":"poda_sale","verified":true,"publicDescription":"A boxy oxford cut to sit away from the body.","selectionReason":"Selected for a cut that improves as the cotton softens.","pricing":{"currentListPrice":215},"soldActuals":{"finalSalePrice":0}}'::jsonb),
('poda-001-tp-002','{"id":"poda-001-tp-002","itemCode":"PODA-001-TP-002","status":"Live","dropNumber":"001","brand":"Private Collection 01","itemName":"Merino Half-Zip","category":"Knit","categoryCode":"TP","size":"M","measurements":"Chest 20in · Length 27in","material":"Merino wool","color":"Ash","condition":"Very Good","sourceType":"closet","sourceName":"Private Collection 01","transactionType":"poda_sale","verified":true,"publicDescription":"A fine-gauge merino half-zip in a quiet ash grey.","selectionReason":"Selected for restrained color and everyday range.","pricing":{"currentListPrice":260},"soldActuals":{"finalSalePrice":0}}'::jsonb),
('poda-001-bt-001','{"id":"poda-001-bt-001","itemCode":"PODA-001-BT-001","status":"Live","dropNumber":"001","brand":"Independent Brand 02","itemName":"Technical Trouser","category":"Pants","categoryCode":"BT","size":"32","measurements":"Waist 32in · Inseam 30in","material":"Recycled nylon","color":"Black","condition":"New","sourceType":"brand","sourceName":"Independent Brand 02","transactionType":"poda_sale","verified":true,"publicDescription":"A tapered technical trouser with a clean waistband.","selectionReason":"Selected for quietly technical construction that reads as plain.","pricing":{"currentListPrice":340},"soldActuals":{"finalSalePrice":0}}'::jsonb),
('poda-001-bt-002','{"id":"poda-001-bt-002","itemCode":"PODA-001-BT-002","status":"Live","dropNumber":"001","brand":"Vintage Seller 01","itemName":"Washed Selvedge Denim","category":"Denim","categoryCode":"BT","size":"33","measurements":"Waist 33in · Inseam 32in","material":"Cotton selvedge","color":"Indigo","condition":"Good","sourceType":"vintage","sourceName":"Vintage Seller 01","transactionType":"assisted","verified":true,"publicDescription":"Straight-leg selvedge with a natural, used fade.","selectionReason":"Selected because it already looks used well.","pricing":{"currentListPrice":290},"soldActuals":{"finalSalePrice":0}}'::jsonb),
('poda-001-fw-001','{"id":"poda-001-fw-001","itemCode":"PODA-001-FW-001","status":"Live","dropNumber":"001","brand":"Independent Brand 02","itemName":"Low Profile Runner","category":"Shoe","categoryCode":"FW","size":"US 10","material":"Suede / mesh","color":"Grey","condition":"New","sourceType":"brand","sourceName":"Independent Brand 02","transactionType":"partner","externalUrl":"https://example.com/partner-listing","verified":true,"publicDescription":"A low, unbranded runner in muted grey.","selectionReason":"Selected for its low profile — the opposite of a statement sneaker.","pricing":{"currentListPrice":450},"soldActuals":{"finalSalePrice":0}}'::jsonb),
('poda-001-ac-001','{"id":"poda-001-ac-001","itemCode":"PODA-001-AC-001","status":"Live","dropNumber":"001","brand":"Private Collection 01","itemName":"Waxed Cotton Cap","category":"Accessory","categoryCode":"AC","size":"OS","material":"Waxed cotton","color":"Olive","condition":"Excellent","sourceType":"closet","sourceName":"Private Collection 01","transactionType":"poda_sale","verified":true,"publicDescription":"A six-panel cap in waxed cotton that weathers well.","selectionReason":"Selected for a material that improves through use.","pricing":{"currentListPrice":175},"soldActuals":{"finalSalePrice":0}}'::jsonb),
('poda-001-ac-002','{"id":"poda-001-ac-002","itemCode":"PODA-001-AC-002","status":"Live","dropNumber":"001","brand":"Vintage Seller 02","itemName":"Leather Card Holder","category":"Bag","categoryCode":"AC","size":"OS","material":"Vegetable-tanned leather","color":"Tan","condition":"Very Good","sourceType":"vintage","sourceName":"Vintage Seller 02","transactionType":"poda_sale","verified":true,"publicDescription":"A slim card holder in vegetable-tanned leather.","selectionReason":"Selected for patina — it will only look better.","pricing":{"currentListPrice":190},"soldActuals":{"finalSalePrice":0}}'::jsonb),
('poda-001-ot-003','{"id":"poda-001-ot-003","itemCode":"PODA-001-OT-003","status":"Live","dropNumber":"001","brand":"Independent Brand 01","itemName":"Liner Vest","category":"Jacket","categoryCode":"OT","size":"M","measurements":"Chest 21in · Length 26in","material":"Quilted nylon","color":"Black","condition":"New","sourceType":"brand","sourceName":"Independent Brand 01","transactionType":"sourcing","publicDescription":"A packable liner vest — currently between sizes.","selectionReason":"Selected as a layer that disappears under everything.","pricing":{"currentListPrice":300},"soldActuals":{"finalSalePrice":0}}'::jsonb)
on conflict (id) do nothing;
```

After running, open `home.html` and `drop.html` — the drop, thesis, featured
note/study, and 10 products all appear. Add images later via the admin
(each product's image, drop cover, study images) — the sample rows have empty
image slots on purpose.
