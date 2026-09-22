/* ============================================================
   Poda Capital — Admin (Closet OS)
   Vanilla JS over a shared Supabase database (via window.PodaDB).

   Poda is a curated consignment retailer: interesting closets supply
   inventory, Poda selects the strongest pieces into recurring drops.
   An item moves through five stages:

     CLOSET     the owner has it; not offered for sale
     AVAILABLE  the owner is willing to sell it
     SELECTED   Poda picked it for an upcoming drop
     LIVE       it's for sale in the current drop
     SOLD       it sold

   Consignors don't log in (admin-managed): the admin enters each
   closet's items and moves them through the workflow here.
   ============================================================ */

"use strict";

/* —— Constants —— */
const STORAGE_KEY = "poda_inventory";

const CATEGORIES = ["Shirt", "Jacket", "Pants", "Denim", "Knit", "Shoe", "Bag", "Accessory", "Other"];
const CONDITIONS = ["New", "Excellent", "Very Good", "Good", "Fair"];
const STATUSES = ["Closet", "Available", "Selected", "Live", "Sold"];

// —— Overhaul additions ——
// Source of supply (brief §2): drives the "source mix" metrics + card labels.
const SOURCE_TYPES = ["brand", "vintage", "closet"];
const SOURCE_LABELS = { brand: "Independent Brand", vintage: "Vintage Seller", closet: "Private Closet" };

// Transaction type (brief §2/§9): decides which CTA the product shows.
const TRANSACTION_TYPES = ["poda_sale", "assisted", "partner", "sourcing"];
const TRANSACTION_LABELS = {
  poda_sale: "Purchase through poda",
  assisted:  "Request to purchase",
  partner:   "View at partner",
  sourcing:  "Source something similar"
};

// Category → item-ID code (brief §8): PODA-[drop]-[code]-[seq].
const CATEGORY_CODES = {
  Shoe: "FW", Jacket: "OT", Shirt: "TP", Knit: "TP",
  Pants: "BT", Denim: "BT", Bag: "AC", Accessory: "AC", Other: "OB"
};

// Default Poda commission (30–35% range in the brief). Per-item overridable.
const DEFAULT_COMMISSION_PCT = 32;

// Lifecycle is linear: Closet → Available → Selected → Live → Sold.
// You can move one step forward or back from the card/row dropdown.
const STAGE_INDEX = { Closet: 0, Available: 1, Selected: 2, Live: 3, Sold: 4 };

const TRANSITIONS = {
  Closet:    ["Closet", "Available"],
  Available: ["Closet", "Available", "Selected"],
  Selected:  ["Available", "Selected", "Live"],
  Live:      ["Selected", "Live", "Sold"],
  Sold:      ["Live", "Sold"]
};

// Fields owned by each stage (dot-paths). Cleared when an item is reverted
// below that stage so the data is re-entered on the way back up. (Closet /
// Available are the base — closet + availability info is never auto-cleared.)
const STAGE_FIELDS = {
  Selected: ["dropNumber", "dateSelected", "pricing.currentListPrice"],
  Live:     ["dateLive", "verified"],
  Sold:     ["dateSold", "soldActuals.finalSalePrice"]
};

// Inputs required to legitimately sit at each stage. Any reached-stage
// requirement left blank is flagged on the card.
const REQUIRED_FIELDS = {
  Selected: [["dropNumber", "Drop #"], ["pricing.currentListPrice", "List Price"]],
  Sold:     [["soldActuals.finalSalePrice", "Sold Price"]]
};

/* —— App state —— */
const state = {
  items: [],
  view: "dashboard",
  editingId: null,        // id being edited, or null for a new item
  draftImages: [],        // images in the open modal
  draftPrimary: "",       // primary image (data URL / URL) in the open modal
  filters: { status: "All", category: "All", owner: "All", brand: "" }
};

/* ============================================================
   Storage
   ============================================================ */
async function loadItems() {
  return await window.PodaDB.getItems();
}

function getItemById(id) {
  return state.items.find(item => item.id === id) || null;
}

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
    itemCode: "",            // PODA-[drop]-[cat]-[seq], e.g. PODA-001-FW-001
    itemName: "",
    category: "",
    categoryCode: "",        // FW | OT | TP | BT | AC | OB
    size: "",
    measurements: "",        // free text, e.g. "Chest 21in, Length 28in"
    material: "",
    color: "",
    condition: "",
    conditionNotes: "",
    season: "",              // era / season when known
    status: "Closet",

    // —— Source / supply (brief §2) ——
    sourceType: "brand",     // brand | vintage | closet
    sourceName: "",          // e.g. "Independent Brand 01"

    // —— Transaction (brief §2/§9): drives which CTA shows ——
    transactionType: "poda_sale", // poda_sale | assisted | partner | sourcing
    externalUrl: "",         // partner link when transactionType === "partner"

    // —— Closet / consignment ——
    closetOwner: "",         // which closet this piece belongs to
    ownerMinPayout: 0,       // amount the owner is comfortable receiving
    commissionPercent: DEFAULT_COMMISSION_PCT,

    // —— Selection / drop ——
    dropNumber: "",          // e.g. "001"
    verified: false,         // Poda has the piece in hand + checked it

    // —— Copy ——
    publicDescription: "",
    selectionReason: "",     // "Why poda selected it" (brief §9)
    privateNotes: "",

    // —— Stage dates ——
    dateAdded: new Date().toISOString().slice(0, 10),
    dateSelected: "",
    dateLive: "",
    dateSold: "",

    // Poda's list price lives in pricing.currentListPrice; the final sale
    // price lives in soldActuals.finalSalePrice. Kept as sub-objects so the
    // existing Excel/backup tooling keeps working unchanged.
    pricing: { currentListPrice: 0 },
    soldActuals: { finalSalePrice: 0 }
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

/**
 * calc(item) — every derived consignment figure for one item.
 * commission is Poda's cut; the owner payout is what's left for the closet.
 */
function calc(item) {
  const p  = item.pricing || {};
  const sa = item.soldActuals || {};

  const listPrice = num(p.currentListPrice);
  const pct = item.commissionPercent === undefined || item.commissionPercent === null || item.commissionPercent === ""
    ? DEFAULT_COMMISSION_PCT
    : num(item.commissionPercent);
  const frac = pct / 100;

  // Expected (while Selected / Live), from the list price.
  const expectedCommission = listPrice * frac;
  const expectedOwnerPayout = listPrice - expectedCommission;

  // Actual (once Sold), from the final sale price.
  const soldPrice = num(sa.finalSalePrice);
  const finalCommission = soldPrice * frac;       // Poda revenue on this piece
  const ownerPayout = soldPrice - finalCommission; // owed to the closet owner

  const today = new Date().toISOString().slice(0, 10);
  const soldDate = item.dateSold || sa.dateSold;
  const daysToSell = (item.dateLive && soldDate) ? daysBetween(item.dateLive, soldDate) : null;
  const daysLive = (item.dateLive && item.status === "Live") ? daysBetween(item.dateLive, today) : null;

  return {
    listPrice, pct,
    expectedCommission, expectedOwnerPayout,
    soldPrice, finalCommission, ownerPayout,
    daysToSell, daysLive
  };
}

/* ============================================================
   Dashboard metrics — across all items
   ============================================================ */
function dashboardMetrics(items) {
  const byStatus = status => items.filter(item => item.status === status);
  const available = byStatus("Available");
  const selected  = byStatus("Selected");
  const live      = byStatus("Live");
  const sold       = byStatus("Sold");

  const gmv = sold.reduce((sum, item) => sum + calc(item).soldPrice, 0);
  const podaRevenue = sold.reduce((sum, item) => sum + calc(item).finalCommission, 0);
  const owedToConsignors = sold.reduce((sum, item) => sum + calc(item).ownerPayout, 0);
  const avgSalePrice = sold.length ? gmv / sold.length : 0;

  // Sell-through across pieces that reached the store (live + sold).
  const throughDenom = sold.length + live.length;
  const sellThroughRate = throughDenom > 0 ? sold.length / throughDenom : 0;

  const daysList = sold.map(item => calc(item).daysToSell).filter(v => v !== null);
  const avgDaysToSell = daysList.length ? daysList.reduce((s, v) => s + v, 0) / daysList.length : 0;

  const closets = new Set(items.map(item => (item.closetOwner || "").trim()).filter(Boolean));

  return {
    totalItems: items.length,
    closets: closets.size,
    availableCount: available.length,
    selectedCount: selected.length,
    liveCount: live.length,
    soldCount: sold.length,
    gmv, podaRevenue, owedToConsignors, avgSalePrice,
    sellThroughRate, avgDaysToSell
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
    "Closet":    "badge--draft",
    "Available": "badge--available",
    "Selected":  "badge--selected",
    "Live":      "badge--listed",
    "Sold":      "badge--sold"
  };
  return map[status] || "badge--draft";
}

function statusBadge(status) {
  return `<span class="badge ${statusBadgeClass(status)}">${escapeHTML(status || "—")}</span>`;
}

function dropLabel(item) {
  const n = String(item.dropNumber || "").trim();
  return n ? `Drop ${n}` : "—";
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

/* —— Inline status dropdown (only valid transitions; locked when stuck) —— */
function statusSelect(item) {
  const allowed = TRANSITIONS[item.status] || [item.status];
  const options = allowed.map(status =>
    `<option value="${escapeHTML(status)}"${status === item.status ? " selected" : ""}>${escapeHTML(status)}</option>`
  ).join("");
  const locked = allowed.length <= 1 ? " disabled" : "";
  return `<select class="status-select" data-status-for="${escapeHTML(item.id)}"${locked} aria-label="Status">${options}</select>`;
}

/* ============================================================
   Item ID generation — PODA-YY-BRAND-CATEGORY-###
   ============================================================ */
function makeBrandCode(brand) {
  return String(brand || "").toUpperCase().replace(/\s+/g, "").slice(0, 8);
}

function generateItemId(item) {
  const yy = String(new Date().getFullYear()).slice(-2);
  const brandCode = (item.brandCode || makeBrandCode(item.brand) || "UNK").toUpperCase().replace(/\s+/g, "");
  const category = (item.category || "ITEM").toUpperCase();
  const prefix = `PODA-${yy}-${brandCode}-${category}-`;

  let max = 0;
  for (const existing of state.items) {
    if (existing.id && existing.id.startsWith(prefix) && existing.id !== item.id) {
      const tail = Number(existing.id.slice(prefix.length));
      if (Number.isFinite(tail) && tail > max) max = tail;
    }
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
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
    closets:   renderClosets,
    available: renderAvailable,
    selected:  renderSelected,
    live:      renderLive,
    sold:      renderSold,
    all:       renderAllItems,
    notes:     renderNotes,
    drops:     renderDrops,
    studies:   renderStudies,
    subscribers: renderSubscribers
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
    metricCard("Closets", m.closets),
    metricCard("Items Tracked", m.totalItems),
    metricCard("Available", m.availableCount),
    metricCard("Selected", m.selectedCount),
    metricCard("Live", m.liveCount),
    metricCard("Sold", m.soldCount),
    metricCard("GMV", formatMoney(m.gmv)),
    metricCard("Poda Revenue", formatMoney(m.podaRevenue), "commission on sold"),
    metricCard("Owed to Consignors", formatMoney(m.owedToConsignors)),
    metricCard("Avg Sale Price", formatMoney(m.avgSalePrice)),
    metricCard("Sell-Through", formatPercent(m.sellThroughRate)),
    metricCard("Avg Days to Sell", m.avgDaysToSell ? m.avgDaysToSell.toFixed(0) : "0")
  ].join("");

  const recent = [...state.items].slice(-6).reverse();

  const recentTable = recent.length
    ? `
      <div class="table-wrap">
        <table class="admin-table">
          <thead>
            <tr><th></th><th>Item ID</th><th>Closet</th><th>Brand</th><th>Name</th><th>Status</th><th>Drop</th></tr>
          </thead>
          <tbody>
            ${recent.map(item => `
              <tr data-edit-id="${escapeHTML(item.id)}">
                <td>${thumbCell(item)}</td>
                <td class="cell-mono">${escapeHTML(item.id)}</td>
                <td>${escapeHTML(item.closetOwner || "—")}</td>
                <td class="cell-strong">${escapeHTML(item.brand)}</td>
                <td>${escapeHTML(item.itemName)}</td>
                <td>${statusBadge(item.status)}</td>
                <td class="cell-mono">${escapeHTML(dropLabel(item))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `
    : `<p class="admin-empty">No items yet. Use “+ New Item” to add your first piece.</p>`;

  adminMain.innerHTML = `
    ${sectionBar("Admin", "Dashboard")}
    <section class="metrics-grid metrics-grid--admin" aria-label="Dashboard metrics">${metrics}</section>
    <div class="section-bar"><span class="section-bar__title">Recently Updated</span></div>
    ${recentTable}
  `;
}

/* ============================================================
   View: Closets — grouped by closet owner
   ============================================================ */
function renderClosets() {
  const owners = [...new Set(state.items.map(i => (i.closetOwner || "").trim()).filter(Boolean))].sort();

  const cards = owners.map(owner => {
    const items = state.items.filter(i => (i.closetOwner || "").trim() === owner);
    const count = s => items.filter(i => i.status === s).length;
    const owed = items.filter(i => i.status === "Sold").reduce((sum, i) => sum + calc(i).ownerPayout, 0);

    return `
      <article class="closet-owner-card" data-owner="${escapeHTML(owner)}">
        <div class="closet-owner-card__head">
          <h3 class="closet-owner-card__name">${escapeHTML(owner)}</h3>
          <span class="closet-owner-card__count">${items.length} piece${items.length === 1 ? "" : "s"}</span>
        </div>
        <dl class="item-ledger">
          <div class="item-ledger__row"><dt>Available</dt><dd>${count("Available")}</dd></div>
          <div class="item-ledger__row"><dt>Selected</dt><dd>${count("Selected")}</dd></div>
          <div class="item-ledger__row"><dt>Live</dt><dd>${count("Live")}</dd></div>
          <div class="item-ledger__row"><dt>Sold</dt><dd>${count("Sold")}</dd></div>
          <div class="item-ledger__row"><dt>Payout owed</dt><dd>${formatMoney(owed)}</dd></div>
        </dl>
      </article>
    `;
  }).join("");

  adminMain.innerHTML = `
    ${sectionBar("Admin", "Closets")}
    ${owners.length
      ? `<section class="closet-owner-grid">${cards}</section>`
      : `<p class="admin-empty">No closets yet. Add a piece and set its <strong>Closet Owner</strong> to start a closet.</p>`
    }
  `;
}

/* ============================================================
   Filter helpers (Available / All Items)
   ============================================================ */
function ownerValues() {
  return [...new Set(state.items.map(i => (i.closetOwner || "").trim()).filter(Boolean))].sort();
}

function filterBar(showStatus) {
  const statusOptions = showStatus
    ? `<label class="field" style="max-width:180px">
        <span class="filter-label">Status</span>
        <select class="status-select" data-filter="status">
          ${["All", ...STATUSES].map(s => `<option value="${escapeHTML(s)}"${state.filters.status === s ? " selected" : ""}>${escapeHTML(s)}</option>`).join("")}
        </select>
      </label>` : "";

  return `
    <section class="controls" aria-label="Filters">
      ${statusOptions}
      <label class="field" style="max-width:180px">
        <span class="filter-label">Closet</span>
        <select class="status-select" data-filter="owner">
          ${["All", ...ownerValues()].map(o => `<option value="${escapeHTML(o)}"${state.filters.owner === o ? " selected" : ""}>${escapeHTML(o)}</option>`).join("")}
        </select>
      </label>
      <label class="field" style="max-width:180px">
        <span class="filter-label">Category</span>
        <select class="status-select" data-filter="category">
          ${["All", ...CATEGORIES].map(c => `<option value="${escapeHTML(c)}"${state.filters.category === c ? " selected" : ""}>${escapeHTML(c)}</option>`).join("")}
        </select>
      </label>
      <label class="search-wrap" style="flex:1 1 180px">
        <span class="visually-hidden">Brand filter</span>
        <input type="search" data-filter="brand" placeholder="Filter by brand…" value="${escapeHTML(state.filters.brand)}" autocomplete="off" />
      </label>
    </section>
  `;
}

function applyFilters(items, { useStatus } = {}) {
  const f = state.filters;
  return items.filter(item => {
    if (useStatus && f.status !== "All" && item.status !== f.status) return false;
    if (f.owner !== "All" && (item.closetOwner || "").trim() !== f.owner) return false;
    if (f.category !== "All" && item.category !== f.category) return false;
    if (f.brand && !String(item.brand).toLowerCase().includes(f.brand.toLowerCase())) return false;
    return true;
  });
}

/* ============================================================
   View: Available inventory — the selection screen
   ============================================================ */
function renderAvailable() {
  const items = applyFilters(state.items.filter(i => i.status === "Available"), { useStatus: false });

  const rows = items.map(item => {
    const d = calc(item);
    return `
      <tr data-edit-id="${escapeHTML(item.id)}">
        <td>${thumbCell(item)}</td>
        <td>${escapeHTML(item.closetOwner || "—")}</td>
        <td class="cell-strong">${escapeHTML(item.brand)}</td>
        <td>${escapeHTML(item.itemName)}</td>
        <td>${escapeHTML(item.category || "—")}</td>
        <td>${escapeHTML(item.size || "—")}</td>
        <td class="cell-num">${item.ownerMinPayout ? formatMoney(item.ownerMinPayout) : "—"}</td>
        <td data-no-edit>${statusSelect(item)}</td>
      </tr>
    `;
  }).join("");

  adminMain.innerHTML = `
    ${sectionBar("Admin", "Available Inventory")}
    <p class="admin-hint">Everything a closet owner is currently willing to sell. Set an item to <strong>Selected</strong> to pull it into a drop, then add its drop number and list price.</p>
    ${filterBar(false)}
    ${state.items.filter(i => i.status === "Available").length === 0
      ? `<p class="admin-empty">Nothing marked Available yet.</p>`
      : `<div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th></th><th>Closet</th><th>Brand</th><th>Name</th><th>Category</th><th>Size</th>
                <th class="cell-num">Min Payout</th><th>Move</th>
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="8" class="admin-empty">No items match these filters.</td></tr>`}</tbody>
          </table>
        </div>`
    }
  `;
}

/* ============================================================
   Item card — shared across Selected / Live / Sold
   ============================================================ */
function itemImageBlock(item) {
  const url = primaryImageUrl(item);
  const inner = url
    ? `<img src="${escapeHTML(url)}" alt="" loading="lazy" />`
    : `<div class="image-placeholder">No image</div>`;
  return `<div class="item-image${url ? "" : " item-image--empty"}">${inner}</div>`;
}

function ledgerHtml(pairs) {
  return pairs.map(([label, value]) =>
    `<div class="item-ledger__row"><dt>${escapeHTML(label)}</dt><dd>${value}</dd></div>`
  ).join("");
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

// Required inputs still blank for the stages this item has reached.
function gapsFor(item) {
  const reached = STAGE_INDEX[item.status] ?? 0;
  const gaps = [];

  Object.entries(REQUIRED_FIELDS).forEach(([stage, fields]) => {
    if ((STAGE_INDEX[stage] ?? 0) > reached) return;
    fields.forEach(([path, label]) => {
      const value = getByPath(item, path);
      if (value === undefined || value === null || value === "") gaps.push(label);
    });
  });

  if (reached >= STAGE_INDEX.Live) {
    if (!primaryImageUrl(item)) gaps.push("Photo");
    if (!item.verified) gaps.push("Verify");
  }
  if (reached >= STAGE_INDEX.Selected && !(item.closetOwner || "").trim()) gaps.push("Closet Owner");

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

// One card used by Selected / Live / Sold.
function itemCard(item) {
  const d = calc(item);
  const stage = STAGE_INDEX[item.status] ?? 0;

  const closet = cardSection("Closet", [
    ["Owner", escapeHTML(item.closetOwner || "—")],
    ["Min Payout", item.ownerMinPayout ? formatMoney(item.ownerMinPayout) : "—"],
    ["Commission", `${num(d.pct)}%`]
  ]);

  let selection = "";
  if (stage >= STAGE_INDEX.Selected) {
    selection = cardSection("Selection", [
      ["Drop", escapeHTML(dropLabel(item))],
      ["List Price", formatMoney(d.listPrice)],
      ["Exp. Commission", formatMoney(d.expectedCommission)],
      ["Exp. Owner Payout", formatMoney(d.expectedOwnerPayout)],
      ["Verified", item.verified ? "Yes" : "No"]
    ]);
  }

  let sale = "";
  if (stage >= STAGE_INDEX.Sold) {
    sale = cardSection("Sale", [
      ["Sold Price", formatMoney(d.soldPrice)],
      ["Poda Commission", formatMoney(d.finalCommission)],
      ["Owner Payout", `<span class="cell-pos">${formatMoney(d.ownerPayout)}</span>`],
      ["Date Sold", escapeHTML(item.dateSold || "—")],
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
        ${closet}
        ${selection}
        ${sale}
        <div class="closet-card__status" data-no-edit>${statusSelect(item)}</div>
      </div>
    </article>
  `;
}

/* ============================================================
   View: Selected — grouped by drop
   ============================================================ */
function renderSelected() {
  const items = state.items.filter(i => i.status === "Selected");
  adminMain.innerHTML = `
    ${sectionBar("Admin", "Selected")}
    <p class="admin-hint">Pieces picked for a drop. Once you physically have and verify one, set it to <strong>Live</strong> to publish it.</p>
    ${items.length
      ? `<div class="closet-grid">${items.map(itemCard).join("")}</div>`
      : `<p class="admin-empty">Nothing selected yet. Pull pieces in from <strong>Available</strong>.</p>`
    }
  `;
}

/* ============================================================
   View: Live — the current store
   ============================================================ */
function renderLive() {
  const items = state.items.filter(i => i.status === "Live");
  adminMain.innerHTML = `
    ${sectionBar("Admin", "Live")}
    <p class="admin-hint">Currently for sale on the public Drop. Set to <strong>Sold</strong> and enter the final price to record a sale.</p>
    ${items.length
      ? `<div class="closet-grid">${items.map(itemCard).join("")}</div>`
      : `<p class="admin-empty">Nothing live yet.</p>`
    }
  `;
}

/* ============================================================
   View: Sold — realized figures + payouts
   ============================================================ */
function renderSold() {
  const items = state.items.filter(i => i.status === "Sold");

  const gmv = items.reduce((sum, i) => sum + calc(i).soldPrice, 0);
  const revenue = items.reduce((sum, i) => sum + calc(i).finalCommission, 0);
  const owed = items.reduce((sum, i) => sum + calc(i).ownerPayout, 0);
  const days = items.map(i => calc(i).daysToSell).filter(v => v !== null);
  const avgDays = days.length ? days.reduce((s, v) => s + v, 0) / days.length : 0;

  adminMain.innerHTML = `
    ${sectionBar("Admin", "Sold")}
    <div class="summary-bar">
      <div><span>Items Sold</span><strong>${items.length}</strong></div>
      <div><span>GMV</span><strong>${formatMoney(gmv)}</strong></div>
      <div><span>Poda Revenue</span><strong>${formatMoney(revenue)}</strong></div>
      <div><span>Owed to Consignors</span><strong>${formatMoney(owed)}</strong></div>
      <div><span>Avg Days to Sell</span><strong>${avgDays ? avgDays.toFixed(0) : "0"}</strong></div>
    </div>
    ${items.length
      ? `<div class="closet-grid">${items.map(itemCard).join("")}</div>`
      : `<p class="admin-empty">No sold items yet.</p>`
    }
  `;
}

/* ============================================================
   View: All Items — full filterable table
   ============================================================ */
function renderAllItems() {
  const rows = applyFilters(state.items, { useStatus: true }).map(item => {
    const d = calc(item);
    return `
      <tr data-edit-id="${escapeHTML(item.id)}">
        <td>${thumbCell(item)}</td>
        <td class="cell-mono">${escapeHTML(item.id)}</td>
        <td>${escapeHTML(item.closetOwner || "—")}</td>
        <td class="cell-strong">${escapeHTML(item.brand)}</td>
        <td>${escapeHTML(item.itemName)}</td>
        <td data-no-edit>${statusSelect(item)}</td>
        <td class="cell-mono">${escapeHTML(dropLabel(item))}</td>
        <td class="cell-num">${d.listPrice ? formatMoney(d.listPrice) : "—"}</td>
        <td class="cell-num">${item.status === "Sold" ? formatMoney(d.soldPrice) : "—"}</td>
      </tr>
    `;
  }).join("");

  adminMain.innerHTML = `
    ${sectionBar("Admin", "All Items")}
    ${filterBar(true)}
    ${state.items.length === 0
      ? `<p class="admin-empty">No items yet.</p>`
      : `<div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th></th><th>Item ID</th><th>Closet</th><th>Brand</th><th>Name</th>
                <th>Status</th><th>Drop</th><th class="cell-num">List</th><th class="cell-num">Sold</th>
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="9" class="admin-empty">No items match these filters.</td></tr>`}</tbody>
          </table>
        </div>`
    }
  `;
}

/* ============================================================
   Modal — form building
   ============================================================ */
const modalOverlay = document.getElementById("modalOverlay");
const modalContent = document.getElementById("modalContent");

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

function calcField(label, id, value) {
  return `
    <div class="field field--calc">
      <label>${escapeHTML(label)}</label>
      <output id="${id}">${value}</output>
    </div>
  `;
}

// Datalist of existing closet owners so the admin can reuse a closet quickly.
function ownerDatalist() {
  const owners = ownerValues();
  return `<datalist id="ownerList">${owners.map(o => `<option value="${escapeHTML(o)}"></option>`).join("")}</datalist>`;
}

function buildForm(item) {
  const d = calc(item);

  return `
    <form id="itemForm" novalidate>
      <p class="field-error" id="formError" hidden></p>
      ${ownerDatalist()}

      <!-- Status (locked — change from the item card/row) -->
      <section class="form-card">
        <div class="section-bar"><span class="section-bar__title">Status</span></div>
        <div class="form-section">
          <div class="toggle-group toggle-group--wrap" role="group" aria-label="Status (locked)">
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

      <!-- Item identity -->
      <section class="form-card">
        <div class="section-bar"><span class="section-bar__title">Item</span></div>
        <div class="field-grid">
          ${textField("Brand", "brand", item.brand)}
          ${textField("Item Name", "itemName", item.itemName)}
          ${selectField("Category", "category", item.category, CATEGORIES)}
          ${textField("Size", "size", item.size)}
          ${textField("Measurements", "measurements", item.measurements, { placeholder: "e.g. Chest 21in · Length 28in" })}
          ${textField("Material", "material", item.material, { placeholder: "e.g. Wool / nylon" })}
          ${textField("Color", "color", item.color)}
          ${textField("Season / Era", "season", item.season, { placeholder: "e.g. FW03, when known" })}
          ${selectField("Condition", "condition", item.condition, CONDITIONS)}
          ${textField("Condition Notes", "conditionNotes", item.conditionNotes, { placeholder: "Any flaws / wear" })}
          ${textareaField("Public Description", "publicDescription", item.publicDescription)}
          ${textareaField("Why poda selected it", "selectionReason", item.selectionReason)}
          ${textareaField("Private Notes", "privateNotes", item.privateNotes)}
        </div>
      </section>

      <!-- Source & transaction (drives the public CTA) -->
      <section class="form-card">
        <div class="section-bar"><span class="section-bar__title">Source &amp; Transaction</span></div>
        <div class="field-grid">
          ${selectField("Source Type", "sourceType", item.sourceType, SOURCE_TYPES)}
          ${textField("Source Name", "sourceName", item.sourceName, { placeholder: "e.g. Independent Brand 01" })}
          ${selectField("Transaction Type", "transactionType", item.transactionType, TRANSACTION_TYPES)}
          ${textField("Partner URL", "externalUrl", item.externalUrl, { placeholder: "Only for 'partner' items" })}
          ${textField("Item ID", "itemCode", item.itemCode, { placeholder: "PODA-001-FW-001" })}
        </div>
      </section>

      <!-- Closet / consignment (base) -->
      <section class="form-card">
        <div class="section-bar"><span class="section-bar__title">Closet</span></div>
        <div class="field-grid">
          <div class="field">
            <label for="closetOwner">Closet Owner</label>
            <input name="closetOwner" id="closetOwner" list="ownerList" value="${escapeHTML(item.closetOwner ?? "")}" placeholder="Whose closet?" />
          </div>
          ${numberField("Owner Min Payout", "ownerMinPayout", item.ownerMinPayout)}
          ${numberField("Commission %", "commissionPercent", item.commissionPercent, { placeholder: String(DEFAULT_COMMISSION_PCT) })}
        </div>
      </section>

      <!-- Selection / pricing (Selected stage) -->
      <section class="form-card" data-stage="Selected">
        <div class="section-bar"><span class="section-bar__title">Selection &amp; Pricing</span></div>
        <div class="field-grid">
          ${textField("Drop #", "dropNumber", item.dropNumber, { placeholder: "e.g. 001" })}
          ${dateField("Date Selected", "dateSelected", item.dateSelected)}
          ${numberField("Poda List Price", "pricing.currentListPrice", item.pricing.currentListPrice, { required: true, placeholder: "Required" })}
          ${calcField("Poda Commission", "calcCommission", formatMoney2(d.expectedCommission))}
          ${calcField("Owner Payout", "calcOwnerPayout", formatMoney2(d.expectedOwnerPayout))}
        </div>
      </section>

      <!-- Verification / go-live (Live stage) -->
      <section class="form-card" data-stage="Live">
        <div class="section-bar"><span class="section-bar__title">Verification</span></div>
        <div class="field-grid">
          ${checkboxField("Verified — in hand, condition & measurements checked", "verified", item.verified)}
          ${dateField("Date Live", "dateLive", item.dateLive)}
        </div>
      </section>

      <!-- Sale (Sold stage) -->
      <section class="form-card" data-stage="Sold">
        <div class="section-bar"><span class="section-bar__title">Sale</span></div>
        <div class="field-grid">
          ${dateField("Date Sold", "dateSold", item.dateSold)}
          ${numberField("Final Sold Price", "soldActuals.finalSalePrice", item.soldActuals.finalSalePrice)}
          ${calcField("Poda Commission", "calcFinalCommission", formatMoney2(d.finalCommission))}
          ${calcField("Owner Payout", "calcFinalOwnerPayout", formatMoney2(d.ownerPayout))}
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
      img.onerror = () => resolve(reader.result);
      img.src = reader.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function handleImageUpload(event) {
  const files = [...event.target.files];
  if (!files.length) return;

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

  event.target.value = "";
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

function clearStageFields(item, stage) {
  const defaults = blankItem();
  (STAGE_FIELDS[stage] || []).forEach(path => setByPath(item, path, getByPath(defaults, path)));
}

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
    else if (element.type === "number") value = element.value === "" ? null : Number(element.value);
    else value = element.value;

    setByPath(base, name, value);
  });

  return base;
}

function recalcForm() {
  const item = readForm();
  const d = calc(item);

  const outputs = {
    calcCommission: formatMoney2(d.expectedCommission),
    calcOwnerPayout: formatMoney2(d.expectedOwnerPayout),
    calcFinalCommission: formatMoney2(d.finalCommission),
    calcFinalOwnerPayout: formatMoney2(d.ownerPayout),
    calcDaysToSell: d.daysToSell === null ? "—" : String(d.daysToSell)
  };
  Object.entries(outputs).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });
}

function handleFormInput() {
  recalcForm();
}

// Show/hide stage cards: a stage card stays hidden until the item reaches it.
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

  const missing = [];
  if (!item.brand.trim()) missing.push("Brand");
  if (!item.itemName.trim()) missing.push("Item Name");
  if (!item.category) missing.push("Category");
  const stage = STAGE_INDEX[item.status] ?? 0;
  if (stage >= STAGE_INDEX.Selected && !String(item.dropNumber || "").trim()) missing.push("Drop #");
  if (stage >= STAGE_INDEX.Selected && !(num(item.pricing.currentListPrice) > 0)) missing.push("List Price");
  if (stage >= STAGE_INDEX.Sold && !(num(item.soldActuals.finalSalePrice) > 0)) missing.push("Sold Price");

  if (missing.length) {
    errorBox.textContent = `Missing required field(s): ${missing.join(", ")}.`;
    errorBox.hidden = false;
    modalContent.querySelector(".modal-body").scrollTop = 0;
    return;
  }

  item.brandCode = item.brandCode || makeBrandCode(item.brand);
  if (!item.id) item.id = generateItemId(item);

  try {
    await upsertItem(item);
  } catch (error) {
    return;
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
          return;
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

function bindMainEvents() {
  adminMain.addEventListener("click", event => {
    if (event.target.closest("[data-new-item]")) { openModal(null); return; }
    if (event.target.closest("[data-new-note]")) { openNoteModal(null); return; }
    if (event.target.closest("[data-new-drop]")) { openDropModal(null); return; }
    if (event.target.closest("[data-new-study]")) { openStudyModal(null); return; }
    if (event.target.closest("[data-export-subscribers]")) { exportSubscribersCSV(); return; }
    if (event.target.closest("[data-no-edit]")) return;

    const sendBtn = event.target.closest("[data-send-note]");
    if (sendBtn) { openSendModal(sendBtn.dataset.sendNote); return; }

    const noteRow = event.target.closest("[data-note-edit]");
    if (noteRow) { openNoteModal(noteRow.dataset.noteEdit); return; }

    const dropRow = event.target.closest("[data-drop-edit]");
    if (dropRow) { openDropModal(dropRow.dataset.dropEdit); return; }

    const studyRow = event.target.closest("[data-study-edit]");
    if (studyRow) { openStudyModal(studyRow.dataset.studyEdit); return; }

    const row = event.target.closest("[data-edit-id]");
    if (row) openModal(row.dataset.editId);
  });

  // Inline status change — drives the whole lifecycle.
  adminMain.addEventListener("change", async event => {
    const subStatusEl = event.target.closest("[data-subscriber-status-for]");
    if (subStatusEl) {
      const id = subStatusEl.dataset.subscriberStatusFor;
      const newStatus = subStatusEl.value;
      const sub = subscriberState.subscribers.find(s => s.id === id);
      if (!sub) return;
      try {
        const patch = { status: newStatus };
        if (newStatus === "UNSUBSCRIBED") patch.unsubscribedAt = new Date().toISOString();
        const merged = await window.PodaDB.updateSubscriber(id, patch);
        Object.assign(sub, merged);
      } catch (error) {
        alert("Could not update the subscriber. Check your connection and try again.");
      }
      renderCurrentView();
      return;
    }

    const statusEl = event.target.closest("[data-status-for]");
    if (statusEl) {
      const item = getItemById(statusEl.dataset.statusFor);
      if (item) {
        const oldStatus = item.status;
        const newStatus = statusEl.value;
        const allowed = TRANSITIONS[oldStatus] || [];

        if (!allowed.includes(newStatus)) { renderCurrentView(); return; }

        const oldIndex = STAGE_INDEX[oldStatus] ?? 0;
        const newIndex = STAGE_INDEX[newStatus] ?? 0;
        const today = new Date().toISOString().slice(0, 10);

        if (newIndex > oldIndex) {
          // Moving forward — auto-stamp the stage date if not already set.
          if (newStatus === "Selected" && !item.dateSelected) item.dateSelected = today;
          if (newStatus === "Live" && !item.dateLive) item.dateLive = today;
          if (newStatus === "Sold" && !item.dateSold) item.dateSold = today;
        } else if (newIndex < oldIndex) {
          // Reverting — clear every stage above the new one so it's re-entered.
          if (STAGE_INDEX.Sold > newIndex) clearStageFields(item, "Sold");
          if (STAGE_INDEX.Live > newIndex) clearStageFields(item, "Live");
          if (STAGE_INDEX.Selected > newIndex) clearStageFields(item, "Selected");
        }

        item.status = newStatus;
        try {
          await upsertItem(item);
        } catch (error) {
          state.items = await loadItems();
        }
        renderCurrentView();
      }
      return;
    }

    const filterEl = event.target.closest("[data-filter]");
    if (filterEl && filterEl.dataset.filter !== "brand") {
      state.filters[filterEl.dataset.filter] = filterEl.value;
      renderCurrentView();
    }
  });

  adminMain.addEventListener("input", event => {
    const filterEl = event.target.closest('[data-filter="brand"]');
    if (filterEl) {
      state.filters.brand = filterEl.value;
      renderCurrentView();
    }
  });
}

function bindGlobalEvents() {
  document.querySelectorAll(".admin-nav__link").forEach(link => {
    link.addEventListener("click", () => setView(link.dataset.view));
  });

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

async function startApp() {
  if (appStarted) return;
  appStarted = true;
  loginGate.hidden = true;
  adminApp.hidden = false;
  [state.items, noteState.notes, dropState.drops, studyState.studies, subscriberState.subscribers] = await Promise.all([
    loadItems(),
    window.PodaDB.getNotes().catch(() => []),
    window.PodaDB.getDrops ? window.PodaDB.getDrops().catch(() => []) : Promise.resolve([]),
    window.PodaDB.getStudies ? window.PodaDB.getStudies().catch(() => []) : Promise.resolve([]),
    window.PodaDB.getSubscribers ? window.PodaDB.getSubscribers().catch(() => []) : Promise.resolve([])
  ]);
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
      loginError.textContent = error && error.message ? error.message : "Sign in failed. Check your email and password.";
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
   Download the inventory workbook (Excel).
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
   JSON backup + restore — full-fidelity safety net.
   ============================================================ */
function downloadBackup() {
  const payload = {
    type: "poda-backup",
    version: 2,
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
  event.target.value = "";
  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    alert("That file isn't valid JSON. Choose a Poda backup file (.json).");
    return;
  }

  const list = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.items) ? parsed.items : null);
  if (!list) {
    alert("This doesn't look like a Poda backup (no items found).");
    return;
  }

  const items = list.filter(item => item && typeof item.id === "string" && item.id);
  if (!items.length) {
    alert("No valid items were found in that backup.");
    return;
  }

  if (!confirm(`Restore ${items.length} item(s) from this backup?\nAny existing item with the same ID will be overwritten.`)) {
    return;
  }

  let restored = 0, failed = 0;
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
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (error) { raw = null; }

  let legacyItems = [];
  try { legacyItems = raw ? JSON.parse(raw) : []; } catch (error) { legacyItems = []; }

  if (!Array.isArray(legacyItems) || !legacyItems.length) {
    alert("No saved items were found in this browser to import.");
    return;
  }

  if (!confirm(`Import ${legacyItems.length} item(s) from this browser into the database?`)) return;

  let imported = 0, failed = 0;
  for (const item of legacyItems) {
    try {
      const map = new Map();
      const uploaded = [];
      for (const img of Array.isArray(item.images) ? item.images : []) {
        if (typeof img !== "string" || !img) continue;
        const url = img.startsWith("data:") ? await window.PodaDB.uploadImage(img) : img;
        map.set(img, url);
        uploaded.push(url);
      }
      item.images = uploaded;
      if (item.primaryImage) item.primaryImage = map.get(item.primaryImage) || uploaded[0] || "";

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
   Market Notes — Poda's public buy / sell / watch brain
   ============================================================ */
const NOTE_CATEGORIES = ["buy", "sell", "watch"];

const noteState = { notes: [] };

function blankNote() {
  return {
    id: "",
    title: "",
    subtitle: "",
    body: "",
    coverImage: "",
    category: "buy",        // "buy" | "sell" | "watch"
    substackUrl: "",
    status: "draft",        // "draft" | "published"
    publishedAt: "",
    createdAt: new Date().toISOString()
  };
}

function generateNoteId() {
  const yy = String(new Date().getFullYear()).slice(-2);
  const existing = noteState.notes
    .map(n => Number((n.id || "").replace(/^NOTE-\d{2}-/, "")))
    .filter(Number.isFinite);
  const next = existing.length ? Math.max(...existing) + 1 : 1;
  return `NOTE-${yy}-${String(next).padStart(3, "0")}`;
}

function noteDateLabel(note) {
  const d = note.publishedAt || note.createdAt;
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function categoryBadge(category) {
  const c = String(category || "").toLowerCase();
  const cls = { buy: "badge--available", sell: "badge--selected", watch: "badge--listed" }[c] || "badge--draft";
  return `<span class="badge ${cls}">${escapeHTML(c ? c.toUpperCase() : "—")}</span>`;
}

function renderNotes() {
  const notes = noteState.notes;

  const rows = notes.map(note => `
    <tr data-note-edit="${escapeHTML(note.id)}">
      <td class="cell-mono">${escapeHTML(note.id)}</td>
      <td>${categoryBadge(note.category)}</td>
      <td class="cell-strong">${escapeHTML(note.title || "Untitled")}</td>
      <td>${escapeHTML(note.subtitle || "—")}</td>
      <td><span class="badge ${note.status === "published" ? "badge--listed" : "badge--draft"}">${escapeHTML(note.status)}</span></td>
      <td>${escapeHTML(noteDateLabel(note))}</td>
      <td>
        <a class="card-link" href="note.html?id=${encodeURIComponent(note.id)}" target="_blank" rel="noopener"
           onclick="event.stopPropagation()">View ↗</a>
        ${note.status === "published"
          ? `<button type="button" class="card-link" data-send-note="${escapeHTML(note.id)}">Send ↗</button>`
          : ""}
      </td>
    </tr>
  `).join("");

  adminMain.innerHTML = `
    <div class="section-bar section-bar--admin">
      <span class="section-bar__label">Research</span>
      <span class="section-bar__title">Inbox</span>
      <button type="button" class="admin-newitem section-bar__action" data-new-note>+ New Note</button>
    </div>
    ${notes.length === 0
      ? `<p class="admin-empty">No notes yet. Use "+ New Note" to write your first one.</p>`
      : `<div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr><th>ID</th><th>Type</th><th>Title</th><th>Subtitle</th><th>Status</th><th>Date</th><th></th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`
    }
  `;
}

/* ============================================================
   Send Market Note by email (Module 2 — Resend, via /api/notes-send)
   ============================================================ */
let sendModalState = null;

function sendModalExcerpt(note, maxLen = 220) {
  const source = note.subtitle || note.body || "";
  const text = String(source).replace(/\s+/g, " ").trim();
  if (!text) return "Read the latest from poda.";
  return text.length > maxLen ? `${text.slice(0, maxLen).trimEnd()}…` : text;
}

function activeSubscriberCount() {
  return subscriberState.subscribers.filter(
    s => s.status === "ACTIVE" && String(s.email || "").trim()
  ).length;
}

function openSendModal(noteId) {
  const note = noteState.notes.find(n => n.id === noteId);
  if (!note) return;

  sendModalState = { noteId, phase: "preview", result: null, error: null, confirmText: "" };
  renderSendModal(note);

  modalOverlay.hidden = false;
  document.body.style.overflow = "hidden";
}

function renderSendModal(note) {
  const s = sendModalState;
  const subject = note.title ? `poda Inbox: ${note.title}` : "poda Inbox";
  const excerpt = sendModalExcerpt(note);
  const activeCount = activeSubscriberCount();

  const previewHTML = `
    <div class="send-preview">
      <p class="send-preview__meta">Subject: <strong>${escapeHTML(subject)}</strong></p>
      <div class="send-preview__card">
        ${note.coverImage ? `<img src="${escapeHTML(note.coverImage)}" alt="" class="send-preview__image" />` : ""}
        <h3 class="send-preview__title">${escapeHTML(note.title || "Untitled")}</h3>
        <p class="send-preview__excerpt">${escapeHTML(excerpt)}</p>
        <span class="btn btn--primary send-preview__btn">Read the full note →</span>
      </div>
      <p class="send-preview__plain">Plain-text fallback is generated automatically from the same content.</p>
    </div>
  `;

  let actionHTML = "";
  if (s.phase === "preview") {
    actionHTML = `
      <div class="send-actions">
        <button type="button" class="btn" id="sendTestBtn">Send test to me</button>
        <button type="button" class="btn btn--primary" id="startBroadcastBtn">Send to active subscribers</button>
      </div>
      <p class="send-note-meta">${activeCount} active subscriber${activeCount === 1 ? "" : "s"} would receive this.</p>
      ${s.error ? `<p class="field-error">${escapeHTML(s.error)}</p>` : ""}
      ${s.result && s.result.mode === "test"
        ? `<p class="field-success">Test sent to ${escapeHTML(s.result.to || "")}.</p>`
        : ""}
    `;
  } else if (s.phase === "confirm") {
    actionHTML = `
      <div class="send-confirm">
        <p class="send-confirm__warning">This sends a real email to <strong>${activeCount}</strong> active subscriber${activeCount === 1 ? "" : "s"}. This cannot be undone.</p>
        <label class="field field--full">
          <span>Type SEND to confirm</span>
          <input type="text" id="sendConfirmInput" autocomplete="off" value="${escapeHTML(s.confirmText)}" />
        </label>
        ${s.priorSend
          ? `<p class="field-error">Already sent as a broadcast on ${escapeHTML(new Date(s.priorSend.created_at).toLocaleString())} (${s.priorSend.succeeded}/${s.priorSend.attempted} delivered).
              <label style="display:block;margin-top:6px;"><input type="checkbox" id="sendOverrideBox" /> Send again anyway</label></p>`
          : ""}
        ${s.error ? `<p class="field-error">${escapeHTML(s.error)}</p>` : ""}
        <div class="send-actions">
          <button type="button" class="btn" id="cancelBroadcastBtn">Cancel</button>
          <button type="button" class="btn btn--primary" id="confirmBroadcastBtn" disabled>Confirm &amp; send</button>
        </div>
      </div>
    `;
  } else if (s.phase === "sending") {
    actionHTML = `<p class="send-note-meta">Sending…</p>`;
  } else if (s.phase === "done") {
    const r = s.result || {};
    actionHTML = `
      <div class="send-result">
        <p class="field-success">
          Broadcast ${escapeHTML(r.status || "completed")} — ${r.succeeded || 0} sent, ${r.failed || 0} failed
          ${r.skipped ? `, ${r.skipped} skipped (no email)` : ""}.
        </p>
        <div class="send-actions"><button type="button" class="btn" id="closeSendBtn">Close</button></div>
      </div>
    `;
  }

  modalContent.innerHTML = `
    <div class="modal-head">
      <h2 class="modal-title">Send: ${escapeHTML(note.title || "Untitled")}</h2>
      <button type="button" class="modal-close" id="modalClose" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      ${previewHTML}
      ${actionHTML}
    </div>
  `;

  bindSendModalButtons(note);
}

/* Binds fresh listeners to this render's buttons. Since renderSendModal()
   fully replaces modalContent.innerHTML on every phase change, the previous
   render's buttons (and their listeners) are discarded with them — this must
   be called again after every render, exactly like bindModalEvents() does
   for the item editor. Never delegate to the persistent #modalContent
   container here, or listeners (and their closured `note`) would stack up
   across separate modal opens. */
function bindSendModalButtons(note) {
  const byId = id => document.getElementById(id);

  byId("modalClose")?.addEventListener("click", () => {
    closeModal();
    sendModalState = null;
  });

  byId("sendTestBtn")?.addEventListener("click", async () => {
    const btn = byId("sendTestBtn");
    btn.disabled = true;
    btn.textContent = "Sending…";
    sendModalState.error = null;
    try {
      const result = await window.PodaDB.sendNoteEmail({ noteId: note.id, mode: "test" });
      if (!result.ok) throw new Error(result.error || "Test send failed.");
      sendModalState.result = result;
    } catch (e) {
      sendModalState.error = e.message || "Test send failed.";
    }
    renderSendModal(note);
  });

  byId("startBroadcastBtn")?.addEventListener("click", () => {
    sendModalState.phase = "confirm";
    sendModalState.confirmText = "";
    sendModalState.priorSend = null;
    sendModalState.error = null;
    renderSendModal(note);
  });

  byId("cancelBroadcastBtn")?.addEventListener("click", () => {
    sendModalState.phase = "preview";
    renderSendModal(note);
  });

  byId("sendConfirmInput")?.addEventListener("input", event => {
    sendModalState.confirmText = event.target.value;
    const confirmBtn = byId("confirmBroadcastBtn");
    if (confirmBtn) confirmBtn.disabled = event.target.value.trim() !== "SEND";
  });

  byId("confirmBroadcastBtn")?.addEventListener("click", async () => {
    const btn = byId("confirmBroadcastBtn");
    if (btn.disabled) return;
    btn.disabled = true;
    sendModalState.phase = "sending";
    renderSendModal(note);

    const override = !!byId("sendOverrideBox")?.checked;
    try {
      const result = await window.PodaDB.sendNoteEmail({
        noteId: note.id,
        mode: "broadcast",
        confirm: "SEND",
        override
      });
      if (result.httpStatus === 409) {
        sendModalState.phase = "confirm";
        sendModalState.priorSend = result.priorSend;
        sendModalState.error = result.error;
      } else if (!result.ok) {
        sendModalState.phase = "confirm";
        sendModalState.error = result.error || "Send failed.";
      } else {
        sendModalState.phase = "done";
        sendModalState.result = result;
      }
    } catch (e) {
      sendModalState.phase = "confirm";
      sendModalState.error = "Network error — please try again.";
    }
    renderSendModal(note);
  });

  byId("closeSendBtn")?.addEventListener("click", () => {
    closeModal();
    sendModalState = null;
  });
}

/* ============================================================
   Subscribers — email list (Module 1: capture only, no sending)
   ============================================================ */
const subscriberState = { subscribers: [] };
const SUBSCRIBER_STATUSES = ["ACTIVE", "UNSUBSCRIBED", "SUPPRESSED"];

function subscriberStatusBadgeClass(status) {
  const map = {
    ACTIVE: "badge--available",
    UNSUBSCRIBED: "badge--draft",
    SUPPRESSED: "badge--sold"
  };
  return map[status] || "badge--draft";
}

function subscriberDateLabel(sub) {
  const d = sub.createdAt;
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function subscriberStatusSelect(sub) {
  const options = SUBSCRIBER_STATUSES.map(status =>
    `<option value="${escapeHTML(status)}"${status === sub.status ? " selected" : ""}>${escapeHTML(status)}</option>`
  ).join("");
  return `<select class="status-select" data-subscriber-status-for="${escapeHTML(sub.id)}" aria-label="Subscriber status">${options}</select>`;
}

function renderSubscribers() {
  const subs = subscriberState.subscribers;
  const activeCount = subs.filter(s => s.status === "ACTIVE").length;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentCount = subs.filter(s => s.createdAt && new Date(s.createdAt).getTime() >= weekAgo).length;

  const rows = subs.map(sub => `
    <tr data-no-edit>
      <td class="cell-strong">${escapeHTML(sub.email || "—")}</td>
      <td>${escapeHTML(sub.firstName || "—")}</td>
      <td>${escapeHTML(sub.source || "—")}</td>
      <td><span class="badge ${subscriberStatusBadgeClass(sub.status)}">${escapeHTML(sub.status || "—")}</span></td>
      <td>${escapeHTML(subscriberDateLabel(sub))}</td>
      <td data-no-edit>${subscriberStatusSelect(sub)}</td>
    </tr>
  `).join("");

  adminMain.innerHTML = `
    <div class="section-bar section-bar--admin">
      <span class="section-bar__label">Audience</span>
      <span class="section-bar__title">Subscribers</span>
      <button type="button" class="admin-newitem section-bar__action" data-export-subscribers>Export CSV</button>
    </div>
    <p class="subscriber-stats">
      ${activeCount} active subscriber${activeCount === 1 ? "" : "s"} · ${recentCount} in the last 7 days
    </p>
    ${subs.length === 0
      ? `<p class="admin-empty">No subscribers yet.</p>`
      : `<div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr><th>Email</th><th>First name</th><th>Source</th><th>Status</th><th>Signed up</th><th></th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`
    }
  `;
}

function subscribersToCSV(subs) {
  const header = ["email", "firstName", "source", "status", "consent", "consentAt", "createdAt"];
  const escapeCSV = value => {
    const str = String(value ?? "");
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [header.join(",")];
  subs.forEach(sub => {
    lines.push(header.map(key => escapeCSV(sub[key])).join(","));
  });
  return lines.join("\n");
}

function exportSubscribersCSV() {
  const csv = subscribersToCSV(subscriberState.subscribers);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `poda_subscribers_${date}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function buildNoteForm(note) {
  return `
    <form id="noteForm" novalidate>
      <p class="field-error" id="noteFormError" hidden></p>

      <section class="form-card">
        <div class="section-bar"><span class="section-bar__title">Note</span></div>
        <div class="field-grid">
          <div class="field">
            <label>Type</label>
            <div class="toggle-group" role="group" style="max-width:280px">
              ${NOTE_CATEGORIES.map(cat =>
                `<button type="button" class="toggle note-cat-btn${note.category === cat ? " active" : ""}" data-note-cat="${cat}">${cat.toUpperCase()}</button>`
              ).join("")}
            </div>
            <input type="hidden" name="note.category" id="noteCatInput" value="${escapeHTML(note.category || "buy")}" />
          </div>
          ${textField("Title", "note.title", note.title, { full: true })}
          ${textField("Subtitle / Deck", "note.subtitle", note.subtitle, { full: true })}
          ${textField("Cover Image URL", "note.coverImage", note.coverImage, { full: true, placeholder: "https://…" })}
          ${textField("Substack Article URL (optional)", "note.substackUrl", note.substackUrl || "", { full: true, placeholder: "https://…" })}
        </div>
      </section>

      <section class="form-card">
        <div class="section-bar"><span class="section-bar__title">Body</span></div>
        <div class="field-grid">
          ${textareaField("Body — blank line = new paragraph · [img: url] on its own line = inline image", "note.body", note.body, { full: true })}
          <div class="field field--full">
            <label style="margin-bottom:6px;display:block;">Insert inline image</label>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <label class="btn" style="cursor:pointer;min-height:36px;display:inline-flex;align-items:center;padding:0 14px;">
                Upload image
                <input type="file" id="noteBodyImageInput" accept="image/*" hidden />
              </label>
              <span id="noteBodyImageStatus" style="font-size:10px;color:var(--text-dim);letter-spacing:0.08em;"></span>
            </div>
          </div>
        </div>
      </section>

      <section class="form-card">
        <div class="section-bar"><span class="section-bar__title">Publish</span></div>
        <div class="field-grid">
          <div class="field">
            <label>Status</label>
            <div class="toggle-group" role="group" style="max-width:240px">
              <button type="button" class="toggle note-status-btn${note.status === "draft" ? " active" : ""}" data-note-status="draft">Draft</button>
              <button type="button" class="toggle note-status-btn${note.status === "published" ? " active" : ""}" data-note-status="published">Published</button>
            </div>
            <input type="hidden" name="note.status" id="noteStatusInput" value="${escapeHTML(note.status)}" />
          </div>
          ${dateField("Publish Date", "note.publishedAt",
              note.publishedAt ? note.publishedAt.slice(0, 10) : new Date().toISOString().slice(0, 10))}
        </div>
      </section>
    </form>
  `;
}

function openNoteModal(noteId = null) {
  const editing = noteId ? noteState.notes.find(n => n.id === noteId) : null;
  const note = editing ? structuredClone(editing) : blankNote();

  modalContent.innerHTML = `
    <div class="modal-head">
      <h2 class="modal-title">${editing ? "Edit Note" : "New Note"}</h2>
      <button type="button" class="modal-close" id="modalClose" aria-label="Close">×</button>
    </div>
    <div class="modal-body">${buildNoteForm(note)}</div>
    <div class="modal-foot">
      ${editing ? `<button type="button" class="btn btn--danger" id="deleteNoteBtn">Delete</button>` : ""}
      <button type="button" class="btn" id="cancelNoteBtn">Cancel</button>
      <button type="button" class="btn btn--primary" id="saveNoteBtn">Save Note</button>
    </div>
  `;

  modalOverlay.hidden = false;
  document.body.style.overflow = "hidden";

  // Category toggle
  modalContent.querySelectorAll(".note-cat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      modalContent.querySelectorAll(".note-cat-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("noteCatInput").value = btn.dataset.noteCat;
    });
  });

  // Status toggle
  modalContent.querySelectorAll(".note-status-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      modalContent.querySelectorAll(".note-status-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("noteStatusInput").value = btn.dataset.noteStatus;
    });
  });

  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("cancelNoteBtn").addEventListener("click", closeModal);
  document.getElementById("saveNoteBtn").addEventListener("click", () => saveNote(noteId));

  document.getElementById("noteBodyImageInput").addEventListener("change", async event => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;

    const statusEl = document.getElementById("noteBodyImageStatus");
    const textarea = document.querySelector('[name="note.body"]');
    statusEl.textContent = "Uploading…";

    try {
      const dataUrl = await compressImage(file);
      const url = await window.PodaDB.uploadImage(dataUrl);
      const tag = `\n\n[img: ${url}]\n\n`;
      if (textarea && typeof textarea.selectionStart === "number") {
        const start = textarea.selectionStart;
        const before = textarea.value.slice(0, start);
        const after  = textarea.value.slice(textarea.selectionEnd);
        textarea.value = before + tag + after;
        textarea.selectionStart = textarea.selectionEnd = start + tag.length;
        textarea.focus();
      } else if (textarea) {
        textarea.value += tag;
      }
      statusEl.textContent = "✓ Image inserted";
      setTimeout(() => { statusEl.textContent = ""; }, 3000);
    } catch (err) {
      statusEl.textContent = "Upload failed — try again.";
      console.error(err);
    }
  });

  const deleteBtn = document.getElementById("deleteNoteBtn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (!confirm("Delete this note permanently?")) return;
      try {
        await window.PodaDB.deleteNote(noteId);
        noteState.notes = noteState.notes.filter(n => n.id !== noteId);
      } catch (e) {
        alert("Could not delete the note. Check your connection and try again.");
        return;
      }
      closeModal();
      renderNotes();
    });
  }
}

function readNoteForm(existingId) {
  const form = document.getElementById("noteForm");
  const note = existingId
    ? structuredClone(noteState.notes.find(n => n.id === existingId) || blankNote())
    : blankNote();

  form.querySelectorAll("input[name], select[name], textarea[name]").forEach(el => {
    const key = el.getAttribute("name").replace("note.", "");
    if (!key) return;
    note[key] = el.type === "checkbox" ? el.checked : el.value;
  });

  return note;
}

async function saveNote(existingId) {
  const note = readNoteForm(existingId);
  const errorBox = document.getElementById("noteFormError");

  if (!note.title.trim()) {
    errorBox.textContent = "Title is required.";
    errorBox.hidden = false;
    return;
  }

  if (!note.id) note.id = generateNoteId();
  if (note.status === "published" && !note.publishedAt) {
    note.publishedAt = new Date().toISOString().slice(0, 10);
  }

  try {
    await window.PodaDB.upsertNote(note);
  } catch (e) {
    alert("Could not save the note. Check your connection and try again.");
    return;
  }

  const idx = noteState.notes.findIndex(n => n.id === note.id);
  if (idx >= 0) noteState.notes[idx] = note;
  else noteState.notes.unshift(note);

  closeModal();
  renderNotes();
}

/* ============================================================
   Drops & Visual Studies (overhaul) — modeled on Notes
   ============================================================ */
const DROP_STATUSES = ["In Assembly", "Live", "Archived"];
const dropState = { drops: [] };
const studyState = { studies: [] };

function blankDrop() {
  return {
    id: "", number: "", title: "", thesis: "", question: "",
    status: "In Assembly", releaseDate: "", coverImage: "",
    marketNoteId: "", visualStudyId: ""
  };
}
function blankStudy() {
  return {
    id: "", studyNumber: "", title: "", framing: "", date: "",
    coverImage: "", images: [], captions: [],
    relatedNoteId: "", relatedDropId: ""
  };
}
function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
function linesToArray(value) {
  return String(value || "").split("\n").map(s => s.trim()).filter(Boolean);
}

/* —— Drops view —— */
function renderDrops() {
  const rows = dropState.drops.map(d => `
    <tr data-drop-edit="${escapeHTML(d.id)}">
      <td class="cell-mono">${escapeHTML(d.number || "—")}</td>
      <td class="cell-strong">${escapeHTML(d.title || "Untitled")}</td>
      <td>${escapeHTML(d.thesis || "—")}</td>
      <td><span class="badge">${escapeHTML(d.status || "—")}</span></td>
      <td>${escapeHTML(d.releaseDate || "—")}</td>
    </tr>
  `).join("");

  adminMain.innerHTML = `
    <div class="section-bar section-bar--admin">
      <span class="section-bar__label">Store</span>
      <span class="section-bar__title">Drops</span>
      <button type="button" class="admin-newitem section-bar__action" data-new-drop>+ New Drop</button>
    </div>
    ${dropState.drops.length === 0
      ? `<p class="admin-empty">No drops yet. Create Drop 001 to give The Edit a thesis and title.</p>`
      : `<div class="table-wrap"><table class="admin-table">
          <thead><tr><th>No.</th><th>Title</th><th>Thesis</th><th>Status</th><th>Release</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`}
  `;
}

function buildDropForm(d) {
  return `
    <form id="dropForm" novalidate>
      <p class="field-error" id="dropFormError" hidden></p>
      <section class="form-card">
        <div class="section-bar"><span class="section-bar__title">Drop</span></div>
        <div class="field-grid">
          ${textField("Number", "number", d.number, { placeholder: "e.g. 001" })}
          ${selectField("Status", "status", d.status, DROP_STATUSES)}
          ${textField("Title", "title", d.title, { full: true, placeholder: "e.g. The current edit" })}
          ${textField("Opening question", "question", d.question, { full: true, placeholder: "e.g. After hype, what remains?" })}
          ${textareaField("Thesis", "thesis", d.thesis)}
          ${dateField("Release date", "releaseDate", d.releaseDate)}
          ${textField("Cover image URL", "coverImage", d.coverImage, { full: true, placeholder: "https://…" })}
          ${textField("Related Note ID", "marketNoteId", d.marketNoteId, { placeholder: "optional" })}
          ${textField("Related Visual Study ID", "visualStudyId", d.visualStudyId, { placeholder: "optional" })}
        </div>
      </section>
    </form>
  `;
}

function openDropModal(dropId = null) {
  const editing = dropId ? dropState.drops.find(d => d.id === dropId) : null;
  const d = editing ? structuredClone(editing) : blankDrop();

  modalContent.innerHTML = `
    <div class="modal-head">
      <h2 class="modal-title">${editing ? "Edit Drop" : "New Drop"}</h2>
      <button type="button" class="modal-close" id="modalClose" aria-label="Close">×</button>
    </div>
    <div class="modal-body">${buildDropForm(d)}</div>
    <div class="modal-foot">
      ${editing ? `<button type="button" class="btn btn--danger" id="deleteDropBtn">Delete</button>` : ""}
      <button type="button" class="btn" id="cancelDropBtn">Cancel</button>
      <button type="button" class="btn btn--primary" id="saveDropBtn">Save Drop</button>
    </div>
  `;
  modalOverlay.hidden = false;
  document.body.style.overflow = "hidden";

  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("cancelDropBtn").addEventListener("click", closeModal);
  document.getElementById("saveDropBtn").addEventListener("click", () => saveDrop(dropId));
  const del = document.getElementById("deleteDropBtn");
  if (del) del.addEventListener("click", async () => {
    if (!confirm("Delete this drop permanently?")) return;
    try { await window.PodaDB.deleteDrop(dropId); dropState.drops = dropState.drops.filter(x => x.id !== dropId); }
    catch (e) { alert("Could not delete the drop."); return; }
    closeModal(); renderDrops();
  });
}

function readSimpleForm(formId, base) {
  const form = document.getElementById(formId);
  form.querySelectorAll("input[name], select[name], textarea[name]").forEach(el => {
    const key = el.getAttribute("name");
    if (!key) return;
    base[key] = el.type === "checkbox" ? el.checked : el.value;
  });
  return base;
}

async function saveDrop(existingId) {
  const base = existingId
    ? structuredClone(dropState.drops.find(d => d.id === existingId) || blankDrop())
    : blankDrop();
  const d = readSimpleForm("dropForm", base);
  const errorBox = document.getElementById("dropFormError");

  if (!String(d.number).trim()) { errorBox.textContent = "Drop number is required."; errorBox.hidden = false; return; }
  if (!d.id) d.id = genId("drop");

  try { await window.PodaDB.upsertDrop(d); }
  catch (e) { alert("Could not save the drop."); return; }

  const idx = dropState.drops.findIndex(x => x.id === d.id);
  if (idx >= 0) dropState.drops[idx] = d; else dropState.drops.unshift(d);
  closeModal(); renderDrops();
}

/* —— Studies view —— */
function renderStudies() {
  const rows = studyState.studies.map(s => `
    <tr data-study-edit="${escapeHTML(s.id)}">
      <td class="cell-mono">${escapeHTML(s.studyNumber || "—")}</td>
      <td class="cell-strong">${escapeHTML(s.title || "Untitled")}</td>
      <td>${escapeHTML(s.framing || "—")}</td>
      <td>${escapeHTML((s.images || []).length + " img")}</td>
      <td>${escapeHTML(s.date || "—")}</td>
      <td><a class="card-link" href="study.html?id=${encodeURIComponent(s.id)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">View ↗</a></td>
    </tr>
  `).join("");

  adminMain.innerHTML = `
    <div class="section-bar section-bar--admin">
      <span class="section-bar__label">Lookbook</span>
      <span class="section-bar__title">Visual Studies</span>
      <button type="button" class="admin-newitem section-bar__action" data-new-study>+ New Study</button>
    </div>
    ${studyState.studies.length === 0
      ? `<p class="admin-empty">No visual studies yet. A study gives the current thesis its images.</p>`
      : `<div class="table-wrap"><table class="admin-table">
          <thead><tr><th>No.</th><th>Title</th><th>Framing</th><th>Images</th><th>Date</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>`}
  `;
}

function buildStudyForm(s) {
  return `
    <form id="studyForm" novalidate>
      <p class="field-error" id="studyFormError" hidden></p>
      <section class="form-card">
        <div class="section-bar"><span class="section-bar__title">Study</span></div>
        <div class="field-grid">
          ${textField("Number", "studyNumber", s.studyNumber, { placeholder: "e.g. 001" })}
          ${dateField("Date", "date", s.date)}
          ${textField("Title", "title", s.title, { full: true })}
          ${textareaField("Framing (one sentence)", "framing", s.framing)}
          ${textField("Cover image URL", "coverImage", s.coverImage, { full: true, placeholder: "https://…" })}
          ${textareaField("Image URLs — one per line", "imagesText", (s.images || []).join("\n"))}
          ${textareaField("Captions — one per line, matching images", "captionsText", (s.captions || []).join("\n"))}
          ${textField("Related Note ID", "relatedNoteId", s.relatedNoteId, { placeholder: "optional" })}
          ${textField("Related Drop ID", "relatedDropId", s.relatedDropId, { placeholder: "optional" })}
        </div>
      </section>
    </form>
  `;
}

function openStudyModal(studyId = null) {
  const editing = studyId ? studyState.studies.find(s => s.id === studyId) : null;
  const s = editing ? structuredClone(editing) : blankStudy();

  modalContent.innerHTML = `
    <div class="modal-head">
      <h2 class="modal-title">${editing ? "Edit Study" : "New Study"}</h2>
      <button type="button" class="modal-close" id="modalClose" aria-label="Close">×</button>
    </div>
    <div class="modal-body">${buildStudyForm(s)}</div>
    <div class="modal-foot">
      ${editing ? `<button type="button" class="btn btn--danger" id="deleteStudyBtn">Delete</button>` : ""}
      <button type="button" class="btn" id="cancelStudyBtn">Cancel</button>
      <button type="button" class="btn btn--primary" id="saveStudyBtn">Save Study</button>
    </div>
  `;
  modalOverlay.hidden = false;
  document.body.style.overflow = "hidden";

  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("cancelStudyBtn").addEventListener("click", closeModal);
  document.getElementById("saveStudyBtn").addEventListener("click", () => saveStudy(studyId));
  const del = document.getElementById("deleteStudyBtn");
  if (del) del.addEventListener("click", async () => {
    if (!confirm("Delete this study permanently?")) return;
    try { await window.PodaDB.deleteStudy(studyId); studyState.studies = studyState.studies.filter(x => x.id !== studyId); }
    catch (e) { alert("Could not delete the study."); return; }
    closeModal(); renderStudies();
  });
}

async function saveStudy(existingId) {
  const base = existingId
    ? structuredClone(studyState.studies.find(s => s.id === existingId) || blankStudy())
    : blankStudy();
  const s = readSimpleForm("studyForm", base);
  const errorBox = document.getElementById("studyFormError");

  // Convert the textarea fields into arrays.
  s.images = linesToArray(s.imagesText); delete s.imagesText;
  s.captions = linesToArray(s.captionsText); delete s.captionsText;

  if (!String(s.title).trim()) { errorBox.textContent = "Title is required."; errorBox.hidden = false; return; }
  if (!s.id) s.id = genId("study");

  try { await window.PodaDB.upsertStudy(s); }
  catch (e) { alert("Could not save the study."); return; }

  const idx = studyState.studies.findIndex(x => x.id === s.id);
  if (idx >= 0) studyState.studies[idx] = s; else studyState.studies.unshift(s);
  closeModal(); renderStudies();
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

  const session = window.PodaDB ? await window.PodaDB.getSession() : null;
  if (session) {
    await startApp();
  } else {
    showLogin();
  }
}

init();
