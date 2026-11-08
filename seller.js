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

// The invite can arrive three ways: /join/ada-k7m2x9q (short code),
// ?invite=ada-k7m2x9q, or the older ?invite=<uuid>. Whatever the form,
// this resolves to the invite's uuid token. Cached, so it runs once.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let inviteTokenPromise = null;

function inviteTokenFromUrl() {
  if (!inviteTokenPromise) {
    const path = window.location.pathname.match(/^\/join\/([^/?#]+)/);
    const raw = (path && decodeURIComponent(path[1])) || new URLSearchParams(window.location.search).get("invite");
    if (!raw) inviteTokenPromise = Promise.resolve(null);
    else if (UUID_RE.test(raw)) inviteTokenPromise = Promise.resolve(raw);
    else inviteTokenPromise = window.PodaMarketplace.resolveInviteCode(raw.trim()).catch(() => null);
  }
  return inviteTokenPromise;
}

// True on a join link even when the code no longer resolves, so the person
// sees "invalid or already used" instead of a bare login form.
function hasInviteInUrl() {
  return /^\/join\//.test(window.location.pathname) || new URLSearchParams(window.location.search).has("invite");
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

  const token = await inviteTokenFromUrl();

  if (token || hasInviteInUrl()) {
    let invite = null;
    try { invite = token ? await window.PodaMarketplace.getInviteByToken(token) : null; } catch (e) { /* treated as invalid below */ }

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
  const token = await inviteTokenFromUrl();

  try {
    let session = await window.PodaDB.signUp(email, password);
    if (!session) {
      // signUp gives no session when the email already has an account, or
      // when Supabase requires email confirmation. Without a session the
      // redeem step has no user and would fail with a misleading
      // "different email address" error, so try signing in first.
      try {
        session = await window.PodaDB.signIn(email, password);
      } catch (signInError) {
        const msg = String((signInError && signInError.message) || "").toLowerCase();
        throw new Error(msg.includes("confirm")
          ? "Check your inbox and confirm your email, then open this invite link again."
          : "An account with this email may already exist. Use the same password you set before, or reset it, then open this link again.");
      }
    }
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
   Inventory — profile cards.
   Photos first: every photo becomes a draft piece with its own card.
   The front asks for four things: brand, size, price, quantity. The
   back, reached with "More details", holds everything optional.
   Fields autosave on change. Every write is still only as safe as
   products_guard() makes it: this UI simply never offers fields RLS
   would reject, such as state, commission or supplier.
   ============================================================ */
const sellerMain = document.getElementById("sellerMain");

const STATE_LABELS = {
  draft: "Draft",
  submitted: "In review",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn"
};

// Filter chips. "always" chips show even at zero; the others appear only
// when something falls in them, which keeps the bar short for new sellers.
const FILTERS = [
  { key: "all",       label: "All",       always: true, test: () => true },
  { key: "draft",     label: "Draft",     always: true, test: p => p.state === "draft" },
  { key: "submitted", label: "In review", always: true, test: p => p.state === "submitted" },
  { key: "accepted",  label: "Accepted",  always: true, test: p => p.state === "accepted" && !p.is_hidden },
  { key: "hidden",    label: "Hidden",    test: p => !!p.is_hidden && p.state !== "declined" && p.state !== "withdrawn" },
  { key: "declined",  label: "Declined",  test: p => p.state === "declined" },
  { key: "withdrawn", label: "Withdrawn", test: p => p.state === "withdrawn" }
];

let myProducts = [];
let activeFilter = "all";

/* —— Small helpers —— */
function escHTML(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function dollars(cents) {
  return cents === null || cents === undefined ? "" : (cents / 100).toFixed(2);
}

function findProduct(id) {
  return myProducts.find(p => p.id === id);
}

function sortedImages(p) {
  return (p.product_images || []).slice().sort((a, b) => a.position - b.position);
}

// A draft can be submitted once it has a photo, a brand and a price.
function isReady(p) {
  return p.state === "draft"
    && sortedImages(p).length > 0
    && !!(p.brand && p.brand.trim())
    && p.price_cents !== null && p.price_cents !== undefined;
}

// Sellers don't need to know about column names. A missing column means the
// database update has not been applied yet.
function friendlyError(e, fallback) {
  const msg = (e && e.message) || fallback;
  if (/schema cache|column .*(size|is_hidden)/i.test(msg)) {
    return "Almost ready: poda is finishing a database update. Try again soon.";
  }
  return msg;
}

/* —— Page shell —— */
async function renderInventoryList() {
  try { myProducts = await window.PodaMarketplace.getMyProducts(mySupplier.id); }
  catch (e) { myProducts = []; }

  sellerMain.innerHTML = `
    <div class="section-bar section-bar--admin">
      <span class="section-bar__label">${escHTML(mySupplier.name)}</span>
      <span class="section-bar__title">My Inventory</span>
    </div>

    <label class="card-drop" id="cardDrop" for="cardFileInput">
      <span class="card-drop__title">Drop photos here</span>
      <span class="card-drop__sub">Each photo becomes a card. Add brand, size, price and quantity, then submit.</span>
      <span class="card-drop__cta">Choose photos</span>
      <input type="file" id="cardFileInput" accept="image/*" multiple hidden />
    </label>

    <div class="card-toolbar" id="cardToolbar"></div>
    <div class="card-grid" id="cardGrid"></div>
  `;

  bindInventoryEvents();
  renderToolbar();
  renderGrid();
}

function renderToolbar() {
  const bar = document.getElementById("cardToolbar");
  if (!bar) return;
  const chips = FILTERS
    .map(f => ({ ...f, n: myProducts.filter(f.test).length }))
    .filter(f => f.always || f.n > 0 || f.key === activeFilter)
    .map(f => `
      <button type="button" class="card-chip${f.key === activeFilter ? " is-active" : ""}"
              data-filter="${f.key}" aria-pressed="${f.key === activeFilter}">
        ${escHTML(f.label)} <span class="card-chip__n">${f.n}</span>
      </button>`).join("");
  const ready = myProducts.filter(isReady).length;
  bar.innerHTML = `
    <div class="card-chips">${chips}</div>
    ${ready > 0
      ? `<button type="button" class="btn btn--primary" data-submit-all>Submit all ready: ${ready}</button>`
      : ""}
  `;
}

function renderGrid() {
  const grid = document.getElementById("cardGrid");
  if (!grid) return;
  const filter = FILTERS.find(f => f.key === activeFilter) || FILTERS[0];
  const list = myProducts.filter(filter.test);
  if (list.length === 0) {
    grid.innerHTML = `<p class="admin-empty card-empty">${
      myProducts.length === 0
        ? "Nothing here yet. Drop your first photos above."
        : "No pieces in this view."}</p>`;
    return;
  }
  grid.innerHTML = list.map(p => cardHTML(p)).join("");
}

/* —— One card —— */
function pfInput(label, field, value, opts = {}) {
  const attrs = [
    `data-field="${field}"`,
    opts.type ? `type="${opts.type}"` : `type="text"`,
    opts.inputmode ? `inputmode="${opts.inputmode}"` : "",
    opts.min !== undefined ? `min="${opts.min}"` : "",
    opts.step ? `step="${opts.step}"` : "",
    opts.placeholder ? `placeholder="${escHTML(opts.placeholder)}"` : "",
    `autocomplete="off"`
  ].join(" ");
  return `<label class="pf${opts.full ? " pf--full" : ""}"><span>${escHTML(label)}</span>
    <input ${attrs} value="${escHTML(value ?? "")}" /></label>`;
}

function pfArea(label, field, value, placeholder) {
  return `<label class="pf pf--full"><span>${escHTML(label)}</span>
    <textarea data-field="${field}" rows="2" placeholder="${escHTML(placeholder || "")}">${escHTML(value ?? "")}</textarea></label>`;
}

// The one-line status under the fields. Replaces the old multi-paragraph
// notices; same facts, shorter.
function noteHTML(p) {
  if (p.is_hidden && p.state !== "declined" && p.state !== "withdrawn") {
    return `<span class="pcard__note pcard__note--muted">Hidden: not for sale. Show it to put it back.</span>`;
  }
  if (p.state === "declined" || (p.state === "draft" && p.review_note)) {
    return p.review_note
      ? `<span class="pcard__note pcard__note--warn">poda: ${escHTML(p.review_note)}</span>`
      : `<span class="pcard__note pcard__note--warn">Declined.</span>`;
  }
  if (p.state === "accepted") {
    if (p.is_available === false) {
      return `<span class="pcard__note pcard__note--warn">Off sale while poda re-reviews a change.</span>`;
    }
    if (p.proposed_price_cents !== null && p.proposed_price_cents !== undefined) {
      return `<span class="pcard__note">Live at $${dollars(p.price_cents)}. New price waiting on poda.</span>`;
    }
    return `<span class="pcard__note pcard__note--muted">Changes to details or photos take it off sale until poda re-reviews.</span>`;
  }
  if (p.state === "draft" && !isReady(p)) {
    return `<span class="pcard__note pcard__note--muted">Needs a photo, brand and price to submit.</span>`;
  }
  return "";
}

function menuHTML(p) {
  const items = [];
  if (p.state !== "declined" && p.state !== "withdrawn") {
    items.push(`<button type="button" data-hide="${p.id}">${p.is_hidden ? "Show" : "Hide"}</button>`);
  }
  // Never-live pieces can be deleted. Anything poda has seen is withdrawn
  // instead, so its history survives.
  if (p.state === "draft" || p.state === "declined" || p.state === "withdrawn") {
    items.push(`<button type="button" class="is-danger" data-delete="${p.id}">Delete</button>`);
  } else {
    items.push(`<button type="button" class="is-danger" data-withdraw="${p.id}">Withdraw</button>`);
  }
  return `<details class="pmenu">
    <summary aria-label="Options for this piece">⋯</summary>
    <div class="pmenu__list">${items.join("")}</div>
  </details>`;
}

function sizesHTML(p) {
  const variants = p.product_variants || [];
  const chips = variants.map(v => `
    <span class="pvar">${escHTML(v.size)} · ${Number(v.quantity) || 0}
      <button type="button" data-rm-variant="${v.id}" aria-label="Remove size ${escHTML(v.size)}">×</button></span>`).join("");
  return `
    <div class="pvars">${chips || `<span class="pcard__note pcard__note--muted">No sizes added.</span>`}</div>
    <div class="pvar-add">
      <input type="text" data-vsize placeholder="Size" autocomplete="off" />
      <input type="number" data-vqty placeholder="Qty" min="0" step="1" inputmode="numeric" />
      <button type="button" class="btn" data-add-variant="${p.id}">Add</button>
    </div>`;
}

function cardHTML(p, flipped = false) {
  const images = sortedImages(p);
  const first = images[0];
  const photo = first
    ? `<img src="${escHTML(window.PodaMarketplace.productImageUrl(first.path))}" alt="" loading="lazy" />`
    : `<label class="pcard__nophoto" for="pf-${p.id}">+ Add a photo</label>`;
  const stateKey = p.state;
  const price = p.proposed_price_cents ?? p.price_cents;
  const qty = p.quantity ?? 1;

  const thumbs = images.map(img => `
    <div class="upload-thumb">
      <img src="${escHTML(window.PodaMarketplace.productImageUrl(img.path))}" alt="" />
      <button type="button" data-rm-image="${img.id}" data-rm-path="${escHTML(img.path)}" aria-label="Remove photo">×</button>
    </div>`).join("");

  return `
  <article class="pcard${flipped ? " is-flipped" : ""}${p.is_hidden ? " is-hidden" : ""}" data-card="${p.id}" data-state="${stateKey}">
    <input type="file" id="pf-${p.id}" data-card-file="${p.id}" accept="image/*" multiple hidden />
    <div class="pcard__inner">

      <div class="pcard__face pcard__front"${flipped ? " inert" : ""}>
        <div class="pcard__photo">
          ${photo}
          <div class="pcard__chips">
            <span class="badge badge--${stateKey}">${escHTML(STATE_LABELS[stateKey] || stateKey)}</span>
            ${p.is_hidden ? `<span class="badge badge--withdrawn">Hidden</span>` : ""}
            ${Number(qty) === 0 && p.state !== "draft" ? `<span class="badge badge--declined">Sold out</span>` : ""}
          </div>
          ${menuHTML(p)}
        </div>
        <div class="pcard__fields">
          ${pfInput("Brand", "brand", p.brand, { full: true, placeholder: "e.g. Margiela" })}
          <div class="pf-row">
            ${pfInput("Size", "size", p.size, { placeholder: "M" })}
            ${pfInput("Price $", "priceDollars", dollars(price), { type: "number", inputmode: "decimal", min: 0, step: "0.01", placeholder: "0" })}
            ${pfInput("Qty", "quantity", qty, { type: "number", inputmode: "numeric", min: 0, step: "1" })}
          </div>
        </div>
        <div class="pcard__status" aria-live="polite">${noteHTML(p)}</div>
        <div class="pcard__foot">
          <button type="button" class="pcard__more" data-flip aria-expanded="${flipped}">More details</button>
          <span class="pcard__saved" data-saved></span>
          ${p.state === "draft"
            ? `<button type="button" class="btn btn--primary pcard__submit" data-submit="${p.id}"${isReady(p) ? "" : " disabled"}>Submit</button>`
            : p.state === "submitted" ? `<span class="pcard__review">In review</span>` : ""}
        </div>
      </div>

      <div class="pcard__face pcard__back"${flipped ? "" : " inert"}>
        <div class="pcard__backhead">
          <span class="pcard__backtitle">More details</span>
          <button type="button" class="pcard__more" data-unflip>Done</button>
        </div>
        <div class="pcard__scroll">
          ${pfInput("Title", "title", p.title, { full: true, placeholder: "Optional" })}
          <div class="pf-row pf-row--2">
            ${pfInput("Category", "category", p.category, { placeholder: "Outerwear" })}
            ${pfInput("Color", "color", p.color)}
          </div>
          <div class="pf-row pf-row--2">
            ${pfInput("Material", "material", p.material)}
            ${pfInput("Condition", "condition", p.condition, { placeholder: "Excellent" })}
          </div>
          ${pfInput("Measurements", "measurements", p.measurements, { full: true, placeholder: "Chest 54cm" })}
          ${pfArea("Condition notes", "condition_notes", p.condition_notes, "Be specific: poda and the buyer both rely on this.")}
          ${pfArea("Description", "description", p.description, "")}
          <div class="pf pf--full"><span>Photos</span>
            <div class="upload-strip">
              ${thumbs}
              <label class="upload-thumb upload-thumb--add" for="pf-${p.id}" aria-label="Add photos">+</label>
            </div>
          </div>
          <div class="pf pf--full pcard__sizes"${Number(qty) > 1 ? "" : " hidden"}>
            <span>Stock by size</span>
            <div data-sizes>${sizesHTML(p)}</div>
          </div>
        </div>
      </div>

    </div>
  </article>`;
}

/* —— Flip: the hidden face is inert so keyboard focus can't land on it —— */
function setFlipped(card, flipped) {
  const front = card.querySelector(".pcard__front");
  const back = card.querySelector(".pcard__back");
  card.classList.toggle("is-flipped", flipped);
  front.toggleAttribute("inert", flipped);
  back.toggleAttribute("inert", !flipped);
  const flipBtn = card.querySelector("[data-flip]");
  if (flipBtn) flipBtn.setAttribute("aria-expanded", String(flipped));
  // Move focus after the face becomes interactive.
  const target = flipped ? back.querySelector("input, textarea") : flipBtn;
  if (target) setTimeout(() => target.focus({ preventScroll: true }), flipped ? 320 : 0);
}

/* —— Re-render helpers —— */
function cardEl(id) {
  return sellerMain.querySelector(`[data-card="${id}"]`);
}

// Swap one card in place, keeping its flipped state.
function replaceCard(id) {
  const p = findProduct(id);
  const el = cardEl(id);
  if (!p || !el) return;
  el.outerHTML = cardHTML(p, el.classList.contains("is-flipped"));
}

// After a state or hidden change: update counts, and rebuild the grid when
// the card no longer belongs in the current filter.
function afterChange(id) {
  renderToolbar();
  const p = findProduct(id);
  const filter = FILTERS.find(f => f.key === activeFilter) || FILTERS[0];
  if (!p || !filter.test(p)) renderGrid(); else replaceCard(id);
}

async function refreshProduct(id) {
  const fresh = await window.PodaMarketplace.getProduct(id);
  const i = myProducts.findIndex(p => p.id === id);
  if (i >= 0) myProducts[i] = fresh; else myProducts.unshift(fresh);
  return fresh;
}

/* —— Autosave —— */
const savedTimers = new WeakMap();

function setSaved(card, text, isError) {
  const el = card && card.querySelector("[data-saved]");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("is-error", !!isError);
  clearTimeout(savedTimers.get(el));
  if (text && !isError && text !== "Saving…") {
    savedTimers.set(el, setTimeout(() => { el.textContent = ""; }, 1800));
  }
}

// Build the one-field patch for an input, or null when nothing changed.
function patchFor(p, key, raw, input) {
  const value = raw.trim();

  if (key === "priceDollars") {
    if (value === "") {
      // A live piece must keep a price; put the old one back.
      if (p.state === "accepted") { input.value = dollars(p.proposed_price_cents ?? p.price_cents); return null; }
      return p.price_cents === null ? null : { priceDollars: "" };
    }
    const n = Number(value);
    if (!isFinite(n) || n < 0) { input.value = dollars(p.price_cents); return null; }
    const cents = Math.round(n * 100);
    if (cents === (p.proposed_price_cents ?? p.price_cents)) return null;
    return { priceDollars: n };
  }

  if (key === "quantity") {
    const q = Math.max(0, Math.floor(Number(value) || 0));
    input.value = q;
    if (q === (p.quantity ?? 1)) return null;
    // One of a kind at 1; more than one means sizes or multiples.
    return { quantity: q, is_unique: q <= 1 };
  }

  if (value === (p[key] || "")) return null;
  return { [key]: value };
}

async function saveField(input) {
  const card = input.closest("[data-card]");
  if (!card) return;
  const id = card.dataset.card;
  const p = findProduct(id);
  if (!p) return;

  const patch = patchFor(p, input.dataset.field, input.value, input);
  if (!patch) return;

  setSaved(card, "Saving…");
  try {
    const row = await window.PodaMarketplace.updateProduct(id, patch);
    Object.assign(p, row);
    setSaved(card, "Saved");
  } catch (e) {
    setSaved(card, friendlyError(e, "Could not save."), true);
    return;
  }

  // Refresh the parts that depend on the saved values without rebuilding
  // the card, which would drop the cursor.
  const status = card.querySelector(".pcard__status");
  if (status) status.innerHTML = noteHTML(p);
  const submit = card.querySelector("[data-submit]");
  if (submit) submit.disabled = !isReady(p);
  const sizes = card.querySelector(".pcard__sizes");
  if (sizes) sizes.hidden = !(Number(p.quantity) > 1);
  renderToolbar();
}

/* —— Photos —— */

// Shrink big phone photos before upload: 1600px long edge, JPEG. Falls back
// to the original file if the browser can't decode it.
async function shrinkImage(file, maxEdge = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.type === "image/jpeg" && file.size < 1.5 * 1024 * 1024) {
      if (bmp.close) bmp.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    if (bmp.close) bmp.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.86));
    if (!blob) return file;
    const base = (file.name || "photo").replace(/\.[^.]+$/, "");
    return new File([blob], base + ".jpg", { type: "image/jpeg" });
  } catch (e) {
    return file;
  }
}

function skeletonHTML(key) {
  return `
  <article class="pcard pcard--loading" data-upload="${key}">
    <div class="pcard__inner"><div class="pcard__face pcard__front">
      <div class="pcard__photo"><div class="pcard__shimmer"></div>
        <span class="pcard__uptext">Uploading…</span></div>
      <div class="pcard__fields"><div class="pcard__bar"></div><div class="pcard__bar pcard__bar--short"></div></div>
    </div></div>
  </article>`;
}

// Run `worker` over `items`, at most `limit` at a time.
async function runPool(items, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; await worker(items[i], i); }
  });
  await Promise.all(lanes);
}

async function addPhotos(fileList) {
  const files = Array.from(fileList || []).filter(f => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name));
  if (files.length === 0) return;

  // New drafts must be visible: switch away from a filter that would hide them.
  if (activeFilter !== "all" && activeFilter !== "draft") {
    activeFilter = "all";
    renderToolbar();
    renderGrid();
  }
  const grid = document.getElementById("cardGrid");
  const empty = grid.querySelector(".card-empty");
  if (empty) empty.remove();

  const jobs = files.map((file, i) => ({ file, key: `${Date.now()}-${i}` }));
  grid.insertAdjacentHTML("afterbegin", jobs.map(j => skeletonHTML(j.key)).join(""));

  await runPool(jobs, 3, async job => {
    const slot = () => grid.querySelector(`[data-upload="${job.key}"]`);
    try {
      const upload = await shrinkImage(job.file);
      const created = await window.PodaMarketplace.createProduct(mySupplier.id, { quantity: 1, is_unique: true });
      try {
        await window.PodaMarketplace.uploadProductImage(mySupplier.id, created.id, upload);
      } catch (e) {
        // Don't leave an empty draft behind when the photo didn't make it.
        try { await window.PodaMarketplace.deleteProduct(created.id); } catch (_) { /* best effort */ }
        throw e;
      }
      const full = await window.PodaMarketplace.getProduct(created.id);
      job.product = full;
      myProducts.unshift(full);
      const el = slot();
      if (el) el.outerHTML = cardHTML(full);
      renderToolbar();
    } catch (e) {
      const el = slot();
      if (el) {
        el.classList.remove("pcard--loading");
        el.classList.add("pcard--failed");
        el.querySelector(".pcard__uptext").textContent = friendlyError(e, "Upload failed.");
        el.insertAdjacentHTML("beforeend",
          `<button type="button" class="pcard__dismiss" data-dismiss-upload aria-label="Dismiss">×</button>`);
      }
    }
  });

  // Uploads finish in any order. Keep the new pieces in the order the files
  // were chosen so the list matches what the seller dropped.
  const added = jobs.map(j => j.product).filter(Boolean);
  if (added.length > 1) {
    myProducts = [...added, ...myProducts.filter(p => !added.includes(p))];
    // Move the existing card elements rather than re-rendering the grid, which
    // would also wipe any failed-upload card the seller has not read yet.
    added.slice().reverse().forEach(p => {
      const el = cardEl(p.id);
      if (el) grid.prepend(el);
    });
  }
}

async function addExtraPhotos(id, fileList) {
  const files = Array.from(fileList || []).filter(f => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name));
  const card = cardEl(id);
  if (!files.length) return;
  setSaved(card, "Uploading…");
  for (const file of files) {
    try {
      await window.PodaMarketplace.uploadProductImage(mySupplier.id, id, await shrinkImage(file));
    } catch (e) {
      setSaved(card, friendlyError(e, "Could not upload that photo."), true);
    }
  }
  await refreshProduct(id);
  replaceCard(id);
  renderToolbar();
}

/* —— Events: one delegated set, bound once —— */
function bindInventoryEvents() {
  const drop = document.getElementById("cardDrop");
  const fileInput = document.getElementById("cardFileInput");
  fileInput.addEventListener("change", () => { addPhotos(fileInput.files); fileInput.value = ""; });
  ["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => {
    e.preventDefault(); drop.classList.add("is-over");
  }));
  ["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => {
    e.preventDefault(); drop.classList.remove("is-over");
  }));
  drop.addEventListener("drop", e => addPhotos(e.dataTransfer && e.dataTransfer.files));

  if (sellerMain.dataset.cardsBound) return;
  sellerMain.dataset.cardsBound = "1";

  sellerMain.addEventListener("change", e => {
    const input = e.target.closest("[data-field]");
    if (input) { saveField(input); return; }
    const fileIn = e.target.closest("[data-card-file]");
    if (fileIn) { addExtraPhotos(fileIn.dataset.cardFile, fileIn.files); fileIn.value = ""; }
  });

  sellerMain.addEventListener("click", e => handleClick(e));

  // Enter in a front field commits it like leaving the field does.
  sellerMain.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.matches("input[data-field]")) e.target.blur();
    if (e.key === "Escape") {
      const card = e.target.closest && e.target.closest(".pcard.is-flipped");
      if (card) setFlipped(card, false);
    }
  });

  // Close any open ⋯ menu when clicking elsewhere.
  document.addEventListener("click", e => {
    document.querySelectorAll(".pmenu[open]").forEach(m => { if (!m.contains(e.target)) m.removeAttribute("open"); });
  });
}

async function handleClick(e) {
  const t = e.target;

  const filterBtn = t.closest("[data-filter]");
  if (filterBtn) { activeFilter = filterBtn.dataset.filter; renderToolbar(); renderGrid(); return; }

  const flip = t.closest("[data-flip]");
  if (flip) { setFlipped(flip.closest("[data-card]"), true); return; }
  const unflip = t.closest("[data-unflip]");
  if (unflip) { setFlipped(unflip.closest("[data-card]"), false); return; }

  const dismiss = t.closest("[data-dismiss-upload]");
  if (dismiss) { dismiss.closest("[data-upload]").remove(); return; }

  const submitBtn = t.closest("[data-submit]");
  if (submitBtn) { await submitPiece(submitBtn.dataset.submit); return; }
  if (t.closest("[data-submit-all]")) { await submitAllReady(); return; }

  const hideBtn = t.closest("[data-hide]");
  if (hideBtn) { await toggleHidden(hideBtn.dataset.hide); return; }

  const delBtn = t.closest("[data-delete]");
  if (delBtn) { await deletePiece(delBtn.dataset.delete); return; }

  const wdBtn = t.closest("[data-withdraw]");
  if (wdBtn) { await withdrawPiece(wdBtn.dataset.withdraw); return; }

  const rmImg = t.closest("[data-rm-image]");
  if (rmImg) {
    const card = rmImg.closest("[data-card]");
    try { await window.PodaMarketplace.deleteProductImage(rmImg.dataset.rmImage, rmImg.dataset.rmPath); }
    catch (err) { setSaved(card, "Could not remove that photo.", true); return; }
    await refreshProduct(card.dataset.card);
    replaceCard(card.dataset.card);
    renderToolbar();
    return;
  }

  const addVar = t.closest("[data-add-variant]");
  if (addVar) { await addVariant(addVar); return; }
  const rmVar = t.closest("[data-rm-variant]");
  if (rmVar) { await removeVariant(rmVar); return; }
}

/* —— Actions —— */
async function submitPiece(id) {
  const p = findProduct(id);
  if (!p || !isReady(p)) return;
  try {
    const row = await window.PodaMarketplace.setProductState(id, "submitted");
    Object.assign(p, row);
  } catch (e) { setSaved(cardEl(id), friendlyError(e, "Could not submit."), true); return; }
  afterChange(id);
}

async function submitAllReady() {
  const ready = myProducts.filter(isReady);
  if (ready.length === 0) return;
  if (!confirm(`Submit ${ready.length} ${ready.length === 1 ? "piece" : "pieces"} to poda for review?`)) return;
  for (const p of ready) {
    try {
      const row = await window.PodaMarketplace.setProductState(p.id, "submitted");
      Object.assign(p, row);
    } catch (e) { setSaved(cardEl(p.id), friendlyError(e, "Could not submit."), true); }
  }
  renderToolbar();
  renderGrid();
}

async function toggleHidden(id) {
  const p = findProduct(id);
  if (!p) return;
  try {
    const row = await window.PodaMarketplace.setProductHidden(id, !p.is_hidden);
    Object.assign(p, row);
  } catch (e) { setSaved(cardEl(id), friendlyError(e, "Could not update."), true); return; }
  afterChange(id);
}

async function deletePiece(id) {
  if (!confirm("Delete this piece for good? This can't be undone.")) return;
  try { await window.PodaMarketplace.deleteProduct(id); }
  catch (e) { alert(friendlyError(e, "Could not delete this piece.")); return; }
  myProducts = myProducts.filter(p => p.id !== id);
  renderToolbar();
  renderGrid();
}

async function withdrawPiece(id) {
  if (!confirm("Withdraw this piece? It will no longer be available, immediately.")) return;
  const p = findProduct(id);
  try {
    const row = await window.PodaMarketplace.withdrawProduct(id);
    Object.assign(p, row);
  } catch (e) { alert(friendlyError(e, "Could not withdraw this piece.")); return; }
  afterChange(id);
}

async function addVariant(btn) {
  const id = btn.dataset.addVariant;
  const box = btn.closest(".pvar-add");
  const size = box.querySelector("[data-vsize]").value.trim();
  const qty = Math.max(0, Math.floor(Number(box.querySelector("[data-vqty]").value) || 0));
  if (!size) return;
  try { await window.PodaMarketplace.upsertVariant(id, { size, sku: null, quantity: qty }); }
  catch (e) { setSaved(cardEl(id), friendlyError(e, "Could not add that size."), true); return; }
  await refreshProduct(id);
  const sizes = cardEl(id).querySelector("[data-sizes]");
  if (sizes) sizes.innerHTML = sizesHTML(findProduct(id));
}

async function removeVariant(btn) {
  const card = btn.closest("[data-card]");
  const id = card.dataset.card;
  try { await window.PodaMarketplace.deleteVariant(btn.dataset.rmVariant); }
  catch (e) { setSaved(card, "Could not remove that size.", true); return; }
  await refreshProduct(id);
  card.querySelector("[data-sizes]").innerHTML = sizesHTML(findProduct(id));
}

init();
