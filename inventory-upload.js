/* ============================================================
   inventory-upload.js — Supply → My inventory.

   Mass upload for poda's OWN pieces: no supplier account, no consignment
   split. Everything is posted under the supplier of type "poda" (0%
   commission, created by MARKETPLACE_APPLY_PART2_ADMIN.sql).

   Flow:
     1. Pick a folder laid out like poda_inventory/NNN_brand_item/edited/*.png
        (the folder is used as it is). Each item folder becomes one DRAFT
        product with its edited photos, in file-name order. originals/ and
        edited/transparent/ are never read. An optional inventory.csv in the
        pick prefills brand, title and colour.
     2. Photos that belong to no item land in the Unfiled tray
        (migrations/20261124_unfiled_photos.sql). Tag them one by one: move
        onto an item, start a new item from them, or delete them.
     3. Fill in each item in the editor ("Save and next" walks the drafts
        that still miss details), then Publish. Publishing sets the product to
        accepted, the same state Review Queue → Accept sets; add it to a
        release from the pick board as usual.

   Loaded after pickboard.js, before admin.js. It only touches admin.js
   globals (adminMain, modalOverlay, modalContent, closeModal, escapeHTML)
   when a function runs, after admin.js has loaded.
   ============================================================ */
(function () {
  "use strict";

  const A = () => window.PodaMarketplace;
  const esc = v => escapeHTML(v == null ? "" : v);
  const BUCKET = "supplier-media";
  const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

  const I = {
    supplier: null,        // the "poda" supplier row
    products: [],          // poda's products, with images
    unfiled: [],           // rows of unfiled_photos
    trayMissing: false,    // unfiled_photos table not created yet
    staged: null,          // { items: [...], looseFiles: [...] } awaiting confirmation
    selected: new Set(),   // unfiled photo ids ticked in the tray
    busy: false,
    notice: "",
    noticeBad: false,
    modal: null,           // { product, error } while the editor is open
    bound: false
  };

  const client = () => window.PodaDB.getClient();
  const mediaUrl = path => client().storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  /* ============================================================
     Data
     ============================================================ */
  async function ensureSupplier() {
    if (I.supplier) return I.supplier;
    const suppliers = await A().getSuppliers();
    let s = suppliers.find(x => x.type === "poda");
    if (!s) {
      const { data, error } = await client()
        .from("suppliers")
        .insert({ name: "poda", type: "poda", commission_bps: 0, status: "active" })
        .select().single();
      if (error) throw error;
      s = data;
    }
    I.supplier = s;
    return s;
  }

  async function load() {
    const s = await ensureSupplier();
    I.products = await A().getMyProducts(s.id);
    const { data, error } = await client()
      .from("unfiled_photos").select("*").order("label", { ascending: true });
    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205" || /does not exist|schema cache/i.test(error.message || "")) {
        I.trayMissing = true; I.unfiled = [];
      } else throw error;
    } else {
      I.trayMissing = false; I.unfiled = data || [];
    }
    I.selected = new Set([...I.selected].filter(id => I.unfiled.some(u => u.id === id)));
  }

  const sortedImages = p => (p.product_images || []).slice().sort((a, b) => a.position - b.position);
  const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

  // What a piece still needs before it can go live.
  function missingOf(p) {
    const m = [];
    if (!p.title || /^untitled/i.test(p.title.trim())) m.push("title");
    if (p.price_cents == null) m.push("price");
    if (!p.category) m.push("category");
    if (!p.size) m.push("size");
    if (!p.condition) m.push("condition");
    if (sortedImages(p).length === 0) m.push("photos");
    return m;
  }

  // PNGs become JPEG on a white ground before upload: a 1600x2000 PNG is
  // several times larger and slows the storefront. Other formats go as they are.
  async function toUpload(file) {
    if (!/png$/i.test(file.type)) return file;
    try {
      const bmp = await createImageBitmap(file);
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0);
      const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.92));
      if (!blob) return file;
      return new File([blob], file.name.replace(/\.png$/i, ".jpg"), { type: "image/jpeg" });
    } catch (e) {
      return file;
    }
  }

  async function uploadUnfiled(file) {
    const f = await toUpload(file);
    const ext = (f.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${I.supplier.id}/unfiled/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await client().storage.from(BUCKET)
      .upload(path, f, { contentType: f.type, upsert: false });
    if (upErr) throw upErr;
    const { error } = await client().from("unfiled_photos").insert({ path, label: file.name });
    if (error) {
      await client().storage.from(BUCKET).remove([path]);
      throw error;
    }
  }

  /* ============================================================
     Reading a picked folder
     ============================================================ */
  // Quote-aware CSV reader (the inventory.csv has commas inside quotes).
  function parseCsv(text) {
    const rows = []; let row = []; let cell = ""; let q = false;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); cell = ""; rows.push(row); row = [];
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const head = (rows.shift() || []).map(h => h.trim());
    return rows.filter(r => r.some(c => c.trim())).map(r => {
      const o = {}; head.forEach((h, i) => { o[h] = (r[i] || "").trim(); }); return o;
    });
  }

  const humanize = folder => {
    const s = folder.replace(/^\d+[_\-\s]*/, "").replace(/_+/g, " ").trim();
    return s ? s[0].toUpperCase() + s.slice(1) : folder;
  };

  function prefillFor(folder, csvRows) {
    const num = (folder.match(/^(\d+)/) || [])[1];
    const row = num != null ? csvRows.find(r => Number(r["Item ID"]) === Number(num)) : null;
    if (!row) return { title: humanize(folder), brand: "", color: "" };
    let brand = (row["Brand"] || "").replace(/\s*\(.*?\)\s*/g, " ").trim();
    if (/not identified|unknown/i.test(brand)) brand = "";
    let name = (row["Item name"] || "").replace(/,?\s*likely[^,]*/i, "").trim();
    const title = name
      ? (brand && !name.toLowerCase().startsWith(brand.toLowerCase())
          ? `${brand} ${name[0].toLowerCase()}${name.slice(1)}` : name)
      : humanize(folder);
    return { title, brand, color: row["Color"] || "" };
  }

  async function stageFolder(fileList) {
    const files = [...fileList];
    const parts = f => (f.webkitRelativePath || f.name).split("/");
    const csvFile = files.find(f => /(^|\/)inventory\.csv$/i.test(f.webkitRelativePath || f.name));
    const csvRows = csvFile ? parseCsv(await csvFile.text()) : [];

    let images = files.filter(f => {
      const p = parts(f);
      return IMAGE_FILE.test(f.name) && !f.name.startsWith(".")
        && !p.slice(0, -1).some(s => /^(originals|transparent)$/i.test(s));
    });
    // A pick of the whole library: only the edited/ photos count.
    if (images.some(f => parts(f).slice(0, -1).includes("edited"))) {
      images = images.filter(f => parts(f).slice(0, -1).includes("edited"));
    }

    const groups = new Map(); const loose = [];
    images.forEach(f => {
      const dir = parts(f).slice(0, -1);
      const at = dir.lastIndexOf("edited");
      const item = at > 0 ? dir[at - 1] : (at === -1 && dir.length ? dir[dir.length - 1] : null);
      if (!item) { loose.push(f); return; }
      if (!groups.has(item)) groups.set(item, []);
      groups.get(item).push(f);
    });

    const existing = new Set(I.products.map(p => (p.title || "").trim().toLowerCase()));
    const items = [...groups.keys()].sort(naturalSort).map(folder => {
      const pre = prefillFor(folder, csvRows);
      const dup = existing.has(pre.title.trim().toLowerCase());
      return {
        folder, ...pre, dup, skip: dup,
        files: groups.get(folder).sort((a, b) => naturalSort(a.name, b.name))
      };
    });
    loose.sort((a, b) => naturalSort(a.name, b.name));
    if (!items.length && !loose.length) {
      notice("No edited photos found in that folder. Pick the folder that holds the item folders, such as poda_inventory.", true);
      return;
    }
    I.staged = { items, looseFiles: loose };
    notice("");
  }

  /* ============================================================
     Upload
     ============================================================ */
  function progress(text) {
    const el = document.getElementById("invProgress");
    if (el) el.textContent = text;
  }

  async function commitStaged() {
    if (I.busy || !I.staged) return;
    syncStagedTitles();
    const items = I.staged.items.filter(i => !i.skip);
    const loose = I.staged.looseFiles;
    if (!items.length && !loose.length) { notice("Nothing selected to upload.", true); render(); return; }
    if (loose.length && I.trayMissing) {
      if (!confirm("The Unfiled tray is not set up yet, so loose photos can't be saved. Upload the items anyway?")) return;
    }
    I.busy = true; render();

    const problems = []; let made = 0, photos = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let product;
      try {
        product = await A().createProduct(I.supplier.id, {
          title: it.title.trim() || humanize(it.folder), brand: it.brand, color: it.color,
          quantity: 1, is_unique: true
        });
        made++;
      } catch (e) {
        problems.push(`${it.folder}: could not create the item (${e.message || e})`);
        continue;
      }
      for (let j = 0; j < it.files.length; j++) {
        progress(`Item ${i + 1} of ${items.length} (${it.folder}): photo ${j + 1} of ${it.files.length}`);
        try {
          await A().uploadProductImage(I.supplier.id, product.id, await toUpload(it.files[j]));
          photos++;
        } catch (e) {
          problems.push(`${it.folder}/${it.files[j].name}: ${e.message || e}`);
        }
      }
    }
    let unfiledCount = 0;
    if (!I.trayMissing) {
      for (let k = 0; k < loose.length; k++) {
        progress(`Unfiled photo ${k + 1} of ${loose.length}`);
        try { await uploadUnfiled(loose[k]); unfiledCount++; }
        catch (e) { problems.push(`${loose[k].name}: ${e.message || e}`); }
      }
    }

    I.busy = false; revokeStaged(); I.staged = null;
    let msg = `Created ${made} draft item${made === 1 ? "" : "s"} with ${photos} photo${photos === 1 ? "" : "s"}`
      + (unfiledCount ? ` and ${unfiledCount} unfiled photo${unfiledCount === 1 ? "" : "s"}` : "") + ".";
    if (problems.length) msg += ` ${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems.slice(0, 4).join("; ")}${problems.length > 4 ? "; …" : ""}`;
    await refresh(msg, problems.length > 0);
  }

  async function addLoose(fileList) {
    const files = [...fileList].filter(f => IMAGE_FILE.test(f.name)).sort((a, b) => naturalSort(a.name, b.name));
    if (!files.length) return;
    if (I.trayMissing) { notice("Run migrations/20261124_unfiled_photos.sql in Supabase first, then reload.", true); render(); return; }
    I.busy = true; render();
    let ok = 0; const problems = [];
    for (let k = 0; k < files.length; k++) {
      progress(`Unfiled photo ${k + 1} of ${files.length}`);
      try { await uploadUnfiled(files[k]); ok++; } catch (e) { problems.push(`${files[k].name}: ${e.message || e}`); }
    }
    I.busy = false;
    await refresh(`Added ${ok} unfiled photo${ok === 1 ? "" : "s"}.` + (problems.length ? ` Problems: ${problems.slice(0, 3).join("; ")}` : ""), problems.length > 0);
  }

  /* ============================================================
     Unfiled tray
     ============================================================ */
  const selectedInTrayOrder = () => I.unfiled.filter(u => I.selected.has(u.id));

  async function moveToProduct(photos, productId) {
    const existing = await A().getProduct(productId);
    let pos = sortedImages(existing).length ? Math.max(...sortedImages(existing).map(i => i.position)) + 1 : 0;
    for (const u of photos) {
      const { error } = await client().from("product_images")
        .insert({ product_id: productId, path: u.path, position: pos++ });
      if (error) throw error;
      const { error: delErr } = await client().from("unfiled_photos").delete().eq("id", u.id);
      if (delErr) throw delErr;
      I.selected.delete(u.id);
    }
  }

  async function moveSelected() {
    const target = document.getElementById("invMoveTarget");
    const photos = selectedInTrayOrder();
    if (!target || !target.value) { notice("Choose an item first.", true); render(); return; }
    if (!photos.length) { notice("Tick some photos first.", true); render(); return; }
    await moveToProduct(photos, target.value);
    await refresh(`Moved ${photos.length} photo${photos.length === 1 ? "" : "s"} onto the item.`);
  }

  async function newItemFromSelected() {
    const photos = selectedInTrayOrder();
    if (!photos.length) { notice("Tick some photos first.", true); render(); return; }
    const product = await A().createProduct(I.supplier.id, { title: "Untitled item", quantity: 1, is_unique: true });
    await moveToProduct(photos, product.id);
    await load();
    await openEditor(product.id);
  }

  async function deleteSelected() {
    const photos = selectedInTrayOrder();
    if (!photos.length) { notice("Tick some photos first.", true); render(); return; }
    if (!confirm(`Delete ${photos.length} unfiled photo${photos.length === 1 ? "" : "s"} for good?`)) return;
    await client().storage.from(BUCKET).remove(photos.map(u => u.path));
    const { error } = await client().from("unfiled_photos").delete().in("id", photos.map(u => u.id));
    if (error) throw error;
    photos.forEach(u => I.selected.delete(u.id));
    await refresh(`Deleted ${photos.length} photo${photos.length === 1 ? "" : "s"}.`);
  }

  /* ============================================================
     Rendering: the tab
     ============================================================ */
  function notice(message, bad) { I.notice = message || ""; I.noticeBad = !!bad; }

  async function refresh(message, bad) {
    notice(message, bad);
    try { await load(); } catch (e) { notice(e.message || "Could not load.", true); }
    render();
  }

  function syncStagedTitles() {
    if (!I.staged) return;
    document.querySelectorAll("[data-inv-title]").forEach(inp => {
      const it = I.staged.items[Number(inp.dataset.invTitle)];
      if (it) it.title = inp.value;
    });
  }

  function uploadBlockHTML() {
    return `
      <section class="rel-block">
        <div class="section-bar"><span class="section-bar__title">Upload</span></div>
        <p class="rel-note">Pick a folder that has one subfolder per item, for example <strong>poda_inventory</strong>. Each subfolder becomes one draft item. Its photos are used in file-name order and the first one is the cover: you can change the cover before uploading and any time after. If a folder has an <strong>edited</strong> subfolder, only that is used and <strong>originals</strong> and <strong>transparent</strong> are skipped. Include <strong>inventory.csv</strong> and brand, title and colour are filled in for you.</p>
        <div class="inv-actions">
          <label class="btn btn--primary inv-file">Choose inventory folder
            <input type="file" webkitdirectory directory multiple data-inv-file="folder" hidden />
          </label>
          <label class="btn inv-file">Add loose photos to Unfiled
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple data-inv-file="loose" hidden />
          </label>
        </div>
      </section>`;
  }

  // Small previews of an item's photos. The first is the cover; clicking another
  // moves it to the front.
  function stagedThumbs(it, i) {
    if (!it.urls) it.urls = it.files.map(f => URL.createObjectURL(f));
    return it.files.map((f, j) => `
      <button type="button" class="inv-mini__btn${j === 0 ? " is-cover" : ""}" data-inv="stage-cover" data-item="${i}" data-idx="${j}"
        title="${j === 0 ? "Cover" : "Make cover"}: ${esc(f.name)}">
        <img src="${esc(it.urls[j])}" alt="" loading="lazy" decoding="async" />
        ${j === 0 ? `<span>Cover</span>` : ""}
      </button>`).join("");
  }

  function revokeStaged() {
    if (!I.staged) return;
    I.staged.items.forEach(it => { (it.urls || []).forEach(u => URL.revokeObjectURL(u)); it.urls = null; });
  }

  function stagedBlockHTML() {
    const s = I.staged;
    const rows = s.items.map((it, i) => `
      <tr>
        <td><input type="checkbox" data-inv-keep="${i}" ${it.skip ? "" : "checked"} aria-label="Upload this item" /></td>
        <td class="cell-mono">${esc(it.folder)}</td>
        <td><input class="inv-title" type="text" data-inv-title="${i}" value="${esc(it.title)}" /></td>
        <td><div class="inv-mini">${stagedThumbs(it, i)}</div></td>
        <td>${it.dup ? `<span class="badge">Already uploaded?</span>` : ""}</td>
      </tr>`).join("");
    const total = s.items.filter(i => !i.skip).reduce((n, i) => n + i.files.length, 0);
    return `
      <section class="rel-block">
        <div class="section-bar"><span class="section-bar__title">Ready to upload</span></div>
        <p class="rel-note">${s.items.length} item folder${s.items.length === 1 ? "" : "s"} found.
          ${s.looseFiles.length ? `${s.looseFiles.length} photo${s.looseFiles.length === 1 ? "" : "s"} sit outside any item folder and will go to Unfiled.` : ""}
          Untick anything to skip it. Edit a title if you like: you can change everything later.</p>
        ${s.items.length ? `<div class="table-wrap"><table class="admin-table">
          <thead><tr><th></th><th>Folder</th><th>Item title</th><th>Photos: click one to make it the cover</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>` : ""}
        <div class="inv-actions">
          <button type="button" class="btn btn--primary" data-inv="commit" ${I.busy ? "disabled" : ""}>
            Create ${s.items.filter(i => !i.skip).length} draft item${s.items.filter(i => !i.skip).length === 1 ? "" : "s"} (${total} photos)</button>
          <button type="button" class="btn" data-inv="cancel-staged" ${I.busy ? "disabled" : ""}>Cancel</button>
        </div>
        <p class="rel-note" id="invProgress">${I.busy ? "Starting…" : ""}</p>
      </section>`;
  }

  function trayBlockHTML() {
    if (I.trayMissing) {
      return `<section class="rel-block"><div class="section-bar"><span class="section-bar__title">Unfiled</span></div>
        <p class="rel-note">The Unfiled tray needs a one-time database update. In Supabase → SQL editor, run <strong>migrations/20261124_unfiled_photos.sql</strong>, then reload this page.</p></section>`;
    }
    if (!I.unfiled.length) {
      return `<section class="rel-block"><div class="section-bar"><span class="section-bar__title">Unfiled</span></div>
        <p class="rel-note">No unfiled photos. Photos that belong to no item folder land here so you can tag them one by one.</p></section>`;
    }
    const tiles = I.unfiled.map(u => `
      <label class="inv-tile${I.selected.has(u.id) ? " is-on" : ""}">
        <img src="${esc(mediaUrl(u.path))}" alt="${esc(u.label || "")}" loading="lazy" />
        <input type="checkbox" data-inv-pick="${esc(u.id)}" ${I.selected.has(u.id) ? "checked" : ""} />
        <span class="inv-tile__name">${esc(u.label || "")}</span>
      </label>`).join("");
    const targets = I.products.slice().sort((a, b) => (a.state === "draft" ? 0 : 1) - (b.state === "draft" ? 0 : 1))
      .map(p => `<option value="${esc(p.id)}">${esc(p.title || "Untitled")}${p.state === "draft" ? "" : " (" + esc(p.state) + ")"}</option>`).join("");
    return `
      <section class="rel-block">
        <div class="section-bar"><span class="section-bar__title">Unfiled</span><span class="badge">${I.unfiled.length}</span></div>
        <p class="rel-note">Tick photos, then add them to an item or start a new item from them.</p>
        <div class="inv-actions">
          <span class="rel-note" id="invSelCount" style="margin:0;">${I.selected.size} selected</span>
          <select id="invMoveTarget" aria-label="Add to item"><option value="">Add to item…</option>${targets}</select>
          <button type="button" class="btn" data-inv="move">Add</button>
          <button type="button" class="btn btn--primary" data-inv="new-from-selected">New item from selected</button>
          <button type="button" class="btn btn--danger" data-inv="delete-unfiled">Delete selected</button>
          <button type="button" class="btn" data-inv="select-all">Select all</button>
        </div>
        <div class="inv-grid">${tiles}</div>
      </section>`;
  }

  function itemsBlockHTML() {
    const drafts = I.products.filter(p => p.state === "draft")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const others = I.products.filter(p => p.state !== "draft");
    const todo = drafts.filter(p => missingOf(p).length);
    const rows = [...drafts, ...others].map(p => {
      const imgs = sortedImages(p);
      const thumb = imgs[0]
        ? `<img class="seller-thumb" src="${esc(A().productImageUrl(imgs[0].path))}" alt="" />`
        : `<div class="seller-thumb seller-thumb--empty">No photo</div>`;
      const miss = p.state === "draft" ? missingOf(p) : [];
      return `
        <tr>
          <td>${thumb}</td>
          <td class="cell-strong">${esc(p.title || "Untitled")}${p.brand ? `<span class="cell-sub">${esc(p.brand)}</span>` : ""}</td>
          <td><span class="badge badge--${esc(p.state)}">${esc(p.state)}</span></td>
          <td class="cell-mono">${imgs.length}</td>
          <td>${p.state !== "draft" ? "" : miss.length ? `<span class="rel-note" style="margin:0;">Needs ${esc(miss.join(", "))}</span>` : `<span class="badge">Ready to publish</span>`}</td>
          <td class="cell-mono">${p.price_cents == null ? "—" : "$" + (p.price_cents / 100).toFixed(p.price_cents % 100 ? 2 : 0)}</td>
          <td><div class="cell-actions">
            <button type="button" class="btn" data-inv="edit" data-id="${esc(p.id)}">${p.state === "draft" ? "Fill in" : "Edit"}</button>
            ${imgs.length ? `<button type="button" class="btn" data-inv="share-ig" data-id="${esc(p.id)}">Share to IG</button>` : ""}
          </div></td>
        </tr>`;
    }).join("");
    return `
      <section class="rel-block">
        <div class="section-bar"><span class="section-bar__title">Your items</span><span class="badge">${I.products.length}</span>
          ${todo.length ? `<button type="button" class="admin-newitem section-bar__action" data-inv="start-tagging">Tag one by one (${todo.length} left)</button>` : ""}</div>
        ${I.products.length ? `<div class="table-wrap"><table class="admin-table">
          <thead><tr><th></th><th>Item</th><th>State</th><th>Photos</th><th>Details</th><th>Price</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>` : `<p class="admin-empty">No items yet. Upload a folder above.</p>`}
      </section>`;
  }

  function render() {
    adminMain.innerHTML = `
      <div class="section-bar section-bar--admin"><span class="section-bar__label">Supply</span><span class="section-bar__title">My inventory</span></div>
      <p class="rel-note">Your own pieces, posted under poda. No supplier account and no consignment split.</p>
      ${I.notice ? `<p class="rel-note" style="color:${I.noticeBad ? "#b3541e" : "var(--text-dim)"};">${esc(I.notice)}</p>` : ""}
      ${I.busy && !I.staged ? `<p class="rel-note" id="invProgress">Working…</p>` : ""}
      ${I.staged ? stagedBlockHTML() : uploadBlockHTML()}
      ${trayBlockHTML()}
      ${itemsBlockHTML()}`;
  }

  async function renderTab() {
    bindOnce();
    adminMain.innerHTML = `<p class="admin-empty">Loading…</p>`;
    try { await load(); }
    catch (e) {
      adminMain.innerHTML = `<p class="rel-note" style="color:#b3541e;">Could not load your inventory: ${esc(e.message || e)}</p>`;
      return;
    }
    render();
  }

  /* ============================================================
     Item editor (modal)
     ============================================================ */
  const FIELDS = [
    ["title", "Title", true], ["brand", "Brand"], ["category", "Category"], ["color", "Colour"],
    ["size", "Size"], ["material", "Material"], ["condition", "Condition"], ["measurements", "Measurements"]
  ];

  function readEditorFields() {
    const m = I.modal; if (!m) return null;
    const f = {};
    FIELDS.forEach(([k]) => { const el = document.getElementById("inv_" + k); if (el) f[k] = el.value.trim(); });
    ["condition_notes", "description"].forEach(k => { const el = document.getElementById("inv_" + k); if (el) f[k] = el.value.trim(); });
    const price = document.getElementById("inv_price");
    if (price) f.priceDollars = price.value.trim();
    return f;
  }

  function editorHTML() {
    const p = I.modal.product;
    const imgs = sortedImages(p);
    const val = k => esc(p[k] ?? "");
    const price = p.price_cents == null ? "" : (p.price_cents / 100).toString();
    const strip = imgs.length ? imgs.map((im, i) => `
      <div class="inv-photo" draggable="true" data-photo="${esc(im.id)}">
        <img src="${esc(A().productImageUrl(im.path))}" alt="" draggable="false" />
        <div class="inv-photo__bar">
          ${i === 0 ? "" : `<button type="button" class="btn" data-inv="img-cover" data-id="${esc(im.id)}" title="Make cover">Cover</button>`}
          <button type="button" class="btn" data-inv="img-left" data-id="${esc(im.id)}" ${i === 0 ? "disabled" : ""} aria-label="Move earlier">←</button>
          <button type="button" class="btn" data-inv="img-right" data-id="${esc(im.id)}" ${i === imgs.length - 1 ? "disabled" : ""} aria-label="Move later">→</button>
          <button type="button" class="btn btn--danger" data-inv="img-del" data-id="${esc(im.id)}" aria-label="Remove photo">×</button>
        </div>
        ${i === 0 ? `<span class="inv-photo__main">Main</span>` : ""}
      </div>`).join("") : `<p class="rel-note">No photos yet.</p>`;
    const live = p.state === "accepted";
    modalContent.innerHTML = `
      <div class="modal-head">
        <h2 class="modal-title">${esc(p.title || "Item")} <span class="badge badge--${esc(p.state)}">${esc(p.state)}</span></h2>
        <button type="button" class="modal-close" data-inv="close" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <p class="field-error" id="invModalError" ${I.modal.error ? "" : "hidden"}>${esc(I.modal.error || "")}</p>
        <p class="rel-note" id="invModalOk" hidden style="margin:0 0 8px;">Saved.</p>
        <div class="inv-strip">${strip}</div>
        <label class="btn inv-file" style="margin:8px 0 16px;">Add photos
          <input type="file" accept="image/png,image/jpeg,image/webp" multiple data-inv-file="item-photos" hidden />
        </label>
        <div class="form-section">
          ${FIELDS.map(([k, label]) => `
            <div class="field"><label for="inv_${k}">${esc(label)}</label>
              <input id="inv_${k}" type="text" value="${val(k)}" /></div>`).join("")}
          <div class="field"><label for="inv_price">Price (USD)</label>
            <input id="inv_price" type="number" min="0" step="0.01" value="${esc(price)}" /></div>
          <div class="field field--full"><label for="inv_condition_notes">Condition notes (shown to buyers: be specific about wear and flaws)</label>
            <textarea id="inv_condition_notes" rows="3">${val("condition_notes")}</textarea></div>
          <div class="field field--full"><label for="inv_description">Description</label>
            <textarea id="inv_description" rows="3">${val("description")}</textarea></div>
        </div>
      </div>
      <div class="modal-foot">
        ${p.state === "draft" ? `<button type="button" class="btn btn--danger" data-inv="delete-item">Delete item</button>` : ""}
        ${live ? `<button type="button" class="btn" data-inv="withdraw">Withdraw</button>` : ""}
        ${imgs.length ? `<button type="button" class="btn" data-inv="share-ig-editor">Share to IG</button>` : ""}
        <button type="button" class="btn" data-inv="save">Save</button>
        ${p.state === "draft" ? `<button type="button" class="btn" data-inv="save-next">Save and next</button>
          <button type="button" class="btn btn--primary" data-inv="publish">Publish</button>` : ""}
      </div>`;
    modalOverlay.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function editorError(message) {
    I.modal.error = message || "";
    const el = document.getElementById("invModalError");
    if (el) { el.textContent = I.modal.error; el.hidden = !I.modal.error; }
  }

  async function openEditor(id) {
    const product = await A().getProduct(id);
    I.modal = { product, error: "" };
    editorHTML();
  }

  async function saveEditor() {
    const fields = readEditorFields();
    I.modal.product = await A().updateProduct(I.modal.product.id, fields);
    // updateProduct returns the bare row: reattach photos for redraws.
    I.modal.product = await A().getProduct(I.modal.product.id);
  }

  async function reloadEditorKeepingFields() {
    const fields = readEditorFields();
    const fresh = await A().getProduct(I.modal.product.id);
    // Keep what was typed: apply it to the local copy before redrawing.
    if (fields) {
      Object.keys(fields).forEach(k => {
        if (k === "priceDollars") fresh.price_cents = fields[k] === "" ? null : Math.round(Number(fields[k]) * 100);
        else fresh[k] = fields[k];
      });
    }
    I.modal.product = fresh;
    editorHTML();
  }

  // Move one photo to a new place in the order (cover = place 0).
  async function moveImage(imgId, toIndex) {
    const imgs = sortedImages(I.modal.product);
    const from = imgs.findIndex(x => x.id === imgId);
    if (from < 0 || toIndex < 0 || toIndex >= imgs.length || from === toIndex) return;
    imgs.splice(toIndex, 0, ...imgs.splice(from, 1));
    for (let k = 0; k < imgs.length; k++) {
      if (imgs[k].position !== k) {
        const { error } = await client().from("product_images").update({ position: k }).eq("id", imgs[k].id);
        if (error) throw error;
      }
    }
    await reloadEditorKeepingFields();
  }

  async function swapImage(imgId, dir) {
    const imgs = sortedImages(I.modal.product);
    const i = imgs.findIndex(x => x.id === imgId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= imgs.length) return;
    [imgs[i], imgs[j]] = [imgs[j], imgs[i]];
    // Write positions as 0..n so they stay tidy.
    for (let k = 0; k < imgs.length; k++) {
      if (imgs[k].position !== k) {
        const { error } = await client().from("product_images").update({ position: k }).eq("id", imgs[k].id);
        if (error) throw error;
      }
    }
    await reloadEditorKeepingFields();
  }

  async function publishEditor() {
    await saveEditor();
    const p = I.modal.product;
    const need = [];
    if (!p.title || /^untitled/i.test(p.title.trim())) need.push("a title");
    if (!(p.price_cents > 0)) need.push("a price");
    if (!p.condition) need.push("a condition");
    if (!sortedImages(p).length) need.push("at least one photo");
    if (need.length) { editorHTML(); editorError(`Before publishing, add ${need.join(", ")}.`); return; }
    if (!confirm(`Publish "${p.title}"? It becomes available to add to a release.`)) { editorHTML(); return; }
    await A().acceptProduct(p.id);
    closeEditor("Published “" + p.title + "”. Add it to a release from the pick board.");
  }

  async function nextDraft(afterId) {
    await load();
    const drafts = I.products.filter(p => p.state === "draft" && missingOf(p).length)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const idx = drafts.findIndex(p => p.id === afterId);
    return drafts.find((p, i) => p.id !== afterId && i > idx) || drafts.find(p => p.id !== afterId) || null;
  }

  function closeEditor(message) {
    I.modal = null;
    closeModal();
    refresh(message || "");
  }

  /* ============================================================
     Share to Instagram
     Turns an item's photos into carousel slides (4:5, 1080x1350, on white)
     and writes a short lowercase caption. Instagram has no web posting
     route for a personal account, so the hand-off is: Share (phone share
     sheet) or Download, then paste the copied caption.
     ============================================================ */
  // Per destination: slide limit and size. Instagram carousels are 4:5; Depop shows
// listings as squares, so its photos are square (nothing gets cropped off).
const MODES = {
    ig:    { label: "Instagram", max: 10, w: 1080, h: 1350, shape: "4:5" },
    depop: { label: "Depop",     max: 8,  w: 1200, h: 1200, shape: "square" }
  };
  const IG_FIXED_TAGS = ["thrifted", "secondhand", "vintage", "preloved", "thriftfinds"];

  // One photo -> a 1080x1350 JPEG: the whole garment, centred on white, never cropped.
  async function renderSlide(url, IG_W, IG_H) {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error("Could not load a photo.");
    const bmp = await createImageBitmap(await res.blob());
    const c = document.createElement("canvas");
    c.width = IG_W; c.height = IG_H;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, IG_W, IG_H);
    const k = Math.min(IG_W / bmp.width, IG_H / bmp.height);
    const w = bmp.width * k, h = bmp.height * k;
    ctx.drawImage(bmp, (IG_W - w) / 2, (IG_H - h) / 2, w, h);
    return new Promise((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error("Could not prepare a photo.")), "image/jpeg", 0.92));
  }

  // Short, lowercase, no price, no link (the link lives in the bio).
  function buildCaption(p, mode) {
    if (mode === "depop") return buildDepop(p);
    const lc = s => String(s || "").trim().toLowerCase();
    const detail = [p.size ? "size " + lc(p.size) : "", lc(p.condition)].filter(Boolean).join(" · ");
    const tag = s => lc(s).replace(/[^a-z0-9]+/g, "");
    const tags = [];
    [p.brand, p.category, p.color].forEach(v => { const t = tag(v); if (t) tags.push(t); });
    IG_FIXED_TAGS.forEach(t => tags.push(t));
    const uniq = [...new Set(tags)].map(t => "#" + t).join(" ");
    return [lc(p.title), detail, "", "dm to buy", "--", uniq].filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n").replace(/^\n+/, "");
  }

// Depop: a plain, searchable description. Hashtags live inside it and Depop counts 5.
  function buildDepop(p) {
    const lc = s => String(s || "").trim().toLowerCase();
    const tag = s => lc(s).replace(/[^a-z0-9]+/g, "");
    const lines = [lc(p.title), ""];
    [["brand", p.brand], ["size", p.size], ["colour", p.color], ["condition", p.condition], ["measurements", p.measurements]]
      .forEach(([k, v]) => { if (lc(v)) lines.push(`${k}: ${lc(v)}`); });
    if (lc(p.condition_notes)) lines.push("", lc(p.condition_notes));
    if (lc(p.description)) lines.push("", lc(p.description));
    const tags = [...new Set([tag(p.brand), tag(p.category), "thrifted", "vintage", "secondhand", tag(p.color)].filter(Boolean))]
      .slice(0, 5).map(t => "#" + t).join(" ");
    lines.push("", "message me with any questions.", "", tags);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n");
  }

  // Depop's form fields, each one copyable.
  function depopFields(p) {
    const price = p.price_cents == null ? "" : (p.price_cents / 100).toFixed(p.price_cents % 100 ? 2 : 0);
    return [["Brand", p.brand], ["Category", p.category], ["Size", p.size], ["Colour", p.color],
      ["Condition", p.condition], ["Price (USD)", price]].filter(([, v]) => v);
  }

  function igRevoke() {
    if (I.ig) I.ig.slides.forEach(s => URL.revokeObjectURL(s.url));
  }

  function syncIgCaption() {
    const t = document.getElementById("igCaption");
    if (t && I.ig) I.ig.caption = t.value;
  }

  function igHTML() {
    const g = I.ig, p = g.product, m = MODES[g.mode];
    const slides = g.slides.map((s, i) => `
      <div class="inv-photo">
        <img src="${esc(s.url)}" alt="" />
        <span class="inv-photo__main">${i + 1}</span>
        <div class="inv-photo__bar">
          <button type="button" class="btn" data-inv="ig-left" data-id="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move earlier">←</button>
          <button type="button" class="btn" data-inv="ig-right" data-id="${i}" ${i === g.slides.length - 1 ? "disabled" : ""} aria-label="Move later">→</button>
          <button type="button" class="btn btn--danger" data-inv="ig-drop" data-id="${i}" aria-label="Leave this photo out">×</button>
        </div>
      </div>`).join("");
    modalContent.innerHTML = `
      <div class="modal-head">
        <h2 class="modal-title">Share: ${esc(p.title || "Item")}</h2>
        <button type="button" class="modal-close" data-inv="ig-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="inv-actions" style="margin-top:0;">
          ${Object.keys(MODES).map(k => `<button type="button" class="btn${k === g.mode ? " btn--primary" : ""}" data-inv="ig-mode" data-mode="${k}">${MODES[k].label}</button>`).join("")}
        </div>
        <p class="field-error" id="igError" ${g.error ? "" : "hidden"}>${esc(g.error || "")}</p>
        <p class="rel-note">${g.slides.length} slide${g.slides.length === 1 ? "" : "s"}, ${m.shape} on white${g.more ? `, first ${m.max} of ${m.max + g.more} photos (${m.label}'s limit)` : ""}. Reorder or drop slides, then ${g.mode === "depop" ? "download them and add them to your Depop listing" : "share or download them"}.</p>
        <div class="inv-strip">${slides || `<p class="rel-note">No photos to share.</p>`}</div>
        <div class="field field--full" style="margin-top:14px;"><label for="igCaption">${g.mode === "depop" ? "Description (hashtags are inside it)" : "Caption"}</label>
          <textarea id="igCaption" rows="${g.mode === "depop" ? 12 : 9}">${esc(g.caption)}</textarea></div>
        ${g.mode === "depop" ? `<div class="field field--full"><label>Listing fields: tap to copy</label>
          <div class="inv-actions" style="margin:0;">${depopFields(p).map(([k, v]) => `<button type="button" class="btn" data-inv="ig-copyval" data-val="${esc(v)}">${esc(k)}: ${esc(v)}</button>`).join("")}</div></div>` : ""}
        <p class="rel-note" id="igOk" hidden style="margin:0;"></p>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" data-inv="ig-copy">${g.mode === "depop" ? "Copy description" : "Copy caption"}</button>
        <button type="button" class="btn" data-inv="ig-download" ${g.slides.length ? "" : "disabled"}>Download photos</button>
        <button type="button" class="btn btn--primary" data-inv="ig-share" ${g.slides.length ? "" : "disabled"}>Share photos</button>
        ${g.mode === "depop" ? `<a class="btn" href="https://www.depop.com/products/create/" target="_blank" rel="noopener">Open Depop</a>` : ""}
      </div>`;
    modalOverlay.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function igFlash(text, bad) {
    const el = document.getElementById(bad ? "igError" : "igOk");
    if (!el) return;
    el.textContent = text; el.hidden = false;
    if (!bad) setTimeout(() => { el.hidden = true; }, 3000);
  }

  async function openShare(product, mode) {
    igRevoke();
    mode = mode || "ig";
    const m = MODES[mode];
    const imgs = sortedImages(product);
    I.ig = { product, mode, slides: [], caption: buildCaption(product, mode), error: "", more: Math.max(0, imgs.length - m.max) };
    modalContent.innerHTML = `<div class="modal-body"><p class="admin-empty">Getting the photos ready…</p></div>`;
    modalOverlay.hidden = false;
    document.body.style.overflow = "hidden";
    const slug = (product.title || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
    let failed = 0;
    for (const im of imgs.slice(0, m.max)) {
      try {
        const blob = await renderSlide(A().productImageUrl(im.path), m.w, m.h);
        I.ig.slides.push({ blob, url: URL.createObjectURL(blob), name: "" });
      } catch (e) { failed++; }
    }
    I.ig.slides.forEach((s, i) => { s.name = `${slug}-${String(i + 1).padStart(2, "0")}.jpg`; });
    if (failed) I.ig.error = `${failed} photo${failed === 1 ? "" : "s"} could not be loaded and ${failed === 1 ? "was" : "were"} left out.`;
    igHTML();
  }

  function igFiles() {
    const slug = (I.ig.product.title || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
    return I.ig.slides.map((s, i) => new File([s.blob], `${slug}-${String(i + 1).padStart(2, "0")}.jpg`, { type: "image/jpeg" }));
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      // Older or locked-down browsers: copy through a throwaway textarea.
      const t = document.createElement("textarea");
      t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (x) { ok = false; }
      t.remove();
      return ok;
    }
  }

  async function igAction(act, idx, el) {
    syncIgCaption();
    const g = I.ig;
    if (act === "ig-mode") {
      await openShare(g.product, el.dataset.mode);
    } else if (act === "ig-copyval") {
      const ok = await copyText(el.dataset.val);
      igFlash(ok ? "Copied." : "Could not copy that one.", !ok);
    } else if (act === "ig-left" || act === "ig-right") {
      const j = idx + (act === "ig-left" ? -1 : 1);
      if (j >= 0 && j < g.slides.length) { [g.slides[idx], g.slides[j]] = [g.slides[j], g.slides[idx]]; }
      igHTML();
    } else if (act === "ig-drop") {
      URL.revokeObjectURL(g.slides[idx].url); g.slides.splice(idx, 1); igHTML();
    } else if (act === "ig-copy") {
      igFlash((await copyText(g.caption)) ? (g.mode === "depop" ? "Description copied." : "Caption copied.") : "Could not copy: select the text and copy it by hand.", false);
    } else if (act === "ig-download") {
      const files = igFiles();
      for (const f of files) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(f); a.download = f.name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        await new Promise(r => setTimeout(r, 300));
      }
      igFlash(`Downloaded ${files.length} photo${files.length === 1 ? "" : "s"}.`, false);
    } else if (act === "ig-share") {
      const files = igFiles(); const m = MODES[g.mode];
      if (!(navigator.canShare && navigator.canShare({ files }))) {
        igFlash(`This browser can't share photos straight to apps. Use Download photos, then add them in ${m.label}.`, true); return;
      }
      await copyText(g.caption); // text is on the clipboard, ready to paste
      try { await navigator.share({ files }); igFlash(`Shared. The ${g.mode === "depop" ? "description" : "caption"} is copied: paste it in ${m.label}.`, false); }
      catch (e) { if (e && e.name !== "AbortError") igFlash("Could not open the share sheet.", true); }
    } else if (act === "ig-close") {
      igRevoke(); I.ig = null; closeModal();
    }
  }

  /* ============================================================
     Events
     ============================================================ */
  async function onClick(e) {
    const el = e.target.closest("[data-inv]");
    if (!el) return;
    const act = el.dataset.inv; const id = el.dataset.id;
    if (act.startsWith("ig-")) { await igAction(act, Number(id), el); return; }
    try {
      switch (act) {
        case "share-ig": {
          const p = I.products.find(x => x.id === id);
          if (p) await openShare(p);
          break;
        }
        case "share-ig-editor": {
          await saveEditor();
          const p = I.modal.product; I.modal = null;
          await openShare(p);
          break;
        }
        case "commit": await commitStaged(); break;
        case "cancel-staged": revokeStaged(); I.staged = null; render(); break;
        case "stage-cover": {
          syncStagedTitles();
          const it = I.staged.items[Number(el.dataset.item)]; const j = Number(el.dataset.idx);
          if (j > 0) { it.files.unshift(...it.files.splice(j, 1)); it.urls.unshift(...it.urls.splice(j, 1)); }
          render(); break;
        }
        case "select-all":
          if (I.selected.size === I.unfiled.length) I.selected.clear(); else I.unfiled.forEach(u => I.selected.add(u.id));
          render(); break;
        case "move": await moveSelected(); break;
        case "new-from-selected": await newItemFromSelected(); break;
        case "delete-unfiled": await deleteSelected(); break;
        case "edit": await openEditor(id); break;
        case "start-tagging": {
          const first = I.products.filter(p => p.state === "draft" && missingOf(p).length)
            .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
          if (first) await openEditor(first.id);
          break;
        }
        case "close": closeEditor(); break;
        case "save": {
          await saveEditor(); editorHTML();
          const ok = document.getElementById("invModalOk");
          if (ok) { ok.hidden = false; setTimeout(() => { ok.hidden = true; }, 2500); }
          break;
        }
        case "save-next": {
          const cur = I.modal.product.id;
          await saveEditor();
          const nxt = await nextDraft(cur);
          if (nxt) { await openEditor(nxt.id); }
          else closeEditor("Saved. No more items waiting on details.");
          break;
        }
        case "publish": await publishEditor(); break;
        case "withdraw":
          if (confirm("Withdraw this item from sale? Its history stays.")) {
            await A().withdrawProduct(I.modal.product.id); closeEditor("Withdrawn.");
          }
          break;
        case "delete-item":
          if (confirm("Delete this draft item and its photos for good?")) {
            await A().deleteProduct(I.modal.product.id); closeEditor("Deleted the draft item.");
          }
          break;
        case "img-cover": await moveImage(id, 0); break;
        case "img-left": await swapImage(id, -1); break;
        case "img-right": await swapImage(id, 1); break;
        case "img-del":
          if (confirm("Remove this photo?")) {
            const im = sortedImages(I.modal.product).find(x => x.id === id);
            if (im) await A().deleteProductImage(im.id, im.path);
            await reloadEditorKeepingFields();
          }
          break;
        default: break;
      }
    } catch (err) {
      console.error("My inventory action failed:", err);
      if (I.modal) editorError(err.message || "That didn't work.");
      else { notice(err.message || "That didn't work.", true); I.busy = false; render(); }
    }
  }

  async function onChange(e) {
    const f = e.target.closest("[data-inv-file]");
    if (f && f.files && f.files.length) {
      const kind = f.dataset.invFile; const files = f.files;
      try {
        if (kind === "folder") { await stageFolder(files); render(); }
        else if (kind === "loose") await addLoose(files);
        else if (kind === "item-photos") {
          for (const file of [...files].sort((a, b) => naturalSort(a.name, b.name))) {
            await A().uploadProductImage(I.supplier.id, I.modal.product.id, await toUpload(file));
          }
          await reloadEditorKeepingFields();
        }
      } catch (err) {
        if (I.modal) editorError(err.message || "Upload failed."); else { notice(err.message || "Upload failed.", true); I.busy = false; render(); }
      }
      f.value = "";
      return;
    }
    const pick = e.target.closest("[data-inv-pick]");
    if (pick) {
      if (pick.checked) I.selected.add(pick.dataset.invPick); else I.selected.delete(pick.dataset.invPick);
      const tile = pick.closest(".inv-tile"); if (tile) tile.classList.toggle("is-on", pick.checked);
      const c = document.getElementById("invSelCount"); if (c) c.textContent = `${I.selected.size} selected`;
      return;
    }
    const keep = e.target.closest("[data-inv-keep]");
    if (keep && I.staged) {
      I.staged.items[Number(keep.dataset.invKeep)].skip = !keep.checked;
      syncStagedTitles(); render();
    }
  }

  let dragId = null;
  function onDragStart(e) {
    const t = e.target.closest && e.target.closest("[data-photo]");
    if (!t) return;
    dragId = t.dataset.photo;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", dragId); } catch (x) { /* some browsers need data to start a drag */ }
  }
  function onDragOver(e) {
    if (dragId && e.target.closest && e.target.closest("[data-photo]")) e.preventDefault();
  }
  async function onDrop(e) {
    const t = e.target.closest && e.target.closest("[data-photo]");
    if (!dragId || !t) return;
    e.preventDefault();
    const id = dragId; dragId = null;
    const target = sortedImages(I.modal.product).findIndex(x => x.id === t.dataset.photo);
    try { await moveImage(id, target); } catch (err) { editorError(err.message || "Could not reorder."); }
  }

  function bindOnce() {
    if (I.bound) return;
    I.bound = true;
    modalContent.addEventListener("dragstart", onDragStart);
    modalContent.addEventListener("dragover", onDragOver);
    modalContent.addEventListener("drop", onDrop);
    [adminMain, modalContent].forEach(el => {
      el.addEventListener("click", onClick);
      el.addEventListener("change", onChange);
    });
  }

  window.PodaInventoryUpload = { render: renderTab };
})();
