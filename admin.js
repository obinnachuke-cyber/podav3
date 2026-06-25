/* ============================================================
   Poda Capital — Admin (Closet OS)
   Vanilla JS. localStorage-backed inventory operating system.
   Separated into: constants, storage, calc, formatting/helpers,
   view renderers, modal form (build / read / recalc / save).
   ============================================================ */

"use strict";

/* —— Constants —— */
const STORAGE_KEY = "poda_inventory";

const CATEGORIES = ["Shirt", "Jacket", "Pants", "Denim", "Knit", "Shoe", "Bag", "Accessory", "Other"];
const CONDITIONS = ["New", "Excellent", "Very Good", "Good", "Fair"];
const STATUSES = ["Closet", "Listed", "Sold"];
const PURCHASE_PLATFORMS = ["Grailed", "Depop", "eBay", "Instagram", "Vestiaire", "StockX", "GOAT", "Archive", "Other"];
const SOLD_PLATFORMS = ["Grailed", "Depop", "eBay", "Instagram", "Vestiaire", "StockX", "GOAT", "Archive", "Direct", "Other"];

// Typical all-in fee % per platform. The expected economics use a single ASSUMED
// fee = the average of these (actual fees are entered at the Sale stage).
const STANDARD_PLATFORM_FEES = {
  Grailed: 9, Depop: 10, eBay: 13, Instagram: 3, Vestiaire: 15, StockX: 9, GOAT: 9.5, Archive: 10, Other: 10
};
const ASSUMED_FEE_PCT = (() => {
  const values = Object.values(STANDARD_PLATFORM_FEES);
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
})();

// All potential listing platforms → the platform key holding that URL.
const LISTING_URL_FIELDS = [
  ["Grailed", "grailedUrl"], ["Depop", "depopUrl"], ["eBay", "ebayUrl"],
  ["Instagram", "instagramUrl"], ["Vestiaire", "vestiaireUrl"], ["StockX", "stockxUrl"],
  ["GOAT", "goatUrl"], ["Archive", "archiveUrl"], ["Other", "otherUrl"]
];

// Lifecycle is linear: Closet → Listed → Sold. You can move one step forward or
// back. Status is changed only from the card/row dropdown, never inside the form.
const STAGE_INDEX = { Closet: 0, Listed: 1, Sold: 2 };

const TRANSITIONS = {
  Closet: ["Closet", "Listed"],
  Listed: ["Closet", "Listed", "Sold"],
  Sold: ["Listed", "Sold"]
};

// Fields owned by each lifecycle stage (dot-paths into the item). Used to CLEAR a
// stage's data when an item is reverted below it — that info must be re-entered.
// (Acquisition / Closet is the base stage and is never cleared.)
const STAGE_FIELDS = {
  Listed: [
    "season", "dateListed", "pricing.currentListPrice",
    "platform.grailedUrl", "platform.depopUrl", "platform.ebayUrl", "platform.instagramUrl",
    "platform.vestiaireUrl", "platform.stockxUrl", "platform.goatUrl", "platform.archiveUrl", "platform.otherUrl",
    "platform.estimatedShipping", "platform.buyerPaysShipping", "platform.sellerPaysShipping"
  ],
  Sold: [
    "dateSold", "soldActuals.soldPlatform", "soldActuals.finalSalePrice",
    "soldActuals.finalPlatformFee", "soldActuals.finalPaymentFee", "soldActuals.finalShipping"
  ]
};

// Inputs required to legitimately sit at each stage (e.g. you can't be Sold without
// a Sale Price). Any reached-stage requirement left blank is flagged on the card.
const REQUIRED_FIELDS = {
  Closet: [["dateAcquired", "Date Acquired"], ["costs.purchasePrice", "Cost"]],
  Listed: [["pricing.currentListPrice", "Listing Price"]],
  Sold: [["dateSold", "Date Sold"], ["soldActuals.soldPlatform", "Sold Platform"], ["soldActuals.finalSalePrice", "Sale Price"]]
};

/* —— App state —— */
const state = {
  items: [],
  view: "dashboard",
  editingId: null,        // id being edited, or null for a new item
  draftImages: [],        // images in the open modal
  draftPrimary: "",       // primary image (data URL / URL) in the open modal
  filters: { status: "All", category: "All", brand: "", platform: "All" }
};

/* ============================================================
   Storage
   ============================================================ */
// Read all items from the shared database (Supabase).
async function loadItems() {
  return await window.PodaDB.getItems();
}

function getItemById(id) {
  return state.items.find(item => item.id === id) || null;
}

// Create/update one item: update local state immediately, then save to the DB.
async function upsertItem(item) {
  const index = state.items.findIndex(existing => existing.id === item.id);
  if (index >= 0) state.items[index] = item;
  else state.items.push(item);
  try {
    await window.PodaDB.upsertItem(item);
  } catch (error) {
    alert("Could not save to the database. Check your connection and try again.");
    throw error;
  }
}

async function deleteItemById(id) {
  state.items = state.items.filter(item => item.id !== id);
  try {
    await window.PodaDB.deleteItem(id);
  } catch (error) {
    alert("Could not delete from the database. Check your connection and try again.");
    throw error;
  }
}

/* —— Blank item factory (keeps the data model in one place) —— */
function blankItem() {
  return {
    id: "",
    images: [],
    primaryImage: "",
    brand: "",
    brandCode: "",
    itemName: "",
    season: "",
    category: "",
    size: "",
    color: "",
    condition: "",
    status: "Closet",
    dateAcquired: "",
    dateListed: "",
    dateSold: "",
    source: "",
    purchasePlatform: "",
    publicDescription: "",
    privateNotes: "",
    costs: {
      purchasePrice: 0, inboundShipping: 0, tax: 0,
      cleaningCost: 0, repairCost: 0, authCost: 0, otherPrepCost: 0
    },
    pricing: {
      originalListPrice: 0, currentListPrice: 0, expectedSalePrice: 0,
      lowestAcceptablePrice: 0, markdownPlan: "",
      compLow: 0, compMid: 0, compHigh: 0, compConfidence: ""
    },
    platform: {
      primaryPlatform: "", websiteListed: false,
      grailedUrl: "", depopUrl: "", ebayUrl: "", instagramUrl: "",
      vestiaireUrl: "", stockxUrl: "", goatUrl: "", archiveUrl: "", otherUrl: "",
      platformFeePercent: 0, paymentFeePercent: 0, estimatedShipping: 0,
      buyerPaysShipping: false, sellerPaysShipping: false
    },
    soldActuals: {
      dateSold: "", soldPlatform: "", finalSalePrice: 0,
      finalPlatformFee: 0, finalPaymentFee: 0, finalShipping: 0
    }
  };
}

/* ============================================================
   Calculations — single source of truth
   ============================================================ */
function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function daysBetween(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.floor((end - start) / 86400000);
}

function agingStatusFor(days) {
  if (days === null || days === undefined) return null;
  if (days <= 14) return "Fresh";
  if (days <= 30) return "Monitor";
  if (days <= 60) return "Consider Markdown";
  if (days <= 90) return "Reposition";
  return "Stale";
}

/**
 * calc(item) — returns ALL derived values for an item.
 * Every view and the form read from this; no math lives elsewhere.
 */
function calc(item) {
  const c = item.costs || {};
  const p = item.pricing || {};
  const pl = item.platform || {};
  const sa = item.soldActuals || {};

  const totalCostBasis =
    num(c.purchasePrice) + num(c.inboundShipping) + num(c.tax) +
    num(c.cleaningCost) + num(c.repairCost) + num(c.authCost) + num(c.otherPrepCost);

  const estimatedShipping = num(pl.estimatedShipping);
  const sellerShips = Boolean(pl.sellerPaysShipping);

  // Expected economics are derived from the Listing Price using the assumed fee %.
  const currentListPrice = num(p.currentListPrice);
  const feeFraction = ASSUMED_FEE_PCT / 100;
  const expectedFee = currentListPrice * feeFraction;
  const expectedNetPayout = currentListPrice - expectedFee - (sellerShips ? estimatedShipping : 0);
  const expectedNetProfit = expectedNetPayout - totalCostBasis;
  const expectedMargin = expectedNetPayout > 0 ? expectedNetProfit / expectedNetPayout : 0;
  const breakEvenPrice = feeFraction < 1
    ? totalCostBasis / (1 - feeFraction) + (sellerShips ? estimatedShipping : 0)
    : 0;
  const markupPercent = totalCostBasis > 0 ? (currentListPrice - totalCostBasis) / totalCostBasis : 0;

  // Sold actuals
  const finalSalePrice = num(sa.finalSalePrice);
  const finalNetPayout =
    finalSalePrice - num(sa.finalPlatformFee) - num(sa.finalPaymentFee) - num(sa.finalShipping);
  const finalNetProfit = finalNetPayout - totalCostBasis;
  const finalMargin = finalNetPayout > 0 ? finalNetProfit / finalNetPayout : 0;

  const today = new Date().toISOString().slice(0, 10);
  const soldDate = sa.dateSold || item.dateSold;
  const daysToSell = (item.dateListed && soldDate) ? daysBetween(item.dateListed, soldDate) : null;
  const daysListed = (item.dateListed && item.status !== "Sold") ? daysBetween(item.dateListed, today) : null;

  const needsMarkdown = daysListed !== null && daysListed >= 30 && item.status === "Listed";

  return {
    totalCostBasis,
    expectedFee, expectedNetPayout, expectedNetProfit, expectedMargin,
    breakEvenPrice, markupPercent,
    finalNetPayout, finalNetProfit, finalMargin,
    daysToSell, daysListed,
    agingStatus: agingStatusFor(daysListed),
    needsMarkdown
  };
}

/* ============================================================
   Dashboard metrics — across all items
   ============================================================ */
function dashboardMetrics(items) {
  const active = items.filter(item => item.status !== "Sold");    // Closet + Listed
  const listed = items.filter(item => item.status === "Listed");  // up for sale
  const sold = items.filter(item => item.status === "Sold");

  const inventoryAtCost = active.reduce((sum, item) => sum + calc(item).totalCostBasis, 0);
  const listedValue = listed.reduce((sum, item) => sum + num(item.pricing.currentListPrice), 0);
  const expectedSaleValue = active.reduce((sum, item) => sum + num(item.pricing.currentListPrice), 0);
  const expectedNetProfit = active.reduce((sum, item) => sum + calc(item).expectedNetProfit, 0);
  const realizedProfit = sold.reduce((sum, item) => sum + calc(item).finalNetProfit, 0);
  const capitalTiedUp = active.reduce((sum, item) => sum + calc(item).totalCostBasis, 0);

  const listedDays = listed.map(item => calc(item).daysListed).filter(days => days !== null);
  const averageDaysListed = listedDays.length
    ? listedDays.reduce((sum, days) => sum + days, 0) / listedDays.length
    : 0;

  const sellThroughDenominator = sold.length + listed.length;
  const sellThroughRate = sellThroughDenominator > 0 ? sold.length / sellThroughDenominator : 0;

  const itemsNeedingMarkdown = items.filter(item => calc(item).needsMarkdown).length;

  return {
    activeItems: active.length,
    inventoryAtCost,
    listedValue,
    expectedSaleValue,
    expectedNetProfit,
    realizedProfit,
    capitalTiedUp,
    averageDaysListed,
    sellThroughRate,
    itemsNeedingMarkdown
  };
}

/* ============================================================
   Formatting helpers
   ============================================================ */
function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0
  }).format(num(value));
}

function formatMoney2(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(num(value));
}

function formatPercent(fraction) {
  return `${(num(fraction) * 100).toFixed(1)}%`;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusBadgeClass(status) {
  const map = {
    "Closet": "badge--draft",   // dim — held in closet
    "Listed": "badge--listed",  // purple — up for sale
    "Sold": "badge--sold"       // faint / strikethrough
  };
  return map[status] || "badge--draft";
}

function agingClass(label) {
  const map = {
    "Fresh": "aging--fresh",
    "Monitor": "aging--monitor",
    "Consider Markdown": "aging--markdown",
    "Reposition": "aging--reposition",
    "Stale": "aging--stale"
  };
  return map[label] || "";
}

function statusBadge(status) {
  return `<span class="badge ${statusBadgeClass(status)}">${escapeHTML(status || "—")}</span>`;
}

function primaryImageUrl(item) {
  if (item.primaryImage) return item.primaryImage;
  if (Array.isArray(item.images) && item.images.length) return item.images[0];
  return "";
}

function thumbCell(item) {
  const url = primaryImageUrl(item);
  if (!url) return `<span class="table-thumb table-thumb--empty">No img</span>`;
  return `<img class="table-thumb" src="${escapeHTML(url)}" alt="" loading="lazy" />`;
}

function profitCellClass(value) {
  return value >= 0 ? "cell-pos" : "cell-neg";
}

/* —— Inline status dropdown (only valid transitions; locked when Sold) —— */
function statusSelect(item) {
  const allowed = TRANSITIONS[item.status] || [item.status];
  const options = allowed.map(status =>
    `<option value="${escapeHTML(status)}"${status === item.status ? " selected" : ""}>${escapeHTML(status)}</option>`
  ).join("");
  const locked = allowed.length <= 1 ? " disabled" : "";
  return `<select class="status-select" data-status-for="${escapeHTML(item.id)}"${locked} aria-label="Status">${options}</select>`;
}

/* ============================================================
   Item ID generation
   ============================================================ */
function makeBrandCode(brand) {
  return String(brand || "").toUpperCase().replace(/\s+/g, "").slice(0, 8);
}

function generateItemId(item) {
  const yearSource = item.dateAcquired ? new Date(item.dateAcquired).getFullYear() : new Date().getFullYear();
  const yy = String(yearSource).slice(-2);
  const brandCode = (item.brandCode || makeBrandCode(item.brand) || "UNK").toUpperCase().replace(/\s+/g, "");
  const season = (item.season ? item.season.toUpperCase().replace(/\s+/g, "") : "") || "UNK";
  const category = (item.category || "ITEM").toUpperCase();
  const prefix = `PODA-${yy}-${brandCode}-${season}-${category}-`;

  // Find the next free 3-digit sequence for this prefix.
  let max = 0;
  for (const existing of state.items) {
    if (existing.id && existing.id.startsWith(prefix) && existing.id !== item.id) {
      const tail = Number(existing.id.slice(prefix.length));
      if (Number.isFinite(tail) && tail > max) max = tail;
    }
  }
  const seq = String(max + 1).padStart(3, "0");
  return `${prefix}${seq}`;
}

/* ============================================================
   View routing
   ============================================================ */
const adminMain = document.getElementById("adminMain");

function setView(view) {
  state.view = view;
  document.querySelectorAll(".admin-nav__link").forEach(link => {
    link.classList.toggle("active", link.dataset.view === view);
  });
  renderCurrentView();
}

function renderCurrentView() {
  const renderers = {
    dashboard: renderDashboard,
    all: renderAllItems,
    closet: renderCloset,
    listed: renderListed,
    sold: renderSold
  };
  (renderers[state.view] || renderDashboard)();
}

function sectionBar(label, title, withAction = true) {
  return `
    <div class="section-bar section-bar--admin">
      <span class="section-bar__label">${escapeHTML(label)}</span>
      <span class="section-bar__title">${escapeHTML(title)}</span>
      ${withAction ? `<button type="button" class="admin-newitem section-bar__action" data-new-item>+ New Item</button>` : ""}
    </div>
  `;
}

/* ============================================================
   View: Dashboard
   ============================================================ */
function metricCard(label, value, note) {
  return `
    <article class="metric-card">
      <span>${escapeHTML(label)}</span>
      <strong>${value}</strong>
      ${note ? `<small>${escapeHTML(note)}</small>` : ""}
    </article>
  `;
}

function renderDashboard() {
  const m = dashboardMetrics(state.items);

  const metrics = [
    metricCard("Active Items", m.activeItems),
    metricCard("Inventory at Cost", formatMoney(m.inventoryAtCost)),
    metricCard("Listed Value", formatMoney(m.listedValue)),
    metricCard("Expected Sale Value", formatMoney(m.expectedSaleValue)),
    metricCard("Expected Net Profit", formatMoney(m.expectedNetProfit)),
    metricCard("Realized Profit", formatMoney(m.realizedProfit)),
    metricCard("Capital Tied Up", formatMoney(m.capitalTiedUp)),
    metricCard("Avg Days Listed", m.averageDaysListed ? m.averageDaysListed.toFixed(0) : "0"),
    metricCard("Sell-Through Rate", formatPercent(m.sellThroughRate)),
    metricCard("Needs Markdown", m.itemsNeedingMarkdown)
  ].join("");

  // 5 most recently added/modified — proxy "recent" by array order (newest pushed last).
  const recent = [...state.items].slice(-5).reverse();

  const recentTable = recent.length
    ? `
      <div class="table-wrap">
        <table class="admin-table">
          <thead>
            <tr><th></th><th>Item ID</th><th>Brand</th><th>Name</th><th>Status</th><th class="cell-num">List Price</th></tr>
          </thead>
          <tbody>
            ${recent.map(item => `
              <tr data-edit-id="${escapeHTML(item.id)}">
                <td>${thumbCell(item)}</td>
                <td class="cell-mono">${escapeHTML(item.id)}</td>
                <td class="cell-strong">${escapeHTML(item.brand)}</td>
                <td>${escapeHTML(item.itemName)}</td>
                <td>${statusBadge(item.status)}</td>
                <td class="cell-num">${formatMoney(item.pricing.currentListPrice)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `
    : `<p class="admin-empty">No items yet. Use “+ New Item” to add your first piece.</p>`;

  adminMain.innerHTML = `
    ${sectionBar("Closet OS", "Dashboard")}
    <section class="metrics-grid metrics-grid--admin" aria-label="Dashboard metrics">${metrics}</section>
    <div class="section-bar"><span class="section-bar__title">Recently Updated</span></div>
    ${recentTable}
  `;
}

/* ============================================================
   View: All Items
   ============================================================ */
function uniqueValues(selector) {
  return [...new Set(state.items.map(selector).filter(Boolean))].sort();
}

function filterBar() {
  const statusOptions = ["All", ...STATUSES].map(s =>
    `<option value="${escapeHTML(s)}"${state.filters.status === s ? " selected" : ""}>${escapeHTML(s)}</option>`).join("");
  const categoryOptions = ["All", ...CATEGORIES].map(c =>
    `<option value="${escapeHTML(c)}"${state.filters.category === c ? " selected" : ""}>${escapeHTML(c)}</option>`).join("");
  const platformOptions = ["All", ...uniqueValues(item => item.purchasePlatform)].map(p =>
    `<option value="${escapeHTML(p)}"${state.filters.platform === p ? " selected" : ""}>${escapeHTML(p)}</option>`).join("");

  return `
    <section class="controls" aria-label="Filters">
      <label class="field" style="max-width:200px">
        <span style="font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:var(--text-faint)">Status</span>
        <select class="status-select" data-filter="status">${statusOptions}</select>
      </label>
      <label class="field" style="max-width:200px">
        <span style="font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:var(--text-faint)">Category</span>
        <select class="status-select" data-filter="category">${categoryOptions}</select>
      </label>
      <label class="field" style="max-width:200px">
        <span style="font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:var(--text-faint)">Platform</span>
        <select class="status-select" data-filter="platform">${platformOptions}</select>
      </label>
      <label class="search-wrap" style="flex:1 1 200px">
        <span class="visually-hidden">Brand filter</span>
        <input type="search" data-filter="brand" placeholder="Filter by brand…" value="${escapeHTML(state.filters.brand)}" autocomplete="off" />
      </label>
    </section>
  `;
}

function applyFilters(items) {
  const f = state.filters;
  return items.filter(item => {
    if (f.status !== "All" && item.status !== f.status) return false;
    if (f.category !== "All" && item.category !== f.category) return false;
    if (f.platform !== "All" && item.purchasePlatform !== f.platform) return false;
    if (f.brand && !String(item.brand).toLowerCase().includes(f.brand.toLowerCase())) return false;
    return true;
  });
}

function renderAllItems() {
  const rows = applyFilters(state.items).map(item => {
    const d = calc(item);
    return `
      <tr data-edit-id="${escapeHTML(item.id)}">
        <td>${thumbCell(item)}</td>
        <td class="cell-mono">${escapeHTML(item.id)}</td>
        <td class="cell-strong">${escapeHTML(item.brand)}</td>
        <td>${escapeHTML(item.itemName)}</td>
        <td>${escapeHTML(item.category)}</td>
        <td>${escapeHTML(item.size)}</td>
        <td data-no-edit>${statusSelect(item)}</td>
        <td class="cell-num">${formatMoney(d.totalCostBasis)}</td>
        <td class="cell-num">${formatMoney(item.pricing.currentListPrice)}</td>
        <td class="cell-num ${profitCellClass(d.expectedNetProfit)}">${formatMoney(d.expectedNetProfit)}</td>
        <td class="cell-num">${d.daysListed === null ? "—" : d.daysListed}</td>
        <td>${d.agingStatus ? `<span class="aging ${agingClass(d.agingStatus)}">${escapeHTML(d.agingStatus)}</span>` : "—"}</td>
      </tr>
    `;
  }).join("");

  adminMain.innerHTML = `
    ${sectionBar("Closet OS", "All Items")}
    ${filterBar()}
    ${state.items.length === 0
      ? `<p class="admin-empty">No items yet.</p>`
      : `<div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th></th><th>Item ID</th><th>Brand</th><th>Name</th><th>Category</th><th>Size</th>
                <th>Status</th><th class="cell-num">Cost Basis</th><th class="cell-num">List Price</th>
                <th class="cell-num">Exp. Profit</th><th class="cell-num">Days Listed</th><th>Aging</th>
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="12" class="admin-empty">No items match these filters.</td></tr>`}</tbody>
          </table>
        </div>`
    }
  `;
}

/* ============================================================
   Item card — shared across Closet / Listed / Sold for consistent
   styling. Each view supplies its own ledger pairs + extra content.
   ============================================================ */
function itemImageBlock(item) {
  const url = primaryImageUrl(item);
  const inner = url
    ? `<img src="${escapeHTML(url)}" alt="" loading="lazy" />`
    : `<div class="image-placeholder">No image</div>`;
  return `<div class="item-image${url ? "" : " item-image--empty"}">${inner}</div>`;
}

// pairs: array of [label, valueHTML]. valueHTML is inserted as-is, so callers
// must escape any free text themselves.
function ledgerHtml(pairs) {
  return pairs.map(([label, value]) =>
    `<div class="item-ledger__row"><dt>${escapeHTML(label)}</dt><dd>${value}</dd></div>`
  ).join("");
}

function listingLink(item) {
  const platform = item.platform || {};
  const url = LISTING_URL_FIELDS.map(([, key]) => platform[key]).find(Boolean) || "";
  return url
    ? `<a class="card-link external-listing" href="${escapeHTML(url)}" target="_blank" rel="noopener">View listing ↗</a>`
    : "";
}

function cardSection(title, pairs, extra = "") {
  return `
    <div class="card-section">
      <p class="card-section__title">${escapeHTML(title)}</p>
      <dl class="item-ledger">${ledgerHtml(pairs)}</dl>
      ${extra}
    </div>
  `;
}

function metaLine(item) {
  const bits = [item.size, item.condition, item.color].map(v => String(v || "").trim()).filter(Boolean);
  return bits.length ? `<p class="card-meta">${escapeHTML(bits.join(" · "))}</p>` : "";
}

function hasListingUrl(item) {
  const platform = item.platform || {};
  return LISTING_URL_FIELDS.some(([, key]) => String(platform[key] || "").trim() !== "");
}

// Every required input still blank for the stages this item has reached. Returns the
// full list so the card shows ALL gaps at once, not just the first.
function gapsFor(item) {
  const reached = STAGE_INDEX[item.status] ?? 0;
  const gaps = [];

  Object.entries(REQUIRED_FIELDS).forEach(([stage, fields]) => {
    if ((STAGE_INDEX[stage] ?? 0) > reached) return;
    fields.forEach(([path, label]) => {
      const value = getByPath(item, path);
      // 0 is a valid value (e.g. free item, $0 cost) — only flag truly blank/missing
      if (value === undefined || value === null || value === "") gaps.push(label);
    });
  });

  // Checks that aren't a single field. A listing needs a photo and at least one URL.
  if (reached >= STAGE_INDEX.Listed) {
    if (!primaryImageUrl(item)) gaps.push("Photo");
    if (!hasListingUrl(item)) gaps.push("Listing URL");
  }

  return gaps;
}

function gapsBlock(item) {
  const gaps = gapsFor(item);
  if (!gaps.length) return "";
  return `
    <div class="card-gaps">
      <span class="card-gaps__label">⚠ Missing</span>
      ${gaps.map(g => `<span class="flag">${escapeHTML(g)}</span>`).join("")}
    </div>
  `;
}

// One card used by Closet / Listed / Sold. Shows the info groups for the item's
// current stage: Acquisition always, Listing once Listed, Sale once Sold.
function itemCard(item) {
  const d = calc(item);
  const stage = STAGE_INDEX[item.status] ?? 0;

  const acquisition = cardSection("Acquisition", [
    ["Date Acquired", escapeHTML(item.dateAcquired || "—")],
    ["Source", escapeHTML(item.source || "—")],
    ["Purchase Platform", escapeHTML(item.purchasePlatform || "—")],
    ["Cost Basis", formatMoney(d.totalCostBasis)]
  ]);

  let listing = "";
  if (stage >= STAGE_INDEX.Listed) {
    const aging = d.agingStatus
      ? `<p class="card-aging aging ${agingClass(d.agingStatus)}">${escapeHTML(d.agingStatus)}</p>`
      : "";
    listing = cardSection("Listing", [
      ["List Price", formatMoney(item.pricing.currentListPrice)],
      ["Exp. Profit", `<span class="${profitCellClass(d.expectedNetProfit)}">${formatMoney(d.expectedNetProfit)}</span>`],
      ["Exp. Margin", formatPercent(d.expectedMargin)],
      ["Date Listed", escapeHTML(item.dateListed || "—")],
      ["Days Listed", d.daysListed === null ? "—" : String(d.daysListed)]
    ], `${aging}<div class="item-card__actions">${listingLink(item)}</div>`);
  }

  let sale = "";
  if (stage >= STAGE_INDEX.Sold) {
    const sa = item.soldActuals;
    sale = cardSection("Sale", [
      ["Sale Price", formatMoney(sa.finalSalePrice)],
      ["Net Payout", formatMoney(d.finalNetPayout)],
      ["Net Profit", `<span class="${profitCellClass(d.finalNetProfit)}">${formatMoney(d.finalNetProfit)}</span>`],
      ["Margin", formatPercent(d.finalMargin)],
      ["Sold Platform", escapeHTML(sa.soldPlatform || "—")],
      ["Date Sold", escapeHTML(item.dateSold || sa.dateSold || "—")],
      ["Days to Sell", d.daysToSell === null ? "—" : String(d.daysToSell)]
    ]);
  }

  return `
    <article class="item-card" data-edit-id="${escapeHTML(item.id)}">
      ${itemImageBlock(item)}
      <div class="item-body">
        <div class="item-body__hero">
          <p class="brand">${escapeHTML(item.brand || "Unknown Brand")}</p>
          <div class="item-body__title-row">
            <h2 class="item-title">${escapeHTML(item.itemName || "Untitled Item")}</h2>
            ${statusBadge(item.status)}
          </div>
          ${metaLine(item)}
        </div>
        ${gapsBlock(item)}
        ${acquisition}
        ${listing}
        ${sale}
        <div class="closet-card__status" data-no-edit>${statusSelect(item)}</div>
      </div>
    </article>
  `;
}

/* ============================================================
   View: Closet
   ============================================================ */
function renderCloset() {
  const items = state.items.filter(item => item.status === "Closet");

  adminMain.innerHTML = `
    ${sectionBar("Closet OS", "Closet")}
    ${items.length
      ? `<div class="closet-grid">${items.map(itemCard).join("")}</div>`
      : `<p class="admin-empty">Nothing in the closet yet. Items appear here when set to Closet.</p>`
    }
  `;
}

/* ============================================================
   View: Listed
   ============================================================ */
function renderListed() {
  const items = state.items.filter(item => item.status === "Listed");

  adminMain.innerHTML = `
    ${sectionBar("Closet OS", "Listed")}
    ${items.length
      ? `<div class="closet-grid">${items.map(itemCard).join("")}</div>`
      : `<p class="admin-empty">Nothing listed yet. Items appear here when set to Listed.</p>`
    }
  `;
}

/* ============================================================
   View: Sold
   ============================================================ */
function renderSold() {
  const items = state.items.filter(item => item.status === "Sold");

  const totalProfit = items.reduce((sum, item) => sum + calc(item).finalNetProfit, 0);
  const margins = items.map(item => calc(item).finalMargin).filter(value => Number.isFinite(value));
  const avgMargin = margins.length ? margins.reduce((sum, value) => sum + value, 0) / margins.length : 0;
  const daysList = items.map(item => calc(item).daysToSell).filter(value => value !== null);
  const avgDaysToSell = daysList.length ? daysList.reduce((sum, value) => sum + value, 0) / daysList.length : 0;

  adminMain.innerHTML = `
    ${sectionBar("Closet OS", "Sold")}
    <div class="summary-bar">
      <div><span>Items Sold</span><strong>${items.length}</strong></div>
      <div><span>Realized Profit</span><strong>${formatMoney(totalProfit)}</strong></div>
      <div><span>Avg Margin</span><strong>${formatPercent(avgMargin)}</strong></div>
      <div><span>Avg Days to Sell</span><strong>${avgDaysToSell ? avgDaysToSell.toFixed(0) : "0"}</strong></div>
    </div>
    ${items.length
      ? `<div class="closet-grid">${items.map(itemCard).join("")}</div>`
      : `<p class="admin-empty">No sold items yet.</p>`
    }
  `;
}

/* ============================================================
   Modal — form building
   ============================================================ */
const modalOverlay = document.getElementById("modalOverlay");
const modalContent = document.getElementById("modalContent");

// Field builders. `name` uses dot-paths (e.g. "costs.purchasePrice").
// `opts.field` adds a data-field attribute used by the status state machine.
function dataFieldAttr(opts) {
  return opts.field ? ` data-field="${opts.field}"` : "";
}

function textField(label, name, value, opts = {}) {
  const attrs = [
    opts.readonly ? "readonly" : "",
    opts.required ? "required" : "",
    opts.type ? `type="${opts.type}"` : `type="text"`,
    opts.id ? `id="${opts.id}"` : "",
    opts.placeholder ? `placeholder="${escapeHTML(opts.placeholder)}"` : ""
  ].filter(Boolean).join(" ");
  const requiredMark = opts.required ? ` <span class="req">*</span>` : "";
  return `
    <div class="field${opts.full ? " field--full" : ""}${opts.calc ? " field--calc" : ""}"${dataFieldAttr(opts)}>
      <label for="${opts.id || name}">${escapeHTML(label)}${requiredMark}</label>
      <input name="${name}" ${attrs} value="${escapeHTML(value ?? "")}" />
    </div>
  `;
}

function numberField(label, name, value, opts = {}) {
  // Show 0 when it's been explicitly set; only leave blank when null/undefined/""
  const display = (value === null || value === undefined || value === "") ? "" : value;
  return textField(label, name, display, { ...opts, type: "number" });
}

function dateField(label, name, value, opts = {}) {
  return textField(label, name, value, { ...opts, type: "date" });
}

function selectField(label, name, value, options, opts = {}) {
  const optionHtml = ["", ...options].map(option =>
    `<option value="${escapeHTML(option)}"${option === value ? " selected" : ""}>${option ? escapeHTML(option) : "—"}</option>`
  ).join("");
  return `
    <div class="field${opts.full ? " field--full" : ""}"${dataFieldAttr(opts)}>
      <label for="${name}">${escapeHTML(label)}</label>
      <select name="${name}" id="${name}">${optionHtml}</select>
    </div>
  `;
}

function textareaField(label, name, value, opts = {}) {
  return `
    <div class="field field--full"${dataFieldAttr(opts)}>
      <label for="${name}">${escapeHTML(label)}</label>
      <textarea name="${name}" id="${name}">${escapeHTML(value ?? "")}</textarea>
    </div>
  `;
}

function checkboxField(label, name, checked) {
  return `
    <div class="field field--check">
      <input type="checkbox" name="${name}" id="${name}"${checked ? " checked" : ""} />
      <label for="${name}">${escapeHTML(label)}</label>
    </div>
  `;
}

// Read-only calculated output, updated live by recalcForm().
function calcField(label, id, value) {
  return `
    <div class="field field--calc">
      <label>${escapeHTML(label)}</label>
      <output id="${id}">${value}</output>
    </div>
  `;
}

function buildForm(item) {
  const d = calc(item);

  return `
    <form id="itemForm" novalidate>
      <p class="field-error" id="formError" hidden></p>

      <!-- Status (locked — change from the item card/row) -->
      <section class="form-card">
        <div class="section-bar"><span class="section-bar__title">Status</span></div>
        <div class="form-section">
          <div class="toggle-group" role="group" aria-label="Status (locked)">
            ${STATUSES.map(stage =>
              `<button type="button" class="toggle${item.status === stage ? " active" : ""}" disabled>${escapeHTML(stage)}</button>`
            ).join("")}
          </div>
          <input type="hidden" name="status" id="statusInput" value="${escapeHTML(item.status)}" />
          <p class="status-locked-hint">Status is changed from the item card, not here.</p>
        </div>
      </section>

      <!-- Images -->
      <section class="form-card">
        <div class="section-bar"><span class="section-bar__title">Images</span></div>
        <div class="form-section">
          <label class="image-dropzone" for="imageInput">
            <span class="image-dropzone__hint">＋ Add photos</span>
            <input type="file" id="imageInput" accept="image/*" multiple hidden />
          </label>
          <div class="image-strip" id="imageStrip"></div>
        </div>
      </section>

      <!-- Item identity — always editable -->
      <section class="form-card">
        <div class="section-bar"><span class="section-bar__title">Item</span></div>
        <div class="field-grid">
          ${textField("Brand", "brand", item.brand)}
          ${textField("Item Name", "itemName", item.itemName)}
          ${selectField("Category", "category", item.category, CATEGORIES)}
          ${textField("Size", "size", item.size)}
          ${textField("Color", "color", item.color)}
          ${selectField("Condition", "condition", item.condition, CONDITIONS)}
          ${textareaField("Public Description", "publicDescription", item.publicDescription)}
          ${textareaField("Private Notes", "privateNotes", item.privateNotes)}
        </div>
      </section>

      <!-- Acquisition (Closet stage) -->
      <section class="form-card" data-stage="Closet">
        <div class="section-bar"><span class="section-bar__title">Acquisition</span></div>
        <div class="field-grid">
          ${dateField("Date Acquired", "dateAcquired", item.dateAcquired)}
          ${textField("Source / Seller", "source", item.source)}
          ${selectField("Purchase Platform", "purchasePlatform", item.purchasePlatform, PURCHASE_PLATFORMS)}
          ${numberField("Cost", "costs.purchasePrice", item.costs.purchasePrice)}
          ${numberField("Inbound Shipping", "costs.inboundShipping", item.costs.inboundShipping)}
          ${numberField("Tax", "costs.tax", item.costs.tax)}
          ${numberField("Misc", "costs.otherPrepCost", item.costs.otherPrepCost)}
          ${calcField("Total Cost Basis", "calcTotalCostBasis", formatMoney2(d.totalCostBasis))}
        </div>
      </section>

      <!-- Listing (Listed stage) -->
      <section class="form-card" data-stage="Listed">
        <div class="section-bar"><span class="section-bar__title">Listing</span></div>
        <div class="field-grid">
          ${textField("Season / Year", "season", item.season)}
          ${dateField("Date Listed", "dateListed", item.dateListed)}
          ${numberField("Listing Price", "pricing.currentListPrice", item.pricing.currentListPrice, { required: true, placeholder: "Required" })}
          ${numberField("Estimated Shipping", "platform.estimatedShipping", item.platform.estimatedShipping)}
          ${checkboxField("Buyer Pays Shipping", "platform.buyerPaysShipping", item.platform.buyerPaysShipping)}
          ${checkboxField("Seller Pays Shipping", "platform.sellerPaysShipping", item.platform.sellerPaysShipping)}
          ${calcField(`Assumed Fee (${ASSUMED_FEE_PCT}%)`, "calcAssumedFee", formatMoney2(d.expectedFee))}
          ${calcField("Expected Net Payout", "calcExpectedNetPayout", formatMoney2(d.expectedNetPayout))}
          ${calcField("Expected Net Profit", "calcExpectedNetProfit", formatMoney2(d.expectedNetProfit))}
          ${calcField("Expected Margin", "calcExpectedMargin", formatPercent(d.expectedMargin))}
          ${calcField("Break-Even Price", "calcBreakEven", formatMoney2(d.breakEvenPrice))}
          ${calcField("Markup %", "calcMarkup", formatPercent(d.markupPercent))}
        </div>
      </section>

      <!-- Listing URLs (Listed stage) -->
      <section class="form-card" data-stage="Listed">
        <div class="section-bar"><span class="section-bar__title">Listing URLs</span></div>
        <div class="field-grid">
          ${LISTING_URL_FIELDS.map(([label, key]) =>
            textField(`${label} URL`, `platform.${key}`, item.platform[key])
          ).join("")}
        </div>
      </section>

      <!-- Sale (Sold stage) — actual figures entered here -->
      <section class="form-card" data-stage="Sold">
        <div class="section-bar"><span class="section-bar__title">Sale</span></div>
        <div class="field-grid">
          ${dateField("Date Sold", "dateSold", item.dateSold)}
          ${selectField("Sold Platform", "soldActuals.soldPlatform", item.soldActuals.soldPlatform, SOLD_PLATFORMS)}
          ${numberField("Sale Price", "soldActuals.finalSalePrice", item.soldActuals.finalSalePrice)}
          ${numberField("Actual Platform Fee", "soldActuals.finalPlatformFee", item.soldActuals.finalPlatformFee)}
          ${numberField("Actual Processing Fee", "soldActuals.finalPaymentFee", item.soldActuals.finalPaymentFee)}
          ${numberField("Actual Shipping", "soldActuals.finalShipping", item.soldActuals.finalShipping)}
          ${calcField("Net Payout", "calcFinalNetPayout", formatMoney2(d.finalNetPayout))}
          ${calcField("Net Profit", "calcFinalNetProfit", formatMoney2(d.finalNetProfit))}
          ${calcField("Margin", "calcFinalMargin", formatPercent(d.finalMargin))}
          ${calcField("Days to Sell", "calcDaysToSell", d.daysToSell === null ? "—" : d.daysToSell)}
        </div>
      </section>
    </form>
  `;
}

/* ============================================================
   Modal — open / close / image handling
   ============================================================ */
function openModal(itemId = null) {
  const editing = itemId ? getItemById(itemId) : null;
  const item = editing ? structuredClone(editing) : blankItem();

  state.editingId = itemId;
  state.draftImages = Array.isArray(item.images) ? [...item.images] : [];
  state.draftPrimary = item.primaryImage || (state.draftImages[0] || "");

  modalContent.innerHTML = `
    <div class="modal-head">
      <h2 class="modal-title">${editing ? "Edit Item" : "New Item"}</h2>
      <button type="button" class="modal-close" id="modalClose" aria-label="Close">×</button>
    </div>
    <div class="modal-body">${buildForm(item)}</div>
    <div class="modal-foot">
      ${editing ? `<button type="button" class="btn btn--danger" id="deleteItemBtn">Delete</button>` : ""}
      <button type="button" class="btn" id="cancelBtn">Cancel</button>
      <button type="button" class="btn btn--primary" id="saveItemBtn">Save Item</button>
    </div>
  `;

  modalOverlay.hidden = false;
  document.body.style.overflow = "hidden";

  bindModalEvents();
  renderImageStrip();
  applyStageVisibility(item.status);
  recalcForm();
}

function closeModal() {
  modalOverlay.hidden = true;
  modalContent.innerHTML = "";
  document.body.style.overflow = "";
  state.editingId = null;
  state.draftImages = [];
  state.draftPrimary = "";
}

function renderImageStrip() {
  const strip = document.getElementById("imageStrip");
  if (!strip) return;
  strip.innerHTML = state.draftImages.map((src, index) => {
    const isPrimary = src === state.draftPrimary;
    return `
      <div class="image-thumb${isPrimary ? " is-primary" : ""}" data-image-index="${index}" title="Click to set primary">
        <img src="${escapeHTML(src)}" alt="" />
        ${isPrimary ? `<span class="image-thumb__tag">Primary</span>` : ""}
        <button type="button" class="image-thumb__remove" data-remove-index="${index}" aria-label="Remove image">×</button>
      </div>
    `;
  }).join("");
}

// localStorage is ~5MB and strict on iOS, so full-res photos must be shrunk before
// storing or saves fail silently. Downscale to MAX_IMAGE_DIM and JPEG-encode.
const MAX_IMAGE_DIM = 1200;
const IMAGE_QUALITY = 0.72;

function compressImage(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
        const width = Math.round(img.width * scale);
        const height = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        try {
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", IMAGE_QUALITY));
        } catch (error) {
          console.error("Image compression failed, storing original:", error);
          resolve(reader.result);
        }
      };
      img.onerror = () => resolve(reader.result); // e.g. format canvas can't decode
      img.src = reader.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function handleImageUpload(event) {
  const files = [...event.target.files];
  if (!files.length) return;

  // Compress for fast uploads, then store the file in Supabase Storage and
  // keep only its public URL on the item (no more bulky base64 in the record).
  for (const file of files) {
    const dataUrl = await compressImage(file);
    if (!dataUrl) continue;
    try {
      const url = await window.PodaDB.uploadImage(dataUrl);
      state.draftImages.push(url);
      if (!state.draftPrimary) state.draftPrimary = url;
      renderImageStrip();
    } catch (error) {
      alert("Image upload failed. Please try again.");
    }
  }

  event.target.value = ""; // let the same file be re-selected if needed
}

/* ============================================================
   Modal — read form / live recalc / save
   ============================================================ */
function setByPath(object, path, value) {
  const keys = path.split(".");
  let cursor = object;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cursor[keys[i]] !== "object" || cursor[keys[i]] === null) cursor[keys[i]] = {};
    cursor = cursor[keys[i]];
  }
  cursor[keys[keys.length - 1]] = value;
}

function getByPath(object, path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), object);
}

// Reset a stage's fields back to their blank defaults (used when reverting a stage).
function clearStageFields(item, stage) {
  const defaults = blankItem();
  (STAGE_FIELDS[stage] || []).forEach(path => setByPath(item, path, getByPath(defaults, path)));
}

// Build an item object from the current form state (without persisting).
function readForm() {
  const base = state.editingId ? structuredClone(getItemById(state.editingId)) : blankItem();
  base.images = [...state.draftImages];
  base.primaryImage = state.draftPrimary;

  const form = document.getElementById("itemForm");
  form.querySelectorAll("input[name], select[name], textarea[name]").forEach(element => {
    const name = element.getAttribute("name");
    if (!name) return;

    let value;
    if (element.type === "checkbox") value = element.checked;
    // Keep blank as null (not 0) so we can tell "not entered" from "explicitly 0"
    else if (element.type === "number") value = element.value === "" ? null : Number(element.value);
    else value = element.value;

    setByPath(base, name, value);
  });

  return base;
}

// Recompute everything derived and refresh the read-only outputs + ID.
function recalcForm() {
  const item = readForm();
  const d = calc(item);

  const outputs = {
    calcTotalCostBasis: formatMoney2(d.totalCostBasis),
    calcAssumedFee: formatMoney2(d.expectedFee),
    calcExpectedNetPayout: formatMoney2(d.expectedNetPayout),
    calcExpectedNetProfit: formatMoney2(d.expectedNetProfit),
    calcExpectedMargin: formatPercent(d.expectedMargin),
    calcBreakEven: formatMoney2(d.breakEvenPrice),
    calcMarkup: formatPercent(d.markupPercent),
    calcFinalNetPayout: formatMoney2(d.finalNetPayout),
    calcFinalNetProfit: formatMoney2(d.finalNetProfit),
    calcFinalMargin: formatPercent(d.finalMargin),
    calcDaysToSell: d.daysToSell === null ? "—" : String(d.daysToSell)
  };
  Object.entries(outputs).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });

  // Live preview of the auto-generated ID (only when not yet saved with an ID).
  const idField = document.getElementById("fieldItemId");
  if (idField && !state.editingId) {
    idField.value = (item.brand && item.season && item.category) ? generateItemId(item) : "";
  }
}

// Any editable input recomputes the derived/read-only outputs. Buyer/Seller Pays
// Shipping are mutually exclusive — checking one clears the other.
function handleFormInput(event) {
  const target = event && event.target;

  if (target && target.type === "checkbox" && target.checked) {
    if (target.name === "platform.buyerPaysShipping") {
      const seller = document.querySelector('[name="platform.sellerPaysShipping"]');
      if (seller) seller.checked = false;
    } else if (target.name === "platform.sellerPaysShipping") {
      const buyer = document.querySelector('[name="platform.buyerPaysShipping"]');
      if (buyer) buyer.checked = false;
    }
  }

  recalcForm();
}

// Show/hide whole stage cards: a stage card is hidden until the item reaches that
// stage. Hidden cards keep their inputs in the DOM (values preserved, not wiped).
function applyStageVisibility(status) {
  const form = document.getElementById("itemForm");
  if (!form) return;

  const current = STAGE_INDEX[status] ?? 0;
  form.querySelectorAll("[data-stage]").forEach(card => {
    card.hidden = (STAGE_INDEX[card.dataset.stage] ?? 0) > current;
  });
}

async function saveItem() {
  const item = readForm();
  const errorBox = document.getElementById("formError");

  // 1. Validate required fields.
  const missing = [];
  if (!item.brand.trim()) missing.push("Brand");
  if (!item.itemName.trim()) missing.push("Item Name");
  if (!item.category) missing.push("Category");
  if (!item.status) missing.push("Status");
  if ((item.status === "Listed" || item.status === "Sold") && !(num(item.pricing.currentListPrice) > 0)) {
    missing.push("Listing Price");
  }
  if (item.status === "Sold" && !(num(item.soldActuals.finalSalePrice) > 0)) {
    missing.push("Sale Price");
  }

  if (missing.length) {
    errorBox.textContent = `Missing required field(s): ${missing.join(", ")}.`;
    errorBox.hidden = false;
    modalContent.querySelector(".modal-body").scrollTop = 0;
    return;
  }

  // 2. Generate/confirm ID.
  item.brandCode = item.brandCode || makeBrandCode(item.brand);
  if (!item.id) item.id = generateItemId(item);

  // 3. Persist, 4. close, 5. re-render.
  try {
    await upsertItem(item);
  } catch (error) {
    return; // upsertItem already alerted the user; keep the modal open
  }
  closeModal();
  renderCurrentView();
}

/* ============================================================
   Event wiring
   ============================================================ */
function bindModalEvents() {
  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("cancelBtn").addEventListener("click", closeModal);
  document.getElementById("saveItemBtn").addEventListener("click", saveItem);

  const deleteBtn = document.getElementById("deleteItemBtn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (confirm("Delete this item permanently?")) {
        try {
          await deleteItemById(state.editingId);
        } catch (error) {
          return; // deleteItemById already alerted the user
        }
        closeModal();
        renderCurrentView();
      }
    });
  }

  document.getElementById("imageInput").addEventListener("change", handleImageUpload);

  const form = document.getElementById("itemForm");
  form.addEventListener("input", handleFormInput);
  form.addEventListener("change", handleFormInput);

  // Image strip: click to set primary, × to remove.
  document.getElementById("imageStrip").addEventListener("click", event => {
    const removeBtn = event.target.closest("[data-remove-index]");
    if (removeBtn) {
      event.stopPropagation();
      const index = Number(removeBtn.dataset.removeIndex);
      const removed = state.draftImages.splice(index, 1)[0];
      if (removed === state.draftPrimary) state.draftPrimary = state.draftImages[0] || "";
      renderImageStrip();
      return;
    }
    const thumb = event.target.closest("[data-image-index]");
    if (thumb) {
      state.draftPrimary = state.draftImages[Number(thumb.dataset.imageIndex)];
      renderImageStrip();
    }
  });
}

// Delegated events on the main content area (rows, filters, inline status, +New).
function bindMainEvents() {
  adminMain.addEventListener("click", event => {
    if (event.target.closest("[data-new-item]")) {
      openModal(null);
      return;
    }
    // Don't open the modal when interacting with inline controls.
    if (event.target.closest("[data-no-edit]")) return;

    const row = event.target.closest("[data-edit-id]");
    if (row) openModal(row.dataset.editId);
  });

  // Inline status change.
  adminMain.addEventListener("change", async event => {
    const statusEl = event.target.closest("[data-status-for]");
    if (statusEl) {
      const item = getItemById(statusEl.dataset.statusFor);
      if (item) {
        const oldStatus = item.status;
        const newStatus = statusEl.value;
        const allowed = TRANSITIONS[oldStatus] || [];

        // Ignore (and revert) any transition the rules don't permit.
        if (!allowed.includes(newStatus)) {
          renderCurrentView();
          return;
        }

        const oldIndex = STAGE_INDEX[oldStatus] ?? 0;
        const newIndex = STAGE_INDEX[newStatus] ?? 0;
        const today = new Date().toISOString().slice(0, 10);

        if (newIndex > oldIndex) {
          // Moving forward — auto-stamp the stage date if not already set.
          if (newStatus === "Listed" && !item.dateListed) item.dateListed = today;
          if (newStatus === "Sold" && !item.dateSold) item.dateSold = today;
        } else if (newIndex < oldIndex) {
          // Reverting — clear every stage above the new one so it's re-entered.
          if (STAGE_INDEX.Sold > newIndex) clearStageFields(item, "Sold");
          if (STAGE_INDEX.Listed > newIndex) clearStageFields(item, "Listed");
        }

        item.status = newStatus;
        try {
          await upsertItem(item);
        } catch (error) {
          state.items = await loadItems(); // re-sync after a failed save
        }
        renderCurrentView();
      }
      return;
    }

    const filterEl = event.target.closest("[data-filter]");
    if (filterEl) {
      state.filters[filterEl.dataset.filter] = filterEl.value;
      renderAllItems();
    }
  });

  // Brand text filter (input event).
  adminMain.addEventListener("input", event => {
    const filterEl = event.target.closest('[data-filter="brand"]');
    if (filterEl) {
      state.filters.brand = filterEl.value;
      renderAllItems();
    }
  });
}

function bindGlobalEvents() {
  document.querySelectorAll(".admin-nav__link").forEach(link => {
    link.addEventListener("click", () => setView(link.dataset.view));
  });

  document.getElementById("headerNewItem").addEventListener("click", () => openModal(null));

  modalOverlay.addEventListener("click", event => {
    if (event.target === modalOverlay) closeModal();
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !modalOverlay.hidden) closeModal();
  });
}

/* ============================================================
   Authentication — login screen gates the whole admin app
   ============================================================ */
const loginGate = document.getElementById("loginGate");
const adminApp = document.getElementById("adminApp");
let appStarted = false;

function showLogin() {
  loginGate.hidden = false;
  adminApp.hidden = true;
}

// Reveal the app and load the live inventory from the database.
async function startApp() {
  if (appStarted) return;
  appStarted = true;
  loginGate.hidden = true;
  adminApp.hidden = false;
  state.items = await loadItems();
  setView("dashboard");
}

function bindAuthEvents() {
  const loginForm = document.getElementById("loginForm");
  const loginError = document.getElementById("loginError");

  loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    loginError.hidden = true;

    const email = window.PODA_ADMIN_EMAIL;
    const password = document.getElementById("loginPassword").value;
    const button = document.getElementById("loginBtn");

    button.disabled = true;
    try {
      await window.PodaDB.signIn(email, password);
      await startApp();
    } catch (error) {
      loginError.textContent = error && error.message
        ? error.message
        : "Sign in failed. Check your email and password.";
      loginError.hidden = false;
      console.error("Login error:", error);
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await window.PodaDB.signOut();
    window.location.reload();
  });

  document.getElementById("importBtn").addEventListener("click", importFromBrowser);
  document.getElementById("exportExcelBtn").addEventListener("click", exportToExcel);
  document.getElementById("backupBtn").addEventListener("click", downloadBackup);
  document.getElementById("restoreBtn").addEventListener("click",
    () => document.getElementById("restoreInput").click());
  document.getElementById("restoreInput").addEventListener("change", restoreFromFile);
}

/* ============================================================
   Download the live inventory workbook (Excel). Built from the
   current items, so it's empty when the closet is empty and
   populates one row per item as you add them.
   ============================================================ */
async function exportToExcel() {
  if (!window.PodaExcel) {
    alert("Excel export isn't loaded yet. Refresh the page and try again.");
    return;
  }
  const button = document.getElementById("exportExcelBtn");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Building…";
  try {
    const date = new Date().toISOString().slice(0, 10);
    await window.PodaExcel.download(state.items, `poda_capital_inventory_${date}.xlsx`);
  } catch (error) {
    console.error("Excel export failed:", error);
    alert("Could not build the Excel file. See the console for details.");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/* ============================================================
   JSON backup + restore — a full-fidelity safety net.
   Backup downloads every item (incl. image URLs) as JSON;
   Restore reads such a file and writes the items back to the DB.
   Unlike the Excel export, a backup can be re-imported to recover.
   ============================================================ */
function downloadBackup() {
  const payload = {
    type: "poda-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    count: state.items.length,
    items: state.items
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `poda_backup_${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function restoreFromFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = ""; // let the same file be chosen again later
  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    alert("That file isn't valid JSON. Choose a Poda backup file (.json).");
    return;
  }

  // Accept either a { items: [...] } backup envelope or a bare array.
  const list = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.items) ? parsed.items : null);
  if (!list) {
    alert("This doesn't look like a Poda backup (no items found).");
    return;
  }

  // Only restore objects that have a usable id.
  const items = list.filter(item => item && typeof item.id === "string" && item.id);
  if (!items.length) {
    alert("No valid items were found in that backup.");
    return;
  }

  if (!confirm(
    `Restore ${items.length} item(s) from this backup?\n` +
    `Any existing item with the same ID will be overwritten.`
  )) {
    return;
  }

  let restored = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await window.PodaDB.upsertItem(item);
      restored++;
    } catch (error) {
      console.error("Restore failed for item", item.id, error);
      failed++;
    }
  }

  state.items = await loadItems();
  renderCurrentView();
  alert(`Restored ${restored} item(s).${failed ? ` ${failed} failed — see console.` : ""}`);
}

/* ============================================================
   One-time migration: pull items saved in THIS browser's old
   localStorage into the database (uploading any base64 photos).
   ============================================================ */
async function importFromBrowser() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    raw = null;
  }

  let legacyItems = [];
  try {
    legacyItems = raw ? JSON.parse(raw) : [];
  } catch (error) {
    legacyItems = [];
  }

  if (!Array.isArray(legacyItems) || !legacyItems.length) {
    alert("No saved items were found in this browser to import.");
    return;
  }

  if (!confirm(`Import ${legacyItems.length} item(s) from this browser into the database?`)) {
    return;
  }

  let imported = 0;
  let failed = 0;

  for (const item of legacyItems) {
    try {
      // Replace any embedded base64 images with uploaded files.
      const map = new Map();
      const uploaded = [];
      for (const img of Array.isArray(item.images) ? item.images : []) {
        if (typeof img !== "string" || !img) continue;
        const url = img.startsWith("data:") ? await window.PodaDB.uploadImage(img) : img;
        map.set(img, url);
        uploaded.push(url);
      }
      item.images = uploaded;
      if (item.primaryImage) {
        item.primaryImage = map.get(item.primaryImage) || uploaded[0] || "";
      }

      await window.PodaDB.upsertItem(item);
      imported++;
    } catch (error) {
      console.error("Import failed for an item:", error);
      failed++;
    }
  }

  state.items = await loadItems();
  renderCurrentView();
  alert(`Imported ${imported} item(s).${failed ? ` ${failed} failed — see console.` : ""}`);
}

/* ============================================================
   Init
   ============================================================ */
async function init() {
  if (!window.PodaDB || !window.PodaDB.isConfigured) {
    alert("The database is not configured yet. See SUPABASE_SETUP.md.");
  }

  bindGlobalEvents();
  bindMainEvents();
  bindAuthEvents();

  // If already signed in (session remembered), go straight in; else show login.
  const session = window.PodaDB ? await window.PodaDB.getSession() : null;
  if (session) {
    await startApp();
  } else {
    showLogin();
  }
}

init();
