/* ============================================================
   Poda Capital — Excel export
   Rebuilds the full "poda_capital_inventory.xlsx" workbook live
   from whatever items exist in the database. When there are no
   items the workbook is empty: headers + zeroed KPIs only.

   Same code runs in two places, so the in-app download and the
   committed template never drift apart:
     • Browser — exposes window.PodaExcel (uses ExcelJS from CDN).
     • Node     — module.exports.buildWorkbook (uses require("exceljs")).

   The builder is self-contained (it ports the few calc helpers it
   needs) so it has no dependency on admin.js.
   ============================================================ */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory();           // Node
  } else {
    root.PodaExcel = factory();           // Browser
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* —— Theme (mirrors the site's navy-green palette + the legend) —— */
  const NAVY        = "FF14233D";  // titles
  const HEADER      = "FF1F3A5F";  // column headers
  const GROUP       = "FF2E4A6B";  // group headers
  const CLOSET_BG   = "FFE7EEF6";  // blue  bg  = Closet
  const LISTED_BG   = "FFE3F0E6";  // green bg  = Listed
  const SOLD_BG     = "FFEFE7DE";  // brown bg  = Sold
  const TOTAL_BG    = "FFD9E2EC";
  const WHITE       = "FFFFFFFF";
  const INPUT_TEXT  = "FF2456A6";  // blue text = user input
  const MUTED       = "FF6B7787";

  const MONEY  = '$#,##0.00';
  const MONEY0 = '$#,##0';
  const PCT    = '0.0%';

  const CATEGORIES = ["Shirt", "Jacket", "Pants", "Denim", "Knit", "Shoe", "Bag", "Accessory", "Other"];
  const STATUSES   = ["Closet", "Listed", "Sold"];
  const PLATFORMS  = ["Grailed", "Depop", "eBay", "Instagram", "Vestiaire", "StockX", "GOAT", "Archive", "Direct", "Other"];

  // All-in fee % per platform → the single assumed fee = their average.
  const STANDARD_PLATFORM_FEES = {
    Grailed: 9, Depop: 10, eBay: 13, Instagram: 3, Vestiaire: 15, StockX: 9, GOAT: 9.5, Archive: 10, Other: 10
  };
  const ASSUMED_FEE_PCT = (() => {
    const v = Object.values(STANDARD_PLATFORM_FEES);
    return Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10;
  })();

  const LISTING_URL_KEYS = [
    "grailedUrl", "depopUrl", "ebayUrl", "instagramUrl",
    "vestiaireUrl", "stockxUrl", "goatUrl", "archiveUrl", "otherUrl"
  ];

  /* ---------------------------------------------------------- */
  /* Calc helpers (ported from admin.js so this file stands alone) */
  /* ---------------------------------------------------------- */
  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function daysBetween(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    return Math.floor((end - start) / 86400000);
  }

  // Every derived number an item row / KPI needs, in one place.
  function calc(item) {
    const c = item.costs || {};
    const p = item.pricing || {};
    const pl = item.platform || {};
    const sa = item.soldActuals || {};

    const purchasePrice = num(c.purchasePrice);
    const inboundShipping = num(c.inboundShipping);
    const otherCosts =
      num(c.tax) + num(c.cleaningCost) + num(c.repairCost) + num(c.authCost) + num(c.otherPrepCost);
    const totalCostBasis = purchasePrice + inboundShipping + otherCosts;

    const currentListPrice = num(p.currentListPrice);
    const feeFraction = ASSUMED_FEE_PCT / 100;
    const sellerShips = Boolean(pl.sellerPaysShipping);
    const estimatedShipping = num(pl.estimatedShipping);
    const expectedNetPayout = currentListPrice - currentListPrice * feeFraction - (sellerShips ? estimatedShipping : 0);
    const expectedNetProfit = expectedNetPayout - totalCostBasis;

    const finalSalePrice = num(sa.finalSalePrice);
    const finalFees = num(sa.finalPlatformFee) + num(sa.finalPaymentFee);
    const finalShipping = num(sa.finalShipping);
    const finalNetPayout = finalSalePrice - finalFees - finalShipping;
    const finalNetProfit = finalNetPayout - totalCostBasis;
    const grossProfit = finalSalePrice ? finalSalePrice - totalCostBasis : 0;

    const today = new Date().toISOString().slice(0, 10);
    const soldDate = sa.dateSold || item.dateSold;
    const daysToSell = (item.dateListed && soldDate) ? daysBetween(item.dateListed, soldDate) : null;
    const daysListed = (item.dateListed && item.status !== "Sold") ? daysBetween(item.dateListed, today) : null;

    return {
      purchasePrice, inboundShipping, otherCosts, totalCostBasis,
      currentListPrice, expectedNetProfit,
      finalSalePrice, finalFees, finalShipping, finalNetPayout, finalNetProfit, grossProfit,
      daysToSell, daysListed
    };
  }

  function firstListingUrl(item) {
    const pl = item.platform || {};
    for (const key of LISTING_URL_KEYS) {
      if (pl[key]) return pl[key];
    }
    return "";
  }

  // Portfolio-wide KPIs (mirror dashboardMetrics in admin.js).
  function metrics(items) {
    const active = items.filter(i => i.status !== "Sold");
    const listed = items.filter(i => i.status === "Listed");
    const sold = items.filter(i => i.status === "Sold");

    const inventoryAtCost = active.reduce((s, i) => s + calc(i).totalCostBasis, 0);
    const listedValue = listed.reduce((s, i) => s + num((i.pricing || {}).currentListPrice), 0);
    const realizedRevenue = sold.reduce((s, i) => s + calc(i).finalSalePrice, 0);
    const realizedProfit = sold.reduce((s, i) => s + calc(i).finalNetProfit, 0);

    const sellThroughDen = sold.length + listed.length;
    const sellThroughRate = sellThroughDen > 0 ? sold.length / sellThroughDen : 0;

    const daysToSell = sold.map(i => calc(i).daysToSell).filter(d => d !== null);
    const avgDaysToSell = daysToSell.length ? daysToSell.reduce((s, d) => s + d, 0) / daysToSell.length : 0;

    const avgMargin = realizedRevenue > 0 ? realizedProfit / realizedRevenue : 0;

    return {
      totalItems: items.length,
      inventoryAtCost, listedValue, realizedRevenue, realizedProfit,
      sellThroughRate, avgDaysToSell, avgMargin,
      itemsListed: listed.length, itemsSold: sold.length
    };
  }

  /* ---------------------------------------------------------- */
  /* Small styling helpers                                       */
  /* ---------------------------------------------------------- */
  function fill(hex) {
    return { type: "pattern", pattern: "solid", fgColor: { argb: hex } };
  }
  function thinBorder() {
    const e = { style: "thin", color: { argb: "FFC7CFDA" } };
    return { top: e, left: e, bottom: e, right: e };
  }
  function statusBg(status) {
    if (status === "Listed") return LISTED_BG;
    if (status === "Sold") return SOLD_BG;
    return CLOSET_BG; // Closet / default
  }

  function titleBlock(ws, span, line1, line2) {
    ws.mergeCells(1, 1, 1, span);
    const t = ws.getCell(1, 1);
    t.value = line1;
    t.font = { name: "Arial", size: 16, bold: true, color: { argb: WHITE } };
    t.fill = fill(NAVY);
    t.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    ws.getRow(1).height = 26;

    ws.mergeCells(2, 1, 2, span);
    const s = ws.getCell(2, 1);
    s.value = line2;
    s.font = { name: "Arial", size: 9, italic: true, color: { argb: WHITE } };
    s.fill = fill(NAVY);
    s.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    ws.getRow(2).height = 16;
  }

  function headerCell(cell, text, bg) {
    cell.value = text;
    cell.font = { name: "Arial", size: 9, bold: true, color: { argb: WHITE } };
    cell.fill = fill(bg || HEADER);
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = thinBorder();
  }

  /* ---------------------------------------------------------- */
  /* Sheet 1 — Overview                                          */
  /* ---------------------------------------------------------- */
  function buildOverview(wb, items, m) {
    const ws = wb.addWorksheet("Overview", { views: [{ showGridLines: false }] });
    ws.columns = [{ width: 26 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }];

    titleBlock(ws, 6, "PODA CAPITAL", "Closet Portfolio · Inventory Tracker · Resale Intelligence");

    // KPI cards
    sectionHeading(ws, 4, 6, "PORTFOLIO OVERVIEW");
    const kpis = [
      ["TOTAL ITEMS", m.totalItems, "0"],
      ["INVENTORY AT COST", m.inventoryAtCost, MONEY0],
      ["LISTED VALUE", m.listedValue, MONEY0],
      ["REALIZED REVENUE", m.realizedRevenue, MONEY0],
      ["REALIZED PROFIT", m.realizedProfit, MONEY0],
      ["SELL-THROUGH RATE", m.sellThroughRate, PCT],
      ["AVG DAYS TO SELL", m.avgDaysToSell, "0.0"],
      ["AVG MARGIN", m.avgMargin, PCT],
      ["ITEMS LISTED", m.itemsListed, "0"],
      ["ITEMS SOLD", m.itemsSold, "0"]
    ];
    // Two KPIs per row (label col + value col, ×3 pairs would overflow — use label/value stacked across 6 cols → 3 per row)
    let r = 6;
    for (let i = 0; i < kpis.length; i += 3) {
      const labelRow = ws.getRow(r);
      const valueRow = ws.getRow(r + 1);
      for (let j = 0; j < 3; j++) {
        const k = kpis[i + j];
        if (!k) continue;
        const cBase = 1 + j * 2; // 1,3,5
        ws.mergeCells(r, cBase, r, cBase + 1);
        const lc = labelRow.getCell(cBase);
        lc.value = k[0];
        lc.font = { name: "Arial", size: 8, bold: true, color: { argb: MUTED } };
        lc.alignment = { horizontal: "left", indent: 1 };

        ws.mergeCells(r + 1, cBase, r + 1, cBase + 1);
        const vc = valueRow.getCell(cBase);
        vc.value = k[1];
        vc.numFmt = k[2];
        vc.font = { name: "Arial", size: 15, bold: true, color: { argb: NAVY } };
        vc.alignment = { horizontal: "left", indent: 1 };
        vc.fill = fill("FFF2F5F9");
        vc.border = thinBorder();
      }
      labelRow.height = 14;
      valueRow.height = 22;
      r += 2;
    }

    // Portfolio breakdown by STATUS
    r += 1;
    sectionHeading(ws, r, 6, "PORTFOLIO BREAKDOWN");
    r += 1;
    const bHead = ["STATUS", "ITEMS", "COST BASIS", "LIST VALUE", "SOLD REVENUE", "PROFIT"];
    bHead.forEach((h, i) => headerCell(ws.getRow(r).getCell(i + 1), h));
    r += 1;
    const totals = { items: 0, cost: 0, list: 0, rev: 0, profit: 0 };
    STATUSES.forEach(status => {
      const group = items.filter(i => i.status === status);
      const cost = group.reduce((s, i) => s + calc(i).totalCostBasis, 0);
      const list = group.reduce((s, i) => s + num((i.pricing || {}).currentListPrice), 0);
      const rev = status === "Sold" ? group.reduce((s, i) => s + calc(i).finalSalePrice, 0) : 0;
      const profit = status === "Sold" ? group.reduce((s, i) => s + calc(i).finalNetProfit, 0) : 0;
      writeBreakdownRow(ws, r, status, group.length, cost, list, rev, profit, statusBg(status));
      totals.items += group.length; totals.cost += cost; totals.list += list; totals.rev += rev; totals.profit += profit;
      r += 1;
    });
    writeBreakdownRow(ws, r, "TOTAL", totals.items, totals.cost, totals.list, totals.rev, totals.profit, TOTAL_BG, true);
    r += 2;

    // By category
    sectionHeading(ws, r, 6, "BY CATEGORY");
    r += 1;
    ["CATEGORY", "ITEMS", "COST BASIS", "LIST VALUE", "SOLD", "PROFIT"].forEach(
      (h, i) => headerCell(ws.getRow(r).getCell(i + 1), h));
    r += 1;
    CATEGORIES.forEach(cat => {
      const group = items.filter(i => (i.category || "Other") === cat);
      if (!group.length) return; // empty when no items in that category
      const cost = group.reduce((s, i) => s + calc(i).totalCostBasis, 0);
      const list = group.reduce((s, i) => s + num((i.pricing || {}).currentListPrice), 0);
      const soldCount = group.filter(i => i.status === "Sold").length;
      const profit = group.filter(i => i.status === "Sold").reduce((s, i) => s + calc(i).finalNetProfit, 0);
      writeBreakdownRow(ws, r, cat, group.length, cost, list, soldCount, profit, "FFFFFFFF");
      ws.getRow(r).getCell(5).numFmt = "0"; // SOLD is a count here
      r += 1;
    });

    r += 1;
    sectionHeading(ws, r, 6, "NOTES / CURRENT FOCUS");
    r += 1;
    ws.mergeCells(r, 1, r + 2, 6);
    const note = ws.getCell(r, 1);
    note.value = "Add sourcing priorities, open questions, or market observations here.";
    note.font = { name: "Arial", size: 9, italic: true, color: { argb: MUTED } };
    note.alignment = { vertical: "top", wrapText: true, indent: 1 };
    return ws;
  }

  function sectionHeading(ws, row, span, text) {
    ws.mergeCells(row, 1, row, span);
    const c = ws.getCell(row, 1);
    c.value = text;
    c.font = { name: "Arial", size: 10, bold: true, color: { argb: WHITE } };
    c.fill = fill(GROUP);
    c.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    ws.getRow(row).height = 18;
  }

  function writeBreakdownRow(ws, row, label, items, cost, list, rev, profit, bg, bold) {
    const r = ws.getRow(row);
    const vals = [label, items, cost, list, rev, profit];
    const fmts = [null, "0", MONEY0, MONEY0, MONEY0, MONEY0];
    vals.forEach((v, i) => {
      const c = r.getCell(i + 1);
      c.value = v;
      if (fmts[i]) c.numFmt = fmts[i];
      c.fill = fill(bg);
      c.border = thinBorder();
      c.font = { name: "Arial", size: 9, bold: !!bold, color: { argb: NAVY } };
      c.alignment = { horizontal: i === 0 ? "left" : "right", indent: 1 };
    });
  }

  /* ---------------------------------------------------------- */
  /* Sheet 2 — Inventory ledger                                  */
  /* ---------------------------------------------------------- */
  const INV_GROUPS = [
    ["ITEM IDENTITY", 8], ["ACQUISITION", 3], ["COSTS", 4],
    ["LISTING", 3], ["SALE ACTUALS", 6], ["ANALYTICS", 4], ["NOTES", 1]
  ];
  const INV_COLS = [
    "ITEM ID", "BRAND", "ITEM NAME", "SUBCATEGORY", "SIZE", "COLOR", "CONDITION", "SEASON / YEAR",
    "DATE ACQUIRED", "SOURCE", "PURCHASE PLATFORM",
    "PURCHASE PRICE", "INBOUND SHIP", "OTHER COSTS", "TOTAL COST BASIS",
    "LIST PRICE", "DATE LISTED", "LISTING URL",
    "SALE PRICE", "DATE SOLD", "SOLD PLATFORM", "PLATFORM FEE", "SHIPPING OUT", "NET PAYOUT",
    "GROSS PROFIT", "NET PROFIT", "DAYS LISTED", "DAYS TO SELL",
    "NOTES"
  ];
  const INV_WIDTHS = [12, 16, 22, 13, 7, 12, 11, 11, 13, 12, 16, 13, 12, 11, 15, 11, 12, 22, 11, 11, 13, 11, 11, 12, 12, 11, 11, 11, 30];
  // Money columns (1-based) and the columns that are user input (blue text).
  const INV_MONEY = new Set([12, 13, 14, 15, 16, 19, 22, 23, 24, 25, 26]);

  function buildInventory(wb, items) {
    const ws = wb.addWorksheet("Inventory", { views: [{ state: "frozen", ySplit: 4, showGridLines: false }] });
    const span = INV_COLS.length;
    ws.columns = INV_WIDTHS.map(w => ({ width: w }));

    titleBlock(ws, span, "PODA CAPITAL — INVENTORY LEDGER",
      "Blue text = user input · Black text = formula · Green = Listed · Blue = Closet · Brown = Sold");

    // Group header row (row 3) + column header row (row 4)
    let col = 1;
    INV_GROUPS.forEach(([name, w]) => {
      ws.mergeCells(3, col, 3, col + w - 1);
      headerCell(ws.getCell(3, col), name, GROUP);
      col += w;
    });
    INV_COLS.forEach((h, i) => headerCell(ws.getRow(4).getCell(i + 1), h));
    ws.getRow(4).height = 26;

    // Data rows — one per item (none → sheet stays empty below the header)
    let r = 5;
    items.forEach(item => {
      const k = calc(item);
      const sold = item.status === "Sold";
      const listed = sold || item.status === "Listed";
      const row = [
        item.id, item.brand, item.itemName, item.category, item.size, item.color, item.condition, item.season,
        item.dateAcquired, item.source, item.purchasePlatform,
        k.purchasePrice, k.inboundShipping, k.otherCosts, k.totalCostBasis,
        listed ? k.currentListPrice : "", item.dateListed || "", firstListingUrl(item),
        sold ? k.finalSalePrice : "", (item.soldActuals || {}).dateSold || item.dateSold || "",
        sold ? (item.soldActuals || {}).soldPlatform : "", sold ? k.finalFees : "",
        sold ? k.finalShipping : "", sold ? k.finalNetPayout : "",
        sold ? k.grossProfit : "", sold ? k.finalNetProfit : "",
        k.daysListed === null ? "" : k.daysListed, k.daysToSell === null ? "" : k.daysToSell,
        item.privateNotes || item.publicDescription || ""
      ];
      const bg = statusBg(item.status);
      row.forEach((v, i) => {
        const c = ws.getRow(r).getCell(i + 1);
        c.value = v;
        c.fill = fill(bg);
        c.border = thinBorder();
        c.font = { name: "Arial", size: 9, color: { argb: NAVY } };
        c.alignment = { horizontal: INV_MONEY.has(i + 1) ? "right" : "left", indent: 1, wrapText: false };
        if (INV_MONEY.has(i + 1) && v !== "") c.numFmt = MONEY;
      });
      r += 1;
    });
    return ws;
  }

  /* ---------------------------------------------------------- */
  /* Sheet 3 — Transactions (a BUY per acquired, a SELL per sold)*/
  /* ---------------------------------------------------------- */
  function buildTransactions(wb, items) {
    const ws = wb.addWorksheet("Transactions", { views: [{ state: "frozen", ySplit: 3, showGridLines: false }] });
    const cols = ["DATE", "TYPE", "ITEM ID", "ITEM", "PLATFORM", "GROSS AMOUNT", "SHIPPING", "NET AMOUNT", "DAYS HELD", "NOTES"];
    const widths = [13, 8, 12, 24, 14, 14, 11, 14, 10, 30];
    ws.columns = widths.map(w => ({ width: w }));
    titleBlock(ws, cols.length, "PODA CAPITAL — TRANSACTION LOG", "Every acquisition and sale, in date order.");
    cols.forEach((h, i) => headerCell(ws.getRow(3).getCell(i + 1), h));

    const rows = [];
    items.forEach(item => {
      const k = calc(item);
      const name = [item.brand, item.itemName].filter(Boolean).join(" ");
      if (item.dateAcquired || k.purchasePrice) {
        rows.push({
          date: item.dateAcquired || "", type: "BUY", id: item.id, name,
          platform: item.purchasePlatform || "", gross: k.purchasePrice, ship: k.inboundShipping,
          net: -(k.totalCostBasis), days: "", bg: CLOSET_BG
        });
      }
      if (item.status === "Sold") {
        const soldDate = (item.soldActuals || {}).dateSold || item.dateSold || "";
        const held = item.dateAcquired && soldDate ? daysBetween(item.dateAcquired, soldDate) : "";
        rows.push({
          date: soldDate, type: "SELL", id: item.id, name,
          platform: (item.soldActuals || {}).soldPlatform || "", gross: k.finalSalePrice,
          ship: k.finalShipping, net: k.finalNetPayout, days: held === null ? "" : held, bg: SOLD_BG
        });
      }
    });
    rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    let r = 4;
    let totalNet = 0;
    rows.forEach(t => {
      totalNet += num(t.net);
      const vals = [t.date, t.type, t.id, t.name, t.platform, t.gross, t.ship, t.net, t.days, ""];
      const money = new Set([6, 7, 8]);
      vals.forEach((v, i) => {
        const c = ws.getRow(r).getCell(i + 1);
        c.value = v;
        c.fill = fill(t.bg);
        c.border = thinBorder();
        c.font = { name: "Arial", size: 9, color: { argb: NAVY } };
        c.alignment = { horizontal: money.has(i + 1) || i + 1 === 9 ? "right" : "left", indent: 1 };
        if (money.has(i + 1) && v !== "") c.numFmt = MONEY;
      });
      r += 1;
    });

    // Totals row
    const tr = ws.getRow(r);
    headerCell(tr.getCell(1), "TOTALS", TOTAL_BG);
    tr.getCell(1).alignment = { horizontal: "left", indent: 1 };
    for (let i = 2; i <= cols.length; i++) {
      const c = tr.getCell(i);
      c.fill = fill(TOTAL_BG); c.border = thinBorder();
      c.font = { name: "Arial", size: 9, bold: true, color: { argb: NAVY } };
      c.alignment = { horizontal: "right", indent: 1 };
    }
    tr.getCell(8).value = totalNet;
    tr.getCell(8).numFmt = MONEY;
    return ws;
  }

  /* ---------------------------------------------------------- */
  /* Sheets 4 & 5 — manual planning sheets (headers only)        */
  /* ---------------------------------------------------------- */
  function buildManualSheet(wb, name, title, subtitle, cols, widths) {
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }] });
    ws.columns = widths.map(w => ({ width: w }));
    titleBlock(ws, cols.length, title, subtitle);
    cols.forEach((h, i) => headerCell(ws.getRow(3).getCell(i + 1), h));
    return ws;
  }

  /* ---------------------------------------------------------- */
  /* Sheet 6 — Calculations engine (definitions + assumptions)   */
  /* ---------------------------------------------------------- */
  function buildCalculations(wb, items, m) {
    const ws = wb.addWorksheet("Calculations", { views: [{ showGridLines: false }] });
    ws.columns = [{ width: 28 }, { width: 16 }, { width: 44 }];
    titleBlock(ws, 3, "PODA CAPITAL — CALCULATIONS ENGINE", "Definitions feeding the Overview sheet.");

    const defs = [
      ["Total Items", m.totalItems, "0", "All items with an ID"],
      ["Inventory at Cost (active)", m.inventoryAtCost, MONEY0, "Cost basis of Closet + Listed items"],
      ["Total Listed Value", m.listedValue, MONEY0, "Sum of list prices for Listed items"],
      ["Realized Revenue", m.realizedRevenue, MONEY0, "Sum of sale prices for Sold items"],
      ["Realized Net Profit", m.realizedProfit, MONEY0, "Net profit after fees + shipping"],
      ["Sell-Through Rate", m.sellThroughRate, PCT, "Sold / (Sold + Listed)"],
      ["Avg Days to Sell", m.avgDaysToSell, "0.0", "Average of days-to-sell for Sold items"],
      ["Avg Net Margin", m.avgMargin, PCT, "Total net profit / total revenue"],
      ["Items Listed", m.itemsListed, "0", "Items currently Listed"],
      ["Items Sold", m.itemsSold, "0", "Items currently Sold"]
    ];
    let r = 3;
    ["METRIC", "VALUE", "DEFINITION"].forEach((h, i) => headerCell(ws.getRow(r).getCell(i + 1), h));
    r += 1;
    defs.forEach(d => {
      const row = ws.getRow(r);
      row.getCell(1).value = d[0];
      row.getCell(2).value = d[1];
      row.getCell(2).numFmt = d[2];
      row.getCell(3).value = d[3];
      [1, 2, 3].forEach(i => {
        const c = row.getCell(i);
        c.border = thinBorder();
        c.font = { name: "Arial", size: 9, color: { argb: i === 3 ? MUTED : NAVY } };
        c.alignment = { horizontal: i === 2 ? "right" : "left", indent: 1 };
      });
      r += 1;
    });

    r += 1;
    sectionHeading(ws, r, 3, "FEE ASSUMPTIONS  (update as needed)");
    r += 1;
    ["PLATFORM", "FEE %", "NOTE"].forEach((h, i) => headerCell(ws.getRow(r).getCell(i + 1), h));
    r += 1;
    Object.entries(STANDARD_PLATFORM_FEES).forEach(([plat, fee]) => {
      const row = ws.getRow(r);
      row.getCell(1).value = plat;
      row.getCell(2).value = fee / 100;
      row.getCell(2).numFmt = PCT;
      row.getCell(3).value = "Standard all-in seller fee";
      [1, 2, 3].forEach(i => {
        const c = row.getCell(i);
        c.border = thinBorder();
        c.font = { name: "Arial", size: 9, color: { argb: i === 3 ? MUTED : NAVY } };
        c.alignment = { horizontal: i === 2 ? "right" : "left", indent: 1 };
      });
      r += 1;
    });
    const row = ws.getRow(r);
    row.getCell(1).value = "Assumed Fee % (avg)";
    row.getCell(2).value = ASSUMED_FEE_PCT / 100;
    row.getCell(2).numFmt = PCT;
    row.getCell(3).value = "Average of the above; used for expected economics";
    [1, 2, 3].forEach(i => {
      const c = row.getCell(i);
      c.fill = fill(TOTAL_BG); c.border = thinBorder();
      c.font = { name: "Arial", size: 9, bold: true, color: { argb: NAVY } };
      c.alignment = { horizontal: i === 2 ? "right" : "left", indent: 1 };
    });
    return ws;
  }

  /* ---------------------------------------------------------- */
  /* Public: build the whole workbook from items                 */
  /* ---------------------------------------------------------- */
  function buildWorkbook(ExcelJS, items) {
    const list = Array.isArray(items) ? items.slice() : [];
    // Oldest → newest, matching the app's ordering.
    const wb = new ExcelJS.Workbook();
    wb.creator = "Poda Capital";
    wb.created = new Date();

    const m = metrics(list);
    buildOverview(wb, list, m);
    buildInventory(wb, list);
    buildTransactions(wb, list);
    buildManualSheet(wb, "Sourcing Pipeline",
      "PODA CAPITAL — SOURCING PIPELINE", "Items you're watching, before they enter the closet.",
      ["DATE SPOTTED", "BRAND", "ITEM", "STATUS", "ASKING PRICE", "COMP LOW", "COMP MID", "COMP HIGH", "TARGET BUY", "EST. LIST", "EST. PROFIT", "EST. MARGIN", "NOTES"],
      [13, 16, 22, 12, 13, 11, 11, 11, 12, 11, 12, 11, 28]);
    buildManualSheet(wb, "Market Comps",
      "PODA CAPITAL — MARKET COMPS", "Sold-listing comparables backing your pricing.",
      ["DATE", "BRAND", "ITEM", "COMP TYPE", "PLATFORM", "SOLD PRICE", "RELEVANCE", "URL", "NOTES"],
      [13, 16, 22, 12, 14, 12, 11, 24, 28]);
    buildCalculations(wb, list, m);
    return wb;
  }

  /* ---------------------------------------------------------- */
  /* Browser-only: build + trigger a download                    */
  /* ---------------------------------------------------------- */
  async function download(items, filename) {
    if (typeof ExcelJS === "undefined") {
      throw new Error("ExcelJS library not loaded (check the CDN <script> tag in admin.html).");
    }
    const wb = buildWorkbook(ExcelJS, items);
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "poda_capital_inventory.xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return { buildWorkbook, download, metrics, calc };
});
