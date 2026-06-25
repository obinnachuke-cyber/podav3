/* ============================================================
   Poda Capital — Data layer (Supabase)
   Replaces the old browser-only localStorage store with a real
   shared database, file storage for photos, and admin auth.

   Both the admin (admin.js) and the public site (script.js) talk
   to the database ONLY through window.PodaDB, so the rest of the
   app code barely changes.

   Requires (loaded before this file in the HTML):
     1. the Supabase JS library (CDN)
     2. supabase-config.js  (your project URL + anon key)
   ============================================================ */
(function () {
  "use strict";

  const URL = window.PODA_SUPABASE_URL;
  const KEY = window.PODA_SUPABASE_ANON_KEY;
  const BUCKET = window.PODA_IMAGE_BUCKET || "item-images";

  const isConfigured =
    typeof URL === "string" && URL.startsWith("http") &&
    typeof KEY === "string" && KEY.length > 20;

  // Guard: if the keys haven't been filled in yet, fail loudly but gracefully
  // instead of throwing cryptic errors all over the app.
  if (!isConfigured) {
    console.error(
      "Supabase is not configured. Open supabase-config.js and paste your " +
      "Project URL and anon key. See SUPABASE_SETUP.md."
    );
  }
  if (typeof window.supabase === "undefined") {
    console.error("Supabase library failed to load (check the CDN <script> tag).");
  }

  const client = (isConfigured && window.supabase)
    ? window.supabase.createClient(URL, KEY)
    : null;

  const TABLE          = "items";
  const NOTES_TABLE    = "notes";
  const ARCHIVE_TABLE  = "archive_images";

  /* —— Items: read all, ordered oldest→newest to match the old array order —— */
  async function getItems() {
    if (!client) return [];
    const { data, error } = await client
      .from(TABLE)
      .select("data")
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Failed to load items:", error.message);
      return [];
    }
    // Each row stores the full item object in its `data` column.
    return (data || []).map(row => row.data).filter(Boolean);
  }

  /* —— Items: create or update one item (keyed by item.id) —— */
  async function upsertItem(item) {
    if (!client) throw new Error("Database not configured.");
    const { error } = await client
      .from(TABLE)
      .upsert({ id: item.id, data: item }, { onConflict: "id" });

    if (error) {
      console.error("Failed to save item:", error.message);
      throw error;
    }
  }

  /* —— Items: delete one —— */
  async function deleteItem(id) {
    if (!client) throw new Error("Database not configured.");
    const { error } = await client.from(TABLE).delete().eq("id", id);
    if (error) {
      console.error("Failed to delete item:", error.message);
      throw error;
    }
  }

  /* —— Live updates: re-run callback whenever the items table changes —— */
  function onItemsChange(callback) {
    if (!client) return () => {};
    const channel = client
      .channel("items-changes")
      .on("postgres_changes",
        { event: "*", schema: "public", table: TABLE },
        () => callback())
      .subscribe();
    return () => client.removeChannel(channel);
  }

  /* —— Notes: read all, newest first —— */
  async function getNotes() {
    if (!client) return [];
    const { data, error } = await client
      .from(NOTES_TABLE)
      .select("data")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Failed to load notes:", error.message);
      return [];
    }
    return (data || []).map(row => row.data).filter(Boolean);
  }

  /* —— Notes: create or update one note (keyed by note.id) —— */
  async function upsertNote(note) {
    if (!client) throw new Error("Database not configured.");
    const { error } = await client
      .from(NOTES_TABLE)
      .upsert({ id: note.id, data: note }, { onConflict: "id" });

    if (error) {
      console.error("Failed to save note:", error.message);
      throw error;
    }
  }

  /* —— Notes: delete one —— */
  async function deleteNote(id) {
    if (!client) throw new Error("Database not configured.");
    const { error } = await client.from(NOTES_TABLE).delete().eq("id", id);
    if (error) {
      console.error("Failed to delete note:", error.message);
      throw error;
    }
  }

  /* —— Archive images: read all, newest first —— */
  async function getArchiveImages() {
    if (!client) return [];
    const { data, error } = await client
      .from(ARCHIVE_TABLE)
      .select("data")
      .order("created_at", { ascending: false });
    if (error) { console.error("Failed to load archive images:", error.message); return []; }
    return (data || []).map(row => row.data).filter(Boolean);
  }

  /* —— Archive images: upsert one —— */
  async function upsertArchiveImage(img) {
    if (!client) throw new Error("Database not configured.");
    const { error } = await client
      .from(ARCHIVE_TABLE)
      .upsert({ id: img.id, data: img }, { onConflict: "id" });
    if (error) { console.error("Failed to save archive image:", error.message); throw error; }
  }

  /* —— Archive images: delete one —— */
  async function deleteArchiveImage(id) {
    if (!client) throw new Error("Database not configured.");
    const { error } = await client.from(ARCHIVE_TABLE).delete().eq("id", id);
    if (error) { console.error("Failed to delete archive image:", error.message); throw error; }
  }

  /* —— Images: turn a data URL into a Blob so we can upload a real file —— */
  function dataUrlToBlob(dataUrl) {
    const [meta, base64] = String(dataUrl).split(",");
    const mime = (meta.match(/data:(.*?);/) || [, "image/jpeg"])[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  /* —— Images: upload a Blob/File (or a data URL) and return its public URL —— */
  async function uploadImage(input) {
    if (!client) throw new Error("Database not configured.");

    const blob = typeof input === "string" ? dataUrlToBlob(input) : input;
    const ext = (blob.type && blob.type.split("/")[1]) || "jpg";
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error } = await client.storage
      .from(BUCKET)
      .upload(path, blob, { contentType: blob.type, upsert: false });

    if (error) {
      console.error("Image upload failed:", error.message);
      throw error;
    }

    const { data } = client.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl;
  }

  /* —— Auth (admin only) —— */
  async function getSession() {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session;
  }

  async function signIn(email, password) {
    if (!client) throw new Error("Database not configured.");
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  }

  async function signOut() {
    if (!client) return;
    await client.auth.signOut();
  }

  function onAuthChange(callback) {
    if (!client) return () => {};
    const { data } = client.auth.onAuthStateChange((_event, session) => callback(session));
    return () => data.subscription.unsubscribe();
  }

  window.PodaDB = {
    isConfigured,
    getItems,
    upsertItem,
    deleteItem,
    onItemsChange,
    getNotes,
    upsertNote,
    deleteNote,
    getArchiveImages,
    upsertArchiveImage,
    deleteArchiveImage,
    uploadImage,
    getSession,
    signIn,
    signOut,
    onAuthChange
  };
})();
