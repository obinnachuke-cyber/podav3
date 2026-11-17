/* ============================================================
   casestudy-core.js: shared helpers and demo data for /build.

   Everything on the /build page runs on this file's in-memory demo state.
   It never loads supabase.min.js, never calls /api/*, and never reads or
   writes a Poda record. Refreshing the page resets it.

   The money rules are the real ones: commission uses the same rounding as
   create_order_hold() in migrations/20261111_checkout.sql, and eligibility,
   balances and refunds are computed by finance.js, the same file the admin
   Payouts view uses.
   ============================================================ */
(function () {
  "use strict";

  const DAY = 86400000;
  const HOLD_DAYS = 7;           // the admin's return window, PAYOUT_HOLD_DAYS in admin.js
  const SHIPPING_CENTS = 1500;   // wrangler.toml default, SHIPPING_FLAT_CENTS

  /* —— Helpers —— */
  const fmtMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const money = cents => fmtMoney.format((Number(cents) || 0) / 100);
  const pct = bps => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`;
  // Same rule as the database: round(price_cents * commission_bps / 10000).
  const commissionCents = (priceCents, bps) => Math.round((priceCents * bps) / 10000);
  const esc = v => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const dayLabel = ms => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const today = new Date();
  today.setHours(9, 0, 0, 0);
  const TODAY = today.getTime();
  const daysAgo = n => TODAY - n * DAY;

  /* —— Categories. The labels are this page's; the database stores a
        supplier type of consignor, brand, boutique or poda. —— */
  const CATEGORIES = {
    closet:   { label: "Private Closet",       dbType: "consignor", startBps: 2500 },
    boutique: { label: "Independent Boutique", dbType: "boutique",  startBps: 1500 },
    vintage:  { label: "Vintage Reseller",     dbType: "set per supplier", startBps: 2000 },
    poda:     { label: "Poda stock",           dbType: "poda",      startBps: 0 }
  };

  /* —— Glyphs: plain placeholders, no real supplier photographs. —— */
  const GLYPHS = {
    jacket:  "M16 8l8 3 8-3 10 8-5 8-4-3v21H15V21l-4 3-5-8z",
    knit:    "M17 8h14l4 4 8 6-4 8-4-3v19H17V23l-4 3-4-8 8-6z",
    denim:   "M16 8l8 3 8-3 10 9-5 7-4-3v21H15V21l-4 3-5-7z M24 11v31",
    dress:   "M18 6h12l2 10 8 26H8l8-26z M18 16h12",
    trouser: "M15 6h18l3 36H26l-2-22-2 22H12z",
    boots:   "M16 6h10v18l10 6v10H14V30l2-4z",
    tee:     "M17 8l7 3 7-3 11 7-4 8-4-3v19H14V20l-4 3-4-8z",
    skirt:   "M17 8h14l9 34H8z M17 14h14",
    scarf:   "M14 8h20v8H14z M20 16v26h8V16",
    tote:    "M12 18h24l2 24H10z M17 18v-4a7 7 0 0 1 14 0v4",
    blazer:  "M15 7l9 4 9-4 8 10-4 6-4-2v24H15V21l-4 2-4-6z M24 11v31",
    hat:     "M10 30c0-10 6-18 14-18s14 8 14 18z M6 32h36"
  };
  const glyph = (key, size) => {
    const s = size || 40;
    return `<svg viewBox="0 0 48 48" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="${GLYPHS[key] || GLYPHS.tee}"/></svg>`;
  };

  /* ============================================================
     Seed data
     ============================================================ */
  function seedSuppliers() {
    return [
      { id: "alder",    name: "Alder Closet",         cat: "closet",   contact: "alder.closet@example.com",  bps: 2000, status: "Active",  joined: daysAgo(118),
        history: [[118, "Application received", "Closet photos and Instagram reviewed."], [116, "Invite sent", "Join link emailed."], [115, "Account created", "Invite redeemed. Role set to supplier."], [114, "Terms set", "20% agreed, below the 25% starting rate for a closet."], [96, "First submission", "Five pieces submitted for review."]] },
      { id: "northline", name: "Northline Vintage",   cat: "vintage",  contact: "orders@northline.example.com", bps: 1500, status: "Active",  joined: daysAgo(101),
        history: [[101, "Application received", "Store listing and sample photos."], [99, "Invite sent", "Join link emailed."], [98, "Account created", "Invite redeemed."], [97, "Terms set", "15% agreed for a larger volume of lower priced pieces."], [80, "First submission", "Twelve pieces submitted."]] },
      { id: "fenwick",  name: "Fenwick & Row",        cat: "boutique", contact: "hello@fenwickrow.example.com", bps: 1500, status: "Active",  joined: daysAgo(76),
        history: [[76, "Application received", ""], [74, "Invite sent", ""], [73, "Account created", ""], [72, "Terms set", "Starting rate for a boutique, 15%."]] },
      { id: "marisol",  name: "Marisol's Closet",     cat: "closet",   contact: "marisol@example.com",       bps: 2500, status: "Active",  joined: daysAgo(52),
        history: [[52, "Application received", ""], [50, "Invite sent", ""], [49, "Account created", ""], [48, "Terms set", "Starting rate for a closet, 25%."]] },
      { id: "harbor",   name: "Harbor Lane",          cat: "boutique", contact: "shop@harborlane.example.com", bps: 1800, status: "Active",  joined: daysAgo(33),
        history: [[33, "Application received", ""], [31, "Invite sent", ""], [30, "Account created", ""], [29, "Terms set", "18% agreed for a smaller assortment."]] },
      { id: "secondskin", name: "Second Skin Archive", cat: "vintage", contact: "archive@secondskin.example.com", bps: 2000, status: "Invited", joined: daysAgo(4),
        history: [[4, "Application received", ""], [2, "Invite sent", "Waiting for the supplier to accept."]] },
      { id: "poda",     name: "Poda own stock",       cat: "poda",     contact: "Internal",                   bps: 0,    status: "Active",  joined: daysAgo(140),
        history: [[140, "Supplier record created", "Poda's own pieces sit under a supplier at 0%, so every piece has an owner."]] }
    ];
  }

  // st: submitted | approved | published | sold | archived | declined
  function seedInventory() {
    const p = (id, name, sup, glyphKey, cond, price, sub, st, rel, events) => ({ id, name, sup, glyph: glyphKey, cond, price: price * 100, submitted: daysAgo(sub), st, rel: rel || "", override: null, events: events || [] });
    return [
      p("PD-1042", "Leather Jacket",        "alder",     "jacket",  "Excellent", 400, 21, "published", "Release 04", [[19, "Accepted by Poda"], [12, "Added to Release 04"], [9, "Release 04 dropped"]]),
      p("PD-1043", "Vintage Knitwear",      "northline", "knit",    "Good",      250, 20, "published", "Release 04", [[18, "Accepted by Poda"], [12, "Added to Release 04"], [9, "Release 04 dropped"]]),
      p("PD-1044", "Washed Denim Jacket",   "northline", "denim",   "Good",      180, 20, "published", "Release 04", [[18, "Accepted by Poda"], [9, "Release 04 dropped"]]),
      p("PD-1045", "Silk Slip Dress",       "marisol",   "dress",   "Excellent", 140, 17, "published", "Release 04", [[16, "Accepted by Poda"], [9, "Release 04 dropped"]]),
      p("PD-1046", "Canvas Tote",           "poda",      "tote",    "New",        60, 30, "published", "Release 04", [[28, "Accepted by Poda"], [9, "Release 04 dropped"]]),
      p("PD-1047", "Wide Leg Trousers",     "fenwick",   "trouser", "New",        210,  6, "approved",  "Release 05", [[3, "Accepted by Poda"], [2, "Added to Release 05"]]),
      p("PD-1048", "Cashmere Cardigan",     "harbor",    "knit",    "Excellent", 165,  5, "approved",  "",           [[2, "Accepted by Poda"]]),
      p("PD-1049", "Pleated Midi Skirt",    "marisol",   "skirt",   "Good",      120,  2, "submitted", ""),
      p("PD-1050", "Band Tee, 1990s",       "northline", "tee",     "Fair",       95,  1, "submitted", ""),
      p("PD-1051", "Tweed Blazer",          "fenwick",   "blazer",  "New",       320,  1, "submitted", ""),
      p("PD-1052", "Suede Boots",           "harbor",    "boots",   "Excellent", 220, 33, "sold",      "Release 03", [[31, "Accepted by Poda"], [26, "Release 03 dropped"], [24, "Sold"]]),
      p("PD-1053", "Corduroy Trousers",     "alder",     "trouser", "Good",      130, 47, "archived",  "Release 03", [[45, "Accepted by Poda"], [26, "Release 03 dropped"], [10, "Release 03 archived"]]),
      p("PD-1054", "Wool Scarf",            "harbor",    "scarf",   "Good",       70, 47, "archived",  "Release 03", [[45, "Accepted by Poda"], [26, "Release 03 dropped"], [10, "Release 03 archived"]]),
      p("PD-1055", "Faux Fur Hat",          "marisol",   "hat",     "Fair",       90,  8, "declined",  "",           [[6, "Declined: condition does not match the photos"]])
    ];
  }

  /* ============================================================
     State and events
     ============================================================ */
  const S = { suppliers: [], inventory: [], sim: null, ui: {} };
  const renderers = [];
  const register = fn => renderers.push(fn);
  const render = () => renderers.forEach(fn => fn());

  const supplierById = id => S.suppliers.find(s => s.id === id);
  const itemById = id => S.inventory.find(i => i.id === id);
  // The rate that applies to a piece: its override, else the supplier's rate.
  const rateFor = item => (item.override != null ? item.override : (supplierById(item.sup) || {}).bps || 0);

  function reset() {
    S.suppliers = seedSuppliers();
    S.inventory = seedInventory();
    S.ui = {};
    if (window.PodaCaseSim) window.PodaCaseSim.reset();
    render();
  }

  /* —— Tabs for the walkthrough —— */
  function initTabs() {
    const tabs = $$("[data-stage-tab]");
    const panels = $$("[data-stage-panel]");
    if (!tabs.length) return;
    function show(n, focus) {
      tabs.forEach(t => {
        const on = t.dataset.stageTab === String(n);
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        t.classList.toggle("is-active", on);
        if (on && focus) t.focus();
      });
      panels.forEach(p => { p.hidden = p.dataset.stagePanel !== String(n); });
      render();
    }
    tabs.forEach(t => t.addEventListener("click", () => show(t.dataset.stageTab)));
    $("[data-stage-tabs]").addEventListener("keydown", e => {
      const cur = tabs.findIndex(t => t.getAttribute("aria-selected") === "true");
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const next = (cur + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        show(tabs[next].dataset.stageTab, true);
        e.preventDefault();
      }
    });
    document.addEventListener("click", e => {
      const go = e.target.closest("[data-goto-stage]");
      if (!go) return;
      e.preventDefault();
      show(go.dataset.gotoStage);
      const bar = $("#walkthrough");
      if (bar) bar.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    // Deep links: /build#stage-4 or /build#simulator open that stage.
    const fromHash = () => {
      const h = (location.hash || "").replace("#", "");
      const m = /^stage-(\d)$/.exec(h);
      const n = m ? m[1] : h === "simulator" ? "4" : h === "dashboard" ? "5" : "";
      if (!n) return;
      show(n);
      // The target may have been hidden when the browser tried to scroll to it.
      const tabsEl = $("[data-stage-tabs]");
      if (tabsEl) tabsEl.scrollIntoView({ block: "start" });
    };
    window.addEventListener("hashchange", fromHash);
    show(1);
    fromHash();
  }

  /* —— Reset button, and a quiet way to see which tab is active —— */
  function initChrome() {
    document.addEventListener("click", e => {
      if (e.target.closest("[data-reset-demo]")) reset();
    });
  }

  window.PodaCase = {
    DAY, HOLD_DAYS, SHIPPING_CENTS, TODAY, CATEGORIES,
    money, pct, commissionCents, esc, $, $$, dayLabel, daysAgo, glyph,
    S, register, render, reset, supplierById, itemById, rateFor,
    F: window.PodaFinance
  };

  document.addEventListener("DOMContentLoaded", () => {
    S.suppliers = seedSuppliers();
    S.inventory = seedInventory();
    if (window.PodaCaseSim) window.PodaCaseSim.reset();
    initChrome();
    initTabs();
  });
})();
