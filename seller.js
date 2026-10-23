/* ============================================================
   seller.js — Seller portal: invite redemption, sign-in, shell.
   Inventory/upload/submission-status/withdraw build out inside
   #sellerMain next — this pass is the auth gate they all sit behind.
   ============================================================ */
"use strict";

const sellerLoading = document.getElementById("sellerLoading");
const inviteGate     = document.getElementById("inviteGate");
const loginGate      = document.getElementById("loginGate");
const sellerApp      = document.getElementById("sellerApp");

function showOnly(el) {
  [sellerLoading, inviteGate, loginGate, sellerApp].forEach(e => { e.hidden = e !== el; });
}

function inviteTokenFromUrl() {
  return new URLSearchParams(window.location.search).get("invite");
}

let mySupplier = null;

async function startSellerApp() {
  try { mySupplier = await window.PodaMarketplace.mySupplier(); }
  catch (e) { mySupplier = null; }

  document.getElementById("sellerSupplierName").textContent = mySupplier
    ? mySupplier.name
    : "Not linked to a supplier yet";

  if (!mySupplier) {
    document.getElementById("sellerMain").innerHTML =
      `<p class="admin-empty">Your account isn't linked to a supplier yet. If you followed an invite link, try it again — otherwise, contact poda.</p>`;
  } else {
    await renderInventoryList();
  }

  showOnly(sellerApp);
}

async function init() {
  if (!window.PodaDB || !window.PodaDB.isConfigured) {
    sellerLoading.querySelector(".login-sub").textContent =
      "The database is not configured yet. See SUPABASE_SETUP.md.";
    return;
  }

  const token = inviteTokenFromUrl();

  if (token) {
    let invite = null;
    try { invite = await window.PodaMarketplace.getInviteByToken(token); } catch (e) { /* treated as invalid below */ }

    if (!invite) {
      showOnly(loginGate);
      document.getElementById("loginError").hidden = false;
      document.getElementById("loginError").textContent = "That invite link is invalid or has already been used.";
      return;
    }

    const session = await window.PodaDB.getSession();
    if (session) {
      // Already signed in (e.g. re-clicked their own invite link) — just
      // redeem it against the session they already have.
      try {
        await window.PodaMarketplace.redeemSupplierInvite(token);
      } catch (e) { /* already used by this same account is fine; ignore */ }
      await startSellerApp();
      return;
    }

    document.getElementById("inviteSupplierName").textContent =
      `You've been invited to join ${invite.suppliers ? invite.suppliers.name : "poda"}`;
    document.getElementById("inviteEmail").value = invite.email;
    showOnly(inviteGate);
    return;
  }

  const session = await window.PodaDB.getSession();
  if (session) {
    await startSellerApp();
  } else {
    showOnly(loginGate);
  }
}

document.getElementById("inviteForm").addEventListener("submit", async event => {
  event.preventDefault();
  const errorBox = document.getElementById("inviteError");
  errorBox.hidden = true;
  const email = document.getElementById("inviteEmail").value;
  const password = document.getElementById("invitePassword").value;
  const token = inviteTokenFromUrl();

  try {
    await window.PodaDB.signUp(email, password);
    await window.PodaMarketplace.redeemSupplierInvite(token);
  } catch (e) {
    errorBox.textContent = e && e.message ? e.message : "Could not create your account.";
    errorBox.hidden = false;
    return;
  }

  await startSellerApp();
});

document.getElementById("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const errorBox = document.getElementById("loginError");
  errorBox.hidden = true;
  const email = document.getElementById("loginEmail").value;
  const password = document.getElementById("loginPassword").value;

  try {
    await window.PodaDB.signIn(email, password);
  } catch (e) {
    errorBox.textContent = e && e.message ? e.message : "Sign in failed. Check your email and password.";
    errorBox.hidden = false;
    return;
  }

  await startSellerApp();
});

document.getElementById("sellerLogoutBtn").addEventListener("click", async () => {
  await window.PodaDB.signOut();
  window.location.href = "seller.html";
});

/* ============================================================
   Inventory — list, create, edit, submit, withdraw.
   Every write here is still only as safe as products_guard() makes it
   (see MARKETPLACE_SETUP.md): this UI simply doesn't *offer* the fields
   RLS would reject (state, commission, supplier_id) rather than
   offering them and showing an error back.
   ============================================================ */
const sellerMain = document.getElementById("sellerMain");

function escHTML(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function dollars(cents) {
  return cents === null || cents === undefined ? "" : (cents / 100).toFixed(2);
}

function field(label, name, value, opts = {}) {
  const tag = opts.textarea ? "textarea" : "input";
  const attrs = opts.textarea ? "" : `type="${opts.type || "text"}" value="${escHTML(value ?? "")}"`;
  const inner = opts.textarea ? escHTML(value ?? "") : "";
  return `
    <label class="field${opts.full ? " field--full" : ""}">
      <span>${escHTML(label)}</span>
      <${tag} name="${name}" ${attrs} ${opts.placeholder ? `placeholder="${escHTML(opts.placeholder)}"` : ""}>${inner}</${tag}>
    </label>
  `;
}

function checkboxField(label, name, checked) {
  return `
    <label class="field">
      <span>${escHTML(label)}</span>
      <input type="checkbox" name="${name}" ${checked ? "checked" : ""} style="width:auto;" />
    </label>
  `;
}

function readForm(form) {
  const out = {};
  form.querySelectorAll("[name]").forEach(el => {
    out[el.name] = el.type === "checkbox" ? el.checked : el.value;
  });
  return out;
}

function stateBadge(p) {
  const label = p.state.charAt(0).toUpperCase() + p.state.slice(1);
  return `<span class="badge">${escHTML(label)}</span>`;
}

function availabilityNote(p) {
  if (p.state !== "accepted") return "";
  if (!p.is_available) {
    return `<p class="field-error" style="margin:0 0 10px;">
      Off sale while poda re-reviews a recent change to this piece. It keeps its
      spot in its Edit, it just won't show as available until that's cleared.
    </p>`;
  }
  if (p.proposed_price_cents !== null && p.proposed_price_cents !== undefined) {
    return `<p class="field-success" style="margin:0 0 10px;">
      Still live at $${dollars(p.price_cents)}. Your proposed price of
      $${dollars(p.proposed_price_cents)} is waiting on poda's approval.
    </p>`;
  }
  return "";
}

async function renderInventoryList() {
  let products = [];
  try { products = await window.PodaMarketplace.getMyProducts(mySupplier.id); }
  catch (e) { /* empty list shown below either way */ }

  const rows = products.map(p => {
    const thumb = p.product_images && p.product_images[0]
      ? `<img src="${escHTML(window.PodaMarketplace.productImageUrl(p.product_images[0].path))}" alt="" style="width:40px;height:40px;object-fit:cover;" />`
      : `<div class="image-placeholder" style="width:40px;height:40px;font-size:8px;">poda</div>`;
    return `
      <tr data-product-row="${escHTML(p.id)}">
        <td>${thumb}</td>
        <td class="cell-strong">${escHTML(p.title || "Untitled")}</td>
        <td>${escHTML(p.brand || "—")}</td>
        <td>${stateBadge(p)}</td>
        <td>${p.is_available === false ? `<span class="badge">Unavailable</span>` : "—"}</td>
        <td class="cell-mono">${p.price_cents !== null ? "$" + dollars(p.price_cents) : "—"}</td>
        <td>
          <button type="button" class="btn" data-edit-product="${escHTML(p.id)}">Edit</button>
        </td>
      </tr>
    `;
  }).join("");

  sellerMain.innerHTML = `
    <div class="section-bar section-bar--admin">
      <span class="section-bar__label">${escHTML(mySupplier.name)}</span>
      <span class="section-bar__title">My Inventory</span>
      <button type="button" class="admin-newitem section-bar__action" id="newProductBtn">+ New Piece</button>
    </div>
    ${products.length === 0
      ? `<p class="admin-empty">Nothing here yet — add your first piece.</p>`
      : `<div class="table-wrap"><table class="admin-table">
          <thead><tr><th></th><th>Title</th><th>Brand</th><th>Status</th><th>Availability</th><th>Price</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>`}
  `;

  document.getElementById("newProductBtn").addEventListener("click", renderNewProductForm);
  sellerMain.querySelectorAll("[data-edit-product]").forEach(btn => {
    btn.addEventListener("click", () => renderProductForm(btn.dataset.editProduct));
  });
}

function renderNewProductForm() {
  sellerMain.innerHTML = `
    <div class="section-bar section-bar--admin">
      <span class="section-bar__label">${escHTML(mySupplier.name)}</span>
      <span class="section-bar__title">New Piece</span>
    </div>
    <p class="admin-empty">Save the basics first — photos and sizes attach once it's created.</p>
    <form id="newProductForm" novalidate>
      <p class="field-error" id="newProductError" hidden></p>
      <div class="field-grid">
        ${field("Title", "title", "", { full: true, placeholder: "e.g. Margiela wool coat" })}
        ${field("Brand", "brand", "")}
        ${field("Category", "category", "", { placeholder: "e.g. Outerwear" })}
        ${field("Price (USD)", "priceDollars", "", { type: "number", placeholder: "385.00" })}
        ${field("Condition", "condition", "", { placeholder: "e.g. Excellent" })}
        ${field("Condition notes", "condition_notes", "", { full: true, textarea: true, placeholder: "Be specific — this is what poda and the buyer both rely on." })}
        ${field("Description", "description", "", { full: true, textarea: true })}
      </div>
      <div style="margin-top:16px;display:flex;gap:10px;">
        <button type="button" class="btn" id="cancelNewProductBtn">Cancel</button>
        <button type="submit" class="btn btn--primary">Create &amp; continue</button>
      </div>
    </form>
  `;

  document.getElementById("cancelNewProductBtn").addEventListener("click", renderInventoryList);
  document.getElementById("newProductForm").addEventListener("submit", async event => {
    event.preventDefault();
    const errorBox = document.getElementById("newProductError");
    const fields = readForm(event.target);
    if (!fields.title.trim()) {
      errorBox.textContent = "Title is required.";
      errorBox.hidden = false;
      return;
    }
    try {
      const created = await window.PodaMarketplace.createProduct(mySupplier.id, fields);
      await renderProductForm(created.id);
    } catch (e) {
      errorBox.textContent = e && e.message ? e.message : "Could not create this piece.";
      errorBox.hidden = false;
    }
  });
}

async function renderProductForm(productId) {
  const p = await window.PodaMarketplace.getProduct(productId);
  const images = p.product_images || [];
  const variants = p.product_variants || [];

  const imageStrip = images.map(img => `
    <div class="upload-thumb">
      <img src="${escHTML(window.PodaMarketplace.productImageUrl(img.path))}" alt="" />
      <button type="button" data-rm-image="${escHTML(img.id)}" data-rm-path="${escHTML(img.path)}" aria-label="Remove photo">×</button>
    </div>
  `).join("");

  const variantRows = variants.map(v => `
    <tr data-variant-row="${escHTML(v.id)}">
      <td>${escHTML(v.size)}</td>
      <td>${escHTML(v.sku || "—")}</td>
      <td>${escHTML(v.quantity)}</td>
      <td><button type="button" class="btn" data-rm-variant="${escHTML(v.id)}">Remove</button></td>
    </tr>
  `).join("");

  sellerMain.innerHTML = `
    <div class="section-bar section-bar--admin">
      <span class="section-bar__label">${escHTML(mySupplier.name)}</span>
      <span class="section-bar__title">${escHTML(p.title || "Untitled")}</span>
      ${stateBadge(p)}
    </div>

    ${availabilityNote(p)}
    ${p.review_note ? `<p class="field-error" style="margin:0 0 10px;">poda's note: ${escHTML(p.review_note)}</p>` : ""}

    <form id="productForm" novalidate>
      <p class="field-error" id="productFormError" hidden></p>
      <div class="field-grid">
        ${field("Title", "title", p.title)}
        ${field("Brand", "brand", p.brand)}
        ${field("Category", "category", p.category)}
        ${field("Color", "color", p.color)}
        ${field("Material", "material", p.material)}
        ${field("Price (USD)", "priceDollars", dollars(p.price_cents), { type: "number" })}
        ${field("Condition", "condition", p.condition)}
        ${field("Condition notes", "condition_notes", p.condition_notes, { full: true, textarea: true })}
        ${field("Description", "description", p.description, { full: true, textarea: true })}
        ${field("Measurements", "measurements", p.measurements, { full: true, textarea: true })}
        ${checkboxField("One of a kind (no size/stock variants)", "is_unique", p.is_unique)}
      </div>
      <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;">
        <button type="button" class="btn" id="backToListBtn">← Back</button>
        <button type="submit" class="btn btn--primary">Save changes</button>
        ${p.state === "draft"
          ? `<button type="button" class="btn btn--primary" id="submitProductBtn">Submit for review</button>`
          : ""}
        ${p.state !== "withdrawn"
          ? `<button type="button" class="btn" id="withdrawProductBtn" style="margin-left:auto;">Withdraw — no longer available</button>`
          : ""}
      </div>
    </form>

    <section class="form-card" style="margin-top:24px;">
      <div class="section-bar"><span class="section-bar__title">Photos</span></div>
      <div class="upload-strip">${imageStrip}</div>
      <label class="upload-dropzone" for="productImageInput"><span>＋ Add photos</span>
        <input type="file" id="productImageInput" accept="image/*" multiple hidden />
      </label>
    </section>

    ${!p.is_unique ? `
      <section class="form-card" style="margin-top:24px;">
        <div class="section-bar"><span class="section-bar__title">Sizes &amp; stock</span></div>
        <div class="table-wrap"><table class="admin-table">
          <thead><tr><th>Size</th><th>SKU</th><th>Qty</th><th></th></tr></thead>
          <tbody>${variantRows}</tbody>
        </table></div>
        <form id="variantForm" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
          ${field("Size", "size", "")}
          ${field("SKU", "sku", "")}
          ${field("Qty", "quantity", "1", { type: "number" })}
          <button type="submit" class="btn">+ Add size</button>
        </form>
      </section>
    ` : ""}
  `;

  document.getElementById("backToListBtn").addEventListener("click", renderInventoryList);

  document.getElementById("productForm").addEventListener("submit", async event => {
    event.preventDefault();
    const errorBox = document.getElementById("productFormError");
    try {
      await window.PodaMarketplace.updateProduct(productId, readForm(event.target));
      await renderProductForm(productId);
    } catch (e) {
      errorBox.textContent = e && e.message ? e.message : "Could not save.";
      errorBox.hidden = false;
    }
  });

  const submitBtn = document.getElementById("submitProductBtn");
  if (submitBtn) submitBtn.addEventListener("click", async () => {
    try {
      await window.PodaMarketplace.setProductState(productId, "submitted");
      await renderProductForm(productId);
    } catch (e) { alert(e && e.message ? e.message : "Could not submit."); }
  });

  const withdrawBtn = document.getElementById("withdrawProductBtn");
  if (withdrawBtn) withdrawBtn.addEventListener("click", async () => {
    if (!confirm("Withdraw this piece? It will no longer be available, immediately.")) return;
    try {
      await window.PodaMarketplace.setProductState(productId, "withdrawn");
      await renderProductForm(productId);
    } catch (e) { alert(e && e.message ? e.message : "Could not withdraw."); }
  });

  document.getElementById("productImageInput").addEventListener("change", async event => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    for (const file of files) {
      try { await window.PodaMarketplace.uploadProductImage(mySupplier.id, productId, file); }
      catch (e) { alert(e && e.message ? e.message : "Could not upload that photo."); }
    }
    await renderProductForm(productId);
  });

  sellerMain.querySelectorAll("[data-rm-image]").forEach(btn => {
    btn.addEventListener("click", async () => {
      try { await window.PodaMarketplace.deleteProductImage(btn.dataset.rmImage, btn.dataset.rmPath); }
      catch (e) { alert("Could not remove that photo."); }
      await renderProductForm(productId);
    });
  });

  const variantForm = document.getElementById("variantForm");
  if (variantForm) variantForm.addEventListener("submit", async event => {
    event.preventDefault();
    const f = readForm(event.target);
    if (!f.size.trim()) return;
    try { await window.PodaMarketplace.upsertVariant(productId, { size: f.size, sku: f.sku, quantity: Number(f.quantity) || 0 }); }
    catch (e) { alert(e && e.message ? e.message : "Could not add that size."); }
    await renderProductForm(productId);
  });

  sellerMain.querySelectorAll("[data-rm-variant]").forEach(btn => {
    btn.addEventListener("click", async () => {
      try { await window.PodaMarketplace.deleteVariant(btn.dataset.rmVariant); }
      catch (e) { alert("Could not remove that size."); }
      await renderProductForm(productId);
    });
  });
}

init();
