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
    return data; // includes .token — build the link as seller.html?invite=<token>
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

  async function getInviteByToken(token) {
    const { data, error } = await client()
      .from("supplier_invites")
      .select("*, suppliers(name)")
      .eq("token", token)
      .is("used_at", null)
      .maybeSingle();
    if (error) throw error;
    return data;
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
      "is_unique", "quantity"
    ];
    copy.forEach(k => { if (fields[k] !== undefined) row[k] = fields[k]; });
    if (fields.priceDollars !== undefined) {
      row.price_cents = Math.round(Number(fields.priceDollars) * 100);
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

  async function deleteProductDraft(id) {
    // RLS only lets the admin delete (see MARKETPLACE_SETUP.md) — a
    // supplier removing a draft they never submitted is really a
    // withdrawal of something that was never live, same button either way.
    return setProductState(id, "withdrawn");
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
    ["position", "editorial_title", "editorial_copy"].forEach(k => {
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
    ["body", "published", "position"].forEach(k => { if (patch[k] !== undefined) row[k] = patch[k]; });
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

  async function getPublicFolders() {
    const { data, error } = await client()
      .from("edits")
      .select(EDIT_COLUMNS)
      .in("status", PUBLIC_EDIT_STATUSES)
      .order("number", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // Resolves to null (not an error) for an unknown id, a malformed id, or a
  // folder that isn't public — all three look the same to a visitor.
  async function getPublicFolder(id) {
    const { data, error } = await client()
      .from("edits")
      .select(EDIT_COLUMNS)
      .eq("id", id)
      .in("status", PUBLIC_EDIT_STATUSES)
      .maybeSingle();
    if (error) {
      if (error.code === "22P02") return null; // not a uuid
      throw error;
    }
    return data;
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
      studies: studies.map(r => ({ ...r.data, id: r.data && r.data.id ? r.data.id : r.study_id })),
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

  window.PodaMarketplace = {
    getPublicFolders,
    getPublicFolder,
    getPublicFolderContent,
    getPublicActivity,
    getPublicUpdates,
    noteMediaUrl,
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
    deleteProductDraft,
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
    addPlacement,
    updatePlacement,
    removePlacement,
    getFolderUpdates,
    createFolderUpdate,
    updateFolderUpdate,
    deleteFolderUpdate
  };
})();
