/* ============================================================
   release.js — the admin's release workspace.

   Primary admin navigation:
     Current Release  — the one release being prepared (explicit is_working
                        flag), with Contents / Settings / Preview / Activity
     All Releases     — switch the working release, create, archive
     Supply           — Review Queue / Inventory / Suppliers (existing views)
     Subscribers      — subscribers, plus the notes library with email send
     Settings         — account, request handling, legacy data

   A release is an `edits` row. Its drop is the DATABASE's call: products
   appear in Shop when edits.publish_at <= now() (or after a manual launch).
   Nothing here is the gate; this file only writes the schedule.

   This file is loaded BEFORE admin.js and only touches admin.js globals
   (adminMain, modalContent, noteState, escapeHTML, textField, …) when a
   function runs, after admin.js has loaded.
   ============================================================ */
(function () {
  "use strict";

  const A = () => window.PodaMarketplace;
  const D = () => window.PodaDB;
  const T = () => window.PodaTZ;
  const esc = v => escapeHTML(v);

  const R = {
    tab: "contents",     // contents | settings | preview | activity
    previewMode: "private",
    supplyTab: "review",
    subsTab: "subscribers",
    data: null,          // the loaded workspace (see loadWorkspace)
    modal: null,         // state of the open modal, if any
    bound: false
  };

  /* ============================================================
     Small helpers
     ============================================================ */
  function releaseLabel(r) {
    return r.number == null ? "Release" : `Folder ${String(r.number).padStart(3, "0")}`;
  }

  function fmtLocal(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
    });
  }

  function fmtZone(iso, zone) {
    return T() ? T().formatInZone(iso, zone, true) : fmtLocal(iso);
  }

  function setNotice(message, bad) {
    const el = document.getElementById("relNotice");
    if (!el) { if (message) alert(message); return; }
    el.textContent = message || "";
    el.style.color = bad ? "#b3541e" : "var(--text-dim)";
  }

  // The admin's own reading of a release's state. Display only: what
  // visitors actually see is decided by the database (public_releases).
  function stateOf(r) {
    const now = Date.now();
    const due = r.publish_at ? Date.parse(r.publish_at) : NaN;
    const dropped = !!r.launched_at || (Number.isFinite(due) && due <= now);
    if (r.status === "archived") return { key: "archived", label: "Archived", dropped };
    if (r.status === "draft") return { key: "draft", label: "Draft — private", dropped: false };
    if (dropped) return { key: "dropped", label: "Dropped", dropped: true };
    if (Number.isFinite(due)) return { key: "scheduled", label: "Drop scheduled", dropped: false };
    return { key: "open", label: "Open — no drop scheduled", dropped: false };
  }

  function showTabs(items, active, onPick) {
    const el = document.getElementById("adminTabs");
    if (!el) return;
    el.hidden = false;
    el.innerHTML = items.map(i =>
      `<button type="button" class="admin-nav__link${i.key === active ? " active" : ""}" data-rel-tab="${i.key}">${esc(i.label)}</button>`
    ).join("");
    el.onclick = e => {
      const b = e.target.closest("[data-rel-tab]");
      if (b) onPick(b.dataset.relTab);
    };
  }

  function hideTabs() {
    const el = document.getElementById("adminTabs");
    if (!el) return;
    el.hidden = true;
    el.innerHTML = "";
    el.onclick = null;
  }

  function migrationNeeded(error) {
    hideTabs();
    adminMain.innerHTML = `
      <div class="section-bar"><span class="section-bar__title">Database update needed</span></div>
      <p class="rel-note">The release workspace needs a one-time database update that hasn't been applied yet.</p>
      <p class="rel-note">In Supabase → SQL editor, run <strong>migrations/20261028_release_workspace.sql</strong> from the repository, then reload this page. It's repeatable and deletes nothing.</p>
      <p class="rel-note">Detail: ${esc(error && error.message ? error.message : String(error))}</p>`;
  }

  function isSchemaError(e) {
    return !!e && (e.code === "42703" || e.code === "42P01" || e.code === "PGRST204" || e.code === "PGRST205" ||
      /is_working|does not exist|schema cache|Could not find/i.test(e.message || ""));
  }

  // Validate and upload one image to the note-media bucket (admin only).
  async function uploadImageFile(file) {
    if (!/^image\/(png|jpe?g|webp|gif|avif)$/i.test(file.type)) {
      throw new Error(`${file.name}: only image files can be uploaded.`);
    }
    if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name}: images must be under 10 MB.`);
    return D().uploadNoteMedia(file, {});
  }

  async function logEvent(event, detail) {
    if (R.data) await A().addReleaseEvent(R.data.release.id, event, detail);
  }

  /* ============================================================
     Current Release
     ============================================================ */
  async function renderCurrent() {
    hideTabs();
    adminMain.innerHTML = `<p class="admin-empty">Loading…</p>`;
    bindOnce();
    let release;
    try {
      release = await A().getWorkingRelease();
      if (!release) {
        // No explicit working release yet: offer the newest unfinished one.
        const all = await A().getEdits();
        release = all.find(r => r.status !== "archived") || null;
        if (release) await A().setWorkingRelease(release.id);
      }
    } catch (e) {
      if (isSchemaError(e)) { migrationNeeded(e); return; }
      adminMain.innerHTML = `<p class="admin-empty">Could not load releases: ${esc(e.message || e)}</p>`;
      return;
    }
    if (!release) { renderFirstRelease(); return; }
    await renderWorkspace(release.id);
  }

  function renderFirstRelease() {
    adminMain.innerHTML = `
      <div class="section-bar"><span class="section-bar__title">Create your first release</span></div>
      <p class="rel-note">A release is one biweekly folder. You'll add its note, lookbook, updates and products here, then schedule its drop into Shop.</p>
      ${newReleaseFormHTML(1)}`;
  }

  function newReleaseFormHTML(suggestedNumber) {
    return `
      <form class="form-card" id="relNewForm" novalidate style="margin-top:14px;">
        <div class="field-grid">
          ${textField("Release number", "number", suggestedNumber, { id: "relNewNumber", type: "number" })}
          ${textField("Title", "title", "", { id: "relNewTitle", full: true, placeholder: "e.g. The New Work Uniform" })}
        </div>
        <p class="field-error" id="relNewError" hidden></p>
        <button type="button" class="btn btn--primary" data-rel="create-release">Create release</button>
      </form>`;
  }

  async function createRelease() {
    const number = parseInt(document.getElementById("relNewNumber").value, 10);
    const title = document.getElementById("relNewTitle").value.trim();
    const err = document.getElementById("relNewError");
    if (!Number.isInteger(number) || number < 1 || !title) {
      err.textContent = "Enter a release number (1 or higher) and a title.";
      err.hidden = false;
      return;
    }
    try {
      const created = await A().createEdit({ number, title });
      await A().setWorkingRelease(created.id);
      R.data = { release: created };
      await logEvent("created", { number, title });
      R.tab = "contents";
      await renderWorkspace(created.id);
      if (state.view !== "release") setView("release");
    } catch (e) {
      err.textContent = e.message || "Could not create the release.";
      err.hidden = false;
    }
  }

  async function loadWorkspace(id) {
    const [release, placements, updates, publicList] = await Promise.all([
      A().getEdit(id),
      A().getPlacementsFull(id),
      A().getFolderUpdates(id),
      A().getPublicFolders().catch(() => [])
    ]);
    const pub = publicList.find(f => f.id === id) || null;
    const shop = publicList.find(f => f.is_shop) || null;
    R.data = {
      release, placements, updates, pub,
      shopId: shop ? shop.id : null,
      shop,
      notes: noteState.notes.filter(n => n.folderId === id),
      studies: studyState.studies
        .filter(s => s.relatedDropId === id)
        .sort((a, b) => (a.releaseOrder ?? 999) - (b.releaseOrder ?? 999))
    };
    return R.data;
  }

  async function renderWorkspace(id) {
    const keepScroll = window.scrollY;
    try {
      await loadWorkspace(id || R.data.release.id);
    } catch (e) {
      if (isSchemaError(e)) { migrationNeeded(e); return; }
      adminMain.innerHTML = `<p class="admin-empty">Could not load this release: ${esc(e.message || e)}</p>`;
      return;
    }
    const d = R.data;
    const r = d.release;
    const st = stateOf(r);
    const inShop = d.shopId === r.id;
    const tabs = [["contents", "Contents"], ["settings", "Settings"], ["preview", "Preview"], ["activity", "Activity"]];

    adminMain.innerHTML = `
      <div class="rel-head">
        <h2 class="rel-head__title">${esc(releaseLabel(r))} — ${esc(r.title || "Untitled")}</h2>
        ${r.is_working ? `<span class="rel-badge rel-badge--on">Working release</span>` : `<span class="rel-badge">Not the working release</span>`}
        ${inShop ? `<span class="rel-badge rel-badge--on">In Shop now</span>` : ""}
        <span class="rel-badge${st.key === "draft" ? "" : " rel-badge--on"}">${esc(st.label)}</span>
      </div>
      <p class="rel-note" id="relNotice" role="status"></p>
      <div class="rel-tabs" role="tablist">
        ${tabs.map(([k, label]) => `<button type="button" class="rel-tab${R.tab === k ? " active" : ""}" data-rel-ws-tab="${k}">${label}</button>`).join("")}
      </div>
      <div id="relBody"></div>`;

    const body = document.getElementById("relBody");
    if (R.tab === "contents") renderContents(body);
    else if (R.tab === "settings") renderSettingsTab(body);
    else if (R.tab === "preview") await renderPreview(body);
    else renderActivity(body);
    window.scrollTo(0, keepScroll);
  }

  /* ============================================================
     Contents
     ============================================================ */
  function addMenuHTML() {
    return `
      <div class="rel-menu" id="relAddMenu">
        <button type="button" class="admin-newitem" data-rel="toggle-add" aria-haspopup="true">+ Add to release</button>
        <div class="rel-menu__list" id="relAddList" hidden>
          <button type="button" class="rel-menu__item" data-rel="new-note">Market Note — write new</button>
          <button type="button" class="rel-menu__item" data-rel="pick-note">Market Note — attach existing…</button>
          <button type="button" class="rel-menu__item" data-rel="new-set">Lookbook set — create new</button>
          <button type="button" class="rel-menu__item" data-rel="pick-set">Lookbook set — attach existing…</button>
          <button type="button" class="rel-menu__item" data-rel="pick-products">Products — select from inventory…</button>
          <button type="button" class="rel-menu__item" data-rel="new-update">Update — short text, optional image</button>
        </div>
      </div>`;
  }

  function chip(text, on) {
    return `<span class="rel-badge${on ? " rel-badge--on" : ""}">${esc(text)}</span>`;
  }

  function renderContents(body) {
    const d = R.data;
    const r = d.release;
    const open = r.status !== "draft";

    const notesHTML = d.notes.length ? d.notes.map(n => `
      <div class="rel-row">
        <div class="rel-row__main">
          <p class="rel-row__title">${esc(n.title || "Untitled")}</p>
          <p class="rel-row__meta">${chip(n.status === "published" ? "Published" : "Draft", n.status === "published")}
            ${n.status === "published" && !open ? " — hidden until this release is opened" : ""}</p>
        </div>
        <div class="rel-actions">
          <button type="button" class="btn" data-rel="edit-note" data-id="${esc(n.id)}">Edit</button>
          <button type="button" class="btn" data-rel="detach-note" data-id="${esc(n.id)}">Remove from release</button>
        </div>
      </div>`).join("") : `<p class="rel-note">No notes yet.</p>`;

    const setsHTML = d.studies.length ? d.studies.map((s, i) => `
      <div class="rel-row">
        <div class="rel-row__main">
          <p class="rel-row__title">${esc(s.title || "Untitled")}</p>
          <p class="rel-row__meta">${chip(s.status === "published" ? "Published" : "Draft", s.status === "published")}
            ${(s.images || []).length} image${(s.images || []).length === 1 ? "" : "s"}</p>
        </div>
        <div class="rel-actions">
          <button type="button" class="btn" data-rel="move-set" data-id="${esc(s.id)}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
          <button type="button" class="btn" data-rel="move-set" data-id="${esc(s.id)}" data-dir="1" ${i === d.studies.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
          <button type="button" class="btn" data-rel="edit-set" data-id="${esc(s.id)}">Edit</button>
          <button type="button" class="btn" data-rel="toggle-set" data-id="${esc(s.id)}">${s.status === "published" ? "Unpublish" : "Publish"}</button>
          <button type="button" class="btn" data-rel="detach-set" data-id="${esc(s.id)}">Remove from release</button>
        </div>
      </div>`).join("") : `<p class="rel-note">No lookbook sets yet.</p>`;

    const updatesHTML = d.updates.length ? d.updates.map((u, i) => `
      <div class="rel-row">
        <div class="rel-row__main">
          <p class="rel-row__title">${esc(String(u.body || "").slice(0, 140))}${String(u.body || "").length > 140 ? "…" : ""}</p>
          <p class="rel-row__meta">${chip(u.published ? "Published" : "Draft", !!u.published)}
            ${u.image_path ? " · has image" : ""} · ${esc(fmtLocal(u.created_at))}</p>
        </div>
        <div class="rel-actions">
          <button type="button" class="btn" data-rel="move-update" data-id="${esc(u.id)}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
          <button type="button" class="btn" data-rel="move-update" data-id="${esc(u.id)}" data-dir="1" ${i === d.updates.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
          <button type="button" class="btn" data-rel="edit-update" data-id="${esc(u.id)}">Edit</button>
          <button type="button" class="btn" data-rel="toggle-update" data-id="${esc(u.id)}">${u.published ? "Unpublish" : "Publish"}</button>
          <button type="button" class="btn btn--danger" data-rel="delete-update" data-id="${esc(u.id)}">Delete</button>
        </div>
      </div>`).join("") : `<p class="rel-note">No updates yet.</p>`;

    const productsHTML = d.placements.length ? d.placements.map((p, i) => {
      const pr = p.products || {};
      const hold = !(pr.state === "accepted" && pr.is_available);
      const seller = (pr.suppliers || {}).name || "—";
      return `
      <div class="rel-row">
        <div class="rel-row__main">
          <p class="rel-row__title">${i + 1}. ${esc(p.editorial_title || pr.title || "Untitled")}</p>
          <p class="rel-row__meta">${esc(pr.brand || "")} · ${esc(seller)}
            ${hold ? chip("On hold / not available", false) : ""}
            ${p.editorial_title || p.editorial_copy ? " · custom copy" : ""}</p>
        </div>
        <div class="rel-actions">
          <button type="button" class="btn" data-rel="move-product" data-id="${esc(p.id)}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
          <button type="button" class="btn" data-rel="move-product" data-id="${esc(p.id)}" data-dir="1" ${i === d.placements.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
          <button type="button" class="btn" data-rel="edit-placement" data-id="${esc(p.id)}">Edit copy / image</button>
          <button type="button" class="btn" data-rel="remove-product" data-id="${esc(p.id)}">Remove</button>
        </div>
      </div>`;
    }).join("") : `<p class="rel-note">No products selected. They stay private until the drop.</p>`;

    body.innerHTML = `
      <div class="section-bar section-bar--admin">
        <span class="section-bar__title">Contents</span>
        <span class="section-bar__action">${addMenuHTML()}</span>
      </div>
      <p class="rel-note">Public order: Market Notes, Lookbook, Updates, then the drop. Each item publishes on its own; products stay private until the drop time (see Settings).</p>
      <section class="rel-block"><div class="section-bar"><span class="section-bar__label">01</span><span class="section-bar__title">Market Notes</span></div>${notesHTML}</section>
      <section class="rel-block"><div class="section-bar"><span class="section-bar__label">02</span><span class="section-bar__title">Lookbook</span></div>${setsHTML}</section>
      <section class="rel-block"><div class="section-bar"><span class="section-bar__label">03</span><span class="section-bar__title">Updates</span></div>${updatesHTML}</section>
      <section class="rel-block"><div class="section-bar"><span class="section-bar__label">04</span><span class="section-bar__title">Products</span></div>${productsHTML}</section>`;
  }

  /* —— Reordering: swap an item with its neighbour and save the order —— */
  function swapped(list, id, dir, key) {
    const ids = list.map(x => x[key || "id"]);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return ids;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return ids;
  }

  async function moveProduct(id, dir) {
    await A().reorderPlacements(swapped(R.data.placements, id, dir));
    await renderWorkspace();
  }

  async function moveUpdate(id, dir) {
    await A().reorderFolderUpdates(swapped(R.data.updates, id, dir));
    await renderWorkspace();
  }

  async function moveSet(id, dir) {
    const ids = swapped(R.data.studies, id, dir);
    for (let i = 0; i < ids.length; i++) {
      const s = studyState.studies.find(x => x.id === ids[i]);
      if (!s) continue;
      s.releaseOrder = i;
      await D().upsertStudy(s);
    }
    await renderWorkspace();
  }

  /* —— Attachments —— */
  async function setNoteFolder(noteId, folderId) {
    const note = noteState.notes.find(n => n.id === noteId);
    if (!note) return;
    note.folderId = folderId;
    await D().upsertNote(note);
  }

  async function setSetFolder(setId, folderId) {
    const s = studyState.studies.find(x => x.id === setId);
    if (!s) return;
    s.relatedDropId = folderId;
    await D().upsertStudy(s);
  }

  async function detachNote(id) {
    const n = noteState.notes.find(x => x.id === id);
    const published = n && n.status === "published";
    const msg = published
      ? "Remove this note from the release? It is published, so it will stay public in the Inbox as a standalone note."
      : "Remove this note from the release? The note itself is kept.";
    if (!confirm(msg)) return;
    await setNoteFolder(id, "");
    await logEvent("note_removed", { title: n && n.title });
    await renderWorkspace();
  }

  async function detachSet(id) {
    const s = studyState.studies.find(x => x.id === id);
    const published = s && s.status === "published";
    const msg = published
      ? "Remove this lookbook set from the release? It is published, so it will stay public in the Lookbook."
      : "Remove this lookbook set from the release? The set itself is kept.";
    if (!confirm(msg)) return;
    await setSetFolder(id, "");
    await logEvent("set_removed", { title: s && s.title });
    await renderWorkspace();
  }

  async function toggleSet(id) {
    const s = studyState.studies.find(x => x.id === id);
    if (!s) return;
    s.status = s.status === "published" ? "draft" : "published";
    await D().upsertStudy(s);
    await logEvent(s.status === "published" ? "set_published" : "set_unpublished", { title: s.title });
    await renderWorkspace();
  }

  async function toggleUpdate(id) {
    const u = R.data.updates.find(x => x.id === id);
    if (!u) return;
    await A().updateFolderUpdate(id, { published: !u.published });
    await logEvent(!u.published ? "update_published" : "update_unpublished", { id });
    await renderWorkspace();
  }

  async function deleteUpdate(id) {
    const u = R.data.updates.find(x => x.id === id);
    if (!u || !confirm("Delete this update permanently?")) return;
    await A().deleteFolderUpdate(id);
    if (u.image_path) await D().deleteNoteMedia(A().noteMediaUrl(u.image_path));
    await renderWorkspace();
  }

  async function removeProduct(id) {
    if (!confirm("Remove this product from the release? The product stays in inventory.")) return;
    await A().removePlacement(id);
    await logEvent("product_removed", { placement: id });
    // Keep positions contiguous.
    const rest = R.data.placements.filter(p => p.id !== id).map(p => p.id);
    await A().reorderPlacements(rest);
    await renderWorkspace();
  }

  /* ============================================================
     Modals
     ============================================================ */
  function openModalHTML(title, bodyHTML, footHTML) {
    modalContent.innerHTML = `
      <div class="modal-head">
        <h2 class="modal-title">${esc(title)}</h2>
        <button type="button" class="modal-close" data-rel="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">${bodyHTML}</div>
      <div class="modal-foot">${footHTML || ""}</div>`;
    modalOverlay.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeRelModal() {
    R.modal = null;
    closeModal();
  }

  /* —— Update (text + optional image) —— */
  function openUpdateModal(id) {
    const existing = id ? R.data.updates.find(u => u.id === id) : null;
    R.modal = {
      kind: "update",
      id: existing ? existing.id : null,
      imagePath: existing ? (existing.image_path || "") : "",
      oldImagePath: existing ? (existing.image_path || "") : "",
      newFile: null
    };
    openModalHTML(existing ? "Edit update" : "New update", `
      <form id="relUpdateForm" novalidate>
        <div class="field field--full">
          <label for="relUpdateBody">Update</label>
          <textarea id="relUpdateBody" rows="5" placeholder="A line or two for this release's folder.">${esc(existing ? existing.body : "")}</textarea>
        </div>
        <div class="field field--full">
          <label>Image (optional)</label>
          <div id="relUpdateImage"></div>
          <input type="file" id="relUpdateFile" accept="image/*" data-rel-file="update-image" />
        </div>
        <div class="field field--check">
          <input type="checkbox" id="relUpdatePublished" ${existing && existing.published ? "checked" : ""} />
          <label for="relUpdatePublished">Published (visible once the release is open)</label>
        </div>
        <p class="field-error" id="relModalError" hidden></p>
      </form>`,
      `<button type="button" class="btn" data-rel="close-modal">Cancel</button>
       <button type="button" class="btn btn--primary" data-rel="save-update">Save update</button>`);
    drawUpdateImage();
  }

  function drawUpdateImage() {
    const m = R.modal;
    const el = document.getElementById("relUpdateImage");
    if (!el) return;
    const url = m.newFile ? URL.createObjectURL(m.newFile) : (m.imagePath ? A().noteMediaUrl(m.imagePath) : "");
    el.innerHTML = url
      ? `<div class="rel-img" style="max-width:200px;margin-bottom:8px;"><img src="${esc(url)}" alt="" />
           <button type="button" class="btn" data-rel="remove-update-image" style="margin-top:6px;">Remove image</button></div>`
      : `<p class="rel-note">No image.</p>`;
  }

  function modalError(message) {
    const el = document.getElementById("relModalError");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  }

  async function saveUpdate() {
    const m = R.modal;
    const body = document.getElementById("relUpdateBody").value.trim();
    if (!body) { modalError("Write something for the update."); return; }
    const published = document.getElementById("relUpdatePublished").checked;
    try {
      let imagePath = m.imagePath;
      if (m.newFile) imagePath = A().noteMediaPath(await uploadImageFile(m.newFile));
      const releaseId = R.data.release.id;
      if (m.id) {
        await A().updateFolderUpdate(m.id, { body, published, image_path: imagePath || null });
      } else {
        const created = await A().createFolderUpdate(releaseId, body);
        await A().updateFolderUpdate(created.id, { published, image_path: imagePath || null });
      }
      // Replaced or removed an image: tidy the old file (best effort).
      if (m.oldImagePath && m.oldImagePath !== imagePath) {
        await D().deleteNoteMedia(A().noteMediaUrl(m.oldImagePath));
      }
    } catch (e) { modalError(e.message || "Could not save the update."); return; }
    closeRelModal();
    await renderWorkspace();
  }

  /* —— Lookbook set (title, images, captions, cover, order, publish) —— */
  function openSetModal(id) {
    const existing = id ? studyState.studies.find(s => s.id === id) : null;
    R.modal = {
      kind: "set",
      set: existing
        ? structuredClone(existing)
        : {
            id: "", title: "", framing: "", date: new Date().toISOString().slice(0, 10),
            status: "draft", coverImage: "", images: [], captions: [],
            relatedNoteId: "", relatedDropId: R.data.release.id, studyNumber: ""
          },
      uploading: ""
    };
    drawSetModal();
  }

  function drawSetModal() {
    const m = R.modal;
    const s = m.set;
    const imgs = (s.images || []).map((url, i) => `
      <div class="rel-img${s.coverImage === url ? " rel-img--cover" : ""}">
        <img src="${esc(url)}" alt="" />
        <input type="text" data-rel-caption="${i}" value="${esc((s.captions || [])[i] || "")}" placeholder="Caption" style="width:100%;margin:6px 0;" />
        <div class="rel-actions">
          <button type="button" class="btn" data-rel="set-img-move" data-i="${i}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Move earlier">←</button>
          <button type="button" class="btn" data-rel="set-img-move" data-i="${i}" data-dir="1" ${i === s.images.length - 1 ? "disabled" : ""} aria-label="Move later">→</button>
          <button type="button" class="btn" data-rel="set-img-cover" data-i="${i}">${s.coverImage === url ? "Cover ✓" : "Make cover"}</button>
          <label class="btn" style="cursor:pointer;">Replace<input type="file" accept="image/*" hidden data-rel-file="set-img-replace" data-i="${i}" /></label>
          <button type="button" class="btn" data-rel="set-img-remove" data-i="${i}">Remove</button>
        </div>
      </div>`).join("");

    openModalHTML(s.id ? "Edit lookbook set" : "New lookbook set", `
      <form id="relSetForm" novalidate>
        <div class="field-grid">
          <div class="field field--full"><label for="relSetTitle">Title</label>
            <input id="relSetTitle" type="text" value="${esc(s.title)}" /></div>
          <div class="field field--full"><label for="relSetFraming">Framing (one sentence)</label>
            <textarea id="relSetFraming" rows="2">${esc(s.framing)}</textarea></div>
          <div class="field"><label for="relSetStatus">Status</label>
            <select id="relSetStatus"><option value="draft"${s.status !== "published" ? " selected" : ""}>Draft — private</option>
              <option value="published"${s.status === "published" ? " selected" : ""}>Published</option></select></div>
        </div>
        <div class="field field--full">
          <label>Images</label>
          <label class="upload-dropzone" for="relSetFiles"><span>＋ Add images</span>
            <input type="file" id="relSetFiles" accept="image/*" multiple hidden data-rel-file="set-add" /></label>
          <p class="rel-note" id="relSetUploading">${esc(m.uploading)}</p>
          <div class="rel-img-grid" id="relSetImages">${imgs || `<p class="rel-note">No images yet.</p>`}</div>
        </div>
        <p class="field-error" id="relModalError" hidden></p>
      </form>`,
      `<button type="button" class="btn" data-rel="close-modal">Cancel</button>
       <button type="button" class="btn btn--primary" data-rel="save-set">Save set</button>`);
  }

  // Keep typed values when the image list redraws the modal.
  function syncSetFields() {
    const m = R.modal;
    if (!m || m.kind !== "set") return;
    const val = id => { const el = document.getElementById(id); return el ? el.value : null; };
    const s = m.set;
    const t = val("relSetTitle"); if (t !== null) s.title = t;
    const f = val("relSetFraming"); if (f !== null) s.framing = f;
    const st = val("relSetStatus"); if (st !== null) s.status = st;
    document.querySelectorAll("[data-rel-caption]").forEach(el => {
      s.captions[Number(el.dataset.relCaption)] = el.value;
    });
  }

  async function addSetImages(files) {
    const m = R.modal;
    syncSetFields();
    const list = Array.from(files);
    for (let i = 0; i < list.length; i++) {
      m.uploading = `Uploading ${i + 1} of ${list.length}…`;
      const note = document.getElementById("relSetUploading");
      if (note) note.textContent = m.uploading;
      try {
        const url = await uploadImageFile(list[i]);
        m.set.images.push(url);
        m.set.captions.push("");
        if (!m.set.coverImage) m.set.coverImage = url;
      } catch (e) {
        m.uploading = e.message || "Upload failed.";
        drawSetModal();
        return;
      }
    }
    m.uploading = "";
    drawSetModal();
  }

  async function replaceSetImage(index, file) {
    const m = R.modal;
    syncSetFields();
    try {
      const url = await uploadImageFile(file);
      const old = m.set.images[index];
      m.set.images[index] = url;
      if (m.set.coverImage === old) m.set.coverImage = url;
    } catch (e) { m.uploading = e.message || "Upload failed."; }
    drawSetModal();
  }

  function moveSetImage(index, dir) {
    const m = R.modal;
    syncSetFields();
    const j = index + dir;
    const s = m.set;
    if (j < 0 || j >= s.images.length) return;
    [s.images[index], s.images[j]] = [s.images[j], s.images[index]];
    [s.captions[index], s.captions[j]] = [s.captions[j], s.captions[index]];
    drawSetModal();
  }

  async function saveSet() {
    syncSetFields();
    const s = R.modal.set;
    if (!String(s.title).trim()) { modalError("A lookbook set needs a title."); return; }
    if (!s.id) s.id = genId("study");
    s.relatedDropId = R.data.release.id;
    if (s.releaseOrder === undefined) s.releaseOrder = R.data.studies.length;
    if (!s.coverImage && s.images.length) s.coverImage = s.images[0];
    s.captions = (s.captions || []).slice(0, s.images.length);
    try {
      await D().upsertStudy(s);
    } catch (e) { modalError(e.message || "Could not save the set."); return; }
    const idx = studyState.studies.findIndex(x => x.id === s.id);
    if (idx >= 0) studyState.studies[idx] = s; else studyState.studies.unshift(s);
    closeRelModal();
    await renderWorkspace();
  }

  /* —— Existing note / set pickers —— */
  function openNotePicker() {
    R.modal = { kind: "picker" };
    const id = R.data.release.id;
    const open = R.data.release.status !== "draft";
    const rows = noteState.notes.filter(n => n.folderId !== id).map(n => {
      const other = n.folderId ? "In another release — attaching moves it" : "Standalone";
      return `
        <div class="rel-row">
          <div class="rel-row__main">
            <p class="rel-row__title">${esc(n.title || "Untitled")}</p>
            <p class="rel-row__meta">${chip(n.status === "published" ? "Published" : "Draft", n.status === "published")} ${esc(other)}</p>
          </div>
          <button type="button" class="btn" data-rel="attach-note" data-id="${esc(n.id)}">Attach</button>
        </div>`;
    }).join("") || `<p class="rel-note">No other notes. Write a new one instead.</p>`;
    openModalHTML("Attach an existing note", `
      ${open ? "" : `<p class="rel-note">This release is still a draft: a published note you attach stays hidden from the public until the release is opened.</p>`}
      ${rows}`, `<button type="button" class="btn" data-rel="close-modal">Close</button>`);
  }

  function openSetPicker() {
    R.modal = { kind: "picker" };
    const id = R.data.release.id;
    const rows = studyState.studies.filter(s => s.relatedDropId !== id).map(s => `
      <div class="rel-row">
        <div class="rel-row__main">
          <p class="rel-row__title">${esc(s.title || "Untitled")}</p>
          <p class="rel-row__meta">${chip(s.status === "published" ? "Published" : "Draft", s.status === "published")}
            ${(s.images || []).length} images · ${s.relatedDropId ? "In another release — attaching moves it" : "Standalone"}</p>
        </div>
        <button type="button" class="btn" data-rel="attach-set" data-id="${esc(s.id)}">Attach</button>
      </div>`).join("") || `<p class="rel-note">No other lookbook sets. Create a new one instead.</p>`;
    openModalHTML("Attach an existing lookbook set", rows, `<button type="button" class="btn" data-rel="close-modal">Close</button>`);
  }

  async function attachNote(id) {
    await setNoteFolder(id, R.data.release.id);
    await logEvent("note_attached", { id });
    closeRelModal();
    await renderWorkspace();
  }

  async function attachSet(id) {
    const s = studyState.studies.find(x => x.id === id);
    if (s && s.releaseOrder === undefined) s.releaseOrder = R.data.studies.length;
    await setSetFolder(id, R.data.release.id);
    await logEvent("set_attached", { id });
    closeRelModal();
    await renderWorkspace();
  }

  /* —— Products picker (accepted supplier products only) —— */
  async function openProductPicker() {
    R.modal = { kind: "picker" };
    openModalHTML("Select products", `<p class="rel-note">Loading accepted products…</p>`,
      `<button type="button" class="btn" data-rel="close-modal">Close</button>`);
    let accepted;
    try { accepted = await A().getAcceptedProducts(); }
    catch (e) { modalError(e.message); return; }
    const placed = new Set(R.data.placements.map(p => p.product_id));
    const rows = accepted.filter(p => !placed.has(p.id)).map(p => `
      <div class="rel-row">
        <div class="rel-row__main">
          <p class="rel-row__title">${esc(p.title || "Untitled")}</p>
          <p class="rel-row__meta">${esc(p.brand || "")} · ${esc((p.suppliers || {}).name || "—")}
            ${p.is_available ? "" : chip("On hold", false)}
            ${p.price_cents != null ? " · $" + (p.price_cents / 100).toFixed(0) : ""}</p>
        </div>
        <button type="button" class="btn" data-rel="add-product" data-id="${esc(p.id)}">Add</button>
      </div>`).join("") || `<p class="rel-note">Nothing accepted and unplaced. Accept products in Supply → Review Queue first.</p>`;
    openModalHTML("Select products", `
      <p class="rel-note">Only accepted products can be selected. Selecting a product does not publish it — the release's drop time does.</p>${rows}`,
      `<button type="button" class="btn" data-rel="close-modal">Close</button>`);
  }

  async function addProduct(productId) {
    try {
      await A().addPlacement(R.data.release.id, productId);
      await logEvent("product_added", { product: productId });
    } catch (e) { modalError(e.message || "Could not add that product."); return; }
    await loadWorkspace(R.data.release.id);
    openProductPicker();
  }

  /* —— Placement: editorial copy and hero image —— */
  function openPlacementModal(id) {
    const p = R.data.placements.find(x => x.id === id);
    if (!p) return;
    const pr = p.products || {};
    const images = (pr.product_images || []).slice().sort((a, b) => a.position - b.position);
    R.modal = { kind: "placement", id, hero: p.hero_image_id || "" };
    const grid = images.length ? images.map(im => `
      <label class="rel-img${p.hero_image_id === im.id ? " rel-img--cover" : ""}">
        <img src="${esc(A().productImageUrl(im.path))}" alt="" />
        <span><input type="radio" name="relHero" value="${esc(im.id)}" ${p.hero_image_id === im.id ? "checked" : ""} /> Hero</span>
      </label>`).join("") : `<p class="rel-note">This product has no photos.</p>`;
    openModalHTML("Edit copy and hero image", `
      <p class="rel-note">The seller wrote: “${esc(pr.title || "")}”. Leave a field empty to use the seller's own text.</p>
      <div class="field field--full"><label for="relPlTitle">Editorial title</label>
        <input id="relPlTitle" type="text" value="${esc(p.editorial_title || "")}" /></div>
      <div class="field field--full"><label for="relPlCopy">Editorial copy</label>
        <textarea id="relPlCopy" rows="4">${esc(p.editorial_copy || "")}</textarea></div>
      <div class="field field--full"><label>Hero image</label>
        <div class="rel-img-grid">${grid}</div>
        ${images.length ? `<button type="button" class="btn" data-rel="clear-hero" style="margin-top:8px;">Use the first photo</button>` : ""}</div>
      <p class="field-error" id="relModalError" hidden></p>`,
      `<button type="button" class="btn" data-rel="close-modal">Cancel</button>
       <button type="button" class="btn btn--primary" data-rel="save-placement">Save</button>`);
  }

  async function savePlacement() {
    const m = R.modal;
    const picked = document.querySelector('input[name="relHero"]:checked');
    try {
      await A().updatePlacement(m.id, {
        editorial_title: document.getElementById("relPlTitle").value.trim(),
        editorial_copy: document.getElementById("relPlCopy").value.trim(),
        hero_image_id: picked ? picked.value : (m.hero || "")
      });
    } catch (e) { modalError(e.message || "Could not save."); return; }
    closeRelModal();
    await renderWorkspace();
  }

  /* ============================================================
     Settings tab: details, visibility, drop schedule, readiness
     ============================================================ */
  function zoneSelectHTML(selected) {
    const z = T() ? T().zoneList() : { common: ["UTC"], rest: [] };
    const opt = name => `<option value="${esc(name)}"${name === selected ? " selected" : ""}>${esc(name.replace(/_/g, " "))}</option>`;
    return `<select id="relTz">
      <optgroup label="Common">${z.common.map(opt).join("")}</optgroup>
      ${z.rest.length ? `<optgroup label="All timezones">${z.rest.map(opt).join("")}</optgroup>` : ""}
    </select>`;
  }

  function readinessItems(d) {
    const r = d.release;
    const products = d.placements;
    const held = products.filter(p => { const pr = p.products || {}; return !(pr.state === "accepted" && pr.is_available); }).length;
    const due = r.publish_at ? Date.parse(r.publish_at) : NaN;
    return [
      { ok: r.number != null, required: true, text: "Release number set" },
      { ok: !!String(r.title || "").trim(), required: true, text: "Title set" },
      { ok: products.length > 0, required: true, text: `At least one product selected (${products.length})` },
      { ok: held === 0, required: false, text: held ? `${held} selected product${held === 1 ? " is" : "s are"} on hold or unavailable` : "All selected products are available" },
      { key: "drop", ok: Number.isFinite(due) || !!r.launched_at, required: true, text: "Drop time set" },
      { ok: !!String(r.standfirst || "").trim(), required: false, text: "Introduction written" },
      { ok: !!r.cover_image, required: false, text: "Cover image added" }
    ];
  }

  // Required items that must hold before scheduling or launching. The drop
  // time itself is excluded: it is what scheduling sets.
  function readyToSchedule(d) {
    return readinessItems(d).filter(c => c.required && c.key !== "drop").every(c => c.ok);
  }

  function launchStatusHTML(d) {
    const r = d.release;
    const zone = r.drop_timezone || (T() ? T().browserZone() : "UTC");
    const st = stateOf(r);
    if (r.status === "archived") return `<p class="rel-note"><strong>Archived.</strong> Not in Shop.</p>`;
    if (r.launched_at) {
      return `<p class="rel-note"><strong>Launched manually</strong> ${esc(fmtZone(r.launched_at, zone))}. ${d.shopId === r.id ? "In Shop now." : "Since replaced in Shop by a newer drop."}</p>`;
    }
    if (st.key === "dropped") {
      return `<p class="rel-note"><strong>Dropped</strong> ${esc(fmtZone(r.publish_at, zone))}. ${d.shopId === r.id ? "Its products are in Shop now." : "Since replaced in Shop by a newer drop."}</p>`;
    }
    if (st.key === "scheduled") {
      const ms = Date.parse(r.publish_at) - Date.now();
      const hrs = Math.max(0, Math.floor(ms / 3600000));
      const when = hrs >= 48 ? `${Math.floor(hrs / 24)} days` : `${hrs}h ${Math.max(0, Math.floor((ms % 3600000) / 60000))}m`;
      return `<p class="rel-note"><strong>Scheduled</strong> for ${esc(fmtZone(r.publish_at, zone))} (in ${when}). Its products will appear in Shop automatically at that moment — no further action. Shop currently shows ${d.shop ? esc(releaseLabel(d.shop)) : "no release"}.</p>`;
    }
    return `<p class="rel-note"><strong>Not scheduled.</strong> Nothing from this release's products is public. Set a drop time below.</p>`;
  }

  function renderSettingsTab(body) {
    const d = R.data;
    const r = d.release;
    const st = stateOf(r);
    const zone = r.drop_timezone || (T() ? T().browserZone() : "UTC");
    const localValue = r.publish_at && T() ? T().utcToZonedLocal(r.publish_at, zone) : "";
    const checks = readinessItems(d);
    const requiredOk = readyToSchedule(d);
    const dropped = st.dropped;
    const canSchedule = requiredOk && r.status !== "archived" && !dropped;

    body.innerHTML = `
      <section class="rel-block">
        <div class="section-bar"><span class="section-bar__title">Release details</span></div>
        <form class="form-card" id="relDetailsForm" novalidate>
          <div class="field-grid">
            ${textField("Release number", "number", r.number ?? "", { id: "relNumber", type: "number" })}
            ${textField("Title", "title", r.title || "", { id: "relTitle", full: true })}
            <div class="field field--full"><label for="relStandfirst">Introduction</label>
              <textarea id="relStandfirst" rows="3">${esc(r.standfirst || "")}</textarea></div>
          </div>
          <div class="field field--full">
            <label>Cover image</label>
            ${r.cover_image ? `<div class="rel-img" style="max-width:220px;margin-bottom:8px;"><img src="${esc(r.cover_image)}" alt="" /></div>` : `<p class="rel-note">No cover image.</p>`}
            <input type="file" accept="image/*" data-rel-file="cover" />
            ${r.cover_image ? `<button type="button" class="btn" data-rel="remove-cover" style="margin-top:8px;">Remove cover</button>` : ""}
          </div>
          <button type="button" class="btn btn--primary" data-rel="save-details">Save details</button>
        </form>
      </section>

      <section class="rel-block">
        <div class="section-bar"><span class="section-bar__title">Editorial visibility</span></div>
        <p class="rel-note">Opening a release makes its page public so published notes, lookbook sets and updates can appear as you add them. It does <strong>not</strong> publish products, and each item still needs its own Publish.</p>
        <div class="rel-actions" style="margin-top:10px;">
          ${r.status === "draft"
            ? `<button type="button" class="btn btn--primary" data-rel="open-release">Open release to the public</button>`
            : (r.status !== "archived" && !r.publish_at && !r.launched_at
                ? `<button type="button" class="btn" data-rel="to-draft">Return to draft (private)</button>` : "")}
          ${r.status !== "archived" ? `<button type="button" class="btn" data-rel="archive">Archive release</button>` : `<button type="button" class="btn" data-rel="unarchive">Reopen from archive</button>`}
          ${r.is_working ? "" : `<button type="button" class="btn" data-rel="make-working">Make this the working release</button>`}
        </div>
      </section>

      <section class="rel-block">
        <div class="section-bar"><span class="section-bar__title">Product drop</span></div>
        ${launchStatusHTML(d)}
        <ul class="rel-check">${checks.map(c => `<li class="${c.ok ? "ok" : ""}">${esc(c.text)}${c.required ? "" : " (recommended)"}</li>`).join("")}</ul>
        ${dropped ? "" : `
        <div class="field-grid" style="margin-top:12px;">
          <div class="field"><label for="relDropAt">Drop date and time</label>
            <input type="datetime-local" id="relDropAt" value="${esc(localValue)}" /></div>
          <div class="field"><label for="relTz">Timezone</label>${zoneSelectHTML(zone)}</div>
        </div>
        <p class="rel-note">Entered in the timezone above and stored as UTC. Visitors see it in this same timezone. The database opens the drop at that moment; nothing needs to be done on the day.</p>
        <div class="rel-actions" style="margin-top:10px;">
          <button type="button" class="btn btn--primary" data-rel="schedule-drop" ${canSchedule ? "" : "disabled"}>${r.publish_at ? "Reschedule drop" : "Schedule drop"}</button>
          ${r.publish_at ? `<button type="button" class="btn" data-rel="cancel-drop">Cancel scheduled drop</button>` : ""}
          <button type="button" class="btn btn--danger" data-rel="launch-now" ${requiredOk && r.status !== "archived" ? "" : "disabled"}>Launch now (manual)</button>
        </div>
        ${canSchedule ? "" : `<p class="rel-note">Complete the required items above to schedule or launch.</p>`}`}
      </section>`;
  }

  async function saveDetails(extra) {
    const r = R.data.release;
    const numberRaw = document.getElementById("relNumber").value.trim();
    const number = numberRaw === "" ? null : Number(numberRaw);
    if (numberRaw !== "" && (!Number.isInteger(number) || number < 1)) {
      setNotice("Release number must be a whole number, 1 or higher.", true); return;
    }
    const title = document.getElementById("relTitle").value.trim();
    if (!title) { setNotice("A release needs a title.", true); return; }
    try {
      await A().updateRelease(r.id, {
        number, title,
        standfirst: document.getElementById("relStandfirst").value.trim(),
        ...(extra || {})
      });
      await logEvent("details_saved", { number, title });
    } catch (e) { setNotice(e.message || "Could not save.", true); return; }
    await renderWorkspace();
    setNotice("Saved.");
  }

  async function setStatus(status, event) {
    try {
      await A().updateRelease(R.data.release.id, { status });
      await logEvent(event, {});
    } catch (e) { setNotice(e.message || "Could not change the release.", true); return; }
    await renderWorkspace();
  }

  async function scheduleDrop() {
    const r = R.data.release;
    const zone = document.getElementById("relTz").value;
    const local = document.getElementById("relDropAt").value;
    const conv = T() ? T().zonedLocalToUtc(local, zone) : { ok: false, error: "Timezone helper not loaded." };
    if (!conv.ok) { setNotice(conv.error, true); return; }
    if (Date.parse(conv.iso) < Date.now() + 60000) {
      setNotice("Pick a time at least a minute from now. To go live immediately use Launch now.", true);
      return;
    }
    if (!readyToSchedule(R.data)) {
      setNotice("Complete the required items first.", true); return;
    }
    const previous = r.publish_at;
    try {
      // Scheduling also opens the release page (a draft can't have a drop).
      await A().updateRelease(r.id, {
        status: r.status === "draft" ? "scheduled" : r.status,
        publish_at: conv.iso,
        drop_timezone: zone
      });
      await logEvent(previous ? "drop_rescheduled" : "drop_scheduled", { publish_at: conv.iso, timezone: zone, previous });
    } catch (e) { setNotice(e.message || "Could not schedule the drop.", true); return; }
    await renderWorkspace();
    setNotice(`Drop ${previous ? "rescheduled" : "scheduled"} for ${fmtZone(conv.iso, zone)}.`);
  }

  async function cancelDrop() {
    const r = R.data.release;
    if (!confirm("Cancel the scheduled drop? Products stay private until you schedule another time.")) return;
    try {
      await A().updateRelease(r.id, { publish_at: null, drop_timezone: null });
      await logEvent("drop_cancelled", { was: r.publish_at });
    } catch (e) { setNotice(e.message || "Could not cancel.", true); return; }
    await renderWorkspace();
    setNotice("Drop cancelled.");
  }

  async function launchNow() {
    const r = R.data.release;
    if (!confirm(`Launch ${releaseLabel(r)} now? Its products go live in Shop immediately and replace the current drop.`)) return;
    try {
      await A().updateRelease(r.id, { status: "live", launched_at: new Date().toISOString() });
      await logEvent("launched_manually", {});
    } catch (e) { setNotice(e.message || "Could not launch.", true); return; }
    await renderWorkspace();
    setNotice("Launched.");
  }

  async function makeWorking() {
    try {
      await A().setWorkingRelease(R.data.release.id);
      await logEvent("working_set", {});
    } catch (e) { setNotice(e.message || "Could not change the working release.", true); return; }
    await renderWorkspace();
  }

  async function uploadCover(file) {
    try {
      const url = await uploadImageFile(file);
      await A().updateRelease(R.data.release.id, { cover_image: url });
    } catch (e) { setNotice(e.message || "Could not upload the cover.", true); return; }
    await renderWorkspace();
  }

  /* ============================================================
     Preview tab. "Private" shows everything attached (drafts flagged,
     products before the drop) using only the signed-in admin's data — it is
     rendered here and exposes nothing publicly. "Public now" renders through
     the same public readers visitors use, so it is exactly what they see.
     ============================================================ */
  function previewProducts(placements) {
    return placements.map(p => {
      const pr = p.products || {};
      const live = pr.state === "accepted" && pr.is_available;
      const images = (pr.product_images || []).slice().sort((a, b) =>
        ((b.id === p.hero_image_id) - (a.id === p.hero_image_id)) || (a.position - b.position));
      const sup = pr.suppliers || {};
      return {
        title: p.editorial_title || pr.title,
        brand: pr.brand,
        price_cents: pr.price_cents,
        currency: pr.currency,
        availability: live ? (pr.quantity > 0 ? "available" : "sold") : "unavailable",
        image_paths: live ? images.map(i => i.path) : [],
        supplier_name: sup.type === "consignor" ? null : sup.name,
        supplier_type: sup.type
      };
    });
  }

  async function renderPreview(body) {
    const d = R.data;
    const r = d.release;
    body.innerHTML = `
      <div class="rel-actions" style="margin-bottom:12px;">
        <button type="button" class="btn${R.previewMode === "private" ? " btn--primary" : ""}" data-rel="preview-mode" data-mode="private">Private preview (everything attached)</button>
        <button type="button" class="btn${R.previewMode === "public" ? " btn--primary" : ""}" data-rel="preview-mode" data-mode="public">What's public now</button>
      </div>
      <div class="rel-preview" id="relPreviewMount"><p class="rel-note">Loading preview…</p></div>`;
    const mount = document.getElementById("relPreviewMount");
    if (!window.PodaFolders) { mount.innerHTML = `<p class="rel-note">Preview unavailable (folders.js not loaded).</p>`; return; }

    if (R.previewMode === "private") {
      const folder = { ...r, drop_open: false, is_shop: false };
      const content = {
        notes: d.notes,
        studies: d.studies,
        updates: d.updates,
        products: previewProducts(d.placements)
      };
      window.PodaFolders.renderFolder(mount, folder, content, { preview: true });
      return;
    }

    try {
      const folder = await A().getPublicFolder(r.id);
      if (!folder) {
        mount.innerHTML = `<p class="rel-note"><strong>Nothing is public for this release.</strong> It is a draft, so visitors cannot reach it. Shop currently shows ${d.shop ? esc(releaseLabel(d.shop)) : "no release"}.</p>`;
        return;
      }
      const content = await A().getPublicFolderContent(r.id);
      window.PodaFolders.renderFolder(mount, folder, content, {});
    } catch (e) {
      mount.innerHTML = `<p class="rel-note">Could not load the public view: ${esc(e.message || e)}</p>`;
    }
  }

  /* ============================================================
     Activity tab
     ============================================================ */
  const EVENT_TEXT = {
    created: "Release created", details_saved: "Details saved",
    opened: "Opened to the public", returned_to_draft: "Returned to draft",
    drop_scheduled: "Drop scheduled", drop_rescheduled: "Drop rescheduled", drop_cancelled: "Drop cancelled",
    launched_manually: "Launched manually", archived: "Archived", unarchived: "Reopened from archive",
    working_set: "Made the working release",
    product_added: "Product added", product_removed: "Product removed",
    note_attached: "Note attached", note_removed: "Note removed",
    set_attached: "Lookbook set attached", set_removed: "Lookbook set removed",
    set_published: "Lookbook set published", set_unpublished: "Lookbook set unpublished",
    update_published: "Update published", update_unpublished: "Update unpublished"
  };

  async function renderActivity(body) {
    const r = R.data.release;
    body.innerHTML = `<p class="rel-note">Loading activity…</p>`;
    const events = await A().getReleaseEvents(r.id);
    const zone = r.drop_timezone || (T() ? T().browserZone() : "UTC");
    const lines = [];
    // Derived lines: the drop itself is not an event row (the database opens
    // it by the clock), so show it from the schedule.
    if (r.publish_at && Date.parse(r.publish_at) <= Date.now() && !r.launched_at) {
      lines.push({ at: r.publish_at, text: `Drop opened automatically (${fmtZone(r.publish_at, zone)})` });
    }
    if (r.launched_at) lines.push({ at: r.launched_at, text: "Launched manually" });
    events.forEach(e => {
      let extra = "";
      if (e.detail && e.detail.publish_at) extra = ` — ${fmtZone(e.detail.publish_at, e.detail.timezone || zone)}`;
      lines.push({ at: e.created_at, text: (EVENT_TEXT[e.event] || e.event) + extra });
    });
    lines.push({ at: r.created_at, text: "Release record created" });
    lines.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    body.innerHTML = `
      <div class="section-bar"><span class="section-bar__title">Activity</span></div>
      ${lines.map(l => `<div class="rel-row"><div class="rel-row__main"><p class="rel-row__title">${esc(l.text)}</p>
        <p class="rel-row__meta">${esc(fmtLocal(l.at))}</p></div></div>`).join("")}
      <p class="rel-note">Publishing a release or launching a drop never sends email. Emailing a note is a separate, manual action (Subscribers → Notes &amp; email).</p>`;
  }

  /* ============================================================
     All Releases
     ============================================================ */
  async function renderAll() {
    hideTabs();
    bindOnce();
    adminMain.innerHTML = `<p class="admin-empty">Loading…</p>`;
    let edits, publicList;
    try {
      [edits, publicList] = await Promise.all([A().getEdits(), A().getPublicFolders().catch(() => [])]);
    } catch (e) {
      if (isSchemaError(e)) { migrationNeeded(e); return; }
      adminMain.innerHTML = `<p class="admin-empty">Could not load releases: ${esc(e.message || e)}</p>`;
      return;
    }
    const pubById = Object.fromEntries(publicList.map(f => [f.id, f]));
    const nextNumber = edits.reduce((m, e) => Math.max(m, e.number || 0), 0) + 1;

    const rowHTML = e => {
      const st = stateOf(e);
      const pub = pubById[e.id];
      const inShop = pub && pub.is_shop;
      const zone = e.drop_timezone;
      return `
        <div class="rel-row">
          <div class="rel-row__main">
            <p class="rel-row__title">${esc(releaseLabel(e))} — ${esc(e.title || "Untitled")}</p>
            <p class="rel-row__meta">
              ${e.is_working ? chip("Working", true) : ""} ${inShop ? chip("In Shop now", true) : ""} ${chip(st.label, st.key !== "draft")}
              ${e.publish_at && !e.launched_at ? " · drop " + esc(fmtZone(e.publish_at, zone)) : ""}
            </p>
          </div>
          <div class="rel-actions">
            <button type="button" class="btn" data-rel="open-release-id" data-id="${esc(e.id)}">${e.is_working ? "Open workspace" : "Work on this"}</button>
            ${e.status !== "archived" ? `<button type="button" class="btn" data-rel="archive-id" data-id="${esc(e.id)}">Archive</button>` : ""}
          </div>
        </div>`;
    };
    const group = (title, list) => `
      <section class="rel-block"><div class="section-bar"><span class="section-bar__title">${title}</span></div>
      ${list.length ? list.map(rowHTML).join("") : `<p class="rel-note">None.</p>`}</section>`;

    const inProgress = edits.filter(e => e.status !== "archived" && !stateOf(e).dropped);
    const dropped = edits.filter(e => e.status !== "archived" && stateOf(e).dropped);
    const archived = edits.filter(e => e.status === "archived");

    adminMain.innerHTML = `
      <div class="section-bar section-bar--admin"><span class="section-bar__label">Releases</span>
        <span class="section-bar__title">All Releases</span></div>
      <p class="rel-note">One release is the <strong>working release</strong> — the one you are preparing, opened by default after sign-in. It is separate from the release currently in Shop.</p>
      ${group("In progress", inProgress)}
      ${group("Dropped", dropped)}
      ${group("Archived", archived)}
      <section class="rel-block"><div class="section-bar"><span class="section-bar__title">New release</span></div>
        ${newReleaseFormHTML(nextNumber)}</section>`;
  }

  async function openReleaseById(id) {
    try { await A().setWorkingRelease(id); }
    catch (e) { alert(e.message || "Could not switch the working release."); return; }
    R.tab = "contents";
    setView("release");
  }

  async function archiveById(id) {
    if (!confirm("Archive this release? It leaves Shop and moves to the Archive. Nothing is deleted.")) return;
    try {
      await A().updateRelease(id, { status: "archived" });
      await A().addReleaseEvent(id, "archived", {});
    } catch (e) { alert(e.message || "Could not archive."); return; }
    renderAll();
  }

  /* ============================================================
     Supply / Subscribers / Settings
     ============================================================ */
  function renderSupply(tab) {
    if (tab) R.supplyTab = tab;
    bindOnce();
    showTabs([
      { key: "review", label: "Review Queue" },
      { key: "inventory", label: "Inventory" },
      { key: "suppliers", label: "Suppliers" }
    ], R.supplyTab, renderSupply);
    if (R.supplyTab === "inventory") renderMarketplaceInventory();
    else if (R.supplyTab === "suppliers") renderSuppliers();
    else renderReviewQueue();
  }

  function renderSubscribersArea(tab) {
    if (tab) R.subsTab = tab;
    bindOnce();
    showTabs([
      { key: "subscribers", label: "Subscribers" },
      { key: "notes", label: "Notes & email" }
    ], R.subsTab, renderSubscribersArea);
    if (R.subsTab === "notes") renderNotes();
    else renderSubscribers();
  }

  function renderSettings() {
    hideTabs();
    bindOnce();
    const contact = window.PODA_CONTACT_EMAIL || "(not configured)";
    adminMain.innerHTML = `
      <div class="section-bar"><span class="section-bar__label">Admin</span><span class="section-bar__title">Settings</span></div>

      <section class="rel-block">
        <div class="section-bar"><span class="section-bar__title">Account</span></div>
        <p class="rel-note">Signed in as the admin account${window.PODA_ADMIN_EMAIL ? ` (${esc(window.PODA_ADMIN_EMAIL)})` : ""}. Use “Log out” in the header to end the session.</p>
      </section>

      <section class="rel-block">
        <div class="section-bar"><span class="section-bar__title">Sell with poda and Source requests</span></div>
        <p class="rel-note">Submissions from the Sell and Source forms are emailed to <strong>${esc(contact)}</strong>. They are not stored in the database, so there is no request inbox to manage here — handle them from that mailbox. Accepted sellers are invited under Supply → Suppliers.</p>
      </section>

      <section class="rel-block">
        <div class="section-bar"><span class="section-bar__title">Product drops</span></div>
        <p class="rel-note">A release's products appear in Shop when the database clock passes its drop time, or after a manual launch. Nothing needs to run on the day and no email is sent. Times are stored in UTC and shown in the release's own timezone (default: ${esc(T() ? T().browserZone() : "UTC")}).</p>
      </section>

      <section class="rel-block">
        <div class="section-bar"><span class="section-bar__title">Legacy data</span></div>
        <p class="rel-note">The old closet pipeline (${(state.items || []).length} items), drops and per-stage item views were retired from navigation. Their records are untouched in the database. The header's <strong>Export / Backup / Restore legacy items</strong> buttons cover that items table only — not releases, notes, lookbook sets, suppliers, products or subscribers.</p>
        <div class="rel-actions"><button type="button" class="btn" data-rel="open-legacy">Open legacy items list</button></div>
      </section>`;
  }

  /* ============================================================
     Events (one delegated listener, bound once)
     ============================================================ */
  async function onClick(e) {
    const wsTab = e.target.closest("[data-rel-ws-tab]");
    if (wsTab) { R.tab = wsTab.dataset.relWsTab; await renderWorkspace(); return; }

    // Close the add menu when clicking elsewhere.
    const menu = document.getElementById("relAddList");
    if (menu && !e.target.closest("#relAddMenu")) menu.hidden = true;

    const el = e.target.closest("[data-rel]");
    if (!el) return;
    const act = el.dataset.rel;
    const id = el.dataset.id;
    const dir = Number(el.dataset.dir);

    try {
      switch (act) {
        case "toggle-add": { const m = document.getElementById("relAddList"); m.hidden = !m.hidden; break; }
        case "create-release": await createRelease(); break;
        case "new-note": {
          window.studioReturnTo = () => renderWorkspace();
          await openNoteModal(null, { folderId: R.data.release.id });
          break;
        }
        case "edit-note": window.studioReturnTo = () => renderWorkspace(); await openNoteModal(id); break;
        case "pick-note": openNotePicker(); break;
        case "attach-note": await attachNote(id); break;
        case "detach-note": await detachNote(id); break;
        case "new-set": openSetModal(null); break;
        case "edit-set": openSetModal(id); break;
        case "pick-set": openSetPicker(); break;
        case "attach-set": await attachSet(id); break;
        case "detach-set": await detachSet(id); break;
        case "toggle-set": await toggleSet(id); break;
        case "move-set": await moveSet(id, dir); break;
        case "new-update": openUpdateModal(null); break;
        case "edit-update": openUpdateModal(id); break;
        case "toggle-update": await toggleUpdate(id); break;
        case "delete-update": await deleteUpdate(id); break;
        case "move-update": await moveUpdate(id, dir); break;
        case "pick-products": await openProductPicker(); break;
        case "add-product": await addProduct(id); break;
        case "remove-product": await removeProduct(id); break;
        case "move-product": await moveProduct(id, dir); break;
        case "edit-placement": openPlacementModal(id); break;
        case "save-placement": await savePlacement(); break;
        case "clear-hero": R.modal.hero = ""; document.querySelectorAll('input[name="relHero"]').forEach(i => { i.checked = false; }); break;
        case "save-update": await saveUpdate(); break;
        case "remove-update-image": R.modal.imagePath = ""; R.modal.newFile = null; drawUpdateImage(); break;
        case "save-set": await saveSet(); break;
        case "set-img-move": moveSetImage(Number(el.dataset.i), dir); break;
        case "set-img-cover": syncSetFields(); R.modal.set.coverImage = R.modal.set.images[Number(el.dataset.i)]; drawSetModal(); break;
        case "set-img-remove": {
          syncSetFields();
          const s = R.modal.set; const i = Number(el.dataset.i);
          const [gone] = s.images.splice(i, 1); s.captions.splice(i, 1);
          if (s.coverImage === gone) s.coverImage = s.images[0] || "";
          drawSetModal();
          break;
        }
        case "close-modal": {
          // Pickers change the release behind them, so refresh it on close.
          const wasPicker = R.modal && R.modal.kind === "picker";
          closeRelModal();
          if (wasPicker) await renderWorkspace();
          break;
        }
        case "save-details": await saveDetails(); break;
        case "remove-cover": await saveDetails({ cover_image: null }); break;
        case "open-release": await setStatus("scheduled", "opened"); break;
        case "to-draft": await setStatus("draft", "returned_to_draft"); break;
        case "archive": if (confirm("Archive this release? It leaves Shop and moves to the Archive. Nothing is deleted.")) await setStatus("archived", "archived"); break;
        case "unarchive": await setStatus("scheduled", "unarchived"); break;
        case "make-working": await makeWorking(); break;
        case "schedule-drop": await scheduleDrop(); break;
        case "cancel-drop": await cancelDrop(); break;
        case "launch-now": await launchNow(); break;
        case "preview-mode": R.previewMode = el.dataset.mode; await renderWorkspace(); break;
        case "open-release-id": await openReleaseById(id); break;
        case "archive-id": await archiveById(id); break;
        case "open-legacy": setView("legacyItems"); break;
        default: break;
      }
    } catch (err) {
      console.error("Release action failed:", err);
      if (R.modal) modalError(err.message || "That didn't work."); else setNotice(err.message || "That didn't work.", true);
    }
  }

  async function onChange(e) {
    const f = e.target.closest("[data-rel-file]");
    if (!f || !f.files || !f.files.length) return;
    const kind = f.dataset.relFile;
    try {
      if (kind === "update-image") { R.modal.newFile = f.files[0]; drawUpdateImage(); }
      else if (kind === "set-add") await addSetImages(f.files);
      else if (kind === "set-img-replace") await replaceSetImage(Number(f.dataset.i), f.files[0]);
      else if (kind === "cover") await uploadCover(f.files[0]);
    } catch (err) {
      if (R.modal) modalError(err.message); else setNotice(err.message, true);
    }
    f.value = "";
  }

  function bindOnce() {
    if (R.bound) return;
    R.bound = true;
    adminMain.addEventListener("click", onClick);
    modalContent.addEventListener("click", onClick);
    adminMain.addEventListener("change", onChange);
    modalContent.addEventListener("change", onChange);
  }

  window.PodaRelease = {
    renderCurrent, renderAll, renderSupply, renderSubscribersArea, renderSettings
  };
})();
