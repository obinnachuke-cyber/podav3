/* ============================================================
   poda — public site
   Reads the inventory poda curates. The public only ever sees
   what poda selected: LIVE pieces in the current drop (The Edit),
   past drops in the Archive, and published Market Notes.

   One file drives several pages, detected by the elements present:
     • The Edit   (#dropGrid)      — the current store
     • Product    (#product-page)  — one piece + transaction CTA
     • Archive    (#archiveDrops)  — past drops, sold marked SOLD
     • Market Notes (#inboxList)   — research index
     • Home       (#homeMount)     — editorial homepage modules
   ============================================================ */

/* —— Public contact (from supabase-config.js) —— */
const CONTACT_EMAIL = window.PODA_CONTACT_EMAIL || "";
const INSTAGRAM = window.PODA_INSTAGRAM || "podacapital";

/* —— Vocabulary shared with the admin (kept in sync manually) —— */
const SOURCE_LABELS = { brand: "Independent Brand", vintage: "Vintage", closet: "Private Closet" };
const TX_LABELS = {
  poda_sale: "Purchase through poda",
  assisted:  "Request to purchase",
  partner:   "View at partner",
  sourcing:  "Source something similar"
};

/* ============================================================
   Small helpers
   ============================================================ */
function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0
  }).format(value || 0);
}

function itemListPrice(item) {
  return numOrNull(item.pricing && item.pricing.currentListPrice);
}

function itemSoldPrice(item) {
  return numOrNull(item.soldActuals && item.soldActuals.finalSalePrice);
}

function getImageUrl(item) {
  if (item.primaryImage) return String(item.primaryImage).trim();
  if (Array.isArray(item.images) && item.images.length) return String(item.images[0]).trim();
  return "";
}

function itemImageAlt(item) {
  return `${item.brand || "Piece"} ${item.itemName || ""}`.trim();
}

function itemDetailHref(item) {
  const id = String(item.id || "").trim();
  return id ? `item.html?id=${encodeURIComponent(id)}` : "";
}

function dropNo(item) {
  return String(item.dropNumber || "").trim();
}

/* —— Overhaul derivations —— */
function txType(item) {
  return item.transactionType || "poda_sale";
}

function sourceLabel(item) {
  return SOURCE_LABELS[item.sourceType] || SOURCE_LABELS.brand;
}

// Structured item ID, or the stored code, or the raw id as a fallback.
function itemCode(item) {
  return String(item.itemCode || item.id || "").trim();
}

// Public availability label + css modifier (brief §6E vocabulary).
function displayStatus(item) {
  if (item.status === "Sold") return { label: "Sold", mod: "sold" };
  const t = txType(item);
  if (t === "partner")  return { label: "External", mod: "external" };
  if (t === "sourcing") return { label: "Source on request", mod: "sourcing" };
  return { label: "Available", mod: "available" };
}

function handleImageError(event) {
  const img = event.currentTarget;
  const container = img.closest(".catalog-card__image, .product-media, .item-image");
  if (container) {
    container.classList.add("is-missing-image");
    img.remove();
  }
}

function bindImageErrorHandlers(root) {
  if (!root) return;
  root.querySelectorAll(".catalog-card__image img, .product-media img").forEach(img => {
    img.addEventListener("error", handleImageError, { once: true });
  });
}

/* ============================================================
   Transaction CTA — the correct call-to-action per item (brief §9)
   ============================================================ */
function inquiryEmailHref(item, mode) {
  if (!CONTACT_EMAIL) return "";
  const price = itemListPrice(item);
  const verb = mode === "assisted" ? "am interested in" : "would like to buy";
  const subject = `poda — ${item.brand || ""} ${item.itemName || ""} (${itemCode(item)})`.trim();
  const body =
    `Hi poda,\n\nI ${verb} this piece:\n` +
    `• ${item.brand || ""} ${item.itemName || ""}\n` +
    (itemCode(item) ? `• ${itemCode(item)}\n` : "") +
    (item.size ? `• Size ${item.size}\n` : "") +
    (price !== null ? `• ${formatMoney(price)}\n` : "") +
    (dropNo(item) ? `• Drop ${dropNo(item)}\n` : "") +
    `\nIs it still available?\n\nThanks!`;
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function instagramHref() {
  return `https://instagram.com/${INSTAGRAM}`;
}

// Returns the primary CTA button(s) HTML for a product, based on its
// transaction type and availability. Every path resolves to a real action.
function transactionCTA(item) {
  if (item.status === "Sold") {
    return `<div class="product-buy-wrap">
        <a class="product-buy product-buy--alt" href="source.html">Join restock notice / source similar →</a>
        <span class="product-buy__note">This piece has sold. poda can look for something close.</span>
      </div>`;
  }

  const t = txType(item);

  if (t === "partner") {
    const url = String(item.externalUrl || "").trim();
    return `<div class="product-buy-wrap">
        ${url
          ? `<a class="product-buy" href="${escapeHTML(url)}" target="_blank" rel="noopener">View at partner<span class="product-buy__arrow" aria-hidden="true">↗</span></a>`
          : `<span class="product-status"><span class="badge">External — link coming</span></span>`}
        <span class="product-buy__note">Sold and shipped by an approved external seller.</span>
      </div>`;
  }

  if (t === "sourcing") {
    return `<div class="product-buy-wrap">
        <a class="product-buy" href="source.html">Source something similar<span class="product-buy__arrow" aria-hidden="true">→</span></a>
        <span class="product-buy__note">Not currently in stock — open a request and poda will look.</span>
      </div>`;
  }

  // poda_sale + assisted → inquiry-led flow (no fake checkout).
  const emailHref = inquiryEmailHref(item, t);
  const label = t === "assisted" ? "Request to purchase" : "Purchase through poda";
  const note = t === "assisted"
    ? "poda confirms availability and completes the purchase with you."
    : "poda confirms availability and arranges payment directly.";
  return `<div class="product-buy-wrap">
      ${emailHref ? `<a class="product-buy" href="${escapeHTML(emailHref)}">${label}<span class="product-buy__arrow" aria-hidden="true">→</span></a>` : ""}
      <a class="product-buy product-buy--alt" href="${escapeHTML(instagramHref())}" target="_blank" rel="noopener">DM on Instagram ↗</a>
      <span class="product-buy__note">${note}</span>
    </div>`;
}

/* ============================================================
   Card — a single piece in The Edit / Archive grid
   ============================================================ */
function cardImage(item) {
  const url = getImageUrl(item);
  return url
    ? `<img src="${escapeHTML(url)}" alt="${escapeHTML(itemImageAlt(item))}" loading="lazy" decoding="async" />`
    : `<div class="image-placeholder">No image</div>`;
}

function pieceCard(item) {
  const isSold = item.status === "Sold";
  const detailHref = itemDetailHref(item);
  const price = isSold ? itemSoldPrice(item) : itemListPrice(item);
  const status = displayStatus(item);

  const detailParts = [
    item.size ? escapeHTML(item.size) : "",
    isSold ? "Sold" : (price !== null ? formatMoney(price) : "")
  ].filter(Boolean);

  const imgInner = `
    <div class="catalog-card__image${getImageUrl(item) ? "" : " catalog-card__image--empty"}${isSold ? " catalog-card__image--sold" : ""}">
      ${cardImage(item)}
      <span class="catalog-card__status catalog-card__status--${status.mod}">${escapeHTML(status.label)}</span>
    </div>`;
  const imageBlock = detailHref
    ? `<a class="catalog-card__img-link" href="${escapeHTML(detailHref)}" aria-label="${escapeHTML(itemImageAlt(item))}">${imgInner}</a>`
    : imgInner;

  const titleInner = detailHref
    ? `<a class="catalog-card__title-link" href="${escapeHTML(detailHref)}">${escapeHTML(item.itemName || "Untitled")}</a>`
    : escapeHTML(item.itemName || "Untitled");

  return `
    <article class="catalog-card${isSold ? " catalog-card--sold" : ""}">
      ${imageBlock}
      <div class="catalog-card__meta">
        <div class="catalog-card__meta-row">
          <span class="catalog-card__brand">${escapeHTML(item.brand || sourceLabel(item))}</span>
          ${itemCode(item) ? `<span class="catalog-card__id">${escapeHTML(itemCode(item))}</span>` : ""}
        </div>
        <h2 class="catalog-card__name">${titleInner}</h2>
        ${detailParts.length ? `<p class="catalog-card__details">${detailParts.join(" · ")}</p>` : ""}
      </div>
    </article>
  `;
}

/* ============================================================
   Page: The Edit — the current store (all LIVE pieces)
   ============================================================ */
let editItems = [];
let editDrops = [];
let editFilter = "all";

function latestDrop(items) {
  const nums = items.map(dropNo).filter(Boolean);
  if (!nums.length) return "";
  return nums.sort((a, b) => (Number(a) || 0) - (Number(b) || 0)).pop();
}

function currentDropRecord(number) {
  return editDrops.find(d => String(d.number || "").trim() === String(number).trim()) || null;
}

// Source-mix summary line, e.g. "3 brands · 2 vintage · 1 closet".
function sourceMix(items) {
  const counts = { brand: 0, vintage: 0, closet: 0 };
  items.forEach(i => { counts[i.sourceType] = (counts[i.sourceType] || 0) + 1; });
  const parts = [];
  if (counts.brand)   parts.push(`${counts.brand} brand`);
  if (counts.vintage) parts.push(`${counts.vintage} vintage`);
  if (counts.closet)  parts.push(`${counts.closet} closet`);
  return parts.join(" · ");
}

function editFilterBar(live) {
  const sources = new Set(live.map(i => i.sourceType).filter(Boolean));
  const chips = [["all", "All"], ["available", "Available"]];
  if (sources.has("brand"))   chips.push(["brand", "Brands"]);
  if (sources.has("vintage")) chips.push(["vintage", "Vintage"]);
  if (sources.has("closet"))  chips.push(["closet", "Closets"]);
  if (chips.length <= 2) return ""; // nothing meaningful to filter
  return `
    <div class="controls" role="tablist" aria-label="Filter the edit">
      <div class="toggle-group">
        ${chips.map(([key, label]) =>
          `<button type="button" class="toggle${key === editFilter ? " active" : ""}" data-edit-filter="${key}">${label}</button>`
        ).join("")}
      </div>
    </div>`;
}

function applyEditFilter(live) {
  if (editFilter === "all") return live;
  if (editFilter === "available") return live.filter(i => txType(i) === "poda_sale" || txType(i) === "assisted");
  return live.filter(i => i.sourceType === editFilter);
}

function renderEdit() {
  const grid = document.getElementById("dropGrid");
  const header = document.getElementById("dropHeader");
  const empty = document.getElementById("dropEmpty");
  const controls = document.getElementById("dropControls");
  if (!grid) return;

  const live = editItems.filter(i => i.status === "Live");

  if (!live.length) {
    if (header) header.innerHTML = `
      <span class="drop-hero__eyebrow">The Edit</span>
      <h1 class="drop-hero__title">In assembly</h1>
      <p class="drop-hero__sub">The next drop is being selected. Check back soon, or open a sourcing request.</p>`;
    if (empty) empty.innerHTML = `<a class="product-link" href="source.html">Open a sourcing request →</a>`;
    if (controls) controls.innerHTML = "";
    grid.innerHTML = "";
    return;
  }

  const current = latestDrop(live);
  const rec = currentDropRecord(current);
  const inCurrent = live.filter(i => dropNo(i) === current);

  if (header) {
    const number = current ? `Drop ${escapeHTML(current)}` : "The Edit";
    const title = rec && rec.title ? escapeHTML(rec.title) : "The current edit";
    const thesis = rec && rec.thesis ? `<p class="drop-hero__thesis">${escapeHTML(rec.thesis)}</p>` : "";
    const mix = sourceMix(inCurrent);
    header.innerHTML = `
      <span class="drop-hero__eyebrow">${number} · ${live.length} piece${live.length === 1 ? "" : "s"}${mix ? ` · ${escapeHTML(mix)}` : ""}</span>
      <h1 class="drop-hero__title">${title}</h1>
      ${thesis}`;
  }

  if (controls) controls.innerHTML = editFilterBar(live);

  const filtered = applyEditFilter(live);
  const ordered = [
    ...filtered.filter(i => dropNo(i) === current),
    ...filtered.filter(i => dropNo(i) !== current)
  ];

  if (empty) empty.textContent = "";
  grid.innerHTML = ordered.length
    ? ordered.map(pieceCard).join("")
    : `<p class="status-message">Nothing in this filter.</p>`;
  bindImageErrorHandlers(grid);
  bindEditFilterTabs();
}

function bindEditFilterTabs() {
  document.querySelectorAll("[data-edit-filter]").forEach(tab => {
    tab.addEventListener("click", () => {
      editFilter = tab.dataset.editFilter;
      renderEdit();
    });
  });
}

/* ============================================================
   Page: Archive — past drops (live + sold), grouped by drop
   ============================================================ */
function renderArchive(items) {
  const wrap = document.getElementById("archiveDrops");
  const status = document.getElementById("archiveStatus");
  if (!wrap) return;

  const inStore = items.filter(i => (i.status === "Live" || i.status === "Sold") && dropNo(i));
  if (!inStore.length) {
    if (status) status.textContent = "No drops yet.";
    return;
  }
  if (status) status.remove();

  const drops = {};
  inStore.forEach(i => { (drops[dropNo(i)] ||= []).push(i); });
  const dropKeys = Object.keys(drops).sort((a, b) => (Number(b) || 0) - (Number(a) || 0));

  wrap.innerHTML = dropKeys.map(key => {
    const pieces = drops[key];
    const sold = pieces.filter(p => p.status === "Sold").length;
    return `
      <section class="archive-drop">
        <div class="section-bar">
          <span class="section-bar__label">Drop ${escapeHTML(key)}</span>
          <span class="section-bar__title">${pieces.length} piece${pieces.length === 1 ? "" : "s"}${sold ? ` · ${sold} sold` : ""}</span>
        </div>
        <div class="items-grid">${pieces.map(pieceCard).join("")}</div>
      </section>
    `;
  }).join("");
  bindImageErrorHandlers(wrap);
}

/* ============================================================
   Page: Product detail — one piece + transaction CTA (brief §9)
   ============================================================ */
function productDetailRow(label, value) {
  if (!value) return "";
  return `
    <div class="product-detail-row">
      <span>${escapeHTML(label)}</span>
      <strong>${escapeHTML(value)}</strong>
    </div>
  `;
}

function renderProductPage(items) {
  const productPage = document.getElementById("product-page");
  if (!productPage) return;

  const id = new URLSearchParams(window.location.search).get("id");
  const item = id ? items.find(p => String(p.id).trim() === String(id).trim()) : null;

  // Only pieces poda has published (Live or Sold) are publicly viewable.
  const isPublic = item && (item.status === "Live" || item.status === "Sold");

  if (!item || !isPublic) {
    productPage.innerHTML = `
      <div class="product-error">
        <p>This piece isn't available.</p>
        <a class="product-link" href="drop.html">← Back to The Edit</a>
      </div>
    `;
    return;
  }

  const isSold = item.status === "Sold";
  const price = isSold ? itemSoldPrice(item) : itemListPrice(item);
  const status = displayStatus(item);

  document.title = `${item.itemName || item.id} — poda`;

  // Gallery: primary + any extra images.
  const images = [];
  if (getImageUrl(item)) images.push(getImageUrl(item));
  (item.images || []).forEach(u => { const s = String(u).trim(); if (s && !images.includes(s)) images.push(s); });
  const media = images.length
    ? images.map((u, idx) =>
        `<div class="product-media${idx === 0 ? " product-media--primary" : ""}"><img src="${escapeHTML(u)}" alt="${escapeHTML(itemImageAlt(item))}" decoding="async" loading="${idx === 0 ? "eager" : "lazy"}" /></div>`
      ).join("")
    : `<div class="product-media product-media--empty"><div class="product-placeholder">No image</div></div>`;

  productPage.innerHTML = `
    <article class="product-layout${isSold ? " product-layout--sold" : ""}">
      <div class="product-gallery">${media}</div>

      <div class="product-info">
        <p class="product-kicker">${escapeHTML(item.brand || sourceLabel(item))}</p>
        <h1 class="product-title">${escapeHTML(item.itemName || "Untitled Item")}</h1>
        <p class="product-subline">
          ${itemCode(item) ? `<span class="product-id">${escapeHTML(itemCode(item))}</span>` : ""}
          <span class="catalog-card__status catalog-card__status--${status.mod}">${escapeHTML(status.label)}</span>
        </p>
        ${price !== null ? `<p class="product-price">${isSold ? "Sold" : formatMoney(price)}</p>` : ""}

        ${transactionCTA(item)}

        <dl class="product-details">
          ${productDetailRow("Source", sourceLabel(item) + (item.sourceName ? ` · ${item.sourceName}` : ""))}
          ${productDetailRow("Category", item.category)}
          ${productDetailRow("Size", item.size)}
          ${productDetailRow("Measurements", item.measurements)}
          ${productDetailRow("Material", item.material)}
          ${productDetailRow("Color", item.color)}
          ${productDetailRow("Condition", item.condition)}
          ${productDetailRow("Condition notes", item.conditionNotes)}
          ${productDetailRow("Season / era", item.season)}
          ${dropNo(item) ? productDetailRow("Drop", dropNo(item)) : ""}
        </dl>

        ${item.publicDescription ? `<div class="product-note"><p>${escapeHTML(item.publicDescription)}</p></div>` : ""}
        ${item.selectionReason ? `<div class="product-selection"><span class="product-selection__label">Why poda selected it</span><p>${escapeHTML(item.selectionReason)}</p></div>` : ""}

        <div class="product-actions">
          <a class="product-link" href="drop.html">← Back to The Edit</a>
        </div>
      </div>
    </article>
  `;

  bindImageErrorHandlers(productPage);
}

/* ============================================================
   Page: Market Notes — research index, filtered by category
   ============================================================ */
let inboxNotes = [];
let inboxFilter = "all";

function noteDateLabel(note) {
  const d = note.publishedAt || note.createdAt;
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function inboxRowHTML(note) {
  const thumb = note.coverImage
    ? `<img src="${escapeHTML(note.coverImage)}" alt="" loading="lazy" decoding="async" />`
    : `<div class="inbox-thumb__placeholder"></div>`;
  const cat = String(note.category || "").toLowerCase();
  const catTag = cat ? `<span class="inbox-row__tag inbox-row__tag--${cat}">${escapeHTML(cat.toUpperCase())}</span>` : "";
  const issue = note.issueNumber ? `<span class="inbox-row__issue">No. ${escapeHTML(String(note.issueNumber))}</span>` : "";

  return `
    <a class="inbox-row" href="note.html?id=${encodeURIComponent(note.id)}">
      <div class="inbox-thumb">${thumb}</div>
      <div class="inbox-row__body">
        <span class="inbox-row__from">${issue || "poda"} ${catTag}</span>
        <span class="inbox-row__title">${escapeHTML(note.title || "Untitled")}</span>
        ${note.subtitle ? `<span class="inbox-row__preview">${escapeHTML(note.subtitle)}</span>` : ""}
      </div>
      <span class="inbox-row__date">${escapeHTML(noteDateLabel(note))}</span>
    </a>
  `;
}

function renderInbox() {
  const list = document.getElementById("inboxList");
  const empty = document.getElementById("marketNotesEmpty");
  if (!list) return;

  const published = inboxNotes.filter(n => n.status === "published");
  const filtered = inboxFilter === "all"
    ? published
    : published.filter(n => String(n.category || "").toLowerCase() === inboxFilter);

  if (!filtered.length) {
    list.innerHTML = `<p class="status-message">${published.length ? "Nothing in this category yet." : "No notes published yet."}</p>`;
    return;
  }
  if (empty) empty.remove();
  list.innerHTML = filtered.map(inboxRowHTML).join("");
}

function initInboxTabs() {
  const tabs = document.querySelectorAll("[data-note-filter]");
  if (!tabs.length) return;
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      inboxFilter = tab.dataset.noteFilter;
      renderInbox();
    });
  });
}

async function loadInbox() {
  const list = document.getElementById("inboxList");
  if (!list) return;
  try {
    inboxNotes = await window.PodaDB.getNotes();
    initInboxTabs();
    renderInbox();
  } catch (error) {
    console.error(error);
    const empty = document.getElementById("marketNotesEmpty");
    if (empty) empty.textContent = "Could not load notes — try refreshing.";
  }
}

/* ============================================================
   Boot — load whichever page we're on
   ============================================================ */
let publicItems = [];

async function loadInventory() {
  try {
    [publicItems, editDrops] = await Promise.all([
      window.PodaDB.getItems(),
      window.PodaDB.getDrops ? window.PodaDB.getDrops() : Promise.resolve([])
    ]);
  } catch (error) {
    console.error("Failed to read inventory:", error);
    publicItems = [];
  }
  editItems = publicItems;
  renderEdit();
  renderArchive(publicItems);
  renderProductPage(publicItems);
  if (typeof renderHome === "function") renderHome(publicItems, editDrops, inboxNotes);
}

if (document.getElementById("dropGrid") ||
    document.getElementById("archiveDrops") ||
    document.getElementById("product-page") ||
    document.getElementById("homeMount")) {
  loadInventory();
  if (window.PodaDB && window.PodaDB.onItemsChange) {
    window.PodaDB.onItemsChange(loadInventory);
  }
}

loadInbox();
