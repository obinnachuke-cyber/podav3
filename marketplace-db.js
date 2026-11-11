/* ============================================================
   marketplace-db.js — Suppliers / Products / Edits data layer
   A second, separate data layer from db.js on purpose: these tables are
   real relational rows with RLS-enforced ownership (see
   MARKETPLACE_SETUP.md), not the { id, data jsonb } pattern db.js's
   tables use. Reuses db.js's existing Supabase client/session instead of
   creating a second one (see PodaDB.getClient()).

   Requires (loaded after db.js, before this file is used):
     1. supabase.min.js, supabase-config.js, db.js
   ============================================================ */
(function () {
  "use strict";

  function client() {
    const c = window.PodaDB && window.PodaDB.getClient();
    if (!c) throw new Error("Database not configured.");
    return c;
  }

  /* —— Suppliers —— */
  async function getSuppliers() {
    const { data, error } = await client()
      .from("suppliers")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function createSupplier({ name, type, commissionBps, contactEmail, notes }) {
    const { data, error } = await client()
      .from("suppliers")
      .insert({
        name,
        type,
        commission_bps: commissionBps,
        contact_email: contactEmail || null,
        notes: notes || null
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function updateSupplier(id, patch) {
    const row = {};
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.type !== undefined) row.type = patch.type;
    if (patch.commissionBps !== undefined) row.commission_bps = patch.commissionBps;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.contactEmail !== undefined) row.contact_email = patch.contactEmail;
    if (patch.notes !== undefined) row.notes = patch.notes;
    row.updated_at = new Date().toISOString();

    const { data, error } = await client()
      .from("suppliers")
      .update(row)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  /* —— Supplier users (who's logged in under which supplier) —— */
  async function getSupplierUsers(supplierId) {
    const { data, error } = await client()
      .from("supplier_users")
      .select("*")
      .eq("supplier_id", supplierId);
    if (error) throw error;
    return data || [];
  }

  /* —— Invites —— */
  async function createSupplierInvite(supplierId, email) {
    const { data, error } = await client()
      .from("supplier_invites")
      .insert({ supplier_id: supplierId, email })
      .select()
      .single();
    if (error) throw error;
    // A fresh invite replaces any older unused one for the same person, so
    // re-inviting never piles up duplicates. Best effort: the new invite
    // already exists, so a failed cleanup must not fail the call.
    await client()
      .from("supplier_invites")
      .delete()
      .eq("supplier_id", supplierId)
      .ilike("email", escapeLike(email))
      .is("used_at", null)
      .neq("token", data.token);
    return data; // includes .token — build the link as seller.html?invite=<token>
  }

  // ilike treats % and _ as wildcards; emails can contain _, so escape them.
  function escapeLike(s) { return String(s).replace(/[\\%_]/g, "\\$&"); }

  // Withdraws every unused invite for one person at one supplier.
  // Accepted invites (used_at set) are never touched.
  async function revokeInvites(supplierId, email) {
    const { error } = await client()
      .from("supplier_invites")
      .delete()
      .eq("supplier_id", supplierId)
      .ilike("email", escapeLike(email))
      .is("used_at", null);
    if (error) throw error;
  }

  // Turns a short join code (ada-k7m2x9q) into the invite's token, or null.
  // Needs resolve_invite_code() from SELLER_INVITE_LINKS_APPLY.sql.
  async function resolveInviteCode(code) {
    const { data, error } = await client().rpc("resolve_invite_code", { invite_code: code });
    if (error) throw error;
    return data || null;
  }

  async function getSupplierInvites(supplierId) {
    const { data, error } = await client()
      .from("supplier_invites")
      .select("*")
      .eq("supplier_id", supplierId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // Looks up one unused invite by its token. Uses get_invite_by_token()
  // from SELLER_INVITES_APPLY.sql, which only ever returns the single invite
  // whose token you hold. Falls back to the old direct read when that
  // function is not installed yet, so deploying the code and running the SQL
  // can happen in either order.
  async function getInviteByToken(token) {
    const { data, error } = await client().rpc("get_invite_by_token", { invite_token: token });
    if (!error) {
      const row = Array.isArray(data) ? data[0] : data;
      return row ? { email: row.email, suppliers: { name: row.supplier_name } } : null;
    }
    const missing = error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message || "");
    if (!missing) throw error;

    const legacy = await client()
      .from("supplier_invites")
      .select("*, suppliers(name)")
      .eq("token", token)
      .is("used_at", null)
      .maybeSingle();
    if (legacy.error) throw legacy.error;
    return legacy.data;
  }

  async function redeemSupplierInvite(token) {
    const { error } = await client().rpc("redeem_supplier_invite", { invite_token: token });
    if (error) throw error;
  }

  /* —— Who am I (supplier side) —— */
  async function myProfile() {
    const { data: auth } = await client().auth.getUser();
    if (!auth || !auth.user) return null;
    const { data, error } = await client()
      .from("profiles")
      .select("*")
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function mySupplier() {
    const { data, error } = await client()
      .from("supplier_users")
      .select("supplier_id, suppliers(*)")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? data.suppliers : null;
  }

  // Saves the seller's own Instagram handle. The database function validates
  // and normalizes it (accepts @name, name or an instagram.com URL) and can
  // touch nothing else on the supplier. Returns the stored handle or null.
  async function setMyInstagram(handle) {
    const { data, error } = await client().rpc("set_my_instagram", { p_handle: handle || "" });
    if (error) throw error;
    return data || null;
  }

  /* —— Products (a supplier's own, or admin's view of all) —— */
  async function getMyProducts(supplierId) {
    const { data, error } = await client()
      .from("products")
      .select("*, product_images(*), product_variants(*)")
      .eq("supplier_id", supplierId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function getProduct(id) {
    const { data, error } = await client()
      .from("products")
      .select("*, product_images(*), product_variants(*)")
      .eq("id", id)
      .single();
    if (error) throw error;
    return data;
  }

  function productRow(fields) {
    const row = {};
    const copy = [
      "title", "brand", "category", "color", "material", "condition",
      "condition_notes", "description", "measurements", "currency",
      "is_unique", "quantity", "size"
    ];
    copy.forEach(k => { if (fields[k] !== undefined) row[k] = fields[k]; });
    if (fields.priceDollars !== undefined) {
      // An empty price means "not set yet", not zero dollars.
      row.price_cents = (fields.priceDollars === "" || fields.priceDollars === null)
        ? null
        : Math.round(Number(fields.priceDollars) * 100);
    }
    return row;
  }

  async function createProduct(supplierId, fields) {
    const { data, error } = await client()
      .from("products")
      .insert({ supplier_id: supplierId, state: "draft", ...productRow(fields) })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function updateProduct(id, fields) {
    const row = productRow(fields);
    row.updated_at = new Date().toISOString();
    const { data, error } = await client()
      .from("products")
      .update(row)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Separate from updateProduct on purpose: this is the one state change a
  // supplier is actually allowed (products_guard() blocks every other
  // value) — draft -> submitted, or -> withdrawn from anywhere.
  async function setProductState(id, newState) {
    const { data, error } = await client()
      .from("products")
      .update({ state: newState })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Take a piece off the market for good while keeping its history.
  function withdrawProduct(id) {
    return setProductState(id, "withdrawn");
  }

  // The seller's own off-sale switch (SELLER_CARDS_APPLY.sql). Separate from
  // is_available, which is poda's re-review hold.
  async function setProductHidden(id, hidden) {
    const { data, error } = await client()
      .from("products")
      .update({ is_hidden: !!hidden })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Permanent delete. RLS allows a supplier this only for draft, declined
  // and withdrawn pieces (SELLER_CARDS_APPLY.sql). A piece placed in a release
  // is blocked by the restrict foreign key; that surfaces as a typed error so
  // the portal can say "withdraw it instead". Storage files go last, so a
  // blocked delete leaves the photos alone.
  async function deleteProduct(id) {
    const { data: imgs } = await client()
      .from("product_images").select("path").eq("product_id", id);

    const { data, error } = await client()
      .from("products").delete().eq("id", id).select("id");
    if (error) {
      const placed = error.code === "23503" || /foreign key|violates/i.test(error.message || "");
      const err = new Error(placed
        ? "This piece was placed in a release. Withdraw it instead."
        : (error.message || "Could not delete this piece."));
      err.code = placed ? "PLACED" : error.code;
      throw err;
    }
    // RLS hides rows the supplier may not delete: zero rows back means no.
    if (!data || data.length === 0) {
      const err = new Error("This piece can't be deleted. Withdraw it instead.");
      err.code = "NOT_DELETABLE";
      throw err;
    }

    const paths = (imgs || []).map(i => i.path).filter(Boolean);
    if (paths.length) {
      try { await client().storage.from("supplier-media").remove(paths); }
      catch (e) { /* orphaned files cost nothing user-visible */ }
    }
  }

  /* —— Variants (brand/boutique sizes+stock; unique pieces skip this) —— */
  async function upsertVariant(productId, variant) {
    const row = { product_id: productId, size: variant.size, sku: variant.sku || null, quantity: variant.quantity };
    if (variant.id) {
      const { data, error } = await client().from("product_variants").update(row).eq("id", variant.id).select().single();
      if (error) throw error;
      return data;
    }
    const { data, error } = await client().from("product_variants").insert(row).select().single();
    if (error) throw error;
    return data;
  }

  async function deleteVariant(id) {
    const { error } = await client().from("product_variants").delete().eq("id", id);
    if (error) throw error;
  }

  /* —— Images: supplier-media/<supplier_id>/<product_id>/<file>, per the
     storage policy in MARKETPLACE_SETUP.md Step 6. —— */
  async function uploadProductImage(supplierId, productId, file) {
    const ext = (file.name && file.name.split(".").pop()) || "jpg";
    const path = `${supplierId}/${productId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error: upErr } = await client().storage
      .from("supplier-media")
      .upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) throw upErr;

    const { data: existing } = await client()
      .from("product_images").select("position").eq("product_id", productId)
      .order("position", { ascending: false }).limit(1);
    const nextPosition = existing && existing[0] ? existing[0].position + 1 : 0;

    const { data, error } = await client()
      .from("product_images")
      .insert({ product_id: productId, path, position: nextPosition })
      .select()
      .single();
    if (error) throw error;

    const { data: pub } = client().storage.from("supplier-media").getPublicUrl(path);
    return { ...data, url: pub.publicUrl };
  }

  function productImageUrl(path) {
    const { data } = client().storage.from("supplier-media").getPublicUrl(path);
    return data.publicUrl;
  }

  async function deleteProductImage(id, path) {
    await client().storage.from("supplier-media").remove([path]);
    const { error } = await client().from("product_images").delete().eq("id", id);
    if (error) throw error;
  }

  /* —— Admin: cross-supplier product views —— */
  async function getAllProducts() {
    const { data, error } = await client()
      .from("products")
      .select("*, suppliers(name, type), product_images(*), product_variants(*)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function getReviewQueue() {
    const { data, error } = await client()
      .from("products")
      .select("*, suppliers(name, type, commission_bps), product_images(*)")
      .eq("state", "submitted")
      .order("submitted_at", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // Admin-only writes — RLS lets the admin set any state; these are the
  // three outcomes a review actually has.
  async function acceptProduct(id) {
    const { data, error } = await client()
      .from("products").update({ state: "accepted", review_note: null }).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }

  async function declineProduct(id, note) {
    const { data, error } = await client()
      .from("products").update({ state: "declined", review_note: note || null }).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }

  async function requestChanges(id, note) {
    // Back to the supplier's drafts, with your note attached — not a
    // decline, so it can be edited and resubmitted.
    const { data, error } = await client()
      .from("products").update({ state: "draft", review_note: note || null }).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }

  // Clearing a false-category pull (see MARKETPLACE_SETUP.md Step 3) —
  // the new field values are already live on the row; this just flips
  // availability back on once you've re-reviewed them.
  async function clearAvailabilityHold(id) {
    const { data, error } = await client()
      .from("products").update({ is_available: true }).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }

  // Approving a staged price change — commits proposed_price_cents to
  // the live price.
  async function approveProposedPrice(id) {
    const current = await getProduct(id);
    if (current.proposed_price_cents === null || current.proposed_price_cents === undefined) {
      throw new Error("No proposed price on this product.");
    }
    const { data, error } = await client()
      .from("products")
      .update({ price_cents: current.proposed_price_cents, proposed_price_cents: null })
      .eq("id", id).select().single();
    if (error) throw error;
    return data;
  }

  /* —— Activity trail (a supplier's own products only — see RLS) —— */
  async function getProductEvents(productId) {
    const { data, error } = await client()
      .from("product_events")
      .select("*")
      .eq("product_id", productId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  /* —— Edits (release folders) —— */
  async function getEdits() {
    const { data, error } = await client()
      .from("edits").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function createEdit({ number, title, standfirst }) {
    const { data, error } = await client()
      .from("edits").insert({ number: number || null, title, standfirst: standfirst || null })
      .select().single();
    if (error) throw error;
    return data;
  }

  async function updateEdit(id, patch) {
    const row = { updated_at: new Date().toISOString() };
    ["number", "title", "standfirst", "status", "publish_at"].forEach(k => {
      if (patch[k] !== undefined) row[k] = patch[k] || null;
    });
    if (patch.status === "live" && !patch.published_at) row.published_at = new Date().toISOString();
    const { data, error } = await client().from("edits").update(row).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }

  async function getEdit(id) {
    const { data, error } = await client().from("edits").select("*").eq("id", id).single();
    if (error) throw error;
    return data;
  }

  async function getPlacements(editId) {
    const { data, error } = await client()
      .from("edit_placements")
      .select("*, products(title, brand, price_cents, state, supplier_id, suppliers(name))")
      .eq("edit_id", editId)
      .order("position", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function getAcceptedProducts() {
    const { data, error } = await client()
      .from("products")
      .select("*, suppliers(name)")
      .eq("state", "accepted")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    // A piece the seller has hidden can't be placed. Filtered here, not in
    // the query, so the picker still works before SELLER_CARDS_APPLY.sql runs.
    return (data || []).filter(p => !p.is_hidden);
  }

  /* —— Pick board + needs-you (admin only; every read is covered by the
     admin RLS policies) —— */

  // Everything that can be picked: accepted pieces, with photos and who
  // uploaded them. Hidden pieces are left out, same as the old picker.
  async function getPickCandidates() {
    const { data, error } = await client()
      .from("products")
      .select("*, suppliers(name, type), product_images(id, path, position)")
      .eq("state", "accepted")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return (data || []).filter(p => !p.is_hidden);
  }

  // Which releases each piece has been placed in, to flag repeats.
  async function getPlacementHistory() {
    const { data, error } = await client()
      .from("edit_placements")
      .select("product_id, edit_id, edits(id, number, title, status, publish_at, launched_at)");
    if (error) throw error;
    return data || [];
  }

  // Light reads for the needs-you strip.
  async function getProductSummaries() {
    const { data, error } = await client()
      .from("products")
      .select("id, supplier_id, state, is_available, is_hidden, proposed_price_cents");
    if (error) throw error;
    return data || [];
  }

  async function getSupplierMembers() {
    const { data, error } = await client().from("supplier_users").select("supplier_id");
    if (error) throw error;
    return data || [];
  }

  /* —— Seller applications (SELLER_APPLICATIONS_APPLY.sql). Admin session only:
     RLS gives everyone else no read access to the table or the bucket. —— */
  async function getApplications() {
    const { data, error } = await client()
      .from("seller_applications")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // Short-lived signed links (1 hour) to the private photos.
  async function getApplicationPhotoUrls(paths) {
    if (!paths || !paths.length) return [];
    const { data, error } = await client().storage.from("applications").createSignedUrls(paths, 3600);
    if (error) throw error;
    return (data || []).map(d => d.signedUrl || "");
  }

  async function setApplicationStatus(id, status) {
    const { error } = await client().from("seller_applications").update({ status }).eq("id", id);
    if (error) throw error;
  }

  // Deletes the row and its photos.
  async function deleteApplication(app) {
    const { error: storageError } = await client().storage.from("applications").remove(app.photo_paths || []);
    if (storageError) throw storageError;
    const { error } = await client().from("seller_applications").delete().eq("id", app.id);
    if (error) throw error;
  }

  async function getOpenInvites() {
    const { data, error } = await client()
      .from("supplier_invites")
      .select("supplier_id, email, created_at")
      .is("used_at", null)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function addPlacement(editId, productId) {
    const { data: existing } = await client()
      .from("edit_placements").select("position").eq("edit_id", editId)
      .order("position", { ascending: false }).limit(1);
    const nextPosition = existing && existing[0] ? existing[0].position + 1 : 0;
    const { data, error } = await client()
      .from("edit_placements")
      .insert({ edit_id: editId, product_id: productId, position: nextPosition })
      .select().single();
    if (error) throw error;
    return data;
  }

  async function updatePlacement(id, patch) {
    const row = {};
    ["position", "editorial_title", "editorial_copy", "hero_image_id"].forEach(k => {
      if (patch[k] !== undefined) row[k] = patch[k] === "" ? null : patch[k];
    });
    const { data, error } = await client().from("edit_placements").update(row).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }

  async function removePlacement(id) {
    const { error } = await client().from("edit_placements").delete().eq("id", id);
    if (error) throw error;
  }

  /* —— Folder updates (short correspondence inside a release folder) —— */
  async function getFolderUpdates(editId) {
    const { data, error } = await client()
      .from("folder_updates").select("*").eq("edit_id", editId).order("position", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function createFolderUpdate(editId, body) {
    const { data: existing } = await client()
      .from("folder_updates").select("position").eq("edit_id", editId)
      .order("position", { ascending: false }).limit(1);
    const nextPosition = existing && existing[0] ? existing[0].position + 1 : 0;
    const { data, error } = await client()
      .from("folder_updates").insert({ edit_id: editId, body, position: nextPosition })
      .select().single();
    if (error) throw error;
    return data;
  }

  async function updateFolderUpdate(id, patch) {
    const row = { updated_at: new Date().toISOString() };
    ["body", "published", "position", "image_path"].forEach(k => { if (patch[k] !== undefined) row[k] = patch[k]; });
    const { data, error } = await client().from("folder_updates").update(row).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }

  async function deleteFolderUpdate(id) {
    const { error } = await client().from("folder_updates").delete().eq("id", id);
    if (error) throw error;
  }

  /* —— Public folder reads (signed-out visitors). RLS and the public_*
     views in MARKETPLACE_SETUP.md / FOLDERS_PUBLIC_SETUP.sql do the real
     gating; the status filters here only keep a signed-in admin's view of
     the public site identical to a visitor's (admins can otherwise read
     draft edits). —— */
  const PUBLIC_EDIT_STATUSES = ["scheduled", "live", "archived"];
  const EDIT_COLUMNS = "id, number, title, standfirst, status, publish_at, published_at, created_at";

  // Public reads go through the public_releases view (migrations/
  // 20261028_release_workspace.sql). It adds drop_open / is_shop / server_now,
  // all decided by the database clock, never by this browser.
  const RELEASE_COLUMNS =
    "id, number, title, standfirst, status, publish_at, published_at, launched_at, " +
    "cover_image, drop_timezone, created_at, drop_open, is_shop, server_now";

  // Before the migration is applied the view doesn't exist. Fall back to the
  // original behaviour (a 'live' folder is the open drop) instead of failing.
  function isMissingSchema(error) {
    return !!error && (error.code === "42P01" || error.code === "42703" ||
      error.code === "PGRST205" || error.code === "PGRST204" ||
      /does not exist|schema cache|Could not find/i.test(error.message || ""));
  }

  async function legacyFolders() {
    const { data, error } = await client()
      .from("edits")
      .select(EDIT_COLUMNS)
      .in("status", PUBLIC_EDIT_STATUSES)
      .order("number", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (error) throw error;
    const rows = (data || []).map(r => ({ ...r, drop_open: r.status === "live", is_shop: false, server_now: new Date().toISOString() }));
    const shop = rows.find(r => r.drop_open);
    if (shop) shop.is_shop = true;
    return rows;
  }

  async function getPublicFolders() {
    const { data, error } = await client()
      .from("public_releases")
      .select(RELEASE_COLUMNS)
      .order("number", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (!error) return data || [];
    if (!isMissingSchema(error)) throw error;
    return legacyFolders();
  }

  // Resolves to null (not an error) for an unknown id, a malformed id, or a
  // folder that isn't public — all three look the same to a visitor.
  async function getPublicFolder(id) {
    const { data, error } = await client()
      .from("public_releases")
      .select(RELEASE_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (!error) return data;
    if (error.code === "22P02") return null; // not a uuid
    if (!isMissingSchema(error)) throw error;
    return (await legacyFolders()).find(f => f.id === id) || null;
  }

  // Each content type loads independently: a failure in one (say the
  // products view hasn't been updated yet) must not blank the whole folder.
  async function settled(label, query) {
    const { data, error } = await query;
    if (error) {
      console.warn(`Folder ${label} unavailable:`, error.message);
      return [];
    }
    return data || [];
  }

  async function getPublicFolderContent(editId) {
    const c = client();
    const [notes, studies, updates, products] = await Promise.all([
      settled("notes", c.from("public_folder_notes").select("note_id, data").eq("edit_id", editId)),
      settled("studies", c.from("public_folder_studies").select("study_id, data").eq("edit_id", editId)),
      settled("updates", c.from("folder_updates")
        .select("id, body, image_path, position, created_at")
        .eq("edit_id", editId).eq("published", true)
        .order("position", { ascending: true })),
      settled("products", c.from("public_products").select("*").eq("edit_id", editId)
        .order("position", { ascending: true }))
    ]);
    return {
      notes: notes.map(r => ({ ...r.data, id: r.data && r.data.id ? r.data.id : r.note_id })),
      // Lookbook sets keep the order the admin gave them (data.releaseOrder).
      studies: studies
        .map(r => ({ ...r.data, id: r.data && r.data.id ? r.data.id : r.study_id }))
        .sort((a, b) => (a.releaseOrder ?? 999) - (b.releaseOrder ?? 999)),
      updates,
      products
    };
  }

  // Latest public-content timestamp (ms) per folder id, used for the
  // "new material" dot. Selects only a date key out of each jsonb row so the
  // homepage doesn't download every note body. Never throws — a missing dot
  // is better than a broken homepage.
  // Resolves to { folders: { [editId]: ms }, inbox: ms } — `inbox` is the
  // newest published note or update anywhere, for the Inbox folder's dot.
  async function getPublicActivity() {
    const c = client();
    const [notes, allNotes, studies, updates] = await Promise.all([
      settled("note activity", c.from("public_folder_notes")
        .select("edit_id, published:data->>publishedAt, created:data->>createdAt")),
      settled("inbox activity", c.from("notes")
        .select("published:data->>publishedAt, created:data->>createdAt")
        .eq("data->>status", "published")),
      settled("study activity", c.from("public_folder_studies")
        .select("edit_id, date:data->>date")),
      settled("update activity", c.from("folder_updates")
        .select("edit_id, created_at").eq("published", true))
    ]);
    const folders = {};
    let inbox = 0;
    const ms = value => { const t = Date.parse(value); return Number.isFinite(t) ? t : 0; };
    const bump = (editId, value) => {
      const t = ms(value);
      if (editId && t > (folders[editId] || 0)) folders[editId] = t;
    };
    notes.forEach(r => bump(r.edit_id, r.published || r.created));
    studies.forEach(r => bump(r.edit_id, r.date));
    updates.forEach(r => bump(r.edit_id, r.created_at));
    allNotes.forEach(r => { inbox = Math.max(inbox, ms(r.published || r.created)); });
    updates.forEach(r => { inbox = Math.max(inbox, ms(r.created_at)); });
    return { folders, inbox };
  }

  // Every published update across public folders, for the Inbox feed.
  async function getPublicUpdates() {
    return settled("updates feed", client().from("folder_updates")
      .select("id, edit_id, body, created_at")
      .eq("published", true)
      .order("created_at", { ascending: false }));
  }

  function noteMediaUrl(path) {
    const { data } = client().storage.from("note-media").getPublicUrl(path);
    return data.publicUrl;
  }

  // note-media uploads come back as public URLs; folder updates store the path.
  function noteMediaPath(publicUrl) {
    const marker = "/object/public/note-media/";
    const i = String(publicUrl || "").indexOf(marker);
    return i === -1 ? "" : publicUrl.slice(i + marker.length);
  }

  /* ============================================================
     Release workspace (admin). All of these rely on admin-only RLS; a
     non-admin session simply gets empty results or an error back.
     ============================================================ */
  const RELEASE_PATCH_KEYS = [
    "number", "title", "standfirst", "status", "publish_at",
    "launched_at", "cover_image", "drop_timezone"
  ];

  // The release being prepared (explicit is_working flag), or null.
  async function getWorkingRelease() {
    const { data, error } = await client()
      .from("edits").select("*").eq("is_working", true).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function setWorkingRelease(id) {
    const { error } = await client().rpc("set_working_release", { p_id: id });
    if (error) throw error;
  }

  // Unlike updateEdit, values are written as given ('' and 0 are not coerced).
  async function updateRelease(id, patch) {
    const row = {};
    RELEASE_PATCH_KEYS.forEach(k => {
      if (patch[k] === undefined) return;
      row[k] = (patch[k] === "" ? null : patch[k]);
    });
    const { data, error } = await client().from("edits").update(row).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }

  // A release can be deleted only while it has never been public. The database
  // enforces this too (migrations/20261109_release_delete_guard.sql), which
  // also detaches its notes and lookbook sets and cascades placements, updates
  // and activity. Zero deleted rows (no permission) is reported, not ignored.
  function canDeleteRelease(r) {
    return !!r && r.status === "draft" && !r.publish_at && !r.launched_at;
  }

  async function deleteRelease(id) {
    const { data, error } = await client().from("edits").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data || !data.length) throw new Error("Nothing was deleted. Check that you are signed in as the admin.");
  }

  // Activity log. Best effort: a failed log write never blocks the action.
  async function addReleaseEvent(editId, event, detail) {
    try {
      await client().from("release_events").insert({ edit_id: editId, event, detail: detail || null });
    } catch (e) { console.warn("Could not log release event:", e); }
  }

  async function getReleaseEvents(editId) {
    const { data, error } = await client()
      .from("release_events").select("*").eq("edit_id", editId)
      .order("created_at", { ascending: false }).limit(50);
    if (error) { console.warn("Release activity unavailable:", error.message); return []; }
    return data || [];
  }

  // Placements with the product, its seller and its photos (for the workspace
  // and the private preview).
  async function getPlacementsFull(editId) {
    const { data, error } = await client()
      .from("edit_placements")
      .select("*, products(title, brand, description, price_cents, currency, state, is_available, is_hidden, size, quantity, supplier_id, suppliers(name, type), product_images(id, path, position))")
      .eq("edit_id", editId)
      .order("position", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // Persist a new order: ids in the order they should now appear.
  async function reorderPlacements(orderedIds) {
    for (let i = 0; i < orderedIds.length; i++) {
      const { error } = await client().from("edit_placements").update({ position: i }).eq("id", orderedIds[i]);
      if (error) throw error;
    }
  }

  async function reorderFolderUpdates(orderedIds) {
    for (let i = 0; i < orderedIds.length; i++) {
      const { error } = await client().from("folder_updates")
        .update({ position: i, updated_at: new Date().toISOString() }).eq("id", orderedIds[i]);
      if (error) throw error;
    }
  }

  /* —— Orders (admin only; row security keeps everyone else out) —— */
  async function getOrders() {
    const { data, error } = await client()
      .from("orders")
      .select("*, suppliers(name, type)")
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) throw error;
    return data || [];
  }

  // Only the bookkeeping can change from the admin. The money and the piece
  // are frozen when the order is made.
  async function updateOrder(id, patch) {
    const row = {};
    ["shipped_at", "carrier", "tracking_number", "payout_status", "payout_paid_at", "status"].forEach(k => {
      if (patch[k] !== undefined) row[k] = patch[k];
    });
    const { data, error } = await client().from("orders").update(row).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }

  window.PodaMarketplace = {
    getPublicFolders,
    getPublicFolder,
    getPublicFolderContent,
    getPublicActivity,
    getPublicUpdates,
    noteMediaUrl,
    noteMediaPath,
    getWorkingRelease,
    setWorkingRelease,
    updateRelease,
    setMyInstagram,
    getOrders,
    updateOrder,
    canDeleteRelease,
    deleteRelease,
    addReleaseEvent,
    getReleaseEvents,
    getPlacementsFull,
    reorderPlacements,
    reorderFolderUpdates,
    getSuppliers,
    createSupplier,
    updateSupplier,
    getSupplierUsers,
    createSupplierInvite,
    getSupplierInvites,
    getInviteByToken,
    redeemSupplierInvite,
    myProfile,
    mySupplier,
    getMyProducts,
    getProduct,
    createProduct,
    updateProduct,
    setProductState,
    withdrawProduct,
    setProductHidden,
    deleteProduct,
    upsertVariant,
    deleteVariant,
    uploadProductImage,
    productImageUrl,
    deleteProductImage,
    getProductEvents,
    getAllProducts,
    getReviewQueue,
    acceptProduct,
    declineProduct,
    requestChanges,
    clearAvailabilityHold,
    approveProposedPrice,
    getEdits,
    createEdit,
    updateEdit,
    getEdit,
    getPlacements,
    getAcceptedProducts,
    getPickCandidates,
    getPlacementHistory,
    getProductSummaries,
    getSupplierMembers,
    getOpenInvites,
    resolveInviteCode,
    revokeInvites,
    getApplications,
    getApplicationPhotoUrls,
    setApplicationStatus,
    deleteApplication,
    addPlacement,
    updatePlacement,
    removePlacement,
    getFolderUpdates,
    createFolderUpdate,
    updateFolderUpdate,
    deleteFolderUpdate
  };
})();
