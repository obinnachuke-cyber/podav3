// Public site reads the same shared inventory the admin writes to the database.
const SUBSTACK_FEED_URL = "https://musicneedsmorethanmusic.substack.com/feed";

const productPage = document.getElementById("product-page");
const marketNotesSection = document.getElementById("market-notes");
const dashboardGrid = document.getElementById("itemsGrid");
const statusMessage = document.getElementById("statusMessage");
const searchInput = document.getElementById("searchInput");
const metricItems = document.getElementById("metricItems");
const metricClosetValue = document.getElementById("metricClosetValue");
const metricListedValue = document.getElementById("metricListedValue");
const metricSoldRevenue = document.getElementById("metricSoldRevenue");
const toggleButtons = dashboardGrid ? document.querySelectorAll(".toggle") : [];

const state = {
  items: [],
  activeFilter: "All",
  searchTerm: ""
};

function parseCSV(text) {
  const rows = [];
  let current = "";
  let row = [];
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && insideQuotes && next === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      insideQuotes = !insideQuotes;
    } else if (char === "," && !insideQuotes) {
      row.push(current.trim());
      current = "";
    } else if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(current.trim());
      if (row.some(cell => cell !== "")) rows.push(row);
      row = [];
      current = "";
    } else {
      current += char;
    }
  }

  row.push(current.trim());
  if (row.some(cell => cell !== "")) rows.push(row);

  return rows;
}

function normalizeHeader(header) {
  return header.trim().replace(/^\uFEFF/, "");
}

function rowsToObjects(rows) {
  if (!rows.length) return [];

  const headers = rows[0].map(normalizeHeader);

  return rows.slice(1).map(row => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = row[index] || "";
    });
    return item;
  }).filter(item => item.id || item.brand || item.name);
}

function parseMoney(value) {
  if (!value) return 0;

  const matches = String(value).match(/\$?\d+(?:,\d{3})*(?:\.\d+)?/g);
  if (!matches) return 0;

  const numbers = matches.map(num => Number(num.replace(/[$,]/g, ""))).filter(Number.isFinite);
  if (!numbers.length) return 0;

  return numbers.reduce((sum, num) => sum + num, 0) / numbers.length;
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value || 0);
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();

  if (normalized === "closet") return "Closet";
  if (normalized === "listed") return "Listed";
  if (normalized === "sold") return "Sold";

  return status || "Closet";
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  return doc.body.textContent.replace(/\s+/g, " ").trim();
}

function feedItemToPost(item) {
  const title = String(item.title || "").trim();
  const link = String(item.link || "").trim();
  const excerpt = stripHtml(item.description || "");

  if (!title || !link) return null;

  return { title, link, excerpt };
}

async function fetchSubstackFeedItems() {
  const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(SUBSTACK_FEED_URL)}`;
  const response = await fetch(apiUrl, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`rss2json request failed: ${response.status}`);
  }

  const data = await response.json();
  if (data.status !== "ok" || !Array.isArray(data.items)) {
    throw new Error("rss2json returned an invalid feed payload");
  }

  return data.items;
}

function populatePrimaryCard(card, post) {
  card.querySelector(".note-feature__title").textContent = post.title;
  card.querySelector(".note-feature__preview").textContent = post.excerpt;
  card.querySelector(".note-link").href = post.link;
}

function populateTeaserCard(card, post) {
  card.querySelector(".note-teaser__title").textContent = post.title;
  card.querySelector(".note-link").href = post.link;
}

function renderMarketNotes(postsBySlot) {
  const emptyMessage = document.getElementById("marketNotesEmpty");
  const primaryCard = marketNotesSection?.querySelector('[data-note-slot="primary"]');
  const secondaryCard = marketNotesSection?.querySelector('[data-note-slot="secondary"]');
  const tertiaryCard = marketNotesSection?.querySelector('[data-note-slot="tertiary"]');
  const noteRail = marketNotesSection?.querySelector(".note-rail");

  const showPrimary = Boolean(postsBySlot.primary);
  const showSecondary = Boolean(postsBySlot.secondary);
  const showTertiary = Boolean(postsBySlot.tertiary);

  if (primaryCard) {
    if (showPrimary) {
      populatePrimaryCard(primaryCard, postsBySlot.primary);
      primaryCard.hidden = false;
    } else {
      primaryCard.hidden = true;
    }
  }

  if (secondaryCard) {
    if (showSecondary) {
      populateTeaserCard(secondaryCard, postsBySlot.secondary);
      secondaryCard.hidden = false;
    } else {
      secondaryCard.hidden = true;
    }
  }

  if (tertiaryCard) {
    if (showTertiary) {
      populateTeaserCard(tertiaryCard, postsBySlot.tertiary);
      tertiaryCard.hidden = false;
    } else {
      tertiaryCard.hidden = true;
    }
  }

  if (noteRail) {
    noteRail.hidden = !(showSecondary || showTertiary);
  }

  const hasVisibleCards = showPrimary || showSecondary || showTertiary;

  if (emptyMessage) {
    emptyMessage.classList.toggle("hidden", hasVisibleCards);
  }
}

async function loadMarketNotes() {
  if (!marketNotesSection) return;

  try {
    const feedItems = await fetchSubstackFeedItems();

    // Use the three most recent posts, filling slots in order:
    // first → primary hero, second → secondary rail, third → tertiary rail.
    const posts = feedItems.slice(0, 3).map(feedItemToPost).filter(Boolean);

    renderMarketNotes({
      primary: posts[0] || null,
      secondary: posts[1] || null,
      tertiary: posts[2] || null
    });
  } catch (error) {
    console.error(error);
    renderMarketNotes({ primary: null, secondary: null, tertiary: null });
  }
}

function itemDetailHref(item) {
  const id = String(item.id || "").trim();
  if (!id) return "";
  return `item.html?id=${encodeURIComponent(id)}`;
}

function getListingUrl(item) {
  const platform = item.platform || {};
  const keys = ["grailedUrl", "depopUrl", "ebayUrl", "instagramUrl",
    "vestiaireUrl", "stockxUrl", "goatUrl", "archiveUrl", "otherUrl"];

  for (const key of keys) {
    const value = String(platform[key] || "").trim();
    if (value) return value;
  }

  return "";
}

function getImageUrl(item) {
  if (item.primaryImage) return String(item.primaryImage).trim();
  if (Array.isArray(item.images) && item.images.length) return String(item.images[0]).trim();
  return "";
}

function itemImageAlt(item) {
  return `${item.brand || "Closet item"} ${item.itemName || ""}`.trim();
}

function itemListPrice(item) {
  return num(item.pricing && item.pricing.currentListPrice);
}

function itemSoldPrice(item) {
  return num(item.soldActuals && item.soldActuals.finalSalePrice);
}

function renderCardImageContent(item) {
  const imageUrl = getImageUrl(item);

  if (!imageUrl) {
    return `<div class="image-placeholder">No image</div>`;
  }

  return `<img src="${escapeHTML(imageUrl)}" alt="${escapeHTML(itemImageAlt(item))}" loading="lazy" decoding="async" />`;
}

function renderProductImageContent(item) {
  const imageUrl = getImageUrl(item);

  if (!imageUrl) {
    return `<div class="product-placeholder">No image</div>`;
  }

  return `<img src="${escapeHTML(imageUrl)}" alt="${escapeHTML(itemImageAlt(item))}" decoding="async" />`;
}

function handleImageError(event) {
  const img = event.currentTarget;
  const container = img.closest(".item-image, .product-media");

  if (container) {
    container.classList.add("is-missing-image");
    img.remove();
  }
}

function bindImageErrorHandlers(root) {
  if (!root) return;

  root.querySelectorAll(".item-image img, .product-media img").forEach(img => {
    img.addEventListener("error", handleImageError, { once: true });
  });
}

function calculateMetrics(items) {
  const hasMetrics = metricItems || metricClosetValue || metricListedValue || metricSoldRevenue;
  if (!hasMetrics) return;

  const closetCount = items.filter(item => cleanStatus(item.status) === "Closet").length;

  const listedValue = items
    .filter(item => cleanStatus(item.status) === "Listed")
    .reduce((sum, item) => sum + itemListPrice(item), 0);

  const soldRevenue = items
    .filter(item => cleanStatus(item.status) === "Sold")
    .reduce((sum, item) => sum + itemSoldPrice(item), 0);

  if (metricItems) metricItems.textContent = items.length;
  if (metricClosetValue) metricClosetValue.textContent = closetCount;
  if (metricListedValue) metricListedValue.textContent = formatMoney(listedValue);
  if (metricSoldRevenue) metricSoldRevenue.textContent = formatMoney(soldRevenue);
}

function getFilteredItems() {
  return state.items.filter(item => {
    const statusMatch = state.activeFilter === "All" || cleanStatus(item.status) === state.activeFilter;
    const searchableText = [
      item.brand,
      item.itemName,
      item.category,
      item.status,
      item.size,
      item.color,
      item.publicDescription
    ].join(" ").toLowerCase();

    const searchMatch = searchableText.includes(state.searchTerm.toLowerCase());

    return statusMatch && searchMatch;
  });
}

function itemCard(item) {
  const status = cleanStatus(item.status);
  const listingUrl = getListingUrl(item);
  const soldClass = status === "Sold" ? " archive-card--sold" : "";
  const detailHref = itemDetailHref(item);
  const assetLinkOpen = detailHref
    ? `<a class="item-card__asset-link" href="${escapeHTML(detailHref)}">`
    : "";
  const assetLinkClose = detailHref ? "</a>" : "";
  const titleInner = detailHref
    ? `<a class="item-card__asset-link item-card__asset-link--title" href="${escapeHTML(detailHref)}">${escapeHTML(item.itemName || "Untitled Item")}</a>`
    : escapeHTML(item.itemName || "Untitled Item");

  // Public-facing price only: list price while Listed, sale price once Sold.
  const price = status === "Sold" ? itemSoldPrice(item) : itemListPrice(item);
  const priceLabel = status === "Sold" ? "Sold For" : "List Price";
  const showPrice = status !== "Closet" && price > 0;

  return `
    <article class="item-card archive-card${soldClass}">
      ${assetLinkOpen}
      <div class="item-image${getImageUrl(item) ? "" : " item-image--empty"}">
        <span class="card-corner-tag">${escapeHTML(status)}</span>
        ${renderCardImageContent(item)}
      </div>
      ${assetLinkClose}
      <div class="item-body">
        <div class="item-body__hero">
          <p class="brand">${escapeHTML(item.brand || "Unknown Brand")}</p>
          <div class="item-body__title-row">
            <h2 class="item-title">${titleInner}</h2>
            <span class="badge">${escapeHTML(status)}</span>
          </div>
        </div>

        <dl class="item-ledger">
          <div class="item-ledger__row">
            <dt>Listing</dt>
            <dd>${status === "Listed" && listingUrl
              ? `<a class="external-listing" href="${escapeHTML(listingUrl)}" target="_blank" rel="noopener">View listing ↗</a>`
              : `<span class="ledger-muted">Not listed</span>`}</dd>
          </div>
          <div class="item-ledger__row">
            <dt>Size</dt>
            <dd>${escapeHTML(item.size || "—")}</dd>
          </div>
          <div class="item-ledger__row">
            <dt>Condition</dt>
            <dd>${escapeHTML(item.condition || "—")}</dd>
          </div>
          ${showPrice
            ? `<div class="item-ledger__row">
            <dt>${priceLabel}</dt>
            <dd>${formatMoney(price)}</dd>
          </div>`
            : ""}
        </dl>

        <div class="detail-grid">
          <div class="detail">
            <span>Category</span>
            <strong>${escapeHTML(item.category || "—")}</strong>
          </div>
          <div class="detail">
            <span>Color</span>
            <strong>${escapeHTML(item.color || "—")}</strong>
          </div>
        </div>

        ${item.publicDescription ? `<p class="thesis">${escapeHTML(item.publicDescription)}</p>` : ""}

        <div class="item-card__actions">
          ${detailHref ? `<a class="asset-link" href="${escapeHTML(detailHref)}">View asset</a>` : ""}
        </div>
      </div>
    </article>
  `;
}

function renderDashboard() {
  if (!dashboardGrid) return;

  const filtered = getFilteredItems();

  calculateMetrics(state.items);

  if (!state.items.length) {
    if (statusMessage) {
      statusMessage.textContent = "No pieces yet. Add items in the admin and they'll appear here.";
      statusMessage.classList.remove("hidden");
    }
    dashboardGrid.innerHTML = "";
    return;
  }

  if (!filtered.length) {
    if (statusMessage) {
      statusMessage.textContent = "No items match this filter/search.";
      statusMessage.classList.remove("hidden");
    }
    dashboardGrid.innerHTML = "";
    return;
  }

  if (statusMessage) statusMessage.classList.add("hidden");
  dashboardGrid.innerHTML = filtered.map(itemCard).join("");
  bindImageErrorHandlers(dashboardGrid);
}

function productDetailRow(label, value) {
  return `
    <div class="product-detail-row">
      <span>${escapeHTML(label)}</span>
      <strong>${escapeHTML(value || "—")}</strong>
    </div>
  `;
}

function renderProductPage(items) {
  if (!productPage) return;

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");

  if (!items.length) {
    productPage.innerHTML = `
      <div class="product-error">
        <p>Closet data could not be loaded.</p>
        <a class="product-link" href="index.html#closet-capital">← Back to portfolio</a>
      </div>
    `;
    return;
  }

  if (!id) {
    productPage.innerHTML = `
      <div class="product-error">
        <p>Asset not found.</p>
        <a class="product-link" href="index.html#closet-capital">← Back to portfolio</a>
      </div>
    `;
    return;
  }

  const item = items.find(piece => String(piece.id).trim() === String(id).trim());

  if (!item) {
    productPage.innerHTML = `
      <div class="product-error">
        <p>Asset not found.</p>
        <a class="product-link" href="index.html#closet-capital">← Back to portfolio</a>
      </div>
    `;
    return;
  }

  const status = cleanStatus(item.status);
  const listingUrl = getListingUrl(item);
  const soldClass = status === "Sold" ? " product-layout--sold" : "";

  const price = status === "Sold" ? itemSoldPrice(item) : itemListPrice(item);
  const priceLabel = status === "Sold" ? "Sold For" : "List Price";
  const showPrice = status !== "Closet" && price > 0;

  document.title = `${item.itemName || item.id} — Poda Closet`;

  productPage.innerHTML = `
    <article class="product-layout${soldClass}">
      <div class="product-media${getImageUrl(item) ? "" : " product-media--empty"}">
        ${renderProductImageContent(item)}
      </div>

      <div class="product-info">
        <p class="product-kicker">${escapeHTML(item.brand || "Unknown Brand")}</p>
        <h1 class="product-title">${escapeHTML(item.itemName || "Untitled Item")}</h1>
        <p class="product-status"><span class="badge">${escapeHTML(status)}</span></p>

        ${status === "Listed" && listingUrl
          ? `<p class="product-listing-cta">
              <a class="product-link external-listing" href="${escapeHTML(listingUrl)}" target="_blank" rel="noopener">View listing ↗</a>
            </p>`
          : ""}

        <dl class="product-details">
          ${productDetailRow("Category", item.category)}
          ${productDetailRow("Status", status)}
          ${productDetailRow("Size", item.size)}
          ${productDetailRow("Condition", item.condition)}
          ${productDetailRow("Color", item.color)}
          ${showPrice ? productDetailRow(priceLabel, formatMoney(price)) : ""}
        </dl>

        ${item.publicDescription ? `<div class="product-note"><p>${escapeHTML(item.publicDescription)}</p></div>` : ""}

        <div class="product-actions">
          <a class="product-link" href="index.html#closet-capital">← Back to portfolio</a>
        </div>
      </div>
    </article>
  `;

  bindImageErrorHandlers(productPage);
}

function initDashboard() {
  if (!dashboardGrid) return;

  toggleButtons.forEach(button => {
    button.addEventListener("click", () => {
      toggleButtons.forEach(btn => btn.classList.remove("active"));
      button.classList.add("active");
      state.activeFilter = button.dataset.filter;
      renderDashboard();
    });
  });

  if (searchInput) {
    searchInput.addEventListener("input", event => {
      state.searchTerm = event.target.value;
      renderDashboard();
    });
  }
}

async function loadCloset() {
  try {
    state.items = await window.PodaDB.getItems();
  } catch (error) {
    console.error("Failed to read inventory:", error);
    state.items = [];
  }

  if (dashboardGrid) renderDashboard();
  if (productPage) renderProductPage(state.items);
}

initDashboard();
loadCloset();
loadMarketNotes();

// Live-update the public site whenever the admin changes the inventory.
if (window.PodaDB && window.PodaDB.onItemsChange) {
  window.PodaDB.onItemsChange(loadCloset);
}
