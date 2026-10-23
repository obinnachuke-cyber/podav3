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

  window.PodaMarketplace = {
    getSuppliers,
    createSupplier,
    updateSupplier,
    getSupplierUsers,
    createSupplierInvite,
    getSupplierInvites,
    getInviteByToken,
    redeemSupplierInvite,
    myProfile,
    mySupplier
  };
})();
